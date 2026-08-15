import assert from "node:assert/strict";
import test from "node:test";
import { TerminalInputBuffer } from "../../src/tui/input-buffer.js";

test("terminal input buffer reassembles UTF-8, CSI, SS3, and terminal replies", () => {
  const input = new TerminalInputBuffer();
  const emoji = Buffer.from("🙂");
  assert.deepEqual(input.push(emoji.subarray(0, 2)), []);
  assert.deepEqual(input.push(emoji.subarray(2)), [{ type: "text", value: "🙂" }]);
  assert.deepEqual(input.push("\u001b[?"), []);
  assert.equal(input.pendingSequence, true);
  assert.deepEqual(input.push("7u\u001bO"), [{ type: "sequence", value: "\u001b[?7u", complete: true }]);
  assert.deepEqual(input.push("P"), [{ type: "sequence", value: "\u001bOP", complete: true }]);
});

test("terminal input buffer keeps OSC, DCS, APC, and PM controls atomic", () => {
  const input = new TerminalInputBuffer();
  assert.deepEqual(input.push("\u001b]11;rgb:00/00"), []);
  assert.deepEqual(input.push("/00\u0007x"), [
    { type: "sequence", value: "\u001b]11;rgb:00/00/00\u0007", complete: true },
    { type: "text", value: "x" },
  ]);
  assert.deepEqual(input.push("\u001bP1+r\u001b\\\u001b_payload\u001b\\\u001b^notice\u001b\\"), [
    { type: "sequence", value: "\u001bP1+r\u001b\\", complete: true },
    { type: "sequence", value: "\u001b_payload\u001b\\", complete: true },
    { type: "sequence", value: "\u001b^notice\u001b\\", complete: true },
  ]);
});

test("terminal input buffer isolates fragmented bracketed paste from controls", () => {
  const input = new TerminalInputBuffer();
  assert.deepEqual(input.push("\u001b[200~one\u001b]not-a-query"), []);
  assert.deepEqual(input.push("\n\u001b[20"), []);
  assert.deepEqual(input.push("1~after"), [
    { type: "paste", value: "one\u001b]not-a-query\n" },
    { type: "text", value: "a" },
    { type: "text", value: "f" },
    { type: "text", value: "t" },
    { type: "text", value: "e" },
    { type: "text", value: "r" },
  ]);
});

test("terminal input buffer times out incomplete controls without replaying them as text", () => {
  const input = new TerminalInputBuffer();
  input.push("\u001b[?12");
  assert.deepEqual(input.flushPending(), [{ type: "sequence", value: "\u001b[?12", complete: false }]);
  assert.deepEqual(input.push("a"), [{ type: "text", value: "a" }]);
  input.push("\u001b");
  assert.equal(input.pendingEscape, true);
  assert.deepEqual(input.flushPending(), [{ type: "sequence", value: "\u001b", complete: true }]);
});

test("terminal input buffer keeps adjacent Escape presses distinct", () => {
  const input = new TerminalInputBuffer();
  assert.deepEqual(input.push("\u001b\u001b"), [{ type: "sequence", value: "\u001b", complete: true }]);
  assert.equal(input.pendingEscape, true);
  assert.deepEqual(input.flushPending(), [{ type: "sequence", value: "\u001b", complete: true }]);
});

test("terminal input buffer bounds unterminated control strings and paste", () => {
  const control = new TerminalInputBuffer();
  assert.throws(() => control.push(`\u001b]${"x".repeat(4 * 1024 + 1)}`), /sequence is too large/u);

  const paste = new TerminalInputBuffer();
  assert.throws(() => paste.push(`\u001b[200~${"x".repeat(4 * 1024 * 1024 + 1)}`), /paste exceeds/u);
});
