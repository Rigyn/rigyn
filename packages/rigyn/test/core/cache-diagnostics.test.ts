import assert from "node:assert/strict";
import test from "node:test";

import {
  addCacheMiss,
  analyzeCacheEffectiveness,
  cacheBoundaryFingerprint,
  emptyCacheWasteTotals,
  observeCacheRequest,
  type CacheBoundaryParts,
  type CacheBoundaryReason,
} from "../../src/core/cache-diagnostics.js";

test("cache diagnostics distinguish unavailable, cold, effective, and churn telemetry", () => {
  assert.deepEqual(analyzeCacheEffectiveness([{ inputTokens: 100 }]), {
    status: "unavailable",
    samples: 0,
    observedInputTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });

  const cold = analyzeCacheEffectiveness([{ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 900 }]);
  assert.equal(cold.status, "cold");
  assert.equal(cold.reuseRatio, 0);
  assert.match(cold.guidance ?? "", /first cache write/u);

  const effective = analyzeCacheEffectiveness([
    { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 900 },
    { inputTokens: 100, cacheReadTokens: 1_800, cacheWriteTokens: 0 },
  ]);
  assert.equal(effective.status, "effective");
  assert.equal(effective.reuseRatio, 1_800 / 2_900);
  assert.equal(effective.guidance, undefined);

  const churn = analyzeCacheEffectiveness([
    { inputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 100 },
    { inputTokens: 850, cacheReadTokens: 0, cacheWriteTokens: 150 },
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

test("cache request observations count token and cost waste above the noise floor", () => {
  const first = observeCacheRequest(undefined, {
    provider: "fixture",
    model: "one",
    usage: {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 100_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0.375, total: 0.375 },
    },
    timestamp: 0,
    cacheReadPrice: 0.3,
  });
  assert.equal(first.miss, undefined);

  const healthy = observeCacheRequest(first.current, {
    provider: "fixture",
    model: "one",
    usage: {
      inputTokens: 0,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 5_000,
      cost: { input: 0, output: 0, cacheRead: 0.03, cacheWrite: 0.019, total: 0.049 },
    },
    timestamp: 60_000,
    cacheReadPrice: 0.3,
  });
  assert.equal(healthy.miss, undefined);

  const missed = observeCacheRequest(healthy.current, {
    provider: "fixture",
    model: "one",
    usage: {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 110_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0.4125, total: 0.4125 },
    },
    timestamp: 600_000,
    cacheReadPrice: 0.3,
  });
  assert.equal(missed.miss?.missedTokens, 105_000);
  assert.ok(Math.abs((missed.miss?.missedCost ?? 0) - 0.36225) < 0.000001);
  assert.equal(missed.miss?.idleMs, 540_000);
  assert.equal(missed.boundaryChange, undefined);
  assert.deepEqual(addCacheMiss(emptyCacheWasteTotals(), missed.miss), {
    missedTokens: 105_000,
    missedCost: missed.miss?.missedCost,
    missCount: 1,
  });
});

test("cache request observations reset on missing telemetry and ignore small misses", () => {
  const missing = observeCacheRequest(undefined, {
    provider: "fixture",
    model: "one",
    usage: { inputTokens: 10_000 },
    timestamp: 0,
  });
  assert.equal(missing.current, undefined);

  const missingRead = observeCacheRequest(undefined, {
    provider: "fixture",
    model: "one",
    usage: { inputTokens: 10_000, cacheWriteTokens: 0 },
    timestamp: 0,
  });
  assert.equal(missingRead.current, undefined);

  const missingWrite = observeCacheRequest(undefined, {
    provider: "fixture",
    model: "one",
    usage: { inputTokens: 10_000, cacheReadTokens: 0 },
    timestamp: 0,
  });
  assert.equal(missingWrite.current, undefined);

  const first = observeCacheRequest(undefined, {
    provider: "fixture",
    model: "one",
    usage: { cacheWriteTokens: 5_000 },
    timestamp: 0,
  });
  const small = observeCacheRequest(first.current, {
    provider: "fixture",
    model: "two",
    usage: { inputTokens: 1_024, cacheReadTokens: 4_000, cacheWriteTokens: 0 },
    timestamp: 1,
  });
  assert.equal(small.miss, undefined);
});

test("cache request observations reject an unsafe prompt-token baseline", () => {
  const result = observeCacheRequest(undefined, {
    provider: "fixture",
    model: "one",
    usage: {
      inputTokens: Number.MAX_SAFE_INTEGER,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
    },
    timestamp: 0,
  });

  assert.deepEqual(result, { current: undefined, miss: undefined });
});

test("cache request observations suppress a non-finite derived miss cost", () => {
  const result = observeCacheRequest({
    provider: "fixture",
    model: "one",
    promptTokens: 2_000,
    timestamp: 0,
    cacheObserved: true,
  }, {
    provider: "fixture",
    model: "one",
    usage: {
      inputTokens: 2_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: {
        input: Number.MAX_VALUE,
        output: 0,
        cacheRead: 0,
        cacheWrite: Number.MAX_VALUE,
        total: Number.MAX_VALUE,
      },
    },
    timestamp: 1,
  });

  assert.equal(result.current?.promptTokens, 2_000);
  assert.equal(result.miss, undefined);
});

test("cache effectiveness is unavailable when any contributing request lacks a cache dimension", () => {
  const incomplete = analyzeCacheEffectiveness([
    { inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0 },
    { inputTokens: 100, cacheReadTokens: 25 },
  ]);
  assert.equal(incomplete.status, "unavailable");
  assert.equal(incomplete.samples, 1);

  const explicitZero = analyzeCacheEffectiveness([
    { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ]);
  assert.notEqual(explicitZero.status, "unavailable");
  assert.equal(explicitZero.samples, 1);
});

test("cache effectiveness excludes samples that would overflow its safe aggregate", () => {
  const result = analyzeCacheEffectiveness([
    { inputTokens: Number.MAX_SAFE_INTEGER, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { inputTokens: Number.MAX_SAFE_INTEGER, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ]);

  assert.deepEqual(result, {
    status: "unavailable",
    samples: 1,
    observedInputTokens: Number.MAX_SAFE_INTEGER,
    uncachedInputTokens: Number.MAX_SAFE_INTEGER,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

test("cache waste accumulation is atomic when any derived total is unsafe", () => {
  const total = {
    missedTokens: Number.MAX_SAFE_INTEGER,
    missedCost: Number.MAX_VALUE,
    missCount: Number.MAX_SAFE_INTEGER,
  };
  const result = addCacheMiss(total, {
    missedTokens: 1,
    missedCost: Number.MAX_VALUE,
    idleMs: 0,
    modelChanged: false,
  });

  assert.deepEqual(result, total);
  assert.equal(Number.isSafeInteger(result.missedTokens), true);
  assert.equal(Number.isSafeInteger(result.missCount), true);
  assert.equal(Number.isFinite(result.missedCost), true);
});

test("cache request observations exclude newly appended prompt tail from a miss", () => {
  const baseline = observeCacheRequest(undefined, {
    provider: "fixture",
    model: "one",
    usage: { cacheWriteTokens: 80_000 },
    timestamp: 0,
  });
  const appended = observeCacheRequest(baseline.current, {
    provider: "fixture",
    model: "one",
    usage: {
      inputTokens: 20_000,
      cacheReadTokens: 80_000,
      cacheWriteTokens: 20_000,
    },
    timestamp: 1,
  });

  assert.equal(appended.current?.promptTokens, 120_000);
  assert.equal(appended.miss, undefined);
});

test("cache request observations start a new epoch at expected structural boundaries", () => {
  const base: CacheBoundaryParts = {
    api: "responses",
    endpointScope: "primary",
    credentialScope: "account-a",
    instructionFingerprint: "instructions-a",
    toolFingerprint: "tools-a",
    cacheRetention: "short",
    transport: "sse",
    continuationGeneration: "connection-a",
    session: "session-a",
    branch: "branch-a",
    compaction: "checkpoint-a",
  };
  const changes: ReadonlyArray<readonly [CacheBoundaryReason, keyof CacheBoundaryParts, string]> = [
    ["api", "api", "messages"],
    ["endpoint", "endpointScope", "secondary"],
    ["credential", "credentialScope", "account-b"],
    ["instructions", "instructionFingerprint", "instructions-b"],
    ["tools", "toolFingerprint", "tools-b"],
    ["retention", "cacheRetention", "long"],
    ["transport", "transport", "websocket"],
    ["continuation", "continuationGeneration", "connection-b"],
    ["session", "session", "session-b"],
    ["branch", "branch", "branch-b"],
    ["compaction", "compaction", "checkpoint-b"],
  ];

  for (const [reason, key, value] of changes) {
    const first = observeCacheRequest(undefined, {
      provider: "fixture",
      model: "one",
      usage: { inputTokens: 30_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      timestamp: 0,
      cacheBoundary: cacheBoundaryFingerprint(base),
    });
    const next = observeCacheRequest(first.current, {
      provider: "fixture",
      model: "one",
      usage: { inputTokens: 31_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      timestamp: 1,
      cacheBoundary: cacheBoundaryFingerprint({ ...base, [key]: value }),
      cacheBoundaryReason: reason,
    });
    assert.equal(next.miss, undefined, reason);
    assert.equal(next.boundaryChange, reason);
    assert.deepEqual(addCacheMiss(emptyCacheWasteTotals(), next.miss), emptyCacheWasteTotals());
  }
});

test("cache boundary fingerprints are deterministic and do not retain source identifiers", () => {
  const left = cacheBoundaryFingerprint({
    endpointScope: "private-endpoint-alias",
    credentialScope: "private-account-alias",
    api: "responses",
  });
  const right = cacheBoundaryFingerprint({
    api: "responses",
    credentialScope: "private-account-alias",
    endpointScope: "private-endpoint-alias",
  });
  assert.equal(left, right);
  assert.match(left, /^cache-v1:[a-f0-9]{64}$/u);
  assert.doesNotMatch(left, /private/u);
});

test("cache request observations reset provider and model routes without recording waste", () => {
  const first = observeCacheRequest(undefined, {
    provider: "provider-a",
    model: "model-a",
    usage: { inputTokens: 30_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    timestamp: 0,
  });
  const provider = observeCacheRequest(first.current, {
    provider: "provider-b",
    model: "model-a",
    usage: { inputTokens: 31_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    timestamp: 1,
  });
  assert.equal(provider.miss, undefined);
  assert.equal(provider.boundaryChange, "provider");

  const model = observeCacheRequest(provider.current, {
    provider: "provider-b",
    model: "model-b",
    usage: { inputTokens: 32_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    timestamp: 2,
  });
  assert.equal(model.miss, undefined);
  assert.equal(model.boundaryChange, "model");
});

test("explicit zero cache counters remain measured and known idle expiry starts a new epoch", () => {
  const first = observeCacheRequest(undefined, {
    provider: "fixture",
    model: "one",
    usage: { inputTokens: 30_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    timestamp: 0,
  });
  assert.equal(first.current?.cacheObserved, true);

  const missed = observeCacheRequest(first.current, {
    provider: "fixture",
    model: "one",
    usage: { inputTokens: 31_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    timestamp: 60_000,
    cacheIdleExpiryPossible: true,
  });
  assert.equal(missed.miss?.missedTokens, 30_000);
  assert.equal(missed.miss?.possibleIdleExpiry, true);

  const expired = observeCacheRequest(missed.current, {
    provider: "fixture",
    model: "one",
    usage: { inputTokens: 32_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    timestamp: 180_000,
    cacheIdleExpiryMs: 120_000,
  });
  assert.equal(expired.miss, undefined);
  assert.equal(expired.boundaryChange, "retention");
});
