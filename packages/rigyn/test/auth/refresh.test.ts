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
