import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalMessage } from "../../src/core/types.js";
import {
  deriveContextBudget,
  estimateContextTokenUsage,
  estimateMessageTokens,
  estimateTextTokens,
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

test("the model context window uses the configured reserve and trigger defaults", () => {
  assert.deepEqual(
    deriveContextBudget({ contextTokens: 128_000, maxOutputTokens: 8_192 }),
    {
      contextWindowTokens: 128_000,
      reservedOutputTokens: 16_384,
      safetyMarginTokens: 0,
      maxInputTokens: 128_000,
      compactAtTokens: 111_616,
    },
  );
  assert.deepEqual(
    deriveContextBudget(
      { contextTokens: 128_000, maxOutputTokens: 8_192 },
      { requestedMaxOutputTokens: 4_096 },
    ),
    {
      contextWindowTokens: 128_000,
      reservedOutputTokens: 16_384,
      safetyMarginTokens: 0,
      maxInputTokens: 128_000,
      compactAtTokens: 111_616,
    },
  );
  assert.equal(deriveContextBudget({ maxOutputTokens: 4_096 }), undefined);
  assert.deepEqual(
    deriveContextBudget({ contextTokens: 128_000 }),
    {
      contextWindowTokens: 128_000,
      reservedOutputTokens: 16_384,
      safetyMarginTokens: 0,
      maxInputTokens: 128_000,
      compactAtTokens: 111_616,
    },
  );
});

test("budget clamping always leaves a positive input allowance", () => {
  assert.deepEqual(
    deriveContextBudget({ contextTokens: 4_096, maxOutputTokens: 8_192 }),
    {
      contextWindowTokens: 4_096,
      reservedOutputTokens: 4_095,
      safetyMarginTokens: 0,
      maxInputTokens: 4_096,
      compactAtTokens: 1,
    },
  );
});

test("matching observed usage can only raise a conservative estimate", () => {
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
  assert.equal(observed.source, "usage_floor");
  assert.ok(observed.tokens >= 500 + estimateMessageTokens(messages[1]!));

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
  assert.deepEqual(lowObservation, fallback);
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

test("fixed request overhead is included with estimated and observed usage", () => {
  const messages = [textMessage("m1", "short")];
  const base = estimateContextTokenUsage(messages, { provider: "openai", model: "exact" });
  const withOverhead = estimateContextTokenUsage(messages, {
    provider: "openai",
    model: "exact",
    additionalTokens: 321,
  });
  assert.equal(withOverhead.tokens, base.tokens + 321);
});
