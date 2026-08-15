import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { BenchmarkReport } from "./offline.js";
import type { RuntimePerformanceReport } from "./runtime-performance.js";
import { runProcess } from "../src/process/index.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_ROOT = resolve(PACKAGE_ROOT, "../..");
const NETWORK_GUARD = pathToFileURL(fileURLToPath(
  new URL("./offline-network-guard.mjs", import.meta.url),
)).href;
const NETWORK_GUARD_MARKER = Symbol.for("rigyn.offline-release-network-guard");
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const FAILURE_LIMIT_CHARACTERS = 16 * 1024;

export type OfflineReleaseAreaId =
  | "tui-lifecycle"
  | "tool-coordinator"
  | "compaction-cache"
  | "v4-recovery"
  | "portable-plugins"
  | "observability"
  | "provider-auth-contracts";

interface FocusedCheckDefinition {
  id: string;
  areas: OfflineReleaseAreaId[];
  testFiles: string[];
}

export const OFFLINE_RELEASE_FOCUSED_CHECKS: readonly FocusedCheckDefinition[] = [
  {
    id: "tui-lifecycle",
    areas: ["tui-lifecycle"],
    testFiles: [
      "test/cli/process-signal-cleanup.test.ts",
      "test/cli/refresh-pty.test.ts",
      "test/cli/tui-extension-session-controls-pty.test.ts",
      "test/modes/interactive-mode-direct.test.ts",
    ],
  },
  {
    id: "tool-coordinator",
    areas: ["tool-coordinator"],
    testFiles: [
      "test/tools/coordinator-cancellation.test.ts",
      "test/tools/coordinator-interceptors.test.ts",
      "test/tools/coordinator-recovered.test.ts",
      "test/tools/coordinator-scheduling.test.ts",
    ],
  },
  {
    id: "context-and-cache",
    areas: ["compaction-cache"],
    testFiles: [
      "test/context/budget.test.ts",
      "test/context/compaction-robustness.test.ts",
      "test/core/cache-diagnostics.test.ts",
    ],
  },
  {
    id: "v4-recovery",
    areas: ["v4-recovery"],
    testFiles: [
      "../kernel/test/semantic/session-v4-io-hardening.test.ts",
      "../kernel/test/semantic/session-v4-reducer-hardening.test.ts",
      "test/service/agent-session-process-death-recovery.test.ts",
    ],
  },
  {
    id: "portable-plugins",
    areas: ["portable-plugins"],
    testFiles: ["test/core/portable-plugin.test.ts"],
  },
  {
    id: "observability",
    areas: ["observability"],
    testFiles: [
      "test/cli/runtime-observability.test.ts",
      "test/core/local-observability.test.ts",
      "test/core/observability.test.ts",
      "test/embedding/observability.test.ts",
    ],
  },
  {
    id: "provider-auth-contracts",
    areas: ["provider-auth-contracts"],
    testFiles: [
      "../models/test/auth-boundaries.test.ts",
      "../models/test/protocol-transports.test.ts",
      "../models/test/provider-catalog.test.ts",
      "../models/test/public-boundaries.test.ts",
      "../models/test/resilience-faux.test.ts",
      "../models/test/tools-images-kimi.test.ts",
      "test/providers/builtin-endpoint-reasoning-matrix.test.ts",
      "test/providers/builtin-provider-wire-contract.test.ts",
      "test/providers/openai-codex-responses.test.ts",
    ],
  },
];

export interface OfflineReleaseFocusedCheckReport {
  id: string;
  areas: OfflineReleaseAreaId[];
  testFiles: string[];
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  passed: boolean;
  failure?: string;
}

export interface OfflineReleaseBuildReport {
  command: "npm run build";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

interface OfflineReleaseComponent<T> {
  durationMs: number;
  passed: boolean;
  report?: T;
  failure?: string;
}

export interface OfflineReleaseAreaReport {
  id: OfflineReleaseAreaId;
  evidence: string[];
  passed: boolean;
}

export interface OfflineReleaseReport {
  schemaVersion: 1;
  suite: "offline-release-v1";
  purpose: "credential-free-release-regression-gate";
  deterministic: true;
  environment: {
    platform: NodeJS.Platform;
    architecture: string;
    node: string;
    credentialSources: "isolated";
    externalNetwork: "blocked";
    loopbackFixtures: true;
    runtimePerformanceSamples: 1;
  };
  build: OfflineReleaseComponent<OfflineReleaseBuildReport>;
  focusedChecks: OfflineReleaseFocusedCheckReport[];
  offlineHarness: OfflineReleaseComponent<BenchmarkReport>;
  runtimePerformance: OfflineReleaseComponent<RuntimePerformanceReport>;
  areas: OfflineReleaseAreaReport[];
  summary: {
    areas: number;
    passedAreas: number;
    components: number;
    passedComponents: number;
    passed: boolean;
  };
}

const PASSTHROUGH_ENVIRONMENT = [
  "CI",
  "COLORTERM",
  "ComSpec",
  "COMSPEC",
  "DYLD_LIBRARY_PATH",
  "GITHUB_ACTIONS",
  "LANG",
  "LC_ALL",
  "LD_LIBRARY_PATH",
  "NO_COLOR",
  "PATH",
  "Path",
  "PATHEXT",
  "SHELL",
  "SystemRoot",
  "SYSTEMROOT",
  "TERM",
  "TZ",
  "WINDIR",
] as const;

export function createOfflineReleaseEnvironment(
  source: NodeJS.ProcessEnv,
  isolatedRoot: string,
  networkGuard = NETWORK_GUARD,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of PASSTHROUGH_ENVIRONMENT) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  const home = join(isolatedRoot, "home");
  const temporary = join(isolatedRoot, "tmp");
  environment.HOME = home;
  environment.USERPROFILE = home;
  environment.APPDATA = join(isolatedRoot, "app-data");
  environment.LOCALAPPDATA = join(isolatedRoot, "local-app-data");
  environment.XDG_CACHE_HOME = join(isolatedRoot, "cache");
  environment.XDG_CONFIG_HOME = join(isolatedRoot, "config");
  environment.XDG_DATA_HOME = join(isolatedRoot, "data");
  environment.XDG_STATE_HOME = join(isolatedRoot, "state");
  environment.RIGYN_HOME = join(home, ".rigyn");
  environment.RUNNER_TEMP = temporary;
  environment.TEMP = temporary;
  environment.TMP = temporary;
  environment.TMPDIR = temporary;
  environment.AWS_EC2_METADATA_DISABLED = "true";
  environment.NODE_OPTIONS = `--import=${networkGuard}`;
  return environment;
}

function replaceEnvironment(environment: Readonly<Record<string, string>>): void {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, environment);
}

function boundedFailure(value: unknown, isolatedRoot: string): string {
  const raw = value instanceof Error ? value.stack ?? value.message : String(value);
  const stable = raw
    .replaceAll(isolatedRoot, "<temporary>")
    .replaceAll(WORKSPACE_ROOT, "<repository>");
  if (stable.length <= FAILURE_LIMIT_CHARACTERS) return stable;
  return `${stable.slice(0, FAILURE_LIMIT_CHARACTERS)}\n...[truncated]`;
}

async function runFocusedCheck(
  definition: FocusedCheckDefinition,
  environment: Record<string, string>,
  isolatedRoot: string,
): Promise<OfflineReleaseFocusedCheckReport> {
  const started = performance.now();
  try {
    const result = await runProcess({
      argv: [
        process.execPath,
        "--import",
        "./test/setup.mjs",
        "--import",
        "tsx",
        "--test",
        "--test-concurrency=2",
        "--test-reporter=spec",
        ...definition.testFiles,
      ],
      cwd: PACKAGE_ROOT,
      env: environment,
      inheritEnv: false,
      timeoutMs: 20 * 60_000,
      outputLimitBytes: OUTPUT_LIMIT_BYTES,
    }, new AbortController().signal);
    const passed = result.exitCode === 0 && !result.timedOut && !result.cancelled;
    const diagnostic = [result.stderr, result.stdout]
      .filter((value) => value.length > 0)
      .map((value) => value.toString("utf8"))
      .join("\n");
    return {
      id: definition.id,
      areas: [...definition.areas],
      testFiles: [...definition.testFiles],
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      passed,
      ...(passed ? {} : { failure: boundedFailure(diagnostic || "Focused test process failed", isolatedRoot) }),
    };
  } catch (error) {
    return {
      id: definition.id,
      areas: [...definition.areas],
      testFiles: [...definition.testFiles],
      durationMs: Math.round(performance.now() - started),
      exitCode: null,
      signal: null,
      timedOut: false,
      passed: false,
      failure: boundedFailure(error, isolatedRoot),
    };
  }
}

async function runBuild(
  environment: Record<string, string>,
  isolatedRoot: string,
): Promise<OfflineReleaseComponent<OfflineReleaseBuildReport>> {
  const started = performance.now();
  try {
    const result = await runProcess({
      argv: [process.platform === "win32" ? "npm.cmd" : "npm", "run", "build", "--silent"],
      cwd: WORKSPACE_ROOT,
      env: environment,
      inheritEnv: false,
      timeoutMs: 10 * 60_000,
      outputLimitBytes: OUTPUT_LIMIT_BYTES,
    }, new AbortController().signal);
    const passed = result.exitCode === 0 && !result.timedOut && !result.cancelled;
    const diagnostic = [result.stderr, result.stdout]
      .filter((value) => value.length > 0)
      .map((value) => value.toString("utf8"))
      .join("\n");
    return {
      durationMs: result.durationMs,
      passed,
      report: {
        command: "npm run build",
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
      },
      ...(passed ? {} : { failure: boundedFailure(diagnostic || "Workspace build failed", isolatedRoot) }),
    };
  } catch (error) {
    return {
      durationMs: Math.round(performance.now() - started),
      passed: false,
      failure: boundedFailure(error, isolatedRoot),
    };
  }
}

async function runComponent<T>(
  operation: () => Promise<T>,
  evaluate: (report: T) => boolean,
  isolatedRoot: string,
): Promise<OfflineReleaseComponent<T>> {
  const started = performance.now();
  try {
    const report = await operation();
    return {
      durationMs: Math.round(performance.now() - started),
      passed: evaluate(report),
      report,
    };
  } catch (error) {
    return {
      durationMs: Math.round(performance.now() - started),
      passed: false,
      failure: boundedFailure(error, isolatedRoot),
    };
  }
}

function focusedPassed(reports: readonly OfflineReleaseFocusedCheckReport[], id: string): boolean {
  return reports.find((report) => report.id === id)?.passed === true;
}

function runtimeScenariosPassed(
  component: OfflineReleaseComponent<RuntimePerformanceReport>,
  operations: ReadonlySet<string>,
): boolean {
  const scenarios = component.report?.scenarios;
  return scenarios !== undefined
    && [...operations].every((operation) => scenarios.some((scenario) => scenario.operation === operation))
    && scenarios.filter((scenario) => operations.has(scenario.operation)).every((scenario) => scenario.passed);
}

function evaluateAreas(
  focusedChecks: readonly OfflineReleaseFocusedCheckReport[],
  offlineHarness: OfflineReleaseComponent<BenchmarkReport>,
  runtimePerformance: OfflineReleaseComponent<RuntimePerformanceReport>,
): OfflineReleaseAreaReport[] {
  const offline = offlineHarness.report;
  return [
    {
      id: "tui-lifecycle",
      evidence: ["focused:tui-lifecycle"],
      passed: focusedPassed(focusedChecks, "tui-lifecycle"),
    },
    {
      id: "tool-coordinator",
      evidence: ["focused:tool-coordinator", "offline-v2:tool-lifecycle"],
      passed: focusedPassed(focusedChecks, "tool-coordinator")
        && offlineHarness.passed,
    },
    {
      id: "compaction-cache",
      evidence: ["focused:context-and-cache", "offline-v2:compaction"],
      passed: focusedPassed(focusedChecks, "context-and-cache")
        && offline?.probes.compaction.passed === true,
    },
    {
      id: "v4-recovery",
      evidence: ["focused:v4-recovery", "offline-v2:crash-recovery", "runtime-performance-v1:resume-replay"],
      passed: focusedPassed(focusedChecks, "v4-recovery")
        && offline?.probes.crashRecovery.passed === true
        && runtimeScenariosPassed(runtimePerformance, new Set(["resume", "rpc-replay", "event-page"])),
    },
    {
      id: "portable-plugins",
      evidence: ["focused:portable-plugins", "runtime-performance-v1:startup-refresh"],
      passed: focusedPassed(focusedChecks, "portable-plugins")
        && runtimeScenariosPassed(runtimePerformance, new Set(["startup", "refresh"])),
    },
    {
      id: "observability",
      evidence: ["focused:observability"],
      passed: focusedPassed(focusedChecks, "observability"),
    },
    {
      id: "provider-auth-contracts",
      evidence: ["focused:provider-auth-contracts"],
      passed: focusedPassed(focusedChecks, "provider-auth-contracts"),
    },
  ];
}

export async function runOfflineReleaseEvaluation(
  onProgress: (message: string) => void = () => undefined,
): Promise<OfflineReleaseReport> {
  if (Reflect.get(globalThis, NETWORK_GUARD_MARKER) !== true) {
    throw new Error("Offline release evaluation requires the bundled external-network guard");
  }
  const isolatedRoot = await mkdtemp(join(tmpdir(), "rigyn-offline-release-"));
  const previousEnvironment = { ...process.env };
  try {
    for (const directory of ["home", "tmp", "app-data", "local-app-data", "cache", "config", "data", "state"]) {
      await mkdir(join(isolatedRoot, directory), { recursive: true });
    }
    const environment = createOfflineReleaseEnvironment(previousEnvironment, isolatedRoot);
    replaceEnvironment(environment);

    onProgress("build");
    const build = await runBuild(environment, isolatedRoot);

    const focusedChecks: OfflineReleaseFocusedCheckReport[] = [];
    if (build.passed) {
      for (const definition of OFFLINE_RELEASE_FOCUSED_CHECKS) {
        onProgress(`focused:${definition.id}`);
        focusedChecks.push(await runFocusedCheck(definition, environment, isolatedRoot));
      }
    } else {
      for (const definition of OFFLINE_RELEASE_FOCUSED_CHECKS) {
        focusedChecks.push({
          id: definition.id,
          areas: [...definition.areas],
          testFiles: [...definition.testFiles],
          durationMs: 0,
          exitCode: null,
          signal: null,
          timedOut: false,
          passed: false,
          failure: "Not run because the workspace build failed",
        });
      }
    }

    let offlineHarness: OfflineReleaseComponent<BenchmarkReport>;
    let runtimePerformance: OfflineReleaseComponent<RuntimePerformanceReport>;
    if (build.passed) {
      const [offlineModule, runtimeModule] = await Promise.all([
        import("./offline.js"),
        import("./runtime-performance.js"),
      ]);
      onProgress("offline-harness");
      offlineHarness = await runComponent(
        offlineModule.runOfflineBenchmark,
        (report) => report.summary.passed === report.summary.taskCount
          && report.probes.compaction.passed
          && report.probes.crashRecovery.passed,
        isolatedRoot,
      );
      onProgress("runtime-performance");
      runtimePerformance = await runComponent(
        async () => await runtimeModule.runRuntimePerformanceBenchmark({ samples: 1 }),
        (report) => report.summary.passed === report.summary.scenarios,
        isolatedRoot,
      );
    } else {
      const skipped = { durationMs: 0, passed: false, failure: "Not run because the workspace build failed" };
      offlineHarness = skipped;
      runtimePerformance = skipped;
    }
    const areas = evaluateAreas(focusedChecks, offlineHarness, runtimePerformance);
    const components = [
      ...focusedChecks.map((report) => report.passed),
      build.passed,
      offlineHarness.passed,
      runtimePerformance.passed,
    ];
    const passedAreas = areas.filter((area) => area.passed).length;
    const passedComponents = components.filter(Boolean).length;
    return {
      schemaVersion: 1,
      suite: "offline-release-v1",
      purpose: "credential-free-release-regression-gate",
      deterministic: true,
      environment: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        credentialSources: "isolated",
        externalNetwork: "blocked",
        loopbackFixtures: true,
        runtimePerformanceSamples: 1,
      },
      build,
      focusedChecks,
      offlineHarness,
      runtimePerformance,
      areas,
      summary: {
        areas: areas.length,
        passedAreas,
        components: components.length,
        passedComponents,
        passed: passedAreas === areas.length && passedComponents === components.length,
      },
    };
  } finally {
    replaceEnvironment(previousEnvironment as Record<string, string>);
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const report = await runOfflineReleaseEvaluation((message) => {
    process.stderr.write(`[offline release eval] ${message}\n`);
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.summary.passed) process.exitCode = 1;
}

const invoked = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) await main();
