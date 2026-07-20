import assert from "node:assert/strict";
import test from "node:test";
import { KeyDecoder } from "../../src/tui/keys.js";

test("key decoder handles fragmented escape sequences and modifiers", () => {
  const decoder = new KeyDecoder();
  assert.deepEqual(decoder.push("\u001b["), []);
  assert.deepEqual(decoder.push("A"), [{ key: "up" }]);
  assert.deepEqual(decoder.push("\u001b[1;5D"), [{ key: "left", ctrl: true }]);
  assert.deepEqual(decoder.push("\u001b[112;6u"), [{ key: "p", ctrl: true, shift: true }]);
  assert.deepEqual(decoder.push("\u001bm"), [{ key: "m", text: "m", alt: true }]);
  assert.deepEqual(decoder.push("\u001b"), []);
  assert.deepEqual(decoder.flushEscape(), [{ key: "escape" }]);
});

test("key decoder preserves fragmented UTF-8 and bracketed multiline paste", () => {
  const decoder = new KeyDecoder();
  const emoji = Buffer.from("🙂");
  assert.deepEqual(decoder.push(emoji.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(emoji.subarray(2)), [{ key: "text", text: "🙂" }]);
  assert.deepEqual(decoder.push("\u001b[200~one\n"), []);
  assert.deepEqual(decoder.push("two\u001b[20"), []);
  assert.deepEqual(decoder.push("1~"), [{ key: "paste", text: "one\ntwo" }]);
});

test("key decoder distinguishes submit, multiline, control, and delete keys", () => {
  const decoder = new KeyDecoder();
  assert.deepEqual(decoder.push(Buffer.from([13, 10, 3, 127])), [
    { key: "enter" },
    { key: "newline", ctrl: true },
    { key: "c", ctrl: true },
    { key: "backspace" },
  ]);
});

test("key decoder rejects unbounded escape sequences and bracketed paste", () => {
  const sequence = new KeyDecoder();
  assert.throws(() => sequence.push(`\u001b[${"1".repeat(5_000)}`), /sequence is too large/u);

  const paste = new KeyDecoder();
  assert.throws(
    () => paste.push(`\u001b[200~${"x".repeat(4 * 1024 * 1024 + 1)}\u001b[201~`),
    /paste exceeds/u,
  );

  const completeSequence = new KeyDecoder();
  assert.throws(() => completeSequence.push(`\u001b[${"1".repeat(5_000)}A`), /sequence is too large/u);
});

test("key decoder handles Kitty event types, alternate layouts, associated text, and extended modifiers", () => {
  const decoder = new KeyDecoder();
  assert.deepEqual(decoder.push("\u001b[97:65;2:2u"), [{
    key: "text",
    text: "A",
    shift: true,
    alternateKey: "A",
    eventType: "repeat",
  }]);
  assert.deepEqual(decoder.push("\u001b[1091::99;13:1u"), [{
    key: "c",
    ctrl: true,
    super: true,
    baseLayoutKey: "c",
    eventType: "press",
  }]);
  assert.deepEqual(decoder.push("\u001b[120;49u"), [{ key: "x", hyper: true, meta: true }]);
  assert.deepEqual(decoder.push("\u001b[0;1;229u"), [{ key: "text", text: "å" }]);
  assert.deepEqual(decoder.push("\u001b[99;5:3u"), []);
});

test("key decoder consumes fragmented protocol replies instead of exposing them as keys", () => {
  const decoder = new KeyDecoder();
  assert.deepEqual(decoder.push("\u001b[?"), []);
  assert.deepEqual(decoder.push("5u\u001b[?1;"), []);
  assert.deepEqual(decoder.takeReplies(), [{ type: "kitty_keyboard", flags: 5 }]);
  assert.deepEqual(decoder.push("2c"), []);
  assert.deepEqual(decoder.takeReplies(), [{ type: "primary_device_attributes" }]);
  assert.deepEqual(decoder.push("\u001b[?997;2n\u001b]11;rgb:0000/0000/0000\u0007"), []);
  assert.deepEqual(decoder.takeReplies(), [
    { type: "color_scheme", scheme: "light" },
    { type: "background_color", color: { red: 0, green: 0, blue: 0 } },
  ]);
  assert.deepEqual(decoder.push("ok"), [{ key: "text", text: "o" }, { key: "text", text: "k" }]);
});

test("key decoder covers legacy function, rxvt, Linux-console, and modify-other-keys forms", () => {
  const decoder = new KeyDecoder();
  assert.deepEqual(decoder.push("\u001bOP\u001bOR\u001b[15~\u001b[[A"), [
    { key: "f1" }, { key: "f3" }, { key: "f5" }, { key: "f1" },
  ]);
  assert.deepEqual(decoder.push("\u001b[a\u001bOa\u001b[5$\u001b[6^"), [
    { key: "up", shift: true },
    { key: "up", ctrl: true },
    { key: "pageup", shift: true },
    { key: "pagedown", ctrl: true },
  ]);
  assert.deepEqual(decoder.push("\u001b[27;6;112~"), [{ key: "p", ctrl: true, shift: true }]);
});

test("key decoder preserves keypad identity while retaining normal editing behavior", () => {
  const decoder = new KeyDecoder();
  assert.deepEqual(decoder.push("\u001bOp\u001bOM"), [
    { key: "text", text: "0", keypad: true },
    { key: "enter", keypad: true },
  ]);
  assert.deepEqual(decoder.push("\u001b[57414;1u\u001b[57417;5u"), [
    { key: "enter", keypad: true },
    { key: "left", keypad: true, ctrl: true },
  ]);
});

test("key decoder suppresses an adjacent legacy duplicate after enhanced input", () => {
  const decoder = new KeyDecoder();
  assert.deepEqual(decoder.push("\u001b[99;5u\u0003\u0004"), [
    { key: "c", ctrl: true },
    { key: "d", ctrl: true },
  ]);
  assert.deepEqual(decoder.push("\u001b]11;rgb:00/00/00\u0007text"), [
    { key: "text", text: "t" },
    { key: "text", text: "e" },
    { key: "text", text: "x" },
    { key: "text", text: "t" },
  ]);
});

test("key decoder safely expires an incomplete query sequence", () => {
  const decoder = new KeyDecoder();
  decoder.push("\u001b[?12");
  assert.equal(decoder.pendingSequence, true);
  assert.deepEqual(decoder.flushPending(), []);
  assert.equal(decoder.pendingSequence, false);
});
