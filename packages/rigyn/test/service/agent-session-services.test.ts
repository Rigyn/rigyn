import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthStorage } from "../../src/auth/auth-storage.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { getExtensionRuntimeHost } from "../../src/extensions/compat.js";
import { providerFromAdapter } from "../../src/providers/internal-runtime-bridge.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { createModels } from "../../src/providers/models.js";
import { ProviderWireInterceptorRegistry } from "../../src/providers/wire.js";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "../../src/service/agent-session-services.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { createScriptedProvider } from "../../src/testing/scripted-provider.js";
import type { ToolExecutionBackend } from "../../src/tools/backend.js";

test("service composition contains hostile extension flag diagnostics without reflection", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-services-flags-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  let failureTraps = 0;
  const failure = new Proxy(Object.create(null) as object, {
    get() { failureTraps += 1; throw new Error("failure get trap executed"); },
    getPrototypeOf() { failureTraps += 1; throw new Error("failure prototype trap executed"); },
  });
  const hostileName = new Proxy(Object.create(null) as object, {
    get(_target, property) {
      if (property === Symbol.toPrimitive) return () => { throw failure; };
      return undefined;
    },
  });
  const modelRuntime = await ModelRuntime.create({ models: createModels(), modelsPath: null });
  context.after(async () => await modelRuntime.close());

  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
    extensionFlagValues: new Map([[hostileName as unknown as string, true]]),
  });

  assert.deepEqual(services.diagnostics, [{ type: "error", message: "[Thrown object]" }]);
  assert.equal(failureTraps, 0);
});

test("service composition returns the public agent-session result contract", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-services-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime: await ModelRuntime.create({ models: createModels(), modelsPath: null }),
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
  });
  const result = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });
  context.after(async () => await result.session.close());

  assert.deepEqual(Object.keys(result).sort(), ["extensionsResult", "modelFallbackMessage", "session"]);
  assert.equal(result.extensionsResult, services.resourceLoader.getExtensions());
  assert.equal("services" in result, false);
  assert.equal("diagnostics" in result, false);
});

test("service composition forwards the caller-owned provider wire lifecycle", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-services-wire-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime: await ModelRuntime.create({ models: createModels(), modelsPath: null }),
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [{
        name: "service-provider-wire",
        factory(api) {
          api.on("before_provider_headers", (event) => {
            event.headers.authorization = "Bearer extension";
            event.headers["x-service-extension"] = "active";
          });
        },
      }],
    },
  });
  const wire = new ProviderWireInterceptorRegistry();
  const extensionHost = getExtensionRuntimeHost(services.resourceLoader.getExtensions().runtime);
  assert.ok(extensionHost);
  assert.equal(extensionHost.hasListeners("before_provider_headers"), true);
  const result = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    providerWireLifecycle: wire,
    noTools: "all",
  });
  context.after(async () => await result.session.close());

  const prepared = await wire.withScope(
    { threadId: result.session.sessionId, runId: "service-run", step: 0 },
    async () => {
      const operation = wire.begin("service-provider");
      assert.equal(operation.active, true);
      return await operation.intercept({
        url: "https://example.test/v1/messages",
        method: "POST",
        headers: new Headers({ authorization: "Bearer original" }),
        body: { model: "service-model" },
      }, new AbortController().signal);
    },
  );
  assert.equal(prepared.headers.get("authorization"), "Bearer extension");
  assert.equal(prepared.headers.get("x-service-extension"), "active");
});

test("service model configuration is separate from the CLI-owned catalog", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-model-config-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const catalog = `${JSON.stringify({ version: 1, savedAt: "2026-07-22T00:00:00.000Z", providers: [] })}\n`;
  await writeFile(join(agentDir, "models.json"), catalog);
  await writeFile(join(agentDir, "model-providers.json"), JSON.stringify({
    providers: {
      "service-custom": {
        baseUrl: "https://example.test/v1",
        apiKey: "service-test-key",
        api: "openai-completions",
        models: [{ id: "service-model" }],
      },
    },
  }));
  const modelRuntime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory(),
    modelsPath: join(agentDir, "model-providers.json"),
    allowModelNetwork: false,
  });

  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
  });

  assert.equal(services.modelRuntime.getModel("service-custom", "service-model")?.id, "service-model");
  assert.equal(services.modelRuntime.getError(), undefined);
  assert.equal(await readFile(join(agentDir, "models.json"), "utf8"), catalog);
});

test("service composition forwards the host-owned tool backend", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-services-backend-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  const adapter = createScriptedProvider({
    id: "service-backend-fixture",
    models: [{ id: "service-backend-model", capabilities: { reasoning: "unsupported" } }],
    scripts: [
      {
        kind: "turn",
        content: [{ type: "tool_call", name: "read", arguments: { path: "ignored" } }],
        terminal: { type: "finish", reason: "tool_calls" },
      },
      {
        kind: "turn",
        content: [{ type: "text", text: "complete" }],
        terminal: { type: "finish", reason: "stop" },
      },
    ],
  });
  const models = createModels();
  models.setProvider(providerFromAdapter(adapter, {
    initialModels: adapter.models.map((entry) => ({
      ...entry,
      compatibility: {
        ...entry.compatibility,
        protocolFamily: {
          value: "openai-chat-completions" as const,
          source: "configuration" as const,
          observedAt: "2026-07-22T00:00:00.000Z",
        },
      },
    })),
    auth: {
      apiKey: {
        name: "Fixture key",
        async resolve() { return { auth: { apiKey: "fixture" }, source: "fixture" }; },
      },
    },
  }));
  const modelRuntime = await ModelRuntime.create({ models, modelsPath: null, allowModelNetwork: false });
  await modelRuntime.refresh({ allowNetwork: false });
  const model = modelRuntime.internalRegistry().find("service-backend-fixture", "service-backend-model");
  assert.ok(model);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
  });
  const requests: string[] = [];
  const toolBackend: ToolExecutionBackend = {
    id: "service-test",
    handles(toolName) {
      return toolName === "read";
    },
    resources(request) {
      requests.push(`resources:${request.invocation.name}`);
      return [{ kind: "workspace", key: "workspace", mode: "read" }];
    },
    async execute(request) {
      requests.push(`execute:${request.invocation.name}`);
      return { content: "backend", isError: false };
    },
  };
  const result = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    model,
    tools: ["read"],
    toolBackend,
  });
  context.after(async () => await result.session.close());

  const promptResult = await result.session.prompt("use the read tool");
  assert.equal(promptResult.results.at(-1)?.finalText, "complete");
  assert.deepEqual(requests, ["resources:read", "execute:read"]);
});
