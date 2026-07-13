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

test("external auth timeout reaps the child process group before rejecting", async (context) => {
  if (process.platform === "win32") {
    context.skip("Windows process-tree termination uses platform process handles");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-reap-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, "survived");
  const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 250)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}]);setTimeout(()=>{},10000)`;
  await assert.rejects(
    resolveExternalCommandCredential({
      provider: "example",
      argv: [process.execPath, "-e", parent],
      timeoutMs: 50,
    }),
    /timed out/u,
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 350));
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
