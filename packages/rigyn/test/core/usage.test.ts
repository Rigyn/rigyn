import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_NORMALIZED_USAGE_RAW_BYTES,
  addNormalizedUsage,
  boundedUsageRaw,
  formatUsageCost,
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
    cost: { input: 0.00025, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.00125 },
    raw: { provider: "fixture" },
  };
  assert.equal(isNormalizedUsage(usage), true);
  assert.equal(isNormalizedUsage({ ...usage, totalTokens: 104 }), false);
  assert.equal(isNormalizedUsage({ ...usage, inputTokens: -1 }), false);
  assert.equal(isNormalizedUsage({ ...usage, surprise: true }), false);
  assert.equal(isNormalizedUsage({ ...usage, cost: { ...usage.cost, total: 0.5 } }), false);
  assert.equal(isNormalizedUsage({ ...usage, cacheWrite1hTokens: 1 }), false);
  assert.equal(isNormalizedUsage({ ...usage, cacheWriteTokens: 2, cacheWrite1hTokens: 3, totalTokens: 102 }), false);
  assert.equal(isNormalizedUsage({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }), false);
});

test("normalized usage aggregation preserves complete structured costs only", () => {
  const first = addNormalizedUsage(undefined, {
    inputTokens: 4,
    cacheWriteTokens: 2,
    cacheWrite1hTokens: 1,
    totalTokens: 6,
    cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0.2, total: 0.3 },
  });
  const total = addNormalizedUsage(first, {
    outputTokens: 3,
    totalTokens: 3,
    cost: { input: 0, output: 0.4, cacheRead: 0, cacheWrite: 0, total: 0.4 },
  });
  assert.deepEqual(total, {
    inputTokens: 4,
    outputTokens: 3,
    totalTokens: 9,
    cacheWriteTokens: 2,
    cacheWrite1hTokens: 1,
    cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0.2, total: 0.7 },
  });
  assert.equal(formatUsageCost(total.cost), "$0.7");
  assert.equal(addNormalizedUsage(total, { inputTokens: 1, totalTokens: 1 }).cost, undefined);
  assert.equal(addNormalizedUsage({ inputTokens: 1, totalTokens: 1 }, {
    inputTokens: 1,
    totalTokens: 1,
    cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
  }).cost, undefined);
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
