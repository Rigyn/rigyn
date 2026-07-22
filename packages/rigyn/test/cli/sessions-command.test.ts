import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectSessionFiles } from "../../src/cli/sessions-command.js";

test("session doctor reports complete-line corruption while accepting an incomplete tail", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-doctor-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const timestamp = "2026-07-21T00:00:00.000Z";
  const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: root });
  const message = JSON.stringify({
    type: "message",
    id: "message1",
    parentId: null,
    timestamp,
    message: { id: "assistant1", role: "assistant", content: [], createdAt: timestamp },
  });
  const valid = join(root, "valid.jsonl");
  const corrupt = join(root, "corrupt.jsonl");
  const recoverable = join(root, "recoverable.jsonl");
  await writeFile(valid, `${header("valid")}\n${message}\n`);
  await writeFile(corrupt, `${header("corrupt")}\n{broken\n`);
  await writeFile(recoverable, `${header("recoverable")}\n${message}\n{"type":"message"`);

  const report = await inspectSessionFiles({ workspace: root, sessionDirectory: root, allWorkspaces: true });

  assert.equal(report.checked, 3);
  assert.equal(report.valid, 2);
  assert.equal(report.healthy, false);
  assert.deepEqual(report.invalid.map((entry) => entry.path), [corrupt]);
  assert.match(report.invalid[0]?.error ?? "", /malformed JSON at line 2/u);
  assert.match(await readFile(corrupt, "utf8"), /\{broken\n$/u);
});
