import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { assertCanonicalDirectoryCreationPathSync, windowsPathHazard } from "../config/canonical-path.js";
import { HarnessError } from "../core/errors.js";
import { CURRENT_SCHEMA_VERSION } from "./migrations.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_INTEGRITY_MESSAGES = 100;
const MAX_FOREIGN_KEY_VIOLATIONS = 100;
const MINIMUM_SQLITE_VERSION = [3, 51, 3] as const;
const NO_FOLLOW = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
const DIRECTORY = process.platform === "win32" ? 0 : (constants.O_DIRECTORY ?? 0);

type SqlRow = Record<string, unknown>;

interface FileIdentity {
  device: string;
  inode: string;
}

export interface SessionForeignKeyViolation {
  table: string;
  rowId: number | null;
  parent: string;
  foreignKey: number;
}

export interface SessionDatabaseReport {
  schemaVersion: 1;
  kind: "rigyn-session-database-doctor";
  databasePath: string;
  sqliteVersion: string;
  expectedSessionSchemaVersion: number;
  sessionSchemaVersion?: number;
  integrity: {
    healthy: boolean;
    messages: string[];
    truncated: boolean;
  };
  foreignKeys: {
    healthy: boolean;
    violations: SessionForeignKeyViolation[];
    truncated: boolean;
    error?: string;
  };
  healthy: boolean;
}

export interface SessionDatabaseRepairResult {
  schemaVersion: 1;
  kind: "rigyn-session-database-repair";
  databasePath: string;
  backupPath: string;
  repaired: "indexes";
  report: SessionDatabaseReport;
}

export interface SessionMaintenanceOptions {
  busyTimeoutMs?: number;
  now?: () => Date;
}

function boundedTimeout(value: number | undefined): number {
  const selected = value ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > 60_000) {
    throw new RangeError("busyTimeoutMs must be an integer from 0 through 60000");
  }
  return selected;
}

function databaseIdentity(path: string): FileIdentity {
  const details = lstatSync(path, { bigint: true });
  if (!details.isFile() || details.isSymbolicLink() || realpathSync(path) !== path) {
    throw new HarnessError("STORAGE_PATH", "Session database must be a canonical regular non-symlink file");
  }
  if (details.nlink !== 1n) {
    throw new HarnessError("STORAGE_PATH", "Session database must not have multiple hard links");
  }
  if (
    process.platform !== "win32"
    && process.getuid !== undefined
    && Number(details.uid) !== process.getuid()
  ) {
    throw new HarnessError("STORAGE_PATH", "Session database is owned by another user");
  }
  if (process.platform !== "win32" && (details.mode & 0o022n) !== 0n) {
    throw new HarnessError("STORAGE_PATH", "Session database must not be group- or world-writable");
  }
  return { device: String(details.dev), inode: String(details.ino) };
}

function selectedDatabasePath(path: string): { path: string; identity: FileIdentity } {
  if (path === ":memory:" || path.includes("\0") || path.startsWith("file:")) {
    throw new HarnessError("STORAGE_PATH", "Session maintenance requires a file-backed database path without NUL");
  }
  const selected = resolve(path);
  const hazard = windowsPathHazard(selected);
  if (hazard !== undefined) {
    throw new HarnessError("STORAGE_PATH", `Session database path uses an unsupported Windows ${hazard}`);
  }
  try {
    assertCanonicalDirectoryCreationPathSync(dirname(selected));
  } catch (cause) {
    throw new HarnessError("STORAGE_PATH", `Session database parent is unsafe: ${dirname(selected)}`, { cause });
  }
  try {
    return { path: selected, identity: databaseIdentity(selected) };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HarnessError("STORAGE_PATH", `Session database does not exist: ${selected}`, { cause });
    }
    throw cause;
  }
}

function assertUnchanged(path: string, identity: FileIdentity): void {
  const current = databaseIdentity(path);
  if (current.device !== identity.device || current.inode !== identity.inode) {
    throw new HarnessError("STORAGE_PATH", "Session database changed while maintenance was running");
  }
}

function requiredString(row: SqlRow | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string") throw new HarnessError("STORAGE_CORRUPT", `SQLite returned an invalid ${key}`);
  return value;
}

function requiredInteger(row: SqlRow | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new HarnessError("STORAGE_CORRUPT", `SQLite returned an invalid ${key}`);
  }
  return value;
}

function sqliteVersion(database: DatabaseSync): string {
  const version = requiredString(
    database.prepare("SELECT sqlite_version() AS version").get() as SqlRow | undefined,
    "version",
  );
  const parts = /^(\d+)\.(\d+)\.(\d+)/u.exec(version)?.slice(1).map(Number);
  if (
    parts === undefined
    || parts.some((part) => !Number.isSafeInteger(part))
    || parts[0]! < MINIMUM_SQLITE_VERSION[0]
    || (parts[0] === MINIMUM_SQLITE_VERSION[0] && parts[1]! < MINIMUM_SQLITE_VERSION[1])
    || (
      parts[0] === MINIMUM_SQLITE_VERSION[0]
      && parts[1] === MINIMUM_SQLITE_VERSION[1]
      && parts[2]! < MINIMUM_SQLITE_VERSION[2]
    )
  ) {
    throw new HarnessError(
      "STORAGE_SQLITE_VERSION",
      `SQLite ${version} is unsupported; session maintenance requires SQLite 3.51.3 or newer`,
    );
  }
  return version;
}

function integrityMessages(database: DatabaseSync): { messages: string[]; truncated: boolean } {
  const rows = database.prepare(`PRAGMA integrity_check(${MAX_INTEGRITY_MESSAGES + 1})`).all() as SqlRow[];
  const values = rows.map((row) => requiredString(row, "integrity_check"));
  return {
    messages: values.slice(0, MAX_INTEGRITY_MESSAGES),
    truncated: values.length > MAX_INTEGRITY_MESSAGES,
  };
}

function foreignKeyReport(database: DatabaseSync): SessionDatabaseReport["foreignKeys"] {
  try {
    const rows = database.prepare(`
      SELECT "table", rowid, parent, fkid
      FROM pragma_foreign_key_check
      LIMIT ${MAX_FOREIGN_KEY_VIOLATIONS + 1}
    `).all() as SqlRow[];
    const violations = rows.slice(0, MAX_FOREIGN_KEY_VIOLATIONS).map((row) => {
      const table = row["table"];
      const rowId = row["rowid"];
      const parent = row["parent"];
      const foreignKey = row["fkid"];
      if (
        typeof table !== "string"
        || (rowId !== null && (typeof rowId !== "number" || !Number.isSafeInteger(rowId)))
        || typeof parent !== "string"
        || typeof foreignKey !== "number"
        || !Number.isSafeInteger(foreignKey)
      ) throw new HarnessError("STORAGE_CORRUPT", "SQLite returned an invalid foreign-key violation");
      return { table, rowId, parent, foreignKey };
    });
    return {
      healthy: rows.length === 0,
      violations,
      truncated: rows.length > MAX_FOREIGN_KEY_VIOLATIONS,
    };
  } catch (error) {
    return {
      healthy: false,
      violations: [],
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function inspectOpenDatabase(database: DatabaseSync, path: string, version = sqliteVersion(database)): SessionDatabaseReport {
  let sessionSchemaVersion: number | undefined;
  let integrity: SessionDatabaseReport["integrity"];
  try {
    const row = database.prepare("PRAGMA user_version").get() as SqlRow | undefined;
    const value = row?.["user_version"];
    if (typeof value === "number" && Number.isSafeInteger(value)) sessionSchemaVersion = value;
  } catch {}
  try {
    const checked = integrityMessages(database);
    integrity = {
      healthy: checked.messages.length === 1 && checked.messages[0] === "ok" && !checked.truncated,
      ...checked,
    };
  } catch (error) {
    integrity = {
      healthy: false,
      messages: [error instanceof Error ? error.message : String(error)],
      truncated: false,
    };
  }
  const foreignKeys = foreignKeyReport(database);
  const schemaHealthy = sessionSchemaVersion === CURRENT_SCHEMA_VERSION;
  return {
    schemaVersion: 1,
    kind: "rigyn-session-database-doctor",
    databasePath: path,
    sqliteVersion: version,
    expectedSessionSchemaVersion: CURRENT_SCHEMA_VERSION,
    ...(sessionSchemaVersion === undefined ? {} : { sessionSchemaVersion }),
    integrity,
    foreignKeys,
    healthy: schemaHealthy && integrity.healthy && foreignKeys.healthy,
  };
}

function openMaintenanceDatabase(path: string, readOnly: boolean, timeout: number): {
  database: DatabaseSync;
  path: string;
  identity: FileIdentity;
  sqliteVersion: string;
} {
  const selected = selectedDatabasePath(path);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(selected.path, {
      readOnly,
      enableForeignKeyConstraints: true,
      timeout,
    });
    if (database.location() !== selected.path) {
      throw new HarnessError("STORAGE_PATH", "SQLite opened an unexpected session database path");
    }
    assertUnchanged(selected.path, selected.identity);
    const version = sqliteVersion(database);
    return { database, path: selected.path, identity: selected.identity, sqliteVersion: version };
  } catch (error) {
    database?.close();
    throw error;
  }
}

function reserveBackup(path: string, now: () => Date): { path: string; identity: FileIdentity } {
  const timestamp = now().toISOString().replaceAll(":", "-");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = `${path}.backup-${timestamp}-${randomUUID()}.sqlite`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        candidate,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      if (process.platform !== "win32") chmodSync(candidate, 0o600);
      closeSync(descriptor);
      descriptor = undefined;
      return { path: candidate, identity: databaseIdentity(candidate) };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new HarnessError("STORAGE_BACKUP", "Could not reserve a unique session database backup path");
}

function syncBackup(path: string, identity: FileIdentity): void {
  if (process.platform !== "win32") chmodSync(path, 0o600);
  const current = databaseIdentity(path);
  if (current.device !== identity.device || current.inode !== identity.inode) {
    throw new HarnessError("STORAGE_BACKUP", "Session database backup changed while it was being written");
  }
  const file = openSync(path, (process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY) | NO_FOLLOW);
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  if (process.platform !== "win32") {
    const directory = openSync(dirname(path), constants.O_RDONLY | DIRECTORY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}

function repairFailure(message: string, backupPath: string, cause?: unknown): HarnessError {
  return new HarnessError(
    "STORAGE_REPAIR_FAILED",
    `${message}; the pre-repair backup remains at ${backupPath}`,
    cause === undefined ? undefined : { cause },
  );
}

export function inspectSessionDatabase(
  path: string,
  options: SessionMaintenanceOptions = {},
): SessionDatabaseReport {
  const opened = openMaintenanceDatabase(path, true, boundedTimeout(options.busyTimeoutMs));
  try {
    const report = inspectOpenDatabase(opened.database, opened.path, opened.sqliteVersion);
    assertUnchanged(opened.path, opened.identity);
    return report;
  } finally {
    opened.database.close();
  }
}

export async function repairSessionDatabaseIndexes(
  path: string,
  options: SessionMaintenanceOptions = {},
): Promise<SessionDatabaseRepairResult> {
  const timeout = boundedTimeout(options.busyTimeoutMs);
  const opened = openMaintenanceDatabase(path, false, timeout);
  let backupFile: { path: string; identity: FileIdentity } | undefined;
  let result: SessionDatabaseRepairResult | undefined;
  let failure: unknown;
  try {
    opened.database.exec(`PRAGMA busy_timeout = ${timeout}`);
    const schema = opened.database.prepare("PRAGMA user_version").get() as SqlRow | undefined;
    if (schema?.["user_version"] !== CURRENT_SCHEMA_VERSION) {
      throw new HarnessError(
        "STORAGE_SCHEMA",
        `Refusing index repair for session schema ${String(schema?.["user_version"])}; expected ${CURRENT_SCHEMA_VERSION}`,
      );
    }
    assertUnchanged(opened.path, opened.identity);
    backupFile = reserveBackup(opened.path, options.now ?? (() => new Date()));
    try {
      let locked = false;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const before = requiredInteger(
          opened.database.prepare("PRAGMA data_version").get() as SqlRow | undefined,
          "data_version",
        );
        await backup(opened.database, backupFile.path);
        syncBackup(backupFile.path, backupFile.identity);
        const afterBackup = requiredInteger(
          opened.database.prepare("PRAGMA data_version").get() as SqlRow | undefined,
          "data_version",
        );
        if (before !== afterBackup) continue;
        try {
          opened.database.exec("BEGIN IMMEDIATE");
        } catch (cause) {
          throw new HarnessError(
            "STORAGE_BUSY",
            "Could not lock the session database for repair; close every Rigyn process and retry",
            { cause },
          );
        }
        const afterLock = requiredInteger(
          opened.database.prepare("PRAGMA data_version").get() as SqlRow | undefined,
          "data_version",
        );
        const lockedSchema = requiredInteger(
          opened.database.prepare("PRAGMA user_version").get() as SqlRow | undefined,
          "user_version",
        );
        if (lockedSchema !== CURRENT_SCHEMA_VERSION) {
          opened.database.exec("ROLLBACK");
          throw new HarnessError(
            "STORAGE_SCHEMA",
            `Refusing index repair for session schema ${lockedSchema}; expected ${CURRENT_SCHEMA_VERSION}`,
          );
        }
        assertUnchanged(opened.path, opened.identity);
        if (afterLock === afterBackup) {
          locked = true;
          break;
        }
        opened.database.exec("ROLLBACK");
      }
      if (!locked) {
        throw new HarnessError(
          "STORAGE_BUSY",
          "Session data changed repeatedly while its repair backup was being verified; close every Rigyn process and retry",
        );
      }
    } catch (cause) {
      if (opened.database.isTransaction) opened.database.exec("ROLLBACK");
      try { unlinkSync(backupFile.path); } catch {}
      backupFile = undefined;
      if (cause instanceof HarnessError) throw cause;
      throw new HarnessError("STORAGE_BACKUP", "Could not create a verified pre-repair session database backup", { cause });
    }

    let committed = false;
    try {
      opened.database.exec("REINDEX");
      const report = inspectOpenDatabase(opened.database, opened.path, opened.sqliteVersion);
      if (!report.healthy) {
        throw repairFailure("Index repair did not restore full database integrity", backupFile.path);
      }
      assertUnchanged(opened.path, opened.identity);
      opened.database.exec("COMMIT");
      committed = true;
      assertUnchanged(opened.path, opened.identity);
      result = {
        schemaVersion: 1,
        kind: "rigyn-session-database-repair",
        databasePath: opened.path,
        backupPath: backupFile.path,
        repaired: "indexes",
        report,
      };
    } catch (cause) {
      if (opened.database.isTransaction) opened.database.exec("ROLLBACK");
      if (cause instanceof HarnessError && cause.code === "STORAGE_REPAIR_FAILED") throw cause;
      if (committed) {
        throw repairFailure("Index repair committed but final database identity verification failed", backupFile.path, cause);
      }
      throw repairFailure("Index repair was rolled back", backupFile.path, cause);
    }
  } catch (error) {
    if (opened.database.isTransaction) opened.database.exec("ROLLBACK");
    failure = error;
  } finally {
    try {
      opened.database.close();
    } catch (closeError) {
      failure = failure === undefined
        ? closeError
        : new AggregateError([failure, closeError], "Session repair and database cleanup both failed");
    }
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) throw new HarnessError("STORAGE_REPAIR_FAILED", "Session index repair produced no result");
  return result;
}
