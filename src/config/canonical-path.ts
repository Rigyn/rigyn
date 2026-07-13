import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";

const MAX_PATH_SEGMENTS = 256;
const MAX_DIRECTORY_ENTRIES = 100_000;
const WINDOWS_DEVICE_NAME = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function caseKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function canonicalEntryName(parent: string, requested: string): Promise<string> {
  const target = await lstat(join(parent, requested));
  const candidates: string[] = [];
  const directory = await opendir(parent);
  let entries = 0;
  for await (const entry of directory) {
    entries += 1;
    if (entries > MAX_DIRECTORY_ENTRIES) return requested;
    if (entry.name === requested) return entry.name;
    if (caseKey(entry.name) === caseKey(requested)) candidates.push(entry.name);
  }
  for (const candidate of candidates) {
    try {
      if (sameFile(target, await lstat(join(parent, candidate)))) return candidate;
    } catch {}
  }
  return requested;
}

function canonicalEntryNameSync(parent: string, requested: string): string {
  const target = lstatSync(join(parent, requested));
  const candidates: string[] = [];
  const directory = opendirSync(parent);
  try {
    let entries = 0;
    let entry = directory.readSync();
    while (entry !== null) {
      entries += 1;
      if (entries > MAX_DIRECTORY_ENTRIES) return requested;
      if (entry.name === requested) return entry.name;
      if (caseKey(entry.name) === caseKey(requested)) candidates.push(entry.name);
      entry = directory.readSync();
    }
  } finally {
    directory.closeSync();
  }
  for (const candidate of candidates) {
    try {
      if (sameFile(target, lstatSync(join(parent, candidate)))) return candidate;
    } catch {}
  }
  return requested;
}

function stableRoot(root: string): string {
  return process.platform === "win32" && /^[a-z]:[\\/]$/iu.test(root)
    ? `${root[0]!.toUpperCase()}${root.slice(1)}`
    : root;
}

/** Resolves links and restores stable directory-entry casing on desktop filesystems. */
export async function canonicalExistingPath(path: string): Promise<string> {
  const resolved = await realpath(path);
  if (process.platform !== "win32" && process.platform !== "darwin") return resolved;
  const root = parse(resolved).root;
  const segments = resolved.slice(root.length).split(sep).filter((segment) => segment !== "");
  if (segments.length > MAX_PATH_SEGMENTS) return resolved;
  let current = stableRoot(root);
  try {
    for (const segment of segments) current = join(current, await canonicalEntryName(current, segment));
    return current;
  } catch {
    return resolved;
  }
}

/** Synchronous counterpart used before synchronous file creation. */
export function canonicalExistingPathSync(path: string): string {
  const resolved = realpathSync(path);
  if (process.platform !== "win32" && process.platform !== "darwin") return resolved;
  const root = parse(resolved).root;
  const segments = resolved.slice(root.length).split(sep).filter((segment) => segment !== "");
  if (segments.length > MAX_PATH_SEGMENTS) return resolved;
  let current = stableRoot(root);
  try {
    for (const segment of segments) current = join(current, canonicalEntryNameSync(current, segment));
    return current;
  } catch {
    return resolved;
  }
}

/** Returns true when any non-root component resolves through a symbolic link or junction. */
export async function hasSymlinkComponent(path: string): Promise<boolean> {
  const root = parse(path).root;
  const segments = path.slice(root.length).split(sep).filter((segment) => segment !== "");
  if (segments.length > MAX_PATH_SEGMENTS) return true;
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) return true;
  }
  return false;
}

function hasSymlinkComponentSync(path: string): boolean {
  const root = parse(path).root;
  const segments = path.slice(root.length).split(sep).filter((segment) => segment !== "");
  if (segments.length > MAX_PATH_SEGMENTS) return true;
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function canonicalCreationError(path: string): Error {
  return new Error(`Directory creation path has a symbolic or non-canonical existing ancestor: ${path}`);
}

/** Rejects a pre-existing alias before recursive directory creation can follow it. */
export async function assertCanonicalDirectoryCreationPath(path: string): Promise<void> {
  const selected = resolve(path);
  let current = selected;
  while (true) {
    try {
      const details = await lstat(current);
      if (!details.isDirectory() || details.isSymbolicLink()) throw canonicalCreationError(current);
      if (await hasSymlinkComponent(current)) throw canonicalCreationError(current);
      if (await canonicalExistingPath(current) !== current) throw canonicalCreationError(current);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/** Synchronous counterpart used before an O_CREAT database open. */
export function assertCanonicalDirectoryCreationPathSync(path: string): void {
  const selected = resolve(path);
  let current = selected;
  while (true) {
    try {
      const details = lstatSync(current);
      if (!details.isDirectory() || details.isSymbolicLink()) throw canonicalCreationError(current);
      if (hasSymlinkComponentSync(current)) throw canonicalCreationError(current);
      if (canonicalExistingPathSync(current) !== current) throw canonicalCreationError(current);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/** Names Windows path forms that bypass ordinary local-file identity semantics. */
export function windowsPathHazard(path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "win32") return undefined;
  const normalized = path.replaceAll("/", "\\");
  if (normalized.startsWith("\\\\?\\") || normalized.startsWith("\\\\.\\")) return "device namespace";
  if (normalized.startsWith("\\\\")) return "UNC path";
  const drive = /^[A-Za-z]:\\/u.exec(normalized)?.[0];
  if (drive === undefined) return "non-drive path";
  const remainder = normalized.slice(drive.length);
  if (remainder.includes(":")) return "alternate data stream";
  for (const segment of remainder.split("\\")) {
    if (segment === "") continue;
    if (/[ .]$/u.test(segment)) return "trailing dot or space";
    if (WINDOWS_DEVICE_NAME.test(segment)) return "reserved device name";
  }
  return undefined;
}
