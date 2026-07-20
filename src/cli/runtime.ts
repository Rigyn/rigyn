import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CredentialBroker,
  CrossProcessFileLock,
  EncryptedFileCredentialStore,
  EnvironmentCredentialSource,
  ExternalCommandCredentialSource,
  ExplicitCredentialSource,
  KeychainCredentialStore,
  ManagedProviderAuthDirectory,
  PlatformKeychainAdapter,
  probePlatformKeychain,
  ProfiledRefreshingStoredCredentialSource,
  ProviderAuthRegistry,
  providerDisplayName,
  resolveAwsDefaultCredentials,
  resolveAzureDefaultCredential,
  resolveGoogleApplicationDefaultCredentials,
  isWindowsDpapiEnvelope,
  protectWindowsCredentialKey,
  unprotectWindowsCredentialKey,
  assertCredentialId,
  type CredentialStore,
  type CredentialProfileMetadataStore,
  type AuthCredential,
  type ExternalCommandCredentialSpec,
  type ProviderAuthBinding,
  refreshAnthropicOAuth,
  refreshGenericOAuthWithFetch,
  refreshGitHubCopilotOAuth,
  authenticatedProviderFetch,
} from "../auth/index.js";
import type { OAuthRegistrationConfig } from "../auth/registry.js";
import { XAI_OAUTH_REGISTRATION, XAI_OAUTH_REGISTRATION_ID } from "../auth/xai.js";
import {
  assertCanonicalDirectoryCreationPath,
  canonicalExistingPath,
  parseHarnessConfig,
  resolveConfig,
  TrustStore,
  type HarnessConfig,
  type JsonObject,
} from "../config/index.js";
import type { ModelInfo, ModelProtocolFamily, ProviderAdapter } from "../core/types.js";
import { ProviderRegistry } from "../providers/registry.js";
import { ProviderWireInterceptorRegistry } from "../providers/wire.js";
import { signAwsRequest } from "../providers/bedrock.js";
import { FileModelCatalogStore } from "../providers/model-catalog-store.js";
import { configuredModelsWithMaintainedCatalog } from "../providers/maintained-model-catalog.js";
import {
  createProviderAdapter,
  HarnessService,
  runtimeProviderId,
  type HarnessResourceCatalogSources,
  type HarnessRuntimeResources,
  type RuntimeProviderConfig,
} from "../service/index.js";
import { SessionStore } from "../storage/store.js";
import { discoverSkills, type SkillMetadata, type SkillRoot } from "../context/skills.js";
import { sharedUserSkillRoots, sharedWorkspaceSkillRoots } from "../context/skill-roots.js";
import { bundledAuthoringResources } from "../prompts/resources.js";
import {
  discoverExtensions,
  ExtensionCatalog,
  filterExtensionResources,
  appendRuntimeExtensions,
  loadPromptTemplates,
  loadThemes,
  loadRuntimeExtensions,
  LocalExtensionPackageManager,
  ProjectPackageManager,
  RuntimeExtensionHost,
  mergeProjectPackageResourceFilters,
  projectPackageResourceFilters,
  type ExtensionPromptTemplate,
  type ExtensionRuntimeEntry,
  type ExtensionSource,
  type ExtensionTheme,
  type ProjectPackageCatalogEntry,
  type RuntimeDiscoveredResourcePath,
  type RuntimeDiscoveredResources,
  type RuntimeProviderAuthDescription,
  type RuntimeExtensionShutdownHandler,
} from "../extensions/index.js";
import { discoverRuntimeExtensionPaths, resolveExplicitRuntimeExtensions } from "../extensions/explicit-runtime.js";
import { expandPath, harnessPaths, type HarnessPaths } from "./paths.js";
import { createNetworkTransport, type NetworkTransport } from "../net/index.js";
import { WorkspaceBoundary } from "../tools/paths.js";
import { ExternalToolBackend, type ToolExecutionBackend } from "../tools/backend.js";
import { updateGlobalConfig } from "./setup.js";

export interface LoadedRuntime {
  paths: HarnessPaths;
  workspace: string;
  trusted: boolean;
  config: HarnessConfig;
  credentials: CredentialStore;
  broker: CredentialBroker;
  auth: ProviderAuthRegistry;
  providers: ProviderRegistry;
  network: NetworkTransport;
  store: SessionStore;
  service: HarnessService;
  extensions: ExtensionCatalog;
  runtimeExtensions: RuntimeExtensionHost;
  databasePath: string;
  generationSignal: AbortSignal;
  setExtensionShutdownHandler(handler: RuntimeExtensionShutdownHandler | undefined): void;
  reload(options?: RuntimeReloadOptions): Promise<RuntimeReloadResult>;
  close(): Promise<void>;
}

export interface RuntimeReloadOptions {
  session?: { threadId: string; branch?: string };
  signal?: AbortSignal;
  prepareExtensions?: (extensions: RuntimeExtensionHost) => void | Promise<void>;
  onCommit?: () => void | Promise<void>;
}

export interface RuntimeReloadResult {
  warnings: string[];
}

export interface LoadedAuthRuntime {
  paths: HarnessPaths;
  workspace: string;
  trusted: boolean;
  config: HarnessConfig;
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
  packagePaths?: readonly string[];
  allowPackageScripts?: boolean;
  extensionRuntime?: boolean;
  skills?: boolean;
  skillPaths?: readonly string[];
  promptTemplates?: boolean;
  promptTemplatePaths?: readonly string[];
  themes?: boolean;
  themePaths?: readonly string[];
  apiKey?: string;
  apiKeyProvider?: string;
  sessionDirectory?: string;
  recover?: boolean;
  managedExtensionLifecycle?: boolean;
  /** Already-active user and invocation extensions used for project trust. */
  preactivatedRuntimeExtensions?: RuntimeExtensionHost;
}

const EPHEMERAL_DATABASE_PATH = ":memory:";
const RUNTIME_RELOAD_TIMEOUT_MS = 60_000;
const RUNTIME_RELOAD_COMMIT_TIMEOUT_MS = 5_000;
const RUNTIME_PROVIDER_DISPOSAL_TIMEOUT_MS = 1_000;
const RUNTIME_GENERATION_CLOSE_TIMEOUT_MS = 25_000;
const RUNTIME_RELOAD_CLOSE_WAIT_TIMEOUT_MS = 40_000;

interface RuntimeResourceGeneration {
  trusted: boolean;
  config: HarnessConfig;
  auth: ProviderAuthRegistry;
  providers: ProviderRegistry;
  network: NetworkTransport;
  extensions: ExtensionCatalog;
  runtimeExtensions: RuntimeExtensionHost;
  databasePath: string;
  skills: SkillMetadata[];
  extraTools: HarnessRuntimeResources["extraTools"];
  toolBackend?: ToolExecutionBackend;
  installedPackages: NonNullable<HarnessResourceCatalogSources["packages"]>[number][];
  projectPackages: ProjectPackageCatalogEntry[];
  packageCatalogDiagnostics: string[];
  abortController: AbortController;
  close(): Promise<void>;
}

function credentialKey(value: string): Buffer {
  const decoded = /^[a-fA-F0-9]{64}$/u.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64url");
  if (decoded.length !== 32) throw new Error("RIGYN_CREDENTIAL_KEY must encode exactly 32 bytes");
  return decoded;
}

async function platformKeychainAvailable(environment: NodeJS.ProcessEnv): Promise<boolean> {
  const command = process.platform === "darwin"
    ? "/usr/bin/security"
    : process.platform === "linux"
      ? "/usr/bin/secret-tool"
      : undefined;
  if (command === undefined) return false;
  try {
    await access(command, constants.X_OK);
    return await probePlatformKeychain(new PlatformKeychainAdapter({ environment }));
  } catch {
    return false;
  }
}

async function readLocalCredentialKey(path: string, environment: NodeJS.ProcessEnv = process.env): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Credential key path is not a regular file");
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("Credential key permissions must be 0600");
    const serialized = (await handle.readFile("utf8")).trim();
    if (process.platform === "win32" && isWindowsDpapiEnvelope(serialized)) {
      return await unprotectWindowsCredentialKey(serialized, { environment });
    }
    return credentialKey(serialized);
  } finally {
    await handle.close();
  }
}

async function createLocalCredentialKey(paths: HarnessPaths, environment: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
  await mkdir(paths.configDirectory, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  const serialized = process.platform === "win32"
    ? await protectWindowsCredentialKey(key, { environment })
    : key.toString("base64url");
  try {
    const handle = await open(paths.credentialKey, "wx", 0o600);
    try {
      await handle.writeFile(`${serialized}\n`, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readLocalCredentialKey(paths.credentialKey, environment);
    if (existing === undefined) throw new Error("Credential key disappeared during creation");
    return existing;
  }
}

class LazyEncryptedFileCredentialStore implements CredentialProfileMetadataStore {
  readonly #paths: HarnessPaths;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #createLocalKey: boolean;
  readonly #lock: CrossProcessFileLock;
  readonly #lockContext = new AsyncLocalStorage<boolean>();
  #delegate: EncryptedFileCredentialStore | undefined;

  constructor(paths: HarnessPaths, environment: NodeJS.ProcessEnv, createLocalKey: boolean) {
    this.#paths = paths;
    this.#environment = environment;
    this.#createLocalKey = createLocalKey;
    this.#lock = new CrossProcessFileLock(`${paths.credentialStore}.lock`);
  }

  async read(id: string): Promise<AuthCredential | undefined> {
    assertCredentialId(id);
    return await (await this.#readable())?.read(id);
  }

  async write(id: string, credential: AuthCredential): Promise<void> {
    assertCredentialId(id);
    await this.withLock(id, async () => (await this.#writable()).write(id, credential));
  }

  async delete(id: string): Promise<void> {
    assertCredentialId(id);
    await this.withLock(id, async () => (await this.#readable())?.delete(id));
  }

  async readCredentialProfileIndex(id: string): Promise<unknown | undefined> {
    assertCredentialId(id);
    return await (await this.#readable())?.readCredentialProfileIndex(id);
  }

  async writeCredentialProfileIndex(id: string, value: unknown): Promise<void> {
    assertCredentialId(id);
    await this.withLock(id, async () => (await this.#writable()).writeCredentialProfileIndex(id, value));
  }

  async deleteCredentialProfileIndex(id: string): Promise<void> {
    assertCredentialId(id);
    await this.withLock(id, async () => (await this.#readable())?.deleteCredentialProfileIndex(id));
  }

  async withLock<T>(id: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    assertCredentialId(id);
    if (this.#lockContext.getStore() === true) return operation();
    return this.#lock.run(() => this.#lockContext.run(true, operation), signal);
  }

  async #readable(): Promise<EncryptedFileCredentialStore | undefined> {
    if (this.#delegate !== undefined) return this.#delegate;
    const key = await readLocalCredentialKey(this.#paths.credentialKey, this.#environment);
    if (key === undefined) return undefined;
    return this.#useKey(key);
  }

  #useKey(key: Uint8Array): EncryptedFileCredentialStore {
    this.#delegate ??= new EncryptedFileCredentialStore({
      path: this.#paths.credentialStore,
      key,
      lock: this.#lock,
      lockContext: this.#lockContext,
    });
    return this.#delegate;
  }

  async #writable(): Promise<EncryptedFileCredentialStore> {
    const existing = await this.#readable();
    if (existing !== undefined) return existing;
    if (!this.#createLocalKey) {
      throw new Error("No credential keychain is available; rerun interactive setup or set RIGYN_CREDENTIAL_KEY");
    }
    return this.#useKey(await createLocalCredentialKey(this.#paths, this.#environment));
  }
}

export async function createCredentialStore(
  paths: HarnessPaths,
  options: { createLocalKey?: boolean; environment?: NodeJS.ProcessEnv; allowPlatformKeychain?: boolean } = {},
): Promise<CredentialStore> {
  const environment = options.environment ?? process.env;
  const key = environment.RIGYN_CREDENTIAL_KEY;
  if (key !== undefined && key !== "") return new EncryptedFileCredentialStore({ path: paths.credentialStore, key: credentialKey(key) });
  const local = await readLocalCredentialKey(paths.credentialKey, environment);
  if (local !== undefined) return new EncryptedFileCredentialStore({ path: paths.credentialStore, key: local });
  if (options.allowPlatformKeychain !== false && await platformKeychainAvailable(environment)) {
    return new KeychainCredentialStore({ adapter: new PlatformKeychainAdapter({ environment }), service: "rigyn" });
  }
  if (options.createLocalKey === true) {
    return new LazyEncryptedFileCredentialStore(paths, environment, true);
  }
  return new LazyEncryptedFileCredentialStore(paths, environment, false);
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
  gemini: { kind: "gemini" },
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
    kind: "openai-compatible",
    id: "fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    credentialProvider: "fireworks",
  },
  huggingface: {
    kind: "openai-compatible",
    id: "huggingface",
    baseUrl: "https://router.huggingface.co/v1",
    credentialProvider: "huggingface",
  },
  "vercel-ai-gateway": {
    kind: "openai-compatible",
    id: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    credentialProvider: "vercel-ai-gateway",
    profile: "vercel-ai-gateway",
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
        "gpt-5.5", "gpt-5.5-pro", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
      ]),
      ...builtinRoutes("opencode", "chat-kimi", "openai-chat-completions", ["kimi-k2.6"]),
      ...builtinRoutes("opencode", "chat", "openai-chat-completions", [
        "big-pickle", "deepseek-v4-flash", "deepseek-v4-flash-free", "deepseek-v4-pro", "glm-5",
        "glm-5.1", "glm-5.2", "grok-4.5", "grok-build-0.1", "hy3-free", "kimi-k2.5",
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
      ...builtinRoutes("opencode-go", "chat-kimi", "openai-chat-completions", ["kimi-k2.6"]),
      ...builtinRoutes("opencode-go", "chat", "openai-chat-completions", [
        "deepseek-v4-flash", "deepseek-v4-pro", "glm-5.1", "glm-5.2", "grok-4.5",
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
  config: HarnessConfig,
  environment: NodeJS.ProcessEnv,
): Record<string, RuntimeProviderConfig> {
  const providerConfigs = { ...BUILTIN_PROVIDER_CONFIGS, ...config.providers };
  const llamaBaseUrl = environment.LLAMA_BASE_URL?.trim();
  if (config.providers["llama.cpp"] === undefined && llamaBaseUrl !== undefined && llamaBaseUrl !== "") {
    providerConfigs["llama.cpp"] = {
      kind: "llama-router",
      id: "llama.cpp",
      baseUrl: llamaBaseUrl,
    };
  }
  if (environment.AWS_REGION !== undefined || environment.AWS_DEFAULT_REGION !== undefined) {
    providerConfigs.bedrock ??= {
      kind: "bedrock",
      region: environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION ?? "",
    };
  }
  return providerConfigs;
}

function configuredCredentialCommands(
  config: HarnessConfig,
  environment: NodeJS.ProcessEnv,
): Record<string, ExternalCommandCredentialSpec> {
  return Object.fromEntries(Object.entries(config.credentialCommands).map(([provider, command]) => {
    const forwarded = Object.fromEntries((command.environment ?? []).flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }));
    return [provider, {
      argv: command.argv,
      ...(Object.keys(forwarded).length === 0 ? {} : { environment: forwarded }),
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      ...(command.maxOutputBytes === undefined ? {} : { maxOutputBytes: command.maxOutputBytes }),
      ...(command.cacheTtlMs === undefined ? {} : { cacheTtlMs: command.cacheTtlMs }),
    }];
  }));
}

function configuredOAuthRegistrations(
  bindings: readonly ProviderAuthBinding[],
  configured: Readonly<Record<string, OAuthRegistrationConfig>>,
): Record<string, OAuthRegistrationConfig> {
  const registrations = { ...configured };
  if (bindings.some((binding) => binding.providerId === "xai" && binding.credentialId === "xai")) {
    if (Object.hasOwn(registrations, XAI_OAUTH_REGISTRATION_ID)) {
      throw new Error(`OAuth registration ID is reserved: ${XAI_OAUTH_REGISTRATION_ID}`);
    }
    registrations[XAI_OAUTH_REGISTRATION_ID] = XAI_OAUTH_REGISTRATION;
  }
  return registrations;
}

export async function loadAuthRuntime(options: {
  workspace?: string;
  createLocalKey?: boolean;
  additionalCredentialIds?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  allowPlatformKeychain?: boolean;
} = {}): Promise<LoadedAuthRuntime> {
  const environment = options.environment ?? process.env;
  const paths = harnessPaths(environment);
  const workspace = await canonicalExistingPath(resolve(options.workspace ?? process.cwd()));
  const trust = new TrustStore(paths.trustStore);
  const trusted = await trust.isTrusted(workspace);
  const resolved = resolveConfig({
    globalPath: paths.globalConfig,
    projectPath: join(workspace, ".rigyn", "config.jsonc"),
    projectTrusted: trusted,
  });
  const config = parseHarnessConfig(resolved.value);
  const network = createNetworkTransport(config.httpTransport);
  const credentials = await createCredentialStore(paths, {
    ...(options.createLocalKey === undefined ? {} : { createLocalKey: options.createLocalKey }),
    environment,
    ...(options.allowPlatformKeychain === undefined ? {} : { allowPlatformKeychain: options.allowPlatformKeychain }),
  });
  const bindings = Object.entries(configuredProviderConfigs(config, environment)).map(([configuredName, providerConfig]) => {
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
  return {
    paths,
    workspace,
    trusted,
    config,
    credentials,
    auth: new ProviderAuthRegistry({
      bindings,
      registrations: configuredOAuthRegistrations(bindings, config.oauthRegistrations),
      store: credentials,
      environment,
    }),
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

function serviceResources(generation: RuntimeResourceGeneration): HarnessRuntimeResources {
  return {
    providers: generation.providers,
    providerAvailable: async (provider) => (await generation.auth.state(provider)).status === "connected",
    projectTrusted: generation.trusted,
    skills: generation.skills,
    extraTools: generation.extraTools,
    outboundImages: generation.config.outboundImages,
    runtimeExtensions: generation.runtimeExtensions,
    ...(generation.toolBackend === undefined ? {} : { toolBackend: generation.toolBackend }),
    ...(generation.config.shellPath === undefined ? {} : { shellPath: generation.config.shellPath }),
    ...(generation.config.shellCommandPrefix === undefined ? {} : { shellCommandPrefix: generation.config.shellCommandPrefix }),
    autoCompaction: generation.config.autoCompaction,
    compactionReserveTokens: generation.config.compaction.reserveTokens,
    compactionKeepRecentTokens: generation.config.compaction.keepRecentTokens,
    compactionRetainRecentTurns: generation.config.compactionRetainRecentTurns,
    compactionToolResultBytes: generation.config.compactionToolResultBytes,
    branchSummaryReserveTokens: generation.config.branchSummary.reserveTokens,
    imageAutoResize: generation.config.images.autoResize,
    ...(generation.config.thinkingBudgets === undefined ? {} : { thinkingBudgets: generation.config.thinkingBudgets }),
    retry: generation.config.providerRetry,
    childRuns: generation.config.childRuns,
    resourceCatalog: {
      extensions: generation.extensions,
      packages: generation.installedPackages,
      projectPackages: generation.projectPackages,
      packageDiagnostics: generation.packageCatalogDiagnostics,
    },
  };
}

async function canonicalRuntimeResourcePath(resource: RuntimeDiscoveredResourcePath): Promise<string> {
  if (!resource.trusted) throw new Error("Resource contribution is not trusted");
  const root = resolve(resource.resourceRoot);
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) {
    throw new Error("Resource package root contains a symbolic link");
  }
  const boundary = await WorkspaceBoundary.create(root);
  const target = boundary.lexical(resource.path);
  const local = relative(root, target);
  let current = root;
  for (const component of local === "" ? [] : local.split(sep)) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Resource path contains a symbolic link");
  }
  const canonical = await boundary.readable(target);
  const information = await lstat(canonical);
  if (!information.isFile() && !information.isDirectory()) throw new Error("Resource path is not a regular file or directory");
  return canonical;
}

async function resolveRuntimeResources(
  host: RuntimeExtensionHost,
  discovered: RuntimeDiscoveredResources,
  signal?: AbortSignal,
): Promise<RuntimeDiscoveredResources> {
  const resolvePaths = async (values: readonly RuntimeDiscoveredResourcePath[]): Promise<RuntimeDiscoveredResourcePath[]> => {
    const paths: RuntimeDiscoveredResourcePath[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      signal?.throwIfAborted();
      try {
        const path = await canonicalRuntimeResourcePath(value);
        if (seen.has(path)) continue;
        seen.add(path);
        paths.push({ ...value, path });
      } catch (error) {
        host.addDiagnostic({
          extensionId: value.extensionId,
          sourcePath: value.sourcePath,
          message: `Runtime resource path was ignored: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return paths;
  };
  return {
    skillPaths: await resolvePaths(discovered.skillPaths),
    promptPaths: await resolvePaths(discovered.promptPaths),
    themePaths: await resolvePaths(discovered.themePaths),
  };
}

async function loadRuntimePrompts(
  host: RuntimeExtensionHost,
  resources: readonly RuntimeDiscoveredResourcePath[],
): Promise<ExtensionPromptTemplate[]> {
  const prompts: ExtensionPromptTemplate[] = [];
  for (const resource of resources) {
    try {
      prompts.push(...(await loadPromptTemplates([resource.path])).map((prompt) => ({
        ...prompt,
        extensionId: resource.extensionId,
      })));
    } catch (error) {
      host.addDiagnostic({
        extensionId: resource.extensionId,
        sourcePath: resource.sourcePath,
        message: `Runtime prompt resource was ignored: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return prompts;
}

async function loadRuntimeThemes(
  host: RuntimeExtensionHost,
  resources: readonly RuntimeDiscoveredResourcePath[],
): Promise<ExtensionTheme[]> {
  const themes: ExtensionTheme[] = [];
  for (const resource of resources) {
    try {
      themes.push(...(await loadThemes([resource.path])).map((theme) => ({
        ...theme,
        extensionId: resource.extensionId,
      })));
    } catch (error) {
      host.addDiagnostic({
        extensionId: resource.extensionId,
        sourcePath: resource.sourcePath,
        message: `Runtime theme resource was ignored: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return themes;
}

/**
 * Activates only launch-authorized extensions before project trust is known.
 * Project configuration, packages, extensions, prompts, skills, and themes are
 * intentionally not inspected here.
 */
export async function preactivateProjectTrustExtensions(
  paths: Pick<HarnessPaths, "userExtensions" | "stateDirectory">,
  workspaceValue: string,
  options: Pick<RuntimeOptions, "extensions" | "extensionPaths" | "extensionRuntime">,
  signal?: AbortSignal,
): Promise<RuntimeExtensionHost | undefined> {
  if (options.extensionRuntime !== true) return undefined;
  const workspace = await canonicalExistingPath(resolve(workspaceValue));
  const entries: ExtensionRuntimeEntry[] = [];
  if (options.extensions === true) {
    const source = { path: paths.userExtensions, scope: "user" as const, trusted: true, optional: true };
    const catalog = await discoverExtensions([source]);
    entries.push(...catalog.bundle().runtime);
    entries.push(...await resolveExplicitRuntimeExtensions(
      await discoverRuntimeExtensionPaths(paths.userExtensions),
      workspace,
      { maximum: 128, scope: "user", trusted: true },
    ));
  }
  entries.push(...await resolveExplicitRuntimeExtensions(
    options.extensionPaths ?? [],
    workspace,
    { scope: "invocation", trusted: true },
  ));
  const unique: ExtensionRuntimeEntry[] = [];
  const sourcePaths = new Set<string>();
  for (const entry of entries) {
    if (sourcePaths.has(entry.sourcePath)) continue;
    sourcePaths.add(entry.sourcePath);
    unique.push(entry);
  }
  if (unique.length > 128) throw new Error("At most 128 pre-trust runtime extensions may be loaded");
  return await loadRuntimeExtensions(unique, {
    workspace,
    dataRoot: join(paths.stateDirectory, "extension-data"),
    ...(signal === undefined ? {} : { signal }),
  });
}

async function loadResourceGeneration(
  paths: HarnessPaths,
  workspace: string,
  broker: CredentialBroker,
  credentials: CredentialStore,
  managedAuth: ManagedProviderAuthDirectory,
  options: Pick<RuntimeOptions, "projectTrusted" | "ephemeral" | "extensions" | "extensionPaths" | "packagePaths" | "allowPackageScripts" | "extensionRuntime" | "skills" | "skillPaths" | "promptTemplates" | "promptTemplatePaths" | "themes" | "themePaths" | "sessionDirectory">,
  reason: "startup" | "reload" = "startup",
  signal?: AbortSignal,
  preactivatedRuntimeExtensions?: RuntimeExtensionHost,
): Promise<RuntimeResourceGeneration> {
  signal?.throwIfAborted();
  const trust = new TrustStore(paths.trustStore);
  const trusted = options.projectTrusted ?? await trust.isTrusted(workspace);
  const resolved = resolveConfig({
    globalPath: paths.globalConfig,
    projectPath: join(workspace, ".rigyn", "config.jsonc"),
    projectTrusted: trusted,
  });
  const config = parseHarnessConfig(resolved.value);
  const toolBackend = config.executionBackend === undefined
    ? undefined
    : await ExternalToolBackend.create(config.executionBackend);
  const installedPackages: NonNullable<HarnessResourceCatalogSources["packages"]>[number][] = [];
  let projectPackages: ProjectPackageCatalogEntry[] = [];
  const packageCatalogDiagnostics: string[] = [];
  if (options.extensions === true) {
    const packageManager = new LocalExtensionPackageManager({
      user: paths.userExtensions,
      ...(trusted ? { project: join(workspace, ".rigyn", "extensions") } : {}),
    }, {}, {}, { operationLeaseRoot: join(paths.stateDirectory, "package-leases") });
    for (const scope of trusted ? ["user", "project"] as const : ["user"] as const) {
      try {
        installedPackages.push(...await packageManager.list(
          scope,
          signal === undefined ? {} : { signal },
        ));
      } catch (error) {
        signal?.throwIfAborted();
        packageCatalogDiagnostics.push(
          `${scope} package provenance could not be catalogued: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (trusted) {
      const projectManager = new ProjectPackageManager({
        workspace,
        projectTrusted: true,
        operationLeaseRoot: join(paths.stateDirectory, "package-leases"),
        commands: {
          ...(config.npmCommand === undefined ? {} : { npm: { command: config.npmCommand[0]!, prefix: config.npmCommand.slice(1) } }),
          ...(config.gitCommand === undefined ? {} : { git: { command: config.gitCommand[0]!, prefix: config.gitCommand.slice(1) } }),
        },
      });
      const reconciled = await projectManager.reconcile(signal);
      installedPackages.push(...reconciled.packages);
      projectPackages = reconciled.catalog;
    }
  }
  let invocationPackageRoot: string | undefined;
  let invocationPackagesHandedOff = false;
  try {
  const authoringResources = bundledAuthoringResources();
  const network = createNetworkTransport(config.httpTransport);
  const providers = new ProviderRegistry([], { catalogStore: new FileModelCatalogStore(paths.modelCatalog) });
  const providerWire = new ProviderWireInterceptorRegistry();
  registerCloudflareWireInterceptors(providerWire, broker, process.env);
  const authBindings: ProviderAuthBinding[] = [];
  const providerConfigs = configuredProviderConfigs(config, process.env);
  for (const [configuredName, providerConfig] of Object.entries(providerConfigs)) {
    const adapter = createProviderAdapter(providerConfig, broker, {
      fetch: network.fetch,
      ...(network.openWebSocket === undefined ? {} : { webSocket: network.openWebSocket }),
      wire: providerWire,
    });
    providers.register(adapter);
    authBindings.push(runtimeProviderAuthBinding(configuredName, providerConfig, adapter.id));
  }
  const databasePath = options.ephemeral === true
    ? EPHEMERAL_DATABASE_PATH
    : options.sessionDirectory === undefined
      ? expandPath(config.databasePath ?? paths.database, workspace)
      : join(expandPath(options.sessionDirectory, workspace), "sessions.sqlite");
  const packagePaths = options.packagePaths ?? [];
  if (packagePaths.length > 16) throw new Error("At most 16 invocation-only packages may be loaded");
  if (packagePaths.length > 0) {
    invocationPackageRoot = await mkdtemp(join(tmpdir(), "rigyn-run-packages-"));
    const manager = new LocalExtensionPackageManager({ user: invocationPackageRoot }, {}, {
      ...(config.npmCommand === undefined ? {} : { npm: { command: config.npmCommand[0]!, prefix: config.npmCommand.slice(1) } }),
      ...(config.gitCommand === undefined ? {} : { git: { command: config.gitCommand[0]!, prefix: config.gitCommand.slice(1) } }),
    }, { operationLeaseRoot: join(invocationPackageRoot, ".leases") });
    for (const source of packagePaths) {
      const selected = !isAbsolute(source) && !/^(?:npm|git|https|ssh):/u.test(source)
        ? resolve(workspace, source)
        : source;
      const installed = await manager.install(selected, "user", {
        allowScripts: options.allowPackageScripts === true,
        ...(signal === undefined ? {} : { signal }),
      });
      installedPackages.push({ ...installed, scope: "invocation" });
    }
  }
  const extensionSources: ExtensionSource[] = options.extensions === true
      ? [
        { path: paths.userExtensions, scope: "user", trusted: true, optional: true },
        ...(trusted ? [{
          path: join(workspace, ".rigyn", "extensions"),
          scope: "project" as const,
          trusted: true,
          optional: true,
        }, {
          path: join(workspace, ".rigyn", "packages"),
          scope: "project" as const,
          trusted: true,
          optional: true,
        }] : []),
        ...(trusted
          ? config.extensionRoots.map((path) => ({
              path: expandPath(path, workspace),
              scope: "project" as const,
              trusted: true,
            }))
          : []),
      ]
    : [];
  if (invocationPackageRoot !== undefined) {
    extensionSources.push({ path: invocationPackageRoot, scope: "invocation", trusted: true });
  }
  let extensions = await discoverExtensions(extensionSources);
  extensions = filterExtensionResources(extensions, mergeProjectPackageResourceFilters(
    config.packageResources,
    projectPackageResourceFilters(projectPackages),
  ));
  let extensionBundle = extensions.bundle();
  const automaticRuntimeSources = options.extensionRuntime === true && options.extensions === true
    ? [
        { path: paths.userExtensions, scope: "user" as const, trusted: true },
        ...(trusted
          ? [
              { path: join(workspace, ".rigyn", "extensions"), scope: "project" as const, trusted: true },
              { path: join(workspace, ".rigyn", "packages"), scope: "project" as const, trusted: true },
              ...config.extensionRoots.map((path) => ({
                path: expandPath(path, workspace), scope: "project" as const, trusted: true,
              })),
            ]
          : []),
      ]
    : [];
  const automaticRuntimeEntries = (
    await Promise.all(automaticRuntimeSources.map(async (source) =>
      await resolveExplicitRuntimeExtensions(
        await discoverRuntimeExtensionPaths(source.path),
        workspace,
        { maximum: 128, scope: source.scope, trusted: source.trusted },
      )))
  ).flat();
  if (automaticRuntimeEntries.length > 128) throw new Error("At most 128 automatically discovered runtime extensions may be loaded");
  const explicitRuntimeEntries = options.extensionRuntime === true
    ? await resolveExplicitRuntimeExtensions(options.extensionPaths ?? [], workspace, { scope: "invocation", trusted: true })
    : [];
  const runtimeEntries = [...extensionBundle.runtime];
  const runtimeSourcePaths = new Set(runtimeEntries.map((entry) => entry.sourcePath));
  for (const entry of [...automaticRuntimeEntries, ...explicitRuntimeEntries]) {
    if (runtimeSourcePaths.has(entry.sourcePath)) continue;
    runtimeSourcePaths.add(entry.sourcePath);
    runtimeEntries.push(entry);
  }
  let runtimeExtensions: RuntimeExtensionHost;
  if (options.extensionRuntime === true) {
    if (preactivatedRuntimeExtensions === undefined) {
      runtimeExtensions = await loadRuntimeExtensions(runtimeEntries, {
        workspace,
        dataRoot: join(paths.stateDirectory, "extension-data"),
        projectTrusted: trusted,
        ...(signal === undefined ? {} : { signal }),
        ...(reason === "reload" ? { activationFailure: "throw" as const } : {}),
      });
    } else {
      runtimeExtensions = preactivatedRuntimeExtensions;
      runtimeExtensions.setHostContext({ projectTrusted: trusted });
      const activePaths = new Set(runtimeExtensions.extensions().map((entry) => entry.sourcePath));
      const additional = runtimeEntries.filter((entry) => !activePaths.has(entry.sourcePath));
      await appendRuntimeExtensions(runtimeExtensions, additional, {
        workspace,
        dataRoot: join(paths.stateDirectory, "extension-data"),
        ...(signal === undefined ? {} : { signal }),
        ...(reason === "reload" ? { activationFailure: "throw" as const } : {}),
      });
    }
  } else {
    if (preactivatedRuntimeExtensions !== undefined) {
      throw new Error("Preactivated extensions require extensionRuntime");
    }
    runtimeExtensions = new RuntimeExtensionHost(workspace, {
      dataRoot: join(paths.stateDirectory, "extension-data"),
      projectTrusted: trusted,
    });
  }
  const integratedRuntimeProviders: ProviderAdapter[] = [];
  for (const provider of runtimeExtensions.providers()) {
    if (providers.has(provider.id)) {
      runtimeExtensions.addDiagnostic({
        extensionId: "runtime",
        sourcePath: "",
        message: `Provider ${provider.id} conflicts with an existing provider and was ignored`,
      });
    } else {
      providers.register(provider);
      integratedRuntimeProviders.push(provider);
      authBindings.push({
        providerId: provider.id,
        credentialId: provider.id,
        displayName: providerDisplayName(provider.id),
        externallyManaged: true,
      });
    }
  }
  const auth = new ProviderAuthRegistry({
    bindings: authBindings,
    registrations: configuredOAuthRegistrations(authBindings, config.oauthRegistrations),
    store: credentials,
  });
  const integratedRuntimeProviderAuthCleanups = new Map<string, () => void>();
  const registerProviderAuth = (description: RuntimeProviderAuthDescription): (() => void) => {
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
  for (const provider of integratedRuntimeProviders) {
    runtimeExtensions.addRegistrationCleanup(() => {
      if (auth.has(provider.id)) auth.unregister(provider.id);
      providers.unregister(provider.id, provider, { preservePersistedCatalog: true });
    });
  }
  for (const description of runtimeExtensions.providerAuth()) {
    if (!providers.has(description.descriptor.provider)) {
      runtimeExtensions.addDiagnostic({
        extensionId: description.extensionId,
        sourcePath: description.sourcePath,
        message: `Provider auth descriptor ${description.descriptor.provider} has no registered provider and was ignored`,
      });
      continue;
    }
    try {
      const cleanup = registerProviderAuth(description);
      integratedRuntimeProviderAuthCleanups.set(description.descriptor.provider, cleanup);
      runtimeExtensions.addRegistrationCleanup(() => {
        if (integratedRuntimeProviderAuthCleanups.get(description.descriptor.provider) !== cleanup) return;
        integratedRuntimeProviderAuthCleanups.delete(description.descriptor.provider);
        cleanup();
      });
    } catch (error) {
      runtimeExtensions.addDiagnostic({
        extensionId: description.extensionId,
        sourcePath: description.sourcePath,
        message: `Provider auth descriptor ${description.descriptor.provider} was ignored: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const extraTools = runtimeExtensions.tools();
  runtimeExtensions.setLiveRegistrationHandler({
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
    registerProvider(provider) {
      if (providers.has(provider.id)) {
        throw new Error(`Provider ${provider.id} conflicts with an existing provider`);
      }
      providers.register(provider);
      let registeredFallbackAuth = false;
      try {
        if (!auth.has(provider.id)) {
          auth.register({
            providerId: provider.id,
            credentialId: provider.id,
            displayName: providerDisplayName(provider.id),
            externallyManaged: true,
          });
          registeredFallbackAuth = true;
        }
      } catch (error) {
        providers.unregister(provider.id, provider);
        throw error;
      }
      return () => {
        if (registeredFallbackAuth) auth.unregister(provider.id);
        providers.unregister(provider.id, provider, { preservePersistedCatalog: true });
      };
    },
    overrideProvider(provider) {
      return providers.override(provider);
    },
    overlayProvider(overlay) {
      if (!providers.has(overlay.id)) throw new Error(`Provider adapter is not registered: ${overlay.id}`);
      const cleanups: Array<() => void> = [];
      try {
        if (overlay.stream !== undefined || overlay.listModels !== undefined || overlay.models !== undefined) {
          const staticModels: ModelInfo[] | undefined = overlay.models === undefined
            ? undefined
            : structuredClone([...overlay.models]);
          cleanups.push(providers.overlay({
            id: overlay.id,
            ...(overlay.stream === undefined ? {} : { stream: overlay.stream }),
            ...(overlay.listModels === undefined && staticModels === undefined
              ? {}
              : {
                  listModels: overlay.listModels ?? (async (signal) => {
                    signal.throwIfAborted();
                    return structuredClone(staticModels!);
                  }),
                }),
          }));
        }
        if (overlay.displayName !== undefined) {
          cleanups.push(auth.overrideDisplayName(overlay.id, overlay.displayName));
        }
        if (overlay.baseUrl !== undefined || overlay.headers !== undefined) {
          cleanups.push(providerWire.register(overlay.id, {
            interceptRequest() {
              return {
                ...(overlay.baseUrl === undefined ? {} : { baseUrl: overlay.baseUrl }),
                ...(overlay.headers === undefined ? {} : { headers: overlay.headers }),
              };
            },
          }));
        }
      } catch (error) {
        for (const cleanup of cleanups.reverse()) cleanup();
        throw error;
      }
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        for (const cleanup of cleanups.reverse()) cleanup();
      };
    },
    registerProviderWire(provider, interceptor) {
      return providerWire.register(provider, interceptor);
    },
    unregisterProvider(provider) {
      integratedRuntimeProviderAuthCleanups.get(provider.id)?.();
      integratedRuntimeProviderAuthCleanups.delete(provider.id);
      if (auth.has(provider.id)) auth.unregister(provider.id);
      providers.unregister(provider.id, provider, { preservePersistedCatalog: true });
    },
    registerProviderAuth(description: RuntimeProviderAuthDescription) {
      if (!providers.has(description.descriptor.provider)) {
        throw new Error(`Provider auth descriptor has no registered provider: ${description.descriptor.provider}`);
      }
      return registerProviderAuth(description);
    },
    async fetchProvider(provider, input, init, signal) {
      const policy = auth.descriptor(provider)?.request;
      if (policy === undefined) throw new Error(`Provider authentication has no request policy: ${provider}`);
      return authenticatedProviderFetch(policy, async (request) => {
        const binding = auth.binding(provider);
        const resolved = await broker.resolve({
          provider: binding.credentialId,
          ...(signal === undefined ? {} : { signal }),
        });
        if (resolved?.credential.kind === "api_key") {
          if (policy.apiKey === undefined) throw new Error(`Provider request policy does not accept API-key credentials: ${provider}`);
          const headers = new Headers(request.headers);
          headers.set(policy.apiKey.header, `${policy.apiKey.prefix ?? ""}${resolved.credential.apiKey}`);
          return new Request(request, { headers });
        }
        if (resolved?.credential.kind === "bearer" || resolved?.credential.kind === "oauth") {
          const projected = resolved.credential.kind === "oauth"
            ? managedAuth.apiKey(provider, resolved.credential)
            : undefined;
          if (policy.bearer === undefined && (projected === undefined || policy.apiKey === undefined)) {
            throw new Error(`Provider request policy does not accept bearer credentials: ${provider}`);
          }
          const headers = new Headers(request.headers);
          if (policy.bearer !== undefined) {
            headers.set(
              policy.bearer.header,
              `${policy.bearer.prefix ?? "Bearer "}${projected ?? resolved.credential.accessToken}`,
            );
          } else {
            headers.set(policy.apiKey!.header, `${policy.apiKey!.prefix ?? ""}${projected}`);
          }
          return new Request(request, { headers });
        }
        if (binding.ambient === "aws") {
          if (policy.awsSigV4 === undefined) throw new Error(`Provider request policy does not accept AWS credentials: ${provider}`);
          const credential = await resolveAwsDefaultCredentials({
            fetch: network.fetch,
            ...(signal === undefined ? {} : { signal }),
          });
          if (credential === undefined) throw new Error(`Provider credentials are unavailable: ${provider}`);
          return signAwsRequest(request, credential, policy.awsSigV4);
        }
        if (binding.ambient === "google" || binding.ambient === "azure") {
          if (policy.bearer === undefined) throw new Error(`Provider request policy does not accept ambient bearer credentials: ${provider}`);
          const credential = binding.ambient === "google"
            ? await resolveGoogleApplicationDefaultCredentials({ fetch: network.fetch, ...(signal === undefined ? {} : { signal }) })
            : await resolveAzureDefaultCredential({ fetch: network.fetch, ...(signal === undefined ? {} : { signal }) });
          if (credential === undefined) throw new Error(`Provider credentials are unavailable: ${provider}`);
          const headers = new Headers(request.headers);
          headers.set(policy.bearer.header, `${policy.bearer.prefix ?? "Bearer "}${credential.accessToken}`);
          return new Request(request, { headers });
        }
        throw new Error(`Provider credentials are unavailable: ${provider}`);
      }, network.fetch, input, init, signal);
    },
  });
  const abortController = new AbortController();
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const providerAdapters = [...new Set([...providers.list(), ...runtimeExtensions.providers()])];
    abortController.abort(new Error("Runtime resource generation closed"));
    const failures: unknown[] = [];
    try {
      await runtimeExtensions.close();
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
    if (invocationPackageRoot !== undefined) {
      try {
        await rm(invocationPackageRoot, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    throwFailures(failures, "Runtime resource cleanup failed");
  };
  try {
    signal?.throwIfAborted();
    providers.configureModels(configuredModelsWithMaintainedCatalog(config.models));
    const discoveredRuntimeResources = await resolveRuntimeResources(
      runtimeExtensions,
      await runtimeExtensions.discoverResources(reason, signal),
      signal,
    );
    signal?.throwIfAborted();
    const runtimePrompts = options.promptTemplates === false
      ? []
      : await loadRuntimePrompts(runtimeExtensions, discoveredRuntimeResources.promptPaths);
    const runtimeThemes = options.themes === false
      ? []
      : await loadRuntimeThemes(runtimeExtensions, discoveredRuntimeResources.themePaths);
    const loosePrompts = await loadPromptTemplates([
      ...(options.promptTemplates === false ? [] : [authoringResources.promptRoot]),
      ...(options.promptTemplates === false ? [] : [paths.userPrompts]),
      ...(options.promptTemplates === false || !trusted ? [] : [join(workspace, ".rigyn", "prompts")]),
      ...(options.promptTemplates === false ? [] : config.promptRoots.map((path) => expandPath(path, workspace))),
      ...(options.promptTemplatePaths ?? []).map((path) => expandPath(path, workspace)),
    ]);
    const looseThemes = await loadThemes([
      ...(options.themes === false ? [] : [paths.userThemes]),
      ...(options.themes === false || !trusted ? [] : [join(workspace, ".rigyn", "themes")]),
      ...(options.themes === false ? [] : config.themeRoots.map((path) => expandPath(path, workspace))),
      ...(options.themePaths ?? []).map((path) => expandPath(path, workspace)),
    ]);
    const prompts = new Map(extensionBundle.prompts.map((prompt) => [prompt.id, prompt]));
    const themes = new Map(extensionBundle.themes.map((theme) => [theme.name, theme]));
    for (const prompt of runtimePrompts) prompts.set(prompt.id, prompt);
    for (const theme of runtimeThemes) themes.set(theme.name, theme);
    for (const prompt of loosePrompts) prompts.set(prompt.id, prompt);
    for (const theme of looseThemes) themes.set(theme.name, theme);
    extensions = new ExtensionCatalog(extensions.list(), extensions.doctor().diagnostics, {
      ...extensionBundle,
      prompts: [...prompts.values()].sort((left, right) => left.id.localeCompare(right.id)),
      themes: [...themes.values()].sort((left, right) => left.name.localeCompare(right.name)),
    });
    extensionBundle = extensions.bundle();
    const skillRoots: SkillRoot[] = [
      ...(options.skills === false ? [] : [
        { path: authoringResources.skillRoot, scope: "user" as const, trusted: true },
        { path: paths.userSkills, scope: "user" as const, trusted: true },
        ...sharedUserSkillRoots(homedir()),
        ...extensionBundle.skillRoots,
        ...discoveredRuntimeResources.skillPaths.map((resource): SkillRoot => ({
          path: resource.path,
          scope: resource.scope === "project" || resource.scope === "invocation" ? "workspace" : "user",
          trusted: resource.trusted,
          extensionId: resource.extensionId,
        })),
      ]),
      ...(options.skills === false || !trusted
        ? []
        : [
            { path: join(workspace, ".rigyn", "skills"), scope: "workspace" as const, trusted: true },
            ...sharedWorkspaceSkillRoots(workspace, trusted),
          ]),
      ...(options.skills === false ? [] : config.skillRoots.map((path) => ({ path: expandPath(path, workspace), scope: "workspace" as const, trusted }))),
      ...(options.skillPaths ?? []).map((path) => ({ path: expandPath(path, workspace), scope: "workspace" as const, trusted: true })),
    ];
    signal?.throwIfAborted();
    const skills = await discoverSkills(skillRoots);
    signal?.throwIfAborted();
    invocationPackagesHandedOff = true;
    return {
      trusted,
      config,
      auth,
      providers,
      network,
      extensions,
      runtimeExtensions,
      databasePath,
      skills,
      extraTools,
      ...(toolBackend === undefined ? {} : { toolBackend }),
      installedPackages,
      projectPackages,
      packageCatalogDiagnostics,
      abortController,
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
  } finally {
    if (!invocationPackagesHandedOff && invocationPackageRoot !== undefined) {
      await rm(invocationPackageRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function assignGeneration(runtime: LoadedRuntime, generation: RuntimeResourceGeneration): void {
  runtime.trusted = generation.trusted;
  runtime.config = generation.config;
  runtime.auth = generation.auth;
  runtime.providers = generation.providers;
  runtime.network = generation.network;
  runtime.extensions = generation.extensions;
  runtime.runtimeExtensions = generation.runtimeExtensions;
  runtime.databasePath = generation.databasePath;
  runtime.generationSignal = generation.abortController.signal;
}

export async function loadRuntime(options: RuntimeOptions = {}): Promise<LoadedRuntime> {
  const paths = harnessPaths();
  const workspace = await canonicalExistingPath(resolve(options.workspace ?? process.cwd()));
  const credentials = await createCredentialStore(paths, { createLocalKey: true });
  let activeNetwork: NetworkTransport | undefined;
  const explicitCredentials = new Map<string, AuthCredential>();
  if (options.apiKey !== undefined) {
    const provider = options.apiKeyProvider ?? "openai";
    explicitCredentials.set(provider, { kind: "api_key", provider, apiKey: options.apiKey });
  }
  const externalCommandCredentials = new ExternalCommandCredentialSource({});
  const managedAuth = new ManagedProviderAuthDirectory();
  const broker = new CredentialBroker([
    ...(explicitCredentials.size === 0 ? [] : [new ExplicitCredentialSource(explicitCredentials)]),
    new ProfiledRefreshingStoredCredentialSource(credentials, {
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
    externalCommandCredentials,
    new EnvironmentCredentialSource(),
  ]);
  let generation: RuntimeResourceGeneration;
  try {
    generation = await loadResourceGeneration(
      paths,
      workspace,
      broker,
      credentials,
      managedAuth,
      options,
      "startup",
      undefined,
      options.preactivatedRuntimeExtensions,
    );
  } catch (error) {
    await options.preactivatedRuntimeExtensions?.close().catch(() => undefined);
    throw error;
  }
  externalCommandCredentials.replaceSpecs(configuredCredentialCommands(generation.config, process.env));
  activeNetwork = generation.network;
  let store: SessionStore | undefined;
  let service: HarnessService | undefined;
  try {
    if (generation.databasePath !== EPHEMERAL_DATABASE_PATH) {
      await assertCanonicalDirectoryCreationPath(dirname(generation.databasePath));
      await mkdir(dirname(generation.databasePath), { recursive: true, mode: 0o700 });
    }
    store = new SessionStore(generation.databasePath);
    service = new HarnessService({
      store,
      workspace,
      ...serviceResources(generation),
      userInstructionFile: join(paths.configDirectory, "AGENTS.md"),
      userPromptDirectory: paths.configDirectory,
      managedExtensionLifecycle: options.managedExtensionLifecycle ?? false,
    });
    await service.initialize({
      ...(options.recover === undefined ? {} : { recover: options.recover }),
      skills: generation.skills,
    });
  } catch (error) {
    store?.close();
    try {
      await generation.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Runtime initialization and cleanup failed");
    }
    throw error;
  }

  const stableStore = store;
  const stableService = service;
  let closed = false;
  let reloadFlight: Promise<RuntimeReloadResult> | undefined;
  let reloadAbortController: AbortController | undefined;
  let extensionShutdownHandler: RuntimeExtensionShutdownHandler | undefined;
  const runtime: LoadedRuntime = {
    paths,
    workspace,
    trusted: generation.trusted,
    config: generation.config,
    credentials,
    broker,
    auth: generation.auth,
    providers: generation.providers,
    network: generation.network,
    store: stableStore,
    service: stableService,
    extensions: generation.extensions,
    runtimeExtensions: generation.runtimeExtensions,
    databasePath: generation.databasePath,
    generationSignal: generation.abortController.signal,
    setExtensionShutdownHandler(handler): void {
      if (closed) throw new Error("Runtime is closed");
      extensionShutdownHandler = handler;
      generation.runtimeExtensions.setShutdownHandler(handler);
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
        const candidate = await loadResourceGeneration(paths, workspace, broker, credentials, managedAuth, options, "reload", signal);
        bindExtensionControls(candidate.runtimeExtensions);
        try {
          await reloadOptions.prepareExtensions?.(candidate.runtimeExtensions);
        } catch (error) {
          await candidate.close().catch(() => undefined);
          throw error;
        }
        signal.throwIfAborted();
        if (candidate.databasePath !== generation.databasePath) {
          await candidate.close().catch(() => undefined);
          throw new Error("databasePath cannot change during /reload; restart chat to use the new session database");
        }
        const previous = generation;
        const warnings: string[] = [];
        let oldSessionEnded = false;
        let committed = false;
        let previousClosed = false;
        if (reloadOptions.session !== undefined) {
          try {
            await previous.runtimeExtensions.dispatch("session_end", {
              ...reloadOptions.session,
              workspace,
              reason: "reload",
            }, signal);
          } catch (error) {
            warnings.push(`Extension session shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          oldSessionEnded = true;
        }
        try {
          await stableService.replaceRuntimeResources(serviceResources(candidate), {
            signal,
            commit: async () => {
              externalCommandCredentials.replaceSpecs(configuredCredentialCommands(candidate.config, process.env));
              generation = candidate;
              activeNetwork = candidate.network;
              assignGeneration(runtime, candidate);
              previous.abortController.abort(new Error("Runtime resources reloaded"));
              committed = true;
              try {
                if (reloadOptions.onCommit !== undefined) {
                  await settleWithin(
                    Promise.resolve().then(async () => await reloadOptions.onCommit!()),
                    RUNTIME_RELOAD_COMMIT_TIMEOUT_MS,
                    "Runtime reload commit callback",
                  );
                }
              } catch (error) {
                warnings.push(`Reloaded resources but UI refresh failed: ${error instanceof Error ? error.message : String(error)}`);
              }
              try {
                await settleWithin(
                  previous.close(),
                  RUNTIME_GENERATION_CLOSE_TIMEOUT_MS,
                  "Old runtime cleanup",
                );
              } catch (error) {
                warnings.push(`Old runtime cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
              }
              previousClosed = true;
              if (reloadOptions.session !== undefined) {
                try {
                  await candidate.runtimeExtensions.dispatch("session_start", {
                    ...reloadOptions.session,
                    workspace,
                    reason: "reload",
                  });
                } catch (error) {
                  warnings.push(`Extension session restart failed: ${error instanceof Error ? error.message : String(error)}`);
                }
              }
            },
          });
        } catch (error) {
          if (!committed && oldSessionEnded && reloadOptions.session !== undefined) {
            await previous.runtimeExtensions.dispatch("session_start", {
              ...reloadOptions.session,
              workspace,
              reason: "reload_rollback",
            }).catch(() => undefined);
          }
          if (!committed) await candidate.close().catch(() => undefined);
          throw error;
        }
        if (!previousClosed) await previous.close().catch(() => undefined);
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
        await stableService.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await generation.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        stableStore.close();
      } catch (error) {
        failures.push(error);
      }
      throwFailures(failures, "Runtime shutdown failed");
    },
  };
  function bindExtensionControls(host: RuntimeExtensionHost): void {
    host.setReloadHandler(async (input) => await runtime.reload({
      ...(input.session === undefined ? {} : { session: input.session }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }));
    host.setShutdownHandler(extensionShutdownHandler);
    host.setNativeHostHandler({
      async resolveCredential(provider, signal) {
        signal?.throwIfAborted();
        if (!runtime.auth.has(provider)) return undefined;
        const binding = runtime.auth.binding(provider);
        const resolved = await runtime.broker.resolve({
          provider: binding.credentialId,
          ...(signal === undefined ? {} : { signal }),
        });
        const request = runtime.auth.descriptor(provider)?.request;
        if (resolved === undefined) {
          if (binding.ambient === undefined) return undefined;
          return {
            provider,
            source: "ambient",
            credential: {
              kind: "ambient",
              mechanism: binding.ambient === "aws"
                ? "aws_default_chain"
                : binding.ambient === "google"
                  ? "google_adc"
                  : "azure_default_credential",
              hints: {},
            },
            headers: {},
          };
        }
        const credential = resolved.credential;
        const headers: Record<string, string> = {};
        if (credential.kind === "api_key" && request?.apiKey !== undefined) {
          headers[request.apiKey.header] = `${request.apiKey.prefix ?? ""}${credential.apiKey}`;
        } else if ((credential.kind === "bearer" || credential.kind === "oauth") && request?.bearer !== undefined) {
          headers[request.bearer.header] = `${request.bearer.prefix ?? "Bearer "}${credential.accessToken}`;
        }
        return {
          provider,
          source: resolved.source,
          credential: credential.kind === "api_key"
            ? {
                kind: "api_key",
                apiKey: credential.apiKey,
                ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
              }
            : credential.kind === "bearer"
              ? {
                  kind: "bearer",
                  accessToken: credential.accessToken,
                  ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }),
                  ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
                  ...(credential.subject === undefined ? {} : { subject: credential.subject }),
                }
              : credential.kind === "oauth"
                ? {
                    kind: "oauth",
                    accessToken: credential.accessToken,
                    expiresAt: credential.expiresAt,
                    tokenType: credential.tokenType,
                    scopes: [...credential.scopes],
                    ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
                    ...(credential.subject === undefined ? {} : { subject: credential.subject }),
                    ...(credential.providerData === undefined ? {} : { providerData: { ...credential.providerData } }),
                  }
                : {
                    kind: "ambient",
                    mechanism: credential.mechanism,
                    hints: { ...credential.hints },
                  },
          headers,
        };
      },
      async getConfiguration(signal) {
        signal?.throwIfAborted();
        const resolved = resolveConfig({
          globalPath: runtime.paths.globalConfig,
          projectPath: join(runtime.workspace, ".rigyn", "config.jsonc"),
          projectTrusted: runtime.trusted,
        });
        const effective = JSON.parse(JSON.stringify(parseHarnessConfig(resolved.value))) as JsonObject;
        signal?.throwIfAborted();
        return {
          workspace: runtime.workspace,
          projectTrusted: runtime.trusted,
          globalConfigPath: runtime.paths.globalConfig,
          projectConfigPath: join(runtime.workspace, ".rigyn", "config.jsonc"),
          databasePath: runtime.databasePath,
          effective,
        };
      },
      async updateConfiguration(input) {
        input.signal?.throwIfAborted();
        if (input.scope === "project" && !runtime.trusted) {
          throw new Error("Project configuration cannot be changed until the workspace is trusted");
        }
        const path = input.scope === "user"
          ? runtime.paths.globalConfig
          : join(runtime.workspace, ".rigyn", "config.jsonc");
        await updateGlobalConfig(path, (existing) => {
          const next = { ...existing, ...input.patch };
          parseHarnessConfig(next);
          return next;
        });
        input.signal?.throwIfAborted();
        const resolved = resolveConfig({
          globalPath: runtime.paths.globalConfig,
          projectPath: join(runtime.workspace, ".rigyn", "config.jsonc"),
          projectTrusted: runtime.trusted,
        });
        return {
          workspace: runtime.workspace,
          projectTrusted: runtime.trusted,
          globalConfigPath: runtime.paths.globalConfig,
          projectConfigPath: join(runtime.workspace, ".rigyn", "config.jsonc"),
          databasePath: runtime.databasePath,
          effective: JSON.parse(JSON.stringify(parseHarnessConfig(resolved.value))) as JsonObject,
        };
      },
    });
  }
  bindExtensionControls(generation.runtimeExtensions);
  return runtime;
}
