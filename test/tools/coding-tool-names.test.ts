import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProviderRegistry } from "../../src/providers/registry.js";
import { DirectProcessRunner } from "../../src/process/index.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { createScriptedProvider } from "../../src/testing/index.js";
import { FindTool, GrepTool, LsTool, WorkspaceBoundary } from "../../src/tools/index.js";
import type { ToolContext } from "../../src/tools/types.js";

async function fixture(context: { after(callback: () => Promise<void>): void }): Promise<{
  root: string;
  tools: ToolContext;
}> {
  const root = await mkdtemp(join(tmpdir(), "harness-coding-tools-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  return {
    root,
    tools: {
      workspace: await WorkspaceBoundary.create(root),
      runner: new DirectProcessRunner(),
      signal: new AbortController().signal,
      runId: "run",
      threadId: "thread",
    },
  };
}

test("grep supports literal and regex matching, case folding, globs, context, and global limits", async (context) => {
  const { root, tools } = await fixture(context);
  await mkdir(join(root, "src"));
  await writeFile(join(root, ".gitignore"), "ignored.ts\n");
  await writeFile(join(root, ".env.ts"), "needle secret\n");
  await writeFile(join(root, "ignored.ts"), "needle ignored\n");
  await writeFile(join(root, "src", "other.js"), "needle javascript\n");
  await writeFile(join(root, "src", "sample.ts"), [
    "before",
    "Needle one",
    "after",
    "NEEDLE two",
    "tail",
  ].join("\n"));

  const grep = new GrepTool();
  const contextual = await grep.execute({
    pattern: "needle",
    literal: true,
    ignoreCase: true,
    glob: "**/*.ts",
    context: 1,
    limit: 1,
  }, tools);
  assert.equal(contextual.content, [
    "src/sample.ts-1- before",
    "src/sample.ts:2: Needle one",
    "src/sample.ts-3- after",
  ].join("\n"));
  assert.deepEqual(contextual.metadata, {
    count: 1,
    truncated: true,
    outputTruncated: false,
    linesTruncated: false,
    contextUnavailable: false,
    engine: "ripgrep",
  });

  const regex = await grep.execute({ pattern: "Needle\\s+one", path: "src/sample.ts" }, tools);
  assert.equal(regex.content, "sample.ts:2: Needle one");
  await assert.rejects(
    grep.execute({ pattern: "[", path: "src/sample.ts" }, tools),
    /ripgrep failed|regex parse error/iu,
  );
  await mkdir(join(root, "empty"));
  await assert.rejects(
    grep.execute({ pattern: "[", path: "empty" }, tools),
    /ripgrep failed|regex parse error/iu,
  );
});

test("find matches path globs relative to the requested root while respecting hidden and ignored files", async (context) => {
  const { root, tools } = await fixture(context);
  await mkdir(join(root, ".secret"));
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "ignored.ts\n");
  await writeFile(join(root, ".env.ts"), "secret\n");
  await writeFile(join(root, "ignored.ts"), "ignored\n");
  await writeFile(join(root, ".secret", "hidden.ts"), "hidden\n");
  await writeFile(join(root, "src", "nested", "keep.ts"), "kept\n");
  await writeFile(join(root, "src", "nested", "other.js"), "other\n");

  const find = new FindTool();
  const all = await find.execute({ pattern: "**/*.ts" }, tools);
  assert.equal(all.content, [".secret/hidden.ts", "src/nested/keep.ts"].join("\n"));
  assert.equal((all.metadata as { truncated?: boolean }).truncated, false);

  const relative = await find.execute({ pattern: "nested/*.ts", path: "src" }, tools);
  assert.equal(relative.content, "nested/keep.ts");

  const limited = await find.execute({ pattern: "**/*.ts", limit: 1 }, tools);
  assert.equal(limited.content, ".secret/hidden.ts");
  assert.equal((limited.metadata as { truncated?: boolean }).truncated, true);
});

test("ls includes dotfiles, sorts without case sensitivity, marks directories, and bounds entries", async (context) => {
  const { root, tools } = await fixture(context);
  await writeFile(join(root, ".hidden"), "hidden\n");
  await mkdir(join(root, "alpha"));
  await writeFile(join(root, "beta"), "beta\n");
  await writeFile(join(root, "Zoo"), "zoo\n");

  const ls = new LsTool();
  const result = await ls.execute({}, tools);
  assert.equal(result.content, [".hidden", "alpha/", "beta", "Zoo"].join("\n"));
  assert.equal((result.metadata as { truncated?: boolean }).truncated, false);

  const limited = await ls.execute({ limit: 2 }, tools);
  assert.equal(limited.content, [".hidden", "alpha/"].join("\n"));
  assert.equal((limited.metadata as { truncated?: boolean }).truncated, true);
});

test("grep, find, and ls accept absolute paths outside the starting workspace", async (context) => {
  const { tools } = await fixture(context);
  const outside = await mkdtemp(join(tmpdir(), "harness-coding-tools-outside-"));
  context.after(async () => await rm(outside, { recursive: true, force: true }));
  await mkdir(join(outside, "src"));
  await writeFile(join(outside, "src", "external.ts"), "external needle\n");

  const grep = new GrepTool();
  const grepResult = await grep.execute({ pattern: "needle", path: outside }, tools);
  assert.equal(grepResult.content, "src/external.ts:1: external needle");
  const externalFile = join(outside, "src", "external.ts");
  const grepFile = await grep.execute({ pattern: "needle", path: externalFile }, tools);
  assert.equal(grepFile.content, "external.ts:1: external needle");
  assert.deepEqual(await grep.resources({ pattern: "needle", path: outside }, tools), [
    { kind: "file", key: outside, mode: "read" },
  ]);

  const find = new FindTool();
  const findResult = await find.execute({ pattern: "**/*.ts", path: outside }, tools);
  assert.equal(findResult.content, "src/external.ts");
  assert.equal((findResult.metadata as { path?: string }).path, outside);

  const ls = new LsTool();
  const source = join(outside, "src");
  const lsResult = await ls.execute({ path: source }, tools);
  assert.equal(lsResult.content, "external.ts");
  assert.equal((lsResult.metadata as { path?: string }).path, source);
});

test("explicit tool selection exposes grep, find, and ls", async (context) => {
  const { root } = await fixture(context);
  const provider = createScriptedProvider({
    id: "coding-tools-surface",
    models: [{ id: "fixture-model" }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "done" }] }],
  });
  const store = new SessionStore(":memory:");
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    projectTrusted: true,
  });
  context.after(async () => {
    await service.close("coding_tools_test");
    store.close();
  });
  await service.initialize({ skills: [] });
  await service.run({
    prompt: "Inspect the tool surface",
    provider: provider.id,
    model: "fixture-model",
    allowedTools: ["grep", "find", "ls"],
  });
  assert.deepEqual(provider.capturedRequests()[0]?.tools?.map((tool) => tool.name), ["find", "grep", "ls"]);

});
