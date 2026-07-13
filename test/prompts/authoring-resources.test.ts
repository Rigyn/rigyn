import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { discoverSkills, loadSkill } from "../../src/context/skills.js";
import { loadPromptTemplates } from "../../src/extensions/loose-resources.js";
import { renderExtensionPrompt } from "../../src/extensions/templates.js";
import { bundledAuthoringResources } from "../../src/prompts/resources.js";
import { buildSystemPrompt } from "../../src/prompts/system.js";

function pattern(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u");
}

test("bundled authoring resources are discoverable and progressively loaded", async () => {
  const resources = bundledAuthoringResources();
  const dashboardReference = resolve(dirname(resources.authoringSkill), "references/dashboard.md");
  await Promise.all([
    access(resources.documentationRoot),
    access(resources.examplesRoot),
    access(resources.skillRoot),
    access(resources.promptRoot),
    access(resources.authoringSkill),
    access(resources.authoringPrompt),
    access(resolve(dirname(resources.authoringSkill), "../../../docs/extensions.md")),
    access(resolve(dirname(resources.authoringSkill), "../../../docs/packages.md")),
    access(resolve(dirname(resources.authoringSkill), "../../../docs/tui.md")),
    access(resolve(dirname(resources.authoringSkill), "../../../examples/package-starter")),
    access(dashboardReference),
  ]);

  const skills = await discoverSkills([{
    path: resources.skillRoot,
    scope: "user",
    trusted: true,
  }]);
  const skill = skills.find((entry) => entry.name === "build-extension");
  assert.ok(skill);
  assert.match(skill.description, /extension|package/iu);

  const loaded = await loadSkill(skill);
  const dashboardBody = await readFile(dashboardReference, "utf8");
  assert.equal(loaded.truncated, false);
  assert.match(loaded.instructions, /docs\/extensions\.md/u);
  assert.match(loaded.instructions, /examples\/package-starter/u);
  assert.match(
    loaded.instructions,
    /Model-callable tools plus durable state or lifecycle events.*examples\/reference-package.*examples\/custom-tool.*examples\/session-notes/su,
  );
  assert.match(loaded.instructions, /multi-capability package inspect every focused contract/iu);
  assert.match(loaded.instructions, /dashboard checklist/iu);
  assert.match(dashboardBody, /no bundled dashboard implementation/iu);
  assert.match(dashboardBody, /api\.getTranscript/iu);
  assert.match(dashboardBody, /never read the session database or expose raw event envelopes/iu);
  assert.match(loaded.instructions, /extension\.json/u);

  const prompts = await loadPromptTemplates([resources.promptRoot]);
  const prompt = prompts.find((entry) => entry.id === "build-extension");
  assert.ok(prompt);
  const rendered = renderExtensionPrompt(prompt, "a polished browser dashboard");
  assert.match(rendered, /build-extension/u);
  assert.match(rendered, /a polished browser dashboard/u);
  assert.doesNotMatch(rendered, /\{\{input\}\}/u);
});

test("the base prompt routes authoring requests without embedding the full workflow", async () => {
  const resources = bundledAuthoringResources();
  const skillBody = await readFile(resources.authoringSkill, "utf8");
  assert.match(skillBody, /bundled example.*read-only reference/isu);
  assert.match(skillBody, /new package directory inside the user's active workspace/iu);
  const skills = await discoverSkills([{
    path: resources.skillRoot,
    scope: "user",
    trusted: true,
  }]);
  const prompt = buildSystemPrompt({
    workspace: "/workspace",
    instructions: { entries: [], totalBytes: 0, truncated: false },
    skills,
  });

  assert.match(prompt, /build-extension/u);
  assert.match(prompt, /<name>build-extension<\/name>/u);
  assert.match(prompt, pattern(`<location>${resources.authoringSkill}</location>`));
  assert.match(prompt, pattern(resources.documentationRoot));
  assert.match(prompt, pattern(resources.examplesRoot));
  assert.doesNotMatch(prompt, /acceptance matrix/u);
  assert.match(skillBody, /acceptance matrix/u);
});
