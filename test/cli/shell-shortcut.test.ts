import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolProgress } from "../../src/core/events.js";
import { runShellShortcut, shellShortcutEnvironment, shellShortcutProgressStatus } from "../../src/cli/main.js";

test("shell shortcut captures stdout, stderr, and exit without interpolation by the parent", async () => {
  const command = "printf hello; printf problem >&2; exit 7";
  const result = await runShellShortcut(command, process.cwd(), new AbortController().signal);
  assert.equal(result.exitCode, 7);
  assert.match(result.text, /hello/u);
  assert.match(result.text, /stderr:\nproblem/u);
  assert.match(result.text, /exit 7/u);
});

test("shell shortcut runs a configured prefix in the same shell", async () => {
  const result = await runShellShortcut(
    "printf '%s' \"$RIGYN_PREFIX_TEST\"",
    process.cwd(),
    new AbortController().signal,
    5_000,
    process.env,
    undefined,
    undefined,
    "RIGYN_PREFIX_TEST=ready",
  );
  assert.match(result.text, /ready/u);
});

test("shell shortcut streams UTF-8-safe progress and flushes short output before completion", async () => {
  const progress: ToolProgress[] = [];
  const command = process.platform === "win32"
    ? "echo hello"
    : `${JSON.stringify(process.execPath)} -e "process.stdout.write(Buffer.from([240,159])); setTimeout(() => process.stdout.write(Buffer.from([153,130])), 10); process.stderr.write('warning')"`;
  const result = await runShellShortcut(
    command,
    process.cwd(),
    new AbortController().signal,
    5_000,
    process.env,
    (update) => progress.push(update),
  );
  if (process.platform === "win32") assert.match(progress.map((entry) => entry.delta).join(""), /hello/u);
  else {
    assert.equal(progress.filter((entry) => entry.stream === "stdout").map((entry) => entry.delta).join(""), "🙂");
    assert.equal(progress.filter((entry) => entry.stream === "stderr").map((entry) => entry.delta).join(""), "warning");
  }
  assert.equal(result.exitCode, 0);
});

test("shell shortcut live status is bounded, terminal-safe, and cumulative", () => {
  const status = shellShortcutProgressStatus("printf \u001b[2J output", {
    type: "output",
    stream: "stderr",
    delta: `warning\u001b]2;owned\u0007 ${"x".repeat(2_000)}`,
    stdoutBytes: 12,
    stderrBytes: 2_000,
    elapsedMs: 65_000,
  });
  assert.ok(Buffer.byteLength(status, "utf8") <= 768);
  assert.doesNotMatch(status, /\u001b/u);
  assert.match(status, /12 B stdout/u);
  assert.match(status, /2000 B stderr/u);
  assert.match(status, /1m 5s elapsed/u);
});

test("shell shortcut rejects empty input and honors pre-cancellation", async () => {
  await assert.rejects(runShellShortcut("", process.cwd(), new AbortController().signal), /empty or too large/u);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(runShellShortcut("echo no", process.cwd(), controller.signal), /cancelled/u);
});

test("shell shortcut force-stops a process group that ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const controller = new AbortController();
  const started = Date.now();
  const running = runShellShortcut("trap '' TERM; while :; do sleep 30; done", process.cwd(), controller.signal);
  setTimeout(() => controller.abort(new Error("cancelled")), 100).unref();
  await assert.rejects(running, /cancelled/u);
  assert.ok(Date.now() - started < 5_000, "cancelled command should not survive the SIGKILL fallback");
});

test("shell shortcut has a bounded execution timeout", async () => {
  const command = process.platform === "win32" ? "ping -n 30 127.0.0.1 >/dev/null" : "sleep 30";
  const started = Date.now();
  await assert.rejects(runShellShortcut(command, process.cwd(), new AbortController().signal, 100), /timed out after 100 ms/u);
  assert.ok(Date.now() - started < 5_000);
});

test("shell shortcuts scrub credential environments and redact credential-shaped output", async () => {
  const secret = ["sk", "proj", "1234567890abcdefghijkl"].join("-");
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SAFE_VALUE: "visible-value",
    OPENAI_API_KEY: secret,
    DATABASE_URL: "postgres://user:password@example.test/database",
  };
  assert.deepEqual(shellShortcutEnvironment(environment), {
    PATH: process.env.PATH,
    SAFE_VALUE: "visible-value",
  });
  const command = `printf '%s\\n' "$SAFE_VALUE" "$OPENAI_API_KEY" '${secret}'`;
  const result = await runShellShortcut(command, process.cwd(), new AbortController().signal, 5_000, environment);
  assert.match(result.text, /visible-value/u);
  assert.match(result.text, /\[REDACTED\]/u);
  assert.doesNotMatch(result.text, new RegExp(secret, "u"));
  assert.doesNotMatch(result.text, /postgres:\/\/user:password/u);
});
