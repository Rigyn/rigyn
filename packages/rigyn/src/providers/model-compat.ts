import { dirname, join } from "node:path";

import {
  lazyStream,
  type Api,
  type ApiStreamOptions,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type AuthCheck,
  type AuthInteraction,
  type AuthResult,
  type AuthType,
  type Context,
  type Credential,
  type CredentialInfo,
  type CredentialStore as PublicCredentialStore,
  type Model,
  type Models,
  type ModelsApiStreamOptions,
  type ModelsRefreshOptions,
  type ModelsRefreshResult,
  type ModelsSimpleStreamOptions,
  type ModelsStreamTransforms,
  type Provider,
  type ProviderHeaders,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@rigyn/models";

import { AuthStorage } from "../auth/auth-storage.js";
import { defaultSecretRedactor } from "../auth/redaction.js";
import {
  assertCredentialId,
  isMutableCredentialStore,
  type CredentialStore as HostCredentialStore,
} from "../auth/types.js";
import { getAgentDir, getAuthPath } from "../config/paths.js";
import {
  extensionModelRegistry,
  type ExtensionProviderConfig,
  type ExtensionProviderModelConfig,
} from "../extensions/model-boundary.js";
import { ProviderCredentialStoreAdapter } from "./auth-store-adapter.js";
import { builtinModels } from "./all.js";
import { ModelRegistry } from "./model-registry.js";
import {
  loadRuntimeModelConfiguration,
  type RuntimeModelDefinition,
  type RuntimeProviderDefinition,
} from "./model-runtime-config.js";
import { resolveModelsForScope } from "./model-scope.js";
import type {
  MutableModels,
  ProviderAuthInteraction,
  ProviderCredential,
  ProviderCredentialInfo,
  ProviderCredentialStore,
  ProviderModel,
  ProviderRefreshResult,
} from "./models.js";
import { FileProviderModelsStore, type ProviderModelsStore } from "./models-store.js";
import { withRemoteCatalog } from "./remote-catalog.js";
import { MODEL_REASONING_EFFORTS, type ModelReasoningEffort } from "./registry.js";
import {
  installModelRuntimeFactory,
  registerModelRuntime,
} from "./model-runtime-ownership.js";

export interface CreateModelRuntimeOptions {
  /** Preconstructed model collection. When supplied, the remaining storage options are ignored. */
  models?: MutableModels;
  /** rigyn credential storage. Defaults to an in-memory store unless authPath is supplied. */
  credentials?: PublicCredentialStore | HostCredentialStore;
  authPath?: string;
  /**
   * Optional provider/model configuration file. Defaults to
   * `<agentDir>/model-providers.json`; null disables file loading.
   */
  modelsPath?: string | null;
  modelsStore?: ProviderModelsStore;
  modelsStorePath?: string;
  /** Allow create-time provider catalog refreshes. Default: false. */
  allowModelNetwork?: boolean;
  /** Timeout for the create-time network model refresh. */
  modelRefreshTimeoutMs?: number;
  /** Optional base URL used by provider implementations with remote catalogs. */
  catalogBaseUrl?: string;
}

export interface ModelRuntimeAuthOverrides {
  apiKey?: string;
  env?: Record<string, string>;
}

/** Non-persistent API-key overlay used only by one ModelRuntime instance. */
class RuntimeCredentialStore implements ProviderCredentialStore {
  readonly #store: ProviderCredentialStore;
  readonly #apiKeys = new Map<string, string>();

  constructor(store: ProviderCredentialStore) {
    this.#store = store;
  }

  setApiKey(provider: string, apiKey: string): void {
    assertCredentialId(provider);
    if (apiKey.trim() === "" || apiKey.includes("\0") || Buffer.byteLength(apiKey, "utf8") > 64 * 1024) {
      throw new TypeError("Runtime API key must be a non-empty value no larger than 64 KiB");
    }
    defaultSecretRedactor.register(apiKey);
    this.#apiKeys.set(provider, apiKey);
  }

  removeApiKey(provider: string): void {
    assertCredentialId(provider);
    this.#apiKeys.delete(provider);
  }

  hasRuntimeApiKey(provider: string): boolean {
    return this.#apiKeys.has(provider);
  }

  async read(provider: string): Promise<ProviderCredential | undefined> {
    const apiKey = this.#apiKeys.get(provider);
    return apiKey === undefined ? await this.#store.read(provider) : { type: "api_key", key: apiKey };
  }

  async list(): Promise<readonly ProviderCredentialInfo[]> {
    const entries = new Map((await this.#store.list()).map((entry) => [entry.providerId, entry]));
    for (const providerId of this.#apiKeys.keys()) entries.set(providerId, { providerId, type: "api_key" });
    return [...entries.values()];
  }

  modify(
    provider: string,
    operation: (current: ProviderCredential | undefined) => Promise<ProviderCredential | undefined>,
  ): Promise<ProviderCredential | undefined> {
    return this.#store.modify(provider, operation);
  }

  async delete(provider: string): Promise<void> {
    this.#apiKeys.delete(provider);
    await this.#store.delete(provider);
  }

}

function providerCredentials(store: PublicCredentialStore | HostCredentialStore): ProviderCredentialStore {
  const candidate = store as Partial<HostCredentialStore> & { list?: unknown; modify?: unknown };
  const isHostStore = isMutableCredentialStore(store as HostCredentialStore)
    && typeof candidate.write === "function"
    && typeof candidate.withLock === "function";
  return isHostStore
    ? new ProviderCredentialStoreAdapter(store as HostCredentialStore)
    : store as PublicCredentialStore;
}

function mergedCompatibility(
  base: Model<Api>["compat"],
  override: Model<Api>["compat"],
): Model<Api>["compat"] {
  if (override === undefined) return base;
  if (base === undefined) return structuredClone(override);
  return { ...base, ...override } as Model<Api>["compat"];
}

function configuredModel(
  provider: string,
  definition: RuntimeModelDefinition,
  providerDefinition: RuntimeProviderDefinition,
  fallback: Model<Api> | undefined,
): Model<Api> {
  const api = definition.api ?? providerDefinition.api ?? fallback?.api;
  if (api === undefined) throw new Error(`Provider ${provider}, model ${definition.id}: API is required`);
  const baseUrl = definition.baseUrl ?? providerDefinition.baseUrl ?? fallback?.baseUrl;
  if (baseUrl === undefined) throw new Error(`Provider ${provider}, model ${definition.id}: base URL is required`);
  return {
    id: definition.id,
    name: definition.name ?? fallback?.name ?? definition.id,
    api,
    provider,
    baseUrl,
    reasoning: definition.reasoning ?? fallback?.reasoning ?? false,
    ...(() => {
      const map = definition.thinkingLevelMap ?? fallback?.thinkingLevelMap;
      return map === undefined ? {} : { thinkingLevelMap: { ...map } };
    })(),
    input: [...(definition.input ?? fallback?.input ?? ["text"])],
    cost: {
      ...(fallback?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      ...definition.cost,
    },
    contextWindow: definition.contextWindow ?? fallback?.contextWindow ?? 128_000,
    maxTokens: definition.maxTokens ?? fallback?.maxTokens ?? 16_384,
    ...(() => {
      const selected = definition.headers ?? fallback?.headers;
      return selected === undefined ? {} : { headers: { ...selected } };
    })(),
    ...(() => {
      const compat = mergedCompatibility(
        mergedCompatibility(fallback?.compat, providerDefinition.compat),
        definition.compat,
      );
      return compat === undefined ? {} : { compat };
    })(),
  };
}

function providerConfiguration(
  runtime: ModelRegistry,
  provider: string,
  definition: RuntimeProviderDefinition,
): ExtensionProviderConfig {
  const publicModels = extensionModelRegistry(runtime);
  const existing = publicModels.getAll().filter((model) => model.provider === provider);
  let models: Model<Api>[] | undefined;
  if ((definition.models?.length ?? 0) > 0 || definition.compat !== undefined) {
    models = existing.map((model) => ({
      ...model,
      ...(definition.baseUrl === undefined ? {} : { baseUrl: definition.baseUrl }),
      ...(() => {
        const compat = mergedCompatibility(model.compat, definition.compat);
        return compat === undefined ? {} : { compat };
      })(),
    }));
    for (const entry of definition.models ?? []) {
      const index = models.findIndex((model) => model.id === entry.id);
      const fallback = index < 0 ? existing[0] : models[index];
      const selected = configuredModel(provider, entry, definition, fallback);
      if (index < 0) models.push(selected);
      else models[index] = selected;
    }
  }
  const configuredModels: ExtensionProviderModelConfig[] | undefined = models?.map((model) => ({
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.headers === undefined ? {} : { headers: { ...model.headers } }),
    ...(model.compat === undefined ? {} : { compat: model.compat }),
  }));
  return {
    ...(definition.name === undefined ? {} : { name: definition.name }),
    ...(definition.baseUrl === undefined ? {} : { baseUrl: definition.baseUrl }),
    ...(definition.apiKey === undefined ? {} : { apiKey: definition.apiKey }),
    ...(definition.api === undefined ? {} : { api: definition.api }),
    ...(definition.headers === undefined ? {} : { headers: { ...definition.headers } }),
    ...(definition.authHeader === undefined ? {} : { authHeader: definition.authHeader }),
    ...(configuredModels === undefined ? {} : { models: configuredModels }),
  };
}

function mergeHeaders(
  base: ProviderHeaders | undefined,
  override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
  if (base === undefined && override === undefined) return undefined;
  const result: ProviderHeaders = { ...base };
  for (const [name, value] of Object.entries(override ?? {})) {
    for (const existing of Object.keys(result)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete result[existing];
    }
    result[name] = value;
  }
  return result;
}

function publicRefreshResult(result: ProviderRefreshResult): ModelsRefreshResult {
  return { aborted: result.aborted, errors: result.errors };
}

/** Public model/auth runtime backed by the provider registry used by the agent loop. */
export class ModelRuntime implements Models {
  static {
    installModelRuntimeFactory((registry) => new ModelRuntime({
      registry,
      modelNetworkEnabled: process.env.RIGYN_OFFLINE === undefined,
    }));
  }
  readonly #registry: ModelRegistry;
  readonly #publicModels: ReturnType<typeof extensionModelRegistry>;
  readonly #runtimeCredentials: RuntimeCredentialStore | undefined;
  readonly #modelsPath: string | undefined;
  readonly #configuredProviderIds = new Set<string>();
  readonly #modelNetworkEnabled: boolean;
  #storedProviders = new Set<string>();
  #configurationError: string | undefined;
  #available: readonly Model<Api>[] = [];
  #availabilityRefresh: Promise<readonly Model<Api>[]> | undefined;

  private constructor(options: {
    registry: ModelRegistry;
    runtimeCredentials?: RuntimeCredentialStore;
    modelsPath?: string;
    modelNetworkEnabled: boolean;
  }) {
    this.#registry = options.registry;
    this.#publicModels = extensionModelRegistry(options.registry);
    this.#runtimeCredentials = options.runtimeCredentials;
    this.#modelsPath = options.modelsPath;
    this.#modelNetworkEnabled = options.modelNetworkEnabled;
    registerModelRuntime(options.registry, this);
  }

  static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
    const credentials = options.credentials
      ?? AuthStorage.create(options.authPath ?? getAuthPath());
    const runtimeCredentials = options.models === undefined
      ? new RuntimeCredentialStore(providerCredentials(credentials))
      : undefined;
    const modelsPath = options.modelsPath === null
      ? undefined
      : options.modelsPath ?? join(getAgentDir(), "model-providers.json");
    const modelsStore = options.modelsStore
      ?? (modelsPath === undefined
        ? undefined
        : new FileProviderModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json")));
    const models = options.models ?? builtinModels({
      credentials: runtimeCredentials!,
      ...(modelsStore === undefined ? {} : { modelsStore }),
    });
    if (options.models === undefined && options.catalogBaseUrl !== undefined) {
      for (const provider of models.getProviders()) {
        models.setProvider(withRemoteCatalog(provider, options.catalogBaseUrl));
      }
    }
    const runtime = new ModelRuntime({
      registry: new ModelRegistry(models),
      ...(runtimeCredentials === undefined ? {} : { runtimeCredentials }),
      ...(modelsPath === undefined ? {} : { modelsPath }),
      modelNetworkEnabled: process.env.RIGYN_OFFLINE === undefined,
    });
    if (options.models === undefined) await runtime.#reloadConfiguredProviders();
    const allowNetwork = runtime.#modelNetworkEnabled && options.allowModelNetwork === true;
    const controller = allowNetwork ? new AbortController() : undefined;
    const timeout = controller === undefined
      ? undefined
      : setTimeout(() => controller.abort(), options.modelRefreshTimeoutMs ?? 15_000);
    try {
      await runtime.refresh({ allowNetwork, ...(controller === undefined ? {} : { signal: controller.signal }) });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    return runtime;
  }

  async #reloadConfiguredProviders(): Promise<void> {
    for (const provider of this.#configuredProviderIds) this.#publicModels.unregisterProvider(provider);
    this.#configuredProviderIds.clear();
    const configuration = await loadRuntimeModelConfiguration(this.#modelsPath);
    this.#configurationError = configuration.error;
    for (const [provider, definition] of configuration.providers) {
      try {
        this.#publicModels.registerProvider(provider, providerConfiguration(this.#registry, provider, definition));
        this.#configuredProviderIds.add(provider);
        if (definition.apiKey !== undefined) defaultSecretRedactor.register(definition.apiKey);
      } catch (error) {
        const message = `Provider ${provider}: ${error instanceof Error ? error.message : String(error)}`;
        this.#configurationError = [this.#configurationError, message].filter(Boolean).join("\n\n");
      }
    }
  }

  getProviders(): readonly Provider[] {
    return this.#registry.models().getProviders().flatMap((provider) => {
      const selected = this.#publicModels.getProvider(provider.id);
      return selected === undefined ? [] : [selected];
    });
  }

  getProvider(providerId: string): Provider | undefined {
    return this.#publicModels.getProvider(providerId);
  }

  getModels(providerId?: string): readonly Model<Api>[] {
    const models = this.#publicModels.getAll();
    return providerId === undefined ? models : models.filter((model) => model.provider === providerId);
  }

  getModel(providerId: string, modelId: string): Model<Api> | undefined {
    return this.#publicModels.find(providerId, modelId);
  }

  checkAuth(providerId: string): Promise<AuthCheck | undefined> {
    return this.#registry.models().checkAuth(providerId) as Promise<AuthCheck | undefined>;
  }

  async #refreshAvailability(providerId?: string): Promise<readonly Model<Api>[]> {
    const internal = await this.#registry.models().getAvailable(providerId);
    const available = internal.map((model) => this.#publicModels.present(model));
    if (providerId === undefined) this.#available = available;
    return available;
  }

  async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
    if (providerId !== undefined) {
      if (this.#availabilityRefresh !== undefined) {
        await this.#availabilityRefresh;
        return this.#available.filter((model) => model.provider === providerId);
      }
      return await this.#refreshAvailability(providerId);
    }
    if (this.#availabilityRefresh !== undefined) return await this.#availabilityRefresh;
    const refresh = this.#refreshAvailability();
    this.#availabilityRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.#availabilityRefresh === refresh) this.#availabilityRefresh = undefined;
    }
  }

  getAvailableSnapshot(): readonly Model<Api>[] {
    return this.#available;
  }

  getError(): string | undefined {
    return [this.#configurationError, this.#registry.getError()]
      .filter((value): value is string => value !== undefined && value !== "")
      .join("\n\n") || undefined;
  }

  getRegisteredProviderConfig(providerId: string): ExtensionProviderConfig | undefined {
    return this.#publicModels.getRegisteredProviderConfig(providerId);
  }

  getRegisteredProviderIds(): readonly string[] {
    return this.#publicModels.getRegisteredProviderIds();
  }

  getRegisteredNativeProvider(providerId: string): Provider | undefined {
    return this.#publicModels.getRegisteredNativeProvider(providerId);
  }

  getCompatibilityRequestConfig(model: Model<Api>): { headers?: ProviderHeaders; authHeader: boolean } {
    const config = this.#publicModels.getRegisteredProviderConfig(model.provider);
    const headers = mergeHeaders(model.headers, config?.headers);
    return {
      ...(headers === undefined ? {} : { headers }),
      authHeader: config?.authHeader ?? false,
    };
  }

  isUsingOAuth(providerOrModel: string | Model<Api>): boolean {
    const provider = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
    return this.#registry.isUsingOAuth(provider);
  }

  hasConfiguredAuth(providerOrModel: string | Model<Api>): boolean {
    const provider = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
    return this.#registry.hasConfiguredAuth(provider);
  }

  getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
  getAuth(model: Model<Api>, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
  getAuth(
    providerOrModel: string | Model<Api>,
    overrides: ModelRuntimeAuthOverrides = {},
  ): Promise<AuthResult | undefined> {
    if (typeof providerOrModel === "string") {
      return this.#registry.models().getAuth(providerOrModel, overrides) as Promise<AuthResult | undefined>;
    }
    return this.#registry.models().getAuth(
      this.#publicModels.resolve(providerOrModel),
      overrides,
    ) as Promise<AuthResult | undefined>;
  }

  async setRuntimeApiKey(
    providerId: string,
    apiKey: string,
    refreshOptions: ModelsRefreshOptions = {},
  ): Promise<void> {
    if (this.#runtimeCredentials === undefined) {
      throw new Error("Runtime API-key overrides are unavailable for a caller-supplied model collection");
    }
    this.#runtimeCredentials.setApiKey(providerId, apiKey);
    await this.refresh(refreshOptions);
  }

  async removeRuntimeApiKey(providerId: string): Promise<void> {
    if (this.#runtimeCredentials === undefined) return;
    this.#runtimeCredentials.removeApiKey(providerId);
    await this.refresh({ allowNetwork: false });
  }

  async listCredentials(): Promise<readonly CredentialInfo[]> {
    if (this.#runtimeCredentials === undefined) return [];
    return (await this.#runtimeCredentials.list()).map((entry) => ({
      providerId: entry.providerId,
      type: entry.type === "oauth" ? "oauth" : "api_key",
    }));
  }

  getProviderAuthStatus(providerId: string) {
    if (this.#runtimeCredentials?.hasRuntimeApiKey(providerId) === true) {
      return { configured: true as const, source: "runtime" as const };
    }
    if (this.#storedProviders.has(providerId)) {
      return { configured: true as const, source: "stored" as const };
    }
    const config = this.#publicModels.getRegisteredProviderConfig(providerId);
    if (config?.apiKey !== undefined) {
      return {
        configured: true as const,
        source: this.#configuredProviderIds.has(providerId) ? "models_json_key" as const : "fallback" as const,
      };
    }
    return this.#registry.getProviderAuthStatus(providerId);
  }

  async #prepareRequest(
    model: Model<Api>,
    options: (StreamOptions & ModelsStreamTransforms) | undefined,
  ): Promise<{ provider: Provider; model: Model<Api>; options: StreamOptions }> {
    const provider = this.getProvider(model.provider);
    if (provider === undefined) throw new Error(`Unknown provider: ${model.provider}`);
    const resolution = await this.getAuth(model, {
      ...(options?.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options?.env === undefined ? {} : { env: options.env }),
    });
    if (resolution === undefined) throw new Error(`Provider is not configured: ${model.provider}`);
    const { transformHeaders, ...providerOptions } = options ?? {};
    let headers = mergeHeaders(resolution.auth.headers, providerOptions.headers);
    if (transformHeaders !== undefined) headers = await transformHeaders(headers ?? {});
    const apiKey = providerOptions.apiKey ?? resolution.auth.apiKey;
    return {
      provider,
      model: resolution.auth.baseUrl === undefined ? model : { ...model, baseUrl: resolution.auth.baseUrl },
      options: {
        ...providerOptions,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(headers === undefined ? {} : { headers }),
        ...(resolution.env === undefined && providerOptions.env === undefined
          ? {}
          : { env: { ...(resolution.env ?? {}), ...(providerOptions.env ?? {}) } }),
      },
    };
  }

  stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ): AssistantMessageEventStream {
    return lazyStream(model, async () => {
      const prepared = await this.#prepareRequest(
        model,
        options as (StreamOptions & ModelsStreamTransforms) | undefined,
      );
      return prepared.provider.stream(
        prepared.model,
        context,
        prepared.options as ApiStreamOptions<TApi>,
      );
    });
  }

  complete<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ): Promise<AssistantMessage> {
    return this.stream(model, context, options).result();
  }

  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): AssistantMessageEventStream {
    return lazyStream(model, async () => {
      const prepared = await this.#prepareRequest(model, options);
      return prepared.provider.streamSimple(prepared.model, context, prepared.options as SimpleStreamOptions);
    });
  }

  completeSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): Promise<AssistantMessage> {
    return this.streamSimple(model, context, options).result();
  }

  async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
    const credential = await this.#registry.models().login(
      providerId,
      type,
      interaction as ProviderAuthInteraction,
    );
    await this.refresh({ allowNetwork: this.#modelNetworkEnabled });
    return credential as Credential;
  }

  async logout(providerId: string): Promise<void> {
    await this.#registry.models().logout(providerId);
    await this.refresh({ allowNetwork: this.#modelNetworkEnabled });
  }

  async reloadConfig(): Promise<void> {
    await this.#reloadConfiguredProviders();
    await this.refresh({ allowNetwork: this.#modelNetworkEnabled });
  }

  async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
    const result = await this.#registry.refresh({
      ...options,
      allowNetwork: options.allowNetwork ?? this.#modelNetworkEnabled,
    });
    try {
      await this.getAvailable();
    } catch {
      // The registry records availability failures while retaining the last good catalog.
    }
    if (this.#runtimeCredentials !== undefined) {
      this.#storedProviders = new Set((await this.#runtimeCredentials.list()).map((entry) => entry.providerId));
    }
    return publicRefreshResult(result);
  }

  registerNativeProvider(provider: Provider): void {
    this.#publicModels.registerProvider(provider);
    void this.refresh({ allowNetwork: false });
  }

  registerProvider(providerId: string, config: ExtensionProviderConfig): void {
    this.#publicModels.registerProvider(providerId, config);
    void this.refresh({ allowNetwork: false });
  }

  unregisterProvider(providerId: string): void {
    this.#publicModels.unregisterProvider(providerId);
    void this.refresh({ allowNetwork: false });
  }

  /** @internal Bridge used by the agent loop until its provider boundary is fully public. */
  internalRegistry(): ModelRegistry {
    return this.#registry;
  }

  /** @deprecated Prefer getModels(). */
  getAll(): Model<Api>[] { return [...this.getModels()]; }
  /** @deprecated Prefer getModel(). */
  find(providerId: string, modelId: string): Model<Api> | undefined { return this.getModel(providerId, modelId); }
  /** @deprecated Prefer getAuth(). */
  async getApiKeyAndHeaders(model: Model<Api>) {
    try {
      const result = await this.getAuth(model);
      if (result === undefined) return { ok: false as const, error: `No API key found for ${model.provider}` };
      const headers = Object.fromEntries(
        Object.entries(result.auth.headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
      );
      return {
        ok: true as const,
        ...(result.auth.apiKey === undefined ? {} : { apiKey: result.auth.apiKey }),
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        ...(result.env === undefined ? {} : { env: result.env }),
      };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** @internal Backward-compatible access to the provider collection. */
  models() { return this.#registry.models(); }
}

export interface ScopedModel {
  model: ProviderModel;
  thinkingLevel?: ModelReasoningEffort;
}

export interface ModelScopeDiagnostic {
  pattern: string;
  provider: string;
  model: string;
  thinkingLevel: ModelReasoningEffort;
  supportedThinkingLevels: ModelReasoningEffort[];
}

export interface ResolveModelScopeResult {
  models: ScopedModel[];
  diagnostics: ModelScopeDiagnostic[];
  omittedCount: number;
}

export function resolveModelScopeWithDiagnostics(
  patterns: readonly string[],
  modelRuntime: Pick<ModelRegistry, "getAvailable">,
): ResolveModelScopeResult {
  const available = modelRuntime.getAvailable().map((model) => ({
    provider: model.provider,
    model: model.id,
    definition: model,
  }));
  const resolved = resolveModelsForScope(available, patterns, (entry) => {
    if (!entry.definition.reasoning) return ["off"];
    const mapping = entry.definition.thinkingLevelMap;
    return mapping === undefined
      ? MODEL_REASONING_EFFORTS
      : MODEL_REASONING_EFFORTS.filter((level) => mapping[level] !== null);
  });
  return {
    models: resolved.models.map((entry) => ({
      model: entry.definition,
      ...(entry.reasoningEffort === undefined ? {} : { thinkingLevel: entry.reasoningEffort }),
    })),
    diagnostics: resolved.diagnostics.map((diagnostic) => ({
      pattern: diagnostic.pattern,
      provider: diagnostic.provider,
      model: diagnostic.model,
      thinkingLevel: diagnostic.reasoningEffort,
      supportedThinkingLevels: diagnostic.supportedReasoningEfforts,
    })),
    omittedCount: resolved.omittedCount,
  };
}

export interface ResolveCliModelResult {
  model?: ProviderModel;
  thinkingLevel?: ModelReasoningEffort;
  error?: string;
}

export function resolveCliModel(options: {
  modelRuntime: Pick<ModelRegistry, "getAvailable">;
  provider?: string;
  model?: string;
  thinkingLevel?: ModelReasoningEffort;
}): ResolveCliModelResult {
  const models = options.modelRuntime.getAvailable();
  if (options.model === undefined) {
    const candidate = options.provider === undefined
      ? models[0]
      : models.find((model) => model.provider.toLowerCase() === options.provider!.toLowerCase());
    return candidate === undefined
      ? { error: options.provider === undefined ? "No available model" : `No available model for provider ${options.provider}` }
      : { model: candidate, ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }) };
  }
  const requested = options.model.trim().toLowerCase();
  const matches = models.filter((model) => {
    if (options.provider !== undefined && model.provider.toLowerCase() !== options.provider.toLowerCase()) return false;
    return model.id.toLowerCase() === requested
      || `${model.provider}/${model.id}`.toLowerCase() === requested;
  });
  if (matches.length === 1) {
    return { model: matches[0]!, ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }) };
  }
  return {
    error: matches.length > 1
      ? `Model reference ${options.model} is ambiguous; include the provider`
      : `Model not found: ${options.model}`,
  };
}
