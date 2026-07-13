import { readFileBounded, WorkspaceBoundary } from "../tools/paths.js";

const MAX_PROMPT_BYTES = 256 * 1024;

export interface WorkspacePromptFiles {
  systemPrompt?: { text: string; source: string };
  appendSystemPrompt?: Array<{ text: string; source: string }>;
}

export interface WorkspacePromptFileDiscoveryOptions {
  includeSystemPrompt?: boolean;
}

export async function discoverWorkspacePromptFiles(
  workspaceRoot: string,
  trusted: boolean,
  options: WorkspacePromptFileDiscoveryOptions = {},
): Promise<WorkspacePromptFiles> {
  if (!trusted) return {};
  const boundary = await WorkspaceBoundary.create(workspaceRoot);
  const systemPrompt = options.includeSystemPrompt === false
    ? undefined
    : await optionalPromptFile(boundary, ".rigyn/SYSTEM.md");
  const appendSystemPrompt = await optionalPromptFile(boundary, ".rigyn/APPEND_SYSTEM.md");
  return {
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt: [appendSystemPrompt] }),
  };
}

async function optionalPromptFile(
  boundary: WorkspaceBoundary,
  relativePath: string,
): Promise<{ text: string; source: string } | undefined> {
  let file: { path: string; relativePath: string };
  try {
    file = await boundary.readableFile(relativePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
  const loaded = await readFileBounded(file.path, MAX_PROMPT_BYTES + 1);
  if (loaded.truncated || loaded.totalBytes > MAX_PROMPT_BYTES) {
    throw new Error(`${relativePath} exceeds 256 KiB`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(loaded.data);
  } catch {
    throw new Error(`${relativePath} must be valid UTF-8`);
  }
  if (text.includes("\0")) throw new Error(`${relativePath} must not contain NUL`);
  return { text, source: file.relativePath };
}
