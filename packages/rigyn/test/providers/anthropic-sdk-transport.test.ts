import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicAdapter } from "../../src/providers/anthropic.js";
import { requestAnthropicWithSdk } from "../../src/providers/anthropic-sdk-transport.js";
import { HttpResponseError, MAX_PROVIDER_ERROR_BODY_BYTES } from "../../src/providers/transport.js";
import { byteChunks, collect, fakeFetch, request, streamResponse, terminalCount } from "./helpers.js";

const BASE_URL = "https://api.anthropic.com/v1";

function sse(...values: unknown[]): string {
  return values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
}

test("Anthropic SDK message creation preserves rigyn's wire fields and raw response", async () => {
  const params = {
    model: "claude-test",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: [{
        type: "text",
        text: "sanitized \ufffd text",
        cache_control: { type: "ephemeral", ttl: "1h" },
      }],
    }],
    stream: true,
  };
  const body = JSON.stringify(params);
  let request: Request | undefined;
  const response = await requestAnthropicWithSdk({
    apiKey: "sdk-secret",
    baseUrl: BASE_URL,
    path: "/messages",
    method: "POST",
    headers: new Headers({
      accept: "text/event-stream",
      "anthropic-beta": "prompt-caching-2024-07-31,interleaved-thinking-2025-05-14",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": "sdk-secret",
    }),
    body,
    stream: true,
    signal: new AbortController().signal,
    fetch: fakeFetch((incoming) => {
      request = incoming;
      return new Response("stream-body", { headers: { "x-request-id": "request-1" } });
    }),
  });

  assert.equal(request?.url, `${BASE_URL}/messages`);
  assert.equal(request?.method, "POST");
  assert.equal(request?.redirect, "error");
  assert.deepEqual(JSON.parse(await request!.text()), params);
  assert.deepEqual([...request!.headers.keys()].sort(), [
    "accept",
    "anthropic-beta",
    "anthropic-version",
    "content-type",
    "x-api-key",
  ]);
  assert.equal(response.headers.get("x-request-id"), "request-1");
  assert.equal(await response.text(), "stream-body");
});

test("Anthropic SDK transport disables retries and keeps provider errors bounded", async () => {
  let calls = 0;
  const oversized = "x".repeat(MAX_PROVIDER_ERROR_BODY_BYTES + 1024);

  await assert.rejects(
    requestAnthropicWithSdk({
      apiKey: "sdk-secret",
      baseUrl: BASE_URL,
      path: "/models?limit=100",
      method: "GET",
      headers: new Headers({ accept: "application/json", "anthropic-version": "2023-06-01" }),
      stream: false,
      signal: new AbortController().signal,
      fetch: fakeFetch(() => {
        calls += 1;
        return new Response(oversized, { status: 503, statusText: "Unavailable" });
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof HttpResponseError);
      assert.equal(error.status, 503);
      assert.equal(typeof error.body, "string");
      assert.match(error.body as string, /response body truncated at 65536 bytes/u);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("Anthropic SDK transport unwraps fetch failures and preserves cancellation", async (t) => {
  await t.test("fetch failure", async () => {
    const failure = new TypeError("offline socket failed");
    let calls = 0;
    await assert.rejects(
      requestAnthropicWithSdk({
        apiKey: "sdk-secret",
        baseUrl: BASE_URL,
        path: "/models?limit=100",
        method: "GET",
        headers: new Headers({ accept: "application/json", "anthropic-version": "2023-06-01" }),
        stream: false,
        signal: new AbortController().signal,
        fetch: fakeFetch(() => {
          calls += 1;
          throw failure;
        }),
      }),
      (error: unknown) => error === failure,
    );
    assert.equal(calls, 1);
  });

  await t.test("caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      requestAnthropicWithSdk({
        apiKey: "sdk-secret",
        baseUrl: BASE_URL,
        path: "/models?limit=100",
        method: "GET",
        headers: new Headers({ accept: "application/json", "anthropic-version": "2023-06-01" }),
        stream: false,
        signal: controller.signal,
        fetch: fakeFetch(() => {
          throw new Error("an aborted request must not complete");
        }),
      }),
      { name: "AbortError" },
    );
  });
});

test("Anthropic SDK and direct transports normalize the same complex response identically", async () => {
  const body = sse(
    {
      type: "message_start",
      message: {
        id: "message-shared",
        model: "claude-haiku-4-5-20251001",
        usage: {
          input_tokens: 40,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
        },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hello" } },
    { type: "content_block_stop", index: 1 },
    {
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: "call-1", name: "read", input: {} },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' },
    },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
    { type: "message_stop" },
  );
  const posted: Array<{ url: string; body: unknown }> = [];
  const transport = () => fakeFetch(async (incoming) => {
    posted.push({ url: incoming.url, body: await incoming.json() });
    return streamResponse(byteChunks(body, [1, 2, 3, 5, 8, 13]), {
      "content-type": "text/event-stream",
      "x-request-id": "request-shared",
    });
  });
  const sdk = new AnthropicAdapter({ apiKey: "secret", fetch: transport() });
  const direct = new AnthropicAdapter({
    apiKey: "secret",
    baseUrl: "https://compatible.example/v1",
    fetch: transport(),
  });
  const providerRequest = request("anthropic");
  providerRequest.model = "claude-haiku-4-5-20251001";
  providerRequest.tools = [{
    name: "read",
    description: "Read a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  }];

  const sdkEvents = await collect(sdk.stream(providerRequest, new AbortController().signal));
  const directEvents = await collect(direct.stream(providerRequest, new AbortController().signal));

  assert.equal(posted[0]?.url, `${BASE_URL}/messages`);
  assert.equal(posted[1]?.url, "https://compatible.example/v1/messages");
  assert.deepEqual(posted[0]?.body, posted[1]?.body);
  assert.deepEqual(sdkEvents, directEvents);
});

test("Anthropic transport routing preserves API-key, OAuth, and custom endpoint authentication", async (t) => {
  const terminal = sse(
    {
      type: "message_start",
      message: { id: "message-auth", model: "claude-test", usage: { input_tokens: 1 } },
    },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  );

  await t.test("first-party API key", async () => {
    let incoming: Request | undefined;
    const adapter = new AnthropicAdapter({
      apiKey: "api-secret",
      fetch: fakeFetch((value) => {
        incoming = value;
        return streamResponse(byteChunks(terminal));
      }),
    });
    const events = await collect(adapter.stream(request("anthropic"), new AbortController().signal));
    assert.equal(terminalCount(events), 1);
    assert.equal(incoming?.url, `${BASE_URL}/messages`);
    assert.equal(incoming?.headers.get("x-api-key"), "api-secret");
    assert.equal(incoming?.headers.get("authorization"), null);
  });

  await t.test("first-party OAuth bypass", async () => {
    let incoming: Request | undefined;
    const adapter = new AnthropicAdapter({
      accessToken: "oauth-secret",
      oauth: () => true,
      fetch: fakeFetch((value) => {
        incoming = value;
        return streamResponse(byteChunks(terminal));
      }),
    });
    const events = await collect(adapter.stream(request("anthropic"), new AbortController().signal));
    assert.equal(terminalCount(events), 1);
    assert.equal(incoming?.url, `${BASE_URL}/messages`);
    assert.equal(incoming?.headers.get("authorization"), "Bearer oauth-secret");
    assert.equal(incoming?.headers.get("x-api-key"), null);
    assert.equal(incoming?.headers.get("x-app"), "cli");
  });

  await t.test("custom endpoint bypass", async () => {
    let incoming: Request | undefined;
    const adapter = new AnthropicAdapter({
      apiKey: "custom-secret",
      baseUrl: "https://compatible.example/v1",
      fetch: fakeFetch((value) => {
        incoming = value;
        return streamResponse(byteChunks(terminal));
      }),
    });
    const events = await collect(adapter.stream(request("anthropic"), new AbortController().signal));
    assert.equal(terminalCount(events), 1);
    assert.equal(incoming?.url, "https://compatible.example/v1/messages");
    assert.equal(incoming?.headers.get("x-api-key"), "custom-secret");
    assert.equal(incoming?.headers.get("authorization"), null);
  });
});
