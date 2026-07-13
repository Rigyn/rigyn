import { DatabaseSync } from "node:sqlite";

export const CURRENT_SCHEMA_VERSION = 14;
const EARLIEST_UPGRADABLE_SCHEMA_VERSION = 13;

interface SchemaMigration {
  version: number;
  sql: string;
}

const MIGRATION_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT;
`;

const CURRENT_SCHEMA = `
  CREATE TABLE threads (
    thread_id TEXT PRIMARY KEY,
    name TEXT,
    default_branch TEXT NOT NULL,
    next_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sequence >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    parent_thread_id TEXT REFERENCES threads(thread_id) ON DELETE SET NULL,
    parent_run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
    workspace_root TEXT
  ) STRICT;

  CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
    branch_name TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
      state IN ('preparing', 'streaming', 'tool_planning', 'executing', 'completed', 'failed', 'cancelled')
    ),
    provider TEXT,
    model TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    UNIQUE(thread_id, run_id)
  ) STRICT;

  CREATE UNIQUE INDEX one_active_run_per_thread
    ON runs(thread_id)
    WHERE state NOT IN ('completed', 'failed', 'cancelled');
  CREATE INDEX threads_parent_idx ON threads(parent_thread_id, parent_run_id);
  CREATE INDEX threads_workspace_updated_idx ON threads(workspace_root, updated_at DESC);

  CREATE TABLE events (
    event_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
    run_id TEXT,
    parent_event_id TEXT,
    branch_name TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    timestamp TEXT NOT NULL,
    kind TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    UNIQUE(thread_id, event_id),
    UNIQUE(thread_id, sequence),
    FOREIGN KEY(thread_id, run_id) REFERENCES runs(thread_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY(thread_id, parent_event_id) REFERENCES events(thread_id, event_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE INDEX events_parent_idx ON events(parent_event_id);
  CREATE INDEX events_run_idx ON events(run_id, sequence);

  CREATE TABLE branches (
    thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
    branch_name TEXT NOT NULL,
    head_event_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(thread_id, branch_name),
    FOREIGN KEY(thread_id, head_event_id) REFERENCES events(thread_id, event_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE artifacts (
    artifact_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
    run_id TEXT,
    event_id TEXT,
    media_type TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    sha256 TEXT NOT NULL,
    content BLOB NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(thread_id, run_id) REFERENCES runs(thread_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY(thread_id, event_id) REFERENCES events(thread_id, event_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE INDEX artifacts_thread_idx ON artifacts(thread_id, created_at);

  CREATE TABLE run_input_queue (
    queue_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_id TEXT NOT NULL UNIQUE CHECK (length(CAST(queue_id AS BLOB)) BETWEEN 1 AND 200),
    message_id TEXT NOT NULL UNIQUE CHECK (length(CAST(message_id AS BLOB)) BETWEEN 1 AND 200),
    thread_id TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('steer', 'follow_up')),
    state TEXT NOT NULL DEFAULT 'queued' CHECK (
      state IN ('queued', 'draining', 'recoverable', 'leased', 'quarantined')
    ),
    text TEXT NOT NULL CHECK (length(CAST(text AS BLOB)) <= 262144),
    images_json TEXT CHECK (
      images_json IS NULL OR (json_valid(images_json) AND json_type(images_json) = 'array')
    ),
    quarantine_reason TEXT CHECK (
      quarantine_reason IS NULL OR length(CAST(quarantine_reason AS BLOB)) <= 4096
    ),
    created_at TEXT NOT NULL,
    FOREIGN KEY(thread_id, branch_name)
      REFERENCES branches(thread_id, branch_name) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX run_input_queue_thread_idx
    ON run_input_queue(thread_id, branch_name, queue_sequence);
  CREATE INDEX run_input_queue_state_idx
    ON run_input_queue(state, thread_id, branch_name, queue_sequence);
`;

const PRE_RELEASE_V13_CLEANUP = `
  UPDATE runs SET state = 'tool_planning' WHERE state = 'approving';
  UPDATE events
  SET payload_json = json_remove(payload_json, '$.message.purpose')
  WHERE kind = 'message_appended'
    AND json_extract(payload_json, '$.message.purpose') = 'memory';
  UPDATE events
  SET kind = 'warning',
      payload_json = json_object(
        'type', 'warning',
        'code', 'legacy_event_removed',
        'message', 'This pre-release event belonged to a removed subsystem and was retained only to preserve session history.'
      )
  WHERE kind IN (
    'approval_required', 'approval_resolved', 'checkpoint_created',
    'subagent_progress', 'todo_updated'
  );
  DROP TABLE IF EXISTS approvals;
  DROP TABLE IF EXISTS checkpoints;
  DROP TABLE IF EXISTS background_jobs;
  DROP TABLE IF EXISTS memories;
  DROP TABLE IF EXISTS todos;
`;

const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = Object.freeze([
  { version: 14, sql: PRE_RELEASE_V13_CLEANUP },
]);

function scalarNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid SQLite ${label}`);
  }
  return value;
}

export function configureDatabase(database: DatabaseSync, busyTimeoutMs = 5_000): void {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError("busyTimeoutMs must be a non-negative safe integer");
  }
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA journal_mode = WAL");
}

function recordMigration(database: DatabaseSync, version: number): void {
  database
    .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(version, new Date().toISOString());
  database.exec(`PRAGMA user_version = ${version}`);
}

function applyFreshSchema(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(MIGRATION_TABLE);
    database.exec(CURRENT_SCHEMA);
    recordMigration(database, CURRENT_SCHEMA_VERSION);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function applyUpgradePath(database: DatabaseSync, currentVersion: number): void {
  const migrations = new Map(SCHEMA_MIGRATIONS.map((migration) => [migration.version, migration]));
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(MIGRATION_TABLE);
    for (let version = currentVersion + 1; version <= CURRENT_SCHEMA_VERSION; version += 1) {
      const migration = migrations.get(version);
      if (migration === undefined) throw new Error(`Missing database migration from schema ${version - 1} to ${version}`);
      database.exec(migration.sql);
      recordMigration(database, version);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function migrateDatabase(database: DatabaseSync, busyTimeoutMs = 5_000): void {
  const versionRow = database.prepare("PRAGMA user_version").get() as
    | { user_version?: unknown }
    | undefined;
  const currentVersion = scalarNumber(versionRow?.user_version, "user_version");
  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema ${currentVersion} is newer than supported schema ${CURRENT_SCHEMA_VERSION}`,
    );
  }
  if (currentVersion !== 0 && currentVersion < EARLIEST_UPGRADABLE_SCHEMA_VERSION) {
    throw new Error(
      `Pre-release database schema ${currentVersion} is not directly upgradeable; the retained upgrade path starts at schema ${EARLIEST_UPGRADABLE_SCHEMA_VERSION}`,
    );
  }

  configureDatabase(database, busyTimeoutMs);
  if (currentVersion === CURRENT_SCHEMA_VERSION) return;
  if (currentVersion === 0) {
    applyFreshSchema(database);
    return;
  }
  applyUpgradePath(database, currentVersion);
}
