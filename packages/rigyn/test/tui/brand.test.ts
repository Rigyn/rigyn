import assert from "node:assert/strict";
import test from "node:test";

import {
  rigynCompactSignature,
  rigynTerminalLockup,
} from "../../src/tui/brand.js";

test("rigyn terminal identity stays compact without a decorative logo", () => {
  assert.equal(rigynCompactSignature("1.2.3"), "rigyn 1.2.3 · ready");
  assert.equal(rigynCompactSignature("1.2.3", false), "rigyn 1.2.3 - ready");
  assert.equal(rigynTerminalLockup("1.2.3"), "rigyn 1.2.3 · ready\nprogrammable agent harness");
  assert.doesNotMatch(rigynTerminalLockup("1.2.3", false), /[^\x00-\x7f]/u);
  assert.match(rigynTerminalLockup("1.2.3", false), /programmable agent harness/u);
});
