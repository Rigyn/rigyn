import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { discoverSkills, loadSkill } from "../../src/context/skills.js";
import { loadPromptTemplates } from "../../src/extensions/loose-resources.js";
import { renderExtensionPrompt } from "../../src/extensions/templates.js";
import { bundledAuthoringResources } from "../../src/prompts/resources.js";

const examples = [
  "starter",
  "provider-override",
  "raw-editor-ui",
  "session-jsonl",
  "session-control",
  "subprocess-workers",
  "dynamic-package",
] as const;

test("bundled authoring resources describe the direct package contract", async () => {
  const resources = bundledAuthoringResources();
  const skillDirectory = dirname(resources.authoringSkill);
  const dashboardReference = resolve(skillDirectory, "references/dashboard.md");
  await Promise.all([
    access(resources.documentationRoot),
    access(resources.examplesRoot),
    access(resources.skillRoot),
    access(resources.promptRoot),
    access(resources.authoringSkill),
    access(resources.authoringPrompt),
    access(resolve(skillDirectory, "../../../docs/extensions.md")),
    access(resolve(skillDirectory, "../../../docs/packages.md")),
    access(resolve(skillDirectory, "../../../docs/tui.md")),
    ...examples.map(async (name) => await access(resolve(skillDirectory, `../../../examples/${name}`))),
    access(dashboardReference),
  ]);

  const skills = await discoverSkills([{ path: resources.skillRoot, scope: "user", trusted: true }]);
  const skill = skills.find((entry) => entry.name === "build-extension");
  assert.ok(skill);
  const loaded = await loadSkill(skill);
  assert.equal(loaded.truncated, false);
  assert.match(loaded.instructions, /docs\/extensions\.md/u);
  assert.match(loaded.instructions, /examples\/starter/u);
  assert.match(loaded.instructions, /examples\/provider-override/u);
  assert.match(loaded.instructions, /examples\/raw-editor-ui/u);
  assert.match(loaded.instructions, /examples\/session-jsonl/u);
  assert.match(loaded.instructions, /examples\/session-control/u);
  assert.match(loaded.instructions, /examples\/subprocess-workers/u);
  assert.match(loaded.instructions, /examples\/dynamic-package/u);
  assert.match(loaded.instructions, /package\.json/iu);
  assert.doesNotMatch(loaded.instructions, /extension\.json/u);
  assert.match(loaded.instructions, /onDispose.*API is stale/isu);
  assert.match(loaded.instructions, /fixed executable and argv array/iu);
  assert.match(loaded.instructions, /failed activation commits nothing/iu);
  assert.match(loaded.instructions, /exact installed package/iu);
  assert.match(loaded.instructions, /rigyn --extension PATH/u);
  assert.doesNotMatch(loaded.instructions, /rigyn --package/u);

  const dashboard = await readFile(dashboardReference, "utf8");
  assert.match(dashboard, /no bundled dashboard/iu);
  assert.match(dashboard, /context\.sessionManager/u);
  assert.match(dashboard, /never reopen the JSONL file/iu);
  assert.match(dashboard, /rigyn\.onDispose/u);

  const packageDocs = await readFile(resolve(resources.documentationRoot, "packages.md"), "utf8");
  assert.match(packageDocs, /rigyn install .*npm:file:\/\/\/absolute\/path\/my-extension-1\.2\.3\.tgz/u);
  assert.match(packageDocs, /schema 1 lock.*migrates `extension\.json` packages/isu);
  const extensionDocs = await readFile(resolve(resources.documentationRoot, "extensions.md"), "utf8");
  assert.match(extensionDocs, /content.*array of text or image blocks/isu);
  assert.match(extensionDocs, /reverse (?:registration )?order/iu);

  const prompts = await loadPromptTemplates([resources.promptRoot]);
  const prompt = prompts.find((entry) => entry.id === "build-extension");
  assert.ok(prompt);
  const rendered = renderExtensionPrompt(prompt, "a polished browser dashboard");
  assert.match(rendered, /build-extension/u);
  assert.match(rendered, /a polished browser dashboard/u);
  assert.doesNotMatch(rendered, /\{\{input\}\}/u);
});
