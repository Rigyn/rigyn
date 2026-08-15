import { closeSync, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";

export const DEFAULT_TRUSTED_RESOURCE_FILE_BYTES = 1024 * 1024;
export const MAX_TRUSTED_RESOURCE_FILE_BYTES = 16 * 1024 * 1024;

export class TrustedResourceFileLimitError extends Error {
  constructor(message: string, readonly information?: Stats) {
    super(message);
  }
}

export class TrustedResourceFileChangedError extends Error {}

export interface TrustedResourceFileReadOptions {
  expectedInformation?: Stats;
  rejectSymbolicLink?: boolean;
}

export interface TrustedResourceFileSnapshot {
  data: Buffer;
  information: Stats;
}

export function trustedResourceFileLimit(
  value = DEFAULT_TRUSTED_RESOURCE_FILE_BYTES,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TRUSTED_RESOURCE_FILE_BYTES) {
    throw new RangeError(
      `Trusted resource file limit must be from 1 through ${MAX_TRUSTED_RESOURCE_FILE_BYTES} bytes`,
    );
  }
  return value;
}

export function readTrustedTextFileSync(
  path: string,
  maxBytes = DEFAULT_TRUSTED_RESOURCE_FILE_BYTES,
  label = "Resource file",
  options: TrustedResourceFileReadOptions = {},
): string {
  return readTrustedFileSync(path, maxBytes, label, options).toString("utf8");
}

export function readTrustedFileSync(
  path: string,
  maxBytes = DEFAULT_TRUSTED_RESOURCE_FILE_BYTES,
  label = "Resource file",
  options: TrustedResourceFileReadOptions = {},
): Buffer {
  return readTrustedFileSnapshotSync(path, maxBytes, label, options).data;
}

export function readTrustedFileSnapshotSync(
  path: string,
  maxBytes = DEFAULT_TRUSTED_RESOURCE_FILE_BYTES,
  label = "Resource file",
  options: TrustedResourceFileReadOptions = {},
): TrustedResourceFileSnapshot {
  const limit = trustedResourceFileLimit(maxBytes);
  let lexical = options.expectedInformation;
  if (lexical === undefined && options.rejectSymbolicLink === true) lexical = lstatSync(path);
  if (lexical !== undefined && options.rejectSymbolicLink === true) {
    if (!lexical.isFile() || lexical.isSymbolicLink()) {
      throw new Error(`${label} is not a regular file: ${path}`);
    }
  }
  const descriptor = openSync(path, "r");
  try {
    const information = fstatSync(descriptor);
    if (!information.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
    if (lexical !== undefined && (
      lexical.dev !== information.dev
      || lexical.ino !== information.ino
      || lexical.size !== information.size
      || lexical.mtimeMs !== information.mtimeMs
      || lexical.ctimeMs !== information.ctimeMs
    )) {
      throw new TrustedResourceFileChangedError(`${label} changed while it was being opened: ${path}`);
    }
    if (information.size > limit) {
      throw new TrustedResourceFileLimitError(`${label} exceeds ${limit} bytes: ${path}`, information);
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - bytes));
      const count = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      bytes += count;
    }
    const after = fstatSync(descriptor);
    if (bytes > limit || after.size > limit) {
      throw new TrustedResourceFileLimitError(`${label} exceeds ${limit} bytes: ${path}`, after);
    }
    if (bytes !== information.size
      || after.size !== information.size
      || after.mtimeMs !== information.mtimeMs
      || after.ctimeMs !== information.ctimeMs) {
      throw new TrustedResourceFileChangedError(`${label} changed while it was being read: ${path}`);
    }
    if (options.rejectSymbolicLink === true) {
      const finalLexical = lstatSync(path);
      if (!finalLexical.isFile()
        || finalLexical.isSymbolicLink()
        || finalLexical.dev !== information.dev
        || finalLexical.ino !== information.ino
        || finalLexical.size !== information.size
        || finalLexical.mtimeMs !== information.mtimeMs
        || finalLexical.ctimeMs !== information.ctimeMs) {
        throw new TrustedResourceFileChangedError(`${label} changed while it was being read: ${path}`);
      }
    }
    return { data: Buffer.concat(chunks, bytes), information };
  } finally {
    closeSync(descriptor);
  }
}
