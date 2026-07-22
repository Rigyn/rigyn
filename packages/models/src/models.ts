import { lazyStream } from "./api/lazy.js";
import { defaultProviderAuthContext } from "./auth/context.js";
import { InMemoryCredentialStore } from "./auth/credential-store.js";
import { ModelsError, resolveProviderAuth, type AuthResolutionOverrides, type ModelsErrorCode } from "./auth/resolve.js";
import type { AuthCheck, AuthContext, AuthInteraction, AuthResult, AuthType, Credential, CredentialStore, ProviderAuth } from "./auth/types.js";
import { InMemoryModelsStore, type ModelsStore, type ProviderModelsStore } from "./models-store.js";
import type { Api, ApiStreamOptions, AssistantMessage, AssistantMessageEventStream, Context, Model, ModelCostRates, ModelThinkingLevel, ModelsApiStreamOptions, ModelsSimpleStreamOptions, ModelsStreamTransforms, ProviderHeaders, ProviderStreams, SimpleStreamOptions, StreamOptions, Usage } from "./types.js";

export { ModelsError, type ModelsErrorCode };
export type { ModelsApiStreamOptions, ModelsSimpleStreamOptions, ModelsStreamTransforms };
export interface RefreshModelsContext { credential?: Credential; store: ProviderModelsStore; allowNetwork: boolean; force?: boolean; signal?: AbortSignal; }
export interface ModelsRefreshOptions { allowNetwork?: boolean; force?: boolean; signal?: AbortSignal; }
export interface ModelsRefreshResult { aborted: boolean; errors: ReadonlyMap<string, Error>; }
export interface Provider<TApi extends Api = Api> {
  readonly id: string; readonly name: string; readonly baseUrl?: string; readonly headers?: ProviderHeaders; readonly auth: ProviderAuth;
  getModels(): readonly Model<TApi>[];
  refreshModels?(context: RefreshModelsContext): Promise<void>;
  filterModels?(models: readonly Model<TApi>[], credential: Credential | undefined): readonly Model<TApi>[];
  stream<T extends TApi>(model: Model<T>, context: Context, options?: ApiStreamOptions<T>): AssistantMessageEventStream;
  streamSimple(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}
export interface Models {
  getProviders(): readonly Provider[]; getProvider(id: string): Provider | undefined;
  getModels(provider?: string): readonly Model<Api>[]; getModel(provider: string, id: string): Model<Api> | undefined;
  refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
  checkAuth(providerId: string): Promise<AuthCheck | undefined>;
  getAvailable(providerId?: string): Promise<readonly Model<Api>[]>;
  getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
  getAuth(model: Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
  login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;
  logout(providerId: string): Promise<void>;
  stream<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): AssistantMessageEventStream;
  complete<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): Promise<AssistantMessage>;
  streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
  completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage>;
}
export interface MutableModels extends Models { setProvider(provider: Provider): void; deleteProvider(id: string): void; clearProviders(): void; }
export interface CreateModelsOptions { credentials?: CredentialStore; modelsStore?: ModelsStore; authContext?: AuthContext; }

function mergeHeaders(base?: ProviderHeaders, override?: ProviderHeaders): ProviderHeaders | undefined {
  if (!base && !override) return undefined;
  const result = { ...base };
  for (const [name, value] of Object.entries(override ?? {})) {
    for (const existing of Object.keys(result)) if (existing.toLowerCase() === name.toLowerCase()) delete result[existing];
    result[name] = value;
  }
  return result;
}
class ModelsCollection implements MutableModels {
  readonly #providers = new Map<string, Provider>();
  readonly #credentials: CredentialStore;
  readonly #modelsStore: ModelsStore;
  readonly #authContext: AuthContext;
  constructor(options: CreateModelsOptions = {}) { this.#credentials = options.credentials ?? new InMemoryCredentialStore(); this.#modelsStore = options.modelsStore ?? new InMemoryModelsStore(); this.#authContext = options.authContext ?? defaultProviderAuthContext(); }
  setProvider(provider: Provider): void { this.#providers.set(provider.id, provider); }
  deleteProvider(id: string): void { this.#providers.delete(id); }
  clearProviders(): void { this.#providers.clear(); }
  getProviders(): readonly Provider[] { return [...this.#providers.values()]; }
  getProvider(id: string): Provider | undefined { return this.#providers.get(id); }
  getModels(provider?: string): readonly Model<Api>[] {
    const selected = provider === undefined ? this.#providers.values() : [this.#providers.get(provider)].filter((entry): entry is Provider => entry !== undefined);
    const output: Model<Api>[] = [];
    for (const entry of selected) try { output.push(...entry.getModels()); } catch { /* a provider catalog is best effort */ }
    return output;
  }
  getModel(provider: string, id: string): Model<Api> | undefined { return this.getModels(provider).find((model) => model.id === id); }
  async #credential(id: string): Promise<Credential | undefined> { try { return await this.#credentials.read(id); } catch (cause) { throw new ModelsError("auth", `Credential store read failed for ${id}`, { cause }); } }
  async #refreshCredential(provider: Provider, stored: Credential | undefined, allowNetwork: boolean, signal?: AbortSignal): Promise<Credential | undefined> {
    if (stored?.type === "oauth") {
      if (!provider.auth.oauth) return undefined;
      if (!allowNetwork || Date.now() < stored.expires || signal?.aborted) return stored;
      const post = await this.#credentials.modify(provider.id, async (current) => current?.type === "oauth" && Date.now() >= current.expires ? provider.auth.oauth!.refresh(current, signal) : undefined);
      return post?.type === "oauth" ? post : undefined;
    }
    if (!provider.auth.apiKey) return undefined;
    const resolved = await provider.auth.apiKey.resolve({ ctx: this.#authContext, ...(stored?.type === "api_key" ? { credential: stored } : {}) });
    return resolved ? { type: "api_key", ...(resolved.auth.apiKey ? { key: resolved.auth.apiKey } : {}), ...(resolved.env ? { env: resolved.env } : {}) } : undefined;
  }
  async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
    const errors = new Map<string, Error>();
    const allowNetwork = options.allowNetwork ?? true;
    const providers = [...this.#providers.values()].filter((provider) => provider.refreshModels);
    await Promise.all(providers.map(async (provider) => {
      if (options.signal?.aborted) return;
      const store: ProviderModelsStore = { read: () => this.#modelsStore.read(provider.id), write: (entry) => this.#modelsStore.write(provider.id, entry), delete: () => this.#modelsStore.delete(provider.id) };
      let stored: Credential | undefined;
      try {
        stored = await this.#credential(provider.id);
        const credential = await this.#refreshCredential(provider, stored, allowNetwork, options.signal);
        if (!credential) return;
        await provider.refreshModels!({ credential, store, allowNetwork, ...(options.force === undefined ? {} : { force: options.force }), ...(options.signal ? { signal: options.signal } : {}) });
      } catch (error) {
        if (!options.signal?.aborted) errors.set(provider.id, error instanceof Error ? error : new ModelsError("model_source", `Model refresh failed for ${provider.id}`, { cause: error }));
        try { await provider.refreshModels!({ ...(stored ? { credential: stored } : {}), store, allowNetwork: false, ...(options.signal ? { signal: options.signal } : {}) }); } catch { /* cache restoration cannot hide the original error */ }
      }
    }));
    return { aborted: options.signal?.aborted ?? false, errors };
  }
  async #check(provider: Provider, credential: Credential | undefined): Promise<AuthCheck | undefined> {
    if (credential?.type === "oauth") return provider.auth.oauth ? { source: "OAuth", type: "oauth" } : undefined;
    const method = provider.auth.apiKey;
    if (!method) return undefined;
    if (method.check) try { return await method.check({ ctx: this.#authContext, ...(credential?.type === "api_key" ? { credential } : {}) }); } catch (cause) { throw new ModelsError("auth", `API key auth check failed for provider ${provider.id}`, { cause }); }
    const resolution = await resolveProviderAuth(provider, this.#credentials, this.#authContext);
    return resolution
      ? { type: "api_key", ...(resolution.source === undefined ? {} : { source: resolution.source }) }
      : undefined;
  }
  async checkAuth(providerId: string): Promise<AuthCheck | undefined> { const provider = this.#providers.get(providerId); return provider ? this.#check(provider, await this.#credential(providerId)) : undefined; }
  async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
    const providers = providerId ? [this.#providers.get(providerId)].filter((entry): entry is Provider => entry !== undefined) : this.getProviders();
    const states = await Promise.all(providers.map(async (provider) => { const credential = await this.#credential(provider.id); return { provider, credential, auth: await this.#check(provider, credential) }; }));
    return states.flatMap(({ provider, credential, auth }) => auth ? [...(provider.filterModels?.(provider.getModels(), credential) ?? provider.getModels())] : []);
  }
  getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
  getAuth(model: Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
  async getAuth(providerOrModel: string | Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined> {
    const id = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
    const provider = this.#providers.get(id); if (!provider) return undefined;
    const result = await resolveProviderAuth(provider, this.#credentials, this.#authContext, overrides);
    if (!result || typeof providerOrModel === "string" || !providerOrModel.headers) return result;
    const headers = mergeHeaders(result.auth.headers, providerOrModel.headers);
    return { ...result, auth: { ...result.auth, ...(headers === undefined ? {} : { headers }) } };
  }
  async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
    const provider = this.#providers.get(providerId); if (!provider) throw new ModelsError("provider", `Unknown provider: ${providerId}`);
    const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
    if (!method?.login) throw new ModelsError("auth", `${provider.name} does not support ${type} login`);
    const credential = await method.login(interaction);
    try { await this.#credentials.modify(providerId, async () => credential); } catch (cause) { throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause }); }
    return credential;
  }
  async logout(providerId: string): Promise<void> { try { await this.#credentials.delete(providerId); } catch (cause) { throw new ModelsError("auth", `Credential store delete failed for ${providerId}`, { cause }); } }
  #provider(model: Model<Api>): Provider { const provider = this.#providers.get(model.provider); if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`); return provider; }
  async #requestOptions(model: Model<Api>, options?: StreamOptions & ModelsStreamTransforms): Promise<{ model: Model<Api>; options: StreamOptions }> {
    this.#provider(model);
    const resolution = await this.getAuth(model, { ...(options?.apiKey === undefined ? {} : { apiKey: options.apiKey }), ...(options?.env === undefined ? {} : { env: options.env }) });
    if (!resolution) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
    let headers = mergeHeaders(resolution.auth.headers, options?.headers);
    if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
    const { transformHeaders: _ignored, ...rest } = options ?? {};
    const apiKey = options?.apiKey ?? resolution.auth.apiKey;
    return {
      model: resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model,
      options: { ...rest, ...(apiKey === undefined ? {} : { apiKey }), ...(headers ? { headers } : {}), ...(resolution.env || options?.env ? { env: { ...(resolution.env ?? {}), ...(options?.env ?? {}) } } : {}) },
    };
  }
  stream<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): AssistantMessageEventStream {
    return lazyStream(model, async () => { const request = await this.#requestOptions(model, options); return this.#provider(model).stream(request.model, context, request.options); });
  }
  complete<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): Promise<AssistantMessage> { return this.stream(model, context, options).result(); }
  streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream { return lazyStream(model, async () => { const request = await this.#requestOptions(model, options); return this.#provider(model).streamSimple(request.model, context, request.options); }); }
  completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> { return this.streamSimple(model, context, options).result(); }
}
export function createModels(options?: CreateModelsOptions): MutableModels { return new ModelsCollection(options); }

export interface CreateProviderOptions<TApi extends Api = Api> {
  id: string; name?: string; baseUrl?: string; headers?: ProviderHeaders; auth: ProviderAuth;
  models: readonly Model<TApi>[]; fetchModels?: (context: RefreshModelsContext) => Promise<readonly Model<TApi>[]>;
  filterModels?: (models: readonly Model<TApi>[], credential: Credential | undefined) => readonly Model<TApi>[];
  api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;
}
export function createProvider<TApi extends Api = Api>(input: CreateProviderOptions<TApi>): Provider<TApi> {
  const baseline = [...input.models]; let dynamic: readonly Model<TApi>[] = []; let inflight: Promise<void> | undefined;
  const list = () => { const output = [...baseline]; for (const model of dynamic) { const index = output.findIndex((entry) => entry.id === model.id); if (index < 0) output.push(model); else output[index] = model; } return output; };
  const single = typeof (input.api as ProviderStreams).stream === "function" ? input.api as ProviderStreams : undefined;
  const select = (model: Model<Api>) => single ?? (input.api as Partial<Record<string, ProviderStreams>>)[model.api];
  const dispatch = (model: Model<Api>, execute: (streams: ProviderStreams) => AssistantMessageEventStream) => { const streams = select(model); return streams ? execute(streams) : lazyStream(model, async () => { throw new ModelsError("stream", `Provider ${input.id} has no API implementation for "${model.api}"`); }); };
  return {
    id: input.id, name: input.name ?? input.id, ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}), ...(input.headers ? { headers: input.headers } : {}), auth: input.auth,
    getModels: list,
    ...(input.fetchModels ? { refreshModels: (context: RefreshModelsContext) => {
      inflight ??= (async () => { try { const stored = await context.store.read(); if (stored) dynamic = stored.models.filter((model) => model.provider === input.id) as Model<TApi>[]; if (!context.allowNetwork || context.signal?.aborted) return; const fetched = await input.fetchModels!(context); if (context.signal?.aborted) return; dynamic = fetched; await context.store.write({ models: fetched, checkedAt: Date.now() }); } finally { inflight = undefined; } })();
      return inflight;
    } } : {}),
    ...(input.filterModels ? { filterModels: input.filterModels } : {}),
    stream: (model, context, options) => dispatch(model, (streams) => streams.stream(model, context, options)),
    streamSimple: (model, context, options) => dispatch(model, (streams) => streams.streamSimple(model, context, options)),
  };
}
export function hasApi<TApi extends Api>(model: Model<Api>, api: TApi): model is Model<TApi> { return model.api === api; }
export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
  const billableInput = usage.input + usage.cacheRead + usage.cacheWrite; let rates: ModelCostRates = model.cost; let threshold = -1;
  for (const tier of model.cost.tiers ?? []) if (billableInput > tier.inputTokensAbove && tier.inputTokensAbove > threshold) { rates = tier; threshold = tier.inputTokensAbove; }
  const longWrite = usage.cacheWrite1h ?? 0; const shortWrite = usage.cacheWrite - longWrite;
  usage.cost.input = rates.input * usage.input / 1_000_000; usage.cost.output = rates.output * usage.output / 1_000_000;
  usage.cost.cacheRead = rates.cacheRead * usage.cacheRead / 1_000_000; usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1_000_000;
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite; return usage.cost;
}
const LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] { return model.reasoning ? LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null && ((level !== "xhigh" && level !== "max") || model.thinkingLevelMap?.[level] !== undefined)) : ["off"]; }
export function clampThinkingLevel<TApi extends Api>(model: Model<TApi>, level: ModelThinkingLevel): ModelThinkingLevel {
  const supported = getSupportedThinkingLevels(model);
  if (supported.includes(level)) return level;
  const index = LEVELS.indexOf(level);
  for (let cursor = index + 1; cursor < LEVELS.length; cursor += 1) {
    const candidate = LEVELS[cursor];
    if (candidate !== undefined && supported.includes(candidate)) return candidate;
  }
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = LEVELS[cursor];
    if (candidate !== undefined && supported.includes(candidate)) return candidate;
  }
  return "off";
}
export function modelsAreEqual<TApi extends Api>(left: Model<TApi> | null | undefined, right: Model<TApi> | null | undefined): boolean { return !!left && !!right && left.id === right.id && left.provider === right.provider; }
