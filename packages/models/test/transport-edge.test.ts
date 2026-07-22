import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.js";
import { stream as streamResponses } from "../src/api/openai-responses.js";
import type { Context, Model, ToolCall } from "../src/types.js";

const responsesModel: Model<"openai-responses"> = {
  id: "response-test", name: "Response Test", api: "openai-responses", provider: "openai", baseUrl: "https://example.invalid/v1",
  reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 1_000,
};
const anthropicModel: Model<"anthropic-messages"> = {
  id: "anthropic-test", name: "Anthropic Test", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://example.invalid",
  reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 1_000,
};
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const sse = (...events: Array<Record<string, unknown>>): Response => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

test("Responses retries terminal early EOF only before semantic output", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? sse({ type: "response.created", response: { id: "first" } })
      : sse({ type: "response.completed", response: { id: "second", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } });
  };
  try {
    const result = await streamResponses(responsesModel, context, { apiKey: "test", maxRetries: 1 }).result();
    assert.equal(calls, 2);
    assert.equal(result.stopReason, "stop");
    assert.equal(result.responseId, "second");
  } finally { globalThis.fetch = original; }
});

test("Responses never retries after emitting partial semantic output", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return sse({ type: "response.output_text.delta", delta: "partial" }); };
  try {
    const result = await streamResponses(responsesModel, context, { apiKey: "test", maxRetries: 3 }).result();
    assert.equal(calls, 1);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /terminal response event.*partial output/u);
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "partial");
  } finally { globalThis.fetch = original; }
});

test("Anthropic sends eager tool input metadata by default and not the legacy beta", async () => {
  const original = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  let headers: Headers | undefined;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    headers = new Headers(init?.headers);
    return sse(
      { type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    );
  };
  try {
    const toolContext: Context = { ...context, tools: [{ name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) }] };
    const result = await streamAnthropic(anthropicModel, toolContext, { apiKey: "test", maxRetries: 0 }).result();
    assert.equal(result.stopReason, "stop");
    const tools = body?.tools as Array<Record<string, unknown>>;
    assert.equal(tools[0]?.eager_input_streaming, true);
    assert.equal(headers?.get("anthropic-beta"), null);
  } finally { globalThis.fetch = original; }
});

test("Anthropic legacy tool streaming is opt-in and absent without tools", async () => {
  const original = globalThis.fetch;
  const observed: Array<string | null> = [];
  globalThis.fetch = async (_input, init) => {
    observed.push(new Headers(init?.headers).get("anthropic-beta"));
    return sse({ type: "message_start", message: { id: "m", usage: {} } }, { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" });
  };
  try {
    const legacy = { ...anthropicModel, compat: { supportsEagerToolInputStreaming: false } };
    await streamAnthropic(legacy, { ...context, tools: [{ name: "read", description: "Read", parameters: Type.Object({}) }] }, { apiKey: "test", maxRetries: 0 }).result();
    await streamAnthropic(legacy, context, { apiKey: "test", maxRetries: 0 }).result();
    assert.deepEqual(observed, ["fine-grained-tool-streaming-2025-05-14", null]);
  } finally { globalThis.fetch = original; }
});

test("Anthropic repairs malformed SSE and partial tool JSON", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    `data: ${JSON.stringify({ type: "message_start", message: { id: "m", usage: { input_tokens: 1 } } })}\n\n`,
    `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call", name: "edit", input: {} } })}\n\n`,
    String.raw`data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"A\H\",\"text\":\"col1` + "\t" + String.raw`col2\"}"}}` + "\n\n",
    `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } })}\n\n`,
    `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  try {
    const result = await streamAnthropic(anthropicModel, { ...context, tools: [{ name: "edit", description: "Edit", parameters: Type.Object({ path: Type.String(), text: Type.String() }) }] }, { apiKey: "test", maxRetries: 0 }).result();
    assert.equal(result.stopReason, "toolUse");
    const call = result.content.find((block): block is ToolCall => block.type === "toolCall");
    assert.deepEqual(call?.arguments, { path: "A\\H", text: "col1\tcol2" });
  } finally { globalThis.fetch = original; }
});

test("Anthropic refusal details and redacted reasoning survive normalization", async () => {
  const original = globalThis.fetch;
  let mode: "redacted" | "refusal" = "redacted";
  globalThis.fetch = async () => mode === "redacted"
    ? sse(
      { type: "message_start", message: { id: "m", usage: {} } },
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "opaque" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" },
    )
    : sse(
      { type: "message_start", message: { id: "m", usage: {} } },
      { type: "message_delta", delta: { stop_reason: "refusal", stop_details: { explanation: "blocked by policy" } } }, { type: "message_stop" },
    );
  try {
    const redacted = await streamAnthropic(anthropicModel, context, { apiKey: "test", maxRetries: 0 }).result();
    assert.deepEqual(redacted.content, [{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque", redacted: true }]);
    mode = "refusal";
    const refused = await streamAnthropic(anthropicModel, context, { apiKey: "test", maxRetries: 0 }).result();
    assert.equal(refused.stopReason, "error");
    assert.equal(refused.errorMessage, "blocked by policy");
  } finally { globalThis.fetch = original; }
});
