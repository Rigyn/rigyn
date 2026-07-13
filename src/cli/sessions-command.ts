import { join, resolve } from "node:path";

import { canonicalExistingPath } from "../config/canonical-path.js";
import { parseHarnessConfig, resolveConfig, TrustStore } from "../config/index.js";
import { writeMachineOutput } from "../interfaces/output-guard.js";
import {
  inspectSessionDatabase,
  repairSessionDatabaseIndexes,
  type SessionDatabaseRepairResult,
  type SessionDatabaseReport,
} from "../storage/maintenance.js";
import { flagBoolean, flagString, type ParsedArguments } from "./args.js";
import { expandPath, harnessPaths } from "./paths.js";

function safeLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
}

function formatDoctorReport(report: SessionDatabaseReport): string {
  const schema = report.sessionSchemaVersion === report.expectedSessionSchemaVersion
    ? `current (${report.sessionSchemaVersion})`
    : `${report.sessionSchemaVersion ?? "unreadable"}; expected ${report.expectedSessionSchemaVersion}`;
  const integrity = report.integrity.healthy
    ? "healthy"
    : `failed (${report.integrity.messages.length}${report.integrity.truncated ? "+" : ""} reported issue${report.integrity.messages.length === 1 && !report.integrity.truncated ? "" : "s"})`;
  const foreignKeys = report.foreignKeys.healthy
    ? "healthy"
    : report.foreignKeys.error === undefined
      ? `failed (${report.foreignKeys.violations.length}${report.foreignKeys.truncated ? "+" : ""} violation${report.foreignKeys.violations.length === 1 && !report.foreignKeys.truncated ? "" : "s"})`
      : `failed (${safeLine(report.foreignKeys.error)})`;
  const issues = report.integrity.healthy
    ? ""
    : `\n${report.integrity.messages.map((message) => `  - ${safeLine(message)}`).join("\n")}`;
  const foreignKeyIssues = report.foreignKeys.violations.length === 0
    ? ""
    : `\n${report.foreignKeys.violations.map((violation) =>
        `  - ${safeLine(violation.table)} row ${violation.rowId ?? "unknown"} -> ${safeLine(violation.parent)} (constraint ${violation.foreignKey})`
      ).join("\n")}${report.foreignKeys.truncated ? "\n  - additional violations were omitted" : ""}`;
  return [
    `Session database: ${safeLine(report.databasePath)}`,
    `SQLite: ${report.sqliteVersion}`,
    `Schema: ${schema}`,
    `Integrity: ${integrity}${issues}`,
    `Foreign keys: ${foreignKeys}${foreignKeyIssues}`,
    `Overall: ${report.healthy ? "healthy" : "needs repair or restore"}`,
    "",
  ].join("\n");
}

function formatRepairReport(result: SessionDatabaseRepairResult): string {
  return [
    "Session database indexes repaired successfully.",
    `Database: ${safeLine(result.databasePath)}`,
    `Pre-repair backup: ${safeLine(result.backupPath)}`,
    "Integrity: healthy",
    "Foreign keys: healthy",
    "",
  ].join("\n");
}

export async function resolveSessionMaintenanceDatabase(argumentsValue: ParsedArguments): Promise<string> {
  const paths = harnessPaths();
  const workspace = await canonicalExistingPath(resolve(flagString(argumentsValue, "workspace") ?? process.cwd()));
  const sessionDirectory = flagString(argumentsValue, "session-dir");
  if (sessionDirectory !== undefined) return join(expandPath(sessionDirectory, workspace), "sessions.sqlite");
  const trusted = await new TrustStore(paths.trustStore).isTrusted(workspace);
  const resolved = resolveConfig({
    globalPath: paths.globalConfig,
    projectPath: join(workspace, ".rigyn", "config.jsonc"),
    projectTrusted: trusted,
  });
  const config = parseHarnessConfig(resolved.value);
  return expandPath(config.databasePath ?? paths.database, workspace);
}

export async function runSessionsCommand(argumentsValue: ParsedArguments): Promise<void> {
  const action = argumentsValue.positionals[0] ?? "doctor";
  if (argumentsValue.positionals.length > 1) {
    throw new Error("Sessions maintenance accepts one action: doctor or repair");
  }
  if (action !== "doctor" && action !== "repair") {
    throw new Error(`Unknown sessions action: ${action}`);
  }
  const reindex = flagBoolean(argumentsValue, "reindex");
  const confirmed = flagBoolean(argumentsValue, "yes");
  if (action === "doctor" && (reindex || confirmed)) {
    throw new Error("sessions doctor does not accept --reindex or --yes");
  }
  if (action === "repair" && !reindex) {
    throw new Error("Index repair is explicit; pass --reindex after reviewing `rigyn sessions doctor`");
  }
  if (action === "repair" && !confirmed) {
    throw new Error("Close every Rigyn process, then pass --yes to create a backup and repair indexes");
  }

  const path = await resolveSessionMaintenanceDatabase(argumentsValue);
  const json = flagBoolean(argumentsValue, "json");
  if (action === "doctor") {
    const report = inspectSessionDatabase(path);
    writeMachineOutput(json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report));
    if (!report.healthy) process.exitCode = 1;
    return;
  }
  const result = await repairSessionDatabaseIndexes(path);
  writeMachineOutput(json ? `${JSON.stringify(result, null, 2)}\n` : formatRepairReport(result));
}
