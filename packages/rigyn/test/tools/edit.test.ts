import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPatch } from "diff";
import { DirectProcessRunner } from "../../src/process/index.js";
import { EditTool, WorkspaceBoundary } from "../../src/tools/index.js";
import type { ToolContext } from "../../src/tools/types.js";

async function fixture(): Promise<{ root: string; context: ToolContext }> {
  const root = await mkdtemp(join(tmpdir(), "harness-edit-"));
  const workspace = await WorkspaceBoundary.create(root);
  return {
    root,
    context: {
      workspace,
      runner: new DirectProcessRunner(),
      signal: new AbortController().signal,
      runId: "run-edit",
      threadId: "thread-edit",
    },
  };
}

test("edit applies multiple replacements and reports display and applicable patch forms", async () => {
  const { root, context } = await fixture();
  await writeFile(join(root, "multi.ts"), "const first = 1;\nconst second = 2;\n");

  const result = await new EditTool().execute({
    path: "multi.ts",
    edits: [
      { oldText: "first = 1", newText: "first = 10" },
      { oldText: "second = 2", newText: "second = 20" },
    ],
  }, context);

  assert.equal(await readFile(join(root, "multi.ts"), "utf8"), "const first = 10;\nconst second = 20;\n");
  const metadata = result.metadata as {
    replacements: number;
    modes: string[];
    diff: string;
    patch: string;
  };
  assert.equal(metadata.replacements, 2);
  assert.deepEqual(metadata.modes, ["exact", "exact"]);
  assert.match(metadata.diff, /-1 const first = 1;/u);
  assert.match(metadata.diff, /\+1 const first = 10;/u);
  assert.equal(applyPatch("const first = 1;\nconst second = 2;\n", metadata.patch), "const first = 10;\nconst second = 20;\n");
});

test("multi-edit validation is atomic when a later replacement is missing", async () => {
  const { root, context } = await fixture();
  const original = "alpha\nbeta\n";
  await writeFile(join(root, "atomic.txt"), original);
  await assert.rejects(new EditTool().execute({
    path: "atomic.txt",
    edits: [
      { oldText: "alpha", newText: "changed" },
      { oldText: "missing", newText: "never" },
    ],
  }, context), /Could not find edits\[1\].*oldText must match exactly/iu);

  assert.equal(await readFile(join(root, "atomic.txt"), "utf8"), original);
});

test("multi-edit rejects ambiguous and overlapping original ranges without mutation", async () => {
  const { root, context } = await fixture();
  const edit = new EditTool();
  await writeFile(join(root, "conflicts.txt"), "alpha beta beta\n");

  await assert.rejects(edit.execute({
    path: "conflicts.txt",
    edits: [{ oldText: "beta", newText: "value" }],
  }, context), /Found 2 occurrences.*text must be unique/iu);
  assert.equal(await readFile(join(root, "conflicts.txt"), "utf8"), "alpha beta beta\n");

  await assert.rejects(edit.execute({
    path: "conflicts.txt",
    edits: [
      { oldText: "alpha beta", newText: "first" },
      { oldText: "beta beta", newText: "second" },
    ],
  }, context), /edits\[0\] and edits\[1\] overlap/iu);
  assert.equal(await readFile(join(root, "conflicts.txt"), "utf8"), "alpha beta beta\n");
});

test("edit emits an applicable unified patch for large Unicode replacements", async () => {
  const { root, context } = await fixture();
  const original = "target\n";
  await writeFile(join(root, "large-diff.txt"), original);

  const result = await new EditTool().execute({
    path: "large-diff.txt",
    edits: [{ oldText: "target", newText: "é".repeat(6_000) }],
  }, context);

  const { diff, patch } = result.metadata as { diff: string; patch: string };
  assert.doesNotMatch(diff, /�/u);
  assert.equal(applyPatch(original, patch), `${"é".repeat(6_000)}\n`);
});

test("edit preserves a UTF-8 BOM and converts replacement newlines to dominant CRLF", async () => {
  const { root, context } = await fixture();
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  await writeFile(join(root, "windows.txt"), Buffer.concat([bom, Buffer.from("first\r\nsecond\r\n", "utf8")]));

  const result = await new EditTool().execute({
    path: "windows.txt",
    edits: [{ oldText: "second\n", newText: "two\nlines\n" }],
  }, context);

  assert.deepEqual(
    await readFile(join(root, "windows.txt")),
    Buffer.concat([bom, Buffer.from("first\r\ntwo\r\nlines\r\n", "utf8")]),
  );
  assert.deepEqual((result.metadata as { modes: string[] }).modes, ["normalized"]);
});

test("edit prepares legacy and stringified multi-edit inputs before validation", async () => {
  const { root, context } = await fixture();
  const tool = new EditTool();
  await writeFile(join(root, "compat.txt"), "alpha\nbeta\ngamma\n");

  const legacy = await tool.prepareInput?.({ path: "compat.txt", oldText: "alpha", newText: "ALPHA" }, context);
  assert.deepEqual(legacy, {
    path: "compat.txt",
    edits: [{ oldText: "alpha", newText: "ALPHA" }],
  });
  await tool.execute(legacy!, context);

  const stringified = await tool.prepareInput?.({
    path: "compat.txt",
    edits: JSON.stringify([
      { oldText: "beta", newText: "BETA" },
      { oldText: "gamma", newText: "GAMMA" },
    ]),
  }, context);
  await tool.execute(stringified!, context);
  assert.equal(await readFile(join(root, "compat.txt"), "utf8"), "ALPHA\nBETA\nGAMMA\n");
});

test("multi-edit resolves every target against the original file", async () => {
  const { root, context } = await fixture();
  await writeFile(join(root, "original.txt"), "first block\nsecond block\n");

  await new EditTool().execute({
    path: "original.txt",
    edits: [
      { oldText: "first block", newText: "second block copied" },
      { oldText: "second block", newText: "final block" },
    ],
  }, context);

  assert.equal(await readFile(join(root, "original.txt"), "utf8"), "second block copied\nfinal block\n");
});

test("normalized edits preserve untouched original bytes", async () => {
  const { root, context } = await fixture();
  const original = "before  \r\ncafe\u0301\r\nafter\t \r\n";
  await writeFile(join(root, "preserve.txt"), original);

  await new EditTool().execute({
    path: "preserve.txt",
    edits: [{ oldText: "café\n", newText: "coffee\n" }],
  }, context);

  assert.equal(await readFile(join(root, "preserve.txt"), "utf8"), "before  \r\ncoffee\r\nafter\t \r\n");
});
