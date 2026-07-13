import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import ignore from "ignore";
import { Minimatch } from "minimatch";

import { sensitiveWorkspacePath } from "./sensitive-path.js";
import { readFileBounded } from "./paths.js";

const DEFAULT_LIMIT = 5_000;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_IGNORE_FILE_BYTES = 1024 * 1024;
const MAX_PATTERN_BYTES = 16 * 1024;
const MAX_VISITED_ENTRIES = 100_000;

export interface WorkspaceWalkOptions {
  /** Workspace-relative path to scan. A directly requested safe regular file is returned even when ignored. */
  path?: string;
  limit?: number;
  maxDepth?: number;
  /** Glob matched against basenames, or against workspace-relative paths when it contains a slash. */
  pattern?: string;
  includeDirectories?: boolean;
  includeHidden?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface WorkspaceWalkEntry {
  absolutePath: string;
  depth: number;
  kind: "directory" | "file";
  path: string;
}

export interface WorkspaceWalkResult {
  entries: WorkspaceWalkEntry[];
  truncated: boolean;
  visitedEntries: number;
}

interface IgnoreScope {
  base: string;
  matcher: ReturnType<typeof ignore>;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return selected;
}

function portablePath(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function inside(root: string, target: string): boolean {
  const local = relative(root, target);
  return local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}

function validLocalPath(value: string): boolean {
  return value !== "" && value !== ".." && !value.startsWith("../") && !/[\u0000\r\n]/u.test(value);
}

function hiddenPath(value: string): boolean {
  return value.split("/").some((part) => part.startsWith(".") && part !== "." && part !== "..");
}

function protectedPath(value: string): boolean {
  const parts = value.split("/").filter((part) => part !== "").map((part) => part.toLocaleLowerCase());
  return parts.includes(".git") || parts.includes("node_modules") ||
    parts.some((part) => [".rigyn", ".ssh", ".aws"].includes(part)) ||
    sensitiveWorkspacePath(value);
}

function compilePattern(pattern: string | undefined): Minimatch | undefined {
  if (pattern === undefined) return undefined;
  if (typeof pattern !== "string" || Buffer.byteLength(pattern, "utf8") > MAX_PATTERN_BYTES) {
    throw new RangeError(`pattern must be a string no larger than ${MAX_PATTERN_BYTES} UTF-8 bytes`);
  }
  const normalized = pattern.replaceAll("\\", "/");
  try {
    return new Minimatch(normalized, {
      braceExpandMax: 1_024,
      dot: true,
      matchBase: !normalized.includes("/"),
      maxExtglobRecursion: 2,
      maxGlobstarRecursion: 64,
      nocomment: true,
      nonegate: true,
      optimizationLevel: 2,
      platform: "linux",
    });
  } catch (error) {
    throw new Error(`Invalid workspace file pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function ignoredBy(scopes: readonly IgnoreScope[], local: string, directory: boolean): boolean {
  let ignored = false;
  for (const scope of scopes) {
    const scoped = scope.base === "" ? local : local.slice(scope.base.length + 1);
    const result = scope.matcher.test(directory ? `${scoped}/` : scoped);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

async function loadIgnoreScopes(
  directory: string,
  base: string,
  check: () => void,
  markIncomplete: () => void,
): Promise<IgnoreScope[]> {
  const scopes: IgnoreScope[] = [];
  for (const name of [".gitignore", ".ignore"]) {
    check();
    const path = join(directory, name);
    try {
      const information = await lstat(path);
      if (!information.isFile() || information.isSymbolicLink()) continue;
      const contents = await readFileBounded(path, MAX_IGNORE_FILE_BYTES);
      check();
      if (contents.truncated) {
        throw new Error(`Workspace ignore file exceeds ${MAX_IGNORE_FILE_BYTES} bytes: ${base === "" ? name : `${base}/${name}`}`);
      }
      scopes.push({
        base,
        matcher: ignore({ ignorecase: process.platform === "win32" }).add(contents.data.toString("utf8")),
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        markIncomplete();
        continue;
      }
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  return scopes;
}

/**
 * Walks a workspace without Git, following hierarchical .gitignore and .ignore files.
 * Descendant symlinks are never traversed; an explicitly requested symlink is accepted
 * only when both its name and resolved target remain non-sensitive and inside the workspace.
 */
export async function walkWorkspace(
  workspace: string,
  options: WorkspaceWalkOptions = {},
): Promise<WorkspaceWalkResult> {
  const limit = boundedInteger(options.limit, DEFAULT_LIMIT, 1, MAX_VISITED_ENTRIES, "limit");
  const maxDepth = boundedInteger(options.maxDepth, DEFAULT_MAX_DEPTH, 0, DEFAULT_MAX_DEPTH, "maxDepth");
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 300_000, "timeoutMs");
  const pattern = compilePattern(options.pattern);
  const includeDirectories = options.includeDirectories ?? false;
  const includeHidden = options.includeHidden ?? true;
  const deadline = Date.now() + timeoutMs;
  const check = (): void => {
    options.signal?.throwIfAborted();
    if (Date.now() > deadline) throw new Error(`Workspace scan timed out after ${timeoutMs}ms`);
  };

  check();
  const workspaceAbsolute = resolve(workspace);
  const root = await realpath(workspaceAbsolute);
  const requested = options.path ?? ".";
  if (requested.includes("\0")) throw new Error("Path contains a NUL byte");
  const lexicalTarget = isAbsolute(requested) ? resolve(requested) : resolve(workspaceAbsolute, requested);
  if (!inside(workspaceAbsolute, lexicalTarget)) throw new Error(`Path escapes workspace: ${requested}`);
  const lexicalLocal = portablePath(relative(workspaceAbsolute, lexicalTarget));
  const target = await realpath(lexicalTarget);
  if (!inside(root, target)) throw new Error(`Resolved path escapes workspace: ${requested}`);
  const localTarget = portablePath(relative(root, target));
  const targetInformation = await lstat(target);
  check();

  if (
    (lexicalLocal !== "" && (!validLocalPath(lexicalLocal) || protectedPath(lexicalLocal))) ||
    (localTarget !== "" && (!validLocalPath(localTarget) || protectedPath(localTarget)))
  ) {
    return { entries: [], truncated: false, visitedEntries: 0 };
  }

  if (targetInformation.isFile()) {
    const matched = pattern === undefined || pattern.match(localTarget);
    if (!matched || (!includeHidden && hiddenPath(localTarget))) {
      return { entries: [], truncated: false, visitedEntries: 1 };
    }
    return {
      entries: [{ absolutePath: target, depth: 0, kind: "file", path: localTarget }],
      truncated: false,
      visitedEntries: 1,
    };
  }
  if (!targetInformation.isDirectory()) throw new Error("Workspace scan path is not a regular file or directory");

  let truncated = false;
  const markIncomplete = (): void => { truncated = true; };
  let scopes = await loadIgnoreScopes(root, "", check, markIncomplete);
  if (localTarget !== "") {
    let cursor = root;
    let localCursor = "";
    for (const segment of localTarget.split("/")) {
      localCursor = localCursor === "" ? segment : `${localCursor}/${segment}`;
      if (protectedPath(localCursor) || ignoredBy(scopes, localCursor, true)) {
        return { entries: [], truncated: false, visitedEntries: 0 };
      }
      cursor = join(cursor, segment);
      scopes = [...scopes, ...await loadIgnoreScopes(cursor, localCursor, check, markIncomplete)];
    }
  }

  const entries: WorkspaceWalkEntry[] = [];
  let limitReached = false;
  let visitedEntries = 0;
  const add = (entry: WorkspaceWalkEntry): boolean => {
    if (entries.length >= limit) {
      truncated = true;
      limitReached = true;
      return false;
    }
    entries.push(entry);
    return true;
  };

  const visit = async (
    directory: string,
    localDirectory: string,
    depth: number,
    inheritedScopes: readonly IgnoreScope[],
  ): Promise<void> => {
    check();
    if (depth > maxDepth || limitReached) return;
    const ownScopes = localDirectory === localTarget
      ? inheritedScopes
      : [...inheritedScopes, ...await loadIgnoreScopes(directory, localDirectory, check, markIncomplete)];
    let handle;
    try {
      handle = await opendir(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EACCES", "EPERM", "ENOENT", "ENOTDIR"].includes(code ?? "")) {
        truncated = true;
        return;
      }
      throw error;
    }
    const directoryEntries = [];
    try {
      for await (const entry of handle) {
        check();
        visitedEntries += 1;
        if (visitedEntries > MAX_VISITED_ENTRIES) {
          throw new Error(`Workspace scan exceeded ${MAX_VISITED_ENTRIES} filesystem entries`);
        }
        directoryEntries.push(entry);
      }
    } finally {
      try {
        await handle.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error;
      }
    }
    directoryEntries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of directoryEntries) {
      check();
      if (limitReached) return;
      const local = localDirectory === "" ? portablePath(entry.name) : `${localDirectory}/${portablePath(entry.name)}`;
      if (!validLocalPath(local) || protectedPath(local) || entry.isSymbolicLink()) continue;
      const hidden = entry.name.startsWith(".");
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (ignoredBy(ownScopes, local, true) || (!includeHidden && hidden)) continue;
        if (includeDirectories && !add({ absolutePath, depth, kind: "directory", path: local })) return;
        if (depth < maxDepth) await visit(absolutePath, local, depth + 1, ownScopes);
      } else if (entry.isFile()) {
        if (
          ignoredBy(ownScopes, local, false) || (!includeHidden && hidden) ||
          (pattern !== undefined && !pattern.match(local))
        ) continue;
        if (!add({ absolutePath, depth, kind: "file", path: local })) return;
      }
    }
  };

  await visit(target, localTarget, 0, scopes);
  entries.sort((left, right) => comparePaths(left.path, right.path));
  return { entries, truncated, visitedEntries };
}

export interface WorkspaceFileScanOptions {
  limit?: number;
  maxDepth?: number;
  pattern?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Returns a bounded, deterministic list of regular workspace files. */
export async function scanWorkspaceFiles(
  workspace: string,
  options: WorkspaceFileScanOptions = {},
): Promise<string[]> {
  const result = await walkWorkspace(workspace, options);
  return result.entries.map((entry) => entry.path);
}
