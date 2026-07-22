import type { ModelProtocolFamily } from "../core/types.js";
import type {
  Models,
  MutableModels,
  Provider,
  ProviderAuthResult,
  ProviderModel,
  ProviderOAuthCredential,
  ProviderRefreshOptions,
  ProviderRefreshContext,
  ProviderStreamContext,
  ProviderStreamOptions,
} from "./models.js";

export interface ExtensionOAuthConfig {
  name: string;
  login(input: {
    signal?: AbortSignal;
    onAuth(info: { url: string; instructions?: string }): void;
    onDeviceCode(info: {
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }): void;
    onPrompt(input: { message: string; placeholder?: string }): Promise<string>;
    onProgress(message: string): void;
    onManualCodeInput(): Promise<string>;
    onSelect(input: {
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
    }): Promise<string>;
  }): Promise<{ refresh: string; access: string; expires: number; [key: string]: unknown }>;
  refreshToken(credential: ProviderOAuthCredential): Promise<{ refresh: string; access: string; expires: number; [key: string]: unknown }>;
  getApiKey(credential: ProviderOAuthCredential): string;
  modifyModels?(models: ProviderModel[], credential: ProviderOAuthCredential): ProviderModel[];
}

export interface ProviderConfigModel {
  id: string;
  name: string;
  api?: ModelProtocolFamily;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: ProviderModel["thinkingLevelMap"];
  input: Array<"text" | "image">;
  cost: ProviderModel["cost"];
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: ProviderModel["compat"];
}

/** Direct extension provider registration input. Defined values compose over an existing registration. */
export interface ProviderConfigInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: ModelProtocolFamily;
  streamSimple?(
    model: ProviderModel,
    context: ProviderStreamContext,
    options?: ProviderStreamOptions,
  ): AsyncIterable<import("../core/types.js").AdapterEvent>;
  headers?: Record<string, string>;
  authHeader?: boolean;
  oauth?: ExtensionOAuthConfig;
  models?: ProviderConfigModel[];
  refreshModels?(context: ProviderRefreshContext): Promise<ProviderConfigModel[]>;
}

export type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
  | { ok: false; error: string };

export interface ProviderAuthStatus {
  configured: boolean;
  source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
  label?: string;
}

function cleanHeaders(
  headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const result = Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null));
  return Object.keys(result).length === 0 ? undefined : result;
}

function mergedModel(
  providerId: string,
  definition: ProviderConfigModel,
  config: ProviderConfigInput,
  fallback: ProviderModel | undefined,
): ProviderModel {
  const api = definition.api ?? config.api ?? fallback?.api;
  if (api === undefined) throw new Error(`Provider ${providerId}, model ${definition.id}: API is required`);
  const baseUrl = definition.baseUrl ?? config.baseUrl ?? fallback?.baseUrl;
  if (baseUrl === undefined) throw new Error(`Provider ${providerId}, model ${definition.id}: base URL is required`);
  if (definition.contextWindow <= 0 || definition.maxTokens <= 0) {
    throw new Error(`Provider ${providerId}, model ${definition.id}: token limits must be positive`);
  }
  return {
    id: definition.id,
    name: definition.name,
    api,
    provider: providerId,
    baseUrl,
    reasoning: definition.reasoning,
    ...(definition.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: definition.thinkingLevelMap }),
    input: definition.input,
    cost: definition.cost,
    contextWindow: definition.contextWindow,
    maxTokens: definition.maxTokens,
    ...(definition.headers === undefined ? {} : { headers: definition.headers }),
    ...(definition.compat === undefined ? {} : { compat: definition.compat }),
  };
}

function extensionOAuth(config: ExtensionOAuthConfig) {
  return {
    name: config.name,
    async login(interaction: import("./models.js").ProviderAuthInteraction): Promise<ProviderOAuthCredential> {
      const credential = await config.login({
        ...(interaction.signal === undefined ? {} : { signal: interaction.signal }),
        onAuth: (info) => interaction.notify({ type: "auth_url", ...info }),
        onDeviceCode: (info) => interaction.notify({ type: "device_code", ...info }),
        onPrompt: (prompt) => interaction.prompt({ type: "text", ...prompt }),
        onProgress: (message) => interaction.notify({ type: "progress", message }),
        onManualCodeInput: () => interaction.prompt({ type: "manual_code", message: "Paste the authorization code" }),
        onSelect: (input) => interaction.prompt({ type: "select", ...input }),
      });
      return { ...credential, type: "oauth" };
    },
    async refresh(credential: ProviderOAuthCredential): Promise<ProviderOAuthCredential> {
      return { ...(await config.refreshToken(credential)), type: "oauth" };
    },
    async toAuth(credential: ProviderOAuthCredential) {
      return { apiKey: config.getApiKey(credential) };
    },
  };
}

function composeProvider(
  providerId: string,
  base: Provider | undefined,
  config: ProviderConfigInput,
): Provider {
  if (base === undefined && config.models === undefined) {
    throw new Error(`Provider ${providerId}: models are required for a new provider`);
  }
  if (config.streamSimple !== undefined && config.api === undefined && config.models?.some((model) => model.api === undefined)) {
    throw new Error(`Provider ${providerId}: API is required when registering a stream implementation`);
  }
  let models = config.models === undefined
    ? (base?.getModels() ?? []).map((model) => config.baseUrl === undefined ? model : { ...model, baseUrl: config.baseUrl })
    : config.models.map((definition) => {
        const defaults = base?.getModels().find((model) => model.id === definition.id) ?? base?.getModels()[0];
        return mergedModel(providerId, definition, config, defaults);
      });
  const oauth = config.oauth === undefined ? base?.auth.oauth : extensionOAuth(config.oauth);
  const inheritedKey = base?.auth.apiKey;
  const configuredHeaders = config.headers;
  const effectiveBaseUrl = config.baseUrl ?? base?.baseUrl;
  const apiKey = inheritedKey === undefined && config.apiKey === undefined && oauth !== undefined
    ? undefined
    : {
        name: inheritedKey?.name ?? "API key",
        login: inheritedKey?.login ?? (async (interaction: import("./models.js").ProviderAuthInteraction) => ({
          type: "api_key" as const,
          key: await interaction.prompt({ type: "secret", message: "Enter API key" }),
        })),
        ...(inheritedKey?.check === undefined ? {} : { check: inheritedKey.check }),
        async resolve(input: Parameters<NonNullable<Provider["auth"]["apiKey"]>["resolve"]>[0]) {
          const result: ProviderAuthResult | undefined = input.credential !== undefined
            ? inheritedKey === undefined
              ? input.credential.key === undefined
                ? undefined
                : {
                    auth: { apiKey: input.credential.key },
                    ...(input.credential.env === undefined ? {} : { env: input.credential.env }),
                    source: "stored credential",
                  }
              : await inheritedKey.resolve(input)
            : config.apiKey !== undefined
              ? { auth: { apiKey: config.apiKey }, source: "configuration" }
              : await inheritedKey?.resolve(input);
          if (result === undefined) return undefined;
          let headers: Record<string, string | null> | undefined = {
            ...result.auth.headers,
            ...configuredHeaders,
          };
          if (config.authHeader === true) {
            if (result.auth.apiKey === undefined) throw new Error("Authorization header requires an API key");
            headers = { ...headers, Authorization: `Bearer ${result.auth.apiKey}` };
          }
          return {
            ...result,
            auth: {
              ...result.auth,
              ...(headers === undefined ? {} : { headers }),
            },
          };
        },
      };
  const provider: Provider = {
    id: providerId,
    name: config.name ?? base?.name ?? providerId,
    ...(effectiveBaseUrl === undefined ? {} : { baseUrl: effectiveBaseUrl }),
    ...(configuredHeaders === undefined ? {} : { headers: configuredHeaders }),
    auth: {
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(oauth === undefined ? {} : { oauth }),
    },
    getModels() {
      return models;
    },
    ...(config.refreshModels === undefined && base?.refreshModels === undefined
      ? {}
      : {
          async refreshModels(context: ProviderRefreshContext) {
            if (base?.refreshModels !== undefined) await base.refreshModels(context);
            if (config.refreshModels !== undefined) {
              const refreshed = await config.refreshModels(context);
              models = refreshed.map((definition) => mergedModel(
                providerId,
                definition,
                config,
                models.find((model) => model.id === definition.id) ?? models[0],
              ));
            }
          },
        }),
    ...(base?.filterModels === undefined && config.oauth?.modifyModels === undefined
      ? {}
      : {
          filterModels(entries: readonly ProviderModel[], credential: import("./models.js").ProviderCredential | undefined) {
            const baseFiltered = base?.filterModels?.(entries, credential) ?? entries;
            return credential?.type === "oauth" && config.oauth?.modifyModels !== undefined
              ? config.oauth.modifyModels([...baseFiltered], credential)
              : baseFiltered;
          },
        }),
    stream(model, context, options) {
      if (config.streamSimple !== undefined) return config.streamSimple(model, context, options);
      if (base === undefined) throw new Error(`Provider ${providerId} has no stream implementation`);
      return base.stream(model, context, options);
    },
    streamSimple(model, context, options) {
      if (config.streamSimple !== undefined) return config.streamSimple(model, context, options);
      if (base === undefined) throw new Error(`Provider ${providerId} has no stream implementation`);
      return base.streamSimple(model, context, options);
    },
  };
  return provider;
}

/** Synchronous extension-facing facade over the direct models collection. */
export class ModelRegistry {
  readonly #models: MutableModels;
  readonly #original = new Map<string, Provider | undefined>();
  readonly #originalAuth = new Map<string, import("./models.js").ProviderAuthCheck | undefined>();
  readonly #originalAvailable = new Map<string, ProviderModel[]>();
  readonly #native = new Map<string, Provider>();
  readonly #configs = new Map<string, ProviderConfigInput>();
  readonly #auth = new Map<string, import("./models.js").ProviderAuthCheck>();
  #available: ProviderModel[] = [];
  #error: string | undefined;

  constructor(models: MutableModels) {
    this.#models = models;
  }

  async refresh(options?: ProviderRefreshOptions): Promise<import("./models.js").ProviderRefreshResult> {
    try {
      const result = await this.#models.refresh(options);
      this.#available = [...await this.#models.getAvailable()];
      const checks = await Promise.all(this.#models.getProviders().map(async (provider) => [
        provider.id,
        await this.#models.checkAuth(provider.id),
      ] as const));
      this.#auth.clear();
      for (const [provider, check] of checks) {
        if (check !== undefined) this.#auth.set(provider, check);
      }
      this.#error = result.errors.size === 0
        ? undefined
        : [...result.errors].map(([provider, error]) => `${provider}: ${error.message}`).join("\n");
      return result;
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
      return {
        aborted: options?.signal?.aborted ?? false,
        errors: new Map([["runtime", error instanceof Error ? error : new Error(String(error))]]),
      };
    }
  }

  getError(): string | undefined { return this.#error; }
  getAll(): ProviderModel[] { return [...this.#models.getModels()]; }
  getAvailable(): ProviderModel[] { return [...this.#available]; }
  find(provider: string, modelId: string): ProviderModel | undefined { return this.#models.getModel(provider, modelId); }
  getProvider(provider: string): Provider | undefined { return this.#models.getProvider(provider); }
  getProviderDisplayName(provider: string): string { return this.#models.getProvider(provider)?.name ?? provider; }
  getProviderAuth(provider: string): Promise<ProviderAuthResult | undefined> { return this.#models.getAuth(provider); }

  hasConfiguredAuth(modelOrProvider: ProviderModel | string): boolean {
    const provider = typeof modelOrProvider === "string" ? modelOrProvider : modelOrProvider.provider;
    return this.#auth.has(provider);
  }

  async getApiKeyAndHeaders(model: ProviderModel): Promise<ResolvedRequestAuth> {
    try {
      const result = await this.#models.getAuth(model);
      if (result === undefined) return { ok: false, error: `No API key found for ${model.provider}` };
      const headers = cleanHeaders(result.auth.headers);
      return {
        ok: true,
        ...(result.auth.apiKey === undefined ? {} : { apiKey: result.auth.apiKey }),
        ...(headers === undefined ? {} : { headers }),
        ...(result.env === undefined ? {} : { env: result.env }),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    try {
      return (await this.#models.getAuth(provider))?.auth.apiKey;
    } catch {
      return undefined;
    }
  }

  getProviderAuthStatus(provider: string): ProviderAuthStatus {
    const check = this.#auth.get(provider);
    return check === undefined
      ? { configured: false }
      : { configured: true, source: check.source === "OAuth" ? "stored" : "environment", ...(check.source === undefined ? {} : { label: check.source }) };
  }

  isUsingOAuth(modelOrProvider: ProviderModel | string): boolean {
    const provider = typeof modelOrProvider === "string" ? modelOrProvider : modelOrProvider.provider;
    return this.#auth.get(provider)?.type === "oauth";
  }

  registerProvider(provider: Provider): void;
  registerProvider(providerName: string, config: ProviderConfigInput): void;
  registerProvider(providerOrName: Provider | string, config?: ProviderConfigInput): void {
    const id = typeof providerOrName === "string" ? providerOrName : providerOrName.id;
    if (id.trim() === "") throw new Error("Provider id must not be empty");
    if (!this.#original.has(id)) {
      this.#original.set(id, this.#models.getProvider(id));
      this.#originalAuth.set(id, this.#auth.get(id));
      this.#originalAvailable.set(id, this.#available.filter((model) => model.provider === id));
    }
    if (typeof providerOrName !== "string") {
      this.#configs.delete(id);
      this.#native.set(id, providerOrName);
      this.#models.setProvider(providerOrName);
      this.#replaceAvailableProvider(id, this.#auth.has(id) ? providerOrName.getModels() : []);
      return;
    }
    if (config === undefined) throw new Error("Provider config is required when registering by name");
    this.#native.delete(id);
    const previous = this.#configs.get(id);
    const merged = { ...previous } as ProviderConfigInput;
    for (const [name, value] of Object.entries(config)) {
      if (value !== undefined) (merged as Record<string, unknown>)[name] = value;
    }
    const base = this.#original.get(id);
    const provider = composeProvider(id, base, merged);
    this.#configs.set(id, merged);
    this.#models.setProvider(provider);
    if (merged.apiKey !== undefined) this.#auth.set(id, { type: "api_key", source: "configuration" });
    this.#replaceAvailableProvider(id, this.#auth.has(id) ? provider.getModels() : []);
  }

  unregisterProvider(providerName: string): void {
    this.#configs.delete(providerName);
    this.#native.delete(providerName);
    this.#auth.delete(providerName);
    const original = this.#original.get(providerName);
    const originalAuth = this.#originalAuth.get(providerName);
    const originalAvailable = this.#originalAvailable.get(providerName) ?? [];
    this.#original.delete(providerName);
    this.#originalAuth.delete(providerName);
    this.#originalAvailable.delete(providerName);
    if (original === undefined) this.#models.deleteProvider(providerName);
    else this.#models.setProvider(original);
    if (originalAuth !== undefined) this.#auth.set(providerName, originalAuth);
    this.#replaceAvailableProvider(providerName, originalAvailable);
  }

  getRegisteredProviderConfig(providerName: string): ProviderConfigInput | undefined {
    return this.#configs.get(providerName);
  }

  getRegisteredNativeProvider(providerName: string): Provider | undefined {
    return this.#native.get(providerName);
  }

  getRegisteredProviderIds(): readonly string[] {
    return [...new Set([...this.#configs.keys(), ...this.#native.keys()])];
  }

  models(): Models {
    return this.#models;
  }

  #replaceAvailableProvider(provider: string, models: readonly ProviderModel[]): void {
    this.#available = [
      ...this.#available.filter((model) => model.provider !== provider),
      ...models,
    ];
  }
}
