import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryCredentialStore,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type Provider,
} from "@rigyn/models";

import { AuthStorage } from "../../src/auth/auth-storage.js";
import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import { builtinModels } from "../../src/providers/all.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { createModels } from "../../src/providers/models.js";
import {
  ModelRegistry,
  type ProviderConfigInput,
  type ResolvedRequestAuth,
} from "../../src/providers/public-model-registry.js";

function fixtureModel<TApi extends Api>(provider: string, id: string, api: TApi): Model<TApi> {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
  };
}

function response(model: Model<Api>, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function responseStream(model: Model<Api>, text: string) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: response(model, text) }));
  return stream;
}

function messageText(message: AssistantMessage): string | undefined {
  const first = message.content[0];
  return first?.type === "text" ? first.text : undefined;
}

test("the public registry method inventory remains reachable", () => {
  assert.deepEqual(Object.getOwnPropertyNames(ModelRegistry.prototype).sort(), [
    "checkAuth",
    "close",
    "complete",
    "completeSimple",
    "constructor",
    "find",
    "getAll",
    "getApiKeyAndHeaders",
    "getAuth",
    "getAvailable",
    "getAvailableSnapshot",
    "getCompatibilityRequestConfig",
    "getError",
    "getModel",
    "getModels",
    "getProvider",
    "getProviderAuthStatus",
    "getProviderDisplayName",
    "getProviders",
    "getRegisteredNativeProvider",
    "getRegisteredProviderConfig",
    "getRegisteredProviderIds",
    "hasConfiguredAuth",
    "internalRegistry",
    "isUsingOAuth",
    "listCredentials",
    "login",
    "logout",
    "models",
    "refresh",
    "refreshConfig",
    "registerNativeProvider",
    "registerProvider",
    "removeRuntimeApiKey",
    "setRuntimeApiKey",
    "stream",
    "streamSimple",
    "unregisterProvider",
  ]);
  assert.equal(typeof ModelRegistry.prototype[Symbol.asyncDispose], "function");
});

test("catalog and provider capabilities preserve synchronous defensive list snapshots", async (context) => {
  const runtime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  context.after(async () => await runtime.close());
  const registry = new ModelRegistry(runtime);
  const model = fixtureModel("public-native", "native-model", "openai-completions");
  const native: Provider = {
    id: model.provider,
    name: "Public native",
    auth: { apiKey: { name: "API key", async resolve() { return { auth: {} }; } } },
    getModels: () => [model],
    stream: () => responseStream(model, "native"),
    streamSimple: () => responseStream(model, "native"),
  };

  registry.registerProvider(native);
  await registry.refresh({ allowNetwork: false });
  assert.equal(registry.getProvider(model.provider), native);
  assert.equal(registry.getProviderDisplayName(model.provider), "Public native");
  assert.equal(registry.getProviderDisplayName("missing"), "missing");
  assert.deepEqual(registry.find(model.provider, model.id), model);
  assert.deepEqual(registry.getModel(model.provider, model.id), model);
  assert.deepEqual(registry.getModels(model.provider)[0], model);
  assert.equal(registry.getRegisteredNativeProvider(model.provider), native);
  assert.deepEqual(registry.getRegisteredProviderIds(), [model.provider]);
  assert.equal(registry.getError(), undefined);
  assert.equal(registry.internalRegistry(), runtime.internalRegistry());
  assert.equal(registry.models(), runtime.models());

  registry.getAll().length = 0;
  registry.getAvailable().length = 0;
  (registry.getModels() as Model<Api>[]).length = 0;
  (registry.getAvailableSnapshot() as Model<Api>[]).length = 0;
  (registry.getProviders() as Provider[]).length = 0;
  (registry.getRegisteredProviderIds() as string[]).length = 0;
  assert.equal(registry.getAll().some((entry) => entry.id === model.id), true);
  assert.equal(registry.getAvailable().some((entry) => entry.id === model.id), true);
  assert.equal(registry.getModels().some((entry) => entry.id === model.id), true);
  assert.equal(registry.getAvailableSnapshot().some((entry) => entry.id === model.id), true);
  assert.equal(registry.getProviders().some((entry) => entry.id === native.id), true);
  assert.deepEqual(registry.getRegisteredProviderIds(), [model.provider]);

  registry.unregisterProvider(model.provider);
  assert.equal(registry.getModel(model.provider, model.id), undefined);
  registry.registerNativeProvider(native);
  await registry.refreshConfig();
  assert.equal(registry.getProvider(model.provider), native);
  registry.unregisterProvider(model.provider);

  const config: ProviderConfigInput = {
    name: "Configured provider",
    api: "openai-completions",
    baseUrl: "https://configured.example.test/v1",
    headers: { "x-configured": "present" },
    authHeader: false,
    models: [{
      id: "configured-model",
      name: "Configured model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4_096,
      maxTokens: 512,
    }],
  };
  registry.registerProvider("public-config", config);
  await registry.refresh({ allowNetwork: false });
  const configured = registry.getModel("public-config", "configured-model");
  assert.ok(configured);
  assert.equal(registry.getRegisteredProviderConfig("public-config")?.name, "Configured provider");
  assert.deepEqual(registry.getCompatibilityRequestConfig(configured), {
    authHeader: false,
  });
  assert.deepEqual(await registry.getApiKeyAndHeaders(configured), {
    ok: true,
    headers: { "x-configured": "present" },
  });

  assert.throws(
    () => (registry.registerProvider as unknown as (providerId: string) => void)("missing-config"),
    /Provider configuration is required/u,
  );
  assert.throws(() => registry.registerProvider("", config), /non-empty id/u);
  assert.throws(
    () => registry.registerProvider("invalid-config", { name: "Invalid config" }),
    /models are required/u,
  );
  assert.throws(
    () => registry.registerNativeProvider({ ...native, id: "", getModels: () => [] }),
    /non-empty id/u,
  );
  registry.unregisterProvider("public-config");
  registry.unregisterProvider("missing-provider");
});

test("authentication capabilities cover overrides, stored keys, runtime keys, OAuth, and logout", async (context) => {
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  context.after(async () => await runtime.close());
  const registry = new ModelRegistry(runtime);
  const model = {
    ...fixtureModel("public-auth", "auth-model", "openai-completions"),
    headers: { "x-model": "model" },
  };
  const provider: Provider = {
    id: model.provider,
    name: "Public auth",
    auth: {
      apiKey: {
        name: "API key",
        async login() { return { type: "api_key", key: "stored-key", env: { ZONE: "stored" } }; },
        async check({ credential }) {
          return credential?.key === undefined ? undefined : { type: "api_key", message: "ready" };
        },
        async resolve({ credential }) {
          return credential?.key === undefined
            ? undefined
            : {
                auth: {
                  apiKey: credential.key,
                  headers: { "x-auth": "auth", "x-removed": null },
                },
                ...(credential.env === undefined ? {} : { env: credential.env }),
              };
        },
      },
    },
    getModels: () => [model],
    stream: () => responseStream(model, "auth"),
    streamSimple: () => responseStream(model, "auth"),
  };
  registry.registerNativeProvider(provider);
  await registry.refresh({ allowNetwork: false });

  assert.equal(registry.hasConfiguredAuth(model), false);
  assert.equal(registry.hasConfiguredAuth(model.provider), false);
  assert.equal(registry.isUsingOAuth(model), false);
  assert.equal(registry.isUsingOAuth(model.provider), false);
  assert.deepEqual(registry.getProviderAuthStatus(model.provider), { configured: false });
  assert.deepEqual(registry.getCompatibilityRequestConfig(model), {
    headers: { "x-model": "model" },
    authHeader: false,
  });
  assert.equal((await registry.getAuth(model, { apiKey: "request-key" }))?.auth.apiKey, "request-key");
  assert.equal((await registry.getAuth(model.provider, { apiKey: "provider-key" }))?.auth.apiKey, "provider-key");

  const interaction = { prompt: async () => "unused", notify() {} };
  const credential = await registry.login(model.provider, "api_key", interaction);
  assert.deepEqual(credential, { type: "api_key", key: "stored-key", env: { ZONE: "stored" } });
  assert.deepEqual(await registry.checkAuth(model.provider), { type: "api_key", message: "ready" });
  assert.equal(registry.hasConfiguredAuth(model), true);
  assert.deepEqual(await registry.getApiKeyAndHeaders(model), {
    ok: true,
    apiKey: "stored-key",
    headers: { "x-auth": "auth", "x-model": "model" },
    env: { ZONE: "stored" },
  });
  assert.deepEqual(await registry.listCredentials(), [{ providerId: model.provider, type: "api_key" }]);

  await registry.setRuntimeApiKey(model.provider, "runtime-key", { allowNetwork: false });
  assert.equal((await registry.getAuth(model))?.auth.apiKey, "runtime-key");
  assert.deepEqual(registry.getProviderAuthStatus(model.provider), { configured: true, source: "runtime" });
  await registry.removeRuntimeApiKey(model.provider);
  assert.equal((await registry.getAuth(model))?.auth.apiKey, "stored-key");
  await registry.logout(model.provider);
  assert.deepEqual(await registry.listCredentials(), []);
  assert.equal(await registry.getAuth(model.provider), undefined);

  const oauthModel = fixtureModel("public-oauth", "oauth-model", "openai-completions");
  const oauthProvider: Provider = {
    id: oauthModel.provider,
    name: "Public OAuth",
    auth: {
      oauth: {
        name: "OAuth",
        async login() {
          return { access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 60_000 };
        },
        async refresh(selected) { return selected; },
        async toAuth(selected) { return { apiKey: selected.access }; },
      },
    },
    getModels: () => [oauthModel],
    stream: () => responseStream(oauthModel, "oauth"),
    streamSimple: () => responseStream(oauthModel, "oauth"),
  };
  registry.registerNativeProvider(oauthProvider);
  await registry.login(oauthModel.provider, "oauth", interaction);
  assert.equal(registry.isUsingOAuth(oauthModel), true);
  assert.equal((await registry.getAuth(oauthModel.provider))?.auth.apiKey, "oauth-access");
  await registry.logout(oauthModel.provider);
});

test("authentication failures are bounded and redacted without reflecting hostile objects", async (context) => {
  let traps = 0;
  const hostile = new Proxy({}, {
    get() { traps += 1; throw new Error("get trap executed"); },
    getPrototypeOf() { traps += 1; throw new Error("prototype trap executed"); },
  });
  const runtime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  context.after(async () => await runtime.close());
  const model = fixtureModel("hostile-provider", "hostile-model", "openai-completions");
  let failure: unknown = new Error("ordinary authentication failure");
  runtime.registerNativeProvider({
    id: model.provider,
    name: "Hostile provider",
    auth: { apiKey: { name: "API key", async resolve() { throw failure; } } },
    getModels: () => [model],
    stream: () => responseStream(model, "unused"),
    streamSimple: () => responseStream(model, "unused"),
  });
  const registry = new ModelRegistry(runtime);

  assert.deepEqual(await registry.getApiKeyAndHeaders(model), {
    ok: false,
    error: "ordinary authentication failure",
  });
  failure = hostile;
  assert.deepEqual(await registry.getApiKeyAndHeaders(model), { ok: false, error: "[Thrown object]" });
  assert.equal(traps, 0);

  failure = new Error(`kept-${"x".repeat(4 * 1_024 * 1_024)}`);
  const huge = await registry.getApiKeyAndHeaders(model);
  assert.equal(huge.ok, false);
  assert.equal(huge.ok ? false : huge.error.startsWith("kept-"), true);
  assert.equal(huge.ok ? false : Buffer.byteLength(huge.error, "utf8") <= 4_096, true);

  const marker = "LEAK-model-registry-cutoff-secret-";
  const secret = `${marker}${"s".repeat((64 * 1_024) - marker.length)}`;
  defaultSecretRedactor.register(secret);
  failure = new Error(`${"p".repeat(4_080)}${secret}-tail`);
  const straddling = await registry.getApiKeyAndHeaders(model);
  assert.equal(straddling.ok, false);
  assert.equal(straddling.ok ? true : straddling.error.includes(marker), false);
  assert.equal(straddling.ok ? false : Buffer.byteLength(straddling.error, "utf8") <= 4_096, true);
});

test("stream and completion methods preserve generic and simple forwarding", async (context) => {
  const runtime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  context.after(async () => await runtime.close());
  const model = fixtureModel("generation-provider", "generation-model", "vendor-generation-probe");
  const calls: Array<{ method: "stream" | "simple"; option: string | number | undefined; messages: number }> = [];
  const provider: Provider = {
    id: model.provider,
    name: "Generation provider",
    auth: { apiKey: { name: "API key", async resolve() { return { auth: {} }; } } },
    getModels: () => [model],
    stream(_selected, selectedContext, options) {
      calls.push({ method: "stream", option: options?.api, messages: selectedContext.messages.length });
      return responseStream(model, "stream");
    },
    streamSimple(_selected, selectedContext, options) {
      calls.push({ method: "simple", option: options?.maxTokens, messages: selectedContext.messages.length });
      return responseStream(model, "simple");
    },
  };
  const registry = new ModelRegistry(runtime);
  registry.registerNativeProvider(provider);
  await registry.refresh({ allowNetwork: false });

  const contextValue = { messages: [] };
  assert.equal(messageText(await registry.stream(model, contextValue, { api: model.api }).result()), "stream");
  assert.equal(messageText(await registry.complete(model, contextValue, { api: model.api })), "stream");
  assert.equal(messageText(await registry.streamSimple(model, contextValue, { maxTokens: 9 }).result()), "simple");
  assert.equal(messageText(await registry.completeSimple(model, contextValue, { maxTokens: 10 })), "simple");
  assert.deepEqual(calls, [
    { method: "stream", option: model.api, messages: 0 },
    { method: "stream", option: model.api, messages: 0 },
    { method: "simple", option: 9, messages: 0 },
    { method: "simple", option: 10, messages: 0 },
  ]);
});

test("close and async disposal are idempotent and respect runtime ownership", async () => {
  const ownedRuntime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const ownedModels = ownedRuntime.models() as ReturnType<typeof builtinModels>;
  const originalClose = ownedModels.close.bind(ownedModels);
  let ownedCloses = 0;
  ownedModels.close = async () => {
    ownedCloses += 1;
    await originalClose();
  };
  const owned = new ModelRegistry(ownedRuntime);
  const firstClose = owned.close();
  assert.equal(owned.close(), firstClose);
  await firstClose;
  await owned[Symbol.asyncDispose]();
  assert.equal(ownedCloses, 1);

  let callerCloses = 0;
  const callerModels = Object.assign(createModels(), {
    async close() { callerCloses += 1; },
  });
  const callerRuntime = await ModelRuntime.create({
    models: callerModels,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const caller = new ModelRegistry(callerRuntime);
  await caller.close();
  await caller[Symbol.asyncDispose]();
  assert.equal(callerCloses, 0);
  await callerModels.close();
  assert.equal(callerCloses, 1);
});

test("ResolvedRequestAuth remains a discriminated public contract", () => {
  const success: ResolvedRequestAuth = { ok: true, apiKey: "key" };
  const failure: ResolvedRequestAuth = { ok: false, error: "missing" };
  assert.equal(success.ok, true);
  assert.equal(failure.ok, false);
});
