import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { EventEnvelope, NormalizedUsage } from "../src/index.js";
import { addNormalizedUsage as aggregateNormalizedUsage } from "../src/core/usage.js";
import { normalizeCommandArgv } from "../src/process/command.js";
import { runProcess } from "../src/process/index.js";
import type { BenchmarkUsage } from "./offline.js";

const CONFIG_LIMIT_BYTES = 1024 * 1024;
const FIXTURE_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const satisfies readonly (keyof BenchmarkUsage)[];

type MetricsFormat = "rigyn-jsonl" | "json-summary" | "none";

export interface ComparativeHarnessConfig {
  id: string;
  argv: [string, ...string[]];
  metrics: MetricsFormat;
}

export interface ComparativeTaskConfig {
  id: string;
  prompt: string;
  files: Record<string, string>;
  verifier: {
    argv: [string, ...string[]];
    timeoutMs?: number;
  };
}

export interface ComparativeLiveConfig {
  schemaVersion: 1;
  provider: string;
  model: string;
  samples: number;
  timeoutMs: number;
  outputLimitBytes?: number;
  harnesses: [ComparativeHarnessConfig, ComparativeHarnessConfig];
  tasks: ComparativeTaskConfig[];
}

export interface ComparativeRunMetrics {
  completion: boolean;
  verifierPassed: boolean;
  passed: boolean;
  failure?: "command_error" | "command_failed" | "timed_out" | "verification_failed";
  wallTimeMs: number;
  exitCode: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  steps: number | null;
  toolErrors: number | null;
  usage: BenchmarkUsage;
}

export interface ComparativeLiveReport {
  schemaVersion: 1;
  suite: "comparative-live-v1";
  purpose: "same-task-peer-comparison";
  stochastic: true;
  provider: string;
  model: string;
  samples: number;
  runs: Array<{
    taskId: string;
    harnessId: string;
    sample: number;
    metrics: ComparativeRunMetrics;
  }>;
  summary: Array<{
    harnessId: string;
    runs: number;
    completionRate: number;
    verifierPassRate: number;
    passRate: number;
    medianWallTimeMs: number;
    steps: number | null;
    toolErrors: number | null;
    usage: BenchmarkUsage;
  }>;
}

interface ObservedMetrics {
  completion: boolean | null;
  steps: number | null;
  toolErrors: number | null;
  usage: BenchmarkUsage;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !accepted.has(key));
  if (unknown !== undefined) throw new Error(`${label} contains unknown key ${unknown}`);
}

function text(value: unknown, label: string, maximum = 16 * 1024): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || Buffer.byteLength(value) > maximum) {
    throw new Error(`${label} must be a non-empty string no larger than ${maximum} bytes`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const selected = text(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(selected)) {
    throw new Error(`${label} must start with a letter or digit and contain only letters, digits, dots, underscores, or hyphens`);
  }
  return selected;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function argv(value: unknown, label: string): [string, ...string[]] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) throw new Error(`${label} must contain 1 to 128 arguments`);
  const values = value.map((entry, index) => text(entry, `${label}[${index}]`, 8 * 1024));
  return normalizeCommandArgv(values);
}

function safeRelativePath(value: string, label: string): string {
  if (isAbsolute(value) || value === "" || value.includes("\0")) throw new Error(`${label} must be relative`);
  const normalized = resolve("/fixture", value);
  const child = relative("/fixture", normalized);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`${label} escapes the fixture workspace`);
  }
  return child;
}

function parseHarness(value: unknown, index: number): ComparativeHarnessConfig {
  const record = object(value, `harnesses[${index}]`);
  exactKeys(record, ["id", "argv", "metrics"], `harnesses[${index}]`);
  const selectedArgv = argv(record.argv, `harnesses[${index}].argv`);
  for (const placeholder of ["{prompt}", "{provider}", "{model}"]) {
    if (!selectedArgv.slice(1).some((argument) => argument.includes(placeholder))) {
      throw new Error(`harnesses[${index}].argv must contain ${placeholder}`);
    }
  }
  const metrics = record.metrics;
  if (metrics !== "rigyn-jsonl" && metrics !== "json-summary" && metrics !== "none") {
    throw new Error(`harnesses[${index}].metrics is invalid`);
  }
  return { id: identifier(record.id, `harnesses[${index}].id`), argv: selectedArgv, metrics };
}

function parseTask(value: unknown, index: number): ComparativeTaskConfig {
  const record = object(value, `tasks[${index}]`);
  exactKeys(record, ["id", "prompt", "files", "verifier"], `tasks[${index}]`);
  const rawFiles = object(record.files, `tasks[${index}].files`);
  if (Object.keys(rawFiles).length > 256) throw new Error(`tasks[${index}].files contains more than 256 files`);
  const files: Record<string, string> = {};
  let fixtureBytes = 0;
  for (const [path, content] of Object.entries(rawFiles)) {
    const selectedPath = safeRelativePath(path, `tasks[${index}].files path`);
    if (typeof content !== "string" || content.includes("\0")) throw new Error(`tasks[${index}].files content must be text`);
    fixtureBytes += Buffer.byteLength(content);
    if (fixtureBytes > FIXTURE_LIMIT_BYTES) throw new Error(`tasks[${index}].files exceeds ${FIXTURE_LIMIT_BYTES} bytes`);
    files[selectedPath] = content;
  }
  const verifier = object(record.verifier, `tasks[${index}].verifier`);
  exactKeys(verifier, ["argv", "timeoutMs"], `tasks[${index}].verifier`);
  return {
    id: identifier(record.id, `tasks[${index}].id`),
    prompt: text(record.prompt, `tasks[${index}].prompt`, 128 * 1024),
    files,
    verifier: {
      argv: argv(verifier.argv, `tasks[${index}].verifier.argv`),
      ...(verifier.timeoutMs === undefined
        ? {}
        : { timeoutMs: integer(verifier.timeoutMs, `tasks[${index}].verifier.timeoutMs`, 1_000, 300_000) }),
    },
  };
}

export function parseComparativeLiveConfig(value: unknown): ComparativeLiveConfig {
  const record = object(value, "configuration");
  exactKeys(record, ["schemaVersion", "provider", "model", "samples", "timeoutMs", "outputLimitBytes", "harnesses", "tasks"], "configuration");
  if (record.schemaVersion !== 1) throw new Error("configuration.schemaVersion must be 1");
  if (!Array.isArray(record.harnesses) || record.harnesses.length !== 2) {
    throw new Error("configuration.harnesses must contain exactly two harnesses");
  }
  if (!Array.isArray(record.tasks) || record.tasks.length === 0 || record.tasks.length > 32) {
    throw new Error("configuration.tasks must contain 1 to 32 tasks");
  }
  const harnesses = record.harnesses.map(parseHarness) as [ComparativeHarnessConfig, ComparativeHarnessConfig];
  if (harnesses[0].id === harnesses[1].id) throw new Error("configuration harness ids must be unique");
  const tasks = record.tasks.map(parseTask);
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error("configuration task ids must be unique");
  return {
    schemaVersion: 1,
    provider: text(record.provider, "configuration.provider", 256),
    model: text(record.model, "configuration.model", 512),
    samples: integer(record.samples, "configuration.samples", 1, 10),
    timeoutMs: integer(record.timeoutMs, "configuration.timeoutMs", 10_000, 1_800_000),
    ...(record.outputLimitBytes === undefined
      ? {}
      : { outputLimitBytes: integer(record.outputLimitBytes, "configuration.outputLimitBytes", 64 * 1024, 64 * 1024 * 1024) }),
    harnesses,
    tasks,
  };
}

function unknownUsage(): BenchmarkUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    costUsd: null,
  };
}

function emptyUsage(): BenchmarkUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: "0",
  };
}

function decimal(value: string): { coefficient: bigint; scale: number } {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(value);
  if (match === null) throw new Error("Comparison cost is not a normalized decimal");
  const fraction = match[2] ?? "";
  let coefficient = BigInt(`${match[1]}${fraction}`);
  let scale = fraction.length - Number(match[3] ?? "0");
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

function formatDecimal(coefficient: bigint, scale: number): string {
  if (coefficient === 0n) return "0";
  const digits = coefficient.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const fraction = digits.slice(-scale).replace(/0+$/u, "");
  return fraction === "" ? digits.slice(0, -scale) : `${digits.slice(0, -scale)}.${fraction}`;
}

function addDecimal(left: string, right: string): string {
  const first = decimal(left);
  const second = decimal(right);
  const scale = Math.max(first.scale, second.scale);
  return formatDecimal(
    first.coefficient * 10n ** BigInt(scale - first.scale) +
      second.coefficient * 10n ** BigInt(scale - second.scale),
    scale,
  );
}

function addUsage(left: BenchmarkUsage, right: BenchmarkUsage): BenchmarkUsage {
  const result = unknownUsage();
  for (const field of USAGE_FIELDS) {
    const first = left[field];
    const second = right[field];
    result[field] = first === null || second === null ? null : first + second;
  }
  result.costUsd = left.costUsd === null || right.costUsd === null ? null : addDecimal(left.costUsd, right.costUsd);
  return result;
}

function normalizedUsage(value: NormalizedUsage): BenchmarkUsage {
  return {
    inputTokens: value.inputTokens ?? null,
    outputTokens: value.outputTokens ?? null,
    totalTokens: value.totalTokens ?? null,
    cacheReadTokens: value.cacheReadTokens ?? null,
    cacheWriteTokens: value.cacheWriteTokens ?? null,
    reasoningTokens: value.reasoningTokens ?? null,
    costUsd: value.cost === undefined ? null : String(value.cost.total),
  };
}

export function parseRigynJsonlMetrics(output: string): ObservedMetrics {
  let completion = false;
  let steps = 0;
  let toolErrors = 0;
  let currentUsage: NormalizedUsage | undefined;
  const usageSegments: BenchmarkUsage[] = [];
  const finishSegment = (): void => {
    if (currentUsage === undefined) return;
    usageSegments.push(normalizedUsage(currentUsage));
    currentUsage = undefined;
  };
  for (const line of output.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    const envelope = value as Partial<EventEnvelope>;
    const event = envelope.event;
    if (event === undefined || typeof event !== "object" || event === null || !("type" in event)) continue;
    if (event.type === "assistant_started") {
      finishSegment();
      if (typeof event.step === "number") steps = Math.max(steps, event.step);
    } else if (event.type === "tool_completed" && event.isError === true) toolErrors += 1;
    else if (event.type === "run_completed") completion = true;
    else if (event.type === "usage") {
      currentUsage = event.semantics === "incremental"
        ? aggregateNormalizedUsage(currentUsage, event.usage)
        : { ...event.usage };
    }
  }
  finishSegment();
  return {
    completion,
    steps,
    toolErrors,
    usage: usageSegments.length === 0 ? unknownUsage() : usageSegments.reduce(addUsage, emptyUsage()),
  };
}

function nullableMetric(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return integer(value, label, 0, Number.MAX_SAFE_INTEGER);
}

function parseUsageSummary(value: unknown): BenchmarkUsage {
  if (value === null || value === undefined) return unknownUsage();
  const record = object(value, "summary usage");
  const result = unknownUsage();
  for (const field of USAGE_FIELDS) result[field] = nullableMetric(record[field], `summary usage.${field}`);
  const cost = record.costUsd;
  if (cost !== null && cost !== undefined) {
    if (typeof cost !== "string") throw new Error("summary usage.costUsd must be a decimal string or null");
    decimal(cost);
    result.costUsd = cost;
  }
  return result;
}

function parseJsonSummary(output: string): ObservedMetrics {
  const lines = output.split(/\r?\n/u).filter((line) => line.trim() !== "").reverse();
  for (const line of lines) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    try {
      const record = object(value, "metrics summary");
      if (typeof record.completed !== "boolean") continue;
      return {
        completion: record.completed,
        steps: nullableMetric(record.steps, "metrics summary.steps"),
        toolErrors: nullableMetric(record.toolErrors, "metrics summary.toolErrors"),
        usage: parseUsageSummary(record.usage),
      };
    } catch {
      continue;
    }
  }
  return { completion: null, steps: null, toolErrors: null, usage: unknownUsage() };
}

function expandArguments(
  selected: readonly string[],
  values: { prompt: string; provider: string; model: string; workspace: string },
): [string, ...string[]] {
  return normalizeCommandArgv(selected.map((argument) => argument
    .replaceAll("{prompt}", values.prompt)
    .replaceAll("{provider}", values.provider)
    .replaceAll("{model}", values.model)
    .replaceAll("{workspace}", values.workspace)));
}

async function populate(workspace: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const destination = join(workspace, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
}

async function oneRun(
  config: ComparativeLiveConfig,
  task: ComparativeTaskConfig,
  harness: ComparativeHarnessConfig,
  root: string,
  sample: number,
): Promise<ComparativeRunMetrics> {
  const workspace = join(root, task.id, harness.id, String(sample));
  await mkdir(workspace, { recursive: true });
  await populate(workspace, task.files);
  const values = { prompt: task.prompt, provider: config.provider, model: config.model, workspace };
  let outcome;
  try {
    outcome = await runProcess({
      argv: expandArguments(harness.argv, values),
      cwd: workspace,
      timeoutMs: config.timeoutMs,
      outputLimitBytes: config.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
    }, new AbortController().signal);
  } catch {
    return {
      completion: false,
      verifierPassed: false,
      passed: false,
      failure: "command_error",
      wallTimeMs: 0,
      exitCode: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      steps: null,
      toolErrors: null,
      usage: unknownUsage(),
    };
  }
  const stdout = outcome.stdout.toString("utf8");
  const observed = harness.metrics === "rigyn-jsonl"
    ? parseRigynJsonlMetrics(stdout)
    : harness.metrics === "json-summary"
      ? parseJsonSummary(stdout)
      : { completion: null, steps: null, toolErrors: null, usage: unknownUsage() };
  const processCompleted = outcome.exitCode === 0 && !outcome.timedOut && !outcome.cancelled;
  const completion = processCompleted && observed.completion !== false;
  let verifierPassed = false;
  if (completion) {
    try {
      const verification = await runProcess({
        argv: expandArguments(task.verifier.argv, values),
        cwd: workspace,
        timeoutMs: task.verifier.timeoutMs ?? 60_000,
        outputLimitBytes: 1024 * 1024,
      }, new AbortController().signal);
      verifierPassed = verification.exitCode === 0 && !verification.timedOut && !verification.cancelled;
    } catch {
      verifierPassed = false;
    }
  }
  const failure = outcome.timedOut
    ? "timed_out" as const
    : !processCompleted
      ? "command_failed" as const
      : !verifierPassed
        ? "verification_failed" as const
        : undefined;
  return {
    completion,
    verifierPassed,
    passed: completion && verifierPassed,
    ...(failure === undefined ? {} : { failure }),
    wallTimeMs: outcome.durationMs,
    exitCode: outcome.exitCode,
    stdoutBytes: outcome.stdoutBytes,
    stderrBytes: outcome.stderrBytes,
    steps: observed.steps,
    toolErrors: observed.toolErrors,
    usage: observed.usage,
  };
}

function sumKnown(values: readonly (number | null)[]): number | null {
  return values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function aggregateKnownUsage(values: readonly BenchmarkUsage[]): BenchmarkUsage {
  return values.length === 0 ? unknownUsage() : values.reduce(addUsage, emptyUsage());
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor((ordered.length - 1) / 2)] ?? 0;
}

export async function runComparativeLiveBenchmark(input: unknown): Promise<ComparativeLiveReport> {
  const config = parseComparativeLiveConfig(input);
  const root = await mkdtemp(join(tmpdir(), "rigyn-live-compare-"));
  try {
    const runs: ComparativeLiveReport["runs"] = [];
    for (const task of config.tasks) {
      for (const harness of config.harnesses) {
        for (let sample = 1; sample <= config.samples; sample += 1) {
          runs.push({ taskId: task.id, harnessId: harness.id, sample, metrics: await oneRun(config, task, harness, root, sample) });
        }
      }
    }
    const summary = config.harnesses.map((harness) => {
      const selected = runs.filter((run) => run.harnessId === harness.id).map((run) => run.metrics);
      return {
        harnessId: harness.id,
        runs: selected.length,
        completionRate: selected.filter((entry) => entry.completion).length / selected.length,
        verifierPassRate: selected.filter((entry) => entry.verifierPassed).length / selected.length,
        passRate: selected.filter((entry) => entry.passed).length / selected.length,
        medianWallTimeMs: median(selected.map((entry) => entry.wallTimeMs)),
        steps: sumKnown(selected.map((entry) => entry.steps)),
        toolErrors: sumKnown(selected.map((entry) => entry.toolErrors)),
        usage: aggregateKnownUsage(selected.map((entry) => entry.usage)),
      };
    });
    return {
      schemaVersion: 1,
      suite: "comparative-live-v1",
      purpose: "same-task-peer-comparison",
      stochastic: true,
      provider: config.provider,
      model: config.model,
      samples: config.samples,
      runs,
      summary,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (process.env.RIGYN_LIVE_COMPARE !== "1") {
    throw new Error("Live comparison is disabled; set RIGYN_LIVE_COMPARE=1 after reviewing its paid external commands");
  }
  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex < 0 ? undefined : process.argv[configIndex + 1];
  if (configPath === undefined) throw new Error("Usage: npm run benchmark:compare -- --config <path>");
  const bytes = await readFile(configPath);
  if (bytes.byteLength > CONFIG_LIMIT_BYTES) throw new Error(`Comparison configuration exceeds ${CONFIG_LIMIT_BYTES} bytes`);
  const report = await runComparativeLiveBenchmark(JSON.parse(bytes.toString("utf8")));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.runs.some((run) => !run.metrics.passed)) process.exitCode = 1;
}

const invoked = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) await main();
