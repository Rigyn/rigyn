import assert from "node:assert/strict";
import test from "node:test";

import type { AdapterEvent, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import type { ModelCatalogStore } from "../../src/providers/model-catalog-store.js";
import { parseConfiguredModels, ProviderRegistry } from "../../src/providers/registry.js";

const observedAt = "2026-08-11T00:00:00.000Z";
const unknown = { value: "unknown" as const, source: "provider" as const, observedAt };

function model(maxInputTokens: number): ModelInfo {
  return {
    id: "bounded",
    provider: "bounded",
    contextTokens: 200_000,
    maxInputTokens,
    maxOutputTokens: 32_000,
    capabilities: { tools: unknown, reasoning: unknown, images: unknown },
  };
}

class CatalogProvider implements ProviderAdapter {
  readonly id = "bounded";
  constructor(readonly models: ModelInfo[]) {}
  async *stream(_request: ProviderRequest, _signal: AbortSignal): AsyncIterable<AdapterEvent> {}
  async listModels(): Promise<ModelInfo[]> { return this.models; }
}

test("configured model parsing accepts only valid published input ceilings", () => {
  assert.deepEqual(parseConfiguredModels([{
    provider: "bounded",
    id: "bounded",
    maxInputTokens: 160_000,
  }]), [{ provider: "bounded", id: "bounded", maxInputTokens: 160_000 }]);
  for (const maxInputTokens of [0, Number.NaN]) {
    assert.throws(
      () => parseConfiguredModels([{ provider: "bounded", id: "bounded", maxInputTokens }]),
      /maxInputTokens must be a positive integer/u,
    );
  }
});

test("published input ceilings survive durable catalog persistence", async () => {
  let serialized: string | undefined;
  const store: ModelCatalogStore = {
    async read() { return serialized; },
    async write(value) { serialized = value; },
  };
  const first = new ProviderRegistry([new CatalogProvider([model(160_000)])], {
    catalogStore: store,
    now: () => Date.parse(observedAt),
  });
  assert.equal((await first.refreshModels("bounded", new AbortController().signal)).ok, true);
  assert.equal(
    JSON.parse(serialized ?? "null").providers[0].models[0].maxInputTokens,
    160_000,
  );

  const restarted = new ProviderRegistry([new CatalogProvider([])], {
    catalogStore: store,
    now: () => Date.parse(observedAt),
  });
  assert.equal(
    (await restarted.listModels("bounded", new AbortController().signal, { refresh: false }))[0]?.maxInputTokens,
    160_000,
  );
});
