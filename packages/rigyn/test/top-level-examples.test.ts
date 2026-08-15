import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const examples = join(process.cwd(), "examples");
const offlineGuard = pathToFileURL(join(process.cwd(), "benchmarks/offline-network-guard.mjs")).href;

function run(name: string, argumentsValue: readonly string[] = []): { stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, ["--import", offlineGuard, join(examples, name), ...argumentsValue], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  return { stderr: result.stderr, stdout: result.stdout };
}

test("documented SDK and configured embedding examples expose an offline help path", () => {
  for (const name of ["sdk-composition.mjs", "embedding-runtime.mjs"]) {
    const result = run(name, ["--help"]);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, new RegExp(`node examples/${name.replace(".", "\\.")}`, "u"));
  }
});

test("the documented in-memory embedding example executes offline", () => {
  const result = run("embedding-in-memory.mjs", ["test prompt"]);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "offline: test prompt\n");
});

test("the documented embedding cancellation example executes offline", () => {
  const result = run("embedding-cancellation.mjs");
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "cancelled\n");
});
