import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInfo, ModelProtocolFamily } from "../../src/core/types.js";
import {
  CredentialBroker,
  ExplicitCredentialSource,
  type CredentialSource,
} from "../../src/auth/index.js";
import {
  AnthropicAdapter,
  GeminiAdapter,
  GeminiInteractionsAdapter,
  GatewayMessagesAdapter,
  LlamaRouterAdapter,
  MistralAdapter,
  ProviderWireInterceptorRegistry,
} from "../../src/providers/index.js";
import {
  createProviderAdapter,
  runtimeProviderId,
  runtimeProviderProtocolFamily,
} from "../../src/service/provider-factory.js";
import { runtimeProviderModelProtocolFamily } from "../../src/service/internal-provider-protocol.js";
import { collect, request } from "../providers/helpers.js";

function configuredModel(
  id: string,
  provider: string,
  protocolFamily: ModelProtocolFamily,
): ModelInfo {
  const observedAt = "2026-07-19T00:00:00.000Z";
  return {
    id,
    provider,
    capabilities: {
      tools: { value: "supported", source: "configuration", observedAt },
      reasoning: { value: "unknown", source: "configuration", observedAt },
      images: { value: "unsupported", source: "configuration", observedAt },
    },
    compatibility: {
      protocolFamily: { value: protocolFamily, source: "configuration", observedAt },
    },
  };
}

function broker(entries: Array<[string, "api_key" | "bearer", string]> = []): CredentialBroker {
  return new CredentialBroker([
    new ExplicitCredentialSource(new Map(entries.map(([provider, kind, secret]) => [
      provider,
      kind === "api_key"
        ? { kind, provider, apiKey: secret }
        : { kind, provider, accessToken: secret },
    ]))),
  ]);
}

function blockingBroker(): { broker: CredentialBroker; started: Promise<void> } {
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const source: CredentialSource = {
    name: "blocking",
    async resolve({ signal }) {
      markStarted?.();
      signal?.throwIfAborted();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return undefined;
    },
  };
  return { broker: new CredentialBroker([source]), started };
}

test("Gemini uses stable Interactions by default with an explicit GenerateContent escape hatch", () => {
  assert.ok(createProviderAdapter({ kind: "gemini" }, broker([["gemini", "api_key", "test-key"]])) instanceof GeminiInteractionsAdapter);
  assert.ok(createProviderAdapter({ kind: "gemini", protocol: "generate-content" }, broker([["gemini", "api_key", "test-key"]])) instanceof GeminiAdapter);
});

test("cloud-backed provider factories preserve their configured protocols", () => {
  assert.equal(createProviderAdapter({ kind: "azure-openai", endpoint: "https://example.openai.azure.com" }, broker([["azure-openai", "api_key", "test-key"]])).id, "azure-openai");
  assert.equal(createProviderAdapter({ kind: "vertex", project: "project-id" }, broker([["vertex", "bearer", "test-token"]])).id, "vertex");
  assert.equal(createProviderAdapter({ kind: "bedrock", region: "us-east-1" }, broker([["bedrock", "bearer", "test-token"]])).id, "bedrock");
  assert.ok(createProviderAdapter({ kind: "mistral" }, broker([["mistral", "api_key", "test-key"]])) instanceof MistralAdapter);
  assert.equal(runtimeProviderProtocolFamily({ kind: "mistral" }), "mistral-conversations");
});

test("provider-owned model routing resolves leaf and exact routed protocols", () => {
  assert.equal(runtimeProviderModelProtocolFamily({ kind: "mistral" }, "any-model"), "mistral-conversations");
  assert.equal(runtimeProviderModelProtocolFamily({
    kind: "routed",
    id: "mixed",
    adapters: {
      chat: { kind: "openai-compatible", id: "chat", baseUrl: "https://example.test/v1" },
      responses: { kind: "openai" },
    },
    routes: [
      { model: "chat-model", adapter: "chat", protocolFamily: "openai-chat-completions" },
      { model: "response-model", adapter: "responses", protocolFamily: "openai-responses" },
    ],
  }, "response-model"), "openai-responses");
  assert.equal(runtimeProviderModelProtocolFamily({
    kind: "routed",
    id: "mixed",
    adapters: { chat: { kind: "openai-compatible", id: "chat", baseUrl: "https://example.test/v1" } },
    routes: [{ model: "known", adapter: "chat", protocolFamily: "openai-chat-completions" }],
  }, "unknown"), undefined);
});

test("llama router factory preserves its public identity, live catalog, auth, and protocol", async () => {
  let incoming: Request | undefined;
  const config = {
    kind: "llama-router" as const,
    id: "local-router",
    credentialProvider: "local-router-token",
    baseUrl: "https://router.example.test",
    timeoutMs: 2_500,
  };
  const adapter = createProviderAdapter(config, broker([["local-router-token", "bearer", "router-secret"]]), {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      incoming = input instanceof Request ? input : new Request(input, init);
      return new Response(JSON.stringify({
        data: [{ id: "loaded.gguf", status: { value: "loaded" }, meta: { n_ctx: 32_768 } }],
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });

  assert.ok(adapter instanceof LlamaRouterAdapter);
  assert.equal(runtimeProviderId(config), "local-router");
  assert.equal(runtimeProviderProtocolFamily(config), "openai-chat-completions");
  assert.deepEqual((await adapter.listModels(new AbortController().signal)).map((model) => model.id), ["loaded.gguf"]);
  assert.equal(incoming?.url, "https://router.example.test/models");
  assert.equal(incoming?.headers.get("authorization"), "Bearer router-secret");
});

test("gateway messages factory preserves public identity, bearer auth, discovery, and protocol", async () => {
  const incoming: Request[] = [];
  const config = {
    kind: "gateway-messages" as const,
    id: "company-gateway",
    gatewayUrl: "https://gateway.example.test/v1",
    credentialProvider: "company-login",
    cacheRetention: "long" as const,
  };
  const adapter = createProviderAdapter(config, broker([["company-login", "bearer", "gateway-token"]]), {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      incoming.push(request);
      return new Response(JSON.stringify({
        baseUrl: "https://messages.example.test/v1",
        models: [{
          id: "code",
          name: "Code",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_768,
          maxTokens: 4_096,
        }],
      }));
    },
  });

  assert.ok(adapter instanceof GatewayMessagesAdapter);
  assert.equal(runtimeProviderId(config), "company-gateway");
  assert.equal(runtimeProviderProtocolFamily(config), "gateway-messages");
  assert.deepEqual((await adapter.listModels(new AbortController().signal)).map((model) => model.id), ["code"]);
  assert.equal(incoming[0]?.url, "https://gateway.example.test/v1/config");
  assert.equal(incoming[0]?.headers.get("authorization"), "Bearer gateway-token");
});

test("provider factories route adapter transport through the injected wire registry", async () => {
  const wire = new ProviderWireInterceptorRegistry();
  let observedProvider: string | undefined;
  let observedAuthorization: string | undefined;
  wire.register("wire-compatible", {
    interceptRequest(request) {
      observedProvider = request.provider;
      assert.equal(request.headers.authorization, undefined);
      return { headers: { "x-wire-test": "enabled" } };
    },
  });
  const adapter = createProviderAdapter({
    kind: "openai-compatible",
    id: "wire-compatible",
    baseUrl: "https://compatible.example/v1",
  }, broker([["wire-compatible", "api_key", "provider-secret"]]), {
    wire,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      observedAuthorization = request.headers.get("authorization") ?? undefined;
      assert.equal(request.headers.get("x-wire-test"), "enabled");
      return new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } });
    },
  });

  await adapter.listModels(new AbortController().signal);
  assert.equal(observedProvider, "wire-compatible");
  assert.equal(observedAuthorization, "Bearer provider-secret");
});

test("Bedrock factory invokes wire interception once before its authentication transport", async () => {
  const wire = new ProviderWireInterceptorRegistry();
  let interceptCalls = 0;
  let transportedHeaders: Headers | undefined;
  wire.register("bedrock", {
    interceptRequest(request) {
      interceptCalls += 1;
      assert.equal(request.headers.authorization, undefined);
      return { headers: { "x-bedrock-wire": "enabled" } };
    },
  });
  const adapter = createProviderAdapter(
    { kind: "bedrock", region: "us-east-1", controlEndpoint: "https://bedrock.example" },
    broker([["bedrock", "bearer", "provider-secret"]]),
    {
      wire,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        transportedHeaders = request.headers;
        return new Response(JSON.stringify({ modelSummaries: [] }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  );

  await adapter.listModels(new AbortController().signal);

  assert.equal(interceptCalls, 1);
  assert.equal(transportedHeaders?.get("authorization"), "Bearer provider-secret");
  assert.equal(transportedHeaders?.get("x-bedrock-wire"), "enabled");
});

test("Anthropic factory forwards the legacy partial-input compatibility setting", async () => {
  let incoming: Request | undefined;
  const adapter = createProviderAdapter({
    kind: "anthropic",
    baseUrl: "https://compatible.example/v1",
    eagerToolInputStreaming: false,
  }, broker([["anthropic", "api_key", "test-key"]]), {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      incoming = input instanceof Request ? input : new Request(input, init);
      return new Response([
        `data: ${JSON.stringify({ type: "message_start", message: { id: "message", model: "model", usage: { input_tokens: 1 } } })}\n\n`,
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
        `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
  });
  assert.ok(adapter instanceof AnthropicAdapter);
  const providerRequest = request("anthropic");
  providerRequest.tools = [{ name: "read", description: "Read", inputSchema: { type: "object" } }];

  await collect(adapter.stream(providerRequest, new AbortController().signal));
  const body = await incoming!.clone().json() as { tools: Array<Record<string, unknown>> };
  assert.equal(body.tools[0]?.eager_input_streaming, undefined);
  assert.match(incoming!.headers.get("anthropic-beta") ?? "", /fine-grained-tool-streaming-2025-05-14/u);
});

test("Anthropic-compatible providers keep their public identity and independent credential binding", async () => {
  let authorization = "";
  const adapter = createProviderAdapter({
    kind: "anthropic",
    id: "custom-messages",
    credentialProvider: "custom-credential",
    baseUrl: "https://messages.example/v1",
  }, broker([["custom-credential", "api_key", "custom-secret"]]), {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const incoming = input instanceof Request ? input : new Request(input, init);
      authorization = incoming.headers.get("x-api-key") ?? "";
      return new Response([
        `data: ${JSON.stringify({ type: "message_start", message: { id: "message", model: "model", usage: { input_tokens: 1 } } })}\n\n`,
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
        `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
  });

  assert.equal(adapter.id, "custom-messages");
  await collect(adapter.stream(request("custom-messages"), new AbortController().signal));
  assert.equal(authorization, "custom-secret");
});

test("declarative routed providers use exact protocols, one credential binding, and public wire telemetry", async () => {
  const wire = new ProviderWireInterceptorRegistry();
  const observedProviders: string[] = [];
  const authorizations: Array<[string, string | null]> = [];
  wire.register("company", {
    interceptRequest(event) {
      observedProviders.push(event.provider);
    },
  });
  const adapter = createProviderAdapter({
    kind: "routed",
    id: "company",
    credentialProvider: "company-credential",
    adapters: {
      chat: {
        kind: "openai-compatible",
        id: "company-chat-wire",
        baseUrl: "https://chat.example/v1",
      },
      messages: {
        kind: "anthropic",
        id: "company-messages-wire",
        baseUrl: "https://messages.example/v1",
      },
    },
    routes: [{
      model: "fast",
      upstreamModel: "upstream-fast",
      adapter: "chat",
      protocolFamily: "openai-chat-completions",
      modelInfo: configuredModel("upstream-fast", "company-chat-wire", "openai-chat-completions"),
    }, {
      model: "deep",
      upstreamModel: "upstream-deep",
      adapter: "messages",
      protocolFamily: "anthropic-messages",
      modelInfo: configuredModel("upstream-deep", "company-messages-wire", "anthropic-messages"),
    }],
  }, broker([["company-credential", "api_key", "shared-secret"]]), {
    wire,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const incoming = input instanceof Request ? input : new Request(input, init);
      authorizations.push([
        new URL(incoming.url).hostname,
        incoming.headers.get("authorization") ?? incoming.headers.get("x-api-key"),
      ]);
      if (incoming.url.includes("/chat/completions")) {
        return new Response([
          `data: ${JSON.stringify({ id: "chat", model: "upstream-fast", choices: [{ index: 0, delta: { content: "fast" }, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response([
        `data: ${JSON.stringify({ type: "message_start", message: { id: "message", model: "upstream-deep", usage: { input_tokens: 1 } } })}\n\n`,
        `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "deep" } })}\n\n`,
        `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
        `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
  });

  assert.deepEqual((await adapter.listModels(new AbortController().signal)).map((entry) => entry.id), ["deep", "fast"]);
  for (const model of ["fast", "deep"]) {
    const providerRequest = request("company");
    providerRequest.model = model;
    const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
    assert.equal(events.at(-1)?.type, "response_end");
  }
  assert.deepEqual(authorizations, [
    ["chat.example", "Bearer shared-secret"],
    ["messages.example", "shared-secret"],
  ]);
  assert.deepEqual(observedProviders, ["company", "company"]);
});

test("declarative routed providers reject protocol mismatch and dynamic delegate protocols", () => {
  assert.throws(() => createProviderAdapter({
    kind: "routed",
    id: "company",
    adapters: { chat: { kind: "openai-compatible", baseUrl: "https://chat.example/v1" } },
    routes: [{ model: "bad", adapter: "chat", protocolFamily: "anthropic-messages" }],
  }, broker()), /declares anthropic-messages.*uses openai-chat-completions/u);
  assert.throws(() => createProviderAdapter({
    kind: "routed",
    id: "company",
    adapters: { dynamic: { kind: "github-copilot" } },
    routes: [{ model: "bad", adapter: "dynamic", protocolFamily: "openai-responses" }],
  }, broker()), /selects its protocol dynamically/u);
});

test("provider factories route discovery through an injected network transport", async () => {
  let url = "";
  const adapter = createProviderAdapter({
    kind: "openai-compatible",
    id: "proxy-fixture",
    baseUrl: "https://models.example.test/v1",
  }, broker([["proxy-fixture", "bearer", "test-token"]]), {
    fetch: (async (input: string | URL | Request) => {
      url = input instanceof Request ? input.url : String(input);
      return new Response(JSON.stringify({ data: [{ id: "model-v1" }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  assert.deepEqual((await adapter.listModels(new AbortController().signal)).map((model) => model.id), ["model-v1"]);
  assert.equal(url, "https://models.example.test/v1/models");
});

test("provider factory credential resolution stops with stream and model-list cancellation", { timeout: 2_000 }, async () => {
  {
    const blocked = blockingBroker();
    const adapter = createProviderAdapter({
      kind: "openai-compatible",
      id: "proxy-fixture",
      baseUrl: "https://models.example.test/v1",
    }, blocked.broker);
    const controller = new AbortController();
    const events = collect(adapter.stream(request("proxy-fixture"), controller.signal));
    await blocked.started;
    controller.abort();
    assert.deepEqual(await events, [{
      type: "error",
      error: {
        category: "cancelled",
        message: "Request cancelled",
        retryable: false,
        partial: false,
      },
    }]);
  }

  {
    const blocked = blockingBroker();
    const adapter = createProviderAdapter({
      kind: "openai-compatible",
      id: "proxy-fixture",
      baseUrl: "https://models.example.test/v1",
    }, blocked.broker);
    const controller = new AbortController();
    const models = adapter.listModels(controller.signal);
    await blocked.started;
    controller.abort();
    await assert.rejects(models, { name: "AbortError" });
  }
});
