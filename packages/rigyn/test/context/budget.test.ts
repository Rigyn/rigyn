import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalMessage } from "../../src/core/types.js";
import {
  deriveContextBudget,
  estimateContextTokenUsage,
  estimateMessageTokens,
  estimateTextTokens,
  estimateToolDefinitionTokens,
  resolveEffectiveContextBudget,
} from "../../src/context/index.js";

const createdAt = "2026-01-01T00:00:00.000Z";

function textMessage(id: string, text: string): CanonicalMessage {
  return { id, role: "user", content: [{ type: "text", text }], createdAt };
}

test("the fallback estimator is conservative without treating every byte as a token", () => {
  assert.equal(estimateTextTokens("a".repeat(4_000)), 2_000);
  assert.equal(estimateTextTokens("😀".repeat(100)), 267);
  const message = textMessage("m1", "a".repeat(4_000));
  assert.equal(estimateMessageTokens(message), 2_012);
  assert.ok(estimateMessageTokens(message) < Buffer.byteLength(JSON.stringify(message), "utf8"));
});

test("tool definition overhead uses the same public context estimator as agent preflight", () => {
  const definitions = [{
    name: "read",
    description: "Read one file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  }];
  assert.equal(
    estimateToolDefinitionTokens(definitions),
    estimateTextTokens(JSON.stringify(definitions)) + 8,
  );
  assert.equal(estimateToolDefinitionTokens([]), 1);
});

test("image payload bytes are not miscounted as text tokens", () => {
  const image: CanonicalMessage = {
    id: "image",
    role: "user",
    content: [{ type: "image", mediaType: "image/png", data: "a".repeat(2_000_000) }],
    createdAt,
  };
  const estimate = estimateMessageTokens(image, "anthropic");
  assert.ok(estimate >= 2_000);
  assert.ok(estimate < 3_000);
});

test("the model context window keeps fifteen percent of the window as response headroom", () => {
  assert.deepEqual(
    deriveContextBudget({ contextTokens: 128_000, maxOutputTokens: 8_192 }),
    {
      contextWindowTokens: 128_000,
      reservedOutputTokens: 19_200,
      safetyMarginTokens: 0,
      maxInputTokens: 108_800,
      compactAtTokens: 108_800,
    },
  );
  assert.deepEqual(
    deriveContextBudget(
      { contextTokens: 128_000, maxOutputTokens: 8_192 },
      { requestedMaxOutputTokens: 4_096 },
    ),
    {
      contextWindowTokens: 128_000,
      reservedOutputTokens: 19_200,
      safetyMarginTokens: 0,
      maxInputTokens: 108_800,
      compactAtTokens: 108_800,
    },
  );
  assert.equal(deriveContextBudget({ maxOutputTokens: 4_096 }), undefined);
  assert.deepEqual(
    deriveContextBudget({ contextTokens: 128_000 }),
    {
      contextWindowTokens: 128_000,
      reservedOutputTokens: 19_200,
      safetyMarginTokens: 0,
      maxInputTokens: 108_800,
      compactAtTokens: 108_800,
    },
  );
});

test("small windows apply the same proportional response headroom", () => {
  assert.deepEqual(
    deriveContextBudget({ contextTokens: 4_096, maxOutputTokens: 8_192 }),
    {
      contextWindowTokens: 4_096,
      reservedOutputTokens: 615,
      safetyMarginTokens: 0,
      maxInputTokens: 3_481,
      compactAtTokens: 3_481,
    },
  );
});

test("small windows accept an explicit output ceiling whenever at least one input token remains", () => {
  assert.deepEqual(
    deriveContextBudget({ contextTokens: 1_000 }, { requestedMaxOutputTokens: 900 }),
    {
      contextWindowTokens: 1_000,
      reservedOutputTokens: 900,
      safetyMarginTokens: 0,
      maxInputTokens: 100,
      compactAtTokens: 100,
    },
  );
  assert.throws(
    () => deriveContextBudget({ contextTokens: 1_000 }, { requestedMaxOutputTokens: 1_000 }),
    /leaves no model context for input/u,
  );
});

test("large windows stay proportional and explicit output requests can move the trigger earlier", () => {
  assert.deepEqual(
    deriveContextBudget({ contextTokens: 372_000 }),
    {
      contextWindowTokens: 372_000,
      reservedOutputTokens: 55_800,
      safetyMarginTokens: 0,
      maxInputTokens: 316_200,
      compactAtTokens: 316_200,
    },
  );
  assert.deepEqual(
    deriveContextBudget(
      { contextTokens: 128_000, maxOutputTokens: 64_000 },
      { requestedMaxOutputTokens: 40_000 },
    ),
    {
      contextWindowTokens: 128_000,
      reservedOutputTokens: 40_000,
      safetyMarginTokens: 0,
      maxInputTokens: 88_000,
      compactAtTokens: 88_000,
    },
  );
});

test("published input ceilings independently bound model prompt budgets", () => {
  assert.deepEqual(
    deriveContextBudget({
      contextTokens: 400_000,
      maxInputTokens: 272_000,
      maxOutputTokens: 128_000,
    }),
    {
      contextWindowTokens: 400_000,
      reservedOutputTokens: 60_000,
      safetyMarginTokens: 0,
      maxInputTokens: 272_000,
      compactAtTokens: 272_000,
    },
  );
  assert.deepEqual(
    deriveContextBudget(
      { contextTokens: 200_000, maxInputTokens: 160_000, maxOutputTokens: 32_000 },
      { requestedMaxOutputTokens: 32_000 },
    ),
    {
      contextWindowTokens: 200_000,
      reservedOutputTokens: 32_000,
      safetyMarginTokens: 0,
      maxInputTokens: 160_000,
      compactAtTokens: 160_000,
    },
  );
});

test("an explicit total context window cannot bypass a published input ceiling", () => {
  assert.deepEqual(
    resolveEffectiveContextBudget(
      { contextTokens: 200_000, maxInputTokens: 160_000, maxOutputTokens: 32_000 },
      { contextTokenBudget: 400_000, requestedMaxOutputTokens: 32_000 },
    ),
    {
      contextWindowTokens: 400_000,
      reservedOutputTokens: 60_000,
      safetyMarginTokens: 0,
      maxInputTokens: 160_000,
      compactAtTokens: 160_000,
    },
  );
});

test("deliberate reserve and trigger overrides replace the ratio defaults", () => {
  assert.deepEqual(
    deriveContextBudget(
      { contextTokens: 128_000 },
      { reserveTokens: 10_000, triggerPercent: 80 },
    ),
    {
      contextWindowTokens: 128_000,
      reservedOutputTokens: 10_000,
      safetyMarginTokens: 0,
      maxInputTokens: 118_000,
      compactAtTokens: 102_400,
    },
  );
});

test("the effective context budget keeps fallback settings without inventing model metadata", () => {
  assert.deepEqual(
    resolveEffectiveContextBudget(undefined, { reserveTokens: 10_000, triggerPercent: 80 }),
    {
      contextWindowTokens: 128_000,
      reservedOutputTokens: 10_000,
      safetyMarginTokens: 0,
      maxInputTokens: 118_000,
      compactAtTokens: 102_400,
    },
  );
});

test("trigger percentages are bounded and every supported budget preserves output headroom", () => {
  assert.throws(
    () => deriveContextBudget({ contextTokens: 128_000 }, { triggerPercent: 49 }),
    /triggerPercent must be an integer from 50 through 95/u,
  );
  assert.throws(
    () => deriveContextBudget({ contextTokens: 8_000 }, { requestedMaxOutputTokens: 8_000 }),
    /leaves no model context for input/u,
  );
  for (const contextTokens of [1_000, 8_000, 32_000, 128_000, 372_000, 1_050_000]) {
    for (const triggerPercent of [50, 88, 95]) {
      const budget = deriveContextBudget({ contextTokens }, { triggerPercent });
      assert.ok(budget !== undefined);
      const expectedReserve = Math.max(1, Math.ceil(contextTokens * 0.15));
      const expectedInput = contextTokens - expectedReserve;
      const expectedTrigger = Math.min(expectedInput, Math.floor(contextTokens * triggerPercent / 100));
      assert.equal(budget.reservedOutputTokens, expectedReserve);
      assert.equal(budget.maxInputTokens, expectedInput);
      assert.equal(budget.compactAtTokens, expectedTrigger);
      assert.equal(budget.maxInputTokens + budget.reservedOutputTokens, contextTokens);
    }
  }
});

test("explicit output requests reserve their exact ceiling across window sizes", () => {
  for (const contextTokens of [8_000, 32_000, 128_000, 372_000, 1_050_000]) {
    const requestedMaxOutputTokens = contextTokens - 1_024;
    const budget = deriveContextBudget({ contextTokens }, { requestedMaxOutputTokens });
    assert.ok(budget !== undefined);
    assert.equal(budget.reservedOutputTokens, requestedMaxOutputTokens);
    assert.equal(budget.maxInputTokens, 1_024);
    assert.equal(budget.compactAtTokens, 1_024);
  }
});

test("matching observed usage replaces the conservative prefix estimate", () => {
  const messages = [textMessage("m1", "short"), textMessage("m2", "trailing")];
  const fallback = estimateContextTokenUsage(messages, { provider: "openai", model: "exact" });
  const observed = estimateContextTokenUsage(messages, {
    provider: "openai",
    model: "exact",
    usageBaseline: {
      provider: "openai",
      model: "exact",
      inputTokens: 500,
      prefixMessageIds: ["m1"],
    },
  });
  assert.equal(fallback.source, "estimated");
  assert.equal(observed.source, "usage_baseline");
  assert.equal(observed.tokens, 500 + estimateMessageTokens(messages[1]!));

  const lowObservation = estimateContextTokenUsage(messages, {
    provider: "openai",
    model: "exact",
    usageBaseline: {
      provider: "openai",
      model: "exact",
      inputTokens: 1,
      prefixMessageIds: ["m1"],
    },
  });
  assert.deepEqual(lowObservation, {
    tokens: 1 + estimateMessageTokens(messages[1]!),
    source: "usage_baseline",
  });
});

test("provider, model, and exact prefix mismatches make observed usage stale", () => {
  const messages = [textMessage("m1", "short"), textMessage("m2", "trailing")];
  const fallback = estimateContextTokenUsage(messages, { provider: "openai", model: "exact" });
  for (const usageBaseline of [
    { provider: "anthropic", model: "exact", inputTokens: 10_000, prefixMessageIds: ["m1"] },
    { provider: "openai", model: "other", inputTokens: 10_000, prefixMessageIds: ["m1"] },
    { provider: "openai", model: "exact", inputTokens: 10_000, prefixMessageIds: ["different"] },
  ]) {
    assert.deepEqual(
      estimateContextTokenUsage(messages, { provider: "openai", model: "exact", usageBaseline }),
      fallback,
    );
  }
});

test("fixed request overhead is estimated only when no matching observation already includes it", () => {
  const messages = [textMessage("m1", "short")];
  const base = estimateContextTokenUsage(messages, { provider: "openai", model: "exact" });
  const withOverhead = estimateContextTokenUsage(messages, {
    provider: "openai",
    model: "exact",
    additionalTokens: 321,
  });
  assert.equal(withOverhead.tokens, base.tokens + 321);
  assert.deepEqual(estimateContextTokenUsage(messages, {
    provider: "openai",
    model: "exact",
    additionalTokens: 321,
    usageBaseline: {
      provider: "openai",
      model: "exact",
      inputTokens: 500,
      prefixMessageIds: ["m1"],
    },
  }), { tokens: 500, source: "usage_baseline" });
});

test("context estimates saturate instead of publishing unsafe token counts", () => {
  const messages = [textMessage("m1", "x")];
  assert.deepEqual(estimateContextTokenUsage(messages, {
    additionalTokens: Number.MAX_SAFE_INTEGER,
  }), { tokens: Number.MAX_SAFE_INTEGER, source: "estimated" });
  assert.deepEqual(estimateContextTokenUsage(messages, {
    provider: "openai",
    model: "exact",
    usageBaseline: {
      provider: "openai",
      model: "exact",
      inputTokens: Number.MAX_SAFE_INTEGER,
      prefixMessageIds: [],
    },
  }), { tokens: Number.MAX_SAFE_INTEGER, source: "usage_baseline" });
});
