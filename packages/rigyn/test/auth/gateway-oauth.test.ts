import assert from "node:assert/strict";
import test from "node:test";

import { createGatewayManagedOAuth, type ProviderManagedAuthInteraction } from "../../src/auth/index.js";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("gateway OAuth discovers endpoints and completes device login and refresh", async () => {
  let clock = 1_000_000;
  let pollCount = 0;
  const requests: Array<{ url: string; body: string }> = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.method === "GET" ? "" : await request.text();
    requests.push({ url: request.url, body });
    if (request.url.endsWith("/oauth")) {
      return json({
        issuer: "https://identity.example.test",
        authorizationEndpoint: "https://identity.example.test/authorize",
        tokenEndpoint: "https://identity.example.test/token",
        deviceAuthorizationEndpoint: "https://identity.example.test/device",
        deviceAuthorizationEventsEndpoint: "https://identity.example.test/device/events",
        verificationEndpoint: "https://identity.example.test/verify",
        clientId: "public-client",
        scope: "models.read offline_access",
        deviceCodeGrantType: "urn:example:params:oauth:grant-type:device",
      });
    }
    if (request.url.endsWith("/device")) {
      return json({ device_code: "device-secret", user_code: "ABCD-EFGH", expires_in: 600, interval: 1 });
    }
    if (body.includes("grant_type=urn%3Aexample%3Aparams%3Aoauth%3Agrant-type%3Adevice")) {
      pollCount += 1;
      if (pollCount === 1) return json({ error: "authorization_pending" }, 400);
      return json({
        access_token: "access-one",
        refresh_token: "refresh-one",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (body.includes("grant_type=refresh_token")) {
      return json({ access_token: "access-two", token_type: "Bearer", expires_in: 3600 });
    }
    throw new Error(`Unexpected request ${request.url}`);
  };
  const notices: Array<{ userCode: string; verificationUri: string }> = [];
  const interaction: ProviderManagedAuthInteraction = {
    signal: new AbortController().signal,
    showAuthorization: () => undefined,
    showDeviceCode(value) {
      notices.push({ userCode: value.userCode, verificationUri: value.verificationUri.toString() });
    },
    showProgress: () => undefined,
    prompt: async () => "",
    select: async () => "device",
  };
  const method = createGatewayManagedOAuth({
    name: "Company Gateway",
    gatewayUrl: "https://gateway.example.test/v1/",
    fetch: fetchImplementation,
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
  });

  const credential = await method.login(interaction);
  assert.equal(credential.accessToken, "access-one");
  assert.equal(credential.refreshToken, "refresh-one");
  assert.deepEqual(credential.scopes, ["models.read", "offline_access"]);
  assert.deepEqual(notices, [{ userCode: "ABCD-EFGH", verificationUri: "https://identity.example.test/verify" }]);
  assert.ok(requests.some((request) => request.body.includes("grant_type=urn%3Aexample%3Aparams%3Aoauth%3Agrant-type%3Adevice")));

  const refreshed = await method.refresh(credential, new AbortController().signal);
  assert.equal(refreshed.accessToken, "access-two");
  assert.equal(refreshed.refreshToken, undefined);
});

test("gateway OAuth rejects unsafe discovered endpoints before authorization", async () => {
  const method = createGatewayManagedOAuth({
    name: "Company Gateway",
    gatewayUrl: "https://gateway.example.test/v1",
    fetch: (async () => json({
      authorizationEndpoint: "file:///tmp/authorize",
      tokenEndpoint: "https://identity.example.test/token",
      deviceAuthorizationEndpoint: "https://identity.example.test/device",
      verificationEndpoint: "https://identity.example.test/verify",
      clientId: "public-client",
      scope: "models.read",
      deviceCodeGrantType: "urn:example:device",
    })) as typeof fetch,
  });
  await assert.rejects(method.login({
    signal: new AbortController().signal,
    showAuthorization: () => undefined,
    showDeviceCode: () => undefined,
    showProgress: () => undefined,
    prompt: async () => "",
    select: async () => "device",
  }), /must use HTTPS/u);
});
