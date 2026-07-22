import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DirectProcessRunner } from "../../src/process/index.js";
import { GrepTool, WorkspaceBoundary } from "../../src/tools/index.js";
import { resolveRipgrep } from "../../src/tools/ripgrep.js";
import type { ToolContext } from "../../src/tools/types.js";

test("bundled ripgrep powers grep when PATH has no rg", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-bundled-ripgrep-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  context.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });
  await writeFile(join(root, "source.txt"), "alpha\nNeedle one\nneedle two\n");
  const tools: ToolContext = {
    workspace: await WorkspaceBoundary.create(root),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "run",
    threadId: "thread",
  };

  const grep = await new GrepTool().execute({ pattern: "needle", ignoreCase: true }, tools);
  assert.equal(grep.content, "source.txt:2: Needle one\nsource.txt:3: needle two");
  assert.equal((grep.metadata as { engine?: string }).engine, "ripgrep");

});

test("ripgrep resolution falls back after an unsupported bundle and still excludes workspace PATH entries", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-ripgrep-resolution-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const outside = join(root, "outside");
  const workspace = join(root, "workspace");
  await mkdir(outside);
  await mkdir(workspace);
  const outsideRg = join(outside, "rg");
  const workspaceRg = join(workspace, "rg");
  await writeFile(outsideRg, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(workspaceRg, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const unsupported = async (): Promise<never> => {
    throw new Error("unsupported platform package");
  };

  assert.equal(
    await resolveRipgrep({ excludedRoot: workspace, environment: { PATH: outside } }, unsupported),
    await realpath(outsideRg),
  );
  assert.equal(
    await resolveRipgrep({ excludedRoot: workspace, environment: { PATH: workspace } }, unsupported),
    undefined,
  );
  assert.equal(await resolveRipgrep({ environment: { PATH: "" } }, unsupported), undefined);
});
