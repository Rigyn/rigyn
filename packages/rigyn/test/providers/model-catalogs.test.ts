import assert from "node:assert/strict";
import test from "node:test";
import type { ModelCapability, ProviderAdapter } from "../../src/core/types.js";
import { AnthropicAdapter } from "../../src/providers/anthropic.js";
import { BedrockAdapter, type BedrockSignerContext } from "../../src/providers/bedrock.js";
import { VertexAdapter } from "../../src/providers/gemini.js";
import { OllamaAdapter } from "../../src/providers/ollama.js";
import { OpenAICompatibleAdapter, OpenRouterAdapter } from "../../src/providers/openai-compatible.js";
import { AzureOpenAIResponsesAdapter, OpenAIResponsesAdapter } from "../../src/providers/openai-responses.js";
import { fakeFetch } from "./helpers.js";

test("OpenAI and Azure Responses catalogs normalize IDs and preserve unknown capability provenance", async (t) => {
  const cases = [
    {
      name: "OpenAI",
      provider: "openai",
      url: "https://api.openai.test/v1/models",
      header: ["authorization", "Bearer offline"] as const,
      adapter: (fetch: typeof globalThis.fetch): ProviderAdapter => new OpenAIResponsesAdapter({
        baseUrl: "https://api.openai.test/v1",
        apiKey: "offline",
        fetch,
      }),
    },
    {
      name: "Azure",
      provider: "azure-openai",
      url: "https://catalog.openai.azure.com/openai/v1/models",
      header: ["api-key", "offline"] as const,
      adapter: (fetch: typeof globalThis.fetch): ProviderAdapter => new AzureOpenAIResponsesAdapter({
        endpoint: "https://catalog.openai.azure.com",
        apiKey: "offline",
        fetch,
      }),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      let requested: Request | undefined;
      const adapter = entry.adapter(fakeFetch((incoming) => {
        requested = incoming;
        return jsonResponse({
          data: [
            { id: " model-a ", object: "model", owned_by: "provider" },
            { id: "" },
            { id: "   " },
            { id: 42 },
            null,
          ],
        });
      }));

      const models = await adapter.listModels(new AbortController().signal);
      assert.equal(requested?.url, entry.url);
      assert.equal(requested?.headers.get(entry.header[0]), entry.header[1]);
      assert.deepEqual(models.map((model) => [model.id, model.provider]), [["model-a", entry.provider]]);
      assert.deepEqual(models[0]?.metadata, { id: " model-a ", object: "model", owned_by: "provider" });
      for (const capability of Object.values(models[0]!.capabilities)) assertCapability(capability, "unknown");
    });
  }
});

test("OpenAI-compatible and OpenRouter catalogs expose valid limits and provider capabilities", async (t) => {
  await t.test("custom OpenAI-compatible", async () => {
    let requested: Request | undefined;
    const adapter = new OpenAICompatibleAdapter({
      id: "local-chat",
      baseUrl: "https://local-chat.test/v1",
      apiKey: "offline",
      fetch: fakeFetch((incoming) => {
        requested = incoming;
        return jsonResponse({
          data: [
            {
              id: "local-vision",
              name: "Local Vision",
              context_length: 32_768,
              top_provider: { max_completion_tokens: 4_096 },
              supported_parameters: ["tools", "reasoning_effort"],
              architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
            },
            {
              id: "bad-limits",
              context_length: -1,
              top_provider: { max_completion_tokens: 2.5 },
              supported_parameters: ["temperature"],
              architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            },
            {
              id: "local-image-only",
              supported_parameters: [],
              architecture: { input_modalities: ["text"], output_modalities: ["image"] },
            },
            { id: "" },
            { name: "missing-id" },
          ],
        });
      }),
    });

    const models = await adapter.listModels(new AbortController().signal);
    assert.equal(requested?.url, "https://local-chat.test/v1/models");
    assert.equal(requested?.headers.get("authorization"), "Bearer offline");
    assert.deepEqual(models.map((model) => model.id), ["local-vision", "bad-limits"]);
    assert.deepEqual(
      [models[0]?.provider, models[0]?.displayName, models[0]?.contextTokens, models[0]?.maxOutputTokens],
      ["local-chat", "Local Vision", 32_768, 4_096],
    );
    assertCapability(models[0]!.capabilities.tools, "supported");
    assertCapability(models[0]!.capabilities.reasoning, "supported");
    assertCapability(models[0]!.capabilities.images, "supported");
    assert.equal(models[1]?.contextTokens, undefined);
    assert.equal(models[1]?.maxOutputTokens, undefined);
    assertCapability(models[1]!.capabilities.tools, "unsupported");
    assertCapability(models[1]!.capabilities.images, "unsupported");
  });

  await t.test("OpenRouter", async () => {
    let requested: Request | undefined;
    const adapter = new OpenRouterAdapter({
      apiKey: "offline",
      appName: "Catalog Test",
      siteUrl: "https://harness.example.test",
      promptCache: "1h",
      fetch: fakeFetch((incoming) => {
        requested = incoming;
        return jsonResponse({
          data: [
            {
              id: "router-chat",
              name: "Router Chat",
              context_length: 131_072,
              top_provider: { max_completion_tokens: 16_384 },
              supported_parameters: ["tool_choice", "reasoning"],
              reasoning: {
                mandatory: false,
                default_enabled: true,
                supported_efforts: ["low", "high"],
                default_effort: "high",
              },
              architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "image"] },
              pricing: {
                prompt: "0.0000015",
                completion: "0.000006",
                input_cache_read: "0.00000015",
                input_cache_write: "0.000001875",
                ignored_provider_field: "123",
              },
            },
            {
              id: "router-image-only",
              supported_parameters: [],
              architecture: { input_modalities: ["text"], output_modalities: ["image"] },
            },
          ],
        });
      }),
    });

    const models = await adapter.listModels(new AbortController().signal);
    assert.equal(requested?.url, "https://openrouter.ai/api/v1/models");
    assert.equal(requested?.headers.get("authorization"), "Bearer offline");
    assert.equal(requested?.headers.get("x-title"), "Catalog Test");
    assert.equal(requested?.headers.get("http-referer"), "https://harness.example.test");
    assert.deepEqual(models.map((model) => model.id), ["router-chat"]);
    assert.deepEqual([models[0]?.provider, models[0]?.contextTokens, models[0]?.maxOutputTokens], ["openrouter", 131_072, 16_384]);
    for (const capability of Object.values(models[0]!.capabilities)) assertCapability(capability, "supported");
    assert.deepEqual(models[0]?.compatibility, {
      protocolFamily: { value: "openai-chat-completions", source: "maintained", observedAt: models[0]?.compatibility?.protocolFamily?.observedAt },
      inputModalities: { value: ["text", "image"], source: "provider", observedAt: models[0]?.compatibility?.inputModalities?.observedAt },
      outputModalities: { value: ["text", "image"], source: "provider", observedAt: models[0]?.compatibility?.outputModalities?.observedAt },
      reasoningEfforts: { value: ["off", "low", "high"], source: "provider", observedAt: models[0]?.compatibility?.reasoningEfforts?.observedAt },
      strictTools: { value: "unsupported", source: "maintained", observedAt: models[0]?.compatibility?.strictTools?.observedAt },
      toolStreaming: { value: "supported", source: "maintained", observedAt: models[0]?.compatibility?.toolStreaming?.observedAt },
      cacheMode: { value: "explicit", source: "configuration", observedAt: models[0]?.compatibility?.cacheMode?.observedAt },
      cacheAffinity: { value: "prefix", source: "configuration", observedAt: models[0]?.compatibility?.cacheAffinity?.observedAt },
      cacheTiers: { value: ["1h"], source: "configuration", observedAt: models[0]?.compatibility?.cacheTiers?.observedAt },
      sessionAffinity: { value: "stateless", source: "maintained", observedAt: models[0]?.compatibility?.sessionAffinity?.observedAt },
    });
    assert.deepEqual(models[0]?.pricing, {
      currency: "USD",
      unit: "per_million_tokens",
      source: "provider",
      observedAt: models[0]?.pricing?.observedAt,
      input: 1.5,
      output: 6,
      cacheRead: 0.15,
      cacheWrite: 1.875,
    });
  });
});

test("Vercel AI Gateway catalog exposes only language models with provider metadata", async () => {
  const adapter = new OpenAICompatibleAdapter({
    id: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    profile: "vercel-ai-gateway",
    apiKey: "offline",
    fetch: fakeFetch(() => jsonResponse({
      data: [
        {
          id: "creator/coder",
          name: "Coder",
          description: "Agent model",
          type: "language",
          context_window: 262_144,
          max_tokens: 32_768,
          tags: ["tool-use", "reasoning", "vision"],
          supported_parameters: ["tools", "tool_choice", "reasoning", "include_reasoning"],
          modalities: { input: ["text", "image", "file"], output: ["text"] },
          reasoning_options: [
            { type: "toggle" },
            { type: "effort", values: ["low", "medium", "high"] },
          ],
          pricing: {
            input: "0.000001",
            output: "0.000004",
            input_cache_read: "0.0000001",
            input_cache_write: "0.00000125",
          },
        },
        {
          id: "creator/tiered",
          type: "language",
          tags: [],
          pricing: {
            input: "0.000001",
            output: "0.000004",
            input_tiers: [{ min: 0, max: 128_000, cost: "0.000001" }],
          },
        },
        { id: "creator/image", type: "image", tags: [] },
        { id: "creator/embed", type: "embedding", tags: [] },
      ],
    })),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.deepEqual(models.map((model) => model.id), ["creator/coder", "creator/tiered"]);
  assert.deepEqual({
    displayName: models[0]?.displayName,
    description: models[0]?.description,
    contextTokens: models[0]?.contextTokens,
    maxOutputTokens: models[0]?.maxOutputTokens,
    capabilities: Object.fromEntries(Object.entries(models[0]!.capabilities).map(([name, value]) => [name, value.value])),
  }, {
    displayName: "Coder",
    description: "Agent model",
    contextTokens: 262_144,
    maxOutputTokens: 32_768,
    capabilities: { tools: "supported", reasoning: "supported", images: "supported" },
  });
  assert.deepEqual(models[0]?.compatibility?.inputModalities?.value, ["text", "image", "file"]);
  assert.deepEqual(models[0]?.compatibility?.outputModalities?.value, ["text"]);
  assert.deepEqual(models[0]?.compatibility?.reasoningEfforts?.value, ["low", "medium", "high"]);
  assert.deepEqual(models[0]?.pricing, {
    currency: "USD",
    unit: "per_million_tokens",
    source: "provider",
    observedAt: models[0]?.pricing?.observedAt,
    input: 1,
    output: 4,
    cacheRead: 0.1,
    cacheWrite: 1.25,
  });
  assert.equal(models[1]?.pricing, undefined);
  for (const capability of Object.values(models[1]!.capabilities)) assertCapability(capability, "unsupported");
});

test("Vercel Messages discovery filters non-language entries and maps public model metadata", async () => {
  let requested: Request | undefined;
  const adapter = new AnthropicAdapter({
    id: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    apiKey: "offline",
    promptCache: "off",
    fetch: fakeFetch((incoming) => {
      requested = incoming;
      return jsonResponse({
        data: [
          {
            id: "creator/agent",
            name: "Agent",
            description: "Tool-capable language model",
            type: "language",
            context_window: 262_144,
            max_tokens: 32_768,
            tags: ["tool-use", "reasoning", "vision"],
            supported_parameters: ["tools", "tool_choice", "reasoning", "include_reasoning"],
            modalities: { input: ["text", "image", "file"], output: ["text"] },
            reasoning_options: [{ type: "effort", values: ["minimal", "low", "high"] }],
            pricing: { input: "0.000001", output: "0.000004" },
          },
          { id: "creator/embedding", type: "embedding", tags: [] },
          { id: "creator/image", type: "image", tags: [] },
        ],
      });
    }),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.match(requested?.url ?? "", /^https:\/\/ai-gateway\.vercel\.sh\/v1\/models\?/u);
  assert.deepEqual(models.map((model) => model.id), ["creator/agent"]);
  assert.deepEqual({
    displayName: models[0]?.displayName,
    description: models[0]?.description,
    contextTokens: models[0]?.contextTokens,
    maxOutputTokens: models[0]?.maxOutputTokens,
    capabilities: Object.fromEntries(Object.entries(models[0]!.capabilities).map(([name, value]) => [name, value.value])),
    inputModalities: models[0]?.compatibility?.inputModalities?.value,
    outputModalities: models[0]?.compatibility?.outputModalities?.value,
    reasoningEfforts: models[0]?.compatibility?.reasoningEfforts?.value,
  }, {
    displayName: "Agent",
    description: "Tool-capable language model",
    contextTokens: 262_144,
    maxOutputTokens: 32_768,
    capabilities: { tools: "supported", reasoning: "supported", images: "supported" },
    inputModalities: ["text", "image", "file"],
    outputModalities: ["text"],
    reasoningEfforts: ["minimal", "low", "high"],
  });
  assert.deepEqual(models[0]?.pricing, {
    currency: "USD",
    unit: "per_million_tokens",
    source: "provider",
    observedAt: models[0]?.pricing?.observedAt,
    input: 1,
    output: 4,
  });
  assert.equal(Object.hasOwn(models[0]!, "maxInputTokens"), false);
});

test("OpenRouter discovery honors mandatory, unrestricted, and default reasoning metadata", async () => {
  const adapter = new OpenRouterAdapter({
    apiKey: "offline",
    fetch: fakeFetch(() => jsonResponse({
      data: [
        {
          id: "mandatory",
          supported_parameters: ["reasoning"],
          reasoning: {
            mandatory: true,
            default_enabled: true,
            supported_efforts: ["minimal", "high", "none"],
            default_effort: "high",
          },
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        },
        {
          id: "unrestricted",
          supported_parameters: ["reasoning"],
          reasoning: {
            mandatory: false,
            default_enabled: false,
            supported_efforts: null,
            default_effort: "none",
          },
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        },
        {
          id: "provider-default",
          supported_parameters: ["reasoning"],
          reasoning: { mandatory: false, default_enabled: true, default_effort: "medium" },
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        },
        {
          id: "unspecified-disable",
          supported_parameters: ["reasoning"],
          reasoning: { supported_efforts: ["low", "high"], default_effort: "low" },
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        },
      ],
    })),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.deepEqual(models.map((model) => [model.id, model.compatibility?.reasoningEfforts?.value]), [
    ["mandatory", ["minimal", "high"]],
    ["unrestricted", ["off", "minimal", "low", "medium", "high", "xhigh", "max"]],
    ["provider-default", undefined],
    ["unspecified-disable", ["low", "high"]],
  ]);
  assert.equal(models[2]?.capabilities.reasoning.value, "supported");
  assert.deepEqual((models[2]?.metadata as { reasoning?: unknown }).reasoning, {
    mandatory: false,
    default_enabled: true,
    default_effort: "medium",
  });
});

test("NVIDIA discovery filters explicit and unmistakable non-chat model entries", async () => {
  const adapter = new OpenAICompatibleAdapter({
    id: "nvidia",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: "offline",
    fetch: fakeFetch(() => jsonResponse({
      data: [
        { id: "nvidia/chat", type: "language" },
        { id: "nvidia/custom-embed-name", type: "language" },
        { id: "nvidia/ordinary-name", type: "embedding" },
        { id: "nvidia/nv-embed-v1" },
        { id: "nvidia/nemotron-4-340b-reward" },
        { id: "meta/llama-3.3-70b-instruct" },
        { id: "nvidia/task-advertised", supported_tasks: ["embedding"] },
        { id: "nvidia/task-chat", supported_tasks: ["chat", "embedding"] },
      ],
    })),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.deepEqual(models.map((model) => model.id), [
    "nvidia/chat",
    "nvidia/custom-embed-name",
    "meta/llama-3.3-70b-instruct",
    "nvidia/task-chat",
  ]);
});

test("Ollama catalog filters embedding-only models and reads context metadata", async () => {
  const showRequests: string[] = [];
  const adapter = new OllamaAdapter({
    apiKey: "offline",
    fetch: fakeFetch(async (incoming) => {
      if (incoming.url.endsWith("/api/tags")) {
        assert.equal(incoming.headers.get("authorization"), "Bearer offline");
        return jsonResponse({
          models: [
            { model: "vision:latest", name: "vision:latest", size: 1 },
            { model: "embedding:latest", name: "embedding:latest" },
            { model: "", name: "fallback:latest" },
            { model: 42 },
          ],
        });
      }
      assert.ok(incoming.url.endsWith("/api/show"));
      const body = await incoming.json() as { model: string };
      showRequests.push(body.model);
      if (body.model === "vision:latest") {
        return jsonResponse({
          capabilities: ["completion", "tools", "vision"],
          model_info: { "general.architecture": "gemma3", "gemma3.context_length": 8_192 },
        });
      }
      if (body.model === "embedding:latest") return jsonResponse({ capabilities: ["embedding"] });
      return jsonResponse({ error: "show unavailable" }, 500);
    }),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.deepEqual(showRequests.sort(), ["embedding:latest", "fallback:latest", "vision:latest"]);
  assert.deepEqual(models.map((model) => [model.id, model.provider]), [
    ["vision:latest", "ollama"],
    ["fallback:latest", "ollama"],
  ]);
  assert.equal(models[0]?.contextTokens, 8_192);
  assertCapability(models[0]!.capabilities.tools, "supported");
  assertCapability(models[0]!.capabilities.reasoning, "unsupported");
  assertCapability(models[0]!.capabilities.images, "supported");
  assert.equal((models[1]?.metadata as { show?: unknown }).show, undefined);
  for (const capability of Object.values(models[1]!.capabilities)) assertCapability(capability, "unknown");
});

test("Ollama bounds concurrent show lookups to eight", async () => {
  let active = 0;
  let maximum = 0;
  const adapter = new OllamaAdapter({
    fetch: fakeFetch(async (incoming) => {
      if (incoming.url.endsWith("/api/tags")) {
        return jsonResponse({ models: Array.from({ length: 9 }, (_, index) => ({ model: `model-${index}` })) });
      }
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return jsonResponse({ capabilities: ["completion"] });
    }),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.equal(models.length, 9);
  assert.equal(maximum, 8);
});

test("Vertex catalog uses Publisher Models discovery, pages, and preserves official metadata", async () => {
  const urls: string[] = [];
  const headers: Headers[] = [];
  const adapter = new VertexAdapter({
    project: "offline-project",
    location: "global",
    accessToken: "offline",
    userProject: "quota-project",
    fetch: fakeFetch((incoming) => {
      urls.push(incoming.url);
      headers.push(incoming.headers);
      const pageToken = new URL(incoming.url).searchParams.get("pageToken");
      return jsonResponse(pageToken === null
        ? {
            publisherModels: [
              {
                name: "publishers/google/models/gemini-first",
                versionId: "001",
                launchStage: "GA",
                supportedActions: { openGenerationAiStudio: { title: "Vertex AI Studio" } },
              },
              { name: "publishers/google/models/gemini-embedding-001" },
              { name: "publishers/google/models/imagen-4.0-generate-001" },
              { name: "publishers/google/models/" },
            ],
            nextPageToken: "next-page",
          }
        : {
            publisherModels: [
              {
                name: "models/gemini-second",
                versionId: "002",
                versionState: "VERSION_STATE_STABLE",
              },
              { name: 42 },
              null,
            ],
          });
    }),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.equal(new URL(urls[0]!).pathname, "/v1beta1/publishers/google/models");
  assert.equal(new URL(urls[0]!).searchParams.get("pageSize"), "1000");
  assert.equal(new URL(urls[1]!).searchParams.get("pageToken"), "next-page");
  assert.equal(headers[0]?.get("authorization"), "Bearer offline");
  assert.equal(headers[0]?.get("x-goog-user-project"), "quota-project");
  assert.deepEqual(models.map((model) => [model.id, model.provider]), [
    ["gemini-first", "vertex"],
    ["gemini-second", "vertex"],
  ]);
  assert.deepEqual(models[0]?.metadata, {
    name: "publishers/google/models/gemini-first",
    versionId: "001",
    launchStage: "GA",
    supportedActions: { openGenerationAiStudio: { title: "Vertex AI Studio" } },
  });
  for (const model of models) {
    for (const capability of Object.values(model.capabilities)) assertCapability(capability, "unknown");
  }
});

test("Vertex catalog rejects repeated page tokens", async () => {
  const adapter = new VertexAdapter({
    project: "offline-project",
    accessToken: "offline",
    fetch: fakeFetch(() => jsonResponse({ publisherModels: [], nextPageToken: "repeat" })),
  });
  await assert.rejects(adapter.listModels(new AbortController().signal), /repeated a page token/u);
});

test("Bedrock catalog requests text-output models and preserves image capability evidence", async () => {
  let requested: Request | undefined;
  let signerContext: BedrockSignerContext | undefined;
  const adapter = new BedrockAdapter({
    region: "ca-central-1",
    signer: (unsigned, context) => {
      signerContext = context;
      return unsigned;
    },
    fetch: fakeFetch((incoming) => {
      requested = incoming;
      return jsonResponse({
        modelSummaries: [
          {
            modelId: "anthropic.claude-opus-4-6-v1",
            modelName: "Claude Opus 4.6",
            inputModalities: ["TEXT", "IMAGE"],
            outputModalities: ["TEXT"],
          },
          {
            modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
            modelName: "Claude Sonnet 4.5",
            inputModalities: ["TEXT"],
            outputModalities: ["TEXT"],
          },
          {
            modelId: "amazon.nova-2-lite-v1:0",
            modelName: "Nova 2 Lite",
            inputModalities: ["TEXT"],
            outputModalities: ["TEXT"],
          },
          {
            modelId: "anthropic.claude-unverified-v1:0",
            modelName: "Claude Unverified",
            inputModalities: ["TEXT"],
            outputModalities: ["TEXT"],
          },
          { modelId: "embed-only", inputModalities: ["TEXT"], outputModalities: ["EMBEDDING"] },
          { modelId: "unknown-output", inputModalities: ["TEXT"] },
          { modelId: "" },
          { modelId: 42 },
        ],
      });
    }),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.equal(new URL(requested!.url).pathname, "/foundation-models");
  assert.equal(new URL(requested!.url).searchParams.get("byOutputModality"), "TEXT");
  assert.deepEqual(signerContext, { region: "ca-central-1", service: "bedrock", target: "control" });
  assert.deepEqual(models.map((model) => [model.id, model.provider, model.displayName]), [
    ["anthropic.claude-opus-4-6-v1", "bedrock", "Claude Opus 4.6"],
    ["anthropic.claude-sonnet-4-5-20250929-v1:0", "bedrock", "Claude Sonnet 4.5"],
    ["amazon.nova-2-lite-v1:0", "bedrock", "Nova 2 Lite"],
    ["anthropic.claude-unverified-v1:0", "bedrock", "Claude Unverified"],
    ["unknown-output", "bedrock", undefined],
  ]);
  assertCapability(models[0]!.capabilities.tools, "unknown");
  assert.equal(models[0]!.capabilities.reasoning.value, "supported");
  assert.equal(models[0]!.capabilities.reasoning.source, "maintained");
  assert.equal(Number.isNaN(Date.parse(models[0]!.capabilities.reasoning.observedAt)), false);
  assertCapability(models[0]!.capabilities.images, "supported");
  assert.deepEqual(models[0]!.compatibility?.reasoningEfforts?.value, ["low", "medium", "high", "max"]);
  assert.equal(models[1]!.capabilities.reasoning.value, "supported");
  assert.equal(models[1]!.capabilities.reasoning.source, "maintained");
  assert.equal(Number.isNaN(Date.parse(models[1]!.capabilities.reasoning.observedAt)), false);
  assert.deepEqual(models[1]!.compatibility?.reasoningEfforts?.value, [
    "off", "minimal", "low", "medium", "high", "xhigh", "max",
  ]);
  assertCapability(models[2]!.capabilities.reasoning, "unknown");
  assert.equal(models[2]!.compatibility?.reasoningEfforts, undefined);
  assertCapability(models[3]!.capabilities.reasoning, "unknown");
  assert.equal(models[3]!.compatibility?.reasoningEfforts, undefined);
  assertCapability(models[4]!.capabilities.images, "unsupported");
});

test("native catalog adapters propagate cancellation to their first request", async (t) => {
  const cases: Array<{ name: string; adapter: (fetch: typeof globalThis.fetch) => ProviderAdapter }> = [
    { name: "OpenAI Responses", adapter: (fetch) => new OpenAIResponsesAdapter({ baseUrl: "https://openai.test/v1", fetch }) },
    { name: "Azure Responses", adapter: (fetch) => new AzureOpenAIResponsesAdapter({ endpoint: "https://azure.test", fetch }) },
    { name: "OpenAI-compatible", adapter: (fetch) => new OpenAICompatibleAdapter({ baseUrl: "https://chat.test/v1", fetch }) },
    { name: "OpenRouter", adapter: (fetch) => new OpenRouterAdapter({ fetch }) },
    { name: "Ollama", adapter: (fetch) => new OllamaAdapter({ fetch }) },
    { name: "Vertex", adapter: (fetch) => new VertexAdapter({ project: "offline", fetch }) },
    {
      name: "Bedrock",
      adapter: (fetch) => new BedrockAdapter({ region: "us-east-1", signer: (unsigned) => unsigned, fetch }),
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      let sawAbortedSignal = false;
      const adapter = entry.adapter(fakeFetch((incoming) => {
        sawAbortedSignal = incoming.signal.aborted;
        throw new DOMException("cancelled", "AbortError");
      }));
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(adapter.listModels(controller.signal), { name: "AbortError" });
      assert.equal(sawAbortedSignal, true);
    });
  }
});

function assertCapability(capability: ModelCapability, value: ModelCapability["value"]): void {
  assert.equal(capability.value, value);
  assert.equal(capability.source, "provider");
  assert.equal(Number.isNaN(Date.parse(capability.observedAt)), false);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
