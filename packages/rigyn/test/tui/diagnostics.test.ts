import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import { TuiController } from "../../src/tui/controller.js";
import {
  boundedTuiDiagnosticText,
  boundedTuiFailureText,
} from "../../src/tui/diagnostics.js";
import { FakeInput, FakeOutput, tick } from "./helpers.js";

function createController(agentDirectory: string, diagnostics: boolean): {
  controller: TuiController;
  output: FakeOutput;
} {
  const input = new FakeInput();
  const output = new FakeOutput();
  return {
    controller: new TuiController({
      input,
      output,
      environment: {
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        TERM_COLOR: "0",
        RIGYN_HOME: agentDirectory,
        ...(diagnostics ? { RIGYN_DEBUG_REDRAW: "1" } : {}),
      },
      handleSignals: false,
    }),
    output,
  };
}

test("TUI diagnostics retain a full registered secret across the output cutoff before redaction", () => {
  const secretPrefix = "registered-tui-boundary-secret:";
  const secret = `${secretPrefix}${"s".repeat(64 * 1_024 - Buffer.byteLength(secretPrefix, "utf8"))}`;
  defaultSecretRedactor.register(secret);

  const bounded = boundedTuiDiagnosticText(`${"a".repeat(4_080)}${secret}-visible-tail`);

  assert.equal(Buffer.byteLength(bounded, "utf8"), 4_096);
  assert.equal(bounded, `${"a".repeat(4_080)}[REDACTED]-visib`);
  assert.doesNotMatch(bounded, /registered-tui-boundary-secret/u);
});

test("TUI failure diagnostics contain hostile thrown values within a final UTF-8 byte cap", () => {
  let traps = 0;
  const hostile = new Proxy(Object.create(null) as object, {
    getPrototypeOf() { traps += 1; throw new Error("prototype trap ran"); },
    get() { traps += 1; throw new Error("property trap ran"); },
  });

  assert.equal(boundedTuiFailureText(hostile), "[Thrown object]");
  assert.equal(traps, 0);

  const multibyte = boundedTuiFailureText(new Error("🙂".repeat(8_192)));
  assert.equal(Buffer.byteLength(multibyte, "utf8"), 4_096);
  assert.doesNotMatch(multibyte, /�/u);
});

test("classic TUI notifications apply the diagnostic cap at the output boundary", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    mode: "classic",
    environment: { TERM: "dumb" },
    handleSignals: false,
  });
  controller.start();
  output.chunks.length = 0;

  controller.notify("🙂".repeat(8_192), "warning");

  const message = output.text.slice("\n[warning] ".length, -1);
  assert.equal(Buffer.byteLength(message, "utf8"), 4_096);
  assert.doesNotMatch(message, /�/u);
  controller.close();
});

test("main TUI leaves the diagnostic path untouched by default", () => {
  const root = mkdtempSync(join(tmpdir(), "rigyn-main-no-debug-"));
  const agentDirectory = join(root, "agent");
  try {
    const { controller } = createController(agentDirectory, false);
    controller.start();
    controller.close();
    assert.equal(existsSync(join(agentDirectory, "logs", "rigyn-debug.log")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main TUI opt-in records bounded geometry without rendered content", async () => {
  const root = mkdtempSync(join(tmpdir(), "rigyn-main-debug-"));
  const agentDirectory = join(root, "agent");
  const logPath = join(agentDirectory, "logs", "rigyn-debug.log");
  try {
    mkdirSync(join(agentDirectory, "logs"), { recursive: true });
    writeFileSync(logPath, "old-private-data".repeat(80_000), { mode: 0o644 });
    const { controller, output } = createController(agentDirectory, true);
    controller.start();
    controller.setEditorText("credential-shaped-private-value");
    output.resize(70, 20);
    await tick();
    controller.close();

    const log = readFileSync(logPath, "utf8");
    assert.match(log, /surface-render strategy=(?:initial|surface-clear|viewport-clear)/u);
    assert.match(log, /previous=\d+ next=\d+ changed=\d+ viewport=\d+x\d+/u);
    assert.doesNotMatch(log, /credential-shaped-private-value|old-private-data/u);
    assert.ok(Buffer.byteLength(log, "utf8") < 2_048);
    if (process.platform !== "win32") assert.equal(statSync(logPath).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main TUI ignores symlinked diagnostic directories and files", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "rigyn-main-debug-link-"));
  try {
    const targetDirectory = join(root, "target");
    const directoryLink = join(root, "agent-link");
    mkdirSync(targetDirectory);
    symlinkSync(targetDirectory, directoryLink, "dir");
    const directoryController = createController(directoryLink, true).controller;
    directoryController.start();
    directoryController.close();
    assert.equal(existsSync(join(targetDirectory, "logs", "rigyn-debug.log")), false);

    const agentDirectory = join(root, "agent");
    const outsideFile = join(root, "outside.log");
    mkdirSync(join(agentDirectory, "logs"), { recursive: true });
    writeFileSync(outsideFile, "unchanged");
    symlinkSync(outsideFile, join(agentDirectory, "logs", "rigyn-debug.log"), "file");
    const fileController = createController(agentDirectory, true).controller;
    fileController.start();
    fileController.close();
    assert.equal(readFileSync(outsideFile, "utf8"), "unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
