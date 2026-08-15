import assert from "node:assert/strict";
import test from "node:test";

import type { QueuedRunMessage } from "../../src/core/agent.js";
import {
  restoreAllQueuedMessages,
  restoreQueuedMessagesThenAbort,
} from "../../src/modes/interactive-queue.js";

function fixture(idleMessages: QueuedRunMessage[], controlMessages: QueuedRunMessage[] = []) {
  const idle = idleMessages.map((message) => structuredClone(message));
  const control = controlMessages.map((message) => structuredClone(message));
  const calls: string[] = [];
  const restored: QueuedRunMessage[][] = [];
  const session = {
    getQueuedMessages: () => [...idle, ...control].map((message) => structuredClone(message)),
    dequeueMessage: () => idle.shift() ?? control.shift(),
    async abort() { calls.push("abort"); },
  };
  const terminal = {
    assertQueuedMessagesRestorable(selected: readonly QueuedRunMessage[]) {
      calls.push("validate");
      assert.equal(idle.length + control.length, selected.length);
    },
    restoreQueuedMessages(selected: readonly QueuedRunMessage[]) {
      calls.push("restore");
      restored.push(selected.map((message) => structuredClone(message)));
      return selected.length;
    },
  };
  return { calls, control, idle, restored, session, terminal };
}

test("interactive queue restore preserves mixed idle/control steering, follow-up, images, and delivery order", () => {
  const idleImage = { type: "image" as const, mediaType: "image/png", data: "aWRsZQ==" };
  const controlImage = { type: "image" as const, mediaType: "image/jpeg", data: "Y29udHJvbA==" };
  const value = fixture(
    [
      { mode: "steer", text: "idle first", images: [idleImage] },
      { mode: "follow_up", text: "idle second" },
    ],
    [
      { mode: "follow_up", text: "control third", images: [controlImage] },
      { mode: "steer", text: "control fourth" },
    ],
  );

  assert.equal(restoreAllQueuedMessages(value.session, value.terminal), 4);
  assert.deepEqual(value.calls, ["validate", "restore"]);
  assert.deepEqual(value.idle, []);
  assert.deepEqual(value.control, []);
  assert.deepEqual(value.restored, [[
    { mode: "steer", text: "idle first", images: [idleImage] },
    { mode: "follow_up", text: "idle second" },
    { mode: "follow_up", text: "control third", images: [controlImage] },
    { mode: "steer", text: "control fourth" },
  ]]);
});

test("active cancellation restores the complete queue before aborting", async () => {
  const value = fixture([
    { mode: "follow_up", text: "afterwards" },
    { mode: "steer", text: "change direction" },
  ]);

  assert.equal(await restoreQueuedMessagesThenAbort(value.session, value.terminal, "Interrupted"), 2);
  assert.deepEqual(value.calls, ["validate", "restore", "abort"]);
});

test("failed restoration validation leaves the queue intact, aborts, and surfaces the error", async () => {
  const value = fixture([{ mode: "steer", text: "keep me" }]);
  value.terminal.assertQueuedMessagesRestorable = () => {
    value.calls.push("validate");
    throw new Error("editor limit");
  };

  await assert.rejects(
    restoreQueuedMessagesThenAbort(value.session, value.terminal, "Interrupted"),
    /editor limit/u,
  );
  assert.deepEqual(value.calls, ["validate", "abort"]);
  assert.deepEqual(value.idle, [{ mode: "steer", text: "keep me" }]);
  assert.deepEqual(value.control, []);
});
