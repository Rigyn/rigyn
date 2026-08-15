import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { describeAmbientIdentity } from "../../src/auth/ambient.js";
import {
  CrossProcessFileLock,
} from "../../src/auth/file-store.js";
import {
  CredentialBroker,
  EnvironmentCredentialSource,
  ExplicitCredentialSource,
} from "../../src/auth/broker.js";
import {
  KeychainCredentialStore,
  PlatformKeychainAdapter,
  probePlatformKeychain,
  type KeychainAdapter,
  type KeychainCommandRunner,
} from "../../src/auth/keychain.js";
import { retainMacosKeychainHelper } from "../../src/auth/macos-keychain-helper.js";
import { CredentialProfileManager } from "../../src/auth/profiles.js";
import {
  createOpenRouterAuthorization,
  exchangeOpenRouterCode,
} from "../../src/auth/openrouter.js";
import { verifyS256Challenge } from "../../src/auth/pkce.js";
import { ProviderCredentialStoreAdapter } from "../../src/providers/auth-store-adapter.js";

test("credential broker honors explicit precedence over environment", async () => {
  const explicit = new ExplicitCredentialSource(
    new Map([
      ["openai", { kind: "api_key" as const, provider: "openai", apiKey: "explicit-key" }],
    ]),
  );
  const environment = new EnvironmentCredentialSource({
    environment: { OPENAI_API_KEY: "environment-key" },
  });
  const resolved = await new CredentialBroker([explicit, environment]).resolve({ provider: "openai" });
  assert.equal(resolved?.source, "explicit");
  assert.equal(resolved?.credential.kind === "api_key" ? resolved.credential.apiKey : undefined, "explicit-key");
});

test("built-in compatible providers resolve their documented environment credentials", async () => {
  const variables = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    "github-copilot": "COPILOT_GITHUB_TOKEN",
    google: "GEMINI_API_KEY",
    gemini: "GEMINI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    ollama: "OLLAMA_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    "kimi-code": "KIMI_CODE_API_KEY",
    xai: "XAI_API_KEY",
    opencode: "OPENCODE_API_KEY",
    "opencode-go": "OPENCODE_GO_API_KEY",
  } as const;
  const environment = Object.fromEntries(Object.values(variables).map((variable) => [variable, `fixture-${variable}`]));
  const source = new EnvironmentCredentialSource({ environment });
  for (const [provider, variable] of Object.entries(variables)) {
    const credential = await source.resolve({ provider });
    assert.equal(credential?.kind, "api_key");
    assert.equal(credential?.kind === "api_key" ? credential.apiKey : undefined, `fixture-${variable}`);
  }
});

test("OpenCode Go prefers its own key and only falls back to the official shared environment variable", async () => {
  const distinct = new EnvironmentCredentialSource({
    environment: {
      OPENCODE_GO_API_KEY: "go-key",
      OPENCODE_API_KEY: "zen-key",
    },
  });
  assert.deepEqual(await distinct.resolve({ provider: "opencode-go" }), {
    kind: "api_key",
    provider: "opencode-go",
    apiKey: "go-key",
  });
  assert.deepEqual(await distinct.resolve({ provider: "opencode" }), {
    kind: "api_key",
    provider: "opencode",
    apiKey: "zen-key",
  });

  assert.deepEqual(await new EnvironmentCredentialSource({
    environment: { OPENCODE_API_KEY: "shared-key" },
  }).resolve({ provider: "opencode-go" }), {
    kind: "api_key",
    provider: "opencode-go",
    apiKey: "shared-key",
  });
});

test("Anthropic distinguishes bearer-token and API-key environment credentials", async () => {
  const bearer = await new EnvironmentCredentialSource({
    environment: {
      ANTHROPIC_AUTH_TOKEN: "bearer-token",
      ANTHROPIC_API_KEY: "api-key",
    },
  }).resolve({ provider: "anthropic" });
  assert.deepEqual(bearer, {
    kind: "bearer",
    provider: "anthropic",
    accessToken: "bearer-token",
  });

  const oauth = await new EnvironmentCredentialSource({
    environment: { ANTHROPIC_OAUTH_TOKEN: "oauth-token" },
  }).resolve({ provider: "anthropic" });
  assert.deepEqual(oauth, {
    kind: "bearer",
    provider: "anthropic",
    accessToken: "oauth-token",
  });

  const apiKey = await new EnvironmentCredentialSource({
    environment: { ANTHROPIC_API_KEY: "api-key" },
  }).resolve({ provider: "anthropic" });
  assert.deepEqual(apiKey, {
    kind: "api_key",
    provider: "anthropic",
    apiKey: "api-key",
  });
});

test("ambient descriptors expose only presence hints", () => {
  const aws = describeAmbientIdentity("aws", {
    AWS_ACCESS_KEY_ID: "AKIASECRET",
    AWS_SECRET_ACCESS_KEY: "very-secret",
  });
  assert.equal(aws.hints.staticEnvironmentCredentialsConfigured, true);
  assert.doesNotMatch(JSON.stringify(aws), /AKIASECRET|very-secret/);
});

test("OpenRouter flow uses the documented S256 key exchange", async () => {
  const authorization = createOpenRouterAuthorization("http://127.0.0.1:54321/callback");
  const challenge = authorization.authorizationUrl.searchParams.get("code_challenge");
  assert.ok(challenge !== null);
  assert.equal(verifyS256Challenge(authorization.verifier, challenge), true);
  assert.equal(authorization.authorizationUrl.searchParams.get("code_challenge_method"), "S256");

  let requestBody = "";
  const key = await exchangeOpenRouterCode({
    code: "authorization-code",
    verifier: authorization.verifier,
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body);
      return new Response(JSON.stringify({ key: "openrouter-user-key" }), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(key, "openrouter-user-key");
  assert.match(requestBody, /"code_challenge_method":"S256"/);
  assert.doesNotMatch(authorization.authorizationUrl.toString(), /client_id|client_secret/);
});

test("macOS Keychain helper keeps every request value out of argv and environment", async () => {
  const helperPath = resolve(tmpdir(), "rigyn-keychain-helper");
  const calls: Parameters<KeychainCommandRunner>[0][] = [];
  const runner: KeychainCommandRunner = async (options) => {
    calls.push(options);
    const request = JSON.parse(options.input ?? "") as { operation: string; secret?: string };
    if (request.operation === "get") {
      return { exitCode: 0, stdout: '{"version":1,"status":"ok","secret":"keychain-secret"}\n', stderr: "" };
    }
    if (request.operation === "delete") {
      return { exitCode: 0, stdout: '{"version":1,"status":"not_found"}\n', stderr: "" };
    }
    return { exitCode: 0, stdout: '{"version":1,"status":"ok"}\n', stderr: "" };
  };
  const keychain = new PlatformKeychainAdapter({
    platform: "darwin",
    runner,
    macosHelperPath: helperPath,
  });

  await keychain.set("rigyn-service", "rigyn-account", "keychain-secret");
  assert.equal(await keychain.get("rigyn-service", "rigyn-account"), "keychain-secret");
  await keychain.delete("rigyn-service", "rigyn-account");

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.command, helperPath);
    assert.deepEqual(call.args, []);
    assert.equal(call.maxOutputBytes, 1024 * 1024);
    assert.doesNotMatch(
      JSON.stringify({ command: call.command, args: call.args, environment: call.environment }),
      /rigyn-service|rigyn-account|keychain-secret/u,
    );
  }
  assert.deepEqual(JSON.parse(calls[0]!.input!), {
    version: 1,
    operation: "set",
    service: "rigyn-service",
    account: "rigyn-account",
    secret: "keychain-secret",
  });
  assert.deepEqual(JSON.parse(calls[1]!.input!), {
    version: 1,
    operation: "get",
    service: "rigyn-service",
    account: "rigyn-account",
  });
  assert.deepEqual(JSON.parse(calls[2]!.input!), {
    version: 1,
    operation: "delete",
    service: "rigyn-service",
    account: "rigyn-account",
  });
});

test("macOS Keychain helper rejects malformed or operation-mismatched success responses", async () => {
  const responses = [
    '{"version":1,"status":"ok"}\n',
    '{"version":1,"status":"ok","secret":"unexpected"}\n',
    '{"version":1,"status":"not_found"}\n',
  ];
  const keychain = new PlatformKeychainAdapter({
    platform: "darwin",
    macosHelperPath: resolve(tmpdir(), "rigyn-keychain-helper"),
    runner: async () => ({ exitCode: 0, stdout: responses.shift()!, stderr: "" }),
  });

  await assert.rejects(keychain.get("rigyn", "user"), /invalid response/u);
  await assert.rejects(keychain.delete("rigyn", "user"), /invalid response/u);
  await assert.rejects(keychain.set("rigyn", "user", "secret"), /invalid response/u);
});

test("retained macOS Keychain helper survives install removal and stays private", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-keychain-retain-test-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const original = join(root, "rigyn-keychain-helper");
  await writeFile(original, "fixture-helper", { mode: 0o755 });

  const retained = await retainMacosKeychainHelper(original);
  t.after(async () => await retained.release());
  assert.notEqual(retained.path, original);
  assert.equal(await readFile(retained.path, "utf8"), "fixture-helper");
  if (process.platform !== "win32") {
    assert.equal((await stat(dirname(retained.path))).mode & 0o777, 0o700);
    assert.equal((await stat(retained.path)).mode & 0o777, 0o700);
    const linked = join(root, "linked-helper");
    await symlink(original, linked);
    await assert.rejects(retainMacosKeychainHelper(linked), /bounded regular file/u);
  }

  await rm(original);
  assert.equal(await readFile(retained.path, "utf8"), "fixture-helper");
  await retained.release();
  await assert.rejects(stat(retained.path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("Linux keychain preserves the user session environment and treats a missing item as absent", async () => {
  const dynamicLibraryInjectionVariable = ["LD", "PRE", "LOAD"].join("_");
  const calls: Parameters<KeychainCommandRunner>[0][] = [];
  const runner: KeychainCommandRunner = async (options) => {
    calls.push(options);
    return { exitCode: 1, stdout: "", stderr: "" };
  };
  const keychain = new PlatformKeychainAdapter({
    platform: "linux",
    runner,
    environment: {
      HOME: "/home/example",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      XDG_RUNTIME_DIR: "/run/user/1000",
      [dynamicLibraryInjectionVariable]: "/untrusted.so",
    },
  });
  assert.equal(await keychain.get("rigyn", "missing"), undefined);
  assert.equal(calls[0]?.environment?.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
  assert.equal(calls[0]?.environment?.XDG_RUNTIME_DIR, "/run/user/1000");
  assert.equal(calls[0]?.environment?.[dynamicLibraryInjectionVariable], undefined);

  const unavailable = new PlatformKeychainAdapter({
    platform: "linux",
    runner: async () => ({ exitCode: 1, stdout: "", stderr: "Secret Service is unavailable" }),
  });
  await assert.rejects(unavailable.get("rigyn", "missing"), /Secret Service is unavailable/u);
});

test("platform keychain probing rejects an unavailable desktop service", async () => {
  const unavailable: KeychainAdapter = {
    async get() { throw new Error("Secret Service is unavailable"); },
    async set() { throw new Error("unused"); },
    async delete() { throw new Error("unused"); },
  };
  assert.equal(await probePlatformKeychain(unavailable), false);
});

test("Linux keychain delete is idempotent for a missing item but preserves service errors", async () => {
  const missing = new PlatformKeychainAdapter({
    platform: "linux",
    runner: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
  });
  await missing.delete("rigyn", "missing");

  const unavailable = new PlatformKeychainAdapter({
    platform: "linux",
    runner: async () => ({ exitCode: 1, stdout: "", stderr: "Secret Service is unavailable" }),
  });
  await assert.rejects(unavailable.delete("rigyn", "missing"), /Secret Service is unavailable/u);
});

test("keychain credential store persists typed credentials", async () => {
  const values = new Map<string, string>();
  const adapter: KeychainAdapter = {
    get: async (service, account) => values.get(`${service}:${account}`),
    set: async (service, account, secret) => {
      values.set(`${service}:${account}`, secret);
    },
    delete: async (service, account) => {
      values.delete(`${service}:${account}`);
    },
  };
  const store = new KeychainCredentialStore({ adapter, service: `test-${process.pid}-${Date.now()}` });
  await store.write("openai", { kind: "api_key", provider: "openai", apiKey: "stored-key" });
  assert.deepEqual(await store.read("openai"), {
    kind: "api_key",
    provider: "openai",
    apiKey: "stored-key",
  });
  await store.delete("openai");
  assert.equal(await store.read("openai"), undefined);
});

test("keychain credential store supports secret-free listing and atomic modification", async () => {
  const values = new Map<string, string>();
  const key = (service: string, account: string) => `${service}\0${account}`;
  const store = new KeychainCredentialStore({
    service: "fixture-index",
    adapter: {
      async get(service, account) { return values.get(key(service, account)); },
      async set(service, account, secret) { values.set(key(service, account), secret); },
      async delete(service, account) { values.delete(key(service, account)); },
    },
  });
  await store.modify("fixture", async () => ({
    kind: "api_key",
    provider: "fixture",
    apiKey: "indexed-secret",
  }));
  assert.deepEqual(await store.list(), [{ providerId: "fixture", type: "api_key" }]);
  assert.doesNotMatch(JSON.stringify(await store.list()), /indexed-secret/u);
  assert.equal((await store.modify("fixture", async () => undefined))?.kind, "api_key");
  await store.delete("fixture");
  assert.deepEqual(await store.list(), []);
});

test("keychain metadata accounts are disjoint from credential ids", async () => {
  const values = new Map<string, string>();
  const key = (service: string, account: string) => `${service}\0${account}`;
  const store = new KeychainCredentialStore({
    service: "fixture-disjoint-index",
    adapter: {
      async get(service, account) { return values.get(key(service, account)); },
      async set(service, account, secret) { values.set(key(service, account), secret); },
      async delete(service, account) { values.delete(key(service, account)); },
    },
  });
  await store.write("credential-index-v2", {
    kind: "api_key",
    provider: "credential-index-v2",
    apiKey: "disjoint-secret",
  });

  assert.equal((await store.read("credential-index-v2"))?.kind, "api_key");
  assert.deepEqual(await store.list(), [{ providerId: "credential-index-v2", type: "api_key" }]);
});

test("keychain listing recovers interrupted credential writes and deletes", async () => {
  const values = new Map<string, string>();
  const key = (service: string, account: string) => `${service}\0${account}`;
  let indexWrites = 0;
  let failIndexWrite = 2;
  const store = new KeychainCredentialStore({
    service: "fixture-index-recovery",
    adapter: {
      async get(service, account) { return values.get(key(service, account)); },
      async set(service, account, secret) {
        if (service.endsWith(":metadata-v2") && account === "credential-index-v2") {
          indexWrites += 1;
          if (indexWrites === failIndexWrite) throw new Error("injected index interruption");
        }
        values.set(key(service, account), secret);
      },
      async delete(service, account) { values.delete(key(service, account)); },
    },
  });

  await assert.rejects(
    store.write("fixture", { kind: "api_key", provider: "fixture", apiKey: "recoverable-secret" }),
    /injected index interruption/u,
  );
  assert.equal((await store.read("fixture"))?.kind, "api_key");
  assert.deepEqual(await store.list(), [{ providerId: "fixture", type: "api_key" }]);

  failIndexWrite = indexWrites + 2;
  await assert.rejects(store.delete("fixture"), /injected index interruption/u);
  assert.equal(await store.read("fixture"), undefined);
  assert.deepEqual(await store.list(), []);
});

test("keychain listing recovers when an adapter reports failure after storing a credential", async () => {
  const values = new Map<string, string>();
  const key = (service: string, account: string) => `${service}\0${account}`;
  const service = "fixture-ambiguous-write";
  let interruptCredentialWrite = true;
  const store = new KeychainCredentialStore({
    service,
    adapter: {
      async get(selectedService, account) { return values.get(key(selectedService, account)); },
      async set(selectedService, account, secret) {
        values.set(key(selectedService, account), secret);
        if (
          interruptCredentialWrite
          && selectedService === service
          && account.startsWith("credential-v2:")
        ) {
          interruptCredentialWrite = false;
          throw new Error("injected post-write interruption");
        }
      },
      async delete(selectedService, account) { values.delete(key(selectedService, account)); },
    },
  });

  await assert.rejects(
    store.write("fixture", { kind: "api_key", provider: "fixture", apiKey: "stored-before-error" }),
    /injected post-write interruption/u,
  );
  assert.deepEqual(await store.list(), [{ providerId: "fixture", type: "api_key" }]);
  const credential = await store.read("fixture");
  assert.equal(credential?.kind === "api_key" ? credential.apiKey : undefined, "stored-before-error");
});

test("keychain writes safely upgrade and later delete legacy raw-account credentials", async () => {
  const values = new Map<string, string>();
  const key = (service: string, account: string) => `${service}\0${account}`;
  const service = "fixture-legacy-upgrade";
  values.set(key(service, "fixture"), JSON.stringify({
    kind: "api_key",
    provider: "fixture",
    apiKey: "legacy-secret",
  }));
  let interruptCredentialWrite = true;
  const store = new KeychainCredentialStore({
    service,
    adapter: {
      async get(selectedService, account) { return values.get(key(selectedService, account)); },
      async set(selectedService, account, secret) {
        if (
          interruptCredentialWrite
          && selectedService === service
          && account.startsWith("credential-v2:")
        ) {
          interruptCredentialWrite = false;
          throw new Error("injected pre-write interruption");
        }
        values.set(key(selectedService, account), secret);
      },
      async delete(selectedService, account) { values.delete(key(selectedService, account)); },
    },
  });

  await assert.rejects(
    store.write("fixture", { kind: "api_key", provider: "fixture", apiKey: "replacement-secret" }),
    /injected pre-write interruption/u,
  );
  assert.deepEqual(await store.list(), [{ providerId: "fixture", type: "api_key" }]);
  const legacy = await store.read("fixture");
  assert.equal(legacy?.kind === "api_key" ? legacy.apiKey : undefined, "legacy-secret");

  await store.write("fixture", {
    kind: "api_key",
    provider: "fixture",
    apiKey: "replacement-secret",
  });
  assert.equal(values.has(key(service, "fixture")), false);
  await store.delete("fixture");
  assert.equal(await store.read("fixture"), undefined);
});

test("keychain listing reports canonical providers instead of profile storage ids", async () => {
  const values = new Map<string, string>();
  const key = (service: string, account: string) => `${service}\0${account}`;
  const store = new KeychainCredentialStore({
    service: "fixture-profile-list",
    adapter: {
      async get(service, account) { return values.get(key(service, account)); },
      async set(service, account, secret) { values.set(key(service, account), secret); },
      async delete(service, account) { values.delete(key(service, account)); },
    },
  });
  const profiles = new CredentialProfileManager(store, "fixture");
  await profiles.create("work", {
    kind: "api_key",
    provider: "fixture",
    apiKey: "profile-secret",
  });

  assert.deepEqual(await store.list(), [{ providerId: "fixture", type: "api_key" }]);
  assert.deepEqual(await store.listCredentialProfileIds(), ["fixture"]);
  assert.doesNotMatch(JSON.stringify(await store.list()), /credential-profile-v1|profile-secret/u);
  const active = await profiles.active();
  assert.ok(active.storageId);
  await store.delete(active.storageId);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await store.listCredentialProfileIds(), ["fixture"]);
});

test("provider profile discovery does not make keychain registry reads contend with each other", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-keychain-profile-discovery-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new KeychainCredentialStore({
    service: "fixture-profile-discovery",
    lockPath: join(directory, "keychain.lock"),
    lock: { timeoutMs: 25, retryMs: 1 },
    adapter: {
      async get(service, account) {
        if (service.endsWith(":metadata-v2") && account === "credential-index-v2") {
          await new Promise<void>((resolveWait) => setTimeout(resolveWait, 75));
        }
        return undefined;
      },
      async set() {},
      async delete() {},
    },
  });

  assert.deepEqual(await new ProviderCredentialStoreAdapter(store).list(), []);
});

test("keychain profile metadata accepts operations that committed before an adapter error", async () => {
  const values = new Map<string, string>();
  const service = "fixture-profile-ambiguous";
  const metadataService = `${service}:metadata-v2`;
  const key = (selectedService: string, account: string) => `${selectedService}\0${account}`;
  let ambiguousRegistryAdd = true;
  let ambiguousProfileWrite = true;
  let ambiguousProfileDelete = false;
  let ambiguousRegistryDelete = false;
  const store = new KeychainCredentialStore({
    service,
    adapter: {
      async get(selectedService, account) { return values.get(key(selectedService, account)); },
      async set(selectedService, account, secret) {
        values.set(key(selectedService, account), secret);
        if (selectedService === metadataService && account === "credential-index-v2") {
          const profileIds = (JSON.parse(secret) as { profileIds?: unknown }).profileIds;
          if (ambiguousRegistryAdd && Array.isArray(profileIds) && profileIds.includes("fixture")) {
            ambiguousRegistryAdd = false;
            throw new Error("injected committed registry addition error");
          }
          if (ambiguousRegistryDelete && Array.isArray(profileIds) && profileIds.length === 0) {
            ambiguousRegistryDelete = false;
            throw new Error("injected committed registry deletion error");
          }
        }
        if (ambiguousProfileWrite && selectedService === metadataService && account.startsWith("profile-index-v1:")) {
          ambiguousProfileWrite = false;
          throw new Error("injected committed profile write error");
        }
      },
      async delete(selectedService, account) {
        values.delete(key(selectedService, account));
        if (ambiguousProfileDelete && selectedService === metadataService && account.startsWith("profile-index-v1:")) {
          ambiguousProfileDelete = false;
          throw new Error("injected committed profile deletion error");
        }
      },
    },
  });
  const profiles = new CredentialProfileManager(store, "fixture");

  await profiles.create("work", {
    kind: "api_key",
    provider: "fixture",
    apiKey: "profile-secret",
  });
  assert.equal((await profiles.active()).credential?.kind, "api_key");
  assert.deepEqual(await store.listCredentialProfileIds(), ["fixture"]);

  ambiguousProfileDelete = true;
  ambiguousRegistryDelete = true;
  assert.equal(await profiles.delete("work"), true);
  assert.deepEqual(await profiles.active(), { configured: false });
  assert.deepEqual(await store.listCredentialProfileIds(), []);
  assert.deepEqual(await store.list(), []);
});

test("keychain profile deletion restores metadata when registry removal fails", async () => {
  const values = new Map<string, string>();
  const service = "fixture-profile-delete-rollback";
  const metadataService = `${service}:metadata-v2`;
  const key = (selectedService: string, account: string) => `${selectedService}\0${account}`;
  let failRegistryRemoval = false;
  const store = new KeychainCredentialStore({
    service,
    adapter: {
      async get(selectedService, account) { return values.get(key(selectedService, account)); },
      async set(selectedService, account, secret) {
        if (failRegistryRemoval && selectedService === metadataService && account === "credential-index-v2") {
          const profileIds = (JSON.parse(secret) as { profileIds?: unknown }).profileIds;
          if (Array.isArray(profileIds) && profileIds.length === 0) {
            throw new Error("injected registry removal failure");
          }
        }
        values.set(key(selectedService, account), secret);
      },
      async delete(selectedService, account) { values.delete(key(selectedService, account)); },
    },
  });
  const profiles = new CredentialProfileManager(store, "fixture");
  await profiles.create("work", {
    kind: "api_key",
    provider: "fixture",
    apiKey: "profile-secret",
  });

  failRegistryRemoval = true;
  await assert.rejects(profiles.delete("work"), /injected registry removal failure/u);
  const active = await profiles.active();
  assert.equal(active.name, "work");
  assert.equal(active.credential?.kind === "api_key" ? active.credential.apiKey : undefined, "profile-secret");
  assert.deepEqual(await store.listCredentialProfileIds(), ["fixture"]);

  failRegistryRemoval = false;
  assert.equal(await profiles.delete("work"), true);
  assert.deepEqual(await store.listCredentialProfileIds(), []);
});

test("keychain writes detach caller data before waiting for the shared lock", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-keychain-snapshot-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const lockPath = join(directory, "keychain.lock");
  const values = new Map<string, string>();
  const adapter: KeychainAdapter = {
    get: async (service, account) => values.get(`${service}:${account}`),
    set: async (service, account, secret) => { values.set(`${service}:${account}`, secret); },
    delete: async (service, account) => { values.delete(`${service}:${account}`); },
  };
  const lock = new CrossProcessFileLock(lockPath, { timeoutMs: 2_000 });
  let release!: () => void;
  let acquired!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const holding = lock.run(async () => { acquired(); await gate; });
  await ready;

  const store = new KeychainCredentialStore({ adapter, service: "fixture", lockPath, lock: { timeoutMs: 2_000 } });
  const value = { kind: "api_key" as const, provider: "example", apiKey: "original-secret" };
  const writing = store.write("account", value);
  value.apiKey = "mutated-secret";
  release();
  await holding;
  await writing;
  const stored = await store.read("account");
  assert.equal(stored?.kind === "api_key" ? stored.apiKey : undefined, "original-secret");
});
