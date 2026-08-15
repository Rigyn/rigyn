import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createAssistantMessageEventStream,
  type Api,
  type Model,
  type Provider,
} from "@rigyn/models";
import {
  type RuntimeCommandContext,
  type RuntimeSessionBeforeCompactEvent,
} from "../../src/extensions/runtime.js";
import type { ExtensionAPI } from "../../src/extensions/direct.js";
import { extensionModelRegistry } from "../../src/extensions/model-boundary.js";
import { extensionSessionManager } from "../../src/extensions/session-contract.js";
import type { CanonicalMessage } from "../../src/core/types.js";
import type { SlashCommandInfo } from "../../src/core/slash-commands.js";
import { DirectProcessRunner } from "../../src/process/index.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import { createModels } from "../../src/providers/models.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { sha256 } from "../../src/tools/hash.js";
import { WorkspaceBoundary } from "../../src/tools/paths.js";
import { loadTestDirectExtensions } from "../helpers/direct-extension-loader.js";

const ui: RuntimeCommandContext["ui"] = {
  notify() {},
  setStatus() {},
  setWidget() {},
  setHeader() {},
  setFooter() {},
  setWorkingMessage() {},
  setWorkingVisible() {},
  setTitle() {},
  async getTheme() { return { name: "dark", available: ["dark"] }; },
  async setTheme(name) { return { name, available: [name] }; },
  async select(_prompt, options) { return options[0]!.value; },
  async confirm() { return true; },
  async input() { return undefined; },
  async editor() { return undefined; },
  setEditorText() {},
  getEditorText() { return ""; },
  async custom<T>(): Promise<T | undefined> { return undefined; },
  showOverlay(): never { throw new Error("not used"); },
};

function commandContext(): Omit<RuntimeCommandContext, "workspace" | "args" | "mode" | "hasUI" | "isProjectTrusted"> {
  return {
    threadId: "thread-1",
    branch: "main",
    signal: new AbortController().signal,
    ui,
  };
}

async function fixture(
  context: { after(callback: () => Promise<void>): void },
  sources: readonly string[],
  unifiedCommands?: readonly SlashCommandInfo[],
) {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-authoring-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const entries = [];
  for (const [index, source] of sources.entries()) {
    const sourcePath = join(root, `extension-${index}.mjs`);
    await writeFile(sourcePath, source);
    entries.push({
      extensionId: `extension-${index}`,
      sourcePath,
      sha256: sha256(source),
      resourceRoot: root,
      scope: "project" as const,
      trusted: true,
    });
  }
  const host = await loadTestDirectExtensions(entries, { workspace: root });
  const sessionManager = SessionManager.inMemory(root, { id: "authoring-session" });
  host.setDirectContextHandler(() => ({
    sessionManager: extensionSessionManager(sessionManager),
    modelRegistry: new ModelRegistry(createModels()),
    thinkingLevel: "off",
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => "authoring system prompt",
  }));
  host.setDirectActionsHandler({
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName: () => undefined,
    setLabel() {},
    async exec() { return { stdout: "", stderr: "", code: 0, killed: false }; },
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
    ...(unifiedCommands === undefined ? {} : { getCommands: () => structuredClone(unifiedCommands) }),
    async setModel() { return true; },
    getThinkingLevel: () => "off",
    setThinkingLevel() {},
    registerProvider() {},
    unregisterProvider() {},
    getSystemPromptOptions: () => ({ cwd: root }),
    async waitForIdle() {},
    async newSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async navigateTree() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async refresh() {},
  });
  return { root, host };
}

function message(id: string, role: CanonicalMessage["role"], text: string): CanonicalMessage {
  return {
    id: id as CanonicalMessage["id"],
    role,
    content: [{ type: "text", text }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

async function within<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation did not settle within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("direct extension tools normalize only nullish result and progress content", async (context) => {
  const source = `export default (api) => {
    const parameters = { type: "object", additionalProperties: false, properties: {} };
    api.registerTool({
      name: "empty_content",
      label: "Empty content",
      description: "Returns runtime values without content",
      parameters,
      execute(_toolCallId, _input, _signal, onUpdate) {
        onUpdate({ details: { phase: "missing" } });
        onUpdate({ content: null, details: { phase: "null" } });
        return { details: { phase: "complete" } };
      }
    });
    for (const [name, content] of [
      ["string_content", "invalid"],
      ["number_content", 7],
      ["object_content", { type: "text", text: "invalid" }],
      ["malformed_content", [{ type: "text" }]]
    ]) {
      api.registerTool({
        name,
        label: name,
        description: "Returns invalid runtime content",
        parameters,
        execute() { return { content, details: {} }; }
      });
    }
    api.registerTool({
      name: "invalid_progress",
      label: "Invalid progress",
      description: "Reports invalid runtime content",
      parameters,
      execute(_toolCallId, _input, _signal, onUpdate) {
        onUpdate({ content: "invalid", details: {} });
        return { content: [], details: {} };
      }
    });
  };\n`;
  const { host, root } = await fixture(context, [source]);
  const workspace = await WorkspaceBoundary.create(root);
  const progress: unknown[] = [];
  const executionContext = {
    workspace,
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "empty-content-run",
    threadId: "empty-content-thread",
    toolCallId: "empty-content-call",
    reportProgress(update: unknown) { progress.push(update); },
  };
  const tools = new Map(host.tools().map((tool) => [tool.definition.name, tool]));
  const empty = tools.get("empty_content");
  assert.ok(empty);
  assert.deepEqual(await empty.execute({}, executionContext), {
    content: "",
    contentBlocks: [],
    isError: false,
    metadata: { phase: "complete" },
  });
  assert.deepEqual(progress, [
    { type: "result", content: "", isError: false, metadata: { phase: "missing" } },
    { type: "result", content: "", isError: false, metadata: { phase: "null" } },
  ]);

  for (const name of ["string_content", "number_content", "object_content", "malformed_content", "invalid_progress"]) {
    const selected = tools.get(name);
    assert.ok(selected);
    await assert.rejects(selected.execute({}, {
      ...executionContext,
      toolCallId: `${name}-call`,
    }));
  }
  await host.close();
});

test("direct extension tool details are detached and bounded before result validation", async (context) => {
  const source = `export default (api) => api.registerTool({
    name: "bounded_details",
    label: "Bounded details",
    description: "Returns boundary fixtures",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    execute() {
      const mode = globalThis.__authoringDirectDetailsMode;
      if (mode === "valid") {
        const details = { nested: { value: "before" } };
        globalThis.__authoringDirectDetailsSource = details;
        return { content: [], details };
      }
      if (mode === "oversized") {
        let shared = { value: true };
        for (let depth = 0; depth < 14; depth += 1) shared = { left: shared, right: shared };
        return { content: [], details: shared };
      }
      const details = Object.assign(Object.create({
        toJSON() {
          globalThis.__authoringDirectDetailsToJson += 1;
          return { rewritten: true };
        }
      }), { original: true });
      return { content: [], details };
    }
  });\n`;
  const { host, root } = await fixture(context, [source]);
  const workspace = await WorkspaceBoundary.create(root);
  const tool = host.tools()[0];
  assert.ok(tool);
  const globals = globalThis as Record<string, unknown>;
  globals.__authoringDirectDetailsToJson = 0;
  const executionContext = {
    workspace,
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "details-run",
    threadId: "details-thread",
    toolCallId: "details-call",
    reportProgress() {},
  };

  globals.__authoringDirectDetailsMode = "valid";
  const valid = await tool.execute({}, executionContext);
  const sourceDetails = globals.__authoringDirectDetailsSource as { nested: { value: string } };
  sourceDetails.nested.value = "after";
  assert.deepEqual(valid.metadata, { nested: { value: "before" } });

  globals.__authoringDirectDetailsMode = "oversized";
  const oversized = await tool.execute({}, { ...executionContext, toolCallId: "oversized-call" });
  assert.equal("metadata" in oversized, false);

  globals.__authoringDirectDetailsMode = "prototype";
  const prototype = await tool.execute({}, { ...executionContext, toolCallId: "prototype-call" });
  assert.equal("metadata" in prototype, false);
  assert.equal(globals.__authoringDirectDetailsToJson, 0);

  delete globals.__authoringDirectDetailsMode;
  delete globals.__authoringDirectDetailsSource;
  delete globals.__authoringDirectDetailsToJson;
  await host.close();
});

test("message_end normalizes nullish extension content without accepting other shapes", async (context) => {
  const source = `export default (api) => {
    api.on("message_end", (event) => {
      if (event.message.content[0]?.text === "null") {
        return { message: { ...event.message, content: null } };
      }
      if (event.message.content[0]?.text === "missing") {
        const { content, ...message } = event.message;
        return { message };
      }
      return { message: { ...event.message, content: "invalid" } };
    });
  };\n`;
  const { host } = await fixture(context, [source]);
  const scope = { threadId: "message-thread", runId: "message-run", branch: "main" };
  for (const text of ["null", "missing"]) {
    const reduced = await host.reduceMessageEnd({
      ...scope,
      message: message(text, "assistant", text),
    });
    assert.deepEqual(reduced.content, []);
  }

  const original = message("invalid", "assistant", "invalid");
  assert.deepEqual(await host.reduceMessageEnd({ ...scope, message: original }), original);
  assert.ok(host.diagnostics().some((entry) => entry.message.includes("Assistant content must be an array")));
  await host.close();
});

test("runtime command catalogs are callback-free, owner-aware, dynamic, and generation-bound", async (context) => {
  const first = `export default (api) => {
    globalThis.__commandCatalogApi = api;
    api.registerCommand("review", { description: "First review", handler() {} });
  };\n`;
  const second = `export default (api) => {
    api.registerCommand("review", { description: "Second review", handler() {} });
  };\n`;
  const { host, root } = await fixture(context, [first, second]);
  const api = (globalThis as Record<string, any>).__commandCatalogApi;
  try {
    const commands = api.getCommands();
    assert.deepEqual(commands.map((command: { name: string }) => command.name), ["review:1", "review:2"]);
    assert.deepEqual(
      commands.map((command: { sourceInfo: { path: string } }) => command.sourceInfo.path),
      [join(root, "extension-0.mjs"), join(root, "extension-1.mjs")],
    );
    assert.deepEqual(
      commands.map((command: { sourceInfo: { scope: string } }) => command.sourceInfo.scope),
      ["project", "project"],
    );
    assert.equal("execute" in commands[0], false);
    commands[0].description = "mutated";
    assert.equal(api.getCommands()[0].description, "First review");

    api.registerCommand("dynamic", { description: "Added after activation", handler() {} });
    assert.deepEqual(api.getCommands().map((command: { name: string }) => command.name), ["review:1", "review:2", "dynamic"]);
  } finally {
    await host.close();
    delete (globalThis as Record<string, unknown>).__commandCatalogApi;
  }
  assert.throws(() => api.getCommands(), /no longer active/u);
});

test("direct command discovery includes extension commands, prompt templates, and skills in host order", async (context) => {
  const source = `export default (api) => {
    api.registerCommand("review", { description: "Review", handler() {} });
    globalThis.__unifiedCommandApi = api;
  };\n`;
  const sourceInfo = (path: string) => ({ path, source: path, scope: "temporary" as const, origin: "top-level" as const });
  const commands: SlashCommandInfo[] = [
    { name: "review", description: "Review", source: "extension", sourceInfo: sourceInfo("/tmp/review.mjs") },
    { name: "release-notes", description: "Draft release notes", source: "prompt", sourceInfo: sourceInfo("/tmp/release-notes.md") },
    { name: "skill:triage", description: "Triage failures", source: "skill", sourceInfo: sourceInfo("/tmp/triage/SKILL.md") },
  ];
  const { host } = await fixture(context, [source], commands);
  const api = (globalThis as Record<string, any>).__unifiedCommandApi;
  try {
    assert.deepEqual(api.getCommands(), commands);
  } finally {
    await host.close();
    delete (globalThis as Record<string, unknown>).__unifiedCommandApi;
  }
});

test("runtime listeners, commands, shortcuts, and tools receive current host mode and trust context", async (context) => {
  const source = `export default (api) => {
    api.on("session_start", (_event, context) => {
      globalThis.__capturedListenerContext = context;
      globalThis.__listenerHostContext = {
        mode: context.mode,
        hasUI: context.hasUI,
        trusted: context.isProjectTrusted(),
        paths: context.paths
      };
    });
    api.registerCommand("host-context", {
      handler(_args, context) {
        globalThis.__capturedCommandContext = context;
        globalThis.__commandHostContext = {
          mode: context.mode,
          hasUI: context.hasUI,
          trusted: context.isProjectTrusted()
        };
      }
    });
    api.registerShortcut("ctrl+alt+h", {
      handler(context) {
        globalThis.__capturedShortcutContext = context;
        globalThis.__shortcutHostContext = {
          mode: context.mode,
          hasUI: context.hasUI,
          trusted: context.isProjectTrusted()
        };
      }
    });
    api.registerTool({
      name: "native_context",
      label: "Native context",
      description: "Inspect native extension tool context",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute(_toolCallId, _input, _signal, _onUpdate, context) {
        globalThis.__nativeToolContext = {
          hasUI: context.hasUI,
          mode: context.mode
        };
        context.ui.notify("tool context " + context.mode);
        return { content: [{ type: "text", text: context.mode }], details: {} };
      }
    });
  };\n`;
  const { host, root } = await fixture(context, [source]);
  const tool = host.tools()[0]!;
  assert.ok(tool, JSON.stringify(host.diagnostics()));
  const executeContext = {
    workspace: await WorkspaceBoundary.create(root),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "native-context-run",
    threadId: "native-context-thread",
    toolCallId: "native-context-call",
  };

  await host.dispatch("session_start", { reason: "startup", threadId: "thread-1" });
  await host.runCommand("host-context", { ...commandContext(), args: "" });
  await host.runShortcut("ctrl+alt+h", commandContext());
  assert.equal((await tool.execute({}, executeContext)).content, "print");
  const extensionPaths = host.extensionDataPaths(host.extensions()[0]!.sourcePath);
  assert.ok(extensionPaths !== undefined);
  const expectedPaths = {
    userData: extensionPaths.user,
    workspaceData: extensionPaths.workspace,
  };
  assert.deepEqual((globalThis as Record<string, unknown>).__nativeToolContext, {
    hasUI: false,
    mode: "print",
  });
  assert.deepEqual((globalThis as Record<string, unknown>).__listenerHostContext, {
    mode: "print",
    hasUI: false,
    trusted: false,
    paths: expectedPaths,
  });
  assert.deepEqual((globalThis as Record<string, unknown>).__commandHostContext, {
    mode: "print", hasUI: false, trusted: false,
  });
  assert.deepEqual((globalThis as Record<string, unknown>).__shortcutHostContext, {
    mode: "print", hasUI: false, trusted: false,
  });
  assert.equal(host.initialUi().some((entry) => entry.type === "notify" && entry.value === "tool context print"), false);

  host.setHostContext({ mode: "sdk" });
  assert.deepEqual(host.hostContext(), { mode: "sdk", projectTrusted: false });
  await host.dispatch("session_start", { reason: "resume", threadId: "thread-1" });
  await host.runCommand("host-context", { ...commandContext(), args: "" });
  await host.runShortcut("ctrl+alt+h", commandContext());
  assert.equal((await tool.execute({}, executeContext)).content, "sdk");
  assert.deepEqual((globalThis as Record<string, unknown>).__nativeToolContext, {
    hasUI: false,
    mode: "sdk",
  });
  assert.deepEqual((globalThis as Record<string, unknown>).__listenerHostContext, {
    mode: "sdk",
    hasUI: false,
    trusted: false,
    paths: expectedPaths,
  });
  assert.deepEqual((globalThis as Record<string, unknown>).__commandHostContext, {
    mode: "sdk", hasUI: false, trusted: false,
  });
  assert.deepEqual((globalThis as Record<string, unknown>).__shortcutHostContext, {
    mode: "sdk", hasUI: false, trusted: false,
  });
  assert.equal(host.initialUi().some((entry) => entry.type === "notify" && entry.value === "tool context sdk"), false);

  const owners: string[] = [];
  host.setHostContext({ mode: "serve" });
  assert.deepEqual(host.hostContext(), { mode: "serve", projectTrusted: false });
  host.setHostContext({ mode: "tui", projectTrusted: true });
  host.setInteractiveUiHandler((extensionId) => {
    owners.push(extensionId);
    return ui;
  });
  await host.dispatch("session_start", { reason: "resume", threadId: "thread-1" });
  await host.runCommand("host-context", { ...commandContext(), args: "" });
  assert.equal((await tool.execute({}, executeContext)).content, "tui");
  assert.deepEqual((globalThis as Record<string, unknown>).__nativeToolContext, {
    hasUI: true,
    mode: "tui",
  });
  assert.deepEqual((globalThis as Record<string, unknown>).__listenerHostContext, {
    mode: "tui",
    hasUI: true,
    trusted: true,
    paths: expectedPaths,
  });
  assert.deepEqual((globalThis as Record<string, unknown>).__commandHostContext, {
    mode: "tui", hasUI: true, trusted: true,
  });
  assert.deepEqual(owners, ["extension-0", "extension-0", "extension-0"]);
  const capturedCommand = (globalThis as Record<string, any>).__capturedCommandContext;
  const capturedListener = (globalThis as Record<string, any>).__capturedListenerContext;
  const capturedShortcut = (globalThis as Record<string, any>).__capturedShortcutContext;
  const getSystemPromptOptions = capturedCommand.getSystemPromptOptions;
  const waitForIdle = capturedCommand.waitForIdle;
  const notify = capturedCommand.ui.notify;
  const getShortcutPromptOptions = capturedShortcut.getSystemPromptOptions;
  const getSessionId = capturedListener.sessionManager.getSessionId;
  const refreshModels = capturedListener.modelRegistry.refresh;
  await host.close();
  const stalePattern = /host is closed|no longer active/u;
  assert.throws(getSystemPromptOptions, stalePattern);
  await assert.rejects(async () => await waitForIdle(), stalePattern);
  assert.throws(() => notify("stale command UI"), stalePattern);
  assert.throws(getShortcutPromptOptions, stalePattern);
  assert.throws(getSessionId, stalePattern);
  await assert.rejects(async () => await refreshModels(), stalePattern);
  delete (globalThis as Record<string, unknown>).__capturedCommandContext;
  delete (globalThis as Record<string, unknown>).__capturedListenerContext;
  delete (globalThis as Record<string, unknown>).__capturedShortcutContext;
  delete (globalThis as Record<string, unknown>).__nativeToolContext;
  delete (globalThis as Record<string, unknown>).__listenerHostContext;
  delete (globalThis as Record<string, unknown>).__commandHostContext;
  delete (globalThis as Record<string, unknown>).__shortcutHostContext;
});

test("listener provider and auth capabilities expire with their session binding and generation", async (context) => {
  const source = `export default (api) => {
    api.on("session_start", (_event, context) => {
      const provider = context.modelRegistry.getProvider("owned-provider");
      if (!provider?.auth.apiKey) throw new Error("owned provider is unavailable");
      const auth = provider.auth;
      const apiKey = auth.apiKey;
      globalThis.__generationBoundProviders ??= [];
      globalThis.__generationBoundProviders.push({
        provider,
        auth,
        apiKey,
        getModels: provider.getModels,
        stream: provider.stream,
        resolve: apiKey.resolve,
        sameProvider: provider === context.modelRegistry.getProvider("owned-provider"),
        sameRegisteredProvider: provider === context.modelRegistry.getRegisteredNativeProvider("owned-provider"),
        sameAuth: auth === provider.auth,
        sameApiKey: apiKey === provider.auth.apiKey
      });
    });
  };\n`;
  const { host, root } = await fixture(context, [source]);
  context.after(async () => {
    await host.close();
    delete (globalThis as Record<string, unknown>).__generationBoundProviders;
  });
  const calls: string[] = [];
  const model: Model<Api> = {
    id: "owned-model",
    name: "Owned model",
    api: "openai-completions",
    provider: "owned-provider",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 1_000,
  };
  const apiKeyAuth: NonNullable<Provider["auth"]["apiKey"]> = {
    name: "Owned key",
    async resolve() {
      assert.equal(this, apiKeyAuth);
      calls.push("auth");
      return { auth: { apiKey: "owned-secret" } };
    },
  };
  const provider: Provider = {
    id: "owned-provider",
    name: "Owned provider",
    auth: { apiKey: apiKeyAuth },
    getModels() {
      assert.equal(this, provider);
      calls.push("getModels");
      return [model];
    },
    stream() {
      assert.equal(this, provider);
      calls.push("stream");
      return createAssistantMessageEventStream();
    },
    streamSimple() {
      assert.equal(this, provider);
      return createAssistantMessageEventStream();
    },
  };
  const modelRegistry = new ModelRegistry(createModels());
  extensionModelRegistry(modelRegistry).registerProvider(provider);
  calls.length = 0;
  const sessionManager = SessionManager.inMemory(root, { id: "provider-generation" });
  const bindSession = (): void => host.setDirectContextHandler(() => ({
    sessionManager: extensionSessionManager(sessionManager),
    modelRegistry,
    thinkingLevel: "off",
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => "provider generation",
  }));
  const authInput = { ctx: { async env() { return undefined; }, async fileExists() { return false; } } };

  bindSession();
  await host.dispatch("session_start", { reason: "startup", threadId: "provider-generation" });
  const views = (globalThis as Record<string, any>).__generationBoundProviders as any[];
  const first = views[0];
  assert.deepEqual(
    [first.sameProvider, first.sameRegisteredProvider, first.sameAuth, first.sameApiKey],
    [true, true, true, true],
  );
  assert.equal(first.provider.getModels()[0]?.id, model.id);
  first.provider.stream(model, { messages: [] });
  await first.apiKey.resolve(authInput);
  assert.deepEqual(calls, ["getModels", "stream", "auth"]);

  calls.length = 0;
  bindSession();
  const sessionStale = /session context is no longer active/u;
  assert.throws(() => first.getModels.call(first.provider), sessionStale);
  assert.throws(() => first.stream.call(first.provider, model, { messages: [] }), sessionStale);
  await assert.rejects(async () => await first.resolve.call(first.apiKey, authInput), sessionStale);
  assert.throws(() => first.auth.apiKey, sessionStale);
  assert.throws(() => first.apiKey.name, sessionStale);
  assert.deepEqual(calls, []);

  await host.dispatch("session_start", { reason: "resume", threadId: "provider-generation" });
  const second = views[1];
  assert.notEqual(second.provider, first.provider);
  assert.deepEqual(
    [second.sameProvider, second.sameRegisteredProvider, second.sameAuth, second.sameApiKey],
    [true, true, true, true],
  );
  assert.equal(second.provider.getModels()[0]?.id, model.id);
  await second.apiKey.resolve(authInput);
  calls.length = 0;

  await host.close();
  const generationStale = /host is closed|no longer active/u;
  assert.throws(() => second.getModels.call(second.provider), generationStale);
  assert.throws(() => second.stream.call(second.provider, model, { messages: [] }), generationStale);
  await assert.rejects(async () => await second.resolve.call(second.apiKey, authInput), generationStale);
  assert.deepEqual(calls, []);
});

test("headless direct UI exposes a stable fallback theme and no-op editor replacement", async (context) => {
  const source = `export default (api) => {
    api.registerCommand("headless-ui", {
      async handler(_args, context) {
        let factoryCalls = 0;
        let terminalCalls = 0;
        const factory = () => { factoryCalls += 1; return {}; };
        context.ui.setEditorComponent(factory);
        context.ui.setBackground(factory);
        context.ui.setWidget("headless", factory);
        context.ui.setFooter(factory);
        context.ui.setHeader(factory);
        context.ui.addAutocompleteProvider(factory);
        context.ui.notify("ignored");
        context.ui.setStatus("headless", "ignored");
        context.ui.setWorkingMessage("ignored");
        context.ui.setWorkingVisible(true);
        context.ui.setWorkingIndicator({ frames: ["."] });
        context.ui.setHiddenThinkingLabel("ignored");
        context.ui.setTitle("ignored");
        context.ui.setEditorText("ignored");
        context.ui.pasteToEditor("ignored");
        context.ui.setToolsExpanded(true);
        const unsubscribe = context.ui.onTerminalInput(() => { terminalCalls += 1; });
        globalThis.__headlessDirectUi = {
          select: await context.ui.select("Select", ["one"]),
          confirm: await context.ui.confirm("Confirm", "Continue?"),
          input: await context.ui.input("Input"),
          editor: await context.ui.editor("Editor", "prefill"),
          custom: await context.ui.custom(factory),
          theme: context.ui.theme.name,
          ansi: context.ui.theme.ansi,
          unicode: context.ui.theme.unicode,
          themes: context.ui.getAllThemes(),
          selected: context.ui.getTheme("mono"),
          editorText: context.ui.getEditorText(),
          editorInstalled: context.ui.getEditorComponent() !== undefined,
          setTheme: context.ui.setTheme("mono"),
          toolsExpanded: context.ui.getToolsExpanded(),
          factoryCalls,
          terminalCalls,
          unsubscribe: typeof unsubscribe,
        };
        unsubscribe();
      }
    });
  };\n`;
  const { host } = await fixture(context, [source]);
  try {
    assert.deepEqual(
      await host.runCommand("headless-ui", {
        threadId: "thread-1",
        branch: "main",
        signal: new AbortController().signal,
        args: "",
      }),
      { handled: true },
    );
    assert.deepEqual((globalThis as Record<string, unknown>).__headlessDirectUi, {
      select: undefined,
      confirm: false,
      input: undefined,
      editor: undefined,
      custom: undefined,
      theme: "mono",
      ansi: false,
      unicode: false,
      themes: [],
      selected: undefined,
      editorText: "",
      editorInstalled: false,
      setTheme: { success: false, error: "Interactive UI is unavailable" },
      toolsExpanded: false,
      factoryCalls: 0,
      terminalCalls: 0,
      unsubscribe: "function",
    });
  } finally {
    await host.close();
    delete (globalThis as Record<string, unknown>).__headlessDirectUi;
  }
});

test("runtime commands and shortcuts settle when their caller aborts", async (context) => {
  let commandStarted!: () => void;
  let shortcutStarted!: () => void;
  const commandReady = new Promise<void>((resolve) => { commandStarted = resolve; });
  const shortcutReady = new Promise<void>((resolve) => { shortcutStarted = resolve; });
  (globalThis as Record<string, unknown>).__authoringCommandStarted = commandStarted;
  (globalThis as Record<string, unknown>).__authoringShortcutStarted = shortcutStarted;
  const source = `export default (api) => {
    api.registerCommand("wait-command", { handler(_args, context) {
      globalThis.__authoringCommandSignal = context.signal;
      globalThis.__authoringCommandStarted();
      return new Promise(() => {});
    }});
    api.registerShortcut("ctrl+g", { handler(context) {
      globalThis.__authoringShortcutSignal = context.signal;
      globalThis.__authoringShortcutStarted();
      return new Promise(() => {});
    }});
  };\n`;
  const { host } = await fixture(context, [source]);

  try {
    const commandAbort = new AbortController();
    const command = host.runCommand("wait-command", {
      ...commandContext(),
      args: "",
      signal: commandAbort.signal,
    });
    await commandReady;
    commandAbort.abort(new Error("cancel command fixture"));
    await assert.rejects(within(command), /cancel command fixture/u);
    assert.equal(((globalThis as Record<string, unknown>).__authoringCommandSignal as AbortSignal).aborted, true);

    const shortcutAbort = new AbortController();
    const shortcut = host.runShortcut("ctrl+g", {
      ...commandContext(),
      signal: shortcutAbort.signal,
    });
    await shortcutReady;
    shortcutAbort.abort(new Error("cancel shortcut fixture"));
    await assert.rejects(within(shortcut), /cancel shortcut fixture/u);
    assert.equal(((globalThis as Record<string, unknown>).__authoringShortcutSignal as AbortSignal).aborted, true);
  } finally {
    await host.close();
    delete (globalThis as Record<string, unknown>).__authoringCommandStarted;
    delete (globalThis as Record<string, unknown>).__authoringShortcutStarted;
    delete (globalThis as Record<string, unknown>).__authoringCommandSignal;
    delete (globalThis as Record<string, unknown>).__authoringShortcutSignal;
  }
});

test("a shortcut reports its replacement failure after its extension generation closes", async (context) => {
  const source = `export default (api) => {
    api.registerShortcut("ctrl+r", { async handler() {
      await globalThis.__authoringCloseForReplacement();
      throw new Error("replacement factory rejected");
    }});
  };\n`;
  const { host } = await fixture(context, [source]);
  (globalThis as Record<string, unknown>).__authoringCloseForReplacement = async () => await host.close();

  try {
    assert.deepEqual(await host.runShortcut("ctrl+r", commandContext()), { handled: true });
    assert.ok(host.diagnostics().some((entry) => entry.message.includes("replacement factory rejected")));
    assert.ok(host.diagnostics().every((entry) => !entry.message.includes("Runtime extension host closed")));
  } finally {
    await host.close();
    delete (globalThis as Record<string, unknown>).__authoringCloseForReplacement;
  }
});

test("resource discovery combines listeners in extension order with source provenance", async (context) => {
  const first = `export default (api) => {
    api.on("resources_discover", (event, context) => {
      globalThis.__resourceDiscoveryEvents = [[event.reason, context.cwd]];
      return { skillPaths: ["skills-a"], promptPaths: ["prompts-a"] };
    });
    api.on("resources_discover", () => ({ themePaths: ["themes-a"] }));
  };\n`;
  const invalid = `export default (api) => api.on("resources_discover", () => ({ skillPaths: "not-an-array" }));\n`;
  const second = `export default (api) => api.on("resources_discover", (event, context) => {
    globalThis.__resourceDiscoveryEvents.push([event.reason, context.cwd]);
    return { skillPaths: ["skills-b"], promptPaths: ["prompts-b"], themePaths: ["themes-b"] };
  });\n`;
  const { host, root } = await fixture(context, [first, invalid, second]);

  try {
    const discovered = await host.discoverResources("startup");
    assert.deepEqual(discovered.skillPaths.map(({ path, extensionId }) => [path, extensionId]), [
      ["skills-a", "extension-0"],
      ["skills-b", "extension-2"],
    ]);
    assert.deepEqual(discovered.promptPaths.map(({ path, extensionId }) => [path, extensionId]), [
      ["prompts-a", "extension-0"],
      ["prompts-b", "extension-2"],
    ]);
    assert.deepEqual(discovered.themePaths.map(({ path, extensionId }) => [path, extensionId]), [
      ["themes-a", "extension-0"],
      ["themes-b", "extension-2"],
    ]);
    assert.ok([...discovered.skillPaths, ...discovered.promptPaths, ...discovered.themePaths]
      .every((entry) => entry.resourceRoot === root && entry.scope === "project" && entry.trusted === true));
    assert.deepEqual((globalThis as Record<string, unknown>).__resourceDiscoveryEvents, [
      ["startup", root],
      ["startup", root],
    ]);
    assert.ok(host.diagnostics().some((entry) => entry.message.includes("resources_discover") && entry.message.includes("array")));
  } finally {
    await host.close();
    delete (globalThis as Record<string, unknown>).__resourceDiscoveryEvents;
  }
});

test("resource discovery honors caller cancellation and rejects untrusted project contributions", async (context) => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  (globalThis as Record<string, unknown>).__resourceDiscoveryStarted = started;
  const waiting = `export default (api) => api.on("resources_discover", (_event, context) => {
    globalThis.__resourceDiscoverySignal = context.signal;
    globalThis.__resourceDiscoveryStarted();
    return new Promise(() => {});
  });\n`;
  const { host } = await fixture(context, [waiting]);
  const controller = new AbortController();
  const pending = host.discoverResources("startup", controller.signal);
  await ready;
  controller.abort(new Error("cancel resource discovery"));
  await assert.rejects(within(pending), /cancel resource discovery/u);
  assert.equal(((globalThis as Record<string, unknown>).__resourceDiscoverySignal as AbortSignal).aborted, true);
  await host.close();
  delete (globalThis as Record<string, unknown>).__resourceDiscoveryStarted;
  delete (globalThis as Record<string, unknown>).__resourceDiscoverySignal;

  const source = `export default (api) => api.on("resources_discover", () => ({ skillPaths: ["skills"] }));\n`;
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-untrusted-resources-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "extension.mjs");
  await writeFile(sourcePath, source);
  const untrusted = await loadTestDirectExtensions([{
    extensionId: "untrusted-project",
    sourcePath,
    sha256: sha256(source),
    resourceRoot: root,
    scope: "project",
    trusted: false,
  }], { workspace: root });
  try {
    assert.deepEqual(await untrusted.discoverResources("startup"), {
      skillPaths: [], promptPaths: [], themePaths: [],
    });
    assert.ok(untrusted.diagnostics().some((entry) => /not trusted.*not imported/u.test(entry.message)));
  } finally {
    await untrusted.close();
  }
});

test("resource discovery has a default host deadline when callers omit a signal", { timeout: 5_000 }, async (context) => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  (globalThis as Record<string, unknown>).__resourceDefaultDeadlineStarted = started;
  const source = `export default (api) => api.on("resources_discover", (_event, context) => {
    globalThis.__resourceDefaultDeadlineSignal = context.signal;
    globalThis.__resourceDefaultDeadlineStarted();
    return new Promise(() => {});
  });\n`;
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-resource-deadline-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "extension.mjs");
  await writeFile(sourcePath, source);
  const host = await loadTestDirectExtensions([{
    extensionId: "resource-deadline",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root, resourceDiscoveryTimeoutMs: 25 });

  try {
    const pending = host.discoverResources("startup");
    await ready;
    await assert.rejects(within(pending, 250), /aborted|timeout/i);
    assert.equal(((globalThis as Record<string, unknown>).__resourceDefaultDeadlineSignal as AbortSignal).aborted, true);
  } finally {
    await host.close();
    delete (globalThis as Record<string, unknown>).__resourceDefaultDeadlineStarted;
    delete (globalThis as Record<string, unknown>).__resourceDefaultDeadlineSignal;
  }
});

test("runtime shutdown listeners are bounded and diagnosed before host teardown", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-shutdown-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const shutdownPath = join(root, "shutdown.mjs");
  const shutdownSource = `export default (api) => {
    api.on("session_shutdown", () => new Promise(() => {}));
  };\n`;
  await writeFile(shutdownPath, shutdownSource);
  const shutdownHost = await loadTestDirectExtensions([{
    extensionId: "shutdown",
    sourcePath: shutdownPath,
    sha256: sha256(shutdownSource),
  }], { workspace: root, shutdownTimeoutMs: 25 });
  await assert.rejects(
    within(shutdownHost.dispatch("session_shutdown", { reason: "quit" })),
    /aborted|timeout/i,
  );
  assert.ok(shutdownHost.diagnostics().some((entry) => entry.message.includes("session_shutdown")));
  await within(shutdownHost.close());
});

test("before-provider request hooks chain safe patches and reject identity, tool, and secret-unsafe failures", async (context) => {
  (globalThis as Record<string, unknown>).__providerBoundaryOrder = [];
  const first = `export default (api) => api.on("before_provider_request", (event) => {
    globalThis.__providerBoundaryOrder.push("first");
    globalThis.__providerBoundaryKeys = [Object.keys(event).sort(), Object.keys(event.request).sort()];
    event.request.messages[0].content[0].text = "in-place mutation must not escape";
    return { tools: event.request.tools.slice(0, 1), reasoningEffort: "high", metadata: { stage: "first" } };
  });\n`;
  const invalidIdentity = `export default (api) => api.on("before_provider_request", () => {
    globalThis.__providerBoundaryOrder.push("identity");
    return { provider: "forbidden-provider" };
  });\n`;
  const invalidTool = `export default (api) => api.on("before_provider_request", () => {
    globalThis.__providerBoundaryOrder.push("tool");
    return { tools: [{ name: "unavailable_tool", description: "no", inputSchema: { type: "object" } }] };
  });\n`;
  const fixtureSecret = ["sk", "proj", "1234567890abcdefghijkl"].join("-");
  const secretFailure = `export default (api) => api.on("before_provider_request", () => {
    globalThis.__providerBoundaryOrder.push("secret");
    throw new Error(${JSON.stringify(fixtureSecret)});
  });\n`;
  const last = `export default (api) => api.on("before_provider_request", (event) => {
    globalThis.__providerBoundaryOrder.push("last:" + event.request.metadata.stage + ":" + event.request.messages[0].content[0].text);
    return { maxOutputTokens: null, metadata: { stage: "last" } };
  });\n`;
  const { host } = await fixture(context, [first, invalidIdentity, invalidTool, secretFailure, last]);

  try {
    const reduced = await host.reduceBeforeProviderRequest({
      threadId: "thread-1",
      runId: "run-1",
      branch: "main",
      step: 1,
      provider: "provider-1",
      model: "model-1",
      request: {
        messages: [message("request-user", "user", "original")],
        tools: [
          { name: "first_tool", description: "first", inputSchema: { type: "object" } },
          { name: "second_tool", description: "second", inputSchema: { type: "object" } },
        ],
        maxOutputTokens: 100,
        metadata: { stage: "initial" },
      },
    });
    assert.equal(reduced.messages[0]?.content[0]?.type === "text" ? reduced.messages[0].content[0].text : undefined, "original");
    assert.deepEqual(reduced.tools.map((tool) => tool.name), ["first_tool"]);
    assert.equal(reduced.reasoningEffort, "high");
    assert.equal(reduced.maxOutputTokens, undefined);
    assert.deepEqual({ ...reduced.metadata }, { stage: "last" });
    assert.deepEqual((globalThis as Record<string, unknown>).__providerBoundaryOrder, [
      "first", "identity", "tool", "secret", "last:first:original",
    ]);
    assert.deepEqual((globalThis as Record<string, unknown>).__providerBoundaryKeys, [
      ["branch", "model", "provider", "request", "runId", "step", "threadId", "type"],
      ["maxOutputTokens", "messages", "metadata", "tools"],
    ]);
    assert.ok(host.diagnostics().some((entry) => entry.message.includes("identity or unsupported") || entry.message.includes("unknown or owner-controlled")));
    assert.ok(host.diagnostics().some((entry) => entry.message.includes("unavailable names")));
    assert.equal(host.diagnostics().some((entry) => entry.message.includes(fixtureSecret)), false);
    assert.ok(host.diagnostics().some((entry) => entry.message.includes("[REDACTED]")));
  } finally {
    await host.close();
    delete (globalThis as Record<string, unknown>).__providerBoundaryOrder;
    delete (globalThis as Record<string, unknown>).__providerBoundaryKeys;
  }
});

test("before-provider request hooks validate, clone, and preserve constrained sampling", async (context) => {
  const validPatch = `export default (api) => api.on("before_provider_request", (event) => {
    globalThis.__providerConstraintInitial = structuredClone(event.request.tools.map((tool) => tool.constrainedSampling));
    const constrainedSampling = {
      type: "grammar",
      variants: { openai_lark: "start: /[a-z]+/", openai_regex: "[a-z]+" }
    };
    globalThis.__providerConstraintPatch = constrainedSampling;
    return {
      tools: event.request.tools.map((tool, index) =>
        index === 0 ? { ...tool, constrainedSampling } : tool)
    };
  });\n`;
  const invalidPatch = `export default (api) => api.on("before_provider_request", (event) => ({
    tools: event.request.tools.map((tool, index) => index === 0
      ? {
          ...tool,
          constrainedSampling: {
            type: "grammar",
            variants: { openai_regex: "x".repeat(256 * 1024 + 1) }
          }
        }
      : tool)
  }));\n`;
  const observe = `export default (api) => api.on("before_provider_request", (event) => {
    globalThis.__providerConstraintFinal = structuredClone(event.request.tools.map((tool) => tool.constrainedSampling));
  });\n`;
  const { host } = await fixture(context, [validPatch, invalidPatch, observe]);
  const initialConstraint = { type: "json_schema", strict: "require" } as const;

  try {
    const reduced = await host.reduceBeforeProviderRequest({
      threadId: "thread-1",
      runId: "run-1",
      branch: "main",
      step: 1,
      provider: "provider-1",
      model: "model-1",
      request: {
        messages: [message("constraint-user", "user", "constrained")],
        tools: [
          {
            name: "constrained_tool",
            description: "constrained",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
            constrainedSampling: initialConstraint,
          },
          {
            name: "unconstrained_tool",
            description: "unconstrained",
            inputSchema: { type: "object" },
            constrainedSampling: false,
          },
        ],
      },
    });

    assert.deepEqual((globalThis as Record<string, unknown>).__providerConstraintInitial, [
      initialConstraint,
      false,
    ]);
    assert.deepEqual(reduced.tools.map((tool) => tool.constrainedSampling), [
      {
        type: "grammar",
        variants: { openai_lark: "start: /[a-z]+/", openai_regex: "[a-z]+" },
      },
      false,
    ]);
    assert.deepEqual(
      (globalThis as Record<string, unknown>).__providerConstraintFinal,
      reduced.tools.map((tool) => tool.constrainedSampling),
    );
    assert.notEqual(reduced.tools[0]?.constrainedSampling, initialConstraint);
    assert.notEqual(
      reduced.tools[0]?.constrainedSampling,
      (globalThis as Record<string, unknown>).__providerConstraintPatch,
    );
    assert.ok(host.diagnostics().some((entry) =>
      entry.message.includes("constrainedSampling.variants.openai_regex is invalid")));

    await assert.rejects(
      host.reduceBeforeProviderRequest({
        threadId: "thread-1",
        runId: "run-2",
        branch: "main",
        step: 2,
        provider: "provider-1",
        model: "model-1",
        request: {
          messages: [message("invalid-constraint-user", "user", "invalid")],
          tools: [{
            name: "invalid_constraint",
            description: "invalid",
            inputSchema: { type: "object" },
            constrainedSampling: {
              type: "grammar",
              variants: { openai_regex: "[a-z]+", unsupported: "invalid" },
            } as never,
          }],
        },
      }),
      /unknown or owner-controlled field/u,
    );
  } finally {
    await host.close();
    delete (globalThis as Record<string, unknown>).__providerConstraintInitial;
    delete (globalThis as Record<string, unknown>).__providerConstraintPatch;
    delete (globalThis as Record<string, unknown>).__providerConstraintFinal;
  }
});

test("provider request messages and tool schemas enter bounded JSON before semantic traversal", async (context) => {
  const { host } = await fixture(context, [`export default () => {};\n`]);
  let serializerCalls = 0;
  const inherited = Object.assign(Object.create({
    toJSON() {
      serializerCalls += 1;
      return { type: "object" };
    },
  }), { type: "object" });
  const request = {
    messages: [message("bounded-provider-user", "user", "bounded")],
    tools: [{ name: "bounded_tool", description: "bounded", inputSchema: { type: "object" } }],
  };
  const event = {
    threadId: "thread-1",
    runId: "run-bounds",
    branch: "main",
    step: 1,
    provider: "provider-1",
    model: "model-1",
  };

  const inheritedMessage = Object.assign(Object.create({
    toJSON() {
      serializerCalls += 1;
      return message("rewritten", "user", "rewritten");
    },
  }), message("inherited", "user", "inherited"));
  await assert.rejects(
    host.reduceBeforeProviderRequest({ ...event, request: { ...request, messages: [inheritedMessage] } }),
    /plain objects/u,
  );
  await assert.rejects(
    host.reduceBeforeProviderRequest({
      ...event,
      request: {
        ...request,
        tools: [{ ...request.tools[0]!, inputSchema: inherited }],
      },
    }),
    /plain objects/u,
  );
  assert.equal(serializerCalls, 0);

  type SharedJson = { value: true } | { left: SharedJson; right: SharedJson };
  let shared: SharedJson = { value: true };
  for (let depth = 0; depth < 14; depth += 1) shared = { left: shared, right: shared };
  await assert.rejects(
    host.reduceBeforeProviderRequest({
      ...event,
      request: {
        ...request,
        messages: [{
          ...message("oversized-message", "assistant", ""),
          content: [{ type: "tool_call", callId: "call-1", name: "bounded_tool", arguments: shared }],
        }],
      },
    }),
    /exceeds (?:4096 JSON containers|8192 JSON values)/u,
  );
  await assert.rejects(
    host.reduceBeforeProviderRequest({
      ...event,
      request: {
        ...request,
        tools: [{ ...request.tools[0]!, inputSchema: { type: "object", definitions: shared } }],
      },
    }),
    /exceeds (?:4096 JSON containers|8192 JSON values)/u,
  );

  await host.close();
});

test("direct provider payload snapshots reject inherited serializers without invoking them", async (context) => {
  const source = `export default (api) => api.on("before_provider_request", () => {
    return Object.assign(Object.create({
      toJSON() {
        globalThis.__providerPayloadToJson += 1;
        return { rewritten: true };
      }
    }), { replacement: true });
  });\n`;
  const { host } = await fixture(context, [source]);
  const globals = globalThis as Record<string, unknown>;
  globals.__providerPayloadToJson = 0;

  try {
    assert.deepEqual(await host.applyBeforeProviderRequestPayload({ original: true }), { original: true });
    assert.equal(globals.__providerPayloadToJson, 0);
    const diagnostics = host.diagnostics();
    assert.ok(
      diagnostics.some((entry) => entry.message.includes("plain objects")),
      JSON.stringify(diagnostics),
    );
  } finally {
    delete globals.__providerPayloadToJson;
    await host.close();
  }
});

test("before-provider request hooks settle on cancellation and replace cleanly after generation unload", async (context) => {
  let callerStarted!: () => void;
  let unloadStarted!: () => void;
  const callerReady = new Promise<void>((resolve) => { callerStarted = resolve; });
  const unloadReady = new Promise<void>((resolve) => { unloadStarted = resolve; });
  (globalThis as Record<string, unknown>).__providerCallerStarted = callerStarted;
  (globalThis as Record<string, unknown>).__providerUnloadStarted = unloadStarted;
  const source = `export default (api) => api.on("before_provider_request", (event) => {
    if (event.step === 1) globalThis.__providerCallerStarted();
    else globalThis.__providerUnloadStarted();
    return new Promise(() => {});
  });\n`;
  const { host, root } = await fixture(context, [source]);
  const event = {
    threadId: "thread-1",
    runId: "run-1",
    branch: "main",
    provider: "provider-1",
    model: "model-1",
    request: { messages: [message("cancel-user", "user", "cancel")], tools: [] },
  };

  const controller = new AbortController();
  const caller = host.reduceBeforeProviderRequest({ ...event, step: 1 }, controller.signal);
  await callerReady;
  controller.abort(new Error("cancel provider boundary"));
  await assert.rejects(within(caller), /cancel provider boundary/u);

  const unloaded = host.reduceBeforeProviderRequest({ ...event, step: 2 });
  await unloadReady;
  const closing = host.close();
  await assert.rejects(within(unloaded), /closed/u);
  await within(closing);

  const replacementPath = join(root, "replacement.mjs");
  const replacementSource = `export default (api) => api.on("before_provider_request", () => ({ metadata: { generation: "replacement" } }));\n`;
  await writeFile(replacementPath, replacementSource);
  const replacement = await loadTestDirectExtensions([{
    extensionId: "replacement",
    sourcePath: replacementPath,
    sha256: sha256(replacementSource),
  }], { workspace: root });
  try {
    const reduced = await replacement.reduceBeforeProviderRequest({ ...event, step: 3 });
    assert.deepEqual({ ...reduced.metadata }, { generation: "replacement" });
  } finally {
    await replacement.close();
  }
});

test("runtime flags are typed, first-registration configured, scoped, and mutable after activation", async (context) => {
  const first = `export default (api) => {
    globalThis.__authoringFirstApi = api;
    api.registerFlag("plan", { description: "first", type: "boolean", default: true });
    api.registerFlag("plan", { description: "first-final", type: "boolean", default: false });
    api.registerFlag("mode", { type: "string", default: "safe" });
    api.on("session_start", () => { globalThis.__authoringFirstFlags = [api.getFlag("plan"), api.getFlag("mode"), api.getFlag("foreign")]; });
  };\n`;
  const second = `export default (api) => {
    api.registerFlag("plan", { description: "second", type: "boolean", default: false });
    api.registerFlag("foreign", { type: "string", default: "owned" });
    api.on("session_start", () => { globalThis.__authoringSecondFlags = [api.getFlag("plan"), api.getFlag("foreign"), api.getFlag("mode")]; });
  };\n`;
  const { host } = await fixture(context, [first, second]);

  assert.deepEqual(host.flags().map((flag) => [flag.name, flag.description, flag.default]), [
    ["plan", "first-final", false],
    ["mode", undefined, "safe"],
    ["foreign", undefined, "owned"],
  ]);
  assert.deepEqual([...host.flagValues()], [["plan", true], ["mode", "safe"], ["foreign", "owned"]]);
  assert.throws(() => host.setFlagValue("plan", "yes"), /requires a boolean/u);
  assert.throws(() => host.setFlagValue("missing", true), /Unknown runtime extension flag/u);
  host.setFlagValue("plan", false);
  host.setFlagValue("mode", "fast");
  await host.dispatch("session_start", { reason: "startup", threadId: "thread-1" });
  assert.deepEqual((globalThis as Record<string, unknown>).__authoringFirstFlags, [false, "fast", undefined]);
  assert.deepEqual((globalThis as Record<string, unknown>).__authoringSecondFlags, [false, "owned", undefined]);

  const stale = (globalThis as Record<string, any>).__authoringFirstApi;
  await host.close();
  assert.throws(() => stale.getFlag("plan"), /no longer active/u);
  delete (globalThis as Record<string, unknown>).__authoringFirstApi;
  delete (globalThis as Record<string, unknown>).__authoringFirstFlags;
  delete (globalThis as Record<string, unknown>).__authoringSecondFlags;
});

test("ordinary observer failures are diagnostic and do not stop later observers", async (context) => {
  const first = `export default (api) => api.on("session_start", () => {
    throw new Error("observer boom");
  });\n`;
  const second = `export default (api) => api.on("session_start", () => {
    globalThis.__authoringObserverContinued = true;
  });\n`;
  const { host } = await fixture(context, [first, second]);

  await host.dispatch("session_start", { reason: "startup", threadId: "thread-1" });

  assert.equal((globalThis as Record<string, unknown>).__authoringObserverContinued, true);
  assert.ok(host.diagnostics().some((entry) => entry.message.includes("observer boom")));
  delete (globalThis as Record<string, unknown>).__authoringObserverContinued;
});

test("runtime shortcuts canonicalize keys, use last-registration wins, and reject stale execution", async (context) => {
  const first = `export default (api) => api.registerShortcut("SHIFT + CTRL + X", {
    description: "first", handler() { globalThis.__authoringShortcut = "first"; }
  });\n`;
  const second = `export default (api) => api.registerShortcut("ctrl+shift+x", {
    description: "second", handler(ctx) { globalThis.__authoringShortcut = "second:" + ctx.cwd; }
  });\n`;
  const { host, root } = await fixture(context, [first, second]);

  assert.deepEqual(host.shortcuts().map((entry) => [entry.shortcut, entry.description, entry.extensionId]), [
    ["ctrl+shift+x", "second", "extension-1"],
  ]);
  assert.match(host.diagnostics()[0]?.message ?? "", /replaced the registration/u);
  assert.equal(host.hasShortcut("shift+ctrl+x"), true);
  assert.deepEqual(await host.runShortcut("ctrl+shift+x", commandContext()), { handled: true });
  assert.equal((globalThis as Record<string, unknown>).__authoringShortcut, `second:${root}`);
  assert.deepEqual(await host.runShortcut("ctrl+alt+x", commandContext()), { handled: false });
  await host.close();
  await assert.rejects(host.runShortcut("ctrl+shift+x", commandContext()), /host is closed/u);
  delete (globalThis as Record<string, unknown>).__authoringShortcut;
});

test("post-activation flag, shortcut, command, and hook registrations become live immediately", async (context) => {
  const source = `export default (api) => { globalThis.__authoringLateApi = api; };\n`;
  const { host } = await fixture(context, [source]);
  const api = (globalThis as Record<string, any>).__authoringLateApi;
  const changes: string[] = [];
  host.onChange((change) => changes.push(change));
  api.registerFlag("late-flag", { type: "boolean", default: true });
  api.registerShortcut("alt+z", { handler() { (globalThis as Record<string, unknown>).__authoringLateShortcut = true; } });
  api.registerCommand("late-authoring", { getArgumentCompletions() { return [{ value: "done" }]; }, handler() { return "late"; } });
  api.on("context", (event: any) => ({ messages: event.messages.slice(0, 1) }));
  api.on("session_shutdown", () => { (globalThis as Record<string, unknown>).__authoringShutdown = true; });

  assert.equal(api.getFlag("late-flag"), true);
  assert.deepEqual(changes, ["flag", "shortcut", "command"]);
  assert.deepEqual(await host.runShortcut("alt+z", commandContext()), { handled: true });
  assert.equal((globalThis as Record<string, unknown>).__authoringLateShortcut, true);
  assert.deepEqual(await host.completeCommandArguments("late-authoring", ""), [{ value: "done" }]);
  assert.deepEqual(await host.runCommand("late-authoring", { ...commandContext(), args: "" }), { handled: true, prompt: "late" });
  assert.deepEqual((await host.reduceContext({
    threadId: "thread-1",
    runId: "run-1",
    branch: "main",
    messages: [
      message("first", "user", "one"),
      message("second", "assistant", "two"),
    ],
  })).map((entry) => entry.id), ["first"]);
  await host.dispatch("session_shutdown", { reason: "quit" });
  assert.equal((globalThis as Record<string, unknown>).__authoringShutdown, true);
  await host.close();
  assert.throws(() => api.registerFlag("stale", { type: "boolean" }), /no longer active/u);
  delete (globalThis as Record<string, unknown>).__authoringLateApi;
  delete (globalThis as Record<string, unknown>).__authoringLateShortcut;
  delete (globalThis as Record<string, unknown>).__authoringShutdown;
});

test("duplicate command names remain independently invokable and duplicate tools keep the first owner", async (context) => {
  const first = `export default (api) => {
    api.registerCommand("review", { description: "first command", getArgumentCompletions(prefix) { return [{ value: prefix + "-one", label: "One" }]; }, handler() { return "first"; } });
    api.registerTool({ name: "shared_tool", label: "Shared", description: "first tool", parameters: { type: "object" }, async execute() { return { content: [{ type: "text", text: "first" }], details: {} }; } });
    api.registerTool({ name: "first_only", label: "First", description: "first only", parameters: { type: "object" }, async execute() { return { content: [{ type: "text", text: "one" }], details: {} }; } });
  };\n`;
  const second = `export default (api) => {
    api.registerCommand("review", { description: "second command", handler() { return "second"; } });
    api.registerTool({ name: "shared_tool", label: "Shared", description: "second tool", parameters: { type: "object" }, async execute() { return { content: [{ type: "text", text: "second" }], details: {} }; } });
    api.registerTool({ name: "second_only", label: "Second", description: "second only", parameters: { type: "object" }, async execute() { return { content: [{ type: "text", text: "two" }], details: {} }; } });
  };\n`;
  const { host, root } = await fixture(context, [first, second]);

  assert.deepEqual(host.commands().map((entry) => [entry.name, entry.baseName, entry.description]), [
    ["review:1", "review", "first command"],
    ["review:2", "review", "second command"],
  ]);
  assert.equal(host.hasCommand("review"), false);
  assert.deepEqual(await host.runCommand("review:1", { ...commandContext(), args: "" }), { handled: true, prompt: "first" });
  assert.deepEqual(await host.runCommand("review:2", { ...commandContext(), args: "" }), { handled: true, prompt: "second" });
  assert.deepEqual(await host.completeCommandArguments("review:1", "pre"), [{ value: "pre-one", label: "One" }]);
  assert.equal(await host.completeCommandArguments("review:2", "pre"), null);
  assert.deepEqual(host.tools().map((tool) => [tool.definition.name, tool.definition.description]), [
    ["shared_tool", "first tool"],
    ["first_only", "first only"],
    ["second_only", "second only"],
  ]);
  assert.deepEqual(host.diagnostics(), [{
    extensionId: "extension-1",
    sourcePath: join(root, "extension-1.mjs"),
    message: `Runtime tool shared_tool from extension-1 (${join(root, "extension-1.mjs")}) was ignored because extension-0 (${join(root, "extension-0.mjs")}) registered it first`,
  }]);
  await host.close();
});

test("duplicate tool ownership distinguishes matching extension IDs at different source paths", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-owner-identity-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  context.after(() => {
    delete (globalThis as Record<string, unknown>).__sameIdFirstApi;
    delete (globalThis as Record<string, unknown>).__sameIdSecondApi;
  });
  const first = `export default (api) => {
    globalThis.__sameIdFirstApi = api;
    api.registerTool({ name: "same_id_tool", label: "Same", description: "first source", parameters: { type: "object" }, async execute() { return { content: [{ type: "text", text: "first" }], details: {} }; } });
  };\n`;
  const second = `export default (api) => {
    globalThis.__sameIdSecondApi = api;
    api.registerTool({ name: "same_id_tool", label: "Same", description: "second source", parameters: { type: "object" }, async execute() { return { content: [{ type: "text", text: "second" }], details: {} }; } });
  };\n`;
  const firstPath = join(root, "first", "entry.mjs");
  const secondPath = join(root, "second", "entry.mjs");
  await Promise.all([
    mkdir(join(root, "first")),
    mkdir(join(root, "second")),
  ]);
  await Promise.all([
    writeFile(firstPath, first),
    writeFile(secondPath, second),
  ]);
  const host = await loadTestDirectExtensions([
    { extensionId: "shared.extension", sourcePath: firstPath, sha256: sha256(first) },
    { extensionId: "shared.extension", sourcePath: secondPath, sha256: sha256(second) },
  ], { workspace: root });
  try {
    const firstApi = (globalThis as Record<string, unknown>).__sameIdFirstApi as ExtensionAPI;
    const secondApi = (globalThis as Record<string, unknown>).__sameIdSecondApi as ExtensionAPI;
    const firstUser = await firstApi.config.replace("user", { owner: "first" }, { expectedRevision: null });
    const firstWorkspace = await firstApi.config.replace("workspace", { owner: "first" }, { expectedRevision: null });
    assert.deepEqual(await secondApi.config.read("user"), { revision: null, value: undefined });
    assert.deepEqual(await secondApi.config.read("workspace"), { revision: null, value: undefined });
    await secondApi.config.replace("user", { owner: "second" }, { expectedRevision: null });
    await secondApi.config.replace("workspace", { owner: "second" }, { expectedRevision: null });
    assert.deepEqual(await firstApi.config.read("user"), firstUser);
    assert.deepEqual(await firstApi.config.read("workspace"), firstWorkspace);
    assert.notDeepEqual(host.extensionDataPaths(firstPath), host.extensionDataPaths(secondPath));
    assert.equal(host.tools().find((tool) => tool.definition.name === "same_id_tool")?.definition.description, "first source");
    assert.deepEqual(host.diagnostics(), [{
      extensionId: "shared.extension",
      sourcePath: secondPath,
      message: `Runtime tool same_id_tool from shared.extension (${secondPath}) was ignored because shared.extension (${firstPath}) registered it first`,
    }]);
  } finally {
    await host.close();
  }
});

test("late duplicate tools diagnose cross-extension collisions and same-owner registration replaces in place", async (context) => {
  const first = `export default (api) => { globalThis.__authoringFirstToolApi = api; };\n`;
  const second = `export default (api) => { globalThis.__authoringSecondToolApi = api; };\n`;
  const { host, root } = await fixture(context, [first, second]);
  const firstApi = (globalThis as Record<string, any>).__authoringFirstToolApi;
  const secondApi = (globalThis as Record<string, any>).__authoringSecondToolApi;
  const registration = (description: string) => ({
    name: "late_shared_tool",
    label: "Late shared",
    description,
    parameters: { type: "object" },
    async execute() { return { content: [{ type: "text", text: description }], details: {} }; },
  });
  try {
    firstApi.registerTool(registration("first late tool"));
    secondApi.registerTool(registration("second late tool"));

    assert.equal(host.tools().find((tool) => tool.definition.name === "late_shared_tool")?.definition.description, "first late tool");
    assert.deepEqual(host.diagnostics(), [{
      extensionId: "extension-1",
      sourcePath: join(root, "extension-1.mjs"),
      message: `Runtime tool late_shared_tool from extension-1 (${join(root, "extension-1.mjs")}) was ignored because extension-0 (${join(root, "extension-0.mjs")}) registered it first`,
    }]);
    firstApi.registerTool(registration("same owner replacement"));
    assert.equal(host.tools().find((tool) => tool.definition.name === "late_shared_tool")?.definition.description, "same owner replacement");
  } finally {
    await host.close();
    delete (globalThis as Record<string, unknown>).__authoringFirstToolApi;
    delete (globalThis as Record<string, unknown>).__authoringSecondToolApi;
  }
});

test("live same-owner tool replacement retains only the current registration cleanup", async (context) => {
  const source = `export default (api) => { globalThis.__authoringLiveToolApi = api; };\n`;
  const { host } = await fixture(context, [source]);
  const api = (globalThis as Record<string, any>).__authoringLiveToolApi;
  const events: string[] = [];
  host.setLiveRegistrationHandler({
    registerTool(tool) {
      events.push(`register:${tool.definition.description}`);
      return () => { events.push(`cleanup:${tool.definition.description}`); };
    },
    replaceTool(previous, tool) {
      events.push(`replace:${previous.definition.description}->${tool.definition.description}`);
      if (tool.definition.description === "rejected") throw new Error("replacement rejected");
      return () => { events.push(`cleanup:${tool.definition.description}`); };
    },
  });
  const registration = (description: string) => ({
    name: "live_replacement",
    label: "Live replacement",
    description,
    parameters: { type: "object" },
    async execute() { return { content: [{ type: "text", text: description }], details: {} }; },
  });
  try {
    api.registerTool(registration("first"));
    api.registerTool(registration("second"));
    assert.deepEqual(events, ["register:first", "replace:first->second"]);
    assert.throws(() => api.registerTool(registration("rejected")), /replacement rejected/u);
    assert.equal(host.tools().find((tool) => tool.definition.name === "live_replacement")?.definition.description, "second");
    await host.close();
    assert.deepEqual(events, [
      "register:first",
      "replace:first->second",
      "replace:second->rejected",
      "cleanup:second",
    ]);
  } finally {
    await host.close();
    delete (globalThis as Record<string, unknown>).__authoringLiveToolApi;
  }
});

test("live same-owner tool replacement removes an obsolete renderer", async (context) => {
  const source = `export default (api) => { globalThis.__authoringLiveRendererApi = api; };\n`;
  const { host } = await fixture(context, [source]);
  const api = (globalThis as Record<string, any>).__authoringLiveRendererApi;
  const registration = (description: string, renderShell?: "self") => ({
    name: "live_renderer_replacement",
    label: "Live renderer replacement",
    description,
    parameters: { type: "object" },
    ...(renderShell === undefined ? {} : { renderShell }),
    async execute() { return { content: [{ type: "text", text: description }], details: {} }; },
  });
  try {
    api.registerTool(registration("rendered", "self"));
    assert.equal(host.renderShell("live_renderer_replacement"), "self");
    api.registerTool(registration("plain"));
    assert.equal(host.renderShell("live_renderer_replacement"), undefined);
  } finally {
    await host.close();
    delete (globalThis as Record<string, unknown>).__authoringLiveRendererApi;
  }
});

test("a losing cross-extension tool renderer does not discard unrelated contributions", async (context) => {
  const first = `export default (api) => {
    api.registerTool({
      name: "shared_rendered_tool",
      label: "Shared rendered tool",
      description: "first tool",
      parameters: { type: "object" },
      renderShell: "self",
      async execute() { return { content: [], details: {} }; }
    });
  };\n`;
  const second = `export default (api) => {
    api.registerTool({
      name: "shared_rendered_tool",
      label: "Shared rendered tool",
      description: "second tool",
      parameters: { type: "object" },
      renderShell: "self",
      async execute() { return { content: [], details: {} }; }
    });
    api.registerCommand("second-command", { async handler() {} });
  };\n`;
  const { host, root } = await fixture(context, [first, second]);
  try {
    assert.equal(host.tools().find((tool) => tool.definition.name === "shared_rendered_tool")?.definition.description, "first tool");
    assert.equal(host.renderShell("shared_rendered_tool"), "self");
    assert.equal(host.hasCommand("second-command"), true);
    assert.deepEqual(host.diagnostics(), [{
      extensionId: "extension-1",
      sourcePath: join(root, "extension-1.mjs"),
      message: `Runtime tool shared_rendered_tool from extension-1 (${join(root, "extension-1.mjs")}) was ignored because extension-0 (${join(root, "extension-0.mjs")}) registered it first`,
    }]);
  } finally {
    await host.close();
  }
});

test("post-activation same-owner command registration replaces its handler", async (context) => {
  const source = `export default (api) => { globalThis.__authoringReplaceCommandApi = api; };\n`;
  const { host } = await fixture(context, [source]);
  const api = (globalThis as Record<string, any>).__authoringReplaceCommandApi;
  try {
    api.registerCommand("replace-command", { handler() { return "first"; } });
    assert.deepEqual(await host.runCommand("replace-command", { ...commandContext(), args: "" }), { handled: true, prompt: "first" });
    api.registerCommand("replace-command", { handler() { return "second"; } });
    assert.deepEqual(host.commands().map((command) => command.name), ["replace-command"]);
    assert.deepEqual(await host.runCommand("replace-command", { ...commandContext(), args: "" }), { handled: true, prompt: "second" });
  } finally {
    await host.close();
    delete (globalThis as Record<string, unknown>).__authoringReplaceCommandApi;
  }
});

test("command registration snapshots the validated handler", async (context) => {
  const source = `export default (api) => {
    const command = { description: "validated", handler() { return this.description; } };
    api.registerCommand("handler-snapshot", command);
    command.handler = () => "mutated";
  };\n`;
  const { host } = await fixture(context, [source]);

  assert.deepEqual(
    await host.runCommand("handler-snapshot", { ...commandContext(), args: "" }),
    { handled: true, prompt: "validated" },
  );
  await host.close();
});

test("input, prompt, context, and message reducers chain in load order and isolate failures", async (context) => {
  const first = `export default (api) => {
    api.on("input", (event) => ({ action: "transform", text: event.text + ":one" }));
    api.on("before_agent_start", (event) => ({
      systemPrompt: event.systemPrompt + ":one",
      message: { customType: "injected-1", content: "one", display: false }
    }));
    api.on("context", (event) => ({ messages: event.messages.filter((entry) => entry.role !== "tool") }));
    api.on("message_end", (event) => ({ message: { ...event.message, content: event.message.content.map((block) => block.type === "text" ? { ...block, text: block.text + ":one" } : block) } }));
  };\n`;
  const broken = `export default (api) => {
    api.on("input", () => { throw new Error("input boom"); });
    api.on("context", () => { throw new Error("context boom"); });
    api.on("message_end", (event) => ({ message: { ...event.message, role: "user" } }));
  };\n`;
  const last = `export default (api) => {
    api.on("input", (event) => event.text.includes("stop") ? { action: "handled" } : { action: "transform", text: event.text + ":two" });
    api.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + ":two" }));
    api.on("context", (event) => ({ messages: [...event.messages, { role: "user", content: [{ type: "text", text: "last" }], timestamp: 1767225600000 }] }));
    api.on("message_end", (event) => ({ message: { ...event.message, content: event.message.content.map((block) => block.type === "text" ? { ...block, text: block.text + ":two" } : block) } }));
  };\n`;
  const { host } = await fixture(context, [first, broken, last]);

  assert.deepEqual(await host.reduceInput({ threadId: "thread-input", branch: "main", text: "go", source: "interactive" }), { action: "transform", text: "go:one:two" });
  assert.deepEqual(await host.reduceInput({ threadId: "thread-input", branch: "main", text: "stop", source: "rpc" }), { action: "handled" });
  const runScope = { threadId: "thread-authoring", runId: "run-authoring", branch: "main" };
  const before = await host.reduceBeforeAgentStart({
    ...runScope,
    prompt: "p",
    systemPrompt: "base",
    systemPromptOptions: { cwd: process.cwd(), selectedTools: [] },
  });
  assert.equal(before.systemPrompt, "base:one:two");
  assert.deepEqual(before.messages.map((entry) => entry.customType), ["injected-1"]);
  const reducedContext = await host.reduceContext({
    ...runScope,
    step: 1,
    messages: [
      message("user", "user", "request"),
      message("tool", "tool", "result"),
    ],
  });
  assert.deepEqual(reducedContext.map((entry) => entry.role), ["user", "user"]);
  const finalContextBlock = reducedContext.at(-1)?.content[0];
  assert.equal(finalContextBlock?.type, "text");
  assert.equal(finalContextBlock?.type === "text" ? finalContextBlock.text : undefined, "last");
  const ended = await host.reduceMessageEnd({
    ...runScope,
    step: 1,
    message: message("assistant", "assistant", "answer"),
  });
  assert.equal(ended.role, "assistant");
  assert.equal(ended.content[0]?.type === "text" ? ended.content[0].text : undefined, "answer:one:two");
  assert.ok(host.diagnostics().some((entry) => entry.message.includes("input boom")));
  assert.ok(host.diagnostics().some((entry) => entry.message.includes("context boom")));
  assert.ok(host.diagnostics().some((entry) => entry.message.includes("cannot change the message role")));
  await host.close();
});

test("tool reducers expose prior mutations, chain partial result patches, and propagate failures before execution", async (context) => {
  const mutating = `export default (api) => {
    api.on("tool_call", (event) => {
      try { event.threadId = "forged-thread"; } catch {}
      try { event.runId = "forged-run"; } catch {}
      try { event.branch = "forged-branch"; } catch {}
      event.input.path = "safe/" + event.input.path;
    });
    api.on("tool_call", (event) => event.input.path === "safe/blocked"
      ? { block: true, reason: "protected", terminate: true }
      : event.input.path === "safe/ignored"
        ? { block: false, terminate: true }
        : undefined);
    api.on("tool_call", (event) => {
      if (event.input.path !== "safe/blocked") return undefined;
      globalThis.__authoringLaterToolListenerRan = true;
      return { block: false, terminate: false };
    });
    api.on("tool_result", (event) => ({
      content: [...event.content, { type: "text", text: ":one" }],
      details: { stage: 1 }
    }));
    api.on("tool_result", () => { throw new Error("result boom"); });
    api.on("tool_result", (event) => ({
      content: [...event.content, { type: "text", text: ":two" }],
      isError: true
    }));
  };\n`;
  const { host } = await fixture(context, [mutating]);
  const target = { threadId: "thread-authoring", runId: "run-authoring", branch: "main" };
  const allowed = await host.reduceToolCall({ ...target, callId: "call-1", name: "write", input: { path: "ok" }, index: 0 });
  assert.deepEqual(allowed, {
    invocation: { ...target, callId: "call-1", name: "write", input: { path: "safe/ok" }, index: 0 },
    blocked: false,
    transformations: [{ actor: "extension-0" }],
  });
  const blocked = await host.reduceToolCall({ ...target, callId: "call-2", name: "write", input: { path: "blocked" }, index: 1 });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, "protected");
  assert.equal(blocked.terminate, true);
  assert.deepEqual(blocked.invocation.input, { path: "safe/blocked" });
  assert.equal((globalThis as Record<string, unknown>).__authoringLaterToolListenerRan, undefined);
  const ignored = await host.reduceToolCall({ ...target, callId: "call-ignored", name: "write", input: { path: "ignored" }, index: 2 });
  assert.equal(ignored.blocked, false);
  assert.equal("terminate" in ignored, false);
  delete (globalThis as Record<string, unknown>).__authoringLaterToolListenerRan;
  const result = await host.reduceToolResult({
    ...target,
    invocation: allowed.invocation,
    result: { content: "base", isError: false },
  });
  assert.deepEqual(result, {
    content: "base:one:two",
    contentBlocks: [
      { type: "text", text: "base" },
      { type: "text", text: ":one" },
      { type: "text", text: ":two" },
    ],
    isError: true,
    metadata: { stage: 1 },
  });
  assert.ok(host.diagnostics().some((entry) => entry.message.includes("result boom")));
  await host.close();

  const throwing = `export default (api) => {
    api.on("tool_call", (event) => { event.input.checked = true; throw new Error("preflight boom"); });
    api.on("tool_call", () => { globalThis.__authoringUnsafeToolContinued = true; });
  };\n`;
  const failed = await fixture(context, [throwing]);
  await assert.rejects(
    failed.host.reduceToolCall({ ...target, callId: "call-3", name: "bash", input: {}, index: 0 }),
    /preflight boom/u,
  );
  assert.equal((globalThis as Record<string, unknown>).__authoringUnsafeToolContinued, undefined);
  await failed.host.close();

  const invalid = await fixture(context, [`export default (api) => {
    api.on("tool_call", () => ({ block: true, terminate: "yes" }));
  };\n`]);
  await assert.rejects(
    invalid.host.reduceToolCall({ ...target, callId: "call-4", name: "bash", input: {}, index: 0 }),
    /terminate must be boolean/u,
  );
  await invalid.host.close();
});

test("tool reducer JSON mutations reject custom serializers and oversized values without invoking hooks", async (context) => {
  const source = `export default (api) => {
    api.on("tool_call", (event) => {
      const mode = globalThis.__authoringToolBoundaryMode;
      if (mode === "input-prototype") {
        event.input = Object.assign(Object.create({
          toJSON() {
            globalThis.__authoringToolBoundaryToJson += 1;
            return { rewritten: true };
          }
        }), { original: true });
      } else if (mode === "input-oversized") {
        event.input = { value: "x".repeat(11534337) };
      }
    });
    api.on("tool_result", () => {
      const mode = globalThis.__authoringToolBoundaryMode;
      if (mode === "details-prototype") {
        return { details: Object.assign(Object.create({
          toJSON() {
            globalThis.__authoringToolBoundaryToJson += 1;
            return { rewritten: true };
          }
        }), { original: true }) };
      }
      if (mode === "details-oversized") return { details: { value: "x".repeat(16385) } };
    });
  };\n`;
  const { host } = await fixture(context, [source]);
  const globals = globalThis as Record<string, unknown>;
  globals.__authoringToolBoundaryToJson = 0;
  const target = { threadId: "thread-boundary", runId: "run-boundary", branch: "main" };

  globals.__authoringToolBoundaryMode = "input-prototype";
  await assert.rejects(
    host.reduceToolCall({ ...target, callId: "prototype", name: "write", input: {}, index: 0 }),
    /plain objects and (?:vanilla )?arrays/u,
  );
  globals.__authoringToolBoundaryMode = "input-oversized";
  await assert.rejects(
    host.reduceToolCall({ ...target, callId: "oversized", name: "write", input: {}, index: 1 }),
    /exceeds 11534336 (?:UTF-8 )?bytes/u,
  );

  for (const mode of ["details-prototype", "details-oversized"]) {
    globals.__authoringToolBoundaryMode = mode;
    const diagnosticsBefore = host.diagnostics().length;
    const reduced = await host.reduceToolResult({
      ...target,
      invocation: { callId: mode, name: "write", input: {}, index: 0 },
      result: { content: "original", isError: false, metadata: { kept: true } },
    });
    assert.deepEqual(reduced.metadata, { kept: true });
    assert.equal(host.diagnostics().length, diagnosticsBefore + 1);
  }
  assert.equal(globals.__authoringToolBoundaryToJson, 0);

  delete globals.__authoringToolBoundaryMode;
  delete globals.__authoringToolBoundaryToJson;
  await host.close();
});

test("session and compaction reducers cancel deterministically and accept bounded custom summaries", async (context) => {
  const source = `export default (api) => {
    api.on("session_before_switch", () => ({}));
    api.on("session_before_switch", () => ({ cancel: true, reason: "extension switch policy" }));
    api.on("session_before_switch", () => { globalThis.__authoringSwitchContinued = true; });
    api.on("session_before_fork", () => ({ cancel: true, reason: "extension fork policy" }));
    api.on("session_before_tree", (event) => {
      event.preparation.entriesToSummarize.push({ type: "custom", id: "listener-only", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", customType: "listener-only" });
      return event.preparation.userWantsSummary ? {
        summary: { summary: "tree summary", details: { count: event.preparation.entriesToSummarize.length } },
        customInstructions: "extension focus",
        replaceInstructions: true,
        label: "extension label",
      } : undefined;
    });
    api.on("session_before_tree", (event) => {
      globalThis.__authoringTreeCloneLength = event.preparation.entriesToSummarize.length;
      return globalThis.__authoringTreeLabelOnly ? { label: "last label" } : undefined;
    });
    api.on("session_before_tree", () => globalThis.__authoringInvalidTree ? { replaceInstructions: "yes" } : undefined);
    api.on("session_before_compact", (event) => {
      globalThis.__authoringCompactMaxInputTokens = event.preparation.settings.maxInputTokens;
      event.preparation.settings.maxInputTokens = 1;
      return { compaction: {
        summary: "compact:" + event.reason,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: { source: event.preparation.messagesToSummarize.length }
      } };
    });
  };\n`;
  const { host } = await fixture(context, [source]);
  assert.deepEqual(await host.reduceSessionBeforeSwitch({ reason: "new" }), {
    cancel: true,
    reason: "extension switch policy",
  });
  assert.equal((globalThis as Record<string, unknown>).__authoringSwitchContinued, undefined);
  assert.deepEqual(await host.reduceSessionBeforeFork({ sourceThreadId: "thread-1", position: "at" }), {
    cancel: true,
    reason: "extension fork policy",
  });
  assert.deepEqual(await host.reduceSessionBeforeTree({
    preparation: {
      targetId: "event-2",
      oldLeafId: "event-1",
      commonAncestorId: null,
      entriesToSummarize: [],
      userWantsSummary: true,
    },
    signal: new AbortController().signal,
  }), {
    summary: { summary: "tree summary", details: { count: 1 } },
    customInstructions: "extension focus",
    replaceInstructions: true,
    label: "extension label",
  });
  assert.equal((globalThis as Record<string, unknown>).__authoringTreeCloneLength, 1);
  (globalThis as Record<string, unknown>).__authoringTreeLabelOnly = true;
  assert.deepEqual(await host.reduceSessionBeforeTree({
    preparation: {
      targetId: "event-2",
      oldLeafId: "event-1",
      commonAncestorId: null,
      entriesToSummarize: [],
      userWantsSummary: true,
    },
    signal: new AbortController().signal,
  }), { label: "last label" });
  delete (globalThis as Record<string, unknown>).__authoringTreeLabelOnly;
  (globalThis as Record<string, unknown>).__authoringInvalidTree = true;
  const validAfterInvalid = await host.reduceSessionBeforeTree({
    preparation: {
      targetId: "event-2",
      oldLeafId: "event-1",
      commonAncestorId: null,
      entriesToSummarize: [],
      userWantsSummary: true,
    },
    signal: new AbortController().signal,
  });
  delete (globalThis as Record<string, unknown>).__authoringInvalidTree;
  delete (globalThis as Record<string, unknown>).__authoringTreeCloneLength;
  assert.equal(validAfterInvalid.replaceInstructions, true);
  assert.ok(host.diagnostics().some((entry) => entry.message.includes("replaceInstructions must be a boolean")));
  const compactionEvent = {
    preparation: {
      firstKeptEntryId: "source-entry",
      messagesToSummarize: [message("source", "user", "source")],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 120,
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 20, recentTokens: 20, maxInputTokens: 100 },
    },
    branchEntries: [],
    customInstructions: "focus",
    reason: "manual" as const,
    willRetry: false,
    signal: new AbortController().signal,
  } satisfies RuntimeSessionBeforeCompactEvent;
  assert.deepEqual(await host.reduceSessionBeforeCompact(compactionEvent), {
    compaction: {
      summary: "compact:manual",
      firstKeptEntryId: "source-entry",
      tokensBefore: 120,
      details: { source: 1 },
    },
  });
  assert.equal((globalThis as Record<string, unknown>).__authoringCompactMaxInputTokens, 100);
  assert.equal(compactionEvent.preparation.settings.maxInputTokens, 100);
  delete (globalThis as Record<string, unknown>).__authoringCompactMaxInputTokens;
  await host.close();
});

test("malformed session switch and fork guards fail closed without changing thrown-handler isolation", async (context) => {
  const source = `export default (api) => {
    for (const event of ["session_before_switch", "session_before_fork"]) {
      api.on(event, () => {
        const result = globalThis.__authoringGuardResults[event];
        if (result === "throw") throw new Error("ordinary guard failure");
        return result;
      });
      api.on(event, () => {
        globalThis.__authoringGuardLater[event] += 1;
        return { cancel: false };
      });
    }
  };\n`;
  const { host } = await fixture(context, [source]);
  const globals = globalThis as Record<string, unknown>;
  const results: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const later: Record<string, number> = {
    session_before_switch: 0,
    session_before_fork: 0,
  };
  globals.__authoringGuardResults = results;
  globals.__authoringGuardLater = later;

  const invocations = {
    session_before_switch: async () => await host.reduceSessionBeforeSwitch({ reason: "new" }),
    session_before_fork: async () => await host.reduceSessionBeforeFork({ sourceThreadId: "thread-1", position: "at" }),
  } as const;
  const invalid = [
    { value: { cancel: "yes" }, diagnostic: /cancel must be a boolean/u },
    { value: { reason: 42 }, diagnostic: /reason must be a string/u },
    { value: { cancel: false, ownerControlled: true }, diagnostic: /unknown or owner-controlled field/u },
  ];
  for (const event of Object.keys(invocations) as Array<keyof typeof invocations>) {
    for (const selected of invalid) {
      results[event] = selected.value;
      const diagnosticsBefore = host.diagnostics().length;
      assert.deepEqual(await invocations[event](), { cancel: true });
      assert.equal(later[event], 0);
      assert.match(host.diagnostics()[diagnosticsBefore]?.message ?? "", selected.diagnostic);
    }

    let proxyTraps = 0;
    results[event] = new Proxy({}, {
      getPrototypeOf() {
        proxyTraps += 1;
        throw new Error("proxy trap must not run");
      },
    });
    const proxyDiagnosticsBefore = host.diagnostics().length;
    assert.deepEqual(await invocations[event](), { cancel: true });
    assert.equal(later[event], 0);
    assert.equal(proxyTraps, 0);
    assert.match(host.diagnostics()[proxyDiagnosticsBefore]?.message ?? "", /plain object/u);

    results[event] = "throw";
    const diagnosticsBefore = host.diagnostics().length;
    assert.deepEqual(await invocations[event](), { cancel: false });
    assert.equal(later[event], 1);
    assert.match(host.diagnostics()[diagnosticsBefore]?.message ?? "", /ordinary guard failure/u);
  }

  delete globals.__authoringGuardResults;
  delete globals.__authoringGuardLater;
  await host.close();
});

test("tree and compaction reducers reject non-data result shapes before invoking extension accessors", async (context) => {
  const source = `export default (api) => {
    const malformed = (mode, nested) => {
      const kind = mode.replace("nested-", "");
      const required = nested
        ? { summary: "invalid", firstKeptEntryId: "source-entry", tokensBefore: 120 }
        : {};
      if (kind === "unknown") return { ...required, ownerControlled: true };
      if (kind === "prototype") {
        return Object.assign(Object.create({
          toJSON() {
            globalThis.__authoringShapeToJson += 1;
            return required;
          }
        }), required, nested ? {} : { cancel: false });
      }
      if (kind === "details-prototype") {
        return {
          ...required,
          details: Object.assign(Object.create({
            toJSON() {
              globalThis.__authoringShapeToJson += 1;
              return { rewritten: true };
            }
          }), { original: true })
        };
      }
      if (kind === "details-accessor") {
        const details = {};
        Object.defineProperty(details, "value", {
          enumerable: true,
          get() {
            globalThis.__authoringShapeGetter += 1;
            return "must-not-run";
          }
        });
        return { ...required, details };
      }
      if (kind === "details-oversized") {
        return { ...required, details: { value: "x".repeat(65536) } };
      }
      const result = { ...required };
      Object.defineProperty(result, nested ? "summary" : "cancel", {
        enumerable: true,
        get() {
          globalThis.__authoringShapeGetter += 1;
          return nested ? "invalid" : false;
        }
      });
      return result;
    };
    api.on("session_before_tree", () => {
      const mode = globalThis.__authoringGuardShapeMode.session_before_tree;
      const value = malformed(mode, mode.startsWith("nested-"));
      return mode.startsWith("nested-") ? { summary: value } : value;
    });
    api.on("session_before_tree", () => {
      globalThis.__authoringShapeLater.session_before_tree += 1;
      return { label: "valid-tree" };
    });
    api.on("session_before_compact", () => {
      const mode = globalThis.__authoringGuardShapeMode.session_before_compact;
      const value = malformed(mode, mode.startsWith("nested-"));
      return mode.startsWith("nested-") ? { compaction: value } : value;
    });
    api.on("session_before_compact", () => {
      globalThis.__authoringShapeLater.session_before_compact += 1;
      return { compaction: {
        summary: "valid-compact",
        firstKeptEntryId: "source-entry",
        tokensBefore: 120
      } };
    });
  };\n`;
  const { host } = await fixture(context, [source]);
  const globals = globalThis as Record<string, unknown>;
  const modes: Record<string, string> = Object.create(null) as Record<string, string>;
  const later: Record<string, number> = {
    session_before_tree: 0,
    session_before_compact: 0,
  };
  globals.__authoringGuardShapeMode = modes;
  globals.__authoringShapeLater = later;
  globals.__authoringShapeGetter = 0;
  globals.__authoringShapeToJson = 0;
  const treeEvent = {
    preparation: {
      targetId: "event-2",
      oldLeafId: "event-1",
      commonAncestorId: null,
      entriesToSummarize: [],
      userWantsSummary: true,
    },
    signal: new AbortController().signal,
  };
  const compactEvent = {
    preparation: {
      firstKeptEntryId: "source-entry",
      messagesToSummarize: [message("source", "user", "source")],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 120,
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 20, recentTokens: 20, maxInputTokens: 100 },
    },
    branchEntries: [],
    reason: "manual" as const,
    willRetry: false,
    signal: new AbortController().signal,
  } satisfies RuntimeSessionBeforeCompactEvent;
  const invocations = {
    session_before_tree: async () => await host.reduceSessionBeforeTree(treeEvent),
    session_before_compact: async () => await host.reduceSessionBeforeCompact(compactEvent),
  } as const;
  const expected = {
    session_before_tree: { label: "valid-tree" },
    session_before_compact: {
      compaction: { summary: "valid-compact", firstKeptEntryId: "source-entry", tokensBefore: 120 },
    },
  } as const;

  for (const event of Object.keys(invocations) as Array<keyof typeof invocations>) {
    for (const mode of [
      "unknown",
      "prototype",
      "accessor",
      "nested-unknown",
      "nested-prototype",
      "nested-accessor",
      "nested-details-prototype",
      "nested-details-accessor",
      "nested-details-oversized",
    ]) {
      modes[event] = mode;
      const diagnosticsBefore = host.diagnostics().length;
      const laterBefore = later[event]!;
      assert.deepEqual(await invocations[event](), expected[event]);
      assert.equal(later[event], laterBefore + 1);
      assert.equal(host.diagnostics().length, diagnosticsBefore + 1);
    }
    assert.equal(later[event], 9);
  }
  assert.equal(globals.__authoringShapeGetter, 0);
  assert.equal(globals.__authoringShapeToJson, 0);

  delete globals.__authoringGuardShapeMode;
  delete globals.__authoringShapeLater;
  delete globals.__authoringShapeGetter;
  delete globals.__authoringShapeToJson;
  await host.close();
});

test("invalid authoring registrations fail transactionally without suppressing later extensions", async (context) => {
  const invalid = `export default (api) => {
    api.registerCommand("must-not-commit", { handler() {} });
    api.registerFlag("bad", { type: "boolean", default: "wrong" });
  };\n`;
  const valid = `export default (api) => {
    api.registerShortcut("ctrl+k", { handler() {} });
    api.registerFlag("valid", { type: "string", default: "yes" });
  };\n`;
  const { host } = await fixture(context, [invalid, valid]);
  assert.equal(host.hasCommand("must-not-commit"), false);
  assert.deepEqual(host.flags().map((entry) => entry.name), ["valid"]);
  assert.deepEqual(host.shortcuts().map((entry) => entry.shortcut), ["ctrl+k"]);
  assert.match(host.diagnostics()[0]?.message ?? "", /default must be boolean/u);
  await host.close();
});

test("command, completion, and shortcut failures are diagnostic and do not escape the host", async (context) => {
  const source = `export default (api) => {
    api.registerCommand("broken-command", {
      getArgumentCompletions() { throw new Error("completion boom"); },
      handler() { throw new Error("command boom"); }
    });
    api.registerShortcut("ctrl+q", { handler() { throw new Error("shortcut boom"); } });
  };\n`;
  const { host } = await fixture(context, [source]);
  assert.deepEqual(await host.runCommand("broken-command", { ...commandContext(), args: "" }), { handled: true });
  assert.equal(await host.completeCommandArguments("broken-command", ""), null);
  assert.deepEqual(await host.runShortcut("ctrl+q", commandContext()), { handled: true });
  assert.ok(host.diagnostics().some((entry) => entry.message.includes("command boom")));
  assert.ok(host.diagnostics().some((entry) => entry.message.includes("completion boom")));
  assert.ok(host.diagnostics().some((entry) => entry.message.includes("shortcut boom")));
  await host.close();
});

test("shared events are disposable and generation-bound", async (context) => {
  const receiver = `export default (api) => {
    globalThis.__authoringSharedDispose = api.events.on("dashboard.update", async (payload) => {
      await Promise.resolve();
      globalThis.__authoringShared = payload;
    });
  };\n`;
  const sender = `export default (api) => { globalThis.__authoringSharedApi = api; };\n`;
  const { host } = await fixture(context, [receiver, sender]);
  const api = (globalThis as Record<string, any>).__authoringSharedApi;

  api.events.emit("dashboard.update", { state: "ready" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual((globalThis as Record<string, unknown>).__authoringShared, { state: "ready" });
  const dispose = (globalThis as Record<string, unknown>).__authoringSharedDispose;
  if (typeof dispose !== "function") throw new Error("shared event disposer was not captured");
  dispose();
  api.events.emit("dashboard.update", { state: "disposed" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual((globalThis as Record<string, unknown>).__authoringShared, { state: "ready" });
  await host.close();
  assert.throws(() => api.events.emit("dashboard.update", null), /no longer active/u);
  await assert.rejects(api.exec(process.execPath, []), /no longer active/u);
  delete (globalThis as Record<string, unknown>).__authoringShared;
  delete (globalThis as Record<string, unknown>).__authoringSharedApi;
  delete (globalThis as Record<string, unknown>).__authoringSharedDispose;
});
