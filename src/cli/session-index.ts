import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CURRENT_SCHEMA_VERSION } from "../storage/migrations.js";
import type { ThreadRecord } from "../storage/types.js";
import {
  assertCanonicalDirectoryCreationPath,
  canonicalExistingPath,
  hasSymlinkComponent,
  windowsPathHazard,
} from "../config/canonical-path.js";

const INDEX_APPLICATION_ID = 0x43485349;
const INDEX_SCHEMA_VERSION = 1;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
export const MAX_INDEX_WORKSPACES = 1_024;
const MAX_WORKSPACE_SESSIONS = 10_000;
const MAX_TOTAL_SESSIONS = 50_000;
const MAX_PATH_BYTES = 4 * 1024;
const MAX_THREAD_ID_BYTES = 4 * 1024;
const MAX_THREAD_NAME_BYTES = 4 * 1024;
const NO_FOLLOW = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
const DIRECTORY = process.platform === "win32" ? 0 : (constants.O_DIRECTORY ?? 0);

type SqlValue = string | number | bigint | Uint8Array | null;
type SqlRow = Record<string, SqlValue>;

export interface IndexedSessionRecord {
  threadId: string;
  name?: string;
  workspaceRoot: string;
  databasePath: string;
  createdAt: string;
  updatedAt: string;
  indexedAt: string;
}

export interface SessionIndexSnapshot {
  workspaceRoot: string;
  databasePath: string;
  sessions: number;
  indexedAt: string;
}

export interface IndexedSessionMatches {
  exactIds: IndexedSessionRecord[];
  exactNames: IndexedSessionRecord[];
  partial: IndexedSessionRecord[];
  truncated: boolean;
}

export interface IndexedSessionPage {
  sessions: IndexedSessionRecord[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface SessionIndexTrust {
  isTrusted(workspace: string): Promise<boolean>;
}

export interface SessionIndexOptions {
  busyTimeoutMs?: number;
  clock?: () => Date;
}

export class SessionIndexError extends Error {
  readonly code:
    | "SESSION_INDEX_PATH"
    | "SESSION_INDEX_SCHEMA"
    | "SESSION_INDEX_CORRUPT"
    | "SESSION_INDEX_LIMIT"
    | "SESSION_INDEX_STALE"
    | "SESSION_INDEX_UNTRUSTED";

  constructor(code: SessionIndexError["code"], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SessionIndexError";
    this.code = code;
  }
}

interface FileIdentity {
  device: string;
  inode: string;
}

interface OpenDirectoryGuard {
  fd: number;
  identity: FileIdentity;
  path: string;
}

interface VerifiedWorkspaceSource {
  workspaceRoot: string;
  databasePath: string;
  workspaceIdentity: FileIdentity;
  databaseIdentity: FileIdentity;
}

interface SourceSession {
  threadId: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceRow extends VerifiedWorkspaceSource {
  indexedAt: string;
}

/** Permission-restricted, process-safe pointers to workspace-owned session databases. */
export class WorkspaceSessionIndex {
  readonly path: string;
  readonly #database: DatabaseSync;
  readonly #indexIdentity: FileIdentity;
  readonly #directoryGuard: OpenDirectoryGuard;
  readonly #clock: () => Date;
  #closed = false;

  private constructor(
    path: string,
    database: DatabaseSync,
    indexIdentity: FileIdentity,
    directoryGuard: OpenDirectoryGuard,
    clock: () => Date,
  ) {
    this.path = path;
    this.#database = database;
    this.#indexIdentity = indexIdentity;
    this.#directoryGuard = directoryGuard;
    this.#clock = clock;
  }

  static async open(path: string, options: SessionIndexOptions = {}): Promise<WorkspaceSessionIndex> {
    const selected = validateAbsolutePath(path, "Session index path");
    const busyTimeoutMs = boundedInteger(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS, 0, 60_000, "busyTimeoutMs");
    const directory = dirname(selected);
    let firstCreated: string | undefined;
    try {
      await assertCanonicalDirectoryCreationPath(directory);
      firstCreated = await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new SessionIndexError("SESSION_INDEX_PATH", `Could not create session index directory ${directory}`, error);
    }
    let directoryGuard: OpenDirectoryGuard | undefined;
    let indexIdentity: FileIdentity | undefined;
    let database: DatabaseSync | undefined;
    try {
      directoryGuard = openSecureIndexDirectory(directory);
      if (firstCreated !== undefined) syncCreatedDirectoryChain(directory, firstCreated, directoryGuard.fd);
      indexIdentity = secureIndexFile(selected, directoryGuard);
      database = new DatabaseSync(selected, {
        enableForeignKeyConstraints: true,
        timeout: busyTimeoutMs,
      });
      if (database.location() !== selected) throw new SessionIndexError("SESSION_INDEX_PATH", "SQLite opened an unexpected session index path");
      assertIndexGuards(selected, indexIdentity, directoryGuard);
      initializeOrValidateIndex(database, busyTimeoutMs);
      assertIndexGuards(selected, indexIdentity, directoryGuard);
      const opened = new WorkspaceSessionIndex(
        selected,
        database,
        indexIdentity,
        directoryGuard,
        options.clock ?? (() => new Date()),
      );
      database = undefined;
      indexIdentity = undefined;
      directoryGuard = undefined;
      return opened;
    } catch (error) {
      let closeFailure: unknown;
      try {
        database?.close();
      } catch (failure) {
        closeFailure = failure;
      }
      if (closeFailure !== undefined) {
        throw new SessionIndexError(
          "SESSION_INDEX_SCHEMA",
          `Could not open or safely close session index ${selected}`,
          new AggregateError([error, closeFailure]),
        );
      }
      if (error instanceof SessionIndexError) throw error;
      throw new SessionIndexError("SESSION_INDEX_SCHEMA", `Could not open session index ${selected}`, error);
    } finally {
      if (directoryGuard !== undefined) closeSync(directoryGuard.fd);
    }
  }

  async refreshWorkspace(input: { workspaceRoot: string; databasePath: string }): Promise<SessionIndexSnapshot> {
    await this.#assertIndexIdentity();
    const source = await verifyWorkspaceSource(input.workspaceRoot, input.databasePath);
    const sessions = readSourceSessions(source);
    const confirmedSource = await verifyWorkspaceSource(input.workspaceRoot, input.databasePath);
    if (!sameWorkspaceSource(source, confirmedSource)) {
      throw stale(`Workspace or database changed while sessions were being indexed: ${source.workspaceRoot}`);
    }
    const indexedAt = canonicalTimestamp(this.#clock().toISOString(), "Index clock");
    this.#transaction(() => {
      const workspaceCount = requiredCount(this.#database.prepare("SELECT count(*) AS value FROM workspaces").get() as SqlRow);
      const existing = this.#workspaceRow(source.workspaceRoot);
      if (existing === undefined && workspaceCount >= MAX_INDEX_WORKSPACES) {
        throw new SessionIndexError("SESSION_INDEX_LIMIT", `Session index exceeds ${MAX_INDEX_WORKSPACES} workspaces`);
      }
      const outside = requiredCount(this.#database.prepare(
        "SELECT count(*) AS value FROM sessions WHERE workspace_root != ?",
      ).get(source.workspaceRoot) as SqlRow);
      if (outside + sessions.length > MAX_TOTAL_SESSIONS) {
        throw new SessionIndexError("SESSION_INDEX_LIMIT", `Session index exceeds ${MAX_TOTAL_SESSIONS} sessions`);
      }

      this.#database.prepare(`
        INSERT INTO workspaces(
          workspace_root, database_path, workspace_device, workspace_inode,
          database_device, database_inode, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_root) DO UPDATE SET
          database_path = excluded.database_path,
          workspace_device = excluded.workspace_device,
          workspace_inode = excluded.workspace_inode,
          database_device = excluded.database_device,
          database_inode = excluded.database_inode,
          indexed_at = excluded.indexed_at
      `).run(
        source.workspaceRoot,
        source.databasePath,
        source.workspaceIdentity.device,
        source.workspaceIdentity.inode,
        source.databaseIdentity.device,
        source.databaseIdentity.inode,
        indexedAt,
      );
      // A restored/VACUUM-replaced database is a new snapshot. Remove every
      // pointer from the old identity before publishing the replacement rows.
      this.#database.prepare("DELETE FROM sessions WHERE workspace_root = ?").run(source.workspaceRoot);
      const insert = this.#database.prepare(`
        INSERT INTO sessions(
          thread_id, thread_id_fold, workspace_root, name, name_fold, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const session of sessions) {
        insert.run(
          session.threadId,
          fold(session.threadId),
          source.workspaceRoot,
          session.name ?? null,
          session.name === undefined ? null : fold(session.name),
          session.createdAt,
          session.updatedAt,
        );
      }
    });
    return { workspaceRoot: source.workspaceRoot, databasePath: source.databasePath, sessions: sessions.length, indexedAt };
  }

  /** Update one row after startup reconciliation; identity changes require a full refresh. */
  async upsertSession(input: {
    workspaceRoot: string;
    databasePath: string;
    thread: ThreadRecord;
  }): Promise<IndexedSessionRecord> {
    await this.#assertIndexIdentity();
    const source = await verifyWorkspaceSource(input.workspaceRoot, input.databasePath);
    const registered = this.#requiredMatchingWorkspace(source);
    const thread = readSourceSession(source, input.thread.threadId);
    if (thread === undefined) throw stale(`Session ${input.thread.threadId} is no longer present; refresh the session index`);
    if (input.thread.workspaceRoot !== source.workspaceRoot || !sameThreadSummary(input.thread, thread)) {
      throw stale(`Session ${input.thread.threadId} changed before it could be indexed; refresh the session index`);
    }
    const confirmedSource = await verifyWorkspaceSource(input.workspaceRoot, input.databasePath);
    if (!sameWorkspaceSource(source, confirmedSource)) {
      throw stale(`Workspace or database changed while session ${input.thread.threadId} was being indexed`);
    }
    const indexedAt = canonicalTimestamp(this.#clock().toISOString(), "Index clock");
    this.#transaction(() => {
      const existing = requiredCount(this.#database.prepare("SELECT count(*) AS value FROM sessions").get() as SqlRow);
      const alreadyIndexed = this.#database.prepare(
        "SELECT 1 AS value FROM sessions WHERE workspace_root = ? AND thread_id = ?",
      ).get(source.workspaceRoot, thread.threadId) !== undefined;
      if (!alreadyIndexed && existing >= MAX_TOTAL_SESSIONS) {
        throw new SessionIndexError("SESSION_INDEX_LIMIT", `Session index exceeds ${MAX_TOTAL_SESSIONS} sessions`);
      }
      this.#database.prepare(`
        INSERT INTO sessions(
          thread_id, thread_id_fold, workspace_root, name, name_fold, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_root, thread_id) DO UPDATE SET
          thread_id_fold = excluded.thread_id_fold,
          name = excluded.name,
          name_fold = excluded.name_fold,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(
        thread.threadId,
        fold(thread.threadId),
        source.workspaceRoot,
        thread.name ?? null,
        thread.name === undefined ? null : fold(thread.name),
        thread.createdAt,
        thread.updatedAt,
      );
      this.#database.prepare("UPDATE workspaces SET indexed_at = ? WHERE workspace_root = ?")
        .run(indexedAt, source.workspaceRoot);
    });
    return toIndexedSession(thread, { ...registered, indexedAt });
  }

  /** Remove one row only after the verified source confirms that it was deleted. */
  async removeSession(input: {
    workspaceRoot: string;
    databasePath: string;
    threadId: string;
  }): Promise<void> {
    await this.#assertIndexIdentity();
    const source = await verifyWorkspaceSource(input.workspaceRoot, input.databasePath);
    this.#requiredMatchingWorkspace(source);
    const threadId = boundedText(input.threadId, MAX_THREAD_ID_BYTES, "Thread ID");
    if (readSourceSession(source, threadId) !== undefined) {
      throw stale(`Session ${threadId} still exists and cannot be removed from the index`);
    }
    const confirmedSource = await verifyWorkspaceSource(input.workspaceRoot, input.databasePath);
    if (!sameWorkspaceSource(source, confirmedSource)) {
      throw stale(`Workspace or database changed while session ${threadId} was being removed from the index`);
    }
    this.#transaction(() => {
      this.#database.prepare("DELETE FROM sessions WHERE workspace_root = ? AND thread_id = ?")
        .run(source.workspaceRoot, threadId);
      this.#database.prepare("UPDATE workspaces SET indexed_at = ? WHERE workspace_root = ?")
        .run(canonicalTimestamp(this.#clock().toISOString(), "Index clock"), source.workspaceRoot);
    });
  }

  async removeWorkspace(workspaceRoot: string): Promise<void> {
    await this.#assertIndexIdentity();
    const selected = validateAbsolutePath(workspaceRoot, "Workspace root");
    this.#transaction(() => {
      this.#database.prepare("DELETE FROM workspaces WHERE workspace_root = ?").run(selected);
    });
  }

  /** Metadata-only page ordered exactly like list(); cursors are bound to the search and workspace filter. */
  listPage(options: {
    workspaceRoot?: string;
    search?: string;
    cursor?: string;
    limit?: number;
  } = {}): IndexedSessionPage {
    this.#assertIndexIdentitySync();
    const limit = boundedInteger(options.limit ?? 100, 1, 100, "Session index page limit");
    const workspace = options.workspaceRoot === undefined
      ? undefined
      : validateAbsolutePath(options.workspaceRoot, "Workspace root");
    const search = options.search?.trim();
    if (search !== undefined && (search.includes("\0") || Buffer.byteLength(search, "utf8") > 1_024)) {
      throw new SessionIndexError("SESSION_INDEX_LIMIT", "Session index search must be at most 1024 bytes without NUL");
    }
    const normalizedSearch = search === "" ? undefined : search;
    const after = options.cursor === undefined
      ? undefined
      : decodeIndexPageCursor(options.cursor, workspace, normalizedSearch);
    const filters: string[] = [];
    const parameters: Array<string | number> = [];
    if (workspace !== undefined) {
      filters.push("workspace.workspace_root = ?");
      parameters.push(workspace);
    }
    if (normalizedSearch !== undefined) {
      const pattern = `%${escapeLike(fold(normalizedSearch))}%`;
      filters.push("(session.thread_id_fold LIKE ? ESCAPE '\\' OR session.name_fold LIKE ? ESCAPE '\\')");
      parameters.push(pattern, pattern);
    }
    if (after !== undefined) {
      filters.push(`(
        session.updated_at < ? OR
        (session.updated_at = ? AND session.thread_id > ?) OR
        (session.updated_at = ? AND session.thread_id = ? AND workspace.workspace_root > ?)
      )`);
      parameters.push(
        after.updatedAt,
        after.updatedAt,
        after.threadId,
        after.updatedAt,
        after.threadId,
        after.workspaceRoot,
      );
    }
    const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
    const rows = this.#database.prepare(`
      SELECT session.thread_id, session.name, session.created_at, session.updated_at,
             workspace.workspace_root, workspace.database_path, workspace.indexed_at
      FROM sessions session
      JOIN workspaces workspace ON workspace.workspace_root = session.workspace_root
      ${where}
      ORDER BY session.updated_at DESC, session.thread_id ASC, workspace.workspace_root ASC
      LIMIT ?
    `).all(...parameters, limit + 1) as SqlRow[];
    const hasMore = rows.length > limit;
    const sessions = rows.slice(0, limit).map(indexedSessionFromRow);
    const last = sessions.at(-1);
    return {
      sessions,
      hasMore,
      ...(hasMore && last !== undefined
        ? { nextCursor: encodeIndexPageCursor(last, workspace, normalizedSearch) }
        : {}),
    };
  }

  list(options: { workspaceRoot?: string; limit?: number } = {}): IndexedSessionRecord[] {
    this.#assertIndexIdentitySync();
    const limit = boundedInteger(options.limit ?? MAX_WORKSPACE_SESSIONS, 1, MAX_WORKSPACE_SESSIONS, "Session index list limit");
    const workspace = options.workspaceRoot === undefined
      ? undefined
      : validateAbsolutePath(options.workspaceRoot, "Workspace root");
    const rows = this.#database.prepare(`
      SELECT session.thread_id, session.name, session.created_at, session.updated_at,
             workspace.workspace_root, workspace.database_path, workspace.indexed_at
      FROM sessions session
      JOIN workspaces workspace ON workspace.workspace_root = session.workspace_root
      ${workspace === undefined ? "" : "WHERE workspace.workspace_root = ?"}
      ORDER BY session.updated_at DESC, session.thread_id ASC, workspace.workspace_root ASC
      LIMIT ?
    `).all(...(workspace === undefined ? [limit] : [workspace, limit])) as SqlRow[];
    return rows.map(indexedSessionFromRow);
  }

  listWorkspaceRoots(): string[] {
    this.#assertIndexIdentitySync();
    const rows = this.#database.prepare(`
      SELECT workspace_root FROM workspaces
      ORDER BY workspace_root ASC
      LIMIT ${MAX_INDEX_WORKSPACES + 1}
    `).all() as SqlRow[];
    if (rows.length > MAX_INDEX_WORKSPACES) {
      throw new SessionIndexError("SESSION_INDEX_LIMIT", "Session index workspace limit was exceeded");
    }
    return rows.map((row) => validateAbsolutePath(
      requiredString(row, "workspace_root"),
      "Indexed workspace root",
    ));
  }

  /** Bounded metadata-only lookup; no session database or history is opened. */
  lookup(
    reference: string,
    options: { workspaceRoot?: string; databasePath?: string; limit?: number } = {},
  ): IndexedSessionMatches {
    this.#assertIndexIdentitySync();
    const selected = boundedText(reference.trim(), MAX_THREAD_ID_BYTES, "Session reference");
    const limit = boundedInteger(options.limit ?? MAX_WORKSPACE_SESSIONS, 1, MAX_WORKSPACE_SESSIONS, "Session lookup limit");
    const filters: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.workspaceRoot !== undefined) {
      filters.push("workspace.workspace_root = ?");
      parameters.push(validateAbsolutePath(options.workspaceRoot, "Workspace root"));
    }
    if (options.databasePath !== undefined) {
      filters.push("workspace.database_path = ?");
      parameters.push(validateAbsolutePath(options.databasePath, "Database path"));
    }
    const query = (condition: string, values: string[]): { rows: IndexedSessionRecord[]; truncated: boolean } => {
      const where = [...filters, condition].join(" AND ");
      const rows = this.#database.prepare(`
        SELECT session.thread_id, session.name, session.created_at, session.updated_at,
               workspace.workspace_root, workspace.database_path, workspace.indexed_at
        FROM sessions session
        JOIN workspaces workspace ON workspace.workspace_root = session.workspace_root
        WHERE ${where}
        ORDER BY session.updated_at DESC, session.thread_id ASC, workspace.workspace_root ASC
        LIMIT ?
      `).all(...parameters, ...values, limit + 1) as SqlRow[];
      return { rows: rows.slice(0, limit).map(indexedSessionFromRow), truncated: rows.length > limit };
    };
    const exactIds = query("session.thread_id = ?", [selected]);
    const folded = fold(selected);
    const exactNames = query("session.name_fold = ?", [folded]);
    const escaped = escapeLike(folded);
    const partial = query(
      "(session.thread_id_fold LIKE ? ESCAPE '\\' OR session.name_fold LIKE ? ESCAPE '\\')",
      [`${escaped}%`, `%${escaped}%`],
    );
    return {
      exactIds: exactIds.rows,
      exactNames: exactNames.rows,
      partial: partial.rows,
      truncated: exactIds.truncated || exactNames.truncated || partial.truncated,
    };
  }

  async verify(record: IndexedSessionRecord, trust: SessionIndexTrust): Promise<IndexedSessionRecord> {
    await this.#assertIndexIdentity();
    const selected = canonicalIndexedSession(record);
    const current = this.#find(selected.workspaceRoot, selected.threadId);
    if (current === undefined || !sameIndexedSession(current, selected)) {
      throw stale(`Session ${selected.threadId} no longer matches the central index; refresh it`);
    }
    const source = await verifyWorkspaceSource(current.workspaceRoot, current.databasePath);
    this.#requiredMatchingWorkspace(source);
    if (!await trust.isTrusted(source.workspaceRoot)) {
      throw new SessionIndexError(
        "SESSION_INDEX_UNTRUSTED",
        `Indexed workspace is not currently trusted: ${source.workspaceRoot}`,
      );
    }
    const afterTrust = await verifyWorkspaceSource(current.workspaceRoot, current.databasePath);
    if (!sameWorkspaceSource(source, afterTrust)) {
      throw stale(`Indexed workspace or database changed while trust was being checked: ${source.workspaceRoot}`);
    }
    this.#requiredMatchingWorkspace(afterTrust);
    const actual = readSourceSession(afterTrust, current.threadId);
    if (actual === undefined || !sameIndexedSummary(current, actual)) {
      throw stale(`Session ${current.threadId} changed in ${source.databasePath}; refresh the session index`);
    }
    return { ...current };
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
    let failure: unknown;
    for (const fd of [this.#directoryGuard.fd]) {
      try {
        closeSync(fd);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  #find(workspaceRoot: string, threadId: string): IndexedSessionRecord | undefined {
    const row = this.#database.prepare(`
      SELECT session.thread_id, session.name, session.created_at, session.updated_at,
             workspace.workspace_root, workspace.database_path, workspace.indexed_at
      FROM sessions session
      JOIN workspaces workspace ON workspace.workspace_root = session.workspace_root
      WHERE workspace.workspace_root = ? AND session.thread_id = ?
    `).get(workspaceRoot, threadId) as SqlRow | undefined;
    return row === undefined ? undefined : indexedSessionFromRow(row);
  }

  #workspaceRow(workspaceRoot: string): WorkspaceRow | undefined {
    const row = this.#database.prepare("SELECT * FROM workspaces WHERE workspace_root = ?")
      .get(workspaceRoot) as SqlRow | undefined;
    return row === undefined ? undefined : workspaceFromRow(row);
  }

  #requiredMatchingWorkspace(source: VerifiedWorkspaceSource): WorkspaceRow {
    const registered = this.#workspaceRow(source.workspaceRoot);
    if (registered === undefined) throw stale(`Workspace ${source.workspaceRoot} is not indexed; refresh it first`);
    if (
      registered.databasePath !== source.databasePath
      || !sameIdentity(registered.workspaceIdentity, source.workspaceIdentity)
      || !sameIdentity(registered.databaseIdentity, source.databaseIdentity)
    ) {
      throw stale(`Workspace or database identity changed for ${source.workspaceRoot}; refresh it first`);
    }
    return registered;
  }

  async #assertIndexIdentity(): Promise<void> {
    this.#assertIndexIdentitySync();
  }

  #assertIndexIdentitySync(): void {
    this.#assertOpen();
    assertIndexGuards(this.path, this.#indexIdentity, this.#directoryGuard);
  }

  #assertOpen(): void {
    if (this.#closed) throw new SessionIndexError("SESSION_INDEX_PATH", "Session index is closed");
  }

  #transaction<T>(operation: () => T): T {
    this.#assertIndexIdentitySync();
    this.#database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      committed = true;
      this.#assertIndexIdentitySync();
      return result;
    } catch (error) {
      if (!committed) this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

function initializeOrValidateIndex(database: DatabaseSync, busyTimeoutMs: number): void {
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL`);
  database.exec("BEGIN IMMEDIATE");
  try {
    const version = pragmaNumber(database, "user_version");
    const applicationId = pragmaNumber(database, "application_id");
    const objects = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%'
    `).all() as SqlRow[];
    if (version === 0 && applicationId === 0 && objects.length === 0) {
      database.exec(`
        CREATE TABLE workspaces (
          workspace_root TEXT PRIMARY KEY CHECK(length(CAST(workspace_root AS BLOB)) BETWEEN 1 AND ${MAX_PATH_BYTES}),
          database_path TEXT NOT NULL CHECK(length(CAST(database_path AS BLOB)) BETWEEN 1 AND ${MAX_PATH_BYTES}),
          workspace_device TEXT NOT NULL CHECK(length(workspace_device) BETWEEN 1 AND 64),
          workspace_inode TEXT NOT NULL CHECK(length(workspace_inode) BETWEEN 1 AND 64),
          database_device TEXT NOT NULL CHECK(length(database_device) BETWEEN 1 AND 64),
          database_inode TEXT NOT NULL CHECK(length(database_inode) BETWEEN 1 AND 64),
          indexed_at TEXT NOT NULL CHECK(length(CAST(indexed_at AS BLOB)) BETWEEN 20 AND 64)
        ) STRICT;
        CREATE TABLE sessions (
          thread_id TEXT NOT NULL CHECK(length(CAST(thread_id AS BLOB)) BETWEEN 1 AND ${MAX_THREAD_ID_BYTES}),
          thread_id_fold TEXT NOT NULL CHECK(length(CAST(thread_id_fold AS BLOB)) BETWEEN 1 AND ${MAX_THREAD_ID_BYTES}),
          workspace_root TEXT NOT NULL REFERENCES workspaces(workspace_root) ON DELETE CASCADE,
          name TEXT CHECK(name IS NULL OR length(CAST(name AS BLOB)) BETWEEN 1 AND ${MAX_THREAD_NAME_BYTES}),
          name_fold TEXT CHECK(name_fold IS NULL OR length(CAST(name_fold AS BLOB)) BETWEEN 1 AND ${MAX_THREAD_NAME_BYTES}),
          created_at TEXT NOT NULL CHECK(length(CAST(created_at AS BLOB)) BETWEEN 20 AND 64),
          updated_at TEXT NOT NULL CHECK(length(CAST(updated_at AS BLOB)) BETWEEN 20 AND 64),
          PRIMARY KEY(workspace_root, thread_id)
        ) STRICT;
        CREATE INDEX sessions_updated_idx ON sessions(updated_at DESC, thread_id, workspace_root);
        PRAGMA application_id = ${INDEX_APPLICATION_ID};
        PRAGMA user_version = ${INDEX_SCHEMA_VERSION};
      `);
    } else if (version !== INDEX_SCHEMA_VERSION || applicationId !== INDEX_APPLICATION_ID) {
      throw new SessionIndexError("SESSION_INDEX_SCHEMA", "Session index has an unknown schema or application identity");
    }
    database.prepare("SELECT workspace_root, database_path, indexed_at FROM workspaces LIMIT 0").all();
    database.prepare(`
      SELECT thread_id, thread_id_fold, workspace_root, name, name_fold, created_at, updated_at
      FROM sessions LIMIT 0
    `).all();
    const integrity = database.prepare("PRAGMA quick_check(1)").get() as SqlRow;
    if (requiredString(integrity, "quick_check") !== "ok") {
      throw new SessionIndexError("SESSION_INDEX_CORRUPT", "Session index failed SQLite integrity checking");
    }
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length > 0) throw new SessionIndexError("SESSION_INDEX_CORRUPT", "Session index has invalid references");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function fileIdentityFromStat(details: { dev: bigint | number; ino: bigint | number }): FileIdentity {
  return { device: String(details.dev), inode: String(details.ino) };
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function assertOwned(details: { uid: bigint | number }, label: string): void {
  if (
    process.platform !== "win32"
    && process.getuid !== undefined
    && Number(details.uid) !== process.getuid()
  ) {
    throw new SessionIndexError("SESSION_INDEX_PATH", `${label} is owned by another user`);
  }
}

function openSecureIndexDirectory(path: string): OpenDirectoryGuard {
  if (path === parse(path).root) {
    throw new SessionIndexError("SESSION_INDEX_PATH", "Session index directory cannot be the filesystem root");
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | DIRECTORY | NO_FOLLOW);
  } catch (error) {
    throw new SessionIndexError("SESSION_INDEX_PATH", `Could not securely open session index directory ${path}`, error);
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    const selected = lstatSync(path, { bigint: true });
    if (
      !opened.isDirectory()
      || !selected.isDirectory()
      || selected.isSymbolicLink()
      || opened.dev !== selected.dev
      || opened.ino !== selected.ino
      || realpathSync(path) !== path
    ) {
      throw new SessionIndexError("SESSION_INDEX_PATH", "Session index directory must remain a canonical non-symlink directory");
    }
    assertOwned(opened, "Session index directory");
    if (process.platform !== "win32") {
      if ((opened.mode & 0o1000n) !== 0n) {
        throw new SessionIndexError("SESSION_INDEX_PATH", "Session index directory cannot be a shared sticky directory");
      }
      if ((opened.mode & 0o022n) !== 0n) {
        throw new SessionIndexError("SESSION_INDEX_PATH", "Session index directory must not be group- or world-writable");
      }
      fchmodSync(fd, 0o700);
    }
    return { fd, path, identity: fileIdentityFromStat(opened) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function secureIndexFile(path: string, directory: OpenDirectoryGuard): FileIdentity {
  assertDirectoryGuard(directory);
  let created: number | undefined;
  try {
    created = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
  } catch (error) {
    if (errno(error) !== "EEXIST") {
      throw new SessionIndexError("SESSION_INDEX_PATH", `Could not securely create session index ${path}`, error);
    }
  }
  if (created !== undefined) {
    try {
      const opened = fstatSync(created, { bigint: true });
      const selected = lstatSync(path, { bigint: true });
      if (
        !opened.isFile()
        || !selected.isFile()
        || selected.isSymbolicLink()
        || opened.dev !== selected.dev
        || opened.ino !== selected.ino
        || realpathSync(path) !== path
      ) {
        throw new SessionIndexError("SESSION_INDEX_PATH", "Session index must remain a canonical regular non-symlink file");
      }
      if (opened.nlink !== 1n) throw new SessionIndexError("SESSION_INDEX_PATH", "Session index must not have multiple hard links");
      assertOwned(opened, "Session index");
      if (process.platform !== "win32") fchmodSync(created, 0o600);
      fsyncFileOrDirectory(created);
      return fileIdentityFromStat(opened);
    } finally {
      closeSync(created);
      fsyncFileOrDirectory(directory.fd);
    }
  }

  try {
    const selected = lstatSync(path, { bigint: true });
    if (
      !selected.isFile()
      || selected.isSymbolicLink()
      || realpathSync(path) !== path
    ) {
      throw new SessionIndexError("SESSION_INDEX_PATH", "Session index must remain a canonical regular non-symlink file");
    }
    if (selected.nlink !== 1n) throw new SessionIndexError("SESSION_INDEX_PATH", "Session index must not have multiple hard links");
    assertOwned(selected, "Session index");
    if (process.platform !== "win32") {
      if ((selected.mode & 0o022n) !== 0n) {
        throw new SessionIndexError("SESSION_INDEX_PATH", "Session index must not be group- or world-writable");
      }
      chmodSync(path, 0o600);
    }
    const secured = lstatSync(path, { bigint: true });
    if (
      !secured.isFile()
      || secured.isSymbolicLink()
      || secured.dev !== selected.dev
      || secured.ino !== selected.ino
      || secured.nlink !== 1n
      || realpathSync(path) !== path
    ) {
      throw new SessionIndexError("SESSION_INDEX_PATH", "Session index changed while it was being secured");
    }
    return fileIdentityFromStat(secured);
  } catch (error) {
    if (error instanceof SessionIndexError) throw error;
    throw new SessionIndexError("SESSION_INDEX_PATH", `Could not securely inspect session index ${path}`, error);
  }
}

function unsupportedDirectorySync(error: unknown): boolean {
  const code = errno(error);
  return (
    process.platform === "win32"
    && new Set(["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]).has(code ?? "")
  ) || (
    process.platform === "darwin"
    && new Set(["EINVAL", "ENOTSUP"]).has(code ?? "")
  );
}

function fsyncFileOrDirectory(fd: number): void {
  try {
    fsyncSync(fd);
  } catch (error) {
    if (!unsupportedDirectorySync(error)) throw error;
  }
}

function syncDirectoryPath(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | DIRECTORY | NO_FOLLOW);
    if (!fstatSync(fd).isDirectory()) {
      throw new SessionIndexError("SESSION_INDEX_PATH", `Cannot make session index directory durable because ${path} is not a directory`);
    }
    fsyncFileOrDirectory(fd);
  } catch (error) {
    if (!unsupportedDirectorySync(error)) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function syncCreatedDirectoryChain(path: string, firstCreated: string, directoryFd: number): void {
  fsyncFileOrDirectory(directoryFd);
  const stop = dirname(firstCreated);
  let cursor = dirname(path);
  while (true) {
    syncDirectoryPath(cursor);
    if (cursor === stop) return;
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function assertDirectoryGuard(directory: OpenDirectoryGuard): void {
  const opened = fstatSync(directory.fd, { bigint: true });
  const selected = lstatSync(directory.path, { bigint: true });
  if (
    !opened.isDirectory()
    || !selected.isDirectory()
    || selected.isSymbolicLink()
    || opened.dev !== selected.dev
    || opened.ino !== selected.ino
    || !sameIdentity(directory.identity, fileIdentityFromStat(opened))
    || realpathSync(directory.path) !== directory.path
  ) {
    throw new SessionIndexError("SESSION_INDEX_PATH", "Session index directory changed after opening");
  }
  assertOwned(opened, "Session index directory");
  if (process.platform !== "win32" && (opened.mode & 0o077n) !== 0n) {
    throw new SessionIndexError("SESSION_INDEX_PATH", "Session index directory permissions changed after opening");
  }
}

function assertIndexGuards(path: string, index: FileIdentity, directory: OpenDirectoryGuard): void {
  assertDirectoryGuard(directory);
  let selected;
  try {
    selected = lstatSync(path, { bigint: true });
  } catch (error) {
    throw new SessionIndexError("SESSION_INDEX_PATH", "Session index path changed after opening", error);
  }
  if (
    !selected.isFile()
    || selected.isSymbolicLink()
    || !sameIdentity(index, fileIdentityFromStat(selected))
    || realpathSync(path) !== path
  ) {
    throw new SessionIndexError("SESSION_INDEX_PATH", "Session index file changed after opening");
  }
  if (selected.nlink !== 1n) throw new SessionIndexError("SESSION_INDEX_PATH", "Session index must not have multiple hard links");
  assertOwned(selected, "Session index");
  if (process.platform !== "win32" && (selected.mode & 0o077n) !== 0n) {
    throw new SessionIndexError("SESSION_INDEX_PATH", "Session index permissions changed after opening");
  }
}

async function verifyWorkspaceSource(workspaceRoot: string, databasePath: string): Promise<VerifiedWorkspaceSource> {
  const workspace = await canonicalDirectory(workspaceRoot, "Workspace root");
  const database = await canonicalRegularFile(databasePath, "Session database");
  return {
    workspaceRoot: workspace.path,
    databasePath: database.path,
    workspaceIdentity: workspace.identity,
    databaseIdentity: database.identity,
  };
}

async function canonicalDirectory(path: string, label: string): Promise<{ path: string; identity: FileIdentity }> {
  const selected = validateAbsolutePath(path, label);
  let canonical: string;
  try {
    if (await hasSymlinkComponent(selected)) throw stale(`${label} resolves through a symbolic link: ${selected}`);
    canonical = await canonicalExistingPath(selected);
  } catch (error) {
    throw stale(`${label} is missing or inaccessible: ${selected}`, error);
  }
  const selectedDetails = await lstat(selected, { bigint: true });
  if (selectedDetails.isSymbolicLink() || !selectedDetails.isDirectory()) {
    throw stale(`${label} must be a non-symlink directory: ${selected}`);
  }
  const details = await stat(canonical, { bigint: true });
  if (!details.isDirectory() || details.dev !== selectedDetails.dev || details.ino !== selectedDetails.ino) {
    throw stale(`${label} changed while it was being canonicalized: ${selected}`);
  }
  return { path: canonical, identity: identityFromStat(details) };
}

async function canonicalRegularFile(path: string, label: string): Promise<{ path: string; identity: FileIdentity }> {
  const selected = validateAbsolutePath(path, label);
  let details;
  try {
    if (await hasSymlinkComponent(selected)) throw stale(`${label} resolves through a symbolic link: ${selected}`);
    details = await lstat(selected, { bigint: true });
  } catch (error) {
    throw stale(`${label} is missing or inaccessible: ${selected}`, error);
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw stale(`${label} must be a regular non-symlink file: ${selected}`);
  }
  assertPrivateOwnedSourceFile(details, label, selected);
  const canonical = await canonicalExistingPath(selected);
  const current = await lstat(canonical, { bigint: true });
  if (!current.isFile() || current.dev !== details.dev || current.ino !== details.ino) {
    throw stale(`${label} changed while it was being canonicalized: ${selected}`);
  }
  return { path: canonical, identity: identityFromStat(details) };
}

function readSourceSessions(source: VerifiedWorkspaceSource): SourceSession[] {
  return withSourceDatabase(source, (database) => {
    const rows = database.prepare(`
      SELECT thread_id, name, created_at, updated_at, workspace_root
      FROM threads
      WHERE workspace_root = ?
        AND EXISTS (
          SELECT 1 FROM events
          WHERE events.thread_id = threads.thread_id
        )
      ORDER BY updated_at DESC, thread_id ASC
      LIMIT ?
    `).all(source.workspaceRoot, MAX_WORKSPACE_SESSIONS + 1) as SqlRow[];
    if (rows.length > MAX_WORKSPACE_SESSIONS) {
      throw new SessionIndexError(
        "SESSION_INDEX_LIMIT",
        `Workspace exceeds ${MAX_WORKSPACE_SESSIONS} sessions; exact cleanup is required before indexing`,
      );
    }
    return rows.map((row) => sourceSessionFromRow(row, source.workspaceRoot));
  }, true);
}

function readSourceSession(source: VerifiedWorkspaceSource, threadId: string): SourceSession | undefined {
  const selected = boundedText(threadId, MAX_THREAD_ID_BYTES, "Thread ID");
  return withSourceDatabase(source, (database) => {
    const row = database.prepare(`
      SELECT thread_id, name, created_at, updated_at, workspace_root
      FROM threads
      WHERE thread_id = ? AND workspace_root = ?
        AND EXISTS (
          SELECT 1 FROM events
          WHERE events.thread_id = threads.thread_id
        )
    `).get(selected, source.workspaceRoot) as SqlRow | undefined;
    return row === undefined ? undefined : sourceSessionFromRow(row, source.workspaceRoot);
  });
}

function withSourceDatabase<T>(
  source: VerifiedWorkspaceSource,
  operation: (database: DatabaseSync) => T,
  fullIntegrityCheck = false,
): T {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(source.databasePath, { readOnly: true, timeout: DEFAULT_BUSY_TIMEOUT_MS });
    const version = pragmaNumber(database, "user_version");
    if (version !== CURRENT_SCHEMA_VERSION) {
      throw stale(
        `Session database schema ${version} is not the current schema ${CURRENT_SCHEMA_VERSION}; open it normally before indexing`,
      );
    }
    if (fullIntegrityCheck) {
      const integrity = database.prepare("PRAGMA quick_check(1)").get() as SqlRow;
      if (requiredString(integrity, "quick_check") !== "ok") {
        throw new SessionIndexError("SESSION_INDEX_CORRUPT", `Session database failed integrity checking: ${source.databasePath}`);
      }
    }
    const result = operation(database);
    const current = regularFileIdentitySync(source.databasePath, "Session database");
    if (!sameIdentity(source.databaseIdentity, current)) {
      throw stale(`Session database was replaced while it was being read; refresh the session index`);
    }
    return result;
  } catch (error) {
    if (error instanceof SessionIndexError) throw error;
    throw new SessionIndexError("SESSION_INDEX_CORRUPT", `Could not read session database ${source.databasePath}`, error);
  } finally {
    database?.close();
  }
}

function regularFileIdentitySync(path: string, label: string): FileIdentity {
  let details;
  try {
    details = lstatSync(path, { bigint: true });
  } catch (error) {
    throw stale(`${label} is missing or inaccessible: ${path}`, error);
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw stale(`${label} must remain a regular non-symlink file: ${path}`);
  }
  assertPrivateOwnedSourceFile(details, label, path);
  if (realpathSync(path) !== path) throw stale(`${label} moved or resolves elsewhere: ${path}`);
  return identityFromStat(details);
}

function assertPrivateOwnedSourceFile(
  details: { nlink: bigint; uid: bigint; mode: bigint },
  label: string,
  path: string,
): void {
  if (details.nlink !== 1n) throw stale(`${label} must not have multiple hard links: ${path}`);
  if (
    process.platform !== "win32"
    && process.getuid !== undefined
    && Number(details.uid) !== process.getuid()
  ) {
    throw stale(`${label} is owned by another user: ${path}`);
  }
  if (process.platform !== "win32" && (details.mode & 0o077n) !== 0n) {
    throw stale(`${label} must only be accessible by its owner: ${path}`);
  }
}

function sourceSessionFromRow(row: SqlRow, workspaceRoot: string): SourceSession {
  if (requiredString(row, "workspace_root") !== workspaceRoot) {
    throw new SessionIndexError("SESSION_INDEX_CORRUPT", "Session database returned a cross-workspace row");
  }
  const nameValue = optionalString(row, "name");
  const session: SourceSession = {
    threadId: boundedText(requiredString(row, "thread_id"), MAX_THREAD_ID_BYTES, "Thread ID"),
    createdAt: canonicalTimestamp(requiredString(row, "created_at"), "Session createdAt"),
    updatedAt: canonicalTimestamp(requiredString(row, "updated_at"), "Session updatedAt"),
  };
  if (nameValue !== undefined) session.name = boundedText(nameValue, MAX_THREAD_NAME_BYTES, "Thread name");
  return session;
}

function indexedSessionFromRow(row: SqlRow): IndexedSessionRecord {
  const record: IndexedSessionRecord = {
    threadId: boundedText(requiredString(row, "thread_id"), MAX_THREAD_ID_BYTES, "Indexed thread ID"),
    workspaceRoot: validateAbsolutePath(requiredString(row, "workspace_root"), "Indexed workspace root"),
    databasePath: validateAbsolutePath(requiredString(row, "database_path"), "Indexed database path"),
    createdAt: canonicalTimestamp(requiredString(row, "created_at"), "Indexed createdAt"),
    updatedAt: canonicalTimestamp(requiredString(row, "updated_at"), "Indexed updatedAt"),
    indexedAt: canonicalTimestamp(requiredString(row, "indexed_at"), "Indexed indexedAt"),
  };
  const name = optionalString(row, "name");
  if (name !== undefined) record.name = boundedText(name, MAX_THREAD_NAME_BYTES, "Indexed thread name");
  return record;
}

function workspaceFromRow(row: SqlRow): WorkspaceRow {
  return {
    workspaceRoot: validateAbsolutePath(requiredString(row, "workspace_root"), "Indexed workspace root"),
    databasePath: validateAbsolutePath(requiredString(row, "database_path"), "Indexed database path"),
    workspaceIdentity: {
      device: identityValue(row, "workspace_device"),
      inode: identityValue(row, "workspace_inode"),
    },
    databaseIdentity: {
      device: identityValue(row, "database_device"),
      inode: identityValue(row, "database_inode"),
    },
    indexedAt: canonicalTimestamp(requiredString(row, "indexed_at"), "Indexed indexedAt"),
  };
}

function canonicalIndexedSession(value: IndexedSessionRecord): IndexedSessionRecord {
  const record: IndexedSessionRecord = {
    threadId: boundedText(value.threadId, MAX_THREAD_ID_BYTES, "Thread ID"),
    workspaceRoot: validateAbsolutePath(value.workspaceRoot, "Workspace root"),
    databasePath: validateAbsolutePath(value.databasePath, "Database path"),
    createdAt: canonicalTimestamp(value.createdAt, "createdAt"),
    updatedAt: canonicalTimestamp(value.updatedAt, "updatedAt"),
    indexedAt: canonicalTimestamp(value.indexedAt, "indexedAt"),
  };
  if (value.name !== undefined) record.name = boundedText(value.name, MAX_THREAD_NAME_BYTES, "Thread name");
  return record;
}

function toIndexedSession(session: SourceSession, workspace: WorkspaceRow): IndexedSessionRecord {
  return {
    threadId: session.threadId,
    ...(session.name === undefined ? {} : { name: session.name }),
    workspaceRoot: workspace.workspaceRoot,
    databasePath: workspace.databasePath,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    indexedAt: workspace.indexedAt,
  };
}

function sameThreadSummary(thread: ThreadRecord, session: SourceSession): boolean {
  return thread.threadId === session.threadId
    && thread.name === session.name
    && thread.createdAt === session.createdAt
    && thread.updatedAt === session.updatedAt;
}

function sameIndexedSummary(record: IndexedSessionRecord, session: SourceSession): boolean {
  return record.threadId === session.threadId
    && record.name === session.name
    && record.createdAt === session.createdAt
    && record.updatedAt === session.updatedAt;
}

function sameIndexedSession(left: IndexedSessionRecord, right: IndexedSessionRecord): boolean {
  return left.threadId === right.threadId
    && left.name === right.name
    && left.workspaceRoot === right.workspaceRoot
    && left.databasePath === right.databasePath
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && left.indexedAt === right.indexedAt;
}

function identityFromStat(details: { dev: bigint | number; ino: bigint | number }): FileIdentity {
  return { device: String(details.dev), inode: String(details.ino) };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameWorkspaceSource(left: VerifiedWorkspaceSource, right: VerifiedWorkspaceSource): boolean {
  return left.workspaceRoot === right.workspaceRoot
    && left.databasePath === right.databasePath
    && sameIdentity(left.workspaceIdentity, right.workspaceIdentity)
    && sameIdentity(left.databaseIdentity, right.databaseIdentity);
}

function identityValue(row: SqlRow, key: string): string {
  const value = requiredString(row, key);
  if (!/^\d{1,64}$/u.test(value)) throw new SessionIndexError("SESSION_INDEX_CORRUPT", `Invalid ${key}`);
  return value;
}

function requiredString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new SessionIndexError("SESSION_INDEX_CORRUPT", `Session index field ${key} is invalid`);
  return value;
}

function optionalString(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new SessionIndexError("SESSION_INDEX_CORRUPT", `Session index field ${key} is invalid`);
  return value;
}

function requiredCount(row: SqlRow): number {
  const value = row["value"];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SessionIndexError("SESSION_INDEX_CORRUPT", "Session index count is invalid");
  }
  return value;
}

function pragmaNumber(database: DatabaseSync, name: "user_version" | "application_id"): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as SqlRow;
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new SessionIndexError("SESSION_INDEX_SCHEMA", `Session index PRAGMA ${name} is invalid`);
  }
  return value;
}

function validateAbsolutePath(value: string, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new SessionIndexError("SESSION_INDEX_PATH", `${label} must be an absolute path`);
  }
  const selected = resolve(value);
  const windowsHazard = windowsPathHazard(selected);
  if (windowsHazard !== undefined) {
    throw new SessionIndexError("SESSION_INDEX_PATH", `${label} uses an unsupported Windows ${windowsHazard}`);
  }
  if (selected !== value || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) {
    throw new SessionIndexError("SESSION_INDEX_PATH", `${label} must be canonical and no larger than 4 KiB`);
  }
  return value;
}

function boundedText(value: string, maxBytes: number, label: string): string {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > maxBytes || value.includes("\0")) {
    throw new SessionIndexError("SESSION_INDEX_CORRUPT", `${label} is invalid or exceeds its byte limit`);
  }
  return value;
}

function fold(value: string): string {
  return value.toLowerCase();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

const INDEX_PAGE_CURSOR_VERSION = 1;
const MAX_INDEX_PAGE_CURSOR_BYTES = 24 * 1_024;

function indexPageCursorBinding(workspaceRoot: string | undefined, search: string | undefined): string {
  return createHash("sha256")
    .update(workspaceRoot ?? "*", "utf8")
    .update("\0", "utf8")
    .update(search ?? "", "utf8")
    .digest("base64url");
}

function encodeIndexPageCursor(
  record: Pick<IndexedSessionRecord, "updatedAt" | "threadId" | "workspaceRoot">,
  workspaceRoot: string | undefined,
  search: string | undefined,
): string {
  return Buffer.from(JSON.stringify([
    INDEX_PAGE_CURSOR_VERSION,
    indexPageCursorBinding(workspaceRoot, search),
    record.updatedAt,
    record.threadId,
    record.workspaceRoot,
  ]), "utf8").toString("base64url");
}

function decodeIndexPageCursor(
  value: string,
  workspaceRoot: string | undefined,
  search: string | undefined,
): Pick<IndexedSessionRecord, "updatedAt" | "threadId" | "workspaceRoot"> {
  const invalid = (): never => { throw new Error("Session index page cursor is invalid"); };
  if (
    typeof value !== "string" || value === "" || value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_INDEX_PAGE_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) invalid();
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) invalid();
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !Array.isArray(parsed) || parsed.length !== 5 ||
      parsed[0] !== INDEX_PAGE_CURSOR_VERSION ||
      parsed[1] !== indexPageCursorBinding(workspaceRoot, search)
    ) invalid();
    const parts = parsed as unknown[];
    return {
      updatedAt: canonicalTimestamp(parts[2] as string, "Session index page cursor timestamp"),
      threadId: boundedText(parts[3] as string, MAX_THREAD_ID_BYTES, "Session index page cursor thread ID"),
      workspaceRoot: validateAbsolutePath(parts[4] as string, "Session index page cursor workspace"),
    };
  } catch {
    return invalid();
  }
}

function canonicalTimestamp(value: string, label: string): string {
  const selected = boundedText(value, 64, label);
  const timestamp = Date.parse(selected);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== selected) {
    throw new SessionIndexError("SESSION_INDEX_CORRUPT", `${label} is not a canonical timestamp`);
  }
  return selected;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function stale(message: string, cause?: unknown): SessionIndexError {
  return new SessionIndexError("SESSION_INDEX_STALE", message, cause);
}
