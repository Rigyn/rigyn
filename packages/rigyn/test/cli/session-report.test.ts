import assert from "node:assert/strict";
import test from "node:test";

import { formatSessionReport, formatSessionUsageReport } from "../../src/cli/session-report.js";

test("session report describes the direct JSONL session and exact model tuple", () => {
  const report = formatSessionReport({
    session: {
      id: "session-1",
      path: "/tmp/session-1.jsonl",
      cwd: "/workspace",
      name: "parser fix",
      created: new Date("2026-07-20T00:00:00.000Z"),
      modified: new Date("2026-07-20T01:00:00.000Z"),
      messageCount: 3,
      firstMessage: "fix parser",
      allMessagesText: "fix parser done",
    },
    context: {
      messages: [],
      thinkingLevel: "high",
      model: { provider: "fixture", modelId: "fixture-model" },
    },
  });
  assert.equal(report, [
    "Session: parser fix",
    "ID: session-1",
    "File: /tmp/session-1.jsonl",
    "Workspace: /workspace",
    "Messages: 3",
    "Created: 2026-07-20T00:00:00.000Z",
    "Updated: 2026-07-20T01:00:00.000Z",
    "Model: fixture/fixture-model",
  ].join("\n"));
});

test("session report includes token, cost, and cache-waste accounting when available", () => {
  const report = formatSessionReport({
    session: {
      id: "session-2",
      path: "/tmp/session-2.jsonl",
      cwd: "/workspace",
      created: new Date("2026-07-20T00:00:00.000Z"),
      modified: new Date("2026-07-20T01:00:00.000Z"),
      messageCount: 3,
      firstMessage: "test cache",
      allMessagesText: "test cache done",
    },
    stats: {
      sessionFile: "/tmp/session-2.jsonl",
      sessionId: "session-2",
      userMessages: 1,
      assistantMessages: 2,
      toolCalls: 1,
      toolResults: 1,
      totalMessages: 4,
      usage: { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 30_000, cacheWriteTokens: 2_000 },
      tokens: { input: 10_000, output: 500, cacheRead: 30_000, cacheWrite: 2_000, total: 42_500 },
      cost: 0.25,
      usageBreakdown: [],
      cacheHitPercent: 30_000 / 42_000 * 100,
      cacheWaste: { missedTokens: 15_000, missedCost: 0.12, missCount: 1 },
    },
  });
  assert.match(report, /Usage scope: complete journal \(all branches and summary requests\)/u);
  assert.match(report, /Messages: 4 total · 1 user · 2 assistant/u);
  assert.match(report, /Tokens: 42,000 prompt · 500 output · 42,500 total/u);
  assert.match(report, /Prompt cache: 30,000 read · 2,000 written/u);
  assert.match(report, /Whole-journal cache hit: 71\.43% of reported prompt tokens/u);
  assert.match(report, /Cost: \$0\.250/u);
  assert.match(report, /Active-branch cache non-reuse estimate: up to 15,000 prior-prompt tokens · 1 request · estimated added cost \$0\.120/u);
});

test("session report distinguishes missing prompt-cache telemetry from an explicit zero", () => {
  const stats = {
    sessionFile: undefined,
    sessionId: "session-cache-status",
    userMessages: 0,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 1,
    tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, total: 110 },
    cost: 0,
    usageBreakdown: [],
  };
  const missing = formatSessionUsageReport({
    ...stats,
    usage: { inputTokens: 100, outputTokens: 10 },
    tokens: { input: 100, output: 10 },
  });
  const zero = formatSessionUsageReport({
    ...stats,
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    cacheHitPercent: 0,
  });
  assert.match(missing, /Prompt cache: not reported/u);
  assert.match(missing, /Whole-journal cache hit: unavailable \(complete prompt-cache telemetry required\)/u);
  assert.match(zero, /Prompt cache: 0 read · 0 written/u);
  assert.match(zero, /Whole-journal cache hit: 0% of reported prompt tokens/u);
});

test("session report labels known cache values from incomplete telemetry as partial", () => {
  const report = formatSessionUsageReport({
    sessionFile: undefined,
    sessionId: "session-cache-partial",
    userMessages: 0,
    assistantMessages: 2,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    usage: { inputTokens: 18, outputTokens: 2, cacheWriteTokens: 2 },
    tokens: { input: 18, output: 2, cacheReadReported: 5, cacheWrite: 2 },
    cost: 0,
    usageBreakdown: [],
  });
  assert.match(report, /Tokens: at least 25 prompt · 2 output · exact total unavailable/u);
  assert.match(report, /Prompt cache: 5 read reported \(partial\) · 2 written/u);
  assert.match(report, /Whole-journal cache hit: unavailable/u);
});

test("session report labels partial token totals and cost without inventing exact values", () => {
  const report = formatSessionUsageReport({
    sessionFile: undefined,
    sessionId: "session-usage-partial",
    userMessages: 0,
    assistantMessages: 2,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    usage: {},
    tokens: {
      inputReported: 18,
      outputReported: 2,
      totalReported: 20,
    },
    costReported: 0.25,
    usageBreakdown: [{ key: "provider/model", tokensReported: 20, costReported: 0.25 }],
  });
  assert.match(report, /Tokens: at least 18 prompt · 2 output reported \(partial\) · 20 total reported \(partial\)/u);
  assert.match(report, /Cost: \$0\.250 reported \(partial\)/u);
  assert.doesNotMatch(report, /Cost: \$0\.250$/mu);
});
