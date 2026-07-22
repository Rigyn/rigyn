import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CredentialBroker,
  CredentialProfileManager,
  EncryptedFileCredentialStore,
  EnvironmentCredentialSource,
  ProfiledRefreshingStoredCredentialSource,
  type AuthCredential,
  type CredentialProfileMetadataStore,
} from "../../src/auth/index.js";

class MemoryProfileStore implements CredentialProfileMetadataStore {
  readonly credentials = new Map<string, AuthCredential>();
  readonly indexes = new Map<string, unknown>();
  failNextIndexWrite = false;
  failNextIndexDelete = false;

  async read(id: string): Promise<AuthCredential | undefined> { return this.credentials.get(id); }
  async write(id: string, credential: AuthCredential): Promise<void> { this.credentials.set(id, structuredClone(credential)); }
  async delete(id: string): Promise<void> { this.credentials.delete(id); }
  async withLock<T>(_id: string, operation: () => Promise<T>): Promise<T> { return operation(); }
  async readCredentialProfileIndex(id: string): Promise<unknown | undefined> { return structuredClone(this.indexes.get(id)); }
  async writeCredentialProfileIndex(id: string, value: unknown): Promise<void> {
    if (this.failNextIndexWrite) {
      this.failNextIndexWrite = false;
      throw new Error("injected index write failure");
    }
    this.indexes.set(id, structuredClone(value));
  }
  async deleteCredentialProfileIndex(id: string): Promise<void> {
    if (this.failNextIndexDelete) {
      this.failNextIndexDelete = false;
      throw new Error("injected index delete failure");
    }
    this.indexes.delete(id);
  }
}

function apiKey(provider: string, value: string, accountId?: string): AuthCredential {
  return {
    kind: "api_key",
    provider,
    apiKey: value,
    ...(accountId === undefined ? {} : { accountId }),
  };
}

test("legacy single credentials migrate non-destructively into an explicit default profile", async () => {
  const store = new MemoryProfileStore();
  store.credentials.set("openai", apiKey("openai", "legacy-secret", "legacy-account"));
  const manager = new CredentialProfileManager(store, "openai");

  const state = await manager.state();
  assert.equal(state.activeProfile, "default");
  assert.equal(state.fallbackSelected, false);
  assert.deepEqual(state.profiles, [{
    name: "default",
    active: true,
    present: true,
    usable: true,
    kind: "api_key",
    accountId: "legacy-account",
  }]);
  assert.equal(store.credentials.get("openai")?.kind, "api_key");
  assert.ok(store.indexes.has("openai"));
  assert.doesNotMatch(JSON.stringify(state), /legacy-secret/u);
});

test("profile CRUD and selection never fall through to a different environment account", async () => {
  const store = new MemoryProfileStore();
  const manager = new CredentialProfileManager(store, "openai");
  await manager.create("work", apiKey("openai", "work-secret", "work-account"));
  await manager.create("personal", apiKey("openai", "personal-secret", "personal-account"));
  assert.equal((await manager.state()).activeProfile, "work");
  await manager.select("personal");
  assert.equal((await manager.read("personal"))?.kind, "api_key");

  const source = new ProfiledRefreshingStoredCredentialSource(store);
  const broker = new CredentialBroker([
    source,
    new EnvironmentCredentialSource({ environment: { OPENAI_API_KEY: "environment-secret" } }),
  ]);
  const selected = await broker.resolve({ provider: "openai" });
  assert.equal(selected?.credential.kind === "api_key" ? selected.credential.apiKey : undefined, "personal-secret");

  await manager.delete("personal");
  const disconnected = await manager.state();
  assert.equal(disconnected.activeProfile, undefined);
  assert.equal(disconnected.profiles.some((profile) => profile.active), false);
  await assert.rejects(broker.resolve({ provider: "openai" }), /No active credential profile/u);

  await manager.selectFallback();
  const fallback = await broker.resolve({ provider: "openai" });
  assert.equal(fallback?.source, "environment");
  assert.equal(fallback?.credential.kind === "api_key" ? fallback.credential.apiKey : undefined, "environment-secret");

  await manager.select("work");
  await manager.update("work", {
    kind: "bearer",
    provider: "openai",
    accessToken: "expired-token",
    expiresAt: 1,
    accountId: "work-account",
  });
  await assert.rejects(broker.resolve({ provider: "openai" }), /expired; reauthentication is required/u);
  assert.doesNotMatch(JSON.stringify(await manager.state()), /work-secret|personal-secret|expired-token|environment-secret/u);
});

test("a corrupt or missing active slot blocks account fallback", async () => {
  const store = new MemoryProfileStore();
  const manager = new CredentialProfileManager(store, "openai");
  await manager.create("work", apiKey("openai", "work-secret"));
  const slot = [...store.credentials.keys()].find((id) => id !== "openai");
  assert.ok(slot);
  store.credentials.delete(slot);
  const broker = new CredentialBroker([
    new ProfiledRefreshingStoredCredentialSource(store),
    new EnvironmentCredentialSource({ environment: { OPENAI_API_KEY: "environment-secret" } }),
  ]);
  await assert.rejects(broker.resolve({ provider: "openai" }), /Active credential profile is missing/u);
  assert.equal((await manager.state()).profiles[0]?.present, false);
});

test("profile metadata failures roll back credential create, replacement, and deletion", async () => {
  const store = new MemoryProfileStore();
  const manager = new CredentialProfileManager(store, "openai");
  await manager.create("work", apiKey("openai", "original-secret"));

  store.failNextIndexWrite = true;
  await assert.rejects(
    manager.create("personal", apiKey("openai", "orphan-secret")),
    /injected index write failure/u,
  );
  assert.equal(await manager.read("personal"), undefined);
  assert.deepEqual((await manager.state()).profiles.map((profile) => profile.name), ["work"]);

  await manager.selectFallback();
  store.failNextIndexWrite = true;
  await assert.rejects(
    manager.putSelected(apiKey("openai", "replacement-secret"), { profile: "work" }),
    /injected index write failure/u,
  );
  const restored = await manager.read("work");
  assert.equal(restored?.kind === "api_key" ? restored.apiKey : undefined, "original-secret");
  assert.equal((await manager.state()).fallbackSelected, true);

  store.failNextIndexDelete = true;
  await assert.rejects(manager.delete("work"), /injected index delete failure/u);
  const retained = await manager.read("work");
  assert.equal(retained?.kind === "api_key" ? retained.apiKey : undefined, "original-secret");
  assert.equal((await manager.state()).profiles[0]?.present, true);
});

test("cross-process file locking admits exactly one concurrent profile create", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-auth-profiles-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "credentials.enc");
  const key = randomBytes(32);
  const first = new CredentialProfileManager(new EncryptedFileCredentialStore({ path, key }), "openai");
  const second = new CredentialProfileManager(new EncryptedFileCredentialStore({ path, key }), "openai");
  const results = await Promise.allSettled([
    first.create("work", apiKey("openai", "first-secret")),
    second.create("work", apiKey("openai", "second-secret")),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const state = await first.state();
  assert.equal(state.activeProfile, "work");
  assert.deepEqual(state.profiles.map((profile) => profile.name), ["work"]);
});

test("profile names, counts, and credential registration identity are bounded", async () => {
  const store = new MemoryProfileStore();
  const manager = new CredentialProfileManager(store, "openai");
  await assert.rejects(manager.create("bad name", apiKey("openai", "secret-value")), /profile name/u);
  await assert.rejects(manager.create("work", apiKey("other", "secret-value")), /must match/u);
  for (let index = 0; index < 64; index += 1) {
    await manager.create(`p-${index}`, apiKey("openai", `secret-${index}`));
  }
  await assert.rejects(manager.create("overflow", apiKey("openai", "overflow-secret")), /limit reached/u);
});
