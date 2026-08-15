import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentMessage,
  StreamFn,
} from "@rigyn/kernel";
import { bashExecutionToText } from "@rigyn/kernel";
import { estimateMessageTokens as estimateKernelMessageTokens } from "@rigyn/kernel/runtime/context/projection";
import {
  contentText,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Usage,
} from "@rigyn/models";

import {
  calculateContextTokens,
  compact,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  generateBranchSummary,
  generateSummaryWithUsage,
  getLastAssistantUsage,
  prepareBranchEntries,
  prepareCompaction,
  serializeConversation,
  shouldCompact,
  type CompactionPreparation,
} from "../../src/context/public-compaction.js";
import type {
  BranchSummaryEntry,
  CustomMessageEntry,
  SessionEntry,
  SessionMessageEntry,
} from "../../src/extensions/session-contract.js";

function usage(input = 10, output = 5, cacheRead = 0, cacheWrite = 0): Usage {
  const totalTokens = input + output + cacheRead + cacheWrite;
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost,
  };
}

test("public compaction thresholds honor an independent published input ceiling", () => {
  const settings = { enabled: true, recentTokens: 20_000, reserveTokens: 60_000 };
  assert.equal(shouldCompact(300_000, 400_000, settings), false);
  assert.equal(shouldCompact(300_000, 400_000, { ...settings, maxInputTokens: 272_000 }), true);
  for (const maxInputTokens of [0, Number.NaN, 1.5]) {
    assert.throws(
      () => shouldCompact(300_000, 400_000, { ...settings, maxInputTokens }),
      /maxInputTokens must be a positive safe integer/u,
    );
  }
});

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: "summary-model",
    name: "Summary Model",
    api: "openai-responses",
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
    api: "openai-responses",
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
  return (selectedModel, context, options = {}) => {
    calls.push({ model: selectedModel, context, options });
    const response = responses[index++];
    if (response === undefined) throw new Error("No scripted summary response remains");
    const stream = createAssistantMessageEventStream();
    const reason = response.stopReason === "length" || response.stopReason === "toolUse"
      ? response.stopReason
      : "stop";
    stream.push({ type: "done", reason, message: response });
    return stream;
  };
}

test("public token estimation is role-aware and uses the native usage total when present", () => {
  const createdAt = new Date(0).toISOString();
  const user: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: "12345678" }, { type: "image", data: "x", mimeType: "image/png" }],
    timestamp: 1,
  };
  assert.equal(estimateTokens(user), estimateKernelMessageTokens({
    id: "expected-user",
    role: "user",
    createdAt,
    content: [
      { type: "text", text: "12345678" },
      { type: "image", data: "x", mediaType: "image/png" },
    ],
  }));

  const args = { path: "/tmp/a" };
  const response = assistant([
    { type: "text", text: "1234" },
    { type: "thinking", thinking: "5678" },
    { type: "toolCall", id: "call", name: "read", arguments: args },
  ]);
  assert.equal(estimateTokens(response), estimateKernelMessageTokens({
    id: "expected-assistant",
    role: "assistant",
    createdAt,
    content: [
      { type: "text", text: "1234" },
      { type: "thinking", thinking: "5678" },
      { type: "tool_call", callId: "call", name: "read", arguments: args, rawArguments: JSON.stringify(args) },
    ],
  }));
  const shell: AgentMessage = {
    role: "bashExecution",
    command: "1234",
    output: "5678",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 1,
  };
  assert.equal(estimateTokens(shell), estimateKernelMessageTokens({
    id: "expected-shell",
    role: "user",
    createdAt,
    content: [{ type: "text", text: bashExecutionToText(shell) }],
  }));
  const branch: AgentMessage = { role: "branchSummary", summary: "12345678", fromId: "x", timestamp: 1 };
  assert.equal(estimateTokens(branch), estimateKernelMessageTokens({
    id: "expected-branch",
    role: "user",
    createdAt,
    content: [{ type: "text", text: "12345678" }],
  }));
  const empty: AgentMessage = { role: "custom", customType: "empty", content: "", display: false, timestamp: 1 };
  assert.equal(estimateTokens(empty), estimateKernelMessageTokens({
    id: "expected-empty",
    role: "user",
    createdAt,
    content: [{ type: "text", text: "" }],
  }));

  const native = { ...usage(1, 2, 3, 4), totalTokens: 99 };
  assert.equal(calculateContextTokens(native), 99);
  assert.equal(calculateContextTokens({ ...native, totalTokens: 0 }), 10);
  assert.equal(calculateContextTokens({ input: 1, output: 2 }), undefined);
  assert.equal(calculateContextTokens({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }), 3);
  const tail: AgentMessage = { role: "user", content: "tail", timestamp: 2 };
  assert.deepEqual(estimateContextTokens([assistant([], { usage: native }), tail]), {
    tokens: 99 + estimateTokens(tail),
    usageTokens: 99,
    trailingTokens: estimateTokens(tail),
    lastUsageIndex: 0,
  });
});

test("public context-token accounting omits unsafe provider arithmetic", () => {
  assert.equal(calculateContextTokens({
    input: Number.MAX_SAFE_INTEGER,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
  }), undefined);
  assert.equal(calculateContextTokens({ input: 1, output: 1.5, cacheRead: 0, cacheWrite: 0 }), undefined);
  assert.equal(calculateContextTokens({ totalTokens: Number.POSITIVE_INFINITY, output: 0 }), undefined);

  const tail: AgentMessage = { role: "user", content: "tail", timestamp: 2 };
  assert.deepEqual(estimateContextTokens([
    assistant([], { usage: { totalTokens: Number.MAX_SAFE_INTEGER } }),
    tail,
  ]), {
    tokens: Number.MAX_SAFE_INTEGER,
    usageTokens: Number.MAX_SAFE_INTEGER,
    trailingTokens: estimateTokens(tail),
    lastUsageIndex: 0,
  });
});

test("public compaction JSON estimation is callback-free and conservative for unsafe arguments", () => {
  let calls = 0;
  const inherited = Object.assign(Object.create({
    toJSON() {
      calls += 1;
      return { rewritten: true };
    },
  }) as Record<string, unknown>, { safe: true });
  const response = assistant([
    { type: "toolCall", id: "call", name: "read", arguments: inherited },
  ]);
  assert.ok(estimateTokens(response) >= 1_048_576);
  assert.equal(calls, 0);

  let traps = 0;
  const proxied = new Proxy({ safe: true }, {
    get() {
      traps += 1;
      throw new Error("get trap executed");
    },
    getPrototypeOf() {
      traps += 1;
      throw new Error("prototype trap executed");
    },
  });
  assert.ok(estimateTokens(assistant([
    { type: "toolCall", id: "proxy", name: "read", arguments: proxied },
  ])) >= 1_048_576);
  assert.equal(traps, 0);
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

test("public compaction estimates exclude superseded summaries from a newer retained tail", () => {
  const userTwo = messageEntry("u2", { role: "user", content: "two ".repeat(300), timestamp: 2 }, "u1");
  const firstCompaction: SessionEntry = {
    type: "compaction",
    id: "c1",
    parentId: "u2",
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "superseded ".repeat(2_000),
    firstKeptEntryId: "u2",
    tokensBefore: 10_000,
  };
  const userThree = messageEntry("u3", { role: "user", content: "three ".repeat(300), timestamp: 3 }, "c1");
  const secondCompaction: SessionEntry = {
    type: "compaction",
    id: "c2",
    parentId: "u3",
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "current checkpoint",
    firstKeptEntryId: "u2",
    tokensBefore: 8_000,
  };
  const userFour = messageEntry("u4", { role: "user", content: "four ".repeat(300), timestamp: 4 }, "c2");
  const entries: SessionEntry[] = [
    messageEntry("u1", { role: "user", content: "one", timestamp: 1 }),
    userTwo,
    firstCompaction,
    userThree,
    secondCompaction,
    userFour,
  ];
  const cleanEntries = entries.filter((entry) => entry.id !== firstCompaction.id);
  const settings = { enabled: true, reserveTokens: 1_000, recentTokens: 1 };

  const prepared = prepareCompaction(entries, settings);
  const cleanPrepared = prepareCompaction(cleanEntries, settings);
  assert.notEqual(prepared, undefined);
  assert.notEqual(cleanPrepared, undefined);
  assert.equal(prepared?.previousSummary, "current checkpoint");
  assert.equal(prepared?.tokensBefore, cleanPrepared?.tokensBefore);
});

test("compaction preparation carries only successful matched file activity into the checkpoint", () => {
  const calls = messageEntry("calls", assistant([
    { type: "toolCall", id: "read", name: "read", arguments: { path: "/read" } },
    { type: "toolCall", id: "write", name: "write", arguments: { path: "/write" } },
    { type: "toolCall", id: "failed", name: "edit", arguments: { path: "/failed" } },
    { type: "toolCall", id: "mismatch", name: "read", arguments: { path: "/mismatch" } },
  ]), "old");
  const result = (
    id: string,
    toolCallId: string,
    toolName: string,
    isError: boolean,
    parentId: string,
  ): SessionMessageEntry => messageEntry(id, {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: isError ? "failed" : "done" }],
    isError,
    timestamp: 1,
  }, parentId);
  const entries = [
    messageEntry("old", { role: "user", content: "old request", timestamp: 1 }),
    calls,
    result("read-result", "read", "read", false, "calls"),
    result("write-result", "write", "write", false, "read-result"),
    result("failed-result", "failed", "edit", true, "write-result"),
    result("mismatch-result", "mismatch", "write", false, "failed-result"),
    messageEntry("recent-user", { role: "user", content: "recent request", timestamp: 2 }, "mismatch-result"),
    messageEntry("recent-assistant", assistant([{ type: "text", text: "recent reply" }]), "recent-user"),
  ];

  const prepared = prepareCompaction(entries, { enabled: true, reserveTokens: 1_000, recentTokens: 1 });
  assert.notEqual(prepared, undefined);
  assert.deepEqual([...(prepared?.fileOps.read ?? [])], ["/read"]);
  assert.deepEqual([...(prepared?.fileOps.written ?? [])], ["/write"]);
  assert.deepEqual([...(prepared?.fileOps.edited ?? [])], []);
  assert.equal(prepared?.isSplitTurn, true);
  assert.equal(prepared?.firstKeptEntryId, "recent-assistant");
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

test("public cut selection moves earlier instead of splitting a tool call from its result", () => {
  const toolCall = messageEntry("call", assistant([
    { type: "toolCall", id: "paired", name: "read", arguments: { path: "/work/file.ts" } },
  ]), "request");
  const interleaved = messageEntry("interleaved", assistant([
    { type: "text", text: "waiting for the result" },
  ]), "call");
  const toolResult = messageEntry("result", {
    role: "toolResult",
    toolCallId: "paired",
    toolName: "read",
    content: [{ type: "text", text: "contents" }],
    isError: false,
    timestamp: 1,
  }, "interleaved");
  const recent = messageEntry("recent", assistant([{ type: "text", text: "continue" }]), "result");
  const entries = [
    messageEntry("request", { role: "user", content: "inspect the file", timestamp: 1 }),
    toolCall,
    interleaved,
    toolResult,
    recent,
  ];
  const recentTokens = [interleaved, toolResult, recent]
    .flatMap((entry) => entry.message)
    .reduce((total, message) => total + estimateTokens(message), 0);

  assert.deepEqual(findCutPoint(entries, 0, entries.length, recentTokens), {
    firstKeptEntryIndex: 1,
    turnStartIndex: 0,
    isSplitTurn: true,
  });
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
    ["branchSummary", "assistant", "toolResult", "toolResult"],
  );
  const retainedAssistant = prepared.messages.find((message) => message.role === "assistant");
  assert.deepEqual(
    retainedAssistant?.role === "assistant"
      ? retainedAssistant.content.flatMap((block) => block.type === "toolCall" ? [block.id] : [])
      : [],
    ["1", "3"],
  );
  assert.deepEqual([...prepared.fileOps.read].sort(), ["/nested/read", "/read-only"]);
  assert.deepEqual([...prepared.fileOps.written], []);
  assert.deepEqual([...prepared.fileOps.edited], ["/nested/changed"]);
});

test("branch preparation rejects an oversized newest message and treats non-positive budgets as empty", () => {
  const entry = messageEntry("large", { role: "user", content: "x".repeat(20_000), timestamp: 1 });
  const recent = messageEntry("recent", { role: "user", content: "keep this", timestamp: 2 }, "large");
  const emptyFileOps = { read: new Set(), written: new Set(), edited: new Set() };
  assert.deepEqual(prepareBranchEntries([entry], 0), {
    messages: [],
    fileOps: emptyFileOps,
    totalTokens: 0,
  });
  assert.throws(
    () => prepareBranchEntries([entry], 100),
    /newest complete message or tool pair cannot fit/u,
  );
  assert.deepEqual(prepareBranchEntries([entry, recent], 100).messages, [recent.message]);
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
  assert.match(result.summary ?? "", /<files-read>\n\/read\n<\/files-read>/u);
  assert.match(result.summary ?? "", /<files-changed>\n\/same\n<\/files-changed>/u);
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
      streamFn: () => {
        called = true;
        throw new Error("must not stream");
      },
    },
  );
  assert.equal(called, false);
  assert.match(result.error ?? "", /does not leave a positive input budget/u);
});

test("branch summary applies a published input ceiling before its safety reserve", async () => {
  let called = false;
  const result = await generateBranchSummary(
    [messageEntry("user", { role: "user", content: "work", timestamp: 1 })],
    {
      model: model({ contextWindow: 64_000, maxInputTokens: 10_000, maxTokens: 4_096 }),
      signal: new AbortController().signal,
      streamFn: () => {
        called = true;
        throw new Error("must not stream");
      },
    },
  );
  assert.equal(called, false);
  assert.match(result.error ?? "", /does not leave a positive input budget/u);
});

test("branch summary rejects wrapper and instruction overhead above its published input ceiling", async () => {
  let called = false;
  const result = await generateBranchSummary(
    [messageEntry("user", { role: "user", content: "work", timestamp: 1 })],
    {
      model: model({ contextWindow: 64_000, maxInputTokens: 20_000, maxTokens: 2_048 }),
      reserveTokens: 0,
      customInstructions: "x".repeat(100_000),
      signal: new AbortController().signal,
      streamFn: () => {
        called = true;
        throw new Error("must not stream");
      },
    },
  );
  assert.equal(called, false);
  assert.match(result.error ?? "", /request exceeds the selected model input budget/u);
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

test("branch summary rejects unsafe terminal reasons and output above its requested cap", async () => {
  const entries = [messageEntry("user", { role: "user", content: "work", timestamp: 1 })];
  const cases = [
    {
      name: "unsafe terminal",
      response: assistant([{ type: "text", text: "partial" }], { stopReason: "length" }),
      error: /ended with length/u,
    },
    {
      name: "inconsistent tool call",
      response: assistant([{ type: "toolCall", id: "summary-tool", name: "read", arguments: { path: "x" } }]),
      error: /included a tool call/u,
    },
    {
      name: "reported token overrun",
      response: assistant([{ type: "text", text: "summary" }], { usage: usage(10, 2_049) }),
      error: /reported 2049 output tokens.*limit of 2048/u,
    },
    {
      name: "estimated token overrun",
      response: assistant([{ type: "text", text: "x".repeat(4_097) }], { usage: usage(10, 0) }),
      error: /estimated 2049 output tokens.*limit of 2048/u,
    },
    {
      name: "estimated reasoning overrun",
      response: assistant([
        { type: "thinking", thinking: "x".repeat(4_097) },
        { type: "text", text: "ok" },
      ], { usage: usage(10, 0) }),
      error: /estimated 2050 output tokens.*limit of 2048/u,
    },
  ];

  for (const value of cases) {
    const result = await generateBranchSummary(entries, {
      model: model(),
      signal: new AbortController().signal,
      streamFn: streamResponses([value.response]),
    });
    assert.match(result.error ?? "", value.error, value.name);
    assert.equal(result.summary, undefined, value.name);
  }
});

test("branch summary trusts positive reported output usage within its requested cap", async () => {
  const result = await generateBranchSummary(
    [messageEntry("user", { role: "user", content: "work", timestamp: 1 })],
    {
      model: model(),
      signal: new AbortController().signal,
      streamFn: streamResponses([
        assistant([{ type: "text", text: "x".repeat(4_097) }], { usage: usage(10, 2_048) }),
      ]),
    },
  );

  assert.equal(result.error, undefined);
  assert.match(result.summary ?? "", /x{4097}/u);
});

test("branch summary fallback excludes reasoning signatures from its output estimate", async () => {
  const result = await generateBranchSummary(
    [messageEntry("user", { role: "user", content: "work", timestamp: 1 })],
    {
      model: model(),
      signal: new AbortController().signal,
      streamFn: streamResponses([
        assistant([
          { type: "thinking", thinking: "plan", thinkingSignature: "x".repeat(10_000) },
          { type: "text", text: "summary" },
        ], { usage: usage(10, 0) }),
      ]),
    },
  );

  assert.equal(result.error, undefined);
  assert.match(result.summary ?? "", /summary/u);
});

test("public conversation summary rejects a provider-native aborted response", async () => {
  await assert.rejects(
    generateSummaryWithUsage(
      [{ role: "user", content: "work", timestamp: 1 }],
      model(),
      1_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamResponses([assistant([], { stopReason: "aborted", errorMessage: "cancelled" })]),
    ),
    /aborted.*cancelled/iu,
  );
});

test("public conversation summary rejects unsafe terminal reasons and output above its requested cap", async () => {
  const cases = [
    {
      name: "unsafe terminal",
      response: assistant([{ type: "text", text: "partial" }], { stopReason: "length" }),
      error: /ended with length/u,
    },
    {
      name: "inconsistent tool call",
      response: assistant([{ type: "toolCall", id: "summary-tool", name: "read", arguments: { path: "x" } }]),
      error: /included a tool call/u,
    },
    {
      name: "reported token overrun",
      response: assistant([{ type: "text", text: "summary" }], { usage: usage(10, 81) }),
      error: /reported 81 output tokens.*limit of 80/u,
    },
    {
      name: "estimated token overrun",
      response: assistant([{ type: "text", text: "x".repeat(161) }], { usage: usage(10, 0) }),
      error: /estimated 81 output tokens.*limit of 80/u,
    },
    {
      name: "estimated reasoning overrun",
      response: assistant([
        { type: "thinking", thinking: "x".repeat(159) },
        { type: "text", text: "ok" },
      ], { usage: usage(10, 0) }),
      error: /estimated 81 output tokens.*limit of 80/u,
    },
  ];

  for (const value of cases) {
    await assert.rejects(
      generateSummaryWithUsage(
        [{ role: "user", content: "work", timestamp: 1 }],
        model(),
        100,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        streamResponses([value.response]),
      ),
      value.error,
      value.name,
    );
  }
});

test("public conversation summary trusts positive reported output usage within its requested cap", async () => {
  const result = await generateSummaryWithUsage(
    [{ role: "user", content: "work", timestamp: 1 }],
    model(),
    100,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    streamResponses([
      assistant([{ type: "text", text: "x".repeat(161) }], { usage: usage(10, 80) }),
    ]),
  );

  assert.equal(result.text, "x".repeat(161));
  assert.equal(result.usage.output, 80);
});

test("public conversation summaries validate input ceilings before invoking custom streams", async () => {
  const calls: Array<{ model: Model; context: Context; options: SimpleStreamOptions }> = [];
  await assert.rejects(
    generateSummaryWithUsage(
      [{ role: "user", content: "work", timestamp: 1 }],
      model({ maxInputTokens: 128 }),
      100,
      undefined,
      undefined,
      undefined,
      "x".repeat(1_024),
      undefined,
      undefined,
      streamResponses([assistant([{ type: "text", text: "must not run" }])], calls),
    ),
    /Estimated prompt tokens .* exceed the model maximum input token limit \(128\)/u,
  );
  for (const maxInputTokens of [0, Number.NaN, 1.5]) {
    await assert.rejects(
      generateSummaryWithUsage(
        [{ role: "user", content: "work", timestamp: 1 }],
        model({ maxInputTokens }),
        100,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        streamResponses([assistant([{ type: "text", text: "must not run" }])], calls),
      ),
      /Model maximum input token limit must be a positive safe integer/u,
    );
  }
  assert.equal(calls.length, 0);
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
    "test-key",
    { "x-test": "yes" },
    undefined,
    "focus on tests",
    "older checkpoint",
    "medium",
    streamFn,
    { REGION: "local" },
  );

  assert.deepEqual(result, { text: "Current checkpoint", usage: summaryUsage });
  assert.deepEqual({
    ...calls[0]?.options,
    sessionId: calls[0]?.options.sessionId === undefined ? undefined : "[isolated]",
  }, {
    maxTokens: 600,
    apiKey: "test-key",
    headers: { "x-test": "yes" },
    env: { REGION: "local" },
    signal: undefined,
    reasoning: "medium",
    cacheRetention: "none",
    sessionId: "[isolated]",
  });
  const prompt = calls[0]?.context.messages[0];
  assert.equal(prompt?.role, "user");
  assert.match(prompt?.role === "user" ? contentText(prompt.content) : "", /older checkpoint/u);
  assert.match(prompt?.role === "user" ? contentText(prompt.content) : "", /focus on tests/u);
});

test("public summary helpers isolate cache identity and retry transient failures", async () => {
  const calls: Array<{ model: Model; context: Context; options: SimpleStreamOptions }> = [];
  const lifecycle: string[] = [];
  const result = await generateSummaryWithUsage(
    [{ role: "user", content: "continue", timestamp: 1 }],
    model(),
    1_000,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    streamResponses([
      assistant([], { stopReason: "error", errorMessage: "network error" }),
      assistant([{ type: "text", text: "Recovered checkpoint" }]),
    ], calls),
    undefined,
    { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    {
      onRetryScheduled(attempt) { lifecycle.push(`scheduled:${attempt}`); },
      onRetryAttemptStart() { lifecycle.push("started"); },
      onRetryFinished(success, attempt) { lifecycle.push(`finished:${success}:${attempt}`); },
    },
  );

  assert.equal(result.text, "Recovered checkpoint");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.options.cacheRetention, "none");
  assert.equal(calls[1]?.options.cacheRetention, "none");
  assert.equal(typeof calls[0]?.options.sessionId, "string");
  assert.equal(calls[1]?.options.sessionId, calls[0]?.options.sessionId);
  assert.deepEqual(lifecycle, ["scheduled:1", "started", "finished:true:1"]);
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
    settings: { enabled: true, reserveTokens: 2_000, recentTokens: 500 },
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

test("split-turn compaction omits cache counters incomplete across its summary requests", async () => {
  const firstUsage: Usage = {
    input: 2,
    output: 3,
    cacheRead: 0,
    reasoning: 4,
    totalTokens: 5,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const secondUsage: Usage = {
    input: 5,
    output: 7,
    cacheWrite: 4,
    totalTokens: 16,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const result = await compact({
    firstKeptEntryId: "keep",
    messagesToSummarize: [{ role: "user", content: "history", timestamp: 1 }],
    turnPrefixMessages: [{ role: "user", content: "large turn", timestamp: 2 }],
    isSplitTurn: true,
    tokensBefore: 9_000,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 2_000, recentTokens: 500 },
  }, model(), undefined, undefined, undefined, undefined, "off", streamResponses([
    assistant([{ type: "text", text: "History" }], { usage: firstUsage }),
    assistant([{ type: "text", text: "Turn prefix" }], { usage: secondUsage }),
  ]));

  assert.equal(result.usage?.cacheRead, undefined);
  assert.equal(result.usage?.cacheWrite, undefined);
  assert.equal(result.usage?.reasoning, undefined);
});

test("split-turn compaction omits overflowing aggregate usage", async () => {
  const result = await compact({
    firstKeptEntryId: "keep",
    messagesToSummarize: [{ role: "user", content: "history", timestamp: 1 }],
    turnPrefixMessages: [{ role: "user", content: "large turn", timestamp: 2 }],
    isSplitTurn: true,
    tokensBefore: 9_000,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 2_000, recentTokens: 500 },
  }, model(), undefined, undefined, undefined, undefined, "off", streamResponses([
    assistant([{ type: "text", text: "History" }], {
      usage: {
        ...usage(2, 3),
        reasoning: Number.MAX_SAFE_INTEGER,
        cost: { input: Number.MAX_VALUE, output: 0, cacheRead: 0, cacheWrite: 0, total: Number.MAX_VALUE },
      },
    }),
    assistant([{ type: "text", text: "Turn prefix" }], {
      usage: {
        ...usage(5, 7),
        reasoning: 1,
        cost: { input: Number.MAX_VALUE, output: 0, cacheRead: 0, cacheWrite: 0, total: Number.MAX_VALUE },
      },
    }),
  ]));

  assert.equal(result.usage?.reasoning, undefined);
  assert.equal(result.usage?.cost, undefined);
  assert.deepEqual(result.usage, {
    input: 7,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 17,
  });
});

test("split-turn prefix summaries require a safe terminal and stay within their requested cap", async () => {
  const preparation: CompactionPreparation = {
    firstKeptEntryId: "keep",
    messagesToSummarize: [],
    turnPrefixMessages: [{ role: "user", content: "large turn", timestamp: 1 }],
    isSplitTurn: true,
    tokensBefore: 1_000,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 100, recentTokens: 50 },
  };
  const cases = [
    {
      name: "unsafe terminal",
      response: assistant([{ type: "text", text: "partial" }], { stopReason: "length" }),
      error: /ended with length/u,
    },
    {
      name: "reported token overrun",
      response: assistant([{ type: "text", text: "prefix" }], { usage: usage(10, 51) }),
      error: /reported 51 output tokens.*limit of 50/u,
    },
    {
      name: "estimated token overrun",
      response: assistant([{ type: "text", text: "x".repeat(101) }], { usage: usage(10, 0) }),
      error: /estimated 51 output tokens.*limit of 50/u,
    },
  ];

  for (const value of cases) {
    await assert.rejects(
      compact(
        preparation,
        model(),
        undefined,
        undefined,
        undefined,
        undefined,
        "off",
        streamResponses([value.response]),
      ),
      value.error,
      value.name,
    );
  }
});

test("split-turn prefix summaries enforce input ceilings before invoking custom streams", async () => {
  const calls: Array<{ model: Model; context: Context; options: SimpleStreamOptions }> = [];
  const preparation: CompactionPreparation = {
    firstKeptEntryId: "keep",
    messagesToSummarize: [],
    turnPrefixMessages: [{ role: "user", content: "large turn", timestamp: 1 }],
    isSplitTurn: true,
    tokensBefore: 1_000,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 100, recentTokens: 50 },
  };

  await assert.rejects(
    compact(
      preparation,
      model({ maxInputTokens: 64 }),
      undefined,
      undefined,
      undefined,
      undefined,
      "off",
      streamResponses([assistant([{ type: "text", text: "must not run" }])], calls),
    ),
    /Estimated prompt tokens .* exceed the model maximum input token limit \(64\)/u,
  );
  assert.equal(calls.length, 0);
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

  assert.equal(serializeConversation([
    {
      role: "user",
      content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
      timestamp: 1,
    },
    assistant([
      { type: "text", text: "first" },
      { type: "thinking", thinking: "plan one" },
      { type: "toolCall", id: "one", name: "read", arguments: { path: "/a" } },
      { type: "text", text: "second" },
      { type: "thinking", thinking: "plan two" },
      { type: "toolCall", id: "two", name: "write", arguments: { path: "/b" } },
    ]),
    {
      role: "toolResult",
      toolCallId: "one",
      toolName: "read",
      content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
      isError: false,
      timestamp: 1,
    },
  ]), [
    "[User]: firstsecond",
    "[Assistant thinking]: plan one\nplan two",
    "[Assistant]: first\nsecond",
    "[Assistant tool calls]: read(path=\"/a\"); write(path=\"/b\")",
    "[Tool result]: firstsecond",
  ].join("\n\n"));
});

test("conversation serialization rejects aggregate text before joining and truncates tool output incrementally", () => {
  const contentLimit = 8 * 1024 * 1024;
  const chunk = "x".repeat(3 * 1024 * 1024);
  const text = Array.from({ length: 3 }, () => ({ type: "text" as const, text: chunk }));
  const thinking = Array.from({ length: 3 }, () => ({ type: "thinking" as const, thinking: chunk }));
  const calls = Array.from({ length: 3 }, (_, index) => ({
    type: "toolCall" as const,
    id: `call-${index}`,
    name: chunk,
    arguments: {},
  }));
  const descriptor = Reflect.getOwnPropertyDescriptor(Array.prototype, "join")!;
  const original = descriptor.value as (this: unknown[], separator?: string) => string;
  let oversizedJoins = 0;
  Object.defineProperty(Array.prototype, "join", {
    ...descriptor,
    value(this: unknown[], separator?: string) {
      const joined = Reflect.apply(original, this, [separator]);
      if (joined.length > contentLimit) {
        oversizedJoins += 1;
        throw new Error("Oversized aggregate join executed");
      }
      return joined;
    },
  });
  try {
    for (const [name, messages] of [
      ["user", [{ role: "user" as const, content: text, timestamp: 1 }]],
      ["assistant text", [assistant(text)]],
      ["assistant thinking", [assistant(thinking)]],
      ["assistant calls", [assistant(calls)]],
    ] as const) {
      assert.throws(
        () => serializeConversation([...messages]),
        /Compaction conversation exceeds 8388608 aggregate UTF-8 bytes/u,
        name,
      );
    }

    const serialized = serializeConversation([{
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: text,
      isError: false,
      timestamp: 1,
    }]);
    assert.match(serialized, /\[\.\.\. 9435184 more characters truncated\]/u);
    assert.doesNotMatch(serialized, /x{2001}/u);
    assert.equal(oversizedJoins, 0);
  } finally {
    Object.defineProperty(Array.prototype, "join", descriptor);
  }
});

test("conversation serialization preserves the exact aggregate UTF-8 boundary", () => {
  const contentLimit = 8 * 1024 * 1024;
  const prefixBytes = Buffer.byteLength("[User]: ", "utf8");
  const exact = "é".repeat((contentLimit - prefixBytes) / 2);
  const serialized = serializeConversation([{ role: "user", content: exact, timestamp: 1 }]);
  assert.equal(Buffer.byteLength(serialized, "utf8"), contentLimit);
  assert.throws(
    () => serializeConversation([{ role: "user", content: `${exact}x`, timestamp: 1 }]),
    /Compaction conversation exceeds 8388608 aggregate UTF-8 bytes/u,
  );
});

test("conversation serialization rejects hostile and aggregate-oversized tool arguments before prompt construction", () => {
  let calls = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "path", {
    enumerable: true,
    get() {
      calls += 1;
      return "/hidden";
    },
  });
  assert.throws(
    () => serializeConversation([assistant([
      { type: "toolCall", id: "accessor", name: "read", arguments: accessor },
    ])]),
    /tool-call arguments.*plain JSON|data propert|serialized safely/u,
  );
  assert.equal(calls, 0);

  let traps = 0;
  const proxied = new Proxy({ path: "/hidden" }, {
    getPrototypeOf() {
      traps += 1;
      throw new Error("prototype trap executed");
    },
  });
  assert.throws(
    () => serializeConversation([assistant([
      { type: "toolCall", id: "proxy", name: "read", arguments: proxied },
    ])]),
    /tool-call arguments.*plain JSON|serialized safely|must not contain proxies/u,
  );
  assert.equal(traps, 0);

  const large = "x".repeat(3 * 1024 * 1024);
  assert.throws(
    () => serializeConversation([assistant([
      { type: "toolCall", id: "one", name: "read", arguments: { value: large } },
      { type: "toolCall", id: "two", name: "read", arguments: { value: large } },
      { type: "toolCall", id: "three", name: "read", arguments: { value: large } },
    ])]),
    /tool-call arguments.*aggregate|assistant content.*aggregate/u,
  );
});
