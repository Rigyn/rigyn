import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileProviderModelsStore } from "../../src/providers/models-store.js";
import type { ProviderModel } from "../../src/providers/models.js";

function model(provider = "fixture", id = "model"): ProviderModel {
  return {
    id,
    name: "Fixture model",
    api: "openai-responses",
    provider,
    baseUrl: "https://example.test/v1",
    reasoning: true,
    thinkingLevelMap: { off: "off", high: "high", max: null },
    input: ["text", "image"],
    cost: {
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 1.25,
      tiers: [{ inputTokensAbove: 100_000, input: 2, output: 3, cacheRead: 0.2, cacheWrite: 2.5 }],
    },
    contextWindow: 200_000,
    maxInputTokens: 160_000,
    maxTokens: 16_000,
    headers: { "x-fixture": "enabled" },
    compat: { supportsStore: false },
  };
}

test("file provider model store validates and detaches complete records", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-models-store-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const store = new FileProviderModelsStore(join(directory, "models.json"));
  const original = model();
  const inheritedBaseUrl = { ...model("fixture", "provider-default"), baseUrl: "" };
  await store.write("fixture", { models: [original, inheritedBaseUrl], checkedAt: 123, etag: 'W/"fixture"' });
  original.name = "mutated";

  const stored = await store.read("fixture");
  assert.equal(stored?.models[0]?.name, "Fixture model");
  assert.equal(stored?.models[0]?.maxInputTokens, 160_000);
  assert.equal(stored?.models[1]?.baseUrl, "");
  assert.equal(stored?.checkedAt, 123);
  assert.equal(stored?.etag, 'W/"fixture"');
  if (stored !== undefined) (stored.models[0] as ProviderModel).name = "read mutation";
  assert.equal((await store.read("fixture"))?.models[0]?.name, "Fixture model");
  assert.equal(
    (await new FileProviderModelsStore(join(directory, "models.json")).read("fixture"))?.models[0]?.maxInputTokens,
    160_000,
  );
});

test("file provider model store rejects invalid provider ids and complete-record violations", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-models-store-invalid-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const store = new FileProviderModelsStore(join(directory, "models.json"));

  await assert.rejects(store.read("../fixture"), /provider is invalid/u);
  await assert.rejects(store.write(" fixture", { models: [] }), /surrounding whitespace/u);
  await assert.rejects(store.delete("__proto__"), /provider is invalid/u);
  await assert.rejects(
    store.write("fixture", { models: [{ ...model("other") }] }),
    /provider must match fixture/u,
  );
  await assert.rejects(
    store.write("fixture", { models: [{ ...model(), compat: { supportsStore: "yes" } as never }] }),
    /supportsStore must be a boolean/u,
  );
  await assert.rejects(
    store.write("fixture", { models: [{ ...model(), cost: { ...model().cost, tiers: [
      { inputTokensAbove: 100, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      { inputTokensAbove: 100, input: 2, output: 2, cacheRead: 0, cacheWrite: 0 },
    ] } }] }),
    /duplicate thresholds/u,
  );
  await assert.rejects(
    store.write("fixture", { models: Array.from({ length: 4_097 }, (_, index) => model("fixture", `m-${index}`)) }),
    /at most 4096 entries/u,
  );
});

test("file provider model store rejects malformed and prototype-unsafe persisted data", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-models-store-shape-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const path = join(directory, "models.json");
  const store = new FileProviderModelsStore(path);

  await writeFile(path, JSON.stringify({ fixture: { models: [model()], checkedAt: -1 } }));
  await assert.rejects(store.read("fixture"), /checkedAt must be a non-negative safe integer/u);
  await writeFile(path, JSON.stringify({ fixture: { models: [model()], etag: "not-an-etag" } }));
  await assert.rejects(store.read("fixture"), /etag is invalid/u);
  await writeFile(path, '{"__proto__":{"models":[]}}');
  await assert.rejects(store.read("fixture"), /__proto__ is reserved/u);

  let getterRead = false;
  const unsafe = model();
  Object.defineProperty(unsafe, "name", {
    enumerable: true,
    get() {
      getterRead = true;
      return "unsafe";
    },
  });
  await assert.rejects(store.write("fixture", { models: [unsafe] }), /data propert/u);
  assert.equal(getterRead, false);

  const inherited = Object.create({ inherited: true }) as ProviderModel;
  Object.assign(inherited, model());
  await assert.rejects(store.write("fixture", { models: [inherited] }), /plain object/u);
});

test("file provider model store atomically drops legacy or mismatched cache scopes", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-models-store-scope-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const store = new FileProviderModelsStore(join(directory, "models.json"));
  const firstScope = `credential-v1:${"a".repeat(64)}`;
  const secondScope = `credential-v1:${"b".repeat(64)}`;

  await store.write("fixture", { models: [model()], cacheScope: firstScope });
  assert.equal((await store.read("fixture", firstScope))?.cacheScope, firstScope);
  assert.equal(await store.read("fixture", secondScope), undefined);
  assert.equal(await store.read("fixture"), undefined);

  await store.write("fixture", { models: [model()] });
  assert.equal(await store.read("fixture", firstScope), undefined);
  await assert.rejects(
    store.write("fixture", { models: [model()], cacheScope: "invalid" }),
    /cacheScope is invalid/u,
  );
});

test("file provider model snapshots detach reads and preserve later cross-process writes", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-models-store-snapshot-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const path = join(directory, "models.json");
  const store = new FileProviderModelsStore(path);
  const scope = `credential-v1:${"c".repeat(64)}`;
  await store.write("first", { models: [model("first", "old")], cacheScope: scope });
  const snapshot = await store.snapshot();

  await store.write("first", { models: [model("first", "new")], cacheScope: scope });
  assert.equal((await snapshot.read("first", scope))?.models[0]?.id, "old");
  assert.equal((await store.read("first", scope))?.models[0]?.id, "new");

  const mismatched = `credential-v1:${"d".repeat(64)}`;
  assert.equal(await snapshot.read("first", mismatched), undefined);
  assert.equal((await store.read("first", scope))?.models[0]?.id, "new");
});
