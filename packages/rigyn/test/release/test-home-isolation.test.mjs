import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import test from "node:test";

function inside(root, candidate) {
  const prefix = resolve(root) + sep;
  return resolve(candidate).startsWith(prefix);
}

test("the test process cannot use the invoking user's home or XDG directories", () => {
  const root = process.env.RIGYN_TEST_ISOLATED_ROOT;
  assert.equal(typeof root, "string");
  for (const name of [
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "RIGYN_CODING_AGENT_DIR",
  ]) {
    const value = process.env[name];
    assert.equal(typeof value, "string", `${name} must be isolated by test/setup.mjs`);
    assert.equal(inside(root, value), true, `${name} must remain inside the isolated test root`);
  }
});
