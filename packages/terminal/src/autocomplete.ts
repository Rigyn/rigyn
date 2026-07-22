import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, posix, win32 } from "node:path";
import { fuzzyFilter } from "./fuzzy.js";

export interface AutocompleteItem { value: string; label: string; description?: string }
export interface SlashCommand { name: string; description?: string; argumentHint?: string; getArgumentCompletions?(prefix: string): AutocompleteItem[] | null | Promise<AutocompleteItem[] | null> }
export interface AutocompleteSuggestions { items: AutocompleteItem[]; prefix: string }
export interface AutocompleteProvider {
  triggerCharacters?: string[];
  getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<AutocompleteSuggestions | null>;
  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string): { lines: string[]; cursorLine: number; cursorCol: number };
  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

const delimiters = new Set([" ", "\t", "\"", "'", "="]);
function display(value: string): string { return value.replace(/\\/gu, "/"); }
function delimiter(value: string): number { for (let index = value.length - 1; index >= 0; index -= 1) if (delimiters.has(value[index]!)) return index; return -1; }
function quotePrefix(value: string): string | undefined {
  let open = -1;
  for (let index = 0; index < value.length; index += 1) if (value[index] === "\"") open = open < 0 ? index : -1;
  if (open < 0) return undefined;
  const start = open > 0 && value[open - 1] === "@" ? open - 1 : open;
  return start === 0 || delimiters.has(value[start - 1]!) ? value.slice(start) : undefined;
}
function parsePrefix(value: string): { path: string; attachment: boolean; quoted: boolean } {
  const attachment = value.startsWith("@"); const quoted = value.startsWith("\"") || value.startsWith("@\"");
  return { path: value.slice((attachment ? 1 : 0) + (quoted ? 1 : 0)), attachment, quoted };
}
function completion(path: string, attachment: boolean, quoted: boolean): string {
  const quote = quoted || path.includes(" "); return `${attachment ? "@" : ""}${quote ? `\"${path}\"` : path}`;
}
function expandHome(value: string): string { return value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) + (value.endsWith("/") ? "/" : "") : value; }

/** @internal Resolves typed path syntax without depending on the host running the test. */
export function resolveFileCompletionPath(value: string, basePath: string): { search: string; needle: string; parent: string } {
  const expanded = expandHome(value); const normalized = display(value);
  const paths = /^[A-Za-z]:[\\/]/u.test(value) || value.includes("\\") ? win32 : process.platform === "win32" ? win32 : posix;
  const directory = ["", "./", "../", "~", "~/", "/"].includes(normalized) || normalized.endsWith("/");
  const searchPath = directory ? expanded : paths.dirname(expanded); const needle = directory ? "" : paths.basename(expanded);
  const search = paths.isAbsolute(searchPath) ? searchPath : join(basePath, display(searchPath));
  const parent = normalized.endsWith("/") ? normalized : normalized.includes("/") ? display(paths.dirname(value)).replace(/\/?$/u, "/") : "";
  return { search, needle, parent };
}

async function fdSearch(executable: string, cwd: string, query: string, signal: AbortSignal): Promise<Array<{ path: string; directory: boolean }>> {
  if (signal.aborted) return [];
  const normalized = display(query); const expression = normalized.includes("/") ? normalized.split("/").filter(Boolean).map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[\\\\/]") + (normalized.endsWith("/") ? "[\\\\/]" : "") : query;
  const args = ["--base-directory", cwd, "--max-results", "100", "--type", "f", "--type", "d", "--follow", "--hidden", "--exclude", ".git", "--exclude", ".git/**"];
  if (normalized.includes("/")) args.push("--full-path"); if (query) args.push(expression);
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "ignore"] }); let output = ""; let settled = false;
    const finish = (value: Array<{ path: string; directory: boolean }>) => { if (settled) return; settled = true; signal.removeEventListener("abort", abort); resolve(value); };
    const abort = () => child.kill("SIGKILL"); signal.addEventListener("abort", abort, { once: true }); child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", () => finish([])); child.on("close", (code) => finish(signal.aborted || code !== 0 ? [] : output.trim().split("\n").filter(Boolean).map(display).filter((path) => path !== ".git" && !path.includes("/.git/")).map((path) => ({ path, directory: path.endsWith("/") }))));
  });
}

export class CombinedAutocompleteProvider implements AutocompleteProvider {
  readonly #commands: Array<SlashCommand | AutocompleteItem>;
  readonly #basePath: string;
  readonly #fd: string | null;
  constructor(commands: Array<SlashCommand | AutocompleteItem> = [], basePath: string, fdPath: string | null = null) { this.#commands = commands; this.#basePath = basePath; this.#fd = fdPath; }

  async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<AutocompleteSuggestions | null> {
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol); const attachment = this.#attachmentPrefix(before);
    if (attachment) { const parsed = parsePrefix(attachment); const items = await this.#fuzzyFiles(parsed.path, parsed.quoted, options.signal); return items.length ? { items, prefix: attachment } : null; }
    if (!options.force && before.startsWith("/")) {
      const space = before.indexOf(" ");
      if (space < 0) {
        const query = before.slice(1); const candidates = this.#commands.map((command) => {
          const name = "name" in command ? command.name : command.value; const hint = "argumentHint" in command ? command.argumentHint : undefined; const description = [hint, command.description].filter(Boolean).join(hint && command.description ? " — " : "");
          return { value: name, label: name, ...(description ? { description } : {}) };
        });
        const items = fuzzyFilter(candidates, query, (item) => item.value); return items.length ? { items, prefix: before } : null;
      }
      const name = before.slice(1, space); const argument = before.slice(space + 1); const command = this.#commands.find((candidate) => ("name" in candidate ? candidate.name : candidate.value) === name);
      if (!command || !("getArgumentCompletions" in command) || !command.getArgumentCompletions) return null;
      const items = await command.getArgumentCompletions(argument); return items?.length ? { items, prefix: argument } : null;
    }
    const prefix = this.#pathPrefix(before, options.force ?? false); if (prefix === null) return null;
    const items = this.#files(prefix); return items.length ? { items, prefix } : null;
  }

  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string): { lines: string[]; cursorLine: number; cursorCol: number } {
    const result = [...lines]; const line = result[cursorLine] ?? ""; const before = line.slice(0, cursorCol - prefix.length); let after = line.slice(cursorCol);
    if ((prefix.startsWith("\"") || prefix.startsWith("@\"")) && item.value.endsWith("\"") && after.startsWith("\"")) after = after.slice(1);
    const command = prefix.startsWith("/") && before.trim() === "" && !prefix.slice(1).includes("/");
    if (command) { result[cursorLine] = `${before}/${item.value} ${after}`; return { lines: result, cursorLine, cursorCol: before.length + item.value.length + 2 }; }
    const directory = item.label.endsWith("/"); const suffix = prefix.startsWith("@") && !directory ? " " : ""; result[cursorLine] = before + item.value + suffix + after;
    const quoteAdjustment = directory && item.value.endsWith("\"") ? 1 : 0; return { lines: result, cursorLine, cursorCol: before.length + item.value.length - quoteAdjustment + suffix.length };
  }

  #attachmentPrefix(value: string): string | undefined {
    const quoted = quotePrefix(value); if (quoted?.startsWith("@\"")) return quoted;
    const start = delimiter(value) + 1; return value[start] === "@" ? value.slice(start) : undefined;
  }
  #pathPrefix(value: string, force: boolean): string | null {
    const quoted = quotePrefix(value); if (quoted) return quoted;
    const prefix = value.slice(delimiter(value) + 1); if (force) return prefix;
    return prefix.includes("/") || prefix.includes("\\") || prefix.startsWith(".") || prefix.startsWith("~/") || (prefix === "" && value.endsWith(" ")) ? prefix : null;
  }

  #files(prefix: string): AutocompleteItem[] {
    try {
      const parsed = parsePrefix(prefix); const { search, needle, parent } = resolveFileCompletionPath(parsed.path, this.#basePath);
      return readdirSync(search, { withFileTypes: true }).flatMap((entry) => {
        if (!entry.name.toLowerCase().startsWith(needle.toLowerCase())) return [];
        let directory = entry.isDirectory(); if (!directory && entry.isSymbolicLink()) try { directory = statSync(join(search, entry.name)).isDirectory(); } catch { /* broken link remains a file */ }
        let path = display(parent === "./" ? `./${entry.name}` : parent + entry.name); if (directory) path += "/";
        return [{ value: completion(path, parsed.attachment, parsed.quoted), label: entry.name + (directory ? "/" : "") }];
      }).sort((a, b) => Number(!a.label.endsWith("/")) - Number(!b.label.endsWith("/")) || a.label.localeCompare(b.label));
    } catch { return []; }
  }

  async #fuzzyFiles(query: string, quoted: boolean, signal: AbortSignal): Promise<AutocompleteItem[]> {
    if (!this.#fd) return [];
    const normalized = display(query); const slash = normalized.lastIndexOf("/"); let cwd = this.#basePath; let needle = normalized; let displayBase = "";
    if (slash >= 0) { const scopedBase = normalized.slice(0, slash + 1); const scopedCwd = scopedBase.startsWith("~/") ? expandHome(scopedBase) : scopedBase.startsWith("/") ? scopedBase : join(this.#basePath, scopedBase); try { if (statSync(scopedCwd).isDirectory()) { displayBase = scopedBase; needle = normalized.slice(slash + 1); cwd = scopedCwd; } } catch { /* search the full path when the prefix is a fuzzy fragment */ } }
    const found = await fdSearch(this.#fd, cwd, needle, signal); if (signal.aborted) return [];
    const score = (path: string, directory: boolean) => { const name = basename(path).toLowerCase(); const q = needle.toLowerCase(); const value = name === q ? 100 : name.startsWith(q) ? 80 : name.includes(q) ? 50 : path.toLowerCase().includes(q) ? 30 : 0; return value + (directory && value ? 10 : 0); };
    return found.map((item) => ({ ...item, score: score(item.path, item.directory) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 20).map((item) => {
      const raw = item.directory ? item.path.slice(0, -1) : item.path; const path = displayBase + raw + (item.directory ? "/" : ""); return { value: completion(path, true, quoted), label: basename(raw) + (item.directory ? "/" : ""), description: displayBase + raw };
    });
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol).trim(); return !(before.startsWith("/") && !before.includes(" "));
  }
}
