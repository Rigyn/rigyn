import assert from "node:assert/strict";
import test from "node:test";

import {
  modelMatchesScope,
  orderModelsForScope,
  parseModelScope,
  resolveModelsForScope,
  SCOPED_MODELS_NONE,
  type ScopedModelSelection,
} from "../../src/providers/model-scope.js";

test("scope matching supports qualified globs and only recognized thinking suffixes", () => {
  assert.equal(modelMatchesScope("cloud.provider-v2", "org/model.v3@2026", ["cloud.provider-v2/org/*:high"]), true);
  assert.equal(modelMatchesScope("cloud.provider-v2", "org/model.v3@2026", ["cloud.provider-v2/org/*:turbo"]), false);
  assert.equal(modelMatchesScope("cloud.provider-v2", "org/model.v3@2026", ["cloud.provider-v?/org/model.v[0-9]@*"]), true);
  assert.equal(modelMatchesScope("openrouter", "openai/gpt-5", ["openrouter/*"]), true);
  assert.equal(modelMatchesScope("cloud.provider-v2", "literal:high", ["cloud.provider-v2/literal:high"]), true);
  // This predicate is intentionally candidate-local; catalog-wide resolution below gives the full literal ID precedence.
  assert.equal(modelMatchesScope("cloud.provider-v2", "literal", ["cloud.provider-v2/literal:high"]), true);
  assert.equal(modelMatchesScope("cloud.provider-v2", "literal", [SCOPED_MODELS_NONE]), false);
});

test("scoped order carries thinking only when the suffix was not a literal model match", () => {
  const available: ScopedModelSelection[] = [
    { provider: "cloud.provider-v2", model: "literal:high" },
    { provider: "cloud.provider-v2", model: "literal" },
    { provider: "other", model: "literal" },
  ];
  assert.deepEqual(orderModelsForScope(available, ["cloud.provider-v2/literal:high", "other/lit*:low"]), [
    { provider: "cloud.provider-v2", model: "literal:high" },
    { provider: "other", model: "literal", reasoningEffort: "low" },
  ]);
  assert.deepEqual(orderModelsForScope(available.filter((entry) => entry.model !== "literal:high"), ["cloud.provider-v2/literal:high"]), [
    { provider: "cloud.provider-v2", model: "literal", reasoningEffort: "high" },
  ]);
});

test("large scoped catalogs resolve deterministically with precompiled bounded glob features", () => {
  const available: ScopedModelSelection[] = Array.from({ length: 20_000 }, (_, index) => ({
    provider: `provider-${index % 20}`,
    model: `org/model-${String(index).padStart(5, "0")}`,
  }));
  const patterns = Array.from({ length: 5 }, (_, index) => `provider-${index}/org/model-19???:high`);
  const first = orderModelsForScope(available, patterns);
  const second = orderModelsForScope([...available].reverse(), patterns);
  assert.deepEqual(second, first);
  assert.equal(first.every((entry) => entry.reasoningEffort === "high"), true);
});

test("scope reasoning diagnostics omit model-specific unsupported combinations", () => {
  const available: ScopedModelSelection[] = [
    { provider: "reasoning", model: "required" },
    { provider: "reasoning", model: "unsupported" },
  ];
  const supported = new Map([
    ["required", ["low", "high"] as const],
    ["unsupported", ["off"] as const],
  ]);
  const resolution = resolveModelsForScope(
    available,
    ["reasoning/required:off", "reasoning/unsupported:high", "reasoning/required:low"],
    (model) => supported.get(model.model),
  );
  assert.deepEqual(resolution.models, [{ provider: "reasoning", model: "required", reasoningEffort: "low" }]);
  assert.equal(resolution.omittedCount, 2);
  assert.deepEqual(resolution.diagnostics, [
    {
      pattern: "reasoning/required:off",
      provider: "reasoning",
      model: "required",
      reasoningEffort: "off",
      supportedReasoningEfforts: ["low", "high"],
    },
    {
      pattern: "reasoning/unsupported:high",
      provider: "reasoning",
      model: "unsupported",
      reasoningEffort: "high",
      supportedReasoningEfforts: ["off"],
    },
  ]);
});

test("scope input stays ordered, normalized, and bounded", () => {
  assert.deepEqual(parseModelScope(" cloud.provider-v2/org/*:high, other/model "), [
    "cloud.provider-v2/org/*:high",
    "other/model",
  ]);
  assert.deepEqual(parseModelScope("clear"), []);
  assert.deepEqual(parseModelScope("all"), []);
  assert.deepEqual(parseModelScope("none"), [SCOPED_MODELS_NONE]);
  assert.throws(() => parseModelScope("x".repeat(257)), /at most 100 patterns/u);
  assert.throws(() => modelMatchesScope("provider", "model", ["[z-a]"]), /Invalid model scope pattern/u);
});
