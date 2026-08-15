import assert from "node:assert/strict";
import test from "node:test";

import { toError } from "../../src/harness/types.js";

test("thrown values are converted without consulting caller-defined behavior", () => {
  let observations = 0;
  const opaque = new Proxy({ marker: true }, {
    get() { observations += 1; throw new Error("unexpected read"); },
    getPrototypeOf() { observations += 1; throw new Error("unexpected prototype read"); },
  });

  assert.equal(toError(opaque).message, "[Thrown object]");
  assert.equal(observations, 0);
});

test("ordinary errors and scalar failures retain useful messages", () => {
  const original = new Error("disk unavailable");
  assert.equal(toError(original), original);
  assert.equal(toError(false).message, "false");
  assert.equal(toError("cancelled").message, "cancelled");
});
