import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
