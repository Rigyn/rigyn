import assert from "node:assert/strict";
import test from "node:test";
import { fuzzyScore, rankPickerItems } from "../../src/tui/fuzzy.js";

test("fuzzy ranking favors exact, prefix, and word-boundary matches", () => {
  assert.ok((fuzzyScore("model picker", "mp") ?? 0) > (fuzzyScore("example", "mp") ?? 0));
  const ranked = rankPickerItems([
    { id: "1", label: "beta smart", value: 1 },
    { id: "2", label: "smart", value: 2 },
    { id: "3", label: "alpha", detail: "smart context", value: 3 },
  ], "smart");
  assert.deepEqual(ranked.map((item) => item.id), ["2", "1", "3"]);
});
