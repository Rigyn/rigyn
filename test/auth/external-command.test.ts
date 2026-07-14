import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveExternalCommandCredential } from "../../src/auth/external-command.js";
import { SecretRedactor } from "../../src/auth/redaction.js";

test("external auth uses argv without a shell and a minimal environment", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-command-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, "shell-injection-marker");
  const previous = process.env.AUTH_SHOULD_NOT_LEAK;
  process.env.AUTH_SHOULD_NOT_LEAK = "sensitive-parent-value";
  context.after(() => {
    if (previous === undefined) delete process.env.AUTH_SHOULD_NOT_LEAK;
    else process.env.AUTH_SHOULD_NOT_LEAK = previous;
  });

  const script = `console.log(JSON.stringify({type:"bearer",accessToken:"command-token",subject:process.env.AUTH_SHOULD_NOT_LEAK ?? "not-inherited"}))`;
  const credential = await resolveExternalCommandCredential({
    provider: "example",
    argv: [process.execPath, "-e", script, `;touch ${marker}`],
  });
  assert.equal(credential.kind, "bearer");
  assert.equal(credential.subject, "not-inherited");
  await assert.rejects(access(marker));
});

test("external auth returns after the command exits when a descendant retains its output pipes", async () => {
  const descendant = "setTimeout(() => {}, 3000)";
  const script = [
    "const { spawn } = require('node:child_process')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'inherit'] })`,
    "child.unref()",
    `process.stdout.write(${JSON.stringify(JSON.stringify({ type: "bearer", accessToken: "bounded-drain-token" }))})`,
  ].join(";");
  const credential = await resolveExternalCommandCredential({
    provider: "example",
    argv: [process.execPath, "-e", script],
    timeoutMs: 2_000,
  });
  assert.equal(credential.kind, "bearer");
});

test("external auth enforces timeout and output bounds", async () => {
  await assert.rejects(
    resolveExternalCommandCredential({
      provider: "example",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
      timeoutMs: 25,
    }),
    /timed out/,
  );
  await assert.rejects(
    resolveExternalCommandCredential({
      provider: "example",
      argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(10000))"],
      maxOutputBytes: 64,
    }),
    /output exceeded/,
  );
});

test("external auth cancellation reaps the child process tree before rejecting", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-reap-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const ready = join(directory, "ready");
  const marker = join(directory, "survived");
  const grandchild = [
    "const fs=require('node:fs')",
    "process.on('SIGTERM',()=>{})",
    `fs.writeFileSync(${JSON.stringify(ready)},'ready')`,
    `setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'bad'),1800)`,
  ].join(";");
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','inherit','inherit']});setTimeout(()=>{},10000)`;
  const controller = new AbortController();
  const pending = resolveExternalCommandCredential({
    provider: "example",
    argv: [process.execPath, "-e", parent],
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  const rejected = assert.rejects(pending, /cancel external credential command/u);
  const readyDeadline = Date.now() + 5_000;
  while (true) {
    try {
      await access(ready);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= readyDeadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  const readyAt = Date.now();
  controller.abort(new Error("cancel external credential command"));
  await rejected;
  const remaining = 2_300 - (Date.now() - readyAt);
  if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  await assert.rejects(access(marker));
});

test("external auth redacts command errors", async () => {
  const redactor = new SecretRedactor();
  redactor.register("stderr-secret-value");
  await assert.rejects(
    resolveExternalCommandCredential({
      provider: "example",
      argv: [
        process.execPath,
        "-e",
        "process.stderr.write('stderr-secret-value'); process.exit(2)",
      ],
      redactor,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /stderr-secret-value/);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});
