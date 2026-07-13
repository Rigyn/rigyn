import type { CredentialBroker } from "../auth/broker.js";
import type { AmbientCredentialDescriptor, AuthCredential } from "../auth/types.js";
import { resolveAwsDefaultCredentials } from "../auth/aws-credentials.js";
import { resolveAzureDefaultCredential } from "../auth/azure-identity.js";
import { resolveGoogleApplicationDefaultCredentials } from "../auth/google-adc.js";
import { exchangeGitHubCopilotToken, normalizeGitHubHost } from "../auth/github-copilot.js";
import type { ProviderAdapter, ProviderId } from "../core/types.js";
import type { NetworkWebSocketFactory } from "../net/index.js";
import {
  AnthropicAdapter,
  AzureOpenAIResponsesAdapter,
  BedrockAdapter,
  GeminiAdapter,
  GeminiInteractionsAdapter,
  GitHubCopilotAdapter,
  MistralAdapter,
  MistralConversationsAdapter,
  OllamaAdapter,
  OpenAICompatibleAdapter,
  OpenAICodexResponsesAdapter,
  OpenAIResponsesAdapter,
  OpenRouterAdapter,
  VertexAdapter,
  type AwsCredentials,
  type AnthropicThinkingConfig,
  type FetchLike,
  type OpenAIPromptCacheOptions,
  type OpenAICodexTransport,
  type OpenAICompatibleProfile,
} from "../providers/index.js";

export type RuntimeProviderConfig =
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
      baseUrl?: string;
      beta?: string[];
      promptCache?: "off" | "5m" | "1h";
      thinking?: AnthropicThinkingConfig;
      deferredToolLoading?: boolean;
    }
  | { kind: "github-copilot"; host?: string }
  | { kind: "gemini"; protocol?: "interactions" | "generate-content"; baseUrl?: string; store?: boolean; userProject?: string }
  | { kind: "vertex"; project: string; location?: string; baseUrl?: string; userProject?: string }
  | { kind: "bedrock"; region: string; runtimeEndpoint?: string; controlEndpoint?: string; promptCache?: "off" | "5m" | "1h" }
  | { kind: "openrouter"; baseUrl?: string; appName?: string; siteUrl?: string; promptCache?: "off" | "5m" | "1h" }
  | {
      kind: "mistral";
      protocol?: "chat-completions" | "conversations";
      baseUrl?: string;
      store?: boolean;
      promptCache?: "off" | "session";
      reasoningMode?: "effort" | "prompt";
    }
  | { kind: "ollama"; host?: string }
  | {
      kind: "openai-compatible";
      id?: ProviderId;
      baseUrl: string;
      credentialProvider?: string;
      profile?: OpenAICompatibleProfile;
    };

async function credential(
  broker: CredentialBroker,
  provider: string,
): Promise<Exclude<AuthCredential, AmbientCredentialDescriptor>> {
  const resolved = await broker.resolve({ provider });
  if (resolved === undefined) throw new Error(`No credential is configured for ${provider}`);
  if (resolved.credential.kind === "ambient") {
    throw new Error(`Ambient ${resolved.credential.provider} identity requires a configured token/credential resolver`);
  }
  return resolved.credential;
}

async function optionalCredential(
  broker: CredentialBroker,
  provider: string,
): Promise<Exclude<AuthCredential, AmbientCredentialDescriptor> | undefined> {
  const resolved = await broker.resolve({ provider });
  if (resolved === undefined || resolved.credential.kind === "ambient") return undefined;
  return resolved.credential;
}

function apiKeyIfPresent(broker: CredentialBroker, provider: string): () => Promise<string | undefined> {
  return async () => {
    const found = await credential(broker, provider);
    return found.kind === "api_key" ? found.apiKey : undefined;
  };
}

function accessTokenIfPresent(broker: CredentialBroker, provider: string): () => Promise<string | undefined> {
  return async () => {
    const found = await credential(broker, provider);
    return found.kind === "api_key" ? undefined : found.accessToken;
  };
}

function optionalApiKeySource(broker: CredentialBroker, provider: string): () => Promise<string | undefined> {
  return async () => {
    const found = await optionalCredential(broker, provider);
    return found?.kind === "api_key" ? found.apiKey : undefined;
  };
}

function googleTokenSources(
  broker: CredentialBroker,
  provider: string,
  configuredUserProject?: string,
  fetchImplementation?: FetchLike,
): { accessToken: () => Promise<string | undefined>; userProject: () => Promise<string | undefined> } {
  let cached: NonNullable<Awaited<ReturnType<typeof resolveGoogleApplicationDefaultCredentials>>> | undefined;
  let pending: Promise<Awaited<ReturnType<typeof resolveGoogleApplicationDefaultCredentials>>> | undefined;
  let activeUserProject: string | undefined;
  const ambient = async () => {
    if (cached !== undefined && cached.expiresAt > Date.now() + 60_000) return cached;
    pending ??= resolveGoogleApplicationDefaultCredentials(
      fetchImplementation === undefined ? {} : { fetch: fetchImplementation },
    ).finally(() => {
      pending = undefined;
    });
    const resolved = await pending;
    if (resolved === undefined) throw new Error("Google application default credentials are unavailable");
    cached = resolved;
    return cached;
  };
  return {
    accessToken: async () => {
      const explicit = await optionalCredential(broker, provider);
      if (explicit?.kind === "api_key") {
        activeUserProject = undefined;
        return undefined;
      }
      if (explicit !== undefined) {
        if (explicit.expiresAt !== undefined && explicit.expiresAt <= Date.now()) throw new Error(`${provider} bearer credential is expired`);
        activeUserProject = configuredUserProject;
        return explicit.accessToken;
      }
      const token = await ambient();
      activeUserProject = configuredUserProject ?? token.quotaProjectId;
      return token.accessToken;
    },
    userProject: async () => activeUserProject ?? configuredUserProject,
  };
}

function azureTokenSource(broker: CredentialBroker, fetchImplementation?: FetchLike): () => Promise<string | undefined> {
  let cached: NonNullable<Awaited<ReturnType<typeof resolveAzureDefaultCredential>>> | undefined;
  let pending: Promise<Awaited<ReturnType<typeof resolveAzureDefaultCredential>>> | undefined;
  return async () => {
    const explicit = await optionalCredential(broker, "azure-openai");
    if (explicit?.kind === "api_key") return undefined;
    if (explicit !== undefined) {
      if (explicit.expiresAt !== undefined && explicit.expiresAt <= Date.now()) throw new Error("azure-openai bearer credential is expired");
      return explicit.accessToken;
    }
    if (cached !== undefined && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;
    pending ??= resolveAzureDefaultCredential(
      fetchImplementation === undefined ? {} : { fetch: fetchImplementation },
    ).finally(() => {
      pending = undefined;
    });
    const resolved = await pending;
    if (resolved === undefined) throw new Error("Azure default credentials are unavailable");
    cached = resolved;
    return cached.accessToken;
  };
}

function awsCredentialSource(fetchImplementation?: FetchLike): () => Promise<AwsCredentials> {
  let cached: NonNullable<Awaited<ReturnType<typeof resolveAwsDefaultCredentials>>> | undefined;
  let pending: Promise<Awaited<ReturnType<typeof resolveAwsDefaultCredentials>>> | undefined;
  return async () => {
    if (cached !== undefined && (cached.expiresAt === undefined || cached.expiresAt > Date.now() + 60_000)) return cached;
    pending ??= resolveAwsDefaultCredentials(
      fetchImplementation === undefined ? {} : { fetch: fetchImplementation },
    ).finally(() => {
      pending = undefined;
    });
    const resolved = await pending;
    if (resolved === undefined) throw new Error("AWS default credentials are unavailable");
    cached = resolved;
    return cached;
  };
}

function bearerSource(broker: CredentialBroker, provider: string): () => Promise<string> {
  return async () => {
    const found = await credential(broker, provider);
    return found.kind === "api_key" ? found.apiKey : found.accessToken;
  };
}

function optionalBearerSource(broker: CredentialBroker, provider: string): () => Promise<string | undefined> {
  return async () => {
    const resolved = await broker.resolve({ provider });
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
): () => Promise<{ accessToken: string; enterpriseHost?: string }> {
  let cached: { sourceToken: string; accessToken: string; expiresAt: number; enterpriseHost?: string } | undefined;
  return async () => {
    const found = await credential(broker, "github-copilot");
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

export function createProviderAdapter(
  config: RuntimeProviderConfig,
  broker: CredentialBroker,
  options: { fetch?: FetchLike; webSocket?: NetworkWebSocketFactory } = {},
): ProviderAdapter {
  const transport = options.fetch === undefined ? {} : { fetch: options.fetch };
  switch (config.kind) {
    case "openai-codex":
      return new OpenAICodexResponsesAdapter({
        credential: async () => {
          const found = await credential(broker, "openai-codex");
          if (found.kind !== "oauth") throw new Error("OpenAI Codex requires ChatGPT subscription OAuth");
          if (found.accountId === undefined) throw new Error("OpenAI Codex credential has no ChatGPT account ID; run /login openai-codex again");
          return { accessToken: found.accessToken, accountId: found.accountId };
        },
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        ...(config.transport === undefined ? {} : { transport: config.transport }),
        ...(config.webSocketConnectTimeoutMs === undefined ? {} : { webSocketConnectTimeoutMs: config.webSocketConnectTimeoutMs }),
        ...(config.webSocketIdleTimeoutMs === undefined ? {} : { webSocketIdleTimeoutMs: config.webSocketIdleTimeoutMs }),
        ...(options.webSocket === undefined ? {} : { webSocket: options.webSocket }),
        ...transport,
      });
    case "openai":
      return new OpenAIResponsesAdapter({
        accessToken: bearerSource(broker, "openai"),
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
        apiKey: optionalApiKeySource(broker, "azure-openai"),
        accessToken: azureTokenSource(broker, options.fetch),
        ...(config.store === undefined ? {} : { store: config.store }),
        ...transport,
      });
    case "anthropic":
      return new AnthropicAdapter({
        apiKey: apiKeyIfPresent(broker, "anthropic"),
        accessToken: accessTokenIfPresent(broker, "anthropic"),
        oauth: async () => (await credential(broker, "anthropic")).kind === "oauth",
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        ...(config.beta === undefined ? {} : { beta: config.beta }),
        ...(config.promptCache === undefined ? {} : { promptCache: config.promptCache }),
        ...(config.thinking === undefined ? {} : { thinking: config.thinking }),
        ...(config.deferredToolLoading === undefined ? {} : { deferredToolLoading: config.deferredToolLoading }),
        ...transport,
      });
    case "github-copilot":
      return new GitHubCopilotAdapter({
        credential: githubCopilotCredentialSource(broker, options.fetch, config.host),
        ...transport,
      });
    case "gemini": {
      const google = googleTokenSources(broker, "gemini", config.userProject, options.fetch);
      const common = {
        apiKey: optionalApiKeySource(broker, "gemini"),
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
      const google = googleTokenSources(broker, "vertex", config.userProject, options.fetch);
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
      const bearerToken = async (): Promise<string | undefined> => {
        return optionalBearerSource(broker, "bedrock")();
      };
      return new BedrockAdapter({
        region: config.region,
        bearerToken,
        credentials: awsCredentialSource(options.fetch),
        ...(config.runtimeEndpoint === undefined ? {} : { runtimeEndpoint: config.runtimeEndpoint }),
        ...(config.controlEndpoint === undefined ? {} : { controlEndpoint: config.controlEndpoint }),
        ...(config.promptCache === undefined ? {} : { promptCache: config.promptCache }),
        ...transport,
      });
    }
    case "openrouter":
      return new OpenRouterAdapter({
        apiKey: bearerSource(broker, "openrouter"),
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        ...(config.appName === undefined ? {} : { appName: config.appName }),
        ...(config.siteUrl === undefined ? {} : { siteUrl: config.siteUrl }),
        ...(config.promptCache === undefined ? {} : { promptCache: config.promptCache }),
        ...transport,
      });
    case "mistral":
      if (config.protocol === "conversations") {
        if (config.promptCache !== undefined && config.promptCache !== "off") {
          throw new TypeError("Mistral Conversations does not support prompt_cache_key; use promptCache: off");
        }
        if (config.reasoningMode !== undefined && config.reasoningMode !== "effort") {
          throw new TypeError("Mistral Conversations supports reasoningMode: effort only");
        }
        return new MistralConversationsAdapter({
          apiKey: bearerSource(broker, "mistral"),
          ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
          ...(config.store === undefined ? {} : { store: config.store }),
          ...transport,
        });
      }
      return new MistralAdapter({
        apiKey: bearerSource(broker, "mistral"),
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
          ...(local ? {} : { apiKey: optionalBearerSource(broker, "ollama") }),
          host,
          ...transport,
        });
      }
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
