import assert from "node:assert/strict";
import test from "node:test";

import { analyzeCacheEffectiveness } from "../../src/core/cache-diagnostics.js";

test("cache diagnostics distinguish unavailable, cold, effective, and churn telemetry", () => {
  assert.deepEqual(analyzeCacheEffectiveness([{ inputTokens: 100 }]), {
    status: "unavailable",
    samples: 0,
    observedInputTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });

  const cold = analyzeCacheEffectiveness([{ inputTokens: 100, cacheWriteTokens: 900 }]);
  assert.equal(cold.status, "cold");
  assert.equal(cold.reuseRatio, 0);
  assert.match(cold.guidance ?? "", /first cache write/u);

  const effective = analyzeCacheEffectiveness([
    { inputTokens: 100, cacheWriteTokens: 900 },
    { inputTokens: 100, cacheReadTokens: 1_800 },
  ]);
  assert.equal(effective.status, "effective");
  assert.equal(effective.reuseRatio, 1_800 / 2_900);
  assert.equal(effective.guidance, undefined);

  const churn = analyzeCacheEffectiveness([
    { inputTokens: 900, cacheWriteTokens: 100 },
    { inputTokens: 850, cacheWriteTokens: 150 },
  ]);
  assert.equal(churn.status, "write_churn");
  assert.match(churn.guidance ?? "", /stable/u);
});

test("cache diagnostics do not double-count normalized cache components", () => {
  const result = analyzeCacheEffectiveness([
    { inputTokens: 100, outputTokens: 20, totalTokens: 1_020, cacheReadTokens: 800, cacheWriteTokens: 100 },
  ]);
  assert.equal(result.observedInputTokens, 1_000);
  assert.equal(result.cacheReadTokens, 800);
  assert.equal(result.cacheWriteTokens, 100);
  assert.equal(result.uncachedInputTokens, 100);
  assert.equal(result.reuseRatio, 0.8);
  assert.equal(result.status, "effective");
});
