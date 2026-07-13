import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  CrossProcessFileLock,
  CredentialStoreError,
  EncryptedFileCredentialStore,
} from "../../src/auth/file-store.js";

test("encrypted store never writes plaintext and detects corruption", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "credentials.enc");
  const key = randomBytes(32);
  const store = new EncryptedFileCredentialStore({ path, key });

  await store.write("openai", {
    kind: "api_key",
    provider: "openai",
    apiKey: "secret-api-key-value",
  });
  const disk = await readFile(path, "utf8");
  assert.doesNotMatch(disk, /secret-api-key-value|api_key/);
  assert.deepEqual(await store.read("openai"), {
    kind: "api_key",
    provider: "openai",
    apiKey: "secret-api-key-value",
  });
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);

  const envelope = JSON.parse(disk) as { ciphertext: string };
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith("A") ? "B" : "A"}`;
  await writeFile(path, JSON.stringify(envelope), { mode: 0o600 });
  await assert.rejects(store.read("openai"), CredentialStoreError);
});

test("encrypted store round-trips a large envelope below its separate disk bound and rejects oversized files", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-store-bound-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "credentials.enc");
  const store = new EncryptedFileCredentialStore({ path, key: randomBytes(32) });
  const scopes = Array.from({ length: 256 }, () => "s".repeat(1024));
  for (let index = 0; index < 30; index += 1) {
    await store.write(`account-${index}`, {
      kind: "oauth",
      provider: "example",
      accessToken: "a".repeat(48 * 1024),
      refreshToken: "r".repeat(48 * 1024),
      expiresAt: Date.now() + 60_000,
      tokenType: "Bearer",
      scopes,
    });
  }
  assert.ok((await stat(path)).size > 12 * 1024 * 1024);
  assert.equal((await store.read("account-29"))?.kind, "oauth");

  await writeFile(path, Buffer.alloc(16 * 1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(store.read("account-0"), /configured size limit/u);
});

test("credential writes detach caller data before waiting for the file lock", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-store-snapshot-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "credentials.enc");
  const lock = new CrossProcessFileLock(`${path}.lock`, { timeoutMs: 2_000 });
  let release!: () => void;
  let acquired!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const holding = lock.run(async () => { acquired(); await gate; });
  await ready;

  const store = new EncryptedFileCredentialStore({ path, key: randomBytes(32), lock: { timeoutMs: 2_000 } });
  const value = { kind: "api_key" as const, provider: "example", apiKey: "original-secret" };
  const writing = store.write("account", value);
  value.apiKey = "mutated-secret";
  release();
  await holding;
  await writing;
  const stored = await store.read("account");
  assert.equal(stored?.kind === "api_key" ? stored.apiKey : undefined, "original-secret");
});

test("stale owner cleanup cannot unlink a successor's lock lease", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-lock-lease-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "credentials.lock");
  const first = new CrossProcessFileLock(path, { retryMs: 1, timeoutMs: 2_000, staleMs: 5 });
  const second = new CrossProcessFileLock(path, { retryMs: 1, timeoutMs: 2_000, staleMs: 5 });
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let enteredFirst!: () => void;
  let enteredSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const firstReady = new Promise<void>((resolve) => { enteredFirst = resolve; });
  const secondReady = new Promise<void>((resolve) => { enteredSecond = resolve; });
  const firstRun = first.run(async () => { enteredFirst(); await firstGate; });
  await firstReady;
  await delay(15);
  const secondRun = second.run(async () => { enteredSecond(); await secondGate; });
  await secondReady;
  const successor = await readFile(path, "utf8");
  releaseFirst();
  await firstRun;
  assert.equal(await readFile(path, "utf8"), successor);
  releaseSecond();
  await secondRun;
  await assert.rejects(stat(path), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("encrypted store rejects wrong keys and plaintext files", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "credentials.enc");
  const store = new EncryptedFileCredentialStore({ path, key: randomBytes(32) });
  await store.write("token", {
    kind: "bearer",
    provider: "example",
    accessToken: "secret-token",
  });

  const wrongKeyStore = new EncryptedFileCredentialStore({ path, key: randomBytes(32) });
  await assert.rejects(wrongKeyStore.read("token"), /decryption failed/);

  await writeFile(path, JSON.stringify({ token: "secret-token" }), { mode: 0o600 });
  await assert.rejects(store.read("token"), /encrypted envelope/);
  await assert.rejects(
    store.write("__proto__", { kind: "api_key", provider: "example", apiKey: "key" }),
    /Credential id is invalid/,
  );
});
