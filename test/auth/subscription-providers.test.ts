import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  ANTHROPIC_OAUTH_CALLBACK_PORT,
  authorizeAnthropic,
  refreshAnthropicOAuth,
} from "../../src/auth/anthropic-oauth.js";
import {
  authorizeGitHubCopilot,
  githubCopilotBaseUrl,
  refreshGitHubCopilotOAuth,
} from "../../src/auth/github-copilot.js";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function occupyAnthropicCallbackPort(): Promise<() => Promise<void>> {
  const server = createServer((_request, response) => response.end("occupied"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(ANTHROPIC_OAUTH_CALLBACK_PORT, "127.0.0.1", () => resolve());
  });
  return async () => await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

test("Anthropic subscription login uses bounded manual PKCE fallback and provider-specific refresh", async (t) => {
  const release = await occupyAnthropicCallbackPort();
  t.after(release);
  let authorizationUrl: URL | undefined;
  let exchangeBody: Record<string, unknown> | undefined;
  const fetchImplementation: typeof fetch = async (_input, init) => {
    exchangeBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return json({
      access_token: "anthropic-access",
      refresh_token: "anthropic-refresh",
      expires_in: 3600,
      token_type: "bearer",
      scope: "user:inference user:profile",
    });
  };

  const credential = await authorizeAnthropic({
    showAuthorization: ({ url }) => { authorizationUrl = url; },
    requestManualAuthorization: async ({ state }) => `manual-code#${state}`,
    fetch: fetchImplementation,
    now: () => 1_000_000,
  });

  assert.equal(authorizationUrl?.hostname, "claude.ai");
  assert.equal(authorizationUrl?.searchParams.get("code_challenge_method"), "S256");
  assert.equal(exchangeBody?.code, "manual-code");
  assert.equal(exchangeBody?.state, authorizationUrl?.searchParams.get("state"));
  assert.match(String(exchangeBody?.redirect_uri), /^http:\/\/localhost:53692\/callback$/u);
  assert.deepEqual(credential, {
    kind: "oauth",
    provider: "anthropic",
    accessToken: "anthropic-access",
    refreshToken: "anthropic-refresh",
    expiresAt: 4_600_000,
    tokenType: "Bearer",
    scopes: ["user:inference", "user:profile"],
    tokenEndpoint: "https://platform.claude.com/v1/oauth/token",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  });

  let refreshBody: Record<string, unknown> | undefined;
  const refreshed = await refreshAnthropicOAuth(credential, undefined, async (_input, init) => {
    refreshBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return json({ access_token: "anthropic-next", refresh_token: "anthropic-refresh-2", expires_in: 7200 });
  }, () => 2_000_000);
  assert.equal(refreshBody?.grant_type, "refresh_token");
  assert.equal(refreshBody?.refresh_token, "anthropic-refresh");
  assert.deepEqual(refreshed, {
    accessToken: "anthropic-next",
    refreshToken: "anthropic-refresh-2",
    expiresAt: 9_200_000,
    tokenType: "Bearer",
  });
});

test("GitHub Copilot subscription login completes device flow and refreshes its service token", async () => {
  const requests: string[] = [];
  let shown: { url: URL; userCode: string } | undefined;
  const future = Math.floor(Date.now() / 1000) + 3600;
  const serviceToken = "tid=fixture;proxy-ep=proxy.individual.githubcopilot.com;exp=fixture";
  const fetchImplementation: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/login/device/code")) {
      return json({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 1,
      });
    }
    if (url.endsWith("/login/oauth/access_token")) {
      return json({ access_token: "github-oauth-token", token_type: "bearer", scope: "read:user" });
    }
    if (url.endsWith("/copilot_internal/v2/token")) {
      return json({ token: serviceToken, expires_at: future });
    }
    return json({ error: "unexpected" }, 404);
  };

  const credential = await authorizeGitHubCopilot({
    requestHost: async () => undefined,
    showDeviceCode: (value) => { shown = value; },
    fetch: fetchImplementation,
    sleep: async () => undefined,
  });

  assert.equal(shown?.url.toString(), "https://github.com/login/device");
  assert.equal(shown?.userCode, "ABCD-EFGH");
  assert.deepEqual(requests, [
    "https://github.com/login/device/code",
    "https://github.com/login/oauth/access_token",
    "https://api.github.com/copilot_internal/v2/token",
  ]);
  assert.equal(credential.provider, "github-copilot");
  assert.equal(credential.accessToken, serviceToken);
  assert.equal(credential.refreshToken, "github-oauth-token");
  assert.equal(githubCopilotBaseUrl(credential.accessToken), "https://api.individual.githubcopilot.com");

  const refreshed = await refreshGitHubCopilotOAuth(credential, undefined, fetchImplementation);
  assert.equal(refreshed.accessToken, serviceToken);
  assert.equal(refreshed.refreshToken, "github-oauth-token");
});

test("GitHub Copilot base URL rejects untrusted token hosts and keeps enterprise fallback bounded", () => {
  assert.equal(
    githubCopilotBaseUrl("tid=x;proxy-ep=proxy.business.githubcopilot.com;exp=x"),
    "https://api.business.githubcopilot.com",
  );
  assert.equal(
    githubCopilotBaseUrl("tid=x;proxy-ep=attacker.example;exp=x", "company.ghe.com"),
    "https://copilot-api.company.ghe.com",
  );
  assert.throws(() => githubCopilotBaseUrl("token", "https://example.com/path"), /without a path/u);
});
