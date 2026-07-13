import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RpcRuntimeDispatcher } from "../../src/interfaces/rpc-runtime.js";
import type { RpcRequest } from "../../src/interfaces/rpc.js";
import { CapturePeer, GatedProvider, QueueProvider, createTestRuntime } from "./rpc-helpers.js";

function request(method: string, params?: unknown): RpcRequest {
  return { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) };
}

test("RPC inspects and dequeues recovered idle queues without automatic replay or branch crossover", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-rpc-recovered-queue-"));
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), new QueueProvider([]));
  const dispatcher = new RpcRuntimeDispatcher({ runtime });
  const peer = new CapturePeer("recovery-peer");
  t.after(async () => {
    await dispatcher.close("test complete");
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const thread = await runtime.service.createSession();
  runtime.store.forkBranch({ threadId: thread.threadId, newBranch: "other" });
  const main = runtime.store.enqueueRunInput({
    threadId: thread.threadId,
    branch: "main",
    mode: "steer",
    text: "main recovered",
  });
  runtime.store.markRunInputRecoverable(main.queueId, main.threadId, main.branch);
  const other = runtime.store.enqueueRunInput({
    threadId: thread.threadId,
    branch: "other",
    mode: "follow_up",
    text: "other recovered",
  });
  runtime.store.markRunInputRecoverable(other.queueId, other.threadId, other.branch);

  assert.deepEqual(await dispatcher.dispatch(peer, request("run.queue", { threadId: thread.threadId })), {
    messages: [{ mode: "steer", text: "main recovered" }],
    recovery: { branch: "main", count: 1, automaticReplay: false },
  });
  assert.deepEqual(await dispatcher.dispatch(peer, request("run.queue", {
    threadId: thread.threadId,
    branch: "other",
  })), {
    messages: [{ mode: "follow_up", text: "other recovered" }],
    recovery: { branch: "other", count: 1, automaticReplay: false },
  });
  const restored = await dispatcher.dispatch(peer, request("run.dequeue", { threadId: thread.threadId })) as {
    messages: unknown[];
    lease: { id: string; branch: string; acknowledgeMethod: string };
  };
  assert.deepEqual(restored.messages, [{ mode: "steer", text: "main recovered" }]);
  assert.equal(restored.lease.acknowledgeMethod, "run.dequeue.ack");
  await dispatcher.dispatch(peer, request("run.dequeue.ack", { leaseId: restored.lease.id }));
  assert.deepEqual(await dispatcher.dispatch(peer, request("run.queue", { threadId: thread.threadId })), { messages: [] });
  assert.deepEqual(await dispatcher.dispatch(peer, request("run.queue", {
    threadId: thread.threadId,
    branch: "other",
  })), {
    messages: [{ mode: "follow_up", text: "other recovered" }],
    recovery: { branch: "other", count: 1, automaticReplay: false },
  });
  const otherLease = await dispatcher.dispatch(peer, request("run.dequeue", {
    threadId: thread.threadId,
    branch: "other",
  })) as { messages: unknown[]; lease: { id: string } };
  assert.deepEqual(otherLease.messages, [{ mode: "follow_up", text: "other recovered" }]);
  assert.deepEqual(await dispatcher.dispatch(peer, request("run.queue", {
    threadId: thread.threadId,
    branch: "other",
  })), { messages: [] });
  await dispatcher.dispatch(peer, request("run.dequeue.release", { leaseId: otherLease.lease.id }));
  assert.equal((await dispatcher.dispatch(peer, request("run.queue", {
    threadId: thread.threadId,
    branch: "other",
  })) as { messages: unknown[] }).messages.length, 1);
});

test("RPC active queue inspection and dequeue remain owner-scoped", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-rpc-owned-queue-"));
  const provider = new GatedProvider();
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), provider);
  const dispatcher = new RpcRuntimeDispatcher({ runtime });
  const owner = new CapturePeer("queue-owner");
  const foreign = new CapturePeer("queue-foreign");
  t.after(async () => {
    await dispatcher.close("test complete");
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const started = await dispatcher.dispatch(owner, request("run.start", {
    prompt: "initial",
    provider: provider.id,
    model: "model",
  })) as { threadId: string };
  await provider.ready;
  await dispatcher.dispatch(owner, request("run.followUp", {
    threadId: started.threadId,
    message: "owner queued",
  }));
  await assert.rejects(dispatcher.dispatch(foreign, request("run.queue", { threadId: started.threadId })), /No RPC-owned run/u);
  await assert.rejects(dispatcher.dispatch(foreign, request("run.dequeue", { threadId: started.threadId })), /No RPC-owned run/u);
  assert.deepEqual(await dispatcher.dispatch(owner, request("run.queue", { threadId: started.threadId })), {
    messages: [{ mode: "follow_up", text: "owner queued" }],
  });
  const ownerLease = await dispatcher.dispatch(owner, request("run.dequeue", { threadId: started.threadId })) as {
    messages: unknown[];
    lease: { id: string };
  };
  assert.deepEqual(ownerLease.messages, [{ mode: "follow_up", text: "owner queued" }]);
  await dispatcher.dispatch(owner, request("run.dequeue.ack", { leaseId: ownerLease.lease.id }));
  const maximumRpcImage = Buffer.alloc(8 * 1024 * 1024, 3).toString("base64");
  const maximumInput = request("run.followUp", {
    threadId: started.threadId,
    message: "maximum RPC image",
    images: [{ type: "image", mediaType: "image/png", data: maximumRpcImage }],
  });
  assert.ok(Buffer.byteLength(JSON.stringify(maximumInput), "utf8") < 16 * 1024 * 1024);
  await dispatcher.dispatch(owner, maximumInput);
  const maximumQueue = await dispatcher.dispatch(owner, request("run.queue", { threadId: started.threadId })) as {
    messages: Array<{ images?: Array<{ data?: string }> }>;
  };
  assert.equal(maximumQueue.messages[0]?.images?.[0]?.data, maximumRpcImage);
  assert.ok(Buffer.byteLength(JSON.stringify(maximumQueue), "utf8") < 16 * 1024 * 1024);
  const maximumDequeue = await dispatcher.dispatch(owner, request("run.dequeue", { threadId: started.threadId })) as {
    messages: Array<{ images?: Array<{ data?: string }> }>;
    lease: { id: string };
  };
  assert.equal(maximumDequeue.messages[0]?.images?.[0]?.data, maximumRpcImage);
  await dispatcher.dispatch(owner, request("run.dequeue.ack", { leaseId: maximumDequeue.lease.id }));
  provider.release();
  await dispatcher.dispatch(owner, request("run.wait", { threadId: started.threadId }));
});

test("RPC queue pagination stays below framing limits and oversized image items remain durable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-rpc-framed-queue-"));
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), new QueueProvider([]));
  const dispatcher = new RpcRuntimeDispatcher({ runtime });
  const peer = new CapturePeer("framed-peer");
  t.after(async () => {
    await dispatcher.close("test complete");
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const thread = await runtime.service.createSession();
  const sixMiB = Buffer.alloc(4_500_000, 1).toString("base64");
  for (let index = 0; index < 3; index += 1) {
    const record = runtime.store.enqueueRunInput({
      threadId: thread.threadId,
      branch: "main",
      mode: index % 2 === 0 ? "steer" : "follow_up",
      text: `page-${index}`,
      images: [{ type: "image", mediaType: "image/png", data: sixMiB }],
    });
    runtime.store.markRunInputRecoverable(record.queueId, record.threadId, record.branch);
  }
  const first = await dispatcher.dispatch(peer, request("run.queue", { threadId: thread.threadId })) as {
    messages: unknown[];
    nextOffset?: number;
  };
  assert.equal(first.messages.length, 2);
  assert.equal(first.nextOffset, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") < 16 * 1024 * 1024);
  const second = await dispatcher.dispatch(peer, request("run.queue", {
    threadId: thread.threadId,
    offset: first.nextOffset,
  })) as { messages: unknown[]; nextOffset?: number };
  assert.equal(second.messages.length, 1);
  assert.equal(second.nextOffset, undefined);

  runtime.service.dequeue(thread.threadId);
  const oversizedData = Buffer.alloc(7_500_000, 2).toString("base64");
  const oversized = runtime.store.enqueueRunInput({
    threadId: thread.threadId,
    branch: "main",
    mode: "follow_up",
    text: "oversized for one RPC response",
    images: [
      { type: "image", mediaType: "image/png", data: oversizedData },
      { type: "image", mediaType: "image/png", data: oversizedData },
    ],
  });
  runtime.store.markRunInputRecoverable(oversized.queueId, oversized.threadId, oversized.branch);
  const inspection = await dispatcher.dispatch(peer, request("run.queue", { threadId: thread.threadId })) as {
    messages: unknown[];
    blocked?: { item?: { imageCount?: number; images?: unknown[] } };
  };
  assert.deepEqual(inspection.messages, []);
  assert.equal(inspection.blocked?.item?.imageCount, 2);
  assert.equal(JSON.stringify(inspection).includes(oversizedData.slice(0, 128)), false);
  const dequeue = await dispatcher.dispatch(peer, request("run.dequeue", { threadId: thread.threadId })) as {
    messages: unknown[];
    blocked?: unknown;
  };
  assert.deepEqual(dequeue.messages, []);
  assert.ok(dequeue.blocked !== undefined);
  assert.equal(runtime.service.recoverableMessageCount(thread.threadId), 1);
});
