import assert from "node:assert/strict";
import test from "node:test";

import { normalizedCacheHitRate } from "../../src/core/cache-usage.js";

test("cache-hit rate uses an exact reported prompt without requiring uncached input", () => {
  assert.equal(normalizedCacheHitRate({
    totalTokens: 120,
    outputTokens: 20,
    cacheReadTokens: 80,
  }), 80);
  assert.equal(normalizedCacheHitRate({
    totalTokens: 120,
    outputTokens: 20,
    cacheReadTokens: 0,
  }), 0);
  assert.equal(normalizedCacheHitRate({ totalTokens: 120, outputTokens: 20 }), undefined);
});
