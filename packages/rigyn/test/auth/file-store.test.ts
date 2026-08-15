import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  CrossProcessFileLock,
  CredentialStoreError,
  EncryptedFileCredentialStore,
} from "../../src/auth/file-store.js";
import { OAUTH_HTTP_TIMEOUT_MS } from "../../src/auth/oauth-http.js";
import { CredentialProfileManager } from "../../src/auth/profiles.js";
import {
  AUTH_PROCESS_DEFAULT_TIMEOUT_MS,
  AUTH_PROCESS_DRAIN_MAX_MS,
  AUTH_PROCESS_KILL_GRACE_MS,
  CREDENTIAL_STORE_LOCK_WAIT_MARGIN_MS,
  CREDENTIAL_STORE_LOCK_WAIT_TIMEOUT_MS,
  NORMAL_OAUTH_KEYCHAIN_HELPER_OPERATIONS,
} from "../../src/auth/timing.js";

test("the production credential-lock wait exceeds a normal bounded OAuth/keychain refresh transaction", () => {
  const helperMaximumMs = AUTH_PROCESS_DEFAULT_TIMEOUT_MS
    + AUTH_PROCESS_KILL_GRACE_MS
    + AUTH_PROCESS_DRAIN_MAX_MS;
  const transactionMaximumMs = OAUTH_HTTP_TIMEOUT_MS
    + NORMAL_OAUTH_KEYCHAIN_HELPER_OPERATIONS * helperMaximumMs;
  assert.equal(
    CREDENTIAL_STORE_LOCK_WAIT_TIMEOUT_MS,
    transactionMaximumMs + CREDENTIAL_STORE_LOCK_WAIT_MARGIN_MS,
  );
  assert.ok(CREDENTIAL_STORE_LOCK_WAIT_TIMEOUT_MS > transactionMaximumMs);
});

test("credential-store locks reject invalid and overflowing timing options", () => {
  for (const options of [
    { retryMs: 0 },
    { retryMs: 1.5 },
    { retryMs: 2_147_483_648 },
    { timeoutMs: Number.NaN },
    { timeoutMs: 2_147_483_648 },
    { staleMs: Number.POSITIVE_INFINITY },
    { staleMs: 2_147_483_648 },
  ]) {
    const name = Object.keys(options)[0]!;
    assert.throws(
      () => new CrossProcessFileLock("unused.lock", options),
      new RegExp(`${name} must be an integer from 1 through 2147483647`, "u"),
    );
  }
});

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

test("encrypted store supports secret-free listing and atomic modification", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-encrypted-list-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const store = new EncryptedFileCredentialStore({
    path: join(directory, "auth.enc"),
    key: randomBytes(32),
  });

  const created = await store.modify("fixture", async () => ({
    kind: "api_key",
    provider: "fixture",
    apiKey: "indexed-secret",
  }));
  assert.equal(created?.kind, "api_key");
  assert.deepEqual(await store.list(), [{ providerId: "fixture", type: "api_key" }]);
  assert.doesNotMatch(JSON.stringify(await store.list()), /indexed-secret/u);
  assert.equal((await store.modify("fixture", async () => undefined))?.kind, "api_key");
});

test("encrypted-store listing reports canonical providers for named profiles", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-encrypted-profiles-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const store = new EncryptedFileCredentialStore({
    path: join(directory, "auth.enc"),
    key: randomBytes(32),
  });
  await new CredentialProfileManager(store, "fixture").create("work", {
    kind: "api_key",
    provider: "fixture",
    apiKey: "profile-secret",
  });

  assert.deepEqual(await store.list(), [{ providerId: "fixture", type: "api_key" }]);
  assert.doesNotMatch(JSON.stringify(await store.list()), /credential-profile-v1|profile-secret/u);
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

test("credential-store locks still reclaim a stale owner without a live process", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-lock-stale-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "credentials.lock");
  await writeFile(path, JSON.stringify({ token: "stale", createdAt: 1 }), { mode: 0o600 });
  const stale = new Date(Date.now() - 60_000);
  await utimes(path, stale, stale);

  const lock = new CrossProcessFileLock(path, { retryMs: 1, timeoutMs: 2_000, staleMs: 5 });
  assert.equal(await lock.run(async () => "acquired"), "acquired");
  await assert.rejects(stat(path), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("credential-store lock wait timing remains injectable and abortable", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-lock-timing-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "credentials.lock");
  const first = new CrossProcessFileLock(path, { retryMs: 1, timeoutMs: 100 });
  const second = new CrossProcessFileLock(path, { retryMs: 1, timeoutMs: 100 });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const holding = first.run(async () => {
    entered();
    await delay(25);
  });
  await ready;
  assert.equal(await second.run(async () => "acquired"), "acquired");
  await holding;

  let release!: () => void;
  let reacquired!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const acquired = new Promise<void>((resolve) => { reacquired = resolve; });
  const holdingAgain = first.run(async () => { reacquired(); await gate; });
  await acquired;
  const controller = new AbortController();
  const reason = new Error("cancel lock wait");
  const waiting = second.run(async () => undefined, controller.signal);
  await delay(5);
  controller.abort(reason);
  await assert.rejects(waiting, (error: unknown) =>
    error instanceof Error
    && error.name === "AbortError"
    && error.cause === reason);
  release();
  await holdingAgain;
});

test("credential-store locks immediately reclaim a fresh lock from an exited process", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-lock-exited-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "credentials.lock");
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid !== undefined);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  await writeFile(path, JSON.stringify({ token: "exited", pid, createdAt: Date.now() }), { mode: 0o600 });

  const lock = new CrossProcessFileLock(path, { retryMs: 1, timeoutMs: 50, staleMs: 60_000 });
  assert.equal(await lock.run(async () => "acquired"), "acquired");
  await assert.rejects(stat(path), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("a live credential-store lock is not reclaimed only because its timestamp is old", async (context) => {
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
  let enteredWhileFirstWasActive = false;
  try {
    enteredWhileFirstWasActive = await Promise.race([
      secondReady.then(() => true),
      delay(25).then(() => false),
    ]);
    assert.equal(enteredWhileFirstWasActive, false);
  } finally {
    releaseFirst();
    await firstRun;
    await secondReady;
    releaseSecond();
    await secondRun;
  }
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
