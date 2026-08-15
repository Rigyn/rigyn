import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AdapterEvent,
  ModelInfo,
  ProviderAdapter,
  ProviderRequest,
} from "../../src/core/types.js";
import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { getExtensionRuntimeHost, projectLoadedExtensionHost } from "../../src/extensions/compat.js";
import type { ExtensionAPI } from "../../src/extensions/direct.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";
import {
  createModels,
  createProvider,
  type ProviderModel,
} from "../../src/providers/index.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { ModelRegistry as InternalModelRegistry } from "../../src/providers/model-registry.js";
import { ModelRegistry as PublicModelRegistry } from "../../src/providers/public-model-registry.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { createAgentSession, type CreateAgentSessionOptions } from "../../src/sdk/index.js";
import { AgentSession } from "../../src/service/agent-session.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { sha256 } from "../../src/tools/hash.js";
import type { ToolAuthorizationOwner } from "../../src/tools/approval.js";
import type { HarnessTool } from "../../src/tools/types.js";
import { loadTestDirectExtensions } from "../helpers/direct-extension-loader.js";

const observedAt = "2026-07-21T00:00:00.000Z";
const supported = { value: "supported", source: "provider", observedAt } as const;

class SwitchingProvider implements ProviderAdapter {
  readonly id = "switching-fixture";
  readonly requests: ProviderRequest[] = [];
  readonly models: ModelInfo[] = [{
    id: "model",
    provider: this.id,
    capabilities: { tools: supported, reasoning: supported, images: supported },
    compatibility: {
      protocolFamily: {
        value: "openai-chat-completions",
        source: "provider",
        observedAt,
      },
    },
  }];

  async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(request));
    yield { type: "response_start", model: request.model };
    if (this.requests.length === 1) {
      yield { type: "tool_call_start", index: 0, id: "switch-call", name: "switch_tools" };
      yield {
        type: "tool_call_end",
        index: 0,
        id: "switch-call",
        name: "switch_tools",
        rawArguments: "{}",
        arguments: {},
      };
      yield {
        type: "response_end",
        reason: "tool_calls",
        state: { kind: "chat_completions", assistantMessage: { turn: 1 } },
      };
      return;
    }
    yield { type: "text_delta", part: 0, text: "done" };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { turn: 2 } },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models;
  }
}

class CatalogProvider implements ProviderAdapter {
  readonly id = "catalog-fixture";
  readonly requests: ProviderRequest[] = [];
  readonly models: ModelInfo[] = [{
    id: "model",
    provider: this.id,
    capabilities: { tools: supported, reasoning: supported, images: supported },
    compatibility: {
      protocolFamily: {
        value: "openai-chat-completions",
        source: "provider",
        observedAt,
      },
    },
  }];

  async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests.push(structuredClone(request));
    yield { type: "response_start", model: request.model };
    yield { type: "text_delta", part: 0, text: "done" };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: {} },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models;
  }
}

function catalogModels(provider: CatalogProvider) {
  const model: ProviderModel = {
    id: "model",
    name: "Model",
    api: "openai-chat-completions",
    provider: provider.id,
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: provider.id,
    auth: {
      apiKey: {
        name: "Fixture key",
        async resolve() { return { auth: { apiKey: "fixture" }, source: "fixture" }; },
      },
    },
    models: [model],
    api: { async *stream() {} },
  }));
  return models;
}

function catalogModelRegistry(provider: CatalogProvider): InternalModelRegistry {
  return new InternalModelRegistry(catalogModels(provider));
}

test("persisted model tuples resolve through the live model registry", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-model-restore-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const provider = new CatalogProvider();
  const manager = SessionManager.inMemory(workspace);
  manager.appendModelChange(provider.id, "model");

  const session = await AgentSession.create({
    workspace,
    sessionManager: manager,
    providers: new ProviderRegistry([provider]),
    modelRegistry: catalogModelRegistry(provider),
    settingsManager: SettingsManager.inMemory(),
  });
  context.after(async () => await session.close());

  assert.equal(session.model?.provider, provider.id);
  assert.equal(session.model?.id, "model");
  assert.equal(session.model?.api, "openai-completions");
  assert.equal(session.nativeModel?.api, "openai-chat-completions");
});

test("an unknown persisted model leaves a usable fallback untouched", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-model-fallback-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const sessionDirectory = join(workspace, "sessions");
  const provider = new CatalogProvider();
  const registry = catalogModelRegistry(provider);
  const currentManager = SessionManager.create(workspace, sessionDirectory, { id: "current" });
  const session = await AgentSession.create({
    workspace,
    sessionManager: currentManager,
    providers: new ProviderRegistry([provider]),
    modelRegistry: registry,
    settingsManager: SettingsManager.inMemory(),
    model: {
      provider: provider.id,
      id: "model",
      api: "openai-chat-completions",
      info: provider.models[0]!,
    },
  });
  context.after(async () => await session.close());

  const unknownManager = SessionManager.create(workspace, sessionDirectory, { id: "unknown" });
  unknownManager.appendModelChange("missing", "gone");
  unknownManager.appendMessage({
    id: "unknown-user",
    role: "user",
    content: [{ type: "text", text: "hello" }],
    createdAt: observedAt,
  });
  unknownManager.appendMessage({
    id: "unknown-assistant",
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    createdAt: observedAt,
    provider: "missing",
    api: "openai-chat-completions",
    model: "gone",
    stopReason: "stop",
  });
  const unknownFile = unknownManager.getSessionFile();
  assert.notEqual(unknownFile, undefined);
  unknownManager.closeV4Store();

  session.switchSessionFile(unknownFile!);
  assert.equal(session.model?.provider, provider.id);
  assert.equal(session.model?.id, "model");
  assert.equal(session.model?.api, "openai-completions");
  assert.equal(session.nativeModel?.api, "openai-chat-completions");
});

test("replacement callbacks receive the full command context and object-style messages", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-replacement-context-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const host = await loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [() => {}],
  });
  context.after(async () => await host.close());
  const manager = SessionManager.inMemory(workspace);
  const session = await AgentSession.create({
    workspace,
    sessionManager: manager,
    providers: new ProviderRegistry([]),
    settingsManager: SettingsManager.inMemory(),
    extensionRunner: host,
  });
  context.after(async () => await session.close());
  await session.bindExtensions({ mode: "print" });

  const replacement = session.createReplacedSessionContext();
  assert.equal(replacement.session, session);
  assert.equal(replacement.cwd, workspace);
  assert.equal(replacement.mode, "print");
  assert.equal(replacement.sessionManager.getSessionId(), manager.getSessionId());
  for (const method of [
    "isIdle",
    "isProjectTrusted",
    "abort",
    "hasPendingMessages",
    "shutdown",
    "getContextUsage",
    "compact",
    "getSystemPrompt",
    "getSystemPromptOptions",
    "waitForIdle",
    "newSession",
    "fork",
    "navigateTree",
    "switchSession",
    "refresh",
    "sendMessage",
    "sendUserMessage",
  ] as const) {
    assert.equal(typeof replacement[method], "function", method);
  }

  const sent = replacement.sendMessage({
    customType: "replacement-note",
    content: "ready",
    display: true,
    details: { source: "replacement" },
  });
  assert.equal(sent instanceof Promise, true);
  await sent;
  const entry = manager.getEntries().find((candidate) =>
    candidate.type === "custom_message" && candidate.customType === "replacement-note"
  );
  assert.equal(entry?.type, "custom_message");
  if (entry?.type === "custom_message") {
    assert.deepEqual(entry.content, [{ type: "text", text: "ready" }]);
    assert.deepEqual(entry.details, { source: "replacement" });
  }
});

test("SDK tool policies apply to tools registered during session start", async (context) => {
  const cases: Array<{
    name: string;
    options: Pick<CreateAgentSessionOptions, "noTools" | "tools" | "excludeTools">;
    active: boolean;
  }> = [
    { name: "default", options: {}, active: true },
    { name: "extensions-only", options: { noTools: "builtin" }, active: true },
    { name: "none", options: { noTools: "all" }, active: false },
    { name: "future-allowlist", options: { tools: ["late_tool"] }, active: true },
    { name: "excluded", options: { excludeTools: ["late_tool"] }, active: false },
  ];

  for (const selected of cases) {
    const workspace = await mkdtemp(join(tmpdir(), `rigyn-sdk-tools-${selected.name}-`));
    context.after(async () => await rm(workspace, { recursive: true, force: true }));
    const agentDirectory = join(workspace, "agent");
    await mkdir(agentDirectory, { recursive: true });
    const settings = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir: agentDirectory,
      settingsManager: settings,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [(rigyn) => {
        rigyn.on("session_start", () => {
          rigyn.registerTool({
            name: "late_tool",
            label: "Late tool",
            description: "Registered after SDK construction",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            async execute() {
              return { content: [{ type: "text", text: "ready" }], details: null };
            },
          });
        });
      }],
    });
    await loader.refresh();
    const host = getExtensionRuntimeHost(loader.getExtensions().runtime);
    assert.ok(host);
    const provider = new CatalogProvider();
    const registry = new PublicModelRegistry(await ModelRuntime.create({
      models: catalogModels(provider),
      modelsPath: null,
      allowModelNetwork: false,
    }));
    await registry.refresh();
    const model = registry.find(provider.id, "model");
    assert.notEqual(model, undefined);
    const created = await createAgentSession({
      cwd: workspace,
      agentDir: agentDirectory,
      modelRuntime: registry,
      model: model!,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(workspace),
      settingsManager: settings,
      ...selected.options,
    });
    await created.session.bindExtensions({ mode: "print" });
    assert.equal(created.session.getActiveTools().includes("late_tool"), selected.active, selected.name);
    await created.session.close();
    await host.close();
  }
});

test("direct getCommands includes extension commands, prompts, and skills in a real session", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-direct-command-catalog-"));
  const agentDirectory = join(workspace, "agent");
  await Promise.all([
    mkdir(join(agentDirectory, "prompts"), { recursive: true }),
    mkdir(join(agentDirectory, "skills", "review"), { recursive: true }),
    mkdir(join(agentDirectory, "skills", "inspect"), { recursive: true }),
  ]);
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  await Promise.all([
    writeFile(
      join(agentDirectory, "prompts", "inspect.md"),
      "---\ndescription: Inspect a target\n---\nInspect $1\n",
    ),
    writeFile(
      join(agentDirectory, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review the current change\n---\nReview instructions\n",
    ),
    writeFile(
      join(agentDirectory, "skills", "inspect", "SKILL.md"),
      "---\nname: inspect\ndescription: Inspect with the matching skill\n---\nInspect instructions\n",
    ),
  ]);

  let directApi: Pick<ExtensionAPI, "getCommands"> | undefined;
  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir: agentDirectory,
    settingsManager: settings,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    additionalPromptTemplatePaths: [join(agentDirectory, "prompts")],
    additionalSkillPaths: [join(agentDirectory, "skills")],
    extensionFactories: [{
      name: "command-catalog-fixture",
      factory(rigyn) {
        directApi = rigyn;
        rigyn.registerCommand("inspect-runtime", {
          description: "Inspect the active runtime",
          async handler() {},
        });
      },
    }],
  });
  await loader.refresh();
  const host = getExtensionRuntimeHost(loader.getExtensions().runtime);
  assert.ok(host);
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    workspace,
    agentDirectory,
    sessionManager: SessionManager.inMemory(workspace),
    providers: new ProviderRegistry([]),
    settingsManager: settings,
    resourceLoader: loader,
  });
  context.after(async () => await session.close());
  await session.bindExtensions({ mode: "print" });

  assert.ok(directApi);
  assert.deepEqual(
    directApi.getCommands().map((command) => [command.name, command.source]),
    [
      ["inspect-runtime", "extension"],
      ["inspect", "prompt"],
      ["skill:inspect", "skill"],
      ["skill:review", "skill"],
    ],
  );
});

test("refresh applies changed resource settings before rebuilding the catalog", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-resource-refresh-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const agentDirectory = join(workspace, "agent");
  await mkdir(join(agentDirectory, "prompts"), { recursive: true });
  await writeFile(join(agentDirectory, "prompts", "sample.md"), "Review the selected files.\n");
  const settings = SettingsManager.create(workspace, agentDirectory);
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir: agentDirectory,
    settingsManager: settings,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.refresh();
  assert.equal(loader.getPrompts().prompts.some((prompt) => prompt.name === "sample"), true);
  const session = await AgentSession.create({
    workspace,
    agentDirectory,
    sessionManager: SessionManager.inMemory(workspace),
    providers: new ProviderRegistry([]),
    settingsManager: settings,
    resourceLoader: loader,
  });
  context.after(async () => await session.close());

  await writeFile(join(agentDirectory, "config.json"), `${JSON.stringify({
    prompts: ["-prompts/sample.md"],
  }, null, 2)}\n`);
  await session.refresh();

  assert.deepEqual(settings.getGlobalSettings().prompts, ["-prompts/sample.md"]);
  assert.equal(loader.getPrompts().prompts.some((prompt) => prompt.name === "sample"), false);
});

test("an over-budget resumed history compacts before its next provider request", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-preprompt-compact-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const provider = new CatalogProvider();
  const manager = SessionManager.inMemory(workspace, { id: "preprompt-compact" });
  let firstKeptEntryId = "";
  for (let turn = 1; turn <= 4; turn += 1) {
    const userEntry = manager.appendMessage({
      id: `history-user-${turn}`,
      role: "user",
      content: [{ type: "text", text: `question ${turn} ${"x".repeat(turn === 4 ? 80 : 2_000)}` }],
      createdAt: `2026-07-21T00:00:0${turn}.000Z`,
    });
    manager.appendMessage({
      id: `history-assistant-${turn}`,
      role: "assistant",
      content: [{ type: "text", text: `answer ${turn} ${"y".repeat(turn === 4 ? 80 : 2_000)}` }],
      createdAt: `2026-07-21T00:00:1${turn}.000Z`,
      provider: provider.id,
      api: "openai-chat-completions",
      model: "model",
      stopReason: turn === 4 ? "length" : "stop",
      usage: {
        inputTokens: turn === 4 ? 5_900 : turn * 100,
        outputTokens: 100,
        totalTokens: turn === 4 ? 6_000 : turn * 100 + 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    if (turn === 4) firstKeptEntryId = userEntry;
  }
  const compactEvents: Array<{ reason: string; willRetry: boolean }> = [];
  const host = await loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [(rigyn) => {
      rigyn.on("session_before_compact", (event) => {
        compactEvents.push({ reason: event.reason, willRetry: event.willRetry });
        return {
          compaction: {
            summary: "resumed history summary",
            firstKeptEntryId,
            tokensBefore: 6_000,
          },
        };
      });
    }],
  });
  context.after(async () => await host.close());
  const session = await AgentSession.create({
    workspace,
    sessionManager: manager,
    providers: new ProviderRegistry([provider]),
    settingsManager: SettingsManager.inMemory(),
    extensionRunner: host,
    compactionReserveTokens: 500,
    compactionRecentTokens: 500,
  });
  context.after(async () => await session.close());
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "model",
    info: { ...provider.models[0]!, contextTokens: 5_000 },
  });

  await session.prompt("continue this session", { allowedTools: [] });

  assert.deepEqual(compactEvents, [{ reason: "overflow", willRetry: true }]);
  assert.equal(provider.requests.length, 1);
  assert.equal(manager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
  assert.equal(provider.requests[0]?.messages.some((message) =>
    message.role === "user" && message.content.some((block) => block.type === "text" && block.text === "continue this session")
  ), true);
});

test("tools registered during session start join the live session catalog", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-start-tool-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const host = await loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [(rigyn) => {
      rigyn.on("session_start", () => {
        throw new Error("start observer failed");
      });
      rigyn.on("session_start", () => {
        rigyn.registerTool({
          name: "start_tool",
          label: "Start tool",
          description: "Registered when the session starts",
          parameters: { type: "object", properties: {}, additionalProperties: false } as never,
          async execute() {
            return { content: [{ type: "text", text: "ready" }], details: {} };
          },
        });
      });
    }],
  });
  context.after(async () => await host.close());
  const provider = new CatalogProvider();
  const session = await AgentSession.create({
    workspace,
    sessionManager: SessionManager.inMemory(workspace),
    providers: new ProviderRegistry([provider]),
    settingsManager: SettingsManager.inMemory(),
    extensionRunner: host,
  });
  context.after(async () => await session.close());
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "model",
    info: provider.models[0]!,
  });

  assert.equal(session.getAllTools().some((tool) => tool.name === "start_tool"), false);
  await session.bindExtensions({ mode: "print" });
  assert.equal(session.getAllTools().some((tool) => tool.name === "start_tool"), true);
  assert.ok(host.diagnostics().some((entry) => entry.message.includes("start observer failed")));

  await session.prompt("catalog");
  assert.equal(provider.requests[0]?.tools.some((tool) => tool.name === "start_tool"), true);
});

test("direct getAllTools preserves builtin, host, and scoped extension provenance", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-tool-provenance-"));
  context.after(async () => {
    delete (globalThis as Record<string, unknown>).__rigynToolProvenanceApi;
    await rm(workspace, { recursive: true, force: true });
  });
  const scopes = ["project", "user", "invocation"] as const;
  const entries = [];
  for (const scope of scopes) {
    const name = `${scope}_tool`;
    const source = `export default (rigyn) => {
      globalThis.__rigynToolProvenanceApi ??= rigyn;
      rigyn.registerTool({
        name: ${JSON.stringify(name)},
        label: ${JSON.stringify(name)},
        description: ${JSON.stringify(`${scope} tool`)},
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; }
      });
      ${scope === "user" ? `rigyn.on("session_start", () => rigyn.registerTool({
        name: "user_late_tool",
        label: "user_late_tool",
        description: "user late tool",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; }
      }));` : ""}
    };\n`;
    const sourcePath = join(workspace, `${scope}.mjs`);
    await writeFile(sourcePath, source);
    entries.push({
      extensionId: `${scope}-extension`,
      sourcePath,
      sha256: sha256(source),
      resourceRoot: workspace,
      scope,
      trusted: true,
    });
  }
  const host = await loadTestDirectExtensions(entries, {
    workspace,
    activationFailure: "throw",
  });
  context.after(async () => await host.close());
  const sourceInfo = new Map(entries.map((entry) => [entry.sourcePath, {
    sourceInfo: {
      path: entry.sourcePath,
      source: `package:${entry.extensionId}`,
      scope: entry.scope === "invocation" ? "temporary" as const : entry.scope,
      origin: "package" as const,
      baseDir: workspace,
    },
  }] as const));
  const sdkTool: HarnessTool = {
    definition: {
      name: "sdk_custom",
      description: "SDK custom tool",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    validate() {},
    resources: () => [],
    async execute() {
      return { content: "ok", isError: false };
    },
  };
  const overriddenBuiltin: HarnessTool = {
    ...sdkTool,
    definition: {
      ...sdkTool.definition,
      name: "read",
      description: "SDK replacement for a built-in",
    },
  };
  const session = await AgentSession.create({
    workspace,
    sessionManager: SessionManager.inMemory(workspace),
    providers: new ProviderRegistry([]),
    settingsManager: SettingsManager.inMemory(),
    extensionsResult: projectLoadedExtensionHost(host, sourceInfo),
    tools: [sdkTool, overriddenBuiltin],
  });
  context.after(async () => await session.close());
  await session.bindExtensions({ mode: "print" });

  const api = (globalThis as Record<string, unknown>).__rigynToolProvenanceApi as {
    getAllTools(): Array<{
      name: string;
      label?: string;
      sourceInfo: {
        path: string;
        source: string;
        scope: string;
        origin: string;
        baseDir?: string;
      };
    }>;
  };
  const tools = new Map(api.getAllTools().map((tool) => [tool.name, tool]));
  assert.equal(tools.get("project_tool")?.label, "project_tool");
  assert.equal(
    session.getAllTools().find((tool) => tool.name === "project_tool")?.label,
    "project_tool",
  );
  assert.deepEqual(tools.get("bash")?.sourceInfo, {
    path: "<builtin:bash>",
    source: "<builtin:bash>",
    scope: "temporary",
    origin: "top-level",
  });
  assert.deepEqual(tools.get("sdk_custom")?.sourceInfo, {
    path: "<host:sdk_custom>",
    source: "<host:sdk_custom>",
    scope: "temporary",
    origin: "top-level",
  });
  assert.deepEqual(tools.get("read")?.sourceInfo, {
    path: "<host:read>",
    source: "<host:read>",
    scope: "temporary",
    origin: "top-level",
  });
  for (const entry of entries) {
    assert.deepEqual(tools.get(`${entry.scope}_tool`)?.sourceInfo, {
      path: entry.sourcePath,
      source: `package:${entry.extensionId}`,
      scope: entry.scope === "invocation" ? "temporary" : entry.scope,
      origin: "package",
      baseDir: workspace,
    });
  }
  const userEntry = entries.find((entry) => entry.scope === "user")!;
  assert.deepEqual(tools.get("user_late_tool")?.sourceInfo, {
    path: userEntry.sourcePath,
    source: `package:${userEntry.extensionId}`,
    scope: "user",
    origin: "package",
    baseDir: workspace,
  });
});

test("extension tool selection changes the next provider turn and records additive tools", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-tool-lifecycle-"));
  context.after(async () => await rm(workspace, { recursive: true, force: true }));
  const host = await loadDirectExtensions([], {
    workspace,
    activationFailure: "throw",
    inlineExtensions: [(rigyn) => {
      rigyn.registerTool({
        name: "switch_tools",
        label: "Switch tools",
        description: "Enable the follow-on tool",
        parameters: { type: "object", properties: {}, additionalProperties: false } as never,
        async execute() {
          rigyn.setActiveTools([...rigyn.getActiveTools(), "after_switch"]);
          return { content: [{ type: "text", text: "switched" }], details: {} };
        },
      });
      rigyn.registerTool({
        name: "after_switch",
        label: "After switch",
        description: "Available after the switch",
        parameters: { type: "object", properties: {}, additionalProperties: false } as never,
        async execute() {
          return { content: [{ type: "text", text: "after" }], details: {} };
        },
      });
    }],
  });
  context.after(async () => await host.close());
  const provider = new SwitchingProvider();
  const authorizationOwners: ToolAuthorizationOwner[] = [];
  const session = await AgentSession.create({
    workspace,
    sessionManager: SessionManager.inMemory(workspace),
    providers: new ProviderRegistry([provider]),
    settingsManager: SettingsManager.inMemory(),
    extensionRunner: host,
    tools: host.tools(),
    toolAuthorizationHandler(_request, authorizationContext) {
      authorizationOwners.push(authorizationContext.owner);
      return { decision: "allow_once" };
    },
  });
  context.after(async () => await session.close());
  await session.setModel({
    provider: provider.id,
    api: "openai-chat-completions",
    id: "model",
    info: provider.models[0]!,
  });
  await session.bindExtensions({ mode: "print" });
  session.setActiveTools(["switch_tools"]);
  const pendingSnapshots: Array<{ event: "start" | "end"; ids: string[] }> = [];
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      pendingSnapshots.push({ event: "start", ids: [...session.state.pendingToolCalls] });
    } else if (event.type === "tool_execution_end") {
      pendingSnapshots.push({ event: "end", ids: [...session.state.pendingToolCalls] });
    }
  });

  await session.prompt("start");

  assert.deepEqual(provider.requests.map((request) => request.tools.map((tool) => tool.name)), [
    ["switch_tools"],
    ["switch_tools", "after_switch"],
  ]);
  const added = provider.requests[1]?.messages
    .flatMap((message) => message.content)
    .filter((block) => block.type === "tool_result")
    .flatMap((block) => block.addedToolNames ?? []);
  assert.deepEqual(added, ["after_switch"]);
  assert.deepEqual(session.getActiveTools(), ["switch_tools", "after_switch"]);
  assert.deepEqual(authorizationOwners, [{
    kind: "extension",
    extensionId: "inline-extension-1",
    sourcePath: "<inline:1>",
    scope: "invocation",
  }]);
  assert.deepEqual(pendingSnapshots, [
    { event: "start", ids: ["switch-call"] },
    { event: "end", ids: [] },
  ]);
  assert.equal(session.state.pendingToolCalls.size, 0);
});
