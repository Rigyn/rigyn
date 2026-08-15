import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_PROVIDER_CONFIGS } from "../../src/cli/runtime.js";
import { BUILTIN_PROVIDER_DESCRIPTORS, canonicalProviderId } from "../../src/providers/builtins.js";

const PUBLIC_IDS = [
  "anthropic",
  "deepseek",
  "github-copilot",
  "google",
  "kimi-code",
  "ollama",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "xai",
] as const;

test("public provider descriptors expose exactly the retained twelve identities", () => {
  assert.deepEqual(BUILTIN_PROVIDER_DESCRIPTORS.map((provider) => provider.id).sort(), [...PUBLIC_IDS].sort());
  assert.equal(new Set(BUILTIN_PROVIDER_DESCRIPTORS.map((provider) => provider.id)).size, 12);
  assert.equal(BUILTIN_PROVIDER_DESCRIPTORS.find((provider) => provider.id === "openrouter")?.oauth, true);
  assert.deepEqual(BUILTIN_PROVIDER_DESCRIPTORS.find((provider) => provider.id === "kimi-code")?.environment, ["KIMI_CODE_API_KEY"]);
  assert.deepEqual(BUILTIN_PROVIDER_DESCRIPTORS.find((provider) => provider.id === "ollama")?.apis, ["ollama-chat"]);
});

test("the public Google identity maps coherently to the Gemini runtime key", () => {
  assert.equal(canonicalProviderId("google"), "google");
  assert.equal(canonicalProviderId("gemini"), "google");
  assert.equal(BUILTIN_PROVIDER_CONFIGS.google, undefined);
  assert.equal(BUILTIN_PROVIDER_CONFIGS.gemini?.kind, "gemini");
});

test("every public identity has exactly one runtime configuration", () => {
  const runtimeIds = Object.keys(BUILTIN_PROVIDER_CONFIGS).map((id) => canonicalProviderId(id)).sort();
  assert.deepEqual(runtimeIds, [...PUBLIC_IDS].sort());
});

test("routed providers expose only declared adapters and model routes", () => {
  for (const id of ["xai", "opencode", "opencode-go"] as const) {
    const config = BUILTIN_PROVIDER_CONFIGS[id];
    assert.equal(config?.kind, "routed", id);
    if (config?.kind !== "routed") continue;
    assert.ok(Object.keys(config.adapters).length > 0, id);
    assert.ok(config.routes.length > 0, id);
    assert.ok(config.routes.every((route) => Object.hasOwn(config.adapters, route.adapter)), id);
  }
});
