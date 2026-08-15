import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticatedProviderFetch,
  normalizeProviderAuthDescriptor,
} from "../../src/auth/index.js";

const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
type StreamingRequestInit = RequestInit & { duplex: "half" };
const streamingRequest = (init: StreamingRequestInit): RequestInit => init;
const requestDuplex = (request: Request): string | undefined =>
  (request as Request & { duplex?: string }).duplex;

function byteStream(bytes: number, value: number, cancelled?: () => void): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(64 * 1024).fill(value);
  let emitted = 0;
  return new ReadableStream({
    pull(controller) {
      if (emitted === bytes) {
        controller.close();
        return;
      }
      const remaining = bytes - emitted;
      const next = remaining < chunk.byteLength ? chunk.subarray(0, remaining) : chunk;
      emitted += next.byteLength;
      controller.enqueue(next);
    },
    cancel() { cancelled?.(); },
  }, { highWaterMark: 0 });
}

function infiniteByteStream(cancelled: () => void): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(64 * 1024).fill(120);
  return new ReadableStream({
    pull(controller) { controller.enqueue(chunk); },
    cancel() { cancelled(); },
  }, { highWaterMark: 0 });
}

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

test("brokered provider fetch preserves an exact-limit streamed body across authorization", async () => {
  const controller = new AbortController();
  let authorizedSignal: AbortSignal | undefined;
  let transported: Request | undefined;
  const response = await authenticatedProviderFetch(
    policy(),
    (request) => {
      authorizedSignal = request.signal;
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("x-request-shape"), "preserved");
      assert.equal(requestDuplex(request), "half");
      const headers = new Headers(request.headers);
      headers.set("x-api-key", "Token secret");
      return new Request(request, { headers });
    },
    async (input, init) => {
      transported = new Request(input, init);
      return new Response("ok");
    },
    new Request("https://api.example.test/v1", streamingRequest({
      method: "POST",
      headers: {
        "content-length": String(MAX_REQUEST_BODY_BYTES),
        "content-type": "application/octet-stream",
        "x-request-shape": "preserved",
      },
      body: byteStream(MAX_REQUEST_BODY_BYTES, 0x5a),
      duplex: "half",
      signal: controller.signal,
    })),
  );

  assert.equal(await response.text(), "ok");
  assert.ok(transported);
  assert.equal(transported.method, "POST");
  assert.equal(transported.headers.get("content-length"), String(MAX_REQUEST_BODY_BYTES));
  assert.equal(transported.headers.get("x-request-shape"), "preserved");
  assert.equal(transported.headers.get("x-api-key"), "Token secret");
  assert.equal(requestDuplex(transported), "half");
  const body = new Uint8Array(await transported.arrayBuffer());
  assert.equal(body.byteLength, MAX_REQUEST_BODY_BYTES);
  assert.equal(body.every((value) => value === 0x5a), true);
  controller.abort(new Error("late stop"));
  assert.equal(authorizedSignal?.aborted, true);
  assert.equal(transported.signal.aborted, true);
});

test("brokered provider fetch cancels over-limit caller and authorizer bodies before dispatch", async (context) => {
  await context.test("caller body", async () => {
    let cancellations = 0;
    let authorizations = 0;
    let fetches = 0;
    await assert.rejects(authenticatedProviderFetch(
      policy(),
      (request) => { authorizations += 1; return request; },
      async () => { fetches += 1; return new Response("unreachable"); },
      "https://api.example.test/v1",
      streamingRequest({
        method: "POST",
        body: byteStream(MAX_REQUEST_BODY_BYTES + 1, 120, () => { cancellations += 1; }),
        duplex: "half",
      }),
    ), /body exceeds 16777216 bytes/u);
    assert.equal(cancellations, 1);
    assert.equal(authorizations, 0);
    assert.equal(fetches, 0);
  });

  await context.test("authorizer replacement", async () => {
    let cancellations = 0;
    let fetches = 0;
    await assert.rejects(authenticatedProviderFetch(
      policy(),
      (request) => new Request(request, streamingRequest({
        body: byteStream(MAX_REQUEST_BODY_BYTES + 1, 121, () => { cancellations += 1; }),
        duplex: "half",
      })),
      async () => { fetches += 1; return new Response("unreachable"); },
      "https://api.example.test/v1",
      { method: "POST", body: "{}" },
    ), /body exceeds 16777216 bytes/u);
    assert.equal(cancellations, 1);
    assert.equal(fetches, 0);
  });
});

test("brokered provider fetch cancels an infinite body at the request limit", { timeout: 5_000 }, async () => {
  let cancellations = 0;
  let authorizations = 0;
  await assert.rejects(authenticatedProviderFetch(
    policy(),
    (request) => { authorizations += 1; return request; },
    async () => new Response("unreachable"),
    "https://api.example.test/v1",
    streamingRequest({
      method: "POST",
      body: infiniteByteStream(() => { cancellations += 1; }),
      duplex: "half",
    }),
  ), /body exceeds 16777216 bytes/u);
  assert.equal(cancellations, 1);
  assert.equal(authorizations, 0);
});
