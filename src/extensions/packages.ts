import { constants } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { minimatch } from "minimatch";
import { satisfies, valid as validSemver } from "semver";

import { trackActiveProcessGroup } from "../process/active-groups.js";
import { normalizeCommandArgv } from "../process/command.js";
import { sha256 } from "../tools/hash.js";
import { parseThemeDefinition } from "../tui/theme.js";
import { RIGYN_VERSION } from "../version.js";
import { discoverExtensions } from "./loader.js";
import { parseExtensionManifest, type ParsedExtensionManifest } from "./manifest.js";
import type { ExtensionSource } from "./types.js";

export const EXTENSION_PACKAGE_PROVENANCE = ".rigyn-package.json";
export const DEFAULT_MAX_PACKAGE_ENTRIES = 4096;
export const DEFAULT_MAX_PACKAGE_FILE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_PACKAGE_DEPTH = 64;
export const DEFAULT_PACKAGE_SOURCE_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_PACKAGE_COMMAND_OUTPUT_BYTES = 1024 * 1024;
export const EXTENSION_PACKAGE_LOCK = ".rigyn-packages.lock";

const MANIFEST_NAME = "extension.json";
const PACKAGE_JSON_NAME = "package.json";
const MANIFEST_MAX_BYTES = 256 * 1024;
const PROVENANCE_MAX_BYTES = 64 * 1024;
const IDENTIFIER = /^[a-z][a-z0-9._-]{0,62}$/u;
const NPM_PART = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const UNPARSEABLE_PACKAGE_LOCK_MAX_AGE_MS = 15 * 60_000;
const PACKAGE_LOCK_BYTES = 4096;
const PACKAGE_STAGE_PREFIX = ".rigyn-package-stage-";
const PACKAGE_BACKUP_PREFIX = ".rigyn-package-backup-";
const PACKAGE_REMOVE_PREFIX = ".rigyn-package-remove-";
const PACKAGE_TRANSACTION = "transaction.json";
const PACKAGE_TRANSACTION_BYTES = 1024;
const PACKAGE_TASKKILL_TIMEOUT_MS = 5_000;

export type ExtensionPackageScope = "user" | "project";

export interface ExtensionPackageRoots {
  user: string;
  project?: string;
}

export interface ExtensionPackageLimits {
  maxEntries?: number;
  maxFileBytes?: number;
  maxBytes?: number;
  maxDepth?: number;
  sourceTimeoutMs?: number;
  maxCommandOutputBytes?: number;
}

export interface ExtensionPackageCommands {
  npm?: { command: string; prefix?: readonly string[] };
  git?: { command: string; prefix?: readonly string[] };
}

export interface ExtensionPackageTransactionOptions {
  allowScripts?: boolean;
  signal?: AbortSignal;
}

interface ExtensionPackageProvenanceBase {
  schemaVersion: 1;
  id: string;
  scope: ExtensionPackageScope;
  installedAt: string;
  updatedAt?: string;
  manifestSha256: string;
}

export type ExtensionPackageProvenance = ExtensionPackageProvenanceBase & (
  | { kind: "local"; sourcePath: string }
  | { kind: "npm"; source: string; packageName: string; resolvedVersion: string; archiveSha256: string }
  | { kind: "git"; source: string; revision: string }
);

export type ParsedExtensionPackageSource =
  | { kind: "local"; sourcePath: string }
  | { kind: "npm"; source: string; specifier?: string; archivePath?: string }
  | { kind: "git"; source: string; repository?: string; repositoryPath?: string; ref?: string };

export interface InstalledExtensionPackage {
  id: string;
  name: string;
  version?: string;
  description?: string;
  scope: ExtensionPackageScope;
  packageRoot: string;
  manifestPath: string;
  manifestModified: boolean;
  provenance: ExtensionPackageProvenance;
}

export interface ExtensionPackageUpdatePolicy {
  pinned: boolean;
  reason?: string;
}

interface PackageLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxBytes: number;
  maxDepth: number;
  sourceTimeoutMs: number;
  maxCommandOutputBytes: number;
}

interface CopyBudget {
  entries: number;
  bytes: number;
}

type ProductionDependencyField = "dependencies" | "optionalDependencies" | "peerDependencies";
const PRODUCTION_DEPENDENCY_FIELDS: readonly ProductionDependencyField[] = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];

interface ProductionDependencies {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

interface ParsedProductionDependencies {
  fields: ProductionDependencies;
  packageJsonSha256: string;
}

interface StagedPackage {
  container: string;
  packageRoot: string;
  manifest: ParsedExtensionManifest;
}

type SourceIdentity =
  | { kind: "local"; sourcePath: string }
  | { kind: "npm"; source: string; packageName: string; resolvedVersion: string; archiveSha256: string }
  | { kind: "git"; source: string; revision: string };

interface SourceMaterial {
  root: string;
  identity: SourceIdentity;
  cleanup?: string;
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new RangeError(`${label} must be an integer from 1 through ${maximum}`);
  }
  return selected;
}

function packageLimits(value: ExtensionPackageLimits): PackageLimits {
  const maxFileBytes = boundedInteger(value.maxFileBytes, DEFAULT_MAX_PACKAGE_FILE_BYTES, 1024 * 1024 * 1024, "maxFileBytes");
  const maxBytes = boundedInteger(value.maxBytes, DEFAULT_MAX_PACKAGE_BYTES, 1024 * 1024 * 1024, "maxBytes");
  if (maxBytes < maxFileBytes) throw new RangeError("maxBytes must be at least maxFileBytes");
  return {
    maxEntries: boundedInteger(value.maxEntries, DEFAULT_MAX_PACKAGE_ENTRIES, 100_000, "maxEntries"),
    maxFileBytes,
    maxBytes,
    maxDepth: boundedInteger(value.maxDepth, DEFAULT_MAX_PACKAGE_DEPTH, 256, "maxDepth"),
    sourceTimeoutMs: boundedInteger(value.sourceTimeoutMs, DEFAULT_PACKAGE_SOURCE_TIMEOUT_MS, 10 * 60_000, "sourceTimeoutMs"),
    maxCommandOutputBytes: boundedInteger(
      value.maxCommandOutputBytes,
      DEFAULT_MAX_PACKAGE_COMMAND_OUTPUT_BYTES,
      16 * 1024 * 1024,
      "maxCommandOutputBytes",
    ),
  };
}

function scope(value: string): asserts value is ExtensionPackageScope {
  if (value !== "user" && value !== "project") throw new TypeError("Package scope must be user or project");
}

function id(value: string): void {
  if (!IDENTIFIER.test(value)) throw new TypeError("Package ID must be a lowercase identifier");
}

function path(value: string, label: string): string {
  if (value.length === 0 || value.includes("\0") || Buffer.byteLength(value) > 4096) {
    throw new TypeError(`${label} must be a non-empty path no larger than 4096 bytes`);
  }
  return resolve(value);
}

function decodeUtf8(data: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

async function readRegularFile(file: string, maximumBytes: number, label: string): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > maximumBytes) {
      throw new Error(`${label} exceeds ${maximumBytes} bytes or is not a regular file`);
    }
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const part = await handle.read(data, offset, data.length - offset, offset);
      if (part.bytesRead === 0) throw new Error(`${label} changed while being read`);
      offset += part.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, data.length)).bytesRead !== 0) throw new Error(`${label} changed while being read`);
    const after = await handle.stat();
    if (
      after.size !== before.size ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`${label} changed while being read`);
    }
    return data;
  } finally {
    await handle.close();
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

async function optionalRegularFile(file: string, maximumBytes: number, label: string): Promise<Buffer | undefined> {
  try {
    return await readRegularFile(file, maximumBytes, label);
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
}

function generatedPackageId(value: string): string {
  const normalized = value.toLowerCase()
    .replace(/^@/u, "")
    .replaceAll("/", ".")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z]+/u, "")
    .replace(/[-._]+$/u, "")
    .slice(0, 63);
  const selected = normalized === "" ? "package" : normalized;
  return /^[a-z]/u.test(selected) ? selected : `package-${selected}`.slice(0, 63);
}

function packagePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || value.includes("\0") || value.includes("\\") || isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path or glob`);
  }
  const selected = value.startsWith("./") ? value.slice(2) : value;
  const bare = selected.startsWith("!") || selected.startsWith("+") || selected.startsWith("-") ? selected.slice(1) : selected;
  if (bare === "" || bare === "." || bare === ".." || bare.startsWith("../") || bare.includes("/../")) {
    throw new Error(`${label} escapes the package root`);
  }
  return `${selected[0] === "!" || selected[0] === "+" || selected[0] === "-" ? selected[0] : ""}${posix.normalize(bare)}`;
}

function packagePaths(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${label} must be an array with at most 256 entries`);
  return value.map((entry, index) => packagePath(entry, `${label}[${index}]`));
}

async function packageFiles(root: string, maximum = DEFAULT_MAX_PACKAGE_ENTRIES): Promise<string[]> {
  const files: string[] = [];
  const visit = async (relativePath: string, depth: number): Promise<void> => {
    if (depth > DEFAULT_MAX_PACKAGE_DEPTH) throw new Error("Package resource discovery exceeds its depth limit");
    const directory = await opendir(relativePath === "" ? root : join(root, relativePath));
    try {
      for await (const entry of directory) {
        if (entry.name === ".git" || entry.name === EXTENSION_PACKAGE_PROVENANCE || entry.name === EXTENSION_PACKAGE_LOCK) continue;
        const child = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
        const information = await lstat(join(root, ...child.split("/")));
        if (information.isSymbolicLink()) throw new Error(`Package resource path is a symbolic link: ${child}`);
        if (information.isDirectory()) await visit(child, depth + 1);
        else if (information.isFile()) files.push(child);
        else throw new Error(`Package resource path is not a regular file or directory: ${child}`);
        if (files.length > maximum) throw new Error(`Package resource discovery exceeds ${maximum} files`);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  };
  await visit("", 0);
  return files.sort((left, right) => left.localeCompare(right));
}

function resourceMatches(path: string, declaration: string, suffixes: readonly string[]): boolean {
  const exact = declaration.replace(/^[!+-]/u, "");
  const suffix = suffixes.some((entry) => path.endsWith(entry));
  if (!suffix) return false;
  if (/[*?\[\]{}]/u.test(exact)) return minimatch(path, exact, { dot: false, nocase: false });
  return path === exact || path.startsWith(`${exact}/`);
}

function selectResourceFiles(files: readonly string[], declarations: readonly string[], suffixes: readonly string[]): string[] {
  const selected = new Set<string>();
  for (const declaration of declarations) {
    const mode = declaration[0] === "!" || declaration[0] === "-" ? "remove" : "add";
    for (const file of files) {
      if (!resourceMatches(file, declaration, suffixes)) continue;
      if (mode === "remove") selected.delete(file);
      else selected.add(file);
    }
  }
  return [...selected].sort((left, right) => left.localeCompare(right));
}

async function conventionalDirectory(root: string, name: string): Promise<boolean> {
  try {
    const information = await lstat(join(root, name));
    return information.isDirectory() && !information.isSymbolicLink();
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
}

async function generateConventionManifest(root: string): Promise<{ bytes: Buffer; manifest: ParsedExtensionManifest }> {
  const packageJsonBytes = await optionalRegularFile(join(root, PACKAGE_JSON_NAME), MANIFEST_MAX_BYTES, "Package package.json");
  const packageJson = packageJsonBytes === undefined ? {} : object(JSON.parse(decodeUtf8(packageJsonBytes, "Package package.json")), "package.json");
  const declared = packageJson.rigyn === undefined ? undefined : object(packageJson.rigyn, "package.json rigyn");
  if (declared !== undefined) {
    const unknown = Object.keys(declared).filter((key) => !["extensions", "skills", "prompts", "themes", "hostVersion"].includes(key));
    if (unknown.length > 0) throw new Error(`package.json rigyn contains unknown keys: ${unknown.join(", ")}`);
  }
  const files = await packageFiles(root);
  const conventions = {
    extensions: await conventionalDirectory(root, "extensions") ? ["extensions"] : [],
    skills: await conventionalDirectory(root, "skills") ? ["skills"] : [],
    prompts: await conventionalDirectory(root, "prompts") ? ["prompts"] : [],
    themes: await conventionalDirectory(root, "themes") ? ["themes"] : [],
  };
  const extensionDeclarations = packagePaths(declared?.extensions, "package.json rigyn.extensions") ?? conventions.extensions;
  const skillDeclarations = packagePaths(declared?.skills, "package.json rigyn.skills") ?? conventions.skills;
  const promptDeclarations = packagePaths(declared?.prompts, "package.json rigyn.prompts") ?? conventions.prompts;
  const themeDeclarations = packagePaths(declared?.themes, "package.json rigyn.themes") ?? conventions.themes;
  const runtime = selectResourceFiles(files, extensionDeclarations, [".ts", ".mts", ".js", ".mjs"])
    .filter((path) => !path.endsWith(".d.ts"))
    .map((path) => ({ path }));
  const skillRoots = skillDeclarations.flatMap((declaration) => {
    const exact = declaration.replace(/^[!+-]/u, "");
    if (declaration[0] === "!" || declaration[0] === "-") return [];
    if (!/[*?\[\]{}]/u.test(exact) && files.some((file) => file.startsWith(`${exact}/`))) return [{ path: exact }];
    return selectResourceFiles(files, [declaration], ["/SKILL.md", ".md"])
      .map((path) => ({ path: path.endsWith("/SKILL.md") ? posix.dirname(path) : path }));
  });
  const prompts = selectResourceFiles(files, promptDeclarations, [".md"]).map((path) => ({
    id: generatedPackageId(posix.basename(path, ".md")),
    path,
  }));
  const themes = [] as Array<{ name: string; path: string }>;
  for (const path of selectResourceFiles(files, themeDeclarations, [".json"])) {
    const definition = parseThemeDefinition(JSON.parse(decodeUtf8(
      await readRegularFile(join(root, ...path.split("/")), MANIFEST_MAX_BYTES, `Package theme ${path}`),
      `Package theme ${path}`,
    )) as unknown);
    themes.push({ name: definition.name, path });
  }
  if (runtime.length + skillRoots.length + prompts.length + themes.length === 0) {
    throw new Error("Package contains no extension, skill, prompt, or theme resources");
  }
  const rawName = typeof packageJson.name === "string" && packageJson.name !== "" ? packageJson.name : posix.basename(root);
  const generated = {
    schemaVersion: 1,
    id: generatedPackageId(rawName),
    name: typeof packageJson.name === "string" && packageJson.name !== "" ? packageJson.name : generatedPackageId(rawName),
    ...(typeof packageJson.version === "string" && packageJson.version !== "" ? { version: packageJson.version } : {}),
    ...(typeof packageJson.description === "string" && packageJson.description !== "" ? { description: packageJson.description } : {}),
    ...(declared?.hostVersion === undefined ? {} : { compatibility: { hostVersion: declared.hostVersion } }),
    contributions: {
      ...(runtime.length === 0 ? {} : { runtime }),
      ...(skillRoots.length === 0 ? {} : { skillRoots }),
      ...(prompts.length === 0 ? {} : { prompts }),
      ...(themes.length === 0 ? {} : { themes }),
    },
  };
  const bytes = Buffer.from(`${JSON.stringify(generated, null, 2)}\n`);
  return { bytes, manifest: parseExtensionManifest(generated) };
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value) > maximum) {
    throw new Error(`${label} must be a non-empty string no larger than ${maximum} bytes`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const selected = requiredString(value, label, 64);
  if (!Number.isFinite(Date.parse(selected)) || new Date(selected).toISOString() !== selected) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return selected;
}

function gitRef(value: string): string {
  const components = value.split("/");
  if (
    !GIT_REF.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    components.some((component) => component.startsWith(".") || component.endsWith(".lock"))
  ) {
    throw new Error("Git source ref is invalid");
  }
  return value;
}

function npmPackageName(value: string, label: string): string {
  if (value.length === 0 || Buffer.byteLength(value) > 214 || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  if (value.startsWith("@")) {
    const parts = value.slice(1).split("/");
    if (parts.length !== 2 || parts.some((part) => !NPM_PART.test(part))) throw new Error(`${label} is invalid`);
  } else if (!NPM_PART.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function npmDependencySpec(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || Buffer.byteLength(value) > 512) {
    throw new Error(`${label} must be a registry version, tag, or range`);
  }
  if (
    /^(?:file|git(?:\+[^:]*)?|https?|workspace|link|portal|patch|npm):/iu.test(value) ||
    /[/\\@#?:,\0]/u.test(value)
  ) {
    throw new Error(`${label} must be a registry version, tag, or range`);
  }
  if (/^[A-Za-z][A-Za-z0-9._-]*$/u.test(value)) return value;
  const atom = String.raw`(?:v?(?:0|[1-9][0-9]*|[xX*])(?:\.(?:0|[1-9][0-9]*|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|[xX*])`;
  const comparator = new RegExp(`^(?:<=|>=|<|>|=|~|\\^)?${atom}$`, "u");
  for (const set of value.split("||")) {
    const selected = set.trim();
    if (selected === "") throw new Error(`${label} must be a registry version, tag, or range`);
    const hyphen = selected.match(/^(\S+)\s+-\s+(\S+)$/u);
    if (hyphen !== null) {
      if (!new RegExp(`^${atom}$`, "u").test(hyphen[1]!) || !new RegExp(`^${atom}$`, "u").test(hyphen[2]!)) {
        throw new Error(`${label} must be a registry version, tag, or range`);
      }
      continue;
    }
    if (!selected.split(/\s+/u).every((part) => comparator.test(part))) {
      throw new Error(`${label} must be a registry version, tag, or range`);
    }
  }
  return value;
}

function npmRegistrySpecifier(value: string): string {
  if (value.length === 0 || Buffer.byteLength(value) > 512 || /[\s\0\\]/u.test(value) || value.startsWith("-")) {
    throw new Error("npm package specifier is invalid");
  }
  let name: string;
  let selector = "";
  let selectorSpecified = false;
  if (value.startsWith("@")) {
    const slash = value.indexOf("/");
    const at = slash < 0 ? -1 : value.indexOf("@", slash);
    name = at < 0 ? value : value.slice(0, at);
    selector = at < 0 ? "" : value.slice(at + 1);
    selectorSpecified = at >= 0;
    npmPackageName(name, "npm package name");
  } else {
    const at = value.indexOf("@");
    name = at < 0 ? value : value.slice(0, at);
    selector = at < 0 ? "" : value.slice(at + 1);
    selectorSpecified = at >= 0;
    npmPackageName(name, "npm package name");
  }
  if (
    selector.includes("/") ||
    selector.includes("#") ||
    selector.includes("?") ||
    selector.includes(":") ||
    (selectorSpecified && (selector === "" || !/^[A-Za-z0-9*+._~^<>=|,-]+$/u.test(selector)))
  ) {
    throw new Error("npm package selector is invalid");
  }
  return value;
}

function npmRegistrySelector(value: string): string | undefined {
  const slash = value.startsWith("@") ? value.indexOf("/") : -1;
  const at = value.indexOf("@", slash < 0 ? 0 : slash);
  return at < 0 ? undefined : value.slice(at + 1);
}

export function extensionPackageUpdatePolicy(provenance: ExtensionPackageProvenance): ExtensionPackageUpdatePolicy {
  if (provenance.kind === "npm") {
    const parsed = parseExtensionPackageSource(provenance.source);
    if (parsed.kind === "npm" && parsed.specifier !== undefined) {
      const selector = npmRegistrySelector(parsed.specifier);
      if (selector !== undefined && validSemver(selector) !== null) {
        return { pinned: true, reason: `npm version ${selector}` };
      }
    }
  }
  if (provenance.kind === "git") {
    const parsed = parseExtensionPackageSource(provenance.source);
    if (parsed.kind === "git" && parsed.ref !== undefined && GIT_REVISION.test(parsed.ref)) {
      return { pinned: true, reason: `Git revision ${parsed.ref}` };
    }
  }
  return { pinned: false };
}

function localNpmArchive(value: string): string | undefined {
  if (value.startsWith("file:")) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("npm file source URL is invalid");
    }
    if (url.protocol !== "file:" || url.search !== "" || url.hash !== "") throw new Error("npm file source must be a plain file URL");
    return resolve(fileURLToPath(url));
  }
  if (isAbsolute(value) || value.startsWith("./") || value.startsWith("../")) return resolve(value);
  return undefined;
}

function gitUrl(value: string): { repository: string; protocol: "https" | "ssh" } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Git source URL is invalid");
  }
  if ((url.protocol !== "https:" && url.protocol !== "ssh:") || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("Git URL sources must use credential-free HTTPS or SSH without query parameters");
  }
  if (url.protocol === "https:" && url.username !== "") throw new Error("HTTPS Git URL sources must be credential-free");
  if (url.protocol === "ssh:" && url.username !== "" && !/^[A-Za-z0-9._-]{1,64}$/u.test(url.username)) {
    throw new Error("SSH Git URL username is invalid");
  }
  if (url.hostname === "" || url.pathname === "" || url.pathname === "/") throw new Error("Git URL repository path is missing");
  return { repository: url.toString(), protocol: url.protocol === "ssh:" ? "ssh" : "https" };
}

function splitGitRef(value: string): { repository: string; ref?: string } {
  const hash = value.lastIndexOf("#");
  if (hash >= 0) return { repository: value.slice(0, hash), ref: gitRef(value.slice(hash + 1)) };
  const separator = value.includes("://")
    ? value.indexOf("/", value.indexOf("://") + 3)
    : Math.max(value.indexOf(":"), value.indexOf("/"));
  const at = value.lastIndexOf("@");
  if (at > separator) return { repository: value.slice(0, at), ref: gitRef(value.slice(at + 1)) };
  return { repository: value };
}

function scpGitRemote(value: string): string | undefined {
  const match = value.match(/^(?:([A-Za-z0-9._-]{1,64})@)?([A-Za-z0-9.-]{1,253}):([A-Za-z0-9._~/-]{1,2048})$/u);
  if (match === null || match[2]!.startsWith(".") || match[2]!.endsWith(".") || match[3]!.startsWith("/")
    || match[3]!.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
  return value;
}

function shorthandGitRemote(value: string): string | undefined {
  if (!/^[A-Za-z0-9.-]{1,253}\/[A-Za-z0-9._~/-]{1,2048}$/u.test(value)) return undefined;
  const slash = value.indexOf("/");
  const host = value.slice(0, slash);
  const repositoryPath = value.slice(slash + 1);
  if (!host.includes(".") || host.startsWith(".") || host.endsWith(".")
    || repositoryPath.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
  return `https://${value}`;
}

export function parseExtensionPackageSource(value: string): ParsedExtensionPackageSource {
  const selected = requiredString(value, "Package source", 4096);
  if (selected.startsWith("npm:")) {
    const raw = selected.slice(4);
    const archivePath = localNpmArchive(raw);
    if (archivePath !== undefined) {
      if (!archivePath.toLowerCase().endsWith(".tgz")) throw new Error("npm file sources must end in .tgz");
      return { kind: "npm", source: `npm:${pathToFileURL(archivePath).href}`, archivePath };
    }
    const specifier = npmRegistrySpecifier(raw);
    return { kind: "npm", source: `npm:${specifier}`, specifier };
  }
  const explicitGit = selected.startsWith("git:");
  if (explicitGit || selected.startsWith("https://") || selected.startsWith("ssh://")) {
    const raw = explicitGit ? selected.slice(4) : selected;
    const split = splitGitRef(raw);
    const repository = split.repository;
    const ref = split.ref;
    if (repository.startsWith("https://") || repository.startsWith("ssh://")) {
      const normalized = gitUrl(repository).repository;
      return {
        kind: "git",
        source: `git:${normalized}${ref === undefined ? "" : `#${ref}`}`,
        repository: normalized,
        ...(ref === undefined ? {} : { ref }),
      };
    }
    if (!explicitGit) throw new Error("Git URL sources must use HTTPS or SSH");
    const scp = scpGitRemote(repository);
    if (scp !== undefined) {
      return {
        kind: "git",
        source: `git:${scp}${ref === undefined ? "" : `#${ref}`}`,
        repository: scp,
        ...(ref === undefined ? {} : { ref }),
      };
    }
    const shorthand = shorthandGitRemote(repository);
    if (shorthand !== undefined) {
      return {
        kind: "git",
        source: `git:${shorthand}${ref === undefined ? "" : `#${ref}`}`,
        repository: shorthand,
        ...(ref === undefined ? {} : { ref }),
      };
    }
    let repositoryPath: string;
    if (repository.startsWith("file:")) {
      let url: URL;
      try {
        url = new URL(repository);
      } catch {
        throw new Error("Git file source URL is invalid");
      }
      if (url.protocol !== "file:" || url.search !== "" || url.hash !== "") throw new Error("Git file source must be a plain file URL");
      repositoryPath = resolve(fileURLToPath(url));
    } else {
      if (!isAbsolute(repository) && /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(repository)) {
        throw new Error("Git package source protocol is unsupported; use HTTPS or an explicit local path");
      }
      repositoryPath = resolve(repository);
    }
    return {
      kind: "git",
      source: `git:${pathToFileURL(repositoryPath).href}${ref === undefined ? "" : `#${ref}`}`,
      repositoryPath,
      ...(ref === undefined ? {} : { ref }),
    };
  }
  if (!isAbsolute(selected) && /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(selected)) throw new Error("Unsupported package source protocol");
  return { kind: "local", sourcePath: path(selected, "Package source") };
}

export function parseExtensionPackageProvenance(value: unknown): ExtensionPackageProvenance {
  const input = object(value, "Package provenance");
  const allowed = [
    "schemaVersion", "kind", "id", "scope", "sourcePath", "source", "packageName", "resolvedVersion", "archiveSha256", "revision",
    "installedAt", "updatedAt", "manifestSha256",
  ];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Package provenance contains unknown keys: ${unknown.join(", ")}`);
  if (input.schemaVersion !== 1) throw new Error("Package provenance schemaVersion must be 1");
  if (input.kind !== "local" && input.kind !== "npm" && input.kind !== "git") throw new Error("Package provenance kind is invalid");
  const packageId = requiredString(input.id, "Package provenance id", 63);
  id(packageId);
  const packageScope = requiredString(input.scope, "Package provenance scope", 16);
  scope(packageScope);
  const installedAt = timestamp(input.installedAt, "Package provenance installedAt");
  const updatedAt = input.updatedAt === undefined ? undefined : timestamp(input.updatedAt, "Package provenance updatedAt");
  const manifestSha256 = requiredString(input.manifestSha256, "Package provenance manifestSha256", 64);
  if (!/^[a-f0-9]{64}$/u.test(manifestSha256)) throw new Error("Package provenance manifestSha256 must be a SHA-256 digest");
  const common: ExtensionPackageProvenanceBase = {
    schemaVersion: 1,
    id: packageId,
    scope: packageScope,
    installedAt,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    manifestSha256,
  };
  if (input.kind === "local") {
    const sourcePath = requiredString(input.sourcePath, "Package provenance sourcePath", 4096);
    if (!isAbsolute(sourcePath)) throw new Error("Package provenance sourcePath must be absolute");
    if (input.source !== undefined || input.packageName !== undefined || input.resolvedVersion !== undefined || input.archiveSha256 !== undefined || input.revision !== undefined) {
      throw new Error("Local package provenance contains remote-source fields");
    }
    return { ...common, kind: "local", sourcePath };
  }
  const source = requiredString(input.source, "Package provenance source", 4096);
  if (input.sourcePath !== undefined) throw new Error("Remote package provenance contains sourcePath");
  if (input.kind === "npm") {
    const parsed = parseExtensionPackageSource(source);
    if (parsed.kind !== "npm" || parsed.source !== source || input.revision !== undefined) throw new Error("npm package provenance is invalid");
    const packageName = requiredString(input.packageName, "Package provenance packageName", 214);
    const resolvedVersion = requiredString(input.resolvedVersion, "Package provenance resolvedVersion", 128);
    const archiveSha256 = requiredString(input.archiveSha256, "Package provenance archiveSha256", 64);
    if (!/^[a-f0-9]{64}$/u.test(archiveSha256)) throw new Error("Package provenance archiveSha256 must be a SHA-256 digest");
    return { ...common, kind: "npm", source, packageName, resolvedVersion, archiveSha256 };
  }
  const parsed = parseExtensionPackageSource(source);
  if (parsed.kind !== "git" || parsed.source !== source || input.packageName !== undefined || input.resolvedVersion !== undefined || input.archiveSha256 !== undefined) {
    throw new Error("Git package provenance is invalid");
  }
  const revision = requiredString(input.revision, "Package provenance revision", 64);
  if (!GIT_REVISION.test(revision)) throw new Error("Package provenance revision is invalid");
  return { ...common, kind: "git", source, revision };
}

async function canonicalDirectory(value: string, label: string): Promise<string> {
  const selected = path(value, label);
  const information = await lstat(selected);
  if (!information.isDirectory() || information.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return await realpath(selected);
}

function commandEnvironment(
  home: string,
  kind: "npm" | "git",
  options: { ssh?: boolean; allowScripts?: boolean } = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "TMPDIR", "TMP", "TEMP"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const commandHome = kind === "git" && options.ssh === true ? homedir() : home;
  environment.HOME = commandHome;
  environment.USERPROFILE = commandHome;
  environment.LANG = "C";
  environment.LC_ALL = "C";
  if (kind === "npm") {
    environment.npm_config_ignore_scripts = options.allowScripts === true ? "false" : "true";
    environment.npm_config_omit = "dev";
    environment.npm_config_audit = "false";
    environment.npm_config_fund = "false";
    environment.npm_config_package_lock = "false";
    environment.npm_config_bin_links = options.allowScripts === true ? "true" : "false";
    environment.npm_config_update_notifier = "false";
    environment.npm_config_progress = "false";
    environment.npm_config_loglevel = "warn";
    environment.npm_config_userconfig = join(home, "npmrc");
    environment.npm_config_globalconfig = join(home, "npmrc-global");
    environment.npm_config_cache = join(home, "npm-cache");
  } else {
    environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
    environment.GIT_CONFIG_NOSYSTEM = "1";
    environment.GIT_TERMINAL_PROMPT = "0";
    environment.GCM_INTERACTIVE = "Never";
    environment.GIT_OPTIONAL_LOCKS = "0";
    if (options.ssh === true) {
      environment.GIT_SSH_COMMAND = "ssh -oBatchMode=yes";
      for (const name of ["SSH_AUTH_SOCK", "SSH_AGENT_PID"]) {
        const value = process.env[name];
        if (value !== undefined) environment[name] = value;
      }
    }
  }
  return environment;
}

export type PackageProcessTerminationPlan =
  | { kind: "signal"; pid: number; signal: NodeJS.Signals }
  | {
    kind: "taskkill";
    command: string;
    args: string[];
    fallback: { kind: "signal"; pid: number; signal: NodeJS.Signals };
  };

export function packageProcessTerminationPlan(
  pid: number,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PackageProcessTerminationPlan {
  if (platform !== "win32") return { kind: "signal", pid: -pid, signal };
  const fallback = { kind: "signal" as const, pid, signal };
  const root = environment.SystemRoot ?? environment.WINDIR;
  if (root === undefined || root.includes("\0") || !/^[A-Za-z]:[\\/]/u.test(root)) return fallback;
  return {
    kind: "taskkill",
    command: win32.join(win32.resolve(root), "System32", "taskkill.exe"),
    args: ["/PID", String(pid), "/T", "/F"],
    fallback,
  };
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (errno(error) !== "ESRCH") throw error;
  }
}

function stopProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  const plan = packageProcessTerminationPlan(child.pid, signal);
  if (plan.kind === "signal") {
    signalProcess(plan.pid, plan.signal);
    return;
  }
  const result = spawnSync(plan.command, plan.args, {
    shell: false,
    stdio: "ignore",
    timeout: PACKAGE_TASKKILL_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error === undefined && result.status === 0) return;
  signalProcess(plan.fallback.pid, plan.fallback.signal);
}

async function runBoundedCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    environment: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
    label: string;
    signal?: AbortSignal;
  },
): Promise<string> {
  options.signal?.throwIfAborted();
  const [executable, ...normalizedArgs] = packageCommandArgv(command, args, process.platform, options.environment);
  const child = spawn(executable, normalizedArgs, {
    cwd: options.cwd,
    env: options.environment,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const releaseProcessGroup = trackActiveProcessGroup(child.pid);
  return await new Promise<string>((resolveResult, reject) => {
    const output: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let failure: Error | undefined;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      releaseProcessGroup();
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      operation();
    };
    const stop = (error: Error): void => {
      if (failure !== undefined || settled) return;
      failure = error;
      try {
        stopProcess(child, "SIGKILL");
      } catch (cause) {
        finish(() => reject(new Error(error.message, { cause })));
      }
    };
    const capture = (chunk: Buffer): void => {
      if (failure !== undefined || settled) return;
      bytes += chunk.byteLength;
      if (bytes > options.maxOutputBytes) {
        stop(new Error(`${options.label} output exceeded ${options.maxOutputBytes} bytes`));
        return;
      }
      output.push(chunk);
    };
    const abort = (): void => {
      stop(options.signal?.reason instanceof Error ? options.signal.reason : new Error(`${options.label} cancelled`));
    };
    const timeout = setTimeout(() => stop(new Error(`${options.label} timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
    timeout.unref();
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("error", (error) => finish(() => reject(new Error(`Unable to start ${options.label}: ${error.message}`, { cause: error }))));
    child.once("close", (code, signal) => finish(() => {
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      const detail = Buffer.concat(output).toString("utf8").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "?").trim().slice(-4096);
      if (code !== 0) {
        reject(new Error(`${options.label} failed${code === null ? ` with signal ${signal ?? "unknown"}` : ` with exit ${code}`}${detail === "" ? "" : `: ${detail}`}`));
        return;
      }
      resolveResult(detail);
    }));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted === true) abort();
  });
}

export function packageCommandArgv(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): [string, ...string[]] {
  return normalizeCommandArgv([command, ...args], { platform, environment });
}

async function npmCommand(): Promise<{ command: string; prefix: string[] }> {
  if (process.platform !== "win32") return { command: "npm", prefix: [] };
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((value): value is string => value !== undefined && value !== "");
  for (const candidate of candidates) {
    try {
      if ((await lstat(candidate)).isFile()) return { command: process.execPath, prefix: [candidate] };
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
  }
  throw new Error("npm sources require npm-cli.js to be installed beside Node.js on Windows");
}

function tarString(field: Buffer, label: string): string {
  const end = field.indexOf(0);
  const selected = field.subarray(0, end < 0 ? field.length : end);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(selected);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function tarNumber(field: Buffer, label: string): number {
  if ((field[0] ?? 0) >= 0x80) throw new Error(`${label} uses unsupported base-256 encoding`);
  const value = tarString(field, label).trim();
  if (value === "") return 0;
  if (!/^[0-7]+$/u.test(value)) throw new Error(`${label} is not octal`);
  const selected = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(selected) || selected < 0) throw new Error(`${label} is out of range`);
  return selected;
}

function verifyTarChecksum(header: Buffer): void {
  const expected = tarNumber(header.subarray(148, 156), "Tar checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) actual += index >= 148 && index < 156 ? 0x20 : header[index] ?? 0;
  if (actual !== expected) throw new Error("npm archive contains an invalid tar checksum");
}

function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error("npm archive contains an invalid PAX record");
    const lengthText = data.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/u.test(lengthText)) throw new Error("npm archive contains an invalid PAX record length");
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isSafeInteger(length) || length < 5 || offset + length > data.length || data[offset + length - 1] !== 0x0a) {
      throw new Error("npm archive contains an out-of-range PAX record");
    }
    const record = data.subarray(space + 1, offset + length - 1);
    const equals = record.indexOf(0x3d);
    if (equals < 1) throw new Error("npm archive contains an invalid PAX key/value");
    const key = tarString(record.subarray(0, equals), "PAX key");
    const value = tarString(record.subarray(equals + 1), "PAX value");
    if (records.has(key)) throw new Error(`npm archive contains duplicate PAX key ${key}`);
    records.set(key, value);
    offset += length;
  }
  return records;
}

function archivePath(value: string, limits: PackageLimits): { relativePath: string; depth: number } {
  if (/[/\\]$/u.test(value)) value = value.slice(0, -1);
  if (value === "package") return { relativePath: "", depth: 0 };
  if (!value.startsWith("package/")) throw new Error("npm archive entries must be rooted under package/");
  const selected = value.slice(8);
  if (
    selected === "" ||
    selected.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(selected) ||
    posix.isAbsolute(selected) ||
    posix.normalize(selected) !== selected ||
    selected.split("/").some((part) => {
      const stem = part.split(".", 1)[0]?.toUpperCase() ?? "";
      return part === "" || part === "." || part === ".." || part.includes(":") || /[ .]$/u.test(part) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem);
    }) ||
    Buffer.byteLength(selected) > 4096
  ) {
    throw new Error(`npm archive contains an unsafe path: ${JSON.stringify(selected)}`);
  }
  const parts = selected.split("/");
  if (parts.length - 1 > limits.maxDepth) throw new Error(`Package exceeds maximum directory depth ${limits.maxDepth}`);
  if (parts[0] === EXTENSION_PACKAGE_PROVENANCE) throw new Error(`Package source contains reserved file ${EXTENSION_PACKAGE_PROVENANCE}`);
  return { relativePath: selected, depth: parts.length - 1 };
}

async function writeArchiveFile(destination: string, data: Buffer, executable: boolean): Promise<void> {
  const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), executable ? 0o700 : 0o600);
  try {
    let offset = 0;
    while (offset < data.length) {
      const result = await handle.write(data, offset, data.length - offset, offset);
      if (result.bytesWritten === 0) throw new Error("npm archive file could not be written");
      offset += result.bytesWritten;
    }
  } finally {
    await handle.close();
  }
}

async function extractNpmArchive(archive: Buffer, destination: string, limits: PackageLimits): Promise<void> {
  const maximumTarBytes = limits.maxBytes + limits.maxEntries * 2048 + 1024 * 1024;
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: maximumTarBytes });
  } catch (error) {
    throw new Error(`Unable to decompress npm archive within ${maximumTarBytes} bytes`, { cause: error });
  }
  let offset = 0;
  let entries = 0;
  let bytes = 0;
  let pax: Map<string, string> | undefined;
  let longName: string | undefined;
  const seen = new Set<string>();
  const seenFolded = new Set<string>();
  const nodes = new Set<string>();
  const foldedNodes = new Map<string, string>();
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      if (pax !== undefined || longName !== undefined) throw new Error("npm archive ended with unused path metadata");
      if (tar.subarray(offset).some((value) => value !== 0)) throw new Error("npm archive contains non-zero data after its terminator");
      return;
    }
    verifyTarChecksum(header);
    const headerSize = tarNumber(header.subarray(124, 136), "Tar entry size");
    const dataStart = offset + 512;
    const dataEnd = dataStart + headerSize;
    const paddedEnd = dataStart + Math.ceil(headerSize / 512) * 512;
    if (!Number.isSafeInteger(dataEnd) || paddedEnd > tar.length) throw new Error("npm archive contains a truncated tar entry");
    if (tar.subarray(dataEnd, paddedEnd).some((value) => value !== 0)) throw new Error("npm archive contains non-zero tar padding");
    const type = String.fromCharCode(header[156] ?? 0).replace("\0", "");
    const data = tar.subarray(dataStart, dataEnd);
    offset = paddedEnd;
    if (type === "x") {
      if (pax !== undefined || longName !== undefined || headerSize > 64 * 1024) throw new Error("npm archive contains invalid PAX metadata chaining");
      pax = paxRecords(data);
      if ([...pax.keys()].some((key) => key === "linkpath" || key.startsWith("GNU.sparse"))) {
        throw new Error("npm archive contains unsafe PAX metadata");
      }
      continue;
    }
    if (type === "L") {
      if (pax !== undefined || longName !== undefined || headerSize > 64 * 1024) throw new Error("npm archive contains invalid GNU long-name metadata");
      longName = tarString(data, "GNU long name").replace(/\0+$/u, "");
      continue;
    }
    if (type === "g" || type === "K") throw new Error("npm archive contains unsupported global or long-link metadata");
    const prefix = tarString(header.subarray(345, 500), "Tar path prefix");
    const name = longName ?? pax?.get("path") ?? [prefix, tarString(header.subarray(0, 100), "Tar path")].filter(Boolean).join("/");
    const paxSize = pax?.get("size");
    if (paxSize !== undefined && (!/^[0-9]+$/u.test(paxSize) || Number.parseInt(paxSize, 10) !== headerSize)) {
      throw new Error("npm archive PAX size does not match its tar header");
    }
    pax = undefined;
    longName = undefined;
    if (type !== "" && type !== "0" && type !== "5") throw new Error(`npm archive contains unsupported tar entry type ${JSON.stringify(type)}`);
    if (type === "5" && headerSize !== 0) throw new Error("npm archive directory entries must have zero size");
    const selected = archivePath(name, limits);
    if (selected.relativePath === "") {
      if (type !== "5") throw new Error("npm archive package root must be a directory");
      continue;
    }
    const parts = selected.relativePath.split("/");
    for (let index = 1; index <= parts.length; index += 1) {
      const node = parts.slice(0, index).join("/");
      const folded = node.normalize("NFC").toLowerCase();
      const existing = foldedNodes.get(folded);
      if (existing !== undefined && existing !== node) throw new Error(`npm archive contains a portable path collision: ${existing} and ${node}`);
      foldedNodes.set(folded, node);
      if (nodes.has(node)) continue;
      nodes.add(node);
      entries += 1;
      if (entries > limits.maxEntries) throw new Error(`Package exceeds ${limits.maxEntries} entries`);
    }
    const collisionKey = selected.relativePath.normalize("NFC").toLowerCase();
    if (seen.has(selected.relativePath) || seenFolded.has(collisionKey)) throw new Error(`npm archive contains a duplicate path: ${selected.relativePath}`);
    seen.add(selected.relativePath);
    seenFolded.add(collisionKey);
    const target = join(destination, ...selected.relativePath.split("/"));
    if (type === "5") {
      await mkdir(target, { recursive: true, mode: 0o700 });
      await chmod(target, 0o700);
      continue;
    }
    if (headerSize > limits.maxFileBytes) throw new Error(`Package file exceeds ${limits.maxFileBytes} bytes: ${selected.relativePath}`);
    bytes += headerSize;
    if (bytes > limits.maxBytes) throw new Error(`Package exceeds ${limits.maxBytes} total bytes`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const mode = tarNumber(header.subarray(100, 108), "Tar entry mode");
    await writeArchiveFile(target, data, (mode & 0o111) !== 0);
  }
  throw new Error("npm archive ended without a tar terminator");
}

async function canonicalFile(value: string, label: string): Promise<string> {
  const selected = path(value, label);
  const information = await lstat(selected);
  if (!information.isFile() || information.isSymbolicLink()) throw new Error(`${label} must be a real regular file`);
  return await realpath(selected);
}

function sourceFromProvenance(provenance: ExtensionPackageProvenance): string {
  return provenance.kind === "local" ? provenance.sourcePath : provenance.source;
}

function gitArguments(protocol: "file" | "https" | "ssh"): string[] {
  return [
    "-c", "advice.detachedHead=false",
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=",
    "-c", "core.pager=cat",
    "-c", "credential.helper=",
    "-c", "credential.interactive=never",
    "-c", "diff.external=",
    "-c", "http.followRedirects=false",
    "-c", "http.sslVerify=true",
    "-c", "protocol.allow=never",
    "-c", `protocol.${protocol}.allow=always`,
  ];
}

async function materializePackageSource(
  parsed: ParsedExtensionPackageSource,
  container: string,
  limits: PackageLimits,
  commands: ExtensionPackageCommands,
  signal?: AbortSignal,
): Promise<SourceMaterial> {
  signal?.throwIfAborted();
  if (parsed.kind === "local") {
    const sourcePath = await canonicalDirectory(parsed.sourcePath, "Package source");
    return { root: sourcePath, identity: { kind: "local", sourcePath } };
  }
  const sourceContainer = join(container, ".source");
  const home = join(sourceContainer, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (parsed.kind === "npm") {
    const extracted = join(sourceContainer, "package");
    await mkdir(extracted, { mode: 0o700 });
    let archivePathValue: string;
    let source: string;
    if (parsed.archivePath !== undefined) {
      archivePathValue = await canonicalFile(parsed.archivePath, "npm package archive");
      source = `npm:${pathToFileURL(archivePathValue).href}`;
    } else {
      const tarballs = join(sourceContainer, "tarballs");
      await mkdir(tarballs, { mode: 0o700 });
      await writeFile(join(home, "npmrc"), "", { flag: "wx", mode: 0o600 });
      await writeFile(join(home, "npmrc-global"), "", { flag: "wx", mode: 0o600 });
      const npm = commands.npm ?? await npmCommand();
      await runBoundedCommand(npm.command, [
        ...(npm.prefix ?? []),
        "pack",
        "--ignore-scripts=true",
        "--json=false",
        "--silent",
        "--pack-destination",
        tarballs,
        "--",
        parsed.specifier!,
      ], {
        cwd: sourceContainer,
        environment: commandEnvironment(home, "npm"),
        timeoutMs: limits.sourceTimeoutMs,
        maxOutputBytes: limits.maxCommandOutputBytes,
        label: "npm package fetch",
        ...(signal === undefined ? {} : { signal }),
      });
      const candidates = (await readdir(tarballs)).filter((name) => name.toLowerCase().endsWith(".tgz"));
      if (candidates.length !== 1) throw new Error(`npm package fetch produced ${candidates.length} tarballs; expected exactly one`);
      archivePathValue = await canonicalFile(join(tarballs, candidates[0]!), "Fetched npm package archive");
      source = parsed.source;
    }
    const archive = await readRegularFile(archivePathValue, limits.maxBytes, "npm package archive");
    await extractNpmArchive(archive, extracted, limits);
    const packageBytes = await readRegularFile(join(extracted, "package.json"), MANIFEST_MAX_BYTES, "npm package.json");
    const packageJson = object(JSON.parse(decodeUtf8(packageBytes, "npm package.json")) as unknown, "npm package.json");
    const packageName = requiredString(packageJson.name, "npm package name", 214);
    const resolvedVersion = requiredString(packageJson.version, "npm package version", 128);
    return {
      root: extracted,
      identity: { kind: "npm", source, packageName, resolvedVersion, archiveSha256: sha256(archive) },
      cleanup: sourceContainer,
    };
  }

  const repository = join(sourceContainer, "repository");
  const template = join(sourceContainer, "git-template");
  await mkdir(template, { mode: 0o700 });
  const local = parsed.repositoryPath !== undefined;
  const protocol = local
    ? "file" as const
    : parsed.repository!.startsWith("ssh://") || scpGitRemote(parsed.repository!) !== undefined
      ? "ssh" as const
      : "https" as const;
  const repositoryValue = local
    ? pathToFileURL(await canonicalDirectory(parsed.repositoryPath!, "Git package repository")).href
    : parsed.repository!;
  const source = `git:${repositoryValue}${parsed.ref === undefined ? "" : `#${parsed.ref}`}`;
  const environment = commandEnvironment(home, "git", { ssh: protocol === "ssh" });
  environment.GIT_TEMPLATE_DIR = template;
  const common = gitArguments(protocol);
  const git = commands.git ?? { command: "git", prefix: [] };
  const exactRevision = parsed.ref !== undefined && GIT_REVISION.test(parsed.ref);
  await runBoundedCommand(git.command, [
    ...(git.prefix ?? []),
    ...common,
    "clone",
    "--quiet",
    "--depth=1",
    "--single-branch",
    "--no-tags",
    "--no-recurse-submodules",
    "--template",
    template,
    "--config", "core.hooksPath=",
    "--config", "core.fsmonitor=false",
    "--config", "submodule.recurse=false",
    ...(local ? ["--no-hardlinks"] : []),
    ...(parsed.ref === undefined || exactRevision ? [] : ["--branch", parsed.ref]),
    "--",
    repositoryValue,
    repository,
  ], {
    cwd: sourceContainer,
    environment,
    timeoutMs: limits.sourceTimeoutMs,
    maxOutputBytes: limits.maxCommandOutputBytes,
    label: "Git package clone",
    ...(signal === undefined ? {} : { signal }),
  });
  if (exactRevision) {
    await runBoundedCommand(git.command, [
      ...(git.prefix ?? []),
      ...common,
      "-C",
      repository,
      "fetch",
      "--quiet",
      "--depth=1",
      "--no-tags",
      "origin",
      parsed.ref!,
    ], {
      cwd: sourceContainer,
      environment,
      timeoutMs: limits.sourceTimeoutMs,
      maxOutputBytes: limits.maxCommandOutputBytes,
      label: "Git package pinned revision fetch",
      ...(signal === undefined ? {} : { signal }),
    });
    await runBoundedCommand(git.command, [
      ...(git.prefix ?? []),
      ...common,
      "-C",
      repository,
      "checkout",
      "--quiet",
      "--detach",
      parsed.ref!,
    ], {
      cwd: sourceContainer,
      environment,
      timeoutMs: limits.sourceTimeoutMs,
      maxOutputBytes: limits.maxCommandOutputBytes,
      label: "Git package pinned revision checkout",
      ...(signal === undefined ? {} : { signal }),
    });
  }
  const revision = (await runBoundedCommand(git.command, [
    ...(git.prefix ?? []),
    ...common,
    "-C",
    repository,
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ], {
    cwd: sourceContainer,
    environment,
    timeoutMs: limits.sourceTimeoutMs,
    maxOutputBytes: limits.maxCommandOutputBytes,
    label: "Git package revision",
    ...(signal === undefined ? {} : { signal }),
  })).trim();
  if (!GIT_REVISION.test(revision)) throw new Error("Git package revision was not a full commit ID");
  await rm(join(repository, ".git"), { recursive: true, force: true });
  return { root: repository, identity: { kind: "git", source, revision }, cleanup: sourceContainer };
}

function contained(root: string, candidate: string): boolean {
  const selected = relative(root, candidate);
  return selected === "" || (!selected.startsWith("..") && !isAbsolute(selected));
}

async function copyFileSafely(source: string, destination: string, limits: PackageLimits, budget: CopyBudget): Promise<void> {
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output;
  try {
    const before = await input.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > limits.maxFileBytes) {
      throw new Error(`Package file exceeds ${limits.maxFileBytes} bytes or is not regular: ${source}`);
    }
    budget.bytes += before.size;
    if (budget.bytes > limits.maxBytes) throw new Error(`Package exceeds ${limits.maxBytes} total bytes`);
    const mode = before.mode & 0o111 ? 0o700 : 0o600;
    output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const part = await input.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (part.bytesRead === 0) throw new Error(`Package file changed while being copied: ${source}`);
      let written = 0;
      while (written < part.bytesRead) {
        const result = await output.write(buffer, written, part.bytesRead - written);
        if (result.bytesWritten === 0) throw new Error(`Package file could not be copied: ${source}`);
        written += result.bytesWritten;
      }
      offset += part.bytesRead;
    }
    if ((await input.read(buffer, 0, 1, before.size)).bytesRead !== 0) throw new Error(`Package file changed while being copied: ${source}`);
    const after = await input.stat();
    if (
      after.size !== before.size ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`Package file changed while being copied: ${source}`);
    }
  } finally {
    await output?.close();
    await input.close();
  }
}

async function copyDirectorySafely(
  sourceRoot: string,
  source: string,
  destination: string,
  limits: PackageLimits,
  budget: CopyBudget,
  depth: number,
): Promise<void> {
  if (depth > limits.maxDepth) throw new Error(`Package exceeds maximum directory depth ${limits.maxDepth}`);
  const canonical = await realpath(source);
  if (!contained(sourceRoot, canonical)) throw new Error(`Package path escapes its source root: ${source}`);
  const information = await lstat(source);
  if (!information.isDirectory() || information.isSymbolicLink()) throw new Error(`Package path is not a real directory: ${source}`);

  const entries = [];
  const directory = await opendir(source);
  try {
    for await (const entry of directory) {
      budget.entries += 1;
      if (budget.entries > limits.maxEntries) throw new Error(`Package exceeds ${limits.maxEntries} entries`);
      entries.push(entry.name);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  entries.sort((left, right) => left.localeCompare(right));

  for (const name of entries) {
    if (depth === 0 && name === EXTENSION_PACKAGE_PROVENANCE) throw new Error(`Package source contains reserved file ${EXTENSION_PACKAGE_PROVENANCE}`);
    const sourceEntry = join(source, name);
    const destinationEntry = join(destination, name);
    if (Buffer.byteLength(relative(sourceRoot, sourceEntry)) > 4096) throw new Error("Package relative path exceeds 4096 bytes");
    const entryInformation = await lstat(sourceEntry);
    if (entryInformation.isSymbolicLink()) throw new Error(`Package contains a symbolic link: ${relative(sourceRoot, sourceEntry)}`);
    if (entryInformation.isDirectory()) {
      await mkdir(destinationEntry, { mode: 0o700 });
      await copyDirectorySafely(sourceRoot, sourceEntry, destinationEntry, limits, budget, depth + 1);
      await chmod(destinationEntry, 0o700);
    } else if (entryInformation.isFile()) {
      const canonicalEntry = await realpath(sourceEntry);
      if (!contained(sourceRoot, canonicalEntry)) throw new Error(`Package file escapes its source root: ${relative(sourceRoot, sourceEntry)}`);
      await copyFileSafely(sourceEntry, destinationEntry, limits, budget);
    } else {
      throw new Error(`Package contains a non-file entry: ${relative(sourceRoot, sourceEntry)}`);
    }
  }
}

async function productionDependencies(packageRoot: string, limits: PackageLimits): Promise<ParsedProductionDependencies | undefined> {
  let packageJsonBytes: Buffer;
  try {
    packageJsonBytes = await readRegularFile(join(packageRoot, "package.json"), MANIFEST_MAX_BYTES, "Package package.json");
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(packageJsonBytes, "Package package.json")) as unknown;
  } catch (error) {
    throw new Error("Package package.json is not valid JSON", { cause: error });
  }
  const packageJson = object(parsed, "Package package.json");
  const fields: ProductionDependencies = {};
  let count = 0;
  for (const field of PRODUCTION_DEPENDENCY_FIELDS) {
    const raw = packageJson[field];
    if (raw === undefined) continue;
    const input = object(raw, `Package package.json ${field}`);
    const entries = Object.entries(input);
    if (entries.length === 0) continue;
    count += entries.length;
    if (count > limits.maxEntries) throw new Error(`Package production dependencies exceed ${limits.maxEntries} entries`);
    const selected: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [name, spec] of entries) {
      npmPackageName(name, `Package package.json ${field} name`);
      selected[name] = npmDependencySpec(spec, `Package package.json ${field}.${name}`);
    }
    fields[field] = selected;
  }
  const rawPeerMetadata = packageJson.peerDependenciesMeta;
  if (rawPeerMetadata !== undefined) {
    const input = object(rawPeerMetadata, "Package package.json peerDependenciesMeta");
    const entries = Object.entries(input);
    count += entries.length;
    if (count > limits.maxEntries) throw new Error(`Package production dependencies exceed ${limits.maxEntries} entries`);
    const selected: Record<string, { optional?: boolean }> = Object.create(null) as Record<string, { optional?: boolean }>;
    for (const [name, rawMetadata] of entries) {
      npmPackageName(name, "Package package.json peerDependenciesMeta name");
      if (fields.peerDependencies?.[name] === undefined) {
        throw new Error(`Package package.json peerDependenciesMeta.${name} does not name a peer dependency`);
      }
      const metadata = object(rawMetadata, `Package package.json peerDependenciesMeta.${name}`);
      const unknown = Object.keys(metadata).filter((key) => key !== "optional");
      if (unknown.length > 0 || (metadata.optional !== undefined && typeof metadata.optional !== "boolean")) {
        throw new Error(`Package package.json peerDependenciesMeta.${name} must contain only an optional boolean`);
      }
      selected[name] = metadata.optional === undefined ? {} : { optional: metadata.optional };
    }
    if (entries.length > 0) fields.peerDependenciesMeta = selected;
  }

  const hostRange = fields.peerDependencies?.rigyn;
  if (hostRange !== undefined) {
    if (!satisfies(RIGYN_VERSION, hostRange, { includePrerelease: true })) {
      throw new Error(`Package requires Rigyn ${hostRange}; current version is ${RIGYN_VERSION}`);
    }
    delete fields.peerDependencies!.rigyn;
    if (Object.keys(fields.peerDependencies!).length === 0) delete fields.peerDependencies;
    if (fields.peerDependenciesMeta !== undefined) {
      delete fields.peerDependenciesMeta.rigyn;
      if (Object.keys(fields.peerDependenciesMeta).length === 0) delete fields.peerDependenciesMeta;
    }
  }

  if (count === 0) return undefined;
  return { fields, packageJsonSha256: sha256(packageJsonBytes) };
}

async function installProductionDependencies(
  packageRoot: string,
  container: string,
  limits: PackageLimits,
  commands: ExtensionPackageCommands,
  budget: CopyBudget,
  allowScripts: boolean,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const dependencies = await productionDependencies(packageRoot, limits);
  if (dependencies === undefined) return;
  const destination = join(packageRoot, "node_modules");
  try {
    await lstat(destination);
    throw new Error("Package source with production dependencies must not contain node_modules");
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
  if (!PRODUCTION_DEPENDENCY_FIELDS
    .some((field) => Object.keys(dependencies.fields[field] ?? {}).length > 0)) return;

  const dependencyContainer = join(container, ".dependencies");
  const home = join(dependencyContainer, "home");
  const workspace = join(dependencyContainer, "workspace");
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(join(home, "npmrc"), "", { flag: "wx", mode: 0o600 });
    await writeFile(join(home, "npmrc-global"), "", { flag: "wx", mode: 0o600 });
    await writeFile(join(workspace, ".npmrc"), "", { flag: "wx", mode: 0o600 });
    await writeFile(join(workspace, "package.json"), `${JSON.stringify({
      name: "rigyn-extension-dependencies",
      version: "0.0.0",
      private: true,
      ...dependencies.fields,
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const npm = commands.npm ?? await npmCommand();
    await runBoundedCommand(npm.command, [
      ...(npm.prefix ?? []),
      "install",
      `--ignore-scripts=${allowScripts ? "false" : "true"}`,
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      `--bin-links=${allowScripts ? "true" : "false"}`,
      "--no-save",
    ], {
      cwd: workspace,
      environment: commandEnvironment(home, "npm", { allowScripts }),
      timeoutMs: limits.sourceTimeoutMs,
      maxOutputBytes: limits.maxCommandOutputBytes,
      label: "npm production dependency install",
      ...(signal === undefined ? {} : { signal }),
    });

    const installedModules = join(workspace, "node_modules");
    let information;
    try {
      information = await lstat(installedModules);
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
      const required = Object.keys(dependencies.fields.dependencies ?? {}).length > 0 ||
        Object.keys(dependencies.fields.peerDependencies ?? {}).some((name) =>
          dependencies.fields.peerDependenciesMeta?.[name]?.optional !== true
        );
      const currentPackageJson = await readRegularFile(join(packageRoot, "package.json"), MANIFEST_MAX_BYTES, "Staged package.json");
      if (sha256(currentPackageJson) !== dependencies.packageJsonSha256) {
        throw new Error("Package package.json changed during production dependency installation");
      }
      if (required) throw new Error("npm production dependency install produced no node_modules tree");
      return;
    }
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw new Error("npm production dependency install produced an unsafe node_modules tree");
    }
    const canonicalModules = await realpath(installedModules);
    await quarantineDependencyBinDirectories(canonicalModules, join(dependencyContainer, ".bin-links"), limits);
    await mkdir(destination, { mode: 0o700 });
    await copyDirectorySafely(canonicalModules, canonicalModules, destination, limits, budget, 0);
    const currentPackageJson = await readRegularFile(join(packageRoot, "package.json"), MANIFEST_MAX_BYTES, "Staged package.json");
    if (sha256(currentPackageJson) !== dependencies.packageJsonSha256) {
      throw new Error("Package package.json changed during production dependency installation");
    }
  } finally {
    await rm(dependencyContainer, { recursive: true, force: true });
  }
}

async function quarantineDependencyBinDirectories(root: string, quarantine: string, limits: PackageLimits): Promise<void> {
  let entries = 0;
  let quarantined = 0;
  const visit = async (directoryPath: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth) throw new Error(`Dependency tree exceeds maximum depth ${limits.maxDepth}`);
    const names: string[] = [];
    const directory = await opendir(directoryPath);
    try {
      for await (const entry of directory) {
        entries += 1;
        if (entries > limits.maxEntries) throw new Error(`Dependency tree exceeds ${limits.maxEntries} entries`);
        names.push(entry.name);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const entryPath = join(directoryPath, name);
      const information = await lstat(entryPath);
      if (name === ".bin") {
        if (quarantined === 0) await mkdir(quarantine, { mode: 0o700 });
        await rename(entryPath, join(quarantine, String(quarantined)));
        quarantined += 1;
      } else if (information.isDirectory() && !information.isSymbolicLink()) {
        await visit(entryPath, depth + 1);
      }
    }
  };
  await visit(root, 0);
}

function packageTransactionAllowsScripts(options: ExtensionPackageTransactionOptions): boolean {
  if (options.allowScripts !== undefined && typeof options.allowScripts !== "boolean") {
    throw new TypeError("allowScripts must be a boolean");
  }
  return options.allowScripts === true;
}

function cloneProvenance(value: ExtensionPackageProvenance): ExtensionPackageProvenance {
  return { ...value };
}

function cloneInstalled(value: InstalledExtensionPackage): InstalledExtensionPackage {
  return { ...value, provenance: cloneProvenance(value.provenance) };
}

interface PackageLockOwner {
  pid: number;
  token: string;
  createdAt: number;
}

interface PackageTransaction {
  schemaVersion: 1;
  id: string;
}

function lockOwner(value: unknown): PackageLockOwner | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (!Number.isSafeInteger(input.pid) || (input.pid as number) < 1 || typeof input.token !== "string" || input.token === ""
    || !Number.isSafeInteger(input.createdAt) || (input.createdAt as number) < 0) return undefined;
  return { pid: input.pid as number, token: input.token, createdAt: input.createdAt as number };
}

function packageTransaction(value: unknown): PackageTransaction {
  const input = object(value, "Package transaction");
  if (input.schemaVersion !== 1 || typeof input.id !== "string" || Object.keys(input).some((key) => key !== "schemaVersion" && key !== "id")) {
    throw new Error("Package transaction is invalid");
  }
  id(input.id);
  return { schemaVersion: 1, id: input.id };
}

function retargetInstalled(value: InstalledExtensionPackage, packageRoot: string): InstalledExtensionPackage {
  return {
    ...value,
    packageRoot,
    manifestPath: join(packageRoot, MANIFEST_NAME),
    provenance: cloneProvenance(value.provenance),
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolveWait, reject) => {
    let timer: NodeJS.Timeout;
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Package transaction cancelled"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolveWait();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
  });
}

export function extensionPackageSources(roots: ExtensionPackageRoots, projectTrusted: boolean): ExtensionSource[] {
  const user = path(roots.user, "User package root");
  const result: ExtensionSource[] = [{ path: user, scope: "user", trusted: true, optional: true }];
  if (roots.project !== undefined) result.push({
    path: path(roots.project, "Project package root"),
    scope: "project",
    trusted: projectTrusted,
    optional: true,
  });
  return result;
}

export class LocalExtensionPackageManager {
  readonly #roots: ExtensionPackageRoots;
  readonly #limits: PackageLimits;
  readonly #commands: ExtensionPackageCommands;
  #operations: Promise<void> = Promise.resolve();

  constructor(roots: ExtensionPackageRoots, limits: ExtensionPackageLimits = {}, commands: ExtensionPackageCommands = {}) {
    this.#roots = {
      user: path(roots.user, "User package root"),
      ...(roots.project === undefined ? {} : { project: path(roots.project, "Project package root") }),
    };
    this.#limits = packageLimits(limits);
    this.#commands = {
      ...(commands.npm === undefined ? {} : { npm: { command: commands.npm.command, prefix: [...(commands.npm.prefix ?? [])] } }),
      ...(commands.git === undefined ? {} : { git: { command: commands.git.command, prefix: [...(commands.git.prefix ?? [])] } }),
    };
  }

  sources(projectTrusted: boolean): ExtensionSource[] {
    return extensionPackageSources(this.#roots, projectTrusted);
  }

  install(
    sourcePath: string,
    selectedScope: ExtensionPackageScope = "user",
    options: ExtensionPackageTransactionOptions = {},
  ): Promise<InstalledExtensionPackage> {
    const allowScripts = packageTransactionAllowsScripts(options);
    return this.#serialized(async () => {
      options.signal?.throwIfAborted();
      scope(selectedScope);
      const root = await this.#root(selectedScope, true);
      if (root === undefined) throw new Error(`No ${selectedScope} package root is configured`);
      return await this.#withPackageLock(root, async () => {
        const staged = await this.#stage(sourcePath, selectedScope, undefined, allowScripts, options.signal);
        const target = join(root, staged.manifest.id);
        try {
          options.signal?.throwIfAborted();
          const installed = await this.#inspect(staged.packageRoot, selectedScope);
          try {
            await lstat(target);
            throw new Error(`Package ${staged.manifest.id} is already installed in ${selectedScope} scope`);
          } catch (error) {
            if (errno(error) !== "ENOENT") throw error;
          }
          await rename(staged.packageRoot, target);
          return retargetInstalled(installed, target);
        } finally {
          await rm(staged.container, { recursive: true, force: true }).catch(() => undefined);
        }
      }, options.signal);
    });
  }

  update(
    packageId: string,
    selectedScope: ExtensionPackageScope = "user",
    sourcePath?: string,
    options: ExtensionPackageTransactionOptions = {},
  ): Promise<InstalledExtensionPackage> {
    const allowScripts = packageTransactionAllowsScripts(options);
    return this.#serialized(async () => {
      options.signal?.throwIfAborted();
      id(packageId);
      scope(selectedScope);
      const root = await this.#root(selectedScope, false);
      if (root === undefined) throw new Error(`Package ${packageId} is not installed in ${selectedScope} scope`);
      return await this.#withPackageLock(root, async () => {
        const target = join(root, packageId);
        const current = await this.#inspect(target, selectedScope);
        const staged = await this.#stage(
          sourcePath ?? sourceFromProvenance(current.provenance),
          selectedScope,
          current.provenance.installedAt,
          allowScripts,
          options.signal,
        );
        if (staged.manifest.id !== packageId) {
          await rm(staged.container, { recursive: true, force: true });
          throw new Error(`Update source contains package ${staged.manifest.id}, expected ${packageId}`);
        }
        const installed = await this.#inspect(staged.packageRoot, selectedScope);
        const backupContainer = await mkdtemp(join(root, PACKAGE_BACKUP_PREFIX));
        const backup = join(backupContainer, packageId);
        let preserveBackup = false;
        try {
          options.signal?.throwIfAborted();
          await writeFile(join(backupContainer, PACKAGE_TRANSACTION), `${JSON.stringify({ schemaVersion: 1, id: packageId })}\n`, {
            flag: "wx",
            mode: 0o600,
          });
          await rename(target, backup);
          try {
            await rename(staged.packageRoot, target);
          } catch (activationError) {
            try {
              await rename(backup, target);
            } catch (restoreError) {
              preserveBackup = true;
              throw new AggregateError(
                [activationError, restoreError],
                `Unable to activate package ${packageId}; its previous version remains in ${backup}`,
              );
            }
            throw activationError;
          }
          return retargetInstalled(installed, target);
        } finally {
          await rm(staged.container, { recursive: true, force: true }).catch(() => undefined);
          if (!preserveBackup) await rm(backupContainer, { recursive: true, force: true }).catch(() => undefined);
        }
      }, options.signal);
    });
  }

  remove(packageId: string, selectedScope: ExtensionPackageScope = "user"): Promise<InstalledExtensionPackage> {
    return this.#serialized(async () => {
      id(packageId);
      scope(selectedScope);
      const root = await this.#root(selectedScope, false);
      if (root === undefined) throw new Error(`Package ${packageId} is not installed in ${selectedScope} scope`);
      return await this.#withPackageLock(root, async () => {
        const target = join(root, packageId);
        const installed = await this.#inspect(target, selectedScope);
        const trashContainer = await mkdtemp(join(root, PACKAGE_REMOVE_PREFIX));
        const trash = join(trashContainer, packageId);
        try {
          await rename(target, trash);
          await rm(trash, { recursive: true });
          return installed;
        } finally {
          await rm(trashContainer, { recursive: true, force: true });
        }
      });
    });
  }

  list(
    selectedScope?: ExtensionPackageScope,
    options: Pick<ExtensionPackageTransactionOptions, "signal"> = {},
  ): Promise<InstalledExtensionPackage[]> {
    return this.#serialized(async () => {
      options.signal?.throwIfAborted();
      if (selectedScope !== undefined) scope(selectedScope);
      const scopes: ExtensionPackageScope[] = selectedScope === undefined ? ["user", "project"] : [selectedScope];
      const result: InstalledExtensionPackage[] = [];
      for (const itemScope of scopes) {
        const root = await this.#root(itemScope, false);
        if (root === undefined) continue;
        await this.#withPackageLock(root, async () => {
          const entries: string[] = [];
          const directory = await opendir(root);
          try {
            for await (const entry of directory) {
              if (entries.length >= this.#limits.maxEntries) throw new Error(`Package root exceeds ${this.#limits.maxEntries} entries`);
              entries.push(entry.name);
            }
          } finally {
            await directory.close().catch(() => undefined);
          }
          entries.sort((left, right) => left.localeCompare(right));
          for (const name of entries) {
            if (!IDENTIFIER.test(name)) continue;
            const target = join(root, name);
            const information = await lstat(target);
            if (!information.isDirectory() || information.isSymbolicLink()) continue;
            try {
              await lstat(join(target, EXTENSION_PACKAGE_PROVENANCE));
            } catch (error) {
              if (errno(error) === "ENOENT") continue;
              throw error;
            }
            result.push(await this.#inspect(target, itemScope));
          }
        }, options.signal);
      }
      return result.map(cloneInstalled);
    });
  }

  async #root(selectedScope: ExtensionPackageScope, create: boolean): Promise<string | undefined> {
    const configured = this.#roots[selectedScope];
    if (configured === undefined) return undefined;
    if (create) await mkdir(configured, { recursive: true, mode: 0o700 });
    let information;
    try {
      information = await lstat(configured);
    } catch (error) {
      if (!create && errno(error) === "ENOENT") return undefined;
      throw error;
    }
    if (!information.isDirectory() || information.isSymbolicLink()) throw new Error(`${selectedScope} package root must be a real directory`);
    return await realpath(configured);
  }

  async #stage(
    sourcePath: string,
    selectedScope: ExtensionPackageScope,
    installedAt?: string,
    allowScripts = false,
    signal?: AbortSignal,
  ): Promise<StagedPackage> {
    signal?.throwIfAborted();
    const root = await this.#root(selectedScope, true);
    if (root === undefined) throw new Error(`No ${selectedScope} package root is configured`);
    const container = await mkdtemp(join(root, PACKAGE_STAGE_PREFIX));
    try {
      const material = await materializePackageSource(
        parseExtensionPackageSource(sourcePath),
        container,
        this.#limits,
        this.#commands,
        signal,
      );
      signal?.throwIfAborted();
      const declaredManifestBytes = await optionalRegularFile(join(material.root, MANIFEST_NAME), MANIFEST_MAX_BYTES, "Package manifest");
      const generatedManifest = declaredManifestBytes === undefined ? await generateConventionManifest(material.root) : undefined;
      const sourceManifestBytes = declaredManifestBytes ?? generatedManifest!.bytes;
      const sourceManifest = generatedManifest?.manifest
        ?? parseExtensionManifest(JSON.parse(decodeUtf8(sourceManifestBytes, "Package manifest")) as unknown);
      const workingContainer = join(container, ".work");
      const workingRoot = join(workingContainer, "package");
      await mkdir(workingRoot, { recursive: true, mode: 0o700 });
      const workingBudget: CopyBudget = { entries: 0, bytes: 0 };
      await copyDirectorySafely(material.root, material.root, workingRoot, this.#limits, workingBudget, 0);
      signal?.throwIfAborted();
      if (generatedManifest !== undefined) await writeFile(join(workingRoot, MANIFEST_NAME), sourceManifestBytes, { mode: 0o600, flag: "wx" });
      await installProductionDependencies(workingRoot, container, this.#limits, this.#commands, workingBudget, allowScripts, signal);
      signal?.throwIfAborted();
      if (material.cleanup !== undefined) await rm(material.cleanup, { recursive: true, force: true });
      const workingManifestBytes = await readRegularFile(join(workingRoot, MANIFEST_NAME), MANIFEST_MAX_BYTES, "Working package manifest");
      if (!workingManifestBytes.equals(sourceManifestBytes)) throw new Error("Package manifest changed while dependencies were installed");

      const packageRoot = join(container, sourceManifest.id);
      await mkdir(packageRoot, { mode: 0o700 });
      const activationBudget: CopyBudget = { entries: 0, bytes: 0 };
      await copyDirectorySafely(workingRoot, workingRoot, packageRoot, this.#limits, activationBudget, 0);
      await rm(workingContainer, { recursive: true, force: true });
      const manifestBytes = await readRegularFile(join(packageRoot, MANIFEST_NAME), MANIFEST_MAX_BYTES, "Staged package manifest");
      const manifest = parseExtensionManifest(JSON.parse(decodeUtf8(manifestBytes, "Staged package manifest")) as unknown);
      if (!manifestBytes.equals(sourceManifestBytes) || manifest.id !== sourceManifest.id) {
        throw new Error("Package manifest changed while being staged");
      }
      const now = new Date().toISOString();
      const common: ExtensionPackageProvenanceBase = {
        schemaVersion: 1,
        id: manifest.id,
        scope: selectedScope,
        installedAt: installedAt ?? now,
        ...(installedAt === undefined ? {} : { updatedAt: now }),
        manifestSha256: sha256(manifestBytes),
      };
      const provenance: ExtensionPackageProvenance = material.identity.kind === "local"
        ? { ...common, kind: "local", sourcePath: material.identity.sourcePath }
        : material.identity.kind === "npm"
          ? {
              ...common,
              kind: "npm",
              source: material.identity.source,
              packageName: material.identity.packageName,
              resolvedVersion: material.identity.resolvedVersion,
              archiveSha256: material.identity.archiveSha256,
            }
          : { ...common, kind: "git", source: material.identity.source, revision: material.identity.revision };
      await writeFile(join(packageRoot, EXTENSION_PACKAGE_PROVENANCE), `${JSON.stringify(provenance, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      const catalog = await discoverExtensions([{ path: container, scope: selectedScope, trusted: true }]);
      const metadata = catalog.list().find((entry) => entry.id === manifest.id);
      if (metadata === undefined || (metadata.status !== "active" && metadata.status !== "disabled")) {
        const diagnostic = catalog.doctor().diagnostics.find((entry) => entry.extensionId === manifest.id || entry.path.includes(packageRoot));
        throw new Error(diagnostic?.message ?? `Package ${manifest.id} did not pass extension validation`);
      }
      if (!catalog.doctor().healthy) {
        const diagnostic = catalog.doctor().diagnostics.find((entry) => entry.severity === "error");
        throw new Error(diagnostic?.message ?? `Package ${manifest.id} did not pass extension validation`);
      }
      signal?.throwIfAborted();
      return { container, packageRoot, manifest };
    } catch (error) {
      await rm(container, { recursive: true, force: true });
      throw error;
    }
  }

  async #inspect(packageRoot: string, selectedScope: ExtensionPackageScope): Promise<InstalledExtensionPackage> {
    const information = await lstat(packageRoot);
    if (!information.isDirectory() || information.isSymbolicLink()) throw new Error("Managed package root must be a real directory");
    const canonicalRoot = await realpath(packageRoot);
    const provenanceBytes = await readRegularFile(join(canonicalRoot, EXTENSION_PACKAGE_PROVENANCE), PROVENANCE_MAX_BYTES, "Package provenance");
    const provenance = parseExtensionPackageProvenance(JSON.parse(decodeUtf8(provenanceBytes, "Package provenance")) as unknown);
    if (provenance.scope !== selectedScope) throw new Error(`Package provenance scope does not match ${selectedScope}`);
    if (join(dirname(canonicalRoot), provenance.id) !== canonicalRoot) throw new Error("Package provenance ID does not match its directory");
    const manifestPath = join(canonicalRoot, MANIFEST_NAME);
    const manifestBytes = await readRegularFile(manifestPath, MANIFEST_MAX_BYTES, "Installed package manifest");
    const manifest = parseExtensionManifest(JSON.parse(decodeUtf8(manifestBytes, "Installed package manifest")) as unknown);
    if (manifest.id !== provenance.id) throw new Error("Installed package manifest and provenance IDs do not match");
    return {
      id: manifest.id,
      name: manifest.name,
      ...(manifest.version === undefined ? {} : { version: manifest.version }),
      ...(manifest.description === undefined ? {} : { description: manifest.description }),
      scope: selectedScope,
      packageRoot: canonicalRoot,
      manifestPath,
      manifestModified: sha256(manifestBytes) !== provenance.manifestSha256,
      provenance: cloneProvenance(provenance),
    };
  }

  async #recoverTransactions(root: string): Promise<void> {
    const names = (await readdir(root)).filter((name) =>
      name.startsWith(PACKAGE_STAGE_PREFIX) || name.startsWith(PACKAGE_BACKUP_PREFIX) || name.startsWith(PACKAGE_REMOVE_PREFIX)
    ).sort((left, right) => left.localeCompare(right));
    if (names.length > this.#limits.maxEntries) throw new Error(`Package root exceeds ${this.#limits.maxEntries} recovery entries`);
    for (const name of names) {
      const container = join(root, name);
      const information = await lstat(container);
      if (!information.isDirectory() || information.isSymbolicLink()) {
        throw new Error(`Package recovery path must be a real directory: ${container}`);
      }
      if (!name.startsWith(PACKAGE_BACKUP_PREFIX)) {
        await rm(container, { recursive: true, force: true });
        continue;
      }
      let transaction: PackageTransaction;
      try {
        transaction = packageTransaction(JSON.parse(decodeUtf8(
          await readRegularFile(join(container, PACKAGE_TRANSACTION), PACKAGE_TRANSACTION_BYTES, "Package transaction"),
          "Package transaction",
        )) as unknown);
      } catch (error) {
        const candidates = (await readdir(container)).filter((entry) => entry !== PACKAGE_TRANSACTION && IDENTIFIER.test(entry));
        if (candidates.length === 0) {
          await rm(container, { recursive: true, force: true });
          continue;
        }
        if (candidates.length !== 1) throw error;
        const candidate = join(container, candidates[0]!);
        const candidateInformation = await lstat(candidate);
        if (!candidateInformation.isDirectory() || candidateInformation.isSymbolicLink()) throw error;
        transaction = { schemaVersion: 1, id: candidates[0]! };
      }
      const backup = join(container, transaction.id);
      const target = join(root, transaction.id);
      let targetInformation;
      try {
        targetInformation = await lstat(target);
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
      }
      if (targetInformation !== undefined) {
        if (!targetInformation.isDirectory() || targetInformation.isSymbolicLink()) {
          throw new Error(`Recovered package target must be a real directory: ${target}`);
        }
        await rm(container, { recursive: true, force: true });
        continue;
      }
      let backupInformation;
      try {
        backupInformation = await lstat(backup);
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
      }
      if (backupInformation === undefined) {
        await rm(container, { recursive: true, force: true });
        continue;
      }
      if (!backupInformation.isDirectory() || backupInformation.isSymbolicLink()) {
        throw new Error(`Recovered package backup must be a real directory: ${backup}`);
      }
      await rename(backup, target);
      await rm(container, { recursive: true, force: true });
    }
  }

  async #withPackageLock<T>(root: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lockPath = join(root, EXTENSION_PACKAGE_LOCK);
    const owner: PackageLockOwner = {
      pid: process.pid,
      token: randomBytes(16).toString("hex"),
      createdAt: Date.now(),
    };
    const deadline = Date.now() + Math.max(30_000, this.#limits.sourceTimeoutMs + 10_000);
    while (true) {
      signal?.throwIfAborted();
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        if (errno(error) !== "EEXIST") throw error;
        let raw: Buffer | undefined;
        let existing: PackageLockOwner | undefined;
        let stale = false;
        try {
          raw = await readRegularFile(lockPath, PACKAGE_LOCK_BYTES, "Package lock");
          try {
            existing = lockOwner(JSON.parse(decodeUtf8(raw, "Package lock")) as unknown);
          } catch {}
          if (existing !== undefined) stale = !processExists(existing.pid);
          else stale = Date.now() - (await lstat(lockPath)).mtimeMs > UNPARSEABLE_PACKAGE_LOCK_MAX_AGE_MS;
        } catch (readError) {
          if (errno(readError) === "ENOENT") continue;
        }
        if (stale && raw !== undefined) {
          try {
            const current = await readRegularFile(lockPath, PACKAGE_LOCK_BYTES, "Package lock");
            let currentOwner: PackageLockOwner | undefined;
            try {
              currentOwner = lockOwner(JSON.parse(decodeUtf8(current, "Package lock")) as unknown);
            } catch {}
            if (current.equals(raw) && (currentOwner === undefined || !processExists(currentOwner.pid))) {
              await rm(lockPath, { force: true });
            }
            continue;
          } catch (readError) {
            if (errno(readError) === "ENOENT") continue;
          }
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for package lock: ${lockPath}`);
        await wait(50, signal);
      }
    }
    try {
      await this.#recoverTransactions(root);
      return await operation();
    } finally {
      try {
        const current = lockOwner(JSON.parse(decodeUtf8(
          await readRegularFile(lockPath, PACKAGE_LOCK_BYTES, "Package lock"),
          "Package lock",
        )) as unknown);
        if (current?.token === owner.token) await rm(lockPath, { force: true });
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
      }
    }
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation, operation);
    this.#operations = result.then(() => undefined, () => undefined);
    return result;
  }
}
