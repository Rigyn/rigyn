import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("one termination signal forces a process out of cleanup that never settles", {
  skip: process.platform === "win32" ? "POSIX signal delivery is required" : false,
}, async (context) => {
  const moduleUrl = pathToFileURL(new URL("../../src/process/graceful-termination.ts", import.meta.url).pathname).href;
  const source = `
    import { withGracefulTermination } from ${JSON.stringify(moduleUrl)};
    await withGracefulTermination(async () => {
      setInterval(() => {}, 1000);
      process.stdout.write("ready\\n");
      await new Promise(() => {});
    }, { forceExitAfterMs: 50 });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not become ready")), 2_000);
    child.once("error", reject);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!chunk.includes("ready")) return;
      clearTimeout(timer);
      resolve();
    });
  });

  child.kill("SIGTERM");
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child remained alive after the cleanup deadline")), 2_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.deepEqual(result, { code: 143, signal: null });
});
