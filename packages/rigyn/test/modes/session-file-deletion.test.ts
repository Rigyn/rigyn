import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  deleteSessionFile,
  recoverableDeleteCommand,
} from "../../src/modes/session-file-deletion.js";
import type { CommandResult, ProcessRunner } from "../../src/process/types.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { acquireSessionWriterLeaseSync } from "../../src/storage/session-writer-lease.js";

function result(exitCode: number): CommandResult {
  return {
    exitCode,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutBytes: 0,
    stderrBytes: 0,
    timedOut: false,
    cancelled: false,
    durationMs: 1,
  };
}

test("recoverable session deletion uses the native platform helper", () => {
  assert.deepEqual(recoverableDeleteCommand("/tmp/session.jsonl", "linux"), {
    argv: ["gio", "trash", "/tmp/session.jsonl"],
  });

  const macos = recoverableDeleteCommand("/tmp/session.jsonl", "darwin");
  assert.deepEqual(macos?.argv.slice(0, 2), ["/usr/bin/osascript", "-e"]);
  assert.deepEqual(macos?.argv.slice(-2), ["--", "/tmp/session.jsonl"]);
  assert.equal(macos?.argv.slice(0, -1).some((part) => part.includes("/tmp/session.jsonl")), false);

  const windows = recoverableDeleteCommand("C:\\sessions\\session.jsonl", "win32");
  assert.deepEqual(windows?.argv.slice(0, 5), [
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-File",
  ]);
  assert.equal(windows?.argv.at(-2), "-");
  assert.equal(windows?.argv.at(-1), "C:\\sessions\\session.jsonl");
  assert.equal(windows?.argv.slice(0, -1).some((part) => part.includes("C:\\sessions\\session.jsonl")), false);
  assert.match(windows?.stdin ?? "", /SendToRecycleBin/u);
  assert.doesNotMatch(windows?.stdin ?? "", /C:\\sessions\\session\.jsonl/u);

  assert.equal(recoverableDeleteCommand("/tmp/session.jsonl", "freebsd"), undefined);
});

test("successful native deletion reports trash without permanent fallback", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-delete-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "session.jsonl");
  const alias = join(root, "session-alias.jsonl");
  await writeFile(path, "{}\n");
  await link(path, alias);
  const calls: string[][] = [];
  const runner: ProcessRunner = {
    async run(spec) {
      calls.push(spec.argv);
      assert.throws(() => acquireSessionWriterLeaseSync(alias), /active writer/u);
      await rm(path);
      return result(0);
    },
  };

  assert.equal(await deleteSessionFile(path, {
    cwd: root,
    processRunner: runner,
    platform: "linux",
  }), "trash");
  assert.deepEqual(calls, [["gio", "trash", path]]);
  await assert.rejects(access(path));
  const aliasLease = acquireSessionWriterLeaseSync(alias);
  aliasLease.release();
  assert.equal(existsSync(`${path}.writer-lock`), false);
});

test("failed or unavailable native deletion falls back to permanent removal", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-delete-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const failedPath = join(root, "failed.jsonl");
  const unavailablePath = join(root, "unavailable.jsonl");
  await writeFile(failedPath, "{}\n");
  await writeFile(unavailablePath, "{}\n");

  assert.equal(await deleteSessionFile(failedPath, {
    cwd: root,
    processRunner: { async run() { return result(1); } },
    platform: "linux",
  }), "permanent");
  assert.equal(await deleteSessionFile(unavailablePath, {
    cwd: root,
    processRunner: { async run() { throw new Error("gio not found"); } },
    platform: "linux",
  }), "permanent");
  await assert.rejects(access(failedPath));
  await assert.rejects(access(unavailablePath));
});

test("session deletion fails closed for active writers and their hard-link aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-delete-active-"));
  const path = join(root, "active.jsonl");
  const alias = join(root, "active-alias.jsonl");
  const manager = SessionManager.open(path, root, root);
  try {
    await link(path, alias);
    const runner: ProcessRunner = {
      async run() {
        assert.fail("the recycle helper must not run without writer ownership");
      },
    };
    const options = { cwd: root, processRunner: runner, platform: "freebsd" as const };

    await assert.rejects(deleteSessionFile(path, options), /active writer/u);
    await assert.rejects(deleteSessionFile(alias, options), /active writer/u);
    await access(path);
    await access(alias);
    assert.equal(existsSync(`${alias}.writer-lock`), false);
  } finally {
    manager.closeV4Store();
    await rm(root, { recursive: true, force: true });
  }
});
