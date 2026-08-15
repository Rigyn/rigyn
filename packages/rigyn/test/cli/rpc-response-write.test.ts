import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import { sendRpcCommandResponse } from "../../src/cli/rpc.js";
import { MAX_RPC_LINE_BYTES, RpcWriter } from "../../src/interfaces/rpc.js";

test("the installed RPC writer correlates an oversized response failure", async () => {
  let output = "";
  const writer = new RpcWriter(new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  }));

  await sendRpcCommandResponse(writer, { id: "oversized-state", type: "get_state" }, {
    value: "x".repeat(MAX_RPC_LINE_BYTES),
  });

  assert.ok(Buffer.byteLength(output, "utf8") <= MAX_RPC_LINE_BYTES + 1);
  assert.deepEqual(JSON.parse(output), {
    id: "oversized-state",
    type: "response",
    command: "get_state",
    success: false,
    error: "Failed to send response: RPC line exceeded 16777216 bytes",
  });
});

test("the installed RPC writer bounds transport failure details", async () => {
  const records: unknown[] = [];
  let attempts = 0;
  await sendRpcCommandResponse({
    async send(value) {
      attempts += 1;
      if (attempts === 1) throw new Error("x".repeat(MAX_RPC_LINE_BYTES));
      records.push(value);
    },
  }, { id: "bounded", type: "get_state" }, { success: true });

  assert.equal(attempts, 2);
  const fallback = records[0] as { error?: string };
  assert.ok((fallback.error?.length ?? 0) < 4_200);
  assert.match(fallback.error ?? "", /^Failed to send response: x+\.\.\.$/u);
});
