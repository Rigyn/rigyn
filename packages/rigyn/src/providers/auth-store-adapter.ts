import {
  isMutableCredentialStore,
  type AuthCredential,
  type CredentialStore,
} from "../auth/types.js";
import type {
  ProviderCredential,
  ProviderCredentialInfo,
  ProviderCredentialStore,
  ProviderOAuthCredential,
} from "./models.js";

function toProviderCredential(credential: AuthCredential | undefined): ProviderCredential | undefined {
  if (credential === undefined || credential.kind === "ambient") return undefined;
  if (credential.kind === "api_key") return { type: "api_key", key: credential.apiKey };
  if (credential.kind === "bearer") return { type: "api_key", key: credential.accessToken };
  return {
    type: "oauth",
    access: credential.accessToken,
    refresh: credential.refreshToken ?? "",
    expires: credential.expiresAt,
    tokenType: credential.tokenType,
    scopes: credential.scopes,
    ...(credential.tokenEndpoint === undefined ? {} : { tokenEndpoint: credential.tokenEndpoint }),
    ...(credential.revocationEndpoint === undefined ? {} : { revocationEndpoint: credential.revocationEndpoint }),
    ...(credential.clientId === undefined ? {} : { clientId: credential.clientId }),
    ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
    ...(credential.subject === undefined ? {} : { subject: credential.subject }),
    ...(credential.providerData === undefined ? {} : { providerData: credential.providerData }),
  };
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every((entry): entry is [string, string] => typeof entry[1] === "string")
    ? Object.fromEntries(entries)
    : undefined;
}

function toHostCredential(provider: string, credential: ProviderCredential): AuthCredential {
  if (credential.type === "api_key") {
    if (credential.key === undefined) throw new TypeError(`Credential for ${provider} has no key`);
    return { kind: "api_key", provider, apiKey: credential.key };
  }
  const tokenType = typeof credential.tokenType === "string" ? credential.tokenType : "Bearer";
  const scopes = Array.isArray(credential.scopes)
    ? credential.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  const providerData = stringRecord(credential.providerData);
  return {
    kind: "oauth",
    provider,
    accessToken: credential.access,
    ...(credential.refresh === "" ? {} : { refreshToken: credential.refresh }),
    expiresAt: credential.expires,
    tokenType,
    scopes,
    ...(typeof credential.tokenEndpoint === "string" ? { tokenEndpoint: credential.tokenEndpoint } : {}),
    ...(typeof credential.revocationEndpoint === "string" ? { revocationEndpoint: credential.revocationEndpoint } : {}),
    ...(typeof credential.clientId === "string" ? { clientId: credential.clientId } : {}),
    ...(typeof credential.accountId === "string" ? { accountId: credential.accountId } : {}),
    ...(typeof credential.subject === "string" ? { subject: credential.subject } : {}),
    ...(providerData === undefined ? {} : { providerData }),
  };
}

/** Bridges Rigyn's durable auth store to the direct provider collection without exposing secrets. */
export class ProviderCredentialStoreAdapter implements ProviderCredentialStore {
  readonly #store: CredentialStore;

  constructor(store: CredentialStore) {
    if (!isMutableCredentialStore(store)) {
      throw new TypeError("Provider credential storage requires atomic modify and list operations");
    }
    this.#store = store;
  }

  async read(providerId: string): Promise<ProviderCredential | undefined> {
    return toProviderCredential(await this.#store.read(providerId));
  }

  async list(): Promise<readonly ProviderCredentialInfo[]> {
    if (!isMutableCredentialStore(this.#store)) return [];
    return (await this.#store.list()).map((entry) => ({
      providerId: entry.providerId,
      type: entry.type === "oauth" ? "oauth" : "api_key",
    }));
  }

  async modify(
    providerId: string,
    operation: (current: ProviderCredential | undefined) => Promise<ProviderCredential | undefined>,
  ): Promise<ProviderCredential | undefined> {
    if (!isMutableCredentialStore(this.#store)) return undefined;
    const result = await this.#store.modify(providerId, async (current) => {
      const replacement = await operation(toProviderCredential(current));
      return replacement === undefined ? undefined : toHostCredential(providerId, replacement);
    });
    return toProviderCredential(result);
  }

  async delete(providerId: string): Promise<void> {
    await this.#store.delete(providerId);
  }
}

export function providerOAuthCredential(credential: AuthCredential): ProviderOAuthCredential | undefined {
  const converted = toProviderCredential(credential);
  return converted?.type === "oauth" ? converted : undefined;
}
