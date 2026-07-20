import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
export function sharedWorkspaceSkillRoots(workspace: string, projectTrusted: boolean): SkillRoot[] {
  if (!projectTrusted) return [];
  const resolvedWorkspace = resolve(workspace);
  const repositoryRoot = findRepositoryRoot(resolvedWorkspace);
  const agentRoots: string[] = [];
  let cursor = resolvedWorkspace;
  while (true) {
    agentRoots.unshift(join(cursor, ".agents", "skills"));
    if (cursor === repositoryRoot) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return [
    ...agentRoots,
    ...SHARED_SKILL_DIRECTORIES
      .filter((directory) => directory !== ".agents")
      .map((directory) => join(resolvedWorkspace, directory, "skills")),
  ].map((path) => ({
    path,
    scope: "workspace",
    trusted: true,
    rootMarkdown: false,
  }));
}

function findRepositoryRoot(start: string): string {
  let cursor = start;
  while (true) {
    if (existsSync(join(cursor, ".git"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return start;
    cursor = parent;
  }
}
