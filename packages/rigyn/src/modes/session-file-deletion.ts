import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

import type { ProcessRunner } from "../process/types.js";
import { acquireSessionWriterLeaseSync } from "../storage/session-writer-lease.js";

const DELETE_TIMEOUT_MS = 10_000;
const DELETE_OUTPUT_LIMIT_BYTES = 8 * 1024;

export interface SessionFileDeleteOptions {
  cwd: string;
  processRunner: ProcessRunner;
  platform?: NodeJS.Platform;
}

export type SessionFileDeleteMethod = "trash" | "permanent";

interface RecoverableDeleteCommand {
  argv: [string, ...string[]];
  stdin?: string;
}

export function recoverableDeleteCommand(
  path: string,
  platform: NodeJS.Platform,
): RecoverableDeleteCommand | undefined {
  if (platform === "linux") {
    return { argv: ["gio", "trash", path] };
  }
  if (platform === "darwin") {
    return {
      argv: [
        "/usr/bin/osascript",
        "-e",
        "on run argv",
        "-e",
        "tell application \"Finder\" to delete POSIX file (item 1 of argv)",
        "-e",
        "end run",
        "--",
        path,
      ],
    };
  }
  if (platform === "win32") {
    return {
      argv: [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        "-",
        path,
      ],
      stdin: "$ErrorActionPreference = 'Stop'\n"
        + "try {\n"
        + "  $sessionPath = $args[0]\n"
        + "  Add-Type -AssemblyName Microsoft.VisualBasic\n"
        + "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($sessionPath, "
        + "[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, "
        + "[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)\n"
        + "  if (Test-Path -LiteralPath $sessionPath) { exit 1 }\n"
        + "  exit 0\n"
        + "} catch { exit 1 }\n",
    };
  }
  return undefined;
}

export async function deleteSessionFile(
  path: string,
  options: SessionFileDeleteOptions,
): Promise<SessionFileDeleteMethod> {
  const writerLease = acquireSessionWriterLeaseSync(path);
  try {
    const command = recoverableDeleteCommand(path, options.platform ?? process.platform);
    if (command !== undefined) {
      try {
        const result = await options.processRunner.run({
          argv: command.argv,
          cwd: options.cwd,
          ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
          timeoutMs: DELETE_TIMEOUT_MS,
          outputLimitBytes: DELETE_OUTPUT_LIMIT_BYTES,
        }, AbortSignal.timeout(DELETE_TIMEOUT_MS));
        if (result.exitCode === 0 || !existsSync(path)) return "trash";
      } catch {
        // A missing or failed recycle helper falls through to permanent deletion.
      }
    }
    await rm(path);
    return "permanent";
  } finally {
    writerLease.release();
  }
}
