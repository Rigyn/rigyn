import assert from "node:assert/strict";
import test from "node:test";

import { CredentialBroker, ExplicitCredentialSource } from "../../src/auth/index.js";
import { BUILTIN_PROVIDER_CONFIGS } from "../../src/cli/runtime.js";
import { createProviderAdapter } from "../../src/service/provider-factory.js";

test("built-in compatible provider presets use their documented model endpoints and credentials", async () => {
  const endpoints = {
    groq: "https://api.groq.com/openai/v1/models",
    together: "https://api.together.ai/v1/models",
    deepseek: "https://api.deepseek.com/models",
    cerebras: "https://api.cerebras.ai/v1/models",
    xai: "https://api.x.ai/v1/models",
    fireworks: "https://api.fireworks.ai/inference/v1/models",
    huggingface: "https://router.huggingface.co/v1/models",
    "vercel-ai-gateway": "https://ai-gateway.vercel.sh/v1/models",
    zai: "https://api.z.ai/api/coding/paas/v4/models",
    "zai-coding-cn": "https://open.bigmodel.cn/api/coding/paas/v4/models",
    "kimi-coding": "https://api.kimi.com/coding/v1/models",
    minimax: "https://api.minimax.io/v1/models",
    "minimax-cn": "https://api.minimaxi.com/v1/models",
  } as const;
  const credentials = new Map(Object.keys(endpoints).map((provider) => [
    provider,
    { kind: "api_key" as const, provider, apiKey: `fixture-${provider}` },
  ]));
  const broker = new CredentialBroker([new ExplicitCredentialSource(credentials)]);

  for (const [provider, endpoint] of Object.entries(endpoints)) {
    const config = BUILTIN_PROVIDER_CONFIGS[provider];
    assert.equal(config?.kind, "openai-compatible");
    let requestedUrl = "";
    let authorization: string | null = null;
    const adapter = createProviderAdapter(config!, broker, {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestedUrl = request.url;
        authorization = request.headers.get("authorization");
        return new Response(JSON.stringify({
          data: [{ id: `${provider}-model`, ...(provider === "vercel-ai-gateway" ? { type: "language" } : {}) }],
        }), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    assert.deepEqual((await adapter.listModels(new AbortController().signal)).map((model) => model.id), [`${provider}-model`]);
    assert.equal(requestedUrl, endpoint);
    assert.equal(authorization, `Bearer fixture-${provider}`);
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
  assert.equal(profile("kimi-coding"), "kimi-coding");
  assert.equal(profile("minimax"), "minimax");
  assert.equal(profile("minimax-cn"), "minimax");
  assert.equal(profile("groq"), undefined);
});
