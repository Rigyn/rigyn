import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  sharedUserSkillRoots,
  sharedWorkspaceSkillRoots,
} from "../../src/context/skill-roots.js";

test("shared skill roots have documented deterministic precedence", () => {
  assert.deepEqual(sharedUserSkillRoots("/home/example"), [
    { path: join("/home/example", ".agents", "skills"), scope: "user", trusted: true, rootMarkdown: false },
    { path: join("/home/example", ".claude", "skills"), scope: "user", trusted: true, rootMarkdown: false },
    { path: join("/home/example", ".codex", "skills"), scope: "user", trusted: true, rootMarkdown: false },
  ]);
  const workspace = mkdtempSync(join(tmpdir(), "harness-skill-precedence-"));
  try {
    mkdirSync(join(workspace, ".git"));
    assert.deepEqual(sharedWorkspaceSkillRoots(workspace, true), [
      { path: join(workspace, ".agents", "skills"), scope: "workspace", trusted: true, rootMarkdown: false },
      { path: join(workspace, ".claude", "skills"), scope: "workspace", trusted: true, rootMarkdown: false },
      { path: join(workspace, ".codex", "skills"), scope: "workspace", trusted: true, rootMarkdown: false },
    ]);
    assert.deepEqual(sharedWorkspaceSkillRoots(workspace, false), []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("trusted workspaces outside a repository scan ancestors but keep the home skill root user-scoped", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-skill-no-repository-"));
  try {
    const home = join(root, "home");
    const parent = join(home, "projects");
    const workspace = join(parent, "application");
    mkdirSync(workspace, { recursive: true });
    const paths = sharedWorkspaceSkillRoots(workspace, true, home).map((entry) => entry.path);

    assert.equal(paths.includes(join(home, ".agents", "skills")), false);
    assert.equal(paths.includes(join(parent, ".agents", "skills")), true);
    assert.equal(paths.includes(join(workspace, ".agents", "skills")), true);
    assert.equal(paths.includes(join(workspace, ".claude", "skills")), true);
    assert.equal(paths.includes(join(workspace, ".codex", "skills")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted nested workspaces inherit ancestor agent skill roots through the repository root", () => {
  const repository = mkdtempSync(join(tmpdir(), "harness-skill-ancestors-"));
  try {
    mkdirSync(join(repository, ".git"));
    const workspace = join(repository, "packages", "app");
    mkdirSync(workspace, { recursive: true });
    assert.deepEqual(sharedWorkspaceSkillRoots(workspace, true), [
      { path: join(repository, ".agents", "skills"), scope: "workspace", trusted: true, rootMarkdown: false },
      { path: join(repository, "packages", ".agents", "skills"), scope: "workspace", trusted: true, rootMarkdown: false },
      { path: join(workspace, ".agents", "skills"), scope: "workspace", trusted: true, rootMarkdown: false },
      { path: join(workspace, ".claude", "skills"), scope: "workspace", trusted: true, rootMarkdown: false },
      { path: join(workspace, ".codex", "skills"), scope: "workspace", trusted: true, rootMarkdown: false },
    ]);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
