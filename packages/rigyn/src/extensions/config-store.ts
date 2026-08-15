import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { JsonValue } from "../core/json.js";
import { withFileLock } from "../storage/file-lock.js";

const CONFIG_FILE = "config.json";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 256;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NON_BLOCKING = constants.O_NONBLOCK ?? 0;

export type ExtensionConfigScope = "user" | "workspace";

export interface ExtensionConfigDataRoots {
  readonly user: string;
  readonly workspace: string;
}

export interface ExtensionConfigSnapshot {
  readonly revision: string | null;
  readonly value: JsonValue | undefined;
}

export interface ExtensionConfigReadOptions {
  readonly signal?: AbortSignal;
}

export interface ExtensionConfigWriteOptions extends ExtensionConfigReadOptions {
  readonly expectedRevision: string | null;
}

export interface ExtensionConfigStore {
  read(
    scope: ExtensionConfigScope,
    options?: ExtensionConfigReadOptions,
  ): Promise<ExtensionConfigSnapshot>;
  replace(
    scope: ExtensionConfigScope,
    value: JsonValue,
    options: ExtensionConfigWriteOptions,
  ): Promise<ExtensionConfigSnapshot>;
  remove(
    scope: ExtensionConfigScope,
    options: ExtensionConfigWriteOptions,
  ): Promise<ExtensionConfigSnapshot>;
}

export interface ExtensionConfigStoreOptions {
  /** Existing canonical, private directories owned by exactly one extension. */
  readonly roots: ExtensionConfigDataRoots;
  /** Rechecked inside the file lock so staged or stale generations cannot mutate through this store. */
  readonly writable: () => boolean;
  /** Generation lifetime. A caller signal is combined with this signal for each operation. */
  readonly signal?: AbortSignal;
}

export class ExtensionConfigConflictError extends Error {
  readonly expectedRevision: string | null;
  readonly currentRevision: string | null;

  constructor(expectedRevision: string | null, currentRevision: string | null) {
    super("Extension configuration changed since it was read");
    this.name = "ExtensionConfigConflictError";
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly path: string;
}

interface StoredDocument {
  readonly revision: string;
  readonly value: JsonValue;
}

const ABSENT_SNAPSHOT: ExtensionConfigSnapshot = Object.freeze({
  revision: null,
  value: undefined,
});

function errno(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function operationSignal(owner: AbortSignal | undefined, caller: AbortSignal | undefined): AbortSignal | undefined {
  if (owner === undefined) return caller;
  if (caller === undefined || caller === owner) return owner;
  return AbortSignal.any([owner, caller]);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function rootPath(value: string, scope: ExtensionConfigScope): string {
  if (typeof value !== "string" || value === "" || value.includes("\0") || !isAbsolute(value)) {
    throw new TypeError(`Extension ${scope} config root must be an absolute path`);
  }
  return resolve(value);
}

function selectedRoot(
  roots: ExtensionConfigDataRoots,
  scope: ExtensionConfigScope,
): string {
  if (scope === "user") return roots.user;
  if (scope === "workspace") return roots.workspace;
  throw new TypeError("Extension config scope must be user or workspace");
}

async function directoryIdentity(root: string): Promise<DirectoryIdentity> {
  const information = await lstat(root);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`Extension config root is not a canonical directory: ${root}`);
  }
  const canonical = await realpath(root);
  if (canonical !== root) throw new Error(`Extension config root is not canonical: ${root}`);
  if (process.platform !== "win32" && (information.mode & 0o077) !== 0) {
    throw new Error(`Extension config root is not private: ${root}`);
  }
  return { dev: information.dev, ino: information.ino, path: root };
}

async function assertSameDirectory(expected: DirectoryIdentity): Promise<void> {
  const current = await directoryIdentity(expected.path);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`Extension config root changed during an operation: ${expected.path}`);
  }
}

function revision(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertExpectedRevision(value: string | null): void {
  if (value !== null && !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("Extension config expectedRevision must be null or a SHA-256 revision");
  }
}

function assertJsonValue(root: unknown): asserts root is JsonValue {
  type Frame = { readonly value: unknown; readonly depth: number; readonly exit?: boolean };
  const active = new WeakSet<object>();
  const stack: Frame[] = [{ value: root, depth: 0 }];
  let minimumBytes = 0;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const value = frame.value;
    if (frame.exit) {
      active.delete(value as object);
      continue;
    }
    if (value === null || typeof value === "boolean") {
      minimumBytes += value === null ? 4 : value ? 4 : 5;
      continue;
    }
    if (typeof value === "string") {
      minimumBytes += Buffer.byteLength(value, "utf8") + 2;
      if (minimumBytes > MAX_CONFIG_BYTES) throw new RangeError(`Extension config exceeds ${MAX_CONFIG_BYTES.toLocaleString()} bytes`);
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("Extension config must be a JSON value");
      minimumBytes += 1;
      continue;
    }
    if (typeof value !== "object" || frame.depth >= MAX_JSON_DEPTH) {
      throw new TypeError("Extension config must be a bounded JSON value");
    }
    if (active.has(value)) throw new TypeError("Extension config must be an acyclic JSON value");
    active.add(value);
    stack.push({ value, depth: frame.depth, exit: true });

    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== value.length + 1
        || !keys.includes("length")
        || value.some((_entry, index) => !Object.hasOwn(value, index))
      ) throw new TypeError("Extension config must be a JSON value without sparse or extra array properties");
      minimumBytes += 2 + Math.max(0, value.length - 1);
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], depth: frame.depth + 1 });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Extension config must be a JSON value with plain objects");
    }
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError("Extension config must not contain symbol keys");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("Extension config must contain only enumerable data properties");
      }
      minimumBytes += Buffer.byteLength(key, "utf8") + 3;
      stack.push({ value: descriptor.value, depth: frame.depth + 1 });
    }
    minimumBytes += 2 + Math.max(0, keys.length - 1);
    if (minimumBytes > MAX_CONFIG_BYTES) throw new RangeError(`Extension config exceeds ${MAX_CONFIG_BYTES.toLocaleString()} bytes`);
  }
}

function deepFreeze(value: JsonValue): JsonValue {
  const stack: JsonValue[] = [value];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current !== null && typeof current === "object" && !Object.isFrozen(current)) {
      Object.freeze(current);
      for (const child of Object.values(current)) stack.push(child);
    }
  }
  return value;
}

function encode(value: JsonValue): { readonly bytes: Buffer; readonly value: JsonValue } {
  assertJsonValue(value);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_CONFIG_BYTES) {
    throw new RangeError(`Extension config exceeds ${MAX_CONFIG_BYTES.toLocaleString()} bytes`);
  }
  const cloned = JSON.parse(bytes.toString("utf8")) as JsonValue;
  return { bytes, value: deepFreeze(cloned) };
}

async function readBounded(path: string, root: DirectoryIdentity): Promise<StoredDocument | undefined> {
  let initial;
  try {
    initial = await lstat(path);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
    await assertSameDirectory(root);
    return undefined;
  }
  if (initial.isSymbolicLink()) throw new Error(`Extension config file is a symbolic link: ${path}`);
  if (!initial.isFile()) throw new Error(`Extension config path is not a regular file: ${path}`);
  if (initial.size > MAX_CONFIG_BYTES) {
    throw new RangeError(`Extension config exceeds ${MAX_CONFIG_BYTES.toLocaleString()} bytes`);
  }

  const descriptor = await open(path, constants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
  try {
    const opened = await descriptor.stat();
    if (
      !opened.isFile()
      || opened.dev !== initial.dev
      || opened.ino !== initial.ino
      || opened.size > MAX_CONFIG_BYTES
    ) throw new Error(`Extension config file changed while opening: ${path}`);

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_CONFIG_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, MAX_CONFIG_BYTES + 1 - total));
      const result = await descriptor.read(chunk, 0, chunk.byteLength, null);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      if (total > MAX_CONFIG_BYTES) {
        throw new RangeError(`Extension config exceeds ${MAX_CONFIG_BYTES.toLocaleString()} bytes`);
      }
      chunks.push(chunk.subarray(0, result.bytesRead));
    }

    const [openedAfter, current] = await Promise.all([descriptor.stat(), lstat(path)]);
    if (
      current.isSymbolicLink()
      || !current.isFile()
      || current.dev !== opened.dev
      || current.ino !== opened.ino
      || current.size !== openedAfter.size
      || opened.size !== openedAfter.size
      || opened.mtimeMs !== openedAfter.mtimeMs
      || opened.ctimeMs !== openedAfter.ctimeMs
    ) throw new Error(`Extension config file changed while reading: ${path}`);
    await assertSameDirectory(root);

    const bytes = Buffer.concat(chunks, total);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw new Error(`Extension config contains invalid JSON: ${path}`, { cause: error });
    }
    assertJsonValue(parsed);
    return { revision: revision(bytes), value: deepFreeze(parsed) };
  } finally {
    await descriptor.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  let descriptor;
  try {
    descriptor = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    await descriptor.sync();
  } catch (error) {
    if (process.platform !== "win32" || !["EISDIR", "EINVAL", "EPERM"].includes(errno(error) ?? "")) throw error;
  } finally {
    await descriptor?.close();
  }
}

function snapshot(document: StoredDocument | undefined): ExtensionConfigSnapshot {
  return document === undefined
    ? ABSENT_SNAPSHOT
    : Object.freeze({ revision: document.revision, value: document.value });
}

function assertRevision(
  expectedRevision: string | null,
  document: StoredDocument | undefined,
): void {
  const currentRevision = document?.revision ?? null;
  if (expectedRevision !== currentRevision) {
    throw new ExtensionConfigConflictError(expectedRevision, currentRevision);
  }
}

/**
 * Creates a bounded CAS store inside two pre-created, host-owned extension data roots.
 * The store never logs or interprets configuration values.
 */
export function createExtensionConfigStore(options: ExtensionConfigStoreOptions): ExtensionConfigStore {
  if (options === null || typeof options !== "object") throw new TypeError("Extension config store options are required");
  if (typeof options.writable !== "function") throw new TypeError("Extension config writable check is required");
  const roots = Object.freeze({
    user: rootPath(options.roots?.user, "user"),
    workspace: rootPath(options.roots?.workspace, "workspace"),
  });
  if (roots.user === roots.workspace) throw new Error("Extension user and workspace config roots must be distinct");

  const pathFor = (scope: ExtensionConfigScope): { readonly path: string; readonly root: string } => {
    const root = selectedRoot(roots, scope);
    return { path: join(root, CONFIG_FILE), root };
  };
  const signalFor = (signal: AbortSignal | undefined): AbortSignal | undefined =>
    operationSignal(options.signal, signal);
  const requireWritable = (): void => {
    if (!options.writable()) throw new Error("Extension configuration is not writable by this generation");
  };

  const read = async (
    scope: ExtensionConfigScope,
    readOptions: ExtensionConfigReadOptions = {},
  ): Promise<ExtensionConfigSnapshot> => {
    const signal = signalFor(readOptions.signal);
    throwIfAborted(signal);
    const selected = pathFor(scope);
    const root = await directoryIdentity(selected.root);
    throwIfAborted(signal);
    const document = await readBounded(selected.path, root);
    throwIfAborted(signal);
    return snapshot(document);
  };

  const replace = async (
    scope: ExtensionConfigScope,
    value: JsonValue,
    writeOptions: ExtensionConfigWriteOptions,
  ): Promise<ExtensionConfigSnapshot> => {
    assertExpectedRevision(writeOptions?.expectedRevision);
    const signal = signalFor(writeOptions.signal);
    throwIfAborted(signal);
    requireWritable();
    const encoded = encode(value);
    const selected = pathFor(scope);
    return await withFileLock(selected.path, async () => {
      throwIfAborted(signal);
      requireWritable();
      const root = await directoryIdentity(selected.root);
      const current = await readBounded(selected.path, root);
      assertRevision(writeOptions.expectedRevision, current);
      const temporary = join(
        selected.root,
        `.${CONFIG_FILE}.${randomBytes(12).toString("hex")}.tmp`,
      );
      let descriptor;
      try {
        descriptor = await open(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
          0o600,
        );
        await descriptor.writeFile(encoded.bytes);
        await descriptor.chmod(0o600);
        await descriptor.sync();
        await descriptor.close();
        descriptor = undefined;
        throwIfAborted(signal);
        requireWritable();
        await assertSameDirectory(root);
        assertRevision(writeOptions.expectedRevision, await readBounded(selected.path, root));
        throwIfAborted(signal);
        requireWritable();
        await rename(temporary, selected.path);
        await syncDirectory(selected.root);
        return snapshot({ revision: revision(encoded.bytes), value: encoded.value });
      } finally {
        await descriptor?.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
      }
    }, signal);
  };

  const remove = async (
    scope: ExtensionConfigScope,
    writeOptions: ExtensionConfigWriteOptions,
  ): Promise<ExtensionConfigSnapshot> => {
    assertExpectedRevision(writeOptions?.expectedRevision);
    const signal = signalFor(writeOptions.signal);
    throwIfAborted(signal);
    requireWritable();
    const selected = pathFor(scope);
    return await withFileLock(selected.path, async () => {
      throwIfAborted(signal);
      requireWritable();
      const root = await directoryIdentity(selected.root);
      const current = await readBounded(selected.path, root);
      assertRevision(writeOptions.expectedRevision, current);
      if (current === undefined) return ABSENT_SNAPSHOT;
      throwIfAborted(signal);
      requireWritable();
      await assertSameDirectory(root);
      assertRevision(writeOptions.expectedRevision, await readBounded(selected.path, root));
      throwIfAborted(signal);
      requireWritable();
      try {
        await unlink(selected.path);
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
        throw new ExtensionConfigConflictError(writeOptions.expectedRevision, null);
      }
      await syncDirectory(selected.root);
      return ABSENT_SNAPSHOT;
    }, signal);
  };

  return Object.freeze({ read, remove, replace });
}
