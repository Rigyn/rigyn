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

test("paged tree roots preserve absolute ancestry depth", () => {
  const roots: SessionTreeNode[] = [{
    entry: user("paged-child", "outside-page", "child"),
    depth: 4,
    children: [{ entry: user("paged-leaf", "paged-child", "leaf"), depth: 5, children: [] }],
  }];

  const rows = sessionTreePickerItems(roots, new Set(["paged-child", "paged-leaf"]));
  assert.deepEqual(rows.map((row) => row.tree.depth), [4, 5]);
  assert.match(rows[0]?.tree.prefix ?? "", /^ {12}/u);
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
  assert.ok(rows.every((row) => (row.tree.prefix.length ?? 0) <= 42));
  assert.match(rows.at(-1)?.tree.prefix ?? "", /^… /u);
});

test("a deep paged tree keeps absolute navigation depth with bounded visual prefixes", () => {
  const roots: SessionTreeNode[] = [{
    entry: user("deep-page", "outside-page", "deep page"),
    depth: 75_000,
    children: [{ entry: user("deep-leaf", "deep-page", "leaf"), depth: 75_001, children: [] }],
  }];

  const rows = sessionTreePickerItems(roots, new Set(["deep-page", "deep-leaf"]));

  assert.deepEqual(rows.map((row) => row.tree.depth), [75_000, 75_001]);
  assert.ok(rows.every((row) => row.tree.prefix.length <= 42));
  assert.ok(rows.every((row) => row.tree.prefix.startsWith("… ")));
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
  assert.deepEqual(sessionEntryPreview({
    type: "message",
    id: "assistant-tool-call",
    parentId: null,
    timestamp: "2026-07-20T00:00:00.000Z",
    message: {
      id: "message-assistant-tool-call",
      role: "assistant",
      content: [{ type: "tool_call", callId: "call", name: "read", arguments: { path: "file.ts" } }],
      createdAt: "2026-07-20T00:00:00.000Z",
      stopReason: "tool_calls",
    },
  }), { kind: "tool_call", text: "[tool: read]" });
  for (const [id, visibleBlock] of [
    ["image", { type: "image", mediaType: "image/png", data: "aW1hZ2U=" }],
    ["reasoning", { type: "thinking", thinking: "Inspect the file", visibility: "summary" }],
  ] as const) {
    assert.deepEqual(sessionEntryPreview({
      type: "message",
      id: `assistant-tool-${id}`,
      parentId: null,
      timestamp: "2026-07-20T00:00:00.000Z",
      message: {
        id: `message-assistant-tool-${id}`,
        role: "assistant",
        content: [
          { type: "tool_call", callId: `call-${id}`, name: "read", arguments: { path: "file.ts" } },
          visibleBlock,
        ],
        createdAt: "2026-07-20T00:00:00.000Z",
        stopReason: "tool_calls",
      },
    }), { kind: "assistant", text: "[tool: read]" });
  }
});
