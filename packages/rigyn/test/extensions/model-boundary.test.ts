import assert from "node:assert/strict";
import test from "node:test";

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type Provider,
} from "@rigyn/models";
import { ASSISTANT_CONTENT_LIMITS } from "@rigyn/kernel/runtime/core/assistant-content-limits";

import { projectMessagesForProvider } from "../../src/context/projection.js";
import type { AdapterEvent, CanonicalMessage, ModelProtocolFamily, ProviderRequest, ProviderState } from "../../src/core/types.js";
import {
  extensionModel,
  extensionModelRegistry,
  protocolFromPublicApi,
  publicApiFromProtocol,
  streamFunctionAdapterEvents,
} from "../../src/extensions/model-boundary.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import { createModels, createProvider, type ProviderStreamOptions } from "../../src/providers/models.js";
import { MAX_TOOL_INVOCATIONS } from "../../src/tools/coordinator.js";

function publicModel(api: Api, provider = "extension-provider", id = "extension-model"): Model<Api> {
  return {
    id,
    name: "Extension model",
    api,
    provider,
    baseUrl: "https://example.test/v1",
    reasoning: true,
    thinkingLevelMap: { high: "provider-high" },
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    contextWindow: 32_000,
    maxTokens: 4_000,
  };
}

async function collectEvents(source: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const values: AdapterEvent[] = [];
  for await (const value of source) values.push(value);
  return values;
}

function publicEventSource(...events: unknown[]): AsyncIterable<AssistantMessageEvent> {
  return (async function* () {
    for (const event of events) yield event as AssistantMessageEvent;
  })();
}

function adapterRequest(model: Model<Api>): ProviderRequest {
  return {
    provider: model.provider,
    model: model.id,
    api: protocolFromPublicApi(model.api),
    messages: [],
    tools: [],
  };
}

test("public provider tool arguments are bounded detached plain JSON without invoking serializers", async () => {
  const model = publicModel("openai-completions");
  const request = adapterRequest(model);
  let toJsonCalls = 0;
  const inheritedToJson = Object.assign(Object.create({
    toJSON() {
      toJsonCalls += 1;
      return { rewritten: true };
    },
  }) as Record<string, unknown>, { original: true });

  await assert.rejects(
    collectEvents(streamFunctionAdapterEvents(
      model,
      request,
      new AbortController().signal,
      () => publicEventSource({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "call", name: "echo", arguments: inheritedToJson },
        partial: {},
      }) as never,
    )),
    /plain objects and (?:vanilla )?arrays/u,
  );
  assert.equal(toJsonCalls, 0);

  await assert.rejects(
    collectEvents(streamFunctionAdapterEvents(
      model,
      request,
      new AbortController().signal,
      () => publicEventSource({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: {
          type: "toolCall",
          id: "oversized",
          name: "echo",
          arguments: { value: "x".repeat(ASSISTANT_CONTENT_LIMITS.fieldBytes + 1) },
        },
        partial: {},
      }) as never,
    )),
    new RegExp(`exceeds ${ASSISTANT_CONTENT_LIMITS.fieldBytes} (?:UTF-8 )?bytes`, "u"),
  );

  const mutable = { value: "before" };
  const events = await collectEvents(streamFunctionAdapterEvents(
    model,
    request,
    new AbortController().signal,
    () => (async function* () {
      yield {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "detached", name: "echo", arguments: mutable },
        partial: {},
      } as unknown as AssistantMessageEvent;
      mutable.value = "after";
    })() as never,
  ));
  const completed = events.find((event): event is Extract<AdapterEvent, { type: "tool_call_end" }> =>
    event.type === "tool_call_end");
  assert.deepEqual(completed?.arguments, { value: "before" });
  assert.equal(completed?.rawArguments, '{"value":"before"}');
  assert.notEqual(completed?.arguments, mutable);
});

test("public provider stream translation enforces indexes, cardinality, fields, and retained content before concatenation", async () => {
  const model = publicModel("openai-completions");
  const request = adapterRequest(model);
  const collect = async (events: unknown[]): Promise<AdapterEvent[]> => await collectEvents(streamFunctionAdapterEvents(
    model,
    request,
    new AbortController().signal,
    () => publicEventSource(...events) as never,
  ));
  const field = ASSISTANT_CONTENT_LIMITS.fieldBytes;

  await assert.rejects(collect([
    { type: "text_start", contentIndex: -1, partial: {} },
  ]), /invalid public stream text index/u);
  await assert.rejects(collect([
    { type: "text_delta", contentIndex: 0, delta: "x".repeat(field + 1), partial: {} },
  ]), new RegExp(`exceeds ${field} bytes`, "u"));
  await assert.rejects(collect([
    { type: "text_delta", contentIndex: 0, delta: "x".repeat(3 * 1024 * 1024), partial: {} },
    { type: "text_delta", contentIndex: 0, delta: "y".repeat(2 * 1024 * 1024), partial: {} },
  ]), new RegExp(`text part 0 exceeds ${field} bytes`, "u"));
  await assert.rejects(collect([
    { type: "text_delta", contentIndex: 0, delta: "x".repeat(field), partial: {} },
    { type: "text_delta", contentIndex: 1, delta: "y".repeat(field), partial: {} },
    { type: "thinking_delta", contentIndex: 2, delta: "z", partial: {} },
  ]), new RegExp(`exceeds ${ASSISTANT_CONTENT_LIMITS.contentBytes} aggregate bytes`, "u"));
  await assert.rejects(collect(Array.from({ length: ASSISTANT_CONTENT_LIMITS.blocks + 1 }, (_, contentIndex) => ({
    type: "text_start",
    contentIndex,
    partial: {},
  }))), new RegExp(`exceeds ${ASSISTANT_CONTENT_LIMITS.blocks} streamed blocks`, "u"));
  await assert.rejects(collect([
    { type: "toolcall_start", contentIndex: -1, partial: { content: [] } },
  ]), /invalid public stream tool index/u);
  await assert.rejects(collect(Array.from({ length: MAX_TOOL_INVOCATIONS + 1 }, (_, contentIndex) => ({
    type: "toolcall_start",
    contentIndex,
    partial: { content: [] },
  }))), new RegExp(`more than ${MAX_TOOL_INVOCATIONS} streaming tool calls`, "u"));
  await assert.rejects(collect([
    { type: "toolcall_delta", contentIndex: 0, delta: "x".repeat(field + 1), partial: {} },
  ]), new RegExp(`exceeds ${field} bytes`, "u"));
});

test("legacy normalized provider events cannot bypass stream boundary validation", async () => {
  const model = publicModel("openai-completions");
  const request = adapterRequest(model);
  const collect = async (...events: unknown[]): Promise<AdapterEvent[]> => await collectEvents(streamFunctionAdapterEvents(
    model,
    request,
    new AbortController().signal,
    () => publicEventSource(...events) as never,
  ));

  await assert.rejects(collect(
    { type: "text_delta", part: -1, text: "invalid" },
  ), /non-negative/u);
  await assert.rejects(collect(
    { type: "text_delta", part: 0, text: "x".repeat(ASSISTANT_CONTENT_LIMITS.fieldBytes + 1) },
  ), /byte limit|exceeds/u);
  await assert.rejects(collect({
    type: "error",
    error: { category: "provider", message: "invalid", retryable: "yes", partial: false },
  }), /flags must be booleans/u);

  let toJsonCalls = 0;
  const hostileArguments = Object.assign(Object.create({
    toJSON() {
      toJsonCalls += 1;
      return { rewritten: true };
    },
  }) as Record<string, unknown>, { original: true });
  await assert.rejects(collect({
    type: "tool_call_end",
    index: 0,
    id: "call",
    name: "echo",
    arguments: hostileArguments,
    rawArguments: "{}",
  }), /plain objects and (?:vanilla )?arrays/u);
  assert.equal(toJsonCalls, 0);

  const hostileState = Object.assign(Object.create({
    toJSON() {
      toJsonCalls += 1;
      return { kind: "chat_completions", assistantMessage: {} };
    },
  }) as Record<string, unknown>, {
    kind: "chat_completions",
    assistantMessage: {},
  });
  await assert.rejects(collect({
    type: "response_end",
    reason: "stop",
    state: hostileState,
  }), /continuation state|plain objects/u);
  assert.equal(toJsonCalls, 0);
});

test("provider event discrimination never invokes proxy traps or accessors", async () => {
  const model = publicModel("openai-completions");
  const request = adapterRequest(model);
  const collect = async (event: unknown): Promise<AdapterEvent[]> => {
    const source: AsyncIterable<AssistantMessageEvent> = {
      [Symbol.asyncIterator]() {
        let emitted = false;
        return {
          async next() {
            if (emitted) return { done: true, value: undefined };
            emitted = true;
            return { done: false, value: event as AssistantMessageEvent };
          },
        };
      },
    };
    return await collectEvents(streamFunctionAdapterEvents(
      model,
      request,
      new AbortController().signal,
      () => source as never,
    ));
  };

  let proxyTraps = 0;
  const normalizedProxy = new Proxy({ type: "text_delta", part: 0, text: "hidden" }, {
    get(target, property, receiver) {
      proxyTraps += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  await assert.rejects(collect(normalizedProxy), /non-proxy plain object/u);
  assert.equal(proxyTraps, 0);

  let getterCalls = 0;
  const ordinaryAccessor = { type: "text_delta", delta: "hidden", partial: {} } as Record<string, unknown>;
  Object.defineProperty(ordinaryAccessor, "contentIndex", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 0;
    },
  });
  await assert.rejects(collect(ordinaryAccessor), /enumerable data fields/u);

  const nestedToolCall = { id: "call", name: "echo", arguments: {} } as Record<string, unknown>;
  Object.defineProperty(nestedToolCall, "thoughtSignature", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "hidden";
    },
  });
  await assert.rejects(collect({
    type: "toolcall_end",
    contentIndex: 0,
    toolCall: nestedToolCall,
    partial: {},
  }), /enumerable data fields/u);
  assert.equal(getterCalls, 0);
});

test("public provider stream lifecycle rejects duplicate starts, post-terminal events, and changed or omitted active parts", async () => {
  const model = publicModel("openai-completions");
  const request = adapterRequest(model);
  const collect = async (...events: unknown[]): Promise<AdapterEvent[]> => await collectEvents(streamFunctionAdapterEvents(
    model,
    request,
    new AbortController().signal,
    () => publicEventSource(...events) as never,
  ));
  const message = {
    role: "assistant" as const,
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };

  await assert.rejects(collect(
    { type: "start", partial: { ...message, stopReason: "pending" } },
    { type: "start", partial: { ...message, stopReason: "pending" } },
  ), /more than one start/u);
  await assert.rejects(collect(
    { type: "done", reason: "stop", message },
    { type: "text_delta", contentIndex: 0, delta: "late", partial: message },
  ), /after a terminal event/u);
  await assert.rejects(collect(
    { type: "text_delta", contentIndex: 0, delta: "started", partial: message },
    { type: "done", reason: "stop", message },
  ), /omitted streamed text part 0/u);
  await collect(
    { type: "text_end", contentIndex: 0, content: "closed", partial: message },
    {
      type: "done",
      reason: "stop",
      message: { ...message, content: [{ type: "text", text: "closed" }] },
    },
  );
  await collect(
    { type: "thinking_end", contentIndex: 0, content: "closed", partial: message },
    {
      type: "done",
      reason: "stop",
      message: { ...message, content: [{ type: "thinking", thinking: "closed" }] },
    },
  );
  await assert.rejects(collect(
    { type: "text_end", contentIndex: 0, content: "closed", partial: message },
    {
      type: "done",
      reason: "stop",
      message: { ...message, content: [{ type: "text", text: "closed later" }] },
    },
  ), /changed completed streamed text part 0/u);
  await assert.rejects(collect(
    { type: "thinking_end", contentIndex: 0, content: "closed", partial: message },
    {
      type: "done",
      reason: "stop",
      message: { ...message, content: [{ type: "thinking", thinking: "closed later" }] },
    },
  ), /changed completed streamed thinking part 0/u);
});

test("model boundary translates canonical APIs and uses a bounded carrier for custom APIs", () => {
  const protocolNames: ModelProtocolFamily[] = [
    "anthropic-messages",
    "bedrock-converse",
    "extension-stream",
    "gemini-generate-content",
    "gemini-interactions",
    "ollama-chat",
    "openai-chat-completions",
    "openai-responses",
  ];
  for (const protocol of protocolNames) assert.equal(protocolFromPublicApi(protocol), protocol);

  assert.equal(protocolFromPublicApi("openai-completions"), "openai-chat-completions");
  assert.equal(protocolFromPublicApi("google-generative-ai"), "gemini-generate-content");
  assert.equal(publicApiFromProtocol("bedrock-converse"), "bedrock-converse-stream");
  assert.equal(protocolFromPublicApi("vendor-custom-stream"), "extension-stream");
});

test("public streams produce protocol-matching continuation state for every core model family", async () => {
  const cases: Array<{ publicApi: Api; protocol: ModelProtocolFamily; kind: ProviderState["kind"] }> = [
    { publicApi: "openai-responses", protocol: "openai-responses", kind: "openai_responses" },
    { publicApi: "openai-completions", protocol: "openai-chat-completions", kind: "chat_completions" },
    { publicApi: "anthropic-messages", protocol: "anthropic-messages", kind: "anthropic_messages" },
    { publicApi: "google-generative-ai", protocol: "gemini-generate-content", kind: "gemini_generate_content" },
    { publicApi: "gemini-interactions", protocol: "gemini-interactions", kind: "gemini_interactions" },
    { publicApi: "bedrock-converse-stream", protocol: "bedrock-converse", kind: "bedrock_converse" },
    { publicApi: "ollama-chat", protocol: "ollama-chat", kind: "ollama_chat" },
    { publicApi: "vendor-custom-stream", protocol: "extension-stream", kind: "extension_stream" },
  ];

  for (const selected of cases) {
    const model = publicModel(selected.publicApi, `provider-${selected.protocol}`, `model-${selected.protocol}`);
    const request: ProviderRequest = {
      provider: model.provider,
      model: model.id,
      api: selected.protocol,
      messages: [],
      tools: [],
    };
    const events = await collectEvents(streamFunctionAdapterEvents(
      model,
      request,
      new AbortController().signal,
      () => responseStream(model, `response for ${selected.protocol}`),
    ));
    const terminal = events.find((event): event is Extract<AdapterEvent, { type: "response_end" }> => event.type === "response_end");
    assert.equal(terminal?.state.kind, selected.kind, selected.protocol);
    assert.deepEqual(terminal?.state.source, {
      provider: model.provider,
      model: model.id,
      api: selected.protocol,
    }, selected.protocol);
  }
});

test("public streams preserve valid explicit continuation state at the exact model boundary", async () => {
  const model = publicModel("anthropic-messages", "explicit-provider", "explicit-model");
  let observedOptions: import("@rigyn/models").SimpleStreamOptions | undefined;
  const explicit: ProviderState = {
    kind: "anthropic_messages",
    assistantBlocks: [{ type: "text", text: "provider-owned replay block" }],
  };
  const events = await collectEvents(streamFunctionAdapterEvents(
    model,
    {
      provider: model.provider,
      model: model.id,
      api: "anthropic-messages",
      messages: [],
      tools: [],
      toolChoice: { type: "function", function: { name: "structured_output" } },
      temperature: 0.25,
      cacheRetention: "long",
    },
    new AbortController().signal,
    (_model, _context, options) => {
      observedOptions = options;
      return responseStream(model, "visible response", explicit);
    },
  ));
  const terminal = events.find((event): event is Extract<AdapterEvent, { type: "response_end" }> => event.type === "response_end");
  assert.deepEqual(terminal?.state, {
    ...explicit,
    source: { provider: model.provider, model: model.id, api: "anthropic-messages" },
  });
  assert.deepEqual(observedOptions?.toolChoice, {
    type: "function",
    function: { name: "structured_output" },
  });
  assert.equal(observedOptions?.temperature, 0.25);
  assert.equal(observedOptions?.cacheRetention, "long");
});

test("extension provider models preserve every public wire-compatibility control at the core boundary", () => {
  const internal = new ModelRegistry(createModels());
  const registry = extensionModelRegistry(internal);
  const common = {
    name: "Compatibility model",
    reasoning: true,
    input: ["text"] as Array<"text">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 4_000,
  };

  registry.registerProvider("compatibility-provider", {
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    models: [
      {
        ...common,
        id: "chat-model",
        api: "openai-completions",
        compat: {
          supportsStore: true,
          supportsDeveloperRole: true,
          supportsReasoningEffort: true,
          supportsUsageInStreaming: false,
          maxTokensField: "max_tokens",
          requiresToolResultName: true,
          requiresAssistantAfterToolResult: true,
          requiresThinkingAsText: true,
          requiresReasoningContentOnAssistantMessages: true,
          reasoningOutputFormat: "parsed",
          reasoningFormat: "zai",
          zaiToolStream: true,
          supportsStrictMode: false,
          supportsOpenAIGrammarTools: true,
          cacheControlFormat: "anthropic",
          cacheControlTtl: "1h",
          deferredToolsMode: "kimi",
          supportsLongCacheRetention: false,
        },
      },
      {
        ...common,
        id: "responses-model",
        api: "openai-responses",
        compat: {
          supportsDeveloperRole: true,
          supportsToolSearch: true,
          supportsExplicitPromptCacheMode: true,
          supportsPromptCacheBreakpoints: true,
          supportsReasoningSummaries: true,
          exposesReasoningText: false,
          supportsOpenAIGrammarTools: true,
          sessionAffinityFormat: "openai-nosession",
          supportsLongCacheRetention: false,
        },
      },
      {
        ...common,
        id: "chat-include-model",
        api: "openai-completions",
        compat: { includeReasoning: true },
      },
      {
        ...common,
        id: "messages-model",
        api: "anthropic-messages",
        compat: {
          supportsEagerToolInputStreaming: false,
          supportsLongCacheRetention: false,
          sendSessionAffinityHeaders: true,
          supportsCacheControlOnTools: false,
          supportsTemperature: false,
          forceAdaptiveThinking: true,
          allowEmptySignature: true,
          supportsToolReferences: true,
          supportsStrictTools: true,
          supportsThinkingDisplay: true,
        },
      },
      {
        ...common,
        id: "bedrock-model",
        api: "bedrock-converse-stream",
        compat: {
          supportsStrictMode: true,
          supportsPromptCaching: false,
        },
      },
    ],
  });

  assert.deepEqual(internal.find("compatibility-provider", "chat-model")?.compat, {
    supportsStore: true,
    supportsDeveloperRole: true,
    supportsReasoningEffort: true,
    supportsUsageInStreaming: false,
    maxTokensField: "max_tokens",
    requiresToolResultName: true,
    requiresAssistantAfterToolResult: true,
    requiresThinkingAsText: true,
    requiresReasoningContentOnAssistantMessages: true,
    reasoningOutputFormat: "parsed",
    reasoningFormat: "zai",
    zaiToolStream: true,
    supportsStrictMode: false,
    supportsOpenAIGrammarTools: true,
    cacheControlFormat: "anthropic",
    cacheControlTtl: "1h",
    deferredToolsMode: "kimi",
    supportsLongCacheRetention: false,
  });
  assert.deepEqual(internal.find("compatibility-provider", "responses-model")?.compat, {
    supportsDeveloperRole: true,
    supportsToolSearch: true,
    supportsExplicitPromptCacheMode: true,
    supportsPromptCacheBreakpoints: true,
    supportsReasoningSummaries: true,
    exposesReasoningText: false,
    supportsOpenAIGrammarTools: true,
    sessionAffinityFormat: "openai-nosession",
    supportsLongCacheRetention: false,
  });
  assert.deepEqual(internal.find("compatibility-provider", "chat-include-model")?.compat, {
    includeReasoning: true,
  });
  assert.deepEqual(internal.find("compatibility-provider", "messages-model")?.compat, {
    supportsEagerToolInputStreaming: false,
    supportsLongCacheRetention: false,
    sendSessionAffinityHeaders: true,
    supportsCacheControlOnTools: false,
    supportsTemperature: false,
    forceAdaptiveThinking: true,
    allowEmptySignature: true,
    supportsToolReferences: true,
    supportsStrictTools: true,
    supportsThinkingDisplay: true,
  });
  assert.deepEqual(extensionModel(internal.find("compatibility-provider", "chat-model")!).compat, {
    supportsStore: true,
    supportsDeveloperRole: true,
    supportsUsageInStreaming: false,
    supportsStrictMode: false,
    supportsOpenAIGrammarTools: true,
    maxTokensField: "max_tokens",
    requiresToolResultName: true,
    requiresAssistantAfterToolResult: true,
    requiresThinkingAsText: true,
    requiresReasoningContentOnAssistantMessages: true,
    supportsReasoningEffort: true,
    reasoningOutputFormat: "parsed",
    reasoningFormat: "zai",
    zaiToolStream: true,
    deferredToolsMode: "kimi",
    cacheControlFormat: "anthropic",
    cacheControlTtl: "1h",
    supportsLongCacheRetention: false,
  });
  assert.deepEqual(extensionModel(internal.find("compatibility-provider", "responses-model")!).compat, {
    supportsDeveloperRole: true,
    supportsOpenAIGrammarTools: true,
    supportsToolSearch: true,
    supportsExplicitPromptCacheMode: true,
    supportsPromptCacheBreakpoints: true,
    supportsReasoningSummaries: true,
    exposesReasoningText: false,
    supportsLongCacheRetention: false,
    sessionAffinityFormat: "openai-nosession",
  });
  assert.deepEqual(extensionModel(internal.find("compatibility-provider", "chat-include-model")!).compat, {
    includeReasoning: true,
  });
  assert.deepEqual(extensionModel(internal.find("compatibility-provider", "messages-model")!).compat, {
    forceAdaptiveThinking: true,
    allowEmptySignature: true,
    supportsEagerToolInputStreaming: false,
    supportsToolReferences: true,
    supportsStrictTools: true,
    supportsThinkingDisplay: true,
    supportsLongCacheRetention: false,
    supportsCacheControlOnTools: false,
    supportsTemperature: false,
    sendSessionAffinityHeaders: true,
  });
  assert.deepEqual(internal.find("compatibility-provider", "bedrock-model")?.compat, {
    supportsStrictMode: true,
    supportsPromptCaching: false,
  });
  assert.deepEqual(extensionModel(internal.find("compatibility-provider", "bedrock-model")!).compat, {
    supportsStrictMode: true,
    supportsPromptCaching: false,
  });
});

test("extension registry preserves a custom public API while the core runs its carrier protocol", async () => {
  const internal = new ModelRegistry(createModels());
  const registry = extensionModelRegistry(internal);
  let observedApi: Api | undefined;
  let observedPrompt: string | undefined;
  let observedContext: Context | undefined;
  let observedOptions: import("@rigyn/models").SimpleStreamOptions | undefined;

  registry.registerProvider("extension-provider", {
    api: "vendor-custom-stream",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    models: [{
      id: "extension-model",
      name: "Extension model",
      reasoning: true,
      thinkingLevelMap: { high: "provider-high" },
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
      contextWindow: 32_000,
      maxTokens: 4_000,
    }],
    streamSimple(model, context, options) {
      observedApi = model.api;
      observedContext = context;
      observedOptions = options;
      observedPrompt = context.messages[0]?.role === "user"
        ? typeof context.messages[0].content === "string"
          ? context.messages[0].content
          : context.messages[0].content[0]?.type === "text"
            ? context.messages[0].content[0].text
            : undefined
        : undefined;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "custom response" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 3,
            output: 2,
            totalTokens: 5,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: Date.now(),
        };
        const lifecycle: AssistantMessageEvent[] = [
          { type: "start", partial: { ...message, content: [] } },
          { type: "done", reason: "stop", message },
        ];
        for (const event of lifecycle) stream.push(event);
      });
      return stream;
    },
  });

  const internalModel = internal.find("extension-provider", "extension-model");
  assert.equal(internalModel?.api, "extension-stream");
  const exposed = registry.find("extension-provider", "extension-model");
  assert.equal(exposed?.api, "vendor-custom-stream");
  assert.deepEqual(await registry.getApiKeyAndHeaders(exposed!), {
    ok: true,
    apiKey: "test-key",
  });

  const completion = await internal.models().completeSimple(internalModel!, {
    messages: [{
      id: "message-1",
      role: "user",
      content: [{ type: "text", text: "hello boundary" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
    tools: [{
      name: "structured_output",
      description: "Return a structured result",
      inputSchema: { type: "object", properties: { answer: { type: "string" } } },
      constrainedSampling: { type: "json_schema", strict: "require" },
    }],
  }, {
    websocketConnectTimeoutMs: 321,
    websocketIdleTimeoutMs: 654,
    fetch: globalThis.fetch,
    metadata: { trace: "extension-boundary" },
    toolChoice: { type: "function", function: { name: "structured_output" } },
  });
  assert.equal(observedApi, "vendor-custom-stream");
  assert.equal(observedPrompt, "hello boundary");
  assert.deepEqual(observedContext?.tools?.[0]?.constrainedSampling, {
    type: "json_schema",
    strict: "require",
  });
  assert.equal(observedOptions?.websocketConnectTimeoutMs, 321);
  assert.equal(observedOptions?.websocketIdleTimeoutMs, 654);
  assert.equal(observedOptions?.fetch, globalThis.fetch);
  assert.deepEqual(observedOptions?.metadata, { trace: "extension-boundary" });
  assert.deepEqual(observedOptions?.toolChoice, {
    type: "function",
    function: { name: "structured_output" },
  });
  assert.equal(completion.text, "custom response");
  assert.equal(completion.finishReason, "stop");
  assert.equal(completion.usage?.totalTokens, 5);
  assert.equal(Object.hasOwn(completion.usage ?? {}, "cacheReadTokens"), false);
  assert.equal(Object.hasOwn(completion.usage ?? {}, "cacheWriteTokens"), false);
});

test("registered-provider thinking remains private while public signed blocks replay safely", async () => {
  const internal = new ModelRegistry(createModels());
  const registry = extensionModelRegistry(internal);
  const observed: Context[] = [];
  let response = 0;
  registry.registerProvider("signed-provider", {
    api: "signed-stream",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    models: ["model-a", "model-b"].map((id) => ({
      id,
      name: id,
      reasoning: true,
      input: ["text"] as Array<"text">,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_000,
      maxTokens: 1_000,
    })),
    streamSimple(model, context) {
      observed.push(structuredClone(context));
      const stream = createAssistantMessageEventStream();
      const signed = response === 0;
      response += 1;
      queueMicrotask(() => {
        const message = {
          role: "assistant" as const,
          content: signed
            ? [
                { type: "thinking" as const, thinking: "private plan", thinkingSignature: "thinking-signature", redacted: false },
                { type: "text" as const, text: "answer", textSignature: "text-signature" },
                {
                  type: "toolCall" as const,
                  id: "signed-call",
                  name: "read",
                  arguments: { path: "README.md" },
                  thoughtSignature: "tool-signature",
                },
              ]
            : [{ type: "text" as const, text: "continued" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            totalTokens: 2,
            cacheWrite: 0,
            cacheRead: 0,
            output: 1,
            input: 1,
            cost: { total: 0, cacheWrite: 0, cacheRead: 0, output: 0, input: 0 },
          },
          stopReason: "stop" as const,
          timestamp: Date.now(),
        };
        stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    },
  });

  const modelA = internal.find("signed-provider", "model-a")!;
  const first = await collectEvents(internal.models().streamSimple(modelA, { messages: [] }));
  assert.deepEqual(first.map((event) => event.type), [
    "response_start",
    "reasoning_start",
    "reasoning_delta",
    "reasoning_end",
    "text_start",
    "text_delta",
    "text_end",
    "tool_call_start",
    "tool_call_end",
    "usage",
    "response_end",
  ]);
  assert.deepEqual(first.flatMap((event) =>
    event.type === "reasoning_start" || event.type === "reasoning_delta" || event.type === "reasoning_end"
      ? [event.visibility]
      : []), ["provider_trace", "provider_trace", "provider_trace"]);
  const terminal = first.find((event): event is AdapterEvent & { type: "response_end" } => event.type === "response_end");
  assert.ok(terminal?.content);
  assert.deepEqual(terminal.content[0], {
    type: "thinking",
    thinking: "private plan",
    thinkingSignature: "thinking-signature",
    redacted: false,
    visibility: "provider_trace",
  });
  const signedMessage: CanonicalMessage = {
    id: "signed-message",
    role: "assistant",
    provider: "signed-provider",
    model: "model-a",
    api: "extension-stream",
    publicApi: "signed-stream",
    content: terminal.content,
    createdAt: "2026-07-21T00:00:00.000Z",
    stopReason: "stop",
  };

  const same = projectMessagesForProvider([signedMessage], "signed-provider", {
    model: "model-a",
    api: "extension-stream",
  });
  await collectEvents(internal.models().streamSimple(modelA, { messages: same }));
  const replay = observed[1]?.messages[0];
  assert.equal(replay?.role, "assistant");
  assert.deepEqual(replay?.role === "assistant" ? replay.content : undefined, [
    { type: "text", text: "answer", textSignature: "text-signature" },
    {
      type: "toolCall",
      id: "signed-call",
      name: "read",
      arguments: { path: "README.md" },
      thoughtSignature: "tool-signature",
    },
  ]);

  const modelB = internal.find("signed-provider", "model-b")!;
  const switched = projectMessagesForProvider([signedMessage], "signed-provider", {
    model: "model-b",
    api: "extension-stream",
  });
  await collectEvents(internal.models().streamSimple(modelB, { messages: switched }));
  const portable = observed[2]?.messages[0];
  assert.equal(portable?.role, "assistant");
  assert.deepEqual(portable?.role === "assistant" ? portable.content : undefined, [
    { type: "text", text: "answer" },
    { type: "toolCall", id: "signed-call", name: "read", arguments: { path: "README.md" } },
  ]);
});

test("named provider registration preserves the legacy normalized stream vocabulary", async () => {
  const internal = new ModelRegistry(createModels());
  const registry = extensionModelRegistry(internal);
  registry.registerProvider("normalized-provider", {
    api: "openai-responses",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    models: [{
      id: "normalized-model",
      name: "Normalized model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_000,
      maxTokens: 1_000,
    }],
    streamSimple: (async function* () {
      yield { type: "response_start", model: "normalized-model" };
      yield { type: "text_delta", part: 0, text: "normalized response" };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "openai_responses", outputItems: [] },
      };
    }) as never,
  });

  const completion = await internal.models().completeSimple(
    internal.find("normalized-provider", "normalized-model")!,
    { messages: [] },
  );
  assert.equal(completion.text, "normalized response");
  assert.equal(completion.finishReason, "stop");
});

test("models obtained outside the registry resolve by provider and id without leaking public protocols", () => {
  const internal = new ModelRegistry(createModels());
  const registry = extensionModelRegistry(internal);
  registry.registerProvider("catalog", {
    api: "openai-completions",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    models: [{
      id: "catalog-model",
      name: "Catalog model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_000,
      maxTokens: 1_000,
    }],
    streamSimple() {
      return createAssistantMessageEventStream();
    },
  });
  const external = publicModel("openai-completions", "catalog", "catalog-model");
  assert.equal(registry.resolve(external), internal.find("catalog", "catalog-model"));
  assert.equal(registry.find("catalog", "catalog-model")?.api, "openai-completions");
});

test("successive named-provider registrations compose and preserve public model APIs", () => {
  const internal = new ModelRegistry(createModels());
  const registry = extensionModelRegistry(internal);
  registry.registerProvider("composed", {
    api: "vendor-custom-stream",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    models: [{
      id: "composed-model",
      name: "Composed model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_000,
      maxTokens: 1_000,
    }],
    streamSimple() {
      return createAssistantMessageEventStream();
    },
  });
  registry.registerProvider("composed", { headers: { "x-extension": "active" } });

  const registered = registry.getRegisteredProviderConfig("composed");
  assert.equal(registered?.api, "vendor-custom-stream");
  assert.equal(registered?.baseUrl, "https://example.test/v1");
  assert.deepEqual(registered?.headers, { "x-extension": "active" });
  assert.equal(registered?.models?.[0]?.id, "composed-model");
  assert.equal(registry.find("composed", "composed-model")?.api, "vendor-custom-stream");
  assert.equal(internal.find("composed", "composed-model")?.api, "extension-stream");
});

test("native public providers execute through the internal run-loop boundary", async () => {
  const internal = new ModelRegistry(createModels());
  const registry = extensionModelRegistry(internal);
  const model = publicModel("native-custom-api", "native-provider", "native-model");
  const provider: Provider = {
    id: "native-provider",
    name: "Native provider",
    auth: { apiKey: { name: "Test key", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
    getModels: () => [model],
    stream: (_model, _context) => responseStream(model, "native response"),
    streamSimple: (_model, _context) => responseStream(model, "native response"),
  };
  registry.registerProvider(provider);
  const internalModel = internal.find("native-provider", "native-model")!;
  assert.equal(internalModel.api, "extension-stream");
  assert.equal(registry.getProvider("native-provider"), provider);
  const completion = await internal.models().completeSimple(internalModel, { messages: [] });
  assert.equal(completion.text, "native response");
  assert.equal(registry.find("native-provider", "native-model")?.api, "native-custom-api");
});

test("OAuth credentials are normalized at both model-provider boundaries", async () => {
  const interaction = {
    prompt: async () => "",
    notify() {},
  };

  const internal = new ModelRegistry(createModels());
  const registry = extensionModelRegistry(internal);
  const publicEntry = publicModel("native-custom-api", "public-oauth-provider", "public-oauth-model");
  const publicObservedTypes: Array<"oauth" | undefined> = [];
  registry.registerProvider({
    id: publicEntry.provider,
    name: "Public OAuth provider",
    auth: {
      oauth: {
        name: "Public OAuth",
        async login() {
          return { access: "public-access", refresh: "public-refresh", expires: 1 };
        },
        async refresh(credential) {
          publicObservedTypes.push(credential.type);
          return { access: "public-access-2", refresh: credential.refresh, expires: 2 };
        },
        async toAuth(credential) {
          publicObservedTypes.push(credential.type);
          return { apiKey: credential.access };
        },
      },
    },
    getModels: () => [publicEntry],
    stream: () => responseStream(publicEntry, "public response"),
    streamSimple: () => responseStream(publicEntry, "public response"),
  });

  const internalOAuth = internal.getProvider(publicEntry.provider)!.auth.oauth!;
  assert.ok(internalOAuth.login);
  assert.ok(internalOAuth.refresh);
  const internalLogin = await internalOAuth.login(interaction);
  assert.equal(internalLogin.type, "oauth");
  const internalRefresh = await internalOAuth.refresh(internalLogin);
  assert.equal(internalRefresh.type, "oauth");
  assert.deepEqual(publicObservedTypes, ["oauth"]);
  await internalOAuth.toAuth(internalRefresh);
  assert.deepEqual(publicObservedTypes, ["oauth", "oauth"]);

  const models = createModels();
  const internalEntry = {
    id: "internal-oauth-model",
    name: "Internal OAuth model",
    api: "openai-chat-completions" as const,
    provider: "internal-oauth-provider",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 1_000,
  };
  const internalObservedTypes: "oauth"[] = [];
  models.setProvider(createProvider({
    id: internalEntry.provider,
    auth: {
      oauth: {
        name: "Internal OAuth",
        async login() {
          return { type: "oauth", access: "internal-access", refresh: "internal-refresh", expires: 1 };
        },
        async refresh(credential) {
          internalObservedTypes.push(credential.type);
          return { ...credential, access: "internal-access-2", expires: 2 };
        },
        async toAuth(credential) {
          internalObservedTypes.push(credential.type);
          return { apiKey: credential.access };
        },
      },
    },
    models: [internalEntry],
    api: {
      async *stream() {
        yield { type: "error", error: { category: "provider", message: "unused", retryable: false, partial: false } } as const;
      },
    },
  }));
  const publicOAuth = extensionModelRegistry(new ModelRegistry(models))
    .getProvider(internalEntry.provider)!.auth.oauth!;
  assert.equal((await publicOAuth.login(interaction)).type, "oauth");
  const publicRefresh = await publicOAuth.refresh({
    access: "caller-access",
    refresh: "caller-refresh",
    expires: 1,
  });
  assert.equal(publicRefresh.type, "oauth");
  await publicOAuth.toAuth({ access: "caller-access", refresh: "caller-refresh", expires: 1 });
  assert.deepEqual(internalObservedTypes, ["oauth", "oauth"]);
});

test("provider-account login preserves its real credential type at both model-provider boundaries", async () => {
  const interaction = { prompt: async () => "", notify() {} };
  const internal = new ModelRegistry(createModels());
  const registry = extensionModelRegistry(internal);
  const publicEntry = publicModel("native-custom-api", "public-account-provider", "public-account-model");
  registry.registerProvider({
    id: publicEntry.provider,
    name: "Public account provider",
    auth: {
      apiKey: {
        name: "Public account key",
        resolve: async ({ credential }) => credential?.key === undefined
          ? undefined
          : { auth: { apiKey: credential.key } },
      },
      providerAccount: {
        name: "Public browser account",
        loginLabel: "Sign in to public account",
        async login() { return { type: "api_key", key: "public-account-key" }; },
      },
    },
    getModels: () => [publicEntry],
    stream: () => responseStream(publicEntry, "public response"),
    streamSimple: () => responseStream(publicEntry, "public response"),
  });

  const internalAccount = internal.getProvider(publicEntry.provider)!.auth.providerAccount!;
  assert.equal(internalAccount.loginLabel, "Sign in to public account");
  assert.deepEqual(await internalAccount.login(interaction), {
    type: "api_key",
    key: "public-account-key",
  });

  const models = createModels();
  const internalEntry = {
    id: "internal-account-model",
    name: "Internal account model",
    api: "openai-chat-completions" as const,
    provider: "internal-account-provider",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 1_000,
  };
  models.setProvider(createProvider({
    id: internalEntry.provider,
    auth: {
      apiKey: {
        name: "Internal account key",
        resolve: async ({ credential }) => credential?.key === undefined
          ? undefined
          : { auth: { apiKey: credential.key } },
      },
      providerAccount: {
        name: "Internal local account",
        async login() { return { type: "api_key", key: "internal-account-key" }; },
      },
    },
    models: [internalEntry],
    api: {
      async *stream() {
        yield { type: "error", error: { category: "provider", message: "unused", retryable: false, partial: false } } as const;
      },
    },
  }));
  const publicAccount = extensionModelRegistry(new ModelRegistry(models))
    .getProvider(internalEntry.provider)!.auth.providerAccount!;
  assert.deepEqual(await publicAccount.login(interaction), {
    type: "api_key",
    key: "internal-account-key",
  });
});

test("internal providers exposed by the model directory retain a functional public stream", async () => {
  const models = createModels();
  let observedOptions: ProviderStreamOptions | undefined;
  let observedRequest: ProviderRequest | undefined;
  const internalModel = {
    id: "internal-model",
    name: "Internal model",
    api: "openai-chat-completions" as const,
    provider: "internal-provider",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 1_000,
  };
  models.setProvider(createProvider({
    id: "internal-provider",
    auth: { apiKey: { name: "Test key", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
    models: [internalModel],
    api: {
      async *stream(request, _signal, options) {
        observedRequest = request;
        observedOptions = options;
        yield {
          type: "response_start",
          model: "internal-model-revision",
          responseId: "internal-response",
          diagnostics: {
            status: 200,
            headers: {
              "x-request-id": "internal-request",
              authorization: "Bearer sk-proj-this-must-not-cross",
            },
          },
        } as const;
        yield { type: "reasoning_start", part: 0, visibility: "summary" } as const;
        yield { type: "reasoning_delta", part: 0, text: "visible summary", visibility: "summary" } as const;
        yield {
          type: "reasoning_end",
          part: 0,
          text: "visible summary",
          visibility: "summary",
        } as const;
        yield { type: "reasoning_start", part: 1, visibility: "provider_trace" } as const;
        yield { type: "reasoning_delta", part: 1, text: "private trace", visibility: "provider_trace" } as const;
        yield {
          type: "reasoning_end",
          part: 1,
          text: "private trace",
          visibility: "provider_trace",
        } as const;
        yield { type: "text_start", part: 1 } as const;
        yield { type: "text_delta", part: 1, text: "public response" } as const;
        yield { type: "text_end", part: 1, text: "public response", textSignature: "text-signature" } as const;
        yield {
          type: "response_end",
          reason: "stop",
          state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "public response" } },
          content: [
            { type: "thinking", thinking: "visible summary", visibility: "summary" },
            { type: "thinking", thinking: "private trace", visibility: "provider_trace" },
            { type: "text", text: "public response", textSignature: "text-signature" },
          ],
        } as const;
      },
    },
  }));
  const registry = extensionModelRegistry(new ModelRegistry(models));
  const provider = registry.getProvider("internal-provider")!;
  const exposed = provider.getModels()[0]!;
  assert.equal(exposed.api, "openai-completions");
  const stream = provider.streamSimple(exposed, {
    messages: [],
    tools: [{
      name: "grammar_output",
      description: "Return a grammar-constrained result",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
      },
      constrainedSampling: {
        type: "grammar",
        variants: { openai_regex: "[a-z]+" },
      },
    }],
  }, {
    toolChoice: { type: "function", function: { name: "grammar_output" } },
    timeoutMs: 123,
    websocketConnectTimeoutMs: 234,
    websocketIdleTimeoutMs: 345,
    maxRetries: 2,
    maxRetryDelayMs: 456,
    fetch: globalThis.fetch,
    metadata: { trace: "public-boundary" },
  });
  const publicEvents = [];
  for await (const event of stream) publicEvents.push(event);
  assert.deepEqual(publicEvents.map((event) => event.type), [
    "start",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "text_start",
    "text_delta",
    "text_end",
    "done",
  ]);
  const start = publicEvents.find((event) => event.type === "start");
  assert.equal(start?.type === "start" ? start.partial.stopReason : undefined, "pending");
  const response = await stream.result();
  assert.deepEqual(response.content, [
    { type: "thinking", thinking: "visible summary" },
    { type: "text", text: "public response", textSignature: "text-signature" },
  ]);
  assert.equal(JSON.stringify(publicEvents).includes("private trace"), false);
  assert.equal(response.responseModel, "internal-model-revision");
  assert.equal(response.responseId, "internal-response");
  assert.deepEqual(response.diagnostics?.[0]?.details, {
    response: { status: 200, headers: { "x-request-id": "internal-request" } },
    requestId: "internal-request",
  });
  assert.deepEqual(response.providerState, {
    source: { api: "openai-completions", provider: "internal-provider", model: "internal-model" },
    value: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "public response" } },
  });
  assert.equal(JSON.stringify(response.diagnostics).includes("sk-proj-this-must-not-cross"), false);
  const textEnd = publicEvents.find((event) => event.type === "text_end");
  assert.equal(textEnd?.type === "text_end" ? textEnd.contentSignature : undefined, "text-signature");
  assert.equal(response.stopReason, "stop");
  assert.equal(observedOptions?.timeoutMs, 123);
  assert.equal(observedOptions?.websocketConnectTimeoutMs, 234);
  assert.equal(observedOptions?.websocketIdleTimeoutMs, 345);
  assert.equal(observedOptions?.maxRetries, 2);
  assert.equal(observedOptions?.maxRetryDelayMs, 456);
  assert.equal(observedOptions?.fetch, globalThis.fetch);
  assert.deepEqual(observedOptions?.metadata, { trace: "public-boundary" });
  assert.deepEqual(observedRequest?.toolChoice, {
    type: "function",
    function: { name: "grammar_output" },
  });
  assert.deepEqual(observedRequest?.tools[0]?.constrainedSampling, {
    type: "grammar",
    variants: { openai_regex: "[a-z]+" },
  });
});

test("internal provider failures settle the public stream without invoking error accessors", async () => {
  const models = createModels();
  const internalModel = {
    id: "hostile-failure-model",
    name: "Hostile failure model",
    api: "openai-chat-completions" as const,
    provider: "hostile-failure-provider",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 1_000,
  };
  let inspected = 0;
  const failure = new Error("provider failed");
  Object.defineProperty(failure, "message", {
    get() {
      inspected += 1;
      return "owner-controlled message";
    },
  });
  models.setProvider(createProvider({
    id: internalModel.provider,
    auth: { apiKey: { name: "Test key", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
    models: [internalModel],
    api: {
      async *stream() {
        throw failure;
      },
    },
  }));
  const registry = extensionModelRegistry(new ModelRegistry(models));
  const provider = registry.getProvider(internalModel.provider)!;
  const model = provider.getModels()[0]!;
  const events: AssistantMessageEvent[] = [];

  for await (const event of provider.streamSimple(model, { messages: [] })) events.push(event);

  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  assert.equal(terminal?.type === "error" ? terminal.error.errorMessage : undefined, "[Thrown Error]");
  assert.equal(inspected, 0);
});

test("internal adapter streams are projected through bounded public lifecycle state", async () => {
  const models = createModels();
  const internalModel = {
    id: "projected-model",
    name: "Projected model",
    api: "openai-chat-completions" as const,
    provider: "projected-provider",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 1_000,
  };
  let queued: AdapterEvent[] = [];
  models.setProvider(createProvider({
    id: "projected-provider",
    auth: { apiKey: { name: "Test key", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
    models: [internalModel],
    api: {
      async *stream() {
        for (const event of queued) yield event;
      },
    },
  }));
  const registry = extensionModelRegistry(new ModelRegistry(models));
  const provider = registry.getProvider("projected-provider")!;
  const model = provider.getModels()[0]!;
  const project = async (): Promise<AssistantMessageEvent[]> => {
    const events: AssistantMessageEvent[] = [];
    for await (const event of provider.streamSimple(model, { messages: [] })) events.push(event);
    return events;
  };
  const failure = (events: AssistantMessageEvent[]): string => {
    const terminal = events.at(-1);
    return terminal?.type === "error" ? terminal.error.errorMessage ?? "" : "";
  };

  queued = [
    { type: "text_delta", part: 0, text: "x".repeat(3 * 1024 * 1024) },
    { type: "text_delta", part: 0, text: "y".repeat(2 * 1024 * 1024) },
  ];
  assert.match(failure(await project()), new RegExp(`text part 0 exceeds ${ASSISTANT_CONTENT_LIMITS.fieldBytes} bytes`, "u"));

  queued = Array.from({ length: ASSISTANT_CONTENT_LIMITS.blocks + 1 }, (_, part): AdapterEvent => ({
    type: "text_start",
    part,
  }));
  assert.match(
    failure(await project()),
    new RegExp(`exceeds ${ASSISTANT_CONTENT_LIMITS.blocks} (?:public content|streamed) blocks`, "u"),
  );

  let toJsonCalls = 0;
  const hostileArguments = Object.assign(Object.create({
    toJSON() {
      toJsonCalls += 1;
      return { rewritten: true };
    },
  }) as Record<string, unknown>, { original: true });
  queued = [{
    type: "tool_call_end",
    index: 0,
    id: "call",
    name: "echo",
    arguments: hostileArguments as never,
    rawArguments: "{}",
  }];
  assert.match(failure(await project()), /plain objects and (?:vanilla )?arrays/u);
  assert.equal(toJsonCalls, 0);

  let getterCalls = 0;
  const diagnostics = [{ type: "provider_notice", timestamp: 1 }] as Array<Record<string, unknown>>;
  Object.defineProperty(diagnostics[0], "message", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-run";
    },
  });
  queued = [{
    type: "response_end",
    reason: "stop",
    state: { kind: "chat_completions", assistantMessage: {} },
    assistantDiagnostics: diagnostics as never,
  }];
  assert.match(failure(await project()), /enumerable data properties/u);
  assert.equal(getterCalls, 0);

  let proxyTraps = 0;
  const state = new Proxy({ kind: "chat_completions", assistantMessage: {} }, {
    get(target, property, receiver) {
      proxyTraps += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  queued = [{ type: "response_end", reason: "stop", state: state as never }];
  assert.match(failure(await project()), /proxies/u);
  assert.equal(proxyTraps, 0);
});

function responseStream(model: Model<Api>, text: string, providerState?: ProviderState) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
      ...(providerState === undefined ? {} : {
        providerState: {
          source: { api: model.api, provider: model.provider, model: model.id },
          value: providerState,
        },
      }),
    };
    const lifecycle: AssistantMessageEvent[] = [
      { type: "start", partial: { ...message, content: [], stopReason: "pending" } },
      { type: "done", reason: "stop", message },
    ];
    for (const event of lifecycle) stream.push(event);
  });
  return stream;
}
