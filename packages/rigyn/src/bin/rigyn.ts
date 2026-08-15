#!/usr/bin/env node
import { writeFileSync } from "node:fs";

import { caughtProcessFailure, isStructuredOutputFailure, main } from "../cli/main.js";
import { markActiveHarness } from "../process/harness-environment.js";
import { getCrashDir } from "../config/paths.js";
import { boundedRedactedFailureText, installLocalCrashReporter } from "../core/local-crash-reporter.js";
import { flushRawStdout, restoreStdout, takeOverStdout } from "../interfaces/output-guard.js";
import { resolveCliInvocationMode } from "../cli/invocation-mode.js";
import { acquireRuntimeLease } from "./runtime-lease.js";

const RECURSION_DEPTH_ENV = "RIGYN_RECURSION_DEPTH";
const MAX_RECURSION_DEPTH = 4;

function enterHarnessProcess(): void {
  const raw = process.env[RECURSION_DEPTH_ENV];
  const depth = raw === undefined ? 0 : Number(raw);
  if (!Number.isSafeInteger(depth) || depth < 0) {
    throw new Error(`${RECURSION_DEPTH_ENV} must be a non-negative integer`);
  }
  if (depth >= MAX_RECURSION_DEPTH) {
    throw new Error(`Refusing recursive rigyn launch at depth ${depth + 1}; check the requested CLI subcommand or child-agent workflow`);
  }
  process.env[RECURSION_DEPTH_ENV] = String(depth + 1);
}

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
  });
}

try {
  markActiveHarness();
  enterHarnessProcess();
  const invocation = process.argv.slice(2);
  const crashMode = resolveCliInvocationMode(invocation, {
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
  });
  const structuredOutput = crashMode === "json" || crashMode === "rpc";
  const versionOnly = invocation.length === 1 && (invocation[0] === "--version" || invocation[0] === "-v");
  const metadataOnly = versionOnly || invocation[0] === "completions";
  if (structuredOutput) takeOverStdout();
  try {
    const crashReporter = metadataOnly
      ? { report(): void {}, close(): void {} }
      : await installLocalCrashReporter(getCrashDir(), crashMode);
    const runtimeLease = metadataOnly ? undefined : await acquireRuntimeLease();
    try {
      try { await main(); }
      catch (error) {
        if (!isStructuredOutputFailure(error)) crashReporter.report(error, "topLevel");
        throw error;
      }
    } finally {
      crashReporter.close();
      await runtimeLease?.release();
    }
  } finally {
    if (structuredOutput) {
      try { await flushRawStdout(); }
      finally { restoreStdout(); }
    }
  }
} catch (error) {
  const failure = caughtProcessFailure(error);
  if (!isStructuredOutputFailure(error)) {
    const message = boundedRedactedFailureText(failure.message);
    writeFileSync(2, `rigyn: ${message}\n`);
  }
  process.exitCode = failure.exitCode;
}
