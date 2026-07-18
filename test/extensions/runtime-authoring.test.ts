import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  loadRuntimeExtensions,
  type RuntimeCommandContext,
  type RuntimeSessionBeforeCompactEvent,
} from "../../src/extensions/runtime.js";
import type { CanonicalMessage } from "../../src/core/types.js";
import { DirectProcessRunner } from "../../src/process/index.js";
import { sha256 } from "../../src/tools/hash.js";
import { WorkspaceBoundary } from "../../src/tools/paths.js";

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

function commandContext(): Omit<RuntimeCommandContext, "workspace" | "args"> {
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
) {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-authoring-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const entries = [];
  for (const [index, source] of sources.entries()) {
    const sourcePath = join(root, `extension-${index}.mjs`);
    await writeFile(sourcePath, source);
    entries.push({ extensionId: `extension-${index}`, sourcePath, sha256: sha256(source) });
  }
  return {
    root,
    host: await loadRuntimeExtensions(entries, { workspace: root }),
  };
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
    api.registerCommand({ name: "review", description: "First review", argumentHint: "[path]", execute() {} });
  };\n`;
  const second = `export default (api) => {
    api.registerCommand({ name: "review", description: "Second review", execute() {} });
  };\n`;
  const { host, root } = await fixture(context, [first, second]);
  const api = (globalThis as Record<string, any>).__commandCatalogApi;
  try {
    const commands = api.getCommands();
    assert.deepEqual(commands.map((command: { name: string }) => command.name), ["review:1", "review:2"]);
    assert.deepEqual(commands.map((command: { extensionId: string }) => command.extensionId), ["extension-0", "extension-1"]);
    assert.equal(commands[0].sourcePath, join(root, "extension-0.mjs"));
    assert.equal("execute" in commands[0], false);
    commands[0].description = "mutated";
    assert.equal(api.getCommands()[0].description, "First review");

    api.registerCommand({ name: "dynamic", description: "Added after activation", execute() {} });
    assert.deepEqual(api.getCommands().map((command: { name: string }) => command.name), ["review:1", "review:2", "dynamic"]);
  } finally {
    await host.close();
    delete (globalThis as Record<string, unknown>).__commandCatalogApi;
  }
  assert.throws(() => api.getCommands(), /no longer active/u);
});

test("runtime tools receive generation-owned native UI and host mode context", async (context) => {
  const source = `export default (api) => {
    api.registerTool({
      name: "native_context",
      description: "Inspect native extension tool context",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      execute(_input, context) {
        globalThis.__nativeToolContext = {
          extensionId: context.extensionId,
          sourcePath: context.sourcePath,
          hasUI: context.hasUI,
          mode: context.mode
        };
        context.ui.notify("tool context " + context.mode);
        return { content: context.mode, isError: false };
      }
    });
  };\n`;
  const { host, root } = await fixture(context, [source]);
  const tool = host.tools()[0]!;
  const executeContext = {
    workspace: await WorkspaceBoundary.create(root),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "native-context-run",
    threadId: "native-context-thread",
  };

  assert.equal((await tool.execute({}, executeContext)).content, "headless");
  assert.deepEqual((globalThis as Record<string, unknown>).__nativeToolContext, {
    extensionId: "extension-0",
    sourcePath: join(root, "extension-0.mjs"),
    hasUI: false,
    mode: "headless",
  });
  assert.equal(host.initialUi().some((entry) => entry.type === "notify" && entry.value === "tool context headless"), true);

  const owners: string[] = [];
  host.setInteractiveUiHandler((extensionId) => {
    owners.push(extensionId);
    return ui;
  });
  assert.equal((await tool.execute({}, executeContext)).content, "interactive");
  assert.deepEqual((globalThis as Record<string, unknown>).__nativeToolContext, {
    extensionId: "extension-0",
    sourcePath: join(root, "extension-0.mjs"),
    hasUI: true,
    mode: "interactive",
  });
  assert.deepEqual(owners, ["extension-0"]);
  await host.close();
  delete (globalThis as Record<string, unknown>).__nativeToolContext;
});

test("autocomplete and editor middleware compose within generation and output bounds", async (context) => {
  const first = `export default (api) => {
    api.ui.registerAutocompleteProvider(({ text, cursor }) => [{ start: 0, end: cursor, value: text.toUpperCase(), label: "Upper" }]);
    api.ui.registerEditorMiddleware((_event, snapshot) => ({ action: "replace", text: snapshot.text + "a" }));
  };\n`;
  const malformed = `export default (api) => {
    api.ui.registerAutocompleteProvider(() => [{ start: -1, end: 0, value: "bad" }]);
    api.ui.registerEditorMiddleware(() => ({ action: "replace", text: "x", cursor: -1 }));
  };\n`;
  const last = `export default (api) => {
    api.ui.registerAutocompleteProvider(() => [{ start: 0, end: 2, value: "OK", detail: "last" }]);
    api.ui.registerEditorMiddleware((_event, snapshot) => ({ action: "replace", text: snapshot.text + "b" }));
  };\n`;
  const { host } = await fixture(context, [first, malformed, last]);
  try {
    assert.equal(host.hasAutocompleteProviders(), true);
    assert.equal(host.hasEditorMiddleware(), true);
    assert.deepEqual(await host.completeInput({ text: "go", cursor: 2 }), [
      { start: 0, end: 2, value: "GO", label: "Upper" },
      { start: 0, end: 2, value: "OK", detail: "last" },
    ]);
    assert.deepEqual(host.handleEditorInput({ key: "text", text: "x", ctrl: false, alt: false, shift: false }, {
      text: "draft",
      cursor: 5,
    }), { action: "replace", text: "draftab", cursor: 7 });
    assert.ok(host.diagnostics().some((entry) => entry.message.includes("autocomplete")));
    assert.ok(host.diagnostics().some((entry) => entry.message.includes("editor middleware")));
  } finally {
    await host.close();
  }
  assert.equal(host.hasAutocompleteProviders(), false);
  await assert.rejects(host.completeInput({ text: "x", cursor: 1 }), /closed/u);
});

test("autocomplete cancellation aborts an in-flight generation-owned provider", async (context) => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  (globalThis as Record<string, unknown>).__autocompleteStarted = started;
  const source = `export default (api) => api.ui.registerAutocompleteProvider((_context, signal) => {
    globalThis.__autocompleteSignal = signal;
    globalThis.__autocompleteStarted();
    return new Promise(() => {});
  });\n`;
  const { host } = await fixture(context, [source]);
  const controller = new AbortController();
  const pending = host.completeInput({ text: "x", cursor: 1 }, controller.signal);
  await ready;
  controller.abort(new Error("cancel autocomplete"));
  await assert.rejects(within(pending), /cancel autocomplete/u);
  assert.equal(((globalThis as Record<string, unknown>).__autocompleteSignal as AbortSignal).aborted, true);
  await host.close();
  delete (globalThis as Record<string, unknown>).__autocompleteStarted;
  delete (globalThis as Record<string, unknown>).__autocompleteSignal;
});

test("runtime commands and shortcuts settle when their caller aborts", async (context) => {
  let commandStarted!: () => void;
  let shortcutStarted!: () => void;
  const commandReady = new Promise<void>((resolve) => { commandStarted = resolve; });
  const shortcutReady = new Promise<void>((resolve) => { shortcutStarted = resolve; });
  (globalThis as Record<string, unknown>).__authoringCommandStarted = commandStarted;
  (globalThis as Record<string, unknown>).__authoringShortcutStarted = shortcutStarted;
  const source = `export default (api) => {
    api.registerCommand({ name: "wait-command", execute(context) {
      globalThis.__authoringCommandSignal = context.signal;
      globalThis.__authoringCommandStarted();
      return new Promise(() => {});
    }});
    api.registerShortcut({ shortcut: "ctrl+g", execute(context) {
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
      globalThis.__resourceDiscoveryEvents = [[event.reason, event.workspace, context.extensionId]];
      return { skillPaths: ["skills-a"], promptPaths: ["prompts-a"] };
    });
    api.on("resources_discover", () => ({ themePaths: ["themes-a"] }));
  };\n`;
  const invalid = `export default (api) => api.on("resources_discover", () => ({ skillPaths: "not-an-array" }));\n`;
  const second = `export default (api) => api.on("resources_discover", (event, context) => {
    globalThis.__resourceDiscoveryEvents.push([event.reason, event.workspace, context.extensionId]);
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
      ["startup", root, "extension-0"],
      ["startup", root, "extension-2"],
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
  const untrusted = await loadRuntimeExtensions([{
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
    assert.ok(untrusted.diagnostics().some((entry) => /untrusted project/u.test(entry.message)));
  } finally {
    await untrusted.close();
  }
});

test("resource discovery has a default host deadline when callers omit a signal", { timeout: 1_000 }, async (context) => {
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
  const host = await loadRuntimeExtensions([{
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

test("runtime shutdown listeners and asynchronous disposers are bounded", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-shutdown-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const shutdownPath = join(root, "shutdown.mjs");
  const shutdownSource = `export default (api) => {
    api.on("session_end", () => new Promise(() => {}));
    api.on("session_shutdown", () => new Promise(() => {}));
  };\n`;
  await writeFile(shutdownPath, shutdownSource);
  const shutdownHost = await loadRuntimeExtensions([{
    extensionId: "shutdown",
    sourcePath: shutdownPath,
    sha256: sha256(shutdownSource),
  }], { workspace: root, shutdownTimeoutMs: 25 });
  await assert.rejects(within(shutdownHost.dispatch("session_end", { threadId: "thread-1" })), /aborted|timeout/i);
  await within(shutdownHost.close());
  assert.ok(shutdownHost.diagnostics().some((entry) => entry.message.includes("session_shutdown")));

  const disposerPath = join(root, "disposer.mjs");
  const disposerSource = `export default (api) => api.onDispose(() => new Promise(() => {}));\n`;
  await writeFile(disposerPath, disposerSource);
  const disposerHost = await loadRuntimeExtensions([{
    extensionId: "disposer",
    sourcePath: disposerPath,
    sha256: sha256(disposerSource),
  }], { workspace: root, shutdownTimeoutMs: 25 });
  await assert.rejects(within(disposerHost.close()), /aborted|timed out|timeout/i);
});

test("runtime shutdown phases do not feed cleanup through an expired earlier deadline", { timeout: 1_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-shutdown-phases-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "shutdown-phases.mjs");
  const order: string[] = [];
  let disposerStarted!: () => void;
  let releaseDisposer!: () => void;
  let registrationStarted!: () => void;
  let releaseRegistration!: () => void;
  const disposerReady = new Promise<void>((resolve) => { disposerStarted = resolve; });
  const disposerRelease = new Promise<void>((resolve) => { releaseDisposer = resolve; });
  const registrationReady = new Promise<void>((resolve) => { registrationStarted = resolve; });
  const registrationRelease = new Promise<void>((resolve) => { releaseRegistration = resolve; });
  Object.assign(globalThis, {
    __shutdownPhaseOrder: order,
    __shutdownPhaseDisposerStarted: disposerStarted,
    __shutdownPhaseDisposerRelease: disposerRelease,
  });
  const source = `export default (api) => {
    api.on("session_shutdown", () => new Promise(() => {}));
    api.onDispose(async () => {
      globalThis.__shutdownPhaseOrder.push("disposer:start");
      globalThis.__shutdownPhaseDisposerStarted();
      await globalThis.__shutdownPhaseDisposerRelease;
      globalThis.__shutdownPhaseOrder.push("disposer:end");
    });
  };\n`;
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "shutdown-phases",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root, shutdownTimeoutMs: 50 });
  host.addRegistrationCleanup(async () => {
    order.push("registration:start");
    registrationStarted();
    await registrationRelease;
    order.push("registration:end");
  });

  try {
    const closing = host.close();
    await within(disposerReady);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["disposer:start"]);
    releaseDisposer();
    await within(registrationReady);
    assert.deepEqual(order, ["disposer:start", "disposer:end", "registration:start"]);
    releaseRegistration();
    await within(closing);
    assert.deepEqual(order, ["disposer:start", "disposer:end", "registration:start", "registration:end"]);
  } finally {
    releaseDisposer();
    releaseRegistration();
    await host.close().catch(() => undefined);
    delete (globalThis as Record<string, unknown>).__shutdownPhaseOrder;
    delete (globalThis as Record<string, unknown>).__shutdownPhaseDisposerStarted;
    delete (globalThis as Record<string, unknown>).__shutdownPhaseDisposerRelease;
  }
});

test("a hung shutdown listener does not prevent another shutdown listener from running", { timeout: 1_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-shutdown-fairness-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "shutdown-fairness.mjs");
  const stateKey = "__runtimeShutdownFairness";
  (globalThis as Record<string, unknown>)[stateKey] = false;
  const source = `export default (api) => {
    api.on("session_shutdown", () => new Promise(() => {}));
    api.on("session_shutdown", () => { globalThis[${JSON.stringify(stateKey)}] = true; });
  };\n`;
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "shutdown-fairness",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root, shutdownTimeoutMs: 25 });

  try {
    await host.close();
    assert.equal((globalThis as Record<string, unknown>)[stateKey], true);
  } finally {
    delete (globalThis as Record<string, unknown>)[stateKey];
    await host.close().catch(() => undefined);
  }
});

test("a hung disposer does not prevent remaining cleanup callbacks from starting", { timeout: 1_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-disposer-fairness-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "disposer-fairness.mjs");
  const stateKey = "__runtimeDisposerFairness";
  (globalThis as Record<string, unknown>)[stateKey] = false;
  const source = `export default (api) => {
    api.onDispose(() => { globalThis[${JSON.stringify(stateKey)}] = true; });
    api.onDispose(() => new Promise(() => {}));
  };\n`;
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "disposer-fairness",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root, shutdownTimeoutMs: 25 });

  try {
    await assert.rejects(host.close(), /timed out after 25ms/u);
    assert.equal((globalThis as Record<string, unknown>)[stateKey], true);
  } finally {
    delete (globalThis as Record<string, unknown>)[stateKey];
    await host.close().catch(() => undefined);
  }
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
      ["branch", "model", "provider", "request", "runId", "step", "threadId"],
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
  const replacement = await loadRuntimeExtensions([{
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
    api.registerFlag({ name: "plan", description: "first", type: "boolean", default: true });
    api.registerFlag({ name: "plan", description: "first-final", type: "boolean", default: false });
    api.registerFlag({ name: "mode", type: "string", default: "safe" });
    api.on("session_start", () => { globalThis.__authoringFirstFlags = [api.getFlag("plan"), api.getFlag("mode"), api.getFlag("foreign")]; });
  };\n`;
  const second = `export default (api) => {
    api.registerFlag({ name: "plan", description: "second", type: "boolean", default: false });
    api.registerFlag({ name: "foreign", type: "string", default: "owned" });
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
  const first = `export default (api) => api.registerShortcut({
    shortcut: "SHIFT + CTRL + X", description: "first", execute() { globalThis.__authoringShortcut = "first"; }
  });\n`;
  const second = `export default (api) => api.registerShortcut({
    shortcut: "ctrl+shift+x", description: "second", execute(ctx) { globalThis.__authoringShortcut = "second:" + ctx.threadId; }
  });\n`;
  const { host } = await fixture(context, [first, second]);

  assert.deepEqual(host.shortcuts().map((entry) => [entry.shortcut, entry.description, entry.extensionId]), [
    ["ctrl+shift+x", "second", "extension-1"],
  ]);
  assert.match(host.diagnostics()[0]?.message ?? "", /replaced the registration/u);
  assert.equal(host.hasShortcut("shift+ctrl+x"), true);
  assert.deepEqual(await host.runShortcut("ctrl+shift+x", commandContext()), { handled: true });
  assert.equal((globalThis as Record<string, unknown>).__authoringShortcut, "second:thread-1");
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
  api.registerFlag({ name: "late-flag", type: "boolean", default: true });
  api.registerShortcut({ shortcut: "alt+z", execute() { (globalThis as Record<string, unknown>).__authoringLateShortcut = true; } });
  api.registerCommand({ name: "late-authoring", getArgumentCompletions() { return [{ value: "done" }]; }, execute() { return "late"; } });
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
  await host.dispatch("session_end", { reason: "quit", threadId: "thread-1" });
  assert.equal((globalThis as Record<string, unknown>).__authoringShutdown, undefined);
  await host.close();
  assert.equal((globalThis as Record<string, unknown>).__authoringShutdown, true);
  assert.throws(() => api.registerFlag({ name: "stale", type: "boolean" }), /no longer active/u);
  delete (globalThis as Record<string, unknown>).__authoringLateApi;
  delete (globalThis as Record<string, unknown>).__authoringLateShortcut;
  delete (globalThis as Record<string, unknown>).__authoringShutdown;
});

test("duplicate command names remain independently invokable and duplicate tools keep the first owner", async (context) => {
  const first = `export default (api) => {
    api.registerCommand({ name: "review", description: "first command", getArgumentCompletions(prefix) { return [{ value: prefix + "-one", label: "One" }]; }, execute() { return "first"; } });
    api.registerTool({ name: "shared_tool", description: "first tool", inputSchema: { type: "object" }, execute() { return { content: "first", isError: false }; } });
    api.registerTool({ name: "first_only", description: "first only", inputSchema: { type: "object" }, execute() { return { content: "one", isError: false }; } });
  };\n`;
  const second = `export default (api) => {
    api.registerCommand({ name: "review", description: "second command", execute() { return "second"; } });
    api.registerTool({ name: "shared_tool", description: "second tool", inputSchema: { type: "object" }, execute() { return { content: "second", isError: false }; } });
    api.registerTool({ name: "second_only", description: "second only", inputSchema: { type: "object" }, execute() { return { content: "two", isError: false }; } });
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
    api.registerTool({ name: "same_id_tool", description: "first source", inputSchema: { type: "object" }, execute() { return { content: "first", isError: false }; } });
  };\n`;
  const second = `export default (api) => {
    api.registerTool({ name: "same_id_tool", description: "second source", inputSchema: { type: "object" }, execute() { return { content: "second", isError: false }; } });
  };\n`;
  const firstPath = join(root, "first.mjs");
  const secondPath = join(root, "second.mjs");
  await Promise.all([
    writeFile(firstPath, first),
    writeFile(secondPath, second),
  ]);
  const host = await loadRuntimeExtensions([
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

test("late duplicate tools diagnose cross-extension collisions without changing same-owner errors", async (context) => {
  const first = `export default (api) => { globalThis.__authoringFirstToolApi = api; };\n`;
  const second = `export default (api) => { globalThis.__authoringSecondToolApi = api; };\n`;
  const { host, root } = await fixture(context, [first, second]);
  const firstApi = (globalThis as Record<string, any>).__authoringFirstToolApi;
  const secondApi = (globalThis as Record<string, any>).__authoringSecondToolApi;
  const registration = (description: string) => ({
    name: "late_shared_tool",
    description,
    inputSchema: { type: "object" },
    execute() { return { content: description, isError: false }; },
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
    assert.throws(() => firstApi.registerTool(registration("same owner duplicate")), /duplicate tool/u);
  } finally {
    await host.close();
    delete (globalThis as Record<string, unknown>).__authoringFirstToolApi;
    delete (globalThis as Record<string, unknown>).__authoringSecondToolApi;
  }
});

test("input, prompt, context, and message reducers chain in load order and isolate failures", async (context) => {
  const first = `export default (api) => {
    api.on("input", (event) => ({ action: "transform", text: event.text + ":one" }));
    api.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + ":one", messages: [{ id: "injected-1", role: "system", content: [{ type: "text", text: "one" }], createdAt: "2026-01-01T00:00:00.000Z" }] }));
    api.on("context", (event) => ({ messages: event.messages.filter((entry) => entry.role !== "tool") }));
    api.on("message_end", (event) => ({ message: { ...event.message, displayText: "one" } }));
  };\n`;
  const broken = `export default (api) => {
    api.on("input", () => { throw new Error("input boom"); });
    api.on("context", () => { throw new Error("context boom"); });
    api.on("message_end", (event) => ({ message: { ...event.message, role: "user" } }));
  };\n`;
  const last = `export default (api) => {
    api.on("input", (event) => event.text.includes("stop") ? { action: "handled" } : { action: "transform", text: event.text + ":two" });
    api.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + ":two" }));
    api.on("context", (event) => ({ messages: [...event.messages, { id: "context-last", role: "system", content: [{ type: "text", text: "last" }], createdAt: "2026-01-01T00:00:00.000Z" }] }));
    api.on("message_end", (event) => ({ message: { ...event.message, displayText: event.message.displayText + ":two" } }));
  };\n`;
  const { host } = await fixture(context, [first, broken, last]);

  assert.deepEqual(await host.reduceInput({ text: "go", source: "tui" }), { action: "transform", text: "go:one:two" });
  assert.deepEqual(await host.reduceInput({ text: "stop", source: "rpc" }), { action: "handled" });
  const runScope = { threadId: "thread-authoring", runId: "run-authoring", branch: "main" };
  const before = await host.reduceBeforeAgentStart({ ...runScope, prompt: "p", systemPrompt: "base" });
  assert.equal(before.systemPrompt, "base:one:two");
  assert.deepEqual(before.messages.map((entry) => entry.id), ["injected-1"]);
  const reducedContext = await host.reduceContext({
    ...runScope,
    step: 1,
    messages: [
      message("user", "user", "request"),
      message("tool", "tool", "result"),
    ],
  });
  assert.deepEqual(reducedContext.map((entry) => entry.id), ["user", "context-last"]);
  const ended = await host.reduceMessageEnd({
    ...runScope,
    step: 1,
    message: message("assistant", "assistant", "answer"),
  });
  assert.equal(ended.role, "assistant");
  assert.equal(ended.displayText, "one:two");
  assert.ok(host.diagnostics().some((entry) => entry.message.includes("input boom")));
  assert.ok(host.diagnostics().some((entry) => entry.message.includes("context boom")));
  assert.ok(host.diagnostics().some((entry) => entry.message.includes("cannot change the message role")));
  await host.close();
});

test("tool reducers expose prior mutations, chain partial result patches, and fail closed before execution", async (context) => {
  const mutating = `export default (api) => {
    api.on("tool_call", (event) => {
      try { event.threadId = "forged-thread"; } catch {}
      try { event.runId = "forged-run"; } catch {}
      try { event.branch = "forged-branch"; } catch {}
      event.input.path = "safe/" + event.input.path;
    });
    api.on("tool_call", (event) => event.input.path === "safe/blocked" ? { block: true, reason: "protected" } : undefined);
    api.on("tool_result", (event) => ({ content: event.result.content + ":one", metadata: { stage: 1 } }));
    api.on("tool_result", () => { throw new Error("result boom"); });
    api.on("tool_result", (event) => ({ content: event.result.content + ":two", isError: true, terminate: true }));
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
  assert.deepEqual(result, { content: "base:one:two", isError: true, terminate: true, metadata: { stage: 1 } });
  assert.ok(host.diagnostics().some((entry) => entry.message.includes("result boom")));
  await host.close();

  const throwing = `export default (api) => {
    api.on("tool_call", (event) => { event.input.checked = true; throw new Error("preflight boom"); });
    api.on("tool_call", () => { globalThis.__authoringUnsafeToolContinued = true; });
  };\n`;
  const failed = await fixture(context, [throwing]);
  const decision = await failed.host.reduceToolCall({ ...target, callId: "call-3", name: "bash", input: {}, index: 0 });
  assert.equal(decision.blocked, true);
  assert.match(decision.reason ?? "", /preflight boom/u);
  assert.deepEqual(decision.invocation.input, {});
  assert.equal((globalThis as Record<string, unknown>).__authoringUnsafeToolContinued, undefined);
  await failed.host.close();
});

test("session and compaction reducers cancel deterministically and accept bounded custom summaries", async (context) => {
  const source = `export default (api) => {
    api.on("session_before_switch", () => ({ reason: "first opinion" }));
    api.on("session_before_switch", () => ({ cancel: true, reason: "stay here" }));
    api.on("session_before_switch", () => { globalThis.__authoringSwitchContinued = true; });
    api.on("session_before_fork", () => ({ cancel: false }));
    api.on("session_before_tree", (event) => event.summarize ? { summary: { text: "tree summary", metadata: { count: event.sourceEventIds.length } } } : undefined);
    api.on("session_before_compact", (event) => ({ compaction: { text: "compact:" + event.plan.reason, metadata: { source: event.plan.sourceMessageIds.length } } }));
  };\n`;
  const { host } = await fixture(context, [source]);
  assert.deepEqual(await host.reduceSessionBeforeSwitch({ reason: "new" }), { cancel: true, reason: "stay here" });
  assert.equal((globalThis as Record<string, unknown>).__authoringSwitchContinued, undefined);
  assert.deepEqual(await host.reduceSessionBeforeFork({ sourceThreadId: "thread-1" }), { cancel: false });
  assert.deepEqual(await host.reduceSessionBeforeTree({
    threadId: "thread-1",
    targetEventId: "event-2",
    summarize: true,
    sourceEventIds: ["event-1"],
  }), { summary: { text: "tree summary", metadata: { count: 1 } } });
  const compactionEvent = {
    threadId: "thread-1",
    runId: "run-1",
    branch: "main",
    plan: {
      kind: "compact",
      provider: "offline",
      maxTokens: 100,
      targetTokens: 80,
      maxSummaryTokens: 20,
      keepRecentTokens: 20,
      reserveTokens: 20,
      additionalTokens: 0,
      estimatedTokensBefore: 120,
      estimatedTokensAfterUpperBound: 60,
      reason: "manual",
      splitTurn: false,
      leadingMessages: [],
      sourceMessages: [message("source", "user", "source")],
      trailingMessages: [],
      sourceMessageIds: ["source"],
    },
    customInstructions: "focus",
    signal: new AbortController().signal,
  } as RuntimeSessionBeforeCompactEvent;
  assert.deepEqual(await host.reduceSessionBeforeCompact(compactionEvent), {
    compaction: { text: "compact:manual", metadata: { source: 1 } },
  });
  await host.close();
});

test("invalid authoring registrations fail transactionally without suppressing later extensions", async (context) => {
  const invalid = `export default (api) => {
    api.registerCommand({ name: "must-not-commit", execute() {} });
    api.registerFlag({ name: "bad", type: "boolean", default: "wrong" });
  };\n`;
  const valid = `export default (api) => {
    api.registerShortcut({ shortcut: "ctrl+k", execute() {} });
    api.registerFlag({ name: "valid", type: "string", default: "yes" });
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
    api.registerCommand({
      name: "broken-command",
      getArgumentCompletions() { throw new Error("completion boom"); },
      execute() { throw new Error("command boom"); }
    });
    api.registerShortcut({ shortcut: "ctrl+q", execute() { throw new Error("shortcut boom"); } });
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

test("shared events and listener UI are generation-bound and abortable", async (context) => {
  const receiver = `export default (api) => {
    api.events.on("dashboard.update", async (payload, context) => {
      globalThis.__authoringShared = [payload, context.extensionId, await context.ui.select("Apply?", [{ label: "Yes", value: "yes" }], context.signal)];
    });
  };\n`;
  const sender = `export default (api) => { globalThis.__authoringSharedApi = api; };\n`;
  const { host } = await fixture(context, [receiver, sender]);
  const uiOwners: string[] = [];
  host.setInteractiveUiHandler((extensionId) => {
    uiOwners.push(extensionId);
    return ui;
  });
  const api = (globalThis as Record<string, any>).__authoringSharedApi;

  await api.events.emit("dashboard.update", { state: "ready" });
  assert.deepEqual((globalThis as Record<string, unknown>).__authoringShared, [
    { state: "ready" },
    "extension-0",
    "yes",
  ]);
  assert.deepEqual(uiOwners, ["extension-0"]);

  const cancelled = new AbortController();
  cancelled.abort(new Error("shared event cancelled"));
  await assert.rejects(api.events.emit("dashboard.update", null, cancelled.signal), /shared event cancelled/u);
  await host.close();
  await assert.rejects(api.events.emit("dashboard.update", null), /no longer active/u);
  await assert.rejects(api.getSession({ threadId: "thread-1" }), /no longer active/u);
  await assert.rejects(api.exec({ command: process.execPath }), /no longer active/u);
  delete (globalThis as Record<string, unknown>).__authoringShared;
  delete (globalThis as Record<string, unknown>).__authoringSharedApi;
});
