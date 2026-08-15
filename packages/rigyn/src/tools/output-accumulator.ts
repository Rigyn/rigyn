import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  createWriteStream,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { TOOL_MAX_BYTES, TOOL_MAX_LINES, truncateToolTail, type ToolTruncation } from "./truncate.js";

export interface ToolOutputSnapshot {
  content: string;
  truncation: ToolTruncation;
  fullOutputPath?: string;
  fullOutputTruncated?: boolean;
  fullOutputUnavailable?: boolean;
}

const OUTPUT_DIRECTORY_MODE = 0o700;
const OUTPUT_FILE_MODE = 0o600;
const OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const OUTPUT_RETENTION_FILES = 128;
const OUTPUT_RETENTION_BYTES = 512 * 1_024 * 1_024;
const OUTPUT_FILE_MAX_BYTES = 64 * 1_024 * 1_024;
const OUTPUT_NAME = /^rigyn-[A-Za-z0-9._-]{1,64}-[a-f0-9]{16}\.log$/u;
const ACTIVE_NAME = /^\.rigyn-active-([1-9][0-9]*)-([1-9][0-9]*)-([a-f0-9]{32})-(rigyn-[A-Za-z0-9._-]{1,64}-[a-f0-9]{16}\.log)\.part$/u;
const LOCK_DIRECTORY_NAME = ".rigyn-retention.lock";
const STAGED_LOCK_NAME = /^\.rigyn-retention-owner-([1-9][0-9]*)-([a-f0-9]{32})\.tmp$/u;
const LOCK_RETRIES = 10;
const LOCK_WAIT_MS = 2;

interface ActiveEntry {
  path: string;
  reservedBytes: number;
  pid: number;
}

interface ClosedEntry {
  path: string;
  bytes: number;
  modifiedAt: number;
}

interface RetentionState {
  active: ActiveEntry[];
  closed: ClosedEntry[];
}

interface LockOwner {
  pid: number;
  token: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface RetentionLock {
  path: string;
  identity: FileIdentity;
  ownerContents: string;
}

export interface ToolOutputRetentionOptions {
  directory?: string;
  maxAgeMs?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  now?: number;
}

export interface ToolOutputCleanupResult {
  removedFiles: number;
  removedBytes: number;
  retainedFiles: number;
  retainedBytes: number;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function selectedOutputBase(): { path: string; installed: boolean } {
  const installRoot = process.env.RIGYN_INSTALL_DIR;
  return installRoot === undefined || installRoot === ""
    ? { path: tmpdir(), installed: false }
    : { path: join(resolve(installRoot), "tmp"), installed: true };
}

function defaultOutputDirectory(): string {
  const identity = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(selectedOutputBase().path, `rigyn-tool-output-${identity}`);
}

function ensureTrustedInstalledOutputBase(directory: string): {
  installRoot: string;
  installRootIdentity: FileIdentity;
  temporaryDirectory: string;
  temporaryDirectoryIdentity: FileIdentity;
} | undefined {
  const base = selectedOutputBase();
  if (!base.installed || resolve(directory) !== resolve(defaultOutputDirectory())) return undefined;
  const installRoot = resolve(base.path, "..");
  const installRootMetadata = lstatSync(installRoot);
  if (!installRootMetadata.isDirectory() || installRootMetadata.isSymbolicLink()) {
    throw new Error(`Tool output installation path must be a real directory: ${installRoot}`);
  }
  if (typeof process.getuid === "function" && installRootMetadata.uid !== process.getuid()) {
    throw new Error(`Tool output installation path is not owned by the current user: ${installRoot}`);
  }
  if (process.platform !== "win32" && (installRootMetadata.mode & 0o077) !== 0) {
    throw new Error(`Tool output installation path is not private: ${installRoot}`);
  }
  try {
    mkdirSync(base.path, { mode: OUTPUT_DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  for (const [path, label] of [[base.path, "installation tmp"]] as const) {
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Tool output ${label} path must be a real directory: ${path}`);
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error(`Tool output ${label} path is not owned by the current user: ${path}`);
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error(`Tool output ${label} path is not private: ${path}`);
    }
  }
  const installRootIdentity = pathIdentity(installRoot);
  const temporaryDirectoryIdentity = pathIdentity(base.path);
  if (installRootIdentity === undefined || temporaryDirectoryIdentity === undefined) {
    throw new Error("Tool output installation path changed during validation");
  }
  return {
    installRoot,
    installRootIdentity,
    temporaryDirectory: base.path,
    temporaryDirectoryIdentity,
  };
}

function ensurePrivateDirectory(directory: string): void {
  const installedBase = ensureTrustedInstalledOutputBase(directory);
  mkdirSync(directory, { recursive: true, mode: OUTPUT_DIRECTORY_MODE });
  if (installedBase !== undefined && (
    !sameIdentity(pathIdentity(installedBase.installRoot), installedBase.installRootIdentity)
    || !sameIdentity(pathIdentity(installedBase.temporaryDirectory), installedBase.temporaryDirectoryIdentity)
  )) throw new Error("Tool output installation path changed during directory creation");
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Tool output path must be a real directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`Tool output directory is not owned by the current user: ${directory}`);
  }
  if (process.platform !== "win32") chmodSync(directory, OUTPUT_DIRECTORY_MODE);
}

function processState(pid: number): "alive" | "dead" | "indeterminate" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" || code === "ERR_OUT_OF_RANGE" ? "dead" : "indeterminate";
  }
}

function sleep(milliseconds: number): void {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, milliseconds);
}

function pathIdentity(path: string): FileIdentity | undefined {
  try {
    const metadata = lstatSync(path, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
    return { dev: metadata.dev, ino: metadata.ino };
  } catch {
    return undefined;
  }
}

function sameIdentity(left: FileIdentity | undefined, right: FileIdentity): boolean {
  return left !== undefined && left.dev === right.dev && left.ino === right.ino;
}

function regularFileIdentity(path: string): FileIdentity | undefined {
  try {
    const metadata = lstatSync(path, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    return { dev: metadata.dev, ino: metadata.ino };
  } catch {
    return undefined;
  }
}

function lockOwner(path: string): LockOwner | undefined {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_024) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>;
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "pid,token"
      || !Number.isSafeInteger(value.pid) || (value.pid as number) < 1
      || !/^[a-f0-9]{32}$/u.test(value.token ?? "")) {
      return undefined;
    }
    return { pid: value.pid as number, token: value.token as string };
  } catch {
    return undefined;
  }
}

function installLock(directory: string, token: string): RetentionLock | undefined {
  const lockPath = join(directory, LOCK_DIRECTORY_NAME);
  const ownerPath = join(directory, `.rigyn-retention-owner-${process.pid}-${token}.tmp`);
  const ownerContents = `${JSON.stringify({ pid: process.pid, token })}\n`;
  let ownerIdentity: FileIdentity | undefined;
  let installed = false;
  try {
    writeFileSync(ownerPath, ownerContents, {
      encoding: "utf8",
      flag: "wx",
      mode: OUTPUT_FILE_MODE,
    });
    ownerIdentity = regularFileIdentity(ownerPath);
    if (ownerIdentity === undefined
      || readFileSync(ownerPath, "utf8") !== ownerContents) {
      throw new Error("Tool output retention owner changed during acquisition");
    }
    try {
      linkSync(ownerPath, lockPath);
      installed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!sameIdentity(regularFileIdentity(ownerPath), ownerIdentity)
        || readFileSync(ownerPath, "utf8") !== ownerContents) {
        throw new Error("Tool output retention owner changed during contention");
      }
      unlinkSync(ownerPath);
      return undefined;
    }
    if (!sameIdentity(regularFileIdentity(lockPath), ownerIdentity)
      || readFileSync(lockPath, "utf8") !== ownerContents
      || !sameIdentity(regularFileIdentity(ownerPath), ownerIdentity)) {
      throw new Error("Tool output retention lock changed during acquisition");
    }
    unlinkSync(ownerPath);
    return { path: lockPath, identity: ownerIdentity, ownerContents };
  } catch (error) {
    if (installed && ownerIdentity !== undefined
      && sameIdentity(regularFileIdentity(lockPath), ownerIdentity)) {
      try {
        if (readFileSync(lockPath, "utf8") === ownerContents) unlinkSync(lockPath);
      } catch {}
    }
    if (ownerIdentity !== undefined && sameIdentity(regularFileIdentity(ownerPath), ownerIdentity)) {
      try {
        if (readFileSync(ownerPath, "utf8") === ownerContents) unlinkSync(ownerPath);
      } catch {}
    }
    throw error;
  }
}

function releaseLock(lock: RetentionLock): void {
  if (!sameIdentity(regularFileIdentity(lock.path), lock.identity)
    || readFileSync(lock.path, "utf8") !== lock.ownerContents) {
    throw new Error("Tool output retention lock ownership changed");
  }
  unlinkSync(lock.path);
}

function removeDeadLockInPlace(directory: string): boolean {
  const lockPath = join(directory, LOCK_DIRECTORY_NAME);
  const identity = regularFileIdentity(lockPath);
  let ownerContents: string;
  try {
    ownerContents = readFileSync(lockPath, "utf8");
  } catch {
    return false;
  }
  const owner = lockOwner(lockPath);
  if (identity === undefined || owner === undefined || processState(owner.pid) !== "dead") {
    return false;
  }
  if (!sameIdentity(regularFileIdentity(lockPath), identity)
    || readFileSync(lockPath, "utf8") !== ownerContents) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/** Runs opportunistic cleanup without allowing spill retention state to fail a session lifecycle. */
export function pruneToolOutputFilesBestEffort(options: ToolOutputRetentionOptions = {}): void {
  try {
    pruneToolOutputFiles(options);
  } catch {
    // Retention admission remains fail closed when a command later needs an artifact.
  }
}

function acquireLock(directory: string, retries = LOCK_RETRIES): RetentionLock {
  const token = randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const installed = installLock(directory, token);
    if (installed !== undefined) return installed;
    if (removeDeadLockInPlace(directory)) {
      const recovered = installLock(directory, token);
      if (recovered !== undefined) return recovered;
    }
    sleep(LOCK_WAIT_MS);
  }
  throw new Error("Timed out acquiring tool output retention lock");
}

function withRetentionLock<T>(directory: string, operation: () => T, retries = LOCK_RETRIES): T {
  ensurePrivateDirectory(directory);
  const lock = acquireLock(directory, retries);
  let failed = false;
  let failure: unknown;
  let result!: T;
  try {
    result = operation();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    releaseLock(lock);
  } catch (releaseError) {
    if (failed) throw new AggregateError([failure, releaseError], "Tool output operation and lock release failed");
    throw releaseError;
  }
  if (failed) throw failure;
  return result;
}

function retentionState(directory: string, reapDead: boolean): RetentionState {
  const active: ActiveEntry[] = [];
  const closed: ClosedEntry[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stagedLock = STAGED_LOCK_NAME.exec(name);
    if (stagedLock !== null) {
      const identity = regularFileIdentity(path);
      const pid = Number(stagedLock[1]);
      if (reapDead && identity !== undefined
        && processState(pid) === "dead"
        && sameIdentity(regularFileIdentity(path), identity)) {
        try {
          unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      continue;
    }
    if (OUTPUT_NAME.test(name)) {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) continue;
      closed.push({ path, bytes: metadata.size, modifiedAt: metadata.mtimeMs });
      continue;
    }
    const match = ACTIVE_NAME.exec(name);
    if (match === null) continue;
    const metadata = lstatSync(path, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    if (typeof process.getuid === "function" && metadata.uid !== BigInt(process.getuid())) continue;
    const identity = { dev: metadata.dev, ino: metadata.ino };
    const pid = Number(match[1]);
    const reservedBytes = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(reservedBytes) || reservedBytes > OUTPUT_FILE_MAX_BYTES) continue;
    if (reapDead && processState(pid) === "dead" && sameIdentity(regularFileIdentity(path), identity)) {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      continue;
    }
    active.push({ path, reservedBytes, pid });
  }
  closed.sort((left, right) => left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path));
  return { active, closed };
}

function pruneLocked(
  directory: string,
  options: Required<Pick<ToolOutputRetentionOptions, "maxAgeMs" | "maxFiles" | "maxTotalBytes" | "now">>,
): ToolOutputCleanupResult {
  const state = retentionState(directory, true);
  const activeBytes = state.active.reduce((total, entry) => total + entry.reservedBytes, 0);
  let retainedBytes = activeBytes + state.closed.reduce((total, entry) => total + entry.bytes, 0);
  let retainedFiles = state.active.length + state.closed.length;
  let removedBytes = 0;
  let removedFiles = 0;
  for (const entry of state.closed) {
    const expired = options.now - entry.modifiedAt > options.maxAgeMs;
    if (!expired && retainedFiles <= options.maxFiles && retainedBytes <= options.maxTotalBytes) continue;
    try {
      unlinkSync(entry.path);
      retainedFiles -= 1;
      retainedBytes -= entry.bytes;
      removedFiles += 1;
      removedBytes += entry.bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { removedFiles, removedBytes, retainedFiles, retainedBytes };
}

/** Removes expired or excess closed command-output files without following links. */
export function pruneToolOutputFiles(options: ToolOutputRetentionOptions = {}): ToolOutputCleanupResult {
  const directory = options.directory ?? defaultOutputDirectory();
  const maxAgeMs = positiveInteger(options.maxAgeMs ?? OUTPUT_RETENTION_MS, "maxAgeMs");
  const maxFiles = positiveInteger(options.maxFiles ?? OUTPUT_RETENTION_FILES, "maxFiles");
  const maxTotalBytes = positiveInteger(options.maxTotalBytes ?? OUTPUT_RETENTION_BYTES, "maxTotalBytes");
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) throw new RangeError("now must be a non-negative finite timestamp");
  return withRetentionLock(directory, () => pruneLocked(directory, { maxAgeMs, maxFiles, maxTotalBytes, now }), 1);
}

/** Retains a bounded decoded tail and spills complete command output to disk when admitted. */
export class ToolOutputAccumulator {
  readonly #decoder = new TextDecoder();
  readonly #maxBytes: number;
  readonly #maxLines: number;
  readonly #prefix: string;
  readonly #directory: string;
  readonly #maxPersistedBytes: number;
  #raw: Buffer[] = [];
  #stream: WriteStream | undefined;
  #streamCompletion: Promise<Error | undefined> | undefined;
  #streamFailure: Error | undefined;
  #activePath: string | undefined;
  #activeIdentity: FileIdentity | undefined;
  #publishedPath: string | undefined;
  #tail = "";
  #decodedBytes = 0;
  #rawBytes = 0;
  #completedLines = 0;
  #openLine = false;
  #lastLineBytes = 0;
  #persistedBytes = 0;
  #fullOutputTruncated = false;
  #fullOutputUnavailable = false;
  #storageUnavailable = false;
  #finished = false;

  constructor(options: {
    maxBytes?: number;
    maxLines?: number;
    prefix?: string;
    directory?: string;
    maxPersistedBytes?: number;
  } = {}) {
    this.#maxBytes = options.maxBytes ?? TOOL_MAX_BYTES;
    this.#maxLines = options.maxLines ?? TOOL_MAX_LINES;
    this.#prefix = options.prefix ?? "rigyn-bash";
    if (!/^rigyn-[A-Za-z0-9._-]{1,58}$/u.test(this.#prefix)) throw new Error("Tool output prefix is invalid");
    this.#directory = options.directory ?? defaultOutputDirectory();
    this.#maxPersistedBytes = positiveInteger(options.maxPersistedBytes ?? OUTPUT_FILE_MAX_BYTES, "maxPersistedBytes");
    if (this.#maxPersistedBytes > OUTPUT_FILE_MAX_BYTES) {
      throw new RangeError(`maxPersistedBytes must not exceed ${OUTPUT_FILE_MAX_BYTES} bytes`);
    }
    try {
      ensurePrivateDirectory(this.#directory);
      pruneToolOutputFilesBestEffort({ directory: this.#directory });
    } catch {
      this.#storageUnavailable = true;
    }
  }

  append(value: Uint8Array): void {
    if (this.#finished) return;
    const chunk = Buffer.from(value);
    this.#rawBytes += chunk.byteLength;
    this.#appendText(this.#decoder.decode(chunk, { stream: true }));
    if (this.#stream !== undefined) this.#writePersisted(chunk);
    else if (!this.#fullOutputUnavailable) this.#raw.push(chunk);
    if (this.#shouldPersist()) this.#ensureFile();
  }

  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#appendText(this.#decoder.decode());
    if (this.#shouldPersist()) this.#ensureFile();
  }

  snapshot(persist = false): ToolOutputSnapshot {
    const tail = truncateToolTail(this.#tail, { maxBytes: this.#maxBytes, maxLines: this.#maxLines });
    const totalLines = this.#completedLines + (this.#openLine ? 1 : 0);
    const truncated = totalLines > this.#maxLines || this.#decodedBytes > this.#maxBytes;
    const truncation: ToolTruncation = {
      ...tail,
      truncated,
      truncatedBy: truncated
        ? (tail.truncatedBy ?? (this.#decodedBytes > this.#maxBytes ? "bytes" : "lines"))
        : null,
      totalLines,
      totalBytes: this.#decodedBytes,
      maxLines: this.#maxLines,
      maxBytes: this.#maxBytes,
    };
    if (persist && truncated) this.#ensureFile();
    return {
      content: truncation.content,
      truncation,
      ...(this.#publishedPath === undefined ? {} : { fullOutputPath: this.#publishedPath }),
      ...(this.#fullOutputTruncated ? { fullOutputTruncated: true } : {}),
      ...(this.#fullOutputUnavailable ? { fullOutputUnavailable: true } : {}),
    };
  }

  lastLineBytes(): number {
    return this.#lastLineBytes;
  }

  async close(): Promise<void> {
    const stream = this.#stream;
    if (stream === undefined) {
      pruneToolOutputFilesBestEffort({ directory: this.#directory });
      return;
    }
    const completion = this.#streamCompletion;
    this.#stream = undefined;
    this.#streamCompletion = undefined;
    if (!stream.destroyed && !stream.writableEnded) stream.end();
    const failure = (await completion) ?? this.#streamFailure;
    if (failure !== undefined) {
      this.#removeOwnedActive();
      this.#fullOutputUnavailable = true;
      this.#fullOutputTruncated = true;
      return;
    }
    const activePath = this.#activePath;
    const activeIdentity = this.#activeIdentity;
    if (activePath === undefined || activeIdentity === undefined) throw new Error("Tool output active path was lost");
    try {
      withRetentionLock(this.#directory, () => {
        const match = ACTIVE_NAME.exec(activePath.slice(this.#directory.length + 1));
        if (match === null || Number(match[1]) !== process.pid
          || !sameIdentity(this.#regularFileIdentity(activePath), activeIdentity)) {
          throw new Error("Tool output active file changed before publication");
        }
        const publishedPath = join(this.#directory, match[4]!);
        let linked = false;
        try {
          linkSync(activePath, publishedPath);
          linked = true;
          if (!sameIdentity(this.#regularFileIdentity(publishedPath), activeIdentity)) {
            throw new Error("Tool output publication identity changed");
          }
          const publishedAt = new Date();
          utimesSync(publishedPath, publishedAt, publishedAt);
          unlinkSync(activePath);
        } catch (error) {
          if (linked && sameIdentity(this.#regularFileIdentity(publishedPath), activeIdentity)) {
            try { unlinkSync(publishedPath); } catch {}
          }
          throw error;
        }
        this.#publishedPath = publishedPath;
        this.#activePath = undefined;
        this.#activeIdentity = undefined;
        try {
          pruneLocked(this.#directory, {
            maxAgeMs: OUTPUT_RETENTION_MS,
            maxFiles: OUTPUT_RETENTION_FILES,
            maxTotalBytes: OUTPUT_RETENTION_BYTES,
            now: Date.now(),
          });
        } catch {
          // Post-publication cleanup is opportunistic.
        }
      });
    } catch {
      if (this.#publishedPath === undefined) {
        this.#removeOwnedActive();
        this.#fullOutputUnavailable = true;
        this.#fullOutputTruncated = true;
      }
    }
  }

  #appendText(value: string): void {
    if (value === "") return;
    const bytes = Buffer.byteLength(value, "utf8");
    this.#decodedBytes += bytes;
    this.#tail += value;
    const lastNewline = value.lastIndexOf("\n");
    if (lastNewline < 0) {
      if (!this.#openLine) this.#lastLineBytes = 0;
      this.#lastLineBytes += bytes;
      this.#openLine = true;
    } else {
      const previousOpenLine = this.#openLine;
      const previousLineBytes = this.#lastLineBytes;
      this.#completedLines += value.split("\n").length - 1;
      const remainder = value.slice(lastNewline + 1);
      this.#openLine = remainder !== "";
      if (this.#openLine) {
        this.#lastLineBytes = Buffer.byteLength(remainder, "utf8");
      } else {
        const previousNewline = lastNewline === 0 ? -1 : value.lastIndexOf("\n", lastNewline - 1);
        this.#lastLineBytes = Buffer.byteLength(value.slice(previousNewline + 1, lastNewline), "utf8")
          + (previousNewline < 0 && previousOpenLine ? previousLineBytes : 0);
      }
    }
    const rollingBytes = this.#maxBytes * 2;
    const encoded = Buffer.from(this.#tail, "utf8");
    if (encoded.byteLength > rollingBytes * 2) {
      let start = encoded.byteLength - rollingBytes;
      while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1;
      const selected = encoded.subarray(start).toString("utf8");
      const firstNewline = selected.indexOf("\n");
      this.#tail = firstNewline < 0 ? selected : selected.slice(firstNewline + 1);
    }
  }

  #shouldPersist(): boolean {
    return this.#rawBytes > this.#maxBytes || this.#decodedBytes > this.#maxBytes ||
      this.#completedLines + (this.#openLine ? 1 : 0) > this.#maxLines;
  }

  #ensureFile(): void {
    if (this.#activePath !== undefined || this.#publishedPath !== undefined || this.#fullOutputUnavailable) return;
    if (this.#storageUnavailable) {
      this.#fullOutputUnavailable = true;
      this.#fullOutputTruncated = true;
      this.#raw = [];
      return;
    }
    let descriptor: number | undefined;
    try {
      withRetentionLock(this.#directory, () => {
        pruneLocked(this.#directory, {
          maxAgeMs: OUTPUT_RETENTION_MS,
          maxFiles: OUTPUT_RETENTION_FILES,
          maxTotalBytes: OUTPUT_RETENTION_BYTES,
          now: Date.now(),
        });
        const state = retentionState(this.#directory, false);
        const reservedBytes = state.active.reduce((total, entry) => total + entry.reservedBytes, 0);
        const closedBytes = state.closed.reduce((total, entry) => total + entry.bytes, 0);
        if (state.active.length + state.closed.length >= OUTPUT_RETENTION_FILES
          || reservedBytes + closedBytes + this.#maxPersistedBytes > OUTPUT_RETENTION_BYTES) return;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const token = randomBytes(16).toString("hex");
          const finalName = `${this.#prefix}-${randomBytes(8).toString("hex")}.log`;
          const activePath = join(
            this.#directory,
            `.rigyn-active-${process.pid}-${this.#maxPersistedBytes}-${token}-${finalName}.part`,
          );
          try {
            descriptor = openSync(
              activePath,
              constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
              OUTPUT_FILE_MODE,
            );
            const metadata = fstatSync(descriptor, { bigint: true });
            this.#activeIdentity = { dev: metadata.dev, ino: metadata.ino };
            this.#activePath = activePath;
            return;
          } catch (error) {
            if (descriptor !== undefined) closeSync(descriptor);
            descriptor = undefined;
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
        throw new Error("Unable to allocate a private tool output file");
      });
    } catch {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        descriptor = undefined;
      }
      this.#removeOwnedActive();
    }
    if (descriptor === undefined || this.#activePath === undefined) {
      this.#fullOutputUnavailable = true;
      this.#fullOutputTruncated = true;
      this.#raw = [];
      return;
    }
    try {
      const stream = createWriteStream(this.#activePath, { fd: descriptor, autoClose: true });
      this.#stream = stream;
      this.#streamCompletion = new Promise((resolveCompletion) => {
        let completed = false;
        const complete = (failure: Error | undefined): void => {
          if (completed) return;
          completed = true;
          resolveCompletion(failure);
        };
        stream.on("error", (failure) => {
          this.#streamFailure ??= failure;
          this.#fullOutputTruncated = true;
        });
        stream.once("close", () => {
          if (this.#streamFailure !== undefined) this.#removeOwnedActive();
          complete(this.#streamFailure);
        });
      });
    } catch {
      try { closeSync(descriptor); } catch {}
      this.#removeOwnedActive();
      this.#fullOutputUnavailable = true;
      this.#fullOutputTruncated = true;
      this.#raw = [];
      return;
    }
    for (const chunk of this.#raw) this.#writePersisted(chunk);
    this.#raw = [];
  }

  #writePersisted(chunk: Buffer): void {
    if (this.#streamFailure !== undefined) {
      this.#fullOutputTruncated = true;
      return;
    }
    const remaining = this.#maxPersistedBytes - this.#persistedBytes;
    if (remaining <= 0) {
      this.#fullOutputTruncated = true;
      return;
    }
    const selected = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
    try {
      this.#stream!.write(selected);
    } catch (error) {
      this.#streamFailure = error instanceof Error ? error : new Error(String(error));
      this.#fullOutputTruncated = true;
      return;
    }
    this.#persistedBytes += selected.byteLength;
    if (selected.byteLength !== chunk.byteLength) this.#fullOutputTruncated = true;
  }

  #regularFileIdentity(path: string): FileIdentity | undefined {
    try {
      return regularFileIdentity(path);
    } catch { return undefined; }
  }

  #removeOwnedActive(): void {
    const path = this.#activePath;
    const identity = this.#activeIdentity;
    if (path === undefined || identity === undefined) return;
    if (sameIdentity(this.#regularFileIdentity(path), identity)) {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      }
    }
    this.#activePath = undefined;
    this.#activeIdentity = undefined;
  }
}
