import assert from "node:assert/strict";
import test from "node:test";

import { projectMessagesForProvider } from "../../src/context/index.js";
import type {
  AdapterEvent,
  ModelProtocolFamily,
  NormalizedUsage,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  ProviderState,
} from "../../src/core/types.js";
import { AnthropicAdapter } from "../../src/providers/anthropic.js";
import { BedrockAdapter } from "../../src/providers/bedrock.js";
import { GeminiInteractionsAdapter } from "../../src/providers/gemini-interactions.js";
import { GeminiAdapter, VertexAdapter } from "../../src/providers/gemini.js";
import { GatewayMessagesAdapter } from "../../src/providers/gateway-messages.js";
import { MistralAdapter, OpenAICompatibleAdapter, OpenRouterAdapter } from "../../src/providers/openai-compatible.js";
import { AzureOpenAIResponsesAdapter, OpenAIResponsesAdapter } from "../../src/providers/openai-responses.js";
import { OllamaAdapter } from "../../src/providers/ollama.js";
import type { FetchLike } from "../../src/providers/transport.js";
import { collect, fakeFetch, request, streamResponse, terminalCount } from "./helpers.js";

interface WireFixture {
  name: string;
  provider: ProviderId;
  api: ModelProtocolFamily;
  create(fetch: FetchLike): ProviderAdapter;
  chunks(): Uint8Array[];
  contentType: string;
  state(): ProviderState;
  prepare?(request: Request): Response | undefined;
}

const encoder = new TextEncoder();

function sse(value: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
}

function namedSse(type: string, value: Record<string, unknown>): Uint8Array {
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ event_type: type, ...value })}\n\n`);
}

function responsesChunks(): Uint8Array[] {
  return [
    sse({ type: "response.created", response: { id: "response-contract", model: "test-model" } }),
    sse({ type: "response.output_text.delta", content_index: 0, delta: "ok" }),
    sse({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        type: "function_call",
        id: "function-item",
        call_id: "contract-call",
        name: "lookup",
        arguments: "",
      },
    }),
    sse({
      type: "response.function_call_arguments.delta",
      item_id: "function-item",
      output_index: 1,
      delta: '{"value":1}',
    }),
    sse({
      type: "response.function_call_arguments.done",
      item_id: "function-item",
      output_index: 1,
      arguments: '{"value":1}',
    }),
    sse({
      type: "response.completed",
      response: {
        id: "response-contract",
        model: "test-model",
        usage: {
          input_tokens: 1_000,
          output_tokens: 100,
          total_tokens: 1_100,
          input_tokens_details: { cached_tokens: 700, cache_write_tokens: 100 },
          output_tokens_details: { reasoning_tokens: 20 },
        },
      },
    }),
  ];
}

function chatChunks(): Uint8Array[] {
  return [
    sse({
      id: "chat-contract",
      model: "test-model",
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
    }),
    sse({
      id: "chat-contract",
      model: "test-model",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "contract-call",
            function: { name: "lookup", arguments: '{"value":1}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }),
    sse({
      id: "chat-contract",
      model: "test-model",
      choices: [],
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 100,
        total_tokens: 1_100,
        prompt_tokens_details: { cached_tokens: 700, cache_write_tokens: 100 },
      },
    }),
    encoder.encode("data: [DONE]\n\n"),
  ];
}

function anthropicChunks(): Uint8Array[] {
  return [
    sse({
      type: "message_start",
      message: {
        id: "message-contract",
        model: "test-model",
        usage: { input_tokens: 200, cache_read_input_tokens: 700, cache_creation_input_tokens: 100 },
      },
    }),
    sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
    sse({ type: "content_block_stop", index: 0 }),
    sse({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "contract-call", name: "lookup", input: {} },
    }),
    sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"value":1}' } }),
    sse({ type: "content_block_stop", index: 1 }),
    sse({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 100 } }),
    sse({ type: "message_stop" }),
  ];
}

function geminiChunks(): Uint8Array[] {
  return [
    sse({
      responseId: "gemini-contract",
      modelVersion: "test-model",
      candidates: [{ index: 0, content: { role: "model", parts: [{ text: "ok" }] } }],
    }),
    sse({
      responseId: "gemini-contract",
      modelVersion: "test-model",
      candidates: [{
        index: 0,
        content: {
          role: "model",
          parts: [{ functionCall: { id: "contract-call", name: "lookup", args: { value: 1 } } }],
        },
      }],
    }),
    sse({
      responseId: "gemini-contract",
      modelVersion: "test-model",
      candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts: [] } }],
      usageMetadata: {
        promptTokenCount: 1_000,
        candidatesTokenCount: 100,
        cachedContentTokenCount: 700,
        totalTokenCount: 1_100,
      },
    }),
  ];
}

function interactionChunks(): Uint8Array[] {
  return [
    namedSse("interaction.created", {
      interaction: { id: "interaction-contract", model: "test-model", status: "in_progress" },
    }),
    namedSse("step.start", { index: 0, step: { type: "model_output" } }),
    namedSse("step.delta", { index: 0, delta: { type: "text", text: "ok" } }),
    namedSse("step.stop", { index: 0 }),
    namedSse("step.start", {
      index: 1,
      step: { type: "function_call", id: "contract-call", name: "lookup", arguments: {} },
    }),
    namedSse("step.delta", { index: 1, delta: { type: "arguments_delta", arguments: '{"value":1}' } }),
    namedSse("step.stop", { index: 1 }),
    namedSse("interaction.completed", {
      interaction: {
        id: "interaction-contract",
        model: "test-model",
        status: "requires_action",
        usage: {
          total_input_tokens: 1_000,
          total_output_tokens: 100,
          total_cached_tokens: 700,
          total_tokens: 1_100,
        },
      },
    }),
    encoder.encode("event: done\ndata: [DONE]\n\n"),
  ];
}

function ollamaChunks(): Uint8Array[] {
  return [
    encoder.encode(`${JSON.stringify({
      model: "test-model",
      message: { role: "assistant", content: "ok" },
      done: false,
    })}\n`),
    encoder.encode(`${JSON.stringify({
      model: "test-model",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "contract-call", function: { index: 0, name: "lookup", arguments: { value: 1 } } }],
      },
      done: false,
    })}\n`),
    encoder.encode(`${JSON.stringify({
      model: "test-model",
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 1_000,
      eval_count: 100,
      total_duration: 2_000_000,
    })}\n`),
  ];
}

function gatewayChunks(): Uint8Array[] {
  const usage = {
    input: 200,
    output: 100,
    cacheRead: 700,
    cacheWrite: 100,
    totalTokens: 1_100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return [
    sse({ type: "start" }),
    sse({ type: "text_start", contentIndex: 0 }),
    sse({ type: "text_delta", contentIndex: 0, delta: "ok" }),
    sse({ type: "text_end", contentIndex: 0, content: "ok", contentSignature: "text-signature" }),
    sse({ type: "toolcall_start", contentIndex: 1, id: "contract-call", toolName: "lookup" }),
    sse({ type: "toolcall_delta", contentIndex: 1, delta: '{"value":1}' }),
    sse({
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: { type: "toolCall", id: "contract-call", name: "lookup", arguments: { value: 1 } },
    }),
    sse({ type: "done", reason: "toolUse", usage, responseId: "gateway-contract" }),
  ];
}

function gatewayConfig(request: Request): Response | undefined {
  if (!request.url.endsWith("/config")) return undefined;
  return new Response(JSON.stringify({
    baseUrl: "https://messages.example/v1",
    models: [{
      id: "test-model",
      name: "Test Model",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    }],
  }), { headers: { "content-type": "application/json" } });
}

function bedrockChunks(): Uint8Array[] {
  return [
    awsFrame({ ":message-type": "event", ":event-type": "messageStart" }, { role: "assistant" }),
    awsFrame(
      { ":message-type": "event", ":event-type": "contentBlockStart" },
      { contentBlockIndex: 0, start: {} },
    ),
    awsFrame(
      { ":message-type": "event", ":event-type": "contentBlockDelta" },
      { contentBlockIndex: 0, delta: { text: "ok" } },
    ),
    awsFrame(
      { ":message-type": "event", ":event-type": "contentBlockStop" },
      { contentBlockIndex: 0 },
    ),
    awsFrame(
      { ":message-type": "event", ":event-type": "contentBlockStart" },
      {
        contentBlockIndex: 1,
        start: { toolUse: { toolUseId: "contract-call", name: "lookup" } },
      },
    ),
    awsFrame(
      { ":message-type": "event", ":event-type": "contentBlockDelta" },
      { contentBlockIndex: 1, delta: { toolUse: { input: '{"value":1}' } } },
    ),
    awsFrame(
      { ":message-type": "event", ":event-type": "contentBlockStop" },
      { contentBlockIndex: 1 },
    ),
    awsFrame({ ":message-type": "event", ":event-type": "messageStop" }, { stopReason: "tool_use" }),
    awsFrame(
      { ":message-type": "event", ":event-type": "metadata" },
      {
        usage: {
          inputTokens: 200,
          outputTokens: 100,
          totalTokens: 1_100,
          cacheReadInputTokens: 700,
          cacheWriteInputTokens: 100,
        },
      },
    ),
  ];
}

const fixtures: WireFixture[] = [
  {
    name: "OpenAI Responses",
    provider: "openai",
    api: "openai-responses",
    create: (fetch) => new OpenAIResponsesAdapter({ apiKey: "offline", fetch }),
    chunks: responsesChunks,
    contentType: "text/event-stream",
    state: responsesState,
  },
  {
    name: "Azure OpenAI Responses",
    provider: "azure-openai",
    api: "openai-responses",
    create: (fetch) => new AzureOpenAIResponsesAdapter({
      endpoint: "https://contract.openai.azure.com",
      apiKey: "offline",
      fetch,
    }),
    chunks: responsesChunks,
    contentType: "text/event-stream",
    state: responsesState,
  },
  {
    name: "Anthropic Messages",
    provider: "anthropic",
    api: "anthropic-messages",
    create: (fetch) => new AnthropicAdapter({ apiKey: "offline", fetch }),
    chunks: anthropicChunks,
    contentType: "text/event-stream",
    state: () => ({
      kind: "anthropic_messages",
      assistantBlocks: [{ type: "text", text: "state-sentinel" }],
    }),
  },
  {
    name: "OpenAI-compatible Chat Completions",
    provider: "openai-compatible",
    api: "openai-chat-completions",
    create: (fetch) => new OpenAICompatibleAdapter({ baseUrl: "https://compatible.example/v1", fetch }),
    chunks: chatChunks,
    contentType: "text/event-stream",
    state: chatState,
  },
  {
    name: "OpenRouter Chat Completions",
    provider: "openrouter",
    api: "openai-chat-completions",
    create: (fetch) => new OpenRouterAdapter({ apiKey: "offline", fetch }),
    chunks: chatChunks,
    contentType: "text/event-stream",
    state: () => ({
      kind: "openrouter_chat",
      assistantMessage: { role: "assistant", content: "state-sentinel" },
    }),
  },
  {
    name: "Mistral Conversations API",
    provider: "mistral",
    api: "mistral-conversations",
    create: (fetch) => new MistralAdapter({ apiKey: "offline", fetch }),
    chunks: chatChunks,
    contentType: "text/event-stream",
    state: () => ({
      kind: "mistral_chat",
      assistantMessage: { role: "assistant", content: "state-sentinel" },
    }),
  },
  {
    name: "Gemini GenerateContent",
    provider: "gemini",
    api: "gemini-generate-content",
    create: (fetch) => new GeminiAdapter({ apiKey: "offline", fetch }),
    chunks: geminiChunks,
    contentType: "text/event-stream",
    state: geminiState,
  },
  {
    name: "Vertex GenerateContent",
    provider: "vertex",
    api: "gemini-generate-content",
    create: (fetch) => new VertexAdapter({ project: "offline-project", accessToken: "offline", fetch }),
    chunks: geminiChunks,
    contentType: "text/event-stream",
    state: geminiState,
  },
  {
    name: "Gemini Interactions",
    provider: "gemini",
    api: "gemini-interactions",
    create: (fetch) => new GeminiInteractionsAdapter({ apiKey: "offline", store: false, fetch }),
    chunks: interactionChunks,
    contentType: "text/event-stream",
    state: () => ({
      kind: "gemini_interactions",
      steps: [{ type: "model_output", content: [{ type: "text", text: "state-sentinel" }] }],
    }),
  },
  {
    name: "Bedrock ConverseStream",
    provider: "bedrock",
    api: "bedrock-converse",
    create: (fetch) => new BedrockAdapter({ region: "ca-central-1", signer: (incoming) => incoming, fetch }),
    chunks: bedrockChunks,
    contentType: "application/vnd.amazon.eventstream",
    state: () => ({
      kind: "bedrock_converse",
      assistantMessage: { role: "assistant", content: [{ text: "state-sentinel" }] },
    }),
  },
  {
    name: "Ollama Chat",
    provider: "ollama",
    api: "ollama-chat",
    create: (fetch) => new OllamaAdapter({ fetch }),
    chunks: ollamaChunks,
    contentType: "application/x-ndjson",
    state: () => ({
      kind: "ollama_chat",
      assistantMessage: { role: "assistant", content: "state-sentinel" },
    }),
  },
  {
    name: "Gateway Messages",
    provider: "gateway-contract",
    api: "gateway-messages",
    create: (fetch) => new GatewayMessagesAdapter({
      id: "gateway-contract",
      gatewayUrl: "https://gateway.example/v1",
      accessToken: "offline",
      fetch,
    }),
    chunks: gatewayChunks,
    contentType: "text/event-stream",
    state: () => ({
      kind: "gateway_messages",
      assistantContent: [{ type: "text", text: "state-sentinel", textSignature: "state-signature" }],
    }),
    prepare: gatewayConfig,
  },
];

function responsesState(): ProviderState {
  return {
    kind: "openai_responses",
    outputItems: [{
      type: "message",
      id: "state-message",
      role: "assistant",
      content: [{ type: "output_text", text: "state-sentinel" }],
    }],
  };
}

function chatState(): ProviderState {
  return {
    kind: "chat_completions",
    assistantMessage: { role: "assistant", content: "state-sentinel" },
  };
}

function geminiState(): ProviderState {
  return {
    kind: "gemini_generate_content",
    parts: [{ text: "state-sentinel" }],
  };
}

test("offline native-provider request and stream contract matrix", async (t) => {
  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      let posted: unknown;
      const adapter = fixture.create(fakeFetch(async (incoming) => {
        const prepared = fixture.prepare?.(incoming);
        if (prepared !== undefined) return prepared;
        posted = await incoming.json();
        return successResponse(fixture);
      }));
      const providerRequest = contractRequest(fixture.provider, fixture.api);
      const events = await collect(adapter.stream(providerRequest, new AbortController().signal));

      assert.equal(terminalCount(events), 1);
      assert.equal(events.at(-1)?.type, "response_end");
      const start = events.find((event) => event.type === "response_start");
      assert.equal(start?.type === "response_start" ? start.diagnostics?.status : undefined, 200);
      assert.equal(
        start?.type === "response_start" ? start.diagnostics?.headers["x-request-id"] : undefined,
        "contract-request",
      );
      assert.ok(events.some((event) => event.type === "text_delta"));
      const tool = events.find((event) => event.type === "tool_call_end");
      assert.equal(tool?.type === "tool_call_end" ? tool.id : undefined, "contract-call");
      assert.equal(tool?.type === "tool_call_end" ? tool.name : undefined, "lookup");
      assert.deepEqual(tool?.type === "tool_call_end" ? tool.arguments : undefined, { value: 1 });
      assertUsageEvents(events);

      const serialized = JSON.stringify(posted);
      assert.doesNotMatch(serialized, /foreign-provider-secret/u);
      if (fixture.api === "gemini-interactions" || fixture.api === "gateway-messages") {
        assert.match(serialized, /unsafe\|tool\|call/u);
      } else {
        assert.doesNotMatch(serialized, /unsafe\|tool\|call/u);
      }
      assert.match(serialized, /AQ==/u);
      if (fixture.api !== "bedrock-converse") {
        assert.match(serialized, /Tool completed with no text output/u);
      }
      assert.match(serialized, /intentional whitespace/u);
      assertNoEmptyWireContainers(posted);
    });
  }
});

test("every native HTTP stream preserves diagnostics when it ends before response_start", async (t) => {
  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const adapter = fixture.create(fakeFetch((incoming) => fixture.prepare?.(incoming) ?? streamResponse([], {
          "content-type": fixture.contentType,
          "x-request-id": "empty-stream-request",
          authorization: "Bearer response-secret",
        })));
      const events = await collect(adapter.stream(request(fixture.provider), new AbortController().signal));

      assert.equal(events.some((event) => event.type === "response_start"), false);
      assert.equal(terminalCount(events), 1);
      const terminal = events.at(-1);
      assert.equal(terminal?.type, "error");
      if (terminal?.type !== "error") return;
      assert.deepEqual(terminal.error.diagnostics, {
        status: 200,
        headers: {
          "content-type": fixture.contentType,
          "x-request-id": "empty-stream-request",
        },
      });
      assert.equal("authorization" in (terminal.error.diagnostics?.headers ?? {}), false);
    });
  }
});

test("every native provider rejects an entirely empty conversation before transport", async (t) => {
  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      let transported = false;
      const adapter = fixture.create(fakeFetch((incoming) => {
        const prepared = fixture.prepare?.(incoming);
        if (prepared !== undefined) return prepared;
        transported = true;
        return successResponse(fixture);
      }));
      const providerRequest = request(fixture.provider);
      providerRequest.messages = [
        { id: "empty-array", role: "user", content: [], createdAt: "2026-07-10T00:00:00.000Z" },
        {
          id: "empty-text",
          role: "assistant",
          content: [{ type: "text", text: "" }],
          createdAt: "2026-07-10T00:00:01.000Z",
        },
      ];
      const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
      assert.equal(transported, false);
      assert.equal(terminalCount(events), 1);
      const terminal = events.at(-1);
      assert.equal(terminal?.type, "error");
      assert.equal(terminal?.type === "error" ? terminal.error.category : undefined, "invalid_request");
      assert.match(terminal?.type === "error" ? terminal.error.message : "", /non-empty message/u);
    });
  }
});

test("every native provider cancels at each stream phase and accepts a successful follow-up", async (t) => {
  const phases: Array<{
    name: string;
    trigger?: (event: AdapterEvent) => boolean;
  }> = [
    { name: "pre-transport" },
    { name: "response-start", trigger: (event) => event.type === "response_start" },
    { name: "text-delta", trigger: (event) => event.type === "text_delta" },
    { name: "tool-call-start", trigger: (event) => event.type === "tool_call_start" },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async (providerTest) => {
      for (const phase of phases) {
        await providerTest.test(phase.name, async () => {
          let attempt = 0;
          const adapter = fixture.create(fakeFetch((incoming) => {
            const prepared = fixture.prepare?.(incoming);
            if (prepared !== undefined) return prepared;
            attempt += 1;
            if (incoming.signal.aborted) throw abortError();
            return attempt === 1
              ? abortableResponse(fixture, incoming.signal)
              : successResponse(fixture);
          }));
          const controller = new AbortController();
          if (phase.trigger === undefined) controller.abort();
          const cancelled: AdapterEvent[] = [];
          for await (const event of adapter.stream(contractRequest(fixture.provider, fixture.api), controller.signal)) {
            cancelled.push(event);
            if (!controller.signal.aborted && phase.trigger?.(event) === true) controller.abort();
          }
          assert.equal(terminalCount(cancelled), 1);
          const terminal = cancelled.at(-1);
          assert.equal(terminal?.type, "error");
          assert.equal(terminal?.type === "error" ? terminal.error.category : undefined, "cancelled");

          const followUp = await collect(adapter.stream(request(fixture.provider), new AbortController().signal));
          assert.equal(terminalCount(followUp), 1);
          assert.equal(followUp.at(-1)?.type, "response_end");
          assertUsageEvents(followUp);
        });
      }
    });
  }
});

test("same-provider state replaces an empty assistant marker without losing reasoning continuity", async (t) => {
  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      let posted: unknown;
      const adapter = fixture.create(fakeFetch(async (incoming) => {
        const prepared = fixture.prepare?.(incoming);
        if (prepared !== undefined) return prepared;
        posted = await incoming.json();
        return successResponse(fixture);
      }));
      const providerRequest = request(fixture.provider);
      providerRequest.messages.push(
        {
          id: "empty-state-marker",
          role: "assistant",
          content: [{ type: "text", text: "" }],
          createdAt: "2026-07-10T00:00:01.000Z",
        },
        {
          id: "state-follow-up",
          role: "user",
          content: [{ type: "text", text: "continue" }],
          createdAt: "2026-07-10T00:00:02.000Z",
        },
      );
      providerRequest.providerState = fixture.state();

      const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
      assert.equal(events.at(-1)?.type, "response_end");
      const serialized = JSON.stringify(posted);
      assert.match(serialized, /state-sentinel/u);
      assertNoEmptyWireContainers(posted);
    });
  }
});

test("every native provider bounds malformed HTTP error bodies", async (t) => {
  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const adapter = fixture.create(fakeFetch((incoming) => fixture.prepare?.(incoming) ?? new Response(
          `malformed gateway body {"reason":"${"x".repeat(96 * 1024)}`,
          {
            status: 502,
            headers: { "content-type": "application/json", "x-request-id": "contract-request" },
          },
        )));
      const events = await collect(adapter.stream(request(fixture.provider), new AbortController().signal));
      assert.equal(terminalCount(events), 1);
      const terminal = events.at(-1);
      assert.equal(terminal?.type, "error");
      if (terminal?.type !== "error") return;
      assert.equal(terminal.error.httpStatus, 502);
      assert.equal(terminal.error.requestId, "contract-request");
      assert.ok(Buffer.byteLength(terminal.error.message, "utf8") <= 4 * 1024);
      assert.ok(Buffer.byteLength(JSON.stringify(terminal.error.raw), "utf8") <= 16 * 1024);
    });
  }
});

function contractRequest(provider: ProviderId, api: ModelProtocolFamily): ProviderRequest {
  const unsafeCallId = `unsafe|tool|call|${"x".repeat(80)}`;
  const messages: ProviderRequest["messages"] = [
    { id: "empty-user", role: "user", content: [], createdAt: "2026-07-10T00:00:00.000Z" },
    {
      id: "empty-assistant",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      createdAt: "2026-07-10T00:00:01.000Z",
    },
    {
      id: "whitespace-user",
      role: "user",
      content: [{ type: "text", text: " \t\nintentional whitespace" }],
      createdAt: "2026-07-10T00:00:02.000Z",
    },
    {
      id: "tool-assistant",
      role: "assistant",
      provider: "foreign-provider",
      content: [
        { type: "text", text: "calling" },
        { type: "tool_call", callId: unsafeCallId, name: "read_image", arguments: { path: "pixel.png" } },
        {
          type: "provider_opaque",
          provider: "foreign-provider",
          mediaType: "application/json",
          value: { private: "foreign-provider-secret" },
        },
      ],
      createdAt: "2026-07-10T00:00:03.000Z",
    },
    {
      id: "tool-result",
      role: "tool",
      content: [{
        type: "tool_result",
        callId: unsafeCallId,
        name: "read_image",
        content: "",
        isError: false,
        images: [{ type: "image", mediaType: "image/png", data: "AQ==" }],
      }],
      createdAt: "2026-07-10T00:00:04.000Z",
    },
    {
      id: "follow-up",
      role: "user",
      content: [{ type: "text", text: "continue" }],
      createdAt: "2026-07-10T00:00:05.000Z",
    },
  ];
  return {
    provider,
    model: "test-model",
    api,
    messages: projectMessagesForProvider(messages, provider, { model: "test-model", api }),
    tools: [],
  };
}

function assertUsageEvents(events: readonly AdapterEvent[]): void {
  const usages = events.filter((event): event is Extract<AdapterEvent, { type: "usage" }> => event.type === "usage");
  assert.ok(usages.length > 0, "success fixture must report usage");
  for (const event of usages) {
    const usage = event.usage;
    assert.notEqual(usage.raw, undefined);
    const total = componentTotal(usage);
    if (total !== undefined) assert.equal(usage.totalTokens, total);
  }
}

function componentTotal(usage: NormalizedUsage): number | undefined {
  const components = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
  if (components.every((value) => value === undefined)) return undefined;
  return components.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function assertNoEmptyWireContainers(value: unknown, path = "body"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoEmptyWireContainers(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["content", "parts"] as const) {
    const candidate = record[key];
    if (Array.isArray(candidate)) assert.notEqual(candidate.length, 0, `${path}.${key} must not be empty`);
  }
  if (record.text === "") assert.fail(`${path}.text must not be empty`);
  if (record.content === "" && !Array.isArray(record.images)) {
    assert.fail(`${path}.content must not be empty without an image payload`);
  }
  for (const [key, child] of Object.entries(record)) assertNoEmptyWireContainers(child, `${path}.${key}`);
}

function successResponse(fixture: WireFixture): Response {
  return streamResponse(fixture.chunks(), {
    "content-type": fixture.contentType,
    "x-request-id": "contract-request",
  });
}

function abortableResponse(fixture: WireFixture, signal: AbortSignal): Response {
  const chunks = fixture.chunks();
  let index = 0;
  let closed = false;
  let removeAbortListener = (): void => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const onAbort = (): void => {
        if (closed) return;
        closed = true;
        controller.error(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    },
    pull(controller) {
      if (signal.aborted) {
        if (!closed) {
          closed = true;
          controller.error(abortError());
        }
        return;
      }
      const chunk = chunks[index];
      if (chunk === undefined) {
        closed = true;
        removeAbortListener();
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      closed = true;
      removeAbortListener();
    },
  }, { highWaterMark: 0 });
  return new Response(body, {
    headers: { "content-type": fixture.contentType, "x-request-id": "contract-request" },
  });
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function awsFrame(headers: Record<string, string>, payloadValue: unknown): Uint8Array {
  const headerBytes = concatBytes(...Object.entries(headers).map(([name, value]) => {
    const nameBytes = encoder.encode(name);
    const valueBytes = encoder.encode(value);
    const output = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    output[0] = nameBytes.length;
    output.set(nameBytes, 1);
    output[1 + nameBytes.length] = 7;
    new DataView(output.buffer).setUint16(2 + nameBytes.length, valueBytes.length);
    output.set(valueBytes, 4 + nameBytes.length);
    return output;
  }));
  const payload = encoder.encode(JSON.stringify(payloadValue));
  const totalLength = 12 + headerBytes.length + payload.length + 4;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, crc32(frame.subarray(0, 8)));
  frame.set(headerBytes, 12);
  frame.set(payload, 12 + headerBytes.length);
  view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)));
  return frame;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ value) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}
