import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installInteractiveEmergencyRecovery } from "../../src/cli/interactive-emergency.js";
import { runProcess } from "../../src/process/runner.js";
import { TuiController } from "../../src/tui/controller.js";
import { FakeInput, FakeOutput, tick } from "../tui/helpers.js";

test("interactive emergency recovery restores the terminal and terminates an active process tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-emergency-"));
  const marker = join(directory, "grandchild-survived");
  const input = new FakeInput();
  const output = new FakeOutput();
  const terminal = new TuiController({
    input,
    output,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", KITTY_WINDOW_ID: "1" },
    handleSignals: false,
  });
  const monitor = new EventEmitter();
  const abort = new AbortController();
  let ready!: () => void;
  const childReady = new Promise<void>((resolve) => { ready = resolve; });
  const grandchild = [
    "const fs = require('node:fs');",
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'survived'), 700);`,
    "setInterval(() => {}, 1000);",
  ].join("");
  const parent = [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
    "process.stdout.write('ready\\n');",
    "setInterval(() => {}, 1000);",
  ].join("");
  const running = runProcess({
    argv: [process.execPath, "-e", parent],
    cwd: directory,
    timeoutMs: 10_000,
    outputLimitBytes: 64 * 1024,
    onOutput(_stream, chunk) {
      if (Buffer.from(chunk).toString("utf8").includes("ready")) ready();
    },
  }, abort.signal);
  const uninstall = installInteractiveEmergencyRecovery({
    restoreTerminal: () => terminal.close(),
    target: monitor,
  });

  try {
    terminal.start();
    input.write("\u001b[?7u");
    await tick();
    await Promise.race([
      childReady,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("child did not start")), 3_000)),
    ]);
    output.chunks.length = 0;

    assert.equal(monitor.listenerCount("uncaughtExceptionMonitor"), 1);
    assert.equal(monitor.listenerCount("uncaughtException"), 0);
    monitor.emit("uncaughtExceptionMonitor", new Error("fixture crash"), "uncaughtException");

    const result = await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("child was not terminated")), 3_000)),
    ]);
    assert.equal(input.isRaw, false);
    assert.match(output.text, /\u001b\[<u/u);
    assert.match(output.text, /\u001b\[\?2004l/u);
    assert.match(output.text, /\u001b\[\?25h/u);
    if (process.platform === "win32") assert.notEqual(result.exitCode, 0);
    else assert.equal(result.signal, "SIGKILL");

    await new Promise<void>((resolve) => setTimeout(resolve, 850));
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    uninstall();
    terminal.close();
    abort.abort(new Error("test cleanup"));
    await running.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("normal interactive cleanup removes the exception monitor without running recovery", () => {
  const monitor = new EventEmitter();
  let terminalRestores = 0;
  let childTerminations = 0;
  const uninstall = installInteractiveEmergencyRecovery({
    restoreTerminal: () => { terminalRestores += 1; },
    terminateChildren: () => { childTerminations += 1; },
    target: monitor,
  });

  uninstall();
  uninstall();
  monitor.emit("uncaughtExceptionMonitor", new Error("after cleanup"), "uncaughtException");
  assert.equal(monitor.listenerCount("uncaughtExceptionMonitor"), 0);
  assert.equal(terminalRestores, 0);
  assert.equal(childTerminations, 0);
});

test("the emergency monitor observes an uncaught error without converting it into a handled error", () => {
  const source = `
    import { installInteractiveEmergencyRecovery } from ${JSON.stringify(
      new URL("../../src/cli/interactive-emergency.ts", import.meta.url).href,
    )};
    installInteractiveEmergencyRecovery({
      restoreTerminal: () => process.stdout.write("terminal-restored\\n"),
      terminateChildren: () => process.stdout.write("children-terminated\\n"),
    });
    setImmediate(() => { throw new Error("uncaught-fixture-marker"); });
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    encoding: "utf8",
    timeout: 5_000,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /children-terminated/u);
  assert.match(result.stdout, /terminal-restored/u);
  assert.match(result.stderr, /uncaught-fixture-marker/u);
});
