import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { AuthStorage, readStoredCredential } from "../../src/auth/auth-storage.js";
import {
  createDefaultCredentialStore,
  prepareDefaultCredentialStorePurge,
  purgeDefaultCredentialStore,
  readStoredCredentialAsync,
} from "../../src/auth/default-store.js";
import {
  KeychainCredentialStore,
  type KeychainAdapter,
} from "../../src/auth/keychain.js";
import { CredentialProfileManager } from "../../src/auth/profiles.js";

function memoryKeychain(): { adapter: KeychainAdapter; values: Map<string, string> } {
  const values = new Map<string, string>();
  const key = (service: string, account: string) => `${service}\0${account}`;
  return {
    values,
    adapter: {
      async get(service, account) { return values.get(key(service, account)); },
      async set(service, account, secret) { values.set(key(service, account), secret); },
      async delete(service, account) { values.delete(key(service, account)); },
    },
  };
}

const windowsProtector = {
  async protect(key: Uint8Array) { return `fixture:v1:${Buffer.from(key).toString("base64url")}`; },
  async unprotect(envelope: string) {
    assert.match(envelope, /^fixture:v1:/u);
    return Buffer.from(envelope.slice("fixture:v1:".length), "base64url");
  },
};

test("default credential selection migrates plaintext credentials into an available platform keychain", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-keychain-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  const legacy = AuthStorage.create(authPath);
  await legacy.write("fixture", { kind: "api_key", provider: "fixture", apiKey: "migration-secret" });
  const keychain = memoryKeychain();

  const store = await createDefaultCredentialStore(authPath, {
    platform: "linux",
    keychainAdapter: keychain.adapter,
  });

  assert.equal(store instanceof KeychainCredentialStore, true);
  assert.equal((await store.read("fixture"))?.kind, "api_key");
  assert.deepEqual(await (store as KeychainCredentialStore).list(), [{ providerId: "fixture", type: "api_key" }]);
  await assert.rejects(stat(authPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.deepEqual(JSON.parse(await readFile(`${authPath}.backend`, "utf8")), {
    version: 1,
    backend: "linux-secret-service-v1",
  });
});

test("platform keychain opt-out retains the private atomic plaintext store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-plaintext-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  const store = await createDefaultCredentialStore(authPath, {
    platform: "linux",
    allowPlatformKeychain: false,
  });

  assert.equal(store instanceof AuthStorage, true);
  await store.write("fixture", { kind: "api_key", provider: "fixture", apiKey: "fallback-secret" });
  assert.match(await readFile(authPath, "utf8"), /fallback-secret/u);
});

test("initial Linux selection falls back without a marker when the full keychain probe fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-probe-fallback-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  const keychain = memoryKeychain();
  const store = await createDefaultCredentialStore(authPath, {
    platform: "linux",
    keychainAdapter: {
      get: keychain.adapter.get,
      set: keychain.adapter.set,
      async delete() { throw new Error("delete unavailable"); },
    },
  });

  assert.equal(store instanceof AuthStorage, true);
  await store.write("fixture", { kind: "api_key", provider: "fixture", apiKey: "probe-fallback" });
  assert.match(await readFile(authPath, "utf8"), /probe-fallback/u);
  await assert.rejects(stat(`${authPath}.backend`), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("initial macOS selection falls back without pinning an unavailable Keychain", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-macos-probe-fallback-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  const unavailable: KeychainAdapter = {
    async get() { throw new Error("service unavailable"); },
    async set() { throw new Error("service unavailable"); },
    async delete() { throw new Error("service unavailable"); },
  };
  const store = await createDefaultCredentialStore(authPath, {
    platform: "darwin",
    keychainAdapter: unavailable,
  });

  assert.equal(store instanceof AuthStorage, true);
  await store.write("fixture", { kind: "api_key", provider: "fixture", apiKey: "macos-probe-fallback" });
  assert.match(await readFile(authPath, "utf8"), /macos-probe-fallback/u);
  await assert.rejects(stat(`${authPath}.backend`), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("Windows default storage protects a local encryption key and reopens the encrypted store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-dpapi-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  const first = await createDefaultCredentialStore(authPath, {
    platform: "win32",
    createLocalKey: true,
    windowsKeyProtector: windowsProtector,
  });
  await first.write("fixture", { kind: "bearer", provider: "fixture", accessToken: "encrypted-secret" });
  assert.doesNotMatch(await readFile(`${authPath}.enc`, "utf8"), /encrypted-secret/u);
  assert.match(await readFile(`${authPath}.key`, "utf8"), /^fixture:v1:/u);

  const reopened = await createDefaultCredentialStore(authPath, {
    platform: "win32",
    windowsKeyProtector: windowsProtector,
  });
  assert.deepEqual(await reopened.read("fixture"), {
    kind: "bearer",
    provider: "fixture",
    accessToken: "encrypted-secret",
  });
});

test("macOS default storage migrates plaintext credentials and pins Keychain", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-macos-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  const legacy = AuthStorage.create(authPath);
  await legacy.write("fixture", { kind: "api_key", provider: "fixture", apiKey: "macos-migration" });
  let calls = 0;
  const keychain = memoryKeychain();
  const adapter: KeychainAdapter = {
    async get(...args) { calls += 1; return await keychain.adapter.get(...args); },
    async set(...args) { calls += 1; return await keychain.adapter.set(...args); },
    async delete(...args) { calls += 1; return await keychain.adapter.delete(...args); },
  };

  const store = await createDefaultCredentialStore(authPath, {
    platform: "darwin",
    keychainAdapter: adapter,
  });
  assert.equal(store instanceof KeychainCredentialStore, true);
  assert.equal((await store.read("fixture"))?.kind, "api_key");
  assert.ok(calls > 0);
  await assert.rejects(stat(authPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.deepEqual(JSON.parse(await readFile(`${authPath}.backend`, "utf8")), {
    version: 1,
    backend: "macos-keychain-v1",
  });
});

test("concurrent macOS selection serializes migration into one pinned Keychain backend", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-macos-concurrent-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  await AuthStorage.create(authPath).write("fixture", {
    kind: "api_key",
    provider: "fixture",
    apiKey: "concurrent-migration",
  });
  const keychain = memoryKeychain();

  const [first, second] = await Promise.all([
    createDefaultCredentialStore(authPath, { platform: "darwin", keychainAdapter: keychain.adapter }),
    createDefaultCredentialStore(authPath, { platform: "darwin", keychainAdapter: keychain.adapter }),
  ]);

  assert.equal(first instanceof KeychainCredentialStore, true);
  assert.equal(second instanceof KeychainCredentialStore, true);
  assert.deepEqual(await first.read("fixture"), await second.read("fixture"));
  await assert.rejects(stat(authPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.deepEqual(JSON.parse(await readFile(`${authPath}.backend`, "utf8")), {
    version: 1,
    backend: "macos-keychain-v1",
  });
});

test("macOS partial migration retains plaintext and resumes safely through its pinned backend", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-macos-partial-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  const legacy = AuthStorage.create(authPath);
  await legacy.write("first", { kind: "api_key", provider: "first", apiKey: "first-secret" });
  await legacy.write("second", { kind: "api_key", provider: "second", apiKey: "second-secret" });
  const keychain = memoryKeychain();
  let failed = false;
  const interrupted: KeychainAdapter = {
    get: keychain.adapter.get,
    async set(service, account, secret, signal, sensitive) {
      if (!failed && secret.includes("second-secret")) {
        failed = true;
        throw new Error("simulated migration interruption");
      }
      await keychain.adapter.set(service, account, secret, signal, sensitive);
    },
    delete: keychain.adapter.delete,
  };

  await assert.rejects(
    createDefaultCredentialStore(authPath, { platform: "darwin", keychainAdapter: interrupted }),
    /simulated migration interruption/u,
  );
  assert.match(await readFile(authPath, "utf8"), /first-secret|second-secret/u);
  assert.deepEqual(JSON.parse(await readFile(`${authPath}.backend`, "utf8")), {
    version: 1,
    backend: "macos-keychain-v1",
  });

  const recovered = await createDefaultCredentialStore(authPath, {
    platform: "darwin",
    keychainAdapter: keychain.adapter,
  });
  assert.equal((await recovered.read("first"))?.kind, "api_key");
  assert.equal((await recovered.read("second"))?.kind, "api_key");
  await assert.rejects(stat(authPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("pinned macOS Keychain supports async reads and fails closed when unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-macos-pinned-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  const keychain = memoryKeychain();
  const store = await createDefaultCredentialStore(authPath, {
    platform: "darwin",
    keychainAdapter: keychain.adapter,
  });
  const profiles = new CredentialProfileManager(store, "fixture");
  await profiles.create("work", { kind: "api_key", provider: "fixture", apiKey: "macos-pinned-secret" });
  await profiles.select("work");

  assert.deepEqual(await readStoredCredentialAsync("fixture", authPath, {
    platform: "darwin",
    keychainAdapter: keychain.adapter,
  }), {
    kind: "api_key",
    provider: "fixture",
    apiKey: "macos-pinned-secret",
  });

  const unavailable: KeychainAdapter = {
    async get() { throw new Error("service unavailable"); },
    async set() { throw new Error("service unavailable"); },
    async delete() { throw new Error("service unavailable"); },
  };
  await assert.rejects(
    createDefaultCredentialStore(authPath, { platform: "darwin", keychainAdapter: unavailable }),
    /Pinned macOS Keychain credential backend is unavailable/u,
  );
  await assert.rejects(
    readStoredCredentialAsync("fixture", authPath, { platform: "darwin", keychainAdapter: unavailable }),
    /Pinned macOS Keychain credential backend is unavailable/u,
  );
  await assert.rejects(stat(authPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("macOS Keychain purge fails closed before removing every pinned record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-macos-purge-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  const keychain = memoryKeychain();
  const store = await createDefaultCredentialStore(authPath, {
    platform: "darwin",
    keychainAdapter: keychain.adapter,
  });
  await store.write("fixture", { kind: "bearer", provider: "fixture", accessToken: "macos-purge-token" });
  const profiles = new CredentialProfileManager(store, "profiled");
  await profiles.create("work", { kind: "api_key", provider: "profiled", apiKey: "macos-profile-secret" });
  const before = new Map(keychain.values);

  await assert.rejects(
    purgeDefaultCredentialStore(authPath, {
      platform: "darwin",
      keychainAdapter: {
        async get() { throw new Error("service unavailable"); },
        async set() { throw new Error("service unavailable"); },
        async delete() { throw new Error("service unavailable"); },
      },
    }),
    /Pinned macOS Keychain credential backend is unavailable/u,
  );
  assert.deepEqual(keychain.values, before);

  await purgeDefaultCredentialStore(authPath, {
    platform: "darwin",
    keychainAdapter: keychain.adapter,
  });
  assert.equal(keychain.values.size, 0);
  await purgeDefaultCredentialStore(authPath, {
    platform: "darwin",
    keychainAdapter: keychain.adapter,
  });
  assert.equal(keychain.values.size, 0);
  assert.deepEqual(JSON.parse(await readFile(`${authPath}.backend`, "utf8")), {
    version: 1,
    backend: "macos-keychain-v1",
  });
});

test("default-store purge removes pinned Linux Secret Service records and is idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-linux-purge-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  const keychain = memoryKeychain();
  const store = await createDefaultCredentialStore(authPath, {
    platform: "linux",
    keychainAdapter: keychain.adapter,
  });
  await store.write("fixture", { kind: "bearer", provider: "fixture", accessToken: "purged-token" });
  const profiles = new CredentialProfileManager(store, "profiled");
  await profiles.create("work", { kind: "api_key", provider: "profiled", apiKey: "profile-secret" });
  assert.ok(keychain.values.size > 0);

  await purgeDefaultCredentialStore(authPath, {
    platform: "linux",
    keychainAdapter: keychain.adapter,
  });
  assert.equal(keychain.values.size, 0);
  await purgeDefaultCredentialStore(authPath, {
    platform: "linux",
    keychainAdapter: keychain.adapter,
  });
  assert.equal(keychain.values.size, 0);
  assert.deepEqual(JSON.parse(await readFile(`${authPath}.backend`, "utf8")), {
    version: 1,
    backend: "linux-secret-service-v1",
  });
});

test("prepared purge reads a relocated marker without recreating the removed install tree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-relocated-purge-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "rigyn-home");
  const tombstone = join(root, "rigyn-home.uninstalling");
  const authPath = join(installRoot, "agent", "auth.json");
  const relocatedAuthPath = join(tombstone, "agent", "auth.json");
  const purgeLockPath = join(root, "credential-purge.lock");
  const keychain = memoryKeychain();
  const store = await createDefaultCredentialStore(authPath, {
    platform: "linux",
    keychainAdapter: keychain.adapter,
  });
  await store.write("fixture", { kind: "api_key", provider: "fixture", apiKey: "relocated-secret" });
  const before = new Map(keychain.values);
  await rename(installRoot, tombstone);

  const purge = await prepareDefaultCredentialStorePurge(authPath, {
    stateAuthPath: relocatedAuthPath,
    platform: "linux",
    keychainAdapter: keychain.adapter,
    keychainLockPath: purgeLockPath,
  });
  assert.deepEqual(keychain.values, before);
  await rm(tombstone, { recursive: true, force: true });
  await purge();

  assert.equal(keychain.values.size, 0);
  await assert.rejects(stat(purgeLockPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await assert.rejects(stat(installRoot), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await assert.rejects(stat(tombstone), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("prepared macOS purge retains its private helper through removal and disposes aborted preparation", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-macos-retained-purge-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "rigyn-home");
  const authPath = join(installRoot, "auth.json");
  const helperPath = join(installRoot, "native", "rigyn-keychain-helper");
  const logPath = join(root, "helper-operations.jsonl");
  const purgeLockPath = join(root, "credential-purge.lock");
  await mkdir(dirname(helperPath), { recursive: true });
  await writeFile(helperPath, [
    `#!${process.execPath}`,
    'const { appendFileSync } = require("node:fs");',
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { input += chunk; });',
    'process.stdin.on("end", () => {',
    '  const request = JSON.parse(input);',
    `  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ operation: request.operation, helper: process.argv[1] }) + "\\n");`,
    '  const status = request.operation === "get" ? "not_found" : "ok";',
    '  process.stdout.write(JSON.stringify({ version: 1, status }) + "\\n");',
    '});',
    "",
  ].join("\n"), { mode: 0o755 });
  await chmod(helperPath, 0o755);
  await writeFile(`${authPath}.backend`, `${JSON.stringify({
    version: 1,
    backend: "macos-keychain-v1",
  })}\n`, { mode: 0o600 });

  const aborted = await prepareDefaultCredentialStorePurge(authPath, {
    platform: "darwin",
    macosHelperPath: helperPath,
    keychainLockPath: purgeLockPath,
  });
  const abortedHelper = (JSON.parse((await readFile(logPath, "utf8")).trim()) as { helper: string }).helper;
  assert.notEqual(abortedHelper, helperPath);
  await aborted.dispose();
  await aborted.dispose();
  await assert.rejects(stat(abortedHelper), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await assert.rejects(stat(dirname(abortedHelper)), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

  await writeFile(logPath, "");
  const purge = await prepareDefaultCredentialStorePurge(authPath, {
    platform: "darwin",
    macosHelperPath: helperPath,
    keychainLockPath: purgeLockPath,
  });
  const retainedHelper = (JSON.parse((await readFile(logPath, "utf8")).trim()) as { helper: string }).helper;
  await rm(installRoot, { recursive: true, force: true });
  await writeFile(logPath, "");
  await purge();

  const operations = (await readFile(logPath, "utf8")).trim().split("\n").map((line) =>
    JSON.parse(line) as { operation: string; helper: string });
  assert.deepEqual(operations.map(({ operation }) => operation), ["get", "get", "delete"]);
  assert.deepEqual(new Set(operations.map(({ helper }) => helper)), new Set([retainedHelper]));
  await assert.rejects(stat(helperPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await assert.rejects(stat(retainedHelper), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await assert.rejects(stat(dirname(retainedHelper)), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("prepared macOS purge preserves both purge and retained-helper cleanup failures", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-macos-purge-double-failure-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  const helperPath = join(root, "rigyn-keychain-helper");
  const countPath = join(root, "helper-count");
  const retainedPathLog = join(root, "retained-helper-path");
  let retainedDirectory: string | undefined;
  t.after(async () => {
    if (retainedDirectory === undefined) return;
    await chmod(retainedDirectory, 0o700).catch(() => undefined);
    await rm(retainedDirectory, { recursive: true, force: true });
  });
  await writeFile(helperPath, [
    `#!${process.execPath}`,
    'const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");',
    `const countPath = ${JSON.stringify(countPath)};`,
    'let count = 0;',
    'try { count = Number(readFileSync(countPath, "utf8")); } catch {}',
    'writeFileSync(countPath, String(count + 1));',
    `appendFileSync(${JSON.stringify(retainedPathLog)}, process.argv[1] + "\\n");`,
    'if (count > 0) { process.stderr.write("fixture helper failure\\n"); process.exit(1); }',
    'process.stdout.write("{\\"version\\":1,\\"status\\":\\"not_found\\"}\\n");',
    "",
  ].join("\n"), { mode: 0o755 });
  await chmod(helperPath, 0o755);
  await writeFile(`${authPath}.backend`, `${JSON.stringify({
    version: 1,
    backend: "macos-keychain-v1",
  })}\n`, { mode: 0o600 });

  const purge = await prepareDefaultCredentialStorePurge(authPath, {
    platform: "darwin",
    macosHelperPath: helperPath,
    keychainLockPath: join(root, "credential-purge.lock"),
  });
  const retainedPath = (await readFile(retainedPathLog, "utf8")).trim();
  retainedDirectory = dirname(retainedPath);
  await chmod(retainedDirectory, 0o500);

  await assert.rejects(purge(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /Credential purge failed and cleanup was incomplete/u);
    assert.equal(error.errors.length, 2);
    assert.match(String(error.errors[0]), /Pinned macOS Keychain credential backend is unavailable/u);
    assert.equal((error.errors[1] as NodeJS.ErrnoException).code, "EACCES");
    return true;
  });
  await chmod(retainedDirectory, 0o700);
  await purge.dispose();
  await assert.rejects(stat(retainedDirectory), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("default-store purge fails closed when a pinned keychain is unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-keychain-purge-unavailable-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  const keychain = memoryKeychain();
  const store = await createDefaultCredentialStore(authPath, {
    platform: "linux",
    keychainAdapter: keychain.adapter,
  });
  await store.write("fixture", { kind: "api_key", provider: "fixture", apiKey: "preserved-secret" });
  const before = new Map(keychain.values);

  await assert.rejects(
    purgeDefaultCredentialStore(authPath, {
      platform: "linux",
      keychainAdapter: {
        async get() { throw new Error("service unavailable"); },
        async set() { throw new Error("service unavailable"); },
        async delete() { throw new Error("service unavailable"); },
      },
    }),
    /Pinned Linux Secret Service credential backend is unavailable/u,
  );
  assert.deepEqual(keychain.values, before);
  assert.deepEqual(JSON.parse(await readFile(`${authPath}.backend`, "utf8")), {
    version: 1,
    backend: "linux-secret-service-v1",
  });
});

test("Linux keychain namespaces and locks are isolated by canonical auth path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-namespaces-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const keychain = memoryKeychain();
  const firstPath = join(root, "first", "auth.json");
  const secondPath = join(root, "second", "auth.json");
  const first = await createDefaultCredentialStore(firstPath, {
    platform: "linux",
    keychainAdapter: keychain.adapter,
  });
  const second = await createDefaultCredentialStore(secondPath, {
    platform: "linux",
    keychainAdapter: keychain.adapter,
  });

  await first.write("fixture", { kind: "api_key", provider: "fixture", apiKey: "first-secret" });
  await second.write("fixture", { kind: "api_key", provider: "fixture", apiKey: "second-secret" });
  const firstCredential = await first.read("fixture");
  const secondCredential = await second.read("fixture");
  assert.equal(firstCredential?.kind === "api_key" ? firstCredential.apiKey : undefined, "first-secret");
  assert.equal(secondCredential?.kind === "api_key" ? secondCredential.apiKey : undefined, "second-secret");
  const credentialServices = new Set(
    [...keychain.values.keys()]
      .map((key) => key.split("\0")[0]!)
      .filter((service) => service.startsWith("rigyn-credentials-v2:") && !service.endsWith(":metadata-v2")),
  );
  assert.equal(credentialServices.size, 2);
});

test("Linux keychain namespaces join canonical aliases of one auth path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-canonical-alias-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const actualDirectory = join(root, "actual");
  const aliasDirectory = join(root, "alias");
  await mkdir(actualDirectory);
  await symlink(actualDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
  const keychain = memoryKeychain();
  const actual = await createDefaultCredentialStore(join(actualDirectory, "auth.json"), {
    platform: "linux",
    keychainAdapter: keychain.adapter,
  });
  const alias = await createDefaultCredentialStore(join(aliasDirectory, "auth.json"), {
    platform: "linux",
    keychainAdapter: keychain.adapter,
  });

  await actual.write("fixture", {
    kind: "api_key",
    provider: "fixture",
    apiKey: "shared-secret",
  });
  const credential = await alias.read("fixture");
  assert.equal(credential?.kind === "api_key" ? credential.apiKey : undefined, "shared-secret");
  const credentialServices = new Set(
    [...keychain.values.keys()]
      .map((key) => key.split("\0")[0]!)
      .filter((service) => service.startsWith("rigyn-credentials-v2:") && !service.endsWith(":metadata-v2")),
  );
  assert.equal(credentialServices.size, 1);
});

test("prepared purge preserves Keychain identity after a symlinked install is renamed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-purge-alias-tombstone-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const actualParent = join(root, "actual");
  const aliasParent = join(root, "alias");
  const actualInstall = join(actualParent, "rigyn-home");
  const tombstone = join(actualParent, "rigyn-home.uninstalling");
  await mkdir(actualInstall, { recursive: true });
  await symlink(actualParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
  const authPath = join(aliasParent, "rigyn-home", "auth.json");
  const stateAuthPath = join(aliasParent, "rigyn-home.uninstalling", "auth.json");
  const keychain = memoryKeychain();
  const store = await createDefaultCredentialStore(authPath, {
    platform: "darwin",
    keychainAdapter: keychain.adapter,
  });
  await store.write("fixture", { kind: "bearer", provider: "fixture", accessToken: "alias-purge-token" });
  await new CredentialProfileManager(store, "profiled").create("work", {
    kind: "api_key",
    provider: "profiled",
    apiKey: "alias-profile-secret",
  });
  assert.ok(keychain.values.size > 2);

  await rename(actualInstall, tombstone);
  const purge = await prepareDefaultCredentialStorePurge(authPath, {
    stateAuthPath,
    platform: "darwin",
    keychainAdapter: keychain.adapter,
    keychainLockPath: join(root, "credential-purge.lock"),
  });
  await rm(tombstone, { recursive: true, force: true });
  await purge();

  assert.equal(keychain.values.size, 0);
  await assert.rejects(stat(actualInstall), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await assert.rejects(stat(tombstone), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("a pinned Linux backend fails closed when Secret Service becomes unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-pinned-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  const keychain = memoryKeychain();
  await createDefaultCredentialStore(authPath, {
    platform: "linux",
    keychainAdapter: keychain.adapter,
  });

  await assert.rejects(
    createDefaultCredentialStore(authPath, {
      platform: "linux",
      keychainAdapter: {
        async get() { throw new Error("service unavailable"); },
        async set() { throw new Error("service unavailable"); },
        async delete() { throw new Error("service unavailable"); },
      },
    }),
    /Pinned Linux Secret Service credential backend is unavailable/u,
  );
  await assert.rejects(stat(authPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("plaintext migration refuses to overwrite a different strong-backend credential", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-conflict-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  const keychain = memoryKeychain();
  const strong = await createDefaultCredentialStore(authPath, {
    platform: "linux",
    keychainAdapter: keychain.adapter,
  });
  await strong.write("fixture", { kind: "api_key", provider: "fixture", apiKey: "strong-secret" });
  await AuthStorage.create(authPath).write("fixture", {
    kind: "api_key",
    provider: "fixture",
    apiKey: "plaintext-secret",
  });

  await assert.rejects(
    createDefaultCredentialStore(authPath, {
      platform: "linux",
      keychainAdapter: keychain.adapter,
    }),
    /Credential migration conflict for fixture/u,
  );
  assert.match(await readFile(authPath, "utf8"), /plaintext-secret/u);
  const strongCredential = await strong.read("fixture");
  assert.equal(strongCredential?.kind === "api_key" ? strongCredential.apiKey : undefined, "strong-secret");
});

test("async stored-credential reads follow the pinned backend while the sync API stays file-only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-async-read-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  const keychain = memoryKeychain();
  const store = await createDefaultCredentialStore(authPath, {
    platform: "linux",
    keychainAdapter: keychain.adapter,
  });
  const profiles = new CredentialProfileManager(store, "fixture");
  await profiles.create("work", { kind: "api_key", provider: "fixture", apiKey: "work-secret" });
  await profiles.create("personal", { kind: "api_key", provider: "fixture", apiKey: "async-secret" });
  await profiles.select("personal");

  assert.equal(readStoredCredential("fixture", authPath), undefined);
  assert.deepEqual(await readStoredCredentialAsync("fixture", authPath, {
    platform: "linux",
    keychainAdapter: keychain.adapter,
  }), {
    kind: "api_key",
    provider: "fixture",
    apiKey: "async-secret",
  });
});

test("Windows refuses to replace a missing key when encrypted ciphertext exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-orphaned-encrypted-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  await writeFile(`${authPath}.enc`, "{}\n", "utf8");
  let protectedKeys = 0;

  await assert.rejects(
    createDefaultCredentialStore(authPath, {
      platform: "win32",
      createLocalKey: true,
      windowsKeyProtector: {
        async protect(key) {
          protectedKeys += 1;
          return await windowsProtector.protect(key);
        },
        unprotect: windowsProtector.unprotect,
      },
    }),
    /Encrypted credential store exists without its protected key/u,
  );
  assert.equal(protectedKeys, 0);
  await assert.rejects(stat(`${authPath}.key`), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("Windows refuses to replace a missing key for a pinned encrypted backend", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-default-pinned-key-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  await writeFile(`${authPath}.backend`, JSON.stringify({
    version: 1,
    backend: "windows-dpapi-file-v1",
  }), "utf8");
  let protectedKeys = 0;

  await assert.rejects(
    createDefaultCredentialStore(authPath, {
      platform: "win32",
      createLocalKey: true,
      windowsKeyProtector: {
        async protect(key) {
          protectedKeys += 1;
          return await windowsProtector.protect(key);
        },
        unprotect: windowsProtector.unprotect,
      },
    }),
    /Pinned Windows credential backend is missing its protected key/u,
  );
  assert.equal(protectedKeys, 0);
  await assert.rejects(stat(`${authPath}.key`), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});
