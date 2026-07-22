import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { CONFIG_DIR_NAME } from "./paths.js";
import { canonicalizePath, resolvePath } from "../utils/paths.js";

export type ProjectTrustDecision = boolean | null;

export interface ProjectTrustStoreEntry {
  path: string;
  decision: boolean;
}

export interface ProjectTrustUpdate {
  path: string;
  decision: ProjectTrustDecision;
}

const PROJECT_CONFIG_RESOURCES = [
  "settings.json",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
] as const;

/** Fast presence check for trust-gated project resources; it never reads their contents. */
export function hasTrustRequiringProjectResources(cwd: string): boolean {
  const home = canonicalizePath(resolvePath(process.env.HOME ?? homedir()));
  const userSkills = join(home, ".agents", "skills");
  let current = canonicalizePath(resolvePath(cwd));
  const config = join(current, CONFIG_DIR_NAME);
  if (PROJECT_CONFIG_RESOURCES.some((name) => existsSync(join(config, name)))) return true;
  for (;;) {
    const skills = join(current, ".agents", "skills");
    if (skills !== userSkills && existsSync(skills)) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

type TrustFile = Record<string, boolean | null | undefined>;

function normalizePath(path: string): string {
  return canonicalizePath(resolvePath(path));
}

function readTrustFile(path: string): TrustFile {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Failed to read trust store ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid trust store ${path}: expected an object`);
  }
  const result: TrustFile = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== true && value !== false && value !== null) {
      throw new Error(`Invalid trust store ${path}: value for ${JSON.stringify(key)} must be true, false, or null`);
    }
    result[key] = value;
  }
  return result;
}

function writeTrustFile(path: string, data: TrustFile): void {
  const sorted: TrustFile = {};
  for (const key of Object.keys(data).sort()) {
    const value = data[key];
    if (value === true || value === false || value === null) sorted[key] = value;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      mkdirSync(lockPath);
      return () => rmSync(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  throw lastError;
}

function withLock<T>(path: string, operation: () => T): T {
  const release = acquireLock(path);
  try {
    return operation();
  } finally {
    release();
  }
}

function nearestEntry(data: TrustFile, cwd: string): ProjectTrustStoreEntry | null {
  let current = normalizePath(cwd);
  for (;;) {
    const decision = data[current];
    if (decision === true || decision === false) return { path: current, decision };
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Synchronous project-decision store used by the public host contract. */
export class ProjectTrustStore {
  readonly #path: string;

  constructor(agentDir: string) {
    this.#path = join(resolvePath(agentDir), "trust.json");
  }

  get(cwd: string): ProjectTrustDecision {
    return this.getEntry(cwd)?.decision ?? null;
  }

  getEntry(cwd: string): ProjectTrustStoreEntry | null {
    return withLock(this.#path, () => nearestEntry(readTrustFile(this.#path), cwd));
  }

  set(cwd: string, decision: ProjectTrustDecision): void {
    this.setMany([{ path: cwd, decision }]);
  }

  setMany(updates: ProjectTrustUpdate[]): void {
    withLock(this.#path, () => {
      const data = readTrustFile(this.#path);
      for (const update of updates) {
        const key = normalizePath(update.path);
        if (update.decision === null) delete data[key];
        else data[key] = update.decision;
      }
      writeTrustFile(this.#path, data);
    });
  }
}
