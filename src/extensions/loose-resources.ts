import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { parseDocument } from "yaml";

import { sha256 } from "../tools/hash.js";
import { parseThemeDefinition } from "../tui/theme.js";
import type { ExtensionPromptTemplate, ExtensionTheme } from "./types.js";

interface Frontmatter {
  body: string;
  description?: string;
  argumentHint?: string;
}

async function files(paths: readonly string[], extension: string): Promise<string[]> {
  const result: string[] = [];
  for (const requested of paths) {
    const path = resolve(requested);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (info.isFile()) {
      if (extname(path).toLowerCase() === extension) result.push(path);
      continue;
    }
    if (!info.isDirectory()) continue;
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && extname(entry.name).toLowerCase() === extension) result.push(join(path, entry.name));
    }
  }
  return [...new Set(result)];
}

function frontmatter(source: string): Frontmatter {
  const normalized = source.replace(/\r\n?/gu, "\n");
  if (!normalized.startsWith("---\n")) return { body: source };
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return { body: source };
  const document = parseDocument(normalized.slice(4, end), { schema: "core", uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`Prompt frontmatter is invalid: ${document.errors[0]!.message}`);
  const value = document.toJS() as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Prompt frontmatter must be a mapping");
  const record = value as Record<string, unknown>;
  const description = typeof record.description === "string" ? record.description.trim() : undefined;
  const argumentHint = typeof record["argument-hint"] === "string" ? record["argument-hint"].trim() : undefined;
  return {
    body: normalized.slice(end + 5),
    ...(description ? { description } : {}),
    ...(argumentHint ? { argumentHint } : {}),
  };
}

export async function loadPromptTemplates(paths: readonly string[]): Promise<ExtensionPromptTemplate[]> {
  const result = new Map<string, ExtensionPromptTemplate>();
  for (const path of await files(paths, ".md")) {
    const source = await readFile(path, "utf8");
    if (Buffer.byteLength(source, "utf8") > 1024 * 1024) throw new Error(`Prompt template exceeds 1 MiB: ${path}`);
    const parsed = frontmatter(source);
    const id = basename(path, extname(path));
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,62}$/u.test(id)) throw new Error(`Prompt template name is invalid: ${id}`);
    const firstLine = parsed.body.split("\n").find((line) => line.trim() !== "")?.trim();
    const description = parsed.description ?? firstLine;
    result.set(id, {
      id,
      extensionId: "prompt-template",
      ...(description === undefined || description === "" ? {} : { description }),
      ...(parsed.argumentHint === undefined ? {} : { argumentHint: parsed.argumentHint }),
      sourcePath: path,
      sha256: sha256(Buffer.from(source)),
      template: parsed.body,
    });
  }
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadThemes(paths: readonly string[]): Promise<ExtensionTheme[]> {
  const result = new Map<string, ExtensionTheme>();
  for (const path of await files(paths, ".json")) {
    const source = await readFile(path, "utf8");
    if (Buffer.byteLength(source, "utf8") > 1024 * 1024) throw new Error(`Theme exceeds 1 MiB: ${path}`);
    const definition = parseThemeDefinition(JSON.parse(source) as unknown);
    result.set(definition.name, {
      name: definition.name,
      extensionId: "theme",
      sourcePath: path,
      sha256: sha256(Buffer.from(source)),
      definition,
    });
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}
