import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@rigyn/models";
import { ASSISTANT_CONTENT_LIMITS } from "@rigyn/kernel/runtime/core/assistant-content-limits";
import { parseSessionV4Bytes, sessionV4JsonHash } from "@rigyn/kernel/session-v4";

import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import type { EventEnvelope, RuntimeEvent } from "../../src/core/events.js";
import {
  RuntimeObservability,
  type ObservabilityRecord,
  type ObservabilitySink,
} from "../../src/core/observability.js";
import type {
  AdapterEvent,
  ModelInfo,
  ModelProtocolFamily,
  PromptCompositionMetadata,
  ProviderAdapter,
  ProviderRequest,
  ProviderState,
} from "../../src/core/types.js";
import { DefaultResourceLoader, type ResourceLoader } from "../../src/core/resource-loader.js";
import { promptCompositionSource } from "../../src/core/prompt-composition.js";
import { InMemorySettingsStorage, SettingsManager } from "../../src/core/settings-manager.js";
import {
  getExtensionRuntimeHost,
  projectLoadedExtensionHost,
  type ExtensionRunner,
} from "../../src/extensions/compat.js";
import type {
  CompactionPreparation,
  ExtensionAPI,
  ToolExecutionEndEvent,
  ToolExecutionUpdateEvent,
} from "../../src/extensions/direct.js";
import {
  extensionModelRegistry,
  type ExtensionModelRegistry,
  type ExtensionProviderConfig,
} from "../../src/extensions/model-boundary.js";
import {
  loadDirectExtensions,
  type RuntimeExtensionListenerContext,
} from "../../src/extensions/runtime.js";
import { extensionUsage } from "../../src/extensions/session-contract.js";
import {
  providerAdapterFromModels,
  providerModelFromInfo,
} from "../../src/providers/internal-runtime-bridge.js";
import { OpenAICodexResponsesAdapter } from "../../src/providers/openai-codex-responses.js";
import { OpenAICompatibleAdapter } from "../../src/providers/openai-compatible.js";
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
import type { BashOperations } from "../../src/tools/builtins/shell.js";
import type { HarnessTool } from "../../src/tools/types.js";
import { DEFAULT_TUI_LIMITS, TuiController } from "../../src/tui/controller.js";
import { TuiModel } from "../../src/tui/model.js";
import { byteChunks, fakeFetch, streamResponse } from "../providers/helpers.js";
import { FakeInput, FakeOutput } from "../tui/helpers.js";
import { FocusedVirtualTerminal } from "../tui/virtual-terminal.js";

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
    const counters = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    queueMicrotask(() => {
      const usage = {
        ...counters,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text }],
        api: selected.api,
        provider: providerId,
        model: modelId,
        stopReason: "stop",
        timestamp: Date.now(),
        usage,
      };
      const partial = { ...message, content: [] };
      stream.push({ type: "start", partial });
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

class RecordingObservabilitySink implements ObservabilitySink {
  readonly records: ObservabilityRecord[] = [];
  record(record: ObservabilityRecord): void { this.records.push(record); }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

function observeCorrelationAlias(
  observability: RuntimeObservability,
  sink: RecordingObservabilitySink,
  runId: string,
  sequence: number,
): string | undefined {
  observability.observe({
    schemaVersion: 1,
    eventId: `correlation-probe-${sequence}`,
    threadId: "correlation-probe-session",
    runId,
    sequence,
    timestamp: "2026-07-20T00:00:00.000Z",
    event: {
      type: "model_selected",
      provider: "correlation-probe",
      model: "correlation-probe",
    },
  });
  return sink.records.findLast((record) => record.name === "model_selected")?.correlation?.run;
}

class ContinuationProvider implements ProviderAdapter {
  readonly id = "continuation-fixture";
  readonly requests: ProviderRequest[] = [];
  readonly models = [
    model(this.id, "one", "openai-responses"),
  ];

  async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(request));
    const requestNumber = this.requests.length;
    yield { type: "response_start", model: request.model };
    yield { type: "text_delta", part: 0, text: `answer-${requestNumber}` };
    yield {
      type: "usage",
      semantics: "final",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
    };
    yield {
      type: "response_end",
      reason: "stop",
      state: {
        kind: "openai_responses",
        previousResponseId: `response-${requestNumber}`,
        outputItems: [{ type: "message", id: `item-${requestNumber}` }],
      },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models;
  }
}

class ProviderStateProvider extends RecordingProvider {
  readonly #state: ProviderState;
  readonly #text: string;

  constructor(state: ProviderState, text = "answer") {
    super();
    this.#state = state;
    this.#text = text;
  }

  override async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(request));
    yield { type: "response_start", model: request.model };
    yield { type: "text_delta", part: 0, text: this.#text };
    yield {
      type: "response_end",
      reason: "stop",
      state: structuredClone(this.#state),
    };
  }
}

class LifecycleOrderProvider extends RecordingProvider {
  readonly #trace: string[];

  constructor(trace: string[]) {
    super();
    this.#trace = trace;
  }

  override async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(request));
    this.#trace.push("provider_headers");
    this.#trace.push("provider_request");
    this.#trace.push("provider_response");
    yield { type: "response_start", model: request.model };
    yield { type: "text_delta", part: 0, text: "ordered-answer" };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { ordered: true } },
    };
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

function hangingProviderEvents(values: readonly AdapterEvent[]): AsyncIterable<AdapterEvent> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next(): Promise<IteratorResult<AdapterEvent>> {
          const value = values[index];
          index += 1;
          return value === undefined
            ? new Promise<IteratorResult<AdapterEvent>>(() => {})
            : Promise.resolve({ done: false, value });
        },
      };
    },
  };
}

class BranchSummaryTimeoutProvider extends RecordingProvider {
  readonly signals: AbortSignal[] = [];
  readonly #firstEvents: readonly AdapterEvent[];

  constructor(firstEvents: readonly AdapterEvent[] = []) {
    super();
    this.#firstEvents = firstEvents;
  }

  override stream(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(request));
    this.signals.push(signal ?? new AbortController().signal);
    if (this.requests.length === 1) return hangingProviderEvents(this.#firstEvents);
    return (async function* () {
      yield { type: "response_start", model: request.model } as const;
      yield { type: "text_delta", part: 0, text: "recovered branch summary" } as const;
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: {} },
      } as const;
    })();
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
  readonly #visibility: "summary" | "provider_trace";

  constructor(visibility: "summary" | "provider_trace" = "provider_trace") {
    super();
    this.#visibility = visibility;
  }

  override async *stream(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<AdapterEvent> {
    const activeSignal = signal ?? new AbortController().signal;
    this.requests.push(structuredClone(request));
    yield { type: "response_start", model: request.model };
    yield { type: "reasoning_start", part: 0, visibility: this.#visibility };
    yield { type: "reasoning_delta", part: 0, text: "working", visibility: this.#visibility };
    yield {
      type: "reasoning_end",
      part: 0,
      text: "working",
      visibility: this.#visibility,
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

class TinyChunkToolArgumentProvider extends RecordingProvider {
  readonly fragments: number;
  readonly chunks: readonly string[];

  constructor(fragments: number | readonly string[]) {
    super();
    this.fragments = typeof fragments === "number" ? fragments : fragments.length;
    this.chunks = typeof fragments === "number"
      ? Array.from({ length: fragments }, () => "x".repeat(64))
      : [...fragments];
  }

  override async *stream(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<AdapterEvent> {
    const activeSignal = signal ?? new AbortController().signal;
    this.requests.push(structuredClone(request));
    yield { type: "response_start", model: request.model };
    yield { type: "tool_call_start", index: 0, id: "tiny-write", name: "write" };
    for (const chunk of this.chunks) {
      yield { type: "tool_call_delta", index: 0, jsonFragment: chunk };
    }
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

class ToolThenCompactionProvider extends RecordingProvider {
  override async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(request));
    yield { type: "response_start", model: request.model };
    if (this.requests.length === 1) {
      yield { type: "tool_call_start", index: 0, id: "dynamic-budget-ls", name: "ls" };
      yield {
        type: "tool_call_end",
        index: 0,
        id: "dynamic-budget-ls",
        name: "ls",
        rawArguments: "{}",
        arguments: {},
      };
      yield {
        type: "response_end",
        reason: "tool_calls",
        state: { kind: "chat_completions", assistantMessage: { request: this.requests.length } },
      };
      return;
    }
    yield {
      type: "text_delta",
      part: 0,
      text: request.cacheRetention === "none" ? "dynamic budget checkpoint" : "dynamic budget complete",
    };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { request: this.requests.length } },
    };
  }
}

class PrepareNextTurnProvider extends RecordingProvider {
  readonly #toolTurns: number;

  constructor(toolTurns: number) {
    super();
    this.#toolTurns = toolTurns;
  }

  override async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(request));
    yield { type: "response_start", model: request.model };
    if (this.requests.length <= this.#toolTurns) {
      const callId = `prepare-next-turn-${this.requests.length}`;
      yield { type: "tool_call_start", index: 0, id: callId, name: "ls" };
      yield {
        type: "tool_call_end",
        index: 0,
        id: callId,
        name: "ls",
        rawArguments: "{}",
        arguments: {},
      };
      yield {
        type: "response_end",
        reason: "tool_calls",
        state: { kind: "chat_completions", assistantMessage: { request: this.requests.length } },
      };
      return;
    }
    yield { type: "text_delta", part: 0, text: `answer-${request.model}` };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { request: this.requests.length } },
    };
  }
}

function seedDynamicTriggerHistory(
  manager: SessionManager,
  provider: RecordingProvider,
  textLength = 10_000,
): void {
  for (let turn = 0; turn < 6; turn += 1) {
    manager.appendMessage({
      id: `dynamic-trigger-user-${turn}`,
      role: "user",
      content: [{ type: "text", text: `question ${turn} ${"u".repeat(textLength)}` }],
      createdAt: `2026-07-20T00:00:${String(turn * 2).padStart(2, "0")}.000Z`,
    });
    manager.appendMessage({
      id: `dynamic-trigger-assistant-${turn}`,
      role: "assistant",
      content: [{ type: "text", text: `answer ${turn} ${"a".repeat(textLength)}` }],
      createdAt: `2026-07-20T00:00:${String(turn * 2 + 1).padStart(2, "0")}.000Z`,
      provider: provider.id,
      api: "openai-chat-completions",
      model: "one",
      stopReason: "stop",
    });
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
  observability?: RuntimeObservability,
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
    ...(observability === undefined ? {} : { observability }),
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
  toolDefinitionFingerprint = "seed-fixture",
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
      toolDefinitionFingerprint,
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

test("AgentSession isolates application event-listener failures from durable run outcomes", async (context) => {
  await context.test("raw envelope listener", async (testContext) => {
    const cwd = await workspace();
    const provider = new RecordingProvider();
    const manager = SessionManager.inMemory(cwd, { id: "raw-listener-isolation" });
    const sink = new RecordingObservabilitySink();
    const observability = new RuntimeObservability(sink, {
      mode: "sdk",
      processInstance: "0123456789abcdef",
      snapshotIntervalMs: 60_000,
      closeSink: false,
    });
    testContext.after(async () => await observability.close());
    const session = await AgentSession.create({
      ...sessionOptions(manager, new ProviderRegistry([provider])),
      observability,
    });
    testContext.after(async () => await session.close());
    await session.setModel({
      provider: provider.id,
      api: "openai-chat-completions",
      id: "one",
      info: provider.models[0]!,
    });
    const laterEnvelopes: EventEnvelope[] = [];
    const publicEvents: AgentSessionEvent[] = [];
    const removedDuringDelivery: RuntimeEvent["type"][] = [];
    const addedDuringDelivery: RuntimeEvent["type"][] = [];
    let removeDuringDelivery = (): void => undefined;
    let mutatedListeners = false;
    session.onEvent((envelope) => {
      if (mutatedListeners || envelope.event.type !== "run_started") return;
      mutatedListeners = true;
      removeDuringDelivery();
      session.onEvent((later) => { addedDuringDelivery.push(later.event.type); });
    });
    removeDuringDelivery = session.onEvent((envelope) => {
      removedDuringDelivery.push(envelope.event.type);
    });
    session.onEvent((envelope) => {
      if (envelope.event.type === "run_completed") throw new Error("raw listener failed");
    });
    session.onEvent((envelope) => { laterEnvelopes.push(envelope); });
    session.subscribe((event) => { publicEvents.push(event); });

    const result = await session.prompt("complete despite the raw listener", { allowedTools: [] });

    assert.equal(result.results.at(-1)?.finishReason, "stop");
    const operation = [...manager.getV4State().operations.values()].at(-1);
    assert.equal(operation?.status, "completed");
    assert.deepEqual(
      laterEnvelopes.filter((envelope) =>
        envelope.event.type === "run_completed" ||
        envelope.event.type === "run_failed" ||
        envelope.event.type === "run_cancelled")
        .map((envelope) => ({ type: envelope.event.type, runId: envelope.runId })),
      [{ type: "run_completed", runId: operation?.id }],
    );
    assert.equal(publicEvents.filter((event) => event.type === "agent_end").length, 1);
    assert.equal(publicEvents.filter((event) => event.type === "agent_settled").length, 1);
    assert.deepEqual(removedDuringDelivery, ["run_started"]);
    assert.equal(addedDuringDelivery.includes("run_started"), false);
    assert.equal(addedDuringDelivery.length > 0, true);
    observability.snapshot();
    const snapshot = sink.records.findLast((record) => record.kind === "metrics_snapshot");
    assert.equal(snapshot?.fields.runs_started, 1);
    assert.equal(snapshot?.fields.runs_completed, 1);
    assert.equal(snapshot?.fields.runs_failed, 0);
    assert.equal(snapshot?.fields.runs_cancelled, 0);
    assert.deepEqual(
      sink.records.filter((record) => record.name === "event_listener_failed")
        .map((record) => record.fields.event_type),
      ["run_completed"],
    );
  });

  await context.test("public session listener", async (testContext) => {
    const cwd = await workspace();
    const provider = new RecordingProvider();
    const manager = SessionManager.inMemory(cwd, { id: "public-listener-isolation" });
    const sink = new RecordingObservabilitySink();
    const observability = new RuntimeObservability(sink, {
      mode: "sdk",
      processInstance: "0123456789abcdef",
      snapshotIntervalMs: 60_000,
      closeSink: false,
    });
    testContext.after(async () => await observability.close());
    const session = await AgentSession.create({
      ...sessionOptions(manager, new ProviderRegistry([provider])),
      observability,
    });
    testContext.after(async () => await session.close());
    await session.setModel({
      provider: provider.id,
      api: "openai-chat-completions",
      id: "one",
      info: provider.models[0]!,
    });
    const envelopes: EventEnvelope[] = [];
    const laterEvents: AgentSessionEvent[] = [];
    session.onEvent((envelope) => { envelopes.push(envelope); });
    const removedDuringDelivery: AgentSessionEvent["type"][] = [];
    const addedDuringDelivery: AgentSessionEvent["type"][] = [];
    let removeDuringDelivery = (): void => undefined;
    let mutatedListeners = false;
    session.subscribe((event) => {
      if (mutatedListeners || event.type !== "agent_start") return;
      mutatedListeners = true;
      removeDuringDelivery();
      session.subscribe((later) => { addedDuringDelivery.push(later.type); });
    });
    removeDuringDelivery = session.subscribe((event) => {
      removedDuringDelivery.push(event.type);
    });
    session.subscribe((event) => {
      if (event.type === "agent_start") throw new Error("public listener failed");
    });
    session.subscribe((event) => { laterEvents.push(event); });

    const result = await session.prompt("complete despite the public listener", { allowedTools: [] });

    assert.equal(result.results.at(-1)?.finishReason, "stop");
    const operation = [...manager.getV4State().operations.values()].at(-1);
    assert.equal(operation?.status, "completed");
    assert.deepEqual(
      envelopes.filter((envelope) =>
        envelope.event.type === "run_completed" ||
        envelope.event.type === "run_failed" ||
        envelope.event.type === "run_cancelled")
        .map((envelope) => ({ type: envelope.event.type, runId: envelope.runId })),
      [{ type: "run_completed", runId: operation?.id }],
    );
    const publicOrder = laterEvents.map((event) => event.type);
    const messageEnd = publicOrder.indexOf("message_end");
    const turnEnd = publicOrder.indexOf("turn_end");
    const agentEnd = publicOrder.indexOf("agent_end");
    const settled = publicOrder.indexOf("agent_settled");
    assert.equal(publicOrder[0], "agent_start");
    assert.ok(messageEnd >= 0 && messageEnd < turnEnd && turnEnd < agentEnd && agentEnd < settled);
    assert.equal(publicOrder.filter((type) => type === "message_end").length, 2);
    assert.equal(publicOrder.filter((type) => type === "agent_end").length, 1);
    assert.equal(publicOrder.filter((type) => type === "agent_settled").length, 1);
    assert.deepEqual(removedDuringDelivery, ["agent_start"]);
    assert.equal(addedDuringDelivery.includes("agent_start"), false);
    assert.equal(addedDuringDelivery.length > 0, true);
    observability.snapshot();
    const snapshot = sink.records.findLast((record) => record.kind === "metrics_snapshot");
    assert.equal(snapshot?.fields.runs_started, 1);
    assert.equal(snapshot?.fields.runs_completed, 1);
    assert.equal(snapshot?.fields.runs_failed, 0);
    assert.equal(snapshot?.fields.runs_cancelled, 0);
    assert.deepEqual(
      sink.records.filter((record) => record.name === "event_listener_failed")
        .map((record) => record.fields.event_type),
      ["agent_start"],
    );
  });
});

test("AgentSession retry.maxRetries stays independent from provider maxRetries", async () => {
  const cwd = await workspace();
  const provider = new RetryThenSuccessProvider(3);
  const settings = SettingsManager.inMemory({
    retry: {
      maxRetries: 3,
      baseDelayMs: 0,
      provider: { maxRetries: 0, maxRetryDelayMs: 0 },
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

  assert.equal(provider.requests.length, 4);
  assert.equal(provider.requests.every((request) => request.maxRetries === 0), true);
  assert.equal(result.results.at(-1)?.finalText, "recovered");
  await session.close();
});

test("AgentSession applies provider timeout and retry settings to every provider request", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd),
    providers: new ProviderRegistry([provider]),
    settingsManager: SettingsManager.inMemory({
      retry: { provider: { timeoutMs: 12_345, maxRetries: 4, maxRetryDelayMs: 6_789 } },
    }),
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });

  await session.prompt("provider settings", { allowedTools: [] });

  assert.equal(session.agent.timeoutMs, 12_345);
  assert.equal(session.agent.maxRetries, 4);
  assert.equal(session.agent.maxRetryDelayMs, 6_789);
  assert.equal(provider.requests[0]?.timeoutMs, 12_345);
  assert.equal(provider.requests[0]?.maxRetries, 4);
  assert.equal(provider.requests[0]?.maxRetryDelayMs, 6_789);
  await session.close();
});

test("AgentSession forwards each configured cache retention value to provider requests", async () => {
  const cwd = await workspace();
  for (const cacheRetention of ["none", "short", "long"] as const) {
    const provider = new RecordingProvider();
    const session = await AgentSession.create({
      sessionManager: SessionManager.inMemory(cwd),
      providers: new ProviderRegistry([provider]),
      settingsManager: SettingsManager.inMemory(),
      cacheRetention,
    });
    await session.setModel({
      provider: provider.id,
      api: "openai-chat-completions",
      id: "one",
      info: provider.models[0]!,
    });

    await session.prompt("cache retention", { allowedTools: [] });

    assert.equal(provider.requests[0]?.cacheRetention, cacheRetention);
    await session.close();
  }
});

test("AgentSession prompt-level autoCompaction false preserves old tool results", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd);
  const oldOutput = "x".repeat(20_000);
  manager.appendMessage({
    id: "old-tool-user",
    role: "user",
    content: [{ type: "text", text: "inspect the old output" }],
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  manager.appendMessage({
    id: "old-tool-call",
    role: "assistant",
    content: [{ type: "tool_call", callId: "old-call", name: "read", arguments: { path: "old.txt" } }],
    createdAt: "2026-07-20T00:00:01.000Z",
  });
  manager.appendMessage({
    id: "old-tool-result",
    role: "tool",
    content: [{
      type: "tool_result",
      callId: "old-call",
      name: "read",
      content: oldOutput,
      isError: false,
    }],
    createdAt: "2026-07-20T00:00:02.000Z",
  });
  manager.appendMessage({
    id: "recent-user",
    role: "user",
    content: [{ type: "text", text: "recent turn" }],
    createdAt: "2026-07-20T00:00:03.000Z",
  });
  manager.appendMessage({
    id: "recent-assistant",
    role: "assistant",
    content: [{ type: "text", text: "recent answer" }],
    createdAt: "2026-07-20T00:00:04.000Z",
    provider: provider.id,
    api: "openai-chat-completions",
    model: "one",
    stopReason: "stop",
  });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 100_000 },
  });

  await session.prompt("continue", { allowedTools: [], autoCompaction: false });

  const result = provider.requests[0]?.messages.flatMap((message) => message.content).find(
    (block) => block.type === "tool_result" && block.callId === "old-call",
  );
  assert.equal(result?.type === "tool_result" ? result.content : undefined, oldOutput);
  await session.close();
});

test("AgentSession refresh updates settings-owned agent options and preserves caller overrides", async () => {
  const cwd = await workspace();
  const storage = new InMemorySettingsStorage();
  const replaceSettings = (settings: object): void => {
    storage.withLock("global", () => JSON.stringify(settings));
  };
  replaceSettings({
    transport: "auto",
    thinkingBudgets: { high: 1_000, xhigh: 2_000, max: 3_000 },
    retry: { provider: { timeoutMs: 100, maxRetries: 1, maxRetryDelayMs: 200 } },
  });
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd),
    providers: new ProviderRegistry([new RecordingProvider()]),
    settingsManager: SettingsManager.fromStorage(storage),
  });

  replaceSettings({
    transport: "websocket",
    thinkingBudgets: { high: 4_000, xhigh: 5_000, max: 6_000 },
    retry: { provider: { timeoutMs: 300, maxRetries: 2, maxRetryDelayMs: 400 } },
  });
  await session.refresh();
  assert.equal(session.agent.transport, "websocket");
  assert.deepEqual(session.agent.thinkingBudgets, { high: 4_000, xhigh: 5_000, max: 6_000 });
  assert.equal(session.agent.timeoutMs, 300);
  assert.equal(session.agent.maxRetries, 2);
  assert.equal(session.agent.maxRetryDelayMs, 400);

  session.agent.transport = "websocket";
  session.agent.thinkingBudgets = { high: 4_000, xhigh: 5_000, max: 6_000 };
  session.agent.timeoutMs = 300;
  session.agent.maxRetries = 2;
  session.agent.maxRetryDelayMs = 400;
  replaceSettings({
    transport: "websocket-cached",
    thinkingBudgets: { high: 10_000 },
    retry: { provider: { timeoutMs: 500, maxRetries: 3, maxRetryDelayMs: 600 } },
  });
  await session.refresh();
  assert.equal(session.agent.transport, "websocket");
  assert.deepEqual(session.agent.thinkingBudgets, { high: 4_000, xhigh: 5_000, max: 6_000 });
  assert.equal(session.agent.timeoutMs, 300);
  assert.equal(session.agent.maxRetries, 2);
  assert.equal(session.agent.maxRetryDelayMs, 400);
  await session.close();
});

test("AgentSession startup rejects invalid on-disk settings", async () => {
  const cwd = await workspace();
  const agentDirectory = join(cwd, "agent-home");
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(join(agentDirectory, "config.json"), JSON.stringify({ tools: "invalid" }));

  await assert.rejects(
    AgentSession.create({
      sessionManager: SessionManager.inMemory(cwd),
      providers: new ProviderRegistry([new RecordingProvider()]),
      agentDirectory,
      projectTrusted: false,
    }),
    /Settings could not be loaded.*settings\.tools must be an object/iu,
  );
});

test("AgentSession startup repeatedly rejects prepared settings errors without refreshing them", async () => {
  const cwd = await workspace();
  let reads = 0;
  const settings = SettingsManager.fromStorage({
    withLock(scope, operation) {
      reads += 1;
      operation(scope === "global" ? JSON.stringify({ tools: "invalid" }) : undefined);
    },
  }, { projectTrusted: false });
  assert.equal(reads, 1);

  const create = async () => await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd),
    providers: new ProviderRegistry([new RecordingProvider()]),
    settingsManager: settings,
  });
  await assert.rejects(create(), /Settings could not be loaded.*settings\.tools must be an object/iu);
  await assert.rejects(create(), /Settings could not be loaded.*settings\.tools must be an object/iu);
  assert.equal(reads, 1);
});

test("AgentSession refresh reports invalid settings and keeps the last valid values", async () => {
  const cwd = await workspace();
  const storage = new InMemorySettingsStorage();
  storage.withLock("global", () => JSON.stringify({ theme: "mono" }));
  const settings = SettingsManager.fromStorage(storage);
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd),
    providers: new ProviderRegistry([new RecordingProvider()]),
    settingsManager: settings,
  });
  storage.withLock("global", () => "{not-json");

  await assert.rejects(session.refresh(), /Settings could not be loaded.*global/iu);

  assert.equal(settings.getTheme(), "mono");
  storage.withLock("global", () => JSON.stringify({
    theme: "candidate",
    retry: { provider: { timeoutMs: "100" } },
  }));
  await assert.rejects(session.refresh(), /Invalid retry\.provider\.timeoutMs setting/iu);
  assert.equal(settings.getTheme(), "mono");
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

test("AgentSession aligns bounded redacted cancellation reasons across V4 and runtime events", async (context) => {
  const cwd = await workspace();
  const provider = new AbortableProvider();
  const manager = SessionManager.inMemory(cwd, { id: "redacted-cancellation" });
  const sink = new RecordingObservabilitySink();
  const observability = new RuntimeObservability(sink, {
    mode: "sdk",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
    closeSink: false,
  });
  context.after(async () => await observability.close());
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    observability,
  });
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });
  const credential = "registered-cancellation-reason-credential";
  defaultSecretRedactor.register(credential);
  const reason = `  cancel ${credential} ${"🌐".repeat(2_100)} tail  `;
  const envelopes: EventEnvelope[] = [];
  let sawUpdate!: () => void;
  const updated = new Promise<void>((resolve) => { sawUpdate = resolve; });
  session.onEvent((envelope) => {
    envelopes.push(envelope);
    if (envelope.event.type === "text_delta") sawUpdate();
  });

  const running = session.prompt("abort without persisting the credential", { allowedTools: [] });
  await updated;
  await session.abort(reason);
  const result = await running;

  assert.equal(result.results.at(-1)?.finishReason, "cancelled");
  const state = manager.getV4State();
  const operation = [...state.operations.values()].at(-1);
  const terminal = envelopes.filter((envelope) => envelope.event.type === "run_cancelled");
  const durableReason = operation?.cancel?.reason;
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.runId, operation?.id);
  assert.equal(operation?.status, "cancelled");
  assert.equal(state.branches.get(state.primaryBranchId)?.openOperationId, null);
  assert.equal(durableReason, terminal[0]?.event.type === "run_cancelled"
    ? terminal[0].event.reason
    : undefined);
  assert.equal(durableReason?.includes(credential), false);
  assert.equal(durableReason?.trim(), durableReason);
  assert.ok(Buffer.byteLength(durableReason ?? "", "utf8") <= 4_096);
  observability.snapshot();
  const snapshot = sink.records.findLast((record) => record.kind === "metrics_snapshot");
  assert.equal(snapshot?.fields.runs_started, 1);
  assert.equal(snapshot?.fields.runs_completed, 0);
  assert.equal(snapshot?.fields.runs_failed, 0);
  assert.equal(snapshot?.fields.runs_cancelled, 1);
  assert.equal(snapshot?.fields.active_runs, 0);
  await session.close();
});

test("session.agent waits for asynchronous subscribers and shares the active cancellation signal", async (context) => {
  const cwd = await workspace();
  const provider = new AbortableProvider();
  const session = await AgentSession.create(
    sessionOptions(SessionManager.inMemory(cwd, { id: "agent-subscriber-signal" }), new ProviderRegistry([provider])),
  );
  let releaseListener!: () => void;
  const listenerGate = new Promise<void>((resolve) => { releaseListener = resolve; });
  context.after(async () => {
    releaseListener();
    await session.close();
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });
  const agent = session.agent;
  let activeSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let markListenerEntered!: () => void;
  const listenerEntered = new Promise<void>((resolve) => { markListenerEntered = resolve; });
  agent.subscribe(async (event, signal) => {
    if (event.type === "agent_start") {
      activeSignal = signal;
      markStarted();
    }
    if (event.type === "agent_end") {
      markListenerEntered();
      await listenerGate;
    }
  });

  let promptSettled = false;
  const running = agent.prompt("wait").then(() => { promptSettled = true; });
  await started;
  assert.equal(activeSignal?.aborted, false);
  await agent.abort("cancel subscriber test");
  await listenerEntered;
  assert.equal(activeSignal?.aborted, true);
  let idleSettled = false;
  const idle = agent.waitForIdle().then(() => { idleSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(promptSettled, false);
  assert.equal(idleSettled, false);

  releaseListener();
  await Promise.all([running, idle]);
  assert.equal(promptSettled, true);
  assert.equal(idleSettled, true);
});

test("AgentSession streaming snapshots expose exact text, reasoning, and tool-call lifecycle with signatures", async () => {
  const cwd = await workspace();
  const provider = new AbortableStructuredStreamProvider("summary");
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

test("tool-call deltas retain cumulative snapshots across mid-stream listener activation", async (context) => {
  const cwd = await workspace();
  const chunks = ['{"path":"fir', 'st.txt"}'];
  const provider = new TinyChunkToolArgumentProvider(chunks);
  const manager = SessionManager.inMemory(cwd, { id: "direct-structured-stream-state" });
  const directDeltas: string[] = [];
  let resolveCompleted!: () => void;
  const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "stream-snapshot-probe",
      factory(api) {
        api.on("message_update", (event) => {
          if (event.assistantMessageEvent.type === "toolcall_delta") {
            directDeltas.push(event.assistantMessageEvent.delta);
          }
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const cumulativeRawArguments: string[] = [];
  const dispatch = host.dispatch.bind(host);
  (host as unknown as {
    dispatch(event: string, value: unknown, signal?: AbortSignal): Promise<void>;
  }).dispatch = async (event, value, signal) => {
    const update = value as {
      assistantMessageEvent?: { type?: unknown };
      message?: { content?: Array<{ type?: unknown; rawArguments?: unknown }> };
    };
    if (event === "message_update" && update.assistantMessageEvent?.type === "tool_call_delta") {
      const call = update.message?.content?.find((block) => block.type === "tool_call");
      if (typeof call?.rawArguments === "string") cumulativeRawArguments.push(call.rawArguments);
    }
    await dispatch(event as never, value as never, signal);
  };
  let observeDirectUpdates = false;
  const hasListeners = host.hasListeners.bind(host);
  (host as unknown as { hasListeners(event: string): boolean }).hasListeners = (event) =>
    event === "message_update" ? observeDirectUpdates : hasListeners(event as never);
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    extensionRunner: host,
  });
  const publicDeltas: string[] = [];
  const publicMessages: Array<Extract<AgentSessionEvent, { type: "message_update" }>> = [];
  const publicMessageArguments: unknown[] = [];
  const publicPartialArguments: unknown[] = [];
  const publicStateArguments: unknown[] = [];
  const publicSnapshotsSynchronized: boolean[] = [];
  session.subscribe((event) => {
    if (event.type !== "message_update" || event.assistantMessageEvent.type !== "toolcall_delta") return;
    publicDeltas.push(event.assistantMessageEvent.delta);
    publicMessages.push(event);
    const messageCall = event.message.role === "assistant"
      ? event.message.content.find((block) => block.type === "toolCall")
      : undefined;
    const partialCall = event.assistantMessageEvent.partial.content.find((block) => block.type === "toolCall");
    const state = session.state.streamingMessage;
    const stateCall = state?.role === "assistant"
      ? state.content.find((block) => block.type === "toolCall")
      : undefined;
    publicMessageArguments.push(messageCall?.arguments);
    publicPartialArguments.push(partialCall?.arguments);
    publicStateArguments.push(stateCall?.arguments);
    publicSnapshotsSynchronized.push(
      isDeepStrictEqual(event.message, event.assistantMessageEvent.partial)
      && isDeepStrictEqual(event.message, state),
    );
    observeDirectUpdates = true;
    if (publicDeltas.length === provider.fragments) resolveCompleted();
  });
  await session.bindExtensions();
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });

  const running = session.prompt("stream direct structured blocks", { allowedTools: [] });
  await completed;
  await session.abort("direct structured stream test complete");
  await running;
  await session.close();

  assert.deepEqual(directDeltas, [chunks[1]]);
  assert.deepEqual(cumulativeRawArguments, [chunks.join("")]);
  assert.deepEqual(publicDeltas, chunks);
  assert.deepEqual(publicMessageArguments, [{}, {}]);
  assert.deepEqual(publicPartialArguments, [{}, {}]);
  assert.deepEqual(publicStateArguments, [{}, {}]);
  assert.deepEqual(publicSnapshotsSynchronized, [true, true]);
  const retainedFirst = publicMessages[0];
  const retainedFirstCall = retainedFirst?.message.role === "assistant"
    ? retainedFirst.message.content.find((block) => block.type === "toolCall")
    : undefined;
  assert.deepEqual(retainedFirstCall?.arguments, {});
});

test("tiny tool-argument chunks preserve exact no-listener delivery within bounded CPU", async () => {
  const cwd = await workspace();
  const provider = new TinyChunkToolArgumentProvider(8_192);
  const manager = SessionManager.inMemory(cwd, { id: "tiny-tool-argument-stream" });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });
  let envelopeDeltas = 0;
  let publicDeltas = 0;
  let resolveDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => { resolveDelivered = resolve; });
  session.onEvent((envelope) => {
    if (envelope.event.type !== "tool_call_delta") return;
    envelopeDeltas += 1;
    if (envelopeDeltas === provider.fragments) resolveDelivered();
  });
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_delta") {
      publicDeltas += 1;
    }
  });

  const started = process.cpuUsage();
  const running = session.prompt("stream tiny tool arguments", { allowedTools: [] });
  await delivered;
  const usage = process.cpuUsage(started);
  const cpuMs = (usage.user + usage.system) / 1_000;
  assert.equal(envelopeDeltas, provider.fragments);
  assert.equal(publicDeltas, provider.fragments);
  // This regression also runs under V8 coverage on hosted CI, where instrumentation
  // materially increases CPU time. Keep a generous ceiling as a gross superlinear guard.
  const cpuCeilingMs = process.env.NODE_V8_COVERAGE === undefined ? 3_000 : 4_000;
  assert.ok(
    cpuMs < cpuCeilingMs,
    `${provider.fragments} tiny tool fragments occupied JavaScript for ${cpuMs.toFixed(1)} ms (limit ${cpuCeilingMs} ms)`,
  );
  assert.equal(session.state.streamingMessage?.role, "assistant");

  const abortStarted = performance.now();
  await session.abort("tiny tool-argument test complete");
  await running;
  assert.ok(performance.now() - abortStarted < 100, "tiny tool-argument cancellation exceeded 100 ms");
  await session.close();
});

test("prebuffered tiny tool arguments yield to a scheduled abort", async () => {
  const cwd = await workspace();
  const provider = new TinyChunkToolArgumentProvider(131_072);
  const manager = SessionManager.inMemory(cwd, { id: "prebuffered-tool-argument-abort" });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });
  let envelopeDeltas = 0;
  let publicDeltas = 0;
  let resolveToolStarted!: () => void;
  const toolStarted = new Promise<void>((resolve) => { resolveToolStarted = resolve; });
  session.onEvent((envelope) => {
    if (envelope.event.type === "tool_call_started") resolveToolStarted();
    if (envelope.event.type === "tool_call_delta") envelopeDeltas += 1;
  });
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_delta") {
      publicDeltas += 1;
    }
  });

  const running = session.prompt("stream a prebuffered tool call", { allowedTools: [] });
  await toolStarted;
  const deltasBeforeImmediate = envelopeDeltas;
  const scheduledAt = performance.now();
  const timing = await new Promise<{ callbackMs: number; abortMs: number }>((resolve, reject) => {
    setImmediate(() => {
      const callbackMs = performance.now() - scheduledAt;
      const abortStarted = performance.now();
      void session.abort("prebuffered tool-argument test complete").then(
        () => resolve({ callbackMs, abortMs: performance.now() - abortStarted }),
        reject,
      );
    });
  });
  await running;

  assert.ok(
    envelopeDeltas - deltasBeforeImmediate <= 32,
    `scheduled abort waited behind ${envelopeDeltas - deltasBeforeImmediate} provider events`,
  );
  assert.equal(publicDeltas, envelopeDeltas);
  assert.ok(timing.callbackMs < 250, `scheduled abort callback waited ${timing.callbackMs.toFixed(1)} ms`);
  assert.ok(timing.abortMs < 250, `scheduled abort settled in ${timing.abortMs.toFixed(1)} ms`);
  await session.close();
});

test("AgentSession public streaming events omit provider-private reasoning", async () => {
  const cwd = await workspace();
  const provider = new AbortableStructuredStreamProvider();
  const manager = SessionManager.inMemory(cwd, { id: "private-structured-stream-state" });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });
  const updates: Array<Extract<AgentSessionEvent, { type: "message_update" }>> = [];
  let sawCompletedToolCall!: () => void;
  const completedToolCall = new Promise<void>((resolve) => { sawCompletedToolCall = resolve; });
  session.subscribe((event) => {
    if (event.type !== "message_update") return;
    updates.push(structuredClone(event));
    if (event.assistantMessageEvent.type === "toolcall_end") sawCompletedToolCall();
  });

  const running = session.prompt("stream private reasoning", { allowedTools: [] });
  await completedToolCall;

  assert.deepEqual(updates.map((event) => event.assistantMessageEvent.type), [
    "text_start",
    "text_delta",
    "text_end",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
  ]);
  assert.equal(updates.some((event) =>
    event.message.role === "assistant"
    && event.message.content.some((block) => block.type === "thinking")), false);
  await session.abort("private structured stream test complete");
  await running;
  await session.close();
});

test("textual provider reasoning reaches the public session and terminal projection", async () => {
  const cwd = await workspace();
  const response = `data: ${JSON.stringify({
    id: "deepseek-visible-reasoning",
    model: "deepseek-v4-pro",
    choices: [{
      index: 0,
      delta: { reasoning_content: "Inspecting the request.", content: "Answer complete." },
      finish_reason: "stop",
    }],
  })}\n\ndata: [DONE]\n\n`;
  const provider = new OpenAICompatibleAdapter({
    id: "deepseek",
    baseUrl: "https://api.deepseek.example/v1",
    fetch: fakeFetch(() => streamResponse(byteChunks(response))),
  });
  const manager = SessionManager.inMemory(cwd, { id: "visible-provider-reasoning" });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  const selected = model("deepseek", "deepseek-v4-pro", "openai-chat-completions");
  await session.setModel({
    provider: "deepseek",
    api: "openai-chat-completions",
    id: "deepseek-v4-pro",
    info: selected,
  });
  const envelopes: EventEnvelope[] = [];
  const updates: Array<Extract<AgentSessionEvent, { type: "message_update" }>> = [];
  session.onEvent((envelope) => { envelopes.push(structuredClone(envelope)); });
  session.subscribe((event) => {
    if (event.type === "message_update") updates.push(structuredClone(event));
  });

  await session.prompt("Explain the request", { allowedTools: [] });

  const thinkingUpdates = updates.filter((event) =>
    event.assistantMessageEvent.type === "thinking_delta");
  assert.deepEqual(thinkingUpdates.map((event) =>
    event.assistantMessageEvent.type === "thinking_delta"
      ? event.assistantMessageEvent.delta
      : ""), ["Inspecting the request."]);
  const tui = new TuiModel(DEFAULT_TUI_LIMITS);
  tui.applyAll(envelopes);
  assert.deepEqual(
    tui.entries.filter((entry) => entry.kind === "reasoning").map((entry) => entry.text),
    ["Inspecting the request."],
  );
  assert.deepEqual(
    tui.entries.filter((entry) => entry.kind === "assistant").map((entry) => entry.text),
    ["Answer complete."],
  );
  const assistant = manager.getEntries().findLast((entry) =>
    entry.type === "message" && "content" in entry.message && entry.message.role === "assistant");
  assert.deepEqual(
    assistant?.type === "message" && "content" in assistant.message
      ? assistant.message.content
      : undefined,
    [
      { type: "thinking", thinking: "Inspecting the request.", visibility: "summary" },
      { type: "text", text: "Answer complete." },
    ],
  );
  await session.close();
});

test("Codex SSE write arguments update one TUI card before the write executes", async () => {
  const cwd = await workspace();
  const target = join(cwd, "live-write.txt");
  const rawArguments = JSON.stringify({
    path: "live-write.txt",
    content: "first line\nsecond line",
  });
  const toolItem = {
    type: "function_call",
    id: "write-item",
    call_id: "write-live",
    name: "write",
    arguments: rawArguments,
  };
  const firstResponse = [
    { type: "response.created", response: { id: "write-response", model: "gpt-5.6-luna" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...toolItem, arguments: "" },
    },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "write-item", delta: "{\"path\":\"live-write.txt\",\"content\":\"first" },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "write-item", delta: " line\\nsecond" },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: "write-item", delta: " line\"}" },
    { type: "response.function_call_arguments.done", output_index: 0, item_id: "write-item", arguments: rawArguments },
    { type: "response.output_item.done", output_index: 0, item: toolItem },
    {
      type: "response.completed",
      response: {
        id: "write-response",
        model: "gpt-5.6-luna",
        output: [toolItem],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ];
  const finalResponse = [
    { type: "response.created", response: { id: "final-response", model: "gpt-5.6-luna" } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "done" },
    {
      type: "response.completed",
      response: {
        id: "final-response",
        model: "gpt-5.6-luna",
        output: [],
        usage: { input_tokens: 12, output_tokens: 1, total_tokens: 13 },
      },
    },
  ];
  let requests = 0;
  const provider = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "sse",
    fetch: fakeFetch(() => {
      requests += 1;
      const events = requests === 1 ? firstResponse : finalResponse;
      const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      return streamResponse(byteChunks(body));
    }),
  });
  const manager = SessionManager.inMemory(cwd, { id: "codex-live-write" });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  const selected = model("openai-codex", "gpt-5.6-luna", "openai-responses");
  await session.setModel({
    provider: "openai-codex",
    api: "openai-responses",
    id: "gpt-5.6-luna",
    info: selected,
  });
  const tui = new TuiModel(DEFAULT_TUI_LIMITS);
  const terminalOutput = new FakeOutput();
  const terminal = new TuiController({
    input: new FakeInput(),
    output: terminalOutput,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
    handleSignals: false,
  });
  terminal.start();
  const renderedTerminal = new FocusedVirtualTerminal(terminalOutput.columns, terminalOutput.rows);
  let renderedChunks = 0;
  const terminalFrame = (): string => {
    for (const chunk of terminalOutput.chunks.slice(renderedChunks)) renderedTerminal.write(chunk.toString("utf8"));
    renderedChunks = terminalOutput.chunks.length;
    return renderedTerminal.viewport().join("\n");
  };
  terminalFrame();
  const livePreviews: string[] = [];
  const liveFrames: string[] = [];
  const liveEntryIds: string[] = [];
  let executionStarted = false;
  session.onEvent((envelope) => {
    terminal.render(envelope);
    tui.apply(envelope);
    if (envelope.event.type === "tool_started") executionStarted = true;
    if (envelope.event.type !== "tool_call_delta") return;
    assert.equal(executionStarted, false);
    const entries = tui.entries.filter((entry) => entry.kind === "tool");
    assert.equal(entries.length, 1);
    liveEntryIds.push(entries[0]!.id);
    livePreviews.push(entries[0]!.inputPreview ?? "");
    terminal.renderNow();
    liveFrames.push(terminalFrame());
  });

  await session.prompt("write the fixture", { allowedTools: ["write"] });
  terminal.close();

  assert.equal(requests, 2);
  assert.equal(new Set(liveEntryIds).size, 1);
  assert.equal(livePreviews.length, 3);
  assert.match(livePreviews[0]!, /first$/u);
  assert.match(livePreviews[1]!, /first line\n\+ second$/u);
  assert.match(livePreviews[2]!, /first line\n\+ second line$/u);
  assert.match(liveFrames[0]!, /write live-write\.txt .* queued[\s\S]*first/u);
  assert.match(liveFrames[1]!, /write live-write\.txt .* queued[\s\S]*first line[\s\S]*second/u);
  assert.match(liveFrames[2]!, /write live-write\.txt .* queued[\s\S]*first line[\s\S]*second line/u);
  assert.equal(await readFile(target, "utf8"), "first line\nsecond line");
  const toolEntries = tui.entries.filter((entry) => entry.kind === "tool");
  assert.equal(toolEntries.length, 1);
  assert.equal(toolEntries[0]?.callId, "write-live");
  assert.equal(toolEntries[0]?.status, "completed");
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
  const publicManager = session.sessionManager;
  assert.equal(session.sessionManager, publicManager);
  assert.notEqual(publicManager, manager);
  assert.equal(session.nativeSessionManager, manager);
  publicManager.appendSessionInfo("mutable-manager");
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

test("public queue clearing and agent reset cancel every durable queued message", async () => {
  const cwd = await workspace();
  const manager = SessionManager.inMemory(cwd, { id: "durable-clear-all" });
  const session = await AgentSession.create(sessionOptions(
    manager,
    new ProviderRegistry([new RecordingProvider()]),
  ));
  const queued = () => [...manager.getV4State().queue.values()].filter((entry) => entry.status === "queued");

  session.steer("ordinary queue");
  await session.sendCustomMessage({
    customType: "deferred",
    content: "next run queue",
    display: false,
    details: undefined,
  }, { deliverAs: "nextTurn" });
  assert.equal(queued().length, 2);

  session.agent.clearAllQueues();
  assert.equal(queued().length, 0);
  assert.equal(session.pendingMessageCount, 0);

  session.followUp("reset queue");
  await session.sendCustomMessage({
    customType: "deferred",
    content: "reset next run queue",
    display: false,
    details: undefined,
  }, { deliverAs: "nextTurn" });
  assert.equal(queued().length, 2);

  session.agent.reset();
  assert.equal(queued().length, 0);
  assert.equal(session.pendingMessageCount, 0);
  assert.equal([...manager.getV4State().queue.values()].every((entry) => entry.status === "cancelled"), true);
  await session.close();
});

test("failed session replacements preserve live queued messages", async () => {
  const cwd = await workspace();
  const manager = SessionManager.inMemory(cwd, { id: "replacement-source" });
  const session = await AgentSession.create(sessionOptions(
    manager,
    new ProviderRegistry([new RecordingProvider()]),
  ));
  session.steer("keep steer");
  session.followUp("keep follow-up");

  const originalNewSession = manager.newSession;
  manager.newSession = (() => { throw new Error("injected new-session failure"); }) as typeof manager.newSession;
  assert.throws(() => session.newSession(), /injected new-session failure/u);
  manager.newSession = originalNewSession;
  assert.deepEqual(session.getSteeringMessages(), ["keep steer"]);
  assert.deepEqual(session.getFollowUpMessages(), ["keep follow-up"]);

  const candidate = SessionManager.create(cwd, join(cwd, "sessions"), { id: "replacement-candidate" });
  const candidatePath = candidate.getSessionFile();
  candidate.closeV4Store();
  assert.notEqual(candidatePath, undefined);
  const originalSetSessionFile = manager.setSessionFile;
  manager.setSessionFile = (() => { throw new Error("injected switch failure"); }) as typeof manager.setSessionFile;
  assert.throws(() => session.switchSessionFile(candidatePath!), /injected switch failure/u);
  manager.setSessionFile = originalSetSessionFile;
  assert.deepEqual(session.getSteeringMessages(), ["keep steer"]);
  assert.deepEqual(session.getFollowUpMessages(), ["keep follow-up"]);
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
  assert.equal(resumed.model?.api, "openai-completions");
  assert.equal(resumed.model?.id, "one");
  assert.equal(resumed.nativeModel?.api, "openai-chat-completions");
  await resumed.prompt("second", { allowedTools: [] });
  assert.equal(provider.requests[1]?.providerState?.kind, "chat_completions");
  await resumed.close();
});

test("AgentSession keeps durable provider selections exact when credentials overlap structural IDs", async () => {
  const cwd = await workspace();
  const credential = "durable-selection-overlap-credential";
  const providerId = `provider-${credential}`;
  const modelId = `model-${credential}`;
  defaultSecretRedactor.register(credential);
  const info = model(providerId, modelId, "openai-chat-completions");
  const provider: ProviderAdapter = {
    id: providerId,
    async *stream(request) {
      yield { type: "response_start", model: request.model };
      yield { type: "text_delta", part: 0, text: "complete" };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: { complete: true } },
      };
    },
    async listModels() { return [info]; },
  };
  const manager = SessionManager.inMemory(cwd, { id: "durable-selection-redaction" });
  const session = await AgentSession.create(sessionOptions(
    manager,
    new ProviderRegistry([provider]),
  ));
  await session.setModel({
    provider: providerId,
    api: "openai-chat-completions",
    id: modelId,
    info,
  });
  const observed: Array<Extract<RuntimeEvent, { type: "provider_attempt_started" }>> = [];
  const observedMessages: Array<Extract<RuntimeEvent, { type: "message_appended" }>> = [];
  session.onEvent((envelope) => {
    if (envelope.event.type === "provider_attempt_started") observed.push(envelope.event);
    if (envelope.event.type === "message_appended" && envelope.event.message.role === "assistant") {
      observedMessages.push(envelope.event);
    }
  });

  const result = await session.prompt("preserve the selection", { allowedTools: [] });

  assert.equal(result.results.at(-1)?.finalText, "complete");
  const operation = [...manager.getV4State().operations.values()].at(-1);
  assert.ok(operation);
  assert.equal(operation.selection.provider, providerId);
  assert.equal(operation.selection.model, modelId);
  assert.deepEqual(operation.stepSelections[0]?.selection, operation.selection);
  const assistant = manager.getBranch().findLast((entry) =>
    entry.type === "message" && entry.message.role === "assistant");
  assert.equal(assistant?.type, "message");
  if (assistant?.type !== "message" || assistant.message.role !== "assistant") {
    throw new Error("missing durable assistant message");
  }
  assert.equal(assistant.message.provider, providerId);
  assert.equal(assistant.message.model, modelId);
  assert.equal(assistant.message.responseModel, modelId);
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.provider, "provider-[REDACTED]");
  assert.equal(observed[0]?.model, "model-[REDACTED]");
  assert.equal(observedMessages.length, 1);
  assert.equal(observedMessages[0]?.message.provider, "provider-[REDACTED]");
  assert.equal(observedMessages[0]?.message.model, "model-[REDACTED]");
  assert.equal(observedMessages[0]?.message.responseModel, "model-[REDACTED]");
  await session.close();
});

test("AgentSession preserves benign provider-state fields in durable JSONL while omitting private state from runtime observers", async () => {
  const cwd = await workspace();
  const ordinaryEventSecret = "registered-ordinary-event-credential";
  defaultSecretRedactor.register(ordinaryEventSecret);
  const state: ProviderState = {
    kind: "chat_completions",
    assistantMessage: {
      token: "opaque cursor",
      secret: "provider label",
      password: "continuation marker",
    },
  };
  const provider = new ProviderStateProvider(state, `answer:${ordinaryEventSecret}`);
  const manager = SessionManager.create(cwd, join(cwd, "sessions"), { id: "provider-state-preservation" });
  const session = await AgentSession.create(sessionOptions(
    manager,
    new ProviderRegistry([provider]),
  ));
  const observed: RuntimeEvent[] = [];
  session.onEvent((envelope) => {
    if (envelope.event.type === "message_appended" && envelope.event.message.role === "assistant") {
      observed.push(envelope.event);
    }
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });

  await session.prompt("persist state", { allowedTools: [] });

  const assistant = manager.buildSessionContext().messages.findLast((message) => message.role === "assistant");
  assert.ok(assistant && "providerState" in assistant);
  assert.deepEqual(assistant.providerState, {
    ...state,
    source: {
      provider: provider.id,
      model: "one",
      api: "openai-chat-completions",
    },
  });
  assert.doesNotMatch(JSON.stringify(assistant.content), new RegExp(ordinaryEventSecret, "u"));
  assert.match(JSON.stringify(assistant.content), /\[REDACTED\]/u);
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const jsonl = await readFile(sessionFile, "utf8");
  assert.match(
    jsonl,
    /"assistantMessage":\{"token":"opaque cursor","secret":"provider label","password":"continuation marker"\}/u,
  );
  assert.doesNotMatch(jsonl, new RegExp(ordinaryEventSecret, "u"));
  assert.equal(observed.length, 1);
  assert.doesNotMatch(JSON.stringify(observed[0]), new RegExp(ordinaryEventSecret, "u"));
  assert.equal("providerState" in observed[0]!, false);
  assert.equal("providerStateSerialized" in observed[0]!, false);
  await session.close();
});

test("AgentSession redacts every user Bash string before memory and JSONL persistence", async () => {
  const cwd = await workspace();
  const secrets = {
    command: "bash-command-registered-secret",
    output: "bash-output-registered-secret",
    signal: "bash-signal-registered-secret",
    path: "bash-path-registered-secret",
  };
  defaultSecretRedactor.registerAll(Object.values(secrets));
  const manager = SessionManager.create(cwd, join(cwd, "sessions"), { id: "bash-redaction" });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry()));

  session.recordBashResult(`printf ${secrets.command}`, {
    output: `result:${secrets.output}`,
    exitCode: 7,
    isError: true,
    cancelled: false,
    timedOut: false,
    signal: `signal:${secrets.signal}`,
    truncated: true,
    fullOutputPath: `/tmp/${secrets.path}.log`,
  });

  const stored = manager.getBranch().findLast((entry) =>
    entry.type === "message" && entry.message.role === "bashExecution");
  assert.equal(stored?.type, "message");
  if (stored?.type !== "message") throw new Error("missing durable Bash message");
  const memory = JSON.stringify(stored.message);
  for (const secret of Object.values(secrets)) assert.doesNotMatch(memory, new RegExp(secret, "u"));
  assert.match(memory, /\[REDACTED\]/u);

  await session.close();
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const jsonl = await readFile(sessionFile, "utf8");
  for (const secret of Object.values(secrets)) assert.doesNotMatch(jsonl, new RegExp(secret, "u"));
  assert.match(jsonl, /\[REDACTED\]/u);
});

test("AgentSession drops credential-bearing provider state but still appends and observes the assistant message", async (context) => {
  const registered = "registered-provider-state-credential";
  defaultSecretRedactor.register(registered);
  const cases = [
    { name: "registered credential", value: `prefix:${registered}:suffix` },
    { name: "credential-shaped value", value: ["sk", "proj", "1234567890abcdefghijkl"].join("-") },
  ];
  for (const entry of cases) {
    await context.test(entry.name, async () => {
      const cwd = await workspace();
      const provider = new ProviderStateProvider({
        kind: "chat_completions",
        assistantMessage: { continuation: entry.value },
      });
      const manager = SessionManager.inMemory(cwd);
      const session = await AgentSession.create(sessionOptions(
        manager,
        new ProviderRegistry([provider]),
      ));
      const observed: RuntimeEvent[] = [];
      session.onEvent((envelope) => {
        if (envelope.event.type === "message_appended" && envelope.event.message.role === "assistant") {
          observed.push(envelope.event);
        }
      });
      await session.setModel({
        provider: provider.id,
        api: "openai-chat-completions",
        id: "one",
        info: provider.models[0]!,
      });

      await session.prompt("keep the answer", { allowedTools: [] });

      assert.equal(
        manager.buildSessionContext().messages.some((message) => message.role === "assistant"),
        true,
      );
      assert.equal(observed.length, 1);
      assert.equal("providerState" in observed[0]!, false);
      const entries = JSON.stringify(manager.getEntries());
      const escaped = entry.value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      assert.doesNotMatch(entries, new RegExp(escaped, "u"));
      assert.doesNotMatch(entries, /"providerState"/u);

      // The next request must not reuse the dropped continuation state.
      await session.prompt("next turn", { allowedTools: [] });
      assert.equal(provider.requests[1]?.providerState, undefined);
      await session.close();
    });
  }
});

test("durable compaction clears retained continuation pointers for the next and resumed request", async (t) => {
  for (const reopen of [false, true]) {
    await t.test(reopen ? "reopened JSONL session" : "current session", async () => {
      const cwd = await workspace();
      const provider = new ContinuationProvider();
      const providers = new ProviderRegistry([provider]);
      let manager = reopen
        ? SessionManager.create(cwd, join(cwd, "sessions"), { id: "continuation-after-compaction" })
        : SessionManager.inMemory(cwd, { id: "continuation-after-compaction" });
      const selected: AgentSessionModel = {
        provider: provider.id,
        api: "openai-responses",
        id: "one",
        info: provider.models[0]!,
      };
      let session = await AgentSession.create(sessionOptions(manager, providers));
      await session.setModel(selected);
      await session.prompt("first", { allowedTools: [] });

      const retainedStart = manager.getBranch().find((entry) =>
        entry.type === "message" && entry.message.role === "user");
      assert.equal(retainedStart?.type, "message");
      manager.appendCompaction("durable checkpoint", retainedStart!.id, 14);

      if (reopen) {
        const file = manager.getSessionFile();
        assert.notEqual(file, undefined);
        await session.close();
        manager = SessionManager.open(file!);
        session = await AgentSession.create(sessionOptions(manager, providers));
        await session.setModel(selected);
      }

      await session.prompt("second", { allowedTools: [] });
      const rewritten = provider.requests[1];
      assert.equal(rewritten?.providerState?.kind, "openai_responses");
      assert.equal(
        rewritten?.providerState?.kind === "openai_responses"
          ? rewritten.providerState.previousResponseId
          : undefined,
        undefined,
      );
      assert.deepEqual(
        rewritten?.providerState?.kind === "openai_responses"
          ? rewritten.providerState.outputItems
          : undefined,
        [{ type: "message", id: "item-1" }],
      );
      assert.equal(rewritten?.messages.some((entry) =>
        entry.purpose === "compaction" &&
        entry.content.some((block) => block.type === "text" && block.text.includes("durable checkpoint"))), true);

      await session.prompt("third", { allowedTools: [] });
      assert.equal(provider.requests[2]?.providerState?.kind, "openai_responses");
      assert.equal(
        provider.requests[2]?.providerState?.kind === "openai_responses"
          ? provider.requests[2].providerState.previousResponseId
          : undefined,
        "response-2",
      );
      await session.close();
    });
  }
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

  session.setThinkingLevel("max");
  models.setProvider(createProvider({
    id: provider.id,
    auth: {
      apiKey: {
        name: "Fixture key",
        async resolve() { return { auth: { apiKey: "fixture" }, source: "fixture" }; },
      },
    },
    models: [{
      ...directModel,
      thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: null },
    }],
    api: { async *stream() {} },
  }));
  assert.deepEqual(session.getAvailableThinkingLevels(), ["off", "low", "medium", "high", "xhigh"]);
  assert.equal(session.cycleThinkingLevel(), "off");
  session.setThinkingLevel("max");
  assert.equal(session.thinkingLevel, "xhigh");
  session.setThinkingLevel("minimal");
  assert.equal(session.thinkingLevel, "low");
  await session.close();
});

test("AgentSession switches a supported reasoning effort between consecutive turns", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const selected = {
    ...provider.models[0]!,
    compatibility: {
      ...provider.models[0]!.compatibility,
      reasoningEfforts: {
        value: ["low", "medium", "high", "xhigh", "max"],
        source: "provider" as const,
        observedAt,
      },
    },
  } satisfies ModelInfo;
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([provider])),
    model: {
      provider: provider.id,
      api: "openai-chat-completions",
      id: selected.id,
      info: selected,
    },
    thinkingLevel: "low",
  });

  await session.prompt("first", { allowedTools: [] });
  session.setThinkingLevel("max");
  await session.prompt("second", { allowedTools: [] });

  assert.deepEqual(provider.requests.map((entry) => entry.reasoningEffort), ["low", "max"]);
  assert.equal(session.thinkingLevel, "max");
  await session.close();
});

test("AgentSession sends thinking only when selected model evidence supports it", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const providers = new ProviderRegistry([provider]);
  const unknown = { value: "unknown" as const, source: "provider" as const, observedAt };
  const unknownModel: ModelInfo = {
    id: "unknown-reasoning",
    provider: provider.id,
    capabilities: { tools: unknown, reasoning: unknown, images: unknown },
    compatibility: {
      protocolFamily: { value: "openai-chat-completions", source: "provider", observedAt },
    },
  };
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), providers),
    settingsManager: SettingsManager.inMemory({ defaultThinkingLevel: "max" }),
  });

  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: unknownModel.id,
    info: unknownModel,
  });
  assert.deepEqual(session.getAvailableThinkingLevels(), ["off"]);
  assert.equal(session.thinkingLevel, "off");
  session.setThinkingLevel("max");
  assert.equal(session.thinkingLevel, "off");
  await session.prompt("unknown", { allowedTools: [] });
  assert.equal(provider.requests.at(-1)?.reasoningEffort, undefined);

  const reportedModel: ModelInfo = {
    ...unknownModel,
    id: "reported-reasoning",
    compatibility: {
      ...unknownModel.compatibility,
      reasoningEfforts: { value: ["off", "high"], source: "provider", observedAt },
    },
  };
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: reportedModel.id,
    info: reportedModel,
  });
  assert.deepEqual(session.getAvailableThinkingLevels(), ["off", "high"]);
  session.setThinkingLevel("high");
  await session.prompt("reported", { allowedTools: [] });
  assert.equal(provider.requests.at(-1)?.reasoningEffort, "high");
  await session.close();
});

test("AgentSession applies thinking selected by a model reference", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  provider.models[0] = {
    ...provider.models[0]!,
    compatibility: {
      ...provider.models[0]!.compatibility,
      reasoningEfforts: { value: ["low", "max"], source: "provider", observedAt },
    },
  };
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([provider])),
    settingsManager: SettingsManager.inMemory({ defaultThinkingLevel: "max" }),
  });

  const inline = await session.resolveModel("one:low", { provider: provider.id });
  assert.equal(inline.reasoningEffort, "low");
  await session.setModel(inline);
  assert.equal(session.thinkingLevel, "low");

  const explicit = await session.resolveModel("one:low", {
    provider: provider.id,
    reasoningEffort: "max",
  });
  assert.equal(explicit.reasoningEffort, "max");
  await session.setModel(explicit);
  assert.equal(session.thinkingLevel, "max");
  await session.close();
});

test("AgentSession restores saved thinking after leaving a non-reasoning model", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const base = {
    api: "openai-chat-completions" as const,
    provider: provider.id,
    baseUrl: "https://example.test/v1",
    input: ["text"] as ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
  };
  const reasoning: ProviderModel = {
    ...base,
    id: "reasoning",
    name: "Reasoning",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  };
  const plain: ProviderModel = {
    ...base,
    id: "plain",
    name: "Plain",
    reasoning: false,
  };
  const limited: ProviderModel = {
    ...base,
    id: "limited",
    name: "Limited",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: null },
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
    models: [reasoning, plain, limited],
    api: { async *stream() {} },
  }));
  const modelRegistry = new ModelRegistry(models);
  await modelRegistry.refresh();
  const entryPoints = [
    {
      name: "setModel",
      apply: async (session: AgentSession, selected: ProviderModel) => await session.setModel(selected),
    },
    {
      name: "setNativeModel",
      apply: async (session: AgentSession, selected: ProviderModel) => await session.setNativeModel(selected),
    },
    {
      name: "agent.model",
      apply: async (session: AgentSession, selected: ProviderModel) => {
        session.agent.state.model = selected as Model<Api>;
      },
    },
  ];

  for (const entryPoint of entryPoints) {
    const settings = SettingsManager.inMemory({ defaultThinkingLevel: "max" });
    const session = await AgentSession.create({
      sessionManager: SessionManager.inMemory(cwd),
      providers: new ProviderRegistry([provider]),
      settingsManager: settings,
      modelRegistry,
    });

    await entryPoint.apply(session, reasoning);
    assert.equal(session.thinkingLevel, "max", `${entryPoint.name}: initial saved level`);

    await entryPoint.apply(session, plain);
    assert.equal(session.thinkingLevel, "off", `${entryPoint.name}: non-reasoning clamp`);
    assert.equal(settings.getDefaultThinkingLevel(), "max", `${entryPoint.name}: saved level preserved`);

    await entryPoint.apply(session, limited);
    assert.equal(session.thinkingLevel, "xhigh", `${entryPoint.name}: restored level clamped to target`);

    session.setThinkingLevel("off");
    settings.setDefaultThinkingLevel("high");
    await entryPoint.apply(session, reasoning);
    assert.equal(session.thinkingLevel, "off", `${entryPoint.name}: explicit off preserved`);
    await session.close();
  }
});

test("AgentSession clamps restored thinking to the current model without publishing a selection", async () => {
  const cwd = await workspace();
  const sessionDirectory = join(cwd, "sessions");
  const provider = new RecordingProvider();
  const providers = new ProviderRegistry([provider]);
  const modelId = "reasoning-drift";
  const providerModel = (max: string | null): ProviderModel => ({
    id: modelId,
    name: "Reasoning drift",
    api: "openai-chat-completions",
    provider: provider.id,
    baseUrl: "https://example.test/v1",
    reasoning: true,
    thinkingLevelMap: { max },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
  });
  const registry = async (selected: ProviderModel): Promise<ModelRegistry> => {
    const models = createModels();
    models.setProvider(createProvider({
      id: provider.id,
      auth: {
        apiKey: {
          name: "Fixture key",
          async resolve() { return { auth: { apiKey: "fixture" }, source: "fixture" }; },
        },
      },
      models: [selected],
      api: { async *stream() {} },
    }));
    const modelRegistry = new ModelRegistry(models);
    await modelRegistry.refresh();
    return modelRegistry;
  };
  const supportedModel = providerModel("provider-max");
  const limitedModel = providerModel(null);
  const supportedRegistry = await registry(supportedModel);
  const limitedRegistry = await registry(limitedModel);

  const storedManager = SessionManager.create(cwd, sessionDirectory, { id: "reasoning-drift" });
  const stored = await AgentSession.create({
    ...sessionOptions(storedManager, providers),
    modelRegistry: supportedRegistry,
  });
  await stored.setNativeModel(supportedModel);
  stored.setThinkingLevel("max");
  assert.equal(stored.thinkingLevel, "max");
  const storedPath = storedManager.getSessionFile();
  assert.notEqual(storedPath, undefined);
  const storedThinkingEntries = storedManager.getEntries()
    .filter((entry) => entry.type === "thinking_level_change").length;
  await stored.close();

  const reopenedManager = SessionManager.open(storedPath!);
  const reopened = await AgentSession.create({
    ...sessionOptions(reopenedManager, providers),
    modelRegistry: limitedRegistry,
  });
  assert.equal(reopened.model?.id, modelId);
  assert.deepEqual(reopened.getAvailableThinkingLevels(), ["off", "minimal", "low", "medium", "high"]);
  assert.equal(reopened.thinkingLevel, "high");
  assert.equal(
    reopenedManager.getEntries().filter((entry) => entry.type === "thinking_level_change").length,
    storedThinkingEntries,
  );
  await reopened.close();

  const explicitManager = SessionManager.inMemory(cwd, { id: "explicit-reasoning-drift" });
  const explicit = await AgentSession.create({
    ...sessionOptions(explicitManager, providers),
    modelRegistry: limitedRegistry,
    model: { provider: provider.id, api: limitedModel.api, id: modelId },
    thinkingLevel: "max",
  });
  assert.equal(explicit.thinkingLevel, "high");
  assert.equal(
    explicitManager.getEntries().filter((entry) => entry.type === "thinking_level_change").length,
    0,
  );
  await explicit.close();

  const supportedExplicitManager = SessionManager.inMemory(cwd, { id: "supported-explicit-thinking" });
  const supportedExplicit = await AgentSession.create({
    ...sessionOptions(supportedExplicitManager, providers),
    modelRegistry: supportedRegistry,
    model: { provider: provider.id, api: supportedModel.api, id: modelId },
    thinkingLevel: "max",
  });
  assert.equal(supportedExplicit.thinkingLevel, "max");
  assert.equal(
    supportedExplicitManager.getEntries().filter((entry) => entry.type === "thinking_level_change").length,
    0,
  );
  await supportedExplicit.close();

  const switchingManager = SessionManager.inMemory(cwd, { id: "switch-reasoning-drift" });
  const switching = await AgentSession.create({
    ...sessionOptions(switchingManager, providers),
    modelRegistry: limitedRegistry,
    model: { provider: provider.id, api: limitedModel.api, id: modelId },
    thinkingLevel: "low",
  });
  const events: AgentSessionEvent[] = [];
  switching.subscribe((event) => { events.push(event); });
  switching.switchSessionFile(storedPath!);
  assert.equal(switching.model?.id, modelId);
  assert.equal(switching.thinkingLevel, "high");
  assert.equal(
    switchingManager.getEntries().filter((entry) => entry.type === "thinking_level_change").length,
    storedThinkingEntries,
  );
  assert.equal(events.some((event) => event.type === "thinking_level_changed"), false);
  await switching.close();
});

test("AgentSession enters a scoped model list consistently from an outside model", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const providers = new ProviderRegistry([provider]);
  const providerModel = (id: string): ProviderModel => ({
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
  });
  const outside = providerModel("outside");
  const first = providerModel("first");
  const second = providerModel("second");
  const third = providerModel("third");
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), providers),
    scopedModels: [
      { model: first, thinkingLevel: "low" },
      { model: second, thinkingLevel: "medium" },
      { model: third, thinkingLevel: "high" },
    ],
  });

  await session.setNativeModel(outside);
  const forward = await session.cycleNativeModel("forward");
  assert.equal(forward?.model.id, "first");
  assert.equal(forward?.thinkingLevel, "low");

  await session.setNativeModel(outside);
  const backward = await session.cycleNativeModel("backward");
  assert.equal(backward?.model.id, "third");
  assert.equal(backward?.thinkingLevel, "high");
  await session.close();
});

test("AgentSession applies configured model-cycle scope without widening disabled or empty matches", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const providers = new ProviderRegistry([provider]);
  const modelRegistry = await recordingModelRegistry(provider);
  const settings = SettingsManager.inMemory();
  settings.setEnabledModels(["fixture/two:high", "fixture/one:low"]);
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), providers),
    modelRegistry,
    settingsManager: settings,
    model: { provider: provider.id, api: "openai-chat-completions", id: "one" },
    thinkingLevel: "medium",
  });
  assert.equal(session.modelCyclingEnabled, true);
  assert.deepEqual(session.scopedModels.map((entry) => ({
    model: entry.model.id,
    thinkingLevel: entry.thinkingLevel,
  })), [
    { model: "two", thinkingLevel: "high" },
    { model: "one", thinkingLevel: "low" },
  ]);
  const configured = await session.cycleModel();
  assert.equal(configured?.model.id, "two");
  assert.equal(configured?.thinkingLevel, "high");
  assert.equal(configured?.isScoped, true);

  settings.setEnabledModels(["!none"]);
  await session.refresh();
  assert.equal(session.modelCyclingEnabled, false);
  assert.deepEqual(session.scopedModels, []);
  assert.equal(await session.cycleModel(), undefined);

  settings.setEnabledModels(["fixture/missing"]);
  await session.refresh();
  assert.equal(session.modelCyclingEnabled, false);
  assert.deepEqual(session.scopedModels, []);
  assert.equal(await session.cycleModel(), undefined);
  await session.close();

  const explicit = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), providers),
    modelRegistry,
    settingsManager: settings,
    model: { provider: provider.id, api: "openai-chat-completions", id: "one" },
    scopedModels: [],
  });
  assert.equal(explicit.modelCyclingEnabled, true);
  assert.deepEqual(explicit.scopedModels, []);
  assert.equal((await explicit.cycleModel())?.model.id, "two");
  explicit.setScopedModels([], { cyclingEnabled: false });
  assert.equal(explicit.modelCyclingEnabled, false);
  assert.equal(await explicit.cycleModel(), undefined);
  await explicit.close();

  const unavailableModel = {
    ...modelRegistry.getAvailable()[0]!,
    provider: "unavailable-provider",
    id: "unavailable-model",
  };
  const unavailableScope = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), providers),
    modelRegistry,
    model: { provider: provider.id, api: "openai-chat-completions", id: "one" },
    scopedModels: [{ model: unavailableModel }],
  });
  assert.equal(unavailableScope.modelCyclingEnabled, true);
  assert.equal(await unavailableScope.cycleModel(), undefined);
  await unavailableScope.close();

  const driftRegistry = await recordingModelRegistry(provider);
  const driftSettings = SettingsManager.inMemory({ enabledModels: ["fixture/one"] });
  const drift = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), providers),
    modelRegistry: driftRegistry,
    settingsManager: driftSettings,
    model: { provider: provider.id, api: "openai-chat-completions", id: "two" },
  });
  assert.equal(drift.modelCyclingEnabled, true);
  assert.deepEqual(drift.scopedModels.map((entry) => entry.model.id), ["one"]);
  const getAvailable = driftRegistry.getAvailable.bind(driftRegistry);
  Object.defineProperty(driftRegistry, "getAvailable", { configurable: true, value: () => [] });
  try {
    assert.equal(drift.modelCyclingEnabled, false);
    assert.deepEqual(drift.scopedModels, []);
    assert.equal(await drift.cycleModel(), undefined);
  } finally {
    Object.defineProperty(driftRegistry, "getAvailable", { configurable: true, value: getAvailable });
  }
  await drift.close();
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
  assert.equal(first.model?.api, "openai-completions");
  assert.equal(first.model?.id, "two");
  assert.equal(first.nativeModel?.api, "openai-chat-completions");
  assert.equal(first.sessionManager.getSessionFile(), secondFile);
  await first.prompt("second through replacement", { allowedTools: [] });
  assert.deepEqual(provider.requests.map((request) => request.sessionId), ["first", "second", "second"]);
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
  const publicModel = session.model;
  const nativeModel = session.nativeModel;
  await session.prompt("before replacement", { allowedTools: [] });

  session.newSession({ id: "after" });
  await session.prompt("after replacement", { allowedTools: [] });

  assert.equal(session.sessionId, "after");
  assert.deepEqual(session.model, publicModel);
  assert.deepEqual(session.nativeModel, nativeModel);
  assert.equal(session.model?.api, "openai-completions");
  assert.equal(session.nativeModel?.api, "openai-chat-completions");
  assert.equal(session.thinkingLevel, "high");
  assert.deepEqual(manager.buildSessionContext().model, {
    provider: provider.id,
    modelId: "one",
  });
  assert.deepEqual(provider.requests.map((request) => request.sessionId), ["before", "after"]);
  session.agent.sessionId = "caller-owned-affinity";
  session.newSession({ id: "third" });
  await session.prompt("caller-owned affinity", { allowedTools: [] });
  assert.equal(provider.requests.at(-1)?.sessionId, "caller-owned-affinity");
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
  assert.equal(stats.userMessages, 2);
  assert.equal(stats.assistantMessages, 1);
  assert.equal(stats.totalMessages, 4);
  assert.equal(stats.usage.inputTokens, 10);
  assert.equal(stats.usage.outputTokens, 4);
  assert.equal(stats.cost, 0.002);
  assert.ok(stats.contextUsage?.tokens !== null && stats.contextUsage?.tokens !== undefined);
  assert.ok(stats.contextUsage.tokens > 10);
  assert.equal(stats.contextUsage.contextWindow, 100_000);
  assert.equal(stats.contextUsage.percent, (stats.contextUsage.tokens / 100_000) * 100);
  assert.equal(stats.contextUsage.source, "estimated");
  assert.equal(stats.contextUsage.autoCompactionThresholdPercent, 85);

  const previousUmask = process.umask(0o000);
  let exported: string;
  try {
    exported = session.exportToJsonl(join(cwd, "exported.jsonl"));
  } finally {
    process.umask(previousUmask);
  }
  assert.equal((await stat(exported)).mode & 0o777, 0o600);
  const journal = parseSessionV4Bytes(Buffer.from(await readFile(exported)));
  const nodes = [...journal.state.nodes.values()];
  assert.equal(journal.state.header.record, "session");
  assert.equal(journal.state.header.version, 4);
  assert.equal(nodes.some((node) =>
    node.nodeType === "shell"
    && node.result !== null
    && typeof node.result === "object"
    && !Array.isArray(node.result)
    && node.result.role === "bashExecution"), true);
  assert.equal(nodes.every((node, index) => node.parentId === (index === 0 ? null : nodes[index - 1]?.id)), true);
  assert.equal(journal.state.operations.size, 0);
  assert.equal(journal.state.queue.size, 0);
  assert.equal(journal.state.toolEffects.size, 0);
  await session.close();
});

test("AgentSession startup and clean close opportunistically prune expired Bash artifacts without running Bash", async (context) => {
  const installRoot = await mkdtemp(join(tmpdir(), "rigyn-agent-session-spill-cleanup-"));
  context.after(async () => await rm(installRoot, { recursive: true, force: true }));
  const previousInstallRoot = process.env.RIGYN_INSTALL_DIR;
  process.env.RIGYN_INSTALL_DIR = installRoot;
  context.after(() => {
    if (previousInstallRoot === undefined) delete process.env.RIGYN_INSTALL_DIR;
    else process.env.RIGYN_INSTALL_DIR = previousInstallRoot;
  });
  const identity = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  const outputDirectory = join(installRoot, "tmp", `rigyn-tool-output-${identity}`);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const expired = join(outputDirectory, "rigyn-bash-0123456789abcdef.log");
  await writeFile(expired, "expired\n", { mode: 0o600 });
  await utimes(expired, new Date(0), new Date(0));

  const cwd = await workspace();
  const provider = new RecordingProvider();
  const session = await AgentSession.create(
    sessionOptions(SessionManager.inMemory(cwd, { id: "spill-cleanup" }), new ProviderRegistry([provider])),
  );
  assert.deepEqual(await readdir(outputDirectory), []);

  await writeFile(expired, "expired again\n", { mode: 0o600 });
  await utimes(expired, new Date(0), new Date(0));
  await session.close();
  assert.deepEqual(await readdir(outputDirectory), []);
});

test("AgentSession close waits for an aborted Bash execution to finish finalization", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const session = await AgentSession.create(
    sessionOptions(SessionManager.inMemory(cwd, { id: "bash-close-settlement" }), new ProviderRegistry([provider])),
  );
  let release!: () => void;
  const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked; });
  const operations: BashOperations = {
    async exec(_command, _cwd, options) {
      await blocked;
      if (options.signal?.aborted === true) throw new Error("aborted");
      return { exitCode: 0 };
    },
  };
  const bash = session.executeBash("blocked close", undefined, { operations });
  const bashRejected = assert.rejects(bash, /Shell command was cancelled/u);
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  let closeSettled = false;
  const close = session.close().finally(() => { closeSettled = true; });
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(closeSettled, false);

  release();
  await bashRejected;
  await close;
  assert.equal(closeSettled, true);
});

test("AgentSession HTML and JSONL exports refuse existing non-private destinations", async (context) => {
  const cwd = await workspace();
  const session = await AgentSession.create(sessionOptions(
    SessionManager.inMemory(cwd, { id: "existing-export-destination" }),
    new ProviderRegistry(),
  ));
  context.after(async () => await session.close());
  const html = join(cwd, "existing.html");
  const jsonl = join(cwd, "existing.jsonl");
  await writeFile(html, "original html", { encoding: "utf8", mode: 0o644 });
  await writeFile(jsonl, "original jsonl", { encoding: "utf8", mode: 0o644 });
  if (process.platform !== "win32") {
    await chmod(html, 0o644);
    await chmod(jsonl, 0o644);
  }

  await assert.rejects(() => session.exportToHtml(html), /export destination already exists/iu);
  assert.throws(() => session.exportToJsonl(jsonl), /export destination already exists/iu);
  assert.equal(await readFile(html, "utf8"), "original html");
  assert.equal(await readFile(jsonl, "utf8"), "original jsonl");
  if (process.platform !== "win32") {
    assert.equal((await stat(html)).mode & 0o777, 0o644);
    assert.equal((await stat(jsonl)).mode & 0o777, 0o644);
  }
});

test("session statistics count every public result in a canonical tool batch", async () => {
  const cwd = await workspace();
  const manager = SessionManager.inMemory(cwd, { id: "batched-result-stats" });
  manager.appendMessage({
    id: "batched-results",
    role: "tool",
    content: [
      { type: "tool_result", callId: "call-one", name: "one", content: "first", isError: false },
      { type: "tool_result", callId: "call-two", name: "two", content: "second", isError: true },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry()));
  try {
    const stats = session.getSessionStats();
    assert.equal(stats.totalMessages, 2);
    assert.equal(stats.toolResults, 2);
  } finally {
    await session.close();
  }
});

test("AgentSession stats aggregate durable cache misses and reset comparisons at compaction", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "cache-waste-stats" });
  const assistant = (
    id: string,
    createdAt: string,
    usage: NonNullable<ProviderRequest["messages"][number]["usage"]>,
  ) => manager.appendMessage({
    id,
    role: "assistant",
    content: [{ type: "text", text: id }],
    createdAt,
    provider: provider.id,
    model: "one",
    stopReason: "stop",
    usage,
  });
  assistant("cache-write", "2026-07-20T00:00:00.000Z", {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 30_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0.12, total: 0.12 },
  });
  assistant("cache-miss", "2026-07-20T00:01:00.000Z", {
    inputTokens: 30_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: { input: 0.09, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.09 },
  });
  const kept = manager.appendMessage({
    id: "after-cache-miss",
    role: "user",
    content: [{ type: "text", text: "continue" }],
    createdAt: "2026-07-20T00:02:00.000Z",
  });
  manager.appendCompaction("checkpoint", kept, 60_000);
  assistant("after-compaction", "2026-07-20T00:03:00.000Z", {
    inputTokens: 30_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: { input: 0.09, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.09 },
  });

  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  assert.deepEqual(session.getSessionStats().cacheWaste, {
    missedTokens: 30_000,
    missedCost: 0.09,
    missCount: 1,
  });
  await session.close();
});

test("AgentSession cache-waste stats exclude instruction and tool-definition boundaries", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "cache-structural-boundaries" });
  const instructions = (id: string, text: string) => manager.appendMessage({
    id,
    role: "system",
    content: [{ type: "text", text }],
    createdAt: "2026-07-20T00:00:00.000Z",
    purpose: "instructions",
  });
  const assistant = (id: string, inputTokens: number, toolDefinitionFingerprint: string) => manager.appendMessage({
    id,
    role: "assistant",
    content: [{ type: "text", text: id }],
    createdAt: `2026-07-20T00:00:${String(inputTokens / 1_000).padStart(2, "0")}.000Z`,
    provider: provider.id,
    model: "one",
    api: "extension-stream",
    stopReason: "stop",
    toolDefinitionFingerprint,
    usage: { inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });

  instructions("instructions-a", "first instructions");
  assistant("first", 30_000, "tools-a");
  instructions("instructions-b", "second instructions");
  assistant("after-instructions", 31_000, "tools-a");
  assistant("after-tools", 32_000, "tools-b");
  assistant("same-boundary", 33_000, "tools-b");

  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  assert.deepEqual(session.getSessionStats().cacheWaste, {
    missedTokens: 32_000,
    missedCost: 0,
    missCount: 1,
  });
  await session.close();
});

test("AgentSession cache diagnostics follow the active branch instead of append order", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "cache-active-branch" });
  manager.appendMessage({
    id: "common-cache",
    role: "assistant",
    content: [{ type: "text", text: "common" }],
    createdAt: "2026-07-20T00:00:00.000Z",
    provider: provider.id,
    model: "one",
    stopReason: "stop",
    usage: { cacheWriteTokens: 10_000 },
  });
  const branchPoint = manager.appendMessage({
    id: "branch-point",
    role: "user",
    content: [{ type: "text", text: "choose a branch" }],
    createdAt: "2026-07-20T00:01:00.000Z",
  });
  manager.appendMessage({
    id: "abandoned-response",
    role: "assistant",
    content: [{ type: "text", text: "abandoned" }],
    createdAt: "2026-07-20T00:02:00.000Z",
    provider: provider.id,
    model: "one",
    stopReason: "stop",
    usage: { inputTokens: 90_000, cacheReadTokens: 10_000, cacheWriteTokens: 0 },
  });
  manager.branch(branchPoint);
  manager.appendMessage({
    id: "active-response",
    role: "assistant",
    content: [{ type: "text", text: "active" }],
    createdAt: "2026-07-20T00:03:00.000Z",
    provider: provider.id,
    model: "one",
    stopReason: "stop",
    usage: { inputTokens: 40_000, cacheReadTokens: 10_000, cacheWriteTokens: 0 },
  });

  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  assert.deepEqual(session.getSessionStats().cacheWaste, {
    missedTokens: 0,
    missedCost: 0,
    missCount: 0,
  });
  await session.close();
});

test("AgentSession stats do not compare cache usage across an unmeasured assistant request", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "cache-waste-missing-usage" });
  manager.appendMessage({
    id: "cache-write",
    role: "assistant",
    content: [{ type: "text", text: "cache write" }],
    createdAt: "2026-07-20T00:00:00.000Z",
    provider: provider.id,
    model: "one",
    stopReason: "stop",
    usage: { cacheWriteTokens: 30_000 },
  });
  manager.appendMessage({
    id: "unmeasured-request",
    role: "assistant",
    content: [{ type: "text", text: "no usage" }],
    createdAt: "2026-07-20T00:01:00.000Z",
    provider: provider.id,
    model: "one",
    stopReason: "stop",
  });
  manager.appendMessage({
    id: "later-request",
    role: "assistant",
    content: [{ type: "text", text: "later usage" }],
    createdAt: "2026-07-20T00:02:00.000Z",
    provider: provider.id,
    model: "one",
    stopReason: "stop",
    usage: { inputTokens: 30_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });

  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  assert.deepEqual(session.getSessionStats().cacheWaste, {
    missedTokens: 0,
    missedCost: 0,
    missCount: 0,
  });
  await session.close();
});

test("AgentSession streams correlated bash updates through per-call operations", async (t) => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "bash-events" });
  const session = await AgentSession.create(
    sessionOptions(manager, new ProviderRegistry([provider])),
  );
  const inheritedSecret = "agent-session-shell-token-secret";
  const previousSecret = process.env.AGENT_SESSION_AUTH_TOKEN;
  const previousSessionId = process.env.RIGYN_SESSION_ID;
  const previousProvider = process.env.RIGYN_PROVIDER;
  process.env.AGENT_SESSION_AUTH_TOKEN = inheritedSecret;
  process.env.RIGYN_SESSION_ID = "stale-user-shell-session";
  process.env.RIGYN_PROVIDER = "stale-user-shell-provider";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.AGENT_SESSION_AUTH_TOKEN;
    else process.env.AGENT_SESSION_AUTH_TOKEN = previousSecret;
    if (previousSessionId === undefined) delete process.env.RIGYN_SESSION_ID;
    else process.env.RIGYN_SESSION_ID = previousSessionId;
    if (previousProvider === undefined) delete process.env.RIGYN_PROVIDER;
    else process.env.RIGYN_PROVIDER = previousProvider;
  });
  const callbackDeltas: string[] = [];
  const events: Array<Extract<AgentSessionEvent, { type: "bash_execution_update" }>> = [];
  const toolLifecycle: Array<Extract<AgentSessionEvent, {
    type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
  }>> = [];
  session.subscribe((event) => {
    if (event.type === "bash_execution_update") events.push(event);
    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_update" ||
      event.type === "tool_execution_end"
    ) toolLifecycle.push(event);
  });

  const result = await session.executeBash(
    "remote command",
    (delta) => callbackDeltas.push(delta),
    {
      id: "bash-request",
      operations: {
        async exec(command, executionCwd, options) {
          assert.equal(command, "remote command");
          assert.equal(executionCwd, cwd);
          assert.equal(options.env?.RIGYN_SESSION_ID, undefined);
          assert.equal(options.env?.RIGYN_PROVIDER, undefined);
          assert.equal(options.env?.AGENT_SESSION_AUTH_TOKEN, undefined);
          options.onData(Buffer.from("first "));
          options.onData(Buffer.from("second"));
          return { exitCode: 0 };
        },
      },
    },
  );

  assert.equal(callbackDeltas.join(""), "first second");
  assert.equal(events.map((event) => event.delta).join(""), "first second");
  assert.equal(events.every((event) => event.id === "bash-request"), true);
  assert.equal(toolLifecycle[0]?.type, "tool_execution_start");
  assert.equal(toolLifecycle.at(-1)?.type, "tool_execution_end");
  assert.equal(toolLifecycle.some((event) => event.type === "tool_execution_update"), true);
  assert.equal(toolLifecycle.every((event) => event.toolCallId === "bash-request"), true);
  assert.equal(result.output, "first second");
  assert.equal(result.exitCode, 0);
  const failedDeltas: string[] = [];
  const failed = await session.executeBash(
    "remote failure",
    (delta) => failedDeltas.push(delta),
    {
      id: "bash-failure",
      operations: {
        async exec(_command, _cwd, options) {
          options.onData(Buffer.from("failure output"));
          return { exitCode: 7 };
        },
      },
    },
  );
  assert.equal(failedDeltas.join(""), "failure output");
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.isError, true);
  assert.equal(failed.cancelled, false);
  assert.equal(failed.truncated, false);
  assert.match(failed.output, /^Tool failed: failure output[\s\S]*Shell command ended with status 7$/u);
  const failedEnd = toolLifecycle.findLast((event) =>
    event.type === "tool_execution_end" && event.toolCallId === "bash-failure");
  assert.equal(failedEnd?.type, "tool_execution_end");
  if (failedEnd?.type === "tool_execution_end") {
    assert.equal(failedEnd.result.isError, true);
    assert.equal((failedEnd.result.metadata as Record<string, unknown> | undefined)?.exitCode, 7);
  }
  assert.equal(manager.buildSessionContext().messages.some((message) =>
    message.role === "bashExecution"
    && message.command === "remote failure"
    && message.exitCode === 7
    && message.isError === true), true);
  assert.equal(defaultSecretRedactor.redact(inheritedSecret), "[REDACTED]");
  const child = await session.executeBash(
    "printf '%s|%s|%s' \"${AGENT_SESSION_AUTH_TOKEN-unset}\" \"${RIGYN_SESSION_ID-unset}\" \"${RIGYN_PROVIDER-unset}\"",
  );
  assert.equal(child.output, "unset|unset|unset");
  assert.equal(child.exitCode, 0);
  await session.close();
});

test("AgentSession publishes complete metadata for shell timeout and signal outcomes", async (context) => {
  if (process.platform === "win32") {
    context.skip("The completed timeout and signal fixtures require a POSIX shell");
    return;
  }
  const cwd = await workspace();
  const manager = SessionManager.inMemory(cwd, { id: "bash-completed-failures" });
  const session = await AgentSession.create(
    sessionOptions(manager, new ProviderRegistry([new RecordingProvider()])),
  );
  const ends: ToolExecutionEndEvent[] = [];
  session.subscribe((event) => {
    if (event.type === "tool_execution_end") ends.push(event);
  });
  try {
    const timedOut = await session.executeBash(
      "printf timeout-output; while :; do :; done",
      undefined,
      { id: "bash-timeout", timeoutMs: 20 },
    );
    assert.equal(timedOut.isError, true);
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.cancelled, false);
    assert.match(timedOut.output, /^Tool failed: timeout-output[\s\S]*exceeded its 0\.02-second time limit$/u);
    const timeoutEnd = ends.find((event) => event.toolCallId === "bash-timeout");
    assert.equal(timeoutEnd?.result.isError, true);
    assert.equal((timeoutEnd?.result.metadata as Record<string, unknown> | undefined)?.timedOut, true);
    assert.equal((timeoutEnd?.result.metadata as Record<string, unknown> | undefined)?.cancelled, false);

    const signalled = await session.executeBash(
      "printf signal-output; kill -TERM $$",
      undefined,
      { id: "bash-signal" },
    );
    assert.equal(signalled.isError, true);
    assert.equal(signalled.signal, "SIGTERM");
    assert.equal(signalled.cancelled, false);
    assert.match(signalled.output, /^Tool failed: signal-output[\s\S]*stopped after signal SIGTERM$/u);
    const signalEnd = ends.find((event) => event.toolCallId === "bash-signal");
    assert.equal(signalEnd?.result.isError, true);
    assert.equal((signalEnd?.result.metadata as Record<string, unknown> | undefined)?.signal, "SIGTERM");
    assert.equal((signalEnd?.result.metadata as Record<string, unknown> | undefined)?.timedOut, false);
    assert.equal((signalEnd?.result.metadata as Record<string, unknown> | undefined)?.cancelled, false);
    const messages = manager.buildSessionContext().messages;
    assert.equal(messages.some((message) =>
      message.role === "bashExecution"
      && message.command.includes("timeout-output")
      && message.isError === true
      && message.timedOut === true), true);
    assert.equal(messages.some((message) =>
      message.role === "bashExecution"
      && message.command.includes("signal-output")
      && message.isError === true
      && message.signal === "SIGTERM"), true);
    const projected = session.messages.flatMap((message) =>
      message.role !== "user"
        ? []
        : typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((block) => block.type === "text" ? [block.text] : []),
    ).join("\n");
    assert.match(projected, /\[Command timed out\]/u);
    assert.match(projected, /\[Command stopped after signal SIGTERM\]/u);
  } finally {
    await session.close();
  }
});

test("AgentSession projects compatibility timeout and cancellation sentinels as completed failures", async () => {
  const cwd = await workspace();
  const manager = SessionManager.inMemory(cwd, { id: "bash-compatibility-failures" });
  const session = await AgentSession.create(
    sessionOptions(manager, new ProviderRegistry([new RecordingProvider()])),
  );
  try {
    const timedOut = await session.executeBash("compatibility timeout", undefined, {
      timeoutMs: 20,
      operations: {
        async exec(_command, _cwd, options) {
          options.onData(Buffer.from("timeout preview"));
          throw new Error("timeout:0.02");
        },
      },
    });
    assert.equal(timedOut.isError, true);
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.cancelled, false);
    assert.match(timedOut.output, /^Tool failed: timeout preview[\s\S]*0\.02-second time limit$/u);

    const cancelled = await session.executeBash("compatibility cancellation", undefined, {
      operations: {
        async exec(_command, _cwd, options) {
          options.onData(Buffer.from("cancel preview"));
          throw new Error("aborted");
        },
      },
    });
    assert.equal(cancelled.isError, true);
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.timedOut, undefined);
    assert.match(cancelled.output, /^Tool failed: cancel preview[\s\S]*Shell command was cancelled$/u);

    const messages = manager.buildSessionContext().messages.filter((message) =>
      message.role === "bashExecution");
    assert.equal(messages[0]?.role === "bashExecution" && messages[0].timedOut, true);
    assert.equal(messages[1]?.role === "bashExecution" && messages[1].cancelled, true);
    assert.equal(messages.every((message) => message.role === "bashExecution" && message.isError === true), true);
  } finally {
    await session.close();
  }
});

test("AgentSession retains scalar shell metadata for one oversized output line", async () => {
  const cwd = await workspace();
  const manager = SessionManager.inMemory(cwd, { id: "bash-oversized-line" });
  const session = await AgentSession.create(
    sessionOptions(manager, new ProviderRegistry([new RecordingProvider()])),
  );
  const ends: ToolExecutionEndEvent[] = [];
  session.subscribe((event) => {
    if (event.type === "tool_execution_end") ends.push(event);
  });
  try {
    const result = await session.executeBash("oversized failure", undefined, {
      id: "bash-oversized",
      operations: {
        async exec(_command, _cwd, options) {
          options.onData(Buffer.alloc(2 * 1024 * 1024, "x"));
          return { exitCode: 7 };
        },
      },
    });
    assert.equal(result.exitCode, 7);
    assert.equal(result.isError, true);
    assert.equal(result.truncated, true);
    assert.ok(result.fullOutputPath);
    assert.equal((await stat(result.fullOutputPath)).size, 2 * 1024 * 1024);

    const end = ends.find((event) => event.toolCallId === "bash-oversized");
    assert.equal(end?.result.isError, true);
    const metadata = end?.result.metadata as Record<string, unknown>;
    assert.equal(metadata.exitCode, 7);
    assert.equal(metadata.truncated, true);
    assert.equal(metadata.fullOutputPath, result.fullOutputPath);
    assert.equal(JSON.stringify(metadata).length < 16 * 1024, true);
    assert.equal(
      metadata.truncation !== null
      && typeof metadata.truncation === "object"
      && !Array.isArray(metadata.truncation)
      && "content" in metadata.truncation,
      false,
    );

    const journal = manager.buildSessionContext().messages.find((message) =>
      message.role === "bashExecution" && message.command === "oversized failure");
    assert.equal(journal?.role, "bashExecution");
    if (journal?.role === "bashExecution") {
      assert.equal(journal.exitCode, 7);
      assert.equal(journal.isError, true);
      assert.equal(journal.truncated, true);
      assert.equal(journal.fullOutputPath, result.fullOutputPath);
    }
    await rm(result.fullOutputPath, { force: true });
  } finally {
    await session.close();
  }
});

test("AgentSession settles and retains pending bash history when persistence fails", async () => {
  const cwd = await workspace();
  const provider = new GatedProvider();
  const manager = SessionManager.inMemory(cwd, { id: "bash-settlement-failure" });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => { events.push(event); });

  const running = session.prompt("hold the run", { allowedTools: [] });
  await provider.started;
  await session.executeBash("pending bash", undefined, {
    operations: {
      async exec(_command, _cwd, options) {
        options.onData(Buffer.from("pending output"));
        return { exitCode: 0 };
      },
    },
  });
  assert.equal(session.hasPendingBashMessages, true);

  const appendMessage = manager.appendMessage.bind(manager);
  manager.appendMessage = ((message, options) => {
    if (message.role === "bashExecution") throw new Error("fixture bash persistence failure");
    return appendMessage(message, options);
  }) as typeof manager.appendMessage;
  provider.release();

  await assert.rejects(running, /fixture bash persistence failure/u);
  assert.equal(session.isIdle, true);
  assert.equal(session.hasPendingBashMessages, true);
  assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);

  manager.appendMessage = appendMessage;
  await session.close();
  assert.equal(manager.buildSessionContext().messages.some((message) =>
    message.role === "bashExecution" && message.command === "pending bash"), true);
});

test("AgentSession close continues independent cleanup after an earlier failure", async () => {
  const cwd = await workspace();
  const manager = SessionManager.inMemory(cwd, { id: "isolated-close-cleanup" });
  const onAppend = manager.onAppend.bind(manager);
  manager.onAppend = ((listener) => {
    const unsubscribe = onAppend(listener);
    return () => {
      unsubscribe();
      throw new Error("fixture unsubscribe failure");
    };
  }) as typeof manager.onAppend;
  const settings = SettingsManager.inMemory();
  let settingsFlushed = false;
  settings.flush = async () => { settingsFlushed = true; };
  const session = await AgentSession.create({
    sessionManager: manager,
    providers: new ProviderRegistry([new RecordingProvider()]),
    settingsManager: settings,
  });

  await assert.rejects(session.close(), /fixture unsubscribe failure/u);
  assert.equal(settingsFlushed, true);
  assert.equal(session.isIdle, true);
});

test("concurrent AgentSession close callers await the same cleanup operation", async () => {
  const cwd = await workspace();
  const settings = SettingsManager.inMemory();
  let enterFlush!: () => void;
  let releaseFlush!: () => void;
  const flushing = new Promise<void>((resolve) => { enterFlush = resolve; });
  const release = new Promise<void>((resolve) => { releaseFlush = resolve; });
  settings.flush = async () => {
    enterFlush();
    await release;
  };
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd, { id: "concurrent-close" }),
    providers: new ProviderRegistry([new RecordingProvider()]),
    settingsManager: settings,
  });

  const first = session.close();
  await flushing;
  let secondSettled = false;
  const second = session.close().finally(() => { secondSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);

  releaseFlush();
  await Promise.all([first, second]);
  assert.equal(secondSettled, true);
});

test("AgentSession keeps newer bash cancellation active when an older command finishes", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const session = await AgentSession.create(
    sessionOptions(SessionManager.inMemory(cwd, { id: "bash-overlap-finish" }), new ProviderRegistry([provider])),
  );
  const pending: Array<{
    signal: AbortSignal | undefined;
    finish(): void;
  }> = [];
  const operations: BashOperations = {
    async exec(_command, _cwd, options) {
      await new Promise<void>((resolve) => {
        pending.push({ signal: options.signal, finish: resolve });
      });
      if (options.signal?.aborted === true) throw new Error("aborted");
      return { exitCode: 0 };
    },
  };

  const older = session.executeBash("older", undefined, { operations });
  const newer = session.executeBash("newer", undefined, { operations });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);
  assert.equal(session.isBashRunning, true);

  pending[0]!.finish();
  await older;
  assert.equal(session.isBashRunning, true);
  assert.equal(pending[1]!.signal?.aborted, false);

  session.abortBash();
  assert.equal(pending[1]!.signal?.aborted, true);
  pending[1]!.finish();
  await assert.rejects(newer, /Shell command was cancelled/);
  assert.equal(session.isBashRunning, false);
  await session.close();
});

test("AgentSession aborts every concurrent bash command", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const session = await AgentSession.create(
    sessionOptions(SessionManager.inMemory(cwd, { id: "bash-overlap-abort" }), new ProviderRegistry([provider])),
  );
  const pending: Array<{
    signal: AbortSignal | undefined;
    finish(): void;
  }> = [];
  const operations: BashOperations = {
    async exec(_command, _cwd, options) {
      await new Promise<void>((resolve) => {
        pending.push({ signal: options.signal, finish: resolve });
      });
      if (options.signal?.aborted === true) throw new Error("aborted");
      return { exitCode: 0 };
    },
  };

  const executions = [
    session.executeBash("first", undefined, { operations }),
    session.executeBash("second", undefined, { operations }),
  ];
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);
  session.abortBash();
  assert.equal(pending.every(({ signal }) => signal?.aborted === true), true);
  for (const operation of pending) operation.finish();
  const results = await Promise.allSettled(executions);
  assert.equal(results.every((result) =>
    result.status === "rejected" && /Shell command was cancelled/.test(String(result.reason))), true);
  assert.equal(session.isBashRunning, false);
  await session.close();
});

test("AgentSession context stats estimate compacted messages before and after valid provider usage", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const providers = new ProviderRegistry([provider]);
  const manager = SessionManager.inMemory(cwd, { id: "context-stats" });
  const session = await AgentSession.create({
    ...sessionOptions(manager, providers),
    allowedToolNames: [],
  });
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
    toolDefinitionFingerprint: sessionV4JsonHash([]),
    usage: { inputTokens, outputTokens: 0, totalTokens: inputTokens },
    stopReason: "stop" as const,
  });

  manager.appendMessage(user("before-user", "before"));
  manager.appendMessage(assistant("before-assistant", 40_000));
  const kept = manager.appendMessage(user("kept-user", "kept"));
  manager.appendCompaction("summary", kept, 40_000);
  manager.appendMessage(user("after-user", "after"));
  manager.appendMessage(assistant("zero-assistant", 0));

  const projectedUsage = session.getContextUsage();
  assert.ok(projectedUsage?.tokens !== null && projectedUsage?.tokens !== undefined);
  assert.ok(projectedUsage.tokens > 0);
  assert.ok(projectedUsage.tokens < 40_000);
  assert.equal(projectedUsage.contextWindow, 200_000);
  assert.equal(projectedUsage.percent, (projectedUsage.tokens / 200_000) * 100);

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

test("AgentSession context usage uses prompt input as its baseline and estimates the completed response", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "context-prompt-usage" });
  manager.appendMessage({
    id: "context-prompt-user",
    role: "user",
    content: [{ type: "text", text: "request" }],
    createdAt: observedAt,
  });
  manager.appendMessage({
    id: "context-prompt-assistant",
    role: "assistant",
    content: [{ type: "text", text: "response" }],
    createdAt: observedAt,
    provider: provider.id,
    api: "openai-chat-completions",
    model: "one",
    stopReason: "stop",
    toolDefinitionFingerprint: sessionV4JsonHash([]),
    usage: { inputTokens: 25_000, outputTokens: 5_000, totalTokens: 30_000 },
  });
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    allowedToolNames: [],
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 200_000 },
  });

  const usage = session.getContextUsage();
  assert.ok(usage?.tokens !== null && usage?.tokens !== undefined);
  assert.ok(usage.tokens > 25_000);
  assert.ok(usage.tokens < 30_000);
  assert.equal(usage.contextWindow, 200_000);
  assert.equal(usage.percent, (usage.tokens / 200_000) * 100);
  assert.equal(usage.source, "estimated");
  assert.equal(usage.autoCompactionThresholdPercent, 85);
  await session.close();
});

test("AgentSession context usage invalidates an observed baseline when active tools change", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "context-active-tools" });
  manager.appendMessage({
    id: "context-active-tools-user",
    role: "user",
    content: [{ type: "text", text: "request" }],
    createdAt: observedAt,
  });
  manager.appendMessage({
    id: "context-active-tools-assistant",
    role: "assistant",
    content: [{ type: "text", text: "response" }],
    createdAt: observedAt,
    provider: provider.id,
    api: "openai-chat-completions",
    model: "one",
    stopReason: "stop",
    toolDefinitionFingerprint: sessionV4JsonHash([]),
    usage: { inputTokens: 25_000, outputTokens: 5_000, totalTokens: 30_000 },
  });
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    allowedToolNames: ["read"],
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 200_000 },
  });
  session.setActiveTools([]);

  const unchanged = session.getContextUsage();
  session.setActiveTools(["read"]);
  const changed = session.getContextUsage();

  assert.ok(unchanged?.tokens !== null && unchanged?.tokens !== undefined && unchanged.tokens > 25_000);
  assert.ok(changed?.tokens !== null && changed?.tokens !== undefined && changed.tokens < 10_000);
  assert.equal(changed?.source, "estimated");
  await session.close();
});

test("AgentSession retains a usage baseline only across a verified same-toolset failure", async (context) => {
  const currentFingerprint = sessionV4JsonHash([]);
  const contextTokens = async (suffix: string, fingerprint: string | undefined): Promise<number> => {
    const cwd = await workspace();
    const provider = new RecordingProvider();
    const manager = SessionManager.inMemory(cwd, { id: `failure-usage-${suffix}` });
    seedCompactableHistory(manager, provider, 20_000, currentFingerprint);
    manager.appendMessage({
      id: `failure-request-${suffix}`,
      role: "user",
      content: [{ type: "text", text: "retry" }],
      createdAt: observedAt,
    });
    manager.appendMessage({
      id: `failure-response-${suffix}`,
      role: "assistant",
      content: [{ type: "text", text: "" }],
      createdAt: observedAt,
      provider: provider.id,
      api: "openai-chat-completions",
      model: "one",
      stopReason: "error",
      ...(fingerprint === undefined ? {} : { toolDefinitionFingerprint: fingerprint }),
    });
    const session = await AgentSession.create({
      ...sessionOptions(manager, new ProviderRegistry([provider])),
      allowedToolNames: [],
    });
    await session.setModel({
      provider: provider.id,
      api: "openai-chat-completions",
      id: "one",
      info: { ...provider.models[0]!, contextTokens: 1_000_000 },
    });
    const tokens = session.getContextUsage()?.tokens;
    await session.close();
    assert.notEqual(tokens, null);
    assert.notEqual(tokens, undefined);
    return tokens!;
  };

  await context.test("same toolset", async () => {
    assert.ok(await contextTokens("same", currentFingerprint) > 10_000);
  });
  await context.test("changed toolset", async () => {
    assert.ok(await contextTokens("changed", "changed-tools") < 10_000);
  });
  await context.test("unverified toolset", async () => {
    assert.ok(await contextTokens("unverified", undefined) < 10_000);
  });
});

test("AgentSession context stats discard usage from a different selected model", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "context-stats-model-boundary" });
  manager.appendMessage({
    id: "model-boundary-user",
    role: "user",
    content: [{ type: "text", text: "short request" }],
    createdAt: observedAt,
  });
  manager.appendMessage({
    id: "model-boundary-assistant",
    role: "assistant",
    content: [{ type: "text", text: "short response" }],
    createdAt: observedAt,
    provider: provider.id,
    api: "openai-chat-completions",
    model: "one",
    stopReason: "stop",
    toolDefinitionFingerprint: sessionV4JsonHash([]),
    usage: { inputTokens: 50_000, outputTokens: 1, totalTokens: 50_001 },
  });
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    allowedToolNames: [],
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "two",
    info: { ...provider.models[1]!, contextTokens: 100_000 },
  });

  const usage = session.getContextUsage();

  assert.ok(usage?.tokens !== null && usage?.tokens !== undefined);
  assert.ok(usage.tokens < 1_000, `expected a fresh model projection, received ${usage.tokens}`);
  await session.close();
});

test("image projection changes discard a stale assistant usage baseline", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const providers = new ProviderRegistry([provider]);
  const manager = SessionManager.inMemory(cwd, { id: "image-usage-floor" });
  manager.appendMessage({
    id: "image-history",
    role: "user",
    content: [
      { type: "text", text: "inspect this image" },
      { type: "image", mediaType: "image/png", data: "private-image" },
    ],
    createdAt: observedAt,
  });
  manager.appendMessage({
    id: "image-history-response",
    role: "assistant",
    content: [{ type: "text", text: "previous response" }],
    createdAt: observedAt,
    provider: provider.id,
    api: "openai-chat-completions",
    model: "one",
    usage: { inputTokens: 50_000, outputTokens: 1, totalTokens: 50_001 },
    stopReason: "stop",
  });
  const session = await AgentSession.create({
    ...sessionOptions(manager, providers),
    outboundImages: "block",
    autoCompaction: false,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 20_000 },
  });

  await session.prompt("continue", { allowedTools: [] });

  assert.equal(provider.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(provider.requests[0]), /private-image/u);
  await session.close();
});

test("projection-only omissions before a valid usage checkpoint do not trigger early compaction", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const providers = new ProviderRegistry([provider]);
  const manager = SessionManager.inMemory(cwd, { id: "projected-usage-floor" });
  manager.appendMessage({
    id: "large-history",
    role: "user",
    content: [{ type: "text", text: "x".repeat(200_000) }],
    createdAt: observedAt,
  });
  manager.appendMessage({
    id: "aborted-history",
    role: "assistant",
    content: [{ type: "text", text: "" }],
    createdAt: observedAt,
    provider: provider.id,
    api: "openai-chat-completions",
    model: "one",
    stopReason: "aborted",
  });
  const session = await AgentSession.create(sessionOptions(manager, providers));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 1_000_000 },
  });
  await session.prompt("establish an observed usage checkpoint", { allowedTools: [] });
  assert.equal(provider.requests.length, 1);

  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 100_000 },
  });
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => { events.push(event); });

  await session.prompt("continue below the observed context threshold", { allowedTools: [] });

  assert.equal(provider.requests.length, 2);
  assert.equal(events.some((event) => event.type === "compaction_start"), false);
  await session.close();
});

test("a later zero-usage response cannot validate an older usage checkpoint against a changed tool set", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "usage-checkpoint-tool-boundary" });
  manager.appendMessage({
    id: "large-history",
    role: "user",
    content: [{ type: "text", text: "x".repeat(200_000) }],
    createdAt: observedAt,
  });
  manager.appendMessage({
    id: "observed-old-tools",
    role: "assistant",
    content: [{ type: "text", text: "observed response" }],
    createdAt: observedAt,
    provider: provider.id,
    api: "openai-chat-completions",
    model: "one",
    stopReason: "stop",
    toolDefinitionFingerprint: "old-tools",
    usage: { inputTokens: 20_000, outputTokens: 1, totalTokens: 20_001 },
  });
  manager.appendMessage({
    id: "zero-usage-user",
    role: "user",
    content: [{ type: "text", text: "request with changed tools" }],
    createdAt: observedAt,
  });
  manager.appendMessage({
    id: "zero-usage-new-tools",
    role: "assistant",
    content: [{ type: "text", text: "successful response without usage telemetry" }],
    createdAt: observedAt,
    provider: provider.id,
    api: "openai-chat-completions",
    model: "one",
    stopReason: "stop",
    toolDefinitionFingerprint: sessionV4JsonHash([]),
    providerState: {
      kind: "chat_completions",
      assistantMessage: { request: "zero-usage" },
      source: { provider: provider.id, model: "one", api: "openai-chat-completions" },
    },
  });
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    autoCompaction: false,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 100_000, maxOutputTokens: 16_000 },
  });

  const run = await session.prompt("current request", { allowedTools: [], autoCompaction: false });

  assert.equal(provider.requests.length, 0);
  assert.equal(run.results.at(-1)?.finishReason, "error");
  assert.match(run.results.at(-1)?.finalText ?? "", /Context exceeds its hard budget/u);
  await session.close();
});

test("post-response context accounting rejects a stale tool-set usage checkpoint", async () => {
  const cwd = await workspace();
  class NoUsageProvider extends RecordingProvider {
    override async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
      this.requests.push(structuredClone(request));
      yield { type: "response_start", model: request.model };
      yield { type: "text_delta", part: 0, text: "current answer without usage" };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: {} },
      };
    }
  }
  const provider = new NoUsageProvider();
  const manager = SessionManager.inMemory(cwd, { id: "postflight-tool-usage-boundary" });
  manager.appendMessage({
    id: "old-tool-user",
    role: "user",
    content: [{ type: "text", text: "short old prompt" }],
    createdAt: observedAt,
  });
  manager.appendMessage({
    id: "old-tool-assistant",
    role: "assistant",
    content: [{ type: "text", text: "short old answer" }],
    createdAt: observedAt,
    provider: provider.id,
    api: "openai-chat-completions",
    model: "one",
    stopReason: "stop",
    toolDefinitionFingerprint: "stale-tools",
    usage: { inputTokens: 9_800, outputTokens: 100, totalTokens: 9_900 },
  });
  manager.appendMessage({
    id: "new-tool-user",
    role: "user",
    content: [{ type: "text", text: "short changed-tool prompt" }],
    createdAt: observedAt,
  });
  manager.appendMessage({
    id: "new-tool-assistant",
    role: "assistant",
    content: [{ type: "text", text: "short changed-tool answer" }],
    createdAt: observedAt,
    provider: provider.id,
    api: "openai-chat-completions",
    model: "one",
    stopReason: "stop",
    toolDefinitionFingerprint: sessionV4JsonHash([]),
    providerState: {
      kind: "chat_completions",
      assistantMessage: {},
      source: { provider: provider.id, model: "one", api: "openai-chat-completions" },
    },
  });
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    allowedToolNames: [],
    compactionReserveTokens: 200,
    compactionRecentTokens: 200,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 10_000, maxOutputTokens: 1_000 },
  });
  const events: RuntimeEvent[] = [];
  session.onEvent((envelope) => { events.push(envelope.event); });

  const before = session.getContextUsage();
  const run = await session.prompt("current request", { allowedTools: [] });
  const after = session.getContextUsage();

  assert.ok(before?.tokens !== null && before?.tokens !== undefined && before.tokens < 8_500);
  assert.equal(run.results.at(-1)?.finishReason, "stop");
  assert.equal(provider.requests.length, 1);
  assert.equal(events.some((event) =>
    event.type === "warning" && event.code === "manual_compaction_skipped"), false);
  assert.equal(events.some((event) => event.type === "compaction_started"), false);
  assert.equal(manager.getEntries().some((entry) => entry.type === "compaction"), false);
  assert.ok(after?.tokens !== null && after?.tokens !== undefined && after.tokens < 8_500);
  await session.close();
});

test("AgentSession accepts public image content for prompts and queued input", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const session = await AgentSession.create(
    sessionOptions(SessionManager.inMemory(cwd, { id: "public-image-input" }), new ProviderRegistry([provider])),
  );
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });
  const image = { type: "image" as const, mimeType: "image/png", data: "AA==" };

  await session.prompt("inspect", { images: [image], allowedTools: [] });
  const promptImage = provider.requests[0]?.messages.flatMap((message) => message.content)
    .find((block) => block.type === "image");
  assert.deepEqual(promptImage, { type: "image", mediaType: "image/png", data: "AA==" });

  await session.steer("redirect", [image]);
  assert.deepEqual(session.dequeueMessage(), {
    mode: "steer",
    text: "redirect",
    images: [{ type: "image", mediaType: "image/png", data: "AA==" }],
  });
  await session.followUp("later", [image]);
  assert.deepEqual(session.dequeueMessage(), {
    mode: "follow_up",
    text: "later",
    images: [{ type: "image", mediaType: "image/png", data: "AA==" }],
  });
  await assert.rejects(
    session.prompt("invalid", { images: [{ ...image, data: "AA==\n" }] }),
    /prompt\.images\[0\].*base64/u,
  );

  let proxyTraps = 0;
  const proxyImage = new Proxy(Object.create(null) as object, {
    get() { proxyTraps += 1; throw new Error("get trap executed"); },
    has() { proxyTraps += 1; throw new Error("has trap executed"); },
    ownKeys() { proxyTraps += 1; throw new Error("ownKeys trap executed"); },
  });
  await assert.rejects(
    session.prompt("invalid proxy", { images: [proxyImage as never] }),
    /prompt\.images must not contain proxies/u,
  );
  assert.equal(proxyTraps, 0);

  let getterCalls = 0;
  const accessorImage: Record<string, unknown> = {
    type: "image",
    mimeType: "image/png",
  };
  Object.defineProperty(accessorImage, "data", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "AA==";
    },
  });
  await assert.rejects(
    session.prompt("invalid accessor", { images: [accessorImage as never] }),
    /prompt\.images must contain only enumerable data properties/u,
  );
  assert.equal(getterCalls, 0);
  await session.close();
});

test("AgentSession attaches exact prompt composition metadata to runs and before-agent events", async (context) => {
  const cwd = await workspace();
  const agentDir = join(cwd, "agent-home");
  const skillDir = join(cwd, "skills", "review");
  const systemPath = join(agentDir, "SYSTEM.md");
  const appendPath = join(agentDir, "APPEND_SYSTEM.md");
  const instructionsPath = join(cwd, "AGENTS.md");
  const skillPath = join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(systemPath, "private base prompt");
  await writeFile(appendPath, "private appended prompt");
  await writeFile(instructionsPath, "private project instructions");
  await writeFile(skillPath, "---\nname: review\ndescription: Review changes\n---\nPrivate skill body");

  let beforeAgentComposition: PromptCompositionMetadata | undefined;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    noSkills: true,
    additionalSkillPaths: [skillDir],
    extensionFactories: [{
      name: "composition-observer",
      factory(api) {
        api.on("before_agent_start", (event) => {
          beforeAgentComposition = event.promptComposition;
        });
      },
    }],
  });
  await loader.refresh();
  context.after(async () => await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close());

  const provider = new RecordingProvider();
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([provider])),
    resourceLoader: loader,
  });
  assert.equal(session.getPromptComposition(), undefined);
  let startedComposition: PromptCompositionMetadata | undefined;
  session.onEvent((envelope) => {
    if (envelope.event.type === "run_started") startedComposition = envelope.event.promptComposition;
  });
  await session.bindExtensions();
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });
  await session.prompt("inspect", { allowedTools: ["read"] });

  const composition = session.getPromptComposition();
  assert.ok(composition);
  assert.deepEqual(startedComposition, composition);
  assert.deepEqual(beforeAgentComposition, composition);
  assert.equal(composition.bytes, Buffer.byteLength(session.systemPrompt));
  assert.equal(
    composition.sha256,
    promptCompositionSource("system_prompt", "unused", session.systemPrompt).sha256,
  );
  assert.deepEqual(composition.tools, ["read"]);
  assert.deepEqual(composition.skills, [{ name: "review", manifestPath: skillPath }]);
  assert.deepEqual(composition.sources.map((entry) => [entry.kind, entry.source]), [
    ["system_prompt", systemPath],
    ["append_system_prompt", appendPath],
    ["instruction", instructionsPath],
  ]);
  assert.doesNotMatch(
    JSON.stringify(composition),
    /private base prompt|private appended prompt|private project instructions|Private skill body/u,
  );

  composition.tools.push("mutated");
  assert.deepEqual(session.getPromptComposition()?.tools, ["read"]);

  session.agent.state.systemPrompt = "private session override";
  assert.equal(session.getPromptComposition(), undefined);
  await session.prompt("inspect override", { allowedTools: ["read"] });
  const overrideComposition = session.getPromptComposition();
  assert.ok(overrideComposition);
  assert.deepEqual(overrideComposition.skills, []);
  assert.deepEqual(overrideComposition.sources.map((entry) => [entry.kind, entry.source]), [
    ["system_prompt", "agent-session:system-prompt-override"],
  ]);
  assert.doesNotMatch(JSON.stringify(overrideComposition), /AGENTS|SKILL/u);
  await session.close();
});

test("AgentSession owns the direct extension run, stream, message, and session lifecycle", async (context) => {
  const cwd = await workspace();
  const events: string[] = [];
  const provider = new LifecycleOrderProvider(events);
  const providers = new ProviderRegistry([provider]);
  const manager = SessionManager.inMemory(cwd, { id: "extension-session" });
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
        api.on("message_start", (event) => { events.push(`message_start:${event.message.role}`); });
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
    "message_start:assistant",
    "message_update",
    "message_end:assistant",
    "turn_end",
    "agent_end",
    "agent_settled",
  ]) assert.equal(events.includes(event), true, `missing ${event}: ${events.join(", ")}`);
  assert.ok(events.indexOf("before_agent_start") < events.indexOf("agent_start"));
  assert.ok(events.indexOf("provider_headers") < events.indexOf("provider_request"));
  assert.ok(events.indexOf("provider_request") < events.indexOf("provider_response"));
  assert.ok(events.indexOf("provider_response") < events.indexOf("message_start:assistant"));
  assert.ok(events.indexOf("turn_end") < events.indexOf("agent_end"));
  assert.equal(session.getLastAssistantText(), "extension-answer");
  await session.close();
});

test("direct tool_call listeners preserve the stable run lineage while built-in tools execute", async (context) => {
  const cwd = await workspace();
  await writeFile(join(cwd, "direct-tool-call.txt"), "direct tool call executed\n", "utf8");
  let listenerCalls = 0;
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "allow-builtins",
      factory(api) {
        api.on("tool_call", () => {
          listenerCalls += 1;
          return { block: false };
        });
      },
    }],
  });
  context.after(async () => await host.close());
  class DirectToolCallProvider extends RecordingProvider {
    override async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
      this.requests.push(structuredClone(request));
      yield { type: "response_start", model: request.model };
      if (this.requests.length === 1) {
        yield { type: "tool_call_start", index: 0, id: "direct-read", name: "read" };
        yield {
          type: "tool_call_end",
          index: 0,
          id: "direct-read",
          name: "read",
          rawArguments: '{"path":"direct-tool-call.txt"}',
          arguments: { path: "direct-tool-call.txt" },
        };
        yield {
          type: "response_end",
          reason: "tool_calls",
          state: { kind: "chat_completions", assistantMessage: { turn: 1 } },
        };
        return;
      }
      yield { type: "text_delta", part: 0, text: "complete" };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: { turn: 2 } },
      };
    }
  }
  const provider = new DirectToolCallProvider();
  const manager = SessionManager.inMemory(cwd, { id: "direct-tool-call-lineage" });
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    modelRegistry: await recordingModelRegistry(provider),
    extensionRunner: host,
    allowedToolNames: ["read"],
  });
  await session.bindExtensions();
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });
  const stableRunBranch = manager.getLeafId() ?? "root";

  const result = await session.prompt("read the fixture", { allowedTools: ["read"] });

  const toolResult = manager.getBranch().flatMap((entry) =>
    entry.type === "message" && entry.message.role === "tool"
      ? entry.message.content.filter((block) => block.type === "tool_result")
      : []).at(-1);
  assert.equal(listenerCalls, 1);
  assert.equal(toolResult?.isError, false);
  assert.match(toolResult?.content ?? "", /direct tool call executed/u);
  assert.equal(result.results.at(-1)?.finalText, "complete");
  await assert.rejects(
    host.reduceToolCall({
      threadId: session.sessionId,
      runId: "stale-run",
      branch: stableRunBranch,
      callId: "stale-call",
      name: "read",
      input: { path: "direct-tool-call.txt" },
      index: 0,
    }),
    /only exposes the current branch/u,
  );
  const abandonedLeaf = manager.getLeafId();
  const forkParent = manager.getBranch().at(-2)?.id;
  assert.ok(abandonedLeaf);
  assert.ok(forkParent);
  manager.branch(forkParent);
  manager.appendMessage({
    id: "direct-tool-call-sibling",
    role: "user",
    content: [{ type: "text", text: "sibling" }],
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  await assert.rejects(
    host.reduceToolCall({
      threadId: session.sessionId,
      runId: "abandoned-run",
      branch: abandonedLeaf,
      callId: "abandoned-call",
      name: "read",
      input: { path: "direct-tool-call.txt" },
      index: 0,
    }),
    /only exposes the current branch/u,
  );
  assert.equal(listenerCalls, 1);
  await session.close();
});

test("message_end usage replacements stay consistent across persistence, events, and stats", async (context) => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "message-end-usage" });
  const replacementCost = {
    input: 0.25,
    output: 0.5,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0.75,
  };
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "usage-owner",
      factory(api) {
        api.on("message_end", (event) => {
          if (event.message.role !== "assistant") return undefined;
          return {
            message: {
              ...event.message,
              usage: {
                ...event.message.usage,
                cost: replacementCost,
              },
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
  });
  await session.bindExtensions();
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => { events.push(event); });

  await session.prompt("price this response", { allowedTools: [] });

  const persisted = session.messages.findLast((message) => message.role === "assistant");
  assert.equal(
    persisted?.role === "assistant" ? persisted.usage?.cost?.total : undefined,
    replacementCost.total,
  );
  const publicEnd = events.findLast((event) => event.type === "message_end");
  assert.equal(
    publicEnd?.type === "message_end" && publicEnd.message.role === "assistant"
      ? publicEnd.message.usage.cost?.total
      : undefined,
    replacementCost.total,
  );
  assert.equal(session.getSessionStats().cost, replacementCost.total);
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
    session.messages.map((message) => message.role),
    ["user", "custom", "assistant"],
  );
  await session.close();
});

test("ordinary idle custom messages stay outside next-turn delivery bookkeeping", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "custom-idle-bounded" });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });

  for (let index = 0; index < 64; index += 1) {
    await session.sendCustomMessage({
      customType: "notice",
      content: `idle ${index}`,
      display: false,
      details: { index },
    });
  }
  await session.sendCustomMessage({
    customType: "carry",
    content: "next turn only",
    display: false,
    details: undefined,
  }, { deliverAs: "nextTurn" });

  await session.prompt("normal prompt", { allowedTools: [] });

  assert.equal(manager.getBranch().filter((entry) => entry.type === "custom_message").length, 65);
  assert.equal(provider.requests[0]!.messages.flatMap((message) => message.content).some(
    (block) => block.type === "text" && block.text === "next turn only",
  ), true);
  await session.close();
});

test("a cancelled run requeues an undelivered next-turn custom message", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "custom-next-turn-cancel" });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: "one", info: provider.models[0]! });
  await session.sendCustomMessage({
    customType: "carry",
    content: "survive cancellation",
    display: false,
    details: undefined,
  }, { deliverAs: "nextTurn" });
  const abort = new AbortController();
  abort.abort(new Error("cancel before dispatch"));

  await assert.rejects(
    session.prompt("cancelled prompt", { allowedTools: [], signal: abort.signal }),
    /cancel before dispatch/u,
  );
  assert.equal(manager.getBranch().some((entry) => entry.type === "custom_message"), false);

  await session.prompt("normal prompt", { allowedTools: [] });

  assert.equal(provider.requests[0]!.messages.flatMap((message) => message.content).some(
    (block) => block.type === "text" && block.text === "survive cancellation",
  ), true);
  assert.equal(manager.getBranch().filter((entry) => entry.type === "custom_message").length, 1);
  await session.close();
});

test("AgentSession cancels a prompt without inspecting a hostile abort reason", async () => {
  const cwd = await workspace();
  const provider = new GatedProvider();
  const session = await AgentSession.create(
    sessionOptions(SessionManager.inMemory(cwd, { id: "hostile-prompt-abort" }), new ProviderRegistry([provider])),
  );
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });
  let traps = 0;
  const reason = new Proxy(new Error("cancel prompt"), {
    getPrototypeOf() {
      traps += 1;
      throw new Error("prompt abort reason was inspected");
    },
  });
  const abort = new AbortController();
  const active = session.prompt("cancelled prompt", { allowedTools: [], signal: abort.signal });
  await provider.started;
  abort.abort(reason);
  provider.release();
  const result = await active;

  assert.equal(traps, 0);
  assert.equal(result.results.at(-1)?.finishReason, "cancelled");
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

test("AgentSession bindExtensions forwards host cancellation to startup listeners", async (context) => {
  const cwd = await workspace();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let listenerSignal: AbortSignal | undefined;
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "cancel-start",
      factory(api) {
        api.on("session_start", (_event, extensionContext) => {
          const activeSignal = extensionContext.signal;
          if (activeSignal === undefined) throw new Error("startup listener did not receive a signal");
          listenerSignal = activeSignal;
          markStarted();
          return new Promise<void>((_resolve, reject) => {
            const abort = () => reject(
              activeSignal.reason instanceof Error
                ? activeSignal.reason
                : new Error("startup cancelled"),
            );
            if (activeSignal.aborted) abort();
            else activeSignal.addEventListener("abort", abort, { once: true });
          });
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([new RecordingProvider()])),
    extensionRunner: host,
  });
  context.after(async () => await session.close());
  const controller = new AbortController();
  const binding = session.bindExtensions({ mode: "serve" }, controller.signal);
  await started;
  controller.abort(new Error("serve startup stopped"));

  await assert.rejects(binding, /serve startup stopped/u);
  assert.equal(listenerSignal?.aborted, true);
});

async function settleWithin<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

for (const action of ["abort", "close"] as const) {
  test(`AgentSession ${action} cancels an extension command preflight without hanging`, async (context) => {
    const cwd = await workspace();
    let markStarted!: () => void;
    let commandSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const host = await loadDirectExtensions([], {
      workspace: cwd,
      activationFailure: "throw",
      inlineExtensions: [{
        name: `${action}-preflight`,
        factory(api) {
          api.registerCommand("block-preflight", {
            handler(_args, commandContext) {
              commandSignal = commandContext.signal;
              markStarted();
              return new Promise<void>(() => {});
            },
          });
        },
      }],
    });
    context.after(async () => await host.close());
    const session = await AgentSession.create({
      ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([new RecordingProvider()])),
      extensionRunner: host,
    });
    await session.bindExtensions({ mode: "print" });

    const prompt = assert.rejects(
      session.prompt("/block-preflight"),
      action === "abort" ? /cancel preflight fixture/u : /AgentSession closed/u,
    );
    await started;
    await settleWithin(
      action === "abort" ? session.abort("cancel preflight fixture") : session.close(),
      `AgentSession ${action}`,
    );
    await settleWithin(prompt, "extension command prompt");
    assert.equal(commandSignal?.aborted, true);
    assert.equal(session.isIdle, true);
    if (action === "abort") await session.close();
  });
}

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
    getExtensions() { return extensionsResult; },
    getSkills() { return { skills: [], diagnostics: [] }; },
    getPrompts() { return { prompts: [], diagnostics: [] }; },
    getThemes() { return { themes: [], diagnostics: [] }; },
    getAgentsFiles() { return { agentsFiles: [] }; },
    getSystemPrompt() { return undefined; },
    getAppendSystemPrompt() { return []; },
    extendResources(paths) {
      lifecycle.push("extend");
      extended.push([
        ...(paths.skillPaths ?? []).map((entry) => entry.path),
        ...(paths.promptPaths ?? []).map((entry) => entry.path),
        ...(paths.themePaths ?? []).map((entry) => entry.path),
      ]);
    },
    async refresh() {},
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

test("AgentSession refresh swaps extension generations and routes later commands and events to the new host", async (context) => {
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
      name: "refresh-generation",
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
        api.registerFlag("refresh-value", { type: "string", default: "default" });
        api.registerCommand("generation", {
          async handler(_args, commandContext) {
            commands.push(`${current}:${commandContext.getSystemPromptOptions().cwd}`);
          },
        });
      },
    }],
  });
  await loader.refresh();
  context.after(async () => await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close());
  const initialHost = getExtensionRuntimeHost(loader.getExtensions().runtime)!;
  initialHost.setFlagValue("refresh-value", "preserved");
  const provider = new RecordingProvider();
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd),
    providers: new ProviderRegistry([provider]),
    settingsManager: settings,
    resourceLoader: loader,
    extensionRunner: initialHost,
  });
  const initialRunner = session.extensionRunner;
  assert.equal(initialRunner.getFlagValues().get("refresh-value"), "preserved");
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });
  await session.bindExtensions({ reason: "startup" });

  await session.prompt("/generation");
  await session.prompt("before refresh", { allowedTools: [] });
  await session.refresh({
    beforeSessionStart() {
      lifecycle.push("before-session-start");
    },
  });

  const refreshedHost = getExtensionRuntimeHost(loader.getExtensions().runtime)!;
  assert.notEqual(refreshedHost, initialHost);
  assert.notEqual(session.extensionRunner, initialRunner);
  assert.throws(() => initialRunner.createContext().isIdle(), /stale after AgentSession refresh/u);
  assert.equal(session.extensionRunner.getFlagValues().get("refresh-value"), "preserved");
  assert.equal(refreshedHost.flagValues().get("refresh-value"), "preserved");
  await session.prompt("/generation");
  assert.deepEqual(await session.prompt("intercept"), { sessionId: session.sessionId, results: [] });
  await session.prompt("after refresh", { allowedTools: [] });

  assert.equal(generation, 2);
  assert.deepEqual(lifecycle, [
    "1:activate",
    "1:start:startup",
    "1:shutdown:refresh",
    "2:activate",
    "before-session-start",
    "2:start:refresh",
  ]);
  assert.deepEqual(commands, [`1:${cwd}`, `2:${cwd}`]);
  assert.deepEqual(inputs, [2]);
  assert.deepEqual(agentStarts, [1, 2]);
  assert.equal(provider.requests.length, 2);
  const finalRunner = session.extensionRunner;
  await session.close();
  assert.throws(() => finalRunner.createContext().isIdle(), /stale after AgentSession close/u);
});

test("AgentSession disables a committed generation when session_start is cancelled and recovers only from a fresh generation", {
  timeout: 10_000,
}, async (context) => {
  const cwd = await workspace();
  const agentDir = join(cwd, "agent-home");
  const settings = SettingsManager.inMemory();
  for (const generation of [1, 2, 3]) {
    await writeFile(join(cwd, `dynamic-${generation}.md`), `Dynamic ${generation}\n`);
  }
  const providerConfig = (generation: number, kind = "generation") => ({
    name: `${kind} ${generation}`,
    baseUrl: "https://example.test/v1",
    apiKey: "fixture-key",
    api: "openai-chat-completions" as const,
    models: [{
      id: `${kind}-model-${generation}`,
      name: `${kind} model ${generation}`,
      reasoning: false,
      input: ["text"] as ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4_096,
      maxTokens: 512,
    }],
  });
  const registerTool = (
    api: ExtensionAPI,
    name: string,
  ): void => {
    api.registerTool({
      name,
      label: name,
      description: `${name} fixture`,
      parameters: { type: "object", properties: {}, additionalProperties: false } as never,
      async execute() {
        return { content: [{ type: "text", text: name }], details: {} };
      },
    });
  };
  let generation = 0;
  let markFailedStart!: () => void;
  const failedStart = new Promise<void>((resolve) => { markFailedStart = resolve; });
  const starts: string[] = [];
  const commands: number[] = [];
  let failedContext: RuntimeExtensionListenerContext | undefined;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{
      name: "incomplete-generation",
      factory(api) {
        const current = ++generation;
        registerTool(api, `generation_${current}_tool`);
        api.registerCommand(`generation-${current}`, {
          async handler() { commands.push(current); },
        });
        api.registerProvider(`generation-provider-${current}`, providerConfig(current));
        api.on("resources_discover", () => ({
          promptPaths: [`dynamic-${current}.md`],
        }));
        api.on("session_start", async (event, extensionContext) => {
          starts.push(`${current}:${event.reason}`);
          if (current !== 2) return;
          failedContext = extensionContext;
          registerTool(api, "partial_generation_2_tool");
          api.registerCommand("partial-generation-2", {
            async handler() { commands.push(200); },
          });
          api.registerProvider("partial-provider-2", providerConfig(2, "partial"));
          markFailedStart();
          await new Promise<void>(() => {});
        });
      },
    }],
  });
  await loader.refresh();
  context.after(async () => await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close());
  const provider = new RecordingProvider();
  const providers = new ProviderRegistry([provider]);
  const modelRegistry = await recordingModelRegistry(provider);
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd),
    providers,
    modelRegistry,
    settingsManager: settings,
    resourceLoader: loader,
  });
  context.after(async () => await session.close());
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });
  const extensionErrors: string[] = [];
  await session.bindExtensions({
    mode: "print",
    onError(error) { extensionErrors.push(error.error); },
  });

  assert.equal(session.getTools().some((tool) => tool.definition.name === "generation_1_tool"), true);
  assert.equal(loader.getPrompts().prompts.some((prompt) => prompt.name === "dynamic-1"), true);
  await session.prompt("/generation-1");
  assert.deepEqual(commands, [1]);

  const controller = new AbortController();
  let failedRunner: ExtensionRunner | undefined;
  const refresh = assert.rejects(
    session.refresh({
      signal: controller.signal,
      beforeSessionStart() {
        failedRunner = session.extensionRunner;
      },
    }),
    /cancel incomplete generation/u,
  );
  await failedStart;
  controller.abort(new Error("cancel incomplete generation"));
  await refresh;

  const incompleteRunner = failedRunner;
  assert.ok(incompleteRunner);
  assert.throws(
    () => incompleteRunner.createContext().isIdle(),
    /incomplete after session_start failed/u,
  );
  assert.throws(
    () => session.extensionRunner,
    /did not finish starting.*fresh generation/u,
  );
  assert.equal(session.hasExtensionHandlers("session_start"), false);
  const toolNames = session.getTools().map((tool) => tool.definition.name);
  assert.equal(toolNames.includes("read"), true);
  assert.equal(toolNames.includes("bash"), true);
  assert.equal(toolNames.some((name) => name.includes("generation_2")), false);
  assert.equal(providers.has("generation-provider-2"), false);
  assert.equal(providers.has("partial-provider-2"), false);
  assert.equal(modelRegistry.find("generation-provider-2", "generation-model-2"), undefined);
  assert.equal(modelRegistry.find("partial-provider-2", "partial-model-2"), undefined);
  assert.equal(loader.getPrompts().prompts.some((prompt) => prompt.name === "dynamic-2"), false);
  assert.throws(() => failedContext?.isIdle(), /Runtime extension host is closed/u);
  const failedHost = getExtensionRuntimeHost(loader.getExtensions().runtime)!;
  const errorCount = extensionErrors.length;
  failedHost.addDiagnostic({
    extensionId: "detached-generation",
    sourcePath: "",
    message: "must not reach the session",
  });
  assert.equal(extensionErrors.length, errorCount);

  await session.bindExtensions({ reason: "refresh" });
  assert.deepEqual(starts, ["1:startup", "2:refresh"]);
  const requestsBeforeDisabledCommand = provider.requests.length;
  await session.prompt("/generation-2", { allowedTools: [] });
  assert.equal(provider.requests.length, requestsBeforeDisabledCommand + 1);
  assert.deepEqual(commands, [1]);

  await session.refresh();

  assert.equal(generation, 3);
  assert.deepEqual(starts, ["1:startup", "2:refresh", "3:refresh"]);
  assert.equal(session.extensionRunner.createContext().isIdle(), true);
  assert.equal(session.getTools().some((tool) => tool.definition.name === "generation_3_tool"), true);
  assert.equal(providers.has("generation-provider-3"), true);
  assert.equal(modelRegistry.find("generation-provider-3", "generation-model-3")?.id, "generation-model-3");
  assert.equal(loader.getPrompts().prompts.some((prompt) => prompt.name === "dynamic-2"), false);
  assert.equal(loader.getPrompts().prompts.some((prompt) => prompt.name === "dynamic-3"), true);
  const requestsBeforeRecoveredCommand = provider.requests.length;
  await session.prompt("/generation-3");
  assert.equal(provider.requests.length, requestsBeforeRecoveredCommand);
  assert.deepEqual(commands, [1, 3]);
});

test("AgentSession refresh aborts a staged resource generation without committing it", { timeout: 10_000 }, async (context) => {
  const cwd = await workspace();
  let shutdownSignal: AbortSignal | undefined;
  const initialHost = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "refresh-abort-initial",
      factory(api) {
        api.on("session_shutdown", (_event, extensionContext) => {
          shutdownSignal = extensionContext.signal;
        });
      },
    }],
  });
  const candidateHost = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{ name: "refresh-abort-candidate", factory() {} }],
  });
  context.after(async () => {
    await candidateHost.close();
    await initialHost.close();
  });
  const initialResult = projectLoadedExtensionHost(initialHost);
  const candidateResult = projectLoadedExtensionHost(candidateHost);
  let published = initialResult;
  let commits = 0;
  let refreshSignal: AbortSignal | undefined;
  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
  const loader = {
    supportsTransactionalRefresh: true as const,
    getExtensions: () => published,
    getSkills() { return { skills: [], diagnostics: [] }; },
    getPrompts() { return { prompts: [], diagnostics: [] }; },
    getThemes() { return { themes: [], diagnostics: [] }; },
    getAgentsFiles() { return { agentsFiles: [] }; },
    getSystemPrompt() { return undefined; },
    getAppendSystemPrompt() { return []; },
    extendResources() {},
    async refresh(options = {}) {
      refreshSignal = options.signal;
      const prepared = options.prepareExtensions?.(candidateResult);
      const rollback = typeof prepared === "function" ? prepared : undefined;
      markRefreshStarted();
      try {
        await new Promise<void>((_resolve, reject) => {
          if (options.signal === undefined) return;
          const rejectAbort = (): void => reject(options.signal?.reason);
          if (options.signal.aborted) rejectAbort();
          else options.signal.addEventListener("abort", rejectAbort, { once: true });
        });
      } catch (error) {
        rollback?.();
        throw error;
      }
      published = candidateResult;
      commits += 1;
    },
  } satisfies ResourceLoader;
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([new RecordingProvider()])),
    resourceLoader: loader,
    extensionRunner: initialHost,
  });
  const initialRunner = session.extensionRunner;
  await session.bindExtensions({ reason: "startup" });
  const controller = new AbortController();
  const refresh = assert.rejects(
    session.refresh({ signal: controller.signal }),
    /cancel refresh fixture/u,
  );

  await refreshStarted;
  controller.abort(new Error("cancel refresh fixture"));
  await settleWithin(refresh, "AgentSession refresh cancellation");

  assert.equal(refreshSignal, controller.signal);
  assert.equal(shutdownSignal?.aborted, false);
  assert.equal(commits, 0);
  assert.equal(loader.getExtensions(), initialResult);
  assert.equal(session.extensionRunner, initialRunner);
  await session.close();
});

test("AgentSession refresh keeps the active runner when resources republish the same runtime", async () => {
  const cwd = await workspace();
  const settings = SettingsManager.inMemory();
  const lifecycle: string[] = [];
  let generation = 0;
  let stable: ReturnType<DefaultResourceLoader["getExtensions"]> | undefined;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, "agent-home"),
    settingsManager: settings,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{
      name: "stable-runtime",
      factory(api) {
        const current = ++generation;
        lifecycle.push(`${current}:activate`);
        api.on("session_start", (event) => { lifecycle.push(`${current}:start:${event.reason}`); });
        api.on("session_shutdown", (event) => { lifecycle.push(`${current}:shutdown:${event.reason}`); });
        api.onDispose(() => { lifecycle.push(`${current}:dispose`); });
      },
    }],
    extensionsOverride(base) {
      if (stable === undefined) {
        stable = base;
        return base;
      }
      return {
        ...stable,
        errors: [...stable.errors, { path: "<override>", error: "updated diagnostics" }],
      };
    },
  });
  await loader.refresh();
  const initialResult = loader.getExtensions();
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([new RecordingProvider()])),
    settingsManager: settings,
    resourceLoader: loader,
  });
  await session.bindExtensions({ reason: "startup" });
  const initialRunner = session.extensionRunner;

  await session.refresh();

  assert.notEqual(loader.getExtensions(), initialResult);
  assert.equal(loader.getExtensions().runtime, initialResult.runtime);
  assert.equal(session.extensionRunner, initialRunner);
  assert.equal(initialRunner.createContext().isIdle(), true);
  assert.deepEqual(lifecycle, [
    "1:activate",
    "1:start:startup",
    "1:shutdown:refresh",
    "2:activate",
    "2:dispose",
    "1:start:refresh",
  ]);
  await session.close();
});

test("AgentSession rejects a changed projection on the active runtime without closing it", async () => {
  const cwd = await workspace();
  const settings = SettingsManager.inMemory();
  const lifecycle: string[] = [];
  let generation = 0;
  let stable: ReturnType<DefaultResourceLoader["getExtensions"]> | undefined;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, "agent-home"),
    settingsManager: settings,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{
      name: "changed-projection",
      factory(api) {
        const current = ++generation;
        lifecycle.push(`${current}:activate`);
        api.on("session_start", (event) => { lifecycle.push(`${current}:start:${event.reason}`); });
        api.on("session_shutdown", (event) => { lifecycle.push(`${current}:shutdown:${event.reason}`); });
        api.onDispose(() => { lifecycle.push(`${current}:dispose`); });
      },
    }],
    extensionsOverride(base) {
      if (stable === undefined) {
        stable = base;
        return base;
      }
      return { ...stable, extensions: [] };
    },
  });
  await loader.refresh();
  const initialResult = loader.getExtensions();
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([new RecordingProvider()])),
    settingsManager: settings,
    resourceLoader: loader,
  });
  await session.bindExtensions({ reason: "startup" });
  const initialRunner = session.extensionRunner;

  await assert.rejects(
    session.refresh(),
    /cannot change the extension projection without a new runtime generation/u,
  );

  assert.equal(loader.getExtensions(), initialResult);
  assert.equal(session.extensionRunner, initialRunner);
  assert.equal(initialRunner.createContext().isIdle(), true);
  assert.deepEqual(lifecycle, [
    "1:activate",
    "1:start:startup",
    "1:shutdown:refresh",
    "2:activate",
    "2:dispose",
    "1:start:refresh",
  ]);
  await session.close();
});

test("AgentSession refresh atomically adds, removes, and replaces direct providers", async (context) => {
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
  await loader.refresh();
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

  await session.refresh();

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

test("direct provider install removes its adapter when display-name binding fails", async (context) => {
  const cwd = await workspace();
  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, "agent-home"),
    settingsManager: settings,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{
      name: "provider-display-failure",
      factory(api) {
        api.registerProvider("display-failure-provider", {
          name: "Display failure provider",
          baseUrl: "https://example.test/v1",
          apiKey: "fixture-key",
          api: "openai-chat-completions",
          models: [{
            id: "display-failure-model",
            name: "Display failure model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4_096,
            maxTokens: 512,
          }],
        });
      },
    }],
  });
  await loader.refresh();
  context.after(async () => await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close());
  const providers = new ProviderRegistry();
  const modelRegistry = new ModelRegistry(createModels());
  const displayFailure = new Error("display-name binding failed");

  await assert.rejects(AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd),
    providers,
    modelRegistry,
    settingsManager: settings,
    resourceLoader: loader,
    providerDisplayNameOverride() {
      throw displayFailure;
    },
  }), (error) => error === displayFailure);

  assert.equal(providers.has("display-failure-provider"), false);
  assert.equal(modelRegistry.find("display-failure-provider", "display-failure-model"), undefined);
});

test("direct provider replacement refreshes selected metadata during its live run", async (context) => {
  const cwd = await workspace();
  const fixture = directProvider("live-provider-refresh", "live-model", "live response");
  const replacement = directProvider("live-provider-refresh", "live-model", "replacement response");
  replacement.config.models![0]!.maxTokens = 1_024;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let releaseStream!: () => void;
  const released = new Promise<void>((resolve) => { releaseStream = resolve; });
  fixture.config.streamSimple = (selected) => {
    const stream = createAssistantMessageEventStream();
    markStarted();
    void released.then(() => {
      const counters = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "live response" }],
        api: selected.api,
        provider: selected.provider,
        model: selected.id,
        usage: {
          ...counters,
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
  let replaceProvider!: () => void;
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "live-provider-refresh",
      factory(api) {
        api.registerProvider(fixture.id, fixture.config);
        replaceProvider = () => { api.registerProvider(replacement.id, replacement.config); };
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd),
    providers: new ProviderRegistry(),
    modelRegistry: new ModelRegistry(createModels()),
    settingsManager: SettingsManager.inMemory(),
    extensionRunner: host,
  });
  context.after(async () => await session.close());
  await session.setModel(fixture.model);
  assert.equal(session.nativeModel?.info?.maxOutputTokens, 512);

  const running = session.prompt("hold the provider request", { allowedTools: [] });
  await started;
  replaceProvider();
  assert.equal(session.nativeModel?.info?.maxOutputTokens, 1_024);
  releaseStream();
  assert.equal((await running).results.at(-1)?.finalText, "live response");
});

test("session_start context surfaces and providers expire across refresh generations", async (context) => {
  const cwd = await workspace();
  const agentDir = join(cwd, "agent-home");
  const settings = SettingsManager.inMemory();
  const capturedRegistries: ExtensionModelRegistry[] = [];
  const capturedContexts: Array<{
    context: RuntimeExtensionListenerContext;
    directCalls: Array<() => unknown>;
    sessionCall: () => string;
    modelCall: () => Model<Api>[];
    asyncModelCall: () => Promise<void>;
    uiCall: () => void;
  }> = [];
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
          const notify = extensionContext.ui.notify;
          capturedContexts.push({
            context: extensionContext,
            directCalls: [
              extensionContext.isProjectTrusted,
              extensionContext.isIdle,
              extensionContext.hasPendingMessages,
              extensionContext.abort,
              extensionContext.shutdown,
              extensionContext.getContextUsage,
              extensionContext.compact,
              extensionContext.getSystemPrompt,
            ],
            sessionCall: extensionContext.sessionManager.getSessionId,
            modelCall: extensionContext.modelRegistry.getAll,
            asyncModelCall: extensionContext.modelRegistry.refresh,
            uiCall: () => notify("stale generation"),
          });
          extensionContext.modelRegistry.registerProvider(fixture.id, fixture.config);
          const selected = extensionContext.modelRegistry.find(fixture.id, fixture.model.id);
          selectedModels.push(selected !== undefined && await api.setModel(selected));
        });
      },
    }],
  });
  await loader.refresh();
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

  await session.refresh();

  assert.deepEqual(selectedModels, [true, true]);
  assert.equal(providers.has("context-provider-1"), false);
  assert.equal(modelRegistry.find("context-provider-1", "context-model-1"), undefined);
  assert.equal(providers.has("context-provider-2"), true);
  assert.equal(session.model?.id, "context-model-2");
  assert.equal((await session.prompt("second", { allowedTools: [] })).results.at(-1)?.finalText, "context-response-2");
  const stalePattern = /no longer active|host is closed|stale after AgentSession refresh/u;
  const firstContext = capturedContexts[0]!;
  for (const call of firstContext.directCalls) assert.throws(call, stalePattern);
  assert.throws(firstContext.sessionCall, stalePattern);
  assert.throws(firstContext.modelCall, stalePattern);
  await assert.rejects(async () => await firstContext.asyncModelCall(), stalePattern);
  assert.throws(firstContext.uiCall, stalePattern);
  assert.throws(() => firstContext.context.ui.theme, stalePattern);
  const stale = directProvider("stale-context-provider", "stale-context-model", "stale");
  assert.throws(
    () => capturedRegistries[0]!.registerProvider(stale.id, stale.config),
    stalePattern,
  );

  await session.close();
  assert.equal(providers.has("context-provider-2"), false);
  assert.equal(modelRegistry.find("context-provider-2", "context-model-2"), undefined);
  const closedContext = capturedContexts[1]!;
  assert.throws(closedContext.directCalls[1]!, stalePattern);
  assert.throws(closedContext.sessionCall, stalePattern);
  assert.throws(closedContext.modelCall, stalePattern);
  await assert.rejects(async () => await closedContext.asyncModelCall(), stalePattern);
  assert.throws(closedContext.uiCall, stalePattern);
  await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close();
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

test("AgentSession refresh rolls back every provider from a partially activated generation", async (context) => {
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
  await loader.refresh();
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
  const previousRuntime = loader.getExtensions().runtime;
  const previousRunner = session.extensionRunner;
  assert.equal(providers.has("previous-provider"), true);

  await assert.rejects(session.refresh(), /cannot exceed 1 adapters/u);

  assert.equal(providers.has("candidate-one"), false);
  assert.equal(providers.has("candidate-two"), false);
  assert.equal(providers.has("previous-provider"), true);
  assert.equal(modelRegistry.find("previous-provider", "previous-model")?.id, "previous-model");
  assert.equal(modelRegistry.find("candidate-one", "candidate-one-model"), undefined);
  assert.equal(modelRegistry.find("candidate-two", "candidate-two-model"), undefined);
  assert.equal(loader.getExtensions().runtime, previousRuntime);
  assert.equal(session.extensionRunner, previousRunner);
  await session.close();
});

test("AgentSession rejects an invalid extension projection before resource publication", async (context) => {
  const cwd = await workspace();
  const agentDir = join(cwd, "agent-home");
  const settings = SettingsManager.inMemory();
  const lifecycle: string[] = [];
  let generation = 0;
  let originalExtensions: ReturnType<DefaultResourceLoader["getExtensions"]>["extensions"] | undefined;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{
      name: "projection-generation",
      factory(api) {
        const current = ++generation;
        lifecycle.push(`${current}:activate`);
        api.on("session_start", (event) => { lifecycle.push(`${current}:start:${event.reason}`); });
        api.on("session_shutdown", (event) => { lifecycle.push(`${current}:shutdown:${event.reason}`); });
        api.onDispose(() => { lifecycle.push(`${current}:dispose`); });
      },
    }],
    extensionsOverride(base) {
      if (originalExtensions === undefined) {
        originalExtensions = base.extensions;
        return base;
      }
      return { ...base, extensions: originalExtensions };
    },
  });
  await loader.refresh();
  context.after(async () => await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close());
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([new RecordingProvider()])),
    settingsManager: settings,
    resourceLoader: loader,
  });
  await session.bindExtensions({ reason: "startup" });
  const originalRuntime = loader.getExtensions().runtime;
  const originalRunner = session.extensionRunner;

  await assert.rejects(session.refresh(), /Extension projection belongs to another host generation/u);

  assert.equal(loader.getExtensions().runtime, originalRuntime);
  assert.equal(session.extensionRunner, originalRunner);
  assert.equal(originalRunner.createContext().isIdle(), true);
  assert.deepEqual(lifecycle, [
    "1:activate",
    "1:start:startup",
    "1:shutdown:refresh",
    "2:activate",
    "2:dispose",
    "1:start:refresh",
  ]);
  await session.close();
});

test("AgentSession rejects a legacy loader before it can publish an unprepared extension generation", async (context) => {
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
  const initialExtensionsResult = extensionsResult;
  let refreshCalls = 0;
  const loader = {
    getExtensions() { return extensionsResult; },
    getSkills() { return { skills: [], diagnostics: [] }; },
    getPrompts() { return { prompts: [], diagnostics: [] }; },
    getThemes() { return { themes: [], diagnostics: [] }; },
    getAgentsFiles() { return { agentsFiles: [] }; },
    getSystemPrompt() { return undefined; },
    getAppendSystemPrompt() { return []; },
    extendResources() {},
    async refresh() {
      refreshCalls += 1;
      extensionsResult = projectLoadedExtensionHost(candidateHost);
    },
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
  const previousRunner = session.extensionRunner;
  assert.equal(providers.has("previous-provider"), true);

  await assert.rejects(session.refresh(), /does not support transactional refresh/u);

  assert.equal(refreshCalls, 0);
  assert.equal(loader.getExtensions(), initialExtensionsResult);
  assert.equal(getExtensionRuntimeHost(loader.getExtensions().runtime), previousHost);
  assert.equal(session.extensionRunner, previousRunner);
  assert.equal(providers.has("previous-provider"), true);
  assert.equal(modelRegistry.find("previous-provider", "previous-model")?.id, "previous-model");
  assert.equal(providers.has("candidate-one"), false);
  assert.equal(providers.has("candidate-two"), false);
  await session.close();
});

test("AgentSession refresh restarts the current extension host when resource loading fails", async (context) => {
  const cwd = await workspace();
  const settingsStorage = new InMemorySettingsStorage();
  settingsStorage.withLock("global", () => JSON.stringify({
    retry: { provider: { timeoutMs: 100 } },
  }));
  const settings = SettingsManager.fromStorage(settingsStorage);
  const lifecycle: string[] = [];
  const commands: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "refresh-recovery",
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
    supportsTransactionalRefresh: true as const,
    getExtensions() { return extensionsResult; },
    getSkills() { return { skills: [], diagnostics: [] }; },
    getPrompts() { return { prompts: [], diagnostics: [] }; },
    getThemes() { return { themes: [], diagnostics: [] }; },
    getAgentsFiles() { return { agentsFiles: [] }; },
    getSystemPrompt() { return undefined; },
    getAppendSystemPrompt() { return []; },
    extendResources() {},
    async refresh() { throw new Error("refresh fixture failed"); },
  } satisfies ResourceLoader;
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([new RecordingProvider()])),
    settingsManager: settings,
    resourceLoader: loader,
    extensionRunner: host,
  });
  const initialRunner = session.extensionRunner;
  await session.bindExtensions({ reason: "startup" });

  settingsStorage.withLock("global", () => JSON.stringify({
    retry: { provider: { timeoutMs: 200 } },
  }));
  await assert.rejects(session.refresh(), /refresh fixture failed/u);

  assert.equal(session.extensionRunner, initialRunner);
  assert.equal(settings.getProviderRetrySettings().timeoutMs, 100);
  assert.equal(session.agent.timeoutMs, 100);
  assert.equal(initialRunner.createContext().isIdle(), true);
  assert.deepEqual(lifecycle, ["start:startup", "shutdown:refresh", "start:refresh"]);
  assert.deepEqual(await session.prompt("/recovered"), { sessionId: session.sessionId, results: [] });
  assert.deepEqual(commands, ["handled"]);
  await session.close();
});

test("AgentSession refresh uses one validated settings snapshot with the default resource loader", async () => {
  const cwd = await workspace();
  const agentDir = join(cwd, "agent-home");
  const storage = new InMemorySettingsStorage();
  storage.withLock("global", () => JSON.stringify({ retry: { provider: { timeoutMs: 100 } } }));
  const settings = SettingsManager.fromStorage(storage, { projectTrusted: false });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.refresh();
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([new RecordingProvider()])),
    settingsManager: settings,
    resourceLoader: loader,
  });
  const originalRefresh = settings.refresh.bind(settings);
  let redundantRefreshes = 0;
  settings.refresh = async (options) => {
    redundantRefreshes += 1;
    await originalRefresh(options);
  };
  storage.withLock("global", () => JSON.stringify({ retry: { provider: { timeoutMs: 200 } } }));

  await session.refresh();

  assert.equal(redundantRefreshes, 0);
  assert.equal(settings.getProviderRetrySettings().timeoutMs, 200);
  assert.equal(session.agent.timeoutMs, 200);
  const activeRuntime = loader.getExtensions().runtime;
  const activeRunner = session.extensionRunner;
  storage.withLock("global", () => JSON.stringify({
    tools: "bad",
    retry: { provider: { timeoutMs: 300 } },
  }));
  await assert.rejects(session.refresh(), /settings\.tools must be an object/iu);
  assert.equal(loader.getExtensions().runtime, activeRuntime);
  assert.equal(session.extensionRunner, activeRunner);
  assert.equal(settings.getProviderRetrySettings().timeoutMs, 200);
  assert.equal(session.agent.timeoutMs, 200);
  await session.close();
});

test("AgentSession does not suppress a distinct resource loader settings manager", async () => {
  const cwd = await workspace();
  const agentDir = join(cwd, "agent-home");
  const loaderSettings = SettingsManager.inMemory({}, { projectTrusted: false });
  const sessionSettings = SettingsManager.inMemory({}, { projectTrusted: false });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: loaderSettings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.refresh();
  const originalLoaderRefresh = loaderSettings.refresh.bind(loaderSettings);
  let loaderSettingsRefreshes = 0;
  loaderSettings.refresh = async (options) => {
    loaderSettingsRefreshes += 1;
    await originalLoaderRefresh(options);
  };
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([new RecordingProvider()])),
    settingsManager: sessionSettings,
    resourceLoader: loader,
  });

  await session.refresh();

  assert.equal(loaderSettingsRefreshes, 1);
  await session.close();
});

test("AgentSession keeps settings coherent when a post-resource refresh hook fails", async () => {
  const cwd = await workspace();
  const agentDir = join(cwd, "agent-home");
  const storage = new InMemorySettingsStorage();
  storage.withLock("global", () => JSON.stringify({ retry: { provider: { timeoutMs: 100 } } }));
  const settings = SettingsManager.fromStorage(storage, { projectTrusted: false });
  let starts = 0;
  let discoveries = 0;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{
      name: "committed-refresh-recovery",
      factory(api) {
        api.on("session_start", () => { starts += 1; });
        api.on("resources_discover", () => { discoveries += 1; });
      },
    }],
  });
  await loader.refresh();
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([new RecordingProvider()])),
    settingsManager: settings,
    resourceLoader: loader,
  });
  await session.bindExtensions({ reason: "startup" });
  const initialRuntime = loader.getExtensions().runtime;
  const initialRunner = session.extensionRunner;
  storage.withLock("global", () => JSON.stringify({ retry: { provider: { timeoutMs: 200 } } }));

  await assert.rejects(session.refresh({
    beforeSessionStart() { throw new Error("UI refresh failed"); },
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /refresh committed/iu);
    assert.equal((error.errors[0] as Error).message, "UI refresh failed");
    return true;
  });

  assert.notEqual(loader.getExtensions().runtime, initialRuntime);
  assert.notEqual(session.extensionRunner, initialRunner);
  assert.equal(settings.getProviderRetrySettings().timeoutMs, 200);
  assert.equal(session.agent.timeoutMs, 200);
  assert.equal(session.extensionRunner.createContext().isIdle(), true);
  assert.equal(starts, 2);
  assert.equal(discoveries, 2);
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
  await loader.refresh();
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
    /A run is in progress\. Set streamingBehavior to 'steer' or 'followUp' to enqueue this prompt\./u,
  );
  await assert.rejects(
    session.agent.prompt([{
      role: "user",
      content: [{ type: "text", text: "batch while active" }],
      timestamp: Date.now(),
    }]),
    /A prompt is in progress\. Queue with steer\(\) or followUp\(\), or wait until the run settles\./u,
  );
  assert.deepEqual(await session.prompt("/probe while-active"), { sessionId: session.sessionId, results: [] });
  await assert.rejects(
    session.steer("/probe queued-command"),
    /Queued input cannot invoke extension command "\/probe"/u,
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

test("extension-origin queued slash follow-ups remain raw model input", async (context) => {
  const cwd = await workspace();
  const provider = new GatedProvider();
  const commands: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "queued-slash",
      factory(api) {
        api.registerCommand("probe", {
          async handler(args) {
            commands.push(args);
          },
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([provider])),
    extensionRunner: host,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });

  const active = session.prompt("first", { allowedTools: [] });
  await provider.started;
  await session.sendUserMessage("/probe queued", { deliverAs: "followUp" });
  provider.release();
  await active;

  const latestUserText = (request: ProviderRequest): string | undefined => request.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .at(-1);
  assert.deepEqual(commands, []);
  assert.deepEqual(provider.requests.map(latestUserText), ["first", "/probe queued"]);
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

test("AgentSession requeues cancelled active input in durable FIFO order", async () => {
  const cwd = await workspace();
  const provider = new GatedProvider();
  const manager = SessionManager.inMemory(cwd, { id: "cancelled-active-queue" });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });

  const active = session.prompt("first", { allowedTools: [] });
  await provider.started;
  await session.followUp("first queued");
  await session.steer("second queued");
  const queuedIds = [...manager.getV4State().queue.values()].map((entry) => entry.id);
  assert.equal(queuedIds.length, 2);

  const aborted = session.abort("cancel active run");
  provider.release();
  await aborted;
  const run = await active;

  assert.equal(run.results.at(-1)?.finishReason, "cancelled");
  assert.deepEqual(session.getQueuedMessages().map((message) => message.text), [
    "first queued",
    "second queued",
  ]);
  assert.deepEqual([...manager.getV4State().queue.values()].map((entry) => ({
    id: entry.id,
    status: entry.status,
    operationId: entry.operationId,
  })), queuedIds.map((id) => ({ id, status: "queued", operationId: null })));
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
    compactionRecentTokens: 200,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 10_000 },
  });
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => { events.push(event); });
  let releaseDelayedEntry!: () => void;
  const delayedEntry = new Promise<void>((resolve) => { releaseDelayedEntry = resolve; });
  let resolveDelayedContext!: (tokens: number | null | undefined) => void;
  const delayedContext = new Promise<number | null | undefined>((resolve) => { resolveDelayedContext = resolve; });
  session.subscribe(async (event) => {
    if (event.type !== "entry_appended" || event.entry.type !== "compaction") return;
    await delayedEntry;
    resolveDelayedContext(session.getContextUsage()?.tokens);
  });
  let runtimeEstimatedTokensAfter: number | undefined;
  session.onEvent((envelope) => {
    if (envelope.event.type !== "compaction_completed") return;
    runtimeEstimatedTokensAfter = envelope.event.estimatedTokensAfter;
    releaseDelayedEntry();
  });
  const statsBefore = session.getSessionStats();

  const result = await session.compact();
  const delayedContextTokens = await delayedContext;
  assert.ok(runtimeEstimatedTokensAfter !== undefined);
  assert.equal(delayedContextTokens, runtimeEstimatedTokensAfter);
  assert.equal(session.getContextUsage()?.tokens, runtimeEstimatedTokensAfter);

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
    estimatedTokensAfter: runtimeEstimatedTokensAfter,
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
  assert.equal(statsAfter.usage.cacheReadTokens, undefined);
  assert.equal(statsAfter.usage.cacheWriteTokens, undefined);
  assert.equal(statsAfter.tokens.cacheReadReported, 30);
  assert.equal(statsAfter.tokens.cacheWriteReported, 40);
  assert.equal(statsAfter.tokens.total, (statsBefore.tokens.total ?? Number.NaN) + 100);
  assert.equal(statsAfter.cost, (statsBefore.cost ?? Number.NaN) + 1);
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

test("AgentSession separates a split-turn prefix for compaction extensions", async (context) => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "split-turn-extension-compaction" });
  for (let turn = 1; turn <= 4; turn += 1) {
    manager.appendMessage({
      id: `split-history-user-${turn}`,
      role: "user",
      content: [{ type: "text", text: `history question ${turn} ${"x".repeat(160)}` }],
      createdAt: `2026-07-20T00:00:0${turn}.000Z`,
    });
    manager.appendMessage({
      id: `split-history-assistant-${turn}`,
      role: "assistant",
      content: [{ type: "text", text: `history answer ${turn} ${"y".repeat(160)}` }],
      createdAt: `2026-07-20T00:00:1${turn}.000Z`,
      provider: provider.id,
      api: "openai-chat-completions",
      model: "one",
      stopReason: "stop",
    });
  }
  manager.appendMessage({
    id: "split-current-user",
    role: "user",
    content: [{ type: "text", text: "current turn prefix" }],
    createdAt: "2026-07-20T00:01:00.000Z",
  });
  const firstKeptEntryId = manager.appendMessage({
    id: "split-current-assistant",
    role: "assistant",
    content: [{ type: "text", text: `retained answer ${"z".repeat(4_000)}` }],
    createdAt: "2026-07-20T00:01:01.000Z",
    provider: provider.id,
    api: "openai-chat-completions",
    model: "one",
    stopReason: "stop",
  });
  let observed: CompactionPreparation | undefined;
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "observe-split-turn",
      factory(api) {
        api.on("session_before_compact", (event) => {
          observed = event.preparation;
          return { cancel: true };
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    extensionRunner: host,
    compactionReserveTokens: 200,
    compactionRecentTokens: 100,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 10_000 },
  });

  await assert.rejects(session.compact(), /Compaction cancelled/u);

  assert.equal(observed?.isSplitTurn, true);
  assert.equal(observed?.firstKeptEntryId, firstKeptEntryId);
  assert.deepEqual(observed?.turnPrefixMessages, [{
    role: "user",
    content: [{ type: "text", text: "current turn prefix" }],
    timestamp: Date.parse("2026-07-20T00:01:00.000Z"),
  }]);
  assert.equal(observed?.messagesToSummarize.length, 8);
  assert.equal(observed?.messagesToSummarize.some((message) =>
    message.role === "user" && Array.isArray(message.content) && message.content.some((block) =>
      block.type === "text" && block.text === "current turn prefix")), false);
  await session.close();
});

function cancelOnAbort(signal: AbortSignal): Promise<{ cancel: true }> {
  if (signal.aborted) return Promise.resolve({ cancel: true });
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
  });
}

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
          return cancelOnAbort(event.signal);
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    extensionRunner: host,
    compactionReserveTokens: 200,
    compactionRecentTokens: 200,
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

test("AgentSession generic abort cancels an active manual compaction", async (context) => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "generic-abort-manual-compaction" });
  seedCompactableHistory(manager, provider);
  let entered!: () => void;
  const listenerEntered = new Promise<void>((resolve) => { entered = resolve; });
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "wait-for-generic-abort",
      factory(api) {
        api.on("session_before_compact", async (event) => {
          entered();
          return cancelOnAbort(event.signal);
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    extensionRunner: host,
    compactionReserveTokens: 200,
    compactionRecentTokens: 200,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 10_000 },
  });

  const compacting = session.compact();
  await listenerEntered;
  await session.abort("cancel all work");

  await assert.rejects(compacting, /Compaction cancelled/u);
  assert.equal(session.isCompacting, false);
  assert.equal(manager.getEntries().some((entry) => entry.type === "compaction"), false);
  await session.close();
});

test("manual compaction participates in idle state and blocks overlapping work", async (context) => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "manual-compaction-idle" });
  seedCompactableHistory(manager, provider);
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  let releaseCompaction!: () => void;
  const gate = new Promise<{ cancel: true }>((resolve) => {
    releaseCompaction = () => resolve({ cancel: true });
  });
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "hold-manual-compaction",
      factory(api) {
        api.on("session_before_compact", async () => {
          markEntered();
          return await gate;
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    extensionRunner: host,
    compactionReserveTokens: 200,
    compactionRecentTokens: 200,
  });
  let markCompactionStarted!: () => void;
  const compactionStarted = new Promise<void>((resolve) => { markCompactionStarted = resolve; });
  let releaseCompactionStart!: () => void;
  const compactionStartGate = new Promise<void>((resolve) => { releaseCompactionStart = resolve; });
  session.subscribe(async (event) => {
    if (event.type !== "compaction_start") return;
    markCompactionStarted();
    await compactionStartGate;
  });
  context.after(async () => {
    releaseCompactionStart();
    releaseCompaction();
    await session.close();
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 10_000 },
  });

  const compacting = session.compact();
  await compactionStarted;
  const entryCountBeforeCustomMessages = manager.getEntryCount();
  const customMessageOutcomes = await Promise.allSettled([
    session.sendCustomMessage({
      customType: "compaction-overlap",
      content: "append during compaction",
      display: false,
    }),
    session.sendCustomMessage({
      customType: "compaction-overlap",
      content: "trigger during compaction",
      display: false,
    }, { triggerTurn: true }),
  ]);
  await session.sendCustomMessage({
    customType: "compaction-next-turn",
    content: "deliver after compaction",
    display: false,
  }, { deliverAs: "nextTurn" });
  releaseCompactionStart();
  await entered;
  assert.equal(session.isIdle, false);
  assert.equal(session.isCompacting, true);
  assert.throws(() => session.newSession(), /must be idle/u);
  await assert.rejects(session.prompt("overlap", { allowedTools: [] }), /must be idle/u);
  await assert.rejects(session.compact(), /already in progress/u);
  let idleSettled = false;
  const idle = session.waitForIdle().then(() => { idleSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(idleSettled, false);

  releaseCompaction();
  await assert.rejects(compacting, /Compaction cancelled/u);
  await idle;
  for (const outcome of customMessageOutcomes) {
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") assert.match(String(outcome.reason), /must be idle/u);
  }
  assert.equal(manager.getEntryCount(), entryCountBeforeCustomMessages);
  assert.equal(session.isIdle, true);
});

test("AgentSession persists provider usage from generated compaction summaries", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "generated-compaction-usage" });
  seedCompactableHistory(manager, provider);
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    compactionReserveTokens: 200,
    compactionRecentTokens: 200,
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
    totalTokens: 14,
    cost: expectedUsage.cost,
  });
  const compaction = manager.getBranch().findLast((entry) => entry.type === "compaction");
  assert.equal(compaction?.type, "compaction");
  assert.deepEqual(compaction?.type === "compaction" ? compaction.usage : undefined, expectedUsage);
  const statsAfter = session.getSessionStats();
  assert.equal(statsAfter.usage.inputTokens, (statsBefore.usage.inputTokens ?? 0) + 10);
  assert.equal(statsAfter.usage.outputTokens, (statsBefore.usage.outputTokens ?? 0) + 4);
  assert.equal(statsAfter.cost, (statsBefore.cost ?? Number.NaN) + 0.002);
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
    compactionRecentTokens: 200,
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
  const compactedSummary = "successful overflow compacted";
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "overflow-summary",
      factory(api) {
        api.on("session_before_compact", () => ({
          compaction: {
            summary: compactedSummary,
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
    compactionRecentTokens: 200,
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
  assert.equal(end.result?.summary, compactedSummary);
  assert.equal((end.result?.estimatedTokensAfter ?? 0) > 0, true);
  const operation = [...manager.getV4State().operations.values()].at(-1);
  assert.equal(operation?.checkpointIds.some((id) => {
    const data = manager.getV4State().checkpoints.get(id)?.data;
    return data !== null
      && typeof data === "object"
      && !Array.isArray(data)
      && data["phase"] === "compaction_persisted";
  }), true);
  await session.close();
});

test("AgentSession reserves an explicit output request before the first provider call", async (context) => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "output-aware-preflight" });
  for (let turn = 0; turn < 4; turn += 1) {
    manager.appendMessage({
      id: `output-aware-user-${turn}`,
      role: "user",
      content: [{ type: "text", text: `question ${turn} ${"u".repeat(2_000)}` }],
      createdAt: `2026-07-20T00:00:0${turn}.000Z`,
    });
    manager.appendMessage({
      id: `output-aware-assistant-${turn}`,
      role: "assistant",
      content: [{ type: "text", text: `answer ${turn} ${"a".repeat(2_000)}` }],
      createdAt: `2026-07-20T00:00:1${turn}.000Z`,
      provider: provider.id,
      api: "openai-chat-completions",
      model: "one",
      stopReason: "stop",
    });
  }
  const observations: Array<{
    reason: string;
    providerRequests: number;
    reserveTokens: number;
    maxInputTokens: number;
  }> = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "output-aware-summary",
      factory(api) {
        api.on("session_before_compact", (event) => {
          observations.push({
            reason: event.reason,
            providerRequests: provider.requests.length,
            reserveTokens: event.preparation.settings.reserveTokens,
            maxInputTokens: event.preparation.settings.maxInputTokens,
          });
          return {
            compaction: {
              summary: "output-aware history checkpoint",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
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
    compactionRecentTokens: 200,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 10_000, maxOutputTokens: 8_000 },
  });

  const run = await session.prompt("leave room for the response", {
    allowedTools: [],
    maxOutputTokens: 4_000,
  });

  assert.equal(run.results.at(-1)?.finalText, "answer-1");
  assert.deepEqual(observations, [{
    reason: "overflow",
    providerRequests: 0,
    reserveTokens: 4_000,
    maxInputTokens: 6_000,
  }]);
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0]?.maxOutputTokens, 4_000);
  assert.equal(manager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
  await session.close();
});

test("AgentSession enforces the fallback hard budget before calling a sparse-metadata provider", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "sparse-model-hard-budget" });
  seedCompactableHistory(manager, provider, 375_000, sessionV4JsonHash([]));
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    autoCompaction: false,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });

  const run = await session.prompt("do not call the provider", { allowedTools: [], autoCompaction: false });

  assert.equal(provider.requests.length, 0);
  assert.equal(run.results.at(-1)?.finishReason, "error");
  assert.match(run.results.at(-1)?.finalText ?? "", /Context exceeds its hard budget/u);
  await session.close();
});

test("AgentSession does not let an explicit total context window bypass a model input ceiling", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd, { id: "explicit-input-ceiling" }), new ProviderRegistry([provider])),
    autoCompaction: false,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: {
      ...provider.models[0]!,
      contextTokens: 200_000,
      maxInputTokens: 100,
      maxOutputTokens: 32_000,
    },
  });

  const run = await session.prompt("x".repeat(2_000), {
    allowedTools: [],
    autoCompaction: false,
    contextTokenBudget: 400_000,
    maxOutputTokens: 32_000,
  });

  assert.equal(provider.requests.length, 0);
  assert.equal(run.results.at(-1)?.finishReason, "error");
  assert.match(run.results.at(-1)?.finalText ?? "", /Context exceeds its hard budget/u);
  await session.close();
});

for (const invalidLimit of [0, Number.NaN]) {
  test(`AgentSession treats ${String(invalidLimit)} model token ceilings as unknown`, async () => {
    const cwd = await workspace();
    const provider = new RecordingProvider();
    const session = await AgentSession.create(sessionOptions(
      SessionManager.inMemory(cwd, { id: `invalid-model-limits-${String(invalidLimit)}` }),
      new ProviderRegistry([provider]),
    ));
    await session.setModel({
      provider: provider.id,
      api: "openai-chat-completions",
      id: "one",
      info: {
        ...provider.models[0]!,
        contextTokens: invalidLimit,
        maxInputTokens: invalidLimit,
        maxOutputTokens: invalidLimit,
      },
    });

    const run = await session.prompt("use unknown model limits", { allowedTools: [], maxOutputTokens: 512 });

    assert.equal(run.results.at(-1)?.finalText, "answer-1");
    assert.equal(provider.requests[0]?.maxOutputTokens, 512);
    await session.close();
  });
}

test("AgentSession rejects invalid caller token ceilings instead of applying model fallbacks", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const session = await AgentSession.create(sessionOptions(
    SessionManager.inMemory(cwd, { id: "invalid-caller-token-limits" }),
    new ProviderRegistry([provider]),
  ));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });

  for (const invalidLimit of [0, Number.NaN]) {
    await assert.rejects(
      session.prompt("invalid context limit", { allowedTools: [], contextTokenBudget: invalidLimit }),
      /contextTokenBudget must be a positive safe integer/u,
    );
    await assert.rejects(
      session.prompt("invalid output limit", { allowedTools: [], maxOutputTokens: invalidLimit }),
      /requestedMaxOutputTokens must be a positive safe integer/u,
    );
  }
  assert.equal(provider.requests.length, 0);
  await session.close();
});

test("AgentSession refreshes the proactive compaction trigger after an agent model change", async () => {
  const cwd = await workspace();
  const provider = new ToolThenCompactionProvider();
  const manager = SessionManager.inMemory(cwd, { id: "dynamic-context-trigger" });
  seedDynamicTriggerHistory(manager, provider);
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    compactionReserveTokens: 18_000,
    compactionRecentTokens: 24_000,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 100_000, maxOutputTokens: 8_000 },
  });
  let refreshes = 0;
  session.agent.prepareNextTurn = () => {
    refreshes += 1;
    return {
      model: {
        ...session.agent.state.model,
        contextWindow: 64_000,
        maxTokens: 8_000,
      },
    };
  };

  const result = await session.prompt("use the directory tool, then continue", { allowedTools: ["ls"] });

  assert.deepEqual({
    refreshes,
    finalText: result.results.at(-1)?.finalText,
    requests: provider.requests.map((request) => request.cacheRetention),
  }, {
    refreshes: 1,
    finalText: "dynamic budget complete",
    requests: [undefined, "none", undefined],
  });
  assert.equal(manager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
  await session.close();
});

test("AgentSession keeps an explicit total window but cannot bypass a refreshed model input ceiling", async () => {
  const cwd = await workspace();
  const provider = new ToolThenCompactionProvider();
  const manager = SessionManager.inMemory(cwd, { id: "explicit-dynamic-context-trigger" });
  seedDynamicTriggerHistory(manager, provider);
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    compactionReserveTokens: 18_000,
    compactionRecentTokens: 24_000,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 100_000, maxOutputTokens: 8_000 },
  });
  let refreshes = 0;
  session.agent.prepareNextTurn = () => {
    refreshes += 1;
    return {
      model: {
        ...session.agent.state.model,
        contextWindow: 64_000,
        maxInputTokens: 60_000,
        maxTokens: 8_000,
      },
    };
  };

  const result = await session.prompt("keep the caller budget", {
    allowedTools: ["ls"],
    contextTokenBudget: 100_000,
  });

  assert.equal(refreshes, 1);
  assert.equal(result.results.at(-1)?.finalText, "dynamic budget complete");
  assert.equal(provider.requests.length, 3);
  assert.equal(manager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
  await session.close();
});

test("AgentSession clears a prior output cap when prepare-next-turn selects a model without one", async () => {
  const cwd = await workspace();
  const provider = new ToolThenCompactionProvider();
  const models = createModels();
  models.setProvider(createProvider({
    id: provider.id,
    auth: {
      apiKey: {
        name: "Fixture key",
        async resolve() { return { auth: { apiKey: "fixture" }, source: "fixture" }; },
      },
    },
    models: [{
      id: "one",
      name: "one",
      api: "openai-chat-completions",
      provider: provider.id,
      baseUrl: "https://example.test/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 64,
    }, providerModelFromInfo({ ...provider.models[1]!, contextTokens: 100_000 })],
    api: { async *stream() {} },
  }));
  const modelRegistry = new ModelRegistry(models);
  await modelRegistry.refresh();
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd, { id: "dynamic-output-cap" }), new ProviderRegistry([provider])),
    modelRegistry,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 100_000, maxOutputTokens: 64 },
  });
  const nextModel = session.modelRuntime.getModel(provider.id, "two");
  assert.ok(nextModel);
  session.agent.prepareNextTurn = () => ({ model: nextModel });

  const result = await session.prompt("switch to the sparse model", {
    allowedTools: ["ls"],
    maxOutputTokens: 512,
  });

  assert.equal(result.results.at(-1)?.finalText, "dynamic budget complete");
  assert.deepEqual(provider.requests.map((request) => [request.model, request.maxOutputTokens]), [
    ["one", 64],
    ["two", 512],
  ]);
  await session.close();
});

async function sparseNextTurnRegistry(provider: RecordingProvider): Promise<ModelRegistry> {
  const models = createModels();
  models.setProvider(createProvider({
    id: provider.id,
    auth: {
      apiKey: {
        name: "Fixture key",
        async resolve() { return { auth: { apiKey: "fixture" }, source: "fixture" }; },
      },
    },
    models: [
      providerModelFromInfo({ ...provider.models[0]!, contextTokens: 200_000, maxOutputTokens: 8_000 }),
      providerModelFromInfo(provider.models[1]!),
    ],
    api: { async *stream() {} },
  }));
  const registry = new ModelRegistry(models);
  await registry.refresh();
  return registry;
}

for (const scenario of [
  {
    name: "refreshes to the fallback budget after a sparse next-turn model switch",
    contextTokenBudget: undefined,
    cacheRetention: [undefined, "none", undefined],
    compactions: 1,
  },
  {
    name: "preserves an explicit budget after a sparse next-turn model switch",
    contextTokenBudget: 200_000,
    cacheRetention: [undefined, undefined],
    compactions: 0,
  },
] as const) {
  test(`AgentSession ${scenario.name}`, async () => {
    const cwd = await workspace();
    const provider = new ToolThenCompactionProvider();
    const manager = SessionManager.inMemory(cwd, { id: `sparse-next-turn-${scenario.compactions}` });
    seedDynamicTriggerHistory(manager, provider, 20_000);
    const modelRegistry = await sparseNextTurnRegistry(provider);
    const session = await AgentSession.create({
      ...sessionOptions(manager, new ProviderRegistry([provider])),
      modelRegistry,
    });
    await session.setModel({
      provider: provider.id,
      api: "openai-chat-completions",
      id: "one",
      info: { ...provider.models[0]!, contextTokens: 200_000, maxOutputTokens: 8_000 },
    });
    const nextModel = session.modelRuntime.getModel(provider.id, "two");
    assert.ok(nextModel);
    session.agent.prepareNextTurn = () => ({ model: nextModel });

    const result = await session.prompt("switch to the sparse model", {
      allowedTools: ["ls"],
      ...(scenario.contextTokenBudget === undefined ? {} : { contextTokenBudget: scenario.contextTokenBudget }),
    });

    assert.equal(result.results.at(-1)?.finalText, "dynamic budget complete");
    assert.deepEqual(provider.requests.map((request) => request.cacheRetention), scenario.cacheRetention);
    assert.equal(manager.getEntries().filter((entry) => entry.type === "compaction").length, scenario.compactions);
    await session.close();
  });
}

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
    compactionRecentTokens: 200,
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

test("AgentSession uses the fallback budget when sparse metadata overflows and recovery is cancelled", async (context) => {
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
    compactionRecentTokens: 200,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
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

test("AgentSession does not reuse a usage baseline after an error response from a changed tool set", async (context) => {
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
    compactionRecentTokens: 200,
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
  const failedAssistant = manager.getBranch().findLast((entry) =>
    entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error");
  assert.equal(
    failedAssistant?.type === "message" && failedAssistant.message.role === "assistant"
      ? failedAssistant.message.toolDefinitionFingerprint
      : undefined,
    sessionV4JsonHash([]),
  );
  assert.deepEqual(compactionProviderRequestCounts, []);
  assert.equal(events.some((event) => event.type === "compaction_start"), false);
  assert.equal(manager.getEntries().some((entry) => entry.type === "compaction"), false);
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
    compactionRecentTokens: 200,
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
  const credential = "registered-extension-branch-summary-credential";
  defaultSecretRedactor.register(credential);
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
          return { summary: {
            summary: `extension branch summary ${credential}`,
            details: {
              source: "fixture",
              detail: `metadata ${credential}`,
              [credential]: "hidden",
            },
          } };
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
  const runtimeEvents: RuntimeEvent[] = [];
  session.onEvent((envelope) => { runtimeEvents.push(envelope.event); });

  const result = await session.navigateTree(first, { summarize: true });

  assert.equal(result.cancelled, false);
  assert.equal(result.editorText, "original question");
  assert.equal(result.summaryEntry?.summary, "extension branch summary [REDACTED]");
  assert.deepEqual(result.summaryEntry?.details, {
    source: "fixture",
    detail: "metadata [REDACTED]",
  });
  assert.equal(result.summaryEntry?.fromHook, true);
  assert.deepEqual(observed, ["before:2", "after:true"]);
  const summaries = runtimeEvents.filter((event) => event.type === "branch_summary_created");
  assert.equal(summaries.length, 1);
  const emitted = summaries[0];
  assert.equal(emitted?.type === "branch_summary_created"
    ? emitted.summary.content[0]?.type === "text" ? emitted.summary.content[0].text : undefined
    : undefined, result.summaryEntry?.summary);
  assert.deepEqual(emitted?.type === "branch_summary_created"
    ? emitted.extensionMetadata
    : undefined, result.summaryEntry?.details);
  assert.equal(JSON.stringify(manager.getV4State().nodes.get(result.summaryEntry!.id)).includes(credential), false);
  await session.close();
});

test("AgentSession observes one durable branch summary with its normalized usage", async (context) => {
  const sink = new RecordingObservabilitySink();
  const observability = new RuntimeObservability(sink, {
    mode: "sdk",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
    closeSink: false,
  });
  context.after(async () => await observability.close());
  const credential = "registered-provider-branch-summary-credential";
  defaultSecretRedactor.register(credential);
  const provider = new BranchSummaryEventProvider([
    { type: "response_start", model: "one" },
    { type: "text_delta", part: 0, text: `observed branch summary ${credential}` },
    {
      type: "usage",
      semantics: "final",
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 160,
        cacheReadTokens: 50,
        raw: { detail: `usage ${credential}` },
      },
    },
    {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: {} },
    },
  ]);
  const { session, manager, target } = await branchSummaryFixture(
    provider,
    SettingsManager.inMemory(),
    observability,
  );
  context.after(async () => await session.close());
  manager.appendMessage({
    id: "provider-summary-secret-tool-call",
    role: "assistant",
    content: [{
      type: "tool_call",
      callId: "provider-summary-secret-read",
      name: "read",
      arguments: { path: `/workspace/${credential}.ts` },
    }],
    createdAt: "2026-07-20T00:00:02.000Z",
  });
  manager.appendMessage({
    id: "provider-summary-secret-tool-result",
    role: "tool",
    content: [{
      type: "tool_result",
      callId: "provider-summary-secret-read",
      name: "read",
      content: "read result",
      isError: false,
    }],
    createdAt: "2026-07-20T00:00:03.000Z",
  });
  const sourceBranch = manager.getLeafId();
  const sourceEventIds = manager.getBranch().slice(1).map((entry) => entry.id);
  const runtimeEvents: RuntimeEvent[] = [];
  session.onEvent((envelope) => { runtimeEvents.push(envelope.event); });

  const result = await session.navigateTree(target, { summarize: true });
  observability.snapshot();

  assert.equal(result.summaryEntry?.summary.includes(credential), false);
  assert.match(result.summaryEntry?.summary ?? "", /observed branch summary \[REDACTED\]/u);
  assert.deepEqual(result.summaryEntry?.details, {
    readFiles: ["/workspace/[REDACTED].ts"],
    modifiedFiles: [],
  });
  const summaries = runtimeEvents.filter((event) => event.type === "branch_summary_created");
  assert.equal(summaries.length, 1);
  const emitted = summaries[0];
  assert.equal(emitted?.type === "branch_summary_created"
    ? emitted.summary.content[0]?.type === "text" ? emitted.summary.content[0].text : undefined
    : undefined, result.summaryEntry?.summary);
  assert.deepEqual(emitted?.type === "branch_summary_created"
    ? emitted.extensionMetadata
    : undefined, result.summaryEntry?.details);
  assert.deepEqual(emitted?.type === "branch_summary_created" ? emitted.usage : undefined, result.summaryEntry?.usage);
  assert.equal(emitted?.type === "branch_summary_created" ? emitted.sourceBranch : undefined, sourceBranch);
  assert.deepEqual(emitted?.type === "branch_summary_created" ? emitted.sourceEventIds : undefined, sourceEventIds);
  assert.equal(JSON.stringify(manager.getV4State().nodes.get(result.summaryEntry!.id)).includes(credential), false);
  assert.deepEqual(summaries[0]?.type === "branch_summary_created" ? summaries[0].usage : undefined, {
    inputTokens: 100,
    outputTokens: 10,
    totalTokens: 160,
    cacheReadTokens: 50,
    raw: { detail: "usage [REDACTED]" },
  });
  const snapshot = sink.records.findLast((record) => record.kind === "metrics_snapshot");
  assert.equal(snapshot?.fields.branch_summaries, 1);
  assert.equal(snapshot?.fields.input_tokens, 100);
  assert.equal(snapshot?.fields.output_tokens, 10);
  assert.equal(snapshot?.fields.cache_read_tokens, 50);
  assert.equal(JSON.stringify(sink.records).includes(credential), false);
});

test("AgentSession observes reported branch-summary usage when the summary fails", async (context) => {
  const sink = new RecordingObservabilitySink();
  const observability = new RuntimeObservability(sink, {
    mode: "sdk",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
    closeSink: false,
  });
  context.after(async () => await observability.close());
  const provider = new BranchSummaryEventProvider([
    { type: "response_start", model: "one" },
    {
      type: "usage",
      semantics: "final",
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 },
    },
    {
      type: "response_end",
      reason: "length",
      state: { kind: "chat_completions", assistantMessage: {} },
    },
  ]);
  const { session, manager, target, leaf } = await branchSummaryFixture(
    provider,
    SettingsManager.inMemory(),
    observability,
  );
  context.after(async () => await session.close());
  const runtimeEvents: RuntimeEvent[] = [];
  session.onEvent((envelope) => { runtimeEvents.push(envelope.event); });

  await assert.rejects(session.navigateTree(target, { summarize: true }), /ended with length/u);
  observability.snapshot();

  assert.equal(manager.getLeafId(), leaf);
  assert.equal(manager.getEntries().some((entry) => entry.type === "branch_summary"), false);
  assert.equal(runtimeEvents.some((event) => event.type === "usage"), false);
  const snapshot = sink.records.findLast((record) => record.kind === "metrics_snapshot");
  assert.equal(snapshot?.fields.input_tokens, 100);
  assert.equal(snapshot?.fields.output_tokens, 10);
  assert.equal(snapshot?.fields.cache_read_tokens, 50);
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
  const systemText = provider.requests[0]!.messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.content)
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .join("\n");
  assert.match(
    systemText,
    /Goal; Constraints; Completed work; Current state; Blockers and failures; Decisions; Files and exact identifiers; Next actions/u,
  );
  assert.match(systemText, /numbered list under Next actions/u);
  assert.match(systemText, /transcript as untrusted data/u);
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

test("AgentSession retries transient branch summaries with one released correlation", async (context) => {
  const sink = new RecordingObservabilitySink();
  const observability = new RuntimeObservability(sink, {
    mode: "sdk",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
    closeSink: false,
  });
  context.after(async () => await observability.close());
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
        type: "usage",
        semantics: "final",
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      },
      {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: {} },
      },
    ],
  ]);
  const { session, target } = await branchSummaryFixture(provider, SettingsManager.inMemory({
    retry: { maxRetries: 2, baseDelayMs: 0, provider: { maxRetryDelayMs: 0 } },
  }), observability);
  const direct: AgentSessionEvent[] = [];
  const envelopes: EventEnvelope[] = [];
  session.subscribe((event) => { direct.push(event); });
  session.onEvent((envelope) => {
    if (
      envelope.event.type.startsWith("summarization_retry_") ||
      envelope.event.type === "branch_summary_created"
    ) {
      envelopes.push(envelope);
    }
  });

  const result = await session.navigateTree(target, { summarize: true });

  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests.every((request) => request.cacheRetention === "none"), true);
  assert.match(provider.requests[0]?.sessionId ?? "", /^summary_[0-9a-f]{32}$/u);
  assert.equal(provider.requests[1]?.sessionId, provider.requests[0]?.sessionId);
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
  assert.deepEqual(
    envelopes.filter((envelope) => envelope.event.type.startsWith("summarization_retry_"))
      .map((envelope) => envelope.event),
    expected,
  );
  assert.equal(envelopes.length, 4);
  const summaryCorrelationId = envelopes[0]?.runId;
  assert.equal(typeof summaryCorrelationId, "string");
  assert.deepEqual(envelopes.map((envelope) => envelope.runId), [
    summaryCorrelationId,
    summaryCorrelationId,
    summaryCorrelationId,
    summaryCorrelationId,
  ]);
  assert.deepEqual(envelopes.map((envelope) => envelope.sequence), [1, 2, 3, 4]);
  const priorAlias = sink.records.find((record) =>
    record.name === "summarization_retry_scheduled")?.correlation?.run;
  assert.equal(typeof priorAlias, "string");
  assert.notEqual(observeCorrelationAlias(observability, sink, summaryCorrelationId!, 5), priorAlias);
  observability.snapshot();
  const snapshot = sink.records.findLast((record) => record.kind === "metrics_snapshot");
  assert.equal(snapshot?.fields.branch_summaries, 1);
  assert.equal(snapshot?.fields.input_tokens, 100);
  assert.equal(snapshot?.fields.output_tokens, 10);
  assert.equal(snapshot?.fields.runs_started, 0);
  assert.equal(snapshot?.fields.runs_completed, 0);
  assert.equal(snapshot?.fields.runs_failed, 0);
  assert.equal(snapshot?.fields.runs_cancelled, 0);
  assert.equal(snapshot?.fields.active_runs, 0);
  await session.close();
});

test("AgentSession branch summaries forward provider overrides without changing outer retry count", async () => {
  const provider = new BranchSummaryTimeoutProvider();
  const { session, target } = await branchSummaryFixture(provider, SettingsManager.inMemory({
    retry: {
      maxRetries: 3,
      baseDelayMs: 0,
      provider: { timeoutMs: 20, maxRetries: 0, maxRetryDelayMs: 0 },
    },
  }));
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => { events.push(event); });

  const result = await session.navigateTree(target, { summarize: true });

  assert.equal(result.summaryEntry?.summary, "recovered branch summary");
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests.every((request) => request.timeoutMs === 20), true);
  assert.equal(provider.requests.every((request) => request.maxRetries === 0), true);
  assert.equal(provider.requests.every((request) => request.maxRetryDelayMs === 0), true);
  assert.notEqual(provider.signals[0], provider.signals[1]);
  assert.equal(provider.signals[0]?.aborted, true);
  assert.equal(provider.signals[1]?.aborted, false);
  assert.deepEqual(events.filter((event) => event.type.startsWith("summarization_retry_")), [
    {
      type: "summarization_retry_scheduled",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 0,
      errorMessage: "Provider request timed out after 20 ms",
    },
    { type: "summarization_retry_attempt_start", source: "branchSummary" },
    { type: "summarization_retry_finished" },
  ]);
  await session.close();
});

test("AgentSession branch-summary timeout does not replay partial output", async () => {
  const provider = new BranchSummaryTimeoutProvider([
    { type: "response_start", model: "one" },
    { type: "text_delta", part: 0, text: "partial branch summary" },
  ]);
  const { session, manager, target, leaf } = await branchSummaryFixture(provider, SettingsManager.inMemory({
    retry: {
      maxRetries: 3,
      baseDelayMs: 0,
      provider: { timeoutMs: 20, maxRetries: 2, maxRetryDelayMs: 0 },
    },
  }));
  const events: AgentSessionEvent[] = [];
  const runtimeEvents: RuntimeEvent[] = [];
  session.subscribe((event) => { events.push(event); });
  session.onEvent((envelope) => { runtimeEvents.push(envelope.event); });

  await assert.rejects(
    session.navigateTree(target, { summarize: true }),
    /Provider request timed out after 20 ms/u,
  );

  assert.equal(provider.requests.length, 1);
  assert.equal(manager.getLeafId(), leaf);
  assert.equal(manager.getEntries().some((entry) => entry.type === "branch_summary"), false);
  assert.equal(events.some((event) => event.type.startsWith("summarization_retry_")), false);
  assert.equal(runtimeEvents.some((event) => event.type === "branch_summary_created"), false);
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

  await context.test("exhausted transient retries", async (testContext) => {
    const sink = new RecordingObservabilitySink();
    const observability = new RuntimeObservability(sink, {
      mode: "sdk",
      processInstance: "0123456789abcdef",
      snapshotIntervalMs: 60_000,
      closeSink: false,
    });
    testContext.after(async () => await observability.close());
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
    }), observability);
    const events: AgentSessionEvent[] = [];
    const envelopes: EventEnvelope[] = [];
    session.subscribe((event) => { events.push(event); });
    session.onEvent((envelope) => {
      if (envelope.event.type.startsWith("summarization_retry_")) envelopes.push(envelope);
    });

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
    const summaryCorrelationId = envelopes[0]?.runId;
    assert.equal(typeof summaryCorrelationId, "string");
    assert.equal(envelopes.every((envelope) => envelope.runId === summaryCorrelationId), true);
    const priorAlias = sink.records.find((record) =>
      record.name === "summarization_retry_scheduled")?.correlation?.run;
    assert.equal(typeof priorAlias, "string");
    assert.notEqual(observeCorrelationAlias(observability, sink, summaryCorrelationId!, 4), priorAlias);
    await session.close();
  });

  await context.test("cancelled retry delay", async (testContext) => {
    const sink = new RecordingObservabilitySink();
    const observability = new RuntimeObservability(sink, {
      mode: "sdk",
      processInstance: "0123456789abcdef",
      snapshotIntervalMs: 60_000,
      closeSink: false,
    });
    testContext.after(async () => await observability.close());
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
    }), observability);
    const events: AgentSessionEvent[] = [];
    const envelopes: EventEnvelope[] = [];
    let scheduled!: () => void;
    const retryScheduled = new Promise<void>((resolve) => { scheduled = resolve; });
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "summarization_retry_scheduled") scheduled();
    });
    session.onEvent((envelope) => {
      if (envelope.event.type.startsWith("summarization_retry_")) envelopes.push(envelope);
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
    const summaryCorrelationId = envelopes[0]?.runId;
    assert.equal(typeof summaryCorrelationId, "string");
    assert.equal(envelopes.every((envelope) => envelope.runId === summaryCorrelationId), true);
    const priorAlias = sink.records.find((record) =>
      record.name === "summarization_retry_scheduled")?.correlation?.run;
    assert.equal(typeof priorAlias, "string");
    assert.notEqual(observeCorrelationAlias(observability, sink, summaryCorrelationId!, 3), priorAlias);
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
  const runtimeEvents: RuntimeEvent[] = [];
  session.onEvent((envelope) => { runtimeEvents.push(envelope.event); });

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
  assert.equal(runtimeEvents.some((event) => event.type === "branch_summary_created"), false);
  await session.close();
});

test("AgentSession uses the fallback context window for a sparse-model branch summary", async () => {
  const provider = new RecordingProvider();
  const { session, manager, target } = await branchSummaryFixture(provider);
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });

  const result = await session.navigateTree(target, { summarize: true });

  assert.equal(result.cancelled, false);
  assert.ok(result.summaryEntry);
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0]?.maxOutputTokens, 2_048);
  assert.equal(manager.getLeafId(), result.summaryEntry.id);
  await session.close();
});

test("AgentSession trusts positive reported branch-summary usage within its requested cap", async () => {
  const provider = new BranchSummaryEventProvider([
    { type: "response_start", model: "one" },
    { type: "text_delta", part: 0, text: "x".repeat(4_097) },
    { type: "usage", semantics: "final", usage: { outputTokens: 2_048 } },
    {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: {} },
      content: [{ type: "text", text: "x".repeat(4_097) }],
    },
  ]);
  const { session, manager, target } = await branchSummaryFixture(provider);

  const result = await session.navigateTree(target, { summarize: true });

  assert.ok(result.summaryEntry);
  assert.equal(provider.requests[0]?.maxOutputTokens, 2_048);
  assert.equal(manager.getLeafId(), result.summaryEntry.id);
  await session.close();
});

test("AgentSession accepts authoritative terminal content for branch summaries", async (t) => {
  await t.test("terminal-only text", async () => {
    const provider = new BranchSummaryEventProvider([
      { type: "response_start", model: "one" },
      {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: {} },
        content: [{ type: "text", text: "terminal-only branch summary" }],
      },
    ]);
    const { session, manager, target } = await branchSummaryFixture(provider);

    const result = await session.navigateTree(target, { summarize: true });

    assert.equal(result.summaryEntry?.summary, "terminal-only branch summary");
    assert.equal(manager.getLeafId(), result.summaryEntry?.id);
    await session.close();
  });

  await t.test("streamed prefixes", async () => {
    const provider = new BranchSummaryEventProvider([
      { type: "response_start", model: "one" },
      { type: "reasoning_delta", part: 0, text: "plan", visibility: "provider_trace" },
      { type: "text_delta", part: 1, text: "branch " },
      {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: {} },
        content: [
          { type: "thinking", thinking: "planning complete", visibility: "provider_trace" },
          { type: "text", text: "branch summary complete" },
        ],
      },
    ]);
    const { session, manager, target } = await branchSummaryFixture(provider);

    const result = await session.navigateTree(target, { summarize: true });

    assert.equal(result.summaryEntry?.summary, "branch summary complete");
    assert.equal(manager.getLeafId(), result.summaryEntry?.id);
    await session.close();
  });
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
  const entryCountBeforeCustomMessages = manager.getEntryCount();
  const customMessageOutcomes = Promise.allSettled([
    session.sendCustomMessage({
      customType: "tree-overlap",
      content: "append during navigation",
      display: false,
    }),
    session.sendCustomMessage({
      customType: "tree-overlap",
      content: "trigger during navigation",
      display: false,
    }, { triggerTurn: true }),
  ]);
  await session.sendCustomMessage({
    customType: "tree-next-turn",
    content: "deliver after navigation",
    display: false,
  }, { deliverAs: "nextTurn" });
  assert.equal(session.isIdle, false);
  await assert.rejects(session.refresh(), /must be idle/u);
  await assert.rejects(session.prompt("overlap", { allowedTools: [] }), /must be idle/u);
  assert.throws(() => session.newSession(), /must be idle/u);
  await assert.rejects(session.navigateTree(target), /must be idle/u);

  await session.close();
  for (const outcome of await customMessageOutcomes) {
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") assert.match(String(outcome.reason), /must be idle/u);
  }
  assert.equal(manager.getEntryCount(), entryCountBeforeCustomMessages);
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

test("AgentSession branch summarization respects a published input ceiling", async () => {
  const provider = new RecordingProvider();
  const { session, manager, target } = await branchSummaryFixture(provider);
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: branchSummaryModel(provider.models[0]!, { maxInputTokens: 10_000 }),
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

test("AgentSession uses the dedicated branch-summary reserve instead of compaction reserve", async () => {
  const provider = new RecordingProvider();
  const { session, target } = await branchSummaryFixture(provider, SettingsManager.inMemory({
    compaction: { reserveTokens: 18_000 },
    branchSummary: { reserveTokens: 100 },
  }));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: branchSummaryModel(provider.models[0]!, { contextTokens: 20_000, maxOutputTokens: 4_096 }),
  });

  const result = await session.navigateTree(target, { summarize: true });

  assert.equal(provider.requests.length, 1);
  assert.equal(result.cancelled, false);
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
    info: branchSummaryModel(provider.models[0]!, { contextTokens: 24_000, maxOutputTokens: 2_048 }),
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
    {
      name: "reported-token-overrun",
      events: [
        { type: "response_start", model: "one" },
        { type: "text_delta", part: 0, text: "summary" },
        { type: "usage", semantics: "final", usage: { outputTokens: 2_049 } },
        {
          type: "response_end",
          reason: "stop",
          state: { kind: "chat_completions", assistantMessage: {} },
        },
      ],
      error: /reported 2049 output tokens.*limit of 2048/u,
    },
    {
      name: "estimated-token-overrun",
      events: [
        { type: "response_start", model: "one" },
        { type: "text_delta", part: 0, text: "x".repeat(4_097) },
        {
          type: "response_end",
          reason: "stop",
          state: { kind: "chat_completions", assistantMessage: {} },
        },
      ],
      error: /estimated 2049 output tokens.*limit of 2048/u,
    },
    {
      name: "estimated-reasoning-overrun",
      events: [
        { type: "response_start", model: "one" },
        { type: "reasoning_delta", part: 0, text: "x".repeat(4_097), visibility: "provider_trace" },
        { type: "text_delta", part: 1, text: "ok" },
        {
          type: "response_end",
          reason: "stop",
          state: { kind: "chat_completions", assistantMessage: {} },
        },
      ],
      error: /estimated 2050 output tokens.*limit of 2048/u,
    },
    {
      name: "terminal-tool-call",
      events: [
        { type: "response_start", model: "one" },
        {
          type: "response_end",
          reason: "stop",
          state: { kind: "chat_completions", assistantMessage: {} },
          content: [{ type: "tool_call", callId: "summary-tool", name: "read", arguments: {} }],
        },
      ],
      error: /cannot call tools/u,
    },
    {
      name: "terminal-text-prefix-mismatch",
      events: [
        { type: "response_start", model: "one" },
        { type: "text_delta", part: 0, text: "streamed" },
        {
          type: "response_end",
          reason: "stop",
          state: { kind: "chat_completions", assistantMessage: {} },
          content: [{ type: "text", text: "different" }],
        },
      ],
      error: /terminal text did not match its streamed prefix/u,
    },
    {
      name: "terminal-reasoning-prefix-mismatch",
      events: [
        { type: "response_start", model: "one" },
        { type: "reasoning_delta", part: 0, text: "streamed", visibility: "provider_trace" },
        { type: "text_delta", part: 1, text: "summary" },
        {
          type: "response_end",
          reason: "stop",
          state: { kind: "chat_completions", assistantMessage: {} },
          content: [
            { type: "thinking", thinking: "different", visibility: "provider_trace" },
            { type: "text", text: "summary" },
          ],
        },
      ],
      error: /terminal reasoning did not match its streamed prefix/u,
    },
    {
      name: "terminal-omits-streamed-text",
      events: [
        { type: "response_start", model: "one" },
        { type: "text_delta", part: 0, text: "streamed" },
        {
          type: "response_end",
          reason: "stop",
          state: { kind: "chat_completions", assistantMessage: {} },
          content: [
            { type: "thinking", thinking: "terminal reasoning", visibility: "provider_trace" },
            { type: "text", text: "summary", textSignature: "signature" },
          ],
        },
      ],
      error: /terminal content omitted streamed text/u,
    },
    {
      name: "terminal-omits-streamed-reasoning",
      events: [
        { type: "response_start", model: "one" },
        { type: "reasoning_delta", part: 0, text: "streamed", visibility: "provider_trace" },
        {
          type: "response_end",
          reason: "stop",
          state: { kind: "chat_completions", assistantMessage: {} },
          content: [{ type: "text", text: "summary" }],
        },
      ],
      error: /terminal content omitted streamed reasoning/u,
    },
    {
      name: "terminal-byte-overrun",
      events: [
        { type: "response_start", model: "one" },
        {
          type: "response_end",
          reason: "stop",
          state: { kind: "chat_completions", assistantMessage: {} },
          content: [
            { type: "thinking", thinking: "x".repeat(32 * 1024), visibility: "provider_trace" },
            { type: "text", text: "x".repeat(32 * 1024 + 1) },
          ],
        },
      ],
      error: /exceeded 65536 bytes/u,
    },
    {
      name: "terminal-estimated-token-overrun",
      events: [
        { type: "response_start", model: "one" },
        {
          type: "response_end",
          reason: "stop",
          state: { kind: "chat_completions", assistantMessage: {} },
          content: [
            { type: "thinking", thinking: "x".repeat(4_097), visibility: "provider_trace" },
            { type: "text", text: "ok" },
          ],
        },
      ],
      error: /estimated 2050 output tokens.*limit of 2048/u,
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

test("AgentSession rejects hostile branch-summary adapter events without traps or retries", async () => {
  const cases: Array<{
    name: string;
    event: (read: () => void) => AdapterEvent;
  }> = [
    {
      name: "accessor",
      event: (read) => Object.defineProperty({}, "type", {
        enumerable: true,
        get() {
          read();
          return "response_start";
        },
      }) as AdapterEvent,
    },
    {
      name: "throwing-accessor",
      event: (read) => Object.defineProperty({}, "type", {
        enumerable: true,
        get() {
          read();
          throw new Error("hostile branch-summary type getter ran");
        },
      }) as AdapterEvent,
    },
    {
      name: "proxy",
      event: (read) => new Proxy({}, {
        get(_target, key) {
          if (key === "type") read();
          return key === "type" ? "response_start" : undefined;
        },
      }) as AdapterEvent,
    },
  ];

  for (const value of cases) {
    let reads = 0;
    const hostile = value.event(() => { reads += 1; });
    const provider = new BranchSummaryAttemptProvider([[hostile], [hostile]]);
    const { session, manager, target, leaf } = await branchSummaryFixture(
      provider,
      SettingsManager.inMemory({
        retry: { maxRetries: 1, baseDelayMs: 0, provider: { maxRetryDelayMs: 0 } },
      }),
    );
    const retryEvents: AgentSessionEvent[] = [];
    session.subscribe((event) => {
      if (event.type.startsWith("summarization_retry_")) retryEvents.push(event);
    });
    try {
      await assert.rejects(
        session.navigateTree(target, { summarize: true }),
        /invalid adapter event/u,
      );
      assert.equal(reads, 0, value.name);
      assert.equal(provider.requests.length, 1, value.name);
      assert.equal(retryEvents.length, 0, value.name);
      assert.equal(manager.getLeafId(), leaf, value.name);
      assert.equal(manager.getEntries().some((entry) => entry.type === "branch_summary"), false, value.name);
    } finally {
      await session.close();
    }
  }
});

test("AgentSession synchronous disposal observes asynchronous close failures", () => {
  let rejectionHandlerAttached = false;
  const failedClose = {
    catch(handler: (reason: unknown) => unknown) {
      rejectionHandlerAttached = true;
      handler(new Error("cleanup failed"));
      return Promise.resolve();
    },
  } as Promise<void>;
  const receiver = { close: () => failedClose } as unknown as AgentSession;

  AgentSession.prototype.dispose.call(receiver);

  assert.equal(rejectionHandlerAttached, true);
});

test("AgentSession bounds terminal assistant content before durable or observed publication", async (t) => {
  const contentBlocks = ASSISTANT_CONTENT_LIMITS.blocks;

  for (const value of [
    { name: "exact", count: contentBlocks, finishReason: "stop" as const },
    { name: "over", count: 10_005, finishReason: "error" as const },
  ]) {
    await t.test(value.name, async () => {
      const cwd = await workspace();
      const content = Array.from({ length: value.count }, (_, index) => ({
        type: "text" as const,
        text: `block-${index}`,
      }));
      const provider = new BranchSummaryEventProvider([
        { type: "response_start", model: "one" },
        {
          type: "response_end",
          reason: "stop",
          state: { kind: "chat_completions", assistantMessage: {} },
          content,
        },
      ]);
      const manager = SessionManager.inMemory(cwd, { id: `terminal-content-${value.name}` });
      const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
      await session.setModel({
        provider: provider.id,
        api: "openai-chat-completions",
        id: "one",
        info: provider.models[0]!,
      });
      const observed: RuntimeEvent[] = [];
      session.onEvent((envelope) => { observed.push(envelope.event); });

      const result = await session.prompt("bounded terminal content", { allowedTools: [] });

      assert.equal(result.results.at(-1)?.finishReason, value.finishReason);
      const durableAssistant = manager.getBranch().flatMap((entry) =>
        entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []).at(-1);
      const observedAssistant = observed.flatMap((event) =>
        event.type === "message_appended" && event.message.role === "assistant" ? [event.message] : []).at(-1);
      assert.ok(durableAssistant);
      assert.ok(observedAssistant);
      assert.equal(durableAssistant.content.length, value.name === "exact" ? contentBlocks : 1);
      assert.equal(observedAssistant.content.length, value.name === "exact" ? contentBlocks : 1);
      assert.equal(durableAssistant.content.every((block) =>
        block.type === "text" && typeof block.text === "string"), true);
      assert.equal(observedAssistant.content.every((block) =>
        block.type === "text" && typeof block.text === "string"), true);
      if (value.name === "over") {
        assert.match(durableAssistant.errorMessage ?? "", /at most 1024 blocks/u);
        assert.equal(manager.getBranch().filter((entry) =>
          entry.type === "message" && "role" in entry.message && entry.message.role === "assistant").length, 1);
      }
      await session.close();
    });
  }
});

test("AgentSession redacts tool payloads without changing a secret-shaped tool name or call ID", async (context) => {
  const directUpdateCarriesArgs: "args" extends keyof ToolExecutionUpdateEvent ? true : false = true;
  const directEndCarriesArgs: "args" extends keyof ToolExecutionEndEvent ? true : false = true;
  const publicUpdateCarriesArgs: "args" extends keyof Extract<AgentSessionEvent, {
    type: "tool_execution_update";
  }> ? true : false = true;
  const publicEndCarriesArgs: "args" extends keyof Extract<AgentSessionEvent, {
    type: "tool_execution_end";
  }> ? true : false = true;
  assert.equal(directUpdateCarriesArgs && directEndCarriesArgs && publicUpdateCarriesArgs && publicEndCarriesArgs, true);
  const cwd = await workspace();
  const toolName = "redaction_identity_tool";
  const callId = "redaction-identity-call";
  const payloadSecret = "redaction-tool-payload-secret";
  const payloadKey = "redaction-tool-payload-key";
  const burstSize = 64;
  defaultSecretRedactor.registerAll([toolName, callId, payloadSecret, payloadKey]);
  let executions = 0;
  const extensionToolEvents: object[] = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "public-tool-redaction",
      factory(api) {
        api.on("tool_execution_start", (event) => { extensionToolEvents.push(structuredClone(event)); });
        api.on("tool_execution_update", (event) => { extensionToolEvents.push(structuredClone(event)); });
        api.on("tool_execution_end", (event) => { extensionToolEvents.push(structuredClone(event)); });
      },
    }],
  });
  context.after(async () => await host.close());
  const tool: HarnessTool = {
    definition: {
      name: toolName,
      description: "Exercise structural event redaction",
      inputSchema: {
        type: "object",
        additionalProperties: true,
        required: ["value"],
        properties: { value: { type: "string" } },
      },
    },
    validate(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.value !== "string") {
        throw new Error("value must be a string");
      }
    },
    resources() { return []; },
    async execute(input, context) {
      executions += 1;
      assert.deepEqual(input, { value: payloadSecret, [payloadKey]: "hidden" });
      for (let index = 0; index < burstSize; index += 1) {
        context.reportProgress?.({
          type: "output",
          stream: index % 2 === 0 ? "stdout" : "stderr",
          delta: `progress ${index} ${payloadSecret}`,
          stdoutBytes: index + 1,
          stderrBytes: index,
        });
      }
      return {
        content: `tool result ${payloadSecret}`,
        isError: false,
        metadata: { payload: payloadSecret, [payloadKey]: "hidden" },
      };
    },
  };
  class StructuralToolProvider extends RecordingProvider {
    override async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
      this.requests.push(structuredClone(request));
      yield { type: "response_start", model: request.model };
      if (this.requests.length === 1) {
        yield { type: "tool_call_start", index: 0, id: callId, name: toolName };
        yield {
          type: "tool_call_end",
          index: 0,
          id: callId,
          name: toolName,
          rawArguments: JSON.stringify({ value: payloadSecret, [payloadKey]: "hidden" }),
          arguments: { value: payloadSecret, [payloadKey]: "hidden" },
        };
        yield {
          type: "response_end",
          reason: "tool_calls",
          state: { kind: "chat_completions", assistantMessage: { turn: 1 } },
        };
        return;
      }
      for (let index = 0; index < burstSize; index += 1) {
        yield { type: "text_delta", part: 0, text: `delta-${index} ` };
      }
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: { turn: 2 } },
      };
    }
  }
  const provider = new StructuralToolProvider();
  const manager = SessionManager.inMemory(cwd, { id: "structural-tool-redaction" });
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    extensionRunner: host,
    tools: [tool],
    allowedToolNames: [toolName],
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });
  const observed: RuntimeEvent[] = [];
  const publicEvents: AgentSessionEvent[] = [];
  const publicStateSnapshots: string[] = [];
  session.onEvent((envelope) => { observed.push(envelope.event); });
  session.subscribe((event) => {
    publicEvents.push(event);
    publicStateSnapshots.push(JSON.stringify({
      streamingMessage: session.state.streamingMessage,
      errorMessage: session.state.errorMessage,
    }));
  });

  const result = await session.prompt("run structural tool redaction", { allowedTools: [toolName] });

  assert.equal(
    result.results.at(-1)?.finalText,
    Array.from({ length: burstSize }, (_, index) => `delta-${index} `).join(""),
  );
  assert.equal(executions, 1);
  const operation = [...manager.getV4State().operations.values()].at(-1);
  assert.equal(operation?.status, "completed");
  assert.deepEqual(operation?.selection.toolNames, [toolName]);
  const effect = [...manager.getV4State().toolEffects.values()].at(-1);
  assert.ok(effect);
  assert.equal(effect.callId, callId);
  assert.equal(effect.toolName, toolName);
  assert.deepEqual(effect.effectiveInput, { value: "[REDACTED]" });
  assert.equal(JSON.stringify(effect.result).includes(payloadSecret), false);
  assert.equal(JSON.stringify(effect.result).includes(payloadKey), false);
  assert.equal(JSON.stringify(effect.result).includes("[REDACTED]"), true);

  const content = manager.getBranch().flatMap((entry) =>
    entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "tool")
      ? entry.message.content
      : []);
  const durableToolCall = content.find((block) => block.type === "tool_call");
  const durableToolResult = content.find((block) => block.type === "tool_result");
  assert.equal(durableToolCall?.type, "tool_call");
  assert.equal(durableToolResult?.type, "tool_result");
  if (durableToolCall?.type !== "tool_call" || durableToolResult?.type !== "tool_result") {
    throw new Error("missing durable tool pair");
  }
  assert.equal(durableToolCall.callId, callId);
  assert.equal(durableToolCall.name, toolName);
  assert.deepEqual(durableToolCall.arguments, { value: "[REDACTED]" });
  assert.equal(durableToolResult.callId, callId);
  assert.equal(durableToolResult.name, toolName);
  assert.equal(durableToolResult.content.includes(payloadSecret), false);
  assert.equal(durableToolResult.content.includes("[REDACTED]"), true);
  assert.deepEqual(durableToolResult.metadata, { payload: "[REDACTED]" });

  let structuralEventCount = 0;
  for (const event of observed) {
    if (!event.type.startsWith("tool_") || !("callId" in event)) continue;
    structuralEventCount += 1;
    assert.equal(event.callId, callId);
    if ("name" in event) assert.equal(event.name, toolName);
  }
  assert.ok(structuralEventCount > 0);
  const progressEvents = observed.filter((event): event is Extract<RuntimeEvent, { type: "tool_progress" }> =>
    event.type === "tool_progress");
  assert.equal(progressEvents.length, burstSize);
  assert.deepEqual(progressEvents.map((event) => event.sequence),
    Array.from({ length: burstSize }, (_, index) => index));
  for (const [index, event] of progressEvents.entries()) {
    assert.equal(event.callId, callId);
    assert.equal(event.name, toolName);
    assert.equal(event.index, 0);
    assert.equal(event.progress.type, "output");
    if (event.progress.type !== "output") throw new Error("unexpected result progress");
    assert.equal(event.progress.stream, index % 2 === 0 ? "stdout" : "stderr");
    assert.equal(event.progress.stdoutBytes, index + 1);
    assert.equal(event.progress.stderrBytes, index);
    assert.equal(event.progress.delta.includes(payloadSecret), false);
  }
  const deltaEvents = observed.filter((event): event is Extract<RuntimeEvent, { type: "text_delta" }> =>
    event.type === "text_delta");
  assert.equal(deltaEvents.length, burstSize);
  assert.equal(deltaEvents.every((event) => event.part === 0), true);
  assert.equal(JSON.stringify(observed).includes(payloadSecret), false);
  assert.equal(JSON.stringify(observed).includes(payloadKey), false);
  assert.equal(JSON.stringify(observed).includes("[REDACTED]"), true);
  const publicToolEvents = publicEvents.filter((event): event is Extract<AgentSessionEvent, {
    type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
  }> =>
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end");
  assert.equal(publicToolEvents.filter((event) => event.type === "tool_execution_start").length, 1);
  assert.equal(publicToolEvents.filter((event) => event.type === "tool_execution_update").length, burstSize);
  assert.equal(publicToolEvents.filter((event) => event.type === "tool_execution_end").length, 1);
  const publicStart = publicToolEvents.find((event) => event.type === "tool_execution_start");
  assert.deepEqual(publicStart?.args, { value: "[REDACTED]" });
  assert.equal(publicToolEvents.filter((event) => event.type !== "tool_execution_start")
    .every((event) => !("args" in event)), true);
  assert.equal(extensionToolEvents.length, burstSize + 2);
  const extensionStart = extensionToolEvents[0];
  assert.deepEqual(extensionStart !== undefined && "args" in extensionStart ? extensionStart.args : undefined,
    { value: payloadSecret, [payloadKey]: "hidden" });
  assert.equal(extensionToolEvents.slice(1).every((event) => !("args" in event)), true);
  const serializedToolEvents = publicToolEvents.map((event) => JSON.stringify(event)).join("\n");
  assert.equal(serializedToolEvents.includes(payloadSecret), false);
  assert.equal(serializedToolEvents.includes(payloadKey), false);
  assert.equal(serializedToolEvents.includes("[REDACTED]"), true);
  const serializedPublicEvents = publicEvents.map((event) => JSON.stringify(event)).join("\n");
  assert.equal(serializedPublicEvents.includes(payloadSecret), false);
  assert.equal(serializedPublicEvents.includes(payloadKey), false);
  assert.equal(serializedPublicEvents.includes("[REDACTED]"), true);
  assert.equal(publicStateSnapshots.some((snapshot) => snapshot.includes(payloadSecret)), false);
  assert.equal(publicStateSnapshots.some((snapshot) => snapshot.includes(payloadKey)), false);
  await session.close();
});

test("AgentSession sanitizes text, custom, and error payloads before public state and serialization", async () => {
  const cwd = await workspace();
  const payloadSecret = "public-message-payload-secret";
  const payloadKey = "public-message-payload-key";
  const customType = "secret-shaped-custom-type";
  const providerError = `provider failure ${payloadSecret} ${"x".repeat(20 * 1024)}`;
  defaultSecretRedactor.registerAll([payloadSecret, payloadKey, customType]);
  class PublicPayloadProvider extends RecordingProvider {
    override async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
      this.requests.push(structuredClone(request));
      if (this.requests.length === 1) {
        yield { type: "response_start", model: request.model };
        yield { type: "text_delta", part: 0, text: `text ${payloadSecret}` };
        yield {
          type: "response_end",
          reason: "stop",
          state: { kind: "chat_completions", assistantMessage: { turn: 1 } },
        };
        return;
      }
      yield {
        type: "error",
        error: {
          category: "provider",
          message: providerError,
          retryable: false,
          partial: false,
          raw: { [payloadKey]: "hidden", value: payloadSecret },
        },
      };
    }
  }
  const provider = new PublicPayloadProvider();
  const manager = SessionManager.inMemory(cwd, { id: "public-message-redaction" });
  const settings = SettingsManager.inMemory();
  settings.setRetryEnabled(false);
  const session = await AgentSession.create({
    sessionManager: manager,
    providers: new ProviderRegistry([provider]),
    settingsManager: settings,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });
  const observed: RuntimeEvent[] = [];
  const publicEvents: AgentSessionEvent[] = [];
  const publicStateSnapshots: string[] = [];
  let sawCustomEntry!: () => void;
  const customEntryObserved = new Promise<void>((resolve) => { sawCustomEntry = resolve; });
  session.onEvent((envelope) => { observed.push(envelope.event); });
  session.subscribe((event) => {
    publicEvents.push(event);
    publicStateSnapshots.push(JSON.stringify({
      streamingMessage: session.state.streamingMessage,
      errorMessage: session.state.errorMessage,
    }));
    if (event.type === "entry_appended" && event.entry.type === "custom_message") sawCustomEntry();
  });

  const completed = await session.prompt("emit text", { allowedTools: [] });
  assert.equal(completed.results.at(-1)?.finishReason, "stop");
  await session.sendCustomMessage({
    customType,
    content: `custom ${payloadSecret}`,
    display: true,
    details: { [payloadKey]: "hidden", value: payloadSecret },
  });
  await customEntryObserved;
  const failed = await session.prompt("emit error", { allowedTools: [] });
  assert.equal(failed.results.at(-1)?.finishReason, "error");

  const customEntry = publicEvents.find((event): event is Extract<AgentSessionEvent, { type: "entry_appended" }> =>
    event.type === "entry_appended" && event.entry.type === "custom_message");
  assert.equal(customEntry?.entry.type, "custom_message");
  if (customEntry?.entry.type !== "custom_message") throw new Error("missing public custom entry");
  assert.equal(customEntry.entry.customType, customType);
  assert.deepEqual(customEntry.entry.content, [{ type: "text", text: "custom [REDACTED]" }]);
  assert.deepEqual(customEntry.entry.details, { value: "[REDACTED]" });
  const failedMessage = publicEvents.findLast((event): event is Extract<AgentSessionEvent, { type: "message_end" }> =>
    event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error");
  assert.equal(failedMessage?.message.role, "assistant");
  if (failedMessage?.message.role !== "assistant") throw new Error("missing public failed assistant message");
  assert.equal(failed.results.at(-1)?.finalText, failedMessage.message.errorMessage);
  assert.equal(Buffer.byteLength(failedMessage.message.errorMessage ?? "", "utf8") <= 16 * 1024, true);
  assert.equal(failedMessage.message.errorMessage?.includes(payloadSecret), false);
  assert.equal(session.state.errorMessage, failedMessage.message.errorMessage);

  const serializedPublicEvents = publicEvents.map((event) => JSON.stringify(event)).join("\n");
  assert.equal(serializedPublicEvents.includes(payloadSecret), false);
  assert.equal(serializedPublicEvents.includes(payloadKey), false);
  assert.equal(serializedPublicEvents.includes("[REDACTED]"), true);
  assert.equal(publicStateSnapshots.some((snapshot) => snapshot.includes(payloadSecret)), false);
  assert.equal(publicStateSnapshots.some((snapshot) => snapshot.includes(payloadKey)), false);
  assert.equal(JSON.stringify(observed).includes(payloadSecret), false);
  assert.equal(JSON.stringify(observed).includes(payloadKey), false);
  const durableProviderMessages = manager.getBranch().filter((entry) =>
    entry.type === "message" && !("custom" in entry.message && entry.message.custom !== undefined));
  assert.equal(JSON.stringify(durableProviderMessages).includes(payloadSecret), false);
  assert.equal(JSON.stringify(durableProviderMessages).includes(payloadKey), false);
  assert.deepEqual([...manager.getV4State().operations.values()].map((operation) => operation.status), [
    "completed",
    "failed",
  ]);
  await session.close();
});

test("AgentSession redacts a compaction payload without changing its secret-shaped kept-message identity", async () => {
  const cwd = await workspace();
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "structural-compaction-redaction" });
  const firstKeptEntryId = seedCompactableHistory(manager, provider);
  const firstKeptMessageId = "seed-user-4";
  const payloadSecret = "redaction-compaction-payload-secret";
  defaultSecretRedactor.registerAll([firstKeptMessageId, payloadSecret]);
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "structural-compaction-redaction",
      factory(api) {
        api.on("session_before_compact", () => ({
          compaction: {
            summary: `extension summary ${payloadSecret}`,
            firstKeptEntryId,
            tokensBefore: 410,
          },
        }));
      },
    }],
  });
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    extensionRunner: host,
    compactionReserveTokens: 200,
    compactionRecentTokens: 200,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: { ...provider.models[0]!, contextTokens: 10_000 },
  });
  const observed: Array<Extract<RuntimeEvent, { type: "compaction_completed" }>> = [];
  session.onEvent((envelope) => {
    if (envelope.event.type === "compaction_completed") observed.push(envelope.event);
  });

  await session.compact();

  const compaction = manager.getBranch().findLast((entry) => entry.type === "compaction");
  assert.equal(compaction?.type, "compaction");
  if (compaction?.type !== "compaction") throw new Error("missing compaction entry");
  assert.equal(compaction.firstKeptEntryId, firstKeptEntryId);
  assert.equal(compaction.summary.includes(payloadSecret), false);
  assert.equal(compaction.summary.includes("[REDACTED]"), true);
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.firstKeptMessageId, firstKeptMessageId);
  assert.equal(observed[0]?.sourceMessageIds.includes(firstKeptMessageId), false);
  assert.equal(observed[0]?.summary.content.some((block) =>
    block.type === "text" && block.text.includes(payloadSecret)), false);
  assert.equal(JSON.stringify(observed[0]).includes("[REDACTED]"), true);
  await session.close();
  await host.close();
});

test("AgentSession redacts message payloads without changing secret-shaped generated message IDs", async () => {
  const cwd = await workspace();
  const payloadSecret = "redaction-message-payload-secret";
  defaultSecretRedactor.registerAll(["msg_", payloadSecret]);
  const provider = new RecordingProvider();
  const manager = SessionManager.inMemory(cwd, { id: "structural-message-redaction" });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "one",
    info: provider.models[0]!,
  });
  const observed: Array<Extract<RuntimeEvent, { type: "message_appended" }>> = [];
  session.onEvent((envelope) => {
    if (envelope.event.type === "message_appended") observed.push(envelope.event);
  });

  await session.prompt(`message payload ${payloadSecret}`, { allowedTools: [] });

  const state = manager.getV4State();
  const operation = [...state.operations.values()].at(-1);
  assert.ok(operation);
  assert.equal(operation.status, "completed");
  assert.match(operation.promptNodeId ?? "", /^msg_/u);
  assert.equal(state.nodes.has(operation.promptNodeId ?? ""), true);
  assert.ok(observed.length >= 2);
  for (const event of observed) {
    assert.match(event.message.id, /^msg_/u);
    assert.equal(state.nodes.has(event.message.id), true);
  }
  assert.equal(JSON.stringify(observed).includes(payloadSecret), false);
  assert.equal(JSON.stringify(observed).includes("[REDACTED]"), true);
  assert.equal(JSON.stringify([...state.nodes.values()]).includes(payloadSecret), false);
  await session.close();
});

test("context-only prepare-next-turn hooks keep the accepted tuple during a concurrent user switch", async () => {
  const cwd = await workspace();
  const provider = new PrepareNextTurnProvider(1);
  const manager = SessionManager.inMemory(cwd, { id: "context-only-selection-race" });
  const firstInfo: ModelInfo = {
    ...model(provider.id, "one", "openai-chat-completions"),
    compatibility: {
      ...model(provider.id, "one", "openai-chat-completions").compatibility,
      reasoningEfforts: { value: ["off", "low"], source: "provider", observedAt },
    },
  };
  const secondInfo: ModelInfo = {
    ...model(provider.id, "two", "openai-chat-completions"),
    compatibility: {
      ...model(provider.id, "two", "openai-chat-completions").compatibility,
      reasoningEfforts: { value: ["off", "max"], source: "provider", observedAt },
    },
  };
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: firstInfo.id, info: firstInfo });
  session.setThinkingLevel("low");
  let enterHook!: () => void;
  let releaseHook!: () => void;
  const hookEntered = new Promise<void>((resolve) => { enterHook = resolve; });
  const hookRelease = new Promise<void>((resolve) => { releaseHook = resolve; });
  session.agent.prepareNextTurn = async () => {
    enterHook();
    await hookRelease;
    return {
      context: {
        systemPrompt: session.agent.state.systemPrompt,
        messages: session.agent.state.messages,
      },
    };
  };

  const active = session.prompt("first operation", { allowedTools: ["ls"] });
  await hookEntered;
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: secondInfo.id, info: secondInfo });
  session.setThinkingLevel("max");
  releaseHook();
  await active;

  assert.deepEqual(provider.requests.map((request) => [request.model, request.reasoningEffort]), [
    [firstInfo.id, "low"],
    [firstInfo.id, "low"],
  ]);
  assert.deepEqual([...manager.getV4State().operations.values()].map((operation) => [
    operation.selection.model,
    operation.selection.thinkingLevel,
  ]), [[firstInfo.id, "low"]]);
  assert.equal(session.nativeModel?.id, secondInfo.id);
  assert.equal(session.thinkingLevel, "max");
  await session.prompt("next operation", { allowedTools: [] });
  assert.deepEqual(
    [provider.requests[2]?.model, provider.requests[2]?.reasoningEffort],
    [secondInfo.id, "max"],
  );
  await session.close();
});

test("queued operations accept the tool snapshot installed by prepare-next-turn", async () => {
  const cwd = await workspace();
  const provider = new PrepareNextTurnProvider(1);
  const manager = SessionManager.inMemory(cwd, { id: "queued-tool-selection" });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: provider.models[0]!.id,
    info: provider.models[0]!,
  });
  const readTool = session.agent.state.tools.find((tool) => tool.name === "read");
  assert.ok(readTool);
  let enterHook!: () => void;
  let releaseHook!: () => void;
  const hookEntered = new Promise<void>((resolve) => { enterHook = resolve; });
  const hookRelease = new Promise<void>((resolve) => { releaseHook = resolve; });
  session.agent.prepareNextTurn = async () => {
    enterHook();
    await hookRelease;
    return {
      context: {
        systemPrompt: session.agent.state.systemPrompt,
        messages: session.agent.state.messages,
        tools: [readTool],
      },
    };
  };

  const active = session.prompt("replace tools", { allowedTools: ["ls"] });
  await hookEntered;
  await session.followUp("use the replaced tools");
  const queuedEntry = [...manager.getV4State().queue.values()].at(-1);
  assert.ok(queuedEntry);
  releaseHook();
  await active;

  assert.deepEqual(provider.requests.map((request) => request.tools?.map((tool) => tool.name)), [
    ["ls"],
    ["read"],
    ["read"],
  ]);
  const operations = [...manager.getV4State().operations.values()];
  assert.deepEqual(operations.map((operation) => operation.selection.toolNames), [["ls"], ["read"]]);
  assert.equal(manager.getV4State().queue.get(queuedEntry.id)?.status, "consumed");
  await session.close();
});

test("explicit prepare-next-turn selections persist and remain local across later hook turns", async () => {
  const cwd = await workspace();
  const provider = new PrepareNextTurnProvider(2);
  const manager = SessionManager.inMemory(cwd, { id: "owned-hook-selection" });
  const firstInfo: ModelInfo = {
    ...model(provider.id, "one", "openai-chat-completions"),
    compatibility: {
      ...model(provider.id, "one", "openai-chat-completions").compatibility,
      reasoningEfforts: { value: ["off", "low", "high"], source: "provider", observedAt },
    },
  };
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: firstInfo.id, info: firstInfo });
  session.setThinkingLevel("low");
  const nextModel = { ...session.agent.state.model, id: "hook", name: "hook" };
  let hooks = 0;
  session.agent.prepareNextTurn = () => {
    hooks += 1;
    return hooks === 1
      ? { model: nextModel, thinkingLevel: "high" }
      : {
          context: {
            systemPrompt: session.agent.state.systemPrompt,
            messages: session.agent.state.messages,
          },
        };
  };

  await session.prompt("tool turns", { allowedTools: ["ls"] });

  assert.deepEqual(provider.requests.map((request) => [request.model, request.reasoningEffort]), [
    [firstInfo.id, "low"],
    [nextModel.id, "high"],
    [nextModel.id, "high"],
  ]);
  assert.equal(session.nativeModel?.id, nextModel.id);
  assert.equal(session.thinkingLevel, "high");
  await session.close();
});

test("late explicit prepare-next-turn selections stay transient after a newer user selection", async () => {
  const cwd = await workspace();
  const provider = new PrepareNextTurnProvider(2);
  const manager = SessionManager.inMemory(cwd, { id: "transient-hook-selection" });
  const firstInfo: ModelInfo = {
    ...model(provider.id, "one", "openai-chat-completions"),
    compatibility: {
      ...model(provider.id, "one", "openai-chat-completions").compatibility,
      reasoningEfforts: { value: ["off", "low", "high"], source: "provider", observedAt },
    },
  };
  const userInfo: ModelInfo = {
    ...model(provider.id, "user", "openai-chat-completions"),
    compatibility: {
      ...model(provider.id, "user", "openai-chat-completions").compatibility,
      reasoningEfforts: { value: ["off", "max"], source: "provider", observedAt },
    },
  };
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: firstInfo.id, info: firstInfo });
  session.setThinkingLevel("low");
  const hookModel = { ...session.agent.state.model, id: "hook", name: "hook" };
  let enterHook!: () => void;
  let releaseHook!: () => void;
  const hookEntered = new Promise<void>((resolve) => { enterHook = resolve; });
  const hookRelease = new Promise<void>((resolve) => { releaseHook = resolve; });
  let hooks = 0;
  session.agent.prepareNextTurn = async () => {
    hooks += 1;
    if (hooks === 1) {
      enterHook();
      await hookRelease;
      return { model: hookModel, thinkingLevel: "high" };
    }
    return {
      context: {
        systemPrompt: session.agent.state.systemPrompt,
        messages: session.agent.state.messages,
      },
    };
  };

  const active = session.prompt("first operation", { allowedTools: ["ls"] });
  await hookEntered;
  await session.followUp("queued operation");
  await session.setModel({ provider: provider.id, api: "openai-chat-completions", id: userInfo.id, info: userInfo });
  session.setThinkingLevel("max");
  releaseHook();
  await active;

  assert.deepEqual(provider.requests.map((request) => [request.model, request.reasoningEffort]), [
    [firstInfo.id, "low"],
    [hookModel.id, "high"],
    [hookModel.id, "high"],
    [userInfo.id, "max"],
  ]);
  assert.deepEqual([...manager.getV4State().operations.values()].map((operation) => [
    operation.selection.model,
    operation.selection.thinkingLevel,
  ]), [
    [firstInfo.id, "low"],
    [userInfo.id, "max"],
  ]);
  assert.equal(session.nativeModel?.id, userInfo.id);
  assert.equal(session.thinkingLevel, "max");
  assert.deepEqual(manager.buildSessionContext().model, {
    provider: provider.id,
    modelId: userInfo.id,
  });
  await session.close();
});

test("mid-turn model and thinking changes leave the active request stable and apply to the next turn", async () => {
  const cwd = await workspace();
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstModel: ModelInfo = {
    ...model("mid-turn-selection", "one", "openai-chat-completions"),
    compatibility: {
      ...model("mid-turn-selection", "one", "openai-chat-completions").compatibility,
      reasoningEfforts: { value: ["off", "high"], source: "provider", observedAt },
    },
  };
  const secondModel: ModelInfo = {
    ...model("mid-turn-selection", "two", "openai-chat-completions"),
    compatibility: {
      ...model("mid-turn-selection", "two", "openai-chat-completions").compatibility,
      reasoningEfforts: { value: ["low", "max"], source: "provider", observedAt },
    },
  };
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    id: "mid-turn-selection",
    async *stream(request) {
      requests.push(structuredClone(request));
      yield { type: "response_start", model: request.model };
      if (requests.length === 1) {
        markFirstStarted();
        await release;
      }
      yield { type: "text_delta", part: 0, text: `answer-${request.model}` };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: { model: request.model } },
      };
    },
    async listModels() { return [firstModel, secondModel]; },
  };
  const manager = SessionManager.inMemory(cwd, { id: "mid-turn-selection" });
  const session = await AgentSession.create(sessionOptions(manager, new ProviderRegistry([provider])));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: firstModel.id,
    info: firstModel,
  });
  session.setThinkingLevel("high");

  const active = session.prompt("first turn", { allowedTools: [] });
  await firstStarted;
  await session.followUp("queued second turn");
  await session.followUp("queued third turn");
  const queuedEntries = [...manager.getV4State().queue.values()];
  assert.deepEqual(queuedEntries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    status: entry.status,
    text: (entry.message as { text?: unknown }).text,
  })), queuedEntries.map((entry, index) => ({
    id: entry.id,
    kind: "follow_up",
    status: "queued",
    text: index === 0 ? "queued second turn" : "queued third turn",
  })));
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: secondModel.id,
    info: secondModel,
  });
  session.setThinkingLevel("max");
  assert.equal(session.model?.id, secondModel.id);
  assert.equal(session.thinkingLevel, "max");
  releaseFirst();
  await active;

  assert.equal(requests[0]?.model, firstModel.id);
  assert.equal(requests[0]?.reasoningEffort, "high");
  assert.equal(requests[1]?.model, secondModel.id);
  assert.equal(requests[1]?.reasoningEffort, "max");
  assert.equal(requests[2]?.model, secondModel.id);
  assert.equal(requests[2]?.reasoningEffort, "max");
  const accepted = [...manager.getV4State().operations.values()];
  assert.deepEqual(accepted.map((operation) => ({
    model: operation.selection.model,
    thinkingLevel: operation.selection.thinkingLevel,
    toolNames: operation.selection.toolNames,
  })), [
    { model: firstModel.id, thinkingLevel: "high", toolNames: [] },
    { model: secondModel.id, thinkingLevel: "max", toolNames: [] },
    { model: secondModel.id, thinkingLevel: "max", toolNames: [] },
  ]);
  assert.deepEqual(queuedEntries.map((entry, index) => {
    const current = manager.getV4State().queue.get(entry.id);
    return {
      id: current?.id,
      status: current?.status,
      operationId: current?.operationId,
      promptNodeId: accepted[index + 1]?.promptNodeId,
      targetNodeId: current?.targetNodeId,
    };
  }), queuedEntries.map((entry, index) => ({
    id: entry.id,
    status: "consumed",
    operationId: accepted[index + 1]?.id,
    promptNodeId: accepted[index + 1]?.promptNodeId,
    targetNodeId: accepted[index + 1]?.promptNodeId,
  })));
  await session.prompt("fourth turn", { allowedTools: [] });
  assert.equal(requests[3]?.model, secondModel.id);
  assert.equal(requests[3]?.reasoningEffort, "max");
  const assistantModels = manager.getBranch().flatMap((entry) =>
    entry.type === "message" && entry.message.role === "assistant"
      ? [entry.message.model]
      : []);
  assert.deepEqual(assistantModels, [firstModel.id, secondModel.id, secondModel.id, secondModel.id]);
  await session.close();
});

test("model changes during metadata lookup cannot split one accepted run tuple", async () => {
  const cwd = await workspace();
  let markLookupStarted!: () => void;
  let releaseLookup!: () => void;
  const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve; });
  const lookupRelease = new Promise<void>((resolve) => { releaseLookup = resolve; });
  const firstInfo: ModelInfo = {
    ...model("selection-race", "one", "openai-chat-completions"),
    contextTokens: 10_000,
    compatibility: {
      ...model("selection-race", "one", "openai-chat-completions").compatibility,
      reasoningEfforts: { value: ["off", "high"], source: "provider", observedAt },
    },
  };
  const secondBase = model("selection-race", "two", "openai-chat-completions");
  const secondInfo: ModelInfo = {
    ...secondBase,
    capabilities: {
      ...secondBase.capabilities,
      reasoning: { value: "unsupported", source: "provider", observedAt },
    },
  };
  const nativeModels = createModels();
  nativeModels.setProvider(createProvider({
    id: "selection-race",
    auth: {
      apiKey: {
        name: "Fixture key",
        async resolve() { return { auth: { apiKey: "fixture" }, source: "fixture" }; },
      },
    },
    models: [
      {
        id: "one",
        name: "one",
        api: "openai-chat-completions",
        provider: "selection-race",
        baseUrl: "https://example.test/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 8_000,
      },
      {
        id: "two",
        name: "two",
        api: "openai-chat-completions",
        provider: "selection-race",
        baseUrl: "https://example.test/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 8_000,
      },
    ],
    api: { async *stream() {} },
  }));
  const modelRegistry = new ModelRegistry(nativeModels);
  await modelRegistry.refresh();
  const requests: ProviderRequest[] = [];
  let lookupCount = 0;
  const provider: ProviderAdapter = {
    id: "selection-race",
    async *stream(request) {
      requests.push(structuredClone(request));
      yield { type: "response_start", model: request.model };
      yield { type: "text_delta", part: 0, text: `answer-${request.model}` };
      yield {
        type: "usage",
        semantics: "final",
        usage: requests.length === 1
          ? { inputTokens: 10_000, outputTokens: 1, totalTokens: 10_001 }
          : { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: { model: request.model } },
      };
    },
    async listModels() {
      lookupCount += 1;
      markLookupStarted();
      await lookupRelease;
      return [firstInfo, secondInfo];
    },
  };
  const manager = SessionManager.inMemory(cwd, { id: "selection-race" });
  const session = await AgentSession.create({
    ...sessionOptions(manager, new ProviderRegistry([provider])),
    modelRegistry,
    compactionReserveTokens: 200,
    compactionRecentTokens: 200,
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: firstInfo.id,
  });
  session.setThinkingLevel("high");

  const active = session.prompt("first turn", { allowedTools: [] });
  await lookupStarted;
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: secondInfo.id,
    info: secondInfo,
  });
  assert.equal(session.model?.id, secondInfo.id);
  assert.equal(session.thinkingLevel, "off");
  releaseLookup();
  await active;

  assert.equal(lookupCount, 1);
  assert.equal(requests[0]?.model, firstInfo.id);
  assert.equal(requests[0]?.reasoningEffort, "high");
  const firstOperations = [...manager.getV4State().operations.values()];
  assert.equal(firstOperations.length, 2);
  const firstOperation = firstOperations[0];
  assert.equal(firstOperation?.selection.provider, provider.id);
  assert.equal(firstOperation?.selection.model, firstInfo.id);
  assert.equal(firstOperation?.selection.api, "openai-chat-completions");
  assert.equal(firstOperation?.selection.thinkingLevel, "high");
  const compactionOperation = firstOperations[1];
  assert.equal(compactionOperation?.selection.provider, provider.id);
  assert.equal(compactionOperation?.selection.model, firstInfo.id);
  assert.equal(compactionOperation?.selection.api, "openai-chat-completions");
  assert.equal(compactionOperation?.selection.thinkingLevel, "high");
  assert.equal(manager.getBranch().flatMap((entry) =>
    entry.type === "message" && entry.message.role === "assistant"
      ? [entry.message.model]
      : []).at(-1), firstInfo.id);

  await session.prompt("second turn", { allowedTools: [] });
  assert.equal(requests[2]?.model, secondInfo.id);
  assert.equal(requests[2]?.reasoningEffort, undefined);
  const secondOperation = [...manager.getV4State().operations.values()].at(-1);
  assert.equal(secondOperation?.selection.model, secondInfo.id);
  assert.equal(secondOperation?.selection.thinkingLevel, "off");
  assert.deepEqual(manager.getBranch().flatMap((entry) =>
    entry.type === "message" && entry.message.role === "assistant"
      ? [entry.message.model]
      : []), [firstInfo.id, secondInfo.id]);
  await session.close();
});

test("prepare-next-turn selections update model attribution for each tool step", async () => {
  const cwd = await workspace();
  const providerId = "dynamic-tool-context";
  const reasoningEfforts = {
    value: ["low", "high"],
    source: "provider" as const,
    observedAt,
  };
  const models = ["one", "two"].map((id): ModelInfo => ({
    ...model(providerId, id, "openai-chat-completions"),
    compatibility: {
      protocolFamily: {
        value: "openai-chat-completions",
        source: "provider",
        observedAt,
      },
      reasoningEfforts,
    },
  }));
  let requests = 0;
  const provider: ProviderAdapter = {
    id: providerId,
    async *stream(request) {
      requests += 1;
      yield { type: "response_start", model: request.model };
      if (requests <= 2) {
        const callId = `dynamic-context-${requests}`;
        yield { type: "tool_call_start", index: 0, id: callId, name: "context_probe" };
        yield {
          type: "tool_call_end",
          index: 0,
          id: callId,
          name: "context_probe",
          rawArguments: "{}",
          arguments: {},
        };
        yield {
          type: "response_end",
          reason: "tool_calls",
          state: { kind: "chat_completions", assistantMessage: { request: requests } },
        };
        return;
      }
      yield { type: "text_delta", part: 0, text: "done" };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: { request: requests } },
      };
    },
    async listModels() { return models; },
  };
  const contexts: Array<{
    provider: string | undefined;
    modelId: string | undefined;
    reasoningLevel: string | undefined;
    step: number | undefined;
  }> = [];
  const probe: HarnessTool = {
    definition: {
      name: "context_probe",
      description: "Record the active model attribution",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    validate() {},
    resources: () => [],
    async execute(_input, context) {
      contexts.push({
        provider: context.provider,
        modelId: context.modelId,
        reasoningLevel: context.reasoningLevel,
        step: context.step,
      });
      return { content: "recorded", isError: false };
    },
  };
  const session = await AgentSession.create({
    ...sessionOptions(SessionManager.inMemory(cwd), new ProviderRegistry([provider])),
    tools: [probe],
  });
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: models[0]!.id,
    info: models[0]!,
  });
  session.setThinkingLevel("low");
  let prepared = false;
  session.agent.prepareNextTurn = () => {
    if (prepared) return;
    prepared = true;
    return {
      model: { ...session.agent.state.model, id: models[1]!.id, name: models[1]!.id },
      thinkingLevel: "high",
    };
  };

  await session.prompt("probe every selected turn", { allowedTools: ["context_probe"] });

  assert.deepEqual(contexts, [
    { provider: providerId, modelId: "one", reasoningLevel: "low", step: 1 },
    { provider: providerId, modelId: "two", reasoningLevel: "high", step: 2 },
  ]);
  await session.close();
});
