import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentMessage, ToolResultMessage } from "@rigyn/kernel";

import type { CanonicalMessage, NormalizedUsage, ProviderState, ToolResultBlock } from "../../src/core/types.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import {
  canonicalMessage,
  canonicalUsage,
  extensionMessage,
  extensionSessionManager,
  extensionToolResult,
  extensionUsage,
} from "../../src/extensions/session-contract.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { AgentSession, type AgentSessionEvent } from "../../src/service/agent-session.js";
import { SessionManager } from "../../src/storage/session-manager.js";

const normalizedUsage: NormalizedUsage = {
  inputTokens: 7,
  outputTokens: 3,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  cacheWrite1hTokens: 1,
  reasoningTokens: 2,
  totalTokens: 13,
  cost: { input: 0.07, output: 0.06, cacheRead: 0.002, cacheWrite: 0.004, total: 0.136 },
};

test("extension usage conversion preserves cache, reasoning, and cost semantics", () => {
  const exposed = extensionUsage(normalizedUsage);
  assert.deepEqual(exposed, {
    input: 7,
    output: 3,
    cacheRead: 2,
    cacheWrite: 1,
    cacheWrite1h: 1,
    reasoning: 2,
    totalTokens: 13,
    cost: { input: 0.07, output: 0.06, cacheRead: 0.002, cacheWrite: 0.004, total: 0.136 },
  });
  assert.deepEqual(canonicalUsage(exposed), normalizedUsage);
  assert.throws(
    () => canonicalUsage({ ...exposed, totalTokens: 12 }),
    /totalTokens must equal/u,
  );
});

test("extension usage conversion preserves missing cache telemetry", () => {
  const canonical: NormalizedUsage = {
    inputTokens: 7,
    outputTokens: 3,
    totalTokens: 10,
    cost: { input: 0.07, output: 0.06, cacheRead: 0, cacheWrite: 0, total: 0.13 },
  };
  const exposed = extensionUsage(canonical);
  assert.equal(Object.hasOwn(exposed, "cacheRead"), false);
  assert.equal(Object.hasOwn(exposed, "cacheWrite"), false);
  assert.deepEqual(canonicalUsage(exposed), canonical);
});

test("extension usage conversion preserves unavailable counters and explicit zero", () => {
  const partial: NormalizedUsage = { inputTokens: 7, totalTokens: 10 };
  assert.deepEqual(extensionUsage(partial), { input: 7, totalTokens: 10 });
  assert.deepEqual(canonicalUsage({ input: 7, totalTokens: 10 }), partial);
  assert.deepEqual(extensionUsage(undefined), {});
  assert.deepEqual(canonicalUsage({}), {});

  const explicitZero: NormalizedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  assert.deepEqual(canonicalUsage(extensionUsage(explicitZero)), explicitZero);
});

test("message conversion uses public image and assistant message contracts without losing host state", () => {
  const user: CanonicalMessage = {
    id: "message-user",
    role: "user",
    content: [
      { type: "text", text: "inspect" },
      { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
    ],
    createdAt: "2026-07-21T00:00:00.000Z",
  };
  const publicUser = extensionMessage(user);
  assert.equal(publicUser.role, "user");
  assert.deepEqual(publicUser.content, [
    { type: "text", text: "inspect" },
    { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
  ]);
  assert.deepEqual(canonicalMessage(publicUser, user), user);

  const assistant: CanonicalMessage & { providerState: ProviderState } = {
    id: "message-assistant",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private plan", thinkingSignature: "thinking-signature", redacted: true },
      { type: "text", text: "done", textSignature: "text-signature" },
      {
        type: "tool_call",
        callId: "call-signed",
        name: "inspect",
        arguments: { path: "README.md" },
        thoughtSignature: "tool-signature",
      },
    ],
    createdAt: "2026-07-21T00:00:01.000Z",
    provider: "custom-provider",
    model: "custom-model",
    api: "extension-stream",
    publicApi: "custom-stream",
    responseModel: "custom-model-revision",
    responseId: "custom-response",
    diagnostics: [{
      type: "provider_response",
      message: "Provider response received",
      details: { response: { status: 200, headers: { "x-request-id": "custom-request" } } },
      timestamp: Date.parse("2026-07-21T00:00:01.000Z"),
    }],
    providerState: { kind: "extension_stream", assistantContent: [{ continuation: "opaque" }] },
    usage: normalizedUsage,
    stopReason: "stop",
  };
  const publicAssistant = extensionMessage(assistant);
  if (publicAssistant.role !== "assistant") assert.fail("Expected an assistant message");
  assert.equal(publicAssistant.api, "custom-stream");
  assert.equal(publicAssistant.responseModel, "custom-model-revision");
  assert.equal(publicAssistant.responseId, "custom-response");
  assert.deepEqual(publicAssistant.diagnostics, assistant.diagnostics);
  assert.deepEqual(publicAssistant.content, [
    { type: "thinking", thinking: "private plan", thinkingSignature: "thinking-signature", redacted: true },
    { type: "text", text: "done", textSignature: "text-signature" },
    {
      type: "toolCall",
      id: "call-signed",
      name: "inspect",
      arguments: { path: "README.md" },
      thoughtSignature: "tool-signature",
    },
  ]);
  assert.deepEqual(publicAssistant.providerState?.value, {
    kind: "extension_stream",
    assistantContent: [{ continuation: "opaque" }],
  });
  assert.deepEqual(canonicalMessage(publicAssistant, assistant), assistant);
  assert.throws(
    () => canonicalMessage({ ...publicAssistant, responseId: "forged-response" }, assistant),
    /response metadata is host-owned/u,
  );
  assert.throws(
    () => canonicalMessage({
      ...publicAssistant,
      diagnostics: [{
        type: "forged",
        message: "api_key=sk-proj-forged-secret-value",
        timestamp: Date.now(),
      }],
    }, assistant),
    /response metadata is host-owned/u,
  );
  const { providerState: _providerState, ...withoutProviderState } = publicAssistant;
  assert.throws(
    () => canonicalMessage(withoutProviderState, undefined),
    /response metadata cannot be introduced/u,
  );
});

test("runtime message conversion accepts only nullish omissions beyond the public content contract", () => {
  const assistant = {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "fixture-provider",
    model: "fixture-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  } as const;
  const toolResult = {
    role: "toolResult",
    toolCallId: "call-empty",
    toolName: "empty-result",
    content: [],
    details: undefined,
    isError: false,
    timestamp: 2,
  } as const;

  for (const value of [null, undefined]) {
    const convertedAssistant = canonicalMessage({
      ...assistant,
      content: value,
    } as unknown as AgentMessage);
    assert.deepEqual(convertedAssistant.role === "assistant" ? convertedAssistant.content : undefined, []);

    const convertedTool = canonicalMessage({
      ...toolResult,
      content: value,
    } as unknown as AgentMessage);
    assert.equal(convertedTool.role, "tool");
    if (convertedTool.role !== "tool") assert.fail("Expected a tool message");
    assert.deepEqual(convertedTool.content[0]?.type === "tool_result"
      ? convertedTool.content[0].contentBlocks
      : undefined, []);
  }

  const invalid = ["text", 1, { type: "text", text: "not-an-array" }, [{ type: "text" }]];
  for (const content of invalid) {
    assert.throws(() => canonicalMessage({
      ...assistant,
      content,
    } as unknown as AgentMessage));
    assert.throws(() => canonicalMessage({
      ...toolResult,
      content,
    } as unknown as AgentMessage));
  }
});

test("assistant diagnostics are redacted before public extension projection", () => {
  const exposed = extensionMessage({
    id: "message-secret-diagnostic",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    createdAt: "2026-07-21T00:00:01.000Z",
    provider: "provider",
    model: "model",
    diagnostics: [{
      type: "provider_failure",
      message: "api_key=sk-proj-abcdefghijklmnop",
      details: {
        authorization: "Bearer sk-proj-abcdefghijklmnop",
        nested: { access_token: "sk-proj-abcdefghijklmnop" },
      },
      timestamp: Date.parse("2026-07-21T00:00:01.000Z"),
    }],
  });
  if (exposed.role !== "assistant") assert.fail("Expected an assistant message");
  assert.deepEqual(exposed.diagnostics, [{
    type: "provider_failure",
    message: "api_key=[REDACTED]",
    details: {
      authorization: "[REDACTED]",
      nested: { access_token: "[REDACTED]" },
    },
    timestamp: Date.parse("2026-07-21T00:00:01.000Z"),
  }]);
  assert.throws(() => extensionMessage({
    id: "message-oversized-diagnostic",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    createdAt: "2026-07-21T00:00:01.000Z",
    diagnostics: [{
      type: "provider_failure",
      message: "x".repeat(4 * 1024 + 1),
      timestamp: Date.parse("2026-07-21T00:00:01.000Z"),
    }],
  }), /byte limit/u);
  assert.throws(() => extensionMessage({
    id: "message-non-json-diagnostic",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    createdAt: "2026-07-21T00:00:01.000Z",
    diagnostics: [{
      type: "provider_failure",
      message: "failed",
      details: { invalid: undefined },
      timestamp: Date.parse("2026-07-21T00:00:01.000Z"),
    }],
  }), /only JSON values/u);
});

test("signed assistant content survives JSONL persistence and public session projection", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-signed-session-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, join(root, "sessions"), { id: "signed" });
  manager.appendMessage({
    id: "signed-assistant",
    role: "assistant",
    provider: "signed-provider",
    model: "signed-model",
    api: "extension-stream",
    content: [
      { type: "thinking", thinking: "plan", thinkingSignature: "thinking-signature", redacted: true },
      { type: "text", text: "answer", textSignature: "text-signature" },
      {
        type: "tool_call",
        callId: "signed-call",
        name: "read",
        arguments: { path: "README.md" },
        thoughtSignature: "tool-signature",
      },
    ],
    createdAt: "2026-07-21T00:00:00.000Z",
    stopReason: "tool_calls",
  });

  manager.closeV4Store();
  const reopened = SessionManager.open(manager.getSessionFile()!);
  context.after(() => reopened.closeV4Store());
  const entry = extensionSessionManager(reopened).getEntries()[0];
  assert.equal(entry?.type, "message");
  assert.deepEqual(entry?.type === "message" ? entry.message : undefined, {
    role: "assistant",
    provider: "signed-provider",
    model: "signed-model",
    api: "extension-stream",
    content: [
      { type: "thinking", thinking: "plan", thinkingSignature: "thinking-signature", redacted: true },
      { type: "text", text: "answer", textSignature: "text-signature" },
      {
        type: "toolCall",
        id: "signed-call",
        name: "read",
        arguments: { path: "README.md" },
        thoughtSignature: "tool-signature",
      },
    ],
    usage: {},
    stopReason: "toolUse",
    timestamp: Date.parse("2026-07-21T00:00:00.000Z"),
  });
});

test("tool results retain ordered content, details, usage, and dynamically added tools", () => {
  const block: ToolResultBlock = {
    type: "tool_result",
    callId: "call-1",
    name: "inspect",
    content: "firstlast",
    contentBlocks: [
      { type: "text", text: "first" },
      { type: "image", mediaType: "image/jpeg", data: "aW1hZ2U=" },
      { type: "text", text: "last" },
    ],
    metadata: { path: "result.txt" },
    addedToolNames: ["follow_up"],
    isError: false,
  };
  const canonical: CanonicalMessage = {
    id: "message-tool",
    role: "tool",
    content: [block],
    createdAt: "2026-07-21T00:00:02.000Z",
    usage: normalizedUsage,
  };
  const exposed = extensionToolResult(canonical, block);
  assert.deepEqual(exposed.content, [
    { type: "text", text: "first" },
    { type: "image", mimeType: "image/jpeg", data: "aW1hZ2U=" },
    { type: "text", text: "last" },
  ]);
  assert.deepEqual(exposed.details, { path: "result.txt" });
  assert.deepEqual(exposed.addedToolNames, ["follow_up"]);
  assert.deepEqual(exposed.usage, extensionUsage(normalizedUsage));

  const roundTrip = canonicalMessage(exposed, canonical);
  assert.equal(roundTrip.role, "tool");
  assert.deepEqual(roundTrip.content[0], { ...block, images: [block.contentBlocks![1]] });
  assert.deepEqual(roundTrip.usage, normalizedUsage);
});

test("extension session facade projects a canonical tool batch as individual public messages", () => {
  const manager = SessionManager.inMemory("/tmp", { id: "session-contract" });
  const userId = manager.appendMessage({
    id: "message-user",
    role: "user",
    content: [{ type: "text", text: "run both" }],
    createdAt: "2026-07-21T00:00:00.000Z",
  });
  const toolId = manager.appendMessage({
    id: "message-tools",
    role: "tool",
    content: [
      { type: "tool_result", callId: "call-1", name: "one", content: "first", isError: false },
      { type: "tool_result", callId: "call-2", name: "two", content: "second", isError: true },
    ],
    createdAt: "2026-07-21T00:00:01.000Z",
  });
  const session = extensionSessionManager(manager);
  const entries = session.getEntries();
  assert.deepEqual(entries.map((entry) => entry.type === "message" ? entry.message.role : entry.type), [
    "user",
    "toolResult",
    "toolResult",
  ]);
  assert.equal(entries[1]?.id, toolId);
  assert.equal(entries[1]?.parentId, userId);
  assert.equal(entries[2]?.id, `${toolId}~1`);
  assert.equal(entries[2]?.parentId, toolId);
  assert.equal(session.getLeafId(), `${toolId}~1`);
  assert.deepEqual(
    entries.slice(1).map((entry) => (entry as { message: ToolResultMessage }).message.toolName),
    ["one", "two"],
  );

  const publicMessage: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "continue" }],
    timestamp: Date.parse("2026-07-21T00:00:02.000Z"),
  };
  session.appendMessage(publicMessage);
  assert.equal(manager.getLeafEntry()?.type, "message");
  const leaf = session.getLeafEntry();
  assert.deepEqual(leaf?.type === "message" ? leaf.message : undefined, publicMessage);
});

test("extension session pages bound payload materialization across projection spans and live appends", () => {
  const manager = SessionManager.inMemory("/tmp", { id: "session-contract-pages" });
  const root = manager.appendMessage({
    id: "paged-root",
    role: "user",
    content: [{ type: "text", text: "root" }],
    createdAt: "2026-07-21T00:00:00.000Z",
  });
  const tools = manager.appendMessage({
    id: "paged-tools",
    role: "tool",
    content: [
      { type: "tool_result", callId: "paged-call-1", name: "one", content: "first", isError: false },
      { type: "tool_result", callId: "paged-call-2", name: "two", content: "second", isError: false },
    ],
    createdAt: "2026-07-21T00:00:01.000Z",
  });
  const child = manager.appendMessage({
    id: "paged-child",
    role: "assistant",
    provider: "paged-provider",
    model: "paged-model",
    content: [{ type: "text", text: "child" }],
    createdAt: "2026-07-21T00:00:02.000Z",
  });
  for (let index = 0; index < 128; index += 1) {
    manager.appendCustomEntry("paged-filler", { index });
  }

  const nativeGetEntries = manager.getEntries.bind(manager);
  const nativeGetEntriesPage = manager.getEntriesPage.bind(manager);
  let fullMaterializations = 0;
  let pageMaterializations = 0;
  manager.getEntries = () => {
    const entries = nativeGetEntries();
    fullMaterializations += entries.length;
    return entries;
  };
  manager.getEntriesPage = (offset, limit) => {
    const entries = nativeGetEntriesPage(offset, limit);
    pageMaterializations += entries.length;
    return entries;
  };

  const session = extensionSessionManager(manager) as ReturnType<typeof extensionSessionManager> & {
    getEntriesPage(offset: number, limit: number): { entries: Array<{ id: string; parentId: string | null; type: string; message?: AgentMessage }>; totalEntries: number };
  };
  const coldTail = session.getEntriesPage(131, 1);
  assert.equal(coldTail.entries.length, 1);
  assert.equal(coldTail.totalEntries, 132);
  assert.equal(pageMaterializations, 1);
  assert.equal(fullMaterializations, 0);

  const first = session.getEntriesPage(0, 1);
  assert.deepEqual(first.entries.map((entry) => entry.id), [root]);
  assert.equal(first.totalEntries, 132);
  assert.equal(pageMaterializations, 2);
  assert.equal(fullMaterializations, 0);

  const spanning = session.getEntriesPage(2, 2);
  assert.deepEqual(spanning.entries.map((entry) => [entry.id, entry.parentId]), [
    [`${tools}~1`, tools],
    [child, `${tools}~1`],
  ]);
  assert.equal(pageMaterializations, 4);
  assert.equal(fullMaterializations, 0);

  const firstMessage = first.entries[0]?.message;
  if (firstMessage?.role !== "user" || !Array.isArray(firstMessage.content)) assert.fail("Expected paged user message");
  firstMessage.content[0] = { type: "text", text: "mutated page" };
  const replayed = session.getEntriesPage(0, 1);
  assert.deepEqual(
    replayed.entries[0]?.message?.role === "user" ? replayed.entries[0].message.content : undefined,
    [{ type: "text", text: "root" }],
  );

  manager.appendLabelChange(root, "root label");
  const afterRevision = session.getEntriesPage(0, 1);
  assert.deepEqual(afterRevision.entries.map((entry) => entry.id), [root]);
  assert.equal(fullMaterializations, 0);

  const previousTotal = afterRevision.totalEntries;
  session.appendMessage({
    role: "bashExecution",
    command: "printf live",
    output: "live output",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: Date.parse("2026-07-21T00:00:03.000Z"),
  });
  const appended = session.getEntriesPage(previousTotal, 1);
  assert.equal(appended.totalEntries, previousTotal + 1);
  assert.equal(appended.entries[0]?.message?.role, "bashExecution");
  assert.equal(
    appended.entries[0]?.message?.role === "bashExecution" ? appended.entries[0].message.output : undefined,
    "live output",
  );
  assert.equal(fullMaterializations, 0);
  assert.ok(pageMaterializations <= 7, `paged projection materialized ${pageMaterializations} canonical rows`);
});

test("extension session pages preserve projected ID collisions and cursor order", () => {
  const manager = SessionManager.inMemory("/tmp", { id: "session-contract-page-collisions" });
  manager.appendMessage({
    id: "row",
    role: "tool",
    content: [
      { type: "tool_result", callId: "collision-1", name: "one", content: "one", isError: false },
      { type: "tool_result", callId: "collision-2", name: "two", content: "two", isError: false },
      { type: "tool_result", callId: "collision-3", name: "three", content: "three", isError: false },
    ],
    createdAt: "2026-07-21T00:00:00.000Z",
  }, { nodeId: "row" });
  manager.appendMessage({
    id: "row~1",
    role: "user",
    content: [{ type: "text", text: "collision" }],
    createdAt: "2026-07-21T00:00:01.000Z",
  }, { nodeId: "row~1" });
  manager.appendMessage({
    id: "row~2",
    role: "user",
    content: [{ type: "text", text: "second collision" }],
    createdAt: "2026-07-21T00:00:02.000Z",
  }, { nodeId: "row~2" });

  const session = extensionSessionManager(manager) as ReturnType<typeof extensionSessionManager> & {
    getEntriesPage(offset: number, limit: number): { entries: Array<{ id: string; parentId: string | null }>; totalEntries: number };
  };
  const expected = session.getEntries();
  assert.deepEqual(expected.map((entry) => [entry.id, entry.parentId]), [
    ["row", null],
    ["row~1", "row"],
    ["row~2", "row~1"],
    ["row~1~0", "row~2"],
    ["row~2~0", "row~1~0"],
  ]);
  const replayed = [];
  for (let offset = 0; offset < expected.length; offset += 1) {
    const page = session.getEntriesPage(offset, 1);
    assert.equal(page.totalEntries, expected.length);
    replayed.push(...page.entries);
  }
  assert.deepEqual(replayed, expected);
});

test("extension branch queries apply bounds and limits to projected entries", () => {
  const manager = SessionManager.inMemory("/tmp", { id: "extension-branch-queries" });
  const root = manager.appendMessage({
    id: "branch-root",
    role: "user",
    content: [{ type: "text", text: "root" }],
    createdAt: "2026-07-21T00:00:00.000Z",
  });
  const custom = manager.appendCustomEntry("note", { value: 1 });
  const tools = manager.appendMessage({
    id: "branch-tools",
    role: "tool",
    content: [
      { type: "tool_result", callId: "branch-call-1", name: "one", content: "first", isError: false },
      { type: "tool_result", callId: "branch-call-2", name: "two", content: "second", isError: false },
    ],
    createdAt: "2026-07-21T00:00:01.000Z",
  });
  const session = extensionSessionManager(manager);
  const projectedTail = `${tools}~1`;

  assert.deepEqual(session.findEntriesOnBranch().map((entry) => entry.id), [
    projectedTail,
    tools,
    custom,
    root,
  ]);
  assert.deepEqual(
    session.findEntriesOnBranch({ start: projectedTail, stopAtId: tools }).map((entry) => entry.id),
    [projectedTail, tools],
  );
  assert.deepEqual(
    session.findEntriesOnBranch({ start: projectedTail, order: "oldestFirst", limit: 2 }).map((entry) => entry.id),
    [root, custom],
  );
  assert.deepEqual(
    session.findEntriesOnBranch({ start: projectedTail, customType: "note" }).map((entry) => entry.id),
    [custom],
  );
  assert.equal(session.findEntryOnBranch({ start: projectedTail, type: "message" })?.id, projectedTail);
  assert.deepEqual(session.findEntriesOnBranch({ start: null }), []);
  assert.throws(() => session.findEntriesOnBranch({ start: "missing" }), /Entry missing not found/u);
  assert.throws(() => session.findEntriesOnBranch({ limit: -1 }), /positive integer/u);

  const result = session.findEntriesOnBranch({ start: projectedTail, customType: "note" });
  (result[0] as { data?: { value: number } }).data!.value = 99;
  const stored = session.getEntry(custom);
  assert.deepEqual(stored?.type === "custom" ? stored.data : undefined, { value: 1 });
});

test("AgentSession publishes queue and committed-session lifecycle events", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-session-events-"));
  context.after(async () => await rm(cwd, { recursive: true, force: true }));
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd, { id: "public-events" }),
    providers: new ProviderRegistry(),
    workspace: cwd,
    settingsManager: SettingsManager.inMemory(),
  });
  context.after(async () => await session.close());
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => { events.push(event); });

  session.appendCustomEntry("marker", { ready: true });
  session.setSessionName("Contract test");
  const thinkingLevel = session.thinkingLevel === "low" ? "high" : "low";
  session.setThinkingLevel(thinkingLevel);
  session.steer("queued message");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.ok(events.some((event) => event.type === "entry_appended" && event.entry.type === "custom"));
  assert.ok(events.some((event) => event.type === "session_info_changed" && event.name === "Contract test"));
  assert.ok(events.some((event) => event.type === "thinking_level_changed" && event.level === thinkingLevel));
  assert.ok(events.some((event) => (
    event.type === "queue_update" && event.steering.includes("queued message")
  )));
});
