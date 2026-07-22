import { accessSync, constants, type Stats } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export interface BoundedFile {
  data: Buffer;
  totalBytes: number;
  truncated: boolean;
}

export interface FileSnapshot {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
}

export interface SnapshottedFile extends BoundedFile {
  snapshot: FileSnapshot;
  path: string;
}

export interface ReadableFile {
  path: string;
  relativePath: string;
}

const UNICODE_SPACES = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu;

export const MAX_TOOL_SOURCE_FILE_BYTES = 64 * 1024 * 1024;

/** Resolve a model-provided tool path with the same authority as the harness process. */
/** Expand user-facing path shorthand without resolving a relative path. */
export function expandPath(input: string): string {
  if (input.includes("\0")) throw new Error("Path contains a NUL byte");
  let value = input.replace(UNICODE_SPACES, " ");
  if (value.startsWith("@")) value = value.slice(1);
  if (value === "~") value = homedir();
  else if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    value = join(homedir(), value.slice(2));
  }
  if (value.startsWith("file://")) value = fileURLToPath(value);
  return value;
}

/** Resolve a model-provided path relative to a working directory. */
export function resolveToCwd(input: string, cwd: string): string {
  const value = expandPath(input);
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

/** Resolve a model-provided tool path with the same authority as the harness process. */
export function resolveToolPath(input: string, cwd: string): string {
  return resolveToCwd(input, cwd);
}

function readPathCandidates(input: string, cwd: string): string[] {
  const initial = resolveToCwd(input, cwd);
  const nfd = initial.normalize("NFD");
  return [...new Set([
    initial,
    initial.replace(/ (AM|PM)\./giu, "\u202f$1."),
    nfd,
    initial.replaceAll("'", "\u2019"),
    nfd.replaceAll("'", "\u2019"),
  ])];
}

/** Resolve a readable path synchronously, including common macOS filename variants. */
export function resolveReadPath(input: string, cwd: string): string {
  const candidates = readPathCandidates(input, cwd);
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.F_OK);
      return candidate;
    } catch {
      // Try the next spelling.
    }
  }
  return candidates[0]!;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Prefer a short cwd-relative label while retaining absolute paths outside the cwd. */
export function displayToolPath(path: string, cwd: string): string {
  const absolute = resolveToolPath(path, cwd);
  const candidate = relative(resolve(cwd), absolute);
  return isInside(resolve(cwd), absolute) ? candidate.replaceAll(sep, "/") || "." : absolute;
}

/** Resolve readable paths, including common macOS filename variants. */
export async function resolveToolReadPath(input: string, cwd: string): Promise<string> {
  const candidates = readPathCandidates(input, cwd);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.F_OK);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return candidates[0]!;
}

export const resolveReadPathAsync = resolveToolReadPath;

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function unicodeFilenameKey(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[\u2018\u2019]/gu, "'")
    .replaceAll("\u202f", " ");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class WorkspaceBoundary {
  readonly root: string;
  readonly #realRoot: string;

  private constructor(root: string, realRoot: string) {
    this.root = root;
    this.#realRoot = realRoot;
  }

  static async create(root: string): Promise<WorkspaceBoundary> {
    const absolute = resolve(root);
    const information = await stat(absolute);
    if (!information.isDirectory()) throw new Error(`Workspace is not a directory: ${absolute}`);
    return new WorkspaceBoundary(absolute, await realpath(absolute));
  }

  lexical(input: string): string {
    if (input.includes("\0")) throw new Error("Path contains a NUL byte");
    const target = isAbsolute(input) ? resolve(input) : resolve(this.root, input);
    if (!isInside(this.root, target)) throw new Error(`Path escapes workspace: ${input}`);
    return target;
  }

  relative(target: string): string {
    const absolute = this.lexical(target);
    return relative(this.root, absolute).replaceAll(sep, "/") || ".";
  }

  async readable(input: string): Promise<string> {
    const lexical = this.lexical(input);
    const resolved = await realpath(lexical);
    if (!isInside(this.#realRoot, resolved)) throw new Error(`Resolved path escapes workspace: ${input}`);
    return resolved;
  }

  async readablePath(input: string): Promise<ReadableFile> {
    const path = await this.readable(input);
    return {
      path,
      relativePath: relative(this.#realRoot, path).replaceAll(sep, "/") || ".",
    };
  }

  async readableFile(input: string): Promise<ReadableFile> {
    const lexical = this.lexical(input);
    try {
      return await this.readablePath(lexical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const missing = error;
      const parent = dirname(lexical);
      const resolvedParent = await realpath(parent);
      if (!isInside(this.#realRoot, resolvedParent)) {
        throw new Error(`Resolved path escapes workspace: ${input}`);
      }
      const key = unicodeFilenameKey(basename(lexical));
      const candidates: string[] = [];
      for (const name of await readdir(parent)) {
        if (unicodeFilenameKey(name) !== key) continue;
        const candidate = join(parent, name);
        try {
          if ((await lstat(candidate)).isFile()) candidates.push(candidate);
        } catch (candidateError) {
          if ((candidateError as NodeJS.ErrnoException).code !== "ENOENT") throw candidateError;
        }
      }
      if (candidates.length === 0) throw missing;
      if (candidates.length > 1) {
        throw new Error(`Ambiguous Unicode filename recovery for ${input}: multiple regular files match`);
      }
      const candidate = candidates[0]!;
      const resolved = await realpath(candidate);
      if (!isInside(this.#realRoot, resolved)) throw new Error(`Resolved path escapes workspace: ${input}`);
      if (!(await lstat(candidate)).isFile()) throw new Error(`Recovered path is not a regular file: ${input}`);
      return {
        path: resolved,
        relativePath: relative(this.#realRoot, resolved).replaceAll(sep, "/") || ".",
      };
    }
  }

  async writable(input: string, options: { createParents?: boolean } = {}): Promise<string> {
    const target = this.lexical(input);
    const pathFromRoot = relative(this.root, target);
    const segments = pathFromRoot === "" ? [] : pathFromRoot.split(sep);
    let cursor = this.root;
    let nearestExisting = this.root;
    for (let index = 0; index < segments.length; index += 1) {
      cursor = join(cursor, segments[index] ?? "");
      try {
        const information = await lstat(cursor);
        nearestExisting = cursor;
        if (information.isSymbolicLink()) throw new Error(`Mutation path contains a symbolic link: ${input}`);
        if (index < segments.length - 1 && !information.isDirectory()) {
          throw new Error(`Mutation parent is not a directory: ${cursor}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!options.createParents && index < segments.length - 1) {
          throw new Error(`Mutation parent does not exist: ${dirname(target)}`);
        }
        break;
      }
    }
    const resolvedAncestor = await realpath(nearestExisting);
    if (!isInside(this.#realRoot, resolvedAncestor)) throw new Error(`Mutation parent escapes workspace: ${input}`);
    return target;
  }

  async assertUnchangedParent(target: string): Promise<void> {
    const parent = dirname(this.lexical(target));
    const resolved = await realpath(parent);
    if (!isInside(this.#realRoot, resolved)) throw new Error("Mutation parent changed outside the workspace");
  }
}

export async function readFileBounded(path: string, maxBytes: number): Promise<BoundedFile> {
  const { data, totalBytes, truncated } = await readFileSnapshotBounded(path, maxBytes);
  return { data, totalBytes, truncated };
}

function fileSnapshot(information: Stats): FileSnapshot {
  return {
    dev: information.dev,
    ino: information.ino,
    size: information.size,
    mtimeMs: information.mtimeMs,
    ctimeMs: information.ctimeMs,
    mode: information.mode & 0o777,
  };
}

function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function resolvedRegularFile(path: string): Promise<string> {
  const information = await lstat(path);
  const target = information.isSymbolicLink() ? await realpath(path) : path;
  const resolved = information.isSymbolicLink() ? await lstat(target) : information;
  if (!resolved.isFile()) throw new Error("Path is not a regular file");
  return target;
}

export async function snapshotRegularFile(path: string): Promise<{ path: string; snapshot: FileSnapshot }> {
  const target = await resolvedRegularFile(path);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const information = await handle.stat();
    if (!information.isFile()) throw new Error("Path is not a regular file");
    return { path: target, snapshot: fileSnapshot(information) };
  } finally {
    await handle.close();
  }
}

export async function readFileSnapshotBounded(path: string, maxBytes: number): Promise<SnapshottedFile> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive safe integer");
  const target = await resolvedRegularFile(path);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Path is not a regular file");
    const totalBytes = before.size;
    const size = Math.min(totalBytes, maxBytes);
    const data = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(data, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("File changed while being read");
    }
    return {
      data: data.subarray(0, offset),
      totalBytes,
      truncated: totalBytes > offset,
      snapshot: fileSnapshot(before),
      path: target,
    };
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  } finally {
    await directory.close();
  }
}

export async function atomicWritePath(
  input: string,
  data: Uint8Array,
  options: { createParents?: boolean; expected?: FileSnapshot; mode?: number } = {},
): Promise<string> {
  let target = resolve(input);
  const parentBefore = dirname(target);
  if (options.createParents) await mkdir(parentBefore, { recursive: true });
  let existing: FileSnapshot | undefined;
  try {
    target = await resolvedRegularFile(target);
    const information = await lstat(target);
    existing = {
      dev: information.dev,
      ino: information.ino,
      size: information.size,
      mtimeMs: information.mtimeMs,
      ctimeMs: information.ctimeMs,
      mode: information.mode & 0o777,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (options.expected !== undefined) throw new Error("File changed before it could be replaced");
  }
  const parent = dirname(target);
  const temporary = join(parent, `.${basename(target)}.${randomBytes(10).toString("hex")}.tmp`);
  const handle = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    options.mode ?? existing?.mode ?? 0o600,
  );
  let closed = false;
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    closed = true;
    if (existing !== undefined) await chmod(temporary, existing.mode);

    const expected = options.expected ?? existing;
    if (expected !== undefined) {
      const currentInformation = await lstat(target);
      if (!currentInformation.isFile() || currentInformation.isSymbolicLink()) {
        throw new Error("File changed before it could be replaced");
      }
      const current: FileSnapshot = {
        dev: currentInformation.dev,
        ino: currentInformation.ino,
        size: currentInformation.size,
        mtimeMs: currentInformation.mtimeMs,
        ctimeMs: currentInformation.ctimeMs,
        mode: currentInformation.mode & 0o777,
      };
      if (!sameFileSnapshot(expected, current)) throw new Error("File changed before it could be replaced");
    } else {
      try {
        await lstat(target);
        throw new Error("File appeared before it could be created");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    await rename(temporary, target);
    await syncDirectory(parent);
    return target;
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function atomicWriteFile(
  boundary: WorkspaceBoundary,
  input: string,
  data: Uint8Array,
  options: { createParents?: boolean; mode?: number } = {},
): Promise<string> {
  const target = await boundary.writable(input, options.createParents === undefined ? {} : { createParents: options.createParents });
  const parent = dirname(target);
  if (options.createParents) {
    await mkdir(parent, { recursive: true });
    await boundary.writable(input);
  }
  let existingMode: number | undefined;
  if (await exists(target)) existingMode = (await lstat(target)).mode & 0o777;
  const temporary = join(parent, `.${basename(target)}.${randomBytes(10).toString("hex")}.tmp`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, options.mode ?? existingMode ?? 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    if (existingMode !== undefined) await chmod(temporary, existingMode);
    await boundary.assertUnchangedParent(target);
    await rename(temporary, target);
    await syncDirectory(parent);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return target;
}

export async function deleteFile(
  boundary: WorkspaceBoundary,
  input: string,
): Promise<void> {
  const target = await boundary.writable(input);
  const information = await lstat(target);
  if (!information.isFile()) throw new Error("Delete target is not a regular file");
  await boundary.assertUnchangedParent(target);
  await unlink(target);
  await syncDirectory(dirname(target));
}
