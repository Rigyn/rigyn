import { createHash } from "node:crypto";

import { errorMessage } from "../core/errors.js";
import type { ModelProtocolFamily } from "../core/types.js";
import { assertRedactableSecret, defaultSecretRedactor } from "../auth/redaction.js";
import type {
  Models,
  MutableModels,
  Provider,
  ProviderAuthContext,
  ProviderAuthResult,
  ProviderModelAuth,
  ProviderModel,
  ProviderOAuthCredential,
  ProviderRefreshOptions,
  ProviderRefreshContext,
  ProviderStreamContext,
  ProviderStreamOptions,
} from "./models.js";
import {
  providerConfigValueUsesCommand,
  resolveProviderConfigValue,
} from "./provider-config-value.js";

function modelRegistryError(value: unknown): Error {
  const isError = (Error as ErrorConstructor & { isError?: (candidate: unknown) => boolean }).isError;
  return isError?.(value) === true
    ? value as Error
    : new Error(errorMessage(value), { cause: value });
}

function waitForModelRefresh<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

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
  maxInputTokens?: number;
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

function mergeHeaders(
  base: Record<string, string | null> | undefined,
  override: Record<string, string | null> | undefined,
): Record<string, string | null> | undefined {
  if (base === undefined && override === undefined) return undefined;
  const result = { ...base };
  for (const [name, value] of Object.entries(override ?? {})) {
    for (const existing of Object.keys(result)) {
      if (existing.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US")) delete result[existing];
    }
    result[name] = value;
  }
  return result;
}

async function resolvedConfiguredHeaders(
  configured: Record<string, string> | undefined,
  context: ProviderAuthContext,
  environment: Readonly<Record<string, string>> | undefined,
): Promise<Record<string, string> | undefined> {
  if (configured === undefined) return undefined;
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(configured)) {
    const resolved = await resolveProviderConfigValue(value, {
      env: async (key) => environment?.[key] ?? await context.env(key),
      ...(environment === undefined ? {} : { environment }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.shellPath === undefined ? {} : { shellPath: context.shellPath }),
    });
    if (resolved === undefined) {
      throw new Error(`Provider header ${name} references an unavailable environment value`);
    }
    if (/[\u0000\r\n]/u.test(resolved)) {
      throw new Error(`Provider header ${name} resolved to an invalid value`);
    }
    defaultSecretRedactor.register(resolved);
    result[name] = resolved;
  }
  return result;
}

function storedCredentialCommandCacheKey(
  providerId: string,
  expression: string,
  environment: Readonly<Record<string, string>> | undefined,
  shellPath: string | undefined,
): string {
  const hash = createHash("sha256");
  for (const value of [
    providerId,
    expression,
    shellPath ?? "",
    ...Object.entries(environment ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .flat(),
  ]) {
    hash.update(String(Buffer.byteLength(value, "utf8")));
    hash.update(":");
    hash.update(value);
  }
  return hash.digest("hex");
}

async function resolvedStoredCredentialKey(
  providerId: string,
  expression: string,
  context: ProviderAuthContext,
  environment: Readonly<Record<string, string>> | undefined,
  commandCache: Map<string, string>,
): Promise<string> {
  context.signal?.throwIfAborted();
  const resolve = () => resolveProviderConfigValue(expression, {
    env: async (name) => environment?.[name] ?? await context.env(name),
    ...(environment === undefined ? {} : { environment }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.shellPath === undefined ? {} : { shellPath: context.shellPath }),
  });
  let resolved: string | undefined;
  if (!providerConfigValueUsesCommand(expression)) {
    resolved = await resolve();
  } else {
    const cacheKey = storedCredentialCommandCacheKey(
      providerId,
      expression,
      environment,
      context.shellPath,
    );
    resolved = commandCache.get(cacheKey);
    if (resolved === undefined) {
      resolved = await resolve();
      if (resolved !== undefined) commandCache.set(cacheKey, resolved);
    }
  }
  context.signal?.throwIfAborted();
  if (resolved === undefined) {
    throw new Error("Stored provider credential references an unavailable environment value");
  }
  assertRedactableSecret(resolved, "Stored provider credential");
  defaultSecretRedactor.register(resolved);
  return resolved;
}

async function configuredAuth(
  auth: ProviderModelAuth,
  config: ProviderConfigInput,
  context: ProviderAuthContext,
  environment: Readonly<Record<string, string>> | undefined,
): Promise<ProviderModelAuth> {
  const headers = mergeHeaders(
    await resolvedConfiguredHeaders(config.headers, context, environment),
    auth.headers,
  );
  return {
    ...auth,
    ...(headers === undefined ? {} : { headers }),
  };
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
  if (
    definition.maxInputTokens !== undefined &&
    (!Number.isSafeInteger(definition.maxInputTokens) || definition.maxInputTokens < 1)
  ) {
    throw new Error(`Provider ${providerId}, model ${definition.id}: maxInputTokens must be a positive safe integer`);
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
    ...(definition.maxInputTokens === undefined ? {} : { maxInputTokens: definition.maxInputTokens }),
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
        onManualCodeInput: () => interaction.prompt({
          type: "manual_code",
          message: "Enter the code shown after authorization",
        }),
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
  const storedCredentialCommandCache = new Map<string, string>();
  const inheritedRefresh = config.models === undefined ? base?.refreshModels : undefined;
  let models = config.models === undefined
    ? (base?.getModels() ?? []).map((model) => config.baseUrl === undefined ? model : { ...model, baseUrl: config.baseUrl })
    : config.models.map((definition) => {
        const defaults = base?.getModels().find((model) => model.id === definition.id) ?? base?.getModels()[0];
        return mergedModel(providerId, definition, config, defaults);
      });
  const inheritedOAuth = config.oauth === undefined ? base?.auth.oauth : extensionOAuth(config.oauth);
  const oauth = inheritedOAuth === undefined
    ? undefined
    : {
        ...inheritedOAuth,
        async toAuth(
          credential: ProviderOAuthCredential,
          context?: ProviderAuthContext,
        ): Promise<ProviderModelAuth> {
          const auth = await inheritedOAuth.toAuth(credential, context);
          if (context === undefined || config.headers === undefined) return auth;
          return await configuredAuth(auth, config, context, undefined);
        },
      };
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
        async check(
          input: Parameters<NonNullable<NonNullable<Provider["auth"]["apiKey"]>["check"]>>[0],
        ) {
          if (input.credential?.key !== undefined || input.credential?.env !== undefined) {
            return { type: "api_key" as const, source: "stored credential" };
          }
          if (config.apiKey !== undefined || config.headers !== undefined) {
            return { type: "api_key" as const, source: "configuration" };
          }
          return await inheritedKey?.check?.(input);
        },
        async resolve(input: Parameters<NonNullable<Provider["auth"]["apiKey"]>["resolve"]>[0]) {
          let result: ProviderAuthResult | undefined;
          if (input.credential?.key !== undefined) {
            const resolved = await resolvedStoredCredentialKey(
              providerId,
              input.credential.key,
              input.ctx,
              input.credential.env,
              storedCredentialCommandCache,
            );
            if (inheritedKey === undefined) {
              result = {
                auth: { apiKey: resolved },
                ...(input.credential.env === undefined ? {} : { env: input.credential.env }),
                source: "stored credential",
              };
            } else {
              result = await inheritedKey.resolve({
                ...input,
                credential: { ...input.credential, key: resolved },
              });
              if (result !== undefined && resolved !== input.credential.key) {
                result = { ...result, source: "stored credential resolution" };
              }
            }
          } else if (input.credential !== undefined && inheritedKey !== undefined) {
            result = await inheritedKey.resolve(input);
          } else if (config.apiKey !== undefined) {
            const resolved = await resolveProviderConfigValue(config.apiKey, {
              env: async (name) => input.credential?.env?.[name] ?? await input.ctx.env(name),
              ...(input.credential?.env === undefined ? {} : { environment: input.credential.env }),
              ...(input.ctx.signal === undefined ? {} : { signal: input.ctx.signal }),
              ...(input.ctx.shellPath === undefined ? {} : { shellPath: input.ctx.shellPath }),
            });
            if (resolved !== undefined) {
              assertRedactableSecret(resolved, "Configured provider API key");
              defaultSecretRedactor.register(resolved);
              result = {
                auth: { apiKey: resolved },
                ...(input.credential?.env === undefined ? {} : { env: input.credential.env }),
                source: "configuration",
              };
            }
          } else if (input.credential?.env !== undefined) {
            result = { auth: {}, env: input.credential.env, source: "stored credential" };
          } else {
            result = await inheritedKey?.resolve(input);
          }
          if (result === undefined && configuredHeaders !== undefined && config.authHeader !== true) {
            result = { auth: {}, source: "configuration" };
          }
          if (result === undefined) return undefined;
          const configured = await configuredAuth(
            result.auth,
            config,
            input.ctx,
            input.credential?.env,
          );
          let headers = configured.headers;
          if (config.authHeader === true) {
            if (configured.apiKey === undefined) throw new Error("Authorization header requires an API key");
            headers = mergeHeaders(headers, { Authorization: `Bearer ${configured.apiKey}` });
          }
          return {
            ...result,
            auth: {
              ...configured,
              ...(headers === undefined ? {} : { headers }),
            },
          };
        },
      };
  const provider: Provider = {
    id: providerId,
    name: config.name ?? base?.name ?? providerId,
    ...(effectiveBaseUrl === undefined ? {} : { baseUrl: effectiveBaseUrl }),
    ...(base?.headers === undefined ? {} : { headers: base.headers }),
    auth: {
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(oauth === undefined ? {} : { oauth }),
    },
    getModels() {
      return models;
    },
    ...(config.refreshModels === undefined && inheritedRefresh === undefined
      ? {}
      : {
          async refreshModels(context: ProviderRefreshContext) {
            if (inheritedRefresh !== undefined) await inheritedRefresh(context);
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
  #refreshGeneration = 0;

  constructor(models: MutableModels) {
    this.#models = models;
  }

  async refresh(options?: ProviderRefreshOptions): Promise<import("./models.js").ProviderRefreshResult> {
    const generation = ++this.#refreshGeneration;
    try {
      const result = await this.#models.refresh(options);
      options?.signal?.throwIfAborted();
      const errors = new Map(
        [...result.errors].map(([provider, error]) => [provider, modelRegistryError(error)]),
      );
      const snapshots = await waitForModelRefresh(Promise.all(this.#models.getProviders().map(async (provider) => {
        try {
          const [available, check] = await Promise.all([
            this.#models.getAvailable(provider.id),
            this.#models.checkAuth(provider.id),
          ]);
          return { provider: provider.id, available: [...available], check };
        } catch (error) {
          const failure = modelRegistryError(error);
          const existing = errors.get(provider.id);
          errors.set(provider.id, existing === undefined || existing.message === failure.message
            ? existing ?? failure
            : new AggregateError([existing, failure], `${existing.message}; ${failure.message}`));
          return { provider: provider.id, available: [], check: undefined };
        }
      })), options?.signal);
      if (generation === this.#refreshGeneration) {
        this.#available = snapshots.flatMap((snapshot) => snapshot.available);
        this.#auth.clear();
        for (const snapshot of snapshots) {
          if (snapshot.check !== undefined) this.#auth.set(snapshot.provider, snapshot.check);
        }
        this.#error = errors.size === 0
          ? undefined
          : [...errors].map(([provider, error]) => `${provider}: ${error.message}`).join("\n");
      }
      return { aborted: result.aborted, errors };
    } catch (error) {
      if (options?.signal?.aborted === true) return { aborted: true, errors: new Map() };
      if (generation === this.#refreshGeneration) {
        this.#available = [];
        this.#auth.clear();
        this.#error = errorMessage(error);
      }
      return {
        aborted: options?.signal?.aborted ?? false,
        errors: new Map([["runtime", modelRegistryError(error)]]),
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
      return { ok: false, error: errorMessage(error) };
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

  registerProvider(providerName: string, config: ProviderConfigInput): void;
  registerProvider(provider: Provider): void;
  registerProvider(providerOrName: Provider | string, config?: ProviderConfigInput): void {
    const id = typeof providerOrName === "string" ? providerOrName : providerOrName.id;
    if (id.trim() === "") throw new Error("Provider registration needs a non-empty id");
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
    if (config === undefined) {
      throw new Error("A provider object is required when registration uses a string name");
    }
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
