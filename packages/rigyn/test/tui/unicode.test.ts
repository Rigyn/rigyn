import assert from "node:assert/strict";
import test from "node:test";
import { byteTail, cellWidth, sanitizeTerminalText, splitGraphemes, truncateCells, wrapCells } from "../../src/tui/unicode.js";

test("Unicode helpers preserve grapheme clusters and terminal cell widths", () => {
  assert.deepEqual(splitGraphemes("a👨‍👩‍👧‍👦e\u0301"), ["a", "👨‍👩‍👧‍👦", "e\u0301"]);
  assert.equal(cellWidth("a界🙂"), 5);
  assert.equal(cellWidth("🇨"), 2);
  assert.equal(cellWidth("🇨🇦"), 2);
  assert.equal(truncateCells("alpha界omega", 8), "alpha界…");
  assert.equal(byteTail("old界🙂latest", 10), "🙂latest");
  assert.deepEqual(wrapCells("ab界cd", 4), ["ab界", "cd"]);
});

test("cell wrapping moves whole words before splitting an overlong token", () => {
  assert.deepEqual(wrapCells("model commands and resources", 14), ["model commands", "and resources"]);
  assert.deepEqual(wrapCells("extraordinary", 5), ["extra", "ordin", "ary"]);
});

test("untrusted terminal text cannot inject ANSI or control sequences", () => {
  const unsafe = "ok\u001b[2J\u001b]0;owned\u0007\nnext\u0000\tvalue";
  assert.equal(sanitizeTerminalText(unsafe), "ok\nnext    value");
});

test("terminal text normalizes CRLF, bare carriage returns, and tabs before wrapping", () => {
  assert.equal(sanitizeTerminalText("first\r\nsecond\rthird\tfourth"), "first\nsecond\nthird    fourth");
  assert.deepEqual(wrapCells("first\r\nsecond\rthird\tfourth", 80), [
    "first",
    "second",
    "third    fourth",
  ]);
});
