import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSyntheticSourceInfo } from "../../src/core/source-info.js";
import {
  attachExtensionRuntimeHost,
  createExtensionRuntime,
  ExtensionRunner,
  getExtensionRuntimeHost,
} from "../../src/extensions/compat-runtime.js";
import { projectLoadedExtensionHost } from "../../src/extensions/compat.js";
import type { Extension, ExtensionActions, ExtensionContextActions } from "../../src/extensions/direct.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import { createModels } from "../../src/providers/models.js";
import { SessionManager } from "../../src/storage/session-manager.js";

const roots = new Set<string>();

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-compat-runtime-"));
  roots.add(cwd);
  return cwd;
}

test.afterEach(async () => {
  await Promise.all([...roots].map(async (root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

function extension(path: string): Extension {
  return {
    path,
    resolvedPath: path,
    sourceInfo: createSyntheticSourceInfo(path, { source: "test" }),
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

function on(
  selected: Extension,
  event: string,
  handler: (...args: unknown[]) => unknown | Promise<unknown>,
): void {
  const handlers = selected.handlers.get(event) ?? [];
  handlers.push(async (...args) => await handler(...args));
  selected.handlers.set(event, handlers);
}

function command(selected: Extension, name: string) {
  return {
    name,
    sourceInfo: selected.sourceInfo,
    async handler() {},
  };
}

function actions(): ExtensionActions {
  return {
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName: () => undefined,
    setLabel() {},
    getActiveTools: () => ["read"],
    getAllTools: () => [],
    setActiveTools() {},
    refreshTools() {},
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => "off",
    setThinkingLevel() {},
  };
}

function contextActions(): ExtensionContextActions {
  return {
    getModel: () => undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => "system",
  };
}

test("zero-argument runtime preserves pre-bind actions, provider queues, and staleness", async () => {
  const runtime = createExtensionRuntime();
  assert.equal(getExtensionRuntimeHost(runtime), undefined);
  assert.throws(() => runtime.getActiveTools(), /before the session host is bound/u);
  await assert.rejects(runtime.setModel({} as never), /before the session host is bound/u);
  assert.doesNotThrow(() => runtime.refreshTools());

  runtime.registerProvider("queued", {}, "/queued.ts");
  assert.deepEqual(runtime.pendingProviderRegistrations, [{ name: "queued", config: {}, extensionPath: "/queued.ts" }]);
  runtime.unregisterProvider("queued");
  assert.deepEqual(runtime.pendingProviderRegistrations, []);

  runtime.invalidate("stale test runtime");
  assert.throws(() => runtime.getCommands(), /stale test runtime/u);
});

test("five-argument runner binds actions and keeps projection resolution deterministic", async () => {
  const cwd = await workspace();
  const runtime = createExtensionRuntime();
  const first = extension("/first.ts");
  const second = extension("/second.ts");
  first.flags.set("mode", {
    name: "mode",
    type: "string",
    default: "first",
    extensionPath: first.path,
  });
  second.flags.set("mode", {
    name: "mode",
    type: "string",
    default: "second",
    extensionPath: second.path,
  });
  const command = (owner: Extension, description: string) => ({
    name: "probe",
    description,
    sourceInfo: owner.sourceInfo,
    async handler() {},
  });
  first.commands.set("probe", command(first, "first"));
  second.commands.set("probe", command(second, "second"));

  runtime.registerProvider("queued", {}, first.path);
  const registered: string[] = [];
  const runner = new ExtensionRunner(
    [first, second],
    runtime,
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  runner.bindCore(actions(), contextActions(), {
    registerProvider(name) { registered.push(name); },
  });

  assert.deepEqual(registered, ["queued"]);
  assert.deepEqual(runner.getActiveTools(), ["read"]);
  assert.equal(runner.createContext().getSystemPrompt(), "system");
  assert.equal(runner.getFlags().get("mode")?.default, "first");
  assert.deepEqual(runner.getRegisteredCommands().map((entry) => entry.invocationName), ["probe:1", "probe:2"]);

  const failures: string[] = [];
  const unsubscribe = runner.onError((error) => failures.push(error.error));
  runner.emitError({ extensionPath: first.path, event: "probe", error: "failure" });
  unsubscribe();
  assert.deepEqual(failures, ["failure"]);

  const context = runner.createContext();
  runner.invalidate("stale runner");
  assert.throws(() => context.isIdle(), /stale runner/u);
});

test("command resolution terminates through nested invocation-name collisions", async () => {
  const cwd = await workspace();
  const selected = extension("/commands.ts");
  selected.commands.set("first", command(selected, "probe"));
  selected.commands.set("second", command(selected, "probe"));
  selected.commands.set("nested", command(selected, "probe:1:2"));
  selected.commands.set("literal", command(selected, "probe:1"));
  const runner = new ExtensionRunner(
    [selected],
    createExtensionRuntime(),
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );

  assert.deepEqual(runner.getRegisteredCommands().map((entry) => entry.invocationName), [
    "probe:1",
    "probe:2",
    "probe:1:2",
    "probe:1:3",
  ]);
});

test("shortcut conflicts are deterministic and visible without an interactive UI", async () => {
  const cwd = await workspace();
  const first = extension("/first.ts");
  const second = extension("/second.ts");
  first.shortcuts.set("ctrl+d" as never, {
    shortcut: "ctrl+d" as never,
    extensionPath: first.path,
    handler() {},
  });
  first.shortcuts.set("alt+x" as never, {
    shortcut: "alt+x" as never,
    extensionPath: first.path,
    handler() {},
  });
  second.shortcuts.set("alt+x" as never, {
    shortcut: "alt+x" as never,
    extensionPath: second.path,
    handler() {},
  });
  const runner = new ExtensionRunner(
    [first, second],
    createExtensionRuntime(),
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message) => { warnings.push(String(message)); };
  try {
    const shortcuts = runner.getShortcuts({ "app.exit": "ctrl+d", "custom.open": "alt+x" } as never);
    assert.equal(shortcuts.get("alt+x" as never)?.extensionPath, second.path);
    assert.equal(shortcuts.has("ctrl+d" as never), false);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, [
    "Extension shortcut 'ctrl+d' from /first.ts conflicts with built-in shortcut. Skipping.",
    "Extension shortcut conflict: 'alt+x' is built-in shortcut for custom.open and /first.ts. Using /first.ts.",
    "Extension shortcut conflict: 'alt+x' is built-in shortcut for custom.open and /second.ts. Using /second.ts.",
    "Extension shortcut conflict: 'alt+x' registered by both /first.ts and /second.ts. Using /second.ts.",
  ]);
  assert.deepEqual(runner.getShortcutDiagnostics().map((entry) => entry.message), warnings);
});

test("standalone projections reduce generic guards and isolate handler failures", async () => {
  const cwd = await workspace();
  const selected = extension("/standalone.ts");
  const observed: string[] = [];
  on(selected, "session_before_switch", () => ({ cancel: false }));
  on(selected, "session_before_switch", () => { throw new Error("guard failed"); });
  on(selected, "session_before_switch", () => ({ cancel: true }));
  on(selected, "session_before_switch", () => { observed.push("after cancel"); });
  const runner = new ExtensionRunner(
    [selected],
    createExtensionRuntime(),
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  const errors: Array<{ event: string; error: string }> = [];
  runner.onError((entry) => errors.push({ event: entry.event, error: entry.error }));

  assert.equal(runner.hasHandlers("session_before_switch"), true);
  assert.deepEqual(await runner.emit({ type: "session_before_switch", reason: "new" }), { cancel: true });
  assert.deepEqual(observed, []);
  assert.deepEqual(errors, [{ event: "session_before_switch", error: "guard failed" }]);
});

test("standalone projection reducers chain payloads, prompts, input, and resources", async () => {
  const cwd = await workspace();
  const first = extension("/first.ts");
  const second = extension("/second.ts");
  const seenPrompts: string[] = [];
  on(first, "before_provider_request", (raw) => {
    const event = raw as { payload: { count: number } };
    return { count: event.payload.count + 1 };
  });
  on(second, "before_provider_request", (raw) => {
    const event = raw as { payload: { count: number } };
    return { count: event.payload.count + 1 };
  });
  on(first, "before_provider_headers", (raw) => {
    (raw as { headers: Record<string, string | null> }).headers["x-first"] = "yes";
  });
  on(first, "before_agent_start", (_event, rawContext) => {
    const context = rawContext as { getSystemPrompt(): string };
    seenPrompts.push(context.getSystemPrompt());
    return { systemPrompt: "second", message: { customType: "notice", content: "one", display: true } };
  });
  on(second, "before_agent_start", (_event, rawContext) => {
    const context = rawContext as { getSystemPrompt(): string };
    seenPrompts.push(context.getSystemPrompt());
    return { systemPrompt: "third" };
  });
  on(first, "resources_discover", () => ({ skillPaths: ["skill.md"], promptPaths: ["prompt.md"] }));
  on(second, "resources_discover", () => ({ themePaths: ["theme.json"] }));
  on(first, "input", (raw) => {
    const event = raw as { text: string };
    return { action: "transform", text: `${event.text}-first` };
  });
  on(second, "input", (raw) => {
    const event = raw as { text: string };
    return { action: "transform", text: `${event.text}-second` };
  });
  const runner = new ExtensionRunner(
    [first, second],
    createExtensionRuntime(),
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );

  assert.deepEqual(await runner.emitBeforeProviderRequest({ count: 0 }), { count: 2 });
  assert.deepEqual(await runner.emitBeforeProviderHeaders({ authorization: null }), {
    authorization: null,
    "x-first": "yes",
  });
  assert.deepEqual(await runner.emitBeforeAgentStart("hello", undefined, "first", { cwd }), {
    messages: [{ customType: "notice", content: "one", display: true }],
    systemPrompt: "third",
  });
  assert.deepEqual(seenPrompts, ["first", "second"]);
  assert.deepEqual(await runner.emitResourcesDiscover(cwd, "startup"), {
    skillPaths: [{ path: "skill.md", extensionPath: first.path }],
    promptPaths: [{ path: "prompt.md", extensionPath: first.path }],
    themePaths: [{ path: "theme.json", extensionPath: second.path }],
  });
  assert.deepEqual(await runner.emitInput("start", undefined, "interactive"), {
    action: "transform",
    text: "start-first-second",
  });
});

test("standalone message, context, tool, and shell reducers preserve their contracts", async () => {
  const cwd = await workspace();
  const selected = extension("/reducers.ts");
  const errors: Array<{ event: string; error: string }> = [];
  on(selected, "message_end", (raw) => ({ message: (raw as { message: unknown }).message }));
  on(selected, "context", (raw) => {
    const event = raw as { messages: Array<{ content: string }> };
    event.messages[0]!.content = "changed";
    return { messages: event.messages };
  });
  on(selected, "tool_result", () => ({
    content: [{ type: "text", text: "replacement" }],
    isError: true,
  }));
  on(selected, "tool_call", () => ({ block: false }));
  on(selected, "tool_call", () => ({ block: true, reason: "blocked" }));
  on(selected, "user_bash", () => ({
    result: { output: "handled", exitCode: 0, cancelled: false, truncated: false },
  }));
  const runner = new ExtensionRunner(
    [selected],
    createExtensionRuntime(),
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  runner.onError((entry) => errors.push({ event: entry.event, error: entry.error }));
  const message = { role: "user", content: "original", timestamp: 1 } as never;
  const messages = [message] as never;

  assert.equal(await runner.emitMessageEnd({ type: "message_end", message }), message);
  assert.deepEqual(await runner.emitContext(messages), [{ role: "user", content: "changed", timestamp: 1 }]);
  assert.equal((messages as Array<{ content: string }>)[0]?.content, "original");
  assert.deepEqual(await runner.emitToolResult({
    type: "tool_result",
    toolCallId: "call-1",
    toolName: "custom",
    input: {},
    content: [{ type: "text", text: "initial" }],
    details: undefined,
    isError: false,
  }), {
    content: [{ type: "text", text: "replacement" }],
    details: undefined,
    isError: true,
  });
  assert.deepEqual(await runner.emitToolCall({
    type: "tool_call",
    toolCallId: "call-1",
    toolName: "custom",
    input: {},
  }), { block: true, reason: "blocked" });
  assert.deepEqual(await runner.emitUserBash({
    type: "user_bash",
    command: "true",
    cwd,
    excludeFromContext: false,
  }), { result: { output: "handled", exitCode: 0, cancelled: false, truncated: false } });
  assert.deepEqual(errors, []);
});

test("runner dispatches through the attached native host instead of a second listener registry", async () => {
  const cwd = await workspace();
  const observed: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    inlineExtensions: [{
      name: "compat-observer",
      factory(api) {
        api.on("session_start", (event) => { observed.push(`start:${event.reason}`); });
        api.on("before_provider_request", (event) => ({ ...event.payload as object, tagged: true }));
        api.on("input", (event) => ({ action: "transform", text: event.text.toUpperCase() }));
      },
    }],
  });
  const runtime = createExtensionRuntime();
  attachExtensionRuntimeHost(runtime, host);
  const runner = new ExtensionRunner(
    [],
    runtime,
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );

  await runner.emit({ type: "session_start", reason: "startup" });
  assert.deepEqual(observed, ["start:startup"]);
  assert.deepEqual(await runner.emitBeforeProviderRequest({ prompt: "hello" }), { prompt: "hello", tagged: true });
  assert.deepEqual(await runner.emitInput("hello", undefined, "interactive"), {
    action: "transform",
    text: "HELLO",
  });
  await host.close();
});

test("standalone runner binds native actions, context, commands, exec, and no-op UI", async () => {
  const cwd = await workspace();
  const observed: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    inlineExtensions: [{
      name: "native-bridge",
      factory(api) {
        api.on("session_start", (_event, ctx) => {
          api.setSessionName("native-name");
          api.setActiveTools(["native-tool"]);
          observed.push(ctx.sessionManager.getSessionId(), ctx.getSystemPrompt(), ctx.ui.theme.name);
          ctx.ui.setFooter(() => ({}) as never);
          ctx.ui.setEditorComponent(() => ({}) as never);
        });
        api.on("session_shutdown", async () => {
          const result = await api.exec(process.execPath, ["-e", "process.stdout.write('native-exec')"]);
          observed.push(result.stdout);
        });
        api.registerCommand("native-command", {
          async handler(_args, ctx) { await ctx.reload(); },
        });
      },
    }],
  });
  const projected = projectLoadedExtensionHost(host);
  const session = SessionManager.inMemory(cwd);
  let sessionName: string | undefined;
  let activeTools: string[] = [];
  let reloads = 0;
  const runner = new ExtensionRunner(
    projected.extensions,
    projected.runtime,
    cwd,
    session,
    new ModelRegistry(createModels()),
  );
  runner.bindCore({
    ...actions(),
    setSessionName(name) { sessionName = name; },
    getSessionName: () => sessionName,
    getActiveTools: () => [...activeTools],
    setActiveTools(names) { activeTools = [...names]; },
  }, contextActions());
  runner.bindCommandContext({
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => { reloads += 1; },
  });

  const errors: string[] = [];
  runner.onError((entry) => errors.push(entry.error));
  await runner.emit({ type: "session_start", reason: "startup" });
  assert.equal(sessionName, "native-name");
  assert.deepEqual(activeTools, ["native-tool"]);
  assert.deepEqual(observed.slice(0, 3), [session.getSessionId(), "system", "mono"]);

  assert.deepEqual(await host.runCommand("native-command", {
    args: "",
    threadId: session.getSessionId(),
    branch: "main",
    signal: new AbortController().signal,
  }), { handled: true });
  assert.equal(reloads, 1);

  await runner.emit({ type: "session_shutdown", reason: "quit" });
  assert.equal(observed.at(-1), "native-exec");
  assert.deepEqual(errors, []);
  await host.close();
});

test("standalone defaults do not replace richer native actions bound after construction", async () => {
  const cwd = await workspace();
  const observed: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    inlineExtensions: [{
      name: "rich-actions",
      factory(api) {
        api.on("session_start", () => { observed.push(api.getSessionName() ?? "missing"); });
      },
    }],
  });
  const projected = projectLoadedExtensionHost(host);
  const runner = new ExtensionRunner(
    projected.extensions,
    projected.runtime,
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  host.setDirectActionsHandler({ getSessionName: () => "rich" } as never);
  runner.bindCore({ ...actions(), getSessionName: () => "public" }, contextActions());

  await runner.emit({ type: "session_start", reason: "startup" });
  assert.deepEqual(observed, ["rich"]);
  await host.close();
});

test("native lifecycle failures are isolated and reported through the public runner", async () => {
  const cwd = await workspace();
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    inlineExtensions: [{
      name: "failing-lifecycle",
      factory(api) {
        api.on("session_start", () => { throw new Error("start failed"); });
      },
    }],
  });
  const projected = projectLoadedExtensionHost(host);
  const runner = new ExtensionRunner(
    projected.extensions,
    projected.runtime,
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  runner.bindCore(actions(), contextActions());
  const errors: Array<{ event: string; error: string }> = [];
  runner.onError((entry) => errors.push({ event: entry.event, error: entry.error }));

  await assert.doesNotReject(runner.emit({ type: "session_start", reason: "startup" }));
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.event, "session_start");
  assert.match(errors[0]?.error ?? "", /start failed/u);
  await host.close();
});

test("native handler diagnostics retain their public event identity", async () => {
  const cwd = await workspace();
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    inlineExtensions: [{
      name: "failing-context",
      factory(api) {
        api.on("context", () => { throw new Error("context failed"); });
      },
    }],
  });
  const runtime = createExtensionRuntime();
  attachExtensionRuntimeHost(runtime, host);
  const runner = new ExtensionRunner(
    [],
    runtime,
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  const errors: Array<{ event: string; error: string }> = [];
  runner.onError((entry) => errors.push({ event: entry.event, error: entry.error }));

  assert.deepEqual(await runner.emitContext([]), []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.event, "context");
  assert.match(errors[0]?.error ?? "", /context failed/u);
  await host.close();
});

test("runner invalidation detaches native diagnostics once and stales captured contexts and actions", async () => {
  const cwd = await workspace();
  const host = await loadDirectExtensions([], { workspace: cwd });
  const subscribe = host.onError.bind(host);
  let unsubscribeCalls = 0;
  Object.defineProperty(host, "onError", {
    configurable: true,
    value(listener: Parameters<typeof host.onError>[0]) {
      const unsubscribe = subscribe(listener);
      return () => {
        unsubscribeCalls += 1;
        unsubscribe();
      };
    },
  });

  const runtime = createExtensionRuntime();
  attachExtensionRuntimeHost(runtime, host);
  const runner = new ExtensionRunner(
    [],
    runtime,
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(createModels()),
  );
  runner.bindCore(actions(), contextActions());
  runner.bindCommandContext();
  const context = runner.createContext();
  const commandContext = runner.createCommandContext();
  const getActiveTools = runtime.getActiveTools;
  const diagnostics: string[] = [];
  runner.onError((entry) => diagnostics.push(entry.error));

  host.addDiagnostic({ extensionId: "test", sourcePath: "/before.ts", message: "before invalidation" });
  assert.deepEqual(diagnostics, ["before invalidation"]);

  runner.invalidate("stale generation");
  runner.invalidate("ignored second invalidation");
  assert.equal(unsubscribeCalls, 1);

  host.addDiagnostic({ extensionId: "test", sourcePath: "/after.ts", message: "after invalidation" });
  assert.deepEqual(diagnostics, ["before invalidation"]);
  assert.throws(() => context.cwd, /stale generation/u);
  assert.throws(() => commandContext.cwd, /stale generation/u);
  assert.throws(() => commandContext.reload(), /stale generation/u);
  assert.throws(() => getActiveTools(), /stale generation/u);

  await host.close();
});
