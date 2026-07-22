import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  authorizeOpenAICodex,
  OPENAI_CODEX_AUTHORIZATION_ENDPOINT,
  OPENAI_CODEX_DEVICE_ENDPOINT,
  OPENAI_CODEX_DEVICE_REDIRECT_URI,
  OPENAI_CODEX_DEVICE_TOKEN_ENDPOINT,
  OPENAI_CODEX_DEVICE_VERIFICATION_URL,
  OPENAI_CODEX_TOKEN_ENDPOINT,
  openAICodexIdentity,
} from "../../src/auth/openai-codex.js";

function accessToken(accountId = "account-123", subject = "user-456"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    sub: subject,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.signature`;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("OpenAI Codex identity extraction validates the account claim without exposing tokens", () => {
  assert.deepEqual(openAICodexIdentity(accessToken()), { accountId: "account-123", subject: "user-456" });
  assert.throws(() => openAICodexIdentity("not-a-jwt"), /valid JWT/u);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  assert.throws(() => openAICodexIdentity(`${encode({})}.${encode({ sub: "user" })}.sig`), /account ID/u);
});

test("OpenAI Codex browser login uses fixed-shape PKCE, accepts a state-checked manual callback, and stores identity", async () => {
  let authorizationUrl: URL | undefined;
  let tokenRequest: URLSearchParams | undefined;
  const fetchImplementation: typeof fetch = async (input, init) => {
    assert.equal(String(input), OPENAI_CODEX_TOKEN_ENDPOINT);
    tokenRequest = new URLSearchParams(String(init?.body));
    return json({
      access_token: accessToken("browser-account", "browser-user"),
      refresh_token: "browser-refresh",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid profile email offline_access",
    });
  };
  const credential = await authorizeOpenAICodex({
    flow: "browser",
    clientId: "fixture-client",
    callbackPort: 0,
    fetch: fetchImplementation,
    now: () => 1_000,
    showAuthorization({ url }) { authorizationUrl = new URL(url); },
    async requestManualAuthorization(input) {
      return `${input.redirectUri}?code=browser-code&state=${encodeURIComponent(input.state)}`;
    },
  });

  if (authorizationUrl === undefined) assert.fail("Expected the browser authorization URL");
  assert.equal(authorizationUrl.origin + authorizationUrl.pathname, OPENAI_CODEX_AUTHORIZATION_ENDPOINT);
  assert.equal(authorizationUrl?.searchParams.get("client_id"), "fixture-client");
  assert.equal(authorizationUrl?.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizationUrl?.searchParams.get("originator"), "rigyn");
  assert.equal(authorizationUrl?.searchParams.get("redirect_uri")?.startsWith("http://localhost:"), true);
  assert.equal(tokenRequest?.get("grant_type"), "authorization_code");
  assert.equal(tokenRequest?.get("code"), "browser-code");
  assert.equal(tokenRequest?.get("redirect_uri")?.startsWith("http://localhost:"), true);
  assert.equal(credential.provider, "openai-codex");
  assert.equal(credential.accountId, "browser-account");
  assert.equal(credential.subject, "browser-user");
  assert.equal(credential.refreshToken, "browser-refresh");
  assert.equal(credential.expiresAt, 3_601_000);
});

test("OpenAI Codex browser login rejects a manual callback with the wrong state before token exchange", async () => {
  let fetchCalls = 0;
  await assert.rejects(authorizeOpenAICodex({
    flow: "browser",
    clientId: "fixture-client",
    callbackPort: 0,
    fetch: async () => {
      fetchCalls += 1;
      return json({});
    },
    showAuthorization() {},
    async requestManualAuthorization(input) {
      return `${input.redirectUri}?code=browser-code&state=wrong`;
    },
  }), /state is invalid/u);
  assert.equal(fetchCalls, 0);
});

test("OpenAI Codex browser login keeps the manual callback path usable when the fixed loopback port is occupied", async (t) => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => occupied.close());
  const port = (occupied.address() as { port: number }).port;
  const credential = await authorizeOpenAICodex({
    flow: "browser",
    clientId: "fixture-client",
    callbackPort: port,
    fetch: async (input) => {
      assert.equal(String(input), OPENAI_CODEX_TOKEN_ENDPOINT);
      return json({
        access_token: accessToken("fallback-account"),
        refresh_token: "fallback-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      });
    },
    showAuthorization() {},
    async requestManualAuthorization(input) {
      assert.equal(input.redirectUri, `http://localhost:${port}/auth/callback`);
      return `manual-code#${input.state}`;
    },
  });
  assert.equal(credential.accountId, "fallback-account");
});

test("OpenAI Codex headless login handles pending and slow-down responses before exchanging the device code", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  let polls = 0;
  let clock = 10_000;
  let shown: { url: URL; userCode?: string } | undefined;
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    requests.push({ url, body });
    if (url === OPENAI_CODEX_DEVICE_ENDPOINT) {
      assert.deepEqual(JSON.parse(body), { client_id: "fixture-client" });
      return json({ device_auth_id: "device-auth", user_code: "ABCD-EFGH", interval: "1" });
    }
    if (url === OPENAI_CODEX_DEVICE_TOKEN_ENDPOINT) {
      polls += 1;
      assert.deepEqual(JSON.parse(body), { device_auth_id: "device-auth", user_code: "ABCD-EFGH" });
      if (polls === 1) return json({ error: { code: "deviceauth_authorization_pending" } }, 403);
      if (polls === 2) return json({ error: "slow_down" }, 400);
      return json({ authorization_code: "device-code", code_verifier: "v".repeat(43) });
    }
    assert.equal(url, OPENAI_CODEX_TOKEN_ENDPOINT);
    const parameters = new URLSearchParams(body);
    assert.equal(parameters.get("redirect_uri"), OPENAI_CODEX_DEVICE_REDIRECT_URI);
    assert.equal(parameters.get("code"), "device-code");
    assert.equal(parameters.get("code_verifier"), "v".repeat(43));
    return json({
      access_token: accessToken("device-account", "device-user"),
      refresh_token: "device-refresh",
      token_type: "Bearer",
      expires_in: 7200,
    });
  };

  const credential = await authorizeOpenAICodex({
    flow: "device",
    clientId: "fixture-client",
    fetch: fetchImplementation,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    showAuthorization(input) { shown = { url: new URL(input.url), ...(input.userCode === undefined ? {} : { userCode: input.userCode }) }; },
  });

  assert.equal(shown?.url.toString(), OPENAI_CODEX_DEVICE_VERIFICATION_URL);
  assert.equal(shown?.userCode, "ABCD-EFGH");
  assert.equal(polls, 3);
  assert.equal(credential.accountId, "device-account");
  assert.equal(credential.refreshToken, "device-refresh");
  assert.ok(requests.length >= 5);
});

test("OpenAI Codex headless login retries one transient non-JSON device response", async () => {
  let deviceRequests = 0;
  let clock = 10_000;
  const fetchImplementation: typeof fetch = async (input) => {
    const url = String(input);
    if (url === OPENAI_CODEX_DEVICE_ENDPOINT) {
      deviceRequests += 1;
      if (deviceRequests === 1) return new Response("temporarily unavailable", { status: 200 });
      return json({ device_auth_id: "device-auth", user_code: "ABCD-EFGH", interval: 1 });
    }
    if (url === OPENAI_CODEX_DEVICE_TOKEN_ENDPOINT) {
      return json({ authorization_code: "device-code", code_verifier: "v".repeat(43) });
    }
    assert.equal(url, OPENAI_CODEX_TOKEN_ENDPOINT);
    return json({
      access_token: accessToken("retry-account"),
      refresh_token: "retry-refresh",
      token_type: "Bearer",
      expires_in: 3600,
    });
  };

  const credential = await authorizeOpenAICodex({
    flow: "device",
    clientId: "fixture-client",
    fetch: fetchImplementation,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    showAuthorization() {},
  });

  assert.equal(deviceRequests, 2);
  assert.equal(credential.accountId, "retry-account");
});

test("OpenAI Codex headless login is abortable while polling", async () => {
  const controller = new AbortController();
  const fetchImplementation: typeof fetch = async (input) => {
    assert.equal(String(input), OPENAI_CODEX_DEVICE_ENDPOINT);
    return json({ device_auth_id: "device-auth", user_code: "ABCD-EFGH", interval: 1 });
  };
  await assert.rejects(authorizeOpenAICodex({
    flow: "device",
    clientId: "fixture-client",
    fetch: fetchImplementation,
    signal: controller.signal,
    showAuthorization() {},
    async sleep() {
      controller.abort(new Error("cancelled by test"));
    },
  }), /cancelled by test/u);
});
