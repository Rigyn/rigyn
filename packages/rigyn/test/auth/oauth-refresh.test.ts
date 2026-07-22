import assert from "node:assert/strict";
import test from "node:test";

import { refreshGenericOAuthWithFetch, type OAuthCredential } from "../../src/auth/index.js";

test("generic OAuth refresh uses the runtime-scoped transport and preserves rotated fields", async () => {
  let endpoint = "";
  let form: URLSearchParams | undefined;
  const credential: OAuthCredential = {
    kind: "oauth",
    provider: "public-provider",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1,
    tokenType: "Bearer",
    scopes: ["models.read"],
    tokenEndpoint: "https://identity.example.test/token",
    clientId: "public-client",
  };

  const refreshed = await refreshGenericOAuthWithFetch(
    credential,
    undefined,
    (async (input: string | URL | Request, init?: RequestInit) => {
      endpoint = String(input);
      form = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 600,
        token_type: "Bearer",
        scope: "models.read models.write",
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  );

  assert.equal(endpoint, "https://identity.example.test/token");
  assert.deepEqual(Object.fromEntries(form ?? []), {
    grant_type: "refresh_token",
    client_id: "public-client",
    refresh_token: "old-refresh",
  });
  assert.equal(refreshed.accessToken, "new-access");
  assert.equal(refreshed.refreshToken, "new-refresh");
  assert.deepEqual(refreshed.scopes, ["models.read", "models.write"]);
  assert.ok(refreshed.expiresAt > Date.now());
});
