import assert from "node:assert/strict";
import test from "node:test";

import { createAssistantMessageEventStream, type Api, type Context, type Model, type Provider } from "@rigyn/models";

import { projectMessagesForProvider } from "../../src/context/projection.js";
import type { AdapterEvent, CanonicalMessage, ModelProtocolFamily, ProviderRequest, ProviderState } from "../../src/core/types.js";
import {
  extensionModelRegistry,
  protocolFromPublicApi,
  publicApiFromProtocol,
  streamFunctionAdapterEvents,
} from "../../src/extensions/model-boundary.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import { createModels, createProvider } from "../../src/providers/models.js";

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

test("model boundary translates canonical APIs and uses a bounded carrier for custom APIs", () => {
  const protocolNames: ModelProtocolFamily[] = [
    "anthropic-messages",
    "bedrock-converse",
    "gateway-messages",
    "gemini-generate-content",
    "gemini-interactions",
    "mistral-conversations",
    "ollama-chat",
    "openai-chat-completions",
    "openai-responses",
  ];
  for (const protocol of protocolNames) assert.equal(protocolFromPublicApi(protocol), protocol);

  assert.equal(protocolFromPublicApi("openai-completions"), "openai-chat-completions");
  assert.equal(protocolFromPublicApi("google-generative-ai"), "gemini-generate-content");
  assert.equal(publicApiFromProtocol("bedrock-converse"), "bedrock-converse-stream");
  assert.equal(protocolFromPublicApi("vendor-custom-stream"), "gateway-messages");
});

test("public streams produce protocol-matching continuation state for every core model family", async () => {
  const cases: Array<{ publicApi: Api; protocol: ModelProtocolFamily; kind: ProviderState["kind"] }> = [
    { publicApi: "openai-responses", protocol: "openai-responses", kind: "openai_responses" },
    { publicApi: "openai-completions", protocol: "openai-chat-completions", kind: "chat_completions" },
    { publicApi: "anthropic-messages", protocol: "anthropic-messages", kind: "anthropic_messages" },
    { publicApi: "google-generative-ai", protocol: "gemini-generate-content", kind: "gemini_generate_content" },
    { publicApi: "gemini-interactions", protocol: "gemini-interactions", kind: "gemini_interactions" },
    { publicApi: "bedrock-converse-stream", protocol: "bedrock-converse", kind: "bedrock_converse" },
    { publicApi: "mistral-conversations", protocol: "mistral-conversations", kind: "mistral_chat" },
    { publicApi: "ollama-chat", protocol: "ollama-chat", kind: "ollama_chat" },
    { publicApi: "rigyn-messages", protocol: "gateway-messages", kind: "gateway_messages" },
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
    },
    new AbortController().signal,
    () => responseStream(model, "visible response", explicit),
  ));
  const terminal = events.find((event): event is Extract<AdapterEvent, { type: "response_end" }> => event.type === "response_end");
  assert.deepEqual(terminal?.state, {
    ...explicit,
    source: { provider: model.provider, model: model.id, api: "anthropic-messages" },
  });
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
          reasoningFormat: "zai",
          zaiToolStream: true,
          supportsStrictMode: false,
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
          sessionAffinityFormat: "openai-nosession",
          supportsLongCacheRetention: false,
        },
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
    reasoningFormat: "zai",
    zaiToolStream: true,
    supportsStrictMode: false,
    deferredToolsMode: "kimi",
    supportsLongCacheRetention: false,
  });
  assert.deepEqual(internal.find("compatibility-provider", "responses-model")?.compat, {
    supportsDeveloperRole: true,
    supportsToolSearch: true,
    sessionAffinityFormat: "openai-nosession",
    supportsLongCacheRetention: false,
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
  });
});

test("extension registry preserves a custom public API while the core runs its carrier protocol", async () => {
  const internal = new ModelRegistry(createModels());
  const registry = extensionModelRegistry(internal);
  let observedApi: Api | undefined;
  let observedPrompt: string | undefined;

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
    streamSimple(model, context) {
      observedApi = model.api;
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
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 5,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    },
  });

  const internalModel = internal.find("extension-provider", "extension-model");
  assert.equal(internalModel?.api, "gateway-messages");
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
  });
  assert.equal(observedApi, "vendor-custom-stream");
  assert.equal(observedPrompt, "hello boundary");
  assert.equal(completion.text, "custom response");
  assert.equal(completion.finishReason, "stop");
  assert.equal(completion.usage?.totalTokens, 5);
});

test("registered providers receive every signed assistant block on same-source replay", async () => {
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
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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
  const terminal = first.find((event): event is AdapterEvent & { type: "response_end" } => event.type === "response_end");
  assert.ok(terminal?.content);
  const signedMessage: CanonicalMessage = {
    id: "signed-message",
    role: "assistant",
    provider: "signed-provider",
    model: "model-a",
    api: "gateway-messages",
    publicApi: "signed-stream",
    content: terminal.content,
    createdAt: "2026-07-21T00:00:00.000Z",
    stopReason: "stop",
  };

  const same = projectMessagesForProvider([signedMessage], "signed-provider", {
    model: "model-a",
    api: "gateway-messages",
  });
  await collectEvents(internal.models().streamSimple(modelA, { messages: same }));
  const replay = observed[1]?.messages[0];
  assert.equal(replay?.role, "assistant");
  assert.deepEqual(replay?.role === "assistant" ? replay.content : undefined, [
    { type: "thinking", thinking: "private plan", thinkingSignature: "thinking-signature", redacted: false },
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
    api: "gateway-messages",
  });
  await collectEvents(internal.models().streamSimple(modelB, { messages: switched }));
  const portable = observed[2]?.messages[0];
  assert.equal(portable?.role, "assistant");
  assert.deepEqual(portable?.role === "assistant" ? portable.content : undefined, [
    { type: "text", text: "private plan" },
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
  assert.equal(internal.find("composed", "composed-model")?.api, "gateway-messages");
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
  assert.equal(internalModel.api, "gateway-messages");
  assert.equal(registry.getProvider("native-provider"), provider);
  const completion = await internal.models().completeSimple(internalModel, { messages: [] });
  assert.equal(completion.text, "native response");
  assert.equal(registry.find("native-provider", "native-model")?.api, "native-custom-api");
});

test("internal providers exposed by the model directory retain a functional public stream", async () => {
  const models = createModels();
  const internalModel = {
    id: "internal-model",
    name: "Internal model",
    api: "openai-chat-completions" as const,
    provider: "internal-provider",
    baseUrl: "https://example.test/v1",
    reasoning: false,
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
      async *stream() {
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
        yield { type: "text_start", part: 0 } as const;
        yield { type: "text_delta", part: 0, text: "public response" } as const;
        yield { type: "text_end", part: 0, text: "public response", textSignature: "text-signature" } as const;
        yield {
          type: "response_end",
          reason: "stop",
          state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "public response" } },
          content: [{ type: "text", text: "public response", textSignature: "text-signature" }],
        } as const;
      },
    },
  }));
  const registry = extensionModelRegistry(new ModelRegistry(models));
  const provider = registry.getProvider("internal-provider")!;
  const exposed = provider.getModels()[0]!;
  assert.equal(exposed.api, "openai-completions");
  const stream = provider.streamSimple(exposed, { messages: [] });
  const publicEvents = [];
  for await (const event of stream) publicEvents.push(event);
  assert.deepEqual(publicEvents.map((event) => event.type), ["start", "text_start", "text_delta", "text_end", "done"]);
  const response = await stream.result();
  assert.equal(response.content[0]?.type, "text");
  assert.equal(response.content[0]?.type === "text" ? response.content[0].text : undefined, "public response");
  assert.equal(response.content[0]?.type === "text" ? response.content[0].textSignature : undefined, "text-signature");
  assert.equal(response.responseModel, "internal-model-revision");
  assert.equal(response.responseId, "internal-response");
  assert.deepEqual(response.diagnostics?.[0]?.details, {
    response: { status: 200, headers: { "x-request-id": "internal-request" } },
    requestId: "internal-request",
  });
  assert.equal(JSON.stringify(response.diagnostics).includes("sk-proj-this-must-not-cross"), false);
  const textEnd = publicEvents.find((event) => event.type === "text_end");
  assert.equal(textEnd?.type === "text_end" ? textEnd.contentSignature : undefined, "text-signature");
  assert.equal(response.stopReason, "stop");
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
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "done", reason: "stop", message });
  });
  return stream;
}
