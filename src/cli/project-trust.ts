import type { Dir, Stats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import {
  canonicalExistingPath,
  TrustStore,
  type DefaultProjectTrust,
} from "../config/index.js";
import type { TerminalPrompter } from "../interfaces/index.js";

const PROJECT_FILES = [
  ".rigyn/config.jsonc",
  ".rigyn/packages.json",
  ".rigyn/packages.lock.json",
  ".rigyn/SYSTEM.md",
  ".rigyn/APPEND_SYSTEM.md",
] as const;

const PROJECT_DIRECTORIES = [
  ".rigyn/extensions",
  ".rigyn/packages",
  ".rigyn/skills",
  ".rigyn/prompts",
  ".rigyn/themes",
  ".agents/skills",
  ".claude/skills",
  ".codex/skills",
] as const;

export type ProjectTrustOverride = "approve" | "deny";

function missing(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function directoryContainsResource(path: string): Promise<boolean> {
  let information: Stats;
  try {
    information = await lstat(path);
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
  if (!information.isDirectory() || information.isSymbolicLink()) return true;
  let directory: Dir | undefined;
  try {
    directory = await opendir(path);
    return await directory.read() !== null;
  } catch (error) {
    if (missing(error)) return false;
    if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) {
      // An existing but unreadable project resource still requires a decision.
      return true;
    }
    throw error;
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

/** Finds trust-gated project resources without reading or executing their contents. */
export async function discoverProjectTrustResources(workspace: string): Promise<string[]> {
  const canonical = await canonicalExistingPath(workspace);
  const resources: string[] = [];
  for (const relativePath of PROJECT_FILES) {
    if (await pathExists(join(canonical, relativePath))) resources.push(relativePath);
  }
  for (const relativePath of PROJECT_DIRECTORIES) {
    if (await directoryContainsResource(join(canonical, relativePath))) resources.push(relativePath);
  }
  return resources;
}

type ProjectTrustChoice = "workspace" | "parent" | "session" | "disabled" | "disabled-session";

export interface ProjectTrustResolverOptions {
  override?: ProjectTrustOverride;
  terminal?: TerminalPrompter;
  defaultProjectTrust?: DefaultProjectTrust;
}

/**
 * Resolves project-resource trust once per workspace for one CLI invocation.
 * Persisted trust is re-read on later checks so a revoked decision cannot race
 * a cross-workspace runtime activation.
 */
export class ProjectTrustResolver {
  readonly #store: TrustStore;
  readonly #override: ProjectTrustOverride | undefined;
  readonly #terminal: TerminalPrompter | undefined;
  readonly #defaultProjectTrust: DefaultProjectTrust;
  readonly #prompted = new Map<string, { decision: boolean; persisted: boolean }>();
  readonly #resources = new Map<string, readonly string[]>();

  constructor(store: TrustStore, options: ProjectTrustResolverOptions = {}) {
    this.#store = store;
    this.#override = options.override;
    this.#terminal = options.terminal;
    this.#defaultProjectTrust = options.defaultProjectTrust ?? "ask";
  }

  async isTrusted(workspace: string): Promise<boolean> {
    const canonical = await canonicalExistingPath(workspace);
    if (this.#override !== undefined) return this.#override === "approve";
    const stored = await this.#store.decision(canonical);
    if (stored !== undefined) return stored;
    const prompted = this.#prompted.get(canonical);
    if (prompted !== undefined) return prompted.persisted ? false : prompted.decision;

    let resources = this.#resources.get(canonical);
    if (resources === undefined) {
      resources = await discoverProjectTrustResources(canonical);
      this.#resources.set(canonical, resources);
    }
    if (resources.length === 0) return false;
    if (this.#defaultProjectTrust !== "ask") {
      const decision = this.#defaultProjectTrust === "always";
      this.#prompted.set(canonical, { decision, persisted: false });
      return decision;
    }
    if (this.#terminal === undefined) return false;

    const parent = dirname(canonical);
    const choices: Array<{ label: string; detail: string; value: ProjectTrustChoice }> = [
      {
        label: "Enable this workspace",
        detail: "Remember this folder and activate its project configuration and code",
        value: "workspace",
      },
      ...(parent === parse(parent).root
        ? []
        : [{
            label: "Enable the parent directory",
            detail: `Remember ${parent} and apply trust to its subdirectories`,
            value: "parent" as const,
          }]),
      {
        label: "Enable for this launch",
        detail: "Activate this workspace without saving a trust decision",
        value: "session",
      },
      {
        label: "Keep disabled for this workspace",
        detail: "Remember this folder and skip its project configuration, extensions, and skills",
        value: "disabled",
      },
      {
        label: "Keep disabled for this launch",
        detail: "Continue without project resources and ask again on a later launch",
        value: "disabled-session",
      },
    ];
    const found = resources.length <= 3
      ? resources.join(", ")
      : `${resources.slice(0, 3).join(", ")} and ${resources.length - 3} more`;
    const choice = await this.#terminal.choose(`Project resources found · ${found}`, choices);
    if (choice === "session" || choice === "disabled-session") {
      const decision = choice === "session";
      this.#prompted.set(canonical, { decision, persisted: false });
      return decision;
    }
    if (choice === "disabled") {
      await this.#store.deny(canonical);
      this.#prompted.set(canonical, { decision: false, persisted: true });
      return false;
    }

    if (choice === "workspace") await this.#store.trust(canonical);
    else await this.#store.trustDescendants(parent);
    this.#prompted.set(canonical, { decision: true, persisted: true });
    return await this.#store.isTrusted(canonical);
  }
}
