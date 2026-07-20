import type { Dir, Stats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import {
  canonicalExistingPath,
  TrustStore,
  type DefaultProjectTrust,
} from "../config/index.js";
import type { RuntimeExtensionHost, RuntimeProjectTrustUi } from "../extensions/index.js";
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
  cwd?: string;
  preactivate?: (workspace: string) => Promise<RuntimeExtensionHost | undefined>;
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
  readonly #cwd: Promise<string>;
  readonly #preactivate: ProjectTrustResolverOptions["preactivate"];
  readonly #prompted = new Map<string, { decision: boolean; persisted: boolean }>();
  readonly #resources = new Map<string, readonly string[]>();
  readonly #extensionEvaluated = new Set<string>();
  readonly #preactivated = new Map<string, RuntimeExtensionHost>();
  readonly #flights = new Map<string, Promise<boolean>>();

  constructor(store: TrustStore, options: ProjectTrustResolverOptions = {}) {
    this.#store = store;
    this.#override = options.override;
    this.#terminal = options.terminal;
    this.#defaultProjectTrust = options.defaultProjectTrust ?? "ask";
    this.#cwd = canonicalExistingPath(resolve(options.cwd ?? process.cwd()));
    this.#preactivate = options.preactivate;
  }

  async isTrusted(workspace: string): Promise<boolean> {
    const canonical = await canonicalExistingPath(workspace);
    if (this.#override !== undefined) return this.#override === "approve";
    const existing = this.#flights.get(canonical);
    if (existing !== undefined) return await existing;
    const flight = this.#resolve(canonical);
    this.#flights.set(canonical, flight);
    try {
      return await flight;
    } catch (error) {
      const host = this.#preactivated.get(canonical);
      this.#preactivated.delete(canonical);
      if (host === undefined) throw error;
      try {
        await host.close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Project trust and preactivated extension cleanup failed");
      }
      throw error;
    } finally {
      if (this.#flights.get(canonical) === flight) this.#flights.delete(canonical);
    }
  }

  /** Transfers ownership of the pre-trust extension generation to the runtime loader. */
  async takePreactivatedExtensions(workspace: string): Promise<RuntimeExtensionHost | undefined> {
    const canonical = await canonicalExistingPath(workspace);
    await this.#flights.get(canonical);
    const host = this.#preactivated.get(canonical);
    this.#preactivated.delete(canonical);
    return host;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.#flights.values());
    const hosts = [...this.#preactivated.values()];
    this.#preactivated.clear();
    const results = await Promise.allSettled(hosts.map(async (host) => await host.close()));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Pre-trust extension cleanup failed");
  }

  async #resolve(canonical: string): Promise<boolean> {
    let resources = this.#resources.get(canonical);
    if (resources === undefined) {
      resources = await discoverProjectTrustResources(canonical);
      this.#resources.set(canonical, resources);
    }
    if (resources.length === 0) return await this.#store.decision(canonical) ?? false;

    if (!this.#extensionEvaluated.has(canonical)) {
      this.#extensionEvaluated.add(canonical);
      const host = await this.#preactivate?.(canonical);
      if (host !== undefined) {
        this.#preactivated.set(canonical, host);
        const cwd = await this.#cwd;
        const terminal = this.#terminal;
        const ui: RuntimeProjectTrustUi = terminal === undefined
          ? {
              hasUI: false,
              async confirm(): Promise<boolean> {
                throw new Error("Interactive project trust UI is unavailable");
              },
            }
          : {
              hasUI: true,
              async confirm(title, message, signal): Promise<boolean> {
                return await terminal.choose(`${title} · ${message}`, [
                  { label: "Yes", value: true },
                  { label: "No", value: false },
                ], signal);
              },
            };
        const result = await host.resolveProjectTrust({ workspace: canonical, cwd }, ui);
        if (result.decision !== "undecided") {
          const decision = result.decision === "yes";
          if (result.remember === true) {
            if (decision) await this.#store.trust(canonical);
            else await this.#store.deny(canonical);
          }
          this.#prompted.set(canonical, { decision, persisted: result.remember === true });
          return decision;
        }
      }
    }

    const prompted = this.#prompted.get(canonical);
    if (prompted !== undefined && !prompted.persisted) return prompted.decision;
    const stored = await this.#store.decision(canonical);
    if (stored !== undefined) return stored;
    if (prompted?.persisted === true) return false;
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
