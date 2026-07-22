import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseComparativeLiveConfig,
  parseRigynJsonlMetrics,
  runComparativeLiveBenchmark,
} from "../../benchmarks/compare-live.js";

test("comparative live runner applies one task contract to both configured harnesses", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-compare-test-"));
  try {
    const agent = join(root, "agent.mjs");
    const verify = join(root, "verify.mjs");
    await writeFile(agent, `
      import { writeSync } from "node:fs";
      import { writeFile } from "node:fs/promises";
      const [artifact, prompt, provider, model, format] = process.argv.slice(2);
      await writeFile(artifact, JSON.stringify({ prompt, provider, model }));
      const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 3, cacheWriteTokens: 0, reasoningTokens: 0, cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
      if (format === "rigyn") {
        const events = [
          { type: "assistant_started", step: 1 },
          { type: "usage", usage, semantics: "final" },
          { type: "run_completed", finishReason: "stop" },
        ];
        writeSync(1, events.map((event) => JSON.stringify({ threadId: "test", event })).join("\\n") + "\\n");
      } else {
        writeSync(1, JSON.stringify({ completed: true, steps: 1, toolErrors: 0, usage: { ...usage, costUsd: String(usage.cost.total) } }) + "\\n");
      }
    `);
    await writeFile(verify, `
      import { readFile } from "node:fs/promises";
      const value = JSON.parse(await readFile(process.argv[2], "utf8"));
      if (value.prompt !== "private benchmark prompt" || value.provider !== "fixture-provider" || value.model !== "fixture-model") process.exitCode = 1;
    `);
    const report = await runComparativeLiveBenchmark({
      schemaVersion: 1,
      provider: "fixture-provider",
      model: "fixture-model",
      samples: 1,
      timeoutMs: 10_000,
      harnesses: [
        {
          id: "first",
          argv: [process.execPath, agent, "{workspace}/artifact.json", "{prompt}", "{provider}", "{model}", "rigyn"],
          metrics: "rigyn-jsonl",
        },
        {
          id: "second",
          argv: [process.execPath, agent, "{workspace}/artifact.json", "{prompt}", "{provider}", "{model}", "summary"],
          metrics: "json-summary",
        },
      ],
      tasks: [{
        id: "same-task",
        prompt: "private benchmark prompt",
        files: {},
        verifier: { argv: [process.execPath, verify, "{workspace}/artifact.json"] },
      }],
    });
    assert.equal(report.runs.length, 2);
    assert.equal(report.runs.every((run) => run.metrics.passed), true);
    assert.deepEqual(report.runs.map((run) => ({
      harness: run.harnessId,
      steps: run.metrics.steps,
      errors: run.metrics.toolErrors,
      total: run.metrics.usage.totalTokens,
      cache: run.metrics.usage.cacheReadTokens,
      cost: run.metrics.usage.costUsd,
    })), [
      { harness: "first", steps: 1, errors: 0, total: 12, cache: 3, cost: "0.01" },
      { harness: "second", steps: 1, errors: 0, total: 12, cache: 3, cost: "0.01" },
    ]);
    assert.doesNotMatch(JSON.stringify(report), /private benchmark prompt/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("comparison configuration enforces shared provider, model, and prompt placeholders", () => {
  assert.throws(() => parseComparativeLiveConfig({
    schemaVersion: 1,
    provider: "provider",
    model: "model",
    samples: 1,
    timeoutMs: 10_000,
    harnesses: [
      { id: "first", argv: ["first", "{prompt}", "{provider}", "{model}"], metrics: "none" },
      { id: "second", argv: ["second", "{prompt}", "{provider}"], metrics: "none" },
    ],
    tasks: [{ id: "task", prompt: "prompt", files: {}, verifier: { argv: ["verify"] } }],
  }), /\{model\}/u);
});

test("comparison configuration keeps task and harness identifiers inside the temporary root", () => {
  const configuration = (harnessId: string, taskId: string) => ({
    schemaVersion: 1,
    provider: "provider",
    model: "model",
    samples: 1,
    timeoutMs: 10_000,
    harnesses: [
      { id: harnessId, argv: ["first", "{prompt}", "{provider}", "{model}"], metrics: "none" },
      { id: "second", argv: ["second", "{prompt}", "{provider}", "{model}"], metrics: "none" },
    ],
    tasks: [{ id: taskId, prompt: "prompt", files: {}, verifier: { argv: ["verify"] } }],
  });

  assert.throws(() => parseComparativeLiveConfig(configuration("../outside", "task")), /harnesses\[0\]\.id/u);
  assert.throws(() => parseComparativeLiveConfig(configuration("first", "..\\outside")), /tasks\[0\]\.id/u);
  assert.throws(() => parseComparativeLiveConfig(configuration("first/child", "task")), /harnesses\[0\]\.id/u);
  assert.equal(parseComparativeLiveConfig(configuration("first.v2", "task_1-fix")).tasks[0]?.id, "task_1-fix");
});

test("rigyn JSONL metrics preserve final usage without double counting", () => {
  const line = (event: object) => JSON.stringify({ threadId: "thread", event });
  const metrics = parseRigynJsonlMetrics([
    line({ type: "assistant_started", step: 1 }),
    line({ type: "usage", semantics: "cumulative", usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } }),
    line({ type: "usage", semantics: "final", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }),
    line({ type: "assistant_started", step: 2 }),
    line({ type: "usage", semantics: "incremental", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } }),
    line({ type: "tool_completed", callId: "call", name: "bash", index: 0, isError: true, preview: "failed" }),
    line({ type: "run_completed", finishReason: "stop" }),
  ].join("\n"));
  assert.equal(metrics.completion, true);
  assert.equal(metrics.steps, 2);
  assert.equal(metrics.toolErrors, 1);
  assert.equal(metrics.usage.totalTokens, 16);
});

test("comparative report schema is closed and versioned", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../../benchmarks/comparative-live-report.schema.json", import.meta.url),
    "utf8",
  )) as { additionalProperties?: boolean; properties?: { schemaVersion?: { const?: number } } };
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties?.schemaVersion?.const, 1);
});
