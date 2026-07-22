import type { CredentialBroker } from "../auth/broker.js";
import type { AmbientCredentialDescriptor, AuthCredential } from "../auth/types.js";
import { resolveAwsDefaultCredentials } from "../auth/aws-credentials.js";
import { resolveAzureDefaultCredential } from "../auth/azure-identity.js";
import { resolveGoogleApplicationDefaultCredentials } from "../auth/google-adc.js";
import { exchangeGitHubCopilotToken, normalizeGitHubHost } from "../auth/github-copilot.js";
import type {
  ModelInfo,
  ModelProtocolFamily,
  ProviderAdapter,
  ProviderId,
} from "../core/types.js";
import type { NetworkWebSocketFactory } from "../net/index.js";
import type { ProviderWireTransportHost } from "../providers/wire.js";
import {
  AnthropicAdapter,
  AzureOpenAIResponsesAdapter,
  BedrockAdapter,
  GeminiAdapter,
  GeminiInteractionsAdapter,
  GatewayMessagesAdapter,
  GitHubCopilotAdapter,
  LlamaRouterAdapter,
  MistralAdapter,
  OllamaAdapter,
  OpenAICompatibleAdapter,
  OpenAICodexResponsesAdapter,
  OpenAIResponsesAdapter,
  OpenRouterAdapter,
  VertexAdapter,
  defineRoutedProviderAdapter,
  type AwsCredentials,
  type AnthropicThinkingConfig,
  type FetchLike,
  type OpenAIPromptCacheOptions,
  type OpenAICodexTransport,
  type OpenAICompatibleProfile,
} from "../providers/index.js";

interface RuntimeProviderCredentialBinding {
  /** Credential broker identity. Defaults to the adapter's public identity. */
  credentialProvider?: string;
}

export type RuntimeLeafProviderConfig = RuntimeProviderCredentialBinding & (
  | { kind: "openai"; baseUrl?: string; organization?: string; project?: string; store?: boolean; promptCacheOptions?: OpenAIPromptCacheOptions; promptCacheRetention?: "in-memory" | "24h"; serviceTier?: "auto" | "default" | "flex" | "priority"; deferredToolLoading?: boolean }
  | {
      kind: "openai-codex";
      baseUrl?: string;
      transport?: OpenAICodexTransport;
      webSocketConnectTimeoutMs?: number;
      webSocketIdleTimeoutMs?: number;
    }
  | { kind: "azure-openai"; endpoint: string; store?: boolean }
  | {
      kind: "anthropic";
      id?: ProviderId;
      credentialProvider?: string;
      baseUrl?: string;
      beta?: string[];
      promptCache?: "off" | "5m" | "1h";
      thinking?: AnthropicThinkingConfig;
      deferredToolLoading?: boolean;
      eagerToolInputStreaming?: boolean;
    }
  | { kind: "github-copilot"; host?: string }
  | {
      kind: "gemini";
      protocol?: "interactions" | "generate-content";
      baseUrl?: string;
      store?: boolean;
      userProject?: string;
    }
  | { kind: "vertex"; project: string; location?: string; baseUrl?: string; userProject?: string }
  | {
      kind: "bedrock";
      region?: string;
      profile?: string;
      runtimeEndpoint?: string;
      controlEndpoint?: string;
      promptCache?: "off" | "5m" | "1h";
      thinkingDisplay?: "summarized" | "omitted";
      interleavedThinking?: boolean;
    }
  | { kind: "openrouter"; baseUrl?: string; appName?: string; siteUrl?: string; promptCache?: "off" | "5m" | "1h" }
  | {
      kind: "mistral";
      baseUrl?: string;
      promptCache?: "off" | "session";
      reasoningMode?: "effort" | "prompt";
    }
  | { kind: "ollama"; host?: string }
  | {
      kind: "llama-router";
      id?: ProviderId;
      baseUrl?: string;
      timeoutMs?: number;
    }
  | {
      kind: "gateway-messages";
      id: ProviderId;
      gatewayUrl: string;
      cacheRetention?: "none" | "short" | "long";
      toolChoice?: "auto" | "none" | "required";
      temperature?: number;
      managedOAuth?: boolean;
    }
  | {
      kind: "openai-compatible";
      id?: ProviderId;
      baseUrl: string;
      profile?: OpenAICompatibleProfile;
    }
);

export interface RuntimeRoutedProviderRouteConfig {
  model: string;
  adapter: string;
  protocolFamily: ModelProtocolFamily;
  upstreamModel?: string;
  modelInfo?: ModelInfo;
}

export interface RuntimeRoutedProviderConfig extends RuntimeProviderCredentialBinding {
  kind: "routed";
  id: ProviderId;
  adapters: Readonly<Record<string, RuntimeLeafProviderConfig>>;
  routes: readonly RuntimeRoutedProviderRouteConfig[];
}

export type RuntimeProviderConfig = RuntimeLeafProviderConfig | RuntimeRoutedProviderConfig;

async function credential(
  broker: CredentialBroker,
  provider: string,
  signal?: AbortSignal,
): Promise<Exclude<AuthCredential, AmbientCredentialDescriptor>> {
  const resolved = await broker.resolve({ provider, ...(signal === undefined ? {} : { signal }) });
  if (resolved === undefined) throw new Error(`No credential is configured for ${provider}`);
  if (resolved.credential.kind === "ambient") {
    throw new Error(`Ambient ${resolved.credential.provider} identity requires a configured token/credential resolver`);
  }
  return resolved.credential;
}

async function optionalCredential(
  broker: CredentialBroker,
  provider: string,
  signal?: AbortSignal,
): Promise<Exclude<AuthCredential, AmbientCredentialDescriptor> | undefined> {
  const resolved = await broker.resolve({ provider, ...(signal === undefined ? {} : { signal }) });
  if (resolved === undefined || resolved.credential.kind === "ambient") return undefined;
  return resolved.credential;
}

function apiKeyIfPresent(broker: CredentialBroker, provider: string): (signal?: AbortSignal) => Promise<string | undefined> {
  return async (signal) => {
    const found = await credential(broker, provider, signal);
    return found.kind === "api_key" ? found.apiKey : undefined;
  };
}

function accessTokenIfPresent(broker: CredentialBroker, provider: string): (signal?: AbortSignal) => Promise<string | undefined> {
  return async (signal) => {
    const found = await credential(broker, provider, signal);
    return found.kind === "api_key" ? undefined : found.accessToken;
  };
}

function optionalApiKeySource(broker: CredentialBroker, provider: string): (signal?: AbortSignal) => Promise<string | undefined> {
  return async (signal) => {
    const found = await optionalCredential(broker, provider, signal);
    return found?.kind === "api_key" ? found.apiKey : undefined;
  };
}

function googleTokenSources(
  broker: CredentialBroker,
  provider: string,
  configuredUserProject?: string,
  fetchImplementation?: FetchLike,
): {
  accessToken: (signal?: AbortSignal) => Promise<string | undefined>;
  userProject: (signal?: AbortSignal) => Promise<string | undefined>;
} {
  let cached: NonNullable<Awaited<ReturnType<typeof resolveGoogleApplicationDefaultCredentials>>> | undefined;
  let activeUserProject: string | undefined;
  const ambient = async (signal?: AbortSignal) => {
    if (cached !== undefined && cached.expiresAt > Date.now() + 60_000) return cached;
    const resolved = await resolveGoogleApplicationDefaultCredentials({
      ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (resolved === undefined) throw new Error("Google application default credentials are unavailable");
    cached = resolved;
    return cached;
  };
  return {
    accessToken: async (signal) => {
      const explicit = await optionalCredential(broker, provider, signal);
      if (explicit?.kind === "api_key") {
        activeUserProject = undefined;
        return undefined;
      }
      if (explicit !== undefined) {
        if (explicit.expiresAt !== undefined && explicit.expiresAt <= Date.now()) throw new Error(`${provider} bearer credential is expired`);
        activeUserProject = configuredUserProject;
        return explicit.accessToken;
      }
      const token = await ambient(signal);
      activeUserProject = configuredUserProject ?? token.quotaProjectId;
      return token.accessToken;
    },
    userProject: async () => activeUserProject ?? configuredUserProject,
  };
}

function azureTokenSource(
  broker: CredentialBroker,
  fetchImplementation?: FetchLike,
): (signal?: AbortSignal) => Promise<string | undefined> {
  let cached: NonNullable<Awaited<ReturnType<typeof resolveAzureDefaultCredential>>> | undefined;
  return async (signal) => {
    const explicit = await optionalCredential(broker, "azure-openai", signal);
    if (explicit?.kind === "api_key") return undefined;
    if (explicit !== undefined) {
      if (explicit.expiresAt !== undefined && explicit.expiresAt <= Date.now()) throw new Error("azure-openai bearer credential is expired");
      return explicit.accessToken;
    }
    if (cached !== undefined && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
    const resolved = await resolveAzureDefaultCredential({
      ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (resolved === undefined) throw new Error("Azure default credentials are unavailable");
    cached = resolved;
    return cached.accessToken;
  };
}

function awsCredentialSource(
  fetchImplementation?: FetchLike,
  environment?: NodeJS.ProcessEnv,
  profile?: string,
): (signal?: AbortSignal) => Promise<AwsCredentials> {
  let cached: NonNullable<Awaited<ReturnType<typeof resolveAwsDefaultCredentials>>> | undefined;
  return async (signal) => {
    if (cached !== undefined && (cached.expiresAt === undefined || cached.expiresAt > Date.now() + 60_000)) return cached;
    const resolved = await resolveAwsDefaultCredentials({
      ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
      ...(environment === undefined ? {} : { environment }),
      ...(profile === undefined ? {} : { profile }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (resolved === undefined) throw new Error("AWS default credentials are unavailable");
    cached = resolved;
    return cached;
  };
}

function bearerSource(broker: CredentialBroker, provider: string): (signal?: AbortSignal) => Promise<string> {
  return async (signal) => {
    const found = await credential(broker, provider, signal);
    return found.kind === "api_key" ? found.apiKey : found.accessToken;
  };
}

function optionalBearerSource(broker: CredentialBroker, provider: string): (signal?: AbortSignal) => Promise<string | undefined> {
  return async (signal) => {
    const resolved = await broker.resolve({ provider, ...(signal === undefined ? {} : { signal }) });
    if (resolved === undefined) return undefined;
    const found = resolved.credential;
    if (found.kind === "ambient") throw new Error(`Ambient ${found.provider} identity requires a configured token resolver`);
    return found.kind === "api_key" ? found.apiKey : found.accessToken;
  };
}

function githubCopilotCredentialSource(
  broker: CredentialBroker,
  fetchImplementation?: FetchLike,
  configuredHost?: string,
  credentialProvider = "github-copilot",
): (signal?: AbortSignal) => Promise<{ accessToken: string; enterpriseHost?: string }> {
  let cached: { sourceToken: string; accessToken: string; expiresAt: number; enterpriseHost?: string } | undefined;
  return async (signal) => {
    const found = await credential(broker, credentialProvider, signal);
    if (found.kind === "oauth") {
      return {
        accessToken: found.accessToken,
        ...(found.providerData?.enterpriseHost === undefined ? {} : { enterpriseHost: found.providerData.enterpriseHost }),
      };
    }
    const sourceToken = found.kind === "api_key" ? found.apiKey : found.accessToken;
    const enterpriseHost = normalizeGitHubHost(configuredHost ?? process.env.COPILOT_GH_HOST);
    if (
      cached !== undefined && cached.sourceToken === sourceToken &&
      cached.enterpriseHost === (enterpriseHost === "github.com" ? undefined : enterpriseHost) &&
      cached.expiresAt > Date.now() + 5 * 60_000
    ) return { accessToken: cached.accessToken, ...(cached.enterpriseHost === undefined ? {} : { enterpriseHost: cached.enterpriseHost }) };
    const token = await exchangeGitHubCopilotToken(sourceToken, enterpriseHost, {
      ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
      ...(signal === undefined ? {} : { signal }),
    });
    cached = {
      sourceToken,
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      ...(enterpriseHost === "github.com" ? {} : { enterpriseHost }),
    };
    return { accessToken: cached.accessToken, ...(cached.enterpriseHost === undefined ? {} : { enterpriseHost: cached.enterpriseHost }) };
  };
}

function routedWireHost(
  wire: ProviderWireTransportHost | undefined,
  provider: ProviderId,
): ProviderWireTransportHost | undefined {
  if (wire === undefined) return undefined;
  return {
    wrapFetch(_delegate, fetchImplementation) {
      return wire.wrapFetch(provider, fetchImplementation);
    },
    begin(_delegate) {
      return wire.begin(provider);
    },
  };
}

export function runtimeProviderProtocolFamily(config: RuntimeLeafProviderConfig): ModelProtocolFamily | undefined {
  switch (config.kind) {
    case "openai":
    case "openai-codex":
    case "azure-openai":
      return "openai-responses";
    case "anthropic":
      return "anthropic-messages";
    case "gemini":
      return config.protocol === "generate-content" ? "gemini-generate-content" : "gemini-interactions";
    case "vertex":
      return "gemini-generate-content";
    case "bedrock":
      return "bedrock-converse";
    case "mistral":
      return "mistral-conversations";
    case "ollama":
      return "ollama-chat";
    case "gateway-messages":
      return "gateway-messages";
    case "llama-router":
    case "openrouter":
    case "openai-compatible":
      return "openai-chat-completions";
    case "github-copilot":
      return undefined;
  }
}

function createRoutedProviderAdapter(
  config: RuntimeRoutedProviderConfig,
  broker: CredentialBroker,
  options: {
    fetch?: FetchLike;
    webSocket?: NetworkWebSocketFactory;
    wire?: ProviderWireTransportHost;
    environment?: NodeJS.ProcessEnv;
  },
): ProviderAdapter {
  if (config.adapters === null || typeof config.adapters !== "object" || Array.isArray(config.adapters)) {
    throw new TypeError(`Routed provider ${config.id} adapters must be an object`);
  }
  const definitions = Object.entries(config.adapters);
  if (definitions.length === 0 || definitions.length > 128) {
    throw new TypeError(`Routed provider ${config.id} must define 1 through 128 adapters`);
  }
  if (!Array.isArray(config.routes) || config.routes.length === 0 || config.routes.length > 20_000) {
    throw new TypeError(`Routed provider ${config.id} must define 1 through 20000 routes`);
  }
  const normalizedDefinitions = new Map<string, RuntimeLeafProviderConfig>();
  for (const [name, definition] of definitions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) {
      throw new TypeError(`Routed provider ${config.id} adapter name is invalid: ${name}`);
    }
    if (definition === null || typeof definition !== "object" || Array.isArray(definition)) {
      throw new TypeError(`Routed provider ${config.id} adapter ${name} must be an object`);
    }
    const credentialProvider = definition.credentialProvider ?? config.credentialProvider ?? config.id;
    const normalized = { ...definition, credentialProvider } as RuntimeLeafProviderConfig;
    normalizedDefinitions.set(name, normalized);
  }
  for (const [index, route] of config.routes.entries()) {
    if (route === null || typeof route !== "object" || Array.isArray(route)) {
      throw new TypeError(`Routed provider ${config.id} route ${index} must be an object`);
    }
    const definition = normalizedDefinitions.get(route.adapter);
    if (definition === undefined) {
      throw new TypeError(`Routed provider ${config.id} route ${index} references unknown adapter ${route.adapter}`);
    }
    const protocolFamily = runtimeProviderProtocolFamily(definition);
    if (protocolFamily === undefined) {
      throw new TypeError(
        `Routed provider ${config.id} adapter ${route.adapter} selects its protocol dynamically and cannot be used in an exact route`,
      );
    }
    if (protocolFamily !== route.protocolFamily) {
      throw new TypeError(
        `Routed provider ${config.id} route ${index} declares ${route.protocolFamily} but adapter ${route.adapter} uses ${protocolFamily}`,
      );
    }
  }
  const delegates = new Map<string, ProviderAdapter>();
  const publicWire = routedWireHost(options.wire, config.id);
  for (const [name, normalized] of normalizedDefinitions) {
    delegates.set(name, createProviderAdapter(normalized, broker, {
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.webSocket === undefined ? {} : { webSocket: options.webSocket }),
        ...(publicWire === undefined ? {} : { wire: publicWire }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      }));
  }
  return defineRoutedProviderAdapter({
    id: config.id,
    delegateOwnership: "owned",
    routes: config.routes.map((route, index) => {
      const delegate = delegates.get(route.adapter);
      if (delegate === undefined) {
        throw new TypeError(`Routed provider ${config.id} route ${index} references unknown adapter ${route.adapter}`);
      }
      return {
        model: route.model,
        adapter: delegate,
        protocolFamily: route.protocolFamily,
        ...(route.upstreamModel === undefined ? {} : { upstreamModel: route.upstreamModel }),
        ...(route.modelInfo === undefined ? {} : { modelInfo: route.modelInfo }),
      };
    }),
  });
}

export function createProviderAdapter(
  config: RuntimeProviderConfig,
  broker: CredentialBroker,
  options: {
    fetch?: FetchLike;
    webSocket?: NetworkWebSocketFactory;
    wire?: ProviderWireTransportHost;
    environment?: NodeJS.ProcessEnv;
  } = {},
): ProviderAdapter {
  if (config.kind === "routed") return createRoutedProviderAdapter(config, broker, options);
  const credentialProvider = config.credentialProvider ?? runtimeProviderId(config);
  const providerFetch = options.wire?.wrapFetch(
    runtimeProviderId(config),
    options.fetch ?? globalThis.fetch,
  );
  const transport = providerFetch === undefined
    ? options.fetch === undefined ? {} : { fetch: options.fetch }
    : { fetch: providerFetch };
  switch (config.kind) {
    case "openai-codex":
      return new OpenAICodexResponsesAdapter({
        credential: async (signal) => {
          const found = await credential(broker, credentialProvider, signal);
          if (found.kind !== "oauth") throw new Error("OpenAI Codex requires ChatGPT subscription OAuth");
          if (found.accountId === undefined) throw new Error("OpenAI Codex credential has no ChatGPT account ID; run /login openai-codex again");
          return { accessToken: found.accessToken, accountId: found.accountId };
        },
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        ...(config.transport === undefined ? {} : { transport: config.transport }),
        ...(config.webSocketConnectTimeoutMs === undefined ? {} : { webSocketConnectTimeoutMs: config.webSocketConnectTimeoutMs }),
        ...(config.webSocketIdleTimeoutMs === undefined ? {} : { webSocketIdleTimeoutMs: config.webSocketIdleTimeoutMs }),
        ...(options.webSocket === undefined ? {} : { webSocket: options.webSocket }),
        ...(options.wire === undefined ? {} : { wire: options.wire }),
        ...transport,
      });
    case "openai":
      return new OpenAIResponsesAdapter({
        accessToken: bearerSource(broker, credentialProvider),
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        ...(config.organization === undefined ? {} : { organization: config.organization }),
        ...(config.project === undefined ? {} : { project: config.project }),
        ...(config.store === undefined ? {} : { store: config.store }),
        ...(config.promptCacheOptions === undefined ? {} : { promptCacheOptions: config.promptCacheOptions }),
        ...(config.promptCacheRetention === undefined ? {} : { promptCacheRetention: config.promptCacheRetention }),
        ...(config.serviceTier === undefined ? {} : { serviceTier: config.serviceTier }),
        ...(config.deferredToolLoading === undefined ? {} : { deferredToolLoading: config.deferredToolLoading }),
        ...transport,
      });
    case "azure-openai":
      return new AzureOpenAIResponsesAdapter({
        endpoint: config.endpoint,
        apiKey: optionalApiKeySource(broker, credentialProvider),
        accessToken: azureTokenSource(broker, options.fetch),
        ...(config.store === undefined ? {} : { store: config.store }),
        ...transport,
      });
    case "anthropic":
      return new AnthropicAdapter({
        ...(config.id === undefined ? {} : { id: config.id }),
        apiKey: apiKeyIfPresent(broker, credentialProvider),
        accessToken: accessTokenIfPresent(broker, credentialProvider),
        oauth: async (signal) =>
          runtimeProviderId(config) === "anthropic" &&
          (await credential(broker, credentialProvider, signal)).kind === "oauth",
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        ...(config.beta === undefined ? {} : { beta: config.beta }),
        ...(config.promptCache === undefined ? {} : { promptCache: config.promptCache }),
        ...(config.thinking === undefined ? {} : { thinking: config.thinking }),
        ...(config.deferredToolLoading === undefined ? {} : { deferredToolLoading: config.deferredToolLoading }),
        ...(config.eagerToolInputStreaming === undefined
          ? {}
          : { eagerToolInputStreaming: config.eagerToolInputStreaming }),
        ...transport,
      });
    case "github-copilot":
      return new GitHubCopilotAdapter({
        credential: githubCopilotCredentialSource(broker, options.fetch, config.host, credentialProvider),
        ...transport,
      });
    case "gemini": {
      const google = googleTokenSources(broker, credentialProvider, config.userProject, options.fetch);
      const common = {
        apiKey: optionalApiKeySource(broker, credentialProvider),
        accessToken: google.accessToken,
        userProject: google.userProject,
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        ...transport,
      };
      return config.protocol === "generate-content"
        ? new GeminiAdapter(common)
        : new GeminiInteractionsAdapter({ ...common, ...(config.store === undefined ? {} : { store: config.store }) });
    }
    case "vertex": {
      const google = googleTokenSources(broker, credentialProvider, config.userProject, options.fetch);
      return new VertexAdapter({
        project: config.project,
        accessToken: google.accessToken,
        userProject: google.userProject,
        ...(config.location === undefined ? {} : { location: config.location }),
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        ...transport,
      });
    }
    case "bedrock": {
      const bearerToken = optionalBearerSource(broker, credentialProvider);
      return new BedrockAdapter({
        ...(config.region === undefined ? {} : { region: config.region }),
        ...(config.profile === undefined ? {} : { profile: config.profile }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        bearerToken,
        credentials: awsCredentialSource(options.fetch, options.environment, config.profile),
        ...(config.runtimeEndpoint === undefined ? {} : { runtimeEndpoint: config.runtimeEndpoint }),
        ...(config.controlEndpoint === undefined ? {} : { controlEndpoint: config.controlEndpoint }),
        ...(config.promptCache === undefined ? {} : { promptCache: config.promptCache }),
        ...(config.thinkingDisplay === undefined ? {} : { thinkingDisplay: config.thinkingDisplay }),
        ...(config.interleavedThinking === undefined ? {} : { interleavedThinking: config.interleavedThinking }),
        fetch: options.fetch ?? globalThis.fetch,
        ...(options.wire === undefined ? {} : { wire: options.wire }),
      });
    }
    case "openrouter":
      return new OpenRouterAdapter({
        apiKey: bearerSource(broker, credentialProvider),
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        ...(config.appName === undefined ? {} : { appName: config.appName }),
        ...(config.siteUrl === undefined ? {} : { siteUrl: config.siteUrl }),
        ...(config.promptCache === undefined ? {} : { promptCache: config.promptCache }),
        ...transport,
      });
    case "mistral":
      return new MistralAdapter({
        apiKey: bearerSource(broker, credentialProvider),
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        ...(config.promptCache === undefined ? {} : { promptCache: config.promptCache }),
        ...(config.reasoningMode === undefined ? {} : { reasoningMode: config.reasoningMode }),
        ...transport,
      });
    case "ollama":
      {
        const host = config.host ?? "http://127.0.0.1:11434";
        const hostname = new URL(host).hostname;
        const local = ["127.0.0.1", "localhost", "::1"].includes(hostname);
        return new OllamaAdapter({
          ...(local ? {} : { apiKey: optionalBearerSource(broker, credentialProvider) }),
          host,
          ...transport,
        });
      }
    case "llama-router":
      return new LlamaRouterAdapter({
        ...(config.id === undefined ? {} : { id: config.id }),
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        apiKey: optionalBearerSource(broker, credentialProvider),
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        ...transport,
      });
    case "gateway-messages":
      return new GatewayMessagesAdapter({
        id: config.id,
        gatewayUrl: config.gatewayUrl,
        accessToken: bearerSource(broker, credentialProvider),
        ...(config.cacheRetention === undefined ? {} : { cacheRetention: config.cacheRetention }),
        ...(config.toolChoice === undefined ? {} : { toolChoice: config.toolChoice }),
        ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
        ...transport,
      });
    default: {
      const id = config.id ?? "openai-compatible";
      const provider = config.credentialProvider ?? id;
      return new OpenAICompatibleAdapter({
        id,
        baseUrl: config.baseUrl,
        accessToken: bearerSource(broker, provider),
        ...(config.profile === undefined ? {} : { profile: config.profile }),
        ...transport,
      });
    }
  }
}

export function runtimeProviderId(config: RuntimeProviderConfig): ProviderId {
  if (config.kind === "routed") return config.id;
  if (config.kind === "openai-compatible") return config.id ?? "openai-compatible";
  if (config.kind === "anthropic") return config.id ?? "anthropic";
  if (config.kind === "llama-router") return config.id ?? "llama.cpp";
  if (config.kind === "gateway-messages") return config.id;
  return config.kind;
}
