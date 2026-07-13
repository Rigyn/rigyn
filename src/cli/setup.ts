import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { applyEdits, modify } from "jsonc-parser";

import { parseJsoncObject, type JsonObject } from "../config/index.js";
import { HarnessError } from "../core/errors.js";
import type { HarnessPaths } from "./paths.js";

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 25;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const TEMPORARY_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/iu;

interface ConfigLease {
  release(): Promise<void>;
}

export interface ConfigUpdateOptions {
  lockTimeoutMs?: number;
  retryDelayMs?: number;
}

type ConfigUpdater = (existing: JsonObject) => JsonObject | Promise<JsonObject>;

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function positiveOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new HarnessError("CONFIG_LOCK_OPTIONS", `${name} must be a positive finite number`);
  }
  return Math.ceil(resolved);
}

function lockPathFor(configPath: string): string {
  return `${configPath}.lock.sqlite3`;
}

function isSqliteContention(error: unknown): boolean {
  if (!(error instanceof Error) || !("errcode" in error) || typeof error.errcode !== "number") {
    return false;
  }
  const primaryCode = error.errcode & 0xff;
  return primaryCode === SQLITE_BUSY || primaryCode === SQLITE_LOCKED;
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = errorCode(error);
    const unsupportedOnWindows =
      process.platform === "win32" &&
      (code === "EACCES" ||
        code === "EINVAL" ||
        code === "EISDIR" ||
        code === "ENOTSUP" ||
        code === "EPERM");
    const unsupportedOnMac =
      process.platform === "darwin" && (code === "EINVAL" || code === "ENOTSUP");
    if (!unsupportedOnWindows && !unsupportedOnMac) throw error;
  } finally {
    await handle?.close();
  }
}

async function openLockDatabase(configPath: string): Promise<DatabaseSync> {
  const lockPath = lockPathFor(configPath);
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  let created = false;
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    created = true;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  } finally {
    await handle?.close();
  }
  if (process.platform !== "win32") await chmod(lockPath, 0o600);
  if (created) await syncDirectory(dirname(configPath));

  const database = new DatabaseSync(lockPath);
  try {
    database.exec("PRAGMA busy_timeout = 0");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function timeoutError(configPath: string, lockTimeoutMs: number): HarnessError {
  return new HarnessError(
    "CONFIG_LOCK_TIMEOUT",
    `Timed out after ${lockTimeoutMs}ms waiting for configuration lock ${lockPathFor(configPath)}`,
  );
}

async function acquireConfigLease(
  configPath: string,
  options: ConfigUpdateOptions,
): Promise<ConfigLease> {
  const lockTimeoutMs = positiveOption(
    options.lockTimeoutMs,
    DEFAULT_LOCK_TIMEOUT_MS,
    "lockTimeoutMs",
  );
  const retryDelayMs = positiveOption(
    options.retryDelayMs,
    DEFAULT_RETRY_DELAY_MS,
    "retryDelayMs",
  );
  const database = await openLockDatabase(configPath);
  const deadline = performance.now() + lockTimeoutMs;
  let attempts = 0;

  while (true) {
    if (attempts > 0 && performance.now() >= deadline) {
      database.close();
      throw timeoutError(configPath, lockTimeoutMs);
    }
    let acquired = false;
    try {
      database.exec("BEGIN IMMEDIATE");
      acquired = true;
    } catch (error) {
      if (!isSqliteContention(error)) {
        database.close();
        throw error;
      }
    }
    if (acquired) {
      if (attempts > 0 && performance.now() >= deadline) {
        database.exec("ROLLBACK");
        database.close();
        throw timeoutError(configPath, lockTimeoutMs);
      }
      break;
    }
    attempts += 1;
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      database.close();
      throw timeoutError(configPath, lockTimeoutMs);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(retryDelayMs, remaining));
    });
  }

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) {
        throw new HarnessError(
          "CONFIG_LOCK_RELEASED",
          `Configuration lock was already released for ${lockPathFor(configPath)}`,
        );
      }
      released = true;
      let rollbackError: unknown;
      try {
        database.exec("ROLLBACK");
      } catch (error) {
        rollbackError = error;
      }
      try {
        database.close();
      } catch (closeError) {
        if (rollbackError !== undefined) {
          throw new AggregateError(
            [rollbackError, closeError],
            `Configuration lock rollback and close both failed for ${configPath}`,
          );
        }
        throw closeError;
      }
      if (rollbackError !== undefined) throw rollbackError;
    },
  };
}

async function withConfigLease<T>(
  configPath: string,
  options: ConfigUpdateOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const lease = await acquireConfigLease(configPath, options);
  let result: T | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let releaseFailed = false;
  let releaseError: unknown;
  try {
    await lease.release();
  } catch (error) {
    releaseFailed = true;
    releaseError = error;
  }

  if (operationFailed) {
    if (releaseFailed) {
      throw new AggregateError(
        [operationError, releaseError],
        `Configuration update and lock release both failed for ${configPath}`,
      );
    }
    throw operationError;
  }
  if (releaseFailed) throw releaseError;
  return result as T;
}

async function removeStaleTemporaryFiles(path: string): Promise<void> {
  const directory = dirname(path);
  const prefix = `${basename(path)}.`;
  let removed = false;
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix) || !TEMPORARY_NAME.test(name.slice(prefix.length))) continue;
    await unlink(join(directory, name)).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
    removed = true;
  }
  if (removed) await syncDirectory(directory);
}

async function writeConfig(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let committed = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(source, "utf8");
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    committed = true;
    try {
      await syncDirectory(dirname(path));
    } catch (error) {
      throw new HarnessError(
        "CONFIG_DURABILITY",
        `Configuration was replaced at ${path}, but its directory could not be synchronized`,
        { cause: error },
      );
    }
  } finally {
    if (!committed) await unlink(temporary).catch(() => undefined);
  }
}

async function configSource(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "{}\n";
    throw error;
  }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function updateJsoncSource(path: string, source: string, nextValue: JsonObject): string {
  const serialized = JSON.stringify(nextValue);
  if (typeof serialized !== "string") throw new TypeError("Configuration update must return a JSON object");
  const next = parseJsoncObject(serialized, path);
  const existing = parseJsoncObject(source, path);
  const keys = [...new Set([...Object.keys(existing), ...Object.keys(next)])];
  const formattingOptions = {
    insertSpaces: true,
    tabSize: 2,
    eol: source.includes("\r\n") ? "\r\n" : "\n",
  };
  let updated = source;
  for (const key of keys) {
    if (Object.hasOwn(next, key) && Object.hasOwn(existing, key) && sameJsonValue(existing[key], next[key])) continue;
    updated = applyEdits(updated, modify(
      updated,
      [key],
      Object.hasOwn(next, key) ? next[key] : undefined,
      { formattingOptions },
    ));
  }
  return updated.endsWith("\n") ? updated : `${updated}\n`;
}

export async function updateGlobalConfig(
  path: string,
  update: ConfigUpdater,
  options: ConfigUpdateOptions = {},
): Promise<void> {
  await withConfigLease(path, options, async () => {
    await removeStaleTemporaryFiles(path);
    const source = await configSource(path);
    const existing = parseJsoncObject(source, path);
    const next = await update(existing);
    await writeConfig(path, updateJsoncSource(path, source, next));
  });
}

export async function persistDefaultSelection(
  paths: HarnessPaths,
  selection: { provider: string; model: string },
): Promise<void> {
  await updateGlobalConfig(paths.globalConfig, (existing) => ({
    ...existing,
    defaultProvider: selection.provider,
    defaultModel: selection.model,
  }));
}

export async function persistUiTheme(paths: HarnessPaths, theme: string): Promise<void> {
  await updateGlobalConfig(paths.globalConfig, (existing) => ({ ...existing, theme }));
}

export async function persistUiPreferences(paths: HarnessPaths, value: JsonObject): Promise<void> {
  await updateGlobalConfig(paths.globalConfig, (existing) => ({ ...existing, ...value }));
}
