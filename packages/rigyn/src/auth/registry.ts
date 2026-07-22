import {
  DEFAULT_ENVIRONMENT_CREDENTIALS,
  EnvironmentCredentialSource,
  environmentCredentialVariables,
  resolvedEnvironmentCredentialVariable,
} from "./broker.js";
import { describeAmbientIdentity } from "./ambient.js";
import { pollDeviceToken, requestDeviceAuthorization } from "./device.js";
import {
  createLoopbackAuthorization,
  exchangeAuthorizationCode,
  type AuthorizationCodeCallback,
  type OAuthTokenResponse,
} from "./loopback.js";
import {
  cloneProviderAuthDescriptor,
  normalizeProviderAuthDescriptor,
  type ProviderAuthDescriptor,
  type ProviderAuthDescriptorMethod,
  type ProviderManagedAuthInteraction,
  type ProviderManagedOAuthAuthMethod,
} from "./provider-descriptor.js";
import { normalizeManagedOAuthCredential } from "./managed.js";
import { oauthErrorCode, oauthTokenExpiresAt } from "./oauth-token.js";
import type {
  AmbientCredentialDescriptor,
  AmbientProvider,
  AuthCredential,
  CredentialStore,
  OAuthCredential,
} from "./types.js";
import { assertCredentialId } from "./types.js";
import { revokeGenericOAuthWithFetch } from "./revocation.js";
import {
  CredentialProfileManager,
  type CredentialProfileState,
  type CredentialProfileSummary,
} from "./profiles.js";
import { isCredentialProfileMetadataStore } from "./types.js";

export type OAuthRegistrationConfig =
  | {
      provider: string;
      flow: "pkce";
      clientId: string;
      authorizationEndpoint: string;
      tokenEndpoint: string;
      revocationEndpoint?: string;
      scopes: string[];
      label?: string;
      callbackPath?: string;
      authorizationParameters?: Record<string, string>;
    }
  | {
      provider: string;
      flow: "device";
      clientId: string;
      deviceEndpoint: string;
      tokenEndpoint: string;
      revocationEndpoint?: string;
      scopes: string[];
      label?: string;
      deviceParameters?: Record<string, string>;
    };

export type ProviderAuthMethod =
  | { id: "local"; kind: "local"; label: string; detail: string }
  | { id: "external"; kind: "external"; label: string; detail: string }
  | { id: "openrouter_browser"; kind: "openrouter_browser"; label: string; detail: string }
  | { id: "openai_codex_browser"; kind: "openai_codex_browser"; label: string; detail: string }
  | { id: "openai_codex_device"; kind: "openai_codex_device"; label: string; detail: string }
  | { id: "anthropic_browser"; kind: "anthropic_browser"; label: string; detail: string }
  | { id: "github_copilot_device"; kind: "github_copilot_device"; label: string; detail: string }
  | { id: "environment"; kind: "environment"; label: string; detail: string; variable: string }
  | { id: "api_key"; kind: "api_key"; label: string; detail: string }
  | { id: "bearer"; kind: "bearer"; label: string; detail: string }
  | { id: `oauth:${string}`; kind: "oauth"; label: string; detail: string; registrationId: string }
  | { id: `managed:${string}`; kind: "managed_oauth"; label: string; detail: string; methodId: string }
  | { id: "ambient"; kind: "ambient"; label: string; detail: string; ambientProvider: AmbientProvider };

export interface ProviderAuthBinding {
  providerId: string;
  credentialId: string;
  displayName: string;
  secret?: "api_key" | "bearer";
  ambient?: AmbientProvider;
  local?: boolean;
  externallyManaged?: boolean;
  openRouterBrowser?: boolean;
  openAICodex?: boolean;
  anthropicOAuth?: boolean;
  githubCopilotOAuth?: boolean;
}

export interface StoredAuthState {
  present: boolean;
  active: boolean;
  shadowed: boolean;
  usable: boolean;
  kind?: AuthCredential["kind"];
  expiresAt?: number;
  accountId?: string;
  subject?: string;
}

export interface EnvironmentAuthState {
  present: boolean;
  active: boolean;
  shadowed: boolean;
  variable?: string;
}

export interface ProviderAuthState {
  provider: string;
  credentialId: string;
  displayName: string;
  status: "connected" | "available" | "unavailable";
  source?: "environment" | "stored" | "local" | "ambient" | "external";
  kind?: AuthCredential["kind"] | "local" | "external";
  accountId?: string;
  subject?: string;
  expiresAt?: number;
  environmentVariable?: string;
  environment: EnvironmentAuthState;
  stored: StoredAuthState;
  ambient?: AmbientCredentialDescriptor;
  methods: ProviderAuthMethod[];
  activeProfile?: string;
  fallbackSelected?: boolean;
  profiles?: CredentialProfileSummary[];
  error?: string;
}

export interface ProviderLogoutResult {
  provider: string;
  credentialId: string;
  removedStored: boolean;
  profile?: string;
  remoteRevocation: "not_requested" | "not_applicable" | "unsupported" | "revoked";
  state: ProviderAuthState;
}

export interface ProviderLogoutOptions {
  revokeRemote?: boolean;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ProviderProfileDeleteResult {
  provider: string;
  credentialId: string;
  profile: string;
  removed: boolean;
  remoteRevocation: ProviderLogoutResult["remoteRevocation"];
  state: ProviderAuthState;
}

export interface ProviderCredentialSaveResult {
  provider: string;
  credentialId: string;
  profile: string;
  action: "created" | "updated";
  state: ProviderAuthState;
}

const DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  openai: "OpenAI",
  "openai-codex": "ChatGPT Plus/Pro (Codex Subscription)",
  "azure-openai": "Azure OpenAI",
  anthropic: "Anthropic",
  "github-copilot": "GitHub Copilot",
  gemini: "Google Gemini",
  mistral: "Mistral AI",
  vertex: "Google Vertex AI",
  bedrock: "Amazon Bedrock",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  "llama.cpp": "llama.cpp Router",
  groq: "Groq",
  together: "Together",
  deepseek: "DeepSeek",
  cerebras: "Cerebras",
  xai: "xAI",
  fireworks: "Fireworks AI",
  huggingface: "Hugging Face",
  "vercel-ai-gateway": "Vercel AI Gateway",
  zai: "Z.AI Coding Plan (Global)",
  "zai-coding-cn": "Z.AI Coding Plan (China)",
  "ant-ling": "Ant Ling",
  nvidia: "NVIDIA",
  xiaomi: "Xiaomi MiMo",
  "xiaomi-token-plan-cn": "Xiaomi Token Plan (China)",
  "xiaomi-token-plan-ams": "Xiaomi Token Plan (Amsterdam)",
  "xiaomi-token-plan-sgp": "Xiaomi Token Plan (Singapore)",
  moonshotai: "Moonshot AI",
  "moonshotai-cn": "Moonshot AI (China)",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  "kimi-coding": "Kimi For Coding",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax (China)",
  "cloudflare-ai-gateway": "Cloudflare AI Gateway",
  "cloudflare-workers-ai": "Cloudflare Workers AI",
});

export function providerDisplayName(provider: string): string {
  return DISPLAY_NAMES[provider] ?? provider;
}

function hasPositiveAmbientHint(descriptor: AmbientCredentialDescriptor): boolean {
  return Object.entries(descriptor.hints).some(([name, value]) => value === true && !name.endsWith("MayBeAvailable"));
}

function credentialDetails(credential: AuthCredential): {
  kind: AuthCredential["kind"];
  accountId?: string;
  subject?: string;
  expiresAt?: number;
} {
  if (credential.kind === "ambient") return { kind: credential.kind };
  return {
    kind: credential.kind,
    ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
    ...((credential.kind === "bearer" || credential.kind === "oauth") && credential.subject !== undefined
      ? { subject: credential.subject }
      : {}),
    ...((credential.kind === "bearer" || credential.kind === "oauth") && credential.expiresAt !== undefined
      ? { expiresAt: credential.expiresAt }
      : {}),
  };
}

function credentialUsable(credential: AuthCredential, now: number): boolean {
  if (credential.kind === "api_key" || credential.kind === "ambient") return true;
  if (credential.kind === "bearer") return credential.expiresAt === undefined || credential.expiresAt > now;
  return credential.expiresAt > now || (
    credential.refreshToken !== undefined &&
    credential.tokenEndpoint !== undefined &&
    credential.clientId !== undefined
  );
}

interface RegisteredProviderAuthDescriptor {
  owner: string;
  descriptor: ProviderAuthDescriptor;
  oauthRegistrationIds: string[];
  ownsBinding: boolean;
}

function copyRegistration(registration: OAuthRegistrationConfig): OAuthRegistrationConfig {
  return registration.flow === "pkce"
    ? {
        ...registration,
        scopes: [...registration.scopes],
        ...(registration.authorizationParameters === undefined
          ? {}
          : { authorizationParameters: { ...registration.authorizationParameters } }),
      }
    : {
        ...registration,
        scopes: [...registration.scopes],
        ...(registration.deviceParameters === undefined
          ? {}
          : { deviceParameters: { ...registration.deviceParameters } }),
      };
}

function registrationRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("OAuth registration must be an object");
  }
  return value as Record<string, unknown>;
}

function registrationKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(input).filter((name) => !allowed.includes(name));
  if (unknown.length > 0) throw new TypeError(`OAuth registration contains unknown keys: ${unknown.join(", ")}`);
}

/** Validate and detach a public-client OAuth registration supplied through the JS API. */
export function normalizeOAuthRegistrationConfig(value: unknown): OAuthRegistrationConfig {
  const input = registrationRecord(value);
  if (input.flow === "pkce") {
    registrationKeys(input, [
      "provider", "flow", "clientId", "authorizationEndpoint", "tokenEndpoint", "scopes", "label",
      "revocationEndpoint", "callbackPath", "authorizationParameters",
    ]);
    const descriptor = normalizeProviderAuthDescriptor({
      provider: input.provider,
      methods: [{
        kind: "oauth_pkce",
        id: "registration",
        clientId: input.clientId,
        authorizationEndpoint: input.authorizationEndpoint,
        tokenEndpoint: input.tokenEndpoint,
        revocationEndpoint: input.revocationEndpoint,
        scopes: input.scopes,
        label: input.label,
        callbackPath: input.callbackPath,
        authorizationParameters: input.authorizationParameters,
      }],
    });
    const method = descriptor.methods[0];
    if (method?.kind !== "oauth_pkce") throw new TypeError("OAuth PKCE registration is invalid");
    return {
      provider: descriptor.provider,
      flow: "pkce",
      clientId: method.clientId,
      authorizationEndpoint: method.authorizationEndpoint,
      tokenEndpoint: method.tokenEndpoint,
      ...(method.revocationEndpoint === undefined ? {} : { revocationEndpoint: method.revocationEndpoint }),
      scopes: [...(method.scopes ?? [])],
      ...(method.label === undefined ? {} : { label: method.label }),
      ...(method.callbackPath === undefined ? {} : { callbackPath: method.callbackPath }),
      ...(method.authorizationParameters === undefined
        ? {}
        : { authorizationParameters: { ...method.authorizationParameters } }),
    };
  }
  if (input.flow === "device") {
    registrationKeys(input, [
      "provider", "flow", "clientId", "deviceEndpoint", "tokenEndpoint", "revocationEndpoint", "scopes", "label", "deviceParameters",
    ]);
    const descriptor = normalizeProviderAuthDescriptor({
      provider: input.provider,
      methods: [{
        kind: "oauth_device",
        id: "registration",
        clientId: input.clientId,
        deviceEndpoint: input.deviceEndpoint,
        tokenEndpoint: input.tokenEndpoint,
        revocationEndpoint: input.revocationEndpoint,
        scopes: input.scopes,
        label: input.label,
        deviceParameters: input.deviceParameters,
      }],
    });
    const method = descriptor.methods[0];
    if (method?.kind !== "oauth_device") throw new TypeError("OAuth device registration is invalid");
    return {
      provider: descriptor.provider,
      flow: "device",
      clientId: method.clientId,
      deviceEndpoint: method.deviceEndpoint,
      tokenEndpoint: method.tokenEndpoint,
      ...(method.revocationEndpoint === undefined ? {} : { revocationEndpoint: method.revocationEndpoint }),
      scopes: [...(method.scopes ?? [])],
      ...(method.label === undefined ? {} : { label: method.label }),
      ...(method.deviceParameters === undefined
        ? {}
        : { deviceParameters: { ...method.deviceParameters } }),
    };
  }
  throw new TypeError("OAuth registration flow must be pkce or device");
}

function descriptorMethod<T extends ProviderAuthDescriptorMethod["kind"]>(
  descriptor: ProviderAuthDescriptor | undefined,
  kind: T,
): Extract<ProviderAuthDescriptorMethod, { kind: T }> | undefined {
  return descriptor?.methods.find(
    (method): method is Extract<ProviderAuthDescriptorMethod, { kind: T }> => method.kind === kind,
  );
}

export class ProviderAuthRegistry {
  readonly #bindings = new Map<string, ProviderAuthBinding>();
  readonly #displayNameOverrides = new Map<string, Array<{ token: symbol; value: string }>>();
  readonly #registrations = new Map<string, OAuthRegistrationConfig>();
  readonly #registrationDetails = new Map<string, string>();
  readonly #descriptors = new Map<string, RegisteredProviderAuthDescriptor>();
  readonly #store: CredentialStore;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #now: () => number;

  constructor(options: {
    bindings: readonly ProviderAuthBinding[];
    registrations?: Readonly<Record<string, OAuthRegistrationConfig>>;
    store: CredentialStore;
    environment?: NodeJS.ProcessEnv;
    now?: () => number;
  }) {
    for (const binding of options.bindings) this.register(binding);
    for (const [id, registration] of Object.entries(options.registrations ?? {})) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
        throw new TypeError(`OAuth registration id is invalid: ${id}`);
      }
      this.#registrations.set(id, normalizeOAuthRegistrationConfig(registration));
    }
    this.#store = options.store;
    this.#environment = options.environment ?? process.env;
    this.#now = options.now ?? Date.now;
  }

  register(binding: ProviderAuthBinding): void {
    if (this.#bindings.has(binding.providerId)) throw new Error(`Duplicate provider auth binding: ${binding.providerId}`);
    this.#bindings.set(binding.providerId, { ...binding });
  }

  unregister(provider: string): boolean {
    if (this.#descriptors.has(provider)) {
      throw new Error(`Provider auth descriptor is still registered: ${provider}`);
    }
    if ((this.#displayNameOverrides.get(provider)?.length ?? 0) > 0) {
      throw new Error(`Provider display-name override is still registered: ${provider}`);
    }
    return this.#bindings.delete(provider);
  }

  has(provider: string): boolean {
    return this.#bindings.has(provider);
  }

  providers(): ProviderAuthBinding[] {
    return [...this.#bindings.keys()].map((provider) => this.binding(provider));
  }

  binding(provider: string): ProviderAuthBinding {
    const base = this.#bindings.get(provider);
    if (base === undefined) throw new Error(`Provider auth metadata is not registered: ${provider}`);
    const displayName = this.#displayNameOverrides.get(provider)?.at(-1)?.value;
    const descriptor = this.#descriptors.get(provider)?.descriptor;
    if (descriptor === undefined) return { ...base, displayName: displayName ?? base.displayName };
    const apiKey = descriptorMethod(descriptor, "api_key");
    const ambient = descriptorMethod(descriptor, "ambient");
    return {
      ...base,
      credentialId: descriptor.credentialId ?? base.credentialId,
      displayName: displayName ?? descriptor.displayName ?? base.displayName,
      ...(apiKey === undefined ? {} : { secret: "api_key" as const }),
      ...(ambient === undefined ? {} : { ambient: ambient.provider }),
      externallyManaged: false,
    };
  }

  /** Temporarily changes only presentation metadata while preserving credentials and methods. */
  overrideDisplayName(provider: string, value: string): () => void {
    if (!this.#bindings.has(provider)) throw new Error(`Provider auth metadata is not registered: ${provider}`);
    const displayName = value.trim();
    if (
      displayName === "" ||
      displayName !== value ||
      /[\x00-\x1f\x7f]/u.test(displayName) ||
      Buffer.byteLength(displayName, "utf8") > 1_024
    ) throw new TypeError("Provider display name is invalid");
    const token = Symbol(provider);
    const layers = this.#displayNameOverrides.get(provider) ?? [];
    layers.push({ token, value: displayName });
    this.#displayNameOverrides.set(provider, layers);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const current = this.#displayNameOverrides.get(provider);
      if (current === undefined) return;
      const index = current.findIndex((entry) => entry.token === token);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.#displayNameOverrides.delete(provider);
    };
  }

  /** Secret-free, detached descriptor metadata for host-side request brokerage. */
  descriptor(provider: string): ProviderAuthDescriptor | undefined {
    const descriptor = this.#descriptors.get(provider)?.descriptor;
    return descriptor === undefined ? undefined : cloneProviderAuthDescriptor(descriptor);
  }

  managedMethod(provider: string, methodId: string): ProviderManagedOAuthAuthMethod | undefined {
    const descriptor = this.#descriptors.get(provider)?.descriptor;
    const method = descriptor?.methods.find((entry): entry is ProviderManagedOAuthAuthMethod =>
      entry.kind === "managed_oauth" && entry.id === methodId);
    return method === undefined ? undefined : { ...method };
  }

  async authorizeManaged(
    provider: string,
    methodId: string,
    interaction: ProviderManagedAuthInteraction,
  ): Promise<OAuthCredential> {
    interaction.signal.throwIfAborted();
    const method = this.managedMethod(provider, methodId);
    if (method === undefined) throw new Error(`Managed provider authentication method is not registered: ${provider}/${methodId}`);
    const binding = this.binding(provider);
    const value = await method.login(interaction);
    interaction.signal.throwIfAborted();
    return normalizeManagedOAuthCredential(binding.credentialId, method.id, value);
  }

  /** Attach one generation-owned extension descriptor. The returned cleanup is idempotent. */
  registerDescriptor(owner: string, value: ProviderAuthDescriptor): () => void {
    if (owner === "" || /[\x00-\x1f\x7f]/u.test(owner) || Buffer.byteLength(owner) > 512) {
      throw new TypeError("Provider auth descriptor owner is invalid");
    }
    const descriptor = normalizeProviderAuthDescriptor(value);
    if (this.#descriptors.has(descriptor.provider)) {
      throw new Error(`Duplicate provider auth descriptor: ${descriptor.provider}`);
    }
    const existing = this.#bindings.get(descriptor.provider);
    const credentialId = descriptor.credentialId ?? existing?.credentialId ?? descriptor.provider;
    if (credentialId !== existing?.credentialId) {
      const credentialOwner = this.providers().find((binding) =>
        binding.providerId !== descriptor.provider && binding.credentialId === credentialId);
      if (credentialOwner !== undefined) {
        throw new Error(`Provider auth credentialId belongs to another provider: ${credentialOwner.providerId}`);
      }
    }
    const apiKey = descriptorMethod(descriptor, "api_key");
    const ambient = descriptorMethod(descriptor, "ambient");
    if (existing?.local === true) throw new Error(`Local provider cannot register authentication methods: ${descriptor.provider}`);
    if (existing?.secret !== undefined && apiKey !== undefined) {
      throw new Error(`Provider auth API-key method conflicts with existing binding: ${descriptor.provider}`);
    }
    if (existing?.ambient !== undefined && ambient !== undefined) {
      throw new Error(`Provider auth ambient method conflicts with existing binding: ${descriptor.provider}`);
    }
    if (
      existing !== undefined &&
      descriptor.credentialId !== undefined &&
      descriptor.credentialId !== existing.credentialId &&
      existing.externallyManaged !== true
    ) {
      throw new Error(`Provider auth credentialId conflicts with existing binding: ${descriptor.provider}`);
    }

    const pendingOAuth: Array<{ id: string; registration: OAuthRegistrationConfig; detail?: string }> = [];
    for (const method of descriptor.methods) {
      if (method.kind !== "oauth_pkce" && method.kind !== "oauth_device") continue;
      const registrationId = `extension:${owner}:${descriptor.provider}:${method.id}`;
      if (this.#registrations.has(registrationId)) {
        throw new Error(`Duplicate OAuth registration: ${registrationId}`);
      }
      const registration: OAuthRegistrationConfig = method.kind === "oauth_pkce"
        ? {
            provider: descriptor.provider,
            flow: "pkce",
            clientId: method.clientId,
            authorizationEndpoint: method.authorizationEndpoint,
            tokenEndpoint: method.tokenEndpoint,
            ...(method.revocationEndpoint === undefined ? {} : { revocationEndpoint: method.revocationEndpoint }),
            scopes: [...(method.scopes ?? [])],
            ...(method.label === undefined ? {} : { label: method.label }),
            ...(method.callbackPath === undefined ? {} : { callbackPath: method.callbackPath }),
            ...(method.authorizationParameters === undefined
              ? {}
              : { authorizationParameters: { ...method.authorizationParameters } }),
          }
        : {
            provider: descriptor.provider,
            flow: "device",
            clientId: method.clientId,
            deviceEndpoint: method.deviceEndpoint,
            tokenEndpoint: method.tokenEndpoint,
            ...(method.revocationEndpoint === undefined ? {} : { revocationEndpoint: method.revocationEndpoint }),
            scopes: [...(method.scopes ?? [])],
            ...(method.label === undefined ? {} : { label: method.label }),
            ...(method.deviceParameters === undefined
              ? {}
              : { deviceParameters: { ...method.deviceParameters } }),
          };
      pendingOAuth.push({ id: registrationId, registration, ...(method.detail === undefined ? {} : { detail: method.detail }) });
    }

    const ownsBinding = existing === undefined;
    if (ownsBinding) {
      this.#bindings.set(descriptor.provider, {
        providerId: descriptor.provider,
        credentialId: descriptor.credentialId ?? descriptor.provider,
        displayName: descriptor.displayName ?? providerDisplayName(descriptor.provider),
      });
    }
    const oauthRegistrationIds = pendingOAuth.map((entry) => entry.id);
    for (const entry of pendingOAuth) {
      this.#registrations.set(entry.id, entry.registration);
      if (entry.detail !== undefined) this.#registrationDetails.set(entry.id, entry.detail);
    }
    const registered = { owner, descriptor, oauthRegistrationIds, ownsBinding };
    this.#descriptors.set(descriptor.provider, registered);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.#descriptors.get(descriptor.provider) !== registered) return;
      this.#descriptors.delete(descriptor.provider);
      for (const registrationId of oauthRegistrationIds) {
        this.#registrations.delete(registrationId);
        this.#registrationDetails.delete(registrationId);
      }
      if (ownsBinding) this.#bindings.delete(descriptor.provider);
    };
  }

  providersForCredential(credentialId: string): string[] {
    return this.providers()
      .filter((binding) => binding.credentialId === credentialId)
      .map((binding) => binding.providerId);
  }

  affectedProviders(provider: string): string[] {
    return this.providersForCredential(this.binding(provider).credentialId);
  }

  registration(id: string): OAuthRegistrationConfig {
    const registration = this.#registrations.get(id);
    if (registration === undefined) throw new Error(`OAuth registration is not configured: ${id}`);
    return copyRegistration(registration);
  }

  methods(provider: string): ProviderAuthMethod[] {
    const binding = this.binding(provider);
    if (binding.local === true) {
      return [{ id: "local", kind: "local", label: "Use local server", detail: "No login is required" }];
    }
    const methods: ProviderAuthMethod[] = [];
    if (binding.openRouterBrowser === true) {
      methods.push({
        id: "openrouter_browser",
        kind: "openrouter_browser",
        label: "Sign in with OpenRouter",
        detail: "Browser authorization",
      });
    }
    if (binding.openAICodex === true) {
      methods.push(
        {
          id: "openai_codex_browser",
          kind: "openai_codex_browser",
          label: "Browser login (default)",
          detail: "ChatGPT Plus/Pro · PKCE loopback with manual callback fallback",
        },
        {
          id: "openai_codex_device",
          kind: "openai_codex_device",
          label: "Device code login (headless)",
          detail: "ChatGPT Plus/Pro · terminal or SSH login",
        },
      );
    }
    if (binding.anthropicOAuth === true) {
      methods.push({
        id: "anthropic_browser",
        kind: "anthropic_browser",
        label: "Claude Pro/Max browser login",
        detail: "Anthropic subscription · PKCE loopback with manual callback fallback",
      });
    }
    if (binding.githubCopilotOAuth === true) {
      methods.push({
        id: "github_copilot_device",
        kind: "github_copilot_device",
        label: "GitHub device login",
        detail: "GitHub Copilot subscription · supports GitHub Enterprise Cloud",
      });
    }
    for (const method of this.#descriptors.get(provider)?.descriptor.methods ?? []) {
      if (method.kind !== "managed_oauth") continue;
      methods.push({
        id: `managed:${method.id}`,
        kind: "managed_oauth",
        label: method.label ?? `Sign in with ${providerDisplayName(provider)}`,
        detail: method.detail ?? "Provider-managed authentication",
        methodId: method.id,
      });
    }
    for (const [registrationId, registration] of this.#registrations) {
      if (registration.provider !== provider) continue;
      methods.push({
        id: `oauth:${registrationId}`,
        kind: "oauth",
        label: registration.label ?? `Sign in with ${providerDisplayName(provider)}`,
        detail: this.#registrationDetails.get(registrationId) ?? `${registration.flow === "pkce" ? "Browser authorization (PKCE)" : "Device authorization"} · ${new URL(
          registration.flow === "pkce" ? registration.authorizationEndpoint : registration.deviceEndpoint,
        ).host} · configured registration ${registrationId}`,
        registrationId,
      });
    }
    const environmentSpec = DEFAULT_ENVIRONMENT_CREDENTIALS[binding.credentialId];
    if (environmentSpec !== undefined) {
      const variables = environmentCredentialVariables(environmentSpec);
      methods.push({
        id: "environment",
        kind: "environment",
        label: "Use environment credential",
        detail: variables.join(" or "),
        variable: environmentSpec.variable,
      });
    }
    const dynamicApiKey = descriptorMethod(this.#descriptors.get(provider)?.descriptor, "api_key");
    if (binding.secret === "api_key") {
      methods.push({
        id: "api_key",
        kind: "api_key",
        label: dynamicApiKey?.label ?? "Store API key",
        detail: dynamicApiKey?.detail ?? "Saved in the secure credential store",
      });
    } else if (binding.secret === "bearer") {
      methods.push({ id: "bearer", kind: "bearer", label: "Store bearer token", detail: "Saved in the secure credential store" });
    }
    if (binding.ambient !== undefined) {
      const dynamicAmbient = descriptorMethod(this.#descriptors.get(provider)?.descriptor, "ambient");
      methods.push({
        id: "ambient",
        kind: "ambient",
        label: dynamicAmbient?.label ?? "Use ambient identity",
        detail: dynamicAmbient?.detail ?? describeAmbientIdentity(binding.ambient, this.#environment).mechanism.replaceAll("_", " "),
        ambientProvider: binding.ambient,
      });
    }
    if (binding.externallyManaged === true) {
      methods.push({
        id: "external",
        kind: "external",
        label: "Use provider-managed authentication",
        detail: "Authentication is managed by the provider extension",
      });
    }
    return methods;
  }

  async loginMethods(provider: string): Promise<ProviderAuthMethod[]> {
    const methods = this.methods(provider);
    const environment = await new EnvironmentCredentialSource({ environment: this.#environment }).resolve({
      provider: this.binding(provider).credentialId,
    });
    return methods.filter((method) => {
      if (method.kind === "environment") return environment !== undefined;
      if (method.kind === "ambient" && environment !== undefined) return false;
      return true;
    });
  }

  async profileState(provider: string): Promise<CredentialProfileState> {
    const binding = this.binding(provider);
    return this.#profileManager(binding.credentialId).state();
  }

  async storeCredential(
    provider: string,
    credential: AuthCredential,
    options: { profile?: string; select?: boolean } = {},
  ): Promise<ProviderCredentialSaveResult> {
    const binding = this.binding(provider);
    if (credential.provider !== binding.credentialId) {
      throw new TypeError("Credential provider does not match the provider registration");
    }
    if (!isCredentialProfileMetadataStore(this.#store)) {
      if (options.profile !== undefined && options.profile !== "default") {
        throw new Error("Credential store does not support named profiles");
      }
      const previous = await this.#store.read(binding.credentialId);
      await this.#store.write(binding.credentialId, credential);
      return {
        provider,
        credentialId: binding.credentialId,
        profile: "default",
        action: previous === undefined ? "created" : "updated",
        state: await this.state(provider),
      };
    }
    const manager = this.#profileManager(binding.credentialId);
    const { profile, action } = await manager.putSelected(credential, options);
    return {
      provider,
      credentialId: binding.credentialId,
      profile,
      action,
      state: await this.state(provider),
    };
  }

  async selectProfile(provider: string, profile: string): Promise<ProviderAuthState> {
    const binding = this.binding(provider);
    await this.#profileManager(binding.credentialId).select(profile);
    return this.state(provider);
  }

  async selectFallback(provider: string): Promise<ProviderAuthState> {
    const binding = this.binding(provider);
    if (isCredentialProfileMetadataStore(this.#store)) {
      await this.#profileManager(binding.credentialId).selectFallback();
    } else {
      await this.#store.delete(binding.credentialId);
    }
    return this.state(provider);
  }

  async deleteProfile(
    provider: string,
    profile: string,
    options: ProviderLogoutOptions = {},
  ): Promise<ProviderProfileDeleteResult> {
    options.signal?.throwIfAborted();
    const binding = this.binding(provider);
    const manager = this.#profileManager(binding.credentialId);
    let removed = false;
    let remoteRevocation: ProviderLogoutResult["remoteRevocation"] = "not_requested";
    await this.#store.withLock(binding.credentialId, async () => {
      const previous = await manager.read(profile);
      remoteRevocation = await this.#remoteRevocation(previous, options);
      options.signal?.throwIfAborted();
      removed = await manager.delete(profile);
    }, options.signal);
    return {
      provider,
      credentialId: binding.credentialId,
      profile,
      removed,
      remoteRevocation,
      state: await this.state(provider),
    };
  }

  async state(provider: string): Promise<ProviderAuthState> {
    const binding = this.binding(provider);
    const methods = this.methods(provider);
    const emptyStored: StoredAuthState = { present: false, active: false, shadowed: false, usable: false };
    const environmentSpec = DEFAULT_ENVIRONMENT_CREDENTIALS[binding.credentialId];
    const environmentVariable = environmentSpec === undefined
      ? undefined
      : resolvedEnvironmentCredentialVariable(environmentSpec, this.#environment) ?? environmentSpec.variable;
    try {
      const environment = await new EnvironmentCredentialSource({ environment: this.#environment }).resolve({
        provider: binding.credentialId,
      });
      let profileState: CredentialProfileState | undefined;
      let storedCredential: AuthCredential | undefined;
      if (isCredentialProfileMetadataStore(this.#store)) {
        const manager = new CredentialProfileManager(this.#store, binding.credentialId, { now: this.#now });
        await this.#store.withLock(binding.credentialId, async () => {
          profileState = await manager.state();
          storedCredential = (await manager.active()).credential;
        });
      } else {
        storedCredential = await this.#store.read(binding.credentialId);
      }
      if (storedCredential !== undefined && storedCredential.provider !== binding.credentialId) {
        throw new Error(`Stored credential provider mismatch for ${binding.credentialId}`);
      }
      const profileConfigured = (profileState?.profiles.length ?? 0) > 0;
      const profileBlocksFallback = profileConfigured && profileState?.fallbackSelected !== true;
      const profileFields = profileState === undefined
        ? {}
        : {
            profiles: profileState.profiles,
            fallbackSelected: profileState.fallbackSelected,
            ...(profileState.activeProfile === undefined ? {} : { activeProfile: profileState.activeProfile }),
          };
      const managedRefresh = storedCredential?.kind === "oauth" && storedCredential.refreshToken !== undefined &&
        typeof storedCredential.providerData?.managedFlow === "string" &&
        this.managedMethod(provider, storedCredential.providerData.managedFlow) !== undefined;
      const usable = storedCredential === undefined ? false : credentialUsable(storedCredential, this.#now()) || managedRefresh;
      const stored: StoredAuthState = storedCredential === undefined
        ? emptyStored
        : {
            present: true,
            active: true,
            shadowed: false,
            usable,
            ...credentialDetails(storedCredential),
          };
      const environmentState: EnvironmentAuthState = {
        present: environment !== undefined,
        active: !profileBlocksFallback && storedCredential === undefined && environment !== undefined,
        shadowed: (profileBlocksFallback || storedCredential !== undefined) && environment !== undefined,
        ...(environmentVariable === undefined ? {} : { variable: environmentVariable }),
      };
      if (profileBlocksFallback && (profileState?.activeProfile === undefined || storedCredential === undefined)) {
        return {
          provider,
          credentialId: binding.credentialId,
          displayName: binding.displayName,
          status: "unavailable",
          source: "stored",
          environment: environmentState,
          ...(environmentVariable === undefined ? {} : { environmentVariable }),
          stored,
          methods,
          ...profileFields,
          ...(binding.ambient === undefined ? {} : { ambient: describeAmbientIdentity(binding.ambient, this.#environment) }),
          error: profileState?.activeProfile === undefined
            ? "Stored credential profiles exist but none is selected"
            : "The selected credential profile is missing",
        };
      }
      if (storedCredential !== undefined && usable) {
        return {
          provider,
          credentialId: binding.credentialId,
          displayName: binding.displayName,
          status: "connected",
          source: "stored",
          ...credentialDetails(storedCredential),
          environment: environmentState,
          ...(environmentVariable === undefined ? {} : { environmentVariable }),
          stored,
          methods,
          ...profileFields,
          ...(binding.ambient === undefined ? {} : { ambient: describeAmbientIdentity(binding.ambient, this.#environment) }),
        };
      }
      if (storedCredential !== undefined) {
        return {
          provider,
          credentialId: binding.credentialId,
          displayName: binding.displayName,
          status: "unavailable",
          source: "stored",
          ...credentialDetails(storedCredential),
          environment: environmentState,
          ...(environmentVariable === undefined ? {} : { environmentVariable }),
          stored,
          methods,
          ...profileFields,
          ...(binding.ambient === undefined ? {} : { ambient: describeAmbientIdentity(binding.ambient, this.#environment) }),
          error: "Stored credential is expired and cannot be refreshed",
        };
      }
      if (environment !== undefined) {
        return {
          provider,
          credentialId: binding.credentialId,
          displayName: binding.displayName,
          status: "connected",
          source: "environment",
          ...credentialDetails(environment),
          environment: environmentState,
          ...(environmentVariable === undefined ? {} : { environmentVariable }),
          stored,
          methods,
          ...profileFields,
          ...(binding.ambient === undefined ? {} : { ambient: describeAmbientIdentity(binding.ambient, this.#environment) }),
        };
      }
      if (binding.local === true) {
        return {
          provider,
          credentialId: binding.credentialId,
          displayName: binding.displayName,
          status: "connected",
          source: "local",
          kind: "local",
          environment: environmentState,
          stored,
          methods,
          ...profileFields,
        };
      }
      if (binding.ambient !== undefined) {
        const ambient = describeAmbientIdentity(binding.ambient, this.#environment);
        return {
          provider,
          credentialId: binding.credentialId,
          displayName: binding.displayName,
          status: "available",
          source: "ambient",
          kind: "ambient",
          environment: environmentState,
          stored,
          ambient,
          methods,
          ...profileFields,
          ...(hasPositiveAmbientHint(ambient) ? {} : { error: "Ambient identity has not been verified" }),
        };
      }
      if (binding.externallyManaged === true) {
        return {
          provider,
          credentialId: binding.credentialId,
          displayName: binding.displayName,
          status: "available",
          source: "external",
          kind: "external",
          environment: environmentState,
          stored,
          methods,
          ...profileFields,
        };
      }
      return {
        provider,
        credentialId: binding.credentialId,
        displayName: binding.displayName,
        status: methods.some((method) => method.kind !== "environment") ? "available" : "unavailable",
        environment: environmentState,
        stored,
        methods,
        ...profileFields,
      };
    } catch (error) {
      return {
        provider,
        credentialId: binding.credentialId,
        displayName: binding.displayName,
        status: "unavailable",
        environment: { present: false, active: false, shadowed: false },
        stored: emptyStored,
        methods,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async states(): Promise<ProviderAuthState[]> {
    return Promise.all(this.providers().map((binding) => this.state(binding.providerId)));
  }

  async logout(provider: string, options: ProviderLogoutOptions = {}): Promise<ProviderLogoutResult> {
    options.signal?.throwIfAborted();
    const binding = this.binding(provider);
    let profile: string | undefined;
    let previous: AuthCredential | undefined;
    let manager: CredentialProfileManager | undefined;
    let remoteRevocation: ProviderLogoutResult["remoteRevocation"] = "not_requested";
    if (isCredentialProfileMetadataStore(this.#store)) {
      manager = this.#profileManager(binding.credentialId);
      await this.#store.withLock(binding.credentialId, async () => {
        const active = await manager!.active();
        profile = active.name;
        previous = active.credential;
        remoteRevocation = await this.#remoteRevocation(previous, options);
        options.signal?.throwIfAborted();
        if (profile !== undefined) await manager!.delete(profile);
      }, options.signal);
    } else {
      previous = await this.#store.read(binding.credentialId);
      remoteRevocation = await this.#remoteRevocation(previous, options);
      options.signal?.throwIfAborted();
      await this.#store.delete(binding.credentialId);
    }
    return {
      provider,
      credentialId: binding.credentialId,
      removedStored: previous !== undefined,
      ...(profile === undefined ? {} : { profile }),
      remoteRevocation,
      state: await this.state(provider),
    };
  }

  #profileManager(credentialId: string): CredentialProfileManager {
    return new CredentialProfileManager(this.#store, credentialId, { now: this.#now });
  }

  async #remoteRevocation(
    credential: AuthCredential | undefined,
    options: ProviderLogoutOptions,
  ): Promise<ProviderLogoutResult["remoteRevocation"]> {
    if (options.revokeRemote !== true) return "not_requested";
    if (credential?.kind !== "oauth") return "not_applicable";
    if (credential.revocationEndpoint === undefined) return "unsupported";
    await revokeGenericOAuthWithFetch(credential, options.fetch ?? fetch, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return "revoked";
  }
}

export interface OAuthRegistrationCallbacks {
  showAuthorization(input: { url: URL; userCode?: string }): void | Promise<void>;
  openUrl?(url: URL): void | Promise<void>;
  requestManualAuthorization?(
    input: { authorizationUrl: URL; redirectUri: string; state: string },
    signal: AbortSignal,
  ): Promise<string | undefined>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export function parseManualAuthorization(
  value: string,
  expected: { redirectUri: string; state: string },
): { code: string; state: string } {
  const input = value.trim();
  if (input === "" || Buffer.byteLength(input, "utf8") > 16 * 1024 || /[\u0000-\u001f\u007f]/u.test(input)) {
    throw new Error("Manual OAuth response must be a non-empty code or callback URL no larger than 16 KiB");
  }
  let callback: URL | undefined;
  try {
    callback = new URL(input);
  } catch {}
  if (callback === undefined) {
    if (Buffer.byteLength(input, "utf8") > 4_096 || /\s/u.test(input)) throw new Error("Manual OAuth code is invalid");
    return { code: input, state: expected.state };
  }
  const redirect = new URL(expected.redirectUri);
  if (
    callback.protocol !== redirect.protocol ||
    callback.hostname !== redirect.hostname ||
    callback.port !== redirect.port ||
    callback.pathname !== redirect.pathname ||
    callback.username !== "" ||
    callback.password !== ""
  ) throw new Error("Manual OAuth callback does not match the expected loopback redirect");
  if (callback.searchParams.get("state") !== expected.state) throw new Error("Manual OAuth callback state is invalid");
  const providerError = callback.searchParams.get("error");
  if (providerError !== null) {
    throw new Error(`OAuth authorization failed: ${oauthErrorCode(providerError, "authorization_failed")}`);
  }
  const code = callback.searchParams.get("code");
  if (code === null || code === "" || Buffer.byteLength(code, "utf8") > 4_096 || /[\u0000-\u001f\u007f]/u.test(code)) {
    throw new Error("Manual OAuth callback omitted a valid authorization code");
  }
  return { code, state: expected.state };
}

function oauthCredential(
  provider: string,
  registration: OAuthRegistrationConfig,
  token: OAuthTokenResponse,
): OAuthCredential {
  return {
    kind: "oauth",
    provider,
    accessToken: token.accessToken,
    ...(token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken }),
    expiresAt: oauthTokenExpiresAt(token),
    tokenType: token.tokenType,
    scopes: token.scope?.split(/\s+/u).filter(Boolean) ?? [...registration.scopes],
    tokenEndpoint: registration.tokenEndpoint,
    ...(registration.revocationEndpoint === undefined ? {} : { revocationEndpoint: registration.revocationEndpoint }),
    clientId: registration.clientId,
  };
}

export async function authorizeOAuthRegistration(
  registration: OAuthRegistrationConfig,
  credentialProvider: string,
  callbacks: OAuthRegistrationCallbacks,
): Promise<OAuthCredential> {
  registration = normalizeOAuthRegistrationConfig(registration);
  assertCredentialId(credentialProvider);
  callbacks.signal?.throwIfAborted();
  if (registration.flow === "pkce") {
    const session = await createLoopbackAuthorization({
      authorizationEndpoint: registration.authorizationEndpoint,
      clientId: registration.clientId,
      scopes: registration.scopes,
      ...(registration.callbackPath === undefined ? {} : { callbackPath: registration.callbackPath }),
      ...(registration.authorizationParameters === undefined ? {} : { extraParameters: registration.authorizationParameters }),
    });
    const abort = (): void => session.cancel(callbacks.signal?.reason instanceof Error ? callbacks.signal.reason : undefined);
    callbacks.signal?.addEventListener("abort", abort, { once: true });
    try {
      await callbacks.showAuthorization({ url: session.authorizationUrl });
      await callbacks.openUrl?.(session.authorizationUrl);
      const manualController = new AbortController();
      const manualSignal = callbacks.signal === undefined
        ? manualController.signal
        : AbortSignal.any([manualController.signal, callbacks.signal]);
      const callbackPromise = session.waitForCallback().then((value) => ({ source: "loopback" as const, value }));
      const manualPromise = callbacks.requestManualAuthorization === undefined
        ? new Promise<never>(() => undefined)
        : callbacks.requestManualAuthorization({
            authorizationUrl: session.authorizationUrl,
            redirectUri: session.redirectUri,
            state: session.state,
          }, manualSignal).then((value) => value === undefined
            ? new Promise<never>(() => undefined)
            : { source: "manual" as const, value: parseManualAuthorization(value, session) });
      let selected:
        | { source: "loopback"; value: AuthorizationCodeCallback }
        | { source: "manual"; value: AuthorizationCodeCallback };
      try {
        selected = await Promise.race([callbackPromise, manualPromise]);
      } finally {
        manualController.abort(new Error("OAuth authorization completed through another channel"));
      }
      if (selected.source === "manual") session.cancel(new Error("OAuth loopback superseded by manual authorization"));
      const callback = selected.value;
      const token = await exchangeAuthorizationCode({
        tokenEndpoint: registration.tokenEndpoint,
        clientId: registration.clientId,
        code: callback.code,
        redirectUri: session.redirectUri,
        verifier: session.verifier,
        ...(callbacks.signal === undefined ? {} : { signal: callbacks.signal }),
        ...(callbacks.fetch === undefined ? {} : { fetch: callbacks.fetch }),
        ...(callbacks.requestTimeoutMs === undefined ? {} : { timeoutMs: callbacks.requestTimeoutMs }),
      });
      return oauthCredential(credentialProvider, registration, token);
    } catch (error) {
      session.cancel(error instanceof Error ? error : new Error("OAuth authorization failed"));
      throw error;
    } finally {
      callbacks.signal?.removeEventListener("abort", abort);
    }
  }

  const authorization = await requestDeviceAuthorization({
    deviceEndpoint: registration.deviceEndpoint,
    clientId: registration.clientId,
    scopes: registration.scopes,
    ...(registration.deviceParameters === undefined ? {} : { parameters: registration.deviceParameters }),
    ...(callbacks.signal === undefined ? {} : { signal: callbacks.signal }),
    ...(callbacks.fetch === undefined ? {} : { fetch: callbacks.fetch }),
    ...(callbacks.requestTimeoutMs === undefined ? {} : { timeoutMs: callbacks.requestTimeoutMs }),
  });
  const url = new URL(authorization.verificationUriComplete ?? authorization.verificationUri);
  await callbacks.showAuthorization({ url, userCode: authorization.userCode });
  await callbacks.openUrl?.(url);
  const token = await pollDeviceToken({
    tokenEndpoint: registration.tokenEndpoint,
    clientId: registration.clientId,
    deviceCode: authorization.deviceCode,
    expiresInSeconds: authorization.expiresInSeconds,
    intervalSeconds: authorization.intervalSeconds,
    ...(callbacks.signal === undefined ? {} : { signal: callbacks.signal }),
    ...(callbacks.fetch === undefined ? {} : { fetch: callbacks.fetch }),
    ...(callbacks.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: callbacks.requestTimeoutMs }),
  });
  return oauthCredential(credentialProvider, registration, token);
}
