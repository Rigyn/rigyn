import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pruneToolOutputFiles, ToolOutputAccumulator } from "../../src/tools/output-accumulator.js";

test("full tool output uses a private directory and exclusive private file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-output-private-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await chmod(root, 0o777);

  const output = new ToolOutputAccumulator({ directory: root, maxBytes: 4, maxLines: 2 });
  output.append(Buffer.from("one\ntwo\nthree\n"));
  output.finish();
  const snapshot = output.snapshot(true);
  await output.close();

  assert.ok(snapshot.fullOutputPath?.startsWith(`${root}/rigyn-`));
  assert.equal((await lstat(root)).mode & 0o777, process.platform === "win32" ? (await lstat(root)).mode & 0o777 : 0o700);
  if (process.platform !== "win32") assert.equal((await lstat(snapshot.fullOutputPath!)).mode & 0o777, 0o600);
});

test("full tool output is explicitly capped while the bounded tail remains available", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-output-cap-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const output = new ToolOutputAccumulator({
    directory: root,
    maxBytes: 4,
    maxLines: 1,
    maxPersistedBytes: 5,
  });
  output.append(Buffer.from("first\nsecond\n"));
  output.finish();
  const snapshot = output.snapshot(true);
  await output.close();
  assert.equal(snapshot.fullOutputTruncated, true);
  assert.equal(snapshot.content, "cond");
  assert.equal((await lstat(snapshot.fullOutputPath!)).size, 5);
});

test("tool output cleanup removes expired and excess files but never follows links", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-output-prune-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "harness-output-outside-"));
  const outside = join(outsideRoot, "secret");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });
  await writeFile(outside, "keep", { mode: 0o600 });
  const old = join(root, "rigyn-bash-0000000000000001.log");
  const newer = join(root, "rigyn-bash-0000000000000002.log");
  await writeFile(old, "old", { mode: 0o600 });
  await writeFile(newer, "new", { mode: 0o600 });
  await symlink(outside, join(root, "rigyn-bash-0000000000000003.log"));
  await utimes(old, new Date(1_000), new Date(1_000));
  await utimes(newer, new Date(2_000), new Date(2_000));

  const result = pruneToolOutputFiles({ directory: root, now: 3_000, maxAgeMs: 10_000, maxFiles: 1, maxTotalBytes: 1_024 });
  assert.equal(result.removedFiles, 1);
  assert.deepEqual((await readdir(root)).sort(), [
    "rigyn-bash-0000000000000002.log",
    "rigyn-bash-0000000000000003.log",
  ]);
  assert.equal((await lstat(outside)).size, 4);
});
