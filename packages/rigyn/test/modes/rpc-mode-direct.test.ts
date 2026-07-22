import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("public RPC mode owns an existing runtime and serves strict JSONL until stdin closes", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/rpc-mode-host.mts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", fixture], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, RIGYN_OFFLINE: "1" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`RPC fixture timed out: ${stderr}`));
    }, 10_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.deepEqual(result, { code: 0, signal: null });
  const records = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(records, [{
    id: "state",
    type: "response",
    command: "get_state",
    success: true,
    data: {
      thinkingLevel: "off",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "all",
      sessionId: "rpc-fixture",
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    },
  }]);
});
