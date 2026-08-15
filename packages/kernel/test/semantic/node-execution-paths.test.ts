import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { NodeExecutionEnv } from "../../src/node.js";

async function temp(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-kernel-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("Node execution resolves portable home and file URL paths", async (t) => {
  const root = await temp(t);
  const env = new NodeExecutionEnv({ cwd: root });
  const filePath = join(root, "folder with spaces", "input.txt");

  assert.deepEqual(await env.absolutePath("~"), { ok: true, value: homedir() });
  assert.deepEqual(await env.absolutePath("~/project/input.txt"), {
    ok: true,
    value: join(homedir(), "project", "input.txt"),
  });
  assert.deepEqual(await env.absolutePath(pathToFileURL(filePath).href), {
    ok: true,
    value: filePath,
  });
});

test("Node execution leaves lookalike home paths and malformed file URLs relative", async (t) => {
  const root = await temp(t);
  const env = new NodeExecutionEnv({ cwd: root });
  const malformedUrl = "file://%not-a-valid-url";

  assert.deepEqual(await env.absolutePath("~service/config.json"), {
    ok: true,
    value: resolve(root, "~service/config.json"),
  });
  assert.deepEqual(await env.absolutePath(malformedUrl), {
    ok: true,
    value: resolve(root, malformedUrl),
  });
});

test("Node execution identifies an unavailable working directory before spawning", async (t) => {
  const root = await temp(t);
  const missingCwd = join(root, "removed-workspace");
  const result = await new NodeExecutionEnv({ cwd: missingCwd }).exec("printf ok");

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "spawn_error");
  assert.deepEqual(result.error.details, { phase: "cwd", cwd: missingCwd });
  assert.match(result.error.message, /working directory is unavailable/u);
});
