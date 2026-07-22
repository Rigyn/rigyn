import assert from "node:assert/strict";
import test from "node:test";

import { minimalProcessEnvironment } from "../../src/auth/process.js";

test("minimal process environment rejects unsafe names case-insensitively", () => {
  assert.throws(
    () => minimalProcessEnvironment({ Node_Options: "--require attacker.js" }, {}),
    /Unsafe external command environment name/u,
  );
});

test("minimal process environment preserves Windows variables independent of casing", {
  skip: process.platform !== "win32",
}, () => {
  const environment = minimalProcessEnvironment({}, {
    Path: "C:\\Windows\\System32",
    windir: "C:\\Windows",
  });
  assert.equal(environment.PATH, "C:\\Windows\\System32");
  assert.equal(environment.WINDIR, "C:\\Windows");
  assert.equal(Object.hasOwn(environment, "Path"), false);
  assert.equal(Object.hasOwn(environment, "windir"), false);
});
