import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InMemoryCredentialStore,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Provider,
} from "@rigyn/models";

import { AuthStorage } from "../../src/auth/auth-storage.js";
import { EncryptedFileCredentialStore } from "../../src/auth/file-store.js";
import { OPENAI_CODEX_TOKEN_ENDPOINT } from "../../src/auth/openai-codex.js";
import { CredentialProfileManager } from "../../src/auth/profiles.js";
import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { ModelRegistry as InternalModelRegistry } from "../../src/providers/model-registry.js";
import { loadRuntimeModelConfiguration } from "../../src/providers/model-runtime-config.js";
import {
  createModels,
  defaultProviderAuthContext,
  InMemoryProviderCredentialStore,
  ProviderModelsError,
} from "../../src/providers/models.js";
import { ModelRegistry } from "../../src/providers/public-model-registry.js";
import { createAgentSession } from "../../src/sdk/index.js";
import { SessionManager } from "../../src/storage/session-manager.js";

const OPENAI_TEST_CLIENT_ID = "rigyn-openai-test-client";

function codexAccessToken(accountId: string, subject = "account-subject"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({ sub: subject, "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
    "fixture-signature",
  ].join(".");
}

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = () => done(); });
  return { promise, resolve };
}

function registerCommandCredentialProvider(runtime: ModelRuntime, providerId: string): void {
  runtime.registerProvider(providerId, {
    name: "Command credential fixture",
    baseUrl: "https://example.test/v1",
    apiKey: "configuration-fallback",
    api: "openai-completions",
    models: [{
      id: "model",
      name: "Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 1_024,
    }],
  });
}

async function configuredRuntime(context: test.TestContext): Promise<{
  directory: string;
  runtime: ModelRuntime;
}> {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-model-runtime-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const modelsPath = join(directory, "models.json");
  await writeFile(modelsPath, `{
    // SDK-local provider configuration.
    "providers": {
      "sdk-custom": {
        "name": "SDK custom",
        "baseUrl": "https://example.test/v1",
        "apiKey": "sdk-config-key",
        "api": "openai-completions",
        "models": [{ "id": "custom-model", "reasoning": true }]
      }
    }
  }\n`);
  return {
    directory,
    runtime: await ModelRuntime.create({
      credentials: AuthStorage.inMemory(),
      modelsPath,
      allowModelNetwork: false,
    }),
  };
}

test("ModelRuntime loads modelsPath and exposes public model protocols", async (context) => {
  const { runtime } = await configuredRuntime(context);
  const model = runtime.getModel("sdk-custom", "custom-model");
  assert.ok(model);
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, "https://example.test/v1");
  assert.equal(model.contextWindow, 128_000);
  assert.equal(model.maxTokens, 16_384);
  assert.equal(runtime.find("sdk-custom", "custom-model")?.api, "openai-completions");
  assert.equal(runtime.getError(), undefined);
  assert.deepEqual(runtime.getProviderAuthStatus("sdk-custom"), {
    configured: true,
    source: "models_json_key",
  });
});

test("ModelRuntime refresh updates provider configuration without applying it to caller-owned models", async (context) => {
  const { directory, runtime } = await configuredRuntime(context);
  const modelsPath = join(directory, "models.json");
  await writeFile(modelsPath, JSON.stringify({
    providers: {
      "sdk-refreshed": {
        baseUrl: "https://refreshed.example.test/v1",
        apiKey: "refreshed-key",
        api: "openai-completions",
        models: [{ id: "refreshed-model" }],
      },
    },
  }));
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getModel("sdk-custom", "custom-model"), undefined);
  assert.equal(runtime.getModel("sdk-refreshed", "refreshed-model")?.baseUrl, "https://refreshed.example.test/v1");

  const ownedModels = (await import("../../src/providers/models.js")).createModels();
  const callerOwned = await ModelRuntime.create({
    models: ownedModels,
    modelsPath,
    allowModelNetwork: false,
  });
  await callerOwned.refresh({ allowNetwork: false });
  assert.equal(callerOwned.getModel("sdk-refreshed", "refreshed-model"), undefined);
});

test("caller-owned model refresh failures are contained without reflection", async () => {
  const models = createModels();
  let traps = 0;
  const hostile = new Proxy({}, {
    get() { traps += 1; throw new Error("get trap executed"); },
    getPrototypeOf() { traps += 1; throw new Error("prototype trap executed"); },
  });
  let failure: unknown = new Error("catalog unavailable");
  models.refresh = async () => { throw failure; };
  const internal = new InternalModelRegistry(models);

  const ordinary = await internal.refresh();
  assert.equal(ordinary.errors.get("runtime"), failure);
  failure = hostile;
  const contained = await internal.refresh();
  const containedError = contained.errors.get("runtime");
  assert.ok(containedError instanceof Error);
  assert.equal(containedError.message, "[Thrown object]");

  const runtime = await ModelRuntime.create({ models, modelsPath: null, allowModelNetwork: false });
  assert.equal(runtime.getError(), "[Thrown object]");
  assert.equal(traps, 0);
});

test("ModelRuntime rejects invalid refresh timeouts before refreshing caller-owned models", async () => {
  for (const modelRefreshTimeoutMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    const models = createModels();
    let refreshes = 0;
    models.refresh = async () => {
      refreshes += 1;
      return { aborted: false, errors: new Map() };
    };
    await assert.rejects(
      ModelRuntime.create({
        models,
        modelsPath: null,
        allowModelNetwork: true,
        modelRefreshTimeoutMs,
      }),
      /modelRefreshTimeoutMs must be an integer from 0 to 2147483647/u,
    );
    assert.equal(refreshes, 0);
  }
});

test("ModelRuntime defaults never parse or replace the CLI-owned catalog", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-model-runtime-default-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const catalog = `${JSON.stringify({ version: 1, savedAt: "2026-07-22T00:00:00.000Z", providers: [] })}\n`;
  await writeFile(join(directory, "models.json"), catalog);
  await writeFile(join(directory, "model-providers.json"), JSON.stringify({
    providers: {
      "default-custom": {
        baseUrl: "https://example.test/v1",
        apiKey: "default-test-key",
        api: "openai-completions",
        models: [{ id: "default-model" }],
      },
    },
  }));
  const previousAgentDir = process.env.RIGYN_HOME;
  process.env.RIGYN_HOME = directory;
  try {
    const runtime = await ModelRuntime.create({
      credentials: AuthStorage.inMemory(),
      allowModelNetwork: false,
    });
    assert.equal(runtime.getModel("default-custom", "default-model")?.id, "default-model");
    assert.equal(runtime.getError(), undefined);
    assert.equal(await readFile(join(directory, "models.json"), "utf8"), catalog);
  } finally {
    if (previousAgentDir === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDir;
  }
});

test("runtime model configuration preflights regular files and the 8 MiB limit", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-model-runtime-bounds-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));

  const absent = await loadRuntimeModelConfiguration(join(directory, "absent.json"));
  assert.equal(absent.error, undefined);
  assert.equal(Object.hasOwn(absent, "error"), false);

  const nonFilePath = join(directory, "provider-directory");
  await mkdir(nonFilePath);
  const nonFile = await loadRuntimeModelConfiguration(nonFilePath);
  assert.match(nonFile.error ?? "", /model configuration is not a regular file/u);
  assert.equal(nonFile.providers.size, 0);

  const modelsPath = join(directory, "model-providers.json");
  const handle = await open(modelsPath, "w", 0o600);
  try {
    await handle.truncate(8 * 1024 * 1024 + 1);
  } finally {
    await handle.close();
  }
  const explicit = await loadRuntimeModelConfiguration(modelsPath);
  assert.match(explicit.error ?? "", /model configuration exceeds 8 MiB/u);
  assert.equal(explicit.providers.size, 0);

  const explicitRuntime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory(),
    modelsPath,
    allowModelNetwork: false,
  });
  try {
    assert.match(explicitRuntime.getError() ?? "", /model configuration exceeds 8 MiB/u);
  } finally {
    await explicitRuntime.close();
  }

  const previousAgentDir = process.env.RIGYN_HOME;
  process.env.RIGYN_HOME = directory;
  try {
    const runtime = await ModelRuntime.create({
      credentials: AuthStorage.inMemory(),
      allowModelNetwork: false,
    });
    try {
      assert.match(runtime.getError() ?? "", /model configuration exceeds 8 MiB/u);
    } finally {
      await runtime.close();
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDir;
  }
});

test("ModelRuntime treats only affirmative RIGYN_OFFLINE values as offline", async () => {
  const previous = process.env.RIGYN_OFFLINE;
  const createProbe = async (value: string): Promise<number> => {
    process.env.RIGYN_OFFLINE = value;
    let networkRefreshes = 0;
    const credentials = new InMemoryProviderCredentialStore();
    await credentials.modify("network-probe", async () => ({ type: "api_key", key: "probe-key" }));
    const models = createModels({ credentials });
    models.setProvider({
      id: "network-probe",
      name: "Network probe",
      auth: {
        apiKey: {
          name: "API key",
          async resolve({ credential }) {
            return credential?.type === "api_key" && credential.key !== undefined
              ? { auth: { apiKey: credential.key } }
              : undefined;
          },
        },
      },
      getModels: () => [],
      async refreshModels({ allowNetwork }) {
        if (allowNetwork) networkRefreshes += 1;
      },
      async *stream() {},
      async *streamSimple() {},
    });
    await ModelRuntime.create({ models, allowModelNetwork: true });
    return networkRefreshes;
  };
  try {
    assert.equal(await createProbe("0"), 1);
    assert.equal(await createProbe("1"), 0);
  } finally {
    if (previous === undefined) delete process.env.RIGYN_OFFLINE;
    else process.env.RIGYN_OFFLINE = previous;
  }
});

test("configured commands execute only for request auth and resolved values are redacted", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-model-command-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const modelsPath = join(directory, "providers.json");
  const marker = join(directory, "executed");
  const apiSecret = "resolved-provider-api-secret";
  const headerSecret = "resolved-provider-header-secret";
  const command = (secret: string) => {
    const source = `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x");process.stdout.write(${JSON.stringify(secret)})`;
    const encoded = Buffer.from(source, "utf8").toString("base64");
    return `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      `eval(Buffer.from("${encoded}", "base64").toString("utf8"))`,
    )}`;
  };
  await writeFile(modelsPath, JSON.stringify({
    providers: {
      commanded: {
        baseUrl: "https://example.test/v1",
        apiKey: command(apiSecret),
        headers: { "x-provider-secret": command(headerSecret) },
        api: "openai-completions",
        models: [{ id: "model" }],
      },
    },
  }));
  const runtime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory(),
    modelsPath,
    allowModelNetwork: false,
  });
  const executions = async () => await readFile(marker, "utf8").catch(() => "");
  assert.equal(await executions(), "");
  assert.deepEqual(runtime.getProviderAuthStatus("commanded"), {
    configured: true,
    source: "models_json_command",
  });
  assert.equal((await runtime.getAvailable("commanded")).length, 1);
  assert.equal(await executions(), "");

  const model = runtime.getModel("commanded", "model");
  assert.ok(model);
  assert.deepEqual(await runtime.getAuth(model), {
    auth: {
      apiKey: apiSecret,
      headers: { "x-provider-secret": headerSecret },
    },
    source: "configuration",
  });
  assert.equal((await executions()).length, 2);
  assert.doesNotMatch(defaultSecretRedactor.redact(`${apiSecret} ${headerSecret}`), new RegExp(`${apiSecret}|${headerSecret}`, "u"));

  await runtime.getAuth(model);
  assert.equal((await executions()).length, 4);
});

test("stored credential values use their durable environment and cache command keys", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-model-stored-values-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const modelsPath = join(directory, "providers.json");
  const marker = join(directory, "stored-command-executed");
  const environmentName = "RIGYN_STORED_SCOPED_VAR";
  const previous = process.env[environmentName];
  process.env[environmentName] = "ambient-value";
  context.after(() => {
    if (previous === undefined) delete process.env[environmentName];
    else process.env[environmentName] = previous;
  });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("stored-interpolation", async () => ({
    type: "api_key",
    key: `$${environmentName}`,
    env: { [environmentName]: "scoped-value" },
  }));
  await credentials.modify("openai", async () => ({
    type: "api_key",
    key: `$${environmentName}`,
    env: { [environmentName]: "inherited-provider-scoped-value" },
  }));
  const source = [
    `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x")`,
    `process.stdout.write(process.env.${environmentName} ?? "missing")`,
  ].join(";");
  const encoded = Buffer.from(source, "utf8").toString("base64");
  const command = `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    `eval(Buffer.from("${encoded}", "base64").toString("utf8"))`,
  )}`;
  await credentials.modify("stored-command", async () => ({
    type: "api_key",
    key: command,
    env: { [environmentName]: "command-scoped-value" },
  }));
  await writeFile(modelsPath, JSON.stringify({
    providers: {
      "stored-interpolation": {
        baseUrl: "https://example.test/v1",
        apiKey: "configuration-fallback",
        api: "openai-completions",
        models: [{ id: "model" }],
      },
      "stored-command": {
        baseUrl: "https://example.test/v1",
        apiKey: "configuration-fallback",
        api: "openai-completions",
        models: [{ id: "model" }],
      },
      openai: {
        apiKey: "configuration-fallback",
      },
    },
  }));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath,
    allowModelNetwork: false,
  });
  const executions = async () => await readFile(marker, "utf8").catch(() => "");
  assert.equal(await executions(), "");
  assert.equal((await runtime.getAvailable("stored-command")).length, 1);
  assert.equal(await executions(), "");

  assert.equal(
    (await runtime.getAuth("stored-interpolation"))?.auth.apiKey,
    "scoped-value",
  );
  const inheritedAuth = await runtime.getAuth("openai");
  assert.equal(inheritedAuth?.auth.apiKey, "inherited-provider-scoped-value");
  assert.equal(inheritedAuth?.source, "stored credential resolution");
  assert.equal(
    (await runtime.getAuth("stored-command"))?.auth.apiKey,
    "command-scoped-value",
  );
  assert.equal(
    (await runtime.getAuth("stored-command"))?.auth.apiKey,
    "command-scoped-value",
  );
  assert.equal(await executions(), "x");
});

test("stored command credentials are isolated by runtime generation and shell policy", {
  skip: process.platform === "win32",
}, async (context) => {
  const providerId = "runtime-shell-command-cache";
  const command = `!printf '%s' "$0"`;
  const directory = await mkdtemp(join(tmpdir(), "rigyn-command-shells-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const shellPaths = [join(directory, "shell-one"), join(directory, "shell-two")];
  await Promise.all(shellPaths.map(async (path) => {
    await copyFile("/bin/sh", path);
    await chmod(path, 0o700);
  }));
  const resolvedShellPaths = await Promise.all(shellPaths.map(async (path) => await realpath(path)));

  const createRuntime = async (shellPath: string): Promise<ModelRuntime> => {
    const credentials = new InMemoryProviderCredentialStore();
    await credentials.modify(providerId, async () => ({ type: "api_key", key: command }));
    const runtime = await ModelRuntime.create({
      models: createModels({
        credentials,
        authContext: defaultProviderAuthContext(process.env, { shellPath }),
      }),
      modelsPath: null,
      allowModelNetwork: false,
    });
    registerCommandCredentialProvider(runtime, providerId);
    return runtime;
  };

  const first = await createRuntime(shellPaths[0]!);
  const second = await createRuntime(shellPaths[1]!);
  assert.equal((await first.getAuth(providerId))?.auth.apiKey, resolvedShellPaths[0]);
  assert.equal((await second.getAuth(providerId))?.auth.apiKey, resolvedShellPaths[1]);

  const resolve = first.models().getProvider(providerId)?.auth.apiKey?.resolve;
  assert.ok(resolve);
  assert.equal((await resolve({
    credential: { type: "api_key", key: command },
    ctx: defaultProviderAuthContext(process.env, { shellPath: shellPaths[1]! }),
  }))?.auth.apiKey, resolvedShellPaths[1]);
});

test("concurrent stored command callers retain independent cancellation and cache only success", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-command-cancellation-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const marker = join(directory, "executions");
  const secret = "independent-command-secret";
  const providerId = "concurrent-command-cache";
  const source = [
    `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x")`,
    `setTimeout(() => process.stdout.write(${JSON.stringify(secret)}), 250)`,
  ].join(";");
  const encoded = Buffer.from(source, "utf8").toString("base64");
  const command = `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    `eval(Buffer.from("${encoded}", "base64").toString("utf8"))`,
  )}`;
  const credentials = new InMemoryProviderCredentialStore();
  await credentials.modify(providerId, async () => ({ type: "api_key", key: command }));
  const runtime = await ModelRuntime.create({
    models: createModels({ credentials }),
    modelsPath: null,
    allowModelNetwork: false,
  });
  registerCommandCredentialProvider(runtime, providerId);
  const provider = runtime.models().getProvider(providerId);
  const resolve = provider?.auth.apiKey?.resolve;
  assert.ok(resolve);
  const credential = { type: "api_key" as const, key: command };
  const baseContext = defaultProviderAuthContext();
  const controller = new AbortController();

  const cancelled = resolve({
    credential,
    ctx: { ...baseContext, signal: controller.signal },
  });
  const successful = resolve({ credential, ctx: baseContext });
  controller.abort();

  await assert.rejects(cancelled, (error) =>
    error instanceof DOMException && error.name === "AbortError");
  assert.equal((await successful)?.auth.apiKey, secret);
  const executions = await readFile(marker, "utf8");
  assert.ok(executions.length >= 1 && executions.length <= 2);

  assert.equal((await resolve({ credential, ctx: baseContext }))?.auth.apiKey, secret);
  assert.equal(await readFile(marker, "utf8"), executions);
});

test("runtime API-key overrides are effective, removable, and never persisted", async () => {
  const credentials = AuthStorage.inMemory();
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const model = runtime.find("anthropic", "claude-opus-4-8");
  assert.ok(model);

  await runtime.setRuntimeApiKey("anthropic", "runtime-only-key");
  assert.deepEqual(await runtime.getApiKeyAndHeaders(model), { ok: true, apiKey: "runtime-only-key" });
  assert.equal((await credentials.read("anthropic")), undefined);

  await runtime.removeRuntimeApiKey("anthropic");
  assert.equal((await credentials.read("anthropic")), undefined);
  const resolved = await runtime.getApiKeyAndHeaders(model);
  assert.equal(resolved.ok && resolved.apiKey === "runtime-only-key", false);
});

test("ModelRuntime exposes a selected Codex OAuth profile and resolves its account header", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-model-runtime-codex-profile-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const credentials = new EncryptedFileCredentialStore({
    path: join(directory, "credentials.enc"),
    key: randomBytes(32),
  });
  const accountId = "account-selected";
  await new CredentialProfileManager(credentials, "openai-codex").create("personal", {
    kind: "oauth",
    provider: "openai-codex",
    accessToken: codexAccessToken(accountId),
    refreshToken: "codex-refresh-token",
    expiresAt: Date.now() + 60 * 60_000,
    tokenType: "Bearer",
    scopes: ["openid", "offline_access"],
    tokenEndpoint: OPENAI_CODEX_TOKEN_ENDPOINT,
    clientId: OPENAI_TEST_CLIENT_ID,
    accountId,
    subject: "account-subject",
  });
  await new CredentialProfileManager(credentials, "openai").create("work", {
    kind: "api_key",
    provider: "openai",
    apiKey: "openai-api-key",
  });

  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const model = runtime.getModel("openai-codex", "gpt-5.6-sol");
  assert.ok(model);
  assert.equal(runtime.getAvailableSnapshot().some((entry) => entry.provider === "openai-codex"), true);
  assert.deepEqual(await runtime.checkAuth("openai-codex"), { type: "oauth", source: "OAuth" });
  assert.deepEqual(await runtime.getAuth(model), {
    auth: {
      apiKey: codexAccessToken(accountId),
      headers: { "chatgpt-account-id": accountId },
    },
    source: "OAuth",
  });

  const openAIModel = runtime.getModels("openai")[0];
  assert.ok(openAIModel);
  assert.equal(runtime.getAvailableSnapshot().some((entry) => entry.provider === "openai"), true);
  assert.equal((await runtime.getAuth(openAIModel))?.auth.apiKey, "openai-api-key");
});

test("ModelRuntime fails safely when a selected Codex OAuth profile cannot refresh", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-model-runtime-codex-refresh-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const credentials = new EncryptedFileCredentialStore({
    path: join(directory, "credentials.enc"),
    key: randomBytes(32),
  });
  const manager = new CredentialProfileManager(credentials, "openai-codex");
  const accessToken = codexAccessToken("account-expired");
  await manager.create("personal", {
    kind: "oauth",
    provider: "openai-codex",
    accessToken,
    refreshToken: "expired-refresh-token",
    expiresAt: Date.now() - 1,
    tokenType: "Bearer",
    scopes: ["openid", "offline_access"],
    tokenEndpoint: OPENAI_CODEX_TOKEN_ENDPOINT,
    clientId: OPENAI_TEST_CLIENT_ID,
    accountId: "account-expired",
    subject: "account-subject",
  });
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const originalFetch = globalThis.fetch;
  let refreshRequests = 0;
  globalThis.fetch = (async () => {
    refreshRequests += 1;
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  }) as typeof fetch;
  try {
    await assert.rejects(runtime.getAuth("openai-codex"), (error) =>
      error instanceof ProviderModelsError
      && error.code === "oauth"
      && /Could not refresh OAuth credentials/u.test(error.message));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(refreshRequests, 1);
  const active = await manager.active();
  assert.equal(active.credential?.kind, "oauth");
  assert.equal(active.credential?.kind === "oauth" ? active.credential.accessToken : undefined, accessToken);
});

test("ModelRuntime isolates deactivated and missing selected credential profiles", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-model-runtime-profile-failure-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const credentials = new EncryptedFileCredentialStore({
    path: join(directory, "credentials.enc"),
    key: randomBytes(32),
  });
  const openai = new CredentialProfileManager(credentials, "openai");
  const anthropic = new CredentialProfileManager(credentials, "anthropic");
  await openai.create("work", { kind: "api_key", provider: "openai", apiKey: "openai-key" });
  await anthropic.create("work", { kind: "api_key", provider: "anthropic", apiKey: "anthropic-key" });
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });

  assert.equal(runtime.getAvailableSnapshot().some((model) => model.provider === "openai"), true);
  assert.equal(runtime.getAvailableSnapshot().some((model) => model.provider === "anthropic"), true);

  await openai.deactivate();
  const deactivated = await runtime.refresh({ allowNetwork: false });
  const deactivatedError = deactivated.errors.get("openai");
  assert.match(deactivatedError?.message ?? "", /Unable to read saved credentials/u);
  assert.match(deactivatedError?.cause instanceof Error ? deactivatedError.cause.message : "", /No active credential profile/u);
  assert.equal(runtime.getAvailableSnapshot().some((model) => model.provider === "openai"), false);
  assert.equal(runtime.hasConfiguredAuth("openai"), false);
  assert.equal(runtime.getAvailableSnapshot().some((model) => model.provider === "anthropic"), true);
  assert.equal(runtime.hasConfiguredAuth("anthropic"), true);

  await openai.select("work");
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getAvailableSnapshot().some((model) => model.provider === "openai"), true);
  const selected = await openai.active();
  assert.ok(selected.storageId);
  await credentials.delete(selected.storageId);
  const missing = await runtime.refresh({ allowNetwork: false });
  const missingError = missing.errors.get("openai");
  assert.match(missingError?.message ?? "", /Unable to read saved credentials/u);
  assert.match(missingError?.cause instanceof Error ? missingError.cause.message : "", /Active credential profile is missing/u);
  assert.equal(runtime.getAvailableSnapshot().some((model) => model.provider === "openai"), false);
  assert.equal(runtime.hasConfiguredAuth("openai"), false);
  assert.equal(runtime.getAvailableSnapshot().some((model) => model.provider === "anthropic"), true);

  const models = runtime.models();
  const refresh = models.refresh.bind(models);
  models.refresh = async () => { throw new Error("catastrophic refresh failure"); };
  try {
    const failed = await runtime.refresh({ allowNetwork: false });
    assert.match(failed.errors.get("runtime")?.message ?? "", /catastrophic refresh failure/u);
    assert.deepEqual(runtime.getAvailableSnapshot(), []);
    assert.equal(runtime.hasConfiguredAuth("anthropic"), false);
  } finally {
    models.refresh = refresh;
  }
});

test("createAgentSession accepts the public ModelRegistry facade", async (context) => {
  const { directory, runtime } = await configuredRuntime(context);
  const model = runtime.getModel("sdk-custom", "custom-model");
  assert.ok(model);
  const registry = new ModelRegistry(runtime);
  const created = await createAgentSession({
    cwd: directory,
    agentDir: join(directory, ".agent"),
    modelRuntime: registry,
    model,
    scopedModels: [{ model, thinkingLevel: "low" }],
    sessionManager: SessionManager.inMemory(directory),
    settingsManager: SettingsManager.inMemory(),
    noTools: "all",
  });
  context.after(async () => await created.session.close());

  assert.equal(created.session.model?.provider, "sdk-custom");
  assert.equal(created.session.model?.id, "custom-model");
  assert.equal(created.session.model?.api, "openai-completions");
  assert.equal(created.session.modelRuntime, runtime);
  assert.equal((await created.session.modelRuntime.getAvailable("sdk-custom")).some((entry) => entry.id === "custom-model"), true);
});

test("ModelRuntime implements the public model, auth, streaming, and provider lifecycle contract", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("sdk-native", async () => ({ type: "api_key", key: "native-key" }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const model = {
    id: "native-model",
    name: "Native model",
    api: "openai-completions" as const,
    provider: "sdk-native",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
  };
  let observedApiKey: string | undefined;
  const provider: Provider = {
    id: "sdk-native",
    name: "SDK native",
    auth: {
      apiKey: {
        name: "API key",
        async resolve({ credential }) {
          return credential?.type === "api_key" && credential.key !== undefined
            ? { auth: { apiKey: credential.key } }
            : undefined;
        },
      },
    },
    getModels: () => [model],
    stream(_model, _context, options) {
      observedApiKey = options?.apiKey;
      const stream = createAssistantMessageEventStream();
      const counters = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "ready" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          ...counters,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      return stream;
    },
    streamSimple(selected, context, options) { return this.stream(selected, context, options); },
  };

  runtime.registerNativeProvider(provider);
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getProvider("sdk-native")?.name, "SDK native");
  assert.equal(runtime.getModels("sdk-native")[0]?.id, "native-model");
  assert.equal((await runtime.getAvailable("sdk-native"))[0]?.id, "native-model");
  assert.equal(runtime.getAvailableSnapshot().some((entry) => entry.provider === "sdk-native"), true);
  assert.deepEqual(await runtime.checkAuth("sdk-native"), { type: "api_key" });
  assert.deepEqual(await runtime.listCredentials(), [{ providerId: "sdk-native", type: "api_key" }]);
  assert.equal((await runtime.completeSimple(model, { messages: [] })).content[0]?.type, "text");
  assert.equal(observedApiKey, "native-key");

  runtime.unregisterProvider("sdk-native");
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getProvider("sdk-native"), undefined);
});

test("a stalled availability read cannot replace a newer successful refresh", async (context) => {
  const { runtime } = await configuredRuntime(context);
  const models = runtime.models();
  const originalGetAvailable = models.getAvailable.bind(models);
  const staleModel = models.getModel("sdk-custom", "custom-model");
  assert.ok(staleModel);
  const currentModel = { ...staleModel, id: "current-model", name: "Current model" };
  const started = deferredSignal();
  const release = deferredSignal();
  let availabilityReads = 0;
  models.getAvailable = async (providerId) => {
    availabilityReads += 1;
    if (availabilityReads === 1) {
      started.resolve();
      await release.promise;
      return [staleModel];
    }
    return providerId === "sdk-custom" ? [currentModel] : [];
  };
  context.after(() => { models.getAvailable = originalGetAvailable; });

  const staleRead = runtime.getAvailable();
  await started.promise;
  await runtime.refresh({ allowNetwork: false });
  assert.deepEqual(runtime.getAvailableSnapshot().map((model) => model.id), ["current-model"]);

  release.resolve();
  assert.deepEqual((await staleRead).map((model) => model.id), ["custom-model"]);
  assert.deepEqual(runtime.getAvailableSnapshot().map((model) => model.id), ["current-model"]);
  assert.equal(runtime.getError(), undefined);
});

test("a stale availability failure cannot replace or intercept a newer successful refresh", async (context) => {
  const { runtime } = await configuredRuntime(context);
  const models = runtime.models();
  const originalGetAvailable = models.getAvailable.bind(models);
  const staleModel = models.getModel("sdk-custom", "custom-model");
  assert.ok(staleModel);
  const currentModel = { ...staleModel, id: "current-model", name: "Current model" };
  const started = deferredSignal();
  const release = deferredSignal();
  let availabilityReads = 0;
  models.getAvailable = async (providerId) => {
    availabilityReads += 1;
    if (availabilityReads === 1) {
      started.resolve();
      await release.promise;
      throw new Error("stale availability failure");
    }
    return providerId === "sdk-custom" ? [currentModel] : [];
  };
  context.after(() => { models.getAvailable = originalGetAvailable; });

  const staleRead = runtime.getAvailable();
  await started.promise;
  const refresh = runtime.refresh({ allowNetwork: false });
  const joined = runtime.getAvailable().then(
    (available) => ({ available }),
    (error: unknown) => ({ error }),
  );
  const result = await refresh;
  assert.equal(result.errors.size, 0);
  assert.deepEqual(runtime.getAvailableSnapshot().map((model) => model.id), ["current-model"]);

  release.resolve();
  await assert.rejects(staleRead, /stale availability failure/u);
  const joinedResult = await joined;
  assert.equal("error" in joinedResult, false);
  assert.deepEqual(
    "available" in joinedResult ? joinedResult.available.map((model) => model.id) : [],
    ["current-model"],
  );
  assert.deepEqual(runtime.getAvailableSnapshot().map((model) => model.id), ["current-model"]);
  assert.equal(runtime.getError(), undefined);
});

test("the public ModelRegistry is the synchronous compatibility view of ModelRuntime", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("registry-native", async () => ({ type: "api_key", key: "registry-key" }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const model = {
    id: "registry-model",
    name: "Registry model",
    api: "openai-completions" as const,
    provider: "registry-native",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4_096,
    maxTokens: 512,
  };
  const provider: Provider = {
    id: "registry-native",
    name: "Registry native",
    auth: {
      apiKey: {
        name: "API key",
        async resolve({ credential }) {
          return credential?.type === "api_key" && credential.key !== undefined
            ? { auth: { apiKey: credential.key } }
            : undefined;
        },
      },
    },
    getModels: () => [model],
    stream() { return createAssistantMessageEventStream(); },
    streamSimple() { return createAssistantMessageEventStream(); },
  };
  runtime.registerNativeProvider(provider);
  await runtime.refresh({ allowNetwork: false });
  const registry = new ModelRegistry(runtime);

  assert.deepEqual(registry.find("registry-native", "registry-model"), model);
  assert.equal(registry.getAvailable().some((entry) => entry.id === "registry-model"), true);
  assert.equal(registry.getProviderDisplayName("registry-native"), "Registry native");
  assert.equal(registry.hasConfiguredAuth(model), true);
  assert.deepEqual(await registry.getApiKeyAndHeaders(model), { ok: true, apiKey: "registry-key" });
  registry.unregisterProvider("registry-native");
  assert.equal(registry.find("registry-native", "registry-model"), undefined);
});

test("the public ModelRegistry contains hostile provider auth failures without reflection", async () => {
  let traps = 0;
  const hostile = new Proxy({}, {
    get() { traps += 1; throw new Error("get trap executed"); },
    getPrototypeOf() { traps += 1; throw new Error("prototype trap executed"); },
  });
  let failure: unknown = new Error("provider credential unavailable");
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  const model = {
    id: "hostile-auth-model",
    name: "Hostile auth model",
    api: "openai-completions" as const,
    provider: "hostile-auth",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4_096,
    maxTokens: 512,
  };
  runtime.registerNativeProvider({
    id: "hostile-auth",
    name: "Hostile auth",
    auth: {
      apiKey: {
        name: "API key",
        async resolve() { throw failure; },
      },
    },
    getModels: () => [model],
    stream: () => createAssistantMessageEventStream(),
    streamSimple: () => createAssistantMessageEventStream(),
  });
  const registry = new ModelRegistry(runtime);

  assert.deepEqual(await registry.getApiKeyAndHeaders(model), {
    ok: false,
    error: "provider credential unavailable",
  });
  failure = hostile;
  assert.deepEqual(await registry.getApiKeyAndHeaders(model), {
    ok: false,
    error: "[Thrown object]",
  });
  assert.equal(traps, 0);
});

test("the compatibility registry permits explicitly unauthenticated provider requests", async () => {
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  runtime.registerProvider("no-auth-fixture", {
    name: "No auth fixture",
    baseUrl: "https://example.test/v1",
    api: "openai-completions",
    authHeader: false,
    headers: { "x-fixture": "present" },
    models: [{
      id: "fixture",
      name: "Fixture",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4_096,
      maxTokens: 512,
    }],
  });
  await runtime.refresh({ allowNetwork: false });
  const model = runtime.getModel("no-auth-fixture", "fixture");
  assert.ok(model);
  const registry = new ModelRegistry(runtime);
  assert.deepEqual(await registry.getApiKeyAndHeaders(model), {
    ok: true,
    headers: { "x-fixture": "present" },
  });
});

test("ModelRuntime uses the platform credential selector when no store is supplied", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-model-runtime-credentials-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const authPath = join(directory, "auth.json");
  await writeFile(`${authPath}.backend`, '{"version":1,"backend":"unsupported-fixture"}\n');

  await assert.rejects(
    ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false }),
    /Credential backend marker has an invalid shape/u,
  );
});

test("catalogBaseUrl overlays built-in models through the persisted refresh contract", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-model-runtime-catalog-store-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const modelsStorePath = join(directory, "models-store.json");
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  const conditionalTags: Array<string | null> = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname !== "/api/models/providers/openai") return new Response(null, { status: 404 });
    const conditionalTag = new Headers(init?.headers).get("if-none-match");
    conditionalTags.push(conditionalTag);
    if (conditionalTag === '"catalog-probe-v1"') return new Response(null, { status: 304 });
    return Response.json({
      models: [{
        id: "catalog-probe",
        name: "Catalog probe",
        api: "openai-responses",
        provider: "wrong-provider",
        baseUrl: "https://api.example.test/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
        contextWindow: 16_384,
        maxTokens: 2_048,
      }],
    }, { headers: { etag: '"catalog-probe-v1"' } });
  }) as typeof fetch;
  try {
    const runtime = await ModelRuntime.create({
      credentials: AuthStorage.inMemory(),
      modelsPath: null,
      modelsStorePath,
      catalogBaseUrl: "https://catalog.example.test/root",
      allowModelNetwork: true,
    });
    const model = runtime.getModel("openai", "catalog-probe");
    assert.ok(model);
    assert.equal(model.provider, "openai");
    assert.equal(model.api, "openai-responses");
    assert.equal(requests.some((url) => url.pathname === "/api/models/providers/openai"), true);
    assert.deepEqual(conditionalTags, [null]);
    await runtime.refresh({ allowNetwork: true, force: true });
    assert.deepEqual(conditionalTags, [null, '"catalog-probe-v1"']);
    assert.equal(runtime.getModel("openai", "catalog-probe")?.id, "catalog-probe");
    assert.match(await readFile(modelsStorePath, "utf8"), /catalog-probe/u);

    globalThis.fetch = (async () => { throw new Error("offline refresh must not use fetch"); }) as typeof fetch;
    const reopened = await ModelRuntime.create({
      credentials: AuthStorage.inMemory(),
      modelsPath: null,
      modelsStorePath,
      catalogBaseUrl: "https://catalog.example.test/root",
      allowModelNetwork: false,
    });
    assert.equal(reopened.getModel("openai", "catalog-probe")?.id, "catalog-probe");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
