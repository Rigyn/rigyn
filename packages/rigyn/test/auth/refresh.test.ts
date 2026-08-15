import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { EncryptedFileCredentialStore } from "../../src/auth/file-store.js";
import { OAuthRefreshCoordinator } from "../../src/auth/refresh.js";

test("refresh is single-flight across store instances and rotates tokens atomically", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-refresh-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "credentials.enc");
  const key = randomBytes(32);
  const firstStore = new EncryptedFileCredentialStore({ path, key });
  const secondStore = new EncryptedFileCredentialStore({ path, key });
  await firstStore.write("account", {
    kind: "oauth",
    provider: "example",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: 1,
    tokenType: "Bearer",
    scopes: ["model:read"],
    accountId: "account-1",
    subject: "subject-1",
  });

  let refreshes = 0;
  const refresher = async () => {
    refreshes += 1;
    await delay(40);
    return {
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: Date.now() + 3_600_000,
      accountId: "account-1",
      subject: "subject-1",
    };
  };
  const first = new OAuthRefreshCoordinator({ store: firstStore, refresh: refresher });
  const second = new OAuthRefreshCoordinator({ store: secondStore, refresh: refresher });
  const [left, right] = await Promise.all([
    first.getValid("account", { force: true }),
    second.getValid("account", { force: true }),
  ]);

  assert.equal(refreshes, 1);
  assert.equal(left.accessToken, "access-2");
  assert.equal(right.accessToken, "access-2");
  assert.equal((await firstStore.read("account"))?.kind, "oauth");
  assert.equal((await firstStore.read("account") as { refreshToken?: string }).refreshToken, "refresh-2");
});

test("refresh preserves an omitted refresh token and rejects identity changes", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-refresh-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "credentials.enc");
  const key = randomBytes(32);
  const store = new EncryptedFileCredentialStore({ path, key });
  await store.write("account", {
    kind: "oauth",
    provider: "example",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: 1,
    tokenType: "Bearer",
    scopes: [],
    accountId: "account-1",
  });

  const preserving = new OAuthRefreshCoordinator({
    store,
    refresh: async () => ({ accessToken: "access-2", expiresAt: Date.now() + 60_000 }),
  });
  assert.equal((await preserving.getValid("account", { force: true })).refreshToken, "refresh-1");

  const guarded = new OAuthRefreshCoordinator({
    store,
    refresh: async () => ({
      accessToken: "access-3",
      expiresAt: Date.now() + 60_000,
      accountId: "different-account",
    }),
  });
  await assert.rejects(guarded.getValid("account", { force: true }), /changed account identity/);
  const stored = await store.read("account");
  assert.equal(stored?.kind === "oauth" ? stored.accessToken : undefined, "access-2");
});

test("refresh persists trusted replacement registration metadata", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-refresh-registration-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new EncryptedFileCredentialStore({
    path: join(directory, "credentials.enc"),
    key: randomBytes(32),
  });
  await store.write("account", {
    kind: "oauth",
    provider: "kimi-code",
    accessToken: "expired-access",
    refreshToken: "refresh-token",
    expiresAt: 1,
    tokenType: "Bearer",
    scopes: [],
    tokenEndpoint: "https://attacker.invalid/token",
    clientId: "attacker-client",
  });

  const coordinator = new OAuthRefreshCoordinator({
    store,
    refresh: async () => ({
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      expiresAt: Date.now() + 60_000,
      tokenEndpoint: "https://auth.kimi.com/api/oauth/token",
      clientId: "trusted-kimi-client",
    }),
  });
  const refreshed = await coordinator.getValid("account", { force: true });
  assert.equal(refreshed.tokenEndpoint, "https://auth.kimi.com/api/oauth/token");
  assert.equal(refreshed.clientId, "trusted-kimi-client");
  const stored = await store.read("account");
  assert.equal(stored?.kind === "oauth" ? stored.tokenEndpoint : undefined, "https://auth.kimi.com/api/oauth/token");
  assert.equal(stored?.kind === "oauth" ? stored.clientId : undefined, "trusted-kimi-client");
});

test("one caller's cancellation does not poison an independent refresh waiter", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-refresh-signal-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new EncryptedFileCredentialStore({
    path: join(directory, "credentials.enc"),
    key: randomBytes(32),
  });
  await store.write("account", {
    kind: "oauth",
    provider: "example",
    accessToken: "expired-access",
    refreshToken: "refresh-token",
    expiresAt: 1,
    tokenType: "Bearer",
    scopes: [],
  });

  let refreshes = 0;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const coordinator = new OAuthRefreshCoordinator({
    store,
    refresh: async (_credential, signal) => {
      refreshes += 1;
      if (refreshes === 1) {
        firstStarted();
        await new Promise<never>((_resolve, reject) => {
          assert.ok(signal);
          const cancel = (): void => reject(signal.reason);
          signal.addEventListener("abort", cancel, { once: true });
        });
      }
      return {
        accessToken: "fresh-access",
        refreshToken: "fresh-refresh",
        expiresAt: Date.now() + 60_000,
      };
    },
  });
  const controller = new AbortController();
  const cancellation = new Error("first refresh cancelled");
  const first = coordinator.getValid("account", { force: true, signal: controller.signal });
  await started;
  const second = coordinator.getValid("account", { force: true });
  controller.abort(cancellation);

  await assert.rejects(first, (error: unknown) => error === cancellation);
  assert.equal((await second).accessToken, "fresh-access");
  assert.equal(refreshes, 2);
});

test("a late refresh result is not persisted after cancellation", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-refresh-cancelled-result-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const store = new EncryptedFileCredentialStore({
    path: join(directory, "credentials.enc"),
    key: randomBytes(32),
  });
  await store.write("account", {
    kind: "oauth",
    provider: "example",
    accessToken: "expired-access",
    refreshToken: "refresh-token",
    expiresAt: 1,
    tokenType: "Bearer",
    scopes: [],
  });
  const controller = new AbortController();
  const cancellation = new Error("cancel after refresh response");
  const coordinator = new OAuthRefreshCoordinator({
    store,
    refresh: async () => {
      controller.abort(cancellation);
      return {
        accessToken: "late-access",
        refreshToken: "late-refresh",
        expiresAt: Date.now() + 60_000,
      };
    },
  });

  await assert.rejects(
    coordinator.getValid("account", { force: true, signal: controller.signal }),
    (error: unknown) => error === cancellation,
  );
  const stored = await store.read("account");
  assert.equal(stored?.kind === "oauth" ? stored.accessToken : undefined, "expired-access");
  assert.equal(stored?.kind === "oauth" ? stored.refreshToken : undefined, "refresh-token");
});
