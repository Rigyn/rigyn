import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { DirectProcessRunner } from "../../src/process/index.js";
import {
  EditTool,
  expandPath,
  FindTool,
  GrepTool,
  LsTool,
  resolveReadPath,
  resolveToCwd,
  WorkspaceBoundary,
} from "../../src/tools/index.js";
import type { ToolContext } from "../../src/tools/types.js";

async function toolFixture(t: test.TestContext): Promise<{ root: string; context: ToolContext }> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-tool-boundary-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return {
    root,
    context: {
      workspace: await WorkspaceBoundary.create(root),
      runner: new DirectProcessRunner(),
      signal: new AbortController().signal,
      runId: "boundary-run",
      threadId: "boundary-thread",
    },
  };
}

async function matchingPaths(pattern: string, context: ToolContext): Promise<string[]> {
  const result = await new FindTool().execute({ pattern }, context);
  if (result.content === "No paths matched the file glob") return [];
  return result.content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("["));
}

test("path helpers keep literal tildes and normalize common pasted filename characters", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-path-boundary-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));

  for (const [input, expected] of [
    ["~notes.log", "~notes.log"],
    ["@~notes.log", "~notes.log"],
    ["build\u00a0report.txt", "build report.txt"],
  ] as const) {
    assert.equal(expandPath(input), expected);
  }
  assert.equal(resolveToCwd("~notes.log", root), join(root, "~notes.log"));
  const fileUrl = pathToFileURL(join(root, "URL name.txt")).href;
  assert.equal(expandPath(fileUrl.replace(/^file:/u, "FILE:")), join(root, "URL name.txt"));
  assert.equal(resolveToCwd(fileUrl.replace(/^file:/u, "FiLe:"), root), join(root, "URL name.txt"));

  const apostrophePath = join(root, "Auteur\u2019s résumé.txt");
  await writeFile(apostrophePath, "unicode punctuation");
  assert.equal(resolveReadPath("Auteur's résumé.txt", root), apostrophePath);

  const clockPath = join(root, "Build 2026-07-30 at 9.30\u202fPM.log");
  await writeFile(clockPath, "narrow space");
  assert.equal(resolveReadPath("Build 2026-07-30 at 9.30 PM.log", root), clockPath);
});

test("find applies filename and directory-aware globs to nested paths", async (t) => {
  const { root, context } = await toolFixture(t);
  const files = [
    "modules/parser/fixtures/sample.data",
    "modules/parser/fixtures/parser.check.ts",
    "checks/integration/network/socket.check.ts",
  ];
  for (const path of files) {
    await mkdir(join(root, ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(root, path), "");
  }

  assert.deepEqual(await matchingPaths("*.check.ts", context), [
    "checks/integration/network/socket.check.ts",
    "modules/parser/fixtures/parser.check.ts",
  ]);
  assert.deepEqual(await matchingPaths("checks/**/*.check.ts", context), [
    "checks/integration/network/socket.check.ts",
  ]);
  assert.deepEqual(await matchingPaths("**/parser/fixtures/*", context), [
    "modules/parser/fixtures/parser.check.ts",
    "modules/parser/fixtures/sample.data",
  ]);
});

test("ignore files affect only their directory and descendants", async (t) => {
  const { root, context } = await toolFixture(t);
  await mkdir(join(root, "private", "generated"), { recursive: true });
  await mkdir(join(root, "public"));
  await writeFile(join(root, "private", ".gitignore"), "scratch.log\n");
  await writeFile(join(root, "private", "generated", ".gitignore"), "token.log\n");
  for (const path of [
    "private/scratch.log",
    "private/kept.log",
    "private/generated/scratch.log",
    "private/generated/token.log",
    "private/generated/result.log",
    "public/scratch.log",
    "public/kept.log",
    "top.log",
  ]) await writeFile(join(root, path), "");

  assert.deepEqual(await matchingPaths("**/*.log", context), [
    "private/generated/result.log",
    "private/kept.log",
    "public/kept.log",
    "public/scratch.log",
    "top.log",
  ]);
});

test("find includes dot paths, honors ignore rules, and treats flag-shaped input as a glob", async (t) => {
  const { root, context } = await toolFixture(t);
  await mkdir(join(root, ".vault"));
  await writeFile(join(root, ".vault", "config.ini"), "hidden");
  await writeFile(join(root, ".gitignore"), "discard.ini\n");
  await writeFile(join(root, "discard.ini"), "ignored");
  await writeFile(join(root, "visible.ini"), "visible");

  assert.deepEqual(await matchingPaths("**/*.ini", context), [".vault/config.ini", "visible.ini"]);
  await assert.rejects(
    new FindTool().execute({ pattern: "[" }, context),
    /glob|fd exited with code 1|fd error/iu,
  );
  assert.deepEqual(await matchingPaths("--help", context), []);
});

test("grep bounds context and cannot execute a flag-shaped search value", async (t) => {
  const { root, context } = await toolFixture(t);
  const source = join(root, "search-source.log");
  await writeFile(source, "alpha\nneedle first\nomega\nneedle second\n");

  const result = await new GrepTool().execute({
    pattern: "needle",
    path: source,
    limit: 1,
    context: 1,
  }, context);
  assert.match(result.content, /search-source\.log-1- alpha/u);
  assert.match(result.content, /search-source\.log:2: needle first/u);
  assert.match(result.content, /search-source\.log-3- omega/u);
  assert.match(result.content, /\[Returned the first 1 matches\. Raise limit to 2 or narrow the search\]/u);
  assert.doesNotMatch(result.content, /needle second/u);

  const marker = join(root, "unexpected-command-output");
  const payload = join(root, "untrusted-filter.sh");
  await writeFile(payload, `#!/bin/sh\nprintf 'unsafe' > ${marker}\ncat "$1"\n`);
  await chmod(payload, 0o755);
  const injection = await new GrepTool().execute({
    pattern: `--pre=${payload}`,
    literal: true,
  }, context);
  assert.equal(injection.content, "Search found no matching lines");
  await assert.rejects(
    import("node:fs/promises").then(({ access }) => access(marker)),
    /ENOENT/u,
  );
});

test("ls reports dot entries and applies its limit only to entries it can inspect", async (t) => {
  const { root, context } = await toolFixture(t);
  await writeFile(join(root, ".environment"), "private");
  await mkdir(join(root, ".workspace"));
  const result = await new LsTool().execute({ path: root }, context);
  assert.match(result.content, /^\.environment\n\.workspace\/$/u);

  const custom = new LsTool({
    operations: {
      exists: () => true,
      readdir: () => ["vanished", "first", "second"],
      stat: (path) => {
        if (path.endsWith("/vanished")) throw new Error("gone");
        return { isDirectory: () => path === root };
      },
    },
  });
  const limited = await custom.execute({ path: root, limit: 1 }, context);
  assert.match(limited.content, /^first\n\n\[Returned the first 1 entries/u);
});

test("file tools safely report hostile injected operation failures", async (t) => {
  const { root, context } = await toolFixture(t);
  const hostile = (onTrap: () => void): object => new Proxy(Object.create(null) as object, {
    get() {
      onTrap();
      throw new Error("property trap");
    },
    getOwnPropertyDescriptor() {
      onTrap();
      throw new Error("descriptor trap");
    },
    getPrototypeOf() {
      onTrap();
      throw new Error("prototype trap");
    },
    ownKeys() {
      onTrap();
      throw new Error("keys trap");
    },
  });

  let lsTraps = 0;
  await assert.rejects(new LsTool({
    operations: {
      exists: () => true,
      stat: () => ({ isDirectory: () => true }),
      readdir() { throw hostile(() => { lsTraps += 1; }); },
    },
  }).execute({ path: root }, context), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Directory listing failed: [Thrown object]");
    return true;
  });
  assert.equal(lsTraps, 0);

  let editTraps = 0;
  await assert.rejects(new EditTool({
    operations: {
      access() { throw hostile(() => { editTraps += 1; }); },
      async readFile() { return Buffer.from("before"); },
      async writeFile() {},
    },
  }).execute({
    path: "hostile.txt",
    edits: [{ oldText: "before", newText: "after" }],
  }, context), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Editing hostile.txt failed: [Thrown object].");
    return true;
  });
  assert.equal(editTraps, 0);
});
