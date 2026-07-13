import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdapterEvent, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import { ProviderRegistry } from "../../src/providers/registry.js";

function model(id: string): ModelInfo {
  const unknown = { value: "unknown" as const, source: "provider" as const, observedAt: "2026-01-01T00:00:00.000Z" };
  return { id, provider: "catalog", contextTokens: 10_000, maxOutputTokens: 1_000, capabilities: { tools: unknown, reasoning: unknown, images: unknown } };
}

class CatalogProvider implements ProviderAdapter {
  readonly id = "catalog";
  readonly #models: ModelInfo[];
  calls = 0;

  constructor(models: ModelInfo[]) {
    this.#models = models;
  }

  async *stream(_request: ProviderRequest, _signal: AbortSignal): AsyncIterable<AdapterEvent> {
    throw new Error("unused");
  }

  async listModels(_signal: AbortSignal): Promise<ModelInfo[]> {
    this.calls += 1;
    return this.#models;
  }
}

test("model resolution uses an exact catalog ID without aliases or name inference", async () => {
  const exact = model("model-1");
  const provider = new CatalogProvider([exact, model("model-10")]);
  const registry = new ProviderRegistry([provider]);
  const resolved = await registry.resolveModel("catalog", "model-1", new AbortController().signal);
  assert.deepEqual(resolved, exact);
  assert.notStrictEqual(resolved, exact);
  assert.equal(await registry.resolveModel("catalog", "MODEL-1", new AbortController().signal), undefined);
  assert.equal(await registry.resolveModel("catalog", "model", new AbortController().signal), undefined);
  assert.equal(provider.calls, 1);
});

test("catalog normalization trims bounded fields and detaches committed models from provider mutation", async () => {
  const source = model(" model-normalized ");
  source.displayName = "  Normalized Model  ";
  source.compatibility = {
    inputModalities: { value: ["text", "image"], source: "provider", observedAt: "2026-01-01T00:00:00.000Z" },
  };
  source.pricing = {
    currency: "USD",
    unit: "per_million_tokens",
    source: "provider",
    observedAt: "2026-01-01T00:00:00.000Z",
    input: 1,
  };
  source.metadata = { nested: { value: "kept" } };
  const registry = new ProviderRegistry([new CatalogProvider([source])]);
  const resolved = await registry.resolveModel("catalog", "model-normalized", new AbortController().signal);

  assert.equal(resolved?.id, "model-normalized");
  assert.equal(resolved?.displayName, "Normalized Model");
  assert.notStrictEqual(resolved, source);
  source.id = "mutated";
  source.capabilities.tools.value = "supported";
  source.compatibility.inputModalities!.value.push("audio");
  source.pricing.input = 999;
  (source.metadata as { nested: { value: string } }).nested.value = "mutated";

  const retained = (await registry.listModels("catalog", new AbortController().signal))[0];
  assert.equal(retained?.id, "model-normalized");
  assert.equal(retained?.capabilities.tools.value, "unknown");
  assert.deepEqual(retained?.compatibility?.inputModalities?.value, ["text", "image"]);
  assert.equal(retained?.pricing?.input, 1);
  assert.deepEqual(retained?.metadata, { nested: { value: "kept" } });
});

test("model cache invalidation forces an entitlement refresh after an account change", async () => {
  const provider = new CatalogProvider([model("account-model")]);
  const registry = new ProviderRegistry([provider]);
  await registry.resolveModel("catalog", "account-model", new AbortController().signal);
  await registry.resolveModel("catalog", "account-model", new AbortController().signal);
  assert.equal(provider.calls, 1);
  registry.invalidateModels("catalog");
  await registry.resolveModel("catalog", "account-model", new AbortController().signal);
  assert.equal(provider.calls, 2);
  registry.invalidateModels();
  await registry.resolveModel("catalog", "account-model", new AbortController().signal);
  assert.equal(provider.calls, 3);
});

test("configured models are available offline without discovery and reject unknown providers", async () => {
  const provider = new CatalogProvider([]);
  const observedAt = "2026-07-10T00:00:00.000Z";
  const registry = new ProviderRegistry([provider], {
    now: () => Date.parse(observedAt),
    configuredModels: [{
      provider: "catalog",
      id: "org/coder:preview@2026",
      displayName: "Configured Coder",
      description: "Available without live discovery",
      contextTokens: 200_000,
      maxOutputTokens: 16_000,
      tools: true,
      reasoningEfforts: ["off", "high"],
      images: false,
    }],
  });

  const configured = await registry.listModels("catalog", new AbortController().signal, { refresh: false });
  assert.equal(provider.calls, 0);
  assert.deepEqual(configured, [{
    provider: "catalog",
    id: "org/coder:preview@2026",
    displayName: "Configured Coder",
    description: "Available without live discovery",
    contextTokens: 200_000,
    maxOutputTokens: 16_000,
    capabilities: {
      tools: { value: "supported", source: "configuration", observedAt },
      reasoning: { value: "supported", source: "configuration", observedAt },
      images: { value: "unsupported", source: "configuration", observedAt },
    },
    compatibility: {
      reasoningEfforts: { value: ["off", "high"], source: "configuration", observedAt },
    },
  }]);
  const resolution = await registry.requireModelReference(
    "org/coder:preview@2026",
    new AbortController().signal,
    { provider: "catalog" },
  );
  assert.equal(resolution.model, "org/coder:preview@2026");
  assert.equal(provider.calls, 0);
  assert.equal((await registry.catalogStatus("catalog"))[0]?.modelCount, 1);
  assert.throws(
    () => new ProviderRegistry([provider], { configuredModels: [{ provider: "missing", id: "model" }] }),
    /provider is not registered/u,
  );
});

test("configured model fields selectively override live metadata", async () => {
  const observedAt = "2026-07-10T00:00:00.000Z";
  const live = model("same-id");
  live.displayName = "Live name";
  live.description = "Live description";
  live.contextTokens = 64_000;
  live.maxOutputTokens = 4_000;
  live.capabilities.tools = { value: "supported", source: "provider", observedAt };
  live.capabilities.images = { value: "supported", source: "provider", observedAt };
  live.compatibility = {
    inputModalities: { value: ["text", "image"], source: "provider", observedAt },
    reasoningEfforts: { value: ["low"], source: "provider", observedAt },
  };
  live.pricing = {
    currency: "USD",
    unit: "per_million_tokens",
    source: "provider",
    observedAt,
    input: 99,
  };
  const provider = new CatalogProvider([live]);
  const registry = new ProviderRegistry([provider], { now: () => Date.parse(observedAt) });
  registry.configureModels([{
    provider: "catalog",
    id: "same-id",
    description: "Configured description",
    contextTokens: 128_000,
    tools: false,
    reasoningEfforts: ["low", "high"],
    pricing: { input: 1, output: 4 },
  }]);
  await registry.refreshModels("catalog", new AbortController().signal);

  const configured = (await registry.listModels("catalog", new AbortController().signal))[0]!;
  assert.equal(configured.id, "same-id");
  assert.equal(configured.displayName, "Live name");
  assert.equal(configured.description, "Configured description");
  assert.equal(configured.contextTokens, 128_000);
  assert.equal(configured.maxOutputTokens, 4_000);
  assert.deepEqual(configured.capabilities.tools, { value: "unsupported", source: "configuration", observedAt });
  assert.deepEqual(configured.capabilities.images, { value: "supported", source: "provider", observedAt });
  assert.deepEqual(configured.compatibility?.inputModalities?.value, ["text", "image"]);
  assert.deepEqual(configured.compatibility?.reasoningEfforts, {
    value: ["low", "high"], source: "configuration", observedAt,
  });
  assert.deepEqual(configured.pricing, {
    currency: "USD",
    unit: "per_million_tokens",
    source: "configuration",
    observedAt,
    input: 1,
    output: 4,
  });
});

test("runtime adapter prices usage while public adapter identity remains unchanged", async () => {
  const priced = model("priced");
  priced.pricing = {
    currency: "USD",
    unit: "per_million_tokens",
    source: "provider",
    observedAt: "2026-01-01T00:00:00.000Z",
    input: 2,
    output: 8,
  };
  const provider: ProviderAdapter = {
    id: "catalog",
    async *stream() {
      yield {
        type: "usage",
        semantics: "final",
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      } as const;
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "openai_responses", outputItems: [] },
      } as const;
    },
    async listModels() { return [priced]; },
  };
  const registry = new ProviderRegistry([provider]);
  await registry.refreshModels("catalog", new AbortController().signal);
  assert.equal(registry.get("catalog"), provider);
  const request = { provider: "catalog", model: "priced", messages: [], tools: [] } satisfies ProviderRequest;
  const events: AdapterEvent[] = [];
  for await (const event of registry.runtimeAdapter("catalog").stream(request, new AbortController().signal)) {
    events.push(event);
  }
  const usage = events.find((event) => event.type === "usage");
  assert.equal(usage?.type === "usage" ? usage.usage.cost : undefined, "0.00028");
});
