import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ImageContent } from "@rigyn/models";
import { RpcClient } from "../../src/interfaces/rpc-client.js";

const cliPath = fileURLToPath(new URL("../fixtures/rpc-client-black-box-server.mjs", import.meta.url));

function clientFor(mode: string, env: Record<string, string> = {}): RpcClient {
  return new RpcClient({ cliPath, env: { RIGYN_RPC_FIXTURE_MODE: mode, ...env } });
}

async function eventually(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail(message);
}

test("every public RPC command method writes exactly its intended command", async () => {
  const client = clientFor("audit");
  const received: string[] = [];
  let resolveComplete = (): void => {};
  const complete = new Promise<void>((resolve) => { resolveComplete = resolve; });
  const off = client.onEvent((event) => {
    const record = event as unknown as Record<string, unknown>;
    if (record["type"] !== "fixture_command_received") return;
    const command = record["command"] as Record<string, unknown>;
    received.push(String(command["type"]));
    if (received.length === 38) resolveComplete();
  });
  await client.start();
  try {
    await client.prompt("prompt");
    await client.steer("steer");
    await client.followUp("follow up");
    await client.abort();
    await client.newSession();
    await client.getState();
    await client.getRecoveryStatus();
    await client.recoverInterruptedRun();
    await client.setModel("fixture", "fixture-model");
    await client.cycleModel();
    await client.getAvailableModels();
    await client.setThinkingLevel("off");
    await client.cycleThinkingLevel();
    await client.getAvailableThinkingLevels();
    await client.setSteeringMode("all");
    await client.setFollowUpMode("one-at-a-time");
    await client.compact();
    await client.setAutoCompaction(true);
    await client.setAutoRetry(true);
    await client.abortRetry();
    await client.bash("true");
    await client.abortBash();
    await client.getSessionStats();
    await client.exportHtml();
    await client.switchSession("fixture-session");
    await client.fork("fixture-entry");
    await client.clone();
    await client.getForkMessages();
    await client.getEntriesPage();
    await client.getEntries();
    await client.getTreePage();
    await client.getTree();
    await client.getLastAssistantText();
    await client.setSessionName("fixture");
    await client.getMessagesPage();
    await client.getMessages();
    await client.getCommands();
    await client.respondToExtensionUi({ type: "extension_ui_response", id: "ui", cancelled: true });
    await complete;

    assert.deepEqual(received, [
      "prompt",
      "steer",
      "follow_up",
      "abort",
      "new_session",
      "get_state",
      "get_recovery_status",
      "recover_interrupted_run",
      "set_model",
      "cycle_model",
      "get_available_models",
      "set_thinking_level",
      "cycle_thinking_level",
      "get_available_thinking_levels",
      "set_steering_mode",
      "set_follow_up_mode",
      "compact",
      "set_auto_compaction",
      "set_auto_retry",
      "abort_retry",
      "bash",
      "abort_bash",
      "get_session_stats",
      "export_html",
      "switch_session",
      "fork",
      "clone",
      "get_fork_messages",
      "get_entries",
      "get_entries",
      "get_tree",
      "get_tree",
      "get_last_assistant_text",
      "set_session_name",
      "get_messages",
      "get_messages",
      "get_commands",
      "extension_ui_response",
    ]);
  } finally {
    off();
    await client.stop();
  }
});

test("start uses child spawn readiness and reports pre-spawn errors", async () => {
  const client = clientFor("hold");
  const startedAt = performance.now();
  await client.start();
  assert.equal(client.started, true);
  assert.ok(performance.now() - startedAt < 500, "start waited for output instead of the spawn event");
  await client.stop();
  assert.equal(client.started, false);

  const missingCwd = join(tmpdir(), `rigyn-rpc-missing-${process.pid}-${Date.now()}`);
  const broken = new RpcClient({ cliPath, cwd: missingCwd });
  await assert.rejects(broken.start(), /startup failed|ENOENT|spawn/iu);
  assert.equal(broken.started, false);
  await broken.stop();
});

test("exited children are not reported as started and stop remains safe", async () => {
  const client = new RpcClient({
    cliPath: fileURLToPath(new URL("../fixtures/rpc-client-server.mjs", import.meta.url)),
    env: { RIGYN_RPC_FIXTURE_MODE: "exit" },
  });
  await client.start();
  await assert.rejects(client.getState(), /code=7/u);
  assert.equal(client.started, false);
  await client.start();
  assert.equal(client.started, true);
  await Promise.all([client.stop(), client.stop()]);
});

test("start racing stop is bounded, idempotent, and restartable", async () => {
  const client = clientFor("hold");
  const starting = client.start();
  const firstStop = client.stop();
  const secondStop = client.stop();
  await assert.rejects(starting, /stopped|ended|startup/iu);
  await Promise.all([firstStop, secondStop]);
  assert.equal(client.started, false);

  await client.start();
  assert.equal(client.started, true);
  await client.stop();
});

test("correlated response mismatches and malformed records disconnect the broker", async () => {
  for (const [mode, expected] of [
    ["mismatch", /command did not match get_state/u],
    ["malformed-matching", /invalid RPC response/u],
    ["missing-data", /response data did not match get_state/u],
    ["invalid-json", /invalid JSON/u],
  ] as const) {
    const client = clientFor(mode);
    await client.start();
    try {
      await assert.rejects(client.getState(), expected);
      assert.equal(client.pendingRequestCount, 0);
    } finally {
      await client.stop();
    }
  }
});

test("unmatched malformed responses are ignored and unknown events remain observable", async () => {
  const unmatched = clientFor("unmatched-malformed");
  await unmatched.start();
  try {
    await unmatched.getState();
    assert.equal(unmatched.pendingRequestCount, 0);
  } finally {
    await unmatched.stop();
  }

  const future = clientFor("unknown-event");
  const observed: Array<Record<string, unknown>> = [];
  const off = future.onEvent((event) => observed.push(event as unknown as Record<string, unknown>));
  await future.start();
  try {
    await future.getState();
    assert.deepEqual(observed, [{ type: "future_event", payload: "preserved" }]);
  } finally {
    off();
    await future.stop();
  }
});

test("the request broker rejects work beyond its concurrent pending limit", async () => {
  const client = clientFor("hold");
  await client.start();
  const pending = Array.from({ length: 64 }, () => client.getState().catch((error: unknown) => error));
  try {
    assert.equal(client.pendingRequestCount, 64);
    await assert.rejects(client.getState(), /cannot exceed 64 pending requests/u);
    assert.equal(client.pendingRequestCount, 64);
  } finally {
    await client.stop();
    await Promise.all(pending);
  }
  assert.equal(client.pendingRequestCount, 0);
});

test("event waiters and retained event collections have independent count and byte limits", async () => {
  const held = clientFor("hold");
  await held.start();
  const waiters = Array.from({ length: 256 }, () => held.waitForIdle().catch((error: unknown) => error));
  assert.throws(() => held.waitForIdle(), /cannot exceed 256 concurrent event waiters/u);
  await held.stop();
  await Promise.all(waiters);

  for (const mode of ["events-count", "events-bytes"] as const) {
    const client = clientFor(mode);
    await client.start();
    try {
      const exceeded = assert.rejects(
        client.collectEvents(10_000),
        /retention limit.*onEvent/u,
      );
      await client.abort();
      await exceeded;
    } finally {
      await client.stop();
    }
  }
});

test("aggregate history helpers reject count and byte overflow while page methods remain available", async () => {
  const count = clientFor("count-overflow");
  await count.start();
  try {
    await assert.rejects(count.getEntries(), /aggregate retention limit.*getEntriesPage/u);
    await assert.rejects(count.getTree(), /aggregate retention limit.*getTreePage/u);
    await assert.rejects(count.getMessages(), /aggregate retention limit.*getMessagesPage/u);
    assert.equal((await count.getEntriesPage()).totalEntries, 32769);
    assert.equal((await count.getTreePage()).totalEntries, 32769);
    assert.equal((await count.getMessagesPage()).totalMessages, 32769);
  } finally {
    await count.stop();
  }

  const bytes = clientFor("messages-byte");
  await bytes.start();
  try {
    await assert.rejects(bytes.getMessages(), /aggregate retention limit.*getMessagesPage/u);
    assert.equal((await bytes.getMessagesPage()).messages.length, 1);
  } finally {
    await bytes.stop();
  }
});

test("history continuations must make monotonic progress", async () => {
  for (const [mode, operation, expected] of [
    ["entries-stalled", (client: RpcClient) => client.getEntries(), /did not advance.*sequence/u],
    ["tree-repeated-cursor", (client: RpcClient) => client.getTree(), /did not advance.*cursor/u],
    ["messages-repeated-cursor", (client: RpcClient) => client.getMessages(), /did not advance.*cursor/u],
  ] as const) {
    const client = clientFor(mode);
    await client.start();
    try {
      await assert.rejects(operation(client), expected);
    } finally {
      await client.stop();
    }
  }
});

test("tree assembly rejects duplicate, cyclic, and orphaned topology", async () => {
  for (const [mode, expected] of [
    ["tree-duplicate", /duplicate entry ID/u],
    ["tree-cycle", /parent cycle/u],
    ["tree-orphan", /missing a parent entry/u],
  ] as const) {
    const client = clientFor(mode);
    await client.start();
    try {
      await assert.rejects(client.getTree(), expected);
    } finally {
      await client.stop();
    }
  }
});

test("hostile serialization failures are bounded and do not expose secrets", async () => {
  const client = clientFor("audit");
  await client.start();
  const image: ImageContent = { type: "image", mimeType: "image/png", data: "AA==" };
  Object.defineProperty(image, "toJSON", {
    value() { throw new Error("sk-proj-rpc-client-secret-1234567890"); },
  });
  try {
    let failure: Error | undefined;
    try {
      await client.prompt("hostile", [image]);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    assert.ok(failure);
    assert.doesNotMatch(failure.message, /rpc-client-secret/u);
    assert.ok(Buffer.byteLength(failure.message, "utf8") <= 4096);
    assert.equal(client.pendingRequestCount, 0);
    await client.getState();
  } finally {
    await client.stop();
  }
});

test("closed RPC input or peer exit rejects promptly without leaving pending requests", async () => {
  const client = clientFor("pipe-close");
  let pipeClosed = (): void => {};
  const closed = new Promise<void>((resolve) => { pipeClosed = resolve; });
  const off = client.onEvent((event) => {
    if ((event as unknown as Record<string, unknown>)["type"] === "fixture_pipe_closed") pipeClosed();
  });
  await client.start();
  try {
    await client.abort();
    await closed;
    await assert.rejects(
      Promise.race([
        client.getState(),
        delay(2_000, undefined, { ref: false }).then(() => {
          throw new Error("RPC disconnect was not observed within 2000 ms");
        }),
      ]),
      /write|input stream|ended|EPIPE/iu,
    );
    assert.equal(client.pendingRequestCount, 0);
  } finally {
    off();
    await client.stop();
  }
});

test("listener snapshots contain mutation and thrown listener failures", async () => {
  const client = clientFor("audit");
  const observed: string[] = [];
  let offFirst = (): void => {};
  offFirst = client.onEvent((event) => {
    if ((event as unknown as Record<string, unknown>)["type"] !== "fixture_command_received") return;
    observed.push("first");
    offFirst();
    client.onEvent(() => observed.push("late"));
  });
  const offThrowing = client.onEvent(() => { throw new Error("listener failure"); });
  await client.start();
  try {
    await client.getState();
    assert.deepEqual(observed, ["first"]);
    await client.getState();
    assert.deepEqual(observed, ["first", "late"]);
  } finally {
    offThrowing();
    await client.stop();
  }
});

test("stop terminates the owned subprocess tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-rpc-client-tree-"));
  const marker = join(root, "grandchild.pid");
  const client = clientFor("child-tree", { RIGYN_RPC_GRANDCHILD_MARKER: marker });
  let grandchildPid: number | undefined;
  try {
    await client.start();
    await eventually(async () => {
      try {
        grandchildPid = Number(await readFile(marker, "utf8"));
        return Number.isSafeInteger(grandchildPid) && grandchildPid > 0;
      } catch {
        return false;
      }
    }, "grandchild did not start");
    await client.stop();
    await eventually(() => {
      try {
        process.kill(grandchildPid!, 0);
        return false;
      } catch (error) {
        return error instanceof Error && "code" in error
          && (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    }, "grandchild survived RpcClient.stop()");
  } finally {
    await client.stop();
    if (grandchildPid !== undefined) {
      try { process.kill(grandchildPid, "SIGKILL"); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});
