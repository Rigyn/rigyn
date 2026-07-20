import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "../../src/core/json.js";
import type { FetchLike } from "../../src/providers/transport.js";
import {
  ProviderWireInterceptorRegistry,
  type ProviderWireRequest,
  type ProviderWireResponse,
} from "../../src/providers/wire.js";

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
