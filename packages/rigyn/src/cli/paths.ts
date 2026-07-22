import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  getAgentDir,
  getAuthPath,
  getExtensionsDir,
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
  keybindings: string;
  trustStore: string;
  auth: string;
  sessions: string;
  modelCatalog: string;
  userSkills: string;
  userExtensions: string;
  userPrompts: string;
  userThemes: string;
}

export function agentPaths(environment: NodeJS.ProcessEnv = process.env): AgentPaths {
  const agentDirectory = getAgentDir(environment);
  return {
    agentDirectory,
    settings: getSettingsPath(environment),
    keybindings: join(agentDirectory, "keybindings.json"),
    trustStore: join(agentDirectory, "trusted-workspaces.json"),
    auth: getAuthPath(environment),
    sessions: getSessionsDir(environment),
    modelCatalog: getModelsPath(environment),
    userSkills: getSkillsDir(environment),
    userExtensions: getExtensionsDir(environment),
    userPrompts: getPromptsDir(environment),
    userThemes: getCustomThemesDir(environment),
  };
}

export function expandPath(path: string, cwd = process.cwd()): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}
