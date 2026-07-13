import { resolve } from "node:path";

import { readFileBounded, WorkspaceBoundary } from "../tools/index.js";
import { flagString, flagStrings, type ParsedArguments } from "./args.js";

const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_APPEND_PROMPTS = 32;
const MAX_TOTAL_BYTES = 1024 * 1024;

export interface SystemPromptCliOptions {
  systemPrompt?: { text: string; source: string };
  appendSystemPrompt?: Array<{ text: string; source: string }>;
}

export async function systemPromptCliOptions(
  argumentsValue: ParsedArguments,
  workspace: string,
): Promise<SystemPromptCliOptions> {
  const custom = flagString(argumentsValue, "system-prompt");
  const append = flagStrings(argumentsValue, "append-system-prompt");
  if (custom === undefined && append.length === 0) return {};
  if (append.length > MAX_APPEND_PROMPTS) {
    throw new Error(`--append-system-prompt may be used at most ${MAX_APPEND_PROMPTS} times`);
  }
  const boundary = await WorkspaceBoundary.create(workspace);
  const systemPrompt = custom === undefined
    ? undefined
    : await resolvePromptSource(custom, "--system-prompt", workspace, boundary);
  const appendSystemPrompt = await Promise.all(append.map(async (value, index) =>
    await resolvePromptSource(value, `--append-system-prompt #${index + 1}`, workspace, boundary)));
  const totalBytes = (systemPrompt === undefined ? 0 : Buffer.byteLength(systemPrompt.text, "utf8")) +
    appendSystemPrompt.reduce((total, entry) => total + Buffer.byteLength(entry.text, "utf8"), 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error("System-prompt customizations exceed 1 MiB in total");
  return {
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(appendSystemPrompt.length === 0 ? {} : { appendSystemPrompt }),
  };
}

async function resolvePromptSource(
  value: string,
  label: string,
  workspace: string,
  boundary: WorkspaceBoundary,
): Promise<{ text: string; source: string }> {
  if (value === "" || value.includes("\0")) throw new Error(`${label} must not be empty or contain NUL`);
  const escapedAt = value.startsWith("@@");
  const explicitPath = value.startsWith("@") && !escapedAt;
  const selected = escapedAt ? value.slice(1) : explicitPath ? value.slice(1) : value;
  if (explicitPath && selected === "") throw new Error(`${label} @file path is empty`);
  if (!explicitPath) return literalPrompt(selected, label);
  const candidate = resolve(workspace, selected);
  const file = await boundary.readableFile(candidate);
  return await readPromptFile(file.path, file.relativePath, label);
}

async function readPromptFile(
  path: string,
  source: string,
  label: string,
): Promise<{ text: string; source: string }> {
  const loaded = await readFileBounded(path, MAX_PROMPT_BYTES + 1);
  if (loaded.truncated || loaded.totalBytes > MAX_PROMPT_BYTES) throw new Error(`${label} file exceeds 256 KiB`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(loaded.data);
  } catch {
    throw new Error(`${label} file must be valid UTF-8`);
  }
  if (text.includes("\0")) throw new Error(`${label} file must not contain NUL`);
  return { text, source };
}

function literalPrompt(text: string, source: string): { text: string; source: string } {
  if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) throw new Error(`${source} text exceeds 256 KiB`);
  return { text, source };
}
