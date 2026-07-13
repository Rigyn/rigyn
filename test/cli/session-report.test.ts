import assert from "node:assert/strict";
import test from "node:test";

import { formatSessionReport } from "../../src/cli/session-report.js";
import type { EventEnvelope } from "../../src/core/events.js";
import type { RuntimeEvent } from "../../src/core/events.js";

function envelope(sequence: number, event: RuntimeEvent, runId = "run_1"): EventEnvelope {
  return {
    eventId: `event_${sequence}`,
    threadId: "thread_1",
    runId,
    sequence,
    timestamp: new Date(sequence * 1_000).toISOString(),
    schemaVersion: 1,
    event,
  };
}

test("session report is concise and aggregates final and incremental usage by run", () => {
  const report = formatSessionReport({
    thread: {
      threadId: "thread_1",
      name: "parser fix",
      defaultBranch: "main",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T01:00:00.000Z",
      workspaceRoot: "/workspace",
      branches: [
        { threadId: "thread_1", name: "main", createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T01:00:00.000Z" },
        { threadId: "thread_1", name: "experiment", createdAt: "2026-07-10T00:30:00.000Z", updatedAt: "2026-07-10T00:40:00.000Z" },
      ],
    },
    branch: "main",
    databasePath: "/state/sessions.sqlite",
    provider: "openai",
    model: "gpt-test",
    runs: [
      { runId: "run_1", threadId: "thread_1", branch: "main", state: "completed", startedAt: "2026-07-10T00:00:00.000Z" },
      { runId: "run_2", threadId: "thread_1", branch: "main", state: "failed", startedAt: "2026-07-10T00:30:00.000Z" },
      { runId: "run_3", threadId: "thread_1", branch: "experiment", state: "completed", startedAt: "2026-07-10T00:40:00.000Z" },
    ],
    events: [
      envelope(0, {
        type: "provider_response_started",
        step: 1,
        model: "routed-gpt-test",
        responseId: "resp-public",
        requestId: "req-support",
      }),
      envelope(1, { type: "message_appended", message: { id: "u", role: "user", content: [{ type: "text", text: "hello" }], createdAt: "2026-07-10T00:00:00.000Z" } }),
      envelope(2, { type: "message_appended", message: { id: "a", role: "assistant", content: [{ type: "text", text: "hi" }], createdAt: "2026-07-10T00:00:01.000Z" } }),
      envelope(3, { type: "usage", semantics: "cumulative", usage: { inputTokens: 200, outputTokens: 200, totalTokens: 1_200, cacheReadTokens: 800, cost: "0.01" } }),
      envelope(4, { type: "usage", semantics: "incremental", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 25, cacheWriteTokens: 10, cost: "0.0025" } }, "run_2"),
    ],
  });

  assert.equal(report, [
    "Session",
    "  ID: thread_1",
    "  Name: parser fix",
    "  Store: /state/sessions.sqlite",
    "  Workspace: /workspace",
    "  Branch: main · 2 total",
    "  Model: openai/gpt-test",
    "  Last response model: routed-gpt-test",
    "  Last response ID: resp-public",
    "  Last request ID: req-support",
    "  Messages: 1 user · 1 assistant · 0 tool",
    "  Runs: 2 total · 1 completed",
    "  Tokens: 210 input · 205 output · 1,225 total · 800 cache read · 10 cache write",
    "  Cache: effective · 78.4% reuse · 800 read · 10 write · 2 responses",
    "  Cost: $0.0125",
    "  Created: 2026-07-10T00:00:00.000Z",
    "  Updated: 2026-07-10T01:00:00.000Z",
  ].join("\n"));
  assert.doesNotMatch(report, /\{|\}|"threadId"/u);
});
