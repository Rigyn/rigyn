import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  inspectSessionDatabase,
  repairSessionDatabaseIndexes,
} from "../../src/storage/maintenance.js";
import { SessionStore } from "../../src/storage/store.js";

const FIXED_TIME = "2026-07-13T12:00:00.000Z";

function fixture(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-session-maintenance-"));
  const path = join(root, "sessions.sqlite");
  const store = new SessionStore(path, { clock: () => new Date(FIXED_TIME) });
  store.createThread({ threadId: "thread-maintenance", workspaceRoot: root });
  store.appendEvent({
    threadId: "thread-maintenance",
    event: { type: "warning", code: "fixture", message: "durable fixture" },
  });
  store.close();
  return { root, path };
}

function damageOrdinaryIndex(path: string): void {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const rootPage = (database.prepare(`
    SELECT rootpage FROM sqlite_schema WHERE name = 'threads_workspace_updated_idx'
  `).get() as { rootpage: number }).rootpage;
  database.close();

  const contents = readFileSync(path);
  const encodedPageSize = contents.readUInt16BE(16);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  const pageOffset = (rootPage - 1) * pageSize;
  assert.ok(pageOffset >= pageSize && pageOffset < contents.length);
  assert.equal(contents[pageOffset], 0x0a, "fixture index must use one leaf page");
  assert.equal(contents.readUInt16BE(pageOffset + 3), 1, "fixture index must contain one entry");
  const contentOffset = contents.readUInt16BE(pageOffset + 5);
  const fragmentedBytes = pageSize - contentOffset;
  assert.ok(fragmentedBytes > 0 && fragmentedBytes <= 0xff);
  contents.writeUInt16BE(0, pageOffset + 3);
  contents[pageOffset + 7] = fragmentedBytes;
  writeFileSync(path, contents);
}

function addForeignKeyViolation(path: string): void {
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  database.prepare(`
    INSERT INTO branches(thread_id, branch_name, head_event_id, created_at, updated_at)
    VALUES (?, 'main', NULL, ?, ?)
  `).run("missing-thread", FIXED_TIME, FIXED_TIME);
  database.close();
}

test("session doctor performs full index and foreign-key integrity checks", () => {
  const { root, path } = fixture();
  try {
    assert.equal(inspectSessionDatabase(path).healthy, true);
    damageOrdinaryIndex(path);
    addForeignKeyViolation(path);

    const report = inspectSessionDatabase(path);
    assert.equal(report.healthy, false);
    assert.equal(report.integrity.healthy, false);
    assert.match(report.integrity.messages.join("\n"), /threads_workspace_updated_idx|wrong # of entries/u);
    assert.deepEqual(report.foreignKeys.violations, [{
      table: "branches",
      rowId: 2,
      parent: "threads",
      foreignKey: 1,
    }]);
    assert.equal(report.foreignKeys.healthy, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit index repair backs up, commits only healthy results, and rolls failures back", async () => {
  const { root, path } = fixture();
  try {
    damageOrdinaryIndex(path);
    const now = () => new Date(FIXED_TIME);
    const first = await repairSessionDatabaseIndexes(path, { now });
    assert.equal(first.report.healthy, true);
    assert.notEqual(first.backupPath, path);
    if (process.platform !== "win32") assert.equal(statSync(first.backupPath).mode & 0o777, 0o600);

    const reopened = new SessionStore(path);
    assert.equal(reopened.getThread("thread-maintenance").threadId, "thread-maintenance");
    reopened.close();

    const second = await repairSessionDatabaseIndexes(path, { now });
    assert.equal(second.report.healthy, true);
    assert.notEqual(second.backupPath, first.backupPath);
    assert.equal(readdirSync(root).filter((name) => name.includes(".backup-") && name.endsWith(".sqlite")).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const failed = fixture();
  try {
    damageOrdinaryIndex(failed.path);
    addForeignKeyViolation(failed.path);
    await assert.rejects(
      repairSessionDatabaseIndexes(failed.path, { now: () => new Date(FIXED_TIME) }),
      /did not restore full database integrity/u,
    );

    const after = inspectSessionDatabase(failed.path);
    assert.equal(after.integrity.healthy, false, "REINDEX must roll back when the final checks fail");
    assert.equal(after.foreignKeys.healthy, false);
    const backups = readdirSync(failed.root).filter((name) => name.includes(".backup-") && name.endsWith(".sqlite"));
    assert.equal(backups.length, 1);
    if (process.platform !== "win32") {
      assert.equal(statSync(join(failed.root, backups[0]!)).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(failed.root, { recursive: true, force: true });
  }
});
