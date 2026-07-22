import assert from "node:assert/strict";
import test from "node:test";

import {
  CredentialBroker,
  createLoopbackAuthorization,
  createOpenRouterLoopback,
  exchangeAuthorizationCode,
  parseOAuthTokenResponse,
  ProviderAuthRegistry,
  type AuthCredential,
  type CredentialSource,
  type CredentialStore,
} from "../../src/auth/index.js";

class MemoryCredentialStore implements CredentialStore {
  async read(_id: string): Promise<AuthCredential | undefined> { return undefined; }
  async write(_id: string, _credential: AuthCredential): Promise<void> {}
  async delete(_id: string): Promise<void> {}
  async withLock<T>(_id: string, operation: () => Promise<T>): Promise<T> { return operation(); }
}

const exchangeInput = {
  tokenEndpoint: "https://issuer.example/token",
  clientId: "public-client",
  code: "authorization-code",
  redirectUri: "http://127.0.0.1:3210/oauth/callback",
  verifier: "a".repeat(43),
};

test("OAuth exchanges disable redirects and enforce a streaming response bound", async () => {
  let redirect: RequestRedirect | undefined;
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.alloc(40 * 1024, 0x61));
      controller.enqueue(Buffer.alloc(40 * 1024, 0x62));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(exchangeAuthorizationCode({
    ...exchangeInput,
    fetch: (async (_input, init) => {
      redirect = init?.redirect;
      return new Response(oversized);
    }) as typeof fetch,
  }), /exceeded configured limit/u);
  assert.equal(redirect, "error");
  assert.equal(cancelled, true);
});

test("OAuth exchanges have a cancellable module-level request timeout", async () => {
  await assert.rejects(exchangeAuthorizationCode({
    ...exchangeInput,
    timeoutMs: 5,
    fetch: (async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch,
  }), /timed out/u);
});

test("direct authorization-code exchange validates every secret-bearing input before fetch", async () => {
  let requests = 0;
  const fetchImplementation = (async () => {
    requests += 1;
    return new Response(JSON.stringify({ access_token: "safe-token" }));
  }) as typeof fetch;
  const invalid = [
    { ...exchangeInput, clientId: "bad\nclient" },
    { ...exchangeInput, code: "x".repeat(4097) },
    { ...exchangeInput, verifier: "too-short" },
    { ...exchangeInput, redirectUri: "https://attacker.example/callback" },
    { ...exchangeInput, extraParameters: { client_secret: "must-not-send" } },
    { ...exchangeInput, extraParameters: { grant_type: "attacker" } },
  ];
  for (const options of invalid) {
    await assert.rejects(exchangeAuthorizationCode({ ...options, fetch: fetchImplementation }), /invalid|loopback|parameters/u);
  }
  assert.equal(requests, 0);
});

test("loopback authorization timeouts require bounded whole milliseconds", async () => {
  for (const timeoutMs of [0.5, 30 * 60_000 + 1]) {
    await assert.rejects(() => createLoopbackAuthorization({
      authorizationEndpoint: "https://issuer.example/authorize",
      clientId: "public-client",
      scopes: [],
      timeoutMs,
    }), /integer between/u);
    await assert.rejects(() => createOpenRouterLoopback({ timeoutMs }), /between 1 ms and 30 minutes/u);
  }
});

test("OAuth token parsing rejects unsafe expiry, rotation, token type, and diagnostic fields", () => {
  for (const expiresIn of [-1, 0, Number.POSITIVE_INFINITY, 366 * 24 * 60 * 60 + 1]) {
    assert.throws(() => parseOAuthTokenResponse({ access_token: "safe-token", expires_in: expiresIn }, "fixture"), /expires_in/u);
  }
  assert.throws(
    () => parseOAuthTokenResponse({ access_token: "safe-token", refresh_token: "" }, "fixture"),
    /invalid token/u,
  );
  assert.throws(
    () => parseOAuthTokenResponse({ access_token: "safe-token", token_type: "DPoP" }, "fixture"),
    /unsupported token_type/u,
  );
  assert.throws(
    () => parseOAuthTokenResponse({ access_token: "line\nbreak" }, "fixture"),
    /invalid token/u,
  );
});

test("public registry registration rejects unvalidated secret-bearing and insecure JS input", () => {
  const store = new MemoryCredentialStore();
  assert.throws(() => new ProviderAuthRegistry({
    bindings: [],
    registrations: {
      unsafe: {
        provider: "fixture",
        flow: "pkce",
        clientId: "public-client",
        authorizationEndpoint: "http://issuer.example/authorize",
        tokenEndpoint: "https://issuer.example/token",
        scopes: [],
      },
    },
    store,
  }), /HTTPS or loopback/u);
  assert.throws(() => new ProviderAuthRegistry({
    bindings: [],
    registrations: {
      unsafe: {
        provider: "fixture",
        flow: "pkce",
        clientId: "public-client",
        authorizationEndpoint: "https://issuer.example/authorize",
        tokenEndpoint: "https://issuer.example/token",
        scopes: [],
        clientSecret: "must-not-enter-config",
      } as never,
    },
    store,
  }), /unknown keys/u);
});

test("credential broker rejects cross-provider and expired source results", async () => {
  const wrongProvider: CredentialSource = {
    name: "fixture",
    resolve: async () => ({ kind: "api_key", provider: "other", apiKey: "wrong-account-key" }),
  };
  await assert.rejects(
    new CredentialBroker([wrongProvider]).resolve({ provider: "expected" }),
    /different provider/u,
  );

  const expired: CredentialSource = {
    name: "fixture",
    resolve: async (request) => ({
      kind: "bearer",
      provider: request.provider,
      accessToken: "expired-access-token",
      expiresAt: 1,
    }),
  };
  await assert.rejects(
    new CredentialBroker([expired]).resolve({ provider: "expected" }),
    /expired; reauthentication is required/u,
  );
});

test("OpenRouter loopback accepts only one callback while its key exchange is pending", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let exchanges = 0;
  const session = await createOpenRouterLoopback({
    timeoutMs: 5_000,
    fetch: (async () => {
      exchanges += 1;
      await gate;
      return new Response(JSON.stringify({ key: "openrouter-user-key" }));
    }) as typeof fetch,
  });
  t.after(() => session.cancel());
  const callback = new URL(session.authorizationUrl.searchParams.get("callback_url")!);
  callback.searchParams.set("code", "one-time-code");
  assert.equal((await fetch(callback)).status, 200);
  assert.equal((await fetch(callback)).status, 409);
  release();
  assert.equal(await session.waitForKey(), "openrouter-user-key");
  assert.equal(exchanges, 1);
});
