import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { EventEnvelope } from "../../src/core/events.js";
import {
  RpcClient,
  RpcClientClosedError,
  RpcRemoteError,
  type RpcEventSubscription,
  spawnRigynRpcClient,
  spawnRpcClient,
} from "../../src/interfaces/rpc-client.js";
import { decodeRpcLines, type RpcRequest } from "../../src/interfaces/rpc.js";

function fixture() {
  const requests = new PassThrough();
  const responses = new PassThrough();
  const client = new RpcClient({ input: responses, output: requests });
  const iterator = decodeRpcLines(requests)[Symbol.asyncIterator]();
  const nextRequest = async (): Promise<RpcRequest> => {
    const next = await iterator.next();
    assert.equal(next.done, false);
    return JSON.parse(next.value!) as RpcRequest;
  };
  const send = (value: unknown): void => {
    responses.write(`${JSON.stringify(value)}\n`);
  };
  return { client, requests, responses, nextRequest, send };
}

function event(sequence: number): EventEnvelope {
  return {
    eventId: `event_${sequence}`,
    threadId: "thread_rpc_client",
    sequence,
    timestamp: "2026-07-13T00:00:00.000Z",
    schemaVersion: 1,
    event: { type: "warning", code: "fixture", message: `event ${sequence}` },
  };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function within<T>(operation: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("typed RPC client correlates concurrent responses, notifications, and remote errors", async (t) => {
  const transport = fixture();
  t.after(async () => await transport.client.close());
  const notifications: string[] = [];
  transport.client.onNotification("run.failed", (value) => {
    notifications.push(`${value.threadId}:${value.message}`);
  });

  const health = transport.client.request("health");
  const version = transport.client.request("version");
  const first = await transport.nextRequest();
  const second = await transport.nextRequest();
  assert.equal(first.method, "health");
  assert.equal(second.method, "version");

  transport.send({ jsonrpc: "2.0", id: second.id, result: { name: "rigyn", version: "0.1.0" } });
  transport.send({ jsonrpc: "2.0", method: "run.failed", params: { threadId: "thread-1", message: "failed" } });
  transport.send({
    jsonrpc: "2.0",
    id: first.id,
    result: { status: "ok", version: "0.1.0", uptimeSeconds: 2, clients: 1, activeRuns: 0 },
  });
  assert.equal((await version).version, "0.1.0");
  assert.equal((await health).status, "ok");
  assert.deepEqual(notifications, ["thread-1:failed"]);

  const failed = transport.client.request("thread.get", { threadId: "missing" });
  const failedRequest = await transport.nextRequest();
  transport.send({
    jsonrpc: "2.0",
    id: failedRequest.id,
    error: { code: -32602, message: "Unknown thread", data: { threadId: "missing" } },
  });
  await assert.rejects(failed, (cause) => {
    assert.ok(cause instanceof RpcRemoteError);
    assert.equal(cause.code, -32602);
    assert.deepEqual(cause.data, { threadId: "missing" });
    return true;
  });
  assert.equal(transport.client.pendingRequestCount, 0);
});

test("request cancellation is local, ignores its late response, and close rejects remaining requests", async () => {
  const transport = fixture();
  const controller = new AbortController();
  const cancelled = transport.client.request("models.list", undefined, { signal: controller.signal });
  const cancelledRequest = await transport.nextRequest();
  controller.abort(new Error("stop waiting"));
  await assert.rejects(cancelled, /stop waiting/u);
  transport.send({ jsonrpc: "2.0", id: cancelledRequest.id, result: [] });

  const healthy = transport.client.request("health");
  const healthyRequest = await transport.nextRequest();
  transport.send({
    jsonrpc: "2.0",
    id: healthyRequest.id,
    result: { status: "ok", version: "0.1.0", uptimeSeconds: 0, clients: 1, activeRuns: 0 },
  });
  assert.equal((await healthy).activeRuns, 0);

  const pending = transport.client.request("version");
  await transport.nextRequest();
  await transport.client.close("test close");
  await assert.rejects(pending, (cause) => cause instanceof RpcClientClosedError && /test close/u.test(cause.message));
  assert.equal(transport.client.closed, true);
  assert.equal(transport.client.pendingRequestCount, 0);
  await transport.client.close("second close");
});

test("cancelled event subscription cleans up a late success without contaminating another handoff", async (t) => {
  const transport = fixture();
  t.after(async () => await transport.client.close());
  const controller = new AbortController();
  const cancelled = transport.client.subscribeEvents(
    { threadId: "thread_rpc_client" },
    () => {},
    { signal: controller.signal },
  );
  const cancelledRequest = await transport.nextRequest();
  controller.abort(new Error("stop the subscription handoff"));
  await assert.rejects(cancelled, /stop the subscription handoff/u);

  const seen: number[] = [];
  const activePromise = transport.client.subscribeEvents(
    { threadId: "thread_rpc_client" },
    (value) => { seen.push(value.sequence); },
    { maxPendingEvents: 1 },
  );
  const activeRequest = await transport.nextRequest();
  transport.send({
    jsonrpc: "2.0",
    method: "events.event",
    params: { subscriptionId: "subscription_cancelled", event: event(80) },
  });
  transport.send({
    jsonrpc: "2.0",
    id: cancelledRequest.id,
    result: {
      subscriptionId: "subscription_cancelled",
      replayedThrough: 80,
      nextCursor: 80,
      hasMore: false,
    },
  });

  const cleanupRequest = await within(transport.nextRequest(), "late subscription cleanup");
  assert.equal(cleanupRequest.method, "events.unsubscribe");
  assert.deepEqual(cleanupRequest.params, { subscriptionId: "subscription_cancelled" });
  transport.send({
    jsonrpc: "2.0",
    method: "events.event",
    params: { subscriptionId: "subscription_cancelled", event: event(81) },
  });
  transport.send({
    jsonrpc: "2.0",
    method: "events.event",
    params: { subscriptionId: "subscription_active", event: event(90) },
  });
  transport.send({
    jsonrpc: "2.0",
    id: activeRequest.id,
    result: {
      subscriptionId: "subscription_active",
      replayedThrough: 90,
      nextCursor: 90,
      hasMore: false,
    },
  });
  transport.send({ jsonrpc: "2.0", id: cleanupRequest.id, result: { unsubscribed: true } });
  const active = await activePromise;
  await waitUntil(() => seen.length === 1, "active subscription delivery");
  assert.deepEqual(seen, [90]);

  const stopping = active.unsubscribe();
  const unsubscribeRequest = await transport.nextRequest();
  transport.send({ jsonrpc: "2.0", id: unsubscribeRequest.id, result: { unsubscribed: true } });
  await stopping;
  assert.equal(transport.client.pendingRequestCount, 0);
});

test("event subscription buffers handoff notifications, filters by ID, and unsubscribes once", async (t) => {
  const transport = fixture();
  t.after(async () => await transport.client.close());
  const seen: number[] = [];
  const subscribing = transport.client.subscribeEvents({
    threadId: "thread_rpc_client",
    afterSequence: 0,
  }, (value) => {
    seen.push(value.sequence);
  });
  const request = await transport.nextRequest();
  assert.equal(request.method, "events.subscribe");
  transport.send({
    jsonrpc: "2.0",
    method: "events.event",
    params: { subscriptionId: "subscription_expected", event: event(1) },
  });
  transport.send({
    jsonrpc: "2.0",
    id: request.id,
    result: {
      subscriptionId: "subscription_expected",
      replayedThrough: 1,
      nextCursor: 1,
      hasMore: false,
    },
  });
  const subscription = await subscribing;
  assert.equal(subscription.subscriptionId, "subscription_expected");
  assert.equal(subscription.nextCursor, 1);
  assert.equal(subscription.hasMore, false);
  assert.deepEqual(seen, [1]);

  transport.send({
    jsonrpc: "2.0",
    method: "events.event",
    params: { subscriptionId: "subscription_other", event: event(2) },
  });
  transport.send({
    jsonrpc: "2.0",
    method: "events.event",
    params: { subscriptionId: "subscription_expected", event: event(3) },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [1, 3]);

  const closing = subscription.unsubscribe();
  const unsubscribe = await transport.nextRequest();
  assert.equal(unsubscribe.method, "events.unsubscribe");
  assert.deepEqual(unsubscribe.params, { subscriptionId: "subscription_expected" });
  transport.send({ jsonrpc: "2.0", id: unsubscribe.id, result: { unsubscribed: true } });
  await closing;
  await subscription.unsubscribe();
  transport.send({
    jsonrpc: "2.0",
    method: "events.event",
    params: { subscriptionId: "subscription_expected", event: event(4) },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [1, 3]);
});

test("event subscription handoff ignores traffic from a busy established subscription", async (t) => {
  const transport = fixture();
  t.after(async () => await transport.client.close());
  const existingSeen: number[] = [];
  let announceExisting!: () => void;
  const existingStarted = new Promise<void>((resolve) => { announceExisting = resolve; });
  let releaseExisting!: () => void;
  const existingGate = new Promise<void>((resolve) => { releaseExisting = resolve; });
  const existingPromise = transport.client.subscribeEvents({ threadId: "thread_rpc_client" }, async (value) => {
    existingSeen.push(value.sequence);
    if (value.sequence === 10) {
      announceExisting();
      await existingGate;
    }
  });
  const existingRequest = await transport.nextRequest();
  transport.send({
    jsonrpc: "2.0",
    id: existingRequest.id,
    result: {
      subscriptionId: "subscription_existing",
      replayedThrough: 0,
      nextCursor: 0,
      hasMore: false,
    },
  });
  const existing = await existingPromise;
  transport.send({
    jsonrpc: "2.0",
    method: "events.event",
    params: { subscriptionId: existing.subscriptionId, event: event(10) },
  });
  await existingStarted;

  const targetSeen: number[] = [];
  const targetPromise = transport.client.subscribeEvents(
    { threadId: "thread_rpc_client" },
    (value) => { targetSeen.push(value.sequence); },
    { maxPendingEvents: 1 },
  );
  const targetRequest = await transport.nextRequest();
  for (const sequence of [11, 12]) {
    transport.send({
      jsonrpc: "2.0",
      method: "events.event",
      params: { subscriptionId: existing.subscriptionId, event: event(sequence) },
    });
  }
  transport.send({
    jsonrpc: "2.0",
    method: "events.event",
    params: { subscriptionId: "subscription_target", event: event(20) },
  });
  transport.send({
    jsonrpc: "2.0",
    id: targetRequest.id,
    result: {
      subscriptionId: "subscription_target",
      replayedThrough: 20,
      nextCursor: 20,
      hasMore: false,
    },
  });
  const target = await targetPromise;
  assert.deepEqual(targetSeen, [20]);

  const stopTarget = target.unsubscribe();
  const targetUnsubscribe = await transport.nextRequest();
  assert.deepEqual(targetUnsubscribe.params, { subscriptionId: target.subscriptionId });
  transport.send({ jsonrpc: "2.0", id: targetUnsubscribe.id, result: { unsubscribed: true } });
  await stopTarget;

  const stopExisting = existing.unsubscribe();
  const existingUnsubscribe = await transport.nextRequest();
  assert.deepEqual(existingUnsubscribe.params, { subscriptionId: existing.subscriptionId });
  transport.send({ jsonrpc: "2.0", id: existingUnsubscribe.id, result: { unsubscribed: true } });
  releaseExisting();
  await stopExisting;
  assert.deepEqual(existingSeen, [10, 11, 12]);
});

test("event subscription handoff attributes traffic from a concurrent raw subscription", async (t) => {
  const transport = fixture();
  t.after(async () => await transport.client.close());
  const rawPromise = transport.client.request("events.subscribe", { threadId: "thread_rpc_client" });
  const rawRequest = await transport.nextRequest();
  const seen: number[] = [];
  const helperPromise = transport.client.subscribeEvents(
    { threadId: "thread_rpc_client" },
    (value) => { seen.push(value.sequence); },
    { maxPendingEvents: 1 },
  );
  const helperRequest = await transport.nextRequest();

  for (const sequence of [30, 31]) {
    transport.send({
      jsonrpc: "2.0",
      method: "events.event",
      params: { subscriptionId: "subscription_raw", event: event(sequence) },
    });
  }
  transport.send({
    jsonrpc: "2.0",
    id: rawRequest.id,
    result: { subscriptionId: "subscription_raw", replayedThrough: 31, nextCursor: 31, hasMore: false },
  });
  const raw = await rawPromise;
  transport.send({
    jsonrpc: "2.0",
    method: "events.event",
    params: { subscriptionId: "subscription_helper", event: event(40) },
  });
  transport.send({
    jsonrpc: "2.0",
    id: helperRequest.id,
    result: { subscriptionId: "subscription_helper", replayedThrough: 40, nextCursor: 40, hasMore: false },
  });
  const helper = await helperPromise;
  assert.deepEqual(seen, [40]);

  const stopHelper = helper.unsubscribe();
  const helperUnsubscribe = await transport.nextRequest();
  transport.send({ jsonrpc: "2.0", id: helperUnsubscribe.id, result: { unsubscribed: true } });
  await stopHelper;
  const stopRaw = transport.client.request("events.unsubscribe", { subscriptionId: raw.subscriptionId });
  const rawUnsubscribe = await transport.nextRequest();
  transport.send({ jsonrpc: "2.0", id: rawUnsubscribe.id, result: { unsubscribed: true } });
  await stopRaw;
});

test("concurrent event subscription helpers claim only their own handoff traffic", async (t) => {
  const transport = fixture();
  t.after(async () => await transport.client.close());
  const firstSeen: number[] = [];
  const secondSeen: number[] = [];
  const firstPromise = transport.client.subscribeEvents(
    { threadId: "thread_rpc_client" },
    (value) => { firstSeen.push(value.sequence); },
    { maxPendingEvents: 4 },
  );
  const firstRequest = await transport.nextRequest();
  const secondPromise = transport.client.subscribeEvents(
    { threadId: "thread_rpc_client" },
    (value) => { secondSeen.push(value.sequence); },
    { maxPendingEvents: 1 },
  );
  const secondRequest = await transport.nextRequest();

  for (const sequence of [50, 51]) {
    transport.send({
      jsonrpc: "2.0",
      method: "events.event",
      params: { subscriptionId: "subscription_first", event: event(sequence) },
    });
  }
  transport.send({
    jsonrpc: "2.0",
    id: firstRequest.id,
    result: { subscriptionId: "subscription_first", replayedThrough: 51, nextCursor: 51, hasMore: false },
  });
  transport.send({
    jsonrpc: "2.0",
    method: "events.event",
    params: { subscriptionId: "subscription_first", event: event(52) },
  });
  const first = await firstPromise;
  transport.send({
    jsonrpc: "2.0",
    method: "events.event",
    params: { subscriptionId: "subscription_second", event: event(60) },
  });
  transport.send({
    jsonrpc: "2.0",
    id: secondRequest.id,
    result: { subscriptionId: "subscription_second", replayedThrough: 60, nextCursor: 60, hasMore: false },
  });
  const second = await secondPromise;
  assert.deepEqual(firstSeen, [50, 51, 52]);
  assert.deepEqual(secondSeen, [60]);

  for (const subscription of [first, second]) {
    const stopping = subscription.unsubscribe();
    const unsubscribe = await transport.nextRequest();
    transport.send({ jsonrpc: "2.0", id: unsubscribe.id, result: { unsubscribed: true } });
    await stopping;
  }
});

test("event subscription can unsubscribe from inside its own async callback", async (t) => {
  const transport = fixture();
  t.after(async () => await transport.client.close());
  let subscription!: RpcEventSubscription;
  let announceCallback!: () => void;
  const callbackStarted = new Promise<void>((resolve) => { announceCallback = resolve; });
  let callbackFinished = false;
  const subscribing = transport.client.subscribeEvents({ threadId: "thread_rpc_client" }, async () => {
    announceCallback();
    await subscription.unsubscribe();
    callbackFinished = true;
  });
  const subscribeRequest = await transport.nextRequest();
  transport.send({
    jsonrpc: "2.0",
    id: subscribeRequest.id,
    result: { subscriptionId: "subscription_self", replayedThrough: 0, nextCursor: 0, hasMore: false },
  });
  subscription = await subscribing;
  transport.send({
    jsonrpc: "2.0",
    method: "events.event",
    params: { subscriptionId: subscription.subscriptionId, event: event(70) },
  });
  await callbackStarted;
  const unsubscribe = await transport.nextRequest();
  assert.deepEqual(unsubscribe.params, { subscriptionId: subscription.subscriptionId });
  transport.send({ jsonrpc: "2.0", id: unsubscribe.id, result: { unsubscribed: true } });
  await waitUntil(() => callbackFinished, "self-unsubscribing callback");
  await subscription.unsubscribe();
});

test("event subscription serializes delayed callbacks and unsubscribe drains accepted events once", async (t) => {
  const transport = fixture();
  t.after(async () => await transport.client.close());
  const order: string[] = [];
  let releaseFirst = (): void => {};
  let firstStarted = (): void => {};
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
  let releaseThird = (): void => {};
  let thirdStarted = (): void => {};
  const thirdGate = new Promise<void>((resolve) => { releaseThird = resolve; });
  const thirdReady = new Promise<void>((resolve) => { thirdStarted = resolve; });
  const subscribing = transport.client.subscribeEvents({ threadId: "thread_rpc_client" }, async (value) => {
    order.push(`start:${value.sequence}`);
    if (value.sequence === 1) {
      firstStarted();
      await firstGate;
    }
    if (value.sequence === 3) {
      thirdStarted();
      await thirdGate;
    }
    order.push(`end:${value.sequence}`);
  });
  const subscribeRequest = await transport.nextRequest();
  transport.send({
    jsonrpc: "2.0",
    id: subscribeRequest.id,
    result: {
      subscriptionId: "subscription_serial",
      replayedThrough: 0,
      nextCursor: 0,
      hasMore: false,
    },
  });
  const subscription = await subscribing;

  transport.send({
    jsonrpc: "2.0",
    method: "events.event",
    params: { subscriptionId: subscription.subscriptionId, event: event(1) },
  });
  transport.send({
    jsonrpc: "2.0",
    method: "events.event",
    params: { subscriptionId: subscription.subscriptionId, event: event(2) },
  });
  await firstReady;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start:1"]);
  releaseFirst();
  await waitUntil(() => order.length >= 4, "ordered event callbacks");
  assert.deepEqual(order, ["start:1", "end:1", "start:2", "end:2"]);

  transport.send({
    jsonrpc: "2.0",
    method: "events.event",
    params: { subscriptionId: subscription.subscriptionId, event: event(3) },
  });
  await thirdReady;
  transport.send({
    jsonrpc: "2.0",
    method: "events.event",
    params: { subscriptionId: subscription.subscriptionId, event: event(4) },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const firstUnsubscribe = subscription.unsubscribe();
  const secondUnsubscribe = subscription.unsubscribe();
  assert.strictEqual(secondUnsubscribe, firstUnsubscribe);
  const unsubscribeRequest = await transport.nextRequest();
  assert.equal(unsubscribeRequest.method, "events.unsubscribe");
  transport.send({ jsonrpc: "2.0", id: unsubscribeRequest.id, result: { unsubscribed: true } });
  transport.send({
    jsonrpc: "2.0",
    method: "events.event",
    params: { subscriptionId: subscription.subscriptionId, event: event(5) },
  });
  let settled = false;
  void firstUnsubscribe.then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseThird();
  await firstUnsubscribe;
  assert.deepEqual(order, [
    "start:1",
    "end:1",
    "start:2",
    "end:2",
    "start:3",
    "end:3",
    "start:4",
    "end:4",
  ]);
  assert.equal(settled, true);
});

test("event subscription bounds a slow listener queue and drains accepted events before reporting overflow", async (t) => {
  const transport = fixture();
  t.after(async () => await transport.client.close());
  const seen: number[] = [];
  const failures: Error[] = [];
  let release = (): void => {};
  let started = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const subscribing = transport.client.subscribeEvents({ threadId: "thread_rpc_client" }, async (value) => {
    seen.push(value.sequence);
    if (value.sequence === 1) {
      started();
      await gate;
    }
  }, {
    maxPendingEvents: 8,
    maxPendingBytes: 64 * 1024,
    onError: (failure) => failures.push(failure),
  });
  const subscribeRequest = await transport.nextRequest();
  transport.send({
    jsonrpc: "2.0",
    id: subscribeRequest.id,
    result: {
      subscriptionId: "subscription_bounded",
      replayedThrough: 0,
      nextCursor: 0,
      hasMore: false,
    },
  });
  const subscription = await subscribing;
  for (let sequence = 1; sequence <= 64; sequence += 1) {
    transport.send({
      jsonrpc: "2.0",
      method: "events.event",
      params: { subscriptionId: subscription.subscriptionId, event: event(sequence) },
    });
  }
  await ready;
  const unsubscribeRequest = await transport.nextRequest();
  assert.equal(unsubscribeRequest.method, "events.unsubscribe");
  assert.deepEqual(unsubscribeRequest.params, { subscriptionId: subscription.subscriptionId });
  transport.send({ jsonrpc: "2.0", id: unsubscribeRequest.id, result: { unsubscribed: true } });
  assert.deepEqual(seen, [1]);
  assert.equal(failures.length, 0);

  release();
  await subscription.unsubscribe();
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.message, /delivery queue exceeded 8 events/u);
});

test("event subscription validates explicit pending delivery bounds", async () => {
  const transport = fixture();
  await assert.rejects(
    transport.client.subscribeEvents({ threadId: "thread_rpc_client" }, () => {}, { maxPendingEvents: 0 }),
    /pending event limit/u,
  );
  await assert.rejects(
    transport.client.subscribeEvents({ threadId: "thread_rpc_client" }, () => {}, { maxPendingBytes: 0 }),
    /pending byte limit/u,
  );
  await transport.client.close();
});

test("spawned RPC client owns a stdio child and closes it deterministically", async () => {
  const program = String.raw`
    const { createReadStream, writeFileSync } = await import("node:fs");
    const input = createReadStream("", { fd: 0, autoClose: false });
    input.setEncoding("utf8");
    let pending = "";
    input.on("data", (chunk) => {
      pending += chunk;
      while (pending.includes("\n")) {
        const index = pending.indexOf("\n");
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (line.trim() === "") continue;
        const request = JSON.parse(line);
        const result = request.method === "health"
          ? { status: "ok", version: "fixture", uptimeSeconds: 0, clients: 1, activeRuns: 0 }
          : { shuttingDown: true };
        writeFileSync(1, JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      }
    });
  `;
  const spawned = spawnRpcClient({
    command: process.execPath,
    args: ["--input-type=module", "--eval", program],
    stderr: "pipe",
    killTimeoutMs: 2_000,
  });
  const health = await spawned.client.request("health");
  assert.equal(health.version, "fixture");
  await spawned.client.request("shutdown");
  await spawned.client.close("fixture complete");
  if (spawned.child.exitCode === null && spawned.child.signalCode === null) {
    await new Promise<void>((resolve) => spawned.child.once("exit", () => resolve()));
  }
  assert.ok(spawned.child.exitCode !== null || spawned.child.signalCode !== null);
});

test("Rigyn RPC client resolves the packaged CLI and bypasses platform command shims", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-rpc-client-"));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
  };
  delete environment.RIGYN_RECURSION_DEPTH;
  const spawned = spawnRigynRpcClient({
    args: ["--workspace", root],
    env: environment,
    stderr: "pipe",
    killTimeoutMs: 2_000,
  });
  t.after(async () => {
    await spawned.client.close("test cleanup");
    await rm(root, { recursive: true, force: true });
  });

  const entry = fileURLToPath(new URL("../../dist/bin/rigyn.js", import.meta.url));
  assert.equal(spawned.child.spawnfile, process.execPath);
  assert.deepEqual(spawned.child.spawnargs.slice(1), [entry, "rpc", "--workspace", root]);
  assert.equal((await spawned.client.request("health")).status, "ok");
  await spawned.client.request("shutdown");
  await spawned.client.close("test complete");
});

test("spawned RPC client rejects shell and hostile argv transport options", () => {
  assert.throws(
    () => spawnRpcClient({ command: process.execPath, shell: true }),
    /without a shell/u,
  );
  assert.throws(
    () => spawnRpcClient({ command: process.execPath, args: ["bad\0argument"] }),
    /argument is invalid/u,
  );
});
