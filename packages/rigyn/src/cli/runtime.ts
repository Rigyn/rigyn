import { join, resolve, sep } from "node:path";
import {
  CredentialBroker,
  EnvironmentCredentialSource,
  ExplicitCredentialSource,
  ManagedProviderAuthDirectory,
  ProfiledRefreshingStoredCredentialSource,
  ProviderAuthRegistry,
  providerDisplayName,
  type CredentialStore,
  type CredentialSource,
  type AuthCredential,
  type OAuthCredential,
  type ProviderAuthBinding,
  authorizeAnthropic,
  authorizeGitHubCopilot,
  authorizeOAuthRegistration,
  authorizeOpenAICodex,
  refreshAnthropicOAuth,
  refreshGenericOAuthWithFetch,
  refreshGitHubCopilotOAuth,
  refreshOpenAICodexCredential,
  configuredOAuthClientId,
  configuredGitHubCopilotHost,
} from "../auth/index.js";
import { pinnedBuiltinOAuthRefreshCredential } from "../auth/builtin-oauth-refresh.js";
import { createDefaultCredentialStore } from "../auth/default-store.js";
import {
  KIMI_CODE_OAUTH_REGISTRATION_ID,
  kimiCodeOAuthRegistration,
} from "../auth/kimi-code.js";
import type { OAuthRegistrationConfig } from "../auth/registry.js";
import {
  XAI_OAUTH_REGISTRATION_ID,
  xaiOAuthRegistration,
} from "../auth/xai.js";
import {
  canonicalExistingPath,
  TrustStore,
} from "../config/index.js";
import type { ModelInfo, ModelProtocolFamily, ProviderRequest } from "../core/types.js";
import { errorMessage } from "../core/errors.js";
import { isJsonValue } from "../core/json.js";
import {
  DefaultResourceLoader,
  type ResourceLoader,
} from "../core/resource-loader.js";
import {
  DefaultPackageManager,
  type PackageActivationCandidate,
  type ResolvedPaths,
} from "../core/package-manager.js";
import { SettingsManager, type ThinkingLevel } from "../core/settings-manager.js";
import { acquireProcessLocalObservabilitySink } from "../core/local-observability.js";
import {
  resolveObservabilityLevel,
  RuntimeObservability,
  type ObservabilityLevel,
  type ObservabilityMode,
  type ObservabilitySink,
} from "../core/observability.js";
import { BUILTIN_SLASH_COMMANDS } from "../core/slash-commands.js";
import { ProviderRegistry } from "../providers/registry.js";
import {
  ProviderCredentialStoreAdapter,
  FileProviderModelsStore,
  createModels,
  defaultProviderAuthContext,
  openAICodexModels,
  hostOAuthCredential,
  providerOAuthCredential,
  type ProviderAuth,
  type ProviderModel,
  type ProviderStreamOptions,
} from "../providers/index.js";
import { openRouterBrowserAccount } from "../providers/openrouter-browser-auth.js";
import { ModelRegistry } from "../providers/model-registry.js";
import {
  OPENAI_CODEX_TRANSPORT_OBSERVER,
  runtimeOpenAICodexTransportObserver,
  type OpenAICodexObservabilityOptions,
  type OpenAICodexTransportObserver,
} from "../providers/openai-codex-observability.js";
import {
  providerFromAdapter,
  providerModelFromInfo,
  providerModelToInfo,
} from "../providers/internal-runtime-bridge.js";
import {
  ProviderWireInterceptorRegistry,
  type ProviderWireLifecycleHost,
  type ProviderWireOperation,
  type ProviderWireTransportHost,
} from "../providers/wire.js";
import { FileModelCatalogStore } from "../providers/model-catalog-store.js";
import { configuredModelsWithMaintainedCatalog } from "../providers/maintained-model-catalog.js";
import {
  AgentSession,
  createProviderAdapter,
  type AgentSessionOptions,
  type RuntimeProviderConfig,
} from "../service/index.js";
import {
  closeAgentSessionForReplacement,
  markAgentSessionSharedStoreReplacement,
} from "../service/agent-session-owner.js";
import { runtimeProviderModelProtocolFamily } from "../service/internal-provider-protocol.js";
import { SessionManager } from "../storage/index.js";
import { bundledAuthoringResources } from "../prompts/resources.js";
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
import type { ToolAuthorizationHandler } from "../tools/approval.js";
import { parseKeybindingOverrides } from "../tui/keybindings.js";
import type { ProjectTrustResolver } from "./project-trust.js";
import type { SessionStartEvent as RuntimeSessionStartEvent } from "../service/agent-session-runtime.js";
import { RIGYN_VERSION } from "../version.js";

class CredentialSnapshotModelRegistry extends ModelRegistry {
  readonly #credentials: ProviderCredentialStoreAdapter;
  readonly #storedCredentials: ProfiledRefreshingStoredCredentialSource;

  constructor(
    models: ConstructorParameters<typeof ModelRegistry>[0],
    credentials: ProviderCredentialStoreAdapter,
    storedCredentials: ProfiledRefreshingStoredCredentialSource,
  ) {
    super(models);
    this.#credentials = credentials;
    this.#storedCredentials = storedCredentials;
  }

  override refresh(
    options?: Parameters<ModelRegistry["refresh"]>[0],
  ): ReturnType<ModelRegistry["refresh"]> {
    return this.#storedCredentials.withReadSnapshot(async () =>
      await this.#credentials.withReadSnapshot(async () => await super.refresh(options)));
  }
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
  providerWireLifecycle: ProviderWireLifecycleHost;
  sessionManager: SessionManager;
  session: AgentSession;
  extensions: ExtensionCatalog;
  runtimeExtensions: RuntimeExtensionHost;
  sessionDirectory?: string;
  generationSignal: AbortSignal;
  observability?: RuntimeObservability;
  setExtensionShutdownHandler(handler: (() => unknown | Promise<unknown>) | undefined): void;
  refresh(options?: RuntimeRefreshOptions): Promise<RuntimeRefreshResult>;
  close(): Promise<void>;
}

export interface RuntimeRefreshOptions {
  signal?: AbortSignal;
  prepareExtensions?: (extensions: RuntimeExtensionHost) => void | Promise<void>;
  prepareSettings?: (settings: SettingsManager) => void | Promise<void>;
  onCommit?: () => void | Promise<void>;
  beforeSessionStart?: (session: AgentSession) => void | Promise<void>;
}

export interface RuntimeRefreshResult {
  warnings: string[];
}

interface RuntimeOptions {
  signal?: AbortSignal;
  workspace?: string;
  /** Explicit agent-state directory for embedded callers. */
  agentDirectory?: string;
  /** Optional host-owned credential store; all other runtime state still uses the resolved agent paths. */
  credentialStore?: CredentialStore;
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
  /** Session replacement reason supplied by an AgentSessionRuntime owner. */
  sessionStartEvent?: RuntimeSessionStartEvent;
  /** Already-active user and invocation extensions used for project trust. */
  preactivatedRuntimeExtensions?: RuntimeExtensionHost;
  /** Invocation-scoped project trust policy shared across workspace changes. */
  projectTrustResolver?: ProjectTrustResolver;
  /** Caller-owned content-free observer. SDK callers remain no-op when omitted. */
  observability?: RuntimeObservability;
  /** Caller-owned destination for SDK records. The runtime owns only its safe projector. */
  observabilitySink?: ObservabilitySink;
  /** Internal CLI opt-in for the default private JSONL observer. */
  localObservabilityMode?: ObservabilityMode;
  /** Optional caller-owned gate for model-requested tool effects. */
  toolAuthorizationHandler?: ToolAuthorizationHandler;
}

const RUNTIME_REFRESH_TIMEOUT_MS = 60_000;
const RUNTIME_PROVIDER_DISPOSAL_TIMEOUT_MS = 1_000;
const RUNTIME_GENERATION_CLOSE_TIMEOUT_MS = 25_000;
const RUNTIME_REFRESH_CLOSE_WAIT_TIMEOUT_MS = 40_000;
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
  options: { createLocalKey?: boolean; environment?: NodeJS.ProcessEnv; allowPlatformKeychain?: boolean } = {},
): Promise<CredentialStore> {
  return await createDefaultCredentialStore(paths.auth, options);
}

const BUILTIN_ROUTE_CATALOG_OBSERVED_AT = "2026-08-13T00:00:00.000Z";
const OPENCODE_GO_ROUTE_CATALOG_OBSERVED_AT = "2026-08-13T00:00:00.000Z";

function builtinRouteModel(
  provider: string,
  id: string,
  protocolFamily: ModelProtocolFamily,
  observedAt = BUILTIN_ROUTE_CATALOG_OBSERVED_AT,
): ModelInfo {
  const capability = (value: "supported" | "unknown") => ({
    value,
    source: "maintained" as const,
    observedAt,
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
        observedAt,
      },
    },
  };
}

function builtinRoutes(
  provider: string,
  adapter: string,
  protocolFamily: ModelProtocolFamily,
  ids: readonly string[],
  upstreamModel?: (model: string) => string,
  observedAt = BUILTIN_ROUTE_CATALOG_OBSERVED_AT,
) {
  return ids.map((model) => ({
    model,
    adapter,
    protocolFamily,
    ...(upstreamModel === undefined ? {} : { upstreamModel: upstreamModel(model) }),
    modelInfo: builtinRouteModel(provider, model, protocolFamily, observedAt),
  }));
}

const OPENCODE_BASE_URL = "https://opencode.ai/zen";
const OPENCODE_GO_BASE_URL = `${OPENCODE_BASE_URL}/go`;
const opencodeGoRoutes = (
  adapter: string,
  protocolFamily: ModelProtocolFamily,
  ids: readonly string[],
) => builtinRoutes(
  "opencode-go",
  adapter,
  protocolFamily,
  ids,
  undefined,
  OPENCODE_GO_ROUTE_CATALOG_OBSERVED_AT,
);

export const BUILTIN_PROVIDER_CONFIGS: Readonly<Record<string, RuntimeProviderConfig>> = Object.freeze({
  openai: { kind: "openai" },
  "openai-codex": { kind: "openai-codex" },
  anthropic: { kind: "anthropic" },
  "github-copilot": { kind: "github-copilot" },
  gemini: { kind: "gemini", protocol: "generate-content" },
  openrouter: { kind: "openrouter" },
  ollama: { kind: "ollama" },
  deepseek: {
    kind: "openai-compatible",
    id: "deepseek",
    baseUrl: "https://api.deepseek.com",
    credentialProvider: "deepseek",
  },
  "kimi-code": {
    kind: "openai-compatible",
    id: "kimi-code",
    baseUrl: "https://api.kimi.com/coding/v1",
    credentialProvider: "kimi-code",
    profile: "kimi-coding",
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
        reasoningTextDisplay: true,
      },
    },
    routes: [
      { model: "grok-4.20", adapter: "responses", protocolFamily: "openai-responses" },
      { model: "grok-4.20-multi-agent", adapter: "responses", protocolFamily: "openai-responses" },
      { model: "grok-4.20-non-reasoning", adapter: "responses", protocolFamily: "openai-responses" },
      { model: "grok-4.3", adapter: "responses", protocolFamily: "openai-responses" },
      { model: "grok-4.5", adapter: "responses", protocolFamily: "openai-responses" },
      { model: "grok-4.6", adapter: "responses", protocolFamily: "openai-responses" },
      { model: "grok-build-0.1", adapter: "responses", protocolFamily: "openai-responses" },
    ],
  },
  opencode: {
    kind: "routed",
    id: "opencode",
    credentialProvider: "opencode",
    catalogAdapter: "chat",
    adapters: {
      responses: { kind: "openai", baseUrl: `${OPENCODE_BASE_URL}/v1`, reasoningSummaries: true },
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
        "claude-fable-5", "claude-haiku-4-5", "claude-opus-4-5", "claude-opus-4-6",
        "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-4-5",
        "claude-sonnet-4-6", "claude-sonnet-5", "qwen3.5-plus", "qwen3.6-plus",
        "qwen3.7-max", "qwen3.7-plus",
      ]),
      ...builtinRoutes("opencode", "gemini", "gemini-generate-content", [
        "gemini-3-flash", "gemini-3.1-pro", "gemini-3.5-flash", "gemini-3.5-flash-lite",
        "gemini-3.6-flash",
      ]),
      ...builtinRoutes("opencode", "responses", "openai-responses", [
        "gpt-5", "gpt-5-codex", "gpt-5-nano", "gpt-5.1", "gpt-5.1-codex",
        "gpt-5.1-codex-max", "gpt-5.1-codex-mini", "gpt-5.2", "gpt-5.2-codex",
        "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano",
        "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
        "grok-4.5", "grok-4.6", "grok-build-0.1",
      ]),
      ...builtinRoutes("opencode", "chat-kimi", "openai-chat-completions", [
        "kimi-k2.5", "kimi-k2.6",
      ]),
      ...builtinRoutes("opencode", "chat", "openai-chat-completions", [
        "big-pickle", "deepseek-v4-flash", "deepseek-v4-flash-free", "deepseek-v4-pro", "glm-5",
        "glm-5.1", "glm-5.2", "hy3-free", "kimi-k2.7-code", "kimi-k3", "laguna-s-2.1-free",
        "ling-3.0-tiny-free", "mimo-v2.5-free", "minimax-m2.5", "minimax-m2.7", "minimax-m3",
        "nemotron-3.5-lightning-free", "nemotron-3-ultra-free",
      ]),
    ],
  },
  "opencode-go": {
    kind: "routed",
    id: "opencode-go",
    credentialProvider: "opencode-go",
    catalogAdapter: "chat",
    adapters: {
      responses: {
        kind: "openai",
        baseUrl: `${OPENCODE_GO_BASE_URL}/v1`,
        reasoningSummaries: true,
      },
      messages: {
        kind: "anthropic",
        id: "opencode-go-messages",
        baseUrl: OPENCODE_GO_BASE_URL,
        defaultMaxOutputTokens: 65_536,
        thinking: {
          budgets: { high: 16_000, max: 31_999 },
          models: {
            "minimax-m3": {
              mode: "adaptive",
              off: "disabled",
              supportsAdaptiveEffort: false,
            },
          },
        },
      },
      chat: {
        kind: "openai-compatible",
        id: "opencode-go-chat",
        baseUrl: `${OPENCODE_GO_BASE_URL}/v1`,
        profile: "opencode",
      },
    },
    routes: [
      ...opencodeGoRoutes("responses", "openai-responses", ["gpt-5.6-luna"]),
      ...opencodeGoRoutes("messages", "anthropic-messages", [
        "minimax-m2.7", "minimax-m3", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus", "qwen3.8-max",
      ]),
      ...opencodeGoRoutes("chat", "openai-chat-completions", [
        "deepseek-v4-flash", "deepseek-v4-pro", "glm-5.1", "glm-5.2", "grok-4.5", "hy3", "kimi-k2.6",
        "kimi-k2.7-code", "kimi-k3", "mimo-v2.5", "mimo-v2.5-pro",
      ]),
    ],
  },
});

export function runtimeProviderAuthBinding(
  configuredName: string,
  providerConfig: RuntimeProviderConfig,
  providerId: string,
  environment: NodeJS.ProcessEnv = process.env,
): ProviderAuthBinding {
  if (providerConfig.kind === "openai-codex") configuredOAuthClientId("openai-codex", environment);
  if (providerConfig.kind === "anthropic" && providerId === "anthropic") configuredOAuthClientId("anthropic", environment);
  if (providerConfig.kind === "github-copilot") configuredOAuthClientId("github-copilot", environment);
  const credentialId = providerConfig.credentialProvider ?? providerId;
  const remoteOllama = providerConfig.kind === "ollama" && (() => {
    const hostname = new URL(providerConfig.host ?? "http://127.0.0.1:11434").hostname;
    return !["127.0.0.1", "localhost", "::1"].includes(hostname);
  })();
  return {
    providerId,
    credentialId,
    displayName: providerDisplayName(
      providerConfig.kind === "openai-compatible" || providerConfig.kind === "routed"
        ? configuredName
        : providerId,
    ),
    ...(providerConfig.kind === "openai-codex"
      ? {}
      : providerConfig.kind === "bedrock" || remoteOllama
      ? { secret: "bearer" as const }
      : providerConfig.kind === "ollama"
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
    ...(providerConfig.kind === "openrouter" ? { openRouterBrowser: true } : {}),
    ...(providerConfig.kind === "openai-codex"
      ? { openAICodex: true }
      : {}),
    ...(providerConfig.kind === "anthropic" && providerId === "anthropic"
      ? { anthropicOAuth: true }
      : {}),
    ...(providerConfig.kind === "github-copilot"
      ? { githubCopilotOAuth: true }
      : {}),
  };
}

export function configuredProviderConfigs(
  settings: SettingsManager,
  environment: NodeJS.ProcessEnv,
): Record<string, RuntimeProviderConfig> {
  const providerConfigs = { ...BUILTIN_PROVIDER_CONFIGS };
  const codex = providerConfigs["openai-codex"];
  if (codex?.kind === "openai-codex") {
    const {
      transport: _transport,
      webSocketConnectTimeoutMs: _webSocketConnectTimeoutMs,
      webSocketIdleTimeoutMs: _webSocketIdleTimeoutMs,
      ...base
    } = codex;
    const connectTimeoutMs = settings.getWebSocketConnectTimeoutMs();
    providerConfigs["openai-codex"] = {
      ...base,
      transport: settings.getTransport(),
      webSocketIdleTimeoutMs: settings.getHttpIdleTimeoutMs(),
      ...(connectTimeoutMs === undefined ? {} : { webSocketConnectTimeoutMs: connectTimeoutMs }),
    };
  }
  void environment;
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

async function refreshRuntimeSettings(settings: SettingsManager): Promise<void> {
  settings.drainErrors();
  await settings.refresh();
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
  environment: NodeJS.ProcessEnv,
  bindings: readonly ProviderAuthBinding[],
): Record<string, OAuthRegistrationConfig> {
  const registrations: Record<string, OAuthRegistrationConfig> = {};
  if (bindings.some((binding) => binding.providerId === "xai" && binding.credentialId === "xai")) {
    registrations[XAI_OAUTH_REGISTRATION_ID] = xaiOAuthRegistration(
      configuredOAuthClientId("xai", environment),
    );
  }
  if (bindings.some((binding) => binding.providerId === "kimi-code" && binding.credentialId === "kimi-code")) {
    registrations[KIMI_CODE_OAUTH_REGISTRATION_ID] = kimiCodeOAuthRegistration(
      configuredOAuthClientId("kimi-code", environment),
    );
  }
  return registrations;
}

async function refreshBuiltinGitHubCopilotOAuth(
  credential: OAuthCredential,
  signal: AbortSignal | undefined,
  fetchImplementation: typeof globalThis.fetch,
  environment: NodeJS.ProcessEnv,
) {
  const enterpriseHost = configuredGitHubCopilotHost(environment);
  const refreshed = await refreshGitHubCopilotOAuth({
    ...credential,
    providerData: { enterpriseHost },
  }, signal, fetchImplementation);
  return { ...refreshed, providerData: { enterpriseHost } };
}

function directProviderAuth(
  providerId: string,
  broker: CredentialBroker,
  auth: ProviderAuthRegistry,
  lifecycleSignal: AbortSignal,
  fetch: typeof globalThis.fetch,
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
    const credential = resolved.credential;
    if (credential.kind === "ambient") return { auth: {}, source: resolved.source };
    const key = credential.kind === "api_key" ? credential.apiKey : credential.accessToken;
    return {
      auth: {
        ...(key === undefined ? {} : { apiKey: key }),
      },
      ...(credential.kind !== "api_key" || credential.env === undefined ? {} : { env: credential.env }),
      source: resolved.source,
    };
  };
  const apiKey = {
    name: providerDisplayName(providerId),
    async resolve({ credential }) {
      if (credential !== undefined && (credential.key !== undefined || credential.env !== undefined)) {
        return {
          auth: credential.key === undefined ? {} : { apiKey: credential.key },
          ...(credential.env === undefined ? {} : { env: credential.env }),
          source: "stored credential",
        };
      }
      return await resolvedAuth();
    },
  } satisfies NonNullable<ProviderAuth["apiKey"]>;
  const oauth: NonNullable<ProviderAuth["oauth"]> = {
    name: `${providerDisplayName(providerId)} account`,
    async refresh(credential, signal) {
      const requestSignal = signal === undefined
        ? lifecycleSignal
        : AbortSignal.any([lifecycleSignal, signal]);
      requestSignal.throwIfAborted();
      const current = hostOAuthCredential(providerId, credential);
      if (providerId === "kimi-code" || providerId === "xai") {
        const registered = pinnedBuiltinOAuthRefreshCredential(providerId, current, process.env);
        const refreshed = await refreshGenericOAuthWithFetch(registered, requestSignal, fetch);
        return convertedCredential({ ...registered, ...refreshed });
      }
      const refreshed = providerId === "openai-codex"
        ? await refreshOpenAICodexCredential({
            ...current,
            clientId: current.clientId ?? configuredOAuthClientId("openai-codex", process.env),
          }, requestSignal, fetch)
        : providerId === "anthropic"
          ? await refreshAnthropicOAuth({
              ...current,
              clientId: current.clientId ?? configuredOAuthClientId("anthropic", process.env),
          }, requestSignal, fetch)
          : providerId === "github-copilot"
            ? await refreshBuiltinGitHubCopilotOAuth(current, requestSignal, fetch, process.env)
            : await refreshGenericOAuthWithFetch(current, requestSignal, fetch);
      return convertedCredential({ ...current, ...refreshed });
    },
    async toAuth(credential) {
      return { apiKey: credential.access };
    },
  };
  const requestSignal = (interactionSignal: AbortSignal | undefined): AbortSignal =>
    interactionSignal === undefined
      ? lifecycleSignal
      : AbortSignal.any([lifecycleSignal, interactionSignal]);
  const convertedCredential = (credential: AuthCredential) => {
    const converted = providerOAuthCredential(credential);
    if (converted === undefined) throw new Error(`${providerDisplayName(providerId)} authorization did not return OAuth credentials`);
    return converted;
  };
  if (providerId === "openai-codex") {
    const clientId = configuredOAuthClientId("openai-codex", process.env);
    oauth.loginLabel = "Sign in with ChatGPT";
    oauth.login = async (interaction) => {
      const signal = requestSignal(interaction.signal);
      const method = await interaction.prompt({
        type: "select",
        message: "Select login method:",
        options: [
          { id: "browser", label: "Browser login" },
          { id: "device", label: "Device code login", description: "For remote or headless systems" },
        ],
        signal,
      });
      if (method !== "browser" && method !== "device") throw new Error(`Unknown login method: ${method}`);
      return convertedCredential(await authorizeOpenAICodex({
        clientId,
        flow: method,
        signal,
        fetch,
        showAuthorization({ url, userCode }) {
          if (userCode === undefined) interaction.notify({ type: "auth_url", url: url.href });
          else interaction.notify({ type: "device_code", userCode, verificationUri: url.href });
        },
        ...(method === "browser"
          ? {
              requestManualAuthorization: async ({ redirectUri }, promptSignal: AbortSignal) => {
                const value = await interaction.prompt({
                  type: "manual_code",
                  message: "Paste the authorization code or final redirect URL, or press Enter to wait for the browser callback:",
                  placeholder: redirectUri,
                  signal: promptSignal,
                });
                return value.trim() === "" ? undefined : value;
              },
            }
          : {}),
      }));
    };
  }
  if (providerId === "anthropic") {
    const clientId = configuredOAuthClientId("anthropic", process.env);
    oauth.loginLabel = "Sign in with Claude";
    oauth.login = async (interaction) => {
        const signal = requestSignal(interaction.signal);
        const credential = await authorizeAnthropic({
          clientId,
          signal,
          fetch,
          showAuthorization({ url }) {
            interaction.notify({ type: "auth_url", url: url.href });
          },
          requestManualAuthorization: async ({ redirectUri }, signal) => {
            const value = await interaction.prompt({
              type: "manual_code",
              message: "Paste the authorization code or final redirect URL, or press Enter to wait for the browser callback:",
              placeholder: redirectUri,
              signal,
            });
            return value.trim() === "" ? undefined : value;
          },
        });
        return convertedCredential(credential);
    };
  }
  if (providerId === "github-copilot") {
    const clientId = configuredOAuthClientId("github-copilot", process.env);
    oauth.loginLabel = "Sign in with GitHub Copilot";
    oauth.login = async (interaction) => convertedCredential(await authorizeGitHubCopilot({
      clientId,
      experimentalTokenBroker: true,
      requestHost: async () => configuredGitHubCopilotHost(process.env),
      showDeviceCode({ url, userCode }) {
        interaction.notify({ type: "device_code", userCode, verificationUri: url.href });
      },
      showProgress(message) {
        interaction.notify({ type: "progress", message });
      },
      signal: requestSignal(interaction.signal),
      fetch,
    }));
  }
  if (providerId === "xai" || providerId === "kimi-code") {
    const registration = providerId === "xai"
      ? xaiOAuthRegistration(configuredOAuthClientId("xai", process.env))
      : kimiCodeOAuthRegistration(configuredOAuthClientId("kimi-code", process.env));
    oauth.loginLabel = registration.label ?? `Sign in with ${providerDisplayName(providerId)}`;
    oauth.login = async (interaction) => convertedCredential(await authorizeOAuthRegistration(
      registration,
      providerId,
      {
        showAuthorization({ url, userCode }) {
          if (userCode === undefined) interaction.notify({ type: "auth_url", url: url.href });
          else interaction.notify({ type: "device_code", userCode, verificationUri: url.href });
        },
        signal: requestSignal(interaction.signal),
        fetch,
      },
    ));
  }
  return {
    apiKey,
    ...(providerId === "openrouter"
      ? { providerAccount: openRouterBrowserAccount({ fetch, signal: lifecycleSignal }) }
      : {}),
    oauth,
  };
}

function requestApiKeyOverridesBroker(
  options: ProviderStreamOptions,
): options is ProviderStreamOptions & { apiKey: string } {
  return options.apiKey !== undefined && (
    options.authSource === "configuration" ||
    options.authSource === "request override" ||
    options.authSource === "stored credential resolution"
  );
}

function requestCredentialBroker(
  broker: CredentialBroker,
  credentialId: string,
  options: ProviderStreamOptions,
): CredentialBroker {
  const sources: CredentialSource[] = [];
  if (requestApiKeyOverridesBroker(options)) {
    sources.push(new ExplicitCredentialSource(new Map([[
      credentialId,
      {
        kind: "api_key",
        provider: credentialId,
        apiKey: options.apiKey,
        ...(options.env === undefined ? {} : { env: options.env }),
      },
    ]])));
  }
  sources.push({
    name: "runtime",
    async resolve(request) {
      return (await broker.resolve(request))?.credential;
    },
  });
  return new CredentialBroker(sources);
}

function privateRequestHeaders(
  headers: Record<string, string | null> | undefined,
  modelHeaders: Record<string, string> | undefined,
): Record<string, string | null> | undefined {
  if (headers === undefined) return undefined;
  const model = new Map(
    Object.entries(modelHeaders ?? {}).map(([name, value]) => [name.toLocaleLowerCase("en-US"), value]),
  );
  const selected = Object.fromEntries(Object.entries(headers).filter(([name, value]) =>
    model.get(name.toLocaleLowerCase("en-US")) !== value));
  return Object.keys(selected).length === 0 ? undefined : selected;
}

function chainedWireOperation(
  first: ProviderWireOperation,
  second: ProviderWireOperation,
): ProviderWireOperation {
  return {
    active: first.active || second.active,
    async intercept(request, signal) {
      const prepared = await first.intercept(request, signal);
      const final = await second.intercept({
        url: prepared.url,
        method: request.method,
        headers: prepared.headers,
        ...(prepared.body === undefined ? {} : { body: prepared.body }),
        ...(request.transport === undefined ? {} : { transport: request.transport }),
        ...(request.phase === undefined ? {} : { phase: request.phase }),
      }, signal);
      return {
        ...final,
        bodyChanged: prepared.bodyChanged || final.bodyChanged,
        headersChanged: prepared.headersChanged || final.headersChanged,
        urlChanged: prepared.urlChanged || final.urlChanged,
      };
    },
    async observe(response, signal) {
      await second.observe(response, signal);
      await first.observe(response, signal);
    },
  };
}

async function invokeProviderCallback<T>(callback: () => T | Promise<T>): Promise<T> {
  try {
    return await callback();
  } catch (cause) {
    throw new Error(errorMessage(cause), { cause });
  }
}

/** @internal Applies request-private headers after extension-visible wire lifecycle interception. */
export function requestWireTransport(
  base: ProviderWireTransportHost,
  provider: string,
  headers: Record<string, string | null> | undefined,
  callbacks?: {
    model: ProviderModel;
    onPayload?: ProviderRequest["onPayload"];
    onResponse?: ProviderRequest["onResponse"];
  },
): ProviderWireTransportHost {
  if (headers === undefined && callbacks?.onPayload === undefined && callbacks?.onResponse === undefined) return base;
  const final = new ProviderWireInterceptorRegistry();
  final.register(provider, {
    async interceptRequest(request) {
      const payload = request.body === undefined || callbacks?.onPayload === undefined
        ? undefined
        : await invokeProviderCallback(() => callbacks.onPayload!(request.body!, callbacks.model));
      if (payload !== undefined && !isJsonValue(payload)) {
        throw new TypeError("Provider onPayload callback must return JSON");
      }
      const requestHeaders = request.transport === "websocket" && request.phase === "frame"
        ? undefined
        : headers;
      if (requestHeaders === undefined && payload === undefined) return;
      return {
        ...(requestHeaders === undefined ? {} : { headers: requestHeaders }),
        ...(payload === undefined ? {} : { body: payload }),
      };
    },
    async observeResponse(response) {
      if (response.phase === "frame") return;
      if (callbacks?.onResponse !== undefined) {
        await invokeProviderCallback(
          () => callbacks.onResponse!({ status: response.status, headers: response.headers }, callbacks.model),
        );
      }
    },
  });
  return {
    wrapFetch(providerId, fetchImplementation) {
      return base.wrapFetch(providerId, final.wrapFetch(providerId, fetchImplementation));
    },
    begin(providerId) {
      return chainedWireOperation(base.begin(providerId), final.begin(providerId));
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
  cacheRetention: ProviderRequest["cacheRetention"],
  observability?: RuntimeObservability,
  toolAuthorizationHandler?: ToolAuthorizationHandler,
): Omit<AgentSessionOptions, "sessionManager" | "workspace" | "model" | "thinkingLevel"> {
  const settings = generation.settings;
  const compactionReserveTokens = settings.getCompactionReserveTokens();
  const compactionRecentTokens = settings.getCompactionRecentTokens();
  return {
    providers: generation.providers,
    modelRegistry: generation.modelRegistry,
    resourceLoader: generation.resourceLoader,
    extensionRunner: generation.runtimeExtensions,
    providerWireLifecycle: generation.providerWire,
    ...(observability === undefined ? {} : { observability }),
    providerDisplayNameOverride(provider, displayName) {
      return generation.auth.has(provider)
        ? generation.auth.overrideDisplayName(provider, displayName)
        : undefined;
    },
    settingsManager: settings,
    tools: generation.extraTools,
    outboundImages: settings.getBlockImages() ? "block" : "allow",
    ...(cacheRetention === undefined ? {} : { cacheRetention }),
    ...(generation.toolBackend === undefined ? {} : { toolBackend: generation.toolBackend }),
    ...(toolAuthorizationHandler === undefined ? {} : { toolAuthorizationHandler }),
    autoCompaction: settings.getCompactionEnabled(),
    ...(compactionReserveTokens === undefined ? {} : { compactionReserveTokens }),
    ...(compactionRecentTokens === undefined ? {} : { compactionRecentTokens }),
    imageAutoResize: settings.getImageAutoResize(),
  };
}

function configuredObservabilityLevel(settings: SettingsManager, environment: NodeJS.ProcessEnv): ObservabilityLevel {
  return resolveObservabilityLevel(settings.getObservabilityLevel(), environment);
}

function localObservabilityDirectory(paths: AgentPaths): string {
  return paths.logs;
}

function cacheRetentionFromEnvironment(
  environment: NodeJS.ProcessEnv,
): ProviderRequest["cacheRetention"] {
  const value = environment.RIGYN_CACHE_RETENTION;
  if (value === undefined) return undefined;
  if (value === "none" || value === "short" || value === "long") return value;
  throw new Error("RIGYN_CACHE_RETENTION must be none, short, or long");
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

export function runtimeDiscoveryView(host: RuntimeExtensionHost, loader: ResourceLoader): RuntimeDiscoveryView {
  const maximumPerKind = 512;
  const runtimeCommands = host.commands();
  const prompts = loader.getPrompts().prompts;
  const skills = loader.getSkills().skills;
  const commandResources: RuntimeDiscoverableResource[] = [
    ...BUILTIN_SLASH_COMMANDS.map((command): RuntimeDiscoverableResource => ({
      kind: "command",
      source: "builtin",
      name: command.name,
      ...(command.description === undefined ? {} : { description: command.description }),
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
  await refreshRuntimeSettings(settings);
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
  storedCredentials: ProfiledRefreshingStoredCredentialSource,
  options: Pick<RuntimeOptions, "projectTrusted" | "ephemeral" | "extensions" | "extensionPaths" | "extensionFactories" | "extensionRuntime" | "skills" | "skillPaths" | "promptTemplates" | "promptTemplatePaths" | "themes" | "themePaths" | "systemPrompt" | "appendSystemPrompt" | "sessionDirectory" | "offline" | "deferModelNetworkRefresh">,
  reason: "startup" | "refresh" = "startup",
  signal?: AbortSignal,
  preactivatedRuntimeExtensions?: RuntimeExtensionHost,
  codexTransportObserver?: OpenAICodexTransportObserver,
): Promise<RuntimeResourceGeneration> {
  signal?.throwIfAborted();
  const trust = new TrustStore(paths.trustStore);
  const requestedTrust = options.projectTrusted ?? await trust.isTrusted(workspace);
  const settings = SettingsManager.create(workspace, paths.agentDirectory, { projectTrusted: requestedTrust });
  const trusted = settings.isProjectTrusted();
  await refreshRuntimeSettings(settings);
  const toolBackend: ToolExecutionBackend | undefined = undefined;
  const authoringResources = bundledAuthoringResources();
  const network = createNetworkTransport(networkOptions(settings, process.env));
  const abortController = new AbortController();
  const modelCatalogStore = new FileModelCatalogStore(paths.modelCatalog);
  const modelCatalogBaseline = await modelCatalogStore.read(RUNTIME_MODEL_CATALOG_MAX_BYTES).catch(() => undefined);
  const providers = new ProviderRegistry([], { catalogStore: modelCatalogStore });
  const providerWire = new ProviderWireInterceptorRegistry();
  const authBindings: ProviderAuthBinding[] = [];
  const providerConfigs = configuredProviderConfigs(settings, process.env);
  const providerConfigsById = new Map<string, RuntimeProviderConfig>();
  for (const [configuredName, providerConfig] of Object.entries(providerConfigs)) {
    const providerOptions: NonNullable<Parameters<typeof createProviderAdapter>[2]> & OpenAICodexObservabilityOptions = {
      fetch: network.fetch,
      ...(network.openWebSocket === undefined ? {} : { webSocket: network.openWebSocket }),
      wire: providerWire,
      environment: process.env,
      ...(codexTransportObserver === undefined ? {} : { [OPENAI_CODEX_TRANSPORT_OBSERVER]: codexTransportObserver }),
    };
    const adapter = createProviderAdapter(providerConfig, broker, providerOptions);
    providers.register(adapter);
    providerConfigsById.set(adapter.id, providerConfig);
    authBindings.push(runtimeProviderAuthBinding(configuredName, providerConfig, adapter.id, process.env));
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
        ...(reason === "refresh" || directAdditionalSources.length > 0 ? { activationFailure: "throw" as const } : {}),
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
        ...(reason === "refresh" || directAdditionalSources.length > 0 ? { activationFailure: "throw" as const } : {}),
      });
		runtimeExtensions.reorderCommittedExtensions(direct.paths);
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
    registrations: configuredOAuthRegistrations(process.env, authBindings),
    environment: process.env,
    store: credentials,
  });
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
    const providerShellPath = settings.getShellPath();
    const directCredentials = new ProviderCredentialStoreAdapter(credentials);
    const directModels = createModels({
      credentials: directCredentials,
      modelsStore: new FileProviderModelsStore(join(paths.agentDirectory, "models-store.json")),
      authContext: defaultProviderAuthContext(process.env, {
        ...(providerShellPath === undefined ? {} : { shellPath: providerShellPath }),
      }),
    });
    for (const adapter of providers.list()) {
      const binding = auth.binding(adapter.id);
      const providerConfig = providerConfigsById.get(adapter.id);
      const catalogModels = providers.getModels(adapter.id);
      const initialModels = providerConfig?.kind === "openai-codex"
        ? [...new Map(
            [...openAICodexModels(), ...catalogModels].map((model) => [model.id, model]),
          ).values()]
        : catalogModels;
      directModels.setProvider(providerFromAdapter(adapter, {
        auth: directProviderAuth(adapter.id, broker, auth, abortController.signal, network.fetch),
        allowUnauthenticatedRefresh: binding.local === true || binding.externallyManaged === true,
        listModels: async (modelSignal) => {
          const result = await providers.refreshModels(adapter.id, modelSignal);
          if (!result.ok) {
            throw new Error(result.status.error?.message ?? `Model catalog refresh failed for ${adapter.id}`);
          }
          return await providers.listModels(adapter.id, modelSignal, { verifiedOnly: true });
        },
        initialModels: providerConfig === undefined
          ? initialModels.filter((model) => model.compatibility?.protocolFamily?.value !== undefined)
          : initialModels,
        model: (info) => providerModelFromInfo(
          info,
          providerConfig === undefined
            ? undefined
            : runtimeProviderModelProtocolFamily(providerConfig, info.id),
        ),
        ...(providerConfig === undefined
          ? {}
          : {
              streamRequest(
                request: ProviderRequest,
                streamOptions: ProviderStreamOptions,
                requestSignal: AbortSignal,
                model: ProviderModel,
              ) {
                const headers = privateRequestHeaders(
                  streamOptions.headers,
                  request.modelSettings?.headers,
                );
                const explicitOverride = requestApiKeyOverridesBroker(streamOptions);
                const hasCallbacks = streamOptions.onPayload !== undefined || streamOptions.onResponse !== undefined;
                const hasFetchOverride = streamOptions.fetch !== undefined;
                const hasCodexTransportOverride = providerConfig.kind === "openai-codex" && (
                  streamOptions.transport !== undefined
                  || streamOptions.websocketConnectTimeoutMs !== undefined
                  || streamOptions.websocketIdleTimeoutMs !== undefined
                );
                if (
                  headers === undefined && streamOptions.env === undefined && !explicitOverride && !hasCallbacks &&
                  !hasFetchOverride && !hasCodexTransportOverride
                ) {
                  return adapter.stream(request, requestSignal);
                }
                return (async function*() {
                  const requestBroker = requestCredentialBroker(
                    broker,
                    binding.credentialId,
                    streamOptions,
                  );
                  const requestEnvironment = { ...process.env, ...streamOptions.env };
                  const requestProviderConfig: RuntimeProviderConfig = providerConfig.kind === "openai-codex"
                    ? {
                        ...providerConfig,
                        ...(streamOptions.transport === undefined ? {} : { transport: streamOptions.transport }),
                        ...(streamOptions.websocketConnectTimeoutMs === undefined
                          ? {}
                          : { webSocketConnectTimeoutMs: streamOptions.websocketConnectTimeoutMs }),
                        ...(streamOptions.websocketIdleTimeoutMs === undefined
                          ? {}
                          : { webSocketIdleTimeoutMs: streamOptions.websocketIdleTimeoutMs }),
                      }
                    : providerConfig;
                  const requestProviderOptions: NonNullable<Parameters<typeof createProviderAdapter>[2]>
                    & OpenAICodexObservabilityOptions = {
                    fetch: streamOptions.fetch ?? network.fetch,
                    ...(network.openWebSocket === undefined ? {} : { webSocket: network.openWebSocket }),
                    wire: requestWireTransport(providerWire, adapter.id, headers, {
                      model,
                      ...(streamOptions.onPayload === undefined ? {} : { onPayload: streamOptions.onPayload }),
                      ...(streamOptions.onResponse === undefined ? {} : { onResponse: streamOptions.onResponse }),
                    }),
                    environment: requestEnvironment,
                    ...(codexTransportObserver === undefined
                      ? {}
                      : { [OPENAI_CODEX_TRANSPORT_OBSERVER]: codexTransportObserver }),
                  };
                  const requestAdapter = createProviderAdapter(
                    requestProviderConfig,
                    requestBroker,
                    requestProviderOptions,
                  );
                  try {
                    yield* requestAdapter.stream(request, requestSignal);
                  } finally {
                    await requestAdapter.dispose?.();
                  }
                })();
              },
            }),
      }));
    }
    const modelRegistry = new CredentialSnapshotModelRegistry(
      directModels,
      directCredentials,
      storedCredentials,
    );
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
      preparedExtensions: runtimeExtensions,
      extensionFactories: [...(options.extensionFactories ?? [])],
      noExtensions: options.extensionRuntime !== true || options.extensions !== true,
      noSkills: options.skills === false,
      noPromptTemplates: options.promptTemplates === false,
      noThemes: options.themes === false,
      additionalSkillPaths: [
		...(options.skills === false ? [] : [
			authoringResources.skillRoot,
			...additionalDirectResources.skills.filter((resource) => resource.enabled).map((resource) => resource.path),
		]),
        ...(options.skillPaths ?? []).map((path) => expandPath(path, workspace)),
      ],
      additionalPromptTemplatePaths: [
		...(options.promptTemplates === false ? [] : [
			...additionalDirectResources.prompts.filter((resource) => resource.enabled).map((resource) => resource.path),
		]),
        ...(options.promptTemplatePaths ?? []).map((path) => expandPath(path, workspace)),
      ],
      additionalThemePaths: [
		...(options.themes === false ? [] : [
			...additionalDirectResources.themes.filter((resource) => resource.enabled).map((resource) => resource.path),
		]),
        ...(options.themePaths ?? []).map((path) => expandPath(path, workspace)),
      ],
    });
    await resourceLoader.refresh({ preparedSettings: settings, ...(signal === undefined ? {} : { signal }) });
    runtimeExtensions.addRegistrationCleanup(bindDirectProviderWireLifecycle(runtimeExtensions, providerWire));
    runtimeExtensions.setDirectDiscoveryHandler((discoverySignal) => {
      discoverySignal?.throwIfAborted();
      return runtimeDiscoveryView(runtimeExtensions, resourceLoader);
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
  runtime.providerWireLifecycle = generation.providerWire;
  runtime.extensions = generation.extensions;
  runtime.runtimeExtensions = generation.runtimeExtensions;
  if (generation.sessionDirectory === undefined) delete runtime.sessionDirectory;
  else runtime.sessionDirectory = generation.sessionDirectory;
  runtime.generationSignal = generation.abortController.signal;
}

export async function loadRuntime(options: RuntimeOptions = {}): Promise<LoadedRuntime> {
  const runtimeStartedAt = Date.now();
  options.signal?.throwIfAborted();
  const cacheRetention = cacheRetentionFromEnvironment(process.env);
  const paths = agentPaths(process.env, options.agentDirectory);
  const workspace = await canonicalExistingPath(resolve(options.workspace ?? process.cwd()));
  let observability = options.observability;
  let ownsObservability = false;
  if (observability === undefined && options.observabilitySink !== undefined) {
    observability = new RuntimeObservability(options.observabilitySink, {
      level: "debug",
      mode: "sdk",
      closeSink: false,
    });
    ownsObservability = true;
  }
  if (observability === undefined && options.localObservabilityMode !== undefined) {
    const observerSettings = SettingsManager.create(workspace, paths.agentDirectory, { projectTrusted: false });
    await observerSettings.refresh();
    const level = configuredObservabilityLevel(observerSettings, process.env);
    if (level !== "off") {
      const sink = await acquireProcessLocalObservabilitySink(localObservabilityDirectory(paths));
      observability = new RuntimeObservability(sink, {
        level,
        mode: options.localObservabilityMode,
        closeSink: false,
      });
      ownsObservability = true;
    }
  }
  observability?.event("startup", "runtime_loading", {
    version: RIGYN_VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    offline: options.offline === true,
    ephemeral: options.ephemeral === true,
  });
  const failStartup = async (stage: string): Promise<void> => {
    observability?.event("startup", "runtime_load_failed", { stage }, "error");
    if (ownsObservability) await observability?.close().catch(() => undefined);
  };
  try { options.signal?.throwIfAborted(); }
  catch (error) {
    await failStartup("cancelled");
    throw error;
  }
  let resolvedProjectTrust: boolean | undefined;
  try {
    resolvedProjectTrust = options.projectTrusted
      ?? await options.projectTrustResolver?.isTrusted(workspace);
  } catch (error) {
    await failStartup("project_trust");
    throw error;
  }
  const effectiveOptions: RuntimeOptions = resolvedProjectTrust === undefined
    ? options
    : { ...options, projectTrusted: resolvedProjectTrust };
  let credentials: CredentialStore;
  try {
    credentials = options.credentialStore ?? await createCredentialStore(paths, { createLocalKey: true });
  } catch (error) {
    await failStartup("credentials");
    throw error;
  }
  let activeNetwork: NetworkTransport | undefined;
  const explicitCredentials = new Map<string, AuthCredential>();
  if (options.apiKey !== undefined) {
    const provider = options.apiKeyProvider ?? "openai";
    explicitCredentials.set(provider, { kind: "api_key", provider, apiKey: options.apiKey });
  }
  const managedAuth = new ManagedProviderAuthDirectory();
  const storedCredentials = new ProfiledRefreshingStoredCredentialSource(credentials, {
    refresh: async (credential, signal) => {
      const fetchImplementation = activeNetwork?.fetch ?? globalThis.fetch;
      if (credential.provider === "anthropic") {
        return await refreshAnthropicOAuth(credential, signal, fetchImplementation);
      }
      if (credential.provider === "github-copilot") {
        return await refreshBuiltinGitHubCopilotOAuth(credential, signal, fetchImplementation, process.env);
      }
      if (credential.provider === "openai-codex") {
        return await refreshOpenAICodexCredential(credential, signal, fetchImplementation);
      }
      if (credential.provider === "kimi-code") {
        const registered = pinnedBuiltinOAuthRefreshCredential("kimi-code", credential, process.env);
        const refreshed = await refreshGenericOAuthWithFetch(
          registered,
          signal,
          fetchImplementation,
        );
        return { ...refreshed, tokenEndpoint: registered.tokenEndpoint, clientId: registered.clientId };
      }
      if (credential.provider === "xai") {
        const registered = pinnedBuiltinOAuthRefreshCredential("xai", credential, process.env);
        const refreshed = await refreshGenericOAuthWithFetch(
          registered,
          signal,
          fetchImplementation,
        );
        return { ...refreshed, tokenEndpoint: registered.tokenEndpoint, clientId: registered.clientId };
      }
      const managed = await managedAuth.refresh(credential, signal);
      if (managed !== undefined) return managed;
      return await refreshGenericOAuthWithFetch(credential, signal, fetchImplementation);
    },
  });
  const broker = new CredentialBroker([
    ...(explicitCredentials.size === 0 ? [] : [new ExplicitCredentialSource(explicitCredentials)]),
    storedCredentials,
    new EnvironmentCredentialSource(),
  ]);
  let preactivatedRuntimeExtensions: RuntimeExtensionHost | undefined;
  try {
    preactivatedRuntimeExtensions = options.preactivatedRuntimeExtensions
      ?? (effectiveOptions.extensionRuntime === true
        ? await options.projectTrustResolver?.takePreactivatedExtensions(workspace)
        : undefined);
  } catch (error) {
    await failStartup("extensions");
    throw error;
  }
  let generation: RuntimeResourceGeneration;
  try {
    generation = await loadResourceGeneration(
      paths,
      workspace,
      broker,
      credentials,
      storedCredentials,
      effectiveOptions,
      "startup",
      options.signal,
      preactivatedRuntimeExtensions,
      runtimeOpenAICodexTransportObserver(() => observability),
    );
  } catch (error) {
    await preactivatedRuntimeExtensions?.close().catch(() => undefined);
    await failStartup("resources");
    throw error;
  }
  activeNetwork = generation.network;
  try {
    observability?.setLevel(configuredObservabilityLevel(generation.settings, process.env));
  } catch (error) {
    await generation.close().catch(() => undefined);
    await failStartup("settings");
    throw error;
  }
  let sessionManager!: SessionManager;
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
      ...(options.sessionStartEvent === undefined ? {} : { sessionStartEvent: options.sessionStartEvent }),
      ...agentSessionResources(generation, cacheRetention, observability, options.toolAuthorizationHandler),
    });
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      sessionManager?.closeV4Store();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    try {
      await generation.close();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    observability?.event("startup", "runtime_load_failed", { stage: "session" }, "error");
    if (ownsObservability) {
      try { await observability?.close(); }
      catch (cleanupError) { failures.push(cleanupError); }
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Runtime initialization and cleanup failed");
    }
    throw error;
  }

  observability?.event("startup", "runtime_loaded", {
    duration_ms: Math.max(0, Date.now() - runtimeStartedAt),
    trusted: generation.trusted,
    offline: options.offline === true,
    ephemeral: options.ephemeral === true,
    extensions: generation.runtimeExtensions.extensions().length,
    providers: generation.providers.list().length,
  });

  let closed = false;
  let refreshFlight: Promise<RuntimeRefreshResult> | undefined;
  let refreshAbortController: AbortController | undefined;
  let extensionShutdownHandler: (() => unknown | Promise<unknown>) | undefined;
  let extensionMode = generation.runtimeExtensions.hostContext().mode;
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
    providerWireLifecycle: generation.providerWire,
    sessionManager,
    session,
    extensions: generation.extensions,
    runtimeExtensions: generation.runtimeExtensions,
    ...(generation.sessionDirectory === undefined ? {} : { sessionDirectory: generation.sessionDirectory }),
    generationSignal: generation.abortController.signal,
    ...(observability === undefined ? {} : { observability }),
    setExtensionShutdownHandler(handler): void {
      if (closed) throw new Error("Runtime is closed");
      extensionShutdownHandler = handler;
    },
    async refresh(refreshOptions: RuntimeRefreshOptions = {}): Promise<RuntimeRefreshResult> {
      if (closed) throw new Error("Runtime is closed");
      refreshOptions.signal?.throwIfAborted();
      if (refreshFlight !== undefined) throw new Error("Runtime refresh is already in progress");
      const refreshStartedAt = Date.now();
      observability?.event("runtime", "refresh_started");
      const operationAbortController = new AbortController();
      const operation = (async (): Promise<RuntimeRefreshResult> => {
        const signals = [operationAbortController.signal, AbortSignal.timeout(RUNTIME_REFRESH_TIMEOUT_MS)];
        if (refreshOptions.signal !== undefined) signals.push(refreshOptions.signal);
        const signal = AbortSignal.any(signals);
        signal.throwIfAborted();
        if (!runtime.session.isIdle) {
          throw new Error("Runtime refresh requires an idle AgentSession");
        }
        const previous = generation;
        const previousSession = runtime.session;
        if (!previous.runtimeExtensions.lifecycleSignal().aborted) {
          extensionMode = previous.runtimeExtensions.hostContext().mode;
        }
        const warnings: string[] = [];
        let committed = false;
        let shutdownStarted = false;
        let candidate: Awaited<ReturnType<typeof loadResourceGeneration>> | undefined;
        let candidateSession: AgentSession | undefined;
        let candidateObservability = observability;
        let ownsCandidateObservability = false;
        let catalogRollback: ModelCatalogRollback | undefined;
        try {
          shutdownStarted = true;
          await previous.runtimeExtensions.dispatch("session_shutdown", {
            reason: "refresh",
          } as never, signal).catch((error: unknown) => {
            warnings.push(`Extension session shutdown failed: ${errorMessage(error)}`);
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
            storedCredentials,
            effectiveOptions,
            "refresh",
            signal,
            undefined,
            runtimeOpenAICodexTransportObserver(() => candidateObservability),
          );
          candidate.runtimeExtensions.setHostContext({ mode: extensionMode });
          if (candidate.sessionDirectory !== previous.sessionDirectory) {
            throw new Error("sessionDirectory cannot change during /refresh; restart rigyn to use the new location");
          }
          const candidateObservabilityLevel = configuredObservabilityLevel(candidate.settings, process.env);
          if (
            candidateObservability === undefined
            && options.localObservabilityMode !== undefined
            && candidateObservabilityLevel !== "off"
          ) {
            const sink = await acquireProcessLocalObservabilitySink(localObservabilityDirectory(paths));
            candidateObservability = new RuntimeObservability(sink, {
              level: "off",
              mode: options.localObservabilityMode,
              closeSink: false,
            });
            ownsCandidateObservability = true;
          }
          const previousModel = previousSession.nativeModel;
          const candidateModel = previousModel === undefined
            ? undefined
            : candidate.modelRegistry.find(previousModel.provider, previousModel.id);
          const replacementModel = candidateModel === undefined
            ? previousModel
            : {
                provider: candidateModel.provider,
                api: candidateModel.api,
                id: candidateModel.id,
                info: providerModelToInfo(candidateModel),
              };
          candidateSession = await AgentSession.create(markAgentSessionSharedStoreReplacement({
            sessionManager,
            workspace,
            agentDirectory: paths.agentDirectory,
            projectTrusted: candidate.trusted,
            ...agentSessionResources(
              candidate,
              cacheRetention,
              candidateObservability,
              options.toolAuthorizationHandler,
            ),
            ...(replacementModel === undefined ? {} : { model: replacementModel }),
            thinkingLevel: previousSession.thinkingLevel,
          }));
          bindExtensionControls(candidate, candidateSession);
          await refreshOptions.prepareExtensions?.(candidate.runtimeExtensions);
          await refreshOptions.prepareSettings?.(candidate.settings);
          signal.throwIfAborted();
          generation = candidate;
          activeNetwork = candidate.network;
          runtime.session = candidateSession;
          assignGeneration(runtime, candidate);
          observability = candidateObservability;
          ownsObservability ||= ownsCandidateObservability;
          if (observability === undefined) delete runtime.observability;
          else runtime.observability = observability;
          observability?.setLevel(candidateObservabilityLevel);
          previous.abortController.abort(new Error("Runtime resources refreshed"));
          committed = true;
          try {
            await closeAgentSessionForReplacement(previousSession, { preserveSessionStore: true });
          } catch (error) {
            warnings.push(`Old session cleanup failed: ${errorMessage(error)}`);
          }
          try {
            await refreshOptions.onCommit?.();
          } catch (error) {
            warnings.push(`Refreshed resources but UI refresh failed: ${errorMessage(error)}`);
          }
          try {
            await refreshOptions.beforeSessionStart?.(candidateSession);
          } catch (error) {
            warnings.push(`Refreshed resources but session bindings failed: ${errorMessage(error)}`);
          }
          if (!candidate.runtimeExtensions.lifecycleSignal().aborted) {
            extensionMode = candidate.runtimeExtensions.hostContext().mode;
          }
          try {
            await settleWithin(previous.close(), RUNTIME_GENERATION_CLOSE_TIMEOUT_MS, "Old runtime cleanup");
          } catch (error) {
            warnings.push(`Old runtime cleanup failed: ${errorMessage(error)}`);
          }
          await candidateSession.bindExtensions({ reason: "refresh" }, signal).catch((error: unknown) => {
            warnings.push(`Extension session restart failed: ${errorMessage(error)}`);
          });
        } catch (error) {
          if (!committed) {
            const recoveryFailures: unknown[] = [error];
            if (candidateSession !== undefined) {
              try {
                await closeAgentSessionForReplacement(candidateSession, { preserveSessionStore: true });
              } catch (candidateSessionCleanupError) {
                recoveryFailures.push(candidateSessionCleanupError);
              }
            }
            if (candidate !== undefined) {
              try {
                await candidate.close();
              } catch (candidateCleanupError) {
                recoveryFailures.push(candidateCleanupError);
              }
            }
            if (ownsCandidateObservability) {
              try {
                await candidateObservability?.close();
              } catch (candidateObservabilityCleanupError) {
                recoveryFailures.push(candidateObservabilityCleanupError);
              }
            }
            try {
              await restoreModelCatalogRollback(
                new FileModelCatalogStore(paths.modelCatalog),
                catalogRollback,
              );
            } catch (candidateRollbackError) {
              recoveryFailures.push(candidateRollbackError);
            }
            if (shutdownStarted) {
              try {
                await previousSession.bindExtensions({ reason: "refresh" });
              } catch (candidateRestartError) {
                recoveryFailures.push(candidateRestartError);
              }
            }
            if (recoveryFailures.length > 1) {
              throw new AggregateError(
                recoveryFailures,
                `${errorMessage(error)}; runtime refresh recovery failed`,
              );
            }
          }
          throw error;
        }
        return { warnings };
      })();
      refreshFlight = operation;
      refreshAbortController = operationAbortController;
      try {
        const result = await operation;
        observability?.event("runtime", "refresh_completed", {
          duration_ms: Math.max(0, Date.now() - refreshStartedAt),
          warnings: result.warnings.length,
        });
        return result;
      } catch (error) {
        observability?.event("runtime", "refresh_failed", {
          duration_ms: Math.max(0, Date.now() - refreshStartedAt),
        }, "error");
        throw error;
      } finally {
        if (refreshFlight === operation) refreshFlight = undefined;
        if (refreshAbortController === operationAbortController) refreshAbortController = undefined;
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const closeStartedAt = Date.now();
      observability?.event("runtime", "shutdown_started");
      const failures: unknown[] = [];
      const pendingRefresh = refreshFlight;
      if (pendingRefresh !== undefined) {
        refreshAbortController?.abort(new Error("Runtime closed while refresh was in progress"));
        try {
          await settleWithin(
            pendingRefresh.then(() => undefined, () => undefined),
            RUNTIME_REFRESH_CLOSE_WAIT_TIMEOUT_MS,
            "Runtime refresh shutdown",
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
      observability?.event("runtime", failures.length === 0 ? "shutdown_completed" : "shutdown_failed", {
        duration_ms: Math.max(0, Date.now() - closeStartedAt),
        failures: failures.length,
      }, failures.length === 0 ? "info" : "error");
      if (ownsObservability) {
        try { await observability?.close(); }
        catch (error) { failures.push(error); }
      }
      throwFailures(failures, "Runtime shutdown failed");
    },
  };
  function bindExtensionControls(target: RuntimeResourceGeneration, controlledSession: AgentSession): void {
    const host = target.runtimeExtensions;
    const commandContextActions: ExtensionCommandContextActions = {
      async waitForIdle(signal) {
        signal?.throwIfAborted();
        await runtime.session.waitForIdle();
        signal?.throwIfAborted();
      },
      async newSession(options = {}, signal) {
        signal?.throwIfAborted();
        if (!runtime.session.isIdle) return { cancelled: true };
        runtime.session.newSession({
          ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
        });
        await options.setup?.(extensionSessionManager(runtime.sessionManager));
        await options.withSession?.(runtime.session.createReplacedSessionContext());
        signal?.throwIfAborted();
        return { cancelled: false };
      },
      async fork(entryId, options = {}, signal) {
        signal?.throwIfAborted();
        if (!runtime.session.isIdle) return { cancelled: true };
        const target = options.position === "before"
          ? runtime.sessionManager.getEntries().find((entry) => entry.id === entryId)?.parentId ?? null
          : entryId;
        if (target === null) throw new Error("Cannot fork before the first session entry");
        const path = runtime.session.createBranchedSession(target);
        if (path === undefined) return { cancelled: true };
        runtime.session.switchSessionFile(path);
        await options.withSession?.(runtime.session.createReplacedSessionContext());
        signal?.throwIfAborted();
        return { cancelled: false };
      },
      async navigateTree(targetId, options = {}, signal) {
        signal?.throwIfAborted();
        if (!runtime.session.isIdle) return { cancelled: true };
        const result = await runtime.session.navigateTree(targetId, options);
        signal?.throwIfAborted();
        return { cancelled: result.cancelled };
      },
      async switchSession(sessionPath, options = {}, signal) {
        signal?.throwIfAborted();
        if (!runtime.session.isIdle) return { cancelled: true };
        runtime.session.switchSessionFile(sessionPath);
        await options.withSession?.(runtime.session.createReplacedSessionContext());
        signal?.throwIfAborted();
        return { cancelled: false };
      },
      async refresh(signal) {
        await runtime.refresh(signal === undefined ? {} : { signal });
      },
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
          const selected = runtime.session.nativeModel;
          const model = selected === undefined ? undefined : target.modelRegistry.find(selected.provider, selected.id);
          return model === undefined ? {} : { model };
        })(),
        scopedModels: runtime.session.nativeScopedModels.map((entry) => ({
          model: entry.model,
          ...(entry.thinkingLevel === undefined
            ? {}
            : { thinkingLevel: entry.thinkingLevel as ThinkingLevel }),
        })),
        thinkingLevel: runtime.session.thinkingLevel as ThinkingLevel,
        isIdle() { return runtime.session.isIdle; },
        hasPendingMessages() { return runtime.session.hasPendingMessages; },
        abort() { runtime.session.abort("Cancelled by extension"); },
        shutdown() {
          if (extensionShutdownHandler === undefined) void runtime.close();
          else void extensionShutdownHandler();
        },
        getContextUsage() { return runtime.session.getContextUsage(); },
        compact(options = {}) {
          void runtime.session.compact(options.customInstructions).then(
            (result) => options.onComplete?.({
              threadId: runtime.session.sessionId,
              branch: runtime.session.sessionManager.getLeafId() ?? "root",
              ...result,
            }),
            (error: unknown) => {
              const isError = (Error as ErrorConstructor & { isError?: (candidate: unknown) => boolean }).isError;
              options.onError?.(isError?.(error) === true
                ? error as Error
                : new Error(errorMessage(error), { cause: error }));
            },
          );
        },
        getSystemPrompt() { return runtime.session.systemPrompt; },
      };
    });
  }
  bindExtensionControls(generation, session);
  return runtime;
}
