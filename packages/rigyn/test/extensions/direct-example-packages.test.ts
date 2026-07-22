import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { DefaultPackageManager } from "../../src/core/package-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import {
  loadDirectExtensions,
  type RuntimeDirectAutocompleteProviderFactory,
  type RuntimeCommandUi,
  type RuntimeDirectEditorFactory,
  type RuntimeDirectTerminalInputHandler,
  type RuntimeDirectUiContext,
  type RuntimeExtensionHost,
} from "../../src/extensions/runtime.js";
import { extensionSessionManager } from "../../src/extensions/session-contract.js";
import { DirectProcessRunner } from "../../src/process/index.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import { createModels, type ProviderModel } from "../../src/providers/models.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { WorkspaceBoundary } from "../../src/tools/index.js";

const exampleNames = [
  "starter",
  "lifecycle-events",
  "command-controls",
  "tool-rendering",
  "input-guard",
  "ui-surfaces",
  "context-compaction",
  "messages-bus",
  "model-controls",
  "provider-override",
  "raw-editor-ui",
  "session-jsonl",
  "session-control",
  "session-metadata",
  "subprocess-workers",
  "dynamic-package",
  "provider-hooks",
  "runtime-catalog",
  "session-lifecycle",
  "provider-catalog",
  "terminal-workbench",
  "project-trust",
] as const;

type ExampleName = (typeof exampleNames)[number];

interface ActionCall {
  name: string;
  values: unknown[];
}

async function loadExample(
  context: TestContext,
  name: ExampleName,
): Promise<{ host: RuntimeExtensionHost; workspace: string; session: SessionManager; calls: ActionCall[] }> {
  const root = await mkdtemp(join(tmpdir(), `rigyn-direct-example-${name}-`));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  await mkdir(agentDir);
  const manager = new DefaultPackageManager({
    cwd: workspace,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
  });
  const resources = await manager.resolveExtensionSources([resolve("examples", name)], { temporary: true });
  assert.equal(resources.extensions.length, 1);
  const metadata = new Map(resources.extensions.map((entry) => [entry.path, {
    scope: entry.metadata.scope,
    trusted: true,
    ...(entry.metadata.baseDir === undefined ? {} : { resourceRoot: entry.metadata.baseDir }),
  }] as const));
  const host = await loadDirectExtensions(resources.extensions.map((entry) => entry.path), {
    workspace,
    mode: "tui",
    activationFailure: "throw",
    directPathMetadata: metadata,
  });
  const session = SessionManager.inMemory(workspace, { id: `example-${name}` });
  const calls: ActionCall[] = [];
  const models = createModels();
  const selectedModel: ProviderModel = {
    id: "example-model",
    name: "Example model",
    api: "openai-chat-completions",
    provider: "example-provider",
    baseUrl: "https://provider.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 2_048,
  };
  host.setDirectContextHandler(() => ({
    sessionManager: extensionSessionManager(session),
    modelRegistry: new ModelRegistry(models),
    model: selectedModel,
    isIdle: () => true,
    hasPendingMessages() { calls.push({ name: "hasPendingMessages", values: [] }); return true; },
    abort() { calls.push({ name: "abort", values: [] }); },
    shutdown() { calls.push({ name: "shutdown", values: [] }); },
    getContextUsage: () => ({ tokens: 1200, contextWindow: 8000, percent: 15 }),
    compact(...values) { calls.push({ name: "compact", values }); },
    getSystemPrompt: () => "example system prompt",
  }));
  host.setDirectActionsHandler({
    sendMessage(...values) { calls.push({ name: "sendMessage", values }); },
    sendUserMessage(...values) { calls.push({ name: "sendUserMessage", values }); },
    appendEntry(...values) { calls.push({ name: "appendEntry", values }); },
    setSessionName(...values) { calls.push({ name: "setSessionName", values }); },
    getSessionName: () => session.getSessionName(),
    setLabel(...values) { calls.push({ name: "setLabel", values }); },
    async exec(...values) {
      calls.push({ name: "exec", values });
      if (name === "subprocess-workers") {
        const prompt = (values[1] as string[]).at(-1) ?? "";
        if (prompt.includes("reviewer specialist")) {
          return { stdout: "", stderr: "review worker unavailable", code: 7, killed: false };
        }
        const role = prompt.match(/the (\w+) specialist/u)?.[1] ?? "unknown";
        return {
          stdout: `${JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: `${role} report` }],
              usage: {
                input: 2,
                output: 3,
                cacheRead: 1,
                cacheWrite: 0,
                totalTokens: 6,
                cost: { input: 0.001, output: 0.002, cacheRead: 0.0005, cacheWrite: 0, total: 0.0035 },
              },
              stopReason: "stop",
            },
          })}\n`,
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      return { stdout: "worker output", stderr: "", code: 0, killed: false };
    },
    getActiveTools: () => ["read"],
    getAllTools: () => [{
      name: "read",
      description: "Read a file",
      inputSchema: { type: "object" },
      active: true,
      executionMode: "parallel",
      owner: { kind: "builtin" },
    }],
    setActiveTools(...values) { calls.push({ name: "setActiveTools", values }); },
    async setModel(...values) { calls.push({ name: "setModel", values }); return true; },
    getThinkingLevel: () => "off",
    setThinkingLevel(...values) { calls.push({ name: "setThinkingLevel", values }); },
    registerProvider(providerOrName: unknown, config?: unknown) {
      calls.push({ name: "registerProvider", values: [providerOrName, ...(config === undefined ? [] : [config])] });
    },
    unregisterProvider(...values) { calls.push({ name: "unregisterProvider", values }); },
    getSystemPromptOptions() { calls.push({ name: "getSystemPromptOptions", values: [] }); return { cwd: workspace, selectedTools: ["read"] }; },
    async waitForIdle() { calls.push({ name: "waitForIdle", values: [] }); },
    async newSession(...values) { calls.push({ name: "newSession", values }); return { cancelled: false }; },
    async fork(...values) { calls.push({ name: "fork", values }); return { cancelled: false }; },
    async navigateTree(...values) { calls.push({ name: "navigateTree", values }); return { cancelled: false }; },
    async switchSession(...values) { calls.push({ name: "switchSession", values }); return { cancelled: false }; },
    async reload() { calls.push({ name: "reload", values: [] }); },
  });
  host.setDirectDiscoveryHandler(() => ({
    resources: [
      { kind: "command", source: "builtin", name: "help" },
      { kind: "prompt", name: "review", extensionId: "example" },
      { kind: "skill", name: "audit", description: "Audit changes", scope: "workspace", trusted: true, disableModelInvocation: false },
    ],
    truncated: false,
    omitted: { commands: 0, prompts: 0, skills: 0 },
  }));
  context.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(host.diagnostics(), []);
  return { host, workspace, session, calls };
}

function commandUi(notices: string[] = []): RuntimeCommandUi {
  return {
    notify(message) { notices.push(message); },
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
    showOverlay(): never { throw new Error("overlay not used"); },
  };
}

async function runCommand(
  host: RuntimeExtensionHost,
  name: string,
  args = "",
  notices: string[] = [],
): Promise<void> {
  assert.deepEqual(await host.runCommand(name, {
    args,
    threadId: "example-thread",
    branch: "main",
    signal: new AbortController().signal,
    ui: commandUi(notices),
  }), { handled: true });
}

test("the direct example corpus is exactly the documented package.json packages without legacy manifests", async () => {
  const discovered: string[] = [];
  for (const entry of await readdir(resolve("examples"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(resolve("examples", entry.name, "package.json"));
      discovered.push(entry.name);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  assert.deepEqual(discovered.sort(), [...exampleNames].sort());
  for (const name of exampleNames) {
    const packageRoot = resolve("examples", name);
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      rigyn?: { extensions?: string[] };
    };
    assert.deepEqual(packageJson.rigyn?.extensions, ["extensions/index.mjs"]);
  }
});

test("lifecycle example observes the complete run lifecycle", async (context) => {
  const { host } = await loadExample(context, "lifecycle-events");
  const message = {
    id: "message-1",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  await host.dispatch("agent_start", {
    threadId: "example-thread",
    branch: "main",
    runId: "example-run",
    provider: "openai",
    model: "example-model",
  });
  await host.dispatch("turn_start", { turnIndex: 0, timestamp: 1 } as never);
  await host.dispatch("message_start", { message } as never);
  await host.dispatch("message_update", {
    message,
    assistantMessageEvent: { type: "text_delta", delta: "done" },
  } as never);
  await host.dispatch("message_end", { message } as never);
  await host.dispatch("tool_execution_start", { toolCallId: "call-1", toolName: "read", args: {} } as never);
  await host.dispatch("tool_execution_update", { toolCallId: "call-1", toolName: "read", args: {}, partialResult: {} } as never);
  await host.dispatch("tool_execution_end", { toolCallId: "call-1", toolName: "read", args: {}, result: {}, isError: false } as never);
  await host.dispatch("turn_end", { turnIndex: 0, message, toolResults: [] } as never);
  await host.dispatch("agent_end", { messages: [message] } as never);
  await host.dispatch("agent_settled", {
    threadId: "example-thread",
    branch: "main",
    runId: "example-run",
    outcome: { status: "completed", finishReason: "stop" },
    messages: [],
    messagesTruncated: false,
  });
  const notices: string[] = [];
  await runCommand(host, "example-lifecycle-status", "", notices);
  assert.deepEqual(JSON.parse(notices[0]!), {
    agentStart: 1,
    agentEnd: 1,
    agentSettled: 1,
    turnStart: 1,
    turnEnd: 1,
    messageStart: 1,
    messageUpdate: 1,
    messageEnd: 1,
    toolStart: 1,
    toolUpdate: 1,
    toolEnd: 1,
  });
});

test("command controls bind typed flags and normalized shortcuts", async (context) => {
  const { host } = await loadExample(context, "command-controls");
  assert.equal(host.flagValues().get("example-compact-output"), false);
  host.setFlagValue("example-compact-output", true);
  const notices: string[] = [];
  await runCommand(host, "example-controls", "", notices);
  assert.deepEqual(notices, ["Compact output: true"]);
  host.setInteractiveUiHandler(() => commandUi(notices));
  assert.deepEqual(await host.runShortcut("ctrl+alt+e", {
    threadId: "example-thread",
    branch: "main",
    signal: new AbortController().signal,
    ui: commandUi(notices),
  }), { handled: true });
  assert.deepEqual(notices, ["Compact output: true", "Example shortcut received."]);
});

test("tool rendering example replaces a built-in name and supplies live renderers", async (context) => {
  const { host, workspace } = await loadExample(context, "tool-rendering");
  const tool = host.tools().find((entry) => entry.definition.name === "read");
  assert.ok(tool);
  const input = { path: "README.md" };
  tool.validate(input);
  const result = await tool.execute(input, {
    workspace: await WorkspaceBoundary.create(workspace),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "example-run",
    threadId: "example-thread",
    toolCallId: "example-call",
  });
  assert.equal(result.content, "Example replacement received: README.md");
  const binding = host.toolRendererBinding();
  assert.equal(binding.has("read"), true);
  const rendered = binding.renderCall("read", {
    callId: "example-call",
    name: "read",
    input,
    status: "pending",
    expanded: true,
  }, {
    width: 100,
    height: 30,
    focused: false,
    expanded: true,
    theme: { name: "mono", color: true, unicode: true },
  });
  assert.equal(rendered?.lines[0]?.spans[0]?.text.trimEnd(), "Read replacement · README.md");
});

test("input guard transforms bounded text and blocks selected shell requests", async (context) => {
  const { host } = await loadExample(context, "input-guard");
  assert.deepEqual(await host.reduceInput({
    threadId: "example-thread",
    branch: "main",
    text: "/example-ignore",
    source: "interactive",
  }), { action: "handled" });
  const long = "x".repeat(5000);
  assert.deepEqual(await host.reduceInput({
    threadId: "example-thread",
    branch: "main",
    text: long,
    source: "interactive",
  }), { action: "transform", text: long.slice(0, 4096) });
  const reduced = await host.reduceToolCall({
    threadId: "example-thread",
    branch: "main",
    runId: "example-run",
    callId: "example-call",
    name: "bash",
    input: { command: "sudo shutdown now" },
    index: 0,
  });
  assert.equal(reduced.blocked, true);
  assert.match(reduced.reason ?? "", /privileged system commands/u);
});

test("UI surfaces mount components and wrap autocomplete while preserving the prior provider", async (context) => {
  const { host } = await loadExample(context, "ui-surfaces");
  const operations: string[] = [];
  let autocompleteFactory: RuntimeDirectAutocompleteProviderFactory | undefined;
  host.setDirectUiHandler(() => ({
    setStatus() { operations.push("status"); },
    setHeader() { operations.push("header"); },
    setWidget() { operations.push("widget"); },
    addAutocompleteProvider(factory: RuntimeDirectAutocompleteProviderFactory) {
      autocompleteFactory = factory;
      operations.push("autocomplete");
    },
    async custom(factory: (...args: unknown[]) => unknown) {
      operations.push("overlay");
      const done = () => {};
      const component = await factory({}, {}, {}, done);
      assert.equal(typeof (component as { render?: unknown }).render, "function");
      return undefined;
    },
  } as unknown as RuntimeDirectUiContext));
  await host.dispatch("session_start", { reason: "startup" } as never);
  assert.notEqual(autocompleteFactory, undefined);
  let delegated = 0;
  const installed = autocompleteFactory!({
    async getSuggestions() {
      delegated += 1;
      return { prefix: "base", items: [{ value: "baseline", label: "baseline" }] };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const result = [...lines];
      const line = result[cursorLine] ?? "";
      result[cursorLine] = `${line.slice(0, cursorCol - prefix.length)}${item.value}${line.slice(cursorCol)}`;
      return { lines: result, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
    },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await installed.getSuggestions(["plain"], 0, 5, { signal }), {
    prefix: "base",
    items: [{ value: "baseline", label: "baseline" }],
  });
  assert.equal(delegated, 1);
  const suggestions = await installed.getSuggestions(["Review :to"], 0, 10, { signal });
  assert.deepEqual(suggestions, {
    prefix: ":to",
    items: [{ value: "TODO: ", label: ":todo", description: "Insert a task marker" }],
  });
  assert.deepEqual(installed.applyCompletion(["Review :to"], 0, 10, suggestions!.items[0]!, suggestions!.prefix), {
    lines: ["Review TODO: "],
    cursorLine: 0,
    cursorCol: 13,
  });
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await installed.getSuggestions([":to"], 0, 3, { signal: aborted.signal }), null);
  await runCommand(host, "example-ui-panel");
  await runCommand(host, "example-ui-overlay");
  assert.deepEqual(operations, ["autocomplete", "status", "header", "widget", "overlay"]);
});

test("context example transforms the active prompt and requests host compaction", async (context) => {
  const { host, calls } = await loadExample(context, "context-compaction");
  const reduced = await host.reduceBeforeAgentStart({
    threadId: "example-thread",
    branch: "main",
    runId: "example-run",
    prompt: "Review",
    systemPrompt: "Base prompt",
    systemPromptOptions: { cwd: process.cwd(), selectedTools: [] },
  });
  assert.match(reduced.systemPrompt, /Base prompt\n\nExample extension instruction/u);
  const notices: string[] = [];
  await runCommand(host, "example-context", "compact", notices);
  assert.deepEqual(JSON.parse(notices[0]!), { tokens: 1200, contextWindow: 8000, percent: 15 });
  assert.deepEqual(calls.filter((entry) => entry.name === "compact"), [{
    name: "compact",
    values: [{ customInstructions: "Preserve active decisions and unresolved work." }],
  }]);
});

test("message bus example emits a custom message and registers its renderer", async (context) => {
  const { host, calls } = await loadExample(context, "messages-bus");
  await runCommand(host, "example-message", "hello bus");
  assert.deepEqual(calls.filter((entry) => entry.name === "sendMessage"), [{
    name: "sendMessage",
    values: [{ customType: "example-note", content: "hello bus", display: true }, undefined],
  }]);
  assert.equal(typeof host.messageRenderer("example-note"), "function");
});

test("model controls read the selected model and delegate thinking selection", async (context) => {
  const { host, calls } = await loadExample(context, "model-controls");
  const notices: string[] = [];
  await runCommand(host, "example-model", "high", notices);
  assert.deepEqual(calls.filter((entry) => entry.name === "setThinkingLevel"), [{
    name: "setThinkingLevel",
    values: ["high"],
  }]);
  assert.match(notices[0]!, / · off$/u);
});

test("starter activates through package resolution and its tool returns a canonical observation", async (context) => {
  const { host, workspace } = await loadExample(context, "starter");
  assert.equal(host.hasCommand("example-hello"), true);
  const tool = host.tools().find((entry) => entry.definition.name === "example_text_length");
  assert.ok(tool);
  const input = { text: "A🙂" };
  tool.validate(input);
  const result = await tool.execute(input, {
    workspace: await WorkspaceBoundary.create(workspace),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "example-run",
    threadId: "example-thread",
    toolCallId: "example-call",
  });
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content), { codePoints: 2 });
});

test("provider override registers a replacement and supports explicit removal", async (context) => {
  const { host, calls } = await loadExample(context, "provider-override");
  assert.deepEqual(host.directProviderRegistrations().map((entry) => entry.name), ["ollama"]);
  await runCommand(host, "example-provider-disable");
  assert.deepEqual(calls.filter((entry) => entry.name === "unregisterProvider"), [{
    name: "unregisterProvider",
    values: ["ollama"],
  }]);
});

test("raw editor UI imports the public TUI surface and installs a host-owned editor factory", async (context) => {
  const { host } = await loadExample(context, "raw-editor-ui");
  let editorFactory: RuntimeDirectEditorFactory | undefined;
  const notices: string[] = [];
  host.setDirectUiHandler(() => ({
    setEditorComponent(factory: RuntimeDirectEditorFactory | undefined) { editorFactory = factory; },
    notify(message: string) { notices.push(message); },
  } as unknown as RuntimeDirectUiContext));
  await runCommand(host, "example-editor-enable");
  assert.equal(typeof editorFactory, "function");
  assert.deepEqual(notices, ["Example editor enabled."]);
  await runCommand(host, "example-editor-disable");
  assert.equal(editorFactory, undefined);
});

test("session JSONL example reads the current session through the read-only manager", async (context) => {
  const { host } = await loadExample(context, "session-jsonl");
  const notices: string[] = [];
  await runCommand(host, "example-session-summary", "", notices);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /Session example-session-jsonl: 0 entries; leaf root\./u);
});

test("session-control delegates transitions and direct context lifecycle actions", async (context) => {
  const { host, calls, workspace } = await loadExample(context, "session-control");
  await runCommand(host, "example-session-new");
  await runCommand(host, "example-session-fork", "entry-7");
  await runCommand(host, "example-session-switch", "/tmp/session.jsonl");
  const notices: string[] = [];
  await runCommand(host, "example-session-status", "", notices);
  await runCommand(host, "example-session-abort", "", notices);
  await runCommand(host, "example-session-reload");
  await runCommand(host, "example-session-shutdown");
  assert.deepEqual(calls.filter((entry) => ["newSession", "fork", "switchSession"].includes(entry.name)), [
    { name: "newSession", values: [] },
    { name: "fork", values: ["entry-7", { position: "at" }] },
    { name: "switchSession", values: ["/tmp/session.jsonl"] },
  ]);
  assert.deepEqual(calls.filter((entry) => [
    "hasPendingMessages",
    "getSystemPromptOptions",
    "waitForIdle",
    "abort",
    "reload",
    "shutdown",
  ].includes(entry.name)), [
    { name: "hasPendingMessages", values: [] },
    { name: "getSystemPromptOptions", values: [] },
    { name: "waitForIdle", values: [] },
    { name: "abort", values: [] },
    { name: "reload", values: [] },
    { name: "shutdown", values: [] },
  ]);
  assert.deepEqual(notices, [
    JSON.stringify({ pendingMessages: true, promptCwd: workspace, selectedTools: ["read"] }),
    "Cancellation requested.",
  ]);
});

test("session metadata delegates naming, append-only entries, labels, and rendering", async (context) => {
  const { host, calls } = await loadExample(context, "session-metadata");
  const notices: string[] = [];
  await runCommand(host, "example-session-metadata", "review entry-4", notices);
  assert.deepEqual(calls.filter((entry) => ["setSessionName", "appendEntry", "setLabel"].includes(entry.name)), [
    { name: "setSessionName", values: ["review"] },
    { name: "appendEntry", values: ["example-session-note", { note: "Named review" }] },
    { name: "setLabel", values: ["entry-4", "Session review"] },
  ]);
  assert.deepEqual(notices, ["Session name: review"]);
  assert.equal(typeof host.entryRenderer("example-session-note"), "function");
});

test("subprocess workers discover agents and cover command, single, parallel, chain, progress, usage, and cancellation", async (context) => {
  const { host, calls, workspace } = await loadExample(context, "subprocess-workers");
  const notices: string[] = [];
  await runCommand(host, "example-workers", "$(not-a-shell)", notices);
  const executions = calls.filter((entry) => entry.name === "exec");
  assert.equal(executions.length, 3);
  const prompts = new Set<string>();
  for (const call of executions) {
    assert.equal(call.values[0], process.execPath);
    const args = call.values[1] as string[];
    assert.deepEqual(args.slice(1, 10), [
      "--no-session",
      "--no-extensions",
      "--print",
      "--mode", "json",
      "--tools", "read,grep,find,ls",
      "--max-steps", "24",
    ]);
    assert.equal(args.at(-2), "low");
    assert.match(args.at(-1)!, /Task: \$\(not-a-shell\)$/u);
    prompts.add(args.at(-1)!);
    assert.equal((call.values[2] as { cwd?: string; timeout?: number }).cwd, workspace);
    assert.equal((call.values[2] as { timeout?: number }).timeout, 120_000);
    assert.ok((call.values[2] as { signal?: AbortSignal }).signal instanceof AbortSignal);
  }
  assert.equal(prompts.size, 3);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /investigator — complete\ninvestigator report/u);
  assert.match(notices[0]!, /implementer — complete\nimplementer report/u);
  assert.match(notices[0]!, /reviewer — failed\nreview worker unavailable/u);

  const tool = host.tools().find((entry) => entry.definition.name === "example_subagent");
  assert.ok(tool);
  assert.equal(tool.executionMode, "sequential");
  assert.match(tool.definition.description, /investigator \(Locate the smallest evidence-backed change\)/u);
  assert.match(tool.definition.description, /implementer \(Propose a scoped implementation and verification\)/u);
  assert.match(tool.definition.description, /reviewer \(Review failure modes and missing tests\)/u);
  const boundary = await WorkspaceBoundary.create(workspace);
  let callOrdinal = 0;
  const execute = async (
    input: Parameters<typeof tool.execute>[0],
    signal = new AbortController().signal,
  ) => {
    tool.validate(input);
    const progress: unknown[] = [];
    const result = await tool.execute(input, {
      workspace: boundary,
      runner: new DirectProcessRunner(),
      signal,
      runId: "example-run",
      threadId: "example-thread",
      toolCallId: `example-call-${++callOrdinal}`,
      reportProgress(update) { progress.push(update); },
    });
    return { result, progress };
  };

  const single = await execute({ agent: "investigator", task: "Find the entry point" });
  assert.match(single.result.content, /investigator — complete\ninvestigator report/u);
  assert.equal((single.result.metadata as { mode?: string } | undefined)?.mode, "single");
  assert.deepEqual(single.result.usage, {
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 6,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
    cost: { input: 0.001, output: 0.002, cacheRead: 0.0005, cacheWrite: 0, total: 0.0035 },
  });
  assert.equal(single.progress.length, 1);

  const parallelCallStart = calls.length;
  const parallel = await execute({ tasks: [
    { agent: "investigator", task: "Inspect" },
    { agent: "reviewer", task: "Review" },
    { agent: "implementer", task: "Propose" },
  ] });
  assert.match(parallel.result.content, /investigator — complete\ninvestigator report/u);
  assert.match(parallel.result.content, /reviewer — failed\nreview worker unavailable/u);
  assert.match(parallel.result.content, /implementer — complete\nimplementer report/u);
  assert.equal(parallel.result.isError, false);
  const parallelMetadata = parallel.result.metadata as {
    mode: string;
    succeeded: number;
    total: number;
    results: unknown[];
    availableAgents: Array<{ name: string }>;
  };
  assert.equal(parallelMetadata.mode, "parallel");
  assert.equal(parallelMetadata.succeeded, 2);
  assert.equal(parallelMetadata.total, 3);
  assert.equal(parallelMetadata.results.length, 3);
  assert.deepEqual(parallelMetadata.availableAgents.map((agent) => agent.name), ["implementer", "investigator", "reviewer"]);
  assert.deepEqual(parallel.result.usage, {
    inputTokens: 4,
    outputTokens: 6,
    totalTokens: 12,
    cacheReadTokens: 2,
    cacheWriteTokens: 0,
    cost: { input: 0.002, output: 0.004, cacheRead: 0.001, cacheWrite: 0, total: 0.007 },
  });
  assert.equal(parallel.progress.length, 3);
  for (const update of parallel.progress) {
    assert.ok(Buffer.byteLength(JSON.stringify(update), "utf8") < 4096);
  }
  assert.equal(calls.slice(parallelCallStart).filter((entry) => entry.name === "exec").length, 3);

  const chainCallStart = calls.length;
  const chain = await execute({ chain: [
    { agent: "investigator", task: "Inspect" },
    { agent: "implementer", task: "Use the evidence" },
  ] });
  assert.match(chain.result.content, /Step 1: investigator — complete/u);
  assert.match(chain.result.content, /Step 2: implementer — complete/u);
  const chainExecutions = calls.slice(chainCallStart).filter((entry) => entry.name === "exec");
  assert.equal(chainExecutions.length, 2);
  assert.match(((chainExecutions[1]?.values[1] as string[]).at(-1)) ?? "", /Previous worker report:\ninvestigator report/u);

  const failedChainCallStart = calls.length;
  const failedChain = await execute({ chain: [
    { agent: "reviewer", task: "Review" },
    { agent: "implementer", task: "Should not run" },
  ] });
  assert.match(failedChain.result.content, /Step 1: reviewer — failed\nreview worker unavailable/u);
  assert.equal(calls.slice(failedChainCallStart).filter((entry) => entry.name === "exec").length, 1);

  const cancelled = new AbortController();
  cancelled.abort(new Error("example cancellation"));
  const cancelledCallStart = calls.length;
  await assert.rejects(execute({ agent: "investigator", task: "Do not start" }, cancelled.signal), /example cancellation/u);
  assert.equal(calls.slice(cancelledCallStart).filter((entry) => entry.name === "exec").length, 0);
});

test("dynamic package discovers its skill and prompt from its package root", async (context) => {
  const { host } = await loadExample(context, "dynamic-package");
  const resources = await host.discoverResources("startup");
  assert.deepEqual(resources.skillPaths.map((entry) => entry.path), ["skills"]);
  assert.deepEqual(resources.promptPaths.map((entry) => entry.path), ["prompts"]);
  assert.equal(resources.skillPaths[0]?.resourceRoot, resolve("examples", "dynamic-package"));
});

test("provider hooks transform request metadata and headers while retaining redacted response status", async (context) => {
  const { host } = await loadExample(context, "provider-hooks");
  assert.deepEqual(await host.applyBeforeProviderRequestPayload({ model: "example" }), {
    model: "example",
    metadata: { extensionExample: true },
  });
  const headers: Record<string, string | null> = {};
  await host.applyBeforeProviderHeaders(headers);
  assert.equal(headers["x-rigyn-example"], "provider-hooks");
  await host.observeAfterProviderResponse(202, { "x-request-id": "request-7" });
  const notices: string[] = [];
  await runCommand(host, "example-provider-hooks", "", notices);
  assert.deepEqual(JSON.parse(notices[0]!), { status: 202, requestId: "request-7" });
});

test("runtime catalog example discovers resources, selects active state, and delivers a user follow-up", async (context) => {
  const { host, calls } = await loadExample(context, "runtime-catalog");
  const notices: string[] = [];
  await runCommand(host, "example-runtime-catalog", "", notices);
  const catalog = JSON.parse(notices[0]!) as { activeTools: string[]; allTools: string[]; commands: string[]; resources: string[] };
  assert.deepEqual(catalog.activeTools, ["read"]);
  assert.deepEqual(catalog.allTools, ["read"]);
  assert.equal(catalog.commands.includes("example-runtime-select"), true);
  assert.deepEqual(catalog.resources, ["command:help", "prompt:review", "skill:audit"]);
  await runCommand(host, "example-runtime-select");
  assert.deepEqual(calls.filter((entry) => ["setActiveTools", "setModel", "sendUserMessage"].includes(entry.name)).map((entry) => entry.name), [
    "setActiveTools",
    "setModel",
    "sendUserMessage",
  ]);
  assert.deepEqual(calls.find((entry) => entry.name === "sendUserMessage")?.values, [
    "Review the updated runtime selection.",
    { deliverAs: "followUp" },
  ]);
});

test("session lifecycle example observes guards and delegates tree navigation and compaction", async (context) => {
  const { host, calls } = await loadExample(context, "session-lifecycle");
  assert.deepEqual(await host.reduceSessionBeforeSwitch({ reason: "new" } as never), {});
  assert.deepEqual(await host.reduceSessionBeforeFork({ entryId: "entry-1", position: "at" } as never), {});
  const signal = new AbortController().signal;
  assert.deepEqual(await host.reduceSessionBeforeTree({
    preparation: { targetId: "entry-1", oldLeafId: null, commonAncestorId: null, entriesToSummarize: [], userWantsSummary: false },
    signal,
  }), { customInstructions: "Retain decisions from the selected branch." });
  await host.reduceSessionBeforeCompact({
    preparation: {
      firstKeptEntryId: "entry-1",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 10,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 4, keepRecentTokens: 4 },
    },
    branchEntries: [],
    reason: "manual",
    willRetry: false,
    signal,
  });
  await host.dispatch("session_compact", {
    compactionEntry: { type: "compaction", id: "compact-1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 10 },
    fromExtension: false,
    reason: "manual",
    willRetry: false,
  } as never);
  await host.dispatch("session_tree", { newLeafId: "entry-1", oldLeafId: null } as never);
  await runCommand(host, "example-session-navigate", "entry-1");
  await runCommand(host, "example-session-compact");
  assert.deepEqual(calls.filter((entry) => ["navigateTree", "compact"].includes(entry.name)), [
    { name: "navigateTree", values: ["entry-1", { summarize: true, label: "example branch" }] },
    { name: "compact", values: [{ customInstructions: "Preserve decisions and unfinished work." }] },
  ]);
});

test("managed provider example exposes a refreshable catalog and OAuth callbacks without credentials", async (context) => {
  const { host } = await loadExample(context, "provider-catalog");
  const registration = host.directProviderRegistrations()[0];
  assert.ok(registration !== undefined && "config" in registration);
  assert.equal(registration.name, "example-managed");
  assert.equal(registration.config.oauth?.name, "Example subscription");
  assert.deepEqual(await registration.config.refreshModels?.({ signal: new AbortController().signal } as never), registration.config.models);
  assert.equal(registration.config.oauth?.getApiKey({ access: "opaque", refresh: "refresh", expires: Date.now() }), "opaque");
});

test("terminal workbench exercises input interception, editor helpers, themes, and expansion", async (context) => {
  const { host } = await loadExample(context, "terminal-workbench");
  const operations: string[] = [];
  let terminalHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
  let editorText = "draft";
  host.setDirectUiHandler(() => ({
    onTerminalInput(handler: RuntimeDirectTerminalInputHandler) { terminalHandler = handler; operations.push("terminal"); return () => { operations.push("terminal-stop"); }; },
    getEditorText() { return editorText; },
    setEditorText(value: string) { editorText = value; operations.push("set-editor"); },
    pasteToEditor(value: string) { editorText += value; operations.push("paste"); },
    async editor(_title: string, prefill?: string) { operations.push(`modal:${prefill}`); return prefill; },
    getAllThemes() { return [{ name: "mono", path: undefined }, { name: "light", path: undefined }]; },
    getTheme(name: string) { return name === "light" ? { name: "light" } as never : undefined; },
    setTheme(name: string) { operations.push(`theme:${String(name)}`); return { success: true }; },
    getToolsExpanded() { return false; },
    setToolsExpanded(value: boolean) { operations.push(`expanded:${String(value)}`); },
    getEditorComponent() { return undefined; },
    notify(message: string) { operations.push(`notice:${message}`); },
  } as unknown as RuntimeDirectUiContext));
  await runCommand(host, "example-terminal-workbench", "light");
  assert.deepEqual(terminalHandler?.("\u001b\u0005"), { consume: true });
  assert.deepEqual(terminalHandler?.("x"), { data: "x" });
  assert.deepEqual(operations.slice(0, 6), ["terminal", "set-editor", "paste", "modal:draftworkbench", "theme:light", "expanded:true"]);
});

test("project trust example asks through the restricted trust UI and returns an invocation-only decision", async (context) => {
  const { host, workspace } = await loadExample(context, "project-trust");
  const prompts: string[] = [];
  assert.deepEqual(await host.resolveProjectTrust({ workspace, cwd: workspace }, {
    hasUI: true,
    async confirm(title, message) { prompts.push(`${title}:${message}`); return true; },
  }), { decision: "yes" });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /Load executable project resources/u);
});
