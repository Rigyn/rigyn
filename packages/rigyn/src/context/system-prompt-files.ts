import { readFileBounded, WorkspaceBoundary } from "../tools/paths.js";

const MAX_PROMPT_BYTES = 256 * 1024;

export interface WorkspacePromptFiles {
  systemPrompt?: { text: string; source: string };
  appendSystemPrompt?: Array<{ text: string; source: string }>;
}

export interface WorkspacePromptFileDiscoveryOptions {
  includeSystemPrompt?: boolean;
  /** Trusted user-level prompt files stored directly in this directory. */
  globalDirectory?: string;
}

export async function discoverWorkspacePromptFiles(
  workspaceRoot: string,
  trusted: boolean,
  options: WorkspacePromptFileDiscoveryOptions = {},
): Promise<WorkspacePromptFiles> {
  const boundary = trusted ? await WorkspaceBoundary.create(workspaceRoot) : undefined;
  let globalBoundary: WorkspaceBoundary | undefined;
  if (options.globalDirectory !== undefined) {
    try {
      globalBoundary = await WorkspaceBoundary.create(options.globalDirectory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  const systemPrompt = options.includeSystemPrompt === false
    ? undefined
    : await firstPromptFile([
        ...(boundary === undefined ? [] : [{ boundary, path: ".rigyn/SYSTEM.md" }]),
        ...(globalBoundary === undefined ? [] : [{ boundary: globalBoundary, path: "SYSTEM.md" }]),
      ]);
  const appendSystemPrompt = await firstPromptFile([
    ...(boundary === undefined ? [] : [{ boundary, path: ".rigyn/APPEND_SYSTEM.md" }]),
    ...(globalBoundary === undefined ? [] : [{ boundary: globalBoundary, path: "APPEND_SYSTEM.md" }]),
  ]);
  return {
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt: [appendSystemPrompt] }),
  };
}

async function firstPromptFile(
  candidates: ReadonlyArray<{ boundary: WorkspaceBoundary; path: string }>,
): Promise<{ text: string; source: string } | undefined> {
  for (const candidate of candidates) {
    const result = await optionalPromptFile(candidate.boundary, candidate.path);
    if (result !== undefined) return result;
  }
  return undefined;
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
