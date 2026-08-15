import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_PROVIDER_CONFIGS } from "../../src/cli/runtime.js";
import { BUILTIN_PROVIDER_DESCRIPTORS, canonicalProviderId } from "../../src/providers/builtins.js";
import { runtimeProviderProtocolFamily } from "../../src/service/provider-factory.js";

test("every public built-in has an exact runtime protocol contract", () => {
  const descriptors = new Map(BUILTIN_PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));
  for (const [runtimeId, config] of Object.entries(BUILTIN_PROVIDER_CONFIGS)) {
    const descriptor = descriptors.get(canonicalProviderId(runtimeId));
    assert.ok(descriptor, runtimeId);
    const families = config.kind === "routed"
      ? [...new Set(config.routes.map((route) => route.protocolFamily))]
      : [runtimeProviderProtocolFamily(config)].filter((value) => value !== undefined);
    if (config.kind === "github-copilot") {
      assert.deepEqual(descriptor.apis, ["anthropic-messages", "openai-chat-completions", "openai-responses"]);
      continue;
    }
    assert.deepEqual([...families].sort(), [...descriptor.apis].sort(), runtimeId);
  }
});

test("every routed adapter is used by a protocol-exact route", () => {
  for (const provider of ["opencode", "opencode-go", "xai"] as const) {
    const config = BUILTIN_PROVIDER_CONFIGS[provider];
    assert.equal(config?.kind, "routed");
    if (config?.kind !== "routed") continue;
    for (const adapter of Object.keys(config.adapters)) {
      const matchingRoutes: typeof config.routes = config.routes.filter((route) => route.adapter === adapter);
      assert.notEqual(matchingRoutes.length, 0, `${provider}/${adapter}`);
      assert.equal(new Set(matchingRoutes.map((route) => route.protocolFamily)).size, 1, `${provider}/${adapter}`);
    }
  }
});

test("retained routed endpoints remain literal and provider-owned", () => {
  const xai = BUILTIN_PROVIDER_CONFIGS.xai;
  assert.equal(xai?.kind, "routed");
  if (xai?.kind === "routed") {
    const responses = xai.adapters.responses;
    assert.equal(responses?.kind, "openai");
    if (responses?.kind === "openai") {
      assert.equal(responses.baseUrl, "https://api.x.ai/v1");
      assert.equal(responses.reasoningTextDisplay, true);
    }
  }

  const opencode = BUILTIN_PROVIDER_CONFIGS.opencode;
  assert.equal(opencode?.kind, "routed");
  if (opencode?.kind === "routed") {
    const messages = opencode.adapters.messages;
    const responses = opencode.adapters.responses;
    const gemini = opencode.adapters.gemini;
    const chat = opencode.adapters.chat;
    assert.equal(messages?.kind, "anthropic");
    assert.equal(responses?.kind, "openai");
    assert.equal(gemini?.kind, "gemini");
    assert.equal(chat?.kind, "openai-compatible");
    if (messages?.kind === "anthropic") assert.equal(messages.baseUrl, "https://opencode.ai/zen");
    if (responses?.kind === "openai") assert.equal(responses.baseUrl, "https://opencode.ai/zen/v1");
    if (gemini?.kind === "gemini") assert.equal(gemini.baseUrl, "https://opencode.ai/zen/v1");
    if (chat?.kind === "openai-compatible") assert.equal(chat.baseUrl, "https://opencode.ai/zen/v1");
  }

  const opencodeGo = BUILTIN_PROVIDER_CONFIGS["opencode-go"];
  assert.equal(opencodeGo?.kind, "routed");
  if (opencodeGo?.kind === "routed") {
    const messages = opencodeGo.adapters.messages;
    const responses = opencodeGo.adapters.responses;
    const chat = opencodeGo.adapters.chat;
    assert.equal(messages?.kind, "anthropic");
    assert.equal(responses?.kind, "openai");
    assert.equal(chat?.kind, "openai-compatible");
    if (messages?.kind === "anthropic") assert.equal(messages.baseUrl, "https://opencode.ai/zen/go");
    if (responses?.kind === "openai") assert.equal(responses.baseUrl, "https://opencode.ai/zen/go/v1");
    if (chat?.kind === "openai-compatible") assert.equal(chat.baseUrl, "https://opencode.ai/zen/go/v1");
  }
});

test("all retained routes have unique model ownership", () => {
  for (const provider of ["opencode", "opencode-go", "xai"] as const) {
    const config = BUILTIN_PROVIDER_CONFIGS[provider];
    if (config?.kind !== "routed") continue;
    assert.equal(new Set(config.routes.map((route) => route.model)).size, config.routes.length, provider);
  }
});
