import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPromptCompositionMetadata,
  promptCompositionSource,
} from "../../src/core/prompt-composition.js";
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

test("instruction source paths cannot break their prompt tag", () => {
  const prompt = buildSystemPrompt({
    customPrompt: "Custom",
    cwd: "/work",
    contextFiles: [{ path: "/work/a&\"<b>\nfile.md", content: "Project rules" }],
  });

  assert.match(
    prompt,
    /<project_instructions path="\/work\/a&amp;&quot;&lt;b&gt;&#xA;file\.md">\nProject rules/u,
  );
  assert.doesNotMatch(prompt, /path="\/work\/a&"/u);
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
  assert.match(prompt, /^You are Rigyn, a coding agent working in the user's environment\./u);
  assert.match(prompt, /make precise changes, and verify results/u);
  assert.match(prompt, /Preserve unrelated work, explain important tradeoffs/u);
  assert.match(prompt, /create or modify files only when the task requires it/u);
  assert.match(prompt, /- read: Read files/u);
  assert.match(prompt, /- bash: Run commands/u);
  assert.doesNotMatch(prompt, /- private:/u);
  assert.equal(prompt.match(/Keep changes focused/gu)?.length, 1);
  assert.match(prompt, /Use bash for file discovery/u);
  assert.match(prompt, /Inspect relevant project files before changing them/u);
  assert.match(prompt, /Give summaries directly in your response/u);
  assert.match(prompt, /Read the relevant documents and directly referenced Markdown files completely/u);
  assert.match(prompt, /Built-in prompt implementation: .*system-prompt\.(?:ts|js)/u);
  assert.match(prompt, /built-in rigyn prompt is public product source/u);
  assert.match(prompt, /read the listed implementation and explain or quote that source directly/u);
  assert.doesNotMatch(prompt, /secret|hidden|privileged|unavailable/u);
  assert.match(prompt, /An empty AGENTS\.md adds no instructions/u);
});

test("dedicated discovery tools suppress the bash discovery guideline", () => {
  const prompt = buildSystemPrompt({
    cwd: "/work",
    selectedTools: ["bash", "grep"],
    toolSnippets: { bash: "Run commands", grep: "Search" },
  });
  assert.doesNotMatch(prompt, /Use bash for file discovery/u);
});

test("prompt composition metadata is content-free, exact, and bounded", () => {
  const prompt = "exact composed prompt";
  const source = promptCompositionSource("instruction", "/work/AGENTS.md", "private instructions");
  const metadata = buildPromptCompositionMetadata({
    prompt,
    sources: [source],
    selectedTools: ["read", "bash", "read"],
    skills: [skill("visible"), skill("hidden", true)],
  });

  assert.equal(metadata.bytes, Buffer.byteLength(prompt));
  assert.equal(metadata.sha256, promptCompositionSource("system_prompt", "unused", prompt).sha256);
  assert.deepEqual(metadata.sources, [source]);
  assert.deepEqual(metadata.tools, ["read", "bash"]);
  assert.deepEqual(metadata.skills, [{ name: "visible", manifestPath: "/skills/visible/SKILL.md" }]);
  assert.equal(metadata.truncated, false);
  assert.doesNotMatch(JSON.stringify(metadata), /private instructions/u);

  const bounded = buildPromptCompositionMetadata({
    prompt,
    sources: Array.from({ length: 2_000 }, (_, index) =>
      promptCompositionSource("instruction", `/work/${index.toString().padStart(4, "0")}-${"x".repeat(256)}.md`, "x")),
  });
  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 64 * 1024);
});
