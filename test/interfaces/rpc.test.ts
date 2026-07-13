import assert from "node:assert/strict";
import test from "node:test";
import { decodeRpcLines, parseRpcRequest } from "../../src/interfaces/rpc.js";

test("RPC parser validates envelopes and preserves IDs", () => {
  assert.deepEqual(parseRpcRequest('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":1}}'), {
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
    params: { x: 1 },
  });
  assert.throws(() => parseRpcRequest("[]"), /object/u);
  assert.throws(() => parseRpcRequest('{"jsonrpc":"1.0","method":"x"}'), /Invalid/u);
  assert.throws(() => parseRpcRequest('{"jsonrpc":"2.0","id":1.5,"method":"x"}'), /ID/u);
});

test("RPC framing handles split CRLF and fails before buffering an oversized or invalid line", async () => {
  async function* chunks(values: Uint8Array[]): AsyncIterable<Uint8Array> {
    for (const value of values) yield value;
  }
  const lines: string[] = [];
  for await (const line of decodeRpcLines(chunks([
    Buffer.from('{"one":1}\r'),
    Buffer.from('\n{"two":2}\n'),
  ]), 64)) lines.push(line);
  assert.deepEqual(lines, ['{"one":1}', '{"two":2}']);

  await assert.rejects(async () => {
    for await (const _line of decodeRpcLines(chunks([Buffer.from("x".repeat(65))]), 64)) {
      // No line should be yielded.
    }
  }, /exceeds/u);
  await assert.rejects(async () => {
    for await (const _line of decodeRpcLines(chunks([Buffer.from([0xff, 0x0a])]), 64)) {
      // No line should be yielded.
    }
  }, /UTF-8/u);
});
