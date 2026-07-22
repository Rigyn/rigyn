import assert from "node:assert/strict";
import test from "node:test";

import {
  RIGYN_TERMINAL_MARK,
  RIGYN_TERMINAL_MARK_ASCII,
  rigynCompactSignature,
  rigynTerminalLockup,
} from "../../src/tui/brand.js";

test("rigyn terminal identity has compact Unicode and strict ASCII forms", () => {
  assert.equal(RIGYN_TERMINAL_MARK.length, RIGYN_TERMINAL_MARK_ASCII.length);
  assert.match(rigynCompactSignature("1.2.3"), /^rigyn 1\.2\.3 · ready/u);
  assert.equal(rigynCompactSignature("1.2.3", false), "rigyn 1.2.3 - ready  o-+-*");
  assert.match(rigynTerminalLockup("1.2.3"), /◆/u);
  assert.doesNotMatch(rigynTerminalLockup("1.2.3", false), /[^\x00-\x7f]/u);
  assert.match(rigynTerminalLockup("1.2.3", false), /programmable agent harness/u);
});
