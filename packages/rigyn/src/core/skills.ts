import { lstatSync, opendirSync, realpathSync, type Dirent } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

import type { ResourceDiagnostic } from "./diagnostics.js";
import { parseFrontmatter } from "./frontmatter.js";
import {
  readTrustedFileSync,
  readTrustedTextFileSync,
  TrustedResourceFileChangedError,
  TrustedResourceFileLimitError,
} from "./resource-file.js";
import type { SourceInfo } from "./source-info.js";

export interface SkillFrontmatter extends Record<string, unknown> {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
}

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  sourceInfo: SourceInfo;
  disableModelInvocation: boolean;
  maxFileBytes?: number;
  frontmatter?: SkillFrontmatter;
}

export interface LoadSkillsOptions {
  cwd: string;
  agentDir: string;
  skillPaths?: readonly string[];
  includeDefaults?: boolean;
  maxFileBytes?: number;
  strictSkillRoots?: ReadonlyMap<string, string>;
}

export interface LoadSkillsFromDirOptions {
  scope?: SourceInfo["scope"];
  maxFileBytes?: number;
  strictSkillRoots?: ReadonlyMap<string, string>;
}

export interface LoadSkillsResult { skills: Skill[]; diagnostics: ResourceDiagnostic[] }

// Discovery retains at most this structural budget across all selected roots.
const SKILL_DISCOVERY_MAX_ENTRIES = 10_000;
const SKILL_DISCOVERY_MAX_DEPTH = 64;
const SKILL_DISCOVERY_MAX_PATH_BYTES = 4 * 1024 * 1024;

class SkillDiscoveryLimitError extends Error {}

interface SkillDiscoveryBudget {
  entries: number;
  pathBytes: number;
}

function maximumBytes(value: number | undefined): number {
  const selected = value ?? 1024 * 1024;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 16 * 1024 * 1024) {
    throw new RangeError("maxFileBytes must be an integer from 1 to 16777216");
  }
  return selected;
}

function ignoredNames(root: string, maximum: number): Set<string> {
  const ignored = new Set<string>();
  for (const file of [".gitignore", ".ignore", ".fdignore"]) {
    try {
      for (const line of readTrustedTextFileSync(
        join(root, file),
        maximum,
        "Skill ignore file",
        { rejectSymbolicLink: true },
      ).split(/\r?\n/u)) {
        const value = line.trim();
        if (value === "" || value.startsWith("#") || value.startsWith("!")) continue;
        const simple = value.replace(/\/$/u, "");
        if (!simple.includes("/") && !simple.includes("*")) ignored.add(simple);
      }
    } catch { /* Optional ignore file. */ }
  }
  return ignored;
}

function boundedEntries(path: string, budget: SkillDiscoveryBudget): Dirent[] {
  const handle = opendirSync(path);
  const entries: Dirent[] = [];
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      budget.entries += 1;
      if (budget.entries > SKILL_DISCOVERY_MAX_ENTRIES) {
        throw new SkillDiscoveryLimitError(`Skill discovery exceeds ${SKILL_DISCOVERY_MAX_ENTRIES} entries`);
      }
      entries.push(entry);
    }
  } finally {
    handle.closeSync();
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function discover(
  path: string,
  output: string[],
  visited: Set<string>,
  budget: SkillDiscoveryBudget,
  maximum: number,
  depth = 0,
): void {
  if (depth > SKILL_DISCOVERY_MAX_DEPTH) {
    throw new SkillDiscoveryLimitError(`Skill discovery exceeds maximum depth ${SKILL_DISCOVERY_MAX_DEPTH}`);
  }
  let canonical: string;
  let info: ReturnType<typeof lstatSync>;
  try { canonical = realpathSync(path); info = lstatSync(canonical); } catch { return; }
  if (visited.has(canonical)) return;
  budget.pathBytes += Buffer.byteLength(canonical);
  if (budget.pathBytes > SKILL_DISCOVERY_MAX_PATH_BYTES) {
    throw new SkillDiscoveryLimitError(`Skill discovery exceeds ${SKILL_DISCOVERY_MAX_PATH_BYTES} retained path bytes`);
  }
  visited.add(canonical);
  if (info.isFile()) {
    if (basename(canonical).toLowerCase() === "skill.md" || extname(canonical).toLowerCase() === ".md") output.push(canonical);
    return;
  }
  if (!info.isDirectory()) return;
  const manifest = join(canonical, "SKILL.md");
  try {
    if (lstatSync(manifest).isFile()) { output.push(manifest); return; }
  } catch { /* Continue recursively. */ }
  const ignored = ignoredNames(canonical, maximum);
  for (const entry of boundedEntries(canonical, budget)) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || ignored.has(entry.name)) continue;
    discover(join(canonical, entry.name), output, visited, budget, maximum, depth + 1);
  }
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
  const maximum = maximumBytes(options.maxFileBytes);
  const roots: Array<{ path: string; scope: SourceInfo["scope"] }> = [
    ...(options.includeDefaults === false ? [] : [
      { path: join(options.agentDir, "skills"), scope: "user" as const },
      { path: join(options.cwd, ".rigyn", "skills"), scope: "project" as const },
    ]),
    ...(options.skillPaths ?? []).map((path) => ({ path: resolve(path), scope: "temporary" as const })),
  ];
  const diagnostics: ResourceDiagnostic[] = [];
  const skills = new Map<string, Skill>();
  const visited = new Set<string>();
  const discoveryBudget: SkillDiscoveryBudget = { entries: 0, pathBytes: 0 };
  for (const root of roots) {
    const manifests: string[] = [];
    try {
      discover(root.path, manifests, visited, discoveryBudget, maximum);
    } catch (error) {
      if (!(error instanceof SkillDiscoveryLimitError)) throw error;
      diagnostics.push({ type: "warning", path: root.path, message: error.message });
      continue;
    }
    for (const manifest of manifests) {
      let bytes: Buffer;
      try { bytes = readTrustedFileSync(manifest, maximum, "Skill file"); }
      catch (error) {
        if (error instanceof TrustedResourceFileLimitError) {
          diagnostics.push({ type: "warning", path: manifest, message: `Skill file exceeds ${maximum} bytes` });
        } else if (error instanceof TrustedResourceFileChangedError) {
          diagnostics.push({ type: "warning", path: manifest, message: error.message });
        }
        continue;
      }
      let parsed: ReturnType<typeof parseFrontmatter<SkillFrontmatter>>;
      try { parsed = parseFrontmatter<SkillFrontmatter>(bytes.toString("utf8")); }
      catch {
        diagnostics.push({ type: "warning", path: manifest, message: "skill metadata is invalid YAML" });
        continue;
      }
      const declared = parsed.frontmatter.name;
      const name = typeof declared === "string" && declared !== "" ? declared : basename(dirname(manifest));
      const description = parsed.frontmatter.description;
      if (typeof description !== "string" || description.trim() === "") {
        diagnostics.push({ type: "warning", path: manifest, message: "skill metadata needs a non-blank description" });
        continue;
      }
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
        diagnostics.push({ type: "warning", path: manifest, message: "skill name should use lowercase letters, digits, and single hyphens" });
        if (name.includes("--")) diagnostics.push({ type: "warning", path: manifest, message: "skill name cannot include '--'" });
      }
      if (description.length > 1024) diagnostics.push({ type: "warning", path: manifest, message: "skill description maximum is 1024 characters" });
      const strictRoot = options.strictSkillRoots?.get(manifest) ?? options.strictSkillRoots?.get(realpathSync(manifest));
      if (strictRoot !== undefined && name !== basename(dirname(manifest))) {
        diagnostics.push({ type: "warning", code: "PORTABLE_PLUGIN_SKILL_INVALID", path: manifest, message: "Portable skill name must match its directory" });
        continue;
      }
      const prior = skills.get(name);
      if (prior !== undefined) {
        diagnostics.push({
          type: "collision",
          path: manifest,
          message: `Skill ${name} collides with ${prior.filePath}`,
          collision: {
				name,
				winnerPath: prior.filePath,
				loserPath: manifest,
				resourceType: "skill",
			},
        });
        continue;
      }
      const sourceInfo: SourceInfo = {
        path: manifest,
        source: root.path,
        scope: root.scope,
        origin: strictRoot === undefined ? "top-level" : "package",
        baseDir: dirname(manifest),
      };
      skills.set(name, {
        name,
        description,
        filePath: manifest,
        baseDir: dirname(manifest),
        sourceInfo,
        disableModelInvocation: parsed.frontmatter["disable-model-invocation"] === true,
        maxFileBytes: maximum,
        frontmatter: parsed.frontmatter,
      });
    }
  }
  return { skills: [...skills.values()], diagnostics };
}

export function loadSkillsFromDir(path: string, options: LoadSkillsFromDirOptions = {}): LoadSkillsResult {
  return loadSkills({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    skillPaths: [path],
    includeDefaults: false,
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
    ...(options.strictSkillRoots === undefined ? {} : { strictSkillRoots: options.strictSkillRoots }),
  });
}

export function formatSkillsForPrompt(skills: readonly Skill[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";
  return [
    "<available_skills>",
    "Read the selected SKILL.md and resolve relative references relative to that skill's directory.",
    ...visible.flatMap((skill) => [
      "<skill>",
      `<name>${escapeXml(skill.name)}</name>`,
      `<description>${escapeXml(skill.description)}</description>`,
      `<location>${escapeXml(skill.filePath)}</location>`,
      "</skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}
