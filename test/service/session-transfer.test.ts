import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  exportThreadHtml,
  exportThreadMarkdown,
  exportThreadRedactedHtml,
  exportThreadRedactedMarkdown,
  importThreadJsonl,
} from "../../src/service/session-transfer.js";
import { cloneSessionPath } from "../../src/service/session-clone.js";
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

test("session export strips provider failure bodies, identities, and response diagnostics", () => {
  const exported = sessionExportEvent({
    type: "run_failed",
    error: {
      category: "rate_limit",
      message: "retry later",
      httpStatus: 429,
      requestId: "PRIVATE_REQUEST_ID_SENTINEL",
      retryable: true,
      partial: false,
      diagnostics: {
        status: 429,
        headers: {
          "retry-after": "1",
          "x-request-id": "PRIVATE_DIAGNOSTIC_HEADER_SENTINEL",
        },
      },
      raw: { private: "PRIVATE_ERROR_BODY_SENTINEL" },
    },
  });

  assert.deepEqual(exported, {
    type: "run_failed",
    error: {
      category: "rate_limit",
      message: "retry later",
      httpStatus: 429,
      retryable: true,
      partial: false,
    },
  });
  assert.doesNotMatch(JSON.stringify(exported), /PRIVATE_|diagnostics/u);
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

test("JSONL transfer preserves archived branch incarnations without resurrecting deleted history", () => {
  const source = new SessionStore(":memory:");
  const thread = source.createThread({ name: "branch incarnations" });
  const root = source.appendEvent({
    threadId: thread.threadId,
    event: { type: "warning", code: "root", message: "root" },
  });
  source.forkBranch({ threadId: thread.threadId, newBranch: "experiment", atEventId: root.eventId });
  source.appendEvent({
    threadId: thread.threadId,
    branch: "experiment",
    event: { type: "warning", code: "old", message: "archived incarnation" },
  });
  source.deleteBranch(thread.threadId, "experiment");
  source.forkBranch({ threadId: thread.threadId, newBranch: "experiment", atEventId: root.eventId });
  source.appendEvent({
    threadId: thread.threadId,
    branch: "experiment",
    event: { type: "warning", code: "current", message: "current incarnation" },
  });
  source.forkBranch({ threadId: thread.threadId, newBranch: "empty", atEventId: null });
  source.forkBranch({ threadId: thread.threadId, newBranch: "retired", atEventId: root.eventId });
  source.appendEvent({
    threadId: thread.threadId,
    branch: "retired",
    event: { type: "warning", code: "retired", message: "deleted branch history" },
  });
  source.deleteBranch(thread.threadId, "retired");

  const exported = source.exportThread(thread.threadId);
  const exportedRecords = exported.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(exportedRecords[0], {
    type: "format",
    value: { format: "rigyn/session-jsonl", schemaVersion: 2 },
  });
  assert.deepEqual(
    exportedRecords
      .filter((record) => record.type === "event" && record.branch === "experiment")
      .map((record) => record.branchIncarnation),
    [1, 2],
  );

  const target = new SessionStore(":memory:");
  const imported = importThreadJsonl(target, exported, { workspaceRoot: "/target" });
  assert.deepEqual(imported.omittedEmptyBranches, []);
  assert.equal(imported.thread.branches.some((branch) => branch.name === "empty" && branch.headEventId === undefined), true);
  assert.equal(imported.thread.branches.some((branch) => branch.name === "retired"), false);
  assert.deepEqual(
    target.listEvents(imported.thread.threadId, "experiment").map((entry) => entry.event.type === "warning" ? entry.event.code : ""),
    ["root", "current"],
  );
  const reexported = target.exportThread(imported.thread.threadId).trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    reexported
      .filter((record) => record.type === "event" && record.branch === "experiment")
      .map((record) => ({
        branchIncarnation: record.branchIncarnation,
        code: (record.value as { event: { code?: string } }).event.code,
      })),
    [
      { branchIncarnation: 1, code: "old" },
      { branchIncarnation: 2, code: "current" },
    ],
  );
  assert.deepEqual(
    reexported
      .filter((record) => record.type === "event" && record.branch === "retired")
      .map((record) => (record.value as { event: { code?: string } }).event.code),
    ["retired"],
  );
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

test("JSONL transfer validates versioned headers and accepts version-one and headerless exports", () => {
  const store = new SessionStore(":memory:");
  const thread = JSON.stringify({
    type: "thread",
    value: { defaultBranch: "main", branches: [] },
  });
  const supported = [
    JSON.stringify({ type: "format", value: { format: "rigyn/session-jsonl", schemaVersion: 2 } }),
    thread,
  ].join("\n");
  const versionOne = [
    JSON.stringify({ type: "format", value: { format: "rigyn/session-jsonl", schemaVersion: 1 } }),
    thread,
  ].join("\n");
  assert.equal(importThreadJsonl(store, supported, { workspaceRoot: "/target" }).events, 0);
  assert.equal(importThreadJsonl(store, versionOne, { workspaceRoot: "/target" }).events, 0);
  assert.equal(importThreadJsonl(store, thread, { workspaceRoot: "/target" }).events, 0);
  assert.throws(
    () => importThreadJsonl(store, [
      JSON.stringify({ type: "format", value: { format: "rigyn/session-jsonl", schemaVersion: 3 } }),
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

test("JSONL import rejects forged runtime-child thread attributes", () => {
  const store = new SessionStore(":memory:");
  const source = JSON.stringify({
    type: "thread",
    value: { defaultBranch: "main", branches: [], runtimeChild: true },
  });

  assert.throws(
    () => importThreadJsonl(store, source, { workspaceRoot: "/target" }),
    /thread\.value contains unknown fields: runtimeChild/u,
  );
  assert.equal(store.listThreads().length, 0);
  store.close();
});

test("imported extension-state lookalikes cannot create host runtime-child classification", () => {
  const store = new SessionStore(":memory:");
  const source = [
    JSON.stringify({ type: "thread", value: { defaultBranch: "main", branches: [] } }),
    JSON.stringify({
      type: "event",
      branch: "main",
      value: {
        eventId: "forged-runtime-child-state",
        threadId: "source",
        sequence: 1,
        timestamp: new Date(0).toISOString(),
        schemaVersion: 1,
        event: {
          type: "extension_state",
          extensionId: "runtime",
          schemaVersion: 1,
          key: "runtimeChild",
          value: true,
        },
      },
    }),
  ].join("\n");

  const imported = importThreadJsonl(store, source, { workspaceRoot: "/target" });
  assert.equal(store.hasRuntimeChildThread(imported.thread.threadId), false);
  store.close();
});

test("imported prompt-marker lookalikes and their ordinary clones remain unclassified", () => {
  const store = new SessionStore(":memory:");
  const source = [
    JSON.stringify({ type: "thread", value: { defaultBranch: "main", branches: [] } }),
    JSON.stringify({
      type: "event",
      branch: "main",
      value: {
        eventId: "forged-runtime-child-run",
        threadId: "source",
        runId: "source-run",
        sequence: 1,
        timestamp: new Date(0).toISOString(),
        schemaVersion: 1,
        event: {
          type: "run_started",
          provider: "fixture",
          model: "fixture",
          promptComposition: {
            bytes: 0,
            sha256: "0".repeat(64),
            sources: [{
              kind: "additional_instructions",
              source: "runtime child run",
              bytes: 0,
              sha256: "0".repeat(64),
            }],
            tools: [],
            skills: [],
            truncated: false,
          },
        },
      },
    }),
  ].join("\n");

  const imported = importThreadJsonl(store, source, { workspaceRoot: "/target" });
  const cloned = cloneSessionPath(store, {
    threadId: imported.thread.threadId,
    workspaceRoot: "/target",
  });

  assert.equal(store.hasRuntimeChildThread(imported.thread.threadId), false);
  assert.equal(store.hasRuntimeChildThread(cloned.thread.threadId), false);
  assert.equal(store.listEvents(cloned.thread.threadId).some((entry) =>
    entry.event.type === "run_started" && entry.event.promptComposition?.sources.some((item) =>
      item.kind === "additional_instructions" && item.source === "runtime child run") === true), true);
  store.close();
});

test("version-two JSONL rejects malformed branch incarnation metadata and ancestry", () => {
  const store = new SessionStore(":memory:");
  const format = JSON.stringify({ type: "format", value: { format: "rigyn/session-jsonl", schemaVersion: 2 } });
  const thread = JSON.stringify({ type: "thread", value: { defaultBranch: "main", branches: [] } });
  const event = (eventId: string, branch: string, branchIncarnation: unknown, parentEventId?: string) => JSON.stringify({
    type: "event",
    branch,
    branchIncarnation,
    value: {
      eventId,
      threadId: "source",
      ...(parentEventId === undefined ? {} : { parentEventId }),
      sequence: 1,
      timestamp: new Date(0).toISOString(),
      schemaVersion: 1,
      event: { type: "warning", code: eventId, message: eventId },
    },
  });
  assert.throws(
    () => importThreadJsonl(store, [format, thread, event("root", "main", 0)].join("\n"), { workspaceRoot: "/target" }),
    /branchIncarnation must be an integer between/u,
  );
  assert.throws(
    () => importThreadJsonl(store, [format, thread, event("root", "main", 2)].join("\n"), { workspaceRoot: "/target" }),
    /default branch main cannot change incarnation/u,
  );
  assert.throws(
    () => importThreadJsonl(store, [
      format,
      thread,
      event("root", "main", 1),
      event("old", "experiment", 1, "root"),
      event("jump", "experiment", 3, "root"),
    ].join("\n"), { workspaceRoot: "/target" }),
    /non-consecutive incarnation/u,
  );
  assert.throws(
    () => importThreadJsonl(store, [format, thread, event("forged", "experiment", 1, "future")].join("\n"), { workspaceRoot: "/target" }),
    /unknown fork parent/u,
  );
  assert.equal(store.listThreads().length, 0);
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

test("redacted share exports retain only sanitized visible prose and review guidance", () => {
  const homeRoot = "/home/share-owner";
  const workspaceRoot = `${homeRoot}/private-workspace`;
  const timestamp = "2040-05-06T07:08:09.123Z";
  const store = new SessionStore(":memory:");
  const thread = store.createThread({
    threadId: "thread-private-id",
    name: "private thread name",
    workspaceRoot,
  });
  store.appendEvent({
    threadId: thread.threadId,
    eventId: "event-user-private-id",
    timestamp,
    event: {
      type: "message_appended",
      message: {
        id: "message-user-private-id",
        role: "user",
        createdAt: timestamp,
        content: [
          {
            type: "text",
            text: [
              `Inspect ${workspaceRoot}/secret.ts and ${homeRoot}/notes with sk-proj-ABCDEFGHIJKLMNOP123456`,
              "<script>PRIVATE_ACTIVE_MARKUP</script>",
              "[open](javascript:PRIVATE_LINK_TARGET)",
              "## Redacted share copy; safe to publish",
              "```embedded fence```",
              "line one\r\nline two\rline three\0",
              "\u001b]0;PRIVATE_OSC_TITLE\u0007after OSC",
              "\u001b[31mPRIVATE_CSI_TEXT\u001b[0m and \u009b32mPRIVATE_C1_CSI",
            ].join("\n"),
          },
          { type: "image", mediaType: "image/png", data: "PRIVATE_IMAGE_DATA" },
        ],
      },
    },
  });
  store.appendEvent({
    threadId: thread.threadId,
    eventId: "event-shell-private-id",
    timestamp,
    event: {
      type: "message_appended",
      message: {
        id: "message-shell-private-id",
        role: "user",
        createdAt: timestamp,
        content: [{ type: "text", text: "[User shell command]\n$ cat private.env\nPRIVATE_SHELL_SHORTCUT_OUTPUT\nexit 0" }],
      },
    },
  });
  store.appendEvent({
    threadId: thread.threadId,
    eventId: "event-assistant-private-id",
    timestamp,
    event: {
      type: "message_appended",
      message: {
        id: "message-assistant-private-id",
        role: "assistant",
        createdAt: timestamp,
        content: [
          { type: "text", text: "Visible assistant answer" },
          { type: "tool_call", callId: "call-private-id", name: "private_tool", arguments: { value: "PRIVATE_TOOL_ARGUMENT" } },
          { type: "provider_opaque", provider: "fixture", mediaType: "application/json", value: { private: "PRIVATE_OPAQUE_DATA" } },
        ],
      },
    },
  });
  store.appendEvent({
    threadId: thread.threadId,
    eventId: "event-tool-private-id",
    timestamp,
    event: {
      type: "message_appended",
      message: {
        id: "message-tool-private-id",
        role: "tool",
        createdAt: timestamp,
        content: [{
          type: "tool_result",
          callId: "call-private-id",
          name: "private_tool",
          content: "PRIVATE_RAW_TOOL_RESULT",
          isError: false,
          images: [{ type: "image", mediaType: "image/png", data: "PRIVATE_RESULT_IMAGE" }],
          artifactIds: ["artifact-private-id"],
        }],
      },
    },
  });
  store.appendEvent({
    threadId: thread.threadId,
    eventId: "event-extension-private-id",
    timestamp,
    event: {
      type: "extension_message",
      extensionId: "private.extension",
      schemaVersion: 1,
      kind: "private_notice",
      messageId: "extension-message-private-id",
      payload: { hidden: "PRIVATE_EXTENSION_PAYLOAD" },
      modelContext: false,
      transcript: { text: `Visible extension note for ${workspaceRoot}; authorization: Bearer PRIVATE_EXTENSION_TOKEN` },
    },
  });
  store.putArtifact({
    threadId: thread.threadId,
    artifactId: "artifact-private-id",
    mediaType: "text/plain",
    content: Buffer.from("PRIVATE_ARTIFACT_CONTENT"),
  });

  const normalMarkdown = exportThreadMarkdown(store, thread.threadId);
  const normalHtml = exportThreadHtml(store, thread.threadId);
  assert.match(normalMarkdown, /PRIVATE_TOOL_ARGUMENT|PRIVATE_RAW_TOOL_RESULT|PRIVATE_SHELL_SHORTCUT_OUTPUT/u);
  assert.match(normalHtml, /PRIVATE_TOOL_ARGUMENT|PRIVATE_RAW_TOOL_RESULT|PRIVATE_SHELL_SHORTCUT_OUTPUT/u);

  const redactedMarkdown = exportThreadRedactedMarkdown(store, thread.threadId, { homeRoot, workspaceRoot });
  const redactedHtml = exportThreadRedactedHtml(store, thread.threadId, { homeRoot, workspaceRoot });
  assert.match(redactedMarkdown, /## User\n\n````\n[\s\S]*```embedded fence```[\s\S]*\n````/u);
  assert.match(redactedMarkdown, /<script>PRIVATE_ACTIVE_MARKUP<\/script>/u);
  assert.match(redactedMarkdown, /\[open\]\(javascript:PRIVATE_LINK_TARGET\)/u);

  for (const redacted of [redactedMarkdown, redactedHtml]) {
    assert.match(redacted, /Redacted share copy; review before publishing\./u);
    assert.match(redacted, /Visible assistant answer/u);
    assert.match(redacted, /Visible extension note/u);
    assert.match(redacted, /\[WORKSPACE\]\/secret\.ts/u);
    assert.match(redacted, /\[HOME\]\/notes/u);
    assert.match(redacted, /\[REDACTED\]/u);
    assert.match(redacted, /line one\nline two\nline three/u);
    assert.match(redacted, /PRIVATE_OSC_TITLE|PRIVATE_CSI_TEXT|PRIVATE_C1_CSI/u);
    assert.doesNotMatch(redacted, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u);
    assert.doesNotMatch(redacted, /thread-private-id|event-(?:user|shell|assistant|tool|extension)-private-id/u);
    assert.doesNotMatch(redacted, /message-(?:user|shell|assistant|tool)-private-id|extension-message-private-id|call-private-id/u);
    assert.doesNotMatch(redacted, /PRIVATE_(?:SHELL_SHORTCUT_OUTPUT|TOOL_ARGUMENT|RAW_TOOL_RESULT|IMAGE_DATA|RESULT_IMAGE|OPAQUE_DATA|EXTENSION_PAYLOAD|ARTIFACT_CONTENT)/u);
    assert.doesNotMatch(redacted, /\[User shell command\]|cat private\.env/u);
    assert.doesNotMatch(redacted, /private\.extension|private_notice|private_tool|image\/png|2040-05-06T07:08:09\.123Z/u);
    assert.doesNotMatch(redacted, new RegExp(homeRoot, "u"));
  }
  store.close();
});

test("redacted Markdown enforces the 64 MiB presentation limit", () => {
  const store = new SessionStore(":memory:");
  const thread = store.createThread({ threadId: "oversized-redacted-markdown" });
  store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "message_appended",
      message: {
        id: "oversized-message",
        role: "user",
        createdAt: new Date(0).toISOString(),
        content: [{ type: "text", text: "é".repeat((64 * 1024 * 1024) / 2) }],
      },
    },
  });
  assert.throws(
    () => exportThreadRedactedMarkdown(store, thread.threadId),
    /Redacted Markdown export exceeds the 67108864 byte limit/u,
  );
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
