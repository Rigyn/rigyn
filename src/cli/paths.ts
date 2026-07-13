import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface HarnessPaths {
  configDirectory: string;
  stateDirectory: string;
  globalConfig: string;
  trustStore: string;
  credentialStore: string;
  credentialKey: string;
  database: string;
  modelCatalog: string;
  userSkills: string;
  userExtensions: string;
  userPrompts: string;
  userThemes: string;
}

export function harnessPaths(environment: NodeJS.ProcessEnv = process.env): HarnessPaths {
  const configDirectory = join(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "rigyn");
  const stateDirectory = join(environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "rigyn");
  return {
    configDirectory,
    stateDirectory,
    globalConfig: join(configDirectory, "config.jsonc"),
    trustStore: join(configDirectory, "trusted-workspaces.json"),
    credentialStore: join(configDirectory, "credentials.enc"),
    credentialKey: join(configDirectory, "credentials.key"),
    database: join(stateDirectory, "sessions.sqlite"),
    modelCatalog: join(stateDirectory, "models.json"),
    userSkills: join(configDirectory, "skills"),
    userExtensions: join(configDirectory, "extensions"),
    userPrompts: join(configDirectory, "prompts"),
    userThemes: join(configDirectory, "themes"),
  };
}

export function expandPath(path: string, cwd = process.cwd()): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}
