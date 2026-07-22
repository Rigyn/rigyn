import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import ignore, { type Ignore } from "ignore";
import { minimatch } from "minimatch";
import { maxSatisfying, rcompare, satisfies, valid, validRange } from "semver";

import { CONFIG_DIR_NAME } from "../config/paths.js";
import { legacyManifestResources, parseLegacyExtensionManifest } from "../extensions/legacy-manifest.js";
import {
  GIT_COMMAND_OUTPUT_LIMIT_BYTES,
  gitRepositoryIdentity,
  gitRepositoryProtocol,
  resolveGitRemoteRef,
  runGitCommand,
  validateGitRef,
  type GitProtocol,
} from "../process/git-runner.js";
import { runProcess } from "../process/runner.js";
import { defaultNpmCommand } from "../process/npm-command.js";
import { RIGYN_VERSION } from "../version.js";
import { parseGitUrl, type GitSource } from "../utils/git.js";
import {
  canonicalizePath,
  markPathIgnoredByCloudSync,
  portableLocalPackageSource,
  resolvePath,
} from "../utils/paths.js";
import type { PackageSource, SettingsManager } from "./settings-manager.js";

export type PackageScope = "user" | "project" | "temporary";
export type ResourceType = "extensions" | "skills" | "prompts" | "themes";

export interface PathMetadata {
  source: string;
  scope: PackageScope;
  origin: "package" | "top-level";
  baseDir?: string;
  declaredResources?: readonly DeclaredResourceMetadata[];
  disabledDeclaredResources?: readonly string[];
}

export interface DeclaredResourceMetadata {
  kind: "prompt" | "command" | "theme";
  name: string;
  description?: string;
  argumentHint?: string;
}

export interface ResolvedResource {
  path: string;
  enabled: boolean;
  metadata: PathMetadata;
}

export interface ResolvedPaths {
  extensions: ResolvedResource[];
  skills: ResolvedResource[];
  prompts: ResolvedResource[];
  themes: ResolvedResource[];
}

export type MissingSourceAction = "install" | "skip" | "error";

export interface ProgressEvent {
  type: "start" | "progress" | "complete" | "error";
  action: "install" | "remove" | "update" | "clone" | "pull";
  source: string;
  message?: string;
}

export type ProgressCallback = (event: ProgressEvent) => void;

export interface PackageUpdate {
  source: string;
  displayName: string;
  type: "npm" | "git";
  scope: "user" | "project";
}

export interface ConfiguredPackage {
  source: string;
  scope: "user" | "project";
  filtered: boolean;
  installedPath?: string;
}

export interface PackageActivationCandidate {
  source: string;
  scope: PackageScope;
  workspace: string;
  projectTrusted: boolean;
  resources: ResolvedPaths;
  dataRoot: string;
  signal?: AbortSignal;
}

export type PackageActivationCallback = (candidate: PackageActivationCandidate) => Promise<void>;

export interface PackageInstallOptions {
  local?: boolean;
  allowScripts?: boolean;
  signal?: AbortSignal;
}

export interface PackageUpdateOptions {
  allowScripts?: boolean;
  signal?: AbortSignal;
}

export interface PackageManager {
  resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>;
  install(source: string, options?: PackageInstallOptions): Promise<void>;
  installAndPersist(source: string, options?: PackageInstallOptions): Promise<void>;
  remove(source: string, options?: { local?: boolean }): Promise<void>;
  removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
  update(source?: string, options?: PackageUpdateOptions): Promise<void>;
  checkForAvailableUpdates(): Promise<PackageUpdate[]>;
  listConfiguredPackages(): ConfiguredPackage[];
  resolveExtensionSources(sources: readonly PackageSource[], options?: { local?: boolean; temporary?: boolean }): Promise<ResolvedPaths>;
  addSourceToSettings(source: string, options?: { local?: boolean }): boolean;
  removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean;
  setProgressCallback(callback: ProgressCallback | undefined): void;
  getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
}

export interface PackageManagerOptions {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  activateCandidate?: PackageActivationCallback;
  offline?: boolean;
  gitCommand?: readonly [string, ...string[]];
}

interface NpmSource {
  type: "npm";
  spec: string;
  name: string;
  identity: string;
  filePath?: string;
  version?: string;
  range?: string;
  pinned: boolean;
}

interface LocalSource {
  type: "local";
  path: string;
}

type ParsedSource = NpmSource | GitSource | LocalSource;
type ResourceMap = Map<string, { metadata: PathMetadata; enabled: boolean }>;
type ResourceAccumulator = Record<ResourceType, ResourceMap>;
type PackageFilter = Exclude<PackageSource, string>;
type PackageManifest = Partial<Record<ResourceType, string[]>> & {
  declarations?: ReadonlyMap<string, readonly DeclaredResourceMetadata[]>;
};

interface StagedPackageInstall {
  packagePath: string;
  commit(): void;
  rollback(): void;
  cleanup(): void;
}

class PackageCommitRollbackError extends AggregateError {}

const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const;
const EXTENSION_SUFFIX = /\.(?:c|m)?(?:j|t)s$/iu;
const SKILL_SUFFIX = /\.md$/iu;
const PROMPT_SUFFIX = /\.md$/iu;
const THEME_SUFFIX = /\.json$/iu;
const IGNORE_FILES = [".gitignore", ".ignore", ".fdignore"] as const;
const NETWORK_TIMEOUT_MS = 10_000;
const UPDATE_CHECK_CONCURRENCY = 4;
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const PACKAGE_STAGE_PREFIX = ".rigyn-package-stage-";
const PACKAGE_ACTIVATION_PREFIX = "package-activation-";
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu;
const NPM_DIST_TAG = /^[a-z0-9][a-z0-9._-]*$/iu;

function subprocessEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let base = process.env;
  if (process.platform === "linux" && Object.keys(base).length === 0) {
    try {
      const recovered: NodeJS.ProcessEnv = {};
      for (const entry of readFileSync("/proc/self/environ", "utf8").split("\0")) {
        const separator = entry.indexOf("=");
        if (separator > 0) recovered[entry.slice(0, separator)] = entry.slice(separator + 1);
      }
      base = recovered;
    } catch {
      // Preserve the empty environment if the process environment cannot be recovered.
    }
  }
  return overrides === undefined ? base : { ...base, ...overrides };
}

function offlineEnvironment(): boolean {
  return /^(?:1|true|yes)$/iu.test(process.env.RIGYN_OFFLINE ?? "");
}

function homeDirectory(): string {
  return process.env.HOME || homedir();
}

function posix(path: string): string {
  return path.split(sep).join("/");
}

function filePattern(type: ResourceType): RegExp {
  if (type === "extensions") return EXTENSION_SUFFIX;
  if (type === "skills") return SKILL_SUFFIX;
  if (type === "prompts") return PROMPT_SUFFIX;
  return THEME_SUFFIX;
}

function addIgnoreFileRules(matcher: Ignore, directory: string, root: string): void {
  const prefix = relative(root, directory);
  for (const name of IGNORE_FILES) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;
    try {
      const lines = readFileSync(path, "utf8").split(/\r?\n/u);
      for (const raw of lines) {
        const trimmed = raw.trim();
        if (trimmed === "" || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) continue;
        const negated = raw.startsWith("!");
        const escapedBang = raw.startsWith("\\!");
        const body = (negated ? raw.slice(1) : escapedBang ? raw.slice(1) : raw).replace(/^\//u, "");
        matcher.add(`${negated ? "!" : ""}${prefix === "" ? "" : `${posix(prefix)}/`}${body}`);
      }
    } catch {
      // An unreadable ignore file cannot contribute rules.
    }
  }
}

function directoryEntries(directory: string): Dirent<string>[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function entryKind(path: string, entry: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): "file" | "directory" | undefined {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink()) return undefined;
  try {
    const information = statSync(path);
    return information.isDirectory() ? "directory" : information.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
}

function walkFiles(
  directory: string,
  pattern: RegExp,
  root = directory,
  matcher: Ignore = ignore(),
  visited = new Set<string>(),
): string[] {
  if (!existsSync(directory)) return [];
  const canonicalDirectory = canonicalizePath(directory);
  if (visited.has(canonicalDirectory)) return [];
  visited.add(canonicalDirectory);
  addIgnoreFileRules(matcher, directory, root);
  const found: string[] = [];
  for (const entry of directoryEntries(directory)) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    const kind = entryKind(path, entry);
    if (kind === undefined) continue;
    const relativePath = posix(relative(root, path));
    if (matcher.ignores(kind === "directory" ? `${relativePath}/` : relativePath)) continue;
    if (kind === "directory") found.push(...walkFiles(path, pattern, root, matcher, visited));
    else if (pattern.test(entry.name)) found.push(path);
  }
  return found.sort();
}

function readManifest(root: string, legacy = false): PackageManifest | undefined {
  if (!legacy) {
    try {
      const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { rigyn?: unknown };
      if (packageJson.rigyn !== null && typeof packageJson.rigyn === "object" && !Array.isArray(packageJson.rigyn)) {
        const value = packageJson.rigyn as Record<string, unknown>;
        const manifest: PackageManifest = {};
        for (const type of RESOURCE_TYPES) {
          const entries = value[type];
          if (Array.isArray(entries)) manifest[type] = entries.filter((entry): entry is string => typeof entry === "string");
        }
        return manifest;
      }
    } catch {
      // A package may use the shipped extension.json manifest without package.json.
    }
  }
  const extensionPath = join(root, "extension.json");
  if (!existsSync(extensionPath)) return undefined;
  try {
    const parsed = parseLegacyExtensionManifest(
      JSON.parse(readFileSync(join(root, "extension.json"), "utf8")) as unknown,
    );
    if (!parsed.enabled || (parsed.hostVersionRange !== undefined && !satisfies(
      RIGYN_VERSION,
      parsed.hostVersionRange,
      { includePrerelease: true },
    ))) {
      return { extensions: [], skills: [], prompts: [], themes: [] };
    }
    for (const [path, expected] of parsed.integrity) {
      const absolute = resolve(root, path);
      if (!packagePathInside(root, absolute)) throw new Error(`Extension integrity path escapes package: ${path}`);
      const information = lstatSync(absolute);
      if (!information.isFile() || information.isSymbolicLink()) throw new Error(`Extension integrity path is not a regular file: ${path}`);
      const actual = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      if (actual !== expected) throw new Error(`Extension integrity mismatch: ${path}`);
    }
    const declarations = new Map<string, DeclaredResourceMetadata[]>();
    const add = (path: string, declaration: DeclaredResourceMetadata): void => {
      const absolute = resolve(root, path);
      declarations.set(absolute, [...(declarations.get(absolute) ?? []), declaration]);
    };
    for (const prompt of parsed.prompts) {
      add(prompt.path, {
        kind: "prompt",
        name: prompt.id,
        ...(prompt.description === undefined ? {} : { description: prompt.description }),
      });
    }
    for (const command of parsed.commands) {
      add(command.path, {
        kind: "command",
        name: command.name,
        ...(command.description === undefined ? {} : { description: command.description }),
        ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
      });
    }
    for (const theme of parsed.themes) {
      add(theme.path, {
        kind: "theme",
        name: theme.name,
        ...(theme.description === undefined ? {} : { description: theme.description }),
      });
    }
    return { ...legacyManifestResources(parsed), declarations };
  } catch {
    // An extension.json package is recognized but cannot activate when its
    // manifest or declared integrity is invalid.
    return { extensions: [], skills: [], prompts: [], themes: [] };
  }
}

function assertPackageHostCompatibility(root: string): void {
  let packageJson: { peerDependencies?: unknown };
  try {
    packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { peerDependencies?: unknown };
  } catch {
    return;
  }
  if (packageJson.peerDependencies === null || typeof packageJson.peerDependencies !== "object" || Array.isArray(packageJson.peerDependencies)) {
    return;
  }
  const range = (packageJson.peerDependencies as Record<string, unknown>).rigyn;
  if (range === undefined) return;
  if (typeof range !== "string" || validRange(range, { loose: false }) === null) {
    throw new Error("Extension package peerDependencies.rigyn must be a valid semantic-version range");
  }
  if (!satisfies(RIGYN_VERSION, range, { includePrerelease: true })) {
    throw new Error(`Extension package requires Rigyn ${range}; current version is ${RIGYN_VERSION}`);
  }
}

function extensionEntry(directory: string): string[] | undefined {
  const configured = readManifest(directory)?.extensions;
  if (configured !== undefined) {
    const found = manifestResourceFiles(directory, configured, "extensions");
    if (found.length > 0) return found;
  }
  for (const name of ["index.ts", "index.js", "index.mts", "index.mjs", "index.cts", "index.cjs"]) {
    const path = join(directory, name);
    if (existsSync(path)) return [path];
  }
  return undefined;
}

function extensionChildren(directory: string): string[] {
  const found: string[] = [];
  const matcher = ignore();
  addIgnoreFileRules(matcher, directory, directory);
  for (const entry of directoryEntries(directory)) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    const kind = entryKind(path, entry);
    if (kind === undefined || matcher.ignores(`${entry.name}${kind === "directory" ? "/" : ""}`)) continue;
    if (kind === "file" && EXTENSION_SUFFIX.test(entry.name)) found.push(path);
    if (kind === "directory") found.push(...(extensionEntry(path) ?? []));
  }
  return found.sort();
}

function autoExtensions(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return extensionEntry(directory) ?? extensionChildren(directory);
}

function topLevelFiles(directory: string, pattern: RegExp): string[] {
  const found: string[] = [];
  const matcher = ignore();
  addIgnoreFileRules(matcher, directory, directory);
  for (const entry of directoryEntries(directory)) {
    if (entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (matcher.ignores(entry.name)) continue;
    if (entryKind(path, entry) === "file" && pattern.test(entry.name)) found.push(path);
  }
  return found.sort();
}

function skillEntries(
  directory: string,
  topLevelMarkdown: boolean,
  root = directory,
  matcher: Ignore = ignore(),
  visited = new Set<string>(),
): string[] {
  if (!existsSync(directory)) return [];
  const canonicalDirectory = canonicalizePath(directory);
  if (visited.has(canonicalDirectory)) return [];
  visited.add(canonicalDirectory);
  addIgnoreFileRules(matcher, directory, root);
  const entries = directoryEntries(directory);
  const skill = entries.find((entry) => entry.name === "SKILL.md" && entryKind(join(directory, entry.name), entry) === "file");
  if (skill !== undefined) {
    const path = join(directory, skill.name);
    if (!matcher.ignores(posix(relative(root, path)))) return [path];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    const kind = entryKind(path, entry);
    if (kind === "file" && topLevelMarkdown && directory === root && SKILL_SUFFIX.test(entry.name)) {
      if (!matcher.ignores(posix(relative(root, path)))) found.push(path);
    } else if (kind === "directory" && !matcher.ignores(`${posix(relative(root, path))}/`)) {
      found.push(...skillEntries(path, topLevelMarkdown, root, matcher, visited));
    }
  }
  return found.sort();
}

function resourceFiles(directory: string, type: ResourceType): string[] {
  if (type === "extensions") return autoExtensions(directory);
  if (type === "skills") return skillEntries(directory, true);
  return walkFiles(directory, filePattern(type));
}

function manifestGlobFiles(root: string, pattern: string, type: ResourceType): string[] {
  const found = new Set<string>();
  const visited = new Set<string>();
  const scan = (directory: string): void => {
    const canonical = canonicalizePath(directory);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    for (const entry of directoryEntries(directory)) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      const kind = entryKind(path, entry);
      if (kind === undefined) continue;
      const matches = minimatch(posix(relative(root, path)), posix(pattern));
      if (matches) {
        if (kind === "file") found.add(path);
        else for (const child of resourceFiles(path, type)) found.add(child);
      }
      if (kind === "directory") scan(path);
    }
  };
  scan(root);
  return [...found].sort();
}

function packagePathInside(root: string, path: string): boolean {
  const boundary = resolve(root);
  const lexical = resolve(path);
  if (lexical !== boundary && !lexical.startsWith(`${boundary}${sep}`)) return false;
  const canonicalRoot = canonicalizePath(boundary);
  const canonicalPath = canonicalizePath(lexical);
  return canonicalPath === canonicalRoot || canonicalPath.startsWith(`${canonicalRoot}${sep}`);
}

function autoResourceFiles(directory: string, type: ResourceType): string[] {
  if (type === "prompts" || type === "themes") return topLevelFiles(directory, filePattern(type));
  return resourceFiles(directory, type);
}

function ancestorAgentSkillDirectories(cwd: string): string[] {
  let repositoryRoot: string | undefined;
  let probe = resolve(cwd);
  while (true) {
    if (existsSync(join(probe, ".git"))) {
      repositoryRoot = probe;
      break;
    }
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }

  const result: string[] = [];
  probe = resolve(cwd);
  while (true) {
    result.push(join(probe, ".agents", "skills"));
    if (probe === repositoryRoot) break;
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return result;
}

function manifestResourceFiles(root: string, entries: string[], type: ResourceType): string[] {
  const found = new Set<string>();
  for (const entry of entries) {
    if (/^[!+-]/u.test(entry)) continue;
    if (/[*?]/u.test(entry)) {
      for (const path of manifestGlobFiles(root, entry, type)) {
        if (packagePathInside(root, path)) found.add(path);
      }
      continue;
    }
    const path = resolve(root, entry);
    if (!existsSync(path) || !packagePathInside(root, path)) continue;
    try {
      if (statSync(path).isDirectory()) {
        const children = type === "extensions" && resolve(path) === resolve(root)
          ? extensionChildren(path)
          : resourceFiles(path, type);
        for (const child of children) {
          if (packagePathInside(root, child)) found.add(child);
        }
      } else if (statSync(path).isFile()) {
        found.add(path);
      }
    } catch {
      // A disappearing manifest entry is ignored during discovery.
    }
  }
  return [...found].sort();
}

function hasPattern(value: string): boolean {
  return /^[!+-]/u.test(value) || /[*?]/u.test(value);
}

function patternMatch(path: string, pattern: string, root: string, exact: boolean): boolean {
  const normalized = posix(pattern.replace(/^\.\//u, ""));
  const pathRelative = posix(relative(root, path));
  const pathAbsolute = posix(path);
  const name = basename(path);
  const skillDirectory = name === "SKILL.md" ? dirname(path) : undefined;
  const candidates = [pathRelative, pathAbsolute];
  if (!exact) candidates.push(name);
  if (skillDirectory !== undefined) {
    candidates.push(posix(relative(root, skillDirectory)), posix(skillDirectory));
    if (!exact) candidates.push(basename(skillDirectory));
  }
  return exact
    ? candidates.includes(normalized)
    : candidates.some((candidate) => minimatch(candidate, normalized, { nonegate: true, nocomment: true }));
}

function applyPatterns(paths: string[], patterns: string[], root: string, emptyMeansNone = false): Map<string, boolean> {
  if (patterns.length === 0) return new Map(paths.map((path) => [path, !emptyMeansNone]));
  const ordinary = patterns.filter((value) => !/^[!+-]/u.test(value));
  const excluded = patterns.filter((value) => value.startsWith("!")).map((value) => value.slice(1));
  const forceIncluded = patterns.filter((value) => value.startsWith("+")).map((value) => value.slice(1));
  const forceExcluded = patterns.filter((value) => value.startsWith("-")).map((value) => value.slice(1));
  const enabled = new Map(paths.map((path) => [path, ordinary.length === 0 && !emptyMeansNone]));
  for (const path of paths) {
    if (ordinary.some((pattern) => patternMatch(path, pattern, root, false))) enabled.set(path, true);
    if (excluded.some((pattern) => patternMatch(path, pattern, root, false))) enabled.set(path, false);
    if (forceIncluded.some((pattern) => patternMatch(path, pattern, root, true))) enabled.set(path, true);
    if (forceExcluded.some((pattern) => patternMatch(path, pattern, root, true))) enabled.set(path, false);
  }
  return enabled;
}

function applyDeltaPatterns(paths: string[], patterns: string[], root: string): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const raw of patterns) {
    const marker = raw[0];
    const marked = marker === "!" || marker === "+" || marker === "-";
    const pattern = marked ? raw.slice(1) : raw;
    const exact = marker === "+" || marker === "-";
    const enabled = marker !== "!" && marker !== "-";
    for (const path of paths) {
      if (patternMatch(path, pattern, root, exact)) result.set(path, enabled);
    }
  }
  return result;
}

function precedence(metadata: PathMetadata): number {
  if (metadata.origin === "package") return 4;
  return (metadata.scope === "project" ? 0 : 2) + (metadata.source === "local" ? 0 : 1);
}

function createAccumulator(): ResourceAccumulator {
  return { extensions: new Map(), skills: new Map(), prompts: new Map(), themes: new Map() };
}

export function getExtensionTempFolder(agentDirectory: string): string {
  const path = join(agentDirectory, "tmp", "extensions");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

export class DefaultPackageManager implements PackageManager {
  readonly #cwd: string;
  readonly #agentDir: string;
  readonly #settings: SettingsManager;
  readonly #activateCandidate: PackageActivationCallback | undefined;
  readonly #offline: boolean | undefined;
  readonly #gitCommand: readonly [string, ...string[]];
  #progress: ProgressCallback | undefined;
  #globalNpmRoot: string | undefined;
  #globalNpmRootCommand: string | undefined;

  constructor(options: PackageManagerOptions) {
    this.#cwd = resolvePath(options.cwd, process.cwd(), { homeDir: homeDirectory(), trim: true });
    this.#agentDir = resolvePath(options.agentDir, process.cwd(), { homeDir: homeDirectory(), trim: true });
    this.#settings = options.settingsManager;
    this.#activateCandidate = options.activateCandidate;
    this.#offline = options.offline;
    this.#gitCommand = options.gitCommand ?? ["git"];
  }

  #isOffline(): boolean {
    return this.#offline ?? offlineEnvironment();
  }

  setProgressCallback(callback: ProgressCallback | undefined): void { this.#progress = callback; }

  #emit(event: ProgressEvent): void { this.#progress?.(event); }

  async #withProgress(
    action: ProgressEvent["action"],
    source: string,
    message: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    this.#emit({ type: "start", action, source, message });
    try {
      await operation();
      this.#emit({ type: "complete", action, source });
    } catch (cause) {
      this.#emit({ type: "error", action, source, message: cause instanceof Error ? cause.message : String(cause) });
      throw cause;
    }
  }

  #scope(local: boolean | undefined): "user" | "project" { return local === true ? "project" : "user"; }

  #base(scope: PackageScope): string {
    if (scope === "project") {
      this.#assertProject();
      return join(this.#cwd, CONFIG_DIR_NAME);
    }
    return scope === "user" ? this.#agentDir : this.#cwd;
  }

  #assertProject(): void {
    if (!this.#settings.isProjectTrusted()) throw new Error("Project is not trusted; refusing package access");
  }

  #parse(source: string): ParsedSource {
    const value = source.trim();
    if (value.startsWith("npm:")) {
      const spec = value.slice(4).trim();
      if (spec.startsWith("file:")) {
        const filePath = this.#fileSourcePath(spec, this.#cwd);
        if (filePath === undefined) throw new Error(`Invalid npm package source: ${source}`);
        const identity = canonicalizePath(filePath);
        return {
          type: "npm",
          spec,
          name: `.rigyn-file-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
          identity: `file:${identity}`,
          filePath: identity,
          pinned: true,
        };
      }
      const match = /^(@?[^@/]+(?:\/[^@]+)?)(?:@(.+))?$/u.exec(spec);
      if (match === null || match[1] === undefined || !NPM_PACKAGE_NAME.test(match[1])) {
        throw new Error(`Invalid npm package source: ${source}`);
      }
      const version = match[2];
      const range = version === undefined ? undefined : validRange(version) ?? undefined;
      if (version !== undefined && range === undefined && !NPM_DIST_TAG.test(version)) {
        throw new Error(`Invalid npm package source: ${source}`);
      }
      return {
        type: "npm",
        spec,
        name: match[1],
        identity: match[1].toLowerCase(),
        ...(version === undefined ? {} : { version }),
        ...(range === undefined ? {} : { range }),
        pinned: valid(version ?? "") !== null,
      };
    }
    const git = parseGitUrl(value);
    if (git !== undefined) {
      gitRepositoryProtocol(git.repo);
      if (git.ref !== undefined) validateGitRef(git.ref);
      return git;
    }
    if (value.startsWith("git:")) throw new Error(`Invalid Git package source: ${source}`);
    return { type: "local", path: value };
  }

  #identity(source: string, scope: PackageScope = "temporary"): string {
    const parsed = this.#parse(source);
    if (parsed.type === "npm") return `npm:${parsed.identity}`;
    if (parsed.type === "git") return `git:${gitRepositoryIdentity(parsed.repo)}`;
    return `local:${this.#resolvePath(parsed.path, this.#base(scope))}`;
  }

  #sourceString(value: PackageSource): string { return typeof value === "string" ? value : value.source; }

  addSourceToSettings(source: string, options?: { local?: boolean }): boolean {
    const scope = this.#scope(options?.local);
    const current = scope === "project" ? this.#settings.getProjectSettings() : this.#settings.getGlobalSettings();
    const packages = current.packages ?? [];
    const identity = this.#identity(source, scope);
    const index = packages.findIndex((value) => this.#identity(this.#sourceString(value), scope) === identity);
    let normalized = source;
    if (this.#parse(source).type === "local") {
      normalized = portableLocalPackageSource(this.#base(scope), this.#resolvePath(source, this.#cwd));
    }
    if (index >= 0) {
      const existing = packages[index];
      if (existing === undefined || this.#sourceString(existing) === normalized) return false;
      const replacement = typeof existing === "string" ? normalized : { ...existing, source: normalized };
      const next = packages.with(index, replacement);
      if (scope === "project") this.#settings.setProjectPackages(next); else this.#settings.setPackages(next);
      return true;
    }
    const next = [...packages, normalized];
    if (scope === "project") this.#settings.setProjectPackages(next); else this.#settings.setPackages(next);
    return true;
  }

  removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean {
    const scope = this.#scope(options?.local);
    const current = scope === "project" ? this.#settings.getProjectSettings() : this.#settings.getGlobalSettings();
    const packages = current.packages ?? [];
    const identity = this.#identity(source, scope);
    const next = packages.filter((value) => this.#identity(this.#sourceString(value), scope) !== identity);
    if (next.length === packages.length) return false;
    if (scope === "project") this.#settings.setProjectPackages(next); else this.#settings.setPackages(next);
    return true;
  }

  #npmRoot(scope: PackageScope): string {
    if (scope === "temporary") return this.#temporaryDirectory("npm");
    return join(this.#base(scope), "npm");
  }

  #gitRoot(scope: PackageScope): string {
    if (scope === "temporary") return getExtensionTempFolder(this.#agentDir);
    return join(this.#base(scope), "git");
  }

  #temporaryDirectory(prefix: string, suffix?: string): string {
    const root = this.#managed(getExtensionTempFolder(this.#agentDir), prefix);
    const identity = createHash("sha256").update(`${prefix}-${suffix ?? ""}`).digest("hex").slice(0, 8);
    return this.#managed(root, identity, suffix ?? "");
  }

  #managed(root: string, ...parts: string[]): string {
    const boundary = resolve(root);
    const path = resolve(boundary, ...parts);
    if (path !== boundary && !path.startsWith(`${boundary}${sep}`)) throw new Error(`Package path escapes install root: ${path}`);
    return path;
  }

  #fileSourcePath(source: string, base: string): string | undefined {
    if (!source.startsWith("file:")) return undefined;
    try {
      return source.startsWith("file://")
        ? resolve(fileURLToPath(new URL(source)))
        : resolve(base, decodeURIComponent(source.slice("file:".length)));
    } catch {
      return undefined;
    }
  }

  #installedNpmPathInRoot(parsed: NpmSource, root: string): string {
    const direct = this.#managed(root, "node_modules", parsed.name);
    if (existsSync(direct) || parsed.filePath === undefined) return direct;
    try {
      const lockPath = join(root, "package-lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
        packages?: Record<string, { resolved?: string }>;
      };
      for (const [entry, metadata] of Object.entries(lock.packages ?? {})) {
        if (!entry.startsWith("node_modules/") || metadata.resolved === undefined) continue;
        const resolvedPath = this.#fileSourcePath(metadata.resolved, dirname(lockPath));
        if (resolvedPath !== undefined && canonicalizePath(resolvedPath) === parsed.filePath) {
          return this.#managed(root, entry);
        }
      }
    } catch {
      // Fall through when the package manager has not produced a usable lock entry.
    }
    return direct;
  }

  #installedPath(parsed: ParsedSource, scope: PackageScope): string {
    if (parsed.type === "local") return this.#resolvePath(parsed.path, this.#base(scope));
    if (parsed.type === "npm") {
      const managed = this.#installedNpmPathInRoot(parsed, this.#npmRoot(scope));
      if (scope !== "user" || existsSync(managed)) return managed;
      const legacy = this.#legacyGlobalNpmPath(parsed.name);
      return legacy !== undefined && existsSync(legacy) ? legacy : managed;
    }
    const identity = createHash("sha256").update(gitRepositoryIdentity(parsed.repo)).digest("hex");
    if (scope === "temporary") return this.#temporaryDirectory("git", identity);
    return this.#managed(this.#gitRoot(scope), "repositories", identity);
  }

  getInstalledPath(source: string, scope: "user" | "project"): string | undefined {
    const path = this.#installedPath(this.#parse(source), scope);
    return existsSync(path) ? path : undefined;
  }

  #npmCommand(): [string, ...string[]] {
    const configured = this.#settings.getNpmCommand();
    if (configured === undefined || configured.length === 0) return defaultNpmCommand();
    if (configured[0] === undefined || configured[0].length === 0) {
      throw new Error("Invalid npmCommand: first array entry must be a non-empty command");
    }
    return configured as [string, ...string[]];
  }

  #packageManagerName(): string {
    const command = this.#npmCommand();
    if (basename(command[1] ?? "").toLowerCase() === "npm-cli.js") return "npm";
    const separator = command.lastIndexOf("--");
    const executable = command[separator >= 0 ? separator + 1 : 0] ?? command[0];
    return basename(executable).replace(/\.(?:cmd|exe)$/iu, "").toLowerCase();
  }

  #npmLifecycleArguments(allowScripts: boolean): string[] {
    if (this.#packageManagerName() === "bun") return allowScripts ? [] : ["--ignore-scripts"];
    if (this.#packageManagerName() === "pnpm") {
      return [
        `--ignore-scripts=${allowScripts ? "false" : "true"}`,
        `--config.bin-links=${allowScripts ? "true" : "false"}`,
      ];
    }
    return [
      `--ignore-scripts=${allowScripts ? "false" : "true"}`,
      `--bin-links=${allowScripts ? "true" : "false"}`,
    ];
  }

  #npmInstallArguments(specs: string[], root: string, allowScripts = false): string[] {
    if (this.#packageManagerName() === "bun") {
      return ["install", ...specs, "--cwd", root, "--omit=peer", ...this.#npmLifecycleArguments(allowScripts)];
    }
    if (this.#packageManagerName() === "pnpm") {
      return [
        "install",
        ...specs,
        "--prefix",
        root,
        ...this.#npmLifecycleArguments(allowScripts),
        "--config.auto-install-peers=false",
        "--config.strict-peer-dependencies=false",
        "--config.strict-dep-builds=false",
      ];
    }
    return [
      "install",
      ...specs,
      "--prefix",
      root,
      "--legacy-peer-deps",
      ...this.#npmLifecycleArguments(allowScripts),
    ];
  }

  #npmLifecycleEnvironment(allowScripts: boolean): NodeJS.ProcessEnv {
    return {
      npm_config_ignore_scripts: allowScripts ? "false" : "true",
      npm_config_bin_links: allowScripts ? "true" : "false",
    };
  }

  #legacyGlobalNpmPath(packageName: string): string | undefined {
    const [command, ...prefix] = this.#npmCommand();
    try {
      if (this.#packageManagerName() === "pnpm") {
        const listing = JSON.parse(this.#runSync(command, [...prefix, "list", "-g", "--depth", "0", "--json"])) as Array<{
          dependencies?: Record<string, { path?: string }>;
        }>;
        for (const entry of listing) {
          const path = entry.dependencies?.[packageName]?.path;
          if (path !== undefined) return path;
        }
      }
      if (this.#packageManagerName() === "bun") {
        const binaryDirectory = this.#runSync(command, [...prefix, "pm", "bin", "-g"]);
        return join(dirname(binaryDirectory), "install", "global", "node_modules", packageName);
      }
      const commandIdentity = [command, ...prefix].join("\0");
      if (this.#globalNpmRoot === undefined || this.#globalNpmRootCommand !== commandIdentity) {
        this.#globalNpmRoot = this.#runSync(command, [...prefix, "root", "-g"]);
        this.#globalNpmRootCommand = commandIdentity;
      }
      return join(this.#globalNpmRoot, packageName);
    } catch {
      return undefined;
    }
  }

  #runSync(command: string, argumentsValue: string[]): string {
    const result = spawnSync(command, argumentsValue, { cwd: this.#cwd, env: subprocessEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(`${command} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
    }
    return String(result.stdout || result.stderr).trim();
  }

  async #run(
    command: string,
    argumentsValue: string[],
    cwd = this.#cwd,
    timeoutMs?: number,
    environment?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ): Promise<string> {
    const activeSignal = signal ?? new AbortController().signal;
    const result = await runProcess({
      argv: [command, ...argumentsValue],
      cwd,
      env: subprocessEnvironment(environment) as Record<string, string>,
      inheritEnv: false,
      outputLimitBytes: GIT_COMMAND_OUTPUT_LIMIT_BYTES,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }, activeSignal);
    if (result.cancelled) throw activeSignal.reason ?? new DOMException("Aborted", "AbortError");
    if (result.timedOut) throw new Error(`${command} timed out after ${timeoutMs}ms`);
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim();
      throw new Error(`${command} failed with ${result.exitCode === null ? `signal ${result.signal}` : `code ${result.exitCode}`}: ${detail}`);
    }
    return result.stdout.toString("utf8").trim();
  }

  #ensureNpmRoot(root: string): void {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    markPathIgnoredByCloudSync(root);
    const packageJson = join(root, "package.json");
    if (!existsSync(packageJson)) writeFileSync(packageJson, JSON.stringify({ name: "rigyn-extensions", private: true }, null, 2));
    const gitignore = join(root, ".gitignore");
    if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n!.gitignore\n");
  }

  #installedNpmVersion(path: string): string | undefined {
    try {
      return (JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { version?: string }).version;
    } catch {
      return undefined;
    }
  }

  async #latestNpmVersion(spec: string, range?: string): Promise<string> {
    const [command, ...prefix] = this.#npmCommand();
    const output = await this.#run(command, [...prefix, "view", spec, "version", "--json"], this.#cwd, NETWORK_TIMEOUT_MS);
    if (output.trim() === "") throw new Error("Empty response from npm view");
    const parsed = JSON.parse(output) as unknown;
    if (typeof parsed === "string") return parsed;
    if (Array.isArray(parsed)) {
      const versions = parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
      const selected = range === undefined ? versions.sort(rcompare)[0] : maxSatisfying(versions, range) ?? undefined;
      if (selected !== undefined) return selected;
    }
    throw new Error("Unexpected response from npm view");
  }

  #managedNpmPath(source: NpmSource, scope: "user" | "project"): string {
    return this.#installedNpmPathInRoot(source, this.#npmRoot(scope));
  }

  async #shouldUpdateNpm(source: NpmSource, scope: "user" | "project"): Promise<boolean> {
    const installedPath = this.#managedNpmPath(source, scope);
    const installedVersion = this.#installedNpmVersion(installedPath);
    if (installedVersion === undefined) return true;
    try {
      const latestVersion = await this.#latestNpmVersion(source.version === undefined ? source.name : source.spec, source.range);
      return latestVersion !== installedVersion;
    } catch {
      return true;
    }
  }

  async #installNpmBatch(
    entries: Array<{ source: string; parsed: NpmSource }>,
    scope: "user" | "project",
    root = this.#npmRoot(scope),
    allowScripts = false,
    signal?: AbortSignal,
  ): Promise<void> {
    if (entries.length === 0) return;
    this.#ensureNpmRoot(root);
    const specs = entries.map(({ parsed }) => parsed.spec.startsWith("file:")
      ? parsed.spec
      : parsed.version === undefined ? `${parsed.name}@latest` : parsed.spec);
    const label = entries.length === 1 ? entries[0]?.source ?? `${scope} npm packages` : `${scope} npm packages`;
    await this.#withProgress("update", label, `Updating ${label}...`, async () => {
      const [command, ...prefix] = this.#npmCommand();
      await this.#run(
        command,
        [...prefix, ...this.#npmInstallArguments(specs, root, allowScripts)],
        this.#cwd,
        undefined,
        this.#npmLifecycleEnvironment(allowScripts),
        signal,
      );
    });
  }

  async #installGitDependencies(path: string, allowScripts = false, signal?: AbortSignal): Promise<void> {
    if (!existsSync(join(path, "package.json"))) return;
    const [command, ...prefix] = this.#npmCommand();
    const configured = this.#settings.getNpmCommand();
    const argumentsValue = configured === undefined || configured.length === 0 ? ["install", "--omit=dev"] : ["install"];
    const lifecycleArgs = this.#npmLifecycleArguments(allowScripts);
    await this.#run(
      command,
      [...prefix, ...argumentsValue, ...lifecycleArgs],
      path,
      undefined,
      this.#npmLifecycleEnvironment(allowScripts),
      signal,
    );
  }

  async #withGit<T>(
    source: GitSource,
    signal: AbortSignal | undefined,
    operation: (run: (argumentsValue: string[], timeoutMs?: number) => Promise<string>, template: string) => Promise<T>,
  ): Promise<T> {
    const commandRoot = mkdtempSync(join(getExtensionTempFolder(this.#agentDir), ".rigyn-git-command-"));
    const home = join(commandRoot, "home");
    const template = join(commandRoot, "template");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(template, { recursive: true, mode: 0o700 });
    const protocol: GitProtocol = gitRepositoryProtocol(source.repo);
    const activeSignal = signal ?? new AbortController().signal;
    const run = async (argumentsValue: string[], timeoutMs?: number): Promise<string> => await runGitCommand({
      argv: [...this.#gitCommand],
      arguments: argumentsValue,
      cwd: commandRoot,
      protocol,
      home,
      template,
      signal: activeSignal,
      sourceEnvironment: subprocessEnvironment(),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    try {
      return await operation(run, template);
    } finally {
      rmSync(commandRoot, { recursive: true, force: true });
    }
  }

  async #installGitAt(
    source: GitSource,
    path: string,
    allowScripts = false,
    signal?: AbortSignal,
  ): Promise<void> {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await this.#withGit(source, signal, async (run, template) => {
        await run([
          "clone",
          "--quiet",
          "--no-tags",
          "--no-recurse-submodules",
          "--no-checkout",
          "--template", template,
          "--config", `core.hooksPath=${template}`,
          "--config", "core.fsmonitor=false",
          "--config", "submodule.recurse=false",
          "--",
          source.repo,
          path,
        ]);
        let checkout = "HEAD";
        let expectedRevision: string | undefined;
        if (source.ref !== undefined) {
          const selected = await resolveGitRemoteRef(run, source.repo, source.ref, NETWORK_TIMEOUT_MS);
          expectedRevision = selected.revision;
          await run([
            "-C", path,
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-recurse-submodules",
            "--force",
            "--",
            "origin",
            selected.fetchRef,
          ]);
          checkout = "FETCH_HEAD";
        }
        await run([
          "-C", path,
          "checkout",
          "--quiet",
          "--no-recurse-submodules",
          "--detach",
          checkout,
        ]);
        const revision = (await run(["-C", path, "rev-parse", "--verify", "HEAD^{commit}"], NETWORK_TIMEOUT_MS)).toLowerCase();
        if (!GIT_REVISION.test(revision)) throw new Error("Git returned an invalid full commit ID");
        if (expectedRevision !== undefined && revision !== expectedRevision) {
          throw new Error(`Git ref changed while it was being installed: expected ${expectedRevision}, received ${revision}`);
        }
      });
      await this.#installGitDependencies(path, allowScripts, signal);
    } catch (cause) {
      rmSync(path, { recursive: true, force: true });
      throw cause;
    }
  }

  async #refreshTemporaryGit(source: GitSource, displaySource: string, value: PackageSource): Promise<void> {
    if (this.#isOffline()) return;
    try {
      await this.#withProgress("pull", displaySource, `Refreshing ${displaySource}...`, async () => {
        const staged = await this.#stageGitPackage(source, "temporary");
        try {
          await this.#activatePackage(displaySource, value, "temporary", source, staged.packagePath);
          staged.commit();
        }
        finally { staged.cleanup(); }
      });
    } catch {
      // Continue using the last complete temporary checkout if refresh fails.
    }
  }

  async #gitHasAvailableUpdate(source: GitSource, path: string): Promise<boolean> {
    try {
      return await this.#withGit(source, undefined, async (run) => {
        const local = await run(["-C", path, "rev-parse", "--verify", "HEAD^{commit}"], NETWORK_TIMEOUT_MS);
        if (source.ref === undefined) {
          const response = await run(["ls-remote", "--", source.repo, "HEAD"], NETWORK_TIMEOUT_MS);
          const revision = /^([0-9a-f]{40}|[0-9a-f]{64})\s+HEAD$/imu.exec(response)?.[1];
          if (revision === undefined) throw new Error("Failed to determine remote Git HEAD");
          return local.toLowerCase() !== revision.toLowerCase();
        }
        const selected = await resolveGitRemoteRef(run, source.repo, source.ref, NETWORK_TIMEOUT_MS);
        return local.toLowerCase() !== selected.revision;
      });
    } catch {
      return false;
    }
  }

  async #runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
    const results = new Array<T>(tasks.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < tasks.length) {
        const index = next++;
        const task = tasks[index];
        if (task !== undefined) results[index] = await task();
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), tasks.length) }, worker));
    return results;
  }

  async #installParsed(parsed: ParsedSource, scope: PackageScope): Promise<void> {
    if (parsed.type === "local") {
      const path = this.#installedPath(parsed, scope);
      if (!existsSync(path)) throw new Error(`Path does not exist: ${path}`);
      return;
    }
    if (parsed.type === "npm") {
      const root = this.#npmRoot(scope);
      this.#ensureNpmRoot(root);
      const [command, ...prefix] = this.#npmCommand();
      await this.#run(
        command,
        [...prefix, ...this.#npmInstallArguments([parsed.spec], root)],
        this.#cwd,
        undefined,
        this.#npmLifecycleEnvironment(false),
      );
      return;
    }
    const path = this.#installedPath(parsed, scope);
    if (existsSync(path)) return;
    if (scope !== "temporary") {
      const root = this.#gitRoot(scope);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const ignorePath = join(root, ".gitignore");
      if (!existsSync(ignorePath)) writeFileSync(ignorePath, "*\n!.gitignore\n");
    }
    await this.#installGitAt(parsed, path);
  }

  #stageContainer(scope: PackageScope): string {
    const base = scope === "temporary" ? getExtensionTempFolder(this.#agentDir) : this.#base(scope);
    mkdirSync(base, { recursive: true, mode: 0o700 });
    return mkdtempSync(join(base, PACKAGE_STAGE_PREFIX));
  }

  #commitDirectory(candidate: string, target: string, container: string): boolean {
    const backup = join(container, "previous");
    const hadPrevious = existsSync(target);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (hadPrevious) renameSync(target, backup);
    try {
      renameSync(candidate, target);
      return hadPrevious;
    } catch (cause) {
      if (!hadPrevious) throw cause;
      try {
        renameSync(backup, target);
      } catch (restoreError) {
        throw new PackageCommitRollbackError(
          [cause, restoreError],
          `Package commit failed; previous package remains in ${backup}`,
        );
      }
      throw cause;
    }
  }

  #stageNpmRoot(scope: "user" | "project"): StagedPackageInstall {
    const base = this.#base(scope);
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const candidateRoot = mkdtempSync(join(base, PACKAGE_STAGE_PREFIX));
    const backupRoot = `${candidateRoot}-previous`;
    const targetRoot = this.#npmRoot(scope);
    let preserveContainer = false;
    let committed = false;
    let hadPrevious = false;
    try {
      if (existsSync(targetRoot)) {
        rmSync(candidateRoot, { recursive: true, force: true });
        cpSync(targetRoot, candidateRoot, { recursive: true });
      }
      this.#ensureNpmRoot(candidateRoot);
      return {
        packagePath: candidateRoot,
        commit: () => {
          hadPrevious = existsSync(targetRoot);
          if (hadPrevious) renameSync(targetRoot, backupRoot);
          try {
            renameSync(candidateRoot, targetRoot);
            committed = true;
          } catch (cause) {
            if (!hadPrevious) throw cause;
            try {
              renameSync(backupRoot, targetRoot);
            } catch (restoreError) {
              preserveContainer = true;
              throw new PackageCommitRollbackError(
                [cause, restoreError],
                `Package commit failed; previous package remains in ${backupRoot}`,
              );
            }
            throw cause;
          }
        },
        rollback: () => {
          if (!committed) return;
          try {
            rmSync(targetRoot, { recursive: true, force: true });
            if (hadPrevious) renameSync(backupRoot, targetRoot);
            committed = false;
          } catch (cause) {
            preserveContainer = true;
            throw cause;
          }
        },
        cleanup: () => {
          if (preserveContainer) return;
          rmSync(candidateRoot, { recursive: true, force: true });
          rmSync(backupRoot, { recursive: true, force: true });
        },
      };
    } catch (cause) {
      rmSync(candidateRoot, { recursive: true, force: true });
      rmSync(backupRoot, { recursive: true, force: true });
      throw cause;
    }
  }

  async #stageGitPackage(
    parsed: GitSource,
    scope: PackageScope,
    allowScripts = false,
    signal?: AbortSignal,
  ): Promise<StagedPackageInstall> {
    const container = this.#stageContainer(scope);
    const candidate = join(container, "package");
    const target = this.#installedPath(parsed, scope);
    let preserveContainer = false;
    let committed = false;
    let hadPrevious = false;
    try {
      await this.#installGitAt(parsed, candidate, allowScripts, signal);
      return {
        packagePath: candidate,
        commit: () => {
          try {
            hadPrevious = this.#commitDirectory(candidate, target, container);
            committed = true;
          }
          catch (cause) {
            preserveContainer = cause instanceof PackageCommitRollbackError;
            throw cause;
          }
        },
        rollback: () => {
          if (!committed) return;
          try {
            rmSync(target, { recursive: true, force: true });
            if (hadPrevious) renameSync(join(container, "previous"), target);
            committed = false;
          } catch (cause) {
            preserveContainer = true;
            throw cause;
          }
        },
        cleanup: () => {
          if (!preserveContainer) rmSync(container, { recursive: true, force: true });
        },
      };
    } catch (cause) {
      rmSync(container, { recursive: true, force: true });
      throw cause;
    }
  }

  async #stageInstall(
    parsed: ParsedSource,
    scope: "user" | "project",
    allowScripts = false,
    signal?: AbortSignal,
  ): Promise<StagedPackageInstall> {
    if (parsed.type === "local") {
      const path = this.#resolvePath(parsed.path, this.#cwd);
      if (!existsSync(path)) throw new Error(`Path does not exist: ${path}`);
      return { packagePath: path, commit() {}, rollback() {}, cleanup() {} };
    }
    if (parsed.type === "git") return await this.#stageGitPackage(parsed, scope, allowScripts, signal);
    const staged = this.#stageNpmRoot(scope);
    try {
      const [command, ...prefix] = this.#npmCommand();
      await this.#run(
        command,
        [...prefix, ...this.#npmInstallArguments([parsed.spec], staged.packagePath, allowScripts)],
        this.#cwd,
        undefined,
        this.#npmLifecycleEnvironment(allowScripts),
        signal,
      );
      return {
        ...staged,
        packagePath: this.#installedNpmPathInRoot(parsed, staged.packagePath),
      };
    } catch (cause) {
      staged.cleanup();
      throw cause;
    }
  }

  #configuredValue(source: string, scope: "user" | "project"): PackageSource {
    const settings = scope === "project" ? this.#settings.getProjectSettings() : this.#settings.getGlobalSettings();
    const identity = this.#identity(source, scope);
    return (settings.packages ?? []).find((value) =>
      this.#identity(this.#sourceString(value), scope) === identity) ?? source;
  }

  async #activatePackage(
    source: string,
    value: PackageSource,
    scope: PackageScope,
    parsed: ParsedSource,
    packagePath: string,
    signal?: AbortSignal,
    required = false,
  ): Promise<void> {
    const resources = this.#candidateResources(value, source, scope, parsed, packagePath);
    if (resources.extensions.every((entry) => !entry.enabled)) return;
    if (this.#activateCandidate === undefined) {
      if (required) throw new Error(`Package candidate activation is unavailable for ${source}`);
      return;
    }
    signal?.throwIfAborted();
    const activationRoot = mkdtempSync(join(getExtensionTempFolder(this.#agentDir), PACKAGE_ACTIVATION_PREFIX));
    try {
      await this.#activateCandidate({
        source,
        scope,
        workspace: this.#cwd,
        projectTrusted: this.#settings.isProjectTrusted(),
        resources,
        dataRoot: join(activationRoot, "data"),
        ...(signal === undefined ? {} : { signal }),
      });
      signal?.throwIfAborted();
    } finally {
      rmSync(activationRoot, { recursive: true, force: true });
    }
  }

  async install(source: string, options?: PackageInstallOptions): Promise<void> {
    if (options?.allowScripts !== undefined && typeof options.allowScripts !== "boolean") {
      throw new TypeError("allowScripts must be a boolean");
    }
    const allowScripts = options?.allowScripts === true;
    const scope = this.#scope(options?.local);
    if (scope === "project") this.#assertProject();
    const parsed = this.#parse(source);
    await this.#withProgress("install", source, `Installing ${source}...`, async () => {
      options?.signal?.throwIfAborted();
      const staged = await this.#stageInstall(parsed, scope, allowScripts, options?.signal);
      try {
        await this.#activatePackage(
          source,
          this.#configuredValue(source, scope),
          scope,
          parsed,
          staged.packagePath,
          options?.signal,
        );
        options?.signal?.throwIfAborted();
        staged.commit();
      } finally {
        staged.cleanup();
      }
    });
  }

  async installAndPersist(source: string, options?: PackageInstallOptions): Promise<void> {
    await this.install(source, options);
    this.addSourceToSettings(source, options);
  }

  async remove(source: string, options?: { local?: boolean }): Promise<void> {
    const scope = this.#scope(options?.local);
    if (scope === "project") this.#assertProject();
    const parsed = this.#parse(source);
    await this.#withProgress("remove", source, `Removing ${source}...`, async () => {
      if (parsed.type === "local") return;
      if (parsed.type === "git") {
        const installedPath = this.#installedPath(parsed, scope);
        rmSync(installedPath, { recursive: true, force: true });
        const root = resolve(this.#gitRoot(scope));
        let current = dirname(installedPath);
        while (current !== root && current.startsWith(`${root}${sep}`)) {
          if (!existsSync(current) || readdirSync(current).length === 0) {
            rmSync(current, { recursive: true, force: true });
            current = dirname(current);
            continue;
          }
          break;
        }
        return;
      }
      const root = this.#npmRoot(scope);
      if (!existsSync(root)) return;
      let packageName = parsed.name;
      try {
        const installed = this.#installedNpmPathInRoot(parsed, root);
        const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as { name?: string };
        if (typeof manifest.name === "string" && NPM_PACKAGE_NAME.test(manifest.name)) packageName = manifest.name;
      } catch {
        // The configured name remains the best uninstall argument for ordinary packages.
      }
      const [command, ...prefix] = this.#npmCommand();
      const argumentsValue = this.#packageManagerName() === "bun"
        ? ["uninstall", packageName, "--cwd", root]
        : ["uninstall", packageName, "--prefix", root, ...(this.#packageManagerName() === "pnpm" ? [] : ["--legacy-peer-deps"] )];
      await this.#run(command, [...prefix, ...argumentsValue]);
    });
  }

  async removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean> {
    await this.remove(source, options);
    return this.removeSourceFromSettings(source, options);
  }

  #configured(): Array<{ value: PackageSource; source: string; scope: "user" | "project" }> {
    const project = (this.#settings.getProjectSettings().packages ?? []).map((value) => ({ value, source: this.#sourceString(value), scope: "project" as const }));
    const user = (this.#settings.getGlobalSettings().packages ?? []).map((value) => ({ value, source: this.#sourceString(value), scope: "user" as const }));
    const seen = new Map<string, number>();
    const result: Array<{ value: PackageSource; source: string; scope: "user" | "project" }> = [];
    for (const entry of [...project, ...user]) {
      const identity = this.#identity(entry.source, entry.scope);
      const priorIndex = seen.get(identity);
      if (priorIndex === undefined) {
        seen.set(identity, result.length);
        result.push(entry);
        continue;
      }
      const prior = result[priorIndex];
      if (prior?.scope === "project" && entry.scope === "user") {
        if (typeof prior.value !== "string" && prior.value.autoload === false) result.push(entry);
      } else if (entry.scope === "project") {
        result[priorIndex] = entry;
      }
    }
    return result;
  }

  #configuredForUpdate(): Array<{ value: PackageSource; source: string; scope: "user" | "project" }> {
    return [
      ...(this.#settings.getGlobalSettings().packages ?? []).map((value) => ({ value, source: this.#sourceString(value), scope: "user" as const })),
      ...(this.#settings.getProjectSettings().packages ?? []).map((value) => ({ value, source: this.#sourceString(value), scope: "project" as const })),
    ];
  }

  #noMatchingPackageMessage(source: string, configured: Array<{ source: string }>): string {
    const input = source.trim();
    const suggestions = new Set<string>();
    for (const entry of configured) {
      const parsed = this.#parse(entry.source);
      if (parsed.type === "npm" && (input === parsed.name || input === parsed.spec)) suggestions.add(entry.source);
      if (parsed.type === "git") {
        const shorthand = `${parsed.host}/${parsed.path}`;
        if (input === shorthand || (parsed.ref !== undefined && input === `${shorthand}@${parsed.ref}`)) suggestions.add(entry.source);
      }
    }
    const suggestion = suggestions.values().next().value;
    return suggestion === undefined
      ? `No matching package found for ${source}`
      : `No matching package found for ${source}. Did you mean ${suggestion}?`;
  }

  #resolutionConfigured(): Array<{
    value: PackageSource;
    source: string;
    scope: "user" | "project";
    installSource: string;
    installScope: "user" | "project";
  }> {
    const project = (this.#settings.getProjectSettings().packages ?? []).map((value) => ({
      value,
      source: this.#sourceString(value),
      scope: "project" as const,
    }));
    const user = (this.#settings.getGlobalSettings().packages ?? []).map((value) => ({
      value,
      source: this.#sourceString(value),
      scope: "user" as const,
    }));
    const seen = new Map<string, number>();
    const result: Array<{
      value: PackageSource;
      source: string;
      scope: "user" | "project";
      installSource: string;
      installScope: "user" | "project";
    }> = [];
    for (const entry of [...project, ...user]) {
      const identity = this.#identity(entry.source, entry.scope);
      const priorIndex = seen.get(identity);
      if (priorIndex !== undefined) {
        const prior = result[priorIndex];
        const delta = prior?.scope === "project" && typeof prior.value !== "string" && prior.value.autoload === false;
        if (entry.scope === "user" && delta) {
          result.push({ ...entry, installSource: entry.source, installScope: entry.scope });
        } else if (entry.scope === "project") {
          result[priorIndex] = {
            ...entry,
            installSource: entry.source,
            installScope: entry.scope,
          };
        }
        continue;
      }
      seen.set(identity, result.length);
      if (entry.scope === "project" && typeof entry.value !== "string" && entry.value.autoload === false) {
        const base = user.find((candidate) => this.#identity(candidate.source, "user") === identity);
        if (base !== undefined) {
          result.push({ ...entry, installSource: base.source, installScope: "user" });
          continue;
        }
      }
      result.push({ ...entry, installSource: entry.source, installScope: entry.scope });
    }
    return result;
  }

  async #stageNpmBatchUpdate(
    entries: Array<{ value: PackageSource; source: string; parsed: NpmSource }>,
    scope: "user" | "project",
    signal?: AbortSignal,
    allowScripts = false,
  ): Promise<StagedPackageInstall> {
    const staged = this.#stageNpmRoot(scope);
    try {
      await this.#installNpmBatch(entries, scope, staged.packagePath, allowScripts, signal);
      for (const entry of entries) {
        await this.#activatePackage(
          entry.source,
          entry.value,
          scope,
          entry.parsed,
          this.#installedNpmPathInRoot(entry.parsed, staged.packagePath),
          signal,
        );
      }
      signal?.throwIfAborted();
      return staged;
    } catch (cause) {
      staged.cleanup();
      throw cause;
    }
  }

  async #stageGitPackageUpdate(
    entry: { value: PackageSource; source: string; scope: "user" | "project"; parsed: GitSource },
    signal?: AbortSignal,
    allowScripts = false,
  ): Promise<StagedPackageInstall> {
    let prepared: StagedPackageInstall | undefined;
    await this.#withProgress("update", entry.source, `Updating ${entry.source}...`, async () => {
      signal?.throwIfAborted();
      const staged = await this.#stageGitPackage(entry.parsed, entry.scope, allowScripts, signal);
      try {
        await this.#activatePackage(
          entry.source,
          entry.value,
          entry.scope,
          entry.parsed,
          staged.packagePath,
          signal,
        );
        signal?.throwIfAborted();
        prepared = staged;
      } catch (cause) {
        staged.cleanup();
        throw cause;
      }
    });
    if (prepared === undefined) throw new Error(`Failed to stage ${entry.source}`);
    return prepared;
  }

  async update(source?: string, options?: PackageUpdateOptions): Promise<void> {
    if (options?.allowScripts !== undefined && typeof options.allowScripts !== "boolean") {
      throw new TypeError("allowScripts must be a boolean");
    }
    const allowScripts = options?.allowScripts === true;
    const configured = this.#configuredForUpdate();
    const identity = source === undefined ? undefined : this.#identity(source);
    const selected = configured.filter((entry) => identity === undefined || this.#identity(entry.source, entry.scope) === identity);
    if (source !== undefined && selected.length === 0) throw new Error(this.#noMatchingPackageMessage(source, configured));
    if (this.#isOffline() || selected.length === 0) return;
    options?.signal?.throwIfAborted();

    const npm = selected.flatMap((entry) => {
      const parsed = this.#parse(entry.source);
      return parsed.type === "npm" && !parsed.pinned ? [{ ...entry, parsed }] : [];
    });
    const git = selected.flatMap((entry) => {
      const parsed = this.#parse(entry.source);
      return parsed.type === "git" ? [{ ...entry, parsed }] : [];
    });
    const checked = await this.#runWithConcurrency(
      npm.map((entry) => async () => ({ entry, update: await this.#shouldUpdateNpm(entry.parsed, entry.scope) })),
      UPDATE_CHECK_CONCURRENCY,
    );
    const user = checked.filter(({ entry, update }) => update && entry.scope === "user").map(({ entry }) => entry);
    const project = checked.filter(({ entry, update }) => update && entry.scope === "project").map(({ entry }) => entry);
    const staged: StagedPackageInstall[] = [];
    const committed: StagedPackageInstall[] = [];
    try {
      if (user.length > 0) staged.push(await this.#stageNpmBatchUpdate(user, "user", options?.signal, allowScripts));
      if (project.length > 0) staged.push(await this.#stageNpmBatchUpdate(project, "project", options?.signal, allowScripts));
      for (const entry of git) {
        staged.push(await this.#stageGitPackageUpdate(entry, options?.signal, allowScripts));
      }
      options?.signal?.throwIfAborted();
      for (const candidate of staged) {
        candidate.commit();
        committed.push(candidate);
      }
    } catch (cause) {
      const rollbackErrors: unknown[] = [];
      for (const candidate of committed.reverse()) {
        try { candidate.rollback(); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (rollbackErrors.length > 0) {
        throw new PackageCommitRollbackError([cause, ...rollbackErrors], "Package update failed and rollback was incomplete");
      }
      throw cause;
    } finally {
      for (const candidate of staged) candidate.cleanup();
    }
  }

  async checkForAvailableUpdates(): Promise<PackageUpdate[]> {
    if (this.#isOffline()) return [];
    const checks = this.#configured().map((entry) => async (): Promise<PackageUpdate | undefined> => {
      const parsed = this.#parse(entry.source);
      const installed = this.#installedPath(parsed, entry.scope);
      if (!existsSync(installed) || parsed.type === "local" || parsed.pinned) return undefined;
      if (parsed.type === "npm") {
        const current = this.#installedNpmVersion(installed);
        if (current === undefined) return undefined;
        try {
          const latest = await this.#latestNpmVersion(parsed.version === undefined ? parsed.name : parsed.spec, parsed.range);
          return latest === current ? undefined : { source: entry.source, displayName: parsed.name, type: "npm", scope: entry.scope };
        } catch {
          return undefined;
        }
      }
      return await this.#gitHasAvailableUpdate(parsed, installed)
        ? { source: entry.source, displayName: `${parsed.host}/${parsed.path}`, type: "git", scope: entry.scope }
        : undefined;
    });
    const results = await this.#runWithConcurrency(checks, UPDATE_CHECK_CONCURRENCY);
    return results.filter((entry): entry is PackageUpdate => entry !== undefined);
  }

  listConfiguredPackages(): ConfiguredPackage[] {
    return [
      ...(this.#settings.getGlobalSettings().packages ?? []).map((value) => ({ value, scope: "user" as const })),
      ...(this.#settings.getProjectSettings().packages ?? []).map((value) => ({ value, scope: "project" as const })),
    ].map(({ value, scope }) => {
      const source = this.#sourceString(value);
      const installedPath = this.getInstalledPath(source, scope);
      return { source, scope, filtered: typeof value !== "string", ...(installedPath === undefined ? {} : { installedPath }) };
    });
  }

  #add(target: ResourceMap, path: string, metadata: PathMetadata, enabled: boolean): void {
    if (!target.has(path)) target.set(path, { metadata, enabled });
  }

  #collectFromPaths(paths: string[], type: ResourceType): string[] {
    return paths.flatMap((path) => {
      if (!existsSync(path)) return [];
      try {
        return statSync(path).isDirectory() ? resourceFiles(path, type) : statSync(path).isFile() ? [path] : [];
      } catch {
        return [];
      }
    });
  }

  #collectPackage(root: string, accumulator: ResourceAccumulator, filter: PackageFilter | undefined, metadata: PathMetadata): boolean {
    assertPackageHostCompatibility(root);
    const manifest = readManifest(root, filter?.manifest === "legacy");
    const metadataFor = (path: string): PathMetadata => {
      const declaredResources = manifest?.declarations?.get(resolve(path));
      return declaredResources === undefined ? metadata : { ...metadata, declaredResources };
    };
    let found = manifest !== undefined || filter !== undefined;
    for (const type of RESOURCE_TYPES) {
      const configured = manifest?.[type];
      const conventionRoot = join(root, type);
      const requested = filter?.[type];
      const useManifest = configured !== undefined && (
        filter === undefined
        || configured.length > 0
        || requested === undefined
      );
      const sources = useManifest
        ? manifestResourceFiles(root, configured, type)
        : manifest === undefined || filter !== undefined
          ? resourceFiles(conventionRoot, type)
          : [];
      if (sources.length > 0 || configured !== undefined || existsSync(conventionRoot)) found = true;
      const packagePatterns = configured?.filter((value) => /^[!+-]/u.test(value)) ?? [];
      const packageEnabled = applyPatterns(sources, packagePatterns, root);
      const eligible = sources.filter((path) => packageEnabled.get(path) ?? true);
      if (filter?.autoload === false) {
        if (requested === undefined || requested.length === 0) continue;
        for (const [path, enabled] of applyDeltaPatterns(eligible, requested, root)) {
          this.#add(accumulator[type], path, metadataFor(path), enabled);
        }
        continue;
      }
      if (filter === undefined || requested === undefined) {
        for (const path of eligible) this.#add(accumulator[type], path, metadataFor(path), true);
        continue;
      }
      const userEnabled = requested === undefined
        ? packageEnabled
        : applyPatterns(eligible, requested, root, requested.length === 0);
      for (const path of eligible) {
        this.#add(accumulator[type], path, metadataFor(path), userEnabled.get(path) ?? true);
      }
    }
    return found;
  }

  #collectResolvedPackage(
    value: PackageSource,
    source: string,
    scope: PackageScope,
    parsed: ParsedSource,
    path: string,
    accumulator: ResourceAccumulator,
  ): void {
    const metadata: PathMetadata = { source, scope, origin: "package", baseDir: path };
    const filter = typeof value === "string" ? undefined : value;
    if (parsed.type === "local" && statSync(path).isFile()) {
      this.#add(accumulator.extensions, path, { ...metadata, baseDir: dirname(path) }, true);
    } else if (!this.#collectPackage(path, accumulator, filter, metadata) && parsed.type === "local") {
      const discovered = autoExtensions(path);
      if (discovered.length === 0) this.#add(accumulator.extensions, path, metadata, true);
      else {
        for (const extension of discovered) {
          this.#add(accumulator.extensions, extension, { ...metadata, baseDir: path }, true);
        }
      }
    }
  }

  #candidateResources(
    value: PackageSource,
    source: string,
    scope: PackageScope,
    parsed: ParsedSource,
    path: string,
  ): ResolvedPaths {
    const accumulator = createAccumulator();
    this.#collectResolvedPackage(value, source, scope, parsed, path, accumulator);
    const resolved = this.#finish(accumulator);
    return {
      ...resolved,
      extensions: resolved.extensions.filter((entry) => {
        try { return statSync(entry.path).isFile(); }
        catch { return false; }
      }),
    };
  }

  async #resolvePackages(
    entries: Array<{
      value: PackageSource;
      source: string;
      scope: PackageScope;
      installSource?: string;
      installScope?: PackageScope;
    }>,
    accumulator: ResourceAccumulator,
    onMissing?: (source: string) => Promise<MissingSourceAction>,
  ): Promise<void> {
    for (const entry of entries) {
      const installedSource = entry.installSource ?? entry.source;
      const installedScope = entry.installScope ?? entry.scope;
      const parsed = this.#parse(installedSource);
      let path = this.#installedPath(parsed, installedScope);
      let requiresInstall = !existsSync(path);
      if (!requiresInstall && parsed.type === "npm" && parsed.range !== undefined) {
        try {
          const installedVersion = (JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { version?: string }).version;
          requiresInstall = installedVersion === undefined || !satisfies(installedVersion, parsed.range);
        } catch {
          requiresInstall = true;
        }
      }
      if (requiresInstall) {
        if (parsed.type === "local" || this.#isOffline()) continue;
        const action = onMissing === undefined ? "install" : await onMissing(installedSource);
        if (action === "skip") continue;
        if (action === "error") throw new Error(`Missing source: ${installedSource}`);
        if (installedScope === "temporary") {
          if (parsed.type === "git") {
            const staged = await this.#stageGitPackage(parsed, installedScope);
            try {
              await this.#activatePackage(entry.source, entry.value, "temporary", parsed, staged.packagePath);
              staged.commit();
            } finally {
              staged.cleanup();
            }
          } else {
            await this.#installParsed(parsed, installedScope);
          }
        } else {
          const staged = await this.#stageInstall(parsed, installedScope);
          const activationScope = entry.scope === "temporary" ? installedScope : entry.scope;
          try {
            await this.#activatePackage(
              entry.source,
              entry.value,
              activationScope,
              parsed,
              staged.packagePath,
              undefined,
              true,
            );
            staged.commit();
          } finally {
            staged.cleanup();
          }
        }
        path = this.#installedPath(parsed, installedScope);
      } else if (parsed.type === "git" && installedScope === "temporary" && !parsed.pinned && !this.#isOffline()) {
        await this.#refreshTemporaryGit(parsed, entry.source, entry.value);
      }
      this.#collectResolvedPackage(entry.value, entry.source, entry.scope, parsed, path, accumulator);
    }
  }

  #localResources(
    entries: string[],
    type: ResourceType,
    accumulator: ResourceAccumulator,
    scope: "user" | "project",
  ): void {
    const base = this.#base(scope);
    const plain = entries.filter((value) => !hasPattern(value));
    const patterns = entries.filter(hasPattern);
    const paths = this.#collectFromPaths(plain.map((value) => this.#resolvePath(value, base)), type);
    const enabled = applyPatterns(paths, patterns, base);
    for (const path of paths) this.#add(accumulator[type], path, { source: "local", scope, origin: "top-level", baseDir: base }, enabled.get(path) ?? true);
  }

  #autoResources(accumulator: ResourceAccumulator, scope: "user" | "project"): void {
    if (scope === "project" && !this.#settings.isProjectTrusted()) return;
    const base = this.#base(scope);
    const settings = scope === "project" ? this.#settings.getProjectSettings() : this.#settings.getGlobalSettings();
    const extensionRoot = join(base, "extensions");
    for (const entry of directoryEntries(extensionRoot)) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const packageRoot = join(extensionRoot, entry.name);
      if (entryKind(packageRoot, entry) !== "directory" || readManifest(packageRoot) === undefined) continue;
      this.#collectPackage(packageRoot, accumulator, undefined, {
        source: "auto",
        scope,
        origin: "package",
        baseDir: packageRoot,
      });
    }
    for (const type of RESOURCE_TYPES) {
      const directory = join(base, type);
      const paths = autoResourceFiles(directory, type);
      const patterns = settings[type] ?? [];
      const enabled = applyPatterns(paths, patterns.filter((value) => /^[!+-]/u.test(value)), base);
      for (const path of paths) this.#add(accumulator[type], path, { source: "auto", scope, origin: "top-level", baseDir: base }, enabled.get(path) ?? true);
    }
    if (scope === "project") {
      const globalSkills = canonicalizePath(join(homeDirectory(), ".agents", "skills"));
      for (const directory of ancestorAgentSkillDirectories(this.#cwd)) {
        if (canonicalizePath(directory) === globalSkills) continue;
        const metadataBase = dirname(directory);
        const paths = skillEntries(directory, false);
        const enabled = applyPatterns(
          paths,
          (settings.skills ?? []).filter((value) => /^[!+-]/u.test(value)),
          metadataBase,
        );
        for (const path of paths) {
          this.#add(
            accumulator.skills,
            path,
            { source: "auto", scope, origin: "top-level", baseDir: metadataBase },
            enabled.get(path) ?? true,
          );
        }
      }
    }
    if (scope === "user") {
      const metadataBase = join(homeDirectory(), ".agents");
      const skills = skillEntries(join(metadataBase, "skills"), false);
      const enabled = applyPatterns(
        skills,
        (settings.skills ?? []).filter((value) => /^[!+-]/u.test(value)),
        metadataBase,
      );
      for (const path of skills) {
        this.#add(
          accumulator.skills,
          path,
          { source: "auto", scope, origin: "top-level", baseDir: metadataBase },
          enabled.get(path) ?? true,
        );
      }
    }
  }

  #finish(accumulator: ResourceAccumulator): ResolvedPaths {
    const output = {} as ResolvedPaths;
    for (const type of RESOURCE_TYPES) {
      const seen = new Set<string>();
      const values = [...accumulator[type]].map(([path, value]) => ({ path, ...value })).sort((left, right) => precedence(left.metadata) - precedence(right.metadata));
      output[type] = values.filter((value) => {
        const path = canonicalizePath(value.path);
        if (seen.has(path)) return false;
        seen.add(path);
        return true;
      });
    }
    return output;
  }

  async resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths> {
    const accumulator = createAccumulator();
    await this.#resolvePackages(this.#resolutionConfigured(), accumulator, onMissing);
    const global = this.#settings.getGlobalSettings();
    const project = this.#settings.getProjectSettings();
    for (const type of RESOURCE_TYPES) {
      if (this.#settings.isProjectTrusted()) {
        this.#localResources(project[type] ?? [], type, accumulator, "project");
      }
      this.#localResources(global[type] ?? [], type, accumulator, "user");
    }
    if (this.#settings.isProjectTrusted()) this.#autoResources(accumulator, "project");
    this.#autoResources(accumulator, "user");
    return this.#finish(accumulator);
  }

  async resolveExtensionSources(sources: readonly PackageSource[], options?: { local?: boolean; temporary?: boolean }): Promise<ResolvedPaths> {
    const accumulator = createAccumulator();
    const scope: PackageScope = options?.temporary === true ? "temporary" : this.#scope(options?.local);
    await this.#resolvePackages(sources.map((value) => ({ value, source: this.#sourceString(value), scope })), accumulator);
    return this.#finish(accumulator);
  }

  #resolvePath(input: string, base: string): string {
    return resolvePath(input, base, { homeDir: homeDirectory(), trim: true });
  }
}
