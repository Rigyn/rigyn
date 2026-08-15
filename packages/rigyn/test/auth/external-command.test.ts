import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveExternalCommandCredential } from "../../src/auth/external-command.js";
import { CredentialBroker, ExternalCommandCredentialSource } from "../../src/auth/broker.js";
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

  const script = `require("node:fs").writeSync(1, JSON.stringify({type:"bearer",accessToken:"command-token",subject:process.env.AUTH_SHOULD_NOT_LEAK ?? "not-inherited"}))`;
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
    `require('node:fs').writeSync(1, ${JSON.stringify(JSON.stringify({ type: "bearer", accessToken: "bounded-drain-token" }))})`,
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
      argv: [process.execPath, "-e", "require('node:fs').writeSync(1, 'x'.repeat(10000))"],
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
        "require('node:fs').writeSync(2, 'stderr-secret-value'); process.exit(2)",
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

test("configured external credential sources are provider-scoped, cached, and broker-compatible", async () => {
  let now = 1_000_000;
  const source = new ExternalCommandCredentialSource({
    company: {
      argv: [process.execPath, "-e", "require('node:fs').writeSync(1, JSON.stringify({type:'api_key',apiKey:process.env.COMPANY_TOKEN}))"],
      environment: { COMPANY_TOKEN: "command-company-token" },
      cacheTtlMs: 5_000,
    },
  }, { now: () => now });
  const broker = new CredentialBroker([source]);

  const first = await broker.resolve({ provider: "company" });
  assert.equal(first?.source, "external-command");
  assert.deepEqual(first?.credential, {
    kind: "api_key",
    provider: "company",
    apiKey: "command-company-token",
  });
  assert.equal(await broker.resolve({ provider: "other" }), undefined);

  now += 1_000;
  const cached = await broker.resolve({ provider: "company" });
  assert.notStrictEqual(cached?.credential, first?.credential);
  assert.deepEqual(cached, first);
});

test("configured external credential caching respects bearer expiry and cancellation", async () => {
  let now = 2_000_000;
  const source = new ExternalCommandCredentialSource({
    expiring: {
      argv: [process.execPath, "-e", `require('node:fs').writeSync(1, JSON.stringify({type:'bearer',accessToken:'short-token',expiresAt:${now + 30_000}}))`],
      cacheTtlMs: 60_000,
    },
  }, { now: () => now });

  assert.equal((await source.resolve({ provider: "expiring" }))?.kind, "bearer");
  const controller = new AbortController();
  controller.abort(new Error("cancel configured credential"));
  await assert.rejects(source.resolve({ provider: "expiring", signal: controller.signal }), /cancel configured credential/u);
  now += 1;
  assert.equal((await source.resolve({ provider: "expiring" }))?.kind, "bearer");
});

test("configured external credential sources reject unsafe resource bounds", () => {
  assert.throws(() => new ExternalCommandCredentialSource({
    company: { argv: [] as unknown as [string, ...string[]] },
  }), /1 through 32/u);
  assert.throws(() => new ExternalCommandCredentialSource({
    company: { argv: [process.execPath], timeoutMs: 60_001 },
  }), /timeoutMs/u);
  assert.throws(() => new ExternalCommandCredentialSource({
    company: { argv: [process.execPath], environment: { "INVALID-NAME": "value" } },
  }), /environment/u);
});
