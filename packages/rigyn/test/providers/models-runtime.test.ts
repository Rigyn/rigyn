import assert from "node:assert/strict";
import test from "node:test";

import type { AdapterEvent, ModelProtocolFamily, ProviderRequest } from "../../src/core/types.js";
import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  InMemoryProviderCredentialStore,
  InMemoryProviderModelsStore,
  ProviderModelsError,
  calculateCost,
  canonicalProviderId,
  clampThinkingLevel,
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  type Provider,
  type ProviderApiKeyAuth,
  type ProviderModel,
  type ProviderStreamOptions,
} from "../../src/providers/index.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import {
  providerAdapterFromModels,
  providerFromAdapter,
  providerModelFromInfo,
  providerModelToInfo,
} from "../../src/providers/internal-runtime-bridge.js";
import { ProviderRegistry } from "../../src/providers/registry.js";

function model(provider: string, id: string, api: ModelProtocolFamily = "openai-responses"): ProviderModel {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10_000,
    maxTokens: 1_000,
  };
}

const ambientAuth: ProviderApiKeyAuth = {
  name: "Ambient",
  resolve: async () => ({ auth: {}, source: "ambient" }),
};

function provider(id: string, models: ProviderModel[] = [model(id, "model")]): Provider {
  return createProvider({
    id,
    auth: { apiKey: ambientAuth },
    models,
    api: {
      async *stream(request) {
        yield { type: "response_start", model: request.model };
      },
    },
  });
}

test("direct models collection replaces providers in place and supports exact synchronous reads", () => {
  const models = createModels();
  const first = provider("one", [model("one", "old")]);
  const second = provider("two");
  models.setProvider(first);
  models.setProvider(second);
  assert.deepEqual(models.getProviders().map((entry) => entry.id), ["one", "two"]);
  const replacement = provider("one", [model("one", "new")]);
  models.setProvider(replacement);
  assert.equal(models.getProvider("one"), replacement);
  assert.deepEqual(models.getModels("one").map((entry) => entry.id), ["new"]);
  assert.equal(models.getModel("one", "new")?.id, "new");
  models.deleteProvider("one");
  assert.equal(models.getProvider("one"), undefined);
  models.clearProviders();
  assert.deepEqual(models.getProviders(), []);
});

test("built-in provider identities are canonical and unique", () => {
  assert.equal(BUILTIN_PROVIDER_DESCRIPTORS.length, 38);
  assert.equal(new Set(BUILTIN_PROVIDER_DESCRIPTORS.map((entry) => entry.id)).size, 38);
  assert.equal(canonicalProviderId("bedrock"), "amazon-bedrock");
  assert.equal(canonicalProviderId("gemini"), "google");
  assert.equal(canonicalProviderId("vertex"), "google-vertex");
  assert.equal(canonicalProviderId("azure-openai"), "azure-openai-responses");
  assert.deepEqual(
    BUILTIN_PROVIDER_DESCRIPTORS.find((entry) => entry.id === "anthropic")?.environment,
    ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  );
  assert.deepEqual(
    BUILTIN_PROVIDER_DESCRIPTORS.find((entry) => entry.id === "openai-codex")?.environment,
    [],
  );
});

test("adapter registry exposes the same direct mutable collection operations", async () => {
  const adapter = (id: string, modelId: string) => ({
    id,
    async *stream() {},
    async listModels() {
      const unknown = { value: "unknown" as const, source: "provider" as const, observedAt: "2026-01-01T00:00:00.000Z" };
      return [{ id: modelId, provider: id, capabilities: { tools: unknown, reasoning: unknown, images: unknown } }];
    },
  });
  const registry = new ProviderRegistry();
  registry.setProvider(adapter("direct", "first"));
  await registry.refreshModels("direct", new AbortController().signal);
  assert.equal(registry.getProvider("direct")?.id, "direct");
  assert.deepEqual(registry.getProviders().map((entry) => entry.id), ["direct"]);
  assert.equal(registry.getModel("direct", "first")?.id, "first");
  registry.setProvider(adapter("direct", "second"));
  assert.deepEqual(registry.getModels("direct"), []);
  await registry.refreshModels("direct", new AbortController().signal);
  assert.equal(registry.getModel("direct", "second")?.id, "second");
  registry.deleteProvider("direct");
  assert.equal(registry.getProvider("direct"), undefined);
  registry.setProvider(adapter("one", "a"));
  registry.setProvider(adapter("two", "b"));
  registry.clearProviders();
  assert.deepEqual(registry.getProviders(), []);
});

test("adapter bridges skip unauthenticated remote discovery but permit explicit local discovery", async () => {
  let refreshes = 0;
  const adapter = {
    id: "discovery",
    async *stream() {},
    async listModels() {
      refreshes += 1;
      return [];
    },
  };
  const auth = {
    apiKey: {
      name: "Unavailable key",
      async resolve() { return undefined; },
    },
  };
  const remote = createModels();
  remote.setProvider(providerFromAdapter(adapter, { auth }));
  assert.equal((await remote.refresh()).errors.size, 0);
  assert.equal(refreshes, 0);

  const local = createModels();
  local.setProvider(providerFromAdapter(adapter, { auth, allowUnauthenticatedRefresh: true }));
  assert.equal((await local.refresh()).errors.size, 0);
  assert.equal(refreshes, 1);
});

test("model bridges preserve exact logical reasoning effort support", () => {
  const observedAt = "2026-07-22T00:00:00.000Z";
  const capability = (value: "supported" | "unsupported") => ({
    value,
    source: "provider" as const,
    observedAt,
  });
  const bridged = providerModelFromInfo({
    id: "reasoning-model",
    provider: "reasoning-provider",
    capabilities: {
      tools: capability("supported"),
      reasoning: capability("supported"),
      images: capability("unsupported"),
    },
    compatibility: {
      protocolFamily: { value: "openai-responses", source: "provider", observedAt },
      reasoningEfforts: {
        value: ["off", "low", "high", "xhigh", "max"],
        source: "provider",
        observedAt,
      },
    },
  });
  assert.deepEqual(bridged.thinkingLevelMap, {
    off: "off",
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });
  assert.deepEqual(getSupportedThinkingLevels(bridged), ["off", "low", "high", "xhigh", "max"]);

  const direct = {
    ...model("reasoning-provider", "mapped-model"),
    reasoning: true,
    thinkingLevelMap: { minimal: "low", xhigh: "extra-high", max: "maximum" },
  } satisfies ProviderModel;
  assert.deepEqual(providerModelToInfo(direct).compatibility?.reasoningEfforts?.value, [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("model bridges can use a provider-owned protocol without fabricating sparse metadata", () => {
  const observedAt = "2026-07-22T00:00:00.000Z";
  const unknown = { value: "unknown" as const, source: "maintained" as const, observedAt };
  const info = {
    id: "fallback-model",
    provider: "mistral",
    capabilities: { tools: unknown, reasoning: unknown, images: unknown },
  };
  assert.throws(() => providerModelFromInfo(info), /does not declare an API protocol/u);
  const bridged = providerModelFromInfo(info, "mistral-conversations");
  assert.equal(bridged.api, "mistral-conversations");
  assert.deepEqual(providerModelToInfo(bridged), info);
});

test("model snapshots are best effort when a provider throws", () => {
  const models = createModels();
  models.setProvider({
    ...provider("broken"),
    getModels() {
      throw new Error("broken source");
    },
  });
  models.setProvider(provider("healthy", [model("healthy", "works")]));
  assert.deepEqual(models.getModels("broken"), []);
  assert.deepEqual(models.getModels().map((entry) => entry.id), ["works"]);
  assert.throws(() => models.getProvider("broken")?.getModels(), /broken source/u);
});

test("provider factories dispatch mixed protocols using explicit model metadata", async () => {
  const calls: string[] = [];
  const direct = createProvider({
    id: "mixed",
    auth: { apiKey: ambientAuth },
    models: [
      model("mixed", "responses", "openai-responses"),
      model("mixed", "messages", "anthropic-messages"),
    ],
    api: {
      "openai-responses": {
        async *stream(request) {
          calls.push(`responses:${request.model}`);
        },
      },
      "anthropic-messages": {
        async *stream(request) {
          calls.push(`messages:${request.model}`);
        },
      },
    },
  });
  const models = createModels();
  models.setProvider(direct);
  for await (const _event of models.stream(direct.getModels()[0]!, { messages: [] })) {
    // exhaust
  }
  for await (const _event of models.stream(direct.getModels()[1]!, { messages: [] })) {
    // exhaust
  }
  assert.deepEqual(calls, ["responses:responses", "messages:messages"]);
});

test("stored credentials own a provider and explicit request auth wins per field", async () => {
  const credentials = new InMemoryProviderCredentialStore();
  await credentials.modify("owned", async () => ({ type: "api_key", key: "stored", env: { SHARED: "stored" } }));
  let observed: ProviderStreamOptions | undefined;
  const ownedModel = { ...model("owned", "model"), headers: { "x-model": "model", "x-shared": "model" } };
  const models = createModels({
    credentials,
    authContext: {
      env: async (name) => name === "OWNED_KEY" ? "ambient" : undefined,
      fileExists: async () => false,
    },
  });
  models.setProvider(createProvider({
    id: "owned",
    auth: {
      apiKey: {
        name: "Key",
        resolve: async ({ credential, ctx }) => {
          const key = credential?.key ?? await ctx.env("OWNED_KEY");
          return key === undefined ? undefined : {
            auth: { apiKey: key, headers: { "X-Shared": "auth", "x-auth": "yes" } },
            ...(credential?.env === undefined ? {} : { env: credential.env }),
            source: credential === undefined ? "ambient" : "stored",
          };
        },
      },
    },
    models: [ownedModel],
    api: {
      async *stream(_request, _signal, options) {
        observed = options;
      },
    },
  }));

  const resolved = await models.getAuth(ownedModel);
  assert.equal(resolved?.auth.apiKey, "stored");
  assert.deepEqual(resolved?.auth.headers, { "x-auth": "yes", "x-model": "model", "x-shared": "model" });

  for await (const _event of models.stream(ownedModel, { messages: [] }, {
    apiKey: "request",
    headers: { "X-SHARED": "request", "x-request": "yes" },
    env: { SHARED: "request", REQUEST: "yes" },
    transformHeaders: (headers) => ({ ...headers, "x-transformed": "yes" }),
  })) {
    // exhaust
  }
  assert.equal(observed?.apiKey, "request");
  assert.deepEqual(observed?.env, { SHARED: "request", REQUEST: "yes" });
  assert.deepEqual(observed?.headers, {
    "x-auth": "yes",
    "x-model": "model",
    "X-SHARED": "request",
    "x-request": "yes",
    "x-transformed": "yes",
  });

  await credentials.modify("blocked", async () => ({
    type: "oauth",
    access: "a",
    refresh: "r",
    expires: Date.now() + 60_000,
  }));
  models.setProvider(createProvider({
    id: "blocked",
    auth: { apiKey: ambientAuth },
    models: [model("blocked", "model")],
    api: { async *stream() {} },
  }));
  assert.equal(await models.getAuth("blocked"), undefined);
});

test("expired OAuth refresh is serialized and a failed refresh preserves storage", async () => {
  const credentials = new InMemoryProviderCredentialStore();
  const expired = {
    type: "oauth" as const,
    access: "old",
    refresh: "refresh",
    expires: Date.now() - 1,
  };
  await credentials.modify("oauth", async () => expired);
  let refreshes = 0;
  const models = createModels({ credentials });
  models.setProvider(createProvider({
    id: "oauth",
    auth: {
      oauth: {
        name: "OAuth",
        async login() { return expired; },
        async refresh(credential) {
          refreshes += 1;
          await Promise.resolve();
          return { ...credential, access: "new", expires: Date.now() + 60_000 };
        },
        async toAuth(credential) { return { apiKey: credential.access }; },
      },
    },
    models: [model("oauth", "model")],
    api: { async *stream() {} },
  }));
  const [first, second] = await Promise.all([models.getAuth("oauth"), models.getAuth("oauth")]);
  assert.equal(first?.auth.apiKey, "new");
  assert.equal(second?.auth.apiKey, "new");
  assert.equal(refreshes, 1);

  await credentials.modify("failing", async () => expired);
  models.setProvider(createProvider({
    id: "failing",
    auth: {
      oauth: {
        name: "OAuth",
        async login() { return expired; },
        async refresh() { throw new Error("refresh rejected"); },
        async toAuth(credential) { return { apiKey: credential.access }; },
      },
    },
    models: [model("failing", "model")],
    api: { async *stream() {} },
  }));
  await assert.rejects(models.getAuth("failing"), (error: unknown) =>
    error instanceof ProviderModelsError && error.code === "oauth");
  assert.deepEqual(await credentials.read("failing"), expired);
});

test("dynamic provider refresh restores cached catalogs, deduplicates, and reports failures", async () => {
  const credentials = new InMemoryProviderCredentialStore();
  const store = new InMemoryProviderModelsStore();
  await credentials.modify("dynamic", async () => ({ type: "api_key", key: "key" }));
  let fetches = 0;
  const dynamic = () => createProvider({
    id: "dynamic",
    auth: {
      apiKey: {
        name: "Key",
        resolve: async ({ credential }) => credential?.key === undefined
          ? undefined
          : { auth: { apiKey: credential.key } },
      },
    },
    models: [],
    async fetchModels() {
      fetches += 1;
      await Promise.resolve();
      return [model("dynamic", "fetched")];
    },
    api: { async *stream() {} },
  });
  const online = createModels({ credentials, modelsStore: store });
  online.setProvider(dynamic());
  const [left, right] = await Promise.all([online.refresh(), online.refresh()]);
  assert.equal(left.errors.size + right.errors.size, 0);
  assert.equal(fetches, 1);
  assert.equal(online.getModel("dynamic", "fetched")?.id, "fetched");

  const offline = createModels({ credentials, modelsStore: store });
  offline.setProvider(dynamic());
  assert.equal((await offline.refresh({ allowNetwork: false })).errors.size, 0);
  assert.equal(offline.getModel("dynamic", "fetched")?.id, "fetched");

  offline.setProvider({
    ...provider("bad"),
    async refreshModels() { throw new Error("catalog unavailable"); },
  });
  assert.match((await offline.refresh()).errors.get("bad")?.message ?? "", /catalog unavailable/u);
});

test("provider-owned login, availability filtering, logout, and unknown-provider streams are semantic", async () => {
  const credentials = new InMemoryProviderCredentialStore();
  const models = createModels({ credentials });
  const visible = model("login", "visible");
  const hidden = model("login", "hidden");
  models.setProvider(createProvider({
    id: "login",
    auth: {
      apiKey: {
        name: "Key",
        login: async () => ({ type: "api_key", key: "saved" }),
        resolve: async ({ credential }) => credential?.key === undefined
          ? undefined
          : { auth: { apiKey: credential.key }, source: "stored" },
      },
    },
    models: [visible, hidden],
    filterModels: (entries) => entries.filter((entry) => entry.id === "visible"),
    api: { async *stream() {} },
  }));
  assert.deepEqual(await models.getAvailable(), []);
  await models.login("login", "api_key", { prompt: async () => "unused", notify() {} });
  assert.deepEqual((await models.getAvailable()).map((entry) => entry.id), ["visible"]);
  await models.logout("login");
  assert.deepEqual(await credentials.list(), []);

  const events: AdapterEvent[] = [];
  for await (const event of models.stream(model("missing", "model"), { messages: [] })) events.push(event);
  assert.equal(events[0]?.type, "error");
});

test("direct model authentication wraps provider and credential-store failures with stable error codes", async () => {
  const failingAuthModels = createModels();
  failingAuthModels.setProvider(createProvider({
    id: "failing-auth",
    auth: {
      apiKey: {
        name: "Key",
        async check() { throw new Error("check exploded"); },
        async resolve() { throw new Error("resolve exploded"); },
      },
    },
    models: [model("failing-auth", "model")],
    api: { async *stream() {} },
  }));
  await assert.rejects(failingAuthModels.checkAuth("failing-auth"), (error: unknown) =>
    error instanceof ProviderModelsError && error.code === "auth" && /authentication check/u.test(error.message));
  await assert.rejects(failingAuthModels.getAuth("failing-auth"), (error: unknown) =>
    error instanceof ProviderModelsError && error.code === "auth" && error.cause instanceof Error && error.cause.message === "resolve exploded");

  const failingStore = {
    async read() { return undefined; },
    async list() { return []; },
    async modify() { throw new Error("store write exploded"); },
    async delete() { throw new Error("store delete exploded"); },
  } satisfies import("../../src/providers/models.js").ProviderCredentialStore;
  const storedModels = createModels({ credentials: failingStore });
  storedModels.setProvider(createProvider({
    id: "failing-store",
    auth: {
      apiKey: {
        name: "Key",
        async login() { return { type: "api_key", key: "secret" }; },
        async resolve() { return undefined; },
      },
    },
    models: [model("failing-store", "model")],
    api: { async *stream() {} },
  }));
  const interaction = { prompt: async () => "unused", notify() {} };
  await assert.rejects(storedModels.login("failing-store", "api_key", interaction), (error: unknown) =>
    error instanceof ProviderModelsError && error.code === "auth" && /store modify/u.test(error.message));
  await assert.rejects(storedModels.logout("failing-store"), (error: unknown) =>
    error instanceof ProviderModelsError && error.code === "auth" && /store delete/u.test(error.message));
});

test("custom provider stream receives exact provider, model, API and request state", async () => {
  let request: ProviderRequest | undefined;
  const customModel = model("custom", "id", "mistral-conversations");
  const models = createModels();
  models.setProvider(createProvider({
    id: "custom",
    auth: { apiKey: ambientAuth },
    models: [customModel],
    api: {
      async *stream(value) {
        request = value;
      },
    },
  }));
  for await (const _event of models.stream(customModel, { messages: [], tools: [] }, {
    maxOutputTokens: 123,
    reasoningEffort: "high",
    toolChoice: { type: "function", function: { name: "read" } },
    temperature: 0.25,
    cacheRetention: "long",
    sessionId: "session",
  })) {
    // exhaust
  }
  assert.deepEqual(request, {
    provider: "custom",
    model: "id",
    api: "mistral-conversations",
    messages: [],
    tools: [],
    maxOutputTokens: 123,
    reasoningEffort: "high",
    toolChoice: { type: "function", function: { name: "read" } },
    temperature: 0.25,
    cacheRetention: "long",
    sessionId: "session",
  });
});

test("direct model stream conveniences share auth and assemble a canonical completed response", async () => {
  let nativeCalls = 0;
  let simpleCalls = 0;
  const selected = model("completion", "model");
  const models = createModels();
  models.setProvider(createProvider({
    id: "completion",
    auth: { apiKey: ambientAuth },
    models: [selected],
    api: {
      async *stream() {
        nativeCalls += 1;
        yield { type: "response_start", model: "model", responseId: "response-1", requestId: "request-1" };
        yield { type: "text_delta", part: 0, text: "native" };
        yield { type: "response_end", reason: "stop", state: { kind: "openai_responses", outputItems: [] } };
      },
      async *streamSimple() {
        simpleCalls += 1;
        yield { type: "response_start", model: "model" };
        yield { type: "reasoning_delta", part: 0, text: "think", visibility: "summary" };
        yield { type: "text_delta", part: 1, text: "simple" };
        yield { type: "tool_call_end", index: 2, id: "call", name: "read", rawArguments: "{}", arguments: {} };
        yield { type: "usage", semantics: "final", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
        yield { type: "response_end", reason: "tool_calls", state: { kind: "openai_responses", outputItems: [] } };
      },
    },
  }));

  const native = await models.complete(selected, { messages: [] });
  const simple = await models.completeSimple(selected, { messages: [] });
  assert.equal(native.text, "native");
  assert.equal(native.responseId, "response-1");
  assert.equal(native.requestId, "request-1");
  assert.equal(native.finishReason, "stop");
  assert.deepEqual(simple, {
    provider: "completion",
    model: "model",
    text: "simple",
    reasoning: "think",
    toolCalls: [{ index: 2, id: "call", name: "read", rawArguments: "{}", arguments: {} }],
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    finishReason: "tool_calls",
    state: { kind: "openai_responses", outputItems: [] },
  });
  assert.equal(nativeCalls, 1);
  assert.equal(simpleCalls, 1);
});

test("extension model registry replaces built-ins, merges re-registration, and restores originals", async () => {
  const models = createModels();
  const original = provider("replaceable", [model("replaceable", "original")]);
  models.setProvider(original);
  const registry = new ModelRegistry(models);
  await registry.refresh();
  assert.equal(registry.hasConfiguredAuth("replaceable"), true);
  assert.deepEqual(registry.getAvailable().map((entry) => entry.id), ["original"]);
  registry.registerProvider("replaceable", {
    name: "Replacement",
    baseUrl: "https://replacement.test/v1",
    apiKey: "configured-key",
    models: [{
      id: "extension-model",
      name: "Extension model",
      api: "openai-responses",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
      contextWindow: 20_000,
      maxTokens: 2_000,
    }],
  });
  assert.equal(registry.getProviderDisplayName("replaceable"), "Replacement");
  assert.equal(registry.find("replaceable", "extension-model")?.baseUrl, "https://replacement.test/v1");
  assert.deepEqual(registry.getRegisteredProviderIds(), ["replaceable"]);
  registry.registerProvider("replaceable", { headers: { "x-extension": "enabled" } });
  assert.equal(registry.getRegisteredProviderConfig("replaceable")?.name, "Replacement");
  assert.deepEqual(
    await registry.getApiKeyAndHeaders(registry.find("replaceable", "extension-model")!),
    { ok: true, apiKey: "configured-key", headers: { "x-extension": "enabled" } },
  );
  await registry.refresh();
  assert.deepEqual(registry.getAvailable().map((entry) => entry.id), ["extension-model"]);
  registry.unregisterProvider("replaceable");
  assert.equal(registry.getProvider("replaceable"), original);
  assert.equal(registry.find("replaceable", "original")?.id, "original");
  assert.equal(registry.hasConfiguredAuth("replaceable"), true);
  assert.deepEqual(registry.getAvailable().map((entry) => entry.id), ["original"]);
  assert.deepEqual(registry.getRegisteredProviderIds(), []);
});

test("native extension providers are directly visible and unregister without a hidden fallback", () => {
  const models = createModels();
  const registry = new ModelRegistry(models);
  const native = provider("native", [model("native", "model")]);
  registry.registerProvider(native);
  assert.equal(registry.getRegisteredNativeProvider("native"), native);
  assert.equal(registry.find("native", "model")?.id, "model");
  registry.unregisterProvider("native");
  assert.equal(registry.getProvider("native"), undefined);
});

test("direct models bridge into the run loop without changing model or request semantics", async () => {
  const selected = {
    ...model("bridge", "model", "anthropic-messages"),
    reasoning: true,
    thinkingLevelMap: { high: "provider-high" },
  } satisfies ProviderModel;
  let observed: ProviderRequest | undefined;
  const models = createModels();
  models.setProvider(createProvider({
    id: "bridge",
    auth: { apiKey: ambientAuth },
    models: [selected],
    api: {
      async *stream(request) {
        observed = request;
        yield { type: "response_start", model: request.model };
      },
    },
  }));
  const adapter = providerAdapterFromModels(models, "bridge");
  const controller = new AbortController();
  assert.equal((await adapter.listModels(controller.signal))[0]?.compatibility?.protocolFamily?.value, "anthropic-messages");
  const events: AdapterEvent[] = [];
  for await (const event of adapter.stream({
    provider: "bridge",
    model: "model",
    api: "anthropic-messages",
    messages: [],
    tools: [],
    reasoningEffort: "high",
  }, controller.signal)) events.push(event);
  assert.equal(events[0]?.type, "response_start");
  assert.equal(observed?.reasoningEffort, "provider-high");
  const info = providerModelToInfo(selected);
  assert.equal(info.provider, "bridge");
  assert.equal(info.capabilities.reasoning.value, "supported");
});

test("thinking support and tiered cache pricing follow direct model declarations", () => {
  const priced = {
    ...model("priced", "model"),
    reasoning: true,
    thinkingLevelMap: { minimal: null, xhigh: "extra-high" },
    cost: {
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 1.25,
      tiers: [{ inputTokensAbove: 100, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 }],
    },
  } satisfies ProviderModel;
  assert.deepEqual(getSupportedThinkingLevels(priced), ["off", "low", "medium", "high", "xhigh"]);
  assert.equal(clampThinkingLevel(priced, "minimal"), "low");
  const cost = calculateCost(priced, {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 10,
    cacheWrite1hTokens: 4,
  });
  assert.ok(Math.abs(cost.input - 0.0002) < Number.EPSILON);
  assert.ok(Math.abs(cost.output - 0.0002) < Number.EPSILON);
  assert.ok(Math.abs(cost.cacheRead - 0.000002) < Number.EPSILON);
  assert.ok(Math.abs(cost.cacheWrite - 0.000031) < Number.EPSILON);
  assert.ok(Math.abs(cost.total - 0.000433) < Number.EPSILON);
});
