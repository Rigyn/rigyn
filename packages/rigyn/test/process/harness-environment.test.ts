import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_HARNESS_ENV,
  markActiveHarness,
} from "../../src/process/harness-environment.js";

test("executable harness processes expose a stable child-process marker", () => {
  const environment: NodeJS.ProcessEnv = {};
  markActiveHarness(environment);
  assert.equal(ACTIVE_HARNESS_ENV, "RIGYN_ACTIVE");
  assert.equal(environment.RIGYN_ACTIVE, "true");
});
