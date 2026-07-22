import { access } from "node:fs/promises";
import { homedir } from "node:os";
import type { AuthContext } from "./types.js";

export function defaultProviderAuthContext(environment: NodeJS.ProcessEnv = process.env): AuthContext {
  return {
    async env(name) { const value = environment[name]; return value?.trim() ? value : undefined; },
    async fileExists(path) { try { await access(path.startsWith("~") ? `${homedir()}${path.slice(1)}` : path); return true; } catch { return false; } },
  };
}
