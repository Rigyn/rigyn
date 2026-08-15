import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthStorage } from "../../src/auth/auth-storage.js";
import { EncryptedFileCredentialStore } from "../../src/auth/file-store.js";
import { CredentialProfileManager } from "../../src/auth/profiles.js";
import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import type { AuthCredential, CredentialProfileMetadataStore, MutableCredentialStore } from "../../src/auth/types.js";
import { ProviderCredentialStoreAdapter } from "../../src/providers/auth-store-adapter.js";
import { providerCredentialScope } from "../../src/providers/provider-credential-scope.js";

test("AuthStorage persists direct provider entries in a private auth.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-auth-storage-"));
  try {
    const path = join(root, "agent", "auth.json");
    const storage = AuthStorage.create(path);
    await storage.write("fixture", {
      kind: "api_key",
      provider: "fixture",
      apiKey: "secret",
    });

    const serialized = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(serialized), ["fixture"]);
    assert.deepEqual(await storage.read("fixture"), {
      kind: "api_key",
      provider: "fixture",
      apiKey: "secret",
    });
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);

    await storage.delete("fixture");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AuthStorage serializes concurrent writers without dropping provider entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-auth-storage-"));
  try {
    const path = join(root, "auth.json");
    const left = AuthStorage.create(path);
    const right = AuthStorage.create(path);
    await Promise.all([
      left.write("left", { kind: "api_key", provider: "left", apiKey: "one-key" }),
      right.write("right", { kind: "api_key", provider: "right", apiKey: "two-key" }),
    ]);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path, "utf8"))).sort(), ["left", "right"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AuthStorage rejects unprotectable credentials before writing or replacing stored data", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-auth-storage-"));
  try {
    const path = join(root, "auth.json");
    const storage = AuthStorage.create(path);
    await assert.rejects(
      storage.write("short", { kind: "api_key", provider: "short", apiKey: "abc" }),
      /invalid or unsupported shape/u,
    );
    await assert.rejects(stat(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

    await storage.write("valid", { kind: "api_key", provider: "valid", apiKey: "valid-key" });
    const before = await readFile(path, "utf8");
    await assert.rejects(
      storage.modify("valid", async () => ({ kind: "bearer", provider: "valid", accessToken: "xyz" })),
      /invalid or unsupported shape/u,
    );
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AuthStorage enumerates no secrets and serializes atomic credential rotation", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-auth-storage-"));
  try {
    const path = join(root, "auth.json");
    const left = AuthStorage.create(path);
    const right = AuthStorage.create(path);
    await left.write("oauth-provider", {
      kind: "oauth",
      provider: "oauth-provider",
      accessToken: "old-access",
      refreshToken: "refresh",
      expiresAt: 1,
      tokenType: "Bearer",
      scopes: [],
    });
    assert.deepEqual(await left.list(), [{ providerId: "oauth-provider", type: "oauth" }]);

    let rotations = 0;
    const rotate = async (storage: AuthStorage) => await storage.modify("oauth-provider", async (current) => {
      assert.equal(current?.kind, "oauth");
      if (current?.kind !== "oauth" || current.expiresAt > 1) return undefined;
      rotations += 1;
      await Promise.resolve();
      return { ...current, accessToken: "new-access", expiresAt: 2 };
    });
    const [first, second] = await Promise.all([rotate(left), rotate(right)]);
    assert.equal(rotations, 1);
    assert.equal(first?.kind === "oauth" ? first.accessToken : undefined, "new-access");
    assert.equal(second?.kind === "oauth" ? second.accessToken : undefined, "new-access");
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct provider credentials round-trip through the durable auth store", async () => {
  const storage = AuthStorage.inMemory();
  const credentials = new ProviderCredentialStoreAdapter(storage);
  const environmentSecret = "provider-environment-secret";
  await credentials.modify("direct", async () => ({
    type: "api_key",
    key: "direct-key",
    env: { PROVIDER_ACCOUNT: environmentSecret },
  }));
  assert.deepEqual(await credentials.read("direct"), {
    type: "api_key",
    key: "direct-key",
    env: { PROVIDER_ACCOUNT: environmentSecret },
  });
  assert.deepEqual(await credentials.list(), [{ providerId: "direct", type: "api_key" }]);
  assert.doesNotMatch(defaultSecretRedactor.redact(environmentSecret), /provider-environment-secret/u);

  await credentials.modify("direct", async () => ({
    type: "api_key",
    env: { AWS_PROFILE: "fixture-profile" },
  }));
  assert.deepEqual(await credentials.read("direct"), {
    type: "api_key",
    env: { AWS_PROFILE: "fixture-profile" },
  });
  assert.deepEqual(await storage.read("direct"), {
    kind: "api_key",
    provider: "direct",
    env: { AWS_PROFILE: "fixture-profile" },
  });

  await credentials.modify("direct", async () => ({
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: 123,
    tokenType: "Bearer",
    scopes: ["scope"],
  }));
  assert.deepEqual(await credentials.read("direct"), {
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: 123,
    tokenType: "Bearer",
    scopes: ["scope"],
  });
  assert.deepEqual(await credentials.list(), [{ providerId: "direct", type: "oauth" }]);
});

test("direct provider credential adapter carries cancellation through the host commit", async () => {
  const storage = AuthStorage.inMemory();
  const credentials = new ProviderCredentialStoreAdapter(storage);
  const controller = new AbortController();
  const cancellation = new Error("cancel provider credential before commit");

  await assert.rejects(
    credentials.modify("direct", async () => {
      queueMicrotask(() => controller.abort(cancellation));
      return { type: "api_key", key: "late-key" };
    }, controller.signal),
    (error: unknown) => error === cancellation,
  );
  assert.equal(await storage.read("direct"), undefined);
});

test("cancelled first profile login rolls back the durable credential before indexing it", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-auth-profile-cancellation-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const cancellation = new Error("cancel first profile login before index commit");
  const storage = new class extends EncryptedFileCredentialStore {
    override async write(id: string, credential: AuthCredential): Promise<void> {
      await super.write(id, credential);
      if (id.startsWith("credential-profile-v1:")) controller.abort(cancellation);
    }
  }({ path: join(directory, "auth.enc"), key: randomBytes(32) });
  const credentials = new ProviderCredentialStoreAdapter(storage);

  await assert.rejects(
    credentials.modify(
      "direct",
      async () => ({ type: "api_key", key: "late-profile-key" }),
      controller.signal,
    ),
    (error: unknown) => error === cancellation,
  );
  assert.deepEqual(await storage.list(), []);
  assert.deepEqual(await new CredentialProfileManager(storage, "direct").state(), {
    credentialId: "direct",
    fallbackSelected: false,
    profiles: [],
  });
  assert.equal(await credentials.read("direct"), undefined);
});

test("direct provider credential snapshots deduplicate reads and remain mutation-coherent", async () => {
  const storage = AuthStorage.inMemory({
    direct: { kind: "api_key", provider: "direct", apiKey: "before" },
  });
  let reads = 0;
  const counted: MutableCredentialStore = {
    async read(id) {
      reads += 1;
      return await storage.read(id);
    },
    write: storage.write.bind(storage),
    delete: storage.delete.bind(storage),
    withLock: storage.withLock.bind(storage),
    list: storage.list.bind(storage),
    modify: storage.modify.bind(storage),
  };
  const credentials = new ProviderCredentialStoreAdapter(counted);

  await credentials.withReadSnapshot(async () => {
    const [first, second] = await Promise.all([
      credentials.read("direct"),
      credentials.read("direct"),
    ]);
    assert.equal(first?.type === "api_key" ? first.key : undefined, "before");
    assert.equal(second?.type === "api_key" ? second.key : undefined, "before");
    assert.equal(reads, 1);
    if (first?.type === "api_key") first.key = "caller-mutation";
    assert.equal((await credentials.read("direct") as { key?: string } | undefined)?.key, "before");

    await credentials.modify("direct", async () => ({ type: "api_key", key: "after" }));
    assert.equal((await credentials.read("direct"))?.type, "api_key");
    assert.equal((await credentials.read("direct") as { key?: string } | undefined)?.key, "after");
    assert.equal(reads, 1);

    await credentials.delete("direct");
    assert.equal(await credentials.read("direct"), undefined);
    assert.equal(reads, 1);
  });

  assert.equal(await credentials.read("direct"), undefined);
  assert.equal(reads, 2);
});

test("direct provider credential snapshots do not retain cross-operation state", async () => {
  const storage = AuthStorage.inMemory();
  const credentials = new ProviderCredentialStoreAdapter(storage);

  await credentials.withReadSnapshot(async () => {
    assert.equal(await credentials.read("external"), undefined);
    await storage.write("external", {
      kind: "api_key",
      provider: "external",
      apiKey: "new-secret",
    });
    assert.equal(await credentials.read("external"), undefined);
  });

  assert.deepEqual(await credentials.read("external"), {
    type: "api_key",
    key: "new-secret",
  });
});

test("credential snapshots trust authoritative profile enumeration for absent providers", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-profile-enumeration-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storage = new EncryptedFileCredentialStore({
    path: join(root, "credentials.enc"),
    key: randomBytes(32),
  });
  await new CredentialProfileManager(storage, "configured").create("default", {
    kind: "api_key",
    provider: "configured",
    apiKey: "configured-secret",
  });

  let lists = 0;
  let profileLists = 0;
  let profileReads = 0;
  const counted: CredentialProfileMetadataStore & MutableCredentialStore = {
    read: storage.read.bind(storage),
    write: storage.write.bind(storage),
    delete: storage.delete.bind(storage),
    withLock: storage.withLock.bind(storage),
    modify: storage.modify.bind(storage),
    async list() {
      lists += 1;
      return await storage.list();
    },
    async readCredentialProfileIndex(id) {
      profileReads += 1;
      return await storage.readCredentialProfileIndex(id);
    },
    writeCredentialProfileIndex: storage.writeCredentialProfileIndex.bind(storage),
    deleteCredentialProfileIndex: storage.deleteCredentialProfileIndex.bind(storage),
    async listCredentialProfileIds() {
      profileLists += 1;
      return await storage.listCredentialProfileIds();
    },
  };
  const credentials = new ProviderCredentialStoreAdapter(counted);

  await credentials.withReadSnapshot(async () => {
    const ids = ["configured", ...Array.from({ length: 64 }, (_, index) => `missing-${index}`)];
    const values = await Promise.all(ids.flatMap((id) => [credentials.read(id), credentials.read(id)]));
    assert.equal(values[0]?.type, "api_key");
    assert.ok(values.slice(2).every((value) => value === undefined));
  });

  assert.equal(lists, 1);
  assert.equal(profileLists, 1);
  assert.equal(profileReads, 1);
});

test("direct provider credentials follow the selected durable profile", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-profiled-provider-auth-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storage = new EncryptedFileCredentialStore({
    path: join(root, "credentials.enc"),
    key: randomBytes(32),
  });
  const profiles = new CredentialProfileManager(storage, "profiled");
  await profiles.create("work", {
    kind: "oauth",
    provider: "profiled",
    accessToken: "work-access",
    refreshToken: "work-refresh",
    expiresAt: 123,
    tokenType: "Bearer",
    scopes: [],
  });
  await profiles.create("personal", {
    kind: "oauth",
    provider: "profiled",
    accessToken: "personal-access",
    refreshToken: "personal-refresh",
    expiresAt: 456,
    tokenType: "Bearer",
    scopes: [],
  });
  await profiles.select("personal");

  const credentials = new ProviderCredentialStoreAdapter(storage);
  assert.deepEqual(await credentials.list(), [{ providerId: "profiled", type: "oauth" }]);
  assert.equal((await credentials.read("profiled"))?.type, "oauth");
  assert.equal((await credentials.read("profiled") as { access?: string } | undefined)?.access, "personal-access");
  await credentials.withReadSnapshot(async () => {
    const first = await credentials.read("profiled");
    const scope = providerCredentialScope(first);
    assert.ok(scope);
    if (first?.type === "oauth") first.access = "caller-mutation";
    const second = await credentials.read("profiled");
    assert.equal(second?.type === "oauth" ? second.access : undefined, "personal-access");
    assert.equal(providerCredentialScope(second), scope);
  });
  await credentials.modify("profiled", async (current) => current?.type === "oauth"
    ? { ...current, access: "rotated-personal-access", expires: 789 }
    : current);
  const work = await profiles.read("work");
  const personal = await profiles.read("personal");
  assert.equal(work?.kind === "oauth" ? work.accessToken : undefined, "work-access");
  assert.equal(personal?.kind === "oauth" ? personal.accessToken : undefined, "rotated-personal-access");
  assert.deepEqual(await credentials.list(), [{ providerId: "profiled", type: "oauth" }]);
});

test("profiled provider refresh retains a credential when a concurrent waiter has already refreshed it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-profiled-provider-refresh-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storage = new EncryptedFileCredentialStore({
    path: join(root, "credentials.enc"),
    key: randomBytes(32),
  });
  const profiles = new CredentialProfileManager(storage, "profiled");
  await profiles.create("default", {
    kind: "oauth",
    provider: "profiled",
    accessToken: "expired-access",
    refreshToken: "refresh",
    expiresAt: 1,
    tokenType: "Bearer",
    scopes: [],
  });

  const credentials = new ProviderCredentialStoreAdapter(storage);
  let rotations = 0;
  const refresh = async () => await credentials.modify("profiled", async (current) => {
    assert.equal(current?.type, "oauth");
    if (current?.type !== "oauth" || current.expires > 1) return undefined;
    rotations += 1;
    await Promise.resolve();
    return { ...current, access: "fresh-access", expires: 2 };
  });
  const [first, second] = await Promise.all([refresh(), refresh()]);

  assert.equal(rotations, 1);
  assert.equal(first?.type === "oauth" ? first.access : undefined, "fresh-access");
  assert.equal(second?.type === "oauth" ? second.access : undefined, "fresh-access");
  assert.equal((await profiles.read("default"))?.kind, "oauth");
  assert.equal((await credentials.read("profiled") as { access?: string } | undefined)?.access, "fresh-access");
});

test("a cold profiled provider adapter rejects a selected slot whose credential is missing", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-profiled-provider-missing-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storage = new EncryptedFileCredentialStore({
    path: join(root, "credentials.enc"),
    key: randomBytes(32),
  });
  const profiles = new CredentialProfileManager(storage, "profiled");
  await profiles.create("default", {
    kind: "api_key",
    provider: "profiled",
    apiKey: "selected-secret",
  });
  const active = await profiles.active();
  assert.ok(active.storageId);
  await storage.delete(active.storageId);

  const reopened = new ProviderCredentialStoreAdapter(storage);
  await assert.rejects(reopened.read("profiled"), /Active credential profile is missing/u);
  assert.deepEqual(await reopened.list(), []);
});

test("a cold provider adapter checks legacy profile metadata when enumeration is unavailable", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-legacy-profiled-provider-missing-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storage = new EncryptedFileCredentialStore({
    path: join(root, "credentials.enc"),
    key: randomBytes(32),
  });
  const legacy: CredentialProfileMetadataStore & MutableCredentialStore = {
    read: storage.read.bind(storage),
    write: storage.write.bind(storage),
    delete: storage.delete.bind(storage),
    withLock: storage.withLock.bind(storage),
    list: storage.list.bind(storage),
    modify: storage.modify.bind(storage),
    readCredentialProfileIndex: storage.readCredentialProfileIndex.bind(storage),
    writeCredentialProfileIndex: storage.writeCredentialProfileIndex.bind(storage),
    deleteCredentialProfileIndex: storage.deleteCredentialProfileIndex.bind(storage),
  };
  assert.equal(legacy.listCredentialProfileIds, undefined);
  const profiles = new CredentialProfileManager(legacy, "profiled");
  await profiles.create("default", {
    kind: "api_key",
    provider: "profiled",
    apiKey: "selected-secret",
  });
  const active = await profiles.active();
  assert.ok(active.storageId);
  await legacy.delete(active.storageId);

  const reopened = new ProviderCredentialStoreAdapter(legacy);
  await assert.rejects(reopened.read("profiled"), /Active credential profile is missing/u);
  assert.deepEqual(await reopened.list(), []);
});

test("durable provider environments reject malformed or empty credentials", async () => {
  const storage = AuthStorage.inMemory();
  await assert.rejects(storage.write("empty", {
    kind: "api_key",
    provider: "empty",
  }));
  await assert.rejects(storage.write("invalid-env", {
    kind: "api_key",
    provider: "invalid-env",
    env: { "BAD-NAME": "value" },
  }));
  await assert.rejects(storage.write("nul-env", {
    kind: "api_key",
    provider: "nul-env",
    env: { VALID_NAME: "bad\0value" },
  }));
});
