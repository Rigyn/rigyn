import { parse } from "yaml";
import type { ExecutionEnv, FileInfo, PromptTemplate, Result } from "./types.js";
import { toError } from "./types.js";

export type PromptTemplateDiagnosticCode = "file_info_failed" | "list_failed" | "read_failed" | "parse_failed";
export interface PromptTemplateDiagnostic { type: "warning"; code: PromptTemplateDiagnosticCode; message: string; path: string; }

function frontmatter(content: string): Result<{ metadata: Record<string, unknown>; body: string }, Error> {
  try {
    const text = content.replace(/\r\n?/g, "\n");
    if (!text.startsWith("---")) return { ok: true, value: { metadata: {}, body: text } };
    const end = text.indexOf("\n---", 3);
    if (end < 0) return { ok: true, value: { metadata: {}, body: text } };
    return { ok: true, value: { metadata: (parse(text.slice(4, end)) ?? {}) as Record<string, unknown>, body: text.slice(end + 4).trim() } };
  } catch (error) { return { ok: false, error: toError(error) }; }
}
async function resolvedKind(env: ExecutionEnv, info: FileInfo, diagnostics: PromptTemplateDiagnostic[]): Promise<"file" | "directory" | undefined> {
  if (info.kind !== "symlink") return info.kind;
  const canonical = await env.canonicalPath(info.path); if (!canonical.ok) { if (canonical.error.code !== "not_found") diagnostics.push({ type: "warning", code: "file_info_failed", message: canonical.error.message, path: info.path }); return undefined; }
  const target = await env.fileInfo(canonical.value); if (!target.ok) { if (target.error.code !== "not_found") diagnostics.push({ type: "warning", code: "file_info_failed", message: target.error.message, path: info.path }); return undefined; }
  return target.value.kind === "file" || target.value.kind === "directory" ? target.value.kind : undefined;
}
async function loadFile(env: ExecutionEnv, info: FileInfo): Promise<{ promptTemplate: PromptTemplate | null; diagnostics: PromptTemplateDiagnostic[] }> {
  const diagnostics: PromptTemplateDiagnostic[] = []; const raw = await env.readTextFile(info.path);
  if (!raw.ok) return { promptTemplate: null, diagnostics: [{ type: "warning", code: "read_failed", message: raw.error.message, path: info.path }] };
  const parsed = frontmatter(raw.value); if (!parsed.ok) return { promptTemplate: null, diagnostics: [{ type: "warning", code: "parse_failed", message: parsed.error.message, path: info.path }] };
  const line = parsed.value.body.split("\n").find((candidate) => candidate.trim()); let description = typeof parsed.value.metadata.description === "string" ? parsed.value.metadata.description : "";
  if (!description && line) description = line.length > 60 ? `${line.slice(0, 60)}...` : line;
  return { promptTemplate: { name: info.name.replace(/\.md$/i, ""), description, content: parsed.value.body }, diagnostics };
}
export async function loadPromptTemplates(env: ExecutionEnv, paths: string | string[]): Promise<{ promptTemplates: PromptTemplate[]; diagnostics: PromptTemplateDiagnostic[] }> {
  const promptTemplates: PromptTemplate[] = []; const diagnostics: PromptTemplateDiagnostic[] = [];
  for (const path of Array.isArray(paths) ? paths : [paths]) {
    const result = await env.fileInfo(path); if (!result.ok) { if (result.error.code !== "not_found") diagnostics.push({ type: "warning", code: "file_info_failed", message: result.error.message, path }); continue; }
    const kind = await resolvedKind(env, result.value, diagnostics);
    if (kind === "file" && result.value.name.endsWith(".md")) { const loaded = await loadFile(env, result.value); if (loaded.promptTemplate) promptTemplates.push(loaded.promptTemplate); diagnostics.push(...loaded.diagnostics); }
    else if (kind === "directory") {
      const listed = await env.listDir(result.value.path); if (!listed.ok) { diagnostics.push({ type: "warning", code: "list_failed", message: listed.error.message, path: result.value.path }); continue; }
      for (const entry of listed.value.sort((a, b) => a.name.localeCompare(b.name))) if (entry.name.endsWith(".md") && await resolvedKind(env, entry, diagnostics) === "file") { const loaded = await loadFile(env, entry); if (loaded.promptTemplate) promptTemplates.push(loaded.promptTemplate); diagnostics.push(...loaded.diagnostics); }
    }
  }
  return { promptTemplates, diagnostics };
}
export async function loadSourcedPromptTemplates<TSource, TPrompt extends PromptTemplate = PromptTemplate>(env: ExecutionEnv, inputs: Array<{ path: string; source: TSource }>, map?: (template: PromptTemplate, source: TSource) => TPrompt): Promise<{ promptTemplates: Array<{ promptTemplate: TPrompt; source: TSource }>; diagnostics: Array<PromptTemplateDiagnostic & { source: TSource }> }> {
  const promptTemplates: Array<{ promptTemplate: TPrompt; source: TSource }> = []; const diagnostics: Array<PromptTemplateDiagnostic & { source: TSource }> = [];
  for (const input of inputs) { const loaded = await loadPromptTemplates(env, input.path); for (const template of loaded.promptTemplates) promptTemplates.push({ promptTemplate: map ? map(template, input.source) : template as TPrompt, source: input.source }); for (const diagnostic of loaded.diagnostics) diagnostics.push({ ...diagnostic, source: input.source }); }
  return { promptTemplates, diagnostics };
}
export function parseCommandArgs(text: string): string[] { const args: string[] = []; let current = ""; let quote: string | undefined; for (const character of text) { if (quote) { if (character === quote) quote = undefined; else current += character; } else if (character === "'" || character === '"') quote = character; else if (character === " " || character === "\t") { if (current) { args.push(current); current = ""; } } else current += character; } if (current) args.push(current); return args; }
export function substituteArgs(content: string, args: string[]): string { return content.replace(/\$(\d+)/g, (_, n: string) => args[Number(n) - 1] ?? "").replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, start: string, length?: string) => args.slice(Math.max(0, Number(start) - 1), length ? Math.max(0, Number(start) - 1) + Number(length) : undefined).join(" ")).replace(/\$ARGUMENTS|\$@/g, args.join(" ")); }
export const formatPromptTemplateInvocation = (template: PromptTemplate, args: string[] = []): string => substituteArgs(template.content, args);
