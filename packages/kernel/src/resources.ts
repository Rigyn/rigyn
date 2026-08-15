import createIgnore from "ignore";
import { parse as parseYaml } from "yaml";

import { type ExecutionEnv, type FileInfo, type Result } from "./harness/types.js";

const FILE_LIMIT = 1024 * 1024;
const TOTAL_PROMPT_LIMIT = 16 * 1024 * 1024;
const PROMPT_FILE_LIMIT = 1024;
const DIRECTORY_ENTRY_LIMIT = 10_000;
const DIRECTORY_DEPTH_LIMIT = 64;

export interface ResourceDiagnostic<TSource = unknown> {
  code: "read_failed" | "list_failed" | "invalid_metadata";
  path: string;
  message: string;
  source?: TSource;
}

export interface Skill {
  name: string;
  description: string;
  content: string;
  filePath: string;
  disableModelInvocation?: boolean;
  metadata?: Readonly<Record<string, string>>;
}

export interface PromptTemplate {
  name: string;
  content: string;
  description?: string;
  filePath?: string;
}

export interface LoadSkillsResult<TSource = never> {
  skills: Array<TSource extends never ? Skill : { skill: Skill; source: TSource }>;
  diagnostics: Array<ResourceDiagnostic<TSource>>;
}

export interface LoadPromptTemplatesResult<TSource = never> {
  promptTemplates: Array<TSource extends never ? PromptTemplate : PromptTemplate & { source: TSource }>;
  diagnostics: Array<ResourceDiagnostic<TSource>>;
}

interface ParsedDocument {
  metadata: Record<string, unknown>;
  body: string;
}

interface PromptBudget {
  files: number;
  bytes: number;
  stopped: boolean;
}

function leafName(path: string): string {
  return path.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) ?? path;
}

function parentName(path: string): string {
  const parts = path.includes("/")
    ? path.replace(/\/+$/u, "").split("/")
    : path.replace(/[\\/]+$/u, "").split(/[\\/]/u);
  return parts.at(-1) ?? path;
}

function withoutMarkdownExtension(path: string): string {
  return leafName(path).replace(/\.md$/iu, "");
}

function frontmatter(value: string): ParsedDocument {
  const normalized = value.replace(/\r\n?/gu, "\n");
  if (!normalized.startsWith("---\n")) return { metadata: {}, body: normalized };
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return { metadata: {}, body: normalized };
  const selected = parseYaml(normalized.slice(4, end));
  const metadata = typeof selected === "object" && selected !== null && !Array.isArray(selected)
    ? selected as Record<string, unknown>
    : {};
  return { metadata, body: normalized.slice(end + 5) };
}

async function boundedText(env: ExecutionEnv, path: string, maximum = FILE_LIMIT): Promise<Result<string, Error>> {
  const result = await env.readBinaryFile(path, undefined, maximum);
  if (!result.ok) return result;
  if (result.value.byteLength > maximum) return { ok: false, error: new Error(`${path} exceeds ${maximum}-byte read limit`) };
  try {
    return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(result.value) };
  } catch {
    return { ok: false, error: new Error(`${path} is not valid UTF-8`) };
  }
}

function diagnostic<TSource>(
  code: ResourceDiagnostic<TSource>["code"],
  path: string,
  message: string,
  source?: TSource,
): ResourceDiagnostic<TSource> {
  return { code, path, message, ...(source === undefined ? {} : { source }) };
}

async function loadSkillFile<TSource>(
  env: ExecutionEnv,
  filePath: string,
  directoryPath: string,
  rootPath: string,
  source: TSource | undefined,
  diagnostics: Array<ResourceDiagnostic<TSource>>,
): Promise<Skill | undefined> {
  const loaded = await boundedText(env, filePath);
  if (!loaded.ok) {
    diagnostics.push(diagnostic("read_failed", filePath, loaded.error.message, source));
    return undefined;
  }
  let parsed: ParsedDocument;
  try { parsed = frontmatter(loaded.value); } catch (error) {
    diagnostics.push(diagnostic("invalid_metadata", filePath, `Invalid skill metadata: ${error instanceof Error ? error.message : "parse failed"}`, source));
    return undefined;
  }
  const name = parsed.metadata.name;
  const description = parsed.metadata.description;
  if (typeof name !== "string" || name.trim() === "") {
    diagnostics.push(diagnostic("invalid_metadata", filePath, "Skill name is required", source));
    return undefined;
  }
  if (typeof description !== "string" || description.trim() === "") {
    diagnostics.push(diagnostic("invalid_metadata", filePath, "Skill description is required", source));
    return undefined;
  }
  const expected = parentName(directoryPath);
  if (directoryPath !== rootPath || expected.toLowerCase() !== "skills") {
    if (name !== expected) {
      diagnostics.push(diagnostic(
        "invalid_metadata",
        filePath,
        `Skill name ${JSON.stringify(name)} differs from directory "${expected.replaceAll('"', '\\"')}"`,
        source,
      ));
    }
  }
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.metadata)) {
    if (key !== "name" && key !== "description" && key !== "disable-model-invocation" && typeof value === "string") metadata[key] = value;
  }
  return {
    name,
    description,
    content: parsed.body,
    filePath,
    ...(parsed.metadata["disable-model-invocation"] === true ? { disableModelInvocation: true } : {}),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
}

async function discoverSkills<TSource>(
  env: ExecutionEnv,
  rootPath: string,
  source: TSource | undefined,
): Promise<{ skills: Skill[]; diagnostics: Array<ResourceDiagnostic<TSource>> }> {
  const diagnostics: Array<ResourceDiagnostic<TSource>> = [];
  const skills: Skill[] = [];
  const rootInfo = await env.fileInfo(rootPath);
  if (!rootInfo.ok) {
    diagnostics.push(diagnostic("read_failed", rootPath, rootInfo.error.message, source));
    return { skills, diagnostics };
  }
  if (rootInfo.value.kind === "file" || rootInfo.value.kind === "symlink") {
    const skill = await loadSkillFile(env, rootPath, rootPath, rootPath, source, diagnostics);
    if (skill !== undefined) skills.push(skill);
    return { skills, diagnostics };
  }
  if (rootInfo.value.kind !== "directory") {
    diagnostics.push(diagnostic("list_failed", rootPath, "Skill root is not a directory", source));
    return { skills, diagnostics };
  }

  const seen = new Set<string>();
  const visit = async (directory: string, relative: string, depth: number, inheritedPatterns: readonly string[]): Promise<void> => {
    if (depth >= DIRECTORY_DEPTH_LIMIT) {
      diagnostics.push(diagnostic("list_failed", directory, `${DIRECTORY_DEPTH_LIMIT}-directory depth limit exceeded`, source));
      return;
    }
    const canonical = await env.canonicalPath(directory);
    if (canonical.ok) {
      if (seen.has(canonical.value)) return;
      seen.add(canonical.value);
    }
    const listing = await env.listDir(directory);
    if (!listing.ok) {
      diagnostics.push(diagnostic("list_failed", directory, listing.error.message, source));
      return;
    }
    if (listing.value.length > DIRECTORY_ENTRY_LIMIT) {
      diagnostics.push(diagnostic("list_failed", directory, `${DIRECTORY_ENTRY_LIMIT}-entry limit exceeded`, source));
      return;
    }

    const patterns = [...inheritedPatterns];
    const ignoreEntry = listing.value.find((entry) => entry.name === ".gitignore" && entry.kind !== "directory");
    if (ignoreEntry !== undefined) {
      const ignored = await boundedText(env, ignoreEntry.path);
      if (ignored.ok) {
        for (const line of ignored.value.split(/\r?\n/u)) {
          const trimmed = line.trim();
          if (trimmed !== "" && !trimmed.startsWith("#")) patterns.push(relative === "" ? trimmed : `${relative}/${trimmed}`);
        }
      }
    }
    const matcher = createIgnore().add(patterns);
    const manifest = listing.value.find((entry) => entry.name.toUpperCase() === "SKILL.MD" && entry.kind !== "directory");
    if (manifest !== undefined) {
      const skill = await loadSkillFile(env, manifest.path, directory, rootPath, source, diagnostics);
      if (skill !== undefined) skills.push(skill);
    }
    for (const entry of listing.value) {
      if (entry.kind !== "directory") continue;
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (matcher.ignores(`${childRelative}/`)) continue;
      await visit(entry.path, childRelative, depth + 1, patterns);
    }
  };

  await visit(rootPath, "", 0, []);
  skills.sort((left, right) => left.name.localeCompare(right.name) || left.filePath.localeCompare(right.filePath));
  return { skills, diagnostics };
}

export async function loadSkills(env: ExecutionEnv, path: string): Promise<LoadSkillsResult> {
  const loaded = await discoverSkills(env, path, undefined);
  return loaded as LoadSkillsResult;
}

export async function loadSourcedSkills<TSource>(
  env: ExecutionEnv,
  roots: readonly { path: string; source: TSource }[],
): Promise<LoadSkillsResult<TSource>> {
  const skills: Array<{ skill: Skill; source: TSource }> = [];
  const diagnostics: Array<ResourceDiagnostic<TSource>> = [];
  for (const root of roots) {
    const loaded = await discoverSkills(env, root.path, root.source);
    skills.push(...loaded.skills.map((skill) => ({ skill, source: root.source })));
    diagnostics.push(...loaded.diagnostics);
  }
  return { skills, diagnostics } as LoadSkillsResult<TSource>;
}

async function promptCandidates<TSource>(
  env: ExecutionEnv,
  path: string,
  source: TSource | undefined,
  diagnostics: Array<ResourceDiagnostic<TSource>>,
): Promise<FileInfo[]> {
  const info = await env.fileInfo(path);
  if (!info.ok) {
    diagnostics.push(diagnostic("read_failed", path, info.error.message, source));
    return [];
  }
  if (info.value.kind === "file" || info.value.kind === "symlink") return [info.value];
  if (info.value.kind !== "directory") return [];
  const listing = await env.listDir(path);
  if (!listing.ok) {
    diagnostics.push(diagnostic("list_failed", path, listing.error.message, source));
    return [];
  }
  return listing.value
    .filter((entry) => entry.kind !== "directory" && /\.md$/iu.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function discoverPrompts<TSource>(
  env: ExecutionEnv,
  path: string,
  source: TSource | undefined,
  budget: PromptBudget,
): Promise<{ promptTemplates: PromptTemplate[]; diagnostics: Array<ResourceDiagnostic<TSource>> }> {
  const diagnostics: Array<ResourceDiagnostic<TSource>> = [];
  const promptTemplates: PromptTemplate[] = [];
  const candidates = await promptCandidates(env, path, source, diagnostics);
  for (const entry of candidates) {
    if (budget.files >= PROMPT_FILE_LIMIT) {
      if (!budget.stopped) diagnostics.push(diagnostic("list_failed", path, `Prompt discovery is limited to ${PROMPT_FILE_LIMIT} files`, source));
      budget.stopped = true;
      break;
    }
    if (entry.size > FILE_LIMIT) {
      diagnostics.push(diagnostic("read_failed", entry.path, `Prompt file exceeds ${FILE_LIMIT} bytes`, source));
      continue;
    }
    if (budget.bytes + entry.size > TOTAL_PROMPT_LIMIT) {
      diagnostics.push(diagnostic("read_failed", entry.path, `Prompt discovery exceeds ${TOTAL_PROMPT_LIMIT} aggregate bytes`, source));
      budget.stopped = true;
      break;
    }
    const loaded = await boundedText(env, entry.path);
    if (!loaded.ok) {
      diagnostics.push(diagnostic("read_failed", entry.path, loaded.error.message, source));
      continue;
    }
    const bytes = Buffer.byteLength(loaded.value, "utf8");
    if (budget.bytes + bytes > TOTAL_PROMPT_LIMIT) {
      diagnostics.push(diagnostic("read_failed", entry.path, `Prompt discovery exceeds ${TOTAL_PROMPT_LIMIT} aggregate bytes`, source));
      budget.stopped = true;
      break;
    }
    budget.bytes += bytes;
    budget.files += 1;
    let parsed: ParsedDocument;
    try { parsed = frontmatter(loaded.value); } catch (error) {
      diagnostics.push(diagnostic("invalid_metadata", entry.path, error instanceof Error ? error.message : "Invalid prompt metadata", source));
      continue;
    }
    promptTemplates.push({
      name: withoutMarkdownExtension(entry.name),
      content: parsed.body,
      ...(typeof parsed.metadata.description === "string" ? { description: parsed.metadata.description } : {}),
      filePath: entry.path,
    });
  }
  return { promptTemplates, diagnostics };
}

export async function loadPromptTemplates(env: ExecutionEnv, path: string): Promise<LoadPromptTemplatesResult> {
  const loaded = await discoverPrompts(env, path, undefined, { files: 0, bytes: 0, stopped: false });
  return loaded as LoadPromptTemplatesResult;
}

export async function loadSourcedPromptTemplates<TSource>(
  env: ExecutionEnv,
  roots: readonly { path: string; source: TSource }[],
): Promise<LoadPromptTemplatesResult<TSource>> {
  const promptTemplates: Array<PromptTemplate & { source: TSource }> = [];
  const diagnostics: Array<ResourceDiagnostic<TSource>> = [];
  const budget: PromptBudget = { files: 0, bytes: 0, stopped: false };
  for (const root of roots) {
    if (budget.stopped) break;
    const loaded = await discoverPrompts(env, root.path, root.source, budget);
    promptTemplates.push(...loaded.promptTemplates.map((template) => ({ ...template, source: root.source })));
    diagnostics.push(...loaded.diagnostics);
  }
  return { promptTemplates, diagnostics } as LoadPromptTemplatesResult<TSource>;
}

export function formatPromptTemplateInvocation(template: Pick<PromptTemplate, "content">, argumentsValue: readonly string[]): string {
  return template.content.replace(/\$\{@:([1-9]\d*)(?::([1-9]\d*))?\}|\$@|\$([1-9]\d*)/gu, (matched, startText: string | undefined, countText: string | undefined, indexText: string | undefined) => {
    if (matched === "$@") return argumentsValue.join(" ");
    if (indexText !== undefined) return argumentsValue[Number(indexText) - 1] ?? "";
    const start = Number(startText) - 1;
    const end = countText === undefined ? undefined : start + Number(countText);
    return argumentsValue.slice(start, end).join(" ");
  });
}

function xml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

export function formatSkillsForSystemPrompt(skills: readonly Skill[]): string {
  const visible = skills.filter((skill) => skill.disableModelInvocation !== true);
  if (visible.length === 0) return "";
  return `<available_skills>\n${visible.map((skill) => [
    "<skill>",
    `<name>${xml(skill.name)}</name>`,
    `<description>${xml(skill.description)}</description>`,
    `<location>${xml(skill.filePath)}</location>`,
    "</skill>",
  ].join("\n")).join("\n")}\n</available_skills>`;
}
