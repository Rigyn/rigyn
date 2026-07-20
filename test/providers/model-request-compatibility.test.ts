import assert from "node:assert/strict";
import test from "node:test";

import { OpenAICompatibleAdapter } from "../../src/providers/openai-compatible.js";
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
      maxTokensField: "max_tokens",
      reasoningFormat: "chat-template",
      chatTemplateParameters: {
        enable_reasoning: { $var: "thinking.enabled" },
        reasoning_level: { $var: "thinking.effort" },
        nested: { selected: { $var: "thinking.effort" } },
      },
      cacheControlFormat: "anthropic",
      cacheControlTtl: "1h",
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
  assert.equal(tools[0]?.cache_control, undefined);
  assert.deepEqual(tools[1]?.cache_control, { type: "ephemeral", ttl: "1h" });

  const models = await registry.listModels("company", new AbortController().signal);
  assert.deepEqual(modelReasoningEfforts(models[0]!), ["off", "low", "medium", "high", "xhigh", "max"]);
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
});
