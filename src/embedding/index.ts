import type { EventEnvelope } from "../core/events.js";
import type { ImageBlock, OutboundImagePolicy, ProviderAdapter, ProviderId } from "../core/types.js";
import { ProviderRegistry } from "../providers/registry.js";
import {
  createHarnessRuntime,
  type CreateHarnessRuntimeOptions,
  type HarnessRuntime,
} from "../public-runtime.js";
import {
  HarnessService,
  type HarnessRun,
  type RunOptions,
} from "../service/harness.js";
import type { HarnessResourceCatalog } from "../service/resource-catalog.js";
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
}

/** A task-focused owner. It intentionally exposes no credential, provider-registry, store, or service objects. */
export interface EmbeddingHarness {
  start(options: EmbeddingRunOptions): Promise<EmbeddingRunHandle>;
  run(options: EmbeddingRunOptions): Promise<HarnessRun>;
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

  constructor(runtime: HarnessRuntime) {
    this.#runtime = runtime;
  }

  async start(options: EmbeddingRunOptions): Promise<EmbeddingRunHandle> {
    return await this.#runtime.start(options);
  }

  async run(options: EmbeddingRunOptions): Promise<HarnessRun> {
    return await this.#runtime.run(options);
  }

  async waitForIdle(signal?: AbortSignal): Promise<void> {
    await this.#runtime.waitForIdle(signal);
  }

  async resourceCatalog(signal?: AbortSignal): Promise<HarnessResourceCatalog> {
    return await this.#runtime.resourceCatalog(signal);
  }

  async reload(options: { signal?: AbortSignal } = {}): Promise<{ warnings: string[] }> {
    return await this.#runtime.reload(options);
  }

  async close(): Promise<void> {
    await this.#runtime.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
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
  return new ConfiguredEmbeddingHarness(await createHarnessRuntime(options));
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
