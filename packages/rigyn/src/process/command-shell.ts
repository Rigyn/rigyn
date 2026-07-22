import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

export interface CommandShellOptions {
  configuredPath?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  inspect?: (candidate: string) => Promise<string | undefined>;
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLocaleLowerCase("en-US");
  return Object.entries(environment).find(([key]) => key.toLocaleLowerCase("en-US") === wanted)?.[1];
}

function unique(candidates: string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = platform === "win32" ? candidate.toLocaleLowerCase("en-US") : candidate;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function commandShellCandidates(options: Omit<CommandShellOptions, "inspect"> = {}): string[] {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const path = platform === "win32" ? win32 : posix;
  if (options.configuredPath !== undefined) {
    if (
      options.configuredPath.includes("\0") ||
      Buffer.byteLength(options.configuredPath, "utf8") > 4096 ||
      !path.isAbsolute(options.configuredPath)
    ) {
      throw new Error("shellPath must be an absolute path no larger than 4096 bytes");
    }
    return [options.configuredPath];
  }
  if (platform !== "win32") return ["/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"];

  const candidates: string[] = [];
  for (const rawDirectory of (environmentValue(environment, "PATH") ?? "").split(win32.delimiter)) {
    const directory = rawDirectory.startsWith('"') && rawDirectory.endsWith('"')
      ? rawDirectory.slice(1, -1)
      : rawDirectory;
    if (win32.isAbsolute(directory)) candidates.push(win32.join(directory, "bash.exe"));
  }
  for (const name of ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]) {
    const root = environmentValue(environment, name);
    if (root === undefined || !win32.isAbsolute(root)) continue;
    candidates.push(win32.join(root, "Git", "bin", "bash.exe"));
    candidates.push(win32.join(root, "Git", "usr", "bin", "bash.exe"));
  }
  const local = environmentValue(environment, "LOCALAPPDATA");
  if (local !== undefined && win32.isAbsolute(local)) {
    candidates.push(win32.join(local, "Programs", "Git", "bin", "bash.exe"));
  }
  const drive = environmentValue(environment, "SystemDrive");
  if (drive !== undefined && /^[A-Za-z]:$/u.test(drive)) {
    candidates.push(win32.join(`${drive}\\`, "msys64", "usr", "bin", "bash.exe"));
  }
  return unique(candidates, platform);
}

async function inspectExecutable(candidate: string): Promise<string | undefined> {
  try {
    await access(candidate, constants.X_OK);
    const resolved = await realpath(candidate);
    return (await stat(resolved)).isFile() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveCommandShell(options: CommandShellOptions = {}): Promise<string> {
  const candidates = commandShellCandidates(options);
  const inspect = options.inspect ?? inspectExecutable;
  for (const candidate of candidates) {
    const resolved = await inspect(candidate);
    if (resolved !== undefined) return resolved;
  }
  if (options.configuredPath !== undefined) {
    throw new Error(`Configured shellPath is not an executable file: ${options.configuredPath}`);
  }
  if ((options.platform ?? process.platform) === "win32") {
    throw new Error("Bash was not found; install Git for Windows, add bash.exe to PATH, or configure shellPath");
  }
  throw new Error("No Bash-compatible command shell was found");
}

export async function commandShellArgv(command: string, options: CommandShellOptions = {}): Promise<[string, "-c", string]> {
  return [await resolveCommandShell(options), "-c", command];
}
