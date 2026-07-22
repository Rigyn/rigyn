import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdapterEvent, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import type { ModelCatalogStore } from "../../src/providers/model-catalog-store.js";
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

test("provider overrides compose as ownership-safe disposable layers", async () => {
  const base = new CatalogProvider([model("base-model")]);
  const first = new CatalogProvider([model("first-model")]);
  const second = new CatalogProvider([model("second-model")]);
  const registry = new ProviderRegistry([base]);

  assert.throws(() => registry.register(first), /already registered/u);
  assert.throws(
    () => registry.override({
      id: "missing",
      async *stream() {},
      async listModels() { return []; },
    }),
    /is not registered/u,
  );

  await registry.refreshModels("catalog", new AbortController().signal);
  assert.deepEqual((await registry.listModels("catalog", new AbortController().signal)).map((entry) => entry.id), ["base-model"]);

  const disposeFirst = registry.override(first);
  assert.equal(registry.get("catalog"), first);
  assert.deepEqual(await registry.listModels("catalog", new AbortController().signal), []);
  await registry.refreshModels("catalog", new AbortController().signal);
  assert.deepEqual((await registry.listModels("catalog", new AbortController().signal)).map((entry) => entry.id), ["first-model"]);

  const disposeSecond = registry.override(second);
  assert.equal(registry.get("catalog"), second);
  disposeFirst();
  assert.equal(registry.get("catalog"), second);
  disposeFirst();

  disposeSecond();
  assert.equal(registry.get("catalog"), base);
  assert.deepEqual(
    (await registry.listModels("catalog", new AbortController().signal)).map((entry) => entry.id),
    ["base-model"],
  );
  await registry.refreshModels("catalog", new AbortController().signal);
  assert.deepEqual((await registry.listModels("catalog", new AbortController().signal)).map((entry) => entry.id), ["base-model"]);
  disposeSecond();
  assert.equal(registry.get("catalog"), base);
});

test("provider override disposal restores each prior verified catalog without network access", async () => {
  const base = new CatalogProvider([model("base-model")]);
  const first = new CatalogProvider([model("first-model")]);
  const second = new CatalogProvider([model("second-model")]);
  const registry = new ProviderRegistry([base]);
  const signal = new AbortController().signal;

  await registry.refreshModels("catalog", signal);
  const disposeFirst = registry.override(first);
  await registry.refreshModels("catalog", signal);
  const disposeSecond = registry.override(second);
  await registry.refreshModels("catalog", signal);

  disposeSecond();
  assert.equal(registry.get("catalog"), first);
  assert.deepEqual(registry.getModels("catalog").map((entry) => entry.id), ["first-model"]);

  disposeFirst();
  assert.equal(registry.get("catalog"), base);
  assert.deepEqual(registry.getModels("catalog").map((entry) => entry.id), ["base-model"]);
  assert.equal(base.calls, 1);
  assert.equal(first.calls, 1);
  assert.equal(second.calls, 1);
});

test("late catalog hydration belongs to the base provider generation during an active override", async () => {
  let releaseRead: ((value: string) => void) | undefined;
  const stored = new Promise<string>((resolve) => { releaseRead = resolve; });
  const store: ModelCatalogStore = {
    async read() { return await stored; },
    async write() {},
  };
  const base = new CatalogProvider([model("base-model")]);
  const replacement = new CatalogProvider([model("replacement-model")]);
  const registry = new ProviderRegistry([base], { catalogStore: store });
  const dispose = registry.override(replacement);

  releaseRead?.(JSON.stringify({
    version: 1,
    savedAt: "2026-01-01T00:00:00.000Z",
    providers: [{
      provider: "catalog",
      provenance: "persisted",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      models: [model("base-model")],
    }],
  }));
  await registry.catalogStatus("catalog");
  assert.deepEqual(registry.getModels("catalog"), []);

  await registry.refreshModels("catalog", new AbortController().signal);
  assert.deepEqual(registry.getModels("catalog").map((entry) => entry.id), ["replacement-model"]);
  dispose();
  assert.deepEqual(registry.getModels("catalog").map((entry) => entry.id), ["base-model"]);
  assert.equal(base.calls, 0);
});

test("provider overlays compose selected behavior and restore correctly out of order", async () => {
  const base = new CatalogProvider([model("base-model")]);
  const registry = new ProviderRegistry([base]);
  const streamOverlay = registry.overlay({
    id: "catalog",
    async *stream() { yield { type: "text_delta", part: 0, text: "overlay" }; },
  });
  const catalogOverlay = registry.overlay({
    id: "catalog",
    async listModels() { return [model("overlay-model")]; },
  });

  let event: AdapterEvent | undefined;
  for await (const current of registry.get("catalog").stream({
    provider: "catalog",
    model: "overlay-model",
    messages: [],
    tools: [],
  }, new AbortController().signal)) {
    event = current;
    break;
  }
  assert.equal(event?.type === "text_delta" ? event.text : undefined, "overlay");
  await registry.refreshModels("catalog", new AbortController().signal);
  assert.deepEqual((await registry.listModels("catalog", new AbortController().signal)).map((entry) => entry.id), ["overlay-model"]);

  streamOverlay();
  await assert.rejects(async () => {
    for await (const _event of registry.get("catalog").stream({
      provider: "catalog",
      model: "overlay-model",
      messages: [],
      tools: [],
    }, new AbortController().signal)) {
      // The base fixture throws before yielding.
    }
  }, /unused/u);
  catalogOverlay();
  await registry.refreshModels("catalog", new AbortController().signal);
  assert.deepEqual((await registry.listModels("catalog", new AbortController().signal)).map((entry) => entry.id), ["base-model"]);
});

test("provider overrides abort stale catalog refreshes without blocking the replacement", async () => {
  let markStarted: (() => void) | undefined;
  let release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const base: ProviderAdapter = {
    id: "catalog",
    async *stream() {},
    async listModels() {
      markStarted?.();
      await blocked;
      return [model("stale-model")];
    },
  };
  const replacement = new CatalogProvider([model("replacement-model")]);
  const registry = new ProviderRegistry([base]);

  const staleRefresh = registry.refreshModels("catalog", new AbortController().signal);
  await started;
  const dispose = registry.override(replacement);
  const replacementRefresh = await registry.refreshModels("catalog", new AbortController().signal);
  assert.equal(replacementRefresh.ok, true);
  assert.deepEqual(
    (await registry.listModels("catalog", new AbortController().signal)).map((entry) => entry.id),
    ["replacement-model"],
  );

  release?.();
  await assert.rejects(staleRefresh, /Provider adapter changed/u);
  assert.deepEqual(
    (await registry.listModels("catalog", new AbortController().signal)).map((entry) => entry.id),
    ["replacement-model"],
  );
  dispose();
});

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
  const totalCost = usage?.type === "usage" ? usage.usage.cost?.total : undefined;
  assert.ok(totalCost !== undefined && Math.abs(totalCost - 0.00028) <= 1e-15);
});
