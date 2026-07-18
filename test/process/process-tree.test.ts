import assert from "node:assert/strict";
import test from "node:test";

import { processTreeTerminationPlan, terminateProcessTree } from "../../src/process/process-tree.js";
import { terminateTrackedProcessGroups } from "../../src/process/active-groups.js";
import { runProcess } from "../../src/process/runner.js";

function inheritedPipeParent(descendantSource: string): string {
  return [
    "const { spawn } = require('node:child_process')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })`,
    "child.once('message', () => process.exit(0))",
  ].join(";");
}

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

test("repeated cancellation leaves no live child processes or tracked groups", async () => {
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const controller = new AbortController();
    let childPid: number | undefined;
    const result = await runProcess({
      argv: [
        process.execPath,
        "--eval",
        "require('node:fs').writeFileSync(1, String(process.pid)); setInterval(() => {}, 1000)",
      ],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      outputLimitBytes: 1024,
      onOutput(stream, chunk) {
        if (stream !== "stdout" || childPid !== undefined) return;
        childPid = Number(Buffer.from(chunk).toString("utf8"));
        controller.abort(new Error(`cancel iteration ${iteration}`));
      },
    }, controller.signal);
    assert.equal(result.cancelled, true);
    assert.ok(childPid !== undefined && Number.isSafeInteger(childPid));
    assert.throws(
      () => process.kill(childPid!, 0),
      (error: unknown) => ["ESRCH", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? ""),
    );
  }
  assert.doesNotThrow(() => terminateTrackedProcessGroups());
});

test("bounded process execution drains active inherited pipes after the parent exits", async () => {
  const descendant = [
    "require('node:fs').writeSync(1, 'first\\n')",
    "process.send('ready')",
    "setTimeout(() => require('node:fs').writeSync(1, 'second\\n'), 80)",
    "setTimeout(() => require('node:fs').writeSync(2, 'third\\n'), 160)",
    "setTimeout(() => process.exit(0), 180)",
  ].join(";");
  const observed: string[] = [];
  const result = await runProcess({
    argv: [process.execPath, "--eval", inheritedPipeParent(descendant)],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    outputLimitBytes: 1024,
    onOutput(stream, chunk) {
      observed.push(`${stream}:${Buffer.from(chunk).toString("utf8")}`);
    },
  }, new AbortController().signal);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.toString("utf8"), "first\nsecond\n");
  assert.equal(result.stderr.toString("utf8"), "third\n");
  assert.equal(result.stdoutBytes, Buffer.byteLength("first\nsecond\n"));
  assert.equal(result.stderrBytes, Buffer.byteLength("third\n"));
  assert.deepEqual(observed, ["stdout:first\n", "stdout:second\n", "stderr:third\n"]);
});

test("bounded process execution does not wait indefinitely for a quiet inherited pipe", async () => {
  const descendant = [
    "process.send('ready')",
    "setTimeout(() => process.exit(0), 1500)",
  ].join(";");
  const result = await runProcess({
    argv: [process.execPath, "--eval", inheritedPipeParent(descendant)],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    outputLimitBytes: 1024,
  }, new AbortController().signal);

  assert.equal(result.exitCode, 0);
  assert.ok(result.durationMs < 1_200, `expected bounded drain, took ${result.durationMs}ms`);
});

test("bounded process execution ignores inherited-pipe output after settling", async () => {
  const descendant = [
    "process.stdout.on('error', () => {})",
    "process.send('ready')",
    "setTimeout(() => process.stdout.write('too late'), 500)",
    "setTimeout(() => process.exit(0), 550)",
  ].join(";");
  const observed: string[] = [];
  const result = await runProcess({
    argv: [process.execPath, "--eval", inheritedPipeParent(descendant)],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    outputLimitBytes: 1024,
    onOutput(stream, chunk) {
      observed.push(`${stream}:${Buffer.from(chunk).toString("utf8")}`);
    },
  }, new AbortController().signal);

  assert.equal(result.stdout.length, 0);
  assert.equal(result.stdoutBytes, 0);
  assert.deepEqual(observed, []);
  await new Promise<void>((resolve) => setTimeout(resolve, 650));
  assert.equal(result.stdout.length, 0);
  assert.equal(result.stdoutBytes, 0);
  assert.deepEqual(observed, []);
});
