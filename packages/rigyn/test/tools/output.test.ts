import assert from "node:assert/strict";
import test from "node:test";

import { escapeTerminal, limitText } from "../../src/tools/output.js";

test("text limits never split UTF-8 code points at either retained edge", () => {
  assert.deepEqual(limitText("🙂x", 1), {
    text: "",
    truncated: true,
    omittedBytes: 5,
  });

  const input = `${"🙂".repeat(40)} middle ${"界".repeat(40)}`;
  const result = limitText(input, 128);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 128);
  assert.equal(result.omittedBytes, Buffer.byteLength(input) -
    Buffer.byteLength(result.text.replace(/\n… \d+ bytes omitted …\n/u, "")));
  assert.doesNotMatch(result.text, /\ufffd/u);
});

test("terminal escaping preserves layout text and exposes control characters", () => {
  assert.equal(
    escapeTerminal("line\tone\nline\r\u001b[31m\u0000\u007f\u009f🙂"),
    "line\tone\nline\r\\x1b[31m\\u{0}\\u{7f}\\u{9f}\\u{1f642}",
  );
});
