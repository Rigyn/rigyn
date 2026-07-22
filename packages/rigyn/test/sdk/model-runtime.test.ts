import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InMemoryCredentialStore,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Provider,
} from "@rigyn/models";

import { AuthStorage } from "../../src/auth/auth-storage.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { ModelRegistry } from "../../src/providers/public-model-registry.js";
import { createAgentSession } from "../../src/sdk/index.js";
import { SessionManager } from "../../src/storage/session-manager.js";

async function configuredRuntime(context: test.TestContext): Promise<{
  directory: string;
  runtime: ModelRuntime;
}> {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-model-runtime-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const modelsPath = join(directory, "models.json");
  await writeFile(modelsPath, `{
    // SDK-local provider configuration.
    "providers": {
      "sdk-custom": {
        "name": "SDK custom",
        "baseUrl": "https://example.test/v1",
        "apiKey": "sdk-config-key",
        "api": "openai-completions",
        "models": [{ "id": "custom-model", "reasoning": true }]
      }
    }
  }\n`);
  return {
    directory,
    runtime: await ModelRuntime.create({
      credentials: AuthStorage.inMemory(),
      modelsPath,
      allowModelNetwork: false,
    }),
  };
}

test("ModelRuntime loads modelsPath and exposes public model protocols", async (context) => {
  const { runtime } = await configuredRuntime(context);
  const model = runtime.getModel("sdk-custom", "custom-model");
  assert.ok(model);
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, "https://example.test/v1");
  assert.equal(model.contextWindow, 128_000);
  assert.equal(model.maxTokens, 16_384);
  assert.equal(runtime.find("sdk-custom", "custom-model")?.api, "openai-completions");
  assert.equal(runtime.getError(), undefined);
  assert.deepEqual(runtime.getProviderAuthStatus("sdk-custom"), {
    configured: true,
    source: "models_json_key",
  });
});

test("ModelRuntime defaults never parse or replace the CLI-owned catalog", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-model-runtime-default-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  const catalog = `${JSON.stringify({ version: 1, savedAt: "2026-07-22T00:00:00.000Z", providers: [] })}\n`;
  await writeFile(join(directory, "models.json"), catalog);
  await writeFile(join(directory, "model-providers.json"), JSON.stringify({
    providers: {
      "default-custom": {
        baseUrl: "https://example.test/v1",
        apiKey: "default-test-key",
        api: "openai-completions",
        models: [{ id: "default-model" }],
      },
    },
  }));
  const previousAgentDir = process.env.RIGYN_CODING_AGENT_DIR;
  process.env.RIGYN_CODING_AGENT_DIR = directory;
  try {
    const runtime = await ModelRuntime.create({
      credentials: AuthStorage.inMemory(),
      allowModelNetwork: false,
    });
    assert.equal(runtime.getModel("default-custom", "default-model")?.id, "default-model");
    assert.equal(runtime.getError(), undefined);
    assert.equal(await readFile(join(directory, "models.json"), "utf8"), catalog);
  } finally {
    if (previousAgentDir === undefined) delete process.env.RIGYN_CODING_AGENT_DIR;
    else process.env.RIGYN_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("runtime API-key overrides are effective, removable, and never persisted", async () => {
  const credentials = AuthStorage.inMemory();
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const model = runtime.find("anthropic", "claude-opus-4-8");
  assert.ok(model);

  await runtime.setRuntimeApiKey("anthropic", "runtime-only-key");
  assert.deepEqual(await runtime.getApiKeyAndHeaders(model), { ok: true, apiKey: "runtime-only-key" });
  assert.equal((await credentials.read("anthropic")), undefined);

  await runtime.removeRuntimeApiKey("anthropic");
  assert.equal((await credentials.read("anthropic")), undefined);
  const resolved = await runtime.getApiKeyAndHeaders(model);
  assert.equal(resolved.ok && resolved.apiKey === "runtime-only-key", false);
});

test("createAgentSession accepts the public ModelRegistry facade", async (context) => {
  const { directory, runtime } = await configuredRuntime(context);
  const model = runtime.getModel("sdk-custom", "custom-model");
  assert.ok(model);
  const registry = new ModelRegistry(runtime);
  const created = await createAgentSession({
    cwd: directory,
    agentDir: join(directory, ".agent"),
    modelRuntime: registry,
    model,
    scopedModels: [{ model, thinkingLevel: "low" }],
    sessionManager: SessionManager.inMemory(directory),
    settingsManager: SettingsManager.inMemory(),
    noTools: "all",
  });
  context.after(async () => await created.session.close());

  assert.equal(created.session.model?.provider, "sdk-custom");
  assert.equal(created.session.model?.id, "custom-model");
  assert.equal(created.session.model?.api, "openai-chat-completions");
  assert.equal(created.session.modelRuntime, runtime);
  assert.equal((await created.session.modelRuntime.getAvailable("sdk-custom")).some((entry) => entry.id === "custom-model"), true);
});

test("ModelRuntime implements the public model, auth, streaming, and provider lifecycle contract", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("sdk-native", async () => ({ type: "api_key", key: "native-key" }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const model = {
    id: "native-model",
    name: "Native model",
    api: "openai-completions" as const,
    provider: "sdk-native",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
  };
  let observedApiKey: string | undefined;
  const provider: Provider = {
    id: "sdk-native",
    name: "SDK native",
    auth: {
      apiKey: {
        name: "API key",
        async resolve({ credential }) {
          return credential?.type === "api_key" && credential.key !== undefined
            ? { auth: { apiKey: credential.key } }
            : undefined;
        },
      },
    },
    getModels: () => [model],
    stream(_model, _context, options) {
      observedApiKey = options?.apiKey;
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "ready" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      return stream;
    },
    streamSimple(selected, context, options) { return this.stream(selected, context, options); },
  };

  runtime.registerNativeProvider(provider);
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getProvider("sdk-native")?.name, "SDK native");
  assert.equal(runtime.getModels("sdk-native")[0]?.id, "native-model");
  assert.equal((await runtime.getAvailable("sdk-native"))[0]?.id, "native-model");
  assert.equal(runtime.getAvailableSnapshot().some((entry) => entry.provider === "sdk-native"), true);
  assert.deepEqual(await runtime.checkAuth("sdk-native"), { type: "api_key" });
  assert.deepEqual(await runtime.listCredentials(), [{ providerId: "sdk-native", type: "api_key" }]);
  assert.equal((await runtime.completeSimple(model, { messages: [] })).content[0]?.type, "text");
  assert.equal(observedApiKey, "native-key");

  runtime.unregisterProvider("sdk-native");
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getProvider("sdk-native"), undefined);
});

test("the public ModelRegistry is the synchronous compatibility view of ModelRuntime", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("registry-native", async () => ({ type: "api_key", key: "registry-key" }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const model = {
    id: "registry-model",
    name: "Registry model",
    api: "openai-completions" as const,
    provider: "registry-native",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4_096,
    maxTokens: 512,
  };
  const provider: Provider = {
    id: "registry-native",
    name: "Registry native",
    auth: {
      apiKey: {
        name: "API key",
        async resolve({ credential }) {
          return credential?.type === "api_key" && credential.key !== undefined
            ? { auth: { apiKey: credential.key } }
            : undefined;
        },
      },
    },
    getModels: () => [model],
    stream() { return createAssistantMessageEventStream(); },
    streamSimple() { return createAssistantMessageEventStream(); },
  };
  runtime.registerNativeProvider(provider);
  await runtime.refresh({ allowNetwork: false });
  const registry = new ModelRegistry(runtime);

  assert.deepEqual(registry.find("registry-native", "registry-model"), model);
  assert.equal(registry.getAvailable().some((entry) => entry.id === "registry-model"), true);
  assert.equal(registry.getProviderDisplayName("registry-native"), "Registry native");
  assert.equal(registry.hasConfiguredAuth(model), true);
  assert.deepEqual(await registry.getApiKeyAndHeaders(model), { ok: true, apiKey: "registry-key" });
  registry.unregisterProvider("registry-native");
  assert.equal(registry.find("registry-native", "registry-model"), undefined);
});

test("the compatibility registry permits explicitly unauthenticated provider requests", async () => {
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  runtime.registerProvider("no-auth-fixture", {
    name: "No auth fixture",
    baseUrl: "https://example.test/v1",
    api: "openai-completions",
    authHeader: false,
    headers: { "x-fixture": "present" },
    models: [{
      id: "fixture",
      name: "Fixture",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4_096,
      maxTokens: 512,
    }],
  });
  await runtime.refresh({ allowNetwork: false });
  const model = runtime.getModel("no-auth-fixture", "fixture");
  assert.ok(model);
  const registry = new ModelRegistry(runtime);
  assert.deepEqual(await registry.getApiKeyAndHeaders(model), {
    ok: true,
    headers: { "x-fixture": "present" },
  });
});

test("catalogBaseUrl overlays built-in models through the persisted refresh contract", async () => {
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname !== "/api/models/providers/openai") return new Response(null, { status: 404 });
    return Response.json({
      models: [{
        id: "catalog-probe",
        name: "Catalog probe",
        api: "openai-responses",
        provider: "wrong-provider",
        baseUrl: "https://api.example.test/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
        contextWindow: 16_384,
        maxTokens: 2_048,
      }],
    });
  }) as typeof fetch;
  try {
    const runtime = await ModelRuntime.create({
      credentials: AuthStorage.inMemory(),
      modelsPath: null,
      catalogBaseUrl: "https://catalog.example.test/root",
      allowModelNetwork: true,
    });
    const model = runtime.getModel("openai", "catalog-probe");
    assert.ok(model);
    assert.equal(model.provider, "openai");
    assert.equal(model.api, "openai-responses");
    assert.equal(requests.some((url) => url.pathname === "/api/models/providers/openai"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
