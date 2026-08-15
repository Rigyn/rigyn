import assert from "node:assert/strict";
import test from "node:test";

import { applyInteractiveThinking } from "../../src/modes/interactive-thinking.js";

test("interactive thinking normalization is shared by installed and public hosts", () => {
  let current = "medium";
  const selected: string[] = [];
  const session = {
    get thinkingLevel() { return current; },
    setThinkingLevel(level: string) {
      selected.push(level);
      current = level;
    },
  };

  assert.equal(applyInteractiveThinking(session, ""), "medium");
  assert.equal(applyInteractiveThinking(session, " NONE "), "off");
  assert.equal(applyInteractiveThinking(session, "HIGH"), "high");
  assert.throws(() => applyInteractiveThinking(session, "ULTRA"), /Thinking level must be one of/u);
  assert.throws(() => applyInteractiveThinking(session, "warp"), /Thinking level must be one of/u);
  assert.deepEqual(selected, ["off", "high"]);
  assert.equal(current, "high");
});
