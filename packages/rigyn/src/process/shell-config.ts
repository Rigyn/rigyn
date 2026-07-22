import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface ShellConfig {
  shell: string;
  args: string[];
  commandTransport?: "argv" | "stdin";
}

function legacyWindowsBash(path: string): boolean {
  const normalized = path.replaceAll("/", "\\").toLowerCase();
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/u.test(normalized);
}

function bashConfig(shell: string): ShellConfig {
  return legacyWindowsBash(shell)
    ? { shell, args: ["-s"], commandTransport: "stdin" }
    : { shell, args: ["-c"] };
}

function findBashOnPath(): string | undefined {
  const command = process.platform === "win32" ? "where" : "which";
  const executable = process.platform === "win32" ? "bash.exe" : "bash";
  try {
    const result = spawnSync(command, [executable], {
      encoding: "utf8",
      timeout: 5_000,
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    });
    const first = result.status === 0 ? result.stdout.trim().split(/\r?\n/u)[0] : undefined;
    if (first !== undefined && first !== "" && (process.platform !== "win32" || existsSync(first))) return first;
  } catch {}
  return undefined;
}

/** Resolve a non-interactive command shell. */
export function getShellConfig(customShellPath?: string): ShellConfig {
  if (customShellPath) {
    if (!existsSync(customShellPath)) throw new Error(`Custom shell path not found: ${customShellPath}`);
    return bashConfig(customShellPath);
  }
  if (process.platform === "win32") {
    const paths = [
      process.env.ProgramFiles === undefined ? undefined : `${process.env.ProgramFiles}\\Git\\bin\\bash.exe`,
      process.env["ProgramFiles(x86)"] === undefined
        ? undefined
        : `${process.env["ProgramFiles(x86)"]}\\Git\\bin\\bash.exe`,
    ].filter((path): path is string => path !== undefined);
    for (const path of paths) if (existsSync(path)) return bashConfig(path);
    const discovered = findBashOnPath();
    if (discovered !== undefined) return bashConfig(discovered);
    throw new Error(
      `No bash shell found. Options:\n`
      + `  1. Install Git for Windows: https://git-scm.com/download/win\n`
      + `  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n`
      + `  3. Set shellPath in settings.json\n\n`
      + `Searched Git Bash in:\n${paths.map((path) => `  ${path}`).join("\n")}`,
    );
  }
  if (existsSync("/bin/bash")) return bashConfig("/bin/bash");
  const discovered = findBashOnPath();
  return discovered === undefined ? { shell: "sh", args: ["-c"] } : bashConfig(discovered);
}
