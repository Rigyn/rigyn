import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalMessage, ContentBlock } from "../../src/core/types.js";
import {
  applyCompaction,
  buildContextProjection,
  compactWithSummarizer,
  groupContextMessages,
  selectCompaction,
  selectManualCompaction,
  selectOverflowCompaction,
  type CompactionPlan,
} from "../../src/context/index.js";

const createdAt = "2026-01-01T00:00:00.000Z";

function message(id: string, role: CanonicalMessage["role"], content: ContentBlock[]): CanonicalMessage {
  return { id, role, content, createdAt };
}

function textMessage(id: string, role: CanonicalMessage["role"], text: string): CanonicalMessage {
  return message(id, role, [{ type: "text", text }]);
}

function fourTurns(size = 400): CanonicalMessage[] {
  return Array.from({ length: 4 }, (_, index) => [
    textMessage(`u${index}`, "user", `question ${index} ${"q".repeat(size)}`),
    textMessage(`a${index}`, "assistant", `answer ${index} ${"a".repeat(size)}`),
  ]).flat();
}

test("default compaction reserves 16384 tokens and keeps about 20000 recent tokens", () => {
  const messages = [
    ...fourTurns(5_000),
    textMessage("u4", "user", `question 4 ${"q".repeat(5_000)}`),
    textMessage("a4", "assistant", `answer 4 ${"a".repeat(5_000)}`),
  ];
  const selection = selectManualCompaction(messages, {
    provider: "openai",
    maxTokens: 128_000,
    triggerTokens: 111_616,
  });
  assert.equal(selection.kind, "compact");
  if (selection.kind !== "compact") return;
  assert.equal(selection.reserveTokens, 16_384);
  assert.equal(selection.keepRecentTokens, 20_000);
  assert.equal(selection.maxSummaryTokens, 13_107);
  const retained = buildContextProjection(selection.trailingMessages, "openai").estimatedTokens;
  assert.ok(retained >= 20_000);
  assert.ok(retained < 25_200);
});

test("the safety threshold compacts before the hard input limit", () => {
  const messages = fourTurns();
  const projection = buildContextProjection(messages, "openai");
  const total = projection.estimatedTokens;
  const selection = selectCompaction(messages, {
    provider: "openai",
    maxTokens: total + 100,
    triggerTokens: total - 500,
    maxSummaryTokens: 80,
    keepRecentTokens: projection.groups.at(-1)!.estimatedTokens,
  });
  assert.equal(selection.kind, "compact");
  if (selection.kind === "compact") {
    assert.equal(selection.reason, "threshold");
    assert.equal(selection.splitTurn, false);
    assert.ok(selection.estimatedTokensAfterUpperBound <= selection.targetTokens);
  }
});

test("threshold pressure defers rather than failing while still below the hard limit", () => {
  const messages = [
    textMessage("u1", "user", "q".repeat(700)),
    textMessage("a1", "assistant", "a".repeat(700)),
  ];
  const total = buildContextProjection(messages, "openai").estimatedTokens;
  const selection = selectCompaction(messages, {
    provider: "openai",
    maxTokens: total + 50,
    triggerTokens: total - 50,
    maxSummaryTokens: 80,
    keepRecentTokens: total,
  });
  assert.equal(selection.kind, "deferred");
  if (selection.kind === "deferred") {
    assert.equal(selection.reason, "nothing_to_compact");
    assert.equal(selection.overflow, false);
  }
});

test("hard overflow splits an oversized turn only at a tool-safe boundary", () => {
  const messages = [
    textMessage("u1", "user", "q".repeat(700)),
    textMessage("a1", "assistant", "a".repeat(700)),
    message("a-tool", "assistant", [
      { type: "tool_call", callId: "call-1", name: "read", arguments: { path: "file.ts" } },
    ]),
    message("t1", "tool", [
      { type: "tool_result", callId: "call-1", name: "read", content: "result", isError: false },
    ]),
    textMessage("a2", "assistant", "done".repeat(200)),
  ];
  const total = buildContextProjection(messages, "openai").estimatedTokens;
  const selection = selectCompaction(messages, {
    provider: "openai",
    maxTokens: total - 300,
    triggerTokens: total - 350,
    maxSummaryTokens: 80,
    keepRecentTokens: 300,
  });
  assert.equal(selection.kind, "compact");
  if (selection.kind !== "compact") return;
  assert.equal(selection.reason, "overflow");
  assert.equal(selection.splitTurn, true);
  assert.doesNotThrow(() => groupContextMessages(selection.sourceMessages));
  const summary = textMessage("summary", "user", "earlier work");
  const compacted = applyCompaction(selection, { sourceMessageIds: selection.sourceMessageIds, message: summary });
  assert.doesNotThrow(() => groupContextMessages(compacted.messages));
  const calls = compacted.messages.flatMap((entry) => entry.content).filter((block) => block.type === "tool_call");
  const results = compacted.messages.flatMap((entry) => entry.content).filter((block) => block.type === "tool_result");
  assert.equal(calls.length, results.length);
});

test("an unsplittable oversized message has a stable hard-overflow outcome", () => {
  const messages = [textMessage("u1", "user", "x".repeat(5_000))];
  const options = {
    provider: "openai" as const,
    maxTokens: 1_000,
    triggerTokens: 900,
    maxSummaryTokens: 100,
    keepRecentTokens: 1,
  };
  const first = selectCompaction(messages, options);
  const second = selectCompaction(messages, options);
  assert.deepEqual(second, first);
  assert.equal(first.kind, "cannot_compact");
  if (first.kind === "cannot_compact") {
    assert.equal(first.reason, "unsplittable_turn");
    assert.equal(first.overflow, true);
  }
});

test("system-only overflow is distinguished from turn overflow", () => {
  const selection = selectCompaction(
    [textMessage("system", "system", "rules".repeat(1_000))],
    { provider: "anthropic", maxTokens: 500, triggerTokens: 450, maxSummaryTokens: 50 },
  );
  assert.equal(selection.kind, "cannot_compact");
  if (selection.kind === "cannot_compact") assert.equal(selection.reason, "system_overflow");
});

test("manual planning reuses the safe planner below the automatic threshold", () => {
  const messages = fourTurns(100);
  const projection = buildContextProjection(messages, "openai");
  const total = projection.estimatedTokens;
  const selection = selectManualCompaction(messages, {
    provider: "openai",
    maxTokens: total + 1_000,
    maxSummaryTokens: 40,
    keepRecentTokens: projection.groups.at(-1)!.estimatedTokens,
  });
  assert.equal(selection.kind, "compact");
  if (selection.kind === "compact") {
    assert.equal(selection.reason, "manual");
    assert.deepEqual(selection.sourceMessageIds, ["u0", "a0", "u1", "a1", "u2", "a2"]);
    assert.deepEqual(selection.trailingMessages.slice(-2).map((entry) => entry.id), ["u3", "a3"]);
  }
});

test("a typed provider overflow can force one deterministic reduction below estimates", () => {
  const messages = fourTurns(100);
  const projection = buildContextProjection(messages, "openai");
  const total = projection.estimatedTokens;
  const options = {
    provider: "openai" as const,
    maxTokens: total + 1_000,
    triggerTokens: total + 500,
    maxSummaryTokens: 40,
    keepRecentTokens: projection.groups.at(-1)!.estimatedTokens,
  };
  const first = selectOverflowCompaction(messages, options);
  const second = selectOverflowCompaction(messages, options);
  assert.deepEqual(second, first);
  assert.equal(first.kind, "compact");
  if (first.kind === "compact") assert.equal(first.reason, "overflow");
});

test("a previous durable summary is supplied separately for iterative compaction", async () => {
  const previous = {
    ...textMessage("previous-summary", "user", `previous ${"p".repeat(500)}`),
    purpose: "compaction" as const,
  };
  const messages = [
    textMessage("system", "system", "rules"),
    previous,
    textMessage("a-old", "assistant", "old continuation".repeat(30)),
    textMessage("u2", "user", "new work".repeat(30)),
    textMessage("a2", "assistant", "new result".repeat(30)),
    textMessage("u3", "user", "recent"),
    textMessage("a3", "assistant", "recent answer"),
  ];
  const projection = buildContextProjection(messages, "openai");
  const total = projection.estimatedTokens;
  const selection = selectManualCompaction(messages, {
    provider: "openai",
    maxTokens: total + 1_000,
    maxSummaryTokens: 60,
    keepRecentTokens: projection.groups.at(-1)!.estimatedTokens,
  });
  assert.equal(selection.kind, "compact");
  if (selection.kind !== "compact") return;
  assert.strictEqual(selection.previousSummary, previous);
  assert.ok(selection.sourceMessageIds.includes(previous.id));
  assert.equal(selection.sourceMessages.some((entry) => entry.id === previous.id), false);

  let observedPrevious: CanonicalMessage | undefined;
  await compactWithSummarizer(
    selection,
    {
      async summarize(request) {
        observedPrevious = request.previousSummary;
        return {
          sourceMessageIds: [...request.sourceMessageIds],
          message: { ...textMessage("next-summary", "user", "updated summary"), purpose: "compaction" },
        };
      },
    },
    new AbortController().signal,
  );
  assert.strictEqual(observedPrevious, previous);
});

test("automatic compaction does not mutate or pre-elide old tool results", () => {
  const messages = [
    textMessage("u1", "user", "old"),
    message("a1", "assistant", [{ type: "tool_call", callId: "old", name: "shell", arguments: {} }]),
    message("t1", "tool", [{
      type: "tool_result",
      callId: "old",
      name: "shell",
      content: "x".repeat(20_000),
      isError: false,
    }]),
    textMessage("u2", "user", "recent"),
    textMessage("a2", "assistant", "answer"),
  ];
  const projection = buildContextProjection(messages, "openai");
  const full = projection.estimatedTokens;
  const selection = selectCompaction(messages, {
    provider: "openai",
    maxTokens: full + 100,
    triggerTokens: full - 2_000,
    maxSummaryTokens: 100,
    keepRecentTokens: projection.groups.at(-1)!.estimatedTokens,
  });
  assert.equal(selection.kind, "compact");
  if (selection.kind === "compact") {
    const result = selection.sourceMessages.flatMap((entry) => entry.content).find((block) => block.type === "tool_result");
    assert.equal(result?.type, "tool_result");
    assert.equal(result?.type === "tool_result" ? result.content.length : 0, 20_000);
  }
  assert.equal(
    messages.flatMap((entry) => entry.content).find((block) => block.type === "tool_result")?.type,
    "tool_result",
  );
});

test("manual application preserves raw message objects outside the derived result", () => {
  const messages = fourTurns(100);
  const original = structuredClone(messages);
  const projection = buildContextProjection(messages, "openai");
  const total = projection.estimatedTokens;
  const selection = selectManualCompaction(messages, {
    provider: "openai",
    maxTokens: total + 1_000,
    maxSummaryTokens: 40,
    keepRecentTokens: projection.groups.at(-1)!.estimatedTokens,
  });
  assert.equal(selection.kind, "compact");
  if (selection.kind !== "compact") return;
  applyCompaction(selection as CompactionPlan, {
    sourceMessageIds: selection.sourceMessageIds,
    message: textMessage("summary", "user", "summary"),
  });
  assert.deepEqual(messages, original);
});
