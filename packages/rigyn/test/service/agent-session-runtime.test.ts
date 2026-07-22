import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type { CanonicalMessage } from "../../src/core/types.js";
import type { AgentSession, AgentSessionReplacedContext } from "../../src/service/agent-session.js";
import {
  AgentSessionRuntime,
  createAgentSessionRuntime,
  type AgentSessionRuntimeServices,
  type CreateAgentSessionRuntimeFactory,
  type SessionStartEvent,
} from "../../src/service/agent-session-runtime.js";
import { SessionManager } from "../../src/storage/session-manager.js";

const roots = new Set<string>();

test.afterEach(async () => {
  await Promise.all([...roots].map(async (root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function temporaryRoot(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "rigyn-agent-session-runtime-"));
  roots.add(value);
  return value;
}

let messageSequence = 0;
function message(role: "user" | "assistant", text: string): CanonicalMessage {
  messageSequence += 1;
  return {
    id: `message-${messageSequence}`,
    role,
    content: [{ type: "text", text }],
    createdAt: new Date(1_700_000_000_000 + messageSequence).toISOString(),
  };
}

interface Services extends AgentSessionRuntimeServices {
  generation: number;
}

function fakeSession(manager: SessionManager, generation: number, events: string[]): AgentSession {
  const context = Object.freeze({ generation }) as unknown as AgentSessionReplacedContext;
  return {
    get sessionManager() { return manager; },
    get sessionFile() { return manager.getSessionFile(); },
    async close() { events.push(`session.close:${generation}`); },
    createReplacedSessionContext() { events.push(`context:${generation}`); return context; },
  } as unknown as AgentSession;
}

function factory(events: string[]): {
  create: CreateAgentSessionRuntimeFactory<Services>;
  starts: Array<SessionStartEvent | undefined>;
} {
  let generation = 0;
  const starts: Array<SessionStartEvent | undefined> = [];
  return {
    starts,
    create: async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      generation += 1;
      starts.push(sessionStartEvent);
      events.push(`factory:${generation}`);
      return {
        session: fakeSession(sessionManager, generation, events),
        services: {
          cwd,
          agentDir,
          generation,
          async close() { events.push(`services.close:${generation}`); },
        },
        diagnostics: [{ type: "info", message: `generation ${generation}` }],
      };
    },
  };
}

function persist(manager: SessionManager): string {
  manager.appendMessage(message("user", "hello"));
  manager.appendMessage(message("assistant", "hi"));
  return manager.getSessionFile()!;
}

test("a cancelled switch leaves the current session and services untouched", async () => {
  const root = await temporaryRoot();
  const current = SessionManager.inMemory(root, { id: "current" });
  const target = SessionManager.create(root, join(root, "sessions"), { id: "target" });
  const targetPath = persist(target);
  const events: string[] = [];
  const { create } = factory(events);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: current,
  }, {
    async beforeSwitch(event) {
      events.push(`guard:${event.reason}:${event.targetSessionFile}`);
      return { cancel: true, reason: "stay" };
    },
    async shutdown() { events.push("shutdown"); },
  });
  events.length = 0;

  assert.deepEqual(await runtime.switchSession(targetPath), { cancelled: true });
  assert.equal(runtime.session.sessionManager.getSessionId(), "current");
  assert.deepEqual(events, [`guard:resume:${resolve(targetPath)}`]);
});

test("an allowed switch tears down before construction and rebinds before withSession", async () => {
  const root = await temporaryRoot();
  const current = SessionManager.inMemory(root, { id: "current" });
  const target = SessionManager.create(root, join(root, "sessions"), { id: "target" });
  const targetPath = persist(target);
  const events: string[] = [];
  const { create, starts } = factory(events);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: current,
  }, {
    async beforeSwitch(event) { events.push(`guard:${event.reason}:${event.targetSessionFile}`); },
    async shutdown(event) { events.push(`shutdown:${event.reason}:${event.targetSessionFile}`); },
  });
  runtime.setBeforeSessionInvalidate(() => events.push("invalidate"));
  runtime.setRebindSession(async () => { events.push("rebind"); });
  events.length = 0;

  const result = await runtime.switchSession(targetPath, {
    async withSession() { events.push("withSession"); },
  });
  assert.deepEqual(result, { cancelled: false });
  assert.equal(runtime.session.sessionManager.getSessionId(), "target");
  assert.deepEqual(events, [
    `guard:resume:${resolve(targetPath)}`,
    `shutdown:resume:${resolve(targetPath)}`,
    "invalidate",
    "session.close:1",
    "services.close:1",
    "factory:2",
    "rebind",
    "context:2",
    "withSession",
  ]);
  assert.deepEqual(starts[1], {
    type: "session_start",
    reason: "resume",
  });
});

test("an owner-managed reload can adopt its replacement session without closing shared services", async () => {
  const root = await temporaryRoot();
  const events: string[] = [];
  const { create } = factory(events);
  const manager = SessionManager.inMemory(root, { id: "current" });
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: manager,
  });
  runtime.setBeforeSessionInvalidate(() => events.push("invalidate"));
  runtime.setRebindSession(async () => { events.push("rebind"); });
  events.length = 0;

  const replacement = fakeSession(manager, 2, events);
  await runtime.adoptSession(replacement);
  assert.equal(runtime.session, replacement);
  assert.deepEqual(events, ["invalidate", "rebind"]);
});

test("fork guards run before mutation and an allowed before-fork returns the selected user text", async () => {
  const root = await temporaryRoot();
  const sessions = join(root, "sessions");
  const manager = SessionManager.create(root, sessions, { id: "source" });
  const user = manager.appendMessage(message("user", "revise this"));
  manager.appendMessage(message("assistant", "first result"));
  const sourcePath = manager.getSessionFile()!;
  const events: string[] = [];
  const { create, starts } = factory(events);
  let cancel = true;
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: manager,
  }, {
    async beforeFork(event) {
      events.push(`guard:${event.entryId}:${event.position}`);
      return cancel ? { cancel: true } : undefined;
    },
    async shutdown(event) { events.push(`shutdown:${event.reason}`); },
  });
  events.length = 0;

  assert.deepEqual(await runtime.fork(user), { cancelled: true });
  assert.equal(runtime.session.sessionFile, sourcePath);
  assert.deepEqual(events, [`guard:${user}:before`]);

  cancel = false;
  events.length = 0;
  assert.deepEqual(await runtime.fork(user), { cancelled: false, selectedText: "revise this" });
  assert.notEqual(runtime.session.sessionFile, sourcePath);
  assert.deepEqual(events.slice(0, 5), [
    `guard:${user}:before`,
    "shutdown:fork",
    "session.close:1",
    "services.close:1",
    "factory:2",
  ]);
  assert.deepEqual(starts[1], {
    type: "session_start",
    reason: "fork",
    previousSessionFile: sourcePath,
  });
});

test("a persistent session cannot fork before its first assistant response is saved", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.create(root, join(root, "sessions"), { id: "unsaved" });
  const user = manager.appendMessage(message("user", "not saved yet"));
  const events: string[] = [];
  const { create } = factory(events);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: manager,
  });
  events.length = 0;

  await assert.rejects(runtime.fork(user, { position: "at" }), /session has not been saved yet/u);
  assert.equal(runtime.session.sessionManager.getSessionId(), "unsaved");
  assert.deepEqual(events, []);
});

test("dispose emits quit exactly once before closing the owned generation", async () => {
  const root = await temporaryRoot();
  const events: string[] = [];
  const { create } = factory(events);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.inMemory(root),
  }, {
    async shutdown(event) { events.push(`shutdown:${event.reason}`); },
  });
  events.length = 0;
  await runtime.dispose();
  await runtime.dispose();
  assert.deepEqual(events, ["shutdown:quit", "session.close:1", "services.close:1"]);
});

test("the public constructor accepts the session, services, factory, diagnostics, and fallback", async () => {
  const root = await temporaryRoot();
  const events: string[] = [];
  const { create } = factory(events);
  const manager = SessionManager.inMemory(root, { id: "direct" });
  const session = fakeSession(manager, 7, events);
  const services: Services = { cwd: root, agentDir: join(root, "agent"), generation: 7 };
  const runtime = new AgentSessionRuntime(
    session,
    services,
    create,
    [{ type: "warning", message: "fixture" }],
    "fallback",
  );

  assert.equal(runtime.session, session);
  assert.equal(runtime.services, services);
  assert.deepEqual(runtime.diagnostics, [{ type: "warning", message: "fixture" }]);
  assert.equal(runtime.modelFallbackMessage, "fallback");
});
