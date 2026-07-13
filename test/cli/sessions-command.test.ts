import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { SessionStore } from "../../src/storage/store.js";

async function cli(argumentsValue: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/bin/rigyn.ts", ...argumentsValue], {
    cwd: resolve("."),
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

test("sessions doctor and explicit reindex repair are wired through the CLI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-sessions-cli-"));
  const directory = join(root, "state");
  await mkdir(directory);
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(directory, "sessions.sqlite");
  const store = new SessionStore(path);
  store.createThread({ threadId: "session-cli", workspaceRoot: root });
  store.close();

  const doctor = await cli(["sessions", "doctor", "--json", "--session-dir", directory]);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).healthy, true);

  const unconfirmed = await cli(["sessions", "repair", "--reindex", "--session-dir", directory]);
  assert.equal(unconfirmed.code, 1);
  assert.match(unconfirmed.stderr, /pass --yes/u);

  const repaired = await cli([
    "sessions", "repair", "--reindex", "--yes", "--json", "--session-dir", directory,
  ]);
  assert.equal(repaired.code, 0, repaired.stderr);
  const result = JSON.parse(repaired.stdout) as { report: { healthy: boolean }; backupPath: string };
  assert.equal(result.report.healthy, true);
  assert.match(result.backupPath, /\.backup-.*\.sqlite$/u);
});
