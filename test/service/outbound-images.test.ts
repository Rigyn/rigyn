import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AdapterEvent,
  CanonicalMessage,
  CapabilityValue,
  ImageBlock,
  ModelInfo,
  ProviderAdapter,
  ProviderRequest,
} from "../../src/core/types.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import type { HarnessTool } from "../../src/tools/types.js";

const DATA_IMAGE: ImageBlock = {
  type: "image",
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=",
};
const URL_IMAGE: ImageBlock = {
  type: "image",
  mediaType: "image/jpeg",
  url: "https://images.example.test/outbound-url-sentinel.jpg",
};
const STEER_IMAGE: ImageBlock = {
  type: "image",
  mediaType: "image/webp",
  data: "c3RlZXJpbmctaW1hZ2Utc2VudGluZWw=",
};
const FOLLOW_IMAGE: ImageBlock = {
  type: "image",
  mediaType: "image/gif",
  url: "https://images.example.test/follow-up-url-sentinel.gif",
};
const SOURCE_SENTINELS = /iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAw|outbound-url-sentinel|c3RlZXJpbmctaW1hZ2Utc2VudGluZWw|follow-up-url-sentinel/u;

function model(provider: string, id: string, images: CapabilityValue): ModelInfo {
  const unknown = { value: "unknown" as const, source: "provider" as const, observedAt: "2026-01-01T00:00:00.000Z" };
  return {
    id,
    provider,
    contextTokens: 200_000,
    maxOutputTokens: 4_096,
    capabilities: {
      tools: unknown,
      reasoning: unknown,
      images: { value: images, source: "provider", observedAt: "2026-01-01T00:00:00.000Z" },
    },
  };
}

function response(text: string): AdapterEvent[] {
  return [
    { type: "response_start", model: "model" },
    { type: "text_delta", part: 0, text },
    {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: text } },
    },
  ];
}

function assertNoImageSources(requests: readonly ProviderRequest[]): void {
  for (const request of requests) {
    const serialized = JSON.stringify(request);
    assert.doesNotMatch(serialized, SOURCE_SENTINELS);
    assert.equal(request.messages.flatMap((message) => message.content).some((block) => block.type === "image"), false);
    for (const block of request.messages.flatMap((message) => message.content)) {
      if (block.type === "tool_result") assert.equal(block.images, undefined);
    }
  }
}

class BoundaryProvider implements ProviderAdapter {
  readonly id = "image-boundary";
  readonly requests: ProviderRequest[] = [];
  readonly secondRequest: Promise<void>;
  #secondRequestResolve!: () => void;
  #releaseSecond!: () => void;
  readonly #secondReleased: Promise<void>;

  constructor() {
    this.secondRequest = new Promise((resolve) => { this.#secondRequestResolve = resolve; });
    this.#secondReleased = new Promise((resolve) => { this.#releaseSecond = resolve; });
  }

  release(): void {
    this.#releaseSecond();
  }

  async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(request));
    const call = this.requests.length;
    if (call === 1) {
      yield { type: "response_start", model: request.model };
      yield { type: "tool_call_start", index: 0, id: "image-call", name: "image_fixture" };
      yield {
        type: "tool_call_end",
        index: 0,
        id: "image-call",
        name: "image_fixture",
        rawArguments: "{}",
        arguments: {},
      };
      yield {
        type: "response_end",
        reason: "tool_calls",
        state: { kind: "chat_completions", assistantMessage: { role: "assistant", tool_calls: [] } },
      };
      return;
    }
    if (call === 2) {
      yield { type: "response_start", model: request.model };
      this.#secondRequestResolve();
      await this.#secondReleased;
      yield { type: "text_delta", part: 0, text: "tool complete" };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "tool complete" } },
      };
      return;
    }
    yield* response(call === 5 ? "bounded compact summary" : `done-${call}`);
  }

  async listModels(): Promise<ModelInfo[]> {
    return [model(this.id, "model", "supported")];
  }
}

const imageTool: HarnessTool = {
  definition: {
    name: "image_fixture",
    description: "Return bounded fixture images",
    inputSchema: { type: "object", additionalProperties: false },
  },
  validate() {},
  resources() { return []; },
  async execute() {
    return { content: "fixture image attached", isError: false, images: [DATA_IMAGE] };
  },
};

async function serviceFor(
  root: string,
  store: SessionStore,
  provider: ProviderAdapter,
  extraTools: HarnessTool[] = [],
): Promise<HarnessService> {
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    extraTools,
    projectTrusted: false,
  });
  await service.initialize();
  return service;
}

test("block keeps initial, queued, and tool-result images durable but omits every provider-bound source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-outbound-images-"));
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const provider = new BoundaryProvider();
  const service = await serviceFor(root, store, provider, [imageTool]);
  t.after(async () => {
    await service.close();
    store.close();
  });
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const running = service.run({
    prompt: `inspect ${"old-context ".repeat(2_000)}`,
    images: [DATA_IMAGE, URL_IMAGE],
    outboundImages: "block",
    provider: provider.id,
    model: "model",
    contextTokenBudget: 100_000,
    summaryTokenBudget: 64,
    maxSteps: 8,
  });
  await provider.secondRequest;
  const activeThread = store.listThreads({ workspaceRoot: root })[0]?.threadId;
  assert.ok(activeThread);
  service.steer(activeThread, "steer with image", [STEER_IMAGE]);
  service.followUp(activeThread, "", [FOLLOW_IMAGE]);
  provider.release();
  const completed = await running;

  assert.equal(completed.results.length, 2);
  assert.equal(provider.requests.length, 4);
  assertNoImageSources(provider.requests);
  assert.ok(provider.requests.every((request) => JSON.stringify(request).includes("Image omitted")));

  const durableBeforeCompaction = JSON.stringify(store.listEvents(completed.threadId));
  assert.match(durableBeforeCompaction, SOURCE_SENTINELS);
  assert.match(store.exportThread(completed.threadId), SOURCE_SENTINELS);

  await service.compact({
    threadId: completed.threadId,
    provider: provider.id,
    model: "model",
    outboundImages: "block",
    contextTokenBudget: 10_000,
    summaryTokenBudget: 64,
  });
  assert.equal(provider.requests.length, 5);
  assertNoImageSources(provider.requests);
  assert.match(JSON.stringify(store.listEvents(completed.threadId)), SOURCE_SENTINELS);
});

class CapabilityProvider implements ProviderAdapter {
  readonly id = "image-capability";
  readonly requests: ProviderRequest[] = [];
  #failedOnce = false;

  async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(request));
    if (request.model === "unsupported" && !this.#failedOnce) {
      this.#failedOnce = true;
      yield {
        type: "error",
        error: {
          category: "network",
          message: "offline retry fixture",
          retryable: true,
          retryAfterMs: 1,
          partial: false,
        },
      };
      return;
    }
    yield* response("done");
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      model(this.id, "unsupported", "unsupported"),
      model(this.id, "unknown", "unknown"),
    ];
  }
}

test("known unsupported models use the safe projection under allow, including retry, while unknown models retain allow behavior", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-image-capability-"));
  const store = new SessionStore(":memory:");
  const provider = new CapabilityProvider();
  const service = await serviceFor(root, store, provider);
  t.after(async () => {
    await service.close();
    store.close();
  });
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await service.run({
    prompt: "unsupported image",
    images: [DATA_IMAGE, URL_IMAGE],
    outboundImages: "allow",
    provider: provider.id,
    model: "unsupported",
    contextTokenBudget: 100_000,
  });
  assert.equal(provider.requests.length, 2);
  assertNoImageSources(provider.requests);

  await service.run({
    prompt: "unknown image",
    images: [DATA_IMAGE],
    outboundImages: "allow",
    provider: provider.id,
    model: "unknown",
    contextTokenBudget: 100_000,
  });
  assert.match(JSON.stringify(provider.requests.at(-1)), /iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAw/u);
});

class SwitchingProvider implements ProviderAdapter {
  readonly requests: ProviderRequest[] = [];

  constructor(readonly id: string) {}

  async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(request));
    yield* response(`${this.id} done`);
  }

  async listModels(): Promise<ModelInfo[]> {
    return [model(this.id, "model", "supported")];
  }
}

test("provider switching reprojects blocked durable images without carrying continuation state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-image-switch-"));
  const store = new SessionStore(":memory:");
  const firstProvider = new SwitchingProvider("image-switch-a");
  const secondProvider = new SwitchingProvider("image-switch-b");
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([firstProvider, secondProvider]),
    projectTrusted: false,
  });
  await service.initialize();
  t.after(async () => {
    await service.close();
    store.close();
  });
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const first = await service.run({
    prompt: "first provider",
    images: [DATA_IMAGE, URL_IMAGE],
    outboundImages: "block",
    provider: firstProvider.id,
    model: "model",
    contextTokenBudget: 100_000,
  });
  await service.run({
    threadId: first.threadId,
    prompt: "second provider",
    outboundImages: "block",
    provider: secondProvider.id,
    model: "model",
    contextTokenBudget: 100_000,
  });

  assertNoImageSources([...firstProvider.requests, ...secondProvider.requests]);
  assert.equal(secondProvider.requests[0]?.providerState, undefined);
  assert.match(JSON.stringify(secondProvider.requests[0]), /Image omitted/u);
  assert.match(JSON.stringify(store.listEvents(first.threadId)), SOURCE_SENTINELS);
});

class OverflowProvider implements ProviderAdapter {
  readonly id = "image-overflow";
  readonly requests: ProviderRequest[] = [];
  #normalCalls = 0;

  async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(request));
    const isSummary = request.messages[0]?.content.some(
      (block) => block.type === "text" && block.text.includes("structured continuation checkpoint"),
    ) === true;
    if (isSummary) {
      yield* response("overflow compact summary");
      return;
    }
    this.#normalCalls += 1;
    if (this.#normalCalls === 1) {
      yield { type: "response_start", model: request.model };
      yield {
        type: "response_end",
        reason: "context_limit",
        state: { kind: "chat_completions", assistantMessage: { role: "assistant" } },
      };
      return;
    }
    yield* response("recovered");
  }

  async listModels(): Promise<ModelInfo[]> {
    return [model(this.id, "model", "supported")];
  }
}

function historicalMessage(id: string, role: "user" | "assistant", image: ImageBlock): CanonicalMessage {
  return {
    id,
    role,
    content: [
      { type: "text", text: `${id} ${"history ".repeat(250)}` },
      ...(role === "user" ? [image] : []),
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(role === "assistant" ? { provider: "image-overflow" } : {}),
  };
}

test("overflow compaction and its summary input cannot recover blocked image bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-image-overflow-"));
  const store = new SessionStore(":memory:");
  const thread = store.createThread({ threadId: "thread-overflow-images", workspaceRoot: root });
  const sink = store.createEventSink({ threadId: thread.threadId, runId: "seed-run" });
  await sink.emit({ type: "run_started", provider: "image-overflow", model: "model" });
  for (let turn = 0; turn < 5; turn += 1) {
    await sink.emit({ type: "message_appended", message: historicalMessage(`u-${turn}`, "user", turn % 2 === 0 ? DATA_IMAGE : URL_IMAGE) });
    await sink.emit({ type: "message_appended", message: historicalMessage(`a-${turn}`, "assistant", DATA_IMAGE) });
  }
  await sink.emit({ type: "run_completed", finishReason: "stop" });

  const provider = new OverflowProvider();
  const service = await serviceFor(root, store, provider);
  t.after(async () => {
    await service.close();
    store.close();
  });
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const result = await service.run({
    threadId: thread.threadId,
    prompt: "continue after provider overflow",
    images: [STEER_IMAGE],
    outboundImages: "block",
    provider: provider.id,
    model: "model",
    contextTokenBudget: 20_000,
    summaryTokenBudget: 64,
    maxSteps: 4,
  });

  assert.equal(result.results[0]?.finalText, "recovered");
  assert.equal(provider.requests.length, 3);
  assert.equal(provider.requests.some((request) => request.messages[0]?.content.some(
    (block) => block.type === "text" && block.text.includes("structured continuation checkpoint"),
  )), true);
  assertNoImageSources(provider.requests);
  assert.match(JSON.stringify(store.listEvents(thread.threadId)), SOURCE_SENTINELS);
});
