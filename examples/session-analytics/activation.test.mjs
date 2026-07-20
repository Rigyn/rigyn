import assert from "node:assert/strict";
import test from "node:test";

import activate from "./runtime/index.mjs";

test("session analytics reports the durable host aggregate without recomputing transcript history", async () => {
  let tool;
  const calls = [];
  activate({
    registerTool(value) { tool = value; },
    async getSessionUsage(input) {
      calls.push(input);
      return {
        threadId: input.threadId,
        branch: input.branch,
        runCount: 3,
        responseCount: 5,
        usageEventCount: 5,
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
          cacheReadTokens: 80,
          cacheWriteTokens: 10,
          cost: "0.0125",
          durationMs: 4200,
        },
        cache: {
          status: "effective",
          samples: 5,
          observedInputTokens: 120,
          uncachedInputTokens: 30,
          cacheReadTokens: 80,
          cacheWriteTokens: 10,
          reuseRatio: 0.6667,
        },
      };
    },
  });
  const result = await tool.execute({}, {
    threadId: "thread-usage",
    branch: "main",
    signal: new AbortController().signal,
  });
  const value = JSON.parse(result.content);
  assert.deepEqual(calls.map(({ threadId, branch }) => ({ threadId, branch })), [{ threadId: "thread-usage", branch: "main" }]);
  assert.equal(value.tokens.totalTokens, 150);
  assert.equal(value.tokens.cacheReadTokens, 80);
  assert.equal(value.tokens.cost, "0.0125");
  assert.equal(value.cache.status, "effective");
});
