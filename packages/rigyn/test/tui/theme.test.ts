import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createTheme,
  parseAutomaticThemePair,
  parseThemeDefinition,
  resolveThemeSetting,
  style,
  themeContrastDiagnostics,
  THEME_SCHEMA_URI,
  THEME_TOKENS,
  type ThemeToken,
} from "../../src/tui/theme.js";
import {
  parseTerminalBackgroundReply,
  parseTerminalColorSchemeReply,
  terminalColorSchemeForRgb,
  terminalColorSchemeFromEnvironment,
} from "../../src/tui/terminal-colors.js";

function tokenColors(overrides: Partial<Record<ThemeToken, string | number>> = {}): Record<ThemeToken, string | number> {
  return { ...Object.fromEntries(THEME_TOKENS.map((token) => [token, ""])), ...overrides } as Record<ThemeToken, string | number>;
}

test("the published theme schema reserves bundled and compatibility names", async () => {
  const schema = JSON.parse(await readFile(new URL("../../resources/schemas/theme-v1.json", import.meta.url), "utf8")) as {
    properties: { name: { not: { enum: string[] } } };
  };
  assert.deepEqual(schema.properties.name.not.enum, ["dark", "light", "mono"]);
});

test("themes honor color and Unicode capability decisions", () => {
  const colored = createTheme("mono", { color: true, unicode: true });
  assert.equal(colored.name, "mono");
  assert.match(style(colored, "error", "failed"), /\u001b\[/u);
  assert.equal(colored.glyphs.success, "✓");
  const fallback = createTheme("light", { color: false, unicode: false });
  assert.equal(fallback.name, "mono");
  assert.equal(style(fallback, "error", "failed"), "failed");
  assert.equal(fallback.glyphs.success, "+");
  assert.match(style(colored, "selection", "selected"), /38;5;16;48;5;255m/u);
  assert.doesNotMatch(style(colored, "toolSuccess", "passed"), /48;/u);
  assert.doesNotMatch(style(colored, "toolError", "failed"), /48;/u);
});

test("live themes expose token colors and composable text styles to direct renderers", () => {
  const colored = createTheme("mono", { color: true, unicode: true });
  assert.equal(colored.unicode, true);
  assert.match(colored.fg("accent", "value"), /^\u001b\[[0-9;]+mvalue\u001b\[39m$/u);
  assert.match(colored.bg("selectedBg", "value"), /^\u001b\[[0-9;]+mvalue\u001b\[49m$/u);
  assert.equal(colored.bold("value"), "\u001b[1mvalue\u001b[22m");
  assert.equal(colored.italic("value"), "\u001b[3mvalue\u001b[23m");
  assert.equal(colored.underline("value"), "\u001b[4mvalue\u001b[24m");
  assert.equal(colored.inverse("value"), "\u001b[7mvalue\u001b[27m");
  assert.equal(colored.strikethrough("value"), "\u001b[9mvalue\u001b[29m");
  assert.match(colored.getThinkingBorderColor("xhigh")("border"), /border\u001b\[39m$/u);
  assert.match(colored.getBashModeBorderColor()("border"), /border\u001b\[39m$/u);
  assert.equal(colored.getColorMode(), "256color");

  const mono = createTheme("mono", { color: false, unicode: false });
  for (const value of [
    mono.fg("accent", "plain"),
    mono.bg("selectedBg", "plain"),
    mono.bold("plain"),
    mono.italic("plain"),
    mono.underline("plain"),
    mono.inverse("plain"),
    mono.strikethrough("plain"),
  ]) assert.equal(value, "plain");
  assert.equal(mono.getFgAnsi("accent"), "");
  assert.equal(mono.getBgAnsi("selectedBg"), "");
});

test("automatic theme pairs resolve from bounded terminal color evidence", () => {
  assert.deepEqual(parseAutomaticThemePair("paper/ocean"), { light: "paper", dark: "ocean" });
  assert.equal(parseAutomaticThemePair("dark"), undefined);
  assert.equal(resolveThemeSetting("paper/ocean", "light"), "paper");
  assert.equal(resolveThemeSetting("paper/ocean", "dark"), "ocean");
  assert.throws(() => parseAutomaticThemePair("one/two/three"), /LIGHT\/DARK/u);
  assert.throws(() => parseAutomaticThemePair("one/"), /two valid theme names/u);

  assert.deepEqual(parseTerminalBackgroundReply("\u001b]11;rgb:0000/8000/ffff\u0007"), {
    red: 0,
    green: 128,
    blue: 255,
  });
  assert.deepEqual(parseTerminalBackgroundReply("\u009d11;#ffffff\u009c"), {
    red: 255,
    green: 255,
    blue: 255,
  });
  assert.equal(parseTerminalBackgroundReply("x\u001b]11;#ffffff\u0007"), undefined);
  assert.equal(parseTerminalColorSchemeReply("\u001b[?997;1n"), "dark");
  assert.equal(parseTerminalColorSchemeReply("\u009b?997;2n"), "light");
  assert.equal(parseTerminalColorSchemeReply("\u001b[?997;3n"), undefined);
  assert.equal(terminalColorSchemeForRgb({ red: 255, green: 255, blue: 255 }), "light");
  assert.equal(terminalColorSchemeForRgb({ red: 0, green: 0, blue: 0 }), "dark");
  assert.equal(terminalColorSchemeFromEnvironment({ COLORFGBG: "15;0" }), "dark");
  assert.equal(terminalColorSchemeFromEnvironment({ COLORFGBG: "0;15" }), "light");
});

test("declarative themes generate bounded ANSI without accepting terminal escapes", () => {
  const definition = parseThemeDefinition({
    schemaVersion: 1,
    name: "ocean",
    base: "dark",
    styles: {
      accent: { foreground: "#00aaff", bold: true },
      selection: { foreground: 16, background: 117 },
    },
  });
  const theme = createTheme("ocean", { color: true, unicode: true }, definition);
  assert.equal(theme.name, "ocean");
  assert.match(style(theme, "accent", "selected"), /38;2;0;170;255;1m/u);
  assert.match(style(theme, "selection", "selected"), /38;5;16;48;5;117m/u);
  assert.match(style(theme, "userMessage", "legacy theme card"), /\u001b\[/u);

  assert.throws(() => parseThemeDefinition({
    schemaVersion: 1,
    name: "unsafe",
    styles: { accent: { foreground: "\u001b[2J" } },
  }), /0-255 palette index/u);
  assert.throws(() => parseThemeDefinition({
    schemaVersion: 1,
    name: "unsafe",
    styles: { accent: { foreground: 12, cursor: "hide" } },
  }), /unknown keys/u);
});

test("semantic transcript roles support safe custom backgrounds", () => {
  const definition = parseThemeDefinition({
    schemaVersion: 1,
    name: "cards",
    base: "light",
    styles: {
      userMessage: { foreground: 16, background: "#eeeeee" },
      toolRunning: { foreground: "#001122", background: 153, bold: true },
    },
  });
  const theme = createTheme("cards", { color: true, unicode: true }, definition);
  assert.match(style(theme, "userMessage", "message"), /38;5;16;48;2;238;238;238m/u);
  assert.match(style(theme, "toolRunning", "running"), /38;2;0;17;34;48;5;153;1m/u);

  assert.throws(() => parseThemeDefinition({
    schemaVersion: 1,
    name: "unsafe-card",
    styles: { toolSuccess: { background: "\u001b[2J" } },
  }), /0-255 palette index/u);
});

test("themes resolve bounded variables, expose richer roles, and report contrast without rejecting", () => {
  const definition = parseThemeDefinition({
    $schema: THEME_SCHEMA_URI,
    schemaVersion: 1,
    name: "variable-theme",
    base: "dark",
    vars: { primary: "#123456", inherited: "$primary", low: "#111111" },
    styles: {
      link: { foreground: "$inherited", bold: true },
      editorActive: { foreground: "$primary" },
      working: { foreground: "$low", background: "#000000" },
    },
  });
  assert.equal(definition.styles.link?.foreground, "#123456");
  assert.match(style(createTheme("variable-theme", { color: true, unicode: true }, definition), "editorActive", "draft"), /18;52;86/u);
  assert.ok(themeContrastDiagnostics(definition).some((entry) => entry.role === "working" && entry.ratio < entry.minimum));
  assert.throws(() => parseThemeDefinition({
    schemaVersion: 1,
    name: "cycle",
    vars: { first: "$second", second: "$first" },
    styles: { accent: { foreground: "$first" } },
  }), /variable cycle/u);
});

test("token-shaped themes preserve resolved semantic tokens and honor light bases", () => {
  const colors = tokenColors({
    accent: "primaryAlias",
    borderAccent: "primary",
    mdHeading: "heading",
    mdLink: "primary",
    mdCode: 117,
    thinkingText: "secondary",
    userMessageBg: "panel",
    thinkingXhigh: "primary",
  });
  delete (colors as Partial<Record<ThemeToken, string | number>>).thinkingMax;
  const definition = parseThemeDefinition({
    schemaVersion: 1,
    name: "paper",
    base: "light",
    vars: {
      primary: "#123456",
      primaryAlias: "primary",
      heading: "#654321",
      secondary: 24,
      panel: 255,
      exportPage: "#fefefe",
      exportAlias: "exportPage",
    },
    colors,
    export: { pageBg: "exportAlias", cardBg: 254 },
  });

  assert.equal(definition.base, "light");
  assert.equal(Object.keys(definition.tokens ?? {}).length, THEME_TOKENS.length);
  assert.equal(definition.tokens?.accent, "#123456");
  assert.equal(definition.tokens?.mdHeading, "#654321");
  assert.equal(definition.tokens?.thinkingText, 24);
  assert.equal(definition.tokens?.thinkingMax, "#123456");
  assert.deepEqual(definition.export, { pageBg: "#fefefe", cardBg: 254, infoBg: 255 });
  assert.equal(definition.styles.title?.foreground, "#654321");
  assert.equal(definition.styles.link?.foreground, "#123456");
  assert.equal(definition.styles.code?.foreground, 117);
  const live = createTheme("paper", { color: true, unicode: true }, definition);
  assert.match(live.codes.title, /^\u001b\[1;30m/u);
  assert.equal(live.getFgAnsi("accent"), "\u001b[38;2;18;52;86m");
  assert.equal(live.getBgAnsi("userMessageBg"), "\u001b[48;5;255m");
  assert.equal(live.fg("mdHeading", "heading"), "\u001b[38;2;101;67;33mheading\u001b[39m");
  assert.equal(live.getColorMode(), "truecolor");

  const inferred = parseThemeDefinition({ name: "default-base", colors: tokenColors() });
  assert.equal(inferred.base, "dark");
});

test("token-shaped themes validate their complete token, base, variable, and export contracts", () => {
  const missing = tokenColors();
  delete (missing as Partial<Record<ThemeToken, string | number>>).syntaxOperator;
  for (const name of ["dark", "light", "mono"]) {
    assert.throws(() => parseThemeDefinition({ name, colors: tokenColors() }), /unique lowercase identifier/u);
  }
  assert.throws(() => parseThemeDefinition({ name: "missing", colors: missing }), /missing required tokens: syntaxOperator/u);
  assert.throws(() => parseThemeDefinition({
    name: "unknown",
    colors: { ...tokenColors(), terminalCursor: "#ffffff" },
  }), /theme colors contains unknown keys: terminalCursor/u);
  assert.throws(() => parseThemeDefinition({ name: "wrong-base", base: "sepia", colors: tokenColors() }), /base must be dark or light/u);
  assert.throws(() => parseThemeDefinition({
    name: "cycle",
    vars: { first: "second", second: "first" },
    colors: tokenColors({ accent: "first" }),
  }), /variable cycle/u);
  assert.throws(() => parseThemeDefinition({
    name: "bad-export",
    colors: tokenColors(),
    export: { pageBg: "missingVariable" },
  }), /unknown variable missingVariable/u);
  assert.throws(() => parseThemeDefinition({
    name: "unknown-export",
    colors: tokenColors(),
    export: { pageBg: "#ffffff", terminalBg: "#000000" },
  }), /theme export contains unknown keys: terminalBg/u);
});
