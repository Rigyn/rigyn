import { lstatSync, opendirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { sharedWorkspaceAgentSkillDirectories } from "../context/skill-roots.js";
import { TrustStore } from "./trust.js";
import { CONFIG_DIR_NAME, getAgentDir } from "./paths.js";
import { canonicalizePath, resolvePath } from "../utils/paths.js";
import { projectConfigRootMatchesAgentDir } from "../utils/project-scope.js";

export type ProjectTrustDecision = boolean | null;

export interface ProjectTrustStoreEntry {
  decision: boolean;
  path: string;
}

export interface ProjectTrustUpdate {
  decision: ProjectTrustDecision;
  path: string;
}

const PROJECT_CONFIG_FILES = [
  "config.json",
  "packages.json",
  "packages.lock.json",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
] as const;

const PROJECT_CONFIG_DIRECTORIES = [
  "extensions",
  "packages",
  "skills",
  "prompts",
  "themes",
] as const;

const SHARED_SKILL_DIRECTORIES = [".agents", ".claude", ".codex"] as const;

function missing(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

function directoryContainsResource(path: string): boolean {
  let information: ReturnType<typeof lstatSync>;
  try {
    information = lstatSync(path);
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
  if (!information.isDirectory() || information.isSymbolicLink()) return true;
  let directory: ReturnType<typeof opendirSync> | undefined;
  try {
    directory = opendirSync(path);
    return directory.readSync() !== null;
  } catch (error) {
    if (missing(error)) return false;
    if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) {
      return true;
    }
    throw error;
  } finally {
    directory?.closeSync();
  }
}

/** Fast presence check for trust-gated project resources; it never reads their contents. */
export function hasTrustRequiringProjectResources(
  cwd: string,
  homeDirectory = process.env.HOME ?? homedir(),
): boolean {
  const home = canonicalizePath(resolvePath(
    homeDirectory.trim().length > 0 && isAbsolute(homeDirectory) ? homeDirectory : homedir(),
  ));
  const current = canonicalizePath(resolvePath(cwd));
  if (projectConfigRootMatchesAgentDir(current, getAgentDir())) return false;
  const config = join(current, CONFIG_DIR_NAME);
  if (PROJECT_CONFIG_FILES.some((name) => pathExists(join(config, name)))) return true;
  if (PROJECT_CONFIG_DIRECTORIES.some((name) => directoryContainsResource(join(config, name)))) return true;
  if (current !== home && SHARED_SKILL_DIRECTORIES
    .filter((directory) => directory !== ".agents")
    .some((directory) => directoryContainsResource(join(current, directory, "skills")))) return true;
  return sharedWorkspaceAgentSkillDirectories(current, home).some(directoryContainsResource);
}

/** Public project-decision wrapper around the same secure store used by the CLI. */
export class ProjectTrustStore {
  readonly #store: TrustStore;

  constructor(agentDir: string) {
    this.#store = new TrustStore(join(resolvePath(agentDir), "trusted-workspaces.json"));
  }

  async get(cwd: string): Promise<ProjectTrustDecision> {
    return (await this.getEntry(cwd))?.decision ?? null;
  }

  async getEntry(cwd: string): Promise<ProjectTrustStoreEntry | null> {
    const entry = await this.#store.decisionEntry(cwd);
    return entry === undefined ? null : { path: entry.workspace, decision: entry.decision };
  }

  async set(cwd: string, decision: ProjectTrustDecision): Promise<void> {
    await this.setMany([{ path: cwd, decision }]);
  }

  async setMany(updates: readonly ProjectTrustUpdate[]): Promise<void> {
    await this.#store.setDecisions(updates.map(({ path, decision }) => ({
      workspace: path,
      decision,
      ...(decision === true ? { descendants: true as const } : {}),
    })));
  }
}
