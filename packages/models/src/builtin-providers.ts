import type {
  Api,
  Model,
  OAuthAuth,
  OAuthCredentials,
  Provider,
  ProviderAuth,
  ProviderHeaders,
  RefreshModelsContext,
} from "./contracts.js";
import { apiKeyMethod, browserOAuthMethod, deviceOAuthMethod } from "./auth-flows.js";
import {
  anthropicModels,
  deepseekModels,
  githubCopilotModels,
  googleModels,
  kimiCodeModels,
  ollamaModels,
  openaiCodexModels,
  openaiModels,
  opencodeGoModels,
  opencodeModels,
  openrouterModels,
  xaiModels,
} from "./catalogs.js";
import { createProvider } from "./model-runtime.js";
import { streamByApi } from "./protocol-transports.js";

export interface ProviderFactoryOptions {
  baseUrl?: string;
  models?: readonly Model[];
  headers?: ProviderHeaders;
  oauth?: OAuthAuth;
}

export interface XaiOAuthOptions {
  clientId: string;
  mode?: "browser" | "device";
  authorizationUrl?: string;
  deviceUrl?: string;
  tokenUrl?: string;
  scopes?: readonly string[];
  redirectUri?: string;
  fetch?: typeof globalThis.fetch;
}

function configuredModels(
  provider: string,
  defaults: readonly Model[],
  baseUrl: string,
  options: ProviderFactoryOptions,
): readonly Model[] {
  return (options.models ?? defaults).map((model) => ({
    ...structuredClone(model),
    provider,
    baseUrl: options.baseUrl ?? model.baseUrl ?? baseUrl,
  }));
}

function builtIn(
  id: string,
  name: string,
  defaults: readonly Model[],
  baseUrl: string,
  environment: readonly string[],
  options: ProviderFactoryOptions = {},
  auth: ProviderAuth = { apiKey: apiKeyMethod("API key", environment) },
): Provider {
  return createProvider({
    id,
    name,
    baseUrl: options.baseUrl ?? baseUrl,
    models: configuredModels(id, defaults, baseUrl, options),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    auth: options.oauth ? { ...auth, oauth: options.oauth } : auth,
    transport: (model, context, streamOptions) => streamByApi(model, context, streamOptions),
  });
}

export function openaiProvider(options: ProviderFactoryOptions = {}): Provider {
  return builtIn("openai", "OpenAI", openaiModels, "https://api.openai.com/v1", ["OPENAI_API_KEY"], options);
}

export function anthropicProvider(options: ProviderFactoryOptions = {}): Provider {
  return builtIn("anthropic", "Anthropic", anthropicModels, "https://api.anthropic.com", ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"], options);
}

export function googleProvider(options: ProviderFactoryOptions = {}): Provider {
  return builtIn("google", "Google", googleModels, "https://generativelanguage.googleapis.com", ["GEMINI_API_KEY", "GOOGLE_API_KEY"], options);
}

export function openrouterProvider(options: ProviderFactoryOptions = {}): Provider {
  return builtIn("openrouter", "OpenRouter", openrouterModels, "https://openrouter.ai/api/v1", ["OPENROUTER_API_KEY"], options);
}

export function deepseekProvider(options: ProviderFactoryOptions = {}): Provider {
  return builtIn("deepseek", "DeepSeek", deepseekModels, "https://api.deepseek.com/v1", ["DEEPSEEK_API_KEY"], options);
}

export function kimiCodeProvider(options: ProviderFactoryOptions = {}): Provider {
  return builtIn("kimi-code", "Kimi Code", kimiCodeModels, "https://api.kimi.com/coding/v1", ["KIMI_CODE_API_KEY"], options);
}

export function opencodeProvider(options: ProviderFactoryOptions = {}): Provider {
  return builtIn("opencode", "OpenCode Zen", opencodeModels, "https://opencode.ai/zen/v1", ["OPENCODE_API_KEY"], options);
}

export function opencodeGoProvider(options: ProviderFactoryOptions = {}): Provider {
  let catalog = configuredModels("opencode-go", opencodeGoModels, "https://opencode.ai/zen/go/v1", options);
  const baseUrl = options.baseUrl ?? "https://opencode.ai/zen/go/v1";
  return {
    id: "opencode-go",
    name: "OpenCode Go",
    baseUrl,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    auth: {
      apiKey: apiKeyMethod("OpenCode Go API key", ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"]),
      ...(options.oauth === undefined ? {} : { oauth: options.oauth }),
    },
    getModels: () => catalog,
    async refreshModels(context) {
      catalog = await refreshOpenCodeGo(catalog, baseUrl, context);
    },
    stream: (model, context, streamOptions) => streamByApi(model, context, streamOptions),
    streamSimple: (model, context, streamOptions) => streamByApi(model, context, streamOptions),
  };
}

async function refreshOpenCodeGo(
  reviewed: readonly Model[],
  baseUrl: string,
  context: RefreshModelsContext,
): Promise<readonly Model[]> {
  if (!context.allowNetwork) return (await context.store.read())?.models ?? reviewed;
  const credential = context.credential;
  const key = credential?.type === "api_key" ? credential.key : credential?.access;
  if (!key) return reviewed;
  const response = await (context.fetch ?? globalThis.fetch)(baseUrl.replace(/\/+$/u, "") + "/models", {
    headers: { authorization: "Bearer " + key, accept: "application/json" },
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  if (!response.ok) throw new Error("OpenCode Go model discovery failed with HTTP " + response.status);
  const value = await response.json() as unknown;
  const entries = typeof value === "object" && value !== null && Array.isArray((value as { data?: unknown }).data)
    ? (value as { data: unknown[] }).data
    : [];
  const live = new Set(entries.flatMap((item) => typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string" ? [(item as { id: string }).id] : []));
  const next = reviewed.filter((model) => live.has(model.id));
  await context.store.write({ models: next, checkedAt: Date.now() });
  return next;
}

export function openaiCodexProvider(options: ProviderFactoryOptions = {}): Provider {
  return builtIn(
    "openai-codex",
    "OpenAI Codex",
    openaiCodexModels,
    "https://chatgpt.com/backend-api/codex",
    [],
    options,
    options.oauth ? { oauth: options.oauth } : {},
  );
}

export function githubCopilotProvider(options: ProviderFactoryOptions = {}): Provider {
  return builtIn("github-copilot", "GitHub Copilot", githubCopilotModels, "https://api.githubcopilot.com", ["COPILOT_GITHUB_TOKEN"], options);
}

export function xaiProvider(options: ProviderFactoryOptions & { xaiOAuth?: XaiOAuthOptions } = {}): Provider {
  const oauth = options.xaiOAuth ? createXaiOAuth(options.xaiOAuth) : options.oauth;
  return builtIn(
    "xai",
    "xAI",
    xaiModels,
    "https://api.x.ai/v1",
    ["XAI_API_KEY"],
    options,
    {
      apiKey: apiKeyMethod("xAI API key", ["XAI_API_KEY"]),
      ...(oauth === undefined ? {} : { oauth }),
    },
  );
}

export function createXaiOAuth(options: XaiOAuthOptions): OAuthAuth {
  const scopes = options.scopes ?? ["openid", "offline_access"];
  const tokenUrl = options.tokenUrl ?? "https://auth.x.ai/oauth2/token";
  if (options.mode === "device") {
    return deviceOAuthMethod({
      name: "Sign in with SuperGrok or X Premium",
      clientId: options.clientId,
      deviceUrl: options.deviceUrl ?? "https://auth.x.ai/oauth2/device_authorization",
      tokenUrl,
      scopes,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }
  return browserOAuthMethod({
    name: "Sign in with SuperGrok or X Premium",
    authorizationUrl: options.authorizationUrl ?? "https://auth.x.ai/oauth2/authorize",
    tokenUrl,
    clientId: options.clientId,
    scopes,
    redirectUri: options.redirectUri ?? "http://127.0.0.1:56121/callback",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

export function ollamaProvider(options: ProviderFactoryOptions = {}): Provider {
  let catalog = configuredModels("ollama", ollamaModels, "http://127.0.0.1:11434/v1", options);
  const base = options.baseUrl ?? "http://127.0.0.1:11434";
  return {
    id: "ollama",
    name: "Ollama",
    baseUrl: base,
    auth: { apiKey: apiKeyMethod("Optional API key", ["OLLAMA_API_KEY"]) },
    getModels: () => catalog,
    async refreshModels(context) {
      if (!context.allowNetwork) {
        catalog = (await context.store.read())?.models ?? catalog;
        return;
      }
      const credential = context.credential;
      const key = credential?.type === "api_key" ? credential.key : credential?.access;
      const response = await (context.fetch ?? globalThis.fetch)(base.replace(/\/+$/u, "") + "/api/tags", {
        ...(key ? { headers: { authorization: "Bearer " + key } } : {}),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      if (!response.ok) throw new Error("Ollama discovery failed with HTTP " + response.status);
      const value = await response.json() as { models?: Array<{ name?: unknown }> };
      catalog = (value.models ?? []).flatMap((entry) => typeof entry.name === "string" ? [{
        id: entry.name,
        name: entry.name,
        api: "openai-completions" as const,
        provider: "ollama",
        baseUrl: base.replace(/\/+$/u, "") + "/v1",
        reasoning: false,
        input: ["text"] as Array<"text">,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 32_000,
      }] : []);
      await context.store.write({ models: catalog, checkedAt: Date.now() });
    },
    stream: (model, context, streamOptions) => streamByApi(model, context, streamOptions),
    streamSimple: (model, context, streamOptions) => streamByApi(model, context, streamOptions),
  };
}

export const builtinProviderFactories = Object.freeze({
  anthropic: anthropicProvider,
  deepseek: deepseekProvider,
  "github-copilot": githubCopilotProvider,
  google: googleProvider,
  "kimi-code": kimiCodeProvider,
  ollama: ollamaProvider,
  "openai-codex": openaiCodexProvider,
  openai: openaiProvider,
  opencode: opencodeProvider,
  "opencode-go": opencodeGoProvider,
  openrouter: openrouterProvider,
  xai: xaiProvider,
});

export function getBuiltinProviders(): readonly Provider[] {
  return Object.values(builtinProviderFactories).map((factory) => factory());
}

export function getBuiltinProvider(id: string): Provider | undefined {
  const factory = builtinProviderFactories[id as keyof typeof builtinProviderFactories];
  return factory?.();
}

export function apiProvider<TApi extends Api>(provider: Provider<TApi>): Provider<TApi> {
  return provider;
}

export function oauthAccessToken(credentials: OAuthCredentials): string {
  return credentials.access;
}
