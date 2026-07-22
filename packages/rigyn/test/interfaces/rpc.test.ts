import assert from "node:assert/strict";
import test from "node:test";

import { decodeRpcLines, parseRpcInput, serializeJsonLine } from "../../src/interfaces/rpc.js";

test("RPC command parsing preserves exact string IDs and unknown command names", () => {
  assert.deepEqual(parseRpcInput('{"id":"req_7","type":"get_state"}'), {
    id: "req_7",
    type: "get_state",
  });
  assert.deepEqual(parseRpcInput('{"id":"req_unknown","type":"future_command","value":1}'), {
    id: "req_unknown",
    type: "future_command",
    value: 1,
  });
  assert.throws(() => parseRpcInput("[]"), /object/u);
  assert.throws(() => parseRpcInput('{"type":""}'), /non-empty/u);
  assert.throws(() => parseRpcInput('{"id":1,"type":"get_state"}'), /ID/u);
});

test("JSONL framing splits only on LF and preserves all other separators", async () => {
  async function* chunks(values: Uint8Array[]): AsyncIterable<Uint8Array> {
    for (const value of values) yield value;
  }
  const first = { type: "prompt", message: "line\u2028separator\u2029payload" };
  const serialized = serializeJsonLine(first);
  assert.equal(serialized.endsWith("\n"), true);
  assert.equal(serialized.slice(0, -1), JSON.stringify(first));

  const lines: string[] = [];
  for await (const line of decodeRpcLines(chunks([
    Buffer.from(serialized.slice(0, 7)),
    Buffer.from(`${serialized.slice(7, -1)}\r\n{"type":"abort"}\n`),
  ]))) lines.push(line);
  assert.deepEqual(lines, [JSON.stringify(first), '{"type":"abort"}']);
  assert.deepEqual(parseRpcInput(lines[0]!), first);
});

test("JSONL framing has no invented size or UTF-8 rejection policy", async () => {
  async function* chunks(values: Uint8Array[]): AsyncIterable<Uint8Array> {
    for (const value of values) yield value;
  }
  const large = "x".repeat(17 * 1024 * 1024);
  const lines: string[] = [];
  for await (const line of decodeRpcLines(chunks([
    Buffer.from(`${large}\nleft\rright\n`),
    Buffer.from([0xff, 0x0a]),
    Buffer.from("unterminated"),
  ]))) lines.push(line);
  assert.deepEqual(lines, [large, "left\rright", "\ufffd", "unterminated"]);
});
