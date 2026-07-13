import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AdapterEvent, ImageBlock, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";

class FirstTurnGateProvider implements ProviderAdapter {
  readonly id = "durable-queue-test";
  readonly requests: ProviderRequest[] = [];
  readonly ready: Promise<void>;
  #ready: () => void = () => {};
  #release: () => void = () => {};
  readonly #released: Promise<void>;

  constructor() {
    this.ready = new Promise<void>((resolve) => { this.#ready = resolve; });
    this.#released = new Promise<void>((resolve) => { this.#release = resolve; });
  }

  release(): void {
    this.#release();
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    this.requests.push(request);
    yield { type: "response_start", model: request.model };
    if (this.requests.length === 1) {
      this.#ready();
      await Promise.race([
        this.#released,
        new Promise<never>((_resolve, reject) => signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        )),
      ]);
    }
    const text = `response-${this.requests.length}`;
    yield { type: "text_delta", part: 0, text };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: text } },
    };
  }

  async listModels(_signal: AbortSignal): Promise<ModelInfo[]> {
    return [];
  }
}

function requestUserTexts(request: ProviderRequest): string[] {
  return request.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(""));
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "harness-durable-service-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const provider = new FirstTurnGateProvider();
  const service = new HarnessService({
    store,
    workspace,
    providers: new ProviderRegistry([provider]),
    projectTrusted: false,
  });
  await service.initialize();
  const thread = await service.createSession();
  t.after(async () => {
    await service.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { workspace, store, provider, service, threadId: thread.threadId };
}

test("normal steering and follow-up drain once in mode-preserving FIFO order, including images", async (t) => {
  const runtime = await fixture(t);
  const followImage: ImageBlock = { type: "image", mediaType: "image/png", data: "aGVsbG8=" };
  const running = runtime.service.run({
    threadId: runtime.threadId,
    prompt: "initial",
    provider: runtime.provider.id,
    model: "model",
  });
  await runtime.provider.ready;
  runtime.service.steer(runtime.threadId, "steer first");
  runtime.service.followUp(runtime.threadId, "follow second", [followImage]);
  assert.deepEqual(runtime.service.queuedMessages(runtime.threadId), [
    { mode: "steer", text: "steer first" },
    { mode: "follow_up", text: "follow second", images: [followImage] },
  ]);
  runtime.provider.release();
  const result = await running;

  assert.equal(result.results.length, 2);
  assert.deepEqual(runtime.provider.requests.map(requestUserTexts), [
    ["initial"],
    ["initial", "steer first"],
    ["initial", "steer first", "follow second"],
  ]);
  const finalRequest = runtime.provider.requests.at(-1)!;
  const finalUser = finalRequest.messages.filter((message) => message.role === "user").at(-1)!;
  assert.deepEqual(finalUser.content.filter((block) => block.type === "image"), [followImage]);
  assert.deepEqual(runtime.store.listRunInputs(runtime.threadId, "main"), []);
  assert.deepEqual(runtime.service.queuedMessages(runtime.threadId), []);
});

test("cancellation leaves undelivered input recoverable, never auto-sends it, and idle dequeue restores it", async (t) => {
  const runtime = await fixture(t);
  const image: ImageBlock = { type: "image", mediaType: "image/png", data: "aGVsbG8=" };
  const running = runtime.service.run({
    threadId: runtime.threadId,
    prompt: "cancel this",
    provider: runtime.provider.id,
    model: "model",
  });
  await runtime.provider.ready;
  runtime.service.followUp(runtime.threadId, "unsent after cancellation", [image]);
  runtime.service.cancel(runtime.threadId, "test cancellation");
  assert.equal((await running).results.at(-1)?.finishReason, "cancelled");
  assert.equal(runtime.service.recoverableMessageCount(runtime.threadId), 1);

  runtime.provider.release();
  await runtime.service.run({
    threadId: runtime.threadId,
    prompt: "normal explicit resume",
    provider: runtime.provider.id,
    model: "model",
  });
  assert.equal(runtime.provider.requests.some((request) => requestUserTexts(request).includes("unsent after cancellation")), false);
  assert.equal(runtime.service.recoverableMessageCount(runtime.threadId), 1);
  assert.deepEqual(runtime.service.dequeue(runtime.threadId), [
    { mode: "follow_up", text: "unsent after cancellation", images: [image] },
  ]);
  assert.equal(runtime.service.recoverableMessageCount(runtime.threadId), 0);
});

test("tree navigation makes branch-local recovery the default without exposing another branch's queue", async (t) => {
  const runtime = await fixture(t);
  const source = runtime.store.appendEvent({
    threadId: runtime.threadId,
    event: {
      type: "message_appended",
      message: {
        id: "message-tree-queue",
        role: "user",
        content: [{ type: "text", text: "tree source" }],
        createdAt: "2026-07-12T00:00:00.000Z",
      },
    },
  });
  const main = runtime.store.enqueueRunInput({
    threadId: runtime.threadId,
    branch: "main",
    mode: "follow_up",
    text: "main recovery",
  });
  runtime.store.markRunInputRecoverable(main.queueId, main.threadId, main.branch);

  const navigation = await runtime.service.navigateTree({
    threadId: runtime.threadId,
    targetBranch: "main",
    targetEventId: source.eventId,
    newBranch: "queue-tree",
    summarize: false,
  });
  assert.equal(navigation.cancelled, false);
  const tree = runtime.store.enqueueRunInput({
    threadId: runtime.threadId,
    branch: "queue-tree",
    mode: "steer",
    text: "tree recovery",
  });
  runtime.store.markRunInputRecoverable(tree.queueId, tree.threadId, tree.branch);

  assert.deepEqual(runtime.service.queuedMessages(runtime.threadId), [
    { mode: "steer", text: "tree recovery" },
  ]);
  const lease = runtime.service.leaseOne(runtime.threadId);
  assert.equal(lease?.branch, "queue-tree");
  assert.equal(lease?.message.text, "tree recovery");
  assert.equal(runtime.service.recoverableMessageCount(runtime.threadId, "main"), 1);
  if (lease !== undefined) runtime.service.releaseQueueLease(lease);
});

test("same-process append/delete failure reconciles the durable user event instead of offering a duplicate", async (t) => {
  const runtime = await fixture(t);
  const original = runtime.store.completeRunInputDelivery.bind(runtime.store);
  let injected = false;
  runtime.store.completeRunInputDelivery = (...args: Parameters<SessionStore["completeRunInputDelivery"]>): void => {
    if (!injected) {
      injected = true;
      throw new Error("injected delete failure after append");
    }
    original(...args);
  };

  const running = runtime.service.run({
    threadId: runtime.threadId,
    prompt: "initial",
    provider: runtime.provider.id,
    model: "model",
  });
  await runtime.provider.ready;
  runtime.service.steer(runtime.threadId, "durable exactly once");
  runtime.provider.release();
  await assert.rejects(running, /injected delete failure/u);

  assert.equal(runtime.store.listEvents(runtime.threadId).filter((entry) =>
    entry.event.type === "message_appended" &&
    entry.event.message.role === "user" &&
    entry.event.message.content.some((block) => block.type === "text" && block.text === "durable exactly once")
  ).length, 1);
  assert.deepEqual(runtime.store.listRunInputs(runtime.threadId, "main"), []);
  assert.deepEqual(runtime.service.queuedMessages(runtime.threadId), []);
});

test("an edited restore lease keeps its fixed message id across append/delete failure", async (t) => {
  const runtime = await fixture(t);
  const queued = runtime.store.enqueueRunInput({
    threadId: runtime.threadId,
    branch: "main",
    mode: "follow_up",
    text: "original recovered text",
    images: [{ type: "image", mediaType: "image/png", data: "aGVsbG8=" }],
  });
  runtime.store.markRunInputRecoverable(queued.queueId, queued.threadId, queued.branch);
  const lease = runtime.service.leaseOne(runtime.threadId)!;
  const original = runtime.store.acknowledgeRunInputLease.bind(runtime.store);
  let injected = false;
  runtime.store.acknowledgeRunInputLease = (...args: Parameters<SessionStore["acknowledgeRunInputLease"]>): void => {
    if (!injected) {
      injected = true;
      throw new Error("injected lease delete failure");
    }
    original(...args);
  };
  const running = runtime.service.run({
    threadId: runtime.threadId,
    prompt: "edited recovered text",
    images: [{ type: "image", mediaType: "image/jpeg", url: "https://images.example.test/edited.jpg" }],
    provider: runtime.provider.id,
    model: "model",
    queueLease: lease,
  });
  await assert.rejects(running, /injected lease delete failure/u);

  const users = runtime.store.listEvents(runtime.threadId).filter((entry) =>
    entry.event.type === "message_appended" && entry.event.message.id === lease.messageId);
  assert.equal(users.length, 1);
  assert.deepEqual(users[0]?.event.type === "message_appended" ? users[0].event.message.content : [], [
    { type: "text", text: "edited recovered text" },
    { type: "image", mediaType: "image/jpeg", url: "https://images.example.test/edited.jpg" },
  ]);
  assert.deepEqual(runtime.store.listRunInputs(runtime.threadId, "main"), []);
});
