import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createLocalStatsReport } from "../../src/cli/stats-command.js";
import type { ObservabilityFields, ObservabilityRecord } from "../../src/core/observability.js";

const defaults: ObservabilityFields = {
  runs_started: 0,
  provider_attempts: 0,
  provider_retries: 0,
  compactions_started: 0,
  compactions_failed: 0,
  tools_failed: 0,
  provider_duration_ms: 0,
};

function snapshot(
  processInstance: string,
  timestamp: string,
  fields: ObservabilityFields,
): ObservabilityRecord {
  return {
    schemaVersion: 1,
    kind: "metrics_snapshot",
    timestamp,
    processInstance,
    mode: "print",
    level: "info",
    area: "runtime",
    name: "metrics_snapshot",
    fields: { ...defaults, ...fields },
  };
}

function line(record: ObservabilityRecord): string {
  return `${JSON.stringify(record)}\n`;
}

async function fixture(context: test.TestContext, name: string) {
  const root = await mkdtemp(join(tmpdir(), `rigyn-stats-${name}-`));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const agentDirectory = join(root, ".rigyn");
  const logs = join(agentDirectory, "logs");
  await mkdir(logs, { recursive: true });
  return {
    agentDirectory,
    logs,
    environment: { ...process.env, RIGYN_HOME: agentDirectory } satisfies NodeJS.ProcessEnv,
  };
}

test("stats sums only the latest aggregate snapshot per process and never emits record content", async (context) => {
  const value = await fixture(context, "aggregate");
  const observed = {
    input_tokens_observed: true,
    input_tokens_complete: true,
    output_tokens_observed: true,
    output_tokens_complete: true,
    total_tokens_observed: true,
    total_tokens_complete: true,
    cache_telemetry_observed: true,
    cache_read_tokens_observed: true,
    cache_write_tokens_observed: true,
    cache_read_tokens_complete: true,
    cache_write_tokens_complete: true,
    cost_observed: true,
    cost_complete: true,
    provider_duration_observed: true,
  } as const;
  const processA = "0123456789abcdef";
  const processB = "fedcba9876543210";
  await writeFile(
    join(value.logs, "rigyn-20260808T120000-1-abcdef123456-000.jsonl"),
    line(snapshot(processA, "2026-08-08T12:01:00.000Z", {
      runs_started: 1,
      provider_attempts: 1,
      input_tokens: 999,
      output_tokens: 0,
      total_tokens: 999,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_total: 0,
      ...observed,
    })),
  );
  await writeFile(
    join(value.logs, "rigyn-20260808T120100-1-abcdef123456-001.jsonl"),
    [
      JSON.stringify({
        schemaVersion: 1,
        kind: "event",
        timestamp: "2026-08-08T12:01:00.000Z",
        processInstance: processA,
        mode: "print",
        level: "error",
        area: "runtime",
        name: "run_failed",
        fields: { error_message: "PRIVATE_RECORD_CONTENT_SENTINEL" },
      }),
      '{"kind":"metrics_snapshot"',
      JSON.stringify(snapshot(processA, "2026-08-08T12:01:00.000Z", {
        runs_started: 2,
        provider_attempts: 3,
        provider_retries: 1,
        compactions_started: 1,
        tools_failed: 2,
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 220,
        cache_read_tokens: 60,
        cache_write_tokens: 40,
        cost_total: 0.15,
        provider_duration_ms: 3_000,
        ...observed,
      })),
      "",
    ].join("\n"),
  );
  await writeFile(
    join(value.logs, "rigyn-20260808T120200-2-fedcba654321-000.jsonl"),
    line(snapshot(processB, "2026-08-08T12:02:00.000Z", {
      runs_started: 1,
      provider_attempts: 1,
      provider_retries: 2,
      compactions_started: 2,
      compactions_failed: 1,
      tools_failed: 1,
      input_tokens: 100,
      output_tokens: 30,
      total_tokens: 180,
      cache_read_tokens: 40,
      cache_write_tokens: 10,
      cost_total: 0.05,
      provider_duration_ms: 1_000,
      ...observed,
    })),
  );

  const report = await createLocalStatsReport(value.environment);
  assert.equal(report.runs, 3);
  assert.equal(report.requests, 4);
  assert.equal(report.retries, 3);
  assert.equal(report.compactions, 3);
  assert.equal(report.compactionFailures, 1);
  assert.equal(report.toolFailures, 3);
  assert.deepEqual(report.tokens, {
    input: 200,
    output: 50,
    total: 400,
    cacheRead: 100,
    cacheWrite: 50,
    cacheHitPercent: 28.57,
  });
  assert.equal(report.costUsd, 0.2);
  assert.equal(report.providerDurationMs, 4_000);
  assert.deepEqual(report.source, {
    filesFound: 3,
    filesRead: 3,
    filesSkipped: 0,
    processes: 2,
    recordsSkipped: 1,
    partial: true,
  });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_RECORD_CONTENT_SENTINEL/u);

  const human = spawnSync(process.execPath, [
    "--import", "tsx", resolve("src/bin/rigyn.ts"), "stats",
  ], {
    cwd: resolve("."),
    env: value.environment,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stderr, "");
  assert.match(human.stdout, /Main model attempts: 4/u);
  assert.match(human.stdout, /Cache hit: 28\.57% of prompt tokens/u);
  assert.match(human.stdout, /Source: 2 runtime-observer aggregates from 3\/3 files · partial/u);
  assert.doesNotMatch(human.stdout, /PRIVATE_RECORD_CONTENT_SENTINEL/u);

  const json = spawnSync(process.execPath, [
    "--import", "tsx", resolve("src/bin/rigyn.ts"), "stats", "--json",
  ], {
    cwd: resolve("."),
    env: value.environment,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(json.status, 0, json.stderr);
  assert.equal((JSON.parse(json.stdout) as { requests: number }).requests, 4);
  assert.doesNotMatch(json.stdout, /PRIVATE_RECORD_CONTENT_SENTINEL/u);
});

test("stats distinguishes explicitly reported zero values from missing telemetry", async (context) => {
  const explicit = await fixture(context, "zero");
  await writeFile(
    join(explicit.logs, "rigyn-20260808T120000-1-abcdef123456-000.jsonl"),
    line(snapshot("0123456789abcdef", "2026-08-08T12:00:00.000Z", {
      provider_attempts: 1,
      input_tokens: 0,
      input_tokens_observed: true,
      input_tokens_complete: true,
      output_tokens: 0,
      output_tokens_observed: true,
      output_tokens_complete: true,
      total_tokens: 0,
      total_tokens_observed: true,
      total_tokens_complete: true,
      cache_telemetry_observed: true,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cache_read_tokens_observed: true,
      cache_write_tokens_observed: true,
      cache_read_tokens_complete: true,
      cache_write_tokens_complete: true,
      cost_total: 0,
      cost_observed: true,
      cost_complete: true,
      provider_duration_observed: true,
    })),
  );
  const zero = await createLocalStatsReport(explicit.environment);
  assert.deepEqual(zero.tokens, { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(zero.costUsd, 0);
  assert.equal(zero.providerDurationMs, 0);

  const missing = await fixture(context, "missing");
  await writeFile(
    join(missing.logs, "rigyn-20260808T120000-1-abcdef123456-000.jsonl"),
    line(snapshot("0123456789abcdef", "2026-08-08T12:00:00.000Z", {
      provider_attempts: 1,
    })),
  );
  const unavailable = await createLocalStatsReport(missing.environment);
  assert.equal(unavailable.tokens, undefined);
  assert.equal(unavailable.costUsd, undefined);
  assert.equal(unavailable.providerDurationMs, undefined);
});

test("stats labels partial cache totals as reported and keeps the other counter exact", async (context) => {
  const value = await fixture(context, "partial-cache");
  await writeFile(
    join(value.logs, "rigyn-20260808T120000-1-abcdef123456-000.jsonl"),
    line(snapshot("0123456789abcdef", "2026-08-08T12:00:00.000Z", {
      provider_attempts: 2,
      input_tokens: 18,
      input_tokens_observed: true,
      input_tokens_complete: true,
      total_tokens_complete: false,
      cache_telemetry_observed: true,
      cache_read_tokens_reported: 5,
      cache_read_tokens_observed: true,
      cache_read_tokens_complete: false,
      cache_write_tokens: 2,
      cache_write_tokens_observed: true,
      cache_write_tokens_complete: true,
    })),
  );

  const report = await createLocalStatsReport(value.environment);
  assert.deepEqual(report.tokens, { input: 18, cacheReadReported: 5, cacheWrite: 2 });
});

test("stats exposes incomplete input, total, and cost only as reported partials", async (context) => {
  const value = await fixture(context, "partial-usage");
  await writeFile(
    join(value.logs, "rigyn-20260808T120000-1-abcdef123456-000.jsonl"),
    line(snapshot("0123456789abcdef", "2026-08-08T12:00:00.000Z", {
      provider_attempts: 2,
      input_tokens_reported: 18,
      input_tokens_observed: true,
      input_tokens_complete: false,
      output_tokens: 2,
      output_tokens_observed: true,
      output_tokens_complete: true,
      total_tokens_reported: 20,
      total_tokens_observed: true,
      total_tokens_complete: false,
      cache_read_tokens_complete: false,
      cache_write_tokens_complete: false,
      cost_total_reported: 0.25,
      cost_observed: true,
      cost_complete: false,
    })),
  );

  const report = await createLocalStatsReport(value.environment);
  assert.deepEqual(report.tokens, { inputReported: 18, output: 2, totalReported: 20 });
  assert.equal(report.costUsd, undefined);
  assert.equal(report.costUsdReported, 0.25);
});

test("failed attempts without usage do not invalidate another process's exact telemetry", async (context) => {
  const value = await fixture(context, "failed-attempt-no-usage");
  await writeFile(
    join(value.logs, "rigyn-20260808T120000-1-abcdef123456-000.jsonl"),
    line(snapshot("0123456789abcdef", "2026-08-08T12:00:00.000Z", {
      provider_attempts: 1,
      usage_scopes: 1,
      input_tokens: 4,
      input_tokens_observed: true,
      input_tokens_complete: true,
      output_tokens: 1,
      output_tokens_observed: true,
      output_tokens_complete: true,
      total_tokens: 5,
      total_tokens_observed: true,
      total_tokens_complete: true,
      cache_read_tokens: 0,
      cache_read_tokens_observed: true,
      cache_read_tokens_complete: true,
      cache_write_tokens: 0,
      cache_write_tokens_observed: true,
      cache_write_tokens_complete: true,
      cost_total: 0,
      cost_observed: true,
      cost_complete: true,
    })),
  );
  await writeFile(
    join(value.logs, "rigyn-20260808T120100-2-fedcba654321-000.jsonl"),
    line(snapshot("fedcba9876543210", "2026-08-08T12:01:00.000Z", {
      provider_attempts: 1,
      usage_scopes: 0,
    })),
  );

  const report = await createLocalStatsReport(value.environment);
  assert.deepEqual(report.tokens, {
    input: 4,
    output: 1,
    total: 5,
    cacheRead: 0,
    cacheWrite: 0,
    cacheHitPercent: 0,
  });
  assert.equal(report.costUsd, 0);
});

test("stats remains useful without logs and marks bounded file coverage as partial", async (context) => {
  const empty = await fixture(context, "empty");
  const noData = await createLocalStatsReport(empty.environment);
  assert.equal(noData.runs, 0);
  assert.equal(noData.requests, 0);
  assert.equal(noData.source.partial, false);

  for (let index = 0; index < 129; index += 1) {
    const stamp = String(index).padStart(12, "0");
    await writeFile(
      join(empty.logs, `rigyn-20260808T120000-${index + 1}-${stamp}-000.jsonl`),
      line(snapshot(index.toString(16).padStart(16, "0"), "2026-08-08T12:00:00.000Z", {
        runs_started: 1,
      })),
    );
  }
  const bounded = await createLocalStatsReport(empty.environment);
  assert.equal(bounded.source.filesFound, 129);
  assert.equal(bounded.source.filesRead, 128);
  assert.equal(bounded.source.filesSkipped, 1);
  assert.equal(bounded.source.partial, true);
  assert.equal(bounded.runs, 128);
});
