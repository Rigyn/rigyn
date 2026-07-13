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

test("old opaque state and abandoned tool calls are stripped from summary input", () => {
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
  assert.equal(
    pendingProjection.messages.some((entry) => entry.content.some((block) => block.type === "tool_call")),
    false,
  );
  const pendingSelection = selectCompaction(pendingMessages, {
    provider: "openai",
    maxTokens: Math.max(1, pendingProjection.estimatedTokens - 100),
    maxSummaryTokens: 80,
    keepRecentTokens: pendingProjection.groups.at(-1)!.estimatedTokens,
  });
  assert.equal(pendingSelection.kind, "compact");
});
