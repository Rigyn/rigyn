import { stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { HarnessError } from "../core/errors.js";
import { WorkspaceBoundary, readFileBounded } from "../tools/paths.js";
import { findNestedGitWorktree } from "./git-worktree.js";

export interface InstructionEntry {
  text: string;
  source: string;
  scope: "user" | "workspace";
  directory?: string;
  trusted: boolean;
  bytesRead: number;
  totalBytes: number;
  truncated: boolean;
}

export interface InstructionDiscoveryOptions {
  workspaceRoot: string;
  cwd: string;
  trusted: boolean;
  userInstructions?: { text: string; source?: string };
  userInstructionFile?: string;
  includeFiles?: boolean;
  filenames?: string[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface DiscoveredInstructions {
  entries: InstructionEntry[];
  totalBytes: number;
  truncated: boolean;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function boundedBuffer(
  encoded: Uint8Array,
  maxBytes: number,
): { text: string; bytes: number; truncated: boolean } {
  let end = Math.min(encoded.byteLength, maxBytes);
  while (end > 0) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(encoded.subarray(0, end));
      break;
    } catch {
      end -= 1;
    }
  }
  const selected = encoded.subarray(0, end);
  return {
    text: Buffer.from(selected).toString("utf8"),
    bytes: selected.byteLength,
    truncated: selected.byteLength < encoded.byteLength,
  };
}

function boundedText(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  return boundedBuffer(Buffer.from(text, "utf8"), maxBytes);
}

function assertWithinWorkspace(root: string, cwd: string): void {
  const path = relative(root, cwd);
  if (path === ".." || path.startsWith(`..${sep}`)) {
    throw new HarnessError("CONTEXT_BOUNDARY", `Working directory escapes workspace: ${cwd}`);
  }
}

function directoriesFromFilesystemRoot(cwd: string): string[] {
  const directories: string[] = [];
  let cursor = cwd;
  while (true) {
    directories.unshift(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) return directories;
    cursor = parent;
  }
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

async function instructionFile(
  directory: string,
  filenames: string[],
  boundary: WorkspaceBoundary,
): Promise<{ filename: string; path: string } | undefined> {
  for (const filename of filenames) {
    const candidate = resolve(directory, filename);
    let readable: string;
    try {
      readable = await boundary.readable(candidate);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    if ((await stat(readable)).isFile()) return { filename, path: readable };
  }
  return undefined;
}

export async function discoverInstructions(
  options: InstructionDiscoveryOptions,
): Promise<DiscoveredInstructions> {
  const maxFileBytes = options.maxFileBytes ?? 64 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new RangeError("maxFileBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) {
    throw new RangeError("maxTotalBytes must be a positive safe integer");
  }
  const filenames = options.filenames ?? ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];
  if (filenames.length === 0 || filenames.some((name) => name.length === 0 || name.includes("/") || name.includes("\\"))) {
    throw new HarnessError("CONTEXT_INSTRUCTIONS", "Instruction filenames must be simple names");
  }

  try {
    const entries: InstructionEntry[] = [];
    let remaining = maxTotalBytes;
    let anyTruncated = false;

    if (options.userInstructions !== undefined && remaining > 0) {
      const selected = boundedText(options.userInstructions.text, remaining);
      entries.push({
        text: selected.text,
        source: options.userInstructions.source ?? "<user-instructions>",
        scope: "user",
        trusted: true,
        bytesRead: selected.bytes,
        totalBytes: Buffer.byteLength(options.userInstructions.text, "utf8"),
        truncated: selected.truncated,
      });
      remaining -= selected.bytes;
      anyTruncated ||= selected.truncated;
    }

    if (options.includeFiles === false) {
      return { entries, totalBytes: maxTotalBytes - remaining, truncated: anyTruncated };
    }

    if (options.userInstructionFile !== undefined && remaining > 0) {
      const candidate = resolve(options.userInstructionFile);
      let readable: string | undefined;
      try {
        const userBoundary = await WorkspaceBoundary.create(dirname(candidate));
        readable = await userBoundary.readable(candidate);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (readable !== undefined) {
        if (!(await stat(readable)).isFile()) readable = undefined;
      }
      if (readable !== undefined) {
        const result = await readFileBounded(readable, Math.min(maxFileBytes, remaining));
        const decoded = boundedBuffer(result.data, result.data.byteLength);
        entries.push({
          text: decoded.text,
          source: readable,
          scope: "user",
          trusted: true,
          bytesRead: decoded.bytes,
          totalBytes: result.totalBytes,
          truncated: result.truncated || decoded.truncated,
        });
        remaining -= decoded.bytes;
        anyTruncated ||= result.truncated || decoded.truncated;
      }
    }

    const initialBoundary = await WorkspaceBoundary.create(options.workspaceRoot);
    const realRoot = await initialBoundary.readable(".");
    const workspaceBoundary = await WorkspaceBoundary.create(realRoot);
    const realCwd = await workspaceBoundary.readable(options.cwd);
    assertWithinWorkspace(realRoot, realCwd);
    const worktree = findNestedGitWorktree(realCwd);
    let shadowedMainInstruction: string | undefined;
    if (worktree !== undefined) {
      const boundary = within(realRoot, worktree.worktreeRoot)
        ? workspaceBoundary
        : await WorkspaceBoundary.create(worktree.worktreeRoot);
      const local = await instructionFile(worktree.worktreeRoot, filenames, boundary);
      if (local !== undefined) {
        shadowedMainInstruction = resolve(worktree.mainRoot, local.filename);
      }
    }
    for (const directory of directoriesFromFilesystemRoot(realCwd)) {
      if (remaining === 0) {
        anyTruncated = true;
        break;
      }
      const boundary = within(realRoot, directory)
        ? workspaceBoundary
        : await WorkspaceBoundary.create(directory);
      const selected = await instructionFile(directory, filenames, boundary);
      if (selected === undefined
        || resolve(directory, selected.filename) === shadowedMainInstruction) continue;
      const limit = Math.min(maxFileBytes, remaining);
      const result = await readFileBounded(selected.path, limit);
      const decoded = boundedBuffer(result.data, result.data.byteLength);
      entries.push({
        text: decoded.text,
        source: selected.path,
        scope: "workspace",
        directory,
        trusted: options.trusted,
        bytesRead: decoded.bytes,
        totalBytes: result.totalBytes,
        truncated: result.truncated || decoded.truncated,
      });
      remaining -= decoded.bytes;
      anyTruncated ||= result.truncated || decoded.truncated;
    }
    return { entries, totalBytes: maxTotalBytes - remaining, truncated: anyTruncated };
  } catch (cause) {
    if (cause instanceof HarnessError) throw cause;
    throw new HarnessError("CONTEXT_BOUNDARY", "Instruction discovery crossed a filesystem boundary", {
      cause,
    });
  }
}

export function renderInstructions(instructions: DiscoveredInstructions): string {
  return instructions.entries
    .map((entry) => {
      const label = entry.scope === "user" ? entry.source : `${entry.source} (${entry.trusted ? "trusted" : "untrusted"})`;
      return `[instructions: ${label}]\n${entry.text}`;
    })
    .join("\n\n");
}
