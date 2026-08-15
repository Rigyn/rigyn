import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadProjectContextFiles } from "../../src/core/resource-loader.js";

async function writeFlatFiles(directory: string, count: number): Promise<void> {
  for (let start = 0; start < count; start += 256) {
    await Promise.all(Array.from(
      { length: Math.min(256, count - start) },
      (_, offset) => writeFile(join(directory, `filler-${String(start + offset).padStart(5, "0")}`), ""),
    ));
  }
}

test("the blank packaged personal file adds no instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-context-packaged-personal-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const packaged = await readFile(resolve("resources", "AGENTS.md"), "utf8");
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(join(agentDir, "AGENTS.md"), packaged);
  await writeFile(join(cwd, "AGENTS.md"), "project rules");

  const result = loadProjectContextFiles({ cwd, agentDir });
  assert.equal(packaged, "");
  assert.deepEqual(result.map((entry) => entry.content), ["project rules"]);
});

test("context files load global first and ancestors from root to cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-context-files-"));
  const agentDir = join(root, "agent");
  const repository = join(root, "repository");
  const cwd = join(repository, "packages", "app");
  await mkdir(agentDir);
  await mkdir(cwd, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global");
  await writeFile(join(repository, "CLAUDE.md"), "root");
  await writeFile(join(repository, "packages", "AGENTS.MD"), "package");
  await writeFile(join(cwd, "AGENTS.md"), "app");

  const result = loadProjectContextFiles({ cwd, agentDir });
  assert.deepEqual(result.map((entry) => entry.content), ["global", "root", "package", "app"]);
});

test("AGENTS files take precedence over alternate context names in one directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-context-precedence-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(join(cwd, "AGENTS.md"), "agents");
  await writeFile(join(cwd, "CLAUDE.md"), "alternate");
  const result = loadProjectContextFiles({ cwd, agentDir });
  assert.equal(result.at(-1)?.content, "agents");
  assert.equal(result.some((entry) => entry.content === "alternate"), false);
});

test("AGENTS override files replace ordinary context in the same directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-context-override-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(join(cwd, "AGENTS.override.md"), "override");
  await writeFile(join(cwd, "AGENTS.md"), "ordinary");
  await writeFile(join(cwd, "CLAUDE.md"), "alternate");

  const result = loadProjectContextFiles({ cwd, agentDir });
  assert.equal(result.at(-1)?.content, "override");
  assert.equal(result.some((entry) => entry.content === "ordinary"), false);
  assert.equal(result.some((entry) => entry.content === "alternate"), false);
});

test("an empty personal AGENTS file is behaviorally inert and still owns name precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-context-empty-personal-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(join(agentDir, "AGENTS.md"), "");
  await writeFile(join(agentDir, "CLAUDE.md"), "alternate");

  assert.deepEqual(loadProjectContextFiles({ cwd, agentDir }), []);
});

test("a directory named AGENTS.md is skipped so a readable fallback can load", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-context-directory-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(join(cwd, "AGENTS.md"), { recursive: true });
  await writeFile(join(cwd, "CLAUDE.md"), "fallback");
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (value) => { warnings.push(String(value)); };
  try {
    const result = loadProjectContextFiles({ cwd, agentDir });
    assert.equal(result.at(-1)?.content, "fallback");
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(warnings, []);
});

test("context discovery bounds each file and can continue to a smaller fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-context-bounded-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(join(cwd, "AGENTS.md"), "x".repeat(65));
  await writeFile(join(cwd, "CLAUDE.md"), "bounded fallback");
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (value) => { warnings.push(String(value)); };
  try {
    const result = loadProjectContextFiles({ cwd, agentDir, maxFileBytes: 64 });
    assert.deepEqual(result.map((entry) => entry.content), ["bounded fallback"]);
  } finally {
    console.error = originalError;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /Instruction file exceeds 64 bytes/u);
});

test("context discovery reports one bounded warning for aliases of the same file", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-context-alias-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(join(cwd, "AGENTS.md"), "x".repeat(65));
  await link(join(cwd, "AGENTS.md"), join(cwd, "AGENTS.override.md"));
  await writeFile(join(cwd, "CLAUDE.md"), "bounded fallback");
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (value) => { warnings.push(String(value)); };
  try {
    const result = loadProjectContextFiles({ cwd, agentDir, maxFileBytes: 64 });
    assert.deepEqual(result.map((entry) => entry.content), ["bounded fallback"]);
  } finally {
    console.error = originalError;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /Instruction file exceeds 64 bytes/u);
});

test("context discovery keeps distinct case-sensitive candidates eligible", {
  skip: process.platform !== "linux",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-context-case-sensitive-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(join(cwd, "AGENTS.override.md"), "x".repeat(65));
  await writeFile(join(cwd, "AGENTS.OVERRIDE.MD"), "case-sensitive fallback");
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (value) => { warnings.push(String(value)); };
  try {
    const result = loadProjectContextFiles({ cwd, agentDir, maxFileBytes: 64 });
    assert.deepEqual(result.map((entry) => entry.content), ["case-sensitive fallback"]);
  } finally {
    console.error = originalError;
  }
  assert.equal(warnings.length, 1);
});

test("context discovery accepts 10,000 directory entries and fails closed at max plus one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-context-entry-bound-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(join(cwd, "AGENTS.md"), "bounded instructions");
  await writeFlatFiles(cwd, 9_999);
  assert.equal(loadProjectContextFiles({ cwd, agentDir }).at(-1)?.content, "bounded instructions");

  await writeFile(join(cwd, "overflow"), "");
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (value) => { warnings.push(String(value)); };
  try {
    assert.equal(loadProjectContextFiles({ cwd, agentDir }).some((entry) => entry.path === join(cwd, "AGENTS.md")), false);
  } finally {
    console.error = originalError;
  }
  assert.equal(warnings.some((entry) => /Instruction discovery exceeds 10000 directory entries/u.test(entry)), true);
});
