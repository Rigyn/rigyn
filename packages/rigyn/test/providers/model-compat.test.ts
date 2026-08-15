import assert from "node:assert/strict";
import test from "node:test";

import type { Api, Model } from "@rigyn/models";

import {
  ModelRuntime,
  resolveCliModel,
  resolveModelScopeWithDiagnostics,
} from "../../src/providers/model-compat.js";
import {
  createModels,
  createProvider,
  InMemoryProviderCredentialStore,
} from "../../src/providers/models.js";

function model(
  provider: string,
  id: string,
  options: { name?: string; reasoning?: boolean } = {},
): Model<Api> {
  return {
    provider,
    id,
    name: options.name ?? id,
    api: "openai-responses",
    baseUrl: "https://example.test/v1",
    reasoning: options.reasoning ?? false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  };
}

const catalog = [
  model("letters", "alpha-coder-20250101", { name: "Alpha Coder" }),
  model("letters", "alpha-coder-latest", { name: "Alpha Coder Current", reasoning: true }),
  model("numbers", "model-one"),
  model("gateway", "numbers/model-one:extended"),
  model("symbols", "bracketed[1m]", { reasoning: true }),
];

test("ModelRuntime carries the OAuth freshness override to its model collection", async () => {
  const credentials = new InMemoryProviderCredentialStore();
  await credentials.modify("runtime-oauth", async () => ({
    type: "oauth",
    access: "old-token",
    refresh: "refresh",
    expires: Date.now() + 10 * 60_000,
  }));
  const models = createModels({ credentials });
  let refreshes = 0;
  models.setProvider(createProvider({
    id: "runtime-oauth",
    auth: {
      oauth: {
        name: "OAuth",
        async login() {
          throw new Error("unused");
        },
        async refresh(credential) {
          refreshes += 1;
          return { ...credential, access: "new-token", expires: Date.now() + 60 * 60_000 };
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
    models: [{ ...model("runtime-oauth", "model"), api: "openai-responses" }],
    api: { async *stream() {} },
  }));
  const runtime = await ModelRuntime.create({
    models,
    modelsPath: null,
    allowModelNetwork: false,
  });

  assert.equal(
    (await runtime.getAuth("runtime-oauth", { minOAuthValidityMs: 30 * 60_000 }))?.auth.apiKey,
    "new-token",
  );
  assert.equal(refreshes, 1);
});

test("ModelRuntime rejects an unprotectable runtime API-key override before installing it", async (t) => {
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  t.after(async () => await runtime.close());

  await assert.rejects(runtime.setRuntimeApiKey("openai", "abc"), /at least 4 characters/u);
  assert.equal((await runtime.listCredentials()).some((entry) => entry.providerId === "openai"), false);
});

test("ModelRuntime cleanup is idempotent and does not take ownership of caller models", async () => {
  const models = createModels();
  const runtime = await ModelRuntime.create({ models, modelsPath: null });

  await runtime.close();
  await runtime.close();
  await runtime[Symbol.asyncDispose]();
  assert.equal(runtime.models(), models);
});

test("deprecated auth compatibility contains hostile caller-owned model failures", async (t) => {
  const models = createModels();
  const runtime = await ModelRuntime.create({ models, modelsPath: null });
  t.after(async () => await runtime.close());
  let traps = 0;
  const hostile = new Proxy({}, {
    get() { traps += 1; throw new Error("get trap"); },
    getPrototypeOf() { traps += 1; throw new Error("prototype trap"); },
  });
  models.getAuth = async () => { throw hostile; };

  assert.deepEqual(await runtime.getApiKeyAndHeaders(model("hostile", "model")), {
    ok: false,
    error: "[Thrown object]",
  });
  assert.equal(traps, 0);
});

test("scoped model compatibility waits for availability and returns structured warnings", async () => {
  let completed = false;
  const result = await resolveModelScopeWithDiagnostics(
    [
      "alpha:high",
      "numbers/model-one:unknown",
      "symbols/bracketed[1m]:low",
      "missing",
    ],
    {
      async getAvailable() {
        await Promise.resolve();
        completed = true;
        return catalog;
      },
    },
  );

  assert.equal(completed, true);
  assert.deepEqual(
    result.scopedModels.map((entry) => ({
      provider: entry.model.provider,
      id: entry.model.id,
      thinkingLevel: entry.thinkingLevel,
    })),
    [
      { provider: "letters", id: "alpha-coder-latest", thinkingLevel: "high" },
      { provider: "numbers", id: "model-one", thinkingLevel: undefined },
      { provider: "symbols", id: "bracketed[1m]", thinkingLevel: "low" },
    ],
  );
  assert.deepEqual(
    result.diagnostics.map((entry) => ({
      type: entry.type,
      code: entry.code,
      pattern: entry.pattern,
    })),
    [
      { type: "warning", code: "invalid-thinking-level", pattern: "numbers/model-one:unknown" },
      { type: "warning", code: "no-match", pattern: "missing" },
    ],
  );
  assert.match(result.diagnostics[0]!.message, /unknown/u);
  assert.match(result.diagnostics[1]!.message, /missing/u);
  assert.equal("models" in result, false);
  assert.equal("omittedCount" in result, false);
});

test("scoped model globs retain catalog order and do not duplicate earlier selections", async () => {
  const result = await resolveModelScopeWithDiagnostics(
    ["letters/*:medium", "*coder*:high"],
    { getAvailable: () => catalog },
  );

  assert.deepEqual(
    result.scopedModels.map((entry) => `${entry.model.id}:${entry.thinkingLevel ?? "default"}`),
    ["alpha-coder-20250101:medium", "alpha-coder-latest:medium"],
  );
  assert.deepEqual(result.diagnostics, []);
});

test("CLI model compatibility accepts CLI-named inputs and resolves fuzzy and thinking patterns", () => {
  const runtime = {
    getModels: () => catalog,
    hasConfiguredAuth: () => true,
  };

  const qualified = resolveCliModel({
    cliModel: "numbers/model-one",
    modelRuntime: runtime,
  });
  assert.equal(qualified.model?.provider, "numbers");
  assert.equal(qualified.model?.id, "model-one");
  assert.equal(qualified.warning, undefined);
  assert.equal(qualified.error, undefined);

  const fuzzy = resolveCliModel({
    cliProvider: "letters",
    cliModel: "alpha:high",
    modelRuntime: runtime,
  });
  assert.equal(fuzzy.model?.id, "alpha-coder-latest");
  assert.equal(fuzzy.thinkingLevel, "high");
  assert.equal(fuzzy.warning, undefined);
  assert.equal(fuzzy.error, undefined);

  const rawSlashId = resolveCliModel({
    cliModel: "numbers/model-one:extended",
    modelRuntime: runtime,
  });
  assert.equal(rawSlashId.model?.provider, "gateway");
  assert.equal(rawSlashId.model?.id, "numbers/model-one:extended");
});

test("CLI custom-model fallback keeps explicit thinking separate and emits a warning", () => {
  const runtime = {
    getModels: () => catalog,
    hasConfiguredAuth: () => true,
  };

  const shorthand = resolveCliModel({
    cliProvider: "letters",
    cliModel: "private-build:high",
    modelRuntime: runtime,
  });
  assert.equal(shorthand.model?.provider, "letters");
  assert.equal(shorthand.model?.id, "private-build");
  assert.equal(shorthand.model?.reasoning, true);
  assert.equal(shorthand.thinkingLevel, "high");
  assert.match(shorthand.warning ?? "", /custom model ID/u);
  assert.equal(shorthand.error, undefined);

  const explicitThinking = resolveCliModel({
    cliProvider: "letters",
    cliModel: "private-build:high",
    cliThinking: "medium",
    modelRuntime: runtime,
  });
  assert.equal(explicitThinking.model?.id, "private-build:high");
  assert.equal(explicitThinking.thinkingLevel, undefined);

  assert.deepEqual(resolveCliModel({
    modelRuntime: runtime,
  }), {
    model: undefined,
    warning: undefined,
    error: undefined,
  });
  assert.match(resolveCliModel({
    cliProvider: "absent",
    cliModel: "model",
    modelRuntime: runtime,
  }).error ?? "", /absent/u);
});
