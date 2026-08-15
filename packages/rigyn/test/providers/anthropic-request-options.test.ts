import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicAdapter } from "../../src/providers/anthropic.js";
import { byteChunks, collect, fakeFetch, request, streamResponse, terminalCount } from "./helpers.js";

function completed(model = "claude-test"): Response {
  const events = [
    { type: "message_start", message: { id: "message", model, usage: { input_tokens: 1 } } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return streamResponse(byteChunks(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
}

test("Anthropic maps per-call tool choice, temperature, cache retention, and affinity", async () => {
  let body: Record<string, unknown> | undefined;
  let headers: Headers | undefined;
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    promptCache: "off",
    fetch: fakeFetch(async (incoming) => {
      body = await incoming.json() as Record<string, unknown>;
      headers = incoming.headers;
      return completed();
    }),
  });
  const input = request("anthropic");
  input.tools = [{ name: "read", description: "Read", inputSchema: { type: "object" } }];
  input.toolChoice = "required";
  input.temperature = 0;
  input.cacheRetention = "long";
  input.sessionId = "session-affinity";
  input.modelSettings = {
    compatibility: {
      supportsLongCacheRetention: true,
      sendSessionAffinityHeaders: true,
    },
  };

  const events = await collect(adapter.stream(input, new AbortController().signal));

  assert.equal(terminalCount(events), 1);
  assert.deepEqual(body?.tool_choice, { type: "any" });
  assert.equal(body?.temperature, 0);
  assert.deepEqual((body?.tools as Array<Record<string, unknown>>)[0]?.cache_control, {
    type: "ephemeral",
    ttl: "1h",
  });
  assert.equal(headers?.get("x-session-affinity"), "session-affinity");
});

test("Anthropic sends an explicit disabled tool choice", async () => {
  let body: Record<string, unknown> | undefined;
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    fetch: fakeFetch(async (incoming) => {
      body = await incoming.json() as Record<string, unknown>;
      return completed();
    }),
  });
  const input = request("anthropic");
  input.tools = [{ name: "read", description: "Read", inputSchema: { type: "object" } }];
  input.toolChoice = "none";

  const events = await collect(adapter.stream(input, new AbortController().signal));

  assert.equal(terminalCount(events), 1);
  assert.deepEqual(body?.tool_choice, { type: "none" });
});

test("Anthropic compatibility safely downgrades unsupported request options", async () => {
  let body: Record<string, unknown> | undefined;
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    fetch: fakeFetch(async (incoming) => {
      body = await incoming.json() as Record<string, unknown>;
      return completed("claude-opus-4-7");
    }),
  });
  const input = request("anthropic");
  input.model = "claude-opus-4-7";
  input.messages.unshift({
    id: "system",
    role: "system",
    content: [{ type: "text", text: "Stable instructions" }],
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  input.tools = [{ name: "read", description: "Read", inputSchema: { type: "object" } }];
  input.toolChoice = { type: "function", function: { name: "read" } };
  input.temperature = 0;
  input.cacheRetention = "long";
  input.modelSettings = {
    compatibility: {
      supportsLongCacheRetention: false,
      supportsCacheControlOnTools: false,
    },
  };

  const events = await collect(adapter.stream(input, new AbortController().signal));

  assert.equal(terminalCount(events), 1);
  assert.equal(body?.temperature, undefined);
  assert.deepEqual(body?.tool_choice, { type: "tool", name: "read" });
  assert.equal((body?.tools as Array<Record<string, unknown>>)[0]?.cache_control, undefined);
  assert.deepEqual((body?.system as Array<Record<string, unknown>>)[0]?.cache_control, { type: "ephemeral" });
});

test("Anthropic reuses the tool breakpoint slot when tool cache markers are unsupported", async () => {
  let body: Record<string, unknown> | undefined;
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    fetch: fakeFetch(async (incoming) => {
      body = await incoming.json() as Record<string, unknown>;
      return completed();
    }),
  });
  const input = request("anthropic");
  input.messages = [
    {
      id: "system",
      role: "system",
      content: [{ type: "text", text: "Stable instructions" }],
      createdAt: "2026-07-20T00:00:00.000Z",
    },
    {
      id: "history",
      role: "user",
      content: Array.from({ length: 65 }, (_, index) => ({
        type: "text" as const,
        text: `history-${index}`,
      })),
      createdAt: "2026-07-20T00:01:00.000Z",
    },
    {
      id: "answer",
      role: "assistant",
      content: [{ type: "text", text: "Stable answer" }],
      createdAt: "2026-07-20T00:02:00.000Z",
      provider: "anthropic",
      model: "test-model",
    },
    {
      id: "current",
      role: "user",
      content: [{ type: "text", text: "Current request" }],
      createdAt: "2026-07-20T00:03:00.000Z",
    },
  ];
  input.tools = [{ name: "read", description: "Read", inputSchema: { type: "object" } }];
  input.modelSettings = { compatibility: { supportsCacheControlOnTools: false } };

  await collect(adapter.stream(input, new AbortController().signal));

  assert.equal((body?.tools as Array<Record<string, unknown>>)[0]?.cache_control, undefined);
  const messages = body?.messages as Array<{ content: Array<Record<string, unknown>> }>;
  const marked = messages.flatMap((message) => message.content)
    .filter((block) => block.cache_control !== undefined);
  assert.equal(marked.length, 3);
  assert.equal(messages.at(-1)?.content.some((block) => block.cache_control !== undefined), false);
});

test("Anthropic emits strict tools only when the model advertises support", async () => {
  let body: Record<string, unknown> | undefined;
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    fetch: fakeFetch(async (incoming) => {
      body = await incoming.json() as Record<string, unknown>;
      return completed();
    }),
  });
  const supported = request("anthropic");
  supported.tools = [{
    name: "strict_tool",
    description: "Strict",
    inputSchema: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
    constrainedSampling: { type: "json_schema", strict: "require" },
  }];
  supported.modelSettings = { compatibility: { supportsStrictTools: true } };
  const events = await collect(adapter.stream(supported, new AbortController().signal));
  assert.equal(events.at(-1)?.type, "response_end");
  assert.equal((body?.tools as Array<Record<string, unknown>>)[0]?.strict, true);

  let fetched = false;
  const unsupportedAdapter = new AnthropicAdapter({
    apiKey: "secret",
    fetch: fakeFetch(() => {
      fetched = true;
      return completed();
    }),
  });
  const unsupported = request("anthropic");
  unsupported.tools = supported.tools;
  unsupported.modelSettings = { compatibility: { supportsStrictTools: false } };
  const unsupportedEvents = await collect(
    unsupportedAdapter.stream(unsupported, new AbortController().signal),
  );
  assert.equal(fetched, false);
  const error = unsupportedEvents.at(-1);
  assert.equal(error?.type, "error");
  assert.match(error?.type === "error" ? error.error.message : "", /requires strict JSON-schema sampling/u);
});

test("Anthropic rejects invalid per-call temperature without making a request", async () => {
  let called = false;
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    fetch: fakeFetch(() => {
      called = true;
      return completed();
    }),
  });
  const input = request("anthropic");
  input.temperature = 1.1;

  const events = await collect(adapter.stream(input, new AbortController().signal));

  assert.equal(called, false);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  assert.match(terminal?.type === "error" ? terminal.error.message : "", /temperature must be between 0 and 1/u);
});

test("Anthropic streams refusal blocks and retains bounded stop details", async () => {
  const wire = [
    { type: "message_start", message: { id: "refusal", model: "claude-test", usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "refusal", refusal: "I cannot" } },
    { type: "content_block_delta", index: 0, delta: { type: "refusal_delta", refusal: " help with that" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "refusal", stop_details: { explanation: "Safety policy" } },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ];
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    fetch: fakeFetch(() => streamResponse(byteChunks(
      wire.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    ))),
  });

  const events = await collect(adapter.stream(request("anthropic"), new AbortController().signal));
  assert.deepEqual(
    events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.text : ""),
    ["I cannot", " help with that"],
  );
  const terminal = events.at(-1);
  assert.equal(terminal?.type === "response_end" ? terminal.reason : undefined, "refusal");
  assert.equal(terminal?.type === "response_end" ? terminal.explanation : undefined, "Safety policy");
  assert.deepEqual(
    terminal?.type === "response_end" && terminal.state.kind === "anthropic_messages"
      ? terminal.state.assistantBlocks[0]
      : undefined,
    { type: "refusal", refusal: "I cannot help with that" },
  );
});

test("Anthropic requests summarized thinking and exposes only that display text", async () => {
  const wire = [
    { type: "message_start", message: { id: "summary", model: "claude-test", usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check the change." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-signature" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  let body: Record<string, unknown> | undefined;
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    fetch: fakeFetch(async (incoming) => {
      body = await incoming.json() as Record<string, unknown>;
      return streamResponse(byteChunks(wire.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
    }),
  });
  const input = request("anthropic");
  input.reasoningEffort = "high";
  input.maxOutputTokens = 4_096;

  const events = await collect(adapter.stream(input, new AbortController().signal));

  assert.deepEqual(body?.thinking, { type: "enabled", budget_tokens: 3_072, display: "summarized" });
  assert.deepEqual(events.filter((event) => event.type === "reasoning_delta"), [
    { type: "reasoning_delta", part: 0, text: "Check the change.", visibility: "summary" },
  ]);
  const terminal = events.at(-1);
  assert.deepEqual(
    terminal?.type === "response_end" && terminal.state.kind === "anthropic_messages"
      ? terminal.state.assistantBlocks[0]
      : undefined,
    { type: "thinking", thinking: "Check the change.", signature: "opaque-signature" },
  );
});

test("Anthropic-compatible endpoints omit unsupported display fields but expose requested plaintext thinking", async () => {
  const wire = [
    { type: "message_start", message: { id: "compatible", model: "compatible-model", usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "Inspect safely." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  let body: Record<string, unknown> | undefined;
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(async (incoming) => {
      body = await incoming.json() as Record<string, unknown>;
      return streamResponse(byteChunks(wire.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
    }),
  });
  const input = request("compatible");
  input.reasoningEffort = "high";
  input.maxOutputTokens = 4_096;

  const events = await collect(adapter.stream(input, new AbortController().signal));

  assert.deepEqual(body?.thinking, { type: "enabled", budget_tokens: 3_072 });
  assert.deepEqual(events.filter((event) => event.type === "reasoning_delta"), [
    { type: "reasoning_delta", part: 0, text: "Inspect safely.", visibility: "summary" },
  ]);
});

test("Anthropic surfaces redacted reasoning and sensitive-content stops", async () => {
  const wire = [
    { type: "message_start", message: { id: "sensitive", model: "claude-test", usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "provider thought" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "sensitive" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    fetch: fakeFetch(() => streamResponse(byteChunks(
      wire.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    ))),
  });

  const events = await collect(adapter.stream(request("anthropic"), new AbortController().signal));
  assert.deepEqual(events.filter((event) => event.type === "reasoning_delta"), [
    { type: "reasoning_delta", part: 0, text: "provider thought", visibility: "summary" },
    { type: "reasoning_delta", part: 1, text: "[Reasoning redacted]", visibility: "provider_trace" },
  ]);
  const terminal = events.at(-1);
  assert.equal(terminal?.type === "response_end" ? terminal.reason : undefined, "content_filter");
  assert.equal(
    terminal?.type === "response_end" ? terminal.explanation : undefined,
    "The provider blocked sensitive content",
  );
  assert.deepEqual(
    terminal?.type === "response_end" && terminal.state.kind === "anthropic_messages"
      ? terminal.state.assistantBlocks
      : undefined,
    [
      { type: "thinking", thinking: "provider thought" },
      { type: "redacted_thinking", data: "opaque" },
    ],
  );
});
