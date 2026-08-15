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
  environmentProviderAuth,
  getSupportedThinkingLevels,
  modelCacheReadPrice,
  type Provider,
  type ProviderApiKeyAuth,
  type ProviderCredential,
  type ProviderCredentialStore,
  type ProviderModel,
  type ProviderModelsStore,
  type ProviderStreamOptions,
  type MutableModels,
} from "../../src/providers/index.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import {
  providerAdapterFromModels,
  providerFromAdapter,
  providerModelFromInfo,
  providerModelToInfo,
} from "../../src/providers/internal-runtime-bridge.js";
import { modelReasoningEfforts, ProviderRegistry } from "../../src/providers/registry.js";

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

let completionProviderSequence = 0;

async function completeEvents(events: readonly AdapterEvent[]) {
  const providerId = `completion-boundary-${completionProviderSequence++}`;
  const selected = model(providerId, "model");
  const models = createModels();
  models.setProvider(createProvider({
    id: providerId,
    auth: { apiKey: ambientAuth },
    models: [selected],
    api: {
      async *stream() {
        yield* events;
      },
    },
  }));
  return models.complete(selected, { messages: [] });
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

test("provider credential mutation lanes release settled IDs and preserve same-ID ordering", async () => {
  const credentials = new InMemoryProviderCredentialStore();
  const failure = new Error("provider credential mutation failed");
  await assert.rejects(
    credentials.modify("released", async () => { throw failure; }),
    (error: unknown) => error === failure,
  );

  const resolveDescriptor = Object.getOwnPropertyDescriptor(Promise, "resolve");
  assert.ok(resolveDescriptor);
  const originalResolve = resolveDescriptor.value as (value?: unknown) => Promise<unknown>;
  let freshLaneStarts = 0;
  let afterFailure!: Promise<void>;
  Object.defineProperty(Promise, "resolve", {
    ...resolveDescriptor,
    value(value?: unknown) {
      freshLaneStarts += 1;
      return Reflect.apply(originalResolve, Promise, [value]) as Promise<unknown>;
    },
  });
  try {
    afterFailure = credentials.delete("released");
  } finally {
    Object.defineProperty(Promise, "resolve", resolveDescriptor);
  }
  assert.equal(freshLaneStarts, 1);
  await afterFailure;

  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let markFirstStarted!: () => void;
  let markSecondStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  const order: string[] = [];
  const firstCredential = { type: "api_key" as const, key: "first" };
  const secondCredential = { type: "api_key" as const, key: "second" };
  const first = credentials.modify("ordered", async () => {
    order.push("first:start");
    markFirstStarted();
    await firstGate;
    order.push("first:end");
    return firstCredential;
  });
  const second = credentials.modify("ordered", async (current) => {
    order.push("second:start");
    assert.deepEqual(current, firstCredential);
    markSecondStarted();
    await secondGate;
    order.push("second:end");
    return secondCredential;
  });
  await firstStarted;
  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  await secondStarted;
  const third = credentials.modify("ordered", async (current) => {
    order.push("third");
    assert.deepEqual(current, secondCredential);
    return current;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
  releaseSecond();
  await Promise.all([first, second, third]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end", "third"]);
});

test("direct model streams contain hostile transform failures without inspection", async () => {
  const models = createModels();
  const selected = model("hostile-transform", "model");
  models.setProvider(createProvider({
    id: selected.provider,
    auth: { apiKey: ambientAuth },
    models: [selected],
    api: { async *stream() {} },
  }));
  let traps = 0;
  const failure = new Proxy(new Error("transform failed"), {
    getPrototypeOf() {
      traps += 1;
      throw new Error("transform failure was inspected");
    },
  });
  const events: AdapterEvent[] = [];

  for await (const event of models.stream(selected, { messages: [] }, {
    transformHeaders() { throw failure; },
  })) events.push(event);

  assert.equal(traps, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  if (events[0]?.type === "error") assert.equal(events[0].error.message, "[Thrown object]");
});

test("direct model refresh contains hostile provider failures without inspection", async () => {
  const models = createModels();
  const selected = model("hostile-refresh", "model");
  let traps = 0;
  const failure = new Proxy(new Error("refresh failed"), {
    getPrototypeOf() {
      traps += 1;
      throw new Error("refresh failure was inspected");
    },
  });
  models.setProvider(createProvider({
    id: selected.provider,
    auth: { apiKey: ambientAuth },
    models: [selected],
    async fetchModels() { throw failure; },
    api: { async *stream() {} },
  }));

  const result = await models.refresh();

  assert.equal(traps, 0);
  assert.equal(result.errors.get(selected.provider)?.message, "[Thrown object]");
});

test("built-in provider identities are canonical and unique", () => {
  assert.equal(BUILTIN_PROVIDER_DESCRIPTORS.length, 12);
  assert.equal(new Set(BUILTIN_PROVIDER_DESCRIPTORS.map((entry) => entry.id)).size, 12);
  assert.equal(canonicalProviderId("gemini"), "google");
  assert.equal(canonicalProviderId("vertex"), "vertex");
  assert.deepEqual(
    BUILTIN_PROVIDER_DESCRIPTORS.find((entry) => entry.id === "anthropic")?.environment,
    ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  );
  assert.equal(BUILTIN_PROVIDER_DESCRIPTORS.find((entry) => entry.id === "anthropic")?.oauth, true);
  assert.deepEqual(
    BUILTIN_PROVIDER_DESCRIPTORS.find((entry) => entry.id === "openai-codex")?.environment,
    [],
  );
  assert.deepEqual(
    BUILTIN_PROVIDER_DESCRIPTORS.find((entry) => entry.id === "opencode-go")?.environment,
    ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"],
  );
  assert.deepEqual(
    BUILTIN_PROVIDER_DESCRIPTORS.find((entry) => entry.id === "kimi-code")?.environment,
    ["KIMI_CODE_API_KEY"],
  );
});

test("Anthropic bearer tokens use Authorization without masquerading as API keys", async () => {
  const descriptor = BUILTIN_PROVIDER_DESCRIPTORS.find((entry) => entry.id === "anthropic");
  assert.ok(descriptor);
  const auth = environmentProviderAuth(descriptor);
  assert.deepEqual(await auth.resolve({
    credential: { type: "api_key", key: "sk-ant-oat-saved" },
    ctx: {
      async env() { return undefined; },
      async fileExists() { return false; },
    },
  }), {
    auth: { headers: { Authorization: "Bearer sk-ant-oat-saved" } },
    source: "stored credential",
  });
  assert.deepEqual(await auth.resolve({
    ctx: {
      async env(name) { return name === "ANTHROPIC_AUTH_TOKEN" ? "bearer-secret" : undefined; },
      async fileExists() { return false; },
    },
  }), {
    auth: { headers: { Authorization: "Bearer bearer-secret" } },
    source: "ANTHROPIC_AUTH_TOKEN",
  });
  assert.deepEqual(await auth.resolve({
    ctx: {
      async env(name) { return name === "ANTHROPIC_OAUTH_TOKEN" ? "oauth-secret" : undefined; },
      async fileExists() { return false; },
    },
  }), {
    auth: { headers: { Authorization: "Bearer oauth-secret" } },
    source: "ANTHROPIC_OAUTH_TOKEN",
  });
});

test("provider auth rejects unprotectable API keys and sensitive headers but permits short ordinary headers", async () => {
  const models = createModels();
  const selected = model("auth-boundary", "model");
  let mode: "api_key" | "sensitive_header" | "ordinary_header" = "api_key";
  models.setProvider(createProvider({
    id: "auth-boundary",
    auth: {
      apiKey: {
        name: "Boundary key",
        async resolve() {
          if (mode === "api_key") return { auth: { apiKey: "abc" } };
          if (mode === "sensitive_header") {
            return { auth: { headers: { Authorization: "Bearer xyz" } } };
          }
          return { auth: { headers: { "x-mode": "ok" } } };
        },
      },
    },
    models: [selected],
    api: { async *stream() {} },
  }));

  await assert.rejects(models.getAuth(selected), ProviderModelsError);
  mode = "sensitive_header";
  await assert.rejects(models.getAuth(selected), ProviderModelsError);
  mode = "ordinary_header";
  assert.deepEqual((await models.getAuth(selected))?.auth.headers, { "x-mode": "ok" });

  const events: AdapterEvent[] = [];
  for await (const event of models.stream(selected, { messages: [] }, {
    transformHeaders: () => ({ Authorization: "Bearer xyz" }),
  })) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  assert.match(events[0]?.type === "error" ? events[0].error.message : "", /at least 4 characters/u);
});

test("extension provider configuration rejects short credentials without rejecting ordinary short headers", async () => {
  const models = createModels();
  const registry = new ModelRegistry(models);
  const definition = {
    id: "model",
    name: "Model",
    api: "openai-responses" as const,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10_000,
    maxTokens: 1_000,
  };

  registry.registerProvider("short-config", {
    name: "Short config",
    baseUrl: "https://short-config.example.test/v1",
    apiKey: "abc",
    models: [definition],
  });
  const shortKey = await registry.getApiKeyAndHeaders(registry.find("short-config", "model")!);
  assert.equal(shortKey.ok, false);

  registry.registerProvider("ordinary-header", {
    name: "Ordinary header",
    baseUrl: "https://ordinary-header.example.test/v1",
    headers: { "x-mode": "ok" },
    models: [definition],
  });
  assert.deepEqual(
    await registry.getApiKeyAndHeaders(registry.find("ordinary-header", "model")!),
    { ok: true, headers: { "x-mode": "ok" } },
  );

  registry.registerProvider("sensitive-header", {
    name: "Sensitive header",
    baseUrl: "https://sensitive-header.example.test/v1",
    headers: { "x-api-key": "abc" },
    models: [definition],
  });
  const shortHeader = await registry.getApiKeyAndHeaders(registry.find("sensitive-header", "model")!);
  assert.equal(shortHeader.ok, false);
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

test("adapter bridges can share the authoritative catalog refresh path", async () => {
  let adapterRefreshes = 0;
  let catalogRefreshes = 0;
  const selected = model("shared-catalog", "discovered");
  const models = createModels();
  models.setProvider(providerFromAdapter({
    id: "shared-catalog",
    async *stream() {},
    async listModels() {
      adapterRefreshes += 1;
      return [];
    },
  }, {
    auth: { apiKey: ambientAuth },
    async listModels(signal) {
      signal.throwIfAborted();
      catalogRefreshes += 1;
      return [providerModelToInfo(selected)];
    },
  }));

  assert.equal((await models.refresh()).errors.size, 0);
  assert.equal(adapterRefreshes, 0);
  assert.equal(catalogRefreshes, 1);
  assert.equal(models.getModel("shared-catalog", "discovered")?.id, "discovered");
});

test("adapter bridges retain incomplete live metadata without writing an invalid persistent cache", async () => {
  let writes = 0;
  const observedAt = "2026-08-13T00:00:00.000Z";
  const unknown = { value: "unknown" as const, source: "provider" as const, observedAt };
  const models = createModels({
    modelsStore: {
      async read() { return undefined; },
      async write(_providerId, entry) {
        writes += 1;
        assert.equal(entry.models.every((model) => model.contextWindow > 0 && model.maxTokens > 0), true);
      },
      async delete() {},
    },
  });
  models.setProvider(providerFromAdapter({
    id: "incomplete-live-catalog",
    async *stream() {},
    async listModels() { return []; },
  }, {
    auth: { apiKey: ambientAuth },
    async listModels() {
      return [{
        id: "unknown-output-limit",
        provider: "incomplete-live-catalog",
        contextTokens: 128_000,
        capabilities: { tools: unknown, reasoning: unknown, images: unknown },
        compatibility: {
          protocolFamily: { value: "openai-responses", source: "provider", observedAt },
        },
      }];
    },
  }));

  assert.equal((await models.refresh()).errors.size, 0);
  const selected = models.getModel("incomplete-live-catalog", "unknown-output-limit");
  assert.ok(selected);
  assert.equal(providerModelToInfo(selected).maxOutputTokens, undefined);
  assert.equal(writes, 0);
});

test("adapter bridges preserve safe request options without copying credentials into ProviderRequest", async () => {
  const requests: ProviderRequest[] = [];
  const privateOptions: ProviderStreamOptions[] = [];
  const selected = {
    ...model("adapter-options", "model"),
    name: "Adapter options model",
    reasoning: true,
    thinkingLevelMap: { high: "provider-high" },
    headers: { "x-model-safe": "yes" },
    compat: { supportsStore: false },
  };
  const adapter = {
    id: selected.provider,
    async *stream(request: ProviderRequest, _signal: AbortSignal) {
      yield { type: "response_start" as const, model: request.model };
    },
    async listModels() {
      return [providerModelToInfo(selected)];
    },
  };
  const bridged = providerFromAdapter(adapter, {
    auth: { apiKey: ambientAuth },
    initialModels: [providerModelToInfo(selected)],
    model: () => selected,
    streamRequest(request, streamOptions, signal) {
      requests.push(request);
      privateOptions.push(streamOptions);
      return adapter.stream(request, signal);
    },
  });
  const bridgedModel = bridged.getModels()[0]!;
  const secret = "bridge-request-secret";
  const onPayload = (payload: unknown): unknown => payload;
  const onResponse = (): void => {};
  const fetchImplementation = async () => new Response();
  const transformHeaders = (headers: Record<string, string | null>) => headers;
  const options = {
    timeoutMs: 123,
    maxRetries: 2,
    maxRetryDelayMs: 456,
    toolChoice: "required" as const,
    temperature: 0.25,
    cacheRetention: "long" as const,
    reasoningEffort: "high",
    thinkingBudgets: { high: 4_096 },
    sessionId: "bridge-session",
    metadata: { operation: "bridge-contract" },
    transport: "sse" as const,
    websocketConnectTimeoutMs: 321,
    websocketIdleTimeoutMs: 654,
    onPayload,
    onResponse,
    fetch: fetchImplementation,
    transformHeaders,
    apiKey: secret,
    authSource: "configuration" as const,
    env: { PROVIDER_SECRET: secret },
    headers: { authorization: `Bearer ${secret}` },
  };

  for await (const _event of bridged.stream(bridgedModel, { messages: [] }, options)) {
    // exhaust
  }
  for await (const _event of bridged.streamSimple(bridgedModel, { messages: [] }, options)) {
    // exhaust
  }

  assert.equal(requests.length, 2);
  assert.equal(privateOptions.length, 2);
  for (const privateOption of privateOptions) {
    assert.equal(privateOption.apiKey, secret);
    assert.equal(privateOption.authSource, "configuration");
    assert.deepEqual(privateOption.env, { PROVIDER_SECRET: secret });
    assert.deepEqual(privateOption.headers, { authorization: `Bearer ${secret}` });
    assert.equal(privateOption.fetch, fetchImplementation);
    assert.equal(privateOption.websocketConnectTimeoutMs, 321);
    assert.equal(privateOption.websocketIdleTimeoutMs, 654);
    assert.equal(privateOption.transformHeaders, transformHeaders);
  }
  for (const request of requests) {
    assert.equal(request.timeoutMs, 123);
    assert.equal(request.maxRetries, 2);
    assert.equal(request.maxRetryDelayMs, 456);
    assert.equal(request.toolChoice, "required");
    assert.equal(request.temperature, 0.25);
    assert.equal(request.cacheRetention, "long");
    assert.equal(request.reasoningEffort, "high");
    assert.deepEqual(request.thinkingBudgets, { high: 4_096 });
    assert.equal(request.sessionId, "bridge-session");
    assert.deepEqual(request.metadata, { operation: "bridge-contract" });
    assert.equal(request.transport, "sse");
    assert.equal(request.onPayload, onPayload);
    assert.equal(request.onResponse, onResponse);
    assert.deepEqual(request.modelSettings, {
      displayName: "Adapter options model",
      headers: { "x-model-safe": "yes" },
      reasoningEffortMap: { high: "provider-high" },
      compatibility: { supportsStore: false },
    });
    assert.doesNotMatch(JSON.stringify(request), new RegExp(secret, "u"));
    assert.equal("apiKey" in request, false);
    assert.equal("env" in request, false);
  }
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
        value: ["off", "low", "high", "xhigh", "max", "ultra"],
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

test("unknown reasoning metadata is conservative in model bridges unless efforts are reported", () => {
  const observedAt = "2026-07-22T00:00:00.000Z";
  const unknown = { value: "unknown" as const, source: "provider" as const, observedAt };
  const base = {
    id: "unknown-model",
    provider: "unknown-provider",
    capabilities: { tools: unknown, reasoning: unknown, images: unknown },
    compatibility: {
      protocolFamily: { value: "openai-responses" as const, source: "provider" as const, observedAt },
    },
  };
  assert.deepEqual(modelReasoningEfforts(base), ["off"]);
  assert.deepEqual(getSupportedThinkingLevels(providerModelFromInfo(base)), ["off"]);

  const supportedWithoutEfforts = {
    ...base,
    capabilities: { ...base.capabilities, reasoning: { ...unknown, value: "supported" as const } },
  };
  assert.deepEqual(modelReasoningEfforts(supportedWithoutEfforts), [
    "off", "minimal", "low", "medium", "high",
  ]);

  const reported = {
    ...base,
    compatibility: {
      ...base.compatibility,
      reasoningEfforts: { value: ["low", "high"], source: "provider" as const, observedAt },
    },
  };
  assert.deepEqual(modelReasoningEfforts(reported), ["low", "high"]);
  assert.deepEqual(getSupportedThinkingLevels(providerModelFromInfo(reported)), ["low", "high"]);
});

test("model bridges can use a provider-owned protocol without fabricating sparse metadata", () => {
  const observedAt = "2026-07-22T00:00:00.000Z";
  const unknown = { value: "unknown" as const, source: "maintained" as const, observedAt };
  const info = {
    id: "fallback-model",
    provider: "custom",
    capabilities: { tools: unknown, reasoning: unknown, images: unknown },
  };
  assert.throws(() => providerModelFromInfo(info), /does not declare an API protocol/u);
  const bridged = providerModelFromInfo(info, "openai-chat-completions");
  assert.equal(bridged.api, "openai-chat-completions");
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
  let observedScopedEnvironment: string | undefined;
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
    headers: { "x-provider": "provider", "x-shared": "provider" },
    auth: {
      apiKey: {
        name: "Key",
        resolve: async ({ credential, ctx }) => {
          observedScopedEnvironment = await ctx.env("SHARED");
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
  assert.equal(observedScopedEnvironment, "stored");
  assert.deepEqual(resolved?.auth.headers, {
    "x-provider": "provider",
    "x-auth": "yes",
    "x-model": "model",
    "x-shared": "model",
  });

  for await (const _event of models.stream(ownedModel, { messages: [] }, {
    apiKey: "request",
    headers: { "X-SHARED": "request", "x-request": "yes" },
    env: { SHARED: "request", REQUEST: "yes" },
    transformHeaders: (headers) => ({ ...headers, "x-transformed": "yes" }),
  })) {
    // exhaust
  }
  assert.equal(observed?.apiKey, "request");
  assert.equal(observedScopedEnvironment, "request");
  assert.deepEqual(observed?.env, { SHARED: "request", REQUEST: "yes" });
  assert.deepEqual(observed?.headers, {
    "x-provider": "provider",
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
    access: "old-token",
    refresh: "refresh",
    expires: Date.now() - 1,
  };
  await credentials.modify("oauth", async () => expired);
  let refreshes = 0;
  const models = createModels({ credentials });
  const oauthModel = {
    ...model("oauth", "model"),
    headers: { "x-shared": "model", "x-model": "yes" },
  };
  models.setProvider(createProvider({
    id: "oauth",
    headers: { "x-provider": "yes", "x-shared": "provider" },
    auth: {
      oauth: {
        name: "OAuth",
        async login() { return expired; },
        async refresh(credential) {
          refreshes += 1;
          await Promise.resolve();
          return { ...credential, access: "new-token", expires: Date.now() + 60 * 60_000 };
        },
        async toAuth(credential) {
          return { apiKey: credential.access, headers: { "X-Shared": "auth", "x-auth": "yes" } };
        },
      },
    },
    models: [oauthModel],
    api: { async *stream() {} },
  }));
  const [first, second] = await Promise.all([models.getAuth("oauth"), models.getAuth("oauth")]);
  assert.equal(first?.auth.apiKey, "new-token");
  assert.equal(second?.auth.apiKey, "new-token");
  assert.equal(refreshes, 1);
  assert.deepEqual((await models.getAuth(oauthModel))?.auth.headers, {
    "x-provider": "yes",
    "x-auth": "yes",
    "x-model": "yes",
    "x-shared": "model",
  });

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
    error instanceof ProviderModelsError &&
    error.code === "oauth" &&
    error.message === "Could not refresh OAuth credentials for failing" &&
    error.cause instanceof Error &&
    error.cause.message === "refresh rejected");
  assert.deepEqual(await credentials.read("failing"), expired);
});

test("OAuth refresh contains hostile credential-store failures without reflection", async () => {
  const expired = {
    type: "oauth" as const,
    access: "old-token",
    refresh: "refresh",
    expires: Date.now() - 1,
  };
  let traps = 0;
  const hostile = new Proxy({}, {
    get() { traps += 1; throw new Error("get trap"); },
    getPrototypeOf() { traps += 1; throw new Error("prototype trap"); },
  });
  const credentials = {
    async read() { return expired; },
    async list() { return []; },
    async modify() { throw hostile; },
    async delete() {},
  } satisfies import("../../src/providers/models.js").ProviderCredentialStore;
  const models = createModels({ credentials });
  models.setProvider(createProvider({
    id: "hostile-store",
    auth: {
      oauth: {
        name: "OAuth",
        async login() { return expired; },
        async refresh(credential) { return credential; },
        async toAuth(credential) { return { apiKey: credential.access }; },
      },
    },
    models: [model("hostile-store", "model")],
    api: { async *stream() {} },
  }));

  await assert.rejects(models.getAuth("hostile-store"), (error: unknown) =>
    error instanceof ProviderModelsError
    && error.code === "auth"
    && error.message === "Unable to update saved credentials for hostile-store");
  assert.equal(traps, 0);
});

test("OAuth auth refreshes before expiry and honors a validated caller freshness requirement", async () => {
  const credentials = new InMemoryProviderCredentialStore();
  const models = createModels({ credentials });
  const refreshes: string[] = [];
  models.setProvider(createProvider({
    id: "freshness",
    auth: {
      oauth: {
        name: "OAuth",
        async login() {
          throw new Error("unused");
        },
        async refresh(credential, signal) {
          signal?.throwIfAborted();
          refreshes.push(credential.access);
          return {
            ...credential,
            access: `fresh-${refreshes.length}`,
            expires: Date.now() + 60 * 60_000,
          };
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
    models: [model("freshness", "model")],
    api: { async *stream() {} },
  }));

  await credentials.modify("freshness", async () => ({
    type: "oauth",
    access: "near-expiry",
    refresh: "refresh",
    expires: Date.now() + 60_000,
  }));
  assert.equal((await models.getAuth("freshness"))?.auth.apiKey, "fresh-1");

  await credentials.modify("freshness", async () => ({
    type: "oauth",
    access: "ten-minutes",
    refresh: "refresh",
    expires: Date.now() + 10 * 60_000,
  }));
  assert.equal(
    (await models.getAuth("freshness", { minOAuthValidityMs: 30 * 60_000 }))?.auth.apiKey,
    "fresh-2",
  );
  assert.deepEqual(refreshes, ["near-expiry", "ten-minutes"]);

  await assert.rejects(
    models.getAuth("freshness", { minOAuthValidityMs: Number.NaN }),
    /minOAuthValidityMs must be a non-negative safe integer/u,
  );
  await assert.rejects(
    models.getAuth("freshness", { minOAuthValidityMs: -1 }),
    /minOAuthValidityMs must be a non-negative safe integer/u,
  );
  await assert.rejects(
    models.getAuth("freshness", { minOAuthValidityMs: 1.5 }),
    /minOAuthValidityMs must be a non-negative safe integer/u,
  );
  await assert.rejects(
    models.getAuth("freshness", { minOAuthValidityMs: Number.MAX_SAFE_INTEGER + 1 }),
    /minOAuthValidityMs must be a non-negative safe integer/u,
  );
});

test("an explicit one-minute OAuth freshness requirement accepts a four-minute rotated credential", async () => {
  const credentials = new InMemoryProviderCredentialStore();
  const models = createModels({ credentials });
  await credentials.modify("bounded-freshness", async () => ({
    type: "oauth",
    access: "old",
    refresh: "refresh",
    expires: Date.now() + 30_000,
  }));
  models.setProvider(createProvider({
    id: "bounded-freshness",
    auth: {
      oauth: {
        name: "OAuth",
        async login() {
          throw new Error("unused");
        },
        async refresh(credential) {
          return { ...credential, access: "rotated", expires: Date.now() + 4 * 60_000 };
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
    models: [model("bounded-freshness", "model")],
    api: { async *stream() {} },
  }));

  assert.equal(
    (await models.getAuth("bounded-freshness", { minOAuthValidityMs: 60_000 }))?.auth.apiKey,
    "rotated",
  );
});

test("an explicit OAuth freshness requirement rejects an insufficient rotated credential", async () => {
  const credentials = new InMemoryProviderCredentialStore();
  const models = createModels({ credentials });
  await credentials.modify("short-lived", async () => ({
    type: "oauth",
    access: "old",
    refresh: "refresh",
    expires: Date.now() + 60_000,
  }));
  models.setProvider(createProvider({
    id: "short-lived",
    auth: {
      oauth: {
        name: "OAuth",
        async login() {
          throw new Error("unused");
        },
        async refresh(credential) {
          return { ...credential, access: "still-short", expires: Date.now() + 2 * 60_000 };
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
    models: [model("short-lived", "model")],
    api: { async *stream() {} },
  }));

  await assert.rejects(
    models.getAuth("short-lived", { minOAuthValidityMs: 15 * 60_000 }),
    (error: unknown) =>
      error instanceof ProviderModelsError
      && error.code === "oauth"
      && /did not provide the requested validity/u.test(error.message),
  );
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

test("one models refresh hydrates all provider caches from one store snapshot", async () => {
  const credentials = new InMemoryProviderCredentialStore();
  for (const providerId of ["snapshot-a", "snapshot-b"]) {
    await credentials.modify(providerId, async () => ({ type: "api_key", key: `${providerId}-key` }));
  }
  let snapshots = 0;
  let backingReads = 0;
  let snapshotReads = 0;
  const store: ProviderModelsStore = {
    async read() {
      backingReads += 1;
      throw new Error("backing store should not be read after snapshot creation");
    },
    async write() {},
    async delete() {},
    async snapshot() {
      snapshots += 1;
      return {
        async read(providerId, cacheScope) {
          snapshotReads += 1;
          return {
            models: [model(providerId, "cached")],
            ...(cacheScope === undefined ? {} : { cacheScope }),
          };
        },
        async write() {},
        async delete() {},
      };
    },
  };
  const models = createModels({ credentials, modelsStore: store });
  for (const providerId of ["snapshot-a", "snapshot-b"]) {
    models.setProvider(createProvider({
      id: providerId,
      auth: {
        apiKey: {
          name: "Key",
          async resolve({ credential }) {
            return credential?.key === undefined ? undefined : { auth: { apiKey: credential.key } };
          },
        },
      },
      models: [],
      async fetchModels() { return []; },
      api: { async *stream() {} },
    }));
  }

  assert.equal((await models.refresh({ allowNetwork: false })).errors.size, 0);
  assert.equal(snapshots, 1);
  assert.equal(backingReads, 0);
  assert.equal(snapshotReads, 2);
  assert.deepEqual(models.getModels().map((entry) => `${entry.provider}/${entry.id}`), [
    "snapshot-a/cached",
    "snapshot-b/cached",
  ]);
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

test("provider-owned login carries cancellation through the credential commit", async () => {
  const controller = new AbortController();
  const cancellation = new Error("login cancelled before storage");
  let stored = false;
  const credentials = {
    async read() { return undefined; },
    async list() { return []; },
    async modify(
      _provider: string,
      update: (current: ProviderCredential | undefined) => Promise<ProviderCredential | undefined>,
      signal?: AbortSignal,
    ): Promise<ProviderCredential | undefined> {
      const replacement = await update(undefined);
      controller.abort(cancellation);
      signal?.throwIfAborted();
      stored = replacement !== undefined;
      return replacement;
    },
    async delete() {},
  } satisfies ProviderCredentialStore;
  const models = createModels({ credentials });
  models.setProvider(createProvider({
    id: "cancelled-login",
    auth: {
      apiKey: {
        name: "Key",
        async login() { return { type: "api_key", key: "late-secret" }; },
        async resolve() { return undefined; },
      },
    },
    models: [],
    api: { async *stream() {} },
  }));

  await assert.rejects(
    models.login("cancelled-login", "api_key", {
      signal: controller.signal,
      async prompt() { return "unused"; },
      notify() {},
    }),
    (error: unknown) => error instanceof ProviderModelsError && error.cause === cancellation,
  );
  assert.equal(stored, false);
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
    error instanceof ProviderModelsError &&
    error.code === "auth" &&
    error.message === "API key authentication check failed for provider failing-auth" &&
    error.cause instanceof Error &&
    error.cause.message === "check exploded");
  await assert.rejects(failingAuthModels.getAuth("failing-auth"), (error: unknown) =>
    error instanceof ProviderModelsError &&
    error.code === "auth" &&
    error.message === "API key authentication failed for provider failing-auth" &&
    error.cause instanceof Error &&
    error.cause.message === "resolve exploded");

  const opaqueToken = "opaque_7Fm2Qr9Vx6Lt4Ns8";
  const cause = new Error(`provider rejected ${opaqueToken}`);
  const sensitive = new ProviderModelsError("auth", "Auth failed", {
    cause,
  });
  assert.equal(sensitive.cause, cause);
  assert.equal(sensitive.message, "Auth failed");
  assert.doesNotMatch(sensitive.message, new RegExp(opaqueToken, "u"));
  assert.doesNotMatch(String(sensitive), new RegExp(opaqueToken, "u"));
  assert.doesNotMatch(JSON.stringify(sensitive), new RegExp(opaqueToken, "u"));

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
    error instanceof ProviderModelsError && error.code === "auth" && /save credentials/u.test(error.message));
  await assert.rejects(storedModels.logout("failing-store"), (error: unknown) =>
    error instanceof ProviderModelsError && error.code === "auth" && /remove credentials/u.test(error.message));
});

test("custom provider stream receives exact provider, model, API and request state", async () => {
  let request: ProviderRequest | undefined;
  const customModel = model("custom", "id", "openai-chat-completions");
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
    api: "openai-chat-completions",
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
  assert.ok(native.requestId === "request-1" || native.requestId === "[REDACTED]-1");
  assert.equal(native.finishReason, "stop");
  const { state: simpleState, ...simpleCompletion } = simple;
  assert.deepEqual(simpleCompletion, {
    provider: "completion",
    model: "model",
    text: "simple",
    reasoning: "think",
    toolCalls: [{ index: 2, id: "call", name: "read", rawArguments: "{}", arguments: {} }],
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    finishReason: "tool_calls",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(simpleState)), {
    kind: "openai_responses",
    outputItems: [],
    source: { provider: "completion", model: "model", api: "openai-responses" },
  });
  assert.equal(nativeCalls, 1);
  assert.equal(simpleCalls, 1);
});

test("direct completion reconciles authoritative end and terminal content", async () => {
  const ended = await completeEvents([
    { type: "text_delta", part: 0, text: "hel" },
    { type: "text_end", part: 0, text: "hello" },
    { type: "reasoning_end", part: 1, text: "thought", visibility: "summary" },
    { type: "response_end", reason: "stop", state: { kind: "openai_responses", outputItems: [] } },
  ]);
  assert.equal(ended.text, "hello");
  assert.equal(ended.reasoning, "thought");

  const terminal = await completeEvents([
    { type: "text_delta", part: 0, text: "term" },
    {
      type: "response_end",
      reason: "tool_calls",
      state: { kind: "openai_responses", outputItems: [] },
      content: [
        { type: "text", text: "terminal" },
        { type: "thinking", thinking: "trace", visibility: "provider_trace" },
        { type: "tool_call", callId: "terminal-call", name: "read", arguments: {}, rawArguments: "{}" },
      ],
    },
  ]);
  assert.equal(terminal.text, "terminal");
  assert.equal(terminal.reasoning, "trace");
  assert.deepEqual(terminal.toolCalls, [{
    index: 2,
    id: "terminal-call",
    name: "read",
    arguments: {},
    rawArguments: "{}",
  }]);

  const rawOnly = await completeEvents([
    { type: "tool_call_end", index: 0, name: "read", rawArguments: "{\"path\":\"/tmp/input\"}" },
    {
      type: "response_end",
      reason: "tool_calls",
      state: { kind: "openai_responses", outputItems: [] },
    },
  ]);
  assert.deepEqual(rawOnly.toolCalls, [{
    index: 0,
    name: "read",
    rawArguments: "{\"path\":\"/tmp/input\"}",
  }]);

  await assert.rejects(completeEvents([
    { type: "text_delta", part: 0, text: "prefix" },
    { type: "text_end", part: 0, text: "other" },
  ]), /streamed prefix/u);
  await assert.rejects(completeEvents([
    { type: "text_delta", part: 0, text: "prefix" },
    {
      type: "response_end",
      reason: "stop",
      state: { kind: "openai_responses", outputItems: [] },
      content: [{ type: "text", text: "other" }],
    },
  ]), /streamed text/u);
  await assert.rejects(completeEvents([
    { type: "text_delta", part: 5, text: "visible" },
    {
      type: "response_end",
      reason: "stop",
      state: { kind: "openai_responses", outputItems: [] },
      content: [{ type: "text", text: "different part" }],
    },
  ]), /omitted or replaced streamed text/u);
  await assert.rejects(completeEvents([
    { type: "reasoning_delta", part: 1, text: "thought", visibility: "summary" },
    {
      type: "response_end",
      reason: "stop",
      state: { kind: "openai_responses", outputItems: [] },
      content: [{ type: "text", text: "answer" }, { type: "text", text: "wrong type" }],
    },
  ]), /omitted or replaced streamed reasoning/u);
  await assert.rejects(completeEvents([
    { type: "tool_call_end", index: 0, id: "streamed", name: "read", rawArguments: "{}", arguments: {} },
    {
      type: "response_end",
      reason: "stop",
      state: { kind: "openai_responses", outputItems: [] },
      content: [],
    },
  ]), /omitted or replaced a streamed tool call/u);
  await assert.rejects(completeEvents([
    { type: "tool_call_end", index: 0, id: "streamed", name: "read", rawArguments: "{}", arguments: {} },
    {
      type: "response_end",
      reason: "stop",
      state: { kind: "openai_responses", outputItems: [] },
      content: [{ type: "tool_call", callId: "changed", name: "read", arguments: {}, rawArguments: "[]" }],
    },
  ]), /omitted or replaced a streamed tool call/u);
});

test("direct completion validates, detaches, and owns continuation state provenance", async () => {
  const sourceState = {
    kind: "openai_responses" as const,
    outputItems: [{ value: "stable" }],
    source: { provider: "lying-provider", model: "lying-model", api: "openai-responses" as const },
  };
  const completion = await completeEvents([
    { type: "response_end", reason: "stop", state: sourceState },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(completion.state)), {
    kind: "openai_responses",
    outputItems: [{ value: "stable" }],
    source: { provider: completion.provider, model: "model", api: "openai-responses" },
  });
  sourceState.outputItems[0]!.value = "mutated";
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      completion.state?.kind === "openai_responses" ? completion.state.outputItems : undefined,
    )),
    [{ value: "stable" }],
  );

  await assert.rejects(completeEvents([{
    type: "response_end",
    reason: "stop",
    state: { kind: "chat_completions", assistantMessage: {} },
  }]), /continuation state protocol/u);

  let getterCalls = 0;
  const hostile = { kind: "openai_responses" } as Record<string, unknown>;
  Object.defineProperty(hostile, "outputItems", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return [];
    },
  });
  await assert.rejects(completeEvents([{
    type: "response_end",
    reason: "stop",
    state: hostile as never,
  }]), /(?:data properties|continuation state)/u);
  assert.equal(getterCalls, 0);

  const hostileEnvelope: Record<string, unknown> = {
    type: "response_end",
    reason: "stop",
  };
  Object.defineProperty(hostileEnvelope, "state", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { kind: "openai_responses", outputItems: [] };
    },
  });
  await assert.rejects(completeEvents([hostileEnvelope as never]), TypeError);
  assert.equal(getterCalls, 0);
});

test("direct completion rejects invalid stream lifecycle and cardinality", async () => {
  const state = { kind: "openai_responses" as const, outputItems: [] };
  await assert.rejects(completeEvents([
    { type: "response_start", model: "model" },
    { type: "response_start", model: "model" },
  ]), /response_start/u);
  await assert.rejects(completeEvents([
    { type: "text_start", part: 0 },
    { type: "text_start", part: 0 },
  ]), /text_start/u);
  await assert.rejects(completeEvents([
    { type: "text_delta", part: 0, text: "implicit" },
    { type: "text_start", part: 0 },
  ]), /text_start/u);
  await assert.rejects(completeEvents([
    { type: "reasoning_start", part: 0, visibility: "summary" },
    { type: "reasoning_start", part: 0, visibility: "summary" },
  ]), /reasoning_start/u);
  await assert.rejects(completeEvents([
    { type: "response_end", reason: "stop", state },
    { type: "text_delta", part: 0, text: "late" },
  ]), /terminal/u);
  await assert.rejects(completeEvents([
    { type: "response_end", reason: "stop", state },
    { type: "response_end", reason: "stop", state },
  ]), /terminal/u);
  await assert.rejects(completeEvents([
    { type: "text_delta", part: 0, text: "truncated" },
  ]), /without a terminal event/u);
  await assert.rejects(completeEvents([
    { type: "tool_call_delta", index: 0, jsonFragment: "{" },
    { type: "response_end", reason: "tool_calls", state },
  ]), /before tool_call_end/u);
  await assert.rejects(completeEvents([
    { type: "tool_call_start", index: 0, id: "active", name: "read" },
    {
      type: "response_end",
      reason: "tool_calls",
      state,
      content: [{ type: "tool_call", callId: "active", name: "read", arguments: {}, rawArguments: "{}" }],
    },
  ]), /before tool_call_end/u);
  await assert.rejects(completeEvents([
    { type: "tool_call_end", index: -1, name: "read", rawArguments: "{}", arguments: {} },
  ]), /index/u);
  await assert.rejects(completeEvents([
    { type: "tool_call_end", index: 0, name: "read", rawArguments: "{}", arguments: {} },
    { type: "tool_call_end", index: 0, name: "read", rawArguments: "{}", arguments: {} },
  ]), /tool_call_end/u);
  await assert.rejects(completeEvents(Array.from({ length: 257 }, (_, index): AdapterEvent => ({
    type: "tool_call_end",
    index,
    name: "read",
    rawArguments: "{}",
    arguments: {},
  }))), /256/u);
});

test("direct completion bounds cumulative assistant stream resources", async () => {
  const fourMiB = "x".repeat(4 * 1024 * 1024);
  await assert.rejects(completeEvents([
    { type: "text_delta", part: 0, text: fourMiB },
    { type: "reasoning_delta", part: 1, text: fourMiB, visibility: "summary" },
    { type: "text_delta", part: 2, text: "x" },
  ]), /aggregate bytes/u);
  await assert.rejects(completeEvents([
    { type: "text_delta", part: 0, text: `${fourMiB}x` },
  ]), /(?:byte limit|exceeds 4194304 bytes)/u);

  const twoMiB = "x".repeat(2 * 1024 * 1024);
  await assert.rejects(completeEvents([
    {
      type: "tool_call_end",
      index: 0,
      name: "read",
      rawArguments: twoMiB,
      arguments: twoMiB,
      thoughtSignature: twoMiB,
    },
    {
      type: "tool_call_end",
      index: 1,
      name: "read",
      rawArguments: twoMiB,
      arguments: twoMiB,
      thoughtSignature: "x",
    },
  ]), /aggregate bytes/u);
});

test("direct completion applies normalized usage semantics and validates observations", async () => {
  const incremental = await completeEvents([
    { type: "usage", semantics: "incremental", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } },
    { type: "usage", semantics: "incremental", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } },
    { type: "response_end", reason: "stop", state: { kind: "openai_responses", outputItems: [] } },
  ]);
  assert.deepEqual(incremental.usage, { inputTokens: 5, outputTokens: 5, totalTokens: 10 });

  const replaced = await completeEvents([
    { type: "usage", semantics: "incremental", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } },
    { type: "usage", semantics: "cumulative", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    { type: "usage", semantics: "incremental", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
    { type: "usage", semantics: "final", usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } },
    { type: "response_end", reason: "stop", state: { kind: "openai_responses", outputItems: [] } },
  ]);
  assert.deepEqual(replaced.usage, { inputTokens: 20, outputTokens: 8, totalTokens: 28 });

  const sanitized = await completeEvents([
    { type: "usage", semantics: "final", usage: { inputTokens: 1, raw: { private: "provider-only" } } },
    { type: "response_end", reason: "stop", state: { kind: "openai_responses", outputItems: [] } },
  ]);
  assert.deepEqual(sanitized.usage, { inputTokens: 1 });

  await assert.rejects(completeEvents([{
    type: "usage",
    semantics: "final",
    usage: { inputTokens: -1 },
  }]), /(?:usage is invalid|normalized usage)/u);
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

test("extension model registry ignores stale concurrent refresh snapshots", async () => {
  const oldModel = model("race", "old");
  const newModel = model("race", "new");
  const raceProvider = provider("race", []);
  let availableCalls = 0;
  let markFirstStarted!: () => void;
  let releaseFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const models = {
    async refresh() { return { aborted: false, errors: new Map<string, Error>() }; },
    getProviders() { return [raceProvider]; },
    async getAvailable() {
      availableCalls += 1;
      if (availableCalls === 1) {
        markFirstStarted();
        await firstRelease;
        return [oldModel];
      }
      return [newModel];
    },
    async checkAuth() {
      return availableCalls === 1
        ? { type: "api_key" as const, source: "old" }
        : { type: "oauth" as const, source: "OAuth" };
    },
  } as unknown as MutableModels;
  const registry = new ModelRegistry(models);

  const stale = registry.refresh();
  await firstStarted;
  await registry.refresh();
  assert.deepEqual(registry.getAvailable().map((entry) => entry.id), ["new"]);
  assert.equal(registry.isUsingOAuth("race"), true);

  releaseFirst();
  await stale;
  assert.deepEqual(registry.getAvailable().map((entry) => entry.id), ["new"]);
  assert.equal(registry.isUsingOAuth("race"), true);
  assert.equal(registry.getError(), undefined);
});

test("extension model registry does not expose a stale concurrent refresh failure", async () => {
  let refreshCalls = 0;
  let markFirstStarted!: () => void;
  let rejectFirst!: (error: Error) => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstRefresh = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
  const models = {
    async refresh() {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        markFirstStarted();
        return await firstRefresh;
      }
      return { aborted: false, errors: new Map<string, Error>() };
    },
    getProviders() { return []; },
  } as unknown as MutableModels;
  const registry = new ModelRegistry(models);

  const stale = registry.refresh();
  await firstStarted;
  await registry.refresh();
  rejectFirst(new Error("stale failure"));
  assert.match((await stale).errors.get("runtime")?.message ?? "", /stale failure/u);
  assert.equal(registry.getError(), undefined);
});

test("a forced models refresh supersedes a stalled refresh without publishing its stale result", async () => {
  const oldModel = model("underlying-race", "old");
  const newestModel = model("underlying-race", "newest");
  let refreshCalls = 0;
  let markFirstStarted!: () => void;
  let releaseFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const models = createModels();
  models.setProvider(createProvider({
    id: "underlying-race",
    auth: { apiKey: ambientAuth },
    models: [],
    async fetchModels() {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        markFirstStarted();
        await firstRelease;
        return [oldModel];
      }
      return [newestModel];
    },
    api: { async *stream() {} },
  }));
  const registry = new ModelRegistry(models);

  const older = registry.refresh();
  await firstStarted;
  const newer = registry.refresh({ force: true });
  await newer;

  assert.equal(refreshCalls, 2);
  assert.equal(registry.find("underlying-race", "newest"), newestModel);
  assert.deepEqual(registry.getAll().map((entry) => entry.id), ["newest"]);
  assert.deepEqual(registry.getAvailable().map((entry) => entry.id), ["newest"]);

  releaseFirst();
  await older;
  assert.deepEqual(registry.getAll().map((entry) => entry.id), ["newest"]);
  assert.deepEqual(registry.getAvailable().map((entry) => entry.id), ["newest"]);
});

test("an opaque provider refresh remains ordered when supersession safety is not declared", async () => {
  const oldModel = model("opaque-race", "old");
  const newestModel = model("opaque-race", "newest");
  let visible: ProviderModel[] = [];
  let calls = 0;
  let markStarted!: () => void;
  let releaseFirst!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const models = createModels();
  models.setProvider({
    ...provider("opaque-race", []),
    getModels: () => visible,
    async refreshModels() {
      calls += 1;
      if (calls === 1) {
        markStarted();
        await firstRelease;
        visible = [oldModel];
      } else {
        visible = [newestModel];
      }
    },
  });
  const registry = new ModelRegistry(models);

  const older = registry.refresh();
  await started;
  let forcedSettled = false;
  const forced = registry.refresh({ force: true }).finally(() => { forcedSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(forcedSettled, false);

  releaseFirst();
  await Promise.all([older, forced]);
  assert.equal(calls, 2);
  assert.deepEqual(registry.getAll().map((entry) => entry.id), ["newest"]);
  assert.deepEqual(registry.getAvailable().map((entry) => entry.id), ["newest"]);
});

test("cancelling availability discovery preserves the last good model snapshot", async () => {
  let stallAuthentication = false;
  const models = createModels();
  models.setProvider(createProvider({
    id: "cancelled-availability",
    auth: {
      apiKey: {
        name: "Cancellable availability",
        resolve: async () => ({ auth: {}, source: "fixture" }),
        async check() {
          if (stallAuthentication) return await new Promise(() => undefined);
          return { type: "api_key", source: "fixture" };
        },
      },
    },
    models: [model("cancelled-availability", "base")],
    api: { async *stream() {} },
  }));
  const registry = new ModelRegistry(models);
  await registry.refresh({ allowNetwork: false });
  assert.deepEqual(registry.getAvailable().map((entry) => entry.id), ["base"]);

  stallAuthentication = true;
  const controller = new AbortController();
  const refresh = registry.refresh({ allowNetwork: false, signal: controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new Error("model picker closed"));
  const result = await refresh;

  assert.equal(result.aborted, true);
  assert.equal(result.errors.size, 0);
  assert.deepEqual(registry.getAvailable().map((entry) => entry.id), ["base"]);
  assert.equal(registry.getError(), undefined);
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

test("direct models bridge preserves the complete non-secret run-loop request contract", async () => {
  const selected = {
    ...model("bridge", "model", "anthropic-messages"),
    name: "Base model name",
    reasoning: true,
    thinkingLevelMap: { high: "provider-high" },
  } satisfies ProviderModel;
  let observed: ProviderRequest | undefined;
  let observedOptions: ProviderStreamOptions | undefined;
  const models = createModels();
  models.setProvider(createProvider({
    id: "bridge",
    auth: { apiKey: ambientAuth },
    models: [selected],
    api: {
      async *stream(request, _signal, options) {
        observed = request;
        observedOptions = options;
        yield { type: "response_start", model: request.model };
      },
    },
  }));
  const adapter = providerAdapterFromModels(models, "bridge");
  const controller = new AbortController();
  const onPayload = (payload: unknown): unknown => payload;
  const onResponse = (): void => {};
  assert.equal((await adapter.listModels(controller.signal))[0]?.compatibility?.protocolFamily?.value, "anthropic-messages");
  const events: AdapterEvent[] = [];
  for await (const event of adapter.stream({
    provider: "bridge",
    model: "model",
    api: "anthropic-messages",
    messages: [],
    tools: [],
    reasoningEffort: "high",
    toolChoice: "required",
    temperature: 0.5,
    cacheRetention: "long",
    maxOutputTokens: 789,
    thinkingBudgets: { high: 4_096 },
    sessionId: "bridge-session",
    metadata: { operation: "bridge-contract" },
    transport: "sse",
    timeoutMs: 123,
    maxRetries: 2,
    maxRetryDelayMs: 456,
    onPayload,
    onResponse,
    modelSettings: {
      displayName: "Configured model name",
      headers: { "x-request-model": "safe" },
      reasoningEffortMap: { high: "configured-high" },
      compatibility: { supportsStrictTools: true },
    },
  }, controller.signal)) events.push(event);
  assert.equal(events[0]?.type, "response_start");
  assert.equal(observed?.reasoningEffort, "configured-high");
  assert.equal(observed?.toolChoice, "required");
  assert.equal(observed?.temperature, 0.5);
  assert.equal(observed?.cacheRetention, "long");
  assert.equal(observed?.maxOutputTokens, 789);
  assert.deepEqual(observed?.thinkingBudgets, { high: 4_096 });
  assert.equal(observed?.sessionId, "bridge-session");
  assert.deepEqual(observed?.metadata, { operation: "bridge-contract" });
  assert.equal(observed?.timeoutMs, 123);
  assert.equal(observed?.maxRetries, 2);
  assert.equal(observed?.maxRetryDelayMs, 456);
  assert.deepEqual(observed?.modelSettings, {
    displayName: "Configured model name",
    reasoningEffortMap: { high: "configured-high" },
    compatibility: { supportsStrictTools: true },
  });
  assert.deepEqual(observedOptions?.headers, { "x-request-model": "safe" });
  assert.equal(observedOptions?.transport, "sse");
  assert.equal(observedOptions?.onPayload, onPayload);
  assert.equal(observedOptions?.onResponse, onResponse);

  observed = undefined;
  observedOptions = undefined;
  for await (const _event of adapter.stream({
    provider: "bridge",
    model: "model",
    messages: [],
    tools: [],
    reasoningEffort: "minimal",
    modelSettings: { reasoningEffortMap: { minimal: null } },
  }, controller.signal)) {}
  const minimalRequest = observed as ProviderRequest | undefined;
  const minimalOptions = observedOptions as ProviderStreamOptions | undefined;
  assert.equal(minimalRequest?.reasoningEffort, undefined);
  assert.equal(minimalOptions?.reasoningEffort, undefined);

  const info = providerModelToInfo(selected);
  assert.equal(info.provider, "bridge");
  assert.equal(info.capabilities.reasoning.value, "supported");
});

test("direct models bridge normalizes disabled Responses reasoning", async () => {
  const selected = {
    ...model("bridge-responses", "model", "openai-responses"),
    reasoning: true,
    thinkingLevelMap: { off: "off" },
  } satisfies ProviderModel;
  let observedOptions: ProviderStreamOptions | undefined;
  const models = createModels();
  models.setProvider(createProvider({
    id: "bridge-responses",
    auth: { apiKey: ambientAuth },
    models: [selected],
    api: {
      async *stream(request, _signal, options) {
        observedOptions = options;
        yield { type: "response_start", model: request.model };
      },
    },
  }));
  const adapter = providerAdapterFromModels(models, "bridge-responses");
  const controller = new AbortController();

  for await (const _event of adapter.stream({
    provider: "bridge-responses",
    model: "model",
    messages: [],
    tools: [],
    reasoningEffort: "off",
    modelSettings: { reasoningEffortMap: { off: "off" } },
  }, controller.signal)) {}
  assert.equal(observedOptions?.reasoningEffort, "none");

  observedOptions = undefined;
  for await (const _event of adapter.stream({
    provider: "bridge-responses",
    model: "model",
    messages: [],
    tools: [],
    reasoningEffort: "off",
    modelSettings: { reasoningEffortMap: { off: null } },
  }, controller.signal)) {}
  assert.equal((observedOptions as ProviderStreamOptions | undefined)?.reasoningEffort, undefined);
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
  assert.equal(clampThinkingLevel(priced, "max"), "xhigh");
  assert.equal(modelCacheReadPrice(priced, 100), 0.1);
  assert.equal(modelCacheReadPrice(priced, 101), 0.2);
  const cost = calculateCost(priced, {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 10,
    cacheWrite1hTokens: 4,
  });
  assert.ok(cost);
  assert.ok(Math.abs(cost.input - 0.0002) < Number.EPSILON);
  assert.ok(Math.abs(cost.output - 0.0002) < Number.EPSILON);
  assert.ok(Math.abs(cost.cacheRead - 0.000002) < Number.EPSILON);
  assert.ok(Math.abs(cost.cacheWrite - 0.000031) < Number.EPSILON);
  assert.ok(Math.abs(cost.total - 0.000433) < Number.EPSILON);
  assert.equal(calculateCost(priced, { inputTokens: 100, outputTokens: 50 }), undefined);
  assert.equal(calculateCost(priced, {
    inputTokens: 0.5,
    outputTokens: 0.25,
    cacheReadTokens: 0.5,
    cacheWriteTokens: 0,
  }), undefined);
});
