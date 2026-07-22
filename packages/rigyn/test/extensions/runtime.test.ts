import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  appendDirectExtensions,
  loadDirectExtensions,
  type RuntimeExtensionHost,
  type RuntimeExtensionLoadOptions,
} from "../../src/extensions/runtime.js";
import type { ExtensionAPI } from "../../src/extensions/direct.js";
import { extensionSessionManager } from "../../src/extensions/session-contract.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import { createModels } from "../../src/providers/models.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { sha256 } from "../../src/tools/hash.js";
import { loadTestDirectExtensions } from "../helpers/direct-extension-loader.js";

async function workspace(context: TestContext, prefix = "rigyn-direct-runtime-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  return root;
}

async function loadSource(
  context: TestContext,
  source: string,
  options: RuntimeExtensionLoadOptions = { workspace: "" },
): Promise<{ host: RuntimeExtensionHost; root: string; sourcePath: string }> {
  const root = options.workspace === "" ? await workspace(context) : options.workspace;
  const sourcePath = join(root, "extension.mjs");
  await writeFile(sourcePath, source);
  const host = await loadTestDirectExtensions([{
    extensionId: "direct-runtime",
    sourcePath,
    sha256: sha256(source),
    trusted: true,
  }], { ...options, workspace: root });
  return { host, root, sourcePath };
}

function bindContext(host: RuntimeExtensionHost, root: string): void {
  const sessionManager = SessionManager.inMemory(root, { id: "direct-runtime-session" });
  host.setDirectContextHandler(() => ({
    sessionManager: extensionSessionManager(sessionManager),
    modelRegistry: new ModelRegistry(createModels()),
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => "runtime system prompt",
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
}

test("trusted modules activate only the direct factory registration contract", async (context) => {
  const source = `export default function (rigyn) {
    globalThis.__directRuntimeApi = rigyn;
    rigyn.registerTool({
      name: "probe_echo",
      label: "Probe echo",
      description: "Echo text",
      promptSnippet: "Echo deterministic text",
      promptGuidelines: ["Use probe_echo for deterministic echoes."],
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string" } }
      },
      async execute(_toolCallId, input) {
        return { content: [{ type: "text", text: "probe:" + input.text }], details: { source: "extension" } };
      }
    });
    rigyn.registerCommand("probe", { description: "Probe command", async handler() {} });
    rigyn.registerFlag("probe-mode", { type: "string", default: "ready" });
    rigyn.registerProvider("probe-provider", { name: "Probe", models: [] });
    rigyn.on("session_start", (event) => { globalThis.__directRuntimeStart = event.reason; });
  }\n`;
  const { host, root } = await loadSource(context, source, { workspace: "", activationFailure: "throw" });
  bindContext(host, root);
  context.after(async () => {
    await host.close();
    delete (globalThis as Record<string, unknown>).__directRuntimeApi;
    delete (globalThis as Record<string, unknown>).__directRuntimeStart;
  });

  assert.deepEqual(host.diagnostics(), []);
  assert.deepEqual(host.tools().map((tool) => tool.definition.name), ["probe_echo"]);
  assert.equal(host.tools()[0]?.definition.promptSnippet, "Echo deterministic text");
  assert.deepEqual(host.tools()[0]?.definition.promptGuidelines, ["Use probe_echo for deterministic echoes."]);
  assert.deepEqual(host.commands().map((command) => command.name), ["probe"]);
  assert.equal(host.flagValues().get("probe-mode"), "ready");
  assert.deepEqual(host.directProviderRegistrations().map((entry) => entry.name), ["probe-provider"]);
  await host.dispatch("session_start", { reason: "startup", threadId: "direct-runtime-session" });
  assert.equal((globalThis as Record<string, unknown>).__directRuntimeStart, "startup");

  const api = (globalThis as Record<string, any>).__directRuntimeApi;
  await host.close();
  assert.throws(() => api.getCommands(), /no longer active/u);
});

test("TypeScript relative imports and CommonJS factories use the same direct API", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-modules-");
  await writeFile(join(root, "helper.ts"), `export enum State { Ready = "ready" }\n`);
  const typescriptPath = join(root, "extension.ts");
  const typescriptSource = `
    import { State } from "./helper";
    export default function (rigyn: any) {
      rigyn.registerFlag("typescript-state", { type: "string", default: State.Ready });
    }
  `;
  await writeFile(typescriptPath, typescriptSource);
  const commonjsPath = join(root, "extension.cjs");
  const commonjsSource = `module.exports = function (rigyn) {
    rigyn.registerFlag("commonjs-state", { type: "string", default: "loaded" });
  };\n`;
  await writeFile(commonjsPath, commonjsSource);
  const host = await loadTestDirectExtensions([
    { extensionId: "typescript", sourcePath: typescriptPath, sha256: sha256(typescriptSource), trusted: true },
    { extensionId: "commonjs", sourcePath: commonjsPath, sha256: sha256(commonjsSource), trusted: true },
  ], { workspace: root, activationFailure: "throw" });
  context.after(async () => await host.close());

  assert.deepEqual(host.diagnostics(), []);
  assert.equal(host.flagValues().get("typescript-state"), "ready");
  assert.equal(host.flagValues().get("commonjs-state"), "loaded");
});

test("empty activation groups preserve caller cancellation", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-empty-cancel-");
  const loadController = new AbortController();
  const loadReason = new Error("empty load cancelled");
  loadController.abort(loadReason);
  await assert.rejects(
    loadDirectExtensions([], { workspace: root, signal: loadController.signal }),
    (cause: unknown) => cause === loadReason,
  );

  const host = await loadDirectExtensions([], { workspace: root });
  context.after(async () => await host.close());
  const appendController = new AbortController();
  const appendReason = new Error("empty append cancelled");
  appendController.abort(appendReason);
  await assert.rejects(
    appendDirectExtensions(host, [], { workspace: root, signal: appendController.signal }),
    (cause: unknown) => cause === appendReason,
  );
});

test("failed activation rolls back direct registrations and invalidates the candidate API", async (context) => {
  const source = `export default function (rigyn) {
    globalThis.__failedDirectRuntimeApi = rigyn;
    rigyn.registerCommand("must-not-commit", { async handler() {} });
    throw new Error("direct activation failed");
  }\n`;
  const { host } = await loadSource(context, source);
  context.after(async () => {
    await host.close();
    delete (globalThis as Record<string, unknown>).__failedDirectRuntimeApi;
  });

  assert.deepEqual(host.commands(), []);
  assert.match(host.diagnostics()[0]?.message ?? "", /direct activation failed/u);
  assert.throws(
    () => (globalThis as Record<string, any>).__failedDirectRuntimeApi.getCommands(),
    /no longer active/u,
  );
});

test("activation cleanup cannot replace the original factory failure with a late timeout", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-cleanup-classification-");
  const sourcePath = join(root, "extension.mjs");
  const source = `export default function (rigyn) {
    rigyn.onDispose(() => new Promise((resolve) => setTimeout(resolve, 80)));
    throw new Error("original activation failure");
  }\n`;
  await writeFile(sourcePath, source);

  await assert.rejects(loadTestDirectExtensions([{
    extensionId: "cleanup-classification",
    sourcePath,
    sha256: sha256(source),
    trusted: true,
  }], {
    workspace: root,
    activationFailure: "throw",
    activationTimeoutMs: 25,
    loadTimeoutMs: 5_000,
    shutdownTimeoutMs: 200,
  }), /original activation failure/u);
});

test("slow module load does not consume activation time and a suspended factory becomes stale", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-timeout-");
  const sourcePath = join(root, "timeout.mjs");
  const source = `await new Promise((resolve) => setTimeout(resolve, 75));
export default async function (rigyn) {
    globalThis.__timedOutDirectRuntimeApi = rigyn;
    await new Promise(() => {});
  }\n`;
  await writeFile(sourcePath, source);
  context.after(() => { delete (globalThis as Record<string, unknown>).__timedOutDirectRuntimeApi; });

  await assert.rejects(loadTestDirectExtensions([{
    extensionId: "timeout",
    sourcePath,
    sha256: sha256(source),
    trusted: true,
  }], {
    workspace: root,
    activationFailure: "throw",
    activationTimeoutMs: 25,
    loadTimeoutMs: 5_000,
  }), /activation timed out after 25ms/u);
  const timedOutApi = (globalThis as Record<string, any>).__timedOutDirectRuntimeApi;
  assert.ok(timedOutApi, "the factory must run after the slower module evaluation completes");
  assert.throws(
    () => timedOutApi.getCommands(),
    /no longer active/u,
  );
});

test("direct disposers run once in LIFO order after the API becomes stale and isolate failures", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-dispose-");
  const order: string[] = [];
  let capturedApi: import("../../src/extensions/direct.js").ExtensionAPI | undefined;
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [(api) => {
      capturedApi = api;
      api.onDispose(() => {
        order.push("first");
        assert.throws(() => api.getCommands(), /no longer active/u);
      });
      api.onDispose(() => {
        order.push("second");
        throw new Error("second cleanup failed");
      });
      api.onDispose(async () => {
        await Promise.resolve();
        order.push("third");
      });
    }],
  });

  await assert.rejects(host.close(), (cause: unknown) => {
    assert.ok(cause instanceof Error);
    assert.match(cause.message, /second cleanup failed/u);
    return true;
  });
  assert.deepEqual(order, ["third", "second", "first"]);
  assert.ok(capturedApi);
  const staleApi = capturedApi;
  assert.throws(() => staleApi.getCommands(), /no longer active/u);
  await host.close();
  assert.deepEqual(order, ["third", "second", "first"]);
});

test("a caller signal cannot disable the host shutdown-listener deadline", { timeout: 5_000 }, async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-shutdown-deadline-");
  let invoked = false;
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    shutdownTimeoutMs: 25,
    inlineExtensions: [{
      name: "shutdown-deadline",
      factory(api) {
        api.on("session_shutdown", async () => {
          invoked = true;
          await new Promise(() => {});
        });
      },
    }],
  });
  context.after(async () => await host.close());

  await assert.rejects(
    host.dispatch("session_shutdown", { reason: "quit" }, new AbortController().signal),
    /aborted|timeout/iu,
  );
  assert.equal(invoked, true);
});

test("failed and timed-out activations dispose staged resources in LIFO order", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-staged-dispose-");
  const failedOrder: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace: root,
    inlineExtensions: [(api) => {
      api.onDispose(() => { failedOrder.push("first"); });
      api.onDispose(() => {
        failedOrder.push("second");
        throw new Error("staged cleanup failed");
      });
      throw new Error("staged activation failed");
    }],
  });
  context.after(async () => await host.close());
  assert.deepEqual(failedOrder, ["second", "first"]);
  assert.equal(host.extensions().length, 0);
  assert.equal(host.diagnostics().some((entry) => /staged activation failed/u.test(entry.message)), true);
  assert.equal(host.diagnostics().some((entry) => /staged cleanup failed/u.test(entry.message)), true);

  const timedOutOrder: string[] = [];
  await assert.rejects(loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    activationTimeoutMs: 25,
    inlineExtensions: [{
      name: "timed-out-staged-disposer",
      async factory(api) {
        api.onDispose(() => { timedOutOrder.push("disposed"); });
        await new Promise(() => {});
      },
    }],
  }), /Aborted|timed out/iu);
  assert.deepEqual(timedOutOrder, ["disposed"]);
});

test("inline cleanup cannot replace the original factory failure with a late timeout", async (context) => {
  const root = await workspace(context, "rigyn-inline-runtime-cleanup-classification-");
  await assert.rejects(loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    activationTimeoutMs: 25,
    loadTimeoutMs: 5_000,
    shutdownTimeoutMs: 200,
    inlineExtensions: [{
      name: "cleanup-classification",
      factory(api) {
        api.onDispose(() => new Promise((resolve) => setTimeout(resolve, 80)));
        throw new Error("original inline activation failure");
      },
    }],
  }), /original inline activation failure/u);
});

test("inline data-path failures become diagnostics without invoking the factory", async (context) => {
  const root = await workspace(context, "rigyn-inline-runtime-data-path-");
  const dataRoot = join(root, "not-a-directory");
  await writeFile(dataRoot, "fixture");
  let invoked = false;
  const host = await loadDirectExtensions([], {
    workspace: root,
    dataRoot,
    inlineExtensions: [{
      name: "data-path-failure",
      factory() { invoked = true; },
    }],
  });
  context.after(async () => await host.close());

  assert.equal(invoked, false);
  assert.equal(host.extensions().length, 0);
  assert.equal(host.diagnostics().length, 1);
  assert.equal(host.diagnostics()[0]?.extensionId, "inline-data-path-failure");
});

test("diagnostic inline load timeout disposes the candidate and skips remaining factories", async (context) => {
  const root = await workspace(context, "rigyn-inline-runtime-load-timeout-");
  const order: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace: root,
    loadTimeoutMs: 2_000,
    activationTimeoutMs: 5_000,
    inlineExtensions: [{
      name: "load-timeout",
      async factory(api) {
        order.push("started");
        api.onDispose(() => { order.push("disposed"); });
        await new Promise(() => {});
      },
    }, {
      name: "must-not-run",
      factory() { order.push("unexpected"); },
    }],
  });
  context.after(async () => await host.close());

  assert.deepEqual(order, ["started", "disposed"]);
  assert.equal(host.extensions().length, 0);
  assert.match(host.diagnostics()[0]?.message ?? "", /load timed out after 2000ms/u);
});

test("external cancellation rejects inline activation after disposing and staling its candidate", async (context) => {
  const root = await workspace(context, "rigyn-inline-runtime-cancel-");
  const controller = new AbortController();
  const cancellation = Object.freeze({ kind: "external-inline-cancellation" });
  let capturedApi: ExtensionAPI | undefined;
  let disposals = 0;

  await assert.rejects(loadDirectExtensions([], {
    workspace: root,
    signal: controller.signal,
    loadTimeoutMs: 5_000,
    activationTimeoutMs: 2_000,
    inlineExtensions: [{
      name: "externally-cancelled",
      async factory(api) {
        capturedApi = api;
        api.onDispose(() => { disposals += 1; });
        setTimeout(() => controller.abort(cancellation), 25);
        await new Promise(() => {});
      },
    }],
  }), (cause: unknown) => cause === cancellation);

  assert.equal(disposals, 1);
  assert.ok(capturedApi);
  const staleApi = capturedApi;
  assert.throws(() => staleApi.getCommands(), /no longer active/u);
});

test("hash mismatches stay inert while reserved commands receive a namespaced invocation", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-invalid-");
  const changedPath = join(root, "changed.mjs");
  await writeFile(changedPath, "export default () => {};\n");
  const reservedPath = join(root, "reserved.mjs");
  const reservedSource = `export default (rigyn) => {
    rigyn.registerCommand("copy", { async handler() { globalThis.__reservedCommandRan = true; } });
  };\n`;
  await writeFile(reservedPath, reservedSource);

  const host = await loadTestDirectExtensions([
    { extensionId: "changed", sourcePath: changedPath, sha256: sha256("different"), trusted: true },
    { extensionId: "reserved", sourcePath: reservedPath, sha256: sha256(reservedSource), trusted: true },
  ], { workspace: root });
  context.after(async () => await host.close());

  bindContext(host, root);
  assert.deepEqual(host.commands().map((command) => [command.name, command.baseName]), [["copy:1", "copy"]]);
  assert.equal(host.hasCommand("copy"), false);
  assert.equal(host.hasCommand("copy:1"), true);
  assert.deepEqual(await host.runCommand("copy:1", {
    args: "",
    threadId: "direct-runtime-session",
    signal: new AbortController().signal,
  }), { handled: true });
  assert.equal((globalThis as Record<string, unknown>).__reservedCommandRan, true);
  assert.equal(host.diagnostics().length, 2);
  assert.equal(host.diagnostics().some((entry) => /changed after resolution/u.test(entry.message)), true);
  assert.equal(host.diagnostics().some((entry) => /command copy conflicts with a built-in command.*copy:1/u.test(entry.message)), true);
  delete (globalThis as Record<string, unknown>).__reservedCommandRan;
});

test("shared event topics accept arbitrary nonempty bounded strings", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-event-topic-");
  const captured: { events?: ExtensionAPI["events"] } = {};
  let received: unknown;
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "event-topic",
      factory(api) {
        captured.events = api.events;
        api.events.on("my:notification", (payload) => { received = payload; });
      },
    }],
  });
  context.after(async () => await host.close());

  const events = captured.events;
  if (events === undefined) throw new Error("Shared EventBus was not captured");
  events.emit("my:notification", { ready: true });
  assert.deepEqual(received, { ready: true });
  const dispose = events.on("x".repeat(1_024), () => undefined);
  dispose();
  assert.throws(() => events.on("", () => undefined), /non-empty/u);
  assert.throws(() => events.emit("contains\0nul", undefined), /contains NUL/u);
  assert.throws(() => events.emit("x".repeat(1_025), undefined), /1024 bytes/u);
});

test("direct tools may intentionally replace built-in tool names", async (context) => {
  const source = `export default (rigyn) => {
    rigyn.registerTool({
      name: "read",
      label: "Replacement read",
      description: "A direct replacement",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() { return { content: [{ type: "text", text: "replacement" }], details: {} }; }
    });
  };\n`;
  const { host } = await loadSource(context, source, { workspace: "", activationFailure: "throw" });
  context.after(async () => await host.close());
  assert.deepEqual(host.tools().map((tool) => tool.definition.name), ["read"]);
});
