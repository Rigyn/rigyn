import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicAdapter } from "../../src/providers/anthropic.js";
import { GeminiAdapter } from "../../src/providers/gemini.js";
import { OllamaAdapter } from "../../src/providers/ollama.js";
import { MistralAdapter, OpenAICompatibleAdapter, OpenRouterAdapter } from "../../src/providers/openai-compatible.js";
import { AzureOpenAIResponsesAdapter, OpenAIResponsesAdapter } from "../../src/providers/openai-responses.js";
import { byteChunks, collect, fakeFetch, request, streamResponse, terminalCount } from "./helpers.js";

function sse(...values: unknown[]): string {
  return values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
}

test("OpenAI Responses maps text, fragmented tools, usage, and opaque output state", async () => {
  let posted: unknown;
  const body = sse(
    { type: "response.created", response: { id: "resp-1", model: "gpt-test" } },
    { type: "response.output_text.delta", content_index: 0, delta: "hello 🌍" },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", id: "item-1", call_id: "call-1", name: "weather", arguments: "" },
    },
    { type: "response.function_call_arguments.delta", item_id: "item-1", output_index: 1, delta: '{"city":"Win' },
    { type: "response.function_call_arguments.delta", item_id: "item-1", output_index: 1, delta: 'nipeg"}' },
    {
      type: "response.function_call_arguments.done",
      item_id: "item-1",
      output_index: 1,
      arguments: '{"city":"Winnipeg"}',
    },
    {
      type: "response.completed",
      response: {
        id: "resp-1",
        model: "gpt-test",
        usage: {
          input_tokens: 1_000,
          output_tokens: 100,
          total_tokens: 1_100,
          input_tokens_details: { cached_tokens: 800 },
          output_tokens_details: { reasoning_tokens: 40 },
        },
      },
    },
  );
  const adapter = new OpenAIResponsesAdapter({
    apiKey: "secret",
    promptCacheOptions: { ttl: "30m" },
    promptCacheRetention: "in-memory",
    serviceTier: "priority",
    fetch: fakeFetch(async (incoming) => {
      posted = await incoming.json();
      return streamResponse(byteChunks(body, [1, 2, 3, 5, 8, 13]), { "x-request-id": "req-1" });
    }),
  });

  const providerRequest = request("openai");
  providerRequest.sessionId = `session-${"x".repeat(200)}`;
  providerRequest.tools = [{
    name: "edit",
    description: "Edit a file",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string" }, expectedSha256: { type: "string" } },
    },
  }];
  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  assert.equal(events.find((event) => event.type === "text_delta")?.type, "text_delta");
  const tool = events.find((event) => event.type === "tool_call_end");
  assert.deepEqual(tool?.type === "tool_call_end" ? tool.arguments : undefined, { city: "Winnipeg" });
  const end = events.at(-1);
  assert.equal(end?.type, "response_end");
  if (end?.type === "response_end") {
    assert.equal(end.reason, "tool_calls");
    assert.equal(end.state.kind, "openai_responses");
  }
  assert.equal((posted as { stream?: boolean }).stream, true);
  assert.equal((posted as { tools?: Array<{ strict?: boolean }> }).tools?.[0]?.strict, false);
  assert.match((posted as { prompt_cache_key?: string }).prompt_cache_key ?? "", /^[a-f0-9]{64}$/u);
  assert.deepEqual((posted as { prompt_cache_options?: unknown }).prompt_cache_options, { ttl: "30m" });
  assert.equal((posted as { prompt_cache_retention?: string }).prompt_cache_retention, "in_memory");
  assert.equal((posted as { service_tier?: string }).service_tier, "priority");
  const usage = events.find((event) => event.type === "usage");
  assert.deepEqual(usage?.type === "usage" ? usage.usage : undefined, {
    raw: {
      input_tokens: 1_000,
      output_tokens: 100,
      total_tokens: 1_100,
      input_tokens_details: { cached_tokens: 800 },
      output_tokens_details: { reasoning_tokens: 40 },
    },
    inputTokens: 200,
    outputTokens: 100,
    cacheReadTokens: 800,
    reasoningTokens: 40,
    totalTokens: 1_100,
  });
});

test("Azure Responses uses the GA v1 path and api-key authentication", async () => {
  let url = "";
  let apiKey = "";
  const adapter = new AzureOpenAIResponsesAdapter({
    endpoint: "https://example.openai.azure.com",
    apiKey: "azure-secret",
    fetch: fakeFetch((incoming) => {
      url = incoming.url;
      apiKey = incoming.headers.get("api-key") ?? "";
      return streamResponse(
        byteChunks(
          sse(
            { type: "response.created", response: { id: "r", model: "deployment" } },
            { type: "response.completed", response: { id: "r", model: "deployment" } },
          ),
        ),
      );
    }),
  });
  const providerRequest = request("azure-openai");
  providerRequest.model = "deployment";
  providerRequest.sessionId = "azure-session";
  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.equal(url, "https://example.openai.azure.com/openai/v1/responses");
  assert.equal(apiKey, "azure-secret");
  assert.equal(terminalCount(events), 1);
});

test("OpenAI Responses sends URL and base64 image blocks as multimodal input", async () => {
  let posted: { input?: unknown[] } | undefined;
  const adapter = new OpenAIResponsesAdapter({
    apiKey: "secret",
    fetch: fakeFetch(async (incoming) => {
      posted = await incoming.json() as { input?: unknown[] };
      return streamResponse(byteChunks(sse(
        { type: "response.created", response: { id: "image-response", model: "vision-model" } },
        { type: "response.completed", response: { id: "image-response", model: "vision-model" } },
      )));
    }),
  });
  const providerRequest = request("openai");
  providerRequest.messages[0]!.content = [
    { type: "text", text: "compare these" },
    { type: "image", mediaType: "image/png", url: "https://example.com/first.png" },
    { type: "image", mediaType: "image/jpeg", data: "AQID" },
  ];

  await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.deepEqual(posted?.input, [{
    role: "user",
    content: [
      { type: "input_text", text: "compare these" },
      { type: "input_image", image_url: "https://example.com/first.png" },
      { type: "input_image", image_url: "data:image/jpeg;base64,AQID" },
    ],
  }]);
});

test("Anthropic maps lifecycle events and cumulative usage", async () => {
  const body = sse(
    {
      type: "message_start",
      message: {
        id: "msg-1",
        model: "claude-test",
        usage: { input_tokens: 200, cache_read_input_tokens: 700, cache_creation_input_tokens: 100 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100 } },
    { type: "message_stop" },
  );
  let requestBody: Record<string, unknown> | undefined;
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    fetch: fakeFetch(async (incoming) => {
      requestBody = JSON.parse(await incoming.text()) as Record<string, unknown>;
      return streamResponse(byteChunks(body));
    }),
  });
  const providerRequest = request("anthropic");
  providerRequest.messages.unshift({
    id: "system-default-cache",
    role: "system",
    content: [{ type: "text", text: "Stable system prompt" }],
    createdAt: "2026-07-09T00:00:00.000Z",
  });
  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  assert.deepEqual(
    events.filter((event) => event.type === "text_delta").map((event) => (event.type === "text_delta" ? event.text : "")),
    ["answer"],
  );
  const end = events.at(-1);
  assert.equal(end?.type === "response_end" ? end.reason : undefined, "stop");
  const usage = events.filter((event) => event.type === "usage").at(-1);
  assert.deepEqual(usage?.type === "usage" ? usage.usage : undefined, {
    raw: { output_tokens: 100 },
    inputTokens: 200,
    outputTokens: 100,
    cacheReadTokens: 700,
    cacheWriteTokens: 100,
    totalTokens: 1_100,
  });
  assert.equal(requestBody?.cache_control, undefined);
  assert.deepEqual(requestBody?.system, [{
    type: "text",
    text: "Stable system prompt",
    cache_control: { type: "ephemeral" },
  }]);
  assert.deepEqual(requestBody?.messages, [{ role: "user", content: [{ type: "text", text: "hello" }] }]);
});

test("Anthropic subscription credentials use bearer OAuth compatibility headers", async () => {
  let headers: Headers | undefined;
  let posted: Record<string, unknown> | undefined;
  const adapter = new AnthropicAdapter({
    accessToken: "subscription-token",
    oauth: async () => true,
    fetch: fakeFetch(async (incoming) => {
      headers = incoming.headers;
      posted = await incoming.json() as Record<string, unknown>;
      return streamResponse(byteChunks(sse(
        { type: "message_start", message: { id: "msg-oauth", model: "claude-test", usage: { input_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "Read", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      )));
    }),
  });

  const providerRequest = request("anthropic");
  providerRequest.tools = [
    { name: "read", description: "Read a file", inputSchema: { type: "object" } },
    { name: "custom_tool", description: "Custom tool", inputSchema: { type: "object" } },
  ];
  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));

  assert.equal(headers?.get("authorization"), "Bearer subscription-token");
  assert.equal(headers?.get("x-api-key"), null);
  assert.match(headers?.get("anthropic-beta") ?? "", /claude-code-20250219/u);
  assert.match(headers?.get("anthropic-beta") ?? "", /oauth-2025-04-20/u);
  assert.equal(headers?.get("x-app"), "cli");
  assert.equal(headers?.get("user-agent"), "rigyn/0.1.0");
  assert.equal(posted?.system, undefined);
  assert.deepEqual((posted?.tools as Array<{ name: string }>).map((tool) => tool.name), ["Read", "custom_tool"]);
  const tool = events.find((event) => event.type === "tool_call_end");
  assert.equal(tool?.type === "tool_call_end" ? tool.name : undefined, "read");
  const end = events.at(-1);
  assert.deepEqual(
    end?.type === "response_end" && end.state.kind === "anthropic_messages" ? end.state.assistantBlocks[0] : undefined,
    { type: "tool_use", id: "tool-1", name: "read", input: { path: "README.md" } },
  );
});

test("Anthropic maps harness effort levels to each current model's thinking contract", async () => {
  const posted = async (model: string, reasoningEffort: string): Promise<Record<string, unknown>> => {
    let body: Record<string, unknown> | undefined;
    const adapter = new AnthropicAdapter({
      apiKey: "secret",
      fetch: fakeFetch(async (incoming) => {
        body = await incoming.json() as Record<string, unknown>;
        return streamResponse(byteChunks(sse(
          { type: "message_start", message: { id: "message", model, usage: { input_tokens: 1 } } },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        )));
      }),
    });
    const providerRequest = request("anthropic");
    providerRequest.model = model;
    providerRequest.reasoningEffort = reasoningEffort;
    await collect(adapter.stream(providerRequest, new AbortController().signal));
    return body!;
  };

  assert.deepEqual((await posted("claude-sonnet-5", "off")).thinking, { type: "disabled" });
  const opusOff = await posted("claude-opus-4-8", "off");
  assert.equal(opusOff.thinking, undefined);
  assert.equal(opusOff.output_config, undefined);
  const fable = await posted("claude-fable-5", "high");
  assert.deepEqual(fable.thinking, { type: "adaptive" });
  assert.deepEqual(fable.output_config, { effort: "high" });
  const opus = await posted("claude-opus-4-8", "xhigh");
  assert.deepEqual(opus.thinking, { type: "adaptive" });
  assert.deepEqual(opus.output_config, { effort: "xhigh" });
  const legacy = await posted("claude-opus-4-5", "high");
  assert.deepEqual(legacy.thinking, { type: "enabled", budget_tokens: 7168 });
  assert.equal(legacy.output_config, undefined);
});

test("Anthropic applies explicit custom thinking compatibility and bounded manual budgets", async () => {
  let posted: Record<string, unknown> | undefined;
  let headers: Headers | undefined;
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    thinking: {
      budgets: { high: 4096 },
      models: {
        "partner-model": { mode: "enabled", interleaved: "beta" },
      },
    },
    fetch: fakeFetch(async (incoming) => {
      headers = incoming.headers;
      posted = await incoming.json() as Record<string, unknown>;
      return streamResponse(byteChunks(sse(
        { type: "message_start", message: { id: "message", model: "partner-model", usage: { input_tokens: 1 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      )));
    }),
  });
  const providerRequest = request("anthropic");
  providerRequest.model = "partner-model";
  providerRequest.reasoningEffort = "high";
  providerRequest.maxOutputTokens = 8192;
  providerRequest.tools = [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }];

  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));

  assert.equal(terminalCount(events), 1);
  assert.deepEqual(posted?.thinking, { type: "enabled", budget_tokens: 4096 });
  assert.equal(posted?.output_config, undefined);
  assert.match(headers?.get("anthropic-beta") ?? "", /interleaved-thinking-2025-05-14/u);
  assert.equal((posted?.tools as Array<{ name: string }>)[0]?.name, "read");

  assert.throws(
    () => new AnthropicAdapter({ apiKey: "secret", thinking: { budgets: { low: 1023 } } }),
    /budget low must be an integer from 1024/u,
  );
});

test("Anthropic live model metadata selects future adaptive contracts and effort levels", async () => {
  let posted: Record<string, unknown> | undefined;
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    fetch: fakeFetch(async (incoming) => {
      if (new URL(incoming.url).pathname.endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [{
            id: "future-adaptive-model",
            max_input_tokens: 300_000,
            max_tokens: 64_000,
            capabilities: {
              thinking: {
                supported: true,
                types: { adaptive: { supported: true }, enabled: { supported: false } },
              },
              effort: {
                supported: true,
                low: { supported: true },
                medium: { supported: true },
                high: { supported: true },
                xhigh: { supported: false },
                max: { supported: true },
              },
            },
          }],
          has_more: false,
        }), { headers: { "content-type": "application/json" } });
      }
      posted = await incoming.json() as Record<string, unknown>;
      return streamResponse(byteChunks(sse(
        { type: "message_start", message: { id: "message", model: "future-adaptive-model", usage: { input_tokens: 1 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      )));
    }),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.deepEqual(models[0]?.compatibility?.reasoningEfforts?.value, ["off", "minimal", "low", "medium", "high", "max"]);
  const providerRequest = request("anthropic");
  providerRequest.model = "future-adaptive-model";
  providerRequest.reasoningEffort = "minimal";
  await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.deepEqual(posted?.thinking, { type: "adaptive" });
  assert.deepEqual(posted?.output_config, { effort: "low" });
});

test("Anthropic round-trips signed and redacted thinking blocks unchanged across tool turns", async () => {
  const posted: Record<string, unknown>[] = [];
  let call = 0;
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    promptCache: "off",
    fetch: fakeFetch(async (incoming) => {
      posted.push(await incoming.json() as Record<string, unknown>);
      call += 1;
      if (call === 1) {
        return streamResponse(byteChunks(sse(
          { type: "message_start", message: { id: "first", model: "claude-opus-4-8", usage: { input_tokens: 1 } } },
          { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-signature" } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque-redaction" } },
          { type: "content_block_stop", index: 1 },
          { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tool-1", name: "read", input: {} } },
          { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' } },
          { type: "content_block_stop", index: 2 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        )));
      }
      return streamResponse(byteChunks(sse(
        { type: "message_start", message: { id: "second", model: "claude-opus-4-8", usage: { input_tokens: 1 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      )));
    }),
  });
  const firstRequest = request("anthropic");
  firstRequest.model = "claude-opus-4-8";
  firstRequest.reasoningEffort = "high";
  firstRequest.tools = [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }];
  const firstEvents = await collect(adapter.stream(firstRequest, new AbortController().signal));
  const firstEnd = firstEvents.at(-1);
  assert.equal(firstEnd?.type, "response_end");
  if (firstEnd?.type !== "response_end") return;

  const secondRequest = request("anthropic");
  secondRequest.model = "claude-opus-4-8";
  secondRequest.reasoningEffort = "high";
  secondRequest.tools = firstRequest.tools;
  secondRequest.providerState = firstEnd.state;
  secondRequest.messages.push(
    {
      id: "assistant-tool",
      role: "assistant",
      content: [{ type: "tool_call", callId: "tool-1", name: "read", arguments: { path: "README.md" } }],
      createdAt: "2026-07-09T00:01:00.000Z",
    },
    {
      id: "tool-result",
      role: "tool",
      content: [{ type: "tool_result", callId: "tool-1", name: "read", content: "contents", isError: false }],
      createdAt: "2026-07-09T00:02:00.000Z",
    },
  );
  await collect(adapter.stream(secondRequest, new AbortController().signal));

  const messages = posted[1]?.messages as Array<{ role: string; content: unknown[] }>;
  assert.deepEqual(messages[1]?.content, [
    { type: "thinking", thinking: "", signature: "opaque-signature" },
    { type: "redacted_thinking", data: "opaque-redaction" },
    { type: "tool_use", id: "tool-1", name: "read", input: { path: "README.md" } },
  ]);
});

test("Anthropic handles unsigned thinking explicitly for first-party and compatible endpoints", async () => {
  const posted = async (allowEmptySignature: boolean): Promise<Record<string, unknown>> => {
    let body: Record<string, unknown> | undefined;
    const adapter = new AnthropicAdapter({
      apiKey: "secret",
      promptCache: "off",
      ...(allowEmptySignature
        ? { thinking: { models: { "partner-model": { allowEmptySignature: true } } } }
        : {}),
      fetch: fakeFetch(async (incoming) => {
        body = await incoming.json() as Record<string, unknown>;
        return streamResponse(byteChunks(sse(
          { type: "message_start", message: { id: "message", model: "partner-model", usage: { input_tokens: 1 } } },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        )));
      }),
    });
    const providerRequest = request("anthropic");
    providerRequest.model = "partner-model";
    providerRequest.tools = [{ name: "read", description: "Read", inputSchema: { type: "object" } }];
    providerRequest.providerState = {
      kind: "anthropic_messages",
      assistantBlocks: [
        { type: "thinking", thinking: "partial reasoning", signature: "" },
        { type: "tool_use", id: "tool-1", name: "read", input: {} },
      ],
    };
    providerRequest.messages.push(
      {
        id: "assistant-tool",
        role: "assistant",
        content: [{ type: "tool_call", callId: "tool-1", name: "read", arguments: {} }],
        createdAt: "2026-07-09T00:01:00.000Z",
      },
      {
        id: "tool-result",
        role: "tool",
        content: [{ type: "tool_result", callId: "tool-1", name: "read", content: "done", isError: false }],
        createdAt: "2026-07-09T00:02:00.000Z",
      },
    );
    await collect(adapter.stream(providerRequest, new AbortController().signal));
    return body!;
  };

  const firstParty = await posted(false);
  const compatible = await posted(true);
  assert.deepEqual((firstParty.messages as Array<{ content: unknown[] }>)[1]?.content, [
    { type: "text", text: "partial reasoning" },
    { type: "tool_use", id: "tool-1", name: "read", input: {} },
  ]);
  assert.deepEqual((compatible.messages as Array<{ content: unknown[] }>)[1]?.content, [
    { type: "thinking", thinking: "partial reasoning", signature: "" },
    { type: "tool_use", id: "tool-1", name: "read", input: {} },
  ]);
});

test("Anthropic prompt caching uses bounded stable-prefix breakpoints", async () => {
  const terminal = sse(
    { type: "message_start", message: { id: "msg-cache", model: "claude-test", usage: { input_tokens: 1 } } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  );
  const bodies: Record<string, unknown>[] = [];
  for (const promptCache of ["off", "1h"] as const) {
    const providerRequest = request("anthropic");
    if (promptCache === "1h") {
      providerRequest.tools = [
        { name: "read", description: "Read a file", inputSchema: { type: "object" } },
        { name: "edit", description: "Edit a file", inputSchema: { type: "object" } },
      ];
      providerRequest.messages = [
        {
          id: "system-cache",
          role: "system",
          content: [{ type: "text", text: "Stable coding instructions" }],
          createdAt: "2026-07-09T00:00:00.000Z",
        },
        {
          id: "history-user",
          role: "user",
          content: Array.from({ length: 25 }, (_, index) => ({
            type: "text" as const,
            text: `history-${index + 1}`,
          })),
          createdAt: "2026-07-09T00:01:00.000Z",
        },
        {
          id: "history-assistant",
          role: "assistant",
          content: [{ type: "text", text: "Stable prior answer" }],
          createdAt: "2026-07-09T00:02:00.000Z",
        },
        {
          id: "current-user",
          role: "user",
          content: [{ type: "text", text: "Volatile latest request" }],
          createdAt: "2026-07-09T00:03:00.000Z",
        },
      ];
    }
    const adapter = new AnthropicAdapter({
      apiKey: "secret",
      promptCache,
      fetch: fakeFetch(async (incoming) => {
        bodies.push(JSON.parse(await incoming.text()) as Record<string, unknown>);
        return streamResponse(byteChunks(terminal));
      }),
    });
    const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
    const usage = events.filter((event) => event.type === "usage").at(-1);
    assert.equal(usage?.type === "usage" ? usage.usage.cacheReadTokens : undefined, undefined);
    assert.equal(usage?.type === "usage" ? usage.usage.cacheWriteTokens : undefined, undefined);
  }
  assert.deepEqual(bodies[0], {
    model: "test-model",
    max_tokens: 8192,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    stream: true,
  });

  const cacheControl = { type: "ephemeral", ttl: "1h" };
  assert.equal(bodies[1]?.cache_control, undefined);
  assert.deepEqual(bodies[1], {
    model: "test-model",
    max_tokens: 8192,
    messages: [
      {
        role: "user",
        content: Array.from({ length: 25 }, (_, index) => ({
          type: "text",
          text: `history-${index + 1}`,
          ...(index === 5 ? { cache_control: cacheControl } : {}),
        })),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Stable prior answer", cache_control: cacheControl }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Volatile latest request" }],
      },
    ],
    stream: true,
    system: [{ type: "text", text: "Stable coding instructions", cache_control: cacheControl }],
    tools: [
      { name: "read", description: "Read a file", input_schema: { type: "object" } },
      { name: "edit", description: "Edit a file", input_schema: { type: "object" }, cache_control: cacheControl },
    ],
  });
});

test("Anthropic normalizes reported cache creation tiers without estimating hits", async () => {
  const body = sse(
    {
      type: "message_start",
      message: {
        id: "msg-tiered-cache",
        model: "claude-test",
        usage: {
          input_tokens: 5,
          cache_read_input_tokens: 30,
          cache_creation: {
            ephemeral_5m_input_tokens: 7,
            ephemeral_1h_input_tokens: 11,
          },
        },
      },
    },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  );
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    fetch: fakeFetch(() => streamResponse(byteChunks(body))),
  });

  const events = await collect(adapter.stream(request("anthropic"), new AbortController().signal));
  const usageEvents = events.filter((event) => event.type === "usage");
  const first = usageEvents[0];
  assert.deepEqual(first?.type === "usage" ? first.usage : undefined, {
    raw: {
      input_tokens: 5,
      cache_read_input_tokens: 30,
      cache_creation: {
        ephemeral_5m_input_tokens: 7,
        ephemeral_1h_input_tokens: 11,
      },
    },
    inputTokens: 5,
    cacheReadTokens: 30,
    cacheWriteTokens: 18,
    totalTokens: 53,
  });
  assert.deepEqual(usageEvents.at(-1)?.type === "usage" ? usageEvents.at(-1)?.usage : undefined, {
    raw: { output_tokens: 2 },
    inputTokens: 5,
    outputTokens: 2,
    cacheReadTokens: 30,
    cacheWriteTokens: 18,
    totalTokens: 55,
  });
});

test("Gemini generateContent keeps thought signatures and maps complete function calls", async () => {
  const chunk = {
    responseId: "gemini-response",
    modelVersion: "gemini-test",
    candidates: [
      {
        index: 0,
        finishReason: "STOP",
        content: {
          role: "model",
          parts: [
            { text: "thinking", thought: true, thoughtSignature: "opaque-signature" },
            { functionCall: { id: "call-1", name: "lookup", args: { key: "value" } } },
          ],
        },
      },
    ],
    usageMetadata: {
      promptTokenCount: 1_000,
      cachedContentTokenCount: 800,
      toolUsePromptTokenCount: 50,
      candidatesTokenCount: 100,
      thoughtsTokenCount: 200,
      totalTokenCount: 1_350,
    },
  };
  const adapter = new GeminiAdapter({
    apiKey: "secret",
    fetch: fakeFetch(() => streamResponse(byteChunks(sse(chunk), [2, 1, 4, 1, 8]))),
  });
  const events = await collect(adapter.stream(request("gemini"), new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  const tool = events.find((event) => event.type === "tool_call_end");
  assert.deepEqual(tool?.type === "tool_call_end" ? tool.arguments : undefined, { key: "value" });
  const end = events.at(-1);
  if (end?.type !== "response_end") assert.fail("missing response_end");
  assert.equal(end.reason, "tool_calls");
  assert.equal(end.state.kind, "gemini_generate_content");
  if (end.state.kind === "gemini_generate_content") {
    assert.equal((end.state.parts[0] as { thoughtSignature?: string }).thoughtSignature, "opaque-signature");
  }
  const usage = events.find((event) => event.type === "usage");
  assert.deepEqual(usage?.type === "usage" ? usage.usage : undefined, {
    raw: {
      promptTokenCount: 1_000,
      cachedContentTokenCount: 800,
      toolUsePromptTokenCount: 50,
      candidatesTokenCount: 100,
      thoughtsTokenCount: 200,
      totalTokenCount: 1_350,
    },
    inputTokens: 250,
    outputTokens: 300,
    cacheReadTokens: 800,
    reasoningTokens: 200,
    totalTokens: 1_350,
  });
});

test("OpenAI-compatible chat assembles interleaved tool arguments and final usage", async () => {
  const body =
    sse(
      {
        id: "chat-1",
        model: "test-model",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "a", function: { name: "one", arguments: '{"a":' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chat-1",
        model: "test-model",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 1, id: "b", function: { name: "two", arguments: '{"b":2}' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chat-1",
        model: "test-model",
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" },
        ],
      },
      {
        id: "chat-1",
        model: "test-model",
        choices: [],
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 100,
          total_tokens: 1_100,
          prompt_tokens_details: { cached_tokens: 800 },
          completion_tokens_details: { reasoning_tokens: 40 },
        },
      },
    ) + "data: [DONE]\n\n";
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => streamResponse(byteChunks(body))),
  });
  const events = await collect(adapter.stream(request("openai-compatible"), new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  const completed = events.filter((event) => event.type === "tool_call_end");
  assert.deepEqual(
    completed.map((event) => (event.type === "tool_call_end" ? event.arguments : undefined)),
    [{ a: 1 }, { b: 2 }],
  );
  const usage = events.find((event) => event.type === "usage");
  assert.deepEqual(usage?.type === "usage" ? usage.usage : undefined, {
    raw: {
      prompt_tokens: 1_000,
      completion_tokens: 100,
      total_tokens: 1_100,
      prompt_tokens_details: { cached_tokens: 800 },
      completion_tokens_details: { reasoning_tokens: 40 },
    },
    inputTokens: 200,
    outputTokens: 100,
    cacheReadTokens: 800,
    reasoningTokens: 40,
    totalTokens: 1_100,
  });
});

test("compatible provider profiles change only documented request and continuation fields", async (t) => {
  const response = sse({
    id: "profile-response",
    model: "profile-model",
    choices: [{
      index: 0,
      delta: { reasoning_content: "private trace", content: "done" },
      finish_reason: "stop",
    }],
  }) + "data: [DONE]\n\n";
  const cases = [
    {
      profile: "zai" as const,
      expected: {
        max_tokens: 2_048,
        max_completion_tokens: undefined,
        stream_options: undefined,
        tool_stream: true,
        parallel_tool_calls: undefined,
        reasoning_effort: "high",
      },
      reasoningKey: "reasoning_content",
    },
    {
      profile: "kimi-coding" as const,
      expected: {
        max_tokens: undefined,
        max_completion_tokens: 2_048,
        stream_options: { include_usage: true },
        tool_stream: undefined,
        parallel_tool_calls: undefined,
        reasoning_effort: "high",
      },
      reasoningKey: "reasoning_content",
    },
    {
      profile: "minimax" as const,
      expected: {
        max_tokens: undefined,
        max_completion_tokens: 2_048,
        stream_options: { include_usage: true },
        tool_stream: undefined,
        parallel_tool_calls: undefined,
        reasoning_effort: "high",
        reasoning_split: true,
      },
      reasoningKey: "reasoning_content",
    },
  ];

  for (const entry of cases) await t.test(entry.profile, async () => {
    let posted: Record<string, unknown> | undefined;
    const adapter = new OpenAICompatibleAdapter({
      id: entry.profile,
      baseUrl: "https://compatible.example/v1",
      profile: entry.profile,
      fetch: fakeFetch(async (incoming) => {
        posted = await incoming.json() as Record<string, unknown>;
        return streamResponse(byteChunks(response));
      }),
    });
    const providerRequest = request(entry.profile);
    providerRequest.maxOutputTokens = 2_048;
    providerRequest.reasoningEffort = "high";
    providerRequest.tools = [{
      name: "read",
      description: "Read a file",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }];
    const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
    for (const [name, expected] of Object.entries(entry.expected)) {
      assert.deepEqual(posted?.[name], expected, `${entry.profile}.${name}`);
    }
    const end = events.at(-1);
    assert.equal(end?.type, "response_end");
    if (end?.type === "response_end" && end.state.kind === "chat_completions") {
      const assistant = end.state.assistantMessage;
      assert.ok(assistant !== null && typeof assistant === "object" && !Array.isArray(assistant));
      assert.equal(assistant[entry.reasoningKey], "private trace");
      assert.equal(assistant.reasoning, undefined);
    }
  });
});

test("MiniMax profile de-duplicates cumulative reasoning details and preserves the final state", async () => {
  const response = sse(
    {
      id: "minimax-reasoning",
      model: "MiniMax-M3",
      choices: [{
        index: 0,
        delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "think" }] },
        finish_reason: null,
      }],
    },
    {
      id: "minimax-reasoning",
      model: "MiniMax-M3",
      choices: [{
        index: 0,
        delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "thinking" }], content: "done" },
        finish_reason: "stop",
      }],
    },
  ) + "data: [DONE]\n\n";
  const adapter = new OpenAICompatibleAdapter({
    id: "minimax",
    baseUrl: "https://api.minimax.io/v1",
    profile: "minimax",
    fetch: fakeFetch(() => streamResponse(byteChunks(response))),
  });

  const events = await collect(adapter.stream(request("minimax"), new AbortController().signal));
  assert.deepEqual(
    events.filter((event) => event.type === "reasoning_delta").map((event) => event.type === "reasoning_delta" ? event.text : ""),
    ["think", "ing"],
  );
  const end = events.at(-1);
  assert.equal(end?.type, "response_end");
  if (end?.type === "response_end" && end.state.kind === "chat_completions") {
    const assistant = end.state.assistantMessage;
    assert.ok(assistant !== null && typeof assistant === "object" && !Array.isArray(assistant));
    assert.deepEqual(assistant.reasoning_details, [{ type: "reasoning.text", index: 0, text: "thinking" }]);
  }
});

test("compatible provider finish aliases preserve actionable terminal categories", async () => {
  const cases = {
    model_context_window_exceeded: "length",
    sensitive: "content_filter",
    network_error: "error",
  } as const;
  for (const [rawReason, expected] of Object.entries(cases)) {
    const response = sse({
      id: `finish-${rawReason}`,
      model: "profile-model",
      choices: [{ index: 0, delta: { content: "partial" }, finish_reason: rawReason }],
    }) + "data: [DONE]\n\n";
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "https://compatible.example/v1",
      fetch: fakeFetch(() => streamResponse(byteChunks(response))),
    });
    const events = await collect(adapter.stream(request("openai-compatible"), new AbortController().signal));
    const end = events.at(-1);
    assert.equal(end?.type, "response_end");
    if (end?.type === "response_end") assert.equal(end.reason, expected, rawReason);
  }
});

test("OpenAI-compatible chat accepts choice-level usage without double-counting cache tokens", async () => {
  const nativeUsage = {
    prompt_tokens: 1_000,
    completion_tokens: 100,
    total_tokens: 1_100,
    prompt_tokens_details: { cached_tokens: 700, cache_write_tokens: 100 },
    completion_tokens_details: { reasoning_tokens: 40 },
    cost: 0.00125,
  };
  const body = sse({
    id: "chat-choice-usage",
    model: "test-model",
    choices: [{
      index: 0,
      delta: { content: "done" },
      finish_reason: "stop",
      usage: nativeUsage,
    }],
  }) + "data: [DONE]\n\n";
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => streamResponse(byteChunks(body))),
  });

  const events = await collect(adapter.stream(request("openai-compatible"), new AbortController().signal));
  const usages = events.filter((event) => event.type === "usage");
  assert.deepEqual(usages, [{
    type: "usage",
    semantics: "final",
    usage: {
      raw: nativeUsage,
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 700,
      cacheWriteTokens: 100,
      reasoningTokens: 40,
      totalTokens: 1_100,
      cost: "0.00125",
    },
  }]);
});

test("OpenAI-compatible chat correlates ID-only fragments and preserves the first indexed tool ID", async () => {
  const body = sse(
    {
      id: "chat-tools",
      model: "test-model",
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 4, id: "stable-id", function: { name: "one", arguments: '{"a":' } }] },
        finish_reason: null,
      }],
    },
    {
      id: "chat-tools",
      model: "test-model",
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 4, id: "mutated-id", function: { arguments: "1}" } }] },
        finish_reason: null,
      }],
    },
    {
      id: "chat-tools",
      model: "test-model",
      choices: [{
        index: 0,
        delta: { tool_calls: [
          { id: "id-only", function: { name: "two", arguments: '{"b":' } },
          { index: 9, id: "mixed-id", function: { name: "three", arguments: '{"c":' } },
        ] },
        finish_reason: null,
      }],
    },
    {
      id: "chat-tools",
      model: "test-model",
      choices: [{
        index: 0,
        delta: { tool_calls: [
          { id: "id-only", function: { arguments: "2}" } },
          { id: "mixed-id", function: { arguments: "3}" } },
        ] },
        finish_reason: "tool_calls",
      }],
    },
  ) + "data: [DONE]\n\n";
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => streamResponse(byteChunks(body))),
  });

  const events = await collect(adapter.stream(request("openai-compatible"), new AbortController().signal));
  const completed = events.filter((event) => event.type === "tool_call_end");
  const byId = new Map<string, (typeof completed)[number]>();
  for (const event of completed) if (event.id !== undefined) byId.set(event.id, event);
  assert.equal(byId.has("mutated-id"), false);
  assert.deepEqual(byId.get("stable-id")?.arguments, { a: 1 });
  assert.deepEqual(byId.get("id-only")?.arguments, { b: 2 });
  assert.deepEqual(byId.get("mixed-id")?.arguments, { c: 3 });
  assert.equal(events.at(-1)?.type, "response_end");
});

test("OpenAI-compatible chat rejects an unidentifiable fragment when parallel calls are active", async () => {
  const body = sse(
    {
      id: "chat-ambiguous",
      model: "test-model",
      choices: [{
        index: 0,
        delta: { tool_calls: [
          { index: 0, id: "first", function: { name: "one", arguments: "{" } },
          { index: 1, id: "second", function: { name: "two", arguments: "{" } },
        ] },
        finish_reason: null,
      }],
    },
    {
      id: "chat-ambiguous",
      model: "test-model",
      choices: [{
        index: 0,
        delta: { tool_calls: [{ function: { arguments: "}" } }] },
        finish_reason: "tool_calls",
      }],
    },
  );
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => streamResponse(byteChunks(body))),
  });

  const events = await collect(adapter.stream(request("openai-compatible"), new AbortController().signal));
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  assert.match(terminal?.type === "error" ? terminal.error.message : "", /no index or ID and is ambiguous/u);
});

test("OpenAI-compatible chat rejects an unknown ID-only continuation when parallel calls are active", async () => {
  const body = sse(
    {
      id: "chat-ambiguous-id",
      model: "test-model",
      choices: [{
        index: 0,
        delta: { tool_calls: [
          { index: 0, id: "first", function: { name: "one", arguments: "{" } },
          { index: 1, id: "second", function: { name: "two", arguments: "{" } },
        ] },
        finish_reason: null,
      }],
    },
    {
      id: "chat-ambiguous-id",
      model: "test-model",
      choices: [{
        index: 0,
        delta: { tool_calls: [{ id: "mutated-or-new", function: { arguments: "}" } }] },
        finish_reason: "tool_calls",
      }],
    },
  );
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => streamResponse(byteChunks(body))),
  });

  const events = await collect(adapter.stream(request("openai-compatible"), new AbortController().signal));
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  assert.match(terminal?.type === "error" ? terminal.error.message : "", /unknown ID.*ambiguous/u);
});

test("OpenAI-compatible chat correlates ordered parallel fragments without indexes or repeated IDs", async () => {
  const body = sse(
    {
      id: "chat-indexless-parallel",
      model: "test-model",
      choices: [{
        index: 0,
        delta: { tool_calls: [
          { id: "stable-first", function: { name: "one", arguments: '{"a":' } },
          { id: "stable-second", function: { name: "two", arguments: '{"b":' } },
        ] },
        finish_reason: null,
      }],
    },
    {
      id: "chat-indexless-parallel",
      model: "test-model",
      choices: [{
        index: 0,
        delta: { tool_calls: [
          { function: { arguments: "1}" } },
          { function: { arguments: "2}" } },
        ] },
        finish_reason: "tool_calls",
      }],
    },
  ) + "data: [DONE]\n\n";
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => streamResponse(byteChunks(body))),
  });

  const events = await collect(adapter.stream(request("openai-compatible"), new AbortController().signal));
  const completed = events.filter((event) => event.type === "tool_call_end");
  assert.deepEqual(completed.map((event) => [event.id, event.name, event.arguments]), [
    ["stable-first", "one", { a: 1 }],
    ["stable-second", "two", { b: 2 }],
  ]);
  assert.equal(events.at(-1)?.type, "response_end");
});

test("OpenAI-compatible chat preserves a stable ID when an indexless continuation mutates it", async () => {
  const body = sse(
    {
      id: "chat-indexless-mutated-id",
      model: "test-model",
      choices: [{
        index: 0,
        delta: { tool_calls: [
          { id: "stable-id", function: { name: "lookup", arguments: '{"key":' } },
        ] },
        finish_reason: null,
      }],
    },
    {
      id: "chat-indexless-mutated-id",
      model: "test-model",
      choices: [{
        index: 0,
        delta: { tool_calls: [
          { id: "mutated-id", function: { arguments: '"value"}' } },
        ] },
        finish_reason: "tool_calls",
      }],
    },
  ) + "data: [DONE]\n\n";
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => streamResponse(byteChunks(body))),
  });

  const events = await collect(adapter.stream(request("openai-compatible"), new AbortController().signal));
  const completed = events.filter((event) => event.type === "tool_call_end");
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0], {
    type: "tool_call_end",
    index: 0,
    id: "stable-id",
    name: "lookup",
    rawArguments: '{"key":"value"}',
    arguments: { key: "value" },
  });
  assert.equal(events.at(-1)?.type, "response_end");
});

test("OpenRouter surfaces HTTP-200 midstream errors as partial terminal errors", async () => {
  let posted: Record<string, unknown> | undefined;
  const body = sse(
    {
      id: "generation-1",
      model: "openai/test",
      choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
    },
    {
      id: "generation-1",
      model: "openai/test",
      error: { code: 502, message: "provider disconnected", metadata: { error_type: "provider_unavailable" } },
      choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
    },
  );
  const adapter = new OpenRouterAdapter({
    apiKey: "secret",
    promptCache: "1h",
    fetch: fakeFetch(async (incoming) => {
      posted = await incoming.json() as Record<string, unknown>;
      return streamResponse(byteChunks(body), { "x-generation-id": "generation-1" });
    }),
  });
  const providerRequest = request("openrouter");
  providerRequest.sessionId = "thread-stable-session";
  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  const error = events.at(-1);
  assert.equal(error?.type, "error");
  if (error?.type === "error") {
    assert.equal(error.error.partial, true);
    assert.equal(error.error.providerCode, "provider_unavailable");
    assert.equal(error.error.requestId, "generation-1");
  }
  assert.equal(posted?.session_id, "thread-stable-session");
  assert.deepEqual(posted?.cache_control, { type: "ephemeral", ttl: "1h" });
});

test("Mistral uses session affinity, native token fields, and correlated short tool IDs", async () => {
  let posted: Record<string, unknown> | undefined;
  let affinity = "";
  const body = sse(
    {
      id: "mistral-response",
      model: "codestral-latest",
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "Abc123XyZ", function: { name: "read", arguments: '{"path":"README.md"}' } }] },
        finish_reason: "tool_calls",
      }],
    },
    {
      id: "mistral-response",
      model: "codestral-latest",
      choices: [],
      usage: { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100, cache_read_tokens: 800 },
    },
  ) + "data: [DONE]\n\n";
  const adapter = new MistralAdapter({
    apiKey: "offline",
    fetch: fakeFetch(async (incoming) => {
      affinity = incoming.headers.get("x-affinity") ?? "";
      posted = await incoming.json() as Record<string, unknown>;
      return streamResponse(byteChunks(body));
    }),
  });
  const providerRequest = request("mistral");
  providerRequest.model = "codestral-latest";
  providerRequest.sessionId = `session unsafe ${"x".repeat(160)}`;
  providerRequest.maxOutputTokens = 2_048;
  providerRequest.reasoningEffort = "high";
  providerRequest.messages = [
    providerRequest.messages[0]!,
    {
      id: "assistant-tool",
      role: "assistant",
      content: [{ type: "tool_call", callId: "tool-call:with punctuation", name: "read", arguments: { path: "README.md" } }],
      createdAt: "2026-07-09T00:00:01.000Z",
    },
    {
      id: "tool-result",
      role: "tool",
      content: [{ type: "tool_result", callId: "tool-call:with punctuation", name: "read", content: "ok", isError: false }],
      createdAt: "2026-07-09T00:00:02.000Z",
    },
    {
      id: "message-2",
      role: "user",
      content: [{ type: "text", text: "continue" }],
      createdAt: "2026-07-09T00:00:03.000Z",
    },
  ];
  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  assert.match(affinity, /^session_[a-f0-9]{32}$/u);
  assert.equal(posted?.prompt_cache_key, affinity);
  assert.equal(posted?.max_tokens, 2_048);
  assert.equal(posted?.max_completion_tokens, undefined);
  assert.equal(posted?.reasoning_effort, "high");
  const messages = posted?.messages as Array<Record<string, unknown>>;
  const assistantCall = (messages[1]?.tool_calls as Array<{ id: string }> | undefined)?.[0]?.id;
  const resultCall = messages[2]?.tool_call_id;
  assert.match(assistantCall ?? "", /^[A-Za-z0-9]{9}$/u);
  assert.equal(resultCall, assistantCall);
  const tool = events.find((event) => event.type === "tool_call_end");
  assert.equal(tool?.type === "tool_call_end" ? tool.id : undefined, "Abc123XyZ");
  const usage = events.find((event) => event.type === "usage");
  assert.deepEqual(usage?.type === "usage" ? usage.usage : undefined, {
    raw: { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100, cache_read_tokens: 800 },
    inputTokens: 200,
    outputTokens: 100,
    cacheReadTokens: 800,
    totalTokens: 1_100,
  });
});

test("Mistral prompt-mode reasoning and cache opt-out change only provider-native fields", async () => {
  let posted: Record<string, unknown> | undefined;
  let affinity: string | null = "unexpected";
  const adapter = new MistralAdapter({
    apiKey: "offline",
    promptCache: "off",
    reasoningMode: "prompt",
    fetch: fakeFetch(async (incoming) => {
      affinity = incoming.headers.get("x-affinity");
      posted = await incoming.json() as Record<string, unknown>;
      return streamResponse(byteChunks(sse({
        id: "mistral-response",
        model: "magistral-small-latest",
        choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
      }) + "data: [DONE]\n\n"));
    }),
  });
  const providerRequest = request("mistral");
  providerRequest.sessionId = "stable-session";
  providerRequest.reasoningEffort = "medium";
  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  assert.equal(affinity, null);
  assert.equal(posted?.prompt_cache_key, undefined);
  assert.equal(posted?.prompt_mode, "reasoning");
  assert.equal(posted?.reasoning_effort, undefined);
  assert.throws(
    () => new MistralAdapter({ headers: { "x-affinity": "unsafe affinity" } }),
    /x-affinity header/u,
  );
});

test("Ollama maps NDJSON thinking/text/usage and rejects truncated streams", async () => {
  const complete = [
    JSON.stringify({ model: "local", message: { role: "assistant", thinking: "think", content: "" }, done: false }),
    JSON.stringify({
      model: "local",
      message: { role: "assistant", content: "done" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 3,
      eval_count: 2,
      total_duration: 2_000_000,
    }),
  ].join("\n");
  const adapter = new OllamaAdapter({
    fetch: fakeFetch(() => streamResponse(byteChunks(complete), { "content-type": "application/x-ndjson" })),
  });
  const events = await collect(adapter.stream(request("ollama"), new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  const terminal = events.at(-1);
  assert.equal(terminal?.type === "response_end" ? terminal.reason : undefined, "stop");

  const truncated = new OllamaAdapter({
    fetch: fakeFetch(() =>
      streamResponse(
        byteChunks(JSON.stringify({ model: "local", message: { role: "assistant", content: "partial" }, done: false })),
        { "content-type": "application/x-ndjson" },
      ),
    ),
  });
  const truncatedEvents = await collect(truncated.stream(request("ollama"), new AbortController().signal));
  assert.equal(terminalCount(truncatedEvents), 1);
  const error = truncatedEvents.at(-1);
  assert.equal(error?.type === "error" ? error.error.category : undefined, "protocol");
  assert.equal(error?.type === "error" ? error.error.partial : undefined, true);
});

test("Gemini GenerateContent model discovery follows page tokens", async () => {
  const urls: string[] = [];
  const adapter = new GeminiAdapter({
    apiKey: "secret",
    fetch: fakeFetch((requestValue) => {
      urls.push(requestValue.url);
      const token = new URL(requestValue.url).searchParams.get("pageToken");
      return new Response(JSON.stringify(token === null
        ? { models: [{ name: "models/first", inputTokenLimit: 1000 }], nextPageToken: "next" }
        : { models: [{ name: "models/second", inputTokenLimit: 2000 }] }), {
        headers: { "content-type": "application/json" },
      });
    }),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.deepEqual(models.map((model) => [model.id, model.contextTokens]), [["first", 1000], ["second", 2000]]);
  assert.equal(new URL(urls[0]!).searchParams.get("pageSize"), "1000");
  assert.equal(new URL(urls[1]!).searchParams.get("pageToken"), "next");
});

test("Anthropic model discovery follows cursor pages and reads current capabilities", async () => {
  const cursors: Array<string | null> = [];
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    fetch: fakeFetch((requestValue) => {
      const cursor = new URL(requestValue.url).searchParams.get("after_id");
      cursors.push(cursor);
      return new Response(JSON.stringify(cursor === null
        ? {
            data: [{ id: "claude-first", max_input_tokens: 200_000, capabilities: { thinking: { supported: true }, image_input: { supported: true } } }],
            has_more: true,
            last_id: "claude-first",
          }
        : { data: [{ id: "claude-second", max_input_tokens: 100_000 }], has_more: false, last_id: "claude-second" }), {
        headers: { "content-type": "application/json" },
      });
    }),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.deepEqual(models.map((model) => [model.id, model.contextTokens]), [["claude-first", 200_000], ["claude-second", 100_000]]);
  assert.equal(models[0]?.capabilities.reasoning.value, "supported");
  assert.equal(models[0]?.capabilities.images.value, "supported");
  assert.equal(models[0]?.compatibility?.cacheMode?.value, "explicit");
  assert.deepEqual(models[0]?.compatibility?.cacheTiers?.value, ["5m"]);
  assert.deepEqual(cursors, [null, "claude-first"]);
});
