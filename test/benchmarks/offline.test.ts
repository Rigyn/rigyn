import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runOfflineBenchmark } from "../../benchmarks/offline.js";

test("offline benchmark records real task outcomes and safety probes deterministically", async () => {
  const report = await runOfflineBenchmark();

  assert.deepEqual(report.tasks.map((task) => ({
    id: task.id,
    checks: task.checks,
    completed: task.completed,
    passed: task.passed,
    runAttempts: task.runAttempts,
    harnessRuns: task.harnessRuns,
    providerAttempts: task.providerAttempts,
    providerRetries: task.providerRetries,
    steps: task.steps,
    toolCalls: task.toolCalls,
    toolCallErrors: task.toolCallErrors,
    parallelToolBatches: task.parallelToolBatches,
  })), [
    {
      id: "create-file-after-transport-retry",
      checks: ["transport-retry", "file-creation"],
      completed: true,
      passed: true,
      runAttempts: 1,
      harnessRuns: 1,
      providerAttempts: 3,
      providerRetries: 1,
      steps: 2,
      toolCalls: 1,
      toolCallErrors: 0,
      parallelToolBatches: 0,
    },
    {
      id: "repair-code-after-tool-error",
      checks: ["tool-error-recovery", "model-visible-tool-recovery", "verification"],
      completed: true,
      passed: true,
      runAttempts: 1,
      harnessRuns: 1,
      providerAttempts: 4,
      providerRetries: 0,
      steps: 4,
      toolCalls: 3,
      toolCallErrors: 1,
      parallelToolBatches: 0,
    },
    {
      id: "parallel-multi-file-change",
      checks: ["multi-file-work", "parallel-tool-batch", "mutation-preservation", "verification"],
      completed: true,
      passed: true,
      runAttempts: 1,
      harnessRuns: 1,
      providerAttempts: 3,
      providerRetries: 0,
      steps: 3,
      toolCalls: 3,
      toolCallErrors: 0,
      parallelToolBatches: 1,
    },
    {
      id: "recover-from-unknown-tool",
      checks: ["unknown-tool-recovery", "model-visible-tool-recovery", "file-creation"],
      completed: true,
      passed: true,
      runAttempts: 1,
      harnessRuns: 1,
      providerAttempts: 3,
      providerRetries: 0,
      steps: 3,
      toolCalls: 2,
      toolCallErrors: 1,
      parallelToolBatches: 0,
    },
    {
      id: "continue-existing-session",
      checks: ["session-continuation"],
      completed: true,
      passed: true,
      runAttempts: 1,
      harnessRuns: 2,
      providerAttempts: 4,
      providerRetries: 0,
      steps: 4,
      toolCalls: 2,
      toolCallErrors: 0,
      parallelToolBatches: 0,
    },
  ]);
  assert.equal(report.purpose, "harness-plumbing");
  assert.deepEqual(report.probes, {
    compaction: { passed: true, completed: 1, sourceMessages: 4 },
    crashRecovery: {
      passed: true,
      recoveredRuns: 1,
      repairedToolCalls: 1,
      inDoubtToolCalls: 1,
      reconstructedToolCalls: 0,
    },
  });
  assert.deepEqual(report.summary, {
    taskCount: 5,
    completed: 5,
    passed: 5,
    completionRate: 1,
    passAt1: 1,
    runAttempts: 5,
    harnessRuns: 6,
    providerAttempts: 17,
    providerRetries: 1,
    toolCalls: 11,
    toolCallErrors: 2,
    parallelToolBatches: 1,
    compactions: 0,
    toolCallsInDoubt: 0,
    usage: {
      inputTokens: 431,
      outputTokens: 76,
      totalTokens: 507,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: "0.0221",
    },
  });
});

test("benchmark report schema is versioned and closes unknown top-level fields", async () => {
  const schema = JSON.parse(await readFile(new URL("../../benchmarks/report.schema.json", import.meta.url), "utf8")) as {
    properties?: { schemaVersion?: { const?: number } };
    additionalProperties?: boolean;
    required?: string[];
  };
  assert.equal(schema.properties?.schemaVersion?.const, 2);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["schemaVersion", "suite", "purpose", "deterministic", "tasks", "probes", "summary"]);
});
