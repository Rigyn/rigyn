import { fileURLToPath } from "node:url";

import { createId } from "./ids.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";
import type { CanonicalMessage } from "./types.js";

export interface ProjectInstruction {
  path: string;
  content: string;
}

export interface BuildSystemPromptOptions {
  cwd: string;
  customPrompt?: string;
  appendSystemPrompt?: string;
  contextFiles?: readonly ProjectInstruction[];
  skills?: readonly Skill[];
  selectedTools?: readonly string[];
  toolSnippets?: Readonly<Record<string, string>>;
  promptGuidelines?: readonly string[];
}

function attribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", "&#xA;");
}

function projectInstruction(instruction: ProjectInstruction): string {
  return `<project_instructions path="${attribute(instruction.path)}">\n${instruction.content}\n</project_instructions>`;
}

export function instructionMessage(prompt: string): CanonicalMessage {
  return {
    id: createId("msg"),
    role: "system",
    purpose: "instructions",
    content: [{ type: "text", text: prompt }],
    createdAt: new Date().toISOString(),
  };
}

function defaultPrompt(options: BuildSystemPromptOptions): string {
  const tools = options.selectedTools ?? [];
  const described = tools.flatMap((name) => {
    const description = options.toolSnippets?.[name];
    return description === undefined ? [] : [`- ${name}: ${description}`];
  });
  const guidelines = new Set((options.promptGuidelines ?? []).map((value) => value.trim()).filter(Boolean));
  if (tools.includes("bash") && !tools.some((name) => ["grep", "find", "ls"].includes(name))) {
    guidelines.add("Use bash for file discovery when no dedicated discovery tool is selected.");
  }
  return [
    "You are Rigyn, a coding agent working in the user's environment.",
    "Understand the request, make precise changes, and verify results. Inspect relevant project files before changing them.",
    "Preserve unrelated work, explain important tradeoffs, and create or modify files only when the task requires it.",
    "Give summaries directly in your response.",
    "Read the relevant documents and directly referenced Markdown files completely before relying on them.",
    "An empty AGENTS.md adds no instructions.",
    `Built-in prompt implementation: ${fileURLToPath(import.meta.url)}. The built-in rigyn prompt is public product source; when asked, read the listed implementation and explain or quote that source directly.`,
    "",
    "Available tools:",
    ...(described.length === 0 ? ["(none)"] : described),
    ...(guidelines.size === 0 ? [] : ["", "Tool guidance:", ...[...guidelines].map((value) => `- ${value}`)]),
  ].join("\n");
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const sections = [options.customPrompt ?? defaultPrompt(options)];
  if (options.appendSystemPrompt !== undefined && options.appendSystemPrompt !== "") sections.push(options.appendSystemPrompt);
  sections.push(...(options.contextFiles ?? []).map(projectInstruction));
  if ((options.selectedTools ?? []).includes("read")) {
    const skills = formatSkillsForPrompt(options.skills ?? []);
    if (skills !== "") sections.push(skills);
  }
  sections.push(`Current working directory: ${options.cwd.replaceAll("\\", "/")}`);
  return sections.join("\n\n");
}
