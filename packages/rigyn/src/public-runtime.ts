import type { ImageBlock, ModelProtocolFamily, ProviderId } from "./core/types.js";
import {
  loadRuntime,
  type LoadedRuntime,
  type RuntimeReloadOptions,
  type RuntimeReloadResult,
} from "./cli/runtime.js";
import type {
  AgentSession,
  AgentSessionEnvelopeListener,
  AgentSessionModel,
  AgentSessionPromptOptions,
  AgentSessionRun,
} from "./service/agent-session.js";
import type { SessionManager } from "./storage/session-manager.js";

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
  reload(options?: RuntimeReloadOptions): Promise<RuntimeReloadResult>;
  close(): Promise<void>;
}

class LoadedHarnessRuntime implements HarnessRuntime {
  readonly #runtime: LoadedRuntime;

  constructor(runtime: LoadedRuntime) {
    this.#runtime = runtime;
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
    return this.session.onEvent(listener);
  }

  async reload(options: RuntimeReloadOptions = {}): Promise<RuntimeReloadResult> {
    return await this.#runtime.reload(options);
  }

  async close(): Promise<void> {
    await this.#runtime.close();
  }
}

export async function createHarnessRuntime(
  options: CreateHarnessRuntimeOptions = {},
): Promise<HarnessRuntime> {
  return new LoadedHarnessRuntime(await loadRuntime(options));
}
