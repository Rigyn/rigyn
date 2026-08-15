import assert from "node:assert/strict";
import test from "node:test";

import { requestWireTransport } from "../../src/cli/runtime.js";
import { resolveProviderConfigValue } from "../../src/providers/provider-config-value.js";
import type { ProviderModel } from "../../src/providers/models.js";
import { ProviderWireInterceptorRegistry } from "../../src/providers/wire.js";

test("request-private provider headers are injected after lifecycle hooks and reach fetch", async () => {
  const secret = "resolved-private-wire-secret";
  const resolved = await resolveProviderConfigValue("$PRIVATE_HEADER", {
    async env(name) {
      return name === "PRIVATE_HEADER" ? secret : undefined;
    },
  });
  assert.equal(resolved, secret);

  const lifecycleHeaders: Array<Record<string, string>> = [];
  const base = new ProviderWireInterceptorRegistry();
  base.registerLifecycle({
    beforeHeaders(request) {
      lifecycleHeaders.push({ ...request.headers });
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers["x-configured-secret"], undefined);
      assert.doesNotMatch(JSON.stringify(request), new RegExp(secret, "u"));
      return { headers: { "x-lifecycle": "observed" } };
    },
    beforeRequest(request) {
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers["x-configured-secret"], undefined);
      assert.doesNotMatch(JSON.stringify(request), new RegExp(secret, "u"));
    },
  });
  const wire = requestWireTransport(base, "private-wire", {
    authorization: `Bearer ${resolved}`,
    "x-configured-secret": resolved,
  });
  let finalHeaders: Headers | undefined;
  const fetch = wire.wrapFetch("private-wire", async (input, init) => {
    finalHeaders = new Request(input, init).headers;
    return new Response("ok");
  });

  await base.withScope({
    threadId: "private-thread",
    runId: "private-run",
    branch: "main",
    step: 1,
  }, () => fetch("https://provider.example/v1/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-model-safe": "yes",
    },
    body: "{}",
  }));

  assert.deepEqual(lifecycleHeaders, [{
    "content-type": "application/json",
    "x-model-safe": "yes",
  }]);
  assert.equal(finalHeaders?.get("authorization"), `Bearer ${secret}`);
  assert.equal(finalHeaders?.get("x-configured-secret"), secret);
  assert.equal(finalHeaders?.get("x-lifecycle"), "observed");

  const socket = wire.begin("private-wire");
  const handshake = await socket.intercept({
    url: "wss://provider.example/v1/responses",
    method: "GET",
    headers: new Headers(),
    transport: "websocket",
    phase: "handshake",
  }, new AbortController().signal);
  assert.equal(handshake.headers.get("authorization"), `Bearer ${secret}`);
  assert.equal(handshake.headers.get("x-configured-secret"), secret);

  const frame = await socket.intercept({
    url: "wss://provider.example/v1/responses",
    method: "SEND",
    headers: handshake.headers,
    body: { type: "response.create" },
    transport: "websocket",
    phase: "frame",
  }, new AbortController().signal);
  assert.equal(frame.headersChanged, false);
  assert.deepEqual(frame.body, { type: "response.create" });
});

test("request callbacks transform the final JSON payload and observe the response", async () => {
  const model = {
    id: "callback-model",
    name: "Callback model",
    api: "openai-responses",
    provider: "callback-provider",
    baseUrl: "https://provider.example/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  } satisfies ProviderModel;
  const base = new ProviderWireInterceptorRegistry();
  base.register("callback-provider", {
    interceptRequest(request) {
      return { body: { ...(request.body as Record<string, unknown>), lifecycle: true } };
    },
  });
  let responseStatus: number | undefined;
  const wire = requestWireTransport(base, "callback-provider", undefined, {
    model,
    onPayload(payload, selected) {
      assert.equal(selected, model);
      assert.deepEqual(payload, { original: true, lifecycle: true });
      return { ...(payload as Record<string, unknown>), callback: true };
    },
    onResponse(response, selected) {
      assert.equal(selected, model);
      responseStatus = response.status;
    },
  });
  let posted: unknown;
  const fetch = wire.wrapFetch("callback-provider", async (input, init) => {
    posted = await new Request(input, init).json();
    return new Response("ok", { status: 202 });
  });

  await fetch("https://provider.example/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ original: true }),
  });

  assert.deepEqual(posted, { original: true, lifecycle: true, callback: true });
  assert.equal(responseStatus, 202);
});

test("request callback failures cross provider transports as safe errors", async () => {
  const model = {
    id: "callback-model",
    name: "Callback model",
    api: "openai-responses",
    provider: "callback-provider",
    baseUrl: "https://provider.example/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  } satisfies ProviderModel;

  for (const callback of ["onPayload", "onResponse"] as const) {
    let traps = 0;
    const hostile = new Proxy(Object.create(null) as object, {
      get() {
        traps += 1;
        throw new Error("property trap");
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("descriptor trap");
      },
      getPrototypeOf() {
        traps += 1;
        throw new Error("prototype trap");
      },
      ownKeys() {
        traps += 1;
        throw new Error("keys trap");
      },
    });
    const wire = requestWireTransport(new ProviderWireInterceptorRegistry(), "callback-provider", undefined, {
      model,
      ...(callback === "onPayload"
        ? { onPayload() { throw hostile; } }
        : { onResponse() { throw hostile; } }),
    });
    const fetch = wire.wrapFetch("callback-provider", async () => new Response("ok"));

    let failure: unknown;
    try {
      await fetch("https://provider.example/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ original: true }),
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof Error);
    assert.equal(failure.message, "[Thrown object]");
    assert.equal(traps, 0);
  }
});
