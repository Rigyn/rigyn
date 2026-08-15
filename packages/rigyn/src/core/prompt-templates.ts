import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

import type { ResourceDiagnostic } from "./diagnostics.js";
import { parseFrontmatter } from "./frontmatter.js";
import {
  readTrustedFileSync,
  TrustedResourceFileChangedError,
  TrustedResourceFileLimitError,
} from "./resource-file.js";
import type { SourceInfo } from "./source-info.js";

export interface PromptTemplate {
  name: string;
  description?: string;
  argumentHint?: string;
  content: string;
  filePath: string;
  sourceInfo: SourceInfo;
}

export interface LoadPromptTemplatesOptions {
  cwd: string;
  agentDir: string;
  promptPaths?: readonly string[];
  includeDefaults?: boolean;
  maxFileBytes?: number;
  diagnostics?: ResourceDiagnostic[];
}

const PROMPT_DISCOVERY_MAX_FILES = 1024;
const PROMPT_DISCOVERY_MAX_ENTRIES = 10_000;
const PROMPT_DISCOVERY_MAX_PATH_BYTES = 4 * 1024 * 1024;

class PromptDiscoveryLimitError extends Error {}

interface PromptCandidates {
  limited: boolean;
  paths: string[];
}

function maximumBytes(value: number | undefined): number {
  const selected = value ?? 1024 * 1024;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 16 * 1024 * 1024) {
    throw new RangeError("maxFileBytes must be an integer from 1 to 16777216");
  }
  return selected;
}

function candidates(path: string): PromptCandidates {
  try {
    const info = lstatSync(path);
    if (info.isFile() || info.isSymbolicLink()) {
      return { limited: false, paths: extname(path).toLowerCase() === ".md" ? [path] : [] };
    }
    if (!info.isDirectory()) return { limited: false, paths: [] };
    const handle = opendirSync(path);
    const selected: string[] = [];
    let entries = 0;
    let pathBytes = 0;
    let limited = false;
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        entries += 1;
        if (entries > PROMPT_DISCOVERY_MAX_ENTRIES) {
          throw new PromptDiscoveryLimitError(`Prompt discovery exceeds ${PROMPT_DISCOVERY_MAX_ENTRIES} directory entries`);
        }
        if (!(entry.isFile() || entry.isSymbolicLink()) || extname(entry.name).toLowerCase() !== ".md") continue;
        const candidate = join(path, entry.name);
        pathBytes += Buffer.byteLength(candidate);
        if (pathBytes > PROMPT_DISCOVERY_MAX_PATH_BYTES) {
          throw new PromptDiscoveryLimitError(`Prompt discovery exceeds ${PROMPT_DISCOVERY_MAX_PATH_BYTES} retained path bytes`);
        }
        if (selected.length < PROMPT_DISCOVERY_MAX_FILES) selected.push(candidate);
        else {
          limited = true;
          let maximumIndex = 0;
          for (let index = 1; index < selected.length; index += 1) {
            if (selected[index]!.localeCompare(selected[maximumIndex]!) > 0) maximumIndex = index;
          }
          if (candidate.localeCompare(selected[maximumIndex]!) < 0) selected[maximumIndex] = candidate;
        }
      }
    } finally {
      handle.closeSync();
    }
    return { limited, paths: selected.sort((left, right) => left.localeCompare(right)) };
  } catch (error) {
    if (error instanceof PromptDiscoveryLimitError) throw error;
    return { limited: false, paths: [] };
  }
}

export function loadPromptTemplates(options: LoadPromptTemplatesOptions): PromptTemplate[] {
  const maximum = maximumBytes(options.maxFileBytes);
  const diagnostics = options.diagnostics ?? [];
  const roots: Array<{ path: string; scope: SourceInfo["scope"] }> = [
    ...(options.includeDefaults === false ? [] : [
      { path: join(options.agentDir, "prompts"), scope: "user" as const },
      { path: join(options.cwd, ".rigyn", "prompts"), scope: "project" as const },
    ]),
    ...(options.promptPaths ?? []).map((path) => ({ path: resolve(path), scope: "temporary" as const })),
  ];
  const result = new Map<string, PromptTemplate>();
  const visited = new Set<string>();
  let discoveredFiles = 0;
  let discoveryStopped = false;
  for (const root of roots) {
    let selected: PromptCandidates;
    try { selected = candidates(root.path); }
    catch (error) {
      if (!(error instanceof PromptDiscoveryLimitError)) throw error;
      diagnostics.push({ type: "warning", message: error.message, path: root.path });
      continue;
    }
    if (selected.limited && !discoveryStopped) {
      diagnostics.push({ type: "warning", message: `Prompt discovery exceeds ${PROMPT_DISCOVERY_MAX_FILES} files`, path: root.path });
      discoveryStopped = true;
    }
    for (const candidate of selected.paths) {
      if (discoveredFiles >= PROMPT_DISCOVERY_MAX_FILES) {
        if (!discoveryStopped) {
          diagnostics.push({ type: "warning", message: `Prompt discovery exceeds ${PROMPT_DISCOVERY_MAX_FILES} files`, path: root.path });
          discoveryStopped = true;
        }
        break;
      }
      discoveredFiles += 1;
      let path: string;
      try { path = realpathSync(candidate); } catch { continue; }
      if (visited.has(path)) continue;
      visited.add(path);
      let bytes: Buffer;
      try { bytes = readTrustedFileSync(path, maximum, "Prompt template"); }
      catch (error) {
        if (error instanceof TrustedResourceFileLimitError) {
          diagnostics.push({ type: "warning", message: `Prompt template exceeds ${maximum} bytes`, path: candidate });
        } else if (error instanceof TrustedResourceFileChangedError) {
          diagnostics.push({ type: "warning", message: error.message, path: candidate });
        }
        continue;
      }
      let parsed: ReturnType<typeof parseFrontmatter<Record<string, unknown>>>;
      try { parsed = parseFrontmatter<Record<string, unknown>>(bytes.toString("utf8")); }
      catch {
        diagnostics.push({ type: "warning", message: "Prompt template metadata is invalid YAML", path: candidate });
        continue;
      }
      const name = basename(candidate, extname(candidate));
      if (result.has(name)) continue;
      const description = parsed.frontmatter.description;
      const argumentHint = parsed.frontmatter["argument-hint"];
      const sourceInfo: SourceInfo = {
        path: candidate,
        source: root.path,
        scope: root.scope,
        origin: "top-level",
        baseDir: dirname(path),
      };
      result.set(name, {
        name,
        ...(typeof description === "string" && description.trim() !== "" ? { description } : {}),
        ...(typeof argumentHint === "string" && argumentHint.trim() !== "" ? { argumentHint } : {}),
        content: parsed.body.replaceAll("{{promptDir}}", dirname(path)),
        filePath: candidate,
        sourceInfo,
      });
    }
  }
  return [...result.values()];
}

export function parseCommandArgs(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote !== undefined) {
      if (character === "\\" && value[index + 1] === quote) {
        current += "\\";
        index += 1;
      } else if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; quoted = true; continue; }
    if (/\s/u.test(character)) {
      if (current !== "") result.push(current);
      current = "";
      quoted = false;
      continue;
    }
    current += character;
  }
  if (current !== "" || (quoted && current !== "")) result.push(current);
  return result;
}

function all(argumentsValue: readonly string[]): string { return argumentsValue.join(" "); }

export function substituteArgs(template: string, argumentsValue: readonly string[]): string {
  return template.replace(/\$\{([^}]+)\}|\$ARGUMENTS|\$@|\$(\d+)/gu, (match, expression: string | undefined, position: string | undefined) => {
    if (expression !== undefined) {
      const fallback = /^([^:]+):-([\s\S]*)$/u.exec(expression);
      const key = fallback?.[1] ?? expression;
      const value = key === "@" || key === "ARGUMENTS"
        ? all(argumentsValue)
        : /^\d+$/u.test(key) ? argumentsValue[Number(key) - 1] ?? "" : match;
      if (fallback !== null) return value === "" ? fallback[2]! : value;
      const slice = /^@:(\d+)(?::(\d+))?$/u.exec(expression);
      if (slice !== null) {
        const start = Math.max(0, Number(slice[1]) - 1);
        const count = slice[2] === undefined ? undefined : Number(slice[2]);
        return argumentsValue.slice(start, count === undefined ? undefined : start + count).join(" ");
      }
      return value;
    }
    if (match === "$ARGUMENTS" || match === "$@") return all(argumentsValue);
    return argumentsValue[Number(position) - 1] ?? "";
  });
}

export function expandPromptTemplate(input: string, templates: readonly PromptTemplate[]): string {
  if (!input.startsWith("/")) return input;
  const boundary = input.search(/[\s]/u);
  const name = input.slice(1, boundary < 0 ? undefined : boundary);
  const template = templates.find((entry) => entry.name === name);
  if (template === undefined) return input;
  const argumentsText = boundary < 0 ? "" : input.slice(boundary).trim();
  return substituteArgs(template.content, parseCommandArgs(argumentsText));
}
