import type { ModelInfo } from "../core/types.js";
import type {
  ProviderManagedOAuthAuthMethod,
  ProviderManagedOAuthCredential,
} from "./provider-descriptor.js";
import { defaultSecretRedactor } from "./redaction.js";
import type { OAuthRefreshResult } from "./refresh.js";
import { assertAuthCredential, type OAuthCredential } from "./types.js";

const FLOW_KEY = "managedFlow";

interface ManagedLayer {
  token: symbol;
  provider: string;
  credentialId: string;
  method: ProviderManagedOAuthAuthMethod;
}

function managedCredentialInput(credential: OAuthCredential): ProviderManagedOAuthCredential {
  const providerData = { ...(credential.providerData ?? {}) };
  delete providerData[FLOW_KEY];
  return {
    accessToken: credential.accessToken,
    ...(credential.refreshToken === undefined ? {} : { refreshToken: credential.refreshToken }),
    expiresAt: credential.expiresAt,
    tokenType: "Bearer",
    scopes: [...credential.scopes],
    ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
    ...(credential.subject === undefined ? {} : { subject: credential.subject }),
    ...(Object.keys(providerData).length === 0 ? {} : { providerData }),
  };
}

export function normalizeManagedOAuthCredential(
  credentialId: string,
  methodId: string,
  value: ProviderManagedOAuthCredential,
  previous?: OAuthCredential,
): OAuthCredential {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Managed provider authentication returned an invalid credential");
  }
  const refreshToken = value.refreshToken ?? previous?.refreshToken;
  if (refreshToken === undefined || refreshToken === "") {
    throw new TypeError("Managed provider authentication must return a refresh token");
  }
  const providerData = { ...(value.providerData ?? {}), [FLOW_KEY]: methodId };
  const accountId = value.accountId ?? previous?.accountId;
  const subject = value.subject ?? previous?.subject;
  const credential: OAuthCredential = {
    kind: "oauth",
    provider: credentialId,
    accessToken: value.accessToken,
    refreshToken,
    expiresAt: value.expiresAt,
    tokenType: value.tokenType ?? "Bearer",
    scopes: [...(value.scopes ?? previous?.scopes ?? [])],
    ...(accountId === undefined ? {} : { accountId }),
    ...(subject === undefined ? {} : { subject }),
    providerData,
  };
  assertAuthCredential(credential);
  if (credential.expiresAt <= Date.now()) {
    throw new TypeError("Managed provider authentication returned an expired credential");
  }
  defaultSecretRedactor.register(credential.accessToken);
  defaultSecretRedactor.register(credential.refreshToken);
  return credential;
}

/** Generation-stacked callback registry used by refresh and brokered requests. */
export class ManagedProviderAuthDirectory {
  readonly #layers: ManagedLayer[] = [];

  register(provider: string, credentialId: string, method: ProviderManagedOAuthAuthMethod): () => void {
    const layer = { token: Symbol(method.id), provider, credentialId, method };
    this.#layers.push(layer);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = this.#layers.findIndex((entry) => entry.token === layer.token);
      if (index >= 0) this.#layers.splice(index, 1);
    };
  }

  #findByCredential(credential: OAuthCredential): ManagedLayer | undefined {
    const methodId = credential.providerData?.[FLOW_KEY];
    for (let index = this.#layers.length - 1; index >= 0; index -= 1) {
      const layer = this.#layers[index]!;
      if (layer.credentialId !== credential.provider) continue;
      if (methodId === undefined || layer.method.id === methodId) return layer;
    }
    return undefined;
  }

  #findByProvider(provider: string, credential: OAuthCredential): ManagedLayer | undefined {
    const methodId = credential.providerData?.[FLOW_KEY];
    for (let index = this.#layers.length - 1; index >= 0; index -= 1) {
      const layer = this.#layers[index]!;
      if (layer.provider !== provider || layer.credentialId !== credential.provider) continue;
      if (methodId === undefined || layer.method.id === methodId) return layer;
    }
    return undefined;
  }

  canRefresh(credential: OAuthCredential): boolean {
    return this.#findByCredential(credential) !== undefined;
  }

  async refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthRefreshResult | undefined> {
    const layer = this.#findByCredential(credential);
    if (layer === undefined) return undefined;
    const selectedSignal = signal ?? new AbortController().signal;
    selectedSignal.throwIfAborted();
    const value = await layer.method.refresh(managedCredentialInput(credential), selectedSignal);
    selectedSignal.throwIfAborted();
    const normalized = normalizeManagedOAuthCredential(layer.credentialId, layer.method.id, value, credential);
    return {
      accessToken: normalized.accessToken,
      expiresAt: normalized.expiresAt,
      ...(normalized.refreshToken === undefined ? {} : { refreshToken: normalized.refreshToken }),
      tokenType: normalized.tokenType,
      scopes: normalized.scopes,
      ...(normalized.accountId === undefined ? {} : { accountId: normalized.accountId }),
      ...(normalized.subject === undefined ? {} : { subject: normalized.subject }),
      ...(normalized.providerData === undefined ? {} : { providerData: normalized.providerData }),
    };
  }

  apiKey(provider: string, credential: OAuthCredential): string | undefined {
    const layer = this.#findByProvider(provider, credential);
    if (layer?.method.getApiKey === undefined) return undefined;
    const value = layer.method.getApiKey(managedCredentialInput(credential));
    if (
      typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > 64 * 1024 ||
      /[\x00-\x1f\x7f]/u.test(value)
    ) throw new TypeError("Managed provider authentication returned an invalid API key projection");
    defaultSecretRedactor.register(value);
    return value;
  }

  async modifyModels(
    provider: string,
    models: readonly ModelInfo[],
    credential: OAuthCredential,
    signal: AbortSignal,
  ): Promise<ModelInfo[]> {
    const layer = this.#findByProvider(provider, credential);
    if (layer?.method.modifyModels === undefined) return structuredClone([...models]);
    signal.throwIfAborted();
    const projected = await layer.method.modifyModels(
      structuredClone([...models]),
      managedCredentialInput(credential),
      signal,
    );
    signal.throwIfAborted();
    if (!Array.isArray(projected)) throw new TypeError("Managed provider model projection must return an array");
    return structuredClone([...projected]);
  }
}
