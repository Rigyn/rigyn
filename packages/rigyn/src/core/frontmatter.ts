import { parse as parseYaml } from "yaml";

export interface ParsedFrontmatter<T extends Record<string, unknown> = Record<string, unknown>> {
  frontmatter: T;
  body: string;
}

export function parseFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
  input: string,
): ParsedFrontmatter<T> {
  const normalized = input.replace(/\r\n?|\u2028|\u2029/gu, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {} as T, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end < 0 || (normalized[end + 4] !== undefined && normalized[end + 4] !== "\n")) {
    return { frontmatter: {} as T, body: normalized };
  }
  const decoded = parseYaml(normalized.slice(4, end));
  if (decoded !== null && (typeof decoded !== "object" || Array.isArray(decoded))) {
    throw new TypeError("Frontmatter must be a YAML mapping");
  }
  return {
    frontmatter: (decoded ?? {}) as T,
    body: normalized.slice(end + 4).trim(),
  };
}

export function stripFrontmatter(input: string): string {
  return parseFrontmatter(input).body;
}
