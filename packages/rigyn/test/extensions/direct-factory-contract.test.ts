import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";

import {
  loadDirectExtensions,
  type RuntimeCommandContext,
  type RuntimeDiscoveryView,
} from "../../src/extensions/runtime.js";
import { MAX_TRUSTED_RESOURCE_FILE_BYTES } from "../../src/core/resource-file.js";
import type { ExtensionAPI } from "../../src/extensions/direct.js";
import { extensionSessionManager } from "../../src/extensions/session-contract.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import { createModels } from "../../src/providers/models.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { sha256 } from "../../src/tools/hash.js";
import { createTheme } from "../../src/tui/theme.js";
import {
  DIRECT_TOOL_RENDER_RESULT,
  projectRuntimeDirectToolRenderContent,
} from "../../src/tui/tool-render-view.js";
import { loadTestDirectExtensions } from "../helpers/direct-extension-loader.js";

const commandUi: RuntimeCommandContext["ui"] = {
  notify() {},
  setStatus() {},
  setWidget() {},
  setHeader() {},
  setFooter() {},
  setWorkingMessage() {},
  setWorkingVisible() {},
  setTitle() {},
  async getTheme() { return { name: "mono", available: ["dark"] }; },
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

function directExtensionSourceAtSize(size: number, source: string): Buffer {
  const prefix = Buffer.from(source, "utf8");
  assert.ok(prefix.byteLength <= size);
  const bytes = Buffer.alloc(size, 0x20);
  prefix.copy(bytes);
  return bytes;
}

test("path-first direct loader accepts TypeScript directories and never reuses stale module state", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-path-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const extensionRoot = join(root, "extension");
  await mkdir(extensionRoot);
  const sourcePath = join(extensionRoot, "index.ts");
  await writeFile(sourcePath, `
    import type { ExtensionAPI } from "rigyn/extensions";
    export default function (rigyn: ExtensionAPI) {
      rigyn.registerCommand("first-load", { handler() {} });
    }
  `);
  const first = await loadDirectExtensions([extensionRoot], { workspace: root, activationFailure: "throw" });
  assert.equal(first.hasCommand("first-load"), true);
  await first.close();

  await writeFile(sourcePath, `
    import type { ExtensionAPI } from "rigyn/extensions";
    export default function (rigyn: ExtensionAPI) {
      rigyn.registerCommand("second-load", { handler() {} });
    }
  `);
  const second = await loadDirectExtensions([extensionRoot], { workspace: root, activationFailure: "throw" });
  context.after(async () => await second.close());
  assert.equal(second.hasCommand("first-load"), false);
  assert.equal(second.hasCommand("second-load"), true);
});

test("direct extension source snapshots enforce the inclusive 16 MiB boundary", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-source-limit-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const exactPath = join(root, "exact.mjs");
  await writeFile(exactPath, directExtensionSourceAtSize(
    MAX_TRUSTED_RESOURCE_FILE_BYTES,
    `export default function (rigyn) {
      rigyn.registerCommand("exact-source-limit", { handler() {} });
    }\n`,
  ));
  const exactHost = await loadDirectExtensions([exactPath], {
    workspace: root,
    activationFailure: "throw",
  });
  assert.equal(exactHost.hasCommand("exact-source-limit"), true);
  await exactHost.close();

  const oversizedPath = join(root, "oversized.mjs");
  await writeFile(oversizedPath, directExtensionSourceAtSize(
    MAX_TRUSTED_RESOURCE_FILE_BYTES + 1,
    `export default function () { throw new Error("oversized direct extension was evaluated"); }\n`,
  ));
  await assert.rejects(
    loadDirectExtensions([oversizedPath], { workspace: root, activationFailure: "throw" }),
    new RegExp(`Direct extension source exceeds ${MAX_TRUSTED_RESOURCE_FILE_BYTES} bytes`),
  );
});

test("direct extension source discovery rejects nonregular entry paths", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-source-nonregular-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const directoryPath = join(root, "not-a-file.ts");
  await mkdir(directoryPath);

  await assert.rejects(
    loadDirectExtensions([directoryPath], { workspace: root, activationFailure: "throw" }),
    /Direct extension directory has no supported index file/,
  );
});

test("direct extension activation uses the immutable discovery snapshot", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-source-snapshot-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const firstPath = join(root, "first.mjs");
  const secondPath = join(root, "second.mjs");
  const replacement = `export default function (rigyn) {
    rigyn.registerCommand("replacement-source", { handler() {} });
  }\n`;
  await writeFile(firstPath, `export default function (rigyn) {
    rigyn.registerCommand("discovery-snapshot", { handler() {} });
  }\n`);
  await writeFile(secondPath, `export default function (rigyn) {
    rigyn.registerCommand("second-source", { handler() {} });
  }\n`);
  const paths = [firstPath, secondPath];
  Object.defineProperty(paths, 1, {
    configurable: true,
    enumerable: true,
    get() {
      writeFileSync(firstPath, replacement);
      return secondPath;
    },
  });

  const host = await loadDirectExtensions(paths, { workspace: root, activationFailure: "throw" });
  context.after(async () => await host.close());
  assert.equal(host.hasCommand("discovery-snapshot"), true);
  assert.equal(host.hasCommand("replacement-source"), false);
  assert.equal(host.hasCommand("second-source"), true);
});

test("loose TypeScript extensions can use the supported schema modules at runtime", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-schema-imports-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "index.ts");
  await writeFile(sourcePath, `
    import { Type } from "typebox";
    import { Compile } from "typebox/compile";
    import { Check } from "typebox/value";
    import { Type as LegacyType } from "@sinclair/typebox";
    import { Compile as LegacyCompile } from "@sinclair/typebox/compile";
    import { Check as LegacyCheck } from "@sinclair/typebox/value";
    import type { ExtensionAPI } from "rigyn/extensions";

    const schema = Type.Object({ value: Type.String() });
    const legacySchema = LegacyType.Object({ count: LegacyType.Number() });
    export default function (rigyn: ExtensionAPI) {
      globalThis.__rigynSchemaImports = [
        Compile(schema).Check({ value: "ready" }),
        Check(schema, { value: "ready" }),
        LegacyCompile(legacySchema).Check({ count: 1 }),
        LegacyCheck(legacySchema, { count: 1 }),
      ];
      rigyn.registerCommand("schema-imports", { handler() {} });
    }
  `);
  const host = await loadDirectExtensions([sourcePath], {
    workspace: root,
    activationFailure: "throw",
  });
  context.after(async () => {
    await host.close();
    delete (globalThis as Record<string, unknown>).__rigynSchemaImports;
  });

  assert.equal(host.hasCommand("schema-imports"), true);
  assert.deepEqual((globalThis as Record<string, unknown>).__rigynSchemaImports, [true, true, true, true]);
});

test("loose TypeScript extensions resolve the host serve API", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-serve-import-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "index.ts");
  await writeFile(sourcePath, `
    import { startServeServer } from "rigyn/serve";
    import type { ExtensionAPI } from "rigyn/extensions";

    export default function (rigyn: ExtensionAPI) {
      globalThis.__rigynServeImport = typeof startServeServer;
      rigyn.registerCommand("serve-import", { handler() {} });
    }
  `);
  const host = await loadDirectExtensions([sourcePath], {
    workspace: root,
    activationFailure: "throw",
  });
  context.after(async () => {
    await host.close();
    delete (globalThis as Record<string, unknown>).__rigynServeImport;
  });

  assert.equal(host.hasCommand("serve-import"), true);
  assert.equal((globalThis as Record<string, unknown>).__rigynServeImport, "function");
});

test("direct tools expose public recovery and resource claims to the scheduler", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-tool-claims-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [(rigyn) => {
      rigyn.registerTool({
        name: "claimed_write",
        label: "Claimed write",
        description: "Claim one output path",
        parameters: Type.Object(
          { path: Type.String() },
          { additionalProperties: false },
        ),
        recovery: { mode: "never_repeat" },
        resources(input, toolContext) {
          return [{
            kind: "file",
            key: `${toolContext.workspace.root}/${input.path}`,
            mode: "write",
          }];
        },
        async execute() {
          return { content: [{ type: "text", text: "done" }], details: undefined };
        },
      });
    }],
  });
  context.after(async () => await host.close());

  const [tool] = host.tools();
  assert.equal(tool?.recovery?.mode, "never_repeat");
  assert.deepEqual(
    await tool?.resources({ path: "output.txt" }, {
      workspace: { root },
      signal: new AbortController().signal,
      runId: "claims-run",
      threadId: "claims-thread",
    } as never),
    [{ kind: "file", key: `${root}/output.txt`, mode: "write" }],
  );
});

test("trusted modules use the direct factory registration signatures", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-factory-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "direct.mjs");
  const source = `export default async function (rigyn) {
    await Promise.resolve();
    globalThis.__rigynDirectApi = rigyn;
    rigyn.registerCommand("direct-command", {
      description: "Direct command",
      handler(args, ctx) {
        globalThis.__rigynDirectCommand = [args, ctx.cwd, ctx.sessionManager.getSessionId(), ctx.thinkingLevel, ctx.getSystemPrompt()];
      }
    });
    rigyn.registerShortcut("ctrl+alt+d", {
      description: "Direct shortcut",
      handler(ctx) { globalThis.__rigynDirectShortcut = ctx.cwd; }
    });
    rigyn.registerFlag("direct-flag", { type: "string", default: "ready" });
    rigyn.registerMessageRenderer("direct-message", () => ({ render: () => ["message"], invalidate() {} }));
    rigyn.registerMarkdownTransformer((markdown, context) => {
      globalThis.__rigynDirectMarkdown = context;
      return markdown.replace("plain", "styled");
    });
    rigyn.registerEntryRenderer("direct-entry", () => ({ render: () => ["entry"], invalidate() {} }));
    rigyn.on("before_provider_headers", (event) => {
      event.headers["x-direct"] = "yes";
      event.headers["x-remove"] = null;
      globalThis.__rigynDirectHeaderEvent = event.type;
    });
    rigyn.on("user_bash", (event, context) => {
      globalThis.__rigynDirectBashEvent = [event.type, event.excludeFromContext, context.thinkingLevel];
      if (event.command === "handled") {
        return { result: { output: "direct output", exitCode: 7, cancelled: false, truncated: false } };
      }
    });
  }\n`;
  await writeFile(sourcePath, source);
  const host = await loadTestDirectExtensions([{
    extensionId: "direct",
    sourcePath,
    sha256: sha256(source),
    trusted: true,
  }], { workspace: root, activationFailure: "throw" });
  const sessionManager = SessionManager.inMemory(root, { id: "direct-session" });
  host.setDirectContextHandler(() => ({
    sessionManager: extensionSessionManager(sessionManager),
    modelRegistry: new ModelRegistry(createModels()),
    thinkingLevel: "high",
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => "direct system prompt",
  }));
  const actionCalls: unknown[] = [];
  host.setDirectActionsHandler({
    sendMessage(message, options) { actionCalls.push(["sendMessage", message, options]); },
    sendUserMessage(content, options) { actionCalls.push(["sendUserMessage", content, options]); },
    appendEntry(customType, data) { actionCalls.push(["appendEntry", customType, data]); },
    setSessionName(name) { actionCalls.push(["setSessionName", name]); },
    getSessionName() { return "direct name"; },
    setLabel(entryId, label) { actionCalls.push(["setLabel", entryId, label]); },
    async exec(command, args, options) {
      actionCalls.push(["exec", command, args, options]);
      return { stdout: "out", stderr: "", code: 0, killed: false };
    },
    getActiveTools() { return ["read"]; },
    getAllTools() {
      const tool = (name: string, owner: {
        kind: "builtin" | "host";
      } | {
        kind: "extension";
        extensionId: string;
        sourcePath: string;
        scope: "user" | "invocation";
      }) => ({
        name,
        description: `${name} description`,
        inputSchema: { type: "object" },
        active: true,
        executionMode: "parallel" as const,
        owner,
      });
      return [
        tool("read", { kind: "builtin" }),
        tool("user_tool", {
          kind: "extension",
          extensionId: "user-extension",
          sourcePath: join(root, "user-extension.mjs"),
          scope: "user",
        }),
        tool("invocation_tool", {
          kind: "extension",
          extensionId: "invocation-extension",
          sourcePath: join(root, "invocation-extension.mjs"),
          scope: "invocation",
        }),
        tool("host_tool", { kind: "host" }),
      ];
    },
    setActiveTools(names) { actionCalls.push(["setActiveTools", names]); },
    async setModel(model) { actionCalls.push(["setModel", model]); return true; },
    getThinkingLevel() { return "high"; },
    setThinkingLevel(level) { actionCalls.push(["setThinkingLevel", level]); },
    registerProvider(providerOrName) { actionCalls.push(["registerProvider", typeof providerOrName === "string" ? providerOrName : providerOrName.id]); },
    unregisterProvider(name) { actionCalls.push(["unregisterProvider", name]); },
    getSystemPromptOptions() { return { cwd: root }; },
    async waitForIdle() {},
    async newSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async navigateTree() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async refresh() {},
  });
  context.after(async () => {
    await host.close();
    delete (globalThis as Record<string, unknown>).__rigynDirectCommand;
    delete (globalThis as Record<string, unknown>).__rigynDirectApi;
    delete (globalThis as Record<string, unknown>).__rigynDirectShortcut;
    delete (globalThis as Record<string, unknown>).__rigynDirectHeaderEvent;
    delete (globalThis as Record<string, unknown>).__rigynDirectBashEvent;
    delete (globalThis as Record<string, unknown>).__rigynDirectMarkdown;
  });

  assert.equal(host.hasCommand("direct-command"), true);
  assert.equal(host.hasShortcut("ctrl+alt+d"), true);
  assert.equal(host.flagValues().get("direct-flag"), "ready");
  assert.equal(typeof host.messageRenderer("direct-message"), "function");
  assert.equal(typeof host.entryRenderer("direct-entry"), "function");
  assert.equal(typeof host.compatibilityProjection(sourcePath)?.markdownTransformer, "function");
  assert.equal(host.transformMarkdown("plain text", {
    messageType: "assistant",
    isStreaming: true,
    availableWidth: 72,
  }), "styled text");
  assert.deepEqual((globalThis as Record<string, unknown>).__rigynDirectMarkdown, {
    messageType: "assistant",
    isStreaming: true,
    availableWidth: 72,
  });
  assert.deepEqual(host.renderers().filter((entry) => entry.extensionId === "direct"), [
    {
      extensionId: "direct",
      sourcePath,
      kind: "message",
      key: "direct-message",
    },
    {
      extensionId: "direct",
      sourcePath,
      kind: "markdown",
      key: "transcript",
    },
    {
      extensionId: "direct",
      sourcePath,
      kind: "entry",
      key: "direct-entry",
    },
  ]);
  const api = (globalThis as Record<string, unknown>).__rigynDirectApi as ExtensionAPI;
  assert.deepEqual(Object.keys(api).sort(), [
    "appendEntry",
    "config",
    "events",
    "exec",
    "getActiveTools",
    "getAllTools",
    "getCommands",
    "getDiscoveryView",
    "getFlag",
    "getSessionName",
    "getThinkingLevel",
    "on",
    "onDispose",
    "processes",
    "registerCommand",
    "registerEntryRenderer",
    "registerFlag",
    "registerMarkdownTransformer",
    "registerMessageRenderer",
    "registerProvider",
    "registerShortcut",
    "registerTool",
    "sendMessage",
    "sendUserMessage",
    "setActiveTools",
    "setLabel",
    "setModel",
    "setSessionName",
    "setThinkingLevel",
    "unregisterProvider",
  ]);
  for (const obsolete of ["auth", "credentials", "dataPaths", "extensionId", "host", "providers", "session", "signal", "terminal", "ui", "workspace"]) {
    assert.equal(obsolete in api, false, `direct factory must not expose ${obsolete}`);
  }
  api.sendMessage({ customType: "notice", content: "hello", display: true });
  api.sendUserMessage("question", { deliverAs: "steer" });
  api.appendEntry("state", { ready: true });
  api.setSessionName("renamed");
  assert.equal(api.getSessionName(), "direct name");
  api.setLabel("entry-1", "bookmark");
  assert.deepEqual(await api.exec("echo", ["hello"], { timeout: 100 }), {
    stdout: "out",
    stderr: "",
    code: 0,
    killed: false,
  });
  assert.deepEqual(api.getActiveTools(), ["read"]);
  const toolInfo = new Map(api.getAllTools().map((tool) => [tool.name, tool]));
  assert.deepEqual(toolInfo.get("user_tool")?.sourceInfo, {
    path: join(root, "user-extension.mjs"),
    source: join(root, "user-extension.mjs"),
    scope: "user",
    origin: "top-level",
    baseDir: root,
  });
  assert.deepEqual(toolInfo.get("invocation_tool")?.sourceInfo, {
    path: join(root, "invocation-extension.mjs"),
    source: join(root, "invocation-extension.mjs"),
    scope: "temporary",
    origin: "top-level",
    baseDir: root,
  });
  api.setActiveTools(["read"]);
  assert.equal(api.getThinkingLevel(), "high");
  api.setThinkingLevel("medium");
  api.unregisterProvider("example");
  assert.deepEqual(actionCalls, [
    ["sendMessage", { customType: "notice", content: "hello", display: true }, undefined],
    ["sendUserMessage", "question", { deliverAs: "steer" }],
    ["appendEntry", "state", { ready: true }],
    ["setSessionName", "renamed"],
    ["setLabel", "entry-1", "bookmark"],
    ["exec", "echo", ["hello"], { timeout: 100 }],
    ["setActiveTools", ["read"]],
    ["setThinkingLevel", "medium"],
    ["unregisterProvider", "example"],
  ]);

  const signal = new AbortController().signal;
  const contextValue = {
    workspace: root,
    threadId: "thread",
    branch: "main",
    signal,
    mode: "tui" as const,
    hasUI: true,
    isProjectTrusted: () => true,
    ui: commandUi,
  };
  await host.runCommand("direct-command", { ...contextValue, args: "value" });
  await host.runShortcut("ctrl+alt+d", contextValue);
  assert.deepEqual((globalThis as Record<string, unknown>).__rigynDirectCommand, [
    "value",
    root,
    "direct-session",
    "high",
    "direct system prompt",
  ]);
  assert.equal((globalThis as Record<string, unknown>).__rigynDirectShortcut, root);
  const headers = { "x-existing": "keep", "x-remove": "remove" } as Record<string, string | null>;
  assert.equal(await host.applyBeforeProviderHeaders(headers), headers);
  assert.deepEqual(headers, { "x-existing": "keep", "x-remove": null, "x-direct": "yes" });
  assert.equal((globalThis as Record<string, unknown>).__rigynDirectHeaderEvent, "before_provider_headers");
  assert.deepEqual(await host.reduceBeforeUserShell({ command: "handled", cwd: root, hidden: true }), {
    action: "handled",
    command: "handled",
    cwd: root,
    result: { text: "direct output", exitCode: 7, isError: true, cancelled: false },
  });
  assert.deepEqual((globalThis as Record<string, unknown>).__rigynDirectBashEvent, ["user_bash", true, "high"]);
});

test("direct tool renderers retain shell, component state, result details, and live invalidation", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-tool-renderer-"));
  let callOrdinal = 0;
  const componentDisposals: string[] = [];
  let retainedCallComponent: {
    label: string;
    render(): string[];
    invalidate(): void;
    dispose(): void;
  } | undefined;
  const callLifecycle: Array<{ argsComplete: boolean; executionStarted: boolean }> = [];
  let receivedResultContent: unknown;
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [(rigyn) => {
      rigyn.registerTool({
        name: "paint",
        label: "Paint",
        description: "Paint a value",
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } as never,
        renderShell: "self",
        async execute() { return { content: [{ type: "text", text: "done" }], details: { tone: "green" } }; },
        renderCall(args, _theme, renderer) {
          callLifecycle.push({
            argsComplete: renderer.argsComplete,
            executionStarted: renderer.executionStarted,
          });
          const state = renderer.state as { token?: string };
          state.token ??= "shared";
          callOrdinal += 1;
          renderer.invalidate();
          const previous = renderer.lastComponent === undefined ? "first" : "again";
          if (retainedCallComponent === undefined || callOrdinal === 3) {
            const identity = callOrdinal === 3 ? "replacement" : "first";
            retainedCallComponent = {
              label: "",
              render() { return [this.label]; },
              invalidate() {},
              dispose() { componentDisposals.push(identity); },
            };
          }
          retainedCallComponent.label = `CALL ${String((args as { value: string }).value)} ${state.token} ${previous} ${callOrdinal}`;
          return retainedCallComponent;
        },
        renderResult(result, options, _theme, renderer) {
          receivedResultContent = result.content;
          const state = renderer.state as { token?: string };
          return { lines: [{ spans: [{
            text: `RESULT ${result.content[0]?.type === "text" ? result.content[0].text : ""} ${String((result.details as { tone?: string }).tone)} ${state.token} ${options.expanded ? "expanded" : "collapsed"}`,
            role: "success",
          }] }] };
        },
      });
    }],
  });
  const lifecycle = host.lifecycleSignal();
  const binding = host.toolRendererBinding();
  const renderContext = {
    width: 100,
    height: 30,
    focused: false,
    expanded: true,
    theme: { name: "mono" as const, color: true, unicode: true },
  };
  let invalidations = 0;
  const bridge = {
    theme: createTheme("mono", { color: true, unicode: true }),
    showImages: true,
    invalidate() { invalidations += 1; },
  };
  const view = {
    callId: "paint-1",
    name: "paint",
    input: { value: "blue" },
    result: { content: "finished", isError: false, metadata: { tone: "green" } },
    argsComplete: true,
    executionStarted: false,
    status: "pending" as const,
    expanded: true,
  };

  assert.equal(binding.has("paint"), true);
  assert.equal(binding.renderShell?.("paint"), "self");
  assert.equal(binding.renderCall("paint", view, renderContext, bridge)?.lines[0]?.spans[0]?.text, "CALL blue shared first 1");
  assert.equal(binding.renderCall("paint", view, renderContext, bridge)?.lines[0]?.spans[0]?.text, "CALL blue shared again 2");
  assert.deepEqual(componentDisposals, []);
  assert.equal(binding.renderCall("paint", view, renderContext, bridge)?.lines[0]?.spans[0]?.text, "CALL blue shared again 3");
  assert.deepEqual(callLifecycle, [
    { argsComplete: true, executionStarted: false },
    { argsComplete: true, executionStarted: false },
    { argsComplete: true, executionStarted: false },
  ]);
  assert.deepEqual(componentDisposals, ["first"]);
  assert.equal(
    binding.renderResult("paint", view, renderContext, bridge)?.lines[0]?.spans[0]?.text,
    "RESULT finished green shared expanded",
  );
  assert.equal(binding.renderResult("paint", view, renderContext, bridge)?.lines[0]?.spans[0]?.role, "success");
  assert.deepEqual(projectRuntimeDirectToolRenderContent(
    { content: "finished", isError: false },
    { maximumBytes: 1_024 },
  ), [{ type: "text", text: "finished" }]);
  const directResult = binding[DIRECT_TOOL_RENDER_RESULT];
  assert.ok(directResult);
  assert.equal(directResult.call(binding, "paint", view, [
    { type: "text", text: "before" },
    { type: "image", mediaType: "image/png", data: "private-image-bytes" },
    { type: "text", text: "after" },
  ], renderContext, bridge)?.lines[0]?.spans[0]?.text, "RESULT before green shared expanded");
  assert.deepEqual(receivedResultContent, [
    { type: "text", text: "before" },
    { type: "image", mimeType: "image/png", data: "private-image-bytes" },
    { type: "text", text: "after" },
  ]);
  assert.equal(invalidations, 3);
  assert.equal(lifecycle.aborted, false);
  binding.reconcile?.(new Set());
  binding.reconcile?.(new Set());
  binding.dispose?.();
  assert.deepEqual(componentDisposals, ["first", "replacement"]);

  await host.close();
  assert.deepEqual(componentDisposals, ["first", "replacement"]);
  assert.equal(lifecycle.aborted, true);
  await rm(root, { recursive: true, force: true });
});

test("named and anonymous inline factories share the direct contract and become stale on close", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-inline-factory-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  let captured: unknown;
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [
      async (rigyn) => {
        await Promise.resolve();
        captured = rigyn;
        rigyn.registerCommand("anonymous", { async handler() {} });
      },
      {
        name: "named",
        factory(rigyn) {
          rigyn.registerCommand("named", { async handler() {} });
        },
      },
    ],
  });
  assert.deepEqual(host.commands().map((entry) => entry.name), ["anonymous", "named"]);
  await host.close();
  assert.throws(
    () => (captured as { getCommands(): unknown }).getCommands(),
    /no longer active|closed/u,
  );
});

test("Markdown transformers chain by extension order and isolate failures", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-markdown-transformers-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  let firstApi: ExtensionAPI | undefined;
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [
      {
        name: "first",
        factory(rigyn) {
          firstApi = rigyn;
          rigyn.registerMarkdownTransformer((markdown) => `first:${markdown}`);
        },
      },
      {
        name: "broken",
        factory(rigyn) {
          rigyn.registerMarkdownTransformer(() => {
            throw new Error("display failure");
          });
        },
      },
      {
        name: "last",
        factory(rigyn) {
          rigyn.registerMarkdownTransformer((markdown) => `${markdown}:last`);
        },
      },
    ],
  });
  context.after(async () => await host.close());

  const selectedContext = {
    messageType: "user" as const,
    isStreaming: false,
    availableWidth: 80,
  };
  assert.equal(host.transformMarkdown("body", selectedContext), "first:body:last");
  assert.match(host.diagnostics().map((entry) => entry.message).join("\n"), /display failure/u);

  firstApi!.registerMarkdownTransformer((markdown) => `replacement:${markdown}`);
  assert.equal(host.transformMarkdown("body", selectedContext), "replacement:body:last");
});

test("direct factories receive one bounded command, prompt, and skill discovery snapshot", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-discovery-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "index.mjs");
  await writeFile(sourcePath, `export default (api) => { globalThis.__rigynDiscoveryApi = api; };\n`);
  const host = await loadDirectExtensions([sourcePath], { workspace: root, activationFailure: "throw" });
  const expected: RuntimeDiscoveryView = {
    resources: [
      { kind: "command", source: "builtin", name: "refresh", syntax: "/refresh" },
      { kind: "prompt", name: "review", extensionId: "fixture" },
      {
        kind: "skill",
        name: "audit",
        description: "Audit changes",
        scope: "workspace",
        trusted: true,
        disableModelInvocation: false,
      },
    ],
    truncated: false,
    omitted: { commands: 0, prompts: 0, skills: 0 },
  };
  host.setDirectDiscoveryHandler(() => expected);
  const api = (globalThis as Record<string, any>).__rigynDiscoveryApi;
  try {
    const first = await api.getDiscoveryView();
    assert.deepEqual(first, expected);
    first.resources[0]!.name = "mutated";
    assert.deepEqual(await api.getDiscoveryView(), expected);
  } finally {
    await host.close();
    delete (globalThis as Record<string, unknown>).__rigynDiscoveryApi;
  }
  await assert.rejects(api.getDiscoveryView(), /no longer active|closed/u);
});
