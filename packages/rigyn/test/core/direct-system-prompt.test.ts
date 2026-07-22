import assert from "node:assert/strict";
import test from "node:test";

import { buildSystemPrompt } from "../../src/core/system-prompt.js";
import { createSyntheticSourceInfo } from "../../src/core/source-info.js";
import type { Skill } from "../../src/core/skills.js";

const skill = (name: string, disabled = false): Skill => ({
  name,
  description: `${name} description`,
  filePath: `/skills/${name}/SKILL.md`,
  baseDir: `/skills/${name}`,
  sourceInfo: createSyntheticSourceInfo(`/skills/${name}/SKILL.md`, { source: "local" }),
  disableModelInvocation: disabled,
});

test("custom prompts replace the default but retain append, context, visible skills, and cwd", () => {
  const prompt = buildSystemPrompt({
    customPrompt: "Custom base",
    appendSystemPrompt: "Appended",
    cwd: "C:\\work\\project",
    selectedTools: ["read"],
    contextFiles: [{ path: "/work/AGENTS.md", content: "Project rules" }],
    skills: [skill("visible"), skill("hidden", true)],
  });
  assert.equal(prompt.startsWith("Custom base\n\nAppended"), true);
  assert.match(prompt, /<project_instructions path="\/work\/AGENTS\.md">\nProject rules/u);
  assert.match(prompt, /<name>visible<\/name>/u);
  assert.doesNotMatch(prompt, /<name>hidden<\/name>/u);
  assert.match(prompt, /Current working directory: C:\/work\/project$/u);
  assert.doesNotMatch(prompt, /Available tools:/u);
});

test("skills are omitted when read is unavailable", () => {
  const prompt = buildSystemPrompt({
    customPrompt: "Custom",
    cwd: "/work",
    selectedTools: ["bash"],
    skills: [skill("review")],
  });
  assert.doesNotMatch(prompt, /available_skills/u);
});

test("default prompt lists only described tools and de-duplicates guidelines", () => {
  const prompt = buildSystemPrompt({
    cwd: "/work",
    selectedTools: ["read", "bash", "private"],
    toolSnippets: { read: "Read files", bash: "Run commands" },
    promptGuidelines: ["Keep changes focused", " Keep changes focused "],
  });
  assert.match(prompt, /- read: Read files/u);
  assert.match(prompt, /- bash: Run commands/u);
  assert.doesNotMatch(prompt, /- private:/u);
  assert.equal(prompt.match(/Keep changes focused/gu)?.length, 1);
  assert.match(prompt, /Use bash for file discovery/u);
});

test("dedicated discovery tools suppress the bash discovery guideline", () => {
  const prompt = buildSystemPrompt({
    cwd: "/work",
    selectedTools: ["bash", "grep"],
    toolSnippets: { bash: "Run commands", grep: "Search" },
  });
  assert.doesNotMatch(prompt, /Use bash for file discovery/u);
});
