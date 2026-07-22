import { resolve } from "node:path";

import { writeMachineOutput } from "../interfaces/output-guard.js";
import { SessionManager } from "../storage/session-manager.js";
import { flagBoolean, flagString, type ManagementArguments as ParsedArguments } from "./management-args.js";
import { expandPath } from "./paths.js";

export interface SessionDoctorReport {
  sessionDirectory?: string;
  workspace: string;
  checked: number;
  valid: number;
  invalid: Array<{ path: string; error: string }>;
  healthy: boolean;
}

export async function inspectSessionFiles(input: {
  workspace: string;
  sessionDirectory?: string;
  allWorkspaces?: boolean;
}): Promise<SessionDoctorReport> {
  const scan = await SessionManager.inspect(
    input.workspace,
    input.sessionDirectory,
    input.allWorkspaces === true,
  );
  return {
    ...(input.sessionDirectory === undefined ? {} : { sessionDirectory: input.sessionDirectory }),
    workspace: input.workspace,
    checked: scan.sessions.length + scan.invalid.length,
    valid: scan.sessions.length,
    invalid: scan.invalid,
    healthy: scan.invalid.length === 0,
  };
}

export async function runSessionsCommand(argumentsValue: ParsedArguments): Promise<void> {
  const action = argumentsValue.positionals[0] ?? "doctor";
  if (action !== "doctor") {
    throw new Error("JSONL sessions do not use database indexes; only `rigyn sessions doctor` is supported");
  }
  const workspace = resolve(flagString(argumentsValue, "workspace") ?? process.cwd());
  const requestedDirectory = flagString(argumentsValue, "session-dir");
  const sessionDirectory = requestedDirectory === undefined ? undefined : expandPath(requestedDirectory, workspace);
  const report = await inspectSessionFiles({
    workspace,
    ...(sessionDirectory === undefined ? {} : { sessionDirectory }),
    allWorkspaces: flagBoolean(argumentsValue, "all"),
  });
  if (flagBoolean(argumentsValue, "json")) writeMachineOutput(`${JSON.stringify(report, null, 2)}\n`);
  else {
    writeMachineOutput([
      `Session files: ${report.checked}`,
      `Valid: ${report.valid}`,
      `Invalid: ${report.invalid.length}`,
      ...report.invalid.map((entry) => `- ${entry.path}: ${entry.error}`),
      `Overall: ${report.healthy ? "healthy" : "needs attention"}`,
      "",
    ].join("\n"));
  }
  if (!report.healthy) process.exitCode = 1;
}
