import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderAuthRegistry,
  revokeGenericOAuthWithFetch,
  type AuthCredential,
  type CredentialStore,
  type OAuthCredential,
} from "../../src/auth/index.js";
import { parseHarnessConfig } from "../../src/config/schema.js";

class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, AuthCredential>();
  async read(id: string): Promise<AuthCredential | undefined> { return this.values.get(id); }
  async write(id: string, credential: AuthCredential): Promise<void> { this.values.set(id, credential); }
  async delete(id: string): Promise<void> { this.values.delete(id); }
  async withLock<T>(_id: string, operation: () => Promise<T>): Promise<T> { return operation(); }
}

function credential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    kind: "oauth",
    provider: "fixture",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: Date.now() + 60_000,
    tokenType: "Bearer",
    scopes: ["models.read"],
    tokenEndpoint: "https://issuer.example/token",
    revocationEndpoint: "https://issuer.example/revoke",
    clientId: "public-client",
    ...overrides,
  };
}

test("RFC 7009 revocation prefers refresh tokens, disables redirects, and ignores a success body", async () => {
  let form: URLSearchParams | undefined;
  let redirect: RequestRedirect | undefined;
  const result = await revokeGenericOAuthWithFetch(credential(), (async (_input, init) => {
    form = new URLSearchParams(String(init?.body));
    redirect = init?.redirect;
    return new Response("not-json-but-irrelevant", { status: 200 });
  }) as typeof fetch);
  assert.deepEqual(Object.fromEntries(form ?? []), {
    token: "refresh-secret",
    token_type_hint: "refresh_token",
    client_id: "public-client",
  });
  assert.equal(redirect, "error");
  assert.deepEqual(result, { tokenTypeHint: "refresh_token" });
});

test("remote logout deletes locally only after confirmed revocation and reports unsupported issuers", async () => {
  const store = new MemoryCredentialStore();
  store.values.set("fixture", credential());
  const registry = new ProviderAuthRegistry({
    bindings: [{ providerId: "fixture", credentialId: "fixture", displayName: "Fixture" }],
    store,
    environment: {},
  });

  await assert.rejects(registry.logout("fixture", {
    revokeRemote: true,
    fetch: (async () => new Response(JSON.stringify({ error: "bad\u001b[31mvalue" }), { status: 503 })) as typeof fetch,
  }), (error: unknown) => error instanceof Error &&
    /503 revocation_failed/u.test(error.message) &&
    !error.message.includes("\u001b"));
  assert.equal(store.values.has("fixture"), true);

  const revoked = await registry.logout("fixture", {
    revokeRemote: true,
    fetch: (async () => new Response(null, { status: 200 })) as typeof fetch,
  });
  assert.equal(revoked.remoteRevocation, "revoked");
  assert.equal(revoked.removedStored, true);
  assert.equal(store.values.has("fixture"), false);

  const withoutRevocation = credential();
  delete withoutRevocation.revocationEndpoint;
  store.values.set("fixture", withoutRevocation);
  const unsupported = await registry.logout("fixture", { revokeRemote: true });
  assert.equal(unsupported.remoteRevocation, "unsupported");
  assert.equal(store.values.has("fixture"), false);
});

test("OAuth revocation endpoints are validated and persisted from trusted configuration", () => {
  const config = parseHarnessConfig({
    oauthRegistrations: {
      workforce: {
        provider: "fixture",
        flow: "pkce",
        clientId: "public-client",
        authorizationEndpoint: "https://issuer.example/authorize",
        tokenEndpoint: "https://issuer.example/token",
        revocationEndpoint: "https://issuer.example/revoke",
        scopes: ["models.read"],
      },
    },
  });
  assert.equal(config.oauthRegistrations.workforce?.revocationEndpoint, "https://issuer.example/revoke");
  assert.throws(() => parseHarnessConfig({
    oauthRegistrations: {
      workforce: {
        provider: "fixture",
        flow: "pkce",
        clientId: "public-client",
        authorizationEndpoint: "https://issuer.example/authorize",
        tokenEndpoint: "https://issuer.example/token",
        revocationEndpoint: "http://issuer.example/revoke",
        scopes: [],
      },
    },
  }), /revocationEndpoint must use HTTPS/u);
});
