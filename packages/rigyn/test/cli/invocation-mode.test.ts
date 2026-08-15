import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  resolveAgentCliMode,
  resolveCliInvocationMode,
} from "../../src/cli/invocation-mode.js";

test("CLI mode classification shares explicit-mode and TTY precedence", () => {
  const tty = { stdinIsTTY: true, stdoutIsTTY: true };
  for (const [argv, expected] of [
    [["serve"], "serve"],
    [["--mode", "rpc"], "rpc"],
    [["--mode", "json"], "json"],
    [["--mode", "text"], "print"],
    [["--mode=rpc"], "rpc"],
    [["--mode=json"], "json"],
    [["--mode=text"], "print"],
    [["--mode=rpc", "--mode", "json"], "json"],
    [["--offline", "serve"], "serve"],
    [["--host", "localhost", "serve"], "serve"],
    [["--print"], "print"],
    [["--print=hello"], "print"],
    [["-p"], "print"],
    [["--", "--mode=json"], "interactive"],
    [["--offline", "--", "serve"], "interactive"],
    [["--model", "serve"], "interactive"],
    [[], "interactive"],
  ] as const) {
    assert.equal(resolveCliInvocationMode(argv, tty), expected);
  }

  assert.equal(resolveCliInvocationMode([], { stdinIsTTY: false, stdoutIsTTY: true }), "print");
  assert.equal(resolveCliInvocationMode([], { stdinIsTTY: true, stdoutIsTTY: false }), "print");
  assert.equal(resolveCliInvocationMode([], { stdinIsTTY: false, stdoutIsTTY: false }), "print");
  assert.equal(resolveAgentCliMode({ stdinIsTTY: true, stdoutIsTTY: true }), "interactive");
  assert.equal(resolveAgentCliMode({ stdinIsTTY: false, stdoutIsTTY: true }), "print");
  assert.equal(resolveAgentCliMode({ mode: "rpc", stdinIsTTY: false, stdoutIsTTY: false }), "rpc");
});

test("a pre-runtime failure on piped input records print crash mode", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-invocation-mode-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "src/bin/rigyn.ts", "--mode", "invalid",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, RIGYN_HOME: root },
    encoding: "utf8",
    input: "",
    timeout: 10_000,
  });
  assert.notEqual(result.status, 0);
  const crashDir = join(root, "crash");
  const reports = await readdir(crashDir);
  assert.equal(reports.length, 1);
  const report = JSON.parse(await readFile(join(crashDir, reports[0]!), "utf8")) as { mode: string };
  assert.equal(report.mode, "print");
});
