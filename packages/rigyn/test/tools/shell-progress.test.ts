import assert from "node:assert/strict";
import { closeSync, readdirSync, readlinkSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolProgress } from "../../src/core/events.js";
import type { CommandResult, CommandSpec, ProcessRunner } from "../../src/process/types.js";
import { SHELL_PROGRESS_FLUSH_BYTES, ShellTool, WorkspaceBoundary } from "../../src/tools/index.js";
import { CoalescedOutputProgress } from "../../src/tools/progress.js";
import type { ToolContext } from "../../src/tools/types.js";

function outcome(stdout: Buffer, stderr = Buffer.alloc(0), overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr,
    stdoutBytes: stdout.byteLength,
    stderrBytes: stderr.byteLength,
    timedOut: false,
    cancelled: false,
    durationMs: 1,
    ...overrides,
  };
}

async function toolContext(
  t: { after(callback: () => Promise<void>): void },
  runner: ProcessRunner,
  reportProgress: (progress: ToolProgress) => void,
): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), "harness-shell-progress-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return {
    workspace: await WorkspaceBoundary.create(root),
    runner,
    reportProgress: (progress) => {
      if (progress.type === "output") reportProgress(progress);
    },
    signal: new AbortController().signal,
    runId: "run",
    threadId: "thread",
  };
}

function runner(run: (spec: CommandSpec) => Promise<CommandResult>): ProcessRunner {
  return {
    run: (spec) => run(spec),
  };
}

test("shell progress coalesces split UTF-8 streams and flushes before the final result", async (t) => {
  const updates: ToolProgress[] = [];
  const stdout = Buffer.from("A🙂B", "utf8");
  const stderr = Buffer.from("err", "utf8");
  const selected = runner(async (spec) => {
    spec.onOutput?.("stdout", stdout.subarray(0, 3));
    spec.onOutput?.("stdout", stdout.subarray(3, 5));
    spec.onOutput?.("stderr", stderr);
    spec.onOutput?.("stdout", stdout.subarray(5));
    assert.equal(updates.length, 0, "small chunks should remain coalesced until close");
    return outcome(stdout, stderr);
  });
  const result = await new ShellTool().execute(
    { command: "ignored" },
    await toolContext(t, selected, (update) => updates.push(update)),
  );

  assert.deepEqual(updates.map((update) => [update.stream, update.delta]), [
    ["stdout", "A🙂B"],
    ["stderr", "err"],
  ]);
  assert.ok(updates.every((update) => update.stdoutBytes === stdout.byteLength && update.stderrBytes === stderr.byteLength));
  const firstStdout = result.content.indexOf("A🙂");
  const selectedStderr = result.content.indexOf("err");
  const finalStdout = result.content.indexOf("B");
  assert.ok(firstStdout >= 0 && firstStdout < selectedStderr && selectedStderr < finalStdout);
  assert.equal((result.content.match(/A🙂/gu) ?? []).length, 1, "progress must not be copied into the model result");
  assert.equal((result.content.match(/err/gu) ?? []).length, 1);
});

test("shell progress flushes at its byte threshold and isolates reporters", async (t) => {
  const updates: ToolProgress[] = [];
  const bytes = Buffer.from("x".repeat(SHELL_PROGRESS_FLUSH_BYTES + 1));
  const selected = runner(async (spec) => {
    spec.onOutput?.("stdout", bytes);
    assert.equal(updates.length, 1, "threshold flush must happen synchronously while the pipe callback drains");
    return outcome(bytes);
  });
  const result = await new ShellTool().execute(
    { command: "ignored" },
    await toolContext(t, selected, (update) => updates.push(update)),
  );
  assert.equal(result.isError, false);
  assert.equal(updates[0]?.delta.length, bytes.byteLength);

  const isolated = runner(async (spec) => {
    spec.onOutput?.("stderr", Buffer.from("still drains"));
    return outcome(Buffer.alloc(0), Buffer.from("still drains"));
  });
  const isolatedResult = await new ShellTool().execute(
    { command: "ignored" },
    await toolContext(t, isolated, () => { throw new Error("observer failed"); }),
  );
  assert.match(isolatedResult.content, /still drains/u);
});

test("shell returns its bounded tail when private artifact streaming fails", { skip: process.platform !== "linux" }, async (t) => {
  const installRoot = await mkdtemp(join(tmpdir(), "harness-shell-spill-failure-"));
  t.after(async () => await rm(installRoot, { recursive: true, force: true }));
  const previousInstallRoot = process.env.RIGYN_INSTALL_DIR;
  process.env.RIGYN_INSTALL_DIR = installRoot;
  try {
    const bytes = Buffer.from(`${"x".repeat(60 * 1_024)}\n`);
    const selected = runner(async (spec) => {
      spec.onOutput?.("stdout", bytes);
      await new Promise((resolve) => setImmediate(resolve));
      const identity = typeof process.getuid === "function" ? String(process.getuid()) : "user";
      const directory = join(installRoot, "tmp", `rigyn-tool-output-${identity}`);
      const active = readdirSync(directory).find((name) => name.startsWith(".rigyn-active-"));
      assert.ok(active);
      const activePath = join(directory, active);
      const descriptor = readdirSync("/proc/self/fd")
        .map(Number)
        .find((fd) => {
          try { return readlinkSync(`/proc/self/fd/${fd}`) === activePath; }
          catch { return false; }
        });
      assert.equal(typeof descriptor, "number");
      closeSync(descriptor!);
      spec.onOutput?.("stdout", Buffer.from("after-failure\n"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      return outcome(Buffer.concat([bytes, Buffer.from("after-failure\n")]));
    });
    const result = await new ShellTool().execute(
      { command: "ignored" },
      await toolContext(t, selected, () => undefined),
    );

    assert.equal(result.isError, false);
    assert.match(result.content, /after-failure/u);
    assert.match(result.content, /private artifact storage or admission was unavailable/u);
    assert.equal((result.metadata as Record<string, unknown>).fullOutputUnavailable, true);
    assert.equal((result.metadata as Record<string, unknown>).fullOutputPath, undefined);
  } finally {
    if (previousInstallRoot === undefined) delete process.env.RIGYN_INSTALL_DIR;
    else process.env.RIGYN_INSTALL_DIR = previousInstallRoot;
  }
});

test("shell still runs when private artifact storage cannot be initialized", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-shell-spill-setup-failure-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const invalidInstallRoot = join(root, "not-a-directory");
  await writeFile(invalidInstallRoot, "blocked\n");
  const previousInstallRoot = process.env.RIGYN_INSTALL_DIR;
  process.env.RIGYN_INSTALL_DIR = invalidInstallRoot;
  let ran = false;
  try {
    const bytes = Buffer.from(`${"y".repeat(60 * 1_024)}\n`);
    const selected = runner(async (spec) => {
      ran = true;
      spec.onOutput?.("stdout", bytes);
      return outcome(bytes);
    });
    const result = await new ShellTool().execute(
      { command: "ignored" },
      await toolContext(t, selected, () => undefined),
    );

    assert.equal(ran, true);
    assert.equal(result.isError, false);
    assert.match(result.content, /private artifact storage or admission was unavailable/u);
    assert.equal((result.metadata as Record<string, unknown>).fullOutputUnavailable, true);
    assert.equal((result.metadata as Record<string, unknown>).fullOutputPath, undefined);
  } finally {
    if (previousInstallRoot === undefined) delete process.env.RIGYN_INSTALL_DIR;
    else process.env.RIGYN_INSTALL_DIR = previousInstallRoot;
  }
});

test("quiet shell progress emits bounded elapsed heartbeats until closed", async () => {
  const updates: ToolProgress[] = [];
  const progress = new CoalescedOutputProgress((update) => updates.push(update), { heartbeatMs: 5 });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("quiet shell heartbeat was not emitted")), 250);
      const poll = setInterval(() => {
        if (updates.length === 0) return;
        clearTimeout(timeout);
        clearInterval(poll);
        resolve();
      }, 2);
    });
  } finally {
    progress.close();
  }

  assert.equal(updates[0]?.delta, "");
  assert.equal(updates[0]?.stdoutBytes, 0);
  assert.equal(updates[0]?.stderrBytes, 0);
  assert.ok((updates[0]?.elapsedMs ?? 0) >= 0);
  const count = updates.length;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(updates.length, count, "closing progress must stop heartbeat updates");
});

test("shell flushes pending progress on completed cancellation and runner errors", async (t) => {
  const cancelledUpdates: ToolProgress[] = [];
  const cancelledRunner = runner(async (spec) => {
    spec.onOutput?.("stdout", Buffer.from("partial cancel"));
    return outcome(Buffer.from("partial cancel"), Buffer.alloc(0), { exitCode: null, cancelled: true });
  });
  const cancelled = await new ShellTool().execute(
    { command: "ignored" },
    await toolContext(t, cancelledRunner, (update) => cancelledUpdates.push(update)),
  );
  assert.equal(cancelled.isError, true);
  assert.match(cancelled.content, /partial cancel[\s\S]*Shell command was cancelled/u);
  assert.equal((cancelled.metadata as Record<string, unknown> | undefined)?.cancelled, true);
  assert.equal(cancelledUpdates[0]?.delta, "partial cancel");

  const errorUpdates: ToolProgress[] = [];
  const failingRunner = runner(async (spec) => {
    spec.onOutput?.("stderr", Buffer.from("partial error"));
    throw new Error("runner exploded");
  });
  await assert.rejects(
    new ShellTool().execute(
      { command: "ignored" },
      await toolContext(t, failingRunner, (update) => errorUpdates.push(update)),
    ),
    /runner exploded/u,
  );
  assert.equal(errorUpdates[0]?.delta, "partial error");
});
