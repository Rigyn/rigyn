import assert from "node:assert/strict";
import test from "node:test";

import { normalizeUsage } from "../../src/providers/usage.js";

test("usage normalization makes cache and input counters mutually exclusive", () => {
  assert.deepEqual(normalizeUsage({
    raw: { provider: "openai" },
    inputTokens: 1_000,
    outputTokens: 100,
    reportedTotalTokens: 1_100,
    cacheReadTokens: 700,
    cacheWriteTokens: 100,
    cacheWrite1hTokens: 25,
    reasoningTokens: 40,
    inputIncludesCache: true,
  }), {
    raw: { provider: "openai" },
    inputTokens: 200,
    outputTokens: 100,
    cacheReadTokens: 700,
    cacheWriteTokens: 100,
    cacheWrite1hTokens: 25,
    reasoningTokens: 40,
    totalTokens: 1_100,
  });

  assert.deepEqual(normalizeUsage({
    raw: { provider: "anthropic" },
    inputTokens: 200,
    outputTokens: 100,
    cacheReadTokens: 700,
    cacheWriteTokens: 100,
  }), {
    raw: { provider: "anthropic" },
    inputTokens: 200,
    outputTokens: 100,
    cacheReadTokens: 700,
    cacheWriteTokens: 100,
    totalTokens: 1_100,
  });
});

test("usage normalization reconciles provider totals containing reasoning and tool prompt tokens", () => {
  assert.deepEqual(normalizeUsage({
    raw: { provider: "gemini" },
    inputTokens: 1_000,
    cacheReadTokens: 800,
    additionalInputTokens: 50,
    outputTokens: 100,
    reasoningTokens: 200,
    reportedTotalTokens: 1_350,
    inputIncludesCache: true,
    reconcileOutputFromTotal: true,
  }), {
    raw: { provider: "gemini" },
    inputTokens: 250,
    outputTokens: 300,
    cacheReadTokens: 800,
    reasoningTokens: 200,
    totalTokens: 1_350,
  });

  assert.deepEqual(normalizeUsage({
    raw: { provider: "gemini-missing-prompt" },
    additionalInputTokens: 50,
    outputTokens: 100,
    reportedTotalTokens: 1_000,
    reconcileOutputFromTotal: true,
  }), {
    raw: { provider: "gemini-missing-prompt" },
    outputTokens: 100,
    totalTokens: 1_000,
  });
});

test("usage normalization rejects invalid components but retains a valid native-only total", () => {
  assert.deepEqual(normalizeUsage({
    raw: {},
    inputTokens: -1,
    outputTokens: 1.5,
    cacheReadTokens: Number.NaN,
    reportedTotalTokens: 9,
  }), { raw: {}, totalTokens: 9 });
  assert.deepEqual(normalizeUsage({
    raw: { source: "cache-exceeds-input" },
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 200,
    reportedTotalTokens: 110,
    inputIncludesCache: true,
  }), {
    raw: { source: "cache-exceeds-input" },
    outputTokens: 10,
    cacheReadTokens: 200,
  });
});

test("usage normalization never manufactures unsafe token arithmetic", () => {
  assert.deepEqual(normalizeUsage({
    raw: { source: "additional-input" },
    inputTokens: Number.MAX_SAFE_INTEGER,
    additionalInputTokens: 1,
  }), { raw: { source: "additional-input" } });

  assert.deepEqual(normalizeUsage({
    raw: { source: "derived-total" },
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }), { raw: { source: "derived-total" } });
});

test("usage normalization keeps reported totals but derives only protocol-safe totals", () => {
  assert.deepEqual(normalizeUsage({
    raw: {},
    inputTokens: 1_000,
    outputTokens: 100,
    inputIncludesCache: true,
  }), { raw: {}, inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 });
  assert.deepEqual(normalizeUsage({
    raw: {},
    inputTokens: 1_000,
    outputTokens: 100,
    cacheReadTokens: 200,
    inputIncludesCache: true,
  }), { raw: {}, inputTokens: 800, outputTokens: 100, cacheReadTokens: 200, totalTokens: 1_100 });
  assert.deepEqual(normalizeUsage({
    raw: {},
    inputTokens: 800,
    outputTokens: 100,
    cacheReadTokens: 200,
  }), { raw: {}, inputTokens: 800, outputTokens: 100, cacheReadTokens: 200 });
  assert.deepEqual(normalizeUsage({
    raw: {},
    inputTokens: 800,
    outputTokens: 100,
    cacheReadTokens: 200,
    cacheWriteTokens: 0,
  }), {
    raw: {},
    inputTokens: 800,
    outputTokens: 100,
    cacheReadTokens: 200,
    cacheWriteTokens: 0,
    totalTokens: 1_100,
  });
  assert.equal(normalizeUsage({
    raw: {},
    inputTokens: 800,
    outputTokens: 100,
    cacheReadTokens: 200,
    reportedTotalTokens: 1_100,
  }).totalTokens, 1_100);
  assert.deepEqual(normalizeUsage({
    raw: { provider: "openai-inconsistent-total" },
    inputTokens: 1_000,
    outputTokens: 100,
    cacheReadTokens: 200,
    reportedTotalTokens: 5,
    inputIncludesCache: true,
  }), {
    raw: { provider: "openai-inconsistent-total" },
    inputTokens: 800,
    outputTokens: 100,
    cacheReadTokens: 200,
    totalTokens: 1_100,
  });
  assert.deepEqual(normalizeUsage({
    raw: { provider: "bedrock" },
    inputTokens: 200,
    outputTokens: 100,
    reportedTotalTokens: 1_100,
    cacheReadTokens: 700,
    reconcileInputFromTotal: true,
  }), {
    raw: { provider: "bedrock" },
    inputTokens: 300,
    outputTokens: 100,
    cacheReadTokens: 700,
    totalTokens: 1_100,
  });
});

test("usage normalization retains only coherent cache lifetimes and structured cost", () => {
  const cost = { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 };
  assert.deepEqual(normalizeUsage({
    raw: {},
    inputTokens: 10,
    cacheWriteTokens: 5,
    cacheWrite1hTokens: 3,
    cost,
  }), {
    raw: {},
    inputTokens: 10,
    cacheWriteTokens: 5,
    cacheWrite1hTokens: 3,
    cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite },
  });
  assert.equal(normalizeUsage({ raw: {}, cacheWriteTokens: 2, cacheWrite1hTokens: 3 }).cacheWrite1hTokens, undefined);
  assert.equal(normalizeUsage({ raw: {}, inputTokens: 1, cost: "0.1" }).cost, undefined);
});
