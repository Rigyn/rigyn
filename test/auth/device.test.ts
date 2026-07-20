import assert from "node:assert/strict";
import test from "node:test";

import { pollDeviceToken, requestDeviceAuthorization } from "../../src/auth/device.js";

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("device authorization requests scoped codes from a secure endpoint", async () => {
  let body = "";
  const response = await requestDeviceAuthorization({
    deviceEndpoint: "https://issuer.example/device",
    clientId: "our-client",
    scopes: ["models.read", "tools.use"],
    fetch: (async (_input, init) => {
      body = String(init?.body);
      return jsonResponse({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://issuer.example/activate",
        verification_uri_complete: "https://issuer.example/activate?user_code=ABCD-EFGH",
        expires_in: 900,
        interval: 3,
      }, 200);
    }) as typeof fetch,
  });
  assert.equal(body, "client_id=our-client&scope=models.read+tools.use");
  assert.deepEqual(response, {
    deviceCode: "device-secret",
    userCode: "ABCD-EFGH",
    verificationUri: "https://issuer.example/activate",
    verificationUriComplete: "https://issuer.example/activate?user_code=ABCD-EFGH",
    expiresInSeconds: 900,
    intervalSeconds: 3,
  });
});

test("device authorization rejects insecure endpoints and malformed responses", async () => {
  await assert.rejects(
    () => requestDeviceAuthorization({ deviceEndpoint: "http://issuer.example/device", clientId: "client" }),
    /must use HTTPS/u,
  );
  await assert.rejects(
    () => requestDeviceAuthorization({
      deviceEndpoint: "https://issuer.example/device",
      clientId: "client",
      fetch: (async () => jsonResponse({ device_code: "only-one-field" }, 200)) as typeof fetch,
    }),
    /invalid user_code/u,
  );
  await assert.rejects(() => requestDeviceAuthorization({
    deviceEndpoint: "https://issuer.example/device",
    clientId: "bad\nclient",
  }), /clientId is invalid/u);
  for (const response of [
    { device_code: "bad\ncode", user_code: "CODE", verification_uri: "https://issuer.example/verify", expires_in: 60 },
    { device_code: "code", user_code: "CODE", verification_uri: "https://issuer.example/verify", expires_in: 1.5 },
    { device_code: "code", user_code: "CODE", verification_uri: "https://issuer.example/verify", expires_in: 60, interval: 0.5 },
  ]) {
    await assert.rejects(() => requestDeviceAuthorization({
      deviceEndpoint: "https://issuer.example/device",
      clientId: "client",
      fetch: (async () => jsonResponse(response, 200)) as typeof fetch,
    }), /invalid (?:device_code|expires_in|interval)/u);
  }
});

test("device authorization treats a zero provider interval as the interoperable default", async () => {
  const response = await requestDeviceAuthorization({
    deviceEndpoint: "https://issuer.example/device",
    clientId: "client",
    fetch: (async () => jsonResponse({
      device_code: "device-secret",
      user_code: "CODE",
      verification_uri: "https://issuer.example/verify",
      expires_in: 60,
      interval: 0,
    }, 200)) as typeof fetch,
  });
  assert.equal(response.intervalSeconds, 5);
});

test("device polling handles pending and slow_down before success", async () => {
  const responses = [
    jsonResponse({ error: "authorization_pending" }, 400),
    jsonResponse({ error: "slow_down" }, 400),
    jsonResponse(
      { access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600 },
      200,
    ),
  ];
  let now = 0;
  const sleeps: number[] = [];
  const result = await pollDeviceToken({
    tokenEndpoint: "https://issuer.example/token",
    clientId: "our-client",
    deviceCode: "device-code",
    expiresInSeconds: 60,
    intervalSeconds: 1,
    now: () => now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    fetch: (async () => responses.shift() ?? jsonResponse({}, 500)) as typeof fetch,
  });

  assert.deepEqual(sleeps, [1_000, 1_000, 6_000]);
  assert.equal(result.accessToken, "access");
  assert.equal(result.refreshToken, "refresh");
});

test("device polling observes cancellation", async () => {
  const controller = new AbortController();
  await assert.rejects(
    pollDeviceToken({
      tokenEndpoint: "https://issuer.example/token",
      clientId: "our-client",
      deviceCode: "device-code",
      expiresInSeconds: 60,
      signal: controller.signal,
      sleep: async (_milliseconds, signal) => {
        controller.abort(new Error("cancel polling"));
        signal?.throwIfAborted();
      },
      fetch: (async () => jsonResponse({}, 500)) as typeof fetch,
    }),
    /cancel polling/,
  );
});

test("device polling stops at device-code expiry", async () => {
  let now = 0;
  let requests = 0;
  await assert.rejects(
    pollDeviceToken({
      tokenEndpoint: "https://issuer.example/token",
      clientId: "our-client",
      deviceCode: "device-code",
      expiresInSeconds: 1,
      intervalSeconds: 1,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      fetch: (async () => {
        requests += 1;
        return jsonResponse({}, 500);
      }) as typeof fetch,
    }),
    /expired/,
  );
  assert.equal(requests, 0);
});

test("device polling rejects fractional/unsafe timing and slow-down overflow", async () => {
  for (const input of [
    { expiresInSeconds: 1.5, intervalSeconds: 1 },
    { expiresInSeconds: 60, intervalSeconds: 0.5 },
  ]) {
    await assert.rejects(() => pollDeviceToken({
      tokenEndpoint: "https://issuer.example/token",
      clientId: "client",
      deviceCode: "device-code",
      ...input,
    }), /must be positive|intervalSeconds/u);
  }
  await assert.rejects(() => pollDeviceToken({
    tokenEndpoint: "https://issuer.example/token",
    clientId: "client",
    deviceCode: "device-code",
    expiresInSeconds: 1,
    now: () => Number.MAX_SAFE_INTEGER - 500,
  }), /expiry is invalid/u);

  let now = 0;
  await assert.rejects(() => pollDeviceToken({
    tokenEndpoint: "https://issuer.example/token",
    clientId: "client",
    deviceCode: "device-code",
    expiresInSeconds: 601,
    intervalSeconds: 300,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    fetch: (async () => jsonResponse({ error: "slow_down" }, 400)) as typeof fetch,
  }), /interval exceeded 300 seconds/u);
});
