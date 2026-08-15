import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

import type { SkillRoot } from "./skills.js";

const SHARED_SKILL_DIRECTORIES = [".agents", ".claude", ".codex"] as const;

/**
 * Compatible user roots in ascending precedence. Later roots win name
 * collisions when passed to discoverSkillsDetailed().
 */
export function sharedUserSkillRoots(homeDirectory: string): SkillRoot[] {
  return SHARED_SKILL_DIRECTORIES.map((directory) => ({
    path: join(homeDirectory, directory, "skills"),
    scope: "user",
    trusted: true,
    rootMarkdown: false,
  }));
}

/**
 * Compatible workspace roots in ascending precedence. Project roots are never
 * returned before the workspace has been trusted.
 */
export function sharedWorkspaceSkillRoots(
  workspace: string,
  projectTrusted: boolean,
  homeDirectory = process.env.HOME || homedir(),
): SkillRoot[] {
  if (!projectTrusted) return [];
  const resolvedWorkspace = resolve(workspace);
  const home = resolvedHomeDirectory(homeDirectory);
  return [
    ...sharedWorkspaceAgentSkillDirectories(resolvedWorkspace, homeDirectory),
    ...SHARED_SKILL_DIRECTORIES
      .filter((directory) => directory !== ".agents")
      .filter(() => resolvedWorkspace !== home)
      .map((directory) => join(resolvedWorkspace, directory, "skills")),
  ].map((path) => ({
    path,
    scope: "workspace",
    trusted: true,
    rootMarkdown: false,
  }));
}

function resolvedHomeDirectory(value = process.env.HOME || homedir()): string {
  return resolve(value.trim() !== "" && isAbsolute(value) ? value : homedir());
}

function workspaceBoundary(start: string): string {
  let cursor = start;
  while (true) {
    if (existsSync(join(cursor, ".git"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return parse(start).root;
    cursor = parent;
  }
}

/** Candidate project skill directories from the outer boundary to the launch directory. */
export function sharedWorkspaceAgentSkillDirectories(
  workspace: string,
  homeDirectory = process.env.HOME || homedir(),
): string[] {
  const resolvedWorkspace = resolve(workspace);
  const home = resolvedHomeDirectory(homeDirectory);
  const boundary = workspaceBoundary(resolvedWorkspace);
  const roots: string[] = [];
  let cursor = resolvedWorkspace;
  while (true) {
    if (cursor !== home) roots.unshift(join(cursor, ".agents", "skills"));
    if (cursor === boundary) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return roots;
}
