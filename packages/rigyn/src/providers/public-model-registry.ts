import type { Api, AuthResult, Model, Provider } from "@rigyn/models";

import type {
  ExtensionProviderConfig as ProviderConfigInput,
} from "../extensions/model-boundary.js";
import type { ProviderAuthStatus } from "./model-registry.js";
import type { ModelRegistry as InternalModelRegistry } from "./model-registry.js";
import type { ModelRuntime } from "./model-compat.js";

export type { ExtensionProviderConfig as ProviderConfigInput } from "../extensions/model-boundary.js";

export type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
  | { ok: false; error: string };

function usableHeaders(
  headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const selected = Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null),
  );
  return Object.keys(selected).length === 0 ? undefined : selected;
}

const publicRegistryRuntimes = new WeakMap<object, ModelRuntime>();

/** Synchronous extension-facing view over the canonical asynchronous model runtime. */
export class ModelRegistry {
  readonly #runtime: ModelRuntime;

  constructor(runtime: ModelRuntime) {
    this.#runtime = runtime;
    publicRegistryRuntimes.set(this, runtime);
  }

  async refresh(): Promise<void> { await this.#runtime.reloadConfig(); }
  getError(): string | undefined { return this.#runtime.getError(); }
  getAll(): Model<Api>[] { return [...this.#runtime.getModels()]; }
  getAvailable(): Model<Api>[] { return [...this.#runtime.getAvailableSnapshot()]; }
  find(provider: string, modelId: string): Model<Api> | undefined {
    return this.#runtime.getModel(provider, modelId);
  }

  hasConfiguredAuth(model: Model<Api>): boolean {
    return this.#runtime.hasConfiguredAuth(model.provider);
  }

  async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
    try {
      const resolution = await this.#runtime.getAuth(model);
      if (resolution === undefined) {
        const compatibility = this.#runtime.getCompatibilityRequestConfig(model);
        if (compatibility.authHeader) {
          return { ok: false, error: `No API key found for "${model.provider}"` };
        }
        const headers = usableHeaders(compatibility.headers);
        return { ok: true, ...(headers === undefined ? {} : { headers }) };
      }
      const headers = usableHeaders(resolution.auth.headers);
      return {
        ok: true,
        ...(resolution.auth.apiKey === undefined ? {} : { apiKey: resolution.auth.apiKey }),
        ...(headers === undefined ? {} : { headers }),
        ...(resolution.env === undefined ? {} : { env: resolution.env }),
      };
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      const message = cause instanceof Error
        ? cause.message
        : error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: message === "authHeader requires a resolved API key"
          ? `No API key found for "${model.provider}"`
          : message,
      };
    }
  }

  getProviderAuthStatus(provider: string): ProviderAuthStatus {
    return this.#runtime.getProviderAuthStatus(provider);
  }

  getProvider(provider: string): Provider | undefined { return this.#runtime.getProvider(provider); }
  getProviderDisplayName(provider: string): string { return this.#runtime.getProvider(provider)?.name ?? provider; }
  getProviderAuth(provider: string): Promise<AuthResult | undefined> { return this.#runtime.getAuth(provider); }

  async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    try {
      return (await this.#runtime.getAuth(provider))?.auth.apiKey;
    } catch {
      return undefined;
    }
  }

  isUsingOAuth(model: Model<Api>): boolean { return this.#runtime.isUsingOAuth(model.provider); }

  registerProvider(provider: Provider): void;
  registerProvider(providerName: string, config: ProviderConfigInput): void;
  registerProvider(providerOrName: Provider | string, config?: ProviderConfigInput): void {
    if (typeof providerOrName === "string") {
      if (config === undefined) throw new Error("Provider config is required when registering by name");
      this.#runtime.registerProvider(providerOrName, config);
      return;
    }
    this.#runtime.registerNativeProvider(providerOrName);
  }

  unregisterProvider(providerName: string): void { this.#runtime.unregisterProvider(providerName); }
  getRegisteredProviderConfig(providerName: string): ProviderConfigInput | undefined {
    return this.#runtime.getRegisteredProviderConfig(providerName);
  }
  getRegisteredNativeProvider(providerName: string): Provider | undefined {
    return this.#runtime.getRegisteredNativeProvider(providerName);
  }
  getRegisteredProviderIds(): readonly string[] { return this.#runtime.getRegisteredProviderIds(); }

}

/** @internal Bridge used by the SDK without making its implementation registry public. */
export function unwrapPublicModelRegistry(registry: ModelRegistry): InternalModelRegistry {
  const runtime = publicRegistryRuntimes.get(registry);
  if (runtime === undefined) throw new TypeError("ModelRegistry was not created by this Rigyn runtime");
  return runtime.internalRegistry();
}
