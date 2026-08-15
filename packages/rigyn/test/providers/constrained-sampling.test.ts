import assert from "node:assert/strict";
import test from "node:test";

import { GeminiAdapter } from "../../src/providers/gemini.js";
import { OpenAICompatibleAdapter, OpenRouterAdapter } from "../../src/providers/openai-compatible.js";
import { buildResponsesBody, OpenAIResponsesAdapter } from "../../src/providers/openai-responses.js";
import { byteChunks, collect, fakeFetch, request, streamResponse } from "./helpers.js";

function sse(...values: unknown[]): string {
  return `${values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`;
}

const strictTool = {
  name: "strict_tool",
  description: "Strict JSON",
  inputSchema: {
    type: "object",
    required: ["value"],
    properties: { value: { type: "string" } },
    additionalProperties: false,
  },
  constrainedSampling: { type: "json_schema", strict: "require" } as const,
};

const grammarTool = {
  name: "grammar_tool",
  description: "Grammar",
  inputSchema: {
    type: "object",
    required: ["source"],
    properties: { source: { type: "string" } },
    additionalProperties: false,
  },
  constrainedSampling: {
    type: "grammar",
    variants: { openai_lark: "start: /[a-z]+/" },
  } as const,
};

test("configured Chat Completions constraints serialize strictly and reject unsupported requirements", async () => {
  let posted: Record<string, unknown> | undefined;
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(async (incoming) => {
      posted = await incoming.json() as Record<string, unknown>;
      return streamResponse(byteChunks(sse({
        id: "chat-constraint",
        model: "test-model",
        choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
      })));
    }),
  });
  const supported = request("openai-compatible");
  supported.tools = [strictTool];
  supported.modelSettings = { compatibility: { supportsStrictMode: true } };
  const events = await collect(adapter.stream(supported, new AbortController().signal));
  assert.equal(events.at(-1)?.type, "response_end");
  assert.equal(
    (((posted?.tools as Array<Record<string, unknown>>)[0]?.function as Record<string, unknown>).strict),
    true,
  );

  let fetched = false;
  const unsupportedAdapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => {
      fetched = true;
      return streamResponse([]);
    }),
  });
  const unsupported = request("openai-compatible");
  unsupported.tools = [strictTool];
  unsupported.modelSettings = { compatibility: { supportsStrictMode: false } };
  const unsupportedEvents = await collect(
    unsupportedAdapter.stream(unsupported, new AbortController().signal),
  );
  assert.equal(fetched, false);
  const error = unsupportedEvents.at(-1);
  assert.equal(error?.type, "error");
  assert.match(error?.type === "error" ? error.error.message : "", /requires strict JSON-schema sampling/u);
});

test("Chat Completions grammar tools stream into their declared string argument", async () => {
  let posted: Record<string, unknown> | undefined;
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(async (incoming) => {
      posted = await incoming.json() as Record<string, unknown>;
      return streamResponse(byteChunks(sse(
        {
          id: "chat-grammar",
          model: "test-model",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "call-grammar",
                type: "custom",
                custom: { name: "grammar_tool", input: "hel" },
              }],
            },
            finish_reason: null,
          }],
        },
        {
          id: "chat-grammar",
          model: "test-model",
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, type: "custom", custom: { input: "lo" } }] },
            finish_reason: "tool_calls",
          }],
        },
      )));
    }),
  });
  const providerRequest = request("openai-compatible");
  providerRequest.tools = [grammarTool];
  providerRequest.modelSettings = { compatibility: { supportsOpenAIGrammarTools: true } };
  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));

  assert.deepEqual((posted?.tools as Array<Record<string, unknown>>)[0], {
    type: "custom",
    custom: {
      name: "grammar_tool",
      description: "Grammar",
      format: {
        type: "grammar",
        grammar: { syntax: "lark", definition: "start: /[a-z]+/" },
      },
    },
  });
  const end = events.find((event) => event.type === "tool_call_end");
  assert.deepEqual(end?.type === "tool_call_end" ? end.arguments : undefined, { source: "hello" });
});

test("Responses constraints preserve request and streamed custom-tool shapes", async () => {
  const providerRequest = request("openai");
  providerRequest.tools = [strictTool, grammarTool];
  providerRequest.modelSettings = {
    compatibility: {
      supportsStrictMode: true,
      supportsOpenAIGrammarTools: true,
    },
  };
  assert.deepEqual(buildResponsesBody(providerRequest, false, false).tools, [
    {
      type: "function",
      name: "strict_tool",
      description: "Strict JSON",
      parameters: strictTool.inputSchema,
      strict: true,
    },
    {
      type: "custom",
      name: "grammar_tool",
      description: "Grammar",
      format: { type: "grammar", syntax: "lark", definition: "start: /[a-z]+/" },
    },
  ]);

  const body = sse(
    { type: "response.created", response: { id: "response-grammar", model: "test-model" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "custom_tool_call",
        id: "custom-item",
        call_id: "custom-call",
        name: "grammar_tool",
        input: "",
      },
    },
    {
      type: "response.custom_tool_call_input.delta",
      output_index: 0,
      item_id: "custom-item",
      delta: "hel",
    },
    {
      type: "response.custom_tool_call_input.done",
      output_index: 0,
      item_id: "custom-item",
      input: "hello",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "custom_tool_call",
        id: "custom-item",
        call_id: "custom-call",
        name: "grammar_tool",
        input: "hello",
      },
    },
    {
      type: "response.completed",
      response: { id: "response-grammar", model: "test-model", output: [] },
    },
  );
  const adapter = new OpenAIResponsesAdapter({
    apiKey: "secret",
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => streamResponse(byteChunks(body))),
  });
  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
  const end = events.find((event) => event.type === "tool_call_end");
  assert.deepEqual(end?.type === "tool_call_end" ? end.arguments : undefined, { source: "hello" });
});

test("Responses grammar replay keeps the declared string argument and string result shape", () => {
  const providerRequest = request("openai");
  providerRequest.tools = [grammarTool];
  providerRequest.modelSettings = {
    compatibility: { supportsOpenAIGrammarTools: true },
  };
  providerRequest.messages.push(
    {
      id: "grammar-call",
      role: "assistant",
      content: [{
        type: "tool_call",
        callId: "custom-call",
        name: "grammar_tool",
        arguments: { source: "hello" },
      }],
      createdAt: "2026-07-25T00:00:01.000Z",
    },
    {
      id: "grammar-result",
      role: "tool",
      content: [{
        type: "tool_result",
        callId: "custom-call",
        name: "grammar_tool",
        content: "done",
        isError: false,
        images: [{ type: "image", mediaType: "image/png", data: "AA==" }],
      }],
      createdAt: "2026-07-25T00:00:02.000Z",
    },
  );

  const input = buildResponsesBody(providerRequest, false, false).input as unknown[];
  assert.deepEqual(input.slice(-3), [
    {
      type: "custom_tool_call",
      call_id: "custom-call",
      name: "grammar_tool",
      input: "hello",
    },
    {
      type: "custom_tool_call_output",
      call_id: "custom-call",
      output: "done",
    },
    {
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }],
    },
  ]);
});

test("Gemini carries strict constraints through its native request transport", async () => {
  let googleBody: Record<string, unknown> | undefined;
  const google = new GeminiAdapter({
    apiKey: "secret",
    fetch: fakeFetch(async (incoming) => {
      googleBody = await incoming.json() as Record<string, unknown>;
      return streamResponse(byteChunks(sse({
        responseId: "google-strict",
        modelVersion: "gemini-3-test",
        candidates: [{
          index: 0,
          finishReason: "STOP",
          content: { role: "model", parts: [{ text: "done" }] },
        }],
      })));
    }),
  });
  const googleRequest = request("gemini");
  googleRequest.model = "gemini-3-test";
  googleRequest.tools = [strictTool];
  const googleEvents = await collect(google.stream(googleRequest, new AbortController().signal));
  assert.equal(googleEvents.at(-1)?.type, "response_end");
  assert.deepEqual(googleBody?.toolConfig, {
    functionCallingConfig: { mode: "VALIDATED" },
  });

  let unsupportedFetched = false;
  const unsupportedGoogle = new GeminiAdapter({
    apiKey: "secret",
    fetch: fakeFetch(() => {
      unsupportedFetched = true;
      return streamResponse([]);
    }),
  });
  const unsupportedRequest = request("gemini");
  unsupportedRequest.model = "gemini-2.5-test";
  unsupportedRequest.tools = [strictTool];
  const unsupportedEvents = await collect(
    unsupportedGoogle.stream(unsupportedRequest, new AbortController().signal),
  );
  assert.equal(unsupportedFetched, false);
  const unsupportedError = unsupportedEvents.at(-1);
  assert.equal(unsupportedError?.type, "error");
  assert.match(
    unsupportedError?.type === "error" ? unsupportedError.error.message : "",
    /requires strict JSON-schema sampling/u,
  );

});

test("routed Anthropic aliases cache the latest tool-result text", async () => {
  let posted: Record<string, unknown> | undefined;
  const adapter = new OpenRouterAdapter({
    apiKey: "secret",
    fetch: fakeFetch(async (incoming) => {
      posted = await incoming.json() as Record<string, unknown>;
      return streamResponse(byteChunks(sse({
        id: "routed-cache",
        model: "~anthropic/claude-latest",
        choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
      })));
    }),
  });
  const providerRequest = request("openrouter");
  providerRequest.model = "~anthropic/claude-latest";
  providerRequest.messages = [
    {
      id: "system",
      role: "system",
      content: [{ type: "text", text: "System" }],
      createdAt: "2026-07-25T00:00:00.000Z",
    },
    {
      id: "assistant",
      role: "assistant",
      content: [{ type: "tool_call", callId: "call", name: "read", arguments: {} }],
      createdAt: "2026-07-25T00:00:01.000Z",
    },
    {
      id: "result",
      role: "tool",
      content: [{
        type: "tool_result",
        callId: "call",
        name: "read",
        content: "contents",
        isError: false,
      }],
      createdAt: "2026-07-25T00:00:02.000Z",
    },
  ];
  await collect(adapter.stream(providerRequest, new AbortController().signal));
  const toolResult = (posted?.messages as Array<{ role: string; content: unknown }> | undefined)
    ?.findLast((message) => message.role === "tool");
  assert.deepEqual(toolResult?.content, [{
    type: "text",
    text: "contents",
    cache_control: { type: "ephemeral" },
  }]);
});
