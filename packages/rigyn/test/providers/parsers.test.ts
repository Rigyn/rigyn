import assert from "node:assert/strict";
import test from "node:test";
import { decodeNDJSON } from "../../src/providers/ndjson.js";
import { decodeSSE } from "../../src/providers/sse.js";
import { byteChunks, readable } from "./helpers.js";

test("SSE decoder handles comments, multiline data, CRLF, unicode splits, and EOF dispatch", async () => {
  const source =
    ": keepalive\r\nid: evt-1\r\nevent: token\r\ndata: hello\r\ndata: 🌍\r\nretry: 15\r\n\r\ndata: tail";
  const events = [];
  for await (const event of decodeSSE(readable(byteChunks(source)))) events.push(event);

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    data: "hello\n🌍",
    event: "token",
    id: "evt-1",
    retry: 15,
    raw: ["id: evt-1", "event: token", "data: hello", "data: 🌍", "retry: 15"],
  });
  assert.deepEqual(events[1], { data: "tail", id: "evt-1", raw: ["data: tail"] });
});

test("SSE replacement decoding preserves valid UTF-8 split across byte boundaries", async () => {
  const events = [];
  for await (const event of decodeSSE(readable(byteChunks("data: 🌍漢字\n\n")))) events.push(event);

  assert.deepEqual(events, [{ data: "🌍漢字", raw: ["data: 🌍漢字"] }]);
});

test("SSE replacement decoding accepts malformed and truncated UTF-8", async (t) => {
  await t.test("malformed sequence", async () => {
    const events = [];
    const bytes = Uint8Array.from([
      ...new TextEncoder().encode("data: bad "),
      0xc3,
      0x28,
      0x0a,
      0x0a,
    ]);
    for await (const event of decodeSSE(readable(byteChunks(bytes)))) events.push(event);
    assert.deepEqual(events, [{ data: "bad �(", raw: ["data: bad �("] }]);
  });

  await t.test("truncated sequence at EOF", async () => {
    const events = [];
    const bytes = Uint8Array.from([
      ...new TextEncoder().encode("data: tail "),
      0xe2,
      0x82,
    ]);
    for await (const event of decodeSSE(readable(byteChunks(bytes)))) events.push(event);
    assert.deepEqual(events, [{ data: "tail �", raw: ["data: tail �"] }]);
  });
});

test("SSE decoder bounds the whole stream including comments", async () => {
  await assert.rejects(async () => {
    for await (const _event of decodeSSE(readable(byteChunks(": long keepalive\n\ndata: ok\n\n")), {
      maxStreamBytes: 8,
    })) {
      // Consume the stream.
    }
  }, /SSE stream exceeded 8 bytes/);
});

test("NDJSON decoder handles one-byte chunks and a final unterminated line", async () => {
  const values = [];
  for await (const value of decodeNDJSON(readable(byteChunks('{"text":"🌍"}\r\n{"done":true}')))) {
    values.push(value);
  }
  assert.deepEqual(values, [{ text: "🌍" }, { done: true }]);
});

test("NDJSON decoder rejects malformed lines instead of silently dropping them", async () => {
  await assert.rejects(async () => {
    for await (const _value of decodeNDJSON(readable(byteChunks('{"ok":true}\nnot-json\n')))) {
      // Consume the stream.
    }
  }, /Malformed NDJSON line/);
});

test("NDJSON decoder continues to reject malformed UTF-8", async () => {
  await assert.rejects(async () => {
    const bytes = Uint8Array.from([...new TextEncoder().encode('{"text":"'), 0xc3, 0x28, 0x22, 0x7d, 0x0a]);
    for await (const _value of decodeNDJSON(readable(byteChunks(bytes)))) {
      // Consume the stream.
    }
  }, /Stream contained invalid UTF-8/);
});
