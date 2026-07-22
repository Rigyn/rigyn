import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeOAuthRegistration,
  parseManualAuthorization,
  type OAuthRegistrationConfig,
} from "../../src/auth/index.js";

test("manual OAuth accepts a state-checked loopback callback and uses the same PKCE exchange", async () => {
  const registration: OAuthRegistrationConfig = {
    provider: "public-provider",
    flow: "pkce",
    clientId: "public-client",
    authorizationEndpoint: "https://identity.example.test/authorize",
    tokenEndpoint: "https://identity.example.test/token",
    scopes: ["models.read"],
  };
  let exchange: URLSearchParams | undefined;
  const credential = await authorizeOAuthRegistration(registration, "shared-account", {
    showAuthorization() {},
    async requestManualAuthorization(input) {
      const callback = new URL(input.redirectUri);
      callback.searchParams.set("code", "manual-code");
      callback.searchParams.set("state", input.state);
      return callback.toString();
    },
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      exchange = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify({
        access_token: "manual-access",
        refresh_token: "manual-refresh",
        token_type: "Bearer",
        expires_in: 600,
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });

  assert.equal(credential.provider, "shared-account");
  assert.equal(credential.accessToken, "manual-access");
  assert.equal(exchange?.get("code"), "manual-code");
  assert.ok((exchange?.get("code_verifier")?.length ?? 0) >= 43);
  assert.match(exchange?.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:/u);
});

test("manual OAuth parsing rejects callback substitution and bad state but permits an explicit raw code", () => {
  const expected = { redirectUri: "http://127.0.0.1:4321/oauth/callback", state: "expected-state" };
  assert.deepEqual(parseManualAuthorization("raw-code_123", expected), {
    code: "raw-code_123",
    state: "expected-state",
  });
  assert.throws(
    () => parseManualAuthorization("http://127.0.0.1:9999/oauth/callback?code=x&state=expected-state", expected),
    /does not match/u,
  );
  assert.throws(
    () => parseManualAuthorization("http://127.0.0.1:4321/oauth/callback?code=x&state=wrong", expected),
    /state is invalid/u,
  );
});
