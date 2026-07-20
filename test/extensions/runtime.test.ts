import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { EventEnvelope } from "../../src/core/events.js";
import { loadRuntimeExtensions } from "../../src/extensions/runtime.js";
import { MAX_TOOL_TRANSFORMATION_AUDIT_ENTRIES } from "../../src/tools/coordinator.js";
import { sha256 } from "../../src/tools/hash.js";

const renderContext = {
  width: 20,
  height: 10,
  focused: false,
  expanded: false,
  theme: { name: "dark" as const, color: true, unicode: true },
};

function observedEvent(): EventEnvelope {
  return {
    eventId: "event-runtime-test",
    threadId: "thread-runtime-test",
    sequence: 1,
    timestamp: "2026-07-10T00:00:00.000Z",
    schemaVersion: 1,
    event: { type: "warning", code: "runtime_test", message: "runtime event fixture" },
  };
}

test("trusted TypeScript runtime registers tools, commands, provider, UI, events, and cleanup", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "extension.ts");
  const source = `
export default function activate(api: any) {
  api.registerTool({
    name: "probe_echo",
    description: "Echo text",
    loading: "deferred",
    promptSnippet: "Echo a small piece of text",
    promptGuidelines: ["Use probe_echo when the user asks for a deterministic echo."],
    inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } },
    execute(input: any) { return { content: "probe:" + input.text, isError: false, metadata: { extension: api.extensionId } }; }
  });
  api.registerCommand({ name: "probe", description: "Probe command", argumentHint: "<text>", execute(ctx: any) { ctx.ui.notify("ran:" + ctx.args); return { prompt: "prompt:" + ctx.args }; } });
  api.registerProvider({ id: "probe-provider", async *stream() {}, async listModels() { return []; } });
  api.registerProviderAuth({ provider: "probe-provider", displayName: "Probe Provider", methods: [{ kind: "api_key", label: "Probe key" }] });
  api.ui.setStatus("ready", "probe ready");
  api.ui.setWidget("panel", "probe widget");
  api.ui.setHeader("summary", "probe header");
  api.ui.setFooter("summary", "probe footer");
  api.ui.setWorkingMessage("probe working");
  api.ui.setWorkingVisible(false);
  api.ui.setTitle("probe title");
  api.ui.notify("probe loaded");
  api.on("event", (value: any) => { globalThis.__runtimeProbeEvent = value; });
  api.onDispose(() => { globalThis.__runtimeProbeDisposed = true; });
}`;
  await writeFile(path, source);
  const host = await loadRuntimeExtensions([{ extensionId: "probe", sourcePath: path, sha256: sha256(source) }], { workspace: root });

  assert.deepEqual(host.diagnostics(), []);
  assert.deepEqual(host.tools().map((tool) => tool.definition.name), ["probe_echo"]);
  assert.deepEqual(host.tools()[0]?.definition.promptGuidelines, [
    "Use probe_echo when the user asks for a deterministic echo.",
  ]);
  assert.equal(host.tools()[0]?.definition.promptSnippet, "Echo a small piece of text");
  assert.equal(host.tools()[0]?.definition.loading, "deferred");
  assert.deepEqual(host.providers().map((provider) => provider.id), ["probe-provider"]);
  assert.deepEqual(host.providerAuth().map((entry) => [entry.descriptor.provider, entry.descriptor.displayName]), [["probe-provider", "Probe Provider"]]);
  assert.deepEqual(host.commands().map((command) => command.name), ["probe"]);
  assert.deepEqual(host.initialUi().map((entry) => entry.type), ["status", "widget", "header", "footer", "working_message", "working_visible", "title", "notify"]);
  const notices: string[] = [];
  const command = await host.runCommand("probe", {
    args: "hello",
    threadId: "thread",
    signal: new AbortController().signal,
    ui: {
      notify: (message) => notices.push(message),
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
    },
  });
  assert.deepEqual(command, { handled: true, prompt: "prompt:hello" });
  assert.deepEqual(notices, ["ran:hello"]);
  await host.dispatch("event", observedEvent());
  assert.deepEqual((globalThis as Record<string, unknown>).__runtimeProbeEvent, observedEvent());
  await host.close();
  assert.equal((globalThis as Record<string, unknown>).__runtimeProbeDisposed, true);
  delete (globalThis as Record<string, unknown>).__runtimeProbeEvent;
  delete (globalThis as Record<string, unknown>).__runtimeProbeDisposed;
});

test("activation-time provider registration returns an idempotent owner disposer", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-provider-disposer-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "provider-disposer.mjs");
  const source = `export default (api) => {
    globalThis.__runtimeProviderDisposer = api.registerProvider({
      id: "owned-provider",
      async *stream() {},
      async listModels() { return []; }
    });
    api.registerProviderAuth({ provider: "owned-provider", methods: [{ kind: "api_key" }] });
  };\n`;
  await writeFile(path, source);
  const host = await loadRuntimeExtensions([{ extensionId: "provider-owner", sourcePath: path, sha256: sha256(source) }], { workspace: root });
  const removed: string[] = [];
  host.setLiveRegistrationHandler({
    registerTool() {},
    registerProvider() {},
    unregisterProvider(provider) { removed.push(provider.id); },
    registerProviderAuth() {},
    async fetchProvider() { throw new Error("not used"); },
  });
  assert.deepEqual(host.providers().map((provider) => provider.id), ["owned-provider"]);
  const dispose = (globalThis as Record<string, any>).__runtimeProviderDisposer;
  await dispose();
  await dispose();
  assert.deepEqual(removed, ["owned-provider"]);
  assert.deepEqual(host.providers(), []);
  assert.deepEqual(host.providerAuth(), []);
  await host.close();
  delete (globalThis as Record<string, unknown>).__runtimeProviderDisposer;
});

test("disposing a provider during activation removes its staged auth atomically", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-staged-provider-disposer-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "staged-provider-disposer.mjs");
  const source = `export default async (api) => {
    const dispose = api.registerProvider({
      id: "staged-provider",
      async *stream() {},
      async listModels() { return []; }
    });
    api.registerProviderAuth({ provider: "staged-provider", methods: [{ kind: "api_key" }] });
    await dispose();
  };\n`;
  await writeFile(path, source);
  const host = await loadRuntimeExtensions([{ extensionId: "staged-provider-owner", sourcePath: path, sha256: sha256(source) }], { workspace: root });
  assert.deepEqual(host.providers(), []);
  assert.deepEqual(host.providerAuth(), []);
  await host.close();
});

test("loose CommonJS-scoped TypeScript entries re-evaluate across generations", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-loose-ts-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "extension.ts");
  const activate = (value: string) => `
globalThis.__runtimeLooseTs = ${JSON.stringify(value)};
export default function activate(api: any) { api.ui.setStatus("loose", ${JSON.stringify(value)}); }
`;

  const firstSource = activate("first");
  await writeFile(path, firstSource);
  const first = await loadRuntimeExtensions([{
    extensionId: "loose-typescript",
    sourcePath: path,
    sha256: sha256(firstSource),
  }], { workspace: root });
  assert.deepEqual(first.diagnostics(), []);
  assert.equal((globalThis as Record<string, unknown>).__runtimeLooseTs, "first");
  await first.close();

  const secondSource = activate("second");
  await writeFile(path, secondSource);
  const second = await loadRuntimeExtensions([{
    extensionId: "loose-typescript",
    sourcePath: path,
    sha256: sha256(secondSource),
  }], { workspace: root });
  assert.deepEqual(second.diagnostics(), []);
  assert.equal((globalThis as Record<string, unknown>).__runtimeLooseTs, "second");
  await second.close();
  delete (globalThis as Record<string, unknown>).__runtimeLooseTs;
});

test("loose CommonJS module.exports entries activate and re-evaluate across generations", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-loose-cjs-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "extension.js");
  const activate = (value: string) => `
module.exports = function activate(api) {
  globalThis.__runtimeLooseCjs = ${JSON.stringify(value)};
  api.ui.setStatus("loose-cjs", ${JSON.stringify(value)});
};
`;

  const firstSource = activate("first");
  await writeFile(path, firstSource);
  const first = await loadRuntimeExtensions([{
    extensionId: "loose-commonjs",
    sourcePath: path,
    sha256: sha256(firstSource),
  }], { workspace: root });
  assert.deepEqual(first.diagnostics(), []);
  assert.equal((globalThis as Record<string, unknown>).__runtimeLooseCjs, "first");
  assert.deepEqual(first.initialUi().map(({ type, key, value }) => ({ type, key, value })), [{
    type: "status",
    key: "loose-cjs",
    value: "first",
  }]);
  await first.close();

  const secondSource = activate("second");
  await writeFile(path, secondSource);
  const second = await loadRuntimeExtensions([{
    extensionId: "loose-commonjs",
    sourcePath: path,
    sha256: sha256(secondSource),
  }], { workspace: root });
  assert.deepEqual(second.diagnostics(), []);
  assert.equal((globalThis as Record<string, unknown>).__runtimeLooseCjs, "second");
  assert.equal(second.initialUi()[0]?.value, "second");
  await second.close();
  delete (globalThis as Record<string, unknown>).__runtimeLooseCjs;
});

test("durable event observers cannot see provider-private or foreign extension payloads", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-observed-redaction-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const source = `
export default function activate(api) {
  api.on("event", (event) => {
    const key = "__runtimeObserved_" + api.extensionId;
    (globalThis[key] ??= []).push(event);
  });
}`;
  const ownerPath = join(root, "owner.mjs");
  const observerPath = join(root, "observer.mjs");
  await writeFile(ownerPath, source);
  await writeFile(observerPath, source);
  const host = await loadRuntimeExtensions([
    { extensionId: "owner", sourcePath: ownerPath, sha256: sha256(source) },
    { extensionId: "observer", sourcePath: observerPath, sha256: sha256(source) },
  ], { workspace: root });
  const envelope = (sequence: number, event: EventEnvelope["event"]): EventEnvelope => ({
    eventId: `event-observed-${sequence}`,
    threadId: "thread-observed",
    runId: "run-observed",
    sequence,
    timestamp: "2026-07-12T00:00:00.000Z",
    schemaVersion: 1,
    event,
  });
  try {
    await host.dispatch("event", envelope(1, {
      type: "message_appended",
      message: {
        id: "message-observed",
        role: "assistant",
        createdAt: "2026-07-12T00:00:00.000Z",
        content: [
          { type: "text", text: "visible" },
          { type: "provider_opaque", provider: "fixture", mediaType: "application/json", value: { private: true }, serialized: "private" },
        ],
      },
      providerState: { kind: "chat_completions", assistantMessage: { private: true } },
      providerStateSerialized: "private-state",
      toolDefinitionFingerprint: "fingerprint",
    }));
    await host.dispatch("event", envelope(2, {
      type: "reasoning_delta",
      text: "hidden provider trace",
      part: 0,
      visibility: "provider_trace",
    }));
    await host.dispatch("event", envelope(3, {
      type: "usage",
      semantics: "final",
      usage: { totalTokens: 3, raw: { private: true } },
    }));
    await host.dispatch("event", envelope(4, {
      type: "run_failed",
      error: {
        category: "provider",
        message: "failed",
        retryable: false,
        partial: false,
        diagnostics: { status: 503, headers: { "x-request-id": "private-diagnostic" } },
        raw: { private: true },
      },
    }));
    await host.dispatch("event", envelope(5, {
      type: "extension_state",
      extensionId: "owner",
      schemaVersion: 1,
      key: "private",
      value: { secret: "owner-state" },
    }));
    await host.dispatch("event", envelope(6, {
      type: "extension_message",
      extensionId: "owner",
      schemaVersion: 1,
      kind: "private",
      messageId: "extension-message-observed",
      payload: { secret: "owner-message" },
      modelContext: { role: "user", text: "private model context" },
      transcript: false,
    }));

    const owner = (globalThis as Record<string, unknown>).__runtimeObserved_owner as EventEnvelope[];
    const observer = (globalThis as Record<string, unknown>).__runtimeObserved_observer as EventEnvelope[];
    for (const events of [owner, observer]) {
      const message = events[0]!.event;
      assert.equal(message.type, "message_appended");
      if (message.type !== "message_appended") throw new Error("expected message event");
      assert.equal("providerState" in message, false);
      assert.equal("providerStateSerialized" in message, false);
      assert.deepEqual(message.message.content, [{ type: "text", text: "visible" }]);
      assert.deepEqual(events[1]!.event, { type: "reasoning_delta", text: "", part: 0, visibility: "provider_trace" });
      assert.deepEqual(events[2]!.event, { type: "usage", semantics: "final", usage: { totalTokens: 3 } });
      assert.equal(events[3]!.event.type === "run_failed" && "raw" in events[3]!.event.error, false);
      assert.equal(events[3]!.event.type === "run_failed" && "diagnostics" in events[3]!.event.error, false);
    }
    assert.deepEqual(owner[4]!.event.type === "extension_state" ? owner[4]!.event.value : undefined, { secret: "owner-state" });
    assert.equal(observer[4]!.event.type === "extension_state" ? observer[4]!.event.value : undefined, null);
    assert.deepEqual(owner[5]!.event.type === "extension_message" ? owner[5]!.event.payload : undefined, { secret: "owner-message" });
    assert.equal(observer[5]!.event.type === "extension_message" ? observer[5]!.event.payload : undefined, null);
    assert.equal(observer[5]!.event.type === "extension_message" ? observer[5]!.event.modelContext : undefined, false);
  } finally {
    await host.close();
    delete (globalThis as Record<string, unknown>).__runtimeObserved_owner;
    delete (globalThis as Record<string, unknown>).__runtimeObserved_observer;
  }
});

test("runtime TypeScript loader transforms package-style syntax and relative modules", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-transformed-ts-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const helperPath = join(root, "helper.ts");
  const path = join(root, "extension.ts");
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(helperPath, `export enum HelperState { Ready = "ready" }\n`);
  const source = `
import { HelperState } from "./helper";

enum ActivationState { Loaded = "loaded" }
class StatusLine {
  constructor(private readonly prefix: string) {}
  render(value: string): string { return this.prefix + ":" + value; }
}

export default function activate(api: any) {
  const line = new StatusLine(ActivationState.Loaded);
  api.ui.setStatus("typescript", line.render(HelperState.Ready));
}
`;
  await writeFile(path, source);

  const host = await loadRuntimeExtensions([{
    extensionId: "transformed-typescript",
    sourcePath: path,
    sha256: sha256(source),
  }], { workspace: root });
  assert.deepEqual(host.diagnostics(), []);
  assert.deepEqual(host.initialUi(), [{
    extensionId: "transformed-typescript",
    type: "status",
    key: "typescript",
    value: "loaded:ready",
  }]);
  await host.close();
});

test("runtime renderer registrations expose bounded structural blocks without raw ANSI", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "renderers.mjs");
  const source = `export default (api) => {
    api.registerToolRenderer("read", {
      renderCall(view, context) {
        return { lines: [{ spans: [{ text: "\\u001b[31mcall:" + view.name + ":123456789\\u001b[0m", role: "accent" }] }] };
      },
      renderResult(view) { return { lines: [{ spans: [{ text: "result:" + view.result.content, role: "success" }] }] }; }
    });
  };\n`;
  await writeFile(path, source);
  const host = await loadRuntimeExtensions([{ extensionId: "renderers", sourcePath: path, sha256: sha256(source) }], { workspace: root });

  assert.deepEqual(host.diagnostics(), []);
  assert.deepEqual(host.renderers().map((entry) => [entry.kind, entry.key]), [["tool", "read"]]);
  const call = host.renderToolCall("read", {
    callId: "call-1",
    name: "read",
    input: { path: "README.md" },
    status: "running",
    expanded: false,
  }, { ...renderContext, width: 12 });
  assert.deepEqual(call, { lines: [{ spans: [{ text: "call:read:12", role: "accent" }] }] });
  assert.doesNotMatch(call!.lines[0]!.spans[0]!.text, /\u001b/u);
  assert.deepEqual(host.renderToolResult("read", {
    callId: "call-1",
    name: "read",
    result: { content: "done", isError: false },
    status: "completed",
    expanded: false,
  }, renderContext), { lines: [{ spans: [{ text: "result:done", role: "success" }] }] });
  await host.close();
});

test("runtime editor renderers replace only the bounded structural editor view", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-editor-renderer-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "editor-renderer.mjs");
  const source = `export default (api) => {
    api.registerEditorRenderer({
      render(view) {
        const prefix = "edit:";
        return {
          lines: [{ spans: [{ text: "\\u001b[31m" + prefix + view.text + "\\u001b[0m", role: "accent" }] }],
          cursor: { row: 0, column: prefix.length + view.cursor }
        };
      }
    });
  };\n`;
  await writeFile(path, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "editor-renderer",
    sourcePath: path,
    sha256: sha256(source),
  }], { workspace: root });

  assert.deepEqual(host.renderers().map((entry) => [entry.kind, entry.key]), [["editor", "editor"]]);
  const block = host.renderEditor({ text: "hello", cursor: 2, label: "you", mode: "normal", blocked: false }, {
    ...renderContext,
    width: 20,
    focused: true,
  });
  assert.deepEqual(block, {
    lines: [{ spans: [{ text: "edit:hello", role: "accent" }] }],
    cursor: { row: 0, column: 7 },
  });
  assert.doesNotMatch(block!.lines[0]!.spans[0]!.text, /\u001b/u);
  await host.close();
});

test("invalid editor renderer output falls back and records a bounded diagnostic", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-editor-renderer-invalid-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "editor-renderer.mjs");
  const source = `export default (api) => {
    api.registerEditorRenderer({ render: () => ({ lines: [{ spans: [{ text: "missing cursor" }] }] }) });
  };\n`;
  await writeFile(path, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "invalid-editor-renderer",
    sourcePath: path,
    sha256: sha256(source),
  }], { workspace: root });

  const view = { text: "hello", cursor: 2, label: "you", mode: "normal" as const, blocked: false };
  assert.equal(host.renderEditor(view, renderContext), undefined);
  assert.equal(host.renderEditor(view, renderContext), undefined);
  assert.equal(host.diagnostics().length, 1);
  assert.match(host.diagnostics()[0]?.message ?? "", /editor renderer failed:.*must return a cursor/u);
  await host.close();
});

test("renderer failure diagnostics redact credential-shaped exception text", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-renderer-secret-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "renderer-secret.mjs");
  const secret = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const source = `export default (api) => {
    api.registerToolRenderer("secret", { renderCall: () => { throw new Error(${JSON.stringify(secret)}); } });
  };\n`;
  await writeFile(path, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "renderer-secret",
    sourcePath: path,
    sha256: sha256(source),
  }], { workspace: root });

  assert.equal(host.renderToolCall("secret", {
    callId: "call-secret",
    name: "secret",
    status: "pending",
    expanded: false,
  }, renderContext), undefined);
  const diagnostic = host.diagnostics()[0]?.message ?? "";
  assert.match(diagnostic, /\[REDACTED\]/u);
  assert.doesNotMatch(diagnostic, new RegExp(secret, "u"));
  await host.close();
});

test("tool-call listeners transform cloned input sequentially with durable actor attribution", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-tool-transform-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const legacyPath = join(root, "legacy.mjs");
  const explicitPath = join(root, "explicit.mjs");
  const legacySource = `export default (api) => api.on("tool_call", (event) => { event.input.value = "legacy"; });\n`;
  const explicitSource = `export default (api) => api.on("tool_call", (event) => ({ input: { value: event.input.value + ":explicit" } }));\n`;
  await writeFile(legacyPath, legacySource);
  await writeFile(explicitPath, explicitSource);
  const host = await loadRuntimeExtensions([
    { extensionId: "legacy-transform", sourcePath: legacyPath, sha256: sha256(legacySource) },
    { extensionId: "explicit-transform", sourcePath: explicitPath, sha256: sha256(explicitSource) },
  ], { workspace: root });

  const original = { value: "original" };
  const reduced = await host.reduceToolCall({
    callId: "call-transform",
    name: "echo",
    input: original,
    index: 0,
    threadId: "thread-transform",
    runId: "run-transform",
    branch: "main",
  });
  assert.deepEqual(original, { value: "original" });
  assert.deepEqual(reduced.invocation.input, { value: "legacy:explicit" });
  assert.deepEqual(reduced.transformations, [
    { actor: "legacy-transform" },
    { actor: "explicit-transform" },
  ]);
  assert.equal(reduced.blocked, false);
  await host.close();
});

test("tool-call listener capacity matches the transformation audit maximum", async (context) => {
  assert.equal(MAX_TOOL_TRANSFORMATION_AUDIT_ENTRIES, 128);
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-tool-listener-limit-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "boundary.mjs");
  const source = `export default (api) => {
    globalThis.__runtimeListenerLimitApi = api;
    globalThis.__runtimeObserverCount = 0;
    for (let index = 0; index < 128; index += 1) {
      api.on("tool_call", (event) => ({ input: { value: event.input.value + 1 } }));
    }
    for (let index = 0; index < 129; index += 1) {
      api.on("agent_start", () => { globalThis.__runtimeObserverCount += 1; });
    }
  };\n`;
  await writeFile(path, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "listener-boundary",
    sourcePath: path,
    sha256: sha256(source),
  }], { workspace: root, activationFailure: "throw" });

  const reduced = await host.reduceToolCall({
    callId: "call-boundary",
    name: "echo",
    input: { value: 0 },
    index: 0,
    threadId: "thread-boundary",
    runId: "run-boundary",
    branch: "main",
  });
  assert.deepEqual(reduced.invocation.input, { value: 128 });
  assert.equal(reduced.transformations?.length, MAX_TOOL_TRANSFORMATION_AUDIT_ENTRIES);

  const api = (globalThis as Record<string, any>).__runtimeListenerLimitApi;
  assert.throws(
    () => api.on("tool_call", () => undefined),
    /tool_call listeners exceed 128/u,
  );
  assert.doesNotThrow(() => api.on("agent_start", () => {
    (globalThis as Record<string, any>).__runtimeObserverCount += 1;
  }));
  await host.dispatch("agent_start", {
    threadId: "thread-boundary",
    runId: "run-boundary",
    branch: "main",
    provider: "fixture",
    model: "fixture-model",
  });
  assert.equal((globalThis as Record<string, unknown>).__runtimeObserverCount, 130);

  await host.close();
  delete (globalThis as Record<string, unknown>).__runtimeListenerLimitApi;
  delete (globalThis as Record<string, unknown>).__runtimeObserverCount;
});

test("activation rejects a 129th tool-call listener transactionally", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-tool-listener-overflow-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "overflow.mjs");
  const source = `export default (api) => {
    api.registerCommand({ name: "must-not-commit-listeners", execute() {} });
    for (let index = 0; index < 129; index += 1) api.on("tool_call", () => undefined);
  };\n`;
  await writeFile(path, source);

  await assert.rejects(loadRuntimeExtensions([{
    extensionId: "listener-overflow",
    sourcePath: path,
    sha256: sha256(source),
  }], { workspace: root, activationFailure: "throw" }), /tool_call listeners exceed 128/u);
});

test("runtime renderer failures fall back and report one diagnostic per failure", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "broken-renderers.mjs");
  const source = `export default (api) => {
    api.registerToolRenderer("broken", { renderCall: () => { throw new Error("paint failed"); } });
    api.registerToolRenderer("unsafe", { renderCall: () => ({ lines: [], raw: "\\u001b]2;owned\\u0007" }) });
    api.registerToolRenderer("many", { renderCall: (view) => { throw new Error("paint " + view.callId); } });
  };\n`;
  await writeFile(path, source);
  const host = await loadRuntimeExtensions([{ extensionId: "broken", sourcePath: path, sha256: sha256(source) }], { workspace: root });
  const view = {
    callId: "call-1",
    name: "broken",
    status: "pending" as const,
    expanded: false,
  };
  assert.equal(host.renderToolCall("broken", view, renderContext), undefined);
  assert.equal(host.renderToolCall("broken", view, renderContext), undefined);
  assert.equal(host.renderToolCall("unsafe", { ...view, name: "unsafe" }, renderContext), undefined);
  assert.equal(host.diagnostics().length, 2);
  assert.match(host.diagnostics()[0]?.message ?? "", /tool call broken renderer failed: paint failed/u);
  assert.match(host.diagnostics()[1]?.message ?? "", /tool call unsafe renderer failed:.*unknown keys: raw/u);
  for (let index = 0; index < 140; index += 1) {
    host.renderToolCall("many", { ...view, callId: String(index), name: "many" }, renderContext);
  }
  assert.equal(host.diagnostics().length, 128);
  await host.close();
});

test("duplicate renderer activation is transactional and cleans staged work in reverse", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const first = join(root, "first.mjs");
  const second = join(root, "second.mjs");
  const firstSource = `export default (api) => { api.registerToolRenderer("read", { renderCall: () => ({ lines: [] }) }); };\n`;
  const secondSource = `export default (api) => {
    globalThis.__rendererRollback = [];
    api.onDispose(() => globalThis.__rendererRollback.push("first"));
    api.onDispose(() => globalThis.__rendererRollback.push("second"));
    api.registerCommand({ name: "must-not-commit", execute() {} });
    api.registerToolRenderer("read", { renderCall: () => ({ lines: [] }) });
  };\n`;
  await writeFile(first, firstSource);
  await writeFile(second, secondSource);
  const host = await loadRuntimeExtensions([
    { extensionId: "first", sourcePath: first, sha256: sha256(firstSource) },
    { extensionId: "second", sourcePath: second, sha256: sha256(secondSource) },
  ], { workspace: root });

  assert.deepEqual(host.renderers().map((entry) => entry.key), ["read"]);
  assert.equal(host.hasCommand("must-not-commit"), false);
  assert.match(host.diagnostics()[0]?.message ?? "", /duplicate tool renderer/u);
  assert.deepEqual((globalThis as Record<string, unknown>).__rendererRollback, ["second", "first"]);
  await host.close();
  delete (globalThis as Record<string, unknown>).__rendererRollback;
});

test("runtime hash mismatch and partial activation failure stay inert and diagnostic", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const mismatch = join(root, "mismatch.mjs");
  const partial = join(root, "partial.mjs");
  await writeFile(mismatch, "export default () => {};\n");
  const partialSource = `export default (api) => { api.registerCommand({ name: "partial", execute() {} }); throw new Error("activation failed"); };\n`;
  await writeFile(partial, partialSource);

  const host = await loadRuntimeExtensions([
    { extensionId: "mismatch", sourcePath: mismatch, sha256: "0".repeat(64) },
    { extensionId: "partial", sourcePath: partial, sha256: sha256(partialSource) },
  ], { workspace: root });
  assert.equal(host.commands().length, 0);
  assert.equal(host.diagnostics().length, 2);
  assert.match(host.diagnostics()[0]?.message ?? "", /changed after extension discovery/u);
  assert.match(host.diagnostics()[1]?.message ?? "", /activation failed/u);
});

test("runtime activation is time-bounded, aborts its generation, and rolls back staged work", async (context) => {
  const activationTimeoutMs = 500;
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-timeout-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "hanging.mjs");
  const source = `export default async (api) => {
    globalThis.__runtimeTimeoutSignal = api.signal;
    api.onDispose(() => { globalThis.__runtimeTimeoutDisposed = true; });
    api.registerCommand({ name: "must-not-commit-timeout", execute() {} });
    await new Promise((resolve) => api.signal.addEventListener("abort", resolve, { once: true }));
  };\n`;
  await writeFile(path, source);

  const startedAt = Date.now();
  const host = await loadRuntimeExtensions([{
    extensionId: "hanging",
    sourcePath: path,
    sha256: sha256(source),
  }], { workspace: root, activationTimeoutMs });

  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal(host.hasCommand("must-not-commit-timeout"), false);
  assert.match(host.diagnostics()[0]?.message ?? "", new RegExp(`activation timed out after ${activationTimeoutMs}ms`, "u"));
  const timeoutSignal = (globalThis as Record<string, unknown>).__runtimeTimeoutSignal;
  assert.ok(timeoutSignal instanceof AbortSignal);
  assert.equal(timeoutSignal.aborted, true);
  assert.equal((globalThis as Record<string, unknown>).__runtimeTimeoutDisposed, true);
  await host.close();
  delete (globalThis as Record<string, unknown>).__runtimeTimeoutSignal;
  delete (globalThis as Record<string, unknown>).__runtimeTimeoutDisposed;
});

test("runtime extension loading has one aggregate deadline across entries", { timeout: 2_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-load-timeout-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const hanging = `export default async (api) => {
    globalThis.__runtimeLoadStarts = (globalThis.__runtimeLoadStarts ?? 0) + 1;
    await new Promise((resolve) => api.signal.addEventListener("abort", resolve, { once: true }));
  };\n`;
  const final = `export default () => { globalThis.__runtimeLoadFinalActivated = true; };\n`;
  const entries = [];
  for (const [index, source] of [hanging, hanging, final].entries()) {
    const sourcePath = join(root, `extension-${index}.mjs`);
    await writeFile(sourcePath, source);
    entries.push({ extensionId: `extension-${index}`, sourcePath, sha256: sha256(source) });
  }

  const host = await loadRuntimeExtensions(entries, {
    workspace: root,
    activationTimeoutMs: 40,
    loadTimeoutMs: 65,
    shutdownTimeoutMs: 10,
  });

  const starts = (globalThis as Record<string, unknown>).__runtimeLoadStarts;
  assert.ok(typeof starts === "number");
  assert.ok(starts >= 1 && starts <= 2);
  assert.equal((globalThis as Record<string, unknown>).__runtimeLoadFinalActivated, undefined);
  const diagnostics = host.diagnostics().map((diagnostic) => diagnostic.message);
  assert.ok(diagnostics.some((message) => /activation timed out after 40ms/u.test(message)));
  assert.ok(diagnostics.some((message) => /load timed out after 65ms/u.test(message)));
  await host.close();
  await rm(join(root, ".rigyn"), { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>).__runtimeLoadStarts;
  delete (globalThis as Record<string, unknown>).__runtimeLoadFinalActivated;
});

test("failed activation reports bounded disposer cleanup failures", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-activation-cleanup-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "activation-cleanup.mjs");
  const source = `export default (api) => {
    api.onDispose(() => new Promise(() => {}));
    throw new Error("activation cleanup fixture");
  };\n`;
  await writeFile(sourcePath, source);

  const host = await loadRuntimeExtensions([{
    extensionId: "activation-cleanup",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root, shutdownTimeoutMs: 15 });

  assert.match(host.diagnostics()[0]?.message ?? "", /activation cleanup fixture/u);
  assert.match(host.diagnostics()[1]?.message ?? "", /activation disposer cleanup timed out after 15ms/u);
  await host.close();
});

test("runtime tool prompt metadata rejects invalid guidance transactionally", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-tool-prompt-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "invalid-tool-prompt.mjs");
  const source = `export default (api) => {
    api.registerCommand({ name: "must-not-commit-prompt", execute() {} });
    api.registerTool({
      name: "invalid_prompt_tool",
      description: "Invalid prompt fixture",
      promptSnippet: "",
      inputSchema: { type: "object" },
      execute() { return { content: "unused", isError: false }; }
    });
  };\n`;
  await writeFile(path, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "invalid-tool-prompt",
    sourcePath: path,
    sha256: sha256(source),
  }], { workspace: root });
  assert.equal(host.hasCommand("must-not-commit-prompt"), false);
  assert.deepEqual(host.tools(), []);
  assert.match(host.diagnostics()[0]?.message ?? "", /promptSnippet must be a non-empty string/u);
  await host.close();
});

test("runtime startup UI and diagnostics are bounded without partial activation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "startup-flood.mjs");
  const source = `export default (api) => {
    api.onDispose(() => { globalThis.__runtimeUiFloodDisposed = true; });
    for (let index = 0; index < 513; index += 1) api.ui.notify("notice:" + index);
    api.registerCommand({ name: "must-not-commit", execute() {} });
  };\n`;
  await writeFile(path, source);
  const host = await loadRuntimeExtensions([
    { extensionId: "startup-flood", sourcePath: path, sha256: sha256(source) },
  ], { workspace: root });

  assert.equal(host.initialUi().length, 0);
  assert.equal(host.hasCommand("must-not-commit"), false);
  assert.match(host.diagnostics()[0]?.message ?? "", /initial UI exceeds 512 operations/u);
  assert.equal((globalThis as Record<string, unknown>).__runtimeUiFloodDisposed, true);

  host.addDiagnostic({
    extensionId: `${"x".repeat(2_000)}\0ignored`,
    sourcePath: `${"/".repeat(20_000)}\0ignored`,
    message: `${"🙂".repeat(2_000)}\0ignored`,
  });
  for (let index = 0; index < 600; index += 1) {
    host.addDiagnostic({ extensionId: "flood", sourcePath: path, message: `failure ${index}` });
  }
  const diagnostics = host.diagnostics();
  assert.equal(diagnostics.length, 512);
  assert.match(diagnostics.at(-1)?.message ?? "", /diagnostics exceeded 512 entries/u);
  assert.equal(diagnostics.some((entry) => entry.extensionId.includes("\0") || entry.sourcePath.includes("\0") || entry.message.includes("\0")), false);
  assert.ok(Buffer.byteLength(diagnostics[1]!.extensionId, "utf8") <= 1_024);
  assert.ok(Buffer.byteLength(diagnostics[1]!.sourcePath, "utf8") <= 16 * 1_024);
  assert.ok(Buffer.byteLength(diagnostics[1]!.message, "utf8") <= 4 * 1_024);
  delete (globalThis as Record<string, unknown>).__runtimeUiFloodDisposed;
  await host.close();
});

test("runtime cleanup is reverse ordered, exhaustive, idempotent, and invalidates old contexts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "cleanup.mjs");
  const source = `export default (api) => {
    globalThis.__runtimeCleanup = [];
    globalThis.__runtimeStaleApi = api;
    api.onDispose(() => { globalThis.__runtimeCleanup.push("first"); });
    api.onDispose(() => { globalThis.__runtimeCleanup.push("second"); throw new Error("dispose failed"); });
    api.onDispose(() => { globalThis.__runtimeCleanup.push("third"); });
  };\n`;
  await writeFile(path, source);
  const host = await loadRuntimeExtensions([{ extensionId: "cleanup", sourcePath: path, sha256: sha256(source) }], { workspace: root });

  await assert.rejects(host.close(), /dispose failed/u);
  assert.deepEqual((globalThis as Record<string, unknown>).__runtimeCleanup, ["third", "second", "first"]);
  await host.close();
  assert.deepEqual((globalThis as Record<string, unknown>).__runtimeCleanup, ["third", "second", "first"]);
  const stale = (globalThis as Record<string, any>).__runtimeStaleApi;
  assert.throws(() => stale.ui.notify("late"), /no longer active/u);
  assert.throws(() => stale.registerToolRenderer("late", { renderCall: () => ({ lines: [] }) }), /no longer active/u);
  await assert.rejects(host.dispatch("event", observedEvent()), /host is closed/u);
  assert.throws(() => host.renderToolCall("missing", {
    callId: "call",
    name: "missing",
    status: "pending",
    expanded: false,
  }, renderContext), /host is closed/u);
  delete (globalThis as Record<string, unknown>).__runtimeCleanup;
  delete (globalThis as Record<string, unknown>).__runtimeStaleApi;
});

test("failed activation disposes staged work and unchanged sources re-evaluate", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const failed = join(root, "failed.mjs");
  const failedSource = `export default (api) => {
    api.onDispose(() => { globalThis.__runtimeFailedCleanup = (globalThis.__runtimeFailedCleanup || 0) + 1; });
    throw new Error("staged failure");
  };\n`;
  await writeFile(failed, failedSource);
  const failedHost = await loadRuntimeExtensions([{ extensionId: "failed", sourcePath: failed, sha256: sha256(failedSource) }], { workspace: root });
  assert.match(failedHost.diagnostics()[0]?.message ?? "", /staged failure/u);
  assert.equal((globalThis as Record<string, unknown>).__runtimeFailedCleanup, 1);

  const repeated = join(root, "repeated.mjs");
  const repeatedSource = `globalThis.__runtimeTopLevel = (globalThis.__runtimeTopLevel || 0) + 1; export default () => {};\n`;
  await writeFile(repeated, repeatedSource);
  const entry = { extensionId: "repeated", sourcePath: repeated, sha256: sha256(repeatedSource) };
  const first = await loadRuntimeExtensions([entry], { workspace: root });
  await first.close();
  const second = await loadRuntimeExtensions([entry], { workspace: root });
  assert.equal((globalThis as Record<string, unknown>).__runtimeTopLevel, 2);
  await second.close();
  await failedHost.close();
  delete (globalThis as Record<string, unknown>).__runtimeFailedCleanup;
  delete (globalThis as Record<string, unknown>).__runtimeTopLevel;
});

test("runtime event dispatch gives every listener a chance when one fails", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "listeners.mjs");
  const source = `export default (api) => {
    api.on("event", () => { throw new Error("first failed"); });
    api.on("event", () => { globalThis.__runtimeSecondListener = true; });
  };\n`;
  await writeFile(path, source);
  const host = await loadRuntimeExtensions([{ extensionId: "listeners", sourcePath: path, sha256: sha256(source) }], { workspace: root });

  await assert.rejects(host.dispatch("event", observedEvent()), /first failed/u);
  assert.equal((globalThis as Record<string, unknown>).__runtimeSecondListener, true);
  delete (globalThis as Record<string, unknown>).__runtimeSecondListener;
});

test("runtime listeners receive owned abortable context", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-context-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "listener-context.mjs");
  const source = `export default (api) => {
    api.on("event", (_event, context) => {
      globalThis.__runtimeListenerContext = context;
    });
  };\n`;
  await writeFile(path, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "listener-context",
    sourcePath: path,
    sha256: sha256(source),
  }], { workspace: root });

  await host.dispatch("event", observedEvent());
  const listenerContext = (globalThis as Record<string, unknown>).__runtimeListenerContext as {
    extensionId: string;
    sourcePath: string;
    workspace: string;
    signal: AbortSignal;
  };
  assert.equal(listenerContext.extensionId, "listener-context");
  assert.equal(listenerContext.sourcePath, path);
  assert.equal(listenerContext.workspace, root);
  assert.equal(listenerContext.signal.aborted, false);
  const cancelled = new AbortController();
  cancelled.abort(new Error("listener operation cancelled"));
  await assert.rejects(host.dispatch("event", observedEvent(), cancelled.signal), /listener operation cancelled/u);
  await host.close();
  assert.equal(listenerContext.signal.aborted, true);
  delete (globalThis as Record<string, unknown>).__runtimeListenerContext;
});

test("runtime activation permits extensions to override built-in tool names", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "collision.mjs");
  const source = `export default (api) => {
    api.registerTool({ name: "read", description: "collision", inputSchema: { type: "object" }, execute() { return { content: "bad", isError: false }; } });
    api.registerCommand({ name: "probe-before-failure", execute() {} });
    api.registerToolRenderer("must-not-commit", { renderCall: () => ({ lines: [] }) });
  };\n`;
  await writeFile(path, source);
  const host = await loadRuntimeExtensions([{ extensionId: "collision", sourcePath: path, sha256: sha256(source) }], { workspace: root });

  assert.deepEqual(host.tools().map((tool) => tool.definition.name), ["read"]);
  assert.deepEqual(host.commands().map((command) => command.name), ["probe-before-failure"]);
  assert.deepEqual(host.renderers().map((renderer) => renderer.key), ["must-not-commit"]);
  assert.deepEqual(host.diagnostics(), []);
});

test("runtime activation permits every built-in tool name to be overridden", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  for (const name of ["grep", "find", "ls"]) {
    const path = join(root, `${name}.mjs`);
    const source = `export default (api) => {
      api.registerTool({ name: "${name}", description: "collision", inputSchema: { type: "object" }, execute() { return { content: "bad", isError: false }; } });
    };\n`;
    await writeFile(path, source);
    const host = await loadRuntimeExtensions([{ extensionId: `collision-${name}`, sourcePath: path, sha256: sha256(source) }], { workspace: root });
    assert.deepEqual(host.tools().map((tool) => tool.definition.name), [name]);
    assert.deepEqual(host.diagnostics(), []);
    await host.close();
  }
});

test("runtime activation rejects every current built-in command namespace", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "command-collision.mjs");
  const source = `export default (api) => { api.registerCommand({ name: "copy", execute() {} }); };\n`;
  await writeFile(path, source);
  const host = await loadRuntimeExtensions([{ extensionId: "collision", sourcePath: path, sha256: sha256(source) }], { workspace: root });

  assert.deepEqual(host.commands(), []);
  assert.match(host.diagnostics()[0]?.message ?? "", /command name is reserved: copy/u);
});

test("provider auth activation is validated and duplicate registration stays transactional", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const first = join(root, "first-auth.mjs");
  const duplicate = join(root, "duplicate-auth.mjs");
  const unsafe = join(root, "unsafe-auth.mjs");
  const firstSource = `export default (api) => api.registerProviderAuth({ provider: "shared", methods: [{ kind: "api_key", label: "Shared key" }] });\n`;
  const duplicateSource = `export default (api) => {
    api.registerCommand({ name: "must-not-commit-auth", execute() {} });
    api.registerProviderAuth({ provider: "shared", methods: [{ kind: "api_key" }] });
  };\n`;
  const unsafeSource = `export default (api) => {
    api.registerProviderAuth({
      provider: "unsafe",
      methods: [{ kind: "oauth_pkce", id: "login", clientId: "public", authorizationEndpoint: "https://id.example/authorize", tokenEndpoint: "https://id.example/token", authorizationParameters: { client_secret: "forbidden" } }]
    });
  };\n`;
  await writeFile(first, firstSource);
  await writeFile(duplicate, duplicateSource);
  await writeFile(unsafe, unsafeSource);
  const host = await loadRuntimeExtensions([
    { extensionId: "first-auth", sourcePath: first, sha256: sha256(firstSource) },
    { extensionId: "duplicate-auth", sourcePath: duplicate, sha256: sha256(duplicateSource) },
    { extensionId: "unsafe-auth", sourcePath: unsafe, sha256: sha256(unsafeSource) },
  ], { workspace: root });

  assert.deepEqual(host.providerAuth().map((entry) => entry.descriptor.provider), ["shared"]);
  assert.equal(host.hasCommand("must-not-commit-auth"), false);
  assert.match(host.diagnostics()[0]?.message ?? "", /duplicate provider auth descriptor/u);
  assert.match(host.diagnostics()[1]?.message ?? "", /invalid or reserved/u);
  await host.close();
});

test("provider authenticated requests are scoped to the extension that owns the auth descriptor", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const owner = join(root, "auth-owner.mjs");
  const observer = join(root, "auth-observer.mjs");
  const ownerSource = `export default (api) => {
    globalThis.__runtimeAuthOwner = api;
    api.registerProviderAuth({ provider: "owned-provider", methods: [{ kind: "api_key" }] });
  };\n`;
  const observerSource = `export default (api) => { globalThis.__runtimeAuthObserver = api; };\n`;
  await writeFile(owner, ownerSource);
  await writeFile(observer, observerSource);
  const host = await loadRuntimeExtensions([
    { extensionId: "auth-owner", sourcePath: owner, sha256: sha256(ownerSource) },
    { extensionId: "auth-observer", sourcePath: observer, sha256: sha256(observerSource) },
  ], { workspace: root });
  host.setLiveRegistrationHandler({
    registerTool() {},
    registerProvider() {},
    registerProviderAuth() {},
    async fetchProvider() { return new Response("owned-response"); },
  });
  const ownerApi = (globalThis as Record<string, any>).__runtimeAuthOwner;
  const observerApi = (globalThis as Record<string, any>).__runtimeAuthObserver;
  assert.equal(await (await ownerApi.auth.fetch("owned-provider", "https://api.example.test/v1")).text(), "owned-response");
  await assert.rejects(
    observerApi.auth.fetch("owned-provider", "https://api.example.test/v1"),
    /does not own provider authentication/u,
  );
  await host.close();
  delete (globalThis as Record<string, unknown>).__runtimeAuthOwner;
  delete (globalThis as Record<string, unknown>).__runtimeAuthObserver;
});

test("provider authenticated requests are cancelled when their extension generation closes", { timeout: 1_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-auth-cancel-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "auth-cancel.mjs");
  const source = `export default (api) => {
    globalThis.__runtimeAuthCancelApi = api;
    api.registerProviderAuth({ provider: "cancel-provider", methods: [{ kind: "api_key" }] });
  };\n`;
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "auth-cancel",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let resolutionSignal: AbortSignal | undefined;
  host.setLiveRegistrationHandler({
    registerTool() {},
    registerProvider() {},
    registerProviderAuth() {},
    async fetchProvider(_provider, _input, _init, signal) {
      resolutionSignal = signal;
      started();
      return await new Promise(() => {});
    },
  });
  const api = (globalThis as Record<string, any>).__runtimeAuthCancelApi;
  const pending = api.auth.fetch("cancel-provider", "https://api.example.test/v1");
  await ready;
  const closing = host.close();
  await assert.rejects(pending, /closed/u);
  assert.equal(resolutionSignal?.aborted, true);
  await closing;
  delete (globalThis as Record<string, unknown>).__runtimeAuthCancelApi;
});

test("post-activation registrations update the live host and clean up with it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const path = join(root, "late.mjs");
  const source = `export default (api) => { globalThis.__runtimeLateApi = api; };\n`;
  await writeFile(path, source);
  const host = await loadRuntimeExtensions([{ extensionId: "late", sourcePath: path, sha256: sha256(source) }], { workspace: root });
  const lifecycle: string[] = [];
  const ui: string[] = [];
  host.setLiveRegistrationHandler({
    registerTool(tool) {
      lifecycle.push(`integrate-tool:${tool.definition.name}`);
      return () => { lifecycle.push(`remove-tool:${tool.definition.name}`); };
    },
    registerProvider(provider) {
      lifecycle.push(`integrate-provider:${provider.id}`);
      return () => { lifecycle.push(`remove-provider:${provider.id}`); };
    },
    registerProviderAuth(auth) {
      lifecycle.push(`integrate-auth:${auth.descriptor.provider}`);
      return () => { lifecycle.push(`remove-auth:${auth.descriptor.provider}`); };
    },
    async fetchProvider(provider) {
      return new Response(`fixture:${provider}`);
    },
  });
  host.setUiHandler((operation) => ui.push(`${operation.type}:${operation.value}`));

  const api = (globalThis as Record<string, any>).__runtimeLateApi;
  api.registerTool({
    name: "late_tool",
    description: "Late tool",
    inputSchema: { type: "object" },
    execute() { return { content: "late", isError: false }; },
  });
  api.registerCommand({ name: "late-command", execute() { return "late prompt"; } });
  const disposeProvider = api.registerProvider({ id: "late-provider", async *stream() {}, async listModels() { return []; } });
  api.registerProviderAuth({ provider: "late-provider", methods: [{ kind: "api_key", label: "Late key" }] });
  api.registerToolRenderer("late_tool", { renderCall: () => ({ lines: [] }) });
  api.on("event", () => lifecycle.push("late-event"));
  api.onDispose(() => lifecycle.push("late-dispose"));
  api.ui.notify("late-notice");

  assert.deepEqual(host.tools().map((tool) => tool.definition.name), ["late_tool"]);
  assert.deepEqual(host.commands().map((command) => command.name), ["late-command"]);
  assert.deepEqual(host.providers().map((provider) => provider.id), ["late-provider"]);
  assert.deepEqual(host.providerAuth().map((auth) => auth.descriptor.provider), ["late-provider"]);
  assert.equal(
    await (await api.auth.fetch("late-provider", "https://api.example.test/v1")).text(),
    "fixture:late-provider",
  );
  assert.deepEqual(host.renderers().map((renderer) => renderer.key), ["late_tool"]);
  assert.deepEqual(await host.runCommand("late-command", {
    args: "",
    threadId: "thread",
    signal: new AbortController().signal,
    ui: {
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
    },
  }), { handled: true, prompt: "late prompt" });
  await host.dispatch("event", observedEvent());
  assert.deepEqual(ui, ["notify:late-notice"]);
  assert.throws(() => api.registerTool({
    name: "invalid_loading",
    description: "Invalid loading",
    loading: "sometimes",
    inputSchema: { type: "object" },
    execute() { return { content: "bad", isError: false }; },
  }), /loading mode/u);
  assert.throws(() => api.registerTool({
    name: "late_tool",
    description: "Duplicate late tool",
    inputSchema: { type: "object" },
    execute() { return { content: "duplicate", isError: false }; },
  }), /duplicate tool/u);
  assert.throws(() => api.registerCommand({ name: "late-command", execute() {} }), /duplicate command/u);
  assert.throws(() => api.registerProvider({
    id: "late-provider",
    async *stream() {},
    async listModels() { return []; },
  }), /duplicate provider/u);
  assert.throws(() => api.registerProviderAuth({
    provider: "late-provider",
    methods: [{ kind: "api_key" }],
  }), /duplicate provider auth descriptor/u);

  await disposeProvider();
  await disposeProvider();
  assert.deepEqual(host.providers(), []);
  assert.deepEqual(host.providerAuth(), []);

  await host.close();
  assert.deepEqual(lifecycle, [
    "integrate-tool:late_tool",
    "integrate-provider:late-provider",
    "integrate-auth:late-provider",
    "late-event",
    "remove-auth:late-provider",
    "remove-provider:late-provider",
    "late-dispose",
    "remove-tool:late_tool",
  ]);
  assert.throws(() => api.ui.notify("stale"), /no longer active/u);
  await assert.rejects(api.auth.fetch("late-provider", "https://api.example.test/v1"), /no longer active/u);
  delete (globalThis as Record<string, unknown>).__runtimeLateApi;
});
