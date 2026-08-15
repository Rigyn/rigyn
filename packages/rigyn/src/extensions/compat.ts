import {
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "../config/paths.js";
import type { EventBus } from "../core/event-bus.js";
import { errorMessage } from "../core/errors.js";
import { readTrustedTextFileSync } from "../core/resource-file.js";
import { createSyntheticSourceInfo } from "../core/source-info.js";
import type { SourceInfo } from "../core/source-info.js";
import { normalizePath, resolvePath } from "../utils/paths.js";
import type { Extension, LoadExtensionsResult } from "./direct.js";
import {
  attachExtensionProjection,
  attachExtensionRuntimeHost,
  createExtensionRuntime,
} from "./compat-runtime.js";
import {
  appendDirectExtensions,
  loadDirectExtensions,
  RuntimeExtensionHost,
  type RuntimeDirectPathMetadata,
} from "./runtime.js";

export {
  attachExtensionProjection,
  attachExtensionRuntimeHost,
  createExtensionRuntime,
  ensureExtensionRuntimeHost,
  ExtensionRunner,
  getExtensionRuntimeHost,
  type ExtensionErrorListener,
} from "./compat-runtime.js";

interface PackageManifest {
  extensions?: string[];
}

interface DiscoveredExtension {
  path: string;
  metadata: RuntimeDirectPathMetadata;
}

export interface LoadedExtensionProjectionMetadata {
  /** Original path presented by the loader; defaults to the canonical source path. */
  path?: string;
  /** Original provenance when a resource loader already resolved it. */
  sourceInfo?: SourceInfo;
}

function readPackageManifest(packageJsonPath: string): PackageManifest | null {
  try {
    const value = JSON.parse(readTrustedTextFileSync(
      packageJsonPath,
      1024 * 1024,
      "Extension package manifest",
    )) as { rigyn?: unknown };
    if (value.rigyn === null || typeof value.rigyn !== "object" || Array.isArray(value.rigyn)) return null;
    const extensions = (value.rigyn as { extensions?: unknown }).extensions;
    if (!Array.isArray(extensions)) return {};
    return { extensions: extensions.filter((entry): entry is string => typeof entry === "string") };
  } catch {
    return null;
  }
}

const EXTENSION_SOURCE_SUFFIXES = [".js", ".ts"] as const;

function isExtensionFile(name: string): boolean {
  return EXTENSION_SOURCE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function resolveExtensionEntries(directory: string): string[] | null {
  const packageJsonPath = join(directory, "package.json");
  if (existsSync(packageJsonPath)) {
    const manifest = readPackageManifest(packageJsonPath);
    if (manifest?.extensions?.length) {
      const entries = manifest.extensions
        .map((entry) => resolve(directory, entry))
        .filter((entry) => existsSync(entry));
      if (entries.length > 0) return entries;
    }
  }

  const indexTs = join(directory, "index.ts");
  if (existsSync(indexTs)) return [indexTs];
  const indexJs = join(directory, "index.js");
  return existsSync(indexJs) ? [indexJs] : null;
}

function discoverExtensionsInDirectory(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const discovered: string[] = [];
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      const sourceFile = entry.isFile() || entry.isSymbolicLink();
      if (sourceFile && isExtensionFile(entry.name)) {
        discovered.push(entryPath);
      } else if (entry.isDirectory() || entry.isSymbolicLink()) {
        const entries = resolveExtensionEntries(entryPath);
        if (entries !== null) discovered.push(...entries);
      }
    }
  } catch {
    return [];
  }
  return discovered;
}

function loadError(cause: unknown): string {
  return `Failed to load extension: ${errorMessage(cause)}`;
}

function projectExtension(
  captured: Extension,
  selected: DiscoveredExtension,
  resolvedPath: string,
): Extension {
  const sourceInfo = createSyntheticSourceInfo(selected.path, {
    source: "local",
    scope: selected.metadata.scope,
    origin: "top-level",
    baseDir: dirname(resolvedPath),
  });
  for (const tool of captured.tools.values()) tool.sourceInfo = sourceInfo;
  for (const command of captured.commands.values()) command.sourceInfo = sourceInfo;
  return {
    ...captured,
    path: selected.path,
    resolvedPath,
    sourceInfo,
    tools: captured.tools,
    commands: captured.commands,
  };
}

/** Projects an already-active native host without evaluating any factory again. */
export function projectLoadedExtensionHost(
  host: RuntimeExtensionHost,
  metadata: ReadonlyMap<string, LoadedExtensionProjectionMetadata> = new Map(),
): LoadExtensionsResult {
  const runtime = createExtensionRuntime();
  attachExtensionRuntimeHost(runtime, host);
  const extensions = host.extensions().map((entry) => {
    const captured = host.compatibilityProjection(entry.sourcePath);
    if (captured === undefined) {
      throw new Error(`Loaded extension has no public projection: ${entry.sourcePath}`);
    }
    const selected = metadata.get(entry.sourcePath);
    const path = selected?.path ?? entry.sourcePath;
    const sourceInfo = selected?.sourceInfo ?? createSyntheticSourceInfo(path, {
      source: "local",
      scope: entry.scope === "user" ? "user" : entry.scope === "project" ? "project" : "temporary",
      origin: "top-level",
      baseDir: entry.resourceRoot ?? dirname(entry.sourcePath),
    });
    for (const tool of captured.tools.values()) tool.sourceInfo = sourceInfo;
    for (const command of captured.commands.values()) command.sourceInfo = sourceInfo;
    const projection: Extension = {
      ...captured,
      path,
      resolvedPath: entry.sourcePath,
      sourceInfo,
      tools: captured.tools,
      commands: captured.commands,
    };
    attachExtensionProjection(projection, runtime);
    return projection;
  });
  runtime.flagValues = host.flagValues();
  return { extensions, errors: [], runtime };
}

/**
 * Discovers project, user, then explicitly configured direct factories and loads them sequentially.
 *
 * This low-level compatibility helper assumes the caller has already approved
 * project-local executable code. Application entry points must use the
 * trust-aware resource loader instead of calling it before a trust decision.
 */
export async function discoverAndLoadExtensions(
  requestedPaths: string[],
  workspace: string,
  userDataDir: string = getAgentDir(),
  events?: EventBus,
): Promise<LoadExtensionsResult> {
  const roots = Object.freeze({
    workspace: resolvePath(workspace),
    agent: resolvePath(userDataDir),
  });
  const discovered: DiscoveredExtension[] = [];
  const seen = new Set<string>();

  const addPaths = (
    paths: readonly string[],
    metadata: RuntimeDirectPathMetadata,
  ): void => {
    for (const path of paths) {
      const canonical = resolve(path);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      discovered.push({
        path,
        metadata: {
          ...metadata,
          resourceRoot: metadata.resourceRoot ?? dirname(canonical),
        },
      });
    }
  };

  const projectDirectory = join(roots.workspace, CONFIG_DIR_NAME, "extensions");
  addPaths(discoverExtensionsInDirectory(projectDirectory), {
    scope: "project",
    trusted: true,
  });

  const userDirectory = join(roots.agent, "extensions");
  addPaths(discoverExtensionsInDirectory(userDirectory), {
    scope: "user",
    trusted: true,
  });

  for (const configuredPath of requestedPaths) {
    const selected = resolvePath(normalizePath(configuredPath, { normalizeUnicodeSpaces: true }), roots.workspace);
    if (existsSync(selected) && statSync(selected).isDirectory()) {
      const entries = resolveExtensionEntries(selected);
      if (entries !== null) {
        addPaths(entries, { scope: "temporary", trusted: true, resourceRoot: selected });
        continue;
      }
      addPaths(discoverExtensionsInDirectory(selected), {
        scope: "temporary",
        trusted: true,
        resourceRoot: selected,
      });
      continue;
    }
    addPaths([selected], { scope: "temporary", trusted: true });
  }

  const host = await loadDirectExtensions([], {
    workspace: roots.workspace,
    activationFailure: "throw",
    ...(events === undefined ? {} : { eventBus: events }),
  });
  const runtime = createExtensionRuntime();
  attachExtensionRuntimeHost(runtime, host);
  const extensions: Extension[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  for (const selected of discovered) {
    try {
      const metadata = new Map<string, RuntimeDirectPathMetadata>([[selected.path, selected.metadata]]);
      const before = host.extensions().length;
      await appendDirectExtensions(host, [selected.path], {
        workspace: roots.workspace,
        activationFailure: "throw",
        directPathMetadata: metadata,
        ...(events === undefined ? {} : { eventBus: events }),
      });
      const entry = host.extensions()[before];
      if (entry === undefined) throw new Error("Extension activation produced no runtime generation");
      const captured = host.compatibilityProjection(entry.sourcePath);
      if (captured === undefined) throw new Error("Extension activation produced no public projection");
      const projection = projectExtension(captured, selected, entry.sourcePath);
      attachExtensionProjection(projection, runtime);
      extensions.push(projection);
    } catch (cause) {
      errors.push({ path: selected.path, error: loadError(cause) });
    }
  }

  runtime.flagValues = host.flagValues();
  return { extensions, errors, runtime };
}
