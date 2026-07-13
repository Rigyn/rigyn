import assert from "node:assert/strict";
import test from "node:test";

import { createLoopbackAuthorization } from "../../src/auth/loopback.js";
import {
  base64UrlSha256,
  createOAuthState,
  createPkcePair,
  verifyS256Challenge,
} from "../../src/auth/pkce.js";

test("creates RFC 7636 S256 challenges", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  assert.equal(base64UrlSha256(verifier), expected);
  assert.equal(verifyS256Challenge(verifier, expected), true);
  assert.equal(verifyS256Challenge(`${verifier}x`, expected), false);

  const pair = createPkcePair();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(pair.challenge, base64UrlSha256(pair.verifier));
  assert.equal(pair.method, "S256");
  assert.match(createOAuthState(), /^[A-Za-z0-9_-]{43}$/);
});

test("loopback flow ignores invalid state and resolves a valid callback", async () => {
  const session = await createLoopbackAuthorization({
    authorizationEndpoint: "https://issuer.example/authorize",
    clientId: "our-public-client",
    scopes: ["openid", "profile"],
    timeoutMs: 5_000,
  });
  const authUrl = session.authorizationUrl;
  assert.equal(authUrl.searchParams.get("client_id"), "our-public-client");
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authUrl.searchParams.get("state"), session.state);

  const invalid = new URL(session.redirectUri);
  invalid.searchParams.set("state", "wrong");
  invalid.searchParams.set("code", "attack-code");
  assert.equal((await fetch(invalid)).status, 400);

  const valid = new URL(session.redirectUri);
  valid.searchParams.set("state", session.state);
  valid.searchParams.set("code", "valid-code");
  assert.equal((await fetch(valid)).status, 200);
  assert.deepEqual(await session.waitForCallback(), { code: "valid-code", state: session.state });
});

test("loopback flow can be cancelled", async () => {
  const session = await createLoopbackAuthorization({
    authorizationEndpoint: "https://issuer.example/authorize",
    clientId: "our-public-client",
    scopes: [],
  });
  session.cancel(new Error("cancelled by test"));
  await assert.rejects(session.waitForCallback(), /cancelled by test/);
});

test("configured authorization parameters reject reserved OAuth protections", async () => {
  await assert.rejects(() => createLoopbackAuthorization({
    authorizationEndpoint: "https://issuer.example/authorize",
    clientId: "real-public-client",
    scopes: ["models.read"],
    extraParameters: { state: "attacker-state" },
  }), /authorization parameters are invalid/u);

  const session = await createLoopbackAuthorization({
    authorizationEndpoint: "https://issuer.example/authorize",
    clientId: "real-public-client",
    scopes: ["models.read"],
    extraParameters: {
      audience: "models",
    },
  });
  try {
    assert.equal(session.authorizationUrl.searchParams.get("audience"), "models");
    assert.equal(session.authorizationUrl.searchParams.get("state"), session.state);
    assert.equal(session.authorizationUrl.searchParams.get("client_id"), "real-public-client");
    assert.equal(session.authorizationUrl.searchParams.get("redirect_uri"), session.redirectUri);
    assert.match(session.authorizationUrl.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(session.authorizationUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(session.authorizationUrl.searchParams.get("response_type"), "code");
  } finally {
    session.cancel();
  }
});
