import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createId } from "./ids.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";
import type { CanonicalMessage } from "./types.js";

export interface BuildSystemPromptOptions {
  customPrompt?: string;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  cwd: string;
  contextFiles?: Array<{ path: string; content: string }>;
  skills?: Skill[];
}

function appendContext(prompt: string, files: readonly { path: string; content: string }[]): string {
  if (files.length === 0) return prompt;
  const entries = files.map((file) =>
    `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`
  ).join("\n\n");
  return `${prompt}\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n${entries}\n\n</project_context>\n`;
}

function packagePaths(): { readme: string; docs: string; examples: string } {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const packageRoot = join(sourceDirectory, "..", "..");
  return {
    readme: join(packageRoot, "README.md"),
    docs: join(packageRoot, "docs"),
    examples: join(packageRoot, "examples"),
  };
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const tools = options.selectedTools ?? ["read", "bash", "edit", "write"];
  const contextFiles = options.contextFiles ?? [];
  const skills = options.skills ?? [];
  const cwd = options.cwd.replaceAll("\\", "/");
  const append = options.appendSystemPrompt === undefined ? "" : `\n\n${options.appendSystemPrompt}`;

  if (options.customPrompt !== undefined && options.customPrompt !== "") {
    let prompt = `${options.customPrompt}${append}`;
    prompt = appendContext(prompt, contextFiles);
    if (tools.includes("read") && skills.length > 0) prompt += formatSkillsForPrompt(skills);
    return `${prompt}\nCurrent working directory: ${cwd}`;
  }

  const visibleTools = tools.filter((name) => options.toolSnippets?.[name] !== undefined);
  const toolList = visibleTools.length === 0
    ? "(none)"
    : visibleTools.map((name) => `- ${name}: ${options.toolSnippets![name]}`).join("\n");
  const guidelines: string[] = [];
  const addGuideline = (value: string): void => {
    const normalized = value.trim();
    if (normalized !== "" && !guidelines.includes(normalized)) guidelines.push(normalized);
  };
  if (tools.includes("bash") && !tools.includes("grep") && !tools.includes("find") && !tools.includes("ls")) {
    addGuideline("Use bash for file discovery and search when no dedicated tool is available");
  }
  for (const guideline of options.promptGuidelines ?? []) addGuideline(guideline);
  addGuideline("Keep responses concise");
  addGuideline("Use clear file paths when discussing files");

  const paths = packagePaths();
  let prompt = `You are an expert coding assistant running inside Rigyn. You help users inspect code, execute commands, edit files, and create new files.

Available tools:
${toolList}

Projects and extensions may supply additional tools.

Guidelines:
${guidelines.map((guideline) => `- ${guideline}`).join("\n")}

Rigyn documentation (consult it when a user asks about Rigyn, its SDK, extensions, themes, skills, prompts, models, packages, keybindings, or terminal UI):
- Main documentation: ${paths.readme}
- Topic documentation: ${paths.docs}
- Working examples: ${paths.examples}
- Resolve documentation and example paths against those directories, not the active project
- Read the relevant documents and directly referenced Markdown files completely before implementing Rigyn-specific work`;
  prompt += append;
  prompt = appendContext(prompt, contextFiles);
  if (tools.includes("read") && skills.length > 0) prompt += formatSkillsForPrompt(skills);
  return `${prompt}\nCurrent working directory: ${cwd}`;
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
