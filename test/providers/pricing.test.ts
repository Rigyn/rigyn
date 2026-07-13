import assert from "node:assert/strict";
import test from "node:test";

import type { AdapterEvent, ModelInfo, ModelPricing, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import { calculateUsageCost, withUsagePricing } from "../../src/providers/pricing.js";

const observedAt = "2026-07-11T00:00:00.000Z";

function pricing(values: Partial<ModelPricing>): ModelPricing {
  return {
    currency: "USD",
    unit: "per_million_tokens",
    source: "maintained",
    observedAt,
    ...values,
  };
}

function model(modelPricing: ModelPricing): ModelInfo {
  const unknown = { value: "unknown" as const, source: "provider" as const, observedAt };
  return {
    id: "priced-model",
    provider: "priced",
    capabilities: { tools: unknown, reasoning: unknown, images: unknown },
    pricing: modelPricing,
  };
}

test("usage pricing calculates input, output, cache read, and generic cache write exactly", () => {
  assert.equal(calculateUsageCost({
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 500,
    cacheWriteTokens: 100,
    totalTokens: 1_800,
  }, pricing({ input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 3.125 })), "0.0049375");
});

test("Anthropic 5m and 1h cache writes use their distinct published rates", () => {
  assert.equal(calculateUsageCost({
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 50,
    totalTokens: 200,
    raw: {
      cache_creation: {
        ephemeral_5m_input_tokens: 20,
        ephemeral_1h_input_tokens: 30,
      },
    },
  }, pricing({
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    cacheWrite5m: 12.5,
    cacheWrite1h: 20,
  }), { cacheWrite5mTokens: 20, cacheWrite1hTokens: 30 }), "0.00288");
});

test("provider-reported costs win and incomplete pricing never under-reports", () => {
  const incomplete = pricing({ input: 1 });
  assert.equal(calculateUsageCost({ inputTokens: 10, outputTokens: 2, cost: "0.75" }, incomplete), "0.75");
  assert.equal(calculateUsageCost({ inputTokens: 10, outputTokens: 2 }, incomplete), undefined);
  assert.equal(calculateUsageCost({ totalTokens: 12 }, pricing({ input: 1, output: 2 })), undefined);
});

test("expired promotional pricing becomes unknown while provider-reported cost still wins", () => {
  const promotional = pricing({ input: 2, output: 10, validUntil: "2026-09-01T00:00:00.000Z" });
  assert.equal(calculateUsageCost(
    { inputTokens: 10, outputTokens: 2 },
    promotional,
    { at: Date.parse("2026-09-01T00:00:00.000Z") },
  ), undefined);
  assert.equal(calculateUsageCost(
    { inputTokens: 10, outputTokens: 2, cost: "0.50" },
    promotional,
    { at: Date.parse("2027-01-01T00:00:00.000Z") },
  ), "0.50");
});

test("pricing tiers apply to the full request at deterministic boundaries", () => {
  const tiered = pricing({
    input: 2,
    output: 8,
    tiers: [{ name: "long", minimumInputTokens: 101, input: 4, output: 12 }],
  });
  assert.equal(calculateUsageCost({ inputTokens: 100, outputTokens: 10, totalTokens: 110 }, tiered), "0.00028");
  assert.equal(calculateUsageCost({ inputTokens: 101, outputTokens: 10, totalTokens: 111 }, tiered), "0.000524");
});

test("priced adapter carries cache lifetime detail across cumulative snapshots without double counting", async () => {
  const adapter: ProviderAdapter = {
    id: "priced",
    async *stream(): AsyncIterable<AdapterEvent> {
      yield {
        type: "usage",
        semantics: "cumulative",
        usage: {
          inputTokens: 100,
          cacheReadTokens: 30,
          cacheWriteTokens: 50,
          totalTokens: 180,
          raw: {
            cache_creation: {
              ephemeral_5m_input_tokens: 20,
              ephemeral_1h_input_tokens: 30,
            },
          },
        },
      };
      yield {
        type: "usage",
        semantics: "cumulative",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheWriteTokens: 50,
          totalTokens: 200,
          raw: { output_tokens: 20 },
        },
      };
    },
    async listModels() { return []; },
  };
  const modelInfo = model(pricing({
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    cacheWrite5m: 12.5,
    cacheWrite1h: 20,
  }));
  const priced = withUsagePricing(adapter, () => modelInfo);
  const request = {
    provider: "priced",
    model: "priced-model",
    messages: [],
    tools: [],
  } satisfies ProviderRequest;
  const costs: string[] = [];
  for await (const event of priced.stream(request, new AbortController().signal)) {
    if (event.type === "usage" && event.usage.cost !== undefined) costs.push(event.usage.cost);
  }
  assert.deepEqual(costs, ["0.00188", "0.00288"]);
});
