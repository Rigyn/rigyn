import { defaultSecretRedactor, type SecretRedactor } from "./redaction.js";
import {
  assertAuthCredential,
  credentialSecrets,
  assertCredentialId,
  type AmbientCredentialDescriptor,
  type AuthCredential,
  type AuthProviderId,
  type OAuthCredential,
  type CredentialRequest,
  type CredentialSource,
  type CredentialStore,
  type ResolvedCredential,
} from "./types.js";
import { OAuthRefreshCoordinator, type OAuthRefresher } from "./refresh.js";
import { refreshGenericOAuth } from "./oauth.js";
import { CredentialProfileManager } from "./profiles.js";
import { isCredentialProfileMetadataStore } from "./types.js";
import { resolveExternalCommandCredential } from "./external-command.js";

export class CredentialBroker {
  readonly #sources: readonly CredentialSource[];
  readonly #redactor: SecretRedactor;

  constructor(sources: readonly CredentialSource[], redactor = defaultSecretRedactor) {
    this.#sources = [...sources];
    this.#redactor = redactor;
  }

  async resolve(request: CredentialRequest): Promise<ResolvedCredential | undefined> {
    request.signal?.throwIfAborted();
    for (const source of this.#sources) {
      const credential = await source.resolve(request);
      request.signal?.throwIfAborted();
      if (credential === undefined) continue;
      assertAuthCredential(credential);
      if (credential.kind !== "ambient" && credential.provider !== request.provider) {
        throw new Error(`Credential source returned a credential for a different provider than ${request.provider}`);
      }
      if (
        (credential.kind === "bearer" || credential.kind === "oauth") &&
        credential.expiresAt !== undefined &&
        credential.expiresAt <= Date.now()
      ) {
        throw new Error(`Credential for ${request.provider} is expired; reauthentication is required`);
      }
      this.#redactor.registerAll(credentialSecrets(credential));
      return { credential, source: source.name };
    }
    return undefined;
  }
}

export class StoredCredentialSource implements CredentialSource {
  readonly name: string;
  readonly #store: CredentialStore;
  readonly #keyForProvider: (provider: AuthProviderId) => string;

  constructor(
    store: CredentialStore,
    options?: { name?: string; keyForProvider?: (provider: AuthProviderId) => string },
  ) {
    this.#store = store;
    this.#keyForProvider = options?.keyForProvider ?? ((provider) => provider);
    this.name = options?.name ?? "stored";
  }

  async resolve(request: CredentialRequest): Promise<AuthCredential | undefined> {
    request.signal?.throwIfAborted();
    const id = this.#keyForProvider(request.provider);
    assertCredentialId(id);
    const credential = await this.#store.read(id);
    if (credential !== undefined && credential.provider !== request.provider) {
      throw new Error(`Stored credential provider mismatch for ${request.provider}`);
    }
    return credential;
  }
}

export class RefreshingStoredCredentialSource implements CredentialSource {
  readonly name: string;
  readonly #store: CredentialStore;
  readonly #keyForProvider: (provider: AuthProviderId) => string;
  readonly #refresh: OAuthRefresher;

  constructor(
    store: CredentialStore,
    options?: {
      name?: string;
      keyForProvider?: (provider: AuthProviderId) => string;
      refresh?: OAuthRefresher;
    },
  ) {
    this.#store = store;
    this.#keyForProvider = options?.keyForProvider ?? ((provider) => provider);
    this.#refresh = options?.refresh ?? refreshGenericOAuth;
    this.name = options?.name ?? "stored";
  }

  async resolve(request: CredentialRequest): Promise<AuthCredential | undefined> {
    request.signal?.throwIfAborted();
    const id = this.#keyForProvider(request.provider);
    assertCredentialId(id);
    const current = await this.#store.read(id);
    if (current === undefined) return undefined;
    if (current.provider !== request.provider) throw new Error(`Stored credential provider mismatch for ${request.provider}`);
    if (current.kind !== "oauth") return current;
    return new OAuthRefreshCoordinator({ store: this.#store, refresh: this.#refresh }).getValid(id, {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  }
}

export class ProfiledRefreshingStoredCredentialSource implements CredentialSource {
  readonly name: string;
  readonly #store: CredentialStore;
  readonly #refresh: OAuthRefresher;
  readonly #legacy: RefreshingStoredCredentialSource;

  constructor(
    store: CredentialStore,
    options?: { name?: string; refresh?: OAuthRefresher },
  ) {
    this.#store = store;
    this.#refresh = options?.refresh ?? refreshGenericOAuth;
    this.name = options?.name ?? "stored";
    this.#legacy = new RefreshingStoredCredentialSource(store, {
      name: this.name,
      refresh: this.#refresh,
    });
  }

  async resolve(request: CredentialRequest): Promise<AuthCredential | undefined> {
    request.signal?.throwIfAborted();
    if (!isCredentialProfileMetadataStore(this.#store)) return this.#legacy.resolve(request);
    const active = await new CredentialProfileManager(this.#store, request.provider).active();
    request.signal?.throwIfAborted();
    if (!active.configured) return undefined;
    if (active.fallbackSelected === true) return undefined;
    if (active.name === undefined) {
      throw new Error(`No active credential profile is selected for ${request.provider}`);
    }
    if (active.credential === undefined || active.storageId === undefined) {
      throw new Error(`Active credential profile is missing for ${request.provider}`);
    }
    if (active.credential.kind !== "oauth") return active.credential;
    return new OAuthRefreshCoordinator({ store: this.#store, refresh: this.#refresh }).getValid(active.storageId, {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  }
}

export class ExplicitCredentialSource implements CredentialSource {
  readonly name: string;
  readonly #credentials: ReadonlyMap<AuthProviderId, AuthCredential>;

  constructor(credentials: ReadonlyMap<AuthProviderId, AuthCredential>, name = "explicit") {
    this.#credentials = new Map(credentials);
    this.name = name;
  }

  async resolve(request: CredentialRequest): Promise<AuthCredential | undefined> {
    request.signal?.throwIfAborted();
    return this.#credentials.get(request.provider);
  }
}

export interface ExternalCommandCredentialSpec {
  argv: readonly [string, ...string[]];
  environment?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Zero disables caching. Defaults to 60 seconds and is capped at one hour. */
  cacheTtlMs?: number;
}

interface CachedExternalCredential {
  credential: Exclude<AuthCredential, OAuthCredential | AmbientCredentialDescriptor>;
  freshUntil: number;
}

function validateExternalCommandSpec(provider: string, spec: ExternalCommandCredentialSpec): void {
  assertCredentialId(provider);
  if (
    !Array.isArray(spec.argv) || spec.argv.length < 1 || spec.argv.length > 32 ||
    spec.argv.some((entry) => typeof entry !== "string" || entry === "" || entry.includes("\0") || Buffer.byteLength(entry, "utf8") > 4096)
  ) throw new TypeError(`External credential command for ${provider} must contain 1 through 32 bounded arguments`);
  if (spec.environment !== undefined && (
    Object.keys(spec.environment).length > 64 ||
    Object.entries(spec.environment).some(([name, value]) =>
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > 16 * 1024)
  )) throw new TypeError(`External credential command environment for ${provider} is invalid`);
  for (const [label, value, maximum] of [
    ["timeoutMs", spec.timeoutMs, 60_000],
    ["maxOutputBytes", spec.maxOutputBytes, 64 * 1024],
    ["cacheTtlMs", spec.cacheTtlMs, 60 * 60_000],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < (label === "cacheTtlMs" ? 0 : 1) || value > maximum)) {
      throw new TypeError(`External credential command ${label} for ${provider} must be an integer from ${label === "cacheTtlMs" ? 0 : 1} through ${maximum}`);
    }
  }
}

/** Resolves explicitly configured argv-only credential helpers with bounded in-memory caching. */
export class ExternalCommandCredentialSource implements CredentialSource {
  readonly name: string;
  #specs: ReadonlyMap<AuthProviderId, ExternalCommandCredentialSpec> = new Map();
  readonly #cache = new Map<AuthProviderId, CachedExternalCredential>();
  readonly #now: () => number;

  constructor(
    specs: Readonly<Record<AuthProviderId, ExternalCommandCredentialSpec>> | ReadonlyMap<AuthProviderId, ExternalCommandCredentialSpec>,
    options?: { name?: string; now?: () => number },
  ) {
    this.name = options?.name ?? "external-command";
    this.#now = options?.now ?? Date.now;
    this.replaceSpecs(specs);
  }

  /** Atomically replaces the active configuration and drops cached credentials. */
  replaceSpecs(
    specs: Readonly<Record<AuthProviderId, ExternalCommandCredentialSpec>> | ReadonlyMap<AuthProviderId, ExternalCommandCredentialSpec>,
  ): void {
    const entries = specs instanceof Map ? [...specs] : Object.entries(specs);
    if (entries.length > 128) throw new TypeError("At most 128 external credential commands may be configured");
    for (const [provider, spec] of entries) validateExternalCommandSpec(provider, spec);
    this.#specs = new Map(entries);
    this.#cache.clear();
  }

  async resolve(request: CredentialRequest): Promise<AuthCredential | undefined> {
    request.signal?.throwIfAborted();
    const spec = this.#specs.get(request.provider);
    if (spec === undefined) return undefined;
    const now = this.#now();
    const cached = this.#cache.get(request.provider);
    if (cached !== undefined && cached.freshUntil > now) return { ...cached.credential };
    this.#cache.delete(request.provider);
    const credential = await resolveExternalCommandCredential({
      provider: request.provider,
      argv: spec.argv,
      ...(spec.environment === undefined ? {} : { environment: spec.environment }),
      ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      ...(spec.maxOutputBytes === undefined ? {} : { maxOutputBytes: spec.maxOutputBytes }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    request.signal?.throwIfAborted();
    const configuredFreshUntil = now + (spec.cacheTtlMs ?? 60_000);
    const credentialFreshUntil = credential.kind === "bearer" && credential.expiresAt !== undefined
      ? credential.expiresAt - 60_000
      : Number.POSITIVE_INFINITY;
    const freshUntil = Math.min(configuredFreshUntil, credentialFreshUntil);
    if (freshUntil > now) this.#cache.set(request.provider, { credential, freshUntil });
    return { ...credential };
  }
}

export interface EnvironmentCredentialSpec {
  variable: string;
  /** Older or provider-specific aliases, checked after `variable` in declaration order. */
  aliases?: readonly string[];
  kind?: "api_key" | "bearer";
}

export function environmentCredentialVariables(spec: EnvironmentCredentialSpec): readonly string[] {
  return [spec.variable, ...(spec.aliases ?? [])];
}

export function resolvedEnvironmentCredentialVariable(
  spec: EnvironmentCredentialSpec,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  return environmentCredentialVariables(spec).find((variable) => {
    const secret = environment[variable];
    return secret !== undefined && secret.length > 0;
  });
}

export const DEFAULT_ENVIRONMENT_CREDENTIALS: Readonly<Record<string, EnvironmentCredentialSpec>> = {
  openai: { variable: "OPENAI_API_KEY" },
  "azure-openai": { variable: "AZURE_OPENAI_API_KEY" },
  anthropic: { variable: "ANTHROPIC_API_KEY" },
  "github-copilot": { variable: "COPILOT_GITHUB_TOKEN" },
  gemini: { variable: "GEMINI_API_KEY" },
  bedrock: { variable: "AWS_BEARER_TOKEN_BEDROCK", kind: "bearer" },
  openrouter: { variable: "OPENROUTER_API_KEY" },
  mistral: { variable: "MISTRAL_API_KEY" },
  ollama: { variable: "OLLAMA_API_KEY" },
  "llama.cpp": { variable: "LLAMA_API_KEY" },
  groq: { variable: "GROQ_API_KEY" },
  together: { variable: "TOGETHER_API_KEY" },
  deepseek: { variable: "DEEPSEEK_API_KEY" },
  cerebras: { variable: "CEREBRAS_API_KEY" },
  xai: { variable: "XAI_API_KEY" },
  fireworks: { variable: "FIREWORKS_API_KEY" },
  huggingface: { variable: "HF_TOKEN" },
  "vercel-ai-gateway": { variable: "AI_GATEWAY_API_KEY" },
  zai: { variable: "ZAI_API_KEY" },
  "zai-coding-cn": { variable: "ZAI_CODING_CN_API_KEY" },
  "ant-ling": { variable: "ANT_LING_API_KEY" },
  nvidia: { variable: "NVIDIA_API_KEY" },
  xiaomi: { variable: "MIMO_API_KEY", aliases: ["XIAOMI_API_KEY"] },
  moonshotai: { variable: "MOONSHOT_API_KEY" },
  "moonshotai-cn": { variable: "MOONSHOT_API_KEY" },
  "xiaomi-token-plan-cn": { variable: "XIAOMI_TOKEN_PLAN_CN_API_KEY" },
  "xiaomi-token-plan-ams": { variable: "XIAOMI_TOKEN_PLAN_AMS_API_KEY" },
  "xiaomi-token-plan-sgp": { variable: "XIAOMI_TOKEN_PLAN_SGP_API_KEY" },
  opencode: { variable: "OPENCODE_API_KEY" },
  "opencode-go": { variable: "OPENCODE_API_KEY" },
  "kimi-coding": { variable: "KIMI_API_KEY" },
  minimax: { variable: "MINIMAX_API_KEY" },
  "minimax-cn": { variable: "MINIMAX_CN_API_KEY" },
  "cloudflare-ai-gateway": { variable: "CLOUDFLARE_API_KEY" },
  "cloudflare-workers-ai": { variable: "CLOUDFLARE_API_KEY" },
};

export class EnvironmentCredentialSource implements CredentialSource {
  readonly name: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #specs: Readonly<Record<string, EnvironmentCredentialSpec>>;

  constructor(options?: {
    environment?: NodeJS.ProcessEnv;
    specs?: Readonly<Record<string, EnvironmentCredentialSpec>>;
    name?: string;
  }) {
    this.#environment = options?.environment ?? process.env;
    this.#specs = options?.specs ?? DEFAULT_ENVIRONMENT_CREDENTIALS;
    this.name = options?.name ?? "environment";
  }

  async resolve(request: CredentialRequest): Promise<AuthCredential | undefined> {
    request.signal?.throwIfAborted();
    if (!Object.hasOwn(this.#specs, request.provider)) return undefined;
    const spec = this.#specs[request.provider];
    if (spec === undefined) return undefined;
    const variable = resolvedEnvironmentCredentialVariable(spec, this.#environment);
    if (variable === undefined) return undefined;
    const secret = this.#environment[variable]!;
    return spec.kind === "bearer"
      ? { kind: "bearer", provider: request.provider, accessToken: secret }
      : { kind: "api_key", provider: request.provider, apiKey: secret };
  }
}
