import assert from "node:assert/strict";
import test from "node:test";
import { createTheme, parseThemeDefinition, style, themeContrastDiagnostics, THEME_SCHEMA_URI } from "../../src/tui/theme.js";

test("themes honor color and Unicode capability decisions", () => {
  const colored = createTheme("dark", { color: true, unicode: true });
  assert.equal(colored.name, "dark");
  assert.match(style(colored, "error", "failed"), /\u001b\[/u);
  assert.equal(colored.glyphs.success, "✓");
  const fallback = createTheme("light", { color: false, unicode: false });
  assert.equal(fallback.name, "mono");
  assert.equal(style(fallback, "error", "failed"), "failed");
  assert.equal(fallback.glyphs.success, "+");
  assert.match(style(colored, "selection", "selected"), /38;5;117;48;5;237m/u);
  assert.doesNotMatch(style(colored, "toolSuccess", "passed"), /48;/u);
  assert.doesNotMatch(style(colored, "toolError", "failed"), /48;/u);
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
