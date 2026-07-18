import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";

import { configureDatabase, CURRENT_SCHEMA_VERSION, migrateDatabase } from "../../src/storage/index.js";

const timestamp = "2026-01-01T00:00:00.000Z";
const legacyTables = ["approvals", "checkpoints", "background_jobs", "memories", "todos"] as const;

function userVersion(database: DatabaseSync): number {
  return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function tableExists(database: DatabaseSync, name: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function migrationVersions(database: DatabaseSync): number[] {
  return (database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>)
    .map((row) => row.version);
}

function removeVersion17Schema(database: DatabaseSync): void {
  database.exec(`
    DROP INDEX events_tool_progress_incarnation_sequence_idx;
    DROP INDEX events_branch_incarnation_sequence_idx;
    ALTER TABLE branches DROP COLUMN branch_incarnation;
    ALTER TABLE events DROP COLUMN branch_incarnation;
  `);
}

function removeVersion18Schema(database: DatabaseSync): void {
  database.exec("DROP TABLE runtime_child_threads");
}

function createVersion13Fixture(database: DatabaseSync): void {
  migrateDatabase(database);
  removeVersion18Schema(database);
  removeVersion17Schema(database);
  database.exec(`
    DROP INDEX events_branch_sequence_idx;
    DROP TABLE runtime_queue_owners;
    DROP TABLE runtime_run_owners;
    DROP TABLE runtime_owners;
  `);
  database.exec("PRAGMA ignore_check_constraints = ON");
  try {
    database.prepare(`
      INSERT INTO threads(thread_id, default_branch, next_sequence, created_at, updated_at, workspace_root)
      VALUES ('thread_v13', 'main', 4, ?, ?, '/workspace/v13')
    `).run(timestamp, timestamp);
    database.prepare(`
      INSERT INTO branches(thread_id, branch_name, head_event_id, created_at, updated_at)
      VALUES ('thread_v13', 'main', NULL, ?, ?)
    `).run(timestamp, timestamp);
    database.prepare(`
      INSERT INTO runs(run_id, thread_id, branch_name, state, provider, model, started_at)
      VALUES ('run_v13', 'thread_v13', 'main', 'approving', 'offline', 'fixture', ?)
    `).run(timestamp);
    database.prepare(`
      INSERT INTO events(
        event_id, thread_id, run_id, parent_event_id, branch_name,
        sequence, timestamp, kind, schema_version, payload_json
      ) VALUES (?, 'thread_v13', NULL, ?, 'main', ?, ?, ?, 1, ?)
    `).run(
      "event_v13_memory",
      null,
      1,
      timestamp,
      "message_appended",
      JSON.stringify({
        type: "message_appended",
        message: {
          id: "message_v13_memory",
          role: "system",
          content: [{ type: "text", text: "retained legacy memory" }],
          createdAt: timestamp,
          purpose: "memory",
        },
      }),
    );
    database.prepare(`
      INSERT INTO events(
        event_id, thread_id, run_id, parent_event_id, branch_name,
        sequence, timestamp, kind, schema_version, payload_json
      ) VALUES (?, 'thread_v13', NULL, ?, 'main', ?, ?, ?, 1, ?)
    `).run(
      "event_v13_removed",
      "event_v13_memory",
      2,
      timestamp,
      "approval_required",
      JSON.stringify({ type: "approval_required", requestId: "approval_v13" }),
    );
    database.prepare(`
      INSERT INTO events(
        event_id, thread_id, run_id, parent_event_id, branch_name,
        sequence, timestamp, kind, schema_version, payload_json
      ) VALUES (?, 'thread_v13', NULL, ?, 'main', ?, ?, ?, 1, ?)
    `).run(
      "event_v13_kept",
      "event_v13_removed",
      3,
      timestamp,
      "warning",
      JSON.stringify({ type: "warning", code: "kept", message: "unchanged" }),
    );
    database.prepare(`
      UPDATE branches SET head_event_id = 'event_v13_kept'
      WHERE thread_id = 'thread_v13' AND branch_name = 'main'
    `).run();
  } finally {
    database.exec("PRAGMA ignore_check_constraints = OFF");
  }
  for (const table of legacyTables) database.exec(`CREATE TABLE ${table}(value TEXT) STRICT`);
  database.exec(`
    DELETE FROM schema_migrations;
    INSERT INTO schema_migrations(version, applied_at) VALUES (13, '${timestamp}');
    PRAGMA user_version = 13;
  `);
}

function createVersion14Fixture(database: DatabaseSync): void {
  migrateDatabase(database);
  removeVersion18Schema(database);
  removeVersion17Schema(database);
  database.exec(`
    DROP INDEX events_branch_sequence_idx;
    DROP TABLE runtime_queue_owners;
    DROP TABLE runtime_run_owners;
    DROP TABLE runtime_owners;
    DELETE FROM schema_migrations WHERE version >= 15;
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (14, '${timestamp}');
    PRAGMA user_version = 14;
  `);
}

function createVersion16Fixture(database: DatabaseSync): void {
  migrateDatabase(database);
  removeVersion18Schema(database);
  removeVersion17Schema(database);
  database.exec(`
    DELETE FROM schema_migrations WHERE version >= 17;
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (16, '${timestamp}');
    PRAGMA user_version = 16;
  `);
}

function createVersion17Fixture(database: DatabaseSync): void {
  migrateDatabase(database);
  removeVersion18Schema(database);
  database.exec(`
    DELETE FROM schema_migrations WHERE version >= 18;
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (17, '${timestamp}');
    PRAGMA user_version = 17;
  `);
}

function migrationChild(path: string, gatePath?: string, openStore = false): {
  ready: Promise<void>;
  completed: Promise<void>;
  kill(): void;
} {
  const source = `
    import { DatabaseSync } from "node:sqlite";
    import { existsSync } from "node:fs";
    import { setTimeout as wait } from "node:timers/promises";
    import { migrateDatabase } from "./src/storage/migrations.ts";
    import { SessionStore } from "./src/storage/store.ts";
    ${gatePath === undefined ? "" : `
      process.stdout.write("ready\\n");
      while (!existsSync(${JSON.stringify(gatePath)})) await wait(2);
    `}
    ${openStore
      ? `const store = new SessionStore(${JSON.stringify(path)}, { busyTimeoutMs: 10_000 });
         store.close();`
      : `const database = new DatabaseSync(${JSON.stringify(path)}, { timeout: 10_000 });
         ${gatePath === undefined ? "process.stdout.write(\"ready\\n\");" : ""}
         migrateDatabase(database, 10_000);
         database.close();`}
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let readyResolved = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (!readyResolved && stdout.includes("ready\n")) {
      readyResolved = true;
      resolveReady();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!readyResolved) rejectReady(new Error(`migration child exited before ready: ${stderr}`));
      if (code === 0) resolve();
      else reject(new Error(`migration child exited ${String(code)}: ${stderr}`));
    });
  });
  return { ready, completed, kill: () => child.kill("SIGKILL") };
}

async function assertUntouchedConcurrentMigration(path: string, processCount = 6): Promise<void> {
  const gatePath = `${path}.gate`;
  const children = Array.from({ length: processCount }, () => migrationChild(path, gatePath, true));
  try {
    await Promise.all(children.map(async (child) => await child.ready));
    writeFileSync(gatePath, "go", { mode: 0o600 });
    await Promise.all(children.map(async (child) => await child.completed));
  } catch (error) {
    for (const child of children) child.kill();
    throw error;
  }

  const inspection = new DatabaseSync(path);
  try {
    assert.equal(userVersion(inspection), CURRENT_SCHEMA_VERSION);
    assert.equal(migrationVersions(inspection).at(-1), CURRENT_SCHEMA_VERSION);
    assert.deepEqual(inspection.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)), [["ok"]]);
  } finally {
    inspection.close();
  }
}

async function assertConcurrentMigration(path: string, prepare?: (database: DatabaseSync) => void): Promise<void> {
  const locker = new DatabaseSync(path, { timeout: 10_000 });
  let children: ReturnType<typeof migrationChild>[] = [];
  try {
    prepare?.(locker);
    configureDatabase(locker, 10_000);
    locker.exec("BEGIN IMMEDIATE");
    children = [migrationChild(path), migrationChild(path)];
    await Promise.all(children.map(async (child) => await child.ready));
    await wait(150);
    locker.exec("COMMIT");
    await Promise.all(children.map(async (child) => await child.completed));
  } catch (error) {
    try { locker.exec("ROLLBACK"); } catch { /* The lock may already be committed. */ }
    for (const child of children) child.kill();
    throw error;
  } finally {
    locker.close();
  }

  const inspection = new DatabaseSync(path);
  try {
    assert.equal(userVersion(inspection), CURRENT_SCHEMA_VERSION);
    assert.deepEqual(migrationVersions(inspection).at(-1), CURRENT_SCHEMA_VERSION);
    assert.deepEqual(inspection.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)), [["ok"]]);
  } finally {
    inspection.close();
  }
}

test("the retained v13 fixture upgrades through the current schema with ordered history and preserved event identity", () => {
  const database = new DatabaseSync(":memory:");
  createVersion13Fixture(database);

  migrateDatabase(database);

  assert.equal(userVersion(database), CURRENT_SCHEMA_VERSION);
  assert.deepEqual(migrationVersions(database), [13, 14, 15, 16, 17, 18]);
  assert.equal(tableExists(database, "runtime_owners"), true);
  assert.equal(tableExists(database, "runtime_run_owners"), true);
  assert.equal(tableExists(database, "runtime_queue_owners"), true);
  assert.equal(tableExists(database, "runtime_child_threads"), true);
  assert.equal(database.prepare("SELECT state FROM runs WHERE run_id = 'run_v13'").get()?.state, "tool_planning");
  const memory = database.prepare("SELECT * FROM events WHERE event_id = 'event_v13_memory'").get() as {
    event_id: string;
    sequence: number;
    timestamp: string;
    payload_json: string;
  };
  assert.deepEqual([memory.event_id, memory.sequence, memory.timestamp], ["event_v13_memory", 1, timestamp]);
  assert.deepEqual(JSON.parse(memory.payload_json), {
    type: "message_appended",
    message: {
      id: "message_v13_memory",
      role: "system",
      content: [{ type: "text", text: "retained legacy memory" }],
      createdAt: timestamp,
    },
  });
  const removed = database.prepare("SELECT event_id, sequence, timestamp, kind, payload_json FROM events WHERE event_id = 'event_v13_removed'").get() as {
    event_id: string;
    sequence: number;
    timestamp: string;
    kind: string;
    payload_json: string;
  };
  assert.deepEqual([removed.event_id, removed.sequence, removed.timestamp, removed.kind], [
    "event_v13_removed",
    2,
    timestamp,
    "warning",
  ]);
  assert.deepEqual(JSON.parse(removed.payload_json), {
    type: "warning",
    code: "legacy_event_removed",
    message: "This pre-release event belonged to a removed subsystem and was retained only to preserve session history.",
  });
  assert.deepEqual(
    JSON.parse((database.prepare("SELECT payload_json FROM events WHERE event_id = 'event_v13_kept'").get() as { payload_json: string }).payload_json),
    { type: "warning", code: "kept", message: "unchanged" },
  );
  for (const table of legacyTables) assert.equal(tableExists(database, table), false);
  assert.deepEqual(
    database.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)),
    [["ok"]],
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("a late v13 migration failure rolls back data, retired tables, history, and user_version", () => {
  const database = new DatabaseSync(":memory:");
  createVersion13Fixture(database);
  database.exec(`
    CREATE TRIGGER reject_v14_history
    BEFORE INSERT ON schema_migrations
    WHEN NEW.version = 14
    BEGIN
      SELECT RAISE(ABORT, 'fixture migration failure');
    END;
  `);

  assert.throws(() => migrateDatabase(database), /fixture migration failure/u);

  assert.equal(userVersion(database), 13);
  assert.deepEqual(migrationVersions(database), [13]);
  assert.equal(database.prepare("SELECT state FROM runs WHERE run_id = 'run_v13'").get()?.state, "approving");
  assert.equal(database.prepare("SELECT kind FROM events WHERE event_id = 'event_v13_removed'").get()?.kind, "approval_required");
  const memory = JSON.parse((database.prepare("SELECT payload_json FROM events WHERE event_id = 'event_v13_memory'").get() as { payload_json: string }).payload_json);
  assert.equal(memory.message.purpose, "memory");
  for (const table of legacyTables) assert.equal(tableExists(database, table), true);
  database.close();
});

test("the v14 upgrade creates owner fencing and the event branch index atomically", () => {
  const database = new DatabaseSync(":memory:");
  createVersion14Fixture(database);

  migrateDatabase(database);

  assert.equal(userVersion(database), CURRENT_SCHEMA_VERSION);
  assert.deepEqual(migrationVersions(database), [14, 15, 16, 17, 18]);
  assert.equal(tableExists(database, "runtime_owners"), true);
  assert.equal(tableExists(database, "runtime_run_owners"), true);
  assert.equal(tableExists(database, "runtime_queue_owners"), true);
  assert.equal(tableExists(database, "runtime_child_threads"), true);
  assert.notEqual(
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'events_branch_sequence_idx'").get(),
    undefined,
  );
  database.close();
});

test("the v16 upgrade reconstructs branch incarnations without timestamp guesses", () => {
  const database = new DatabaseSync(":memory:");
  createVersion16Fixture(database);
  database.prepare(`
    INSERT INTO threads(thread_id, default_branch, next_sequence, created_at, updated_at)
    VALUES ('thread_incarnations', 'main', 5, ?, ?)
  `).run(timestamp, timestamp);
  database.prepare(`
    INSERT INTO branches(thread_id, branch_name, head_event_id, created_at, updated_at)
    VALUES
      ('thread_incarnations', 'main', NULL, ?, ?),
      ('thread_incarnations', 'experiment', NULL, ?, ?)
  `).run(timestamp, timestamp, timestamp, timestamp);
  const insert = database.prepare(`
    INSERT INTO events(
      event_id, thread_id, parent_event_id, branch_name, sequence,
      timestamp, kind, schema_version, payload_json
    ) VALUES (?, 'thread_incarnations', ?, ?, ?, ?, 'warning', 1, ?)
  `);
  const warning = (code: string) => JSON.stringify({ type: "warning", code, message: code });
  insert.run("event_root", null, "main", 1, timestamp, warning("root"));
  insert.run("event_old", "event_root", "experiment", 2, timestamp, warning("old"));
  insert.run("event_new", "event_root", "experiment", 3, timestamp, warning("new"));
  insert.run("event_new_tail", "event_new", "experiment", 4, timestamp, warning("new-tail"));
  database.exec(`
    UPDATE branches SET head_event_id = 'event_root' WHERE branch_name = 'main';
    UPDATE branches SET head_event_id = 'event_new_tail' WHERE branch_name = 'experiment';
  `);

  migrateDatabase(database);

  assert.deepEqual(
    (database.prepare(`
      SELECT event_id, branch_incarnation
      FROM events
      ORDER BY sequence
    `).all() as Array<{ event_id: string; branch_incarnation: number }>).map((row) => ({ ...row })),
    [
      { event_id: "event_root", branch_incarnation: 1 },
      { event_id: "event_old", branch_incarnation: 1 },
      { event_id: "event_new", branch_incarnation: 2 },
      { event_id: "event_new_tail", branch_incarnation: 2 },
    ],
  );
  assert.deepEqual(
    (database.prepare(`
      SELECT branch_name, branch_incarnation
      FROM branches
      ORDER BY branch_name
    `).all() as Array<{ branch_name: string; branch_incarnation: number }>).map((row) => ({ ...row })),
    [
      { branch_name: "experiment", branch_incarnation: 3 },
      { branch_name: "main", branch_incarnation: 2 },
    ],
  );
  assert.notEqual(
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'events_branch_incarnation_sequence_idx'").get(),
    undefined,
  );
  assert.notEqual(
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'events_tool_progress_incarnation_sequence_idx'").get(),
    undefined,
  );
  database.close();
});

test("a failed v17 migration rolls back incarnation columns, indexes, history, and user_version", () => {
  const database = new DatabaseSync(":memory:");
  createVersion16Fixture(database);
  database.exec(`
    CREATE TRIGGER reject_v17_history
    BEFORE INSERT ON schema_migrations
    WHEN NEW.version = 17
    BEGIN
      SELECT RAISE(ABORT, 'fixture v17 migration failure');
    END;
  `);

  assert.throws(() => migrateDatabase(database), /fixture v17 migration failure/u);

  assert.equal(userVersion(database), 16);
  assert.deepEqual(migrationVersions(database), [16]);
  assert.equal(
    (database.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).some((row) => row.name === "branch_incarnation"),
    false,
  );
  assert.equal(
    (database.prepare("PRAGMA table_info(branches)").all() as Array<{ name: string }>).some((row) => row.name === "branch_incarnation"),
    false,
  );
  assert.equal(
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'events_branch_incarnation_sequence_idx'").get(),
    undefined,
  );
  database.close();
});

test("the v17 upgrade backfills only canonical legacy runtime-child markers", () => {
  const database = new DatabaseSync(":memory:");
  createVersion17Fixture(database);
  const insertThread = database.prepare(`
    INSERT INTO threads(
      thread_id, default_branch, next_sequence, created_at, updated_at, parent_thread_id
    ) VALUES (?, 'main', ?, ?, ?, ?)
  `);
  const insertBranch = database.prepare(`
    INSERT INTO branches(
      thread_id, branch_name, branch_incarnation, head_event_id, created_at, updated_at
    ) VALUES (?, 'main', 1, NULL, ?, ?)
  `);
  const insertRun = database.prepare(`
    INSERT INTO runs(run_id, thread_id, branch_name, state, provider, model, started_at, ended_at)
    VALUES (?, ?, 'main', 'completed', 'fixture', 'fixture', ?, ?)
  `);
  const insertEvent = database.prepare(`
    INSERT INTO events(
      event_id, thread_id, run_id, parent_event_id, branch_name, branch_incarnation,
      sequence, timestamp, kind, schema_version, payload_json
    ) VALUES (?, ?, ?, ?, 'main', 1, ?, ?, 'run_started', 1, ?)
  `);
  const marker = {
    kind: "additional_instructions",
    source: "runtime child run",
    bytes: 0,
    sha256: "0".repeat(64),
  };
  const runStarted = (sources: unknown) => JSON.stringify({
    type: "run_started",
    provider: "fixture",
    model: "fixture",
    promptComposition: {
      bytes: 0,
      sha256: "0".repeat(64),
      ...(sources === undefined ? {} : { sources }),
      tools: [],
      skills: [],
      truncated: false,
    },
  });
  const addThread = (threadId: string, nextSequence: number, parentThreadId: string | null = null) => {
    insertThread.run(threadId, nextSequence, timestamp, timestamp, parentThreadId);
    insertBranch.run(threadId, timestamp, timestamp);
  };
  const addRunStarted = (
    threadId: string,
    sequence: number,
    parentEventId: string | null,
    sources: unknown,
    withRun = true,
  ): string => {
    const eventId = `event_${threadId}_${sequence}`;
    const runId = withRun ? `run_${threadId}_${sequence}` : null;
    if (runId !== null) insertRun.run(runId, threadId, timestamp, timestamp);
    insertEvent.run(eventId, threadId, runId, parentEventId, sequence, timestamp, runStarted(sources));
    database.prepare(`
      UPDATE branches SET head_event_id = ? WHERE thread_id = ? AND branch_name = 'main'
    `).run(eventId, threadId);
    return eventId;
  };

  addThread("legacy_parent", 1);
  addThread("legacy_runtime_child", 3, "legacy_parent");
  const firstLegacy = addRunStarted("legacy_runtime_child", 1, null, [{
    ...marker,
    kind: "instruction",
  }, marker]);
  addRunStarted("legacy_runtime_child", 2, firstLegacy, [marker]);

  addThread("ordinary_v17_thread", 2);
  addRunStarted("ordinary_v17_thread", 1, null, [{ ...marker, kind: "instruction" }]);

  addThread("invalid_sources_thread", 5);
  let invalidParent: string | null = null;
  for (const [sequence, sources] of [
    [1, undefined],
    [2, "not-an-array"],
    [3, marker],
    [4, Array.from({ length: 129 }, () => marker)],
  ] as const) {
    invalidParent = addRunStarted("invalid_sources_thread", sequence, invalidParent, sources);
  }

  addThread("missing_run_thread", 2);
  addRunStarted("missing_run_thread", 1, null, [marker], false);
  database.prepare("DELETE FROM threads WHERE thread_id = 'legacy_parent'").run();

  migrateDatabase(database);

  assert.equal(userVersion(database), CURRENT_SCHEMA_VERSION);
  assert.deepEqual(migrationVersions(database), [17, 18]);
  assert.equal(tableExists(database, "runtime_child_threads"), true);
  assert.deepEqual(
    (database.prepare("SELECT thread_id FROM runtime_child_threads ORDER BY thread_id").all() as Array<{ thread_id: string }>)
      .map((row) => row.thread_id),
    ["legacy_runtime_child"],
  );
  assert.equal(database.prepare("SELECT parent_thread_id FROM threads WHERE thread_id = 'legacy_runtime_child'").get()?.parent_thread_id, null);
  database.prepare("UPDATE branches SET head_event_id = NULL WHERE thread_id = 'legacy_runtime_child'").run();
  database.prepare("UPDATE events SET parent_event_id = NULL WHERE thread_id = 'legacy_runtime_child'").run();
  database.prepare("DELETE FROM events WHERE thread_id = 'legacy_runtime_child'").run();
  database.prepare("DELETE FROM runs WHERE thread_id = 'legacy_runtime_child'").run();
  database.prepare("DELETE FROM branches WHERE thread_id = 'legacy_runtime_child'").run();
  database.prepare("DELETE FROM threads WHERE thread_id = 'legacy_runtime_child'").run();
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM runtime_child_threads").get()?.count, 0);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("a failed v18 migration rolls back runtime-child classification schema and history", () => {
  const database = new DatabaseSync(":memory:");
  createVersion17Fixture(database);
  const rollbackPayload = JSON.stringify({
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
  });
  database.prepare(`
    INSERT INTO threads(thread_id, default_branch, next_sequence, created_at, updated_at)
    VALUES ('rollback_runtime_child', 'main', 2, ?, ?)
  `).run(timestamp, timestamp);
  database.prepare(`
    INSERT INTO branches(
      thread_id, branch_name, branch_incarnation, head_event_id, created_at, updated_at
    ) VALUES ('rollback_runtime_child', 'main', 1, NULL, ?, ?)
  `).run(timestamp, timestamp);
  database.prepare(`
    INSERT INTO runs(run_id, thread_id, branch_name, state, provider, model, started_at, ended_at)
    VALUES ('rollback_run', 'rollback_runtime_child', 'main', 'completed', 'fixture', 'fixture', ?, ?)
  `).run(timestamp, timestamp);
  database.prepare(`
    INSERT INTO events(
      event_id, thread_id, run_id, parent_event_id, branch_name, branch_incarnation,
      sequence, timestamp, kind, schema_version, payload_json
    ) VALUES (
      'rollback_event', 'rollback_runtime_child', 'rollback_run', NULL, 'main', 1,
      1, ?, 'run_started', 1, ?
    )
  `).run(timestamp, rollbackPayload);
  database.prepare(`
    UPDATE branches SET head_event_id = 'rollback_event'
    WHERE thread_id = 'rollback_runtime_child' AND branch_name = 'main'
  `).run();
  database.exec(`
    CREATE TRIGGER reject_v18_history
    BEFORE INSERT ON schema_migrations
    WHEN NEW.version = 18
    BEGIN
      SELECT RAISE(ABORT, 'fixture v18 migration failure');
    END;
  `);

  assert.throws(() => migrateDatabase(database), /fixture v18 migration failure/u);

  assert.equal(userVersion(database), 17);
  assert.deepEqual(migrationVersions(database), [17]);
  assert.equal(tableExists(database, "runtime_child_threads"), false);
  assert.equal(database.prepare("SELECT payload_json FROM events WHERE event_id = 'rollback_event'").get()?.payload_json, rollbackPayload);
  assert.notEqual(database.prepare("SELECT 1 FROM threads WHERE thread_id = 'rollback_runtime_child'").get(), undefined);
  database.close();
});

test("a late v15 migration failure rolls back every owner-fencing table", () => {
  const database = new DatabaseSync(":memory:");
  createVersion14Fixture(database);
  database.exec(`
    CREATE TRIGGER reject_v15_history
    BEFORE INSERT ON schema_migrations
    WHEN NEW.version = 15
    BEGIN
      SELECT RAISE(ABORT, 'fixture v15 migration failure');
    END;
  `);

  assert.throws(() => migrateDatabase(database), /fixture v15 migration failure/u);

  assert.equal(userVersion(database), 14);
  assert.deepEqual(migrationVersions(database), [14]);
  assert.equal(tableExists(database, "runtime_owners"), false);
  assert.equal(tableExists(database, "runtime_run_owners"), false);
  assert.equal(tableExists(database, "runtime_queue_owners"), false);
  database.close();
});

test("an untouched database tolerates simultaneous first opens before WAL exists", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rigyn-untouched-migration-race-"));
  try {
    await assertUntouchedConcurrentMigration(join(directory, "sessions.sqlite"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent processes serialize first-time schema creation before reading user_version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rigyn-fresh-migration-race-"));
  try {
    await assertConcurrentMigration(join(directory, "sessions.sqlite"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent processes serialize v14 upgrades before reading user_version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rigyn-upgrade-migration-race-"));
  try {
    await assertConcurrentMigration(
      join(directory, "sessions.sqlite"),
      (database) => createVersion14Fixture(database),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fresh-schema failure rolls back migration metadata and leaves existing unversioned data untouched", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE threads(sentinel TEXT) STRICT");

  assert.throws(() => migrateDatabase(database), /table threads already exists/u);

  assert.equal(userVersion(database), 0);
  assert.equal(tableExists(database, "schema_migrations"), false);
  assert.deepEqual(
    (database.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map((row) => row.name),
    ["sentinel"],
  );
  database.close();
});

test("unsupported older schemas are refused before migration metadata is written", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE sentinel(value TEXT) STRICT; PRAGMA user_version = 12");

  assert.throws(() => migrateDatabase(database), /retained upgrade path starts at schema 13/u);

  assert.equal(userVersion(database), 12);
  assert.equal(tableExists(database, "sentinel"), true);
  assert.equal(tableExists(database, "schema_migrations"), false);
  database.close();
});
