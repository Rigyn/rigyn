import { isProxy } from "node:util/types";

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  AuthCheck,
  AuthInteraction,
  AuthResult,
  AuthType,
  Context,
  Credential,
  CredentialInfo,
  Model,
  ModelsApiStreamOptions,
  ModelsRefreshOptions,
  ModelsRefreshResult,
  ModelsSimpleStreamOptions,
  Provider,
  ProviderHeaders,
} from "@rigyn/models";

import { defaultSecretRedactor } from "../auth/redaction.js";
import { errorMessage } from "../core/errors.js";
import type { ExtensionProviderConfig } from "../extensions/model-boundary.js";
import type { ModelRuntime, ModelRuntimeAuthOverrides } from "./model-compat.js";

export type ProviderConfigInput = ExtensionProviderConfig;

export type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
  | { ok: false; error: string };

const MAX_AUTHENTICATION_ERROR_BYTES = 4_096;
const MAX_REGISTERED_SECRET_BYTES = 64 * 1_024;
const AUTHENTICATION_ERROR_TRUNCATION = "...";

function cleanHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const selected = Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null),
  );
  return Object.keys(selected).length === 0 ? undefined : selected;
}

function inputPrefix(value: string): string {
  let end = Math.min(value.length, MAX_AUTHENTICATION_ERROR_BYTES + MAX_REGISTERED_SECRET_BYTES);
  if (
    end < value.length
    && end > 0
    && /[\uD800-\uDBFF]/u.test(value[end - 1]!)
    && /[\uDC00-\uDFFF]/u.test(value[end]!)
  ) end -= 1;
  return value.slice(0, end);
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function authenticationError(error: unknown): string {
  let selected = error;
  if (typeof error === "object" && error !== null && !isProxy(error)) {
    const cause = Reflect.getOwnPropertyDescriptor(error, "cause");
    if (cause !== undefined && "value" in cause && cause.value !== undefined) selected = cause.value;
  }
  const source = errorMessage(selected);
  const retained = inputPrefix(source);
  const redacted = defaultSecretRedactor.redact(retained);
  const truncated = retained.length < source.length
    || Buffer.byteLength(redacted, "utf8") > MAX_AUTHENTICATION_ERROR_BYTES;
  if (!truncated) return redacted;
  return `${utf8Prefix(
    redacted,
    MAX_AUTHENTICATION_ERROR_BYTES - AUTHENTICATION_ERROR_TRUNCATION.length,
  )}${AUTHENTICATION_ERROR_TRUNCATION}`;
}

type CatalogCapability = Pick<ModelRuntime,
  | "getModels"
  | "getAvailableSnapshot"
  | "getModel"
  | "getProviders"
  | "getProvider"
  | "getError"
  | "refresh"
  | "refreshConfig"
>;

type AuthenticationCapability = Pick<ModelRuntime,
  | "checkAuth"
  | "hasConfiguredAuth"
  | "isUsingOAuth"
  | "getProviderAuthStatus"
  | "getCompatibilityRequestConfig"
  | "getAuth"
  | "setRuntimeApiKey"
  | "removeRuntimeApiKey"
  | "listCredentials"
  | "login"
  | "logout"
>;

type ProviderCapability = Pick<ModelRuntime,
  | "getRegisteredProviderConfig"
  | "getRegisteredProviderIds"
  | "getRegisteredNativeProvider"
  | "registerProvider"
  | "registerNativeProvider"
  | "unregisterProvider"
>;

type GenerationCapability = Pick<ModelRuntime,
  | "stream"
  | "complete"
  | "streamSimple"
  | "completeSimple"
>;

type LifecycleCapability = Pick<ModelRuntime, "close" | "internalRegistry" | "models">;

/**
 * Synchronous catalog view over the public model runtime.
 *
 * Catalog reads intentionally return the latest completed runtime snapshot;
 * call `refresh()` when a caller needs a newer provider or authentication view.
 */
export class ModelRegistry {
  readonly #catalog: CatalogCapability;
  readonly #authentication: AuthenticationCapability;
  readonly #providers: ProviderCapability;
  readonly #generation: GenerationCapability;
  readonly #lifecycle: LifecycleCapability;

  constructor(runtime: ModelRuntime) {
    this.#catalog = runtime;
    this.#authentication = runtime;
    this.#providers = runtime;
    this.#generation = runtime;
    this.#lifecycle = runtime;
  }

  getAll(): Model<Api>[] { return [...this.#catalog.getModels()]; }
  getModels(providerId?: string): readonly Model<Api>[] { return [...this.#catalog.getModels(providerId)]; }
  getAvailable(): Model<Api>[] { return [...this.#catalog.getAvailableSnapshot()]; }
  getAvailableSnapshot(): readonly Model<Api>[] { return [...this.#catalog.getAvailableSnapshot()]; }
  find(providerId: string, modelId: string): Model<Api> | undefined {
    return this.#catalog.getModel(providerId, modelId);
  }
  getModel(providerId: string, modelId: string): Model<Api> | undefined {
    return this.#catalog.getModel(providerId, modelId);
  }
  getProviders(): readonly Provider[] { return [...this.#catalog.getProviders()]; }
  getProvider(providerId: string): Provider | undefined { return this.#catalog.getProvider(providerId); }
  getProviderDisplayName(providerId: string): string {
    return this.#catalog.getProvider(providerId)?.name ?? providerId;
  }
  getError(): string | undefined { return this.#catalog.getError(); }
  refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
    return this.#catalog.refresh(options);
  }
  refreshConfig(): Promise<void> { return this.#catalog.refreshConfig(); }

  checkAuth(providerId: string): Promise<AuthCheck | undefined> {
    return this.#authentication.checkAuth(providerId);
  }
  hasConfiguredAuth(providerOrModel: string | Model<Api>): boolean {
    return this.#authentication.hasConfiguredAuth(providerOrModel);
  }
  isUsingOAuth(providerOrModel: string | Model<Api>): boolean {
    return this.#authentication.isUsingOAuth(providerOrModel);
  }
  getProviderAuthStatus(providerId: string): ReturnType<ModelRuntime["getProviderAuthStatus"]> {
    return this.#authentication.getProviderAuthStatus(providerId);
  }
  getCompatibilityRequestConfig(model: Model<Api>): { headers?: ProviderHeaders; authHeader: boolean } {
    return this.#authentication.getCompatibilityRequestConfig(model);
  }
  getAuth(model: Model<Api>, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
  getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
  getAuth(
    providerOrModel: string | Model<Api>,
    overrides?: ModelRuntimeAuthOverrides,
  ): Promise<AuthResult | undefined> {
    return typeof providerOrModel === "string"
      ? this.#authentication.getAuth(providerOrModel, overrides)
      : this.#authentication.getAuth(providerOrModel, overrides);
  }
  async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
    try {
      const result = await this.#authentication.getAuth(model);
      if (result !== undefined) {
        const headers = cleanHeaders(result.auth.headers);
        return {
          ok: true,
          ...(result.auth.apiKey === undefined ? {} : { apiKey: result.auth.apiKey }),
          ...(headers === undefined ? {} : { headers }),
          ...(result.env === undefined ? {} : { env: result.env }),
        };
      }
      const fallback = this.#authentication.getCompatibilityRequestConfig(model);
      if (fallback.authHeader) return { ok: false, error: `No API key found for ${model.provider}` };
      const headers = cleanHeaders(fallback.headers);
      return { ok: true, ...(headers === undefined ? {} : { headers }) };
    } catch (error) {
      return { ok: false, error: authenticationError(error) };
    }
  }
  setRuntimeApiKey(providerId: string, apiKey: string, options?: ModelsRefreshOptions): Promise<void> {
    return this.#authentication.setRuntimeApiKey(providerId, apiKey, options);
  }
  removeRuntimeApiKey(providerId: string): Promise<void> {
    return this.#authentication.removeRuntimeApiKey(providerId);
  }
  listCredentials(): Promise<readonly CredentialInfo[]> { return this.#authentication.listCredentials(); }
  login(providerId: string, type: AuthType | "provider_account", interaction: AuthInteraction): Promise<Credential> {
    return this.#authentication.login(providerId, type, interaction);
  }
  logout(providerId: string): Promise<void> { return this.#authentication.logout(providerId); }

  getRegisteredProviderConfig(providerId: string): ExtensionProviderConfig | undefined {
    return this.#providers.getRegisteredProviderConfig(providerId);
  }
  getRegisteredProviderIds(): readonly string[] { return [...this.#providers.getRegisteredProviderIds()]; }
  getRegisteredNativeProvider(providerId: string): Provider | undefined {
    return this.#providers.getRegisteredNativeProvider(providerId);
  }
  registerProvider(provider: Provider): void;
  registerProvider(providerId: string, config: ExtensionProviderConfig): void;
  registerProvider(providerOrId: Provider | string, config?: ExtensionProviderConfig): void {
    if (typeof providerOrId !== "string") {
      this.#providers.registerNativeProvider(providerOrId);
      return;
    }
    if (config === undefined) throw new Error("Provider configuration is required");
    this.#providers.registerProvider(providerOrId, config);
  }
  registerNativeProvider(provider: Provider): void { this.#providers.registerNativeProvider(provider); }
  unregisterProvider(providerId: string): void { this.#providers.unregisterProvider(providerId); }

  stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ): AssistantMessageEventStream {
    return this.#generation.stream(model, context, options);
  }
  complete<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ): Promise<AssistantMessage> {
    return this.#generation.complete(model, context, options);
  }
  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): AssistantMessageEventStream {
    return this.#generation.streamSimple(model, context, options);
  }
  completeSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): Promise<AssistantMessage> {
    return this.#generation.completeSimple(model, context, options);
  }

  close(): Promise<void> { return this.#lifecycle.close(); }
  internalRegistry(): ReturnType<ModelRuntime["internalRegistry"]> { return this.#lifecycle.internalRegistry(); }
  models(): ReturnType<ModelRuntime["models"]> { return this.#lifecycle.models(); }
  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}
