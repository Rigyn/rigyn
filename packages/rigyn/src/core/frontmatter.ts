import { parse } from "yaml";

export interface ParsedFrontmatter<T extends Record<string, unknown>> {
  frontmatter: T;
  body: string;
}

/** Parse an optional YAML metadata block at the start of a text resource. */
export function parseFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
  content: string,
): ParsedFrontmatter<T> {
  const normalized = content.replace(/\r\n?/gu, "\n");
  if (!normalized.startsWith("---")) return { frontmatter: {} as T, body: normalized };
  const end = normalized.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {} as T, body: normalized };
  const yaml = normalized.slice(4, end);
  const body = normalized.slice(end + 4).trim();
  if (!yaml) return { frontmatter: {} as T, body };
  return { frontmatter: (parse(yaml) ?? {}) as T, body };
}

export function stripFrontmatter(content: string): string {
  return parseFrontmatter(content).body;
}
