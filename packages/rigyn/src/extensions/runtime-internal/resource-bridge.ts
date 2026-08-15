import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { minimatch } from "minimatch";

import { assertCanonicalDirectoryCreationPath } from "../../config/canonical-path.js";
import { sha256 } from "../../tools/hash.js";
import type { ExtensionRuntimeEntry } from "../types.js";
import type { RuntimeExtensionDataPaths } from "../runtime.js";

export function pathInside(root: string, target: string): boolean {
  const local = relative(root, target);
  return local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}

export function runtimeResourcePatternMatch(pathValue: string, packageRoot: string, pattern: string): boolean {
  const target = isAbsolute(pathValue) ? resolve(pathValue) : resolve(packageRoot, pathValue);
  const name = basename(target);
  const portable = (value: string): string => value.split(sep).join("/");
  const candidates = [portable(relative(packageRoot, target)), portable(target), name];
  if (name === "SKILL.md") {
    const directory = dirname(target);
    candidates.push(portable(relative(packageRoot, directory)), portable(directory), basename(directory));
  }
  const normalized = portable(pattern.replace(/^\.\//u, ""));
  return candidates.some((candidate) => minimatch(candidate, normalized, { nonegate: true, nocomment: true }));
}

export function extensionDataPaths(
  dataRoot: string,
  workspace: string,
  entry: ExtensionRuntimeEntry,
): RuntimeExtensionDataPaths {
  const extensionId = entry.extensionId;
  if (!/^[a-z][a-z0-9._-]{0,62}$/u.test(extensionId)) throw new Error("Extension ID is invalid");
  const sourcePath = entry.sourcePath;
  const resourceRoot = resolve(entry.resourceRoot ?? dirname(sourcePath));
  const canonicalSource = isAbsolute(sourcePath) ? resolve(sourcePath) : sourcePath;
  const relativeSource = isAbsolute(canonicalSource) && pathInside(resourceRoot, canonicalSource)
    ? relative(resourceRoot, canonicalSource).split(sep).join("/")
    : undefined;
  const sourceIdentity = sourcePath.startsWith("<inline:")
    ? `inline:${sourcePath}`
    : entry.scope === "project" && relativeSource !== undefined
      ? `project:${relativeSource}`
      : relativeSource === undefined
        ? `path:${canonicalSource}`
        : `root:${resourceRoot}\0path:${relativeSource}`;
  const namespace = `${extensionId}-${sha256(sourceIdentity)}`;
  const workspaceNamespace = sha256(workspace);
  return {
    user: join(dataRoot, "user", namespace),
    workspace: join(dataRoot, "workspaces", workspaceNamespace, namespace),
  };
}

async function secureExtensionDataDirectory(path: string): Promise<string> {
  const selected = resolve(path);
  await assertCanonicalDirectoryCreationPath(selected);
  await mkdir(selected, { recursive: true, mode: 0o700 });
  const information = await lstat(selected);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`Runtime extension data path is not a canonical directory: ${selected}`);
  }
  const canonical = await realpath(selected);
  if (canonical !== selected) throw new Error(`Runtime extension data path is not canonical: ${selected}`);
  if (process.platform !== "win32") await chmod(selected, 0o700);
  return canonical;
}

export async function prepareExtensionDataPaths(
  paths: RuntimeExtensionDataPaths,
  signal: AbortSignal,
): Promise<RuntimeExtensionDataPaths> {
  signal.throwIfAborted();
  const user = await secureExtensionDataDirectory(paths.user);
  signal.throwIfAborted();
  const workspace = await secureExtensionDataDirectory(paths.workspace);
  signal.throwIfAborted();
  return Object.freeze({ user, workspace });
}
