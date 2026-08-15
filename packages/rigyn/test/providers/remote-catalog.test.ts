import assert from "node:assert/strict";
import test from "node:test";

import type { Provider, ProviderModel, ProviderModelsStoreEntry } from "../../src/providers/index.js";
import { withRemoteCatalog } from "../../src/providers/remote-catalog.js";

const baseline: ProviderModel = {
  id: "baseline",
  name: "Baseline",
  api: "openai-responses",
  provider: "bounded-catalog",
  baseUrl: "https://api.example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_384,
  maxTokens: 2_048,
};

const cached: ProviderModel = {
  ...baseline,
  id: "cached",
  name: "Cached",
};

function provider(): Provider {
  return {
    id: "bounded-catalog",
    name: "Bounded catalog",
    baseUrl: baseline.baseUrl,
    auth: {},
    getModels: () => [baseline],
    async *stream() {},
    async *streamSimple() {},
  };
}

function store(initial: ProviderModelsStoreEntry | undefined) {
  let value = initial;
  return {
    async read() { return value === undefined ? undefined : structuredClone(value); },
    async write(next: ProviderModelsStoreEntry) { value = structuredClone(next); },
    async delete() { value = undefined; },
  };
}

test("remote catalogs use a timeout signal, reject oversized bodies, and retain the last good overlay", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requestSignal: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => {
    requestSignal = init?.signal ?? undefined;
    return new Response("{}", {
      headers: { "content-length": String(128 * 1024 * 1024) },
    });
  };
  const wrapped = withRemoteCatalog(provider(), "https://catalog.example.test");

  await assert.rejects(wrapped.refreshModels!({
    allowNetwork: true,
    force: true,
    store: store({ models: [cached], checkedAt: 0 }),
  }), /catalog response exceeds/iu);

  assert.ok(requestSignal);
  assert.deepEqual(wrapped.getModels().map((model) => model.id), ["baseline", "cached"]);
});

test("remote catalogs reject excessive entry counts before model conversion", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({
    models: Array.from({ length: 4_097 }, (_, index) => ({ id: `model-${index}` })),
  });
  const wrapped = withRemoteCatalog(provider(), "https://catalog.example.test");

  await assert.rejects(wrapped.refreshModels!({
    allowNetwork: true,
    force: true,
    store: store({ models: [cached], checkedAt: 0 }),
  }), /too many models/iu);

  assert.deepEqual(wrapped.getModels().map((model) => model.id), ["baseline", "cached"]);
});

test("remote catalogs reject deeply nested metadata before cloning it", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let nested: Record<string, unknown> = {};
  for (let depth = 0; depth < 40; depth += 1) nested = { child: nested };
  globalThis.fetch = async () => Response.json({
    models: [{ ...baseline, compat: nested }],
  });
  const wrapped = withRemoteCatalog(provider(), "https://catalog.example.test");

  await assert.rejects(wrapped.refreshModels!({
    allowNetwork: true,
    force: true,
    store: store({ models: [cached], checkedAt: 0 }),
  }), /nested too deeply/iu);

  assert.deepEqual(wrapped.getModels().map((model) => model.id), ["baseline", "cached"]);
});

test("remote catalogs clear an overlay when the scoped cache is unavailable", async () => {
  const wrapped = withRemoteCatalog(provider(), "https://catalog.example.test");

  await wrapped.refreshModels!({
    allowNetwork: false,
    store: store({ models: [cached], checkedAt: 0 }),
  });
  assert.deepEqual(wrapped.getModels().map((model) => model.id), ["baseline", "cached"]);

  await wrapped.refreshModels!({
    allowNetwork: false,
    store: store(undefined),
  });
  assert.deepEqual(wrapped.getModels().map((model) => model.id), ["baseline"]);
});
