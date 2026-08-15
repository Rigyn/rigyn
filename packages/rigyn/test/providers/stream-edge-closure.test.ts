import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicAdapter } from "../../src/providers/anthropic.js";
import { OpenAIResponsesAdapter } from "../../src/providers/openai-responses.js";
import type { ProviderAdapter } from "../../src/core/types.js";
import { byteChunks, collect, fakeFetch, request, streamResponse, terminalCount } from "./helpers.js";

function sse(...values: unknown[]): string {
  return values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
}

function anthropicToolStream(): string {
  return sse(
    {
      type: "message_start",
      message: { id: "message-tool", model: "claude-test", usage: { input_tokens: 4 } },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "call-1", name: "read", input: {} },
    },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'README.md"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  );
}

test("Anthropic requests eager tool input and normalizes partial arguments exactly once across transports", async () => {
  const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
  const transport = () => fakeFetch(async (incoming) => {
    posted.push({ url: incoming.url, body: await incoming.json() as Record<string, unknown> });
    return streamResponse(byteChunks(anthropicToolStream(), [1, 2, 3, 5, 8]), {
      "content-type": "text/event-stream",
    });
  });
  const adapters: ProviderAdapter[] = [
    new AnthropicAdapter({ apiKey: "sdk-secret", fetch: transport() }),
    new AnthropicAdapter({
      apiKey: "direct-secret",
      baseUrl: "https://compatible.example/v1",
      fetch: transport(),
    }),
  ];

  for (const adapter of adapters) {
    const providerRequest = request("anthropic");
    providerRequest.tools = [{
      name: "read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }];
    const events = await collect(adapter.stream(providerRequest, new AbortController().signal));

    assert.equal(terminalCount(events), 1);
    assert.deepEqual(
      events.filter((event) => event.type.startsWith("tool_call")).map((event) => event.type),
      ["tool_call_start", "tool_call_delta", "tool_call_delta", "tool_call_end"],
    );
    const end = events.find((event) => event.type === "tool_call_end");
    assert.deepEqual(end?.type === "tool_call_end" ? end.arguments : undefined, { path: "README.md" });
  }

  for (const requestBody of posted.map((entry) => entry.body)) {
    const tools = requestBody.tools as Array<Record<string, unknown>>;
    assert.equal(tools[0]?.eager_input_streaming, true);
  }
});

test("Anthropic repairs unambiguous malformed string literals in streamed tool input", async () => {
  const rawArguments = '{"path":"A\\H","text":"col1\tcol2"}';
  const adapter = new AnthropicAdapter({
    apiKey: "direct-secret",
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => streamResponse(byteChunks(sse(
      { type: "message_start", message: { id: "malformed-tool", model: "claude-test", usage: { input_tokens: 1 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call-malformed", name: "edit", input: {} },
      },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: rawArguments } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    )))),
  });

  const events = await collect(adapter.stream(request("anthropic"), new AbortController().signal));
  const end = events.find((event) => event.type === "tool_call_end");
  if (end?.type !== "tool_call_end") assert.fail("missing tool_call_end");
  assert.equal(end.rawArguments, rawArguments);
  assert.equal(end.parseError, undefined);
  assert.deepEqual(end.arguments, { path: "A\\H", text: "col1\tcol2" });

  const terminal = events.at(-1);
  if (terminal?.type !== "response_end") assert.fail("missing response_end");
  assert.deepEqual(terminal.state, {
    kind: "anthropic_messages",
    assistantBlocks: [{
      type: "tool_use",
      id: "call-malformed",
      name: "edit",
      input: { path: "A\\H", text: "col1\tcol2" },
    }],
  });
});

test("Anthropic can use the legacy partial-input contract without mixing wire modes", async () => {
  let incoming: Request | undefined;
  const adapter = new AnthropicAdapter({
    apiKey: "direct-secret",
    baseUrl: "https://compatible.example/v1",
    eagerToolInputStreaming: false,
    fetch: fakeFetch((requestValue) => {
      incoming = requestValue;
      return streamResponse(byteChunks(sse(
        { type: "message_start", message: { id: "legacy", model: "claude-test", usage: { input_tokens: 1 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      )));
    }),
  });
  const providerRequest = request("anthropic");
  providerRequest.tools = [{ name: "read", description: "Read", inputSchema: { type: "object" } }];

  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
  const body = await incoming!.clone().json() as Record<string, unknown>;
  const tools = body.tools as Array<Record<string, unknown>>;

  assert.equal(terminalCount(events), 1);
  assert.equal(tools[0]?.eager_input_streaming, undefined);
  assert.match(incoming!.headers.get("anthropic-beta") ?? "", /fine-grained-tool-streaming-2025-05-14/u);
});

test("Anthropic surfaces only the bounded refusal explanation across SDK and direct transports", async () => {
  const explanation = "The request cannot be completed under the active safety policy.";
  const body = sse(
    {
      type: "message_start",
      message: { id: "message-refusal", model: "claude-test", usage: { input_tokens: 3 } },
    },
    {
      type: "message_delta",
      delta: {
        stop_reason: "refusal",
        stop_details: {
          type: "refusal",
          category: "policy",
          explanation,
          internal_secret: "must-not-surface",
        },
      },
      usage: { output_tokens: 0 },
    },
    { type: "message_stop" },
  );
  const transport = () => fakeFetch(() => streamResponse(byteChunks(body, [2, 1, 4, 8]), {
    "content-type": "text/event-stream",
  }));
  const adapters: ProviderAdapter[] = [
    new AnthropicAdapter({ apiKey: "sdk-secret", fetch: transport() }),
    new AnthropicAdapter({
      apiKey: "direct-secret",
      baseUrl: "https://compatible.example/v1",
      fetch: transport(),
    }),
  ];

  const results = [];
  for (const adapter of adapters) {
    const events = await collect(adapter.stream(request("anthropic"), new AbortController().signal));
    results.push(events);
    assert.equal(terminalCount(events), 1);
    assert.equal(events.some((event) => event.type === "text_delta"), false);
    const end = events.at(-1);
    assert.equal(end?.type === "response_end" ? end.reason : undefined, "refusal");
    assert.equal(end?.type === "response_end" ? end.rawReason : undefined, "refusal");
    assert.equal(end?.type === "response_end" ? end.explanation : undefined, explanation);
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("must-not-surface"), false);
    assert.equal(serialized.includes("sdk-secret"), false);
    assert.equal(serialized.includes("direct-secret"), false);
  }
  assert.deepEqual(results[0], results[1]);
});

test("Anthropic bounds and sanitizes refusal explanations at the adapter boundary", async () => {
  const rawExplanation = `blocked\u001b[2J\n${"x".repeat(8 * 1024)}`;
  const adapter = new AnthropicAdapter({
    apiKey: "direct-secret",
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => streamResponse(byteChunks(sse(
      { type: "message_start", message: { id: "bounded", model: "claude-test", usage: { input_tokens: 1 } } },
      {
        type: "message_delta",
        delta: { stop_reason: "refusal", stop_details: { explanation: rawExplanation } },
        usage: { output_tokens: 0 },
      },
      { type: "message_stop" },
    )))),
  });

  const events = await collect(adapter.stream(request("anthropic"), new AbortController().signal));
  const end = events.at(-1);
  if (end?.type !== "response_end") assert.fail("missing response_end");
  assert.ok(end.explanation !== undefined);
  assert.ok(Buffer.byteLength(end.explanation, "utf8") <= 4 * 1024);
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/u.test(end.explanation), false);
  assert.match(end.explanation, /^blocked \[2J /u);
});

function responsesAdapter(kind: "sdk" | "direct", body: string): OpenAIResponsesAdapter {
  return new OpenAIResponsesAdapter({
    apiKey: "secret",
    ...(kind === "direct" ? { baseUrl: "https://compatible.example/v1" } : {}),
    fetch: fakeFetch(() => streamResponse(byteChunks(body, [1, 2, 3, 5]), {
      "content-type": "text/event-stream",
      "x-request-id": `request-${kind}`,
    })),
  });
}

test("Responses early EOF is retryable only before substantive output across transports", async (t) => {
  for (const kind of ["sdk", "direct"] as const) {
    await t.test(`${kind}: metadata only`, async () => {
      const adapter = responsesAdapter(kind, sse(
        { type: "response.created", response: { id: `response-${kind}`, model: "gpt-test" } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "reasoning", id: "reasoning-1", summary: [] },
        },
      ));
      const events = await collect(adapter.stream(request("openai"), new AbortController().signal));
      assert.deepEqual(events.map((event) => event.type), ["error"]);
      const failure = events[0];
      assert.equal(failure?.type === "error" ? failure.error.category : undefined, "network");
      assert.equal(failure?.type === "error" ? failure.error.retryable : undefined, true);
      assert.equal(failure?.type === "error" ? failure.error.partial : undefined, false);
      assert.equal(failure?.type === "error" ? failure.error.bodyStarted : undefined, undefined);
      assert.equal(failure?.type === "error" ? failure.error.requestId : undefined, `request-${kind}`);
    });

    await t.test(`${kind}: partial text`, async () => {
      const adapter = responsesAdapter(kind, sse(
        { type: "response.created", response: { id: `response-${kind}`, model: "gpt-test" } },
        { type: "response.output_text.delta", content_index: 0, delta: "partial" },
      ));
      const events = await collect(adapter.stream(request("openai"), new AbortController().signal));
      assert.deepEqual(events.map((event) => event.type), ["response_start", "text_delta", "error"]);
      const failure = events.at(-1);
      assert.equal(failure?.type === "error" ? failure.error.category : undefined, "network");
      assert.equal(failure?.type === "error" ? failure.error.retryable : undefined, false);
      assert.equal(failure?.type === "error" ? failure.error.partial : undefined, true);
      assert.equal(failure?.type === "error" ? failure.error.bodyStarted : undefined, true);
      assert.equal(terminalCount(events), 1);
    });
  }
});

test("Responses early EOF preserves cancellation instead of retry classification", async () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = new OpenAIResponsesAdapter({
    apiKey: "secret",
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => {
      throw new DOMException("aborted", "AbortError");
    }),
  });

  const events = await collect(adapter.stream(request("openai"), controller.signal));
  assert.equal(terminalCount(events), 1);
  assert.equal(events[0]?.type === "error" ? events[0].error.category : undefined, "cancelled");
  assert.equal(events[0]?.type === "error" ? events[0].error.retryable : undefined, false);
});

test("Responses classifies a final SSE frame cut off by EOF as a transport failure", async (t) => {
  const truncatedFrame = 'data: {"type":"response.in_progress"';
  for (const kind of ["sdk", "direct"] as const) {
    await t.test(`${kind}: before substantive output`, async () => {
      const adapter = responsesAdapter(kind, `${sse(
        { type: "response.created", response: { id: `response-${kind}`, model: "gpt-test" } },
      )}${truncatedFrame}`);
      const events = await collect(adapter.stream(request("openai"), new AbortController().signal));
      assert.deepEqual(events.map((event) => event.type), ["error"]);
      const failure = events[0];
      if (failure?.type !== "error") assert.fail("missing error");
      assert.equal(failure.error.category, "network");
      assert.equal(failure.error.retryable, true);
      assert.equal(failure.error.partial, false);
      assert.equal(failure.error.bodyStarted, undefined);
    });

    await t.test(`${kind}: after substantive output`, async () => {
      const adapter = responsesAdapter(kind, `${sse(
        { type: "response.created", response: { id: `response-${kind}`, model: "gpt-test" } },
        { type: "response.output_text.delta", content_index: 0, delta: "partial" },
      )}${truncatedFrame}`);
      const events = await collect(adapter.stream(request("openai"), new AbortController().signal));
      assert.deepEqual(events.map((event) => event.type), ["response_start", "text_delta", "error"]);
      const failure = events.at(-1);
      if (failure?.type !== "error") assert.fail("missing error");
      assert.equal(failure.error.category, "network");
      assert.equal(failure.error.retryable, false);
      assert.equal(failure.error.partial, true);
      assert.equal(failure.error.bodyStarted, true);
    });
  }

  await t.test("a complete malformed frame remains a protocol failure", async () => {
    const adapter = responsesAdapter("direct", `${sse(
      { type: "response.created", response: { id: "response-direct", model: "gpt-test" } },
    )}${truncatedFrame}\n\n`);
    const events = await collect(adapter.stream(request("openai"), new AbortController().signal));
    const failure = events[0];
    if (failure?.type !== "error") assert.fail("missing error");
    assert.equal(failure.error.category, "protocol");
    assert.equal(failure.error.retryable, false);
    assert.equal(failure.error.partial, false);
    assert.equal(failure.error.bodyStarted, true);
  });
});
