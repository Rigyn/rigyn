import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInfo, ModelProtocolFamily } from "../../src/core/types.js";
import {
  CredentialBroker,
  EnvironmentCredentialSource,
  ExplicitCredentialSource,
  type CredentialSource,
} from "../../src/auth/index.js";
import {
  AnthropicAdapter,
  GeminiAdapter,
  GeminiInteractionsAdapter,
  ProviderWireInterceptorRegistry,
} from "../../src/providers/index.js";
import {
  OPENAI_CODEX_TRANSPORT_OBSERVER,
  type OpenAICodexTransportObservation,
} from "../../src/providers/openai-codex-observability.js";
import { createProviderAdapter } from "../../src/service/provider-factory.js";
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
});

test("GitHub Copilot inference ignores stored host metadata and honors only trusted host configuration", async () => {
  const credentials = new CredentialBroker([new ExplicitCredentialSource(new Map([[
    "github-copilot",
    {
      kind: "oauth" as const,
      provider: "github-copilot",
      accessToken: "copilot-service-token",
      refreshToken: "github-source-token",
      expiresAt: Date.now() + 60 * 60_000,
      tokenType: "Bearer",
      scopes: [],
      providerData: { enterpriseHost: "attacker.invalid" },
    },
  ]]))]);
  const requests: string[] = [];
  const fetchImplementation = async (input: string | URL | Request): Promise<Response> => {
    requests.push(String(input));
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const cases = [
    {
      config: { kind: "github-copilot" as const },
      environment: {},
      endpoint: "https://api.individual.githubcopilot.com/models",
    },
    {
      config: { kind: "github-copilot" as const },
      environment: { COPILOT_GH_HOST: "environment.ghe.com" },
      endpoint: "https://copilot-api.environment.ghe.com/models",
    },
    {
      config: { kind: "github-copilot" as const, host: "configured.ghe.com" },
      environment: { COPILOT_GH_HOST: "environment.ghe.com" },
      endpoint: "https://copilot-api.configured.ghe.com/models",
    },
  ];
  for (const selected of cases) {
    const adapter = createProviderAdapter(selected.config, credentials, {
      fetch: fetchImplementation,
      environment: selected.environment,
    });
    assert.deepEqual(await adapter.listModels(new AbortController().signal), []);
  }

  assert.deepEqual(requests, cases.map((selected) => selected.endpoint));
  assert.equal(requests.some((request) => request.includes("attacker.invalid")), false);
});

test("Anthropic factory distinguishes stored OAuth from ordinary bearer credentials", async () => {
  const credentials = new CredentialBroker([new ExplicitCredentialSource(new Map([[
    "anthropic",
    {
      kind: "oauth" as const,
      provider: "anthropic",
      accessToken: "approved-oauth-access",
      refreshToken: "approved-oauth-refresh",
      expiresAt: Date.now() + 60_000,
      tokenType: "Bearer",
      scopes: [],
    },
  ]]))]);
  let incoming: Request | undefined;
  const adapter = createProviderAdapter({ kind: "anthropic" }, credentials, {
    fetch: async (input, init) => {
      incoming = input instanceof Request ? input : new Request(input, init);
      return new Response([
        `data: ${JSON.stringify({ type: "message_start", message: { id: "message", model: "model", usage: { input_tokens: 1 } } })}\n\n`,
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
        `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });

  const events = await collect(adapter.stream(request("anthropic"), new AbortController().signal));

  assert.equal(events.at(-1)?.type, "response_end");
  assert.equal(incoming?.headers.get("authorization"), "Bearer approved-oauth-access");
  assert.equal(incoming?.headers.get("x-app"), "cli");
  assert.match(incoming?.headers.get("anthropic-beta") ?? "", /oauth-2025-04-20/u);
});

test("Vertex factory forwards a stored API key to Publisher Models discovery", async () => {
  let incoming: Request | undefined;
  const adapter = createProviderAdapter(
    { kind: "vertex", project: "project-id" },
    broker([["vertex", "api_key", "test-key"]]),
    {
      fetch: async (input, init) => {
        incoming = input instanceof Request ? input : new Request(input, init);
        return new Response(JSON.stringify({ publisherModels: [] }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  );

  await adapter.listModels(new AbortController().signal);

  assert.equal(incoming?.headers.get("x-goog-api-key"), "test-key");
  assert.equal(incoming?.headers.get("authorization"), null);
});

test("Vertex factory accepts an extension-provided environment credential mapping", async () => {
  let incoming: Request | undefined;
  const environment = { GOOGLE_CLOUD_API_KEY: "environment-key" };
  const adapter = createProviderAdapter(
    { kind: "vertex", project: "project-id" },
    new CredentialBroker([new EnvironmentCredentialSource({
      environment,
      specs: { vertex: { variable: "GOOGLE_CLOUD_API_KEY" } },
    })]),
    {
      environment,
      fetch: async (input, init) => {
        incoming = input instanceof Request ? input : new Request(input, init);
        return new Response(JSON.stringify({ publisherModels: [] }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  );

  await adapter.listModels(new AbortController().signal);

  assert.equal(incoming?.headers.get("x-goog-api-key"), "environment-key");
  assert.equal(incoming?.headers.get("authorization"), null);
});

test("provider-owned model routing resolves leaf and exact routed protocols", () => {
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

test("the provider factory preserves the internal Codex transport observer", async () => {
  const observations: OpenAICodexTransportObservation[] = [];
  const credentials = new CredentialBroker([new ExplicitCredentialSource(new Map([[
    "openai-codex",
    {
      kind: "oauth" as const,
      provider: "openai-codex",
      accessToken: "subscription-access",
      expiresAt: Date.now() + 60_000,
      tokenType: "Bearer",
      scopes: [],
      accountId: "chatgpt-account",
    },
  ]]))]);
  const options = {
    fetch: (async () => new Response([
      `data: ${JSON.stringify({ type: "response.created", response: { id: "response", model: "gpt-5.5" } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "response", model: "gpt-5.5", output: [], usage: {} } })}\n\n`,
    ].join(""), { headers: { "content-type": "text/event-stream" } })) as typeof fetch,
    [OPENAI_CODEX_TRANSPORT_OBSERVER]: (observation: OpenAICodexTransportObservation) => {
      observations.push(observation);
    },
  };
  const adapter = createProviderAdapter({ kind: "openai-codex", transport: "sse" }, credentials, options);

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));
  await adapter.dispose?.();

  assert.equal(events.at(-1)?.type, "response_end");
  assert.deepEqual(observations, [{ type: "selected", transport: "sse", sessionFallbackUsed: false }]);
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

test("declarative routed providers reject protocol mismatch, dynamic delegate protocols, and unknown catalog adapters", () => {
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
  assert.throws(() => createProviderAdapter({
    kind: "routed",
    id: "company",
    catalogAdapter: "missing",
    adapters: { chat: { kind: "openai-compatible", baseUrl: "https://chat.example/v1" } },
    routes: [{ model: "known", adapter: "chat", protocolFamily: "openai-chat-completions" }],
  }, broker()), /catalog adapter is unknown: missing/u);
});

test("routed catalog delegates filter exact maintained routes and preserve failure, cancellation, and disposal", async () => {
  let catalogRequest: Request | undefined;
  const adapter = createProviderAdapter({
    kind: "routed",
    id: "company",
    credentialProvider: "company-credential",
    catalogAdapter: "chat",
    adapters: { chat: { kind: "openai-compatible", baseUrl: "https://chat.example/v1" } },
    routes: [
      {
        model: "active",
        adapter: "chat",
        protocolFamily: "openai-chat-completions",
        modelInfo: configuredModel("active", "company", "openai-chat-completions"),
      },
      {
        model: "retired",
        adapter: "chat",
        protocolFamily: "openai-chat-completions",
        modelInfo: configuredModel("retired", "company", "openai-chat-completions"),
      },
    ],
  }, broker([["company-credential", "api_key", "catalog-secret"]]), {
    fetch: async (input, init) => {
      catalogRequest = input instanceof Request && init === undefined ? input : new Request(input, init);
      return new Response(JSON.stringify({ data: [{ id: "active" }, { id: "new-without-route" }] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepEqual((await adapter.listModels(new AbortController().signal)).map((model) => model.id), ["active"]);
  assert.equal(catalogRequest?.url, "https://chat.example/v1/models");
  assert.equal(catalogRequest?.headers.get("authorization"), "Bearer catalog-secret");
  await adapter.dispose?.();

  for (const mode of ["failure", "abort"] as const) {
    const blocked = createProviderAdapter({
      kind: "routed",
      id: `company-${mode}`,
      catalogAdapter: "chat",
      adapters: { chat: { kind: "openai-compatible", baseUrl: "https://chat.example/v1" } },
      routes: [{ model: "active", adapter: "chat", protocolFamily: "openai-chat-completions" }],
    }, broker([[`company-${mode}`, "api_key", "secret"]]), {
      fetch: mode === "failure"
        ? async () => new Response("unavailable", { status: 503 })
        : async (_input, init) => await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          }),
    });
    const controller = new AbortController();
    const listing = blocked.listModels(controller.signal);
    if (mode === "abort") controller.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects(
      listing,
      mode === "failure" ? { name: "HttpResponseError", status: 503 } : { name: "AbortError" },
    );
    await blocked.dispose?.();
  }
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
