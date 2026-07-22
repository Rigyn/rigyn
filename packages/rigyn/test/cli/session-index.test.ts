import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listSessionCatalog } from "../../src/cli/session-index.js";
import { SessionManager } from "../../src/storage/session-manager.js";

test("session catalog pagination is stable and rejects a stale cursor", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-catalog-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const timestamp = "2026-07-21T00:00:00.000Z";
  for (const id of ["bravo", "alpha"]) {
    const manager = SessionManager.create(root, root, { id });
    manager.appendMessage({ id: `${id}-assistant`, role: "assistant", content: [], createdAt: timestamp, timestamp: 1_700_000_000_000 });
  }

  const first = await listSessionCatalog({ cwd: root, sessionDirectory: root, allWorkspaces: true, limit: 1 });
  assert.equal(first.sessions.length, 1);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextPath, first.sessions[0]?.path);
  assert.ok(first.nextPath);
  const second = await listSessionCatalog({
    cwd: root,
    sessionDirectory: root,
    allWorkspaces: true,
    limit: 1,
    afterPath: first.nextPath,
  });
  assert.equal(second.sessions.length, 1);
  assert.notEqual(second.sessions[0]?.path, first.sessions[0]?.path);
  assert.equal(second.hasMore, false);

  await assert.rejects(
    listSessionCatalog({ cwd: root, sessionDirectory: root, allWorkspaces: true, afterPath: join(root, "missing.jsonl") }),
    /cursor was not found/u,
  );
});
