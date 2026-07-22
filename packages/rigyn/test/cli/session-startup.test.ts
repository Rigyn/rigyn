import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parseArgs } from "../../src/cli/args.js";
import {
  createStartupSession,
  validateSessionFlags,
  type SessionStartupInteraction,
} from "../../src/cli/session-startup.js";
import type { CanonicalMessage } from "../../src/core/types.js";
import { SessionManager } from "../../src/storage/session-manager.js";

const roots = new Set<string>();

test.afterEach(async () => {
  await Promise.all([...roots].map(async (root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "rigyn-session-startup-"));
  roots.add(value);
  return value;
}

let sequence = 0;
function message(role: "user" | "assistant", text: string): CanonicalMessage {
  sequence += 1;
  return {
    id: `message-${sequence}`,
    role,
    content: [{ type: "text", text }],
    createdAt: new Date(1_700_000_000_000 + sequence).toISOString(),
  };
}

function persist(manager: SessionManager): string {
  manager.appendMessage(message("user", "hello"));
  manager.appendMessage(message("assistant", "hi"));
  return manager.getSessionFile()!;
}

const noInteraction: SessionStartupInteraction = {
  async selectSession() { throw new Error("unexpected selector"); },
  async confirmForkFromWorkspace() { throw new Error("unexpected confirmation"); },
};

test("session flags keep fork target IDs valid and reject ambiguous selectors", () => {
  assert.doesNotThrow(() => validateSessionFlags(parseArgs(["--fork", "source", "--session-id", "copy.one"])));
  assert.doesNotThrow(() => validateSessionFlags(parseArgs(["--no-session", "--session-id", "temporary.one"])));
  assert.throws(() => validateSessionFlags(parseArgs(["--fork", "source", "--continue"])), /--fork cannot be combined/u);
  assert.throws(() => validateSessionFlags(parseArgs(["--session-id", "copy", "--resume"])), /--session-id cannot be combined/u);
  assert.throws(() => validateSessionFlags(parseArgs(["--session-id", "bad id"])), /letters, numbers/u);
});

test("resume invokes the selector instead of continuing the most recent session", async () => {
  const base = await root();
  const workspace = join(base, "workspace");
  const sessions = join(base, "sessions");
  const older = SessionManager.create(workspace, sessions, { id: "older" });
  const olderPath = persist(older);
  persist(SessionManager.create(workspace, sessions, { id: "newer" }));
  let selected = false;
  const result = await createStartupSession(parseArgs(["--resume"]), workspace, sessions, {
    async selectSession(current) {
      selected = true;
      assert.equal((await current()).some((session) => session.path === olderPath), true);
      return olderPath;
    },
    async confirmForkFromWorkspace() { throw new Error("unexpected confirmation"); },
  });
  assert.equal(selected, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.sessionManager?.getSessionId(), "older");
});

test("--all starts resume with every workspace and continues the newest global session", async () => {
  const base = await root();
  const current = join(base, "current");
  const other = join(base, "other");
  const sessions = join(base, "sessions");
  persist(SessionManager.create(current, sessions, { id: "local" }));
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  const newest = SessionManager.create(other, sessions, { id: "global-newest" });
  const newestPath = persist(newest);

  const resumed = await createStartupSession(parseArgs(["--resume", "--all"]), current, sessions, {
    async selectSession(initial, all) {
      assert.deepEqual((await initial()).map((entry) => entry.path), (await all()).map((entry) => entry.path));
      return newestPath;
    },
    async confirmForkFromWorkspace() { throw new Error("unexpected confirmation"); },
  });
  assert.equal(resumed.sessionManager?.getSessionId(), "global-newest");

  const continued = await createStartupSession(parseArgs(["--continue", "--all"]), current, sessions, noInteraction);
  assert.equal(continued.sessionManager?.getSessionId(), "global-newest");
  assert.equal(continued.sessionManager?.getCwd(), resolve(other));
});

test("cancelled resume does not create or open a replacement session", async () => {
  const base = await root();
  const result = await createStartupSession(parseArgs(["--resume"]), base, join(base, "sessions"), {
    async selectSession() { return undefined; },
    async confirmForkFromWorkspace() { throw new Error("unexpected confirmation"); },
  });
  assert.deepEqual(result, { cancelled: true });
});

test("an exact project session ID resumes while an unused ID creates a session", async () => {
  const base = await root();
  const workspace = join(base, "workspace");
  const sessions = join(base, "sessions");
  persist(SessionManager.create(workspace, sessions, { id: "known" }));

  const existing = await createStartupSession(parseArgs(["--session-id", "known"]), workspace, sessions, noInteraction);
  assert.equal(existing.sessionManager?.getSessionId(), "known");
  assert.equal(existing.sessionManager?.getEntries().length, 2);

  const created = await createStartupSession(parseArgs(["--session-id", "fresh"]), workspace, sessions, noInteraction);
  assert.equal(created.sessionManager?.getSessionId(), "fresh");
  assert.equal(created.sessionManager?.getEntries().length, 0);
});

test("an exact project session name resumes and an ambiguous name fails", async () => {
  const base = await root();
  const workspace = join(base, "workspace");
  const sessions = join(base, "sessions");
  const first = SessionManager.create(workspace, sessions, { id: "named-first" });
  first.appendSessionInfo("friendly name");
  persist(first);

  const resumed = await createStartupSession(parseArgs(["--session", "friendly name"]), workspace, sessions, noInteraction);
  assert.equal(resumed.sessionManager?.getSessionId(), "named-first");

  const second = SessionManager.create(workspace, sessions, { id: "named-second" });
  second.appendSessionInfo("friendly name");
  persist(second);
  await assert.rejects(
    createStartupSession(parseArgs(["--session", "friendly name"]), workspace, sessions, noInteraction),
    /ambiguous/u,
  );
});

test("fork accepts a target ID, preserves source history, and rejects collisions", async () => {
  const base = await root();
  const workspace = join(base, "workspace");
  const sessions = join(base, "sessions");
  persist(SessionManager.create(workspace, sessions, { id: "source" }));

  const forked = await createStartupSession(
    parseArgs(["--fork", "source", "--session-id", "copy"]),
    workspace,
    sessions,
    noInteraction,
  );
  assert.equal(forked.sessionManager?.getSessionId(), "copy");
  assert.equal(forked.sessionManager?.getEntries().length, 2);
  persist(forked.sessionManager!);

  await assert.rejects(
    createStartupSession(parseArgs(["--fork", "source", "--session-id", "copy"]), workspace, sessions, noInteraction),
    /already exists/u,
  );
});

test("an explicit session in another workspace forks only after confirmation", async () => {
  const base = await root();
  const current = join(base, "current");
  const other = join(base, "other");
  const sessions = join(base, "sessions");
  const sourcePath = persist(SessionManager.create(other, sessions, { id: "outside" }));

  const pathCancelled = await createStartupSession(parseArgs(["--session", sourcePath]), current, sessions, {
    async selectSession() { throw new Error("unexpected selector"); },
    async confirmForkFromWorkspace(workspace) { assert.equal(workspace, resolve(other)); return false; },
  });
  assert.deepEqual(pathCancelled, { cancelled: true });

  const cancelled = await createStartupSession(parseArgs(["--session", "outside"]), current, sessions, {
    async selectSession() { throw new Error("unexpected selector"); },
    async confirmForkFromWorkspace(workspace) { assert.equal(workspace, resolve(other)); return false; },
  });
  assert.deepEqual(cancelled, { cancelled: true });

  const forked = await createStartupSession(parseArgs(["--session", "outside"]), current, sessions, {
    async selectSession() { throw new Error("unexpected selector"); },
    async confirmForkFromWorkspace(workspace) { assert.equal(workspace, resolve(other)); return true; },
  });
  assert.equal(forked.sessionManager?.getCwd(), resolve(current));
  assert.equal(forked.sessionManager?.getHeader()?.parentSession, sourcePath);
});

test("an explicit missing session path fails instead of planning a new file", async () => {
  const base = await root();
  await assert.rejects(
    createStartupSession(
      parseArgs(["--session", join(base, "missing.jsonl")]),
      base,
      join(base, "sessions"),
      noInteraction,
    ),
    /No session found/u,
  );
});
