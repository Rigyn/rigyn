import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { walkWorkspace } from "../../src/tools/index.js";

async function fixture(context: { after(callback: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-walker-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  return root;
}

test("workspace walker applies nested .gitignore and .ignore rules with directory re-inclusion", async (context) => {
  const root = await fixture(context);
  await mkdir(join(root, "ignored", "restored"), { recursive: true });
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await writeFile(join(root, ".gitignore"), [
    "restored-at-root.txt",
    "ignored/*",
    "!ignored/restored/",
    "ignored/restored/*",
    "!ignored/restored/keep.txt",
    "",
  ].join("\n"));
  await writeFile(join(root, ".ignore"), "!restored-at-root.txt\n");
  await writeFile(join(root, "restored-at-root.txt"), "root");
  await writeFile(join(root, "ignored", "drop.txt"), "drop");
  await writeFile(join(root, "ignored", "restored", "drop.txt"), "drop");
  await writeFile(join(root, "ignored", "restored", "keep.txt"), "keep");
  await writeFile(join(root, "src", ".gitignore"), "*.generated\n!keep.generated\n");
  await writeFile(join(root, "src", "drop.generated"), "drop");
  await writeFile(join(root, "src", "keep.generated"), "keep");
  await writeFile(join(root, "src", "nested", ".ignore"), "private.txt\n!public.txt\n");
  await writeFile(join(root, "src", "nested", "private.txt"), "private");
  await writeFile(join(root, "src", "nested", "public.txt"), "public");

  const first = (await walkWorkspace(root)).entries.map((entry) => entry.path);
  const second = (await walkWorkspace(root)).entries.map((entry) => entry.path);
  assert.deepEqual(first, second);
  assert.deepEqual(first, [
    ".gitignore",
    ".ignore",
    "ignored/restored/keep.txt",
    "restored-at-root.txt",
    "src/.gitignore",
    "src/keep.generated",
    "src/nested/.ignore",
    "src/nested/public.txt",
  ]);
});

test("walker rejects symlink escapes and omits credential paths", async (context) => {
  const root = await fixture(context);
  const outside = await mkdtemp(join(tmpdir(), "harness-walker-outside-"));
  context.after(async () => await rm(outside, { recursive: true, force: true }));
  await mkdir(join(root, ".SSH"));
  await mkdir(join(root, ".AWS"));
  await mkdir(join(root, ".git", "objects"), { recursive: true });
  await writeFile(join(root, "visible.txt"), "shared visible\n");
  await writeFile(join(root, ".env.local"), "shared env\n");
  await writeFile(join(root, "private.KEY"), "shared key\n");
  await writeFile(join(root, ".SSH", "id_rsa"), "shared ssh\n");
  await writeFile(join(root, ".AWS", "credentials"), "shared aws\n");
  await writeFile(join(root, ".git", "config"), "shared git\n");
  await writeFile(join(outside, "outside.txt"), "shared outside\n");
  await symlink(outside, join(root, "escape"));

  assert.deepEqual((await walkWorkspace(root)).entries.map((entry) => entry.path), ["visible.txt"]);
  await assert.rejects(walkWorkspace(root, { path: "escape/outside.txt" }), /escapes workspace/u);

});

test("an explicit ignored regular file is readable but sensitive files and symlinks are not", async (context) => {
  const root = await fixture(context);
  const outside = await mkdtemp(join(tmpdir(), "harness-walker-explicit-"));
  context.after(async () => await rm(outside, { recursive: true, force: true }));
  await writeFile(join(root, ".ignore"), "ignored.txt\n");
  await writeFile(join(root, "ignored.txt"), "explicit needle\n");
  await writeFile(join(root, ".env.test"), "explicit secret\n");
  await writeFile(join(outside, "outside.txt"), "explicit outside\n");
  await symlink(join(outside, "outside.txt"), join(root, "alias.txt"));

  assert.deepEqual((await walkWorkspace(root)).entries.map((entry) => entry.path), [".ignore"]);
  assert.deepEqual((await walkWorkspace(root, { path: "ignored.txt" })).entries.map((entry) => entry.path), ["ignored.txt"]);
  assert.deepEqual((await walkWorkspace(root, { path: ".env.test" })).entries, []);
  await assert.rejects(walkWorkspace(root, { path: "alias.txt" }), /escapes workspace/u);

});

test("walker cancellation and output ordering are deterministic", async (context) => {
  const root = await fixture(context);
  await mkdir(join(root, "z"));
  await mkdir(join(root, "a"));
  await writeFile(join(root, "z", "one.txt"), "one");
  await writeFile(join(root, "a", "two.txt"), "two");
  await writeFile(join(root, "middle.txt"), "middle");
  const controller = new AbortController();
  controller.abort(new Error("walker cancelled"));
  await assert.rejects(walkWorkspace(root, { signal: controller.signal }), /walker cancelled/u);

  assert.deepEqual((await walkWorkspace(root)).entries.map((entry) => entry.path), [
    "a/two.txt",
    "middle.txt",
    "z/one.txt",
  ]);
});

test("an unreadable directory marks the scan incomplete without hiding later siblings", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (context) => {
  const root = await fixture(context);
  const blocked = join(root, "a-blocked");
  await mkdir(blocked);
  await writeFile(join(blocked, "hidden.txt"), "hidden");
  await writeFile(join(root, "z-visible.txt"), "visible");
  await chmod(blocked, 0o000);
  try {
    const scanned = await walkWorkspace(root);
    assert.equal(scanned.truncated, true);
    assert.deepEqual(scanned.entries.map((entry) => entry.path), ["z-visible.txt"]);
  } finally {
    await chmod(blocked, 0o700);
  }
});
