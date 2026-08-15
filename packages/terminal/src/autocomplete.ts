import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { fuzzyFilter } from "./fuzzy.js";

export interface AutocompleteItem { value: string; label: string; description?: string }
export interface AutocompleteSuggestions { items: AutocompleteItem[]; prefix: string }
export interface AutocompleteProvider {
  readonly triggerCharacters?: readonly string[];
  getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<AutocompleteSuggestions | null>;
  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string): { lines: string[]; cursorLine: number; cursorCol: number };
  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}
export interface SlashCommand { name: string; description?: string; getArgumentCompletions?: (prefix: string, signal: AbortSignal) => AutocompleteItem[] | Promise<AutocompleteItem[]> }

export function resolveFileCompletionPath(value: string, basePath: string): { search: string; needle: string; parent: string } {
  const normalized = value.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  const originalSlash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  const parent = slash < 0 ? "" : normalized.slice(0, slash + 1);
  const needle = slash < 0 ? normalized : normalized.slice(slash + 1);
  const absolute = /^[A-Za-z]:\//u.test(normalized) || isAbsolute(normalized);
  return { search: slash < 0 ? basePath : absolute ? value.slice(0, originalSlash) : resolve(basePath, normalized.slice(0, slash)), needle, parent };
}

async function walk(root: string, directory = root, output: string[] = []): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(root, path, output);
    else output.push(relative(root, path).replaceAll("\\", "/"));
  }
  return output;
}

export class CombinedAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters = ["/", "@"] as const;
  constructor(readonly commands: readonly SlashCommand[], readonly basePath: string, readonly fdPath?: string) {}
  async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal }): Promise<AutocompleteSuggestions | null> {
    const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol);
    if (prefix.startsWith("/")) {
      const space = prefix.indexOf(" ");
      if (space < 0) {
        const query = prefix.slice(1);
        return { prefix, items: fuzzyFilter(this.commands, query, (item) => item.name).map((command) => ({ value: command.name, label: command.name, ...(command.description === undefined ? {} : { description: command.description }) })) };
      }
      const name = prefix.slice(1, space);
      const command = this.commands.find((item) => item.name === name);
      if (command?.getArgumentCompletions === undefined) return null;
      return { prefix, items: await command.getArgumentCompletions(prefix.slice(space + 1), options.signal) };
    }
    const marker = prefix.lastIndexOf("@");
    const fragment = marker >= 0 ? prefix.slice(marker + 1) : prefix;
    if (fragment === "" && marker < 0) return null;
    const resolved = resolveFileCompletionPath(fragment, this.basePath);
    let files: string[];
    if (marker >= 0 && this.fdPath !== undefined) files = await walk(this.basePath);
    else {
      let names;
      try { names = await readdir(resolved.search, { withFileTypes: true }); } catch { return null; }
      files = names.map((entry) => `${resolved.parent}${entry.name}${entry.isDirectory() ? "/" : ""}`);
    }
    const query = marker >= 0 ? fragment : resolved.needle;
    const matched = fuzzyFilter(files, query.replaceAll("/", ""), (value) => value.replaceAll("/", ""));
    return { prefix, items: matched.map((value) => ({ value: `${marker >= 0 ? "@" : ""}${value}`, label: value })) };
  }
  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string): { lines: string[]; cursorLine: number; cursorCol: number } {
    const copy = [...lines];
    const line = copy[cursorLine] ?? "";
    const start = Math.max(0, cursorCol - prefix.length);
    const slash = prefix.startsWith("/") && !item.value.startsWith("/") ? "/" : "";
    const value = `${slash}${item.value}${item.value.endsWith("/") ? "" : " "}`;
    copy[cursorLine] = `${line.slice(0, start)}${value}${line.slice(cursorCol)}`;
    return { lines: copy, cursorLine, cursorCol: start + value.length };
  }
}
