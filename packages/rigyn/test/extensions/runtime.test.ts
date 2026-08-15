import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import { createEventBus, type EventBus } from "../../src/core/event-bus.js";
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
    thinkingLevel: "off",
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
    async refresh() {},
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
      constrainedSampling: { type: "json_schema", strict: "require" },
      loading: "deferred",
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
  assert.deepEqual(host.tools()[0]?.definition.constrainedSampling, {
    type: "json_schema",
    strict: "require",
  });
  assert.equal(host.tools()[0]?.definition.loading, "deferred");
  assert.deepEqual(host.commands().map((command) => command.name), ["probe"]);
  assert.equal(host.flagValues().get("probe-mode"), "ready");
  assert.deepEqual(host.directProviderRegistrations().map((entry) => entry.name), ["probe-provider"]);
  await host.dispatch("session_start", { reason: "startup", threadId: "direct-runtime-session" });
  assert.equal((globalThis as Record<string, unknown>).__directRuntimeStart, "startup");

  const api = (globalThis as Record<string, any>).__directRuntimeApi;
  await host.close();
  assert.throws(() => api.getCommands(), /no longer active/u);
});

test("tool registration rejects hostile schemas and grammar variants without invoking them", async (context) => {
  const cases = [
    {
      name: "schema",
      source: `const schema = Object.assign(Object.create({
        toJSON() {
          globalThis.__toolRegistrationBoundaryCalls += 1;
          return { type: "object" };
        }
      }), { type: "object" });
      export default (rigyn) => rigyn.registerTool({
        name: "hostile_schema",
        description: "hostile schema",
        parameters: schema,
        async execute() { return { content: [{ type: "text", text: "unsafe" }] }; }
      });\n`,
    },
    {
      name: "grammar",
      source: `const variants = {};
      Object.defineProperty(variants, "openai_lark", {
        enumerable: true,
        get() {
          globalThis.__toolRegistrationBoundaryCalls += 1;
          return "start: /x/";
        }
      });
      export default (rigyn) => rigyn.registerTool({
        name: "hostile_grammar",
        description: "hostile grammar",
        parameters: { type: "object" },
        constrainedSampling: { type: "grammar", variants },
        async execute() { return { content: [{ type: "text", text: "unsafe" }] }; }
      });\n`,
    },
  ];
  const globals = globalThis as Record<string, unknown>;
  globals.__toolRegistrationBoundaryCalls = 0;

  try {
    for (const selected of cases) {
      await assert.rejects(
        loadSource(context, selected.source, { workspace: "", activationFailure: "throw" })
          .then(async ({ host }) => await host.close()),
        /plain objects|enumerable data properties/u,
        selected.name,
      );
    }
    assert.equal(globals.__toolRegistrationBoundaryCalls, 0);
  } finally {
    delete globals.__toolRegistrationBoundaryCalls;
  }
});

test("message listeners never observe provider traces", async (context) => {
  const source = `export default function (rigyn) {
    globalThis.__directRuntimeEvents = [];
    rigyn.on("message_update", (entry) => {
      globalThis.__directRuntimeEvents.push(
        entry.assistantMessageEvent.type + ":" +
        entry.message.content.map((block) => block.type + ":" + (block.thinking ?? block.text ?? "")).join("|")
      );
    });
    rigyn.on("message_end", (entry) => {
      globalThis.__directRuntimeEvents.push(
        entry.message.content.map((block) => block.type + ":" + (block.thinking ?? block.text ?? "")).join("|")
      );
    });
  }\n`;
  const { host, root } = await loadSource(context, source, { workspace: "", activationFailure: "throw" });
  bindContext(host, root);
  context.after(async () => {
    await host.close();
    delete (globalThis as Record<string, unknown>).__directRuntimeEvents;
  });
  const base = {
    threadId: "thread_1",
    runId: "run_1",
    branch: "main",
    step: 1,
  };
  const message = {
    id: "message_1",
    role: "assistant" as const,
    createdAt: "2026-07-28T00:00:00.000Z",
    content: [
      { type: "thinking" as const, thinking: "private durable trace", visibility: "provider_trace" as const },
      { type: "thinking" as const, thinking: "public summary", visibility: "summary" as const },
      { type: "text" as const, text: "answer" },
    ],
  };
  await host.dispatch("message_update", {
    ...base,
    message,
    assistantMessageEvent: {
      type: "reasoning_completed" as const,
      part: 0,
      text: "private trace",
      visibility: "provider_trace",
    },
  } as never);
  await host.dispatch("message_update", {
    ...base,
    message,
    assistantMessageEvent: {
      type: "reasoning_completed" as const,
      part: 1,
      text: "public summary",
      visibility: "summary",
    },
  } as never);
  await host.dispatch("message_end", { ...base, message });
  assert.deepEqual((globalThis as Record<string, unknown>).__directRuntimeEvents, [
    "thinking_end:thinking:public summary|text:answer",
    "thinking:public summary|text:answer",
  ]);
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

test("direct cleanup contains hostile thrown objects without inspecting them", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-hostile-dispose-");
  let prototypeTrapCalls = 0;
  let conversionTrapCalls = 0;
  const hostileFailure = new Proxy({}, {
    getPrototypeOf() {
      prototypeTrapCalls += 1;
      throw new Error("cleanup failure prototype must not be inspected");
    },
    get(_target, property) {
      if (property === "toString" || property === Symbol.toPrimitive) conversionTrapCalls += 1;
      throw new Error("cleanup failure conversion must not be invoked");
    },
  });
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [(api) => {
      api.onDispose(() => { throw hostileFailure; });
    }],
  });

  await assert.rejects(host.close(), (cause: unknown) => {
    assert.ok(cause instanceof Error);
    assert.match(cause.message, /\[Thrown object\]/u);
    return true;
  });
  assert.equal(prototypeTrapCalls, 0);
  assert.equal(conversionTrapCalls, 0);
});

test("direct cleanup bounds huge failures and redacts secrets straddling the output cutoff", async (context) => {
  const hugeRoot = await workspace(context, "rigyn-direct-runtime-huge-dispose-");
  const hugeHost = await loadDirectExtensions([], {
    workspace: hugeRoot,
    activationFailure: "throw",
    inlineExtensions: [(api) => {
      api.onDispose(() => { throw new Error(`retained-${"x".repeat(4 * 1_024 * 1_024)}`); });
    }],
  });
  await assert.rejects(hugeHost.close(), (cause: unknown) => {
    assert.ok(cause instanceof Error);
    assert.equal(cause.message.startsWith("Runtime extension disposer cleanup failed: retained-"), true);
    assert.equal(Buffer.byteLength(cause.message, "utf8") <= 4_096, true);
    return true;
  });

  const marker = "LEAK-runtime-cleanup-cutoff-secret-";
  const secret = `${marker}${"s".repeat((64 * 1_024) - marker.length)}`;
  defaultSecretRedactor.register(secret);
  const straddlingRoot = await workspace(context, "rigyn-direct-runtime-secret-dispose-");
  const straddlingHost = await loadDirectExtensions([], {
    workspace: straddlingRoot,
    activationFailure: "throw",
    inlineExtensions: [(api) => {
      api.onDispose(() => { throw new Error(`${"p".repeat(4_050)}${secret}-tail`); });
    }],
  });
  await assert.rejects(straddlingHost.close(), (cause: unknown) => {
    assert.ok(cause instanceof Error);
    assert.equal(cause.message.includes(marker), false);
    assert.equal(Buffer.byteLength(cause.message, "utf8") <= 4_096, true);
    return true;
  });
});

test("command completion preserves a hostile abort reason without inspecting it", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-hostile-completion-abort-");
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [(api) => {
      api.registerCommand("complete", {
        getArgumentCompletions() { return new Promise(() => {}); },
        async handler() {},
      });
    }],
  });
  context.after(async () => await host.close());
  let prototypeTrapCalls = 0;
  const hostileReason = new Proxy({}, {
    getPrototypeOf() {
      prototypeTrapCalls += 1;
      throw new Error("abort reason prototype must not be inspected");
    },
  });
  const controller = new AbortController();
  controller.abort(hostileReason);

  await assert.rejects(
    host.completeCommandArguments("complete", "", controller.signal),
    (cause: unknown) => cause === hostileReason,
  );
  assert.equal(prototypeTrapCalls, 0);
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

test("successful lifecycle UI remains generation-owned after its dispatch deadline", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-ui-generation-");
  let status: string | undefined;
  let ownerSignal: AbortSignal | undefined;
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    shutdownTimeoutMs: 25,
    inlineExtensions: [{
      name: "generation-ui",
      factory(api) {
        api.on("session_start", (_event, runtime) => runtime.ui.setStatus("phase", "ready"));
      },
    }],
  });
  host.setDirectUiHandler((_extensionId, signal) => ({
    setStatus(_key: string, value: string | undefined) {
      ownerSignal = signal;
      status = value;
      signal.addEventListener("abort", () => { status = undefined; }, { once: true });
    },
  } as never));

  await host.dispatch("session_start", {});
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  assert.equal(status, "ready");
  assert.equal(ownerSignal?.aborted, false);

  await host.close();
  assert.equal(ownerSignal?.aborted, true);
  assert.equal(status, undefined);
});

test("in-flight listener cancellation still aborts its UI ownership", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-ui-cancellation-");
  let status: string | undefined;
  let ownerSignal: AbortSignal | undefined;
  let started!: () => void;
  const listenerStarted = new Promise<void>((resolve) => { started = resolve; });
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "cancelled-ui",
      factory(api) {
        api.on("agent_settled", async (_event, runtime) => {
          runtime.ui.setStatus("phase", "waiting");
          started();
          await new Promise(() => {});
        });
      },
    }],
  });
  context.after(async () => await host.close());
  host.setDirectUiHandler((_extensionId, signal) => ({
    setStatus(_key: string, value: string | undefined) {
      ownerSignal = signal;
      status = value;
      signal.addEventListener("abort", () => { status = undefined; }, { once: true });
    },
  } as never));
  const caller = new AbortController();
  const dispatch = host.dispatch("agent_settled", {
    threadId: "thread-1",
    runId: "run-1",
    branch: "main",
    outcome: { status: "completed", finishReason: "stop" },
    messages: [],
    messagesTruncated: false,
  }, caller.signal);

  await listenerStarted;
  assert.equal(status, "waiting");
  caller.abort(new Error("caller cancelled"));
  await assert.rejects(dispatch, /caller cancelled/u);
  assert.equal(ownerSignal?.aborted, true);
  assert.equal(status, undefined);
  assert.equal(host.lifecycleSignal().aborted, false);
});

test("repeated callbacks expose one stable direct UI generation owner", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-ui-owner-");
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "stable-ui-owner",
      factory(api) {
        api.on("agent_settled", () => undefined);
      },
    }],
  });
  context.after(async () => await host.close());
  let callbackCount = 0;
  let previousCallbackSignal: AbortSignal | undefined;
  const generationSignals = new Set<AbortSignal>();
  host.setDirectUiHandler((_extensionId, callbackSignal, _ownerKey, generationSignal) => {
    assert.notEqual(callbackSignal, previousCallbackSignal);
    previousCallbackSignal = callbackSignal;
    callbackCount += 1;
    generationSignals.add(generationSignal);
    assert.notEqual(callbackSignal, generationSignal);
    return {} as never;
  });
  const event = {
    threadId: "thread-1",
    runId: "run-1",
    branch: "main",
    outcome: { status: "completed" as const, finishReason: "stop" as const },
    messages: [],
    messagesTruncated: false,
  };

  for (let index = 0; index < 1_000; index += 1) {
    await host.dispatch("agent_settled", event, new AbortController().signal);
  }

  assert.equal(callbackCount, 1_000);
  assert.equal(generationSignals.size, 1);
  assert.ok([...generationSignals][0] instanceof AbortSignal);
});

test("session shutdown listeners settle in extension load and registration order", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-shutdown-order-");
  const order: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [
      {
        name: "shutdown-first",
        factory(api) {
          api.on("session_shutdown", async () => {
            order.push("first:start");
            await new Promise<void>((resolve) => setImmediate(resolve));
            order.push("first:end");
          });
        },
      },
      {
        name: "shutdown-second",
        factory(api) {
          api.on("session_shutdown", () => { order.push("second"); });
        },
      },
    ],
  });
  context.after(async () => await host.close());

  await host.dispatch("session_shutdown", { reason: "quit" });
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

test("owner-aware direct UI takes precedence over the compatibility session fallback", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-ui-precedence-");
  const directOwners: string[] = [];
  let sessionStatuses = 0;
  const listener = (api: ExtensionAPI): void => {
    api.on("session_start", (_event, runtime) => runtime.ui.setStatus("phase", "ready"));
  };
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [
      { name: "Alpha", factory: listener },
      { name: "alpha", factory: listener },
    ],
  });
  context.after(async () => await host.close());
  host.setSessionUiHandler(() => ({
    setStatus() { sessionStatuses += 1; },
  } as never));
  host.setDirectUiHandler((_extensionId, _signal, ownerKey) => ({
    setStatus() { directOwners.push(ownerKey); },
  } as never));

  await host.dispatch("session_start", {});
  assert.equal(new Set(directOwners).size, 2);
  assert.equal(sessionStatuses, 0);

  host.setDirectUiHandler(undefined);
  await host.dispatch("session_start", {});
  assert.equal(sessionStatuses, 2);
});

test("invalid command objects and handlers roll back their activation transactions", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-invalid-command-");
  let disposed = 0;
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "diagnostic",
    inlineExtensions: [
      {
        name: "invalid-command-object",
        factory(api) {
          api.onDispose(() => { disposed += 1; });
          api.registerFlag("staged-flag", { type: "boolean", default: true });
          api.registerCommand("broken-object", null as never);
        },
      },
      {
        name: "invalid-command-handler",
        factory(api) {
          api.onDispose(() => { disposed += 1; });
          api.registerFlag("staged-flag", { type: "boolean", default: true });
          api.registerCommand("broken-handler", { handler: 42 } as never);
        },
      },
    ],
  });
  context.after(async () => await host.close());

  assert.equal(disposed, 2);
  assert.deepEqual(host.extensions(), []);
  assert.deepEqual(host.commands(), []);
  assert.deepEqual(host.flags(), []);
  assert.equal(host.diagnostics().some((entry) => /command registration must be an object/iu.test(entry.message)), true);
  assert.equal(host.diagnostics().some((entry) => /command handler must be a function/iu.test(entry.message)), true);
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

test("activation publishes shared listeners and emissions atomically", async (context) => {
  const cases: Array<{ name: string; eventBus?: EventBus }> = [
    { name: "host-local" },
    { name: "supplied", eventBus: createEventBus() },
  ];

  for (const selected of cases) {
    await context.test(selected.name, async (nested) => {
      const root = await workspace(nested, `rigyn-direct-runtime-event-transaction-${selected.name}-`);
      const observed: string[] = [];
      const describe = (owner: string, payload: unknown): string => {
        const value = payload !== null && typeof payload === "object" && "value" in payload
          ? String(payload.value)
          : String(payload);
        return `${owner}:${value}`;
      };
      const host = await loadDirectExtensions([], {
        workspace: root,
        activationFailure: "diagnostic",
        ...(selected.eventBus === undefined ? {} : { eventBus: selected.eventBus }),
        inlineExtensions: [
          {
            name: "committed-listener",
            factory(rigyn) {
              rigyn.events.on("audit:transaction", (payload) => {
                observed.push(describe("committed", payload));
              });
            },
          },
          {
            name: "rejected-emitter",
            factory(rigyn) {
              rigyn.events.on("audit:transaction", (payload) => {
                observed.push(describe("rejected", payload));
              });
              rigyn.events.emit("audit:transaction", "rollback");
              throw new Error("candidate rejected after emit");
            },
          },
          {
            name: "committed-emitter",
            factory(rigyn) {
              const disposeBeforeCommit = rigyn.events.on("audit:transaction", (payload) => {
                observed.push(describe("disposed", payload));
              });
              disposeBeforeCommit();
              rigyn.events.on("audit:transaction", (payload) => {
                observed.push(describe("candidate", payload));
              });
              const first = { value: "first" };
              rigyn.events.emit("audit:transaction", first);
              first.value = "mutated-after-emit";
              const array = ["array"];
              rigyn.events.emit("audit:transaction", array);
              array[0] = "mutated-after-emit";
              rigyn.events.emit("audit:transaction", "second");
            },
          },
        ],
      });
      nested.after(async () => await host.close());

      assert.deepEqual(observed, [
        "committed:first",
        "candidate:first",
        "committed:array",
        "candidate:array",
        "committed:second",
        "candidate:second",
      ]);
      assert.deepEqual(host.extensions().map((entry) => entry.extensionId), [
        "inline-committed-listener",
        "inline-committed-emitter",
      ]);
      assert.equal(host.diagnostics().some((entry) => /candidate rejected after emit/u.test(entry.message)), true);
    });
  }
});

test("activation bounds the staged shared event queue", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-event-bounds-");
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    inlineExtensions: [
      {
        name: "count-bound",
        factory(rigyn) {
          assert.throws(
            () => rigyn.events.emit("audit:bounds", () => undefined),
            /payload must contain only JSON values/u,
          );
          assert.throws(
            () => rigyn.events.emit("audit:bounds", "x".repeat(1024 * 1024)),
            /payload exceeds 1048576 (?:UTF-8 )?bytes/u,
          );
          assert.throws(
            () => rigyn.events.emit("audit:bounds", "\0".repeat(200_000)),
            /payload exceeds 1048576 (?:UTF-8 )?bytes/u,
          );
          for (let index = 0; index < 1_024; index += 1) rigyn.events.emit("audit:bounds", null);
          assert.throws(
            () => rigyn.events.emit("audit:bounds", null),
            /emissions exceed 1024/u,
          );
        },
      },
      {
        name: "aggregate-byte-bound",
        factory(rigyn) {
          const maximumPayload = "x".repeat((1024 * 1024) - 2);
          for (let index = 0; index < 4; index += 1) {
            rigyn.events.emit("audit:bounds", maximumPayload);
          }
          assert.throws(
            () => rigyn.events.emit("audit:bounds", "x"),
            /payloads exceed 4194304 bytes/u,
          );
        },
      },
      {
        name: "shape-bounds",
        factory(rigyn) {
          assert.throws(
            () => rigyn.events.emit("audit:bounds", new Array(8_192).fill(null)),
            /exceeds 8192 JSON values/u,
          );
          assert.throws(
            () => rigyn.events.emit("audit:bounds", Array.from({ length: 4_096 }, () => ({}))),
            /exceeds 4096 (?:JSON )?containers/u,
          );
          let deep: Record<string, unknown> = {};
          for (let depth = 0; depth <= 59; depth += 1) deep = { child: deep };
          assert.throws(
            () => rigyn.events.emit("audit:bounds", deep as never),
            /exceeds 59 levels/u,
          );
          let accessorCalls = 0;
          const accessorPayload = Object.create(null) as Record<string, unknown>;
          Object.defineProperty(accessorPayload, "value", {
            enumerable: true,
            get() {
              accessorCalls += 1;
              return "must-not-run";
            },
          });
          assert.throws(
            () => rigyn.events.emit("audit:bounds", accessorPayload as never),
            /enumerable data properties/u,
          );
          assert.equal(accessorCalls, 0);

          let toJsonCalls = 0;
          const inheritedToJson = Object.assign(Object.create({
            toJSON() {
              toJsonCalls += 1;
              return { value: "must-not-run" };
            },
          }) as Record<string, unknown>, { value: "ready" });
          assert.throws(
            () => rigyn.events.emit("audit:bounds", inheritedToJson as never),
            /plain objects and (?:vanilla )?arrays/u,
          );
          assert.equal(toJsonCalls, 0);

          const sparse = new Array(1);
          assert.throws(
            () => rigyn.events.emit("audit:bounds", sparse as never),
            /dense arrays without extra properties/u,
          );
          const symbolPayload = { value: "ready" } as Record<PropertyKey, unknown>;
          symbolPayload[Symbol("hidden")] = true;
          assert.throws(
            () => rigyn.events.emit("audit:bounds", symbolPayload as never),
            /symbol keys/u,
          );
          const cyclic: Record<string, unknown> = {};
          cyclic.self = cyclic;
          assert.throws(
            () => rigyn.events.emit("audit:bounds", cyclic as never),
            /must not contain cycles/u,
          );
        },
      },
    ],
  });
  context.after(async () => await host.close());

  assert.deepEqual(host.diagnostics(), []);
});

test("the default supplied event bus treats error as an ordinary activation and live topic", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-event-error-topic-");
  let events: ExtensionAPI["events"] | undefined;
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    eventBus: createEventBus(),
    inlineExtensions: [{
      name: "error-emitter",
      factory(rigyn) {
        events = rigyn.events;
        rigyn.events.emit("error", { phase: "activation" });
      },
    }],
  });
  context.after(async () => await host.close());

  assert.deepEqual(host.extensions().map((entry) => entry.extensionId), ["inline-error-emitter"]);
  assert.deepEqual(host.diagnostics(), []);
  const capturedEvents = events;
  if (capturedEvents === undefined) throw new Error("Shared event API was not captured");
  assert.doesNotThrow(() => capturedEvents.emit("error", { phase: "live-without-listener" }));
  let live: unknown;
  capturedEvents.on("error", (payload) => { live = payload; });
  capturedEvents.emit("error", { phase: "live" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(live, { phase: "live" });
});

test("a supplied event bus cannot leave a half-committed generation", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-event-bus-failure-");
  const sourcePath = join(root, "candidate.mjs");
  await writeFile(sourcePath, `export default (rigyn) => {
    rigyn.events.on("audit:first", () => undefined);
    rigyn.events.on("audit:reject", () => undefined);
    rigyn.registerCommand("must-not-commit", { handler() {} });
  };\n`);
  let activeListeners = 0;
  let unsubscriptions = 0;
  const eventBus: EventBus = {
    emit() {},
    on(topic) {
      if (topic === "audit:reject") throw new Error("supplied bus rejected subscription");
      activeListeners += 1;
      return () => {
        activeListeners -= 1;
        unsubscriptions += 1;
      };
    },
  };
  const host = await loadDirectExtensions([], { workspace: root });
  context.after(async () => await host.close());

  await assert.rejects(
    appendDirectExtensions(host, [sourcePath], {
      workspace: root,
      activationFailure: "throw",
      eventBus,
    }),
    /supplied bus rejected subscription/u,
  );
  assert.equal(activeListeners, 0);
  assert.equal(unsubscriptions, 1);
  assert.deepEqual(host.extensions(), []);
  assert.deepEqual(host.commands(), []);
});

test("a supplied event bus with an invalid unsubscribe result rejects and rolls back the candidate", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-event-bus-unsubscribe-");
  const sourcePath = join(root, "candidate.mjs");
  await writeFile(sourcePath, `export default (rigyn) => {
    rigyn.events.on("audit:first", () => undefined);
    rigyn.events.on("audit:invalid", () => undefined);
    rigyn.registerCommand("must-not-commit", { handler() {} });
  };\n`);
  let activeListeners = 0;
  let unsubscriptions = 0;
  const eventBus: EventBus = {
    emit() {},
    on(topic) {
      if (topic === "audit:invalid") return undefined as never;
      activeListeners += 1;
      return () => {
        activeListeners -= 1;
        unsubscriptions += 1;
      };
    },
  };
  const host = await loadDirectExtensions([], { workspace: root });

  await assert.rejects(
    appendDirectExtensions(host, [sourcePath], {
      workspace: root,
      activationFailure: "throw",
      eventBus,
    }),
    /unsubscribe function/u,
  );
  assert.equal(activeListeners, 0);
  assert.equal(unsubscriptions, 1);
  assert.deepEqual(host.extensions(), []);
  assert.deepEqual(host.commands(), []);
  await assert.doesNotReject(host.close());
});

test("a reentrant supplied event bus cannot leak a live subscription while closing the host", async () => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-direct-runtime-event-bus-reentrant-"));
  let sharedEvents: ExtensionAPI["events"] | undefined;
  let closeHost: (() => Promise<void>) | undefined;
  let closePromise: Promise<void> | undefined;
  let activeListeners = 0;
  let unsubscriptions = 0;
  const eventBus: EventBus = {
    emit() {},
    on() {
      activeListeners += 1;
      closePromise = closeHost?.();
      return () => {
        activeListeners -= 1;
        unsubscriptions += 1;
      };
    },
  };
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    eventBus,
    inlineExtensions: [{
      name: "reentrant-event-bus",
      factory(rigyn) { sharedEvents = rigyn.events; },
    }],
  });
  closeHost = async () => await host.close();

  const capturedEvents = sharedEvents;
  if (capturedEvents === undefined) throw new Error("Shared event API was not captured");
  assert.throws(
    () => capturedEvents.on("audit:reentrant", () => undefined),
    /Runtime extension host is closed/u,
  );
  await closePromise;
  assert.equal(activeListeners, 0);
  assert.equal(unsubscriptions, 1);
  await rm(root, { recursive: true, force: true });
});

test("pre-commit shared event disposal releases staged accounting and preserves the active listener cap", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-event-bus-disposed-staging-");
  let sharedEvents: ExtensionAPI["events"] | undefined;
  let disposeActive: (() => void) | undefined;
  let activeListeners = 0;
  let subscriptions = 0;
  let unsubscriptions = 0;
  const eventBus: EventBus = {
    emit() {},
    on() {
      activeListeners += 1;
      subscriptions += 1;
      return () => {
        activeListeners -= 1;
        unsubscriptions += 1;
      };
    },
  };
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    eventBus,
    inlineExtensions: [{
      name: "disposed-staged-events",
      factory(rigyn) {
        sharedEvents = rigyn.events;
        for (let index = 0; index < 2_000; index += 1) {
          const retained = new Array<number>(128).fill(index);
          const dispose = rigyn.events.on(`audit:disposed:${index}`, () => { void retained[0]; });
          dispose();
        }
        for (let index = 0; index < 1_024; index += 1) {
          const dispose = rigyn.events.on(`audit:active:${index}`, () => undefined);
          if (index === 0) disposeActive = dispose;
        }
      },
    }],
  });
  context.after(async () => await host.close());

  assert.equal(subscriptions, 1_024);
  assert.equal(activeListeners, 1_024);
  const capturedEvents = sharedEvents;
  if (capturedEvents === undefined || disposeActive === undefined) {
    throw new Error("Shared event API or disposer was not captured");
  }
  assert.throws(
    () => capturedEvents.on("audit:over-cap", () => undefined),
    /listeners exceed 1024/u,
  );
  disposeActive();
  capturedEvents.on("audit:replacement", () => undefined);
  assert.equal(subscriptions, 1_025);
  assert.equal(activeListeners, 1_024);
  await host.close();
  assert.equal(activeListeners, 0);
  assert.equal(unsubscriptions, 1_025);
});

test("live shared event emissions are bounded detached snapshots on local and supplied buses", async (context) => {
  for (const selected of ["host-local", "supplied"] as const) {
    await context.test(selected, async (nested) => {
      const root = await workspace(nested, `rigyn-direct-runtime-live-event-${selected}-`);
      const observed: unknown[] = [];
      let sharedEvents: ExtensionAPI["events"] | undefined;
      const host = await loadDirectExtensions([], {
        workspace: root,
        activationFailure: "throw",
        ...(selected === "supplied" ? { eventBus: createEventBus() } : {}),
        inlineExtensions: [
          {
            name: "live-listener",
            factory(rigyn) {
              rigyn.events.on("audit:live-snapshot", async (payload) => {
                await new Promise((resolve) => setImmediate(resolve));
                observed.push(payload);
              });
            },
          },
          {
            name: "live-emitter",
            factory(rigyn) { sharedEvents = rigyn.events; },
          },
        ],
      });
      nested.after(async () => await host.close());
      const capturedEvents = sharedEvents;
      if (capturedEvents === undefined) throw new Error("Shared event API was not captured");

      const mutable = { value: "before" };
      capturedEvents.emit("audit:live-snapshot", mutable);
      mutable.value = "after";
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(observed, [{ value: "before" }]);

      let toJsonCalls = 0;
      const hostile = Object.assign(Object.create({
        toJSON() {
          toJsonCalls += 1;
          return { rewritten: true };
        },
      }) as Record<string, unknown>, { value: "ready" });
      assert.throws(
        () => capturedEvents.emit("audit:live-snapshot", hostile),
        /plain objects and (?:vanilla )?arrays/u,
      );
      assert.throws(
        () => capturedEvents.emit("audit:live-snapshot", "x".repeat((1024 * 1024) + 1)),
        /exceeds 1048576 (?:UTF-8 )?bytes/u,
      );
      assert.equal(toJsonCalls, 0);
      assert.equal(observed.length, 1);
    });
  }
});

test("supplied event bus inbound payloads are validated before extension listeners run", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-event-bus-inbound-payload-");
  let deliver: ((payload: unknown) => void | Promise<void>) | undefined;
  let listenerCalls = 0;
  const eventBus: EventBus = {
    emit() {},
    on(_topic, handler) {
      deliver = (payload) => handler(payload as never);
      return () => undefined;
    },
  };
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    eventBus,
    inlineExtensions: [{
      name: "inbound-listener",
      factory(rigyn) {
        rigyn.events.on("audit:inbound", () => { listenerCalls += 1; });
      },
    }],
  });
  context.after(async () => await host.close());
  const capturedDeliver = deliver;
  if (capturedDeliver === undefined) throw new Error("Supplied bus handler was not captured");

  let toJsonCalls = 0;
  const hostile = Object.assign(Object.create({
    toJSON() {
      toJsonCalls += 1;
      return { rewritten: true };
    },
  }) as Record<string, unknown>, { value: "ready" });
  const diagnosticsBefore = host.diagnostics().length;
  await capturedDeliver(hostile);
  assert.equal(toJsonCalls, 0);
  assert.equal(listenerCalls, 0);
  assert.equal(host.diagnostics().length, diagnosticsBefore + 1);
  assert.match(host.diagnostics().at(-1)?.message ?? "", /shared event audit:inbound/u);
});

test("a supplied event bus emit failure is isolated after commit", async (context) => {
  const root = await workspace(context, "rigyn-direct-runtime-event-bus-emit-failure-");
  let unsubscriptions = 0;
  const eventBus: EventBus = {
    emit() { throw new Error("supplied bus rejected emission"); },
    on() {
      return () => { unsubscriptions += 1; };
    },
  };
  const host = await loadDirectExtensions([], {
    workspace: root,
    activationFailure: "throw",
    eventBus,
    inlineExtensions: [{
      name: "emit-failure",
      factory(rigyn) {
        rigyn.events.on("audit:emit", () => undefined);
        rigyn.events.emit("audit:emit", { ready: true });
      },
    }],
  });

  assert.deepEqual(host.extensions().map((entry) => entry.extensionId), ["inline-emit-failure"]);
  assert.equal(host.diagnostics().some((entry) => /supplied bus rejected emission/u.test(entry.message)), true);
  await host.close();
  assert.equal(unsubscriptions, 1);
});

test("closing a runtime extension host detaches diagnostic observers", async (context) => {
  const { host } = await loadSource(context, "export default () => {};\n", {
    workspace: "",
    activationFailure: "throw",
  });
  const observed: string[] = [];
  host.onError((diagnostic) => observed.push(diagnostic.message));

  host.addDiagnostic({ extensionId: "probe", sourcePath: "", message: "before close" });
  assert.deepEqual(observed, ["before close"]);

  await host.close();
  host.addDiagnostic({ extensionId: "probe", sourcePath: "", message: "after close" });
  assert.deepEqual(observed, ["before close"]);
  assert.deepEqual(host.diagnostics().map((diagnostic) => diagnostic.message), ["before close", "after close"]);
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

test("direct extension tools accept nullable array parameters", async (context) => {
  const source = `export default (rigyn) => {
    rigyn.registerTool({
      name: "nullable_array",
      label: "Nullable array",
      description: "Accept an array or null",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["values"],
        properties: {
          values: { type: ["array", "null"], items: { type: "string" } }
        }
      },
      async execute() {
        return { content: [{ type: "text", text: "accepted" }], details: {} };
      }
    });
  };\n`;
  const { host } = await loadSource(context, source, { workspace: "", activationFailure: "throw" });
  context.after(async () => await host.close());
  const tool = host.tools()[0];
  assert.ok(tool);
  assert.doesNotThrow(() => tool.validate({ values: null }));
  assert.doesNotThrow(() => tool.validate({ values: ["ready"] }));
  assert.throws(() => tool.validate({ values: [{}] }), /must be string/u);
});
