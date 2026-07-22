import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { EventEnvelope } from "../../src/core/events.js";
import {
  bindInteractiveSessionPresentation,
  interactiveTranscriptHistory,
} from "../../src/interactive/session-presentation.js";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "../../src/service/agent-session.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { DEFAULT_TUI_LIMITS, type TuiController } from "../../src/tui/controller.js";
import { TuiModel } from "../../src/tui/model.js";
import type { TuiSessionEntry, TuiTranscriptItem } from "../../src/tui/types.js";

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
  assert.deepEqual(projected.flatMap((item) => "event" in item ? [] : [item.customType]), ["counter", "notice"]);
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

test("non-display entry floods do not crowd visible resume history out", async () => {
  const storage = await manager();
  storage.appendMessage({
    id: "retained-user-message",
    role: "user",
    content: [{ type: "text", text: "retained visible history" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  for (let index = 0; index < 2_000; index += 1) storage.appendThinkingLevelChange("off");

  const projected = interactiveTranscriptHistory(fakeSession(storage).session);

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
