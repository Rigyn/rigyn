import assert from "node:assert/strict";
import test from "node:test";

import type { AdapterEvent, ModelInfo, ModelPricing, ProviderAdapter, ProviderRequest, UsageCost } from "../../src/core/types.js";
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

function assertCost(actual: UsageCost | undefined, expected: Omit<UsageCost, "total">): void {
  assert.notEqual(actual, undefined);
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    assert.ok(Math.abs(actual![field] - expected[field]) <= 1e-15, `${field}: ${actual![field]}`);
  }
  assert.equal(actual!.total, actual!.input + actual!.output + actual!.cacheRead + actual!.cacheWrite);
}

test("usage pricing calculates numeric components and derives the total from them", () => {
  assertCost(calculateUsageCost({
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 500,
    cacheWriteTokens: 100,
    totalTokens: 1_800,
  }, pricing({ input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 3.125 })), {
    input: 0.0025,
    output: 0.002,
    cacheRead: 0.000125,
    cacheWrite: 0.0003125,
  });
});

test("mixed 5m and 1h cache writes use their distinct published rates", () => {
  assertCost(calculateUsageCost({
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 50,
    cacheWrite1hTokens: 30,
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
  }), { cacheWrite5mTokens: 20 }), {
    input: 0.001,
    output: 0.001,
    cacheRead: 0.00003,
    cacheWrite: 0.00085,
  });
});

test("provider-reported costs win and incomplete pricing never under-reports", () => {
  const incomplete = pricing({ input: 1 });
  const reported = { input: 0.1, output: 0.6, cacheRead: 0, cacheWrite: 0.05, total: 0.75 };
  assert.deepEqual(calculateUsageCost({ inputTokens: 10, outputTokens: 2, cost: reported }, incomplete), reported);
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
    { inputTokens: 10, outputTokens: 2, cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0, total: 0.5 } },
    promotional,
    { at: Date.parse("2027-01-01T00:00:00.000Z") },
  )?.total, 0.5);
});

test("pricing tiers apply to the full request at deterministic boundaries", () => {
  const tiered = pricing({
    input: 2,
    output: 8,
    tiers: [{ name: "long", minimumInputTokens: 101, input: 4, output: 12 }],
  });
  assertCost(calculateUsageCost({ inputTokens: 100, outputTokens: 10, totalTokens: 110 }, tiered), {
    input: 0.0002, output: 0.00008, cacheRead: 0, cacheWrite: 0,
  });
  assertCost(calculateUsageCost({ inputTokens: 101, outputTokens: 10, totalTokens: 111 }, tiered), {
    input: 0.000404, output: 0.00012, cacheRead: 0, cacheWrite: 0,
  });
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
  const costs: UsageCost[] = [];
  for await (const event of priced.stream(request, new AbortController().signal)) {
    if (event.type === "usage" && event.usage.cost !== undefined) costs.push(event.usage.cost);
  }
  assertCost(costs[0], { input: 0.001, output: 0, cacheRead: 0.00003, cacheWrite: 0.00085 });
  assertCost(costs[1], { input: 0.001, output: 0.001, cacheRead: 0.00003, cacheWrite: 0.00085 });
});
