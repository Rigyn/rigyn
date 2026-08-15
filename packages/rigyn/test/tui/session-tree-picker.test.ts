import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionTreePickerRows,
  sessionTreeEndpointIndex,
  sessionTreeSelectionIndex,
} from "../../src/tui/session-tree-picker.js";
import type { PickerItem, SessionTreeMetadata } from "../../src/tui/types.js";

function row(
  eventId: string,
  label: string,
  depth: number,
  active: boolean,
  branches: string[] = [],
  parentEventId?: string,
): PickerItem<string> & { tree: SessionTreeMetadata } {
  return {
    id: eventId,
    label,
    value: eventId,
    tree: {
      eventId,
      ...(parentEventId === undefined ? {} : { parentEventId }),
      kind: "user",
      depth,
      prefix: depth === 0 ? "└─ " : "   └─ ",
      branches,
      paths: active ? ["main"] : ["sibling"],
      active,
    },
  };
}

const source = [
  row("root", "Root prompt", 0, true),
  row("main", "Main prompt", 1, true, ["main"], "root"),
  row("sibling", "Sibling prompt", 1, false, [], "root"),
  row("sibling-end", "Sibling answer", 2, false, ["sibling"], "sibling"),
];

test("session-tree rows preserve order while searching, filtering the active path, and folding descendants", () => {
  const all = buildSessionTreePickerRows(source, { query: "", activeOnly: false, folded: new Set(), unicode: true });
  assert.deepEqual(all.map((item) => item.value), ["root", "main", "sibling", "sibling-end"]);
  assert.match(all[0]?.label ?? "", /● .*⊟ Root prompt/u);

  const active = buildSessionTreePickerRows(source, { query: "", activeOnly: true, folded: new Set(), unicode: true });
  assert.deepEqual(active.map((item) => item.value), ["root", "main"]);

  const searched = buildSessionTreePickerRows(source, { query: "sibling answer", activeOnly: false, folded: new Set(), unicode: true });
  assert.deepEqual(searched.map((item) => item.value), ["sibling-end"]);

  const folded = buildSessionTreePickerRows(source, { query: "", activeOnly: false, folded: new Set(["root"]), unicode: false });
  assert.deepEqual(folded.map((item) => item.value), ["root"]);
  assert.match(folded[0]?.label ?? "", /\[\+\] Root prompt/u);
});

test("session-tree endpoint navigation cycles across sibling branches", () => {
  const rows = buildSessionTreePickerRows(source, { query: "", activeOnly: false, folded: new Set(), unicode: true });
  assert.equal(sessionTreeEndpointIndex(rows, 0, "next"), 1);
  assert.equal(sessionTreeEndpointIndex(rows, 1, "next"), 3);
  assert.equal(sessionTreeEndpointIndex(rows, 3, "next"), 1);
  assert.equal(sessionTreeEndpointIndex(rows, 1, "previous"), 3);
});

test("session-tree endpoint navigation treats a filtered visible leaf as an endpoint", () => {
  const hiddenChild = {
    ...row("assistant", "Assistant answer", 1, true),
    tree: { ...row("assistant", "Assistant answer", 1, true).tree, kind: "assistant" as const },
  };
  const rows = buildSessionTreePickerRows([row("root", "Root prompt", 0, true), hiddenChild], {
    query: "",
    activeOnly: false,
    folded: new Set(),
    unicode: true,
    filter: "user-only",
  });
  assert.deepEqual(rows.map((item) => item.value), ["root"]);
  assert.equal(sessionTreeEndpointIndex(rows, 0, "next"), 0);
  assert.equal(sessionTreeEndpointIndex(rows, 0, "previous"), 0);
});

test("session-tree selection falls back through visible ancestors without losing its anchor", () => {
  const root = row("root", "Root prompt", 0, true);
  const child = {
    ...row("child", "Assistant answer", 1, true),
    tree: { ...row("child", "Assistant answer", 1, true).tree, parentEventId: "root", kind: "assistant" },
  };
  const leaf = {
    ...row("leaf", "Leaf prompt", 2, true),
    tree: { ...row("leaf", "Leaf prompt", 2, true).tree, parentEventId: "child" },
  };
  const nested = [root, child, leaf];
  const userRows = buildSessionTreePickerRows(nested, {
    query: "",
    activeOnly: false,
    folded: new Set(),
    unicode: true,
    filter: "user-only",
  });
  assert.equal(sessionTreeSelectionIndex(nested, userRows, "child"), 0);

  const foldedRows = buildSessionTreePickerRows(nested, {
    query: "",
    activeOnly: false,
    folded: new Set(["root"]),
    unicode: true,
  });
  assert.equal(sessionTreeSelectionIndex(nested, foldedRows, "leaf"), 0);
  assert.equal(sessionTreeSelectionIndex(nested, [], "leaf"), -1);
});

test("session-tree filters and label timestamps compose with search and path state", () => {
  const mixed = [
    { ...row("labeled-user", "Labeled user", 0, true), tree: { ...row("labeled-user", "Labeled user", 0, true).tree, label: "bookmark", labelTimestamp: "2026-07-10T12:34:56.000Z" } },
    { ...row("assistant", "Assistant answer", 1, true), tree: { ...row("assistant", "Assistant answer", 1, true).tree, kind: "assistant" } },
    { ...row("tool", "Tool output", 1, true), tree: { ...row("tool", "Tool output", 1, true).tree, kind: "tool" } },
    row("other-user", "Other user", 1, false),
  ];
  const values = (filter: "default" | "no-tools" | "user-only" | "labeled-only" | "all") =>
    buildSessionTreePickerRows(mixed, { query: "", activeOnly: false, folded: new Set(), unicode: true, filter })
      .map((item) => item.value);
  assert.deepEqual(values("default"), ["labeled-user", "assistant", "tool", "other-user"]);
  assert.deepEqual(values("no-tools"), ["labeled-user", "assistant", "other-user"]);
  assert.deepEqual(values("user-only"), ["labeled-user", "other-user"]);
  assert.deepEqual(values("labeled-only"), ["labeled-user"]);
  assert.deepEqual(values("all"), values("default"));

  const labeled = buildSessionTreePickerRows(mixed, {
    query: "bookmark",
    activeOnly: true,
    folded: new Set(),
    unicode: true,
    filter: "labeled-only",
    showLabelTimestamps: true,
  });
  assert.equal(labeled.length, 1);
  assert.match(labeled[0]?.label ?? "", /\[bookmark\] 2026-07-10 12:34 Labeled user/u);
});

test("session-tree default filters bookkeeping and tool-call-only rows and rebuilds visible connectors", () => {
  const root = row("root", "Root", 0, true);
  const bookkeeping = {
    ...row("model", "provider/model", 1, true, [], "root"),
    tree: { ...row("model", "provider/model", 1, true, [], "root").tree, kind: "model" },
  };
  const toolCall = {
    ...row("tool-call", "[tool: read]", 2, true, [], "model"),
    tree: { ...row("tool-call", "[tool: read]", 2, true, [], "model").tree, kind: "tool_call" },
  };
  const followUp = row("follow-up", "Follow up", 3, true, [], "tool-call");
  const sibling = row("sibling", "Sibling", 1, false, [], "root");

  const rows = buildSessionTreePickerRows([root, bookkeeping, toolCall, followUp, sibling], {
    query: "",
    activeOnly: false,
    folded: new Set(),
    unicode: true,
    filter: "default",
  });

  assert.deepEqual(rows.map((item) => item.value), ["root", "follow-up", "sibling"]);
  assert.equal(rows[1]?.tree?.depth, 1);
  assert.match(rows[1]?.tree?.prefix ?? "", /├─ /u);
  assert.match(rows[2]?.tree?.prefix ?? "", /└─ /u);
});

test("session-tree page navigation remains reachable through path and content filters", () => {
  const navigation = {
    ...row("later", "Later entries", 0, false),
    tree: { ...row("later", "Later entries", 0, false).tree, kind: "navigation" },
  };
  for (const filter of ["default", "no-tools", "user-only", "labeled-only", "all"] as const) {
    const rows = buildSessionTreePickerRows([navigation], {
      query: "",
      activeOnly: true,
      folded: new Set(),
      unicode: true,
      filter,
    });
    assert.deepEqual(rows.map((item) => item.value), ["later"]);
  }
});
