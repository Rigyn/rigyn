import { lstat, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, resolve, sep } from "node:path";
import ignore from "ignore";
import { parseDocument } from "yaml";

import { HarnessError } from "../core/errors.js";
import { WorkspaceBoundary, readFileBounded } from "../tools/paths.js";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1_024;
const MAX_COMPATIBILITY_LENGTH = 500;
const MAX_IGNORE_FILE_BYTES = 1024 * 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"] as const;
const KNOWN_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
  "disable-model-invocation",
]);

export interface SkillRoot {
  path: string;
  scope: "user" | "workspace";
  trusted: boolean;
  extensionId?: string;
  /** Discover direct Markdown skill files when this path is a directory. */
  rootMarkdown?: boolean;
}

export interface SkillMetadata {
  name: string;
  description: string;
  scope: "user" | "workspace";
  trusted: boolean;
  rootPath: string;
  directory: string;
  manifestPath: string;
  metadataTruncated: boolean;
  metadata: Readonly<Record<string, string>>;
  disableModelInvocation: boolean;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
}

export interface LoadedSkill extends SkillMetadata {
  instructions: string;
  totalBytes: number;
  truncated: boolean;
}

export type SkillDiagnosticSeverity = "error" | "warning";

export type SkillDiagnosticCode =
  | "SKILL_COLLISION"
  | "SKILL_DESCRIPTION_INVALID"
  | "SKILL_DESCRIPTION_REQUIRED"
  | "SKILL_DIRECTORY_UNREADABLE"
  | "SKILL_FIELD_INVALID"
  | "SKILL_FRONTMATTER_INVALID"
  | "SKILL_FRONTMATTER_MISSING"
  | "SKILL_FRONTMATTER_TRUNCATED"
  | "SKILL_FRONTMATTER_UNTERMINATED"
  | "SKILL_MANIFEST_UNREADABLE"
  | "SKILL_METADATA_INVALID"
  | "SKILL_NAME_INVALID"
  | "SKILL_NAME_MISMATCH"
  | "SKILL_NAME_REQUIRED"
  | "SKILL_UNKNOWN_FIELD";

export interface SkillDiagnostic {
  severity: SkillDiagnosticSeverity;
  code: SkillDiagnosticCode;
  message: string;
  path: string;
  field?: string;
  skillName?: string;
  winnerPath?: string;
  loserPath?: string;
  winnerRootPath?: string;
  loserRootPath?: string;
}

export interface SkillDiscoveryOptions {
  maxSkills?: number;
  maxMetadataBytes?: number;
}

export interface SkillDiscoveryResult {
  skills: SkillMetadata[];
  diagnostics: SkillDiagnostic[];
}

interface ParsedFrontmatter {
  name: string;
  description: string;
  metadata: Readonly<Record<string, string>>;
  disableModelInvocation: boolean;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
}

interface IgnoreScope {
  base: string;
  matcher: ReturnType<typeof ignore>;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portablePath(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
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

async function loadIgnoreScopes(directory: string, base: string): Promise<IgnoreScope[]> {
  const scopes: IgnoreScope[] = [];
  for (const name of IGNORE_FILE_NAMES) {
    const path = resolve(directory, name);
    try {
      const information = await lstat(path);
      if (!information.isFile() || information.isSymbolicLink()) continue;
      const contents = await readFileBounded(path, MAX_IGNORE_FILE_BYTES);
      if (contents.truncated) {
        throw new HarnessError(
          "CONTEXT_SKILL_IGNORE_LIMIT",
          `Skill ignore file exceeds ${MAX_IGNORE_FILE_BYTES} bytes: ${base === "" ? name : `${base}/${name}`}`,
        );
      }
      scopes.push({
        base,
        matcher: ignore({ ignorecase: process.platform === "win32" }).add(contents.data.toString("utf8")),
      });
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (["EACCES", "ENOENT", "ENOTDIR", "EPERM"].includes(code ?? "")) continue;
      throw error;
    }
  }
  return scopes;
}

function frontmatterSource(
  source: string,
  truncated: boolean,
): { yaml: string } | { code: SkillDiagnosticCode; message: string } {
  const normalized = source.replace(/\r\n?/gu, "\n");
  const firstNewline = normalized.indexOf("\n");
  const firstLine = firstNewline < 0 ? normalized : normalized.slice(0, firstNewline);
  if (firstLine !== "---") {
    return { code: "SKILL_FRONTMATTER_MISSING", message: "SKILL.md must start with YAML frontmatter" };
  }
  if (firstNewline < 0) {
    return truncated
      ? { code: "SKILL_FRONTMATTER_TRUNCATED", message: "Skill frontmatter exceeds the metadata byte limit" }
      : { code: "SKILL_FRONTMATTER_UNTERMINATED", message: "Skill frontmatter is missing its closing fence" };
  }
  let lineStart = firstNewline + 1;
  while (lineStart <= normalized.length) {
    const nextNewline = normalized.indexOf("\n", lineStart);
    const lineEnd = nextNewline < 0 ? normalized.length : nextNewline;
    if (normalized.slice(lineStart, lineEnd) === "---") {
      return { yaml: normalized.slice(firstNewline + 1, lineStart) };
    }
    if (nextNewline < 0) break;
    lineStart = nextNewline + 1;
  }
  return truncated
    ? { code: "SKILL_FRONTMATTER_TRUNCATED", message: "Skill frontmatter exceeds the metadata byte limit" }
    : { code: "SKILL_FRONTMATTER_UNTERMINATED", message: "Skill frontmatter is missing its closing fence" };
}

function frontmatterMap(
  yaml: string,
  manifestPath: string,
  diagnostics: SkillDiagnostic[],
): Map<string, unknown> | undefined {
  try {
    const document = parseDocument(yaml, {
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      merge: false,
      resolveKnownTags: false,
    });
    const issue = document.errors[0] ?? document.warnings[0];
    if (issue !== undefined) {
      diagnostics.push({
        severity: "error",
        code: "SKILL_FRONTMATTER_INVALID",
        message: `Invalid YAML frontmatter: ${issue.message}`,
        path: manifestPath,
      });
      return undefined;
    }
    const parsed: unknown = document.toJS({ mapAsMap: true, maxAliasCount: 32 });
    if (!(parsed instanceof Map)) {
      diagnostics.push({
        severity: "error",
        code: "SKILL_FRONTMATTER_INVALID",
        message: "Skill frontmatter must be a YAML mapping",
        path: manifestPath,
      });
      return undefined;
    }
    return parsed as Map<string, unknown>;
  } catch (error) {
    diagnostics.push({
      severity: "error",
      code: "SKILL_FRONTMATTER_INVALID",
      message: `Invalid YAML frontmatter: ${message(error)}`,
      path: manifestPath,
    });
    return undefined;
  }
}

function optionalString(
  fields: Map<string, unknown>,
  field: string,
  manifestPath: string,
  diagnostics: SkillDiagnostic[],
  maximumLength?: number,
): string | undefined | null {
  const value = fields.get(field);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || (maximumLength !== undefined && (value.length < 1 || value.length > maximumLength))) {
    diagnostics.push({
      severity: "error",
      code: "SKILL_FIELD_INVALID",
      message: maximumLength === undefined
        ? `${field} must be a string`
        : `${field} must be a string from 1 through ${maximumLength} characters`,
      path: manifestPath,
      field,
    });
    return null;
  }
  return value;
}

function parseFrontmatter(
  source: string,
  truncated: boolean,
  expectedName: string,
  manifestPath: string,
  diagnostics: SkillDiagnostic[],
): ParsedFrontmatter | undefined {
  const extracted = frontmatterSource(source, truncated);
  if (!("yaml" in extracted)) {
    diagnostics.push({
      severity: "error",
      code: extracted.code,
      message: extracted.message,
      path: manifestPath,
    });
    return undefined;
  }
  const fields = frontmatterMap(extracted.yaml, manifestPath, diagnostics);
  if (fields === undefined) return undefined;

  for (const field of [...fields.keys()].sort(compareText)) {
    if (KNOWN_FIELDS.has(field)) continue;
    diagnostics.push({
      severity: "warning",
      code: "SKILL_UNKNOWN_FIELD",
      message: `Unknown skill frontmatter field: ${field}`,
      path: manifestPath,
      field,
    });
  }

  const name = fields.get("name");
  if (typeof name !== "string" || name.length === 0) {
    diagnostics.push({
      severity: "error",
      code: "SKILL_NAME_REQUIRED",
      message: "Skill name is required and must be a string",
      path: manifestPath,
      field: "name",
    });
    return undefined;
  }
  const nameProblems: string[] = [];
  if (name.length > MAX_NAME_LENGTH) nameProblems.push(`must not exceed ${MAX_NAME_LENGTH} characters`);
  if (!/^[a-z0-9-]+$/u.test(name)) nameProblems.push("must contain only lowercase letters, numbers, and hyphens");
  if (name.startsWith("-") || name.endsWith("-")) nameProblems.push("must not start or end with a hyphen");
  if (name.includes("--")) nameProblems.push("must not contain consecutive hyphens");
  if (nameProblems.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "SKILL_NAME_INVALID",
      message: `Invalid skill name ${JSON.stringify(name)}: ${nameProblems.join("; ")}`,
      path: manifestPath,
      field: "name",
      skillName: name,
    });
  }
  if (name !== expectedName) {
    diagnostics.push({
      severity: "warning",
      code: "SKILL_NAME_MISMATCH",
      message: `Skill name ${JSON.stringify(name)} differs from directory ${JSON.stringify(expectedName)}`,
      path: manifestPath,
      field: "name",
      skillName: name,
    });
  }

  const description = fields.get("description");
  if (typeof description !== "string" || description.trim().length === 0) {
    diagnostics.push({
      severity: "error",
      code: "SKILL_DESCRIPTION_REQUIRED",
      message: "Skill description is required and must be a non-empty string",
      path: manifestPath,
      field: "description",
      skillName: name,
    });
    return undefined;
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    diagnostics.push({
      severity: "warning",
      code: "SKILL_DESCRIPTION_INVALID",
      message: `Skill description must not exceed ${MAX_DESCRIPTION_LENGTH} characters`,
      path: manifestPath,
      field: "description",
      skillName: name,
    });
  }

  const rawMetadata = fields.get("metadata");
  const metadataEntries: Array<[string, string]> = [];
  if (rawMetadata !== undefined) {
    if (!(rawMetadata instanceof Map)) {
      diagnostics.push({
        severity: "error",
        code: "SKILL_METADATA_INVALID",
        message: "Skill metadata must be a mapping of string keys to string values",
        path: manifestPath,
        field: "metadata",
        skillName: name,
      });
      return undefined;
    }
    for (const [key, value] of rawMetadata) {
      if (typeof key !== "string" || typeof value !== "string") {
        diagnostics.push({
          severity: "error",
          code: "SKILL_METADATA_INVALID",
          message: "Skill metadata must be a mapping of string keys to string values",
          path: manifestPath,
          field: "metadata",
          skillName: name,
        });
        return undefined;
      }
      metadataEntries.push([key, value]);
    }
  }

  const rawDisableModelInvocation = fields.get("disable-model-invocation");
  if (rawDisableModelInvocation !== undefined && typeof rawDisableModelInvocation !== "boolean") {
    diagnostics.push({
      severity: "error",
      code: "SKILL_FIELD_INVALID",
      message: "disable-model-invocation must be a boolean",
      path: manifestPath,
      field: "disable-model-invocation",
      skillName: name,
    });
    return undefined;
  }
  const license = optionalString(fields, "license", manifestPath, diagnostics);
  const compatibility = optionalString(fields, "compatibility", manifestPath, diagnostics, MAX_COMPATIBILITY_LENGTH);
  const allowedTools = optionalString(fields, "allowed-tools", manifestPath, diagnostics);
  if (license === null || compatibility === null || allowedTools === null) return undefined;

  return {
    name,
    description,
    metadata: Object.freeze(Object.fromEntries(metadataEntries.sort(([left], [right]) => compareText(left, right)))),
    disableModelInvocation: rawDisableModelInvocation === true,
    ...(license === undefined ? {} : { license }),
    ...(compatibility === undefined ? {} : { compatibility }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
  };
}

async function readSkillMetadata(
  root: SkillRoot,
  rootPath: string,
  directory: string,
  expectedName: string,
  manifestPath: string,
  maxMetadataBytes: number,
  diagnostics: SkillDiagnostic[],
): Promise<SkillMetadata | undefined> {
  let bounded;
  try {
    bounded = await readFileBounded(manifestPath, maxMetadataBytes);
  } catch (error) {
    diagnostics.push({
      severity: "error",
      code: "SKILL_MANIFEST_UNREADABLE",
      message: `Unable to read skill manifest: ${message(error)}`,
      path: manifestPath,
    });
    return undefined;
  }
  const parsed = parseFrontmatter(
    bounded.data.toString("utf8"),
    bounded.truncated,
    expectedName,
    manifestPath,
    diagnostics,
  );
  if (parsed === undefined) return undefined;
  return {
    ...parsed,
    scope: root.scope,
    trusted: root.trusted,
    rootPath,
    directory,
    manifestPath,
    metadataTruncated: false,
  };
}

export async function discoverSkillsDetailed(
  roots: readonly SkillRoot[],
  options: SkillDiscoveryOptions = {},
): Promise<SkillDiscoveryResult> {
  const maxSkills = options.maxSkills ?? 128;
  const maxMetadataBytes = options.maxMetadataBytes ?? 8 * 1024;
  if (!Number.isSafeInteger(maxSkills) || maxSkills < 1) throw new RangeError("maxSkills must be positive");
  if (!Number.isSafeInteger(maxMetadataBytes) || maxMetadataBytes < 1) {
    throw new RangeError("maxMetadataBytes must be positive");
  }

  const byName = new Map<string, SkillMetadata>();
  const diagnostics: SkillDiagnostic[] = [];
  const seenManifests = new Set<string>();

  const registerSkill = (discovered: SkillMetadata): void => {
    const previous = byName.get(discovered.name);
    if (previous !== undefined) {
      diagnostics.push({
        severity: "warning",
        code: "SKILL_COLLISION",
        message: `Skill ${JSON.stringify(discovered.name)} from the later root ${discovered.rootPath} takes precedence over ${previous.rootPath}`,
        path: discovered.manifestPath,
        skillName: discovered.name,
        winnerPath: discovered.manifestPath,
        loserPath: previous.manifestPath,
        winnerRootPath: discovered.rootPath,
        loserRootPath: previous.rootPath,
      });
    }
    byName.set(discovered.name, discovered);
    if (byName.size > maxSkills) throw new HarnessError("CONTEXT_SKILL_LIMIT", `Skill count exceeds ${maxSkills}`);
  };

  for (const root of roots) {
    try {
      const requested = resolve(root.path);
      const information = await stat(requested);
      if (information.isFile()) {
        const directory = dirname(requested);
        const discovered = await readSkillMetadata(
          { ...root, path: directory },
          directory,
          directory,
          basename(requested, extname(requested)),
          requested,
          maxMetadataBytes,
          diagnostics,
        );
        if (discovered !== undefined) registerSkill(discovered);
        continue;
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    let boundary: WorkspaceBoundary;
    let realRoot: string;
    try {
      const initialBoundary = await WorkspaceBoundary.create(root.path);
      realRoot = await initialBoundary.readable(".");
      boundary = await WorkspaceBoundary.create(realRoot);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw new HarnessError("CONTEXT_SKILL_BOUNDARY", `Unable to inspect skill root ${root.path}`, {
        cause: error,
      });
    }
    const visitedDirectories = new Set<string>();

    const addManifest = async (directory: string, expectedName: string, manifestPath: string): Promise<void> => {
      if (seenManifests.has(manifestPath)) return;
      seenManifests.add(manifestPath);
      const discovered = await readSkillMetadata(
        root,
        realRoot,
        directory,
        expectedName,
        manifestPath,
        maxMetadataBytes,
        diagnostics,
      );
      if (discovered === undefined) return;
      registerSkill(discovered);
    };

    const scan = async (
      directory: string,
      expectedName: string,
      inheritedScopes: readonly IgnoreScope[],
      localDirectory: string,
    ): Promise<void> => {
      if (visitedDirectories.has(directory)) return;
      visitedDirectories.add(directory);
      const scopes = [...inheritedScopes, ...await loadIgnoreScopes(directory, localDirectory)];
      let entries;
      try {
        entries = (await readdir(directory, { withFileTypes: true }))
          .sort((left, right) => compareText(left.name, right.name));
      } catch (error) {
        diagnostics.push({
          severity: "error",
          code: "SKILL_DIRECTORY_UNREADABLE",
          message: `Unable to inspect skill directory: ${message(error)}`,
          path: directory,
        });
        return;
      }

      const manifestEntry = entries.find((entry) => entry.name === "SKILL.md");
      if (manifestEntry !== undefined) {
        const candidate = resolve(directory, manifestEntry.name);
        const localManifest = localDirectory === "" ? manifestEntry.name : `${localDirectory}/${manifestEntry.name}`;
        let manifestPath: string;
        let manifestIsFile = false;
        try {
          manifestPath = await boundary.readable(candidate);
          manifestIsFile = (await stat(manifestPath)).isFile();
        } catch (error) {
          if (!isNotFound(error)) {
            throw new HarnessError("CONTEXT_SKILL_BOUNDARY", `Skill ${expectedName} escapes its root`, {
              cause: error,
            });
          }
          manifestPath = candidate;
        }
        if (manifestIsFile && !ignoredBy(scopes, localManifest, false)) {
          await addManifest(directory, expectedName, manifestPath);
          return;
        }
      }

      if (localDirectory === "" && root.rootMarkdown !== false) {
        for (const entry of entries) {
          if (entry.name === "SKILL.md" || entry.name.startsWith(".") || !entry.name.endsWith(".md")) continue;
          const candidate = resolve(directory, entry.name);
          const localManifest = portablePath(entry.name);
          if (ignoredBy(scopes, localManifest, false)) continue;
          let manifestPath: string;
          try {
            manifestPath = await boundary.readable(candidate);
            if (!(await stat(manifestPath)).isFile()) continue;
          } catch (error) {
            if (isNotFound(error)) continue;
            throw new HarnessError("CONTEXT_SKILL_BOUNDARY", `Skill ${entry.name} escapes its root`, {
              cause: error,
            });
          }
          await addManifest(directory, basename(entry.name, extname(entry.name)), manifestPath);
        }
      }

      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const candidate = resolve(directory, entry.name);
        const local = localDirectory === "" ? portablePath(entry.name) : `${localDirectory}/${portablePath(entry.name)}`;
        let child: string;
        try {
          child = await boundary.readable(candidate);
          if (!(await stat(child)).isDirectory()) continue;
        } catch (error) {
          if (isNotFound(error)) continue;
          throw new HarnessError("CONTEXT_SKILL_BOUNDARY", `Skill ${entry.name} escapes its root`, {
            cause: error,
          });
        }
        if (ignoredBy(scopes, local, true)) continue;
        await scan(child, entry.name, scopes, local);
      }
    };

    await scan(realRoot, basename(resolve(root.path)), [], "");
  }

  return {
    skills: [...byName.values()].sort((left, right) => compareText(left.name, right.name)),
    diagnostics,
  };
}

export async function discoverSkills(
  roots: readonly SkillRoot[],
  options: SkillDiscoveryOptions = {},
): Promise<SkillMetadata[]> {
  return (await discoverSkillsDetailed(roots, options)).skills;
}

export async function loadSkill(skill: SkillMetadata, maxBytes = 64 * 1024): Promise<LoadedSkill> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be positive");
  try {
    const boundary = await WorkspaceBoundary.create(skill.rootPath);
    const manifest = await boundary.readable(skill.manifestPath);
    if (manifest !== skill.manifestPath) {
      throw new HarnessError("CONTEXT_SKILL_CHANGED", `Skill path changed after discovery: ${skill.name}`);
    }
    const bounded = await readFileBounded(manifest, maxBytes);
    return {
      ...skill,
      instructions: bounded.data.toString("utf8"),
      totalBytes: bounded.totalBytes,
      truncated: bounded.truncated,
    };
  } catch (cause) {
    if (cause instanceof HarnessError) throw cause;
    throw new HarnessError("CONTEXT_SKILL_BOUNDARY", `Unable to load skill ${skill.name}`, {
      cause,
    });
  }
}
