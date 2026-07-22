import { constants, readFileSync, realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { satisfies, valid as validVersion, validRange } from "semver";

import { getAgentDir } from "../config/paths.js";
import { DefaultPackageManager, type ResolvedPaths } from "../core/package-manager.js";
import { SettingsManager, type PackageSource } from "../core/settings-manager.js";
import {
  gitRepositoryProtocol,
  resolveGitRemoteRef,
  runGitCommand,
  validateGitRef,
  type GitProtocol,
} from "../process/git-runner.js";
import { runProcess } from "../process/runner.js";
import { sha256 } from "../tools/hash.js";
import { WorkspaceBoundary } from "../tools/paths.js";
import { parseGitUrl } from "../utils/git.js";
import { RIGYN_VERSION } from "../version.js";
import { parseLegacyExtensionManifest } from "./legacy-manifest.js";
import {
  loadDirectExtensions,
  type RuntimeDirectPathMetadata,
  type RuntimeExtensionHost,
} from "./runtime.js";

export const PROJECT_PACKAGE_DECLARATION = ".rigyn/packages.json";
export const PROJECT_PACKAGE_LOCK = ".rigyn/packages.lock.json";
export const PROJECT_PACKAGE_INSTALL_ROOT = ".rigyn/packages";

const PROJECT_PACKAGE_STAGE_ROOT = ".rigyn/.packages-stage";
const PROJECT_PACKAGE_BACKUP_ROOT = ".rigyn/.packages-backup";
const PROJECT_PACKAGE_TRANSACTION = ".rigyn/.packages-transaction.json";
const PROJECT_PACKAGE_RESOLUTION_ROOT = ".rigyn/.packages-resolution";
const PROJECT_PACKAGE_PROVENANCE = ".rigyn-package.json";
const MAX_PROJECT_PACKAGE_FILE_BYTES = 512 * 1024;
const MAX_PROJECT_PACKAGE_LOCK_BYTES = 24 * 1024 * 1024;
const MAX_DEPENDENCY_LOCK_BYTES = 2 * 1024 * 1024;
const MAX_DEPENDENCY_LOCK_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_PROJECT_PACKAGES = 256;
const MAX_RESOURCE_FILTERS = 512;
const MAX_CONTENT_FILES = 4096;
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 150_000;
const MATERIALIZATION_QUOTA_POLL_MS = 10;
const LOCK_TIMEOUT_MS = 150_000;
const INCOMPLETE_LOCK_STALE_MS = 5_000;
const IDENTIFIER = /^[a-z][a-z0-9._-]{0,62}$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const RESOURCE_FILTER_KIND = new Set(["runtime", "skill", "prompt", "command", "theme"]);
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function comparePortable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareLegacy(left: string, right: string): number {
  return left.localeCompare(right);
}

function portablePathKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function assertPortableName(value: string, label: string): void {
  if (
    value.normalize("NFC") !== value
    || value.endsWith(".")
    || value.endsWith(" ")
    || /[<>:"\/\\|?*\x00-\x1f]/u.test(value)
    || WINDOWS_RESERVED_NAME.test(value)
  ) throw new Error(`${label} is not portable across supported filesystems`);
}

function assertPortableNames(values: readonly string[], label: string): void {
  const seen = new Map<string, string>();
  for (const value of values) {
    assertPortableName(value, `${label} ${value}`);
    const key = portablePathKey(value);
    const previous = seen.get(key);
    if (previous !== undefined && previous !== value) {
      throw new Error(`${label} contains a case or Unicode-normalization collision: ${previous}, ${value}`);
    }
    seen.set(key, value);
  }
}

function packageDirectoryName(id: string, schemaVersion: 1 | 2): string {
  if (schemaVersion === 1 || (!id.endsWith(".") && !WINDOWS_RESERVED_NAME.test(id))) return id;
  return `_${id}${id.endsWith(".") ? "_" : ""}`;
}

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

export interface ProjectPackageDependencyLock {
  sha256: string;
  content: string;
}

interface ProjectPackageResolvedBase {
  manifestSha256: string;
  contentSha256: string;
  dependencyLock?: ProjectPackageDependencyLock;
  dependencyContentSha256?: string;
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
  schemaVersion: 1 | 2;
  declarationGrammar?: "legacy";
  declarationSha256: string;
  packages: ProjectPackageLockEntry[];
}

export interface ProjectPackageCatalogEntry {
  id: string;
  source: ProjectPackageDeclarationSource;
  disabledResources: string[];
  resolved: ProjectPackageCatalogResolvedSource;
}

export type ProjectPackageCatalogResolvedSource =
  | (Omit<Extract<ProjectPackageResolvedSource, { kind: "npm" }>, "dependencyLock"> & { dependencyLockSha256?: string })
  | (Omit<Extract<ProjectPackageResolvedSource, { kind: "git" }>, "dependencyLock"> & { dependencyLockSha256?: string })
  | (Omit<Extract<ProjectPackageResolvedSource, { kind: "local" }>, "dependencyLock"> & { dependencyLockSha256?: string });

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

export type ProjectPackageProvenance = {
  schemaVersion: 1;
  id: string;
  scope: "project";
  installedAt: string;
  updatedAt?: string;
  manifestSha256: string;
  dependencyPlatformContentSha256?: string;
} & (
  | { kind: "local"; sourcePath: string }
  | { kind: "npm"; source: string; packageName: string; resolvedVersion: string; archiveSha256: string }
  | { kind: "git"; source: string; revision: string }
);

export interface InstalledProjectPackage {
  id: string;
  name: string;
  version?: string;
  description?: string;
  scope: "project";
  packageRoot: string;
  manifestPath: string;
  manifestModified: false;
  provenance: ProjectPackageProvenance;
}

export interface ProjectPackageReconcileResult {
  status: "ignored" | "absent" | "ready";
  changed: boolean;
  packages: InstalledProjectPackage[];
  catalog: ProjectPackageCatalogEntry[];
}

export interface ProjectPackageUpdateOptions {
  all?: boolean;
  ids?: readonly string[];
  signal?: AbortSignal;
}

export interface ProjectPackageCommand {
  command: string;
  prefix?: readonly string[];
}

export interface ProjectPackageCommands {
  npm?: ProjectPackageCommand;
  git?: ProjectPackageCommand;
}

export interface ProjectPackageManagerOptions {
  workspace: string;
  projectTrusted: boolean;
  commands?: ProjectPackageCommands;
  operationLeaseRoot?: string;
  attestationRoot?: string;
  offline?: boolean;
}

interface ProjectPackageState {
  declaration?: ProjectPackageDeclaration;
  lock?: ProjectPackageLock;
  legacyDeclarationGrammar?: boolean;
}

interface PackageManifest {
  name: string;
  version?: string;
  description?: string;
  extensionId?: string;
  packageName?: string;
  packageVersion?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function offlineEnvironment(): boolean {
  return /^(?:1|true|yes)$/iu.test(process.env.RIGYN_OFFLINE ?? "");
}

export function projectPackagePlatformFingerprint(input: {
  platform: string;
  architecture: string;
  nodeAbi?: string;
  glibcVersionRuntime?: string;
}): string {
  const libc = input.platform === "linux"
    ? (input.glibcVersionRuntime === undefined ? "musl" : "glibc")
    : "libc-na";
  return `${input.platform}/${input.architecture}/${libc}/node-abi-${input.nodeAbi ?? "unknown"}`;
}

function dependencyPlatformFingerprint(): string {
  const report = process.platform === "linux"
    ? process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } }
    : undefined;
  const glibcVersionRuntime = typeof report?.header?.glibcVersionRuntime === "string"
    ? report.header.glibcVersionRuntime
    : undefined;
  return projectPackagePlatformFingerprint({
    platform: process.platform,
    architecture: process.arch,
    nodeAbi: process.versions.modules,
    ...(glibcVersionRuntime === undefined ? {} : { glibcVersionRuntime }),
  });
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function assertMaterializationQuota(root: string): Promise<void> {
  let entryCount = 0;
  let bytes = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error("Project package staging quota exceeds maximum directory depth 64");
    let handle;
    try {
      handle = await opendir(directory);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    try {
      for await (const entry of handle) {
        const path = join(directory, entry.name);
        let information;
        try {
          information = await lstat(path);
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        entryCount += 1;
        if (entryCount > MAX_CONTENT_FILES) {
          throw new Error(`Project package staging quota exceeds ${MAX_CONTENT_FILES} entries`);
        }
        if (information.isDirectory() && !information.isSymbolicLink()) {
          await visit(path, depth + 1);
          continue;
        }
        if (information.isFile()) bytes += information.size;
        if (bytes > MAX_CONTENT_BYTES) {
          throw new Error(`Project package staging quota exceeds ${MAX_CONTENT_BYTES} bytes`);
        }
      }
    } catch (error) {
      if (!missing(error)) throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }
  };
  let information;
  try {
    information = await lstat(root);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error("Project package staging quota root must be a real directory");
  }
  await visit(root, 0);
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
  if (isAbsolute(selected) || /^[A-Za-z]:/u.test(selected) || selected.includes("\\") || selected.startsWith("../") || selected === "..") {
    throw new Error(`${label} must be a workspace-relative POSIX path`);
  }
  const normalized = posix.normalize(selected.startsWith("./") ? selected.slice(2) : selected);
  if (normalized === "." || normalized === "" || normalized.startsWith("../") || normalized !== selected.replace(/^\.\//u, "")) {
    throw new Error(`${label} must be a normalized workspace-relative POSIX path`);
  }
  if (normalized === ".rigyn" || normalized.startsWith(".rigyn/")) {
    throw new Error(`${label} cannot use the project control directory`);
  }
  return normalized;
}

function npmPackageName(value: unknown, label: string): string {
  const selected = requiredString(value, label, 214);
  if (!PACKAGE_NAME.test(selected)) throw new Error(`${label} must be a registry package name`);
  return selected;
}

function repository(value: unknown, label: string): string {
  const selected = requiredString(value, label, 4096);
  if (selected.includes("#")) throw new Error(`${label} must not contain a ref`);
  const parsed = parseGitUrl(`git:${selected}`);
  if (parsed === undefined || parsed.ref !== undefined) {
    throw new Error(`${label} must be a credential-free HTTPS or SSH Git repository`);
  }
  try { gitRepositoryProtocol(parsed.repo); }
  catch { throw new Error(`${label} must be a credential-free HTTPS or SSH Git repository`); }
  return parsed.repo;
}

function legacyRepository(value: unknown, label: string): string {
  const selected = requiredString(value, label, 4096);
  if (selected.includes("#")) throw new Error(`${label} must not contain a ref`);
  if (selected.startsWith("https://") || selected.startsWith("ssh://")) {
    let url: URL;
    try {
      url = new URL(selected);
    } catch {
      throw new Error(`${label} must be a credential-free HTTPS or SSH Git repository`);
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "ssh:")
      || url.password !== ""
      || url.search !== ""
      || url.hash !== ""
      || (url.protocol === "https:" && url.username !== "")
      || (url.protocol === "ssh:" && url.username !== "" && !/^[A-Za-z0-9._-]{1,64}$/u.test(url.username))
      || url.hostname === ""
      || url.pathname === ""
      || url.pathname === "/"
    ) throw new Error(`${label} must be a credential-free HTTPS or SSH Git repository`);
    const normalized = url.toString();
    try { gitRepositoryProtocol(normalized); }
    catch { throw new Error(`${label} must be a credential-free HTTPS or SSH Git repository`); }
    return normalized;
  }
  const scp = selected.match(/^(?:([A-Za-z0-9._-]{1,64})@)?([A-Za-z0-9.-]{1,253}):([A-Za-z0-9._~/-]{1,2048})$/u);
  if (
    scp !== null
    && !scp[2]!.startsWith(".")
    && !scp[2]!.endsWith(".")
    && !scp[3]!.startsWith("/")
    && !scp[3]!.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    try { gitRepositoryProtocol(selected); }
    catch { throw new Error(`${label} must be a credential-free HTTPS or SSH Git repository`); }
    return selected;
  }
  if (/^[A-Za-z0-9.-]{1,253}\/[A-Za-z0-9._~/-]{1,2048}$/u.test(selected)) {
    const slash = selected.indexOf("/");
    const host = selected.slice(0, slash);
    const repositoryPath = selected.slice(slash + 1);
    if (
      host.includes(".")
      && !host.startsWith(".")
      && !host.endsWith(".")
      && !repositoryPath.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      const normalized = `https://${selected}`;
      try { gitRepositoryProtocol(normalized); }
      catch { throw new Error(`${label} must be a credential-free HTTPS or SSH Git repository`); }
      return normalized;
    }
  }
  throw new Error(`${label} must be a credential-free HTTPS or SSH Git repository`);
}

function parsedGitSource(
  source: string,
  legacyGrammar: boolean,
): { repo: string; ref?: string } | undefined {
  if (!legacyGrammar) {
    const parsed = parseGitUrl(source);
    return parsed === undefined ? undefined : { repo: parsed.repo, ...(parsed.ref === undefined ? {} : { ref: parsed.ref }) };
  }
  if (!source.startsWith("git:")) return undefined;
  const raw = source.slice(4);
  const marker = raw.lastIndexOf("#");
  if (marker <= 0 || marker === raw.length - 1) return undefined;
  try {
    return {
      repo: legacyRepository(raw.slice(0, marker), "Git source repository"),
      ref: gitRef(raw.slice(marker + 1), "Git source ref"),
    };
  } catch {
    return undefined;
  }
}

function gitRef(value: unknown, label: string): string {
  const selected = requiredString(value, label, 255);
  try { return validateGitRef(selected); }
  catch { throw new Error(`${label} must be a safe Git ref`); }
}

function parseDeclarationSource(value: unknown, label: string, legacyGrammar = false): ProjectPackageDeclarationSource {
  const input = object(value, label);
  const kind = requiredString(input.kind, `${label}.kind`, 16);
  if (kind === "npm") {
    assertAllowed(input, ["kind", "package", "selector"], label);
    const packageName = npmPackageName(input.package, `${label}.package`);
    const selector = requiredString(input.selector, `${label}.selector`, 256);
    if (validRange(selector) === null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(selector)) {
      throw new Error(`${label}.selector must be a semver range or plain npm dist-tag`);
    }
    return { kind: "npm", package: packageName, selector };
  }
  if (kind === "git") {
    assertAllowed(input, ["kind", "repository", "ref"], label);
    const selected = legacyGrammar
      ? legacyRepository(input.repository, `${label}.repository`)
      : repository(input.repository, `${label}.repository`);
    const ref = input.ref === undefined ? undefined : gitRef(input.ref, `${label}.ref`);
    return { kind: "git", repository: selected, ...(ref === undefined ? {} : { ref }) };
  }
  if (kind === "local") {
    assertAllowed(input, ["kind", "path"], label);
    return { kind: "local", path: normalizeLocalPath(input.path, `${label}.path`) };
  }
  throw new Error(`${label}.kind must be npm, git, or local`);
}

function parseDisabledResources(
  value: unknown,
  label: string,
  comparator: (left: string, right: string) => number,
  legacyGrammar = false,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RESOURCE_FILTERS) {
    throw new Error(`${label} must be an array with at most ${MAX_RESOURCE_FILTERS} entries`);
  }
  const selected = value.map((entry, index) => requiredString(entry, `${label}[${index}]`, 4096));
  if (legacyGrammar) {
    if (selected.some((entry) => !/^(?:runtime|skill|prompt|command|theme):[^\0]+$/u.test(entry))) {
      throw new Error(`${label} entries must be runtime, skill, prompt, command, or theme resource keys`);
    }
    return [...new Set(selected)].sort(comparator);
  }
  for (const entry of selected) {
    const separator = entry.indexOf(":");
    const kind = entry.slice(0, separator);
    const key = entry.slice(separator + 1);
    if (!RESOURCE_FILTER_KIND.has(kind) || separator < 1 || key === "") {
      throw new Error(`${label} entries must be runtime, skill, prompt, command, or theme resource keys`);
    }
    if (kind !== "command" && (
      key.includes("\\")
      || key.startsWith("/")
      || /^[A-Za-z]:/u.test(key)
      || key.split("/").some((component) => component === "..")
      || posix.normalize(key) !== key
    )) {
      throw new Error(`${label} resource paths must be normalized package-relative names or globs`);
    }
  }
  return [...new Set(selected)].sort(comparator);
}

function parseDeclarationEntry(
  value: unknown,
  label: string,
  comparator = comparePortable,
  legacyGrammar = false,
): ProjectPackageDeclarationEntry {
  const input = object(value, label);
  assertAllowed(input, ["id", "source", "disabledResources"], label);
  return {
    id: packageId(input.id, `${label}.id`),
    source: parseDeclarationSource(input.source, `${label}.source`, legacyGrammar),
    disabledResources: parseDisabledResources(input.disabledResources, `${label}.disabledResources`, comparator, legacyGrammar),
  };
}

function sortedUniquePackages<T extends { id: string }>(
  values: T[],
  label: string,
  comparator = comparePortable,
): T[] {
  values.sort((left, right) => comparator(left.id, right.id));
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]!.id === values[index]!.id) throw new Error(`${label} contains duplicate package ${values[index]!.id}`);
  }
  return values;
}

function parseProjectPackageDeclarationValue(
  value: unknown,
  legacyOrdering = false,
  legacyGrammar = legacyOrdering,
): ProjectPackageDeclaration {
  const input = object(value, "Project package declaration");
  assertAllowed(input, ["schemaVersion", "packages"], "Project package declaration");
  if (input.schemaVersion !== 1) throw new Error("Project package declaration schemaVersion must be 1");
  if (!Array.isArray(input.packages) || input.packages.length > MAX_PROJECT_PACKAGES) {
    throw new Error(`Project package declaration packages must contain at most ${MAX_PROJECT_PACKAGES} entries`);
  }
  const comparator = legacyOrdering ? compareLegacy : comparePortable;
  const packages = sortedUniquePackages(input.packages.map((entry, index) =>
    parseDeclarationEntry(entry, `Project package declaration packages[${index}]`, comparator, legacyGrammar)), "Project package declaration", comparator);
  return { schemaVersion: 1, packages };
}

export function parseProjectPackageDeclaration(value: unknown): ProjectPackageDeclaration {
  return parseProjectPackageDeclarationValue(value, true, true);
}

function parseDeclarationForLock(
  value: unknown,
  lock: ProjectPackageLock | undefined,
): { declaration: ProjectPackageDeclaration; legacyGrammar: boolean } {
  if (lock?.schemaVersion === 1) {
    return { declaration: parseProjectPackageDeclarationValue(value, true, true), legacyGrammar: true };
  }
  if (lock?.declarationGrammar === "legacy") {
    return { declaration: parseProjectPackageDeclarationValue(value, false, true), legacyGrammar: true };
  }
  if (lock !== undefined) {
    return { declaration: parseProjectPackageDeclarationValue(value), legacyGrammar: false };
  }
  try {
    return { declaration: parseProjectPackageDeclarationValue(value), legacyGrammar: false };
  } catch (strictError) {
    try {
      return { declaration: parseProjectPackageDeclarationValue(value, false, true), legacyGrammar: true };
    } catch {
      throw strictError;
    }
  }
}

export function projectPackageDeclarationSha256(value: ProjectPackageDeclaration): string {
  return sha256(JSON.stringify(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Dependency lock contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const input = object(value, "Dependency lock value");
  return `{${Object.keys(input).sort(comparePortable)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(",")}}`;
}

function assertDependencyLockSafe(
  value: unknown,
  path = "package-lock.json",
  depth = 0,
  budget = { nodes: 0 },
): void {
  budget.nodes += 1;
  if (depth > 64 || budget.nodes > 100_000) throw new Error("Dependency lock exceeds structural bounds");
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertDependencyLockSafe(entry, `${path}[${index}]`, depth + 1, budget));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const field = key.slice(key.lastIndexOf(":") + 1);
    if (/^(?:_?auth|_?authToken|npmAuthToken|accessToken|authorization|_?token|_?password|_?secret)$/iu.test(field)) {
      throw new Error(`Dependency lock contains a credential field at ${path}`);
    }
    for (const candidate of [key, typeof entry === "string" ? entry : undefined]) {
      if (candidate === undefined) continue;
      if (/^(?:\.{0,2}\/|\/|[A-Za-z]:[\\/]|(?:file|link|workspace):)/iu.test(candidate)) {
        throw new Error(`Dependency lock contains a non-portable dependency source at ${path}`);
      }
      const urlValue = candidate.startsWith("git+") ? candidate.slice("git+".length) : candidate;
      if (!urlValue.includes("://")) continue;
      try {
        const url = new URL(urlValue);
        if (!new Set(["http:", "https:", "ssh:", "git:"]).has(url.protocol)) {
          throw new Error(`Dependency lock contains an unsupported URL at ${path}`);
        }
        if (
          url.password !== ""
          || url.search !== ""
          || (url.username !== "" && (url.protocol !== "ssh:" || url.username !== "git"))
        ) {
          throw new Error(`Dependency lock contains a credential-bearing URL at ${path}`);
        }
        if (/^(?:git\+|ssh:|git:)/iu.test(candidate)) {
          const revision = url.hash.slice(1);
          if (!GIT_REVISION.test(revision)) {
            throw new Error(`Dependency lock contains a Git source without a full revision at ${path}`);
          }
        } else if (url.hash !== "") {
          throw new Error(`Dependency lock contains a URL fragment at ${path}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Dependency lock")) throw error;
        throw new Error(`Dependency lock contains an invalid URL at ${path}`, { cause: error });
      }
    }
    if (typeof entry === "string") {
      // String values were screened together with object keys above.
    }
    if (key === "link" && entry === true) throw new Error(`Dependency lock contains a linked dependency at ${path}`);
    assertDependencyLockSafe(entry, `${path}.${key}`, depth + 1, budget);
  }
}

function dependencyLock(value: unknown, label: string): ProjectPackageDependencyLock {
  const input = object(value, label);
  assertAllowed(input, ["sha256", "content"], label);
  const expectedSha256 = digest(input.sha256, `${label}.sha256`);
  if (
    typeof input.content !== "string"
    || input.content === ""
    || input.content.includes("\0")
    || Buffer.byteLength(input.content) > MAX_DEPENDENCY_LOCK_BYTES
  ) {
    throw new Error(`${label}.content must be a non-empty string no larger than ${MAX_DEPENDENCY_LOCK_BYTES} bytes`);
  }
  const content = input.content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`${label}.content is not valid JSON`, { cause: error });
  }
  const root = object(parsed, `${label}.content`);
  if (root.lockfileVersion !== 2 && root.lockfileVersion !== 3) {
    throw new Error(`${label}.content must use npm lockfileVersion 2 or 3`);
  }
  const packages = object(root.packages, `${label}.content packages`);
  const portablePaths = new Map<string, string>();
  for (const key of Object.keys(packages)) {
    if (key !== "" && (!key.startsWith("node_modules/") || key.includes("\\") || key.split("/").includes(".."))) {
      throw new Error(`${label}.content contains an unsafe package path`);
    }
    if (key === "") continue;
    for (const component of key.split("/")) assertPortableName(component, `${label}.content package path ${key}`);
    const portable = portablePathKey(key);
    const previous = portablePaths.get(portable);
    if (previous !== undefined && previous !== key) {
      throw new Error(`${label}.content contains a case or Unicode-normalization path collision`);
    }
    portablePaths.set(portable, key);
  }
  assertDependencyLockSafe(root);
  const canonical = `${canonicalJson(root)}\n`;
  if (content !== canonical || sha256(Buffer.from(content)) !== expectedSha256) {
    throw new Error(`${label} must contain canonical content matching its digest`);
  }
  return { sha256: expectedSha256, content };
}

function parseResolvedSource(
  value: unknown,
  label: string,
  schemaVersion: 1 | 2,
  legacyGrammar = false,
): ProjectPackageResolvedSource {
  const input = object(value, label);
  const kind = requiredString(input.kind, `${label}.kind`, 16);
  const manifestSha256 = digest(input.manifestSha256, `${label}.manifestSha256`);
  const contentSha256 = digest(input.contentSha256, `${label}.contentSha256`);
  const dependencyContentSha256 = input.dependencyContentSha256 === undefined
    ? undefined
    : digest(input.dependencyContentSha256, `${label}.dependencyContentSha256`);
  const selectedDependencyLock = input.dependencyLock === undefined
    ? undefined
    : dependencyLock(input.dependencyLock, `${label}.dependencyLock`);
  if (schemaVersion === 1 && (selectedDependencyLock !== undefined || dependencyContentSha256 !== undefined)) {
    throw new Error(`${label} legacy locks cannot contain dependency snapshots`);
  }
  if (schemaVersion === 2 && (selectedDependencyLock === undefined) !== (dependencyContentSha256 === undefined)) {
    throw new Error(`${label} dependency lock and dependency content digest must appear together`);
  }
  if (kind === "npm") {
    assertAllowed(input, ["kind", "source", "packageName", "resolvedVersion", "archiveSha256", "manifestSha256", "contentSha256", "dependencyLock", "dependencyContentSha256"], label);
    const source = requiredString(input.source, `${label}.source`, 4096);
    const packageName = npmPackageName(input.packageName, `${label}.packageName`);
    const resolvedVersion = requiredString(input.resolvedVersion, `${label}.resolvedVersion`, 128);
    const archiveSha256 = digest(input.archiveSha256, `${label}.archiveSha256`);
    if (validVersion(resolvedVersion) === null || source !== `npm:${packageName}@${resolvedVersion}`) {
      throw new Error(`${label}.source must pin the resolved npm version`);
    }
    return { kind: "npm", source, packageName, resolvedVersion, archiveSha256, manifestSha256, contentSha256,
      ...(selectedDependencyLock === undefined ? {} : {
        dependencyLock: selectedDependencyLock,
        dependencyContentSha256: dependencyContentSha256!,
      }) };
  }
  if (kind === "git") {
    assertAllowed(input, ["kind", "source", "revision", "manifestSha256", "contentSha256", "dependencyLock", "dependencyContentSha256"], label);
    const source = requiredString(input.source, `${label}.source`, 4096);
    const revision = requiredString(input.revision, `${label}.revision`, 64);
    const parsed = parsedGitSource(source, legacyGrammar);
    if (!GIT_REVISION.test(revision) || parsed?.ref !== revision) {
      throw new Error(`${label}.source must pin a full Git commit ID`);
    }
    return { kind: "git", source, revision, manifestSha256, contentSha256,
      ...(selectedDependencyLock === undefined ? {} : {
        dependencyLock: selectedDependencyLock,
        dependencyContentSha256: dependencyContentSha256!,
      }) };
  }
  if (kind === "local") {
    assertAllowed(input, ["kind", "path", "manifestSha256", "contentSha256", "dependencyLock", "dependencyContentSha256"], label);
    return { kind: "local", path: normalizeLocalPath(input.path, `${label}.path`), manifestSha256, contentSha256,
      ...(selectedDependencyLock === undefined ? {} : {
        dependencyLock: selectedDependencyLock,
        dependencyContentSha256: dependencyContentSha256!,
      }) };
  }
  throw new Error(`${label}.kind must be npm, git, or local`);
}

function parseLockEntry(
  value: unknown,
  label: string,
  schemaVersion: 1 | 2,
  legacyGrammar = schemaVersion === 1,
): ProjectPackageLockEntry {
  const input = object(value, label);
  assertAllowed(input, ["id", "declaration", "resolved"], label);
  const id = packageId(input.id, `${label}.id`);
  const comparator = schemaVersion === 1 ? compareLegacy : comparePortable;
  const declaration = parseDeclarationEntry(input.declaration, `${label}.declaration`, comparator, legacyGrammar);
  if (declaration.id !== id) throw new Error(`${label} ID does not match its declaration`);
  const resolved = parseResolvedSource(input.resolved, `${label}.resolved`, schemaVersion, legacyGrammar);
  if (resolved.kind !== declaration.source.kind) throw new Error(`${label} source kind does not match its declaration`);
  if (resolved.kind === "npm" && declaration.source.kind === "npm" && resolved.packageName !== declaration.source.package) {
    throw new Error(`${label} npm package name does not match its declaration`);
  }
  if (resolved.kind === "npm" && declaration.source.kind === "npm") {
    const range = validRange(declaration.source.selector);
    if (range !== null && !satisfies(resolved.resolvedVersion, range)) {
      throw new Error(`${label} npm version does not satisfy its declared range`);
    }
  }
  if (resolved.kind === "local" && declaration.source.kind === "local" && resolved.path !== declaration.source.path) {
    throw new Error(`${label} local path does not match its declaration`);
  }
  if (resolved.kind === "git" && declaration.source.kind === "git") {
    const parsed = parsedGitSource(resolved.source, legacyGrammar);
    if (parsed?.repo !== declaration.source.repository) {
      throw new Error(`${label} Git repository does not match its declaration`);
    }
  }
  return { id, declaration, resolved };
}

export function parseProjectPackageLock(value: unknown): ProjectPackageLock {
  const input = object(value, "Project package lock");
  assertAllowed(input, ["schemaVersion", "declarationGrammar", "declarationSha256", "packages"], "Project package lock");
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2) {
    throw new Error("Project package lock schemaVersion must be 1 or 2");
  }
  const schemaVersion = input.schemaVersion as 1 | 2;
  if (input.declarationGrammar !== undefined && (schemaVersion !== 2 || input.declarationGrammar !== "legacy")) {
    throw new Error("Project package lock declarationGrammar must be legacy on schemaVersion 2 locks");
  }
  const declarationGrammar = input.declarationGrammar === "legacy" ? "legacy" as const : undefined;
  const legacyGrammar = schemaVersion === 1 || declarationGrammar === "legacy";
  const declarationSha256 = digest(input.declarationSha256, "Project package lock declarationSha256");
  if (!Array.isArray(input.packages) || input.packages.length > MAX_PROJECT_PACKAGES) {
    throw new Error(`Project package lock packages must contain at most ${MAX_PROJECT_PACKAGES} entries`);
  }
  const comparator = schemaVersion === 1 ? compareLegacy : comparePortable;
  const packages = sortedUniquePackages(input.packages.map((entry, index) =>
    parseLockEntry(entry, `Project package lock packages[${index}]`, schemaVersion, legacyGrammar)), "Project package lock", comparator);
  const dependencyLockBytes = packages.reduce((total, entry) =>
    total + Buffer.byteLength(entry.resolved.dependencyLock?.content ?? ""), 0);
  if (dependencyLockBytes > MAX_DEPENDENCY_LOCK_TOTAL_BYTES) {
    throw new Error(`Project package lock dependency snapshots exceed ${MAX_DEPENDENCY_LOCK_TOTAL_BYTES} bytes`);
  }
  const embedded: ProjectPackageDeclaration = { schemaVersion: 1, packages: packages.map((entry) => entry.declaration) };
  if (projectPackageDeclarationSha256(embedded) !== declarationSha256) {
    throw new Error("Project package lock declaration digest does not match its embedded declarations");
  }
  const selected: ProjectPackageLock = {
    schemaVersion,
    ...(declarationGrammar === undefined ? {} : { declarationGrammar }),
    declarationSha256,
    packages,
  };
  if (Buffer.byteLength(`${JSON.stringify(selected, null, 2)}\n`) > MAX_PROJECT_PACKAGE_LOCK_BYTES) {
    throw new Error(`Project package lock exceeds ${MAX_PROJECT_PACKAGE_LOCK_BYTES} serialized bytes`);
  }
  return selected;
}

function serializeLock(value: ProjectPackageLock): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function declarationEqual(left: ProjectPackageDeclarationEntry, right: ProjectPackageDeclarationEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function catalogEntries(lock: ProjectPackageLock): ProjectPackageCatalogEntry[] {
  return lock.packages.map((entry) => {
    const { dependencyLock: selectedDependencyLock, ...resolved } = entry.resolved;
    return {
      id: entry.id,
      source: { ...entry.declaration.source },
      disabledResources: [...entry.declaration.disabledResources],
      resolved: {
        ...resolved,
        ...(selectedDependencyLock === undefined ? {} : { dependencyLockSha256: selectedDependencyLock.sha256 }),
      },
    } as ProjectPackageCatalogEntry;
  });
}

async function optionalJson(
  path: string,
  label: string,
  maximumBytes = MAX_PROJECT_PACKAGE_FILE_BYTES,
): Promise<unknown | undefined> {
  let information;
  try {
    information = await lstat(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  if (!information.isFile() || information.isSymbolicLink() || information.size > maximumBytes) {
    throw new Error(`${label} must be a regular file no larger than ${maximumBytes} bytes`);
  }
  const source = await readFile(path, "utf8");
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

async function packageContentSha256(
  packageRoot: string,
  signal?: AbortSignal,
  legacy = false,
): Promise<string> {
  const hash = createHash("sha256");
  let entryCount = 0;
  let bytes = 0;
  const visit = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (depth > 64) throw new Error("Project package content exceeds maximum directory depth 64");
    const names: string[] = [];
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) names.push(entry.name);
    } finally {
      await handle.close().catch(() => undefined);
    }
    names.sort(legacy ? compareLegacy : comparePortable);
    if (!legacy) assertPortableNames(names, `Project package directory ${relativeDirectory || "."}`);
    for (const name of names) {
      signal?.throwIfAborted();
      if (relativeDirectory === "" && name === PROJECT_PACKAGE_PROVENANCE) continue;
      if (legacy && relativeDirectory === "" && (name === ".rigyn-packages.lock" || name === "node_modules")) continue;
      if (!legacy && relativeDirectory === "" && (name === "package-lock.json" || name === "node_modules")) continue;
      const path = join(directory, name);
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const information = await lstat(path);
      if (information.isSymbolicLink()) throw new Error(`Project package content contains a symbolic link: ${relativePath}`);
      entryCount += 1;
      if (entryCount > MAX_CONTENT_FILES) throw new Error("Project package content exceeds its digest bounds");
      if (information.isDirectory()) {
        if (!legacy) hash.update(`D${Buffer.byteLength(relativePath)}:${relativePath};`);
        await visit(path, relativePath, depth + 1);
        continue;
      }
      if (!information.isFile()) throw new Error(`Project package content contains a non-file entry: ${relativePath}`);
      bytes += information.size;
      if (bytes > MAX_CONTENT_BYTES) throw new Error("Project package content exceeds its digest bounds");
      const data = await readFile(path);
      signal?.throwIfAborted();
      if (data.byteLength !== information.size) throw new Error(`Project package content changed while hashing: ${relativePath}`);
      hash.update(Buffer.from(`${Buffer.byteLength(relativePath)}:`));
      hash.update(relativePath);
      hash.update(Buffer.from(`:${data.byteLength}:`));
      hash.update(data);
    }
  };
  signal?.throwIfAborted();
  await visit(packageRoot, "", 0);
  return hash.digest("hex");
}

async function packageDependencyContentDigests(
  packageRoot: string,
  selected: ProjectPackageDependencyLock,
  signal?: AbortSignal,
): Promise<{ portableSha256: string; platformSha256: string }> {
  const lock = object(JSON.parse(selected.content) as unknown, "Project package dependency lock");
  const packages = object(lock.packages, "Project package dependency lock packages");
  const devRoots: string[] = [];
  const platformRoots: string[] = [];
  for (const [path, metadataValue] of Object.entries(packages)) {
    if (path === "") continue;
    const metadata = object(metadataValue, `Project package dependency ${path}`);
    if (metadata.dev === true) devRoots.push(path);
    else if (
      metadata.optional === true
      || Array.isArray(metadata.os)
      || Array.isArray(metadata.cpu)
      || Array.isArray(metadata.libc)
    ) platformRoots.push(path);
  }
  const under = (path: string, roots: readonly string[]): boolean =>
    roots.some((root) => path === root || path.startsWith(`${root}/`));
  const portableHash = createHash("sha256");
  const platformHash = createHash("sha256");
  let entryCount = 0;
  let bytes = 0;
  const visit = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (depth > 64) throw new Error("Project package dependency tree exceeds maximum directory depth 64");
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => comparePortable(left.name, right.name));
    assertPortableNames(entries.map((entry) => entry.name), `Project package dependency directory ${relativeDirectory}`);
    for (const entry of entries) {
      signal?.throwIfAborted();
      const path = join(directory, entry.name);
      const relativePath = `${relativeDirectory}/${entry.name}`;
      const information = await lstat(path);
      if (information.isSymbolicLink()) throw new Error(`Project package dependency tree contains a symbolic link: ${relativePath}`);
      entryCount += 1;
      if (entryCount > MAX_CONTENT_FILES) {
        throw new Error("Project package dependency tree exceeds its content bounds");
      }
      if (under(relativePath, devRoots)) {
        throw new Error(`Project package dependency tree contains omitted dev dependency ${relativePath}`);
      }
      const platform = under(relativePath, platformRoots);
      const ignored = relativePath === "node_modules/.package-lock.json";
      const hash = platform ? platformHash : portableHash;
      if (information.isDirectory()) {
        if (!ignored) hash.update(`D${Buffer.byteLength(relativePath)}:${relativePath};`);
        await visit(path, relativePath, depth + 1);
        continue;
      }
      if (!information.isFile()) throw new Error(`Project package dependency tree contains a non-file entry: ${relativePath}`);
      bytes += information.size;
      if (bytes > MAX_CONTENT_BYTES) {
        throw new Error("Project package dependency tree exceeds its content bounds");
      }
      const data = await readFile(path);
      signal?.throwIfAborted();
      if (!ignored) {
        hash.update(`F${Buffer.byteLength(relativePath)}:${relativePath}:${data.byteLength}:`);
        hash.update(data);
      }
    }
  };
  const root = join(packageRoot, "node_modules");
  try {
    const information = await lstat(root);
    if (!information.isDirectory() || information.isSymbolicLink() || await realpath(root) !== root) {
      throw new Error("Project package dependency root must be a real directory");
    }
    await visit(root, "node_modules", 0);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  return { portableSha256: portableHash.digest("hex"), platformSha256: platformHash.digest("hex") };
}

async function packageDependencyContentSha256(
  packageRoot: string,
  selected: ProjectPackageDependencyLock,
  signal?: AbortSignal,
): Promise<string> {
  return (await packageDependencyContentDigests(packageRoot, selected, signal)).portableSha256;
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

function projectPackageProvenance(
  id: string,
  declaration: ProjectPackageDeclarationEntry,
  resolvedSource: ProjectPackageResolvedSource,
  dependencyPlatformContentSha256?: string,
): ProjectPackageProvenance {
  const common = {
    schemaVersion: 1 as const,
    id,
    scope: "project" as const,
    installedAt: new Date().toISOString(),
    manifestSha256: resolvedSource.manifestSha256,
    ...(dependencyPlatformContentSha256 === undefined ? {} : { dependencyPlatformContentSha256 }),
  };
  if (resolvedSource.kind === "npm") return {
    ...common,
    kind: "npm",
    source: resolvedSource.source,
    packageName: resolvedSource.packageName,
    resolvedVersion: resolvedSource.resolvedVersion,
    archiveSha256: resolvedSource.archiveSha256,
  };
  if (resolvedSource.kind === "git") return {
    ...common,
    kind: "git",
    source: resolvedSource.source,
    revision: resolvedSource.revision,
  };
  if (declaration.source.kind !== "local") throw new Error(`Project package ${id} changed source kind`);
  return { ...common, kind: "local", sourcePath: declaration.source.path };
}

function projectPackageFilters(
  entry: ProjectPackageCatalogEntry,
  installed: InstalledProjectPackage,
): PackageSource {
  const packageRoot = installed.packageRoot;
  const legacyManifest = basename(installed.manifestPath) === "extension.json";
  const selected: Exclude<PackageSource, string> = {
    source: packageRoot,
    ...(legacyManifest ? { manifest: "legacy" as const } : {}),
  };
  for (const value of entry.disabledResources) {
    const separatorIndex = value.indexOf(":");
    const kind = value.slice(0, separatorIndex);
    const key = value.slice(separatorIndex + 1);
    const pattern = `-${key}`;
    const normalizedPath = !key.includes("\\")
      && !key.startsWith("/")
      && !/^[A-Za-z]:/u.test(key)
      && !key.split("/").includes("..")
      && posix.normalize(key) === key;
    if (kind === "runtime" && (!legacyManifest || normalizedPath)) (selected.extensions ??= []).push(pattern);
    else if (kind === "skill" && !legacyManifest) (selected.skills ??= []).push(pattern);
    else if (kind === "prompt" && !legacyManifest) (selected.prompts ??= []).push(pattern);
    else if (kind === "theme" && !legacyManifest) (selected.themes ??= []).push(pattern);
  }
  return selected;
}

export function projectPackageResourceSources(
  packages: readonly InstalledProjectPackage[],
  catalog: readonly ProjectPackageCatalogEntry[],
): PackageSource[] {
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  return packages.map((entry) => {
    const declared = byId.get(entry.id);
    if (declared === undefined) throw new Error(`Project package catalog is missing ${entry.id}`);
    return projectPackageFilters(declared, entry);
  });
}

export function projectPackageDeclaredResourceMetadata(
  resources: ResolvedPaths,
  packages: readonly InstalledProjectPackage[],
  catalog: readonly ProjectPackageCatalogEntry[],
): ResolvedPaths {
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  const disabledByRoot = new Map(packages.map((entry) => {
    const declared = byId.get(entry.id);
    if (declared === undefined) throw new Error(`Project package catalog is missing ${entry.id}`);
    const legacyManifest = basename(entry.manifestPath) === "extension.json";
    const declaredSkillRoots = legacyManifest
      ? new Set(parseLegacyExtensionManifest(JSON.parse(readFileSync(entry.manifestPath, "utf8")) as unknown)
        .skillRoots.map((root) => root.path))
      : new Set<string>();
    return [resolve(entry.packageRoot), {
      metadata: declared.disabledResources.filter((value) =>
        value.startsWith("prompt:") || value.startsWith("command:") || value.startsWith("theme:")),
      skillRoots: new Set(declared.disabledResources
        .filter((value) => value.startsWith("skill:") && declaredSkillRoots.has(value.slice("skill:".length)))
        .map((value) => value.slice("skill:".length))),
    }] as const;
  }));
  const apply = <T extends { path: string; enabled: boolean; metadata: { baseDir?: string } }>(
    entries: readonly T[],
    skills = false,
  ): T[] => entries.map((entry) => {
    const baseDir = entry.metadata.baseDir;
    const disabled = baseDir === undefined
      ? undefined
      : disabledByRoot.get(resolve(baseDir));
    const disabledSkill = skills && disabled !== undefined && baseDir !== undefined
      ? [...disabled.skillRoots].some((root) => {
        const resource = relative(resolve(baseDir), resolve(entry.path)).split(sep).join("/");
        return resource.startsWith(`${root}/`);
      })
      : false;
    if ((disabled?.metadata.length ?? 0) === 0 && !disabledSkill) return entry;
    return {
      ...entry,
      ...(disabledSkill ? { enabled: false } : {}),
      ...((disabled?.metadata.length ?? 0) === 0 ? {} : {
        metadata: { ...entry.metadata, disabledDeclaredResources: disabled!.metadata },
      }),
    };
  });
  return {
    extensions: apply(resources.extensions),
    skills: apply(resources.skills, true),
    prompts: apply(resources.prompts),
    themes: apply(resources.themes),
  };
}

export function projectPackageDisabledCommands(entry: ProjectPackageCatalogEntry): string[] {
  return entry.disabledResources
    .filter((value) => value.startsWith("command:"))
    .map((value) => value.slice("command:".length));
}

function projectPackageDisabledDynamicResources(
  entry: ProjectPackageCatalogEntry,
): Partial<Record<"skill" | "prompt" | "theme", string[]>> {
  const selected: Partial<Record<"skill" | "prompt" | "theme", string[]>> = {};
  for (const value of entry.disabledResources) {
    const separator = value.indexOf(":");
    const kind = value.slice(0, separator) as "skill" | "prompt" | "theme";
    if (kind !== "skill" && kind !== "prompt" && kind !== "theme") continue;
    (selected[kind] ??= []).push(value.slice(separator + 1));
  }
  return selected;
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
  const ids = [...new Set([...Object.keys(configured), ...Object.keys(declared)])]
    .sort(comparePortable);
  const values = (record: Readonly<Record<string, readonly string[]>>, id: string): readonly string[] =>
    Object.prototype.hasOwnProperty.call(record, id) ? record[id] ?? [] : [];
  return Object.fromEntries(ids.map((id) => [id, [...new Set([...values(configured, id), ...values(declared, id)])]
    .sort(comparePortable)]));
}

interface CopyBudget {
  entries: number;
  bytes: number;
  signal?: AbortSignal;
}

async function copyPackageTree(
  source: string,
  target: string,
  budget: CopyBudget,
  relativeDirectory = "",
  depth = 0,
): Promise<void> {
  if (depth > 64) throw new Error("Project package content exceeds maximum directory depth 64");
  const sourceInformation = await lstat(source);
  if (!sourceInformation.isDirectory() || sourceInformation.isSymbolicLink()) {
    throw new Error(`Project package source contains an unsafe directory: ${relativeDirectory || "."}`);
  }
  await mkdir(target, { recursive: true, mode: sourceInformation.mode & 0o777 });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => comparePortable(left.name, right.name));
  assertPortableNames(entries.map((entry) => entry.name), `Project package source directory ${relativeDirectory || "."}`);
  for (const entry of entries) {
    budget.signal?.throwIfAborted();
    if (entry.name === ".git") continue;
    if (relativeDirectory === "" && entry.name === "node_modules") continue;
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
    const information = await lstat(sourcePath);
    if (information.isSymbolicLink()) throw new Error(`Project package content contains a symbolic link: ${relativePath}`);
    budget.entries += 1;
    if (budget.entries > MAX_CONTENT_FILES) throw new Error("Project package content exceeds its copy bounds");
    if (information.isDirectory()) {
      await copyPackageTree(sourcePath, targetPath, budget, relativePath, depth + 1);
      continue;
    }
    if (!information.isFile()) throw new Error(`Project package content contains a non-file entry: ${relativePath}`);
    budget.bytes += information.size;
    if (budget.bytes > MAX_CONTENT_BYTES) {
      throw new Error("Project package content exceeds its copy bounds");
    }
    const handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== information.size) {
        throw new Error(`Project package content changed while copying: ${relativePath}`);
      }
      const data = await handle.readFile();
      const after = await handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
        throw new Error(`Project package content changed while copying: ${relativePath}`);
      }
      await writeFile(targetPath, data, { flag: "wx", mode: information.mode & 0o777 });
      await chmod(targetPath, information.mode & 0o777);
    } finally {
      await handle.close();
    }
  }
}

async function readPackageManifest(
  packageRoot: string,
  requireLegacy = false,
  requirePackageIdentity = false,
): Promise<{
  manifest: PackageManifest;
  manifestSha256: string;
  manifestPath: string;
}> {
  const readManifestJson = async (name: "package.json" | "extension.json"): Promise<{
    path: string;
    data: Buffer;
    value: Record<string, unknown>;
  } | undefined> => {
    const path = join(packageRoot, name);
    let information;
    try {
      information = await lstat(path);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    if (!information.isFile() || information.isSymbolicLink() || information.size > MAX_PROJECT_PACKAGE_FILE_BYTES) {
      throw new Error(`Project package ${name} must be a bounded regular file`);
    }
    const data = await readFile(path);
    try {
      return { path, data, value: object(JSON.parse(data.toString("utf8")) as unknown, `Project package ${name}`) };
    } catch (error) {
      throw new Error(`Project package ${name} is invalid`, { cause: error });
    }
  };
  const packageJson = await readManifestJson("package.json");
  const packageRigyn = packageJson?.value.rigyn;
  const modern = packageJson !== undefined
    && packageRigyn !== undefined
    && packageRigyn !== null
    && typeof packageRigyn === "object"
    && !Array.isArray(packageRigyn);
  const legacyJson = requireLegacy || !modern ? await readManifestJson("extension.json") : undefined;
  if (requireLegacy && legacyJson === undefined) throw new Error("Legacy project package extension.json is missing");
  if (packageJson === undefined && legacyJson === undefined) {
    throw new Error("Project package must contain package.json or extension.json");
  }
  const useLegacy = legacyJson !== undefined && (
    requireLegacy
    || packageJson === undefined
    || packageRigyn === undefined
    || packageRigyn === null
    || typeof packageRigyn !== "object"
    || Array.isArray(packageRigyn)
  );
  const legacy = useLegacy ? parseLegacyExtensionManifest(legacyJson!.value) : undefined;
  if (legacy !== undefined) {
    for (const [path, expected] of legacy.integrity) {
      const absolute = join(packageRoot, path);
      const information = await lstat(absolute);
      if (!information.isFile() || information.isSymbolicLink() || information.size > 32 * 1024 * 1024) {
        throw new Error(`Project package integrity path must be a bounded regular file: ${path}`);
      }
      if (sha256(await readFile(absolute)) !== expected) {
        throw new Error(`Project package integrity mismatch: ${path}`);
      }
    }
  }
  const packageName = packageJson?.value.name === undefined || (useLegacy && !requirePackageIdentity)
    ? undefined
    : npmPackageName(packageJson.value.name, "Project package package.json name");
  const packageVersion = packageJson?.value.version === undefined || (useLegacy && !requirePackageIdentity)
    ? undefined
    : requiredString(packageJson.value.version, "Project package package.json version", 128);
  const name = legacy?.name ?? packageName;
  if (name === undefined) throw new Error("Project package package.json name is missing");
  const version = legacy === undefined ? packageVersion : legacy.version;
  const description = legacy === undefined
    ? packageJson?.value.description === undefined
      ? undefined
      : requiredString(packageJson.value.description, "Project package package.json description", 4096)
    : legacy.description;
  const value = packageJson?.value ?? {};
  const dependencyMap = (field: "dependencies" | "optionalDependencies" | "peerDependencies"): Record<string, string> | undefined => {
    if (value[field] === undefined) return undefined;
    const input = object(value[field], `Project package ${field}`);
    return Object.fromEntries(Object.entries(input).map(([dependency, selector]) => {
      const selected = requiredString(selector, `Project package dependency ${dependency}`, 512);
      if (/^(?:\.{0,2}\/|\/|[A-Za-z]:[\\/]|(?:file|link|workspace):)/iu.test(selected)) {
        throw new Error(`Project package dependency ${dependency} must not use a local path`);
      }
      return [npmPackageName(dependency, `Project package dependency ${dependency}`), selected];
    }));
  };
  const dependencies = dependencyMap("dependencies");
  const optionalDependencies = dependencyMap("optionalDependencies");
  const peerDependencies = dependencyMap("peerDependencies");
  let peerDependenciesMeta: Record<string, { optional?: boolean }> | undefined;
  if (value.peerDependenciesMeta !== undefined) {
    const input = object(value.peerDependenciesMeta, "Project package peerDependenciesMeta");
    peerDependenciesMeta = Object.fromEntries(Object.entries(input).map(([dependency, rawMetadata]) => {
      npmPackageName(dependency, `Project package peerDependenciesMeta ${dependency}`);
      if (peerDependencies === undefined || !Object.prototype.hasOwnProperty.call(peerDependencies, dependency)) {
        throw new Error(`Project package peerDependenciesMeta ${dependency} does not name a peer dependency`);
      }
      const metadata = object(rawMetadata, `Project package peerDependenciesMeta ${dependency}`);
      assertAllowed(metadata, ["optional"], `Project package peerDependenciesMeta ${dependency}`);
      if (metadata.optional !== undefined && typeof metadata.optional !== "boolean") {
        throw new Error(`Project package peerDependenciesMeta ${dependency}.optional must be a boolean`);
      }
      return [dependency, metadata.optional === undefined ? {} : { optional: metadata.optional }];
    }));
  }
  const hostRange = peerDependencies?.rigyn;
  if (hostRange !== undefined) {
    if (validRange(hostRange) === null || !satisfies(RIGYN_VERSION, hostRange, { includePrerelease: true })) {
      throw new Error(`Project package requires rigyn ${hostRange}; current version is ${RIGYN_VERSION}`);
    }
    delete peerDependencies!.rigyn;
    if (Object.keys(peerDependencies!).length === 0) peerDependenciesMeta = undefined;
    if (peerDependenciesMeta !== undefined) {
      delete peerDependenciesMeta.rigyn;
      if (Object.keys(peerDependenciesMeta).length === 0) peerDependenciesMeta = undefined;
    }
  }
  return {
    manifest: {
      name,
      ...(version === undefined ? {} : { version }),
      ...(description === undefined ? {} : { description }),
      ...(legacy === undefined ? {} : { extensionId: legacy.id }),
      ...(packageName === undefined ? {} : { packageName }),
      ...(packageVersion === undefined ? {} : { packageVersion }),
      ...(dependencies === undefined ? {} : { dependencies }),
      ...(optionalDependencies === undefined ? {} : { optionalDependencies }),
      ...(peerDependencies === undefined || Object.keys(peerDependencies).length === 0 ? {} : { peerDependencies }),
      ...(peerDependenciesMeta === undefined ? {} : { peerDependenciesMeta }),
    },
    manifestSha256: sha256(useLegacy ? legacyJson!.data : packageJson!.data),
    manifestPath: useLegacy ? legacyJson!.path : packageJson!.path,
  };
}

async function readDependencyPackageVersion(packageRoot: string, label: string): Promise<string> {
  const path = join(packageRoot, "package.json");
  const information = await lstat(path);
  if (!information.isFile() || information.isSymbolicLink() || information.size > MAX_PROJECT_PACKAGE_FILE_BYTES) {
    throw new Error(`${label} package.json must be a bounded regular file`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`${label} package.json is invalid`, { cause: error });
  }
  return requiredString(object(parsed, `${label} package.json`).version, `${label} package.json version`, 128);
}

async function matchesLegacyManifest(packageRoot: string, expectedSha256: string | undefined): Promise<boolean> {
  if (expectedSha256 === undefined) return false;
  const path = join(packageRoot, "extension.json");
  let information;
  try {
    information = await lstat(path);
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
  if (!information.isFile() || information.isSymbolicLink() || information.size > MAX_PROJECT_PACKAGE_FILE_BYTES) return false;
  return sha256(await readFile(path)) === expectedSha256;
}

function lockSha256(lock: ProjectPackageLock): string {
  return sha256(serializeLock(lock));
}

function commandFiltersByRoot(
  packages: readonly InstalledProjectPackage[],
  catalog: readonly ProjectPackageCatalogEntry[],
): Map<string, string[]> {
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  return new Map(packages.map((entry) => {
    const declared = byId.get(entry.id);
    if (declared === undefined) throw new Error(`Project package catalog is missing ${entry.id}`);
    return [resolve(entry.packageRoot), projectPackageDisabledCommands(declared)] as const;
  }));
}

export function projectPackageDirectMetadata(
  resources: ResolvedPaths,
  packages: readonly InstalledProjectPackage[],
  catalog: readonly ProjectPackageCatalogEntry[],
): Map<string, RuntimeDirectPathMetadata> {
  const commands = commandFiltersByRoot(packages, catalog);
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  const ids = new Map(packages.map((entry) => [resolve(entry.packageRoot), {
    id: entry.id,
    legacyManifest: basename(entry.manifestPath) === "extension.json",
  }]));
  const counts = new Map<string, number>();
  for (const resource of resources.extensions) {
    const id = ids.get(resolve(resource.metadata.baseDir ?? dirname(resource.path)))?.id;
    if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const usedIds = new Set(catalog.map((entry) => entry.id));
  const derivedId = (id: string, root: string, resourcePath: string): string => {
    const relativePath = relative(root, resourcePath).split(sep).join("/");
    for (let attempt = 0; ; attempt += 1) {
      const suffix = `-${sha256(`${id}\0${relativePath}\0${attempt}`).slice(0, 40)}`;
      const candidate = `${id.slice(0, 63 - suffix.length)}${suffix}`;
      if (!usedIds.has(candidate)) {
        usedIds.add(candidate);
        return candidate;
      }
    }
  };
  return new Map(resources.extensions.map((resource) => {
    const root = resolve(resource.metadata.baseDir ?? dirname(resource.path));
    const identity = ids.get(root);
    const id = identity?.id;
    return [resource.path, {
      scope: "project",
      trusted: true,
      resourceRoot: root,
      ...(id === undefined ? {} : {
        extensionId: identity?.legacyManifest === true || counts.get(id) === 1
          ? id
          : derivedId(id, root, resource.path),
      }),
      ...((commands.get(root)?.length ?? 0) === 0 ? {} : { disabledCommands: commands.get(root)! }),
      ...(id === undefined ? {} : {
        disabledResources: projectPackageDisabledDynamicResources(byId.get(id)!),
      }),
    }] as const;
  }));
}

/**
 * Reconciles trusted project package declarations against an immutable lock.
 * Ordinary reconciliation never resolves moving tags, ranges, branches, or edits.
 */
export class ProjectPackageManager {
  readonly #workspace: string;
  readonly #trusted: boolean;
  readonly #commands: ProjectPackageCommands;
  readonly #operationLeaseRoot: string;
  readonly #attestationRoot: string;
  readonly #offline: boolean;
  #operations: Promise<void> = Promise.resolve();

  constructor(options: ProjectPackageManagerOptions) {
    this.#workspace = realpathSync(resolve(options.workspace));
    this.#trusted = options.projectTrusted;
    this.#commands = {
      ...(options.commands?.npm === undefined ? {} : {
        npm: { command: options.commands.npm.command, prefix: [...(options.commands.npm.prefix ?? [])] },
      }),
      ...(options.commands?.git === undefined ? {} : {
        git: { command: options.commands.git.command, prefix: [...(options.commands.git.prefix ?? [])] },
      }),
    };
    this.#operationLeaseRoot = resolve(options.operationLeaseRoot ?? join(getAgentDir(), "state", "leases"));
    this.#attestationRoot = resolve(options.attestationRoot ?? join(dirname(this.#operationLeaseRoot), "project-package-attestations"));
    this.#offline = options.offline ?? offlineEnvironment();
  }

  async check(signal?: AbortSignal): Promise<ProjectPackageCheckResult> {
    if (!this.#trusted) return {
      status: "ignored",
      trusted: false,
      packageCount: 0,
      packages: [],
      message: "Project package declarations are ignored until the workspace is trusted.",
    };
    return await this.#serialized(async () => await this.#withOperationLock(async () => await this.#checkLocked(signal), signal));
  }

  async reconcile(signal?: AbortSignal): Promise<ProjectPackageReconcileResult> {
    if (!this.#trusted) return { status: "ignored", changed: false, packages: [], catalog: [] };
    return await this.#serialized(async () => await this.#withOperationLock(async () => {
      signal?.throwIfAborted();
      await this.#recoverTransaction(signal);
      const state = await this.#readState();
      if (state.declaration === undefined && state.lock === undefined) {
        return { status: "absent", changed: false, packages: [], catalog: [] };
      }
      const lock = this.#matchingLock(state);
      const sourceLockSha256 = lockSha256(lock);
      const current = await this.#installedMatches(lock, signal);
      if (current !== undefined) {
        return { status: "ready", changed: false, packages: current, catalog: catalogEntries(lock) };
      }
      if (lock.schemaVersion === 1) {
        throw new Error("Legacy project package lock cannot be repaired immutably; run `rigyn packages update --all`");
      }
      await this.#stageLock(lock, signal);
      signal?.throwIfAborted();
      try {
        await this.#assertInputsUnchanged(lock.declarationSha256, sourceLockSha256);
        signal?.throwIfAborted();
        await this.#commitStaged(lock);
      } catch (error) {
        await rm(join(this.#workspace, PROJECT_PACKAGE_STAGE_ROOT), { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return {
        status: "ready",
        changed: true,
        packages: await this.#installed(lock),
        catalog: catalogEntries(lock),
      };
    }, signal));
  }

  async update(options: ProjectPackageUpdateOptions): Promise<ProjectPackageReconcileResult> {
    if (!this.#trusted) throw new Error("Project package updates require workspace trust");
    return await this.#serialized(async () => await this.#withOperationLock(async () => {
      options.signal?.throwIfAborted();
      await this.#recoverTransaction(options.signal);
      const state = await this.#readState();
      if (state.declaration === undefined) throw new Error(`No ${PROJECT_PACKAGE_DECLARATION} declaration exists`);
      const sourceDeclarationSha256 = projectPackageDeclarationSha256(state.declaration);
      const legacyGrammar = state.legacyDeclarationGrammar === true;
      const targetDeclaration = parseProjectPackageDeclarationValue({
        schemaVersion: 1,
        packages: state.declaration.packages,
      }, false, legacyGrammar);
      const requested = new Set(options.ids ?? []);
      if (options.all === true && requested.size > 0) throw new Error("Project package update accepts either IDs or all, not both");
      if (options.all !== true && requested.size === 0) throw new Error("Project package update requires one or more package IDs or all");
      if (state.lock?.schemaVersion === 1 && options.all !== true) {
        throw new Error("Legacy project package locks require `rigyn packages update --all`");
      }
      const declaredIds = new Set(targetDeclaration.packages.map((entry) => entry.id));
      const unknown = [...requested].filter((id) => !declaredIds.has(id)).sort(comparePortable);
      if (unknown.length > 0) throw new Error(`Project package declaration does not contain: ${unknown.join(", ")}`);
      const previous = new Map((state.lock?.packages ?? []).map((entry) => [entry.id, entry]));
      if (options.all !== true) {
        const current = new Map(targetDeclaration.packages.map((entry) => [entry.id, entry]));
        for (const existing of previous.values()) {
          if (requested.has(existing.id)) continue;
          const declared = current.get(existing.id);
          if (declared === undefined || !declarationEqual(existing.declaration, declared)) {
            throw new Error(`Project package ${existing.id} changed outside the requested update; use --all`);
          }
        }
      }
      const sourceLockSha256 = state.lock === undefined ? undefined : lockSha256(state.lock);
      const packages: ProjectPackageLockEntry[] = [];
      const resolutionRoot = join(this.#workspace, PROJECT_PACKAGE_RESOLUTION_ROOT);
      await rm(resolutionRoot, { recursive: true, force: true });
      try {
        await mkdir(resolutionRoot, { recursive: true, mode: 0o700 });
        for (const declaration of targetDeclaration.packages) {
          options.signal?.throwIfAborted();
          if (options.all === true || requested.has(declaration.id)) {
            const legacyManifestSha256 = state.lock?.schemaVersion === 1
              ? previous.get(declaration.id)?.resolved.manifestSha256
              : undefined;
            packages.push(await this.#resolveDeclaration(
              declaration,
              resolutionRoot,
              options.signal,
              legacyGrammar,
              legacyManifestSha256,
            ));
            continue;
          }
          const existing = previous.get(declaration.id);
          if (existing === undefined || !declarationEqual(existing.declaration, declaration)) {
            throw new Error(`Project package ${declaration.id} is not locked for its current declaration; update it or use --all`);
          }
          packages.push(existing);
        }
      } finally {
        await rm(resolutionRoot, { recursive: true, force: true });
      }
      const lock = parseProjectPackageLock({
        schemaVersion: 2,
        ...(legacyGrammar ? { declarationGrammar: "legacy" } : {}),
        declarationSha256: projectPackageDeclarationSha256(targetDeclaration),
        packages,
      });
      await this.#stageLock(lock, options.signal);
      options.signal?.throwIfAborted();
      try {
        await this.#assertInputsUnchanged(sourceDeclarationSha256, sourceLockSha256);
        options.signal?.throwIfAborted();
        await this.#commitStaged(lock, true);
      } catch (error) {
        await rm(join(this.#workspace, PROJECT_PACKAGE_STAGE_ROOT), { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return {
        status: "ready",
        changed: true,
        packages: await this.#installed(lock),
        catalog: catalogEntries(lock),
      };
    }, options.signal));
  }

  async #checkLocked(signal?: AbortSignal): Promise<ProjectPackageCheckResult> {
    await this.#recoverTransaction(signal);
    const state = await this.#readState();
    if (state.declaration === undefined && state.lock === undefined) return {
      status: "absent",
      trusted: true,
      packageCount: 0,
      packages: [],
      message: "No project package declaration exists.",
    };
    if (state.declaration === undefined) return {
      status: "stale-lock",
      trusted: true,
      packageCount: 0,
      packages: [],
      message: "A project package lock exists without a declaration.",
    };
    if (state.lock === undefined) return {
      status: "unlocked",
      trusted: true,
      packageCount: state.declaration.packages.length,
      packages: [],
      message: "Project packages are declared but not locked; run `rigyn packages update --all`.",
    };
    if (state.lock.declarationSha256 !== projectPackageDeclarationSha256(state.declaration)) return {
      status: "stale-lock",
      trusted: true,
      packageCount: state.declaration.packages.length,
      packages: catalogEntries(state.lock),
      message: "The project package declaration changed after the lock was written; update the affected packages or use --all.",
    };
    const current = await this.#installedMatches(state.lock, signal);
    return {
      status: current === undefined ? "needs-reconcile" : "ready",
      trusted: true,
      packageCount: state.lock.packages.length,
      packages: catalogEntries(state.lock),
      message: current !== undefined && state.lock.schemaVersion === 1
        ? "Installed project packages match a legacy lock; run `rigyn packages update --all` to migrate it."
        : current === undefined
        ? state.lock.schemaVersion === 1
          ? "Legacy project package install is missing or corrupt; run `rigyn packages update --all`."
          : "Installed project packages do not match the immutable lock; run `rigyn packages reconcile`."
        : "Installed project packages match the immutable lock.",
    };
  }

  #matchingLock(state: ProjectPackageState): ProjectPackageLock {
    if (state.declaration === undefined) throw new Error(`Project package lock exists without ${PROJECT_PACKAGE_DECLARATION}`);
    if (state.lock === undefined) throw new Error("Project packages are not locked; run `rigyn packages update --all`");
    if (state.lock.declarationSha256 !== projectPackageDeclarationSha256(state.declaration)) {
      throw new Error("Project package declaration does not match its lock; run `rigyn packages update ID` or `--all`");
    }
    return state.lock;
  }

  async #readState(): Promise<ProjectPackageState> {
    const declarationValue = await optionalJson(join(this.#workspace, PROJECT_PACKAGE_DECLARATION), "Project package declaration");
    const lockValue = await optionalJson(
      join(this.#workspace, PROJECT_PACKAGE_LOCK),
      "Project package lock",
      MAX_PROJECT_PACKAGE_LOCK_BYTES,
    );
    const lock = lockValue === undefined ? undefined : parseProjectPackageLock(lockValue);
    const parsedDeclaration = declarationValue === undefined ? undefined : parseDeclarationForLock(declarationValue, lock);
    return {
      ...(parsedDeclaration === undefined ? {} : {
        declaration: parsedDeclaration.declaration,
        legacyDeclarationGrammar: parsedDeclaration.legacyGrammar,
      }),
      ...(lock === undefined ? {} : { lock }),
    };
  }

  async #assertInputsUnchanged(expectedDeclarationSha256: string, expectedLockSha256: string | undefined): Promise<void> {
    const declarationValue = await optionalJson(join(this.#workspace, PROJECT_PACKAGE_DECLARATION), "Project package declaration");
    const lockValue = await optionalJson(
      join(this.#workspace, PROJECT_PACKAGE_LOCK),
      "Project package lock",
      MAX_PROJECT_PACKAGE_LOCK_BYTES,
    );
    const selectedLock = lockValue === undefined ? undefined : parseProjectPackageLock(lockValue);
    const declarationSha256 = declarationValue === undefined
      ? undefined
      : projectPackageDeclarationSha256(parseDeclarationForLock(declarationValue, selectedLock).declaration);
    const selectedLockSha256 = selectedLock === undefined ? undefined : lockSha256(selectedLock);
    if (declarationSha256 !== expectedDeclarationSha256 || selectedLockSha256 !== expectedLockSha256) {
      throw new Error("Project package declaration or lock changed while packages were being prepared");
    }
  }

  async #run(
    kind: "npm" | "git",
    argumentsValue: string[],
    cwd: string,
    options: {
      signal?: AbortSignal;
      quotaRoot?: string;
      environment?: Record<string, string>;
      inheritEnvironment?: boolean;
      git?: { protocol: GitProtocol; home: string; template: string };
    } = {},
  ): Promise<string> {
    const configured = this.#commands[kind];
    const command = configured?.command ?? kind;
    const prefix = configured?.prefix ?? [];
    options.signal?.throwIfAborted();
    const commandController = new AbortController();
    const relayAbort = (): void => commandController.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", relayAbort, { once: true });
    if (options.signal?.aborted === true) relayAbort();
    const monitorController = new AbortController();
    let quotaFailure: Error | undefined;
    const inspectQuota = async (): Promise<void> => {
      if (options.quotaRoot === undefined || quotaFailure !== undefined) return;
      try {
        await assertMaterializationQuota(options.quotaRoot);
      } catch (error) {
        quotaFailure = error instanceof Error ? error : new Error(String(error));
        commandController.abort(quotaFailure);
      }
    };
    await inspectQuota();
    if (quotaFailure !== undefined) {
      options.signal?.removeEventListener("abort", relayAbort);
      throw quotaFailure;
    }
    const monitor = options.quotaRoot === undefined ? undefined : (async () => {
      while (!monitorController.signal.aborted && quotaFailure === undefined) {
        try {
          await delay(MATERIALIZATION_QUOTA_POLL_MS, undefined, { signal: monitorController.signal });
        } catch {
          break;
        }
        if (!monitorController.signal.aborted) await inspectQuota();
      }
    })();
    let output: string | undefined;
    let result: Awaited<ReturnType<typeof runProcess>> | undefined;
    try {
      if (kind === "git") {
        if (options.git === undefined) throw new Error("Git command policy is required");
        output = await runGitCommand({
          argv: [command, ...prefix],
          arguments: argumentsValue,
          cwd,
          ...options.git,
          signal: commandController.signal,
        });
      } else {
        result = await runProcess({
          argv: [command, ...prefix, ...argumentsValue],
          cwd,
          timeoutMs: COMMAND_TIMEOUT_MS,
          outputLimitBytes: MAX_COMMAND_OUTPUT_BYTES,
          ...(options.inheritEnvironment === undefined ? {} : { inheritEnv: options.inheritEnvironment }),
          env: {
            npm_config_ignore_scripts: "true",
            npm_config_bin_links: "false",
            npm_config_audit: "false",
            npm_config_fund: "false",
            ...(this.#offline ? { npm_config_offline: "true" } : {}),
            ...(options.environment ?? {}),
          },
        }, commandController.signal);
      }
    } finally {
      monitorController.abort();
      await monitor;
      options.signal?.removeEventListener("abort", relayAbort);
    }
    if (quotaFailure === undefined && options.signal?.aborted !== true) await inspectQuota();
    if (quotaFailure !== undefined) throw quotaFailure;
    if (result !== undefined) {
      if (result.cancelled) throw options.signal?.reason ?? new DOMException("Aborted", "AbortError");
      if (result.timedOut) throw new Error(`${kind} command timed out after ${COMMAND_TIMEOUT_MS}ms`);
      if (result.exitCode !== 0) {
        const detail = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim();
        throw new Error(`${kind} command failed with ${result.exitCode === null ? `signal ${result.signal}` : `code ${result.exitCode}`}${detail === "" ? "" : `: ${detail}`}`);
      }
      return result.stdout.toString("utf8").trim();
    }
    return output ?? "";
  }

  async #runNpm(
    argumentsValue: string[],
    cwd: string,
    quotaRoot: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const environmentRoot = join(quotaRoot, ".rigyn-npm-command");
    const home = join(environmentRoot, "home");
    const cache = join(environmentRoot, "cache");
    const temporary = join(environmentRoot, "tmp");
    await rm(environmentRoot, { recursive: true, force: true });
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(cache, { recursive: true, mode: 0o700 });
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    const userConfig = join(environmentRoot, "npmrc");
    const globalConfig = join(environmentRoot, "npmrc-global");
    await writeFile(userConfig, "", { mode: 0o600 });
    await writeFile(globalConfig, "", { mode: 0o600 });
    const environment: Record<string, string> = {
      HOME: home,
      USERPROFILE: home,
      LANG: "C",
      LC_ALL: "C",
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
      npm_config_cache: cache,
      npm_config_tmp: temporary,
      npm_config_update_notifier: "false",
      npm_config_progress: "false",
      npm_config_loglevel: "warn",
    };
    for (const name of ["PATH", "SystemRoot", "WINDIR", "PATHEXT"]) {
      const value = process.env[name];
      if (value !== undefined) environment[name] = value;
    }
    try {
      return await this.#run("npm", argumentsValue, cwd, {
        ...(signal === undefined ? {} : { signal }),
        quotaRoot,
        environment,
        inheritEnvironment: false,
      });
    } finally {
      await rm(environmentRoot, { recursive: true, force: true });
    }
  }

  async #localSource(path: string): Promise<string> {
    const boundary = await WorkspaceBoundary.create(this.#workspace);
    const lexical = boundary.lexical(path);
    const information = await lstat(lexical);
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw new Error(`Local project package must be a real directory: ${path}`);
    }
    const canonical = await boundary.readable(lexical);
    if (canonical !== lexical || await realpath(lexical) !== lexical) {
      throw new Error(`Local project package path contains a symbolic link: ${path}`);
    }
    return canonical;
  }

  #hasProductionDependencies(manifest: PackageManifest): boolean {
    return [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]
      .some((entries) => Object.keys(entries ?? {}).length > 0);
  }

  async #withProductionDependencyManifest<T>(
    packageRoot: string,
    manifest: PackageManifest,
    operation: () => Promise<T>,
  ): Promise<T> {
    const path = join(packageRoot, "package.json");
    const original = await readFile(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(original.toString("utf8")) as unknown;
    } catch (error) {
      throw new Error("Project package package.json is not valid JSON", { cause: error });
    }
    const selected = { ...object(parsed, "Project package package.json") };
    for (const [field, value] of Object.entries({
      dependencies: manifest.dependencies,
      optionalDependencies: manifest.optionalDependencies,
      peerDependencies: manifest.peerDependencies,
      peerDependenciesMeta: manifest.peerDependenciesMeta,
    })) {
      if (value === undefined) delete selected[field];
      else selected[field] = value;
    }
    await writeFile(path, `${JSON.stringify(selected, null, 2)}\n`);
    try {
      return await operation();
    } finally {
      await writeFile(path, original);
    }
  }

  async #assertRequiredProductionDependencies(packageRoot: string, manifest: PackageManifest): Promise<void> {
    const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
    const required = new Set(Object.keys(manifest.dependencies ?? {}).filter((name) => !optional.has(name)));
    for (const name of Object.keys(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[name]?.optional !== true) required.add(name);
    }
    for (const name of required) {
      const path = join(packageRoot, "node_modules", ...name.split("/"));
      let information;
      try {
        information = await lstat(path);
      } catch (error) {
        if (missing(error)) throw new Error(`Project package required production dependency ${name} is missing`);
        throw error;
      }
      if (!information.isDirectory() || information.isSymbolicLink()) {
        throw new Error(`Project package required production dependency ${name} is not a real directory`);
      }
    }
  }

  #assertPackageId(manifest: PackageManifest, expectedId: string): void {
    if (manifest.extensionId !== undefined && manifest.extensionId !== expectedId) {
      throw new Error(`Project package source contains ${manifest.extensionId}, expected ${expectedId}`);
    }
  }

  async #readDependencyLock(packageRoot: string): Promise<ProjectPackageDependencyLock> {
    const path = join(packageRoot, "package-lock.json");
    const information = await lstat(path);
    if (!information.isFile() || information.isSymbolicLink() || information.size > MAX_DEPENDENCY_LOCK_BYTES) {
      throw new Error(`Project package dependency lock must be a regular file no larger than ${MAX_DEPENDENCY_LOCK_BYTES} bytes`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
      throw new Error("Project package dependency lock is not valid JSON", { cause: error });
    }
    const content = `${canonicalJson(parsed)}\n`;
    return dependencyLock({ sha256: sha256(Buffer.from(content)), content }, "Project package dependency lock");
  }

  async #writeDependencyLock(packageRoot: string, selected: ProjectPackageDependencyLock): Promise<void> {
    await atomicWrite(join(packageRoot, "package-lock.json"), Buffer.from(selected.content));
  }

  async #resolveDependencies(
    packageRoot: string,
    manifest: PackageManifest,
    signal?: AbortSignal,
  ): Promise<ProjectPackageDependencyLock | undefined> {
    if (!this.#hasProductionDependencies(manifest)) {
      await rm(join(packageRoot, "node_modules"), { recursive: true, force: true });
      await rm(join(packageRoot, "package-lock.json"), { force: true });
      await rm(join(packageRoot, "npm-shrinkwrap.json"), { force: true });
      return undefined;
    }
    try {
      const sourceLock = await this.#readDependencyLock(packageRoot);
      await this.#writeDependencyLock(packageRoot, sourceLock);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await rm(join(packageRoot, "node_modules"), { recursive: true, force: true });
    await rm(join(packageRoot, "npm-shrinkwrap.json"), { force: true });
    await this.#withProductionDependencyManifest(packageRoot, manifest, async () => await this.#runNpm([
      "install",
      "--omit=dev",
      "--ignore-scripts=true",
      "--bin-links=false",
      ...(this.#offline ? ["--offline"] : []),
    ], packageRoot, packageRoot, signal));
    await this.#assertRequiredProductionDependencies(packageRoot, manifest);
    const selected = await this.#readDependencyLock(packageRoot);
    await this.#writeDependencyLock(packageRoot, selected);
    return selected;
  }

  async #restoreDependencies(
    packageRoot: string,
    manifest: PackageManifest,
    selected: ProjectPackageDependencyLock | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.#hasProductionDependencies(manifest)) {
      if (selected !== undefined) {
        throw new Error("Project package dependency lock exists without production dependencies");
      }
      await rm(join(packageRoot, "node_modules"), { recursive: true, force: true });
      await rm(join(packageRoot, "package-lock.json"), { force: true });
      await rm(join(packageRoot, "npm-shrinkwrap.json"), { force: true });
      return;
    }
    if (selected === undefined) throw new Error("Project package production dependencies are missing their immutable lock");
    await rm(join(packageRoot, "node_modules"), { recursive: true, force: true });
    await rm(join(packageRoot, "npm-shrinkwrap.json"), { force: true });
    await rm(join(packageRoot, "package-lock.json"), { force: true });
    await this.#writeDependencyLock(packageRoot, selected);
    await this.#withProductionDependencyManifest(packageRoot, manifest, async () => await this.#runNpm([
      "ci",
      "--omit=dev",
      "--ignore-scripts=true",
      "--bin-links=false",
      ...(this.#offline ? ["--offline"] : []),
    ], packageRoot, packageRoot, signal));
    await this.#assertRequiredProductionDependencies(packageRoot, manifest);
    const restored = await this.#readDependencyLock(packageRoot);
    if (restored.sha256 !== selected.sha256 || restored.content !== selected.content) {
      throw new Error("Project package dependency lock changed during installation");
    }
  }

  async #copySource(
    source: string,
    target: string,
    signal?: AbortSignal,
    locked?: { dependencyLock: ProjectPackageDependencyLock | undefined },
    legacyManifestSha256?: string,
  ): Promise<{
    manifest: PackageManifest;
    manifestSha256: string;
    manifestPath: string;
    contentSha256: string;
    dependencyLock?: ProjectPackageDependencyLock;
    dependencyContentSha256?: string;
  }> {
    signal?.throwIfAborted();
    await copyPackageTree(source, target, { entries: 0, bytes: 0, ...(signal === undefined ? {} : { signal }) });
    const legacyManifest = await matchesLegacyManifest(target, legacyManifestSha256);
    const initial = await readPackageManifest(target, legacyManifest);
    const selectedDependencyLock = locked === undefined
      ? await this.#resolveDependencies(target, initial.manifest, signal)
      : (await this.#restoreDependencies(target, initial.manifest, locked.dependencyLock, signal), locked.dependencyLock);
    const selected = await readPackageManifest(target, legacyManifest);
    signal?.throwIfAborted();
    return {
      ...selected,
      contentSha256: await packageContentSha256(target, signal),
      ...(selectedDependencyLock === undefined ? {} : { dependencyLock: selectedDependencyLock }),
      ...(selectedDependencyLock === undefined ? {} : {
        dependencyContentSha256: await packageDependencyContentSha256(target, selectedDependencyLock, signal),
      }),
    };
  }

  async #packNpm(specifier: string, destination: string, signal?: AbortSignal): Promise<{
    archivePath: string;
    archiveSha256: string;
  }> {
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const output = await this.#runNpm([
      "pack",
      specifier,
      "--json",
      "--pack-destination",
      destination,
      "--ignore-scripts",
    ], this.#workspace, dirname(destination), signal);
    let filename: string | undefined;
    try {
      const parsed = JSON.parse(output) as unknown;
      if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("expected one archive");
      const first = object(parsed[0], "npm pack result");
      filename = requiredString(first.filename, "npm pack filename", 512);
    } catch {
      const archives = (await readdir(destination, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".tgz"))
        .map((entry) => entry.name);
      if (archives.length !== 1) throw new Error("npm pack did not produce exactly one archive");
      [filename] = archives;
    }
    if (filename === undefined) throw new Error("npm pack did not report an archive filename");
    if (filename !== basename(filename)) throw new Error("npm pack returned an unsafe archive filename");
    const archivePath = resolve(destination, filename);
    if (relative(resolve(destination), archivePath).startsWith(`..${sep}`)) {
      throw new Error("npm pack archive escaped its destination");
    }
    const information = await lstat(archivePath);
    if (!information.isFile() || information.isSymbolicLink() || information.size > MAX_CONTENT_BYTES) {
      throw new Error("npm pack archive must be a bounded regular file");
    }
    return {
      archivePath,
      archiveSha256: sha256(await readFile(archivePath)),
    };
  }

  async #materializeNpm(
    specifier: string,
    expectedPackageName: string,
    target: string,
    workRoot: string,
    signal?: AbortSignal,
    locked?: { dependencyLock: ProjectPackageDependencyLock | undefined },
    legacyManifestSha256?: string,
  ): Promise<{
    manifest: PackageManifest;
    manifestSha256: string;
    manifestPath: string;
    contentSha256: string;
    dependencyLock?: ProjectPackageDependencyLock;
    dependencyContentSha256?: string;
    archiveSha256: string;
    packageName: string;
    version: string;
  }> {
    const archive = await this.#packNpm(specifier, join(workRoot, "archive"), signal);
    const installRoot = join(workRoot, "install");
    await mkdir(installRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(installRoot, "package.json"), `${JSON.stringify({ name: "project-package-stage", private: true })}\n`, { mode: 0o600 });
    await this.#runNpm([
      "install",
      pathToFileURL(archive.archivePath).href,
      "--prefix",
      installRoot,
      "--omit=dev",
      "--ignore-scripts=true",
      "--bin-links=false",
      "--legacy-peer-deps",
    ], this.#workspace, workRoot, signal);
    const nodeModules = join(installRoot, "node_modules");
    const source = join(nodeModules, ...expectedPackageName.split("/"));
    const information = await lstat(source);
    if (!information.isDirectory() || information.isSymbolicLink()) throw new Error("npm installed package is not a real directory");
    const budget: CopyBudget = { entries: 0, bytes: 0, ...(signal === undefined ? {} : { signal }) };
    await copyPackageTree(source, target, budget);
    const legacyManifest = await matchesLegacyManifest(target, legacyManifestSha256);
    const initial = await readPackageManifest(target, legacyManifest, true);
    const selectedDependencyLock = locked === undefined
      ? await this.#resolveDependencies(target, initial.manifest, signal)
      : (await this.#restoreDependencies(target, initial.manifest, locked.dependencyLock, signal), locked.dependencyLock);
    const selected = await readPackageManifest(target, legacyManifest, true);
    const packageName = selected.manifest.packageName ?? expectedPackageName;
    const version = selected.manifest.packageVersion ?? selected.manifest.version;
    if (packageName !== expectedPackageName || version === undefined || validVersion(version) === null) {
      throw new Error("npm archive identity changed during installation");
    }
    signal?.throwIfAborted();
    return {
      ...selected,
      contentSha256: await packageContentSha256(target, signal),
      archiveSha256: archive.archiveSha256,
      packageName,
      version,
      ...(selectedDependencyLock === undefined ? {} : { dependencyLock: selectedDependencyLock }),
      ...(selectedDependencyLock === undefined ? {} : {
        dependencyContentSha256: await packageDependencyContentSha256(target, selectedDependencyLock, signal),
      }),
    };
  }

  async #materializeGit(
    repositoryValue: string,
    ref: string | undefined,
    target: string,
    workRoot: string,
    signal?: AbortSignal,
    locked?: { dependencyLock: ProjectPackageDependencyLock | undefined },
    legacyManifestSha256?: string,
  ): Promise<{
    manifest: PackageManifest;
    manifestSha256: string;
    manifestPath: string;
    contentSha256: string;
    dependencyLock?: ProjectPackageDependencyLock;
    dependencyContentSha256?: string;
    revision: string;
  }> {
    const cloneRoot = join(workRoot, "repository");
    const home = join(workRoot, "git-home");
    const template = join(workRoot, "git-template");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(template, { recursive: true, mode: 0o700 });
    const protocol = gitRepositoryProtocol(repositoryValue);
    const selectedRef = ref === undefined ? undefined : validateGitRef(ref);
    const commandOptions = {
      ...(signal === undefined ? {} : { signal }),
      quotaRoot: cloneRoot,
      git: { protocol, home, template },
    };
    await this.#run("git", [
      "clone",
      "--quiet",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-checkout",
      "--template",
      template,
      "--config", `core.hooksPath=${template}`,
      "--config", "core.fsmonitor=false",
      "--config", "submodule.recurse=false",
      "--",
      repositoryValue,
      cloneRoot,
    ], this.#workspace, commandOptions);
    let checkout = "HEAD";
    let expectedRevision: string | undefined;
    if (selectedRef !== undefined) {
      const selected = await resolveGitRemoteRef(
        async (argumentsValue) => await this.#run("git", argumentsValue, this.#workspace, commandOptions),
        repositoryValue,
        selectedRef,
        COMMAND_TIMEOUT_MS,
      );
      expectedRevision = selected.revision;
      await this.#run("git", [
        "-C", cloneRoot,
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-recurse-submodules",
        "--force",
        "--",
        "origin",
        selected.fetchRef,
      ], this.#workspace, commandOptions);
      checkout = "FETCH_HEAD";
    }
    await this.#run("git", [
      "-C", cloneRoot,
      "checkout",
      "--quiet",
      "--no-recurse-submodules",
      "--detach",
      checkout,
    ], this.#workspace, commandOptions);
    const revision = (await this.#run("git", [
      "-C", cloneRoot,
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ], this.#workspace, commandOptions)).toLowerCase();
    if (!GIT_REVISION.test(revision)) throw new Error("Git returned an invalid full commit ID");
    if (expectedRevision !== undefined && revision !== expectedRevision) {
      throw new Error(`Git ref changed while it was being installed: expected ${expectedRevision}, received ${revision}`);
    }
    const selected = await this.#copySource(cloneRoot, target, signal, locked, legacyManifestSha256);
    return { ...selected, revision };
  }

  async #resolveDeclaration(
    declaration: ProjectPackageDeclarationEntry,
    resolutionRoot: string,
    signal?: AbortSignal,
    legacyGrammar = false,
    legacyManifestSha256?: string,
  ): Promise<ProjectPackageLockEntry> {
    const directoryName = packageDirectoryName(declaration.id, 2);
    const target = join(resolutionRoot, directoryName, "package");
    const workRoot = join(resolutionRoot, directoryName, "work");
    await rm(join(resolutionRoot, directoryName), { recursive: true, force: true });
    await mkdir(workRoot, { recursive: true, mode: 0o700 });
    if (declaration.source.kind === "local") {
      const selected = await this.#copySource(
        await this.#localSource(declaration.source.path),
        target,
        signal,
        undefined,
        legacyManifestSha256,
      );
      this.#assertPackageId(selected.manifest, declaration.id);
      return parseLockEntry({
        id: declaration.id,
        declaration,
        resolved: {
          kind: "local",
          path: declaration.source.path,
          manifestSha256: selected.manifestSha256,
          contentSha256: selected.contentSha256,
          ...(selected.dependencyLock === undefined ? {} : { dependencyLock: selected.dependencyLock }),
          ...(selected.dependencyContentSha256 === undefined ? {} : {
            dependencyContentSha256: selected.dependencyContentSha256,
          }),
        },
      }, `Resolved project package ${declaration.id}`, 2, legacyGrammar);
    }
    if (declaration.source.kind === "npm") {
      if (this.#offline) throw new Error(`Cannot update remote project package ${declaration.id} while offline`);
      const selected = await this.#materializeNpm(
        `${declaration.source.package}@${declaration.source.selector}`,
        declaration.source.package,
        target,
        workRoot,
        signal,
        undefined,
        legacyManifestSha256,
      );
      this.#assertPackageId(selected.manifest, declaration.id);
      if (selected.packageName !== declaration.source.package) {
        throw new Error(`Project package ${declaration.id} resolved an unexpected npm package`);
      }
      return parseLockEntry({
        id: declaration.id,
        declaration,
        resolved: {
          kind: "npm",
          source: `npm:${selected.packageName}@${selected.version}`,
          packageName: selected.packageName,
          resolvedVersion: selected.version,
          archiveSha256: selected.archiveSha256,
          manifestSha256: selected.manifestSha256,
          contentSha256: selected.contentSha256,
          ...(selected.dependencyLock === undefined ? {} : { dependencyLock: selected.dependencyLock }),
          ...(selected.dependencyContentSha256 === undefined ? {} : {
            dependencyContentSha256: selected.dependencyContentSha256,
          }),
        },
      }, `Resolved project package ${declaration.id}`, 2, legacyGrammar);
    }
    if (this.#offline) throw new Error(`Cannot update remote project package ${declaration.id} while offline`);
    const selected = await this.#materializeGit(
      declaration.source.repository,
      declaration.source.ref,
      target,
      workRoot,
      signal,
      undefined,
      legacyManifestSha256,
    );
    this.#assertPackageId(selected.manifest, declaration.id);
    return parseLockEntry({
      id: declaration.id,
      declaration,
      resolved: {
        kind: "git",
        source: `git:${declaration.source.repository}#${selected.revision}`,
        revision: selected.revision,
        manifestSha256: selected.manifestSha256,
        contentSha256: selected.contentSha256,
        ...(selected.dependencyLock === undefined ? {} : { dependencyLock: selected.dependencyLock }),
        ...(selected.dependencyContentSha256 === undefined ? {} : {
          dependencyContentSha256: selected.dependencyContentSha256,
        }),
      },
    }, `Resolved project package ${declaration.id}`, 2, legacyGrammar);
  }

  async #materializeLocked(
    entry: ProjectPackageLockEntry,
    target: string,
    resolutionRoot: string,
    signal?: AbortSignal,
    legacyGrammar = false,
    directoryName = entry.id,
  ): Promise<void> {
    const workRoot = join(resolutionRoot, directoryName);
    await rm(workRoot, { recursive: true, force: true });
    await mkdir(workRoot, { recursive: true, mode: 0o700 });
    let selected: {
      manifest: PackageManifest;
      manifestSha256: string;
      manifestPath: string;
      contentSha256: string;
      archiveSha256?: string;
      packageName?: string;
      version?: string;
      revision?: string;
      dependencyLock?: ProjectPackageDependencyLock;
      dependencyContentSha256?: string;
    };
    const legacyManifestSha256 = legacyGrammar ? entry.resolved.manifestSha256 : undefined;
    if (entry.resolved.kind === "local") {
      selected = await this.#copySource(await this.#localSource(entry.resolved.path), target, signal, {
        dependencyLock: entry.resolved.dependencyLock,
      }, legacyManifestSha256);
    } else if (entry.resolved.kind === "npm") {
      if (this.#offline) throw new Error(`Cannot restore remote project package ${entry.id} while offline`);
      selected = await this.#materializeNpm(
        `${entry.resolved.packageName}@${entry.resolved.resolvedVersion}`,
        entry.resolved.packageName,
        target,
        workRoot,
        signal,
        { dependencyLock: entry.resolved.dependencyLock },
        legacyManifestSha256,
      );
      if (
        selected.packageName !== entry.resolved.packageName
        || selected.version !== entry.resolved.resolvedVersion
        || selected.archiveSha256 !== entry.resolved.archiveSha256
      ) {
        throw new Error(`Project package ${entry.id} npm archive does not match its lock`);
      }
    } else {
      if (this.#offline) throw new Error(`Cannot restore remote project package ${entry.id} while offline`);
      const parsed = parsedGitSource(entry.resolved.source, legacyGrammar);
      if (parsed === undefined) throw new Error(`Project package ${entry.id} has an invalid locked Git source`);
      selected = await this.#materializeGit(
        parsed.repo,
        entry.resolved.revision,
        target,
        workRoot,
        signal,
        { dependencyLock: entry.resolved.dependencyLock },
        legacyManifestSha256,
      );
      if (selected.revision !== entry.resolved.revision) {
        throw new Error(`Project package ${entry.id} Git revision does not match its lock`);
      }
    }
    this.#assertPackageId(selected.manifest, entry.id);
    if (selected.manifestSha256 !== entry.resolved.manifestSha256) {
      throw new Error(`Project package ${entry.id} manifest digest does not match its lock`);
    }
    if (selected.contentSha256 !== entry.resolved.contentSha256) {
      throw new Error(`Project package ${entry.id} content digest does not match its lock`);
    }
    if (
      selected.dependencyLock?.sha256 !== entry.resolved.dependencyLock?.sha256
      || selected.dependencyLock?.content !== entry.resolved.dependencyLock?.content
    ) {
      throw new Error(`Project package ${entry.id} dependency lock does not match its immutable snapshot`);
    }
    if (selected.dependencyContentSha256 !== entry.resolved.dependencyContentSha256) {
      throw new Error(`Project package ${entry.id} dependency content does not match its immutable snapshot`);
    }
    const dependencyPlatformContentSha256 = entry.resolved.dependencyLock === undefined
      ? undefined
      : (await packageDependencyContentDigests(target, entry.resolved.dependencyLock, signal)).platformSha256;
    const provenance = projectPackageProvenance(
      entry.id,
      entry.declaration,
      entry.resolved,
      dependencyPlatformContentSha256,
    );
    await writeFile(join(target, PROJECT_PACKAGE_PROVENANCE), `${JSON.stringify(provenance, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  }

  async #platformAttestationPath(
    lock: ProjectPackageLock,
    packageIdValue: string,
  ): Promise<string> {
    const workspaceSha256 = sha256(await realpath(this.#workspace));
    return join(
      this.#attestationRoot,
      workspaceSha256,
      lockSha256(lock),
      packageDirectoryName(packageIdValue, 2),
      `${sha256(dependencyPlatformFingerprint())}.json`,
    );
  }

  async #assertPlatformAttestation(
    lock: ProjectPackageLock,
    packageIdValue: string,
    platformDigest: string,
  ): Promise<void> {
    const path = await this.#platformAttestationPath(lock, packageIdValue);
    const expected = `${JSON.stringify({
      schemaVersion: 1,
      lockSha256: lockSha256(lock),
      packageId: packageIdValue,
      platformFingerprint: dependencyPlatformFingerprint(),
      dependencyPlatformContentSha256: platformDigest,
    })}\n`;
    let information;
    try {
      information = await lstat(path);
    } catch (error) {
      if (missing(error)) throw new Error(`Project package ${packageIdValue} local platform attestation is missing`);
      throw error;
    }
    if (!information.isFile() || information.isSymbolicLink() || information.size !== Buffer.byteLength(expected)) {
      throw new Error(`Project package ${packageIdValue} local platform attestation is unsafe`);
    }
    if (await readFile(path, "utf8") !== expected) {
      throw new Error(`Project package ${packageIdValue} local platform attestation is invalid`);
    }
  }

  async #recordPlatformAttestations(
    lock: ProjectPackageLock,
    packages: readonly InstalledProjectPackage[],
  ): Promise<void> {
    for (const installed of packages) {
      const platformDigest = installed.provenance.dependencyPlatformContentSha256;
      if (platformDigest === undefined) continue;
      const path = await this.#platformAttestationPath(lock, installed.id);
      const directory = dirname(path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryInformation = await lstat(directory);
      if (!directoryInformation.isDirectory() || directoryInformation.isSymbolicLink() || await realpath(directory) !== directory) {
        throw new Error(`Project package ${installed.id} local platform attestation directory is unsafe`);
      }
      const data = `${JSON.stringify({
        schemaVersion: 1,
        lockSha256: lockSha256(lock),
        packageId: installed.id,
        platformFingerprint: dependencyPlatformFingerprint(),
        dependencyPlatformContentSha256: platformDigest,
      })}\n`;
      let handle;
      try {
        handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        await handle.writeFile(data);
        await handle.sync();
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      } finally {
        await handle?.close().catch(() => undefined);
      }
      await this.#assertPlatformAttestation(lock, installed.id, platformDigest);
    }
  }

  async #stageLock(lock: ProjectPackageLock, signal?: AbortSignal): Promise<void> {
    const stageRoot = join(this.#workspace, PROJECT_PACKAGE_STAGE_ROOT);
    const resolutionRoot = join(this.#workspace, PROJECT_PACKAGE_RESOLUTION_ROOT);
    await rm(stageRoot, { recursive: true, force: true });
    await rm(resolutionRoot, { recursive: true, force: true });
    await mkdir(stageRoot, { recursive: true, mode: 0o700 });
    await mkdir(resolutionRoot, { recursive: true, mode: 0o700 });
    let host: RuntimeExtensionHost | undefined;
    let failure: unknown;
    try {
      for (const entry of lock.packages) {
        signal?.throwIfAborted();
        const directoryName = packageDirectoryName(entry.id, lock.schemaVersion);
        await this.#materializeLocked(
          entry,
          join(stageRoot, directoryName),
          resolutionRoot,
          signal,
          lock.schemaVersion === 1 || lock.declarationGrammar === "legacy",
          directoryName,
        );
      }
      signal?.throwIfAborted();
      const packages = await this.#installed(lock, stageRoot, signal);
      const catalog = catalogEntries(lock);
      const resolver = new DefaultPackageManager({
        cwd: this.#workspace,
        agentDir: join(resolutionRoot, "agent"),
        settingsManager: SettingsManager.inMemory(),
      });
      const resources = await resolver.resolveExtensionSources(
        projectPackageResourceSources(packages, catalog),
        { temporary: true },
      );
      const paths = resources.extensions.filter((entry) => entry.enabled).map((entry) => entry.path);
      host = await loadDirectExtensions(paths, {
        workspace: this.#workspace,
        dataRoot: join(resolutionRoot, "activation-data"),
        projectTrusted: true,
        directPathMetadata: projectPackageDirectMetadata(resources, packages, catalog),
        activationFailure: "throw",
        ...(signal === undefined ? {} : { signal }),
      });
      const collision = host.diagnostics().find((entry) => /was ignored because/u.test(entry.message));
      if (collision !== undefined) throw new Error(`Project package activation reported: ${collision.message}`);
      signal?.throwIfAborted();
    } catch (error) {
      failure = error;
      await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    let closeFailure: unknown;
    try {
      await host?.close();
    } catch (error) {
      closeFailure = error;
      await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    } finally {
      await rm(resolutionRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    if (failure === undefined && closeFailure === undefined) {
      try {
        for (const entry of lock.packages) {
          signal?.throwIfAborted();
          const packageRoot = join(stageRoot, packageDirectoryName(entry.id, lock.schemaVersion));
          const selected = await readPackageManifest(packageRoot, await matchesLegacyManifest(
            packageRoot,
            lock.schemaVersion === 1 || lock.declarationGrammar === "legacy"
              ? entry.resolved.manifestSha256
              : undefined,
          ));
          await this.#restoreDependencies(packageRoot, selected.manifest, entry.resolved.dependencyLock, signal);
        }
        const stagedPackages = await this.#installed(lock, stageRoot, signal);
        await this.#recordPlatformAttestations(lock, stagedPackages);
      } catch (error) {
        failure = error;
        await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    if (failure !== undefined && closeFailure !== undefined) {
      throw new AggregateError([failure, closeFailure], "Project package activation and cleanup failed");
    }
    if (failure !== undefined) throw failure;
    if (closeFailure !== undefined) throw closeFailure;
  }

  #parseInstalledProvenance(
    value: unknown,
    entry: ProjectPackageLockEntry,
    lockSchemaVersion: 1 | 2,
  ): ProjectPackageProvenance {
    const input = object(value, `Project package ${entry.id} provenance`);
    assertAllowed(input, [
      "schemaVersion", "kind", "id", "scope", "sourcePath", "source", "packageName", "resolvedVersion", "archiveSha256", "revision",
      "installedAt", "updatedAt", "manifestSha256", "dependencyPlatformContentSha256",
    ], `Project package ${entry.id} provenance`);
    const installedAt = requiredString(input.installedAt, `Project package ${entry.id} installedAt`, 64);
    const updatedAt = input.updatedAt === undefined
      ? undefined
      : requiredString(input.updatedAt, `Project package ${entry.id} updatedAt`, 64);
    const dependencyPlatformContentSha256 = input.dependencyPlatformContentSha256 === undefined
      ? undefined
      : digest(input.dependencyPlatformContentSha256, `Project package ${entry.id} dependencyPlatformContentSha256`);
    if (
      input.schemaVersion !== 1
      || input.id !== entry.id
      || input.scope !== "project"
      || input.kind !== entry.resolved.kind
      || input.manifestSha256 !== entry.resolved.manifestSha256
      || !Number.isFinite(Date.parse(installedAt))
      || (updatedAt !== undefined && !Number.isFinite(Date.parse(updatedAt)))
      || (lockSchemaVersion === 1 && dependencyPlatformContentSha256 !== undefined)
      || (lockSchemaVersion === 2 && (entry.resolved.dependencyLock === undefined) !== (dependencyPlatformContentSha256 === undefined))
    ) {
      throw new Error(`Project package ${entry.id} provenance does not match its lock`);
    }
    const common = {
      schemaVersion: 1 as const,
      id: entry.id,
      scope: "project" as const,
      installedAt,
      ...(updatedAt === undefined ? {} : { updatedAt }),
      manifestSha256: entry.resolved.manifestSha256,
      ...(dependencyPlatformContentSha256 === undefined ? {} : { dependencyPlatformContentSha256 }),
    };
    if (entry.resolved.kind === "npm") {
      if (
        input.packageName !== entry.resolved.packageName
        || input.resolvedVersion !== entry.resolved.resolvedVersion
        || input.archiveSha256 !== entry.resolved.archiveSha256
      ) throw new Error(`Project package ${entry.id} npm provenance does not match its lock`);
      const source = requiredString(input.source, `Project package ${entry.id} npm source`, 4096);
      if (lockSchemaVersion === 2 && source !== entry.resolved.source) {
        throw new Error(`Project package ${entry.id} npm provenance does not match its lock`);
      }
      if (lockSchemaVersion === 1 && !source.startsWith(`npm:${entry.resolved.packageName}@`)) {
        throw new Error(`Project package ${entry.id} npm provenance has an invalid source`);
      }
      if (input.sourcePath !== undefined || input.revision !== undefined) {
        throw new Error(`Project package ${entry.id} npm provenance contains unrelated source fields`);
      }
      return {
        ...common,
        kind: "npm",
        source,
        packageName: entry.resolved.packageName,
        resolvedVersion: entry.resolved.resolvedVersion,
        archiveSha256: entry.resolved.archiveSha256,
      };
    }
    if (entry.resolved.kind === "git") {
      const source = requiredString(input.source, `Project package ${entry.id} Git source`, 4096);
      const moving = parsedGitSource(source, lockSchemaVersion === 1);
      const locked = parsedGitSource(entry.resolved.source, lockSchemaVersion === 1);
      if (
        input.revision !== entry.resolved.revision
        || (lockSchemaVersion === 2 && source !== entry.resolved.source)
        || (lockSchemaVersion === 1 && (moving === undefined || locked === undefined || moving.repo !== locked.repo))
      ) {
        throw new Error(`Project package ${entry.id} Git provenance does not match its lock`);
      }
      if (input.sourcePath !== undefined || input.packageName !== undefined || input.resolvedVersion !== undefined || input.archiveSha256 !== undefined) {
        throw new Error(`Project package ${entry.id} Git provenance contains unrelated source fields`);
      }
      return { ...common, kind: "git", source, revision: entry.resolved.revision };
    }
    const sourcePath = requiredString(input.sourcePath, `Project package ${entry.id} local sourcePath`, 4096);
    if (
      entry.declaration.source.kind !== "local"
      || (lockSchemaVersion === 1 ? !isAbsolute(sourcePath) : sourcePath !== entry.declaration.source.path)
      || input.source !== undefined
      || input.packageName !== undefined
      || input.resolvedVersion !== undefined
      || input.archiveSha256 !== undefined
      || input.revision !== undefined
    ) {
      throw new Error(`Project package ${entry.id} local provenance does not match its lock`);
    }
    return { ...common, kind: "local", sourcePath };
  }

  async #verifyInstalledDependencies(
    packageRoot: string,
    manifest: PackageManifest,
    selected: ProjectPackageDependencyLock | undefined,
    expectedContentSha256: string | undefined,
    expectedPlatformContentSha256: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!this.#hasProductionDependencies(manifest)) {
      if (selected !== undefined || expectedContentSha256 !== undefined || expectedPlatformContentSha256 !== undefined) {
        throw new Error("Project package dependency lock exists without production dependencies");
      }
      for (const name of ["package-lock.json", "npm-shrinkwrap.json", "node_modules"]) {
        try {
          await lstat(join(packageRoot, name));
          throw new Error(`Project package without production dependencies contains ${name}`);
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      return;
    }
    if (selected === undefined) throw new Error("Project package production dependencies are missing their immutable lock");
    if (expectedContentSha256 === undefined) throw new Error("Project package dependency content digest is missing");
    if (expectedPlatformContentSha256 === undefined) throw new Error("Project package dependency platform attestation is missing");
    await this.#assertRequiredProductionDependencies(packageRoot, manifest);
    const current = await this.#readDependencyLock(packageRoot);
    if (current.sha256 !== selected.sha256 || current.content !== selected.content) {
      throw new Error("Project package installed dependency lock does not match its immutable snapshot");
    }
    const digests = await packageDependencyContentDigests(packageRoot, selected, signal);
    if (digests.portableSha256 !== expectedContentSha256) {
      throw new Error("Project package installed dependency content does not match its immutable snapshot");
    }
    if (digests.platformSha256 !== expectedPlatformContentSha256) {
      throw new Error("Project package installed optional dependency content does not match its local attestation");
    }
    const root = object(JSON.parse(selected.content) as unknown, "Project package dependency lock");
    const packages = object(root.packages, "Project package dependency lock packages");
    for (const [path, metadataValue] of Object.entries(packages)) {
      signal?.throwIfAborted();
      if (path === "") continue;
      const metadata = object(metadataValue, `Project package dependency ${path}`);
      if (metadata.dev === true || metadata.link === true) continue;
      const version = metadata.version;
      if (typeof version !== "string") continue;
      const dependencyRoot = join(packageRoot, ...path.split("/"));
      try {
        const information = await lstat(dependencyRoot);
        if (!information.isDirectory() || information.isSymbolicLink()) {
          throw new Error(`Project package dependency ${path} is not a real directory`);
        }
        if (await readDependencyPackageVersion(dependencyRoot, `Project package dependency ${path}`) !== version) {
          throw new Error(`Project package dependency ${path} does not match its locked version`);
        }
      } catch (error) {
        if (
          (
            metadata.optional === true
            || Array.isArray(metadata.os)
            || Array.isArray(metadata.cpu)
            || Array.isArray(metadata.libc)
          )
          && missing(error)
        ) continue;
        throw error;
      }
    }
  }

  async #installedEntry(
    entry: ProjectPackageLockEntry,
    root: string,
    lock: ProjectPackageLock,
    verifyPlatformAttestation: boolean,
    signal?: AbortSignal,
  ): Promise<InstalledProjectPackage> {
    const schemaVersion = lock.schemaVersion;
    const packageRoot = join(root, packageDirectoryName(entry.id, schemaVersion));
    const information = await lstat(packageRoot);
    if (!information.isDirectory() || information.isSymbolicLink() || await realpath(packageRoot) !== packageRoot) {
      throw new Error(`Project package ${entry.id} install root is unsafe`);
    }
    const selected = await readPackageManifest(packageRoot, await matchesLegacyManifest(
      packageRoot,
      schemaVersion === 1 || lock.declarationGrammar === "legacy" ? entry.resolved.manifestSha256 : undefined,
    ));
    this.#assertPackageId(selected.manifest, entry.id);
    if (selected.manifestSha256 !== entry.resolved.manifestSha256) {
      throw new Error(`Project package ${entry.id} manifest digest does not match its lock`);
    }
    if (await packageContentSha256(packageRoot, signal, schemaVersion === 1) !== entry.resolved.contentSha256) {
      throw new Error(`Project package ${entry.id} content digest does not match its lock`);
    }
    const provenanceValue = await optionalJson(
      join(packageRoot, PROJECT_PACKAGE_PROVENANCE),
      `Project package ${entry.id} provenance`,
    );
    if (provenanceValue === undefined) throw new Error(`Project package ${entry.id} provenance is missing`);
    const provenance = this.#parseInstalledProvenance(provenanceValue, entry, schemaVersion);
    if (schemaVersion === 2) {
      await this.#verifyInstalledDependencies(
        packageRoot,
        selected.manifest,
        entry.resolved.dependencyLock,
        entry.resolved.dependencyContentSha256,
        provenance.dependencyPlatformContentSha256,
        signal,
      );
      if (verifyPlatformAttestation && provenance.dependencyPlatformContentSha256 !== undefined) {
        await this.#assertPlatformAttestation(lock, entry.id, provenance.dependencyPlatformContentSha256);
      }
    }
    const installed: InstalledProjectPackage = {
      id: entry.id,
      name: selected.manifest.name,
      ...(selected.manifest.version === undefined ? {} : { version: selected.manifest.version }),
      ...(selected.manifest.description === undefined ? {} : { description: selected.manifest.description }),
      scope: "project",
      packageRoot,
      manifestPath: selected.manifestPath,
      manifestModified: false,
      provenance,
    };
    return installed;
  }

  async #installed(
    lock: ProjectPackageLock,
    root = join(this.#workspace, PROJECT_PACKAGE_INSTALL_ROOT),
    signal?: AbortSignal,
    verifyPlatformAttestations = resolve(root) === resolve(join(this.#workspace, PROJECT_PACKAGE_INSTALL_ROOT)),
  ): Promise<InstalledProjectPackage[]> {
    signal?.throwIfAborted();
    if (lock.packages.length === 0 && !await directoryExists(root)) return [];
    const names = (await readdir(root))
      .filter((name) => lock.schemaVersion !== 1 || name !== ".rigyn-packages.lock")
      .sort(lock.schemaVersion === 1 ? compareLegacy : comparePortable);
    const expected = lock.packages.map((entry) => packageDirectoryName(entry.id, lock.schemaVersion))
      .sort(lock.schemaVersion === 1 ? compareLegacy : comparePortable);
    if (lock.schemaVersion === 2) assertPortableNames(expected, "Installed project package directories");
    if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error("Installed project package set does not match its lock");
    const installed: InstalledProjectPackage[] = [];
    for (const entry of lock.packages) {
      signal?.throwIfAborted();
      installed.push(await this.#installedEntry(entry, root, lock, verifyPlatformAttestations, signal));
    }
    return installed;
  }

  async #installedMatches(
    lock: ProjectPackageLock,
    signal?: AbortSignal,
  ): Promise<InstalledProjectPackage[] | undefined> {
    const root = join(this.#workspace, PROJECT_PACKAGE_INSTALL_ROOT);
    if (!await directoryExists(root)) return lock.packages.length === 0 ? [] : undefined;
    try {
      return await this.#installed(lock, root, signal);
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason ?? error;
      return undefined;
    }
  }

  async #commitStaged(lock: ProjectPackageLock, writeLock = false): Promise<void> {
    const stage = join(this.#workspace, PROJECT_PACKAGE_STAGE_ROOT);
    const active = join(this.#workspace, PROJECT_PACKAGE_INSTALL_ROOT);
    const backup = join(this.#workspace, PROJECT_PACKAGE_BACKUP_ROOT);
    const transaction = join(this.#workspace, PROJECT_PACKAGE_TRANSACTION);
    const lockPath = join(this.#workspace, PROJECT_PACKAGE_LOCK);
    await rm(backup, { recursive: true, force: true });
    const targetLockSha256 = lockSha256(lock);
    const writeTransaction = async (phase: "prepared" | "backed-up" | "activated"): Promise<void> => {
      await atomicWrite(transaction, Buffer.from(`${JSON.stringify({ schemaVersion: 1, targetLockSha256, phase })}\n`));
    };
    await writeTransaction("prepared");
    let activeMoved = false;
    let stagedActivated = false;
    try {
      if (await directoryExists(active)) {
        await rename(active, backup);
        activeMoved = true;
      }
      await writeTransaction("backed-up");
      await rename(stage, active);
      stagedActivated = true;
      await writeTransaction("activated");
      if (writeLock) await atomicWrite(lockPath, serializeLock(lock));
    } catch (error) {
      if (stagedActivated) await rm(active, { recursive: true, force: true }).catch(() => undefined);
      if (activeMoved) {
        try {
          await rename(backup, active);
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], `Unable to roll back project package transaction; previous packages remain in ${backup}`);
        }
      }
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      await rm(transaction, { force: true }).catch(() => undefined);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
    await rm(transaction, { force: true });
  }

  async #recoverTransaction(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const stage = join(this.#workspace, PROJECT_PACKAGE_STAGE_ROOT);
    const active = join(this.#workspace, PROJECT_PACKAGE_INSTALL_ROOT);
    const backup = join(this.#workspace, PROJECT_PACKAGE_BACKUP_ROOT);
    const transactionPath = join(this.#workspace, PROJECT_PACKAGE_TRANSACTION);
    const transactionValue = await optionalJson(transactionPath, "Project package transaction");
    if (transactionValue === undefined) {
      if (await directoryExists(backup)) {
        const rawLock = await optionalJson(
          join(this.#workspace, PROJECT_PACKAGE_LOCK),
          "Project package lock",
          MAX_PROJECT_PACKAGE_LOCK_BYTES,
        );
        if (rawLock === undefined) {
          throw new Error("Project package recovery found a backup without a transaction marker or lock; package sets were preserved for manual recovery");
        }
        const currentLock = parseProjectPackageLock(rawLock);
        const matchesLock = async (root: string): Promise<boolean> => {
          try {
            await this.#installed(currentLock, root, signal, true);
            return true;
          } catch (error) {
            if (signal?.aborted === true) throw signal.reason ?? error;
            return false;
          }
        };
        const activeExists = await directoryExists(active);
        if (activeExists && await matchesLock(active)) {
          await rm(backup, { recursive: true, force: true });
        } else if (await matchesLock(backup)) {
          if (activeExists) await rm(active, { recursive: true, force: true });
          await rename(backup, active);
        } else {
          throw new Error("Project package recovery found no package set matching the current lock; active and backup sets were preserved for manual recovery");
        }
      }
      await rm(stage, { recursive: true, force: true });
      await rm(join(this.#workspace, PROJECT_PACKAGE_RESOLUTION_ROOT), { recursive: true, force: true });
      return;
    }
    const input = object(transactionValue, "Project package transaction");
    assertAllowed(input, ["schemaVersion", "targetLockSha256", "phase"], "Project package transaction");
    if (input.schemaVersion !== 1) throw new Error("Project package transaction schemaVersion must be 1");
    const expectedLockSha256 = digest(input.targetLockSha256, "Project package transaction targetLockSha256");
    const phase = requiredString(input.phase, "Project package transaction phase", 16);
    if (phase !== "prepared" && phase !== "backed-up" && phase !== "activated") {
      throw new Error("Project package transaction phase is invalid");
    }
    const rawLock = await optionalJson(
      join(this.#workspace, PROJECT_PACKAGE_LOCK),
      "Project package lock",
      MAX_PROJECT_PACKAGE_LOCK_BYTES,
    );
    const currentLock = rawLock === undefined ? undefined : parseProjectPackageLock(rawLock);
    const activeMatchesCurrentLock = async (): Promise<boolean> => {
      if (currentLock === undefined || !await directoryExists(active)) return false;
      return await this.#installedMatches(currentLock, signal) !== undefined;
    };
    const committed = currentLock !== undefined && lockSha256(currentLock) === expectedLockSha256;
    if (committed) {
      if (!await directoryExists(active)) {
        throw new Error("Committed project package transaction is missing its active package set");
      }
      await this.#installed(currentLock, active, signal);
      await rm(backup, { recursive: true, force: true });
      await rm(stage, { recursive: true, force: true });
      await rm(join(this.#workspace, PROJECT_PACKAGE_RESOLUTION_ROOT), { recursive: true, force: true });
      await rm(transactionPath, { force: true });
      return;
    }
    if (phase === "prepared" || phase === "backed-up") {
      if (await directoryExists(backup)) {
        if (await directoryExists(active)) await rm(active, { recursive: true, force: true });
        await rename(backup, active);
      } else if (phase === "backed-up" && await directoryExists(active) && !await activeMatchesCurrentLock()) {
        await rm(active, { recursive: true, force: true });
      }
      await rm(stage, { recursive: true, force: true });
      await rm(join(this.#workspace, PROJECT_PACKAGE_RESOLUTION_ROOT), { recursive: true, force: true });
      await rm(transactionPath, { force: true });
      return;
    }
    if (await directoryExists(backup)) {
      await rm(active, { recursive: true, force: true });
      await rename(backup, active);
    } else if (await directoryExists(active) && !await activeMatchesCurrentLock()) {
      await rm(active, { recursive: true, force: true });
    }
    await rm(stage, { recursive: true, force: true });
    await rm(join(this.#workspace, PROJECT_PACKAGE_RESOLUTION_ROOT), { recursive: true, force: true });
    await rm(transactionPath, { force: true });
  }

  async #prepareControlDirectory(): Promise<void> {
    const boundary = await WorkspaceBoundary.create(this.#workspace);
    const directory = await boundary.writable(".rigyn", { createParents: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const information = await lstat(directory);
    if (!information.isDirectory() || information.isSymbolicLink() || await realpath(directory) !== directory) {
      throw new Error("Project control directory must be a real directory inside the workspace");
    }
  }

  async #acquireOperationLock(signal?: AbortSignal): Promise<() => Promise<void>> {
    await mkdir(this.#operationLeaseRoot, { recursive: true, mode: 0o700 });
    const leaseInformation = await lstat(this.#operationLeaseRoot);
    if (!leaseInformation.isDirectory() || leaseInformation.isSymbolicLink() || await realpath(this.#operationLeaseRoot) !== this.#operationLeaseRoot) {
      throw new Error("Project package operation lease root must be a real directory");
    }
    const canonicalWorkspace = await realpath(this.#workspace);
    const path = join(this.#operationLeaseRoot, `project-packages-${sha256(canonicalWorkspace)}.lock`);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    const token = randomBytes(16).toString("hex");
    while (true) {
      signal?.throwIfAborted();
      try {
        const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, token })}\n`);
        await handle.close();
        return async () => {
          try {
            const current = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
            if (current.token === token) await rm(path, { force: true });
          } catch (error) {
            if (!missing(error)) throw error;
          }
        };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      let incomplete = false;
      try {
        const current = JSON.parse(await readFile(path, "utf8")) as {
          schemaVersion?: unknown;
          pid?: unknown;
          token?: unknown;
        };
        const valid = current.schemaVersion === 1
          && typeof current.pid === "number"
          && Number.isSafeInteger(current.pid)
          && current.pid > 0
          && typeof current.token === "string"
          && /^[a-f0-9]{32}$/u.test(current.token);
        if (!valid) {
          incomplete = true;
        } else {
          try {
            process.kill(current.pid as number, 0);
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ESRCH") {
              await rm(path, { force: true });
              continue;
            }
          }
        }
      } catch (error) {
        if (missing(error)) continue;
        incomplete = true;
      }
      if (incomplete) {
        try {
          if (Date.now() - (await stat(path)).mtimeMs >= INCOMPLETE_LOCK_STALE_MS) {
            await rm(path, { force: true });
            continue;
          }
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
      }
      if (Date.now() >= deadline) throw new Error(`Project package operation lock timed out after ${LOCK_TIMEOUT_MS}ms`);
      try {
        await delay(50, undefined, signal === undefined ? undefined : { signal });
      } catch (error) {
        if (signal?.aborted === true) throw signal.reason ?? error;
        throw error;
      }
    }
  }

  async #withOperationLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.#prepareControlDirectory();
    const release = await this.#acquireOperationLock(signal);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation, operation);
    this.#operations = result.then(() => undefined, () => undefined);
    return result;
  }
}
