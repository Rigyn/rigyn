import { CredentialBroker, EnvironmentCredentialSource } from "../auth/broker.js";
import { defaultSecretRedactor } from "../auth/redaction.js";
import type { ResolvedCredential } from "../auth/types.js";
import {
  createModels,
  defaultProviderAuthContext,
  ProviderModelsError,
  type MutableModels,
  type Provider,
  type ProviderAuth,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderCredentialStore,
} from "../providers/models.js";
import type {
  AssistantImages,
  ImagesApi,
  ImagesAuthResult,
  ImagesContext,
  ImagesFunction,
  ImagesModel,
  ImagesOptions,
  ImagesProviderId,
  ProviderImages,
} from "./types.js";

export type ImagesModelsErrorCode = "auth" | "model_source" | "oauth" | "provider";

export class ImagesModelsError extends Error {
  readonly code: ImagesModelsErrorCode;

  constructor(code: ImagesModelsErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImagesModelsError";
    this.code = code;
  }
}

export interface LegacyImagesProviderAuth {
  /** Credential-broker provider id. Defaults to the image provider id. */
  provider?: string;
  /** Request-scoped environment overrides checked before the broker. */
  environmentVariables?: readonly string[];
}

/** Image providers use the same request-auth contract as text providers. */
export type ImagesProviderAuth = ProviderAuth | LegacyImagesProviderAuth;

export interface ImagesProvider {
  readonly id: ImagesProviderId;
  readonly name: string;
  readonly auth: ImagesProviderAuth;
  getModels(): readonly ImagesModel<ImagesApi>[];
  refreshModels?(): Promise<void>;
  generateImages(
    model: ImagesModel<ImagesApi>,
    context: ImagesContext,
    options?: ImagesOptions,
  ): Promise<AssistantImages>;
}

export interface ImagesAuthOverrides {
  apiKey?: string;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface ImagesCredentialResolver {
  resolve(request: { provider: string; signal?: AbortSignal }): Promise<ResolvedCredential | undefined>;
}

export interface CreateImagesModelsOptions {
  credentials?: ProviderCredentialStore;
  authContext?: ProviderAuthContext;
  /** @deprecated Compatibility bridge for hosts using the legacy credential broker. */
  credentialBroker?: ImagesCredentialResolver;
  /** @deprecated Prefer authContext for deterministic environment access. */
  environment?: NodeJS.ProcessEnv;
}

export interface ImagesModels {
  getProviders(): readonly ImagesProvider[];
  getProvider(id: string): ImagesProvider | undefined;
  getModels(provider?: string): readonly ImagesModel<ImagesApi>[];
  getModel(provider: string, id: string): ImagesModel<ImagesApi> | undefined;
  refresh(provider?: string): Promise<void>;
  getAuth(providerId: string, overrides?: ImagesAuthOverrides): Promise<ImagesAuthResult | undefined>;
  getAuth(model: ImagesModel<ImagesApi>, overrides?: ImagesAuthOverrides): Promise<ImagesAuthResult | undefined>;
  generateImages(
    model: ImagesModel<ImagesApi>,
    context: ImagesContext,
    options?: ImagesOptions,
  ): Promise<AssistantImages>;
}

export interface MutableImagesModels extends ImagesModels {
  setProvider(provider: ImagesProvider): void;
  deleteProvider(id: string): void;
  clearProviders(): void;
}

class ImagesModelsCollection implements MutableImagesModels {
  readonly #providers = new Map<string, ImagesProvider>();
  readonly #authModels: MutableModels;
  readonly #broker: ImagesCredentialResolver;

  constructor(options?: CreateImagesModelsOptions) {
    const authContext = options?.authContext ?? (
      options?.environment === undefined
        ? undefined
        : defaultProviderAuthContext(options.environment)
    );
    this.#authModels = createModels({
      ...(options?.credentials === undefined ? {} : { credentials: options.credentials }),
      ...(authContext === undefined ? {} : { authContext }),
    });
    this.#broker = options?.credentialBroker ?? new CredentialBroker([
      new EnvironmentCredentialSource(options?.environment === undefined ? {} : { environment: options.environment }),
    ]);
  }

  setProvider(provider: ImagesProvider): void {
    this.#providers.set(provider.id, provider);
    if (isDirectProviderAuth(provider.auth)) {
      this.#authModels.setProvider(authOnlyProvider(provider));
    } else {
      this.#authModels.deleteProvider(provider.id);
    }
  }

  deleteProvider(id: string): void {
    this.#providers.delete(id);
    this.#authModels.deleteProvider(id);
  }

  clearProviders(): void {
    this.#providers.clear();
    this.#authModels.clearProviders();
  }

  getProviders(): readonly ImagesProvider[] {
    return [...this.#providers.values()];
  }

  getProvider(id: string): ImagesProvider | undefined {
    return this.#providers.get(id);
  }

  getModels(provider?: string): readonly ImagesModel<ImagesApi>[] {
    if (provider !== undefined) {
      const entry = this.#providers.get(provider);
      if (entry === undefined) return [];
      try {
        return entry.getModels();
      } catch {
        return [];
      }
    }

    const models: ImagesModel<ImagesApi>[] = [];
    for (const entry of this.#providers.values()) {
      try {
        models.push(...entry.getModels());
      } catch {
        // One faulty provider must not make the catalog unreadable.
      }
    }
    return models;
  }

  getModel(provider: string, id: string): ImagesModel<ImagesApi> | undefined {
    return this.getModels(provider).find((model) => model.id === id);
  }

  async refresh(provider?: string): Promise<void> {
    if (provider !== undefined) {
      const entry = this.#providers.get(provider);
      if (entry?.refreshModels === undefined) return;
      try {
        await entry.refreshModels();
      } catch (error) {
        if (error instanceof ImagesModelsError) throw error;
        throw new ImagesModelsError("model_source", `Image model refresh failed for ${provider}`, { cause: error });
      }
      return;
    }
    await Promise.allSettled([...this.#providers.values()].map(async (entry) => entry.refreshModels?.()));
  }

  getAuth(providerId: string, overrides?: ImagesAuthOverrides): Promise<ImagesAuthResult | undefined>;
  getAuth(model: ImagesModel<ImagesApi>, overrides?: ImagesAuthOverrides): Promise<ImagesAuthResult | undefined>;
  async getAuth(
    providerOrModel: string | ImagesModel<ImagesApi>,
    overrides?: ImagesAuthOverrides,
  ): Promise<ImagesAuthResult | undefined> {
    const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
    const provider = this.#providers.get(providerId);
    if (provider === undefined) return undefined;
    overrides?.signal?.throwIfAborted();

    if (isDirectProviderAuth(provider.auth)) {
      try {
        const resolved = await this.#authModels.getAuth(providerId, {
          ...(overrides?.apiKey === undefined ? {} : { apiKey: overrides.apiKey }),
          ...(overrides?.env === undefined ? {} : { env: { ...overrides.env } }),
        });
        return resolved === undefined ? undefined : imageAuthResult(provider.id, resolved);
      } catch (error) {
        if (error instanceof ProviderModelsError) {
          throw new ImagesModelsError(
            error.code === "oauth" ? "oauth" : "auth",
            error.message,
            { cause: error },
          );
        }
        throw new ImagesModelsError("auth", `Image provider authentication failed for ${provider.id}`, { cause: error });
      }
    }

    if (overrides?.apiKey !== undefined && overrides.apiKey !== "") {
      defaultSecretRedactor.register(overrides.apiKey);
      return {
        auth: { apiKey: overrides.apiKey },
        provider: provider.auth.provider ?? provider.id,
        source: "request",
        credentialKind: "api_key",
        apiKey: overrides.apiKey,
      };
    }

    for (const variable of provider.auth.environmentVariables ?? []) {
      const key = overrides?.env?.[variable];
      if (key !== undefined && key !== "") {
        defaultSecretRedactor.register(key);
        return {
          auth: { apiKey: key },
          provider: provider.auth.provider ?? provider.id,
          source: variable,
          credentialKind: "api_key",
          apiKey: key,
        };
      }
    }

    try {
      const request = overrides?.signal === undefined
        ? { provider: provider.auth.provider ?? provider.id }
        : { provider: provider.auth.provider ?? provider.id, signal: overrides.signal };
      const resolved = await this.#broker.resolve(request);
      if (resolved === undefined) return undefined;
      const apiKey = credentialToken(resolved);
      defaultSecretRedactor.register(apiKey);
      return {
        auth: apiKey === undefined ? {} : { apiKey },
        provider: resolved.credential.provider,
        source: resolved.source,
        credentialKind: resolved.credential.kind,
        ...(apiKey === undefined ? {} : { apiKey }),
      };
    } catch (error) {
      throw new ImagesModelsError("auth", `Image provider authentication failed for ${provider.id}`, { cause: error });
    }
  }

  async generateImages(
    model: ImagesModel<ImagesApi>,
    context: ImagesContext,
    options?: ImagesOptions,
  ): Promise<AssistantImages> {
    try {
      const provider = this.#providers.get(model.provider);
      if (provider === undefined) {
        throw new ImagesModelsError("provider", `Unknown image provider: ${model.provider}`);
      }
      const auth = await this.getAuth(model, {
        ...(options?.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        ...(options?.env === undefined ? {} : { env: options.env }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      if (auth === undefined) return await provider.generateImages(model, context, options);
      const requestModel = auth.auth.baseUrl === undefined
        ? model
        : { ...model, baseUrl: auth.auth.baseUrl };
      const apiKey = options?.apiKey ?? auth.auth.apiKey;
      const headers = mergeHeaders(auth.auth.headers, options?.headers);
      const env = auth.env === undefined && options?.env === undefined
        ? undefined
        : { ...auth.env, ...options?.env };
      return await provider.generateImages(requestModel, context, {
        ...options,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(headers === undefined ? {} : { headers }),
        ...(env === undefined ? {} : { env }),
      });
    } catch (error) {
      return imageErrorResult(model, error, options?.signal);
    }
  }
}

function isDirectProviderAuth(auth: ImagesProviderAuth): auth is ProviderAuth {
  return "apiKey" in auth || "oauth" in auth;
}

function authOnlyProvider(provider: ImagesProvider): Provider {
  if (!isDirectProviderAuth(provider.auth)) throw new TypeError("Expected direct provider auth");
  return {
    id: provider.id,
    name: provider.name,
    auth: provider.auth,
    getModels: () => [],
    stream: emptyProviderStream,
    streamSimple: emptyProviderStream,
  };
}

async function* emptyProviderStream(): AsyncIterable<never> {
  return;
}

function imageAuthResult(provider: string, result: ProviderAuthResult): ImagesAuthResult {
  return {
    ...result,
    provider,
    ...(result.auth.apiKey === undefined ? {} : { apiKey: result.auth.apiKey }),
  };
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

function credentialToken(resolved: ResolvedCredential): string | undefined {
  switch (resolved.credential.kind) {
    case "api_key":
      return resolved.credential.apiKey;
    case "bearer":
    case "oauth":
      return resolved.credential.accessToken;
    case "ambient":
      return undefined;
  }
}

export function imageErrorResult(
  model: ImagesModel<ImagesApi>,
  error: unknown,
  signal?: AbortSignal,
): AssistantImages {
  return {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: signal?.aborted === true ? "aborted" : "error",
    errorMessage: boundedImageErrorMessage(error instanceof Error ? error.message : String(error)),
    timestamp: Date.now(),
  };
}

function boundedImageErrorMessage(value: string): string {
  const normalized = defaultSecretRedactor.redact(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
  const bytes = Buffer.from(normalized, "utf8");
  return bytes.byteLength <= 4_096
    ? normalized
    : `${bytes.subarray(0, 4_096).toString("utf8")}…`;
}

export function createImagesModels(options?: CreateImagesModelsOptions): MutableImagesModels {
  return new ImagesModelsCollection(options);
}

export interface CreateImagesProviderOptions {
  id: ImagesProviderId;
  name?: string;
  auth: ImagesProviderAuth;
  models: readonly ImagesModel<ImagesApi>[];
  refreshModels?: () => Promise<readonly ImagesModel<ImagesApi>[]>;
  api: ProviderImages | { generateImages: ImagesFunction };
}

/** Creates a provider whose dynamic model refreshes preserve the last successful catalog. */
export function createImagesProvider(input: CreateImagesProviderOptions): ImagesProvider {
  let models = [...input.models];
  let inFlight: Promise<void> | undefined;
  const refresh = input.refreshModels;
  return {
    id: input.id,
    name: input.name ?? input.id,
    auth: input.auth,
    getModels: () => models,
    ...(refresh === undefined ? {} : {
      refreshModels: (): Promise<void> => {
        inFlight ??= (async () => {
          try {
            models = [...await refresh()];
          } finally {
            inFlight = undefined;
          }
        })();
        return inFlight;
      },
    }),
    generateImages: (model, context, options) => input.api.generateImages(model, context, options),
  };
}
