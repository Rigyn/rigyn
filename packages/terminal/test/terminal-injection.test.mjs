import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ProcessTerminal } from "../dist/index.js";

class TestInput extends EventEmitter {
  isRaw = false;
  rawModes = [];
  encoding;
  resumes = 0;
  pauses = 0;

  setRawMode(value) {
    this.isRaw = value;
    this.rawModes.push(value);
    return this;
  }

  setEncoding(value) {
    this.encoding = value;
    return this;
  }

  resume() {
    this.resumes += 1;
    return this;
  }

  pause() {
    this.pauses += 1;
    return this;
  }
}

class TestOutput extends EventEmitter {
  columns = 132;
  rows = 41;
  writes = [];

  write(value) {
    this.writes.push(String(value));
    return true;
  }
}

describe("ProcessTerminal stream injection", () => {
  it("shares native Windows input activation and Apple modified Enter normalization", () => {
    const candidates = [];
    let enabled = 0;
    assert.equal(ProcessTerminal.enableNativeInput({
      platform: "win32",
      architecture: "x64",
      executablePath: "/opt/rigyn/node",
      moduleUrl: import.meta.url,
      loadNativeModule(path) {
        candidates.push(path);
        if (candidates.length < 3) throw new Error("not in this layout");
        return { enableVirtualTerminalInput() { enabled += 1; return false; } };
      },
    }), true);
    assert.equal(candidates.length, 3);
    assert.equal(enabled, 1);

    const environment = { TERM_PROGRAM: "Apple_Terminal" };
    assert.equal(ProcessTerminal.normalizeNativeInput("\r", {
      environment,
      platform: "darwin",
      modifierPressed: (name) => name === "shift",
    }), "\x1b[13;2u");
    const ordinary = Buffer.from([13]);
    assert.equal(ProcessTerminal.normalizeNativeInput(ordinary, {
      environment,
      platform: "darwin",
      modifierPressed: () => false,
    }), ordinary);
  });

  it("recognizes only local Windows Terminal sessions", () => {
    assert.equal(ProcessTerminal.isWindowsTerminalSession({ WT_SESSION: "session" }), true);
    assert.equal(ProcessTerminal.isWindowsTerminalSession({ WT_SESSION: "session", SSH_CONNECTION: "remote" }), false);
    assert.equal(ProcessTerminal.isWindowsTerminalSession({}), false);
  });

  it("does not mirror raw terminal output through an environment variable", () => {
    const previous = process.env.RIGYN_TUI_WRITE_LOG;
    const target = join(tmpdir(), `rigyn-terminal-write-${process.pid}-${Date.now()}.log`);
    process.env.RIGYN_TUI_WRITE_LOG = target;
    try {
      const terminal = new ProcessTerminal({ input: new TestInput(), output: new TestOutput() });
      terminal.write("private transcript");
      assert.equal(existsSync(target), false);
    } finally {
      if (previous === undefined) delete process.env.RIGYN_TUI_WRITE_LOG;
      else process.env.RIGYN_TUI_WRITE_LOG = previous;
    }
  });

  it("owns input, output, dimensions, and cleanup through the supplied streams", () => {
    const input = new TestInput();
    const output = new TestOutput();
    const terminal = new ProcessTerminal({ input, output });
    const received = [];
    let resizes = 0;

    terminal.start((value) => received.push(value), () => { resizes += 1; });
    terminal.start(() => received.push("duplicate"), () => { resizes += 100; });

    assert.deepEqual(input.rawModes, [true]);
    assert.equal(input.encoding, "utf8");
    assert.equal(input.resumes, 1);
    assert.equal(input.listenerCount("data"), 1);
    assert.equal(output.listenerCount("resize"), 1);
    assert.equal(terminal.columns, 132);
    assert.equal(terminal.rows, 41);
    output.columns = -2;
    output.rows = -5;
    assert.equal(terminal.columns, 1);
    assert.equal(terminal.rows, 1);
    assert.deepEqual(output.writes.slice(0, 2), ["\x1b[?2004h", "\x1b[>7u\x1b[?u\x1b[c"]);

    output.emit("resize");
    input.emit("data", "a");
    input.emit("data", "\x1b[200~line one\n");
    input.emit("data", "line two\x1b[201~");
    assert.equal(resizes, 1);
    assert.deepEqual(received, ["a", "\x1b[200~line one\nline two\x1b[201~"]);

    terminal.write("rendered");
    assert.equal(output.writes.at(-1), "rendered");
    terminal.setTitle("safe\x1b]0;owned\x07\nname");
    assert.equal(output.writes.at(-1), "\x1b]0;safe name\x07");

    terminal.stop();
    const writesAfterStop = output.writes.length;
    terminal.stop();
    assert.equal(output.writes.length, writesAfterStop);
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(output.listenerCount("resize"), 0);
    assert.equal(input.pauses, 1);
    assert.deepEqual(input.rawModes, [true, false]);
  });

  it("negotiates keyboard mode and drains only the supplied input", async () => {
    const input = new TestInput();
    const output = new TestOutput();
    const terminal = new ProcessTerminal({ input, output });
    const received = [];
    terminal.start((value) => received.push(value), () => {});

    input.emit("data", "\x1b[?7u");
    assert.equal(terminal.kittyProtocolActive, true);
    assert.deepEqual(received, []);

    const draining = terminal.drainInput(50, 5);
    input.emit("data", "discarded");
    await draining;
    input.emit("data", "kept");

    assert.deepEqual(received, ["k", "e", "p", "t"]);
    assert.equal(output.writes.filter((value) => value === "\x1b[<u").length, 1);
    terminal.stop();
  });
});
