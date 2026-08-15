import assert from "node:assert/strict";
import test from "node:test";

import { minimalProcessEnvironment, runSafeProcess } from "../../src/auth/process.js";

test("safe auth processes reject timeout values that Node timers cannot represent", async () => {
  for (const timeoutMs of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    await assert.rejects(
      runSafeProcess({ command: process.execPath, args: ["-e", "void 0"], timeoutMs }),
      /timeoutMs must be an integer from 1 through 2147483647/u,
    );
  }
});

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

test("safe auth process cancellation does not inspect hostile reasons and preserves Error identity", async () => {
  let traps = 0;
  const hostileReason = new Proxy(Object.create(null) as object, {
    get() { traps += 1; return undefined; },
    getPrototypeOf() { traps += 1; return Object.prototype; },
  });
  const hostileController = new AbortController();
  const hostile = runSafeProcess({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    signal: hostileController.signal,
  });
  hostileController.abort(hostileReason);
  await assert.rejects(hostile, (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError");
  assert.equal(traps, 0);

  const expected = new Error("cancel auth process");
  const ordinaryController = new AbortController();
  const ordinary = runSafeProcess({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    signal: ordinaryController.signal,
  });
  ordinaryController.abort(expected);
  await assert.rejects(ordinary, (error: unknown) => error === expected);
});
