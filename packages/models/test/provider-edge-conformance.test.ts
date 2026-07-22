import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.js";
import { stream as streamResponses } from "../src/api/openai-responses.js";
import { buildResponsesBody } from "../src/api/openai-responses-shared.js";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, ToolCall } from "../src/types.js";

const responsesModel: Model<"openai-responses"> = {
  id: "response-edge", name: "Response Edge", api: "openai-responses", provider: "openai", baseUrl: "https://example.invalid/v1",
  reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 1_000,
};
const anthropicModel: Model<"anthropic-messages"> = {
  id: "anthropic-edge", name: "Anthropic Edge", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://example.invalid",
  reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 1_000,
};
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const encoder = new TextEncoder();

function sse(...events: Array<Record<string, unknown>>): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function interruptedSse(...events: Array<Record<string, unknown>>): Response {
  const bytes = encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  let sent = false;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(bytes); return; }
      controller.error(new TypeError("response body terminated"));
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(stream: ReturnType<typeof streamResponses>): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

test("Responses retries metadata-only and interrupted bodies without leaking abandoned output", async (t) => {
  await t.test("reasoning metadata followed by EOF", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return calls === 1
        ? sse(
          { type: "response.created", response: { id: "abandoned" } },
          { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_abandoned", summary: [] } },
        )
        : sse({ type: "response.completed", response: { id: "recovered", usage: {} } });
    };
    const { events, result } = await collect(streamResponses(responsesModel, context, { apiKey: "test", fetch, maxRetries: 1 }));
    assert.equal(calls, 2);
    assert.equal(result.responseId, "recovered");
    assert.deepEqual(result.content, []);
    assert.equal(events.some((event) => event.type === "thinking_start"), false);
  });

  await t.test("body reader fails after metadata", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return calls === 1
        ? interruptedSse({ type: "response.created", response: { id: "interrupted" } })
        : sse({ type: "response.completed", response: { id: "recovered", usage: {} } });
    };
    const result = await streamResponses(responsesModel, context, { apiKey: "test", fetch, maxRetries: 1 }).result();
    assert.equal(calls, 2);
    assert.equal(result.stopReason, "stop");
    assert.equal(result.responseId, "recovered");
  });

  await t.test("body reader fails after text", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return interruptedSse({ type: "response.output_text.delta", delta: "partial" });
    };
    const result = await streamResponses(responsesModel, context, { apiKey: "test", fetch, maxRetries: 2 }).result();
    assert.equal(calls, 1);
    assert.equal(result.stopReason, "error");
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "partial");
  });

  await t.test("done-only output is substantive", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return sse({
        type: "response.output_item.done", output_index: 0,
        item: { type: "message", id: "message_done", content: [{ type: "output_text", text: "done-only text" }] },
      });
    };
    const result = await streamResponses(responsesModel, context, { apiKey: "test", fetch, maxRetries: 2 }).result();
    assert.equal(calls, 1);
    assert.equal(result.stopReason, "error");
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "done-only text");
  });

  await t.test("done-only tool call is substantive", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return sse({
        type: "response.output_item.done", output_index: 0,
        item: { type: "function_call", id: "fc_done", call_id: "call_done", name: "weather", arguments: '{"city":"Winnipeg"}' },
      });
    };
    const result = await streamResponses(responsesModel, context, { apiKey: "test", fetch, maxRetries: 2 }).result();
    assert.equal(calls, 1);
    assert.equal(result.stopReason, "error");
    const call = result.content.find((block): block is ToolCall => block.type === "toolCall");
    assert.deepEqual(call?.arguments, { city: "Winnipeg" });
  });
});

test("provider streams preserve cancellation before and during a body", async (t) => {
  await t.test("already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    let calls = 0;
    const result = await streamResponses(responsesModel, context, {
      apiKey: "test", signal: controller.signal, fetch: async () => { calls += 1; return sse(); }, maxRetries: 2,
    }).result();
    assert.equal(calls, 0);
    assert.equal(result.stopReason, "aborted");
  });

  await t.test("after partial text", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      calls += 1;
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`));
          signal?.addEventListener("abort", () => streamController.error(signal.reason), { once: true });
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const stream = streamResponses(responsesModel, context, { apiKey: "test", fetch, signal: controller.signal, maxRetries: 2 });
    for await (const event of stream) if (event.type === "text_delta") controller.abort(new DOMException("cancelled", "AbortError"));
    const result = await stream.result();
    assert.equal(calls, 1);
    assert.equal(result.stopReason, "aborted");
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "partial");
  });

  await t.test("Anthropic after partial tool input", async () => {
    const controller = new AbortController();
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const bytes = encoder.encode([
        { type: "message_start", message: { id: "partial", usage: {} } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call", name: "read", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(bytes);
          signal?.addEventListener("abort", () => streamController.error(signal.reason), { once: true });
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const stream = streamAnthropic(anthropicModel, context, { apiKey: "test", fetch, signal: controller.signal, maxRetries: 2 });
    for await (const event of stream) if (event.type === "toolcall_delta") controller.abort(new DOMException("cancelled", "AbortError"));
    const result = await stream.result();
    assert.equal(result.stopReason, "aborted");
    const call = result.content.find((block): block is ToolCall => block.type === "toolCall");
    assert.deepEqual(call?.arguments, { path: "README.md" });
  });
});

test("Anthropic streams partial tool arguments in order and finalizes once", async () => {
  const fetch: typeof globalThis.fetch = async () => sse(
    { type: "message_start", message: { id: "message", usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call", name: "read", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"README.md"' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "}" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  );
  const toolContext: Context = { ...context, tools: [{ name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) }] };
  const stream = streamAnthropic(anthropicModel, toolContext, { apiKey: "test", fetch, maxRetries: 0 });
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  assert.deepEqual(events.filter((event) => event.type === "toolcall_delta").map((event) => event.type === "toolcall_delta" ? event.delta : ""), ['{"path":"README.md"', "}"]);
  assert.equal(events.filter((event) => event.type === "toolcall_end").length, 1);
  const call = result.content.find((block): block is ToolCall => block.type === "toolCall");
  assert.deepEqual(call?.arguments, { path: "README.md" });
});

test("Anthropic retains bounded provider-authored refusal and SDK error details", async (t) => {
  await t.test("refusal explanation", async () => {
    const explanation = `blocked\u001b[2J\n${"x".repeat(5_000)}`;
    const result = await streamAnthropic(anthropicModel, context, {
      apiKey: "test", maxRetries: 0,
      fetch: async () => sse(
        { type: "message_start", message: { id: "message", usage: {} } },
        { type: "message_delta", delta: { stop_reason: "refusal", stop_details: { explanation, internal: "do-not-expose" } } },
        { type: "message_stop" },
      ),
    }).result();
    assert.equal(result.stopReason, "error");
    assert.ok(Buffer.byteLength(result.errorMessage ?? "", "utf8") <= 4 * 1_024);
    assert.doesNotMatch(result.errorMessage ?? "", /[\u0000-\u001f\u007f-\u009f]/u);
    assert.doesNotMatch(result.errorMessage ?? "", /do-not-expose/u);
  });

  await t.test("SDK-shaped HTTP failure", async () => {
    const failure = Object.assign(new Error("403 status code (no body)"), { status: 403, error: { reason: "gateway rejected request" } });
    const result = await streamAnthropic(anthropicModel, context, {
      apiKey: "test", maxRetries: 0,
      client: { messages: { create() { return { asResponse: async () => { throw failure; } }; } } },
    }).result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /403/u);
    assert.match(result.errorMessage ?? "", /gateway rejected request/u);
  });

  await t.test("stream error code", async () => {
    const result = await streamAnthropic(anthropicModel, context, {
      apiKey: "test", maxRetries: 0,
      fetch: async () => sse({ type: "error", error: { type: "overloaded_error", message: "capacity unavailable" } }),
    }).result();
    assert.equal(result.errorMessage, "overloaded_error: capacity unavailable");
  });
});

test("provider payloads replace lone surrogates and retain valid Unicode", async () => {
  const invalid = `emoji 😀 lone ${String.fromCharCode(0xd83d)} end`;
  const prior: AssistantMessage = {
    role: "assistant", api: "openai-responses", provider: "openai", model: responsesModel.id,
    content: [{ type: "toolCall", id: "call|fc_call", name: "read", arguments: {} }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: 1,
  };
  const unicodeContext: Context = {
    systemPrompt: invalid,
    messages: [
      { role: "user", content: invalid, timestamp: 0 },
      prior,
      { role: "toolResult", toolCallId: "call|fc_call", toolName: "read", content: [{ type: "text", text: invalid }], isError: false, timestamp: 2 },
    ],
  };
  let responsesBody: unknown;
  await streamResponses(responsesModel, unicodeContext, {
    apiKey: "test", maxRetries: 0,
    fetch: async (_url, init) => { responsesBody = JSON.parse(String(init?.body)); return sse({ type: "response.completed", response: { usage: {} } }); },
  }).result();
  let anthropicBody: unknown;
  await streamAnthropic({ ...anthropicModel, api: "anthropic-messages", provider: "anthropic" }, {
    ...unicodeContext,
    messages: unicodeContext.messages.map((message) => message.role === "assistant" ? { ...message, api: "anthropic-messages", provider: "anthropic", model: anthropicModel.id } : message),
  }, {
    apiKey: "test", maxRetries: 0,
    fetch: async (_url, init) => { anthropicBody = JSON.parse(String(init?.body)); return sse({ type: "message_start", message: { usage: {} } }, { type: "message_stop" }); },
  }).result();
  for (const payload of [responsesBody, anthropicBody]) {
    const serialized = JSON.stringify(payload);
    assert.match(serialized, /😀/u);
    assert.doesNotMatch(serialized, /\\ud83d/u);
    assert.match(serialized, /�/u);
  }
});

test("Responses accounts for cache writes and replays terminal reasoning state", async () => {
  let calls = 0;
  const payloads: Array<Record<string, unknown>> = [];
  const doneReasoning = { type: "reasoning", id: "rs_replay", summary: [{ type: "summary_text", text: "plan" }] };
  const terminalReasoning = { ...doneReasoning, encrypted_content: "opaque-replay-token" };
  const tool = { type: "function_call", id: "fc_weather", call_id: "call_weather", name: "weather", arguments: '{"city":"Winnipeg"}' };
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    calls += 1;
    payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (calls === 1) return sse(
      { type: "response.created", response: { id: "first" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_replay", summary: [] } },
      { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs_replay", delta: "plan" },
      { type: "response.output_item.done", output_index: 0, item: doneReasoning },
      { type: "response.output_item.added", output_index: 1, item: { ...tool, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_weather", delta: tool.arguments },
      { type: "response.output_item.done", output_index: 1, item: tool },
      { type: "response.completed", response: {
        id: "first", output: [terminalReasoning, tool],
        usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 }, output_tokens_details: { reasoning_tokens: 4 } },
      } },
    );
    return sse({ type: "response.completed", response: { id: "second", usage: {} } });
  };
  const sessionId = "cache-session";
  const first = await streamResponses(responsesModel, context, {
    apiKey: "test", fetch, maxRetries: 0, reasoningEffort: "high", sessionId, cacheRetention: "long",
  }).result();
  assert.equal(first.stopReason, "toolUse", first.errorMessage);
  assert.deepEqual(first.usage, {
    input: 15, output: 7, cacheRead: 2, cacheWrite: 3, reasoning: 4, totalTokens: 27,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  assert.equal(payloads[0]?.prompt_cache_key, sessionId);
  assert.equal(payloads[0]?.prompt_cache_retention, "24h");
  assert.deepEqual(payloads[0]?.include, ["reasoning.encrypted_content"]);
  const unicodeCacheKey = `${"a".repeat(63)}😀z`;
  assert.equal(buildResponsesBody(responsesModel, context, { sessionId: unicodeCacheKey }).prompt_cache_key, `${"a".repeat(63)}😀`);

  const replayContext: Context = {
    messages: [
      ...context.messages,
      first,
      { role: "toolResult", toolCallId: "call_weather|fc_weather", toolName: "weather", content: [{ type: "text", text: "sunny" }], isError: false, timestamp: 2 },
    ],
  };
  await streamResponses(responsesModel, replayContext, { apiKey: "test", fetch, maxRetries: 0, reasoningEffort: "high" }).result();
  const replayInput = payloads[1]?.input as Array<Record<string, unknown>>;
  const replayed = replayInput.find((item) => item.type === "reasoning");
  assert.equal(replayed?.encrypted_content, "opaque-replay-token");
  assert.ok(replayInput.indexOf(replayed!) < replayInput.findIndex((item) => item.type === "function_call"));
});

test("Responses retains the provider code on failed terminal events", async () => {
  const result = await streamResponses(responsesModel, context, {
    apiKey: "test", maxRetries: 0,
    fetch: async () => sse({ type: "response.failed", response: { error: { code: "server_error", message: "capacity unavailable" } } }),
  }).result();
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "server_error: capacity unavailable");
});

test("Anthropic cache markers cover the conversation and honor model compatibility", async () => {
  let body: Record<string, unknown> | undefined;
  const model: Model<"anthropic-messages"> = { ...anthropicModel, compat: { supportsLongCacheRetention: false } };
  await streamAnthropic(model, { ...context, systemPrompt: "system" }, {
    apiKey: "test", cacheRetention: "long", maxRetries: 0,
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sse({ type: "message_start", message: { usage: {} } }, { type: "message_stop" });
    },
  }).result();
  const system = body?.system as Array<Record<string, unknown>>;
  assert.deepEqual(system[0]?.cache_control, { type: "ephemeral" });
  const messages = body?.messages as Array<Record<string, unknown>>;
  const content = messages.at(-1)?.content as Array<Record<string, unknown>>;
  assert.deepEqual(content.at(-1)?.cache_control, { type: "ephemeral" });
});
