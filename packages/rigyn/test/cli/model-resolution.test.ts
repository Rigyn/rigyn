import assert from "node:assert/strict";
import test from "node:test";

import { resolveRequestedModel } from "../../src/cli/model-resolution.js";
import type { AdapterEvent, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import { ModelReferenceResolutionError, ProviderRegistry } from "../../src/providers/registry.js";

const observedAt = "2026-01-01T00:00:00.000Z";
const unknown = { value: "unknown" as const, source: "provider" as const, observedAt };

function model(provider: string, id: string, efforts?: string[]): ModelInfo {
  return {
    provider,
    id,
    capabilities: { tools: unknown, reasoning: unknown, images: unknown },
    ...(efforts === undefined
      ? {}
      : { compatibility: { reasoningEfforts: { value: efforts, source: "provider", observedAt } } }),
  };
}

class CatalogProvider implements ProviderAdapter {
  constructor(readonly id: string, readonly models: ModelInfo[]) {}
  async *stream(_request: ProviderRequest, _signal: AbortSignal): AsyncIterable<AdapterEvent> {
    throw new Error("unused");
  }
  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    signal.throwIfAborted();
    return this.models;
  }
}

async function registry(): Promise<ProviderRegistry> {
  const result = new ProviderRegistry([
    new CatalogProvider("alpha-provider", [
      model("alpha-provider", "coder-v1", ["low", "high"]),
      model("alpha-provider", "coder-v2", ["low", "high"]),
      model("alpha-provider", "literal:high"),
    ]),
    new CatalogProvider("fallback", [model("fallback", "fallback-v1")]),
  ]);
  await result.refreshAllModels(new AbortController().signal);
  return result;
}

test("CLI resolver canonicalizes inline providers and validates thinking metadata", async () => {
  const providers = await registry();
  const signal = new AbortController().signal;
  const selected = await resolveRequestedModel(providers, {
    reference: "alpha/coder-v1:HIGH",
    fallbackProvider: "fallback",
    refresh: false,
  }, signal);
  const { info, ...selection } = selected;
  assert.equal(info?.id, "coder-v1");
  assert.deepEqual(selection, {
    provider: "alpha-provider",
    model: "coder-v1",
    match: "exact",
    reasoningEffort: "high",
  });
  await assert.rejects(
    resolveRequestedModel(providers, {
      reference: "alpha/coder-v1:off",
      fallbackProvider: "fallback",
      refresh: false,
    }, signal),
    /does not support thinking level off; supported levels: low, high/u,
  );
});

test("CLI resolver rejects fuzzy ambiguity instead of falling back", async () => {
  const providers = await registry();
  await assert.rejects(
    resolveRequestedModel(providers, {
      reference: "coder",
      fallbackProvider: "fallback",
      refresh: false,
    }, new AbortController().signal),
    (error) => error instanceof ModelReferenceResolutionError
      && error.resolution.match === "ambiguous"
      && error.resolution.candidates.length === 2,
  );
});

test("CLI resolver preserves custom slash IDs and explicit thinking precedence", async () => {
  const providers = await registry();
  const signal = new AbortController().signal;
  assert.deepEqual(
    await resolveRequestedModel(providers, {
      reference: "org/custom:model@2026:high",
      fallbackProvider: "fallback",
      refresh: false,
    }, signal),
    {
      provider: "fallback",
      model: "org/custom:model@2026",
      match: "custom",
      reasoningEffort: "high",
    },
  );
  const literal = await resolveRequestedModel(providers, {
    reference: "literal:high",
    provider: "alpha-provider",
    reasoningEffort: "medium",
    refresh: false,
  }, signal);
  const { info, ...selection } = literal;
  assert.equal(info?.id, "literal:high");
  assert.deepEqual(selection, {
    provider: "alpha-provider",
    model: "literal:high",
    match: "exact",
    reasoningEffort: "medium",
  });
});
