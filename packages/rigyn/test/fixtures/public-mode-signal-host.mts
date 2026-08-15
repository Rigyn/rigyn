import { writeFileSync } from "node:fs";

import { runPrintMode } from "../../src/modes/print-mode.js";
import { runRpcMode } from "../../src/modes/rpc-mode.js";

const mode = process.argv[2];
const readyPath = process.env["RIGYN_MODE_READY"];
const disposedPath = process.env["RIGYN_MODE_DISPOSED"];
if (readyPath === undefined || disposedPath === undefined) {
  throw new Error("Signal fixture paths are required");
}

const dispose = (): void => {
  writeFileSync(disposedPath, "disposed");
};

if (mode === "rpc") {
  const session = {
    async bindExtensions() {},
    subscribe() { return () => undefined; },
  };
  const runtime = {
    session,
    setBeforeSessionInvalidate() {},
    setRebindSession() {},
    async dispose() { dispose(); },
  };
  setTimeout(() => writeFileSync(readyPath, "ready"), 100);
  await runRpcMode(runtime as never);
} else if (mode === "print") {
  let finishPrompt: (() => void) | undefined;
  const keepAlive = setInterval(() => undefined, 1_000);
  process.once("SIGINT", () => {
    clearInterval(keepAlive);
    writeFileSync(readyPath, "handled-by-host");
    finishPrompt?.();
  });
  const session = {
    sessionManager: { getHeader: () => null },
    state: { messages: [] },
    suspendedRun: undefined,
    async bindExtensions() {},
    subscribe() { return () => undefined; },
    async prompt() {
      writeFileSync(readyPath, "ready");
      return await new Promise<void>((resolve) => {
        finishPrompt = resolve;
      });
    },
  };
  const runtime = {
    session,
    setBeforeSessionInvalidate() {},
    setRebindSession() {},
    async dispose() { dispose(); },
  };
  await runPrintMode(runtime as never, { mode: "text", initialMessage: "wait" });
} else {
  throw new Error(`Unknown public mode fixture: ${mode ?? ""}`);
}
