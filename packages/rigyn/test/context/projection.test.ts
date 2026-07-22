import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalMessage, ContentBlock, OpaqueBlock } from "../../src/core/types.js";
import {
  applyCompaction,
  buildContextProjection,
  compactWithSummarizer,
  elideOldToolResults,
  estimateMessageTokens,
  groupContextMessages,
  selectCompaction,
  type CompactionPlan,
} from "../../src/context/index.js";

const timestamp = "2026-01-01T00:00:00.000Z";

function message(
  id: string,
  role: CanonicalMessage["role"],
  content: ContentBlock[],
): CanonicalMessage {
  return { id, role, content, createdAt: timestamp };
}

function textMessage(id: string, role: CanonicalMessage["role"], text: string): CanonicalMessage {
  return message(id, role, [{ type: "text", text }]);
}

test("provider projection preserves source opaque blocks exactly and removes incompatible state", () => {
  const opaque: OpaqueBlock = {
    type: "provider_opaque",
    provider: "openai",
    mediaType: "application/json",
    value: { signature: "opaque-value", nested: [1, 2] },
  };
  const messages = [
    textMessage("user", "user", "question"),
    message("assistant", "assistant", [{ type: "text", text: "answer" }, opaque]),
  ];
  const openai = buildContextProjection(messages, "openai");
  assert.strictEqual(openai.messages[1]?.content[1], opaque);
  assert.equal(openai.groups[0]?.containsProviderOpaque, true);

  const anthropic = buildContextProjection(messages, "anthropic");
  assert.deepEqual(anthropic.messages[1]?.content, [{ type: "text", text: "answer" }]);
  assert.equal(anthropic.groups[0]?.containsProviderOpaque, false);
});

test("provider projection replays opaque state only for the exact provider, API, and model", () => {
  const opaque: OpaqueBlock = {
    type: "provider_opaque",
    provider: "openai",
    mediaType: "application/json",
    value: { encrypted: "state" },
  };
  const assistant: CanonicalMessage = {
    ...message("assistant-state", "assistant", [{ type: "text", text: "answer" }, opaque]),
    provider: "openai",
    model: "model-a",
    api: "openai-responses",
  };
  const messages = [textMessage("user", "user", "question"), assistant];

  assert.strictEqual(
    buildContextProjection(messages, "openai", { model: "model-a", api: "openai-responses" }).messages[1]?.content[1],
    opaque,
  );
  assert.deepEqual(
    buildContextProjection(messages, "openai", { model: "model-b", api: "openai-responses" }).messages[1]?.content,
    [{ type: "text", text: "answer" }],
  );
  assert.deepEqual(
    buildContextProjection(messages, "openai", { model: "model-a", api: "openai-chat-completions" }).messages[1]?.content,
    [{ type: "text", text: "answer" }],
  );
});

test("failed assistant attempts are omitted without deriving results for their partial tool calls", () => {
  const messages: CanonicalMessage[] = [
    textMessage("u1", "user", "inspect the valid file"),
    {
      ...message("a-valid", "assistant", [
        { type: "text", text: "I will inspect it." },
        { type: "tool_call", callId: "valid-call", name: "read", arguments: { path: "valid.ts" } },
      ]),
      stopReason: "tool_calls",
    },
    message("t-valid", "tool", [
      { type: "tool_result", callId: "valid-call", name: "read", content: "valid contents", isError: false },
    ]),
    textMessage("u2", "user", "try the next operation"),
    {
      ...message("a-error", "assistant", [
        { type: "text", text: "partial failed answer" },
        {
          type: "provider_opaque",
          provider: "openai",
          mediaType: "application/json",
          value: { reasoning: "partial failed reasoning" },
        },
        { type: "tool_call", callId: "failed-call", name: "bash", arguments: { command: "false" } },
      ]),
      stopReason: "error",
      errorMessage: "provider failed",
    },
    textMessage("u3", "user", "continue after the failure"),
    {
      ...message("a-aborted", "assistant", [
        { type: "text", text: "partial aborted answer" },
        { type: "tool_call", callId: "aborted-call", name: "find", arguments: { pattern: "unfinished" } },
      ]),
      stopReason: "aborted",
      errorMessage: "interrupted",
    },
    message("t-aborted", "tool", [
      { type: "tool_result", callId: "aborted-call", name: "find", content: "partial result", isError: true },
    ]),
    textMessage("u4", "user", "final request"),
  ];

  const projected = buildContextProjection(messages, "openai").messages;

  assert.deepEqual(projected.map((entry) => entry.id), ["u1", "a-valid", "t-valid", "u2", "u3", "u4"]);
  assert.equal(projected.flatMap((entry) => entry.content).some(
    (block) => block.type === "tool_call" && ["failed-call", "aborted-call"].includes(block.callId),
  ), false);
  assert.equal(projected.flatMap((entry) => entry.content).some(
    (block) => block.type === "tool_result" && ["failed-call", "aborted-call"].includes(block.callId),
  ), false);
  assert.equal(projected.flatMap((entry) => entry.content).some(
    (block) => block.type === "tool_result" && block.content === "No result provided",
  ), false);
  assert.equal(projected.flatMap((entry) => entry.content).some(
    (block) => block.type === "text" && block.text.includes("partial"),
  ), false);
  assert.deepEqual(messages.map((entry) => entry.id), [
    "u1", "a-valid", "t-valid", "u2", "a-error", "u3", "a-aborted", "t-aborted", "u4",
  ]);
});

test("tool calls and results remain in one complete turn and malformed groups fail", () => {
  const messages = [
    textMessage("u1", "user", "inspect"),
    message("a1", "assistant", [
      { type: "tool_call", callId: "call_1", name: "read", arguments: { path: "a" } },
    ]),
    message("t1", "tool", [
      { type: "tool_result", callId: "call_1", name: "read", content: "data", isError: false },
    ]),
    textMessage("a2", "assistant", "done"),
    textMessage("u2", "user", "next"),
  ];
  const groups = groupContextMessages(messages);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0]?.messageIds, ["u1", "a1", "t1", "a2"]);
  assert.deepEqual(groups[0]?.pendingToolCallIds, []);
  assert.throws(
    () =>
      groupContextMessages([
        textMessage("u", "user", "bad"),
        message("t", "tool", [
          { type: "tool_result", callId: "missing", name: "read", content: "x", isError: true },
        ]),
      ]),
    /has no call in its turn/,
  );
});

test("old tool output is bounded without dropping call/result structure or recent turns", () => {
  const oldResult = "a".repeat(2_000);
  const recentResult = "b".repeat(2_000);
  const messages = [
    textMessage("u1", "user", "old"),
    message("a1", "assistant", [
      { type: "tool_call", callId: "old", name: "shell", arguments: {} },
    ]),
    message("t1", "tool", [
      {
        type: "tool_result",
        callId: "old",
        name: "shell",
        content: oldResult,
        isError: false,
        images: [{ type: "image", mediaType: "image/png", data: "private-old-image" }],
      },
    ]),
    textMessage("u2", "user", "recent"),
    message("a2", "assistant", [
      { type: "tool_call", callId: "recent", name: "shell", arguments: {} },
    ]),
    message("t2", "tool", [
      { type: "tool_result", callId: "recent", name: "shell", content: recentResult, isError: false },
    ]),
  ];
  const elided = elideOldToolResults(messages, { retainRecentTurns: 1, maxResultBytes: 100 });
  const old = elided[2]?.content[0];
  const recent = elided[5]?.content[0];
  assert.equal(old?.type, "tool_result");
  assert.match(old?.type === "tool_result" ? old.content : "", /bytes omitted/);
  assert.ok(Buffer.byteLength(old?.type === "tool_result" ? old.content : "", "utf8") <= 100);
  assert.equal(old?.type === "tool_result" ? old.callId : "", "old");
  assert.equal(old?.type === "tool_result" ? old.images : undefined, undefined);
  assert.doesNotMatch(old?.type === "tool_result" ? old.content : "", /private-old-image/u);
  assert.equal(recent?.type === "tool_result" ? recent.content : "", recentResult);
  assert.deepEqual(groupContextMessages(elided).map((group) => group.pendingToolCallIds), [[], []]);
});

function compactionFixture(): CanonicalMessage[] {
  return [
    textMessage("system", "system", "system rules"),
    textMessage("u1", "user", `first ${"a".repeat(700)}`),
    message("a1", "assistant", [
      { type: "tool_call", callId: "tool1", name: "read", arguments: { path: "a" } },
    ]),
    message("t1", "tool", [
      { type: "tool_result", callId: "tool1", name: "read", content: "r".repeat(700), isError: false },
    ]),
    textMessage("a1done", "assistant", "first complete"),
    textMessage("u2", "user", `second ${"b".repeat(700)}`),
    textMessage("a2", "assistant", `answer ${"c".repeat(700)}`),
    textMessage("u3", "user", `third ${"d".repeat(500)}`),
    textMessage("a3", "assistant", `answer ${"e".repeat(500)}`),
    textMessage("u4", "user", `recent ${"f".repeat(500)}`),
    textMessage("a4", "assistant", `answer ${"g".repeat(500)}`),
  ];
}

test("compaction selects only complete old groups and applies a source-bound summary", async () => {
  const messages = compactionFixture();
  const projection = buildContextProjection(messages, "openai");
  const first = projection.groups[1]!;
  const second = projection.groups[2]!;
  const maxSummaryTokens = 160;
  const maxTokens = projection.estimatedTokens - first.estimatedTokens - second.estimatedTokens + maxSummaryTokens;
  const keepRecentTokens = projection.groups[3]!.estimatedTokens + projection.groups[4]!.estimatedTokens;
  const selection = selectCompaction(messages, {
    provider: "openai",
    maxTokens,
    maxSummaryTokens,
    keepRecentTokens,
  });
  assert.equal(selection.kind, "compact");
  const plan = selection as CompactionPlan;
  assert.deepEqual(plan.sourceMessageIds, [...first.messageIds, ...second.messageIds]);
  assert.deepEqual(plan.trailingMessages.map((item) => item.id), ["u3", "a3", "u4", "a4"]);

  const summaryMessage = textMessage("summary", "user", "Earlier work inspected a file and completed two turns.");
  assert.ok(estimateMessageTokens(summaryMessage) <= maxSummaryTokens);
  const compacted = applyCompaction(plan, {
    sourceMessageIds: plan.sourceMessageIds,
    message: summaryMessage,
  });
  assert.ok(compacted.estimatedTokens <= maxTokens);
  assert.deepEqual(compacted.messages.map((item) => item.id), [
    "system",
    "summary",
    "u3",
    "a3",
    "u4",
    "a4",
  ]);

  let observedIds: readonly string[] = [];
  const throughInterface = await compactWithSummarizer(
    plan,
    {
      async summarize(request) {
        observedIds = request.sourceMessageIds;
        return { sourceMessageIds: [...request.sourceMessageIds], message: summaryMessage };
      },
    },
    new AbortController().signal,
  );
  assert.deepEqual(observedIds, plan.sourceMessageIds);
  assert.deepEqual(throughInterface.messages.map((item) => item.id), compacted.messages.map((item) => item.id));
});

test("summary contracts reject wrong sources, reused IDs, oversized output, and unsafe blocks", () => {
  const messages = compactionFixture();
  const projection = buildContextProjection(messages, "openai");
  const maxTokens = projection.estimatedTokens - projection.groups[1]!.estimatedTokens - projection.groups[2]!.estimatedTokens + 160;
  const selection = selectCompaction(messages, {
    provider: "openai",
    maxTokens,
    maxSummaryTokens: 160,
    keepRecentTokens: projection.groups[3]!.estimatedTokens + projection.groups[4]!.estimatedTokens,
  });
  assert.equal(selection.kind, "compact");
  const plan = selection as CompactionPlan;
  assert.throws(
    () => applyCompaction(plan, { sourceMessageIds: [], message: textMessage("summary", "user", "ok") }),
    /source IDs/,
  );
  assert.throws(
    () =>
      applyCompaction(plan, {
        sourceMessageIds: plan.sourceMessageIds,
        message: textMessage(plan.sourceMessageIds[0]!, "user", "ok"),
      }),
    /must be new/,
  );
  assert.throws(
    () =>
      applyCompaction(plan, {
        sourceMessageIds: plan.sourceMessageIds,
        message: textMessage("huge", "user", "x".repeat(2_000)),
      }),
    /token contract/,
  );
  assert.throws(
    () =>
      applyCompaction(plan, {
        sourceMessageIds: plan.sourceMessageIds,
        message: message("unsafe", "user", [
          { type: "tool_call", callId: "x", name: "shell", arguments: {} },
        ]),
      }),
    /user text message/,
  );
});

test("old opaque state is stripped and abandoned tool calls receive derived error results", () => {
  const opaque: OpaqueBlock = {
    type: "provider_opaque",
    provider: "openai",
    mediaType: "application/json",
    value: { state: "keep" },
  };
  const opaqueMessages = [
    textMessage("system", "system", "rules"),
    textMessage("u1", "user", "x".repeat(1_000)),
    message("a1", "assistant", [{ type: "text", text: "y".repeat(1_000) }, opaque]),
    textMessage("u2", "user", "recent"),
    textMessage("a2", "assistant", "answer"),
  ];
  const opaqueProjection = buildContextProjection(opaqueMessages, "openai");
  const opaqueSelection = selectCompaction(opaqueMessages, {
    provider: "openai",
    maxTokens: Math.max(1, opaqueProjection.estimatedTokens - 100),
    maxSummaryTokens: 80,
    keepRecentTokens: opaqueProjection.groups.at(-1)!.estimatedTokens,
  });
  assert.equal(opaqueSelection.kind, "compact");
  if (opaqueSelection.kind === "compact") {
    assert.equal(
      opaqueSelection.sourceMessages.some((entry) => entry.content.some((block) => block.type === "provider_opaque")),
      false,
    );
    assert.equal(opaqueMessages[1]?.content.includes(opaque), false);
    assert.equal(opaqueMessages[2]?.content.includes(opaque), true);
  }

  const pendingMessages = [
    textMessage("system", "system", "rules"),
    textMessage("u1", "user", "x".repeat(1_000)),
    message("a1", "assistant", [
      { type: "tool_call", callId: "pending", name: "shell", arguments: {} },
    ]),
    textMessage("u2", "user", "recent"),
    textMessage("a2", "assistant", "answer"),
  ];
  const pendingProjection = buildContextProjection(pendingMessages, "openai");
  assert.deepEqual(pendingProjection.messages.map((entry) => entry.role), [
    "system",
    "user",
    "assistant",
    "tool",
    "user",
    "assistant",
  ]);
  assert.deepEqual(pendingProjection.messages[2]?.content, pendingMessages[2]?.content);
  assert.deepEqual(pendingProjection.messages[3]?.content, [{
    type: "tool_result",
    callId: "pending",
    name: "shell",
    content: "No result provided",
    isError: true,
  }]);
  assert.equal(pendingMessages.length, 5);
  const pendingSelection = selectCompaction(pendingMessages, {
    provider: "openai",
    maxTokens: Math.max(1, pendingProjection.estimatedTokens - 100),
    maxSummaryTokens: 80,
    keepRecentTokens: pendingProjection.groups.at(-1)!.estimatedTokens,
  });
  assert.equal(pendingSelection.kind, "compact");
});

test("provider projection fills each missing result at an assistant, user, or history boundary", () => {
  const interrupted = [
    textMessage("u1", "user", "first"),
    message("a1", "assistant", [
      { type: "tool_call", callId: "one", name: "read", arguments: { path: "a" } },
      { type: "tool_call", callId: "two", name: "read", arguments: { path: "b" } },
    ]),
    message("t1", "tool", [
      { type: "tool_result", callId: "one", name: "read", content: "a", isError: false },
    ]),
    textMessage("u2", "user", "continue"),
    message("a2", "assistant", [
      { type: "tool_call", callId: "three", name: "bash", arguments: { command: "pwd" } },
    ]),
    textMessage("a3", "assistant", "working"),
    message("a4", "assistant", [
      { type: "tool_call", callId: "four", name: "find", arguments: { pattern: "x" } },
    ]),
  ];

  const projected = buildContextProjection(interrupted, "openai").messages;
  const blocks = projected.flatMap((entry) => entry.content);
  const results = blocks.filter((block) => block.type === "tool_result");
  assert.deepEqual(results.map((block) => [block.callId, block.name, block.content, block.isError]), [
    ["one", "read", "a", false],
    ["two", "read", "No result provided", true],
    ["three", "bash", "No result provided", true],
    ["four", "find", "No result provided", true],
  ]);
  assert.deepEqual(projected.map((entry) => entry.role), [
    "user",
    "assistant",
    "tool",
    "tool",
    "user",
    "assistant",
    "tool",
    "assistant",
    "assistant",
    "tool",
  ]);
  assert.equal(groupContextMessages(projected).every((group) => group.pendingToolCallIds.length === 0), true);
});

test("tool-call IDs are normalized only when history crosses a model boundary", () => {
  const foreignCall = "call with spaces|item/with+symbols";
  const history: CanonicalMessage[] = [
    textMessage("u1", "user", "inspect"),
    {
      ...message("a1", "assistant", [
        { type: "tool_call", callId: foreignCall, name: "read", arguments: { path: "a" } },
      ]),
      provider: "openai",
      model: "source-model",
      api: "openai-responses",
    },
    message("t1", "tool", [
      { type: "tool_result", callId: foreignCall, name: "read", content: "ok", isError: false },
    ]),
  ];

  const same = buildContextProjection(history, "openai", {
    model: "source-model",
    api: "openai-responses",
  }).messages;
  const sameCall = same[1]?.content[0];
  const sameResult = same[2]?.content[0];
  assert.equal(sameCall?.type === "tool_call" ? sameCall.callId : undefined, foreignCall);
  assert.equal(sameResult?.type === "tool_result" ? sameResult.callId : undefined, foreignCall);

  const crossed = buildContextProjection(history, "anthropic", {
    model: "target-model",
    api: "anthropic-messages",
  }).messages;
  const crossedCall = crossed[1]?.content[0];
  const crossedResult = crossed[2]?.content[0];
  const normalized = crossedCall?.type === "tool_call" ? crossedCall.callId : undefined;
  assert.equal(normalized, "call_with_spaces_item_with_symbols");
  assert.equal(crossedResult?.type === "tool_result" ? crossedResult.callId : undefined, normalized);
});
