import { join } from "node:path";

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
  return SHARED_SKILL_DIRECTORIES.map((directory) => ({
    path: join(workspace, directory, "skills"),
    scope: "workspace",
    trusted: true,
    rootMarkdown: false,
  }));
}
