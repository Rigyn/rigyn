import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { sha256 } from "../tools/hash.js";
import { readFileBounded, WorkspaceBoundary } from "../tools/paths.js";
import type { ExtensionRuntimeEntry, ExtensionScope } from "./types.js";

const MAX_EXPLICIT_RUNTIME_EXTENSIONS = 32;
const MAX_EXPLICIT_RUNTIME_PATH_BYTES = 4_096;
const MAX_EXPLICIT_RUNTIME_BYTES = 32 * 1024 * 1024;
const RUNTIME_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"]);
const RUNTIME_INDEX_FILES = ["index.ts", "index.mts", "index.js", "index.mjs"] as const;
const MANAGED_EXTENSION_MANIFEST = "extension.json";

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function assertNoSymbolicLinkComponents(path: string): Promise<void> {
  const root = parse(path).root;
  const components = relative(root, path).split(sep).filter((entry) => entry !== "");
  let current = root;
  for (const component of components) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`Explicit runtime extension path contains a symbolic link: ${path}`);
    }
  }
}

async function directoryEntry(path: string): Promise<string> {
  for (const name of RUNTIME_INDEX_FILES) {
    const candidate = join(path, name);
    let information;
    try {
      information = await lstat(candidate);
    } catch (error) {
      if (errno(error) === "ENOENT") continue;
      throw error;
    }
    if (information.isSymbolicLink()) {
      throw new Error(`Explicit runtime extension index must not be a symbolic link: ${candidate}`);
    }
    if (!information.isFile()) {
      throw new Error(`Explicit runtime extension index is not a regular file: ${candidate}`);
    }
    return candidate;
  }
  throw new Error(`Explicit runtime extension directory has no supported index (${RUNTIME_INDEX_FILES.join(", ")}): ${path}`);
}

async function hasManagedExtensionManifest(path: string): Promise<boolean> {
  try {
    await lstat(join(path, MANAGED_EXTENSION_MANIFEST));
    return true;
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
}

/** Discover simple extension files and directories from one extension root. */
export async function discoverRuntimeExtensionPaths(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return [];
    throw error;
  }
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isFile() && RUNTIME_EXTENSIONS.has(extname(entry.name))) {
      paths.push(path);
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (await hasManagedExtensionManifest(path)) continue;
    try {
      await directoryEntry(path);
      paths.push(path);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("has no supported index")) throw error;
    }
  }
  return paths;
}

function runtimeExtensionId(sourcePath: string, requestedPath: string): string {
  const name = basename(requestedPath, extname(requestedPath));
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z]+/u, "")
    .replace(/-+$/u, "")
    .slice(0, 40) || "extension";
  return `cli-${slug}-${sha256(sourcePath).slice(0, 10)}`;
}

export async function resolveExplicitRuntimeExtensions(
  values: readonly string[],
  workspace: string,
  options: { maximum?: number; scope?: ExtensionScope; trusted?: boolean } = {},
): Promise<ExtensionRuntimeEntry[]> {
  const maximum = options.maximum ?? MAX_EXPLICIT_RUNTIME_EXTENSIONS;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4_096) {
    throw new RangeError("Runtime extension maximum must be an integer from 1 through 4096");
  }
  if (values.length > maximum) {
    throw new Error(`At most ${maximum} runtime extensions may be loaded`);
  }
  const boundary = await WorkspaceBoundary.create(workspace);
  const entries: ExtensionRuntimeEntry[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (
      typeof value !== "string" ||
      value === "" ||
      value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > MAX_EXPLICIT_RUNTIME_PATH_BYTES
    ) {
      throw new Error(`--extension value ${index + 1} must be a non-empty path no larger than ${MAX_EXPLICIT_RUNTIME_PATH_BYTES} bytes`);
    }
    const absoluteInput = isAbsolute(value);
    const requested = absoluteInput ? resolve(value) : boundary.lexical(value);
    let information;
    try {
      information = await lstat(requested);
    } catch (error) {
      if (errno(error) === "ENOENT") throw new Error(`Explicit runtime extension does not exist: ${value}`);
      throw error;
    }
    if (information.isSymbolicLink()) {
      throw new Error(`Explicit runtime extension path must not be a symbolic link: ${value}`);
    }
    if (!absoluteInput) await assertNoSymbolicLinkComponents(requested);
    const selected = information.isDirectory()
      ? await directoryEntry(requested)
      : requested;
    if (!absoluteInput) await assertNoSymbolicLinkComponents(selected);
    const selectedInformation = await lstat(selected);
    if (!selectedInformation.isFile()) {
      throw new Error(`Explicit runtime extension is not a regular file: ${value}`);
    }
    if (!RUNTIME_EXTENSIONS.has(extname(selected))) {
      throw new Error("Explicit runtime extension must use .ts, .mts, .js, or .mjs");
    }
    const canonical = await realpath(selected);
    if (!isAbsolute(value)) await boundary.readable(canonical);
    if (seen.has(canonical)) continue;
    const source = await readFileBounded(canonical, MAX_EXPLICIT_RUNTIME_BYTES);
    if (source.truncated) {
      throw new Error(`Explicit runtime extension exceeds ${MAX_EXPLICIT_RUNTIME_BYTES} bytes: ${value}`);
    }
    seen.add(canonical);
    entries.push({
      extensionId: runtimeExtensionId(canonical, information.isDirectory() ? requested : canonical),
      sourcePath: canonical,
      sha256: sha256(source.data),
      resourceRoot: information.isDirectory() ? await realpath(requested) : dirname(canonical),
      scope: options.scope ?? "project",
      trusted: options.trusted ?? true,
    });
  }
  return entries;
}
