import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DirectProcessRunner } from "../../src/process/index.js";
import {
  expandPath,
  FindTool,
  GrepTool,
  LsTool,
  resolveReadPath,
  resolveToCwd,
  WorkspaceBoundary,
} from "../../src/tools/index.js";
import type { ToolContext } from "../../src/tools/types.js";

async function findFixture(t: test.TestContext): Promise<{ root: string; context: ToolContext }> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-find-regression-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return {
    root,
    context: {
      workspace: await WorkspaceBoundary.create(root),
      runner: new DirectProcessRunner(),
      signal: new AbortController().signal,
      runId: "find-regression",
      threadId: "find-regression",
    },
  };
}

async function findPaths(pattern: string, context: ToolContext): Promise<string[]> {
  const result = await new FindTool().execute({ pattern }, context);
  if (result.content === "No files found matching pattern") return [];
  return result.content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("["));
}

test("path helpers preserve tilde-prefixed filenames and recover common macOS spellings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-path-regression-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  assert.equal(expandPath("~draft.md"), "~draft.md");
  assert.equal(expandPath("@~draft.md"), "~draft.md");
  assert.equal(expandPath("file\u00a0name.txt"), "file name.txt");
  assert.equal(resolveToCwd("~draft.md", root), join(root, "~draft.md"));

  const curved = join(root, "Capture d\u2019écran.txt");
  await writeFile(curved, "fixture");
  assert.equal(resolveReadPath("Capture d'écran.txt", root), curved);

  const clock = join(root, "Screenshot 2024-01-01 at 10.00.00\u202fAM.png");
  await writeFile(clock, "fixture");
  assert.equal(resolveReadPath("Screenshot 2024-01-01 at 10.00.00 AM.png", root), clock);
});

test("find matches directory-bearing glob patterns", async (t) => {
  const { root, context } = await findFixture(t);
  await mkdir(join(root, "some", "parent", "child"), { recursive: true });
  await mkdir(join(root, "src", "foo", "bar"), { recursive: true });
  await writeFile(join(root, "some", "parent", "child", "file.ext"), "");
  await writeFile(join(root, "some", "parent", "child", "test.spec.ts"), "");
  await writeFile(join(root, "src", "foo", "bar", "example.spec.ts"), "");

  assert.deepEqual(await findPaths("*.spec.ts", context), [
    "some/parent/child/test.spec.ts",
    "src/foo/bar/example.spec.ts",
  ]);
  assert.deepEqual(await findPaths("src/**/*.spec.ts", context), ["src/foo/bar/example.spec.ts"]);
  assert.deepEqual(await findPaths("**/parent/child/*", context), [
    "some/parent/child/file.ext",
    "some/parent/child/test.spec.ts",
  ]);
});

test("nested ignore rules stay scoped to their own directory tree", async (t) => {
  const { root, context } = await findFixture(t);
  await mkdir(join(root, "a", "deep"), { recursive: true });
  await mkdir(join(root, "b"), { recursive: true });
  await writeFile(join(root, "a", ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "a", "deep", ".gitignore"), "secret.txt\n");
  for (const path of [
    "a/ignored.txt",
    "a/kept.txt",
    "a/deep/ignored.txt",
    "a/deep/secret.txt",
    "a/deep/kept.txt",
    "b/ignored.txt",
    "b/kept.txt",
    "root.txt",
  ]) await writeFile(join(root, path), "");

  assert.deepEqual(await findPaths("**/*.txt", context), [
    "a/deep/kept.txt",
    "a/kept.txt",
    "b/ignored.txt",
    "b/kept.txt",
    "root.txt",
  ]);
});

test("find includes visible hidden paths, honors ignores, rejects invalid globs, and treats flags as data", async (t) => {
  const { root, context } = await findFixture(t);
  await mkdir(join(root, ".secret"));
  await writeFile(join(root, ".secret", "hidden.txt"), "hidden");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "ignored.txt"), "ignored");
  await writeFile(join(root, "visible.txt"), "visible");

  assert.deepEqual(await findPaths("**/*.txt", context), [".secret/hidden.txt", "visible.txt"]);
  await assert.rejects(new FindTool().execute({ pattern: "[" }, context), /glob|fd exited with code 1|fd error/iu);
  assert.deepEqual(await findPaths("--help", context), []);
});

test("grep reports single-file paths and context while flag-like patterns cannot execute commands", async (t) => {
  const { root, context } = await findFixture(t);
  const source = join(root, "context.txt");
  await writeFile(source, "before\nmatch one\nafter\nmatch two\n");
  const result = await new GrepTool().execute({ pattern: "match", path: source, limit: 1, context: 1 }, context);
  assert.match(result.content, /context\.txt-1- before/u);
  assert.match(result.content, /context\.txt:2: match one/u);
  assert.match(result.content, /context\.txt-3- after/u);
  assert.match(result.content, /\[1 matches limit reached\. Use limit=2 for more, or refine pattern\]/u);
  assert.doesNotMatch(result.content, /match two/u);

  const marker = join(root, "grep-injection-marker");
  const payload = join(root, "payload.sh");
  await writeFile(payload, `#!/bin/sh\necho executed > ${marker}\ncat "$1"\n`);
  await chmod(payload, 0o755);
  const injection = await new GrepTool().execute({ pattern: `--pre=${payload}`, literal: true }, context);
  assert.equal(injection.content, "No matches found");
  await assert.rejects(import("node:fs/promises").then(({ access }) => access(marker)), /ENOENT/u);
});

test("ls includes dotfiles, marks directories, and counts only stat-able entries toward its limit", async (t) => {
  const { root, context } = await findFixture(t);
  await writeFile(join(root, ".hidden-file"), "secret");
  await mkdir(join(root, ".hidden-dir"));
  const result = await new LsTool().execute({ path: root }, context);
  assert.match(result.content, /^\.hidden-dir\/\n\.hidden-file$/u);

  const custom = new LsTool({
    operations: {
      exists: () => true,
      readdir: () => ["missing", "kept", "later"],
      stat: (path) => {
        if (path.endsWith("/missing")) throw new Error("gone");
        return { isDirectory: () => path === root };
      },
    },
  });
  const limited = await custom.execute({ path: root, limit: 1 }, context);
  assert.match(limited.content, /^kept\n\n\[1 entries limit reached/u);
});
