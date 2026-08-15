import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverWorkspacePromptFiles } from "../../src/context/system-prompt-files.js";

async function fixture(context: test.TestContext): Promise<{
  root: string;
  workspace: string;
  globalDirectory: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-prompt-files-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const globalDirectory = join(root, "global");
  await mkdir(join(workspace, ".rigyn"), { recursive: true });
  await mkdir(globalDirectory);
  return { root, workspace, globalDirectory };
}

test("workspace prompt discovery respects trust, precedence, and the system-prompt switch", async (context) => {
  const value = await fixture(context);
  await writeFile(join(value.workspace, ".rigyn", "SYSTEM.md"), "workspace system");
  await writeFile(join(value.workspace, ".rigyn", "APPEND_SYSTEM.md"), "workspace append");
  await writeFile(join(value.globalDirectory, "SYSTEM.md"), "global system");
  await writeFile(join(value.globalDirectory, "APPEND_SYSTEM.md"), "global append");

  assert.deepEqual(await discoverWorkspacePromptFiles(value.workspace, true, {
    globalDirectory: value.globalDirectory,
  }), {
    systemPrompt: { text: "workspace system", source: ".rigyn/SYSTEM.md" },
    appendSystemPrompt: [{ text: "workspace append", source: ".rigyn/APPEND_SYSTEM.md" }],
  });

  assert.deepEqual(await discoverWorkspacePromptFiles(value.workspace, false, {
    globalDirectory: value.globalDirectory,
  }), {
    systemPrompt: { text: "global system", source: "SYSTEM.md" },
    appendSystemPrompt: [{ text: "global append", source: "APPEND_SYSTEM.md" }],
  });

  assert.deepEqual(await discoverWorkspacePromptFiles(value.workspace, true, {
    includeSystemPrompt: false,
    globalDirectory: value.globalDirectory,
  }), {
    appendSystemPrompt: [{ text: "workspace append", source: ".rigyn/APPEND_SYSTEM.md" }],
  });
});

test("missing optional prompt locations produce an empty result", async (context) => {
  const value = await fixture(context);
  await rm(join(value.workspace, ".rigyn"), { recursive: true });
  await rm(value.globalDirectory, { recursive: true });

  assert.deepEqual(await discoverWorkspacePromptFiles(value.workspace, true, {
    globalDirectory: value.globalDirectory,
  }), {});
  assert.deepEqual(await discoverWorkspacePromptFiles(join(value.root, "missing-workspace"), false), {});
});

test("prompt files reject oversized, malformed UTF-8, and NUL-bearing content", async (context) => {
  const value = await fixture(context);
  const systemPath = join(value.workspace, ".rigyn", "SYSTEM.md");

  await writeFile(systemPath, Buffer.alloc(256 * 1024 + 1, 0x61));
  await assert.rejects(
    discoverWorkspacePromptFiles(value.workspace, true),
    /\.rigyn\/SYSTEM\.md exceeds 256 KiB/u,
  );

  await writeFile(systemPath, Buffer.from([0xc3, 0x28]));
  await assert.rejects(
    discoverWorkspacePromptFiles(value.workspace, true),
    /\.rigyn\/SYSTEM\.md must be valid UTF-8/u,
  );

  await writeFile(systemPath, "before\0after");
  await assert.rejects(
    discoverWorkspacePromptFiles(value.workspace, true),
    /\.rigyn\/SYSTEM\.md must not contain NUL/u,
  );
});

test("prompt discovery rejects files that resolve outside a trusted workspace", {
  skip: process.platform === "win32",
}, async (context) => {
  const value = await fixture(context);
  const outside = join(value.root, "outside.md");
  await writeFile(outside, "outside");
  await symlink(outside, join(value.workspace, ".rigyn", "SYSTEM.md"));

  await assert.rejects(
    discoverWorkspacePromptFiles(value.workspace, true),
    /Resolved path escapes workspace/u,
  );
});
