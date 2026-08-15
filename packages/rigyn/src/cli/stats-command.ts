import {
  listLocalObservabilityFiles,
  scanLocalObservabilityFile,
} from "../core/local-observability.js";
import type { ObservabilityRecord } from "../core/observability.js";
import { writeMachineOutput } from "../interfaces/output-guard.js";
import { flagBoolean, type ManagementArguments } from "./management-args.js";
import { agentPaths } from "./paths.js";

const MAX_FILES = 128;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_RECORDS = 250_000;
const MAX_PROCESSES = 4_096;
const MAX_COMPONENT = Math.floor(Number.MAX_SAFE_INTEGER / MAX_PROCESSES);

interface ProjectedSnapshot {
  processInstance: string;
  timestamp: number;
  fileName: string;
  order: number;
  runs: number;
  requests: number;
  retries: number;
  compactions: number;
  compactionFailures: number;
  toolFailures: number;
  usageScopes: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  providerDurationMs: number;
  inputTokensObserved: boolean;
  inputTokensComplete: boolean;
  outputTokensObserved: boolean;
  outputTokensComplete: boolean;
  totalTokensObserved: boolean;
  totalTokensComplete: boolean;
  cacheTelemetryObserved: boolean;
  cacheReadTokensObserved: boolean;
  cacheWriteTokensObserved: boolean;
  cacheReadTokensComplete: boolean;
  cacheWriteTokensComplete: boolean;
  costObserved: boolean;
  costComplete: boolean;
  providerDurationObserved: boolean;
}

export interface LocalStatsReport {
  schemaVersion: 1;
  kind: "rigyn-local-stats";
  source: {
    filesFound: number;
    filesRead: number;
    filesSkipped: number;
    processes: number;
    recordsSkipped: number;
    partial: boolean;
  };
  runs: number;
  requests: number;
  retries: number;
  compactions: number;
  compactionFailures: number;
  toolFailures: number;
  tokens?: {
    input?: number;
    inputReported?: number;
    output?: number;
    outputReported?: number;
    total?: number;
    totalReported?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cacheReadReported?: number;
    cacheWriteReported?: number;
    cacheHitPercent?: number;
  };
  costUsd?: number;
  costUsdReported?: number;
  providerDurationMs?: number;
}

function component(fields: ObservabilityRecord["fields"], name: string): number | undefined {
  const value = fields[name];
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_COMPONENT
    ? value
    : undefined;
}

function count(fields: ObservabilityRecord["fields"], name: string): number | undefined {
  const value = component(fields, name);
  return value !== undefined && Number.isSafeInteger(value) ? value : undefined;
}

function availability(
  fields: ObservabilityRecord["fields"],
  name: string,
  legacyValues: readonly number[],
): boolean | undefined {
  const value = fields[name];
  if (value !== undefined && typeof value !== "boolean") return undefined;
  if (typeof value === "boolean") return value;
  return legacyValues.some((candidate) => candidate > 0);
}

function booleanField(fields: ObservabilityRecord["fields"], name: string): boolean | undefined {
  const value = fields[name];
  return typeof value === "boolean" ? value : undefined;
}

function usageCounter(
  fields: ObservabilityRecord["fields"],
  name: string,
  integer: boolean,
  availabilityName = name,
): { value: number; observed: boolean; complete: boolean } | undefined {
  const parse = integer ? count : component;
  const exactName = name;
  const reportedName = `${name}_reported`;
  const observedName = `${availabilityName}_observed`;
  const completeName = `${availabilityName}_complete`;
  const exact = parse(fields, exactName);
  const reported = parse(fields, reportedName);
  const explicitObserved = booleanField(fields, observedName);
  const explicitComplete = booleanField(fields, completeName);
  for (const field of [exactName, reportedName]) {
    if (fields[field] !== undefined && parse(fields, field) === undefined) return undefined;
  }
  for (const field of [observedName, completeName]) {
    if (fields[field] !== undefined && typeof fields[field] !== "boolean") return undefined;
  }
  if (exact !== undefined && reported !== undefined) return undefined;
  if (explicitComplete === true) {
    if (exact === undefined || explicitObserved === false) return undefined;
    return { value: exact, observed: true, complete: true };
  }
  if (explicitComplete === false) {
    if (exact !== undefined) return undefined;
    const observed = explicitObserved ?? reported !== undefined;
    if (observed !== (reported !== undefined)) return undefined;
    return { value: reported ?? 0, observed, complete: false };
  }
  if (fields[completeName] !== undefined || reported !== undefined) return undefined;

  // Snapshots from before per-request completeness cannot prove an exact total.
  const legacy = exact ?? 0;
  const observed = explicitObserved ?? legacy > 0;
  return { value: legacy, observed, complete: false };
}

function cacheCounter(
  fields: ObservabilityRecord["fields"],
  name: "read" | "write",
): { tokens: number; observed: boolean; complete: boolean } | undefined {
  const exactName = `cache_${name}_tokens`;
  const reportedName = `${exactName}_reported`;
  const observedName = `${exactName}_observed`;
  const completeName = `${exactName}_complete`;
  const exact = count(fields, exactName);
  const reported = count(fields, reportedName);
  const explicitObserved = booleanField(fields, observedName);
  const explicitComplete = booleanField(fields, completeName);
  for (const field of [exactName, reportedName]) {
    if (fields[field] !== undefined && count(fields, field) === undefined) return undefined;
  }
  for (const field of [observedName, completeName]) {
    if (fields[field] !== undefined && typeof fields[field] !== "boolean") return undefined;
  }
  if (explicitComplete === true) {
    if (exact === undefined || reported !== undefined || explicitObserved === false) return undefined;
    return { tokens: exact, observed: true, complete: true };
  }
  if (explicitComplete === false) {
    if (exact !== undefined) return undefined;
    const observed = explicitObserved ?? reported !== undefined;
    if (observed !== (reported !== undefined)) return undefined;
    return { tokens: reported ?? 0, observed, complete: false };
  }
  if (fields[completeName] !== undefined) return undefined;

  // Legacy snapshots had one combined availability flag and always emitted both
  // numeric counters. Positive values remain useful as reported partials, but
  // cannot be promoted to per-counter exact totals.
  if (reported !== undefined) return undefined;
  const legacy = exact ?? 0;
  const observed = explicitObserved ?? legacy > 0;
  return { tokens: legacy, observed, complete: false };
}

function projectSnapshot(
  record: ObservabilityRecord,
  fileName: string,
  order: number,
): ProjectedSnapshot | undefined {
  if (
    record.kind !== "metrics_snapshot"
    || record.name !== "metrics_snapshot"
    || record.area !== "runtime"
    || !/^[a-f0-9]{16}$/u.test(record.processInstance)
  ) return undefined;
  const timestamp = Date.parse(record.timestamp);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== record.timestamp) return undefined;
  const fields = record.fields;
  const runs = count(fields, "runs_started");
  const requests = count(fields, "provider_attempts");
  const retries = count(fields, "provider_retries");
  const compactions = count(fields, "compactions_started");
  const compactionFailures = count(fields, "compactions_failed");
  const toolFailures = count(fields, "tools_failed");
  const explicitUsageScopes = count(fields, "usage_scopes");
  if (fields.usage_scopes !== undefined && explicitUsageScopes === undefined) return undefined;
  const input = usageCounter(fields, "input_tokens", true);
  const output = usageCounter(fields, "output_tokens", true);
  const total = usageCounter(fields, "total_tokens", true);
  const cacheRead = cacheCounter(fields, "read");
  const cacheWrite = cacheCounter(fields, "write");
  const observedCost = usageCounter(fields, "cost_total", false, "cost");
  const providerDurationMs = component(fields, "provider_duration_ms");
  if (
    runs === undefined
    || requests === undefined
    || retries === undefined
    || compactions === undefined
    || compactionFailures === undefined
    || toolFailures === undefined
    || input === undefined
    || output === undefined
    || total === undefined
    || cacheRead === undefined
    || cacheWrite === undefined
    || observedCost === undefined
    || providerDurationMs === undefined
  ) return undefined;
  const cacheTelemetryObserved = availability(
    fields,
    "cache_telemetry_observed",
    [cacheRead.tokens, cacheWrite.tokens],
  );
  const providerDurationObserved = availability(
    fields,
    "provider_duration_observed",
    [providerDurationMs],
  );
  if (
    cacheTelemetryObserved === undefined
    || providerDurationObserved === undefined
  ) return undefined;
  return {
    processInstance: record.processInstance,
    timestamp,
    fileName,
    order,
    runs,
    requests,
    retries,
    compactions,
    compactionFailures,
    toolFailures,
    usageScopes: explicitUsageScopes ?? requests,
    inputTokens: input.value,
    outputTokens: output.value,
    totalTokens: total.value,
    cacheReadTokens: cacheRead.tokens,
    cacheWriteTokens: cacheWrite.tokens,
    costUsd: observedCost.value,
    providerDurationMs,
    inputTokensObserved: input.observed,
    inputTokensComplete: input.complete,
    outputTokensObserved: output.observed,
    outputTokensComplete: output.complete,
    totalTokensObserved: total.observed,
    totalTokensComplete: total.complete,
    cacheTelemetryObserved,
    cacheReadTokensObserved: cacheRead.observed,
    cacheWriteTokensObserved: cacheWrite.observed,
    cacheReadTokensComplete: cacheRead.complete,
    cacheWriteTokensComplete: cacheWrite.complete,
    costObserved: observedCost.observed,
    costComplete: observedCost.complete,
    providerDurationObserved,
  };
}

function sum(snapshots: readonly ProjectedSnapshot[], select: (snapshot: ProjectedSnapshot) => number): number {
  return snapshots.reduce((total, snapshot) => total + select(snapshot), 0);
}

function allObserved(
  snapshots: readonly ProjectedSnapshot[],
  select: (snapshot: ProjectedSnapshot) => boolean,
): boolean {
  return snapshots.length > 0 && snapshots.every(select);
}

export async function createLocalStatsReport(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LocalStatsReport> {
  const listed = await listLocalObservabilityFiles(agentPaths(environment).logs);
  const selected = [] as typeof listed.files;
  let selectedBytes = 0;
  for (const file of [...listed.files].reverse()) {
    if (
      selected.length >= MAX_FILES
      || file.sizeBytes > MAX_FILE_BYTES
      || selectedBytes + file.sizeBytes > MAX_BYTES
    ) continue;
    selected.push(file);
    selectedBytes += file.sizeBytes;
  }

  const latest = new Map<string, ProjectedSnapshot>();
  let filesRead = 0;
  let recordsRead = 0;
  let recordsSkipped = 0;
  let order = 0;
  let partial = listed.partial || selected.length < listed.files.length;
  for (const file of selected) {
    if (recordsRead >= MAX_RECORDS) {
      partial = true;
      break;
    }
    let invalidSnapshots = 0;
    const scan = await scanLocalObservabilityFile(listed.directory, file, {
      maximumBytes: Math.max(1, Math.min(file.sizeBytes, MAX_FILE_BYTES)),
      maximumLineBytes: MAX_LINE_BYTES,
      maximumRecords: MAX_RECORDS - recordsRead,
      onSnapshot(record) {
        const projected = projectSnapshot(record, file.name, ++order);
        if (projected === undefined) {
          invalidSnapshots += 1;
          return;
        }
        const existing = latest.get(projected.processInstance);
        if (existing === undefined && latest.size >= MAX_PROCESSES) {
          invalidSnapshots += 1;
          partial = true;
          return;
        }
        if (
          existing === undefined
          || projected.timestamp > existing.timestamp
          || projected.timestamp === existing.timestamp && (
            projected.fileName > existing.fileName
            || projected.fileName === existing.fileName && projected.order > existing.order
          )
        ) latest.set(projected.processInstance, projected);
      },
    });
    if (scan === undefined) {
      partial = true;
      continue;
    }
    filesRead += 1;
    recordsRead += scan.recordsRead;
    recordsSkipped += scan.recordsSkipped + invalidSnapshots;
    partial ||= scan.partial || scan.recordsSkipped > 0 || invalidSnapshots > 0;
  }

  const snapshots = [...latest.values()];
  const usageSnapshots = snapshots.filter((snapshot) =>
    snapshot.usageScopes > 0
    || snapshot.inputTokensObserved
    || snapshot.outputTokensObserved
    || snapshot.totalTokensObserved
    || snapshot.cacheTelemetryObserved
    || snapshot.costObserved
    || snapshot.providerDurationObserved);
  const inputAvailable = allObserved(usageSnapshots, (snapshot) => snapshot.inputTokensComplete);
  const outputAvailable = allObserved(usageSnapshots, (snapshot) => snapshot.outputTokensComplete);
  const totalAvailable = allObserved(usageSnapshots, (snapshot) => snapshot.totalTokensComplete);
  const cacheReadAvailable = allObserved(usageSnapshots, (snapshot) => snapshot.cacheReadTokensComplete);
  const cacheWriteAvailable = allObserved(usageSnapshots, (snapshot) => snapshot.cacheWriteTokensComplete);
  const cacheReadObserved = usageSnapshots.some((snapshot) => snapshot.cacheReadTokensObserved);
  const cacheWriteObserved = usageSnapshots.some((snapshot) => snapshot.cacheWriteTokensObserved);
  const inputObserved = usageSnapshots.some((snapshot) => snapshot.inputTokensObserved);
  const outputObserved = usageSnapshots.some((snapshot) => snapshot.outputTokensObserved);
  const totalObserved = usageSnapshots.some((snapshot) => snapshot.totalTokensObserved);
  const input = sum(snapshots, (snapshot) => snapshot.inputTokens);
  const output = sum(snapshots, (snapshot) => snapshot.outputTokens);
  const total = sum(snapshots, (snapshot) => snapshot.totalTokens);
  const cacheRead = sum(snapshots, (snapshot) => snapshot.cacheReadTokens);
  const cacheWrite = sum(snapshots, (snapshot) => snapshot.cacheWriteTokens);
  const tokens: NonNullable<LocalStatsReport["tokens"]> = {
    ...(inputAvailable ? { input } : inputObserved ? { inputReported: input } : {}),
    ...(outputAvailable ? { output } : outputObserved ? { outputReported: output } : {}),
    ...(totalAvailable ? { total } : totalObserved ? { totalReported: total } : {}),
    ...(cacheReadAvailable
      ? { cacheRead }
      : cacheReadObserved
        ? { cacheReadReported: cacheRead }
        : {}),
    ...(cacheWriteAvailable
      ? { cacheWrite }
      : cacheWriteObserved
        ? { cacheWriteReported: cacheWrite }
        : {}),
  };
  if (inputAvailable && cacheReadAvailable && cacheWriteAvailable) {
    const promptTokens = input + cacheRead + cacheWrite;
    if (promptTokens > 0) tokens.cacheHitPercent = Math.round(cacheRead / promptTokens * 10_000) / 100;
  }
  const costAvailable = allObserved(usageSnapshots, (snapshot) => snapshot.costComplete);
  const costObserved = usageSnapshots.some((snapshot) => snapshot.costObserved);
  const durationAvailable = allObserved(usageSnapshots, (snapshot) => snapshot.providerDurationObserved);
  return {
    schemaVersion: 1,
    kind: "rigyn-local-stats",
    source: {
      filesFound: listed.files.length,
      filesRead,
      filesSkipped: listed.files.length - filesRead,
      processes: snapshots.length,
      recordsSkipped,
      partial,
    },
    runs: sum(snapshots, (snapshot) => snapshot.runs),
    requests: sum(snapshots, (snapshot) => snapshot.requests),
    retries: sum(snapshots, (snapshot) => snapshot.retries),
    compactions: sum(snapshots, (snapshot) => snapshot.compactions),
    compactionFailures: sum(snapshots, (snapshot) => snapshot.compactionFailures),
    toolFailures: sum(snapshots, (snapshot) => snapshot.toolFailures),
    ...(Object.keys(tokens).length === 0 ? {} : { tokens }),
    ...(costAvailable
      ? { costUsd: sum(snapshots, (snapshot) => snapshot.costUsd) }
      : costObserved
        ? { costUsdReported: sum(snapshots, (snapshot) => snapshot.costUsd) }
        : {}),
    ...(durationAvailable
      ? { providerDurationMs: sum(snapshots, (snapshot) => snapshot.providerDurationMs) }
      : {}),
  };
}

function number(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function cost(value: number): string {
  return `$${value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "")}`;
}

function formatLocalStats(report: LocalStatsReport): string {
  const tokens = report.tokens;
  const tokenParts = tokens === undefined ? [] : [
    ...(tokens.input === undefined ? [] : [`input ${number(tokens.input)}`]),
    ...(tokens.inputReported === undefined ? [] : [`input reported ${number(tokens.inputReported)} (partial)`]),
    ...(tokens.output === undefined ? [] : [`output ${number(tokens.output)}`]),
    ...(tokens.outputReported === undefined ? [] : [`output reported ${number(tokens.outputReported)} (partial)`]),
    ...(tokens.total === undefined ? [] : [`total ${number(tokens.total)}`]),
    ...(tokens.totalReported === undefined ? [] : [`total reported ${number(tokens.totalReported)} (partial)`]),
    ...(tokens.cacheRead === undefined ? [] : [`cache read ${number(tokens.cacheRead)}`]),
    ...(tokens.cacheWrite === undefined ? [] : [`cache write ${number(tokens.cacheWrite)}`]),
    ...(tokens.cacheReadReported === undefined ? [] : [`cache read reported ${number(tokens.cacheReadReported)} (partial)`]),
    ...(tokens.cacheWriteReported === undefined ? [] : [`cache write reported ${number(tokens.cacheWriteReported)} (partial)`]),
  ];
  const skipped = report.source.filesSkipped + report.source.recordsSkipped;
  return [
    "Rigyn local stats",
    `Runs: ${number(report.runs)}`,
    `Main model attempts: ${number(report.requests)}`,
    ...(tokenParts.length === 0 ? [] : [`Tokens: ${tokenParts.join(" · ")}`]),
    ...(tokens?.cacheHitPercent === undefined
      ? []
      : [`Cache hit: ${number(tokens.cacheHitPercent)}% of prompt tokens`]),
    ...(report.costUsd === undefined ? [] : [`Cost: ${cost(report.costUsd)}`]),
    ...(report.costUsdReported === undefined ? [] : [`Cost: ${cost(report.costUsdReported)} reported (partial)`]),
    `Retries: ${number(report.retries)}`,
    `Compactions: ${number(report.compactions)}`,
    `Compaction failures: ${number(report.compactionFailures)}`,
    `Tool failures: ${number(report.toolFailures)}`,
    ...(report.providerDurationMs === undefined
      ? []
      : [`Provider duration: ${number(report.providerDurationMs)} ms reported total`]),
    `Source: ${number(report.source.processes)} runtime-observer aggregates from ${number(report.source.filesRead)}/${number(report.source.filesFound)} files${report.source.partial ? " · partial" : ""}`,
    ...(skipped === 0 ? [] : [`Skipped: ${number(report.source.filesSkipped)} files · ${number(report.source.recordsSkipped)} records`]),
    "",
  ].join("\n");
}

export async function runStatsCommand(argumentsValue: ManagementArguments): Promise<void> {
  if (argumentsValue.positionals.length > 0) throw new Error("stats accepts no positional arguments");
  const report = await createLocalStatsReport();
  writeMachineOutput(flagBoolean(argumentsValue, "json")
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatLocalStats(report));
}
