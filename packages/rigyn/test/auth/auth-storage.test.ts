import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthStorage } from "../../src/auth/auth-storage.js";
import { ProviderCredentialStoreAdapter } from "../../src/providers/auth-store-adapter.js";

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
      left.write("left", { kind: "api_key", provider: "left", apiKey: "one" }),
      right.write("right", { kind: "api_key", provider: "right", apiKey: "two" }),
    ]);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path, "utf8"))).sort(), ["left", "right"]);
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
  await credentials.modify("direct", async () => ({ type: "api_key", key: "key" }));
  assert.deepEqual(await credentials.read("direct"), { type: "api_key", key: "key" });
  assert.deepEqual(await credentials.list(), [{ providerId: "direct", type: "api_key" }]);

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
