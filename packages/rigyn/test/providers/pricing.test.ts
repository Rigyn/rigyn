import assert from "node:assert/strict";
import test from "node:test";

import type { AdapterEvent, ModelInfo, ModelPricing, ProviderAdapter, ProviderRequest, UsageCost } from "../../src/core/types.js";
import { applyUsagePricing, calculateUsageCost, withUsagePricing } from "../../src/providers/pricing.js";

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

test("usage pricing does not price omitted cache counters as zero", () => {
  const rates = pricing({ input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 3.125 });
  assert.equal(calculateUsageCost({ inputTokens: 1_000, outputTokens: 100 }, rates), undefined);
  assert.equal(calculateUsageCost({
    inputTokens: 800,
    outputTokens: 100,
    cacheReadTokens: 200,
  }, rates), undefined);
  assert.notEqual(calculateUsageCost({
    inputTokens: 1_000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }, rates), undefined);
});

test("usage pricing never emits non-finite derived cost", () => {
  assert.equal(calculateUsageCost({
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }, pricing({ input: Number.MAX_VALUE, output: 0, cacheRead: 0, cacheWrite: 0 })), undefined);
  assert.equal(calculateUsageCost({
    inputTokens: 0.5,
    outputTokens: 0.25,
    cacheReadTokens: 0.5,
    cacheWriteTokens: 0,
  }, pricing({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })), undefined);
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

test("usage pricing rejects hostile provider events before inspecting them", async () => {
  for (const kind of ["accessor", "proxy", "nested-accessor"] as const) {
    let reads = 0;
    let resumed = 0;
    let closed = false;
    const hostile = kind === "accessor"
      ? Object.defineProperty({}, "type", {
          enumerable: true,
          get() {
            reads += 1;
            return "response_start";
          },
        })
      : kind === "proxy"
        ? new Proxy({}, {
            get(_target, key) {
              if (key === "type") reads += 1;
              return key === "type" ? "response_start" : undefined;
            },
          })
        : {
            type: "usage",
            semantics: "final",
            get usage() {
              reads += 1;
              return { inputTokens: 1 };
            },
          };
    const adapter: ProviderAdapter = {
      id: "hostile",
      async *stream() {
        try {
          yield hostile as AdapterEvent;
          resumed += 1;
          yield { type: "response_start", model: "late" };
        } finally {
          closed = true;
        }
      },
      async listModels() { return []; },
    };
    const priced = withUsagePricing(adapter, () => undefined);
    const events: AdapterEvent[] = [];

    for await (const event of priced.stream({
      provider: "hostile",
      model: "one",
      messages: [],
      tools: [],
    }, new AbortController().signal)) events.push(event);

    assert.equal(reads, 0, kind);
    assert.equal(resumed, 0, kind);
    assert.equal(closed, true, kind);
    assert.equal(events.length, 1, kind);
    assert.equal(events[0]?.type, "error", kind);
    if (events[0]?.type === "error") {
      assert.equal(events[0].error.category, "protocol", kind);
      assert.equal(events[0].error.retryable, false, kind);
      assert.equal(events[0].error.partial, false, kind);
      assert.equal(events[0].error.bodyStarted, false, kind);
    }
  }
});

test("usage pricing marks a malformed event partial only after validated provider output", async () => {
  let reads = 0;
  const hostile = Object.defineProperty({}, "type", {
    enumerable: true,
    get() {
      reads += 1;
      return "response_start";
    },
  });
  const adapter: ProviderAdapter = {
    id: "partial-hostile",
    async *stream() {
      yield { type: "text_delta", part: 0, text: "partial" };
      yield hostile as AdapterEvent;
    },
    async listModels() { return []; },
  };
  const priced = withUsagePricing(adapter, () => undefined);
  const events: AdapterEvent[] = [];

  for await (const event of priced.stream({
    provider: "partial-hostile",
    model: "one",
    messages: [],
    tools: [],
  }, new AbortController().signal)) events.push(event);

  assert.equal(reads, 0);
  assert.equal(events[0]?.type, "text_delta");
  assert.equal(events[1]?.type, "error");
  if (events[1]?.type === "error") {
    assert.equal(events[1].error.category, "protocol");
    assert.equal(events[1].error.retryable, false);
    assert.equal(events[1].error.partial, true);
    assert.equal(events[1].error.bodyStarted, true);
  }
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
  assertCost(calculateUsageCost({
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 110,
  }, tiered), {
    input: 0.0002, output: 0.00008, cacheRead: 0, cacheWrite: 0,
  });
  assertCost(calculateUsageCost({
    inputTokens: 101,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 111,
  }, tiered), {
    input: 0.000404, output: 0.00012, cacheRead: 0, cacheWrite: 0,
  });
});

test("OpenAI service tiers scale every calculated component without changing other providers", () => {
  const rates = pricing({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 3 });
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  };
  const cases = [
    { provider: "openai", id: "gpt-5.6-terra", tier: "flex", multiplier: 0.5 },
    { provider: "openai", id: "gpt-5.6-terra", tier: "priority", multiplier: 2 },
    { provider: "openai", id: "gpt-5-mini", tier: "fast", multiplier: 1.8 },
    { provider: "openai", id: "gpt-5.5", tier: "priority", multiplier: 2.5 },
    { provider: "openai", id: "gpt-4.1", tier: "priority", multiplier: 1.75 },
    { provider: "openai", id: "gpt-4o-mini", tier: "priority", multiplier: 5 / 3 },
    { provider: "openai", id: "o4-mini", tier: "priority", multiplier: 20 / 11 },
    { provider: "openai-codex", id: "gpt-5.3-codex", tier: "priority", multiplier: 2 },
    { provider: "other", id: "gpt-test", tier: "priority", multiplier: 1 },
  ] as const;
  for (const current of cases) {
    const selected = {
      ...model(rates),
      provider: current.provider,
      id: current.id,
    };
    const cost = applyUsagePricing({
      ...usage,
      raw: { service_tier: current.tier },
    }, selected).cost;
    assertCost(cost, {
      input: 1 * current.multiplier,
      output: 2 * current.multiplier,
      cacheRead: 0.5 * current.multiplier,
      cacheWrite: 3 * current.multiplier,
    });
  }

  const unsupported = applyUsagePricing({
    ...usage,
    raw: { service_tier: "priority" },
  }, {
    ...model(rates),
    provider: "openai",
    id: "gpt-5.4-pro",
  });
  assert.equal(unsupported.cost, undefined);
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
  const costs: Array<UsageCost | undefined> = [];
  for await (const event of priced.stream(request, new AbortController().signal)) {
    if (event.type === "usage") costs.push(event.usage.cost);
  }
  assert.equal(costs[0], undefined);
  assertCost(costs[1], { input: 0.001, output: 0.001, cacheRead: 0.00003, cacheWrite: 0.00085 });
});

test("priced adapter prices incremental usage only after aggregating the request tier", async () => {
  const adapter: ProviderAdapter = {
    id: "priced",
    async *stream(): AsyncIterable<AdapterEvent> {
      yield { type: "response_start", model: "priced-model" };
      yield {
        type: "usage",
        semantics: "incremental",
        usage: {
          inputTokens: 60,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 60,
          raw: { service_tier: "priority" },
        },
      };
      yield {
        type: "usage",
        semantics: "incremental",
        usage: { inputTokens: 60, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 60 },
      };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: {} },
      };
    },
    async listModels() { return []; },
  };
  const modelInfo = {
    ...model(pricing({
      input: 1,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tiers: [{ name: "long", minimumInputTokens: 101, input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }],
    })),
    provider: "openai",
    id: "gpt-5.6-terra",
  };
  const priced = withUsagePricing(adapter, () => modelInfo);
  const events: AdapterEvent[] = [];
  for await (const event of priced.stream({
    provider: "priced",
    model: "priced-model",
    messages: [],
    tools: [],
  }, new AbortController().signal)) events.push(event);

  const usages = events.filter((event): event is Extract<AdapterEvent, { type: "usage" }> => event.type === "usage");
  assert.equal(usages.length, 3);
  assert.equal(usages[0]?.semantics, "incremental");
  assert.equal(usages[0]?.usage.cost, undefined);
  assert.equal(usages[1]?.semantics, "incremental");
  assert.equal(usages[1]?.usage.cost, undefined);
  assert.equal(usages[2]?.semantics, "final");
  assert.equal(usages[2]?.usage.inputTokens, 120);
  assertCost(usages[2]?.usage.cost, { input: 0.0024, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(events.at(-1)?.type, "response_end");
});

test("priced adapter replaces cumulative usage before aggregating later increments", async () => {
  const adapter: ProviderAdapter = {
    id: "priced",
    async *stream(): AsyncIterable<AdapterEvent> {
      yield { type: "response_start", model: "priced-model" };
      yield {
        type: "usage",
        semantics: "incremental",
        usage: { inputTokens: 60, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 60 },
      };
      yield {
        type: "usage",
        semantics: "cumulative",
        usage: { inputTokens: 120, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 121 },
      };
      yield {
        type: "usage",
        semantics: "incremental",
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12 },
      };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: {} },
      };
    },
    async listModels() { return []; },
  };
  const modelInfo = model(pricing({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }));
  const priced = withUsagePricing(adapter, () => modelInfo);
  const usages: Array<Extract<AdapterEvent, { type: "usage" }>> = [];
  for await (const event of priced.stream({
    provider: "priced",
    model: "priced-model",
    messages: [],
    tools: [],
  }, new AbortController().signal)) {
    if (event.type === "usage") usages.push(event);
  }

  assert.equal(usages.at(-1)?.semantics, "final");
  assert.deepEqual(usages.at(-1)?.usage, {
    inputTokens: 130,
    outputTokens: 3,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 133,
    cost: { input: 0.00013, output: 0.000006, cacheRead: 0, cacheWrite: 0, total: 0.000136 },
  });
});
