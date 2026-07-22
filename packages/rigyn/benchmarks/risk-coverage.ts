import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runProcess } from "../src/process/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "benchmarks", "risk-coverage.config.json");
const C8_BIN = createRequire(import.meta.url).resolve("c8/bin/c8.js");

export interface CoveragePercentages {
  lines: number;
  branches: number;
  functions: number;
}

export interface RiskCoverageTarget {
  file: string;
  minimum: CoveragePercentages;
}

export interface RiskCoverageGroup {
  id: string;
  targets: string[];
  testPrefixes: string[];
  testExcludes: string[];
}

export interface RiskCoverageConfig {
  schemaVersion: 1;
  excludedTests: string[];
  targets: RiskCoverageTarget[];
  groups: RiskCoverageGroup[];
}

export interface RiskCoverageResult {
  file: string;
  actual: CoveragePercentages;
  minimum: CoveragePercentages;
  passed: boolean;
  failures: Array<keyof CoveragePercentages>;
}

export interface RiskCoverageReport {
  schemaVersion: 1;
  suite: "risk-coverage-v1";
  purpose: "high-risk-module-regression-guard";
  globalThreshold: false;
  platform: NodeJS.Platform;
  excludedTests: string[];
  testFiles: number;
  durationMs: number;
  groups: Array<{
    id: string;
    targets: string[];
    testPrefixes: string[];
    testExcludes: string[];
    testFiles: number;
    durationMs: number;
  }>;
  targets: RiskCoverageResult[];
  passed: boolean;
}

function portable(path: string): string {
  return path.split(sep).join("/");
}

function validProjectPath(value: unknown, prefix: "src/" | "test/", suffix: string): value is string {
  if (typeof value !== "string" || !value.startsWith(prefix) || !value.endsWith(suffix) || value.includes("\\")) return false;
  const body = suffix === "/" ? value.slice(0, -1) : value;
  return body.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function parseV8Coverage(input: string, root = ROOT): Map<string, CoveragePercentages> {
  const parsed: unknown = JSON.parse(input);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("V8 coverage report must be an object");
  const files = (parsed as Record<string, unknown>).files;
  if (!Array.isArray(files)) throw new Error("V8 coverage report files must be an array");
  const coverage = new Map<string, CoveragePercentages>();
  for (const entry of files) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("V8 coverage file must be an object");
    const record = entry as Record<string, unknown>;
    if (typeof record.sourcePath !== "string" || record.sourcePath === "") throw new Error("V8 coverage sourcePath is invalid");
    if (record.summary === null || typeof record.summary !== "object" || Array.isArray(record.summary)) {
      throw new Error(`V8 coverage summary is invalid for ${record.sourcePath}`);
    }
    const metrics = record.summary as Record<string, unknown>;
    const readMetric = (name: keyof CoveragePercentages): number => {
      const metric = metrics[name];
      const value = metric !== null && typeof metric === "object" && !Array.isArray(metric)
        ? (metric as Record<string, unknown>).pct
        : undefined;
      if (!validPercentage(value)) throw new Error(`V8 coverage ${name} percentage is invalid for ${record.sourcePath}`);
      return value;
    };
    const absolute = resolve(root, record.sourcePath);
    const file = portable(relative(root, absolute));
    coverage.set(file, {
      lines: readMetric("lines"),
      branches: readMetric("branches"),
      functions: readMetric("functions"),
    });
  }
  return coverage;
}

function validPercentage(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function parseRiskCoverageConfig(value: unknown): RiskCoverageConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Risk coverage config must be an object");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new Error("Risk coverage schemaVersion must be 1");
  if (!Array.isArray(record.excludedTests) || !record.excludedTests.every((entry) => validProjectPath(entry, "test/", "/"))) {
    throw new Error("Risk coverage excludedTests must contain test-directory prefixes");
  }
  if (new Set(record.excludedTests).size !== record.excludedTests.length) throw new Error("Risk coverage excludedTests must be unique");
  if (!Array.isArray(record.targets) || record.targets.length === 0) throw new Error("Risk coverage targets must not be empty");
  const targets = record.targets.map((entry, index): RiskCoverageTarget => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Risk coverage target ${index} must be an object`);
    const target = entry as Record<string, unknown>;
    const minimum = target.minimum;
    if (!validProjectPath(target.file, "src/", ".ts")) {
      throw new Error(`Risk coverage target ${index} file is invalid`);
    }
    if (minimum === null || typeof minimum !== "object" || Array.isArray(minimum)) {
      throw new Error(`Risk coverage target ${index} minimum is invalid`);
    }
    const values = minimum as Record<string, unknown>;
    if (!validPercentage(values.lines) || !validPercentage(values.branches) || !validPercentage(values.functions)) {
      throw new Error(`Risk coverage target ${index} thresholds must be percentages`);
    }
    return {
      file: target.file,
      minimum: { lines: values.lines, branches: values.branches, functions: values.functions },
    };
  });
  if (new Set(targets.map((entry) => entry.file)).size !== targets.length) throw new Error("Risk coverage target files must be unique");
  if (!Array.isArray(record.groups) || record.groups.length === 0) throw new Error("Risk coverage groups must not be empty");
  const targetFiles = new Set(targets.map((entry) => entry.file));
  const groups = record.groups.map((entry, index): RiskCoverageGroup => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Risk coverage group ${index} must be an object`);
    const group = entry as Record<string, unknown>;
    if (typeof group.id !== "string" || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(group.id)) {
      throw new Error(`Risk coverage group ${index} id is invalid`);
    }
    if (!Array.isArray(group.targets) || group.targets.length === 0 || !group.targets.every((file) => typeof file === "string" && targetFiles.has(file))) {
      throw new Error(`Risk coverage group ${group.id} targets are invalid`);
    }
    const groupTargets = group.targets as string[];
    if (new Set(groupTargets).size !== groupTargets.length) throw new Error(`Risk coverage group ${group.id} targets must be unique`);
    if (!Array.isArray(group.testPrefixes) || group.testPrefixes.length === 0
      || !group.testPrefixes.every((prefix) => validProjectPath(prefix, "test/", "/"))) {
      throw new Error(`Risk coverage group ${group.id} testPrefixes are invalid`);
    }
    const testPrefixes = group.testPrefixes as string[];
    if (new Set(testPrefixes).size !== testPrefixes.length) {
      throw new Error(`Risk coverage group ${group.id} testPrefixes must be unique`);
    }
    if (!Array.isArray(group.testExcludes)
      || !group.testExcludes.every((file) => validProjectPath(file, "test/", ".test.ts"))) {
      throw new Error(`Risk coverage group ${group.id} testExcludes are invalid`);
    }
    const testExcludes = group.testExcludes as string[];
    if (new Set(testExcludes).size !== testExcludes.length) {
      throw new Error(`Risk coverage group ${group.id} testExcludes must be unique`);
    }
    if (testExcludes.some((file) => !testPrefixes.some((prefix) => file.startsWith(prefix)))) {
      throw new Error(`Risk coverage group ${group.id} testExcludes must be within a testPrefix`);
    }
    return {
      id: group.id,
      targets: [...groupTargets],
      testPrefixes: [...testPrefixes],
      testExcludes: [...testExcludes],
    };
  });
  if (new Set(groups.map((group) => group.id)).size !== groups.length) throw new Error("Risk coverage group ids must be unique");
  const assignedTargets = groups.flatMap((group) => group.targets);
  if (new Set(assignedTargets).size !== assignedTargets.length
    || assignedTargets.length !== targets.length
    || assignedTargets.some((file) => !targetFiles.has(file))) {
    throw new Error("Every risk coverage target must belong to exactly one group");
  }
  return { schemaVersion: 1, excludedTests: [...record.excludedTests] as string[], targets, groups };
}

export function evaluateRiskCoverage(
  config: RiskCoverageConfig,
  coverage: ReadonlyMap<string, CoveragePercentages>,
): RiskCoverageResult[] {
  return config.targets.map((target) => {
    const actual = coverage.get(target.file);
    if (actual === undefined) throw new Error(`Coverage report is missing ${target.file}`);
    const failures = (Object.keys(target.minimum) as Array<keyof CoveragePercentages>)
      .filter((key) => actual[key] < target.minimum[key]);
    return { file: target.file, actual, minimum: target.minimum, passed: failures.length === 0, failures };
  });
}

async function discoverTests(directory: string, excluded: readonly string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const projectPath = portable(relative(ROOT, absolute));
    if (excluded.some((prefix) => projectPath.startsWith(prefix))) continue;
    if (entry.isDirectory()) paths.push(...await discoverTests(absolute, excluded));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) paths.push(projectPath);
  }
  return paths.sort();
}

export function selectRiskCoverageTests(tests: readonly string[], group: RiskCoverageGroup): string[] {
  const candidates = tests.filter((file) => group.testPrefixes.some((prefix) => file.startsWith(prefix)));
  if (candidates.length === 0) throw new Error(`Risk coverage group ${group.id} does not match any tests`);
  for (const excluded of group.testExcludes) {
    if (!candidates.includes(excluded)) throw new Error(`Risk coverage group ${group.id} excludes an unknown test: ${excluded}`);
  }
  const exclusions = new Set(group.testExcludes);
  const selected = candidates.filter((file) => !exclusions.has(file));
  if (selected.length === 0) throw new Error(`Risk coverage group ${group.id} does not select any tests`);
  return selected;
}

export async function validateRiskCoverageTargets(config: RiskCoverageConfig, root = ROOT): Promise<void> {
  for (const target of config.targets) {
    let metadata;
    try {
      metadata = await stat(join(root, target.file));
    } catch (error) {
      throw new Error(
        `Risk coverage target ${target.file} is missing or unreadable; update benchmarks/risk-coverage.config.json after moving or removing source files`,
        { cause: error },
      );
    }
    if (!metadata.isFile()) {
      throw new Error(
        `Risk coverage target ${target.file} is not a regular file; update benchmarks/risk-coverage.config.json after moving or removing source files`,
      );
    }
  }
}

export async function runRiskCoverageCheck(): Promise<RiskCoverageReport> {
  const config = parseRiskCoverageConfig(JSON.parse(await readFile(CONFIG, "utf8")));
  await validateRiskCoverageTargets(config);
  const allTests = await discoverTests(join(ROOT, "test"), config.excludedTests);
  const groupedTests = config.groups.map((group) => ({ group, tests: selectRiskCoverageTests(allTests, group) }));
  const temporary = await mkdtemp(join(tmpdir(), "rigyn-risk-coverage-"));
  try {
    const coverage = new Map<string, CoveragePercentages>();
    const groupReports: RiskCoverageReport["groups"] = [];
    for (const { group, tests } of groupedTests) {
      const reportDirectory = join(temporary, group.id, "report");
      const result = await runProcess({
        argv: [
          process.execPath,
          C8_BIN,
          "--experimental-monocart",
          "--merge-async",
          "--reporter=v8-json",
          `--temp-directory=${join(temporary, group.id, "v8")}`,
          `--reports-dir=${reportDirectory}`,
          ...group.targets.map((file) => `--include=${file}`),
          process.execPath,
          "--import",
          "./test/setup.mjs",
          "--import",
          "tsx",
          "--test",
          "--test-concurrency=4",
          "--test-reporter=spec",
          "--test-reporter-destination=stderr",
          ...tests,
        ],
        cwd: ROOT,
        timeoutMs: 20 * 60_000,
        outputLimitBytes: 16 * 1024 * 1024,
      }, new AbortController().signal);
      if (result.exitCode !== 0 || result.timedOut || result.cancelled) {
        const diagnostic = result.stderr.toString("utf8").slice(-16 * 1024);
        if (diagnostic !== "") process.stderr.write(diagnostic);
        throw new Error(result.timedOut ? `Risk coverage group ${group.id} timed out` : `Risk coverage group ${group.id} failed`);
      }
      const groupCoverage = parseV8Coverage(await readFile(join(reportDirectory, "coverage-report.json"), "utf8"));
      for (const file of group.targets) {
        const percentages = groupCoverage.get(file);
        if (percentages === undefined) throw new Error(`Coverage report is missing ${file}`);
        coverage.set(file, percentages);
      }
      groupReports.push({
        id: group.id,
        targets: group.targets,
        testPrefixes: group.testPrefixes,
        testExcludes: group.testExcludes,
        testFiles: tests.length,
        durationMs: result.durationMs,
      });
    }
    const targets = evaluateRiskCoverage(config, coverage);
    return {
      schemaVersion: 1,
      suite: "risk-coverage-v1",
      purpose: "high-risk-module-regression-guard",
      globalThreshold: false,
      platform: process.platform,
      excludedTests: config.excludedTests,
      testFiles: new Set(groupedTests.flatMap(({ tests }) => tests)).size,
      durationMs: groupReports.reduce((total, group) => total + group.durationMs, 0),
      groups: groupReports,
      targets,
      passed: targets.every((target) => target.passed),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const report = await runRiskCoverageCheck();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

const invoked = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) await main();
