import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";

import { sha256 } from "../tools/hash.js";
import { WorkspaceBoundary } from "../tools/paths.js";
import {
  defaultSqliteLeaseRoot,
  keyedSqliteLeasePath,
  withSqliteProcessLease,
} from "../process/sqlite-lease.js";
import {
  EXTENSION_PACKAGE_LOCK,
  EXTENSION_PACKAGE_PROVENANCE,
  LocalExtensionPackageManager,
  parseExtensionPackageSource,
  type ExtensionPackageCommands,
  type ExtensionPackageProvenance,
  type InstalledExtensionPackage,
} from "./packages.js";

export const PROJECT_PACKAGE_DECLARATION = ".rigyn/packages.json";
export const PROJECT_PACKAGE_LOCK = ".rigyn/packages.lock.json";
export const PROJECT_PACKAGE_INSTALL_ROOT = ".rigyn/packages";

const PROJECT_PACKAGE_STAGE_ROOT = ".rigyn/.packages-stage";
const PROJECT_PACKAGE_BACKUP_ROOT = ".rigyn/.packages-backup";
const PROJECT_PACKAGE_TRANSACTION = ".rigyn/.packages-transaction.json";
const PROJECT_PACKAGE_RESOLUTION_ROOT = ".rigyn/.packages-resolution";
const MAX_PROJECT_PACKAGE_FILE_BYTES = 512 * 1024;
const MAX_PROJECT_PACKAGES = 256;
const MAX_RESOURCE_FILTERS = 512;
const MAX_CONTENT_FILES = 4096;
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 150_000;
const IDENTIFIER = /^[a-z][a-z0-9._-]{0,62}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const RESOURCE_FILTER = /^(?:runtime|skill|prompt|command|theme):[^\0]+$/u;

export type ProjectPackageDeclarationSource =
  | { kind: "npm"; package: string; selector: string }
  | { kind: "git"; repository: string; ref?: string }
  | { kind: "local"; path: string };

export interface ProjectPackageDeclarationEntry {
  id: string;
  source: ProjectPackageDeclarationSource;
  disabledResources: string[];
}

export interface ProjectPackageDeclaration {
  schemaVersion: 1;
  packages: ProjectPackageDeclarationEntry[];
}

interface ProjectPackageResolvedBase {
  manifestSha256: string;
  contentSha256: string;
}

export type ProjectPackageResolvedSource =
  | (ProjectPackageResolvedBase & {
    kind: "npm";
    source: string;
    packageName: string;
    resolvedVersion: string;
    archiveSha256: string;
  })
  | (ProjectPackageResolvedBase & { kind: "git"; source: string; revision: string })
  | (ProjectPackageResolvedBase & { kind: "local"; path: string });

export interface ProjectPackageLockEntry {
  id: string;
  declaration: ProjectPackageDeclarationEntry;
  resolved: ProjectPackageResolvedSource;
}

export interface ProjectPackageLock {
  schemaVersion: 1;
  declarationSha256: string;
  packages: ProjectPackageLockEntry[];
}

export interface ProjectPackageCatalogEntry {
  id: string;
  source: ProjectPackageDeclarationSource;
  disabledResources: string[];
  resolved: ProjectPackageResolvedSource;
}

export type ProjectPackageCheckStatus =
  | "ignored"
  | "absent"
  | "unlocked"
  | "stale-lock"
  | "needs-reconcile"
  | "ready";

export interface ProjectPackageCheckResult {
  status: ProjectPackageCheckStatus;
  trusted: boolean;
  packageCount: number;
  packages: ProjectPackageCatalogEntry[];
  message: string;
}

export interface ProjectPackageReconcileResult {
  status: "ignored" | "absent" | "ready";
  changed: boolean;
  packages: InstalledExtensionPackage[];
  catalog: ProjectPackageCatalogEntry[];
}

export interface ProjectPackageUpdateOptions {
  all?: boolean;
  ids?: readonly string[];
  signal?: AbortSignal;
}

export interface ProjectPackageManagerOptions {
  workspace: string;
  projectTrusted: boolean;
  commands?: ExtensionPackageCommands;
  operationLeaseRoot?: string;
}

interface ProjectPackageState {
  declaration?: ProjectPackageDeclaration;
  lock?: ProjectPackageLock;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertAllowed(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown keys: ${unknown.join(", ")}`);
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value === "" || value.trim() !== value || value.includes("\0") || Buffer.byteLength(value) > maximum) {
    throw new Error(`${label} must be a non-empty string no larger than ${maximum} bytes`);
  }
  return value;
}

function packageId(value: unknown, label: string): string {
  const selected = requiredString(value, label, 63);
  if (!IDENTIFIER.test(selected)) throw new Error(`${label} must be a lowercase package identifier`);
  return selected;
}

function digest(value: unknown, label: string): string {
  const selected = requiredString(value, label, 64);
  if (!SHA256.test(selected)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return selected;
}

function normalizeLocalPath(value: unknown, label: string): string {
  const selected = requiredString(value, label, 4096);
  if (isAbsolute(selected) || selected.includes("\\") || selected.startsWith("../") || selected === "..") {
    throw new Error(`${label} must be a workspace-relative POSIX path`);
  }
  const normalized = posix.normalize(selected.startsWith("./") ? selected.slice(2) : selected);
  if (normalized === "." || normalized === "" || normalized.startsWith("../") || normalized !== selected.replace(/^\.\//u, "")) {
    throw new Error(`${label} must be a normalized workspace-relative POSIX path`);
  }
  if (normalized === ".rigyn" || normalized.startsWith(".rigyn/")) {
    throw new Error(`${label} cannot use the harness control directory`);
  }
  return normalized;
}

function parseDeclarationSource(value: unknown, label: string): ProjectPackageDeclarationSource {
  const input = object(value, label);
  const kind = requiredString(input.kind, `${label}.kind`, 16);
  if (kind === "npm") {
    assertAllowed(input, ["kind", "package", "selector"], label);
    const packageName = requiredString(input.package, `${label}.package`, 214);
    const selector = requiredString(input.selector, `${label}.selector`, 256);
    const parsed = parseExtensionPackageSource(`npm:${packageName}@${selector}`);
    if (parsed.kind !== "npm" || parsed.archivePath !== undefined || parsed.specifier === undefined) {
      throw new Error(`${label} must name a registry npm package`);
    }
    return { kind: "npm", package: packageName, selector };
  }
  if (kind === "git") {
    assertAllowed(input, ["kind", "repository", "ref"], label);
    const repository = requiredString(input.repository, `${label}.repository`, 4096);
    const ref = input.ref === undefined ? undefined : requiredString(input.ref, `${label}.ref`, 255);
    if (repository.includes("#")) throw new Error(`${label}.repository must not contain a ref`);
    const parsed = parseExtensionPackageSource(`git:${repository}${ref === undefined ? "" : `#${ref}`}`);
    if (parsed.kind !== "git" || parsed.repository === undefined || parsed.repositoryPath !== undefined) {
      throw new Error(`${label}.repository must be a credential-free HTTPS or SSH Git repository`);
    }
    return { kind: "git", repository: parsed.repository, ...(ref === undefined ? {} : { ref }) };
  }
  if (kind === "local") {
    assertAllowed(input, ["kind", "path"], label);
    return { kind: "local", path: normalizeLocalPath(input.path, `${label}.path`) };
  }
  throw new Error(`${label}.kind must be npm, git, or local`);
}

function parseDisabledResources(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RESOURCE_FILTERS) {
    throw new Error(`${label} must be an array with at most ${MAX_RESOURCE_FILTERS} entries`);
  }
  const selected = value.map((entry, index) => requiredString(entry, `${label}[${index}]`, 4096));
  if (selected.some((entry) => !RESOURCE_FILTER.test(entry))) {
    throw new Error(`${label} entries must be runtime, skill, prompt, command, or theme resource keys`);
  }
  return [...new Set(selected)].sort((left, right) => left.localeCompare(right));
}

function parseDeclarationEntry(value: unknown, label: string): ProjectPackageDeclarationEntry {
  const input = object(value, label);
  assertAllowed(input, ["id", "source", "disabledResources"], label);
  return {
    id: packageId(input.id, `${label}.id`),
    source: parseDeclarationSource(input.source, `${label}.source`),
    disabledResources: parseDisabledResources(input.disabledResources, `${label}.disabledResources`),
  };
}

function sortedUniquePackages<T extends { id: string }>(values: T[], label: string): T[] {
  values.sort((left, right) => left.id.localeCompare(right.id));
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]!.id === values[index]!.id) throw new Error(`${label} contains duplicate package ${values[index]!.id}`);
  }
  return values;
}

export function parseProjectPackageDeclaration(value: unknown): ProjectPackageDeclaration {
  const input = object(value, "Project package declaration");
  assertAllowed(input, ["schemaVersion", "packages"], "Project package declaration");
  if (input.schemaVersion !== 1) throw new Error("Project package declaration schemaVersion must be 1");
  if (!Array.isArray(input.packages) || input.packages.length > MAX_PROJECT_PACKAGES) {
    throw new Error(`Project package declaration packages must contain at most ${MAX_PROJECT_PACKAGES} entries`);
  }
  const packages = sortedUniquePackages(input.packages.map((entry, index) =>
    parseDeclarationEntry(entry, `Project package declaration packages[${index}]`)), "Project package declaration");
  return { schemaVersion: 1, packages };
}

function canonicalDeclaration(value: ProjectPackageDeclaration): string {
  return JSON.stringify(value);
}

export function projectPackageDeclarationSha256(value: ProjectPackageDeclaration): string {
  return sha256(canonicalDeclaration(value));
}

function parseResolvedSource(value: unknown, label: string): ProjectPackageResolvedSource {
  const input = object(value, label);
  const kind = requiredString(input.kind, `${label}.kind`, 16);
  const manifestSha256 = digest(input.manifestSha256, `${label}.manifestSha256`);
  const contentSha256 = digest(input.contentSha256, `${label}.contentSha256`);
  if (kind === "npm") {
    assertAllowed(input, ["kind", "source", "packageName", "resolvedVersion", "archiveSha256", "manifestSha256", "contentSha256"], label);
    const source = requiredString(input.source, `${label}.source`, 4096);
    const packageName = requiredString(input.packageName, `${label}.packageName`, 214);
    const resolvedVersion = requiredString(input.resolvedVersion, `${label}.resolvedVersion`, 128);
    const archiveSha256 = digest(input.archiveSha256, `${label}.archiveSha256`);
    const parsed = parseExtensionPackageSource(source);
    if (parsed.kind !== "npm" || parsed.archivePath !== undefined || parsed.specifier === undefined || !source.endsWith(`@${resolvedVersion}`)) {
      throw new Error(`${label}.source must pin the resolved npm version`);
    }
    return { kind: "npm", source, packageName, resolvedVersion, archiveSha256, manifestSha256, contentSha256 };
  }
  if (kind === "git") {
    assertAllowed(input, ["kind", "source", "revision", "manifestSha256", "contentSha256"], label);
    const source = requiredString(input.source, `${label}.source`, 4096);
    const revision = requiredString(input.revision, `${label}.revision`, 64);
    if (!GIT_REVISION.test(revision)) throw new Error(`${label}.revision must be a full Git commit ID`);
    const parsed = parseExtensionPackageSource(source);
    if (parsed.kind !== "git" || parsed.ref !== revision || parsed.repository === undefined) {
      throw new Error(`${label}.source must pin the resolved Git revision`);
    }
    return { kind: "git", source, revision, manifestSha256, contentSha256 };
  }
  if (kind === "local") {
    assertAllowed(input, ["kind", "path", "manifestSha256", "contentSha256"], label);
    return {
      kind: "local",
      path: normalizeLocalPath(input.path, `${label}.path`),
      manifestSha256,
      contentSha256,
    };
  }
  throw new Error(`${label}.kind must be npm, git, or local`);
}

function parseLockEntry(value: unknown, label: string): ProjectPackageLockEntry {
  const input = object(value, label);
  assertAllowed(input, ["id", "declaration", "resolved"], label);
  const id = packageId(input.id, `${label}.id`);
  const declaration = parseDeclarationEntry(input.declaration, `${label}.declaration`);
  if (declaration.id !== id) throw new Error(`${label} ID does not match its declaration`);
  const resolved = parseResolvedSource(input.resolved, `${label}.resolved`);
  if (resolved.kind !== declaration.source.kind) throw new Error(`${label} source kind does not match its declaration`);
  if (resolved.kind === "npm" && declaration.source.kind === "npm" && resolved.packageName !== declaration.source.package) {
    throw new Error(`${label} npm package name does not match its declaration`);
  }
  if (resolved.kind === "local" && declaration.source.kind === "local" && resolved.path !== declaration.source.path) {
    throw new Error(`${label} local path does not match its declaration`);
  }
  return { id, declaration, resolved };
}

export function parseProjectPackageLock(value: unknown): ProjectPackageLock {
  const input = object(value, "Project package lock");
  assertAllowed(input, ["schemaVersion", "declarationSha256", "packages"], "Project package lock");
  if (input.schemaVersion !== 1) throw new Error("Project package lock schemaVersion must be 1");
  const declarationSha256 = digest(input.declarationSha256, "Project package lock declarationSha256");
  if (!Array.isArray(input.packages) || input.packages.length > MAX_PROJECT_PACKAGES) {
    throw new Error(`Project package lock packages must contain at most ${MAX_PROJECT_PACKAGES} entries`);
  }
  const packages = sortedUniquePackages(input.packages.map((entry, index) =>
    parseLockEntry(entry, `Project package lock packages[${index}]`)), "Project package lock");
  const embeddedDeclaration: ProjectPackageDeclaration = {
    schemaVersion: 1,
    packages: packages.map((entry) => entry.declaration),
  };
  if (projectPackageDeclarationSha256(embeddedDeclaration) !== declarationSha256) {
    throw new Error("Project package lock declaration digest does not match its embedded declarations");
  }
  return { schemaVersion: 1, declarationSha256, packages };
}

function serializeLock(value: ProjectPackageLock): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function declarationEqual(left: ProjectPackageDeclarationEntry, right: ProjectPackageDeclarationEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function catalogEntries(lock: ProjectPackageLock): ProjectPackageCatalogEntry[] {
  return lock.packages.map((entry) => ({
    id: entry.id,
    source: { ...entry.declaration.source },
    disabledResources: [...entry.declaration.disabledResources],
    resolved: { ...entry.resolved },
  }));
}

async function optionalJson(path: string, label: string): Promise<unknown | undefined> {
  let information;
  try {
    information = await lstat(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  if (!information.isFile() || information.isSymbolicLink() || information.size > MAX_PROJECT_PACKAGE_FILE_BYTES) {
    throw new Error(`${label} must be a regular file no larger than ${MAX_PROJECT_PACKAGE_FILE_BYTES} bytes`);
  }
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${label}`, { cause: error });
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

async function packageContentSha256(packageRoot: string): Promise<string> {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const visit = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error("Project package content exceeds maximum directory depth 64");
    const names: string[] = [];
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) names.push(entry.name);
    } finally {
      await handle.close().catch(() => undefined);
    }
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      if (relativeDirectory === "" && (name === EXTENSION_PACKAGE_PROVENANCE || name === EXTENSION_PACKAGE_LOCK || name === "node_modules")) continue;
      const path = join(directory, name);
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const information = await lstat(path);
      if (information.isSymbolicLink()) throw new Error(`Project package content contains a symbolic link: ${relativePath}`);
      if (information.isDirectory()) {
        await visit(path, relativePath, depth + 1);
        continue;
      }
      if (!information.isFile()) throw new Error(`Project package content contains a non-file entry: ${relativePath}`);
      files += 1;
      bytes += information.size;
      if (files > MAX_CONTENT_FILES || bytes > MAX_CONTENT_BYTES) throw new Error("Project package content exceeds its digest bounds");
      const data = await readFile(path);
      if (data.byteLength !== information.size) throw new Error(`Project package content changed while hashing: ${relativePath}`);
      hash.update(Buffer.from(`${Buffer.byteLength(relativePath)}:`));
      hash.update(relativePath);
      hash.update(Buffer.from(`:${data.byteLength}:`));
      hash.update(data);
    }
  };
  await visit(packageRoot, "", 0);
  return hash.digest("hex");
}

function sourceSpecifier(entry: ProjectPackageDeclarationEntry, localPath?: string): string {
  if (entry.source.kind === "npm") return `npm:${entry.source.package}@${entry.source.selector}`;
  if (entry.source.kind === "git") {
    return `git:${entry.source.repository}${entry.source.ref === undefined ? "" : `#${entry.source.ref}`}`;
  }
  if (localPath === undefined) throw new Error(`Local project package ${entry.id} has not been resolved inside the workspace`);
  return localPath;
}

function exactSourceSpecifier(entry: ProjectPackageLockEntry, localPath?: string): string {
  if (entry.resolved.kind === "npm" || entry.resolved.kind === "git") return entry.resolved.source;
  if (localPath === undefined) throw new Error(`Local project package ${entry.id} has not been resolved inside the workspace`);
  return localPath;
}

function lockSha256(lock: ProjectPackageLock): string {
  return sha256(serializeLock(lock));
}

async function atomicWrite(path: string, data: Buffer): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const information = await lstat(path);
    if (!information.isDirectory() || information.isSymbolicLink()) throw new Error(`Project package transaction path is unsafe: ${path}`);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/**
 * Reconciles trusted project package declarations against an immutable lock.
 * Ordinary reconciliation never resolves tags, ranges, branches, or local edits.
 */
export class ProjectPackageManager {
  readonly #workspace: string;
  readonly #trusted: boolean;
  readonly #commands: ExtensionPackageCommands;
  readonly #operationLeaseRoot: string;
  #operations: Promise<void> = Promise.resolve();

  constructor(options: ProjectPackageManagerOptions) {
    this.#workspace = resolve(options.workspace);
    this.#trusted = options.projectTrusted;
    this.#commands = {
      ...(options.commands?.npm === undefined ? {} : { npm: { command: options.commands.npm.command, prefix: [...(options.commands.npm.prefix ?? [])] } }),
      ...(options.commands?.git === undefined ? {} : { git: { command: options.commands.git.command, prefix: [...(options.commands.git.prefix ?? [])] } }),
    };
    this.#operationLeaseRoot = resolve(options.operationLeaseRoot ?? defaultSqliteLeaseRoot());
  }

  async check(): Promise<ProjectPackageCheckResult> {
    if (!this.#trusted) return {
      status: "ignored",
      trusted: false,
      packageCount: 0,
      packages: [],
      message: "Project package declarations are ignored until the workspace is trusted.",
    };
    return await this.#serialized(async () => await this.#withOperationLock(async () => await this.#checkLocked()));
  }

  async reconcile(signal?: AbortSignal): Promise<ProjectPackageReconcileResult> {
    if (!this.#trusted) return { status: "ignored", changed: false, packages: [], catalog: [] };
    return await this.#serialized(async () => await this.#withOperationLock(async () => {
      signal?.throwIfAborted();
      await this.#recoverTransaction();
      const state = await this.#readState();
      if (state.declaration === undefined && state.lock === undefined) {
        return { status: "absent", changed: false, packages: [], catalog: [] };
      }
      const lock = this.#matchingLock(state);
      const current = await this.#installedMatches(lock);
      if (current !== undefined) {
        return { status: "ready", changed: false, packages: current, catalog: catalogEntries(lock) };
      }
      await this.#stageLock(lock, signal);
      signal?.throwIfAborted();
      await this.#commitStaged(lock);
      const packages = await this.#installed(lock);
      return { status: "ready", changed: true, packages, catalog: catalogEntries(lock) };
    }, signal));
  }

  async update(options: ProjectPackageUpdateOptions): Promise<ProjectPackageReconcileResult> {
    if (!this.#trusted) throw new Error("Project package updates require workspace trust");
    return await this.#serialized(async () => await this.#withOperationLock(async () => {
      options.signal?.throwIfAborted();
      await this.#recoverTransaction();
      const state = await this.#readState();
      if (state.declaration === undefined) throw new Error(`No ${PROJECT_PACKAGE_DECLARATION} declaration exists`);
      const requested = new Set(options.ids ?? []);
      if (options.all === true && requested.size > 0) throw new Error("Project package update accepts either IDs or all, not both");
      if (options.all !== true && requested.size === 0) throw new Error("Project package update requires one or more package IDs or all");
      const declaredIds = new Set(state.declaration.packages.map((entry) => entry.id));
      const unknown = [...requested].filter((id) => !declaredIds.has(id)).sort((left, right) => left.localeCompare(right));
      if (unknown.length > 0) throw new Error(`Project package declaration does not contain: ${unknown.join(", ")}`);
      const previous = new Map((state.lock?.packages ?? []).map((entry) => [entry.id, entry]));
      const packages: ProjectPackageLockEntry[] = [];
      await rm(join(this.#workspace, PROJECT_PACKAGE_RESOLUTION_ROOT), { recursive: true, force: true });
      try {
        for (const declaration of state.declaration.packages) {
          options.signal?.throwIfAborted();
          if (options.all === true || requested.has(declaration.id)) {
            packages.push(await this.#resolveDeclaration(declaration, options.signal));
            continue;
          }
          const existing = previous.get(declaration.id);
          if (existing === undefined || !declarationEqual(existing.declaration, declaration)) {
            throw new Error(`Project package ${declaration.id} is not locked for its current declaration; update it or use --all`);
          }
          packages.push(existing);
        }
      } finally {
        await rm(join(this.#workspace, PROJECT_PACKAGE_RESOLUTION_ROOT), { recursive: true, force: true });
      }
      const lock = parseProjectPackageLock({
        schemaVersion: 1,
        declarationSha256: projectPackageDeclarationSha256(state.declaration),
        packages,
      });
      await this.#stageLock(lock, options.signal);
      options.signal?.throwIfAborted();
      await this.#commitStaged(lock, true);
      return {
        status: "ready",
        changed: true,
        packages: await this.#installed(lock),
        catalog: catalogEntries(lock),
      };
    }, options.signal));
  }

  async #checkLocked(): Promise<ProjectPackageCheckResult> {
    await this.#recoverTransaction();
    const state = await this.#readState();
    if (state.declaration === undefined && state.lock === undefined) return {
      status: "absent", trusted: true, packageCount: 0, packages: [], message: "No project package declaration exists.",
    };
    if (state.declaration === undefined) return {
      status: "stale-lock", trusted: true, packageCount: 0, packages: [], message: "A project package lock exists without a declaration.",
    };
    if (state.lock === undefined) return {
      status: "unlocked", trusted: true, packageCount: state.declaration.packages.length, packages: [],
      message: "Project packages are declared but not locked; run `rigyn packages update --all`.",
    };
    if (state.lock.declarationSha256 !== projectPackageDeclarationSha256(state.declaration)) return {
      status: "stale-lock", trusted: true, packageCount: state.declaration.packages.length, packages: catalogEntries(state.lock),
      message: "The project package declaration changed after the lock was written; update the affected packages or use --all.",
    };
    const current = await this.#installedMatches(state.lock);
    return {
      status: current === undefined ? "needs-reconcile" : "ready",
      trusted: true,
      packageCount: state.lock.packages.length,
      packages: catalogEntries(state.lock),
      message: current === undefined
        ? "Installed project packages do not match the immutable lock; run `rigyn packages reconcile`."
        : "Installed project packages match the immutable lock.",
    };
  }

  #matchingLock(state: ProjectPackageState): ProjectPackageLock {
    if (state.declaration === undefined) throw new Error(`Project package lock exists without ${PROJECT_PACKAGE_DECLARATION}`);
    if (state.lock === undefined) throw new Error(`Project packages are not locked; run \`rigyn packages update --all\``);
    if (state.lock.declarationSha256 !== projectPackageDeclarationSha256(state.declaration)) {
      throw new Error("Project package declaration does not match its lock; run `rigyn packages update ID` or `--all`");
    }
    return state.lock;
  }

  async #readState(): Promise<ProjectPackageState> {
    const declarationPath = join(this.#workspace, ...PROJECT_PACKAGE_DECLARATION.split("/"));
    const lockPath = join(this.#workspace, ...PROJECT_PACKAGE_LOCK.split("/"));
    const declarationValue = await optionalJson(declarationPath, "Project package declaration");
    const lockValue = await optionalJson(lockPath, "Project package lock");
    return {
      ...(declarationValue === undefined ? {} : { declaration: parseProjectPackageDeclaration(declarationValue) }),
      ...(lockValue === undefined ? {} : { lock: parseProjectPackageLock(lockValue) }),
    };
  }

  async #localSource(path: string): Promise<string> {
    const boundary = await WorkspaceBoundary.create(this.#workspace);
    const lexical = boundary.lexical(path);
    const information = await lstat(lexical);
    if (!information.isDirectory() || information.isSymbolicLink()) throw new Error(`Local project package must be a real directory: ${path}`);
    const canonical = await boundary.readable(lexical);
    if (canonical !== lexical) throw new Error(`Local project package path contains a symbolic link: ${path}`);
    return canonical;
  }

  async #resolveDeclaration(declaration: ProjectPackageDeclarationEntry, signal?: AbortSignal): Promise<ProjectPackageLockEntry> {
    signal?.throwIfAborted();
    const resolutionRoot = join(this.#workspace, PROJECT_PACKAGE_RESOLUTION_ROOT, declaration.id);
    const installedRoot = join(resolutionRoot, "packages");
    await mkdir(resolutionRoot, { recursive: true, mode: 0o700 });
    const manager = new LocalExtensionPackageManager(
      { user: join(resolutionRoot, "user"), project: installedRoot },
      {},
      this.#commands,
      { operationLeaseRoot: this.#operationLeaseRoot },
    );
    const localPath = declaration.source.kind === "local" ? await this.#localSource(declaration.source.path) : undefined;
    const installed = await manager.install(
      sourceSpecifier(declaration, localPath),
      "project",
      signal === undefined ? {} : { signal },
    );
    if (installed.id !== declaration.id) throw new Error(`Project package source contains ${installed.id}, expected ${declaration.id}`);
    const contentSha256 = await packageContentSha256(installed.packageRoot);
    const resolved = this.#resolvedFromProvenance(declaration, installed.provenance, contentSha256);
    return parseLockEntry({ id: declaration.id, declaration, resolved }, `Resolved project package ${declaration.id}`);
  }

  #resolvedFromProvenance(
    declaration: ProjectPackageDeclarationEntry,
    provenance: ExtensionPackageProvenance,
    contentSha256: string,
  ): ProjectPackageResolvedSource {
    const common = { manifestSha256: provenance.manifestSha256, contentSha256 };
    if (provenance.kind === "npm" && declaration.source.kind === "npm") return {
      ...common,
      kind: "npm",
      source: `npm:${provenance.packageName}@${provenance.resolvedVersion}`,
      packageName: provenance.packageName,
      resolvedVersion: provenance.resolvedVersion,
      archiveSha256: provenance.archiveSha256,
    };
    if (provenance.kind === "git" && declaration.source.kind === "git") {
      const parsed = parseExtensionPackageSource(provenance.source);
      if (parsed.kind !== "git" || parsed.repository === undefined) throw new Error(`Resolved project package ${declaration.id} has invalid Git provenance`);
      return { ...common, kind: "git", source: `git:${parsed.repository}#${provenance.revision}`, revision: provenance.revision };
    }
    if (provenance.kind === "local" && declaration.source.kind === "local") {
      return { ...common, kind: "local", path: declaration.source.path };
    }
    throw new Error(`Resolved project package ${declaration.id} changed source kind`);
  }

  async #stageLock(lock: ProjectPackageLock, signal?: AbortSignal): Promise<void> {
    const stageRoot = join(this.#workspace, PROJECT_PACKAGE_STAGE_ROOT);
    await rm(stageRoot, { recursive: true, force: true });
    await mkdir(stageRoot, { recursive: true, mode: 0o700 });
    const manager = new LocalExtensionPackageManager(
      { user: join(stageRoot, ".user"), project: stageRoot },
      {},
      this.#commands,
      { operationLeaseRoot: this.#operationLeaseRoot },
    );
    try {
      for (const entry of lock.packages) {
        signal?.throwIfAborted();
        const localPath = entry.resolved.kind === "local" ? await this.#localSource(entry.resolved.path) : undefined;
        const installed = await manager.install(
          exactSourceSpecifier(entry, localPath),
          "project",
          signal === undefined ? {} : { signal },
        );
        if (installed.id !== entry.id) throw new Error(`Locked source contains ${installed.id}, expected ${entry.id}`);
        await this.#assertInstalledEntry(installed, entry);
      }
      signal?.throwIfAborted();
    } catch (error) {
      await rm(stageRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async #assertInstalledEntry(installed: InstalledExtensionPackage, entry: ProjectPackageLockEntry): Promise<void> {
    const provenance = installed.provenance;
    if (provenance.manifestSha256 !== entry.resolved.manifestSha256) {
      throw new Error(`Project package ${entry.id} manifest digest does not match its lock`);
    }
    if (await packageContentSha256(installed.packageRoot) !== entry.resolved.contentSha256) {
      throw new Error(`Project package ${entry.id} content digest does not match its lock`);
    }
    if (entry.resolved.kind === "npm") {
      if (provenance.kind !== "npm" || provenance.packageName !== entry.resolved.packageName
        || provenance.resolvedVersion !== entry.resolved.resolvedVersion || provenance.archiveSha256 !== entry.resolved.archiveSha256) {
        throw new Error(`Project package ${entry.id} npm provenance does not match its lock`);
      }
    } else if (entry.resolved.kind === "git") {
      if (provenance.kind !== "git" || provenance.revision !== entry.resolved.revision) {
        throw new Error(`Project package ${entry.id} Git revision does not match its lock`);
      }
    } else if (provenance.kind !== "local") {
      throw new Error(`Project package ${entry.id} local provenance does not match its lock`);
    }
  }

  async #installed(lock: ProjectPackageLock): Promise<InstalledExtensionPackage[]> {
    const manager = new LocalExtensionPackageManager(
      { user: join(this.#workspace, ".rigyn", ".unused"), project: join(this.#workspace, PROJECT_PACKAGE_INSTALL_ROOT) },
      {},
      {},
      { operationLeaseRoot: this.#operationLeaseRoot },
    );
    const installed = await manager.list("project");
    for (const entry of lock.packages) {
      const selected = installed.find((value) => value.id === entry.id);
      if (selected === undefined) throw new Error(`Committed project package ${entry.id} is missing`);
      await this.#assertInstalledEntry(selected, entry);
    }
    return installed;
  }

  async #installedMatches(lock: ProjectPackageLock): Promise<InstalledExtensionPackage[] | undefined> {
    const root = join(this.#workspace, PROJECT_PACKAGE_INSTALL_ROOT);
    if (!await directoryExists(root)) return lock.packages.length === 0 ? [] : undefined;
    let installed: InstalledExtensionPackage[];
    try {
      installed = await this.#installed(lock);
    } catch {
      return undefined;
    }
    if (installed.length !== lock.packages.length) return undefined;
    const expected = lock.packages.map((entry) => entry.id);
    const actual = installed.map((entry) => entry.id).sort((left, right) => left.localeCompare(right));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return undefined;
    const names = (await readdir(root)).filter((name) => name !== EXTENSION_PACKAGE_LOCK).sort((left, right) => left.localeCompare(right));
    if (JSON.stringify(names) !== JSON.stringify(expected)) return undefined;
    return installed;
  }

  async #commitStaged(lock: ProjectPackageLock, writeLock = false): Promise<void> {
    const stage = join(this.#workspace, PROJECT_PACKAGE_STAGE_ROOT);
    const active = join(this.#workspace, PROJECT_PACKAGE_INSTALL_ROOT);
    const backup = join(this.#workspace, PROJECT_PACKAGE_BACKUP_ROOT);
    const transaction = join(this.#workspace, PROJECT_PACKAGE_TRANSACTION);
    const lockPath = join(this.#workspace, PROJECT_PACKAGE_LOCK);
    await rm(backup, { recursive: true, force: true });
    await atomicWrite(transaction, Buffer.from(`${JSON.stringify({ schemaVersion: 1, lockSha256: lockSha256(lock) })}\n`));
    let activeMoved = false;
    let stagedActivated = false;
    try {
      if (await directoryExists(active)) {
        await rename(active, backup);
        activeMoved = true;
      }
      await rename(stage, active);
      stagedActivated = true;
      if (writeLock) await atomicWrite(lockPath, serializeLock(lock));
      await rm(backup, { recursive: true, force: true });
      await rm(transaction, { force: true });
    } catch (error) {
      if (stagedActivated) await rm(active, { recursive: true, force: true }).catch(() => undefined);
      if (activeMoved) await rename(backup, active).catch((restoreError) => {
        throw new AggregateError([error, restoreError], `Unable to roll back project package transaction; previous packages remain in ${backup}`);
      });
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      await rm(transaction, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #recoverTransaction(): Promise<void> {
    const stage = join(this.#workspace, PROJECT_PACKAGE_STAGE_ROOT);
    const active = join(this.#workspace, PROJECT_PACKAGE_INSTALL_ROOT);
    const backup = join(this.#workspace, PROJECT_PACKAGE_BACKUP_ROOT);
    const transactionPath = join(this.#workspace, PROJECT_PACKAGE_TRANSACTION);
    const transactionValue = await optionalJson(transactionPath, "Project package transaction");
    if (transactionValue === undefined) {
      await rm(stage, { recursive: true, force: true });
      if (await directoryExists(backup)) {
        if (await directoryExists(active)) await rm(backup, { recursive: true, force: true });
        else await rename(backup, active);
      }
      return;
    }
    const input = object(transactionValue, "Project package transaction");
    assertAllowed(input, ["schemaVersion", "lockSha256"], "Project package transaction");
    if (input.schemaVersion !== 1) throw new Error("Project package transaction schemaVersion must be 1");
    const expectedLockSha256 = digest(input.lockSha256, "Project package transaction lockSha256");
    const rawLock = await optionalJson(join(this.#workspace, PROJECT_PACKAGE_LOCK), "Project package lock");
    const committed = rawLock !== undefined && lockSha256(parseProjectPackageLock(rawLock)) === expectedLockSha256;
    if (committed) {
      if (!await directoryExists(active) && await directoryExists(backup)) await rename(backup, active);
      await rm(backup, { recursive: true, force: true });
    } else if (await directoryExists(backup)) {
      await rm(active, { recursive: true, force: true });
      await rename(backup, active);
    } else if (await directoryExists(active)) {
      await rm(active, { recursive: true, force: true });
    }
    await rm(stage, { recursive: true, force: true });
    await rm(transactionPath, { force: true });
  }

  async #prepareHarnessDirectory(): Promise<void> {
    const boundary = await WorkspaceBoundary.create(this.#workspace);
    const harnessDirectory = boundary.lexical(".rigyn");
    await boundary.writable(harnessDirectory, { createParents: true });
    await mkdir(harnessDirectory, { recursive: true, mode: 0o700 });
    const information = await lstat(harnessDirectory);
    if (!information.isDirectory() || information.isSymbolicLink() || await realpath(harnessDirectory) !== harnessDirectory) {
      throw new Error("Project harness directory must be a real directory inside the workspace");
    }
  }

  async #withOperationLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.#prepareHarnessDirectory();
    const lockPath = await keyedSqliteLeasePath(this.#operationLeaseRoot, "project-packages", this.#workspace);
    return await withSqliteProcessLease(lockPath, operation, {
      timeoutMs: LOCK_TIMEOUT_MS,
      retryMs: 50,
      label: "project package operation lock",
    }, signal);
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation, operation);
    this.#operations = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function projectPackageResourceFilters(catalog: readonly ProjectPackageCatalogEntry[]): Record<string, string[]> {
  return Object.fromEntries(catalog
    .filter((entry) => entry.disabledResources.length > 0)
    .map((entry) => [entry.id, [...entry.disabledResources]]));
}

export function mergeProjectPackageResourceFilters(
  configured: Readonly<Record<string, readonly string[]>>,
  declared: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const ids = [...new Set([...Object.keys(configured), ...Object.keys(declared)])].sort((left, right) => left.localeCompare(right));
  return Object.fromEntries(ids.map((id) => [id, [...new Set([...(configured[id] ?? []), ...(declared[id] ?? [])])]
    .sort((left, right) => left.localeCompare(right))]));
}
