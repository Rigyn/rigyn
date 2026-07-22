#!/usr/bin/env node
import { writeFileSync } from "node:fs";

import { main } from "../cli/main.js";
import { defaultSecretRedactor } from "../auth/redaction.js";
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
  enterHarnessProcess();
  const runtimeLease = await acquireRuntimeLease();
  try {
    await main();
  } finally {
    await runtimeLease?.release();
  }
} catch (error) {
  const message = defaultSecretRedactor.redact(error instanceof Error ? error.message : String(error));
  writeFileSync(2, `rigyn: ${message}\n`);
  process.exitCode = error instanceof Error && "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1;
}
