import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceSessionFacade } from "../../src/service/session-access.js";
import { SessionStore } from "../../src/storage/store.js";

test("workspace session facade scopes extension reads and writes before store access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-access-"));
  const workspace = join(root, "workspace");
  const foreignWorkspace = join(root, "foreign");
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const local = store.createThread({ threadId: "local", workspaceRoot: workspace });
  const foreign = store.createThread({ threadId: "foreign", workspaceRoot: foreignWorkspace });
  const access = new WorkspaceSessionFacade(store, workspace);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const event = access.appendEvent(local.threadId, "main", {
    type: "extension_state",
    extensionId: "fixture",
    schemaVersion: 1,
    key: "state",
    value: { ready: true },
  });
  assert.equal(access.extensionState(local.threadId, "main", "fixture", 1, "state")?.eventId, event.eventId);
  assert.throws(() => access.branch(local.threadId, "missing"), /Unknown branch/u);
  assert.throws(() => access.appendEvent(foreign.threadId, "main", {
    type: "extension_state",
    extensionId: "fixture",
    schemaVersion: 1,
    key: "state",
    value: { leaked: true },
  }), /belongs to/u);
  assert.equal(store.listEvents(foreign.threadId, "main").length, 0);
});

test("workspace session queries and commands keep metadata, history, runs, artifacts, and parents scoped", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-query-"));
  const workspace = join(root, "workspace");
  const foreignWorkspace = join(root, "foreign");
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const access = new WorkspaceSessionFacade(store, workspace);
  const local = access.mutate({ type: "create", threadId: "local", name: "Original" });
  const foreign = store.createThread({ threadId: "foreign", workspaceRoot: foreignWorkspace });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const message = access.appendEvent(local.threadId, "main", {
    type: "message_appended",
    message: {
      id: "message-local",
      role: "user",
      content: [{ type: "text", text: "scoped history" }],
      createdAt: "2026-07-17T00:00:00.000Z",
    },
  });
  access.mutate({ type: "name", threadId: local.threadId, name: "Renamed" });
  access.mutate({
    type: "label",
    threadId: local.threadId,
    branch: "main",
    targetEventId: message.eventId,
    label: "checkpoint",
  });
  access.mutate({
    type: "fork",
    input: { threadId: local.threadId, fromBranch: "main", newBranch: "alternate", atEventId: message.eventId },
  });
  store.startRun({ threadId: local.threadId, branch: "main", runId: "run-local", provider: "offline", model: "fixture" });
  store.putArtifact({ threadId: local.threadId, artifactId: "artifact-local", mediaType: "text/plain", content: Buffer.from("artifact") });

  let eventReads = 0;
  const listEvents = store.listEvents.bind(store);
  store.listEvents = (threadId, branch) => {
    eventReads += 1;
    return listEvents(threadId, branch);
  };
  const runOnly = access.snapshot({ threadId: local.threadId, include: { runs: true } });
  assert.deepEqual(runOnly.runs?.map((run) => run.runId), ["run-local"]);
  assert.equal(eventReads, 0);

  const selectedBranches = access.snapshot({
    threadId: local.threadId,
    include: { branchEvents: ["alternate", "alternate"] },
  });
  assert.deepEqual([...(selectedBranches.branchEvents?.keys() ?? [])], ["alternate"]);
  assert.equal(eventReads, 1);
  eventReads = 0;

  const snapshot = access.snapshot({
    threadId: local.threadId,
    branch: "main",
    include: { events: true, branchEvents: true, runs: true, artifacts: true },
  });
  assert.equal(snapshot.thread.name, "Renamed");
  assert.deepEqual(snapshot.thread.branches.map((entry) => entry.name), ["alternate", "main"]);
  assert.equal(snapshot.events?.some((entry) => entry.eventId === message.eventId), true);
  assert.equal(snapshot.branchEvents?.get("alternate")?.some((entry) => entry.eventId === message.eventId), true);
  assert.deepEqual(snapshot.runs?.map((run) => run.runId), ["run-local"]);
  assert.deepEqual(snapshot.artifacts?.map((artifact) => artifact.artifactId), ["artifact-local"]);
  assert.equal(access.tree(local.threadId, "main").some((row) => row.eventId === message.eventId), true);
  assert.deepEqual(access.metadataPage({ limit: 10 }).threads.map((thread) => thread.threadId), ["local"]);

  assert.throws(() => access.snapshot({ threadId: foreign.threadId, include: { events: true } }), /belongs to/u);
  assert.throws(() => access.tree(foreign.threadId), /belongs to/u);
  assert.throws(() => access.clone({ threadId: foreign.threadId }), /belongs to/u);
  assert.throws(() => access.mutate({ type: "delete", threadId: foreign.threadId }), /belongs to/u);
  assert.throws(() => access.mutate({ type: "create", parentThreadId: foreign.threadId }), /belongs to/u);
  assert.equal(store.getThread(foreign.threadId).workspaceRoot, foreignWorkspace);
});

test("workspace session creation binds parent runs to a local parent session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-parent-run-"));
  const workspace = join(root, "workspace");
  const foreignWorkspace = join(root, "foreign");
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const access = new WorkspaceSessionFacade(store, workspace);
  const local = access.mutate({ type: "create", threadId: "local-parent" });
  const foreign = store.createThread({ threadId: "foreign-parent", workspaceRoot: foreignWorkspace });
  const localRun = store.startRun({ threadId: local.threadId, runId: "local-run" });
  const foreignRun = store.startRun({ threadId: foreign.threadId, runId: "foreign-run" });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  assert.throws(
    () => access.mutate({ type: "create", threadId: "missing-parent", parentRunId: localRun.runId }),
    /requires parentThreadId/u,
  );
  assert.throws(
    () => access.mutate({
      type: "create",
      threadId: "cross-workspace-parent",
      parentThreadId: local.threadId,
      parentRunId: foreignRun.runId,
    }),
    /does not belong to session/u,
  );
  const child = access.mutate({
    type: "create",
    threadId: "local-child",
    parentThreadId: local.threadId,
    parentRunId: localRun.runId,
  });
  assert.equal(child.parentThreadId, local.threadId);
  assert.equal(child.parentRunId, localRun.runId);
  assert.equal(child.workspaceRoot, workspace);
});

test("workspace branch queue capability preserves durable delivery and lease transitions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-queue-"));
  const workspace = join(root, "workspace");
  const foreignWorkspace = join(root, "foreign");
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const access = new WorkspaceSessionFacade(store, workspace);
  const local = access.mutate({ type: "create", threadId: "local" });
  store.createThread({ threadId: "foreign", workspaceRoot: foreignWorkspace });
  access.mutate({ type: "fork", input: { threadId: local.threadId, newBranch: "alternate", atEventId: null } });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const queue = access.queue(local.threadId, "main");
  const leased = queue.enqueue({ mode: "steer", text: "lease me" });
  assert.throws(
    () => access.queue(local.threadId, "alternate").transition(leased.queueId, "dequeue"),
    /cannot be dequeued/u,
  );
  queue.transition(leased.queueId, "lease");
  assert.deepEqual(queue.list(["leased"]).map((record) => record.queueId), [leased.queueId]);
  queue.transition(leased.queueId, "release");
  assert.deepEqual(queue.list(["recoverable"]).map((record) => record.queueId), [leased.queueId]);
  queue.transition(leased.queueId, "lease");
  queue.transition(leased.queueId, "acknowledge");
  assert.deepEqual(queue.list(), []);

  const delivered = queue.enqueue({ mode: "follow_up", text: "deliver me" });
  queue.transition(delivered.queueId, "begin_delivery");
  queue.transition(delivered.queueId, "complete_delivery");
  assert.deepEqual(queue.list(), []);
  assert.throws(() => access.queue("foreign", "main"), /belongs to/u);
});
