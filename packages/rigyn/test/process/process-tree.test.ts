import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  processTreeTerminationPlan,
  terminateProcessTree,
  terminateProcessTreeAsync,
} from "../../src/process/process-tree.js";
import { terminateTrackedProcessGroups } from "../../src/process/active-groups.js";
import { DirectProcessRunner, runProcess } from "../../src/process/runner.js";

function inheritedPipeParent(descendantSource: string): string {
  // libuv's Windows job object kills non-detached children when their spawning process exits.
  return [
    "const { spawn } = require('node:child_process')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { detached: process.platform === 'win32', stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true })`,
    "child.once('message', () => process.exit(0))",
  ].join(";");
}

test("process runners reject invalid timeouts before spawning", async () => {
  const invalid = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648];
  const direct = new DirectProcessRunner();
  for (const timeoutMs of invalid) {
    const spec = {
      argv: ["/rigyn-fixture-command-must-not-spawn"] as [string],
      cwd: process.cwd(),
      timeoutMs,
      outputLimitBytes: 1_024,
    };
    await assert.rejects(
      runProcess(spec, new AbortController().signal),
      /timeoutMs must be an integer from 0 to 2147483647/u,
    );
    await assert.rejects(
      direct.run(spec, new AbortController().signal),
      /timeoutMs must be an integer from 0 to 2147483647/u,
    );
  }
});

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

test("an already-gone POSIX process group is a successful termination", async () => {
  const missing = Object.assign(new Error("process group does not exist"), { code: "ESRCH" });
  const kill = (): never => { throw missing; };

  assert.equal(terminateProcessTree(2468, "SIGTERM", { platform: "linux", kill }), true);
  assert.equal(await terminateProcessTreeAsync(2468, "SIGKILL", { platform: "linux", kill }), true);
});

test("asynchronous Windows taskkill succeeds without a direct fallback", async () => {
  const calls: unknown[][] = [];
  const killed: unknown[][] = [];
  const child = Object.assign(new EventEmitter(), {
    kill(signal?: NodeJS.Signals | number) {
      killed.push(["helper", signal]);
      return true;
    },
  });
  const result = terminateProcessTreeAsync(4321, "SIGTERM", {
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows" },
    spawn(command, args, options) {
      calls.push([command, [...args], options]);
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
    kill(pid, signal) { killed.push([pid, signal]); },
  });

  assert.equal(await result, true);
  assert.deepEqual(calls, [[
    "C:\\Windows\\System32\\taskkill.exe",
    ["/PID", "4321", "/T", "/F"],
    { shell: false, stdio: "ignore", windowsHide: true },
  ]]);
  assert.deepEqual(killed, []);
});

test("asynchronous Windows taskkill errors use the direct fallback exactly once and never reject", async () => {
  const fallback: unknown[][] = [];
  const child = Object.assign(new EventEmitter(), {
    kill() { return true; },
  });
  const result = terminateProcessTreeAsync(7654, "SIGKILL", {
    platform: "win32",
    environment: { WINDIR: "D:\\Windows" },
    spawn() {
      queueMicrotask(() => {
        child.emit("error", new Error("taskkill fixture failed"));
        child.emit("close", 1, null);
      });
      return child;
    },
    kill(pid, signal) {
      fallback.push([pid, signal]);
      throw new Error("direct fallback fixture failed");
    },
  });

  assert.equal(await result, false);
  assert.deepEqual(fallback, [[7654, "SIGKILL"]]);
});

test("asynchronous Windows taskkill times out at exactly two seconds, kills its helper, and falls back once", async () => {
  const delays: number[] = [];
  const helperSignals: Array<NodeJS.Signals | number | undefined> = [];
  const fallback: unknown[][] = [];
  const child = Object.assign(new EventEmitter(), {
    kill(signal?: NodeJS.Signals | number) {
      helperSignals.push(signal);
      queueMicrotask(() => child.emit("close", 1, null));
      return true;
    },
  });
  const result = terminateProcessTreeAsync(2468, "SIGTERM", {
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows" },
    spawn() { return child; },
    kill(pid, signal) { fallback.push([pid, signal]); },
    setTimeout(callback, delay) {
      delays.push(delay);
      queueMicrotask(callback);
      return globalThis.setTimeout(() => undefined, 60_000);
    },
    clearTimeout(timeout) { globalThis.clearTimeout(timeout); },
  });

  assert.equal(await result, true);
  assert.deepEqual(delays, [2_000]);
  assert.deepEqual(helperSignals, ["SIGKILL"]);
  assert.deepEqual(fallback, [[2468, "SIGTERM"]]);
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

test("bounded process execution waits for asynchronous output observers in order", async () => {
  let active = 0;
  let maximumActive = 0;
  const completed: string[] = [];
  const result = await runProcess({
    argv: [
      process.execPath,
      "--eval",
      "process.stdout.write('out'); process.stderr.write('err')",
    ],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    outputLimitBytes: 1024,
    async onOutput(stream, chunk) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      completed.push(`${stream}:${Buffer.from(chunk).toString("utf8")}`);
      active -= 1;
    },
  }, new AbortController().signal);

  assert.equal(result.stdout.toString("utf8"), "out");
  assert.equal(result.stderr.toString("utf8"), "err");
  assert.equal(active, 0);
  assert.equal(maximumActive, 1);
  assert.deepEqual(new Set(completed), new Set(["stdout:out", "stderr:err"]));
});

test("POSIX process ownership terminates a background descendant before returning", {
  skip: process.platform === "win32",
}, async (context) => {
  let descendantPid: number | undefined;
  context.after(() => {
    if (descendantPid === undefined) return;
    try {
      process.kill(descendantPid, "SIGKILL");
    } catch {}
  });
  const source = [
    "const { spawn } = require('node:child_process')",
    "const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    "process.stdout.write(String(child.pid))",
    "child.unref()",
  ].join(";");
  const result = await runProcess({
    argv: [process.execPath, "--eval", source],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    outputLimitBytes: 1024,
  }, new AbortController().signal);
  descendantPid = Number(result.stdout.toString("utf8"));
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);

  let alive = true;
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(descendantPid, 0);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    } catch (error) {
      if (!["ESRCH", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      alive = false;
      break;
    }
  }
  assert.equal(alive, false);
});
