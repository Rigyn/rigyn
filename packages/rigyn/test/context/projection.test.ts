import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import type { CanonicalMessage, ContentBlock, OpaqueBlock } from "../../src/core/types.js";
import {
  applyCompaction,
  buildContextProjection,
  compactionSummaryInput,
  compactWithSummarizer,
  elideOldToolResults,
  estimateContextTokenUsage,
  estimateMessageTokens,
  estimateTextTokens,
  groupContextMessages,
  selectCompaction,
  selectManualCompaction,
  type CompactionPlan,
} from "../../src/context/index.js";
import { toolResultText } from "../../src/providers/tool-results.js";

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

test("provider projection resolves normalized tool-call ID collision chains deterministically", () => {
  const projectionModule = new URL(
    "../../../kernel/src/runtime/context/projection.ts",
    import.meta.url,
  ).href;
  const probe = String.raw`
    const { projectMessagesForProvider } = await import(process.argv[1]);
    const createdAt = "2026-01-01T00:00:00.000Z";
    const messages = [
      { id: "user", role: "user", content: [{ type: "text", text: "inspect" }], createdAt },
      {
        id: "assistant",
        role: "assistant",
        provider: "openai",
        model: "gpt-source",
        api: "openai-responses",
        content: [
          { type: "tool_call", callId: "call-ok_1", name: "read", arguments: {} },
          { type: "tool_call", callId: "same!", name: "read", arguments: {} },
          { type: "tool_call", callId: "same@", name: "read", arguments: {} },
          { type: "tool_call", callId: "same#", name: "read", arguments: {} },
          { type: "tool_call", callId: "!!!", name: "read", arguments: {} },
        ],
        createdAt,
      },
      {
        id: "tool-results",
        role: "tool",
        content: ["call-ok_1", "same!", "same@", "same#", "!!!"].map((callId) => ({
          type: "tool_result",
          callId,
          name: "read",
          content: "ok",
          isError: false,
        })),
        createdAt,
      },
    ];
    const project = () => {
      const blocks = projectMessagesForProvider(messages, "anthropic", {
        model: "claude-destination",
        api: "anthropic-messages",
      }).flatMap((message) => message.content);
      return {
        calls: blocks.filter((block) => block.type === "tool_call").map((block) => block.callId),
        results: blocks.filter((block) => block.type === "tool_result").map((block) => block.callId),
      };
    };
    const first = project();
    const second = project();
    process.stdout.write(JSON.stringify({ first, second }));
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", probe, projectionModule],
    { encoding: "utf8", timeout: 2_000 },
  );

  assert.equal(result.error, undefined, result.error?.message ?? result.stderr);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as {
    first: { calls: string[]; results: string[] };
    second: { calls: string[]; results: string[] };
  };
  assert.deepEqual(output.first, output.second);
  assert.equal(output.first.calls[0], "call-ok_1");
  assert.deepEqual(output.first.results, output.first.calls);
  assert.equal(new Set(output.first.calls).size, output.first.calls.length);
  assert.ok(output.first.calls.every((id) => /^[A-Za-z0-9_-]+$/u.test(id) && id.length <= 64));
});

test("provider projection never exposes provider-trace reasoning across a signature boundary", () => {
  const assistant: CanonicalMessage = {
    ...message("assistant-reasoning", "assistant", [
      { type: "thinking", thinking: "hidden provider reasoning", visibility: "provider_trace" },
      { type: "thinking", thinking: "visible reasoning summary", visibility: "summary" },
      { type: "text", text: "answer" },
    ]),
    provider: "openai",
    model: "model-a",
    api: "openai-responses",
  };
  const messages = [textMessage("user", "user", "question"), assistant];

  const matching = buildContextProjection(messages, "openai", {
    model: "model-a",
    api: "openai-responses",
  });
  assert.strictEqual(matching.messages[1]?.content[0], assistant.content[0]);

  const changedModel = buildContextProjection(messages, "openai", {
    model: "model-b",
    api: "openai-responses",
  });
  assert.deepEqual(changedModel.messages[1]?.content, [
    { type: "text", text: "visible reasoning summary" },
    { type: "text", text: "answer" },
  ]);
  assert.equal(JSON.stringify(changedModel.messages).includes("hidden provider reasoning"), false);
  assert.strictEqual(assistant.content[0]?.type, "thinking");
  assert.equal(assistant.content[0]?.type === "thinking" ? assistant.content[0].thinking : "", "hidden provider reasoning");
});

test("provider projection rewrites invalidate a usage baseline even when message IDs stay unchanged", () => {
  const messages = [
    message("image-user", "user", [
      { type: "text", text: "inspect this" },
      { type: "image", mediaType: "image/png", data: "private-image" },
    ]),
  ];
  const usageBaseline = {
    provider: "openai" as const,
    model: "model-a",
    api: "openai-responses" as const,
    inputTokens: 50_000,
    prefixMessageIds: ["image-user"],
  };
  const unchanged = buildContextProjection(messages, "openai", {
    model: "model-a",
    api: "openai-responses",
    supportsImages: true,
    usageBaseline,
  });
  assert.equal(unchanged.estimateSource, "usage_baseline");
  assert.equal(unchanged.estimatedTokens, 50_000);

  const rewritten = buildContextProjection(messages, "openai", {
    model: "model-a",
    api: "openai-responses",
    supportsImages: false,
    usageBaseline,
  });
  assert.equal(rewritten.estimateSource, "estimated");
  assert.ok(rewritten.estimatedTokens < 50_000);
  assert.equal(rewritten.messages[0]?.content.some((block) => block.type === "image"), false);
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

test("normal compaction selection keeps full tool output and call/result structure", () => {
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
  const selection = selectCompaction(messages, {
    provider: "openai",
    maxTokens: 100_000,
    retainRecentTurns: 1,
    oldToolResultBytes: 100,
  });
  assert.equal(selection.kind, "not_needed");
  assert.equal(selection.kind === "not_needed" ? selection.reason : undefined, "within_threshold");
  const projectedOld = selection.kind === "not_needed" ? selection.projection.messages[2]?.content[0] : undefined;
  const projectedRecent = selection.kind === "not_needed" ? selection.projection.messages[5]?.content[0] : undefined;
  assert.equal(projectedOld?.type === "tool_result" ? projectedOld.content : undefined, oldResult);
  assert.equal(projectedOld?.type === "tool_result" ? projectedOld.images?.[0]?.data : undefined, "private-old-image");
  assert.equal(projectedRecent?.type === "tool_result" ? projectedRecent.content : undefined, recentResult);
  assert.deepEqual(
    selection.kind === "not_needed"
      ? selection.projection.groups.map((group) => group.pendingToolCallIds)
      : [],
    [[], []],
  );
});

test("explicit old-tool-result elision remains an isolated opt-in utility", () => {
  const richResult = {
    type: "tool_result" as const,
    callId: "rich",
    name: "shell",
    content: "private details ".repeat(200),
    isError: false,
    status: "warning" as const,
    summary: "private summary ".repeat(100),
    nextActions: Array.from({ length: 8 }, (_, index) => `private action ${index} `.repeat(80)),
    images: [{ type: "image" as const, mediaType: "image/png", data: "private-image" }],
  };
  const messages = [
    textMessage("u1", "user", "old"),
    message("a1", "assistant", [
      { type: "tool_call", callId: "rich", name: "shell", arguments: {} },
    ]),
    message("t1", "tool", [richResult]),
    textMessage("u2", "user", "recent"),
    textMessage("a2", "assistant", "answer"),
  ];
  const elided = elideOldToolResults(messages, { retainRecentTurns: 1, maxResultBytes: 160 });
  const old = elided[2]?.content[0];
  assert.equal(old?.type, "tool_result");
  if (old?.type === "tool_result") {
    assert.ok(Buffer.byteLength(toolResultText(old), "utf8") <= 160);
    assert.equal(old.status, undefined);
    assert.equal(old.summary, undefined);
    assert.equal(old.nextActions, undefined);
    assert.equal(old.images, undefined);
    assert.doesNotMatch(toolResultText(old), /private-image/u);
  }
  assert.deepEqual(messages[2]?.content[0], richResult);
});

test("tool-result estimates cover the exact provider-rendered text", () => {
  const richResult = {
    type: "tool_result" as const,
    callId: "rich",
    name: "shell",
    content: "private details ".repeat(200),
    isError: false,
    status: "warning" as const,
    summary: "private summary ".repeat(100),
    nextActions: Array.from({ length: 8 }, (_, index) => `private action ${index} `.repeat(80)),
    images: [{ type: "image" as const, mediaType: "image/png", data: "private-image" }],
  };
  const resultMessage = message("t1", "tool", [richResult]);
  const rendered = toolResultText(richResult);
  const expectedTextTokens = estimateTextTokens(richResult.name) + estimateTextTokens(rendered) + 8;
  assert.ok(estimateMessageTokens(resultMessage) >= expectedTextTokens);
});

test("normal provider projection keeps full tool results and a matching usage baseline", () => {
  const messages = [
    textMessage("u1", "user", "old"),
    message("a1", "assistant", [
      { type: "tool_call", callId: "old", name: "read", arguments: {} },
    ]),
    message("t1", "tool", [
      { type: "tool_result", callId: "old", name: "read", content: "x".repeat(20_000), isError: false },
    ]),
    textMessage("u2", "user", "recent"),
    textMessage("a2", "assistant", "answer"),
  ];
  const usageBaseline = {
    provider: "openai" as const,
    model: "model-a",
    api: "openai-responses" as const,
    inputTokens: 60_000,
    prefixMessageIds: messages.map((entry) => entry.id),
  };
  assert.equal(
    estimateContextTokenUsage(messages, {
      provider: "openai",
      model: "model-a",
      api: "openai-responses",
      usageBaseline,
    }).source,
    "usage_baseline",
  );

  const selected = selectCompaction(messages, {
    provider: "openai",
    model: "model-a",
    api: "openai-responses",
    maxTokens: 100_000,
    retainRecentTurns: 1,
    oldToolResultBytes: 160,
    usageBaseline,
  });
  assert.equal(selected.kind, "not_needed");
  assert.equal(selected.kind === "not_needed" ? selected.reason : undefined, "within_threshold");
  assert.equal(selected.kind === "not_needed" ? selected.projection.estimateSource : undefined, "usage_baseline");
  assert.equal(selected.kind === "not_needed" ? selected.projection.estimatedTokens : undefined, 60_000);
  const projectedResult = selected.kind === "not_needed"
    ? selected.projection.messages[2]?.content[0]
    : undefined;
  assert.equal(projectedResult?.type === "tool_result" ? projectedResult.content.length : 0, 20_000);
});

test("validated provider usage prevents conservative fallback estimates from triggering early compaction", () => {
  const messages = [
    textMessage("compressed-user", "user", "u".repeat(250_000)),
    textMessage("compressed-assistant", "assistant", "a".repeat(250_000)),
    textMessage("trailing-user", "user", "continue"),
  ];
  const triggerTokens = Math.floor(272_000 * 0.88);
  const fallback = estimateContextTokenUsage(messages, {
    provider: "openai",
    model: "gpt-test",
    additionalTokens: 3_000,
  });
  assert.equal(fallback.tokens, 253_040);
  assert.ok(fallback.tokens > triggerTokens);

  const selection = selectCompaction(messages, {
    provider: "openai",
    model: "gpt-test",
    maxTokens: 272_000,
    triggerTokens,
    additionalTokens: 3_000,
    usageBaseline: {
      provider: "openai",
      model: "gpt-test",
      inputTokens: 98_000,
      prefixMessageIds: ["compressed-user", "compressed-assistant"],
    },
  });

  assert.equal(selection.kind, "not_needed");
  assert.equal(
    selection.kind === "not_needed" ? selection.projection.estimatedTokens : undefined,
    98_000 + estimateMessageTokens(messages[2]!, "openai"),
  );
  assert.equal(selection.kind === "not_needed" ? selection.projection.estimateSource : undefined, "usage_baseline");
});

test("zero observed summary output does not suppress the conservative content estimate", () => {
  const summary: CanonicalMessage = {
    ...textMessage("zero-summary-usage", "user", `[Compacted session history]\n${"x".repeat(4_000)}`),
    purpose: "compaction",
    usage: { outputTokens: 0, totalTokens: 0 },
  };
  assert.ok(estimateMessageTokens(summary, "openai") > 2_000);
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
  const targetTokens = projection.estimatedTokens - first.estimatedTokens - second.estimatedTokens + maxSummaryTokens;
  const recentTokens = projection.groups[3]!.estimatedTokens + projection.groups[4]!.estimatedTokens;
  const selection = selectManualCompaction(messages, {
    provider: "openai",
    maxTokens: 5_000,
    reserveTokens: 1,
    maxSummaryTokens,
    recentTokens,
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
  assert.ok(compacted.estimatedTokens <= targetTokens);
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
  const selection = selectManualCompaction(messages, {
    provider: "openai",
    maxTokens: 5_000,
    reserveTokens: 1,
    maxSummaryTokens: 160,
    recentTokens: projection.groups[3]!.estimatedTokens + projection.groups[4]!.estimatedTokens,
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

test("compaction summary input excludes provider-trace reasoning but keeps visible summaries", () => {
  const source = message("assistant-reasoning", "assistant", [
    { type: "thinking", thinking: "hidden provider reasoning", visibility: "provider_trace" },
    { type: "thinking", thinking: "visible reasoning summary", visibility: "summary" },
    { type: "thinking", thinking: "redacted reasoning summary", visibility: "summary", redacted: true },
    { type: "text", text: "answer" },
  ]);
  const plan: CompactionPlan = {
    kind: "compact",
    provider: "openai",
    maxTokens: 100_000,
    maxInputTokens: 82_000,
    targetTokens: 80_000,
    maxSummaryTokens: 4_000,
    recentTokens: 24_000,
    reserveTokens: 18_000,
    additionalTokens: 0,
    summaryToolResultCharacters: 2_000,
    estimatedTokensBefore: 90_000,
    estimatedTokensAfterUpperBound: 24_000,
    reason: "manual",
    splitTurn: false,
    leadingMessages: [],
    sourceMessages: [source],
    trailingMessages: [],
    sourceMessageIds: [source.id],
  };

  const input = compactionSummaryInput(plan);
  assert.deepEqual(input[0]?.content, [
    { type: "thinking", thinking: "visible reasoning summary", visibility: "summary" },
    { type: "text", text: "answer" },
  ]);
  assert.equal(JSON.stringify(input).includes("hidden provider reasoning"), false);
  assert.equal(JSON.stringify(input).includes("redacted reasoning summary"), false);
  assert.equal(JSON.stringify(plan.sourceMessages).includes("hidden provider reasoning"), true);
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
    recentTokens: opaqueProjection.groups.at(-1)!.estimatedTokens,
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
    recentTokens: pendingProjection.groups.at(-1)!.estimatedTokens,
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
