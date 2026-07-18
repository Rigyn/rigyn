import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runRuntimePerformanceBenchmark } from "../../benchmarks/runtime-performance.js";

test("runtime performance benchmark covers startup, reload, resume, and paged RPC replay fixtures", async () => {
  const report = await runRuntimePerformanceBenchmark({ samples: 1 });
  assert.equal(report.deterministicFixtures, true);
  assert.deepEqual(report.scenarios.map((scenario) => ({
    id: scenario.id,
    fixture: scenario.fixture,
    samples: scenario.samplesMs.length,
    passed: scenario.passed,
  })), [
    { id: "startup-0-extensions", fixture: { extensionCount: 0 }, samples: 1, passed: true },
    { id: "startup-10-extensions", fixture: { extensionCount: 10 }, samples: 1, passed: true },
    { id: "startup-50-extensions", fixture: { extensionCount: 50 }, samples: 1, passed: true },
    {
      id: "reload-large-package",
      fixture: { extensionCount: 1, runtimeEntryCount: 8, commandCount: 256 },
      samples: 1,
      passed: true,
    },
    {
      id: "cold-page-20000-single-branch",
      fixture: { eventCount: 20_000, pageLimit: 1, branchCount: 1, cold: true, materializedRowBudget: 16 },
      samples: 1,
      passed: true,
    },
    {
      id: "cold-page-16002-unrelated-branches",
      fixture: { eventCount: 16_002, pageLimit: 1, branchCount: 34, cold: true, materializedRowBudget: 16 },
      samples: 1,
      passed: true,
    },
    {
      id: "cold-page-10000-tool-progress",
      fixture: {
        eventCount: 10_000,
        pageLimit: 1,
        branchCount: 1,
        toolProgressCount: 10_000,
        cold: true,
        materializedRowBudget: 16,
      },
      samples: 1,
      passed: true,
    },
    { id: "resume-100-events", fixture: { eventCount: 100 }, samples: 1, passed: true },
    { id: "rpc-replay-100-events", fixture: { eventCount: 100, pageLimit: 16 }, samples: 1, passed: true },
    { id: "resume-10000-events", fixture: { eventCount: 10_000 }, samples: 1, passed: true },
    { id: "rpc-replay-10000-events", fixture: { eventCount: 10_000, pageLimit: 1 }, samples: 1, passed: true },
  ]);
  assert.equal(report.summary.passed, report.summary.scenarios);
});

test("runtime performance report schema is closed and versioned", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../../benchmarks/runtime-performance-report.schema.json", import.meta.url),
    "utf8",
  )) as { additionalProperties?: boolean; properties?: { schemaVersion?: { const?: number } } };
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties?.schemaVersion?.const, 1);
});
