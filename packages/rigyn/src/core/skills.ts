import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import ignore, { type Ignore } from "ignore";
import { parseDocument } from "yaml";

import { CONFIG_DIR_NAME } from "../config/paths.js";
import { canonicalizePath, resolvePath } from "../utils/paths.js";
import type { ResourceDiagnostic } from "./diagnostics.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
  [key: string]: unknown;
}

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  sourceInfo: SourceInfo;
  disableModelInvocation: boolean;
}

export interface LoadSkillsResult {
  skills: Skill[];
  diagnostics: ResourceDiagnostic[];
}

export interface LoadSkillsFromDirOptions {
  dir: string;
  source: string;
}

export interface LoadSkillsOptions {
  cwd: string;
  agentDir: string;
  skillPaths: string[];
  includeDefaults: boolean;
}

const IGNORE_FILES = [".gitignore", ".ignore", ".fdignore"] as const;

function sourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
  if (source === "user" || source === "project") {
    return createSyntheticSourceInfo(filePath, { source: "local", scope: source, baseDir });
  }
  return createSyntheticSourceInfo(filePath, { source: source === "path" ? "local" : source, baseDir });
}

function frontmatter(filePath: string): { metadata?: SkillFrontmatter; error?: string } {
  let source: string;
  try { source = readFileSync(filePath, "utf8").replace(/\r\n?/gu, "\n"); }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  if (!source.startsWith("---")) return { metadata: {} };
  const end = source.indexOf("\n---", 4);
  if (end < 0) return { metadata: {} };
  try {
    const document = parseDocument(source.slice(4, end), {
      schema: "core",
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) return { error: document.errors[0]?.message ?? "invalid frontmatter" };
    const value = document.toJS() as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { error: "skill frontmatter must be a map" };
    return { metadata: value as SkillFrontmatter };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function loadFile(filePath: string, source: string): LoadSkillsResult {
  const diagnostics: ResourceDiagnostic[] = [];
  const parsed = frontmatter(filePath);
  if (parsed.metadata === undefined) {
    diagnostics.push({ type: "warning", message: parsed.error ?? "invalid skill", path: filePath });
    return { skills: [], diagnostics };
  }
  const fallbackName = basename(dirname(filePath));
  const name = typeof parsed.metadata.name === "string" ? parsed.metadata.name : fallbackName;
  const description = typeof parsed.metadata.description === "string" ? parsed.metadata.description : "";
  if (name.length > 64) {
    diagnostics.push({ type: "warning", message: `name exceeds 64 characters (${name.length})`, path: filePath });
  }
  if (!/^[a-z0-9-]+$/u.test(name)) {
    diagnostics.push({
      type: "warning",
      message: "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)",
      path: filePath,
    });
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    diagnostics.push({ type: "warning", message: "name must not start or end with a hyphen", path: filePath });
  }
  if (name.includes("--")) {
    diagnostics.push({ type: "warning", message: "name must not contain consecutive hyphens", path: filePath });
  }
  if (description.trim() === "") {
    diagnostics.push({ type: "warning", message: "description is required", path: filePath });
    return { skills: [], diagnostics };
  }
  if (description.length > 1_024) {
    diagnostics.push({
      type: "warning",
      message: `description exceeds 1024 characters (${description.length})`,
      path: filePath,
    });
  }
  const baseDir = dirname(filePath);
  return {
    skills: [{
      name,
      description,
      filePath,
      baseDir,
      sourceInfo: sourceInfo(filePath, baseDir, source),
      disableModelInvocation: parsed.metadata["disable-model-invocation"] === true,
    }],
    diagnostics,
  };
}

function addIgnoreRules(matcher: Ignore, directory: string, root: string): void {
  const prefix = relative(root, directory).split(sep).join("/");
  for (const name of IGNORE_FILES) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;
    try {
      const rules = readFileSync(path, "utf8").split(/\r?\n/gu).flatMap((line) => {
        const trimmed = line.trim();
        if (trimmed === "" || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) return [];
        const negated = line.startsWith("!");
        const body = (negated ? line.slice(1) : line).replace(/^\//u, "");
        return [`${negated ? "!" : ""}${prefix === "" ? "" : `${prefix}/`}${body}`];
      });
      if (rules.length > 0) matcher.add(rules);
    } catch {
      // An unreadable ignore file contributes no rules.
    }
  }
}

function scanDirectory(
  directory: string,
  source: string,
  rootMarkdown: boolean,
  root = directory,
  matcher: Ignore = ignore(),
  visited = new Set<string>(),
): LoadSkillsResult {
  if (!existsSync(directory)) return { skills: [], diagnostics: [] };
  const canonical = canonicalizePath(directory);
  if (visited.has(canonical)) return { skills: [], diagnostics: [] };
  visited.add(canonical);
  addIgnoreRules(matcher, directory, root);
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)); }
  catch (error) {
    return { skills: [], diagnostics: [{ type: "warning", message: error instanceof Error ? error.message : String(error), path: directory }] };
  }
  const manifest = entries.find((entry) => entry.name === "SKILL.md");
  if (manifest !== undefined) {
    const path = join(directory, manifest.name);
    try {
      if (statSync(path).isFile() && !matcher.ignores(relative(root, path).split(sep).join("/"))) {
        return loadFile(path, source);
      }
    } catch {
      // Continue scanning when an entry disappears.
    }
  }
  const result: LoadSkillsResult = { skills: [], diagnostics: [] };
  if (directory === root && rootMarkdown) {
    for (const entry of entries) {
      if (entry.name === "SKILL.md" || entry.name.startsWith(".") || !entry.name.endsWith(".md")) continue;
      const path = join(directory, entry.name);
      if (matcher.ignores(entry.name)) continue;
      const loaded = loadFile(path, source);
      result.skills.push(...loaded.skills);
      result.diagnostics.push(...loaded.diagnostics);
    }
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    let child = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try { child = statSync(path).isDirectory(); } catch { child = false; }
    }
    const local = relative(root, path).split(sep).join("/");
    if (!child || matcher.ignores(`${local}/`)) continue;
    const nested = scanDirectory(path, source, rootMarkdown, root, matcher, visited);
    result.skills.push(...nested.skills);
    result.diagnostics.push(...nested.diagnostics);
  }
  return result;
}

export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
  if (!existsSync(options.dir)) return { skills: [], diagnostics: [] };
  return scanDirectory(resolve(options.dir), options.source, true);
}

export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
  const cwd = resolvePath(options.cwd);
  const agentDir = resolvePath(options.agentDir);
  const userRoot = join(agentDir, "skills");
  const projectRoot = join(cwd, CONFIG_DIR_NAME, "skills");
  const byName = new Map<string, Skill>();
  const paths = new Set<string>();
  const diagnostics: ResourceDiagnostic[] = [];
  const add = (result: LoadSkillsResult): void => {
    diagnostics.push(...result.diagnostics);
    for (const skill of result.skills) {
      const canonical = canonicalizePath(skill.filePath);
      if (paths.has(canonical)) continue;
      const previous = byName.get(skill.name);
      if (previous !== undefined) {
        diagnostics.push({
          type: "collision",
          message: `skill ${JSON.stringify(skill.name)} has multiple definitions`,
          path: skill.filePath,
          collision: {
            resourceType: "skill",
            name: skill.name,
            winnerPath: previous.filePath,
            loserPath: skill.filePath,
          },
        });
        continue;
      }
      byName.set(skill.name, skill);
      paths.add(canonical);
    }
  };
  if (options.includeDefaults) {
    add(scanDirectory(userRoot, "user", true));
    add(scanDirectory(projectRoot, "project", true));
  }
  const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}${sep}`);
  for (const input of options.skillPaths) {
    const path = resolvePath(input, cwd, { trim: true });
    if (!existsSync(path)) {
      diagnostics.push({ type: "warning", message: "skill path does not exist", path });
      continue;
    }
    const source = !options.includeDefaults && under(path, userRoot)
      ? "user"
      : !options.includeDefaults && under(path, projectRoot) ? "project" : "path";
    try {
      const information = statSync(path);
      if (information.isDirectory()) add(scanDirectory(path, source, true));
      else if (information.isFile() && path.endsWith(".md")) add(loadFile(path, source));
      else diagnostics.push({ type: "warning", message: "skill path is not a markdown file", path });
    } catch (error) {
      diagnostics.push({ type: "warning", message: error instanceof Error ? error.message : String(error), path });
    }
  }
  return { skills: [...byName.values()], diagnostics };
}

export function formatSkillsForPrompt(skills: readonly Skill[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";
  const escape = (value: string): string => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
  return [
    "",
    "",
    "The following skills provide specialized instructions for specific tasks.",
    "Read a skill file when its description matches the work.",
    "Resolve paths mentioned by a skill relative to that skill's directory, and use absolute paths when invoking tools.",
    "",
    "<available_skills>",
    ...visible.flatMap((skill) => [
      "  <skill>",
      `    <name>${escape(skill.name)}</name>`,
      `    <description>${escape(skill.description)}</description>`,
      `    <location>${escape(skill.filePath)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}
