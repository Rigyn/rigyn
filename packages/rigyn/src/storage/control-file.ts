import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { lstat, open } from "node:fs/promises";

const MAX_CONTROL_FILE_BYTES = 4 * 1024;
const READ_FLAGS = constants.O_RDONLY
  | (constants.O_NONBLOCK ?? 0)
  | (constants.O_NOFOLLOW ?? 0);

function invalid(path: string): Error {
  return new Error(`Control file is not a bounded regular file: ${path}`);
}

function unchanged(
  opened: { dev: number; ino: number; size: number },
  current: { dev: number; ino: number; size: number; isFile(): boolean },
): boolean {
  return current.isFile()
    && current.dev === opened.dev
    && current.ino === opened.ino
    && current.size === opened.size;
}

export function readControlFileSync(path: string): string {
  const descriptor = openSync(path, READ_FLAGS);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_CONTROL_FILE_BYTES) throw invalid(path);

    const bytes = Buffer.allocUnsafe(MAX_CONTROL_FILE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_CONTROL_FILE_BYTES) throw invalid(path);

    const after = fstatSync(descriptor);
    const current = lstatSync(path);
    if (!unchanged(opened, after) || !unchanged(opened, current) || offset !== opened.size) {
      throw invalid(path);
    }
    return bytes.toString("utf8", 0, offset);
  } finally {
    closeSync(descriptor);
  }
}

export async function readControlFile(path: string): Promise<string> {
  const handle = await open(path, READ_FLAGS);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_CONTROL_FILE_BYTES) throw invalid(path);

    const bytes = Buffer.allocUnsafe(MAX_CONTROL_FILE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_CONTROL_FILE_BYTES) throw invalid(path);

    const after = await handle.stat();
    const current = await lstat(path);
    if (!unchanged(opened, after) || !unchanged(opened, current) || offset !== opened.size) {
      throw invalid(path);
    }
    return bytes.toString("utf8", 0, offset);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
