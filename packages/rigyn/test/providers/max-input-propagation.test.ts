import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthStorage } from "../../src/auth/auth-storage.js";
import type { ModelInfo as RootModelInfo } from "../../src/index.js";
import {
  extensionModel,
  extensionModelRegistry,
} from "../../src/extensions/model-boundary.js";
import {
  providerModelFromInfo,
  providerModelToInfo,
} from "../../src/providers/internal-runtime-bridge.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import { createModels, type Provider, type ProviderModel } from "../../src/providers/models.js";
import { withRemoteCatalog } from "../../src/providers/remote-catalog.js";
import {
  buildHarnessResourceCatalog,
  parseHarnessResourceCatalog,
} from "../../src/service/resource-catalog.js";
import { createScriptedProvider } from "../../src/testing/scripted-provider.js";

const BASE_MODEL: ProviderModel = {
  id: "bounded",
  name: "Bounded",
  api: "openai-responses",
  provider: "ceiling-fixture",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_384,
  maxInputTokens: 12_000,
  maxTokens: 2_048,
};

function provider(): Provider {
  return {
    id: BASE_MODEL.provider,
    name: "Ceiling fixture",
    baseUrl: BASE_MODEL.baseUrl,
    auth: {},
    getModels: () => [BASE_MODEL],
    async *stream() {},
    async *streamSimple() {},
  };
}

test("public, adapter, and root model views preserve an explicit input ceiling", () => {
  const info = providerModelToInfo(BASE_MODEL);
  assert.equal(info.maxInputTokens, 12_000);
  assert.equal(providerModelFromInfo(info).maxInputTokens, 12_000);
  assert.equal(extensionModel(BASE_MODEL).maxInputTokens, 12_000);

  const publicAlias: RootModelInfo = {
    provider: BASE_MODEL.provider,
    id: BASE_MODEL.id,
    contextWindow: BASE_MODEL.contextWindow,
    maxInputTokens: BASE_MODEL.maxInputTokens!,
    reasoning: BASE_MODEL.reasoning,
  };
  assert.equal(publicAlias.maxInputTokens, 12_000);
});

test("direct extension provider registration preserves its optional input ceiling", () => {
  const internal = new ModelRegistry(createModels());
  const registry = extensionModelRegistry(internal);
  registry.registerProvider("extension-ceiling", {
    api: "openai-responses",
    apiKey: "fixture-key",
    baseUrl: "https://example.test/v1",
    models: [{
      id: "bounded",
      name: "Bounded",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_384,
      maxInputTokens: 12_000,
      maxTokens: 2_048,
    }],
  });

  assert.equal(internal.find("extension-ceiling", "bounded")?.maxInputTokens, 12_000);
  assert.equal(registry.find("extension-ceiling", "bounded")?.maxInputTokens, 12_000);
  assert.equal(
    registry.getRegisteredProviderConfig("extension-ceiling")?.models?.[0]?.maxInputTokens,
    12_000,
  );
  assert.throws(
    () => registry.registerProvider("invalid-extension-ceiling", {
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      models: [{
        id: "invalid",
        name: "Invalid",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16_384,
        maxInputTokens: Number.POSITIVE_INFINITY,
        maxTokens: 2_048,
      }],
    }),
    /maxInputTokens must be a positive safe integer/iu,
  );
});

test("editable provider configuration preserves its optional input ceiling", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-max-input-config-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const modelsPath = join(directory, "model-providers.json");
  await writeFile(modelsPath, JSON.stringify({
    providers: {
      "configured-ceiling": {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.test/v1",
        models: [{ id: "bounded", maxInputTokens: 12_000 }],
      },
    },
  }));
  const runtime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory(),
    modelsPath,
    allowModelNetwork: false,
  });
  context.after(async () => await runtime.close());

  assert.equal(runtime.getModel("configured-ceiling", "bounded")?.maxInputTokens, 12_000);

  await writeFile(modelsPath, JSON.stringify({
    providers: {
      "configured-ceiling": {
        api: "openai-responses",
        apiKey: "fixture-key",
        baseUrl: "https://example.test/v1",
        models: [{ id: "bounded", maxInputTokens: 12.5 }],
      },
    },
  }));
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getModel("configured-ceiling", "bounded"), undefined);
  assert.match(runtime.getError() ?? "", /maxInputTokens must be a positive safe integer/iu);
});

test("remote catalogs preserve explicit input ceilings and do not infer absent values", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let responseModel: Record<string, unknown> = { ...BASE_MODEL, maxInputTokens: 11_000 };
  globalThis.fetch = async () => Response.json({ models: [responseModel] });
  const wrapped = withRemoteCatalog(provider(), "https://catalog.example.test");
  const store = {
    async read() { return undefined; },
    async write() {},
    async delete() {},
  };
  await wrapped.refreshModels!({ allowNetwork: true, force: true, store });
  assert.equal(wrapped.getModels()[0]?.maxInputTokens, 11_000);

  responseModel = Object.fromEntries(
    Object.entries(BASE_MODEL).filter(([name]) => name !== "maxInputTokens"),
  );
  const { maxInputTokens: _maxInputTokens, ...unboundedBaseline } = BASE_MODEL;
  const withoutBaseline: Provider = { ...provider(), getModels: () => [unboundedBaseline] };
  const unknown = withRemoteCatalog(withoutBaseline, "https://catalog.example.test");
  await unknown.refreshModels!({ allowNetwork: true, force: true, store });
  assert.equal(Object.hasOwn(unknown.getModels()[0]!, "maxInputTokens"), false);

  responseModel = { ...BASE_MODEL, maxInputTokens: 0 };
  const invalid = withRemoteCatalog(provider(), "https://catalog.example.test");
  await assert.rejects(
    invalid.refreshModels!({ allowNetwork: true, force: true, store }),
    /maximum input tokens must be a positive safe integer/iu,
  );
});

test("the harness resource catalog carries and validates the optional input ceiling", () => {
  const info = providerModelToInfo(BASE_MODEL);
  const catalog = buildHarnessResourceCatalog({
    tools: [],
    toolOwner: () => ({ kind: "builtin" }),
    skills: [],
    providers: [{ id: BASE_MODEL.provider, models: [info] }],
  });
  assert.equal(catalog.providers[0]?.models[0]?.maxInputTokens, 12_000);
  assert.equal(
    parseHarnessResourceCatalog(catalog).providers[0]?.models[0]?.maxInputTokens,
    12_000,
  );
});

test("the public scripted provider preserves and validates the optional input ceiling", () => {
  const scripted = createScriptedProvider({
    models: [{ id: "bounded", maxInputTokens: 12_000 }],
  });
  assert.equal(scripted.models[0]?.maxInputTokens, 12_000);
  assert.throws(
    () => createScriptedProvider({ models: [{ id: "invalid", maxInputTokens: 0 }] }),
    /maxInputTokens must be an integer from 1/iu,
  );
});
