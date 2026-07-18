import { createId } from "../core/ids.js";
import type { CanonicalMessage, ToolDefinition } from "../core/types.js";
import type { DiscoveredInstructions } from "../context/instructions.js";
import { renderInstructions } from "../context/instructions.js";
import type { SkillMetadata } from "../context/skills.js";
import { bundledAuthoringResources } from "./resources.js";

const TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  read: "Read text files and images",
  bash: "Execute bash commands",
  edit: "Make precise text replacements",
  write: "Create or overwrite files",
  grep: "Search file contents",
  find: "Find files by pattern",
  ls: "List directory contents",
});

export function buildSystemPrompt(input: {
  workspace: string;
  instructions: DiscoveredInstructions;
  skills: readonly SkillMetadata[];
  selectedTools?: readonly string[];
  toolMetadata?: readonly Pick<ToolDefinition, "name" | "promptSnippet" | "promptGuidelines">[];
  additionalInstructions?: { text: string; source: string };
  customPrompt?: { text: string; source: string };
  appendSystemPrompt?: readonly { text: string; source: string }[];
}): string {
  const { packageRoot, documentationRoot, examplesRoot } = bundledAuthoringResources();
  const date = new Date().toISOString().slice(0, 10);
  const selectedTools = input.selectedTools ?? ["read", "bash", "edit", "write"];
  const toolMetadata = new Map((input.toolMetadata ?? []).map((tool) => [tool.name, tool]));
  const authoringSkill = selectedTools.includes("read")
    ? input.skills.find((skill) => skill.name === "build-extension" && !skill.disableModelInvocation)
    : undefined;
  const toolList = selectedTools
    .flatMap((name) => {
      const snippet = toolMetadata.get(name)?.promptSnippet ?? TOOL_DESCRIPTIONS[name];
      return snippet === undefined
        ? []
        : [`- ${name}: ${boundedPromptText(snippet, `tool ${name} prompt snippet`)}`];
    })
    .join("\n") || "(none)";
  const toolGuidelines = selectedTools.flatMap((name) =>
    (toolMetadata.get(name)?.promptGuidelines ?? []).map((guideline) =>
      `- ${boundedPromptText(guideline, `tool ${name} prompt guideline`)}`));
  const bashGuideline = selectedTools.includes("bash")
    ? "- Use bash for file operations such as ls, rg, and find when dedicated tools are unavailable\n"
    : "";
  const discoveredInstructions = renderInstructions(input.instructions);
  const appended = (input.appendSystemPrompt ?? []).map((entry) =>
    `[appended instructions: ${safeSource(entry.source)}]\n${boundedPromptText(entry.text, "appended system prompt")}`
  );

  let prompt = input.customPrompt === undefined
    ? `You are an expert coding assistant operating inside Rigyn, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolList}

In addition to the tools above, project extensions may provide custom tools.

Guidelines:
- Inspect relevant files before changing them; use tools to resolve facts available in the workspace
- Make the smallest coherent change that satisfies the request and preserve unrelated user work
- Work through the requested outcome; when blocked, state the concrete blocker and what is needed
- Verify changes with the most relevant tests or commands before claiming success
- Treat failed verification as unfinished work: inspect the failure, fix it, and rerun; never claim success from a command that exited unsuccessfully
${bashGuideline}- Be concise in your responses
- Show file paths clearly when working with files
${toolGuidelines.length === 0 ? "" : `${toolGuidelines.join("\n")}\n`}

Rigyn documentation (read only when the user asks about Rigyn itself, extensions, themes, skills, prompt templates, packages, models, keybindings, or the TUI):
- Main documentation: ${packageRoot}README.md
- Additional docs: ${documentationRoot}
- Examples: ${examplesRoot}
- Topic map: architecture (docs/ARCHITECTURE.md), configuration and keybindings (docs/configuration.md), providers/auth/models (docs/providers.md), sessions/compaction (docs/sessions.md), extensions/packages/themes/prompts/TUI (docs/extensions.md and docs/tui.md), package installation/distribution/discovery (docs/packages.md and docs/package-gallery.md)
- Focused package example: examples/reference-package
${authoringSkill === undefined ? "" : `- For extension or package creation, load ${authoringSkill.manifestPath} before implementing; it routes to capability-specific examples and verification\n`}- Resolve those paths under the package root, not the current workspace
- Read the relevant documentation and examples completely, including directly referenced files, before changing Rigyn`
    : boundedPromptText(input.customPrompt.text, "custom system prompt");

  if (appended.length > 0) prompt += `\n\n${appended.join("\n\n")}`;
  if (discoveredInstructions !== "") {
    prompt += `\n\n<project_context>\n${discoveredInstructions}\n</project_context>`;
  }
  prompt += formatSkills(input.skills, selectedTools.includes("read"));
  if (input.additionalInstructions !== undefined) {
    prompt += `\n\n[instructions: ${safeSource(input.additionalInstructions.source)}]\n${boundedPromptText(input.additionalInstructions.text, "additional instructions")}`;
  }
  prompt += `\nCurrent date: ${date}`;
  prompt += `\nCurrent working directory: ${input.workspace.replaceAll("\\", "/")}`;
  return prompt;
}

function formatSkills(skills: readonly SkillMetadata[], canRead: boolean): string {
  const visible = canRead ? skills.filter((skill) => !skill.disableModelInvocation) : [];
  if (visible.length === 0) return "";
  const lines = [
    "",
    "",
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill file when the task matches its description.",
    "Resolve relative references against the directory containing the skill file.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.manifestPath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function safeSource(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "?").slice(0, 512) || "unspecified";
}

function boundedPromptText(value: string, label: string): string {
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > 256 * 1024) {
    throw new Error(`${label} must not contain NUL and must not exceed 256 KiB`);
  }
  return value;
}

export function instructionMessage(prompt: string): CanonicalMessage {
  return {
    id: createId("msg"),
    role: "system",
    content: [{ type: "text", text: prompt }],
    createdAt: new Date().toISOString(),
    purpose: "instructions",
  };
}
