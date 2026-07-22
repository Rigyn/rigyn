import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  evaluateRiskCoverage,
  formatRiskCoverageFailure,
  parseRiskCoverageConfig,
  parseV8Coverage,
  selectRiskCoverageTests,
  validateRiskCoverageTargets,
} from "../../benchmarks/risk-coverage.js";

test("risk coverage failure diagnostics preserve early failures and process metadata", () => {
  const trailingOutput = "✓ later passing test\n".repeat(1_000);
  const stderr = Buffer.from(`✗ original failure marker\n${trailingOutput}`, "utf8");
  assert.ok(stderr.length > 16 * 1024);
  const formatted = formatRiskCoverageFailure("service-storage", {
    exitCode: 1,
    signal: "SIGTERM",
    stdout: Buffer.from("coverage worker output\n", "utf8"),
    stderr,
    stdoutBytes: 23,
    stderrBytes: stderr.length + 512,
    timedOut: false,
    cancelled: false,
  });
  assert.match(formatted.diagnostic, /original failure marker/u);
  assert.match(formatted.diagnostic, /later passing test/u);
  assert.match(formatted.message, /exitCode=1, signal=SIGTERM/u);
  assert.match(formatted.message, /stdout=23\/23 retained\/observed bytes/u);
  assert.match(formatted.message, new RegExp(`stderr=${stderr.length}/${stderr.length + 512} retained/observed bytes`, "u"));
});

test("risk coverage evaluates each configured module independently", () => {
  const parsed = parseV8Coverage(JSON.stringify({
    type: "v8",
    files: [{
      sourcePath: "src/extensions/runtime.ts",
      summary: {
        lines: { total: 100, covered: 95, pct: 95 },
        branches: { total: 20, covered: 16, pct: 80 },
        functions: { total: 10, covered: 9, pct: 90 },
      },
    }],
  }), process.cwd());
  const [result] = evaluateRiskCoverage({
    schemaVersion: 1,
    excludedTests: ["test/live/"],
    targets: [{ file: "src/extensions/runtime.ts", minimum: { lines: 90, branches: 85, functions: 90 } }],
    groups: [{
      id: "extension-runtime",
      targets: ["src/extensions/runtime.ts"],
      testPrefixes: ["test/extensions/"],
      testExcludes: [],
    }],
  }, parsed);
  assert.deepEqual(result, {
    file: "src/extensions/runtime.ts",
    actual: { lines: 95, branches: 80, functions: 90 },
    minimum: { lines: 90, branches: 85, functions: 90 },
    passed: false,
    failures: ["branches"],
  });
});

test("risk coverage configuration targets only the five high-risk modules", async () => {
  const config = JSON.parse(await readFile(
    new URL("../../benchmarks/risk-coverage.config.json", import.meta.url),
    "utf8",
  )) as {
    excludedTests?: string[];
    targets?: Array<{ file?: string; minimum?: { lines?: number; branches?: number; functions?: number } }>;
    groups?: Array<{ id?: string; targets?: string[]; testPrefixes?: string[]; testExcludes?: string[] }>;
  };
  assert.deepEqual(config.excludedTests, ["test/live/"]);
  assert.deepEqual(config.targets, [
    { file: "src/extensions/runtime.ts", minimum: { lines: 90, branches: 68, functions: 90 } },
    { file: "src/cli/main.ts", minimum: { lines: 84, branches: 68, functions: 74 } },
    { file: "src/tui/controller.ts", minimum: { lines: 91, branches: 78, functions: 85 } },
    { file: "src/service/agent-session.ts", minimum: { lines: 94, branches: 85, functions: 90 } },
    { file: "src/storage/session-manager.ts", minimum: { lines: 97, branches: 88, functions: 97 } },
  ]);
  assert.deepEqual(config.groups, [
    {
      id: "extension-runtime",
      targets: ["src/extensions/runtime.ts"],
      testPrefixes: ["test/extensions/", "test/cli/", "test/service/", "test/storage/"],
      testExcludes: [],
    },
    {
      id: "cli-tui",
      targets: ["src/cli/main.ts", "src/tui/controller.ts"],
      testPrefixes: ["test/cli/", "test/tui/"],
      testExcludes: [],
    },
    {
      id: "service-storage",
      targets: ["src/service/agent-session.ts", "src/storage/session-manager.ts"],
      testPrefixes: ["test/storage/", "test/service/", "test/cli/", "test/core/", "test/extensions/", "test/tools/"],
      testExcludes: [],
    },
  ]);
});

test("risk coverage groups use prefixes and exact exclusions", () => {
  const selected = selectRiskCoverageTests([
    "test/extensions/runtime.test.ts",
    "test/extensions/managed-package-host-imports.test.ts",
    "test/extensions/managed-package-host-imports.test.ts.backup.test.ts",
    "test/service/harness.test.ts",
  ], {
    id: "extension-runtime",
    targets: ["src/extensions/runtime.ts"],
    testPrefixes: ["test/extensions/"],
    testExcludes: ["test/extensions/managed-package-host-imports.test.ts"],
  });
  assert.deepEqual(selected, [
    "test/extensions/runtime.test.ts",
    "test/extensions/managed-package-host-imports.test.ts.backup.test.ts",
  ]);
});

test("risk coverage config rejects traversal and incomplete target ownership", () => {
  const base = {
    schemaVersion: 1,
    excludedTests: ["test/live/"],
    targets: [
      { file: "src/extensions/runtime.ts", minimum: { lines: 90, branches: 68, functions: 90 } },
      { file: "src/cli/main.ts", minimum: { lines: 84, branches: 68, functions: 74 } },
    ],
    groups: [{
      id: "runtime",
      targets: ["src/extensions/runtime.ts"],
      testPrefixes: ["test/extensions/"],
      testExcludes: [],
    }],
  };
  assert.throws(() => parseRiskCoverageConfig(base), /exactly one group/u);
  assert.throws(() => parseRiskCoverageConfig({
    ...base,
    targets: base.targets.slice(0, 1),
    groups: [{ ...base.groups[0], testPrefixes: ["test/../extensions/"] }],
  }), /testPrefixes are invalid/u);
});

test("risk coverage preflight rejects stale and non-file source targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-risk-targets-"));
  const config = parseRiskCoverageConfig({
    schemaVersion: 1,
    excludedTests: ["test/live/"],
    targets: [
      { file: "src/current.ts", minimum: { lines: 90, branches: 80, functions: 90 } },
      { file: "src/stale.ts", minimum: { lines: 90, branches: 80, functions: 90 } },
    ],
    groups: [{
      id: "runtime",
      targets: ["src/current.ts", "src/stale.ts"],
      testPrefixes: ["test/extensions/"],
      testExcludes: [],
    }],
  });
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/current.ts"), "export {};\n", "utf8");
    await assert.rejects(
      validateRiskCoverageTargets(config, root),
      /Risk coverage target src\/stale\.ts is missing or unreadable; update benchmarks\/risk-coverage\.config\.json/u,
    );
    await mkdir(join(root, "src/stale.ts"));
    await assert.rejects(
      validateRiskCoverageTargets(config, root),
      /Risk coverage target src\/stale\.ts is not a regular file; update benchmarks\/risk-coverage\.config\.json/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
