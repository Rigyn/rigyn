import ignore from "ignore";
import { parse } from "yaml";
import type { ExecutionEnv, FileInfo, Result, Skill } from "./types.js";
import { toError } from "./types.js";

export type SkillDiagnosticCode = "file_info_failed" | "list_failed" | "read_failed" | "parse_failed" | "invalid_metadata";
export interface SkillDiagnostic { type: "warning"; code: SkillDiagnosticCode; message: string; path: string; }
const windowsPath = (path: string): boolean => /^[a-z]:[\\/]/iu.test(path) || path.startsWith("\\\\");
const trim = (path: string): string => path.replace(windowsPath(path) ? /[\\/]+$/u : /\/+$/u, "");
const dirname = (path: string): string => { const normalized = trim(path); const index = windowsPath(path) ? Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\")) : normalized.lastIndexOf("/"); return index <= 0 ? "/" : normalized.slice(0, index); };
const basename = (path: string): string => trim(path).split(windowsPath(path) ? /[\\/]/u : /\//u).at(-1) ?? path;
const relative = (root: string, path: string): string => { const windows = windowsPath(root) || windowsPath(path); const normalizedRoot = trim(windows ? root.replace(/\\/gu, "/") : root); const normalizedPath = windows ? path.replace(/\\/gu, "/") : path; return normalizedPath === normalizedRoot ? "" : normalizedPath.startsWith(`${normalizedRoot}/`) ? normalizedPath.slice(normalizedRoot.length + 1) : normalizedPath.replace(/^\/+/, ""); };

function parseFrontmatter(content: string): Result<{ metadata: Record<string, unknown>; body: string }, Error> {
  try { const text = content.replace(/\r\n?/g, "\n"); if (!text.startsWith("---")) return { ok: true, value: { metadata: {}, body: text } }; const end = text.indexOf("\n---", 3); if (end < 0) return { ok: true, value: { metadata: {}, body: text } }; return { ok: true, value: { metadata: (parse(text.slice(4, end)) ?? {}) as Record<string, unknown>, body: text.slice(end + 4).trim() } }; } catch (error) { return { ok: false, error: toError(error) }; }
}
async function kind(env: ExecutionEnv, info: FileInfo, diagnostics: SkillDiagnostic[]): Promise<"file" | "directory" | undefined> { if (info.kind !== "symlink") return info.kind; const canonical = await env.canonicalPath(info.path); if (!canonical.ok) { if (canonical.error.code !== "not_found") diagnostics.push({ type: "warning", code: "file_info_failed", message: canonical.error.message, path: info.path }); return undefined; } const target = await env.fileInfo(canonical.value); if (!target.ok) { if (target.error.code !== "not_found") diagnostics.push({ type: "warning", code: "file_info_failed", message: target.error.message, path: info.path }); return undefined; } return target.value.kind === "file" || target.value.kind === "directory" ? target.value.kind : undefined; }
async function loadSkill(env: ExecutionEnv, path: string): Promise<{ skill: Skill | null; diagnostics: SkillDiagnostic[] }> {
  const raw = await env.readTextFile(path); if (!raw.ok) return { skill: null, diagnostics: [{ type: "warning", code: "read_failed", message: raw.error.message, path }] };
  const parsed = parseFrontmatter(raw.value); if (!parsed.ok) return { skill: null, diagnostics: [{ type: "warning", code: "parse_failed", message: parsed.error.message, path }] };
  const diagnostics: SkillDiagnostic[] = []; const parent = basename(dirname(path)); const supplied = typeof parsed.value.metadata.name === "string" ? parsed.value.metadata.name : undefined; const name = supplied || parent; const description = typeof parsed.value.metadata.description === "string" ? parsed.value.metadata.description : undefined;
  const errors: string[] = []; if (name !== parent) errors.push(`name "${name}" does not match parent directory "${parent}"`); if (name.length > 64) errors.push(`name exceeds 64 characters (${name.length})`); if (!/^[a-z0-9-]+$/.test(name)) errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)"); if (name.startsWith("-") || name.endsWith("-")) errors.push("name must not start or end with a hyphen"); if (name.includes("--")) errors.push("name must not contain consecutive hyphens"); if (!description?.trim()) errors.push("description is required"); else if (description.length > 1024) errors.push(`description exceeds 1024 characters (${description.length})`);
  for (const message of errors) diagnostics.push({ type: "warning", code: "invalid_metadata", message, path });
  return !description?.trim() ? { skill: null, diagnostics } : { skill: { name, description, content: parsed.value.body, filePath: path, disableModelInvocation: parsed.value.metadata["disable-model-invocation"] === true }, diagnostics };
}
async function walk(env: ExecutionEnv, dir: string, root: string, rootFiles: boolean, matcher: ReturnType<typeof ignore>): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
  const skills: Skill[] = []; const diagnostics: SkillDiagnostic[] = []; const listed = await env.listDir(dir); if (!listed.ok) return { skills, diagnostics: [{ type: "warning", code: "list_failed", message: listed.error.message, path: dir }] };
  for (const ignoreName of [".gitignore", ".ignore", ".fdignore"]) {
    const path = `${trim(dir)}/${ignoreName}`;
    const info = await env.fileInfo(path);
    if (!info.ok) { if (info.error.code !== "not_found") diagnostics.push({ type: "warning", code: "file_info_failed", message: info.error.message, path }); continue; }
    if (info.value.kind !== "file") continue;
    const read = await env.readTextFile(path);
    if (!read.ok) { diagnostics.push({ type: "warning", code: "read_failed", message: read.error.message, path }); continue; }
    const prefix = relative(root, dir);
    const patterns = read.value.split(/\r?\n/u).map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return "";
      let pattern = line;
      let negated = false;
      if (pattern.startsWith("!")) { negated = true; pattern = pattern.slice(1); }
      else if (pattern.startsWith("\\!")) pattern = pattern.slice(1);
      if (pattern.startsWith("/")) pattern = pattern.slice(1);
      const scoped = prefix ? `${prefix}/${pattern}` : pattern;
      return negated ? `!${scoped}` : scoped;
    }).filter(Boolean);
    if (patterns.length) matcher.add(patterns);
  }
  const skillFile = listed.value.find((entry) => entry.name === "SKILL.md");
  if (skillFile && await kind(env, skillFile, diagnostics) === "file" && !matcher.ignores(relative(root, skillFile.path))) { const loaded = await loadSkill(env, skillFile.path); if (loaded.skill) skills.push(loaded.skill); diagnostics.push(...loaded.diagnostics); return { skills, diagnostics }; }
  for (const entry of listed.value.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue; const entryKind = await kind(env, entry, diagnostics); if (!entryKind) continue; const rel = relative(root, entry.path); if (matcher.ignores(entryKind === "directory" ? `${rel}/` : rel)) continue;
    if (entryKind === "directory") { const nested = await walk(env, entry.path, root, false, matcher); skills.push(...nested.skills); diagnostics.push(...nested.diagnostics); }
    else if (rootFiles && entry.name.endsWith(".md")) { const loaded = await loadSkill(env, entry.path); if (loaded.skill) skills.push(loaded.skill); diagnostics.push(...loaded.diagnostics); }
  }
  return { skills, diagnostics };
}
export async function loadSkills(env: ExecutionEnv, dirs: string | string[]): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> { const skills: Skill[] = []; const diagnostics: SkillDiagnostic[] = []; for (const dir of Array.isArray(dirs) ? dirs : [dirs]) { const info = await env.fileInfo(dir); if (!info.ok) { if (info.error.code !== "not_found") diagnostics.push({ type: "warning", code: "file_info_failed", message: info.error.message, path: dir }); continue; } if (await kind(env, info.value, diagnostics) !== "directory") continue; const loaded = await walk(env, info.value.path, info.value.path, true, ignore()); skills.push(...loaded.skills); diagnostics.push(...loaded.diagnostics); } return { skills, diagnostics }; }
export async function loadSourcedSkills<TSource, TSkill extends Skill = Skill>(env: ExecutionEnv, inputs: Array<{ path: string; source: TSource }>, map?: (skill: Skill, source: TSource) => TSkill): Promise<{ skills: Array<{ skill: TSkill; source: TSource }>; diagnostics: Array<SkillDiagnostic & { source: TSource }> }> { const skills: Array<{ skill: TSkill; source: TSource }> = []; const diagnostics: Array<SkillDiagnostic & { source: TSource }> = []; for (const input of inputs) { const loaded = await loadSkills(env, input.path); for (const skill of loaded.skills) skills.push({ skill: map ? map(skill, input.source) : skill as TSkill, source: input.source }); for (const diagnostic of loaded.diagnostics) diagnostics.push({ ...diagnostic, source: input.source }); } return { skills, diagnostics }; }
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string { const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dirname(skill.filePath)}.\n\n${skill.content}\n</skill>`; return additionalInstructions ? `${block}\n\n${additionalInstructions}` : block; }
