import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { RpcClient } from "../../src/interfaces/rpc-client.js";

const cliPath = fileURLToPath(new URL("../fixtures/rpc-client-server.mjs", import.meta.url));

test("RPC client rejects a pending command immediately when the child exits", async () => {
  const client = new RpcClient({ cliPath, env: { RIGYN_RPC_FIXTURE_MODE: "exit" } });
  await client.start();
  await assert.rejects(client.getState(), /code=7/u);
  assert.equal(client.pendingRequestCount, 0);
  await client.stop();
});

test("promptAndWait subscribes before prompting and correlates command responses by ID", async () => {
  const client = new RpcClient({ cliPath });
  await client.start();
  try {
    const events = await client.promptAndWait("build it", undefined, 2_000);
    assert.deepEqual(events.map((event) => event.type), [
      "agent_start",
      "agent_end",
      "queued_follow_up_processed",
      "agent_settled",
    ]);
    assert.equal(client.pendingRequestCount, 0);
  } finally {
    await client.stop();
  }
});
