import type { ImageBlock, ModelProtocolFamily, ProviderId } from "./core/types.js";
import {
  loadRuntime,
  type LoadedRuntime,
  type RuntimeRefreshOptions,
  type RuntimeRefreshResult,
} from "./cli/runtime.js";
import type {
  AgentSession,
  AgentSessionEnvelopeListener,
  AgentSessionModel,
  AgentSessionPromptOptions,
  AgentSessionRun,
} from "./service/agent-session.js";
import type { SessionManager } from "./storage/session-manager.js";
import type { ObservabilitySink } from "./core/observability.js";
import type { ToolAuthorizationHandler } from "./tools/approval.js";

export interface CreateHarnessRuntimeOptions {
  workspace?: string;
  projectTrusted?: boolean;
  ephemeral?: boolean;
  extensions?: boolean;
  extensionPaths?: readonly string[];
  skills?: boolean;
  skillPaths?: readonly string[];
  promptTemplates?: boolean;
  promptTemplatePaths?: readonly string[];
  themes?: boolean;
  themePaths?: readonly string[];
  apiKey?: string;
  apiKeyProvider?: string;
  sessionDirectory?: string;
  sessionFile?: string;
  continueRecent?: boolean;
  sessionManager?: SessionManager;
  /** Caller-owned destination for metadata-only records. Omit it to keep SDK runtimes silent. */
  observabilitySink?: ObservabilitySink;
  /** Optional host-owned gate for model-requested tool effects. */
  toolAuthorizationHandler?: ToolAuthorizationHandler;
}

export interface HarnessRunHandle {
  readonly sessionId: string;
  readonly result: Promise<AgentSessionRun>;
  abort(reason?: string): void;
  cancelRetry(): boolean;
}

export interface HarnessRuntime {
  readonly workspace: string;
  readonly session: AgentSession;
  readonly sessionManager: SessionManager;
  prompt(text: string, options?: AgentSessionPromptOptions): HarnessRunHandle;
  steer(text: string, images?: ImageBlock[]): Promise<void>;
  followUp(text: string, images?: ImageBlock[]): Promise<void>;
  setModel(model: AgentSessionModel): Promise<void>;
  resolveModel(
    reference: string,
    options?: { provider?: ProviderId; api?: ModelProtocolFamily; reasoningEffort?: string; signal?: AbortSignal },
  ): Promise<AgentSessionModel>;
  onEvent(listener: AgentSessionEnvelopeListener): () => void;
  refresh(options?: RuntimeRefreshOptions): Promise<RuntimeRefreshResult>;
  close(): Promise<void>;
}

class LoadedHarnessRuntime implements HarnessRuntime {
  readonly #runtime: LoadedRuntime;
  readonly #subscriptions = new Set<{
    listener: AgentSessionEnvelopeListener;
    session: AgentSession;
    unsubscribe: () => void;
  }>();
  #closeFlight: Promise<void> | undefined;

  static async create(runtime: LoadedRuntime): Promise<LoadedHarnessRuntime> {
    const harness = new LoadedHarnessRuntime(runtime);
    try {
      await runtime.session.bindExtensions({
        mode: "sdk",
        shutdownHandler: () => { void harness.close(); },
      });
      if (harness.#closeFlight !== undefined) {
        await harness.#closeFlight;
        throw new Error("Harness runtime shut down during extension startup");
      }
      return harness;
    } catch (error) {
      try {
        await (harness.#closeFlight ?? runtime.close());
      } catch (cleanupError) {
        if (cleanupError === error) throw error;
        throw new AggregateError(
          [error, cleanupError],
          "Harness runtime extension binding and cleanup failed",
        );
      }
      throw error;
    }
  }

  constructor(runtime: LoadedRuntime) {
    this.#runtime = runtime;
    runtime.setExtensionShutdownHandler(() => this.close());
  }

  get workspace(): string {
    return this.#runtime.workspace;
  }

  get session(): AgentSession {
    return this.#runtime.session;
  }

  get sessionManager(): SessionManager {
    return this.#runtime.sessionManager;
  }

  prompt(text: string, options: AgentSessionPromptOptions = {}): HarnessRunHandle {
    const session = this.session;
    const controller = new AbortController();
    const signal = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([options.signal, controller.signal]);
    const result = session.prompt(text, { ...options, signal });
    return {
      sessionId: session.sessionId,
      result,
      abort: (reason?: string) => controller.abort(new Error(reason ?? "Harness run aborted")),
      cancelRetry: () => session.cancelRetry(),
    };
  }

  async steer(text: string, images?: ImageBlock[]): Promise<void> {
    await this.session.steer(text, images);
  }

  async followUp(text: string, images?: ImageBlock[]): Promise<void> {
    await this.session.followUp(text, images);
  }

  async setModel(model: AgentSessionModel): Promise<void> {
    await this.session.setModel(model);
  }

  async resolveModel(
    reference: string,
    options: { provider?: ProviderId; api?: ModelProtocolFamily; reasoningEffort?: string; signal?: AbortSignal } = {},
  ): Promise<AgentSessionModel> {
    return await this.session.resolveModel(reference, options);
  }

  onEvent(listener: AgentSessionEnvelopeListener): () => void {
    if (this.#closeFlight !== undefined) throw new Error("Harness runtime is closed");
    const session = this.session;
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

  async refresh(options: RuntimeRefreshOptions = {}): Promise<RuntimeRefreshResult> {
    const beforeSessionStart = options.beforeSessionStart;
    try {
      return await this.#runtime.refresh({
        ...options,
        beforeSessionStart: async (session) => {
          session.updateExtensionBindings({
            mode: "sdk",
            shutdownHandler: () => { void this.close(); },
          });
          this.#rebindSubscriptions(session);
          await beforeSessionStart?.(session);
        },
      });
    } finally {
      if (this.#closeFlight === undefined) this.#rebindSubscriptions(this.session);
    }
  }

  close(): Promise<void> {
    if (this.#closeFlight !== undefined) return this.#closeFlight;
    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    const operation = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    this.#closeFlight = operation;
    void this.#performClose().then(resolveClose, rejectClose);
    return operation;
  }

  #rebindSubscriptions(session: AgentSession): void {
    for (const binding of this.#subscriptions) {
      if (binding.session === session) continue;
      const unsubscribe = session.onEvent(binding.listener);
      const previous = binding.unsubscribe;
      binding.session = session;
      binding.unsubscribe = unsubscribe;
      previous();
    }
  }

  async #performClose(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.#runtime.runtimeExtensions.dispatch("session_shutdown", { reason: "quit" } as never);
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#runtime.close();
    } catch (error) {
      failures.push(error);
    }
    for (const binding of this.#subscriptions) {
      try {
        binding.unsubscribe();
      } catch (error) {
        failures.push(error);
      }
    }
    this.#subscriptions.clear();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Harness runtime shutdown failed");
  }
}

export async function createHarnessRuntime(
  options: CreateHarnessRuntimeOptions = {},
): Promise<HarnessRuntime> {
  const runtime = await loadRuntime({ ...options, extensionRuntime: true });
  return await LoadedHarnessRuntime.create(runtime);
}
