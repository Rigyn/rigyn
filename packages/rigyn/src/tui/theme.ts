import type { ThemeName } from "./types.js";
import type { SourceInfo } from "../core/source-info.js";

export type ThemeRole =
  | "title"
  | "muted"
  | "accent"
  | "info"
  | "link"
  | "code"
  | "border"
  | "editor"
  | "editorActive"
  | "working"
  | "user"
  | "assistant"
  | "success"
  | "warning"
  | "error"
  | "selection"
  | "userMessage"
  | "toolPending"
  | "toolRunning"
  | "toolSuccess"
  | "toolError";

export const THEME_TOKENS = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "selectedBg",
  "userMessageBg",
  "userMessageText",
  "customMessageBg",
  "customMessageText",
  "customMessageLabel",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
  "bashMode",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];
export type ThemeColorValue = "" | number | `#${string}`;

export const THEME_BACKGROUND_TOKENS = [
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
] as const satisfies readonly ThemeToken[];

export type ThemeBg = (typeof THEME_BACKGROUND_TOKENS)[number];
export type ThemeColor = Exclude<ThemeToken, ThemeBg>;
export type ThemeColorMode = "truecolor" | "256color";

export interface Theme {
  name: ThemeName;
  ansi: boolean;
  unicode: boolean;
  glyphs: {
    assistant: string;
    user: string;
    tool: string;
    success: string;
    failure: string;
    pending: string;
    scroll: string;
    horizontal: string;
  };
  codes: Record<ThemeRole, string>;
  fg(color: ThemeColor, text: string): string;
  bg(color: ThemeBg, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
  inverse(text: string): string;
  strikethrough(text: string): string;
  getFgAnsi(color: ThemeColor): string;
  getBgAnsi(color: ThemeBg): string;
  getColorMode(): ThemeColorMode;
  getThinkingBorderColor(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"): (text: string) => string;
  getBashModeBorderColor(): (text: string) => string;
}

/** Runtime theme constructor exposed to extension authors. */
const runtimeThemeForeground = new WeakMap<object, Map<ThemeColor, string>>();
const runtimeThemeBackground = new WeakMap<object, Map<ThemeBg, string>>();
const runtimeThemeMode = new WeakMap<object, ThemeColorMode>();
const runtimeCubeValues = [0, 95, 135, 175, 215, 255] as const;
const runtimeGrayValues = Array.from({ length: 24 }, (_, index) => 8 + index * 10);

function runtimeRgbTo256(red: number, green: number, blue: number): number {
  const nearest = (values: readonly number[], value: number): number => {
    let selected = 0;
    for (let index = 1; index < values.length; index += 1) {
      if (Math.abs(values[index]! - value) < Math.abs(values[selected]! - value)) selected = index;
    }
    return selected;
  };
  const redIndex = nearest(runtimeCubeValues, red);
  const greenIndex = nearest(runtimeCubeValues, green);
  const blueIndex = nearest(runtimeCubeValues, blue);
  const cube = 16 + 36 * redIndex + 6 * greenIndex + blueIndex;
  const distance = (leftRed: number, leftGreen: number, leftBlue: number, rightRed: number, rightGreen: number, rightBlue: number) => {
    const redDelta = leftRed - rightRed;
    const greenDelta = leftGreen - rightGreen;
    const blueDelta = leftBlue - rightBlue;
    return redDelta * redDelta * 0.299 + greenDelta * greenDelta * 0.587 + blueDelta * blueDelta * 0.114;
  };
  const cubeDistance = distance(red, green, blue, runtimeCubeValues[redIndex]!, runtimeCubeValues[greenIndex]!, runtimeCubeValues[blueIndex]!);
  const grayValue = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);
  const grayIndex = nearest(runtimeGrayValues, grayValue);
  const gray = runtimeGrayValues[grayIndex]!;
  const grayDistance = distance(red, green, blue, gray, gray, gray);
  return Math.max(red, green, blue) - Math.min(red, green, blue) < 10 && grayDistance < cubeDistance ? 232 + grayIndex : cube;
}

function runtimeColorAnsi(value: string | number, background: boolean, mode: ThemeColorMode): string {
  if (value === "") return `\u001b[${background ? 49 : 39}m`;
  if (typeof value === "number") return `\u001b[${background ? 48 : 38};5;${value}m`;
  if (!/^#[0-9a-f]{6}$/iu.test(value)) throw new Error(`Invalid color value: ${value}`);
  const red = Number.parseInt(value.slice(1, 3), 16);
  const green = Number.parseInt(value.slice(3, 5), 16);
  const blue = Number.parseInt(value.slice(5, 7), 16);
  return mode === "truecolor"
    ? `\u001b[${background ? 48 : 38};2;${red};${green};${blue}m`
    : `\u001b[${background ? 48 : 38};5;${runtimeRgbTo256(red, green, blue)}m`;
}

export const Theme = class Theme {
  readonly name?: string;
  readonly sourcePath?: string;
  sourceInfo?: SourceInfo;

  constructor(
    foreground: Record<ThemeColor, string | number>,
    background: Record<ThemeBg, string | number>,
    mode: ThemeColorMode,
    options: { name?: string; sourcePath?: string; sourceInfo?: SourceInfo } = {},
  ) {
    const resolvedForeground = new Map<ThemeColor, string>();
    const resolvedBackground = new Map<ThemeBg, string>();
    runtimeThemeForeground.set(this, resolvedForeground);
    runtimeThemeBackground.set(this, resolvedBackground);
    runtimeThemeMode.set(this, mode);
    if (options.name !== undefined) this.name = options.name;
    if (options.sourcePath !== undefined) this.sourcePath = options.sourcePath;
    if (options.sourceInfo !== undefined) this.sourceInfo = options.sourceInfo;
    const colors = {
      ...foreground,
      thinkingMax: foreground.thinkingMax ?? foreground.thinkingXhigh,
    };
    for (const [name, value] of Object.entries(colors) as Array<[ThemeColor, string | number]>) {
      resolvedForeground.set(name, runtimeColorAnsi(value, false, mode));
    }
    for (const [name, value] of Object.entries(background) as Array<[ThemeBg, string | number]>) {
      resolvedBackground.set(name, runtimeColorAnsi(value, true, mode));
    }
  }

  fg(color: ThemeColor, text: string): string { return `${this.getFgAnsi(color)}${text}\u001b[39m`; }
  bg(color: ThemeBg, text: string): string { return `${this.getBgAnsi(color)}${text}\u001b[49m`; }
  bold(text: string): string { return `\u001b[1m${text}\u001b[22m`; }
  italic(text: string): string { return `\u001b[3m${text}\u001b[23m`; }
  underline(text: string): string { return `\u001b[4m${text}\u001b[24m`; }
  inverse(text: string): string { return `\u001b[7m${text}\u001b[27m`; }
  strikethrough(text: string): string { return `\u001b[9m${text}\u001b[29m`; }
  getFgAnsi(color: ThemeColor): string {
    const value = runtimeThemeForeground.get(this)?.get(color);
    if (value === undefined) throw new Error(`Unknown theme color: ${color}`);
    return value;
  }
  getBgAnsi(color: ThemeBg): string {
    const value = runtimeThemeBackground.get(this)?.get(color);
    if (value === undefined) throw new Error(`Unknown theme background color: ${color}`);
    return value;
  }
  getColorMode(): ThemeColorMode { return runtimeThemeMode.get(this) ?? "256color"; }
  getThinkingBorderColor(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"): (text: string) => string {
    const token: ThemeColor = level === "minimal" ? "thinkingMinimal"
      : level === "low" ? "thinkingLow"
      : level === "medium" ? "thinkingMedium"
      : level === "high" ? "thinkingHigh"
      : level === "xhigh" ? "thinkingXhigh"
      : level === "max" ? "thinkingMax"
      : "thinkingOff";
    return (text) => this.fg(token, text);
  }
  getBashModeBorderColor(): (text: string) => string { return (text) => this.fg("bashMode", text); }
};

export interface ThemeStyleDefinition {
  foreground?: ThemeColorValue;
  background?: number | `#${string}`;
  bold?: boolean;
  italic?: boolean;
}

export interface ThemeExportDefinition {
  pageBg?: ThemeColorValue;
  cardBg?: ThemeColorValue;
  infoBg?: ThemeColorValue;
}

export interface ThemeDefinition {
  schemaVersion: 1;
  name: string;
  base: "dark" | "light";
  styles: Partial<Record<ThemeRole, ThemeStyleDefinition>>;
  /** Fully resolved semantic tokens when the source used the token-shaped contract. */
  tokens?: Readonly<Record<ThemeToken, ThemeColorValue>>;
  /** Fully resolved export backgrounds; omitted fields inherit the message background token. */
  export?: Readonly<ThemeExportDefinition>;
}

export interface ThemeContrastDiagnostic {
  role: ThemeRole;
  ratio: number;
  minimum: number;
  message: string;
}

export interface AutomaticThemePair {
  readonly light: string;
  readonly dark: string;
}

export const THEME_SCHEMA_URI = "urn:rigyn:schema:theme:v1";

const reset = "\u001b[0m";
const themeName = /^[a-z][a-z0-9._-]{0,62}$/u;
const hexColor = /^#[0-9a-f]{6}$/iu;
const REQUIRED_THEME_TOKENS = THEME_TOKENS.filter((token) => token !== "thinkingMax") as readonly Exclude<ThemeToken, "thinkingMax">[];
export const THEME_ROLES: readonly ThemeRole[] = [
  "title",
  "muted",
  "accent",
  "info",
  "link",
  "code",
  "border",
  "editor",
  "editorActive",
  "working",
  "user",
  "assistant",
  "success",
  "warning",
  "error",
  "selection",
  "userMessage",
  "toolPending",
  "toolRunning",
  "toolSuccess",
  "toolError",
];

/**
 * A paired setting uses `LIGHT/DARK`. Theme names themselves cannot contain a
 * slash, so the form is unambiguous and remains a single backwards-compatible
 * configuration value.
 */
export function parseAutomaticThemePair(value: string): AutomaticThemePair | undefined {
  const parts = value.split("/");
  if (parts.length === 1) return undefined;
  if (parts.length !== 2) throw new Error("Automatic theme setting must use LIGHT/DARK");
  const light = parts[0]!.trim();
  const dark = parts[1]!.trim();
  if (!themeName.test(light) || !themeName.test(dark)) {
    throw new Error("Automatic theme setting must contain two valid theme names");
  }
  return Object.freeze({ light, dark });
}

export function resolveThemeSetting(value: string, terminal: "dark" | "light"): string {
  const pair = parseAutomaticThemePair(value);
  if (pair !== undefined) return terminal === "light" ? pair.light : pair.dark;
  if (!themeName.test(value)) throw new Error("Theme must be a valid name or LIGHT/DARK pair");
  return value;
}

const glyphs = {
  assistant: "◆",
  user: "›",
  tool: "▸",
  success: "✓",
  failure: "✗",
  pending: "…",
  scroll: "↕",
  horizontal: "─",
};

const asciiGlyphs = {
  assistant: "A",
  user: ">",
  tool: ">",
  success: "+",
  failure: "x",
  pending: ".",
  scroll: "^",
  horizontal: "-",
};

const palettes: Record<"dark" | "light", Record<ThemeRole, string>> = {
  dark: {
    title: "\u001b[1;97m",
    muted: "\u001b[38;5;245m",
    accent: "\u001b[38;5;81m",
    info: "\u001b[38;5;117m",
    link: "\u001b[4;38;5;81m",
    code: "\u001b[38;5;252m",
    border: "\u001b[38;5;240m",
    editor: "\u001b[38;5;252m",
    editorActive: "\u001b[38;5;81m",
    working: "\u001b[38;5;117m",
    user: "\u001b[38;5;117m",
    assistant: "\u001b[38;5;252m",
    success: "\u001b[38;5;114m",
    warning: "\u001b[38;5;221m",
    error: "\u001b[38;5;203m",
    selection: "\u001b[38;5;117;48;5;237m",
    userMessage: "\u001b[38;5;255;48;5;236m",
    toolPending: "\u001b[38;5;252;48;5;235m",
    toolRunning: "\u001b[38;5;117;48;5;235m",
    toolSuccess: "\u001b[38;5;151m",
    toolError: "\u001b[38;5;224m",
  },
  light: {
    title: "\u001b[1;30m",
    muted: "\u001b[38;5;242m",
    accent: "\u001b[38;5;25m",
    info: "\u001b[38;5;24m",
    link: "\u001b[4;38;5;25m",
    code: "\u001b[38;5;238m",
    border: "\u001b[38;5;250m",
    editor: "\u001b[38;5;238m",
    editorActive: "\u001b[38;5;25m",
    working: "\u001b[38;5;24m",
    user: "\u001b[38;5;24m",
    assistant: "\u001b[38;5;238m",
    success: "\u001b[38;5;28m",
    warning: "\u001b[38;5;130m",
    error: "\u001b[38;5;160m",
    selection: "\u001b[38;5;25;48;5;254m",
    userMessage: "\u001b[38;5;234;48;5;254m",
    toolPending: "\u001b[38;5;238;48;5;252m",
    toolRunning: "\u001b[38;5;24;48;5;153m",
    toolSuccess: "\u001b[38;5;28m",
    toolError: "\u001b[38;5;160m",
  },
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function allowed(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown keys: ${unknown.join(", ")}`);
}

function color(value: unknown, label: string, empty: false): number | `#${string}` | undefined;
function color(value: unknown, label: string, empty: true): "" | number | `#${string}` | undefined;
function color(value: unknown, label: string, empty: boolean): "" | number | `#${string}` | undefined {
  if (value === undefined) return undefined;
  if (value === "" && empty) return "";
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 255) return value;
  if (typeof value === "string" && hexColor.test(value)) return value as `#${string}`;
  throw new Error(`${label} must be a 0-255 palette index${empty ? ", an empty default color," : ""} or #RRGGBB`);
}

function tokenTheme(value: Record<string, unknown>): ThemeDefinition {
  allowed(value, ["$schema", "schemaVersion", "name", "base", "vars", "colors", "export"], "theme");
  if (value.$schema !== undefined && (typeof value.$schema !== "string" || value.$schema.length > 4_096)) {
    throw new Error("theme $schema must be a bounded string");
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) throw new Error("theme schemaVersion must be 1");
  if (typeof value.name !== "string" || value.name === "" || value.name.includes("/") || value.name.includes("\\")) {
    throw new Error("theme name must be non-empty and must not contain a path separator");
  }
  const base = value.base ?? (value.name === "light" ? "light" : "dark");
  if (base !== "dark" && base !== "light") throw new Error("theme base must be dark or light");

  const variables = value.vars === undefined ? {} : record(value.vars, "theme vars");
  const tokenValue = (selected: unknown, label: string): ThemeColorValue | string => {
    if (selected === "" || (typeof selected === "string" && hexColor.test(selected))) return selected as ThemeColorValue;
    if (typeof selected === "number" && Number.isSafeInteger(selected) && selected >= 0 && selected <= 255) return selected;
    if (
      typeof selected === "string"
      && selected !== ""
      && !selected.startsWith("#")
      && !selected.includes("\0")
      && Buffer.byteLength(selected, "utf8") <= 1_024
    ) {
      return selected;
    }
    throw new Error(`${label} must be a variable name, 0-255 palette index, an empty default color, or #RRGGBB`);
  };
  for (const [name, selected] of Object.entries(variables)) tokenValue(selected, `theme vars.${name}`);

  const resolvedVariables = new Map<string, ThemeColorValue>();
  const resolveVariable = (name: string, trail: Set<string>): ThemeColorValue => {
    const cached = resolvedVariables.get(name);
    if (cached !== undefined || resolvedVariables.has(name)) return cached!;
    if (!Object.hasOwn(variables, name)) throw new Error(`theme references unknown variable ${name}`);
    if (trail.has(name)) throw new Error(`theme variable cycle at ${name}`);
    const selected = tokenValue(variables[name], `theme vars.${name}`);
    const resolved = typeof selected === "string" && selected !== "" && !hexColor.test(selected)
      ? resolveVariable(selected, new Set(trail).add(name))
      : selected as ThemeColorValue;
    resolvedVariables.set(name, resolved);
    return resolved;
  };
  const resolveValue = (selected: unknown, label: string): ThemeColorValue => {
    const parsed = tokenValue(selected, label);
    return typeof parsed === "string" && parsed !== "" && !hexColor.test(parsed)
      ? resolveVariable(parsed, new Set())
      : parsed as ThemeColorValue;
  };

  const colors = record(value.colors, "theme colors");
  allowed(colors, THEME_TOKENS, "theme colors");
  const missing = REQUIRED_THEME_TOKENS.filter((token) => colors[token] === undefined);
  if (missing.length > 0) throw new Error(`theme colors is missing required tokens: ${missing.join(", ")}`);
  const tokens = {} as Record<ThemeToken, ThemeColorValue>;
  for (const token of REQUIRED_THEME_TOKENS) tokens[token] = resolveValue(colors[token], `theme colors.${token}`);
  tokens.thinkingMax = colors.thinkingMax === undefined
    ? tokens.thinkingXhigh
    : resolveValue(colors.thinkingMax, "theme colors.thinkingMax");

  const exportInput = value.export === undefined ? {} : record(value.export, "theme export");
  allowed(exportInput, ["pageBg", "cardBg", "infoBg"], "theme export");
  const exportColor = (name: keyof ThemeExportDefinition): ThemeColorValue => {
    const selected = exportInput[name] === undefined
      ? tokens.userMessageBg
      : resolveValue(exportInput[name], `theme export.${name}`);
    return selected === "" ? tokens.userMessageBg : selected;
  };
  const exportDefinition = Object.freeze({
    pageBg: exportColor("pageBg"),
    cardBg: exportColor("cardBg"),
    infoBg: exportColor("infoBg"),
  });
  const foreground = (name: ThemeToken): ThemeStyleDefinition => ({ foreground: tokens[name] });
  const background = (foregroundName: ThemeToken, backgroundName: ThemeToken): ThemeStyleDefinition => {
    const backgroundColor = tokens[backgroundName];
    return {
      foreground: tokens[foregroundName],
      ...(backgroundColor === "" ? {} : { background: backgroundColor }),
    };
  };
  return {
    schemaVersion: 1,
    name: value.name,
    base,
    styles: {
      title: { ...foreground("mdHeading"), bold: true },
      muted: foreground("muted"),
      accent: foreground("accent"),
      info: foreground("thinkingText"),
      link: foreground("mdLink"),
      code: foreground("mdCode"),
      border: foreground("border"),
      editor: foreground("text"),
      editorActive: foreground("borderAccent"),
      working: foreground("thinkingText"),
      user: foreground("accent"),
      assistant: foreground("text"),
      success: foreground("success"),
      warning: foreground("warning"),
      error: foreground("error"),
      selection: background("text", "selectedBg"),
      userMessage: background("userMessageText", "userMessageBg"),
      toolPending: background("toolOutput", "toolPendingBg"),
      toolRunning: background("toolTitle", "toolPendingBg"),
      toolSuccess: background("toolOutput", "toolSuccessBg"),
      toolError: background("toolOutput", "toolErrorBg"),
    },
    tokens: Object.freeze(tokens),
    export: exportDefinition,
  };
}

export function parseThemeDefinition(value: unknown): ThemeDefinition {
  const input = record(value, "theme");
  if (input.colors !== undefined) return tokenTheme(input);
  allowed(input, ["$schema", "schemaVersion", "name", "base", "vars", "styles"], "theme");
  if (input.$schema !== undefined && (typeof input.$schema !== "string" || input.$schema.length > 4_096)) {
    throw new Error("theme $schema must be a bounded string");
  }
  if (input.schemaVersion !== 1) throw new Error("theme schemaVersion must be 1");
  if (typeof input.name !== "string" || !themeName.test(input.name) || input.name === "dark" || input.name === "light" || input.name === "mono") {
    throw new Error("theme name must be a unique lowercase identifier");
  }
  const base = input.base ?? "dark";
  if (base !== "dark" && base !== "light") throw new Error("theme base must be dark or light");
  const inputVariables = input.vars === undefined ? {} : record(input.vars, "theme vars");
  const resolvedVariables = new Map<string, "" | number | `#${string}`>();
  const resolveVariable = (name: string, trail: Set<string>): "" | number | `#${string}` => {
    const cached = resolvedVariables.get(name);
    if (cached !== undefined || resolvedVariables.has(name)) return cached!;
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,62}$/u.test(name) || !Object.hasOwn(inputVariables, name)) {
      throw new Error(`theme references unknown variable ${name}`);
    }
    if (trail.has(name)) throw new Error(`theme variable cycle at ${name}`);
    const selected = inputVariables[name];
    const nextTrail = new Set(trail).add(name);
    const resolved = typeof selected === "string" && selected.startsWith("$")
      ? resolveVariable(selected.slice(1), nextTrail)
      : color(selected, `theme vars.${name}`, true);
    if (resolved === undefined) throw new Error(`theme vars.${name} must define a color`);
    resolvedVariables.set(name, resolved);
    return resolved;
  };
  for (const name of Object.keys(inputVariables)) resolveVariable(name, new Set());
  function styleColor(value: unknown, label: string, empty: false): number | `#${string}` | undefined;
  function styleColor(value: unknown, label: string, empty: true): "" | number | `#${string}` | undefined;
  function styleColor(value: unknown, label: string, empty: boolean): "" | number | `#${string}` | undefined {
    if (typeof value === "string" && value.startsWith("$")) {
      const selected = resolveVariable(value.slice(1), new Set());
      if (!empty && selected === "") throw new Error(`${label} cannot use an empty color variable`);
      return selected;
    }
    return empty ? color(value, label, true) : color(value, label, false);
  }
  const inputStyles = record(input.styles, "theme styles");
  allowed(inputStyles, THEME_ROLES, "theme styles");
  if (Object.keys(inputStyles).length === 0) throw new Error("theme styles must define at least one role");
  const styles: Partial<Record<ThemeRole, ThemeStyleDefinition>> = {};
  for (const [role, raw] of Object.entries(inputStyles) as Array<[ThemeRole, unknown]>) {
    const declaration = record(raw, `theme styles.${role}`);
    allowed(declaration, ["foreground", "background", "bold", "italic"], `theme styles.${role}`);
    if (declaration.bold !== undefined && typeof declaration.bold !== "boolean") throw new Error(`theme styles.${role}.bold must be a boolean`);
    if (declaration.italic !== undefined && typeof declaration.italic !== "boolean") throw new Error(`theme styles.${role}.italic must be a boolean`);
    const foreground = styleColor(declaration.foreground, `theme styles.${role}.foreground`, true);
    const background = styleColor(declaration.background, `theme styles.${role}.background`, false);
    styles[role] = {
      ...(foreground === undefined ? {} : { foreground }),
      ...(background === undefined ? {} : { background }),
      ...(declaration.bold === undefined ? {} : { bold: declaration.bold }),
      ...(declaration.italic === undefined ? {} : { italic: declaration.italic }),
    };
  }
  return { schemaVersion: 1, name: input.name, base, styles };
}

function colorCode(value: "" | number | `#${string}`, background: boolean): string {
  if (value === "") return background ? "49" : "39";
  if (typeof value === "number") return `${background ? 48 : 38};5;${value}`;
  return `${background ? 48 : 38};2;${Number.parseInt(value.slice(1, 3), 16)};${Number.parseInt(value.slice(3, 5), 16)};${Number.parseInt(value.slice(5, 7), 16)}`;
}

function customCodes(definition: ThemeDefinition): Record<ThemeRole, string> {
  const base = palettes[definition.base];
  return Object.fromEntries(THEME_ROLES.map((role) => {
    const selected = definition.styles[role];
    if (selected === undefined) return [role, base[role]];
    const codes = [
      selected.foreground === undefined ? undefined : colorCode(selected.foreground, false),
      selected.background === undefined ? undefined : colorCode(selected.background, true),
      selected.bold === undefined ? undefined : selected.bold ? "1" : "22",
      selected.italic === undefined ? undefined : selected.italic ? "3" : "23",
    ].filter((value): value is string => value !== undefined);
    return [role, `${base[role]}${codes.length === 0 ? "" : `\u001b[${codes.join(";")}m`}`];
  })) as unknown as Record<ThemeRole, string>;
}

const tokenRoles: Readonly<Record<ThemeColor, ThemeRole>> = Object.freeze({
  accent: "accent",
  border: "border",
  borderAccent: "editorActive",
  borderMuted: "border",
  success: "success",
  error: "error",
  warning: "warning",
  muted: "muted",
  dim: "muted",
  text: "assistant",
  thinkingText: "info",
  userMessageText: "userMessage",
  customMessageText: "assistant",
  customMessageLabel: "accent",
  toolTitle: "toolRunning",
  toolOutput: "code",
  mdHeading: "title",
  mdLink: "link",
  mdLinkUrl: "muted",
  mdCode: "code",
  mdCodeBlock: "code",
  mdCodeBlockBorder: "border",
  mdQuote: "assistant",
  mdQuoteBorder: "border",
  mdHr: "border",
  mdListBullet: "accent",
  toolDiffAdded: "success",
  toolDiffRemoved: "error",
  toolDiffContext: "muted",
  syntaxComment: "muted",
  syntaxKeyword: "accent",
  syntaxFunction: "info",
  syntaxVariable: "assistant",
  syntaxString: "success",
  syntaxNumber: "warning",
  syntaxType: "accent",
  syntaxOperator: "assistant",
  syntaxPunctuation: "muted",
  thinkingOff: "muted",
  thinkingMinimal: "info",
  thinkingLow: "info",
  thinkingMedium: "accent",
  thinkingHigh: "warning",
  thinkingXhigh: "error",
  thinkingMax: "error",
  bashMode: "accent",
});

const backgroundTokenRoles: Readonly<Record<ThemeBg, ThemeRole>> = Object.freeze({
  selectedBg: "selection",
  userMessageBg: "userMessage",
  customMessageBg: "toolPending",
  toolPendingBg: "toolPending",
  toolSuccessBg: "toolSuccess",
  toolErrorBg: "toolError",
});

function selectedSgr(code: string, background: boolean): string {
  let selected: string | undefined;
  for (const match of code.matchAll(/\u001b\[([0-9;]*)m/gu)) {
    const parameters = match[1]!.split(";").map((value) => Number.parseInt(value || "0", 10));
    for (let index = 0; index < parameters.length; index += 1) {
      const value = parameters[index]!;
      if (value === (background ? 48 : 38)) {
        const mode = parameters[index + 1];
        const count = mode === 5 ? 3 : mode === 2 ? 5 : 1;
        selected = parameters.slice(index, index + count).join(";");
        index += count - 1;
      } else if (background ? value >= 40 && value <= 49 || value >= 100 && value <= 107 : value >= 30 && value <= 39 || value >= 90 && value <= 97) {
        selected = String(value);
      }
    }
  }
  return selected === undefined ? "" : `\u001b[${selected}m`;
}

function tokenCodes(
  ansi: boolean,
  codes: Readonly<Record<ThemeRole, string>>,
  definition: ThemeDefinition | undefined,
): { foreground: ReadonlyMap<ThemeColor, string>; background: ReadonlyMap<ThemeBg, string> } {
  const foreground = new Map<ThemeColor, string>();
  const background = new Map<ThemeBg, string>();
  for (const [token, role] of Object.entries(tokenRoles) as Array<[ThemeColor, ThemeRole]>) {
    const value = definition?.tokens?.[token];
    foreground.set(token, !ansi ? "" : value === undefined ? selectedSgr(codes[role], false) : `\u001b[${colorCode(value, false)}m`);
  }
  for (const [token, role] of Object.entries(backgroundTokenRoles) as Array<[ThemeBg, ThemeRole]>) {
    const value = definition?.tokens?.[token];
    background.set(token, !ansi ? "" : value === undefined ? selectedSgr(codes[role], true) : `\u001b[${colorCode(value, true)}m`);
  }
  return { foreground, background };
}

function textStyle(ansi: boolean, open: number, close: number, value: string): string {
  return ansi ? `\u001b[${open}m${value}\u001b[${close}m` : value;
}

export function createTheme(
  name: ThemeName,
  options: { color: boolean; unicode: boolean },
  definition?: ThemeDefinition,
): Theme {
  const ansi = options.color && name !== "mono";
  if (definition === undefined && name !== "dark" && name !== "light" && name !== "mono") throw new Error(`Unknown theme: ${name}`);
  if (definition !== undefined && definition.name !== name) throw new Error(`Theme definition does not match ${name}`);
  const codes = ansi
    ? definition === undefined ? palettes[name === "light" ? "light" : "dark"] : customCodes(definition)
    : Object.fromEntries(THEME_ROLES.map((role) => [role, ""])) as Record<ThemeRole, string>;
  const tokens = tokenCodes(ansi, codes, definition);
  const colorMode: ThemeColorMode = definition?.tokens !== undefined
    && Object.values(definition.tokens).some((value) => typeof value === "string" && value.startsWith("#"))
    ? "truecolor"
    : "256color";
  const foreground = (color: ThemeColor): string => {
    const value = tokens.foreground.get(color);
    if (value === undefined) throw new Error(`Unknown theme color: ${String(color)}`);
    return value;
  };
  const background = (color: ThemeBg): string => {
    const value = tokens.background.get(color);
    if (value === undefined) throw new Error(`Unknown theme background color: ${String(color)}`);
    return value;
  };
  return {
    name: ansi ? name : "mono",
    ansi,
    unicode: options.unicode,
    glyphs: options.unicode ? glyphs : asciiGlyphs,
    codes,
    fg: (color, value) => ansi ? `${foreground(color)}${value}\u001b[39m` : value,
    bg: (color, value) => ansi ? `${background(color)}${value}\u001b[49m` : value,
    bold: (value) => textStyle(ansi, 1, 22, value),
    italic: (value) => textStyle(ansi, 3, 23, value),
    underline: (value) => textStyle(ansi, 4, 24, value),
    inverse: (value) => textStyle(ansi, 7, 27, value),
    strikethrough: (value) => textStyle(ansi, 9, 29, value),
    getFgAnsi: foreground,
    getBgAnsi: background,
    getColorMode: () => colorMode,
    getThinkingBorderColor: (level) => (value) => {
      const selected = level === "max" ? "thinkingMax" : `thinking${level[0]!.toUpperCase()}${level.slice(1)}` as ThemeColor;
      return ansi ? `${foreground(selected)}${value}\u001b[39m` : value;
    },
    getBashModeBorderColor: () => (value) => ansi ? `${foreground("bashMode")}${value}\u001b[39m` : value,
  };
}

export function style(theme: Theme, role: ThemeRole, value: string): string {
  return theme.ansi ? `${theme.codes[role]}${value}${reset}` : value;
}

function paletteRgb(index: number): [number, number, number] {
  const system: Array<[number, number, number]> = [
    [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
    [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
  ];
  if (index < 16) return system[index]!;
  if (index < 232) {
    const selected = index - 16;
    const channel = (value: number): number => value === 0 ? 0 : 55 + value * 40;
    return [channel(Math.floor(selected / 36)), channel(Math.floor(selected / 6) % 6), channel(selected % 6)];
  }
  const gray = 8 + (index - 232) * 10;
  return [gray, gray, gray];
}

function rgb(value: "" | number | `#${string}`, fallback: [number, number, number]): [number, number, number] {
  if (value === "") return fallback;
  if (typeof value === "number") return paletteRgb(value);
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}

function luminance(value: [number, number, number]): number {
  const channel = (selected: number): number => {
    const normalized = selected / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(value[0]) + 0.7152 * channel(value[1]) + 0.0722 * channel(value[2]);
}

/** Reports WCAG-style contrast warnings without rejecting a usable theme. */
export function themeContrastDiagnostics(definition: ThemeDefinition, minimum = 3): ThemeContrastDiagnostic[] {
  if (!Number.isFinite(minimum) || minimum < 1 || minimum > 21) throw new RangeError("Theme contrast minimum must be from 1 through 21");
  const defaultForeground: [number, number, number] = definition.base === "light" ? [0, 0, 0] : [255, 255, 255];
  const defaultBackground: [number, number, number] = definition.base === "light" ? [255, 255, 255] : [0, 0, 0];
  const diagnostics: ThemeContrastDiagnostic[] = [];
  for (const role of THEME_ROLES) {
    const selected = definition.styles[role];
    if (selected?.foreground === undefined && selected?.background === undefined) continue;
    const foreground = rgb(selected.foreground ?? "", defaultForeground);
    const background = rgb(selected.background ?? "", defaultBackground);
    const first = luminance(foreground);
    const second = luminance(background);
    const ratio = (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    if (ratio >= minimum) continue;
    diagnostics.push({
      role,
      ratio,
      minimum,
      message: `Theme ${definition.name} role ${role} has ${ratio.toFixed(2)}:1 contrast; recommended minimum is ${minimum.toFixed(1)}:1`,
    });
  }
  return diagnostics;
}
