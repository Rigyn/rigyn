import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listSessionCatalog } from "../../src/cli/session-index.js";
import { sessionPickerItems } from "../../src/cli/session-picker.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import type { SessionInfo } from "../../src/storage/types.js";
import { buildSessionPickerRows } from "../../src/tui/session-picker.js";

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

test("session catalog search shares fuzzy, phrase, and regex behavior with the picker", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-search-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, root, { id: "search-session" });
  manager.appendMessage({
    id: "search-message",
    role: "user",
    content: [{ type: "text", text: "Alpha provider migration" }],
    createdAt: "2026-07-21T00:00:00.000Z",
    timestamp: 1_700_000_000_000,
  });

  for (const search of ["alp prv", "\"alpha provider\"", "re:\\bALPHA\\s+provider\\b"]) {
    const result = await listSessionCatalog({ cwd: root, sessionDirectory: root, search });
    assert.deepEqual(result.sessions.map((session) => session.id), ["search-session"]);
  }
  const invalid = await listSessionCatalog({ cwd: root, sessionDirectory: root, search: "re:(" });
  assert.deepEqual(invalid.sessions, []);
});

test("real fork metadata renders as a thread while ambiguous parent IDs remain roots", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-thread-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const parent = SessionManager.create(root, root, { id: "parent" });
  parent.appendMessage({
    id: "parent-message",
    role: "user",
    content: [{ type: "text", text: "Parent prompt" }],
    createdAt: "2026-07-21T00:00:00.000Z",
    timestamp: 1_700_000_000_000,
  });
  const child = SessionManager.forkFrom(parent.getSessionFile()!, root, root, { id: "child" });
  child.appendMessage({
    id: "child-message",
    role: "assistant",
    content: [{ type: "text", text: "Child answer" }],
    createdAt: "2026-07-21T00:00:01.000Z",
    timestamp: 1_700_000_001_000,
  });

  const listed = await SessionManager.list(root, root);
  const metadata = sessionPickerItems(listed).map((item) => ({
    id: item.id,
    label: item.label,
    updatedAt: item.session!.updatedAt,
    ...(item.session!.parentId === undefined ? {} : { parentId: item.session!.parentId }),
  }));
  const rows = buildSessionPickerRows(metadata, { sort: "threaded" }).rows;
  assert.deepEqual(rows.map((row) => [row.session.id, row.depth]), [
    [parent.getSessionFile(), 0],
    [child.getSessionFile(), 1],
  ]);

  const firstParentPath = join(root, "first-parent.jsonl");
  const duplicateParents = [
    { ...listed.find((session) => session.id === "parent")!, path: firstParentPath, id: "duplicate" },
    { ...listed.find((session) => session.id === "parent")!, path: join(root, "second-parent.jsonl"), id: "duplicate" },
    { ...listed.find((session) => session.id === "child")!, path: join(root, "ambiguous-child.jsonl"), parentSessionPath: "duplicate" },
    { ...listed.find((session) => session.id === "child")!, path: join(root, "path-child.jsonl"), parentSessionPath: firstParentPath },
  ];
  const duplicateItems = sessionPickerItems(duplicateParents);
  const ambiguousChild = duplicateItems.find((item) => item.id.endsWith("ambiguous-child.jsonl"));
  assert.equal(ambiguousChild?.session?.parentId, undefined);
  const pathChild = duplicateItems.find((item) => item.id.endsWith("path-child.jsonl"));
  assert.equal(pathChild?.session?.parentId, firstParentPath);
});

test("session picker resolves lineage and active identity across symlink aliases", {
  skip: process.platform === "win32" ? "directory symlinks require optional Windows privileges" : false,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-alias-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const real = join(root, "real");
  const aliasA = join(root, "alias-a");
  const aliasB = join(root, "alias-b");
  await mkdir(real);
  await symlink(real, aliasA, "dir");
  await symlink(real, aliasB, "dir");
  await writeFile(join(real, "parent.jsonl"), "parent\n");
  await writeFile(join(real, "child.jsonl"), "child\n");

  const base = {
    cwd: root,
    created: new Date("2026-01-01T00:00:00.000Z"),
    modified: new Date("2026-01-01T00:00:00.000Z"),
    messageCount: 1,
    firstMessage: "message",
    allMessagesText: "message",
  };
  const parentPath = join(aliasB, "parent.jsonl");
  const sessions: SessionInfo[] = [
    { ...base, id: "parent", path: parentPath },
    { ...base, id: "child", path: join(aliasB, "child.jsonl"), parentSessionPath: join(aliasA, "parent.jsonl") },
  ];
  const items = sessionPickerItems(sessions, join(aliasA, "parent.jsonl"));

  assert.equal(items.find((item) => item.value === parentPath)?.session?.current, true);
  assert.equal(items.find((item) => item.value === sessions[1]!.path)?.session?.parentId, parentPath);
});
