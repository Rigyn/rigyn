import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  createOpenRouterAuthorization,
  exchangeOpenRouterCode,
} from "../../src/auth/openrouter.js";
import { verifyS256Challenge } from "../../src/auth/pkce.js";

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
    groq: "GROQ_API_KEY",
    together: "TOGETHER_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    cerebras: "CEREBRAS_API_KEY",
    xai: "XAI_API_KEY",
    fireworks: "FIREWORKS_API_KEY",
    huggingface: "HF_TOKEN",
    "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
    zai: "ZAI_API_KEY",
    "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
    "ant-ling": "ANT_LING_API_KEY",
    nvidia: "NVIDIA_API_KEY",
    xiaomi: "MIMO_API_KEY",
    moonshotai: "MOONSHOT_API_KEY",
    "moonshotai-cn": "MOONSHOT_API_KEY",
    "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
    "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
    "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
    opencode: "OPENCODE_API_KEY",
    "opencode-go": "OPENCODE_API_KEY",
    "kimi-coding": "KIMI_API_KEY",
    minimax: "MINIMAX_API_KEY",
    "minimax-cn": "MINIMAX_CN_API_KEY",
    "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
    "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
  } as const;
  const environment = Object.fromEntries(Object.values(variables).map((variable) => [variable, `fixture-${variable}`]));
  const source = new EnvironmentCredentialSource({ environment });
  for (const [provider, variable] of Object.entries(variables)) {
    const credential = await source.resolve({ provider });
    assert.equal(credential?.kind, "api_key");
    assert.equal(credential?.kind === "api_key" ? credential.apiKey : undefined, `fixture-${variable}`);
  }
});

test("Xiaomi prefers the documented environment variable and preserves its legacy alias", async () => {
  const official = await new EnvironmentCredentialSource({
    environment: { MIMO_API_KEY: "official-key", XIAOMI_API_KEY: "legacy-key" },
  }).resolve({ provider: "xiaomi" });
  assert.equal(official?.kind === "api_key" ? official.apiKey : undefined, "official-key");

  const legacy = await new EnvironmentCredentialSource({
    environment: { XIAOMI_API_KEY: "legacy-key" },
  }).resolve({ provider: "xiaomi" });
  assert.equal(legacy?.kind === "api_key" ? legacy.apiKey : undefined, "legacy-key");
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

test("macOS keychain set keeps the secret out of argv", async () => {
  const calls: Parameters<KeychainCommandRunner>[0][] = [];
  const runner: KeychainCommandRunner = async (options) => {
    calls.push(options);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const keychain = new PlatformKeychainAdapter({ platform: "darwin", runner });
  await keychain.set("rigyn", "user", "keychain-secret");
  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(calls[0]?.args), /keychain-secret/);
  assert.equal(calls[0]?.input, "keychain-secret\n");
  assert.equal(calls[0]?.command, "/usr/bin/security");
});

test("Linux keychain preserves the user session environment and treats a missing item as absent", async () => {
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
      LD_PRELOAD: "/untrusted.so",
    },
  });
  assert.equal(await keychain.get("rigyn", "missing"), undefined);
  assert.equal(calls[0]?.environment?.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
  assert.equal(calls[0]?.environment?.XDG_RUNTIME_DIR, "/run/user/1000");
  assert.equal(calls[0]?.environment?.LD_PRELOAD, undefined);

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
