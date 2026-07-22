import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import { parseDocument } from "yaml";

import { CONFIG_DIR_NAME } from "../config/paths.js";
import { resolvePath } from "../utils/paths.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";

export interface PromptTemplate {
  name: string;
  description: string;
  argumentHint?: string;
  content: string;
  sourceInfo: SourceInfo;
  filePath: string;
}

const TEMPLATE_SUFFIX = /\.md$/iu;

export function parseCommandArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (const character of input) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (/\s/u.test(character)) {
      if (current !== "") {
        args.push(current);
        current = "";
      }
    } else current += character;
  }
  if (current !== "") args.push(current);
  return args;
}

export function substituteArgs(template: string, args: readonly string[]): string {
  const all = args.join(" ");
  return template.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/gu,
    (_token, defaultTarget: string | undefined, fallback: string | undefined, sliceStart: string | undefined, sliceLength: string | undefined, simple: string | undefined) => {
      if (defaultTarget !== undefined) {
        const value = defaultTarget === "@" || defaultTarget === "ARGUMENTS"
          ? all
          : args[Number(defaultTarget) - 1];
        return value || fallback || "";
      }
      if (sliceStart !== undefined) {
        const start = Math.max(0, Number(sliceStart) - 1);
        const length = sliceLength === undefined ? undefined : Number(sliceLength);
        return args.slice(start, length === undefined ? undefined : start + length).join(" ");
      }
      if (simple === "@" || simple === "ARGUMENTS") return all;
      return args[Number(simple) - 1] ?? "";
    },
  );
}

function frontmatter(source: string): { metadata: Record<string, unknown>; body: string } {
  const normalized = source.replace(/\r\n?/gu, "\n");
  if (!normalized.startsWith("---\n")) return { metadata: {}, body: normalized };
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return { metadata: {}, body: normalized };
  try {
    const document = parseDocument(normalized.slice(4, end), {
      schema: "core",
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) return { metadata: {}, body: normalized };
    const parsed = document.toJS() as unknown;
    return {
      metadata: parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {},
      body: normalized.slice(end + 5),
    };
  } catch {
    return { metadata: {}, body: normalized };
  }
}

function sourceInfoFor(path: string, globalRoot: string, projectRoot: string): SourceInfo {
  const under = (candidate: string, root: string): boolean => {
    const absoluteRoot = resolve(root);
    return candidate === absoluteRoot || candidate.startsWith(`${absoluteRoot}${sep}`);
  };
  if (under(path, globalRoot)) {
    return createSyntheticSourceInfo(path, { source: "local", scope: "user", baseDir: globalRoot });
  }
  if (under(path, projectRoot)) {
    return createSyntheticSourceInfo(path, { source: "local", scope: "project", baseDir: projectRoot });
  }
  return createSyntheticSourceInfo(path, {
    source: "local",
    baseDir: statSync(path).isDirectory() ? path : dirname(path),
  });
}

function loadFile(path: string, sourceInfo: SourceInfo): PromptTemplate | undefined {
  try {
    const parsed = frontmatter(readFileSync(path, "utf8"));
    const name = basename(path).replace(TEMPLATE_SUFFIX, "");
    const declaredDescription = parsed.metadata.description;
    const firstLine = parsed.body.split("\n").find((line) => line.trim() !== "") ?? "";
    const description = typeof declaredDescription === "string"
      ? declaredDescription
      : firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
    const hint = parsed.metadata["argument-hint"];
    return {
      name,
      description,
      ...(typeof hint === "string" && hint !== "" ? { argumentHint: hint } : {}),
      content: parsed.body.replaceAll("{{promptDir}}", dirname(path)),
      sourceInfo,
      filePath: path,
    };
  } catch {
    return undefined;
  }
}

function loadDirectory(directory: string, info: (path: string) => SourceInfo): PromptTemplate[] {
  if (!existsSync(directory)) return [];
  try {
    return readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .flatMap((entry) => {
        const path = join(directory, entry.name);
        let file = entry.isFile();
        if (entry.isSymbolicLink()) {
          try { file = statSync(path).isFile(); } catch { return []; }
        }
        if (!file || !TEMPLATE_SUFFIX.test(entry.name)) return [];
        const loaded = loadFile(path, info(path));
        return loaded === undefined ? [] : [loaded];
      });
  } catch {
    return [];
  }
}

export function loadPromptTemplates(options: {
  cwd: string;
  agentDir: string;
  promptPaths: string[];
  includeDefaults: boolean;
}): PromptTemplate[] {
  const cwd = resolvePath(options.cwd);
  const agentDir = resolvePath(options.agentDir);
  const globalRoot = join(agentDir, "prompts");
  const projectRoot = join(cwd, CONFIG_DIR_NAME, "prompts");
  const info = (path: string): SourceInfo => sourceInfoFor(resolve(path), globalRoot, projectRoot);
  const loaded: PromptTemplate[] = [];
  if (options.includeDefaults) {
    loaded.push(...loadDirectory(globalRoot, info));
    loaded.push(...loadDirectory(projectRoot, info));
  }
  for (const input of options.promptPaths) {
    const path = resolvePath(input, cwd, { trim: true });
    if (!existsSync(path)) continue;
    try {
      if (statSync(path).isDirectory()) loaded.push(...loadDirectory(path, info));
      else if (statSync(path).isFile() && TEMPLATE_SUFFIX.test(path)) {
        const template = loadFile(path, info(path));
        if (template !== undefined) loaded.push(template);
      }
    } catch {
      // A disappearing explicit path contributes no template.
    }
  }
  return loaded;
}

export function expandPromptTemplate(text: string, templates: readonly PromptTemplate[]): string {
  if (!text.startsWith("/")) return text;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(text);
  if (match === null) return text;
  const template = templates.find((candidate) => candidate.name === match[1]);
  return template === undefined
    ? text
    : substituteArgs(template.content, parseCommandArgs(match[2] ?? ""));
}
