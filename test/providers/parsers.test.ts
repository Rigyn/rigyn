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
