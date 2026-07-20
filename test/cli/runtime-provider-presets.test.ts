import assert from "node:assert/strict";
import test from "node:test";

import { CredentialBroker, ExplicitCredentialSource } from "../../src/auth/index.js";
import {
  BUILTIN_PROVIDER_CONFIGS,
  registerCloudflareWireInterceptors,
} from "../../src/cli/runtime.js";
import { ProviderWireInterceptorRegistry } from "../../src/providers/index.js";
import { createProviderAdapter } from "../../src/service/provider-factory.js";
import { collect, request } from "../providers/helpers.js";

test("built-in compatible provider presets use their documented model endpoints and credentials", async () => {
  const endpoints = {
    groq: "https://api.groq.com/openai/v1/models",
    together: "https://api.together.ai/v1/models",
    deepseek: "https://api.deepseek.com/models",
    cerebras: "https://api.cerebras.ai/v1/models",
    fireworks: "https://api.fireworks.ai/inference/v1/models",
    huggingface: "https://router.huggingface.co/v1/models",
    "vercel-ai-gateway": "https://ai-gateway.vercel.sh/v1/models",
    zai: "https://api.z.ai/api/coding/paas/v4/models",
    "zai-coding-cn": "https://open.bigmodel.cn/api/coding/paas/v4/models",
    "ant-ling": "https://api.ant-ling.com/v1/models",
    nvidia: "https://integrate.api.nvidia.com/v1/models",
    xiaomi: "https://api.xiaomimimo.com/v1/models",
    moonshotai: "https://api.moonshot.ai/v1/models",
    "moonshotai-cn": "https://api.moonshot.cn/v1/models",
    "xiaomi-token-plan-cn": "https://token-plan-cn.xiaomimimo.com/v1/models",
    "xiaomi-token-plan-ams": "https://token-plan-ams.xiaomimimo.com/v1/models",
    "xiaomi-token-plan-sgp": "https://token-plan-sgp.xiaomimimo.com/v1/models",
  } as const;
  const credentials = new Map(Object.keys(endpoints).map((provider) => [
    provider,
    { kind: "api_key" as const, provider, apiKey: `fixture-${provider}` },
  ]));
  const broker = new CredentialBroker([new ExplicitCredentialSource(credentials)]);

  for (const [provider, endpoint] of Object.entries(endpoints)) {
    const config = BUILTIN_PROVIDER_CONFIGS[provider];
    assert.equal(config?.kind, "openai-compatible");
    const modelId = provider === "xiaomi" || provider.startsWith("xiaomi-token-plan-")
      ? "mimo-v2.5-pro"
      : `${provider}-model`;
    let requestedUrl = "";
    let authorization: string | null = null;
    const adapter = createProviderAdapter(config!, broker, {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestedUrl = request.url;
        authorization = request.headers.get("authorization");
        return new Response(JSON.stringify({
          data: [{ id: modelId, ...(provider === "vercel-ai-gateway" ? { type: "language" } : {}) }],
        }), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    assert.deepEqual((await adapter.listModels(new AbortController().signal)).map((model) => model.id), [modelId]);
    assert.equal(requestedUrl, endpoint);
    assert.equal(authorization, `Bearer fixture-${provider}`);
  }
});

test("xAI routes each maintained model through its declared wire protocol", async () => {
  const config = BUILTIN_PROVIDER_CONFIGS.xai;
  assert.equal(config?.kind, "routed");
  if (config?.kind !== "routed") throw new Error("Expected routed xAI provider");
  assert.deepEqual(config.routes.map((route) => [route.model, route.protocolFamily]), [
    ["grok-4.3", "openai-chat-completions"],
    ["grok-4.5", "openai-responses"],
    ["grok-build-0.1", "openai-chat-completions"],
  ]);

  const broker = new CredentialBroker([new ExplicitCredentialSource(new Map([
    ["xai", { kind: "api_key" as const, provider: "xai", apiKey: "fixture-xai" }],
  ]))]);
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const adapter = createProviderAdapter(config, broker, {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push({ url: request.url, authorization: request.headers.get("authorization") });
      return new Response(JSON.stringify({
        data: [{ id: "grok-4.3" }, { id: "grok-4.5" }, { id: "grok-build-0.1" }],
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  assert.deepEqual((await adapter.listModels(new AbortController().signal)).map((model) => model.id), [
    "grok-4.3",
    "grok-4.5",
    "grok-build-0.1",
  ]);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.url === "https://api.x.ai/v1/models"));
  assert.ok(requests.every((request) => request.authorization === "Bearer fixture-xai"));
});

test("Kimi and MiniMax coding presets use their Anthropic Messages model endpoints", async () => {
  const endpoints = {
    "kimi-coding": "https://api.kimi.com/coding/models?limit=100",
    minimax: "https://api.minimax.io/anthropic/models?limit=100",
    "minimax-cn": "https://api.minimaxi.com/anthropic/models?limit=100",
  } as const;
  const credentials = new Map(Object.keys(endpoints).map((provider) => [
    provider,
    { kind: "api_key" as const, provider, apiKey: `fixture-${provider}` },
  ]));
  const broker = new CredentialBroker([new ExplicitCredentialSource(credentials)]);

  for (const [provider, endpoint] of Object.entries(endpoints)) {
    const config = BUILTIN_PROVIDER_CONFIGS[provider];
    assert.equal(config?.kind, "anthropic");
    let requestedUrl = "";
    let apiKey: string | null = null;
    const adapter = createProviderAdapter(config!, broker, {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestedUrl = request.url;
        apiKey = request.headers.get("x-api-key");
        return new Response(JSON.stringify({ data: [{ id: `${provider}-model` }], has_more: false }), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    assert.deepEqual((await adapter.listModels(new AbortController().signal)).map((model) => model.id), [`${provider}-model`]);
    assert.equal(requestedUrl, endpoint);
    assert.equal(apiKey, `fixture-${provider}`);
  }
});

test("provider presets select only their documented compatibility profiles", () => {
  const profile = (provider: string): string | undefined => {
    const config = BUILTIN_PROVIDER_CONFIGS[provider];
    return config?.kind === "openai-compatible" ? config.profile : undefined;
  };
  assert.equal(profile("vercel-ai-gateway"), "vercel-ai-gateway");
  assert.equal(profile("zai"), "zai");
  assert.equal(profile("zai-coding-cn"), "zai");
  assert.equal(profile("xiaomi"), "xiaomi");
  assert.equal(profile("moonshotai"), "moonshot");
  assert.equal(profile("moonshotai-cn"), "moonshot");
  assert.equal(profile("xiaomi-token-plan-cn"), "xiaomi");
  assert.equal(profile("xiaomi-token-plan-ams"), "xiaomi");
  assert.equal(profile("xiaomi-token-plan-sgp"), "xiaomi");
  const cloudflare = BUILTIN_PROVIDER_CONFIGS["cloudflare-ai-gateway"];
  assert.equal(
    cloudflare?.kind === "routed" && cloudflare.adapters.chat?.kind === "openai-compatible"
      ? cloudflare.adapters.chat.profile
      : undefined,
    "cloudflare-ai-gateway",
  );
  assert.equal(profile("kimi-coding"), undefined);
  assert.equal(profile("minimax"), undefined);
  assert.equal(profile("minimax-cn"), undefined);
  assert.equal(profile("groq"), undefined);
});

test("OpenCode presets expose explicit maintained routes for every supported protocol", async () => {
  const expected = {
    opencode: {
      count: 54,
      examples: [
        ["claude-sonnet-5", "anthropic-messages"],
        ["gemini-3.5-flash", "gemini-generate-content"],
        ["gpt-5.6-sol", "openai-responses"],
        ["kimi-k2.6", "openai-chat-completions"],
      ],
    },
    "opencode-go": {
      count: 15,
      examples: [
        ["qwen3.7-plus", "anthropic-messages"],
        ["kimi-k2.6", "openai-chat-completions"],
        ["mimo-v2.5-pro", "openai-chat-completions"],
      ],
    },
  } as const;
  const providerBroker = new CredentialBroker([new ExplicitCredentialSource(new Map([
    ["opencode", { kind: "api_key" as const, provider: "opencode", apiKey: "zen-key" }],
    ["opencode-go", { kind: "api_key" as const, provider: "opencode-go", apiKey: "go-key" }],
  ]))]);

  for (const [provider, details] of Object.entries(expected)) {
    const config = BUILTIN_PROVIDER_CONFIGS[provider];
    assert.equal(config?.kind, "routed");
    if (config?.kind !== "routed") throw new Error(`Expected routed provider ${provider}`);
    assert.equal(config.routes.length, details.count);
    assert.equal(new Set(config.routes.map((route) => route.model)).size, details.count);
    for (const [model, protocolFamily] of details.examples) {
      assert.equal(config.routes.find((route) => route.model === model)?.protocolFamily, protocolFamily);
    }
    let networkCalls = 0;
    const adapter = createProviderAdapter(config, providerBroker, {
      fetch: (async () => {
        networkCalls += 1;
        throw new Error("Static route catalog must not use the network");
      }) as typeof fetch,
    });
    assert.equal((await adapter.listModels(new AbortController().signal)).length, details.count);
    assert.equal(networkCalls, 0);
  }
});

test("OpenCode Gemini routes retain GenerateContent API-key authentication", async () => {
  const providerBroker = new CredentialBroker([new ExplicitCredentialSource(new Map([
    ["opencode", { kind: "api_key" as const, provider: "opencode", apiKey: "zen-key" }],
  ]))]);
  let incoming: Request | undefined;
  const adapter = createProviderAdapter(BUILTIN_PROVIDER_CONFIGS.opencode!, providerBroker, {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      incoming = input instanceof Request ? input : new Request(input, init);
      return new Response([
        `data: ${JSON.stringify({
          responseId: "gemini-response",
          modelVersion: "gemini-3.5-flash",
          candidates: [{
            index: 0,
            finishReason: "STOP",
            content: { role: "model", parts: [{ text: "ok" }] },
          }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
  });
  const input = request("opencode");
  input.model = "gemini-3.5-flash";

  const events = await collect(adapter.stream(input, new AbortController().signal));
  assert.equal(events.at(-1)?.type, "response_end");
  assert.equal(
    incoming?.url,
    "https://opencode.ai/zen/v1/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
  );
  assert.equal(incoming?.headers.get("x-goog-api-key"), "zen-key");
  assert.equal(incoming?.headers.get("authorization"), null);
});

test("Cloudflare presets materialize scoped endpoints and gateway authentication", async () => {
  const providerBroker = new CredentialBroker([new ExplicitCredentialSource(new Map([
    ["cloudflare-workers-ai", {
      kind: "api_key" as const,
      provider: "cloudflare-workers-ai",
      apiKey: "workers-key",
      accountId: "stored-account",
    }],
    ["cloudflare-ai-gateway", {
      kind: "api_key" as const,
      provider: "cloudflare-ai-gateway",
      apiKey: "gateway-key",
    }],
  ]))]);
  const wire = new ProviderWireInterceptorRegistry();
  registerCloudflareWireInterceptors(wire, providerBroker, {
    CLOUDFLARE_ACCOUNT_ID: "ambient-account",
    CLOUDFLARE_GATEWAY_ID: "coding-gateway",
  });
  const observed: Request[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    observed.push(input instanceof Request ? input : new Request(input, init));
    return new Response(
      `data: ${JSON.stringify({ id: "response", model: "model", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof globalThis.fetch;

  const workers = createProviderAdapter(BUILTIN_PROVIDER_CONFIGS["cloudflare-workers-ai"]!, providerBroker, { wire, fetch });
  const workersRequest = request("cloudflare-workers-ai");
  workersRequest.model = "@cf/openai/gpt-oss-20b";
  await collect(workers.stream(workersRequest, new AbortController().signal));

  const gateway = createProviderAdapter(BUILTIN_PROVIDER_CONFIGS["cloudflare-ai-gateway"]!, providerBroker, { wire, fetch });
  const gatewayRequest = request("cloudflare-ai-gateway");
  gatewayRequest.model = "workers-ai/@cf/zai-org/glm-5.2";
  gatewayRequest.maxOutputTokens = 123;
  gatewayRequest.reasoningEffort = "high";
  await collect(gateway.stream(gatewayRequest, new AbortController().signal));

  assert.equal(observed[0]?.url, "https://api.cloudflare.com/client/v4/accounts/stored-account/ai/v1/chat/completions");
  assert.equal(observed[0]?.headers.get("authorization"), "Bearer workers-key");
  assert.equal(observed[1]?.url, "https://gateway.ai.cloudflare.com/v1/ambient-account/coding-gateway/compat/chat/completions");
  assert.equal(observed[1]?.headers.get("authorization"), null);
  assert.equal(observed[1]?.headers.get("x-api-key"), null);
  assert.equal(observed[1]?.headers.get("cf-aig-authorization"), "Bearer gateway-key");
  const gatewayBody = await observed[1]!.clone().json() as Record<string, unknown>;
  assert.equal(gatewayBody.max_tokens, 123);
  assert.equal(gatewayBody.max_completion_tokens, undefined);
  assert.equal(gatewayBody.reasoning_effort, undefined);
});

test("the local router preset discovers only live router models", async () => {
  const config = BUILTIN_PROVIDER_CONFIGS["llama.cpp"];
  assert.deepEqual(config, {
    kind: "llama-router",
    id: "llama.cpp",
    baseUrl: "http://127.0.0.1:8080",
  });
  const adapter = createProviderAdapter(config!, new CredentialBroker([]), {
    fetch: (async () => new Response(JSON.stringify({
      data: [
        { id: "ready.gguf", status: { value: "loaded" } },
        { id: "cold.gguf", status: { value: "unloaded" } },
      ],
    }), { headers: { "content-type": "application/json" } })) as typeof fetch,
  });
  assert.deepEqual((await adapter.listModels(new AbortController().signal)).map((model) => model.id), ["ready.gguf"]);
});
