import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "../../src/core/json.js";
import type { FetchLike } from "../../src/providers/transport.js";
import {
  ProviderWireInterceptorRegistry,
  type ProviderWireAfterResponse,
  type ProviderWireLifecycleScope,
  type ProviderWireRequest,
  type ProviderWireResponse,
} from "../../src/providers/wire.js";

const lifecycleScope = (runId: string, step = 3): ProviderWireLifecycleScope => ({
  threadId: `thread-${runId}`,
  runId,
  branch: `branch-${runId}`,
  step,
});

test("provider wire interceptors patch JSON requests without exposing request credentials", async () => {
  const registry = new ProviderWireInterceptorRegistry();
  let observedRequest: ProviderWireRequest | undefined;
  let observedResponse: ProviderWireResponse | undefined;
  let transportedBody: JsonValue | undefined;
  let transportedHeaders: Headers | undefined;
  const transport: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    transportedHeaders = request.headers;
    transportedBody = JSON.parse(await request.text()) as JsonValue;
    return new Response("ok", {
      status: 201,
      statusText: "Created",
      headers: {
        "set-cookie": "session=response-secret",
        "x-provider-request-id": "request-1",
      },
    });
  };

  registry.register("anthropic", {
    interceptRequest(request) {
      observedRequest = request;
      return {
        body: { model: "patched-model", stream: true },
        headers: {
          "x-remove": null,
          "x-wire-added": "added",
        },
      };
    },
    observeResponse(response) {
      observedResponse = response;
    },
  });

  const fetch = registry.wrapFetch("anthropic", transport);
  const response = await fetch("https://provider.example/messages?key=query-secret&view=full", {
    method: "POST",
    headers: {
      authorization: "Bearer request-secret",
      "content-type": "application/json",
      "x-api-key": "request-api-key",
      "x-remove": "remove-me",
      "x-visible": "visible",
    },
    body: JSON.stringify({ model: "original-model" }),
  });

  assert.equal(response.status, 201);
  assert.equal(observedRequest?.headers.authorization, undefined);
  assert.equal(observedRequest?.headers["x-api-key"], undefined);
  assert.equal(observedRequest?.headers["x-visible"], "visible");
  assert.equal(observedRequest?.url.includes("query-secret"), false);
  assert.equal(observedRequest?.url.includes("key=%5Bredacted%5D"), true);
  assert.deepEqual(observedRequest?.body, { model: "original-model" });

  assert.equal(transportedHeaders?.get("authorization"), "Bearer request-secret");
  assert.equal(transportedHeaders?.get("x-api-key"), "request-api-key");
  assert.equal(transportedHeaders?.get("x-remove"), null);
  assert.equal(transportedHeaders?.get("x-wire-added"), "added");
  assert.deepEqual(transportedBody, { model: "patched-model", stream: true });

  assert.equal(observedResponse?.status, 201);
  assert.equal(observedResponse?.statusText, "Created");
  assert.equal(observedResponse?.headers["set-cookie"], "session=response-secret");
  assert.equal(observedResponse?.headers["x-provider-request-id"], "request-1");
});

test("provider wire base URL patches preserve private query values without exposing them", async () => {
  const registry = new ProviderWireInterceptorRegistry();
  let observedUrl = "";
  let transportedUrl = "";
  registry.register("gemini", {
    interceptRequest(request) {
      observedUrl = request.url;
      return { baseUrl: "https://gateway.example/proxy", headers: { "x-route": "edge" } };
    },
  });
  const wrapped = registry.wrapFetch("gemini", async (input, init) => {
    const request = new Request(input, init);
    transportedUrl = request.url;
    assert.equal(request.headers.get("x-route"), "edge");
    return new Response("ok");
  });

  await wrapped("https://provider.example/v1/models?key=private-value&alt=sse", { method: "GET" });
  assert.equal(observedUrl.includes("private-value"), false);
  assert.equal(transportedUrl, "https://gateway.example/proxy/v1/models?key=private-value&alt=sse");
});

test("provider wire registration disposers remove only their interceptor", async () => {
  const registry = new ProviderWireInterceptorRegistry();
  const calls: string[] = [];
  const first = registry.register("openai", {
    interceptRequest() {
      calls.push("first");
      return { headers: { "x-first": "yes" } };
    },
  });
  registry.register("openai", {
    interceptRequest(request) {
      calls.push(`second:${request.headers["x-first"] ?? "missing"}`);
    },
  });
  const transport: FetchLike = async () => new Response("ok");
  const fetch = registry.wrapFetch("openai", transport);

  await fetch("https://provider.example/responses", { method: "POST" });
  first();
  first();
  await fetch("https://provider.example/responses", { method: "POST" });

  assert.deepEqual(calls, ["first", "second:yes", "second:missing"]);
});

test("provider wire interceptors reject non-JSON body patches", async () => {
  const registry = new ProviderWireInterceptorRegistry();
  registry.register("openai", {
    interceptRequest() {
      return { body: undefined as unknown as JsonValue };
    },
  });
  let transported = false;
  const fetch = registry.wrapFetch("openai", async () => {
    transported = true;
    return new Response("ok");
  });

  await assert.rejects(
    fetch("https://provider.example/responses", { method: "POST", body: "{}" }),
    /body patch must be JSON/u,
  );
  assert.equal(transported, false);
});

test("provider wire lifecycle phases compose in order and reach the transport before body consumption", async () => {
  const registry = new ProviderWireInterceptorRegistry();
  const phases: string[] = [];
  const lifecycleResponses: ProviderWireAfterResponse[] = [];
  let transportedHeaders: Headers | undefined;
  let transportedBody: JsonValue | undefined;

  registry.registerLifecycle({
    beforeHeaders(request) {
      phases.push("headers:first");
      assert.equal(request.runId, "run-order");
      assert.equal(request.headers.authorization, "Bearer request-secret");
      assert.equal(request.headers["x-api-key"], "request-key-secret");
      assert.equal(request.url.includes("query-secret"), false);
      return {
        headers: {
          authorization: "Bearer lifecycle-replacement",
          "x-api-key": null,
          "x-first": "one",
          "x-remove": null,
        },
      };
    },
    beforeRequest(request) {
      phases.push("request:first");
      assert.equal(request.headers["x-first"], "one");
      assert.equal(request.headers.authorization, "Bearer lifecycle-replacement");
      assert.equal(request.headers["x-api-key"], undefined);
      assert.deepEqual(request.body, { model: "original" });
      (request.body as { model: string }).model = "detached-mutation";
      return { body: { model: "first" } };
    },
    afterResponse(response) {
      phases.push("response:first");
      lifecycleResponses.push(response);
    },
  });
  registry.registerLifecycle({
    beforeHeaders(request) {
      phases.push("headers:second");
      assert.equal(request.headers["x-first"], "one");
      return { headers: { "x-second": "two" } };
    },
    beforeRequest(request) {
      phases.push("request:second");
      assert.deepEqual(request.body, { model: "first" });
      return { body: { model: "second" } };
    },
    afterResponse() {
      phases.push("response:second");
    },
  });
  registry.register("anthropic", {
    interceptRequest(request) {
      phases.push("legacy:request");
      assert.equal(request.headers["x-second"], "two");
      assert.deepEqual(request.body, { model: "second" });
    },
    observeResponse(response) {
      phases.push("legacy:response");
      assert.equal(response.headers["set-cookie"], "session=response-secret");
    },
  });

  const wrapped = registry.wrapFetch("anthropic", async (input, init) => {
    phases.push("fetch");
    const request = new Request(input, init);
    transportedHeaders = request.headers;
    transportedBody = JSON.parse(await request.text()) as JsonValue;
    return new Response("body-not-consumed-by-observers", {
      status: 202,
      headers: {
        authorization: "response-auth-secret",
        "set-cookie": "session=response-secret",
        "x-request-id": "safe-id",
      },
    });
  });

  const response = await registry.withScope(lifecycleScope("run-order"), () => wrapped(
    "https://provider.example/messages?api_key=query-secret&view=full",
    {
      method: "POST",
      headers: {
        authorization: "Bearer request-secret",
        "content-type": "application/json",
        "x-api-key": "request-key-secret",
        "x-remove": "delete-me",
      },
      body: JSON.stringify({ model: "original" }),
    },
  ));
  phases.push("body");
  assert.equal(await response.text(), "body-not-consumed-by-observers");

  assert.deepEqual(phases, [
    "headers:first",
    "headers:second",
    "request:first",
    "request:second",
    "legacy:request",
    "fetch",
    "response:first",
    "response:second",
    "legacy:response",
    "body",
  ]);
  assert.equal(transportedHeaders?.get("x-remove"), null);
  assert.equal(transportedHeaders?.get("x-first"), "one");
  assert.equal(transportedHeaders?.get("x-second"), "two");
  assert.equal(transportedHeaders?.get("authorization"), "Bearer lifecycle-replacement");
  assert.equal(transportedHeaders?.get("x-api-key"), null);
  assert.deepEqual(transportedBody, { model: "second" });
  assert.equal(lifecycleResponses.length, 1);
  assert.equal(lifecycleResponses[0]?.headers.authorization, "response-auth-secret");
  assert.equal(lifecycleResponses[0]?.headers["set-cookie"], "session=response-secret");
  assert.equal(lifecycleResponses[0]?.headers["x-request-id"], "safe-id");
  assert.equal(lifecycleResponses[0]?.url.includes("query-secret"), false);
  assert.equal("body" in lifecycleResponses[0]!, false);
});

test("provider wire lifecycle scopes remain isolated across nested and concurrent operations", async () => {
  const registry = new ProviderWireInterceptorRegistry();
  const observed: string[] = [];
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  let blockedOnce = false;
  const firstReady = new Promise<void>((resolve) => { firstEntered = resolve; });
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });

  registry.registerLifecycle({
    async beforeRequest(request) {
      observed.push(`start:${request.runId}:${request.step}`);
      if (!blockedOnce) {
        blockedOnce = true;
        firstEntered();
        await firstBlocked;
      }
      observed.push(`end:${request.runId}:${request.step}`);
      return { body: { runId: request.runId, step: request.step } };
    },
  });
  const transported: JsonValue[] = [];
  const wrapped = registry.wrapFetch("openai", async (input, init) => {
    transported.push(JSON.parse(await new Request(input, init).text()) as JsonValue);
    return new Response("ok");
  });

  const first = registry.withScope(lifecycleScope("run-first", 1), () => wrapped(
    "https://provider.example/responses",
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  ));
  await firstReady;
  const second = registry.withScope(lifecycleScope("run-second", 2), async () => {
    await wrapped("https://provider.example/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await registry.withScope(lifecycleScope("run-nested", 9), () => wrapped(
      "https://provider.example/responses",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ));
    await wrapped("https://provider.example/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  });
  await second;
  releaseFirst();
  await first;

  assert.deepEqual(observed, [
    "start:run-first:1",
    "start:run-second:2",
    "end:run-second:2",
    "start:run-nested:9",
    "end:run-nested:9",
    "start:run-second:2",
    "end:run-second:2",
    "end:run-first:1",
  ]);
  assert.deepEqual(transported, [
    { runId: "run-second", step: 2 },
    { runId: "run-nested", step: 9 },
    { runId: "run-second", step: 2 },
    { runId: "run-first", step: 1 },
  ]);
});

test("provider wire lifecycle observers are scoped, disposable, and do not disturb legacy interception", async () => {
  const registry = new ProviderWireInterceptorRegistry();
  const calls: string[] = [];
  const dispose = registry.registerLifecycle({
    beforeHeaders() {
      calls.push("lifecycle");
      return { headers: { "x-lifecycle": "yes" } };
    },
  });
  registry.register("openai", {
    interceptRequest() {
      calls.push("legacy");
      return { headers: { "x-legacy": "yes" } };
    },
  });
  const headers: Headers[] = [];
  const wrapped = registry.wrapFetch("openai", async (input, init) => {
    headers.push(new Request(input, init).headers);
    return new Response("ok");
  });

  await wrapped("https://provider.example/responses");
  await registry.withScope(lifecycleScope("run-scoped"), () => wrapped("https://provider.example/responses"));
  dispose();
  dispose();
  await registry.withScope(lifecycleScope("run-disposed"), () => wrapped("https://provider.example/responses"));

  assert.deepEqual(calls, ["legacy", "lifecycle", "legacy", "legacy"]);
  assert.equal(headers[0]?.get("x-lifecycle"), null);
  assert.equal(headers[0]?.get("x-legacy"), "yes");
  assert.equal(headers[1]?.get("x-lifecycle"), "yes");
  assert.equal(headers[2]?.get("x-lifecycle"), null);
});

test("provider wire lifecycle validates scopes, header patches, JSON patches, and aborts", async () => {
  const invalidScope = new ProviderWireInterceptorRegistry();
  assert.throws(
    () => invalidScope.withScope({ ...lifecycleScope("bad"), step: -1 }, () => undefined),
    /non-negative safe integer/u,
  );
  assert.throws(
    () => invalidScope.registerLifecycle({ beforeHeaders: "invalid" as never }),
    /callbacks must be functions/u,
  );

  let transported = 0;
  const transport: FetchLike = async () => {
    transported += 1;
    return new Response("ok");
  };
  const invalidHeaders = new ProviderWireInterceptorRegistry();
  invalidHeaders.registerLifecycle({
    beforeHeaders() {
      return { headers: { "x-invalid": 1 as never } };
    },
  });
  await assert.rejects(
    invalidHeaders.withScope(lifecycleScope("bad-headers"), () => invalidHeaders.wrapFetch("openai", transport)(
      "https://provider.example/responses",
    )),
    /strings or null/u,
  );

  const invalidBody = new ProviderWireInterceptorRegistry();
  invalidBody.registerLifecycle({
    beforeRequest() {
      return { body: undefined as never };
    },
  });
  await assert.rejects(
    invalidBody.withScope(lifecycleScope("bad-body"), () => invalidBody.wrapFetch("openai", transport)(
      "https://provider.example/responses",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    )),
    /must contain JSON body/u,
  );

  const aborted = new ProviderWireInterceptorRegistry();
  let lifecycleCalls = 0;
  aborted.registerLifecycle({ beforeHeaders() { lifecycleCalls += 1; } });
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(
    aborted.withScope(lifecycleScope("aborted"), () => aborted.wrapFetch("openai", transport)(
      "https://provider.example/responses",
      { signal: controller.signal },
    )),
    /stop|aborted/iu,
  );
  assert.equal(lifecycleCalls, 0);
  assert.equal(transported, 0);
});

test("provider wire lifecycle scopes are captured by WebSocket operations without exposing frames", async () => {
  const registry = new ProviderWireInterceptorRegistry();
  const calls: string[] = [];
  registry.registerLifecycle({
    beforeHeaders(request) {
      calls.push(`headers:${request.runId}:${request.transport}:${request.phase}`);
      return request.phase === "handshake" ? { headers: { "x-socket": "yes" } } : undefined;
    },
    beforeRequest(request) {
      calls.push(`request:${request.runId}:${request.transport}:${request.phase}`);
      return { body: { ...request.body as Record<string, JsonValue>, scoped: request.runId } };
    },
    afterResponse(response) {
      calls.push(`response:${response.runId}:${response.transport}:${response.phase}:${response.frame?.bytes ?? 0}`);
      assert.equal("body" in response, false);
    },
  });

  const handshake = registry.withScope(lifecycleScope("socket"), () => registry.begin("openai-codex"));
  const preparedHandshake = await handshake.intercept({
    url: "wss://provider.example/responses?token=secret",
    method: "GET",
    headers: new Headers({ authorization: "Bearer secret" }),
    transport: "websocket",
    phase: "handshake",
  }, new AbortController().signal);
  assert.equal(preparedHandshake.headers.get("x-socket"), "yes");
  await handshake.observe({
    url: "wss://provider.example/responses?token=secret",
    status: 101,
    statusText: "Switching Protocols",
    headers: {},
    transport: "websocket",
    phase: "open",
  }, new AbortController().signal);

  const frame = registry.withScope(lifecycleScope("socket"), () => registry.begin("openai-codex"));
  const preparedFrame = await frame.intercept({
    url: "wss://provider.example/responses?token=secret",
    method: "SEND",
    headers: new Headers({ authorization: "Bearer secret" }),
    body: { type: "response.create" },
    transport: "websocket",
    phase: "frame",
  }, new AbortController().signal);
  assert.deepEqual(preparedFrame.body, { type: "response.create", scoped: "socket" });
  await frame.observe({
    url: "wss://provider.example/responses?token=secret",
    status: 101,
    statusText: "WebSocket Message",
    headers: { "set-cookie": "secret", "x-visible": "yes" },
    transport: "websocket",
    phase: "frame",
    frame: { direction: "receive", bytes: 42, type: "response.done" },
  }, new AbortController().signal);

  assert.deepEqual(calls, [
    "headers:socket:websocket:handshake",
    "response:socket:websocket:open:0",
    "headers:socket:websocket:frame",
    "request:socket:websocket:frame",
    "response:socket:websocket:frame:42",
  ]);
});
