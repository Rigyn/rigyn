import { defaultProviderAuthContext } from "./auth/context.js";
import { InMemoryCredentialStore } from "./auth/credential-store.js";
import { ModelsError, resolveProviderAuth, type AuthResolutionOverrides } from "./auth/resolve.js";
import type { AuthContext, AuthResult, CredentialStore, ProviderAuth } from "./auth/types.js";
import type { CreateModelsOptions } from "./models.js";
import type { AssistantImages, ImagesApi, ImagesContext, ImagesModel, ImagesOptions, ProviderHeaders, ProviderImages } from "./types.js";

export interface ImagesProvider {
  readonly id: string;
  readonly name: string;
  readonly auth: ProviderAuth;
  getModels(): readonly ImagesModel<ImagesApi>[];
  refreshModels?(): Promise<void>;
  generateImages(model: ImagesModel<ImagesApi>, context: ImagesContext, options?: ImagesOptions): Promise<AssistantImages>;
}

export interface ImagesModels {
  getProviders(): readonly ImagesProvider[];
  getProvider(id: string): ImagesProvider | undefined;
  getModels(provider?: string): readonly ImagesModel<ImagesApi>[];
  getModel(provider: string, id: string): ImagesModel<ImagesApi> | undefined;
  refresh(provider?: string): Promise<void>;
  getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
  getAuth(model: ImagesModel<ImagesApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
  generateImages(model: ImagesModel<ImagesApi>, context: ImagesContext, options?: ImagesOptions): Promise<AssistantImages>;
}
export interface MutableImagesModels extends ImagesModels { setProvider(provider: ImagesProvider): void; deleteProvider(id: string): void; clearProviders(): void; }

function mergeHeaders(base?: ProviderHeaders, override?: ProviderHeaders): ProviderHeaders | undefined {
  if (base === undefined && override === undefined) return undefined;
  const result: ProviderHeaders = { ...base };
  for (const [name, value] of Object.entries(override ?? {})) {
    for (const existing of Object.keys(result)) if (existing.toLowerCase() === name.toLowerCase()) delete result[existing];
    result[name] = value;
  }
  return result;
}

class ImagesCollection implements MutableImagesModels {
  readonly #providers = new Map<string, ImagesProvider>();
  readonly #credentials: CredentialStore;
  readonly #authContext: AuthContext;
  constructor(options: CreateModelsOptions = {}) {
    this.#credentials = options.credentials ?? new InMemoryCredentialStore();
    this.#authContext = options.authContext ?? defaultProviderAuthContext();
  }
  setProvider(provider: ImagesProvider): void { this.#providers.set(provider.id, provider); }
  deleteProvider(id: string): void { this.#providers.delete(id); }
  clearProviders(): void { this.#providers.clear(); }
  getProviders(): readonly ImagesProvider[] { return [...this.#providers.values()]; }
  getProvider(id: string): ImagesProvider | undefined { return this.#providers.get(id); }
  getModels(provider?: string): readonly ImagesModel<ImagesApi>[] {
    const providers = provider === undefined ? this.#providers.values() : [this.#providers.get(provider)].filter((entry): entry is ImagesProvider => entry !== undefined);
    const output: ImagesModel<ImagesApi>[] = [];
    for (const entry of providers) try { output.push(...entry.getModels()); } catch { /* catalog reads are best effort */ }
    return output;
  }
  getModel(provider: string, id: string): ImagesModel<ImagesApi> | undefined { return this.getModels(provider).find((model) => model.id === id); }
  async refresh(provider?: string): Promise<void> {
    if (provider === undefined) { await Promise.allSettled(this.getProviders().map((entry) => entry.refreshModels?.())); return; }
    const entry = this.#providers.get(provider);
    if (!entry?.refreshModels) return;
    try { await entry.refreshModels(); } catch (cause) { throw cause instanceof ModelsError ? cause : new ModelsError("model_source", `Image model refresh failed for ${provider}`, { cause }); }
  }
  getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
  getAuth(model: ImagesModel<ImagesApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
  async getAuth(providerOrModel: string | ImagesModel<ImagesApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined> {
    const provider = this.#providers.get(typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider);
    return provider === undefined ? undefined : resolveProviderAuth(provider, this.#credentials, this.#authContext, overrides);
  }
  async generateImages(model: ImagesModel<ImagesApi>, context: ImagesContext, options?: ImagesOptions): Promise<AssistantImages> {
    try {
      const provider = this.#providers.get(model.provider);
      if (provider === undefined) throw new ModelsError("provider", `Unknown image provider: ${model.provider}`);
      const resolution = await this.getAuth(model, { ...(options?.apiKey === undefined ? {} : { apiKey: options.apiKey }), ...(options?.env === undefined ? {} : { env: options.env }) });
      if (resolution === undefined) return provider.generateImages(model, context, options);
      const apiKey = options?.apiKey ?? resolution.auth.apiKey;
      const headers = mergeHeaders(resolution.auth.headers, options?.headers);
      const env = resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;
      return await provider.generateImages(resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model, context, { ...options, ...(apiKey === undefined ? {} : { apiKey }), ...(headers === undefined ? {} : { headers }), ...(env === undefined ? {} : { env }) });
    } catch (error) {
      return { api: model.api, provider: model.provider, model: model.id, output: [], stopReason: options?.signal?.aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now() };
    }
  }
}

export function createImagesModels(options?: CreateModelsOptions): MutableImagesModels { return new ImagesCollection(options); }

export interface CreateImagesProviderOptions {
  id: string; name?: string; auth: ProviderAuth; models: readonly ImagesModel<ImagesApi>[];
  refreshModels?: () => Promise<readonly ImagesModel<ImagesApi>[]>;
  api: ProviderImages;
}
export function createImagesProvider(input: CreateImagesProviderOptions): ImagesProvider {
  let models = [...input.models];
  let refresh: Promise<void> | undefined;
  return {
    id: input.id, name: input.name ?? input.id, auth: input.auth, getModels: () => models,
    ...(input.refreshModels === undefined ? {} : { refreshModels: () => {
      refresh ??= (async () => { try { models = [...await input.refreshModels!()]; } finally { refresh = undefined; } })();
      return refresh;
    } }),
    generateImages: (model, context, options) => input.api.generateImages(model, context, options),
  };
}
