import assert from "node:assert/strict";
import test from "node:test";

import {
  CredentialBroker,
  createKimiCodingAuthDescriptor,
  createKimiCodingManagedOAuth,
  ExplicitCredentialSource,
  ProviderAuthRegistry,
  type AuthCredential,
  type CredentialStore,
  type ProviderManagedAuthInteraction,
} from "../../src/auth/index.js";
import { BUILTIN_PROVIDER_CONFIGS } from "../../src/cli/runtime.js";
import { getBuiltinProviderDescriptor } from "../../src/providers/builtins.js";
import { createProviderAdapter } from "../../src/service/provider-factory.js";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const OAUTH_HOST = "https://auth.kimi.com";

class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, AuthCredential>();

  async read(id: string): Promise<AuthCredential | undefined> { return this.values.get(id); }
  async write(id: string, credential: AuthCredential): Promise<void> { this.values.set(id, credential); }
  async delete(id: string): Promise<void> { this.values.delete(id); }
  async withLock<T>(_id: string, operation: () => Promise<T>): Promise<T> { return await operation(); }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deviceAuthorization(overrides: Record<string, unknown> = {}): Response {
  return json({
    user_code: "ABCD-1234",
    device_code: "device-code-123",
    verification_uri: "https://www.kimi.com/code",
    verification_uri_complete: "https://www.kimi.com/code?user_code=ABCD-1234",
    interval: 5,
    expires_in: 600,
    ...overrides,
  });
}

function interaction(
  notices: Array<{ userCode: string; verificationUri: string }>,
): ProviderManagedAuthInteraction {
  return {
    signal: new AbortController().signal,
    showAuthorization: () => undefined,
    showDeviceCode(value) {
      notices.push({ userCode: value.userCode, verificationUri: value.verificationUri.toString() });
    },
    showProgress: () => undefined,
    prompt: async () => { throw new Error("Kimi Code login must not prompt"); },
    select: async () => { throw new Error("Kimi Code login must not select"); },
  };
}

test("Kimi Code OAuth completes RFC8628 login after the first poll interval", async () => {
  let clock = 1_000_000;
  let polls = 0;
  const requests: Array<{ url: string; body: URLSearchParams; at: number }> = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = new URLSearchParams(await request.text());
    requests.push({ url: request.url, body, at: clock });
    if (request.url === `${OAUTH_HOST}/api/oauth/device_authorization`) return deviceAuthorization();
    if (request.url === `${OAUTH_HOST}/api/oauth/token`) {
      polls += 1;
      if (polls === 1) return json({ error: "authorization_pending" }, 400);
      return json({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 });
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };
  const notices: Array<{ userCode: string; verificationUri: string }> = [];
  const method = createKimiCodingManagedOAuth({
    fetch: fetchImplementation,
    environment: {},
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  });

  const credential = await method.login(interaction(notices));

  assert.deepEqual(notices, [{
    userCode: "ABCD-1234",
    verificationUri: "https://www.kimi.com/code?user_code=ABCD-1234",
  }]);
  assert.deepEqual(requests.map((entry) => entry.url), [
    `${OAUTH_HOST}/api/oauth/device_authorization`,
    `${OAUTH_HOST}/api/oauth/token`,
    `${OAUTH_HOST}/api/oauth/token`,
  ]);
  assert.equal(requests[0]?.body.get("client_id"), CLIENT_ID);
  assert.equal(requests[1]?.body.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
  assert.equal(requests[1]?.body.get("client_id"), CLIENT_ID);
  assert.equal(requests[1]?.body.get("device_code"), "device-code-123");
  assert.deepEqual(requests.slice(1).map((entry) => entry.at), [1_005_000, 1_010_000]);
  assert.deepEqual(credential, {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: 4_610_000,
    tokenType: "Bearer",
  });
});

test("Kimi Code OAuth reports expired and denied device grants", async () => {
  for (const [error, message] of [["expired_token", /expired/u], ["access_denied", /denied/u]] as const) {
    const method = createKimiCodingManagedOAuth({
      environment: {},
      fetch: (async (input) => String(input).endsWith("device_authorization")
        ? deviceAuthorization({ interval: 1 })
        : json({ error }, 400)) as typeof fetch,
      now: () => 1_000_000,
      sleep: async () => undefined,
    });
    await assert.rejects(method.login(interaction([])), message);
  }
});

test("Kimi Code OAuth honors its preferred and legacy host overrides", async () => {
  for (const environment of [
    { KIMI_CODE_OAUTH_HOST: "https://auth.example.test///", KIMI_OAUTH_HOST: "https://legacy.example.test" },
    { KIMI_OAUTH_HOST: "https://legacy.example.test/" },
  ]) {
    const urls: string[] = [];
    const method = createKimiCodingManagedOAuth({
      environment,
      fetch: (async (input) => {
        const url = String(input);
        urls.push(url);
        return url.endsWith("device_authorization")
          ? deviceAuthorization({ interval: 1 })
          : json({ access_token: "access", refresh_token: "refresh", expires_in: 60 });
      }) as typeof fetch,
      now: () => 1_000_000,
      sleep: async () => undefined,
    });
    await method.login(interaction([]));
    const expectedHost = environment.KIMI_CODE_OAUTH_HOST === undefined
      ? "https://legacy.example.test"
      : "https://auth.example.test";
    assert.deepEqual(urls, [
      `${expectedHost}/api/oauth/device_authorization`,
      `${expectedHost}/api/oauth/token`,
    ]);
  }
});

test("Kimi Code OAuth refresh rotates tokens and retries only transient failures", async () => {
  let clock = 2_000_000;
  let calls = 0;
  const waits: number[] = [];
  const bodies: URLSearchParams[] = [];
  const method = createKimiCodingManagedOAuth({
    environment: {},
    now: () => clock,
    sleep: async (milliseconds) => { waits.push(milliseconds); clock += milliseconds; },
    fetch: (async (input, init) => {
      assert.equal(String(input), `${OAUTH_HOST}/api/oauth/token`);
      bodies.push(new URLSearchParams(String(init?.body)));
      calls += 1;
      if (calls === 1) return json({ error: "temporarily_unavailable" }, 429);
      return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    }) as typeof fetch,
  });

  const refreshed = await method.refresh({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 0,
  }, new AbortController().signal);

  assert.deepEqual(waits, [1000]);
  assert.equal(calls, 2);
  assert.equal(bodies[0]?.get("grant_type"), "refresh_token");
  assert.equal(bodies[0]?.get("client_id"), CLIENT_ID);
  assert.equal(bodies[0]?.get("refresh_token"), "old-refresh");
  assert.deepEqual(refreshed, {
    accessToken: "new-access",
    refreshToken: "new-refresh",
    expiresAt: 5_601_000,
    tokenType: "Bearer",
  });

  let unauthorizedCalls = 0;
  const unauthorized = createKimiCodingManagedOAuth({
    environment: {},
    sleep: async () => { throw new Error("invalid_grant must not back off"); },
    fetch: (async () => {
      unauthorizedCalls += 1;
      return json({ error: "invalid_grant" }, 400);
    }) as typeof fetch,
  });
  await assert.rejects(unauthorized.refresh({
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 0,
  }, new AbortController().signal), /unauthorized/u);
  assert.equal(unauthorizedCalls, 1);
});

test("Kimi Code registration adds subscription OAuth while preserving API-key login and Bearer requests", async () => {
  assert.equal(getBuiltinProviderDescriptor("kimi-coding")?.oauth, true);
  const descriptor = createKimiCodingAuthDescriptor({ environment: {} });
  const registry = new ProviderAuthRegistry({
    bindings: [{
      providerId: "kimi-coding",
      credentialId: "kimi-coding",
      displayName: "Kimi For Coding",
      secret: "api_key",
    }],
    store: new MemoryCredentialStore(),
    environment: { KIMI_API_KEY: "environment-key" },
  });
  registry.registerDescriptor("rigyn-core", descriptor);

  assert.deepEqual((await registry.loginMethods("kimi-coding")).map((method) => method.kind), [
    "managed_oauth",
    "environment",
    "api_key",
  ]);
  assert.equal(registry.methods("kimi-coding")[0]?.label, "Sign in with Kimi Code");
  assert.deepEqual(registry.descriptor("kimi-coding")?.request, {
    origins: ["https://api.kimi.com"],
    bearer: { header: "authorization", prefix: "Bearer " },
  });
});

test("Kimi Code transport keeps API keys on x-api-key and subscription tokens on plain Bearer auth", async () => {
  const config = BUILTIN_PROVIDER_CONFIGS["kimi-coding"];
  assert.equal(config?.kind, "anthropic");
  for (const fixture of [
    {
      credential: { kind: "api_key" as const, provider: "kimi-coding", apiKey: "api-secret" },
      apiKey: "api-secret",
      authorization: null,
    },
    {
      credential: {
        kind: "oauth" as const,
        provider: "kimi-coding",
        accessToken: "subscription-secret",
        refreshToken: "refresh-secret",
        expiresAt: Date.now() + 60_000,
        tokenType: "Bearer" as const,
        scopes: [],
      },
      apiKey: null,
      authorization: "Bearer subscription-secret",
    },
  ]) {
    let headers: Headers | undefined;
    const broker = new CredentialBroker([new ExplicitCredentialSource(new Map([
      ["kimi-coding", fixture.credential],
    ]))]);
    const adapter = createProviderAdapter(config!, broker, {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        headers = request.headers;
        return json({ data: [], has_more: false });
      }) as typeof fetch,
    });
    await adapter.listModels(new AbortController().signal);
    assert.equal(headers?.get("x-api-key"), fixture.apiKey);
    assert.equal(headers?.get("authorization"), fixture.authorization);
    assert.equal(headers?.has("anthropic-dangerous-direct-browser-access"), false);
    assert.equal(headers?.get("anthropic-beta"), null);
  }
});
