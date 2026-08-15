import type { ProviderCredential } from "./models.js";

const scopes = new WeakMap<ProviderCredential, string>();

export function markProviderCredentialScope(
  credential: ProviderCredential | undefined,
  scope: string | undefined,
): ProviderCredential | undefined {
  if (credential !== undefined && scope !== undefined) scopes.set(credential, scope);
  return credential;
}

export function providerCredentialScope(credential: ProviderCredential | undefined): string | undefined {
  return credential === undefined ? undefined : scopes.get(credential);
}
