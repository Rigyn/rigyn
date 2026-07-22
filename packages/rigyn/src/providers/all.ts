import {
  CredentialBroker,
  ExplicitCredentialSource,
} from "../auth/broker.js";
import type { AuthCredential } from "../auth/types.js";
import type {
  AdapterEvent,
  ProviderRequest,
} from "../core/types.js";
import { ProviderWireInterceptorRegistry } from "./wire.js";
import { BUILTIN_MODEL_CATALOG } from "./builtin-models.generated.js";
import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  environmentProviderAuth,
  type BuiltinProviderDescriptor,
} from "./builtins.js";
import {
  createModels,
  type CreateModelsOptions,
  type MutableModels,
  type Provider,
  type ProviderModel,
  type ProviderStreamContext,
  type ProviderStreamOptions,
} from "./models.js";

const modelsByProvider = new Map<string, readonly ProviderModel[]>();
for (const descriptor of BUILTIN_PROVIDER_DESCRIPTORS) modelsByProvider.set(descriptor.id, []);
for (const model of BUILTIN_MODEL_CATALOG) {
  const existing = modelsByProvider.get(model.provider) ?? [];
  modelsByProvider.set(model.provider, [...existing, model]);
}

const staticProviderIds = Object.freeze(
  [...modelsByProvider].filter(([, models]) => models.length > 0).map(([provider]) => provider),
);

/** Provider identities with entries in the synchronous built-in model catalog. */
export type BuiltinProvider = (typeof staticProviderIds)[number];

/** Read one model from the immutable built-in catalog. */
export function getBuiltinModel(provider: string, modelId: string): ProviderModel | undefined {
  return modelsByProvider.get(provider)?.find((model) => model.id === modelId);
}

/** Provider identities with entries in the synchronous built-in model catalog. */
export function getBuiltinProviders(): BuiltinProvider[] {
  return [...staticProviderIds];
}

/** Read all static models for one built-in provider. */
export function getBuiltinModels(provider: string): ProviderModel[] {
  return [...(modelsByProvider.get(provider) ?? [])];
}

function header(headers: Record<string, string | null> | undefined, name: string): string | undefined {
  const target = name.toLowerCase();
  return Object.entries(headers ?? {}).find(([key, value]) => key.toLowerCase() === target && value !== null)?.[1] ?? undefined;
}

function explicitCredential(
  provider: string,
  modelProvider: string,
  options: ProviderStreamOptions,
): AuthCredential | undefined {
  const authorization = header(options.headers, "authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
  const secret = options.apiKey ?? bearer;
  if (secret === undefined) return undefined;
  if (modelProvider === "openai-codex") {
    const accountId = header(options.headers, "chatgpt-account-id");
    return {
      kind: "oauth",
      provider,
      accessToken: secret,
      expiresAt: Date.now() + 60 * 60_000,
      tokenType: "Bearer",
      scopes: [],
      ...(accountId === undefined ? {} : { accountId }),
    };
  }
  if (modelProvider === "anthropic" && (bearer !== undefined || secret.startsWith("sk-ant-oat"))) {
    return {
      kind: "oauth",
      provider,
      accessToken: secret,
      expiresAt: Date.now() + 60 * 60_000,
      tokenType: "Bearer",
      scopes: [],
    };
  }
  return { kind: "api_key", provider, apiKey: secret };
}

function substituteEnvironment(value: string, environment: NodeJS.ProcessEnv): string {
  return value.replace(/\{([A-Z][A-Z0-9_]*)\}/gu, (_match, name: string) => environment[name] ?? `{${name}}`);
}

function materializeEnvironment<T>(value: T, environment: NodeJS.ProcessEnv): T {
  if (typeof value === "string") return substituteEnvironment(value, environment) as T;
  if (Array.isArray(value)) return value.map((entry) => materializeEnvironment(entry, environment)) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [name, materializeEnvironment(entry, environment)]),
  ) as T;
}

async function runtimeConfig(
  provider: string,
  model: ProviderModel,
  environment: NodeJS.ProcessEnv,
): Promise<import("../service/provider-factory.js").RuntimeProviderConfig> {
  const runtime = await import("../cli/runtime.js");
  const alias = provider === "amazon-bedrock" ? "bedrock" : provider === "google" ? "gemini" : provider;
  const configured = runtime.BUILTIN_PROVIDER_CONFIGS[alias];
  if (configured !== undefined) return materializeEnvironment(configured, environment);
  if (provider === "google-vertex") {
    const project = environment.GOOGLE_CLOUD_PROJECT ?? environment.GCLOUD_PROJECT;
    if (project === undefined || project.trim() === "") throw new Error("GOOGLE_CLOUD_PROJECT is required for Google Vertex AI");
    return {
      kind: "vertex",
      project,
      ...(environment.GOOGLE_CLOUD_LOCATION === undefined ? {} : { location: environment.GOOGLE_CLOUD_LOCATION }),
      ...(model.baseUrl === "" ? {} : { baseUrl: model.baseUrl }),
    };
  }
  if (provider === "azure-openai-responses") {
    const endpoint = environment.AZURE_OPENAI_ENDPOINT ?? model.baseUrl;
    if (endpoint === "") throw new Error("AZURE_OPENAI_ENDPOINT is required for Azure OpenAI");
    return { kind: "azure-openai", endpoint };
  }
  if (provider === "radius") {
    const gateway = environment.RADIUS_GATEWAY ?? model.baseUrl;
    if (gateway === "") throw new Error("RADIUS_GATEWAY is required for Radius");
    return {
      kind: "gateway-messages",
      id: "radius",
      gatewayUrl: /^https?:\/\//iu.test(gateway) ? gateway : `https://${gateway}`,
      managedOAuth: true,
    };
  }
  throw new Error(`No built-in transport configuration exists for ${provider}`);
}

function credentialProvider(
  config: import("../service/provider-factory.js").RuntimeProviderConfig,
  publicProvider: string,
): string {
  if (config.credentialProvider !== undefined) return config.credentialProvider;
  if (publicProvider === "amazon-bedrock") return "bedrock";
  if (publicProvider === "google") return "gemini";
  if (publicProvider === "google-vertex") return "vertex";
  if (publicProvider === "azure-openai-responses") return "azure-openai";
  return publicProvider;
}

async function* streamBuiltinModel(
  model: ProviderModel,
  context: ProviderStreamContext,
  options: ProviderStreamOptions = {},
): AsyncIterable<AdapterEvent> {
  try {
    const environment = { ...process.env, ...options.env };
    const config = await runtimeConfig(model.provider, model, environment);
    const credentialId = credentialProvider(config, model.provider);
    const credential = explicitCredential(credentialId, model.provider, options);
    const credentials = credential === undefined
      ? new Map<string, AuthCredential>()
      : new Map<string, AuthCredential>([[credentialId, credential]]);
    const broker = new CredentialBroker([new ExplicitCredentialSource(credentials)]);
    const wire = new ProviderWireInterceptorRegistry();
    if (model.provider === "cloudflare-workers-ai" || model.provider === "cloudflare-ai-gateway") {
      const runtime = await import("../cli/runtime.js");
      runtime.registerCloudflareWireInterceptors(wire, broker, environment);
    }
    const { createProviderAdapter } = await import("../service/provider-factory.js");
    const adapter = createProviderAdapter(config, broker, { environment, wire });
    const requestHeaders = Object.fromEntries(
      Object.entries(options.headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
    );
    const request: ProviderRequest = {
      provider: adapter.id,
      model: model.id,
      api: model.api,
      messages: context.messages,
      tools: context.tools ?? [],
      ...(context.providerState === undefined ? {} : { providerState: context.providerState }),
      ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.cacheRetention === undefined ? {} : { cacheRetention: options.cacheRetention }),
      ...(options.thinkingBudgets === undefined ? {} : { thinkingBudgets: options.thinkingBudgets }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      ...(options.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: options.maxRetryDelayMs }),
      ...(Object.keys(requestHeaders).length === 0 && model.compat === undefined
        ? {}
        : {
            modelSettings: {
              ...(Object.keys(requestHeaders).length === 0 ? {} : { headers: requestHeaders }),
              ...(model.compat === undefined ? {} : { compatibility: structuredClone(model.compat) }),
            },
          }),
    };
    yield* adapter.stream(request, options.signal ?? new AbortController().signal);
    await adapter.dispose?.();
  } catch (error) {
    yield {
      type: "error",
      error: {
        category: "provider",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        partial: false,
      },
    };
  }
}

function builtinProvider(descriptor: BuiltinProviderDescriptor): Provider {
  const models = modelsByProvider.get(descriptor.id) ?? [];
  return {
    id: descriptor.id,
    name: descriptor.name,
    ...(descriptor.baseUrl === undefined ? {} : { baseUrl: descriptor.baseUrl }),
    auth: { apiKey: environmentProviderAuth(descriptor) },
    getModels: () => models,
    stream: streamBuiltinModel,
    streamSimple: streamBuiltinModel,
  };
}

/** All built-in providers, freshly constructed. Dynamic providers may initially have no models. */
export function builtinProviders(): Provider[] {
  return BUILTIN_PROVIDER_DESCRIPTORS.map(builtinProvider);
}

/** A direct mutable model collection with every built-in provider registered. */
export function builtinModels(options?: CreateModelsOptions): MutableModels {
  const models = createModels(options);
  for (const provider of builtinProviders()) models.setProvider(provider);
  return models;
}
