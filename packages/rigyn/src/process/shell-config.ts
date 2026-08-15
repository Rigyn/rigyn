import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export interface ShellConfig { shell: string; args: string[] }

function executable(path: string): string | undefined {
  try {
    accessSync(path, constants.X_OK);
    const resolved = realpathSync(path);
    return statSync(resolved).isFile() ? resolved : undefined;
  } catch { return undefined; }
}

export function getShellConfig(configuredPath?: string): ShellConfig {
  if (configuredPath !== undefined) {
    if (!isAbsolute(configuredPath)) throw new Error("Configured shell path must be absolute");
    const shell = executable(configuredPath);
    if (shell === undefined) throw new Error(`Configured shell does not exist or is not executable: ${configuredPath}`);
    return { shell, args: ["-c"] };
  }
  if (process.platform === "win32") {
    const candidates = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((path) => join(path.replace(/^"|"$/gu, ""), "bash.exe"));
    const shell = candidates.map(executable).find((value): value is string => value !== undefined);
    if (shell === undefined) throw new Error("rigyn needs Bash to run shell tools on Windows. Install Git for Windows or set shellPath in config.json.");
    return { shell, args: ["-c"] };
  }
  for (const candidate of [process.env.SHELL, "/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"]) {
    if (candidate === undefined) continue;
    const shell = executable(candidate);
    if (shell !== undefined) return { shell, args: ["-c"] };
  }
  throw new Error("No Bash-compatible shell was found");
}
