import assert from "node:assert/strict";
import test from "node:test";

import { formatPromptContextReport, formatSessionReport } from "../../src/cli/session-report.js";
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

test("prompt context report exposes redacted composition metadata without prompt bodies", () => {
  const report = formatPromptContextReport([
    envelope(0, {
      type: "run_started",
      provider: "openai",
      model: "gpt-test",
      promptComposition: {
        bytes: 4_096,
        sha256: "a".repeat(64),
        sources: [
          {
            kind: "instruction",
            source: "/workspace/AGENTS.md",
            bytes: 512,
            sha256: "b".repeat(64),
          },
          {
            kind: "append_system_prompt",
            source: "team-policy.md",
            bytes: 128,
            sha256: "c".repeat(64),
            truncated: true,
          },
        ],
        tools: ["read", "edit"],
        skills: [{ name: "review", manifestPath: "/skills/review/SKILL.md" }],
        truncated: false,
      },
    }),
  ]);

  assert.match(report, /Model context\n  Run: run_1/u);
  assert.match(report, /Host-composed system prompt: 4,096 bytes · sha256:aaaaaaaaaaaa · complete metadata/u);
  assert.match(report, /Tools \(2\): read, edit/u);
  assert.match(report, /instruction: \/workspace\/AGENTS\.md · 512 bytes · sha256:bbbbbbbbbbbb/u);
  assert.match(report, /append_system_prompt: team-policy\.md.*truncated/u);
  assert.match(report, /review: \/skills\/review\/SKILL\.md/u);
  assert.match(report, /bodies are intentionally not displayed/u);
  assert.doesNotMatch(report, /secret prompt body/u);
});

test("prompt context report explains when the branch has no recorded run", () => {
  assert.match(formatPromptContextReport([]), /No composed prompt has been recorded/u);
});

test("prompt context report never falls back to stale provenance from an older run", () => {
  const report = formatPromptContextReport([
    envelope(0, {
      type: "run_started",
      provider: "openai",
      model: "old-model",
      promptComposition: {
        bytes: 128,
        sha256: "a".repeat(64),
        sources: [],
        tools: [],
        skills: [],
        truncated: false,
      },
    }, "run_old"),
    envelope(1, {
      type: "run_started",
      provider: "openai",
      model: "current-model",
    }, "run_current"),
  ]);

  assert.match(report, /Run: run_current/u);
  assert.match(report, /latest run has no recorded prompt-composition metadata/u);
  assert.doesNotMatch(report, /aaaaaaaaaaaa|old-model/u);
});

test("prompt context report neutralizes terminal controls in persisted identities", () => {
  const report = formatPromptContextReport([
    envelope(0, {
      type: "run_started",
      provider: "openai",
      model: "gpt-test",
      promptComposition: {
        bytes: 1,
        sha256: "a".repeat(64),
        sources: [{
          kind: "instruction",
          source: "AGENTS.md\u001b[31m",
          bytes: 1,
          sha256: "b".repeat(64),
        }],
        tools: [],
        skills: [{ name: "review\nspoof", manifestPath: "/skills/review\u001b[0m/SKILL.md" }],
        truncated: false,
      },
    }),
  ]);

  assert.doesNotMatch(report, /[\u0000-\u0009\u000b-\u001f\u007f]/u);
  assert.match(report, /AGENTS\.md\?\[31m/u);
  assert.match(report, /review\?spoof: \/skills\/review\?\[0m\/SKILL\.md/u);
});
