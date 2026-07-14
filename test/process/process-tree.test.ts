import assert from "node:assert/strict";
import test from "node:test";

import { processTreeTerminationPlan, terminateProcessTree } from "../../src/process/process-tree.js";
import { runProcess } from "../../src/process/runner.js";

test("Windows process-tree termination uses the absolute SystemRoot taskkill /T /F command", () => {
  assert.deepEqual(processTreeTerminationPlan(4321, "SIGTERM", "win32", { SystemRoot: "C:\\Windows" }), {
    kind: "taskkill",
    command: "C:\\Windows\\System32\\taskkill.exe",
    args: ["/PID", "4321", "/T", "/F"],
    fallbackPid: 4321,
    fallbackSignal: "SIGTERM",
  });
});

test("Windows taskkill execution is injectable and falls back to the direct child on failure", () => {
  const calls: unknown[][] = [];
  const killed: unknown[][] = [];
  assert.equal(terminateProcessTree(7654, "SIGKILL", {
    platform: "win32",
    environment: { WINDIR: "D:\\Windows" },
    spawnSync(command, args, options) {
      calls.push([command, [...args], options]);
      return { status: 1 };
    },
    kill(pid, signal) { killed.push([pid, signal]); },
  }), true);
  assert.deepEqual(calls, [[
    "D:\\Windows\\System32\\taskkill.exe",
    ["/PID", "7654", "/T", "/F"],
    { shell: false, stdio: "ignore", timeout: 2_000, windowsHide: true },
  ]]);
  assert.deepEqual(killed, [[7654, "SIGKILL"]]);
});

test("POSIX process-tree termination targets the detached process group with the requested signal", () => {
  const killed: unknown[][] = [];
  assert.equal(terminateProcessTree(2468, "SIGTERM", {
    platform: "linux",
    kill(pid, signal) { killed.push([pid, signal]); },
  }), true);
  assert.deepEqual(killed, [[-2468, "SIGTERM"]]);
});

test("bounded process execution tolerates a child closing stdin before a pending write drains across platforms", async () => {
  const result = await runProcess({
    argv: [process.execPath, "--eval", "process.exit(0)"],
    cwd: process.cwd(),
    stdin: "x".repeat(1024 * 1024),
    timeoutMs: 5_000,
    outputLimitBytes: 1024,
  }, new AbortController().signal);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
});
