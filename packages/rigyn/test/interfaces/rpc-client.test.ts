import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { RpcClient } from "../../src/interfaces/rpc-client.js";
import type { RpcBashExecutionUpdate } from "../../src/interfaces/rpc-protocol.js";

const cliPath = fileURLToPath(new URL("../fixtures/rpc-client-server.mjs", import.meta.url));

test("RPC event waits reject invalid public timeouts before subscribing or prompting", async () => {
  const invalid = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648];
  const client = new RpcClient({ cliPath });
  for (const timeout of invalid) {
    await assert.rejects(
      async () => await client.waitForIdle(timeout),
      /timeout must be an integer from 0 to 2147483647/u,
    );
    await assert.rejects(
      async () => await client.collectEvents(timeout),
      /timeout must be an integer from 0 to 2147483647/u,
    );
    await assert.rejects(
      client.promptAndWait("must not submit", undefined, timeout),
      /timeout must be an integer from 0 to 2147483647/u,
    );
  }
  assert.equal(client.pendingRequestCount, 0);
  assert.equal(client.started, false);
});

test("RPC client rejects a pending command immediately when the child exits", async () => {
  const client = new RpcClient({ cliPath, env: { RIGYN_RPC_FIXTURE_MODE: "exit" } });
  await client.start();
  await assert.rejects(client.getState(), /code=7/u);
  assert.equal(client.pendingRequestCount, 0);
  await client.stop();
});

test("RPC client rejects event waiters when the child exits", async () => {
  const client = new RpcClient({ cliPath, env: { RIGYN_RPC_FIXTURE_MODE: "exit" } });
  await client.start();
  try {
    await Promise.all([
      assert.rejects(client.waitForIdle(1_000), /code=7/u),
      assert.rejects(client.collectEvents(1_000), /code=7/u),
    ]);
  } finally {
    await client.stop();
  }
});

test("RPC client retains a bounded stderr tail with an explicit truncation marker", async () => {
  const client = new RpcClient({ cliPath, env: { RIGYN_RPC_FIXTURE_MODE: "stderr-overflow" } });
  await client.start();
  await assert.rejects(client.getState(), /code=7/u);
  const stderr = client.getStderr();
  assert.ok(Buffer.byteLength(stderr, "utf8") <= 65 * 1024, String(Buffer.byteLength(stderr, "utf8")));
  assert.match(stderr, /stderr truncated/iu);
  assert.match(stderr, /retained-tail-marker/u);
  assert.doesNotMatch(stderr, /discarded-prefix/u);
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

test("RPC event consumers cannot suppress delivery to later consumers", async () => {
  const client = new RpcClient({ cliPath });
  await client.start();
  const off = client.onEvent(() => { throw new Error("consumer failed"); });
  try {
    const events = await client.promptAndWait("keep delivering", undefined, 1_000);
    assert.equal(events.at(-1)?.type, "agent_settled");
  } finally {
    off();
    await client.stop();
  }
});

test("RPC client prompt helpers serialize the public image shape unchanged", async () => {
  const client = new RpcClient({ cliPath, env: { RIGYN_RPC_FIXTURE_MODE: "image-echo" } });
  await client.start();
  const commands: Array<Record<string, unknown>> = [];
  const off = client.onEvent((event) => {
    const record = event as unknown as Record<string, unknown>;
    if (record["type"] !== "fixture_command_received") return;
    commands.push(record["command"] as Record<string, unknown>);
  });
  const waitForSettled = (): Promise<void> => new Promise((resolve) => {
    const stop = client.onEvent((event) => {
      if (event.type !== "agent_settled") return;
      stop();
      resolve();
    });
  });
  const image = { type: "image" as const, mimeType: "image/png", data: "AA==" };
  try {
    const directSettled = waitForSettled();
    await client.prompt("direct", [image]);
    await directSettled;
    await client.steer("redirect", [image]);
    await client.followUp("later", [image]);
    await client.promptAndWait("wait", [image], 2_000);

    assert.deepEqual(commands.map((command) => ({
      type: command["type"],
      message: command["message"],
      images: command["images"],
    })), [
      { type: "prompt", message: "direct", images: [image] },
      { type: "steer", message: "redirect", images: [image] },
      { type: "follow_up", message: "later", images: [image] },
      { type: "prompt", message: "wait", images: [image] },
    ]);
  } finally {
    off();
    await client.stop();
  }
});

test("promptAndWait disposes its event waiter when prompt submission fails", async () => {
  const client = new RpcClient({ cliPath });

  await assert.rejects(client.promptAndWait("cannot start", undefined, 10), /Start the RPC client/u);
  await delay(30);
});

test("RPC client delivers correlated bash updates before resolving the command", async () => {
  const client = new RpcClient({ cliPath });
  await client.start();
  const updates: RpcBashExecutionUpdate[] = [];
  const off = client.onEvent((event) => {
    if (event.type === "bash_execution_update") updates.push(event as RpcBashExecutionUpdate);
  });
  try {
    assert.deepEqual(await client.bash("printf fixture"), {
      output: "fixture output",
      exitCode: 0,
      cancelled: false,
      truncated: false,
    });
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.delta, "fixture output");
    assert.match(updates[0]?.id ?? "", /^req_/u);
  } finally {
    off();
    await client.stop();
  }
});

test("RPC client ignores unmatched response envelopes", async () => {
  const client = new RpcClient({ cliPath, env: { RIGYN_RPC_FIXTURE_MODE: "unmatched" } });
  await client.start();
  const events: string[] = [];
  const settled = new Promise<void>((resolve) => {
    client.onEvent((event) => {
      events.push(event.type);
      if (event.type === "agent_settled") resolve();
    });
  });
  try {
    await client.abort();
    await settled;
    assert.deepEqual(events, ["agent_settled"]);
  } finally {
    await client.stop();
  }
});

test("RPC client sends typed one-way extension UI responses", async () => {
  const client = new RpcClient({ cliPath });
  await client.start();
  try {
    const received = new Promise<Record<string, unknown>>((resolve) => {
      const off = client.onEvent((event) => {
        const record = event as unknown as Record<string, unknown>;
        if (record.type !== "extension_ui_received") return;
        off();
        resolve(record);
      });
    });
    await client.respondToExtensionUi({
      type: "extension_ui_response",
      id: "ui-select",
      value: "selected",
    });
    assert.deepEqual(await received, {
      type: "extension_ui_received",
      response: {
        type: "extension_ui_response",
        id: "ui-select",
        value: "selected",
      },
    });
    assert.equal(client.pendingRequestCount, 0);
  } finally {
    await client.stop();
  }
});

test("RPC client returns the complete provider model contract", async () => {
  const client = new RpcClient({ cliPath });
  await client.start();
  try {
    const models = await client.getAvailableModels();
    assert.deepEqual(
      models.map(({ provider, id, contextWindow, reasoning }) => ({
        provider,
        id,
        contextWindow,
        reasoning,
      })),
      [{
        provider: "fixture",
        id: "fixture-model",
        contextWindow: 128_000,
        reasoning: true,
      }],
    );
    assert.equal(models[0]?.name, "Fixture model");
    assert.equal(models[0]?.api, "openai-responses");
    assert.deepEqual(models[0]?.cost, {
      input: 1,
      output: 2,
      cacheRead: 0.5,
      cacheWrite: 1.5,
    });
    assert.equal(models[0]?.maxTokens, 8_192);
  } finally {
    await client.stop();
  }
});

test("RPC client exposes suspended-run recovery commands", async () => {
  const client = new RpcClient({ cliPath });
  await client.start();
  try {
    assert.deepEqual(await client.getRecoveryStatus(), {
      operationId: "operation-fixture",
      acceptedAt: "2026-01-01T00:00:00.000Z",
      cancelled: false,
      attempts: 1,
      claimedQueueIds: [],
      effects: [],
    });
    assert.deepEqual(await client.recoverInterruptedRun([{
      effectId: "effect-client",
      outcome: "abandoned",
    }]), {
      recovered: true,
      operationId: "effect-client",
      blocked: [],
    });
  } finally {
    await client.stop();
  }
});

test("RPC client exposes bounded history pages and reconstructs complete history", async () => {
  const client = new RpcClient({ cliPath, env: { RIGYN_RPC_FIXTURE_MODE: "pagination" } });
  await client.start();
  try {
    const treePage = await client.getTreePage({ limit: 1 });
    assert.equal(treePage.tree[0]?.entry.id, "tree-1");
    assert.equal(treePage.hasMore, true);
    assert.equal(treePage.nextCursor, "tree-page-2");

    const completeTree = await client.getTree();
    assert.equal(completeTree.leafId, "tree-3");
    assert.equal(completeTree.tree.length, 1);
    assert.equal(completeTree.tree[0]?.entry.id, "tree-1");
    assert.equal(completeTree.tree[0]?.children[0]?.entry.id, "tree-2");
    assert.equal(completeTree.tree[0]?.children[0]?.children[0]?.entry.id, "tree-3");

    const messagePage = await client.getMessagesPage({ limit: 1 });
    assert.equal(messagePage.messages.length, 1);
    assert.equal(messagePage.hasMore, true);
    assert.equal(messagePage.nextCursor, "message-page-2");
    assert.deepEqual(await client.getMessages(), [
      { role: "user", content: [{ type: "text", text: "one" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "two" }], timestamp: 2 },
    ]);

    const entryPage = await client.getEntriesPage({ limit: 1 });
    assert.equal(entryPage.entries[0]?.id, "entry-1");
    assert.equal(entryPage.hasMore, true);
    const entryHistory = await client.getEntries();
    assert.deepEqual(entryHistory.entries.map((entry) => entry.id), ["entry-1", "entry-2"]);
    assert.equal(entryHistory.leafId, "entry-2");
  } finally {
    await client.stop();
  }
});
