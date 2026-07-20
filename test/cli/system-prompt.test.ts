import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArguments } from "../../src/cli/args.js";
import { systemPromptCliOptions } from "../../src/cli/system-prompt.js";
import { discoverWorkspacePromptFiles } from "../../src/context/index.js";
import { buildSystemPrompt } from "../../src/prompts/system.js";

test("system prompt CLI inputs support bounded workspace files, literals, and repeatable append order", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-system-prompt-"));
  await writeFile(join(workspace, "base.md"), "Operate as a release engineer.");
  await writeFile(join(workspace, "append.md"), "Check the package artifact.");
  const argumentsValue = parseArguments([
    "run",
    "hello",
    "--system-prompt",
    "@base.md",
    "--append-system-prompt",
    "Explain important tradeoffs.",
    "--append-system-prompt",
    "@append.md",
  ]);

  assert.deepEqual(await systemPromptCliOptions(argumentsValue, workspace), {
    systemPrompt: { text: "Operate as a release engineer.", source: "base.md" },
    appendSystemPrompt: [
      { text: "Explain important tradeoffs.", source: "--append-system-prompt #1" },
      { text: "Check the package artifact.", source: "append.md" },
    ],
  });

  const escaped = parseArguments(["run", "hello", "--system-prompt", "@@base.md"]);
  assert.deepEqual(await systemPromptCliOptions(escaped, workspace), {
    systemPrompt: { text: "@base.md", source: "--system-prompt" },
  });

  const existingNameIsLiteral = parseArguments(["run", "hello", "--system-prompt", "base.md"]);
  assert.deepEqual(await systemPromptCliOptions(existingNameIsLiteral, workspace), {
    systemPrompt: { text: "base.md", source: "--system-prompt" },
  });
});

test("system prompt file sources cannot escape the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-system-boundary-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(root, "outside.md"), "must not load");
  const argumentsValue = parseArguments(["run", "hello", "--system-prompt", "@../outside.md"]);
  await assert.rejects(systemPromptCliOptions(argumentsValue, workspace), /outside workspace|escapes workspace|Workspace/u);
});

test("trusted workspace prompt files are discovered separately from explicit prompt flags", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-system-context-"));
  const harnessDirectory = join(workspace, ".rigyn");
  await mkdir(harnessDirectory);
  await writeFile(join(harnessDirectory, "SYSTEM.md"), "Automatic operating prompt.");
  await writeFile(join(harnessDirectory, "APPEND_SYSTEM.md"), "Automatic appended prompt.");

  assert.deepEqual(await discoverWorkspacePromptFiles(workspace, true), {
    systemPrompt: { text: "Automatic operating prompt.", source: ".rigyn/SYSTEM.md" },
    appendSystemPrompt: [{ text: "Automatic appended prompt.", source: ".rigyn/APPEND_SYSTEM.md" }],
  });
  assert.deepEqual(await discoverWorkspacePromptFiles(workspace, true, { includeSystemPrompt: false }), {
    appendSystemPrompt: [{ text: "Automatic appended prompt.", source: ".rigyn/APPEND_SYSTEM.md" }],
  });

  const explicit = parseArguments([
    "run", "hello",
    "--system-prompt", "Explicit operating prompt.",
    "--append-system-prompt", "Explicit appended prompt.",
  ]);
  assert.deepEqual(await systemPromptCliOptions(explicit, workspace), {
    systemPrompt: { text: "Explicit operating prompt.", source: "--system-prompt" },
    appendSystemPrompt: [{ text: "Explicit appended prompt.", source: "--append-system-prompt #1" }],
  });

  const disabled = parseArguments([
    "run", "hello", "--no-context-files",
    "--system-prompt", "Explicit operating prompt.",
    "--append-system-prompt", "Explicit appended prompt.",
  ]);
  assert.deepEqual(await systemPromptCliOptions(disabled, workspace), {
    systemPrompt: { text: "Explicit operating prompt.", source: "--system-prompt" },
    appendSystemPrompt: [{ text: "Explicit appended prompt.", source: "--append-system-prompt #1" }],
  });
  assert.deepEqual(await discoverWorkspacePromptFiles(workspace, false), {});
});

test("global prompt files are fallbacks and trusted project files take precedence", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "harness-global-system-workspace-"));
  const globalDirectory = await mkdtemp(join(tmpdir(), "harness-global-system-config-"));
  await writeFile(join(globalDirectory, "SYSTEM.md"), "Global operating prompt.");
  await writeFile(join(globalDirectory, "APPEND_SYSTEM.md"), "Global appended prompt.");

  assert.deepEqual(await discoverWorkspacePromptFiles(workspace, false, { globalDirectory }), {
    systemPrompt: { text: "Global operating prompt.", source: "SYSTEM.md" },
    appendSystemPrompt: [{ text: "Global appended prompt.", source: "APPEND_SYSTEM.md" }],
  });

  await mkdir(join(workspace, ".rigyn"));
  await writeFile(join(workspace, ".rigyn", "SYSTEM.md"), "Project operating prompt.");
  await writeFile(join(workspace, ".rigyn", "APPEND_SYSTEM.md"), "Project appended prompt.");
  assert.deepEqual(await discoverWorkspacePromptFiles(workspace, true, { globalDirectory }), {
    systemPrompt: { text: "Project operating prompt.", source: ".rigyn/SYSTEM.md" },
    appendSystemPrompt: [{ text: "Project appended prompt.", source: ".rigyn/APPEND_SYSTEM.md" }],
  });
});

test("an absent global prompt directory is treated as having no prompt files", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-missing-global-system-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);

  assert.deepEqual(await discoverWorkspacePromptFiles(workspace, false, {
    globalDirectory: join(root, "missing", "rigyn"),
  }), {});
});

test("automatic workspace prompt files cannot escape through symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-auto-system-boundary-"));
  const workspace = join(root, "workspace");
  const harnessDirectory = join(workspace, ".rigyn");
  await mkdir(harnessDirectory, { recursive: true });
  const outside = join(root, "outside.md");
  await writeFile(outside, "must not load");
  await symlink(outside, join(harnessDirectory, "SYSTEM.md"));
  await assert.rejects(
    discoverWorkspacePromptFiles(workspace, true),
    /outside workspace|escapes workspace|Workspace/u,
  );
});

test("custom system prompts replace operating guidance and keep run context", () => {
  const prompt = buildSystemPrompt({
    workspace: "/workspace",
    instructions: { entries: [], totalBytes: 0, truncated: false },
    skills: [],
    customPrompt: { text: "Use a proof-driven workflow.", source: "team.md" },
    appendSystemPrompt: [{ text: "Summarize verification.", source: "release.md" }],
  });

  assert.match(prompt, /Use a proof-driven workflow/u);
  assert.match(prompt, /Summarize verification/u);
  assert.doesNotMatch(prompt, /Work until the user's requested outcome/u);
  assert.match(prompt, /Current date:/u);
  assert.match(prompt, /Current working directory: \/workspace/u);
  assert.ok(prompt.indexOf("Use a proof-driven workflow.") < prompt.indexOf("Current date:"));
});

test("default system prompt requires inspection, focused edits, verification, and routed self-knowledge", () => {
  const prompt = buildSystemPrompt({
    workspace: "/workspace",
    instructions: { entries: [], totalBytes: 0, truncated: false },
    skills: [],
  });

  assert.match(prompt, /Inspect relevant files before changing them/u);
  assert.match(prompt, /smallest coherent change/u);
  assert.match(prompt, /Verify changes with the most relevant tests or commands/u);
  assert.match(prompt, /failed verification as unfinished work/u);
  assert.match(prompt, /never claim success from a command that exited unsuccessfully/u);
  assert.match(prompt, /providers\/auth\/models \(docs\/providers\.md\)/u);
  assert.match(prompt, /extensions\/packages\/themes\/prompts\/TUI \(docs\/extensions\.md and docs\/tui\.md\)/u);
});
