import { dirname, join } from "node:path";

import { minimatch } from "minimatch";

import {
  lazyStream,
  type ModelsStreamTransforms,
  type ModelsSimpleStreamOptions,
  type ModelsRefreshResult,
  type ModelsRefreshOptions,
  type ModelsApiStreamOptions,
  type Models,
  type Model,
  type CredentialStore as PublicCredentialStore,
  type CredentialInfo,
  type Credential,
  type Context,
  type AuthType,
  type AuthResult,
  type AuthInteraction,
  type AuthCheck,
  type AssistantMessageEventStream,
  type AssistantMessage,
  type ApiStreamOptions,
  type Api,
  type Provider,
  type ProviderHeaders,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@rigyn/models";

import { createDefaultCredentialStore } from "../auth/default-store.js";
import { assertRedactableSecret, defaultSecretRedactor } from "../auth/redaction.js";
import {
  assertCredentialId,
  isMutableCredentialStore,
  type CredentialStore as HostCredentialStore,
} from "../auth/types.js";
import { getAgentDir, getAuthPath } from "../config/paths.js";
import { errorMessage } from "../core/errors.js";
import {
  extensionModelRegistry,
  type ExtensionProviderConfig,
  type ExtensionProviderModelConfig,
} from "../extensions/model-boundary.js";
import { ProviderCredentialStoreAdapter } from "./auth-store-adapter.js";
import { protectProviderAuth, protectProviderEnvironment } from "./auth-protection.js";
import { builtinModels } from "./all.js";
import { ModelRegistry } from "./model-registry.js";
import {
  loadRuntimeModelConfiguration,
  type RuntimeModelDefinition,
  type RuntimeProviderDefinition,
} from "./model-runtime-config.js";
import { providerConfigValueUsesCommand } from "./provider-config-value.js";
import type {
  MutableModels,
  ProviderAuthInteraction,
  ProviderCredential,
  ProviderCredentialInfo,
  ProviderCredentialStore,
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
  /** Credential storage. Defaults to the platform-selected store at authPath or the standard rigyn auth path. */
  credentials?: PublicCredentialStore | HostCredentialStore;
  /** File used by the default credential store. Ignored when credentials or models is supplied. */
  authPath?: string;
  /**
   * Optional provider/model configuration file. Defaults to
   * `<agentDir>/model-providers.json`; null disables file loading.
   */
  modelsPath?: string | null;
  modelsStore?: ProviderModelsStore;
  modelsStorePath?: string;
  /** Timeout for the create-time network model refresh. */
  modelRefreshTimeoutMs?: number;
  /** Allow create-time provider catalog refreshes. Default: false. */
  allowModelNetwork?: boolean;
  /** Optional base URL used by provider implementations with remote catalogs. */
  catalogBaseUrl?: string;
}

export interface ModelRuntimeAuthOverrides {
  apiKey?: string;
  env?: Record<string, string>;
  /** Refresh stored OAuth before it has less than this many milliseconds remaining. */
  minOAuthValidityMs?: number;
  signal?: AbortSignal;
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
    assertRedactableSecret(apiKey, "Runtime API key");
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
    if (apiKey === undefined) return await this.#store.read(provider);
    const stored = await this.#store.read(provider);
    return {
      type: "api_key",
      key: apiKey,
      ...(stored?.type !== "api_key" || stored.env === undefined ? {} : { env: stored.env }),
    };
  }

  async list(): Promise<readonly ProviderCredentialInfo[]> {
    const entries = new Map((await this.#store.list()).map((entry) => [entry.providerId, entry]));
    for (const providerId of this.#apiKeys.keys()) entries.set(providerId, { providerId, type: "api_key" });
    return [...entries.values()];
  }

  modify(
    provider: string,
    operation: (current: ProviderCredential | undefined) => Promise<ProviderCredential | undefined>,
    signal?: AbortSignal,
  ): Promise<ProviderCredential | undefined> {
    return this.#store.modify(provider, operation, signal);
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
    ...(() => {
      const selected = definition.maxInputTokens ?? fallback?.maxInputTokens;
      return selected === undefined ? {} : { maxInputTokens: selected };
    })(),
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
    ...(model.maxInputTokens === undefined ? {} : { maxInputTokens: model.maxInputTokens }),
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

function modelNetworkEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(?:1|true|yes)$/iu.test(environment.RIGYN_OFFLINE ?? "");
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function validateModelRefreshTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`modelRefreshTimeoutMs must be an integer from 0 to ${MAX_TIMER_DELAY_MS}`);
  }
}

/** Public model/auth runtime backed by the provider registry used by the agent loop. */
export class ModelRuntime implements Models {
  static {
    installModelRuntimeFactory((registry) => new ModelRuntime({
      registry,
      modelNetworkEnabled: modelNetworkEnabled(),
    }));
  }
  readonly #registry: ModelRegistry;
  readonly #publicModels: ReturnType<typeof extensionModelRegistry>;
  readonly #runtimeCredentials: RuntimeCredentialStore | undefined;
  readonly #modelsPath: string | undefined;
  readonly #configuredProviderIds = new Set<string>();
  readonly #modelNetworkEnabled: boolean;
  readonly #closeModels: (() => Promise<void>) | undefined;
  #storedProviders = new Set<string>();
  #configurationError: string | undefined;
  #available: readonly Model<Api>[] = [];
  #availabilityGeneration = 0;
  #availabilityRefresh: Promise<readonly Model<Api>[]> | undefined;
  #closePromise: Promise<void> | undefined;

  private constructor(options: {
    registry: ModelRegistry;
    runtimeCredentials?: RuntimeCredentialStore;
    modelsPath?: string;
    modelNetworkEnabled: boolean;
    closeModels?: () => Promise<void>;
  }) {
    this.#registry = options.registry;
    this.#publicModels = extensionModelRegistry(options.registry);
    this.#runtimeCredentials = options.runtimeCredentials;
    this.#modelsPath = options.modelsPath;
    this.#modelNetworkEnabled = options.modelNetworkEnabled;
    this.#closeModels = options.closeModels;
    registerModelRuntime(options.registry, this);
  }

  static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
    const modelRefreshTimeoutMs = options.modelRefreshTimeoutMs ?? 15_000;
    validateModelRefreshTimeout(modelRefreshTimeoutMs);
    const credentials = options.credentials
      ?? await createDefaultCredentialStore(options.authPath ?? getAuthPath(), { createLocalKey: true });
    const runtimeCredentials = options.models === undefined
      ? new RuntimeCredentialStore(providerCredentials(credentials))
      : undefined;
    const modelsPath = options.modelsPath === null
      ? undefined
      : options.modelsPath ?? join(getAgentDir(), "model-providers.json");
    const modelsStore = options.modelsStore
      ?? (options.modelsStorePath !== undefined
        ? new FileProviderModelsStore(options.modelsStorePath)
        : modelsPath === undefined
          ? undefined
          : new FileProviderModelsStore(join(dirname(modelsPath), "models-store.json")));
    const ownedModels = options.models === undefined
      ? builtinModels({
          credentials: runtimeCredentials!,
          ...(modelsStore === undefined ? {} : { modelsStore }),
        })
      : undefined;
    const models = options.models ?? ownedModels!;
    if (options.models === undefined && options.catalogBaseUrl !== undefined) {
      for (const provider of models.getProviders()) {
        models.setProvider(withRemoteCatalog(provider, options.catalogBaseUrl));
      }
    }
    const runtime = new ModelRuntime({
      registry: new ModelRegistry(models),
      ...(runtimeCredentials === undefined ? {} : { runtimeCredentials }),
      ...(options.models !== undefined || modelsPath === undefined ? {} : { modelsPath }),
      modelNetworkEnabled: modelNetworkEnabled(),
      ...(ownedModels === undefined ? {} : { closeModels: () => ownedModels.close() }),
    });
    try {
      if (options.models === undefined) await runtime.#refreshConfiguredProviders();
      const allowNetwork = runtime.#modelNetworkEnabled && options.allowModelNetwork === true;
      const controller = allowNetwork ? new AbortController() : undefined;
      const timeout = controller === undefined
        ? undefined
        : setTimeout(() => controller.abort(), modelRefreshTimeoutMs);
      try {
        await runtime.refresh({ allowNetwork, ...(controller === undefined ? {} : { signal: controller.signal }) });
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
      return runtime;
    } catch (error) {
      try {
        await ownedModels?.close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "ModelRuntime creation and cleanup failed");
      }
      throw error;
    }
  }

  async #refreshConfiguredProviders(): Promise<void> {
    for (const provider of this.#configuredProviderIds) this.#publicModels.unregisterProvider(provider);
    this.#configuredProviderIds.clear();
    const configuration = await loadRuntimeModelConfiguration(this.#modelsPath);
    this.#configurationError = configuration.error;
    for (const [provider, definition] of configuration.providers) {
      try {
        this.#publicModels.registerProvider(provider, providerConfiguration(this.#registry, provider, definition));
        this.#configuredProviderIds.add(provider);
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

  async #readAvailability(providerId?: string): Promise<readonly Model<Api>[]> {
    const internal = await this.#registry.models().getAvailable(providerId);
    return internal.map((model) => this.#publicModels.present(model));
  }

  async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
    if (providerId !== undefined) {
      if (this.#availabilityRefresh !== undefined) {
        await this.#availabilityRefresh;
        return this.#available.filter((model) => model.provider === providerId);
      }
      return await this.#readAvailability(providerId);
    }
    if (this.#availabilityRefresh !== undefined) return await this.#availabilityRefresh;
    const generation = ++this.#availabilityGeneration;
    const refresh = this.#readAvailability().then((available) => {
      if (generation === this.#availabilityGeneration) this.#available = available;
      return available;
    });
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
    const headers = mergeHeaders(model.headers, undefined);
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

  getAuth(model: Model<Api>, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
  getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
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
        source: this.#configuredProviderIds.has(providerId)
          ? providerConfigValueUsesCommand(config.apiKey)
            ? "models_json_command" as const
            : "models_json_key" as const
          : "fallback" as const,
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
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    if (resolution === undefined) throw new Error(`Provider is not configured: ${model.provider}`);
    const selectedOptions = options ?? {};
    const { transformHeaders: headerTransform, ...providerOptions } = selectedOptions;
    const providerHeaders = providerOptions.headers;
    let headers = mergeHeaders(resolution.auth.headers, providerHeaders);
    if (headerTransform !== undefined) headers = await headerTransform(headers ?? {});
    const apiKey = providerOptions.apiKey ?? resolution.auth.apiKey;
    const env = resolution.env === undefined && providerOptions.env === undefined
      ? undefined
      : { ...(resolution.env ?? {}), ...(providerOptions.env ?? {}) };
    protectProviderAuth({ ...(apiKey === undefined ? {} : { apiKey }), ...(headers === undefined ? {} : { headers }) });
    protectProviderEnvironment(env);
    return {
      provider,
      model: resolution.auth.baseUrl === undefined ? model : { ...model, baseUrl: resolution.auth.baseUrl },
      options: {
        ...providerOptions,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(headers === undefined ? {} : { headers }),
        ...(env === undefined ? {} : { env }),
      },
    };
  }

  stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ): AssistantMessageEventStream {
    const start = async () => {
      const prepared = await this.#prepareRequest(
        model,
        options as (StreamOptions & ModelsStreamTransforms) | undefined,
      );
      return prepared.provider.stream(
        prepared.model,
        context,
        prepared.options as ApiStreamOptions<TApi>,
      );
    };
    return lazyStream(model, start);
  }

  complete<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ): Promise<AssistantMessage> {
    const events = this.stream(model, context, options);
    return events.result();
  }

  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): AssistantMessageEventStream {
    const start = async () => {
      const prepared = await this.#prepareRequest(model, options);
      return prepared.provider.streamSimple(
        prepared.model,
        context,
        prepared.options as SimpleStreamOptions,
      );
    };
    return lazyStream(model, start);
  }

  completeSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): Promise<AssistantMessage> {
    const events = this.streamSimple(model, context, options);
    return events.result();
  }

  async login(providerId: string, type: AuthType | "provider_account", interaction: AuthInteraction): Promise<Credential> {
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

  async refreshConfig(): Promise<void> {
    await this.refresh({ allowNetwork: this.#modelNetworkEnabled });
  }

  async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
    const generation = ++this.#availabilityGeneration;
    const operation = (async () => {
      if (this.#modelsPath !== undefined) await this.#refreshConfiguredProviders();
      const result = await this.#registry.refresh({
        ...options,
        allowNetwork: options.allowNetwork ?? this.#modelNetworkEnabled,
      });
      if (generation === this.#availabilityGeneration) {
        this.#available = this.#registry.getAvailable().map((model) => this.#publicModels.present(model));
      }
      if (this.#runtimeCredentials !== undefined) {
        const storedProviders = new Set((await this.#runtimeCredentials.list()).map((entry) => entry.providerId));
        if (generation === this.#availabilityGeneration) this.#storedProviders = storedProviders;
      }
      return publicRefreshResult(result);
    })();
    const refresh = operation.then(() => this.#available);
    void refresh.catch(() => undefined);
    this.#availabilityRefresh = refresh;
    try {
      return await operation;
    } finally {
      if (this.#availabilityRefresh === refresh) this.#availabilityRefresh = undefined;
    }
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

  /** Close transports owned by a runtime created with the built-in model collection. */
  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closePromise = this.#closeModels?.() ?? Promise.resolve();
    return this.#closePromise;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
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
      return { ok: false as const, error: errorMessage(error) };
    }
  }

  /** @internal Backward-compatible access to the provider collection. */
  models() { return this.#registry.models(); }
}

export interface ScopedModel {
  model: Model<Api>;
  thinkingLevel?: ModelReasoningEffort;
}

export interface ModelScopeDiagnostic {
  pattern: string;
  message: string;
  code: "no-match" | "invalid-thinking-level";
  type: "warning";
}

export interface ResolveModelScopeResult {
  diagnostics: ModelScopeDiagnostic[];
  scopedModels: ScopedModel[];
}

interface ResolverModelRuntime {
  getModels(): readonly Model<Api>[];
  getAvailable(): readonly Model<Api>[] | Promise<readonly Model<Api>[]>;
  hasConfiguredAuth?(providerOrModel: string | Model<Api>): boolean;
}

interface ParsedModelPattern {
  model?: Model<Api>;
  thinkingLevel?: ModelReasoningEffort;
  warning?: string;
}

function isThinkingLevel(value: string): value is ModelReasoningEffort {
  return (MODEL_REASONING_EFFORTS as readonly string[]).includes(value);
}

function sameModel(left: Model<Api>, right: Model<Api>): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function exactReference(
  reference: string,
  models: readonly Model<Api>[],
): Model<Api> | undefined {
  const needle = reference.trim().toLocaleLowerCase("en-US");
  if (needle === "") return undefined;
  const qualified = models.filter(
    (model) => `${model.provider}/${model.id}`.toLocaleLowerCase("en-US") === needle,
  );
  if (qualified.length === 1) return qualified[0];
  if (qualified.length > 1) return undefined;
  const byId = models.filter((model) => model.id.toLocaleLowerCase("en-US") === needle);
  return byId.length === 1 ? byId[0] : undefined;
}

function isVersionedModel(id: string): boolean {
  return /-\d{8}$/u.test(id);
}

function fuzzyModel(pattern: string, models: readonly Model<Api>[]): Model<Api> | undefined {
  const exact = exactReference(pattern, models);
  if (exact !== undefined) return exact;
  const needle = pattern.toLocaleLowerCase("en-US");
  const candidates = models.filter((model) =>
    model.id.toLocaleLowerCase("en-US").includes(needle)
    || model.name.toLocaleLowerCase("en-US").includes(needle));
  if (candidates.length === 0) return undefined;
  const aliases = candidates.filter((model) => !isVersionedModel(model.id));
  const preferred = aliases.length === 0 ? candidates : aliases;
  return [...preferred].sort((left, right) => right.id.localeCompare(left.id))[0];
}

function parseModelPattern(
  pattern: string,
  models: readonly Model<Api>[],
  invalidSuffixIsModelId: boolean,
): ParsedModelPattern {
  const direct = fuzzyModel(pattern, models);
  if (direct !== undefined) return { model: direct };
  const separator = pattern.lastIndexOf(":");
  if (separator < 0) return {};
  const prefix = pattern.slice(0, separator);
  const suffix = pattern.slice(separator + 1);
  if (isThinkingLevel(suffix)) {
    const nested = parseModelPattern(prefix, models, invalidSuffixIsModelId);
    return nested.model === undefined
      ? nested
      : {
          model: nested.model,
          ...(nested.warning === undefined ? { thinkingLevel: suffix } : {}),
          ...(nested.warning === undefined ? {} : { warning: nested.warning }),
        };
  }
  if (invalidSuffixIsModelId) return {};
  const nested = parseModelPattern(prefix, models, false);
  if (nested.model === undefined) return nested;
  return {
    model: nested.model,
    warning: `Thinking level "${suffix}" is not recognized in "${pattern}"; the default will be used.`,
  };
}

function addScopedModel(target: ScopedModel[], model: Model<Api>, thinkingLevel?: ModelReasoningEffort): void {
  if (target.some((entry) => sameModel(entry.model, model))) return;
  target.push({
    model,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  });
}

function scopeWarning(
  diagnostics: ModelScopeDiagnostic[],
  code: ModelScopeDiagnostic["code"],
  pattern: string,
  message: string,
): void {
  diagnostics.push({ type: "warning", code, message, pattern });
}

export async function resolveModelScopeWithDiagnostics(
  patterns: readonly string[],
  modelRuntime: Pick<ResolverModelRuntime, "getAvailable">,
): Promise<ResolveModelScopeResult> {
  const available = [...await modelRuntime.getAvailable()];
  const scopedModels: ScopedModel[] = [];
  const diagnostics: ModelScopeDiagnostic[] = [];

  for (const pattern of patterns) {
    const exact = exactReference(pattern, available);
    if (exact !== undefined) {
      addScopedModel(scopedModels, exact);
      continue;
    }

    const isGlob = /[*?[]/u.test(pattern);
    if (isGlob) {
      const separator = pattern.lastIndexOf(":");
      const suffix = separator < 0 ? undefined : pattern.slice(separator + 1);
      const thinkingLevel = suffix !== undefined && isThinkingLevel(suffix) ? suffix : undefined;
      const matchPattern = thinkingLevel === undefined ? pattern : pattern.slice(0, separator);
      const exactWithoutThinking = thinkingLevel === undefined
        ? undefined
        : exactReference(matchPattern, available);
      if (exactWithoutThinking !== undefined) {
        addScopedModel(scopedModels, exactWithoutThinking, thinkingLevel);
        continue;
      }
      const matches = available.filter((model) =>
        minimatch(`${model.provider}/${model.id}`, matchPattern, { nocase: true })
        || minimatch(model.id, matchPattern, { nocase: true }));
      if (matches.length === 0) {
        scopeWarning(
          diagnostics,
          "no-match",
          pattern,
          `No catalog model matched "${pattern}".`,
        );
        continue;
      }
      for (const model of matches) addScopedModel(scopedModels, model, thinkingLevel);
      continue;
    }

    const parsed = parseModelPattern(pattern, available, false);
    if (parsed.warning !== undefined) {
      scopeWarning(diagnostics, "invalid-thinking-level", pattern, parsed.warning);
    }
    if (parsed.model === undefined) {
      scopeWarning(
        diagnostics,
        "no-match",
        pattern,
        `No catalog model matched "${pattern}".`,
      );
      continue;
    }
    addScopedModel(scopedModels, parsed.model, parsed.thinkingLevel);
  }

  return { scopedModels, diagnostics };
}

export interface ResolveCliModelResult {
  model: Model<Api> | undefined;
  thinkingLevel?: ModelReasoningEffort;
  warning: string | undefined;
  error: string | undefined;
}

export function resolveCliModel(options: {
  cliProvider?: string;
  cliModel?: string;
  cliThinking?: ModelReasoningEffort;
  modelRuntime: Pick<ResolverModelRuntime, "getModels"> & Partial<Pick<ResolverModelRuntime, "hasConfiguredAuth">>;
}): ResolveCliModelResult {
  const empty = (): ResolveCliModelResult => ({ model: undefined, warning: undefined, error: undefined });
  if (options.cliModel === undefined || options.cliModel === "") return empty();

  const models = [...options.modelRuntime.getModels()];
  if (models.length === 0) {
    return {
      model: undefined,
      warning: undefined,
      error: "The model catalog is empty; add a provider model before selecting one.",
    };
  }

  const providers = new Map<string, string>();
  for (const model of models) {
    providers.set(model.provider.toLocaleLowerCase("en-US"), model.provider);
  }
  let provider = options.cliProvider === undefined
    ? undefined
    : providers.get(options.cliProvider.toLocaleLowerCase("en-US"));
  if (options.cliProvider !== undefined && provider === undefined) {
    return {
      model: undefined,
      warning: undefined,
      error: `Provider "${options.cliProvider}" is not present in the model catalog.`,
    };
  }

  let pattern = options.cliModel;
  let inferredProvider = false;
  if (provider === undefined) {
    const separator = pattern.indexOf("/");
    if (separator >= 0) {
      const inferred = providers.get(pattern.slice(0, separator).toLocaleLowerCase("en-US"));
      if (inferred !== undefined) {
        provider = inferred;
        pattern = pattern.slice(separator + 1);
        inferredProvider = true;
      }
    }
  }

  if (provider === undefined) {
    const exact = exactReference(options.cliModel, models);
    if (exact !== undefined) {
      return { model: exact, warning: undefined, error: undefined };
    }
  } else if (options.cliProvider !== undefined) {
    const prefix = `${provider}/`;
    if (pattern.toLocaleLowerCase("en-US").startsWith(prefix.toLocaleLowerCase("en-US"))) {
      pattern = pattern.slice(prefix.length);
    }
  }

  const candidates = provider === undefined
    ? models
    : models.filter((model) => model.provider === provider);
  const parsed = parseModelPattern(pattern, candidates, true);
  if (parsed.model !== undefined) {
    if (inferredProvider) {
      const rawMatches = models.filter((model) =>
        model.id.toLocaleLowerCase("en-US") === options.cliModel!.toLocaleLowerCase("en-US")
        && !sameModel(model, parsed.model!));
      const hasAuth = options.modelRuntime.hasConfiguredAuth === undefined
        ? undefined
        : (candidate: string | Model<Api>): boolean =>
            options.modelRuntime.hasConfiguredAuth!(candidate);
      if (
        rawMatches.length > 0
        && hasAuth !== undefined
        && !hasAuth(parsed.model.provider)
      ) {
        const configured = rawMatches.filter((model) => hasAuth(model.provider));
        if (configured.length === 1) {
          return { model: configured[0], warning: undefined, error: undefined };
        }
      }
    }
    return {
      model: parsed.model,
      ...(parsed.thinkingLevel === undefined ? {} : { thinkingLevel: parsed.thinkingLevel }),
      warning: parsed.warning,
      error: undefined,
    };
  }

  if (inferredProvider) {
    const rawExact = exactReference(options.cliModel, models);
    if (rawExact !== undefined) {
      return { model: rawExact, warning: undefined, error: undefined };
    }
    const rawParsed = parseModelPattern(options.cliModel, models, true);
    if (rawParsed.model !== undefined) {
      return {
        model: rawParsed.model,
        ...(rawParsed.thinkingLevel === undefined ? {} : { thinkingLevel: rawParsed.thinkingLevel }),
        warning: rawParsed.warning,
        error: undefined,
      };
    }
  }

  if (provider !== undefined && candidates.length > 0) {
    let customId = pattern;
    let customThinking: ModelReasoningEffort | undefined;
    if (options.cliThinking === undefined) {
      const separator = pattern.lastIndexOf(":");
      const suffix = separator < 0 ? undefined : pattern.slice(separator + 1);
      if (suffix !== undefined && isThinkingLevel(suffix)) {
        customId = pattern.slice(0, separator);
        customThinking = suffix;
      }
    }
    const base = candidates[0]!;
    const customModel: Model<Api> = {
      ...base,
      id: customId,
      name: customId,
      ...(
        customThinking !== undefined && customThinking !== "off"
          ? { reasoning: true }
          : {}
      ),
    };
    return {
      model: customModel,
      ...(customThinking === undefined ? {} : { thinkingLevel: customThinking }),
      warning: `Model "${customId}" is not catalogued for provider "${provider}"; using it as a custom model ID.`,
      error: undefined,
    };
  }

  const display = provider === undefined ? options.cliModel : `${provider}/${pattern}`;
  return {
    model: undefined,
    warning: parsed.warning,
    error: `No model matched "${display}".`,
  };
}
