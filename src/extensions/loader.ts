import { constants } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
} from "node:fs/promises";
import { basename, isAbsolute, join, posix, resolve } from "node:path";
import { satisfies } from "semver";

import type { SkillRoot } from "../context/skills.js";
import { sha256 } from "../tools/hash.js";
import { WorkspaceBoundary } from "../tools/paths.js";
import { parseThemeDefinition } from "../tui/theme.js";
import { RIGYN_VERSION } from "../version.js";
import {
  parseExtensionManifest,
  type ParsedExtensionManifest,
} from "./manifest.js";
import { validateTemplatePlaceholders } from "./templates.js";
import type {
  ExtensionBundle,
  ExtensionDiagnostic,
  ExtensionDiscoveryOptions,
  ExtensionDoctorReport,
  ExtensionMetadata,
  ExtensionPromptTemplate,
  ExtensionRuntimeEntry,
  ExtensionSlashCommand,
  ExtensionSource,
  ExtensionTheme,
} from "./types.js";

const MANIFEST_NAME = "extension.json";
const SCOPE_PRECEDENCE = { builtin: 0, user: 1, project: 2, invocation: 3 } as const;
const EMPTY_COUNTS = { skillRoots: 0, prompts: 0, commands: 0, themes: 0, runtime: 0 } as const;

export const DEFAULT_MAX_EXTENSIONS = 128;
export const DEFAULT_MAX_EXTENSION_DIRECTORY_ENTRIES = 4096;
export const DEFAULT_MAX_EXTENSION_MANIFEST_BYTES = 256 * 1024;
export const DEFAULT_MAX_EXTENSION_TEMPLATE_BYTES = 64 * 1024;
export const DEFAULT_MAX_EXTENSION_INTEGRITY_FILE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_EXTENSION_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_EXTENSION_DIAGNOSTICS = 512;

interface Limits {
  maxExtensions: number;
  maxDirectoryEntries: number;
  maxManifestBytes: number;
  maxTemplateBytes: number;
  maxIntegrityFileBytes: number;
  maxExtensionBytes: number;
  maxDiagnostics: number;
}

interface Candidate {
  manifest: ParsedExtensionManifest;
  metadata: ExtensionMetadata;
  boundary: WorkspaceBoundary;
}

class DiagnosticCollector {
  readonly values: ExtensionDiagnostic[] = [];
  readonly #maximum: number;
  #truncated = false;

  constructor(maximum: number) {
    this.#maximum = maximum;
  }

  add(value: ExtensionDiagnostic): void {
    if (this.values.length < this.#maximum) {
      this.values.push(value);
      return;
    }
    if (this.#truncated || this.#maximum === 0) return;
    this.#truncated = true;
    this.values[this.#maximum - 1] = {
      severity: "error",
      code: "EXTENSION_DIAGNOSTICS_TRUNCATED",
      message: `Extension diagnostics exceeded ${this.#maximum} entries`,
      path: value.path,
    };
  }
}

function limit(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new RangeError(`${label} must be an integer from 1 through ${maximum}`);
  }
  return selected;
}

function options(value: ExtensionDiscoveryOptions): Limits {
  const maxIntegrityFileBytes = limit(
    value.maxIntegrityFileBytes,
    DEFAULT_MAX_EXTENSION_INTEGRITY_FILE_BYTES,
    1024 * 1024 * 1024,
    "maxIntegrityFileBytes",
  );
  const maxExtensionBytes = limit(
    value.maxExtensionBytes,
    DEFAULT_MAX_EXTENSION_BYTES,
    1024 * 1024 * 1024,
    "maxExtensionBytes",
  );
  if (maxExtensionBytes < maxIntegrityFileBytes) {
    throw new RangeError("maxExtensionBytes must be at least maxIntegrityFileBytes");
  }
  return {
    maxExtensions: limit(value.maxExtensions, DEFAULT_MAX_EXTENSIONS, 4096, "maxExtensions"),
    maxDirectoryEntries: limit(value.maxDirectoryEntries, DEFAULT_MAX_EXTENSION_DIRECTORY_ENTRIES, 100_000, "maxDirectoryEntries"),
    maxManifestBytes: limit(value.maxManifestBytes, DEFAULT_MAX_EXTENSION_MANIFEST_BYTES, 16 * 1024 * 1024, "maxManifestBytes"),
    maxTemplateBytes: limit(value.maxTemplateBytes, DEFAULT_MAX_EXTENSION_TEMPLATE_BYTES, 4 * 1024 * 1024, "maxTemplateBytes"),
    maxIntegrityFileBytes,
    maxExtensionBytes,
    maxDiagnostics: limit(value.maxDiagnostics, DEFAULT_MAX_EXTENSION_DIAGNOSTICS, 10_000, "maxDiagnostics"),
  };
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function readRegularFile(path: string, maximumBytes: number, label: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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
    if ((await handle.read(Buffer.alloc(1), 0, 1, data.length)).bytesRead !== 0) {
      throw new Error(`${label} changed while being read`);
    }
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

function decodeUtf8(data: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

async function safeEntry(
  boundary: WorkspaceBoundary,
  relativePath: string,
  expected: "file" | "directory" | "any",
): Promise<string> {
  if (
    isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.includes("/../") ||
    posix.normalize(relativePath) !== relativePath
  ) {
    throw new Error(`Extension path must be normalized and relative: ${relativePath}`);
  }
  const segments = relativePath.split("/");
  let current = boundary.root;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index] ?? "");
    const information = await lstat(current);
    if (information.isSymbolicLink()) throw new Error(`Extension path contains a symbolic link: ${relativePath}`);
    if (index < segments.length - 1 && !information.isDirectory()) {
      throw new Error(`Extension path parent is not a directory: ${relativePath}`);
    }
    if (index === segments.length - 1) {
      if (expected === "file" && !information.isFile()) throw new Error(`Extension asset is not a regular file: ${relativePath}`);
      if (expected === "directory" && !information.isDirectory()) throw new Error(`Extension skill root is not a directory: ${relativePath}`);
      if (expected === "any" && !information.isFile() && !information.isDirectory()) throw new Error(`Extension skill path is not a file or directory: ${relativePath}`);
    }
  }
  const resolved = await boundary.readable(relativePath);
  if (resolved !== await realpath(current)) throw new Error(`Extension path changed during validation: ${relativePath}`);
  return resolved;
}

class AssetReader {
  readonly #boundary: WorkspaceBoundary;
  readonly #limits: Limits;
  readonly #cache = new Map<string, { path: string; data: Buffer }>();
  #totalBytes = 0;

  constructor(boundary: WorkspaceBoundary, limits: Limits) {
    this.#boundary = boundary;
    this.#limits = limits;
  }

  async read(path: string, maximumBytes: number): Promise<{ path: string; data: Buffer }> {
    const cached = this.#cache.get(path);
    if (cached !== undefined) {
      if (cached.data.length > maximumBytes) throw new Error(`Extension asset exceeds ${maximumBytes} bytes: ${path}`);
      return cached;
    }
    const absolute = await safeEntry(this.#boundary, path, "file");
    const data = await readRegularFile(absolute, maximumBytes, `Extension asset ${path}`);
    this.#totalBytes += data.length;
    if (this.#totalBytes > this.#limits.maxExtensionBytes) {
      throw new Error(`Extension assets exceed ${this.#limits.maxExtensionBytes} total bytes`);
    }
    const result = { path: absolute, data };
    this.#cache.set(path, result);
    return result;
  }

  async verifyIntegrity(integrity: ReadonlyMap<string, string>): Promise<void> {
    for (const [path, expected] of integrity) {
      const asset = await this.read(path, this.#limits.maxIntegrityFileBytes);
      if (sha256(asset.data) !== expected) throw new Error(`Extension integrity mismatch: ${path}`);
    }
  }
}

async function materialize(
  candidate: Candidate,
  limits: Limits,
): Promise<ExtensionBundle> {
  const manifest = candidate.manifest;
  const reader = new AssetReader(candidate.boundary, limits);
  await reader.verifyIntegrity(manifest.integrity);

  const skillRoots: SkillRoot[] = [];
  for (const root of manifest.skillRoots) {
    skillRoots.push({
      path: await safeEntry(candidate.boundary, root.path, "any"),
      scope: candidate.metadata.scope === "project" || candidate.metadata.scope === "invocation" ? "workspace" : "user",
      trusted: true,
      extensionId: manifest.id,
    });
  }

  const prompts: ExtensionPromptTemplate[] = [];
  for (const prompt of manifest.prompts) {
    const asset = await reader.read(prompt.path, limits.maxTemplateBytes);
    const template = decodeUtf8(asset.data, `Extension prompt ${prompt.id}`);
    validateTemplatePlaceholders(template, new Set(["input"]), `Extension prompt ${prompt.id}`);
    prompts.push({
      id: prompt.id,
      extensionId: manifest.id,
      ...(prompt.description === undefined ? {} : { description: prompt.description }),
      sourcePath: asset.path,
      sha256: sha256(asset.data),
      template,
    });
  }

  const commands: ExtensionSlashCommand[] = [];
  for (const command of manifest.commands) {
    const asset = await reader.read(command.path, limits.maxTemplateBytes);
    const template = decodeUtf8(asset.data, `Extension command ${command.name}`);
    validateTemplatePlaceholders(template, new Set(["args"]), `Extension command ${command.name}`);
    commands.push({
      name: command.name,
      extensionId: manifest.id,
      ...(command.description === undefined ? {} : { description: command.description }),
      ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
      sourcePath: asset.path,
      sha256: sha256(asset.data),
      template,
    });
  }

  const themes: ExtensionTheme[] = [];
  for (const theme of manifest.themes) {
    const asset = await reader.read(theme.path, limits.maxTemplateBytes);
    const definition = parseThemeDefinition(JSON.parse(decodeUtf8(asset.data, `Extension theme ${theme.name}`)) as unknown);
    if (definition.name !== theme.name) throw new Error(`Extension theme declaration ${theme.name} does not match definition ${definition.name}`);
    themes.push({
      name: theme.name,
      extensionId: manifest.id,
      ...(theme.description === undefined ? {} : { description: theme.description }),
      sourcePath: asset.path,
      sha256: sha256(asset.data),
      definition,
    });
  }

  const runtime: ExtensionRuntimeEntry[] = [];
  for (const entry of manifest.runtime) {
    const asset = await reader.read(entry.path, limits.maxIntegrityFileBytes);
    decodeUtf8(asset.data, `Extension runtime ${entry.path}`);
    runtime.push({
      extensionId: manifest.id,
      sourcePath: asset.path,
      sha256: sha256(asset.data),
      resourceRoot: candidate.metadata.extensionRoot,
      scope: candidate.metadata.scope,
      trusted: candidate.metadata.trusted,
      ...(Object.values(manifest.permissions).some(Boolean)
        ? {
            permissions: Object.fromEntries(
              Object.entries(manifest.permissions).filter(([, enabled]) => enabled),
            ),
          }
        : {}),
    });
  }
  return { skillRoots, prompts, commands, themes, runtime };
}

function metadataForInvalid(input: {
  id: string;
  scope: ExtensionSource["scope"];
  trusted: boolean;
  sourceRoot: string;
  extensionRoot: string;
  manifestPath: string;
  precedence: number;
  manifestSha256?: string;
}): ExtensionMetadata {
  return {
    id: input.id,
    name: input.id,
    scope: input.scope,
    trusted: input.trusted,
    status: "invalid",
    sourceRoot: input.sourceRoot,
    extensionRoot: input.extensionRoot,
    manifestPath: input.manifestPath,
    ...(input.manifestSha256 === undefined ? {} : { manifestSha256: input.manifestSha256 }),
    precedence: input.precedence,
    contributions: { ...EMPTY_COUNTS },
  };
}

function cloneMetadata(value: ExtensionMetadata): ExtensionMetadata {
  return { ...value, contributions: { ...value.contributions } };
}

function cloneTheme(value: ExtensionTheme): ExtensionTheme {
  return {
    ...value,
    definition: {
      ...value.definition,
      styles: Object.fromEntries(Object.entries(value.definition.styles).map(([role, declaration]) => [role, { ...declaration }])),
      ...(value.definition.tokens === undefined ? {} : { tokens: { ...value.definition.tokens } }),
      ...(value.definition.export === undefined ? {} : { export: { ...value.definition.export } }),
    },
  };
}

function cloneBundle(value: ExtensionBundle): ExtensionBundle {
  return {
    skillRoots: value.skillRoots.map((root) => ({ ...root })),
    prompts: value.prompts.map((prompt) => ({ ...prompt })),
    commands: value.commands.map((command) => ({ ...command })),
    themes: value.themes.map(cloneTheme),
    runtime: value.runtime.map((entry) => ({
      ...entry,
      ...(entry.permissions === undefined ? {} : { permissions: { ...entry.permissions } }),
    })),
  };
}

export class ExtensionCatalog {
  readonly #extensions: ExtensionMetadata[];
  readonly #diagnostics: ExtensionDiagnostic[];
  readonly #bundle: ExtensionBundle;

  constructor(extensions: ExtensionMetadata[], diagnostics: ExtensionDiagnostic[], bundle: ExtensionBundle) {
    this.#extensions = extensions.map(cloneMetadata);
    this.#diagnostics = diagnostics.map((diagnostic) => ({ ...diagnostic }));
    this.#bundle = cloneBundle(bundle);
  }

  list(): ExtensionMetadata[] {
    return this.#extensions.map(cloneMetadata);
  }

  bundle(): ExtensionBundle {
    return cloneBundle(this.#bundle);
  }

  doctor(): ExtensionDoctorReport {
    const count = (status: ExtensionMetadata["status"]): number => this.#extensions.filter((entry) => entry.status === status).length;
    return {
      healthy: !this.#diagnostics.some((entry) => entry.severity === "error"),
      active: count("active"),
      blocked: count("blocked"),
      disabled: count("disabled"),
      invalid: count("invalid"),
      shadowed: count("shadowed"),
      diagnostics: this.#diagnostics.map((diagnostic) => ({ ...diagnostic })),
    };
  }

  prompt(id: string): ExtensionPromptTemplate | undefined {
    const value = this.#bundle.prompts.find((entry) => entry.id === id);
    return value === undefined ? undefined : { ...value };
  }

  command(name: string): ExtensionSlashCommand | undefined {
    const value = this.#bundle.commands.find((entry) => entry.name === name);
    return value === undefined ? undefined : { ...value };
  }

  theme(name: string): ExtensionTheme | undefined {
    const value = this.#bundle.themes.find((entry) => entry.name === name);
    return value === undefined ? undefined : cloneTheme(value);
  }
}

export async function discoverExtensions(
  sources: readonly ExtensionSource[],
  discoveryOptions: ExtensionDiscoveryOptions = {},
): Promise<ExtensionCatalog> {
  if (sources.length > 32) throw new RangeError("Extension discovery cannot contain more than 32 sources");
  const limits = options(discoveryOptions);
  const diagnostics = new DiagnosticCollector(limits.maxDiagnostics);
  const metadata: ExtensionMetadata[] = [];
  const candidates: Candidate[] = [];
  let extensionCount = 0;

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const source = sources[sourceIndex];
    if (source === undefined) continue;
    if (
      typeof source.path !== "string" ||
      source.path.length === 0 ||
      source.path.includes("\0") ||
      Buffer.byteLength(source.path) > 4096
    ) {
      throw new TypeError(`Extension source ${sourceIndex} path must be a non-empty string no larger than 4096 bytes`);
    }
    if (
      source.scope !== "builtin"
      && source.scope !== "user"
      && source.scope !== "project"
      && source.scope !== "invocation"
    ) {
      throw new TypeError(`Extension source ${sourceIndex} scope is invalid`);
    }
    if (typeof source.trusted !== "boolean") {
      throw new TypeError(`Extension source ${sourceIndex} trusted must be a boolean`);
    }
    if (source.optional !== undefined && typeof source.optional !== "boolean") {
      throw new TypeError(`Extension source ${sourceIndex} optional must be a boolean`);
    }
    const sourcePath = resolve(source.path);
    let rootInformation;
    try {
      rootInformation = await lstat(sourcePath);
    } catch (error) {
      if (errno(error) === "ENOENT" && source.optional === true) continue;
      diagnostics.add({
        severity: errno(error) === "ENOENT" ? "warning" : "error",
        code: errno(error) === "ENOENT" ? "EXTENSION_ROOT_MISSING" : "EXTENSION_ROOT_UNREADABLE",
        message: errno(error) === "ENOENT" ? "Extension source root does not exist" : "Extension source root cannot be inspected",
        path: sourcePath,
      });
      continue;
    }
    if (!rootInformation.isDirectory() || rootInformation.isSymbolicLink()) {
      diagnostics.add({ severity: "error", code: "EXTENSION_ROOT_BOUNDARY", message: "Extension source root must be a real directory", path: sourcePath });
      continue;
    }
    let realRoot: string;
    let sourceBoundary: WorkspaceBoundary;
    try {
      realRoot = await realpath(sourcePath);
      sourceBoundary = await WorkspaceBoundary.create(realRoot);
    } catch {
      diagnostics.add({ severity: "error", code: "EXTENSION_ROOT_BOUNDARY", message: "Extension source root cannot be canonicalized", path: sourcePath });
      continue;
    }
    const children: string[] = [];
    let directory;
    try {
      directory = await opendir(realRoot);
    } catch {
      diagnostics.add({ severity: "error", code: "EXTENSION_ROOT_UNREADABLE", message: "Extension source root cannot be read", path: realRoot });
      continue;
    }
    let directoryLimitExceeded = false;
    try {
      for await (const entry of directory) {
        children.push(entry.name);
        if (children.length > limits.maxDirectoryEntries) {
          directoryLimitExceeded = true;
          diagnostics.add({
            severity: "error",
            code: "EXTENSION_DIRECTORY_LIMIT",
            message: `Extension source exceeds ${limits.maxDirectoryEntries} directory entries`,
            path: realRoot,
          });
          break;
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    if (directoryLimitExceeded) continue;
    children.sort((left, right) => left.localeCompare(right));

    for (let childIndex = 0; childIndex < Math.min(children.length, limits.maxDirectoryEntries); childIndex += 1) {
      const child = children[childIndex];
      if (child === undefined) continue;
      const extensionRoot = join(realRoot, child);
      const manifestPath = join(extensionRoot, MANIFEST_NAME);
      let childInformation;
      try {
        childInformation = await lstat(extensionRoot);
      } catch {
        continue;
      }
      if (childInformation.isSymbolicLink()) {
        diagnostics.add({ severity: "error", code: "EXTENSION_SYMLINK", message: "Extension directories must not be symbolic links", path: extensionRoot });
        continue;
      }
      if (!childInformation.isDirectory()) continue;
      let manifestInformation;
      try {
        manifestInformation = await lstat(manifestPath);
      } catch (error) {
        if (errno(error) !== "ENOENT") {
          diagnostics.add({ severity: "error", code: "EXTENSION_MANIFEST_UNREADABLE", message: "Extension manifest cannot be inspected", path: manifestPath });
        }
        continue;
      }
      extensionCount += 1;
      const precedence = SCOPE_PRECEDENCE[source.scope] * 1_000_000_000 + sourceIndex * 100_000 + childIndex;
      const fallbackId = basename(extensionRoot);
      if (extensionCount > limits.maxExtensions) {
        diagnostics.add({
          severity: "error",
          code: "EXTENSION_COUNT_LIMIT",
          message: `Extension count exceeds ${limits.maxExtensions}`,
          path: manifestPath,
        });
        continue;
      }
      if (!manifestInformation.isFile() || manifestInformation.isSymbolicLink()) {
        metadata.push(metadataForInvalid({
          id: fallbackId,
          scope: source.scope,
          trusted: source.trusted,
          sourceRoot: realRoot,
          extensionRoot,
          manifestPath,
          precedence,
        }));
        diagnostics.add({ severity: "error", code: "EXTENSION_MANIFEST_BOUNDARY", message: "Extension manifest must be a regular non-symlink file", path: manifestPath });
        continue;
      }

      let bytes: Buffer;
      let parsed: ParsedExtensionManifest;
      try {
        const canonicalManifest = await sourceBoundary.readable(manifestPath);
        if (canonicalManifest !== await realpath(manifestPath)) throw new Error("Extension manifest changed during discovery");
        bytes = await readRegularFile(canonicalManifest, limits.maxManifestBytes, "Extension manifest");
        parsed = parseExtensionManifest(JSON.parse(decodeUtf8(bytes, "Extension manifest")) as unknown);
      } catch (error) {
        metadata.push(metadataForInvalid({
          id: fallbackId,
          scope: source.scope,
          trusted: source.trusted,
          sourceRoot: realRoot,
          extensionRoot,
          manifestPath,
          precedence,
        }));
        diagnostics.add({
          severity: "error",
          code: "EXTENSION_MANIFEST_INVALID",
          message: error instanceof Error ? error.message : "Extension manifest is invalid",
          path: manifestPath,
        });
        continue;
      }
      const compatible = parsed.hostVersionRange === undefined
        || satisfies(RIGYN_VERSION, parsed.hostVersionRange, { includePrerelease: true });
      const status = !compatible ? "invalid" : !parsed.enabled ? "disabled" : !source.trusted ? "blocked" : "active";
      const item: ExtensionMetadata = {
        id: parsed.id,
        name: parsed.name,
        ...(parsed.version === undefined ? {} : { version: parsed.version }),
        ...(parsed.description === undefined ? {} : { description: parsed.description }),
        ...(parsed.hostVersionRange === undefined ? {} : { hostVersionRange: parsed.hostVersionRange }),
        scope: source.scope,
        trusted: source.trusted,
        status,
        sourceRoot: realRoot,
        extensionRoot,
        manifestPath,
        manifestSha256: sha256(bytes),
        precedence,
        contributions: {
          skillRoots: parsed.skillRoots.length,
          prompts: parsed.prompts.length,
          commands: parsed.commands.length,
          themes: parsed.themes.length,
          runtime: parsed.runtime.length,
        },
      };
      metadata.push(item);
      if (!compatible) {
        diagnostics.add({
          severity: "error",
          code: "EXTENSION_HOST_INCOMPATIBLE",
          message: `Extension requires Rigyn ${parsed.hostVersionRange}; current version is ${RIGYN_VERSION}`,
          path: manifestPath,
          extensionId: parsed.id,
        });
        continue;
      }
      if (!parsed.enabled) {
        diagnostics.add({ severity: "info", code: "EXTENSION_DISABLED", message: "Extension is disabled by its manifest", path: manifestPath, extensionId: parsed.id });
        continue;
      }
      if (!source.trusted) {
        diagnostics.add({ severity: "warning", code: "EXTENSION_UNTRUSTED", message: "Extension contributions are blocked until the source is trusted", path: manifestPath, extensionId: parsed.id });
        continue;
      }
      try {
        const extensionRealRoot = await sourceBoundary.readable(extensionRoot);
        candidates.push({ manifest: parsed, metadata: item, boundary: await WorkspaceBoundary.create(extensionRealRoot) });
      } catch (error) {
        item.status = "invalid";
        diagnostics.add({
          severity: "error",
          code: "EXTENSION_BOUNDARY",
          message: error instanceof Error ? error.message : "Extension root is not safely contained",
          path: extensionRoot,
          extensionId: parsed.id,
        });
      }
    }
  }

  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.manifest.id) ?? [];
    group.push(candidate);
    groups.set(candidate.manifest.id, group);
  }
  const selected: Array<{ candidate: Candidate; bundle: ExtensionBundle }> = [];
  for (const [id, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    group.sort((left, right) => right.metadata.precedence - left.metadata.precedence || right.metadata.manifestPath.localeCompare(left.metadata.manifestPath));
    let winner: Candidate | undefined;
    for (const candidate of group) {
      if (winner !== undefined) {
        candidate.metadata.status = "shadowed";
        diagnostics.add({
          severity: "warning",
          code: "EXTENSION_SHADOWED",
          message: `Extension is shadowed by ${winner.metadata.manifestPath}`,
          path: candidate.metadata.manifestPath,
          extensionId: id,
        });
        continue;
      }
      try {
        const bundle = await materialize(candidate, limits);
        candidate.metadata.status = "active";
        winner = candidate;
        selected.push({ candidate, bundle });
      } catch (error) {
        candidate.metadata.status = "invalid";
        diagnostics.add({
          severity: "error",
          code: "EXTENSION_CONTRIBUTION_INVALID",
          message: error instanceof Error ? error.message : "Extension contribution is invalid",
          path: candidate.metadata.manifestPath,
          extensionId: id,
        });
      }
    }
  }

  selected.sort((left, right) => left.candidate.metadata.precedence - right.candidate.metadata.precedence || left.candidate.metadata.manifestPath.localeCompare(right.candidate.metadata.manifestPath));
  const aggregate: ExtensionBundle = { skillRoots: [], prompts: [], commands: [], themes: [], runtime: [] };
  const prompts = new Map<string, ExtensionPromptTemplate>();
  const commands = new Map<string, ExtensionSlashCommand>();
  const themes = new Map<string, ExtensionTheme>();
  for (const entry of selected) {
    aggregate.skillRoots.push(...entry.bundle.skillRoots);
    aggregate.runtime.push(...entry.bundle.runtime);
    for (const prompt of entry.bundle.prompts) {
      const previous = prompts.get(prompt.id);
      if (previous !== undefined) diagnostics.add({
        severity: "warning",
        code: "EXTENSION_PROMPT_SHADOWED",
        message: `Prompt ${prompt.id} from ${previous.extensionId} is shadowed by ${prompt.extensionId}`,
        path: entry.candidate.metadata.manifestPath,
        extensionId: entry.candidate.manifest.id,
      });
      prompts.set(prompt.id, prompt);
    }
    for (const command of entry.bundle.commands) {
      const previous = commands.get(command.name);
      if (previous !== undefined) diagnostics.add({
        severity: "warning",
        code: "EXTENSION_COMMAND_SHADOWED",
        message: `Command /${command.name} from ${previous.extensionId} is shadowed by ${command.extensionId}`,
        path: entry.candidate.metadata.manifestPath,
        extensionId: entry.candidate.manifest.id,
      });
      commands.set(command.name, command);
    }
    for (const theme of entry.bundle.themes) {
      const previous = themes.get(theme.name);
      if (previous !== undefined) diagnostics.add({
        severity: "warning",
        code: "EXTENSION_THEME_SHADOWED",
        message: `Theme ${theme.name} from ${previous.extensionId} is shadowed by ${theme.extensionId}`,
        path: entry.candidate.metadata.manifestPath,
        extensionId: entry.candidate.manifest.id,
      });
      themes.set(theme.name, theme);
    }
  }
  aggregate.prompts = [...prompts.values()].sort((left, right) => left.id.localeCompare(right.id));
  aggregate.commands = [...commands.values()].sort((left, right) => left.name.localeCompare(right.name));
  aggregate.themes = [...themes.values()].sort((left, right) => left.name.localeCompare(right.name));
  metadata.sort((left, right) => left.precedence - right.precedence || left.manifestPath.localeCompare(right.manifestPath));
  return new ExtensionCatalog(metadata, diagnostics.values, aggregate);
}
