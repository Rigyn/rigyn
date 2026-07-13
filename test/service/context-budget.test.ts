import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AdapterEvent, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import { ProviderRegistry, type ConfiguredModel } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { resolveEffectiveContextBudget } from "../../src/context/budget.js";

function modelInfo(id: string, contextTokens: number, maxOutputTokens?: number): ModelInfo {
  const unknown = { value: "unknown" as const, source: "provider" as const, observedAt: "2026-01-01T00:00:00.000Z" };
  return {
    id,
    provider: "budget-provider",
    contextTokens,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    capabilities: { tools: unknown, reasoning: unknown, images: unknown },
  };
}

class BudgetProvider implements ProviderAdapter {
  readonly id = "budget-provider";
  readonly requests: ProviderRequest[] = [];
  catalogCalls = 0;
  readonly #models: ModelInfo[];
  readonly #catalogError: boolean;

  constructor(models: ModelInfo[], catalogError = false) {
    this.#models = models;
    this.#catalogError = catalogError;
  }

  async *stream(request: ProviderRequest, _signal: AbortSignal): AsyncIterable<AdapterEvent> {
    this.requests.push(request);
    yield { type: "response_start", model: request.model };
    yield { type: "text_delta", part: 0, text: "done" };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "done" } },
    };
  }

  async listModels(_signal: AbortSignal): Promise<ModelInfo[]> {
    this.catalogCalls += 1;
    if (this.#catalogError) throw new Error("catalog unavailable");
    return this.#models;
  }
}

class ContextLimitProvider implements ProviderAdapter {
  readonly id = "budget-provider";
  requests = 0;

  async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests += 1;
    yield { type: "response_start", model: request.model };
    yield {
      type: "response_end",
      reason: "context_limit",
      state: { kind: "chat_completions", assistantMessage: { role: "assistant" } },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [modelInfo("exact", 128_000, 4_096)];
  }
}

async function harness(
  provider: BudgetProvider,
  configuredModels: readonly ConfiguredModel[] = [],
): Promise<{ service: HarnessService; store: SessionStore }> {
  const root = await mkdtemp(join(tmpdir(), "harness-context-budget-"));
  const store = new SessionStore(":memory:");
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider], { configuredModels }),
    projectTrusted: false,
  });
  await service.initialize();
  return { service, store };
}

test("exact catalog context metadata enables automatic hard-budget enforcement", async () => {
  const provider = new BudgetProvider([modelInfo("exact", 256, 64)]);
  const runtime = await harness(provider);
  await assert.rejects(
    runtime.service.run({ prompt: "x".repeat(4_000), provider: provider.id, model: "exact" }),
    /hard budget/u,
  );
  assert.equal(provider.catalogCalls, 1);
  assert.equal(provider.requests.length, 0);
  await runtime.service.close();
  runtime.store.close();
});

test("execution and UI share explicit, catalog, and fallback context windows", () => {
  assert.equal(resolveEffectiveContextBudget(undefined, { contextTokenBudget: 96_000 }).contextWindowTokens, 96_000);
  const catalog = resolveEffectiveContextBudget({ contextTokens: 256_000, maxOutputTokens: 32_000 });
  assert.equal(catalog.contextWindowTokens, 256_000);
  assert.equal(catalog.reservedOutputTokens, 16_384);
  assert.equal(resolveEffectiveContextBudget(undefined).contextWindowTokens, 128_000);
  assert.equal(resolveEffectiveContextBudget({ contextTokens: -1 }).contextWindowTokens, 128_000);
});

test("catalog output metadata caps explicit requests and leaves omitted requests unset", async () => {
  const provider = new BudgetProvider([modelInfo("exact", 128_000, 64)]);
  const runtime = await harness(provider);
  await runtime.service.run({
    prompt: "bounded",
    provider: provider.id,
    model: "exact",
    maxOutputTokens: 4_096,
  });
  await runtime.service.run({
    prompt: "provider default",
    provider: provider.id,
    model: "exact",
  });
  assert.equal(provider.requests[0]?.maxOutputTokens, 64);
  assert.equal(provider.requests[1]?.maxOutputTokens, undefined);
  await runtime.service.close();
  runtime.store.close();
});

test("service rejects a coercible non-numeric maxOutputTokens value before provider work", async () => {
  const provider = new BudgetProvider([modelInfo("exact", 128_000, 64)]);
  const runtime = await harness(provider);
  await assert.rejects(runtime.service.run({
    prompt: "invalid",
    provider: provider.id,
    model: "exact",
    maxOutputTokens: "5" as unknown as number,
  }), /maxOutputTokens must be a positive safe integer/u);
  assert.equal(provider.requests.length, 0);
  await runtime.service.close();
  runtime.store.close();
});

test("an explicit context budget bypasses catalog-derived sizing while still resolving model capabilities", async () => {
  const provider = new BudgetProvider([modelInfo("exact", 256, 64)]);
  const runtime = await harness(provider);
  await runtime.service.run({
    prompt: "short",
    provider: provider.id,
    model: "exact",
    contextTokenBudget: 100_000,
  });
  assert.equal(provider.catalogCalls, 1);
  assert.equal(provider.requests.length, 1);
  await runtime.service.close();
  runtime.store.close();
});

test("a run-level auto-compaction choice overrides the service default immediately", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-context-budget-"));
  const store = new SessionStore(":memory:");
  const provider = new ContextLimitProvider();
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    projectTrusted: false,
    autoCompaction: true,
  });
  await service.initialize();
  t.after(async () => {
    await service.close();
    store.close();
  });

  await assert.rejects(service.run({
    prompt: "overflow",
    provider: provider.id,
    model: "exact",
    contextTokenBudget: 100_000,
    autoCompaction: false,
  }), /automatic compaction is disabled/u);
  assert.equal(provider.requests, 1);
});

test("catalog failure, model mismatch, and absent output metadata remain non-fatal", async () => {
  for (const provider of [
    new BudgetProvider([], true),
    new BudgetProvider([modelInfo("different", 256, 64)]),
    new BudgetProvider([modelInfo("exact", 128_000)]),
  ]) {
    const runtime = await harness(provider);
    await runtime.service.run({ prompt: "short", provider: provider.id, model: "exact" });
    assert.equal(provider.requests.length, 1);
    await runtime.service.close();
    runtime.store.close();
  }
});

test("unknown model metadata uses a conservative fallback instead of disabling budget enforcement", async () => {
  const provider = new BudgetProvider([], true);
  const runtime = await harness(provider);
  await assert.rejects(
    runtime.service.run({ prompt: "x".repeat(300_000), provider: provider.id, model: "unknown" }),
    /hard budget/u,
  );
  assert.equal(provider.requests.length, 0);
  await runtime.service.close();
  runtime.store.close();
});

test("configured model limits drive budgeting offline and preserve the exact wire ID", async () => {
  const boundedProvider = new BudgetProvider([], true);
  const bounded = await harness(boundedProvider, [{
    provider: boundedProvider.id,
    id: "org/deployment:preview@2026",
    contextTokens: 256,
    maxOutputTokens: 64,
  }]);
  assert.equal(boundedProvider.catalogCalls, 0);
  await assert.rejects(
    bounded.service.run({
      prompt: "x".repeat(4_000),
      provider: boundedProvider.id,
      model: "org/deployment:preview@2026",
    }),
    /hard budget/u,
  );
  assert.equal(boundedProvider.catalogCalls, 0);
  assert.equal(boundedProvider.requests.length, 0);
  await bounded.service.close();
  bounded.store.close();

  const wireProvider = new BudgetProvider([], true);
  const wire = await harness(wireProvider, [{
    provider: wireProvider.id,
    id: "org/deployment:preview@2026",
    contextTokens: 128_000,
    maxOutputTokens: 8_000,
  }]);
  await wire.service.run({
    prompt: "short",
    provider: wireProvider.id,
    model: "org/deployment:preview@2026",
  });
  assert.equal(wireProvider.requests[0]?.model, "org/deployment:preview@2026");
  assert.equal(wireProvider.catalogCalls, 0);
  await wire.service.close();
  wire.store.close();
});
