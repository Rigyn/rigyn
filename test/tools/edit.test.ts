import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

test("edit applies multiple replacements against one original and reports a bounded unified diff", async () => {
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
  };
  assert.equal(metadata.replacements, 2);
  assert.deepEqual(metadata.modes, ["exact", "exact"]);
  assert.match(metadata.diff, /^--- multi\.ts\n\+\+\+ multi\.ts\n/u);
  assert.match(metadata.diff, /-first = 1\n\+first = 10/u);
  assert.ok(Buffer.byteLength(metadata.diff) <= 8 * 1024);
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

test("edit truncates large unified metadata on a valid UTF-8 boundary", async () => {
  const { root, context } = await fixture();
  await writeFile(join(root, "large-diff.txt"), "target\n");

  const result = await new EditTool().execute({
    path: "large-diff.txt",
    edits: [{ oldText: "target", newText: "é".repeat(6_000) }],
  }, context);

  const diff = (result.metadata as { diff: string }).diff;
  assert.ok(Buffer.byteLength(diff, "utf8") <= 8 * 1024);
  assert.doesNotMatch(diff, /�/u);
  assert.match(diff, /\.\.\. diff truncated$/u);
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
