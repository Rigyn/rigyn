import assert from "node:assert/strict";
import test from "node:test";

import { sessionEntryPreview, sessionTreePickerItems } from "../../src/cli/session-tree.js";
import type { SessionEntry, SessionTreeNode } from "../../src/storage/types.js";

function user(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-07-20T00:00:00.000Z",
    message: {
      id: `message-${id}`,
      role: "user",
      content: [{ type: "text", text }],
      createdAt: "2026-07-20T00:00:00.000Z",
    },
  };
}

test("session tree rows preserve topology, active paths, labels, and bounded previews", () => {
  const root = user("root", null, "Root prompt");
  const active = user("active", "root", "Active branch");
  const alternate = user("alternate", "root", `${"long ".repeat(200)}branch`);
  const tree: SessionTreeNode[] = [{
    entry: root,
    children: [
      { entry: active, children: [], label: "current", labelTimestamp: "2026-07-20T01:02:03.000Z" },
      { entry: alternate, children: [] },
    ],
  }];

  const rows = sessionTreePickerItems(tree, new Set(["root", "active"]));
  assert.deepEqual(rows.map((row) => row.value), ["root", "active", "alternate"]);
  assert.equal(rows[0]?.tree.branches.length, 2);
  assert.equal(rows[1]?.tree.active, true);
  assert.equal(rows[1]?.tree.label, "current");
  assert.equal(rows[2]?.tree.active, false);
  assert.ok((rows[2]?.label.length ?? 0) <= 500);
  assert.match(rows[1]?.tree.prefix ?? "", /├─/u);
  assert.match(rows[2]?.tree.prefix ?? "", /└─/u);
});

test("session tree row construction handles very deep histories without recursion", () => {
  const depth = 5_000;
  let node: SessionTreeNode = { entry: user(`entry-${depth}`, `entry-${depth - 1}`, "leaf"), children: [] };
  for (let index = depth - 1; index >= 0; index -= 1) {
    node = {
      entry: user(`entry-${index}`, index === 0 ? null : `entry-${index - 1}`, `prompt ${index}`),
      children: [node],
    };
  }
  const rows = sessionTreePickerItems([node], new Set([`entry-${depth}`]));
  assert.equal(rows.length, depth + 1);
  assert.equal(rows.at(-1)?.value, `entry-${depth}`);
});

test("session entry previews distinguish operational entry kinds", () => {
  assert.deepEqual(sessionEntryPreview({
    type: "thinking_level_change",
    id: "thinking",
    parentId: null,
    timestamp: "2026-07-20T00:00:00.000Z",
    thinkingLevel: "high",
  }), { kind: "thinking", text: "Thinking: high" });
  assert.deepEqual(sessionEntryPreview({
    type: "model_change",
    id: "model",
    parentId: null,
    timestamp: "2026-07-20T00:00:00.000Z",
    provider: "provider",
    modelId: "model",
  }), { kind: "model", text: "provider/model" });
});
