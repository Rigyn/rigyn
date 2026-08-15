import assert from "node:assert/strict";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import {
  MAX_RPC_LINE_BYTES,
  RpcWriter,
  attachJsonlLineReader,
  decodeRpcLines,
  parseRpcInput,
  serializeJsonLine,
} from "../../src/interfaces/rpc.js";

async function decodedLines(values: readonly (string | Uint8Array)[]): Promise<string[]> {
  async function* chunks(): AsyncIterable<string | Uint8Array> {
    for (const value of values) yield value;
  }
  const lines: string[] = [];
  for await (const line of decodeRpcLines(chunks())) lines.push(line);
  return lines;
}

async function attachedLines(values: readonly (string | Uint8Array)[]): Promise<string[]> {
  const stream = Readable.from(values);
  const lines: string[] = [];
  attachJsonlLineReader(stream, (line) => lines.push(line));
  await once(stream, "end");
  return lines;
}

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

test("both JSONL readers share the byte cap and framing edge behavior", async () => {
  const exact = "x".repeat(MAX_RPC_LINE_BYTES);
  const unicode = Buffer.from("one-界-two\r\nunterminated-🙂", "utf8");
  const unicodeChunks = [
    unicode.subarray(0, 5),
    unicode.subarray(5, 7),
    unicode.subarray(7, unicode.length - 2),
    unicode.subarray(unicode.length - 2),
  ];
  const values = [
    exact.slice(0, MAX_RPC_LINE_BYTES - 1),
    `${exact.slice(-1)}\r`,
    "\n",
    ...unicodeChunks,
  ];
  const expected = [exact, "one-界-two", "unterminated-🙂"];
  assert.deepEqual(await decodedLines(values), expected);
  assert.deepEqual(await attachedLines(values), expected);

  await assert.rejects(
    decodedLines([Buffer.alloc(MAX_RPC_LINE_BYTES, 120), Buffer.from("x")]),
    new RegExp(`RPC line exceeded ${MAX_RPC_LINE_BYTES} bytes`, "u"),
  );

  const stream = new Readable({ read() {} });
  let readerError: Error | undefined;
  attachJsonlLineReader(stream, () => undefined, (error) => { readerError = error; });
  stream.emit("data", Buffer.alloc(MAX_RPC_LINE_BYTES, 120));
  assert.doesNotThrow(() => stream.emit("data", Buffer.from("x")));
  assert.match(
    readerError?.message ?? "",
    new RegExp(`RPC line exceeded ${MAX_RPC_LINE_BYTES} bytes`, "u"),
  );
  assert.equal(stream.destroyed, true);
});

test("the JSONL reader contains hostile values thrown by its line callback", () => {
  const hostile = new Proxy(Object.create(null) as object, {
    getPrototypeOf() { throw new Error("prototype trap must not run"); },
    get() { throw new Error("property trap must not run"); },
  });
  const stream = new Readable({ read() {} });
  let readerError: Error | undefined;
  attachJsonlLineReader(stream, () => { throw hostile; }, (error) => { readerError = error; });

  assert.doesNotThrow(() => stream.emit("data", Buffer.from("line\n")));
  assert.equal(readerError?.message, "[Thrown object]");
  assert.equal(stream.destroyed, true);
});

test("RPC serialization enforces the shared byte cap before writing", async () => {
  const emptyBytes = Buffer.byteLength(JSON.stringify({ value: "" }), "utf8");
  const exact = { value: "x".repeat(MAX_RPC_LINE_BYTES - emptyBytes) };
  assert.equal(Buffer.byteLength(serializeJsonLine(exact), "utf8"), MAX_RPC_LINE_BYTES + 1);
  assert.throws(
    () => serializeJsonLine({ value: `${exact.value}界\r\n` }),
    new RegExp(`RPC line exceeded ${MAX_RPC_LINE_BYTES} bytes`, "u"),
  );

  let writes = 0;
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      writes += 1;
      callback();
    },
  });
  const writer = new RpcWriter(output);
  let rejected: Promise<void> | undefined;
  assert.doesNotThrow(() => { rejected = writer.send({ value: `${exact.value}x` }); });
  await assert.rejects(rejected!, new RegExp(`RPC line exceeded ${MAX_RPC_LINE_BYTES} bytes`, "u"));
  assert.equal(writes, 0);
});
