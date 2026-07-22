import assert from "node:assert/strict";
import test from "node:test";

import { decodeRpcLines, parseRpcInput } from "../../src/interfaces/rpc.js";
import { limitText } from "../../src/tools/output.js";
import { truncateToolHead, truncateToolTail } from "../../src/tools/truncate.js";
import {
  byteTail,
  byteTruncate,
  cellWidth,
  sanitizeTerminalText,
  truncateCells,
  wrapCells,
} from "../../src/tui/unicode.js";

function random(seed = 0x5eed1234): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const PIECES = [
  "a", "Z", " ", "\n", "\t", "\u0000", "\u001b[31m", "界", "é", "e\u0301",
  "🙂", "👩🏽‍💻", "🏳️‍🌈", "\u200d", "\u009f", "\r\n",
] as const;

function generatedText(next: () => number, maximumPieces = 96): string {
  const count = Math.floor(next() * maximumPieces);
  let value = "";
  for (let index = 0; index < count; index += 1) {
    value += PIECES[Math.floor(next() * PIECES.length)]!;
  }
  return value;
}

async function framed(chunks: readonly Uint8Array[]): Promise<string[]> {
  async function* source(): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) yield chunk;
  }
  const result: string[] = [];
  for await (const line of decodeRpcLines(source())) result.push(line);
  return result;
}

test("generated Unicode stays bounded across terminal and byte truncation helpers", () => {
  const next = random();
  for (let iteration = 0; iteration < 1_000; iteration += 1) {
    const value = generatedText(next);
    const sanitized = sanitizeTerminalText(value);
    assert.equal(sanitizeTerminalText(sanitized), sanitized);
    assert.doesNotMatch(sanitized, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u001b]/u);

    const cells = Math.floor(next() * 48);
    assert.ok(cellWidth(truncateCells(value, cells)) <= cells);
    for (const line of wrapCells(value, Math.max(1, cells))) {
      assert.ok(cellWidth(line) <= Math.max(1, cells));
    }

    const bytes = Math.floor(next() * 160);
    assert.ok(Buffer.byteLength(byteTruncate(value, bytes), "utf8") <= bytes);
    assert.ok(Buffer.byteLength(byteTail(value, bytes), "utf8") <= bytes);
    const limited = limitText(value, bytes);
    assert.ok(Buffer.byteLength(limited.text, "utf8") <= bytes);
    assert.equal(limited.truncated, Buffer.byteLength(value, "utf8") > bytes);
    if (!limited.truncated) assert.equal(limited.text, value);

    const maxLines = Math.max(1, Math.floor(next() * 12));
    const maxBytes = Math.max(1, Math.floor(next() * 96));
    for (const result of [
      truncateToolHead(value, { maxLines, maxBytes }),
      truncateToolTail(value, { maxLines, maxBytes }),
    ]) {
      assert.ok(result.outputLines <= maxLines);
      assert.ok(result.outputBytes <= maxBytes);
      assert.equal(result.totalBytes, Buffer.byteLength(value, "utf8"));
    }
  }
  assert.throws(() => limitText("value", -1), /non-negative safe integer/u);
});

test("generated RPC command lines survive arbitrary byte chunk boundaries", async () => {
  const next = random(0x12345678);
  for (let iteration = 0; iteration < 300; iteration += 1) {
    const type = `command-${iteration}-界`;
    const line = JSON.stringify({ id: `req_${iteration}`, type, payload: { text: generatedText(next, 24) } });
    const encoded = Buffer.from(`${line}\r\n`, "utf8");
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < encoded.length) {
      const length = Math.max(1, Math.floor(next() * 7));
      chunks.push(encoded.subarray(offset, Math.min(encoded.length, offset + length)));
      offset += length;
    }
    assert.deepEqual(await framed(chunks), [line]);
    assert.deepEqual(parseRpcInput(line), {
      id: `req_${iteration}`,
      type,
      payload: JSON.parse(line).payload,
    });
  }
});

test("RPC framing follows StringDecoder semantics at byte and UTF-8 boundaries", async () => {
  for (let length = 1; length <= 64; length += 1) {
    assert.deepEqual(await framed([Buffer.from(`${"x".repeat(length)}\n`)]), ["x".repeat(length)]);
  }
  assert.deepEqual(await framed([Buffer.from([0xf0, 0x9f, 0x0a])]), ["\ufffd"]);
  assert.throws(() => parseRpcInput(JSON.stringify({ id: 1, type: "get_state" })), /ID/u);
  assert.throws(() => parseRpcInput(JSON.stringify({ id: "req_1" })), /type/u);
});
