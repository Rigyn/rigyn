import assert from "node:assert/strict";
import test from "node:test";

import { OpenAICompatibleAdapter } from "../../src/providers/openai-compatible.js";
import { buildResponsesBody } from "../../src/providers/openai-responses.js";
import type { ConfiguredModel } from "../../src/providers/registry.js";
import {
  modelReasoningEfforts,
  parseConfiguredModels,
  ProviderRegistry,
} from "../../src/providers/registry.js";
import { byteChunks, collect, fakeFetch, request, streamResponse } from "./helpers.js";

function completedResponse(): Response {
  const body = `data: ${JSON.stringify({
    id: "response-1",
    model: "configured-model",
    choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
  })}\n\ndata: [DONE]\n\n`;
  return streamResponse(byteChunks(body));
}

test("configured model compatibility reaches the exact Chat Completions request", async () => {
  let posted: Record<string, unknown> | undefined;
  let postedHeaders: Headers | undefined;
  const adapter = new OpenAICompatibleAdapter({
    id: "company",
    baseUrl: "https://models.example/v1",
    fetch: fakeFetch(async (incoming) => {
      postedHeaders = incoming.headers;
      posted = await incoming.json() as Record<string, unknown>;
      return completedResponse();
    }),
  });
  const registry = new ProviderRegistry([adapter]);
  registry.configureModels([{
    provider: "company",
    id: "configured-model",
    reasoning: true,
    headers: { "x-tenant": "engineering" },
    reasoningEffortMap: { minimal: null, high: "intense" },
    requestCompatibility: {
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
      reasoningFormat: "chat-template",
      chatTemplateParameters: {
        enable_reasoning: { $var: "thinking.enabled" },
        reasoning_level: { $var: "thinking.effort" },
        nested: { selected: { $var: "thinking.effort" } },
      },
      cacheControlFormat: "anthropic",
      cacheControlTtl: "1h",
      supportsLongCacheRetention: false,
      supportsPromptCaching: true,
      supportsCacheControlOnTools: false,
      supportsTemperature: false,
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openai-nosession",
      openRouterRouting: {
        only: ["first-party"],
        allow_fallbacks: false,
        data_collection: "deny",
      },
    },
  }]);
  const providerRequest = request("company");
  providerRequest.model = "configured-model";
  providerRequest.reasoningEffort = "high";
  providerRequest.maxOutputTokens = 4_096;
  providerRequest.sessionId = "thread-123";
  providerRequest.messages.unshift({
    id: "system-1",
    role: "system",
    content: [{ type: "text", text: "stable instructions" }],
    createdAt: "2026-07-19T00:00:00.000Z",
  });
  providerRequest.tools = [
    { name: "read", description: "Read", inputSchema: { type: "object" } },
    { name: "write", description: "Write", inputSchema: { type: "object" } },
  ];

  await collect(registry.runtimeAdapter("company").stream(providerRequest, new AbortController().signal));

  assert.equal(postedHeaders?.get("x-tenant"), "engineering");
  assert.equal(postedHeaders?.get("x-client-request-id"), "thread-123");
  assert.equal(postedHeaders?.get("x-session-affinity"), "thread-123");
  assert.equal(postedHeaders?.get("session_id"), null);
  assert.equal(posted?.stream_options, undefined);
  assert.equal(posted?.max_tokens, 4_096);
  assert.equal(posted?.max_completion_tokens, undefined);
  assert.deepEqual(posted?.chat_template_kwargs, {
    enable_reasoning: true,
    reasoning_level: "intense",
    nested: { selected: "intense" },
  });
  assert.deepEqual(posted?.provider, {
    only: ["first-party"],
    allow_fallbacks: false,
    data_collection: "deny",
  });

  const messages = posted?.messages as Array<Record<string, unknown>>;
  const systemContent = messages[0]?.content as Array<Record<string, unknown>>;
  const userContent = messages[1]?.content as Array<Record<string, unknown>>;
  assert.deepEqual(systemContent.at(-1)?.cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(userContent.at(-1)?.cache_control, { type: "ephemeral", ttl: "1h" });
  const tools = posted?.tools as Array<Record<string, unknown>>;
  assert.equal(Object.hasOwn(tools[0]?.function as object, "strict"), false);
  assert.equal(Object.hasOwn(tools[1]?.function as object, "strict"), false);
  assert.equal(tools[0]?.cache_control, undefined);
  assert.deepEqual(tools[1]?.cache_control, { type: "ephemeral", ttl: "1h" });

  const models = await registry.listModels("company", new AbortController().signal);
  assert.deepEqual(modelReasoningEfforts(models[0]!), ["off", "low", "medium", "high", "xhigh", "max"]);
});

test("Chat Completions consumes structural compatibility controls without model-name inference", async () => {
  let posted: Record<string, unknown> | undefined;
  const adapter = new OpenAICompatibleAdapter({
    id: "extension-chat",
    baseUrl: "https://models.example/v1",
    fetch: fakeFetch(async (incoming) => {
      posted = await incoming.json() as Record<string, unknown>;
      return completedResponse();
    }),
  });
  const providerRequest = request("extension-chat");
  providerRequest.model = "plain-model";
  providerRequest.messages = [
    {
      id: "system",
      role: "system",
      content: [{ type: "text", text: "stable instructions" }],
      createdAt: "2026-07-21T00:00:00.000Z",
    },
    {
      id: "assistant",
      role: "assistant",
      content: [{ type: "tool_call", callId: "call-1", name: "discover", arguments: {} }],
      createdAt: "2026-07-21T00:00:01.000Z",
    },
    {
      id: "result",
      role: "tool",
      content: [{
        type: "tool_result",
        callId: "call-1",
        name: "discover",
        content: "loaded",
        isError: false,
        addedToolNames: ["deferred_tool"],
      }],
      createdAt: "2026-07-21T00:00:02.000Z",
    },
    {
      id: "user",
      role: "user",
      content: [{ type: "text", text: "continue" }],
      createdAt: "2026-07-21T00:00:03.000Z",
    },
  ];
  providerRequest.tools = [
    { name: "discover", description: "Discover", inputSchema: { type: "object" } },
    { name: "deferred_tool", description: "Deferred", inputSchema: { type: "object" }, loading: "deferred" },
  ];
  providerRequest.modelSettings = {
    compatibility: {
      supportsStore: true,
      supportsDeveloperRole: true,
      requiresToolResultName: true,
      requiresAssistantAfterToolResult: true,
      requiresReasoningContentOnAssistantMessages: true,
      zaiToolStream: true,
      deferredToolsMode: "kimi",
    },
  };

  await collect(adapter.stream(providerRequest, new AbortController().signal));

  assert.equal(posted?.store, false);
  assert.equal(posted?.tool_stream, true);
  assert.deepEqual((posted?.tools as Array<Record<string, unknown>>).map((entry) =>
    (entry.function as Record<string, unknown>).name), ["discover"]);
  const messages = posted?.messages as Array<Record<string, unknown>>;
  assert.equal(messages[0]?.role, "developer");
  assert.equal(messages[1]?.reasoning_content, "");
  assert.equal(messages[2]?.name, "discover");
  assert.deepEqual(messages[3], {
    role: "system",
    tools: [{
      type: "function",
      function: {
        name: "deferred_tool",
        description: "Deferred",
        parameters: { type: "object" },
        strict: false,
      },
    }],
  });
  assert.deepEqual(messages[4], { role: "assistant", content: "I have processed the tool results." });
  assert.equal(messages[5]?.role, "user");
});

test("Chat Completions can replay provider reasoning as ordinary assistant text", async () => {
  let posted: Record<string, unknown> | undefined;
  const adapter = new OpenAICompatibleAdapter({
    id: "extension-chat",
    baseUrl: "https://models.example/v1",
    fetch: fakeFetch(async (incoming) => {
      posted = await incoming.json() as Record<string, unknown>;
      return completedResponse();
    }),
  });
  const providerRequest = request("extension-chat");
  providerRequest.model = "plain-model";
  providerRequest.messages.push({
    id: "assistant",
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    createdAt: "2026-07-21T00:00:01.000Z",
  });
  providerRequest.providerState = {
    kind: "chat_completions",
    assistantMessage: { role: "assistant", content: "answer", reasoning_content: "private trace" },
  };
  providerRequest.modelSettings = { compatibility: { requiresThinkingAsText: true } };

  await collect(adapter.stream(providerRequest, new AbortController().signal));

  const messages = posted?.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages.at(-1), {
    role: "assistant",
    content: [
      { type: "text", text: "private trace" },
      { type: "text", text: "answer" },
    ],
  });
});

test("Responses consumes explicit developer-role and hosted tool-search compatibility", () => {
  const providerRequest = request("extension-responses");
  providerRequest.model = "plain-model";
  providerRequest.messages.unshift({
    id: "system",
    role: "system",
    content: [{ type: "text", text: "stable instructions" }],
    createdAt: "2026-07-21T00:00:00.000Z",
  });
  providerRequest.tools = [
    { name: "read", description: "Read", inputSchema: { type: "object" } },
    { name: "search", description: "Search", inputSchema: { type: "object" }, loading: "deferred" },
  ];
  providerRequest.modelSettings = {
    compatibility: {
      supportsDeveloperRole: true,
      supportsToolSearch: true,
    },
  };

  const body = buildResponsesBody(providerRequest, false, false);

  assert.equal((body.input as Array<Record<string, unknown>>)[0]?.role, "developer");
  assert.deepEqual(body.tools, [
    {
      type: "function",
      name: "read",
      description: "Read",
      parameters: { type: "object" },
      strict: false,
    },
    {
      type: "function",
      name: "search",
      description: "Search",
      parameters: { type: "object" },
      strict: false,
      defer_loading: true,
    },
    { type: "tool_search" },
  ]);
});

test("configured routing and reasoning formats remain model-specific", async () => {
  const bodies: Record<string, unknown>[] = [];
  const headers: Headers[] = [];
  const adapter = new OpenAICompatibleAdapter({
    id: "company",
    baseUrl: "https://models.example/v1",
    fetch: fakeFetch(async (incoming) => {
      headers.push(incoming.headers);
      bodies.push(await incoming.json() as Record<string, unknown>);
      return completedResponse();
    }),
  });
  const registry = new ProviderRegistry([adapter], {
    configuredModels: [
      {
        provider: "company",
        id: "openrouter-model",
        reasoning: true,
        reasoningEffortMap: { off: "none", high: "maximum" },
        requestCompatibility: {
          reasoningFormat: "openrouter",
          sessionAffinityFormat: "openrouter",
          sendSessionAffinityHeaders: true,
        },
      },
      {
        provider: "company",
        id: "vercel-model",
        requestCompatibility: {
          vercelGatewayRouting: { only: ["bedrock"], order: ["bedrock", "anthropic"] },
        },
      },
      {
        provider: "company",
        id: "default-model",
        reasoning: true,
        reasoningEffortMap: { high: "provider-high" },
      },
    ],
  });

  const first = request("company");
  first.model = "openrouter-model";
  first.reasoningEffort = "high";
  first.sessionId = "session-1";
  await collect(registry.runtimeAdapter("company").stream(first, new AbortController().signal));
  assert.deepEqual(bodies[0]?.reasoning, { effort: "maximum" });
  assert.equal(headers[0]?.get("x-session-id"), "session-1");
  assert.equal(headers[0]?.get("x-session-affinity"), null);

  const second = request("company");
  second.model = "vercel-model";
  await collect(registry.runtimeAdapter("company").stream(second, new AbortController().signal));
  assert.deepEqual(bodies[1]?.providerOptions, {
    gateway: { only: ["bedrock"], order: ["bedrock", "anthropic"] },
  });
  assert.equal(bodies[1]?.reasoning, undefined);

  const third = request("company");
  third.model = "default-model";
  third.reasoningEffort = "high";
  await collect(registry.runtimeAdapter("company").stream(third, new AbortController().signal));
  assert.equal(bodies[2]?.reasoning_effort, "provider-high");
});

test("explicit reasoning formats serialize without model-name inference", async () => {
  const bodies: Record<string, unknown>[] = [];
  const adapter = new OpenAICompatibleAdapter({
    id: "company",
    baseUrl: "https://models.example/v1",
    fetch: fakeFetch(async (incoming) => {
      bodies.push(await incoming.json() as Record<string, unknown>);
      return completedResponse();
    }),
  });
  const formats: Array<{
    id: string;
    model: ConfiguredModel;
    expected: Record<string, unknown>;
  }> = [
    {
      id: "openai",
      model: {
        provider: "company", id: "openai", reasoning: true, reasoningEffortMap: { high: "mapped" },
        requestCompatibility: { reasoningFormat: "openai" },
      },
      expected: { reasoning_effort: "mapped" },
    },
    {
      id: "deepseek",
      model: {
        provider: "company", id: "deepseek", reasoning: true, reasoningEffortMap: { high: "mapped" },
        requestCompatibility: { reasoningFormat: "deepseek", supportsReasoningEffort: true },
      },
      expected: { thinking: { type: "enabled" }, reasoning_effort: "mapped" },
    },
    {
      id: "together",
      model: {
        provider: "company", id: "together", reasoning: true, reasoningEffortMap: { high: "mapped" },
        requestCompatibility: { reasoningFormat: "together", supportsReasoningEffort: true },
      },
      expected: { reasoning: { enabled: true }, reasoning_effort: "mapped" },
    },
    {
      id: "zai",
      model: {
        provider: "company", id: "zai", reasoning: true, reasoningEffortMap: { high: "mapped" },
        requestCompatibility: { reasoningFormat: "zai", supportsReasoningEffort: true },
      },
      expected: { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "mapped" },
    },
    {
      id: "qwen",
      model: {
        provider: "company", id: "qwen", reasoning: true,
        requestCompatibility: { reasoningFormat: "qwen" },
      },
      expected: { enable_thinking: true },
    },
    {
      id: "qwen-chat-template",
      model: {
        provider: "company", id: "qwen-chat-template", reasoning: true,
        requestCompatibility: { reasoningFormat: "qwen-chat-template" },
      },
      expected: { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } },
    },
    {
      id: "string-thinking",
      model: {
        provider: "company", id: "string-thinking", reasoning: true, reasoningEffortMap: { high: "mapped" },
        requestCompatibility: { reasoningFormat: "string-thinking" },
      },
      expected: { thinking: "mapped" },
    },
    {
      id: "ant-ling",
      model: {
        provider: "company", id: "ant-ling", reasoning: true, reasoningEffortMap: { high: "mapped" },
        requestCompatibility: { reasoningFormat: "ant-ling" },
      },
      expected: { reasoning: { effort: "mapped" } },
    },
  ];
  const registry = new ProviderRegistry([adapter], { configuredModels: formats.map((entry) => entry.model) });

  for (const [index, entry] of formats.entries()) {
    const providerRequest = request("company");
    providerRequest.model = entry.id;
    providerRequest.reasoningEffort = "high";
    await collect(registry.runtimeAdapter("company").stream(providerRequest, new AbortController().signal));
    for (const [field, value] of Object.entries(entry.expected)) {
      assert.deepEqual(bodies[index]?.[field], value, `${entry.id}.${field}`);
    }
  }
});

test("configured model compatibility rejects secrets and contradictory metadata", () => {
  const [configured] = parseConfiguredModels([{
    provider: "company",
    id: "structural-model",
    reasoning: true,
    requestCompatibility: {
      forceAdaptiveThinking: true,
      allowEmptySignature: true,
      supportsEagerToolInputStreaming: false,
      supportsToolReferences: true,
      supportsStore: true,
      supportsDeveloperRole: true,
      requiresToolResultName: true,
      requiresAssistantAfterToolResult: true,
      requiresThinkingAsText: true,
      requiresReasoningContentOnAssistantMessages: true,
      zaiToolStream: true,
      deferredToolsMode: "kimi",
      supportsToolSearch: true,
    },
  }]);
  assert.deepEqual(configured?.requestCompatibility, {
    forceAdaptiveThinking: true,
    allowEmptySignature: true,
    supportsEagerToolInputStreaming: false,
    supportsToolReferences: true,
    supportsStore: true,
    supportsDeveloperRole: true,
    requiresToolResultName: true,
    requiresAssistantAfterToolResult: true,
    requiresThinkingAsText: true,
    requiresReasoningContentOnAssistantMessages: true,
    zaiToolStream: true,
    deferredToolsMode: "kimi",
    supportsToolSearch: true,
  });
  assert.throws(() => parseConfiguredModels([{
    provider: "company",
    id: "secret-model",
    headers: { Authorization: "Bearer secret" },
  }]), /reserved; credentials must use provider authentication/u);
  assert.throws(() => parseConfiguredModels([{
    provider: "company",
    id: "contradictory-model",
    reasoning: true,
    reasoningEfforts: ["off", "high"],
    reasoningEffortMap: { high: null },
  }]), /conflicts with reasoningEfforts/u);
  assert.throws(() => parseConfiguredModels([{
    provider: "company",
    id: "ambiguous-routing-model",
    requestCompatibility: {
      openRouterRouting: { only: ["one"] },
      vercelGatewayRouting: { only: ["two"] },
    },
  }]), /cannot configure both OpenRouter and Vercel routing/u);
  assert.throws(() => parseConfiguredModels([{
    provider: "company",
    id: "invalid-strict-mode-model",
    requestCompatibility: { supportsStrictMode: "no" as unknown as boolean },
  }]), /supportsStrictMode must be a boolean/u);
  assert.throws(() => parseConfiguredModels([{
    provider: "company",
    id: "invalid-temperature-model",
    requestCompatibility: { supportsTemperature: "no" as unknown as boolean },
  }]), /supportsTemperature must be a boolean/u);
});
