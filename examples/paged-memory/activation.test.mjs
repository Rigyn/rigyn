import assert from "node:assert/strict";
import test from "node:test";

import activate from "./runtime/index.mjs";

test("paged memory stores private namespaced notes and forwards the opaque cursor", async () => {
  let tool;
  let renderer;
  const writes = [];
  const reads = [];
  activate({
    registerTool(value) { tool = value; },
    session: {
      registerRenderers(_version, value) { renderer = value; },
      async appendMessage(input) {
        writes.push(input);
        return { ...input, extensionId: "paged-memory-example", messageId: "message-1", eventId: "event-9", timestamp: "2026-01-01T00:00:00.000Z" };
      },
      async readMessages(input) {
        reads.push(input);
        return [2, 3].map((index) => ({
          type: "extension_message",
          extensionId: "paged-memory-example",
          schemaVersion: 1,
          kind: "note",
          messageId: `message-${index}`,
          payload: { text: `note ${index}` },
          modelContext: false,
          transcript: false,
          threadId: input.threadId,
          branch: input.branch,
          eventId: `event-${index}`,
          timestamp: "2026-01-01T00:00:00.000Z",
        }));
      },
    },
  });
  const context = { threadId: "thread-memory", branch: "main", signal: new AbortController().signal };
  await tool.execute({ action: "remember", text: "Keep the parser invariant." }, context);
  const recalled = await tool.execute({ action: "recall", limit: 2, beforeEventId: "event-4" }, context);

  assert.equal(writes[0].modelContext, false);
  assert.equal(writes[0].transcript, false);
  assert.equal(reads[0].beforeEventId, "event-4");
  assert.deepEqual(JSON.parse(recalled.content), {
    notes: [
      { eventId: "event-2", timestamp: "2026-01-01T00:00:00.000Z", text: "note 2" },
      { eventId: "event-3", timestamp: "2026-01-01T00:00:00.000Z", text: "note 3" },
    ],
    nextBeforeEventId: "event-2",
  });
  assert.ok(renderer.renderMessage({ kind: "note", payload: { text: "visible locally" } }));
});
