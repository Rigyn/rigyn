import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@rigyn/models";

import type {
  AdapterEvent,
  ModelInfo,
  ModelProtocolFamily,
  ProviderAdapter,
  ProviderRequest,
} from "../../src/core/types.js";
import { DefaultResourceLoader, type ResourceLoader } from "../../src/core/resource-loader.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { getExtensionRuntimeHost, projectLoadedExtensionHost } from "../../src/extensions/compat.js";
import {
  extensionModelRegistry,
  type ExtensionModelRegistry,
  type ExtensionProviderConfig,
} from "../../src/extensions/model-boundary.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";
import { extensionUsage } from "../../src/extensions/session-contract.js";
import { providerAdapterFromModels } from "../../src/providers/internal-runtime-bridge.js";
import {
  createModels,
  createProvider,
  type ProviderModel,
} from "../../src/providers/index.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { AgentSession, type AgentSessionEvent, type AgentSessionModel } from "../../src/service/agent-session.js";
import { SessionManager } from "../../src/storage/index.js";

const observedAt = "2026-07-20T00:00:00.000Z";
const supported = { value: "supported", source: "provider", observedAt } as const;

function model(provider: string, id: string, api: ModelProtocolFamily): ModelInfo {
  return {
    id,
    provider,
    capabilities: { tools: supported, reasoning: supported, images: supported },
    compatibility: {
      protocolFamily: { value: api, source: "provider", observedAt },
    },
  };
}

function branchSummaryModel(info: ModelInfo, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return { ...info, contextTokens: 64_000, maxOutputTokens: 4_096, ...overrides };
}

function directProvider(
  providerId: string,
  modelId: string,
  text: string,
): { id: string; config: ExtensionProviderConfig; model: Model<Api> } {
  const selected: Model<Api> = {
    id: modelId,
    name: modelId,
    api: "context-fixture-stream",
    provider: providerId,
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4_096,
    maxTokens: 512,
  };
  const response = (): ReturnType<typeof createAssistantMessageEventStream> => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text }],
        api: selected.api,
        provider: providerId,
        model: modelId,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
  return {
    id: providerId,
    model: selected,
    config: {
      name: providerId,
      baseUrl: selected.baseUrl,
      apiKey: "fixture-key",
      api: selected.api,
      models: [{
        id: selected.id,
        name: selected.name,
        api: selected.api,
        reasoning: selected.reasoning,
        input: [...selected.input],
        cost: { ...selected.cost },
        contextWindow: selected.contextWindow,
        maxTokens: selected.maxTokens,
      }],
      streamSimple: response,
    },
  };
}

class RecordingProvider implements ProviderAdapter {
  readonly id = "fixture";
  readonly requests: ProviderRequest[] = [];
  readonly models = [
    model(this.id, "one", "openai-chat-completions"),
    model(this.id, "two", "openai-chat-completions"),
  ];

  async *stream(request: ProviderRequest, _signal?: AbortSignal): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(request));
    yield { type: "response_start", model: request.model };
    yield { type: "text_delta", part: 0, text: `answer-${this.requests.length}` };
    yield {
      type: "usage",
      semantics: "final",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
      },
    };
    yield {
      type: "response_end",
      reason: "stop",
      state: {
        kind: "chat_completions",
        assistantMessage: { request: this.requests.length },
      },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models;
  }
}

class BranchSummaryEventProvider extends RecordingProvider {
  readonly #events: readonly AdapterEvent[];

  constructor(events: readonly AdapterEvent[]) {
    super();
    this.#events = events;
  }

  override async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(request));
    for (const event of this.#events) yield event;
  }
}

class BranchSummaryAttemptProvider extends RecordingProvider {
  readonly #attempts: readonly (readonly AdapterEvent[])[];

  constructor(attempts: readonly (readonly AdapterEvent[])[]) {
    super();
    this.#attempts = attempts;
  }

  override async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(request));
    const events = this.#attempts[this.requests.length - 1];
    if (events === undefined) throw new Error("No scripted branch-summary attempt remains");
    for (const event of events) yield event;
  }
}

class GatedProvider extends RecordingProvider {
  readonly started: Promise<void>;
  readonly #release: Promise<void>;
  #markStarted!: () => void;
  #releaseFirst!: () => void;

  constructor() {
    super();
    this.started = new Promise((resolve) => { this.#markStarted = resolve; });
    this.#release = new Promise((resolve) => { this.#releaseFirst = resolve; });
  }

  release(): void {
    this.#releaseFirst();
  }

  override async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.#markStarted();
    await this.#release;
    yield* super.stream(request);
  }
}

class RetryThenSuccessProvider extends RecordingProvider {
  readonly #failures: number;

  constructor(failures: number) {
    super();
    this.#failures = failures;
  }

  override async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(request));
    if (this.requests.length <= this.#failures) {
      yield {
        type: "error",
        error: {
          category: "network",
          message: `retryable failure ${this.requests.length}`,
          retryable: true,
          partial: false,
        },
      };
      return;
    }
    yield { type: "response_start", model: request.model };
    yield { type: "text_delta", part: 0, text: "recovered" };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { request: this.requests.length } },
    };
  }
}

class AbortableProvider extends RecordingProvider {
  override async *stream(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<AdapterEvent> {
    const activeSignal = signal ?? new AbortController().signal;
    this.requests.push(structuredClone(request));
    yield { type: "response_start", model: request.model };
    yield { type: "text_delta", part: 0, text: "partial" };
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(activeSignal.reason instanceof Error ? activeSignal.reason : new Error("aborted"));
      if (activeSignal.aborted) abort();
      else activeSignal.addEventListener("abort", abort, { once: true });
    });
  }
}

class AbortableStructuredStreamProvider extends RecordingProvider {
  override async *stream(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<AdapterEvent> {
    const activeSignal = signal ?? new AbortController().signal;
    this.requests.push(structuredClone(request));
    yield { type: "response_start", model: request.model };
    yield { type: "reasoning_start", part: 0, visibility: "provider_trace" };
    yield { type: "reasoning_delta", part: 0, text: "working", visibility: "provider_trace" };
    yield {
      type: "reasoning_end",
      part: 0,
      text: "working",
      visibility: "provider_trace",
      thinkingSignature: "reason-signature",
      redacted: true,
    };
    yield { type: "text_start", part: 1 };
    yield { type: "text_delta", part: 1, text: "answer" };
    yield { type: "text_end", part: 1, text: "answer", textSignature: "text-signature" };
    yield { type: "tool_call_start", index: 2, id: "partial-call", name: "read" };
    yield { type: "tool_call_delta", index: 2, jsonFragment: '{"path":"par' };
    yield {
      type: "tool_call_end",
      index: 2,
      id: "partial-call",
      name: "read",
      rawArguments: '{"path":"partial.txt"}',
      arguments: { path: "partial.txt" },
      thoughtSignature: "tool-signature",
    };
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(activeSignal.reason instanceof Error ? activeSignal.reason : new Error("aborted"));
      if (activeSignal.aborted) abort();
      else activeSignal.addEventListener("abort", abort, { once: true });
    });
  }
}

type ScriptedUsageReply =
  | { kind: "success"; text: string; totalTokens: number }
  | { kind: "error"; message: string };

class ScriptedUsageProvider extends RecordingProvider {
  readonly #replies: ScriptedUsageReply[];

  constructor(replies: ScriptedUsageReply[]) {
    super();
    this.#replies = [...replies];
  }

  override async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(request));
    const reply = this.#replies.shift();
    if (reply === undefined) throw new Error("No scripted provider reply remains");
    if (reply.kind === "error") {
      yield {
        type: "error",
        error: {
          category: "provider",
          message: reply.message,
          retryable: false,
          partial: false,
        },
      };
      return;
    }
    yield { type: "response_start", model: request.model };
    yield { type: "text_delta", part: 0, text: reply.text };
    yield {
      type: "usage",
      semantics: "final",
      usage: {
        inputTokens: reply.totalTokens,
        outputTokens: 0,
        totalTokens: reply.totalTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { request: this.requests.length } },
    };
  }
}

class ContextLimitProvider extends RecordingProvider {
  override async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(request));
    yield {
      type: "error",
      error: {
        category: "invalid_request",
        message: "fixture context limit",
        providerCode: "context_length_exceeded",
        retryable: false,
        partial: false,
      },
    };
  }
}

const roots = new Set<string>();

function sessionOptions(sessionManager: SessionManager, providers: ProviderRegistry) {
  return { sessionManager, providers, settingsManager: SettingsManager.inMemory() };
}

async function recordingModelRegistry(provider: RecordingProvider): Promise<ModelRegistry> {
  const models = createModels();
  models.setProvider(createProvider({
    id: provider.id,
    auth: {
      apiKey: {
        name: "Fixture key",
        async resolve() { return { auth: { apiKey: "fixture" }, source: "fixture" }; },
      },
    },
    models: ["one", "two"].map((id): ProviderModel => ({
      id,
      name: id,
      api: "openai-chat-completions",
      provider: provider.id,
      baseUrl: "https://example.test/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 8_000,
    })),
    api: { async *stream() {} },
  }));
  const registry = new ModelRegistry(models);
  await registry.refresh();
  return registry;
}

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rigyn-agent-session-"));
  roots.add(path);
  return path;
}

async function branchSummaryFixture(
  provider: RecordingProvider,
  settingsManager: SettingsManager = SettingsManager.inMemory(),
): Promise<{ session: AgentSession; manager: SessionManager; target: string; leaf: string | null }> {
  const cwd = await workspace();
  const manager = SessionManager.inMemory(cwd, { id: `branch-summary-${roots.size}` });
  const target = manager.appendMessage({
    id: "branch-summary-root",
    role: "user",
    content: [{ type: "text", text: "root" }],
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  manager.appendMessage({
    id: "branch-summary-abandoned",
    role: "user",
    content: [{ type: "text", text: "abandoned work" }],
    createdAt: "2026-07-20T00:00:01.000Z",
  });
  const session = await AgentSession.create({
    sessionManager: manager,
    providers: new ProviderRegistry([provider]),
    settingsManager,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: branchSummaryModel(provider.models[0]!),
  });
  return { session, manager, target, leaf: manager.getLeafId() };
}

function seedCompactableHistory(
  manager: SessionManager,
  provider: RecordingProvider,
  latestUsageTokens = 410,
): string {
  let selectedEntryId = "";
  for (let turn = 1; turn <= 4; turn += 1) {
    const userEntry = manager.appendMessage({
      id: `seed-user-${turn}`,
      role: "user",
      content: [{ type: "text", text: `question ${turn} ${"x".repeat(80)}` }],
      createdAt: `2026-07-20T00:00:0${turn}.000Z`,
    });
    manager.appendMessage({
      id: `seed-assistant-${turn}`,
      role: "assistant",
      content: [{ type: "text", text: `answer ${turn} ${"y".repeat(80)}` }],
      createdAt: `2026-07-20T00:00:1${turn}.000Z`,
      provider: provider.id,
      api: "openai-chat-completions",
      model: "one",
      stopReason: "stop",
      toolDefinitionFingerprint: "seed-fixture",
      usage: {
        inputTokens: turn === 4 ? Math.max(0, latestUsageTokens - 10) : turn * 100,
        outputTokens: 10,
        totalTokens: turn === 4 ? latestUsageTokens : turn * 100 + 10,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    if (turn === 4) selectedEntryId = userEntry;
  }
  return selectedEntryId;
}

test.afterEach(async () => {
  await Promise.all([...roots].map(async (root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

test("AgentSession reports prompt preflight success and failure exactly once", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const providers = new ProviderRegistry([provider]);
  const session = await AgentSession.create(sessionOptions(SessionManager.inMemory(cwd), providers));
  const failed: boolean[] = [];
  await assert.rejects(session.prompt("missing model", {
    preflightResult(value) { failed.push(value); },
  }), /No model is selected/u);
  assert.deepEqual(failed, [false]);

  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });
  const succeeded: boolean[] = [];
  await session.prompt("ready", {
    allowedTools: [],
    preflightResult(value) { succeeded.push(value); },
  });
  assert.deepEqual(succeeded, [true]);
  await session.close();
});

test("AgentSession retry.maxRetries counts retries after the initial attempt", async () => {
  const cwd = await workspace();
  const provider = new RetryThenSuccessProvider(2);
  const settings = SettingsManager.inMemory({
    retry: {
      maxRetries: 2,
      baseDelayMs: 0,
      provider: { maxRetryDelayMs: 0 },
    },
  });
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd),
    providers: new ProviderRegistry([provider]),
    settingsManager: settings,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });

  const result = await session.prompt("retry", { allowedTools: [] });

  assert.equal(provider.requests.length, 3);
  assert.equal(result.results.at(-1)?.finalText, "recovered");
  await session.close();
});

test("AgentSession exposes exact retry lifecycle events and persists retry history without replaying it", async () => {
  const cwd = await workspace();
  const provider = new RetryThenSuccessProvider(2);
  const manager = SessionManager.inMemory(cwd, { id: "retry-events" });
  const settings = SettingsManager.inMemory({
    retry: { maxRetries: 2, baseDelayMs: 0, provider: { maxRetryDelayMs: 0 } },
  });
  const session = await AgentSession.create({
    sessionManager: manager,
    providers: new ProviderRegistry([provider]),
    settingsManager: settings,
  });
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => { events.push(event); });

  const result = await session.prompt("retry", { allowedTools: [] });

  assert.equal(result.results.at(-1)?.finalText, "recovered");
  assert.deepEqual(events.filter((event) => event.type === "auto_retry_start"), [
    { type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 0, errorMessage: "retryable failure 1" },
    { type: "auto_retry_start", attempt: 2, maxAttempts: 2, delayMs: 0, errorMessage: "retryable failure 2" },
  ]);
  assert.deepEqual(events.filter((event) => event.type === "auto_retry_end"), [
    { type: "auto_retry_end", success: true, attempt: 2 },
  ]);
  assert.deepEqual(events.filter((event) => event.type === "agent_end").map((event) => event.willRetry), [true, true, false]);
  assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
  const assistant = manager.getBranch().flatMap((entry) =>
    entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []);
  assert.deepEqual(assistant.map((message) => [message.stopReason, message.retryTransient === true]), [
    ["error", true],
    ["error", true],
    ["stop", false],
  ]);
  assert.equal(session.retryAttempt, 0);
  assert.equal(session.isRetrying, false);
  await session.close();
});

test("AgentSession settles exhausted and cancelled retries exactly once", async (context) => {
  await context.test("exhausted retries", async () => {
    const cwd = await workspace();
    const provider = new RetryThenSuccessProvider(99);
    const manager = SessionManager.inMemory(cwd, { id: "retry-exhausted" });
    const session = await AgentSession.create({
      sessionManager: manager,
      providers: new ProviderRegistry([provider]),
      settingsManager: SettingsManager.inMemory({
        retry: { maxRetries: 2, baseDelayMs: 0, provider: { maxRetryDelayMs: 0 } },
      }),
    });
    await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });
    const events: AgentSessionEvent[] = [];
    session.subscribe((event) => { events.push(event); });

    const result = await session.prompt("retry", { allowedTools: [] });

    assert.equal(result.results.at(-1)?.finishReason, "error");
    assert.equal(provider.requests.length, 3);
    assert.deepEqual(events.filter((event) => event.type === "auto_retry_end"), [
      { type: "auto_retry_end", success: false, attempt: 2, finalError: "retryable failure 3" },
    ]);
    assert.deepEqual(events.filter((event) => event.type === "agent_end").map((event) => event.willRetry), [true, true, false]);
    assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
    const final = manager.buildSessionContext().messages.at(-1);
    assert.equal(final?.role, "assistant");
    assert.equal(final?.role === "assistant" ? final.stopReason : undefined, "error");
    assert.equal(final?.role === "assistant" ? final.retryTransient : undefined, undefined);
    await session.close();
  });

  await context.test("cancelled retry delay", async () => {
    const cwd = await workspace();
    const provider = new RetryThenSuccessProvider(99);
    const session = await AgentSession.create({
      sessionManager: SessionManager.inMemory(cwd, { id: "retry-cancelled" }),
      providers: new ProviderRegistry([provider]),
      settingsManager: SettingsManager.inMemory({
        retry: { maxRetries: 3, baseDelayMs: 60_000, provider: { maxRetryDelayMs: 60_000 } },
      }),
    });
    await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });
    const events: AgentSessionEvent[] = [];
    let sawRetry!: () => void;
    const retryStarted = new Promise<void>((resolve) => { sawRetry = resolve; });
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "auto_retry_start") sawRetry();
    });

    const running = session.prompt("retry", { allowedTools: [] });
    await retryStarted;
    assert.equal(session.isRetrying, true);
    session.abortRetry();
    const result = await running;

    assert.equal(result.results.at(-1)?.finishReason, "cancelled");
    assert.deepEqual(events.filter((event) => event.type === "auto_retry_end"), [
      { type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
    ]);
    assert.deepEqual(events.filter((event) => event.type === "agent_end").map((event) => event.willRetry), [true]);
    assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
    assert.equal(session.isRetrying, false);
    assert.equal(session.retryAttempt, 0);
    await session.close();
  });
});

test("AgentSession persists an aborted partial assistant before settling", async () => {
  const cwd = await workspace();
  const provider = new AbortableProvider();
  const manager = SessionManager.inMemory(cwd, { id: "aborted-assistant" });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });
  const events: AgentSessionEvent[] = [];
  let sawUpdate!: () => void;
  const updated = new Promise<void>((resolve) => { sawUpdate = resolve; });
  session.subscribe((event) => {
    events.push(event);
    if (event.type === "message_update") sawUpdate();
  });

  const running = session.prompt("abort", { allowedTools: [] });
  await updated;
  assert.equal(session.state.isStreaming, true);
  assert.equal(session.state.streamingMessage?.role, "assistant");
  assert.equal(session.state.pendingToolCalls.size, 0);
  assert.equal(session.state.errorMessage, undefined);
  await session.abort("test abort");
  const result = await running;

  assert.equal(result.results.at(-1)?.finishReason, "cancelled");
  const last = manager.buildSessionContext().messages.at(-1);
  assert.equal(last?.role, "assistant");
  assert.equal(last?.role === "assistant" ? last.stopReason : undefined, "aborted");
  assert.equal(last?.role === "assistant" ? last.errorMessage : undefined, "test abort");
  assert.equal(last?.role === "assistant"
    ? last.content.some((block) => block.type === "text" && block.text === "partial")
    : false, true);
  assert.deepEqual(events.filter((event) => event.type === "agent_end").map((event) => event.willRetry), [false]);
  assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
  assert.equal(session.state.isStreaming, false);
  assert.equal(session.state.streamingMessage, undefined);
  assert.equal(session.state.pendingToolCalls.size, 0);
  assert.equal(session.state.errorMessage, "test abort");
  await session.close();
});

test("AgentSession streaming snapshots expose exact text, reasoning, and tool-call lifecycle with signatures", async () => {
  const cwd = await workspace();
  const provider = new AbortableStructuredStreamProvider();
  const manager = SessionManager.inMemory(cwd, { id: "structured-stream-state" });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });
  let observed!: Extract<AgentSessionEvent, { type: "message_update" }>;
  const lifecycle: string[] = [];
  let sawCompletedToolCall!: () => void;
  const completedToolCall = new Promise<void>((resolve) => { sawCompletedToolCall = resolve; });
  session.subscribe((event) => {
    if (event.type !== "message_update") return;
    lifecycle.push(event.assistantMessageEvent.type);
    if (event.assistantMessageEvent.type !== "toolcall_end") return;
    observed = structuredClone(event);
    sawCompletedToolCall();
  });

  const running = session.prompt("stream structured blocks", { allowedTools: [] });
  await completedToolCall;

  const expectedContent = [
    { type: "thinking", thinking: "working", thinkingSignature: "reason-signature", redacted: true },
    { type: "text", text: "answer", textSignature: "text-signature" },
    {
      type: "toolCall",
      id: "partial-call",
      name: "read",
      arguments: { path: "partial.txt" },
      thoughtSignature: "tool-signature",
    },
  ];
  assert.deepEqual(lifecycle, [
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "text_start",
    "text_delta",
    "text_end",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
  ]);
  assert.deepEqual(observed.message.role === "assistant" ? observed.message.content : undefined, expectedContent);
  assert.deepEqual(
    observed.assistantMessageEvent.type === "toolcall_end"
      ? observed.assistantMessageEvent.partial.content
      : undefined,
    expectedContent,
  );
  assert.deepEqual(
    observed.assistantMessageEvent.type === "toolcall_end"
      ? observed.assistantMessageEvent.toolCall
      : undefined,
    expectedContent[2],
  );
  assert.deepEqual(
    session.state.streamingMessage?.role === "assistant"
      ? session.state.streamingMessage.content
      : undefined,
    expectedContent,
  );

  await session.abort("structured stream test complete");
  await running;
  await session.close();
});

test("AgentSession exposes a session-backed operational agent and model runtime", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "public-agent-facade" });
  manager.appendMessage({
    id: "seed-user",
    role: "user",
    content: [{ type: "text", text: "continue this" }],
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  const registry = await recordingModelRegistry(provider);
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    modelRegistry: registry,
  });
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });
  const agent = session.agent;
  const observed: string[] = [];
  const signals: AbortSignal[] = [];
  const unsubscribe = agent.subscribe((event, signal) => {
    observed.push(event.type);
    signals.push(signal);
  });

  agent.steeringMode = "all";
  agent.followUpMode = "all";
  assert.equal(session.steeringMode, "all");
  assert.equal(session.followUpMode, "all");
  assert.ok(session.modelRuntime instanceof ModelRuntime);
  assert.equal(session.modelRuntime.internalRegistry(), registry);
  assert.equal((await session.modelRuntime.getAvailable()).some((entry) => entry.id === "one"), true);

  await agent.continue();
  await agent.prompt("next prompt");
  await agent.steer("queued after answer");
  await agent.continue();
  await agent.prompt([{
    role: "user",
    content: [{ type: "text", text: "batch first" }],
    timestamp: Date.now(),
  }, {
    role: "user",
    content: [{ type: "text", text: "batch second" }],
    timestamp: Date.now(),
  }]);

  assert.equal(provider.requests.length, 4);
  assert.equal(provider.requests[0]!.messages.some((message) =>
    message.role === "user" && message.content.some((block) => block.type === "text" && block.text === "continue this")), true);
  assert.equal(provider.requests[2]!.messages.some((message) =>
    message.role === "user" && message.content.some((block) => block.type === "text" && block.text === "queued after answer")), true);
  assert.deepEqual(provider.requests[3]!.messages.filter((message) => message.role === "user").slice(-2)
    .map((message) => message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("")), [
    "batch first",
    "batch second",
  ]);
  assert.equal(observed.includes("agent_start"), true);
  assert.equal(observed.includes("message_update"), true);
  assert.equal(agent.state.isStreaming, false);
  assert.equal(agent.state.messages.length >= 4, true);
  assert.equal(signals.every((signal) => signal instanceof AbortSignal), true);
  assert.equal(agent.hasQueuedMessages(), false);
  unsubscribe();
  const lifecycle = session.lifecycleSignal;
  await session.close();
  assert.equal(lifecycle.aborted, true);
});

test("AgentSession preserves failed attempts in history without replaying them to a later provider", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "failed-history-projection" });
  manager.appendMessage({
    id: "valid-user",
    role: "user",
    content: [{ type: "text", text: "valid request" }],
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  manager.appendMessage({
    id: "valid-assistant",
    role: "assistant",
    content: [{ type: "text", text: "valid answer" }],
    createdAt: "2026-07-20T00:00:01.000Z",
    provider: provider.id,
    api: "openai-chat-completions",
    model: "one",
    stopReason: "stop",
  });
  manager.appendMessage({
    id: "error-user",
    role: "user",
    content: [{ type: "text", text: "request that failed" }],
    createdAt: "2026-07-20T00:00:02.000Z",
  });
  manager.appendMessage({
    id: "error-assistant",
    role: "assistant",
    content: [
      { type: "text", text: "partial failed answer" },
      {
        type: "provider_opaque",
        provider: provider.id,
        mediaType: "application/json",
        value: { reasoning: "partial failed reasoning" },
      },
      { type: "tool_call", callId: "failed-call", name: "bash", arguments: { command: "false" } },
    ],
    createdAt: "2026-07-20T00:00:03.000Z",
    provider: provider.id,
    api: "openai-chat-completions",
    model: "one",
    stopReason: "error",
    errorMessage: "provider failed",
  });
  manager.appendMessage({
    id: "aborted-user",
    role: "user",
    content: [{ type: "text", text: "request that was interrupted" }],
    createdAt: "2026-07-20T00:00:04.000Z",
  });
  manager.appendMessage({
    id: "aborted-assistant",
    role: "assistant",
    content: [
      { type: "text", text: "partial aborted answer" },
      { type: "tool_call", callId: "aborted-call", name: "find", arguments: { pattern: "unfinished" } },
    ],
    createdAt: "2026-07-20T00:00:05.000Z",
    provider: provider.id,
    api: "openai-chat-completions",
    model: "one",
    stopReason: "aborted",
    errorMessage: "interrupted",
  });
  manager.appendMessage({
    id: "aborted-tool",
    role: "tool",
    content: [{
      type: "tool_result",
      callId: "aborted-call",
      name: "find",
      content: "partial result",
      isError: true,
    }],
    createdAt: "2026-07-20T00:00:06.000Z",
  });
  const persistedBefore = structuredClone(manager.buildSessionContext().messages);
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });

  await session.prompt("continue safely", { allowedTools: [] });

  const request = provider.requests[0]!;
  assert.equal(request.messages.some((entry) => entry.id === "valid-user"), true);
  assert.equal(request.messages.some((entry) => entry.id === "valid-assistant"), true);
  assert.equal(request.messages.some((entry) => entry.id === "error-user"), true);
  assert.equal(request.messages.some((entry) => entry.id === "aborted-user"), true);
  assert.equal(request.messages.some((entry) => ["error-assistant", "aborted-assistant", "aborted-tool"].includes(entry.id)), false);
  assert.equal(request.messages.flatMap((entry) => entry.content).some((block) =>
    (block.type === "tool_call" || block.type === "tool_result") &&
    ["failed-call", "aborted-call"].includes(block.callId)), false);
  assert.equal(request.messages.flatMap((entry) => entry.content).some((block) =>
    block.type === "tool_result" && block.content === "No result provided"), false);
  assert.deepEqual(manager.buildSessionContext().messages.slice(0, persistedBefore.length), persistedBefore);
  assert.equal(manager.buildSessionContext().messages.some((entry) =>
    "id" in entry && entry.id === "error-assistant" && entry.role === "assistant" &&
    entry.content.some((block) => block.type === "text" && block.text === "partial failed answer")), true);
  assert.equal(manager.buildSessionContext().messages.some((entry) =>
    "id" in entry && entry.id === "aborted-assistant" && entry.role === "assistant" &&
    entry.content.some((block) => block.type === "text" && block.text === "partial aborted answer")), true);
  await session.close();
});

test("AgentSession accepts idle steering and follow-up messages with their distinct delivery order", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd);
  const session = await AgentSession.create(sessionOptions(
    manager,
    new ProviderRegistry([provider]),
  ));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });

  const steering = session.steer("idle steer");
  const followUp = session.followUp("idle follow-up");
  assert.equal(steering instanceof Promise, true);
  assert.equal(followUp instanceof Promise, true);
  await Promise.all([steering, followUp]);
  assert.equal(session.sessionManager, manager);
  session.sessionManager.appendSessionInfo("mutable-manager");
  assert.equal(session.sessionName, "mutable-manager");
  assert.equal(session.hasPendingMessages, true);
  assert.equal(session.pendingMessageCount, 2);
  assert.deepEqual(session.getSteeringMessages(), ["idle steer"]);
  assert.deepEqual(session.getFollowUpMessages(), ["idle follow-up"]);

  await session.prompt("initial", { allowedTools: [] });

  const userTexts = (request: ProviderRequest): string[] => request.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .flatMap((block) => block.type === "text" ? [block.text] : []);
  assert.equal(provider.requests.length, 2);
  assert.deepEqual(userTexts(provider.requests[0]!).slice(-2), ["initial", "idle steer"]);
  assert.equal(userTexts(provider.requests[1]!).at(-1), "idle follow-up");
  assert.equal(session.hasPendingMessages, false);
  assert.equal(session.pendingMessageCount, 0);
  await session.close();
});

test("AgentSession preserves idle queues across preflight failure and clears them explicitly", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const session = await AgentSession.create(sessionOptions(
    SessionManager.inMemory(cwd),
    new ProviderRegistry([provider]),
  ));

  session.steer("keep steer");
  session.followUp("keep follow-up");
  await assert.rejects(session.prompt("missing model"), /No model is selected/u);
  assert.deepEqual(session.getSteeringMessages(), ["keep steer"]);
  assert.deepEqual(session.getFollowUpMessages(), ["keep follow-up"]);
  assert.deepEqual(session.clearQueue(), {
    steering: ["keep steer"],
    followUp: ["keep follow-up"],
  });
  assert.equal(session.pendingMessageCount, 0);
  await session.close();
});

test("AgentSession exposes and restores one queued user message with images", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const session = await AgentSession.create(sessionOptions(
    SessionManager.inMemory(cwd),
    new ProviderRegistry([provider]),
  ));
  const image = { type: "image" as const, mediaType: "image/png", data: "aGVsbG8=" };
  session.steer("first", [image]);
  session.followUp("second");
  assert.deepEqual(session.getQueuedMessages(), [
    { mode: "steer", text: "first", images: [image] },
    { mode: "follow_up", text: "second" },
  ]);
  assert.deepEqual(session.dequeueMessage(), { mode: "steer", text: "first", images: [image] });
  assert.deepEqual(session.getQueuedMessages(), [{ mode: "follow_up", text: "second" }]);
  await session.close();
});

test("AgentSession persists one current JSONL session and resumes its exact model tuple", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const providers = new ProviderRegistry([provider]);
  const modelRegistry = await recordingModelRegistry(provider);
  const manager = SessionManager.inMemory(cwd, { id: "current-session" });
  const selected: AgentSessionModel = {
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  };

  const first = await AgentSession.create({ ...sessionOptions(manager, providers), modelRegistry });
  await first.setModel(selected);
  const firstRun = await first.prompt("first", { allowedTools: [] });
  assert.equal(firstRun.sessionId, "current-session");
  assert.equal(firstRun.results.at(-1)?.finalText, "answer-1");
  await first.close();

  const persisted = manager.buildSessionContext();
  assert.deepEqual(persisted.model, {
    provider: provider.id,
    modelId: "one",
  });
  assert.deepEqual(manager.getEntries().map((entry) => entry.type), [
    "model_change",
    "message",
    "message",
    "message",
  ]);
  const persistedAssistant = manager.buildSessionContext().messages.findLast((entry) => entry.role === "assistant");
  assert.equal(
    persistedAssistant !== undefined && "providerState" in persistedAssistant
      ? persistedAssistant.providerState?.kind
      : undefined,
    "chat_completions",
  );
  assert.equal(
    persistedAssistant !== undefined && "toolDefinitionFingerprint" in persistedAssistant
      ? typeof persistedAssistant.toolDefinitionFingerprint
      : "missing",
    "string",
  );
  if (persistedAssistant !== undefined && "providerState" in persistedAssistant) {
    assert.deepEqual(persistedAssistant.providerState?.source, {
      provider: provider.id,
      model: "one",
      api: "openai-chat-completions",
    });
  }

  const resumed = await AgentSession.create({ ...sessionOptions(manager, providers), modelRegistry });
  assert.equal(resumed.model?.provider, provider.id);
  assert.equal(resumed.model?.api, "openai-chat-completions");
  assert.equal(resumed.model?.id, "one");
  await resumed.prompt("second", { allowedTools: [] });
  assert.equal(provider.requests[1]?.providerState?.kind, "chat_completions");
  await resumed.close();
});

test("continuation state is dropped when any provider API model tuple field changes", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const providers = new ProviderRegistry([provider]);
  const manager = SessionManager.inMemory(cwd);
  const session = await AgentSession.create(sessionOptions(manager, providers));

  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });
  await session.prompt("first", { allowedTools: [] });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "two",
    info: provider.models[1]!,
  });
  await session.prompt("second", { allowedTools: [] });

  assert.equal(provider.requests[1]?.providerState, undefined);
  await session.close();
});

test("declared model API mismatches are rejected rather than guessed from model names", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const providers = new ProviderRegistry([provider]);
  const manager = SessionManager.inMemory(cwd);
  const session = await AgentSession.create(sessionOptions(manager, providers));

  await assert.rejects(session.setModel({
    provider: provider.id,
    api: "anthropic-messages",
    id: "one",
    info: provider.models[0]!,
  }), /declares API openai-chat-completions/u);
  await session.close();
});

test("AgentSession preserves ordinary thinking levels before sparse extra levels", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const directModel: ProviderModel = {
    id: "one",
    name: "One",
    api: "openai-chat-completions",
    provider: provider.id,
    baseUrl: "https://example.test/v1",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: provider.id,
    auth: {
      apiKey: {
        name: "Fixture key",
        async resolve() { return { auth: { apiKey: "fixture" }, source: "fixture" }; },
      },
    },
    models: [directModel],
    api: { async *stream() {} },
  }));
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([provider])),
    modelRegistry: new ModelRegistry(models),
    model: {
      provider: provider.id,
      api: "openai-chat-completions",
      id: "one",
      info: provider.models[0]!,
    },
  });

  assert.deepEqual(session.getAvailableThinkingLevels(), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  session.setThinkingLevel("high");
  assert.equal(session.cycleThinkingLevel(), "xhigh");
  assert.equal(session.cycleThinkingLevel(), "max");
  assert.equal(session.cycleThinkingLevel(), "off");
  await session.close();
});

test("AgentSession switches directly between current-session JSONL files", async () => {
  const cwd = await workspace();
  const sessionDirectory = join(cwd, "sessions");
  const provider = new RecordingProvider();
  const providers = new ProviderRegistry([provider]);
  const modelRegistry = await recordingModelRegistry(provider);
  const firstManager = SessionManager.create(cwd, sessionDirectory, { id: "first" });
  const first = await AgentSession.create({ ...sessionOptions(firstManager, providers), modelRegistry });
  await first.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });
  await first.prompt("first", { allowedTools: [] });

  const secondManager = SessionManager.create(cwd, sessionDirectory, { id: "second" });
  const second = await AgentSession.create({ ...sessionOptions(secondManager, providers), modelRegistry });
  await second.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "two",
    info: provider.models[1]!,
  });
  await second.prompt("second", { allowedTools: [] });
  const secondFile = secondManager.getSessionFile();
  assert.notEqual(secondFile, undefined);
  await second.close();

  first.switchSessionFile(secondFile!);
  assert.equal(first.sessionId, "second");
  assert.equal(first.model?.provider, provider.id);
  assert.equal(first.model?.api, "openai-chat-completions");
  assert.equal(first.model?.id, "two");
  assert.equal(first.sessionManager.getSessionFile(), secondFile);
  await first.close();
});

test("newSession keeps the active model and thinking selection in the new JSONL tree", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const providers = new ProviderRegistry([provider]);
  const manager = SessionManager.inMemory(cwd, { id: "before" });
  const session = await AgentSession.create(sessionOptions(manager, providers));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });
  session.setThinkingLevel("high");

  session.newSession({ id: "after" });

  assert.equal(session.sessionId, "after");
  assert.deepEqual(session.model, {
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0],
  });
  assert.equal(session.thinkingLevel, "high");
  assert.deepEqual(manager.buildSessionContext().model, {
    provider: provider.id,
    modelId: "one",
  });
  await session.close();
});

test("AgentSession owns bash persistence, usage stats, and branch-only JSONL export", async (context) => {
  if (process.platform === "win32") {
    context.skip("The direct bash fixture requires a POSIX shell");
    return;
  }
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const providers = new ProviderRegistry([provider]);
  const manager = SessionManager.inMemory(cwd, { id: "owned-runtime" });
  const session = await AgentSession.create(sessionOptions(manager, providers));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 100_000 },
  });

  const bash = await session.executeBash("printf owned");
  assert.equal(bash.exitCode, 0);
  assert.match(bash.output, /owned/u);
  await session.prompt("measure", { allowedTools: [] });

  const stats = session.getSessionStats();
  assert.equal(stats.userMessages, 1);
  assert.equal(stats.assistantMessages, 1);
  assert.equal(stats.totalMessages, 4);
  assert.equal(stats.usage.inputTokens, 10);
  assert.equal(stats.usage.outputTokens, 4);
  assert.equal(stats.cost, 0.002);
  assert.deepEqual(stats.contextUsage, { tokens: 14, contextWindow: 100_000, percent: (14 / 100_000) * 100 });

  const exported = session.exportToJsonl(join(cwd, "exported.jsonl"));
  const rows = (await readFile(exported, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows[0]?.type, "session");
  assert.equal(rows[0]?.version, 3);
  assert.equal(rows.some((row) => row.type === "message" && (row.message as { role?: string }).role === "bashExecution"), true);
  assert.equal(rows.slice(1).every((row, index) => row.parentId === (index === 0 ? null : rows[index]?.id)), true);
  await session.close();
});

test("AgentSession context stats ignore zero usage and estimate messages after a valid post-compaction response", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const providers = new ProviderRegistry([provider]);
  const manager = SessionManager.inMemory(cwd, { id: "context-stats" });
  const session = await AgentSession.create(sessionOptions(manager, providers));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 200_000 },
  });

  const user = (id: string, text: string) => ({
    id,
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  const assistant = (id: string, inputTokens: number) => ({
    id,
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "response" }],
    createdAt: "2026-07-20T00:00:00.000Z",
    provider: provider.id,
    api: "openai-chat-completions" as const,
    model: "one",
    usage: { inputTokens, outputTokens: 0, totalTokens: inputTokens },
    stopReason: "stop" as const,
  });

  manager.appendMessage(user("before-user", "before"));
  manager.appendMessage(assistant("before-assistant", 40_000));
  const kept = manager.appendMessage(user("kept-user", "kept"));
  manager.appendCompaction("summary", kept, 40_000);
  manager.appendMessage(user("after-user", "after"));
  manager.appendMessage(assistant("zero-assistant", 0));

  assert.deepEqual(session.getContextUsage(), {
    tokens: null,
    contextWindow: 200_000,
    percent: null,
  });

  manager.appendMessage(assistant("valid-assistant", 25_000));
  manager.appendMessage(user("trailing-user", "continue with another message"));
  manager.appendMessage(assistant("trailing-zero", 0));

  const contextUsage = session.getContextUsage();
  assert.ok(contextUsage?.tokens !== null && contextUsage?.tokens !== undefined);
  assert.ok(contextUsage.tokens > 25_000);
  assert.equal(contextUsage.contextWindow, 200_000);
  assert.equal(contextUsage.percent, (contextUsage.tokens / 200_000) * 100);
  await session.close();
});

test("AgentSession owns the direct extension run, stream, message, and session lifecycle", async (context) => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const providers = new ProviderRegistry([provider]);
  const manager = SessionManager.inMemory(cwd, { id: "extension-session" });
  const events: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "lifecycle",
      factory(api) {
        api.on("session_start", () => { events.push("session_start"); });
        api.on("before_agent_start", (event) => {
          events.push("before_agent_start");
          return {
            systemPrompt: `${event.systemPrompt}\nextension-system`,
            message: {
              customType: "extension-context",
              content: "extension-context",
              display: false,
            },
          };
        });
        api.on("agent_start", () => { events.push("agent_start"); });
        api.on("turn_start", () => { events.push("turn_start"); });
        api.on("message_start", () => { events.push("message_start"); });
        api.on("message_update", () => { events.push("message_update"); });
        api.on("turn_end", () => { events.push("turn_end"); });
        api.on("agent_end", () => { events.push("agent_end"); });
        api.on("agent_settled", () => { events.push("agent_settled"); });
        api.on("model_select", () => { events.push("model_select"); });
        api.on("thinking_level_select", () => { events.push("thinking_level_select"); });
        api.on("context", (event) => {
          events.push("context");
          return { messages: event.messages };
        });
        api.on("message_end", (event) => {
          events.push(`message_end:${event.message.role}`);
          if (event.message.role !== "assistant") return undefined;
          return {
            message: {
              ...event.message,
              content: [{ type: "text", text: "extension-answer" }],
            },
          };
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    ...sessionOptions(manager, providers),
    extensionRunner: host,
  });
  await session.bindExtensions();
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });
  session.setThinkingLevel("high");
  const run = await session.prompt("hello", { allowedTools: [] });

  assert.equal(run.results.at(-1)?.finalText, "extension-answer");
  assert.match(
    provider.requests[0]?.messages.find((message) => message.role === "system")?.content
      .flatMap((block) => block.type === "text" ? [block.text] : []).join("") ?? "",
    /extension-system/u,
  );
  assert.equal(provider.requests[0]?.messages.some((message) => message.content.some(
    (block) => block.type === "text" && block.text === "extension-context",
  )), true);
  assert.equal(session.messages.some((message) =>
    message.role === "custom" && message.customType === "extension-context" && message.display === false), true);
  for (const event of [
    "session_start",
    "model_select",
    "thinking_level_select",
    "before_agent_start",
    "agent_start",
    "context",
    "turn_start",
    "message_start",
    "message_update",
    "message_end:assistant",
    "turn_end",
    "agent_end",
    "agent_settled",
  ]) assert.equal(events.includes(event), true, `missing ${event}: ${events.join(", ")}`);
  assert.ok(events.indexOf("before_agent_start") < events.indexOf("agent_start"));
  assert.ok(events.indexOf("turn_end") < events.indexOf("agent_end"));
  assert.equal(session.getLastAssistantText(), "extension-answer");
  await session.close();
});

test("custom messages append or trigger exactly once while idle", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "custom-idle" });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });

  await session.sendCustomMessage({
    customType: "notice",
    content: "append only",
    display: true,
    details: { sequence: 1 },
  });
  await session.sendCustomMessage({
    customType: "notice",
    content: "idle delivery label",
    display: false,
    details: { sequence: 2 },
  }, { deliverAs: "steer" });
  assert.equal(provider.requests.length, 0);

  await session.sendCustomMessage({
    customType: "notice",
    content: "trigger custom",
    display: true,
    details: { sequence: 3 },
  }, { triggerTurn: true });

  assert.equal(provider.requests.length, 1);
  const triggerOccurrences = provider.requests[0]!.messages.flatMap((message) => message.content)
    .filter((block) => block.type === "text" && block.text === "trigger custom").length;
  assert.equal(triggerOccurrences, 1);
  const customEntries = manager.getBranch().filter((entry) => entry.type === "custom_message");
  assert.equal(customEntries.length, 3);
  assert.deepEqual(customEntries.map((entry) => entry.details), [
    { sequence: 1 },
    { sequence: 2 },
    { sequence: 3 },
  ]);
  assert.equal(manager.getBranch().some((entry) =>
    entry.type === "message" && entry.message.role === "user" && entry.message.content.some(
      (block) => block.type === "text" && block.text === "trigger custom",
    )), false);
  await session.close();
});

test("nextTurn custom messages are deferred and ordered after the ordinary prompt", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "custom-next-turn" });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });

  await session.sendCustomMessage({
    customType: "carry",
    content: "carry this",
    display: true,
    details: { durable: false },
  }, { triggerTurn: true, deliverAs: "nextTurn" });
  assert.equal(provider.requests.length, 0);
  assert.equal(manager.getBranch().some((entry) => entry.type === "custom_message"), false);

  await session.prompt("normal prompt", { allowedTools: [] });

  const userText = provider.requests[0]!.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .flatMap((block) => block.type === "text" ? [block.text] : []);
  assert.deepEqual(userText.slice(-2), ["normal prompt", "carry this"]);
  assert.deepEqual(
    session.messages.filter((message) => message.role !== "system").map((message) => message.role),
    ["user", "custom", "assistant"],
  );
  await session.close();
});

test("active custom messages preserve identity without entering the visible text queue", async () => {
  const cwd = await workspace();
  const provider = new GatedProvider();
  const manager = SessionManager.inMemory(cwd, { id: "custom-active" });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });
  const active = session.prompt("initial", { allowedTools: [] });
  await provider.started;

  await session.sendCustomMessage({
    customType: "active",
    content: "steer custom",
    display: true,
    details: { mode: "steer" },
  }, { triggerTurn: true });
  await session.sendCustomMessage({
    customType: "active",
    content: "follow custom",
    display: false,
    details: { mode: "follow" },
  }, { deliverAs: "followUp" });
  assert.equal(session.pendingMessageCount, 0);
  assert.equal(manager.getBranch().some((entry) => entry.type === "custom_message"), false);

  provider.release();
  await active;

  assert.equal(provider.requests.length, 3);
  const requestText = (index: number): string[] => provider.requests[index]!.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .flatMap((block) => block.type === "text" ? [block.text] : []);
  assert.equal(requestText(1).at(-1), "steer custom");
  assert.equal(requestText(2).at(-1), "follow custom");
  assert.equal(manager.getBranch().filter((entry) => entry.type === "custom_message").length, 2);
  assert.equal(manager.getBranch().filter((entry) =>
    entry.type === "message" && entry.message.role === "user").length, 1);
  await session.close();
});

test("AgentSession bindExtensions preserves the replacement start reason", async (context) => {
  const cwd = await workspace();
  const starts: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "start-reason",
      factory(api) {
        api.on("session_start", (event) => {
          starts.push(event.reason ?? "missing");
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([new RecordingProvider()])),
    extensionRunner: host,
  });

  await session.bindExtensions({ reason: "resume", previousSessionFile: "/tmp/previous.jsonl" });

  assert.deepEqual(starts, ["resume"]);
  await session.close();
});

test("AgentSession binds extension context before start and discovers resources afterward", async (context) => {
  const cwd = await workspace();
  const lifecycle: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "bound-resource-discovery",
      factory(api) {
        api.on("session_start", (event, extensionContext) => {
          lifecycle.push(`start:${event.reason}:${extensionContext.mode}`);
        });
        api.on("resources_discover", () => {
          lifecycle.push("discover");
          return {
            skillPaths: ["dynamic-skill"],
            promptPaths: ["dynamic-prompt"],
            themePaths: ["dynamic-theme"],
          };
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const extensionsResult = projectLoadedExtensionHost(host);
  const extended: string[][] = [];
  const loader = {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources(paths) {
      lifecycle.push("extend");
      extended.push([
        ...(paths.skillPaths ?? []).map((entry) => entry.path),
        ...(paths.promptPaths ?? []).map((entry) => entry.path),
        ...(paths.themePaths ?? []).map((entry) => entry.path),
      ]);
    },
    async reload() {},
  } satisfies ResourceLoader;
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([new RecordingProvider()])),
    resourceLoader: loader,
    extensionRunner: host,
    sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: "/tmp/previous.jsonl" },
  });

  const errors: string[] = [];
  await session.bindExtensions({
    mode: "rpc",
    onError(error) { errors.push(`${error.event}:${error.error}`); },
  });
  session.extensionRunner.emitError({ extensionPath: "<test>", event: "probe", error: "bound" });

  assert.deepEqual(lifecycle, ["start:resume:rpc", "discover", "extend"]);
  assert.deepEqual(extended, [["dynamic-skill", "dynamic-prompt", "dynamic-theme"]]);
  assert.equal(session.extensionRunner.createContext().cwd, cwd);
  assert.equal(session.extensionRunner.createContext().mode, "rpc");
  assert.equal(session.extensionRunner.createContext().isIdle(), true);
  assert.equal(session.extensionRunner.createCommandContext().getSystemPromptOptions().cwd, cwd);
  assert.deepEqual(errors, ["probe:bound"]);
  await session.close();
});

test("AgentSession reload swaps extension generations and routes later commands and events to the new host", async (context) => {
  const cwd = await workspace();
  const agentDir = join(cwd, "agent-home");
  const settings = SettingsManager.inMemory();
  const lifecycle: string[] = [];
  const commands: string[] = [];
  const inputs: number[] = [];
  const agentStarts: number[] = [];
  let generation = 0;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{
      name: "reload-generation",
      factory(api) {
        const current = ++generation;
        lifecycle.push(`${current}:activate`);
        api.on("session_start", (event) => {
          lifecycle.push(`${current}:start:${event.reason}`);
        });
        api.on("session_shutdown", (event) => {
          lifecycle.push(`${current}:shutdown:${event.reason}`);
        });
        api.on("agent_start", () => {
          agentStarts.push(current);
        });
        api.on("input", (event) => {
          if (event.text !== "intercept") return { action: "continue" };
          inputs.push(current);
          return { action: "handled" };
        });
        api.registerFlag("reload-value", { type: "string", default: "default" });
        api.registerCommand("generation", {
          async handler(_args, commandContext) {
            commands.push(`${current}:${commandContext.getSystemPromptOptions().cwd}`);
          },
        });
      },
    }],
  });
  await loader.reload();
  context.after(async () => await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close());
  const initialHost = getExtensionRuntimeHost(loader.getExtensions().runtime)!;
  initialHost.setFlagValue("reload-value", "preserved");
  const provider = new RecordingProvider();
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd),
    providers: new ProviderRegistry([provider]),
    settingsManager: settings,
    resourceLoader: loader,
    extensionRunner: initialHost,
  });
  const initialRunner = session.extensionRunner;
  assert.equal(initialRunner.getFlagValues().get("reload-value"), "preserved");
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });
  await session.bindExtensions({ reason: "startup" });

  await session.prompt("/generation");
  await session.prompt("before reload", { allowedTools: [] });
  await session.reload({
    beforeSessionStart() {
      lifecycle.push("before-session-start");
    },
  });

  const reloadedHost = getExtensionRuntimeHost(loader.getExtensions().runtime)!;
  assert.notEqual(reloadedHost, initialHost);
  assert.notEqual(session.extensionRunner, initialRunner);
  assert.throws(() => initialRunner.createContext().isIdle(), /stale after AgentSession reload/u);
  assert.equal(session.extensionRunner.getFlagValues().get("reload-value"), "preserved");
  assert.equal(reloadedHost.flagValues().get("reload-value"), "preserved");
  await session.prompt("/generation");
  assert.deepEqual(await session.prompt("intercept"), { sessionId: session.sessionId, results: [] });
  await session.prompt("after reload", { allowedTools: [] });

  assert.equal(generation, 2);
  assert.deepEqual(lifecycle, [
    "1:activate",
    "1:start:startup",
    "1:shutdown:reload",
    "2:activate",
    "before-session-start",
    "2:start:reload",
  ]);
  assert.deepEqual(commands, [`1:${cwd}`, `2:${cwd}`]);
  assert.deepEqual(inputs, [2]);
  assert.deepEqual(agentStarts, [1, 2]);
  assert.equal(provider.requests.length, 2);
  const finalRunner = session.extensionRunner;
  await session.close();
  assert.throws(() => finalRunner.createContext().isIdle(), /stale after AgentSession close/u);
});

test("AgentSession reload atomically adds, removes, and replaces direct providers", async (context) => {
  const cwd = await workspace();
  const agentDir = join(cwd, "agent-home");
  const settings = SettingsManager.inMemory();
  let generation = 0;
  const providerConfig = (name: string, modelId: string) => ({
    name,
    baseUrl: "https://example.test/v1",
    apiKey: "fixture-key",
    api: "openai-chat-completions" as const,
    models: [{
      id: modelId,
      name: modelId,
      reasoning: false,
      input: ["text"] as ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4_096,
      maxTokens: 512,
    }],
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{
      name: "provider-generation",
      factory(api) {
        const current = ++generation;
        if (current === 1) api.registerProvider("removed-provider", providerConfig("Removed", "removed-model"));
        else api.registerProvider("added-provider", providerConfig("Added", "added-model"));
        api.registerProvider(
          "replaced-provider",
          providerConfig(`Replacement ${current}`, `replacement-${current}`),
        );
      },
    }],
  });
  await loader.reload();
  context.after(async () => await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close());
  const providers = new ProviderRegistry();
  const modelRegistry = new ModelRegistry(createModels());
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd),
    providers,
    modelRegistry,
    settingsManager: settings,
    resourceLoader: loader,
  });

  await session.bindExtensions({ reason: "startup" });
  assert.equal(providers.has("removed-provider"), true);
  assert.equal(providers.has("replaced-provider"), true);
  assert.equal(modelRegistry.find("removed-provider", "removed-model")?.id, "removed-model");
  assert.equal(modelRegistry.find("replaced-provider", "replacement-1")?.id, "replacement-1");

  await session.reload();

  assert.equal(providers.has("removed-provider"), false);
  assert.equal(modelRegistry.find("removed-provider", "removed-model"), undefined);
  assert.equal(providers.has("added-provider"), true);
  assert.equal(modelRegistry.find("added-provider", "added-model")?.id, "added-model");
  assert.equal(providers.has("replaced-provider"), true);
  assert.equal(modelRegistry.find("replaced-provider", "replacement-1"), undefined);
  assert.equal(modelRegistry.find("replaced-provider", "replacement-2")?.id, "replacement-2");

  await session.close();
  assert.equal(providers.has("added-provider"), false);
  assert.equal(providers.has("replaced-provider"), false);
  assert.equal(modelRegistry.find("added-provider", "added-model"), undefined);
  assert.equal(modelRegistry.find("replaced-provider", "replacement-2"), undefined);
});

test("session_start modelRegistry providers stream and are cleaned up across reload generations", async (context) => {
  const cwd = await workspace();
  const agentDir = join(cwd, "agent-home");
  const settings = SettingsManager.inMemory();
  const capturedRegistries: ExtensionModelRegistry[] = [];
  const selectedModels: boolean[] = [];
  let generation = 0;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{
      name: "context-provider-generation",
      factory(api) {
        const current = ++generation;
        const fixture = directProvider(
          `context-provider-${current}`,
          `context-model-${current}`,
          `context-response-${current}`,
        );
        api.on("session_start", async (_event, extensionContext) => {
          capturedRegistries.push(extensionContext.modelRegistry);
          extensionContext.modelRegistry.registerProvider(fixture.id, fixture.config);
          const selected = extensionContext.modelRegistry.find(fixture.id, fixture.model.id);
          selectedModels.push(selected !== undefined && await api.setModel(selected));
        });
      },
    }],
  });
  await loader.reload();
  context.after(async () => await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close());
  const providers = new ProviderRegistry();
  const modelRegistry = new ModelRegistry(createModels());
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd),
    providers,
    modelRegistry,
    settingsManager: settings,
    resourceLoader: loader,
  });

  await session.bindExtensions({ reason: "startup" });
  assert.deepEqual(selectedModels, [true]);
  assert.equal(providers.has("context-provider-1"), true);
  assert.equal(session.model?.id, "context-model-1");
  assert.equal((await session.prompt("first", { allowedTools: [] })).results.at(-1)?.finalText, "context-response-1");

  await session.reload();

  assert.deepEqual(selectedModels, [true, true]);
  assert.equal(providers.has("context-provider-1"), false);
  assert.equal(modelRegistry.find("context-provider-1", "context-model-1"), undefined);
  assert.equal(providers.has("context-provider-2"), true);
  assert.equal(session.model?.id, "context-model-2");
  assert.equal((await session.prompt("second", { allowedTools: [] })).results.at(-1)?.finalText, "context-response-2");
  const stale = directProvider("stale-context-provider", "stale-context-model", "stale");
  assert.throws(
    () => capturedRegistries[0]!.registerProvider(stale.id, stale.config),
    /no longer active|host is closed|stale after AgentSession reload/u,
  );

  await session.close();
  assert.equal(providers.has("context-provider-2"), false);
  assert.equal(modelRegistry.find("context-provider-2", "context-model-2"), undefined);
});

test("command context modelRegistry overrides, streams, unregisters, and restores a provider", async (context) => {
  const cwd = await workspace();
  const original = directProvider("context-replacement", "original-model", "original-response");
  const replacement = directProvider("context-replacement", "replacement-model", "replacement-response");
  const modelRegistry = new ModelRegistry(createModels());
  extensionModelRegistry(modelRegistry).registerProvider(original.id, original.config);
  const providers = new ProviderRegistry([
    providerAdapterFromModels(modelRegistry.models(), original.id),
  ]);
  const setModelResults: boolean[] = [];
  let capturedRegistry: ExtensionModelRegistry | undefined;
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "context-provider-commands",
      factory(api) {
        api.registerCommand("context-provider-override", {
          async handler(_args, commandContext) {
            capturedRegistry = commandContext.modelRegistry;
            commandContext.modelRegistry.registerProvider(replacement.id, replacement.config);
            const selected = commandContext.modelRegistry.find(replacement.id, replacement.model.id);
            setModelResults.push(selected !== undefined && await api.setModel(selected));
          },
        });
        api.registerCommand("context-provider-restore", {
          async handler(_args, commandContext) {
            commandContext.modelRegistry.unregisterProvider(original.id);
            const selected = commandContext.modelRegistry.find(original.id, original.model.id);
            setModelResults.push(selected !== undefined && await api.setModel(selected));
          },
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd),
    providers,
    modelRegistry,
    settingsManager: SettingsManager.inMemory(),
    extensionRunner: host,
  });
  await session.setModel(modelRegistry.find(original.id, original.model.id)!);
  await session.bindExtensions({ reason: "startup" });

  assert.equal((await session.prompt("original", { allowedTools: [] })).results.at(-1)?.finalText, "original-response");
  await session.prompt("/context-provider-override");
  assert.deepEqual(setModelResults, [true]);
  assert.equal(modelRegistry.find(original.id, original.model.id), undefined);
  assert.equal(session.model?.id, replacement.model.id);
  assert.equal((await session.prompt("replacement", { allowedTools: [] })).results.at(-1)?.finalText, "replacement-response");

  await session.prompt("/context-provider-restore");
  assert.deepEqual(setModelResults, [true, true]);
  assert.equal(modelRegistry.find(original.id, replacement.model.id), undefined);
  assert.equal(modelRegistry.find(original.id, original.model.id)?.id, original.model.id);
  assert.equal(session.model?.id, original.model.id);
  assert.equal((await session.prompt("restored", { allowedTools: [] })).results.at(-1)?.finalText, "original-response");

  await session.close();
  assert.equal(providers.has(original.id), true);
  assert.equal(modelRegistry.find(original.id, original.model.id)?.id, original.model.id);
  assert.ok(capturedRegistry);
  assert.throws(
    () => capturedRegistry!.registerProvider(replacement.id, replacement.config),
    /no longer active|inactive extension generation|stale after AgentSession close/u,
  );
});

test("AgentSession reload rolls back every provider from a partially activated generation", async (context) => {
  const cwd = await workspace();
  const agentDir = join(cwd, "agent-home");
  const settings = SettingsManager.inMemory();
  let generation = 0;
  const config = (modelId: string) => ({
    name: modelId,
    baseUrl: "https://example.test/v1",
    apiKey: "fixture-key",
    api: "openai-chat-completions" as const,
    models: [{
      id: modelId,
      name: modelId,
      reasoning: false,
      input: ["text"] as ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4_096,
      maxTokens: 512,
    }],
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{
      name: "provider-rollback",
      factory(api) {
        generation += 1;
        if (generation === 1) {
          api.registerProvider("previous-provider", config("previous-model"));
          return;
        }
        api.registerProvider("candidate-one", config("candidate-one-model"));
        api.registerProvider("candidate-two", config("candidate-two-model"));
      },
    }],
  });
  await loader.reload();
  context.after(async () => await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close());
  const providers = new ProviderRegistry([], { maxProviders: 1 });
  const modelRegistry = new ModelRegistry(createModels());
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd),
    providers,
    modelRegistry,
    settingsManager: settings,
    resourceLoader: loader,
  });
  await session.bindExtensions({ reason: "startup" });
  assert.equal(providers.has("previous-provider"), true);

  await assert.rejects(session.reload(), /cannot exceed 1 adapters/u);

  assert.equal(providers.has("candidate-one"), false);
  assert.equal(providers.has("candidate-two"), false);
  assert.equal(modelRegistry.find("candidate-one", "candidate-one-model"), undefined);
  assert.equal(modelRegistry.find("candidate-two", "candidate-two-model"), undefined);
  await session.close();
});

test("AgentSession reload restores the prior provider set when its host remains live", async (context) => {
  const cwd = await workspace();
  const config = (modelId: string) => ({
    name: modelId,
    baseUrl: "https://example.test/v1",
    apiKey: "fixture-key",
    api: "openai-chat-completions" as const,
    models: [{
      id: modelId,
      name: modelId,
      reasoning: false,
      input: ["text"] as ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4_096,
      maxTokens: 512,
    }],
  });
  const previousHost = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "previous-provider",
      factory(api) { api.registerProvider("previous-provider", config("previous-model")); },
    }],
  });
  const candidateHost = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "candidate-providers",
      factory(api) {
        api.registerProvider("candidate-one", config("candidate-one-model"));
        api.registerProvider("candidate-two", config("candidate-two-model"));
      },
    }],
  });
  context.after(async () => {
    await candidateHost.close();
    await previousHost.close();
  });
  let extensionsResult = projectLoadedExtensionHost(previousHost);
  const loader = {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources() {},
    async reload() { extensionsResult = projectLoadedExtensionHost(candidateHost); },
  } satisfies ResourceLoader;
  const providers = new ProviderRegistry([], { maxProviders: 1 });
  const modelRegistry = new ModelRegistry(createModels());
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd),
    providers,
    modelRegistry,
    resourceLoader: loader,
    settingsManager: SettingsManager.inMemory(),
  });
  assert.equal(providers.has("previous-provider"), true);

  await assert.rejects(session.reload(), /cannot exceed 1 adapters/u);

  assert.equal(providers.has("previous-provider"), true);
  assert.equal(modelRegistry.find("previous-provider", "previous-model")?.id, "previous-model");
  assert.equal(providers.has("candidate-one"), false);
  assert.equal(providers.has("candidate-two"), false);
  await session.close();
});

test("AgentSession reload restarts the current extension host when resource loading fails", async (context) => {
  const cwd = await workspace();
  const lifecycle: string[] = [];
  const commands: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "reload-recovery",
      factory(api) {
        api.on("session_start", (event) => {
          lifecycle.push(`start:${event.reason}`);
        });
        api.on("session_shutdown", (event) => {
          lifecycle.push(`shutdown:${event.reason}`);
        });
        api.registerCommand("recovered", {
          async handler() { commands.push("handled"); },
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const extensionsResult = projectLoadedExtensionHost(host);
  const loader = {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources() {},
    async reload() { throw new Error("reload fixture failed"); },
  } satisfies ResourceLoader;
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([new RecordingProvider()])),
    resourceLoader: loader,
    extensionRunner: host,
  });
  const initialRunner = session.extensionRunner;
  await session.bindExtensions({ reason: "startup" });

  await assert.rejects(session.reload(), /reload fixture failed/u);

  assert.equal(session.extensionRunner, initialRunner);
  assert.equal(initialRunner.createContext().isIdle(), true);
  assert.deepEqual(lifecycle, ["start:startup", "shutdown:reload", "start:reload"]);
  assert.deepEqual(await session.prompt("/recovered"), { sessionId: session.sessionId, results: [] });
  assert.deepEqual(commands, ["handled"]);
  await session.close();
});

test("AgentSession owns extension commands and input interception before model validation", async (context) => {
  const cwd = await workspace();
  const commands: string[] = [];
  const inputs: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "input-preflight",
      factory(api) {
        api.registerCommand("probe", {
          async handler(args) { commands.push(args); },
        });
        api.on("input", (event) => {
          inputs.push(event.text);
          return event.text === "handled" ? { action: "handled" } : { action: "continue" };
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const provider = new RecordingProvider();
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([provider])),
    extensionRunner: host,
  });

  assert.deepEqual(await session.prompt("/probe exact args"), { sessionId: session.sessionId, results: [] });
  assert.deepEqual(await session.prompt("handled"), { sessionId: session.sessionId, results: [] });
  assert.deepEqual(commands, ["exact args"]);
  assert.deepEqual(inputs, ["handled"]);
  assert.equal(provider.requests.length, 0);
  await session.close();
});

test("extension commands inspect the same live system prompt options object", async (context) => {
  const cwd = await workspace();
  const seen: Array<Record<string, unknown>> = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "prompt-options",
      factory(api) {
        api.registerCommand("inspect-options", {
          async handler(_args, commandContext) {
            const options = commandContext.getSystemPromptOptions();
            seen.push(options as unknown as Record<string, unknown>);
            (options.selectedTools as string[] | undefined)?.push("mutated_tool");
          },
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const provider = new RecordingProvider();
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([provider])),
    extensionRunner: host,
  });

  await session.prompt("/inspect-options");
  await session.prompt("/inspect-options");

  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.equal(seen[0]?.cwd, cwd);
  assert.deepEqual(seen[0]?.selectedTools, [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "mutated_tool",
    "mutated_tool",
  ]);
  await session.close();
});

test("AgentSession expands transformed skill commands and prompt templates for direct consumers", async (context) => {
  const cwd = await workspace();
  const agentDir = join(cwd, "agent-home");
  const skillDirectory = join(cwd, ".rigyn", "skills", "review");
  const promptDirectory = join(cwd, ".rigyn", "prompts");
  await mkdir(skillDirectory, { recursive: true });
  await mkdir(promptDirectory, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), [
    "---",
    "name: review",
    "description: Review a change",
    "---",
    "Review every changed file.",
  ].join("\n"));
  await writeFile(join(promptDirectory, "brief.md"), "---\ndescription: Make a brief\n---\nTemplate says $1");
  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    extensionFactories: [{
      name: "aliases",
      factory(api) {
        api.on("input", (event) => {
          if (event.text === "skill alias") return { action: "transform", text: "/skill:review alpha" };
          if (event.text === "prompt alias") return { action: "transform", text: "/brief beta" };
          return { action: "continue" };
        });
      },
    }],
  });
  await loader.reload();
  context.after(async () => await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close());
  const provider = new RecordingProvider();
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd),
    providers: new ProviderRegistry([provider]),
    settingsManager: settings,
    resourceLoader: loader,
    extensionsResult: loader.getExtensions(),
  });
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });

  await session.prompt("skill alias", { allowedTools: [] });
  await session.prompt("prompt alias", { allowedTools: [] });
  await session.sendUserMessage("/brief bypass");

  const userText = (request: ProviderRequest): string => request.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .at(-1) ?? "";
  assert.match(userText(provider.requests[0]!), /<skill name="review"/u);
  assert.match(userText(provider.requests[0]!), /Review every changed file\./u);
  assert.match(userText(provider.requests[0]!), /alpha/u);
  assert.doesNotMatch(userText(provider.requests[0]!), /^---/u);
  assert.equal(userText(provider.requests[1]!), "Template says beta");
  assert.equal(userText(provider.requests[2]!), "/brief bypass");
  await session.close();
});

test("AgentSession executes commands during streaming and expands queued input", async (context) => {
  const cwd = await workspace();
  const provider = new GatedProvider();
  const commands: string[] = [];
  const observedStreaming: Array<"steer" | "followUp" | undefined> = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "stream-input",
      factory(api) {
        api.registerCommand("probe", { async handler(args) { commands.push(args); } });
        api.on("input", (event) => {
          observedStreaming.push(event.streamingBehavior);
          return { action: "continue" };
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([provider])),
    extensionRunner: host,
  });
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });
  const active = session.prompt("first", { allowedTools: [] });
  await provider.started;

  await assert.rejects(
    session.prompt("missing behavior"),
    /Agent is already processing\. Specify streamingBehavior \('steer' or 'followUp'\) to queue the message\./u,
  );
  assert.deepEqual(await session.prompt("/probe while-active"), { sessionId: session.sessionId, results: [] });
  await assert.rejects(
    session.steer("/probe queued-command"),
    /Extension command "\/probe" cannot be queued/u,
  );
  assert.deepEqual(await session.prompt("queued", { streamingBehavior: "steer" }), {
    sessionId: session.sessionId,
    results: [],
  });
  assert.deepEqual(commands, ["while-active"]);
  assert.deepEqual(observedStreaming, [undefined, undefined, "steer"]);

  provider.release();
  await active;
  assert.equal(provider.requests.length, 2);
  const queuedText = provider.requests[1]?.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .at(-1);
  assert.equal(queuedText, "queued");
  await session.close();
});

test("AgentSession serializes preparing input before ordered extension delivery", { timeout: 5_000 }, async (context) => {
  const cwd = await workspace();
  const provider = new GatedProvider();
  let enterPreparation!: () => void;
  let releasePreparation!: () => void;
  const preparationEntered = new Promise<void>((resolve) => { enterPreparation = resolve; });
  const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
  const observed: Array<[string, "steer" | "followUp" | undefined]> = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "ordered-input",
      factory(api) {
        api.on("input", async (event) => {
          observed.push([event.text, event.streamingBehavior]);
          if (event.text === "first") {
            enterPreparation();
            await preparationGate;
          }
          return { action: "continue" };
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([provider])),
    extensionRunner: host,
  });
  context.after(async () => {
    releasePreparation();
    provider.release();
    await session.close();
  });
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });

  const first = session.prompt("first", { allowedTools: [] });
  await preparationEntered;
  assert.equal(session.isIdle, false);
  assert.equal(session.isStreaming, false);
  let idleSettled = false;
  const idle = session.waitForIdle().then(() => { idleSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(idleSettled, false);

  const delivered = session.sendUserMessage("second", { deliverAs: "followUp" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, [["first", undefined]]);

  releasePreparation();
  await provider.started;
  await delivered;
  assert.equal(session.isStreaming, true);
  assert.deepEqual(observed, [
    ["first", undefined],
    ["second", "followUp"],
  ]);

  provider.release();
  await first;
  await idle;
  const latestUserText = (request: ProviderRequest): string | undefined => request.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .at(-1);
  assert.deepEqual(provider.requests.map(latestUserText), ["first", "second"]);
  assert.equal(session.isIdle, true);
});

test("AgentSession restores one active queued message instead of delivering it", async () => {
  const cwd = await workspace();
  const provider = new GatedProvider();
  const session = await AgentSession.create(sessionOptions(
    SessionManager.inMemory(cwd),
    new ProviderRegistry([provider]),
  ));
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });
  const active = session.prompt("first", { allowedTools: [] });
  await provider.started;
  const image = { type: "image" as const, mediaType: "image/png", data: "aGVsbG8=" };
  session.followUp("restore me", [image]);
  assert.deepEqual(session.getQueuedMessages(), [{ mode: "follow_up", text: "restore me", images: [image] }]);
  assert.deepEqual(session.dequeueMessage(), { mode: "follow_up", text: "restore me", images: [image] });
  assert.deepEqual(session.getQueuedMessages(), []);
  provider.release();
  await active;
  assert.equal(provider.requests.length, 1);
  await session.close();
});

test("AgentSession persists extension-selected compaction boundaries and token totals", async (context) => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "extension-compaction" });
  const summaryUsage = {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    totalTokens: 100,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
  };
  let selectedEntryId = "";
  for (let turn = 1; turn <= 4; turn += 1) {
    const userEntry = manager.appendMessage({
      id: `compact-user-${turn}`,
      role: "user",
      content: [{ type: "text", text: `question ${turn} ${"x".repeat(80)}` }],
      createdAt: `2026-07-20T00:00:0${turn}.000Z`,
    });
    manager.appendMessage({
      id: `compact-assistant-${turn}`,
      role: "assistant",
      content: [{ type: "text", text: `answer ${turn} ${"y".repeat(80)}` }],
      createdAt: `2026-07-20T00:00:1${turn}.000Z`,
      provider: provider.id,
      api: "openai-chat-completions",
      model: "one",
      stopReason: "stop",
      usage: {
        inputTokens: turn * 100,
        outputTokens: 10,
        totalTokens: turn * 100 + 10,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    if (turn === 4) selectedEntryId = userEntry;
  }
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "compaction-owner",
      factory(api) {
        api.on("session_before_compact", () => ({
          compaction: {
            summary: "extension-owned summary",
            firstKeptEntryId: selectedEntryId,
            tokensBefore: 777,
            usage: extensionUsage(summaryUsage),
            details: { owner: "fixture" },
          },
        }));
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    extensionRunner: host,
    compactionReserveTokens: 200,
    compactionKeepRecentTokens: 200,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 10_000 },
  });
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => { events.push(event); });
  const statsBefore = session.getSessionStats();

  const result = await session.compact();

  const compaction = manager.getBranch().findLast((entry) => entry.type === "compaction");
  assert.equal(compaction?.type, "compaction");
  if (compaction?.type !== "compaction") throw new Error("missing compaction entry");
  assert.equal(compaction.summary, "extension-owned summary");
  assert.equal(compaction.firstKeptEntryId, selectedEntryId);
  assert.equal(compaction.tokensBefore, 777);
  assert.deepEqual(compaction.usage, summaryUsage);
  assert.equal(compaction.fromHook, true);
  assert.deepEqual(compaction.details, { owner: "fixture" });
  assert.deepEqual(result, {
    summary: "extension-owned summary",
    firstKeptEntryId: selectedEntryId,
    tokensBefore: 777,
    estimatedTokensAfter: 153,
    usage: extensionUsage(summaryUsage),
    details: { owner: "fixture" },
  });
  assert.deepEqual(
    manager.buildSessionContext().messages.flatMap((message) => {
      if (message.role === "compactionSummary") return [message.summary];
      if ("id" in message && typeof message.id === "string") return [message.id];
      return [];
    }),
    ["extension-owned summary", "compact-user-4", "compact-assistant-4"],
  );
  assert.equal(provider.requests.length, 0);
  const statsAfter = session.getSessionStats();
  assert.equal(statsAfter.usage.inputTokens, (statsBefore.usage.inputTokens ?? 0) + 10);
  assert.equal(statsAfter.usage.outputTokens, (statsBefore.usage.outputTokens ?? 0) + 20);
  assert.equal(statsAfter.usage.cacheReadTokens, (statsBefore.usage.cacheReadTokens ?? 0) + 30);
  assert.equal(statsAfter.usage.cacheWriteTokens, (statsBefore.usage.cacheWriteTokens ?? 0) + 40);
  assert.equal(statsAfter.cost, statsBefore.cost + 1);
  const compactionEvents = events.filter((event) =>
    event.type === "compaction_start" || event.type === "compaction_end");
  assert.deepEqual(compactionEvents, [
    { type: "compaction_start", reason: "manual" },
    {
      type: "compaction_end",
      reason: "manual",
      result,
      aborted: false,
      willRetry: false,
    },
  ]);
  await session.close();
});

test("AgentSession reports manual compaction failures before a model is selected", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const session = await AgentSession.create(
    sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([provider])),
  );
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => { events.push(event); });

  await assert.rejects(session.compact(), /No model is selected/u);

  assert.deepEqual(events.filter((event) =>
    event.type === "compaction_start" || event.type === "compaction_end"), [
    { type: "compaction_start", reason: "manual" },
    {
      type: "compaction_end",
      reason: "manual",
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: "Compaction failed: No model is selected",
    },
  ]);
  await session.close();
});

test("AgentSession rejects an explicitly aborted manual compaction and reports it once", async (context) => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "aborted-manual-compaction" });
  seedCompactableHistory(manager, provider);
  let entered!: () => void;
  const listenerEntered = new Promise<void>((resolve) => { entered = resolve; });
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "wait-for-compaction-abort",
      factory(api) {
        api.on("session_before_compact", async (event) => {
          entered();
          return await new Promise<{ cancel: true }>((resolve) => {
            event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
          });
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    extensionRunner: host,
    compactionReserveTokens: 200,
    compactionKeepRecentTokens: 200,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 10_000 },
  });
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => { events.push(event); });

  const compacting = session.compact();
  await listenerEntered;
  session.abortCompaction();

  await assert.rejects(compacting, /Compaction cancelled/u);
  assert.deepEqual(events.filter((event) =>
    event.type === "compaction_start" || event.type === "compaction_end"), [
    { type: "compaction_start", reason: "manual" },
    {
      type: "compaction_end",
      reason: "manual",
      result: undefined,
      aborted: true,
      willRetry: false,
    },
  ]);
  assert.equal(manager.getEntries().some((entry) => entry.type === "compaction"), false);
  await session.close();
});

test("AgentSession persists provider usage from generated compaction summaries", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "generated-compaction-usage" });
  seedCompactableHistory(manager, provider);
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    compactionReserveTokens: 200,
    compactionKeepRecentTokens: 200,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 10_000 },
  });
  const statsBefore = session.getSessionStats();

  const result = await session.compact();

  const expectedUsage = {
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
  };
  assert.deepEqual(result.usage, {
    input: 10,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 14,
    cost: expectedUsage.cost,
  });
  const compaction = manager.getBranch().findLast((entry) => entry.type === "compaction");
  assert.equal(compaction?.type, "compaction");
  assert.deepEqual(compaction?.type === "compaction" ? compaction.usage : undefined, expectedUsage);
  const statsAfter = session.getSessionStats();
  assert.equal(statsAfter.usage.inputTokens, (statsBefore.usage.inputTokens ?? 0) + 10);
  assert.equal(statsAfter.usage.outputTokens, (statsBefore.usage.outputTokens ?? 0) + 4);
  assert.equal(statsAfter.cost, statsBefore.cost + 0.002);
  assert.equal(provider.requests.length, 1);
  await session.close();
});

test("standalone AgentSession binds direct extension compaction to the full result", async (context) => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "direct-compaction" });
  seedCompactableHistory(manager, provider);
  let completed: import("../../src/extensions/direct.js").CompactionResult | undefined;
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "direct-compaction",
      factory(api) {
        api.registerCommand("compact-direct", {
          async handler(_args, commandContext) {
            await new Promise<void>((resolve, reject) => {
              commandContext.compact({
                onComplete(result) {
                  completed = result;
                  resolve();
                },
                onError: reject,
              });
            });
          },
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const directModel: ProviderModel = {
    id: "one",
    name: "One",
    api: "openai-chat-completions",
    provider: provider.id,
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10_000,
    maxTokens: 1_000,
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: provider.id,
    auth: {
      apiKey: {
        name: "Fixture key",
        async resolve() { return { auth: { apiKey: "fixture" }, source: "fixture" }; },
      },
    },
    models: [directModel],
    api: { async *stream() {} },
  }));
  const modelRegistry = new ModelRegistry(models);
  await modelRegistry.refresh();
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    modelRegistry,
    extensionRunner: host,
    compactionReserveTokens: 200,
    compactionKeepRecentTokens: 200,
  });
  await session.setModel(directModel);

  await host.runCommand("compact-direct", {
    args: "",
    threadId: session.sessionId,
    branch: manager.getLeafId() ?? "root",
    signal: new AbortController().signal,
  });

  assert.equal(completed?.summary.includes("answer-1"), true);
  assert.equal((completed?.estimatedTokensAfter ?? 0) > 0, true);
  assert.deepEqual(completed?.usage, {
    input: 10,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 14,
    cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
  });
  await session.close();
});

test("AgentSession compacts a successful over-budget response without retrying it", async (context) => {
  const cwd = await workspace();
  const provider = new ScriptedUsageProvider([{ kind: "success", text: "completed answer", totalTokens: 10_001 }]);
  const manager = SessionManager.inMemory(cwd, { id: "successful-overflow" });
  const selectedEntryId = seedCompactableHistory(manager, provider);
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "overflow-summary",
      factory(api) {
        api.on("session_before_compact", () => ({
          compaction: {
            summary: "successful overflow compacted",
            firstKeptEntryId: selectedEntryId,
            tokensBefore: 10_001,
          },
        }));
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    extensionRunner: host,
    compactionReserveTokens: 200,
    compactionKeepRecentTokens: 200,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 10_000 },
  });
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => { events.push(event); });

  const run = await session.prompt("finish once", { allowedTools: [] });

  assert.equal(run.results.at(-1)?.finalText, "completed answer");
  assert.equal(provider.requests.length, 1);
  assert.equal(manager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
  const end = events.findLast((event) => event.type === "compaction_end");
  assert.equal(events.findLast((event) => event.type === "compaction_start")?.reason, "overflow");
  assert.equal(end?.type, "compaction_end");
  if (end?.type !== "compaction_end") throw new Error("missing compaction_end event");
  assert.equal(end.reason, "overflow");
  assert.equal(end.aborted, false);
  assert.equal(end.willRetry, false);
  assert.equal(end.result?.summary, "successful overflow compacted");
  assert.equal((end.result?.estimatedTokensAfter ?? 0) > 0, true);
  await session.close();
});

test("AgentSession treats cancelled post-response compaction as nonfatal", async (context) => {
  const cwd = await workspace();
  const provider = new ScriptedUsageProvider([{ kind: "success", text: "answer after cancellation", totalTokens: 9_900 }]);
  const manager = SessionManager.inMemory(cwd, { id: "cancelled-threshold" });
  seedCompactableHistory(manager, provider);
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "cancel-compaction",
      factory(api) {
        api.on("session_before_compact", () => ({ cancel: true }));
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    extensionRunner: host,
    compactionReserveTokens: 200,
    compactionKeepRecentTokens: 200,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 10_000 },
  });
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => { events.push(event); });

  const run = await session.prompt("continue after compaction cancellation", { allowedTools: [] });

  assert.equal(run.results.at(-1)?.finalText, "answer after cancellation");
  assert.equal(provider.requests.length, 1);
  const end = events.find((event) => event.type === "compaction_end");
  assert.deepEqual(end, {
    type: "compaction_end",
    reason: "threshold",
    result: undefined,
    aborted: true,
    willRetry: false,
  });
  await session.close();
});

test("AgentSession keeps a provider overflow failure authoritative when recovery compaction is cancelled", async (context) => {
  const cwd = await workspace();
  const provider = new ContextLimitProvider();
  const manager = SessionManager.inMemory(cwd, { id: "cancelled-overflow-recovery" });
  seedCompactableHistory(manager, provider);
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "cancel-overflow-recovery",
      factory(api) {
        api.on("session_before_compact", () => ({ cancel: true }));
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    extensionRunner: host,
    compactionReserveTokens: 200,
    compactionKeepRecentTokens: 200,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 10_000 },
  });
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => { events.push(event); });

  const run = await session.prompt("overflow once", { allowedTools: [] });

  assert.equal(run.results.at(-1)?.finishReason, "error");
  assert.equal(run.results.at(-1)?.finalText, "fixture context limit");
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(events.findLast((event) => event.type === "compaction_end"), {
    type: "compaction_end",
    reason: "overflow",
    result: undefined,
    aborted: true,
    willRetry: false,
  });
  assert.equal(manager.getEntries().some((entry) => entry.type === "compaction"), false);
  await session.close();
});

test("AgentSession uses the last valid post-boundary usage after an error response", async (context) => {
  const cwd = await workspace();
  const provider = new ScriptedUsageProvider([{ kind: "error", message: "x".repeat(1_200) }]);
  const manager = SessionManager.inMemory(cwd, { id: "error-threshold" });
  const selectedEntryId = seedCompactableHistory(manager, provider, 9_799);
  const compactionProviderRequestCounts: number[] = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "error-summary",
      factory(api) {
        api.on("session_before_compact", () => {
          compactionProviderRequestCounts.push(provider.requests.length);
          return {
            compaction: {
              summary: "error history compacted",
              firstKeptEntryId: selectedEntryId,
              tokensBefore: 9_900,
            },
          };
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    extensionRunner: host,
    compactionReserveTokens: 200,
    compactionKeepRecentTokens: 200,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 10_000 },
  });
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => { events.push(event); });

  const run = await session.prompt("fail after the threshold check", { allowedTools: [] });

  assert.equal(run.results.at(-1)?.finishReason, "error");
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(compactionProviderRequestCounts, [1]);
  assert.equal(events.findLast((event) => event.type === "compaction_start")?.reason, "threshold");
  const end = events.findLast((event) => event.type === "compaction_end");
  assert.equal(end?.type === "compaction_end" ? end.result?.summary : undefined, "error history compacted");
  await session.close();
});

test("AgentSession ignores assistant usage retained across the last compaction boundary", async () => {
  const cwd = await workspace();
  const provider = new ScriptedUsageProvider([{ kind: "error", message: "x".repeat(1_200) }]);
  const manager = SessionManager.inMemory(cwd, { id: "stale-usage" });
  const first = manager.appendMessage({
    id: "stale-user",
    role: "user",
    content: [{ type: "text", text: "before" }],
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  manager.appendMessage({
    id: "stale-assistant",
    role: "assistant",
    content: [{ type: "text", text: "old answer" }],
    createdAt: "2026-07-20T00:00:01.000Z",
    provider: provider.id,
    api: "openai-chat-completions",
    model: "one",
    stopReason: "stop",
    usage: { inputTokens: 20_000, outputTokens: 0, totalTokens: 20_000 },
  });
  manager.appendCompaction("existing summary", first, 20_000);
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    compactionReserveTokens: 200,
    compactionKeepRecentTokens: 200,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 10_000 },
  });
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => { events.push(event); });

  const run = await session.prompt("new failing request", { allowedTools: [] });

  assert.equal(run.results.at(-1)?.finishReason, "error");
  assert.equal(provider.requests.length, 1);
  assert.equal(manager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
  assert.equal(events.some((event) => event.type === "compaction_start"), false);
  await session.close();
});

test("AgentSession lets extensions guard and summarize direct JSONL tree navigation", async (context) => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "tree-session" });
  const first = manager.appendMessage({
    id: "first-user",
    role: "user",
    content: [{ type: "text", text: "original question" }],
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  manager.appendMessage({
    id: "first-answer",
    role: "assistant",
    content: [{ type: "text", text: "original answer" }],
    createdAt: "2026-07-20T00:00:01.000Z",
  });
  manager.appendMessage({
    id: "second-user",
    role: "user",
    content: [{ type: "text", text: "abandoned work" }],
    createdAt: "2026-07-20T00:00:02.000Z",
  });
  const observed: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "tree",
      factory(api) {
        api.on("session_before_tree", (event) => {
          observed.push(`before:${event.preparation.entriesToSummarize.length}`);
          return { summary: { summary: "extension branch summary", details: { source: "fixture" } } };
        });
        api.on("session_tree", (event) => {
          observed.push(`after:${event.fromExtension === true}`);
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    extensionRunner: host,
  });

  const result = await session.navigateTree(first, { summarize: true });

  assert.equal(result.cancelled, false);
  assert.equal(result.editorText, "original question");
  assert.equal(result.summaryEntry?.summary, "extension branch summary");
  assert.equal(result.summaryEntry?.fromHook, true);
  assert.deepEqual(observed, ["before:2", "after:true"]);
  await session.close();
});

test("AgentSession summarizes a bounded JSONL tail with complete tool pairs and file activity", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "bounded-tree-summary" });
  const target = manager.appendMessage({
    id: "branch-root",
    role: "user",
    content: [{ type: "text", text: "branch root" }],
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  for (let index = 0; index < 40; index += 1) {
    manager.appendMessage({
      id: `large-history-${index}`,
      role: "user",
      content: [{
        type: "text",
        text: `${index === 0 ? "OLDEST BRANCH MARKER " : ""}${index === 39 ? "RECENT BRANCH MARKER " : ""}${"x".repeat(20_000)}`,
      }],
      createdAt: `2026-07-20T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
    });
  }
  manager.appendMessage({
    id: "paired-tool-calls",
    role: "assistant",
    content: [
      {
        type: "tool_call",
        callId: "read-pair",
        name: "read",
        arguments: { path: "/workspace/read-only.ts" },
      },
      {
        type: "tool_call",
        callId: "write-pair",
        name: "write",
        arguments: { path: "/workspace/changed.ts" },
      },
    ],
    createdAt: "2026-07-20T00:01:00.000Z",
  });
  manager.appendMessage({
    id: "paired-tool-results",
    role: "tool",
    content: [
      {
        type: "tool_result",
        callId: "read-pair",
        name: "read",
        content: "read pair result",
        isError: false,
      },
      {
        type: "tool_result",
        callId: "write-pair",
        name: "write",
        content: "write pair result",
        isError: false,
      },
    ],
    createdAt: "2026-07-20T00:01:01.000Z",
  });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: branchSummaryModel(provider.models[0]!),
  });

  const result = await session.navigateTree(target, { summarize: true });

  assert.equal(result.cancelled, false);
  assert.equal(provider.requests.length, 1);
  const requestText = provider.requests[0]!.messages.flatMap((message) => message.content)
    .flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
  assert.ok(Buffer.byteLength(requestText, "utf8") < 512 * 1024);
  assert.match(requestText, /RECENT BRANCH MARKER/u);
  assert.doesNotMatch(requestText, /OLDEST BRANCH MARKER/u);
  assert.match(requestText, /read-pair|read pair result/u);
  assert.match(requestText, /write-pair|write pair result/u);
  assert.match(result.summaryEntry?.summary ?? "", /\[rigyn-file-activity-v1\]/u);
  assert.deepEqual(result.summaryEntry?.details, {
    readFiles: ["/workspace/read-only.ts"],
    modifiedFiles: ["/workspace/changed.ts"],
  });
  await session.close();
});

test("AgentSession retries transient branch summaries with exact public and envelope lifecycle events", async () => {
  const provider = new BranchSummaryAttemptProvider([
    [{
      type: "error",
      error: {
        category: "network",
        message: "branch summary connection reset",
        retryable: true,
        partial: false,
      },
    }],
    [
      { type: "response_start", model: "one" },
      { type: "text_delta", part: 0, text: "recovered branch summary" },
      {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: {} },
      },
    ],
  ]);
  const { session, target } = await branchSummaryFixture(provider, SettingsManager.inMemory({
    retry: { maxRetries: 2, baseDelayMs: 0, provider: { maxRetryDelayMs: 0 } },
  }));
  const direct: AgentSessionEvent[] = [];
  const envelopes: object[] = [];
  session.subscribe((event) => { direct.push(event); });
  session.onEvent((envelope) => {
    if (envelope.event.type.startsWith("summarization_retry_")) {
      envelopes.push(envelope.event);
    }
  });

  const result = await session.navigateTree(target, { summarize: true });

  assert.equal(provider.requests.length, 2);
  assert.equal(result.summaryEntry?.summary, "recovered branch summary");
  const expected = [
    {
      type: "summarization_retry_scheduled",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 0,
      errorMessage: "branch summary connection reset",
    },
    { type: "summarization_retry_attempt_start", source: "branchSummary" },
    { type: "summarization_retry_finished" },
  ];
  assert.deepEqual(direct.filter((event) => event.type.startsWith("summarization_retry_")), expected);
  assert.deepEqual(envelopes, expected);
  await session.close();
});

test("AgentSession branch-summary retry boundaries never move the leaf on failure or cancellation", async (context) => {
  const retrySettings = () => SettingsManager.inMemory({
    retry: { maxRetries: 2, baseDelayMs: 0, provider: { maxRetryDelayMs: 0 } },
  });
  const failures: Array<{ name: string; events: AdapterEvent[]; message: RegExp }> = [
    {
      name: "partial",
      events: [
        { type: "response_start", model: "one" },
        { type: "text_delta", part: 0, text: "partial output" },
        {
          type: "error",
          error: {
            category: "network",
            message: "partial summary stream failed",
            retryable: true,
            partial: false,
          },
        },
      ],
      message: /partial summary stream failed/u,
    },
    {
      name: "protocol",
      events: [{
        type: "error",
        error: {
          category: "protocol",
          message: "malformed summary event order",
          retryable: true,
          partial: false,
        },
      }],
      message: /malformed summary event order/u,
    },
    {
      name: "non-retryable",
      events: [{
        type: "error",
        error: {
          category: "provider",
          message: "summary request rejected",
          retryable: false,
          partial: false,
        },
      }],
      message: /summary request rejected/u,
    },
  ];

  for (const failure of failures) {
    await context.test(failure.name, async () => {
      const provider = new BranchSummaryEventProvider(failure.events);
      const { session, manager, target, leaf } = await branchSummaryFixture(provider, retrySettings());
      const events: AgentSessionEvent[] = [];
      session.subscribe((event) => { events.push(event); });

      await assert.rejects(session.navigateTree(target, { summarize: true }), failure.message);

      assert.equal(provider.requests.length, 1);
      assert.equal(manager.getLeafId(), leaf);
      assert.equal(manager.getEntries().some((entry) => entry.type === "branch_summary"), false);
      assert.equal(events.some((event) => event.type.startsWith("summarization_retry_")), false);
      await session.close();
    });
  }

  await context.test("exhausted transient retries", async () => {
    const provider = new BranchSummaryEventProvider([{
      type: "error",
      error: {
        category: "network",
        message: "summary transport unavailable",
        retryable: true,
        partial: false,
      },
    }]);
    const { session, manager, target, leaf } = await branchSummaryFixture(provider, SettingsManager.inMemory({
      retry: { maxRetries: 1, baseDelayMs: 0, provider: { maxRetryDelayMs: 0 } },
    }));
    const events: AgentSessionEvent[] = [];
    session.subscribe((event) => { events.push(event); });

    await assert.rejects(session.navigateTree(target, { summarize: true }), /summary transport unavailable/u);

    assert.equal(provider.requests.length, 2);
    assert.equal(manager.getLeafId(), leaf);
    assert.equal(manager.getEntries().some((entry) => entry.type === "branch_summary"), false);
    assert.deepEqual(events.filter((event) => event.type.startsWith("summarization_retry_")), [
      {
        type: "summarization_retry_scheduled",
        attempt: 1,
        maxAttempts: 1,
        delayMs: 0,
        errorMessage: "summary transport unavailable",
      },
      { type: "summarization_retry_attempt_start", source: "branchSummary" },
      { type: "summarization_retry_finished" },
    ]);
    await session.close();
  });

  await context.test("cancelled retry delay", async () => {
    const provider = new BranchSummaryAttemptProvider([
      [{
        type: "error",
        error: {
          category: "network",
          message: "summary retry waits",
          retryable: true,
          partial: false,
        },
      }],
      [{ type: "text_delta", part: 0, text: "must not run" }],
    ]);
    const { session, manager, target, leaf } = await branchSummaryFixture(provider, SettingsManager.inMemory({
      retry: { maxRetries: 2, baseDelayMs: 60_000, provider: { maxRetryDelayMs: 60_000 } },
    }));
    const events: AgentSessionEvent[] = [];
    let scheduled!: () => void;
    const retryScheduled = new Promise<void>((resolve) => { scheduled = resolve; });
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "summarization_retry_scheduled") scheduled();
    });

    const navigation = session.navigateTree(target, { summarize: true });
    await retryScheduled;
    session.abortBranchSummary();
    const result = await navigation;

    assert.deepEqual(result, { cancelled: true, aborted: true });
    assert.equal(provider.requests.length, 1);
    assert.equal(manager.getLeafId(), leaf);
    assert.equal(manager.getEntries().some((entry) => entry.type === "branch_summary"), false);
    assert.deepEqual(events.filter((event) => event.type.startsWith("summarization_retry_")).map((event) => event.type), [
      "summarization_retry_scheduled",
      "summarization_retry_finished",
    ]);
    await session.close();
  });
});

test("AgentSession branch-summary cancellation settles without moving the JSONL leaf", async () => {
  const cwd = await workspace();
  const provider = new AbortableProvider();
  const manager = SessionManager.inMemory(cwd, { id: "cancelled-tree-summary" });
  const target = manager.appendMessage({
    id: "cancel-root",
    role: "user",
    content: [{ type: "text", text: "root" }],
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  const abandoned = manager.appendMessage({
    id: "cancel-abandoned",
    role: "user",
    content: [{ type: "text", text: "abandoned work" }],
    createdAt: "2026-07-20T00:00:01.000Z",
  });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: branchSummaryModel(provider.models[0]!),
  });
  const leafBeforeNavigation = manager.getLeafId();

  const navigation = session.navigateTree(target, { summarize: true });
  while (provider.requests.length === 0) await new Promise((resolve) => setImmediate(resolve));
  session.abortBranchSummary();
  const result = await Promise.race([
    navigation,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("branch summary cancellation timed out")), 500)),
  ]);

  assert.deepEqual(result, { cancelled: true, aborted: true });
  assert.notEqual(leafBeforeNavigation, abandoned);
  assert.equal(manager.getLeafId(), leafBeforeNavigation);
  assert.equal(manager.getEntries().some((entry) => entry.type === "branch_summary"), false);
  await session.close();
});

test("AgentSession treats branch navigation as active work and close awaits its cancellation", async () => {
  const cwd = await workspace();
  const provider = new AbortableProvider();
  const manager = SessionManager.inMemory(cwd, { id: "active-tree-summary" });
  const target = manager.appendMessage({
    id: "active-root",
    role: "user",
    content: [{ type: "text", text: "root" }],
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  manager.appendMessage({
    id: "active-abandoned",
    role: "user",
    content: [{ type: "text", text: "abandoned work" }],
    createdAt: "2026-07-20T00:00:01.000Z",
  });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: branchSummaryModel(provider.models[0]!),
  });

  const navigation = session.navigateTree(target, { summarize: true });
  while (provider.requests.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.isIdle, false);
  await assert.rejects(session.reload(), /must be idle/u);
  await assert.rejects(session.prompt("overlap", { allowedTools: [] }), /must be idle/u);
  assert.throws(() => session.newSession(), /must be idle/u);
  await assert.rejects(session.navigateTree(target), /must be idle/u);

  await session.close();
  assert.deepEqual(await navigation, { cancelled: true, aborted: true });
  assert.equal(session.isIdle, true);
});

test("AgentSession rejects branch summarization when the selected model leaves no input budget", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "small-context-tree-summary" });
  const target = manager.appendMessage({
    id: "small-context-root",
    role: "user",
    content: [{ type: "text", text: "root" }],
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  manager.appendMessage({
    id: "small-context-abandoned",
    role: "user",
    content: [{ type: "text", text: "abandoned work" }],
    createdAt: "2026-07-20T00:00:01.000Z",
  });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: branchSummaryModel(provider.models[0]!, { contextTokens: 2_000, maxOutputTokens: 1_500 }),
  });
  const leaf = manager.getLeafId();

  await assert.rejects(
    session.navigateTree(target, { summarize: true }),
    /does not leave a positive input budget/u,
  );
  assert.equal(provider.requests.length, 0);
  assert.equal(manager.getLeafId(), leaf);
  await session.close();
});

test("AgentSession never navigates away when the newest summary content cannot fit", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "oversized-tail-tree-summary" });
  const target = manager.appendMessage({
    id: "oversized-tail-root",
    role: "user",
    content: [{ type: "text", text: "root" }],
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  manager.appendMessage({
    id: "oversized-tail-abandoned",
    role: "user",
    content: [{ type: "text", text: "x".repeat(20_000) }],
    createdAt: "2026-07-20T00:00:01.000Z",
  });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: branchSummaryModel(provider.models[0]!, { contextTokens: 20_000, maxOutputTokens: 2_048 }),
  });
  const leaf = manager.getLeafId();

  await assert.rejects(
    session.navigateTree(target, { summarize: true }),
    /newest complete message or tool pair cannot fit/u,
  );
  assert.equal(provider.requests.length, 0);
  assert.equal(manager.getLeafId(), leaf);
  await session.close();
});

test("AgentSession normalizes reducer and provider-native branch-summary cancellation", async (context) => {
  const cwd = await workspace();
  const reducerManager = SessionManager.inMemory(cwd, { id: "reducer-cancelled-tree" });
  const reducerTarget = reducerManager.appendMessage({
    id: "reducer-root",
    role: "user",
    content: [{ type: "text", text: "root" }],
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  reducerManager.appendMessage({
    id: "reducer-abandoned",
    role: "user",
    content: [{ type: "text", text: "abandoned" }],
    createdAt: "2026-07-20T00:00:01.000Z",
  });
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "cancel-tree",
      factory(api) { api.on("session_before_tree", () => ({ cancel: true })); },
    }],
  });
  context.after(async () => await host.close());
  const reducerSession = await AgentSession.create({
    ...sessionOptions(reducerManager, new ProviderRegistry([new RecordingProvider()])),
    extensionRunner: host,
  });
  assert.deepEqual(
    await reducerSession.navigateTree(reducerTarget, { summarize: true }),
    { cancelled: true, aborted: true },
  );
  await reducerSession.close();

  const provider = new BranchSummaryEventProvider([{
    type: "response_end",
    reason: "cancelled",
    state: { kind: "chat_completions", assistantMessage: {} },
  }]);
  const providerManager = SessionManager.inMemory(cwd, { id: "provider-cancelled-tree" });
  const providerTarget = providerManager.appendMessage({
    id: "provider-root",
    role: "user",
    content: [{ type: "text", text: "root" }],
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  providerManager.appendMessage({
    id: "provider-abandoned",
    role: "user",
    content: [{ type: "text", text: "abandoned" }],
    createdAt: "2026-07-20T00:00:01.000Z",
  });
  const providerSession = await AgentSession.create(sessionOptions(providerManager, new ProviderRegistry([provider])));
  await providerSession.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: branchSummaryModel(provider.models[0]!),
  });
  assert.deepEqual(
    await providerSession.navigateTree(providerTarget, { summarize: true }),
    { cancelled: true, aborted: true },
  );
  await providerSession.close();
});

test("AgentSession rejects branch-summary tool calls, post-terminal data, and oversized output", async () => {
  const cases: Array<{ name: string; events: AdapterEvent[]; error: RegExp }> = [
    {
      name: "tool-call",
      events: [
        { type: "response_start", model: "one" },
        { type: "tool_call_start", index: 0, id: "summary-tool", name: "read" },
      ],
      error: /cannot call tools/u,
    },
    {
      name: "post-terminal",
      events: [
        {
          type: "response_end",
          reason: "stop",
          state: { kind: "chat_completions", assistantMessage: {} },
        },
        { type: "text_delta", part: 0, text: "late data" },
      ],
      error: /data after completion/u,
    },
    {
      name: "oversized-output",
      events: [
        { type: "response_start", model: "one" },
        { type: "text_delta", part: 0, text: "x".repeat(64 * 1024 + 1) },
      ],
      error: /exceeded 65536 bytes/u,
    },
  ];

  for (const value of cases) {
    const cwd = await workspace();
    const provider = new BranchSummaryEventProvider(value.events);
    const manager = SessionManager.inMemory(cwd, { id: `invalid-tree-summary-${value.name}` });
    const target = manager.appendMessage({
      id: `${value.name}-root`,
      role: "user",
      content: [{ type: "text", text: "root" }],
      createdAt: "2026-07-20T00:00:00.000Z",
    });
    const abandoned = manager.appendMessage({
      id: `${value.name}-abandoned`,
      role: "user",
      content: [{ type: "text", text: "abandoned" }],
      createdAt: "2026-07-20T00:00:01.000Z",
    });
    const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
    await session.setModel({
      provider: provider.id,
      api: "openai-chat-completions",
      id: "one",
      info: branchSummaryModel(provider.models[0]!),
    });
    const leafBeforeNavigation = manager.getLeafId();

    await assert.rejects(session.navigateTree(target, { summarize: true }), value.error);
    assert.notEqual(leafBeforeNavigation, abandoned);
    assert.equal(manager.getLeafId(), leafBeforeNavigation);
    assert.equal(manager.getEntries().some((entry) => entry.type === "branch_summary"), false);
    await session.close();
  }
});
