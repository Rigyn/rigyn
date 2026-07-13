import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  exportThreadHtml,
  exportThreadMarkdown,
  importThreadJsonl,
} from "../../src/service/session-transfer.js";
import { StoredConversation } from "../../src/service/session-runtime.js";
import { sessionExportEvent } from "../../src/storage/session-export.js";
import { SessionStore } from "../../src/storage/store.js";

function message(id: string, role: "user" | "assistant", text: string) {
  return { id, role, content: [{ type: "text" as const, text }], createdAt: new Date(0).toISOString() };
}

test("session export strips opaque blocks from every canonical message carrier", () => {
  const summary = {
    ...message("private", "assistant", "portable"),
    content: [
      { type: "text" as const, text: "portable" },
      {
        type: "provider_opaque" as const,
        provider: "fixture" as const,
        mediaType: "application/json",
        value: { secret: "PRIVATE_SUMMARY_OPAQUE" },
      },
    ],
  };
  const events = [
    { type: "message_appended" as const, message: summary },
    { type: "compaction_completed" as const, summary, sourceMessageIds: ["source"] },
    {
      type: "branch_summary_created" as const,
      summary,
      sourceBranch: "main",
      sourceEventIds: ["event-source"],
    },
  ];
  for (const event of events) {
    const portable = JSON.stringify(sessionExportEvent(event));
    assert.match(portable, /portable/u);
    assert.doesNotMatch(portable, /provider_opaque|PRIVATE_SUMMARY_OPAQUE/u);
  }
});

test("JSONL transfer preserves branches and artifacts but strips remote provider state", async () => {
  const source = new SessionStore(":memory:");
  const thread = source.createThread({ name: "transfer", workspaceRoot: "/source" });
  const main = source.createEventSink({ threadId: thread.threadId, runId: "run-main" });
  await main.emit({ type: "run_started", provider: "fixture", model: "m" });
  const sourceUser = await main.emit({ type: "message_appended", message: message("u1", "user", "hello") });
  await main.emit({
    type: "message_appended",
    message: {
      ...message("a1", "assistant", "answer"),
      content: [
        { type: "text", text: "answer" },
        {
          type: "provider_opaque",
          provider: "fixture",
          mediaType: "application/json",
          value: { private: "PRIVATE_OPAQUE_SENTINEL" },
          serialized: "PRIVATE_OPAQUE_SERIALIZED_SENTINEL",
        },
      ],
    },
    providerState: { kind: "chat_completions", assistantMessage: { remote: "state" } },
  });
  await main.emit({ type: "reasoning_delta", part: 0, text: "PRIVATE_REASONING_SENTINEL", visibility: "provider_trace" });
  await main.emit({
    type: "provider_response_started",
    step: 0,
    model: "m",
    responseId: "PRIVATE_RESPONSE_ID_SENTINEL",
    requestId: "PRIVATE_REQUEST_ID_SENTINEL",
  });
  await main.emit({
    type: "warning",
    code: "unknown_provider_event",
    message: "Unknown provider event omitted",
    details: { privateDetails: "PRIVATE_WARNING_DETAILS_SENTINEL" },
  });
  await main.emit({
    type: "usage",
    semantics: "final",
    usage: { inputTokens: 1, raw: { privateUsage: "PRIVATE_USAGE_SENTINEL" } },
  });
  await main.emit({ type: "run_completed", finishReason: "stop" });
  source.appendEvent({
    threadId: thread.threadId,
    event: { type: "model_selected", provider: "fixture", model: "m-next" },
  });
  source.putArtifact({ threadId: thread.threadId, runId: "run-main", content: Buffer.from("artifact"), mediaType: "text/plain" });
  source.forkBranch({ threadId: thread.threadId, newBranch: "experiment" });
  const fork = source.createEventSink({ threadId: thread.threadId, branch: "experiment", runId: "run-fork" });
  await fork.emit({ type: "run_started", provider: "fixture", model: "m" });
  await fork.emit({ type: "message_appended", message: message("u2", "user", "fork only") });
  await fork.emit({ type: "run_completed", finishReason: "stop" });
  source.setEntryLabel({
    threadId: thread.threadId,
    branch: "experiment",
    targetEventId: sourceUser.eventId,
    label: "shared root",
  });

  const target = new SessionStore(":memory:");
  const exported = source.exportThread(thread.threadId);
  assert.doesNotMatch(exported, /remote|PRIVATE_REASONING_SENTINEL|PRIVATE_(?:OPAQUE(?:_SERIALIZED)?|USAGE|RESPONSE_ID|REQUEST_ID|WARNING_DETAILS)_SENTINEL/u);
  assert.match(exported, /session_export_private_event_omitted/u);
  const imported = importThreadJsonl(target, exported, { workspaceRoot: "/target" });
  assert.equal(imported.events, source.listEvents(thread.threadId, "experiment").length + 0);
  assert.equal(imported.artifacts, 1);
  assert.equal(imported.thread.workspaceRoot, "/target");
  assert.equal(imported.thread.branches.some((branch) => branch.name === "experiment"), true);
  const mainEvents = target.listEvents(imported.thread.threadId, "main");
  const forkEvents = target.listEvents(imported.thread.threadId, "experiment");
  assert.equal(mainEvents.some((entry) => entry.event.type === "message_appended" && entry.event.message.id === "u2"), false);
  assert.equal(forkEvents.some((entry) => entry.event.type === "message_appended" && entry.event.message.id === "u2"), true);
  assert.deepEqual(target.getModelSelection(imported.thread.threadId), { provider: "fixture", model: "m-next" });
  const importedLabel = target.listEntryLabels(imported.thread.threadId)[0];
  assert.equal(importedLabel?.label, "shared root");
  assert.notEqual(importedLabel?.targetEventId, sourceUser.eventId);
  const importedTarget = forkEvents.find((entry) => entry.eventId === importedLabel?.targetEventId);
  assert.equal(importedTarget?.event.type === "message_appended" ? importedTarget.event.message.id : undefined, "u1");
  const context = await new StoredConversation(target).loadContext(imported.thread.threadId, "main", "fixture", new AbortController().signal);
  assert.equal(context.providerState, undefined);
  assert.deepEqual(context.messages.map((entry) => entry.id), ["u1", "a1"]);
  assert.deepEqual(context.messages[1]?.content, [{ type: "text", text: "answer" }]);
  assert.equal(Buffer.from(target.listArtifacts(imported.thread.threadId)[0]?.content ?? []).toString(), "artifact");
  source.close();
  target.close();
});

test("JSONL transfer applies the same one-line thread-name boundary", () => {
  const store = new SessionStore(":memory:");
  const source = (name: string) => `${JSON.stringify({
    type: "thread",
    value: { name, defaultBranch: "main", branches: [] },
  })}\n`;
  const imported = importThreadJsonl(store, source(" Imported\r\n name\t "), { workspaceRoot: "/target" });
  assert.equal(imported.thread.name, "Imported name");
  const before = store.listThreads().length;
  assert.throws(
    () => importThreadJsonl(store, source("unsafe\u001bname"), { workspaceRoot: "/target" }),
    /control characters/u,
  );
  assert.equal(store.listThreads().length, before);
  store.close();
});

test("JSONL transfer validates versioned headers and accepts legacy headerless exports", () => {
  const store = new SessionStore(":memory:");
  const thread = JSON.stringify({
    type: "thread",
    value: { defaultBranch: "main", branches: [] },
  });
  const supported = [
    JSON.stringify({ type: "format", value: { format: "rigyn/session-jsonl", schemaVersion: 1 } }),
    thread,
  ].join("\n");
  assert.equal(importThreadJsonl(store, supported, { workspaceRoot: "/target" }).events, 0);
  assert.equal(importThreadJsonl(store, thread, { workspaceRoot: "/target" }).events, 0);
  assert.throws(
    () => importThreadJsonl(store, [
      JSON.stringify({ type: "format", value: { format: "rigyn/session-jsonl", schemaVersion: 2 } }),
      thread,
    ].join("\n"), { workspaceRoot: "/target" }),
    /Unsupported session export/u,
  );
  assert.throws(
    () => importThreadJsonl(store, [thread, JSON.stringify({
      type: "format",
      value: { format: "rigyn/session-jsonl", schemaVersion: 1 },
    })].join("\n"), { workspaceRoot: "/target" }),
    /must be first/u,
  );
  assert.throws(
    () => importThreadJsonl(store, [thread, thread].join("\n"), { workspaceRoot: "/target" }),
    /more than one thread record/u,
  );
  store.close();
});

test("JSONL import strips provider-private events even from external writers", () => {
  const store = new SessionStore(":memory:");
  const source = [
    JSON.stringify({ type: "thread", value: { defaultBranch: "main", branches: [] } }),
    JSON.stringify({
      type: "event",
      branch: "main",
      value: {
        eventId: "event-private",
        threadId: "source",
        sequence: 1,
        timestamp: new Date(0).toISOString(),
        schemaVersion: 1,
        event: { type: "reasoning_delta", text: "PRIVATE_EXTERNAL_TRACE", part: 0, visibility: "provider_trace" },
      },
    }),
    JSON.stringify({
      type: "event",
      branch: "main",
      value: {
        eventId: "event-message",
        threadId: "source",
        parentEventId: "event-private",
        sequence: 2,
        timestamp: new Date(1).toISOString(),
        schemaVersion: 1,
        event: {
          type: "message_appended",
          message: {
            id: "message-external",
            role: "assistant",
            createdAt: new Date(1).toISOString(),
            content: [
              { type: "text", text: "portable" },
              {
                type: "provider_opaque",
                provider: "fixture",
                mediaType: "application/json",
                value: { secret: "PRIVATE_EXTERNAL_OPAQUE" },
              },
            ],
          },
        },
      },
    }),
  ].join("\n");
  const imported = importThreadJsonl(store, source, { workspaceRoot: "/target" });
  const events = store.listEvents(imported.thread.threadId, "main");
  assert.equal(events[0]?.event.type, "warning");
  assert.deepEqual(
    events.find((entry) => entry.event.type === "message_appended")?.event,
    {
      type: "message_appended",
      message: {
        id: "message-external",
        role: "assistant",
        createdAt: new Date(1).toISOString(),
        content: [{ type: "text", text: "portable" }],
      },
    },
  );
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_EXTERNAL_(?:TRACE|OPAQUE)/u);
  store.close();
});

test("Markdown and HTML exports render messages while escaping active markup", async () => {
  const store = new SessionStore(":memory:");
  const thread = store.createThread({ name: "<script>alert(1)</script>" });
  const sink = store.createEventSink({ threadId: thread.threadId, runId: "run" });
  await sink.emit({ type: "run_started", provider: "fixture", model: "m" });
  await sink.emit({ type: "message_appended", message: message("u", "user", "<img src=x onerror=alert(1)>") });
  await sink.emit({ type: "run_completed", finishReason: "stop" });
  store.forkBranch({ threadId: thread.threadId, newBranch: "review" });
  const review = store.createEventSink({ threadId: thread.threadId, branch: "review", runId: "review-run" });
  await review.emit({ type: "run_started", provider: "fixture", model: "m" });
  await review.emit({ type: "message_appended", message: message("a", "assistant", "review-only javascript:alert(2)") });
  await review.emit({ type: "run_completed", finishReason: "stop" });
  assert.match(exportThreadMarkdown(store, thread.threadId), /<img src=x/u);
  const html = exportThreadHtml(store, thread.threadId);
  assert.doesNotMatch(html, /<script>alert/u);
  assert.doesNotMatch(html, /<img src=x/u);
  assert.match(html, /&lt;img/u);
  assert.match(html, /Content-Security-Policy/u);
  assert.match(html, /aria-label="Branches"/u);
  assert.match(html, />review</u);
  assert.match(html, /review-only javascript:alert\(2\)/u);
  assert.doesNotMatch(html, /href="javascript:/u);
  assert.match(html, /Filter messages/u);
  assert.throws(() => exportThreadHtml(store, thread.threadId, "missing"), /Unknown branch/u);
  store.close();
});

test("a malformed import rolls back its partially created thread", () => {
  const store = new SessionStore(":memory:");
  const before = store.listThreads().length;
  const malformed = [
    JSON.stringify({ type: "thread", value: { defaultBranch: "main", branches: [] } }),
    JSON.stringify({ type: "event", branch: "main", value: { eventId: "e", runId: "missing", timestamp: new Date().toISOString(), event: { type: "run_completed", finishReason: "stop" } } }),
  ].join("\n");
  assert.throws(() => importThreadJsonl(store, malformed, { workspaceRoot: "/target" }), /before run_started/u);
  assert.equal(store.listThreads().length, before);
  store.close();
});

test("artifact import verifies integrity metadata and associations before commit", () => {
  const store = new SessionStore(":memory:");
  const content = Buffer.from("artifact");
  const base = [
    JSON.stringify({ type: "thread", value: { defaultBranch: "main", branches: [] } }),
    JSON.stringify({
      type: "artifact",
      value: {
        content: content.toString("base64"),
        byteLength: content.length,
        sha256: "0".repeat(64),
        mediaType: "text/plain",
      },
    }),
  ];
  const before = store.listThreads().length;
  assert.throws(() => importThreadJsonl(store, base.join("\n"), { workspaceRoot: "/target" }), /invalid digest/u);
  assert.equal(store.listThreads().length, before);

  const digest = createHash("sha256").update(content).digest("hex");
  const unknownRun = JSON.parse(base[1]!) as { value: Record<string, unknown> };
  unknownRun.value.sha256 = digest;
  unknownRun.value.runId = "missing";
  assert.throws(
    () => importThreadJsonl(store, [base[0]!, JSON.stringify(unknownRun)].join("\n"), { workspaceRoot: "/target" }),
    /unknown run/u,
  );
  assert.equal(store.listThreads().length, before);
  store.close();
});
