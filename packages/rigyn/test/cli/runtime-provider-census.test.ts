import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_PROVIDER_CONFIGS, configuredProviderConfigs } from "../../src/cli/runtime.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import type { ModelProtocolFamily } from "../../src/core/types.js";
import { BUILTIN_PROVIDER_DESCRIPTORS, canonicalProviderId } from "../../src/providers/builtins.js";
import { runtimeProviderProtocolFamily, type RuntimeProviderConfig } from "../../src/service/provider-factory.js";

const EXPECTED = [
  "anthropic", "deepseek", "github-copilot", "google", "kimi-code", "ollama",
  "openai", "openai-codex", "opencode", "opencode-go", "openrouter", "xai",
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
  const descriptors = new Map(BUILTIN_PROVIDER_DESCRIPTORS.map((entry) => [entry.id, entry]));
  assert.deepEqual([...descriptors.keys()].sort(), [...EXPECTED].sort());
  const represented = new Set<string>();
  for (const [name, config] of Object.entries(BUILTIN_PROVIDER_CONFIGS)) {
    const provider = canonicalProviderId(runtimeProviderId(name, config));
    const descriptor = descriptors.get(provider);
    assert.ok(descriptor, `Runtime provider ${name} has no public descriptor`);
    represented.add(provider);
    for (const family of protocolFamilies(config)) {
      assert.ok(descriptor.apis.includes(family), `${name} routes undeclared protocol ${family}`);
    }
  }
  assert.deepEqual([...represented].sort(), [...EXPECTED].sort());
});

test("environment configuration does not restore removed built-ins", () => {
  const configured = configuredProviderConfigs(SettingsManager.inMemory(), {
    GOOGLE_CLOUD_PROJECT: "project-id",
    GOOGLE_CLOUD_LOCATION: "us-central1",
    AZURE_OPENAI_ENDPOINT: "https://fixture.openai.azure.com",
    GROQ_API_KEY: "removed",
  });
  assert.deepEqual(Object.keys(configured).sort(), Object.keys(BUILTIN_PROVIDER_CONFIGS).sort());
  assert.equal(configured.vertex, undefined);
  assert.equal(configured["azure-openai"], undefined);
  assert.equal(configured.groq, undefined);
});

test("the HTTP response-idle setting also configures Codex WebSocket response idle", () => {
  const configured = configuredProviderConfigs(SettingsManager.inMemory({ httpIdleTimeoutMs: 12_345 }), {});
  const codex = configured["openai-codex"];
  assert.equal(codex?.kind, "openai-codex");
  assert.equal(codex?.kind === "openai-codex" ? codex.webSocketIdleTimeoutMs : undefined, 12_345);
});

test("retained routed providers keep exact model ownership", () => {
  for (const provider of ["opencode", "opencode-go", "xai"] as const) {
    const config = BUILTIN_PROVIDER_CONFIGS[provider];
    assert.equal(config?.kind, "routed");
    if (config?.kind !== "routed") continue;
    assert.notEqual(config.routes.length, 0, provider);
    assert.equal(new Set(config.routes.map((route) => route.model)).size, config.routes.length, provider);
    assert.ok(config.routes.every((route) => route.modelInfo?.provider === provider || provider === "xai"), provider);
  }
});
