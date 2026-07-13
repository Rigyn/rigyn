import assert from "node:assert/strict";
import { test } from "node:test";

import { cloneSessionPath } from "../../src/service/session-clone.js";
import { StoredConversation } from "../../src/service/session-runtime.js";
import { SessionStore } from "../../src/storage/store.js";

function message(id: string, role: "user" | "assistant" | "tool", text: string) {
  return {
    id,
    role,
    createdAt: "2026-07-09T00:00:00.000Z",
    content: [{ type: "text" as const, text }],
  };
}

function sourceSession(store: SessionStore) {
  const thread = store.createThread({ threadId: "source", name: "Original", workspaceRoot: "/workspace" });
  const run = store.startRun({ threadId: thread.threadId, runId: "source-run", provider: "openai", model: "gpt-test" });
  store.appendEvent({
    threadId: thread.threadId,
    runId: run.runId,
    eventId: "start",
    event: { type: "run_started", provider: "openai", model: "gpt-test" },
  });
  const user = store.appendEvent({
    threadId: thread.threadId,
    runId: run.runId,
    eventId: "user",
    event: { type: "message_appended", message: message("user-message", "user", "question") },
  });
  const artifact = store.putArtifact({
    threadId: thread.threadId,
    runId: run.runId,
    artifactId: "source-artifact",
    mediaType: "text/plain",
    content: Buffer.from("artifact body"),
  });
  store.appendEvent({
    threadId: thread.threadId,
    runId: run.runId,
    eventId: "tool-call",
    event: {
      type: "message_appended",
      message: {
        ...message("tool-call-message", "assistant", ""),
        content: [{
          type: "tool_call",
          callId: "call-one",
          name: "read",
          arguments: { path: "artifact.txt" },
        }],
      },
    },
  });
  store.appendEvent({
    threadId: thread.threadId,
    runId: run.runId,
    eventId: "tool-result",
    event: {
      type: "message_appended",
      message: {
        ...message("artifact-message", "tool", "artifact"),
        content: [{
          type: "tool_result",
          callId: "call-one",
          name: "read",
          content: "artifact body",
          isError: false,
          artifactIds: [artifact.artifactId],
        }],
      },
    },
  });
  store.appendEvent({
    threadId: thread.threadId,
    runId: run.runId,
    eventId: "assistant",
    event: {
      type: "message_appended",
      message: {
        ...message("assistant-message", "assistant", "answer"),
        provider: "openai",
      },
      providerState: {
        kind: "openai_responses",
        previousResponseId: "response-one",
        outputItems: [{ type: "message", id: "remote-one" }],
      },
    },
  });
  store.appendEvent({
    threadId: thread.threadId,
    runId: run.runId,
    eventId: "completed",
    event: { type: "run_completed", finishReason: "stop" },
  });
  return { thread, user };
}

test("cloneSessionPath duplicates the active path with remapped runs, events, artifacts, and provider state", async () => {
  const store = new SessionStore(":memory:");
  const { thread } = sourceSession(store);
  store.appendEvent({
    threadId: thread.threadId,
    event: { type: "model_selected", provider: "anthropic", model: "claude-next" },
  });

  const cloned = cloneSessionPath(store, { threadId: thread.threadId, workspaceRoot: "/workspace" });

  assert.notEqual(cloned.thread.threadId, thread.threadId);
  assert.equal(cloned.thread.parentThreadId, thread.threadId);
  assert.equal(cloned.thread.name, "Original (copy)");
  assert.equal(cloned.provider, "anthropic");
  assert.equal(cloned.model, "claude-next");
  assert.deepEqual(store.getModelSelection(cloned.thread.threadId), { provider: "anthropic", model: "claude-next" });
  assert.equal(store.listRuns(cloned.thread.threadId).at(-1)?.state, "completed");
  const copiedArtifact = store.listArtifacts(cloned.thread.threadId)[0];
  assert.ok(copiedArtifact);
  assert.notEqual(copiedArtifact.artifactId, "source-artifact");
  assert.equal(Buffer.from(copiedArtifact.content).toString(), "artifact body");
  const artifactMessage = store.listEvents(cloned.thread.threadId).find((entry) =>
    entry.event.type === "message_appended" && entry.event.message.id === "artifact-message");
  assert.ok(artifactMessage?.event.type === "message_appended");
  const result = artifactMessage.event.message.content.find((block) => block.type === "tool_result");
  assert.deepEqual(result?.type === "tool_result" ? result.artifactIds : undefined, [copiedArtifact.artifactId]);
  const context = await new StoredConversation(store).loadContext(
    cloned.thread.threadId,
    undefined,
    "openai",
    new AbortController().signal,
    "gpt-test",
  );
  assert.equal(context.providerState?.kind, "openai_responses");
  store.close();
});

test("cloneSessionPath remaps latest resolved labels and omits targets outside the copied path", () => {
  const store = new SessionStore(":memory:");
  const { thread, user } = sourceSession(store);
  store.setEntryLabel({ threadId: thread.threadId, targetEventId: user.eventId, label: "first" });
  store.setEntryLabel({ threadId: thread.threadId, targetEventId: user.eventId, label: "keep" });
  store.setEntryLabel({ threadId: thread.threadId, targetEventId: "start", label: "remove" });
  store.setEntryLabel({ threadId: thread.threadId, targetEventId: "start" });
  const assistant = store.listEvents(thread.threadId).find((entry) =>
    entry.event.type === "message_appended" && entry.event.message.id === "assistant-message");
  assert.ok(assistant);
  store.setEntryLabel({ threadId: thread.threadId, targetEventId: assistant.eventId, label: "outside" });

  const cloned = cloneSessionPath(store, {
    threadId: thread.threadId,
    atEventId: user.eventId,
    workspaceRoot: "/workspace",
  });
  const labels = store.listEntryLabels(cloned.thread.threadId);
  assert.equal(labels.length, 1);
  assert.equal(labels[0]?.label, "keep");
  assert.notEqual(labels[0]?.targetEventId, user.eventId);
  const target = store.listEvents(cloned.thread.threadId).find((entry) => entry.eventId === labels[0]?.targetEventId);
  assert.equal(target?.event.type, "message_appended");
  assert.equal(target?.event.type === "message_appended" ? target.event.message.id : undefined, "user-message");
  store.close();
});

test("forking at a user event omits later output and closes the copied partial run", () => {
  const store = new SessionStore(":memory:");
  const { thread, user } = sourceSession(store);

  const forked = cloneSessionPath(store, {
    threadId: thread.threadId,
    atEventId: user.eventId,
    name: "Try another way",
    workspaceRoot: "/workspace",
  });

  assert.equal(forked.thread.name, "Try another way");
  assert.equal(forked.sourceEventId, user.eventId);
  const copied = store.listEvents(forked.thread.threadId);
  assert.equal(copied.some((entry) => entry.event.type === "message_appended" && entry.event.message.id === "user-message"), true);
  assert.equal(copied.some((entry) => entry.event.type === "message_appended" && entry.event.message.id === "assistant-message"), false);
  assert.equal(store.listRuns(forked.thread.threadId).at(-1)?.state, "cancelled");
  assert.doesNotThrow(() => store.startRun({ threadId: forked.thread.threadId, runId: "next-run" }));
  store.close();
});

test("forking before a user run restores a clean path without copying that prompt", () => {
  const store = new SessionStore(":memory:");
  const { thread, user } = sourceSession(store);

  const forked = cloneSessionPath(store, {
    threadId: thread.threadId,
    atEventId: null,
    name: "Edit root prompt",
    workspaceRoot: "/workspace",
  });

  assert.equal(forked.thread.name, "Edit root prompt");
  assert.equal(forked.sourceEventId, undefined);
  assert.deepEqual(store.listEvents(forked.thread.threadId), []);
  assert.equal(store.listEvents(forked.thread.threadId).some((entry) => entry.eventId === user.eventId), false);
  store.close();
});

test("cloneSessionPath rejects a fork point outside the selected branch without creating a session", () => {
  const store = new SessionStore(":memory:");
  const { thread } = sourceSession(store);
  const before = store.listThreads().length;

  assert.throws(
    () => cloneSessionPath(store, { threadId: thread.threadId, atEventId: "missing", workspaceRoot: "/workspace" }),
    /not on session path/u,
  );
  assert.equal(store.listThreads().length, before);
  store.close();
});
