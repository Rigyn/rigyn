import assert from "node:assert/strict";
import test from "node:test";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.js";
import { stream as streamResponses } from "../src/api/openai-responses.js";
import type { AssistantMessage, Context, Model, ToolCall } from "../src/types.js";

const responsesModel: Model<"openai-responses"> = {
  id: "portable-responses", name: "Portable Responses", api: "openai-responses", provider: "openai", baseUrl: "https://example.invalid/v1",
  reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 1_000,
};
const anthropicModel: Model<"anthropic-messages"> = {
  id: "portable-anthropic", name: "Portable Anthropic", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://example.invalid",
  reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 1_000,
};
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

function rawSse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
}
function sse(...events: Array<Record<string, unknown>>): Response {
  return rawSse(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}
function opaqueState(message: AssistantMessage): {
  source: { api: string; provider: string; model: string };
  value: { outputItems?: unknown[]; assistantBlocks?: unknown[]; unknownEvents?: unknown[] };
} | undefined {
  return (message as AssistantMessage & { providerState?: ReturnType<typeof opaqueState> }).providerState;
}

test("provider diagnostics retain safe response metadata and structured failure fields", async () => {
  const result = await streamResponses(responsesModel, context, {
    apiKey: "sk-secret-request-key", maxRetries: 0,
    fetch: async () => new Response("capacity unavailable", {
      status: 429,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_safe_123",
        "retry-after": "2",
        authorization: "Bearer response-secret",
        "set-cookie": "session=response-secret",
        "x-internal-secret": "response-secret",
      },
    }),
  }).result();

  assert.equal(result.stopReason, "error");
  const diagnostic = result.diagnostics?.find((entry) => entry.type === "provider_failure");
  assert.equal(diagnostic?.details?.category, "rate_limit");
  assert.equal(diagnostic?.details?.retryable, true);
  assert.equal(diagnostic?.details?.partial, false);
  assert.equal(diagnostic?.details?.requestId, "req_safe_123");
  assert.deepEqual(diagnostic?.details?.response, {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "2", "x-request-id": "req_safe_123" },
  });
  const serialized = JSON.stringify(result.diagnostics);
  assert.doesNotMatch(serialized, /sk-secret-request-key|response-secret|authorization|set-cookie|x-internal-secret/u);
});

test("complete malformed SSE is a protocol failure while a truncated final frame is retryable", async (t) => {
  for (const [name, stream] of [
    ["Responses", streamResponses] as const,
    ["Anthropic", streamAnthropic] as const,
  ]) {
    await t.test(`${name}: complete malformed frame`, async () => {
      let calls = 0;
      const result = await stream(name === "Responses" ? responsesModel : anthropicModel, context, {
        apiKey: "test", maxRetries: 2,
        fetch: async () => { calls += 1; return rawSse('data: {"type":\n\n'); },
      } as never).result();
      assert.equal(calls, 1);
      assert.equal(result.stopReason, "error");
      const failure = result.diagnostics?.find((entry) => entry.type === "provider_failure");
      assert.equal(failure?.details?.category, "protocol");
      assert.equal(failure?.details?.retryable, false);
      assert.equal(failure?.details?.bodyStarted, true);
    });

    await t.test(`${name}: truncated final frame`, async () => {
      let calls = 0;
      const result = await stream(name === "Responses" ? responsesModel : anthropicModel, context, {
        apiKey: "test", maxRetries: 1,
        fetch: async () => {
          calls += 1;
          if (calls === 1) return rawSse('data: {"type":"metadata');
          return name === "Responses"
            ? sse({ type: "response.completed", response: { id: "recovered", usage: {} } })
            : sse({ type: "message_start", message: { id: "recovered", usage: {} } }, { type: "message_stop" });
        },
      } as never).result();
      assert.equal(calls, 2);
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(result.responseId, "recovered");
    });
  }
});

test("Anthropic retries metadata-only EOF without leaking abandoned metadata", async () => {
  let calls = 0;
  const result = await streamAnthropic(anthropicModel, context, {
    apiKey: "test", maxRetries: 1,
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? sse({ type: "message_start", message: { id: "abandoned", model: "old", usage: { input_tokens: 99 } } })
        : sse(
          { type: "message_start", message: { id: "recovered", model: "new", usage: { input_tokens: 3 } } },
          { type: "message_stop" },
        );
    },
  }).result();
  assert.equal(calls, 2);
  assert.equal(result.responseId, "recovered");
  assert.equal(result.responseModel, "new");
  assert.equal(result.usage.input, 3);
});

test("Responses routes interleaved output by output index and retains unknown wire state", async () => {
  const firstMessage = { type: "message", id: "message_0", content: [{ type: "output_text", text: "first" }], vendor: { stable: true } };
  const secondMessage = { type: "message", id: "message_1", content: [{ type: "output_text", text: "second" }] };
  const functionCall = { type: "function_call", id: "fc_2", call_id: "call_2", name: "read", arguments: '{"path":"README.md"}' };
  const unknownItem = { type: "future_output", id: "future_3", payload: { exact: [1, "two", false] } };
  const unknownEvent = { type: "response.future_event", output_index: 3, hidden_reasoning: "must-not-become-a-diagnostic" };
  let payload: Record<string, unknown> | undefined;
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    calls += 1;
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (calls > 1) return sse({ type: "response.completed", response: { usage: {} } });
    return sse(
      { type: "response.output_item.added", output_index: 0, item: { ...firstMessage, content: [] } },
      { type: "response.output_item.added", output_index: 1, item: { ...secondMessage, content: [] } },
      { type: "response.output_item.added", output_index: 2, item: { ...functionCall, arguments: "" } },
      { type: "response.output_text.delta", output_index: 1, item_id: "message_1", content_index: 0, delta: "second" },
      { type: "response.output_text.delta", output_index: 0, item_id: "message_0", content_index: 0, delta: "first" },
      { type: "response.function_call_arguments.delta", output_index: 2, delta: functionCall.arguments },
      { type: "response.output_item.done", output_index: 1, item: secondMessage },
      { type: "response.output_item.done", output_index: 0, item: firstMessage },
      { type: "response.output_item.done", output_index: 2, item: functionCall },
      { type: "response.output_item.done", output_index: 3, item: unknownItem },
      unknownEvent,
      { type: "response.completed", response: { id: "first", usage: {} } },
    );
  };

  const first = await streamResponses(responsesModel, context, { apiKey: "test", fetch, maxRetries: 0 }).result();
  assert.deepEqual(first.content.filter((block) => block.type === "text").map((block) => block.text), ["first", "second"]);
  const call = first.content.find((block): block is ToolCall => block.type === "toolCall");
  assert.deepEqual(call?.arguments, { path: "README.md" });
  assert.deepEqual(opaqueState(first), {
    source: { api: "openai-responses", provider: "openai", model: "portable-responses" },
    value: { outputItems: [firstMessage, secondMessage, functionCall, unknownItem], unknownEvents: [unknownEvent] },
  });
  const unknownDiagnostic = first.diagnostics?.find((entry) => entry.type === "unknown_provider_event");
  assert.deepEqual(unknownDiagnostic?.details, { provider: "openai", eventType: "response.future_event", outputIndex: 3 });
  assert.doesNotMatch(JSON.stringify(first.diagnostics), /must-not-become-a-diagnostic/u);

  await streamResponses(responsesModel, { messages: [...context.messages, first] }, { apiKey: "test", fetch, maxRetries: 0 }).result();
  assert.deepEqual(payload?.input, [
    { role: "user", content: [{ type: "input_text", text: "hello" }] },
    firstMessage,
    secondMessage,
    functionCall,
    unknownItem,
    { type: "function_call_output", call_id: "call_2", output: "No result provided" },
  ]);
});

test("Anthropic preserves and replays provider assistant blocks without semantic reconstruction", async () => {
  const block = {
    type: "tool_use", id: "tool_0", name: "read", input: { path: "README.md" },
    vendor_extension: { exact: ["opaque", 7] },
  };
  let payload: Record<string, unknown> | undefined;
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    calls += 1;
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return calls === 1
      ? sse(
        { type: "message_start", message: { id: "first", usage: {} } },
        { type: "content_block_start", index: 0, content_block: block },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" } },
        { type: "message_stop" },
      )
      : sse({ type: "message_start", message: { id: "second", usage: {} } }, { type: "message_stop" });
  };
  const first = await streamAnthropic(anthropicModel, context, { apiKey: "test", fetch, maxRetries: 0 }).result();
  assert.deepEqual(opaqueState(first), {
    source: { api: "anthropic-messages", provider: "anthropic", model: "portable-anthropic" },
    value: { assistantBlocks: [block] },
  });

  await streamAnthropic(anthropicModel, {
    messages: [
      ...context.messages,
      first,
      { role: "toolResult", toolCallId: "tool_0", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false, timestamp: 2 },
    ],
  }, { apiKey: "test", fetch, maxRetries: 0 }).result();
  assert.deepEqual((payload?.messages as Array<Record<string, unknown>>)[1], { role: "assistant", content: [block] });
});
