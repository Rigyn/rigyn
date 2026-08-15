import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  ManagedProcessSupervisor,
  type ManagedProcessOwner,
} from "../../src/process/managed-process.js";

function owner(overrides: Partial<ManagedProcessOwner> = {}): {
  active: { value: boolean };
  committed: { value: boolean };
  controller: AbortController;
  owner: ManagedProcessOwner;
} {
  const active = { value: true };
  const committed = { value: true };
  const controller = new AbortController();
  const key = {};
  return {
    active,
    committed,
    controller,
    owner: {
      key,
      signal: controller.signal,
      isActive: () => active.value,
      isCommitted: () => committed.value,
      ...overrides,
    },
  };
}

function fakeManagedChild(stdin: Writable = new PassThrough(), pid?: number): {
  child: ChildProcessWithoutNullStreams;
  stderr: PassThrough;
  stdout: PassThrough;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdin,
    stdout,
    stderr,
  }) as unknown as ChildProcessWithoutNullStreams;
  return { child, stderr, stdout };
}

function controlledInput(): {
  firstWrite: Promise<(cause?: Error | null) => void>;
  stdin: Writable;
} {
  let first = true;
  let reportFirst!: (callback: (cause?: Error | null) => void) => void;
  const firstWrite = new Promise<(cause?: Error | null) => void>((resolveFirst) => {
    reportFirst = resolveFirst;
  });
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      if (first) {
        first = false;
        reportFirst(callback);
      } else {
        queueMicrotask(callback);
      }
    },
  });
  return { firstWrite, stdin };
}

test("managed processes return an opaque id immediately and retain bounded captured output", async (context) => {
  const supervisor = new ManagedProcessSupervisor({ cwd: process.cwd() });
  context.after(async () => await supervisor.close());
  const selected = owner();
  const processes = supervisor.service(selected.owner);

  const id = processes.spawn({
    argv: [process.execPath, "--eval", "process.stdout.write('ready'); process.stderr.write('warn')"],
  });
  assert.match(id, /^process_[a-f0-9]{32}$/u);
  assert.ok(["starting", "running"].includes(processes.status(id).state));

  const result = await processes.wait(id);
  assert.equal(result.state, "succeeded");
  assert.equal(result.exitCode, 0);
  assert.equal(Buffer.from(result.stdout).toString("utf8"), "ready");
  assert.equal(Buffer.from(result.stderr).toString("utf8"), "warn");
  assert.equal(result.stdoutBytes, 5);
  assert.equal(result.stderrBytes, 4);
  assert.equal(result.outputTruncated, false);
  assert.equal("pid" in result, false);

  result.stdout[0] = 0;
  const repeated = await processes.wait(id);
  assert.equal(Buffer.from(repeated.stdout).toString("utf8"), "ready");
  assert.notEqual(repeated, result);
});

test("managed process capture is prefix-bounded while total byte counts remain authoritative", async (context) => {
  const supervisor = new ManagedProcessSupervisor({ cwd: process.cwd(), maxCaptureBytes: 32 });
  context.after(async () => await supervisor.close());
  const processes = supervisor.service(owner().owner);
  const id = processes.spawn({
    argv: [process.execPath, "--eval", "process.stdout.write('x'.repeat(100)); process.stderr.write('y'.repeat(80))"],
    captureLimitBytes: 16,
  });
  const result = await processes.wait(id);
  assert.equal(result.stdout.length, 16);
  assert.equal(result.stderr.length, 16);
  assert.equal(result.stdoutBytes, 100);
  assert.equal(result.stderrBytes, 80);
  assert.equal(result.outputTruncated, true);
});

test("managed process pipe mode provides bounded lossless reads and serialized writes", async (context) => {
  const supervisor = new ManagedProcessSupervisor({ cwd: process.cwd() });
  context.after(async () => await supervisor.close());
  const processes = supervisor.service(owner().owner);
  const id = processes.spawn({
    argv: [
      process.execPath,
      "--eval",
      "process.stdin.on('data', chunk => process.stdout.write(chunk)); process.stdin.on('end', () => process.exit(0))",
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  await Promise.all([
    processes.write(id, "alpha"),
    processes.write(id, Buffer.from("beta")),
  ]);
  await processes.closeInput(id);

  let output = Buffer.alloc(0);
  while (true) {
    const page = await processes.read(id, "stdout", { maxBytes: 3 });
    output = Buffer.concat([output, Buffer.from(page.data)]);
    if (page.eof) break;
  }
  assert.equal(output.toString("utf8"), "alphabeta");
  assert.equal((await processes.wait(id)).state, "succeeded");
});

test("an aborted write is not admitted while a managed process write is still queued", async (context) => {
  const supervisor = new ManagedProcessSupervisor({ cwd: process.cwd() });
  context.after(async () => await supervisor.close());
  const processes = supervisor.service(owner().owner);
  const id = processes.spawn({
    argv: [
      process.execPath,
      "--eval",
      "process.stdin.on('data', chunk => process.stdout.write(chunk)); process.stdin.on('end', () => process.exit(0))",
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const controller = new AbortController();
  controller.abort(new Error("write withdrawn"));

  await assert.rejects(processes.write(id, "must not arrive", { signal: controller.signal }), /write withdrawn/u);
  await new Promise<void>((resolveValue) => setTimeout(resolveValue, 30));
  assert.equal(processes.status(id).stdoutBytes, 0);
  await processes.closeInput(id);
  const page = await processes.read(id, "stdout");
  assert.equal(page.eof, true);
  assert.equal(page.data.length, 0);
  assert.equal((await processes.wait(id)).state, "succeeded");
});

test("managed process pipe mode backpressures without losing delayed output", async (context) => {
  const supervisor = new ManagedProcessSupervisor({
    cwd: process.cwd(),
    pipeHighWaterBytes: 16 * 1024,
    pipeLowWaterBytes: 8 * 1024,
  });
  context.after(async () => await supervisor.close());
  const processes = supervisor.service(owner().owner);
  const expectedBytes = 512 * 1024;
  const id = processes.spawn({
    argv: [process.execPath, "--eval", `process.stdout.write(Buffer.alloc(${expectedBytes}, 120))`],
    stdout: "pipe",
    stderr: "ignore",
  });

  await new Promise<void>((resolveValue) => setTimeout(resolveValue, 30));
  let observedBytes = 0;
  while (true) {
    const page = await processes.read(id, "stdout", { maxBytes: 8 * 1024 });
    observedBytes += page.data.length;
    assert.equal(page.data.every((value) => value === 120), true);
    if (page.eof) break;
  }

  const result = await processes.wait(id);
  assert.equal(result.state, "succeeded");
  assert.equal(observedBytes, expectedBytes);
  assert.equal(result.stdoutBytes, expectedBytes);
  assert.equal(result.outputTruncated, false);
});

test("managed process output errors fail once and settle pending reads", async (context) => {
  for (const streamName of ["stdout", "stderr"] as const) {
    await context.test(streamName, async (subcontext) => {
      const diagnostics: string[] = [];
      const fixture = fakeManagedChild();
      const supervisor = new ManagedProcessSupervisor({
        cwd: process.cwd(),
        spawnProcess: (() => fixture.child) as unknown as typeof spawn,
      });
      subcontext.after(async () => await supervisor.close());
      const processes = supervisor.service(owner({ diagnostic: (message) => diagnostics.push(message) }).owner);
      const id = processes.spawn({
        argv: [process.execPath],
        stdout: "pipe",
        stderr: "pipe",
      });
      fixture.child.emit("spawn");
      const pendingRead = processes.read(id, streamName);

      fixture[streamName].emit("error", new Error(`${streamName} pipe failed`));
      fixture[streamName].emit("error", new Error(`${streamName} duplicate failure`));
      fixture[streamName === "stdout" ? "stderr" : "stdout"].emit("error", new Error("other pipe failed"));
      fixture.child.emit("close", 0, null);

      const [page, result] = await Promise.all([pendingRead, processes.wait(id)]);
      assert.equal(page.eof, true);
      assert.equal(page.data.length, 0);
      assert.equal(result.state, "failed");
      assert.match(result.error ?? "", new RegExp(`${streamName} pipe failed`, "u"));
      assert.deepEqual(diagnostics, [`Managed process ${streamName} failed: ${streamName} pipe failed`]);
    });
  }
});

test("managed process input operation capacity is released after queued aborts", async (context) => {
  const input = controlledInput();
  const fixture = fakeManagedChild(input.stdin);
  const supervisor = new ManagedProcessSupervisor({
    cwd: process.cwd(),
    spawnProcess: (() => fixture.child) as unknown as typeof spawn,
  });
  context.after(async () => await supervisor.close());
  const processes = supervisor.service(owner().owner);
  const id = processes.spawn({
    argv: [process.execPath],
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  fixture.child.emit("spawn");
  const withdrawn = new AbortController();
  const writes = Array.from({ length: 64 }, (_value, index) =>
    processes.write(id, "x", index === 1 ? { signal: withdrawn.signal } : {}));
  const settlements = Promise.allSettled(writes);
  await assert.rejects(processes.write(id, "overflow"), /input queue capacity/u);
  withdrawn.abort(new Error("queued write withdrawn"));
  await assert.rejects(writes[1]!, /queued write withdrawn/u);
  await assert.rejects(processes.write(id, "still full"), /input queue capacity/u);

  const releaseFirst = await input.firstWrite;
  releaseFirst();
  const outcomes = await settlements;
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);

  const refill = Array.from({ length: 64 }, () => processes.write(id, "y"));
  const refillSettlements = Promise.allSettled(refill);
  await assert.rejects(processes.write(id, "overflow again"), /input queue capacity/u);
  assert.equal((await refillSettlements).every((outcome) => outcome.status === "fulfilled"), true);
  fixture.child.emit("close", 0, null);
  assert.equal((await processes.wait(id)).state, "succeeded");
});

test("managed process input operation capacity is released after write failures", async (context) => {
  const input = controlledInput();
  const fixture = fakeManagedChild(input.stdin);
  const supervisor = new ManagedProcessSupervisor({
    cwd: process.cwd(),
    spawnProcess: (() => fixture.child) as unknown as typeof spawn,
  });
  context.after(async () => await supervisor.close());
  const processes = supervisor.service(owner().owner);
  const id = processes.spawn({
    argv: [process.execPath],
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  fixture.child.emit("spawn");
  const writes = Array.from({ length: 64 }, () => processes.write(id, "x"));
  const settlements = Promise.allSettled(writes);
  await assert.rejects(processes.write(id, "overflow"), /input queue capacity/u);

  const failFirst = await input.firstWrite;
  failFirst(new Error("controlled stdin failure"));
  assert.equal((await settlements).every((outcome) => outcome.status === "rejected"), true);

  const refill = Array.from({ length: 64 }, () => processes.write(id, "y"));
  const refillSettlements = Promise.allSettled(refill);
  await assert.rejects(processes.write(id, "overflow again"), /input queue capacity/u);
  assert.equal((await refillSettlements).every((outcome) => outcome.status === "rejected"), true);
  fixture.child.emit("close", 0, null);
  assert.equal((await processes.wait(id)).state, "succeeded");
});

test("supervisor close starts the full host termination set without blocking the event loop", async () => {
  const fixtures = Array.from({ length: 16 }, (_value, index) =>
    fakeManagedChild(new PassThrough(), 10_000 + index));
  const diagnostics: string[] = [];
  const terminations: Array<[number, NodeJS.Signals]> = [];
  let childIndex = 0;
  const supervisor = new ManagedProcessSupervisor({
    cwd: process.cwd(),
    maxRunningPerOwner: 16,
    maxRunning: 16,
    spawnProcess: (() => fixtures[childIndex++]!.child) as unknown as typeof spawn,
    async terminateProcess(pid, signal) {
      terminations.push([pid, signal]);
      if (pid % 2 === 0) return false;
      throw new Error(`termination fixture ${pid}`);
    },
  });
  const processes = supervisor.service(owner({ diagnostic: (message) => diagnostics.push(message) }).owner);
  for (const fixture of fixtures) {
    processes.spawn({ argv: [process.execPath] });
    fixture.child.emit("spawn");
  }

  const eventLoopTurn = new Promise<"turn">((resolveTurn) => setTimeout(() => resolveTurn("turn"), 0));
  const closeOperation = supervisor.close();
  assert.equal(await Promise.race([closeOperation.then(() => "closed" as const), eventLoopTurn]), "turn");
  assert.equal(terminations.length, 16);
  assert.equal(diagnostics.length, 16);
  assert.equal(diagnostics.every((message) => message.includes("Managed process tree termination failed")), true);

  for (const fixture of fixtures) fixture.child.emit("close", null, "SIGTERM");
  await closeOperation;
});

test("natural close waits for asynchronous descendant cleanup before settling", async (context) => {
  const fixture = fakeManagedChild(new PassThrough(), 12_345);
  const pending: Array<() => void> = [];
  let releaseImmediately = false;
  const supervisor = new ManagedProcessSupervisor({
    cwd: process.cwd(),
    spawnProcess: (() => fixture.child) as unknown as typeof spawn,
    terminateProcess: async () => {
      if (releaseImmediately) return true;
      return await new Promise<boolean>((resolveTermination) => {
        pending.push(() => resolveTermination(true));
      });
    },
  });
  context.after(async () => {
    releaseImmediately = true;
    for (const release of pending.splice(0)) release();
    await supervisor.close();
  });
  const processes = supervisor.service(owner().owner);
  const id = processes.spawn({ argv: [process.execPath] });
  fixture.child.emit("spawn");
  fixture.child.emit("exit", 0, null);
  fixture.child.emit("close", 0, null);
  let settled = false;
  const resultPromise = processes.wait(id).then((result) => {
    settled = true;
    return result;
  });

  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(pending.length, process.platform === "win32" ? 1 : 2);
  assert.equal(settled, false);
  for (const release of pending.splice(0)) release();
  assert.equal((await resultPromise).state, "succeeded");
});

test("managed process cancellation is idempotent and terminates the owned process", async (context) => {
  const supervisor = new ManagedProcessSupervisor({ cwd: process.cwd() });
  context.after(async () => await supervisor.close());
  const processes = supervisor.service(owner().owner);
  const id = processes.spawn({
    argv: [process.execPath, "--eval", "setInterval(() => {}, 1000)"],
  });
  const [first, second] = await Promise.all([processes.cancel(id), processes.cancel(id)]);
  assert.equal(first.state, "cancelled");
  assert.deepEqual(second, first);
});

test("managed process timeout has a distinct terminal state", async (context) => {
  const supervisor = new ManagedProcessSupervisor({ cwd: process.cwd() });
  context.after(async () => await supervisor.close());
  const processes = supervisor.service(owner().owner);
  const id = processes.spawn({
    argv: [process.execPath, "--eval", "setInterval(() => {}, 1000)"],
    timeoutMs: 20,
  });

  const result = await processes.wait(id);
  assert.equal(result.state, "timed_out");
});

test("managed process cancellation terminates its POSIX descendant group", {
  skip: process.platform === "win32",
}, async (context) => {
  const supervisor = new ManagedProcessSupervisor({ cwd: process.cwd() });
  context.after(async () => await supervisor.close());
  let descendantPid: number | undefined;
  context.after(() => {
    if (descendantPid === undefined) return;
    try {
      process.kill(descendantPid, "SIGKILL");
    } catch {}
  });
  const processes = supervisor.service(owner().owner);
  const source = [
    "const { spawn } = require('node:child_process')",
    "const child = spawn(process.execPath, ['--eval', 'process.on(\"SIGTERM\", () => {}); process.send(\"ready\"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })",
    "child.once('message', () => process.stdout.write(String(child.pid)))",
    "setInterval(() => {}, 1000)",
  ].join(";");
  const id = processes.spawn({
    argv: [process.execPath, "--eval", source],
    stdout: "pipe",
    stderr: "ignore",
  });
  const page = await processes.read(id, "stdout", { maxBytes: 64 });
  descendantPid = Number(Buffer.from(page.data).toString("utf8"));
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);

  await processes.cancel(id);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(descendantPid, 0);
      await new Promise<void>((resolveValue) => setTimeout(resolveValue, 20));
    } catch (cause) {
      if (["ESRCH", "EINVAL"].includes((cause as NodeJS.ErrnoException).code ?? "")) return;
      throw cause;
    }
  }
  assert.fail(`managed descendant ${descendantPid} survived cancellation`);
});

test("aborting wait leaves the process running while an owner abort cancels it", async (context) => {
  const supervisor = new ManagedProcessSupervisor({ cwd: process.cwd() });
  context.after(async () => await supervisor.close());
  const selected = owner();
  const processes = supervisor.service(selected.owner);
  const id = processes.spawn({
    argv: [process.execPath, "--eval", "setInterval(() => {}, 1000)"],
  });
  const waiter = new AbortController();
  waiter.abort(new Error("stop waiting"));
  await assert.rejects(processes.wait(id, { signal: waiter.signal }), /stop waiting/u);
  assert.ok(["starting", "running"].includes(processes.status(id).state));

  selected.controller.abort(new Error("generation replaced"));
  selected.active.value = false;
  await assert.rejects(processes.wait(id), /no longer active/u);
  await supervisor.close();
});

test("owner abort rejects a pending pipe read without leaking it", async (context) => {
  const supervisor = new ManagedProcessSupervisor({ cwd: process.cwd() });
  context.after(async () => await supervisor.close());
  const selected = owner();
  const processes = supervisor.service(selected.owner);
  const id = processes.spawn({
    argv: [process.execPath, "--eval", "setInterval(() => {}, 1000)"],
    stdout: "pipe",
    stderr: "ignore",
  });
  const pending = processes.read(id, "stdout");
  selected.controller.abort(new Error("generation retired"));
  selected.active.value = false;

  await assert.rejects(pending, /generation retired/u);
  await supervisor.close();
});

test("spawn failure settles pending pipe reads and reports a failed result", async (context) => {
  const supervisor = new ManagedProcessSupervisor({ cwd: process.cwd() });
  context.after(async () => await supervisor.close());
  const processes = supervisor.service(owner().owner);
  const id = processes.spawn({
    argv: [`definitely-missing-rigyn-executable-${process.pid}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  const pending = processes.read(id, "stdout");
  const [page, result] = await Promise.all([pending, processes.wait(id)]);

  assert.equal(page.eof, true);
  assert.equal(page.data.length, 0);
  assert.equal(result.state, "failed");
  assert.match(result.error ?? "", /ENOENT|spawn/u);
});

test("supervisor close force-settles a child that never reports spawn or close", async () => {
  const fakeChild = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams;
  const supervisor = new ManagedProcessSupervisor({
    cwd: process.cwd(),
    spawnProcess: (() => fakeChild) as unknown as typeof spawn,
  });
  const processes = supervisor.service(owner().owner);
  const id = processes.spawn({
    argv: [process.execPath],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const pendingRead = processes.read(id, "stdout");
  const pendingWrite = processes.write(id, "queued input");
  const resultPromise = processes.wait(id);
  const startedAt = Date.now();

  await supervisor.close();
  const [page, result] = await Promise.all([pendingRead, resultPromise]);

  assert.ok(Date.now() - startedAt < 4_500);
  assert.equal(page.eof, true);
  assert.equal(page.data.length, 0);
  await assert.rejects(pendingWrite, /did not close/u);
  assert.equal(result.state, "cancelled");
  assert.match(result.error ?? "", /did not close/u);
});

test("managed process services reject precommit starts, stale access, invalid argv, and capacity overflow", async (context) => {
  const supervisor = new ManagedProcessSupervisor({
    cwd: process.cwd(),
    maxRunningPerOwner: 1,
    maxRunning: 1,
  });
  context.after(async () => await supervisor.close());
  const selected = owner();
  selected.committed.value = false;
  const processes = supervisor.service(selected.owner);
  assert.throws(
    () => processes.spawn({ argv: [process.execPath, "--eval", "0"] }),
    /before activation commits/u,
  );
  selected.committed.value = true;
  assert.throws(() => processes.spawn({ argv: [""] }), /non-empty command/u);
  assert.throws(() => processes.spawn({ argv: ["bad\0command"] }), /contains NUL/u);

  const id = processes.spawn({ argv: [process.execPath, "--eval", "setInterval(() => {}, 1000)"] });
  assert.throws(
    () => processes.spawn({ argv: [process.execPath, "--eval", "0"] }),
    /capacity/u,
  );
  await processes.cancel(id);
  selected.active.value = false;
  assert.throws(() => processes.status(id), /no longer active/u);
});

test("managed process host capacity spans independent owners and writes are operation-bounded", async (context) => {
  const supervisor = new ManagedProcessSupervisor({
    cwd: process.cwd(),
    maxRunningPerOwner: 2,
    maxRunning: 2,
  });
  context.after(async () => await supervisor.close());
  const first = supervisor.service(owner().owner);
  const second = supervisor.service(owner().owner);
  const firstId = first.spawn({
    argv: [process.execPath, "--eval", "process.stdin.resume(); setInterval(() => {}, 1000)"],
    stdin: "pipe",
  });
  const secondId = second.spawn({ argv: [process.execPath, "--eval", "setInterval(() => {}, 1000)"] });

  assert.throws(
    () => first.spawn({ argv: [process.execPath, "--eval", "0"] }),
    /capacity/u,
  );
  await assert.rejects(
    first.write(firstId, Buffer.alloc(64 * 1024 + 1)),
    /write exceeds/u,
  );
  await Promise.all([first.cancel(firstId), second.cancel(secondId)]);
});

test("managed process status subscriptions are generation-owned and listener failures are isolated", async (context) => {
  const diagnostics: string[] = [];
  let prototypeTrapCalls = 0;
  let conversionTrapCalls = 0;
  const hostileFailure = new Proxy({}, {
    getPrototypeOf() {
      prototypeTrapCalls += 1;
      throw new Error("listener failure prototype must not be inspected");
    },
    get(_target, property) {
      if (property === "toString" || property === Symbol.toPrimitive) conversionTrapCalls += 1;
      throw new Error("listener failure conversion must not be invoked");
    },
  });
  let promiseTrapCalls = 0;
  const hostileReturn = new Proxy({}, {
    getPrototypeOf() {
      promiseTrapCalls += 1;
      throw new Error("listener return prototype must not be inspected");
    },
  });
  const supervisor = new ManagedProcessSupervisor({ cwd: process.cwd(), statusUpdateIntervalMs: 1 });
  context.after(async () => await supervisor.close());
  const selected = owner({ diagnostic: (message) => diagnostics.push(message) });
  const processes = supervisor.service(selected.owner);
  const id = processes.spawn({
    argv: [process.execPath, "--eval", "process.stdout.write('one'); setTimeout(() => process.exit(0), 20)"],
  });
  const states: string[] = [];
  processes.subscribe(id, (status) => {
    states.push(status.state);
    if (status.state === "running") throw new Error("listener fixture");
  });
  processes.subscribe(id, () => { throw hostileFailure; });
  processes.subscribe(id, () => hostileReturn as never);
  const result = await processes.wait(id);
  assert.equal(result.state, "succeeded");
  assert.equal(states.includes("succeeded"), true);
  assert.equal(diagnostics.some((message) => message.includes("listener fixture")), true);
  assert.equal(diagnostics.some((message) => message.includes("[Thrown object]")), true);
  assert.equal(prototypeTrapCalls, 0);
  assert.equal(conversionTrapCalls, 0);
  assert.equal(promiseTrapCalls, 0);
});

test("duplicate status listeners retain independent subscription accounting", async (context) => {
  const supervisor = new ManagedProcessSupervisor({
    cwd: process.cwd(),
    maxSubscriptionsPerOwner: 2,
  });
  context.after(async () => await supervisor.close());
  const processes = supervisor.service(owner().owner);
  const id = processes.spawn({ argv: [process.execPath, "--eval", "setInterval(() => {}, 1000)"] });
  const listener = (): void => undefined;
  const first = processes.subscribe(id, listener);
  const second = processes.subscribe(id, listener);
  assert.throws(() => processes.subscribe(id, listener), /capacity/u);

  first();
  second();
  const third = processes.subscribe(id, listener);
  const fourth = processes.subscribe(id, listener);
  third();
  fourth();
  await processes.cancel(id);
});

test("terminal managed processes release owner and caller abort listeners", async (context) => {
  const supervisor = new ManagedProcessSupervisor({ cwd: process.cwd() });
  context.after(async () => await supervisor.close());
  const selected = owner();
  const caller = new AbortController();
  const processes = supervisor.service(selected.owner);
  const ownerBaseline = getEventListeners(selected.controller.signal, "abort").length;
  const id = processes.spawn({
    argv: [process.execPath, "--eval", "0"],
    signal: caller.signal,
  });
  assert.equal(getEventListeners(selected.controller.signal, "abort").length, ownerBaseline + 1);
  assert.equal(getEventListeners(caller.signal, "abort").length, 1);

  await processes.wait(id);
  assert.equal(getEventListeners(selected.controller.signal, "abort").length, ownerBaseline);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  selected.controller.abort();
  assert.equal(getEventListeners(selected.controller.signal, "abort").length, 0);
});
