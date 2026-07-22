import assert from "node:assert/strict";
import { lstat, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DirectProcessRunner } from "../../src/process/index.js";
import {
  atomicWritePath,
  EditTool,
  MAX_TOOL_SOURCE_FILE_BYTES,
  ReadTool,
  readFileSnapshotBounded,
  WorkspaceBoundary,
  WriteTool,
} from "../../src/tools/index.js";
import type { ToolContext } from "../../src/tools/types.js";

async function fixture(): Promise<{ root: string; context: ToolContext }> {
  const root = await mkdtemp(join(tmpdir(), "harness-file-safety-"));
  return {
    root,
    context: {
      workspace: await WorkspaceBoundary.create(root),
      runner: new DirectProcessRunner(),
      signal: new AbortController().signal,
      runId: "run-file-safety",
      threadId: "thread-file-safety",
    },
  };
}

test("read and edit reject oversized regular files before allocating their contents", async (context) => {
  const value = await fixture();
  context.after(async () => await rm(value.root, { recursive: true, force: true }));
  const path = join(value.root, "oversized.txt");
  const handle = await open(path, "w", 0o600);
  await handle.truncate(MAX_TOOL_SOURCE_FILE_BYTES + 1);
  await handle.close();

  await assert.rejects(new ReadTool().execute({ path: "oversized.txt" }, value.context), /too large to read safely/u);
  await assert.rejects(
    new EditTool().execute({ path: "oversized.txt", edits: [{ oldText: "x", newText: "y" }] }, value.context),
    /safety limit/u,
  );
});

test("atomic replacement rejects a stale edit and removes its private staging file", async (context) => {
  const value = await fixture();
  context.after(async () => await rm(value.root, { recursive: true, force: true }));
  const path = join(value.root, "shared.txt");
  await writeFile(path, "original\n", { mode: 0o640 });
  const loaded = await readFileSnapshotBounded(path, 1024);
  await writeFile(path, "newer external content\n", "utf8");

  await assert.rejects(
    atomicWritePath(loaded.path, Buffer.from("stale agent content\n"), { expected: loaded.snapshot }),
    /changed before it could be replaced/u,
  );
  assert.equal(await readFile(path, "utf8"), "newer external content\n");
  assert.deepEqual((await readdir(value.root)).sort(), ["shared.txt"]);
});

test("write uses an atomic replacement, preserves modes, and follows an existing file symlink", {
  skip: process.platform === "win32",
}, async (context) => {
  const value = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "harness-file-safety-target-"));
  context.after(async () => {
    await rm(value.root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const target = join(outside, "target.txt");
  await writeFile(target, "before\n", { mode: 0o640 });
  const link = join(value.root, "linked.txt");
  await symlink(target, link, "file");

  await new WriteTool().execute({ path: "linked.txt", content: "after\n" }, value.context);

  assert.equal(await readFile(target, "utf8"), "after\n");
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal((await lstat(target)).mode & 0o777, 0o640);
});
