import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  type RuntimeCommandContext,
  type RuntimeSessionBeforeCompactEvent,
} from "../../src/extensions/runtime.js";
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
    async reload() {},
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
      globalThis.__listenerHostContext = {
        mode: context.mode,
        hasUI: context.hasUI,
        trusted: context.isProjectTrusted()
      };
    });
    api.registerCommand("host-context", {
      handler(_args, context) {
        globalThis.__commandHostContext = {
          mode: context.mode,
          hasUI: context.hasUI,
          trusted: context.isProjectTrusted()
        };
      }
    });
    api.registerShortcut("ctrl+alt+h", {
      handler(context) {
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
  assert.deepEqual((globalThis as Record<string, unknown>).__nativeToolContext, {
    hasUI: false,
    mode: "print",
  });
  assert.deepEqual((globalThis as Record<string, unknown>).__listenerHostContext, {
    mode: "print", hasUI: false, trusted: false,
  });
  assert.deepEqual((globalThis as Record<string, unknown>).__commandHostContext, {
    mode: "print", hasUI: false, trusted: false,
  });
  assert.deepEqual((globalThis as Record<string, unknown>).__shortcutHostContext, {
    mode: "print", hasUI: false, trusted: false,
  });
  assert.equal(host.initialUi().some((entry) => entry.type === "notify" && entry.value === "tool context print"), true);

  const owners: string[] = [];
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
    mode: "tui", hasUI: true, trusted: true,
  });
  assert.deepEqual((globalThis as Record<string, unknown>).__commandHostContext, {
    mode: "tui", hasUI: true, trusted: true,
  });
  assert.deepEqual(owners, ["extension-0", "extension-0", "extension-0"]);
  await host.close();
  delete (globalThis as Record<string, unknown>).__nativeToolContext;
  delete (globalThis as Record<string, unknown>).__listenerHostContext;
  delete (globalThis as Record<string, unknown>).__commandHostContext;
  delete (globalThis as Record<string, unknown>).__shortcutHostContext;
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
  const first = `export default (api) => {
    api.registerTool({ name: "same_id_tool", label: "Same", description: "first source", parameters: { type: "object" }, async execute() { return { content: [{ type: "text", text: "first" }], details: {} }; } });
  };\n`;
  const second = `export default (api) => {
    api.registerTool({ name: "same_id_tool", label: "Same", description: "second source", parameters: { type: "object" }, async execute() { return { content: [{ type: "text", text: "second" }], details: {} }; } });
  };\n`;
  const firstPath = join(root, "first.mjs");
  const secondPath = join(root, "second.mjs");
  await Promise.all([
    writeFile(firstPath, first),
    writeFile(secondPath, second),
  ]);
  const host = await loadTestDirectExtensions([
    { extensionId: "shared.extension", sourcePath: firstPath, sha256: sha256(first) },
    { extensionId: "shared.extension", sourcePath: secondPath, sha256: sha256(second) },
  ], { workspace: root });
  try {
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
    api.on("tool_call", (event) => event.input.path === "safe/blocked" ? { block: true, reason: "protected" } : undefined);
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
  assert.deepEqual(blocked.invocation.input, { path: "safe/blocked" });
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
});

test("session and compaction reducers cancel deterministically and accept bounded custom summaries", async (context) => {
  const source = `export default (api) => {
    api.on("session_before_switch", () => ({}));
    api.on("session_before_switch", () => ({ cancel: true }));
    api.on("session_before_switch", () => { globalThis.__authoringSwitchContinued = true; });
    api.on("session_before_fork", () => ({ cancel: false }));
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
    api.on("session_before_compact", (event) => ({ compaction: {
      summary: "compact:" + event.reason,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      details: { source: event.preparation.messagesToSummarize.length }
    } }));
  };\n`;
  const { host } = await fixture(context, [source]);
  assert.deepEqual(await host.reduceSessionBeforeSwitch({ reason: "new" }), { cancel: true });
  assert.equal((globalThis as Record<string, unknown>).__authoringSwitchContinued, undefined);
  assert.deepEqual(await host.reduceSessionBeforeFork({ sourceThreadId: "thread-1", position: "at" }), { cancel: false });
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
      settings: { enabled: true, reserveTokens: 20, keepRecentTokens: 20 },
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
