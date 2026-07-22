#!/usr/bin/env node

import { runAiCli } from "./cli/main.js";

const controller = new AbortController();
const cancel = (): void => controller.abort();

process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  process.exitCode = await runAiCli({ signal: controller.signal, onCancel: cancel });
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
