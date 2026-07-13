import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SessionIndexError,
  WorkspaceSessionIndex,
} from "../../src/cli/session-index.js";
import { SessionStore } from "../../src/storage/store.js";

const FIXED_TIME = "2026-07-10T12:00:00.000Z";

function savedThread(
  store: SessionStore,
  input: { threadId: string; name: string; workspaceRoot: string },
): void {
  store.createThread(input);
  store.appendEvent({
    threadId: input.threadId,
    event: {
      type: "message_appended",
      message: {
        id: `${input.threadId}-user`,
        role: "user",
        createdAt: FIXED_TIME,
        content: [{ type: "text", text: `${input.name} prompt` }],
      },
    },
  });
}

test("central session index is private, bounded, detached, and refreshes exact workspace metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-index-"));
  const workspace = join(root, "workspace");
  const databasePath = join(root, "sessions.sqlite");
  const indexPath = join(root, "state", "session-index.sqlite");
  await mkdir(workspace);
  const canonicalWorkspace = await realpath(workspace);
  const store = new SessionStore(databasePath, { clock: () => new Date(FIXED_TIME) });
  t.after(() => store.close());
  savedThread(store, { threadId: "thread_indexed", name: "Indexed session", workspaceRoot: canonicalWorkspace });
  store.createThread({ threadId: "crash_left_empty", name: "Must not resume", workspaceRoot: canonicalWorkspace });

  const index = await WorkspaceSessionIndex.open(indexPath, { clock: () => new Date(FIXED_TIME) });
  t.after(() => index.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await index.refreshWorkspace({ workspaceRoot: workspace, databasePath });
  assert.equal(snapshot.workspaceRoot, canonicalWorkspace);
  assert.equal(snapshot.databasePath, await realpath(databasePath));
  assert.equal(snapshot.sessions, 1);
  if (process.platform !== "win32") {
    assert.equal((await stat(indexPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "state"))).mode & 0o777, 0o700);
  }

  const listed = index.list();
  assert.deepEqual(listed, [{
    threadId: "thread_indexed",
    name: "Indexed session",
    workspaceRoot: canonicalWorkspace,
    databasePath: await realpath(databasePath),
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    indexedAt: FIXED_TIME,
  }]);
  listed[0]!.name = "caller mutation";
  assert.equal(index.list()[0]?.name, "Indexed session");
  assert.throws(() => index.list({ limit: 10_001 }), /between 1 and 10000/u);

  store.nameThread("thread_indexed", "Renamed session");
  await index.refreshWorkspace({ workspaceRoot: canonicalWorkspace, databasePath });
  assert.equal(index.list()[0]?.name, "Renamed session");
  store.deleteThread("thread_indexed");
  await index.refreshWorkspace({ workspaceRoot: canonicalWorkspace, databasePath });
  assert.deepEqual(index.list(), []);
});

test("opening an existing index never closes a raw descriptor that cancels another SQLite connection's locks", async (t) => {
  if (process.platform !== "linux") return;
  const root = await mkdtemp(join(tmpdir(), "harness-session-index-locks-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const indexPath = join(root, "index.sqlite");
  const initialized = await WorkspaceSessionIndex.open(indexPath);
  initialized.close();

  const lockHolder = new DatabaseSync(indexPath);
  lockHolder.exec("BEGIN IMMEDIATE");
  const inode = String((await stat(indexPath)).ino);
  const hasKernelLock = async (): Promise<boolean> => {
    const locks = await readFile("/proc/locks", "utf8");
    return locks.split("\n").some((line) => line.includes(`:${inode} `));
  };
  assert.equal(await hasKernelLock(), true, "fixture must hold a SQLite advisory lock");
  try {
    await assert.rejects(
      WorkspaceSessionIndex.open(indexPath, { busyTimeoutMs: 0 }),
      (error: unknown) => error instanceof SessionIndexError && error.code === "SESSION_INDEX_SCHEMA",
    );
    assert.equal(await hasKernelLock(), true, "opening the index must not cancel another connection's locks");
  } finally {
    lockHolder.exec("ROLLBACK");
    lockHolder.close();
  }
});

test("session index pagination exposes more than 500 equal-timestamp sessions with stable searchable cursors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-index-page-"));
  const workspace = join(root, "workspace");
  const databasePath = join(root, "sessions.sqlite");
  await mkdir(workspace);
  const canonicalWorkspace = await realpath(workspace);
  const store = new SessionStore(databasePath, { clock: () => new Date(FIXED_TIME) });
  const index = await WorkspaceSessionIndex.open(join(root, "index.sqlite"), { clock: () => new Date(FIXED_TIME) });
  t.after(async () => {
    index.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  for (let ordinal = 0; ordinal < 525; ordinal += 1) {
    const suffix = String(ordinal).padStart(4, "0");
    savedThread(store, {
      threadId: `thread-${suffix}`,
      name: ordinal === 524 ? "Deep archive needle" : `Archive ${suffix}`,
      workspaceRoot: canonicalWorkspace,
    });
  }
  await index.refreshWorkspace({ workspaceRoot: canonicalWorkspace, databasePath });

  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = index.listPage({ limit: 73, ...(cursor === undefined ? {} : { cursor }) });
    ids.push(...page.sessions.map((session) => session.threadId));
    assert.equal(page.hasMore, page.nextCursor !== undefined);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  assert.equal(ids.length, 525);
  assert.equal(new Set(ids).size, 525);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(ids.at(-1), "thread-0524");

  const archive = index.listPage({ search: "archive", limit: 10 });
  assert.equal(archive.sessions.length, 10);
  assert.ok(archive.nextCursor);
  assert.throws(
    () => index.listPage({
      search: "needle",
      limit: 10,
      ...(archive.nextCursor === undefined ? {} : { cursor: archive.nextCursor }),
    }),
    /cursor is invalid/u,
  );
  assert.deepEqual(index.listPage({ search: "deep archive needle", limit: 10 }).sessions.map((entry) => entry.threadId), [
    "thread-0524",
  ]);

  const renamed = store.nameThread("thread-0524", "Renamed catalog target");
  await index.upsertSession({ workspaceRoot: canonicalWorkspace, databasePath, thread: renamed });
  assert.deepEqual(index.listPage({ search: "renamed catalog", limit: 10 }).sessions.map((entry) => entry.threadId), [
    "thread-0524",
  ]);
  store.deleteThread("thread-0524");
  await index.removeSession({ workspaceRoot: canonicalWorkspace, databasePath, threadId: "thread-0524" });
  assert.deepEqual(index.listPage({ search: "renamed catalog", limit: 10 }).sessions, []);
});

test("central session index includes extension-only durable sessions and excludes empty threads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-extension-session-index-"));
  const workspace = join(root, "workspace");
  const databasePath = join(root, "sessions.sqlite");
  const indexPath = join(root, "session-index.sqlite");
  await mkdir(workspace);
  const canonicalWorkspace = await realpath(workspace);
  const store = new SessionStore(databasePath, { clock: () => new Date(FIXED_TIME) });
  const extensionThread = store.createThread({
    threadId: "extension_only",
    name: "Extension only",
    workspaceRoot: canonicalWorkspace,
  });
  store.appendEvent({
    threadId: extensionThread.threadId,
    event: {
      type: "extension_state",
      extensionId: "session.fixture",
      schemaVersion: 1,
      key: "invocations",
      value: { count: 1 },
    },
  });
  store.createThread({ threadId: "actually_empty", workspaceRoot: canonicalWorkspace });
  const index = await WorkspaceSessionIndex.open(indexPath, { clock: () => new Date(FIXED_TIME) });
  t.after(async () => {
    index.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const snapshot = await index.refreshWorkspace({ workspaceRoot: workspace, databasePath });
  assert.equal(snapshot.sessions, 1);
  assert.deepEqual(index.list().map((record) => record.threadId), ["extension_only"]);
  assert.equal((await index.upsertSession({
    workspaceRoot: workspace,
    databasePath,
    thread: store.getThread(extensionThread.threadId),
  })).threadId, extensionThread.threadId);
});

test("central session index serializes refreshes from independent Node processes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-index-concurrent-"));
  const indexPath = join(root, "state", "session-index.sqlite");
  const inputs: Array<{ workspace: string; database: string; threadId: string }> = [];
  for (let index = 0; index < 8; index += 1) {
    const workspace = join(root, `workspace-${index}`);
    const database = join(root, `sessions-${index}.sqlite`);
    await mkdir(workspace);
    const canonical = await realpath(workspace);
    const store = new SessionStore(database);
    savedThread(store, { threadId: `thread_${index}`, name: `Session ${index}`, workspaceRoot: canonical });
    store.close();
    inputs.push({ workspace: canonical, database, threadId: `thread_${index}` });
  }

  await Promise.all(inputs.map(async (input) => await runIndexWorker(indexPath, input.workspace, input.database)));
  const index = await WorkspaceSessionIndex.open(indexPath);
  t.after(() => index.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = index.list({ limit: 100 });
  assert.deepEqual(records.map((record) => record.threadId).sort(), inputs.map((input) => input.threadId).sort());
  assert.equal(new Set(records.map((record) => record.workspaceRoot)).size, inputs.length);
});

test("single-session mutation APIs verify the live database and preserve duplicate IDs by workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-index-mutations-"));
  const indexPath = join(root, "session-index.sqlite");
  const index = await WorkspaceSessionIndex.open(indexPath, { clock: () => new Date(FIXED_TIME) });
  const stores: SessionStore[] = [];
  t.after(() => {
    for (const store of stores) store.close();
    index.close();
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaces: string[] = [];
  for (let ordinal = 0; ordinal < 2; ordinal += 1) {
    const workspace = join(root, `workspace-${ordinal}`);
    const databasePath = join(root, `database-${ordinal}.sqlite`);
    await mkdir(workspace);
    const canonical = await realpath(workspace);
    workspaces.push(canonical);
    const store = new SessionStore(databasePath, { clock: () => new Date(FIXED_TIME) });
    stores.push(store);
    savedThread(store, { threadId: "duplicate_thread", name: `Workspace ${ordinal}`, workspaceRoot: canonical });
    await index.refreshWorkspace({ workspaceRoot: canonical, databasePath });
  }
  assert.equal(index.list().filter((record) => record.threadId === "duplicate_thread").length, 2);

  const firstStore = stores[0]!;
  const firstWorkspace = workspaces[0]!;
  const renamed = firstStore.nameThread("duplicate_thread", "Renamed exactly once");
  const upserted = await index.upsertSession({
    workspaceRoot: firstWorkspace,
    databasePath: join(root, "database-0.sqlite"),
    thread: renamed,
  });
  assert.equal(upserted.name, "Renamed exactly once");
  assert.equal(index.list({ workspaceRoot: firstWorkspace })[0]?.name, "Renamed exactly once");

  firstStore.deleteThread("duplicate_thread");
  await index.removeSession({
    workspaceRoot: firstWorkspace,
    databasePath: join(root, "database-0.sqlite"),
    threadId: "duplicate_thread",
  });
  assert.deepEqual(index.list({ workspaceRoot: firstWorkspace }), []);
  await index.removeWorkspace(firstWorkspace);
  await assert.rejects(
    index.upsertSession({ workspaceRoot: firstWorkspace, databasePath: join(root, "database-0.sqlite"), thread: renamed }),
    (error: unknown) => error instanceof SessionIndexError && error.code === "SESSION_INDEX_STALE",
  );
});

test("indexed target verification rechecks trust, canonical identities, source database, and stale metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-index-verify-"));
  const workspace = join(root, "workspace");
  const databasePath = join(root, "sessions.sqlite");
  const indexPath = join(root, "session-index.sqlite");
  await mkdir(workspace);
  const canonicalWorkspace = await realpath(workspace);
  const store = new SessionStore(databasePath);
  savedThread(store, { threadId: "thread_verify", name: "Verify me", workspaceRoot: canonicalWorkspace });
  const index = await WorkspaceSessionIndex.open(indexPath);
  t.after(async () => {
    try { store.close(); } catch {}
    index.close();
    await rm(root, { recursive: true, force: true });
  });
  await index.refreshWorkspace({ workspaceRoot: workspace, databasePath });
  const record = index.list()[0]!;

  await assert.rejects(
    index.verify(record, { isTrusted: async () => false }),
    (error: unknown) => error instanceof SessionIndexError && error.code === "SESSION_INDEX_UNTRUSTED",
  );
  assert.deepEqual(await index.verify(record, { isTrusted: async () => true }), record);

  const movedWorkspace = join(root, "workspace-before-trust-race");
  await assert.rejects(
    index.verify(record, {
      isTrusted: async () => {
        await rename(workspace, movedWorkspace);
        await mkdir(workspace);
        return true;
      },
    }),
    (error: unknown) => error instanceof SessionIndexError && error.code === "SESSION_INDEX_STALE",
  );
  await rm(workspace, { recursive: true, force: true });
  await rename(movedWorkspace, workspace);

  store.nameThread("thread_verify", "Changed behind index");
  await assert.rejects(
    index.verify(record, { isTrusted: async () => true }),
    (error: unknown) => error instanceof SessionIndexError && error.code === "SESSION_INDEX_STALE",
  );
  await index.refreshWorkspace({ workspaceRoot: workspace, databasePath });

  const replacementPath = join(root, "replacement.sqlite");
  const replacement = new SessionStore(replacementPath);
  savedThread(replacement, { threadId: "thread_verify", name: "Changed behind index", workspaceRoot: canonicalWorkspace });
  replacement.close();
  const tamper = new DatabaseSync(indexPath);
  tamper.prepare("UPDATE workspaces SET database_path = ? WHERE workspace_root = ?")
    .run(await realpath(replacementPath), canonicalWorkspace);
  tamper.close();
  const tampered = index.list()[0]!;
  await assert.rejects(
    index.verify(tampered, { isTrusted: async () => true }),
    (error: unknown) => error instanceof SessionIndexError && error.code === "SESSION_INDEX_STALE",
  );

  await index.refreshWorkspace({ workspaceRoot: workspace, databasePath });
  const beforeReplacement = index.list()[0]!;
  store.close();
  await rename(databasePath, `${databasePath}.old`);
  const newStore = new SessionStore(databasePath);
  savedThread(newStore, { threadId: "thread_replacement", name: "Replacement", workspaceRoot: canonicalWorkspace });
  newStore.close();
  await assert.rejects(
    index.verify(beforeReplacement, { isTrusted: async () => true }),
    (error: unknown) => error instanceof SessionIndexError && error.code === "SESSION_INDEX_STALE",
  );
  await index.refreshWorkspace({ workspaceRoot: workspace, databasePath });
  assert.deepEqual(index.list().map((entry) => entry.threadId), ["thread_replacement"]);
  const replacementRecord = index.list()[0]!;

  await rm(workspace, { recursive: true, force: true });
  await assert.rejects(
    index.verify(replacementRecord, { isTrusted: async () => true }),
    (error: unknown) => error instanceof SessionIndexError && error.code === "SESSION_INDEX_STALE",
  );
});

test("session index rejects symlinks, foreign schemas, corrupt rows, and oversized metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-index-tamper-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  if (process.platform !== "win32") {
    const target = join(root, "target.sqlite");
    await writeFile(target, "not sqlite", { mode: 0o600 });
    const link = join(root, "linked.sqlite");
    await symlink(target, link);
    await assert.rejects(
      WorkspaceSessionIndex.open(link),
      (error: unknown) => error instanceof SessionIndexError && error.code === "SESSION_INDEX_PATH",
    );
  }

  const foreignPath = join(root, "foreign.sqlite");
  const foreign = new DatabaseSync(foreignPath);
  foreign.exec(`
    PRAGMA application_id = ${0x43485349};
    PRAGMA user_version = 1;
    CREATE TABLE workspaces(foo TEXT) STRICT;
    CREATE TABLE sessions(foo TEXT) STRICT;
  `);
  foreign.close();
  await assert.rejects(
    WorkspaceSessionIndex.open(foreignPath),
    (error: unknown) => error instanceof SessionIndexError && error.code === "SESSION_INDEX_SCHEMA",
  );

  const indexPath = join(root, "valid.sqlite");
  const index = await WorkspaceSessionIndex.open(indexPath);
  index.close();
  if (process.platform !== "win32") {
    const hardlink = join(root, "valid-hardlink.sqlite");
    await link(indexPath, hardlink);
    await assert.rejects(
      WorkspaceSessionIndex.open(indexPath),
      (error: unknown) => error instanceof SessionIndexError && error.code === "SESSION_INDEX_PATH",
    );
    await rm(hardlink);
    await chmod(indexPath, 0o666);
    await assert.rejects(
      WorkspaceSessionIndex.open(indexPath),
      (error: unknown) => error instanceof SessionIndexError && error.code === "SESSION_INDEX_PATH",
    );
    await chmod(indexPath, 0o600);
    const repaired = await WorkspaceSessionIndex.open(indexPath);
    repaired.close();
    assert.equal((await stat(indexPath)).mode & 0o777, 0o600);
  }
  const database = new DatabaseSync(indexPath);
  assert.throws(() => database.prepare(`
    INSERT INTO workspaces(
      workspace_root, database_path, workspace_device, workspace_inode,
      database_device, database_inode, indexed_at
    ) VALUES (?, ?, '1', '1', '1', '1', ?)
  `).run(`/${"w".repeat(5_000)}`, "/database", FIXED_TIME));
  database.close();

  const closed = await WorkspaceSessionIndex.open(join(root, "closed.sqlite"));
  closed.close();
  assert.throws(() => closed.list(), /closed/u);
  await assert.rejects(
    closed.refreshWorkspace({ workspaceRoot: root, databasePath: indexPath }),
    /closed/u,
  );
});

test("session index rejects an aliased missing parent before recursive creation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-index-parent-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const target = join(root, "actual");
  const alias = join(root, "alias");
  await mkdir(target);
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    WorkspaceSessionIndex.open(join(alias, "missing", "index.sqlite")),
    (error: unknown) => error instanceof SessionIndexError && error.code === "SESSION_INDEX_PATH",
  );
  await assert.rejects(
    stat(join(target, "missing")),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("session index only reads private, owner-controlled source databases", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "harness-session-index-source-security-"));
  const workspace = join(root, "workspace");
  const databasePath = join(root, "sessions.sqlite");
  const indexPath = join(root, "index.sqlite");
  let index: WorkspaceSessionIndex | undefined;
  try {
    await mkdir(workspace);
    const canonicalWorkspace = await realpath(workspace);
    const store = new SessionStore(databasePath);
    savedThread(store, {
      threadId: "thread_private_source",
      name: "Private source",
      workspaceRoot: canonicalWorkspace,
    });
    store.close();
    index = await WorkspaceSessionIndex.open(indexPath);

    await chmod(databasePath, 0o644);
    await assert.rejects(
      index.refreshWorkspace({ workspaceRoot: workspace, databasePath }),
      (error: unknown) => error instanceof SessionIndexError && error.code === "SESSION_INDEX_STALE",
    );
    await chmod(databasePath, 0o600);

    const hardlink = join(root, "sessions-hardlink.sqlite");
    await link(databasePath, hardlink);
    await assert.rejects(
      index.refreshWorkspace({ workspaceRoot: workspace, databasePath }),
      (error: unknown) => error instanceof SessionIndexError && error.code === "SESSION_INDEX_STALE",
    );
    await rm(hardlink);

    const symlinkPath = join(root, "sessions-symlink.sqlite");
    await symlink(databasePath, symlinkPath);
    await assert.rejects(
      index.refreshWorkspace({ workspaceRoot: workspace, databasePath: symlinkPath }),
      (error: unknown) => error instanceof SessionIndexError && error.code === "SESSION_INDEX_STALE",
    );

    const snapshot = await index.refreshWorkspace({ workspaceRoot: workspace, databasePath });
    assert.equal(snapshot.sessions, 1);
  } finally {
    index?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("session index honors a bounded SQLite lock timeout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-index-busy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const indexPath = join(root, "index.sqlite");
  const initialized = await WorkspaceSessionIndex.open(indexPath);
  initialized.close();
  const blocker = new DatabaseSync(indexPath);
  blocker.exec("BEGIN EXCLUSIVE");
  const started = performance.now();
  try {
    await assert.rejects(
      WorkspaceSessionIndex.open(indexPath, { busyTimeoutMs: 20 }),
      (error: unknown) => error instanceof SessionIndexError && error.code === "SESSION_INDEX_SCHEMA",
    );
    assert.ok(performance.now() - started < 1_000, "opening a locked index must honor the configured timeout");
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
  }
});

async function runIndexWorker(indexPath: string, workspace: string, database: string): Promise<void> {
  const source = `
    import { WorkspaceSessionIndex } from ${JSON.stringify(new URL("../../src/cli/session-index.ts", import.meta.url).href)};
    const index = await WorkspaceSessionIndex.open(process.env.INDEX_PATH);
    await index.refreshWorkspace({ workspaceRoot: process.env.WORKSPACE, databasePath: process.env.DATABASE });
    index.close();
  `;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
      cwd: process.cwd(),
      env: { ...process.env, INDEX_PATH: indexPath, WORKSPACE: workspace, DATABASE: database },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`index worker exited ${code}: ${stdout}${stderr}`));
    });
  });
}
