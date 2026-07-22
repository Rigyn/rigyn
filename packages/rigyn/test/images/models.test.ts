import assert from "node:assert/strict";
import test from "node:test";

import type { ResolvedCredential } from "../../src/auth/types.js";
import {
  builtinImagesModels,
  createImagesModels,
  createImagesProvider,
  getImageModel,
  getImageModels,
  getImageProviders,
  type AssistantImages,
  type ImagesApi,
  type ImagesContext,
  type ImagesModel,
  type ImagesOptions,
} from "../../src/images/index.js";

function imageModel(provider: string, id = "model-a"): ImagesModel<ImagesApi> {
  return {
    id,
    name: id,
    api: "test-images",
    provider,
    baseUrl: "https://images.example.test/v1",
    input: ["text"],
    output: ["image"],
  };
}

function result(model: ImagesModel<ImagesApi>): AssistantImages {
  return {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [{ type: "image", mimeType: "image/png", data: "aGk=" }],
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

const context: ImagesContext = { input: [{ type: "text", text: "a red circle" }] };

test("image model collections mutate and isolate throwing provider catalogs", () => {
  const models = createImagesModels();
  models.setProvider(createImagesProvider({
    id: "one",
    auth: {},
    models: [imageModel("one", "a"), imageModel("one", "b")],
    api: { generateImages: async (model) => result(model) },
  }));
  models.setProvider({
    id: "broken",
    name: "Broken",
    auth: {},
    getModels: () => { throw new Error("broken catalog"); },
    generateImages: async (model) => result(model),
  });

  assert.deepEqual(models.getProviders().map((provider) => provider.id), ["one", "broken"]);
  assert.deepEqual(models.getModels().map((model) => model.id), ["a", "b"]);
  assert.deepEqual(models.getModels("broken"), []);
  assert.equal(models.getModel("one", "b")?.id, "b");
  models.deleteProvider("one");
  assert.equal(models.getProvider("one"), undefined);
  models.clearProviders();
  assert.deepEqual(models.getProviders(), []);
});

test("image auth uses request, scoped environment, then the credential broker", async () => {
  const seen: ImagesOptions[] = [];
  const resolved: ResolvedCredential = {
    credential: {
      kind: "oauth",
      provider: "images-auth",
      accessToken: "broker-token",
      refreshToken: "never-expose-refresh",
      expiresAt: Date.now() + 60_000,
      tokenType: "Bearer",
      scopes: ["images"],
    },
    source: "test-broker",
  };
  const models = createImagesModels({
    credentialBroker: { resolve: async () => resolved },
  });
  models.setProvider(createImagesProvider({
    id: "images",
    auth: { provider: "images-auth", environmentVariables: ["IMAGES_KEY"] },
    models: [imageModel("images")],
    api: {
      generateImages: async (model, _context, options) => {
        seen.push(options ?? {});
        return result(model);
      },
    },
  }));
  const model = models.getModel("images", "model-a")!;

  const brokerAuth = await models.getAuth(model);
  assert.equal(brokerAuth?.apiKey, "broker-token");
  assert.equal(brokerAuth?.credentialKind, "oauth");
  assert.equal("credential" in (brokerAuth ?? {}), false, "refresh-capable broker credentials must not escape");
  assert.equal((await models.getAuth(model, { env: { IMAGES_KEY: "env-token" } }))?.apiKey, "env-token");
  assert.equal((await models.getAuth("images", { apiKey: "request-token" }))?.apiKey, "request-token");

  await models.generateImages(model, context);
  await models.generateImages(model, context, { env: { IMAGES_KEY: "env-token" } });
  await models.generateImages(model, context, { apiKey: "request-token" });
  assert.deepEqual(seen.map((options) => options.apiKey), ["broker-token", "env-token", "request-token"]);
});

test("image auth projects provider endpoint, headers, and environment with request overrides", async () => {
  const calls: Array<{ model: ImagesModel<ImagesApi>; options: ImagesOptions | undefined }> = [];
  const models = createImagesModels({
    authContext: {
      env: async (name) => name === "IMAGE_KEY" ? "environment-key" : undefined,
      fileExists: async () => false,
    },
  });
  models.setProvider(createImagesProvider({
    id: "direct",
    auth: {
      apiKey: {
        name: "Image key",
        async resolve({ ctx, credential }) {
          const key = credential?.key ?? await ctx.env("IMAGE_KEY");
          return key === undefined ? undefined : {
            auth: {
              apiKey: key,
              baseUrl: "https://resolved-images.example.test/v1",
              headers: { "x-auth": "provider", "x-shared": "provider" },
            },
            env: { PROVIDER_ONLY: "provider", SHARED: "provider" },
            source: credential === undefined ? "IMAGE_KEY" : "stored",
          };
        },
      },
    },
    models: [imageModel("direct")],
    api: {
      generateImages: async (model, _context, options) => {
        calls.push({ model, options });
        return result(model);
      },
    },
  }));
  const model = models.getModel("direct", "model-a")!;

  assert.equal((await models.getAuth(model))?.auth.apiKey, "environment-key");
  await models.generateImages(model, context, {
    apiKey: "request-key",
    headers: { "X-SHARED": "request", "x-request": "yes" },
    env: { REQUEST_ONLY: "request", SHARED: "request" },
  });

  assert.equal(calls[0]?.model.baseUrl, "https://resolved-images.example.test/v1");
  assert.equal(calls[0]?.options?.apiKey, "request-key");
  assert.deepEqual(calls[0]?.options?.headers, {
    "x-auth": "provider",
    "X-SHARED": "request",
    "x-request": "yes",
  });
  assert.deepEqual(calls[0]?.options?.env, {
    PROVIDER_ONLY: "provider",
    REQUEST_ONLY: "request",
    SHARED: "request",
  });
});

test("image model generation never rejects", async () => {
  const models = createImagesModels();
  const missing = await models.generateImages(imageModel("missing"), context);
  assert.equal(missing.stopReason, "error");
  assert.match(missing.errorMessage ?? "", /Unknown image provider/u);

  models.setProvider(createImagesProvider({
    id: "throws",
    auth: {},
    models: [imageModel("throws")],
    api: { generateImages: async () => { throw new Error("provider failed"); } },
  }));
  const failed = await models.generateImages(imageModel("throws"), context);
  assert.equal(failed.stopReason, "error");
  assert.match(failed.errorMessage ?? "", /provider failed/u);
});

test("dynamic image catalogs dedupe refreshes, preserve last-good data, and retry", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = createImagesProvider({
    id: "dynamic",
    auth: {},
    models: [imageModel("dynamic", "old")],
    refreshModels: async () => {
      calls += 1;
      if (calls === 1) {
        await gate;
        throw new Error("temporary outage");
      }
      return [imageModel("dynamic", "new")];
    },
    api: { generateImages: async (model) => result(model) },
  });
  const models = createImagesModels();
  models.setProvider(provider);

  const first = models.refresh("dynamic");
  const duplicate = models.refresh("dynamic");
  release!();
  await assert.rejects(first, (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "model_source");
  await assert.rejects(duplicate);
  assert.equal(calls, 1);
  assert.equal(models.getModel("dynamic", "old")?.id, "old");

  await models.refresh("dynamic");
  assert.equal(calls, 2);
  assert.equal(models.getModel("dynamic", "new")?.id, "new");

  models.setProvider({
    id: "also-broken",
    name: "Also broken",
    auth: {},
    getModels: () => [],
    refreshModels: async () => { throw new Error("ignored by all-provider refresh"); },
    generateImages: async (model) => result(model),
  });
  await models.refresh();
});

test("built-in image models remain separate and resolve OpenRouter credentials", async () => {
  const models = builtinImagesModels({ environment: { OPENROUTER_API_KEY: "catalog-key" } });
  assert.deepEqual(models.getProviders().map((provider) => provider.id), ["openrouter"]);
  const catalog = models.getModels("openrouter");
  assert.equal(catalog.length, 35);
  assert.equal(catalog.every((model) => model.api === "openrouter-images"), true);
  assert.equal((await models.getAuth(catalog[0]!))?.apiKey, "catalog-key");
});

test("the maintained image catalog is copied, typed, and omits unknown prices", () => {
  assert.deepEqual(getImageProviders(), ["openrouter"]);
  const catalog = getImageModels("openrouter");
  assert.equal(catalog.length, 35);
  catalog.pop();
  assert.equal(getImageModels("openrouter").length, 35);
  assert.deepEqual(getImageModel("openrouter", "google/gemini-2.5-flash-image")?.pricing, {
    input: 0.3,
    output: 2.5,
    cacheRead: 0.03,
    cacheWrite: 1 / 12,
  });
  assert.equal(getImageModel("openrouter", "openrouter/auto")?.pricing, undefined);
  assert.equal(getImageModel("openrouter", "missing"), undefined);
});
