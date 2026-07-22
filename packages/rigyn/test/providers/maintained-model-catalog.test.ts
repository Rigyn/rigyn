import assert from "node:assert/strict";
import test from "node:test";

import { configuredModelsWithMaintainedCatalog } from "../../src/providers/maintained-model-catalog.js";

test("maintained model catalog includes selectable defaults for major built-in providers", () => {
  const models = configuredModelsWithMaintainedCatalog([]);
  assert.equal(models.length, 157);
  assert.equal(new Set(models.map((model) => `${model.provider}\0${model.id}`)).size, models.length);
  const ids = new Set(models.map((model) => `${model.provider}/${model.id}`));
  for (const expected of [
    "openai/gpt-5.6-sol",
    "openai/gpt-4.1-mini",
    "anthropic/claude-opus-4-8",
    "gemini/gemini-3.5-flash",
    "mistral/devstral-medium-latest",
    "groq/openai/gpt-oss-120b",
    "deepseek/deepseek-v4-pro",
    "vercel-ai-gateway/anthropic/claude-sonnet-4.6",
    "zai/glm-5.1",
    "zai-coding-cn/glm-5.1",
    "kimi-coding/kimi-for-coding",
    "minimax/MiniMax-M3",
    "minimax-cn/MiniMax-M3",
    "moonshotai/kimi-k2.7-code",
    "moonshotai-cn/kimi-k2.6",
    "xiaomi-token-plan-cn/mimo-v2.5-pro",
    "xiaomi-token-plan-ams/mimo-v2.5-pro",
    "xiaomi-token-plan-sgp/mimo-v2.5-pro",
  ]) assert.equal(ids.has(expected), true, expected);
});

test("maintained metadata is exact for documented models and conservative for fallback IDs", () => {
  const models = configuredModelsWithMaintainedCatalog([]);
  const byReference = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
  const sol = byReference.get("openai/gpt-5.6-sol");
  assert.equal(sol?.contextTokens, 1_050_000);
  assert.equal(sol?.maxOutputTokens, 128_000);
  assert.deepEqual(sol?.reasoningEfforts, ["off", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(sol?.pricing?.tiers?.[0], {
    name: "over-272k-input",
    minimumInputTokens: 272_001,
    input: 10,
    output: 45,
    cacheRead: 1,
    cacheWrite: 12.5,
  });

  const opus = byReference.get("anthropic/claude-opus-4-8");
  assert.equal(opus?.pricing?.cacheWrite5m, 6.25);
  assert.equal(opus?.pricing?.cacheWrite1h, 10);

  const fallback = byReference.get("mistral/devstral-medium-latest");
  assert.equal(fallback?.tools, undefined);
  assert.equal(fallback?.reasoning, undefined);
  assert.equal(fallback?.images, undefined);
  assert.equal(fallback?.metadataSource, "maintained");

  const kimi = byReference.get("kimi-coding/kimi-for-coding");
  assert.equal(kimi?.contextTokens, 262_144);
  assert.equal(kimi?.maxOutputTokens, 32_768);
  assert.deepEqual(kimi?.reasoningEfforts, ["off", "low", "medium", "high"]);

  const minimax = byReference.get("minimax/MiniMax-M3");
  assert.equal(minimax?.contextTokens, 1_000_000);
  assert.equal(minimax?.reasoning, undefined);
  assert.equal(minimax?.reasoningEfforts, undefined);

  const moonshot = byReference.get("moonshotai/kimi-k2.7-code");
  assert.deepEqual(moonshot?.reasoningEffortMap, { off: null });

  const tokenPlan = byReference.get("xiaomi-token-plan-cn/mimo-v2.5-pro");
  assert.equal(tokenPlan?.contextTokens, 1_000_000);
  assert.equal(tokenPlan?.maxOutputTokens, 128_000);
  assert.deepEqual(tokenPlan?.reasoningEfforts, ["off", "high"]);
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
