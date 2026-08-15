import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { RIGYN_VERSION } from "../src/version.js";

test("packaged product and runtime use the same version", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  assert.equal(packageJson.version, RIGYN_VERSION);
});
