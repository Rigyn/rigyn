import { isProxy } from "node:util/types";

import type { ResolvedCredential } from "../auth/types.js";
import type {
  AssistantImages,
  ImagesApi,
  ImagesContext,
  ImagesModel,
  ImagesOptions,
  ProviderImages,
} from "./types.js";

export type ImagesModelsErrorCode = "model_source" | "provider" | "auth";

export class ImagesModelsError extends Error {
  constructor(readonly code: ImagesModelsErrorCode, message: string) {
    super(message);
    this.name = "ImagesModelsError";
  }
}

export interface ImagesEnvironment {
  env(name: string): Promise<string | undefined>;
  fileExists(path: string): Promise<boolean>;
}

export interface ImagesAuthOverrides {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface ImagesAuthResult {
  auth: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> };
  env?: NodeJS.ProcessEnv;
  source?: string;
  apiKey?: string;
  credentialKind?: string;
}

export interface ImagesCredentialResolver {
  resolve(request: { provider: string; signal?: AbortSignal }): Promise<ResolvedCredential | undefined>;
}

export interface ImagesProviderAuth {
  provider?: string;
  environmentVariables?: string[];
  apiKey?: {
    name?: string;
    resolve(input: {
      ctx: ImagesEnvironment;
      credential?: { key: string; kind: string };
      signal?: AbortSignal;
    }): Promise<ImagesAuthResult | undefined>;
  };
}

export interface ImagesProvider<TApi extends ImagesApi = ImagesApi> {
  id: string;
  name: string;
  auth: ImagesProviderAuth;
  getModels(): ImagesModel<TApi>[];
  refreshModels?(): Promise<ImagesModel<TApi>[]>;
  generateImages(model: ImagesModel<TApi>, context: ImagesContext, options?: ImagesOptions): Promise<AssistantImages>;
}

export interface CreateImagesProviderOptions<TApi extends ImagesApi = ImagesApi> {
  id: string;
  name?: string;
  auth: ImagesProviderAuth;
  models: readonly ImagesModel<TApi>[];
  refreshModels?: () => Promise<ImagesModel<TApi>[]>;
  api: ProviderImages<TApi>;
}

export interface CreateImagesModelsOptions {
  environment?: NodeJS.ProcessEnv;
  credentialBroker?: ImagesCredentialResolver;
  authContext?: ImagesEnvironment;
}

export interface ImagesModels {
  getProviders(): ImagesProvider[];
  getProvider(id: string): ImagesProvider | undefined;
  getModels(provider?: string): ImagesModel[];
  getModel(provider: string, id: string): ImagesModel | undefined;
  getAuth(modelOrProvider: ImagesModel | string, overrides?: ImagesAuthOverrides): Promise<ImagesAuthResult | undefined>;
  generateImages(model: ImagesModel, context: ImagesContext, options?: ImagesOptions): Promise<AssistantImages>;
  refresh(provider?: string): Promise<void>;
}

export interface MutableImagesModels extends ImagesModels {
  setProvider(provider: ImagesProvider): void;
  deleteProvider(id: string): void;
  clearProviders(): void;
}

function safeThrown(value: unknown): string {
  if (isProxy(value)) return "[Thrown object]";
  const isError = (Error as ErrorConstructor & { isError?: (candidate: unknown) => boolean }).isError;
  if (isError?.(value) === true) {
    const descriptor = Object.getOwnPropertyDescriptor(value, "message");
    return typeof descriptor?.value === "string" ? descriptor.value : "Error";
  }
  if (typeof value === "string") return value;
  if (value === null || ["number", "boolean", "bigint", "undefined"].includes(typeof value)) return String(value);
  return "[Thrown object]";
}

export function imageErrorResult(
  model: ImagesModel,
  error: unknown,
  signal?: AbortSignal,
): AssistantImages {
  const aborted = signal?.aborted === true;
  return {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: aborted ? "aborted" : "error",
    timestamp: Date.now(),
    errorMessage: aborted ? "Request cancelled" : safeThrown(error),
  };
}

export function createImagesProvider<TApi extends ImagesApi>(
  options: CreateImagesProviderOptions<TApi>,
): ImagesProvider<TApi> {
  let models = options.models.map((model) => ({ ...model }));
  return {
    id: options.id,
    name: options.name ?? options.id,
    auth: options.auth,
    getModels: () => models.map((model) => ({ ...model })),
    ...(options.refreshModels === undefined ? {} : {
      async refreshModels() {
        const refreshed = await options.refreshModels!();
        models = refreshed.map((model) => ({ ...model }));
        return models.map((model) => ({ ...model }));
      },
    }),
    async generateImages(model, context, request) {
      return await options.api.generateImages(model, context, request);
    },
  };
}

function secret(value: string, label: string): string {
  if (value.length < 4) throw new Error(`${label} must contain at least 4 characters`);
  return value;
}

function credentialKey(resolved: ResolvedCredential | undefined): { key: string; kind: string } | undefined {
  const credential = resolved?.credential;
  if (credential === undefined || credential.kind === "ambient") return undefined;
  if (credential.kind === "api_key") return credential.apiKey === undefined ? undefined : { key: credential.apiKey, kind: credential.kind };
  return { key: credential.accessToken, kind: credential.kind };
}

function mergeHeaders(base: Record<string, string> | undefined, overlay: ImagesOptions["headers"]): Record<string, string> | undefined {
  const entries = new Map<string, { name: string; value: string }>();
  for (const [name, value] of Object.entries(base ?? {})) entries.set(name.toLowerCase(), { name, value });
  for (const [name, value] of Object.entries(overlay ?? {})) {
    if (value === null) entries.delete(name.toLowerCase());
    else entries.set(name.toLowerCase(), { name, value });
  }
  return entries.size === 0 ? undefined : Object.fromEntries([...entries.values()].map(({ name, value }) => [name, value]));
}

export function createImagesModels(options: CreateImagesModelsOptions = {}): MutableImagesModels {
  const providers = new Map<string, ImagesProvider>();
  const refreshes = new Map<string, Promise<void>>();
  const environment = options.environment ?? process.env;
  const authContext: ImagesEnvironment = options.authContext ?? {
    env: async (name) => environment[name],
    fileExists: async () => false,
  };

  const registry: MutableImagesModels = {
    getProviders: () => [...providers.values()],
    getProvider: (id) => providers.get(id),
    getModels(provider) {
      const selected = provider === undefined ? [...providers.values()] : [providers.get(provider)].filter((value): value is ImagesProvider => value !== undefined);
      return selected.flatMap((entry) => { try { return entry.getModels(); } catch { return []; } });
    },
    getModel(provider, id) { return registry.getModels(provider).find((model) => model.id === id); },
    async getAuth(modelOrProvider, overrides = {}) {
      overrides.signal?.throwIfAborted();
      const providerId = typeof modelOrProvider === "string" ? modelOrProvider : modelOrProvider.provider;
      const provider = providers.get(providerId);
      if (provider === undefined) return undefined;
      const requested = overrides.apiKey;
      const brokerId = provider.auth.provider ?? provider.id;
      const resolved = await options.credentialBroker?.resolve({ provider: brokerId, ...(overrides.signal === undefined ? {} : { signal: overrides.signal }) });
      const stored = credentialKey(resolved);
      if (provider.auth.apiKey !== undefined) {
        const context = overrides.env === undefined ? authContext : {
          ...authContext,
          env: async (name: string) => overrides.env?.[name] ?? await authContext.env(name),
        };
        const result = await provider.auth.apiKey.resolve({ ctx: context, ...(stored === undefined ? {} : { credential: stored }), ...(overrides.signal === undefined ? {} : { signal: overrides.signal }) });
        if (result === undefined && requested === undefined) return undefined;
        const apiKey = requested ?? result?.auth.apiKey;
        if (apiKey !== undefined) secret(apiKey, "Image API key");
        return {
          ...(result ?? { auth: {} }),
          auth: { ...(result?.auth ?? {}), ...(apiKey === undefined ? {} : { apiKey }) },
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(requested === undefined ? {} : { source: "request" }),
          ...(stored === undefined ? {} : { credentialKind: stored.kind }),
        };
      }
      if (requested !== undefined) {
        const apiKey = secret(requested, "Image API key");
        return { auth: { apiKey }, apiKey, source: "request" };
      }
      for (const name of provider.auth.environmentVariables ?? []) {
        const value = overrides.env?.[name] ?? environment[name];
        if (value !== undefined && value !== "") {
          const apiKey = secret(value, `Image credential ${name}`);
          return { auth: { apiKey }, apiKey, source: name };
        }
      }
      if (stored === undefined) return undefined;
      const apiKey = secret(stored.key, "Image API key");
      return {
        auth: { apiKey },
        apiKey,
        credentialKind: stored.kind,
        ...(resolved?.source === undefined ? {} : { source: resolved.source }),
      };
    },
    async generateImages(model, context, request = {}) {
      const provider = providers.get(model.provider);
      if (provider === undefined) return imageErrorResult(model, new Error(`Unknown image provider: ${model.provider}`), request.signal);
      try {
        const authorization = await registry.getAuth(model, request);
        const selectedModel = authorization?.auth.baseUrl === undefined ? model : { ...model, baseUrl: authorization.auth.baseUrl };
        const headers = mergeHeaders(authorization?.auth.headers, request.headers);
        const env = { ...(authorization?.env ?? {}), ...(request.env ?? {}) };
        return await provider.generateImages(selectedModel, context, {
          ...request,
          ...(authorization?.apiKey === undefined ? {} : { apiKey: request.apiKey ?? authorization.apiKey }),
          ...(headers === undefined ? {} : { headers }),
          ...(Object.keys(env).length === 0 ? {} : { env }),
        });
      } catch (error) { return imageErrorResult(model, error, request.signal); }
    },
    async refresh(provider) {
      const refreshOne = (id: string): Promise<void> => {
        const current = refreshes.get(id);
        if (current !== undefined) return current;
        const entry = providers.get(id);
        if (entry?.refreshModels === undefined) return Promise.resolve();
        const pending = (async () => {
          try { await entry.refreshModels!(); }
          catch { throw new ImagesModelsError("model_source", `Image model refresh failed for ${id}`); }
          finally { refreshes.delete(id); }
        })();
        refreshes.set(id, pending);
        return pending;
      };
      if (provider !== undefined) return await refreshOne(provider);
      await Promise.allSettled([...providers.keys()].map(refreshOne));
    },
    setProvider(provider) { providers.set(provider.id, provider); },
    deleteProvider(id) { providers.delete(id); },
    clearProviders() { providers.clear(); },
  };
  return registry;
}
