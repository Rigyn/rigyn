import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdapterEvent, ModelCapability, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import { FileModelCatalogStore } from "../../src/providers/model-catalog-store.js";
import type { ModelCatalogStore } from "../../src/providers/model-catalog-store.js";
import { modelReasoningEfforts, ProviderRegistry } from "../../src/providers/registry.js";

const OBSERVED_AT = "2026-01-01T00:00:00.000Z";

function capability(value: ModelCapability["value"] = "unknown"): ModelCapability {
  return { value, source: "provider", observedAt: OBSERVED_AT };
}

function model(provider: string, id: string, options: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    provider,
    capabilities: {
      tools: capability(),
      reasoning: capability(),
      images: capability(),
    },
    ...options,
  };
}

class MutableProvider implements ProviderAdapter {
  readonly id: string;
  models: ModelInfo[];
  calls = 0;
  failure: unknown;
  list: ((signal: AbortSignal) => Promise<ModelInfo[]>) | undefined;

  constructor(id: string, models: ModelInfo[] = []) {
    this.id = id;
    this.models = models;
  }

  async *stream(_request: ProviderRequest, _signal: AbortSignal): AsyncIterable<AdapterEvent> {
    throw new Error("unused");
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    this.calls += 1;
    signal.throwIfAborted();
    if (this.list !== undefined) return await this.list(signal);
    if (this.failure !== undefined) throw this.failure;
    return this.models;
  }
}

test("catalog refreshes coalesce while each waiter retains independent cancellation", async () => {
  const provider = new MutableProvider("coalesced");
  let release: ((value: ModelInfo[]) => void) | undefined;
  provider.list = async () => await new Promise<ModelInfo[]>((resolve) => { release = resolve; });
  const registry = new ProviderRegistry([provider]);
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const first = registry.refreshModels(provider.id, firstAbort.signal);
  const second = registry.refreshModels(provider.id, secondAbort.signal);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(provider.calls, 1);
  assert.equal((await registry.catalogStatus(provider.id))[0]?.refreshing, true);
  firstAbort.abort(new DOMException("first waiter cancelled", "AbortError"));
  await assert.rejects(first, { name: "AbortError" });
  release?.([model(provider.id, "current")]);

  assert.equal((await second).ok, true);
  assert.deepEqual((await registry.listModels(provider.id, new AbortController().signal)).map((entry) => entry.id), ["current"]);
  assert.equal((await registry.catalogStatus(provider.id))[0]?.refreshing, false);
});

test("a sole cancelled waiter aborts provider discovery and cannot commit a late result", async () => {
  const provider = new MutableProvider("cancelled");
  let providerSignal: AbortSignal | undefined;
  let release: ((value: ModelInfo[]) => void) | undefined;
  provider.list = async (signal) => {
    providerSignal = signal;
    return await new Promise<ModelInfo[]>((resolve) => { release = resolve; });
  };
  const registry = new ProviderRegistry([provider]);
  const controller = new AbortController();
  const pending = registry.refreshModels(provider.id, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(providerSignal?.aborted, true);
  release?.([model(provider.id, "too-late")]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await registry.listModels(provider.id, new AbortController().signal), []);
});

test("atomic snapshots provide last-known-good models while a provider is offline", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-model-catalog-"));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  const path = join(directory, "models.json");
  const store = new FileModelCatalogStore(path);
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  const online = new MutableProvider("durable", [model("durable", "kept", { contextTokens: 128_000 })]);
  const first = new ProviderRegistry([online], { catalogStore: store, cacheTtlMs: 10, now: () => now });

  assert.equal((await first.refreshModels("durable", new AbortController().signal)).ok, true);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path, "utf8")).providers[0].provenance, "live");

  const offline = new MutableProvider("durable");
  offline.failure = new Error("network unavailable");
  const restarted = new ProviderRegistry([offline], {
    catalogStore: new FileModelCatalogStore(path),
    cacheTtlMs: 10,
    now: () => now + 1_000,
  });
  const resolved = await restarted.resolveModel("durable", "kept", new AbortController().signal);
  assert.equal(resolved?.contextTokens, 128_000);
  assert.equal(offline.calls, 1);
  assert.deepEqual(await restarted.catalogStatus("durable"), [{
    provider: "durable",
    provenance: "persisted",
    fetchedAt: "2026-07-10T00:00:00.000Z",
    stale: true,
    refreshing: false,
    modelCount: 1,
    error: {
      category: "provider",
      message: "network unavailable",
      at: "2026-07-10T00:00:01.000Z",
    },
  }]);
});

test("best-effort refresh preserves good providers and reports bounded failures", async () => {
  const good = new MutableProvider("good", [model("good", "ready")]);
  const bad = new MutableProvider("bad");
  bad.failure = new Error(`authorization: Bearer ${"x".repeat(3_000)}`);
  const registry = new ProviderRegistry([good, bad]);
  const results = await registry.refreshAllModels(new AbortController().signal);

  assert.deepEqual(results.map((entry) => [entry.provider, entry.ok]), [["bad", false], ["good", true]]);
  assert.deepEqual((await registry.listModels(undefined, new AbortController().signal)).map((entry) => entry.id), ["ready"]);
  const failure = results[0]?.status.error;
  assert.equal(failure?.category, "provider");
  assert.match(failure?.message ?? "", /\[REDACTED\]/u);
  assert.ok(Buffer.byteLength(failure?.message ?? "", "utf8") <= 2_048);
});

test("selected exact IDs survive entitlement refresh while unselected stale entries disappear", async () => {
  const provider = new MutableProvider("selection", [
    model("selection", "selected"),
    model("selection", "remove-me"),
  ]);
  const registry = new ProviderRegistry([provider]);
  assert.equal((await registry.resolveModel(provider.id, "selected", new AbortController().signal))?.id, "selected");

  provider.models = [model("selection", "new")];
  registry.invalidateModels(provider.id);
  await registry.refreshModels(provider.id, new AbortController().signal);
  assert.deepEqual(
    (await registry.listModels(provider.id, new AbortController().signal)).map((entry) => entry.id),
    ["new", "selected"],
  );
  assert.equal(registry.releaseModel(provider.id, "selected"), true);
  registry.invalidateModels(provider.id);
  await registry.refreshModels(provider.id, new AbortController().signal);
  assert.deepEqual((await registry.listModels(provider.id, new AbortController().signal)).map((entry) => entry.id), ["new"]);
});

test("model references preserve exact matches and reject ambiguous fuzzy matches", async () => {
  const alpha = new MutableProvider("alpha", [
    model("alpha", "shared"),
    model("alpha", "coder-20250101", { displayName: "Coder dated" }),
    model("alpha", "coder-latest", { displayName: "Coder alias" }),
    model("alpha", "org/slash"),
  ]);
  const beta = new MutableProvider("beta", [model("beta", "shared")]);
  const registry = new ProviderRegistry([beta, alpha]);
  await registry.refreshAllModels(new AbortController().signal);
  const signal = new AbortController().signal;

  assert.deepEqual(
    await registry.resolveModelReference("alpha/coder-latest", signal, { refresh: false }),
    {
      query: "alpha/coder-latest",
      match: "exact",
      model: alpha.models[2],
      candidates: [alpha.models[2]],
    },
  );
  assert.equal((await registry.resolveModelReference("shared", signal, { refresh: false })).match, "ambiguous");
  assert.equal(
    (await registry.resolveModelReference("ALPHA/CODER-LATEST", signal, { refresh: false })).model?.id,
    "coder-latest",
  );
  const fuzzyAmbiguity = await registry.resolveModelReference("coder", signal, { refresh: false });
  assert.equal(fuzzyAmbiguity.match, "ambiguous");
  assert.deepEqual(fuzzyAmbiguity.candidates.map((entry) => entry.id), ["coder-latest", "coder-20250101"]);
  assert.equal((await registry.resolveModelReference("latest", signal, { refresh: false })).model?.id, "coder-latest");
  assert.equal((await registry.resolveModelReference("org/slash", signal, { refresh: false })).model?.id, "org/slash");
  assert.equal(
    (await registry.resolveModelReference("latest", signal, { provider: "alp", refresh: false })).model?.provider,
    "alpha",
  );
  assert.deepEqual(
    await registry.resolveModelReference("shared", signal, { provider: "missing", refresh: false }),
    { query: "shared", match: "none", candidates: [] },
  );
});

test("model references parse only recognized trailing thinking levels and validate model evidence", async () => {
  const observedAt = "2026-01-01T00:00:00.000Z";
  const reasoning = model("cloud.provider-v2", "org/model.v3:preview@2026", {
    capabilities: {
      tools: capability(),
      reasoning: capability("supported"),
      images: capability(),
    },
    compatibility: {
      reasoningEfforts: { value: ["LOW", "high", "none", "provider-special"], source: "provider", observedAt },
    },
  });
  const literalHigh = model("cloud.provider-v2", "literal:high");
  const requiredReasoning = model("cloud.provider-v2", "required-reasoning", {
    capabilities: {
      tools: capability(),
      reasoning: capability("supported"),
      images: capability(),
    },
    compatibility: {
      reasoningEfforts: { value: ["low", "high"], source: "provider", observedAt },
    },
  });
  const plain = model("cloud.provider-v2", "plain", {
    capabilities: {
      tools: capability(),
      reasoning: capability("unsupported"),
      images: capability(),
    },
  });
  const provider = new MutableProvider("cloud.provider-v2", [reasoning, literalHigh, requiredReasoning, plain]);
  const registry = new ProviderRegistry([provider]);
  await registry.refreshAllModels(new AbortController().signal);
  const signal = new AbortController().signal;

  assert.deepEqual(
    await registry.resolveModelReference("CLOUD.PROVIDER-V2/org/model.v3:preview@2026:HIGH", signal, { refresh: false }),
    {
      query: "CLOUD.PROVIDER-V2/org/model.v3:preview@2026:HIGH",
      match: "exact",
      model: reasoning,
      candidates: [reasoning],
      reasoningEffort: "high",
    },
  );
  assert.deepEqual(modelReasoningEfforts(requiredReasoning), ["low", "high"]);
  assert.deepEqual(
    await registry.resolveModelReference("cloud.provider-v2/required-reasoning:off", signal, { refresh: false }),
    {
      query: "cloud.provider-v2/required-reasoning:off",
      match: "unsupported-thinking",
      candidates: [requiredReasoning],
      reasoningEffort: "off",
      supportedReasoningEfforts: ["low", "high"],
    },
  );
  assert.equal(
    (await registry.resolveModelReference("cloud.provider-v2/org/model.v3:preview@2026:none", signal, { refresh: false })).reasoningEffort,
    "off",
  );
  assert.deepEqual(
    await registry.resolveModelReference("cloud.provider-v2/literal:high", signal, { refresh: false }),
    {
      query: "cloud.provider-v2/literal:high",
      match: "exact",
      model: literalHigh,
      candidates: [literalHigh],
    },
  );
  assert.deepEqual(
    await registry.resolveModelReference("cloud.provider-v2/literal:high", signal, {
      refresh: false,
      reasoningEffort: "medium",
    }),
    {
      query: "cloud.provider-v2/literal:high",
      match: "exact",
      model: literalHigh,
      candidates: [literalHigh],
      reasoningEffort: "medium",
    },
  );
  assert.equal(
    (await registry.resolveModelReference("cloud.provider-v2/org/model.v3:preview@2026:turbo", signal, { refresh: false })).match,
    "none",
  );
  assert.deepEqual(
    await registry.resolveModelReference("cloud.provider-v2/plain:high", signal, { refresh: false }),
    {
      query: "cloud.provider-v2/plain:high",
      match: "unsupported-thinking",
      candidates: [plain],
      reasoningEffort: "high",
      supportedReasoningEfforts: ["off"],
    },
  );
  await assert.rejects(
    registry.requireModelReference("cloud.provider-v2/plain:high", signal, { refresh: false }),
    /does not support thinking level high; supported levels: off/u,
  );
  await assert.rejects(
    registry.requireModelReference("cloud.provider-v2/plain", signal, { refresh: false, reasoningEffort: "turbo" }),
    /Thinking level must be one of/u,
  );
  assert.deepEqual(
    await registry.requireModelReference("cloud.provider-v2/org/model.v3:preview@2026:low", signal, { refresh: false }),
    {
      provider: "cloud.provider-v2",
      model: "org/model.v3:preview@2026",
      info: reasoning,
      match: "exact",
      reasoningEffort: "low",
    },
  );
});

test("fuzzy provider references must be unambiguous and return useful provider candidates", async () => {
  const alpha = new MutableProvider("alpha", [model("alpha", "one")]);
  const alpine = new MutableProvider("alpine", [model("alpine", "two")]);
  const registry = new ProviderRegistry([alpha, alpine]);
  await registry.refreshAllModels(new AbortController().signal);

  assert.deepEqual(
    await registry.resolveModelReference("one", new AbortController().signal, { provider: "alp", refresh: false }),
    {
      query: "one",
      match: "ambiguous",
      candidates: [],
      providerCandidates: ["alpha", "alpine"],
    },
  );
  assert.deepEqual(
    await registry.resolveModelReference("alp/one", new AbortController().signal, { refresh: false }),
    {
      query: "alp/one",
      match: "ambiguous",
      candidates: [],
      providerCandidates: ["alpha", "alpine"],
    },
  );
  await assert.rejects(
    registry.requireModelReference("one", new AbortController().signal, { provider: "alp", refresh: false }),
    /ambiguous; choose one of: alpha, alpine/u,
  );
});

test("a unique inline provider prefix resolves to its canonical provider", async () => {
  const provider = new MutableProvider("alpha-provider", [model("alpha-provider", "org/model-v1")]);
  const registry = new ProviderRegistry([provider]);
  await registry.refreshAllModels(new AbortController().signal);

  assert.deepEqual(
    await registry.requireModelReference("alpha/org/model-v1", new AbortController().signal, { refresh: false }),
    {
      provider: "alpha-provider",
      model: "org/model-v1",
      info: provider.models[0],
      match: "exact",
    },
  );
});

test("an explicit unknown provider fails provider preflight before model resolution", async () => {
  const registry = new ProviderRegistry([
    new MutableProvider("available-provider", [model("available-provider", "model-a")]),
  ]);

  await assert.rejects(
    registry.requireModelReference("model-a", new AbortController().signal, {
      provider: "unavailable-provider",
      allowUnknownModel: true,
      refresh: false,
    }),
    /Provider adapter is not registered: unavailable-provider/u,
  );
});

test("an inline canonical provider never falls through to another provider's slash-bearing model ID", async () => {
  const direct = new MutableProvider("openai", [model("openai", "known")]);
  const gatewayModel = model("gateway", "openai/missing");
  const gateway = new MutableProvider("gateway", [gatewayModel]);
  const registry = new ProviderRegistry([direct, gateway]);
  await registry.refreshAllModels(new AbortController().signal);
  const signal = new AbortController().signal;

  assert.deepEqual(
    await registry.resolveModelReference("openai/missing", signal, { refresh: false }),
    { query: "openai/missing", match: "none", candidates: [] },
  );
  assert.deepEqual(
    (await registry.requireModelReference("gateway/openai/missing", signal, { refresh: false })).info,
    gatewayModel,
  );
});

test("explicit providers preserve bounded custom model IDs without weakening strict lookup", async () => {
  const provider = new MutableProvider("custom.provider-v1", [model("custom.provider-v1", "catalogued")]);
  const registry = new ProviderRegistry([provider]);
  await registry.refreshAllModels(new AbortController().signal);
  const signal = new AbortController().signal;

  await assert.rejects(
    registry.requireModelReference("org/model:v2@preview", signal, { provider: "custom.provider-v1", refresh: false }),
    /No model matches/u,
  );
  assert.deepEqual(
    await registry.requireModelReference("CUSTOM.PROVIDER-V1/org/model:v2@preview:high", signal, {
      provider: "custom.prov",
      refresh: false,
      allowUnknownModel: true,
    }),
    {
      provider: "custom.provider-v1",
      model: "org/model:v2@preview",
      match: "custom",
      reasoningEffort: "high",
    },
  );
  assert.equal(
    (await registry.requireModelReference("custom.prov/catalogued", signal, {
      provider: "custom.prov",
      refresh: false,
    })).model,
    "catalogued",
  );
  assert.deepEqual(
    await registry.requireModelReference("org/model:v2@preview:turbo", signal, {
      provider: "custom.provider-v1",
      refresh: false,
      allowUnknownModel: true,
    }),
    {
      provider: "custom.provider-v1",
      model: "org/model:v2@preview:turbo",
      match: "custom",
    },
  );
  assert.deepEqual(
    await registry.requireModelReference("org/model:v2@preview:high", signal, {
      provider: "custom.provider-v1",
      refresh: false,
      allowUnknownModel: true,
      reasoningEffort: "low",
    }),
    {
      provider: "custom.provider-v1",
      model: "org/model:v2@preview:high",
      match: "custom",
      reasoningEffort: "low",
    },
  );
  assert.deepEqual(
    await registry.requireModelReference("custom.prov/org/inline-custom:high", signal, {
      refresh: false,
      allowUnknownModel: true,
    }),
    {
      provider: "custom.provider-v1",
      model: "org/inline-custom",
      match: "custom",
      reasoningEffort: "high",
    },
  );
  assert.deepEqual(
    await registry.requireModelReference("custom.prov/org/explicit-custom", signal, {
      provider: "custom.prov",
      refresh: false,
      allowUnknownModel: true,
    }),
    {
      provider: "custom.provider-v1",
      model: "org/explicit-custom",
      match: "custom",
    },
  );
});

test("maintained reasoning evidence fills unknown values without overriding explicit evidence", async () => {
  const explicit = model("openai", "o3-explicit", {
    capabilities: {
      tools: capability(),
      reasoning: capability("unsupported"),
      images: capability(),
    },
  });
  const provider = new MutableProvider("openai", [model("openai", "o3-mini"), explicit]);
  const registry = new ProviderRegistry([provider]);
  const models = await registry.listModels("openai", new AbortController().signal, { refresh: true });

  assert.deepEqual(models[0]?.capabilities.reasoning, {
    value: "unsupported",
    source: "provider",
    observedAt: OBSERVED_AT,
  });
  assert.deepEqual(models[1]?.capabilities.reasoning, {
    value: "supported",
    source: "maintained",
    observedAt: models[1]?.capabilities.reasoning.observedAt,
  });
});

test("invalid live catalogs leave last-known-good state intact", async () => {
  const provider = new MutableProvider("bounded", [model("bounded", "one")]);
  const registry = new ProviderRegistry([provider], { maxModelsPerProvider: 1 });
  await registry.refreshModels(provider.id, new AbortController().signal);
  provider.models = [model("bounded", "two"), model("bounded", "three")];
  const failed = await registry.refreshModels(provider.id, new AbortController().signal);

  assert.equal(failed.ok, false);
  assert.equal(failed.status.error?.category, "validation");
  assert.deepEqual((await registry.listModels(provider.id, new AbortController().signal)).map((entry) => entry.id), ["one"]);
});

test("corrupt and oversized persisted snapshots are isolated as catalog status", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-model-corrupt-"));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  const path = join(directory, "models.json");
  await writeFile(path, "{".repeat(100));
  const provider = new MutableProvider("offline");
  const registry = new ProviderRegistry([provider], {
    catalogStore: new FileModelCatalogStore(path),
    maxSnapshotBytes: 64,
  });
  const status = (await registry.catalogStatus(provider.id))[0];

  assert.equal(status?.provenance, "none");
  assert.equal(status?.error?.category, "persistence");
  assert.match(status?.error?.message ?? "", /exceeds 64 bytes/u);
});

test("persistence failures do not discard a valid live catalog", async () => {
  const store: ModelCatalogStore = {
    async read() { return undefined; },
    async write() { throw new Error("read-only filesystem"); },
  };
  const provider = new MutableProvider("memory", [model("memory", "usable")]);
  const registry = new ProviderRegistry([provider], { catalogStore: store });
  const refresh = await registry.refreshModels(provider.id, new AbortController().signal);

  assert.equal(refresh.ok, true);
  assert.equal(refresh.status.provenance, "live");
  assert.equal(refresh.status.error?.category, "persistence");
  assert.equal((await registry.resolveModel(provider.id, "usable", new AbortController().signal))?.id, "usable");
});

test("typed compatibility and normalized pricing survive snapshots while raw metadata is dropped", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-model-metadata-"));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  const path = join(directory, "models.json");
  const compatibility: NonNullable<ModelInfo["compatibility"]> = {
    protocolFamily: { value: "openai-chat-completions", source: "maintained", observedAt: OBSERVED_AT },
    inputModalities: { value: ["text", "image"], source: "provider", observedAt: OBSERVED_AT },
    outputModalities: { value: ["text"], source: "provider", observedAt: OBSERVED_AT },
    reasoningEfforts: { value: ["low", "high"], source: "provider", observedAt: OBSERVED_AT },
    strictTools: { value: "unsupported", source: "maintained", observedAt: OBSERVED_AT },
    toolStreaming: { value: "supported", source: "maintained", observedAt: OBSERVED_AT },
    deferredTools: { value: "supported", source: "maintained", observedAt: OBSERVED_AT },
    cacheMode: { value: "explicit", source: "configuration", observedAt: OBSERVED_AT },
    cacheAffinity: { value: "prefix", source: "configuration", observedAt: OBSERVED_AT },
    cacheTiers: { value: ["5m", "1h"], source: "configuration", observedAt: OBSERVED_AT },
    sessionAffinity: { value: "stateless", source: "maintained", observedAt: OBSERVED_AT },
  };
  const pricing: NonNullable<ModelInfo["pricing"]> = {
    currency: "USD",
    unit: "per_million_tokens",
    source: "provider",
    observedAt: OBSERVED_AT,
    input: 1.25,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.5,
    tiers: [
      { name: "base", minimumInputTokens: 0, maximumInputTokens: 200_000, input: 1.25, output: 5 },
      { name: "long-context", minimumInputTokens: 200_001, input: 2.5, output: 7.5 },
    ],
  };
  const provider = new MutableProvider("rich", [model("rich", "rich-v1", {
    compatibility,
    pricing,
    metadata: { arbitrary: { rawSecretLikeField: "must-not-persist" } },
  })]);
  const now = Date.parse(OBSERVED_AT);
  const first = new ProviderRegistry([provider], {
    catalogStore: new FileModelCatalogStore(path),
    now: () => now,
  });
  assert.equal((await first.refreshModels(provider.id, new AbortController().signal)).ok, true);
  const serialized = await readFile(path, "utf8");
  assert.doesNotMatch(serialized, /must-not-persist|rawSecretLikeField|arbitrary/u);
  assert.deepEqual(JSON.parse(serialized).providers[0].models[0].compatibility, compatibility);
  assert.deepEqual(JSON.parse(serialized).providers[0].models[0].pricing, pricing);

  const restarted = new ProviderRegistry([new MutableProvider("rich")], {
    catalogStore: new FileModelCatalogStore(path),
    now: () => now,
  });
  const restored = (await restarted.listModels("rich", new AbortController().signal))[0];
  assert.deepEqual(restored?.compatibility, compatibility);
  assert.deepEqual(restored?.pricing, pricing);
  assert.equal(restored?.metadata, undefined);
});

test("catalog metadata validation is exact, bounded, finite, and preserves the last-known-good model", async () => {
  const provider = new MutableProvider("metadata-validation", [model("metadata-validation", "kept")]);
  const registry = new ProviderRegistry([provider]);
  await registry.refreshModels(provider.id, new AbortController().signal);
  const base = model(provider.id, "invalid");
  const invalid: unknown[] = [
    { ...base, compatibility: { unknownField: true } },
    {
      ...base,
      compatibility: {
        protocolFamily: { value: "openai-responses", source: "guess", observedAt: OBSERVED_AT },
      },
    },
    {
      ...base,
      compatibility: {
        reasoningEfforts: {
          value: Array.from({ length: 33 }, (_, index) => `effort-${index}`),
          source: "provider",
          observedAt: OBSERVED_AT,
        },
      },
    },
    {
      ...base,
      pricing: {
        currency: "USD",
        unit: "per_million_tokens",
        source: "provider",
        observedAt: OBSERVED_AT,
        input: -1,
      },
    },
    {
      ...base,
      pricing: {
        currency: "USD",
        unit: "per_million_tokens",
        source: "provider",
        observedAt: OBSERVED_AT,
        output: Number.POSITIVE_INFINITY,
      },
    },
    {
      ...base,
      pricing: {
        currency: "USD",
        unit: "per_million_tokens",
        source: "provider",
        observedAt: OBSERVED_AT,
        tiers: [{ name: "inverted", minimumInputTokens: 100, maximumInputTokens: 10, input: 1 }],
      },
    },
  ];
  for (const value of invalid) {
    provider.models = [value as ModelInfo];
    registry.invalidateModels(provider.id);
    const refresh = await registry.refreshModels(provider.id, new AbortController().signal);
    assert.equal(refresh.ok, false);
    assert.equal(refresh.status.error?.category, "validation");
    assert.deepEqual((await registry.listModels(provider.id, new AbortController().signal)).map((entry) => entry.id), ["kept"]);
  }
});

test("a corrupt persisted provider is isolated without discarding valid provider metadata", async () => {
  const capabilityValue = capability();
  const persisted = {
    version: 1,
    savedAt: OBSERVED_AT,
    providers: [
      {
        provider: "good-snapshot",
        provenance: "live",
        fetchedAt: OBSERVED_AT,
        models: [{
          id: "good-v1",
          provider: "good-snapshot",
          capabilities: { tools: capabilityValue, reasoning: capabilityValue, images: capabilityValue },
          compatibility: {
            protocolFamily: { value: "ollama-chat", source: "maintained", observedAt: OBSERVED_AT },
          },
        }],
      },
      {
        provider: "bad-snapshot",
        provenance: "live",
        fetchedAt: OBSERVED_AT,
        models: [{
          id: "bad-v1",
          provider: "bad-snapshot",
          capabilities: { tools: capabilityValue, reasoning: capabilityValue, images: capabilityValue },
          pricing: {
            currency: "USD",
            unit: "per_million_tokens",
            source: "provider",
            observedAt: OBSERVED_AT,
            input: -1,
          },
        }],
      },
    ],
  };
  const store: ModelCatalogStore = {
    async read() { return JSON.stringify(persisted); },
    async write() {},
  };
  const registry = new ProviderRegistry([
    new MutableProvider("good-snapshot"),
    new MutableProvider("bad-snapshot"),
  ], { catalogStore: store, now: () => Date.parse(OBSERVED_AT) });

  assert.deepEqual((await registry.listModels("good-snapshot", new AbortController().signal)).map((entry) => entry.id), ["good-v1"]);
  assert.deepEqual(await registry.listModels("bad-snapshot", new AbortController().signal), []);
  const statuses = await registry.catalogStatus();
  assert.equal(statuses.find((entry) => entry.provider === "good-snapshot")?.provenance, "persisted");
  assert.equal(statuses.find((entry) => entry.provider === "bad-snapshot")?.provenance, "none");
  assert.equal(statuses[0]?.error?.category, "validation");
});

test("hydration isolates a persisted provider whose catalog plus configured additions exceeds the bound", async () => {
  const persisted = {
    version: 1,
    savedAt: OBSERVED_AT,
    providers: [{
      provider: "bounded-config",
      provenance: "live",
      fetchedAt: OBSERVED_AT,
      models: [model("bounded-config", "persisted")],
    }],
  };
  const store: ModelCatalogStore = {
    async read() { return JSON.stringify(persisted); },
    async write() {},
  };
  const registry = new ProviderRegistry([new MutableProvider("bounded-config")], {
    catalogStore: store,
    maxModelsPerProvider: 1,
    configuredModels: [{ provider: "bounded-config", id: "configured" }],
    now: () => Date.parse(OBSERVED_AT),
  });

  assert.deepEqual(
    (await registry.listModels("bounded-config", new AbortController().signal, { refresh: false })).map((entry) => entry.id),
    ["configured"],
  );
  assert.deepEqual(await registry.catalogStatus("bounded-config"), [{
    provider: "bounded-config",
    provenance: "none",
    stale: true,
    refreshing: false,
    modelCount: 1,
    error: {
      category: "validation",
      message: "Provider bounded-config persisted catalog plus configured models exceeds 1 models",
      at: OBSERVED_AT,
    },
  }]);
});

test("retiring one registry cannot erase the durable catalog used by its replacement", async () => {
  let serialized: string | undefined;
  const store: ModelCatalogStore = {
    async read() { return serialized; },
    async write(value) { serialized = value; },
  };
  const provider = new MutableProvider("replacement", [model("replacement", "live-model")]);
  const previous = new ProviderRegistry([provider], { catalogStore: store, now: () => Date.parse(OBSERVED_AT) });
  assert.equal((await previous.refreshModels(provider.id, new AbortController().signal)).ok, true);

  const active = new ProviderRegistry([new MutableProvider("replacement")], {
    catalogStore: store,
    now: () => Date.parse(OBSERVED_AT),
  });
  assert.deepEqual(
    (await active.listModels("replacement", new AbortController().signal, { refresh: false })).map((entry) => entry.id),
    ["live-model"],
  );

  assert.equal(previous.unregister(provider.id, provider, { preservePersistedCatalog: true }), true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const restarted = new ProviderRegistry([new MutableProvider("replacement")], {
    catalogStore: store,
    now: () => Date.parse(OBSERVED_AT),
  });
  assert.deepEqual(
    (await restarted.listModels("replacement", new AbortController().signal, { refresh: false })).map((entry) => entry.id),
    ["live-model"],
  );
});
