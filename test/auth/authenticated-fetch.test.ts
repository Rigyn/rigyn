import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticatedProviderFetch,
  normalizeProviderAuthDescriptor,
} from "../../src/auth/index.js";

function policy() {
  const descriptor = normalizeProviderAuthDescriptor({
    provider: "fixture",
    methods: [{ kind: "api_key" }],
    request: {
      origins: ["https://api.example.test", "https://api.example.test/"],
      apiKey: { header: "X-Api-Key", prefix: "Token " },
      bearer: { header: "Authorization", prefix: "Bearer " },
    },
  });
  assert.ok(descriptor.request);
  return descriptor.request;
}

test("provider request policies are detached, normalized, and exact-origin", () => {
  assert.deepEqual(policy(), {
    origins: ["https://api.example.test"],
    apiKey: { header: "x-api-key", prefix: "Token " },
    bearer: { header: "authorization", prefix: "Bearer " },
  });
  assert.throws(() => normalizeProviderAuthDescriptor({
    provider: "fixture",
    methods: [{ kind: "api_key" }],
    request: { origins: ["https://api.example.test/v1"], apiKey: { header: "x-api-key" } },
  }), /only an origin/u);
  assert.throws(() => normalizeProviderAuthDescriptor({
    provider: "fixture",
    methods: [{ kind: "api_key" }],
    request: { origins: ["https://api.example.test"], apiKey: { header: "cookie" } },
  }), /reserved/u);
});

test("brokered provider fetch injects credentials inside the host and never returns them", async () => {
  const secret = "credential-that-must-not-be-returned";
  let observed: Request | undefined;
  const response = await authenticatedProviderFetch(
    policy(),
    (request) => {
      const headers = new Headers(request.headers);
      headers.set("x-api-key", `Token ${secret}`);
      return new Request(request, { headers });
    },
    async (input, init) => {
      observed = input instanceof Request ? input : new Request(input, init);
      return new Response("ok", { status: 201, headers: { "x-fixture": "yes" } });
    },
    "https://api.example.test/v1/models",
    { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
  );
  assert.equal(observed?.headers.get("x-api-key"), `Token ${secret}`);
  assert.equal(observed?.redirect, "error");
  assert.equal(response.status, 201);
  assert.equal(await response.text(), "ok");
  assert.doesNotMatch(JSON.stringify({ status: response.status, headers: [...response.headers] }), /credential-that/u);
});

test("brokered provider fetch rejects cross-origin requests, caller auth, retargeting, and cancellation", async () => {
  const authorize = (request: Request) => request;
  const unreachable: typeof fetch = async () => assert.fail("fetch must not run");
  await assert.rejects(
    authenticatedProviderFetch(policy(), authorize, unreachable, "https://other.example.test/v1"),
    /origin is not allowed/u,
  );
  await assert.rejects(
    authenticatedProviderFetch(policy(), authorize, unreachable, "https://api.example.test/v1", {
      headers: { authorization: "caller-secret" },
    }),
    /header is host-owned: authorization/u,
  );
  await assert.rejects(
    authenticatedProviderFetch(
      policy(),
      () => new Request("https://api.example.test/other"),
      unreachable,
      "https://api.example.test/v1",
    ),
    /changed the request target/u,
  );
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(
    authenticatedProviderFetch(policy(), authorize, unreachable, "https://api.example.test/v1", undefined, controller.signal),
    /stop/u,
  );
});

test("brokered provider fetch cannot forward session or profile selectors", async () => {
  let forwarded: RequestInit | undefined;
  const response = await authenticatedProviderFetch(
    policy(),
    (request) => request,
    async (_input, init) => {
      forwarded = init;
      return new Response("ok");
    },
    "https://api.example.test/v1",
    { method: "GET", sessionId: "other-session", profile: "other-profile" } as RequestInit,
  );
  assert.equal(await response.text(), "ok");
  assert.equal("sessionId" in (forwarded ?? {}), false);
  assert.equal("profile" in (forwarded ?? {}), false);
});
