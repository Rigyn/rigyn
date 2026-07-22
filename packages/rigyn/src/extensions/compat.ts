import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "../config/paths.js";
import type { EventBus } from "../core/event-bus.js";
import { createSyntheticSourceInfo } from "../core/source-info.js";
import type { SourceInfo } from "../core/source-info.js";
import { resolvePath } from "../utils/paths.js";
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
    const value = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { rigyn?: unknown };
    if (value.rigyn === null || typeof value.rigyn !== "object" || Array.isArray(value.rigyn)) return null;
    const extensions = (value.rigyn as { extensions?: unknown }).extensions;
    if (!Array.isArray(extensions)) return {};
    return { extensions: extensions.filter((entry): entry is string => typeof entry === "string") };
  } catch {
    return null;
  }
}

function isExtensionFile(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".js");
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
      if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
        discovered.push(entryPath);
        continue;
      }
      if (entry.isDirectory() || entry.isSymbolicLink()) {
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
  const message = cause instanceof Error ? cause.message : String(cause);
  return `Failed to load extension: ${message}`;
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

/** Discovers project, user, then explicitly configured direct factories and loads them sequentially. */
export async function discoverAndLoadExtensions(
  configuredPaths: string[],
  cwd: string,
  agentDir: string = getAgentDir(),
  eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
  const resolvedCwd = resolvePath(cwd);
  const resolvedAgentDir = resolvePath(agentDir);
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

  const projectDirectory = join(resolvedCwd, CONFIG_DIR_NAME, "extensions");
  addPaths(discoverExtensionsInDirectory(projectDirectory), {
    scope: "project",
    trusted: true,
  });

  const userDirectory = join(resolvedAgentDir, "extensions");
  addPaths(discoverExtensionsInDirectory(userDirectory), {
    scope: "user",
    trusted: true,
  });

  for (const configuredPath of configuredPaths) {
    const selected = resolvePath(configuredPath, resolvedCwd, { normalizeUnicodeSpaces: true });
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
    workspace: resolvedCwd,
    activationFailure: "throw",
    ...(eventBus === undefined ? {} : { eventBus }),
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
        workspace: resolvedCwd,
        activationFailure: "throw",
        directPathMetadata: metadata,
        ...(eventBus === undefined ? {} : { eventBus }),
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
