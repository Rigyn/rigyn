import assert from "node:assert/strict";
import test from "node:test";
import {
  createProvider,
  createModels,
  fauxModel,
  fauxProvider,
  getBuiltinProviders,
  getModels,
  kimiCodeModels,
  opencodeGoModels,
  type Credential,
  type CredentialStore,
} from "../src/index.ts";
import { model, userContext } from "./black-box-helpers.ts";

test("built-in providers expose native identity, catalog, and streaming surfaces", () => {
  const providers = getBuiltinProviders();
  const ids = new Set(providers.map((provider) => provider.id));
  for (const expected of ["openai", "anthropic", "google", "kimi-code", "openrouter", "opencode", "opencode-go", "xai"]) {
    assert.ok(ids.has(expected), `missing ${expected}`);
  }
  for (const provider of providers) {
    assert.ok(provider.id.length > 0);
    assert.ok(provider.name.length > 0);
    assert.equal(typeof provider.getModels, "function");
    assert.equal(typeof provider.stream, "function");
    assert.equal(typeof provider.streamSimple, "function");
    for (const entry of provider.getModels()) assert.equal(entry.provider, provider.id);
  }
});

test("Kimi Code keeps its strict direct shard empty rather than inventing output limits or per-token prices", () => {
  assert.deepEqual(kimiCodeModels, []);
  assert.deepEqual(getModels("kimi-code"), []);
});

test("a native Faux provider can be registered and queried without authentication", async () => {
  const runtime = createModels({ providers: [fauxProvider(() => ({ text: "ok" }))] });
  assert.equal(runtime.getProvider("faux")?.id, "faux");
  assert.equal(runtime.getModel("faux", "faux")?.id, fauxModel.id);
  assert.equal((await runtime.complete(fauxModel, userContext())).content[0]?.type, "text");
  assert.equal((await runtime.completeSimple(fauxModel, userContext())).content[0]?.type, "text");
});

test("login carries cancellation through the credential commit", async () => {
  const controller = new AbortController();
  const cancellation = new Error("login cancelled before storage");
  let stored = false;
  const credentials = {
    async read() { return undefined; },
    async list() { return []; },
    async modify(
      _provider: string,
      update: (current: Credential | undefined) => Credential | undefined | Promise<Credential | undefined>,
      signal?: AbortSignal,
    ): Promise<Credential | undefined> {
      const replacement = await update(undefined);
      controller.abort(cancellation);
      signal?.throwIfAborted();
      stored = replacement !== undefined;
      return replacement;
    },
    async delete() {},
  } satisfies CredentialStore;
  const runtime = createModels({
    credentials,
    providers: [createProvider({
      id: "cancelled-login",
      auth: {
        apiKey: {
          name: "Key",
          async login() { return { type: "api_key", key: "late-secret" }; },
          async resolve() { return undefined; },
        },
      },
    })],
  });

  await assert.rejects(runtime.login("cancelled-login", "api_key", {
    signal: controller.signal,
    async prompt() { return "unused"; },
    notify() {},
  }), (error: unknown) => error === cancellation);
  assert.equal(stored, false);
});

test("OpenCode Go keeps its direct shard empty rather than guessing routed metadata", () => {
  assert.deepEqual(opencodeGoModels, []);
  assert.deepEqual(getModels("opencode-go"), []);
});

test("model catalogs clone caller input and every public snapshot", async () => {
  const source = model("faux", { id: "safe", name: "Safe", provider: "custom" });
  const provider = createProvider({ id: "custom", models: [source] });
  source.name = "caller mutation";
  const providerSnapshot = provider.getModels();
  providerSnapshot[0]!.name = "provider snapshot mutation";

  const runtime = createModels({ providers: [provider] });
  const catalog = runtime.getModels("custom");
  assert.equal(catalog[0]?.name, "Safe");
  catalog[0]!.name = "runtime snapshot mutation";
  assert.equal(runtime.getModel("custom", "safe")?.name, "Safe");

  const available = await runtime.getAvailable("custom");
  available[0]!.name = "available mutation";
  assert.equal(runtime.getAvailableSnapshot()[0]?.name, "Safe");
});

test("model catalogs reject duplicates and invalid core bounds", () => {
  const duplicate = model("faux", { id: "duplicate", provider: "custom" });
  assert.throws(() => createModels({
    providers: [createProvider({ id: "custom", models: [duplicate, structuredClone(duplicate)] })],
  }), /Duplicate model id/u);

  const invalid = model("faux", { id: "invalid", provider: "custom", contextWindow: 0 });
  assert.throws(() => createModels({
    providers: [createProvider({ id: "custom", models: [invalid] })],
  }), /contextWindow must be a positive safe integer/u);
});
