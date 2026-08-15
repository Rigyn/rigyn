import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { SessionManager } from "../../src/storage/session-manager.js";

const TIME = "2026-07-29T12:00:00.000Z";
const ENTRY_COUNT = 10_000;
const CEILING_MS = 5_000;

function commitNode(manager: SessionManager, index: number, prefix: string): void {
  const id = `${prefix}-node-${index}`;
  manager.commitChanges([{
    type: "conversation_node",
    node: {
      id,
      parentId: null,
      nodeType: "extension_state",
      extensionId: "session-manager-performance",
      state: null,
      createdAt: TIME,
    },
  }], `${prefix}-commit-${index}`, TIME);
}

test("10k in-memory commits remain linear and public state stays detached", () => {
  const warmup = SessionManager.inMemory("/tmp", { id: "performance-warmup" });
  for (let index = 0; index < 100; index += 1) commitNode(warmup, index, "warmup");

  const manager = SessionManager.inMemory("/tmp", { id: "performance-10k" });
  const startedAt = performance.now();
  for (let index = 0; index < ENTRY_COUNT; index += 1) commitNode(manager, index, "measured");
  const elapsedMs = performance.now() - startedAt;

  assert.equal(manager.getEntryCount(), ENTRY_COUNT);
  assert.ok(
    elapsedMs < CEILING_MS,
    `10k in-memory commits took ${elapsedMs.toFixed(1)}ms; expected under ${CEILING_MS}ms`,
  );

  const snapshot = manager.getV4State();
  assert.equal(snapshot.nodes.size, ENTRY_COUNT);
  snapshot.nodes.clear();
  assert.equal(manager.getEntryCount(), ENTRY_COUNT);
});
