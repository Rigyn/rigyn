import { access } from "node:fs/promises";
import { homedir } from "node:os";

import type { JsonValue } from "../core/json.js";
import type {
  AdapterEvent,
  CanonicalMessage,
  ModelProtocolFamily,
  ModelRequestCompatibility,
  NormalizedUsage,
  ProviderId,
  ProviderCacheRetention,
  ProviderRequest,
  ProviderState,
  ThinkingBudgets,
  ToolDefinition,
} from "../core/types.js";
import type { SimpleStreamOptions, Transport } from "@rigyn/models";
import type {
  ProviderModelsStore,
  ScopedProviderModelsStore,
} from "./models-store.js";
import { InMemoryProviderModelsStore } from "./models-store.js";

export interface ProviderModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: ProviderModelCostTier[];
}

export interface ProviderModelCostTier {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ProviderModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** A direct, provider-owned model declaration. */
export interface ProviderModel<TApi extends ModelProtocolFamily = ModelProtocolFamily> {
  id: string;
  name: string;
  api: TApi;
  provider: ProviderId;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ProviderModelThinkingLevel, string | null>>;
  input: Array<"text" | "image">;
  cost: ProviderModelCost;
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: ModelRequestCompatibility;
}

export interface ProviderModelAuth {
  apiKey?: string;
  headers?: Record<string, string | null>;
  baseUrl?: string;
}

export interface ProviderApiKeyCredential {
  type: "api_key";
  key?: string;
  env?: Record<string, string>;
}

export interface ProviderOAuthCredential {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}

export type ProviderCredential = ProviderApiKeyCredential | ProviderOAuthCredential;

export interface ProviderCredentialInfo {
  providerId: string;
  type: ProviderCredential["type"];
}

export interface ProviderCredentialStore {
  read(providerId: string): Promise<ProviderCredential | undefined>;
  list(): Promise<readonly ProviderCredentialInfo[]>;
  modify(
    providerId: string,
    operation: (current: ProviderCredential | undefined) => Promise<ProviderCredential | undefined>,
  ): Promise<ProviderCredential | undefined>;
  delete(providerId: string): Promise<void>;
}

export class InMemoryProviderCredentialStore implements ProviderCredentialStore {
  readonly #credentials = new Map<string, ProviderCredential>();
  readonly #tails = new Map<string, Promise<unknown>>();

  async read(providerId: string): Promise<ProviderCredential | undefined> {
    const credential = this.#credentials.get(providerId);
    return credential === undefined ? undefined : structuredClone(credential);
  }

  async list(): Promise<readonly ProviderCredentialInfo[]> {
    return [...this.#credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(
    providerId: string,
    operation: (current: ProviderCredential | undefined) => Promise<ProviderCredential | undefined>,
  ): Promise<ProviderCredential | undefined> {
    const previous = this.#tails.get(providerId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const current = this.#credentials.get(providerId);
      const replacement = await operation(current === undefined ? undefined : structuredClone(current));
      if (replacement !== undefined) this.#credentials.set(providerId, structuredClone(replacement));
      const stored = replacement ?? current;
      return stored === undefined ? undefined : structuredClone(stored);
    });
    this.#tails.set(providerId, next.catch(() => undefined));
    return next;
  }

  async delete(providerId: string): Promise<void> {
    const previous = this.#tails.get(providerId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => {
      this.#credentials.delete(providerId);
    });
    this.#tails.set(providerId, next.catch(() => undefined));
    await next;
  }
}

export interface ProviderAuthContext {
  env(name: string): Promise<string | undefined>;
  fileExists(path: string): Promise<boolean>;
}

export function defaultProviderAuthContext(environment: NodeJS.ProcessEnv = process.env): ProviderAuthContext {
  return {
    async env(name) {
      const value = environment[name];
      return value === undefined || value.trim() === "" ? undefined : value;
    },
    async fileExists(path) {
      const resolved = path.startsWith("~") ? `${homedir()}${path.slice(1)}` : path;
      try {
        await access(resolved);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export interface ProviderAuthResult {
  auth: ProviderModelAuth;
  env?: Record<string, string>;
  source?: string;
}

export interface ProviderAuthCheck {
  source?: string;
  type: "api_key" | "oauth";
}

export type ProviderAuthPrompt =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string; signal?: AbortSignal }
  | {
      type: "select";
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
      signal?: AbortSignal;
    };

export type ProviderAuthEvent =
  | { type: "info" | "progress"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    };

export interface ProviderAuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: ProviderAuthPrompt): Promise<string>;
  notify(event: ProviderAuthEvent): void;
}

export interface ProviderApiKeyAuth {
  name: string;
  login?(interaction: ProviderAuthInteraction): Promise<ProviderApiKeyCredential>;
  check?(input: {
    ctx: ProviderAuthContext;
    credential?: ProviderApiKeyCredential;
  }): Promise<ProviderAuthCheck | undefined>;
  resolve(input: {
    ctx: ProviderAuthContext;
    credential?: ProviderApiKeyCredential;
  }): Promise<ProviderAuthResult | undefined>;
}

export interface ProviderOAuthAuth {
  name: string;
  loginLabel?: string;
  login(interaction: ProviderAuthInteraction): Promise<ProviderOAuthCredential>;
  refresh(credential: ProviderOAuthCredential, signal?: AbortSignal): Promise<ProviderOAuthCredential>;
  toAuth(credential: ProviderOAuthCredential): Promise<ProviderModelAuth>;
}

export interface ProviderAuth {
  apiKey?: ProviderApiKeyAuth;
  oauth?: ProviderOAuthAuth;
}

export interface ProviderStreamOptions {
  signal?: AbortSignal;
  apiKey?: string;
  headers?: Record<string, string | null>;
  env?: Record<string, string>;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  toolChoice?: ProviderRequest["toolChoice"];
  temperature?: number;
  cacheRetention?: ProviderCacheRetention;
  thinkingBudgets?: ThinkingBudgets;
  sessionId?: string;
  metadata?: Record<string, string>;
  transport?: Transport;
  maxRetryDelayMs?: number;
  onPayload?: SimpleStreamOptions["onPayload"];
  onResponse?: SimpleStreamOptions["onResponse"];
  transformHeaders?: (
    headers: Record<string, string | null>,
  ) => Record<string, string | null> | Promise<Record<string, string | null>>;
}

export interface ProviderStreamContext {
  messages: CanonicalMessage[];
  tools?: ToolDefinition[];
  providerState?: ProviderState;
}

export interface ProviderStreams {
  stream(
    request: ProviderRequest,
    signal: AbortSignal,
    options?: ProviderStreamOptions,
  ): AsyncIterable<AdapterEvent>;
  streamSimple?(
    request: ProviderRequest,
    signal: AbortSignal,
    options?: ProviderStreamOptions,
  ): AsyncIterable<AdapterEvent>;
}

export interface ProviderRefreshContext {
  credential?: ProviderCredential;
  store: ScopedProviderModelsStore;
  allowNetwork: boolean;
  force?: boolean;
  signal?: AbortSignal;
}

export interface Provider<TApi extends ModelProtocolFamily = ModelProtocolFamily> {
  readonly id: ProviderId;
  readonly name: string;
  readonly baseUrl?: string;
  readonly headers?: Record<string, string | null>;
  readonly auth: ProviderAuth;
  getModels(): readonly ProviderModel<TApi>[];
  refreshModels?(context: ProviderRefreshContext): Promise<void>;
  filterModels?(
    models: readonly ProviderModel<TApi>[],
    credential: ProviderCredential | undefined,
  ): readonly ProviderModel<TApi>[];
  stream(
    model: ProviderModel<TApi>,
    context: ProviderStreamContext,
    options?: ProviderStreamOptions,
  ): AsyncIterable<AdapterEvent>;
  streamSimple(
    model: ProviderModel<TApi>,
    context: ProviderStreamContext,
    options?: ProviderStreamOptions,
  ): AsyncIterable<AdapterEvent>;
}

export interface ProviderRefreshOptions {
  allowNetwork?: boolean;
  force?: boolean;
  signal?: AbortSignal;
}

export interface ProviderRefreshResult {
  aborted: boolean;
  errors: ReadonlyMap<string, Error>;
}

export interface ProviderAuthOverrides {
  apiKey?: string;
  env?: Record<string, string>;
}

export interface ProviderCompletionToolCall {
  index: number;
  id?: string;
  name: string;
  arguments?: JsonValue;
  rawArguments: string;
  parseError?: string;
}

/** Provider-neutral completed response assembled from the same canonical events consumed by the agent loop. */
export interface ProviderCompletion {
  provider: ProviderId;
  model: string;
  text: string;
  reasoning: string;
  toolCalls: ProviderCompletionToolCall[];
  usage?: NormalizedUsage;
  finishReason: import("../core/types.js").FinishReason;
  state?: ProviderState;
  responseId?: string;
  requestId?: string;
  error?: import("../core/types.js").AdapterError;
}

export class ProviderModelsError extends Error {
  constructor(
    readonly code: "model_source" | "model_validation" | "provider" | "stream" | "auth" | "oauth",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProviderModelsError";
  }
}

export interface Models {
  getProviders(): readonly Provider[];
  getProvider(id: string): Provider | undefined;
  getModels(provider?: string): readonly ProviderModel[];
  getModel(provider: string, id: string): ProviderModel | undefined;
  refresh(options?: ProviderRefreshOptions): Promise<ProviderRefreshResult>;
  checkAuth(providerId: string): Promise<ProviderAuthCheck | undefined>;
  getAvailable(providerId?: string): Promise<readonly ProviderModel[]>;
  getAuth(providerId: string, overrides?: ProviderAuthOverrides): Promise<ProviderAuthResult | undefined>;
  getAuth(model: ProviderModel, overrides?: ProviderAuthOverrides): Promise<ProviderAuthResult | undefined>;
  login(
    providerId: string,
    type: "api_key" | "oauth",
    interaction: ProviderAuthInteraction,
  ): Promise<ProviderCredential>;
  logout(providerId: string): Promise<void>;
  stream(
    model: ProviderModel,
    context: ProviderStreamContext,
    options?: ProviderStreamOptions,
  ): AsyncIterable<AdapterEvent>;
  complete(
    model: ProviderModel,
    context: ProviderStreamContext,
    options?: ProviderStreamOptions,
  ): Promise<ProviderCompletion>;
  streamSimple(
    model: ProviderModel,
    context: ProviderStreamContext,
    options?: ProviderStreamOptions,
  ): AsyncIterable<AdapterEvent>;
  completeSimple(
    model: ProviderModel,
    context: ProviderStreamContext,
    options?: ProviderStreamOptions,
  ): Promise<ProviderCompletion>;
}

export interface MutableModels extends Models {
  setProvider(provider: Provider): void;
  deleteProvider(id: string): void;
  clearProviders(): void;
}

export interface CreateModelsOptions {
  credentials?: ProviderCredentialStore;
  modelsStore?: ProviderModelsStore;
  authContext?: ProviderAuthContext;
}

function mergeHeaders(
  base: Record<string, string | null> | undefined,
  override: Record<string, string | null> | undefined,
): Record<string, string | null> | undefined {
  if (base === undefined && override === undefined) return undefined;
  const result = { ...base };
  for (const [name, value] of Object.entries(override ?? {})) {
    for (const existing of Object.keys(result)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete result[existing];
    }
    result[name] = value;
  }
  return result;
}

function overlayAuthContext(base: ProviderAuthContext, env: Record<string, string>): ProviderAuthContext {
  return {
    env: async (name) => env[name] || await base.env(name),
    fileExists: (path) => base.fileExists(path),
  };
}

class ModelsCollection implements MutableModels {
  readonly #providers = new Map<string, Provider>();
  readonly #credentials: ProviderCredentialStore;
  readonly #modelsStore: ProviderModelsStore;
  readonly #authContext: ProviderAuthContext;

  constructor(options: CreateModelsOptions = {}) {
    this.#credentials = options.credentials ?? new InMemoryProviderCredentialStore();
    this.#modelsStore = options.modelsStore ?? new InMemoryProviderModelsStore();
    this.#authContext = options.authContext ?? defaultProviderAuthContext();
  }

  setProvider(provider: Provider): void {
    if (provider.id.trim() === "") throw new TypeError("Provider id must not be empty");
    if (provider.auth.apiKey === undefined && provider.auth.oauth === undefined) {
      throw new TypeError(`Provider ${provider.id} must declare authentication semantics`);
    }
    this.#providers.set(provider.id, provider);
  }

  deleteProvider(id: string): void {
    this.#providers.delete(id);
  }

  clearProviders(): void {
    this.#providers.clear();
  }

  getProviders(): readonly Provider[] {
    return [...this.#providers.values()];
  }

  getProvider(id: string): Provider | undefined {
    return this.#providers.get(id);
  }

  getModels(provider?: string): readonly ProviderModel[] {
    if (provider !== undefined) {
      try {
        return [...(this.#providers.get(provider)?.getModels() ?? [])];
      } catch {
        return [];
      }
    }
    const result: ProviderModel[] = [];
    for (const entry of this.#providers.values()) {
      try {
        result.push(...entry.getModels());
      } catch {
        // Model listing is a best-effort synchronous snapshot.
      }
    }
    return result;
  }

  getModel(provider: string, id: string): ProviderModel | undefined {
    return this.getModels(provider).find((model) => model.id === id);
  }

  async refresh(options: ProviderRefreshOptions = {}): Promise<ProviderRefreshResult> {
    const allowNetwork = options.allowNetwork ?? true;
    const errors = new Map<string, Error>();
    const providers = [...this.#providers.values()].filter(
      (provider): provider is Provider & Required<Pick<Provider, "refreshModels">> => provider.refreshModels !== undefined,
    );
    await Promise.all(providers.map(async (provider) => {
      if (options.signal?.aborted) return;
      const store: ScopedProviderModelsStore = {
        read: () => this.#modelsStore.read(provider.id),
        write: (entry) => this.#modelsStore.write(provider.id, entry),
        delete: () => this.#modelsStore.delete(provider.id),
      };
      let stored: ProviderCredential | undefined;
      try {
        stored = await this.#readCredential(provider.id);
        const credential = await this.#refreshCredential(provider, stored, allowNetwork, options.signal);
        await provider.refreshModels({
          ...(credential === undefined ? {} : { credential }),
          store,
          allowNetwork,
          ...(options.force === undefined ? {} : { force: options.force }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        if (!options.signal?.aborted) {
          errors.set(provider.id, error instanceof Error ? error : new Error(String(error)));
        }
        try {
          await provider.refreshModels({
            store,
            allowNetwork: false,
            ...(stored === undefined ? {} : { credential: stored }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
        } catch {
          // Retaining the provider's last good list is preferable to replacing the first error.
        }
      }
    }));
    return { aborted: options.signal?.aborted ?? false, errors };
  }

  async #refreshCredential(
    provider: Provider,
    stored: ProviderCredential | undefined,
    allowNetwork: boolean,
    signal?: AbortSignal,
  ): Promise<ProviderCredential | undefined> {
    if (stored?.type === "oauth") {
      const oauth = provider.auth.oauth;
      if (oauth === undefined) return undefined;
      if (!allowNetwork || stored.expires > Date.now()) return stored;
      if (signal?.aborted) return undefined;
      const post = await this.#credentials.modify(provider.id, async (current) => {
        if (current?.type !== "oauth" || current.expires > Date.now()) return undefined;
        return await oauth.refresh(current, signal);
      });
      return post?.type === "oauth" ? post : undefined;
    }
    const auth = provider.auth.apiKey;
    if (auth === undefined) return undefined;
    const result = await this.#resolveApiKey(provider, this.#authContext, stored?.type === "api_key" ? stored : undefined);
    if (result === undefined) return undefined;
    return {
      type: "api_key",
      ...(result.auth.apiKey === undefined ? {} : { key: result.auth.apiKey }),
      ...(result.env === undefined ? {} : { env: result.env }),
    };
  }

  async #readCredential(providerId: string): Promise<ProviderCredential | undefined> {
    try {
      return await this.#credentials.read(providerId);
    } catch (error) {
      throw new ProviderModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
    }
  }

  async #resolveApiKey(
    provider: Provider,
    context: ProviderAuthContext,
    credential: ProviderApiKeyCredential | undefined,
  ): Promise<ProviderAuthResult | undefined> {
    const auth = provider.auth.apiKey;
    if (auth === undefined) return undefined;
    try {
      return await auth.resolve({
        ctx: context,
        ...(credential === undefined ? {} : { credential }),
      });
    } catch (error) {
      throw new ProviderModelsError("auth", `API key authentication failed for provider ${provider.id}`, { cause: error });
    }
  }

  async #resolveAuth(
    provider: Provider,
    overrides: ProviderAuthOverrides = {},
  ): Promise<ProviderAuthResult | undefined> {
    const ctx = overrides.env === undefined ? this.#authContext : overlayAuthContext(this.#authContext, overrides.env);
    if (overrides.apiKey !== undefined && provider.auth.apiKey !== undefined) {
      return await this.#resolveApiKey(provider, ctx, {
        type: "api_key",
        key: overrides.apiKey,
        ...(overrides.env === undefined ? {} : { env: overrides.env }),
      });
    }
    const stored = await this.#readCredential(provider.id);
    if (stored !== undefined) {
      if (stored.type === "oauth" && provider.auth.oauth !== undefined) {
        let credential = stored;
        if (credential.expires <= Date.now()) {
          let post: ProviderCredential | undefined;
          try {
            post = await this.#credentials.modify(provider.id, async (current) => {
              if (current?.type !== "oauth" || current.expires > Date.now()) return undefined;
              try {
                return await provider.auth.oauth!.refresh(current);
              } catch (error) {
                throw new ProviderModelsError("oauth", `OAuth refresh failed for ${provider.id}`, { cause: error });
              }
            });
          } catch (error) {
            if (error instanceof ProviderModelsError) throw error;
            throw new ProviderModelsError("auth", `Credential store modify failed for ${provider.id}`, { cause: error });
          }
          if (post?.type !== "oauth") return undefined;
          credential = post;
        }
        try {
          return { auth: await provider.auth.oauth.toAuth(credential), source: "OAuth" };
        } catch (error) {
          throw new ProviderModelsError("oauth", `OAuth authentication failed for ${provider.id}`, { cause: error });
        }
      }
      if (stored.type === "api_key" && provider.auth.apiKey !== undefined) {
        const credential = overrides.env === undefined
          ? stored
          : { ...stored, env: { ...stored.env, ...overrides.env } };
        return await this.#resolveApiKey(provider, ctx, credential);
      }
      // A stored credential owns the provider. Never silently fall back to ambient auth.
      return undefined;
    }
    return await this.#resolveApiKey(provider, ctx, undefined);
  }

  async checkAuth(providerId: string): Promise<ProviderAuthCheck | undefined> {
    const provider = this.#providers.get(providerId);
    if (provider === undefined) return undefined;
    const stored = await this.#readCredential(providerId);
    if (stored?.type === "oauth") return provider.auth.oauth === undefined ? undefined : { type: "oauth", source: "OAuth" };
    const auth = provider.auth.apiKey;
    if (auth === undefined) return undefined;
    if (auth.check !== undefined) {
      try {
        return await auth.check({
          ctx: this.#authContext,
          ...(stored?.type === "api_key" ? { credential: stored } : {}),
        });
      } catch (error) {
        throw new ProviderModelsError("auth", `API key authentication check failed for provider ${provider.id}`, { cause: error });
      }
    }
    const result = await this.#resolveAuth(provider);
    return result === undefined
      ? undefined
      : { type: "api_key", ...(result.source === undefined ? {} : { source: result.source }) };
  }

  async getAvailable(providerId?: string): Promise<readonly ProviderModel[]> {
    const providers = providerId === undefined
      ? this.getProviders()
      : [this.#providers.get(providerId)].filter((provider): provider is Provider => provider !== undefined);
    const results = await Promise.all(providers.map(async (provider) => {
      const credential = await this.#readCredential(provider.id);
      const auth = await this.checkAuth(provider.id);
      if (auth === undefined) return [];
      const models = provider.getModels();
      return [...(provider.filterModels?.(models, credential) ?? models)];
    }));
    return results.flat();
  }

  getAuth(providerId: string, overrides?: ProviderAuthOverrides): Promise<ProviderAuthResult | undefined>;
  getAuth(model: ProviderModel, overrides?: ProviderAuthOverrides): Promise<ProviderAuthResult | undefined>;
  async getAuth(
    providerOrModel: string | ProviderModel,
    overrides: ProviderAuthOverrides = {},
  ): Promise<ProviderAuthResult | undefined> {
    const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
    const provider = this.#providers.get(providerId);
    if (provider === undefined) return undefined;
    let result: ProviderAuthResult | undefined;
    try {
      result = await this.#resolveAuth(provider, overrides);
    } catch (error) {
      if (error instanceof ProviderModelsError) throw error;
      throw new ProviderModelsError("auth", `Authentication failed for ${providerId}`, { cause: error });
    }
    if (result === undefined || typeof providerOrModel === "string") return result;
    return {
      ...result,
      auth: {
        ...result.auth,
        ...(() => {
          const headers = mergeHeaders(result.auth.headers, providerOrModel.headers);
          return headers === undefined ? {} : { headers };
        })(),
      },
    };
  }

  async login(
    providerId: string,
    type: "api_key" | "oauth",
    interaction: ProviderAuthInteraction,
  ): Promise<ProviderCredential> {
    const provider = this.#providers.get(providerId);
    if (provider === undefined) throw new ProviderModelsError("provider", `Unknown provider: ${providerId}`);
    const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
    if (method?.login === undefined) {
      throw new ProviderModelsError("auth", `${provider.name} does not support ${type} login`);
    }
    const credential = await method.login(interaction);
    try {
      await this.#credentials.modify(providerId, async () => credential);
    } catch (error) {
      throw new ProviderModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
    }
    return credential;
  }

  async logout(providerId: string): Promise<void> {
    try {
      await this.#credentials.delete(providerId);
    } catch (error) {
      throw new ProviderModelsError("auth", `Credential store delete failed for ${providerId}`, { cause: error });
    }
  }

  stream(
    model: ProviderModel,
    context: ProviderStreamContext,
    options: ProviderStreamOptions = {},
  ): AsyncIterable<AdapterEvent> {
    return this.#stream(model, context, options, false);
  }

  complete(
    model: ProviderModel,
    context: ProviderStreamContext,
    options: ProviderStreamOptions = {},
  ): Promise<ProviderCompletion> {
    return completeProviderStream(model, this.stream(model, context, options));
  }

  streamSimple(
    model: ProviderModel,
    context: ProviderStreamContext,
    options: ProviderStreamOptions = {},
  ): AsyncIterable<AdapterEvent> {
    return this.#stream(model, context, options, true);
  }

  completeSimple(
    model: ProviderModel,
    context: ProviderStreamContext,
    options: ProviderStreamOptions = {},
  ): Promise<ProviderCompletion> {
    return completeProviderStream(model, this.streamSimple(model, context, options));
  }

  #stream(
    model: ProviderModel,
    context: ProviderStreamContext,
    options: ProviderStreamOptions,
    simple: boolean,
  ): AsyncIterable<AdapterEvent> {
    const provider = this.#providers.get(model.provider);
    if (provider === undefined) return errorStream(`Unknown provider: ${model.provider}`);
    return lazyProviderStream(async () => {
      const resolution = await this.getAuth(model, {
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.env === undefined ? {} : { env: options.env }),
      });
      if (resolution === undefined) {
        throw new ProviderModelsError("auth", `Provider is not configured: ${model.provider}`);
      }
      let headers = mergeHeaders(resolution.auth.headers, options.headers);
      if (options.transformHeaders !== undefined) headers = await options.transformHeaders(headers ?? {});
      const env = resolution.env !== undefined || options.env !== undefined
        ? { ...resolution.env, ...options.env }
        : undefined;
      const requestModel = resolution.auth.baseUrl === undefined
        ? model
        : { ...model, baseUrl: resolution.auth.baseUrl };
      const requestOptions = {
        ...options,
        ...((options.apiKey ?? resolution.auth.apiKey) === undefined
          ? {}
          : { apiKey: options.apiKey ?? resolution.auth.apiKey }),
        ...(headers === undefined ? {} : { headers }),
        ...(env === undefined ? {} : { env }),
      };
      return simple
        ? provider.streamSimple(requestModel, context, requestOptions)
        : provider.stream(requestModel, context, requestOptions);
    });
  }
}

async function completeProviderStream(
  model: ProviderModel,
  stream: AsyncIterable<AdapterEvent>,
): Promise<ProviderCompletion> {
  let text = "";
  let reasoning = "";
  let usage: NormalizedUsage | undefined;
  let finishReason: ProviderCompletion["finishReason"] = "incomplete";
  let state: ProviderState | undefined;
  let responseId: string | undefined;
  let requestId: string | undefined;
  let error: ProviderCompletion["error"];
  const toolCalls: ProviderCompletionToolCall[] = [];
  for await (const event of stream) {
    if (event.type === "response_start") {
      responseId = event.responseId ?? responseId;
      requestId = event.requestId ?? requestId;
    } else if (event.type === "text_delta") {
      text += event.text;
    } else if (event.type === "reasoning_delta") {
      reasoning += event.text;
    } else if (event.type === "tool_call_end") {
      toolCalls.push({
        index: event.index,
        ...(event.id === undefined ? {} : { id: event.id }),
        name: event.name,
        ...(event.arguments === undefined ? {} : { arguments: event.arguments }),
        rawArguments: event.rawArguments,
        ...(event.parseError === undefined ? {} : { parseError: event.parseError }),
      });
    } else if (event.type === "usage") {
      usage = event.usage;
    } else if (event.type === "response_end") {
      finishReason = event.reason;
      state = event.state;
    } else if (event.type === "error") {
      finishReason = event.error.category === "cancelled" ? "cancelled" : "error";
      error = event.error;
    }
  }
  return {
    provider: model.provider,
    model: model.id,
    text,
    reasoning,
    toolCalls,
    ...(usage === undefined ? {} : { usage }),
    finishReason,
    ...(state === undefined ? {} : { state }),
    ...(responseId === undefined ? {} : { responseId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(error === undefined ? {} : { error }),
  };
}

async function* lazyProviderStream(
  create: () => Promise<AsyncIterable<AdapterEvent>>,
): AsyncIterable<AdapterEvent> {
  try {
    yield* await create();
  } catch (error) {
    yield* errorStream(error instanceof Error ? error.message : String(error));
  }
}

async function* errorStream(message: string): AsyncIterable<AdapterEvent> {
  yield {
    type: "error",
    error: {
      category: "provider",
      message,
      retryable: false,
      partial: false,
    },
  };
}

export function createModels(options?: CreateModelsOptions): MutableModels {
  return new ModelsCollection(options);
}

export interface CreateProviderOptions<TApi extends ModelProtocolFamily = ModelProtocolFamily> {
  id: ProviderId;
  name?: string;
  baseUrl?: string;
  headers?: Record<string, string | null>;
  auth: ProviderAuth;
  models: readonly ProviderModel<TApi>[];
  fetchModels?(context: ProviderRefreshContext): Promise<readonly ProviderModel<TApi>[]>;
  filterModels?(
    models: readonly ProviderModel<TApi>[],
    credential: ProviderCredential | undefined,
  ): readonly ProviderModel<TApi>[];
  api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;
}

/** Build a direct provider, including mixed-protocol dispatch and a persisted dynamic overlay. */
export function createProvider<TApi extends ModelProtocolFamily = ModelProtocolFamily>(
  input: CreateProviderOptions<TApi>,
): Provider<TApi> {
  const baseline = [...input.models];
  let dynamic: readonly ProviderModel<TApi>[] = [];
  let activeRefresh: Promise<void> | undefined;
  const direct = typeof (input.api as ProviderStreams).stream === "function"
    ? input.api as ProviderStreams
    : undefined;
  const byApi = direct === undefined ? input.api as Partial<Record<TApi, ProviderStreams>> : undefined;
  const models = () => {
    const result = [...baseline];
    for (const model of dynamic) {
      const index = result.findIndex((entry) => entry.id === model.id);
      if (index < 0) result.push(model);
      else result[index] = model;
    }
    return result;
  };
  const dispatch = (
    model: ProviderModel<TApi>,
    context: ProviderStreamContext,
    options: ProviderStreamOptions,
    simple: boolean,
  ): AsyncIterable<AdapterEvent> => {
    const implementation = direct ?? byApi?.[model.api];
    if (implementation === undefined) {
      return errorStream(`Provider ${input.id} has no API implementation for ${model.api}`);
    }
    const signal = options.signal ?? new AbortController().signal;
    const request: ProviderRequest = {
      provider: input.id,
      model: model.id,
      api: model.api,
      messages: context.messages,
      tools: context.tools ?? [],
      ...(context.providerState === undefined ? {} : { providerState: context.providerState }),
      ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.cacheRetention === undefined ? {} : { cacheRetention: options.cacheRetention }),
      ...(options.thinkingBudgets === undefined ? {} : { thinkingBudgets: options.thinkingBudgets }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
      ...(model.compat === undefined ? {} : { modelSettings: { compatibility: structuredClone(model.compat) } }),
    };
    return simple && implementation.streamSimple !== undefined
      ? implementation.streamSimple(request, signal, options)
      : implementation.stream(request, signal, options);
  };
  const provider: Provider<TApi> = {
    id: input.id,
    name: input.name ?? input.id,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    auth: input.auth,
    getModels: models,
    ...(input.fetchModels === undefined
      ? {}
      : {
          refreshModels(context: ProviderRefreshContext) {
            activeRefresh ??= (async () => {
              try {
                const stored = await context.store.read();
                if (stored !== undefined) {
                  dynamic = stored.models.filter((model) => model.provider === input.id) as ProviderModel<TApi>[];
                }
                if (!context.allowNetwork || context.signal?.aborted) return;
                const refreshed = await input.fetchModels!(context);
                if (context.signal?.aborted) return;
                dynamic = [...refreshed];
                await context.store.write({ models: refreshed, checkedAt: Date.now() });
              } finally {
                activeRefresh = undefined;
              }
            })();
            return activeRefresh;
          },
        }),
    ...(input.filterModels === undefined ? {} : { filterModels: input.filterModels }),
    stream(model, context, options = {}) {
      return dispatch(model, context, options, false);
    },
    streamSimple(model, context, options = {}) {
      return dispatch(model, context, options, true);
    },
  };
  return provider;
}

export function hasApi<TApi extends ModelProtocolFamily>(
  model: ProviderModel,
  api: TApi,
): model is ProviderModel<TApi> {
  return model.api === api;
}

const PROVIDER_THINKING_LEVELS: readonly ProviderModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function getSupportedThinkingLevels(model: ProviderModel): ProviderModelThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return PROVIDER_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function clampThinkingLevel(
  model: ProviderModel,
  level: ProviderModelThinkingLevel,
): ProviderModelThinkingLevel {
  const available = getSupportedThinkingLevels(model);
  if (available.includes(level)) return level;
  const requested = PROVIDER_THINKING_LEVELS.indexOf(level);
  for (let index = requested; index < PROVIDER_THINKING_LEVELS.length; index += 1) {
    const candidate = PROVIDER_THINKING_LEVELS[index];
    if (candidate !== undefined && available.includes(candidate)) return candidate;
  }
  for (let index = requested - 1; index >= 0; index -= 1) {
    const candidate = PROVIDER_THINKING_LEVELS[index];
    if (candidate !== undefined && available.includes(candidate)) return candidate;
  }
  return available[0] ?? "off";
}

export function modelsAreEqual(
  left: ProviderModel | null | undefined,
  right: ProviderModel | null | undefined,
): boolean {
  return left !== undefined && left !== null && right !== undefined && right !== null &&
    left.provider === right.provider && left.id === right.id;
}

export function calculateCost(model: ProviderModel, usage: NormalizedUsage): NonNullable<NormalizedUsage["cost"]> {
  const inputTokens = usage.inputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  let rates: ProviderModelCost = model.cost;
  let matchedThreshold = -1;
  for (const tier of model.cost.tiers ?? []) {
    if (inputTokens + cacheReadTokens + cacheWriteTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      rates = tier;
      matchedThreshold = tier.inputTokensAbove;
    }
  }
  const input = (rates.input / 1_000_000) * inputTokens;
  const output = (rates.output / 1_000_000) * (usage.outputTokens ?? 0);
  const cacheRead = (rates.cacheRead / 1_000_000) * cacheReadTokens;
  const longWriteTokens = usage.cacheWrite1hTokens ?? 0;
  const shortWriteTokens = cacheWriteTokens - longWriteTokens;
  const cacheWrite = ((rates.cacheWrite * shortWriteTokens) + (rates.input * 2 * longWriteTokens)) / 1_000_000;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
