import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";

import { Agent, type AgentEvent, type AgentTool } from "@rigyn/kernel";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@rigyn/models";

import { DefaultResourceLoader, type ResourceLoader } from "../../src/core/resource-loader.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import {
  createExtensionRuntime,
  getExtensionRuntimeHost,
} from "../../src/extensions/compat.js";
import { providerFromAdapter } from "../../src/providers/internal-runtime-bridge.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { ModelRegistry as InternalModelRegistry } from "../../src/providers/model-registry.js";
import { ModelRegistry } from "../../src/providers/public-model-registry.js";
import { createModels, type ProviderModel } from "../../src/providers/models.js";
import { createAgentSession } from "../../src/sdk/index.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { createScriptedProvider, type ScriptedProviderStep } from "../../src/testing/scripted-provider.js";
import type { HarnessTool } from "../../src/tools/types.js";

const roots = new Set<string>();

async function workspace(): Promise<{ cwd: string; agentDir: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-sdk-session-"));
  roots.add(cwd);
  return { cwd, agentDir: join(cwd, ".agent") };
}

test.afterEach(async () => {
  await Promise.all([...roots].map(async (root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

test("SDK installs the default kernel stream fallback", () => {
  const agent = Reflect.construct(Agent, [{}]) as Agent;
  assert.equal(typeof agent.streamFunction, "function");
});

async function modelRuntime(scripts: readonly ScriptedProviderStep[] = []): Promise<{
  model: ProviderModel;
  runtime: ModelRegistry;
  modelRuntime: ModelRuntime;
}> {
  const adapter = createScriptedProvider({
    id: "sdk-fixture",
    models: [{ id: "fixture-model", capabilities: { reasoning: "unsupported" } }],
    scripts,
  });
  const initialModels = adapter.models.map((entry) => ({
    ...entry,
    compatibility: {
      ...entry.compatibility,
      protocolFamily: {
        value: "openai-chat-completions" as const,
        source: "configuration" as const,
        observedAt: "2026-07-20T00:00:00.000Z",
      },
    },
  }));
  const models = createModels();
  models.setProvider(providerFromAdapter(adapter, {
    initialModels,
    auth: {
      apiKey: {
        name: "Fixture key",
        async resolve() { return { auth: { apiKey: "fixture" }, source: "fixture" }; },
      },
    },
  }));
  const internal = new InternalModelRegistry(models);
  await internal.refresh({ allowNetwork: false });
  const model = internal.find("sdk-fixture", "fixture-model");
  if (model === undefined) throw new Error("fixture model was not registered");
  const modelRuntime = await ModelRuntime.create({
    models,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const runtime = new ModelRegistry(modelRuntime);
  await runtime.refresh();
  return { model, runtime, modelRuntime };
}

function delegateResourceLoader(loader: DefaultResourceLoader, reload: () => Promise<void>): ResourceLoader {
  return {
    getExtensions: () => loader.getExtensions(),
    getSkills: () => loader.getSkills(),
    getPrompts: () => loader.getPrompts(),
    getThemes: () => loader.getThemes(),
    getAgentsFiles: () => loader.getAgentsFiles(),
    getSystemPrompt: () => loader.getSystemPrompt(),
    getAppendSystemPrompt: () => loader.getAppendSystemPrompt(),
    extendResources: (paths) => loader.extendResources(paths),
    extendResourcesFromExtensions: async (runtime, reason) => await loader.extendResourcesFromExtensions(runtime, reason),
    reload,
  };
}

test("createAgentSession accepts a SessionManager cwd for the same canonical workspace", async () => {
  const { cwd: root, agentDir } = await workspace();
  const cwd = join(root, "workspace");
  const alias = join(root, "workspace-alias");
  await mkdir(cwd);
  await symlink(cwd, alias, process.platform === "win32" ? "junction" : "dir");
  const { runtime } = await modelRuntime();
  const manager = SessionManager.inMemory(alias);

  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory(),
    noTools: "all",
  });

  assert.equal(created.session.sessionManager, manager);
  await created.session.close();
});

test("createAgentSession accepts the public extension result contract and zero-argument runtime", async () => {
  const { cwd, agentDir } = await workspace();
  const extensionRuntime = createExtensionRuntime();
  const exactExtensionsResult = { extensions: [], errors: [], runtime: extensionRuntime };
  const resourceLoader: ResourceLoader = {
    getExtensions: () => exactExtensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources() {},
    async reload() {},
  };
  const { model, runtime } = await modelRuntime();
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    noTools: "all",
  });

  assert.equal(created.extensionsResult, exactExtensionsResult);
  assert.equal(created.extensionsResult.runtime, extensionRuntime);
  assert.deepEqual(created.extensionsResult.extensions, []);
  assert.deepEqual(created.extensionsResult.errors, []);
  const fallbackHost = getExtensionRuntimeHost(extensionRuntime);
  assert.ok(fallbackHost);
  await created.session.close();
  assert.throws(() => fallbackHost.onError(() => {}), /closed/u);
  assert.throws(() => extensionRuntime.getCommands(), /stale|disposed/u);
});

test("direct provider registrations are available before the initial model is selected", async () => {
  const { cwd, agentDir } = await workspace();
  let generation = 0;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [{
      name: "provider-fixture",
      factory(api) {
        const current = ++generation;
        if (current > 2) return;
        api.registerProvider("extension-model", {
          name: "Extension model",
          baseUrl: "https://example.test/v1",
          apiKey: "fixture-key",
          api: "openai-completions",
          models: [{
            id: `fixture-${current}`,
            name: "Fixture",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4_096,
            maxTokens: 512,
          }],
        });
      },
    }],
  });
  await loader.reload();
  const { runtime } = await modelRuntime();
  const settings = SettingsManager.inMemory();
  settings.setDefaultModelAndProvider("extension-model", "fixture-1");
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });

  assert.equal(created.session.model?.provider, "extension-model");
  assert.equal(created.session.model?.id, "fixture-1");
  assert.equal(runtime.find("extension-model", "fixture-1")?.id, "fixture-1");
  await created.session.reload();
  assert.equal(runtime.find("extension-model", "fixture-1"), undefined);
  assert.equal(runtime.find("extension-model", "fixture-2")?.id, "fixture-2");
  await created.session.reload();
  assert.equal(runtime.find("extension-model", "fixture-2"), undefined);
  await created.session.close();
  await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close();
  assert.equal(runtime.find("extension-model", "fixture-1"), undefined);
});

test("SDK provider bootstrap restores the built-in model and transport after command-time unregister", async () => {
  const { cwd, agentDir } = await workspace();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [{
      name: "provider-override-fixture",
      factory(api) {
        api.registerProvider("sdk-fixture", {
          name: "Temporary SDK provider",
          baseUrl: "https://example.test/v1",
          apiKey: "fixture-key",
          api: "openai-completions",
          models: [{
            id: "temporary-model",
            name: "Temporary model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4_096,
            maxTokens: 512,
          }],
        });
        api.registerCommand("restore-sdk-provider", {
          async handler(_args, context) {
            context.modelRegistry.unregisterProvider("sdk-fixture");
          },
        });
      },
    }],
  });
  await loader.reload();
  const { model, runtime } = await modelRuntime([{
    kind: "turn",
    content: [{ type: "text", text: "restored transport" }],
    terminal: { type: "finish", reason: "stop" },
  }]);
  const settings = SettingsManager.inMemory();
  settings.setDefaultModelAndProvider("sdk-fixture", "temporary-model");
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });
  const host = getExtensionRuntimeHost(created.extensionsResult.runtime);
  assert.ok(host);
  assert.equal(created.session.model?.id, "temporary-model");
  assert.equal(runtime.find("sdk-fixture", "temporary-model")?.id, "temporary-model");

  assert.deepEqual(await host.runCommand("restore-sdk-provider", {
    args: "",
    threadId: created.session.sessionId,
    branch: created.session.sessionManager.getLeafId() ?? "root",
    signal: new AbortController().signal,
  }), { handled: true });
  assert.equal(runtime.find("sdk-fixture", "temporary-model"), undefined);
  assert.equal(runtime.find("sdk-fixture", "fixture-model")?.id, "fixture-model");

  await created.session.setModel(model);
  const result = await created.session.prompt("verify restored provider", { allowedTools: [] });
  assert.equal(result.results.at(-1)?.finalText, "restored transport");
  await created.session.close();
  await host.close();
});

test("createAgentSession composes injected managers, exact tool policy, and custom tools", async () => {
  const { cwd, agentDir } = await workspace();
  let executions = 0;
  const customTool: HarnessTool = {
    definition: {
      name: "probe",
      description: "Return the supplied value",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } },
      },
    },
    validate(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.value !== "string") {
        throw new Error("probe.value must be a string");
      }
    },
    resources() { return []; },
    async execute(input) {
      executions += 1;
      return { content: String((input as { value: string }).value), isError: false };
    },
  };
  const { model, runtime } = await modelRuntime([
    {
      kind: "turn",
      content: [{ type: "tool_call", name: "probe", arguments: { value: "works" } }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    {
      kind: "turn",
      content: [{ type: "text", text: "complete" }],
      terminal: { type: "finish", reason: "stop" },
    },
  ]);
  const sessionManager = SessionManager.inMemory(cwd, { id: "sdk-session" });
  const settingsManager = SettingsManager.inMemory();
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "high",
    sessionManager,
    settingsManager,
    customTools: [customTool],
    tools: ["probe"],
  });

  assert.deepEqual(Object.keys(created).sort(), ["extensionsResult", "session"]);
  assert.equal(created.session.sessionManager, sessionManager);
  assert.equal(created.session.settingsManager, settingsManager);
  assert.equal(created.session.thinkingLevel, "off");
  assert.deepEqual(created.session.getActiveTools(), ["probe"]);
  assert.notEqual(created.extensionsResult.runtime, created.session.extensionRunner);
  assert.equal(created.extensionsResult, created.session.resourceLoader.getExtensions());

  const events: string[] = [];
  const unsubscribe = created.session.subscribe((event) => { events.push(event.type); });
  const result = await created.session.prompt("use the probe");
  unsubscribe();
  assert.equal(result.results.at(-1)?.finalText, "complete");
  assert.equal(executions, 1);
  assert.equal(events.includes("tool_execution_start"), true);
  const initialHost = getExtensionRuntimeHost(created.extensionsResult.runtime);
  assert.ok(initialHost);
  await created.session.reload();
  const currentExtensionsResult = created.session.resourceLoader.getExtensions();
  const currentHost = getExtensionRuntimeHost(currentExtensionsResult.runtime);
  assert.ok(currentHost);
  assert.notEqual(currentExtensionsResult, created.extensionsResult);
  assert.notEqual(currentHost, initialHost);
  assert.throws(() => initialHost.onError(() => {}), /closed/u);
  await created.session.close();
  assert.throws(() => currentHost.onError(() => {}), /closed/u);
});

test("session.agent applies mutable state and low-level stream configuration to a real run", async () => {
  const { cwd, agentDir } = await workspace();
  const { model, runtime, modelRuntime: publicRuntime } = await modelRuntime();
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    noTools: "all",
  });
  const agent = created.session.agent;
  assert.equal(agent.state, agent.state);
  const publicModel = publicRuntime.getModel(model.provider, model.id);
  assert.ok(publicModel);
  const probeParameters = Type.Object({ value: Type.String() });
  const probe: AgentTool<typeof probeParameters> = {
    name: "agent_probe",
    label: "Agent probe",
    description: "Return a value",
    parameters: probeParameters,
    async execute(_callId, input) {
      return { content: [{ type: "text", text: String(input.value) }], details: { source: "agent" } };
    },
  };
  const seed = { role: "user" as const, content: [{ type: "text" as const, text: "seed" }], timestamp: Date.now() };
  agent.state.systemPrompt = "agent-owned prompt";
  agent.state.messages = [seed];
  agent.state.tools = [probe];
  agent.state.model = publicModel;
  assert.equal(agent.state.model.id, publicModel.id);
  assert.deepEqual(agent.state.messages, [seed]);
  assert.deepEqual(agent.state.tools.map((tool) => tool.name), ["agent_probe"]);

  agent.sessionId = "provider-session";
  agent.thinkingBudgets = { low: 17, medium: 23 };
  agent.transport = "websocket";
  agent.maxRetryDelayMs = 321;
  agent.toolExecution = "sequential";
  const payloadHook = async (payload: unknown) => payload;
  const responseHook = async () => {};
  agent.onPayload = payloadHook;
  agent.onResponse = responseHook;
  agent.getApiKey = (provider) => provider === publicModel.provider ? "agent-key" : undefined;
  let transformCalls = 0;
  agent.transformContext = async (messages) => {
    transformCalls += 1;
    return messages;
  };
  agent.convertToLlm = (messages) => messages.filter((message) =>
    message.role === "user" || message.role === "assistant" || message.role === "toolResult");

  let observedContext: Context | undefined;
  let observedOptions: SimpleStreamOptions | undefined;
  agent.streamFunction = (selected, context, options) => {
    observedContext = context;
    observedOptions = options;
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "custom stream complete" }],
      api: selected.api,
      provider: selected.provider,
      model: selected.id,
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
  };

  const events: AgentEvent["type"][] = [];
  const listener = (event: AgentEvent): void => { events.push(event.type); };
  const unsubscribe = agent.subscribe(listener);
  const result = await created.session.prompt("run custom stream");
  unsubscribe();
  assert.equal(result.results.at(-1)?.finalText, "custom stream complete");
  assert.equal(transformCalls, 1);
  assert.equal(observedContext?.systemPrompt, "agent-owned prompt");
  assert.deepEqual(observedContext?.messages.filter((message) => message.role === "user").map((message) =>
    typeof message.content === "string" ? message.content : message.content[0]?.type === "text" ? message.content[0].text : ""), [
    "seed",
    "run custom stream",
  ]);
  assert.deepEqual(observedContext?.tools?.map((tool) => tool.name), ["agent_probe"]);
  assert.equal(observedOptions?.apiKey, "agent-key");
  assert.equal(observedOptions?.sessionId, "provider-session");
  assert.deepEqual(observedOptions?.thinkingBudgets, { low: 17, medium: 23 });
  assert.equal(observedOptions?.transport, "websocket");
  assert.equal(observedOptions?.maxRetryDelayMs, 321);
  assert.equal(observedOptions?.onPayload, payloadHook);
  assert.equal(observedOptions?.onResponse, responseHook);
  assert.deepEqual(events, [
    "agent_start",
    "turn_start",
    "message_start",
    "message_end",
    "message_start",
    "message_update",
    "message_update",
    "message_update",
    "message_end",
    "turn_end",
    "agent_end",
  ]);

  agent.reset();
  assert.deepEqual(agent.state.messages, []);
  assert.equal(agent.state.isStreaming, false);
  assert.equal(agent.state.errorMessage, undefined);
  assert.equal(agent.sessionId, "provider-session");
  await created.session.close();
});

test("session.agent runs a caller-owned model through caller-owned stream and auth callbacks", async (context) => {
  const { cwd, agentDir } = await workspace();
  const { model, runtime, modelRuntime: publicRuntime } = await modelRuntime();
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    noTools: "all",
  });
  context.after(async () => await created.session.close());

  const registered = publicRuntime.getModel(model.provider, model.id);
  assert.ok(registered);
  const callerOwned: Model<Api> = {
    ...structuredClone(registered),
    id: "caller-owned-model",
    name: "Caller-owned model",
    provider: "caller-owned-provider",
  };
  const agent = created.session.agent;
  let requestedApiKeyProvider: string | undefined;
  let streamedModel: Model<Api> | undefined;
  agent.getApiKey = (provider) => {
    requestedApiKeyProvider = provider;
    return "caller-owned-key";
  };
  agent.streamFunction = (selected, _context, options) => {
    streamedModel = selected;
    assert.equal(options?.apiKey, "caller-owned-key");
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "caller-owned stream complete" }],
      api: selected.api,
      provider: selected.provider,
      model: selected.id,
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
  };

  agent.state.model = callerOwned;
  assert.equal(agent.state.model.id, callerOwned.id);
  assert.equal(agent.state.model.provider, callerOwned.provider);
  const modelChange = created.session.sessionManager.getEntries()
    .filter((entry) => entry.type === "model_change")
    .at(-1);
  assert.deepEqual(modelChange === undefined ? undefined : {
    provider: modelChange.provider,
    modelId: modelChange.modelId,
  }, {
    provider: callerOwned.provider,
    modelId: callerOwned.id,
  });
  await assert.rejects(created.session.setModel({
    provider: "ordinary-unregistered-provider",
    api: model.api,
    id: "ordinary-unregistered-model",
  }), /Provider adapter is not registered/u);
  assert.equal(agent.state.model.id, callerOwned.id);
  const result = await created.session.prompt("use caller-owned transport");
  assert.equal(result.results.at(-1)?.finalText, "caller-owned stream complete");
  assert.equal(streamedModel?.id, callerOwned.id);
  assert.equal(streamedModel?.provider, callerOwned.provider);
  assert.equal(requestedApiKeyProvider, callerOwned.provider);
  assert.equal(agent.state.errorMessage, undefined);
});

test("prepareNextTurn installs a brand-new tool only at the next turn boundary", async () => {
  const { cwd, agentDir } = await workspace();
  let bootstrapExecutions = 0;
  let nextExecutions = 0;
  const bootstrap: HarnessTool = {
    definition: {
      name: "bootstrap",
      description: "Complete the first turn",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    validate() {},
    resources: () => [],
    async execute() {
      bootstrapExecutions += 1;
      return { content: "bootstrapped", isError: false };
    },
  };
  const nextTool: AgentTool = {
    name: "next_probe",
    label: "Next probe",
    description: "Runs after the tool registry swap",
    parameters: Type.Object({}),
    async execute() {
      nextExecutions += 1;
      return { content: [{ type: "text", text: "next ran" }], details: undefined };
    },
  };
  const { model, runtime } = await modelRuntime([
    {
      kind: "turn",
      content: [{ type: "tool_call", name: "bootstrap", arguments: {} }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    {
      kind: "turn",
      content: [{ type: "tool_call", name: "next_probe", arguments: {} }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    {
      kind: "turn",
      content: [{ type: "text", text: "boundary complete" }],
      terminal: { type: "finish", reason: "stop" },
    },
  ]);
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    customTools: [bootstrap],
    tools: ["bootstrap"],
  });
  const hookOrder: string[] = [];
  created.session.agent.beforeToolCall = async ({ toolCall }) => {
    hookOrder.push(`before:${toolCall.name}`);
    return undefined;
  };
  created.session.agent.afterToolCall = async ({ toolCall }) => {
    hookOrder.push(`after:${toolCall.name}`);
    return undefined;
  };
  let preparations = 0;
  created.session.agent.prepareNextTurnWithContext = ({ context }) => {
    preparations += 1;
    if (preparations !== 1) return undefined;
    assert.deepEqual(context.tools?.map((tool) => tool.name), ["bootstrap"]);
    return { context: { ...context, tools: [nextTool] } };
  };

  const result = await created.session.prompt("swap tools after the first turn");
  assert.equal(result.results.at(-1)?.finalText, "boundary complete");
  assert.equal(bootstrapExecutions, 1);
  assert.equal(nextExecutions, 1);
  assert.equal(preparations, 2);
  assert.deepEqual(hookOrder, [
    "before:bootstrap",
    "after:bootstrap",
    "before:next_probe",
    "after:next_probe",
  ]);
  assert.deepEqual(created.session.agent.state.tools.map((tool) => tool.name), ["next_probe"]);
  await created.session.close();
});

test("createAgentSession keeps a supplied loader intact and binds extensions only on request", async () => {
  const { cwd, agentDir } = await workspace();
  const lifecycle: Array<{ type: string; reason?: string; threadId?: string }> = [];
  const settingsManager = SettingsManager.inMemory();
  const dynamicSkill = join(cwd, "dynamic-skill");
  await mkdir(dynamicSkill);
  await writeFile(join(dynamicSkill, "SKILL.md"), "---\nname: sdk-dynamic\ndescription: SDK dynamic resource\n---\n\n# Dynamic\n");
  const brokenExtension = join(cwd, "broken-extension.mjs");
  await writeFile(brokenExtension, "export default function () { throw new Error('activation failed'); }\n");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [brokenExtension],
    extensionFactories: [{
      name: "lifecycle-fixture",
      factory(api) {
        api.registerTool({
          name: "extension_probe",
          label: "Extension probe",
          description: "Extension fixture",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            return { content: [{ type: "text", text: "extension" }], details: null };
          },
        });
        api.on("session_start", (event) => {
          lifecycle.push({
            type: event.type,
            ...(event.reason === undefined ? {} : { reason: event.reason }),
          });
        });
        api.on("resources_discover", () => {
          lifecycle.push({ type: "resources_discover" });
          return { skillPaths: [dynamicSkill] };
        });
        api.on("session_shutdown", (event) => {
          lifecycle.push({ type: event.type, reason: event.reason });
        });
      },
    }],
  });
  await loader.reload();
  let reloadCalls = 0;
  const supplied = delegateResourceLoader(loader, async () => {
    reloadCalls += 1;
    throw new Error("createAgentSession must not reload a caller-owned ResourceLoader");
  });
  const { model, runtime } = await modelRuntime();
  const manager = SessionManager.inMemory(cwd, { id: "extension-session" });
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: manager,
    settingsManager,
    resourceLoader: supplied,
    noTools: "builtin",
    sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: "/tmp/previous.jsonl" },
  });

  assert.equal(reloadCalls, 0);
  assert.equal(created.extensionsResult.extensions.some((entry) => entry.path.includes("lifecycle-fixture")), true);
  assert.equal(created.extensionsResult.errors.some((entry) =>
    entry.path.includes("broken-extension.mjs") && entry.error.includes("activation failed")), true);
  assert.deepEqual(created.session.getActiveTools(), ["extension_probe"]);
  assert.equal(lifecycle.length, 0);
  await created.session.bindExtensions({});
  assert.equal(lifecycle[0]?.type, "session_start");
  assert.equal(lifecycle[0]?.reason, "resume");
  assert.equal(lifecycle[1]?.type, "resources_discover");
  assert.equal(
    supplied.getSkills().skills.some((skill) => skill.name === "sdk-dynamic"),
    true,
    JSON.stringify({
      skills: supplied.getSkills(),
      extensionDiagnostics: getExtensionRuntimeHost(loader.getExtensions().runtime)?.diagnostics(),
    }),
  );

  const host = getExtensionRuntimeHost(created.extensionsResult.runtime);
  assert.ok(host);
  await created.session.close();
  assert.equal(lifecycle.some((entry) => entry.type === "session_shutdown"), false);
  assert.equal(host.tools().some((tool) => tool.definition.name === "extension_probe"), true);
  const unsubscribe = host.onError(() => {});
  unsubscribe();
  await host.close();
  await created.session.close();
});

test("construction failure closes an SDK-created fallback host without reloading the supplied loader", async () => {
  const { cwd, agentDir } = await workspace();
  const extensionRuntime = createExtensionRuntime();
  const exactExtensionsResult = { extensions: [], errors: [], runtime: extensionRuntime };
  let reloadCalls = 0;
  const resourceLoader: ResourceLoader = {
    getExtensions: () => exactExtensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources() {},
    async reload() { reloadCalls += 1; },
  };
  const { runtime } = await modelRuntime();
  const invalidTool = {
    get definition(): never { throw new Error("custom tool construction failed"); },
    validate() {},
    resources() { return []; },
    async execute() { return { content: "unused", isError: false }; },
  } as HarnessTool;

  await assert.rejects(createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    customTools: [invalidTool],
  }), /custom tool construction failed/u);

  assert.equal(reloadCalls, 0);
  const fallbackHost = getExtensionRuntimeHost(extensionRuntime);
  assert.ok(fallbackHost);
  assert.throws(() => fallbackHost.onError(() => {}), /closed/u);
  assert.throws(() => extensionRuntime.getCommands(), /stale|disposed/u);
});

test("createAgentSession reports model restoration fallback without replacing caller state", async () => {
  const { cwd, agentDir } = await workspace();
  const manager = SessionManager.inMemory(cwd);
  manager.appendModelChange("missing", "gone");
  manager.appendMessage({
    id: "user-existing",
    role: "user",
    content: [{ type: "text", text: "existing" }],
    createdAt: new Date(0).toISOString(),
  });
  const { runtime } = await modelRuntime();
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory(),
    noTools: "all",
  });
  assert.match(created.modelFallbackMessage ?? "", /Could not restore model missing\/gone/u);
  assert.match(created.modelFallbackMessage ?? "", /Using sdk-fixture\/fixture-model/u);
  assert.equal(created.session.messages.some((message) => "id" in message && message.id === "user-existing"), true);
  await created.session.close();
});
