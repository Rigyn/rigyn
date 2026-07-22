import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentMessage,
  AssistantMessageEventStream,
  StreamFn,
} from "@rigyn/kernel";
import {
  contentText,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Usage,
} from "@rigyn/models";

import {
  calculateContextTokens,
  compact,
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  generateBranchSummary,
  generateSummaryWithUsage,
  getLastAssistantUsage,
  prepareBranchEntries,
  serializeConversation,
  type CompactionPreparation,
} from "../../src/context/public-compaction.js";
import type {
  BranchSummaryEntry,
  CustomMessageEntry,
  SessionEntry,
  SessionMessageEntry,
} from "../../src/extensions/session-contract.js";

function usage(input = 10, output = 5, cacheRead = 0, cacheWrite = 0): Usage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: "summary-model",
    name: "Summary Model",
    api: "rigyn-messages",
    provider: "test",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 4_096,
    ...overrides,
  };
}

function assistant(
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "rigyn-messages",
    provider: "test",
    model: "summary-model",
    usage: usage(),
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

function messageEntry(id: string, message: AgentMessage, parentId: string | null = null): SessionMessageEntry {
  return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message };
}

function streamResponses(
  responses: AssistantMessage[],
  calls: Array<{ model: Model; context: Context; options: SimpleStreamOptions }> = [],
): StreamFn {
  let index = 0;
  return async (selectedModel, context, options = {}) => {
    calls.push({ model: selectedModel, context, options });
    const response = responses[index++];
    if (response === undefined) throw new Error("No scripted summary response remains");
    return {
      result: async () => response,
    } as unknown as AssistantMessageEventStream;
  };
}

test("public token estimation is role-aware and uses the native usage total when present", () => {
  const user: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "12345678" }, { type: "image", data: "x", mimeType: "image/png" }],
    timestamp: 1,
  };
  assert.equal(estimateTokens(user), Math.ceil((8 + 4_800) / 4));

  const args = { path: "/tmp/a" };
  const response = assistant([
    { type: "text", text: "1234" },
    { type: "thinking", thinking: "5678" },
    { type: "toolCall", id: "call", name: "read", arguments: args },
  ]);
  assert.equal(estimateTokens(response), Math.ceil((4 + 4 + "read".length + JSON.stringify(args).length) / 4));
  assert.equal(estimateTokens({
    role: "bashExecution",
    command: "1234",
    output: "5678",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 1,
  }), 2);
  assert.equal(estimateTokens({ role: "branchSummary", summary: "12345678", fromId: "x", timestamp: 1 }), 2);
  assert.equal(estimateTokens({ role: "custom", customType: "empty", content: "", display: false, timestamp: 1 }), 0);

  const native = { ...usage(1, 2, 3, 4), totalTokens: 99 };
  assert.equal(calculateContextTokens(native), 99);
  assert.equal(calculateContextTokens({ ...native, totalTokens: 0 }), 10);
});

test("last assistant usage ignores failed, aborted, and zero-token responses", () => {
  const valid = usage(11, 7);
  const entries: SessionEntry[] = [
    messageEntry("valid", assistant([{ type: "text", text: "ok" }], { usage: valid })),
    messageEntry("zero", assistant([], { usage: usage(0, 0), stopReason: "stop" }), "valid"),
    messageEntry("failed", assistant([], { usage: usage(50, 50), stopReason: "error" }), "zero"),
    messageEntry("aborted", assistant([], { usage: usage(60, 60), stopReason: "aborted" }), "failed"),
  ];
  assert.deepEqual(getLastAssistantUsage(entries), valid);
});

test("custom and summary messages start turns while assistant and tool results do not", () => {
  const custom: CustomMessageEntry = {
    type: "custom_message",
    id: "custom",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "notice",
    content: "x".repeat(4_000),
    display: true,
  };
  const response = messageEntry("assistant", assistant([{ type: "text", text: "ok" }]), "custom");
  const result = messageEntry("result", {
    role: "toolResult",
    toolCallId: "call",
    toolName: "read",
    content: [{ type: "text", text: "done" }],
    isError: false,
    timestamp: 1,
  }, "assistant");
  const entries: SessionEntry[] = [custom, response, result];

  assert.equal(findTurnStartIndex(entries, 2, 0), 0);
  assert.deepEqual(findCutPoint(entries, 0, 2, 1), {
    firstKeptEntryIndex: 1,
    turnStartIndex: 0,
    isSplitTurn: true,
  });

  const branch: BranchSummaryEntry = {
    type: "branch_summary",
    id: "branch",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    fromId: "old",
    summary: "branch context",
  };
  assert.equal(findTurnStartIndex([branch, response], 1, 0), 0);
});

test("branch preparation retains complete tool pairs and records only successful matched file operations", () => {
  const nested: BranchSummaryEntry = {
    type: "branch_summary",
    id: "nested",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    fromId: "old",
    summary: "nested branch",
    details: { readFiles: ["/nested/read"], modifiedFiles: ["/nested/changed"] },
  };
  const toolCalls = messageEntry("tools", assistant([
    { type: "toolCall", id: "1", name: "read", arguments: { path: "/read-only" } },
    { type: "toolCall", id: "2", name: "read", arguments: { path: "/also-written" } },
    { type: "toolCall", id: "3", name: "write", arguments: { path: "/also-written" } },
    { type: "toolCall", id: "4", name: "edit", arguments: { path: "/edited" } },
  ]), "nested");
  const toolResult = messageEntry("result", {
    role: "toolResult",
    toolCallId: "1",
    toolName: "read",
    content: [{ type: "text", text: "not summarized directly" }],
    isError: false,
    timestamp: 1,
  }, "tools");
  const failedWrite = messageEntry("failed-write", {
    role: "toolResult",
    toolCallId: "3",
    toolName: "write",
    content: [{ type: "text", text: "failed" }],
    isError: true,
    timestamp: 1,
  }, "result");
  const mismatchedEdit = messageEntry("mismatched-edit", {
    role: "toolResult",
    toolCallId: "4",
    toolName: "write",
    content: [{ type: "text", text: "wrong tool" }],
    isError: false,
    timestamp: 1,
  }, "failed-write");

  const prepared = prepareBranchEntries([nested, toolCalls, toolResult, failedWrite, mismatchedEdit]);
  assert.deepEqual(
    prepared.messages.map((message) => message.role),
    ["branchSummary", "assistant", "toolResult", "toolResult", "toolResult"],
  );
  const retainedAssistant = prepared.messages.find((message) => message.role === "assistant");
  assert.deepEqual(
    retainedAssistant?.role === "assistant"
      ? retainedAssistant.content.flatMap((block) => block.type === "toolCall" ? [block.id] : [])
      : [],
    ["1", "3", "4"],
  );
  assert.deepEqual([...prepared.fileOps.read].sort(), ["/nested/read", "/read-only"]);
  assert.deepEqual([...prepared.fileOps.written], []);
  assert.deepEqual([...prepared.fileOps.edited], ["/nested/changed"]);
});

test("branch preparation rejects an oversized newest message and treats non-positive budgets as empty", () => {
  const entry = messageEntry("large", { role: "user", content: "x".repeat(20_000), timestamp: 1 });
  assert.deepEqual(prepareBranchEntries([entry], 0), {
    messages: [],
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    totalTokens: 0,
  });
  assert.throws(
    () => prepareBranchEntries([entry], 100),
    /newest complete message or tool pair cannot fit/u,
  );
});

test("branch preparation bounds and validates nested file metadata", () => {
  const valid = Array.from({ length: 700 }, (_value, index) => `/nested/${index}`);
  const nested: BranchSummaryEntry = {
    type: "branch_summary",
    id: "nested-bounded",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    fromId: "old",
    summary: "nested branch",
    details: {
      readFiles: [...valid, "/bad\npath", "x".repeat(4_097), 42],
      modifiedFiles: ["/changed", "/changed", "\0invalid"],
    },
  };
  const prepared = prepareBranchEntries([nested]);
  assert.equal(prepared.fileOps.read.size, 512);
  assert.equal(prepared.fileOps.read.has("/nested/699"), true);
  assert.equal(prepared.fileOps.read.has("/nested/0"), false);
  assert.deepEqual([...prepared.fileOps.edited], ["/changed"]);
});

test("branch summary returns provider usage and normalized file lists", async () => {
  const summaryUsage = usage(20, 8, 3, 2);
  const calls: Array<{ model: Model; context: Context; options: SimpleStreamOptions }> = [];
  const streamFn = streamResponses([
    assistant([{ type: "text", text: "Branch checkpoint" }], { usage: summaryUsage }),
  ], calls);
  const entries: SessionEntry[] = [
    messageEntry("user", { role: "user", content: "work", timestamp: 1 }),
    messageEntry("assistant", assistant([
      { type: "toolCall", id: "1", name: "read", arguments: { path: "/same" } },
      { type: "toolCall", id: "2", name: "write", arguments: { path: "/same" } },
      { type: "toolCall", id: "3", name: "read", arguments: { path: "/read" } },
    ]), "user"),
    messageEntry("read-same", {
      role: "toolResult",
      toolCallId: "1",
      toolName: "read",
      content: [{ type: "text", text: "read" }],
      isError: false,
      timestamp: 1,
    }, "assistant"),
    messageEntry("write-same", {
      role: "toolResult",
      toolCallId: "2",
      toolName: "write",
      content: [{ type: "text", text: "write" }],
      isError: false,
      timestamp: 1,
    }, "read-same"),
    messageEntry("read-only", {
      role: "toolResult",
      toolCallId: "3",
      toolName: "read",
      content: [{ type: "text", text: "read" }],
      isError: false,
      timestamp: 1,
    }, "write-same"),
  ];
  const signal = new AbortController().signal;

  const result = await generateBranchSummary(entries, {
    model: model(),
    apiKey: "test-key",
    headers: { "x-test": "yes" },
    env: { TEST_ENV: "yes" },
    signal,
    streamFn,
  });

  assert.deepEqual(result.usage, summaryUsage);
  assert.deepEqual(result.readFiles, ["/read"]);
  assert.deepEqual(result.modifiedFiles, ["/same"]);
  assert.match(result.summary ?? "", /Branch checkpoint/u);
  assert.match(result.summary ?? "", /<read-files>\n\/read\n<\/read-files>/u);
  assert.match(result.summary ?? "", /<modified-files>\n\/same\n<\/modified-files>/u);
  assert.equal(calls[0]?.options.maxTokens, 2_048);
  assert.equal(calls[0]?.options.signal, signal);
  assert.equal(calls[0]?.options.apiKey, "test-key");
});

test("branch summary derives its input budget from context, output, and reserve", async () => {
  let called = false;
  const result = await generateBranchSummary(
    [messageEntry("user", { role: "user", content: "work", timestamp: 1 })],
    {
      model: model({ contextWindow: 2_000, maxTokens: 1_500 }),
      reserveTokens: 600,
      signal: new AbortController().signal,
      streamFn: async () => {
        called = true;
        throw new Error("must not stream");
      },
    },
  );
  assert.equal(called, false);
  assert.match(result.error ?? "", /does not leave a positive input budget/u);
});

test("branch summary normalizes a provider-native aborted response", async () => {
  const result = await generateBranchSummary(
    [messageEntry("user", { role: "user", content: "work", timestamp: 1 })],
    {
      model: model(),
      signal: new AbortController().signal,
      streamFn: streamResponses([assistant([], { stopReason: "aborted" })]),
    },
  );
  assert.deepEqual(result, { aborted: true });
});

test("summary generation exposes text and usage while forwarding bounded reasoning options", async () => {
  const summaryUsage = usage(30, 10);
  const calls: Array<{ model: Model; context: Context; options: SimpleStreamOptions }> = [];
  const streamFn = streamResponses([
    assistant([{ type: "text", text: "Current checkpoint" }], { usage: summaryUsage }),
  ], calls);
  const result = await generateSummaryWithUsage(
    [{ role: "user", content: "new work", timestamp: 1 }],
    model({ maxTokens: 600 }),
    1_000,
    "key",
    { "x-test": "yes" },
    undefined,
    "focus on tests",
    "older checkpoint",
    "medium",
    streamFn,
    { REGION: "local" },
  );

  assert.deepEqual(result, { text: "Current checkpoint", usage: summaryUsage });
  assert.deepEqual(calls[0]?.options, {
    maxTokens: 600,
    apiKey: "key",
    headers: { "x-test": "yes" },
    env: { REGION: "local" },
    signal: undefined,
    reasoning: "medium",
  });
  const prompt = calls[0]?.context.messages[0];
  assert.equal(prompt?.role, "user");
  assert.match(prompt?.role === "user" ? contentText(prompt.content) : "", /older checkpoint/u);
  assert.match(prompt?.role === "user" ? contentText(prompt.content) : "", /focus on tests/u);
});

test("split-turn compaction combines usage and reports deduplicated file activity", async () => {
  const firstUsage = { ...usage(2, 3), reasoning: 4 };
  const secondUsage = { ...usage(5, 7), reasoning: 6 };
  const streamFn = streamResponses([
    assistant([{ type: "text", text: "History" }], { usage: firstUsage }),
    assistant([{ type: "text", text: "Turn prefix" }], { usage: secondUsage }),
  ]);
  const preparation: CompactionPreparation = {
    firstKeptEntryId: "keep",
    messagesToSummarize: [{ role: "user", content: "history", timestamp: 1 }],
    turnPrefixMessages: [{ role: "user", content: "large turn", timestamp: 2 }],
    isSplitTurn: true,
    tokensBefore: 9_000,
    fileOps: {
      read: new Set(["/read", "/changed"]),
      written: new Set(["/changed"]),
      edited: new Set(["/edited"]),
    },
    settings: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 500 },
  };

  const result = await compact(preparation, model(), undefined, undefined, undefined, undefined, "off", streamFn);
  assert.equal(result.firstKeptEntryId, "keep");
  assert.equal(result.tokensBefore, 9_000);
  assert.deepEqual(result.details, { readFiles: ["/read"], modifiedFiles: ["/changed", "/edited"] });
  assert.deepEqual(result.usage, {
    input: 7,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 10,
    totalTokens: 17,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  assert.match(result.summary, /History/u);
  assert.match(result.summary, /Turn prefix/u);
});

test("conversation serialization truncates only long tool output", () => {
  const longToolText = "x".repeat(5_000);
  const serialized = serializeConversation([
    { role: "user", content: "request", timestamp: 1 },
    assistant([
      { type: "thinking", thinking: "consider" },
      { type: "text", text: "answer" },
      { type: "toolCall", id: "call", name: "read", arguments: { path: "/a" } },
    ]),
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: longToolText }],
      isError: false,
      timestamp: 1,
    },
  ]);
  assert.match(serialized, /\[User\]: request/u);
  assert.match(serialized, /\[Assistant thinking\]: consider/u);
  assert.match(serialized, /\[Assistant tool calls\]: read\(path="\/a"\)/u);
  assert.match(serialized, /\[\.\.\. 3000 more characters truncated\]/u);
  assert.doesNotMatch(serialized, /x{2001}/u);
});
