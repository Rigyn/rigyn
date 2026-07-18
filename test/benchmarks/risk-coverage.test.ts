import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evaluateRiskCoverage,
  parseRiskCoverageConfig,
  parseV8Coverage,
  selectRiskCoverageTests,
} from "../../benchmarks/risk-coverage.js";

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
    targets?: Array<{ file?: string }>;
    groups?: Array<{ id?: string; targets?: string[]; testPrefixes?: string[]; testExcludes?: string[] }>;
  };
  assert.deepEqual(config.excludedTests, ["test/live/"]);
  assert.deepEqual(config.targets?.map((target) => target.file), [
    "src/extensions/runtime.ts",
    "src/cli/main.ts",
    "src/tui/controller.ts",
    "src/service/harness.ts",
    "src/storage/store.ts",
  ]);
  assert.deepEqual(config.groups, [
    {
      id: "extension-runtime",
      targets: ["src/extensions/runtime.ts"],
      testPrefixes: ["test/extensions/", "test/cli/", "test/service/", "test/storage/"],
      testExcludes: ["test/extensions/managed-package-host-imports.test.ts"],
    },
    {
      id: "cli-tui",
      targets: ["src/cli/main.ts", "src/tui/controller.ts"],
      testPrefixes: ["test/cli/", "test/tui/"],
      testExcludes: [],
    },
    {
      id: "service-storage",
      targets: ["src/service/harness.ts", "src/storage/store.ts"],
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
