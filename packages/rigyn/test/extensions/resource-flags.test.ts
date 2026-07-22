import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "../../src/cli/args.js";
import { discoverSkills } from "../../src/context/skills.js";
import { loadPromptTemplates, loadThemes, renderExtensionPrompt } from "../../src/extensions/index.js";
import { resourcePathHasMagic } from "../../src/extensions/loose-resources.js";
import { THEME_TOKENS } from "../../src/tui/theme.js";

test("resource flags and short aliases parse as repeatable invocation resources", () => {
  const parsed = parseArgs([
    "-nt",
    "-ne",
    "-ns",
    "-np",
    "-e", "one.ts",
    "--extension", "two.ts",
    "--skill", "skill.md",
    "--prompt-template", "prompt.md",
    "--theme", "theme.json",
  ]);
  assert.equal(parsed.noTools, true);
  assert.equal(parsed.noExtensions, true);
  assert.equal(parsed.noSkills, true);
  assert.equal(parsed.noPromptTemplates, true);
  assert.deepEqual(parsed.extensions, ["one.ts", "two.ts"]);
  assert.deepEqual(parsed.skills, ["skill.md"]);
  assert.deepEqual(parsed.promptTemplates, ["prompt.md"]);
  assert.deepEqual(parsed.themes, ["theme.json"]);
});

test("case-insensitive Windows literal paths are not mistaken for globs", () => {
  assert.equal(resourcePathHasMagic("C:\\Users\\runner\\prompts"), false);
  assert.equal(resourcePathHasMagic("C:\\Users\\runner\\prompts\\*.md"), true);
});

test("loose prompt templates support frontmatter, arguments, defaults, and slices", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-resource-prompts-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "component.md"), [
    "---",
    "description: Build a component",
    "argument-hint: <name> [features]",
    "---",
    "Create $1 with ${1:-Fallback}; extras: ${@:2}; all: $ARGUMENTS",
  ].join("\n"));

  const [prompt] = await loadPromptTemplates([root]);
  assert.equal(prompt?.id, "component");
  assert.equal(prompt?.description, "Build a component");
  assert.equal(prompt?.argumentHint, "<name> [features]");
  assert.equal(
    renderExtensionPrompt(prompt!, 'Button "click handler" disabled'),
    "Create Button with Button; extras: click handler disabled; all: Button click handler disabled",
  );
});

test("an explicit Markdown skill file loads even when its declared name differs from the filename", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-resource-skill-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "shared-name.md");
  await writeFile(path, "---\nname: actual-skill\ndescription: Shared skill fixture\n---\n\nFollow the workflow.\n");

  const skills = await discoverSkills([{ path, scope: "user", trusted: true }]);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.name, "actual-skill");
  assert.equal(skills[0]?.manifestPath, path);
});

test("token-based themes load from a plain themes directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-resource-theme-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "ocean.json"), JSON.stringify({
    name: "ocean",
    vars: { primary: "#00aaff", panel: 236 },
    colors: {
      ...Object.fromEntries(THEME_TOKENS.map((token) => [token, ""])),
      accent: "primary",
      text: "",
      muted: 242,
      success: "#00ff00",
      warning: "#ffff00",
      error: "#ff0000",
      selectedBg: "panel",
      userMessageText: "",
      userMessageBg: "panel",
      toolTitle: "primary",
      toolOutput: "",
      toolPendingBg: "panel",
      toolSuccessBg: 22,
      toolErrorBg: 52,
    },
  }));

  const [theme] = await loadThemes([root]);
  assert.equal(theme?.name, "ocean");
  assert.equal(theme?.definition.styles.accent?.foreground, "#00aaff");
  assert.equal(theme?.definition.styles.toolSuccess?.background, 22);
});
