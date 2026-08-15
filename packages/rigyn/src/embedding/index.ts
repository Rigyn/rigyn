import type { EventEnvelope } from "../core/events.js";
import {
  RuntimeObservability,
  resolveObservabilityLevel,
  type ObservabilitySink,
} from "../core/observability.js";
import type {
  ImageBlock,
  ModelProtocolFamily,
  ProviderAdapter,
  ProviderId,
} from "../core/types.js";
import { projectLoadedExtensionHost } from "../extensions/compat.js";
import type { ToolDefinition } from "../extensions/direct.js";
import {
  directToolRendererBinding,
  RuntimeExtensionHost,
} from "../extensions/runtime.js";
import { ProviderRegistry } from "../providers/registry.js";
import {
  createHarnessRuntime,
  type CreateHarnessRuntimeOptions,
  type HarnessRuntime,
} from "../public-runtime.js";
import {
  AgentSession,
  type AgentSessionModel,
  type AgentSessionPromptOptions,
  type AgentSessionRecoveryOptions,
  type AgentSessionRecoveryResult,
  type AgentSessionRun,
  type AgentSessionSuspendedRun,
} from "../service/agent-session.js";
import { SettingsManager } from "../core/settings-manager.js";
import { SessionManager } from "../storage/session-manager.js";
import { allToolNames } from "../tools/catalog.js";
import type { ToolAuthorizationHandler } from "../tools/approval.js";
import {
  createHarnessToolFromDefinition,
  isHarnessTool,
  type AgentSessionTool,
} from "../tools/direct-tool.js";

export interface EmbeddingRunOptions extends AgentSessionPromptOptions {
  prompt: string;
}

export interface EmbeddingRunHandle {
  readonly sessionId: string;
  readonly result: Promise<AgentSessionRun>;
  abort(reason?: string): void;
  cancelRetry(): boolean;
}

export type EmbeddingSessionEventListener = (event: EventEnvelope) => Promise<void> | void;

export interface EmbeddingSession {
  readonly id: string;
  readonly cwd: string;
  readonly model: AgentSessionModel | undefined;
  readonly isIdle: boolean;
  readonly suspendedRun: AgentSessionSuspendedRun | undefined;
  start(options: EmbeddingRunOptions): EmbeddingRunHandle;
  run(options: EmbeddingRunOptions): Promise<AgentSessionRun>;
  steer(message: string, images?: ImageBlock[]): Promise<void>;
  followUp(message: string, images?: ImageBlock[]): Promise<void>;
  abort(reason?: string): void;
  waitForIdle(): Promise<void>;
  recoverInterruptedRun(
    options?: AgentSessionRecoveryOptions,
  ): Promise<AgentSessionRecoveryResult>;
  resolveModel(
    reference: string,
    options?: { provider?: ProviderId; api?: ModelProtocolFamily; reasoningEffort?: string; signal?: AbortSignal },
  ): Promise<AgentSessionModel>;
  setModel(model: AgentSessionModel): Promise<void>;
  setThinkingLevel(level: string): void;
  setName(name: string): void;
  subscribe(listener: EmbeddingSessionEventListener): () => void;
}

export interface EmbeddingHarness {
  readonly session: EmbeddingSession;
  refresh(options?: { signal?: AbortSignal }): Promise<{ warnings: string[] }>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

class DirectEmbeddingSession implements EmbeddingSession {
  readonly #getSession: () => AgentSession;
  readonly #subscriptions = new Set<{
    listener: EmbeddingSessionEventListener;
    session: AgentSession;
    unsubscribe: () => void;
  }>();
  #disposed = false;

  constructor(session: AgentSession | (() => AgentSession)) {
    this.#getSession = typeof session === "function" ? session : () => session;
  }

  get #session(): AgentSession { return this.#getSession(); }
  get id(): string { return this.#session.sessionId; }
  get cwd(): string { return this.#session.cwd; }
  get model(): AgentSessionModel | undefined { return this.#session.nativeModel; }
  get isIdle(): boolean { return this.#session.isIdle; }
  get suspendedRun(): AgentSessionSuspendedRun | undefined { return this.#session.suspendedRun; }

  start(options: EmbeddingRunOptions): EmbeddingRunHandle {
    const { prompt, signal: callerSignal, ...runOptions } = options;
    const session = this.#session;
    const controller = new AbortController();
    let admitted = false;
    let pendingAbort: Error | undefined;
    const signal = callerSignal === undefined
      ? controller.signal
      : AbortSignal.any([callerSignal, controller.signal]);
    const result = session.prompt(prompt, {
      ...runOptions,
      signal,
      preflightResult: (succeeded) => {
        admitted = succeeded;
        if (succeeded && pendingAbort !== undefined) controller.abort(pendingAbort);
        runOptions.preflightResult?.(succeeded);
      },
    });
    return {
      sessionId: session.sessionId,
      result,
      abort: (reason?: string) => {
        if (controller.signal.aborted || pendingAbort !== undefined) return;
        const error = new Error(reason ?? "Embedding run aborted");
        if (admitted) controller.abort(error);
        else pendingAbort = error;
      },
      cancelRetry: () => session.cancelRetry(),
    };
  }

  async run(options: EmbeddingRunOptions): Promise<AgentSessionRun> {
    return await this.start(options).result;
  }

  async steer(message: string, images?: ImageBlock[]): Promise<void> { await this.#session.steer(message, images); }
  async followUp(message: string, images?: ImageBlock[]): Promise<void> { await this.#session.followUp(message, images); }
  abort(reason?: string): void { this.#session.abort(reason); }
  async waitForIdle(): Promise<void> { await this.#session.waitForIdle(); }
  async recoverInterruptedRun(
    options: AgentSessionRecoveryOptions = {},
  ): Promise<AgentSessionRecoveryResult> {
    return await this.#session.recoverInterruptedRun(options);
  }
  async resolveModel(
    reference: string,
    options: { provider?: ProviderId; api?: ModelProtocolFamily; reasoningEffort?: string; signal?: AbortSignal } = {},
  ): Promise<AgentSessionModel> {
    return await this.#session.resolveModel(reference, options);
  }
  async setModel(model: AgentSessionModel): Promise<void> { await this.#session.setModel(model); }
  setThinkingLevel(level: string): void { this.#session.setThinkingLevel(level); }
  setName(name: string): void { this.#session.setSessionName(name); }
  subscribe(listener: EmbeddingSessionEventListener): () => void {
    if (this.#disposed) throw new Error("Embedding session is closed");
    const session = this.#session;
    const binding = { listener, session, unsubscribe: session.onEvent(listener) };
    this.#subscriptions.add(binding);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#subscriptions.delete(binding);
      binding.unsubscribe();
    };
  }

  rebind(candidate: AgentSession = this.#session): void {
    if (this.#disposed) return;
    const session = candidate;
    for (const binding of this.#subscriptions) {
      if (binding.session === session) continue;
      const unsubscribe = session.onEvent(binding.listener);
      const previous = binding.unsubscribe;
      binding.session = session;
      binding.unsubscribe = unsubscribe;
      previous();
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const binding of this.#subscriptions) binding.unsubscribe();
    this.#subscriptions.clear();
  }
}

class ConfiguredEmbeddingHarness implements EmbeddingHarness {
  readonly #runtime: HarnessRuntime;
  readonly #session: DirectEmbeddingSession;

  constructor(runtime: HarnessRuntime) {
    this.#runtime = runtime;
    this.#session = new DirectEmbeddingSession(() => this.#runtime.session);
  }

  get session(): EmbeddingSession {
    return this.#session;
  }

  async refresh(options: { signal?: AbortSignal } = {}): Promise<{ warnings: string[] }> {
    try {
      return await this.#runtime.refresh({
        ...options,
        beforeSessionStart: (session) => {
          this.#session.rebind(session);
        },
      });
    } finally {
      // Reconcile late subscribers after publication and restore the current
      // owner when a prepared candidate fails before it is published.
      this.#session.rebind();
    }
  }

  async close(): Promise<void> {
    try {
      await this.#runtime.close();
    } finally {
      this.#session.dispose();
    }
  }
  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}

export interface CreateInMemoryHarnessOptions {
  provider: ProviderAdapter;
  model: string;
  api: ModelProtocolFamily;
  additionalProviders?: readonly ProviderAdapter[];
  /** Caller-owned tools added alongside the built-ins. */
  customTools?: readonly AgentSessionTool[];
  /** @deprecated Use customTools. */
  tools?: readonly AgentSessionTool[];
  /** Exact active-tool allowlist. */
  enabledTools?: readonly string[];
  /** Tool names removed after the allowlist/default policy. */
  excludeTools?: readonly string[];
  /** Suppress every tool, or only the default built-ins. */
  noTools?: "all" | "builtin";
  workspace?: string;
  /** Caller-owned destination for metadata-only records. Omit it to keep the in-memory harness silent. */
  observabilitySink?: ObservabilitySink;
  /** Optional host-owned gate for model-requested tool effects. */
  toolAuthorizationHandler?: ToolAuthorizationHandler;
}

class InMemoryEmbeddingHarness implements EmbeddingHarness {
  readonly #agentSession: AgentSession;
  readonly #extensionHost: RuntimeExtensionHost | undefined;
  readonly #observability: RuntimeObservability | undefined;
  readonly #session: DirectEmbeddingSession;

  constructor(
    session: AgentSession,
    extensionHost?: RuntimeExtensionHost,
    observability?: RuntimeObservability,
  ) {
    this.#agentSession = session;
    this.#extensionHost = extensionHost;
    this.#observability = observability;
    this.#session = new DirectEmbeddingSession(session);
  }

  get session(): EmbeddingSession { return this.#session; }
  async refresh(): Promise<{ warnings: string[] }> { return { warnings: [] }; }
  async close(): Promise<void> {
    const failures: unknown[] = [];
    try { await this.#agentSession.close(); } catch (error) { failures.push(error); }
    try { await this.#extensionHost?.close(); } catch (error) { failures.push(error); }
    try { await this.#observability?.close(); } catch (error) { failures.push(error); }
    try { this.#session.dispose(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Embedding harness cleanup failed");
  }
  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}

export async function createEmbeddingHarness(
  options: CreateHarnessRuntimeOptions = {},
): Promise<EmbeddingHarness> {
  return createEmbeddingHarnessFromRuntime(await createHarnessRuntime(options));
}

export function createEmbeddingHarnessFromRuntime(runtime: HarnessRuntime): EmbeddingHarness {
  return new ConfiguredEmbeddingHarness(runtime);
}

export async function createInMemoryHarness(
  options: CreateInMemoryHarnessOptions,
): Promise<EmbeddingHarness> {
  const providers = new ProviderRegistry([options.provider, ...(options.additionalProviders ?? [])]);
  const workspace = options.workspace ?? process.cwd();
  const manager = SessionManager.inMemory(workspace);
  const observability = options.observabilitySink === undefined
    ? undefined
    : new RuntimeObservability(options.observabilitySink, {
        mode: "sdk",
        level: resolveObservabilityLevel(),
        closeSink: false,
      });
  const customToolInputs = options.customTools ?? options.tools ?? [];
  const customToolName = (tool: AgentSessionTool): string =>
    isHarnessTool(tool) ? tool.definition.name : tool.name;
  const directDefinitions = new Map<string, ToolDefinition<any, any, any>>();
  for (const tool of customToolInputs) {
    if (isHarnessTool(tool)) directDefinitions.delete(tool.definition.name);
    else directDefinitions.set(tool.name, tool);
  }
  const extensionHost = directDefinitions.size === 0 ? undefined : new RuntimeExtensionHost(workspace);
  let session: AgentSession | undefined;
  const customTools = customToolInputs.map((tool) =>
    isHarnessTool(tool)
      ? tool
      : createHarnessToolFromDefinition(tool, () => {
          if (session === undefined) throw new Error("Embedding tool context is not ready");
          return session.createReplacedSessionContext();
        }));
  const customToolRenderer = directToolRendererBinding(
    [...directDefinitions.values()],
    workspace,
    (diagnostic) => extensionHost?.addDiagnostic({
      extensionId: "embedding",
      sourcePath: "<custom-tool-renderer>",
      message: diagnostic.message,
    }),
  );
  const hasToolSelection = options.enabledTools !== undefined
    || options.excludeTools !== undefined
    || options.noTools !== undefined;
  const activeToolNames = options.enabledTools !== undefined
    ? [...options.enabledTools]
    : options.noTools === "all"
      ? []
      : options.noTools === "builtin"
        ? customToolInputs.map(customToolName)
        : [...allToolNames, ...customToolInputs.map(customToolName)];
  try {
    session = await AgentSession.create({
      sessionManager: manager,
      providers,
      workspace,
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
      ...(observability === undefined ? {} : { observability }),
      ...(extensionHost === undefined ? {} : { extensionsResult: projectLoadedExtensionHost(extensionHost) }),
      ...(customTools.length === 0 ? {} : { tools: customTools }),
      ...(customToolRenderer === undefined ? {} : { toolRendererBinding: customToolRenderer }),
      ...(options.toolAuthorizationHandler === undefined
        ? {}
        : { toolAuthorizationHandler: options.toolAuthorizationHandler }),
      ...(hasToolSelection
        ? {
            initialToolSelection: {
              names: [...new Set(activeToolNames)],
              excludedNames: [...new Set(options.excludeTools ?? [])],
            },
          }
        : {}),
    });
    const selected = await session.resolveModel(options.model, {
      provider: options.provider.id as ProviderId,
      api: options.api,
    });
    await session.setModel(selected);
    await session.bindExtensions({ mode: "sdk" });
    return new InMemoryEmbeddingHarness(session, extensionHost, observability);
  } catch (error) {
    await session?.close().catch(() => undefined);
    await observability?.close().catch(() => undefined);
    await extensionHost?.close().catch(() => undefined);
    throw error;
  }
}
