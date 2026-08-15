import { join, resolve } from "node:path";

import { ENV_SESSION_DIR } from "../config/paths.js";
import { listLocalObservabilityFiles } from "../core/local-observability.js";
import { resolveObservabilityLevel } from "../core/observability.js";
import { SettingsManager } from "../core/settings-manager.js";
import { writeMachineOutput } from "../interfaces/output-guard.js";
import { resolvePath } from "../utils/paths.js";
import { agentPaths } from "./paths.js";
import { flagBoolean, type ManagementArguments } from "./management-args.js";

export interface LocalLogsReport {
  schemaVersion: 1;
  kind: "rigyn-local-logs";
  level: "off" | "error" | "info" | "debug";
  configuration: {
    status: "valid" | "invalid";
    warning?: string;
  };
  directory: string;
  redrawDebugPath: string;
  diagnosticsDirectory: string;
  crashDirectory: string;
  sessionDirectory: string;
  files: Array<{ path: string; sizeBytes: number; modifiedAt: string }>;
  totalBytes: number;
  partial: boolean;
}

export async function createLocalLogsReport(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LocalLogsReport> {
  const paths = agentPaths(environment);
  const settings = SettingsManager.create(resolve(process.cwd()), paths.agentDirectory, { projectTrusted: false });
  let configuration: LocalLogsReport["configuration"] = { status: "valid" };
  try {
    await settings.refresh();
  } catch {
    configuration = {
      status: "invalid",
      warning: "Global config could not be loaded; the log level uses RIGYN_LOG_LEVEL or the built-in default. Run `rigyn config validate --json` for details.",
    };
  }
  const listed = await listLocalObservabilityFiles(paths.logs);
  const cwd = resolve(process.cwd());
  const environmentSessionDirectory = environment[ENV_SESSION_DIR];
  const configuredSessionDirectory = configuration.status === "valid" ? settings.getSessionDir() : undefined;
  const sessionDirectory = environmentSessionDirectory !== undefined && environmentSessionDirectory !== ""
    ? resolvePath(environmentSessionDirectory, cwd)
    : configuredSessionDirectory === undefined
      ? resolve(paths.sessions)
      : resolvePath(configuredSessionDirectory, cwd);
  return {
    schemaVersion: 1,
    kind: "rigyn-local-logs",
    level: resolveObservabilityLevel(
      configuration.status === "valid" ? settings.getObservabilityLevel() : undefined,
      environment,
    ),
    configuration,
    directory: listed.directory,
    redrawDebugPath: join(paths.logs, "rigyn-debug.log"),
    diagnosticsDirectory: paths.diagnostics,
    crashDirectory: paths.crash,
    sessionDirectory,
    files: listed.files.map((file) => ({
      path: join(listed.directory, file.name),
      sizeBytes: file.sizeBytes,
      modifiedAt: file.modifiedAt,
    })),
    totalBytes: listed.totalBytes,
    partial: listed.partial,
  };
}

export async function runLogsCommand(argumentsValue: ManagementArguments): Promise<void> {
  if (argumentsValue.positionals.length > 0) throw new Error("logs accepts no positional arguments");
  const report = await createLocalLogsReport();
  if (flagBoolean(argumentsValue, "json")) {
    writeMachineOutput(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const newest = report.files.at(-1);
  writeMachineOutput([
    `Local observability: ${report.level}`,
    `Configuration: ${report.configuration.status}`,
    ...(report.configuration.warning === undefined ? [] : [`Warning: ${report.configuration.warning}`]),
    `Directory: ${report.directory}`,
    `Redraw debug: ${report.redrawDebugPath}`,
    `Diagnostics: ${report.diagnosticsDirectory}`,
    `Crash reports: ${report.crashDirectory}`,
    `Sessions: ${report.sessionDirectory}`,
    `Files: ${report.files.length}`,
    `Bytes: ${report.totalBytes}`,
    `Listing: ${report.partial ? "partial" : "complete"}`,
    ...(newest === undefined ? [] : [`Latest: ${newest.path}`]),
    "",
  ].join("\n"));
}
