import type { EventEnvelope, RuntimeEvent } from "../core/events.js";
import type { AgentRunResult } from "../core/agent.js";
import type {
  CanonicalMessage,
  ImageBlock,
  OutboundImagePolicy,
  ProviderAdapter,
  ProviderId,
} from "../core/types.js";
import { ProviderRegistry } from "../providers/registry.js";
import {
  createHarnessRuntime,
  type CreateHarnessRuntimeOptions,
  type HarnessRuntime,
} from "../public-runtime.js";
import {
  HarnessService,
  type HarnessRun,
  type NavigateTreeResult,
  type RunOptions,
} from "../service/harness.js";
import type { HarnessResourceCatalog } from "../service/resource-catalog.js";
import type { HarnessSessionListRequest, HarnessSessionPage } from "../service/session-catalog.js";
import type { HarnessTranscriptPage, HarnessTranscriptRequest } from "../service/transcript.js";
import { SessionStore } from "../storage/store.js";
import type { HarnessTool } from "../tools/types.js";

const DEFAULT_IN_MEMORY_TIMEOUT_MS = 30_000;
const MAX_IN_MEMORY_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_IN_MEMORY_MAX_STEPS = 16;

export interface EmbeddingRunOptions {
  prompt: string;
  provider: ProviderId;
  model: string;
  signal?: AbortSignal;
  displayPrompt?: string;
  images?: ImageBlock[];
  outboundImages?: OutboundImagePolicy;
  autoCompaction?: boolean;
  threadId?: string;
  branch?: string;
  cwd?: string;
  maxSteps?: number;
  maxOutputTokens?: number;
  contextTokenBudget?: number;
  summaryTokenBudget?: number;
  reasoningEffort?: string;
  allowedTools?: string[];
  excludedTools?: string[];
  noBuiltinTools?: boolean;
  noContextFiles?: boolean;
  onEvent?: (event: EventEnvelope) => Promise<void> | void;
  additionalInstructions?: { text: string; source: string };
  systemPrompt?: { text: string; source: string };
  appendSystemPrompt?: Array<{ text: string; source: string }>;
}

export interface EmbeddingRunHandle {
  readonly threadId: string;
  readonly result: Promise<HarnessRun>;
  cancel(reason?: string): void;
  cancelRetry(): boolean;
}

export interface EmbeddingModelSelection {
  provider: ProviderId;
  model: string;
  reasoningEffort?: string;
}

export interface EmbeddingSessionRunOptions extends Omit<
  EmbeddingRunOptions,
  "provider" | "model" | "threadId" | "branch"
> {
  selection?: EmbeddingModelSelection;
}

export interface EmbeddingSessionCreateOptions {
  name?: string;
  defaultBranch?: string;
  cwd?: string;
  signal?: AbortSignal;
}

export interface EmbeddingSessionOpenOptions {
  threadId: string;
  branch?: string;
  signal?: AbortSignal;
}

export interface EmbeddingSessionForkOptions {
  atEventId?: string | null;
  beforeEventId?: string;
  name?: string;
  signal?: AbortSignal;
}

export interface EmbeddingSessionCompactOptions {
  selection?: EmbeddingModelSelection;
  signal?: AbortSignal;
  instructions?: string;
  maxSteps?: number;
  maxOutputTokens?: number;
  contextTokenBudget?: number;
  summaryTokenBudget?: number;
}

export interface EmbeddingSessionNavigateOptions {
  targetBranch: string;
  targetEventId: string | null;
  newBranch: string;
  summarize?: boolean;
  selection?: Pick<EmbeddingModelSelection, "provider" | "model">;
  summaryTokenBudget?: number;
  summaryInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
  signal?: AbortSignal;
}

export interface EmbeddingSessionNavigateResult {
  cancelled: boolean;
  branch?: string;
  summaryEventId?: string;
}

export type EmbeddingSessionEventListener = (event: EventEnvelope) => Promise<void> | void;

/** A session-oriented application facade. It exposes no credentials, registries, stores, or raw service objects. */
export interface EmbeddingSession {
  readonly threadId: string;
  readonly branch: string;
  start(options: EmbeddingSessionRunOptions): Promise<EmbeddingRunHandle>;
  run(options: EmbeddingSessionRunOptions): Promise<HarnessRun>;
  steer(message: string, images?: ImageBlock[]): void;
  followUp(message: string, images?: ImageBlock[]): void;
  abort(reason?: string): void;
  compact(options?: EmbeddingSessionCompactOptions): Promise<AgentRunResult>;
  fork(options?: EmbeddingSessionForkOptions): Promise<EmbeddingSession>;
  navigate(options: EmbeddingSessionNavigateOptions): Promise<EmbeddingSessionNavigateResult>;
  transcript(input?: Omit<HarnessTranscriptRequest, "threadId" | "branch">): Promise<HarnessTranscriptPage>;
  setName(name?: string, signal?: AbortSignal): Promise<void>;
  getModel(): EmbeddingModelSelection | undefined;
  setModel(selection: EmbeddingModelSelection, signal?: AbortSignal): Promise<EmbeddingModelSelection>;
  subscribe(listener: EmbeddingSessionEventListener): () => void;
}

/** A task-focused owner. It intentionally exposes no credential, provider-registry, store, or service objects. */
export interface EmbeddingHarness {
  start(options: EmbeddingRunOptions): Promise<EmbeddingRunHandle>;
  run(options: EmbeddingRunOptions): Promise<HarnessRun>;
  createSession(options?: EmbeddingSessionCreateOptions): Promise<EmbeddingSession>;
  openSession(options: EmbeddingSessionOpenOptions): Promise<EmbeddingSession>;
  listSessions(options?: HarnessSessionListRequest): Promise<HarnessSessionPage>;
  waitForIdle(signal?: AbortSignal): Promise<void>;
  resourceCatalog(signal?: AbortSignal): Promise<HarnessResourceCatalog>;
  reload(options?: { signal?: AbortSignal }): Promise<{ warnings: string[] }>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface InMemoryModelSelection {
  provider: ProviderId;
  model: string;
}

export interface CreateInMemoryHarnessOptions {
  /** The default adapter. Injected adapters remain owned by the caller. */
  provider: ProviderAdapter;
  /** Exact default model ID for `provider`. */
  model: string;
  /** Additional adapters available through an explicit per-run selection. */
  additionalProviders?: readonly ProviderAdapter[];
  /** Optional host tools. Built-in filesystem and shell tools remain disabled. */
  tools?: readonly HarnessTool[];
  /** Existing boundary root used only for session identity and injected tools. */
  workspace?: string;
  /** Hard deadline applied independently to every run. */
  timeoutMs?: number;
  /** Default bounded agent-step count. */
  maxSteps?: number;
}

export interface InMemoryRunOptions extends Omit<
  EmbeddingRunOptions,
  "provider" | "model" | "cwd" | "noBuiltinTools" | "noContextFiles"
> {
  /** Omit to use the factory's exact default provider/model pair. */
  selection?: InMemoryModelSelection;
}

/** An isolated test owner backed by one in-memory SQLite database. */
export interface InMemoryHarness {
  start(options: InMemoryRunOptions): Promise<EmbeddingRunHandle>;
  run(options: InMemoryRunOptions): Promise<HarnessRun>;
  waitForIdle(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function embeddingMessage(message: CanonicalMessage): CanonicalMessage {
  return {
    ...message,
    content: message.content.filter((block) => block.type !== "provider_opaque"),
  };
}

function embeddingRuntimeEvent(event: RuntimeEvent): RuntimeEvent | undefined {
  if (event.type === "message_appended") {
    return {
      type: "message_appended",
      message: embeddingMessage(event.message),
      ...(event.toolDefinitionFingerprint === undefined
        ? {}
        : { toolDefinitionFingerprint: event.toolDefinitionFingerprint }),
    };
  }
  if (event.type === "reasoning_delta" && event.visibility === "provider_trace") return undefined;
  if (event.type === "usage") {
    const { raw: _raw, ...usage } = event.usage;
    return { ...event, usage };
  }
  if (event.type === "run_failed" && "retryable" in event.error) {
    const { raw: _raw, ...error } = event.error;
    return { ...event, error };
  }
  if (event.type === "compaction_completed") {
    return { ...event, summary: embeddingMessage(event.summary) };
  }
  if (event.type === "branch_summary_created") {
    return { ...event, summary: embeddingMessage(event.summary) };
  }
  return event;
}

function embeddingSessionEvent(envelope: EventEnvelope): EventEnvelope | undefined {
  const event = embeddingRuntimeEvent(envelope.event);
  return event === undefined ? undefined : { ...envelope, event };
}

async function settleWithSignal(operation: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    await operation;
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(() => resolve(), reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

class ConfiguredEmbeddingHarness implements EmbeddingHarness {
  readonly #runtime: HarnessRuntime;
  readonly #sessionOperations = new Set<Promise<unknown>>();
  readonly #sessions = new Set<ConfiguredEmbeddingSession>();
  #closing: Promise<void> | undefined;

  constructor(runtime: HarnessRuntime) {
    this.#runtime = runtime;
  }

  async start(options: EmbeddingRunOptions): Promise<EmbeddingRunHandle> {
    this.#assertOpen();
    return await this.#runtime.start(options);
  }

  async run(options: EmbeddingRunOptions): Promise<HarnessRun> {
    this.#assertOpen();
    return await this.#runtime.run(options);
  }

  async createSession(options: EmbeddingSessionCreateOptions = {}): Promise<EmbeddingSession> {
    this.#assertOpen();
    return await this.#track((async () => {
      const thread = await this.#runtime.service.createSession(options);
      return this.#session(thread.threadId, thread.defaultBranch);
    })());
  }

  async openSession(options: EmbeddingSessionOpenOptions): Promise<EmbeddingSession> {
    this.#assertOpen();
    return await this.#track((async () => {
      options.signal?.throwIfAborted();
      const thread = this.#runtime.store.bindThreadWorkspace(options.threadId, this.#runtime.workspace);
      const branch = options.branch ?? thread.defaultBranch;
      await this.#runtime.service.getTranscript({
        threadId: options.threadId,
        branch,
        limit: 1,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return this.#session(options.threadId, branch);
    })());
  }

  async listSessions(options: HarnessSessionListRequest = {}): Promise<HarnessSessionPage> {
    this.#assertOpen();
    return await this.#track(this.#runtime.service.listSessions(options));
  }

  async waitForIdle(signal?: AbortSignal): Promise<void> {
    this.#assertOpen();
    while (true) {
      await this.#runtime.waitForIdle(signal);
      const operations = [...this.#sessionOperations];
      if (operations.length === 0) return;
      await settleWithSignal(Promise.allSettled(operations).then(() => undefined), signal);
      if (this.#sessionOperations.size === 0) return;
    }
  }

  async resourceCatalog(signal?: AbortSignal): Promise<HarnessResourceCatalog> {
    this.#assertOpen();
    return await this.#runtime.resourceCatalog(signal);
  }

  async reload(options: { signal?: AbortSignal } = {}): Promise<{ warnings: string[] }> {
    this.#assertOpen();
    return await this.#runtime.reload(options);
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    this.#sessionOperations.add(operation);
    void operation.finally(() => this.#sessionOperations.delete(operation)).catch(() => undefined);
    return operation;
  }

  #session(threadId: string, branch: string): EmbeddingSession {
    this.#assertOpen();
    const session = new ConfiguredEmbeddingSession(
      this.#runtime,
      threadId,
      branch,
      <T>(operation: Promise<T>) => this.#track(operation),
      async (options) => await this.openSession(options),
    );
    this.#sessions.add(session);
    return session;
  }

  #assertOpen(): void {
    if (this.#closing !== undefined) throw new Error("Embedding harness is closing");
  }

  async #close(): Promise<void> {
    for (const session of this.#sessions) session.invalidate();
    this.#sessions.clear();
    try {
      await this.#runtime.close();
    } finally {
      while (this.#sessionOperations.size > 0) {
        await Promise.allSettled([...this.#sessionOperations]);
      }
    }
  }
}

class ConfiguredEmbeddingSession implements EmbeddingSession {
  readonly threadId: string;
  readonly branch: string;
  readonly #runtime: HarnessRuntime;
  readonly #track: <T>(operation: Promise<T>) => Promise<T>;
  readonly #open: (options: EmbeddingSessionOpenOptions) => Promise<EmbeddingSession>;
  readonly #listeners = new Set<EmbeddingSessionEventListener>();
  #active = true;

  constructor(
    runtime: HarnessRuntime,
    threadId: string,
    branch: string,
    track: <T>(operation: Promise<T>) => Promise<T>,
    open: (options: EmbeddingSessionOpenOptions) => Promise<EmbeddingSession>,
  ) {
    this.#runtime = runtime;
    this.threadId = threadId;
    this.branch = branch;
    this.#track = track;
    this.#open = open;
  }

  async start(options: EmbeddingSessionRunOptions): Promise<EmbeddingRunHandle> {
    this.#assertOpen();
    return await this.#track((async () => {
      const selection = await this.#selection(options.selection, options.signal);
      const { selection: _selection, onEvent, ...remaining } = options;
      return await this.#runtime.start({
        ...remaining,
        threadId: this.threadId,
        branch: this.branch,
        ...selection,
        onEvent: async (event) => await this.#publish(event, onEvent),
      });
    })());
  }

  async run(options: EmbeddingSessionRunOptions): Promise<HarnessRun> {
    return await (await this.start(options)).result;
  }

  steer(message: string, images?: ImageBlock[]): void {
    this.#assertOpen();
    this.#assertActiveBranch();
    this.#runtime.service.steer(this.threadId, message, images);
  }

  followUp(message: string, images?: ImageBlock[]): void {
    this.#assertOpen();
    this.#assertActiveBranch();
    this.#runtime.service.followUp(this.threadId, message, images);
  }

  abort(reason?: string): void {
    this.#assertOpen();
    this.#assertActiveBranch();
    this.#runtime.service.cancel(this.threadId, reason);
  }

  async compact(options: EmbeddingSessionCompactOptions = {}): Promise<AgentRunResult> {
    this.#assertOpen();
    const operation = (async () => {
      const selection = await this.#selection(options.selection, options.signal);
      return await this.#runtime.service.compact({
        threadId: this.threadId,
        branch: this.branch,
        ...selection,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.instructions === undefined ? {} : { compactionInstructions: options.instructions }),
        ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
        ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
        ...(options.contextTokenBudget === undefined ? {} : { contextTokenBudget: options.contextTokenBudget }),
        ...(options.summaryTokenBudget === undefined ? {} : { summaryTokenBudget: options.summaryTokenBudget }),
        onEvent: async (event) => await this.#publish(event),
      });
    })();
    return await this.#track(operation);
  }

  async fork(options: EmbeddingSessionForkOptions = {}): Promise<EmbeddingSession> {
    this.#assertOpen();
    return await this.#track((async () => {
      const result = await this.#runtime.service.cloneSessionPath({
        threadId: this.threadId,
        branch: this.branch,
        ...(options.atEventId === undefined ? {} : { atEventId: options.atEventId }),
        ...(options.beforeEventId === undefined ? {} : { beforeEventId: options.beforeEventId }),
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return await this.#open({
        threadId: result.thread.threadId,
        branch: result.thread.defaultBranch,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    })());
  }

  async navigate(options: EmbeddingSessionNavigateOptions): Promise<EmbeddingSessionNavigateResult> {
    this.#assertOpen();
    return await this.#track((async () => {
      const selection = options.summarize === true
        ? await this.#selection(options.selection, options.signal)
        : options.selection;
      const result: NavigateTreeResult = await this.#runtime.service.navigateTree({
        threadId: this.threadId,
        branch: this.branch,
        targetBranch: options.targetBranch,
        targetEventId: options.targetEventId,
        newBranch: options.newBranch,
        ...(options.summarize === undefined ? {} : { summarize: options.summarize }),
        ...(selection === undefined ? {} : { provider: selection.provider, model: selection.model }),
        ...(options.summaryTokenBudget === undefined ? {} : { summaryTokenBudget: options.summaryTokenBudget }),
        ...(options.summaryInstructions === undefined ? {} : { summaryInstructions: options.summaryInstructions }),
        ...(options.replaceInstructions === undefined ? {} : { replaceInstructions: options.replaceInstructions }),
        ...(options.label === undefined ? {} : { label: options.label }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return {
        cancelled: result.cancelled,
        ...(result.branch === undefined ? {} : { branch: result.branch.name }),
        ...(result.summaryEvent === undefined ? {} : { summaryEventId: result.summaryEvent.eventId }),
      };
    })());
  }

  async transcript(input: Omit<HarnessTranscriptRequest, "threadId" | "branch"> = {}): Promise<HarnessTranscriptPage> {
    this.#assertOpen();
    return await this.#track(this.#runtime.service.getTranscript({
      ...input,
      threadId: this.threadId,
      branch: this.branch,
    }));
  }

  async setName(name?: string, signal?: AbortSignal): Promise<void> {
    this.#assertOpen();
    await this.#track(this.#runtime.service.setSessionName({
      threadId: this.threadId,
      branch: this.branch,
      ...(name === undefined ? {} : { name }),
      ...(signal === undefined ? {} : { signal }),
    }).then(() => undefined));
  }

  getModel(): EmbeddingModelSelection | undefined {
    this.#assertOpen();
    this.#assertScope();
    const selected = this.#runtime.store.getModelSelection(this.threadId, this.branch);
    return selected === undefined ? undefined : { ...selected };
  }

  async setModel(selection: EmbeddingModelSelection, signal?: AbortSignal): Promise<EmbeddingModelSelection> {
    this.#assertOpen();
    return await this.#track(this.#selection(selection, signal, true));
  }

  subscribe(listener: EmbeddingSessionEventListener): () => void {
    this.#assertOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  invalidate(): void {
    this.#active = false;
    this.#listeners.clear();
  }

  #assertOpen(): void {
    if (!this.#active) throw new Error("Embedding harness is closing");
  }

  #assertScope(): void {
    const thread = this.#runtime.store.bindThreadWorkspace(this.threadId, this.#runtime.workspace);
    if (!thread.branches.some((entry) => entry.name === this.branch)) throw new Error(`Unknown branch: ${this.branch}`);
  }

  #assertActiveBranch(): void {
    void this.#runtime.service.recoverableMessageCount(this.threadId, this.branch);
  }

  async #publish(event: EventEnvelope, onEvent?: EmbeddingSessionEventListener): Promise<void> {
    if (!this.#active) return;
    const visible = embeddingSessionEvent(event);
    if (visible === undefined) return;
    if (onEvent !== undefined) await onEvent(structuredClone(visible));
    for (const listener of [...this.#listeners]) await listener(structuredClone(visible));
  }

  async #selection(
    selection: EmbeddingModelSelection | undefined,
    signal?: AbortSignal,
    persist = false,
  ): Promise<EmbeddingModelSelection> {
    this.#assertOpen();
    const requested = selection ?? this.getModel();
    if (requested === undefined) throw new Error("Embedding session has no model selection; call setModel() or pass selection");
    const selected = await this.#runtime.service.resolveModelSelection(requested.model, {
      provider: requested.provider,
      ...(requested.reasoningEffort === undefined ? {} : { reasoningEffort: requested.reasoningEffort }),
      ...(signal === undefined ? {} : { signal }),
    });
    const result: EmbeddingModelSelection = {
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    };
    signal?.throwIfAborted();
    this.#assertOpen();
    const previous = this.#runtime.store.getModelSelection(this.threadId, this.branch);
    if (persist) {
      this.#assertScope();
      this.#runtime.store.appendEvent({
        threadId: this.threadId,
        branch: this.branch,
        event: {
          type: "model_selected",
          provider: result.provider,
          model: result.model,
          ...(result.reasoningEffort === undefined ? {} : { reasoningEffort: result.reasoningEffort }),
        },
      });
    }
    this.#runtime.service.setRuntimeModelSelection({
      threadId: this.threadId,
      branch: this.branch,
      selection: result,
    });
    await this.#runtime.service.publishRuntimeModelSelectionChange({
      threadId: this.threadId,
      branch: this.branch,
      ...(previous === undefined ? {} : { previous }),
      current: result,
      source: "set",
      ...(signal === undefined ? {} : { signal }),
    });
    return result;
  }
}

class OwnedInMemoryHarness implements InMemoryHarness {
  readonly #service: HarnessService;
  readonly #store: SessionStore;
  readonly #providers: ProviderRegistry;
  readonly #selection: InMemoryModelSelection;
  readonly #timeoutMs: number;
  readonly #maxSteps: number;
  readonly #runs = new Map<string, Promise<HarnessRun>>();
  readonly #closeController = new AbortController();
  #threadSequence = 0;
  #lifecycleTail: Promise<void> = Promise.resolve();
  #closing: Promise<void> | undefined;

  constructor(input: {
    service: HarnessService;
    store: SessionStore;
    providers: ProviderRegistry;
    selection: InMemoryModelSelection;
    timeoutMs: number;
    maxSteps: number;
  }) {
    this.#service = input.service;
    this.#store = input.store;
    this.#providers = input.providers;
    this.#selection = input.selection;
    this.#timeoutMs = input.timeoutMs;
    this.#maxSteps = input.maxSteps;
  }

  async start(options: InMemoryRunOptions): Promise<EmbeddingRunHandle> {
    if (this.#closing !== undefined) throw new Error("In-memory harness is closing");
    return await this.#enqueueLifecycle(async () => {
      const selection = options.selection ?? this.#selection;
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      const signals = [timeout, this.#closeController.signal];
      if (options.signal !== undefined) signals.push(options.signal);
      const signal = AbortSignal.any(signals);
      signal.throwIfAborted();
      await requireExactSelection(this.#providers, selection, signal);
      const threadId = options.threadId ?? (await this.#service.createSession({
        threadId: `thread_memory_${String(++this.#threadSequence).padStart(6, "0")}`,
        ...(options.branch === undefined ? {} : { defaultBranch: options.branch }),
        signal,
      })).threadId;
      if (this.#runs.has(threadId)) {
        throw new Error(`Thread already has an active in-memory operation: ${threadId}`);
      }
      const {
        selection: _selection,
        signal: _signal,
        maxSteps: requestedMaxSteps,
        ...remaining
      } = options;
      const runOptions: RunOptions = {
        ...remaining,
        threadId,
        provider: selection.provider,
        model: selection.model,
        signal,
        maxSteps: requestedMaxSteps ?? this.#maxSteps,
        noBuiltinTools: true,
        noContextFiles: true,
      };
      const result = this.#service.run(runOptions).finally(() => {
        if (this.#runs.get(threadId) === result) this.#runs.delete(threadId);
      });
      this.#runs.set(threadId, result);
      return {
        threadId,
        result,
        cancel: (reason?: string) => this.#service.cancel(threadId, reason),
        cancelRetry: () => this.#service.cancelRetry(threadId),
      };
    });
  }

  async run(options: InMemoryRunOptions): Promise<HarnessRun> {
    return await (await this.start(options)).result;
  }

  async waitForIdle(signal?: AbortSignal): Promise<void> {
    while (true) {
      const lifecycle = this.#lifecycleTail;
      await settleWithSignal(lifecycle, signal);
      const runs = [...this.#runs.values()];
      if (runs.length > 0) {
        await settleWithSignal(Promise.allSettled(runs).then(() => undefined), signal);
      }
      if (lifecycle === this.#lifecycleTail && this.#runs.size === 0) return;
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.#enqueueLifecycle(async () => {
      for (const threadId of this.#runs.keys()) this.#service.cancel(threadId, "In-memory harness closed");
      await Promise.allSettled([...this.#runs.values()]);
      this.#closeController.abort(new Error("In-memory harness closed"));
      try {
        await this.#service.close("in_memory_harness_close");
      } finally {
        this.#store.close();
      }
    });
    return this.#closing;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#lifecycleTail.then(operation);
    this.#lifecycleTail = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new RangeError(`${label} must be an integer from 1 to ${maximum}`);
  }
  return selected;
}

async function requireExactSelection(
  providers: ProviderRegistry,
  selection: InMemoryModelSelection,
  signal: AbortSignal,
): Promise<void> {
  const [status] = await providers.catalogStatus(selection.provider);
  const resolved = await providers.requireModelReference(selection.model, signal, {
    provider: selection.provider,
    refresh: status === undefined || status.provenance === "none" || status.stale,
    allowUnknownModel: false,
  });
  if (resolved.provider !== selection.provider || resolved.model !== selection.model) {
    throw new Error(`In-memory model selection must be exact: ${selection.provider}/${selection.model}`);
  }
}

/**
 * Loads the normal configured Node.js runtime behind a narrow owner facade.
 * Use `createHarnessRuntime` only when an advanced host truly needs its internals.
 */
export async function createEmbeddingHarness(
  options: CreateHarnessRuntimeOptions = {},
): Promise<EmbeddingHarness> {
  return createEmbeddingHarnessFromRuntime(await createHarnessRuntime(options));
}

/** Wraps and takes lifecycle ownership of an already-created configured runtime. */
export function createEmbeddingHarnessFromRuntime(runtime: HarnessRuntime): EmbeddingHarness {
  return new ConfiguredEmbeddingHarness(runtime);
}

/**
 * Creates a deterministic, credential-free preset for unit tests and small Node.js integrations.
 * The owner never loads config, extensions, credentials, model-cache files, or a session database file.
 */
export async function createInMemoryHarness(
  options: CreateInMemoryHarnessOptions,
): Promise<InMemoryHarness> {
  const timeoutMs = boundedInteger(
    options.timeoutMs,
    DEFAULT_IN_MEMORY_TIMEOUT_MS,
    MAX_IN_MEMORY_TIMEOUT_MS,
    "In-memory run timeout",
  );
  const maxSteps = boundedInteger(options.maxSteps, DEFAULT_IN_MEMORY_MAX_STEPS, 1_024, "In-memory max steps");
  const adapters = [options.provider, ...(options.additionalProviders ?? [])];
  const providers = new ProviderRegistry(adapters);
  let idSequence = 0;
  const store = new SessionStore(":memory:", {
    clock: () => new Date("2000-01-01T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_memory_${String(++idSequence).padStart(6, "0")}`,
  });
  const service = new HarnessService({
    store,
    workspace: options.workspace ?? process.cwd(),
    providers,
    projectTrusted: false,
    extraTools: [...(options.tools ?? [])],
  });
  try {
    await service.initialize({ skills: [] });
    const signal = AbortSignal.timeout(timeoutMs);
    await requireExactSelection(providers, { provider: options.provider.id, model: options.model }, signal);
  } catch (error) {
    await service.close("in_memory_harness_initialization_failed").catch(() => undefined);
    store.close();
    throw error;
  }
  return new OwnedInMemoryHarness({
    service,
    store,
    providers,
    selection: { provider: options.provider.id, model: options.model },
    timeoutMs,
    maxSteps,
  });
}
