import assert from "node:assert/strict";
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
  assert.deepEqual(sharedWorkspaceSkillRoots("/workspace", true), [
    { path: join("/workspace", ".agents", "skills"), scope: "workspace", trusted: true, rootMarkdown: false },
    { path: join("/workspace", ".claude", "skills"), scope: "workspace", trusted: true, rootMarkdown: false },
    { path: join("/workspace", ".codex", "skills"), scope: "workspace", trusted: true, rootMarkdown: false },
  ]);
  assert.deepEqual(sharedWorkspaceSkillRoots("/workspace", false), []);
});
