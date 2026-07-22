import assert from "node:assert/strict";
import test from "node:test";

import { formatSessionReport } from "../../src/cli/session-report.js";

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
    "File: /tmp/session-1.jsonl",
    "Workspace: /workspace",
    "Messages: 3",
    "Created: 2026-07-20T00:00:00.000Z",
    "Updated: 2026-07-20T01:00:00.000Z",
    "Model: fixture/fixture-model",
  ].join("\n"));
});
