import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderRequest, ToolDefinition } from "../../src/core/types.js";
import { AnthropicAdapter } from "../../src/providers/anthropic.js";
import { buildResponsesBody, OpenAIResponsesAdapter } from "../../src/providers/openai-responses.js";
import { byteChunks, collect, fakeFetch, request, streamResponse } from "./helpers.js";

function tools(): ToolDefinition[] {
  return [
    {
      name: "read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      loading: "eager",
    },
    {
      name: "issue_search",
      description: "Search issue records",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      loading: "deferred",
    },
  ];
}

function sse(...values: unknown[]): Uint8Array[] {
  return byteChunks(values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""));
}

function completedAnthropicResponse(id: string): Uint8Array[] {
  return sse(
    { type: "message_start", message: { id, model: "claude-opus-4-8", usage: { input_tokens: 1 } } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  );
}

test("OpenAI Responses defers opted-in executable tools only on documented model families", () => {
  const supported = request("openai");
  supported.model = "gpt-5.4";
  supported.tools = tools();

  assert.deepEqual(buildResponsesBody(supported, false, true, undefined, undefined, undefined, true).tools, [
    {
      type: "function",
      name: "read",
      description: "Read a file",
      parameters: supported.tools[0]!.inputSchema,
      strict: false,
    },
    {
      type: "function",
      name: "issue_search",
      description: "Search issue records",
      parameters: supported.tools[1]!.inputSchema,
      strict: false,
      defer_loading: true,
    },
    { type: "tool_search" },
  ]);

  for (const [provider, model] of [["openai", "gpt-5.3"], ["openai", "custom-deployment"], ["azure-openai", "gpt-5.4"]] as const) {
    const fallback = request(provider);
    fallback.model = model;
    fallback.tools = tools();
    const wireTools = buildResponsesBody(
      fallback,
      false,
      provider === "openai",
      undefined,
      undefined,
      undefined,
      true,
    ).tools as Array<Record<string, unknown>>;
    assert.equal(wireTools.some((tool) => tool.type === "tool_search"), false);
    assert.equal(wireTools.some((tool) => tool.defer_loading !== undefined), false);
    assert.equal(wireTools.length, fallback.tools.length);
  }
});

test("OpenAI Responses preserves hosted search output while emitting only executable function calls", async () => {
  const searchCall = {
    type: "tool_search_call",
    execution: "server",
    call_id: null,
    status: "completed",
    arguments: { paths: ["issue_search"] },
  };
  const searchOutput = {
    type: "tool_search_output",
    execution: "server",
    call_id: null,
    status: "completed",
    tools: [{
      type: "function",
      name: "issue_search",
      description: "Search issue records",
      defer_loading: true,
      parameters: { type: "object", properties: { query: { type: "string" } } },
    }],
  };
  const functionCall = {
    type: "function_call",
    id: "item-issue",
    call_id: "call-issue",
    name: "issue_search",
    arguments: '{"query":"open"}',
  };
  const adapter = new OpenAIResponsesAdapter({
    apiKey: "secret",
    fetch: fakeFetch(() => streamResponse(sse(
      { type: "response.created", response: { id: "response-search", model: "gpt-5.4" } },
      { type: "response.output_item.added", output_index: 0, item: searchCall },
      { type: "response.output_item.done", output_index: 0, item: searchCall },
      { type: "response.output_item.added", output_index: 1, item: searchOutput },
      { type: "response.output_item.done", output_index: 1, item: searchOutput },
      { type: "response.output_item.added", output_index: 2, item: functionCall },
      { type: "response.output_item.done", output_index: 2, item: functionCall },
      {
        type: "response.completed",
        response: { id: "response-search", model: "gpt-5.4", output: [searchCall, searchOutput, functionCall] },
      },
    ))),
  });
  const providerRequest = request("openai");
  providerRequest.model = "gpt-5.4";
  providerRequest.tools = tools();

  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
  const calls = events.filter((event) => event.type === "tool_call_end");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.type === "tool_call_end" ? calls[0].name : undefined, "issue_search");
  const end = events.at(-1);
  assert.equal(end?.type, "response_end");
  assert.deepEqual(end?.type === "response_end" && end.state.kind === "openai_responses"
    ? end.state.outputItems
    : undefined, [searchCall, searchOutput, functionCall]);
});

test("Anthropic preserves server search blocks while emitting only executable client tool calls", async () => {
  const posted: Array<Record<string, unknown>> = [];
  let call = 0;
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    fetch: fakeFetch(async (incoming) => {
      posted.push(await incoming.json() as Record<string, unknown>);
      call += 1;
      if (call > 1) return streamResponse(completedAnthropicResponse("msg-continued"));
      return streamResponse(sse(
        { type: "message_start", message: { id: "msg-search", model: "claude-opus-4-8", usage: { input_tokens: 1 } } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "server_tool_use", id: "srvtoolu_search", name: "tool_search_tool_bm25", input: {} },
        },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"issues"}' } },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_search_tool_result",
            tool_use_id: "srvtoolu_search",
            content: {
              type: "tool_search_tool_search_result",
              tool_references: [{ type: "tool_reference", tool_name: "issue_search" }],
            },
          },
        },
        { type: "content_block_stop", index: 1 },
        {
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "toolu_issue", name: "issue_search", input: {} },
        },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"query":"open"}' } },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ));
    }),
  });

  const firstRequest = request("anthropic");
  firstRequest.model = "claude-opus-4-8";
  firstRequest.tools = tools();
  const events = await collect(adapter.stream(firstRequest, new AbortController().signal));

  const wireTools = posted[0]!.tools as Array<Record<string, unknown>>;
  assert.deepEqual(wireTools.map((tool) => [tool.type, tool.name, tool.defer_loading]), [
    ["tool_search_tool_bm25_20251119", "tool_search_tool_bm25", undefined],
    [undefined, "read", undefined],
    [undefined, "issue_search", true],
  ]);
  assert.equal(wireTools[1]!.cache_control === undefined, false);
  assert.equal(wireTools[2]!.cache_control, undefined);
  assert.equal(events.filter((event) => event.type === "tool_call_end").length, 1);
  assert.equal(events.find((event) => event.type === "tool_call_end")?.type === "tool_call_end"
    ? events.find((event) => event.type === "tool_call_end")?.name
    : undefined, "issue_search");

  const end = events.at(-1);
  assert.equal(end?.type, "response_end");
  const state = end?.type === "response_end" ? end.state : undefined;
  assert.equal(state?.kind, "anthropic_messages");
  if (state?.kind !== "anthropic_messages") throw new Error("missing Anthropic state");
  assert.deepEqual(state.assistantBlocks[0], {
    type: "server_tool_use",
    id: "srvtoolu_search",
    name: "tool_search_tool_bm25",
    input: { query: "issues" },
  });
  assert.equal((state.assistantBlocks[1] as { type?: string }).type, "tool_search_tool_result");

  const continuation: ProviderRequest = {
    ...firstRequest,
    providerState: state,
    messages: [
      ...firstRequest.messages,
      {
        id: "assistant-search",
        role: "assistant",
        provider: "anthropic",
        content: [{ type: "tool_call", callId: "toolu_issue", name: "issue_search", arguments: { query: "open" } }],
        createdAt: "2026-07-12T00:00:00.000Z",
      },
      {
        id: "tool-result",
        role: "tool",
        content: [{ type: "tool_result", callId: "toolu_issue", name: "issue_search", content: "[]", isError: false }],
        createdAt: "2026-07-12T00:00:01.000Z",
      },
    ],
  };
  await collect(adapter.stream(continuation, new AbortController().signal));
  const continuedMessages = posted[1]!.messages as Array<{ role: string; content: unknown }>;
  assert.deepEqual(continuedMessages[1]?.content, state.assistantBlocks);
});

test("Anthropic sends full definitions for unsupported and conflicting tool-search models", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    fetch: fakeFetch(async (incoming) => {
      bodies.push(await incoming.json() as Record<string, unknown>);
      return streamResponse(completedAnthropicResponse(`msg-${bodies.length}`));
    }),
  });

  const unsupported = request("anthropic");
  unsupported.model = "claude-opus-4-1";
  unsupported.tools = tools();
  await collect(adapter.stream(unsupported, new AbortController().signal));

  const conflicting = request("anthropic");
  conflicting.model = "claude-opus-4-8";
  conflicting.tools = [{
    ...tools()[1]!,
    name: "tool_search_tool_bm25",
  }];
  await collect(adapter.stream(conflicting, new AbortController().signal));

  for (const body of bodies) {
    const wireTools = body.tools as Array<Record<string, unknown>>;
    assert.equal(wireTools.some((tool) => tool.type === "tool_search_tool_bm25_20251119"), false);
    assert.equal(wireTools.some((tool) => tool.defer_loading !== undefined), false);
  }
});

test("provider model catalogs expose conservative deferred-tool capability evidence", async () => {
  const openai = new OpenAIResponsesAdapter({
    apiKey: "secret",
    fetch: fakeFetch(() => new Response(JSON.stringify({ data: [
      { id: "gpt-5.4" },
      { id: "gpt-5.3" },
      { id: "vendor-model" },
    ] }), { headers: { "content-type": "application/json" } })),
  });
  const openaiModels = await openai.listModels(new AbortController().signal);
  assert.deepEqual(openaiModels.map((model) => model.compatibility?.deferredTools?.value), [
    "supported",
    "unsupported",
    "unknown",
  ]);

  const anthropic = new AnthropicAdapter({
    apiKey: "secret",
    fetch: fakeFetch(() => new Response(JSON.stringify({ data: [
      { id: "claude-opus-4-8" },
      { id: "claude-opus-4-1" },
      { id: "private-model" },
    ], has_more: false }), { headers: { "content-type": "application/json" } })),
  });
  const anthropicModels = await anthropic.listModels(new AbortController().signal);
  assert.deepEqual(anthropicModels.map((model) => model.compatibility?.deferredTools?.value), [
    "supported",
    "unsupported",
    "unknown",
  ]);
});
