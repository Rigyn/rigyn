import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import type { AdapterEvent, ProviderRequest } from "../../src/core/types.js";
import {
  discoverExtensions,
  loadRuntimeExtensions,
  type RuntimeCommandUi,
  type RuntimeExtensionStateRecord,
  type RuntimeSessionBeforeCompactEvent,
} from "../../src/extensions/index.js";
import type { RuntimeExtensionSessionHandler } from "../../src/extensions/runtime.js";
import { DirectProcessRunner } from "../../src/process/index.js";
import { WorkspaceBoundary } from "../../src/tools/index.js";

const exampleIds = {
  "package-starter": "package-starter",
  "custom-tool": "custom-tool-example",
  "custom-provider": "custom-provider-example",
  "session-notes": "session-notes-example",
  "tool-lifecycle": "tool-lifecycle-example",
  "custom-compaction": "custom-compaction-example",
  "dynamic-tools": "dynamic-tools-example",
  "mcp-stdio": "mcp-stdio-example",
} as const;

async function loadExample(t: TestContext, directory: keyof typeof exampleIds) {
  const workspace = await mkdtemp(join(tmpdir(), `harness-${directory}-`));
  const catalog = await discoverExtensions([{
    path: resolve("examples"),
    scope: "user",
    trusted: true,
  }]);
  const extensionId = exampleIds[directory];
  const metadata = catalog.list().find((entry) => entry.id === extensionId);
  assert.equal(metadata?.status, "active");
  const entries = catalog.bundle().runtime.filter((entry) => entry.extensionId === extensionId);
  assert.equal(entries.length, 1);
  const host = await loadRuntimeExtensions(entries, { workspace });
  t.after(async () => {
    await host.close();
    await rm(workspace, { recursive: true, force: true });
  });
  assert.deepEqual(host.diagnostics(), []);
  return { host, workspace };
}

function commandUi(overrides: Partial<RuntimeCommandUi> = {}): RuntimeCommandUi {
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
    async select<T>(_prompt: string, options: readonly { label: string; value: T }[]): Promise<T> {
      return options[0]!.value;
    },
    async confirm() { return true; },
    async input() { return undefined; },
    async editor() { return undefined; },
    setEditorText() {},
    getEditorText() { return ""; },
    async custom<T>(): Promise<T | undefined> { return undefined; },
    showOverlay(): never { throw new Error("overlay not used"); },
    ...overrides,
  };
}

test("the package-author starter activates and returns its documented prompt", async (t) => {
  const { host } = await loadExample(t, "package-starter");
  assert.deepEqual(host.commands().map((entry) => entry.name), ["starter-review"]);
  assert.deepEqual(host.initialUi().map((entry) => entry.type), ["status"]);
  assert.deepEqual(await host.runCommand("starter-review", {
    args: "the auth change",
    threadId: "thread-starter",
    signal: new AbortController().signal,
    ui: commandUi(),
  }), {
    handled: true,
    prompt: "Review the auth change. Report concrete evidence, risks, and the smallest useful next action.",
  });
});

test("the focused custom tool validates input and returns a deterministic observation", async (t) => {
  const { host, workspace } = await loadExample(t, "custom-tool");
  const tool = host.tools().find((entry) => entry.definition.name === "text_metrics");
  assert.ok(tool);
  const input = { text: "one two\nthree" };
  tool.validate(input);
  const context = {
    workspace: await WorkspaceBoundary.create(workspace),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "run-gallery-tool",
    threadId: "thread-gallery-tool",
  };
  assert.deepEqual(await tool.resources(input, context), []);
  const result = await tool.execute(input, context);
  assert.equal(result.isError, false);
  assert.equal(result.status, "success");
  assert.equal(result.summary, "Measured 2 lines, 3 words, and 13 UTF-8 bytes.");
  assert.deepEqual(result.nextActions, []);
  assert.deepEqual(JSON.parse(result.content), { metrics: { lines: 2, words: 3, bytes: 13 } });
  assert.throws(() => tool.validate({ text: "", extra: true }));
});

test("the focused custom provider lists and streams its offline model", async (t) => {
  const { host } = await loadExample(t, "custom-provider");
  const provider = host.providers().find((entry) => entry.id === "gallery-offline");
  assert.ok(provider);
  const signal = new AbortController().signal;
  const models = await provider.listModels(signal);
  assert.deepEqual(models.map((model) => model.id), ["gallery-offline-v1"]);
  assert.equal((models[0]?.metadata as { offline?: boolean } | undefined)?.offline, true);

  const events: AdapterEvent[] = [];
  const request = {
    provider: "gallery-offline",
    model: "gallery-offline-v1",
    messages: [{
      id: "message-gallery-provider",
      role: "user",
      content: [{ type: "text", text: "hello gallery" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
    tools: [],
  } as ProviderRequest;
  for await (const event of provider.stream(request, signal)) events.push(event);
  assert.equal(events.find((event) => event.type === "text_delta")?.text, "Offline provider: hello gallery");
  assert.equal(events.at(-1)?.type, "response_end");
});

test("the session-note example edits, persists, and renders extension-owned state", async (t) => {
  const { host } = await loadExample(t, "session-notes");
  let saved: RuntimeExtensionStateRecord | undefined;
  let sequence = 0;
  let injectConflict = false;
  const expectedEventIds: Array<string | null> = [];
  host.setSessionHandler({
    async compareAndAppendState(input: Parameters<RuntimeExtensionSessionHandler["compareAndAppendState"]>[0]) {
      expectedEventIds.push(input.expectedEventId);
      if (injectConflict) {
        injectConflict = false;
        sequence += 1;
        saved = {
          type: "extension_state",
          extensionId: input.event.extensionId,
          schemaVersion: input.event.schemaVersion,
          key: input.event.key,
          value: { text: "concurrent note", revision: 2 },
          threadId: input.threadId,
          branch: input.branch ?? "main",
          eventId: `event-note-${sequence}`,
          timestamp: "2026-01-01T00:00:00.000Z",
        };
        return {
          status: "conflict" as const,
          threadId: input.threadId,
          branch: input.branch ?? "main",
          expectedEventId: input.expectedEventId,
          current: saved,
        };
      }
      if ((saved?.eventId ?? null) !== input.expectedEventId) {
        return {
          status: "conflict" as const,
          threadId: input.threadId,
          branch: input.branch ?? "main",
          expectedEventId: input.expectedEventId,
          ...(saved === undefined ? {} : { current: saved }),
        };
      }
      sequence += 1;
      saved = {
        ...input.event,
        threadId: input.threadId,
        branch: input.branch ?? "main",
        eventId: `event-note-${sequence}`,
        timestamp: "2026-01-01T00:00:00.000Z",
      };
      return { status: "committed" as const, record: saved };
    },
    async readState() {
      return saved;
    },
  } as unknown as RuntimeExtensionSessionHandler);

  const notices: string[] = [];
  const first = await host.runCommand("session-note", {
    args: "first note",
    threadId: "thread-notes",
    branch: "main",
    signal: new AbortController().signal,
    ui: commandUi({ notify(message) { notices.push(message); } }),
  });
  assert.deepEqual(first, { handled: true });
  assert.deepEqual(JSON.parse(JSON.stringify(saved?.value)), { text: "first note", revision: 1 });

  let editorPrefill = "";
  injectConflict = true;
  await host.runCommand("session-note", {
    args: "",
    threadId: "thread-notes",
    branch: "main",
    signal: new AbortController().signal,
    ui: commandUi({
      notify(message) { notices.push(message); },
      async editor(_title, prefill) {
        editorPrefill = prefill ?? "";
        return "edited note";
      },
    }),
  });
  assert.equal(editorPrefill, "first note");
  assert.deepEqual(JSON.parse(JSON.stringify(saved?.value)), { text: "edited note", revision: 3 });
  assert.deepEqual(expectedEventIds, [null, "event-note-1", "event-note-2"]);
  assert.deepEqual(notices, ["Session note saved as revision 1.", "Session note saved as revision 3."]);
  assert.ok(saved);
  const rendered = host.renderExtensionState(saved, {
    width: 80,
    height: 24,
    focused: false,
    expanded: false,
    theme: { name: "dark", color: true, unicode: true },
  });
  assert.equal(rendered.lines[0]?.spans.map((span) => span.text).join(""), "Session note r3 · edited note");
});

test("the tool-lifecycle example blocks private calls and transforms only its own results", async (t) => {
  const { host, workspace } = await loadExample(t, "tool-lifecycle");
  const tool = host.tools().find((entry) => entry.definition.name === "guarded_echo");
  assert.ok(tool);
  const context = {
    workspace: await WorkspaceBoundary.create(workspace),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "run-gallery-lifecycle",
    threadId: "thread-gallery-lifecycle",
  };
  const target = { threadId: context.threadId, runId: context.runId, branch: "main" };
  const invocation = { ...target, callId: "call-lifecycle", name: "guarded_echo", input: { text: "review me" }, index: 0 };
  assert.deepEqual(await host.reduceToolCall(invocation), { invocation, blocked: false });
  const base = await tool.execute(invocation.input, context);
  assert.deepEqual(await host.reduceToolResult({ invocation, result: base }), {
    ...base,
    content: JSON.stringify({ echo: "review me", reviewed: true }),
    metadata: { reviewedBy: "tool-lifecycle-example" },
  });
  const blocked = await host.reduceToolCall({
    ...target,
    callId: "call-private",
    name: "guarded_echo",
    input: { text: " private: internal value" },
    index: 1,
  });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason ?? "", /refuses text explicitly marked private/u);
  const unrelated = { ...target, callId: "call-read", name: "read", input: { path: "README.md" }, index: 2 };
  assert.deepEqual(await host.reduceToolCall(unrelated), { invocation: unrelated, blocked: false });
});

test("the custom-compaction example returns a bounded deterministic role outline", async (t) => {
  const { host } = await loadExample(t, "custom-compaction");
  const sourceMessages = Array.from({ length: 30 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: [{ type: "text" as const, text: `message ${index} ${"x".repeat(600)}` }],
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
  const event = {
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
      sourceMessages,
      trailingMessages: [],
      sourceMessageIds: sourceMessages.map((message) => message.id),
    },
    customInstructions: "preserve decisions",
    signal: new AbortController().signal,
  } satisfies RuntimeSessionBeforeCompactEvent;
  const reduced = await host.reduceSessionBeforeCompact(event);
  assert.equal(reduced.compaction?.metadata !== undefined, true);
  assert.deepEqual(reduced.compaction?.metadata, {
    strategy: "bounded-role-outline",
    sourceMessages: 30,
    includedMessages: 24,
    omittedMessages: 6,
  });
  assert.match(reduced.compaction?.text ?? "", /Focus: preserve decisions/u);
  assert.match(reduced.compaction?.text ?? "", /message 0/u);
  assert.match(reduced.compaction?.text ?? "", /message 29/u);
  assert.match(reduced.compaction?.text ?? "", /6 middle messages omitted/u);
  assert.ok(Buffer.byteLength(reduced.compaction?.text ?? "") < 16 * 1024);

  const cancelled = new AbortController();
  cancelled.abort(new Error("cancel custom compaction"));
  await assert.rejects(host.reduceSessionBeforeCompact({ ...event, signal: cancelled.signal }), /cancel custom compaction/u);
});

test("the dynamic-tools example preserves unrelated tools while loading and unloading its toolset", async (t) => {
  const { host, workspace } = await loadExample(t, "dynamic-tools");
  let active = ["read", "load_text_toolset", "text_uppercase", "text_lowercase"];
  let selectedBranch: string | undefined;
  host.setSessionHandler({
    async getActiveTools() { return [...active]; },
    async setActiveTools(input: Parameters<RuntimeExtensionSessionHandler["setActiveTools"]>[0]) {
      active = [...input.names];
      selectedBranch = input.branch;
      return [...active];
    },
  } as unknown as RuntimeExtensionSessionHandler);

  const notices: string[] = [];
  assert.deepEqual(await host.runCommand("dynamic-tools", {
    args: "loader-only",
    threadId: "thread-dynamic-tools",
    signal: new AbortController().signal,
    ui: commandUi({ notify(value) { notices.push(value); } }),
  }), { handled: true });
  assert.deepEqual(active, ["read", "load_text_toolset"]);

  const loader = host.tools().find((entry) => entry.definition.name === "load_text_toolset");
  assert.ok(loader);
  await host.dispatch("agent_start", {
    threadId: "thread-dynamic-tools",
    branch: "experiment",
    runId: "run-dynamic-tools",
    provider: "offline",
    model: "offline-model",
  });
  const result = await loader.execute({ preset: "text" }, {
    workspace: await WorkspaceBoundary.create(workspace),
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "run-dynamic-tools",
    threadId: "thread-dynamic-tools",
  });
  assert.equal(result.isError, false);
  assert.equal(selectedBranch, "experiment");
  assert.deepEqual(active, ["read", "load_text_toolset", "text_uppercase", "text_lowercase"]);
  assert.deepEqual(JSON.parse(result.content), {
    activeTools: active,
    applies: "next-provider-turn",
  });
  assert.deepEqual(notices, ["Active tool selection queued: read, load_text_toolset."]);
});

test("the MCP stdio example performs a fixed tool round trip and stops its child on disposal", async (t) => {
  const { host, workspace } = await loadExample(t, "mcp-stdio");
  const tool = host.tools().find((entry) => entry.definition.name === "mcp_reverse_text");
  assert.ok(tool);
  const input = { text: "Rigyn" };
  tool.validate(input);
  const boundary = await WorkspaceBoundary.create(workspace);
  const cancelled = new AbortController();
  cancelled.abort(new Error("cancel MCP request"));
  await assert.rejects(tool.execute(input, {
    workspace: boundary,
    runner: new DirectProcessRunner(),
    signal: cancelled.signal,
    runId: "run-gallery-mcp-cancelled",
    threadId: "thread-gallery-mcp",
  }), /cancel MCP request/u);

  const result = await tool.execute(input, {
    workspace: boundary,
    runner: new DirectProcessRunner(),
    signal: new AbortController().signal,
    runId: "run-gallery-mcp",
    threadId: "thread-gallery-mcp",
  });
  assert.equal(result.isError, false);
  assert.equal(result.status, "success");
  assert.deepEqual(JSON.parse(result.content), { text: "nygiR" });
  const serverPid = (result.metadata as { serverPid?: unknown } | undefined)?.serverPid;
  assert.equal(typeof serverPid, "number");
  assert.doesNotThrow(() => process.kill(serverPid as number, 0));

  await host.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.throws(() => process.kill(serverPid as number, 0), (cause: unknown) => (
    cause instanceof Error && "code" in cause && cause.code === "ESRCH"
  ));
});
