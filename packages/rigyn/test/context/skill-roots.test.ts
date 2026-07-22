import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  const workspace = resolve("/workspace");
  assert.deepEqual(sharedWorkspaceSkillRoots(workspace, true), [
    { path: join(workspace, ".agents", "skills"), scope: "workspace", trusted: true, rootMarkdown: false },
    { path: join(workspace, ".claude", "skills"), scope: "workspace", trusted: true, rootMarkdown: false },
    { path: join(workspace, ".codex", "skills"), scope: "workspace", trusted: true, rootMarkdown: false },
  ]);
  assert.deepEqual(sharedWorkspaceSkillRoots(workspace, false), []);
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
