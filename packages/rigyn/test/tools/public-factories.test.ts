import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  allToolNames,
  createAllToolDefinitions,
  createCodingToolDefinitions,
  createEditToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createReadOnlyToolDefinitions,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "../../src/tools/index.js";

test("public tool collections expose the seven stable tools in their target groups", () => {
  assert.deepEqual([...allToolNames], ["read", "bash", "edit", "write", "grep", "find", "ls"]);
  assert.deepEqual(createCodingToolDefinitions(process.cwd()).map((tool) => tool.name), ["read", "bash", "edit", "write"]);
  assert.deepEqual(createReadOnlyToolDefinitions(process.cwd()).map((tool) => tool.name), ["read", "grep", "find", "ls"]);
  assert.deepEqual(Object.keys(createAllToolDefinitions(process.cwd())), ["read", "bash", "edit", "write", "grep", "find", "ls"]);
});

test("read, write, and edit factories honor injected operations", async () => {
  const cwd = resolve("/virtual/workspace");
  const read = createReadToolDefinition(cwd, {
    operations: {
      async access() {},
      async readFile() { return Buffer.from("one\ntwo", "utf8"); },
    },
  });
  const readResult = await read.execute("read-1", { path: "notes.txt", offset: 2 }, undefined, undefined, undefined as never);
  assert.equal(readResult.content[0]?.type === "text" ? readResult.content[0].text : undefined, "two");

  const writes: Array<{ path: string; content: string }> = [];
  const directories: string[] = [];
  const write = createWriteToolDefinition(cwd, {
    operations: {
      async mkdir(path) { directories.push(path); },
      async writeFile(path, content) { writes.push({ path, content }); },
    },
  });
  await write.execute("write-1", { path: "new/file.txt", content: "hello" }, undefined, undefined, undefined as never);
  assert.deepEqual(directories, [join(cwd, "new")]);
  assert.deepEqual(writes, [{ path: join(cwd, "new", "file.txt"), content: "hello" }]);

  let edited = "alpha\nbeta\n";
  const edit = createEditToolDefinition(cwd, {
    operations: {
      async access() {},
      async readFile() { return Buffer.from(edited, "utf8"); },
      async writeFile(_path, content) { edited = content; },
    },
  });
  const editResult = await edit.execute(
    "edit-1",
    { path: "file.txt", edits: [{ oldText: "beta", newText: "gamma" }] },
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(edited, "alpha\ngamma\n");
  assert.equal(editResult.details?.firstChangedLine, 2);
});

test("find and ls factories honor injected discovery operations", async () => {
  const cwd = resolve("/virtual/workspace");
  const find = createFindToolDefinition(cwd, {
    operations: {
      exists: () => true,
      glob: () => [join(cwd, "src", "a.ts"), join(cwd, "src", "b.ts")],
    },
  });
  const found = await find.execute("find-1", { pattern: "**/*.ts" }, undefined, undefined, undefined as never);
  assert.equal(found.content[0]?.type === "text" ? found.content[0].text : undefined, "src/a.ts\nsrc/b.ts");

  const ls = createLsToolDefinition(cwd, {
    operations: {
      exists: () => true,
      stat: (path) => ({ isDirectory: () => path === join(cwd, "folder") || path === cwd }),
      readdir: () => ["z.txt", "folder", "a.txt"],
    },
  });
  const listed = await ls.execute("ls-1", {}, undefined, undefined, undefined as never);
  assert.equal(listed.content[0]?.type === "text" ? listed.content[0].text : undefined, "a.txt\nfolder/\nz.txt");
});

test("default factory definitions execute against their captured cwd", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-tool-factory-"));
  t.after(async () => await rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "captured.txt"), "captured cwd", "utf8");
  const read = createReadToolDefinition(cwd);
  const result = await read.execute("read-cwd", { path: "captured.txt" }, undefined, undefined, undefined as never);
  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "captured cwd");
});
