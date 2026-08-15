import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "../config/paths.js";
import { filesystemPathIdentity } from "./paths.js";

function futurePathIdentity(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      const ancestor = filesystemPathIdentity(realpathSync(current));
      const identity = join(ancestor, ...suffix.reverse());
      return process.platform === "win32" ? identity.toLowerCase() : identity;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return filesystemPathIdentity(path);
      const parent = dirname(current);
      if (parent === current) return filesystemPathIdentity(path);
      suffix.push(basename(current));
      current = parent;
    }
  }
}

/** True when project scope would address the same directory as user scope. */
export function projectConfigRootMatchesAgentDir(
  cwd: string,
  agentDirectory = getAgentDir(),
): boolean {
  return futurePathIdentity(join(resolve(cwd), CONFIG_DIR_NAME)) === futurePathIdentity(agentDirectory);
}
