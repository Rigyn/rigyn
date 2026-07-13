import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSessionTree } from "../../src/service/session-tree.js";
import { StoredConversation } from "../../src/service/session-runtime.js";
import { SessionStore } from "../../src/storage/store.js";

function user(id: string, text: string) {
  return {
    type: "message_appended" as const,
    message: {
      id: `message-${id}`,
      role: "user" as const,
      createdAt: "2026-07-09T00:00:00.000Z",
      content: [{ type: "text" as const, text }],
    },
  };
}

test("session tree renders shared ancestry and branch endpoints once", () => {
  const store = new SessionStore(":memory:");
  store.createThread({ threadId: "tree" });
  const root = store.appendEvent({ threadId: "tree", eventId: "root", event: user("root", "Start here") });
  const main = store.appendEvent({ threadId: "tree", eventId: "main", event: user("main", "Main direction") });
  store.forkBranch({ threadId: "tree", fromBranch: "main", newBranch: "experiment", atEventId: root.eventId });
  const experiment = store.appendEvent({
    threadId: "tree",
    branch: "experiment",
    eventId: "experiment",
    event: user("experiment", "Try another direction"),
  });

  const rows = buildSessionTree(store, "tree", "experiment");
  assert.deepEqual(rows.map((row) => row.eventId), [root.eventId, main.eventId, experiment.eventId]);
  assert.deepEqual(rows.map((row) => row.prefix), ["└─ ", "   ├─ ", "   └─ "]);
  assert.deepEqual(rows.find((row) => row.eventId === main.eventId)?.branches, ["main"]);
  assert.deepEqual(rows.find((row) => row.eventId === experiment.eventId)?.branches, ["experiment"]);
  assert.deepEqual(rows.find((row) => row.eventId === root.eventId)?.paths, ["experiment", "main"]);
  assert.equal(rows.find((row) => row.eventId === main.eventId)?.sourceBranch, "main");
  assert.equal(rows.find((row) => row.eventId === root.eventId)?.active, true);
  assert.equal(rows.find((row) => row.eventId === experiment.eventId)?.active, true);
  assert.equal(rows.find((row) => row.eventId === main.eventId)?.active, false);
  store.close();
});

test("session tree includes meaningful non-user entries and normalizes previews", () => {
  const store = new SessionStore(":memory:");
  store.createThread({ threadId: "tree-empty" });
  store.appendEvent({ threadId: "tree-empty", event: { type: "warning", code: "empty", message: "no user" } });
  store.forkBranch({ threadId: "tree-empty", newBranch: "warnings" });
  const warnings = buildSessionTree(store, "tree-empty");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.kind, "warning");
  assert.deepEqual(warnings[0]?.paths, ["main", "warnings"]);

  store.appendEvent({ threadId: "tree-empty", event: user("long", `  ${"word ".repeat(40)} `) });
  const row = buildSessionTree(store, "tree-empty").find((entry) => entry.kind === "user");
  assert.ok(row);
  assert.equal(row.text.includes("  "), false);
  assert.equal(row.text.endsWith("…"), true);
  assert.equal(row.text.length, 100);
  store.close();
});

test("session tree identifies a reachable source branch and rewinds before the selected user run", () => {
  const store = new SessionStore(":memory:");
  store.createThread({ threadId: "tree-source" });
  const root = store.appendEvent({ threadId: "tree-source", eventId: "root", event: user("root", "Root") });
  store.forkBranch({ threadId: "tree-source", newBranch: "sibling", atEventId: root.eventId });
  const run = store.startRun({ threadId: "tree-source", branch: "sibling", runId: "sibling-run" });
  store.appendEvent({
    threadId: "tree-source",
    branch: "sibling",
    runId: run.runId,
    eventId: "sibling-start",
    event: { type: "run_started", provider: "test", model: "model" },
  });
  const sibling = store.appendEvent({
    threadId: "tree-source",
    branch: "sibling",
    runId: run.runId,
    eventId: "sibling-user",
    event: user("sibling", "Sibling prompt"),
  });
  const row = buildSessionTree(store, "tree-source", "main").find((entry) => entry.eventId === sibling.eventId);
  assert.ok(row);
  assert.equal(row.sourceBranch, "sibling");
  assert.equal(row.rewindEventId, root.eventId);
  assert.equal(row.restoreText, "Sibling prompt");
  store.close();
});

test("session tree projects resolved labels without exposing metadata events as selectable rows", async () => {
  const store = new SessionStore(":memory:");
  store.createThread({ threadId: "tree-labels" });
  const root = store.appendEvent({ threadId: "tree-labels", eventId: "label-root", event: user("label-root", "Root") });
  store.forkBranch({ threadId: "tree-labels", newBranch: "sibling", atEventId: root.eventId });
  const changed = store.setEntryLabel({
    threadId: "tree-labels",
    branch: "sibling",
    targetEventId: root.eventId,
    label: "bookmark",
  });

  const rows = buildSessionTree(store, "tree-labels", "main");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.eventId, root.eventId);
  assert.equal(rows[0]?.label, "bookmark");
  assert.equal(rows[0]?.labelTimestamp, changed.timestamp);
  assert.equal(rows.some((row) => row.eventId === changed.eventId), false);
  const context = await new StoredConversation(store).loadContext(
    "tree-labels",
    "sibling",
    "fixture",
    new AbortController().signal,
  );
  assert.deepEqual(context.messages.map((message) => message.id), ["message-label-root"]);

  store.setEntryLabel({ threadId: "tree-labels", targetEventId: root.eventId });
  assert.equal(buildSessionTree(store, "tree-labels")[0]?.label, undefined);
  store.close();
});

test("session tree exposes a durable branch summary as one selectable continuation node", () => {
  const store = new SessionStore(":memory:");
  store.createThread({ threadId: "tree-summary" });
  const root = store.appendEvent({ threadId: "tree-summary", eventId: "summary-root", event: user("summary-root", "Root") });
  const abandoned = store.appendEvent({ threadId: "tree-summary", eventId: "summary-source", event: user("summary-source", "Abandoned") });
  const summary = {
    id: "message-branch-summary",
    role: "user" as const,
    purpose: "compaction" as const,
    createdAt: "2026-07-10T00:00:00.000Z",
    content: [{ type: "text" as const, text: "[Abandoned branch summary]\nKeep the earlier decision." }],
  };
  store.forkBranchWithSummary({
    threadId: "tree-summary",
    fromBranch: "main",
    newBranch: "returned",
    atEventId: root.eventId,
    summary,
    sourceBranch: "main",
    sourceEventIds: [abandoned.eventId],
  });

  const rows = buildSessionTree(store, "tree-summary", "returned");
  const summaries = rows.filter((entry) => entry.kind === "branch_summary");
  assert.equal(summaries.length, 1);
  assert.match(summaries[0]?.text ?? "", /earlier decision/u);
  assert.equal(summaries[0]?.active, true);
  store.close();
});
