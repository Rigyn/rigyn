import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { homedir } from "node:os";

import { errorMessage } from "../core/errors.js";
import type { JsonValue } from "../core/json.js";
import type {
  AdapterEvent,
  AssistantContentBlock,
  CanonicalMessage,
  ModelProtocolFamily,
  ModelRequestCompatibility,
  NormalizedUsage,
  ProviderId,
  ProviderCacheRetention,
  ProviderRequest,
  ProviderState,
  ThinkingBudgets,
  ProviderToolDefinition,
} from "../core/types.js";
import { addNormalizedUsage, canonicalUsageCost, isNormalizedUsage } from "../core/usage.js";
import { validatedAssistantContent } from "../core/public-assistant-content.js";
import { validateProviderState } from "../core/provider-state.js";
import { ASSISTANT_CONTENT_LIMITS } from "@rigyn/kernel/runtime/core/assistant-content-limits";
import type { SimpleStreamOptions, Transport } from "@rigyn/models";
import type {
  ProviderModelsStore,
  ScopedProviderModelsStore,
} from "./models-store.js";
import { InMemoryProviderModelsStore } from "./models-store.js";
import { protectProviderAuth, protectProviderEnvironment } from "./auth-protection.js";
import { providerCredentialScope } from "./provider-credential-scope.js";
import { ProviderStreamProjector } from "./stream-envelope.js";

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
  maxInputTokens?: number;
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
    signal?: AbortSignal,
  ): Promise<ProviderCredential | undefined>;
  delete(providerId: string): Promise<void>;
}

export class InMemoryProviderCredentialStore implements ProviderCredentialStore {
  readonly #credentials = new Map<string, ProviderCredential>();
  readonly #tails = new Map<string, Promise<unknown>>();

  #trackMutation(providerId: string, next: Promise<unknown>): void {
    let tail!: Promise<void>;
    const release = (): void => {
      if (this.#tails.get(providerId) === tail) this.#tails.delete(providerId);
    };
    tail = next.then(release, release);
    this.#tails.set(providerId, tail);
  }

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
    signal?: AbortSignal,
  ): Promise<ProviderCredential | undefined> {
    signal?.throwIfAborted();
    const previous = this.#tails.get(providerId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      signal?.throwIfAborted();
      const current = this.#credentials.get(providerId);
      const replacement = await operation(current === undefined ? undefined : structuredClone(current));
      signal?.throwIfAborted();
      if (replacement !== undefined) this.#credentials.set(providerId, structuredClone(replacement));
      const stored = replacement ?? current;
      return stored === undefined ? undefined : structuredClone(stored);
    });
    this.#trackMutation(providerId, next);
    return next;
  }

  async delete(providerId: string): Promise<void> {
    const previous = this.#tails.get(providerId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => {
      this.#credentials.delete(providerId);
    });
    this.#trackMutation(providerId, next);
    await next;
  }
}

export interface ProviderAuthContext {
  env(name: string): Promise<string | undefined>;
  fileExists(path: string): Promise<boolean>;
  signal?: AbortSignal;
  shellPath?: string;
}

export function defaultProviderAuthContext(
  environment: NodeJS.ProcessEnv = process.env,
  options: { shellPath?: string } = {},
): ProviderAuthContext {
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
    ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
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
      expiresInSeconds?: number;
      intervalSeconds?: number;
      userCode: string;
      verificationUri: string;
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
  login?(interaction: ProviderAuthInteraction): Promise<ProviderOAuthCredential>;
  refresh?(credential: ProviderOAuthCredential, signal?: AbortSignal): Promise<ProviderOAuthCredential>;
  toAuth(credential: ProviderOAuthCredential, context?: ProviderAuthContext): Promise<ProviderModelAuth>;
}

/** Interactive account acquisition that returns the credential persisted by the host. */
export interface ProviderAccountAuth {
  name: string;
  loginLabel?: string;
  login(interaction: ProviderAuthInteraction): Promise<ProviderCredential>;
}

export interface ProviderAuth {
  apiKey?: ProviderApiKeyAuth;
  oauth?: ProviderOAuthAuth;
  providerAccount?: ProviderAccountAuth;
}

export interface ProviderStreamOptions {
  signal?: AbortSignal;
  apiKey?: string;
  headers?: Record<string, string | null>;
  env?: Record<string, string>;
  /** Internal request-scoped provenance; never copied into ProviderRequest or session state. */
  authSource?: string;
  fetch?: typeof fetch;
  maxOutputTokens?: number;
  reasoningEffort?: string;
  toolChoice?: ProviderRequest["toolChoice"];
  temperature?: number;
  cacheRetention?: ProviderCacheRetention;
  thinkingBudgets?: ThinkingBudgets;
  sessionId?: string;
  metadata?: Record<string, string>;
  transport?: Transport;
  timeoutMs?: number;
  websocketConnectTimeoutMs?: number;
  websocketIdleTimeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  onPayload?: SimpleStreamOptions["onPayload"];
  onResponse?: SimpleStreamOptions["onResponse"];
  transformHeaders?: (
    headers: Record<string, string | null>,
  ) => Record<string, string | null> | Promise<Record<string, string | null>>;
}

export interface ProviderStreamContext {
  messages: CanonicalMessage[];
  tools?: ProviderToolDefinition[];
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
  /** Refresh stored OAuth before it has less than this many milliseconds remaining. */
  minOAuthValidityMs?: number;
  signal?: AbortSignal;
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
  refreshProvider(providerId: string, options?: ProviderRefreshOptions): Promise<ProviderRefreshResult>;
  checkAuth(providerId: string): Promise<ProviderAuthCheck | undefined>;
  getAvailable(providerId?: string): Promise<readonly ProviderModel[]>;
  getAuth(providerId: string, overrides?: ProviderAuthOverrides): Promise<ProviderAuthResult | undefined>;
  getAuth(model: ProviderModel, overrides?: ProviderAuthOverrides): Promise<ProviderAuthResult | undefined>;
  login(
    providerId: string,
    type: "api_key" | "oauth" | "provider_account",
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

function protectProviderAuthResult(result: ProviderAuthResult): ProviderAuthResult {
  protectProviderAuth(result.auth);
  protectProviderEnvironment(result.env);
  return result;
}

function overlayAuthContext(
  base: ProviderAuthContext,
  env: Record<string, string>,
  signal = base.signal,
): ProviderAuthContext {
  return {
    env: async (name) => env[name] || await base.env(name),
    fileExists: (path) => base.fileExists(path),
    ...(signal === undefined ? {} : { signal }),
    ...(base.shellPath === undefined ? {} : { shellPath: base.shellPath }),
  };
}

function providerModelsCacheScope(
  providerId: string,
  credential: ProviderCredential | undefined,
  profileScope = providerCredentialScope(credential),
): string | undefined {
  const hash = createHash("sha256");
  const add = (value: string): void => {
    hash.update(`${Buffer.byteLength(value, "utf8")}:`);
    hash.update(value);
  };
  add("rigyn-provider-model-cache-v1");
  add(providerId);
  if (credential === undefined) {
    add("anonymous");
    return `credential-v1:${hash.digest("hex")}`;
  }
  if (profileScope !== undefined) {
    add("profile");
    add(profileScope);
  }
  if (credential.type === "api_key") {
    const env = Object.entries(credential.env ?? {}).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0);
    if (credential.key === undefined && env.length === 0) return undefined;
    add("api_key");
    if (credential.key !== undefined) {
      add("key");
      add(credential.key);
    }
    for (const [name, value] of env) {
      add(`env.${name}`);
      add(value);
    }
  } else {
    add("oauth");
    const identities: Array<[string, string]> = [];
    if (typeof credential.accountId === "string" && credential.accountId !== "") {
      identities.push(["accountId", credential.accountId]);
    }
    if (typeof credential.subject === "string" && credential.subject !== "") {
      identities.push(["subject", credential.subject]);
    }
    if (identities.length === 0) {
      identities.push(credential.refresh === ""
        ? ["access", credential.access]
        : ["refresh", credential.refresh]);
    }
    for (const [name, value] of identities) {
      add(name);
      add(value);
    }
  }
  return `credential-v1:${hash.digest("hex")}`;
}

function waitForRefreshTurn(turn: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return turn;
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    turn.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function providerModelsFailure(error: unknown): Error {
  const isError = (Error as ErrorConstructor & { isError?: (candidate: unknown) => boolean }).isError;
  if (isError?.(error) === true) {
    const message = Object.getOwnPropertyDescriptor(error, "message");
    if (message !== undefined && "value" in message && typeof message.value === "string") return error as Error;
  }
  return new Error(errorMessage(error));
}

function isProviderModelsError(error: unknown): error is ProviderModelsError {
  const isError = (Error as ErrorConstructor & { isError?: (candidate: unknown) => boolean }).isError;
  return isError?.(error) === true && Object.getPrototypeOf(error) === ProviderModelsError.prototype;
}

const supersedingRefreshProviders = new WeakSet<Provider>();

class ModelsCollection implements MutableModels {
  readonly #providers = new Map<string, Provider>();
  readonly #credentials: ProviderCredentialStore;
  readonly #modelsStore: ProviderModelsStore;
  readonly #authContext: ProviderAuthContext;
  #refreshTail: Promise<void> = Promise.resolve();
  readonly #pendingRefreshes: Array<{
    allowNetwork: boolean;
    force: boolean | undefined;
    signal: AbortSignal | undefined;
    promise: Promise<ProviderRefreshResult>;
  }> = [];

  constructor(options: CreateModelsOptions = {}) {
    this.#credentials = options.credentials ?? new InMemoryProviderCredentialStore();
    this.#modelsStore = options.modelsStore ?? new InMemoryProviderModelsStore();
    this.#authContext = options.authContext ?? defaultProviderAuthContext();
  }

  setProvider(provider: Provider): void {
    if (provider.id.trim() === "") throw new TypeError("Provider id cannot be blank");
    if (provider.auth.apiKey === undefined && provider.auth.oauth === undefined) {
      throw new TypeError(`Provider ${provider.id} must define an API-key or OAuth method`);
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

  #scopedModelsStore(
    providerId: string,
    cacheScope: string | undefined,
    modelsStore: ProviderModelsStore = this.#modelsStore,
  ): ScopedProviderModelsStore {
    if (cacheScope === undefined) {
      return {
        read: async () => {
          await modelsStore.delete(providerId);
          return undefined;
        },
        write: async () => undefined,
        delete: () => modelsStore.delete(providerId),
      };
    }
    return {
      read: async () => {
        const entry = await modelsStore.read(providerId, cacheScope);
        return entry?.cacheScope === cacheScope ? entry : undefined;
      },
      write: (entry) => modelsStore.write(providerId, { ...entry, cacheScope }),
      delete: () => modelsStore.delete(providerId),
    };
  }

  refresh(options: ProviderRefreshOptions = {}): Promise<ProviderRefreshResult> {
    const request = {
      allowNetwork: options.allowNetwork ?? true,
      force: options.force,
      signal: options.signal,
    };
    const latest = this.#pendingRefreshes[this.#pendingRefreshes.length - 1];
    const existing =
      latest?.allowNetwork === request.allowNetwork &&
      latest.force === request.force &&
      latest.signal === request.signal
        ? latest
        : undefined;
    if (existing !== undefined) return existing.promise;
    const selected = { ...options };
    const canSupersede = selected.force === true && [...this.#providers.values()].every((provider) =>
      provider.refreshModels === undefined || supersedingRefreshProviders.has(provider));
    const operation = canSupersede
      ? this.#refreshNow(selected)
      : waitForRefreshTurn(this.#refreshTail, selected.signal).then(() => this.#refreshNow(selected));
    this.#refreshTail = operation.then(() => undefined, () => undefined);
    const pending = { ...request, promise: operation };
    this.#pendingRefreshes.push(pending);
    const remove = (): void => {
      const index = this.#pendingRefreshes.indexOf(pending);
      if (index >= 0) this.#pendingRefreshes.splice(index, 1);
    };
    void operation.then(remove, remove);
    return operation;
  }

  refreshProvider(providerId: string, options: ProviderRefreshOptions = {}): Promise<ProviderRefreshResult> {
    if (!this.#providers.has(providerId)) {
      return Promise.resolve({
        aborted: options.signal?.aborted ?? false,
        errors: new Map([[providerId, new Error(`Unknown provider: ${providerId}`)]]),
      });
    }
    return this.#refreshNow(options, providerId);
  }

  async #refreshNow(options: ProviderRefreshOptions, providerId?: string): Promise<ProviderRefreshResult> {
    const allowNetwork = options.allowNetwork ?? true;
    const errors = new Map<string, Error>();
    const providers = [...this.#providers.values()].filter(
      (provider): provider is Provider & Required<Pick<Provider, "refreshModels">> =>
        provider.refreshModels !== undefined && (providerId === undefined || provider.id === providerId),
    );
    if (providers.length === 0) return { aborted: options.signal?.aborted ?? false, errors };
    let modelsStore = this.#modelsStore;
    try {
      modelsStore = await this.#modelsStore.snapshot?.() ?? this.#modelsStore;
    } catch (error) {
      const failure = providerModelsFailure(error);
      modelsStore = {
        read: async () => { throw failure; },
        write: (providerId, entry) => this.#modelsStore.write(providerId, entry),
        delete: (providerId) => this.#modelsStore.delete(providerId),
      };
    }
    await Promise.all(providers.map(async (provider) => {
      if (options.signal?.aborted) return;
      let store = this.#scopedModelsStore(
        provider.id,
        providerModelsCacheScope(provider.id, undefined),
        modelsStore,
      );
      let stored: ProviderCredential | undefined;
      try {
        stored = await this.#readCredential(provider.id);
        const storedScope = providerCredentialScope(stored);
        store = this.#scopedModelsStore(
          provider.id,
          providerModelsCacheScope(provider.id, stored, storedScope),
          modelsStore,
        );
        const credential = await this.#refreshCredential(provider, stored, allowNetwork, options.signal);
        if (options.signal?.aborted) return;
        store = this.#scopedModelsStore(
          provider.id,
          providerModelsCacheScope(provider.id, credential, providerCredentialScope(credential) ?? storedScope),
          modelsStore,
        );
        await provider.refreshModels({
          ...(credential === undefined ? {} : { credential }),
          store,
          allowNetwork,
          ...(options.force === undefined ? {} : { force: options.force }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        if (!options.signal?.aborted) {
          errors.set(provider.id, providerModelsFailure(error));
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
    if (!allowNetwork) return stored;
    if (stored?.type === "oauth") {
      const oauth = provider.auth.oauth;
      if (oauth === undefined) return undefined;
      if (!allowNetwork || stored.expires > Date.now()) return stored;
      if (signal?.aborted) return undefined;
      if (oauth.refresh === undefined) {
        throw new ProviderModelsError(
          "oauth",
          `OAuth credentials for ${provider.id} require refresh, but no refresh capability is configured; configure a reviewed OAuth client registration and sign in again`,
        );
      }
      const post = await this.#credentials.modify(provider.id, async (current) => {
        if (current?.type !== "oauth" || current.expires > Date.now()) return undefined;
        return await oauth.refresh!(current, signal);
      }, signal);
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
      throw new ProviderModelsError("auth", `Unable to read saved credentials for ${providerId}`, { cause: error });
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
    const requestedOAuthValidityMs = overrides.minOAuthValidityMs ?? 0;
    const ctx = overrides.env === undefined && overrides.signal === undefined
      ? this.#authContext
      : overlayAuthContext(this.#authContext, overrides.env ?? {}, overrides.signal);
    if (overrides.apiKey !== undefined && provider.auth.apiKey !== undefined) {
      const result = await this.#resolveApiKey(provider, ctx, {
        type: "api_key",
        key: overrides.apiKey,
        ...(overrides.env === undefined ? {} : { env: overrides.env }),
      });
      return result === undefined ? undefined : { ...result, source: "request override" };
    }
    if (overrides.apiKey !== undefined && provider.auth.oauth !== undefined) {
      return { auth: { apiKey: overrides.apiKey }, source: "request override" };
    }
    const stored = await this.#readCredential(provider.id);
    if (stored !== undefined) {
      if (stored.type === "oauth" && provider.auth.oauth !== undefined) {
        const proactiveValidityMs = Math.max(5 * 60_000, requestedOAuthValidityMs);
        const expiresSoon = (credential: ProviderOAuthCredential): boolean =>
          Date.now() + proactiveValidityMs >= credential.expires;
        let credential = stored;
        if (expiresSoon(credential)) {
          if (provider.auth.oauth.refresh === undefined) {
            throw new ProviderModelsError(
              "oauth",
              `OAuth credentials for ${provider.id} require refresh, but no refresh capability is configured; configure a reviewed OAuth client registration and sign in again`,
            );
          }
          let post: ProviderCredential | undefined;
          try {
            post = await this.#credentials.modify(provider.id, async (current) => {
              if (current?.type !== "oauth" || !expiresSoon(current)) return undefined;
              try {
                return await provider.auth.oauth!.refresh!(current, overrides.signal);
              } catch (error) {
						if (isProviderModelsError(error)) throw error;
                throw new ProviderModelsError("oauth", `Could not refresh OAuth credentials for ${provider.id}`, { cause: error });
              }
            }, overrides.signal);
          } catch (error) {
            if (isProviderModelsError(error)) throw error;
            throw new ProviderModelsError("auth", `Unable to update saved credentials for ${provider.id}`, { cause: error });
          }
          if (post?.type !== "oauth") return undefined;
          credential = post;
          if (Date.now() + requestedOAuthValidityMs >= credential.expires) {
            throw new ProviderModelsError(
              "oauth",
              `OAuth refresh for ${provider.id} did not provide the requested validity`,
            );
          }
        }
        try {
          return { auth: await provider.auth.oauth.toAuth(credential, ctx), source: "OAuth" };
        } catch (error) {
          throw new ProviderModelsError("oauth", `OAuth authentication failed for ${provider.id}`, { cause: error });
        }
      }
      if (stored.type === "api_key" && provider.auth.apiKey !== undefined) {
        const credential = overrides.env === undefined
          ? stored
          : { ...stored, env: { ...stored.env, ...overrides.env } };
        const credentialContext = credential.env === undefined
          ? ctx
          : overlayAuthContext(ctx, credential.env, overrides.signal);
        return await this.#resolveApiKey(provider, credentialContext, credential);
      }
      // Once a provider has saved credentials, do not substitute ambient credentials.
      return undefined;
    }
    return await this.#resolveApiKey(
      provider,
      ctx,
      overrides.env === undefined ? undefined : { type: "api_key", env: overrides.env },
    );
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
    if (
      overrides.minOAuthValidityMs !== undefined
      && (!Number.isSafeInteger(overrides.minOAuthValidityMs) || overrides.minOAuthValidityMs < 0)
    ) {
      throw new TypeError("minOAuthValidityMs must be a non-negative safe integer");
    }
    const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
    const provider = this.#providers.get(providerId);
    if (provider === undefined) return undefined;
    let result: ProviderAuthResult | undefined;
    try {
      result = await this.#resolveAuth(provider, overrides);
    } catch (error) {
      if (isProviderModelsError(error)) throw error;
      throw new ProviderModelsError("auth", `Authentication failed for ${providerId}`, { cause: error });
    }
    if (result === undefined) return result;
    try {
      const providerHeaders = mergeHeaders(provider.headers, result.auth.headers);
      if (typeof providerOrModel === "string") {
        return protectProviderAuthResult({
          ...result,
          auth: {
            ...result.auth,
            ...(providerHeaders === undefined ? {} : { headers: providerHeaders }),
          },
        });
      }
      return protectProviderAuthResult({
        ...result,
        auth: {
          ...result.auth,
          ...(() => {
            const headers = mergeHeaders(providerHeaders, providerOrModel.headers);
            return headers === undefined ? {} : { headers };
          })(),
        },
      });
    } catch (error) {
      throw new ProviderModelsError("auth", `Authentication failed for ${providerId}`, { cause: error });
    }
  }

  async login(
    providerId: string,
    type: "api_key" | "oauth" | "provider_account",
    interaction: ProviderAuthInteraction,
  ): Promise<ProviderCredential> {
    const provider = this.#providers.get(providerId);
    if (provider === undefined) throw new ProviderModelsError("provider", `Provider is not registered: ${providerId}`);
    const method = type === "oauth"
      ? provider.auth.oauth
      : type === "provider_account"
        ? provider.auth.providerAccount
        : provider.auth.apiKey;
    if (method?.login === undefined) {
      throw new ProviderModelsError("auth", `${provider.name} has no ${type} login flow`);
    }
    const credential = await method.login(interaction);
    interaction.signal?.throwIfAborted();
    try {
      await this.#credentials.modify(providerId, async () => {
        interaction.signal?.throwIfAborted();
        return credential;
      }, interaction.signal);
    } catch (error) {
      throw new ProviderModelsError("auth", `Unable to save credentials for ${providerId}`, { cause: error });
    }
    return credential;
  }

  async logout(providerId: string): Promise<void> {
    try {
      await this.#credentials.delete(providerId);
    } catch (error) {
      throw new ProviderModelsError("auth", `Unable to remove credentials for ${providerId}`, { cause: error });
    }
    try {
      await this.#modelsStore.delete(providerId);
    } catch (error) {
      throw new ProviderModelsError("model_source", `Unable to remove cached models for ${providerId}`, { cause: error });
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
    if (provider === undefined) return errorStream(`Provider is not registered: ${model.provider}`);
    return lazyProviderStream(async () => {
      const resolution = await this.getAuth(model, {
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (resolution === undefined) {
        throw new ProviderModelsError("auth", `No credentials are available for provider ${model.provider}`);
      }
      let headers = mergeHeaders(resolution.auth.headers, options.headers);
      if (options.transformHeaders !== undefined) headers = await options.transformHeaders(headers ?? {});
      const env = resolution.env !== undefined || options.env !== undefined
        ? { ...resolution.env, ...options.env }
        : undefined;
      const apiKey = options.apiKey ?? resolution.auth.apiKey;
      protectProviderAuth({ ...(apiKey === undefined ? {} : { apiKey }), ...(headers === undefined ? {} : { headers }) });
      protectProviderEnvironment(env);
      const requestModel = resolution.auth.baseUrl === undefined
        ? model
        : { ...model, baseUrl: resolution.auth.baseUrl };
      const requestOptions = {
        ...options,
        ...(apiKey === undefined
          ? {}
          : { apiKey }),
        ...(headers === undefined ? {} : { headers }),
        ...(env === undefined ? {} : { env }),
        ...(resolution.source === undefined ? {} : { authSource: resolution.source }),
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
  type Part = { text: string; bytes: number; signatureBytes: number };
  type ToolBlock = Extract<AssistantContentBlock, { type: "tool_call" }>;
  const projector = new ProviderStreamProjector(model.provider);
  const textParts = new Map<number, Part>();
  const reasoningParts = new Map<number, Part>();
  const reasoningVisibility = new Map<number, "summary" | "provider_trace">();
  const startedText = new Set<number>();
  const startedReasoning = new Set<number>();
  const completedText = new Set<number>();
  const completedReasoning = new Set<number>();
  const retainedTools = new Map<number, { bytes: number; raw: string }>();
  const toolBlocks = new Map<number, ToolBlock>();
  const completedTools = new Map<number, ProviderCompletionToolCall>();
  let usage: NormalizedUsage | undefined;
  let finishReason: ProviderCompletion["finishReason"] = "incomplete";
  let state: ProviderState | undefined;
  let responseId: string | undefined;
  let requestId: string | undefined;
  let error: ProviderCompletion["error"];
  let responseStarted = false;
  let bodySeen = false;
  let terminalSeen = false;
  let payloadBytes = 0;
  let terminalContent: AssistantContentBlock[] | undefined;

  const ensureBlock = (exists: boolean): void => {
    if (!exists && textParts.size + reasoningParts.size + retainedTools.size >= ASSISTANT_CONTENT_LIMITS.blocks) {
      throw new TypeError(`Provider assistant content exceeds ${ASSISTANT_CONTENT_LIMITS.blocks} streamed blocks`);
    }
  };
  const part = (parts: Map<number, Part>, index: number): Part => {
    const current = parts.get(index);
    if (current !== undefined) return current;
    ensureBlock(false);
    const created = { text: "", bytes: 0, signatureBytes: 0 };
    parts.set(index, created);
    return created;
  };
  const replaceBytes = (removed: number, added: number): number => {
    const next = payloadBytes - removed + added;
    if (next > ASSISTANT_CONTENT_LIMITS.contentBytes) {
      throw new TypeError(`Provider assistant content exceeds ${ASSISTANT_CONTENT_LIMITS.contentBytes} aggregate bytes`);
    }
    return next;
  };
  const observeVisibility = (index: number, value: "summary" | "provider_trace"): void => {
    const previous = reasoningVisibility.get(index);
    if (previous !== undefined && previous !== value) {
      throw new TypeError(`Provider changed reasoning visibility for part ${index}`);
    }
    reasoningVisibility.set(index, value);
  };

  for await (const event of stream) {
    if (terminalSeen) throw new TypeError("Provider emitted data after its terminal event");
    const projected = projector.project(event)?.event;
    if (projected === undefined) continue;
    if (projected.type === "response_start") {
      if (responseStarted || bodySeen) throw new TypeError("Provider emitted an invalid duplicate or late response_start");
      responseStarted = true;
    } else bodySeen = true;

    if (projected.type === "response_start") {
      responseId = projected.responseId;
      requestId = projected.requestId;
    } else if (projected.type === "text_start") {
      if (startedText.has(projected.part)) {
        throw new TypeError(`Provider emitted more than one text_start for part ${projected.part}`);
      }
      part(textParts, projected.part);
      startedText.add(projected.part);
    } else if (projected.type === "text_delta") {
      if (completedText.has(projected.part)) {
        throw new TypeError(`Provider emitted text_delta after text_end for part ${projected.part}`);
      }
      const current = part(textParts, projected.part);
      const deltaBytes = Buffer.byteLength(projected.delta, "utf8");
      if (current.bytes + deltaBytes > ASSISTANT_CONTENT_LIMITS.fieldBytes) {
        throw new TypeError(`Provider streamed text part ${projected.part} exceeds its byte limit`);
      }
      const nextPayloadBytes = replaceBytes(0, deltaBytes);
      current.text += projected.delta;
      current.bytes += deltaBytes;
      payloadBytes = nextPayloadBytes;
      startedText.add(projected.part);
    } else if (projected.type === "text_end") {
      if (completedText.has(projected.part)) {
        throw new TypeError(`Provider emitted more than one text_end for part ${projected.part}`);
      }
      const current = part(textParts, projected.part);
      if (!projected.content.startsWith(current.text)) {
        throw new TypeError("Provider final text did not match its streamed prefix");
      }
      const bytes = Buffer.byteLength(projected.content, "utf8");
      const signatureBytes = Buffer.byteLength(projected.contentSignature ?? "", "utf8");
      const nextPayloadBytes = replaceBytes(current.bytes + current.signatureBytes, bytes + signatureBytes);
      current.text = projected.content;
      current.bytes = bytes;
      current.signatureBytes = signatureBytes;
      payloadBytes = nextPayloadBytes;
      startedText.add(projected.part);
      completedText.add(projected.part);
    } else if (projected.type === "reasoning_start") {
      if (startedReasoning.has(projected.part)) {
        throw new TypeError(`Provider emitted more than one reasoning_start for part ${projected.part}`);
      }
      part(reasoningParts, projected.part);
      observeVisibility(projected.part, projected.visibility);
      startedReasoning.add(projected.part);
    } else if (projected.type === "reasoning_delta") {
      if (completedReasoning.has(projected.part)) {
        throw new TypeError(`Provider emitted reasoning_delta after reasoning_end for part ${projected.part}`);
      }
      const current = part(reasoningParts, projected.part);
      observeVisibility(projected.part, projected.visibility);
      const deltaBytes = Buffer.byteLength(projected.delta, "utf8");
      if (current.bytes + deltaBytes > ASSISTANT_CONTENT_LIMITS.fieldBytes) {
        throw new TypeError(`Provider streamed reasoning part ${projected.part} exceeds its byte limit`);
      }
      const nextPayloadBytes = replaceBytes(0, deltaBytes);
      current.text += projected.delta;
      current.bytes += deltaBytes;
      payloadBytes = nextPayloadBytes;
      startedReasoning.add(projected.part);
    } else if (projected.type === "reasoning_end") {
      if (completedReasoning.has(projected.part)) {
        throw new TypeError(`Provider emitted more than one reasoning_end for part ${projected.part}`);
      }
      const current = part(reasoningParts, projected.part);
      observeVisibility(projected.part, projected.visibility);
      if (!projected.content.startsWith(current.text)) {
        throw new TypeError("Provider final reasoning did not match its streamed prefix");
      }
      const bytes = Buffer.byteLength(projected.content, "utf8");
      const signatureBytes = Buffer.byteLength(projected.contentSignature ?? "", "utf8");
      const nextPayloadBytes = replaceBytes(current.bytes + current.signatureBytes, bytes + signatureBytes);
      current.text = projected.content;
      current.bytes = bytes;
      current.signatureBytes = signatureBytes;
      payloadBytes = nextPayloadBytes;
      startedReasoning.add(projected.part);
      completedReasoning.add(projected.part);
    } else if (projected.type === "tool_call_start" || projected.type === "tool_call_delta") {
      const index = projected.index;
      const previous = retainedTools.get(index);
      ensureBlock(previous !== undefined);
      const deltaBytes = projected.type === "tool_call_delta" ? Buffer.byteLength(projected.delta, "utf8") : 0;
      const retained = (previous?.bytes ?? 0) + deltaBytes +
        (projected.type === "tool_call_start"
          ? Buffer.byteLength(projected.partial.id ?? "", "utf8") + Buffer.byteLength(projected.partial.name ?? "", "utf8")
          : 0);
      const nextPayloadBytes = replaceBytes(previous?.bytes ?? 0, retained);
      retainedTools.set(index, { bytes: retained, raw: projected.partial.rawArguments });
      payloadBytes = nextPayloadBytes;
    } else if (projected.type === "tool_call_end") {
      const call = projected.toolCall;
      if (call.name === undefined) throw new TypeError("Provider omitted a completed tool-call name");
      const previous = retainedTools.get(call.index);
      ensureBlock(previous !== undefined);
      const source = event as Extract<AdapterEvent, { type: "tool_call_end" }>;
      const suppliedArguments = source.arguments !== undefined
        ? call.arguments
        : undefined;
      const block: ToolBlock = {
        type: "tool_call",
        callId: call.id ?? `direct-call-${call.index}`,
        name: call.name,
        arguments: suppliedArguments ?? null,
        rawArguments: call.rawArguments,
        ...(call.thoughtSignature === undefined ? {} : { thoughtSignature: call.thoughtSignature }),
      };
      validatedAssistantContent([...toolBlocks.values(), block]);
      const retained = Buffer.byteLength(call.id ?? "", "utf8") + Buffer.byteLength(call.name, "utf8") +
        Buffer.byteLength(call.rawArguments, "utf8") + Buffer.byteLength(call.parseError ?? "", "utf8") +
        Buffer.byteLength(call.thoughtSignature ?? "", "utf8") + Buffer.byteLength(JSON.stringify(block.arguments), "utf8");
      const nextPayloadBytes = replaceBytes(previous?.bytes ?? 0, retained);
      toolBlocks.set(call.index, block);
      retainedTools.set(call.index, { bytes: retained, raw: call.rawArguments });
      completedTools.set(call.index, {
        index: call.index,
        ...(call.id === undefined ? {} : { id: call.id }),
        name: call.name,
        ...(suppliedArguments === undefined ? {} : { arguments: suppliedArguments }),
        rawArguments: call.rawArguments,
        ...(call.parseError === undefined ? {} : { parseError: call.parseError }),
      });
      payloadBytes = nextPayloadBytes;
    } else if (projected.type === "usage") {
      usage = projected.semantics === "incremental"
        ? addNormalizedUsage(usage, projected.usage)
        : structuredClone(projected.usage);
      if (!isNormalizedUsage(usage)) throw new TypeError("Provider emitted usage whose aggregate is invalid");
    } else if (projected.type === "response_end") {
      if ([...retainedTools.keys()].some((index) => !completedTools.has(index))) {
        throw new TypeError("Provider emitted response_end before tool_call_end");
      }
      const source = event as Extract<AdapterEvent, { type: "response_end" }>;
      const selectedState = validateProviderState(source.state);
      if (selectedState.api !== model.api) {
        throw new TypeError("Provider continuation state protocol does not match the model API");
      }
      const ownedState = validateProviderState({
        ...selectedState.state,
        source: { provider: model.provider, model: model.id, api: selectedState.api },
      }).state;
      const content = projected.content;
      if (content !== undefined) {
        if (content.filter((block) => block.type === "tool_call").length > 256) {
          throw new TypeError("Provider returned more than 256 terminal tool calls");
        }
        for (const [index, current] of textParts) {
          const block = content[index];
          if (block?.type !== "text" || !block.text.startsWith(current.text)) {
            throw new TypeError("Provider terminal content omitted or replaced streamed text");
          }
        }
        for (const [index, current] of reasoningParts) {
          const block = content[index];
          if (block?.type !== "thinking" || !block.thinking.startsWith(current.text)) {
            throw new TypeError("Provider terminal content omitted or replaced streamed reasoning");
          }
          observeVisibility(index, block.visibility ?? "provider_trace");
        }
        for (const [index, retained] of retainedTools) {
          const block = content[index];
          const raw = block?.type === "tool_call"
            ? block.rawArguments ?? JSON.stringify(block.arguments)
            : undefined;
          const completed = completedTools.get(index);
          if (
            block?.type !== "tool_call" || raw === undefined || !raw.startsWith(retained.raw) ||
            (completed !== undefined && (
              block.name !== completed.name ||
              (completed.id !== undefined && block.callId !== completed.id)
            ))
          ) throw new TypeError("Provider terminal content omitted or replaced a streamed tool call");
        }
      }
      finishReason = projected.reason;
      state = ownedState;
      terminalContent = content;
      terminalSeen = true;
    } else if (projected.type === "error") {
      finishReason = projected.error.category === "cancelled" ? "cancelled" : "error";
      error = projected.error;
      terminalSeen = true;
    }
  }
  if (!terminalSeen) throw new TypeError("Provider stream ended without a terminal event");
  const streamedContent: AssistantContentBlock[] = [
    ...[...reasoningParts].map(([index, current]) => ({ index, order: 0, block: {
      type: "thinking" as const,
      thinking: current.text,
      visibility: reasoningVisibility.get(index) ?? "provider_trace" as const,
    } })),
    ...[...textParts].map(([index, current]) => ({
      index,
      order: 1,
      block: { type: "text" as const, text: current.text },
    })),
  ].sort((left, right) => left.index - right.index || left.order - right.order).map(({ block }) => block);
  if (terminalContent === undefined) validatedAssistantContent([...streamedContent, ...toolBlocks.values()]);
  const selectedContent = terminalContent ?? streamedContent;
  const terminalTools = terminalContent?.flatMap((block, index): ProviderCompletionToolCall[] => block.type !== "tool_call"
    ? []
    : [{
        index,
        id: block.callId,
        name: block.name,
        arguments: block.arguments,
        rawArguments: block.rawArguments ?? JSON.stringify(block.arguments),
      }]) ?? [];
  const toolCalls = terminalContent === undefined
    ? [...completedTools].sort(([left], [right]) => left - right).map(([, call]) => call)
    : terminalTools;
  const text = selectedContent.filter((block) => block.type === "text").map((block) => block.text).join("");
  const reasoning = selectedContent.filter((block) => block.type === "thinking").map((block) => block.thinking).join("");
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
    yield* errorStream(errorMessage(error));
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
  let activeRefresh: { controller: AbortController; generation: number; promise: Promise<void> } | undefined;
  let refreshGeneration = 0;
  let refreshCommitTail = Promise.resolve();
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
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      ...(options.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: options.maxRetryDelayMs }),
      ...(
        model.name === model.id && model.thinkingLevelMap === undefined && model.compat === undefined
          ? {}
          : {
              modelSettings: {
                ...(model.name === model.id ? {} : { displayName: model.name }),
                ...(model.thinkingLevelMap === undefined
                  ? {}
                  : { reasoningEffortMap: structuredClone(model.thinkingLevelMap) }),
                ...(model.compat === undefined ? {} : { compatibility: structuredClone(model.compat) }),
              },
            }
      ),
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
            if (activeRefresh !== undefined && context.force !== true) return activeRefresh.promise;
            activeRefresh?.controller.abort(new Error("Provider model refresh superseded"));
            const controller = new AbortController();
            const generation = ++refreshGeneration;
            const signal = context.signal === undefined
              ? controller.signal
              : AbortSignal.any([context.signal, controller.signal]);
            const request = { ...context, signal };
            const operation = (async () => {
              try {
                const stored = await request.store.read();
                const cached = stored?.models.filter((model) => model.provider === input.id) as
                  | ProviderModel<TApi>[]
                  | undefined;
                if (generation === refreshGeneration && !signal.aborted) dynamic = cached ?? [];
                if (!request.allowNetwork || signal.aborted) return;
                const refreshed = await input.fetchModels!(request);
                if (signal.aborted) return;
                const commit = refreshCommitTail.then(async () => {
                  if (generation !== refreshGeneration || signal.aborted) return;
                  dynamic = [...refreshed];
                  await request.store.write({ models: refreshed, checkedAt: Date.now() });
                });
                refreshCommitTail = commit.catch(() => undefined);
                await commit;
              } finally {
                if (activeRefresh?.generation === generation) activeRefresh = undefined;
              }
            })();
            activeRefresh = { controller, generation, promise: operation };
            return operation;
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
  if (input.fetchModels !== undefined) supersedingRefreshProviders.add(provider);
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
  const supported: ProviderModelThinkingLevel[] = [];
  for (const level of PROVIDER_THINKING_LEVELS) {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) continue;
    if ((level === "xhigh" || level === "max") && mapped === undefined) continue;
    supported.push(level);
  }
  return supported;
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

export function modelCacheReadPrice(model: ProviderModel, promptTokens: number): number {
  let price = model.cost.cacheRead;
  let matchedThreshold = -1;
  for (const tier of model.cost.tiers ?? []) {
    if (promptTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      price = tier.cacheRead;
      matchedThreshold = tier.inputTokensAbove;
    }
  }
  return price;
}

export function calculateCost(model: ProviderModel, usage: NormalizedUsage): NormalizedUsage["cost"] {
  if (
    usage.inputTokens === undefined || usage.outputTokens === undefined ||
    usage.cacheReadTokens === undefined || usage.cacheWriteTokens === undefined
  ) return undefined;
  if ([usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
    .some((value) => !Number.isSafeInteger(value) || value < 0)) return undefined;
  const inputTokens = usage.inputTokens;
  const cacheReadTokens = usage.cacheReadTokens;
  const cacheWriteTokens = usage.cacheWriteTokens;
  let rates: ProviderModelCost = model.cost;
  let matchedThreshold = -1;
  const inputVolume = inputTokens + cacheReadTokens + cacheWriteTokens;
  if (!Number.isSafeInteger(inputVolume)) return undefined;
  for (const tier of model.cost.tiers ?? []) {
    if (inputVolume > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      rates = tier;
      matchedThreshold = tier.inputTokensAbove;
    }
  }
  const input = (rates.input / 1_000_000) * inputTokens;
  const output = (rates.output / 1_000_000) * usage.outputTokens;
  const cacheRead = (rates.cacheRead / 1_000_000) * cacheReadTokens;
  const longWriteTokens = usage.cacheWrite1hTokens ?? 0;
  const shortWriteTokens = cacheWriteTokens - longWriteTokens;
  const cacheWrite = ((rates.cacheWrite * shortWriteTokens) + (rates.input * 2 * longWriteTokens)) / 1_000_000;
  return canonicalUsageCost({ input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite });
}
