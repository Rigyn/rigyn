import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EncryptedFileCredentialStore } from "../../src/auth/file-store.js";
import { CredentialProfileManager } from "../../src/auth/profiles.js";
import type { OAuthCredential } from "../../src/auth/types.js";
import { ProviderCredentialStoreAdapter } from "../../src/providers/auth-store-adapter.js";
import { providerFromAdapter, providerModelToInfo } from "../../src/providers/internal-runtime-bridge.js";
import { FileProviderModelsStore } from "../../src/providers/models-store.js";
import {
  InMemoryProviderCredentialStore,
  createModels,
  createProvider,
  type ProviderModel,
} from "../../src/providers/models.js";

function model(provider: string, id: string): ProviderModel {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider,
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
  };
}

function oauth(accountId: string, subject: string, accessToken: string, refreshToken: string): OAuthCredential {
  return {
    kind: "oauth",
    provider: "profiled",
    accessToken,
    refreshToken,
    expiresAt: Date.now() + 60 * 60_000,
    tokenType: "Bearer",
    scopes: [],
    accountId,
    subject,
  };
}

function expectedScope(providerId: string, profileScope: string, accountId: string, subject: string): string {
  const hash = createHash("sha256");
  const add = (value: string): void => {
    hash.update(`${Buffer.byteLength(value, "utf8")}:`);
    hash.update(value);
  };
  for (const value of [
    "rigyn-provider-model-cache-v1",
    providerId,
    "profile",
    profileScope,
    "oauth",
    "accountId",
    accountId,
    "subject",
    subject,
  ]) add(value);
  return `credential-v1:${hash.digest("hex")}`;
}

test("dynamic model caches follow the selected OAuth identity without storing secrets", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-model-cache-scope-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const authStore = new EncryptedFileCredentialStore({
    path: join(directory, "credentials.enc"),
    key: randomBytes(32),
  });
  const cachePath = join(directory, "models.json");
  const cache = new FileProviderModelsStore(cachePath);
  const profiles = new CredentialProfileManager(authStore, "profiled");
  const secrets = {
    aAccess: "account-a-access-secret",
    aRefresh: "account-a-refresh-secret",
    bAccess: "account-b-access-secret",
    bRefresh: "account-b-refresh-secret",
    cAccess: "account-c-access-secret",
    cRefresh: "account-c-refresh-secret",
    apiKey: "api-key-secret-without-safe-identity",
    rotatedApiKey: "rotated-api-key-secret",
  };
  await profiles.create("account-a", oauth("account-a", "subject-a", secrets.aAccess, secrets.aRefresh));
  await profiles.create("account-b", oauth("account-b", "subject-b", secrets.bAccess, secrets.bRefresh));

  const models = createModels({
    credentials: new ProviderCredentialStoreAdapter(authStore),
    modelsStore: cache,
  });
  models.setProvider(createProvider({
    id: "profiled",
    auth: {
      oauth: {
        name: "OAuth",
        async login() { throw new Error("unused"); },
        async refresh(credential) { return credential; },
        async toAuth(credential) { return { apiKey: credential.access }; },
      },
    },
    models: [model("profiled", "baseline")],
    async fetchModels({ credential }) {
      assert.equal(credential?.type, "oauth");
      return [model("profiled", `${String(credential?.accountId)}-model`)];
    },
    api: { async *stream() {} },
  }));

  const accountAStorage = (await profiles.active()).storageId;
  assert.notEqual(accountAStorage, undefined);
  assert.equal((await models.refresh()).errors.size, 0);
  assert.notEqual(models.getModel("profiled", "account-a-model"), undefined);
  const accountAEntry = await cache.read("profiled");
  assert.equal(accountAEntry?.cacheScope, expectedScope("profiled", accountAStorage!, "account-a", "subject-a"));
  const accountARaw = await readFile(cachePath, "utf8");
  for (const secret of Object.values(secrets)) assert.equal(accountARaw.includes(secret), false);

  await profiles.select("account-b");
  assert.equal((await models.refresh({ allowNetwork: false })).errors.size, 0);
  assert.deepEqual(models.getModels("profiled").map((entry) => entry.id), ["baseline"]);
  assert.equal(await cache.read("profiled"), undefined);

  assert.equal((await models.refresh()).errors.size, 0);
  assert.notEqual(models.getModel("profiled", "account-b-model"), undefined);
  const accountBScope = (await cache.read("profiled"))?.cacheScope;
  assert.notEqual(accountBScope, accountAEntry?.cacheScope);

  await profiles.update("account-b", oauth("account-c", "subject-c", secrets.cAccess, secrets.cRefresh));
  assert.equal((await models.refresh({ allowNetwork: false })).errors.size, 0);
  assert.deepEqual(models.getModels("profiled").map((entry) => entry.id), ["baseline"]);
  assert.equal(await cache.read("profiled"), undefined);
  assert.equal((await models.refresh()).errors.size, 0);
  assert.notEqual(models.getModel("profiled", "account-c-model"), undefined);

  await models.logout("profiled");
  assert.equal(await cache.read("profiled"), undefined);

  const apiCredentials = new InMemoryProviderCredentialStore();
  await apiCredentials.modify("keyed", async () => ({ type: "api_key", key: secrets.apiKey }));
  const keyed = createModels({ credentials: apiCredentials, modelsStore: cache });
  keyed.setProvider(createProvider({
    id: "keyed",
    auth: {
      apiKey: {
        name: "API key",
        async resolve({ credential }) {
          return credential?.key === undefined ? undefined : { auth: { apiKey: credential.key } };
        },
      },
    },
    models: [],
    async fetchModels() { return [model("keyed", "fetched")]; },
    api: { async *stream() {} },
  }));
  assert.equal((await keyed.refresh()).errors.size, 0);
  assert.notEqual(keyed.getModel("keyed", "fetched"), undefined);
  const keyedScope = (await cache.read("keyed"))?.cacheScope;
  assert.notEqual(keyedScope, undefined);
  await apiCredentials.modify("keyed", async () => ({ type: "api_key", key: secrets.rotatedApiKey }));
  assert.equal((await keyed.refresh({ allowNetwork: false })).errors.size, 0);
  assert.equal(keyed.getModel("keyed", "fetched"), undefined);
  assert.equal(await cache.read("keyed"), undefined);
  assert.equal((await keyed.refresh()).errors.size, 0);
  assert.notEqual((await cache.read("keyed"))?.cacheScope, keyedScope);
  const finalRaw = await readFile(cachePath, "utf8");
  for (const secret of Object.values(secrets)) {
    assert.equal(finalRaw.includes(secret), false);
    assert.equal(finalRaw.includes(createHash("sha256").update(secret).digest("hex")), false);
  }
});

test("adapter-backed models restore their baseline when a scoped cache disappears", async () => {
  const baseline = model("bridged", "baseline");
  const cached = model("bridged", "cached");
  const bridged = providerFromAdapter({
    id: "bridged",
    async *stream() {},
    async listModels() { return []; },
  }, {
    auth: {},
    initialModels: [providerModelToInfo(baseline)],
  });
  await bridged.refreshModels!({
    allowNetwork: false,
    store: {
      async read() { return { models: [cached] }; },
      async write() {},
      async delete() {},
    },
  });
  assert.deepEqual(bridged.getModels().map((entry) => entry.id), ["cached"]);

  await bridged.refreshModels!({
    allowNetwork: false,
    store: {
      async read() { return undefined; },
      async write() {},
      async delete() {},
    },
  });
  assert.deepEqual(bridged.getModels().map((entry) => entry.id), ["baseline"]);

  await assert.rejects(bridged.refreshModels!({
    allowNetwork: false,
    store: {
      async read() { throw new Error("cache unavailable"); },
      async write() {},
      async delete() {},
    },
  }), /cache unavailable/u);
  assert.deepEqual(bridged.getModels().map((entry) => entry.id), ["baseline"]);
});

test("identity-less OAuth caches use an opaque token scope and invalidate on rotation", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-token-model-cache-scope-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const cachePath = join(directory, "models.json");
  const cache = new FileProviderModelsStore(cachePath);
  const credentials = new InMemoryProviderCredentialStore();
  const access = "identityless-access-secret";
  const refresh = "identityless-refresh-secret";
  const rotatedRefresh = "identityless-rotated-refresh-secret";
  const credential = (refreshToken: string) => ({
    type: "oauth" as const,
    access,
    refresh: refreshToken,
    expires: Date.now() + 60 * 60_000,
  });
  await credentials.modify("identityless", async () => credential(refresh));
  const dynamic = () => createProvider({
    id: "identityless",
    auth: {
      oauth: {
        name: "OAuth",
        async login() { return credential(refresh); },
        async refresh(current) { return current; },
        async toAuth(current) { return { apiKey: current.access }; },
      },
    },
    models: [],
    async fetchModels() { return [model("identityless", "fetched")]; },
    api: { async *stream() {} },
  });
  const online = createModels({ credentials, modelsStore: cache });
  online.setProvider(dynamic());
  assert.equal((await online.refresh()).errors.size, 0);
  const initialScope = (await cache.read("identityless"))?.cacheScope;
  assert.notEqual(initialScope, undefined);
  const raw = await readFile(cachePath, "utf8");
  assert.equal(raw.includes(access), false);
  assert.equal(raw.includes(refresh), false);

  const offline = createModels({ credentials, modelsStore: cache });
  offline.setProvider(dynamic());
  assert.equal((await offline.refresh({ allowNetwork: false })).errors.size, 0);
  assert.notEqual(offline.getModel("identityless", "fetched"), undefined);

  await credentials.modify("identityless", async () => credential(rotatedRefresh));
  assert.equal((await offline.refresh({ allowNetwork: false })).errors.size, 0);
  assert.equal(offline.getModel("identityless", "fetched"), undefined);
  assert.equal(await cache.read("identityless"), undefined);
  assert.equal((await offline.refresh()).errors.size, 0);
  assert.notEqual((await cache.read("identityless"))?.cacheScope, initialScope);
  assert.equal((await readFile(cachePath, "utf8")).includes(rotatedRefresh), false);

  await credentials.delete("identityless");
  assert.equal((await offline.refresh({ allowNetwork: false })).errors.size, 0);
  assert.equal(offline.getModel("identityless", "fetched"), undefined);
  assert.equal(await cache.read("identityless"), undefined);
});
