import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  constants as fileConstants,
  type FileHandle,
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rm,
} from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";

import type { ObservabilityRecord, ObservabilitySink } from "./observability.js";

const MAX_SEGMENT_BYTES = 8 * 1024 * 1024;
const MAX_PROCESS_SEGMENTS = 4;
const MAX_QUEUE_RECORDS = 2_048;
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const FLUSH_BATCH_BYTES = 64 * 1024;
const FLUSH_INTERVAL_MS = 2_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const ACTIVE_SEGMENT_GRACE_MS = 5 * 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_RETAINED_FILES = 128;
const MAX_RETAINED_BYTES = 128 * 1024 * 1024;
const LOG_NAME = /^rigyn-(\d{8}T\d{6})-(\d+)-([a-f0-9]{12})-(\d{3,12})\.jsonl$/u;

/** @internal Bounds best-effort observability and crash directory scans. */
export const MAX_DIRECTORY_SCAN_ENTRIES = 10_000;

export interface LocalObservabilityStatus {
  directory: string;
  droppedRecords: number;
  writerFailures: number;
  disabled: boolean;
}

export interface LocalObservabilityFile {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface LocalObservabilityFiles {
  directory: string;
  files: LocalObservabilityFile[];
  totalBytes: number;
  partial: boolean;
}

export interface LocalObservabilitySinkOptions {
  directory: string;
  now?: () => Date;
  /** @internal Shorter intervals are used only by active-writer lifecycle tests. */
  heartbeatIntervalMs?: number;
}

export interface ScanLocalObservabilityFileOptions {
  maximumBytes: number;
  maximumLineBytes: number;
  maximumRecords: number;
  onSnapshot(record: ObservabilityRecord): void;
}

export interface LocalObservabilityFileScan {
  recordsRead: number;
  recordsSkipped: number;
  snapshotsRead: number;
  partial: boolean;
}

function timestampName(value: Date): string {
  return value.toISOString().replaceAll("-", "").replaceAll(":", "").slice(0, 15);
}

async function containsSymbolicLink(value: string): Promise<boolean> {
  const selected = resolve(value);
  const root = parse(selected).root;
  let current = root;
  for (const segment of selected.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return true;
    }
  }
  return false;
}

export async function preparePrivateObservabilityDirectory(directory: string): Promise<string> {
  const selected = resolve(directory);
  if (selected.includes("\0") || Buffer.byteLength(selected, "utf8") > 4_096) {
    throw new Error("Observability log directory is invalid");
  }
  if (await containsSymbolicLink(selected)) throw new Error("Observability log directory contains a symbolic link");
  await mkdir(selected, { recursive: true, mode: 0o700 });
  if (await containsSymbolicLink(selected)) throw new Error("Observability log directory contains a symbolic link");
  const information = await lstat(selected);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error("Observability log destination is not a private directory");
  }
  if (process.platform !== "win32") await chmod(selected, 0o700);
  return await realpath(selected);
}

function recordIsSafe(record: ObservabilityRecord): boolean {
  if (
    record === null
    || typeof record !== "object"
    || record.schemaVersion !== 1
    || (record.kind !== "event" && record.kind !== "metrics_snapshot")
  ) return false;
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(record.timestamp)) return false;
  if (typeof record.processInstance !== "string" || !/^[a-f0-9]{16}$/u.test(record.processInstance)) return false;
  if (typeof record.name !== "string" || record.name.length === 0) return false;
  for (const value of Object.values(record.fields)) {
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) return false;
    if (typeof value === "number" && !Number.isFinite(value)) return false;
  }
  if (record.correlation !== undefined) {
    for (const value of Object.values(record.correlation)) {
      if (value !== undefined && !/^[srq][1-9][0-9]*$/u.test(value)) return false;
    }
  }
  return true;
}

async function scanDirectory(
  directory: string,
  visit: (entry: Dirent) => Promise<void>,
): Promise<boolean> {
  const handle = await opendir(directory);
  try {
    for (let scanned = 0; scanned < MAX_DIRECTORY_SCAN_ENTRIES; scanned += 1) {
      const entry = await handle.read();
      if (entry === null) return false;
      await visit(entry);
    }
    return await handle.read() !== null;
  } finally {
    try { await handle.close(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error;
    }
  }
}

async function cleanupExpired(directory: string, now: number): Promise<void> {
  const retained: Array<{
    path: string;
    size: number;
    modifiedAt: number;
    name: string;
    fresh: boolean;
  }> = [];
  const partial = await scanDirectory(directory, async (entry) => {
    if (!entry.isFile() || !LOG_NAME.test(entry.name)) return;
    const path = join(directory, entry.name);
    try {
      const information = await lstat(path);
      if (information.isSymbolicLink() || !information.isFile()) return;
      const fresh = now - information.mtimeMs <= ACTIVE_SEGMENT_GRACE_MS;
      if (!fresh && now - information.mtimeMs > RETENTION_MS) await rm(path, { force: true });
      else retained.push({
        path,
        size: information.size,
        modifiedAt: information.mtimeMs,
        name: entry.name,
        fresh,
      });
    } catch {
      // Retention is best-effort and must not prevent a new run.
    }
  });
  if (partial) return;
  retained.sort((left, right) =>
    right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name));
  const maximumFiles = Math.max(0, MAX_RETAINED_FILES - MAX_PROCESS_SEGMENTS);
  const maximumBytes = Math.max(0, MAX_RETAINED_BYTES - MAX_PROCESS_SEGMENTS * MAX_SEGMENT_BYTES);
  let files = retained.filter((file) => file.fresh).length;
  let bytes = retained.reduce((sum, file) => sum + (file.fresh ? file.size : 0), 0);
  for (const file of retained) {
    if (file.fresh) continue;
    if (files < maximumFiles && bytes + file.size <= maximumBytes) {
      files += 1;
      bytes += file.size;
      continue;
    }
    try { await rm(file.path, { force: true }); }
    catch { /* Retention is best-effort. */ }
  }
}

export async function listLocalObservabilityFiles(directory: string): Promise<LocalObservabilityFiles> {
  const selected = resolve(directory);
  try {
    if (selected.includes("\0") || await containsSymbolicLink(selected)) {
      return { directory: selected, files: [], totalBytes: 0, partial: true };
    }
    const information = await lstat(selected);
    if (!information.isDirectory() || information.isSymbolicLink()) {
      return { directory: selected, files: [], totalBytes: 0, partial: false };
    }
  } catch (error) {
    return {
      directory: selected,
      files: [],
      totalBytes: 0,
      partial: (error as NodeJS.ErrnoException).code !== "ENOENT",
    };
  }
  const files: LocalObservabilityFile[] = [];
  let entryInspectionFailed = false;
  let partial: boolean;
  try {
    partial = await scanDirectory(selected, async (entry) => {
      if (!entry.isFile() || !LOG_NAME.test(entry.name)) return;
      try {
        const information = await lstat(join(selected, entry.name));
        if (!information.isFile() || information.isSymbolicLink()) return;
        files.push({
          name: entry.name,
          sizeBytes: information.size,
          modifiedAt: information.mtime.toISOString(),
        });
      } catch {
        // A concurrent rotation may remove a file between listing and inspection.
        entryInspectionFailed = true;
      }
    });
  } catch (error) {
    return {
      directory: selected,
      files: [],
      totalBytes: 0,
      partial: (error as NodeJS.ErrnoException).code !== "ENOENT",
    };
  }
  partial ||= entryInspectionFailed;
  files.sort((left, right) => left.modifiedAt.localeCompare(right.modifiedAt));
  return {
    directory: selected,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    partial,
  };
}

/** Streams safe aggregate snapshots from one listed file without retaining other log records. */
export async function scanLocalObservabilityFile(
  directory: string,
  file: LocalObservabilityFile,
  options: ScanLocalObservabilityFileOptions,
): Promise<LocalObservabilityFileScan | undefined> {
  if (
    !LOG_NAME.test(file.name)
    || !Number.isSafeInteger(options.maximumBytes)
    || options.maximumBytes < 1
    || !Number.isSafeInteger(options.maximumLineBytes)
    || options.maximumLineBytes < 1
    || !Number.isSafeInteger(options.maximumRecords)
    || options.maximumRecords < 1
  ) return undefined;
  const selected = resolve(directory);
  if (selected.includes("\0") || await containsSymbolicLink(selected)) return undefined;
  const path = join(selected, file.name);
  let handle: FileHandle | undefined;
  try {
    const directoryBefore = await lstat(selected);
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) return undefined;
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) return undefined;
    const noFollow = "O_NOFOLLOW" in fileConstants ? fileConstants.O_NOFOLLOW : 0;
    handle = await open(path, fileConstants.O_RDONLY | noFollow);
    const directoryAfter = await lstat(selected);
    const information = await handle.stat();
    if (
      !directoryAfter.isDirectory()
      || directoryAfter.isSymbolicLink()
      || directoryBefore.dev !== directoryAfter.dev
      || directoryBefore.ino !== directoryAfter.ino
      || !information.isFile()
      || before.dev !== information.dev
      || before.ino !== information.ino
    ) return undefined;
    const maximumBytes = Math.min(options.maximumBytes, information.size);
    if (maximumBytes === 0) {
      return { recordsRead: 0, recordsSkipped: 0, snapshotsRead: 0, partial: false };
    }

    const stream = handle.createReadStream({
      autoClose: false,
      encoding: "utf8",
      start: 0,
      end: maximumBytes - 1,
    });
    let pending = "";
    let pendingBytes = 0;
    let discarding = false;
    let recordsRead = 0;
    let recordsSkipped = 0;
    let snapshotsRead = 0;
    let partial = maximumBytes < information.size;
    let stopped = false;

    const processLine = (line: string): void => {
      if (stopped || line === "") return;
      if (recordsRead >= options.maximumRecords) {
        partial = true;
        stopped = true;
        return;
      }
      recordsRead += 1;
      if (!line.includes('"kind":"metrics_snapshot"')) return;
      let parsed: unknown;
      try { parsed = JSON.parse(line); }
      catch { recordsSkipped += 1; return; }
      if (parsed === null || typeof parsed !== "object") {
        recordsSkipped += 1;
        return;
      }
      const candidate = parsed as ObservabilityRecord;
      if (candidate.kind !== "metrics_snapshot") return;
      let safe = false;
      try { safe = recordIsSafe(candidate); } catch {}
      if (!safe) {
        recordsSkipped += 1;
        return;
      }
      snapshotsRead += 1;
      options.onSnapshot(candidate);
    };
    const consume = (piece: string, complete: boolean): void => {
      if (discarding) {
        if (complete) discarding = false;
        return;
      }
      const bytes = Buffer.byteLength(piece, "utf8");
      if (pendingBytes + bytes > options.maximumLineBytes) {
        pending = "";
        pendingBytes = 0;
        recordsSkipped += 1;
        discarding = !complete;
        return;
      }
      pending += piece;
      pendingBytes += bytes;
      if (!complete) return;
      processLine(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
      pending = "";
      pendingBytes = 0;
    };

    for await (const chunk of stream) {
      const text = String(chunk);
      let start = 0;
      for (;;) {
        const newline = text.indexOf("\n", start);
        if (newline < 0) break;
        consume(text.slice(start, newline), true);
        start = newline + 1;
        if (stopped) break;
      }
      if (stopped) break;
      consume(text.slice(start), false);
    }
    if (!stopped && !discarding && pending !== "") {
      if (partial) recordsSkipped += 1;
      else processLine(pending);
    }
    return { recordsRead, recordsSkipped, snapshotsRead, partial };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Private, fail-open JSONL sink. Each process owns its files and never shares a writer lock. */
export class LocalJsonlObservabilitySink implements ObservabilitySink {
  readonly #directory: string;
  readonly #now: () => Date;
  readonly #prefix: string;
  readonly #heartbeatIntervalMs: number;
  readonly #queue: Array<{ line: string; bytes: number }> = [];
  readonly #segments: string[] = [];
  #queueBytes = 0;
  #bufferedRecords = 0;
  #bufferedBytes = 0;
  #segment = 0;
  #segmentBytes = 0;
  #handle: FileHandle | undefined;
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #writeTail: Promise<void> = Promise.resolve();
  #droppedRecords = 0;
  #writerFailures = 0;
  #heartbeatFailureReported = false;
  #heartbeatQueued = false;
  #disabled = false;
  #closed = false;

  private constructor(directory: string, options: LocalObservabilitySinkOptions, disabled: boolean) {
    this.#directory = directory;
    this.#now = options.now ?? (() => new Date());
    this.#prefix = `rigyn-${timestampName(this.#now())}-${process.pid}-${randomBytes(6).toString("hex")}`;
    const heartbeatInterval = options.heartbeatIntervalMs;
    this.#heartbeatIntervalMs = heartbeatInterval !== undefined
      && Number.isFinite(heartbeatInterval)
      && heartbeatInterval > 0
      && heartbeatInterval <= MAX_TIMER_DELAY_MS
      ? Math.max(10, Math.floor(heartbeatInterval))
      : DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#disabled = disabled;
  }

  static async create(options: LocalObservabilitySinkOptions): Promise<LocalJsonlObservabilitySink> {
    try {
      const directory = await preparePrivateObservabilityDirectory(options.directory);
      await cleanupExpired(directory, (options.now ?? (() => new Date()))().getTime());
      return new LocalJsonlObservabilitySink(directory, options, false);
    } catch {
      const sink = new LocalJsonlObservabilitySink(resolve(options.directory), options, true);
      sink.#writerFailures = 1;
      return sink;
    }
  }

  status(): LocalObservabilityStatus {
    return {
      directory: this.#directory,
      droppedRecords: this.#droppedRecords,
      writerFailures: this.#writerFailures,
      disabled: this.#disabled,
    };
  }

  /** @internal Process-scoped acquisition must never reuse a closed writer. */
  isClosed(): boolean { return this.#closed; }

  record(record: ObservabilityRecord): void {
    let safe = false;
    try { safe = recordIsSafe(record); } catch {}
    if (this.#closed || this.#disabled || !safe) {
      this.#droppedRecords += 1;
      return;
    }
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      this.#droppedRecords += 1;
      return;
    }
    const bytes = Buffer.byteLength(line, "utf8");
    if (
      bytes > MAX_QUEUE_BYTES
      || this.#bufferedRecords >= MAX_QUEUE_RECORDS
      || this.#bufferedBytes + bytes > MAX_QUEUE_BYTES
    ) {
      this.#droppedRecords += 1;
      return;
    }
    this.#queue.push({ line, bytes });
    this.#queueBytes += bytes;
    this.#bufferedRecords += 1;
    this.#bufferedBytes += bytes;
    if (this.#queueBytes >= FLUSH_BATCH_BYTES) this.#scheduleDrain(true);
    else this.#scheduleDrain(false);
  }

  async flush(): Promise<void> {
    if (this.#flushTimer !== undefined) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }
    for (;;) {
      this.#scheduleDrain(true);
      const observed = this.#writeTail;
      await observed;
      if (this.#queue.length === 0 && observed === this.#writeTail) return;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopHeartbeat();
    await this.flush();
    const handle = this.#handle;
    this.#handle = undefined;
    if (handle !== undefined) {
      try { await handle.close(); }
      catch { this.#writerFailures += 1; }
    }
  }

  #scheduleDrain(immediate: boolean): void {
    if (this.#queue.length === 0) return;
    if (immediate) {
      if (this.#flushTimer !== undefined) clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
      this.#enqueueDrain();
      return;
    }
    if (this.#flushTimer !== undefined) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      this.#enqueueDrain();
    }, FLUSH_INTERVAL_MS);
    this.#flushTimer.unref();
  }

  #enqueueDrain(): void {
    if (this.#queue.length === 0) return;
    const batch = this.#queue.splice(0, this.#queue.length);
    const bytes = batch.reduce((sum, entry) => sum + entry.bytes, 0);
    this.#queueBytes = Math.max(0, this.#queueBytes - bytes);
    this.#writeTail = this.#writeTail
      .then(async () => {
        if (this.#disabled) {
          this.#droppedRecords += batch.length;
          return;
        }
        try {
          await this.#writeBatch(batch);
        } catch {
          this.#writerFailures += 1;
          this.#droppedRecords += batch.length;
          this.#disabled = true;
          this.#stopHeartbeat();
          const handle = this.#handle;
          this.#handle = undefined;
          await handle?.close().catch(() => undefined);
        }
      })
      .finally(() => {
        this.#bufferedRecords = Math.max(0, this.#bufferedRecords - batch.length);
        this.#bufferedBytes = Math.max(0, this.#bufferedBytes - bytes);
      });
  }

  async #writeBatch(batch: Array<{ line: string; bytes: number }>): Promise<void> {
    let lines: string[] = [];
    let bytes = 0;
    const writePending = async (): Promise<void> => {
      if (lines.length === 0) return;
      await this.#handle!.writeFile(lines.join(""), "utf8");
      this.#segmentBytes += bytes;
      lines = [];
      bytes = 0;
    };
    for (const entry of batch) {
      if (this.#handle === undefined) await this.#rotate();
      if (this.#segmentBytes + bytes + entry.bytes > MAX_SEGMENT_BYTES) {
        await writePending();
        await this.#rotate();
      }
      lines.push(entry.line);
      bytes += entry.bytes;
    }
    await writePending();
  }

  async #rotate(): Promise<void> {
    const previous = this.#handle;
    this.#handle = undefined;
    await previous?.close();
    const path = join(this.#directory, `${this.#prefix}-${String(this.#segment).padStart(3, "0")}.jsonl`);
    this.#segment += 1;
    const noFollow = "O_NOFOLLOW" in fileConstants ? fileConstants.O_NOFOLLOW : 0;
    this.#handle = await open(
      path,
      fileConstants.O_WRONLY | fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_APPEND | noFollow,
      0o600,
    );
    if (process.platform !== "win32") await this.#handle.chmod(0o600);
    this.#segmentBytes = 0;
    this.#segments.push(path);
    this.#startHeartbeat();
    while (this.#segments.length > MAX_PROCESS_SEGMENTS) {
      const expired = this.#segments.shift();
      if (expired !== undefined) await rm(expired, { force: true });
    }
  }

  #startHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined || this.#closed || this.#disabled) return;
    this.#heartbeatTimer = setInterval(() => this.#enqueueHeartbeat(), this.#heartbeatIntervalMs);
    this.#heartbeatTimer.unref();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer === undefined) return;
    clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  #enqueueHeartbeat(): void {
    if (this.#closed || this.#disabled || this.#handle === undefined || this.#heartbeatQueued) return;
    this.#heartbeatQueued = true;
    this.#writeTail = this.#writeTail
      .then(async () => {
        const handle = this.#handle;
        if (this.#closed || this.#disabled || handle === undefined) return;
        try {
          const now = this.#now();
          await handle.utimes(now, now);
        } catch {
          if (!this.#heartbeatFailureReported) {
            this.#heartbeatFailureReported = true;
            this.#writerFailures += 1;
          }
        }
      })
      .finally(() => { this.#heartbeatQueued = false; });
  }
}

const processLocalSinks = new Map<string, Promise<LocalJsonlObservabilitySink>>();

/** @internal Shares one serialized local writer across runtime observers in this process. */
export async function acquireProcessLocalObservabilitySink(
  directory: string,
): Promise<LocalJsonlObservabilitySink> {
  const selected = resolve(directory);
  const cached = processLocalSinks.get(selected);
  if (cached !== undefined) {
    let sink: LocalJsonlObservabilitySink;
    try { sink = await cached; }
    catch (error) {
      if (processLocalSinks.get(selected) === cached) processLocalSinks.delete(selected);
      throw error;
    }
    if (!sink.status().disabled && !sink.isClosed()) return sink;
    if (processLocalSinks.get(selected) === cached) processLocalSinks.delete(selected);
  }

  let pending = processLocalSinks.get(selected);
  if (pending === undefined) {
    pending = LocalJsonlObservabilitySink.create({ directory: selected });
    processLocalSinks.set(selected, pending);
  }
  let sink: LocalJsonlObservabilitySink;
  try { sink = await pending; }
  catch (error) {
    if (processLocalSinks.get(selected) === pending) processLocalSinks.delete(selected);
    throw error;
  }
  if (sink.status().disabled && processLocalSinks.get(selected) === pending) {
    processLocalSinks.delete(selected);
  }
  return sink;
}
