import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  createWriteStream,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  type WriteStream,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TOOL_MAX_BYTES, TOOL_MAX_LINES, truncateToolTail, type ToolTruncation } from "./truncate.js";

export interface ToolOutputSnapshot {
  content: string;
  truncation: ToolTruncation;
  fullOutputPath?: string;
  fullOutputTruncated?: boolean;
}

const OUTPUT_DIRECTORY_MODE = 0o700;
const OUTPUT_FILE_MODE = 0o600;
const OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const OUTPUT_RETENTION_FILES = 128;
const OUTPUT_RETENTION_BYTES = 512 * 1_024 * 1_024;
const OUTPUT_FILE_MAX_BYTES = 64 * 1_024 * 1_024;
const OUTPUT_NAME = /^rigyn-[A-Za-z0-9._-]{1,64}-[a-f0-9]{16}\.log$/u;

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

function defaultOutputDirectory(): string {
  const identity = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(tmpdir(), `rigyn-tool-output-${identity}`);
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: OUTPUT_DIRECTORY_MODE });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Tool output path must be a real directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`Tool output directory is not owned by the current user: ${directory}`);
  }
  if (process.platform !== "win32") chmodSync(directory, OUTPUT_DIRECTORY_MODE);
}

/** Removes expired or excess private command-output files without following links. */
export function pruneToolOutputFiles(options: ToolOutputRetentionOptions = {}): ToolOutputCleanupResult {
  const directory = options.directory ?? defaultOutputDirectory();
  const maxAgeMs = positiveInteger(options.maxAgeMs ?? OUTPUT_RETENTION_MS, "maxAgeMs");
  const maxFiles = positiveInteger(options.maxFiles ?? OUTPUT_RETENTION_FILES, "maxFiles");
  const maxTotalBytes = positiveInteger(options.maxTotalBytes ?? OUTPUT_RETENTION_BYTES, "maxTotalBytes");
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) throw new RangeError("now must be a non-negative finite timestamp");
  ensurePrivateDirectory(directory);

  const entries = readdirSync(directory).flatMap((name) => {
    if (!OUTPUT_NAME.test(name)) return [];
    const path = join(directory, name);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return [];
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) return [];
    return [{ path, bytes: metadata.size, modifiedAt: metadata.mtimeMs }];
  }).sort((left, right) => left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path));

  let retainedBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  let retainedFiles = entries.length;
  let removedBytes = 0;
  let removedFiles = 0;
  for (const entry of entries) {
    const expired = now - entry.modifiedAt > maxAgeMs;
    if (!expired && retainedFiles <= maxFiles && retainedBytes <= maxTotalBytes) continue;
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

/** Retains a bounded decoded tail and spills complete command output to disk when needed. */
export class ToolOutputAccumulator {
  readonly #decoder = new TextDecoder();
  readonly #maxBytes: number;
  readonly #maxLines: number;
  readonly #prefix: string;
  readonly #directory: string;
  readonly #maxPersistedBytes: number;
  #raw: Buffer[] = [];
  #stream: WriteStream | undefined;
  #path: string | undefined;
  #tail = "";
  #decodedBytes = 0;
  #rawBytes = 0;
  #completedLines = 0;
  #openLine = false;
  #lastLineBytes = 0;
  #persistedBytes = 0;
  #fullOutputTruncated = false;
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
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(this.#prefix)) throw new Error("Tool output prefix is invalid");
    this.#directory = options.directory ?? defaultOutputDirectory();
    this.#maxPersistedBytes = positiveInteger(options.maxPersistedBytes ?? OUTPUT_FILE_MAX_BYTES, "maxPersistedBytes");
    pruneToolOutputFiles({ directory: this.#directory });
  }

  append(value: Uint8Array): void {
    if (this.#finished) return;
    const chunk = Buffer.from(value);
    this.#rawBytes += chunk.byteLength;
    this.#appendText(this.#decoder.decode(chunk, { stream: true }));
    if (this.#stream !== undefined) this.#writePersisted(chunk);
    else this.#raw.push(chunk);
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
      ...(this.#path === undefined ? {} : { fullOutputPath: this.#path }),
      ...(this.#fullOutputTruncated ? { fullOutputTruncated: true } : {}),
    };
  }

  lastLineBytes(): number {
    return this.#lastLineBytes;
  }

  async close(): Promise<void> {
    const stream = this.#stream;
    if (stream === undefined) return;
    this.#stream = undefined;
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject);
      stream.once("finish", resolve);
      stream.end();
    });
  }

  #appendText(value: string): void {
    if (value === "") return;
    const bytes = Buffer.byteLength(value, "utf8");
    this.#decodedBytes += bytes;
    this.#tail += value;
    const lastNewline = value.lastIndexOf("\n");
    if (lastNewline < 0) {
      this.#lastLineBytes += bytes;
      this.#openLine = true;
    } else {
      this.#completedLines += value.split("\n").length - 1;
      const remainder = value.slice(lastNewline + 1);
      this.#lastLineBytes = Buffer.byteLength(remainder, "utf8");
      this.#openLine = remainder !== "";
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
    if (this.#path !== undefined) return;
    pruneToolOutputFiles({ directory: this.#directory, maxFiles: OUTPUT_RETENTION_FILES - 1 });
    let descriptor: number | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = join(this.#directory, `${this.#prefix}-${randomBytes(8).toString("hex")}.log`);
      try {
        descriptor = openSync(
          candidate,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
          OUTPUT_FILE_MODE,
        );
        this.#path = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (descriptor === undefined || this.#path === undefined) throw new Error("Unable to allocate a private tool output file");
    try {
      this.#stream = createWriteStream(this.#path, { fd: descriptor, autoClose: true });
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
    for (const chunk of this.#raw) this.#writePersisted(chunk);
    this.#raw = [];
  }

  #writePersisted(chunk: Buffer): void {
    const remaining = this.#maxPersistedBytes - this.#persistedBytes;
    if (remaining <= 0) {
      this.#fullOutputTruncated = true;
      return;
    }
    const selected = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
    this.#stream!.write(selected);
    this.#persistedBytes += selected.byteLength;
    if (selected.byteLength !== chunk.byteLength) this.#fullOutputTruncated = true;
  }
}
