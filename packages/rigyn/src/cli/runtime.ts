import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import {
  AuthStorage,
  CredentialBroker,
  createGatewayManagedOAuth,
  createKimiCodingAuthDescriptor,
  EnvironmentCredentialSource,
  ExplicitCredentialSource,
  ManagedProviderAuthDirectory,
  RefreshingStoredCredentialSource,
  ProviderAuthRegistry,
  providerDisplayName,
  type CredentialStore,
  type AuthCredential,
  type ProviderAuthBinding,
  type ProviderAuthDescriptor,
  refreshAnthropicOAuth,
  refreshGenericOAuthWithFetch,
  refreshGitHubCopilotOAuth,
} from "../auth/index.js";
import type { OAuthRegistrationConfig } from "../auth/registry.js";
import { XAI_OAUTH_REGISTRATION, XAI_OAUTH_REGISTRATION_ID } from "../auth/xai.js";
import {
  canonicalExistingPath,
  TrustStore,
} from "../config/index.js";
import type { ModelInfo, ModelProtocolFamily } from "../core/types.js";
import {
  DefaultResourceLoader,
  type ResourceLoader,
} from "../core/resource-loader.js";
import {
  DefaultPackageManager,
  type PackageActivationCandidate,
  type ResolvedPaths,
} from "../core/package-manager.js";
import { SettingsManager } from "../core/settings-manager.js";
import { BUILTIN_SLASH_COMMANDS } from "../core/slash-commands.js";
import { ProviderRegistry } from "../providers/registry.js";
import {
  ProviderCredentialStoreAdapter,
  createModels,
  providerOAuthCredential,
  type ProviderAuth,
} from "../providers/index.js";
import { ModelRegistry } from "../providers/model-registry.js";
import {
  providerFromAdapter,
  providerModelFromInfo,
} from "../providers/internal-runtime-bridge.js";
import { ProviderWireInterceptorRegistry } from "../providers/wire.js";
import { FileModelCatalogStore } from "../providers/model-catalog-store.js";
import { configuredModelsWithMaintainedCatalog } from "../providers/maintained-model-catalog.js";
import {
  AgentSession,
  createProviderAdapter,
  runtimeProviderId,
  type AgentSessionOptions,
  type RuntimeProviderConfig,
} from "../service/index.js";
import { runtimeProviderModelProtocolFamily } from "../service/internal-provider-protocol.js";
import { SessionManager } from "../storage/index.js";
import { bundledAuthoringResources } from "../prompts/resources.js";
import { sharedUserSkillRoots, sharedWorkspaceSkillRoots } from "../context/skill-roots.js";
import {
  ExtensionCatalog,
  type ExtensionPromptTemplate,
  type ExtensionTheme,
} from "../extensions/index.js";
import {
  appendDirectExtensions,
  bindDirectProviderWireLifecycle,
  loadDirectExtensions,
  RuntimeExtensionHost,
  type RuntimeDiscoverableResource,
  type RuntimeInlineExtension,
  type RuntimeDiscoveryView,
} from "../extensions/runtime.js";
import type { ExtensionCommandContextActions } from "../extensions/direct.js";
import { extensionSessionManager } from "../extensions/session-contract.js";
import { expandPath, agentPaths, type AgentPaths } from "./paths.js";
import { createNetworkTransport, type NetworkTransport } from "../net/index.js";
import { sha256 } from "../tools/hash.js";
import type { ToolExecutionBackend } from "../tools/backend.js";
import { parseKeybindingOverrides } from "../tui/keybindings.js";
import type { ProjectTrustResolver } from "./project-trust.js";

interface RuntimeProviderAuthRegistration {
  extensionId: string;
  sourcePath: string;
  descriptor: ProviderAuthDescriptor;
}

export interface LoadedRuntime {
  paths: AgentPaths;
  workspace: string;
  trusted: boolean;
  settings: SettingsManager;
  credentials: CredentialStore;
  broker: CredentialBroker;
  auth: ProviderAuthRegistry;
  providers: ProviderRegistry;
  modelRegistry: ModelRegistry;
  resourceLoader: ResourceLoader;
  network: NetworkTransport;
  sessionManager: SessionManager;
  session: AgentSession;
  extensions: ExtensionCatalog;
  runtimeExtensions: RuntimeExtensionHost;
  sessionDirectory?: string;
  generationSignal: AbortSignal;
  setExtensionShutdownHandler(handler: (() => unknown | Promise<unknown>) | undefined): void;
  reload(options?: RuntimeReloadOptions): Promise<RuntimeReloadResult>;
  close(): Promise<void>;
}

export interface RuntimeReloadOptions {
  signal?: AbortSignal;
  prepareExtensions?: (extensions: RuntimeExtensionHost) => void | Promise<void>;
  prepareSettings?: (settings: SettingsManager) => void | Promise<void>;
  onCommit?: () => void | Promise<void>;
}

export interface RuntimeReloadResult {
  warnings: string[];
}

export interface LoadedAuthRuntime {
  paths: AgentPaths;
  workspace: string;
  trusted: boolean;
  settings: SettingsManager;
  credentials: CredentialStore;
  auth: ProviderAuthRegistry;
  network: NetworkTransport;
  close(): Promise<void>;
}

interface RuntimeOptions {
  workspace?: string;
  projectTrusted?: boolean;
  ephemeral?: boolean;
  extensions?: boolean;
  extensionPaths?: readonly string[];
  /** Trusted in-process extension factories supplied by the embedding caller. */
  extensionFactories?: readonly RuntimeInlineExtension[];
  extensionRuntime?: boolean;
  skills?: boolean;
  skillPaths?: readonly string[];
  promptTemplates?: boolean;
  promptTemplatePaths?: readonly string[];
  themes?: boolean;
  themePaths?: readonly string[];
  systemPrompt?: string;
  appendSystemPrompt?: readonly string[];
  apiKey?: string;
  apiKeyProvider?: string;
  sessionDirectory?: string;
  sessionFile?: string;
  continueRecent?: boolean;
  offline?: boolean;
  /** Populate cached model state at startup without waiting for live discovery. */
  deferModelNetworkRefresh?: boolean;
  sessionManager?: SessionManager;
  /** Already-active user and invocation extensions used for project trust. */
  preactivatedRuntimeExtensions?: RuntimeExtensionHost;
  /** Invocation-scoped project trust policy shared across workspace changes. */
  projectTrustResolver?: ProjectTrustResolver;
}

const RUNTIME_RELOAD_TIMEOUT_MS = 60_000;
const RUNTIME_PROVIDER_DISPOSAL_TIMEOUT_MS = 1_000;
const RUNTIME_GENERATION_CLOSE_TIMEOUT_MS = 25_000;
const RUNTIME_RELOAD_CLOSE_WAIT_TIMEOUT_MS = 40_000;
const RUNTIME_MODEL_CATALOG_MAX_BYTES = 8 * 1024 * 1024;

interface StoredModelCatalog {
  version: 1;
  savedAt: string;
  providers: Array<Record<string, unknown> & { provider: string }>;
}

interface ModelCatalogRollback {
  source: string | undefined;
}

function storedModelCatalog(source: string, label: string): StoredModelCatalog {
  const value = JSON.parse(source) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.savedAt !== "string" || !Array.isArray(record.providers)) {
    throw new Error(`${label} has an unsupported format`);
  }
  const providers: StoredModelCatalog["providers"] = [];
  const seen = new Set<string>();
  for (const provider of record.providers) {
    if (provider === null || typeof provider !== "object" || Array.isArray(provider)) {
      throw new Error(`${label} contains an invalid provider record`);
    }
    const selected = provider as Record<string, unknown>;
    if (typeof selected.provider !== "string" || selected.provider.trim() === "" || seen.has(selected.provider)) {
      throw new Error(`${label} contains an invalid provider ID`);
    }
    seen.add(selected.provider);
    providers.push(selected as StoredModelCatalog["providers"][number]);
  }
  return { version: 1, savedAt: record.savedAt, providers };
}

function restoreExtensionCatalogProviders(
  currentSource: string,
  baselineSource: string | undefined,
  providerIds: readonly string[],
): string {
  const current = storedModelCatalog(currentSource, "Current model catalog");
  const baseline = baselineSource === undefined
    ? undefined
    : storedModelCatalog(baselineSource, "Baseline model catalog");
  const selected = new Set(providerIds);
  const currentByProvider = new Map(current.providers.map((entry) => [entry.provider, entry]));
  const baselineByProvider = new Map((baseline?.providers ?? []).map((entry) => [entry.provider, entry]));
  if ([...selected].every((provider) =>
    JSON.stringify(currentByProvider.get(provider)) === JSON.stringify(baselineByProvider.get(provider)))) {
    return currentSource;
  }
  const providers = current.providers.filter((entry) => !selected.has(entry.provider));
  for (const entry of baseline?.providers ?? []) {
    if (selected.has(entry.provider)) providers.push(entry);
  }
  providers.sort((left, right) => left.provider.localeCompare(right.provider));
  return JSON.stringify({ ...current, providers });
}

async function stageExtensionCatalogBaseline(
  store: FileModelCatalogStore,
  baselineSource: string | undefined,
  providerIds: readonly string[],
): Promise<ModelCatalogRollback | undefined> {
  if (providerIds.length === 0) return undefined;
  const source = await store.read(RUNTIME_MODEL_CATALOG_MAX_BYTES);
  const basis = source ?? baselineSource;
  if (basis === undefined) return undefined;
  const restored = restoreExtensionCatalogProviders(basis, baselineSource, providerIds);
  if (source === restored) return undefined;
  await store.write(restored);
  return { source };
}

async function restoreModelCatalogRollback(
  store: FileModelCatalogStore,
  rollback: ModelCatalogRollback | undefined,
): Promise<void> {
  if (rollback === undefined) return;
  if (rollback.source === undefined) await store.remove();
  else await store.write(rollback.source);
}

interface RuntimeResourceGeneration {
  trusted: boolean;
  settings: SettingsManager;
  auth: ProviderAuthRegistry;
  providers: ProviderRegistry;
  modelRegistry: ModelRegistry;
  resourceLoader: ResourceLoader;
  network: NetworkTransport;
  providerWire: ProviderWireInterceptorRegistry;
  extensions: ExtensionCatalog;
  runtimeExtensions: RuntimeExtensionHost;
  sessionDirectory?: string;
  extraTools: NonNullable<AgentSessionOptions["tools"]>;
  toolBackend?: ToolExecutionBackend;
  abortController: AbortController;
  modelCatalogBaseline: string | undefined;
  extensionCatalogProviderIds: readonly string[];
  close(): Promise<void>;
}

export async function createCredentialStore(
  paths: AgentPaths,
  _options: { createLocalKey?: boolean; environment?: NodeJS.ProcessEnv; allowPlatformKeychain?: boolean } = {},
): Promise<CredentialStore> {
  return AuthStorage.create(paths.auth);
}

const BUILTIN_ROUTE_CATALOG_OBSERVED_AT = "2026-07-19T00:00:00.000Z";

function builtinRouteModel(
  provider: string,
  id: string,
  protocolFamily: ModelProtocolFamily,
): ModelInfo {
  const capability = (value: "supported" | "unknown") => ({
    value,
    source: "maintained" as const,
    observedAt: BUILTIN_ROUTE_CATALOG_OBSERVED_AT,
  });
  return {
    id,
    provider,
    capabilities: {
      tools: capability("supported"),
      reasoning: capability("unknown"),
      images: capability("unknown"),
    },
    compatibility: {
      protocolFamily: {
        value: protocolFamily,
        source: "maintained",
        observedAt: BUILTIN_ROUTE_CATALOG_OBSERVED_AT,
      },
    },
  };
}

function builtinRoutes(
  provider: string,
  adapter: string,
  protocolFamily: ModelProtocolFamily,
  ids: readonly string[],
) {
  return ids.map((model) => ({
    model,
    adapter,
    protocolFamily,
    modelInfo: builtinRouteModel(provider, model, protocolFamily),
  }));
}

const OPENCODE_BASE_URL = "https://opencode.ai/zen";
const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go";
const CLOUDFLARE_ACCOUNT_PLACEHOLDER = "{CLOUDFLARE_ACCOUNT_ID}";
const CLOUDFLARE_GATEWAY_PLACEHOLDER = "{CLOUDFLARE_GATEWAY_ID}";
const CLOUDFLARE_WORKERS_BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_PLACEHOLDER}/ai/v1`;
const CLOUDFLARE_GATEWAY_BASE_URL = `https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_PLACEHOLDER}/${CLOUDFLARE_GATEWAY_PLACEHOLDER}`;

export const BUILTIN_PROVIDER_CONFIGS: Readonly<Record<string, RuntimeProviderConfig>> = Object.freeze({
  openai: { kind: "openai" },
  "openai-codex": { kind: "openai-codex" },
  anthropic: { kind: "anthropic" },
  "github-copilot": { kind: "github-copilot" },
  gemini: { kind: "gemini", protocol: "generate-content" },
  bedrock: { kind: "bedrock" },
  mistral: { kind: "mistral" },
  openrouter: { kind: "openrouter" },
  ollama: { kind: "ollama" },
  "llama.cpp": { kind: "llama-router", id: "llama.cpp", baseUrl: "http://127.0.0.1:8080" },
  groq: {
    kind: "openai-compatible",
    id: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    credentialProvider: "groq",
  },
  together: {
    kind: "openai-compatible",
    id: "together",
    baseUrl: "https://api.together.ai/v1",
    credentialProvider: "together",
  },
  deepseek: {
    kind: "openai-compatible",
    id: "deepseek",
    baseUrl: "https://api.deepseek.com",
    credentialProvider: "deepseek",
  },
  cerebras: {
    kind: "openai-compatible",
    id: "cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    credentialProvider: "cerebras",
  },
  xai: {
    kind: "routed",
    id: "xai",
    credentialProvider: "xai",
    adapters: {
      responses: {
        kind: "openai",
        baseUrl: "https://api.x.ai/v1",
        credentialProvider: "xai",
      },
      chat: {
        kind: "openai-compatible",
        id: "xai-chat",
        baseUrl: "https://api.x.ai/v1",
        credentialProvider: "xai",
      },
    },
    routes: [
      { model: "grok-4.3", adapter: "chat", protocolFamily: "openai-chat-completions" },
      { model: "grok-4.5", adapter: "responses", protocolFamily: "openai-responses" },
      { model: "grok-build-0.1", adapter: "chat", protocolFamily: "openai-chat-completions" },
    ],
  },
  fireworks: {
    kind: "routed",
    id: "fireworks",
    credentialProvider: "fireworks",
    adapters: {
      messages: {
        kind: "anthropic",
        id: "fireworks-messages",
        baseUrl: "https://api.fireworks.ai/inference",
        promptCache: "5m",
      },
      chat: {
        kind: "openai-compatible",
        id: "fireworks-chat",
        baseUrl: "https://api.fireworks.ai/inference/v1",
      },
    },
    routes: [
      ...builtinRoutes("fireworks", "messages", "anthropic-messages", [
        "accounts/fireworks/models/deepseek-v4-flash",
        "accounts/fireworks/models/deepseek-v4-pro",
        "accounts/fireworks/models/glm-5p1",
        "accounts/fireworks/models/gpt-oss-120b",
        "accounts/fireworks/models/gpt-oss-20b",
        "accounts/fireworks/models/kimi-k2p6",
        "accounts/fireworks/models/kimi-k2p7-code",
        "accounts/fireworks/models/minimax-m2p7",
        "accounts/fireworks/models/minimax-m3",
        "accounts/fireworks/models/qwen3p7-plus",
        "accounts/fireworks/routers/glm-5p1-fast",
        "accounts/fireworks/routers/kimi-k2p6-fast",
        "accounts/fireworks/routers/kimi-k2p6-turbo",
        "accounts/fireworks/routers/kimi-k2p7-code-fast",
      ]),
      ...builtinRoutes("fireworks", "chat", "openai-chat-completions", [
        "accounts/fireworks/models/glm-5p2",
        "accounts/fireworks/routers/glm-5p2-fast",
      ]),
    ],
  },
  huggingface: {
    kind: "openai-compatible",
    id: "huggingface",
    baseUrl: "https://router.huggingface.co/v1",
    credentialProvider: "huggingface",
  },
  "vercel-ai-gateway": {
    kind: "anthropic",
    id: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    credentialProvider: "vercel-ai-gateway",
  },
  "qwen-token-plan": {
    kind: "openai-compatible",
    id: "qwen-token-plan",
    baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    credentialProvider: "qwen-token-plan",
  },
  "qwen-token-plan-cn": {
    kind: "openai-compatible",
    id: "qwen-token-plan-cn",
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    credentialProvider: "qwen-token-plan-cn",
  },
  zai: {
    kind: "openai-compatible",
    id: "zai",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    credentialProvider: "zai",
    profile: "zai",
  },
  "zai-coding-cn": {
    kind: "openai-compatible",
    id: "zai-coding-cn",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    credentialProvider: "zai-coding-cn",
    profile: "zai",
  },
  "ant-ling": {
    kind: "openai-compatible",
    id: "ant-ling",
    baseUrl: "https://api.ant-ling.com/v1",
    credentialProvider: "ant-ling",
  },
  nvidia: {
    kind: "openai-compatible",
    id: "nvidia",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    credentialProvider: "nvidia",
  },
  xiaomi: {
    kind: "openai-compatible",
    id: "xiaomi",
    baseUrl: "https://api.xiaomimimo.com/v1",
    credentialProvider: "xiaomi",
    profile: "xiaomi",
  },
  moonshotai: {
    kind: "openai-compatible",
    id: "moonshotai",
    baseUrl: "https://api.moonshot.ai/v1",
    credentialProvider: "moonshotai",
    profile: "moonshot",
  },
  "moonshotai-cn": {
    kind: "openai-compatible",
    id: "moonshotai-cn",
    baseUrl: "https://api.moonshot.cn/v1",
    credentialProvider: "moonshotai-cn",
    profile: "moonshot",
  },
  "xiaomi-token-plan-cn": {
    kind: "openai-compatible",
    id: "xiaomi-token-plan-cn",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    credentialProvider: "xiaomi-token-plan-cn",
    profile: "xiaomi",
  },
  "xiaomi-token-plan-ams": {
    kind: "openai-compatible",
    id: "xiaomi-token-plan-ams",
    baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
    credentialProvider: "xiaomi-token-plan-ams",
    profile: "xiaomi",
  },
  "xiaomi-token-plan-sgp": {
    kind: "openai-compatible",
    id: "xiaomi-token-plan-sgp",
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    credentialProvider: "xiaomi-token-plan-sgp",
    profile: "xiaomi",
  },
  opencode: {
    kind: "routed",
    id: "opencode",
    credentialProvider: "opencode",
    adapters: {
      responses: { kind: "openai", baseUrl: `${OPENCODE_BASE_URL}/v1` },
      messages: { kind: "anthropic", id: "opencode-messages", baseUrl: OPENCODE_BASE_URL },
      gemini: {
        kind: "gemini",
        protocol: "generate-content",
        baseUrl: `${OPENCODE_BASE_URL}/v1`,
      },
      chat: {
        kind: "openai-compatible",
        id: "opencode-chat",
        baseUrl: `${OPENCODE_BASE_URL}/v1`,
        profile: "opencode",
      },
      "chat-kimi": {
        kind: "openai-compatible",
        id: "opencode-chat-kimi",
        baseUrl: `${OPENCODE_BASE_URL}/v1`,
        profile: "moonshot",
      },
    },
    routes: [
      ...builtinRoutes("opencode", "messages", "anthropic-messages", [
        "claude-fable-5", "claude-haiku-4-5", "claude-opus-4-1", "claude-opus-4-5",
        "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4",
        "claude-sonnet-4-5", "claude-sonnet-4-6", "claude-sonnet-5", "qwen3.5-plus", "qwen3.6-plus",
      ]),
      ...builtinRoutes("opencode", "gemini", "gemini-generate-content", [
        "gemini-3-flash", "gemini-3.1-pro", "gemini-3.5-flash",
      ]),
      ...builtinRoutes("opencode", "responses", "openai-responses", [
        "gpt-5", "gpt-5-codex", "gpt-5-nano", "gpt-5.1", "gpt-5.1-codex",
        "gpt-5.1-codex-max", "gpt-5.1-codex-mini", "gpt-5.2", "gpt-5.2-codex",
        "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.4-pro",
        "gpt-5.5", "gpt-5.5-pro", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "grok-4.5",
      ]),
      ...builtinRoutes("opencode", "chat-kimi", "openai-chat-completions", ["kimi-k2.6"]),
      ...builtinRoutes("opencode", "chat", "openai-chat-completions", [
        "big-pickle", "deepseek-v4-flash", "deepseek-v4-flash-free", "deepseek-v4-pro", "glm-5",
        "glm-5.1", "glm-5.2", "grok-build-0.1", "hy3-free", "kimi-k2.5",
        "kimi-k2.7-code", "mimo-v2.5-free", "minimax-m2.5", "minimax-m2.7", "minimax-m3",
        "nemotron-3-ultra-free", "north-mini-code-free",
      ]),
    ],
  },
  "opencode-go": {
    kind: "routed",
    id: "opencode-go",
    credentialProvider: "opencode-go",
    adapters: {
      messages: { kind: "anthropic", id: "opencode-go-messages", baseUrl: OPENCODE_GO_BASE_URL },
      responses: { kind: "openai", baseUrl: `${OPENCODE_GO_BASE_URL}/v1` },
      chat: {
        kind: "openai-compatible",
        id: "opencode-go-chat",
        baseUrl: `${OPENCODE_GO_BASE_URL}/v1`,
        profile: "opencode",
      },
      "chat-kimi": {
        kind: "openai-compatible",
        id: "opencode-go-chat-kimi",
        baseUrl: `${OPENCODE_GO_BASE_URL}/v1`,
        profile: "moonshot",
      },
    },
    routes: [
      ...builtinRoutes("opencode-go", "messages", "anthropic-messages", [
        "minimax-m3", "qwen3.7-max", "qwen3.7-plus",
      ]),
      ...builtinRoutes("opencode-go", "responses", "openai-responses", ["grok-4.5"]),
      ...builtinRoutes("opencode-go", "chat-kimi", "openai-chat-completions", ["kimi-k2.6"]),
      ...builtinRoutes("opencode-go", "chat", "openai-chat-completions", [
        "deepseek-v4-flash", "deepseek-v4-pro", "glm-5.1", "glm-5.2",
        "kimi-k2.7-code", "kimi-k3", "mimo-v2.5", "mimo-v2.5-pro", "minimax-m2.7",
        "qwen3.6-plus",
      ]),
    ],
  },
  "cloudflare-workers-ai": {
    kind: "routed",
    id: "cloudflare-workers-ai",
    credentialProvider: "cloudflare-workers-ai",
    adapters: {
      chat: {
        kind: "openai-compatible",
        id: "cloudflare-workers-ai-chat",
        baseUrl: CLOUDFLARE_WORKERS_BASE_URL,
      },
    },
    routes: builtinRoutes("cloudflare-workers-ai", "chat", "openai-chat-completions", [
      "@cf/google/gemma-4-26b-a4b-it", "@cf/ibm-granite/granite-4.0-h-micro",
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-4-scout-17b-16e-instruct",
      "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/moonshotai/kimi-k2.6",
      "@cf/moonshotai/kimi-k2.7-code", "@cf/nvidia/nemotron-3-120b-a12b",
      "@cf/openai/gpt-oss-120b", "@cf/openai/gpt-oss-20b", "@cf/qwen/qwen3-30b-a3b-fp8",
      "@cf/zai-org/glm-4.7-flash", "@cf/zai-org/glm-5.2",
    ]),
  },
  "cloudflare-ai-gateway": {
    kind: "routed",
    id: "cloudflare-ai-gateway",
    credentialProvider: "cloudflare-ai-gateway",
    adapters: {
      messages: {
        kind: "anthropic",
        id: "cloudflare-ai-gateway-messages",
        baseUrl: `${CLOUDFLARE_GATEWAY_BASE_URL}/anthropic`,
      },
      responses: { kind: "openai", baseUrl: `${CLOUDFLARE_GATEWAY_BASE_URL}/openai` },
      chat: {
        kind: "openai-compatible",
        id: "cloudflare-ai-gateway-chat",
        baseUrl: `${CLOUDFLARE_GATEWAY_BASE_URL}/compat`,
        profile: "cloudflare-ai-gateway",
      },
    },
    routes: [
      ...builtinRoutes("cloudflare-ai-gateway", "messages", "anthropic-messages", [
        "claude-3-5-haiku", "claude-3-haiku", "claude-3-opus", "claude-3-sonnet",
        "claude-3.5-haiku", "claude-3.5-sonnet", "claude-fable-5", "claude-haiku-4-5",
        "claude-opus-4", "claude-opus-4-1", "claude-opus-4-5", "claude-opus-4-6",
        "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4", "claude-sonnet-4-5",
        "claude-sonnet-4-6", "claude-sonnet-5",
      ]),
      ...builtinRoutes("cloudflare-ai-gateway", "responses", "openai-responses", [
        "gpt-4", "gpt-4-turbo", "gpt-4o", "gpt-4o-mini", "gpt-5.1", "gpt-5.1-codex",
        "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.4", "gpt-5.5",
        "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "o1", "o3", "o3-mini", "o3-pro", "o4-mini",
      ]),
      ...builtinRoutes("cloudflare-ai-gateway", "chat", "openai-chat-completions", [
        "workers-ai/@cf/moonshotai/kimi-k2.5", "workers-ai/@cf/moonshotai/kimi-k2.6",
        "workers-ai/@cf/nvidia/nemotron-3-120b-a12b", "workers-ai/@cf/zai-org/glm-4.7-flash",
        "workers-ai/@cf/zai-org/glm-5.2",
      ]),
    ],
  },
  "kimi-coding": {
    kind: "anthropic",
    id: "kimi-coding",
    baseUrl: "https://api.kimi.com/coding",
    credentialProvider: "kimi-coding",
  },
  minimax: {
    kind: "anthropic",
    id: "minimax",
    baseUrl: "https://api.minimax.io/anthropic",
    credentialProvider: "minimax",
  },
  "minimax-cn": {
    kind: "anthropic",
    id: "minimax-cn",
    baseUrl: "https://api.minimaxi.com/anthropic",
    credentialProvider: "minimax-cn",
  },
});

export function runtimeProviderAuthBinding(
  configuredName: string,
  providerConfig: RuntimeProviderConfig,
  providerId: string,
): ProviderAuthBinding {
  const credentialId = providerConfig.credentialProvider ?? providerId;
  const remoteOllama = providerConfig.kind === "ollama" && (() => {
    const hostname = new URL(providerConfig.host ?? "http://127.0.0.1:11434").hostname;
    return !["127.0.0.1", "localhost", "::1"].includes(hostname);
  })();
  const remoteLlamaRouter = providerConfig.kind === "llama-router" && (() => {
    const hostname = new URL(providerConfig.baseUrl ?? "http://127.0.0.1:8080").hostname;
    return !["127.0.0.1", "localhost", "::1"].includes(hostname);
  })();
  return {
    providerId,
    credentialId,
    displayName: providerConfig.kind === "anthropic" && providerId === "anthropic"
      ? "Anthropic (Claude Pro/Max)"
      : providerDisplayName(
          providerConfig.kind === "openai-compatible" || providerConfig.kind === "routed"
            ? configuredName
            : providerId,
        ),
    ...(providerConfig.kind === "openai-codex"
      ? {}
      : providerConfig.kind === "vertex" || providerConfig.kind === "bedrock" ||
          providerConfig.kind === "gateway-messages" || remoteOllama || remoteLlamaRouter
      ? { secret: "bearer" as const }
      : providerConfig.kind === "ollama" || providerConfig.kind === "llama-router"
        ? {}
        : { secret: "api_key" as const }),
    ...(providerConfig.kind === "gemini" || providerConfig.kind === "vertex"
      ? { ambient: "google" as const }
      : providerConfig.kind === "azure-openai"
        ? { ambient: "azure" as const }
        : providerConfig.kind === "bedrock"
          ? { ambient: "aws" as const }
          : {}),
    ...(providerConfig.kind === "ollama" && !remoteOllama ? { local: true } : {}),
    ...(providerConfig.kind === "llama-router" && !remoteLlamaRouter ? { local: true } : {}),
    ...(providerConfig.kind === "openrouter" ? { openRouterBrowser: true } : {}),
    ...(providerConfig.kind === "openai-codex" ? { openAICodex: true } : {}),
    ...(providerConfig.kind === "anthropic" && providerId === "anthropic" ? { anthropicOAuth: true } : {}),
    ...(providerConfig.kind === "github-copilot" ? { githubCopilotOAuth: true } : {}),
  };
}

function cloudflarePathSegment(value: string | undefined, label: string): string {
  const selected = value?.trim();
  if (
    selected === undefined || selected === "" || selected.includes("\0") ||
    /[\r\n]/u.test(selected) || Buffer.byteLength(selected, "utf8") > 512
  ) {
    throw new Error(`${label} is required and must be a single value no larger than 512 bytes`);
  }
  return encodeURIComponent(selected);
}

function credentialSecret(credential: AuthCredential | undefined): string | undefined {
  if (credential === undefined || credential.kind === "ambient") return undefined;
  return credential.kind === "api_key" ? credential.apiKey : credential.accessToken;
}

function credentialAccountId(credential: AuthCredential | undefined): string | undefined {
  return credential === undefined || credential.kind === "ambient" ? undefined : credential.accountId;
}

export function registerCloudflareWireInterceptors(
  wire: ProviderWireInterceptorRegistry,
  broker: CredentialBroker,
  environment: NodeJS.ProcessEnv,
): void {
  wire.register("cloudflare-workers-ai", {
    async interceptRequest(request, signal) {
      const placeholder = encodeURIComponent(CLOUDFLARE_ACCOUNT_PLACEHOLDER);
      if (!request.url.includes(placeholder)) return;
      const resolved = await broker.resolve({ provider: "cloudflare-workers-ai", signal });
      const accountId = cloudflarePathSegment(
        credentialAccountId(resolved?.credential) ?? environment.CLOUDFLARE_ACCOUNT_ID,
        "CLOUDFLARE_ACCOUNT_ID",
      );
      return { url: request.url.replaceAll(placeholder, accountId) };
    },
  });
  wire.register("cloudflare-ai-gateway", {
    async interceptRequest(request, signal) {
      const resolved = await broker.resolve({ provider: "cloudflare-ai-gateway", signal });
      const secret = credentialSecret(resolved?.credential);
      if (secret === undefined) throw new Error("Cloudflare AI Gateway credentials are unavailable");
      const accountPlaceholder = encodeURIComponent(CLOUDFLARE_ACCOUNT_PLACEHOLDER);
      const gatewayPlaceholder = encodeURIComponent(CLOUDFLARE_GATEWAY_PLACEHOLDER);
      let url = request.url;
      if (url.includes(accountPlaceholder)) {
        url = url.replaceAll(accountPlaceholder, cloudflarePathSegment(
          credentialAccountId(resolved?.credential) ?? environment.CLOUDFLARE_ACCOUNT_ID,
          "CLOUDFLARE_ACCOUNT_ID",
        ));
      }
      if (url.includes(gatewayPlaceholder)) {
        url = url.replaceAll(gatewayPlaceholder, cloudflarePathSegment(
          environment.CLOUDFLARE_GATEWAY_ID,
          "CLOUDFLARE_GATEWAY_ID",
        ));
      }
      return {
        ...(url === request.url ? {} : { url }),
        headers: {
          authorization: null,
          "x-api-key": null,
          "cf-aig-authorization": `Bearer ${secret}`,
        },
      };
    },
  });
}

function configuredProviderConfigs(
  settings: SettingsManager,
  environment: NodeJS.ProcessEnv,
): Record<string, RuntimeProviderConfig> {
  const providerConfigs = { ...BUILTIN_PROVIDER_CONFIGS };
  const codex = providerConfigs["openai-codex"];
  if (codex?.kind === "openai-codex") {
    const {
      transport: _transport,
      webSocketConnectTimeoutMs: _webSocketConnectTimeoutMs,
      ...base
    } = codex;
    const connectTimeoutMs = settings.getWebSocketConnectTimeoutMs();
    providerConfigs["openai-codex"] = {
      ...base,
      transport: settings.getTransport(),
      ...(connectTimeoutMs === undefined ? {} : { webSocketConnectTimeoutMs: connectTimeoutMs }),
    };
  }
  const llamaBaseUrl = environment.LLAMA_BASE_URL?.trim();
  if (llamaBaseUrl !== undefined && llamaBaseUrl !== "") {
    providerConfigs["llama.cpp"] = {
      kind: "llama-router",
      id: "llama.cpp",
      baseUrl: llamaBaseUrl,
    };
  }
  const radiusGateway = environment.RADIUS_GATEWAY?.trim();
  if (radiusGateway !== undefined && radiusGateway !== "") {
    providerConfigs.radius = {
      kind: "gateway-messages",
      id: "radius",
      gatewayUrl: /^https?:\/\//iu.test(radiusGateway) ? radiusGateway : `https://${radiusGateway}`,
      managedOAuth: true,
    };
  }
  const radius = providerConfigs.radius;
  if (radius?.kind === "gateway-messages" && radius.managedOAuth === undefined) {
    providerConfigs.radius = { ...radius, managedOAuth: true };
  }
  return providerConfigs;
}

function networkOptions(settings: SettingsManager, environment: NodeJS.ProcessEnv) {
  const proxy = settings.getHttpProxy();
  const idleTimeoutMs = settings.getHttpIdleTimeoutMs();
  return {
    environment,
    ...(proxy === undefined ? {} : { proxy: { all: proxy } }),
    headersTimeoutMs: idleTimeoutMs,
    bodyTimeoutMs: idleTimeoutMs,
  };
}

async function reloadRuntimeSettings(settings: SettingsManager): Promise<void> {
  settings.drainErrors();
  await settings.reload();
  const failures = settings.drainErrors();
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `Settings could not be loaded: ${failures.map((failure) => `${failure.scope}: ${failure.error.message}`).join("; ")}`,
    );
  }
  settings.getToolSettings();
  settings.getRetrySettings();
  settings.getProviderRetrySettings();
  parseKeybindingOverrides(settings.getKeybindings());
}

function configuredOAuthRegistrations(
  bindings: readonly ProviderAuthBinding[],
): Record<string, OAuthRegistrationConfig> {
  const registrations: Record<string, OAuthRegistrationConfig> = {};
  if (bindings.some((binding) => binding.providerId === "xai" && binding.credentialId === "xai")) {
    if (Object.hasOwn(registrations, XAI_OAUTH_REGISTRATION_ID)) {
      throw new Error(`OAuth registration ID is reserved: ${XAI_OAUTH_REGISTRATION_ID}`);
    }
    registrations[XAI_OAUTH_REGISTRATION_ID] = XAI_OAUTH_REGISTRATION;
  }
  return registrations;
}

function directProviderAuth(
  providerId: string,
  broker: CredentialBroker,
  auth: ProviderAuthRegistry,
  lifecycleSignal: AbortSignal,
): ProviderAuth {
  const resolvedAuth = async (signal?: AbortSignal) => {
    const requestSignal = signal === undefined
      ? lifecycleSignal
      : AbortSignal.any([lifecycleSignal, signal]);
    requestSignal.throwIfAborted();
    if (!auth.has(providerId)) return undefined;
    const binding = auth.binding(providerId);
    const resolved = await broker.resolve({
      provider: binding.credentialId,
      signal: requestSignal,
    });
    if (resolved === undefined) {
      return binding.externallyManaged === true
        ? { auth: {}, source: "provider extension" }
        : undefined;
    }
    const request = auth.descriptor(providerId)?.request;
    const credential = resolved.credential;
    if (credential.kind === "ambient") return { auth: {}, source: resolved.source };
    const key = credential.kind === "api_key" ? credential.apiKey : credential.accessToken;
    const headers: Record<string, string> = {};
    if (credential.kind === "api_key" && request?.apiKey !== undefined) {
      headers[request.apiKey.header] = `${request.apiKey.prefix ?? ""}${key}`;
    } else if (credential.kind !== "api_key" && request?.bearer !== undefined) {
      headers[request.bearer.header] = `${request.bearer.prefix ?? "Bearer "}${key}`;
    }
    return {
      auth: {
        apiKey: key,
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
      },
      source: resolved.source,
    };
  };
  return {
    apiKey: {
      name: providerDisplayName(providerId),
      async resolve({ credential }) {
        if (credential?.key !== undefined) return { auth: { apiKey: credential.key }, source: "stored credential" };
        return await resolvedAuth();
      },
    },
    oauth: {
      name: providerDisplayName(providerId),
      async login() {
        throw new Error(`Use /login ${providerId} to authenticate this provider`);
      },
      async refresh(credential, signal) {
        const requestSignal = signal === undefined
          ? lifecycleSignal
          : AbortSignal.any([lifecycleSignal, signal]);
        requestSignal.throwIfAborted();
        const resolved = auth.has(providerId)
          ? await broker.resolve({ provider: auth.binding(providerId).credentialId, signal: requestSignal })
          : undefined;
        return resolved === undefined ? credential : providerOAuthCredential(resolved.credential) ?? credential;
      },
      async toAuth(credential) {
        const request = auth.descriptor(providerId)?.request;
        return {
          apiKey: credential.access,
          ...(request?.bearer === undefined
            ? {}
            : { headers: { [request.bearer.header]: `${request.bearer.prefix ?? "Bearer "}${credential.access}` } }),
        };
      },
    },
  };
}

export async function loadAuthRuntime(options: {
  workspace?: string;
  createLocalKey?: boolean;
  additionalCredentialIds?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  allowPlatformKeychain?: boolean;
} = {}): Promise<LoadedAuthRuntime> {
  const environment = options.environment ?? process.env;
  const paths = agentPaths(environment);
  const workspace = await canonicalExistingPath(resolve(options.workspace ?? process.cwd()));
  const trust = new TrustStore(paths.trustStore);
  const trusted = await trust.isTrusted(workspace);
  const settings = SettingsManager.create(workspace, paths.agentDirectory, { projectTrusted: trusted });
  await reloadRuntimeSettings(settings);
  const network = createNetworkTransport(networkOptions(settings, environment));
  const credentials = await createCredentialStore(paths, {
    ...(options.createLocalKey === undefined ? {} : { createLocalKey: options.createLocalKey }),
    environment,
    ...(options.allowPlatformKeychain === undefined ? {} : { allowPlatformKeychain: options.allowPlatformKeychain }),
  });
  const bindings = Object.entries(configuredProviderConfigs(settings, environment)).map(([configuredName, providerConfig]) => {
    const providerId = runtimeProviderId(providerConfig);
    return runtimeProviderAuthBinding(configuredName, providerConfig, providerId);
  });
  const registered = new Set(bindings.map((binding) => binding.providerId));
  for (const id of options.additionalCredentialIds ?? []) {
    if (registered.has(id)) continue;
    bindings.push({
      providerId: id,
      credentialId: id,
      displayName: providerDisplayName(id),
      externallyManaged: true,
    });
    registered.add(id);
  }
  const auth = new ProviderAuthRegistry({
    bindings,
    registrations: configuredOAuthRegistrations(bindings),
    store: credentials,
    environment,
  });
  if (auth.has("kimi-coding")) {
    auth.registerDescriptor("rigyn-core", createKimiCodingAuthDescriptor({
      fetch: network.fetch,
      environment,
    }));
  }
  return {
    paths,
    workspace,
    trusted,
    settings,
    credentials,
    auth,
    network,
    async close() {
      await network.close();
    },
  };
}

function throwFailures(failures: unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function settleWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function settleWithin<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await settleWithSignal(operation, signal);
  } catch (error) {
    if (signal.aborted) throw new Error(`${label} timed out after ${timeoutMs}ms`, { cause: error });
    throw error;
  }
}

function agentSessionResources(
  generation: RuntimeResourceGeneration,
): Omit<AgentSessionOptions, "sessionManager" | "workspace" | "model" | "thinkingLevel"> {
  const settings = generation.settings;
  return {
    providers: generation.providers,
    modelRegistry: generation.modelRegistry,
    resourceLoader: generation.resourceLoader,
    extensionRunner: generation.runtimeExtensions,
    providerWireLifecycle: generation.providerWire,
    providerDisplayNameOverride(provider, displayName) {
      return generation.auth.has(provider)
        ? generation.auth.overrideDisplayName(provider, displayName)
        : undefined;
    },
    settingsManager: settings,
    tools: generation.extraTools,
    outboundImages: settings.getBlockImages() ? "block" : "allow",
    ...(generation.toolBackend === undefined ? {} : { toolBackend: generation.toolBackend }),
    autoCompaction: settings.getCompactionEnabled(),
    compactionReserveTokens: settings.getCompactionReserveTokens(),
    compactionKeepRecentTokens: settings.getCompactionKeepRecentTokens(),
    imageAutoResize: settings.getImageAutoResize(),
  };
}

function directResourceCatalog(
  host: RuntimeExtensionHost,
  loader: ResourceLoader,
): ExtensionCatalog {
  const entries = host.extensions();
  const ownerForPath = (path: string): string | undefined => {
    const target = resolve(path);
    return entries
      .filter((entry) => {
        const root = resolve(entry.resourceRoot ?? entry.sourcePath);
        return target === root || target.startsWith(`${root}${sep}`);
      })
      .sort((left, right) =>
        resolve(right.resourceRoot ?? right.sourcePath).length
        - resolve(left.resourceRoot ?? left.sourcePath).length)[0]?.extensionId;
  };
  const prompts: ExtensionPromptTemplate[] = loader.getPrompts().prompts.map((prompt) => ({
    id: prompt.name,
    extensionId: ownerForPath(prompt.filePath) ?? "prompt-template",
    ...(prompt.description === "" ? {} : { description: prompt.description }),
    ...(prompt.argumentHint === undefined ? {} : { argumentHint: prompt.argumentHint }),
    sourcePath: prompt.filePath,
    sha256: sha256(prompt.content),
    template: prompt.content,
  }));
  const themes: ExtensionTheme[] = loader.getThemes().themes.map((theme) => ({
    ...theme,
    extensionId: ownerForPath(theme.sourcePath) ?? theme.extensionId,
  }));
  const commands = host.commands();
  const skills = loader.getSkills().skills;
  const metadata = entries.map((entry, index) => {
    const scope = entry.scope ?? "project";
    const root = resolve(entry.resourceRoot ?? entry.sourcePath);
    return {
      id: entry.extensionId,
      name: entry.extensionId,
      scope,
      trusted: entry.trusted ?? true,
      status: "active" as const,
      sourceRoot: root,
      extensionRoot: root,
      manifestPath: entry.sourcePath,
      manifestSha256: entry.sha256,
      precedence: index,
      contributions: {
        skillRoots: skills.filter((skill) => ownerForPath(skill.filePath) === entry.extensionId).length,
        prompts: prompts.filter((prompt) => prompt.extensionId === entry.extensionId).length,
        commands: commands.filter((command) => command.extensionId === entry.extensionId).length,
        themes: themes.filter((theme) => theme.extensionId === entry.extensionId).length,
        runtime: 1,
      },
    };
  });
  return new ExtensionCatalog(
    metadata,
    host.diagnostics().map((diagnostic) => ({
      severity: "warning" as const,
      code: "RUNTIME_EXTENSION_DIAGNOSTIC",
      message: diagnostic.message,
      path: diagnostic.sourcePath,
      extensionId: diagnostic.extensionId,
    })),
    {
      skillRoots: [],
      prompts: prompts.sort((left, right) => left.id.localeCompare(right.id)),
      commands: [],
      themes: themes.sort((left, right) => left.name.localeCompare(right.name)),
      runtime: entries,
    },
  );
}

function directDiscoveryView(host: RuntimeExtensionHost, loader: ResourceLoader): RuntimeDiscoveryView {
  const maximumPerKind = 512;
  const runtimeCommands = host.commands();
  const prompts = loader.getPrompts().prompts;
  const skills = loader.getSkills().skills;
  const commandResources: RuntimeDiscoverableResource[] = [
    ...BUILTIN_SLASH_COMMANDS.map((command): RuntimeDiscoverableResource => ({
      kind: "command",
      source: "builtin",
      name: command.name,
      description: command.description,
      ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
    })),
    ...runtimeCommands.map((command): RuntimeDiscoverableResource => ({
      kind: "command",
      source: "runtime_extension",
      name: command.name,
      extensionId: command.extensionId,
      ...(command.description === undefined ? {} : { description: command.description }),
      ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
    })),
  ];
  const promptResources = prompts.map((prompt): RuntimeDiscoverableResource => ({
    kind: "prompt",
    name: prompt.name,
    extensionId: prompt.sourceInfo.source,
    ...(prompt.description === "" ? {} : { description: prompt.description }),
    ...(prompt.argumentHint === undefined ? {} : { argumentHint: prompt.argumentHint }),
  }));
  const skillResources = skills.map((skill): RuntimeDiscoverableResource => ({
    kind: "skill",
    name: skill.name,
    description: skill.description,
    scope: skill.sourceInfo.scope === "user" ? "user" : "workspace",
    trusted: true,
    disableModelInvocation: skill.disableModelInvocation,
  }));
  return {
    resources: [
      ...commandResources.slice(0, maximumPerKind),
      ...promptResources.slice(0, maximumPerKind),
      ...skillResources.slice(0, maximumPerKind),
    ],
    truncated: commandResources.length > maximumPerKind
      || promptResources.length > maximumPerKind
      || skillResources.length > maximumPerKind,
    omitted: {
      commands: Math.max(0, commandResources.length - maximumPerKind),
      prompts: Math.max(0, promptResources.length - maximumPerKind),
      skills: Math.max(0, skillResources.length - maximumPerKind),
    },
  };
}

function directExtensionSelection(
  resolved: readonly ResolvedPaths[],
  projectTrusted: boolean,
): {
  paths: string[];
  metadata: Map<string, { scope: "user" | "project" | "temporary"; trusted: boolean; resourceRoot?: string }>;
} {
  const paths: string[] = [];
  const metadata = new Map<string, { scope: "user" | "project" | "temporary"; trusted: boolean; resourceRoot?: string }>();
  for (const group of resolved) {
    for (const resource of group.extensions) {
      if (!resource.enabled) continue;
      const path = resolve(resource.path);
      if (metadata.has(path)) continue;
      paths.push(path);
      metadata.set(path, {
        scope: resource.metadata.scope,
        trusted: resource.metadata.scope !== "project" || projectTrusted,
        ...(resource.metadata.baseDir === undefined ? {} : { resourceRoot: resource.metadata.baseDir }),
      });
    }
  }
  return { paths, metadata };
}

export async function activatePackageCandidate(candidate: PackageActivationCandidate): Promise<void> {
  const direct = directExtensionSelection([candidate.resources], candidate.projectTrusted);
  if (direct.paths.length === 0) return;
  let host: RuntimeExtensionHost | undefined;
  try {
    host = await loadDirectExtensions(direct.paths, {
      workspace: candidate.workspace,
      dataRoot: candidate.dataRoot,
      projectTrusted: candidate.projectTrusted,
      directPathMetadata: direct.metadata,
      activationFailure: "throw",
      ...(candidate.signal === undefined ? {} : { signal: candidate.signal }),
    });
  } finally {
    await host?.close();
  }
}

/**
 * Activates only launch-authorized extensions before project trust is known.
 * Project configuration, packages, extensions, prompts, skills, and themes are
 * intentionally not inspected here.
 */
export async function preactivateProjectTrustExtensions(
  paths: Pick<AgentPaths, "userExtensions" | "agentDirectory">,
  workspaceValue: string,
  options: Pick<RuntimeOptions, "extensions" | "extensionPaths" | "extensionFactories" | "extensionRuntime" | "offline">,
  signal?: AbortSignal,
): Promise<RuntimeExtensionHost | undefined> {
  if (options.extensionRuntime !== true) return undefined;
  const workspace = await canonicalExistingPath(resolve(workspaceValue));
  const settings = SettingsManager.create(workspace, paths.agentDirectory, { projectTrusted: false });
  await reloadRuntimeSettings(settings);
  const packages = new DefaultPackageManager({
    cwd: workspace,
    agentDir: paths.agentDirectory,
    settingsManager: settings,
    offline: options.offline === true,
    activateCandidate: async (candidate) => await activatePackageCandidate({
      ...candidate,
      ...(signal === undefined ? {} : { signal }),
    }),
  });
  const selected: ResolvedPaths[] = [];
  if (options.extensions === true) selected.push(await packages.resolve());
  if ((options.extensionPaths?.length ?? 0) > 0) {
    selected.push(await packages.resolveExtensionSources([...options.extensionPaths!], { temporary: true }));
  }
  const direct = directExtensionSelection(selected, false);
  if (direct.paths.length > 128) throw new Error("At most 128 pre-trust runtime extensions may be loaded");
  return await loadDirectExtensions(direct.paths, {
    workspace,
    dataRoot: join(paths.agentDirectory, "extension-data"),
    projectTrusted: false,
    directPathMetadata: direct.metadata,
    inlineExtensions: options.extensionFactories ?? [],
    ...(signal === undefined ? {} : { signal }),
  });
}

async function loadResourceGeneration(
  paths: AgentPaths,
  workspace: string,
  broker: CredentialBroker,
  credentials: CredentialStore,
  managedAuth: ManagedProviderAuthDirectory,
  options: Pick<RuntimeOptions, "projectTrusted" | "ephemeral" | "extensions" | "extensionPaths" | "extensionFactories" | "extensionRuntime" | "skills" | "skillPaths" | "promptTemplates" | "promptTemplatePaths" | "themes" | "themePaths" | "systemPrompt" | "appendSystemPrompt" | "sessionDirectory" | "offline" | "deferModelNetworkRefresh">,
  reason: "startup" | "reload" = "startup",
  signal?: AbortSignal,
  preactivatedRuntimeExtensions?: RuntimeExtensionHost,
): Promise<RuntimeResourceGeneration> {
  signal?.throwIfAborted();
  const trust = new TrustStore(paths.trustStore);
  const trusted = options.projectTrusted ?? await trust.isTrusted(workspace);
  const settings = SettingsManager.create(workspace, paths.agentDirectory, { projectTrusted: trusted });
  await reloadRuntimeSettings(settings);
  const toolBackend: ToolExecutionBackend | undefined = undefined;
  const authoringResources = bundledAuthoringResources();
  const network = createNetworkTransport(networkOptions(settings, process.env));
  const abortController = new AbortController();
  const modelCatalogStore = new FileModelCatalogStore(paths.modelCatalog);
  const modelCatalogBaseline = await modelCatalogStore.read(RUNTIME_MODEL_CATALOG_MAX_BYTES).catch(() => undefined);
  const providers = new ProviderRegistry([], { catalogStore: modelCatalogStore });
  const providerWire = new ProviderWireInterceptorRegistry();
  registerCloudflareWireInterceptors(providerWire, broker, process.env);
  const authBindings: ProviderAuthBinding[] = [];
  const providerConfigs = configuredProviderConfigs(settings, process.env);
  const providerConfigsById = new Map<string, RuntimeProviderConfig>();
  for (const [configuredName, providerConfig] of Object.entries(providerConfigs)) {
    const adapter = createProviderAdapter(providerConfig, broker, {
      fetch: network.fetch,
      ...(network.openWebSocket === undefined ? {} : { webSocket: network.openWebSocket }),
      wire: providerWire,
      environment: process.env,
    });
    providers.register(adapter);
    providerConfigsById.set(adapter.id, providerConfig);
    authBindings.push(runtimeProviderAuthBinding(configuredName, providerConfig, adapter.id));
  }
  const configuredSessionDirectory = options.sessionDirectory ?? settings.getSessionDir();
  const sessionDirectory = configuredSessionDirectory === undefined
    ? undefined
    : expandPath(configuredSessionDirectory, workspace);
  const directPackages = new DefaultPackageManager({
    cwd: workspace,
    agentDir: paths.agentDirectory,
    settingsManager: settings,
    offline: options.offline === true,
    activateCandidate: async (candidate) => await activatePackageCandidate({
      ...candidate,
      ...(signal === undefined ? {} : { signal }),
    }),
  });
  const automaticDirectResources = options.extensions === true
    ? await directPackages.resolve()
    : { extensions: [], skills: [], prompts: [], themes: [] } satisfies ResolvedPaths;
  const directAdditionalSources = [
    ...(options.extensionPaths ?? []).map((path) => expandPath(path, workspace)),
  ];
  const additionalDirectResources = directAdditionalSources.length === 0
    ? { extensions: [], skills: [], prompts: [], themes: [] } satisfies ResolvedPaths
    : await directPackages.resolveExtensionSources(directAdditionalSources, { temporary: true });
  const direct = directExtensionSelection(
    options.extensionRuntime === true ? [automaticDirectResources, additionalDirectResources] : [],
    trusted,
  );
  if (direct.paths.length > 128) throw new Error("At most 128 runtime extensions may be loaded");
  let runtimeExtensions: RuntimeExtensionHost;
  if (options.extensionRuntime === true) {
    if (preactivatedRuntimeExtensions === undefined) {
      runtimeExtensions = await loadDirectExtensions(direct.paths, {
        workspace,
        dataRoot: join(paths.agentDirectory, "extension-data"),
        projectTrusted: trusted,
        directPathMetadata: direct.metadata,
        inlineExtensions: options.extensionFactories ?? [],
        ...(signal === undefined ? {} : { signal }),
        ...(reason === "reload" || directAdditionalSources.length > 0 ? { activationFailure: "throw" as const } : {}),
      });
    } else {
      runtimeExtensions = preactivatedRuntimeExtensions;
      runtimeExtensions.setHostContext({ projectTrusted: trusted });
      const activePaths = new Set(runtimeExtensions.extensions().map((entry) => entry.sourcePath));
      const additional = direct.paths.filter((path) => !activePaths.has(path));
      await appendDirectExtensions(runtimeExtensions, additional, {
        workspace,
        dataRoot: join(paths.agentDirectory, "extension-data"),
        directPathMetadata: direct.metadata,
        ...(signal === undefined ? {} : { signal }),
        ...(reason === "reload" || directAdditionalSources.length > 0 ? { activationFailure: "throw" as const } : {}),
      });
    }
  } else {
    if (preactivatedRuntimeExtensions !== undefined) {
      throw new Error("Preactivated extensions require extensionRuntime");
    }
    runtimeExtensions = new RuntimeExtensionHost(workspace, {
      dataRoot: join(paths.agentDirectory, "extension-data"),
      projectTrusted: trusted,
    });
  }
  const extensionCatalogProviderIds = [...new Set(
    runtimeExtensions.directProviderRegistrations().map((registration) => registration.name),
  )];
  const auth = new ProviderAuthRegistry({
    bindings: authBindings,
    registrations: configuredOAuthRegistrations(authBindings),
    store: credentials,
  });
  const integratedRuntimeProviderAuthCleanups = new Map<string, () => void>();
  const registerProviderAuth = (description: RuntimeProviderAuthRegistration): (() => void) => {
    const provider = description.descriptor.provider;
    const cleanups: Array<() => void> = [auth.registerDescriptor(description.extensionId, description.descriptor)];
    try {
      const binding = auth.binding(provider);
      for (const method of description.descriptor.methods) {
        if (method.kind !== "managed_oauth") continue;
        cleanups.push(managedAuth.register(provider, binding.credentialId, method));
        if (method.modifyModels !== undefined) {
          const underlying = providers.get(provider);
          cleanups.push(providers.overlay({
            id: provider,
            listModels: async (modelSignal) => {
              const models = await underlying.listModels(modelSignal);
              const resolved = await broker.resolve({ provider: binding.credentialId, signal: modelSignal });
              if (resolved?.credential.kind !== "oauth") return models;
              return await managedAuth.modifyModels(provider, models, resolved.credential, modelSignal);
            },
          }));
        }
      }
    } catch (error) {
      for (const cleanup of cleanups.reverse()) cleanup();
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      for (const cleanup of cleanups.reverse()) cleanup();
    };
  };
  if (auth.has("kimi-coding")) {
    const provider = "kimi-coding";
    const cleanup = registerProviderAuth({
      extensionId: "rigyn-core",
      sourcePath: "<builtin>",
      descriptor: createKimiCodingAuthDescriptor({
        fetch: network.fetch,
        environment: process.env,
      }),
    });
    integratedRuntimeProviderAuthCleanups.set(provider, cleanup);
    runtimeExtensions.addRegistrationCleanup(() => {
      if (integratedRuntimeProviderAuthCleanups.get(provider) !== cleanup) return;
      integratedRuntimeProviderAuthCleanups.delete(provider);
      cleanup();
    });
  }
  for (const providerConfig of Object.values(providerConfigs)) {
    if (providerConfig.kind !== "gateway-messages" || providerConfig.managedOAuth !== true) continue;
    const provider = providerConfig.id;
    const cleanup = registerProviderAuth({
      extensionId: "rigyn-core",
      sourcePath: "<builtin>",
      descriptor: {
        provider,
        methods: [createGatewayManagedOAuth({
          name: providerDisplayName(provider),
          gatewayUrl: providerConfig.gatewayUrl,
          fetch: network.fetch,
        })],
      },
    });
    integratedRuntimeProviderAuthCleanups.set(provider, cleanup);
    runtimeExtensions.addRegistrationCleanup(() => {
      if (integratedRuntimeProviderAuthCleanups.get(provider) !== cleanup) return;
      integratedRuntimeProviderAuthCleanups.delete(provider);
      cleanup();
    });
  }
  const extraTools = runtimeExtensions.tools();
  const bindLiveRegistrations = (): void => runtimeExtensions.setLiveRegistrationHandler({
    registerTool(tool) {
      if (extraTools.some((entry) => entry.definition.name === tool.definition.name)) {
        throw new Error(`Runtime extension tool is already registered: ${tool.definition.name}`);
      }
      extraTools.push(tool);
      return () => {
        const index = extraTools.indexOf(tool);
        if (index >= 0) extraTools.splice(index, 1);
      };
    },
    replaceTool(previous, tool) {
      const index = extraTools.indexOf(previous);
      if (index < 0) throw new Error(`Runtime extension tool is not registered: ${previous.definition.name}`);
      extraTools.splice(index, 1, tool);
      return () => {
        const selected = extraTools.indexOf(tool);
        if (selected >= 0) extraTools.splice(selected, 1);
      };
    },
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const providerAdapters = providers.list();
    abortController.abort(new Error("Runtime resource generation closed"));
    const failures: unknown[] = [];
    try {
      await runtimeExtensions.close();
      await providers.settlePersistence();
    } catch (error) {
      failures.push(error);
    }
    const providerDisposals = providerAdapters.flatMap((provider) =>
      provider.dispose === undefined
        ? []
        : [settleWithin(
            Promise.resolve().then(async () => await provider.dispose!()),
            RUNTIME_PROVIDER_DISPOSAL_TIMEOUT_MS,
            `Provider ${provider.id} disposal`,
          )]);
    const results = await Promise.allSettled([...providerDisposals, network.close()]);
    for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    try {
      await stageExtensionCatalogBaseline(
        modelCatalogStore,
        modelCatalogBaseline,
        extensionCatalogProviderIds,
      );
    } catch (error) {
      failures.push(error);
    }
    throwFailures(failures, "Runtime resource cleanup failed");
  };
  try {
    signal?.throwIfAborted();
    providers.configureModels(configuredModelsWithMaintainedCatalog([]));
    const directModels = createModels({
      credentials: new ProviderCredentialStoreAdapter(credentials),
    });
    for (const adapter of providers.list()) {
      const binding = auth.binding(adapter.id);
      const providerConfig = providerConfigsById.get(adapter.id);
      const initialModels = providers.getModels(adapter.id);
      directModels.setProvider(providerFromAdapter(adapter, {
        auth: directProviderAuth(adapter.id, broker, auth, abortController.signal),
        allowUnauthenticatedRefresh: binding.local === true || binding.externallyManaged === true,
        initialModels: providerConfig === undefined
          ? initialModels.filter((model) => model.compatibility?.protocolFamily?.value !== undefined)
          : initialModels,
        model: (info) => providerModelFromInfo(
          info,
          providerConfig === undefined
            ? undefined
            : runtimeProviderModelProtocolFamily(providerConfig, info.id),
        ),
      }));
    }
    const modelRegistry = new ModelRegistry(directModels);
    await modelRegistry.refresh({
      allowNetwork: options.offline !== true && options.deferModelNetworkRefresh !== true,
      signal: signal === undefined
        ? abortController.signal
        : AbortSignal.any([abortController.signal, signal]),
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir: paths.agentDirectory,
      settingsManager: settings,
      offline: options.offline === true,
      ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
      ...(options.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: [...options.appendSystemPrompt] }),
      additionalExtensionPaths: options.extensionRuntime === true ? directAdditionalSources : [],
      preloadedExtensions: runtimeExtensions,
      extensionFactories: [...(options.extensionFactories ?? [])],
      noExtensions: options.extensionRuntime !== true || options.extensions !== true,
      noSkills: options.skills === false,
      noPromptTemplates: options.promptTemplates === false,
      noThemes: options.themes === false,
      additionalSkillPaths: [
        ...(options.skills === false ? [] : [
          authoringResources.skillRoot,
          ...sharedUserSkillRoots(homedir()).map((root) => root.path),
          ...sharedWorkspaceSkillRoots(workspace, trusted).map((root) => root.path),
          ...(options.extensionRuntime === true
            ? []
            : additionalDirectResources.skills.filter((resource) => resource.enabled).map((resource) => resource.path)),
        ]),
        ...(options.skillPaths ?? []).map((path) => expandPath(path, workspace)),
      ],
      additionalPromptTemplatePaths: [
        ...(options.promptTemplates === false ? [] : [
          authoringResources.promptRoot,
          ...(options.extensionRuntime === true
            ? []
            : additionalDirectResources.prompts.filter((resource) => resource.enabled).map((resource) => resource.path)),
        ]),
        ...(options.promptTemplatePaths ?? []).map((path) => expandPath(path, workspace)),
      ],
      additionalThemePaths: [
        ...(options.themes === false ? [] : [
          ...(options.extensionRuntime === true
            ? []
            : additionalDirectResources.themes.filter((resource) => resource.enabled).map((resource) => resource.path)),
        ]),
        ...(options.themePaths ?? []).map((path) => expandPath(path, workspace)),
      ],
    });
    await resourceLoader.reload({ preparedSettings: settings, ...(signal === undefined ? {} : { signal }) });
    runtimeExtensions.addRegistrationCleanup(bindDirectProviderWireLifecycle(runtimeExtensions, providerWire));
    runtimeExtensions.setDirectDiscoveryHandler((discoverySignal) => {
      discoverySignal?.throwIfAborted();
      return directDiscoveryView(runtimeExtensions, resourceLoader);
    });
    bindLiveRegistrations();
    signal?.throwIfAborted();
    const extensions = directResourceCatalog(runtimeExtensions, resourceLoader);
    signal?.throwIfAborted();
    return {
      trusted,
      settings,
      auth,
      providers,
      modelRegistry,
      resourceLoader,
      network,
      providerWire,
      extensions,
      runtimeExtensions,
      ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
      extraTools,
      ...(toolBackend === undefined ? {} : { toolBackend }),
      abortController,
      modelCatalogBaseline,
      extensionCatalogProviderIds,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Runtime resource loading and cleanup failed");
    }
    throw error;
  }
}

function assignGeneration(runtime: LoadedRuntime, generation: RuntimeResourceGeneration): void {
  runtime.trusted = generation.trusted;
  runtime.settings = generation.settings;
  runtime.auth = generation.auth;
  runtime.providers = generation.providers;
  runtime.modelRegistry = generation.modelRegistry;
  runtime.resourceLoader = generation.resourceLoader;
  runtime.network = generation.network;
  runtime.extensions = generation.extensions;
  runtime.runtimeExtensions = generation.runtimeExtensions;
  if (generation.sessionDirectory === undefined) delete runtime.sessionDirectory;
  else runtime.sessionDirectory = generation.sessionDirectory;
  runtime.generationSignal = generation.abortController.signal;
}

export async function loadRuntime(options: RuntimeOptions = {}): Promise<LoadedRuntime> {
  const paths = agentPaths();
  const workspace = await canonicalExistingPath(resolve(options.workspace ?? process.cwd()));
  const resolvedProjectTrust = options.projectTrusted
    ?? await options.projectTrustResolver?.isTrusted(workspace);
  const effectiveOptions: RuntimeOptions = resolvedProjectTrust === undefined
    ? options
    : { ...options, projectTrusted: resolvedProjectTrust };
  const credentials = await createCredentialStore(paths, { createLocalKey: true });
  let activeNetwork: NetworkTransport | undefined;
  const explicitCredentials = new Map<string, AuthCredential>();
  if (options.apiKey !== undefined) {
    const provider = options.apiKeyProvider ?? "openai";
    explicitCredentials.set(provider, { kind: "api_key", provider, apiKey: options.apiKey });
  }
  const managedAuth = new ManagedProviderAuthDirectory();
  const broker = new CredentialBroker([
    ...(explicitCredentials.size === 0 ? [] : [new ExplicitCredentialSource(explicitCredentials)]),
    new RefreshingStoredCredentialSource(credentials, {
      refresh: async (credential, signal) => {
        const fetchImplementation = activeNetwork?.fetch ?? globalThis.fetch;
        if (credential.provider === "anthropic") {
          return await refreshAnthropicOAuth(credential, signal, fetchImplementation);
        }
        if (credential.provider === "github-copilot") {
          return await refreshGitHubCopilotOAuth(credential, signal, fetchImplementation);
        }
        const managed = await managedAuth.refresh(credential, signal);
        if (managed !== undefined) return managed;
        return await refreshGenericOAuthWithFetch(credential, signal, fetchImplementation);
      },
    }),
    new EnvironmentCredentialSource(),
  ]);
  const preactivatedRuntimeExtensions = options.preactivatedRuntimeExtensions
    ?? (effectiveOptions.extensionRuntime === true
      ? await options.projectTrustResolver?.takePreactivatedExtensions(workspace)
      : undefined);
  let generation: RuntimeResourceGeneration;
  try {
    generation = await loadResourceGeneration(
      paths,
      workspace,
      broker,
      credentials,
      managedAuth,
      effectiveOptions,
      "startup",
      undefined,
      preactivatedRuntimeExtensions,
    );
  } catch (error) {
    await preactivatedRuntimeExtensions?.close().catch(() => undefined);
    throw error;
  }
  activeNetwork = generation.network;
  let sessionManager: SessionManager;
  let session: AgentSession;
  try {
    if (options.sessionManager !== undefined) {
      const sessionWorkspace = await canonicalExistingPath(resolve(options.sessionManager.getCwd()));
      if (sessionWorkspace !== workspace) {
        throw new Error("The supplied SessionManager cwd does not match the runtime workspace");
      }
      sessionManager = options.sessionManager;
    } else if (options.ephemeral === true) {
      sessionManager = SessionManager.inMemory(workspace);
    } else if (options.sessionFile !== undefined) {
      sessionManager = SessionManager.open(
        expandPath(options.sessionFile, workspace),
        generation.sessionDirectory,
        workspace,
      );
    } else if (options.continueRecent === true) {
      sessionManager = SessionManager.continueRecent(workspace, generation.sessionDirectory);
    } else {
      sessionManager = SessionManager.create(workspace, generation.sessionDirectory);
    }
    session = await AgentSession.create({
      sessionManager,
      workspace,
      agentDirectory: paths.agentDirectory,
      projectTrusted: generation.trusted,
      ...agentSessionResources(generation),
    });
  } catch (error) {
    try {
      await generation.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Runtime initialization and cleanup failed");
    }
    throw error;
  }

  let closed = false;
  let reloadFlight: Promise<RuntimeReloadResult> | undefined;
  let reloadAbortController: AbortController | undefined;
  let extensionShutdownHandler: (() => unknown | Promise<unknown>) | undefined;
  const runtime: LoadedRuntime = {
    paths,
    workspace,
    trusted: generation.trusted,
    settings: generation.settings,
    credentials,
    broker,
    auth: generation.auth,
    providers: generation.providers,
    modelRegistry: generation.modelRegistry,
    resourceLoader: generation.resourceLoader,
    network: generation.network,
    sessionManager,
    session,
    extensions: generation.extensions,
    runtimeExtensions: generation.runtimeExtensions,
    ...(generation.sessionDirectory === undefined ? {} : { sessionDirectory: generation.sessionDirectory }),
    generationSignal: generation.abortController.signal,
    setExtensionShutdownHandler(handler): void {
      if (closed) throw new Error("Runtime is closed");
      extensionShutdownHandler = handler;
    },
    async reload(reloadOptions: RuntimeReloadOptions = {}): Promise<RuntimeReloadResult> {
      if (closed) throw new Error("Runtime is closed");
      reloadOptions.signal?.throwIfAborted();
      if (reloadFlight !== undefined) throw new Error("Runtime reload is already in progress");
      const operationAbortController = new AbortController();
      const operation = (async (): Promise<RuntimeReloadResult> => {
        const signals = [operationAbortController.signal, AbortSignal.timeout(RUNTIME_RELOAD_TIMEOUT_MS)];
        if (reloadOptions.signal !== undefined) signals.push(reloadOptions.signal);
        const signal = AbortSignal.any(signals);
        signal.throwIfAborted();
        if (!runtime.session.isIdle) {
          throw new Error("Runtime reload requires an idle AgentSession");
        }
        const previous = generation;
        const previousSession = runtime.session;
        const warnings: string[] = [];
        let committed = false;
        let shutdownStarted = false;
        let candidate: Awaited<ReturnType<typeof loadResourceGeneration>> | undefined;
        let candidateSession: AgentSession | undefined;
        let catalogRollback: ModelCatalogRollback | undefined;
        try {
          shutdownStarted = true;
          await previous.runtimeExtensions.dispatch("session_shutdown", {
            reason: "reload",
          } as never, signal).catch((error: unknown) => {
            warnings.push(`Extension session shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
          });
          signal.throwIfAborted();
          catalogRollback = await stageExtensionCatalogBaseline(
            new FileModelCatalogStore(paths.modelCatalog),
            previous.modelCatalogBaseline,
            previous.extensionCatalogProviderIds,
          );
          signal.throwIfAborted();
          candidate = await loadResourceGeneration(
            paths,
            workspace,
            broker,
            credentials,
            managedAuth,
            effectiveOptions,
            "reload",
            signal,
          );
          candidate.runtimeExtensions.setHostContext({ mode: previous.runtimeExtensions.hostContext().mode });
          if (candidate.sessionDirectory !== previous.sessionDirectory) {
            throw new Error("sessionDirectory cannot change during /reload; restart Rigyn to use the new location");
          }
          candidateSession = await AgentSession.create({
            sessionManager,
            workspace,
            agentDirectory: paths.agentDirectory,
            projectTrusted: candidate.trusted,
            ...agentSessionResources(candidate),
            ...(previousSession.model === undefined ? {} : { model: previousSession.model }),
            thinkingLevel: previousSession.thinkingLevel,
          });
          bindExtensionControls(candidate, candidateSession);
          await reloadOptions.prepareExtensions?.(candidate.runtimeExtensions);
          await reloadOptions.prepareSettings?.(candidate.settings);
          signal.throwIfAborted();
          generation = candidate;
          activeNetwork = candidate.network;
          runtime.session = candidateSession;
          assignGeneration(runtime, candidate);
          previous.abortController.abort(new Error("Runtime resources reloaded"));
          committed = true;
          try {
            await previousSession.close();
          } catch (error) {
            warnings.push(`Old session cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          try {
            await reloadOptions.onCommit?.();
          } catch (error) {
            warnings.push(`Reloaded resources but UI refresh failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          try {
            await settleWithin(previous.close(), RUNTIME_GENERATION_CLOSE_TIMEOUT_MS, "Old runtime cleanup");
          } catch (error) {
            warnings.push(`Old runtime cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          await candidateSession.bindExtensions({ reason: "reload" }).catch((error: unknown) => {
            warnings.push(`Extension session restart failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        } catch (error) {
          if (!committed) {
            await candidateSession?.close().catch(() => undefined);
            await candidate?.close().catch(() => undefined);
            let rollbackError: unknown;
            try {
              await restoreModelCatalogRollback(
                new FileModelCatalogStore(paths.modelCatalog),
                catalogRollback,
              );
            } catch (candidateRollbackError) {
              rollbackError = candidateRollbackError;
            }
            if (shutdownStarted) await previousSession.bindExtensions({ reason: "reload" }).catch(() => undefined);
            if (rollbackError !== undefined) {
              throw new AggregateError(
                [error, rollbackError],
                `${error instanceof Error ? error.message : String(error)}; model catalog rollback failed`,
              );
            }
          }
          throw error;
        }
        return { warnings };
      })();
      reloadFlight = operation;
      reloadAbortController = operationAbortController;
      try {
        return await operation;
      } finally {
        if (reloadFlight === operation) reloadFlight = undefined;
        if (reloadAbortController === operationAbortController) reloadAbortController = undefined;
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const failures: unknown[] = [];
      const pendingReload = reloadFlight;
      if (pendingReload !== undefined) {
        reloadAbortController?.abort(new Error("Runtime closed while reload was in progress"));
        try {
          await settleWithin(
            pendingReload.then(() => undefined, () => undefined),
            RUNTIME_RELOAD_CLOSE_WAIT_TIMEOUT_MS,
            "Runtime reload shutdown",
          );
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await runtime.session.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await generation.close();
      } catch (error) {
        failures.push(error);
      }
      throwFailures(failures, "Runtime shutdown failed");
    },
  };
  function bindExtensionControls(target: RuntimeResourceGeneration, controlledSession: AgentSession): void {
    const host = target.runtimeExtensions;
    const commandContextActions: ExtensionCommandContextActions = {
      async waitForIdle() { await runtime.session.waitForIdle(); },
      async newSession(options = {}) {
        if (!runtime.session.isIdle) return { cancelled: true };
        runtime.session.newSession({
          ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
        });
        await options.setup?.(extensionSessionManager(runtime.sessionManager));
        await options.withSession?.(runtime.session.createReplacedSessionContext());
        return { cancelled: false };
      },
      async fork(entryId, options = {}) {
        if (!runtime.session.isIdle) return { cancelled: true };
        const target = options.position === "before"
          ? runtime.sessionManager.getEntries().find((entry) => entry.id === entryId)?.parentId ?? null
          : entryId;
        if (target === null) throw new Error("Cannot fork before the first session entry");
        const path = runtime.session.createBranchedSession(target);
        if (path === undefined) return { cancelled: true };
        runtime.session.switchSessionFile(path);
        await options.withSession?.(runtime.session.createReplacedSessionContext());
        return { cancelled: false };
      },
      async navigateTree(targetId, options = {}) {
        if (!runtime.session.isIdle) return { cancelled: true };
        const result = await runtime.session.navigateTree(targetId, options);
        return { cancelled: result.cancelled };
      },
      async switchSession(sessionPath, options = {}) {
        if (!runtime.session.isIdle) return { cancelled: true };
        runtime.session.switchSessionFile(sessionPath);
        await options.withSession?.(runtime.session.createReplacedSessionContext());
        return { cancelled: false };
      },
      async reload() { await runtime.reload(); },
    };
    controlledSession.setExtensionCommandActions(commandContextActions);
    host.setDirectContextHandler((sessionTarget, signal) => {
      signal.throwIfAborted();
      if (sessionTarget !== undefined && sessionTarget.threadId !== runtime.session.sessionId) {
        throw new Error("Direct extension context only exposes the current session");
      }
      if (
        sessionTarget?.branch !== undefined &&
        sessionTarget.branch !== (runtime.session.sessionManager.getLeafId() ?? "root")
      ) throw new Error("Direct extension context only exposes the current branch");
      return {
        sessionManager: extensionSessionManager(runtime.sessionManager),
        modelRegistry: target.modelRegistry,
        ...(() => {
          const selected = runtime.session.model;
          const model = selected === undefined ? undefined : target.modelRegistry.find(selected.provider, selected.id);
          return model === undefined ? {} : { model };
        })(),
        isIdle() { return runtime.session.isIdle; },
        hasPendingMessages() { return runtime.session.hasPendingMessages; },
        abort() { runtime.session.abort("Cancelled by extension"); },
        shutdown() {
          if (extensionShutdownHandler === undefined) void runtime.close();
          else void extensionShutdownHandler();
        },
        getContextUsage() { return runtime.session.getSessionStats().contextUsage; },
        compact(options = {}) {
          void runtime.session.compact(options.customInstructions).then(
            (result) => options.onComplete?.({
              threadId: runtime.session.sessionId,
              branch: runtime.session.sessionManager.getLeafId() ?? "root",
              ...result,
            }),
            (error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error))),
          );
        },
        getSystemPrompt() { return runtime.session.systemPrompt; },
      };
    });
  }
  bindExtensionControls(generation, session);
  return runtime;
}
