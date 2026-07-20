import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type { EventEnvelope } from "../../src/core/events.js";
import type { ProviderAdapter } from "../../src/core/types.js";
import {
  loadRuntimeExtensions,
  type RuntimeAdvancedUiApi,
  type RuntimeAdvancedUiOperation,
  type RuntimeCommandUi,
  type RuntimeExtensionApi,
  type RuntimeExtensionHost,
  type RuntimeExtensionSessionHandler,
  type RuntimeInitialUiOperation,
  type RuntimeObservedEvent,
} from "../../src/extensions/runtime.js";
import type { HarnessResourceCatalog } from "../../src/service/resource-catalog.js";
import { sha256 } from "../../src/tools/hash.js";
import { MultilineEditor, type TuiEditorImplementation } from "../../src/tui/editor.js";
import { Keybindings } from "../../src/tui/keybindings.js";
import type { NativeUiHost, UnsafeTerminalHost } from "../../src/tui/native-ui.js";
import { createTheme } from "../../src/tui/theme.js";

const EXTENSION_ID = "semantic-conformance";
const THREAD_ID = "semantic-thread";
const BRANCH = "main";
const TIMESTAMP = "2026-07-19T00:00:00.000Z";
const HASH = "a".repeat(64);

const EMPTY_CATALOG = {
  schemaVersion: 1,
  tools: [],
  commands: { builtins: [], runtimeExtensions: [], extensionTemplates: [] },
  prompts: [],
  skills: [],
  themes: [],
  providers: [],
  packages: [],
  extensions: [],
  diagnostics: [],
  bounds: {
    truncated: false,
    omitted: {
      tools: 0,
      commands: 0,
      prompts: 0,
      skills: 0,
      themes: 0,
      providers: 0,
      models: 0,
      packages: 0,
      extensions: 0,
      diagnostics: 0,
    },
  },
} satisfies HarnessResourceCatalog;

function commandUi(): RuntimeCommandUi {
  let editorText = "";
  return {
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
    async input() { return "input"; },
    async editor() { return "editor"; },
    setEditorText(value) { editorText = value; },
    getEditorText() { return editorText; },
    async custom() { return undefined; },
    showOverlay() { throw new Error("not used by semantic conformance"); },
  };
}

function sessionSnapshot(threadId: string, branch = BRANCH) {
  return {
    threadId,
    branch,
    name: "Semantic session",
    branches: [branch],
    active: false,
    operation: null,
    phase: "idle" as const,
    pendingMessageCount: 0,
    recoverableMessageCount: 0,
    model: { provider: "semantic-provider", model: "semantic-model", reasoningEffort: "high" },
  };
}

interface SemanticContext {
  api: RuntimeExtensionApi;
  host: RuntimeExtensionHost;
  root: string;
  sourcePath: string;
  uiOperations: RuntimeInitialUiOperation[];
  advancedUiOperations: RuntimeAdvancedUiOperation[];
  handlerCalls: Set<keyof RuntimeExtensionSessionHandler>;
  providerDisposer?: () => Promise<void>;
  keyObserverDisposer?: () => void;
  lifecycleEvent?: RuntimeObservedEvent;
  sharedPayload?: unknown;
  nativeUiCalls: string[];
  unsafeTerminalCalls: string[];
  nativeRegistrations: string[];
  disposed: boolean;
}

type SemanticEvidence<Surface> = {
  [Key in keyof Surface]: (context: SemanticContext) => void | Promise<void>;
};

// These maps are deliberately exhaustive: adding a public member must fail typechecking
// until the new contract receives an assertion that is executed by the test below.
const ROOT_EVIDENCE = {
  extensionId({ api }) {
    assert.equal(api.extensionId, EXTENSION_ID);
  },
  workspace({ api, root }) {
    assert.equal(api.workspace, resolve(root));
  },
  dataPaths({ api, root }) {
    assert.equal(api.dataPaths.user.startsWith(resolve(root)), true);
    assert.equal(api.dataPaths.workspace.startsWith(resolve(root)), true);
    assert.notEqual(api.dataPaths.user, api.dataPaths.workspace);
  },
  signal({ api }) {
    assert.equal(api.signal instanceof AbortSignal, true);
    assert.equal(api.signal.aborted, false);
  },
  registerTool({ api, host, sourcePath }) {
    api.registerTool({
      name: "semantic_tool",
      description: "Semantic tool",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string" } },
      },
      execute(input) {
        return { content: String((input as { text: string }).text), isError: false };
      },
    });
    const tool = host.tools().find((entry) => entry.definition.name === "semantic_tool");
    assert.ok(tool);
    assert.deepEqual(host.toolOwner(tool), { kind: "extension", extensionId: EXTENSION_ID, sourcePath });
  },
  registerCommand({ api, host }) {
    api.registerCommand({
      name: "semantic-command",
      description: "Semantic command",
      argumentHint: "<value>",
      getArgumentCompletions(prefix) {
        return [{ value: `${prefix}-complete` }];
      },
      execute({ args }) {
        return { prompt: `semantic:${args}` };
      },
    });
    assert.equal(host.hasCommand("semantic-command"), true);
  },
  registerShortcut({ api, host }) {
    api.registerShortcut({ shortcut: "ctrl+alt+s", description: "Semantic shortcut", execute() {} });
    assert.equal(host.hasShortcut("ctrl+alt+s"), true);
  },
  registerFlag({ api, host }) {
    api.registerFlag({ name: "semantic-flag", type: "boolean", default: true });
    assert.equal(host.flags().some((entry) => entry.name === "semantic-flag"), true);
  },
  getFlag({ api }) {
    assert.equal(api.getFlag("semantic-flag"), true);
  },
  registerProvider(context) {
    const provider: ProviderAdapter = {
      id: "semantic-provider",
      async *stream() {},
      async listModels() { return []; },
    };
    context.providerDisposer = context.api.registerProvider(provider);
    assert.deepEqual(context.host.providers().map((entry) => entry.id), ["semantic-provider"]);
  },
  registerProviderAuth({ api, host }) {
    api.registerProviderAuth({
      provider: "semantic-provider",
      displayName: "Semantic Provider",
      methods: [{ kind: "api_key", label: "Semantic key" }],
    });
    assert.deepEqual(host.providerAuth().map((entry) => entry.descriptor.provider), ["semantic-provider"]);
  },
  registerToolRenderer({ api, host }) {
    api.registerToolRenderer("semantic_tool", {
      renderCall(view) {
        return { lines: [{ spans: [{ text: `call:${view.name}`, role: "accent" }] }] };
      },
      renderResult(view) {
        return { lines: [{ spans: [{ text: `result:${view.name}`, role: "success" }] }] };
      },
    });
    assert.equal(host.renderers().some((entry) => entry.kind === "tool" && entry.key === "semantic_tool"), true);
  },
  registerEditorRenderer({ api, host }) {
    api.registerEditorRenderer({
      render(view) {
        return {
          lines: [{ spans: [{ text: `editor:${view.text}`, role: "accent" }] }],
          cursor: { row: 0, column: view.cursor },
        };
      },
    });
    assert.equal(host.renderers().some((entry) => entry.kind === "editor"), true);
  },
  async getActiveTools({ api }) {
    assert.deepEqual(await api.getActiveTools({ threadId: THREAD_ID, branch: BRANCH }), ["read", "semantic_tool"]);
  },
  async getAllTools({ api }) {
    assert.deepEqual((await api.getAllTools({ threadId: THREAD_ID, branch: BRANCH })).map((entry) => entry.name), ["read"]);
  },
  getCommands({ api }) {
    assert.equal(api.getCommands().some((entry) => entry.baseName === "semantic-command"), true);
  },
  async getResourceCatalog({ api }) {
    assert.deepEqual(await api.getResourceCatalog(), EMPTY_CATALOG);
  },
  async getDiscoveryView({ api }) {
    assert.deepEqual(await api.getDiscoveryView(), {
      resources: [],
      truncated: false,
      omitted: { commands: 0, prompts: 0, skills: 0 },
    });
  },
  async listSessions({ api }) {
    const page = await api.listSessions({ search: "semantic", limit: 1 });
    assert.equal(page.sessions[0]?.threadId, THREAD_ID);
  },
  async getTranscript({ api }) {
    const page = await api.getTranscript({ threadId: THREAD_ID, branch: BRANCH, afterSequence: 4, limit: 2 });
    assert.deepEqual(page, {
      schemaVersion: 1,
      threadId: THREAD_ID,
      branch: BRANCH,
      entries: [],
      hasMore: false,
      truncated: false,
    });
  },
  async getSessionUsage({ api }) {
    const usage = await api.getSessionUsage({ threadId: THREAD_ID, branch: BRANCH });
    assert.equal(usage.usage.cost, "0.0125");
    assert.equal(usage.cache.cacheReadTokens, 8);
  },
  async getSystemPromptSnapshot({ api }) {
    assert.deepEqual(await api.getSystemPromptSnapshot({ threadId: THREAD_ID, branch: BRANCH }), {
      threadId: THREAD_ID,
      branch: BRANCH,
      text: "Redacted semantic system prompt",
      bytes: 31,
      sha256: HASH,
      redacted: true,
      model: { provider: "semantic-provider", model: "semantic-model" },
    });
  },
  async setActiveTools({ api }) {
    assert.deepEqual(await api.setActiveTools({ threadId: THREAD_ID, branch: BRANCH, names: ["semantic_tool"] }), ["semantic_tool"]);
  },
  async setSessionName({ api }) {
    assert.deepEqual(await api.setSessionName({ threadId: THREAD_ID, branch: BRANCH, name: "Renamed" }), {
      threadId: THREAD_ID,
      branch: BRANCH,
      name: "Renamed",
    });
  },
  async setEntryLabel({ api }) {
    assert.equal((await api.setEntryLabel({
      threadId: THREAD_ID,
      branch: BRANCH,
      targetEventId: "target-event",
      label: "checkpoint",
    })).label, "checkpoint");
  },
  async sendUserMessage({ api }) {
    assert.deepEqual(await api.sendUserMessage({
      threadId: THREAD_ID,
      branch: BRANCH,
      text: "continue",
      delivery: "follow_up",
    }), { threadId: THREAD_ID, branch: BRANCH, delivery: "follow_up", queued: true });
  },
  async sendMessage({ api }) {
    const record = await api.sendMessage({
      threadId: THREAD_ID,
      branch: BRANCH,
      schemaVersion: 1,
      kind: "semantic_message",
      payload: { source: "root" },
      modelContext: false,
      transcript: { text: "Root semantic message" },
    });
    assert.equal(record.extensionId, EXTENSION_ID);
  },
  async abort({ api }) {
    assert.equal(await api.abort({ threadId: THREAD_ID, branch: BRANCH, reason: "semantic abort" }), true);
  },
  async compact({ api }) {
    assert.deepEqual(await api.compact({ threadId: THREAD_ID, branch: BRANCH, summaryTokenBudget: 64 }), {
      threadId: THREAD_ID,
      branch: BRANCH,
      summary: "Semantic summary",
    });
  },
  async runChild({ api }) {
    let started = false;
    let eventObserved = false;
    const result = await api.runChild({
      threadId: THREAD_ID,
      branch: BRANCH,
      prompt: "Review this change",
      context: "fork",
      tools: ["read"],
      systemPrompt: "You are a focused reviewer.",
      appendSystemPrompt: "Report only verified defects.",
      session: "ephemeral",
      onStart(session) { started = session.threadId === "child-thread"; },
      onEvent(event) { eventObserved = event.event.type === "run_started"; },
    });
    assert.equal(result.finalText, "Child completed");
    assert.equal(started, true);
    assert.equal(eventObserved, true);
  },
  async reload({ api }) {
    assert.deepEqual(await api.reload({ threadId: THREAD_ID, branch: BRANCH }), { warnings: ["semantic reload"] });
  },
  async requestShutdown({ api }) {
    const result = await api.requestShutdown({ reason: "semantic complete" });
    assert.deepEqual({ accepted: result.accepted, acknowledged: result.acknowledged, message: result.message }, {
      accepted: true,
      acknowledged: true,
      message: "semantic shutdown",
    });
  },
  async newSession({ api }) {
    assert.equal((await api.newSession({ name: "Created", defaultBranch: "feature" })).branch, "feature");
  },
  async forkSession({ api }) {
    assert.equal((await api.forkSession({
      threadId: THREAD_ID,
      branch: BRANCH,
      atEventId: "event-1",
      name: "Forked",
    })).threadId, "fork-thread");
  },
  async switchSession({ api }) {
    assert.equal((await api.switchSession({ threadId: THREAD_ID, branch: "review" })).branch, "review");
  },
  async getSession({ api }) {
    assert.equal((await api.getSession({ threadId: THREAD_ID, branch: BRANCH })).threadId, THREAD_ID);
  },
  async waitForIdle({ api }) {
    await api.waitForIdle({ threadId: THREAD_ID, branch: BRANCH });
  },
  async getSessionTree({ api }) {
    assert.deepEqual(await api.getSessionTree({ threadId: THREAD_ID, branch: BRANCH }), []);
  },
  async navigateSessionTree({ api }) {
    assert.deepEqual(await api.navigateSessionTree({
      threadId: THREAD_ID,
      branch: BRANCH,
      targetBranch: BRANCH,
      targetEventId: null,
      newBranch: "reviewed",
      summarize: true,
      provider: "semantic-provider",
      model: "semantic-model",
      summaryTokenBudget: 64,
      summaryInstructions: "semantic focus",
      replaceInstructions: true,
      label: "semantic label",
    }), { cancelled: false, branch: "reviewed" });
  },
  async getModel({ api }) {
    assert.deepEqual(await api.getModel({ threadId: THREAD_ID, branch: BRANCH }), {
      provider: "semantic-provider",
      model: "semantic-model",
    });
  },
  async setModel({ api }) {
    assert.deepEqual(await api.setModel({
      threadId: THREAD_ID,
      branch: BRANCH,
      provider: "semantic-provider",
      model: "semantic-model",
      reasoningEffort: "medium",
    }), { provider: "semantic-provider", model: "semantic-model", reasoningEffort: "medium" });
  },
  async setThinkingLevel({ api }) {
    assert.equal((await api.setThinkingLevel({
      threadId: THREAD_ID,
      branch: BRANCH,
      reasoningEffort: "low",
    })).reasoningEffort, "low");
  },
  async exec({ api }) {
    assert.deepEqual(await api.exec({ command: "semantic-command", args: ["one"], timeoutMs: 100 }), {
      exitCode: 0,
      signal: null,
      stdout: "semantic stdout",
      stderr: "",
      stdoutBytes: 15,
      stderrBytes: 0,
      timedOut: false,
      cancelled: false,
      durationMs: 1,
    });
  },
  on(context) {
    context.api.on("event", (event) => { context.lifecycleEvent = event; });
  },
  onDispose(context) {
    context.api.onDispose(() => { context.disposed = true; });
  },
  ui({ api }) {
    assert.equal(Object.isFrozen(api.ui), true);
  },
  auth({ api }) {
    assert.equal(Object.isFrozen(api.auth), true);
  },
  events({ api }) {
    assert.equal(Object.isFrozen(api.events), true);
  },
  session({ api }) {
    assert.equal(Object.isFrozen(api.session), true);
  },
  native({ api }) {
    assert.equal(Object.isFrozen(api.native), true);
  },
} satisfies SemanticEvidence<RuntimeExtensionApi>;

const UI_EVIDENCE = {
  setStatus({ api }) { api.ui.setStatus("semantic", "ready"); },
  setWidget({ api }) { api.ui.setWidget("semantic", "widget"); },
  setHeader({ api }) { api.ui.setHeader("semantic", "header"); },
  setFooter({ api }) { api.ui.setFooter("semantic", "footer"); },
  setWorkingMessage({ api }) { api.ui.setWorkingMessage("working"); },
  setWorkingVisible({ api }) { api.ui.setWorkingVisible(false); },
  setTitle({ api }) { api.ui.setTitle("Semantic title"); },
  notify({ api }) { api.ui.notify("Semantic notice", "warning"); },
  registerAutocompleteProvider({ api }) {
    api.ui.registerAutocompleteProvider(({ text, cursor }) => [{ start: 0, end: cursor, value: text.toUpperCase() }]);
  },
  registerEditorMiddleware({ api }) {
    api.ui.registerEditorMiddleware((_event, snapshot) => ({ action: "replace", text: `${snapshot.text}!` }));
  },
  advanced({ api }) {
    assert.equal(Object.isFrozen(api.ui.advanced), true);
  },
} satisfies SemanticEvidence<RuntimeExtensionApi["ui"]>;

const ADVANCED_UI_EVIDENCE = {
  setComponent({ api }) {
    api.ui.advanced.setComponent("header", "semantic", () => ({
      render() { return { lines: [{ spans: [{ text: "semantic", role: "accent" }] }] }; },
    }));
  },
  setWorkingIndicator({ api }) {
    api.ui.advanced.setWorkingIndicator({ frames: [".", ".."], intervalMs: 100 });
  },
  setHiddenReasoningLabel({ api }) {
    api.ui.advanced.setHiddenReasoningLabel("Reasoning");
  },
  getToolOutputExpanded({ api }) {
    assert.equal(api.ui.advanced.getToolOutputExpanded(), true);
  },
  setToolOutputExpanded({ api }) {
    api.ui.advanced.setToolOutputExpanded(false);
  },
  observeKeys(context) {
    context.keyObserverDisposer = context.api.ui.advanced.observeKeys(() => {});
  },
} satisfies SemanticEvidence<RuntimeAdvancedUiApi>;

const AUTH_EVIDENCE = {
  async fetch({ api }) {
    const response = await api.auth.fetch("semantic-provider", "https://semantic.invalid/resource", { method: "POST" });
    assert.equal(await response.text(), "authenticated");
  },
} satisfies SemanticEvidence<RuntimeExtensionApi["auth"]>;

const EVENTS_EVIDENCE = {
  on(context) {
    context.api.events.on("semantic.topic", (payload) => { context.sharedPayload = payload; });
  },
  async emit({ api }) {
    await api.events.emit("semantic.topic", { value: 42 });
  },
} satisfies SemanticEvidence<RuntimeExtensionApi["events"]>;

const SESSION_EVIDENCE = {
  async appendState({ api }) {
    const result = await api.session.appendState({
      threadId: THREAD_ID,
      branch: BRANCH,
      schemaVersion: 1,
      key: "semantic_state",
      value: { version: 1 },
    });
    assert.equal(result.extensionId, EXTENSION_ID);
  },
  async compareAndAppendState({ api }) {
    const result = await api.session.compareAndAppendState({
      threadId: THREAD_ID,
      branch: BRANCH,
      schemaVersion: 1,
      key: "semantic_state",
      value: { version: 2 },
      expectedEventId: "state-event",
    });
    assert.equal(result.status, "committed");
  },
  async readState({ api }) {
    const result = await api.session.readState({
      threadId: THREAD_ID,
      branch: BRANCH,
      schemaVersion: 1,
      key: "semantic_state",
    });
    assert.equal(result?.extensionId, EXTENSION_ID);
  },
  async appendMessage({ api }) {
    const result = await api.session.appendMessage({
      threadId: THREAD_ID,
      branch: BRANCH,
      schemaVersion: 1,
      kind: "semantic_message",
      payload: { source: "session" },
      modelContext: { role: "system", text: "Semantic model context" },
      transcript: { text: "Semantic transcript" },
    });
    assert.equal(result.kind, "semantic_message");
  },
  async readMessages({ api }) {
    const result = await api.session.readMessages({
      threadId: THREAD_ID,
      branch: BRANCH,
      schemaVersion: 1,
      kind: "semantic_message",
      limit: 2,
      beforeEventId: "message-cursor",
    });
    assert.equal(result[0]?.eventId, "older-message");
  },
  registerRenderers({ api, host }) {
    api.session.registerRenderers(1, {
      renderState(entry) {
        return { lines: [{ spans: [{ text: entry.key, role: "accent" }] }] };
      },
      renderMessage(entry) {
        return { lines: [{ spans: [{ text: entry.kind, role: "accent" }] }] };
      },
    });
    assert.equal(host.renderers().some((entry) => entry.kind === "session" && entry.key === "1"), true);
  },
} satisfies SemanticEvidence<RuntimeExtensionApi["session"]>;

const NATIVE_EVIDENCE = {
  ui({ api }) { assert.equal(Object.isFrozen(api.native.ui), true); },
  terminal({ api }) { assert.equal(Object.isFrozen(api.native.terminal), true); },
  session({ api }) { assert.equal(Object.isFrozen(api.native.session), true); },
  credentials({ api }) { assert.equal(Object.isFrozen(api.native.credentials), true); },
  providers({ api }) { assert.equal(Object.isFrozen(api.native.providers), true); },
  host({ api }) { assert.equal(Object.isFrozen(api.native.host), true); },
} satisfies SemanticEvidence<RuntimeExtensionApi["native"]>;

const NATIVE_UI_EVIDENCE = {
  extensionId({ api }) { assert.equal(api.native.ui.extensionId, EXTENSION_ID); },
  signal({ api }) { assert.equal(api.native.ui.signal.aborted, false); },
  onInput({ api }) { api.native.ui.onInput(() => ({ action: "pass" }))(); },
  getEditor({ api }) { assert.equal(api.native.ui.getEditor().empty, true); },
  replaceEditor({ api }) { api.native.ui.replaceEditor(new MultilineEditor())(); },
  wrapEditor({ api }) { api.native.ui.wrapEditor((editor) => editor)(); },
  mountHeader({ api }) { api.native.ui.mountHeader(() => ({ render: () => ({ lines: [] }) }))(); },
  mountFooter({ api }) { api.native.ui.mountFooter(() => ({ render: () => ({ lines: [] }) }))(); },
  mountWidget({ api }) { api.native.ui.mountWidget(() => ({ render: () => ({ lines: [] }) }), "below")(); },
  replaceHeader({ api }) { api.native.ui.replaceHeader(() => ({ render: () => ({ lines: [] }) }))(); },
  replaceFooter({ api }) { api.native.ui.replaceFooter(() => ({ render: () => ({ lines: [] }) }))(); },
  currentTheme({ api }) { assert.equal(api.native.ui.currentTheme().name, "mono"); },
  themeCatalog({ api }) { assert.equal(api.native.ui.themeCatalog().length, 1); },
  applyTheme({ api }) { api.native.ui.applyTheme(api.native.ui.currentTheme())(); },
  pasteToEditor({ api }) { api.native.ui.pasteToEditor("semantic paste"); },
  wrapAutocomplete({ api }) { api.native.ui.wrapAutocomplete((provider) => provider)(); },
  dispose({ api }) { api.native.ui.dispose(); },
} satisfies SemanticEvidence<RuntimeExtensionApi["native"]["ui"]>;

const UNSAFE_TERMINAL_EVIDENCE = {
  extensionId({ api }) { assert.equal(api.native.terminal.extensionId, EXTENSION_ID); },
  signal({ api }) { assert.equal(api.native.terminal.signal.aborted, false); },
  onInput({ api }) {
    const dispose = api.native.terminal.onInput((data, signal) => {
      assert.equal(data, "\u001b[A");
      assert.equal(signal.aborted, false);
      return { consume: true, data: "rewritten" };
    });
    dispose();
  },
  write({ api }) { api.native.terminal.write("\u001b]0;semantic\u0007"); },
  requestRender({ api }) { api.native.terminal.requestRender(); },
  size({ api }) { assert.deepEqual(api.native.terminal.size(), { columns: 120, rows: 40 }); },
  capabilities({ api }) {
    assert.deepEqual(api.native.terminal.capabilities(), {
      mode: "full",
      ansi: true,
      color: true,
      unicode: true,
      alternateScreen: true,
      bracketedPaste: true,
      rawInput: true,
      imageProtocol: null,
      hyperlinks: true,
      columns: 120,
      rows: 40,
    });
  },
  keybindings({ api }) {
    assert.deepEqual(api.native.terminal.keybindings().keys("app.tools.expand"), ["alt+t"]);
  },
  dispose({ api }) { api.native.terminal.dispose(); },
} satisfies SemanticEvidence<RuntimeExtensionApi["native"]["terminal"]>;

const NATIVE_SESSION_EVIDENCE = {
  async read({ api }) {
    const page = await api.native.session.read({
      threadId: THREAD_ID,
      branch: BRANCH,
      afterSequence: 0,
      limit: 2,
      includeContext: true,
    });
    assert.equal(page.thread.threadId, THREAD_ID);
    assert.equal(page.context?.[0]?.role, "system");
  },
  async getSystemPrompt({ api, host }) {
    await host.reduceBeforeAgentStart({
      threadId: THREAD_ID,
      runId: "semantic-run",
      branch: BRANCH,
      prompt: "Semantic prompt",
      systemPrompt: "Unredacted semantic system prompt",
    });
    assert.equal((await api.native.session.getSystemPrompt({ threadId: THREAD_ID, branch: BRANCH }))?.systemPrompt,
      "Unredacted semantic system prompt");
  },
} satisfies SemanticEvidence<RuntimeExtensionApi["native"]["session"]>;

const NATIVE_CREDENTIAL_EVIDENCE = {
  async resolve({ api }) {
    const credential = await api.native.credentials.resolve("semantic-provider");
    assert.equal(credential?.credential.kind, "api_key");
    assert.equal(credential?.headers.authorization, "Bearer semantic-secret");
  },
} satisfies SemanticEvidence<RuntimeExtensionApi["native"]["credentials"]>;

const NATIVE_PROVIDER_EVIDENCE = {
  async override(context) {
    const dispose = context.api.native.providers.override({
      id: "semantic-provider",
      async *stream() {},
      async listModels() { return []; },
    });
    assert.equal(context.nativeRegistrations.includes("provider-override"), true);
    await dispose();
  },
  async overlay(context) {
    const dispose = context.api.native.providers.overlay({
      id: "semantic-provider",
      displayName: "Semantic Overlay",
      models: [],
      headers: { "x-semantic-overlay": "true" },
    });
    assert.equal(context.nativeRegistrations.includes("provider-overlay"), true);
    await dispose();
  },
  async intercept(context) {
    const dispose = context.api.native.providers.intercept("semantic-provider", {
      interceptRequest(request) { return { headers: { ...request.headers, "x-semantic": "true" } }; },
      observeResponse(response) { assert.equal(response.provider, "semantic-provider"); },
    });
    assert.equal(context.nativeRegistrations.includes("provider-wire"), true);
    await dispose();
  },
} satisfies SemanticEvidence<RuntimeExtensionApi["native"]["providers"]>;

const NATIVE_HOST_EVIDENCE = {
  async getConfiguration({ api, root }) {
    const configuration = await api.native.host.getConfiguration();
    assert.equal(configuration.workspace, resolve(root));
    assert.equal(configuration.effective.theme, "dark");
  },
  async updateConfiguration({ api }) {
    const configuration = await api.native.host.updateConfiguration({ scope: "user", patch: { theme: "light" } });
    assert.equal(configuration.effective.theme, "light");
  },
} satisfies SemanticEvidence<RuntimeExtensionApi["native"]["host"]>;

function nativeUiHost(context: SemanticContext, signal: AbortSignal): NativeUiHost {
  const editor = new MultilineEditor();
  const theme = createTheme("mono", { color: false, unicode: true });
  const registration = (name: string) => {
    context.nativeUiCalls.push(name);
    return () => { context.nativeUiCalls.push(`${name}:dispose`); };
  };
  return {
    extensionId: EXTENSION_ID,
    signal,
    onInput() { return registration("input"); },
    getEditor() { context.nativeUiCalls.push("get-editor"); return editor; },
    replaceEditor(_editor: TuiEditorImplementation) { return registration("replace-editor"); },
    wrapEditor() { return registration("wrap-editor"); },
    mountHeader() { return registration("header"); },
    mountFooter() { return registration("footer"); },
    mountWidget() { return registration("widget"); },
    replaceHeader() { return registration("replace-header"); },
    replaceFooter() { return registration("replace-footer"); },
    currentTheme() { context.nativeUiCalls.push("theme"); return theme; },
    themeCatalog() { context.nativeUiCalls.push("themes"); return [theme]; },
    applyTheme() { return registration("apply-theme"); },
    pasteToEditor(value) { context.nativeUiCalls.push(`paste:${value}`); },
    wrapAutocomplete() { return registration("autocomplete"); },
    dispose() { context.nativeUiCalls.push("dispose"); },
  };
}

function unsafeTerminalHost(context: SemanticContext, signal: AbortSignal): UnsafeTerminalHost {
  return {
    extensionId: EXTENSION_ID,
    signal,
    onInput(handler) {
      context.unsafeTerminalCalls.push("input");
      assert.deepEqual(handler("\u001b[A", signal), { consume: true, data: "rewritten" });
      return () => { context.unsafeTerminalCalls.push("input:dispose"); };
    },
    write(data) { context.unsafeTerminalCalls.push(`write:${data}`); },
    requestRender() { context.unsafeTerminalCalls.push("render"); },
    size() { context.unsafeTerminalCalls.push("size"); return { columns: 120, rows: 40 }; },
    capabilities() {
      context.unsafeTerminalCalls.push("capabilities");
      return {
        mode: "full",
        ansi: true,
        color: true,
        unicode: true,
        alternateScreen: true,
        bracketedPaste: true,
        rawInput: true,
        imageProtocol: null,
        hyperlinks: true,
        columns: 120,
        rows: 40,
      };
    },
    keybindings() {
      context.unsafeTerminalCalls.push("keybindings");
      return new Keybindings({ "app.tools.expand": "alt+t" });
    },
    dispose() { context.unsafeTerminalCalls.push("dispose"); },
  };
}

function sessionHandler(context: SemanticContext): RuntimeExtensionSessionHandler {
  const seen = <Key extends keyof RuntimeExtensionSessionHandler>(key: Key): void => {
    context.handlerCalls.add(key);
  };
  return {
    async getResourceCatalog() {
      seen("getResourceCatalog");
      return structuredClone(EMPTY_CATALOG);
    },
    async listSessions() {
      seen("listSessions");
      return {
        schemaVersion: 1,
        sessions: [{
          threadId: THREAD_ID,
          name: "Semantic session",
          defaultBranch: BRANCH,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        }],
        hasMore: false,
      };
    },
    async getTranscript(input) {
      seen("getTranscript");
      assert.equal(input.afterSequence, 4);
      assert.equal(input.limit, 2);
      return { schemaVersion: 1, threadId: input.threadId, branch: input.branch ?? BRANCH, entries: [], hasMore: false, truncated: false };
    },
    async readNativeSession(input) {
      seen("readNativeSession");
      return {
        thread: {
          threadId: input.threadId,
          name: "Semantic session",
          defaultBranch: BRANCH,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
          branches: [{ threadId: input.threadId, name: BRANCH, createdAt: TIMESTAMP, updatedAt: TIMESTAMP }],
        },
        branch: input.branch ?? BRANCH,
        events: [],
        runs: [],
        nextSequence: 0,
        snapshotSequence: 0,
        hasMore: false,
        model: { provider: "semantic-provider", model: "semantic-model" },
        context: [{
          id: "semantic-context-message",
          role: "system",
          content: [{ type: "text", text: "Semantic canonical context" }],
          createdAt: TIMESTAMP,
        }],
      };
    },
    async appendState(input) {
      seen("appendState");
      return { ...input.event, threadId: input.threadId, branch: input.branch ?? BRANCH, eventId: "state-event", timestamp: TIMESTAMP };
    },
    async compareAndAppendState(input) {
      seen("compareAndAppendState");
      return {
        status: "committed",
        record: { ...input.event, threadId: input.threadId, branch: input.branch ?? BRANCH, eventId: "state-event-next", timestamp: TIMESTAMP },
      };
    },
    async readState(input) {
      seen("readState");
      assert.equal(input.extensionId, EXTENSION_ID);
      return {
        type: "extension_state",
        threadId: input.threadId,
        branch: input.branch ?? BRANCH,
        eventId: "state-event",
        timestamp: TIMESTAMP,
        extensionId: input.extensionId,
        schemaVersion: input.schemaVersion,
        key: input.key,
        value: { version: 1 },
      };
    },
    async appendMessage(input) {
      seen("appendMessage");
      return { ...input.event, threadId: input.threadId, branch: input.branch ?? BRANCH, eventId: "message-event", timestamp: TIMESTAMP };
    },
    async readMessages(input) {
      seen("readMessages");
      assert.equal(input.beforeEventId, "message-cursor");
      assert.equal(input.extensionId, EXTENSION_ID);
      return [{
        type: "extension_message",
        threadId: input.threadId,
        branch: input.branch ?? BRANCH,
        eventId: "older-message",
        timestamp: TIMESTAMP,
        extensionId: input.extensionId,
        schemaVersion: input.schemaVersion,
        kind: input.kind ?? "semantic_message",
        messageId: "semantic-message-id",
        payload: { older: true },
        modelContext: false,
        transcript: { text: "Older semantic message" },
      }];
    },
    async getUsage(input) {
      seen("getUsage");
      return {
        threadId: input.threadId,
        branch: input.branch ?? BRANCH,
        runCount: 2,
        responseCount: 3,
        usageEventCount: 3,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 8, cost: "0.0125" },
        cache: {
          status: "effective",
          samples: 3,
          observedInputTokens: 18,
          uncachedInputTokens: 10,
          cacheReadTokens: 8,
          cacheWriteTokens: 0,
          reuseRatio: 8 / 18,
        },
      };
    },
    async getSystemPrompt(input) {
      seen("getSystemPrompt");
      return {
        threadId: input.threadId,
        branch: input.branch ?? BRANCH,
        text: "Redacted semantic system prompt",
        bytes: 31,
        sha256: HASH,
        redacted: true,
        model: { provider: "semantic-provider", model: "semantic-model" },
      };
    },
    async getActiveTools(input) {
      seen("getActiveTools");
      assert.equal(input.requesterExtensionId, EXTENSION_ID);
      assert.equal(input.requesterSourcePath, context.sourcePath);
      return ["read", "semantic_tool"];
    },
    async getAllTools(input) {
      seen("getAllTools");
      assert.equal(input.requesterExtensionId, EXTENSION_ID);
      return [{
        name: "read",
        description: "Read a file",
        inputSchema: { type: "object" },
        active: true,
        executionMode: "parallel",
        owner: { kind: "builtin" },
      }];
    },
    async setActiveTools(input) {
      seen("setActiveTools");
      assert.equal(input.requesterExtensionId, EXTENSION_ID);
      return input.names;
    },
    async setSessionName(input) {
      seen("setSessionName");
      return { threadId: input.threadId, branch: input.branch ?? BRANCH, ...(input.name === undefined ? {} : { name: input.name }) };
    },
    async setEntryLabel(input) {
      seen("setEntryLabel");
      return {
        threadId: input.threadId,
        branch: input.branch ?? BRANCH,
        targetEventId: input.targetEventId,
        eventId: "label-event",
        timestamp: TIMESTAMP,
        ...(input.label === undefined ? {} : { label: input.label }),
      };
    },
    async sendUserMessage(input) {
      seen("sendUserMessage");
      assert.equal(input.requesterExtensionId, EXTENSION_ID);
      return { threadId: input.threadId, branch: input.branch ?? BRANCH, delivery: input.delivery ?? "steer", queued: true };
    },
    async cancel() {
      seen("cancel");
      return true;
    },
    async compact(input) {
      seen("compact");
      return { threadId: input.threadId, branch: input.branch ?? BRANCH, summary: "Semantic summary" };
    },
    async runChild(input) {
      seen("runChild");
      assert.equal(input.systemPrompt, "You are a focused reviewer.");
      assert.equal(input.appendSystemPrompt, "Report only verified defects.");
      input.onStart?.({
        threadId: "child-thread",
        branch: BRANCH,
        model: { provider: "semantic-provider", model: "semantic-model" },
        persisted: false,
      });
      input.onEvent?.({
        threadId: "child-thread",
        branch: BRANCH,
        runId: "child-run",
        sequence: 1,
        timestamp: TIMESTAMP,
        event: { type: "run_started", provider: "semantic-provider", model: "semantic-model" },
      });
      return {
        status: "success",
        summary: "Child completed",
        nextActions: [],
        threadId: "child-thread",
        branch: BRANCH,
        model: { provider: "semantic-provider", model: "semantic-model" },
        persisted: false,
        runId: "child-run",
        finishReason: "stop",
        finalText: "Child completed",
        steps: 1,
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        artifacts: [],
        artifactCount: 0,
        artifactsTruncated: false,
        execution: { backend: "local", required: false, routedTools: [], localTools: ["read"] },
        truncated: false,
      };
    },
    async createSession(input) {
      seen("createSession");
      return sessionSnapshot("created-thread", input.defaultBranch ?? BRANCH);
    },
    async forkSession() {
      seen("forkSession");
      return sessionSnapshot("fork-thread");
    },
    async inspectSession(input) {
      seen("inspectSession");
      if (input.threadId === "semantic-failure") throw new Error("semantic handler failure");
      return sessionSnapshot(input.threadId, input.branch ?? BRANCH);
    },
    async waitForIdle() {
      seen("waitForIdle");
    },
    async sessionTree() {
      seen("sessionTree");
      return [];
    },
    async navigateSession(input) {
      seen("navigateSession");
      assert.equal(input.summaryInstructions, "semantic focus");
      assert.equal(input.replaceInstructions, true);
      assert.equal(input.label, "semantic label");
      return { cancelled: false, branch: input.newBranch };
    },
    async getModel() {
      seen("getModel");
      return { provider: "semantic-provider", model: "semantic-model" };
    },
    async setModel(input) {
      seen("setModel");
      return { provider: input.provider, model: input.model, ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }) };
    },
    async setThinking(input) {
      seen("setThinking");
      return { provider: "semantic-provider", model: "semantic-model", reasoningEffort: input.reasoningEffort };
    },
    async exec() {
      seen("exec");
      return {
        exitCode: 0,
        signal: null,
        stdout: "semantic stdout",
        stderr: "",
        stdoutBytes: 15,
        stderrBytes: 0,
        timedOut: false,
        cancelled: false,
        durationMs: 1,
      };
    },
  };
}

test("every public runtime extension API member has executable semantic evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-api-conformance-"));
  const sourcePath = join(root, "semantic-extension.mjs");
  const source = `export default (api) => { globalThis.__rigynSemanticConformanceApi = api; };\n`;
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: EXTENSION_ID,
    sourcePath,
    sha256: sha256(source),
    trusted: true,
    permissions: {
      advancedUi: true,
      nativeUi: true,
      unsafeTerminal: true,
      providerOverride: true,
      providerWire: true,
      credentialAccess: true,
      sessionRaw: true,
      hostConfiguration: true,
    },
  }], { workspace: root, dataRoot: join(root, "state") });
  const api = (globalThis as Record<string, unknown>).__rigynSemanticConformanceApi as RuntimeExtensionApi;
  const context: SemanticContext = {
    api,
    host,
    root,
    sourcePath,
    uiOperations: [],
    advancedUiOperations: [],
    handlerCalls: new Set(),
    nativeUiCalls: [],
    unsafeTerminalCalls: [],
    nativeRegistrations: [],
    disposed: false,
  };
  t.after(async () => {
    delete (globalThis as Record<string, unknown>).__rigynSemanticConformanceApi;
    await host.close();
    await rm(root, { recursive: true, force: true });
  });

  const registrationCleanup: string[] = [];
  const nativeCleanup = (name: string) => {
    context.nativeRegistrations.push(name);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      context.nativeRegistrations.push(`${name}:dispose`);
    };
  };
  host.setLiveRegistrationHandler({
    registerTool(tool) {
      assert.equal(tool.definition.name, "semantic_tool");
      return () => { registrationCleanup.push("tool"); };
    },
    registerProvider(provider) {
      assert.equal(provider.id, "semantic-provider");
      return () => { registrationCleanup.push("provider"); };
    },
    overrideProvider(provider) {
      assert.equal(provider.id, "semantic-provider");
      return nativeCleanup("provider-override");
    },
    overlayProvider(overlay) {
      assert.equal(overlay.id, "semantic-provider");
      assert.equal(overlay.displayName, "Semantic Overlay");
      return nativeCleanup("provider-overlay");
    },
    registerProviderWire(provider, interceptor) {
      assert.equal(provider, "semantic-provider");
      assert.equal(typeof interceptor.interceptRequest, "function");
      return nativeCleanup("provider-wire");
    },
    unregisterProvider() {
      throw new Error("provider cleanup should use its registration disposer");
    },
    registerProviderAuth(auth) {
      assert.equal(auth.extensionId, EXTENSION_ID);
      return () => { registrationCleanup.push("provider-auth"); };
    },
    async fetchProvider(provider, input, init) {
      assert.equal(provider, "semantic-provider");
      assert.equal(String(input), "https://semantic.invalid/resource");
      assert.equal(init?.method, "POST");
      return new Response("authenticated");
    },
  });
  host.setUiHandler((operation) => { context.uiOperations.push(operation); });
  host.setAdvancedUiHandler({
    apply(operation) { context.advancedUiOperations.push(operation); },
    getToolOutputExpanded() { return true; },
  });
  host.setInteractiveUiHandler(() => commandUi());
  host.setSessionHandler(sessionHandler(context));
  host.setNativeUiHandler((_extensionId, signal) => nativeUiHost(context, signal));
  host.setUnsafeTerminalHandler((_extensionId, signal) => unsafeTerminalHost(context, signal));
  let effectiveTheme = "dark";
  host.setNativeHostHandler({
    async resolveCredential(provider) {
      return {
        provider,
        source: "semantic-test",
        credential: { kind: "api_key", apiKey: "semantic-secret" },
        headers: { authorization: "Bearer semantic-secret" },
      };
    },
    async getConfiguration() {
      return {
        workspace: resolve(root),
        projectTrusted: true,
        globalConfigPath: join(root, "config.jsonc"),
        projectConfigPath: join(root, ".rigyn", "config.jsonc"),
        databasePath: join(root, "state.sqlite"),
        effective: { theme: effectiveTheme },
      };
    },
    async updateConfiguration(input) {
      if (typeof input.patch.theme === "string") effectiveTheme = input.patch.theme;
      return {
        workspace: resolve(root),
        projectTrusted: true,
        globalConfigPath: join(root, "config.jsonc"),
        projectConfigPath: join(root, ".rigyn", "config.jsonc"),
        databasePath: join(root, "state.sqlite"),
        effective: { theme: effectiveTheme },
      };
    },
  });
  host.setReloadHandler(async (input) => {
    assert.equal(input.session?.threadId, THREAD_ID);
    return { warnings: ["semantic reload"] };
  });
  host.setShutdownHandler(async (input) => {
    assert.equal(input.extensionId, EXTENSION_ID);
    return { accepted: true, message: "semantic shutdown" };
  });
  host.setSessionFocusHandler(() => {});
  host.setModelFocusHandler(() => {});

  for (const exercise of Object.values(ROOT_EVIDENCE)) await exercise(context);
  for (const exercise of Object.values(UI_EVIDENCE)) await exercise(context);
  for (const exercise of Object.values(ADVANCED_UI_EVIDENCE)) await exercise(context);
  for (const exercise of Object.values(AUTH_EVIDENCE)) await exercise(context);
  for (const exercise of Object.values(EVENTS_EVIDENCE)) await exercise(context);
  for (const exercise of Object.values(SESSION_EVIDENCE)) await exercise(context);
  for (const exercise of Object.values(NATIVE_EVIDENCE)) await exercise(context);
  for (const exercise of Object.values(NATIVE_UI_EVIDENCE)) await exercise(context);
  for (const exercise of Object.values(UNSAFE_TERMINAL_EVIDENCE)) await exercise(context);
  for (const exercise of Object.values(NATIVE_SESSION_EVIDENCE)) await exercise(context);
  for (const exercise of Object.values(NATIVE_CREDENTIAL_EVIDENCE)) await exercise(context);
  for (const exercise of Object.values(NATIVE_PROVIDER_EVIDENCE)) await exercise(context);
  for (const exercise of Object.values(NATIVE_HOST_EVIDENCE)) await exercise(context);

  assert.equal((await host.runCommand("semantic-command", {
    args: "value",
    threadId: THREAD_ID,
    branch: BRANCH,
    signal: AbortSignal.timeout(1_000),
    ui: commandUi(),
  })).prompt, "semantic:value");
  assert.deepEqual(await host.completeCommandArguments("semantic-command", "arg"), [{ value: "arg-complete" }]);
  await host.runShortcut("ctrl+alt+s", {
    threadId: THREAD_ID,
    branch: BRANCH,
    signal: AbortSignal.timeout(1_000),
    ui: commandUi(),
  });
  assert.deepEqual(await host.completeInput({ text: "go", cursor: 2 }), [{ start: 0, end: 2, value: "GO" }]);
  assert.deepEqual(host.handleEditorInput(
    { key: "text", text: "x", ctrl: false, alt: false, shift: false },
    { text: "draft", cursor: 5 },
  ), { action: "replace", text: "draft!", cursor: 6 });
  assert.equal(host.renderToolCall("semantic_tool", {
    callId: "call-1",
    name: "semantic_tool",
    input: { text: "value" },
    status: "running",
    expanded: false,
  }, { width: 80, height: 20, focused: false, expanded: false, theme: { name: "dark", color: true, unicode: true } })
    ?.lines[0]?.spans[0]?.text, "call:semantic_tool");
  assert.equal(host.renderEditor({ text: "draft", cursor: 2, label: "you", mode: "normal", blocked: false }, {
    width: 80,
    height: 20,
    focused: true,
    expanded: false,
    theme: { name: "dark", color: true, unicode: true },
  })?.lines[0]?.spans[0]?.text, "editor:draft");

  const observedEvent: EventEnvelope = {
    eventId: "semantic-event",
    threadId: THREAD_ID,
    sequence: 1,
    timestamp: TIMESTAMP,
    schemaVersion: 1,
    event: { type: "warning", code: "semantic", message: "semantic warning" },
  };
  await host.dispatch("event", observedEvent);
  assert.deepEqual(context.lifecycleEvent, observedEvent);
  assert.deepEqual(context.sharedPayload, { value: 42 });
  assert.deepEqual(context.uiOperations.map((operation) => operation.type), [
    "status", "widget", "header", "footer", "working_message", "working_visible", "title", "notify",
  ]);
  assert.deepEqual(context.advancedUiOperations.map((operation) => operation.type), [
    "component", "working_indicator", "hidden_reasoning_label", "tool_output_expanded", "key_observer",
  ]);
  assert.deepEqual(context.unsafeTerminalCalls, [
    "input",
    "input:dispose",
    "write:\u001b]0;semantic\u0007",
    "render",
    "size",
    "capabilities",
    "keybindings",
    "dispose",
  ]);
  context.keyObserverDisposer?.();
  context.keyObserverDisposer?.();
  assert.equal(context.advancedUiOperations.at(-1)?.type, "key_observer");
  assert.equal((context.advancedUiOperations.at(-1) as { observer?: unknown }).observer, undefined);

  assert.ok(context.providerDisposer);
  await context.providerDisposer();
  await context.providerDisposer();
  assert.deepEqual(host.providers(), []);
  assert.deepEqual(host.providerAuth(), []);
  assert.deepEqual(registrationCleanup.filter((value) => value === "provider"), ["provider"]);
  assert.deepEqual(registrationCleanup.filter((value) => value === "provider-auth"), ["provider-auth"]);

  await assert.rejects(
    api.auth.fetch("not-owned", "https://semantic.invalid/resource"),
    /does not own provider authentication/u,
  );
  await assert.rejects(
    api.getSession({ threadId: "semantic-failure", branch: BRANCH }),
    /semantic handler failure/u,
  );

  const expectedHandlerCalls = {
    getResourceCatalog: true,
    listSessions: true,
    getTranscript: true,
    readNativeSession: true,
    appendState: true,
    compareAndAppendState: true,
    readState: true,
    appendMessage: true,
    readMessages: true,
    getUsage: true,
    getSystemPrompt: true,
    getActiveTools: true,
    getAllTools: true,
    setActiveTools: true,
    setSessionName: true,
    setEntryLabel: true,
    sendUserMessage: true,
    cancel: true,
    compact: true,
    runChild: true,
    createSession: true,
    forkSession: true,
    inspectSession: true,
    waitForIdle: true,
    sessionTree: true,
    navigateSession: true,
    getModel: true,
    setModel: true,
    setThinking: true,
    exec: true,
  } satisfies Record<keyof RuntimeExtensionSessionHandler, true>;
  assert.deepEqual([...context.handlerCalls].sort(), Object.keys(expectedHandlerCalls).sort());

  await host.close();
  assert.equal(api.signal.aborted, true);
  assert.equal(context.disposed, true);
  assert.throws(() => api.ui.setStatus("stale", "value"), /no longer active/u);
  assert.throws(() => api.ui.advanced.setWorkingIndicator(), /no longer active/u);
  assert.throws(() => api.native.terminal.size(), /no longer active/u);
  await assert.rejects(api.auth.fetch("semantic-provider", "https://semantic.invalid"), /no longer active/u);
  await assert.rejects(api.events.emit("semantic.topic", null), /no longer active/u);
  await assert.rejects(api.session.readState({
    threadId: THREAD_ID,
    branch: BRANCH,
    schemaVersion: 1,
    key: "semantic_state",
  }), /no longer active/u);
  await assert.rejects(api.getSession({ threadId: THREAD_ID, branch: BRANCH }), /no longer active/u);
});

test("advanced UI is present but permission-gated for ordinary trusted extensions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-api-permission-"));
  const sourcePath = join(root, "ordinary-extension.mjs");
  const source = `export default (api) => { globalThis.__rigynOrdinarySemanticApi = api; };\n`;
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "ordinary-semantic",
    sourcePath,
    sha256: sha256(source),
    trusted: true,
  }], { workspace: root });
  const api = (globalThis as Record<string, unknown>).__rigynOrdinarySemanticApi as RuntimeExtensionApi;
  t.after(async () => {
    delete (globalThis as Record<string, unknown>).__rigynOrdinarySemanticApi;
    await host.close();
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(Object.isFrozen(api.ui.advanced), true);
  assert.equal(Object.isFrozen(api.native.terminal), true);
  assert.throws(
    () => api.ui.advanced.setHiddenReasoningLabel("Reasoning"),
    /trusted manifest with permissions\.advancedUi enabled/u,
  );
  assert.throws(
    () => api.native.terminal.size(),
    /trusted manifest with permissions\.unsafeTerminal enabled/u,
  );
});
