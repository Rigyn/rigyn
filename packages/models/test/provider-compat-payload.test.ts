import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.js";
import { stream as streamCompletions } from "../src/api/openai-completions.js";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat, ThinkingLevel, Usage } from "../src/types.js";

type Record_ = Record<string, unknown>;

const zeroUsage = (): Usage => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const completionModel = (compat: OpenAICompletionsCompat = {}, overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> => ({
  id: "compat-model", name: "Compatibility model", api: "openai-completions", provider: "proxy",
  baseUrl: "https://proxy.example/v1", reasoning: true, thinkingLevelMap: { off: "none", high: "high", max: "max" },
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 20_000, maxTokens: 4_000,
  compat,
  ...overrides,
});

const anthropicModel = (allowEmptySignature?: boolean): Model<"anthropic-messages"> => ({
  id: "compat-model", name: "Compatibility model", api: "anthropic-messages", provider: "proxy",
  baseUrl: "https://proxy.example", reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 20_000, maxTokens: 4_000,
  ...(allowEmptySignature === undefined ? {} : { compat: { allowEmptySignature } }),
});

function completionSse(...packets: Record_[]): Response {
  return new Response(packets.map((packet) => `data: ${JSON.stringify(packet)}\n\n`).join(""), {
    status: 200, headers: { "content-type": "text/event-stream" },
  });
}

function anthropicSse(): Response {
  return completionSse(
    { type: "message_start", message: { id: "message", usage: {} } },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  );
}

async function completionPayload(
  model: Model<"openai-completions">,
  context: Context = { systemPrompt: "System", messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
  reasoningEffort?: ThinkingLevel,
  cacheRetention: "none" | "short" | "long" = "short",
): Promise<Record_> {
  let payload: Record_ | undefined;
  const result = await streamCompletions(model, context, {
    apiKey: "test", reasoningEffort, cacheRetention, maxRetries: 0,
    fetch: async (_input, init) => {
      payload = JSON.parse(String(init?.body)) as Record_;
      return completionSse({ id: "response", choices: [{ delta: {}, finish_reason: "stop" }] });
    },
  }).result();
  assert.equal(result.stopReason, "stop");
  assert.ok(payload);
  return payload;
}

async function anthropicPayload(model: Model<"anthropic-messages">, thinking: string, signature: string): Promise<Record_> {
  let payload: Record_ | undefined;
  const previous: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "thinking", thinking, thinkingSignature: signature }], usage: zeroUsage(), stopReason: "stop", timestamp: 2,
  };
  await streamAnthropic(model, {
    messages: [{ role: "user", content: "First", timestamp: 1 }, previous, { role: "user", content: "Second", timestamp: 3 }],
  }, {
    apiKey: "test", maxRetries: 0,
    fetch: async (_input, init) => { payload = JSON.parse(String(init?.body)) as Record_; return anthropicSse(); },
  }).result();
  assert.ok(payload);
  return payload;
}

function assistantBlocks(payload: Record_): Record_[] {
  const messages = payload.messages as Array<{ role: string; content: Record_[] }>;
  return messages.find((message) => message.role === "assistant")?.content ?? [];
}

test("Anthropic empty-signature compatibility preserves only supported thinking blocks", async () => {
  assert.deepEqual(assistantBlocks(await anthropicPayload(anthropicModel(), "internal", "")), [{ type: "text", text: "internal" }]);
  assert.deepEqual(assistantBlocks(await anthropicPayload(anthropicModel(), "", "signed")), [{ type: "thinking", thinking: "", signature: "signed" }]);
  assert.deepEqual(assistantBlocks(await anthropicPayload(anthropicModel(true), "internal", " ")), [{ type: "thinking", thinking: "internal", signature: "" }]);

  const k3: Model<"anthropic-messages"> = {
    ...anthropicModel(),
    id: "k3",
    provider: "kimi-coding",
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
    compat: { allowEmptySignature: true, forceAdaptiveThinking: true },
  };
  assert.equal(k3.reasoning, true);
  assert.equal(k3.compat?.allowEmptySignature, true);
  assert.equal(k3.compat?.forceAdaptiveThinking, true);
  assert.deepEqual(k3.thinkingLevelMap, { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" });
});

test("completion compatibility controls store, strict schemas, and z.ai tool streaming", async () => {
  const context: Context = {
    messages: [{ role: "user", content: "Hello", timestamp: 1 }],
    tools: [{ name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) }],
  };
  const supported = await completionPayload(completionModel({ supportsStore: true, supportsStrictMode: true, zaiToolStream: true }), context);
  assert.equal(supported.store, false);
  assert.equal(supported.tool_stream, true);
  assert.equal((((supported.tools as Record_[])[0]!.function as Record_).strict), false);

  const unsupported = await completionPayload(completionModel({ supportsStore: false, supportsStrictMode: false, zaiToolStream: true }), { messages: context.messages });
  assert.equal(unsupported.store, undefined);
  assert.equal(unsupported.tool_stream, undefined);
});

test("Kimi deferred tools are omitted initially and introduced after each result batch", async () => {
  const prior: AssistantMessage = {
    role: "assistant", api: "openai-completions", provider: "proxy", model: "compat-model",
    content: [
      { type: "toolCall", id: "first", name: "base", arguments: {} },
      { type: "toolCall", id: "second", name: "base", arguments: {} },
    ], usage: zeroUsage(), stopReason: "toolUse", timestamp: 2,
  };
  const context: Context = {
    messages: [
      { role: "user", content: "Start", timestamp: 1 }, prior,
      { role: "toolResult", toolCallId: "first", toolName: "base", content: [{ type: "text", text: "one" }], addedToolNames: ["late", "missing"], isError: false, timestamp: 3 },
      { role: "toolResult", toolCallId: "second", toolName: "base", content: [{ type: "text", text: "two" }], addedToolNames: ["later"], isError: false, timestamp: 4 },
      { role: "user", content: "Continue", timestamp: 5 },
    ],
    tools: [
      { name: "base", description: "Base", parameters: Type.Object({}) },
      { name: "late", description: "Late", parameters: Type.Object({ value: Type.String() }) },
      { name: "later", description: "Later", parameters: Type.Object({ count: Type.Number() }) },
    ],
  };
  const payload = await completionPayload(completionModel({ deferredToolsMode: "kimi" }), context);
  const tools = payload.tools as Array<{ function: { name: string } }>;
  assert.deepEqual(tools.map((tool) => tool.function.name), ["base"]);
  const messages = payload.messages as Array<{ role: string; tools?: Array<{ function: { name: string } }> }>;
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool", "tool", "system", "user"]);
  assert.deepEqual(messages[4]!.tools?.map((tool) => tool.function.name), ["late", "later"]);
});

test("Anthropic cache markers cover instructions, tools, and the last conversational text", async () => {
  const context: Context = {
    systemPrompt: "System",
    messages: [{ role: "user", content: "Hello", timestamp: 1 }],
    tools: [{ name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) }],
  };
  const long = await completionPayload(completionModel({ cacheControlFormat: "anthropic", supportsLongCacheRetention: true }), context, undefined, "long");
  const marker = { type: "ephemeral", ttl: "1h" };
  assert.deepEqual(((long.messages as Array<{ content: Record_[] }>)[0]!.content[0]!.cache_control), marker);
  assert.deepEqual((long.tools as Record_[])[0]!.cache_control, marker);
  assert.deepEqual(((long.messages as Array<{ content: Record_[] }>).at(-1)!.content[0]!.cache_control), marker);

  const unsupportedLong = await completionPayload(completionModel({ cacheControlFormat: "anthropic", supportsLongCacheRetention: false }), context, undefined, "long");
  assert.deepEqual(((unsupportedLong.messages as Array<{ content: Record_[] }>)[0]!.content[0]!.cache_control), { type: "ephemeral" });

  const disabled = await completionPayload(completionModel({ cacheControlFormat: "anthropic" }), context, undefined, "none");
  assert.equal(typeof (disabled.messages as Array<{ content: unknown }>)[0]!.content, "string");
  assert.equal((disabled.tools as Record_[])[0]!.cache_control, undefined);
});

test("every declared completion reasoning format maps on and off payloads", async (t) => {
  await t.test("zai", async () => {
    const model = completionModel({ reasoningFormat: "zai", supportsReasoningEffort: true });
    assert.deepEqual((await completionPayload(model, undefined, "high")).thinking, { type: "enabled", clear_thinking: false });
    assert.equal((await completionPayload(model, undefined, "high")).reasoning_effort, "high");
    assert.deepEqual((await completionPayload(model)).thinking, { type: "disabled" });
  });
  await t.test("qwen variants", async () => {
    assert.equal((await completionPayload(completionModel({ reasoningFormat: "qwen" }), undefined, "high")).enable_thinking, true);
    assert.equal((await completionPayload(completionModel({ reasoningFormat: "qwen" }))).enable_thinking, false);
    assert.deepEqual((await completionPayload(completionModel({ reasoningFormat: "qwen-chat-template" }), undefined, "high")).chat_template_kwargs, { enable_thinking: true, preserve_thinking: true });
    assert.deepEqual((await completionPayload(completionModel({ reasoningFormat: "qwen-chat-template" }))).chat_template_kwargs, { enable_thinking: false, preserve_thinking: true });
  });
  await t.test("configurable chat template", async () => {
    const model = completionModel({
      reasoningFormat: "chat-template",
      chatTemplateKwargs: {
        preserve_thinking: true,
        enabled: { $var: "thinking.enabled" },
        effort: { $var: "thinking.effort", omitWhenOff: true },
        optional: { $var: "thinking.effort" },
      },
    });
    assert.deepEqual((await completionPayload(model, undefined, "max")).chat_template_kwargs, { preserve_thinking: true, enabled: true, effort: "max", optional: "max" });
    assert.deepEqual((await completionPayload(model)).chat_template_kwargs, { preserve_thinking: true, enabled: false, optional: "none" });
  });
  await t.test("deepseek", async () => {
    const model = completionModel({ reasoningFormat: "deepseek", supportsReasoningEffort: true });
    assert.deepEqual((await completionPayload(model, undefined, "high")).thinking, { type: "enabled" });
    assert.equal((await completionPayload(model, undefined, "high")).reasoning_effort, "high");
    assert.deepEqual((await completionPayload(model)).thinking, { type: "disabled" });
    assert.equal((await completionPayload({ ...model, thinkingLevelMap: { off: null, high: "high" } })).thinking, undefined);
  });
  await t.test("openrouter", async () => {
    const model = completionModel({ reasoningFormat: "openrouter" });
    assert.deepEqual((await completionPayload(model, undefined, "high")).reasoning, { effort: "high" });
    assert.deepEqual((await completionPayload(model)).reasoning, { effort: "none" });
    assert.equal((await completionPayload({ ...model, thinkingLevelMap: { off: null } })).reasoning, undefined);
  });
  await t.test("together", async () => {
    const model = completionModel({ reasoningFormat: "together", supportsReasoningEffort: true });
    assert.deepEqual((await completionPayload(model, undefined, "high")).reasoning, { enabled: true });
    assert.equal((await completionPayload(model, undefined, "high")).reasoning_effort, "high");
    assert.deepEqual((await completionPayload(model)).reasoning, { enabled: false });
  });
  await t.test("string thinking", async () => {
    const model = completionModel({ reasoningFormat: "string-thinking" });
    assert.equal((await completionPayload(model, undefined, "high")).thinking, "high");
    assert.equal((await completionPayload(model)).thinking, "none");
    assert.equal((await completionPayload({ ...model, thinkingLevelMap: { off: null } })).thinking, undefined);
  });
  await t.test("ant-ling", async () => {
    const model = completionModel({ reasoningFormat: "ant-ling" }, { thinkingLevelMap: { high: "high" } });
    assert.deepEqual((await completionPayload(model, undefined, "high")).reasoning, { effort: "high" });
    assert.equal((await completionPayload(model, undefined, "medium")).reasoning, undefined);
    assert.equal((await completionPayload(model)).reasoning, undefined);
  });
  await t.test("openai/default", async () => {
    const model = completionModel({ reasoningFormat: "openai", supportsReasoningEffort: true });
    assert.equal((await completionPayload(model, undefined, "high")).reasoning_effort, "high");
    assert.equal((await completionPayload(model)).reasoning_effort, "none");
    assert.equal((await completionPayload({ ...model, thinkingLevelMap: { off: null } })).reasoning_effort, undefined);
  });
});

test("completion usage accepts provider fallbacks without double-counting cache or reasoning", async () => {
  const model = completionModel();
  const result = await streamCompletions(model, { messages: [{ role: "user", content: "Hello", timestamp: 1 }] }, {
    apiKey: "test", maxRetries: 0,
    fetch: async () => completionSse({
      id: "response", choices: [{ delta: {}, finish_reason: "stop", usage: {
        prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 50,
        prompt_tokens_details: { cache_write_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 2 },
      } }],
    }),
  }).result();
  assert.deepEqual(result.usage, {
    input: 20, output: 5, cacheRead: 50, cacheWrite: 30, reasoning: 2, totalTokens: 105,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("encrypted reasoning details bind to tools and replay at assistant-message scope", async () => {
  const detail = { type: "reasoning.encrypted", id: "call", data: "opaque" };
  const model = completionModel({ reasoningFormat: "openrouter" });
  const first = await streamCompletions(model, { messages: [{ role: "user", content: "Hello", timestamp: 1 }] }, {
    apiKey: "test", maxRetries: 0,
    fetch: async () => completionSse(
      { id: "response", choices: [{ delta: { reasoning_details: [detail] }, finish_reason: null }] },
      { id: "response", choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "read", arguments: "{}" } }] }, finish_reason: null }] },
      { id: "response", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ),
  }).result();
  const call = first.content.find((block) => block.type === "toolCall");
  assert.equal(call?.type === "toolCall" ? call.thoughtSignature : undefined, JSON.stringify(detail));

  const payload = await completionPayload(model, { messages: [{ role: "user", content: "Hello", timestamp: 1 }, first] });
  const assistant = (payload.messages as Record_[]).find((message) => message.role === "assistant")!;
  assert.deepEqual(assistant.reasoning_details, [detail]);
  const replayedCall = (assistant.tool_calls as Record_[])[0]!;
  assert.equal(replayedCall.reasoning_details, undefined);
});

test("completion streaming preserves reasoning field identity and rejects unknown terminal reasons", async () => {
  const model = completionModel({ reasoningFormat: "openrouter" });
  const reasoning = await streamCompletions(model, { messages: [{ role: "user", content: "Hello", timestamp: 1 }] }, {
    apiKey: "test", maxRetries: 0,
    fetch: async () => completionSse({ id: "response", choices: [{ delta: { reasoning_text: "thought" }, finish_reason: "stop" }] }),
  }).result();
  const thought = reasoning.content.find((block) => block.type === "thinking");
  assert.deepEqual(thought, { type: "thinking", thinking: "thought", thinkingSignature: "reasoning_text" });

  const failed = await streamCompletions(model, { messages: [{ role: "user", content: "Hello", timestamp: 1 }] }, {
    apiKey: "test", maxRetries: 0,
    fetch: async () => completionSse({ id: "response", choices: [{ delta: { content: "partial" }, finish_reason: "network_error" }] }),
  }).result();
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.errorMessage, "Provider finish_reason: network_error");
});

test("completion compatibility is inferred for maintained nonstandard endpoints", async () => {
  const zai = await completionPayload(completionModel({}, { provider: "zai", baseUrl: "https://api.z.ai/api/paas/v4" }), undefined, "high");
  assert.equal(zai.store, undefined);
  assert.deepEqual(zai.thinking, { type: "enabled", clear_thinking: false });
  assert.equal(zai.reasoning_effort, undefined);

  const together = await completionPayload(completionModel({}, { provider: "together", baseUrl: "https://api.together.xyz/v1" }), {
    messages: [{ role: "user", content: "Hello", timestamp: 1 }],
    tools: [{ name: "read", description: "Read", parameters: Type.Object({}) }],
  }, "high");
  assert.equal(together.max_tokens, 4_000);
  assert.deepEqual(together.reasoning, { enabled: true });
  assert.equal((((together.tools as Record_[])[0]!.function as Record_).strict), undefined);

  const routed = await completionPayload(completionModel({}, { id: "anthropic/model", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }));
  assert.equal((routed.messages as Record_[])[0]!.role, "developer");
  assert.equal(Array.isArray((routed.messages as Record_[])[0]!.content), true);
});
