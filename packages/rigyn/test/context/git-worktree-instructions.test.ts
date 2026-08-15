import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, test } from "node:test";

import { findNestedGitWorktree } from "../../src/context/git-worktree.js";
import { discoverInstructions } from "../../src/context/instructions.js";
import { loadProjectContextFiles } from "../../src/core/resource-loader.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function linkWorktree(main: string, worktree: string, name: string): Promise<void> {
  const gitDirectory = join(main, ".git", "worktrees", name);
  await mkdir(gitDirectory, { recursive: true });
  await writeFile(join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(gitDirectory, "HEAD"), `ref: refs/heads/${name}\n`);
  await writeFile(join(gitDirectory, "commondir"), "../..\n");
  await writeFile(join(worktree, ".git"), `gitdir: ${gitDirectory}\n`);
}

async function nestedWorktree(prefix: string): Promise<{
  fixture: string;
  outer: string;
  main: string;
  worktree: string;
  cwd: string;
}> {
  const fixture = await temporaryDirectory(prefix);
  const outer = join(fixture, "outer");
  const main = join(outer, "main");
  const worktree = join(main, "worktrees", "feature");
  const cwd = join(worktree, "src");
  await mkdir(cwd, { recursive: true });
  await linkWorktree(main, worktree, "feature");
  return { fixture, outer, main, worktree, cwd };
}

function inside(fixture: string, path: string): boolean {
  return path.startsWith(`${fixture}${sep}`);
}

async function assertBothLoaders(
  fixture: string,
  workspaceRoot: string,
  cwd: string,
  expected: string[],
): Promise<void> {
  const agentDir = join(fixture, "agent");
  await mkdir(agentDir, { recursive: true });
  const loaded = loadProjectContextFiles({ cwd, agentDir })
    .filter((entry) => inside(fixture, entry.path))
    .map((entry) => entry.content);
  const discovered = (await discoverInstructions({ workspaceRoot, cwd, trusted: true })).entries
    .filter((entry) => entry.scope === "workspace" && inside(fixture, entry.source))
    .map((entry) => entry.text);
  assert.deepEqual(loaded, expected);
  assert.deepEqual(discovered, expected);
}

test("nested worktree instructions shadow the same main filename without hiding higher ancestors", async () => {
  const { fixture, outer, main, worktree, cwd } = await nestedWorktree("rigyn-context-nested-worktree-");
  await writeFile(join(outer, "AGENTS.md"), "outer instructions");
  await writeFile(join(main, "AGENTS.md"), "main instructions");
  await writeFile(join(worktree, "AGENTS.md"), "worktree instructions");

  await assertBothLoaders(fixture, worktree, cwd, ["outer instructions", "worktree instructions"]);
});

test("a nested worktree without local instructions inherits the main file", async () => {
  const { fixture, main, worktree, cwd } = await nestedWorktree("rigyn-context-worktree-inherit-");
  await writeFile(join(main, "AGENTS.md"), "main instructions");

  await assertBothLoaders(fixture, worktree, cwd, ["main instructions"]);
});

test("different instruction filenames in the main and nested worktree both load", async () => {
  const { fixture, main, worktree, cwd } = await nestedWorktree("rigyn-context-worktree-names-");
  await writeFile(join(main, "CLAUDE.md"), "main alternate instructions");
  await writeFile(join(worktree, "AGENTS.md"), "worktree instructions");

  await assertBothLoaders(
    fixture,
    worktree,
    cwd,
    ["main alternate instructions", "worktree instructions"],
  );
});

test("ordinary repositories keep normal ancestor inheritance", async () => {
  const fixture = await temporaryDirectory("rigyn-context-ordinary-repository-");
  const outer = join(fixture, "outer");
  const repository = join(outer, "repository");
  const cwd = join(repository, "src");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(outer, "AGENTS.md"), "outer instructions");
  await writeFile(join(repository, "AGENTS.md"), "repository instructions");

  await assertBothLoaders(
    fixture,
    repository,
    cwd,
    ["outer instructions", "repository instructions"],
  );
});

test("sibling worktrees do not hide their shared ancestor instructions", async () => {
  const fixture = await temporaryDirectory("rigyn-context-sibling-worktree-");
  const outer = join(fixture, "outer");
  const main = join(outer, "main");
  const worktree = join(outer, "feature");
  const cwd = join(worktree, "src");
  await mkdir(cwd, { recursive: true });
  await linkWorktree(main, worktree, "feature");
  await writeFile(join(outer, "AGENTS.md"), "outer instructions");
  await writeFile(join(worktree, "AGENTS.md"), "worktree instructions");

  await assertBothLoaders(fixture, worktree, cwd, ["outer instructions", "worktree instructions"]);
});

test("submodules retain superproject and local instructions", async () => {
  const fixture = await temporaryDirectory("rigyn-context-submodule-");
  const superproject = join(fixture, "superproject");
  const submodule = join(superproject, "vendor", "library");
  const cwd = join(submodule, "src");
  const gitDirectory = join(superproject, ".git", "modules", "vendor", "library");
  await mkdir(gitDirectory, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(gitDirectory, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(submodule, ".git"), `gitdir: ${gitDirectory}\n`);
  await writeFile(join(superproject, "AGENTS.md"), "superproject instructions");
  await writeFile(join(submodule, "AGENTS.md"), "submodule instructions");

  await assertBothLoaders(
    fixture,
    submodule,
    cwd,
    ["superproject instructions", "submodule instructions"],
  );
});

test("worktrees backed by a bare repository retain container instructions", async () => {
  const fixture = await temporaryDirectory("rigyn-context-bare-worktree-");
  const container = join(fixture, "project");
  const bare = join(container, ".bare");
  const worktree = join(container, "main");
  const gitDirectory = join(bare, "worktrees", "main");
  await mkdir(gitDirectory, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(join(bare, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(gitDirectory, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(gitDirectory, "commondir"), "../..\n");
  await writeFile(join(worktree, ".git"), `gitdir: ${gitDirectory}\n`);
  await writeFile(join(container, "AGENTS.md"), "container instructions");
  await writeFile(join(worktree, "AGENTS.md"), "worktree instructions");

  await assertBothLoaders(
    fixture,
    worktree,
    worktree,
    ["container instructions", "worktree instructions"],
  );
});

test("non-Git directories retain normal ancestor instructions", async () => {
  const fixture = await temporaryDirectory("rigyn-context-no-git-");
  const outer = join(fixture, "outer");
  const workspace = join(outer, "workspace");
  const cwd = join(workspace, "src");
  await mkdir(cwd, { recursive: true });
  await writeFile(join(outer, "AGENTS.md"), "outer instructions");
  await writeFile(join(workspace, "AGENTS.md"), "workspace instructions");

  await assertBothLoaders(
    fixture,
    workspace,
    cwd,
    ["outer instructions", "workspace instructions"],
  );
});

test("oversized worktree metadata is ignored", async () => {
  const { main, worktree } = await nestedWorktree("rigyn-context-worktree-metadata-");
  const gitFile = join(worktree, ".git");
  const validGitFile = `gitdir: ${join(main, ".git", "worktrees", "feature")}\n`;

  await writeFile(gitFile, "x".repeat(4 * 1024 + 1));
  assert.equal(findNestedGitWorktree(worktree), undefined);

  await writeFile(gitFile, validGitFile);
  await writeFile(join(main, ".git", "worktrees", "feature", "commondir"), "x".repeat(4 * 1024 + 1));
  assert.equal(findNestedGitWorktree(worktree), undefined);
});
