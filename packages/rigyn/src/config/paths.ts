import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizePath } from "../utils/paths.js";
import { RIGYN_VERSION } from "../version.js";

export const APP_NAME = "rigyn";
export const APP_TITLE = "Rigyn";
export const CONFIG_DIR_NAME = ".rigyn";
export const ENV_AGENT_DIR = "RIGYN_CODING_AGENT_DIR";
export const ENV_SESSION_DIR = "RIGYN_CODING_AGENT_SESSION_DIR";
export const VERSION = RIGYN_VERSION;

export function getPackageDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

export function getReadmePath(): string {
  return join(getPackageDir(), "README.md");
}

export function getDocsPath(): string {
  return join(getPackageDir(), "docs");
}

export function getExamplesPath(): string {
  return join(getPackageDir(), "examples");
}

export function getAgentDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment[ENV_AGENT_DIR];
  return configured === undefined || configured === ""
    ? join(homedir(), CONFIG_DIR_NAME, "agent")
    : normalizePath(configured);
}

export function getCustomThemesDir(environment?: NodeJS.ProcessEnv): string {
  return join(getAgentDir(environment), "themes");
}

export function getModelsPath(environment?: NodeJS.ProcessEnv): string {
  return join(getAgentDir(environment), "models.json");
}

export function getAuthPath(environment?: NodeJS.ProcessEnv): string {
  return join(getAgentDir(environment), "auth.json");
}

export function getSettingsPath(environment?: NodeJS.ProcessEnv): string {
  return join(getAgentDir(environment), "settings.json");
}

export function getToolsDir(environment?: NodeJS.ProcessEnv): string {
  return join(getAgentDir(environment), "tools");
}

export function getExtensionsDir(environment?: NodeJS.ProcessEnv): string {
  return join(getAgentDir(environment), "extensions");
}

export function getSkillsDir(environment?: NodeJS.ProcessEnv): string {
  return join(getAgentDir(environment), "skills");
}

export function getBinDir(environment?: NodeJS.ProcessEnv): string {
  return join(getAgentDir(environment), "bin");
}

export function getPromptsDir(environment?: NodeJS.ProcessEnv): string {
  return join(getAgentDir(environment), "prompts");
}

export function getSessionsDir(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment[ENV_SESSION_DIR];
  return configured === undefined || configured === ""
    ? join(getAgentDir(environment), "sessions")
    : normalizePath(configured);
}

export function getDebugLogPath(environment?: NodeJS.ProcessEnv): string {
  return join(getAgentDir(environment), `${APP_NAME}-debug.log`);
}

export function getProjectDir(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME);
}

export function getProjectSettingsPath(cwd: string): string {
  return join(getProjectDir(cwd), "settings.json");
}
