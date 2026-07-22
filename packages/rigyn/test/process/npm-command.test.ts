import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultNpmCommand } from "../../src/process/npm-command.js";

test("Windows npm resolution launches npm-cli.js through Node without a command shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-npm-command-"));
  const node = join(root, "node.exe");
  const npmCli = join(root, "node_modules", "npm", "bin", "npm-cli.js");
  await mkdir(join(root, "node_modules", "npm", "bin"), { recursive: true });
  await writeFile(node, "");
  await writeFile(npmCli, "");

  assert.deepEqual(defaultNpmCommand("win32", {}, node), [node, npmCli]);
  assert.deepEqual(defaultNpmCommand("linux", {}, node), ["npm"]);
});

test("Windows npm resolution honors the active npm entry point", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-npm-command-env-"));
  const node = join(root, "node.exe");
  const npmCli = join(root, "active-npm-cli.js");
  await writeFile(npmCli, "");

  assert.deepEqual(defaultNpmCommand("win32", { npm_execpath: npmCli }, node), [node, npmCli]);
});
