import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, parse, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalExistingPath, windowsPathHazard } from "./canonical-path.js";

const MAX_TRUST_FILE_BYTES = 1024 * 1024;
const MAX_TRUSTED_WORKSPACES = 4096;
const MAX_WORKSPACE_BYTES = 4096;
const MAX_LOCK_BYTES = 4096;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_CLOCK_SKEW_MS = 60_000;
const MAX_PROCESS_ID = 0x7fff_ffff;
const MAX_STATE_DIRECTORY_ENTRIES = 10_000;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NON_BLOCK = constants.O_NONBLOCK ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;

type TrustDecision = "trusted" | "untrusted";

interface TrustEntry {
  decision: TrustDecision;
  decidedAt: string;
  descendants?: true;
}

interface TrustFile {
  version: 2;
  workspaces: Record<string, TrustEntry>;
}

export interface WorkspaceTrustDecision {
  workspace: string;
  decision: boolean;
  decidedAt: string;
  descendants?: true;
}

interface LockRecord {
  version: 1;
  pid: number;
  token: string;
  createdAt: number;
}

interface SecureDirectory {
  handle: FileHandle;
  device: number;
  inode: number;
}

export class TrustStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TrustStoreError";
  }
}

function empty(): TrustFile {
  return { version: 2, workspaces: Object.create(null) as Record<string, TrustEntry> };
}

function errno(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function assertWorkspacePath(workspace: string): void {
  const windowsHazard = windowsPathHazard(workspace);
  if (
    !isAbsolute(workspace) ||
    normalize(workspace) !== workspace ||
    workspace.includes("\0") ||
    Buffer.byteLength(workspace, "utf8") > MAX_WORKSPACE_BYTES ||
    windowsHazard !== undefined
  ) {
    throw new TrustStoreError("Trust store contains an invalid workspace path");
  }
}

function validateLegacyTrustFile(workspaces: Record<string, unknown>): TrustFile {
  const migrated = empty();
  for (const [workspace, valueRecord] of Object.entries(workspaces)) {
    assertWorkspacePath(workspace);
    const entry = record(valueRecord);
    const exact = entry !== undefined && hasOnlyKeys(entry, ["trustedAt"]);
    const descendants = entry !== undefined
      && hasOnlyKeys(entry, ["trustedAt", "descendants"])
      && entry.descendants === true;
    if (
      entry === undefined
      || (!exact && !descendants)
      || !validTimestamp(entry.trustedAt)
      || (descendants && workspace === parse(workspace).root)
    ) {
      throw new TrustStoreError(`Trust store contains an invalid entry for ${workspace}`);
    }
    migrated.workspaces[workspace] = {
      decision: "trusted",
      decidedAt: entry.trustedAt,
      ...(descendants ? { descendants: true } : {}),
    };
  }
  return migrated;
}

function validateCurrentTrustFile(workspaces: Record<string, unknown>): TrustFile {
  const validated = empty();
  for (const [workspace, valueRecord] of Object.entries(workspaces)) {
    assertWorkspacePath(workspace);
    const entry = record(valueRecord);
    const exact = entry !== undefined && hasOnlyKeys(entry, ["decision", "decidedAt"]);
    const descendants = entry !== undefined
      && hasOnlyKeys(entry, ["decision", "decidedAt", "descendants"])
      && entry.descendants === true;
    if (
      entry === undefined
      || (!exact && !descendants)
      || (entry.decision !== "trusted" && entry.decision !== "untrusted")
      || !validTimestamp(entry.decidedAt)
      || (descendants && (entry.decision !== "trusted" || workspace === parse(workspace).root))
    ) {
      throw new TrustStoreError(`Trust store contains an invalid entry for ${workspace}`);
    }
    validated.workspaces[workspace] = {
      decision: entry.decision,
      decidedAt: entry.decidedAt,
      ...(descendants ? { descendants: true } : {}),
    };
  }
  return validated;
}

function validateTrustFile(value: unknown): TrustFile {
  const root = record(value);
  if (
    root === undefined
    || !hasOnlyKeys(root, ["version", "workspaces"])
    || (root.version !== 1 && root.version !== 2)
  ) {
    throw new TrustStoreError("Trust store has an invalid top-level shape");
  }
  const workspaces = record(root.workspaces);
  if (workspaces === undefined) throw new TrustStoreError("Trust store has an invalid workspace map");
  const entries = Object.entries(workspaces);
  if (entries.length > MAX_TRUSTED_WORKSPACES) {
    throw new TrustStoreError(`Trust store exceeds the ${MAX_TRUSTED_WORKSPACES} workspace limit`);
  }
  return root.version === 1
    ? validateLegacyTrustFile(workspaces)
    : validateCurrentTrustFile(workspaces);
}

function parseTrustFile(text: string): TrustFile {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new TrustStoreError("Trust store is not valid JSON", { cause: error });
  }
  return validateTrustFile(value);
}

function serializeTrustFile(value: TrustFile): string {
  const validated = validateTrustFile(value);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_TRUST_FILE_BYTES) {
    throw new TrustStoreError(`Trust store exceeds the ${MAX_TRUST_FILE_BYTES} byte size limit`);
  }
  return serialized;
}

function recursiveTrustParent(workspaces: TrustFile["workspaces"], workspace: string): string | undefined {
  let cursor = dirname(workspace);
  while (true) {
    if (workspaces[cursor]?.decision === "trusted" && workspaces[cursor]?.descendants === true) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function sameFile(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOwned(information: { uid: number }, label: string): void {
  if (
    process.platform !== "win32" &&
    process.getuid !== undefined &&
    information.uid !== process.getuid()
  ) {
    throw new TrustStoreError(`${label} is owned by another user`);
  }
}

async function openSecureDirectory(
  path: string,
  create: boolean,
  expected?: SecureDirectory,
): Promise<SecureDirectory | undefined> {
  if (path === parse(path).root) {
    throw new TrustStoreError("Trust store directory cannot be the filesystem root");
  }
  let firstCreated: string | undefined;
  if (create) {
    try {
      firstCreated = await mkdir(path, { recursive: true, mode: 0o700 });
    } catch (error) {
      if (new Set(["EEXIST", "ELOOP", "ENOTDIR"]).has(errno(error) ?? "")) {
        throw new TrustStoreError("Trust store directory is not a regular directory", { cause: error });
      }
      throw error;
    }
  }

  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | DIRECTORY | NO_FOLLOW);
  } catch (error) {
    if (errno(error) === "ENOENT" && !create) return undefined;
    if (new Set(["ELOOP", "ENOTDIR"]).has(errno(error) ?? "")) {
      throw new TrustStoreError("Trust store directory must not be a symbolic link or special file", { cause: error });
    }
    throw error;
  }

  try {
    const information = await handle.stat();
    const selected = await lstat(path);
    if (
      !information.isDirectory() ||
      !selected.isDirectory() ||
      selected.isSymbolicLink() ||
      !sameFile(information, selected)
    ) {
      throw new TrustStoreError("Trust store directory must be a non-symbolic regular directory");
    }
    if (
      expected !== undefined &&
      (information.dev !== expected.device || information.ino !== expected.inode)
    ) {
      throw new TrustStoreError("Trust store directory changed during operation");
    }
    assertOwned(information, "Trust store directory");
    if (process.platform !== "win32") {
      if ((information.mode & 0o1000) !== 0) {
        throw new TrustStoreError("Trust store directory cannot be a shared sticky directory");
      }
      if ((information.mode & 0o022) !== 0) {
        throw new TrustStoreError("Trust store directory must not be group- or world-writable");
      }
      await handle.chmod(0o700);
    }
    const opened = { handle, device: information.dev, inode: information.ino };
    if (firstCreated !== undefined) await syncCreatedDirectory(path, firstCreated, opened);
    return opened;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertDirectorySelected(path: string, directory: SecureDirectory): Promise<void> {
  let selected;
  try {
    selected = await lstat(path);
  } catch (error) {
    throw new TrustStoreError("Trust store directory changed during operation", { cause: error });
  }
  if (
    !selected.isDirectory() ||
    selected.isSymbolicLink() ||
    selected.dev !== directory.device ||
    selected.ino !== directory.inode
  ) {
    throw new TrustStoreError("Trust store directory changed during operation");
  }
}

async function openPrivateRegularFile(
  path: string,
  label: string,
  maxBytes: number,
  allowMultipleLinks = false,
): Promise<FileHandle | undefined> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let selected;
    try {
      selected = await lstat(path);
    } catch (error) {
      if (errno(error) === "ENOENT") return undefined;
      throw error;
    }
    if (selected.isSymbolicLink() || !selected.isFile()) {
      throw new TrustStoreError(`${label} must be a non-symbolic regular file`);
    }

    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
    } catch (error) {
      if (errno(error) === "ENOENT") continue;
      if (errno(error) === "ELOOP") {
        throw new TrustStoreError(`${label} must not be a symbolic link`, { cause: error });
      }
      throw error;
    }
    try {
      const information = await handle.stat();
      let current;
      try {
        current = await lstat(path);
      } catch (error) {
        if (errno(error) === "ENOENT") {
          await handle.close();
          continue;
        }
        throw error;
      }
      if (current.isSymbolicLink() || !information.isFile() || !current.isFile()) {
        throw new TrustStoreError(`${label} must be a non-symbolic regular file`);
      }
      if (!sameFile(information, selected) || !sameFile(information, current)) {
        await handle.close();
        continue;
      }
      assertOwned(information, label);
      if (!allowMultipleLinks && information.nlink !== 1) {
        throw new TrustStoreError(`${label} must not have multiple hard links`);
      }
      if (process.platform !== "win32") {
        if ((information.mode & 0o022) !== 0) {
          throw new TrustStoreError(`${label} must not be group- or world-writable`);
        }
        await handle.chmod(0o600);
      }
      if (information.size > maxBytes) {
        throw new TrustStoreError(`${label} exceeds the ${maxBytes} byte size limit`);
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  throw new TrustStoreError(`${label} changed repeatedly while it was being opened`);
}

async function readBounded(handle: FileHandle, label: string, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new TrustStoreError(`${label} exceeds the ${maxBytes} byte size limit`);
    chunks.push(buffer.subarray(0, bytesRead));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch (error) {
    throw new TrustStoreError(`${label} is not valid UTF-8`, { cause: error });
  }
}

function lockRecord(value: unknown): LockRecord {
  const input = record(value);
  if (
    input === undefined ||
    !hasOnlyKeys(input, ["version", "pid", "token", "createdAt"]) ||
    input.version !== 1 ||
    !Number.isSafeInteger(input.pid) ||
    (input.pid as number) < 1 ||
    (input.pid as number) > MAX_PROCESS_ID ||
    typeof input.token !== "string" ||
    !/^[a-f0-9]{32}$/u.test(input.token) ||
    !Number.isSafeInteger(input.createdAt) ||
    (input.createdAt as number) < 0 ||
    (input.createdAt as number) > Date.now() + LOCK_CLOCK_SKEW_MS
  ) {
    throw new TrustStoreError("Trust store lock is corrupt");
  }
  return input as unknown as LockRecord;
}

async function readLock(path: string): Promise<LockRecord | undefined> {
  const handle = await openPrivateRegularFile(path, "Trust store lock", MAX_LOCK_BYTES, true);
  if (handle === undefined) return undefined;
  try {
    let value: unknown;
    try {
      value = JSON.parse(await readBounded(handle, "Trust store lock", MAX_LOCK_BYTES)) as unknown;
    } catch (error) {
      if (error instanceof TrustStoreError) throw error;
      throw new TrustStoreError("Trust store lock is corrupt", { cause: error });
    }
    return lockRecord(value);
  } finally {
    await handle.close();
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) !== "ESRCH" && errno(error) !== "ERR_OUT_OF_RANGE";
  }
}

function lockOwnerActive(owner: LockRecord): boolean {
  return Date.now() - owner.createdAt <= LOCK_STALE_MS && processAlive(owner.pid);
}

async function writeLockCandidate(path: string, value: LockRecord): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
    0o600,
  );
  try {
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function unlinkIfOwned(path: string, token: string): Promise<boolean> {
  const current = await readLock(path);
  if (current?.token !== token) return false;
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
}

function unsupportedDirectorySync(error: unknown): boolean {
  const code = errno(error);
  return (
    process.platform === "win32" &&
    new Set(["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]).has(code ?? "")
  ) || (
    process.platform === "darwin" &&
    new Set(["EINVAL", "ENOTSUP"]).has(code ?? "")
  );
}

async function syncHandle(handle: FileHandle): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    if (!unsupportedDirectorySync(error)) throw error;
  }
}

async function syncDirectory(directory: SecureDirectory): Promise<void> {
  await syncHandle(directory.handle);
}

async function syncDirectoryPath(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | DIRECTORY | NO_FOLLOW);
    if (!(await handle.stat()).isDirectory()) {
      throw new TrustStoreError(`Cannot make trust store directory durable because ${path} is not a directory`);
    }
    await syncHandle(handle);
  } catch (error) {
    if (!unsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close();
  }
}

async function syncCreatedDirectory(
  path: string,
  firstCreated: string,
  directory: SecureDirectory,
): Promise<void> {
  await syncDirectory(directory);
  const stop = dirname(firstCreated);
  let cursor = dirname(path);
  while (true) {
    await syncDirectoryPath(cursor);
    if (cursor === stop) return;
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

async function assertDirectoriesSelected(
  paths: readonly string[],
  directory: SecureDirectory,
): Promise<void> {
  for (const path of paths) await assertDirectorySelected(path, directory);
}

async function linkCandidate(
  candidatePath: string,
  lockPath: string,
  value: LockRecord,
  directoryPaths: readonly string[],
  directory: SecureDirectory,
): Promise<() => Promise<void>> {
  await assertDirectoriesSelected(directoryPaths, directory);
  await link(candidatePath, lockPath);
  try {
    await syncDirectory(directory);
  } catch (error) {
    try {
      await unlinkIfOwned(lockPath, value.token);
    } catch (cleanupError) {
      throw new TrustStoreError("Trust store lock durability and cleanup both failed", {
        cause: new AggregateError([error, cleanupError]),
      });
    }
    throw error;
  }
  return async () => {
    await assertDirectoriesSelected(directoryPaths, directory);
    const removed = await unlinkIfOwned(lockPath, value.token);
    await assertDirectoriesSelected(directoryPaths, directory);
    if (removed) await syncDirectory(directory);
  };
}

async function acquireLock(
  lockPath: string,
  recoveryPath: string,
  directoryPaths: readonly string[],
  directory: SecureDirectory,
): Promise<() => Promise<void>> {
  const value: LockRecord = {
    version: 1,
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
    createdAt: Date.now(),
  };
  const candidatePath = `${lockPath}.${value.token}.candidate`;
  const startedAt = Date.now();
  try {
    await assertDirectoriesSelected(directoryPaths, directory);
    await writeLockCandidate(candidatePath, value);
    while (true) {
      await assertDirectoriesSelected(directoryPaths, directory);
      try {
        return await linkCandidate(candidatePath, lockPath, value, directoryPaths, directory);
      } catch (error) {
        if (errno(error) !== "EEXIST") throw error;
      }

      const owner = await readLock(lockPath);
      if (owner !== undefined && !lockOwnerActive(owner)) {
        let recoveryOwned = false;
        try {
          try {
            await link(candidatePath, recoveryPath);
            recoveryOwned = true;
          } catch (error) {
            if (errno(error) !== "EEXIST") throw error;
            const claimant = await readLock(recoveryPath);
            if (claimant !== undefined && !lockOwnerActive(claimant)) {
              await unlinkIfOwned(recoveryPath, claimant.token);
            }
          }
          if (recoveryOwned) {
            const current = await readLock(lockPath);
            if (current === undefined || !lockOwnerActive(current)) {
              if (current !== undefined) await unlinkIfOwned(lockPath, current.token);
              try {
                return await linkCandidate(candidatePath, lockPath, value, directoryPaths, directory);
              } catch (error) {
                if (errno(error) !== "EEXIST") throw error;
              }
            }
          }
        } finally {
          if (recoveryOwned) await unlinkIfOwned(recoveryPath, value.token);
        }
      }

      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new TrustStoreError(`Timed out after ${LOCK_TIMEOUT_MS}ms waiting for trust store lock`);
      }
      await delay(LOCK_RETRY_MS);
    }
  } finally {
    await unlink(candidatePath).catch(() => undefined);
  }
}

async function canonicalDirectoryPath(path: string, directory: SecureDirectory): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    throw new TrustStoreError("Trust store directory could not be canonicalized", { cause: error });
  }
  const information = await lstat(canonical);
  if (
    !information.isDirectory() ||
    information.isSymbolicLink() ||
    information.dev !== directory.device ||
    information.ino !== directory.inode
  ) {
    throw new TrustStoreError("Trust store directory changed during canonicalization");
  }
  return canonical;
}

function lockKey(path: string, directory: SecureDirectory): string {
  const name = basename(path).normalize("NFC").toLowerCase();
  return createHash("sha256")
    .update(`${directory.device}:${directory.inode}\0${name}`)
    .digest("hex")
    .slice(0, 32);
}

async function canonicalWorkspaceForRevocation(workspace: string): Promise<string> {
  const absolute = resolve(workspace);
  let cursor = absolute;
  const suffix: string[] = [];
  while (true) {
    try {
      const existing = await canonicalExistingPath(cursor);
      const canonical = join(existing, ...suffix);
      assertWorkspacePath(canonical);
      return canonical;
    } catch (error) {
      if (!new Set(["ENOENT", "ENOTDIR"]).has(errno(error) ?? "")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) {
        assertWorkspacePath(absolute);
        return absolute;
      }
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

async function cleanupCrashArtifacts(directory: string, key: string): Promise<void> {
  const candidate = new RegExp(`^\\.trust-store-${key}\\.lock\\.[a-f0-9]{32}\\.candidate$`, "u");
  const temporary = new RegExp(`^\\.trust-store-${key}\\.[0-9]+\\.[a-f0-9]{32}\\.tmp$`, "u");
  const recovery = `.trust-store-${key}.recovery`;
  const entries = await opendir(directory);
  let seen = 0;
  for await (const entry of entries) {
    seen += 1;
    if (seen > MAX_STATE_DIRECTORY_ENTRIES) {
      throw new TrustStoreError(`Trust store directory exceeds the ${MAX_STATE_DIRECTORY_ENTRIES} entry scan limit`);
    }
    const path = join(directory, entry.name);
    if (entry.name === recovery) {
      const owner = await readLock(path);
      if (owner !== undefined && !lockOwnerActive(owner)) await unlinkIfOwned(path, owner.token);
      continue;
    }
    if (candidate.test(entry.name)) {
      const information = await lstat(path);
      if (Date.now() - information.mtimeMs <= LOCK_STALE_MS) continue;
      const handle = await openPrivateRegularFile(path, "Trust store lock candidate", MAX_LOCK_BYTES, true);
      if (handle === undefined) continue;
      await handle.close();
      await unlink(path).catch((error: unknown) => {
        if (errno(error) !== "ENOENT") throw error;
      });
      continue;
    }
    if (!temporary.test(entry.name)) continue;
    const handle = await openPrivateRegularFile(path, "Trust store temporary file", MAX_TRUST_FILE_BYTES);
    if (handle === undefined) continue;
    await handle.close();
    await unlink(path).catch((error: unknown) => {
      if (errno(error) !== "ENOENT") throw error;
    });
  }
}

export class TrustStore {
  readonly #path: string;
  readonly #directory: string;

  constructor(path: string) {
    this.#path = resolve(path);
    this.#directory = dirname(this.#path);
  }

  async isTrusted(workspace: string): Promise<boolean> {
    return await this.decision(workspace) === true;
  }

  async decision(workspace: string): Promise<boolean | undefined> {
    const canonical = await canonicalExistingPath(workspace);
    assertWorkspacePath(canonical);
    const workspaces = (await this.#read()).workspaces;
    const exact = workspaces[canonical];
    if (exact !== undefined) return exact.decision === "trusted";
    return recursiveTrustParent(workspaces, canonical) === undefined ? undefined : true;
  }

  async trust(workspace: string): Promise<void> {
    const canonical = await canonicalExistingPath(workspace);
    assertWorkspacePath(canonical);
    await this.#mutate((value) => {
      value.workspaces[canonical] = { decision: "trusted", decidedAt: new Date().toISOString() };
    });
  }

  async deny(workspace: string): Promise<void> {
    const canonical = await canonicalExistingPath(workspace);
    assertWorkspacePath(canonical);
    await this.#mutate((value) => {
      value.workspaces[canonical] = { decision: "untrusted", decidedAt: new Date().toISOString() };
    });
  }

  async trustDescendants(workspace: string): Promise<void> {
    const canonical = await canonicalExistingPath(workspace);
    assertWorkspacePath(canonical);
    if (canonical === parse(canonical).root) {
      throw new TrustStoreError("Filesystem root cannot be trusted recursively");
    }
    await this.#mutate((value) => {
      value.workspaces[canonical] = {
        decision: "trusted",
        decidedAt: new Date().toISOString(),
        descendants: true,
      };
    });
  }

  async untrust(workspace: string): Promise<void> {
    const canonical = await canonicalWorkspaceForRevocation(workspace);
    await this.#mutate((value) => {
      const inherited = recursiveTrustParent(value.workspaces, canonical);
      if (inherited !== undefined) {
        throw new TrustStoreError(`Workspace inherits trust from ${inherited}; revoke that parent entry instead`);
      }
      delete value.workspaces[canonical];
    });
  }

  async list(): Promise<Array<{ workspace: string; trustedAt: string; descendants?: true }>> {
    const value = await this.#read();
    return Object.entries(value.workspaces)
      .filter(([, workspaceRecord]) => workspaceRecord.decision === "trusted")
      .map(([workspace, workspaceRecord]) => ({
        workspace,
        trustedAt: workspaceRecord.decidedAt,
        ...(workspaceRecord.descendants === true ? { descendants: true as const } : {}),
      }))
      .sort((left, right) => left.workspace.localeCompare(right.workspace));
  }

  async listDecisions(): Promise<WorkspaceTrustDecision[]> {
    const value = await this.#read();
    return Object.entries(value.workspaces)
      .map(([workspace, workspaceRecord]) => ({
        workspace,
        decision: workspaceRecord.decision === "trusted",
        decidedAt: workspaceRecord.decidedAt,
        ...(workspaceRecord.descendants === true ? { descendants: true as const } : {}),
      }))
      .sort((left, right) => left.workspace.localeCompare(right.workspace));
  }

  async #mutate(operation: (value: TrustFile) => void): Promise<void> {
    const directory = await openSecureDirectory(this.#directory, true);
    if (directory === undefined) throw new TrustStoreError("Trust store directory could not be created");
    let release: (() => Promise<void>) | undefined;
    try {
      const canonicalDirectory = await canonicalDirectoryPath(this.#directory, directory);
      const key = lockKey(this.#path, directory);
      const lockPath = join(canonicalDirectory, `.trust-store-${key}.lock`);
      const recoveryPath = join(canonicalDirectory, `.trust-store-${key}.recovery`);
      const directoryPaths = [...new Set([this.#directory, canonicalDirectory])];
      release = await acquireLock(lockPath, recoveryPath, directoryPaths, directory);
      await cleanupCrashArtifacts(canonicalDirectory, key);
      const value = await this.#read(directory);
      operation(value);
      await this.#write(value, directory, key);
    } finally {
      try {
        await release?.();
      } finally {
        await directory.handle.close();
      }
    }
  }

  async #read(expected?: SecureDirectory): Promise<TrustFile> {
    const directory = await openSecureDirectory(this.#directory, false, expected);
    if (directory === undefined) {
      if (expected !== undefined) throw new TrustStoreError("Trust store directory changed during operation");
      return empty();
    }
    try {
      const handle = await openPrivateRegularFile(this.#path, "Trust store", MAX_TRUST_FILE_BYTES);
      if (handle === undefined) return empty();
      try {
        await assertDirectorySelected(this.#directory, directory);
        return parseTrustFile(await readBounded(handle, "Trust store", MAX_TRUST_FILE_BYTES));
      } finally {
        await handle.close();
      }
    } finally {
      await directory.handle.close();
    }
  }

  async #write(value: TrustFile, expected: SecureDirectory, key: string): Promise<void> {
    const serialized = serializeTrustFile(value);
    const directory = await openSecureDirectory(this.#directory, false, expected);
    if (directory === undefined) throw new TrustStoreError("Trust store directory changed during operation");
    const temporary = join(
      this.#directory,
      `.trust-store-${key}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`,
    );
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      try {
        if (process.platform !== "win32") await handle.chmod(0o600);
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await assertDirectorySelected(this.#directory, directory);
      await rename(temporary, this.#path);
      await assertDirectorySelected(this.#directory, directory);
      await syncDirectory(directory);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    } finally {
      await directory.handle.close();
    }
  }
}
