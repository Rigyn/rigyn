import type { AssistantMessage, Context } from "./content-messages.js";
import type {
  Api,
  ApiStreamOptions,
  AssistantMessageEventStream,
  Model,
  ModelsApiStreamOptions,
  ModelsSimpleStreamOptions,
  ProviderHeaders,
  SimpleStreamOptions,
} from "./models-sampling-streaming.js";

export interface ApiKeyCredential {
  type: "api_key";
  key?: string;
  env?: Record<string, string>;
}

export interface OAuthCredentials {
  type?: "oauth";
  access: string;
  refresh: string;
  expires: number;
  [name: string]: unknown;
}

export type Credential = ApiKeyCredential | (OAuthCredentials & { type: "oauth" });
export type ProviderApiKeyCredential = ApiKeyCredential;
export type OAuthCredential = OAuthCredentials & { type: "oauth" };
export type AuthType = "api_key" | "oauth";

export interface CredentialInfo {
  providerId: string;
  type: AuthType;
  expires?: number;
}

export interface CredentialStore {
  read(provider: string): Promise<Credential | undefined>;
  list(): Promise<readonly CredentialInfo[]>;
  modify(
    provider: string,
    update: (current: Credential | undefined) => Credential | undefined | Promise<Credential | undefined>,
    signal?: AbortSignal,
  ): Promise<Credential | undefined>;
  delete(provider: string): Promise<void>;
}

export interface AuthContext {
  env(name: string): Promise<string | undefined>;
  fileExists(path: string): Promise<boolean>;
  credentials?: CredentialStore;
  provider?: string | undefined;
  now?: (() => number) | undefined;
  fetch?: typeof globalThis.fetch | undefined;
}

export interface OAuthLoginCallbacks {
  onAuth(input: { url: string; instructions?: string }): void | Promise<void>;
  onDeviceCode?(input: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }): void | Promise<void>;
  onPrompt(input: { message: string; placeholder?: string; allowEmpty?: boolean }): string | Promise<string>;
  onProgress?(message: string): void | Promise<void>;
  onManualCodeInput?(): string | Promise<string>;
  onSelect?(input: { message: string; options: readonly { id: string; label: string }[] }): string | undefined | Promise<string | undefined>;
  signal?: AbortSignal;
}

export type AuthPrompt =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string; allowEmpty?: boolean }
  | { type: "select"; message: string; options: readonly { id: string; label: string }[] };

export type AuthNotification =
  | { type: "info" | "progress"; message: string }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number };

export interface AuthInteraction {
  prompt(input: AuthPrompt): Promise<string>;
  notify(input: AuthNotification): void | Promise<void>;
  signal?: AbortSignal;
}

export type AuthCheck =
  | { ok: true; type: AuthType; message?: string }
  | { ok: false; message: string };

export interface ResolvedAuth {
  apiKey?: string;
  headers?: ProviderHeaders;
  baseUrl?: string;
}

export interface AuthResult {
  auth: ResolvedAuth;
  source?: string;
  env?: Record<string, string>;
}

export interface ProviderAuthCheck {
  type: AuthType;
  message?: string;
}

export interface ApiKeyAuth {
  name: string;
  login?(interaction: AuthInteraction): Promise<ApiKeyCredential>;
  check?(input: { ctx: AuthContext; credential?: ApiKeyCredential }): Promise<ProviderAuthCheck | undefined>;
  resolve(input: { ctx: AuthContext; credential?: ApiKeyCredential }): Promise<AuthResult | undefined>;
}

export interface OAuthAuth {
  name: string;
  loginLabel?: string;
  login(interaction: AuthInteraction): Promise<OAuthCredentials>;
  refresh(credential: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials>;
  toAuth(credential: OAuthCredentials): Promise<ResolvedAuth>;
}

/** Interactive account acquisition that stores the credential returned by the provider unchanged. */
export interface ProviderAccountAuth {
  name: string;
  loginLabel?: string;
  login(interaction: AuthInteraction): Promise<Credential>;
}

export interface ProviderAuth {
  apiKey?: ApiKeyAuth;
  oauth?: OAuthAuth;
  providerAccount?: ProviderAccountAuth;
}

export type AuthMethod = ApiKeyAuth | OAuthAuth | ProviderAccountAuth;

export interface ProviderCatalogCacheEntry {
  models: readonly Model[];
  checkedAt?: number;
  etag?: string;
}

export interface ProviderCatalogStore {
  read(): Promise<ProviderCatalogCacheEntry | undefined>;
  write(entry: ProviderCatalogCacheEntry): Promise<void>;
  delete(): Promise<void>;
}

export interface RefreshModelsContext {
  credential?: Credential;
  store: ProviderCatalogStore;
  allowNetwork: boolean;
  force?: boolean;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export interface Provider<TApi extends Api = Api> {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  headers?: ProviderHeaders;
  readonly auth: ProviderAuth;
  getModels(): readonly Model<TApi>[];
  refreshModels?(context: RefreshModelsContext): Promise<void>;
  filterModels?(models: readonly Model<TApi>[], credential?: Credential): readonly Model<TApi>[];
  stream<T extends TApi>(model: Model<T>, context: Context, options?: ApiStreamOptions<T>): AssistantMessageEventStream;
  streamSimple(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

export interface ModelsRefreshOptions {
  provider?: string;
  signal?: AbortSignal;
  allowNetwork?: boolean;
  force?: boolean;
}

export interface ModelsRefreshResult {
  models?: readonly Model[];
  errors: ReadonlyMap<string, Error>;
  aborted: boolean;
}

export interface ModelsStreamTransforms {
  context?: (context: Context, model?: Model) => Context;
  options?: (options: ModelsSimpleStreamOptions, model?: Model) => ModelsSimpleStreamOptions;
  events?: (events: AssistantMessageEventStream, model?: Model) => AssistantMessageEventStream;
  transformHeaders?: (headers: ProviderHeaders, model?: Model) => ProviderHeaders;
}

export interface Models {
  getProviders(): readonly Provider[];
  getProvider(providerId: string): Provider | undefined;
  getModels(providerId?: string): readonly Model[];
  getModel(providerId: string, modelId: string): Model | undefined;
  getAvailable(providerId?: string): Promise<readonly Model[]>;
  getAvailableSnapshot(): readonly Model[];
  checkAuth(providerId: string): Promise<AuthCheck | undefined>;
  stream<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): AssistantMessageEventStream;
  complete<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): Promise<AssistantMessage>;
  streamSimple(model: Model, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
  completeSimple(model: Model, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage>;
  login(providerId: string, type: AuthType | "provider_account", interaction: AuthInteraction): Promise<Credential>;
  logout(providerId: string): Promise<void>;
  refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
}

export interface MutableModels extends Models {
  setProvider(provider: Provider): void;
  removeProvider(providerId: string): boolean;
}
