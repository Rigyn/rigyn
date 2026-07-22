import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInfo, ProviderAdapter } from "../../src/core/types.js";
import {
  compatibleThinkingLevel,
  classifyModelCatalogFailure,
  authMethodLoginPath,
  isAgentOpenAIModel,
  latestAssistantText,
  modelCatalogEmptyMessage,
  modelMatchesScope,
  orderModelsForScope,
  parseModelScope,
  refreshModelPicker,
  selectDefaultModelAfterLogin,
  SCOPED_MODELS_NONE,
  THINKING_LEVELS,
  thinkingLevelsForModel,
  type ModelSelection,
  type ProviderModelCatalogStatus,
} from "../../src/cli/main.js";
import type { ProviderAuthMethod, ProviderAuthRegistry, ProviderAuthState } from "../../src/auth/index.js";
import type { EventEnvelope } from "../../src/core/events.js";
import type { PickerItem, PickerKind } from "../../src/tui/types.js";
import { providerModelFromInfo, providerModelToInfo } from "../../src/providers/internal-runtime-bridge.js";
import { openAICodexModels } from "../../src/providers/openai-codex-responses.js";
import { ProviderRegistry } from "../../src/providers/registry.js";

function model(id: string, provider = "openai"): ModelInfo {
  const capability = { value: "unknown" as const, source: "provider" as const, observedAt: "2026-01-01T00:00:00.000Z" };
  return { id, provider, capabilities: { tools: capability, reasoning: capability, images: capability } };
}

test("login separates subscription OAuth from API-key and provider-managed methods", () => {
  const methods: ProviderAuthMethod[] = [
    { id: "oauth:fixture", kind: "oauth", label: "Subscription", detail: "PKCE", registrationId: "fixture" },
    { id: "openai_codex_browser", kind: "openai_codex_browser", label: "Browser", detail: "PKCE" },
    { id: "openai_codex_device", kind: "openai_codex_device", label: "Device", detail: "Headless" },
    { id: "openrouter_browser", kind: "openrouter_browser", label: "OpenRouter", detail: "Browser API key" },
    { id: "api_key", kind: "api_key", label: "API key", detail: "Secure store" },
    { id: "environment", kind: "environment", label: "Environment", detail: "OPENAI_API_KEY", variable: "OPENAI_API_KEY" },
    { id: "external", kind: "external", label: "Extension", detail: "Provider managed" },
  ];
  assert.deepEqual(methods.map(authMethodLoginPath), [
    "subscription",
    "subscription",
    "subscription",
    "api_key",
    "api_key",
    "api_key",
    "api_key",
  ]);
});

test("post-login defaults are provider-specific and never replace a real active model", () => {
  const models = [model("gpt-5.5", "openai-codex"), model("gpt-5.6-sol", "openai-codex")];
  assert.deepEqual(selectDefaultModelAfterLogin("openai-codex", models), {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
  });
  assert.deepEqual(selectDefaultModelAfterLogin("custom", [model("only", "custom")]), undefined);
  assert.deepEqual(selectDefaultModelAfterLogin("custom", [model("configured", "custom")], {
    provider: "custom",
    model: "configured",
  }), { provider: "custom", model: "configured" });
  assert.deepEqual(selectDefaultModelAfterLogin("openai-codex", models, undefined, {
    provider: "anthropic",
    model: "already-selected",
  }), undefined);
  assert.deepEqual(selectDefaultModelAfterLogin("opencode", [model("kimi-k2.6", "opencode")]), {
    provider: "opencode",
    model: "kimi-k2.6",
  });
  assert.deepEqual(selectDefaultModelAfterLogin(
    "cloudflare-workers-ai",
    [model("@cf/moonshotai/kimi-k2.6", "cloudflare-workers-ai")],
  ), {
    provider: "cloudflare-workers-ai",
    model: "@cf/moonshotai/kimi-k2.6",
  });
});

test("OpenAI model picker excludes obvious non-agent catalog entries", () => {
  for (const id of [
    "text-embedding-3-small",
    "gpt-image-1",
    "chatgpt-image-latest",
    "dall-e-3",
    "gpt-3.5-turbo",
    "gpt-4",
    "gpt-4-0613",
    "gpt-4-turbo",
    "gpt-4o-audio-preview",
    "whisper-1",
    "tts-1",
    "omni-moderation-latest",
    "gpt-4o-search-preview",
    "babbage-002",
    "davinci-002",
    "text-davinci-003",
  ]) assert.equal(isAgentOpenAIModel(id), false, id);

  for (const id of ["gpt-5", "gpt-4.1", "gpt-4o", "o3", "codex-mini-latest", "computer-use-preview"]) {
    assert.equal(isAgentOpenAIModel(id), true, id);
  }
});

test("thinking choices honor exact model effort metadata without guessing", () => {
  assert.deepEqual(thinkingLevelsForModel(undefined), THINKING_LEVELS);
  const supported = model("reasoning-model");
  supported.capabilities.reasoning = {
    value: "supported",
    source: "provider",
    observedAt: "2026-01-01T00:00:00.000Z",
  };
  supported.compatibility = {
    reasoningEfforts: {
      value: ["LOW", "high", "none", "provider-special"],
      source: "provider",
      observedAt: "2026-01-01T00:00:00.000Z",
    },
  };
  assert.deepEqual(thinkingLevelsForModel(supported), ["off", "low", "high"]);

  const required = model("required-reasoning");
  required.capabilities.reasoning = {
    value: "supported",
    source: "provider",
    observedAt: "2026-01-01T00:00:00.000Z",
  };
  required.compatibility = {
    reasoningEfforts: {
      value: ["low", "high"],
      source: "provider",
      observedAt: "2026-01-01T00:00:00.000Z",
    },
  };
  assert.deepEqual(thinkingLevelsForModel(required), ["low", "high"]);

  const unsupported = model("plain-model");
  unsupported.capabilities.reasoning = {
    value: "unsupported",
    source: "provider",
    observedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.deepEqual(thinkingLevelsForModel(unsupported), ["off"]);
  assert.deepEqual(thinkingLevelsForModel(model("unknown-model")), ["off"]);
  assert.equal(compatibleThinkingLevel("medium", unsupported), "off");
  assert.equal(compatibleThinkingLevel("high", required), "high");
});

test("GPT-5.6 Sol exposes xhigh and max through the interactive model bridge", () => {
  const info = openAICodexModels("2026-07-22T00:00:00.000Z").find((entry) => entry.id === "gpt-5.6-sol");
  assert.ok(info);
  assert.deepEqual(thinkingLevelsForModel(providerModelToInfo(providerModelFromInfo(info))), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("model scope supports provider-qualified and wildcard patterns", () => {
  assert.equal(modelMatchesScope("anthropic", "claude-sonnet-4", ["anthropic/*sonnet*"]), true);
  assert.equal(modelMatchesScope("openai", "gpt-5.5", ["gpt-5.*"]), true);
  assert.equal(modelMatchesScope("openai", "gpt-4o", ["anthropic/*"]), false);
  assert.equal(modelMatchesScope("openai", "gpt-4o", []), true);
  assert.equal(modelMatchesScope("openai", "gpt-4o", [SCOPED_MODELS_NONE]), false);
  assert.equal(modelMatchesScope("openai", "gpt-4o", [SCOPED_MODELS_NONE, "openai/gpt-4o"]), true);
});

test("model scope input is normalized and bounded consistently", () => {
  assert.deepEqual(parseModelScope(" openai/gpt-5.*, anthropic/*sonnet* "), ["openai/gpt-5.*", "anthropic/*sonnet*"]);
  assert.deepEqual(parseModelScope("clear"), []);
  assert.deepEqual(parseModelScope("all"), []);
  assert.deepEqual(parseModelScope("none"), [SCOPED_MODELS_NONE]);
  assert.throws(() => parseModelScope(`${"x".repeat(257)}`), /at most 100 patterns/u);
  assert.throws(() => parseModelScope(Array.from({ length: 101 }, (_, index) => `m${index}`).join(",")), /at most 100 patterns/u);
});

test("model scope order expands wildcards deterministically without duplicates", () => {
  const available: ModelSelection[] = [
    { provider: "openai", model: "gpt-b" },
    { provider: "anthropic", model: "claude-z" },
    { provider: "openai", model: "gpt-a" },
    { provider: "anthropic", model: "claude-a" },
    { provider: "openai", model: "gpt-b" },
  ];
  assert.deepEqual(orderModelsForScope(available, ["openai/gpt-b", "anthropic/*", "*/gpt-*"]), [
    { provider: "openai", model: "gpt-b" },
    { provider: "anthropic", model: "claude-a" },
    { provider: "anthropic", model: "claude-z" },
    { provider: "openai", model: "gpt-a" },
  ]);
  assert.deepEqual(orderModelsForScope(available, []), [
    { provider: "anthropic", model: "claude-a" },
    { provider: "anthropic", model: "claude-z" },
    { provider: "openai", model: "gpt-a" },
    { provider: "openai", model: "gpt-b" },
  ]);
  assert.deepEqual(orderModelsForScope(available, [SCOPED_MODELS_NONE]), []);
});

test("clipboard selection skips tool-only assistant messages and returns the latest text", () => {
  const envelope = (sequence: number, content: EventEnvelope["event"]): EventEnvelope => ({
    eventId: `event-${sequence}`,
    threadId: "thread",
    sequence,
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    event: content,
  });
  assert.equal(latestAssistantText([
    envelope(1, { type: "message_appended", message: {
      id: "message-1", role: "assistant", createdAt: "2026-01-01T00:00:00.000Z", content: [{ type: "text", text: "first" }],
    } }),
    envelope(2, { type: "message_appended", message: {
      id: "message-2", role: "assistant", createdAt: "2026-01-01T00:00:01.000Z", content: [{ type: "tool_call", callId: "call", name: "read", arguments: {} }],
    } }),
    envelope(3, { type: "message_appended", message: {
      id: "message-3", role: "assistant", createdAt: "2026-01-01T00:00:02.000Z", content: [{ type: "text", text: "latest" }],
    } }),
  ]), "latest");
});

test("combined model refresh hides a current choice from a disconnected provider", async () => {
  let items: PickerItem<ModelSelection>[] = [];
  let cycleItems: PickerItem<ModelSelection>[] = [];
  const terminal = {
    setPickerItems<T>(_kind: Exclude<PickerKind, "generic">, next: readonly PickerItem<T>[]): void {
      items = [...next] as PickerItem<ModelSelection>[];
    },
    addPickerItems<T>(_kind: Exclude<PickerKind, "generic">, next: readonly PickerItem<T>[]): void {
      const merged = new Map(items.map((item) => [item.id, item]));
      for (const item of next as readonly PickerItem<ModelSelection>[]) merged.set(item.id, item);
      items = [...merged.values()];
    },
    setModelCycleItems<T>(next: readonly PickerItem<T>[]): void {
      cycleItems = [...next] as PickerItem<ModelSelection>[];
    },
  };
  const providers: Array<Pick<ProviderAdapter, "id" | "listModels">> = [
    {
      id: "openai",
      async listModels() {
        return [model("gpt-image-1"), model("gpt-5")];
      },
    },
    {
      id: "anthropic",
      async listModels() {
        return [model("claude-sonnet", "anthropic")];
      },
    },
    {
      id: "offline",
      async listModels() {
        throw new Error("not connected");
      },
    },
  ];

  const refresh = refreshModelPicker(
    providers,
    terminal,
    { provider: "offline", model: "configured-model" },
    new AbortController().signal,
    [],
    {
      async state(provider: string): Promise<ProviderAuthState> {
        const base = {
          provider,
          credentialId: provider,
          displayName: provider,
          environment: { present: false, active: false, shadowed: false },
          stored: { present: false, active: false, shadowed: false, usable: false },
        };
        return provider === "offline"
          ? { ...base, status: "available", methods: [{ id: "api_key", kind: "api_key", label: "API key", detail: "secure store" }] }
          : { ...base, status: "connected", source: "external", kind: "external", methods: [] };
      },
    },
  );
  await refresh;
  assert.deepEqual(items.map((item) => item.value), [
    { provider: "anthropic", model: "claude-sonnet" },
    { provider: "openai", model: "gpt-5" },
  ]);
  assert.deepEqual(cycleItems.map((item) => item.value), [
    { provider: "anthropic", model: "claude-sonnet" },
    { provider: "openai", model: "gpt-5" },
  ]);
  assert.equal(items.some((item) => item.label === "openai / gpt-image-1"), false);
});

test("an empty first-run model picker stays a model picker and leaves login to /login", async () => {
  let items: PickerItem<ModelSelection>[] = [];
  await refreshModelPicker([], {
    setPickerItems<T>(_kind: Exclude<PickerKind, "generic">, next: readonly PickerItem<T>[]) {
      items = [...next] as PickerItem<ModelSelection>[];
    },
    addPickerItems() {},
  }, undefined, new AbortController().signal);
  assert.deepEqual(items, []);
});

test("model refresh replaces cycle items atomically instead of clearing them while discovery is pending", async () => {
  let release!: (models: ModelInfo[]) => void;
  const discovered = new Promise<ModelInfo[]>((resolve) => { release = resolve; });
  const cycleSnapshots: ModelSelection[][] = [];
  const refreshing = refreshModelPicker([{
    id: "delayed",
    async listModels() { return await discovered; },
  }], {
    setPickerItems() {},
    addPickerItems() {},
    setModelCycleItems<T>(items: readonly PickerItem<T>[]) {
      cycleSnapshots.push(items.map((item) => item.value as ModelSelection));
    },
  }, { provider: "delayed", model: "current" }, new AbortController().signal);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(cycleSnapshots, []);
  release([model("next", "delayed")]);
  await refreshing;
  assert.deepEqual(cycleSnapshots, [[{ provider: "delayed", model: "next" }]]);
});

test("model refresh keeps prior rows, publishes fast live catalogs, and reports loading until the atomic final view", async () => {
  let releaseSlow!: (models: ModelInfo[]) => void;
  const slow = new Promise<ModelInfo[]>((resolve) => { releaseSlow = resolve; });
  let items: PickerItem<ModelSelection>[] = [
    { id: "prior", label: "prior / verified", value: { provider: "prior", model: "verified" } },
  ];
  const loading: boolean[] = [];
  const refreshing = refreshModelPicker([
    { id: "fast", async listModels() { return [model("live-fast", "fast")]; } },
    { id: "slow", async listModels() { return await slow; } },
  ], {
    setPickerItems<T>(_kind: Exclude<PickerKind, "generic">, next: readonly PickerItem<T>[]) {
      items = [...next] as PickerItem<ModelSelection>[];
    },
    addPickerItems<T>(_kind: Exclude<PickerKind, "generic">, next: readonly PickerItem<T>[]) {
      const merged = new Map(items.map((item) => [item.id, item]));
      for (const item of next as readonly PickerItem<ModelSelection>[]) merged.set(item.id, item);
      items = [...merged.values()];
    },
    setModelPickerLoading(value) { loading.push(value); },
  }, undefined, new AbortController().signal);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(items.map((item) => item.value), [
    { provider: "prior", model: "verified" },
    { provider: "fast", model: "live-fast" },
  ]);
  assert.deepEqual(loading, [true]);

  releaseSlow([model("live-slow", "slow")]);
  await refreshing;
  assert.deepEqual(items.map((item) => item.value), [
    { provider: "fast", model: "live-fast" },
    { provider: "slow", model: "live-slow" },
  ]);
  assert.deepEqual(loading, [true, false]);
});

test("combined model refresh keeps all models for Tab while limiting the default view and cycling to scope", async () => {
  let all: ModelSelection[] = [];
  let scoped: ModelSelection[] | undefined;
  const terminal = {
    setPickerItems() {},
    addPickerItems() {},
    setModelPickerItems<T>(allItems: readonly PickerItem<T>[], scopedItems?: readonly PickerItem<T>[]) {
      all = allItems.map((item) => item.value as ModelSelection);
      scoped = scopedItems?.map((item) => item.value as ModelSelection);
    },
  };
  await refreshModelPicker([{
    id: "openai",
    async listModels() { return [model("gpt-4o"), model("gpt-5.5")]; },
  }], terminal, undefined, new AbortController().signal, ["gpt-5.*"]);
  assert.deepEqual(all, [
    { provider: "openai", model: "gpt-4o" },
    { provider: "openai", model: "gpt-5.5" },
  ]);
  assert.deepEqual(scoped, [{ provider: "openai", model: "gpt-5.5" }]);
});

test("combined model refresh visibly omits scoped thinking unsupported by exact model metadata", async () => {
  const required = model("required", "reasoning");
  required.compatibility = {
    reasoningEfforts: { value: ["low", "high"], source: "provider", observedAt: "2026-01-01T00:00:00.000Z" },
  };
  const unsupported = model("unsupported", "reasoning");
  unsupported.capabilities.reasoning = {
    value: "unsupported",
    source: "provider",
    observedAt: "2026-01-01T00:00:00.000Z",
  };
  let cycle: ModelSelection[] = [];
  const notices: string[] = [];
  await refreshModelPicker([{
    id: "reasoning",
    async listModels() { return [required, unsupported]; },
  }], {
    setPickerItems() {},
    addPickerItems() {},
    setModelCycleItems<T>(items: readonly PickerItem<T>[]) {
      cycle = items.map((item) => item.value as ModelSelection);
    },
    notify(message: string) { notices.push(message); },
  }, undefined, new AbortController().signal, [
    "reasoning/required:off",
    "reasoning/unsupported:high",
    "reasoning/required:low",
  ]);
  assert.deepEqual(cycle, [{ provider: "reasoning", model: "required", reasoningEffort: "low" }]);
  assert.match(notices.join("\n"), /ignored 2 unsupported thinking selections/u);
});

test("an aborted stale model refresh cannot overwrite a newer catalog", async () => {
  const values: ModelSelection[] = [];
  const terminal = {
    setPickerItems<T>(_kind: Exclude<PickerKind, "generic">, items: readonly PickerItem<T>[]) {
      values.splice(0, values.length, ...items.map((item) => item.value as ModelSelection));
    },
    addPickerItems() {},
  };
  let releaseOld: (models: ModelInfo[]) => void = () => {};
  const oldModels = new Promise<ModelInfo[]>((resolve) => { releaseOld = resolve; });
  const oldAbort = new AbortController();
  const stale = refreshModelPicker([{
    id: "openai",
    async listModels() { return await oldModels; },
  }], terminal, undefined, oldAbort.signal);
  oldAbort.abort(new Error("superseded"));
  await refreshModelPicker([{
    id: "anthropic",
    async listModels() { return [model("claude-current", "anthropic")]; },
  }], terminal, undefined, new AbortController().signal);
  releaseOld([model("gpt-stale")]);
  await stale;
  assert.deepEqual(values, [{ provider: "anthropic", model: "claude-current" }]);
});

test("model picker keeps available rows clean, omits unverified current IDs, and reports bounded failure classes", async () => {
  let items: PickerItem<ModelSelection>[] = [];
  const notices: string[] = [];
  let statuses: Array<{ provider: string; status: string }> = [];
  const terminal = {
    setPickerItems<T>(_kind: Exclude<PickerKind, "generic">, next: readonly PickerItem<T>[]) {
      items = [...next] as PickerItem<ModelSelection>[];
    },
    addPickerItems() {},
    notify(message: string) { notices.push(message); },
  };
  const state = (provider: string): ProviderAuthState => ({
    provider,
    credentialId: provider,
    displayName: provider,
    status: "connected",
    source: "stored",
    kind: "oauth",
    accountId: `${provider}-account`,
    environment: { present: false, active: false, shadowed: false },
    stored: { present: true, active: true, shadowed: false, usable: true, kind: "oauth" },
    methods: [],
  });
  const auth = { async state(provider: string) { return state(provider); } } as Pick<ProviderAuthRegistry, "state">;
  await refreshModelPicker([
    { id: "openai", async listModels() { return [model("gpt-5")]; } },
    { id: "unauthorized", async listModels() { throw { category: "authentication" }; } },
    { id: "empty", async listModels() { return []; } },
  ], terminal, { provider: "unauthorized", model: "configured" }, new AbortController().signal, [], auth, (next) => {
    statuses = next.map(({ provider, status }) => ({ provider, status }));
  });

  assert.equal(items.find((item) => item.value.provider === "openai")?.detail, undefined);
  assert.equal(items.find((item) => item.value.provider === "unauthorized"), undefined);
  assert.deepEqual(notices, ["Model catalogs: unauthorized (authentication)"]);
  assert.deepEqual(statuses, [
    { provider: "openai", status: "available" },
    { provider: "unauthorized", status: "authentication" },
    { provider: "empty", status: "empty" },
  ]);
  assert.equal(classifyModelCatalogFailure(new Error("fetch failed: ECONNREFUSED")), "network");
  assert.equal(classifyModelCatalogFailure(new Error("request timed out")), "timeout");
  assert.equal(classifyModelCatalogFailure(new Error("401 unauthorized")), "authentication");
});

test("a connected provider catalog failure is not misdiagnosed as missing login without a current model", async () => {
  const notices: string[] = [];
  let statuses: readonly ProviderModelCatalogStatus[] = [];
  await refreshModelPicker([{
    id: "connected",
    async listModels() { throw new Error("fetch failed: ECONNREFUSED"); },
  }], {
    setPickerItems() {},
    addPickerItems() {},
    notify(message: string) { notices.push(message); },
  }, undefined, new AbortController().signal, [], {
    async state(): Promise<ProviderAuthState> {
      return {
        provider: "connected",
        credentialId: "connected",
        displayName: "Connected",
        status: "connected",
        source: "stored",
        kind: "oauth",
        environment: { present: false, active: false, shadowed: false },
        stored: { present: true, active: true, shadowed: false, usable: true, kind: "oauth" },
        methods: [],
      };
    },
  }, (next) => { statuses = next; });
  assert.deepEqual(notices, ["Model catalogs: connected (network)"]);
  assert.match(modelCatalogEmptyMessage(statuses) ?? "", /Connected provider catalogs are unavailable: connected \(network\)/u);
  assert.doesNotMatch(modelCatalogEmptyMessage(statuses) ?? "", /connect a provider/u);
});

test("local-daemon and authentication failures keep empty model recovery on /login", () => {
  assert.equal(modelCatalogEmptyMessage([{
    provider: "ollama",
    status: "network",
    authStatus: "connected",
    authSource: "local",
  }]), undefined);
  assert.equal(modelCatalogEmptyMessage([{
    provider: "openai",
    status: "authentication",
    authStatus: "connected",
    authSource: "environment",
  }]), undefined);
});

test("background model refresh skips definitively disconnected providers without noisy warnings", async () => {
  let called = false;
  const notices: string[] = [];
  let status = "";
  let items: PickerItem<ModelSelection>[] = [];
  const auth = {
    async state(provider: string): Promise<ProviderAuthState> {
      return {
        provider,
        credentialId: provider,
        displayName: provider,
        status: "available",
        environment: { present: false, active: false, shadowed: false },
        stored: { present: false, active: false, shadowed: false, usable: false },
        methods: [{ id: "api_key", kind: "api_key", label: "Store API key", detail: "secure store" }],
      };
    },
  } as Pick<ProviderAuthRegistry, "state">;
  await refreshModelPicker([{
    id: "disconnected",
    async listModels() {
      called = true;
      return [];
    },
  }], {
    setPickerItems<T>(_kind: Exclude<PickerKind, "generic">, next: readonly PickerItem<T>[]) {
      items = [...next] as PickerItem<ModelSelection>[];
    },
    addPickerItems() {},
    notify(message: string) { notices.push(message); },
  }, { provider: "disconnected", model: "stale" }, new AbortController().signal, [], auth, (statuses) => {
    status = statuses[0]?.status ?? "";
  });
  assert.equal(called, false);
  assert.equal(status, "disconnected");
  assert.deepEqual(items, []);
  assert.deepEqual(notices, []);
});

test("model refresh hides an unverified ambient provider", async () => {
  let called = false;
  let items: PickerItem<ModelSelection>[] = [];
  await refreshModelPicker([{
    id: "gemini",
    async listModels() {
      called = true;
      return [model("gemini-pro", "gemini")];
    },
  }], {
    setPickerItems<T>(_kind: Exclude<PickerKind, "generic">, next: readonly PickerItem<T>[]) {
      items = [...next] as PickerItem<ModelSelection>[];
    },
    addPickerItems() {},
  }, undefined, new AbortController().signal, [], {
    async state(): Promise<ProviderAuthState> {
      return {
        provider: "gemini",
        credentialId: "gemini",
        displayName: "Google Gemini",
        status: "available",
        source: "ambient",
        kind: "ambient",
        error: "Ambient identity has not been verified",
        environment: { present: false, active: false, shadowed: false },
        stored: { present: false, active: false, shadowed: false, usable: false },
        methods: [],
      };
    },
  });
  assert.equal(called, false);
  assert.deepEqual(items, []);
});

test("configured offline models stay outside the live available picker", async () => {
  let discoveryCalled = false;
  const provider: ProviderAdapter = {
    id: "configured",
    async *stream() { throw new Error("unused"); },
    async listModels() {
      discoveryCalled = true;
      throw new Error("offline");
    },
  };
  const registry = new ProviderRegistry([provider], {
    now: () => Date.parse("2026-07-10T00:00:00.000Z"),
    configuredModels: [{
      provider: "configured",
      id: "offline-model",
      displayName: "Local catalog model",
      description: "Declared in configuration",
      contextTokens: 96_000,
      reasoningEfforts: ["low", "high"],
    }],
  });
  let items: PickerItem<ModelSelection>[] = [];
  let cycle: ModelSelection[] = [];
  const discovered = await refreshModelPicker(
    [provider],
    {
      setPickerItems<T>(_kind: Exclude<PickerKind, "generic">, next: readonly PickerItem<T>[]) {
        items = [...next] as PickerItem<ModelSelection>[];
      },
      addPickerItems() {},
      setModelCycleItems<T>(next: readonly PickerItem<T>[]) {
        cycle = next.map((entry) => entry.value as ModelSelection);
      },
    },
    undefined,
    new AbortController().signal,
    ["configured/offline-model:high"],
    {
      async state(): Promise<ProviderAuthState> {
        return {
          provider: "configured",
          credentialId: "configured",
          displayName: "Configured",
          status: "unavailable",
          environment: { present: false, active: false, shadowed: false },
          stored: { present: false, active: false, shadowed: false, usable: false },
          methods: [],
        };
      },
    },
    undefined,
    registry,
  );

  assert.equal(discoveryCalled, false);
  assert.deepEqual(discovered, []);
  assert.deepEqual(cycle, []);
  assert.deepEqual(items, []);
});

test("successful live discovery excludes configured IDs that the provider did not return", async () => {
  const provider: ProviderAdapter = {
    id: "verified",
    async *stream() { throw new Error("unused"); },
    async listModels() { return [model("live-model", "verified")]; },
  };
  const registry = new ProviderRegistry([provider], {
    configuredModels: [
      { provider: "verified", id: "live-model", displayName: "Enriched live model" },
      { provider: "verified", id: "stale-fallback", displayName: "Must not appear" },
    ],
  });
  let items: PickerItem<ModelSelection>[] = [];
  const discovered = await refreshModelPicker([provider], {
    setPickerItems<T>(_kind: Exclude<PickerKind, "generic">, next: readonly PickerItem<T>[]) {
      items = [...next] as PickerItem<ModelSelection>[];
    },
    addPickerItems() {},
  }, { provider: "verified", model: "stale-fallback" }, new AbortController().signal, [], {
    async state(): Promise<ProviderAuthState> {
      return {
        provider: "verified",
        credentialId: "verified",
        displayName: "Verified",
        status: "connected",
        source: "stored",
        kind: "api_key",
        environment: { present: false, active: false, shadowed: false },
        stored: { present: true, active: true, shadowed: false, usable: true, kind: "api_key" },
        methods: [],
      };
    },
  }, undefined, registry);

  assert.deepEqual(discovered.map((entry) => entry.id), ["live-model"]);
  assert.deepEqual(items.map((entry) => entry.value), [{ provider: "verified", model: "live-model" }]);
  assert.match(items[0]?.detail ?? "", /Enriched live model/u);
});

test("cached models from a disconnected credentialed provider are not selectable", async () => {
  const provider: ProviderAdapter = {
    id: "credentialed",
    async *stream() { throw new Error("unused"); },
    async listModels() { throw new Error("must not contact a disconnected provider"); },
  };
  const registry = new ProviderRegistry([provider], {
    configuredModels: [{ provider: "credentialed", id: "stale-model" }],
  });
  let items: PickerItem<ModelSelection>[] = [];
  let cycle: ModelSelection[] = [];
  const discovered = await refreshModelPicker([provider], {
    setPickerItems<T>(_kind: Exclude<PickerKind, "generic">, next: readonly PickerItem<T>[]) {
      items = [...next] as PickerItem<ModelSelection>[];
    },
    addPickerItems() {},
    setModelCycleItems<T>(next: readonly PickerItem<T>[]) {
      cycle = next.map((entry) => entry.value as ModelSelection);
    },
  }, undefined, new AbortController().signal, [], {
    async state(): Promise<ProviderAuthState> {
      return {
        provider: "credentialed",
        credentialId: "credentialed",
        displayName: "Credentialed",
        status: "available",
        environment: { present: false, active: false, shadowed: false },
        stored: { present: false, active: false, shadowed: false, usable: false },
        methods: [{ id: "api_key", kind: "api_key", label: "Store API key", detail: "secure store" }],
      };
    },
  }, undefined, registry);

  assert.deepEqual(discovered, []);
  assert.deepEqual(items, []);
  assert.deepEqual(cycle, []);
});
