import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fileReferenceQuery, scanWorkspaceFiles } from "../../src/tui/workspace-files.js";

test("workspace file scan is sorted, bounded, and skips dependency and symlink traversal", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-files-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src", "deep"), { recursive: true });
  await mkdir(join(root, "node_modules", "package"), { recursive: true });
  await writeFile(join(root, "README.md"), "readme");
  await writeFile(join(root, "src", "b.ts"), "b");
  await writeFile(join(root, "src", "a.ts"), "a");
  await writeFile(join(root, "src", "deep", "c.ts"), "c");
  await writeFile(join(root, ".env.local"), "secret");
  await writeFile(join(root, "node_modules", "package", "ignored.js"), "ignored");
  await symlink(tmpdir(), join(root, "outside"));
  await symlink(root, join(root, "loop"));
  await symlink(join(root, "src", "a.ts"), join(root, "alias.ts"));

  assert.deepEqual(await scanWorkspaceFiles(root), ["README.md", "src/a.ts", "src/b.ts", "src/deep/c.ts"]);
  assert.deepEqual(await scanWorkspaceFiles(root, { limit: 2 }), ["README.md", "src/a.ts"]);
  assert.deepEqual(await scanWorkspaceFiles(root, { maxDepth: 1 }), ["README.md", "src/a.ts", "src/b.ts"]);
});

test("workspace file scan honors ignore rules without a Git executable", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-files-git-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "tracked.txt"), "tracked");
  await writeFile(join(root, "ignored.txt"), "ignored");
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.deepEqual(await scanWorkspaceFiles(root), [".gitignore", "tracked.txt"]);
    assert.deepEqual(await scanWorkspaceFiles(root, { pattern: "*.md" }), []);
    assert.deepEqual(await scanWorkspaceFiles(root, { pattern: "*.txt" }), ["tracked.txt"]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("workspace file scan applies path globs to basenames and workspace-relative paths", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-files-glob-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".hidden"));
  await mkdir(join(root, "some", "parent", "child"), { recursive: true });
  await mkdir(join(root, "src", "foo", "bar"), { recursive: true });
  await mkdir(join(root, "src", "κώδικας"), { recursive: true });
  await writeFile(join(root, ".hidden", "hidden.spec.ts"), "hidden");
  await writeFile(join(root, "--help"), "literal flag-like filename");
  await writeFile(join(root, "README.md"), "readme");
  await writeFile(join(root, "some", "parent", "child", "file.ext"), "file");
  await writeFile(join(root, "some", "parent", "child", "test.spec.ts"), "test");
  await writeFile(join(root, "src", "foo", "bar", "example.spec.ts"), "example");
  await writeFile(join(root, "src", "κώδικας", "你好-😀.spec.ts"), "unicode");

  assert.deepEqual(await scanWorkspaceFiles(root, { pattern: "*.spec.ts" }), [
    ".hidden/hidden.spec.ts",
    "some/parent/child/test.spec.ts",
    "src/foo/bar/example.spec.ts",
    "src/κώδικας/你好-😀.spec.ts",
  ]);
  assert.deepEqual(await scanWorkspaceFiles(root, { pattern: "src/**/*.spec.ts" }), [
    "src/foo/bar/example.spec.ts",
    "src/κώδικας/你好-😀.spec.ts",
  ]);
  assert.deepEqual(await scanWorkspaceFiles(root, { pattern: "some/parent/child/**" }), [
    "some/parent/child/file.ext",
    "some/parent/child/test.spec.ts",
  ]);
  assert.deepEqual(await scanWorkspaceFiles(root, { pattern: "**/parent/child/*" }), [
    "some/parent/child/file.ext",
    "some/parent/child/test.spec.ts",
  ]);
  assert.deepEqual(await scanWorkspaceFiles(root, { pattern: "--help" }), ["--help"]);
  assert.deepEqual(await scanWorkspaceFiles(root, { pattern: "*.spec.ts", limit: 1 }), [
    ".hidden/hidden.spec.ts",
  ]);
});

test("workspace file scan honors hierarchical Git ignore rules outside a repository", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-files-ignore-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "a", "deep"), { recursive: true });
  await mkdir(join(root, "b"));
  await mkdir(join(root, "cache"));
  await mkdir(join(root, "generated"));
  await mkdir(join(root, "sealed"));
  await writeFile(join(root, ".gitignore"), [
    "# root rules",
    "*.tmp",
    "!important.tmp",
    "/root-only.txt",
    "cache/",
    "generated/*",
    "!generated/keep.txt",
    "sealed/",
    "!sealed/keep.txt",
    "",
  ].join("\n"));
  await writeFile(join(root, "a", ".gitignore"), [
    "ignored.txt",
    "/anchored.txt",
    "*.log",
    "!keep.log",
    "",
  ].join("\n"));
  await writeFile(join(root, "a", "deep", ".gitignore"), "secret.txt\n");
  await writeFile(join(root, "drop.tmp"), "ignored");
  await writeFile(join(root, "important.tmp"), "kept by negation");
  await writeFile(join(root, "root-only.txt"), "ignored only at the root");
  await writeFile(join(root, "cache", "kept.txt"), "parent directory ignored");
  await writeFile(join(root, "generated", "drop.txt"), "ignored child");
  await writeFile(join(root, "generated", "keep.txt"), "re-included child");
  await writeFile(join(root, "sealed", "keep.txt"), "cannot re-include below an ignored directory");
  await writeFile(join(root, "a", "ignored.txt"), "ignored in a");
  await writeFile(join(root, "a", "anchored.txt"), "anchored to a");
  await writeFile(join(root, "a", "drop.log"), "ignored log");
  await writeFile(join(root, "a", "keep.log"), "nested negation");
  await writeFile(join(root, "a", "root-only.txt"), "root anchor does not reach here");
  await writeFile(join(root, "a", "deep", "ignored.txt"), "inherited ignore");
  await writeFile(join(root, "a", "deep", "anchored.txt"), "nested path is not anchored match");
  await writeFile(join(root, "a", "deep", "keep.log"), "inherited nested negation");
  await writeFile(join(root, "a", "deep", "secret.txt"), "nested ignore");
  await writeFile(join(root, "b", "ignored.txt"), "sibling is unaffected");
  await writeFile(join(root, "b", "anchored.txt"), "sibling is unaffected");
  await writeFile(join(root, "b", "drop.log"), "sibling is unaffected");

  assert.deepEqual(await scanWorkspaceFiles(root), [
    ".gitignore",
    "a/.gitignore",
    "a/deep/.gitignore",
    "a/deep/anchored.txt",
    "a/deep/keep.log",
    "a/keep.log",
    "a/root-only.txt",
    "b/anchored.txt",
    "b/drop.log",
    "b/ignored.txt",
    "generated/keep.txt",
    "important.tmp",
  ]);
});

test("workspace file scan honors cancellation and validates bounds", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-files-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(scanWorkspaceFiles(root, { signal: controller.signal }), /cancelled/u);
  await assert.rejects(scanWorkspaceFiles(root, { limit: 0 }), /limit must be/u);
  await assert.rejects(scanWorkspaceFiles(root, { pattern: "x".repeat(16_385) }), /pattern must be/u);
  await writeFile(join(root, ".gitignore"), Buffer.alloc(1024 * 1024 + 1, 0x61));
  await assert.rejects(scanWorkspaceFiles(root), /ignore file exceeds/u);
});

test("file reference query only matches the active at-token", () => {
  assert.equal(fileReferenceQuery("review @src/cli/ma"), "src/cli/ma");
  assert.equal(fileReferenceQuery("@"), "");
  assert.equal(fileReferenceQuery("email@example.com"), undefined);
  assert.equal(fileReferenceQuery("done @one next"), undefined);
});
