import assert from "node:assert/strict";
import test from "node:test";

import type { ModelInfo } from "../../src/core/types.js";
import {
  baseModelCompatibility,
  mergeModelCompatibility,
  modelEvidence,
  openRouterPricing,
} from "../../src/providers/model-metadata.js";

const OBSERVED_AT = "2026-01-01T00:00:00.000Z";

function model(): ModelInfo {
  const unknown = { value: "unknown" as const, source: "provider" as const, observedAt: OBSERVED_AT };
  return {
    id: "model",
    provider: "provider",
    capabilities: { tools: unknown, reasoning: unknown, images: unknown },
    compatibility: {
      protocolFamily: modelEvidence("openai-chat-completions", "provider", OBSERVED_AT),
      cacheMode: modelEvidence("explicit", "configuration", OBSERVED_AT),
    },
  };
}

test("maintained compatibility overlays never replace provider or configuration evidence", () => {
  const input = model();
  const maintained = baseModelCompatibility("anthropic-messages", input.capabilities.tools, "2026-02-01T00:00:00.000Z");
  maintained.cacheMode = modelEvidence("automatic", "maintained", "2026-02-01T00:00:00.000Z");
  const merged = mergeModelCompatibility(input, maintained);

  assert.deepEqual(merged.compatibility?.protocolFamily, input.compatibility?.protocolFamily);
  assert.deepEqual(merged.compatibility?.cacheMode, input.compatibility?.cacheMode);
  assert.equal(merged.compatibility?.strictTools?.source, "maintained");
  assert.equal(merged.compatibility?.toolStreaming?.source, "maintained");
});

test("provider pricing normalization accepts only finite non-negative per-token fields", () => {
  assert.deepEqual(openRouterPricing({
    pricing: {
      prompt: "0.000002",
      completion: 0.00001,
      input_cache_read: "-1",
      input_cache_write: "not-a-number",
      arbitrary: "ignored",
    },
  }, OBSERVED_AT), {
    currency: "USD",
    unit: "per_million_tokens",
    source: "provider",
    observedAt: OBSERVED_AT,
    input: 2,
    output: 10,
  });
  assert.equal(openRouterPricing({ pricing: { prompt: -1, completion: Number.POSITIVE_INFINITY } }, OBSERVED_AT), undefined);
});
