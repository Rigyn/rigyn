import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadProjectContextFiles } from "../../src/core/resource-loader.js";

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
