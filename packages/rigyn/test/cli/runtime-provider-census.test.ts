import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_PROVIDER_CONFIGS } from "../../src/cli/runtime.js";
import type { ModelProtocolFamily } from "../../src/core/types.js";
import {
  runtimeProviderProtocolFamily,
  type RuntimeProviderConfig,
} from "../../src/service/provider-factory.js";
import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  canonicalProviderId,
} from "../../src/providers/builtins.js";

const CONFIGURED_EXTERNALLY = new Set([
  "azure-openai-responses",
  "google-vertex",
  "radius",
]);
const LOCAL_RUNTIME_PROVIDERS = new Set(["llama.cpp", "ollama"]);
const EXPECTED_BUILTIN_PROVIDERS = [
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "azure-openai-responses",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "radius",
  "together",
  "vercel-ai-gateway",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
] as const;

function runtimeProviderId(name: string, config: RuntimeProviderConfig): string {
  return "id" in config && config.id !== undefined ? config.id : name;
}

function protocolFamilies(config: RuntimeProviderConfig): readonly ModelProtocolFamily[] {
  if (config.kind === "routed") return [...new Set(config.routes.map((route) => route.protocolFamily))];
  const family = runtimeProviderProtocolFamily(config);
  return family === undefined ? [] : [family];
}

test("the built-in descriptor and runtime factory census is closed", () => {
  assert.equal(BUILTIN_PROVIDER_DESCRIPTORS.length, 38);
  const descriptors = new Map(BUILTIN_PROVIDER_DESCRIPTORS.map((entry) => [entry.id, entry]));
  assert.deepEqual([...descriptors.keys()].sort(), [...EXPECTED_BUILTIN_PROVIDERS].sort());
  const represented = new Set<string>();

  for (const [name, config] of Object.entries(BUILTIN_PROVIDER_CONFIGS)) {
    if (LOCAL_RUNTIME_PROVIDERS.has(name)) continue;
    const provider = canonicalProviderId(runtimeProviderId(name, config));
    const descriptor = descriptors.get(provider);
    assert.ok(descriptor, `Runtime provider ${name} has no built-in descriptor`);
    represented.add(provider);
    for (const family of protocolFamilies(config)) {
      assert.ok(
        descriptor.apis.includes(family),
        `Runtime provider ${name} routes ${family}, outside its descriptor`,
      );
    }
  }

  assert.deepEqual(
    [...descriptors.keys()].filter((provider) => !represented.has(provider)).sort(),
    [...CONFIGURED_EXTERNALLY].sort(),
  );
  assert.deepEqual(
    Object.keys(BUILTIN_PROVIDER_CONFIGS)
      .filter((name) => LOCAL_RUNTIME_PROVIDERS.has(name))
      .sort(),
    [...LOCAL_RUNTIME_PROVIDERS].sort(),
  );
});

test("maintained mixed-protocol routes keep exact model ownership", () => {
  const expected = {
    fireworks: { count: 16, messages: 14, responses: 0, chat: 2, gemini: 0 },
    opencode: { count: 54, messages: 13, responses: 20, chat: 18, gemini: 3 },
    "opencode-go": { count: 15, messages: 3, responses: 1, chat: 11, gemini: 0 },
    "cloudflare-ai-gateway": { count: 42, messages: 18, responses: 19, chat: 5, gemini: 0 },
  } as const;

  for (const [provider, counts] of Object.entries(expected)) {
    const config = BUILTIN_PROVIDER_CONFIGS[provider];
    assert.equal(config?.kind, "routed");
    if (config?.kind !== "routed") continue;
    assert.equal(config.routes.length, counts.count, provider);
    assert.equal(config.routes.filter((route) => route.protocolFamily === "anthropic-messages").length, counts.messages, provider);
    assert.equal(config.routes.filter((route) => route.protocolFamily === "openai-responses").length, counts.responses, provider);
    assert.equal(config.routes.filter((route) => route.protocolFamily === "openai-chat-completions").length, counts.chat, provider);
    assert.equal(config.routes.filter((route) => route.protocolFamily === "gemini-generate-content").length, counts.gemini, provider);
  }
});
