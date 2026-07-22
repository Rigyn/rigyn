import type { EventEnvelope } from "../core/events.js";
import type {
  ImageBlock,
  ModelProtocolFamily,
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
  AgentSession,
  type AgentSessionModel,
  type AgentSessionPromptOptions,
  type AgentSessionRun,
} from "../service/agent-session.js";
import { SessionManager } from "../storage/session-manager.js";
import type { HarnessTool } from "../tools/types.js";

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
  start(options: EmbeddingRunOptions): EmbeddingRunHandle;
  run(options: EmbeddingRunOptions): Promise<AgentSessionRun>;
  steer(message: string, images?: ImageBlock[]): Promise<void>;
  followUp(message: string, images?: ImageBlock[]): Promise<void>;
  abort(reason?: string): void;
  waitForIdle(): Promise<void>;
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
  reload(options?: { signal?: AbortSignal }): Promise<{ warnings: string[] }>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

class DirectEmbeddingSession implements EmbeddingSession {
  readonly #getSession: () => AgentSession;

  constructor(session: AgentSession | (() => AgentSession)) {
    this.#getSession = typeof session === "function" ? session : () => session;
  }

  get #session(): AgentSession { return this.#getSession(); }
  get id(): string { return this.#session.sessionId; }
  get cwd(): string { return this.#session.cwd; }
  get model(): AgentSessionModel | undefined { return this.#session.model; }
  get isIdle(): boolean { return this.#session.isIdle; }

  start(options: EmbeddingRunOptions): EmbeddingRunHandle {
    const { prompt, signal: callerSignal, ...runOptions } = options;
    const session = this.#session;
    const controller = new AbortController();
    const signal = callerSignal === undefined
      ? controller.signal
      : AbortSignal.any([callerSignal, controller.signal]);
    const result = session.prompt(prompt, { ...runOptions, signal });
    return {
      sessionId: session.sessionId,
      result,
      abort: (reason?: string) => controller.abort(new Error(reason ?? "Embedding run aborted")),
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
  async resolveModel(
    reference: string,
    options: { provider?: ProviderId; api?: ModelProtocolFamily; reasoningEffort?: string; signal?: AbortSignal } = {},
  ): Promise<AgentSessionModel> {
    return await this.#session.resolveModel(reference, options);
  }
  async setModel(model: AgentSessionModel): Promise<void> { await this.#session.setModel(model); }
  setThinkingLevel(level: string): void { this.#session.setThinkingLevel(level); }
  setName(name: string): void { this.#session.setSessionName(name); }
  subscribe(listener: EmbeddingSessionEventListener): () => void { return this.#session.onEvent(listener); }
}

class ConfiguredEmbeddingHarness implements EmbeddingHarness {
  readonly #runtime: HarnessRuntime;
  readonly #session: EmbeddingSession;

  constructor(runtime: HarnessRuntime) {
    this.#runtime = runtime;
    this.#session = new DirectEmbeddingSession(() => this.#runtime.session);
  }

  get session(): EmbeddingSession {
    return this.#session;
  }

  async reload(options: { signal?: AbortSignal } = {}): Promise<{ warnings: string[] }> {
    return await this.#runtime.reload(options);
  }

  async close(): Promise<void> { await this.#runtime.close(); }
  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}

export interface CreateInMemoryHarnessOptions {
  provider: ProviderAdapter;
  model: string;
  api: ModelProtocolFamily;
  additionalProviders?: readonly ProviderAdapter[];
  tools?: readonly HarnessTool[];
  workspace?: string;
}

class InMemoryEmbeddingHarness implements EmbeddingHarness {
  readonly #agentSession: AgentSession;
  readonly #session: EmbeddingSession;

  constructor(session: AgentSession) {
    this.#agentSession = session;
    this.#session = new DirectEmbeddingSession(session);
  }

  get session(): EmbeddingSession { return this.#session; }
  async reload(): Promise<{ warnings: string[] }> { return { warnings: [] }; }
  async close(): Promise<void> { await this.#agentSession.close(); }
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
  const manager = SessionManager.inMemory(options.workspace ?? process.cwd());
  const session = await AgentSession.create({
    sessionManager: manager,
    providers,
    workspace: options.workspace ?? process.cwd(),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  });
  const selected = await session.resolveModel(options.model, {
    provider: options.provider.id as ProviderId,
    api: options.api,
  });
  await session.setModel(selected);
  return new InMemoryEmbeddingHarness(session);
}
