import { constants } from "node:fs";
import { homedir } from "node:os";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { sha256 } from "../tools/hash.js";

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

export interface SqliteProcessLeaseOptions {
  timeoutMs: number;
  retryMs?: number;
  label: string;
}

function sqliteContention(error: unknown): boolean {
  if (!(error instanceof Error) || !("errcode" in error) || typeof error.errcode !== "number") return false;
  const primary = error.errcode & 0xff;
  return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
}

interface PreparedLockFile {
  path: string;
  handle: Awaited<ReturnType<typeof open>>;
  device: number | bigint;
  inode: number | bigint;
}

function sameFile(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertProtectedDirectory(path: string): Promise<void> {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  const currentUid = process.getuid();
  let child = await lstat(path);
  if (!child.isDirectory() || child.isSymbolicLink()) {
    throw new Error(`Process lock directory must be a real directory: ${path}`);
  }
  if (child.uid !== currentUid || (child.mode & 0o022) !== 0) {
    throw new Error(`Process lock directory must be private and owned by the current user: ${path}`);
  }
  let selected = path;
  const root = parse(path).root;
  while (selected !== root) {
    const parent = dirname(selected);
    const information = await lstat(parent);
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw new Error(`Process lock ancestor must be a real directory: ${parent}`);
    }
    const trustedOwner = information.uid === currentUid || information.uid === 0;
    const ownerCanReplace = !trustedOwner && (information.mode & 0o200) !== 0;
    const sharedWritable = (information.mode & 0o022) !== 0;
    const stickyProtectsChild = (information.mode & 0o1000) !== 0
      && trustedOwner
      && (child.uid === currentUid || child.uid === 0);
    if (ownerCanReplace || (sharedWritable && !stickyProtectsChild)) {
      throw new Error(`Process lock path has a writable shared ancestor: ${parent}`);
    }
    selected = parent;
    child = information;
  }
}

async function prepareLockFile(requestedPath: string): Promise<PreparedLockFile> {
  const requestedDirectory = resolve(dirname(requestedPath));
  await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
  const canonicalDirectory = await realpath(requestedDirectory);
  await assertProtectedDirectory(canonicalDirectory);
  const path = join(canonicalDirectory, basename(requestedPath));
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  }
  try {
    let information = await handle.stat();
    const pathInformation = await lstat(path);
    if (!information.isFile() || !pathInformation.isFile() || pathInformation.isSymbolicLink()
      || !sameFile(information, pathInformation)) {
      throw new Error(`Process lock must be a stable regular non-symlink file: ${path}`);
    }
    if (process.platform !== "win32") {
      if (information.nlink !== 1) throw new Error(`Process lock must not have hard links: ${path}`);
      if (typeof process.getuid === "function" && information.uid !== process.getuid()) {
        throw new Error(`Process lock is owned by another user: ${path}`);
      }
      await handle.chmod(0o600);
      information = await handle.stat();
    }
    return { path, handle, device: information.dev, inode: information.ino };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export function defaultSqliteLeaseRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(
    environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "rigyn",
    "package-leases",
  );
}

export async function keyedSqliteLeasePath(root: string, namespace: string, identity: string): Promise<string> {
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(namespace)) throw new TypeError("Process lock namespace is invalid");
  const canonicalIdentity = await realpath(resolve(identity));
  return join(resolve(root), `${namespace}-${sha256(canonicalIdentity)}.sqlite3`);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000) {
    throw new RangeError(`${label} must be an integer from 1 through 3600000`);
  }
  return value;
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Process lock wait cancelled"));
    };
    if (signal?.aborted === true) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Runs an asynchronous operation while an OS-backed SQLite writer lease is held.
 * SQLite releases the lease if the process exits, so no PID or stale-file recovery
 * is required. The small database file intentionally persists between runs.
 */
export async function withSqliteProcessLease<T>(
  path: string,
  operation: () => Promise<T>,
  options: SqliteProcessLeaseOptions,
  signal?: AbortSignal,
): Promise<T> {
  const timeoutMs = positiveInteger(options.timeoutMs, "Process lock timeoutMs");
  const retryMs = positiveInteger(options.retryMs ?? 50, "Process lock retryMs");
  if (options.label.trim() === "") throw new TypeError("Process lock label must not be empty");
  signal?.throwIfAborted();
  const prepared = await prepareLockFile(path);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(prepared.path);
    const current = await lstat(prepared.path);
    if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== prepared.device || current.ino !== prepared.inode) {
      throw new Error(`Process lock path changed while it was opened: ${prepared.path}`);
    }
    database.exec("PRAGMA busy_timeout = 0");
  } catch (error) {
    database?.close();
    await prepared.handle.close().catch(() => undefined);
    throw error;
  }
  const deadline = performance.now() + timeoutMs;
  let acquired = false;
  try {
    while (!acquired) {
      signal?.throwIfAborted();
      try {
        database.exec("BEGIN IMMEDIATE");
        acquired = true;
      } catch (error) {
        if (!sqliteContention(error)) throw error;
      }
      if (acquired) break;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${options.label}: ${path}`);
      await wait(Math.min(retryMs, remaining), signal);
    }
    return await operation();
  } finally {
    try {
      if (acquired) {
        try {
          database.exec("ROLLBACK");
        } finally {
          database.close();
        }
      } else {
        database.close();
      }
    } finally {
      await prepared.handle.close().catch(() => undefined);
    }
  }
}
