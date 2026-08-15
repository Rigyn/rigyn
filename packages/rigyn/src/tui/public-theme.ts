import { lstatSync } from "node:fs";
import { extname, join } from "node:path";
import type {
  EditorTheme,
  Keybinding,
  MarkdownTheme,
  SelectListTheme,
  SettingsListTheme,
} from "@rigyn/terminal";
import { getKeybindings } from "@rigyn/terminal";

import { getCustomThemesDir } from "../config/paths.js";
import { readTrustedTextFileSync } from "../core/resource-file.js";
import { renderSyntaxCodeLines } from "./markdown.js";
import { ThemeHotRefresher } from "./theme-hot-refresh.js";
import {
  createTheme,
  isBuiltinThemeName,
  normalizeThemeSetting,
  parseThemeDefinition,
  style,
  type Theme,
  type ThemeDefinition,
} from "./theme.js";
export type { ThemeColor } from "./theme.js";

let activeTheme = createTheme("signal", { color: process.env.NO_COLOR === undefined, unicode: true });
let activeThemeNames: readonly string[] = Object.freeze(["mono", "signal"]);
let themeWatcher: ThemeHotRefresher | undefined;

function capabilities(): { color: boolean; unicode: boolean } {
  return { color: process.env.NO_COLOR === undefined, unicode: true };
}

function customTheme(name: string): { definition: ThemeDefinition; sourcePath: string } {
  if (!/^[a-z][a-z0-9._-]{0,62}$/u.test(name)) throw new Error(`Invalid theme name: ${name}`);
  const sourcePath = join(getCustomThemesDir(), `${name}.json`);
  const information = lstatSync(sourcePath);
  if (!information.isFile() || information.isSymbolicLink() || information.size > 1024 * 1024) {
    throw new Error(`Theme path must be a regular file no larger than 1 MiB: ${sourcePath}`);
  }
  const source = readTrustedTextFileSync(sourcePath, 1024 * 1024, "Theme");
  const definition = parseThemeDefinition(JSON.parse(source) as unknown);
  if (definition.name !== name) throw new Error(`Theme definition does not match ${name}`);
  return { definition, sourcePath };
}

export function stopThemeWatcher(): void {
  themeWatcher?.close();
  themeWatcher = undefined;
}

export function initTheme(name = "signal", enableWatcher = false): void {
  stopThemeWatcher();
  const normalized = normalizeThemeSetting(name);
  if (isBuiltinThemeName(normalized)) {
    activeTheme = createTheme(normalized, capabilities());
    return;
  }
  const selected = customTheme(normalized);
  activeTheme = createTheme(normalized, capabilities(), selected.definition);
  if (!enableWatcher) return;
  themeWatcher = new ThemeHotRefresher({
    apply(definition) {
      activeTheme = createTheme(normalized, capabilities(), definition);
    },
  });
  themeWatcher.select({ name: normalized, sourcePath: selected.sourcePath });
}

/** @internal Synchronizes compatibility components with the active TUI owner. */
export function syncPublicTheme(theme: Theme, names?: readonly string[]): void {
  activeTheme = theme;
  if (names !== undefined) activeThemeNames = Object.freeze([...new Set(names)].sort());
}

export function currentTheme(): Theme {
  return activeTheme;
}

/** Resolved theme names available to module-level compatibility components. */
export function currentThemeNames(): readonly string[] {
  return activeThemeNames;
}

export function getLanguageFromPath(filePath: string): string | undefined {
  const language: Record<string, string> = {
    ".c": "c", ".cc": "cpp", ".cpp": "cpp", ".css": "css", ".go": "go",
    ".h": "c", ".hpp": "cpp", ".html": "html", ".java": "java", ".js": "javascript",
    ".json": "json", ".jsonc": "jsonc", ".jsx": "javascript", ".mjs": "javascript",
    ".py": "python", ".rb": "ruby", ".rs": "rust", ".sh": "shell", ".sql": "sql",
    ".swift": "swift", ".ts": "typescript", ".tsx": "typescript", ".xml": "html",
    ".yaml": "yaml", ".yml": "yaml", ".zsh": "shell",
  };
  return language[extname(filePath).toLowerCase()];
}

export function highlightCode(code: string, language = ""): string[] {
  const rendered = renderSyntaxCodeLines("", code, 500, language);
  if (rendered.length === 0) return code.split("\n");
  return rendered.map((line) => line.spans.map((span) =>
    span.role === undefined ? span.text : style(activeTheme, span.role, span.text)).join(""));
}

export function getMarkdownTheme(): MarkdownTheme {
  return {
    heading: (text) => activeTheme.fg("mdHeading", text),
    link: (text) => activeTheme.fg("mdLink", text),
    linkUrl: (text) => activeTheme.fg("mdLinkUrl", text),
    code: (text) => activeTheme.fg("mdCode", text),
    codeBlock: (text) => activeTheme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => activeTheme.fg("mdCodeBlockBorder", text),
    quote: (text) => activeTheme.fg("mdQuote", text),
    quoteBorder: (text) => activeTheme.fg("mdQuoteBorder", text),
    hr: (text) => activeTheme.fg("mdHr", text),
    listBullet: (text) => activeTheme.fg("mdListBullet", text),
    bold: (text) => activeTheme.bold(text),
    italic: (text) => activeTheme.italic(text),
    strikethrough: (text) => activeTheme.strikethrough(text),
    underline: (text) => activeTheme.underline(text),
    highlightCode,
  };
}

export function getSelectListTheme(): SelectListTheme {
  return {
    selectedPrefix: (text) => activeTheme.fg("accent", text),
    selectedText: (text) => activeTheme.bold(text),
    description: (text) => activeTheme.fg("muted", text),
    scrollInfo: (text) => activeTheme.fg("dim", text),
    noMatch: (text) => activeTheme.fg("warning", text),
  };
}

export function getSettingsListTheme(): SettingsListTheme {
  return {
    label: (text, selected) => selected ? activeTheme.bold(text) : text,
    value: (text, selected) => selected ? activeTheme.fg("accent", text) : activeTheme.fg("muted", text),
    description: (text) => activeTheme.fg("dim", text),
    cursor: activeTheme.fg("accent", "→ "),
    hint: (text) => activeTheme.fg("muted", text),
  };
}

export function getEditorTheme(): EditorTheme {
  return { borderColor: (text) => activeTheme.fg("borderAccent", text), selectList: getSelectListTheme() };
}

function displayKey(value: string): string {
  return value.split("+").map((part) => part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1)).join("+");
}

export function keyText(keybinding: Keybinding): string {
  const key = getKeybindings().getKeys(keybinding)[0];
  return key === undefined ? "" : displayKey(key);
}

export function keyHint(keybinding: Keybinding, description: string): string {
  const key = keyText(keybinding);
  return key === "" ? description : `${key} ${description}`;
}

export function rawKeyHint(key: string, description: string): string {
  return `${displayKey(key)} ${description}`;
}
