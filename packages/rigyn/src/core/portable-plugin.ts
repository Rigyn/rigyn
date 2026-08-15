import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseDocument } from "yaml";

export const PORTABLE_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const RIGYN_PLUGIN_NAMESPACE = "io.github.rigyn";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SKILL_BYTES = 1024 * 1024;
const MANIFEST_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);
const AUTHOR_FIELDS = new Set(["name", "email", "url"]);

export type PortablePluginDiagnosticCode =
  | "PORTABLE_PLUGIN_MANIFEST_FIELD_IGNORED"
  | "PORTABLE_PLUGIN_MANIFEST_INVALID"
  | "PORTABLE_PLUGIN_NAMESPACE_INVALID"
  | "PORTABLE_PLUGIN_SKILLS_INVALID"
  | "PORTABLE_PLUGIN_SKILL_INVALID"
  | "PORTABLE_PLUGIN_SKILL_PATH_ESCAPE";

export interface PortablePluginDiagnostic {
  code: PortablePluginDiagnosticCode;
  message: string;
  path: string;
  severity: "warning" | "error";
}

export interface PortablePluginManifest {
  name: string;
  version?: string;
  description?: string;
}

export interface PortablePluginInspection {
  diagnostics: PortablePluginDiagnostic[];
  manifest?: PortablePluginManifest;
  manifestPath: string;
  namespaceRoot?: string;
  rejected: boolean;
  root: string;
  skills: string[];
}

export interface PortableSkillMetadata {
  description: string;
  disableModelInvocation: boolean;
  name: string;
}

export interface PortableSkillValidation {
  diagnostics: PortablePluginDiagnostic[];
  metadata?: PortableSkillMetadata;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

export function portablePathInside(root: string, path: string): boolean {
  const local = relative(resolve(root), resolve(path));
  return local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}

function canonicalInside(root: string, path: string): string {
  const canonical = realpathSync(path);
  if (!portablePathInside(root, canonical)) throw new Error("path resolves outside the plugin root");
  return canonical;
}

function decodeJsonFile(path: string, label: string, maximumBytes: number): unknown {
  const information = statSync(path);
  if (!information.isFile()) throw new Error(`${label} is not a regular file`);
  if (information.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  const bytes = readFileSync(path);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function manifestError(path: string, message: string): PortablePluginInspection {
  return {
    diagnostics: [{
      code: "PORTABLE_PLUGIN_MANIFEST_INVALID",
      message,
      path,
      severity: "error",
    }],
    manifestPath: path,
    rejected: true,
    root: dirname(resolve(path)),
    skills: [],
  };
}

function validateManifest(value: unknown, path: string): {
  diagnostics: PortablePluginDiagnostic[];
  error?: string;
  manifest?: PortablePluginManifest;
  rejected: boolean;
} {
  const diagnostics: PortablePluginDiagnostic[] = [];
  if (!plainObject(value)) {
    return { diagnostics, error: "plugin.json must contain an object", rejected: true };
  }
  for (const field of Object.keys(value).sort(compareText)) {
    if (MANIFEST_FIELDS.has(field)) continue;
    diagnostics.push({
      code: "PORTABLE_PLUGIN_MANIFEST_FIELD_IGNORED",
      message: `Ignored unknown plugin manifest field ${JSON.stringify(field)}`,
      path,
      severity: "warning",
    });
  }
  if (value.$schema !== PORTABLE_PLUGIN_SCHEMA) {
    return { diagnostics, error: "plugin.json declares an unsupported schema", rejected: true };
  }
  if (
    typeof value.name !== "string"
    || !/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value.name)
    || value.name.length > 64
  ) {
    return { diagnostics, error: "plugin.json name is invalid", rejected: true };
  }
  for (const field of ["version", "description", "homepage", "repository", "license"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      return { diagnostics, error: `plugin.json ${field} must be a string`, rejected: true };
    }
  }
  if (value.author !== undefined) {
    if (!plainObject(value.author)) {
      return { diagnostics, error: "plugin.json author must be an object", rejected: true };
    }
    if (Object.keys(value.author).some((field) => !AUTHOR_FIELDS.has(field))) {
      return { diagnostics, error: "plugin.json author contains an unknown field", rejected: true };
    }
    if (Object.values(value.author).some((field) => typeof field !== "string")) {
      return { diagnostics, error: "plugin.json author values must be strings", rejected: true };
    }
  }
  if (
    value.keywords !== undefined
    && (!Array.isArray(value.keywords) || value.keywords.some((entry) => typeof entry !== "string"))
  ) {
    return { diagnostics, error: "plugin.json keywords must be an array of strings", rejected: true };
  }
  if (value.extensions !== undefined && !plainObject(value.extensions)) {
    diagnostics.push({
      code: "PORTABLE_PLUGIN_MANIFEST_FIELD_IGNORED",
      message: "Ignored plugin manifest extensions because it is not an object",
      path,
      severity: "warning",
    });
  }
  return {
    diagnostics,
    manifest: {
      name: value.name,
      ...(value.version === undefined ? {} : { version: value.version as string }),
      ...(value.description === undefined ? {} : { description: value.description as string }),
    },
    rejected: false,
  };
}

function frontmatter(source: string): Map<string, unknown> {
  const normalized = source.replace(/\r\n?/gu, "\n");
  if (normalized !== "---" && !normalized.startsWith("---\n")) {
    throw new Error("SKILL.md must begin with YAML frontmatter");
  }
  const lines = normalized.split("\n");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("SKILL.md frontmatter is missing its closing fence");
  const document = parseDocument(lines.slice(1, end).join("\n"), {
    schema: "core",
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    merge: false,
    resolveKnownTags: false,
  });
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue !== undefined) throw new Error(`SKILL.md frontmatter is invalid: ${issue.message}`);
  const parsed: unknown = document.toJS({ mapAsMap: true, maxAliasCount: 32 });
  if (!(parsed instanceof Map)) throw new Error("SKILL.md frontmatter must be a mapping");
  return parsed as Map<string, unknown>;
}

function characterCount(value: string): number {
  return [...value].length;
}

export function validatePortableSkill(
  path: string,
  expectedName: string,
  pluginRoot: string,
  maximumBytes = MAX_SKILL_BYTES,
): PortableSkillValidation {
  const invalid = (message: string, code: PortablePluginDiagnosticCode = "PORTABLE_PLUGIN_SKILL_INVALID"): PortableSkillValidation => ({
    diagnostics: [{ code, message, path, severity: "error" }],
  });
  let canonicalRoot: string;
  let canonicalPath: string;
  let source: string;
  try {
    canonicalRoot = realpathSync(pluginRoot);
    canonicalPath = canonicalInside(canonicalRoot, path);
    const information = statSync(canonicalPath);
    if (!information.isFile()) return invalid("Portable skill manifest is not a regular file");
    if (information.size > maximumBytes) return invalid(`Portable skill manifest exceeds ${maximumBytes} bytes`);
    source = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(canonicalPath));
  } catch (error) {
    return invalid(
      error instanceof Error ? error.message : String(error),
      error instanceof Error && error.message.includes("outside the plugin root")
        ? "PORTABLE_PLUGIN_SKILL_PATH_ESCAPE"
        : "PORTABLE_PLUGIN_SKILL_INVALID",
    );
  }
  let fields: Map<string, unknown>;
  try {
    fields = frontmatter(source);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
  const name = fields.get("name");
  if (
    typeof name !== "string"
    || characterCount(name) < 1
    || characterCount(name) > 64
    || !/^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name)
  ) {
    return invalid("Portable skill name is invalid");
  }
  if (name !== expectedName) return invalid("Portable skill name must match its parent directory");
  const description = fields.get("description");
  if (
    typeof description !== "string"
    || description.trim().length === 0
    || characterCount(description) > 1_024
  ) {
    return invalid("Portable skill description is invalid");
  }
  for (const field of ["license", "allowed-tools"] as const) {
    const value = fields.get(field);
    if (value !== undefined && typeof value !== "string") return invalid(`Portable skill ${field} must be a string`);
  }
  const compatibility = fields.get("compatibility");
  if (
    compatibility !== undefined
    && (typeof compatibility !== "string" || characterCount(compatibility) < 1 || characterCount(compatibility) > 500)
  ) {
    return invalid("Portable skill compatibility is invalid");
  }
  const metadata = fields.get("metadata");
  if (metadata !== undefined) {
    if (!(metadata instanceof Map)) return invalid("Portable skill metadata must be a string mapping");
    for (const [key, value] of metadata) {
      if (typeof key !== "string" || typeof value !== "string") {
        return invalid("Portable skill metadata must be a string mapping");
      }
    }
  }
  const disableModelInvocation = fields.get("disable-model-invocation");
  if (disableModelInvocation !== undefined && typeof disableModelInvocation !== "boolean") {
    return invalid("Portable skill disable-model-invocation must be a boolean");
  }
  return {
    diagnostics: [],
    metadata: {
      name,
      description,
      disableModelInvocation: disableModelInvocation === true,
    },
  };
}

function discoverSkills(root: string, diagnostics: PortablePluginDiagnostic[]): string[] {
  const requested = join(root, "skills");
  try {
    if (!present(requested)) return [];
  } catch (error) {
    diagnostics.push({
      code: "PORTABLE_PLUGIN_SKILLS_INVALID",
      message: error instanceof Error ? error.message : String(error),
      path: requested,
      severity: "error",
    });
    return [];
  }
  let directory: string;
  try {
    directory = canonicalInside(root, requested);
    if (!statSync(directory).isDirectory()) throw new Error("skills is not a directory");
  } catch (error) {
    diagnostics.push({
      code: "PORTABLE_PLUGIN_SKILLS_INVALID",
      message: error instanceof Error ? error.message : String(error),
      path: requested,
      severity: "error",
    });
    return [];
  }
  const skills: string[] = [];
  const seen = new Set<string>();
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name));
  } catch (error) {
    diagnostics.push({
      code: "PORTABLE_PLUGIN_SKILLS_INVALID",
      message: error instanceof Error ? error.message : String(error),
      path: requested,
      severity: "error",
    });
    return [];
  }
  for (const entry of entries) {
    const child = join(directory, entry.name);
    let childDirectory: string;
    try {
      childDirectory = canonicalInside(root, child);
      if (!statSync(childDirectory).isDirectory()) continue;
    } catch (error) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        diagnostics.push({
          code: "PORTABLE_PLUGIN_SKILL_PATH_ESCAPE",
          message: error instanceof Error ? error.message : String(error),
          path: child,
          severity: "error",
        });
      }
      continue;
    }
    const requestedManifest = join(childDirectory, "SKILL.md");
    try {
      if (!present(requestedManifest)) continue;
    } catch (error) {
      diagnostics.push({
        code: "PORTABLE_PLUGIN_SKILL_INVALID",
        message: error instanceof Error ? error.message : String(error),
        path: requestedManifest,
        severity: "error",
      });
      continue;
    }
    let manifestPath: string;
    try {
      manifestPath = canonicalInside(root, requestedManifest);
      if (!statSync(manifestPath).isFile()) throw new Error("SKILL.md is not a regular file");
    } catch (error) {
      diagnostics.push({
        code: error instanceof Error && error.message.includes("outside the plugin root")
          ? "PORTABLE_PLUGIN_SKILL_PATH_ESCAPE"
          : "PORTABLE_PLUGIN_SKILL_INVALID",
        message: error instanceof Error ? error.message : String(error),
        path: requestedManifest,
        severity: "error",
      });
      continue;
    }
    if (seen.has(manifestPath)) continue;
    const validated = validatePortableSkill(manifestPath, entry.name, root);
    diagnostics.push(...validated.diagnostics);
    if (validated.metadata === undefined) continue;
    seen.add(manifestPath);
    skills.push(manifestPath);
  }
  return skills;
}

function namespaceDirectory(root: string, diagnostics: PortablePluginDiagnostic[]): string | undefined {
  const requested = join(root, RIGYN_PLUGIN_NAMESPACE);
  try {
    if (!present(requested)) return undefined;
    const directory = canonicalInside(root, requested);
    if (!statSync(directory).isDirectory()) throw new Error(`${RIGYN_PLUGIN_NAMESPACE} is not a directory`);
    for (const component of ["extensions", "prompts", "themes"] as const) {
      const path = join(directory, component);
      try {
        if (!present(path)) continue;
        const canonical = canonicalInside(root, path);
        if (!statSync(canonical).isDirectory()) throw new Error(`${component} is not a directory`);
      } catch (error) {
        diagnostics.push({
          code: "PORTABLE_PLUGIN_NAMESPACE_INVALID",
          message: error instanceof Error ? error.message : String(error),
          path,
          severity: "error",
        });
      }
    }
    return directory;
  } catch (error) {
    diagnostics.push({
      code: "PORTABLE_PLUGIN_NAMESPACE_INVALID",
      message: error instanceof Error ? error.message : String(error),
      path: requested,
      severity: "error",
    });
    return undefined;
  }
}

export function inspectPortablePlugin(inputRoot: string): PortablePluginInspection | undefined {
  const lexicalRoot = resolve(inputRoot);
  const requestedManifest = join(lexicalRoot, "plugin.json");
  try {
    if (!present(requestedManifest)) return undefined;
  } catch (error) {
    return manifestError(requestedManifest, error instanceof Error ? error.message : String(error));
  }
  let root: string;
  let manifestPath: string;
  let value: unknown;
  try {
    root = realpathSync(lexicalRoot);
    if (!statSync(root).isDirectory()) throw new Error("Plugin root is not a directory");
    manifestPath = canonicalInside(root, requestedManifest);
    value = decodeJsonFile(manifestPath, "plugin.json", MAX_MANIFEST_BYTES);
  } catch (error) {
    return manifestError(requestedManifest, error instanceof Error ? error.message : String(error));
  }
  const parsed = validateManifest(value, manifestPath);
  if (parsed.rejected || parsed.manifest === undefined) {
    return {
      diagnostics: [...parsed.diagnostics, {
        code: "PORTABLE_PLUGIN_MANIFEST_INVALID",
        message: parsed.error ?? "plugin.json does not satisfy the supported manifest contract",
        path: manifestPath,
        severity: "error",
      }],
      manifestPath,
      rejected: true,
      root,
      skills: [],
    };
  }
  const diagnostics = [...parsed.diagnostics];
  const skills = discoverSkills(root, diagnostics);
  const namespaceRoot = namespaceDirectory(root, diagnostics);
  return {
    diagnostics,
    manifest: parsed.manifest,
    manifestPath,
    ...(namespaceRoot === undefined ? {} : { namespaceRoot }),
    rejected: false,
    root,
    skills,
  };
}
