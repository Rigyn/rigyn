import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_PROVIDER_CONFIGS } from "../../src/cli/runtime.js";
import { configuredModelsWithMaintainedCatalog } from "../../src/providers/maintained-model-catalog.js";
import { openAICodexModels } from "../../src/providers/openai-codex-responses.js";
import { modelReasoningEfforts, ProviderRegistry } from "../../src/providers/registry.js";

const CATALOG_PROVIDER_IDS = [
  "anthropic", "deepseek", "gemini", "kimi-code", "openai", "opencode", "opencode-go", "openrouter", "xai",
] as const;

const EXPECTED_LIMIT_GROUPS = [
  {
    provider: "anthropic", contextTokens: 1_000_000, maxOutputTokens: 128_000,
    ids: ["claude-fable-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-4-6", "claude-sonnet-5"],
  },
  {
    provider: "anthropic", contextTokens: 200_000, maxOutputTokens: 64_000,
    ids: ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-opus-4-5", "claude-opus-4-5-20251101"],
  },
  {
    provider: "anthropic", contextTokens: 1_000_000, maxOutputTokens: 64_000,
    ids: ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"],
  },
  {
    provider: "gemini", contextTokens: 1_048_576, maxOutputTokens: 65_536,
    ids: [
      "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-3-flash-preview",
      "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools",
      "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-flash-latest",
      "gemini-flash-lite-latest",
    ],
  },
  {
    provider: "openai", contextTokens: 1_050_000, maxOutputTokens: 128_000,
    ids: ["gpt-5.4", "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro", "gpt-5.6", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
  },
  {
    provider: "openai", contextTokens: 400_000, maxOutputTokens: 128_000,
    ids: ["gpt-5", "gpt-5.1", "gpt-5.2", "gpt-5.2-pro", "gpt-5.3-codex", "gpt-5-mini", "gpt-5-nano", "gpt-5.4-mini", "gpt-5.4-nano"],
  },
  { provider: "openai", contextTokens: 400_000, maxOutputTokens: 272_000, ids: ["gpt-5-pro"] },
  { provider: "openai", contextTokens: 200_000, maxOutputTokens: 100_000, ids: ["o3", "o3-pro"] },
  { provider: "openai", contextTokens: 1_047_576, maxOutputTokens: 32_768, ids: ["gpt-4.1", "gpt-4.1-mini"] },
  { provider: "openai", contextTokens: 128_000, maxOutputTokens: 16_384, ids: ["gpt-4o", "gpt-4o-mini"] },
  { provider: "deepseek", contextTokens: 1_000_000, maxOutputTokens: 384_000, ids: ["deepseek-v4-flash", "deepseek-v4-pro"] },
  { provider: "xai", contextTokens: 1_000_000, maxOutputTokens: 30_000, ids: ["grok-4.3"] },
  { provider: "xai", contextTokens: 256_000, maxOutputTokens: 256_000, ids: ["grok-build-0.1"] },
  { provider: "xai", contextTokens: 500_000, maxOutputTokens: 500_000, ids: ["grok-4.5"] },
  {
    provider: "openrouter", contextTokens: 262_144, maxOutputTokens: 262_144,
    ids: ["moonshotai/kimi-k2.6", "moonshotai/kimi-k2.7-code"],
  },
  {
    provider: "opencode", contextTokens: 1_000_000, maxOutputTokens: 128_000,
    ids: ["claude-fable-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5"],
  },
  { provider: "opencode", contextTokens: 200_000, maxOutputTokens: 64_000, ids: ["claude-haiku-4-5", "claude-opus-4-5"] },
  { provider: "opencode", contextTokens: 1_000_000, maxOutputTokens: 64_000, ids: ["claude-sonnet-4-5", "claude-sonnet-4-6"] },
  { provider: "opencode", contextTokens: 262_144, maxOutputTokens: 65_536, ids: ["qwen3.5-plus", "qwen3.6-plus"] },
  {
    provider: "opencode", contextTokens: 1_048_576, maxOutputTokens: 65_536,
    ids: ["gemini-3-flash", "gemini-3.1-pro", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash"],
  },
  {
    provider: "opencode", contextTokens: 400_000, maxOutputTokens: 128_000,
    ids: [
      "gpt-5", "gpt-5-codex", "gpt-5-nano", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini", "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.4-mini", "gpt-5.4-nano",
    ],
  },
  {
    provider: "opencode", contextTokens: 1_050_000, maxOutputTokens: 128_000,
    ids: ["gpt-5.4", "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
  },
  { provider: "opencode", contextTokens: 128_000, maxOutputTokens: 128_000, ids: ["gpt-5.3-codex-spark"] },
  { provider: "opencode", contextTokens: 500_000, maxOutputTokens: 500_000, ids: ["grok-4.5", "grok-4.6"] },
  { provider: "opencode", contextTokens: 256_000, maxOutputTokens: 256_000, ids: ["grok-build-0.1"] },
  { provider: "opencode", contextTokens: 262_144, maxOutputTokens: 65_536, ids: ["kimi-k2.5", "kimi-k2.6"] },
  { provider: "opencode", contextTokens: 262_144, maxOutputTokens: 262_144, ids: ["kimi-k2.7-code"] },
  { provider: "opencode", contextTokens: 200_000, maxOutputTokens: 32_000, ids: ["big-pickle", "mimo-v2.5-free"] },
  { provider: "opencode", contextTokens: 1_000_000, maxOutputTokens: 384_000, ids: ["deepseek-v4-flash", "deepseek-v4-pro"] },
  { provider: "opencode", contextTokens: 200_000, maxOutputTokens: 128_000, ids: ["deepseek-v4-flash-free"] },
  { provider: "opencode", contextTokens: 204_800, maxOutputTokens: 131_072, ids: ["glm-5", "glm-5.1", "minimax-m2.5", "minimax-m2.7"] },
  { provider: "opencode", contextTokens: 1_000_000, maxOutputTokens: 131_072, ids: ["glm-5.2"] },
  { provider: "opencode", contextTokens: 1_048_576, maxOutputTokens: 131_072, ids: ["kimi-k3"] },
  { provider: "opencode", contextTokens: 190_000, maxOutputTokens: 64_000, ids: ["hy3-free"] },
  { provider: "opencode", contextTokens: 256_000, maxOutputTokens: 32_000, ids: ["laguna-s-2.1-free"] },
  { provider: "opencode", contextTokens: 262_144, maxOutputTokens: 32_768, ids: ["ling-3.0-tiny-free"] },
  { provider: "opencode", contextTokens: 512_000, maxOutputTokens: 128_000, ids: ["minimax-m3"] },
  { provider: "opencode", contextTokens: 262_144, maxOutputTokens: 262_144, ids: ["nemotron-3.5-lightning-free"] },
  { provider: "opencode", contextTokens: 1_000_000, maxOutputTokens: 128_000, ids: ["nemotron-3-ultra-free"] },
  { provider: "opencode-go", contextTokens: 1_000_000, maxOutputTokens: 384_000, ids: ["deepseek-v4-flash", "deepseek-v4-pro"] },
  { provider: "opencode-go", contextTokens: 202_752, maxOutputTokens: 32_768, ids: ["glm-5.1"] },
  { provider: "opencode-go", contextTokens: 1_000_000, maxOutputTokens: 131_072, ids: ["glm-5.2", "minimax-m3", "qwen3.8-max"] },
  { provider: "opencode-go", contextTokens: 1_050_000, maxOutputTokens: 128_000, ids: ["gpt-5.6-luna"] },
  { provider: "opencode-go", contextTokens: 500_000, maxOutputTokens: 500_000, ids: ["grok-4.5"] },
  { provider: "opencode-go", contextTokens: 256_000, maxOutputTokens: 64_000, ids: ["hy3"] },
  { provider: "opencode-go", contextTokens: 262_144, maxOutputTokens: 65_536, ids: ["kimi-k2.6"] },
  { provider: "opencode-go", contextTokens: 262_144, maxOutputTokens: 262_144, ids: ["kimi-k2.7-code"] },
  { provider: "opencode-go", contextTokens: 1_048_576, maxOutputTokens: 131_072, ids: ["kimi-k3"] },
  { provider: "opencode-go", contextTokens: 1_000_000, maxOutputTokens: 128_000, ids: ["mimo-v2.5"] },
  { provider: "opencode-go", contextTokens: 1_048_576, maxOutputTokens: 128_000, ids: ["mimo-v2.5-pro"] },
  { provider: "opencode-go", contextTokens: 204_800, maxOutputTokens: 131_072, ids: ["minimax-m2.7"] },
  { provider: "opencode-go", contextTokens: 1_000_000, maxOutputTokens: 65_536, ids: ["qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus"] },
] as const;

const EXPECTED_LIMITS = new Map(EXPECTED_LIMIT_GROUPS.flatMap((group) => group.ids.map((id) => [
  `${group.provider}/${id}`,
  { contextTokens: group.contextTokens, maxOutputTokens: group.maxOutputTokens },
] as const)));

const EXPECTED_UNKNOWN_LIMITS = [
  "kimi-code/k3",
  "kimi-code/k3-256k",
  "kimi-code/kimi-for-coding",
  "kimi-code/kimi-for-coding-highspeed",
  "opencode/qwen3.7-max",
  "opencode/qwen3.7-plus",
  "openrouter/openrouter/auto",
  "xai/grok-4.20",
  "xai/grok-4.20-multi-agent",
  "xai/grok-4.20-non-reasoning",
  "xai/grok-4.6",
];

const EXPECTED_CONTEXT_ONLY = new Map([
  ["kimi-code/k3", 1_048_576],
  ["kimi-code/k3-256k", 262_144],
  ["kimi-code/kimi-for-coding", 262_144],
  ["kimi-code/kimi-for-coding-highspeed", 262_144],
  ["xai/grok-4.20", 1_000_000],
  ["xai/grok-4.20-multi-agent", 1_000_000],
  ["xai/grok-4.20-non-reasoning", 1_000_000],
  ["xai/grok-4.6", 500_000],
]);

const EXPECTED_MAX_INPUT_GROUPS = [
  {
    provider: "openai", maxInputTokens: 922_000,
    ids: ["gpt-5.4", "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro", "gpt-5.6", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
  },
  {
    provider: "openai", maxInputTokens: 272_000,
    ids: ["gpt-5", "gpt-5.1", "gpt-5.2", "gpt-5.2-pro", "gpt-5.3-codex", "gpt-5-mini", "gpt-5-nano", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5-pro"],
  },
  {
    provider: "opencode", maxInputTokens: 272_000,
    ids: [
      "gpt-5", "gpt-5-codex", "gpt-5-nano", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini", "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.4-mini", "gpt-5.4-nano",
    ],
  },
  {
    provider: "opencode", maxInputTokens: 922_000,
    ids: ["gpt-5.4", "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
  },
  { provider: "opencode", maxInputTokens: 128_000, ids: ["gpt-5.3-codex-spark"] },
  { provider: "opencode", maxInputTokens: 160_000, ids: ["big-pickle"] },
  { provider: "opencode-go", maxInputTokens: 922_000, ids: ["gpt-5.6-luna"] },
] as const;

const EXPECTED_MAX_INPUTS = new Map(EXPECTED_MAX_INPUT_GROUPS.flatMap((group) => group.ids.map((id) => [
  `${group.provider}/${id}`,
  group.maxInputTokens,
] as const)));

test("the maintained catalog contains only retained built-in model sources", () => {
  const models = configuredModelsWithMaintainedCatalog([]);
  assert.equal(models.length, 145);
  assert.deepEqual([...new Set(models.map((model) => model.provider))].sort(), [...CATALOG_PROVIDER_IDS].sort());
  assert.equal(new Set(models.map((model) => `${model.provider}\0${model.id}`)).size, models.length);
  assert.ok(models.every((model) => model.reasoning !== true || (model.reasoningEfforts?.length ?? 0) > 0));
});

test("OpenAI Codex and direct OpenAI catalogs exclude unsupported entitlement-only models", () => {
  const forbiddenEntitlementMarker = ["sp", "ark"].join("");
  const catalogIds = [
    ...configuredModelsWithMaintainedCatalog([])
      .filter((model) => model.provider === "openai")
      .map((model) => model.id),
    ...openAICodexModels("2026-08-11T00:00:00.000Z").map((model) => model.id),
  ];
  assert.equal(catalogIds.some((id) => id.toLowerCase().includes(forbiddenEntitlementMarker)), false);
});

test("published fallback ceilings have an exact census", () => {
  const models = configuredModelsWithMaintainedCatalog([]);
  const actualLimits = new Map(models.flatMap((model) => {
    if (model.maxOutputTokens !== undefined) assert.ok(model.contextTokens !== undefined, `${model.provider}/${model.id}`);
    return model.contextTokens === undefined || model.maxOutputTokens === undefined
      ? []
      : [[`${model.provider}/${model.id}`, {
          contextTokens: model.contextTokens,
          maxOutputTokens: model.maxOutputTokens,
        }] as const];
  }));
  assert.equal(EXPECTED_LIMITS.size, 134);
  assert.deepEqual(actualLimits, EXPECTED_LIMITS);
  assert.deepEqual(
    models.filter((model) => model.contextTokens === undefined).map((model) => `${model.provider}/${model.id}`).sort(),
    EXPECTED_UNKNOWN_LIMITS.filter((reference) => !EXPECTED_CONTEXT_ONLY.has(reference)).sort(),
  );
  assert.deepEqual(new Map(models.flatMap((model) =>
    model.contextTokens === undefined || model.maxOutputTokens !== undefined
      ? []
      : [[`${model.provider}/${model.id}`, model.contextTokens] as const])), EXPECTED_CONTEXT_ONLY);
  assert.deepEqual(Object.fromEntries(CATALOG_PROVIDER_IDS.map((provider) => [
    provider,
    models.filter((model) => model.provider === provider).length,
  ])), {
    anthropic: 13,
    deepseek: 2,
    gemini: 12,
    "kimi-code": 4,
    openai: 24,
    opencode: 62,
    "opencode-go": 18,
    openrouter: 3,
    xai: 7,
  });
});

test("current xAI canonical models retain published capabilities and pricing", () => {
  const models = new Map(configuredModelsWithMaintainedCatalog([])
    .filter((model) => model.provider === "xai")
    .map((model) => [model.id, model]));
  for (const id of ["grok-4.20", "grok-4.20-multi-agent", "grok-4.20-non-reasoning"]) {
    const model = models.get(id);
    assert.equal(model?.contextTokens, 1_000_000, id);
    assert.equal(model?.maxOutputTokens, undefined, id);
    assert.equal(model?.images, true, id);
    assert.deepEqual([
      model?.pricing?.input,
      model?.pricing?.output,
      model?.pricing?.cacheRead,
    ], [1.25, 2.5, 0.2], id);
    assert.deepEqual(model?.pricing?.tiers, [{
      name: "at-least-200k-input",
      minimumInputTokens: 200_000,
      input: 2.5,
      output: 5,
      cacheRead: 0.4,
    }], id);
  }
  assert.equal(models.get("grok-4.20")?.reasoning, true);
  assert.equal(models.get("grok-4.20")?.tools, true);
  assert.deepEqual(models.get("grok-4.20")?.reasoningEfforts, ["medium"]);
  assert.equal(models.get("grok-4.20")?.requestCompatibility?.supportsReasoningEffort, false);
  assert.equal(models.get("grok-4.20-non-reasoning")?.reasoning, false);
  assert.equal(models.get("grok-4.20-non-reasoning")?.tools, true);
  assert.equal(models.get("grok-4.20-non-reasoning")?.reasoningEfforts, undefined);
  assert.equal(models.get("grok-4.20-multi-agent")?.tools, false);
  assert.deepEqual(models.get("grok-4.20-multi-agent")?.reasoningEfforts, ["low", "medium", "high", "xhigh"]);
});

test("published input ceilings have an exact independent census", () => {
  const actual = new Map(configuredModelsWithMaintainedCatalog([]).flatMap((model) =>
    model.maxInputTokens === undefined
      ? []
      : [[`${model.provider}/${model.id}`, model.maxInputTokens] as const]));
  assert.equal(EXPECTED_MAX_INPUTS.size, 40);
  assert.deepEqual(actual, EXPECTED_MAX_INPUTS);
});

test("newly covered OpenCode Zen routes retain complete published capabilities and pricing", () => {
  const expected = new Map([
    ["big-pickle", { images: false, efforts: ["medium"], pricing: [0, 0, 0, 0] }],
    ["claude-haiku-4-5", { images: true, efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], pricing: [1, 5, 0.1, 1.25] }],
    ["claude-sonnet-4-5", { images: true, efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], pricing: [3, 15, 0.3, 3.75] }],
    ["glm-5", { images: false, efforts: ["off", "medium"], pricing: [1, 3.2, 0.2, undefined] }],
    ["glm-5.1", { images: false, efforts: ["off", "medium"], pricing: [1.4, 4.4, 0.26, undefined] }],
    ["gpt-5.3-codex-spark", { images: false, efforts: ["low", "medium", "high", "xhigh"], pricing: [1.75, 14, 0.175, undefined] }],
    ["grok-4.6", { images: true, efforts: ["low", "medium", "high", "xhigh"], pricing: [2, 6, 0.5, undefined] }],
    ["grok-build-0.1", { images: true, efforts: ["medium"], pricing: [1, 2, 0.2, undefined] }],
    ["hy3-free", { images: false, efforts: ["off", "low", "medium", "high"], pricing: [0, 0, 0, undefined] }],
    ["kimi-k2.5", { images: true, efforts: ["off", "medium"], pricing: [0.6, 3, 0.1, undefined] }],
    ["kimi-k2.6", { images: true, efforts: ["off", "medium"], pricing: [0.95, 4, 0.16, undefined] }],
    ["kimi-k2.7-code", { images: true, efforts: ["medium"], pricing: [0.95, 4, 0.19, undefined] }],
    ["ling-3.0-tiny-free", { images: false, efforts: ["medium"], pricing: [0, 0, 0, undefined] }],
    ["mimo-v2.5-free", { images: true, efforts: ["medium"], pricing: [0, 0, 0, undefined] }],
    ["minimax-m2.5", { images: false, efforts: ["medium"], pricing: [0.3, 1.2, 0.06, undefined] }],
    ["minimax-m2.7", { images: false, efforts: ["medium"], pricing: [0.3, 1.2, 0.06, undefined] }],
    ["minimax-m3", { images: true, efforts: ["medium"], pricing: [0.3, 1.2, 0.06, undefined] }],
    ["nemotron-3.5-lightning-free", { images: false, efforts: ["medium"], pricing: [0, 0, 0, undefined] }],
    ["nemotron-3-ultra-free", { images: false, efforts: ["medium"], pricing: [0, 0, 0, undefined] }],
    ["qwen3.5-plus", { images: true, efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], pricing: [0.2, 1.2, 0.02, 0.25] }],
    ["qwen3.6-plus", { images: true, efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], pricing: [0.5, 3, 0.05, 0.625] }],
  ] as const);
  const models = new Map(configuredModelsWithMaintainedCatalog([])
    .filter((model) => model.provider === "opencode")
    .map((model) => [model.id, model]));
  for (const [id, metadata] of expected) {
    const model = models.get(id);
    assert.ok(model?.displayName, id);
    assert.ok(model.description, id);
    assert.equal(model.tools, true, id);
    assert.equal(model.reasoning, true, id);
    assert.equal(model.images, metadata.images, id);
    assert.deepEqual(model.reasoningEfforts, metadata.efforts, id);
    assert.deepEqual([
      model.pricing?.input,
      model.pricing?.output,
      model.pricing?.cacheRead,
      model.pricing?.cacheWrite,
    ], metadata.pricing, id);
  }
  assert.deepEqual(models.get("claude-sonnet-4-5")?.pricing?.tiers, [{
    name: "over-200k-input",
    minimumInputTokens: 200_001,
    input: 6,
    output: 22.5,
    cacheRead: 0.6,
    cacheWrite: 7.5,
  }]);
  for (const id of [
    "big-pickle", "glm-5", "glm-5.1", "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code",
    "mimo-v2.5-free", "minimax-m2.5", "minimax-m2.7", "minimax-m3", "nemotron-3.5-lightning-free",
    "nemotron-3-ultra-free",
  ]) {
    const compatibility = models.get(id)?.requestCompatibility;
    assert.equal(compatibility?.supportsReasoningEffort, false, id);
    assert.equal(compatibility?.requiresReasoningContentOnAssistantMessages, true, id);
  }
  for (const id of ["glm-5", "glm-5.1"]) {
    assert.equal(models.get(id)?.requestCompatibility?.reasoningFormat, "zai", id);
  }
  assert.equal(models.get("grok-build-0.1")?.requestCompatibility?.supportsReasoningEffort, false);
  assert.equal(models.get("grok-build-0.1")?.requestCompatibility?.requiresReasoningContentOnAssistantMessages, undefined);
  assert.equal(models.get("hy3-free")?.requestCompatibility?.supportsReasoningEffort, true);
  assert.equal(models.get("hy3-free")?.requestCompatibility?.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(models.get("ling-3.0-tiny-free")?.requestCompatibility?.supportsReasoningEffort, false);
  assert.equal(models.get("ling-3.0-tiny-free")?.requestCompatibility?.requiresReasoningContentOnAssistantMessages, undefined);
  for (const id of ["qwen3.7-max", "qwen3.7-plus"]) {
    assert.deepEqual(models.get(id), { provider: "opencode", id, metadataSource: "maintained" });
  }
});

test("OpenCode Zen routes expose every maintained ceiling through the runtime registry", async () => {
  const config = BUILTIN_PROVIDER_CONFIGS.opencode;
  assert.equal(config?.kind, "routed");
  if (config?.kind !== "routed") return;
  const routes = new Map(config.routes.map((route) => [route.model, route]));
  assert.equal(routes.get("kimi-k2.5")?.adapter, "chat-kimi");
  assert.equal(routes.get("kimi-k2.6")?.adapter, "chat-kimi");
  assert.equal(routes.get("kimi-k2.7-code")?.adapter, "chat");
  assert.equal(routes.get("nemotron-3.5-lightning-free")?.adapter, "chat");
  const registry = new ProviderRegistry([{
    id: "opencode",
    async *stream() {},
    async listModels() {
      return config.routes.map((route) => structuredClone(route.modelInfo!));
    },
  }], {
    configuredModels: configuredModelsWithMaintainedCatalog([]).filter((model) => model.provider === "opencode"),
  });
  const models = await registry.listModels("opencode", new AbortController().signal, { refresh: true });
  assert.equal(models.length, 62);
  assert.deepEqual(new Map(models.flatMap((model) => model.contextTokens === undefined ? [] : [[
    `opencode/${model.id}`,
    { contextTokens: model.contextTokens, maxOutputTokens: model.maxOutputTokens },
  ] as const])), new Map([...EXPECTED_LIMITS].filter(([reference]) => reference.startsWith("opencode/"))));
  assert.deepEqual(
    models.filter((model) => model.contextTokens === undefined).map((model) => model.id).sort(),
    ["qwen3.7-max", "qwen3.7-plus"],
  );
  for (const [id, levels] of [
    ["claude-haiku-4-5", ["off", "minimal", "low", "medium", "high", "xhigh", "max"]],
    ["qwen3.6-plus", ["off", "minimal", "low", "medium", "high", "xhigh", "max"]],
    ["kimi-k2.6", ["off", "medium"]],
    ["kimi-k2.7-code", ["medium"]],
    ["minimax-m3", ["medium"]],
    ["nemotron-3.5-lightning-free", ["medium"]],
  ] as const) {
    const model = models.find((entry) => entry.id === id);
    assert.ok(model, id);
    assert.deepEqual(modelReasoningEfforts(model), levels, id);
  }
});

test("live provider ceilings remain authoritative over maintained fallbacks", async () => {
  const observedAt = "2026-08-11T00:00:00.000Z";
  const capability = { value: "supported" as const, source: "provider" as const, observedAt };
  const registry = new ProviderRegistry([{
    id: "openai",
    async *stream() {},
    async listModels() {
      return [{
        id: "gpt-5",
        provider: "openai",
        contextTokens: 123_456,
        maxInputTokens: 111_111,
        maxOutputTokens: 12_345,
        capabilities: { tools: capability, reasoning: capability, images: capability },
      }];
    },
  }], {
    configuredModels: configuredModelsWithMaintainedCatalog([]).filter((model) => model.provider === "openai"),
  });
  const models = await registry.listModels("openai", new AbortController().signal, { refresh: true });
  const live = models.find((model) => model.id === "gpt-5");
  assert.equal(live?.contextTokens, 123_456);
  assert.equal(live?.maxInputTokens, 111_111);
  assert.equal(live?.maxOutputTokens, 12_345);
});

test("selectable retained defaults keep reviewed metadata", () => {
  const byReference = new Map(configuredModelsWithMaintainedCatalog([])
    .map((model) => [`${model.provider}/${model.id}`, model]));
  for (const reference of [
    "openai/gpt-5.6-sol",
    "anthropic/claude-opus-5",
    "gemini/gemini-3.6-flash",
    "deepseek/deepseek-v4-pro",
    "xai/grok-4.5",
    "openrouter/openrouter/auto",
    "opencode/gpt-5.6-sol",
    "opencode-go/gpt-5.6-luna",
    "opencode-go/grok-4.5",
  ]) assert.ok(byReference.has(reference), reference);

  const sol = byReference.get("openai/gpt-5.6-sol");
  assert.deepEqual(sol?.reasoningEfforts, ["off", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(sol?.reasoningEffortMap, { off: "none" });
  assert.equal(sol?.requestCompatibility?.supportsExplicitPromptCacheMode, true);
  assert.equal(sol?.requestCompatibility?.supportsPromptCacheBreakpoints, true);

  const goGrok = byReference.get("opencode-go/grok-4.5");
  assert.equal(goGrok?.contextTokens, 500_000);
  assert.equal(goGrok?.maxOutputTokens, 500_000);
  assert.deepEqual(goGrok?.reasoningEfforts, ["low", "medium", "high"]);
  assert.equal(goGrok?.pricing?.cacheRead, 0.3);
  assert.equal(goGrok?.pricing?.tiers, undefined);

  const goDeepSeek = byReference.get("opencode-go/deepseek-v4-flash");
  assert.equal(goDeepSeek?.displayName, "DeepSeek V4 Flash (2x usage)");
  assert.equal(goDeepSeek?.contextTokens, 1_000_000);
  assert.equal(goDeepSeek?.maxOutputTokens, 384_000);
  assert.deepEqual(goDeepSeek?.reasoningEfforts, ["low", "high", "max"]);
  assert.equal(goDeepSeek?.requestCompatibility?.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(goDeepSeek?.requestCompatibility?.supportsReasoningEffort, true);
  assert.equal(goDeepSeek?.requestCompatibility?.reasoningFormat, undefined);
  assert.equal(goDeepSeek?.pricing?.input, 0.14);
  assert.equal(goDeepSeek?.pricing?.output, 0.28);
  assert.equal(goDeepSeek?.pricing?.cacheRead, 0.0028);
  const openRouterKimi = byReference.get("openrouter/moonshotai/kimi-k2.6");
  assert.equal(openRouterKimi?.pricing?.input, 0.95);
  assert.equal(openRouterKimi?.pricing?.output, 4);
  assert.equal(openRouterKimi?.pricing?.cacheRead, 0.16);
  assert.equal(byReference.has("opencode-go/minimax-m2.5"), false);
  assert.deepEqual(byReference.get("opencode-go/minimax-m2.7")?.reasoningEfforts, ["off"]);
  assert.equal(byReference.get("opencode-go/minimax-m2.7")?.pricing?.cacheWrite, 0.375);
  assert.deepEqual(byReference.get("opencode-go/minimax-m3")?.reasoningEfforts, ["off", "high"]);
  for (const model of ["qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus", "qwen3.8-max"]) {
    assert.deepEqual(byReference.get(`opencode-go/${model}`)?.reasoningEfforts, ["high", "max"], model);
  }
  assert.equal(byReference.get("opencode-go/gpt-5.6-luna")?.pricing?.input, 0.2);
  assert.equal(byReference.get("opencode-go/gpt-5.6-luna")?.pricing?.output, 1.2);
  assert.equal(byReference.get("opencode-go/gpt-5.6-luna")?.pricing?.cacheRead, 0.02);
  assert.equal(byReference.get("opencode-go/gpt-5.6-luna")?.pricing?.cacheWrite, 0.25);
  assert.equal(byReference.get("opencode-go/gpt-5.6-luna")?.pricing?.tiers?.[0]?.minimumInputTokens, 272_001);
  assert.equal(byReference.get("opencode-go/minimax-m3")?.pricing?.tiers, undefined);
  assert.equal(byReference.get("opencode-go/qwen3.7-plus")?.pricing?.tiers?.[0]?.minimumInputTokens, 256_001);
});

test("user configured model metadata overrides the maintained entry without duplicates", () => {
  const models = configuredModelsWithMaintainedCatalog([{
    provider: "openai",
    id: "gpt-5.6-sol",
    displayName: "Team GPT",
    contextTokens: 123_456,
  }]);
  const matches = models.filter((model) => model.provider === "openai" && model.id === "gpt-5.6-sol");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.displayName, "Team GPT");
  assert.equal(matches[0]?.contextTokens, 123_456);
});
