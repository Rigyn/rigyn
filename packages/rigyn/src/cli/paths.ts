import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  getAgentDir,
  getAuthPath,
  getCrashDir,
  getDiagnosticsDir,
  getExtensionsDir,
  getLogsDir,
  getModelsPath,
  getPromptsDir,
  getSessionsDir,
  getSettingsPath,
  getSkillsDir,
  getCustomThemesDir,
} from "../config/paths.js";

export interface AgentPaths {
  agentDirectory: string;
  settings: string;
  trustStore: string;
  auth: string;
  sessions: string;
  modelCatalog: string;
  userSkills: string;
  userExtensions: string;
  userPrompts: string;
  userThemes: string;
  logs: string;
  diagnostics: string;
  crash: string;
}

export function agentPaths(
  environment: NodeJS.ProcessEnv = process.env,
  directory?: string,
): AgentPaths {
  const agentDirectory = directory === undefined ? getAgentDir(environment) : resolve(directory);
  return {
    agentDirectory,
    settings: directory === undefined ? getSettingsPath(environment) : join(agentDirectory, "config.json"),
    trustStore: join(agentDirectory, "trusted-workspaces.json"),
    auth: directory === undefined ? getAuthPath(environment) : join(agentDirectory, "auth.json"),
    sessions: directory === undefined ? getSessionsDir(environment) : join(agentDirectory, "sessions"),
    modelCatalog: directory === undefined ? getModelsPath(environment) : join(agentDirectory, "models.json"),
    userSkills: directory === undefined ? getSkillsDir(environment) : join(agentDirectory, "skills"),
    userExtensions: directory === undefined ? getExtensionsDir(environment) : join(agentDirectory, "extensions"),
    userPrompts: directory === undefined ? getPromptsDir(environment) : join(agentDirectory, "prompts"),
    userThemes: directory === undefined ? getCustomThemesDir(environment) : join(agentDirectory, "themes"),
    logs: directory === undefined ? getLogsDir(environment) : join(agentDirectory, "logs"),
    diagnostics: directory === undefined ? getDiagnosticsDir(environment) : join(agentDirectory, "diagnostics"),
    crash: directory === undefined ? getCrashDir(environment) : join(agentDirectory, "crash"),
  };
}

export function expandPath(path: string, cwd = process.cwd()): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}
