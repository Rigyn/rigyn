import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

import type { CanonicalMessage } from "../../src/core/types.js";
import type { LoadExtensionsResult } from "../../src/extensions/direct.js";
import type { AgentSession, AgentSessionReplacedContext } from "../../src/service/agent-session.js";
import { createAgentSessionRuntimeCommandActions } from "../../src/service/runtime-command-actions.js";
import {
  AgentSessionRuntime,
  MissingSessionCwdError,
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

function fakeExtensionsResult(generation: number): LoadExtensionsResult {
  return Object.freeze({ generation }) as unknown as LoadExtensionsResult;
}

function fakeSession(manager: SessionManager, generation: number, events: string[]): AgentSession {
  const context = Object.freeze({ generation }) as unknown as AgentSessionReplacedContext;
  return {
    get sessionManager() { return manager; },
    get sessionFile() { return manager.getSessionFile(); },
    async close() {
      events.push(`session.close:${generation}`);
      manager.closeV4Store();
    },
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
        extensionsResult: fakeExtensionsResult(generation),
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

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function settleWithin<T>(operation: Promise<T>, milliseconds = 500): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("operation did not settle after cancellation")), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("a cancelled switch leaves the current session and services untouched", async () => {
  const root = await temporaryRoot();
  const current = SessionManager.inMemory(root, { id: "current" });
  const target = SessionManager.create(root, join(root, "sessions"), { id: "target" });
  const targetPath = persist(target);
  target.closeV4Store();
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

  assert.deepEqual(await runtime.switchSession(targetPath), { cancelled: true, reason: "stay" });
  assert.equal(runtime.session.sessionManager.getSessionId(), "current");
  assert.deepEqual(events, [`guard:resume:${resolve(targetPath)}`]);
});

test("built-in runtime factory results retain extension discovery and diagnostics", async () => {
  const root = await temporaryRoot();
  const events: string[] = [];
  const { create } = factory(events);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.inMemory(root),
  });

  assert.deepEqual(runtime.extensionsResult, fakeExtensionsResult(1));
  assert.deepEqual(runtime.diagnostics, [{ type: "info", message: "generation 1" }]);
  await runtime.dispose();
});

test("an allowed switch tears down before construction and rebinds before withSession", async () => {
  const root = await temporaryRoot();
  const current = SessionManager.inMemory(root, { id: "current" });
  const target = SessionManager.create(root, join(root, "sessions"), { id: "target" });
  const targetPath = persist(target);
  target.closeV4Store();
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

test("switching the owned persistent file releases its writer before reopening it", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.create(root, join(root, "sessions"), { id: "current" });
  const sessionPath = persist(manager);
  const events: string[] = [];
  const { create } = factory(events);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: manager,
  });
  events.length = 0;

  assert.deepEqual(await runtime.switchSession(sessionPath), { cancelled: false });
  assert.equal(runtime.session.sessionManager.getSessionId(), "current");
  assert.deepEqual(events, [
    "session.close:1",
    "services.close:1",
    "factory:2",
    "context:2",
  ]);
  await runtime.dispose();

  const reopened = SessionManager.open(sessionPath);
  reopened.closeV4Store();
});

test("switch reports a missing stored cwd and accepts the active cwd as an explicit override", async () => {
  const root = await temporaryRoot();
  const missingCwd = join(root, "missing-workspace");
  const target = SessionManager.create(missingCwd, join(root, "sessions"), { id: "target" });
  const targetPath = persist(target);
  target.closeV4Store();
  const current = SessionManager.inMemory(root, { id: "current" });
  const events: string[] = [];
  const { create } = factory(events);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: current,
  });
  events.length = 0;

  await assert.rejects(runtime.switchSession(targetPath), (error: unknown) => {
    assert.ok(error instanceof MissingSessionCwdError);
    assert.deepEqual(error.issue, {
      sessionFile: resolve(targetPath),
      sessionCwd: resolve(missingCwd),
      fallbackCwd: root,
    });
    return true;
  });
  assert.equal(runtime.session.sessionManager.getSessionId(), "current");
  assert.deepEqual(events, []);

  assert.deepEqual(await runtime.switchSession(targetPath, { cwdOverride: root }), { cancelled: false });
  assert.equal(runtime.session.sessionManager.getSessionId(), "target");
  assert.equal(runtime.cwd, root);
});

test("a failed switch releases the candidate writer and reopens the previous owner", async () => {
  const root = await temporaryRoot();
  const current = SessionManager.create(root, join(root, "current-sessions"), { id: "current" });
  persist(current);
  const target = SessionManager.create(root, join(root, "target-sessions"), { id: "target" });
  const targetPath = persist(target);
  target.closeV4Store();
  const events: string[] = [];
  let generation = 0;
  const create: CreateAgentSessionRuntimeFactory<Services> = async ({ cwd, agentDir, sessionManager }) => {
    const currentGeneration = ++generation;
    if (currentGeneration === 2) throw new Error("switch factory rejected");
    return {
      session: fakeSession(sessionManager, currentGeneration, events),
      services: { cwd, agentDir, generation: currentGeneration },
    };
  };
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: current,
  });

  await assert.rejects(runtime.switchSession(targetPath), /switch factory rejected/u);
  assert.equal(runtime.session.sessionManager.getSessionId(), "current");
  const reopenedTarget = SessionManager.open(targetPath);
  reopenedTarget.closeV4Store();
  await runtime.dispose();
});

test("an owner-managed refresh can adopt its replacement session without closing shared services", async () => {
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

test("refresh adoption finishes after a cancellation that arrives beyond the commit boundary", async () => {
  const root = await temporaryRoot();
  const events: string[] = [];
  const { create } = factory(events);
  const manager = SessionManager.inMemory(root, { id: "current" });
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: manager,
  });
  const initial = runtime.session;
  const replacement = fakeSession(manager, 2, events);
  const controller = new AbortController();
  let reportCommit!: () => void;
  const committed = new Promise<void>((resolveCommit) => { reportCommit = resolveCommit; });
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>((resolveCleanup) => { finishCleanup = resolveCleanup; });
  const adopted: AgentSession[] = [];

  const operation = runtime.refreshSession(initial, async () => {
    reportCommit();
    await cleanup;
    return replacement;
  }, {
    signal: controller.signal,
    async withSession(session) {
      adopted.push(session);
    },
  });
  await committed;
  controller.abort(new Error("late refresh cancellation"));
  finishCleanup();
  await operation;

  assert.equal(runtime.session, replacement);
  assert.deepEqual(adopted, [replacement]);
  await runtime.dispose();
});

test("adoptSession does not commit when invalidation aborts or replacement rebinding fails", async () => {
  const root = await temporaryRoot();
  const events: string[] = [];
  const { create } = factory(events);
  const manager = SessionManager.inMemory(root, { id: "current" });
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: manager,
  });
  const initial = runtime.session;
  const abortedReplacement = fakeSession(manager, 2, events);
  const controller = new AbortController();
  runtime.setBeforeSessionInvalidate(() => controller.abort(new Error("adopt cancelled")));

  await assert.rejects(
    runtime.adoptSession(abortedReplacement, { rebind: false, signal: controller.signal }),
    /adopt cancelled/u,
  );
  assert.equal(runtime.session, initial);

  const rejectedReplacement = fakeSession(manager, 3, events);
  runtime.setBeforeSessionInvalidate(undefined);
  runtime.setRebindSession(async () => { throw new Error("rebind rejected"); });
  await assert.rejects(runtime.adoptSession(rejectedReplacement), /rebind rejected/u);
  assert.equal(runtime.session, initial);

  const cancelledReplacement = fakeSession(manager, 4, events);
  const commitController = new AbortController();
  runtime.setRebindSession(async () => { commitController.abort(new Error("late adopt cancellation")); });
  await assert.rejects(
    runtime.adoptSession(cancelledReplacement, { signal: commitController.signal }),
    /late adopt cancellation/u,
  );
  assert.equal(runtime.session, initial);
});

test("new-session setup failure leaves the owned session and services untouched", async () => {
  const root = await temporaryRoot();
  const events: string[] = [];
  const { create } = factory(events);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.inMemory(root, { id: "current" }),
  });
  const initialSession = runtime.session;
  const initialServices = runtime.services;
  events.length = 0;

  await assert.rejects(runtime.newSession({
    async setup() { throw new Error("setup rejected"); },
  }), /setup rejected/u);

  assert.equal(runtime.session, initialSession);
  assert.equal(runtime.services, initialServices);
  assert.deepEqual(events, []);
});

test("failed persistent new-session preparation removes only its created journal", async () => {
  const root = await temporaryRoot();
  const sessions = join(root, "sessions");
  const manager = SessionManager.create(root, sessions, { id: "current" });
  const currentFile = manager.getSessionFile()!;
  const preservedFile = join(sessions, "user-owned.jsonl");
  await writeFile(preservedFile, "preserve this file");
  const events: string[] = [];
  const { create } = factory(events);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: manager,
  });
  events.length = 0;

  await assert.rejects(runtime.newSession({
    async setup() { throw new Error("persistent setup rejected"); },
  }), /persistent setup rejected/u);

  assert.equal(runtime.session.sessionManager, manager);
  assert.deepEqual(
    (await readdir(sessions)).filter((name) => name.endsWith(".jsonl")).sort(),
    [basename(currentFile), basename(preservedFile)].sort(),
  );
  assert.equal(await readFile(preservedFile, "utf8"), "preserve this file");
  assert.deepEqual(events, []);
  await runtime.dispose();
});

test("linked runtime replacement prepares exactly one fresh session", async () => {
  const root = await temporaryRoot();
  const sessionDir = join(root, "sessions");
  const events: string[] = [];
  const { create } = factory(events);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.create(root, sessionDir, { id: "current" }),
  });

  await runtime.newSession({ parentSession: "parent-session" });

  assert.equal(runtime.session.sessionManager.getHeader()!.parentSession, "parent-session");
  assert.equal((await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl")).length, 2);
  await runtime.dispose();
});

test("dispose promptly cancels a new-session setup callback that ignores its signal", async () => {
  const root = await temporaryRoot();
  const events: string[] = [];
  const { create } = factory(events);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.inMemory(root, { id: "current" }),
  });
  const setupStarted = deferred();
  events.length = 0;

  const replacement = runtime.newSession({
    async setup() {
      setupStarted.resolve();
      await new Promise<void>(() => undefined);
    },
  }).then(
    () => ({ status: "fulfilled" as const }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
  await setupStarted.promise;

  const [replacementResult] = await settleWithin(Promise.all([replacement, runtime.dispose()]));
  assert.equal(replacementResult.status, "rejected");
  assert.match(
    replacementResult.status === "rejected" && replacementResult.reason instanceof Error
      ? replacementResult.reason.message
      : "",
    /disposed during session replacement/u,
  );
  assert.deepEqual(events, ["session.close:1", "services.close:1"]);
});

test("an aborted mutation rejects while queued without waiting for the active callback", async () => {
  const root = await temporaryRoot();
  const events: string[] = [];
  const { create } = factory(events);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.inMemory(root, { id: "current" }),
  });
  const firstStarted = deferred();
  const firstController = new AbortController();
  const first = runtime.newSession({
    signal: firstController.signal,
    async setup() {
      firstStarted.resolve();
      await new Promise<void>(() => undefined);
    },
  }).catch((error: unknown) => error);
  await firstStarted.promise;

  let queuedSetupCalled = false;
  const queuedController = new AbortController();
  const queued = runtime.newSession({
    signal: queuedController.signal,
    async setup() { queuedSetupCalled = true; },
  }).catch((error: unknown) => error);
  const queuedReason = new Error("queued mutation cancelled");
  queuedController.abort(queuedReason);

  assert.equal(await settleWithin(queued), queuedReason);
  assert.equal(queuedSetupCalled, false);
  firstController.abort(new Error("active mutation cancelled"));
  assert.match(String(await settleWithin(first)), /active mutation cancelled/u);
  await runtime.dispose();
});

test("an aborted lifecycle guard settles promptly and cannot mutate the owned session later", async () => {
  const root = await temporaryRoot();
  const events: string[] = [];
  const { create } = factory(events);
  const guardStarted = deferred();
  const releaseGuard = deferred<{ cancel: true; reason: string }>();
  let guardSignal: AbortSignal | undefined;
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.inMemory(root, { id: "current" }),
  }, {
    async beforeSwitch(_event, signal) {
      guardSignal = signal;
      guardStarted.resolve();
      return await releaseGuard.promise;
    },
  });
  const initial = runtime.session;
  const controller = new AbortController();
  const operation = runtime.newSession({ signal: controller.signal });
  await guardStarted.promise;

  controller.abort(new Error("guard cancelled"));
  await assert.rejects(settleWithin(operation), /guard cancelled/u);
  assert.equal(guardSignal?.aborted, true);
  assert.match(String(guardSignal?.reason), /guard cancelled/u);
  releaseGuard.resolve({ cancel: true, reason: "late guard result" });
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(runtime.session, initial);
  assert.equal(runtime.services.generation, 1);
  await runtime.dispose();
});

test("factory failure recreates the previous owned generation and reports the original error", async () => {
  const root = await temporaryRoot();
  const events: string[] = [];
  let generation = 0;
  const create: CreateAgentSessionRuntimeFactory<Services> = async ({
    cwd,
    agentDir,
    sessionManager,
  }) => {
    const currentGeneration = ++generation;
    events.push(`factory:${currentGeneration}`);
    if (currentGeneration === 2) throw new Error("replacement factory rejected");
    return {
      session: fakeSession(sessionManager, currentGeneration, events),
      extensionsResult: fakeExtensionsResult(currentGeneration),
      diagnostics: [],
      services: {
        cwd,
        agentDir,
        generation: currentGeneration,
        async close() { events.push(`services.close:${currentGeneration}`); },
      },
    };
  };
  const manager = SessionManager.inMemory(root, { id: "current" });
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: manager,
  });
  runtime.setRebindSession(async () => { events.push(`rebind:${runtime.services.generation}`); });
  events.length = 0;

  await assert.rejects(runtime.newSession(), /replacement factory rejected/u);

  assert.equal(runtime.session.sessionManager, manager);
  assert.equal(runtime.services.generation, 3);
  assert.deepEqual(events, [
    "session.close:1",
    "services.close:1",
    "factory:2",
    "factory:3",
    "rebind:3",
  ]);
});

test("failed persistent new-session construction removes its candidate after owner recovery", async () => {
  const root = await temporaryRoot();
  const sessions = join(root, "sessions");
  const manager = SessionManager.create(root, sessions, { id: "current" });
  const currentFile = manager.getSessionFile()!;
  const preservedFile = join(sessions, "user-owned.jsonl");
  await writeFile(preservedFile, "preserve this file");
  const events: string[] = [];
  let generation = 0;
  const create: CreateAgentSessionRuntimeFactory<Services> = async ({ cwd, agentDir, sessionManager }) => {
    const currentGeneration = ++generation;
    if (currentGeneration === 2) throw new Error("persistent factory rejected");
    return {
      session: fakeSession(sessionManager, currentGeneration, events),
      services: { cwd, agentDir, generation: currentGeneration },
    };
  };
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: manager,
  });

  await assert.rejects(runtime.newSession(), /persistent factory rejected/u);

  assert.equal(runtime.session.sessionManager.getSessionId(), "current");
  assert.deepEqual(
    (await readdir(sessions)).filter((name) => name.endsWith(".jsonl")).sort(),
    [basename(currentFile), basename(preservedFile)].sort(),
  );
  assert.deepEqual(
    (await readdir(sessions)).filter((name) => name.endsWith(".writer-lock")),
    [`${basename(currentFile)}.writer-lock`],
  );
  assert.equal(await readFile(preservedFile, "utf8"), "preserve this file");
  await runtime.dispose();
});

test("rebind failure closes the candidate once and recreates the previous generation", async () => {
  const root = await temporaryRoot();
  const events: string[] = [];
  let generation = 0;
  const create: CreateAgentSessionRuntimeFactory<Services> = async ({
    cwd,
    agentDir,
    sessionManager,
  }) => {
    const currentGeneration = ++generation;
    events.push(`factory:${currentGeneration}`);
    return {
      session: fakeSession(sessionManager, currentGeneration, events),
      extensionsResult: fakeExtensionsResult(currentGeneration),
      diagnostics: [],
      services: {
        cwd,
        agentDir,
        generation: currentGeneration,
        async close() { events.push(`services.close:${currentGeneration}`); },
      },
    };
  };
  const manager = SessionManager.inMemory(root, { id: "current" });
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: manager,
  });
  let rejectNextRebind = true;
  runtime.setRebindSession(async () => {
    events.push(`rebind:${runtime.services.generation}`);
    if (rejectNextRebind) {
      rejectNextRebind = false;
      throw new Error("candidate rebind rejected");
    }
  });
  events.length = 0;

  await assert.rejects(runtime.newSession(), /candidate rebind rejected/u);

  assert.equal(runtime.session.sessionManager, manager);
  assert.equal(runtime.services.generation, 3);
  assert.deepEqual(events, [
    "session.close:1",
    "services.close:1",
    "factory:2",
    "rebind:2",
    "session.close:2",
    "services.close:2",
    "factory:3",
    "rebind:3",
  ]);
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
      return cancel ? { cancel: true, reason: "keep current branch" } : undefined;
    },
    async shutdown(event) { events.push(`shutdown:${event.reason}`); },
  });
  events.length = 0;

  assert.deepEqual(await runtime.fork(user), { cancelled: true, reason: "keep current branch" });
  assert.equal(runtime.session.sessionFile, sourcePath);
  assert.deepEqual(events, [`guard:${user}:before`]);

  cancel = false;
  events.length = 0;
  assert.deepEqual(await runtime.fork(user), { cancelled: false, selectedText: "revise this" });
  assert.notEqual(runtime.session.sessionFile, sourcePath);
  assert.equal(runtime.session.sessionManager.getHeader()!.parentSession, "source");
  assert.equal((await readdir(sessions)).filter((name) => name.endsWith(".jsonl")).length, 2);
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

test("a persistent V4 session can fork its durably saved first user message", async () => {
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

  assert.deepEqual(await runtime.fork(user, { position: "at" }), { cancelled: false });
  assert.notEqual(runtime.session.sessionManager.getSessionId(), "unsaved");
  assert.deepEqual(runtime.session.sessionManager.getEntries().map((entry) => entry.id), [user]);
  assert.deepEqual(events, [
    "session.close:1",
    "services.close:1",
    "factory:2",
    "context:2",
  ]);
});

test("a failed in-memory fork leaves the original branch and entries unchanged", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.inMemory(root, { id: "source" });
  const user = manager.appendMessage(message("user", "keep this branch"));
  const assistant = manager.appendMessage(message("assistant", "original response"));
  const events: string[] = [];
  let generation = 0;
  const create: CreateAgentSessionRuntimeFactory<Services> = async ({
    cwd,
    agentDir,
    sessionManager,
  }) => {
    const currentGeneration = ++generation;
    events.push(`factory:${currentGeneration}`);
    if (currentGeneration === 2) throw new Error("fork factory rejected");
    return {
      session: fakeSession(sessionManager, currentGeneration, events),
      extensionsResult: fakeExtensionsResult(currentGeneration),
      diagnostics: [],
      services: {
        cwd,
        agentDir,
        generation: currentGeneration,
        async close() { events.push(`services.close:${currentGeneration}`); },
      },
    };
  };
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: manager,
  });

  await assert.rejects(runtime.fork(user, { position: "at" }), /fork factory rejected/u);

  assert.equal(runtime.session.sessionManager, manager);
  assert.equal(manager.getSessionId(), "source");
  assert.equal(manager.getLeafId(), assistant);
  assert.deepEqual(manager.getEntries().map((entry) => entry.id), [user, assistant]);
  assert.deepEqual(
    manager.buildSessionContext().messages.map((entry) => entry.role),
    ["user", "assistant"],
  );
});

test("a failed persistent fork releases its candidate writer before owner recovery", async () => {
  const root = await temporaryRoot();
  const sessions = join(root, "sessions");
  const manager = SessionManager.create(root, sessions, { id: "source" });
  const user = manager.appendMessage(message("user", "keep this branch"));
  manager.appendMessage(message("assistant", "original response"));
  const sourcePath = manager.getSessionFile()!;
  const preservedFile = join(sessions, "user-owned.jsonl");
  await writeFile(preservedFile, "preserve this file");
  const events: string[] = [];
  let generation = 0;
  const create: CreateAgentSessionRuntimeFactory<Services> = async ({ cwd, agentDir, sessionManager }) => {
    const currentGeneration = ++generation;
    if (currentGeneration === 2) throw new Error("fork factory rejected");
    return {
      session: fakeSession(sessionManager, currentGeneration, events),
      services: { cwd, agentDir, generation: currentGeneration },
    };
  };
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: manager,
  });

  await assert.rejects(runtime.fork(user, { position: "at" }), /fork factory rejected/u);
  assert.equal(runtime.session.sessionManager.getSessionId(), "source");
  assert.deepEqual(
    (await readdir(sessions)).filter((name) => name.endsWith(".writer-lock")),
    [`${basename(sourcePath)}.writer-lock`],
  );
  assert.deepEqual(
    (await readdir(sessions)).filter((name) => name.endsWith(".jsonl")).sort(),
    [basename(sourcePath), basename(preservedFile)].sort(),
  );
  assert.equal(await readFile(preservedFile, "utf8"), "preserve this file");
  await runtime.dispose();
});

test("import reports a missing stored cwd and accepts the active cwd as an explicit override", async () => {
  const root = await temporaryRoot();
  const missingCwd = join(root, "missing-workspace");
  const source = SessionManager.create(missingCwd, join(root, "source-sessions"), { id: "imported" });
  const sourcePath = persist(source);
  const current = SessionManager.create(root, join(root, "current-sessions"), { id: "current" });
  persist(current);
  const events: string[] = [];
  const { create } = factory(events);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: current,
  });
  events.length = 0;

  await assert.rejects(runtime.importFromJsonl(sourcePath), (error: unknown) => {
    assert.ok(error instanceof MissingSessionCwdError);
    assert.equal(error.issue.sessionCwd, resolve(missingCwd));
    assert.equal(error.issue.fallbackCwd, root);
    assert.match(error.issue.sessionFile, /current-sessions[/\\].+_imported\.jsonl$/u);
    return true;
  });
  assert.equal(runtime.session.sessionManager.getSessionId(), "current");
  assert.deepEqual(events, []);

  assert.deepEqual(await runtime.importFromJsonl(sourcePath, root), { cancelled: false });
  assert.equal(runtime.session.sessionManager.getSessionId(), "imported");
  assert.equal(runtime.cwd, root);
});

test("import rejects nonregular sources without blocking and preserves regular-file symlink aliases", {
  skip: process.platform === "win32" ? "POSIX FIFO and device probe" : false,
}, async () => {
  const root = await temporaryRoot();
  const source = SessionManager.create(root, join(root, "source-sessions"), { id: "imported" });
  const sourcePath = persist(source);
  source.closeV4Store();
  const alias = join(root, "alias.jsonl");
  const fifo = join(root, "blocked.jsonl");
  const directory = join(root, "directory.jsonl");
  await symlink(sourcePath, alias, "file");
  execFileSync("mkfifo", [fifo]);
  await mkdir(directory);

  const events: string[] = [];
  const { create } = factory(events);
  const current = SessionManager.create(root, join(root, "current-sessions"), { id: "current" });
  persist(current);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: current,
  });

  await assert.rejects(
    runtime.importFromJsonl(fifo, root, AbortSignal.timeout(1_000)),
    /not a regular file/u,
  );
  await assert.rejects(runtime.importFromJsonl(directory, root), /not a regular file/u);
  await assert.rejects(runtime.importFromJsonl("/dev/null", root), /not a regular file/u);
  assert.deepEqual(await runtime.importFromJsonl(alias, root), { cancelled: false });
  assert.equal(runtime.session.sessionManager.getSessionId(), "imported");
  await runtime.dispose();
});

test("import never overwrites a colliding destination", async () => {
  const root = await temporaryRoot();
  const source = SessionManager.create(root, join(root, "source-sessions"), { id: "imported" });
  const sourcePath = persist(source);
  const currentDirectory = join(root, "current-sessions");
  const current = SessionManager.create(root, currentDirectory, { id: "current" });
  persist(current);
  const collidingPath = join(currentDirectory, basename(sourcePath));
  const existing = Buffer.from("existing destination\n");
  await writeFile(collidingPath, existing);

  const events: string[] = [];
  const { create } = factory(events);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: current,
  });
  assert.deepEqual(await runtime.importFromJsonl(sourcePath, root), { cancelled: false });
  assert.deepEqual(await readFile(collidingPath), existing);
  assert.equal(runtime.session.sessionManager.getSessionId(), "imported");
  assert.notEqual(runtime.session.sessionFile, collidingPath);
  assert.equal((await readdir(currentDirectory)).some((name) => name.startsWith(".rigyn-import-")), false);
});

test("import never follows a colliding destination symlink", async (context) => {
  const root = await temporaryRoot();
  const source = SessionManager.create(root, join(root, "source-sessions"), { id: "symlinked" });
  const sourcePath = persist(source);
  const currentDirectory = join(root, "current-sessions");
  const current = SessionManager.create(root, currentDirectory, { id: "current" });
  persist(current);
  const victim = join(root, "victim.txt");
  const victimBytes = Buffer.from("do not replace\n");
  await writeFile(victim, victimBytes);
  const linkedDestination = join(currentDirectory, basename(sourcePath));
  try {
    await symlink(victim, linkedDestination, "file");
  } catch (error) {
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      context.skip("file symlinks are not available in this environment");
      return;
    }
    throw error;
  }

  const events: string[] = [];
  const { create } = factory(events);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: current,
  });
  assert.deepEqual(await runtime.importFromJsonl(sourcePath, root), { cancelled: false });
  assert.deepEqual(await readFile(victim), victimBytes);
  assert.equal(runtime.session.sessionManager.getSessionId(), "symlinked");
  assert.notEqual(runtime.session.sessionFile, linkedDestination);
});

test("invalid and cancelled imports leave no destination or private staging files", async () => {
  const root = await temporaryRoot();
  const currentDirectory = join(root, "current-sessions");
  const current = SessionManager.create(root, currentDirectory, { id: "current" });
  persist(current);
  const invalidDestination = join(currentDirectory, "invalid.jsonl");
  const invalidDestinationBytes = Buffer.from("existing invalid destination\n");
  await writeFile(invalidDestination, invalidDestinationBytes);
  const baseline = (await readdir(currentDirectory)).sort();
  const events: string[] = [];
  const guardStarted = deferred<string | undefined>();
  const releaseGuard = deferred();
  const { create } = factory(events);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: current,
  }, {
    async beforeSwitch(event) {
      guardStarted.resolve(event.targetSessionFile);
      await releaseGuard.promise;
      return {};
    },
  });

  const invalidPath = join(root, "invalid.jsonl");
  const timestamp = new Date().toISOString();
  await writeFile(invalidPath, `${JSON.stringify({
    record: "session",
    version: 4,
    sessionId: "invalid",
    createdAt: timestamp,
    workspace: root,
    cwd: root,
  })}\n${JSON.stringify({
    record: "commit",
    sequence: 1,
    commitId: "invalid-message",
    committedAt: timestamp,
    changes: [{
      type: "conversation_node",
      node: {
        id: "bad",
        parentId: null,
        nodeType: "message",
        role: "invalid",
        content: [],
        createdAt: timestamp,
      },
    }],
  })}\n`);
  await assert.rejects(runtime.importFromJsonl(invalidPath, root), /role must be one of/u);
  assert.deepEqual((await readdir(currentDirectory)).sort(), baseline);
  assert.deepEqual(await readFile(invalidDestination), invalidDestinationBytes);

  const source = SessionManager.create(root, join(root, "source-sessions"), { id: "cancelled" });
  const sourcePath = persist(source);
  const controller = new AbortController();
  const importing = runtime.importFromJsonl(sourcePath, root, controller.signal);
  const candidate = await guardStarted.promise;
  assert.equal(typeof candidate, "string");
  controller.abort(new Error("cancel import"));
  await assert.rejects(importing, /cancel import/u);
  releaseGuard.resolve();
  assert.deepEqual((await readdir(currentDirectory)).sort(), baseline);
  assert.equal(runtime.session.sessionManager.getSessionId(), "current");
});

test("a guarded import cancellation removes the committed candidate", async () => {
  const root = await temporaryRoot();
  const source = SessionManager.create(root, join(root, "source-sessions"), { id: "cancelled" });
  const sourcePath = persist(source);
  const currentDirectory = join(root, "current-sessions");
  const current = SessionManager.create(root, currentDirectory, { id: "current" });
  persist(current);
  const baseline = (await readdir(currentDirectory)).sort();
  const events: string[] = [];
  const { create } = factory(events);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: current,
  }, {
    async beforeSwitch() {
      return { cancel: true, reason: "stay" };
    },
  });

  assert.deepEqual(await runtime.importFromJsonl(sourcePath, root), { cancelled: true, reason: "stay" });
  assert.deepEqual((await readdir(currentDirectory)).sort(), baseline);
  assert.equal(runtime.session.sessionManager.getSessionId(), "current");
});

test("an import replacement failure recovers the owner and removes the committed candidate", async () => {
  const root = await temporaryRoot();
  const source = SessionManager.create(root, join(root, "source-sessions"), { id: "failed-import" });
  const sourcePath = persist(source);
  const sourceBytes = await readFile(sourcePath);
  const currentDirectory = join(root, "current-sessions");
  const current = SessionManager.create(root, currentDirectory, { id: "current" });
  persist(current);
  const baseline = (await readdir(currentDirectory)).sort();
  const events: string[] = [];
  let generation = 0;
  const create: CreateAgentSessionRuntimeFactory<Services> = async ({ cwd, agentDir, sessionManager }) => {
    const currentGeneration = ++generation;
    if (currentGeneration === 2) throw new Error("import factory rejected");
    return {
      session: fakeSession(sessionManager, currentGeneration, events),
      extensionsResult: fakeExtensionsResult(currentGeneration),
      diagnostics: [],
      services: { cwd, agentDir, generation: currentGeneration },
    };
  };
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: current,
  });

  await assert.rejects(runtime.importFromJsonl(sourcePath, root), /import factory rejected/u);
  assert.equal(runtime.session.sessionManager.getSessionId(), "current");
  assert.deepEqual((await readdir(currentDirectory)).sort(), baseline);
  assert.deepEqual(await readFile(sourcePath), sourceBytes);
});

test("concurrent retained command actions serialize through withSession and reject the stale mutation", async () => {
  const root = await temporaryRoot();
  const events: string[] = [];
  const { create } = factory(events);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.inMemory(root, { id: "current" }),
  });
  const origin = runtime.session;
  const actions = createAgentSessionRuntimeCommandActions(runtime, origin);
  const setupStarted = deferred();
  const releaseSetup = deferred();
  const hookStarted = deferred();
  const releaseHook = deferred();
  let hookActive = false;
  let secondSettled = false;
  events.length = 0;

  const first = actions.newSession({
    async setup() {
      setupStarted.resolve();
      await releaseSetup.promise;
    },
    async withSession() {
      hookActive = true;
      hookStarted.resolve();
      assert.notEqual(runtime.session, origin);
      await releaseHook.promise;
      hookActive = false;
    },
  });
  await setupStarted.promise;
  const second = actions.newSession().then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  ).finally(() => { secondSettled = true; });
  releaseSetup.resolve();
  await hookStarted.promise;
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));

  assert.equal(hookActive, true);
  assert.equal(secondSettled, false);
  assert.deepEqual(events, [
    "session.close:1",
    "services.close:1",
    "factory:2",
    "context:2",
  ]);

  releaseHook.resolve();
  assert.deepEqual(await first, { cancelled: false });
  const secondResult = await second;
  assert.equal(secondResult.status, "rejected");
  assert.match(
    secondResult.status === "rejected" && secondResult.reason instanceof Error
      ? secondResult.reason.message
      : "",
    /stale after session replacement/u,
  );
  assert.equal(runtime.services.generation, 2);
});

test("refresh and new-session actions share one owner transaction and cannot overwrite each other", async () => {
  const root = await temporaryRoot();
  const events: string[] = [];
  const { create } = factory(events);
  const manager = SessionManager.inMemory(root, { id: "current" });
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: manager,
  });
  const origin = runtime.session;
  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  const replacement = fakeSession(manager, 99, events);
  let newSettled = false;
  const actions = createAgentSessionRuntimeCommandActions(runtime, origin, {
    async refresh() {
      refreshStarted.resolve();
      await releaseRefresh.promise;
      return replacement;
    },
  });
  events.length = 0;

  const refresh = actions.refresh();
  await refreshStarted.promise;
  const createNew = actions.newSession().then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  ).finally(() => { newSettled = true; });
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(newSettled, false);

  releaseRefresh.resolve();
  await refresh;
  const newResult = await createNew;
  assert.equal(runtime.session, replacement);
  assert.equal(runtime.services.generation, 1);
  assert.equal(newResult.status, "rejected");
  assert.match(
    newResult.status === "rejected" && newResult.reason instanceof Error
      ? newResult.reason.message
      : "",
    /stale after session replacement/u,
  );
  assert.deepEqual(events, []);
});

test("caller cancellation during a stalled replacement factory recovers the owner", async () => {
  const root = await temporaryRoot();
  const events: string[] = [];
  const candidateStarted = deferred();
  const releaseCandidate = deferred();
  const candidateClosed = deferred();
  const factorySignals: AbortSignal[] = [];
  let generation = 0;
  const create: CreateAgentSessionRuntimeFactory<Services> = async ({
    cwd,
    agentDir,
    sessionManager,
    signal,
  }) => {
    const currentGeneration = ++generation;
    if (signal !== undefined) factorySignals.push(signal);
    events.push(`factory:${currentGeneration}:start`);
    if (currentGeneration === 2) {
      candidateStarted.resolve();
      await releaseCandidate.promise;
    }
    events.push(`factory:${currentGeneration}:return`);
    return {
      session: fakeSession(sessionManager, currentGeneration, events),
      extensionsResult: fakeExtensionsResult(currentGeneration),
      diagnostics: [],
      services: {
        cwd,
        agentDir,
        generation: currentGeneration,
        async close() {
          events.push(`services.close:${currentGeneration}`);
          if (currentGeneration === 2) candidateClosed.resolve();
        },
      },
    };
  };
  const manager = SessionManager.inMemory(root, { id: "current" });
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: manager,
  });
  events.length = 0;

  const controller = new AbortController();
  const cancellation = new Error("caller cancelled replacement");
  const replacement = runtime.newSession({ signal: controller.signal }).catch((error: unknown) => error);
  await candidateStarted.promise;
  controller.abort(cancellation);

  assert.equal(await settleWithin(replacement), cancellation);
  assert.equal(runtime.services.generation, 3);
  assert.equal(runtime.session.sessionManager, manager);
  assert.equal(factorySignals[0]?.aborted, true);
  assert.equal(factorySignals[1]?.aborted, false);

  assert.deepEqual(await runtime.newSession(), { cancelled: false });
  assert.equal(runtime.services.generation, 4);
  releaseCandidate.resolve();
  await settleWithin(candidateClosed.promise);
  assert.equal(runtime.services.generation, 4, "the late candidate must not replace the recovered owner");
  await runtime.dispose();

  for (const currentGeneration of [1, 2, 3, 4]) {
    assert.equal(
      events.filter((entry) => entry === `session.close:${currentGeneration}`).length,
      1,
      `session generation ${currentGeneration} was not closed exactly once`,
    );
    assert.equal(
      events.filter((entry) => entry === `services.close:${currentGeneration}`).length,
      1,
      `service generation ${currentGeneration} was not closed exactly once`,
    );
  }
});

test("caller cancellation cannot recover until destructive teardown finishes", async () => {
  const root = await temporaryRoot();
  const events: string[] = [];
  const closeStarted = deferred();
  const releaseClose = deferred();
  let generation = 0;
  const create: CreateAgentSessionRuntimeFactory<Services> = async ({
    cwd,
    agentDir,
    sessionManager,
  }) => {
    const currentGeneration = ++generation;
    const session = currentGeneration === 1
      ? {
          get sessionManager() { return sessionManager; },
          get sessionFile() { return sessionManager.getSessionFile(); },
          async close() {
            events.push("session.close:1:start");
            closeStarted.resolve();
            await releaseClose.promise;
            sessionManager.closeV4Store();
            events.push("session.close:1:end");
          },
          createReplacedSessionContext() {
            return Object.freeze({ generation: currentGeneration }) as unknown as AgentSessionReplacedContext;
          },
        } as unknown as AgentSession
      : fakeSession(sessionManager, currentGeneration, events);
    return {
      session,
      services: {
        cwd,
        agentDir,
        generation: currentGeneration,
        async close() { events.push(`services.close:${currentGeneration}`); },
      },
    };
  };
  const manager = SessionManager.inMemory(root, { id: "current" });
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: manager,
  });
  const controller = new AbortController();
  const cancellation = new Error("cancel during teardown");
  let settled = false;
  const replacement = runtime.newSession({ signal: controller.signal })
    .catch((error: unknown) => error)
    .finally(() => { settled = true; });

  await closeStarted.promise;
  controller.abort(cancellation);
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(settled, false);
  assert.equal(generation, 1);

  releaseClose.resolve();
  assert.equal(await replacement, cancellation);
  assert.equal(runtime.services.generation, 2);
  assert.equal(runtime.session.sessionManager.getSessionId(), "current");
  assert.deepEqual(events.slice(0, 4), [
    "session.close:1:start",
    "session.close:1:end",
    "services.close:1",
  ]);
  await runtime.dispose();
});

test("dispose during replacement closes every returned generation exactly once", async () => {
  const root = await temporaryRoot();
  const events: string[] = [];
  const candidateStarted = deferred();
  const releaseCandidate = deferred();
  let generation = 0;
  const create: CreateAgentSessionRuntimeFactory<Services> = async ({
    cwd,
    agentDir,
    sessionManager,
  }) => {
    const currentGeneration = ++generation;
    events.push(`factory:${currentGeneration}:start`);
    if (currentGeneration === 2) {
      candidateStarted.resolve();
      await releaseCandidate.promise;
    }
    events.push(`factory:${currentGeneration}:return`);
    return {
      session: fakeSession(sessionManager, currentGeneration, events),
      extensionsResult: fakeExtensionsResult(currentGeneration),
      diagnostics: [],
      services: {
        cwd,
        agentDir,
        generation: currentGeneration,
        async close() { events.push(`services.close:${currentGeneration}`); },
      },
    };
  };
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.inMemory(root, { id: "current" }),
  });
  events.length = 0;

  const replacement = runtime.newSession().then(
    () => ({ status: "fulfilled" as const }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
  await candidateStarted.promise;
  const disposal = runtime.dispose();
  releaseCandidate.resolve();
  const replacementResult = await replacement;
  await disposal;
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));

  assert.equal(replacementResult.status, "rejected");
  assert.match(
    replacementResult.status === "rejected" && replacementResult.reason instanceof Error
      ? replacementResult.reason.message
      : "",
    /disposed during session replacement/u,
  );
  assert.deepEqual(events, [
    "session.close:1",
    "services.close:1",
    "factory:2:start",
    "factory:2:return",
    "session.close:2",
    "services.close:2",
  ]);
  await assert.rejects(runtime.newSession(), /closed/u);
});

test("dispose does not wait for a replacement factory that ignores cancellation", async () => {
  const root = await temporaryRoot();
  const events: string[] = [];
  const candidateStarted = deferred();
  let generation = 0;
  const create: CreateAgentSessionRuntimeFactory<Services> = async ({
    cwd,
    agentDir,
    sessionManager,
  }) => {
    const currentGeneration = ++generation;
    if (currentGeneration === 2) {
      candidateStarted.resolve();
      await new Promise<void>(() => undefined);
    }
    return {
      session: fakeSession(sessionManager, currentGeneration, events),
      extensionsResult: fakeExtensionsResult(currentGeneration),
      diagnostics: [],
      services: {
        cwd,
        agentDir,
        generation: currentGeneration,
        async close() { events.push(`services.close:${currentGeneration}`); },
      },
    };
  };
  const runtime = await createAgentSessionRuntime(create, {
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: SessionManager.inMemory(root, { id: "current" }),
  });

  const replacement = runtime.newSession().catch((error: unknown) => error);
  await candidateStarted.promise;
  const [replacementError] = await settleWithin(Promise.all([replacement, runtime.dispose()]));
  assert.match(String(replacementError), /disposed during session replacement/u);
  assert.deepEqual(events, ["session.close:1", "services.close:1"]);
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
  const extensionsResult = fakeExtensionsResult(7);
  const runtime = new AgentSessionRuntime(
    session,
    services,
    create,
    [{ type: "warning", message: "fixture" }],
    "fallback",
    extensionsResult,
  );

  assert.equal(runtime.session, session);
  assert.equal(runtime.services, services);
  assert.equal(runtime.extensionsResult, extensionsResult);
  assert.deepEqual(runtime.diagnostics, [{ type: "warning", message: "fixture" }]);
  assert.equal(runtime.modelFallbackMessage, "fallback");
});
