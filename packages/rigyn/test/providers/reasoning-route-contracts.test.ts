import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_PROVIDER_CONFIGS } from "../../src/cli/runtime.js";

test("every retained routed model uses one declared adapter", () => {
  for (const provider of ["opencode", "opencode-go", "xai"] as const) {
    const config = BUILTIN_PROVIDER_CONFIGS[provider];
    assert.equal(config?.kind, "routed");
    if (config?.kind !== "routed") continue;
    for (const route of config.routes) {
      assert.ok(Object.hasOwn(config.adapters, route.adapter), `${provider}/${route.model}`);
      assert.ok(route.protocolFamily.length > 0, `${provider}/${route.model}`);
      if (route.modelInfo !== undefined) {
        assert.equal(route.modelInfo.provider, provider);
        assert.equal(route.modelInfo.id, route.model);
        assert.ok(["supported", "unsupported", "unknown"].includes(route.modelInfo.capabilities.reasoning.value));
      }
    }
  }
});

test("xAI reasoning routes use one Responses contract with visible public reasoning", () => {
  const config = BUILTIN_PROVIDER_CONFIGS.xai;
  assert.equal(config?.kind, "routed");
  if (config?.kind !== "routed") return;
  assert.deepEqual(Object.keys(config.adapters), ["responses"]);
  assert.equal(config.adapters.responses?.kind, "openai");
  assert.equal(config.adapters.responses?.reasoningTextDisplay, true);
  assert.ok(config.routes.every((route) => route.protocolFamily === "openai-responses"));
});

test("OpenCode Zen keeps provider-native reasoning routes separated by protocol", () => {
  const config = BUILTIN_PROVIDER_CONFIGS.opencode;
  assert.equal(config?.kind, "routed");
  if (config?.kind !== "routed") return;
  assert.equal(config.adapters.responses?.kind, "openai");
  assert.equal(config.adapters.responses?.reasoningSummaries, true);
  assert.equal(config.adapters.messages?.kind, "anthropic");
  assert.equal(config.adapters.gemini?.kind, "gemini");
  assert.equal(config.adapters.chat?.kind, "openai-compatible");
  assert.equal(config.adapters["chat-kimi"]?.kind, "openai-compatible");
});

test("OpenCode Go keeps current provider-native reasoning routes separated by protocol", () => {
  const config = BUILTIN_PROVIDER_CONFIGS["opencode-go"];
  assert.equal(config?.kind, "routed");
  if (config?.kind !== "routed") return;
  assert.equal(config.adapters.responses?.kind, "openai");
  assert.equal(config.adapters.responses?.reasoningSummaries, true);
  assert.equal(config.adapters.messages?.kind, "anthropic");
  assert.equal(config.adapters.chat?.kind, "openai-compatible");
  assert.equal(config.routes.find((route) => route.model === "grok-4.5")?.protocolFamily, "openai-chat-completions");
  assert.equal(config.routes.find((route) => route.model === "deepseek-v4-flash")?.protocolFamily, "openai-chat-completions");
  assert.equal(config.routes.find((route) => route.model === "minimax-m3")?.protocolFamily, "anthropic-messages");
});
