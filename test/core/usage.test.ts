import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_NORMALIZED_USAGE_RAW_BYTES,
  boundedUsageRaw,
  isNormalizedUsage,
  normalizedContextTokens,
  normalizedTotalTokens,
} from "../../src/core/usage.js";

test("normalized usage validates canonical counters and exact totals", () => {
  const usage = {
    inputTokens: 20,
    outputTokens: 10,
    cacheReadTokens: 70,
    totalTokens: 100,
    reasoningTokens: 4,
    cost: "0.00125",
    raw: { provider: "fixture" },
  };
  assert.equal(isNormalizedUsage(usage), true);
  assert.equal(isNormalizedUsage({ ...usage, totalTokens: 104 }), false);
  assert.equal(isNormalizedUsage({ ...usage, inputTokens: -1 }), false);
  assert.equal(isNormalizedUsage({ ...usage, surprise: true }), false);
  assert.equal(isNormalizedUsage({ ...usage, cost: "USD 0.00125" }), false);
  assert.equal(isNormalizedUsage({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }), false);
});

test("normalized usage context and totals do not double-count reasoning detail", () => {
  const usage = {
    inputTokens: 20,
    outputTokens: 10,
    cacheReadTokens: 70,
    cacheWriteTokens: 5,
    reasoningTokens: 4,
  };
  assert.equal(normalizedContextTokens(usage), 95);
  assert.equal(normalizedTotalTokens(usage), 105);
  assert.equal(normalizedTotalTokens({ ...usage, totalTokens: 105 }), 105);
  assert.equal(normalizedContextTokens({}), undefined);
});

test("raw usage telemetry is detached and bounded", () => {
  const source = { nested: { value: "safe" } };
  const bounded = boundedUsageRaw(source);
  source.nested.value = "mutated";
  assert.deepEqual(bounded, { nested: { value: "safe" } });

  const oversized = boundedUsageRaw({ payload: "x".repeat(MAX_NORMALIZED_USAGE_RAW_BYTES) });
  assert.deepEqual(oversized, {
    originalBytes: MAX_NORMALIZED_USAGE_RAW_BYTES + Buffer.byteLength('{"payload":""}', "utf8"),
    truncated: true,
  });
});
