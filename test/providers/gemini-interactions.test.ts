import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "../../src/core/json.js";
import { GeminiInteractionsAdapter } from "../../src/providers/gemini-interactions.js";
import { byteChunks, collect, fakeFetch, request, streamResponse, terminalCount } from "./helpers.js";

function sseEvent(type: string, value: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ event_type: type, ...value })}\n\n`;
}

function completedStream(id = "interaction-1", status = "completed"): string {
  return (
    sseEvent("interaction.created", {
      interaction: { id, model: "gemini-3.5-flash", status: "in_progress" },
    }) +
    sseEvent("interaction.completed", {
      interaction: { id, model: "gemini-3.5-flash", status },
    }) +
    "event: done\ndata: [DONE]\n\n"
  );
}

test("Gemini Interactions v1 assembles thought, text, tools, usage, and stateless state", async () => {
  let posted: Record<string, unknown> | undefined;
  let url = "";
  let apiKey = "";
  const stream =
    sseEvent("interaction.created", {
      interaction: { id: "interaction-1", model: "gemini-3.5-flash", status: "in_progress" },
    }) +
    sseEvent("step.start", { index: 0, step: { type: "thought" } }) +
    sseEvent("step.delta", {
      index: 0,
      delta: { type: "thought_summary", content: { type: "text", text: "Checking the tool." } },
    }) +
    sseEvent("step.delta", {
      index: 0,
      delta: { type: "thought_signature", signature: "opaque-signature" },
    }) +
    sseEvent("step.stop", { index: 0 }) +
    sseEvent("step.start", { index: 1, step: { type: "model_output" } }) +
    sseEvent("step.delta", { index: 1, delta: { type: "text", text: "hello " } }) +
    sseEvent("step.delta", { index: 1, delta: { type: "text", text: "world" } }) +
    sseEvent("step.stop", { index: 1 }) +
    sseEvent("step.start", {
      index: 2,
      step: { type: "function_call", id: "call-1", name: "lookup", arguments: {} },
    }) +
    sseEvent("step.delta", { index: 2, delta: { type: "arguments_delta", arguments: '{"key":' } }) +
    sseEvent("step.delta", { index: 2, delta: { type: "arguments", partial_arguments: '"value"}' } }) +
    sseEvent("step.stop", { index: 2, status: "waiting" }) +
    sseEvent("provider.experimental", { value: 1 }) +
    sseEvent("interaction.completed", {
      interaction: {
        id: "interaction-1",
        model: "gemini-3.5-flash",
        status: "requires_action",
        usage: {
          total_input_tokens: 1_000,
          total_output_tokens: 100,
          total_thought_tokens: 200,
          total_cached_tokens: 800,
          total_tokens: 1_300,
        },
      },
    }) +
    "event: done\ndata: [DONE]\n\n";

  const adapter = new GeminiInteractionsAdapter({
    apiKey: "secret",
    fetch: fakeFetch(async (incoming) => {
      url = incoming.url;
      apiKey = incoming.headers.get("x-goog-api-key") ?? "";
      posted = (await incoming.json()) as Record<string, unknown>;
      return streamResponse(byteChunks(stream, [1, 2, 3, 5, 8, 13]), { "x-request-id": "request-1" });
    }),
  });
  const providerRequest = request("gemini");
  providerRequest.model = "models/gemini-3.5-flash";
  providerRequest.messages.unshift({
    id: "system-1",
    role: "system",
    content: [{ type: "text", text: "Be concise." }],
    createdAt: "2026-07-09T00:00:00.000Z",
  });
  providerRequest.tools = [
    {
      name: "lookup",
      description: "Look up a value",
      inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    },
  ];
  providerRequest.maxOutputTokens = 128;
  providerRequest.reasoningEffort = "high";

  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  assert.equal(url, "https://generativelanguage.googleapis.com/v1/interactions");
  assert.equal(apiKey, "secret");
  assert.deepEqual(posted, {
    model: "gemini-3.5-flash",
    input: [{ type: "user_input", content: [{ type: "text", text: "hello" }] }],
    stream: true,
    store: false,
    system_instruction: "Be concise.",
    tools: [
      {
        type: "function",
        name: "lookup",
        description: "Look up a value",
        parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
      },
    ],
    generation_config: { max_output_tokens: 128, thinking_level: "high" },
  });
  assert.deepEqual(
    events.filter((event) => event.type === "text_delta").map((event) => (event.type === "text_delta" ? event.text : "")),
    ["hello ", "world"],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "reasoning_delta").map((event) =>
      event.type === "reasoning_delta" ? [event.text, event.visibility] : [],
    ),
    [["Checking the tool.", "summary"]],
  );
  const tool = events.find((event) => event.type === "tool_call_end");
  assert.deepEqual(tool?.type === "tool_call_end" ? tool.arguments : undefined, { key: "value" });
  assert.equal(events.filter((event) => event.type === "unknown_provider_event").length, 1);
  const usage = events.find((event) => event.type === "usage");
  assert.deepEqual(usage?.type === "usage" ? usage.usage : undefined, {
    inputTokens: 200,
    outputTokens: 300,
    cacheReadTokens: 800,
    reasoningTokens: 200,
    totalTokens: 1_300,
    raw: {
      total_input_tokens: 1_000,
      total_output_tokens: 100,
      total_thought_tokens: 200,
      total_cached_tokens: 800,
      total_tokens: 1_300,
    },
  });
  const end = events.at(-1);
  if (end?.type !== "response_end") assert.fail("missing response_end");
  assert.equal(end.reason, "tool_calls");
  assert.deepEqual(end.state, {
    kind: "gemini_interactions",
    steps: [
      {
        type: "thought",
        summary: [{ type: "text", text: "Checking the tool." }],
        signature: "opaque-signature",
      },
      { type: "model_output", content: [{ type: "text", text: "hello world" }] },
      {
        type: "function_call",
        id: "call-1",
        name: "lookup",
        arguments: { key: "value" },
      },
    ],
  });
});

test("Gemini Interactions replays exact steps when store is false and maps function results", async () => {
  let posted: Record<string, unknown> | undefined;
  const adapter = new GeminiInteractionsAdapter({
    fetch: fakeFetch(async (incoming) => {
      posted = (await incoming.json()) as Record<string, unknown>;
      return streamResponse(byteChunks(completedStream()));
    }),
  });
  const providerRequest = request("gemini");
  providerRequest.model = "gemini-3.5-flash";
  providerRequest.messages.push(
    {
      id: "assistant-1",
      role: "assistant",
      content: [{ type: "tool_call", callId: "call-1", name: "lookup", arguments: { key: "value" } }],
      createdAt: "2026-07-09T00:00:01.000Z",
    },
    {
      id: "tool-1",
      role: "tool",
      content: [
        { type: "tool_result", callId: "call-1", name: "lookup", content: '{"answer":42}', isError: false },
      ],
      createdAt: "2026-07-09T00:00:02.000Z",
    },
  );
  const exactSteps: JsonValue[] = [
    { type: "thought", signature: "opaque", summary: [{ type: "text", text: "Use lookup." }] },
    { type: "function_call", id: "call-1", name: "lookup", arguments: { key: "value" } },
  ];
  providerRequest.providerState = {
    kind: "gemini_interactions",
    previousInteractionId: "must-not-be-used",
    steps: exactSteps,
  };

  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  assert.deepEqual(posted?.input, [
    { type: "user_input", content: [{ type: "text", text: "hello" }] },
    ...exactSteps,
    {
      type: "function_result",
      call_id: "call-1",
      name: "lookup",
      result: [{ type: "text", text: '{"answer":42}' }],
      is_error: false,
    },
  ]);
  assert.equal(posted?.store, false);
  assert.equal("previous_interaction_id" in (posted ?? {}), false);
});

test("Gemini Interactions uses explicit stateful storage and OAuth quota headers", async () => {
  let posted: Record<string, unknown> | undefined;
  let authorization = "";
  let quotaProject = "";
  let apiKey: string | null = null;
  const response =
    sseEvent("interaction.created", {
      interaction: { id: "interaction-2", model: "gemini-3.5-flash", status: "in_progress" },
    }) +
    sseEvent("step.start", { index: 0, step: { type: "model_output" } }) +
    sseEvent("step.delta", { index: 0, delta: { type: "text", text: "done" } }) +
    sseEvent("step.stop", { index: 0 }) +
    sseEvent("interaction.completed", {
      interaction: { id: "interaction-2", model: "gemini-3.5-flash", status: "completed" },
    }) +
    "event: done\ndata: [DONE]\n\n";
  const adapter = new GeminiInteractionsAdapter({
    apiKey: "unused",
    accessToken: async () => "oauth-token",
    userProject: "billing-project",
    store: true,
    fetch: fakeFetch(async (incoming) => {
      authorization = incoming.headers.get("authorization") ?? "";
      quotaProject = incoming.headers.get("x-goog-user-project") ?? "";
      apiKey = incoming.headers.get("x-goog-api-key");
      posted = (await incoming.json()) as Record<string, unknown>;
      return streamResponse(byteChunks(response));
    }),
  });
  const providerRequest = request("gemini");
  providerRequest.model = "gemini-3.5-flash";
  providerRequest.messages.push(
    {
      id: "assistant-1",
      role: "assistant",
      content: [{ type: "tool_call", callId: "call-1", name: "lookup", arguments: {} }],
      createdAt: "2026-07-09T00:00:01.000Z",
    },
    {
      id: "tool-1",
      role: "tool",
      content: [{ type: "tool_result", callId: "call-1", name: "lookup", content: "42", isError: false }],
      createdAt: "2026-07-09T00:00:02.000Z",
    },
  );
  providerRequest.providerState = {
    kind: "gemini_interactions",
    previousInteractionId: "interaction-1",
    steps: [{ type: "function_call", id: "call-1", name: "lookup", arguments: {} }],
  };

  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.equal(authorization, "Bearer oauth-token");
  assert.equal(quotaProject, "billing-project");
  assert.equal(apiKey, null);
  assert.equal(posted?.store, true);
  assert.equal(posted?.previous_interaction_id, "interaction-1");
  assert.deepEqual(posted?.input, [
    {
      type: "function_result",
      call_id: "call-1",
      name: "lookup",
      result: [{ type: "text", text: "42" }],
      is_error: false,
    },
  ]);
  const end = events.at(-1);
  if (end?.type !== "response_end") assert.fail("missing response_end");
  assert.deepEqual(end.state, {
    kind: "gemini_interactions",
    previousInteractionId: "interaction-2",
    steps: [{ type: "model_output", content: [{ type: "text", text: "done" }] }],
  });
});

test("Gemini Interactions accepts documented terminal aliases and bounds aggregate streams", async () => {
  const aliasStream =
    sseEvent("interaction.created", {
      interaction: { id: "interaction-1", model: "gemini-3.5-flash", status: "in_progress" },
    }) +
    sseEvent("step.start", {
      index: 0,
      step: { type: "function_call", id: "call-1", name: "lookup", arguments: {} },
    }) +
    sseEvent("step.delta", {
      index: 0,
      delta: { type: "arguments_delta", partial_arguments: "{}" },
    }) +
    sseEvent("step.stop", { index: 0 }) +
    sseEvent("interaction.requires_action", { interaction_id: "interaction-1" }) +
    "event: done\ndata: [DONE]\n\n";
  const aliasAdapter = new GeminiInteractionsAdapter({
    fetch: fakeFetch(() => streamResponse(byteChunks(aliasStream))),
  });
  const aliasEvents = await collect(aliasAdapter.stream(request("gemini"), new AbortController().signal));
  const aliasEnd = aliasEvents.at(-1);
  assert.equal(aliasEnd?.type === "response_end" ? aliasEnd.reason : undefined, "tool_calls");

  const boundedAdapter = new GeminiInteractionsAdapter({
    maxStreamBytes: 8,
    fetch: fakeFetch(() => streamResponse(byteChunks(completedStream()))),
  });
  const boundedEvents = await collect(boundedAdapter.stream(request("gemini"), new AbortController().signal));
  assert.equal(terminalCount(boundedEvents), 1);
  const error = boundedEvents.at(-1);
  assert.equal(error?.type === "error" ? error.error.category : undefined, "protocol");
  assert.match(error?.type === "error" ? error.error.message : "", /stream exceeded/);
});

test("Gemini Interactions model discovery follows page tokens", async () => {
  const tokens: Array<string | null> = [];
  const adapter = new GeminiInteractionsAdapter({
    apiKey: "secret",
    fetch: fakeFetch((requestValue) => {
      const token = new URL(requestValue.url).searchParams.get("pageToken");
      tokens.push(token);
      return new Response(JSON.stringify(token === null
        ? { models: [{ name: "models/first", inputTokenLimit: 1000 }], nextPageToken: "next" }
        : { models: [{ name: "models/second", inputTokenLimit: 2000 }] }), {
        headers: { "content-type": "application/json" },
      });
    }),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.deepEqual(models.map((model) => [model.id, model.contextTokens]), [["first", 1000], ["second", 2000]]);
  assert.deepEqual(tokens, [null, "next"]);
});
