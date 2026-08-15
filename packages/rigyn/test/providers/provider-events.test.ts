import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicAdapter } from "../../src/providers/anthropic.js";
import { GeminiAdapter, VertexAdapter } from "../../src/providers/gemini.js";
import { OllamaAdapter } from "../../src/providers/ollama.js";
import { OpenAICompatibleAdapter, OpenRouterAdapter } from "../../src/providers/openai-compatible.js";
import {
  AzureOpenAIResponsesAdapter,
  buildResponsesBody,
  OpenAIResponsesAdapter,
} from "../../src/providers/openai-responses.js";
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
        service_tier: "priority",
        usage: {
          input_tokens: 1_000,
          output_tokens: 100,
          total_tokens: 1_100,
          input_tokens_details: { cached_tokens: 700, cache_write_tokens: 100 },
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
      input_tokens_details: { cached_tokens: 700, cache_write_tokens: 100 },
      output_tokens_details: { reasoning_tokens: 40 },
      service_tier: "priority",
    },
    inputTokens: 200,
    outputTokens: 100,
    cacheReadTokens: 700,
    cacheWriteTokens: 100,
    reasoningTokens: 40,
    totalTokens: 1_100,
  });
});

test("OpenAI Responses cache opt-out removes configured body and session affinity fields", async () => {
  let posted: Record<string, unknown> | undefined;
  let postedHeaders: Headers | undefined;
  const adapter = new OpenAIResponsesAdapter({
    apiKey: "secret",
    headers: {
      session_id: "configured-session",
      "x-session-id": "configured-session",
      "x-client-request-id": "configured-session",
      "x-session-affinity": "configured-session",
    },
    promptCacheOptions: { ttl: "30m" },
    promptCacheRetention: "24h",
    fetch: fakeFetch(async (incoming) => {
      postedHeaders = incoming.headers;
      posted = await incoming.json() as Record<string, unknown>;
      return streamResponse(byteChunks(sse(
        { type: "response.created", response: { id: "response-none", model: "gpt-test" } },
        {
          type: "response.completed",
          response: { id: "response-none", model: "gpt-test", usage: { input_tokens: 1, output_tokens: 0 } },
        },
      )));
    }),
  });
  const providerRequest = request("openai");
  providerRequest.sessionId = "summary-session";
  providerRequest.cacheRetention = "none";

  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));

  assert.equal(terminalCount(events), 1);
  assert.equal(posted?.prompt_cache_key, undefined);
  assert.equal(posted?.prompt_cache_options, undefined);
  assert.equal(posted?.prompt_cache_retention, undefined);
  assert.equal(postedHeaders?.get("session_id"), null);
  assert.equal(postedHeaders?.get("x-session-id"), null);
  assert.equal(postedHeaders?.get("x-client-request-id"), null);
  assert.equal(postedHeaders?.get("x-session-affinity"), null);
});

test("OpenAI Responses cache opt-out disables implicit caching only when the model supports it", () => {
  const unsupported = request("openai");
  unsupported.cacheRetention = "none";
  unsupported.sessionId = "summary-session";
  assert.equal(buildResponsesBody(unsupported, false, true).prompt_cache_options, undefined);

  const supported = structuredClone(unsupported);
  supported.modelSettings = {
    compatibility: { supportsExplicitPromptCacheMode: true },
  };
  const body = buildResponsesBody(supported, false, true);
  assert.deepEqual(body.prompt_cache_options, { mode: "explicit" });
  assert.equal(body.prompt_cache_key, undefined);
  assert.equal(body.prompt_cache_retention, undefined);
});

test("OpenAI Responses marks the stable instruction prefix only on the standard breakpoint API", () => {
  const standard = request("openai");
  standard.api = "openai-responses";
  standard.sessionId = "stable-session";
  standard.cacheRetention = "short";
  standard.messages.unshift({
    id: "system",
    role: "system",
    content: [{ type: "text", text: "Stable coding instructions" }],
    createdAt: "2026-07-09T00:00:00.000Z",
  });
  standard.modelSettings = {
    compatibility: {
      supportsExplicitPromptCacheMode: true,
      supportsPromptCacheBreakpoints: true,
    },
  };

  const body = buildResponsesBody(standard, false, true);
  assert.deepEqual(body.prompt_cache_options, { mode: "explicit", ttl: "30m" });
  assert.equal(body.prompt_cache_retention, undefined);
  const input = body.input as Array<Record<string, unknown>>;
  assert.deepEqual(input[0], {
    role: "system",
    content: [{
      type: "input_text",
      text: "Stable coding instructions",
      prompt_cache_breakpoint: { mode: "explicit" },
    }],
  });
  assert.equal(JSON.stringify(input[1]).includes("prompt_cache_breakpoint"), false);

  const codex = structuredClone(standard);
  codex.provider = "openai-codex";
  codex.api = "openai-responses";
  const codexBody = buildResponsesBody(codex, false, true);
  assert.equal(codexBody.prompt_cache_options, undefined);
  assert.equal(JSON.stringify(codexBody.input).includes("prompt_cache_breakpoint"), false);
});

test("OpenAI Responses maps per-request cache retention on models before breakpoint caching", () => {
  const providerRequest = request("openai");
  providerRequest.api = "openai-responses";
  providerRequest.cacheRetention = "short";
  assert.equal(buildResponsesBody(providerRequest, false, true).prompt_cache_retention, "in_memory");

  providerRequest.cacheRetention = "long";
  providerRequest.modelSettings = { compatibility: { supportsLongCacheRetention: true } };
  assert.equal(buildResponsesBody(providerRequest, false, true).prompt_cache_retention, "24h");

  providerRequest.modelSettings = { compatibility: { supportsLongCacheRetention: false } };
  assert.equal(buildResponsesBody(providerRequest, false, true).prompt_cache_retention, "in_memory");
});

test("OpenAI Responses enforces the provider minimum output limit", () => {
  const providerRequest = request("openai");
  providerRequest.maxOutputTokens = 1;
  assert.equal(buildResponsesBody(providerRequest, false, false).max_output_tokens, 16);
});

test("OpenAI Responses forwards sampling, named tool choice, and disabled reasoning", () => {
  const providerRequest = request("openai");
  providerRequest.temperature = 0.25;
  providerRequest.toolChoice = { type: "function", function: { name: "read" } };
  providerRequest.reasoningEffort = "off";
  const body = buildResponsesBody(providerRequest, false, false, undefined, undefined, undefined, false, true);
  assert.equal(body.temperature, 0.25);
  assert.deepEqual(body.tool_choice, { type: "function", name: "read" });
  assert.deepEqual(body.reasoning, { effort: "none" });

  providerRequest.modelSettings = { reasoningEffortMap: { off: "off" } };
  assert.deepEqual(buildResponsesBody(providerRequest, false, false).reasoning, { effort: "none" });

  providerRequest.modelSettings = { reasoningEffortMap: { off: null } };
  assert.equal(buildResponsesBody(providerRequest, false, false).reasoning, undefined);
});

test("Responses builders preserve custom effort mappings but reject ultra", () => {
  const custom = request("custom");
  custom.reasoningEffort = "xhigh";
  custom.modelSettings = { reasoningEffortMap: { xhigh: "provider-extra-high" } };
  assert.deepEqual(buildResponsesBody(custom, false, false).reasoning, { effort: "provider-extra-high" });

  custom.modelSettings = { reasoningEffortMap: { xhigh: "ultra" } };
  assert.throws(() => buildResponsesBody(custom, false, false), /ultra is not supported/iu);

  const openai = request("openai");
  openai.reasoningEffort = "max";
  openai.modelSettings = { reasoningEffortMap: { max: "provider-extra-high" } };
  assert.throws(() => buildResponsesBody(openai, false, false), /OpenAI reasoning effort/iu);
});

test("Responses endpoints request displayable reasoning summaries when reasoning is enabled", async (t) => {
  const completed = sse(
    { type: "response.created", response: { id: "reasoning-response", model: "reasoning-model" } },
    { type: "response.completed", response: { id: "reasoning-response", model: "reasoning-model" } },
  );
  const cases = [
    {
      name: "OpenAI",
      provider: "openai" as const,
      create(posted: (body: Record<string, unknown>) => void) {
        return new OpenAIResponsesAdapter({
          apiKey: "secret",
          fetch: fakeFetch(async (incoming) => {
            posted(await incoming.json() as Record<string, unknown>);
            return streamResponse(byteChunks(completed));
          }),
        });
      },
    },
    {
      name: "Azure OpenAI",
      provider: "azure-openai" as const,
      create(posted: (body: Record<string, unknown>) => void) {
        return new AzureOpenAIResponsesAdapter({
          endpoint: "https://example.openai.azure.com",
          apiKey: "secret",
          deploymentName: "reasoning-deployment",
          fetch: fakeFetch(async (incoming) => {
            posted(await incoming.json() as Record<string, unknown>);
            return streamResponse(byteChunks(completed));
          }),
        });
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      let posted: Record<string, unknown> | undefined;
      const adapter = entry.create((body) => {
        posted = body;
      });
      const providerRequest = request(entry.provider);
      providerRequest.model = "reasoning-model";
      providerRequest.reasoningEffort = "high";
      const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
      assert.equal(terminalCount(events), 1);
      assert.deepEqual(posted?.reasoning, { effort: "high", summary: "auto" });
    });
  }
});

test("OpenAI Responses reads the final outcome from response.done", async (t) => {
  const cases = [
    { name: "status omitted", status: undefined, terminal: "response_end", reason: "stop" },
    { name: "completed", status: "completed", terminal: "response_end", reason: "stop" },
    { name: "incomplete", status: "incomplete", terminal: "response_end", reason: "length" },
    { name: "failed", status: "failed", terminal: "error", reason: "provider" },
    { name: "cancelled", status: "cancelled", terminal: "error", reason: "cancelled" },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const response: Record<string, unknown> = {
        id: `response-${entry.name}`,
        ...(entry.status === undefined ? {} : { status: entry.status }),
        ...(entry.status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
        ...(entry.status === "failed" ? { error: { code: "generation_failed", message: "generation failed" } } : {}),
      };
      const adapter = new OpenAIResponsesAdapter({
        apiKey: "secret",
        fetch: fakeFetch(() => streamResponse(byteChunks(sse({ type: "response.done", response })))),
      });

      const events = await collect(adapter.stream(request("openai"), new AbortController().signal));
      const terminal = events.at(-1);
      assert.equal(terminal?.type, entry.terminal);
      if (terminal?.type === "response_end") assert.equal(terminal.reason, entry.reason);
      if (terminal?.type === "error") assert.equal(terminal.error.category, entry.reason);
    });
  }
});

test("OpenAI Responses cache opt-out keeps configured stateful transports local across turns", async () => {
  const posted: Record<string, unknown>[] = [];
  const adapter = new OpenAIResponsesAdapter({
    apiKey: "secret",
    baseUrl: "https://responses.example/v1",
    store: true,
    fetch: fakeFetch(async (incoming) => {
      posted.push(await incoming.json() as Record<string, unknown>);
      const turn = posted.length;
      const id = `response-none-${turn}`;
      const item = {
        id: `message-none-${turn}`,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `answer ${turn}` }],
      };
      return streamResponse(byteChunks(sse(
        { type: "response.created", response: { id, model: "gpt-test" } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id, model: "gpt-test", output: [item] } },
      )));
    }),
  });
  const first = request("openai");
  const firstEvents = await collect(adapter.stream(first, new AbortController().signal));
  const firstEnd = firstEvents.find((event) => event.type === "response_end");
  assert.ok(firstEnd?.type === "response_end");

  const second = request("openai");
  second.cacheRetention = "none";
  second.providerState = firstEnd.state;
  second.messages = [
    ...first.messages,
    {
      id: "assistant-none-1",
      role: "assistant",
      content: [{ type: "text", text: "answer 1" }],
      createdAt: "2026-07-09T00:00:01.000Z",
    },
    {
      id: "user-none-2",
      role: "user",
      content: [{ type: "text", text: "continue" }],
      createdAt: "2026-07-09T00:00:02.000Z",
    },
  ];
  const secondEvents = await collect(adapter.stream(second, new AbortController().signal));
  const secondEnd = secondEvents.find((event) => event.type === "response_end");
  assert.ok(secondEnd?.type === "response_end");

  assert.equal(posted.length, 2);
  assert.equal(posted[0]?.store, true);
  assert.equal(posted[1]?.store, false);
  assert.equal(posted[1]?.previous_response_id, undefined);
  assert.equal(
    Array.isArray(posted[1]?.include) && posted[1]?.include.includes("reasoning.encrypted_content"),
    true,
  );
  assert.equal(
    firstEnd.state.kind === "openai_responses" ? firstEnd.state.previousResponseId : undefined,
    "response-none-1",
  );
  assert.equal(secondEnd.state.kind === "openai_responses" ? secondEnd.state.previousResponseId : undefined, undefined);
  assert.deepEqual(posted[1]?.input, [
    { role: "user", content: "hello" },
    {
      id: "message-none-1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "answer 1" }],
    },
    { role: "user", content: "continue" },
  ]);
});

test("OpenAI Responses retains configured stateful continuation by default", async () => {
  const posted: Record<string, unknown>[] = [];
  const adapter = new OpenAIResponsesAdapter({
    apiKey: "secret",
    baseUrl: "https://responses.example/v1",
    store: true,
    fetch: fakeFetch(async (incoming) => {
      posted.push(await incoming.json() as Record<string, unknown>);
      const turn = posted.length;
      const id = `response-default-${turn}`;
      return streamResponse(byteChunks(sse(
        { type: "response.created", response: { id, model: "gpt-test" } },
        { type: "response.completed", response: { id, model: "gpt-test" } },
      )));
    }),
  });
  const first = request("openai");
  const firstEvents = await collect(adapter.stream(first, new AbortController().signal));
  const firstEnd = firstEvents.find((event) => event.type === "response_end");
  assert.ok(firstEnd?.type === "response_end");

  const second = request("openai");
  second.providerState = firstEnd.state;
  second.messages = [
    ...first.messages,
    {
      id: "assistant-default-1",
      role: "assistant",
      content: [{ type: "text", text: "answer 1" }],
      createdAt: "2026-07-09T00:00:01.000Z",
    },
    {
      id: "user-default-2",
      role: "user",
      content: [{ type: "text", text: "continue" }],
      createdAt: "2026-07-09T00:00:02.000Z",
    },
  ];
  const secondEvents = await collect(adapter.stream(second, new AbortController().signal));
  const secondEnd = secondEvents.find((event) => event.type === "response_end");
  assert.ok(secondEnd?.type === "response_end");

  assert.equal(posted[0]?.store, true);
  assert.equal(posted[1]?.store, true);
  assert.equal(posted[1]?.previous_response_id, "response-default-1");
  assert.deepEqual(posted[1]?.input, [{ role: "user", content: "continue" }]);
  assert.equal(
    secondEnd.state.kind === "openai_responses" ? secondEnd.state.previousResponseId : undefined,
    "response-default-2",
  );
});

test("OpenAI Responses keeps reasoning summaries from separate output items distinct", async () => {
  const body = sse(
    { type: "response.created", response: { id: "resp-reasoning", model: "gpt-test" } },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "reasoning-1",
      output_index: 0,
      summary_index: 0,
      delta: "Planning ",
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "reasoning-1",
      output_index: 0,
      summary_index: 0,
      delta: "the change",
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "reasoning-2",
      output_index: 1,
      summary_index: 0,
      delta: "Implementing the fix",
    },
    {
      type: "response.reasoning_summary_text.delta",
      output_index: 2,
      summary_index: 0,
      delta: "Reviewing the result",
    },
    { type: "response.completed", response: { id: "resp-reasoning", model: "gpt-test" } },
  );
  const adapter = new OpenAIResponsesAdapter({
    apiKey: "secret",
    baseUrl: "https://responses.example/v1",
    fetch: fakeFetch(() => streamResponse(byteChunks(body))),
  });

  const events = await collect(adapter.stream(request("openai"), new AbortController().signal));
  assert.deepEqual(
    events.flatMap((event) => event.type === "reasoning_delta" ? [[event.part, event.text]] : []),
    [[0, "Planning "], [0, "the change"], [1, "Implementing the fix"], [2, "Reviewing the result"]],
  );
});

test("Azure Responses uses the GA v1 path and api-key authentication", async () => {
  let url = "";
  let apiKey = "";
  let retryCount = "";
  const adapter = new AzureOpenAIResponsesAdapter({
    endpoint: "https://example.openai.azure.com",
    apiKey: "azure-secret",
    fetch: fakeFetch((incoming) => {
      url = incoming.url;
      apiKey = incoming.headers.get("api-key") ?? "";
      retryCount = incoming.headers.get("x-stainless-retry-count") ?? "";
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
  assert.equal(url, "https://example.openai.azure.com/openai/v1/responses?api-version=v1");
  assert.equal(apiKey, "azure-secret");
  assert.equal(retryCount, "0");
  assert.equal(terminalCount(events), 1);
});

test("Azure Responses normalizes supported endpoint forms", async (t) => {
  const cases = [
    [
      "Cognitive Services root",
      "https://one.cognitiveservices.azure.com/",
      "https://one.cognitiveservices.azure.com/openai/v1/responses?api-version=v1",
    ],
    [
      "Foundry openai path",
      "https://two.services.ai.azure.com/openai?api-version=old",
      "https://two.services.ai.azure.com/openai/v1/responses?api-version=v1",
    ],
    [
      "existing Responses path",
      "https://three.openai.azure.com/openai/v1/responses",
      "https://three.openai.azure.com/openai/v1/responses?api-version=v1",
    ],
  ] as const;

  for (const [name, endpoint, expected] of cases) {
    await t.test(name, async () => {
      let requested = "";
      const adapter = new AzureOpenAIResponsesAdapter({
        endpoint,
        apiKey: "azure-secret",
        fetch: fakeFetch((incoming) => {
          requested = incoming.url;
          return streamResponse(byteChunks(sse(
            { type: "response.created", response: { id: "r", model: "deployment" } },
            { type: "response.completed", response: { id: "r", model: "deployment" } },
          )));
        }),
      });
      const providerRequest = request("azure-openai");
      providerRequest.model = "deployment";
      const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
      assert.equal(terminalCount(events), 1);
      assert.equal(requested, expected);
    });
  }
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

test("Anthropic API bearer credentials preserve ordinary headers and tool names", async () => {
  let headers: Headers | undefined;
  let posted: Record<string, unknown> | undefined;
  const adapter = new AnthropicAdapter({
    accessToken: "console-bearer",
    fetch: fakeFetch(async (incoming) => {
      headers = incoming.headers;
      posted = await incoming.json() as Record<string, unknown>;
      return streamResponse(byteChunks(sse(
        { type: "message_start", message: { id: "msg-bearer", model: "claude-test", usage: { input_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "read", input: {} } },
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

  assert.equal(headers?.get("authorization"), "Bearer console-bearer");
  assert.equal(headers?.get("x-api-key"), null);
  assert.doesNotMatch(headers?.get("anthropic-beta") ?? "", /claude-code|oauth-/u);
  assert.equal(headers?.get("anthropic-dangerous-direct-browser-access"), null);
  assert.equal(headers?.get("x-app"), null);
  assert.equal(headers?.get("user-agent"), null);
  assert.equal(posted?.system, undefined);
  assert.deepEqual((posted?.tools as Array<{ name: string }>).map((tool) => tool.name), ["read", "custom_tool"]);
  const tool = events.find((event) => event.type === "tool_call_end");
  assert.equal(tool?.type === "tool_call_end" ? tool.name : undefined, "read");
  const end = events.at(-1);
  assert.deepEqual(
    end?.type === "response_end" && end.state.kind === "anthropic_messages" ? end.state.assistantBlocks[0] : undefined,
    { type: "tool_use", id: "tool-1", name: "read", input: { path: "README.md" } },
  );
});

test("approved Anthropic OAuth credentials use the provider compatibility contract", async () => {
  let headers: Headers | undefined;
  let posted: Record<string, unknown> | undefined;
  const adapter = new AnthropicAdapter({
    accessToken: "approved-oauth-token",
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

  assert.equal(headers?.get("authorization"), "Bearer approved-oauth-token");
  assert.equal(headers?.get("x-api-key"), null);
  assert.match(headers?.get("anthropic-beta") ?? "", /claude-code-20250219/u);
  assert.match(headers?.get("anthropic-beta") ?? "", /oauth-2025-04-20/u);
  assert.equal(headers?.get("anthropic-dangerous-direct-browser-access"), "true");
  assert.equal(headers?.get("x-app"), "cli");
  assert.equal(headers?.get("user-agent"), "rigyn/0.1.0");
  assert.deepEqual((posted?.tools as Array<{ name: string }>).map((tool) => tool.name), ["Read", "custom_tool"]);
  const tool = events.find((event) => event.type === "tool_call_end");
  assert.equal(tool?.type === "tool_call_end" ? tool.name : undefined, "read");
});

test("Anthropic repairs non-object tool inputs before canonical and provider-state replay", async () => {
  const terminal = sse(
    { type: "message_start", message: { id: "message-replay", model: "claude-test", usage: { input_tokens: 1 } } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  );
  const posted: Record<string, unknown>[] = [];
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    promptCache: "off",
    fetch: fakeFetch(async (incoming) => {
      posted.push(await incoming.json() as Record<string, unknown>);
      return streamResponse(byteChunks(terminal));
    }),
  });
  const canonical = request("anthropic");
  canonical.messages.push(
    {
      id: "assistant-invalid-canonical-tool",
      role: "assistant",
      content: [{
        type: "tool_call",
        callId: "canonical-call",
        name: "read",
        arguments: null,
        rawArguments: "null",
      }],
      createdAt: "2026-07-09T00:01:00.000Z",
    },
    {
      id: "canonical-tool-result",
      role: "tool",
      content: [{
        type: "tool_result",
        callId: "canonical-call",
        name: "read",
        content: "Tool input must be an object",
        isError: true,
      }],
      createdAt: "2026-07-09T00:02:00.000Z",
    },
    {
      id: "canonical-current-user",
      role: "user",
      content: [{ type: "text", text: "Try again." }],
      createdAt: "2026-07-09T00:03:00.000Z",
    },
  );
  await collect(adapter.stream(canonical, new AbortController().signal));

  const state = request("anthropic");
  state.providerState = {
    kind: "anthropic_messages",
    assistantBlocks: [{
      type: "tool_use",
      id: "state-call",
      name: "read",
      input: "[Circular]",
    }],
  };
  state.messages.push(
    {
      id: "assistant-invalid-state-tool",
      role: "assistant",
      content: [{ type: "tool_call", callId: "state-call", name: "read", arguments: null }],
      createdAt: "2026-07-09T00:01:00.000Z",
    },
    {
      id: "state-tool-result",
      role: "tool",
      content: [{
        type: "tool_result",
        callId: "state-call",
        name: "read",
        content: "Tool input must be an object",
        isError: true,
      }],
      createdAt: "2026-07-09T00:02:00.000Z",
    },
  );
  await collect(adapter.stream(state, new AbortController().signal));

  const canonicalMessages = posted[0]?.messages as Array<{ content: Array<{ type: string; input?: unknown }> }>;
  const stateMessages = posted[1]?.messages as Array<{ content: Array<{ type: string; input?: unknown }> }>;
  assert.deepEqual(canonicalMessages[1]?.content[0]?.input, {});
  assert.deepEqual(stateMessages[1]?.content[0]?.input, {});
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
    providerRequest.temperature = 0.7;
    await collect(adapter.stream(providerRequest, new AbortController().signal));
    return body!;
  };

  const sonnet5Off = await posted("claude-sonnet-5", "off");
  assert.deepEqual(sonnet5Off.thinking, { type: "disabled" });
  assert.equal(sonnet5Off.temperature, undefined);
  const opus5Off = await posted("claude-opus-5", "off");
  assert.deepEqual(opus5Off.thinking, { type: "disabled" });
  assert.equal(opus5Off.temperature, undefined);
  const opus5Max = await posted("claude-opus-5", "max");
  assert.deepEqual(opus5Max.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(opus5Max.output_config, { effort: "max" });
  const opusOff = await posted("claude-opus-4-8", "off");
  assert.equal(opusOff.thinking, undefined);
  assert.equal(opusOff.output_config, undefined);
  const fable = await posted("claude-fable-5", "high");
  assert.deepEqual(fable.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(fable.output_config, { effort: "high" });
  const opus = await posted("claude-opus-4-8", "xhigh");
  assert.deepEqual(opus.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(opus.output_config, { effort: "xhigh" });
  const legacy = await posted("claude-opus-4-5", "high");
  assert.deepEqual(legacy.thinking, { type: "enabled", budget_tokens: 7168, display: "summarized" });
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
  assert.deepEqual(posted?.thinking, { type: "enabled", budget_tokens: 4096, display: "summarized" });
  assert.equal(posted?.output_config, undefined);
  assert.match(headers?.get("anthropic-beta") ?? "", /interleaved-thinking-2025-05-14/u);
  assert.equal((posted?.tools as Array<{ name: string }>)[0]?.name, "read");

  assert.throws(
    () => new AnthropicAdapter({ apiKey: "secret", thinking: { budgets: { low: 1023 } } }),
    /budget low must be an integer from 1024/u,
  );
});

test("per-run thinking budgets override provider defaults and retain Anthropic minimums", async () => {
  let posted: Record<string, unknown> | undefined;
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    thinking: { budgets: { high: 4096 }, models: { "partner-model": { mode: "enabled" } } },
    fetch: fakeFetch(async (incoming) => {
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
  providerRequest.thinkingBudgets = { high: 2048 };
  await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.deepEqual(posted?.thinking, { type: "enabled", budget_tokens: 2048, display: "summarized" });

  providerRequest.thinkingBudgets = { high: 1 };
  await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.deepEqual(posted?.thinking, { type: "enabled", budget_tokens: 1024, display: "summarized" });
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
  assert.deepEqual(posted?.thinking, { type: "adaptive", display: "summarized" });
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

test("Anthropic applies catalog-level adaptive thinking and empty-signature compatibility", async () => {
  let body: Record<string, unknown> | undefined;
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    promptCache: "off",
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
  providerRequest.reasoningEffort = "max";
  providerRequest.modelSettings = {
    headers: { "x-session-affinity": "configured-session" },
    compatibility: {
      forceAdaptiveThinking: true,
      allowEmptySignature: true,
    },
  };
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

  assert.deepEqual(body?.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual((body?.messages as Array<{ content: unknown[] }>)[1]?.content, [
    { type: "thinking", thinking: "partial reasoning", signature: "" },
    { type: "tool_use", id: "tool-1", name: "read", input: {} },
  ]);
});

test("Anthropic consumes extension compatibility for eager streaming and deferred tool references", async () => {
  let body: Record<string, unknown> | undefined;
  let headers: Headers | undefined;
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    promptCache: "off",
    deferredToolLoading: true,
    fetch: fakeFetch(async (incoming) => {
      body = await incoming.json() as Record<string, unknown>;
      headers = incoming.headers;
      return streamResponse(byteChunks(sse(
        { type: "message_start", message: { id: "message", model: "partner-model", usage: { input_tokens: 1 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      )));
    }),
  });
  const providerRequest = request("anthropic");
  providerRequest.model = "partner-model";
  providerRequest.modelSettings = {
    compatibility: {
      supportsEagerToolInputStreaming: false,
      supportsToolReferences: true,
    },
  };
  providerRequest.tools = [
    { name: "discover", description: "Discover", inputSchema: { type: "object" } },
    { name: "deferred_tool", description: "Deferred", inputSchema: { type: "object" }, loading: "deferred" },
  ];
  providerRequest.messages.push(
    {
      id: "assistant-tool",
      role: "assistant",
      content: [{ type: "tool_call", callId: "tool-1", name: "discover", arguments: {} }],
      createdAt: "2026-07-21T00:01:00.000Z",
    },
    {
      id: "tool-result",
      role: "tool",
      content: [{
        type: "tool_result",
        callId: "tool-1",
        name: "discover",
        content: "loaded",
        isError: false,
        addedToolNames: ["deferred_tool"],
      }],
      createdAt: "2026-07-21T00:02:00.000Z",
    },
  );

  await collect(adapter.stream(providerRequest, new AbortController().signal));

  assert.match(headers?.get("anthropic-beta") ?? "", /fine-grained-tool-streaming/u);
  assert.deepEqual(body?.tools, [
    { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
    { name: "discover", description: "Discover", input_schema: { type: "object" } },
    {
      name: "deferred_tool",
      description: "Deferred",
      input_schema: { type: "object" },
      defer_loading: true,
    },
  ]);
  const messages = body?.messages as Array<{ role: string; content: unknown[] }>;
  assert.deepEqual(messages.at(-1)?.content, [
    {
      type: "tool_result",
      tool_use_id: "tool-1",
      content: [{ type: "tool_reference", tool_name: "deferred_tool" }],
      is_error: false,
    },
    { type: "text", text: "loaded" },
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
      { name: "read", description: "Read a file", input_schema: { type: "object" }, eager_input_streaming: true },
      {
        name: "edit",
        description: "Edit a file",
        input_schema: { type: "object" },
        eager_input_streaming: true,
        cache_control: cacheControl,
      },
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
    cacheWrite1hTokens: 11,
  });
  assert.deepEqual(usageEvents.at(-1)?.type === "usage" ? usageEvents.at(-1)?.usage : undefined, {
    raw: { output_tokens: 2 },
    inputTokens: 5,
    outputTokens: 2,
    cacheReadTokens: 30,
    cacheWriteTokens: 18,
    cacheWrite1hTokens: 11,
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
  assert.deepEqual(events.filter((event) => event.type === "reasoning_delta"), [
    { type: "reasoning_delta", part: 0, text: "thinking", visibility: "provider_trace" },
  ]);
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

test("Gemini 2.5 generateContent uses configured token thinking budgets", async () => {
  let posted: Record<string, unknown> | undefined;
  const adapter = new GeminiAdapter({
    apiKey: "secret",
    fetch: fakeFetch(async (incoming) => {
      posted = await incoming.json() as Record<string, unknown>;
      return streamResponse(byteChunks(sse({
        responseId: "gemini-budget",
        modelVersion: "gemini-2.5-pro",
        candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts: [{ text: "done" }] } }],
      })));
    }),
  });
  const providerRequest = request("gemini");
  providerRequest.model = "gemini-2.5-pro";
  providerRequest.temperature = 0.35;
  providerRequest.reasoningEffort = "high";
  providerRequest.thinkingBudgets = { high: 12_345 };
  await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.deepEqual(
    (posted?.generationConfig as { thinkingConfig?: unknown }).thinkingConfig,
    { thinkingBudget: 12_345, includeThoughts: true },
  );
  assert.equal((posted?.generationConfig as { temperature?: unknown }).temperature, 0.35);
});

test("Gemini generateContent maps thinking controls by model generation", async () => {
  const posted: Record<string, unknown>[] = [];
  const adapter = new GeminiAdapter({
    apiKey: "secret",
    fetch: fakeFetch(async (incoming) => {
      posted.push(await incoming.json() as Record<string, unknown>);
      return streamResponse(byteChunks(sse({
        responseId: `gemini-thinking-${posted.length}`,
        modelVersion: "gemini-test",
        candidates: [{ index: 0, finishReason: "STOP", content: { role: "model", parts: [{ text: "done" }] } }],
      })));
    }),
  });
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ["gemini-2.5-pro", "off", { thinkingBudget: 128 }],
    ["gemini-2.5-flash", "off", { thinkingBudget: 0 }],
    ["gemini-2.5-flash-lite", "minimal", { thinkingBudget: 512, includeThoughts: true }],
    ["gemini-2.5-flash", "max", { thinkingBudget: 24_576, includeThoughts: true }],
    ["gemini-2.5-pro", "xhigh", { thinkingBudget: 32_768, includeThoughts: true }],
    ["gemini-3.6-flash", "off", { thinkingLevel: "MINIMAL" }],
    ["gemini-3.6-flash", "max", { thinkingLevel: "HIGH", includeThoughts: true }],
  ];

  for (const [model, effort, expected] of cases) {
    const providerRequest = request("gemini");
    providerRequest.model = model;
    providerRequest.reasoningEffort = effort;
    assert.equal(terminalCount(await collect(adapter.stream(providerRequest, new AbortController().signal))), 1);
    const generationConfig = posted.at(-1)?.generationConfig as Record<string, unknown>;
    assert.deepEqual(generationConfig.thinkingConfig, expected);
  }
});

test("Gemini and Vertex request thought summaries and expose them as displayable reasoning", async (t) => {
  const chunk = {
    responseId: "thought-summary",
    modelVersion: "gemini-test",
    candidates: [{
      index: 0,
      finishReason: "STOP",
      content: {
        role: "model",
        parts: [{ text: "Inspect the change.", thought: true, thoughtSignature: "opaque-signature" }],
      },
    }],
  };
  const cases = [
    {
      name: "Gemini",
      provider: "gemini" as const,
      create: (fetch: typeof globalThis.fetch) => new GeminiAdapter({ apiKey: "secret", fetch }),
    },
    {
      name: "Vertex",
      provider: "vertex" as const,
      create: (fetch: typeof globalThis.fetch) => new VertexAdapter({
        project: "offline-project",
        accessToken: "secret",
        fetch,
      }),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      let posted: Record<string, unknown> | undefined;
      const adapter = entry.create(fakeFetch(async (incoming) => {
        posted = await incoming.json() as Record<string, unknown>;
        return streamResponse(byteChunks(sse(chunk)));
      }));
      const input = request(entry.provider);
      input.reasoningEffort = "high";

      const events = await collect(adapter.stream(input, new AbortController().signal));

      assert.deepEqual(
        (posted?.generationConfig as { thinkingConfig?: unknown }).thinkingConfig,
        { thinkingLevel: "HIGH", includeThoughts: true },
      );
      assert.deepEqual(events.filter((event) => event.type === "reasoning_delta"), [
        { type: "reasoning_delta", part: 0, text: "Inspect the change.", visibility: "summary" },
      ]);
      const terminal = events.at(-1);
      assert.equal(terminal?.type, "response_end");
      assert.deepEqual(
        terminal?.type === "response_end" && terminal.state.kind === "gemini_generate_content"
          ? terminal.state.parts[0]
          : undefined,
        { text: "Inspect the change.", thought: true, thoughtSignature: "opaque-signature" },
      );
    });
  }
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

test("OpenAI-compatible chat preserves DeepSeek native cache-hit telemetry", async () => {
  const nativeUsage = {
    prompt_tokens: 1_000,
    completion_tokens: 100,
    total_tokens: 1_100,
    prompt_cache_hit_tokens: 700,
    prompt_cache_miss_tokens: 300,
  };
  const body = sse({
    id: "deepseek-cache-usage",
    model: "deepseek-v4-pro",
    choices: [],
    usage: nativeUsage,
  }) + "data: [DONE]\n\n";
  const adapter = new OpenAICompatibleAdapter({
    id: "deepseek",
    baseUrl: "https://api.deepseek.com",
    fetch: fakeFetch(() => streamResponse(byteChunks(body))),
  });

  const events = await collect(adapter.stream(request("deepseek"), new AbortController().signal));
  const usage = events.find((event) => event.type === "usage");
  assert.deepEqual(usage?.type === "usage" ? usage.usage : undefined, {
    raw: nativeUsage,
    inputTokens: 300,
    outputTokens: 100,
    cacheReadTokens: 700,
    totalTokens: 1_100,
  });
});

test("OpenAI-compatible chat propagates per-call tool choice and strict tool compatibility", async () => {
  const posted: Record<string, unknown>[] = [];
  const response = sse({
    id: "chat-options",
    model: "test-model",
    choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
  }) + "data: [DONE]\n\n";
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(async (incoming) => {
      posted.push(await incoming.json() as Record<string, unknown>);
      return streamResponse(byteChunks(response));
    }),
  });
  const providerRequest = request("openai-compatible");
  providerRequest.temperature = 0.45;
  providerRequest.toolChoice = { type: "function", function: { name: "read" } };
  providerRequest.tools = [{
    name: "read",
    description: "Read a file",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }];
  await collect(adapter.stream(providerRequest, new AbortController().signal));

  const disabled = request("openai-compatible");
  disabled.tools = providerRequest.tools;
  disabled.modelSettings = { compatibility: { supportsStrictMode: false } };
  await collect(adapter.stream(disabled, new AbortController().signal));

  assert.deepEqual(posted[0]?.tool_choice, { type: "function", function: { name: "read" } });
  assert.equal(posted[0]?.temperature, 0.45);
  const defaultFunction = ((posted[0]?.tools as Array<Record<string, unknown>>)[0]?.function) as
    | Record<string, unknown>
    | undefined;
  assert.equal(defaultFunction?.strict, false);
  const disabledFunction = ((posted[1]?.tools as Array<Record<string, unknown>>)[0]?.function) as
    | Record<string, unknown>
    | undefined;
  assert.equal(Object.hasOwn(disabledFunction ?? {}, "strict"), false);
});

test("OpenAI-compatible chat streams textual reasoning for display", async () => {
  const response = sse({
    id: "chat-reasoning-text",
    model: "test-model",
    choices: [{
      index: 0,
      delta: { reasoning_text: "visible reasoning", content: "done" },
      finish_reason: "stop",
    }],
  }) + "data: [DONE]\n\n";
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => streamResponse(byteChunks(response))),
  });

  const events = await collect(adapter.stream(request("openai-compatible"), new AbortController().signal));
  assert.deepEqual(
    events.filter((event) => event.type === "reasoning_delta"),
    [{ type: "reasoning_delta", part: 0, text: "visible reasoning", visibility: "summary" }],
  );
});

test("OpenAI-compatible chat keeps summary details separate from private reasoning", async () => {
  const response = sse(
    {
      id: "chat-mixed-reasoning",
      model: "test-model",
      choices: [{
        index: 0,
        delta: {
          reasoning: "visible one ",
          reasoning_details: [
            { type: "reasoning.summary", index: 0, summary: "Safe one. " },
            { type: "reasoning.encrypted", index: 1, text: "opaque one" },
          ],
        },
        finish_reason: null,
      }],
    },
    {
      id: "chat-mixed-reasoning",
      model: "test-model",
      choices: [{
        index: 0,
        delta: {
          reasoning: "visible two",
          reasoning_details: [
            { type: "reasoning.summary", index: 0, summary: "Safe two." },
            { type: "reasoning.encrypted", index: 1, text: "opaque two" },
          ],
          content: "done",
        },
        finish_reason: "stop",
      }],
    },
  ) + "data: [DONE]\n\n";
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => streamResponse(byteChunks(response))),
  });

  const events = await collect(adapter.stream(request("openai-compatible"), new AbortController().signal));
  assert.deepEqual(events.flatMap((event) => event.type === "reasoning_delta"
    ? [[event.part, event.text, event.visibility]]
    : []), [
    [0, "visible one ", "summary"],
    [1, "Safe one. ", "summary"],
    [2, "opaque one", "provider_trace"],
    [0, "visible two", "summary"],
    [1, "Safe two.", "summary"],
    [2, "opaque two", "provider_trace"],
  ]);
});

test("OpenAI-compatible chat exposes only known public reasoning detail types", async () => {
  const response = sse({
    id: "chat-reasoning-visibility",
    model: "test-model",
    choices: [{
      index: 0,
      delta: {
        reasoning_details: [
          { type: "reasoning.text", index: 0, text: "public text" },
          { type: "reasoning.summary", index: 1, summary: "public summary" },
          { type: "reasoning.encrypted", index: 2, text: "encrypted" },
          { type: "reasoning.signature", index: 3, summary: "signature" },
          { type: "reasoning.redacted", index: 4, text: "redacted" },
          { type: "reasoning.opaque", index: 5, summary: "opaque" },
          { type: "vendor.reasoning", index: 6, text: "unknown" },
          { index: 7, summary: "untyped" },
          { type: "reasoning.text", index: 8, text: "flagged", redacted: true },
        ],
        content: "done",
      },
      finish_reason: "stop",
    }],
  }) + "data: [DONE]\n\n";
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => streamResponse(byteChunks(response))),
  });

  const events = await collect(adapter.stream(request("openai-compatible"), new AbortController().signal));
  assert.deepEqual(events.flatMap((event) => event.type === "reasoning_delta"
    ? [[event.text, event.visibility]]
    : []), [
    ["public text", "summary"],
    ["public summary", "summary"],
    ["encrypted", "provider_trace"],
    ["signature", "provider_trace"],
    ["redacted", "provider_trace"],
    ["opaque", "provider_trace"],
    ["unknown", "provider_trace"],
    ["untyped", "provider_trace"],
    ["flagged", "provider_trace"],
  ]);
});

test("OpenAI-compatible chat replays exact textual reasoning across a tool continuation", async () => {
  const posted: Array<Record<string, unknown>> = [];
  const responses = [
    sse({
      id: "deepseek-tool-turn",
      model: "deepseek-v4-pro",
      choices: [{
        index: 0,
        delta: {
          reasoning_content: "Inspect the requested file exactly.",
          tool_calls: [{
            index: 0,
            id: "call-read",
            function: { name: "read", arguments: '{"path":"README.md"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }) + "data: [DONE]\n\n",
    sse({
      id: "deepseek-answer-turn",
      model: "deepseek-v4-pro",
      choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
    }) + "data: [DONE]\n\n",
  ];
  const adapter = new OpenAICompatibleAdapter({
    id: "deepseek",
    baseUrl: "https://api.deepseek.example/v1",
    fetch: fakeFetch(async (incoming) => {
      posted.push(await incoming.json() as Record<string, unknown>);
      return streamResponse(byteChunks(responses[posted.length - 1]!));
    }),
  });
  const compatibility = { requiresReasoningContentOnAssistantMessages: true };
  const first = request("deepseek");
  first.model = "deepseek-v4-pro";
  first.modelSettings = { compatibility };
  first.tools = [{
    name: "read",
    description: "Read a file",
    inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
  }];

  const firstEvents = await collect(adapter.stream(first, new AbortController().signal));
  const terminal = firstEvents.at(-1);
  assert.equal(terminal?.type, "response_end");
  if (terminal?.type !== "response_end") return;
  assert.equal(terminal.state.kind, "chat_completions");
  if (terminal.state.kind !== "chat_completions") return;
  assert.equal((terminal.state.assistantMessage as Record<string, unknown>).reasoning, "Inspect the requested file exactly.");

  const second = request("deepseek");
  second.model = "deepseek-v4-pro";
  second.modelSettings = { compatibility };
  second.tools = first.tools;
  second.providerState = terminal.state;
  second.messages = [
    first.messages[0]!,
    {
      id: "assistant-tool",
      role: "assistant",
      content: [{ type: "tool_call", callId: "call-read", name: "read", arguments: { path: "README.md" } }],
      createdAt: "2026-08-01T00:00:01.000Z",
    },
    {
      id: "tool-result",
      role: "tool",
      content: [{
        type: "tool_result",
        callId: "call-read",
        name: "read",
        content: "contents",
        isError: false,
      }],
      createdAt: "2026-08-01T00:00:02.000Z",
    },
  ];

  assert.equal(terminalCount(await collect(adapter.stream(second, new AbortController().signal))), 1);
  const messages = posted[1]?.messages as Array<Record<string, unknown>>;
  assert.equal(messages[1]?.reasoning_content, "Inspect the requested file exactly.");
  assert.equal(messages[1]?.reasoning, undefined);
  assert.equal(messages[1]?.reasoning_text, undefined);
  assert.deepEqual(messages[1]?.tool_calls, [{
    id: "call-read",
    type: "function",
    function: { name: "read", arguments: '{"path":"README.md"}' },
  }]);
});

test("provider-native Chat output caps use their documented field", async (t) => {
  const response = sse({
    id: "field-response",
    model: "field-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  }) + "data: [DONE]\n\n";
  const cases = [
    { provider: "xai", baseUrl: "https://api.x.ai/v1", profile: "default", field: "max_tokens" },
    {
      provider: "github-copilot",
      baseUrl: "https://api.individual.githubcopilot.com",
      profile: "default",
      field: "max_tokens",
    },
    { provider: "opencode", baseUrl: "https://opencode.ai/zen/v1", profile: "opencode", field: "max_tokens" },
    { provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", profile: "opencode", field: "max_tokens" },
    {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      profile: "default",
      field: "max_completion_tokens",
    },
  ] as const;
  for (const entry of cases) await t.test(entry.provider, async () => {
    let posted: Record<string, unknown> | undefined;
    const adapter = new OpenAICompatibleAdapter({
      id: entry.provider,
      baseUrl: entry.baseUrl,
      profile: entry.profile,
      fetch: fakeFetch(async (incoming) => {
        posted = await incoming.json() as Record<string, unknown>;
        return streamResponse(byteChunks(response));
      }),
    });
    const providerRequest = request(entry.provider);
    providerRequest.maxOutputTokens = 2_048;
    assert.equal(terminalCount(await collect(adapter.stream(providerRequest, new AbortController().signal))), 1);
    assert.equal(posted?.[entry.field], 2_048);
    assert.equal(posted?.[entry.field === "max_tokens" ? "max_completion_tokens" : "max_tokens"], undefined);
  });
});

test("OpenCode Zen Kimi routes send only published reasoning controls", async (t) => {
  const response = sse({
    id: "kimi-response",
    model: "kimi-model",
    choices: [{
      index: 0,
      delta: { reasoning_content: "checked", content: "done" },
      finish_reason: "stop",
    }],
  }) + "data: [DONE]\n\n";
  const cases = [
    {
      model: "kimi-k2.6",
      profile: "moonshot" as const,
      expectedThinking: { type: "enabled" },
      reasoningKey: "reasoning_content",
    },
    {
      model: "kimi-k2.7-code",
      profile: "opencode" as const,
      expectedThinking: undefined,
      reasoningKey: "reasoning",
    },
  ];
  for (const entry of cases) await t.test(entry.model, async () => {
    let posted: Record<string, unknown> | undefined;
    const adapter = new OpenAICompatibleAdapter({
      id: `opencode-${entry.profile}`,
      baseUrl: "https://opencode.ai/zen/v1",
      profile: entry.profile,
      fetch: fakeFetch(async (incoming) => {
        posted = await incoming.json() as Record<string, unknown>;
        return streamResponse(byteChunks(response));
      }),
    });
    const providerRequest = request("opencode");
    providerRequest.model = entry.model;
    providerRequest.reasoningEffort = "medium";
    providerRequest.modelSettings = {
      compatibility: {
        supportsReasoningEffort: false,
        requiresReasoningContentOnAssistantMessages: true,
      },
    };
    const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
    assert.equal(terminalCount(events), 1);
    assert.deepEqual(posted?.thinking, entry.expectedThinking);
    assert.equal(posted?.reasoning_effort, undefined);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "response_end");
    if (terminal?.type !== "response_end" || terminal.state.kind !== "chat_completions") return;
    assert.equal(
      (terminal.state.assistantMessage as Record<string, unknown>)[entry.reasoningKey],
      "checked",
    );
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
  const response = sse({
    id: "finish-model_context_window_exceeded",
    model: "profile-model",
    choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "model_context_window_exceeded" }],
  }) + "data: [DONE]\n\n";
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => streamResponse(byteChunks(response))),
  });
  const events = await collect(adapter.stream(request("openai-compatible"), new AbortController().signal));
  const end = events.at(-1);
  assert.equal(end?.type, "response_end");
  if (end?.type === "response_end") assert.equal(end.reason, "length");
});

test("content-filter, network, and unknown chat finishes terminate as provider errors", async () => {
  for (const rawReason of ["content_filter", "sensitive", "network_error", "unrecognized_finish"]) {
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
    const error = events.at(-1);
    assert.equal(error?.type, "error", rawReason);
    if (error?.type === "error") {
      assert.equal(error.error.message, `Provider finish_reason: ${rawReason}`);
      assert.equal(error.error.providerCode, rawReason);
      assert.equal(error.error.partial, true);
    }
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

test("OpenRouter cache opt-out removes body caching and session affinity", async () => {
  let posted: Record<string, unknown> | undefined;
  let postedHeaders: Headers | undefined;
  const adapter = new OpenRouterAdapter({
    apiKey: "secret",
    promptCache: "1h",
    fetch: fakeFetch(async (incoming) => {
      postedHeaders = incoming.headers;
      posted = await incoming.json() as Record<string, unknown>;
      return streamResponse(byteChunks(
        sse({
          id: "generation-none",
          model: "openai/test",
          choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
        }) + "data: [DONE]\n\n",
      ));
    }),
  });
  const providerRequest = request("openrouter");
  providerRequest.sessionId = "summary-session";
  providerRequest.cacheRetention = "none";
  providerRequest.modelSettings = {
    compatibility: {
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openrouter",
    },
  };

  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));

  assert.equal(terminalCount(events), 1);
  assert.equal(posted?.session_id, undefined);
  assert.equal(posted?.cache_control, undefined);
  assert.equal(postedHeaders?.get("x-session-id"), null);
  assert.equal(postedHeaders?.get("x-session-affinity"), null);
});

test("Ollama maps request options, NDJSON thinking/text/usage, and rejects truncated streams", async () => {
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
  let posted: Record<string, unknown> | undefined;
  const adapter = new OllamaAdapter({
    fetch: fakeFetch(async (incoming) => {
      posted = await incoming.json() as Record<string, unknown>;
      return streamResponse(byteChunks(complete), { "content-type": "application/x-ndjson" });
    }),
  });
  const providerRequest = request("ollama");
  providerRequest.maxOutputTokens = 256;
  providerRequest.temperature = 0.55;
  providerRequest.reasoningEffort = "high";
  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  assert.deepEqual(posted?.options, { num_predict: 256, temperature: 0.55 });
  assert.equal(posted?.think, "high");
  assert.deepEqual(events.filter((event) => event.type === "reasoning_delta"), [
    { type: "reasoning_delta", part: 0, text: "think", visibility: "summary" },
  ]);
  const terminal = events.at(-1);
  assert.equal(terminal?.type === "response_end" ? terminal.reason : undefined, "stop");
  assert.deepEqual(
    terminal?.type === "response_end" && terminal.state.kind === "ollama_chat"
      ? terminal.state.assistantMessage
      : undefined,
    { role: "assistant", content: "done", thinking: "think" },
  );

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

test("Ollama maps canonical thinking levels to its documented request values", async () => {
  const posted: Record<string, unknown>[] = [];
  const adapter = new OllamaAdapter({
    fetch: fakeFetch(async (incoming) => {
      posted.push(await incoming.json() as Record<string, unknown>);
      return streamResponse(byteChunks(JSON.stringify({
        model: "local",
        message: { role: "assistant", content: "done" },
        done: true,
        done_reason: "stop",
      })), { "content-type": "application/x-ndjson" });
    }),
  });
  const cases: Array<[string | undefined, boolean | "low" | "medium" | "high" | undefined]> = [
    [undefined, undefined],
    ["off", false],
    ["none", false],
    ["minimal", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "high"],
    ["max", "high"],
    ["unsupported", undefined],
  ];

  for (const [effort, expected] of cases) {
    const providerRequest = request("ollama");
    if (effort !== undefined) providerRequest.reasoningEffort = effort;
    const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
    assert.equal(terminalCount(events), 1);
    const body = posted.at(-1);
    if (expected === undefined) assert.equal(Object.hasOwn(body ?? {}, "think"), false);
    else assert.equal(body?.think, expected);
  }
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
        : { models: [{ name: "models/second", input_token_limit: 2000 }] }), {
        headers: { "content-type": "application/json" },
      });
    }),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.deepEqual(models.map((model) => [model.id, model.contextTokens, model.maxInputTokens]), [
    ["first", 1000, 1000],
    ["second", 2000, 2000],
  ]);
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
  assert.deepEqual(models.map((model) => [model.id, model.contextTokens, model.maxInputTokens]), [
    ["claude-first", 200_000, 200_000],
    ["claude-second", 100_000, 100_000],
  ]);
  assert.equal(models[0]?.capabilities.reasoning.value, "supported");
  assert.equal(models[0]?.capabilities.images.value, "supported");
  assert.equal(models[0]?.compatibility?.cacheMode?.value, "explicit");
  assert.deepEqual(models[0]?.compatibility?.cacheTiers?.value, ["5m"]);
  assert.deepEqual(cursors, [null, "claude-first"]);
});
