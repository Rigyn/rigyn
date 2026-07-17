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

function createVersion13Fixture(database: DatabaseSync): void {
  migrateDatabase(database);
  database.exec(`
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
  database.exec(`
    DROP TABLE runtime_queue_owners;
    DROP TABLE runtime_run_owners;
    DROP TABLE runtime_owners;
    DELETE FROM schema_migrations WHERE version = 15;
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (14, '${timestamp}');
    PRAGMA user_version = 14;
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

test("the retained v13 fixture upgrades through v15 with ordered history and preserved event identity", () => {
  const database = new DatabaseSync(":memory:");
  createVersion13Fixture(database);

  migrateDatabase(database);

  assert.equal(userVersion(database), CURRENT_SCHEMA_VERSION);
  assert.deepEqual(migrationVersions(database), [13, 14, 15]);
  assert.equal(tableExists(database, "runtime_owners"), true);
  assert.equal(tableExists(database, "runtime_run_owners"), true);
  assert.equal(tableExists(database, "runtime_queue_owners"), true);
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

test("the v14 owner-fencing migration creates all tables atomically", () => {
  const database = new DatabaseSync(":memory:");
  createVersion14Fixture(database);

  migrateDatabase(database);

  assert.equal(userVersion(database), 15);
  assert.deepEqual(migrationVersions(database), [14, 15]);
  assert.equal(tableExists(database, "runtime_owners"), true);
  assert.equal(tableExists(database, "runtime_run_owners"), true);
  assert.equal(tableExists(database, "runtime_queue_owners"), true);
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
