import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { EventEnvelope } from "../../src/core/events.js";
import { extensionSessionManager } from "../../src/extensions/session-contract.js";
import {
  bindInteractiveSessionPresentation,
  INTERACTIVE_TRANSCRIPT_SCAN_MS,
  interactiveTranscriptHistory,
  interactiveTranscriptUsageBaseline,
} from "../../src/interactive/session-presentation.js";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "../../src/service/agent-session.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { DEFAULT_TUI_LIMITS, type TuiController } from "../../src/tui/controller.js";
import { TuiModel } from "../../src/tui/model.js";
import type { TuiSessionEntry, TuiSessionSummary, TuiTranscriptItem } from "../../src/tui/types.js";

const roots = new Set<string>();

test.afterEach(async () => {
  await Promise.all([...roots].map(async (root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function manager(): Promise<SessionManager> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-presentation-"));
  roots.add(root);
  return SessionManager.create(root, join(root, "sessions"), { id: "presentation" });
}

function fakeSession(sessionManager: SessionManager) {
  const envelopeListeners = new Set<(event: EventEnvelope) => void>();
  const sessionListeners = new Set<AgentSessionEventListener>();
  const session = {
    sessionId: sessionManager.getSessionId(),
    sessionManager,
    onEvent(listener: (event: EventEnvelope) => void) {
      envelopeListeners.add(listener);
      return () => envelopeListeners.delete(listener);
    },
    subscribe(listener: AgentSessionEventListener) {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    getSessionStats() {
      return { usage: {} };
    },
  } as unknown as AgentSession;
  return {
    session,
    emitEnvelope(event: EventEnvelope) { for (const listener of envelopeListeners) listener(event); },
    emitSession(event: AgentSessionEvent) { for (const listener of sessionListeners) void listener(event); },
    listenerCounts: () => ({ envelopes: envelopeListeners.size, sessions: sessionListeners.size }),
  };
}

test("interactive history preserves custom entry order and omits display-false messages", async () => {
  const storage = await manager();
  const first = storage.appendMessage({
    id: "user-message",
    role: "user",
    content: [{ type: "text", text: "first" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const state = storage.appendCustomEntry("counter", { value: 1 });
  storage.appendCustomMessageEntry("hidden", "not visible", false, { private: true });
  const visible = storage.appendCustomMessageEntry("notice", "visible", true, { value: 2 });
  const last = storage.appendMessage({
    id: "assistant-message",
    role: "assistant",
    content: [{ type: "text", text: "last" }],
    createdAt: "2026-01-01T00:00:01.000Z",
  });

  const projected = interactiveTranscriptHistory(fakeSession(storage).session);
  assert.deepEqual(projected.map((item) => "event" in item ? item.eventId : item.id), [
    first,
    state,
    visible,
    last,
    `${last}~assistant-completed`,
  ]);
  assert.equal(projected.some((item) => !("event" in item) && item.type === "custom_message" && !item.display), false);
  assert.deepEqual(projected.flatMap((item) =>
    "event" in item || item.type === "session_summary" || item.type === "shell_execution"
      ? []
      : [item.customType]), ["counter", "notice"]);
});

test("interactive history restores user shell shortcuts as retained tool cards", async () => {
  const storage = await manager();
  const shell = storage.appendMessage({
    role: "bashExecution",
    command: "printf 'hello\\n'",
    output: "hello\n",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
  });

  const projected = interactiveTranscriptHistory(fakeSession(storage).session);
  assert.deepEqual(projected, [{
    type: "shell_execution",
    id: shell,
    command: "printf 'hello\\n'",
    output: "hello\n",
    exitCode: 0,
    cancelled: false,
    truncated: false,
  }]);

  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.applyAll(projected);
  assert.deepEqual(model.entries.map((entry) => ({
    kind: entry.kind,
    title: entry.title,
    summary: entry.summary,
    status: entry.status,
    output: entry.toolData?.result?.content,
  })), [{
    kind: "tool",
    title: "bash",
    summary: "printf 'hello\\n'",
    status: "completed",
    output: "hello\n",
  }]);
});

test("interactive history preserves completed shell timeout status", async () => {
  const storage = await manager();
  const shell = storage.appendMessage({
    role: "bashExecution",
    command: "slow command",
    output: "Tool failed: Shell command timed out",
    exitCode: undefined,
    isError: true,
    timedOut: true,
    signal: "SIGTERM",
    cancelled: false,
    truncated: false,
    timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
  });

  const projected = interactiveTranscriptHistory(fakeSession(storage).session);
  assert.deepEqual(projected, [{
    type: "shell_execution",
    id: shell,
    command: "slow command",
    output: "Tool failed: Shell command timed out",
    isError: true,
    timedOut: true,
    signal: "SIGTERM",
    cancelled: false,
    truncated: false,
  }]);

  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.applyAll(projected);
  assert.equal(model.entries[0]?.status, "failed");
  assert.deepEqual(model.entries[0]?.toolData?.result?.metadata, {
    timedOut: true,
    signal: "SIGTERM",
  });
});

test("interactive history does not let an explicit false override objective shell failure", async () => {
  const storage = await manager();
  storage.appendMessage({
    role: "bashExecution",
    command: "exit 7",
    output: "failed",
    exitCode: 7,
    isError: false,
    cancelled: false,
    truncated: false,
    timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
  });

  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.applyAll(interactiveTranscriptHistory(fakeSession(storage).session));
  assert.equal(model.entries[0]?.status, "failed");
  assert.equal(model.entries[0]?.toolData?.result?.isError, true);
});

test("history replay finalizes each assistant before its tool and later assistant", async () => {
  const storage = await manager();
  storage.appendMessage({
    id: "ordered-user",
    role: "user",
    content: [{ type: "text", text: "inspect the file" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  storage.appendMessage({
    id: "ordered-planning",
    role: "assistant",
    content: [
      { type: "text", text: "I will read it" },
      { type: "tool_call", callId: "ordered-call", name: "read", arguments: { path: "src/main.ts" } },
    ],
    stopReason: "tool_calls",
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  storage.appendMessage({
    id: "ordered-tool",
    role: "tool",
    content: [{
      type: "tool_result",
      callId: "ordered-call",
      name: "read",
      content: "file contents",
      isError: false,
    }],
    createdAt: "2026-01-01T00:00:02.000Z",
  });
  storage.appendMessage({
    id: "ordered-final",
    role: "assistant",
    content: [{ type: "text", text: "final answer" }],
    stopReason: "stop",
    createdAt: "2026-01-01T00:00:03.000Z",
  });

  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.applyAll(interactiveTranscriptHistory(fakeSession(storage).session));

  assert.deepEqual(model.entries.map((entry) => [entry.kind, entry.text || entry.title]), [
    ["user", "inspect the file"],
    ["assistant", "I will read it"],
    ["tool", "file contents"],
    ["assistant", "final answer"],
  ]);
  assert.deepEqual(model.committableEntries().map((entry) => entry.id), model.entries.map((entry) => entry.id));
});

test("history replay includes durable compaction and branch summaries in session order", async () => {
  const storage = await manager();
  const first = storage.appendMessage({
    id: "summary-user",
    role: "user",
    content: [{ type: "text", text: "retain this message" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const compaction = storage.appendCompaction(
    "durable compaction summary",
    first,
    42_000,
    undefined,
    false,
    {
      inputTokens: 2_930,
      cacheReadTokens: 35_584,
      cacheWriteTokens: 0,
      outputTokens: 3_449,
      totalTokens: 41_963,
      raw: { providerTelemetry: "must not enter the TUI projection" },
    },
  );
  const branch = storage.branchWithSummary(compaction, "durable branch summary");

  const projected = interactiveTranscriptHistory(fakeSession(storage).session);
  assert.deepEqual(projected.map((item) => "event" in item ? item.eventId : item.id), [
    first,
    compaction,
    branch,
  ]);
  const projectedCompaction = projected.find((item): item is TuiSessionSummary =>
    !("event" in item) && item.type === "session_summary" && item.summaryType === "compaction");
  assert.equal(
    projectedCompaction?.usage !== undefined && "raw" in projectedCompaction.usage,
    false,
  );

  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.applyAll(projected);
  assert.deepEqual(model.entries.map((entry) => [entry.title, entry.compactText, entry.text]), [
    [undefined, undefined, "retain this message"],
    [
      "Context compacted",
      "42,000 tokens before",
      "durable compaction summary",
    ],
    ["Branch summary", "", "durable branch summary"],
  ]);
  assert.equal(
    model.entries[1]?.summary,
    "summary request · prompt 38,514 · cache read 35,584 (92.4% of this request) · cache write 0 · output 3,449",
  );
});

test("history replay excludes summaries that belong only to an abandoned sibling branch", async () => {
  const storage = await manager();
  const common = storage.appendMessage({
    id: "common-user",
    role: "user",
    content: [{ type: "text", text: "common request" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const abandoned = storage.appendMessage({
    id: "abandoned-assistant",
    role: "assistant",
    content: [{ type: "text", text: "abandoned answer" }],
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  const abandonedSummary = storage.branchWithSummary(abandoned, "abandoned sibling summary");
  storage.branch(common);
  const active = storage.appendMessage({
    id: "active-assistant",
    role: "assistant",
    content: [{ type: "text", text: "active answer" }],
    createdAt: "2026-01-01T00:00:02.000Z",
  });

  const projected = interactiveTranscriptHistory(fakeSession(storage).session);
  const ids = projected.map((item) => "event" in item ? item.eventId : item.id);
  assert.equal(ids.includes(abandonedSummary), false);
  assert.equal(ids.includes(abandoned), false);
  assert.ok(ids.includes(active));
});

test("transcript usage follows active conversation requests and retains its latest cache-hit rate", async () => {
  const storage = await manager();
  storage.appendMessage({
    id: "usage-root",
    role: "user",
    content: [{ type: "text", text: "root" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const common = storage.appendMessage({
    id: "usage-common",
    role: "assistant",
    content: [{ type: "text", text: "common" }],
    stopReason: "stop",
    usage: { inputTokens: 100, cacheReadTokens: 100, outputTokens: 10 },
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  storage.appendMessage({
    id: "usage-abandoned",
    role: "assistant",
    content: [{ type: "text", text: "abandoned" }],
    stopReason: "stop",
    usage: { inputTokens: 1_000, outputTokens: 10 },
    createdAt: "2026-01-01T00:00:02.000Z",
  });
  storage.branch(common);
  const active = storage.appendMessage({
    id: "usage-active",
    role: "assistant",
    content: [{ type: "text", text: "active" }],
    stopReason: "stop",
    usage: { inputTokens: 40, cacheReadTokens: 160, cacheWriteTokens: 0, outputTokens: 20 },
    createdAt: "2026-01-01T00:00:03.000Z",
  });
  storage.appendCompaction(
    "active summary",
    active,
    1_000,
    undefined,
    false,
    { inputTokens: 30, outputTokens: 10 },
  );

  const baseline = interactiveTranscriptUsageBaseline(fakeSession(storage).session);

  assert.deepEqual(baseline, {
    usage: {
      inputTokens: 170,
      outputTokens: 40,
    },
    reportedUsage: {
      inputTokens: 170,
      outputTokens: 40,
      cacheReadTokens: 260,
      cacheWriteTokens: 0,
      totalTokens: 470,
    },
    latestCacheHitRate: 80,
    latestCacheUsage: {
      cacheReadTokens: 160,
      cacheWriteTokens: 0,
    },
  });
});

test("transcript usage does not invent a cache-hit rate when the latest provider omits cache telemetry", async () => {
  const storage = await manager();
  storage.appendMessage({
    id: "telemetry-reported",
    role: "assistant",
    content: [{ type: "text", text: "reported" }],
    stopReason: "stop",
    usage: { inputTokens: 20, cacheReadTokens: 80, outputTokens: 5 },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  storage.appendMessage({
    id: "telemetry-omitted",
    role: "assistant",
    content: [{ type: "text", text: "omitted" }],
    stopReason: "stop",
    usage: { inputTokens: 100, outputTokens: 5 },
    createdAt: "2026-01-01T00:00:01.000Z",
  });

  const baseline = interactiveTranscriptUsageBaseline(fakeSession(storage).session);

  assert.equal(baseline.latestCacheHitRate, undefined);
  assert.equal(baseline.latestCacheUsage, undefined);
  assert.equal(Object.hasOwn(baseline.usage ?? {}, "cacheReadTokens"), false);
});

test("transcript cache-hit rates require exact prompt usage and preserve explicit zero", async () => {
  const cases = [
    {
      id: "exact-total-without-input",
      usage: { outputTokens: 5, totalTokens: 105, cacheReadTokens: 80 },
      expected: 80,
    },
    {
      id: "missing-read",
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, cacheWriteTokens: 0 },
      expected: undefined,
    },
    {
      id: "missing-write",
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 105, cacheReadTokens: 80 },
      expected: 80,
    },
    {
      id: "explicit-zero",
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0 },
      expected: 0,
    },
    {
      id: "empty-prompt",
      usage: { inputTokens: 0, outputTokens: 5, totalTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      expected: undefined,
    },
  ] as const;

  for (const fixture of cases) {
    const storage = await manager();
    storage.appendMessage({
      id: `cache-rate-${fixture.id}`,
      role: "assistant",
      content: [{ type: "text", text: fixture.id }],
      stopReason: "stop",
      usage: fixture.usage,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(
      interactiveTranscriptUsageBaseline(fakeSession(storage).session).latestCacheHitRate,
      fixture.expected,
    );
  }
});

test("an empty transcript does not seed an unknown usage observation", async () => {
  const storage = await manager();
  const baseline = interactiveTranscriptUsageBaseline(fakeSession(storage).session);
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.setUsageBaseline(baseline.usage, baseline.latestCacheHitRate, baseline.latestCacheUsage);

  const events: EventEnvelope["event"][] = [
    { type: "run_started", provider: "openai-codex", model: "gpt-test" },
    { type: "assistant_started", step: 1 },
    {
      type: "usage",
      semantics: "final",
      usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 80, cacheWriteTokens: 0 },
    },
    { type: "assistant_completed", finishReason: "stop" },
  ];
  events.forEach((event, index) => model.apply({
    eventId: `empty-baseline-${index}`,
    threadId: "empty-baseline",
    runId: "empty-baseline-run",
    sequence: index + 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    event,
  }));

  assert.equal(baseline.usage, undefined);
  assert.deepEqual(model.usage?.total, {
    inputTokens: 20,
    outputTokens: 5,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    totalTokens: 105,
  });
  assert.equal(model.usage?.latestCacheHitRate, 80);
});

test("legacy presentation fallback treats a newest no-usage assistant as an observation", async () => {
  const storage = await manager();
  storage.appendMessage({
    id: "fallback-reported",
    role: "assistant",
    content: [{ type: "text", text: "reported" }],
    stopReason: "stop",
    usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  storage.appendMessage({
    id: "fallback-omitted",
    role: "assistant",
    content: [{ type: "text", text: "omitted" }],
    stopReason: "stop",
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  const legacyManager = {
    getEntry: (id: string) => storage.getEntry(id),
    getLeafEntry: () => storage.getLeafEntry(),
    getBranch: () => storage.getBranch(),
  };
  const session = { sessionManager: legacyManager } as unknown as AgentSession;

  assert.deepEqual(interactiveTranscriptUsageBaseline(session), {
    usage: {},
    reportedUsage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
  });
});

test("legacy presentation fallback retains a fuller prompt lower bound with partial cache telemetry", async () => {
  const storage = await manager();
  storage.appendMessage({
    id: "fallback-complete-cache",
    role: "assistant",
    content: [{ type: "text", text: "complete cache telemetry" }],
    stopReason: "stop",
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  storage.appendMessage({
    id: "fallback-partial-cache",
    role: "assistant",
    content: [{ type: "text", text: "missing cache telemetry" }],
    stopReason: "stop",
    usage: { inputTokens: 100, outputTokens: 10 },
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  const legacyManager = {
    getEntry: (id: string) => storage.getEntry(id),
    getLeafEntry: () => storage.getLeafEntry(),
    getBranch: () => storage.getBranch(),
  };
  const session = { sessionManager: legacyManager } as unknown as AgentSession;

  assert.deepEqual(interactiveTranscriptUsageBaseline(session), {
    usage: { inputTokens: 200, outputTokens: 20 },
    reportedUsage: {
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
      totalTokens: 270,
    },
  });
});

test("legacy presentation fallback retains reported cache fields with an exact derived prompt", async () => {
  const storage = await manager();
  storage.appendMessage({
    id: "fallback-reported-cache",
    role: "assistant",
    content: [{ type: "text", text: "reported cache" }],
    stopReason: "stop",
    usage: { outputTokens: 10, totalTokens: 100, cacheReadTokens: 80 },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  storage.appendMessage({
    id: "fallback-omitted-cache",
    role: "assistant",
    content: [{ type: "text", text: "omitted cache" }],
    stopReason: "stop",
    usage: { outputTokens: 10, totalTokens: 100 },
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  const legacyManager = {
    getEntry: (id: string) => storage.getEntry(id),
    getLeafEntry: () => storage.getLeafEntry(),
    getBranch: () => storage.getBranch(),
  };
  const session = { sessionManager: legacyManager } as unknown as AgentSession;

  assert.deepEqual(interactiveTranscriptUsageBaseline(session), {
    usage: { outputTokens: 20, totalTokens: 200 },
    reportedUsage: { outputTokens: 20, totalTokens: 200, cacheReadTokens: 80 },
  });
});

test("legacy presentation fallback ignores unmetered failures and hook summaries", async () => {
  const storage = await manager();
  const reported = storage.appendMessage({
    id: "fallback-metered",
    role: "assistant",
    content: [{ type: "text", text: "reported" }],
    stopReason: "stop",
    usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  storage.appendMessage({
    id: "fallback-cancelled",
    role: "assistant",
    content: [{ type: "text", text: "cancelled" }],
    stopReason: "cancelled",
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  storage.appendCompaction("hook summary", reported, 25, undefined, true);
  const legacyManager = {
    getEntry: (id: string) => storage.getEntry(id),
    getLeafEntry: () => storage.getLeafEntry(),
    getBranch: () => storage.getBranch(),
  };
  const session = { sessionManager: legacyManager } as unknown as AgentSession;

  assert.deepEqual(interactiveTranscriptUsageBaseline(session), {
    usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
  });
});

test("public session facades preserve canonical tool usage and missing cache telemetry", async () => {
  const storage = await manager();
  storage.appendMessage({
    id: "public-assistant",
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    stopReason: "stop",
    usage: { inputTokens: 100, outputTokens: 10 },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  storage.appendMessage({
    id: "public-tool-batch",
    role: "tool",
    content: [{
      type: "tool_result",
      callId: "public-one",
      name: "read",
      content: "one",
      isError: false,
    }, {
      type: "tool_result",
      callId: "public-two",
      name: "read",
      content: "two",
      isError: false,
    }],
    usage: { inputTokens: 20, outputTokens: 5 },
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  const session = {
    sessionId: storage.getSessionId(),
    sessionManager: extensionSessionManager(storage),
  } as unknown as AgentSession;
  Object.defineProperty(storage, "getBranch", {
    value: () => { throw new Error("facade usage must not project the branch"); },
  });

  assert.deepEqual(interactiveTranscriptUsageBaseline(session), {
    usage: {
      inputTokens: 120,
      outputTokens: 15,
    },
  });
});

test("history replay omits the prefix replaced by the latest compaction", async () => {
  const storage = await manager();
  storage.appendMessage({
    id: "old-user",
    role: "user",
    content: [{ type: "text", text: "obsolete request" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  storage.appendMessage({
    id: "old-assistant",
    role: "assistant",
    content: [{ type: "text", text: "obsolete answer" }],
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  const retained = storage.appendMessage({
    id: "retained-user",
    role: "user",
    content: [{ type: "text", text: "retained request" }],
    createdAt: "2026-01-01T00:00:02.000Z",
  });
  storage.appendMessage({
    id: "retained-assistant",
    role: "assistant",
    content: [{ type: "text", text: "retained answer" }],
    createdAt: "2026-01-01T00:00:03.000Z",
  });
  const compaction = storage.appendCompaction("replacement checkpoint", retained, 42_000);
  storage.appendMessage({
    id: "new-user",
    role: "user",
    content: [{ type: "text", text: "new request" }],
    createdAt: "2026-01-01T00:00:04.000Z",
  });

  const projected = interactiveTranscriptHistory(fakeSession(storage).session);
  assert.deepEqual(projected.flatMap((item) => {
    if (!("event" in item)) return [item.id];
    return item.event.type === "message_appended" ? [item.event.message.id] : [];
  }), ["retained-user", "retained-assistant", compaction, "new-user"]);
});

test("non-display entry floods do not crowd visible resume history out", async (context) => {
  const storage = await manager();
  storage.appendMessage({
    id: "retained-user-message",
    role: "user",
    content: [{ type: "text", text: "retained visible history" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  for (let index = 0; index < 2_000; index += 1) storage.appendThinkingLevelChange("off");

  let now = 0;
  context.mock.method(performance, "now", () => {
    now += 0.01;
    return now;
  });

  const projected = interactiveTranscriptHistory(fakeSession(storage).session);

  assert.ok(now > INTERACTIVE_TRANSCRIPT_SCAN_MS);
  assert.equal(projected.length, 1);
  const retained = projected[0];
  assert.ok(retained !== undefined && "event" in retained && retained.event.type === "message_appended");
  assert.equal(retained.event.message.id, "retained-user-message");
});

test("resume preserves projected parents after a batched tool-result entry", async () => {
  const storage = await manager();
  const toolEntryId = storage.appendMessage({
    id: "batched-tool-results",
    role: "tool",
    content: [{
      type: "tool_result",
      callId: "first-call",
      name: "read",
      content: "first",
      isError: false,
    }, {
      type: "tool_result",
      callId: "second-call",
      name: "read",
      content: "second",
      isError: false,
    }],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const customEntryId = storage.appendCustomEntry("after-tools", { ready: true });

  const custom = interactiveTranscriptHistory(fakeSession(storage).session)
    .find((item): item is TuiSessionEntry => !("event" in item) && item.id === customEntryId);

  assert.equal(custom?.parentId, `${toolEntryId}~1`);
});

test("live presentation queues append events during replay and tears down both subscriptions", async () => {
  const storage = await manager();
  const fixture = fakeSession(storage);
  const replaced: TuiTranscriptItem[][] = [];
  const renderedEntries: TuiSessionEntry[] = [];
  const renderedEnvelopes: EventEnvelope[] = [];
  const duringReplay: TuiSessionEntry = {
    type: "custom",
    id: "during-replay",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "live-state",
    data: { ready: true },
  };
  const terminal = {
    replaceTranscript(items: readonly TuiTranscriptItem[]) {
      replaced.push([...items]);
      fixture.emitSession({ type: "entry_appended", entry: duringReplay });
    },
    setUsageBaseline() {},
    renderSessionEntry(entry: TuiSessionEntry) { renderedEntries.push(entry); },
    render(event: EventEnvelope) { renderedEnvelopes.push(event); },
  } as unknown as TuiController;

  const unsubscribe = bindInteractiveSessionPresentation(fixture.session, terminal);
  assert.equal(replaced.length, 1);
  assert.deepEqual(renderedEntries.map((entry) => entry.id), ["during-replay"]);

  fixture.emitSession({
    type: "entry_appended",
    entry: {
      type: "custom_message",
      id: "hidden-live",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "hidden",
      content: "hidden",
      display: false,
    },
  });
  assert.deepEqual(renderedEntries.map((entry) => entry.id), ["during-replay"]);

  const envelope: EventEnvelope = {
    eventId: "warning-live",
    threadId: "presentation",
    sequence: 1,
    timestamp: "2026-01-01T00:00:02.000Z",
    schemaVersion: 1,
    event: { type: "warning", code: "live", message: "warning" },
  };
  fixture.emitEnvelope(envelope);
  assert.deepEqual(renderedEnvelopes, [envelope]);
  assert.deepEqual(fixture.listenerCounts(), { envelopes: 1, sessions: 1 });

  unsubscribe();
  assert.deepEqual(fixture.listenerCounts(), { envelopes: 0, sessions: 0 });
});

test("live presentation seeds footer usage from the active branch instead of whole-graph statistics", async () => {
  const storage = await manager();
  const common = storage.appendMessage({
    id: "baseline-common",
    role: "assistant",
    content: [{ type: "text", text: "common" }],
    stopReason: "stop",
    usage: { inputTokens: 20, cacheReadTokens: 80, outputTokens: 5 },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  storage.appendMessage({
    id: "baseline-abandoned",
    role: "assistant",
    content: [{ type: "text", text: "abandoned" }],
    stopReason: "stop",
    usage: { inputTokens: 900, outputTokens: 10 },
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  storage.branch(common);
  storage.appendMessage({
    id: "baseline-active",
    role: "assistant",
    content: [{ type: "text", text: "active" }],
    stopReason: "stop",
    usage: { inputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 0, outputTokens: 5 },
    createdAt: "2026-01-01T00:00:02.000Z",
  });
  const fixture = fakeSession(storage);
  (fixture.session as unknown as { getSessionStats(): { usage: { inputTokens: number } } }).getSessionStats = () => ({
    usage: { inputTokens: 9_999 },
  });
  const baselines: unknown[] = [];
  const cacheRates: Array<number | undefined> = [];
  const terminal = {
    replaceTranscript() {},
    setUsageBaseline(usage: unknown, latestCacheHitRate?: number) {
      baselines.push(usage);
      cacheRates.push(latestCacheHitRate);
    },
    renderSessionEntry() {},
    render() {},
  } as unknown as TuiController;

  const unsubscribe = bindInteractiveSessionPresentation(fixture.session, terminal);

  assert.deepEqual(baselines, [{
    inputTokens: 30,
    outputTokens: 10,
    cacheReadTokens: 170,
  }]);
  assert.deepEqual(cacheRates, [90]);
  unsubscribe();
});

test("live presentation and resume seed the same reported usage lower bounds", async () => {
  const storage = await manager();
  storage.appendMessage({
    id: "reported-resume",
    role: "assistant",
    content: [{ type: "text", text: "reported" }],
    stopReason: "stop",
    usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  storage.appendMessage({
    id: "omitted-resume",
    role: "assistant",
    content: [{ type: "text", text: "omitted" }],
    stopReason: "stop",
    createdAt: "2026-01-01T00:00:01.000Z",
  });
  const fixture = fakeSession(storage);
  const seeded: unknown[][] = [];
  const terminal = {
    replaceTranscript() {},
    setUsageBaseline(...args: unknown[]) { seeded.push(args); },
    renderSessionEntry() {},
    render() {},
  } as unknown as TuiController;

  const unsubscribe = bindInteractiveSessionPresentation(fixture.session, terminal);
  const baseline = interactiveTranscriptUsageBaseline(fixture.session);

  assert.deepEqual(baseline, {
    usage: {},
    reportedUsage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
  });
  assert.deepEqual(seeded, [[
    baseline.usage,
    undefined,
    undefined,
    baseline.reportedUsage,
  ]]);
  unsubscribe();
});
