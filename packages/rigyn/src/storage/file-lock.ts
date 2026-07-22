import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";

const RETRY_DELAY_MS = 20;
const SYNC_ATTEMPTS = 10;
const ASYNC_TIMEOUT_MS = 30_000;
const STALE_AFTER_MS = 45_000;
const HEARTBEAT_MS = 10_000;

function lockDirectory(path: string): string {
  return `${path}.lock`;
}

function tokenPath(path: string): string {
  return `${lockDirectory(path)}/owner`;
}

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isAlreadyLocked(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function removeStaleSync(path: string): boolean {
  try {
    if (Date.now() - statSync(lockDirectory(path)).mtimeMs <= STALE_AFTER_MS) return false;
    rmSync(lockDirectory(path), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function removeStale(path: string): Promise<boolean> {
  try {
    if (Date.now() - (await stat(lockDirectory(path))).mtimeMs <= STALE_AFTER_MS) return false;
    await rm(lockDirectory(path), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function releaseSync(path: string, token: string): void {
  try {
    if (readFileSync(tokenPath(path), "utf8") === token) {
      rmSync(lockDirectory(path), { recursive: true, force: true });
    }
  } catch {
    // A replaced or already released lock is not ours to remove.
  }
}

async function release(path: string, token: string): Promise<void> {
  try {
    if (await readFile(tokenPath(path), "utf8") === token) {
      await rm(lockDirectory(path), { recursive: true, force: true });
    }
  } catch {
    // A replaced or already released lock is not ours to remove.
  }
}

export function withFileLockSync<T>(path: string, operation: () => T): T {
  const token = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt += 1) {
    try {
      mkdirSync(lockDirectory(path));
      writeFileSync(tokenPath(path), token, { encoding: "utf8", mode: 0o600 });
      acquired = true;
      break;
    } catch (error) {
      if (!isAlreadyLocked(error)) throw error;
      if (!removeStaleSync(path)) pause(RETRY_DELAY_MS);
    }
  }
  if (!acquired) throw new Error(`Timed out acquiring file lock for ${path}`);

  try {
    return operation();
  } finally {
    releaseSync(path, token);
  }
}

export async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockDirectory(path));
      await writeFile(tokenPath(path), token, { encoding: "utf8", mode: 0o600 });
      break;
    } catch (error) {
      if (!isAlreadyLocked(error)) throw error;
      if (Date.now() - started >= ASYNC_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring file lock for ${path}`);
      }
      if (!(await removeStale(path))) {
        await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  let compromised: Error | undefined;
  const heartbeat = setInterval(() => {
    try {
      if (readFileSync(tokenPath(path), "utf8") !== token) {
        compromised = new Error(`File lock was replaced for ${path}`);
        return;
      }
      const now = new Date();
      utimesSync(lockDirectory(path), now, now);
    } catch (error) {
      compromised = error instanceof Error ? error : new Error(String(error));
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  try {
    const result = await operation();
    if (compromised !== undefined) throw compromised;
    if (await readFile(tokenPath(path), "utf8") !== token) {
      throw new Error(`File lock was replaced for ${path}`);
    }
    await utimes(lockDirectory(path), new Date(), new Date());
    return result;
  } finally {
    clearInterval(heartbeat);
    await release(path, token);
  }
}
