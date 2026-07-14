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
    result: { subscriptionId: "subscription_expected", replayedThrough: 1 },
  });
  const subscription = await subscribing;
  assert.equal(subscription.subscriptionId, "subscription_expected");
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

test("spawned RPC client owns a stdio child and closes it deterministically", async () => {
  const program = String.raw`
    process.stdin.setEncoding("utf8");
    let pending = "";
    process.stdin.on("data", (chunk) => {
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
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
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
