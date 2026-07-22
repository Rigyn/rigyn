#!/usr/bin/env node
import { writeFileSync } from "node:fs";

import { defaultSecretRedactor } from "./auth/redaction.js";
import { main } from "./cli/main.js";

process.title = "rigyn-rpc";

try {
  await main(["--mode", "rpc", ...process.argv.slice(2)]);
} catch (error) {
  const message = defaultSecretRedactor.redact(error instanceof Error ? error.message : String(error));
  writeFileSync(2, `rigyn-rpc: ${message}\n`);
  process.exitCode = error instanceof Error && "exitCode" in error && typeof error.exitCode === "number"
    ? error.exitCode
    : 1;
}
