import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runExtensionAuthoringBenchmark } from "../../benchmarks/extension-authoring.js";

test("offline extension-authoring benchmark reports verifier pass@1 and pass@3", async () => {
  const report = await runExtensionAuthoringBenchmark();
  assert.equal(report.modelCalls, 0);
  assert.deepEqual(report.tasks.map((task) => ({
    id: task.id,
    passed: task.passed,
    passedAt: task.passedAt,
    stages: task.attempts.map((attempt) => attempt.stage),
  })), [
    { id: "command-package", passed: true, passedAt: 1, stages: ["complete"] },
    { id: "tool-package-after-invalid-attempt", passed: true, passedAt: 2, stages: ["install", "complete"] },
    { id: "multi-resource-package", passed: true, passedAt: 1, stages: ["complete"] },
  ]);
  assert.deepEqual(report.summary, {
    taskCount: 3,
    passed: 3,
    passAt1: 2 / 3,
    passAt3: 1,
    attempts: 4,
  });
  assert.doesNotMatch(JSON.stringify(report), /\.rigyn-package-stage-[A-Za-z0-9]/u);
});

test("extension-authoring report schema is closed and versioned", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../../benchmarks/extension-authoring-report.schema.json", import.meta.url),
    "utf8",
  )) as { additionalProperties?: boolean; properties?: { schemaVersion?: { const?: number }; maxAttempts?: { const?: number } } };
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties?.schemaVersion?.const, 1);
  assert.equal(schema.properties?.maxAttempts?.const, 3);
});
