import assert from "node:assert/strict";
import test from "node:test";
import { getBuiltinProvider, MemoryCredentialStore } from "../src/index.ts";
import {
  browserOAuthMethod,
  createPkcePair,
  deviceOAuthMethod,
  modifyCredential,
} from "../src/oauth.ts";
import { xaiProvider } from "../src/providers/xai.ts";

test("credential store reads clones, lists provider identities, modifies atomically, and deletes", async () => {
  const store = new MemoryCredentialStore();
  await store.modify("example", () => ({ type: "api_key", key: "first" }));
  const first = await store.read("example");
  assert.deepEqual(first, { type: "api_key", key: "first" });
  if (first?.type === "api_key") first.key = "mutated-copy";
  assert.deepEqual(await store.read("example"), { type: "api_key", key: "first" });

  await Promise.all([
    modifyCredential(store, "counter", async (credential) => {
      await Promise.resolve();
      const count = credential?.type === "oauth" && typeof credential.count === "number" ? credential.count : 0;
      return { type: "oauth", access: "a", refresh: "r", expires: 10, count: count + 1 };
    }),
    modifyCredential(store, "counter", async (credential) => {
      await Promise.resolve();
      const count = credential?.type === "oauth" && typeof credential.count === "number" ? credential.count : 0;
      return { type: "oauth", access: "a", refresh: "r", expires: 10, count: count + 1 };
    }),
  ]);
  assert.equal((await store.read("counter") as { count?: number }).count, 2);
  assert.deepEqual(new Set((await store.list()).map((entry) => entry.providerId)), new Set(["example", "counter"]));
  await store.delete("example");
  assert.equal(await store.read("example"), undefined);
});

test("PKCE creates independent URL-safe verifier and challenge values", async () => {
  const left = await createPkcePair();
  const right = await createPkcePair();
  assert.match(left.verifier, /^[A-Za-z0-9_-]+$/u);
  assert.match(left.challenge, /^[A-Za-z0-9_-]+$/u);
  assert.notEqual(left.verifier, right.verifier);
  assert.notEqual(left.verifier, left.challenge);
});

test("browser OAuth verifies callback state before exchanging the code", async () => {
  let authorizationUrl = "";
  let exchanges = 0;
  const method = browserOAuthMethod({
    name: "Example",
    authorizationUrl: "https://auth.example/authorize",
    tokenUrl: "https://auth.example/token",
    clientId: "rigyn-owned-client",
    scopes: ["openid"],
    fetch: async () => {
      exchanges += 1;
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 60 });
    },
  });
  const credential = await method.login({
    async notify(input) {
      if (input.type === "auth_url") authorizationUrl = input.url;
    },
    async prompt() {
      const state = new URL(authorizationUrl).searchParams.get("state");
      return "http://127.0.0.1:1455/auth/callback?code=code&state=" + encodeURIComponent(state ?? "");
    },
  });
  assert.equal(exchanges, 1);
  assert.equal(credential.type, "oauth");
  assert.equal(credential.access, "access");

  await assert.rejects(method.login({
    async notify(input) {
      if (input.type === "auth_url") authorizationUrl = input.url;
    },
    async prompt() { return "http://127.0.0.1:1455/auth/callback?code=code&state=wrong"; },
  }), /state/u);
  assert.equal(exchanges, 1);
});

test("device OAuth polling is bounded by expiry and cancellation", async () => {
  let requests = 0;
  const method = deviceOAuthMethod({
    name: "Device example",
    clientId: "rigyn-owned-client",
    deviceUrl: "https://auth.example/device",
    tokenUrl: "https://auth.example/token",
    scopes: ["openid"],
    fetch: async () => {
      requests += 1;
      return Response.json({
        device_code: "device",
        user_code: "CODE",
        verification_uri: "https://auth.example/verify",
        expires_in: 0,
        interval: 1,
      });
    },
  });
  await assert.rejects(method.login({
    async notify() {},
    async prompt() { return ""; },
  }), /expired/u);
  assert.equal(requests, 1, "expiry must prevent token polling");

  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  const cancelledMethod = deviceOAuthMethod({
    name: "Device example",
    clientId: "rigyn-owned-client",
    deviceUrl: "https://auth.example/device",
    tokenUrl: "https://auth.example/token",
    scopes: ["openid"],
    fetch: async () => Response.json({
      device_code: "device",
      user_code: "CODE",
      verification_uri: "https://auth.example/verify",
      expires_in: 60,
      interval: 1,
    }),
  });
  await assert.rejects(cancelledMethod.login({
    async notify() {},
    async prompt() { return ""; },
    signal: controller.signal,
  }), /cancelled/u);
});

test("xAI keeps API-key identity and enables OAuth only with an injected registration", () => {
  const withoutRegistration = xaiProvider();
  assert.ok(withoutRegistration.auth.apiKey);
  assert.equal(withoutRegistration.auth.oauth, undefined);

  const registered = xaiProvider({ xaiOAuth: { clientId: "rigyn-owned-client", mode: "device" } });
  assert.ok(registered.auth.apiKey);
  assert.ok(registered.auth.oauth);
});

test("audited product providers do not install a product OAuth registration by default", () => {
  for (const id of ["openai-codex", "anthropic", "github-copilot", "xai", "kimi-code", "opencode", "opencode-go"]) {
    assert.equal(getBuiltinProvider(id)?.auth.oauth, undefined, id);
  }
});
