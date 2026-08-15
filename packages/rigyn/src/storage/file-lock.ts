import { randomUUID } from "node:crypto";
import { opendirSync } from "node:fs";
import {
  mkdir,
  lstat,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { readControlFile, readControlFileSync } from "./control-file.js";

const RETRY_DELAY_MS = 20;
const ASYNC_TIMEOUT_MS = 30_000;
const STALE_AFTER_MS = 45_000;
const MAX_LOCK_ENTRIES = 4;
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface LockDirectoryIdentity {
  dev: bigint;
  ino: bigint;
}

type ControlName = "claim" | "owner" | "pid";

function lockDirectory(path: string): string {
  return `${path}.lock`;
}

function controlPath(path: string, name: ControlName, token: string): string {
  return `${lockDirectory(path)}/${name}-${token}`;
}

async function directoryIdentity(path: string): Promise<LockDirectoryIdentity> {
  const value = await lstat(lockDirectory(path), { bigint: true });
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error("File lock is not a real directory");
  return { dev: value.dev, ino: value.ino };
}

function sameIdentity(left: LockDirectoryIdentity, right: LockDirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isAlreadyLocked(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isLostUnclaimedDirectory(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function cleanupFailure(path: string): Error {
  return new Error(`Failed to release file lock for ${path}`);
}

function operationAndCleanupFailure(path: string, operationError: unknown): AggregateError {
  const releaseError = cleanupFailure(path);
  const operationMessage = operationError instanceof Error ? operationError.message : "File lock operation failed";
  return new AggregateError(
    [operationError, releaseError],
    `${operationMessage}; ${releaseError.message}`,
    { cause: operationError },
  );
}

function claimTokenSync(path: string): string | undefined {
  let selected: string | undefined;
  const handle = opendirSync(lockDirectory(path));
  try {
    for (let scanned = 0; scanned <= MAX_LOCK_ENTRIES; scanned += 1) {
      const entry = handle.readSync();
      if (entry === null) return selected;
      if (scanned === MAX_LOCK_ENTRIES) return undefined;
      if (!entry.name.startsWith("claim-")) continue;
      if (!entry.isFile()) return undefined;
      const token = entry.name.slice("claim-".length);
      if (selected !== undefined || !TOKEN.test(token)) return undefined;
      if (readControlFileSync(controlPath(path, "claim", token)) !== token) return undefined;
      selected = token;
    }
    return undefined;
  } finally {
    handle.closeSync();
  }
}

function lockOwnerIsAlive(path: string): boolean {
  try {
    const token = claimTokenSync(path);
    if (token === undefined) return false;
    if (readControlFileSync(controlPath(path, "owner", token)) !== token) return false;
    const pid = Number(readControlFileSync(controlPath(path, "pid", token)));
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  } catch {
    return false;
  }
}

async function removeExpectedControl(path: string, name: ControlName, token: string, expected: string): Promise<boolean> {
  const selected = controlPath(path, name, token);
  try {
    if (await readControlFile(selected) !== expected) return false;
    await unlink(selected);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    return false;
  }
}

async function removeStaleControl(path: string, name: Exclude<ControlName, "claim">, token: string): Promise<boolean> {
  const selected = controlPath(path, name, token);
  try {
    const metadata = await lstat(selected);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) await rmdir(selected);
    else await unlink(selected);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}

async function rollBackWrittenControls(
  path: string,
  created: LockDirectoryIdentity,
  token: string,
  controls: readonly Exclude<ControlName, "claim">[],
): Promise<boolean> {
  const ownedDirectory = await directoryMatches(path, created, token, false);
  let success = true;
  for (const name of controls) {
    const expected = name === "owner" ? token : String(process.pid);
    if (!(await removeExpectedControl(path, name, token, expected))) success = false;
  }
  if (!(await removeExpectedControl(path, "claim", token, token))) success = false;
  if (success && ownedDirectory) {
    try {
      await rmdir(lockDirectory(path));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) success = false;
    }
  }
  return success;
}

async function directoryMatches(
  path: string,
  created: LockDirectoryIdentity,
  token: string,
  complete: boolean,
): Promise<boolean> {
  try {
    return sameIdentity(await directoryIdentity(path), created)
      && await readControlFile(controlPath(path, "claim", token)) === token
      && (!complete || (
        await readControlFile(controlPath(path, "owner", token)) === token
        && await readControlFile(controlPath(path, "pid", token)) === String(process.pid)
      ));
  } catch {
    return false;
  }
}

async function removeClaimed(
  path: string,
  created: LockDirectoryIdentity,
  token: string,
  controls: readonly Exclude<ControlName, "claim">[],
  complete: boolean,
): Promise<boolean> {
  if (!(await directoryMatches(path, created, token, complete))) return false;
  let controlsRemoved = true;
  for (const name of controls) {
    const expected = name === "owner" ? token : String(process.pid);
    if (!(await removeExpectedControl(path, name, token, expected))) controlsRemoved = false;
  }
  if (!controlsRemoved) return false;
  try {
    await unlink(controlPath(path, "claim", token));
    await rmdir(lockDirectory(path));
    return true;
  } catch {
    return false;
  }
}

async function removeStale(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(lockDirectory(path), { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
    if (Date.now() - Number(metadata.mtimeMs) <= STALE_AFTER_MS) return false;
    const created = { dev: metadata.dev, ino: metadata.ino };
    const token = claimTokenSync(path);
    if (token === undefined) {
      await rmdir(lockDirectory(path));
      return true;
    }
    if (lockOwnerIsAlive(path)) return false;
    if (!(await directoryMatches(path, created, token, false))) return false;
    const ownerRemoved = await removeStaleControl(path, "owner", token);
    const pidRemoved = await removeStaleControl(path, "pid", token);
    if (!ownerRemoved || !pidRemoved) return false;
    try {
      await unlink(controlPath(path, "claim", token));
      await rmdir(lockDirectory(path));
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

async function waitForRetry(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    await delay(RETRY_DELAY_MS);
    return;
  }
  try {
    await delay(RETRY_DELAY_MS, undefined, { signal });
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
}

export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const token = randomUUID();
  const started = Date.now();
  let acquired: LockDirectoryIdentity | undefined;
  while (true) {
    signal?.throwIfAborted();
    let createdDirectory = false;
    try {
      await mkdir(lockDirectory(path));
      createdDirectory = true;
      const created = await directoryIdentity(path);
      const written: Exclude<ControlName, "claim">[] = [];
      let claimed = false;
      try {
        await writeFile(controlPath(path, "claim", token), token, { encoding: "utf8", flag: "wx", mode: 0o600 });
        claimed = true;
        await writeFile(controlPath(path, "owner", token), token, { encoding: "utf8", flag: "wx", mode: 0o600 });
        written.push("owner");
        await writeFile(controlPath(path, "pid", token), String(process.pid), { encoding: "utf8", flag: "wx", mode: 0o600 });
        written.push("pid");
        if (!(await directoryMatches(path, created, token, true))) {
          throw new Error(`File lock was replaced for ${path}`);
        }
      } catch (error) {
        if (claimed && !(await rollBackWrittenControls(path, created, token, written))) {
          throw operationAndCleanupFailure(path, error);
        }
        throw error;
      }
      acquired = created;
      break;
    } catch (error) {
      if (createdDirectory && isLostUnclaimedDirectory(error)) {
        if (Date.now() - started >= ASYNC_TIMEOUT_MS) {
          throw new Error(`Timed out acquiring file lock for ${path}`);
        }
        await waitForRetry(signal);
        continue;
      }
      if (!isAlreadyLocked(error)) throw error;
      if (Date.now() - started >= ASYNC_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring file lock for ${path}`);
      }
      if (!(await removeStale(path))) await waitForRetry(signal);
    }
  }
  if (acquired === undefined) throw new Error(`Timed out acquiring file lock for ${path}`);
  try {
    signal?.throwIfAborted();
  } catch (error) {
    if (!(await removeClaimed(path, acquired, token, ["owner", "pid"], true))) {
      throw operationAndCleanupFailure(path, error);
    }
    throw error;
  }

  let result!: T;
  let operationError: unknown;
  let operationFailed = false;
  try {
    result = await operation();
    if (!(await directoryMatches(path, acquired, token, true))) {
      throw new Error(`File lock was replaced for ${path}`);
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  const released = await removeClaimed(path, acquired, token, ["owner", "pid"], true);
  if (!released) {
    if (operationFailed) throw operationAndCleanupFailure(path, operationError);
    throw cleanupFailure(path);
  }
  if (operationFailed) throw operationError;
  return result;
}
