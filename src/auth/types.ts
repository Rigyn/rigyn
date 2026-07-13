export type AuthProviderId = string;

export interface ApiKeyCredential {
  kind: "api_key";
  provider: AuthProviderId;
  apiKey: string;
  accountId?: string;
}

export interface BearerCredential {
  kind: "bearer";
  provider: AuthProviderId;
  accessToken: string;
  expiresAt?: number;
  accountId?: string;
  subject?: string;
}

export interface OAuthCredential {
  kind: "oauth";
  provider: AuthProviderId;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType: string;
  scopes: string[];
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  clientId?: string;
  accountId?: string;
  subject?: string;
  providerData?: Record<string, string>;
}

export type AmbientProvider = "aws" | "google" | "azure";

export interface AmbientCredentialDescriptor {
  kind: "ambient";
  provider: AmbientProvider;
  mechanism: "aws_default_chain" | "google_adc" | "azure_default_credential";
  hints: Readonly<Record<string, string | boolean>>;
}

export type AuthCredential =
  | ApiKeyCredential
  | BearerCredential
  | OAuthCredential
  | AmbientCredentialDescriptor;

export interface ResolvedCredential {
  credential: AuthCredential;
  source: string;
}

export interface CredentialRequest {
  provider: AuthProviderId;
  signal?: AbortSignal;
}

export interface CredentialSource {
  readonly name: string;
  resolve(request: CredentialRequest): Promise<AuthCredential | undefined>;
}

export interface CredentialStore {
  read(id: string): Promise<AuthCredential | undefined>;
  write(id: string, credential: AuthCredential): Promise<void>;
  delete(id: string): Promise<void>;
  withLock<T>(id: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface CredentialProfileMetadataStore extends CredentialStore {
  readCredentialProfileIndex(id: string): Promise<unknown | undefined>;
  writeCredentialProfileIndex(id: string, value: unknown): Promise<void>;
  deleteCredentialProfileIndex(id: string): Promise<void>;
}

export function isCredentialProfileMetadataStore(
  store: CredentialStore,
): store is CredentialProfileMetadataStore {
  const candidate = store as Partial<CredentialProfileMetadataStore>;
  return (
    typeof candidate.readCredentialProfileIndex === "function" &&
    typeof candidate.writeCredentialProfileIndex === "function" &&
    typeof candidate.deleteCredentialProfileIndex === "function"
  );
}

export function assertCredentialId(id: string): void {
  if (
    id.length === 0 ||
    id.includes("\0") ||
    /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(id) ||
    Buffer.byteLength(id, "utf8") > 512 ||
    id === "__proto__" ||
    id === "prototype" ||
    id === "constructor"
  ) {
    throw new TypeError("Credential id is invalid");
  }
}

export function credentialSecrets(credential: AuthCredential): string[] {
  switch (credential.kind) {
    case "api_key":
      return [credential.apiKey];
    case "bearer":
      return [credential.accessToken];
    case "oauth":
      return credential.refreshToken === undefined
        ? [credential.accessToken]
        : [credential.accessToken, credential.refreshToken];
    case "ambient":
      return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number, optional = true): boolean {
  return (
    (optional && value === undefined) ||
    (typeof value === "string" &&
      value !== "" &&
      Buffer.byteLength(value, "utf8") <= maximum &&
      !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value))
  );
}

function knownKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).every((name) => names.includes(name));
}

function credentialProvider(value: unknown): boolean {
  return boundedText(value, 512, false) &&
    value !== "__proto__" &&
    value !== "prototype" &&
    value !== "constructor";
}

function oauthEndpoint(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > 16 * 1024) return false;
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return false;
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
  return (
    (endpoint.protocol === "https:" || (endpoint.protocol === "http:" && loopback)) &&
    endpoint.username === "" &&
    endpoint.password === "" &&
    endpoint.hash === ""
  );
}

export function isAuthCredential(value: unknown): value is AuthCredential {
  if (!isRecord(value) || typeof value.kind !== "string" || !credentialProvider(value.provider)) {
    return false;
  }
  if (!boundedText(value.accountId, 4096) || !boundedText(value.subject, 4096)) return false;
  switch (value.kind) {
    case "api_key":
      return knownKeys(value, ["kind", "provider", "apiKey", "accountId"]) &&
        boundedText(value.apiKey, 64 * 1024, false);
    case "bearer":
      return (
        knownKeys(value, ["kind", "provider", "accessToken", "expiresAt", "accountId", "subject"]) &&
        boundedText(value.accessToken, 48 * 1024, false) &&
        !/\s/u.test(value.accessToken as string) &&
        (value.expiresAt === undefined ||
          (typeof value.expiresAt === "number" && Number.isSafeInteger(value.expiresAt)))
      );
    case "oauth":
      return (
        knownKeys(value, [
          "kind", "provider", "accessToken", "refreshToken", "expiresAt", "tokenType", "scopes",
          "tokenEndpoint", "revocationEndpoint", "clientId", "accountId", "subject", "providerData",
        ]) &&
        boundedText(value.accessToken, 48 * 1024, false) &&
        !/\s/u.test(value.accessToken as string) &&
        boundedText(value.refreshToken, 48 * 1024) &&
        typeof value.expiresAt === "number" &&
        Number.isSafeInteger(value.expiresAt) &&
        typeof value.tokenType === "string" &&
        value.tokenType.toLowerCase() === "bearer" &&
        Array.isArray(value.scopes) &&
        value.scopes.length <= 256 &&
        value.scopes.every((scope) => boundedText(scope, 1024, false) && !/\s/u.test(scope as string)) &&
        oauthEndpoint(value.tokenEndpoint) &&
        oauthEndpoint(value.revocationEndpoint) &&
        boundedText(value.clientId, 4096) &&
        (value.providerData === undefined || (
          isRecord(value.providerData) &&
          Object.keys(value.providerData).length <= 16 &&
          Object.entries(value.providerData).every(([name, entry]) =>
            /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(name) &&
            !/secret|password|token/iu.test(name) &&
            boundedText(entry, 4096, false))
        ))
      );
    case "ambient": {
      if (!knownKeys(value, ["kind", "provider", "mechanism", "hints"]) || !isRecord(value.hints)) return false;
      if (
        Object.keys(value.hints).length > 64 ||
        !Object.entries(value.hints).every(([name, hint]) =>
          boundedText(name, 256, false) &&
          (typeof hint === "boolean" || boundedText(hint, 2048, false)))
      ) {
        return false;
      }
      return (
        (value.provider === "aws" && value.mechanism === "aws_default_chain") ||
        (value.provider === "google" && value.mechanism === "google_adc") ||
        (value.provider === "azure" && value.mechanism === "azure_default_credential")
      );
    }
    default:
      return false;
  }
}

export function assertAuthCredential(value: unknown): asserts value is AuthCredential {
  if (!isAuthCredential(value)) throw new TypeError("Credential has an invalid or unsupported shape");
}
