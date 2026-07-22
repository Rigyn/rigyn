import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentHarness,
  InMemorySessionStorage,
  JsonlSessionStorage,
  compact,
  prepareCompaction,
  type AgentMessage,
  type AssistantMessage,
  type CompactResult,
  type CompactionEntry,
  type CompactionPreparation,
  type CompactionResult,
  type Model,
  type Models,
  type SessionBeforeCompactResult,
  type SessionTreeEntry,
} from "../../src/index.js";
import { NodeExecutionEnv } from "../../src/node.js";
import { Session } from "../../src/harness/session/session.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test",
  provider: "test",
  baseUrl: "http://localhost.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (content: string, timestamp: number): AgentMessage => ({ role: "user", content, timestamp });
const assistant = (content: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text: content }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now() });
const models = {
  streamSimple() { throw new Error("Unexpected streaming request"); },
  async completeSimple() { return assistant("generated checkpoint"); },
} as unknown as Models;

test("public compaction types and generated results expose retained tails", async () => {
  const retainedTail = [user("recent", 2)];
  const entry: CompactionEntry = { type: "compaction", id: "compact", parentId: "old", timestamp: "2026-01-01T00:00:00.000Z", summary: "checkpoint", tokensBefore: 100, retainedTail };
  const compactResult: CompactResult = { summary: "checkpoint", tokensBefore: 100, retainedTail };
  const generatedResult: CompactionResult = { summary: "checkpoint", tokensBefore: 100, retainedTail };
  const hookResult: SessionBeforeCompactResult = { compaction: compactResult };
  const preparation: CompactionPreparation = {
    firstKeptEntryId: "recent",
    messagesToSummarize: [user("old", 1)],
    turnPrefixMessages: [],
    retainedTail,
    isSplitTurn: false,
    tokensBefore: 100,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
  };

  assert.deepEqual(entry.retainedTail, retainedTail);
  assert.deepEqual(generatedResult.retainedTail, retainedTail);
  assert.deepEqual(hookResult.compaction?.retainedTail, retainedTail);
  assert.deepEqual(preparation.retainedTail, retainedTail);

  const entries: SessionTreeEntry[] = [
    { type: "message", id: "old", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: user("x".repeat(100), 1) },
    { type: "message", id: "recent", parentId: "old", timestamp: "2026-01-01T00:00:01.000Z", message: retainedTail[0]! },
  ];
  const prepared = prepareCompaction(entries, { enabled: true, reserveTokens: 100, keepRecentTokens: 1 });
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.ok ? prepared.value?.retainedTail : undefined, retainedTail);
  assert.ok(prepared.ok && prepared.value);
  const generated = await compact(prepared.value, models, model);
  assert.equal(generated.ok, true);
  assert.deepEqual(generated.ok ? generated.value.retainedTail : undefined, retainedTail);
});

test("repeated compaction materializes the prior retained tail", async () => {
  const edited = {
    ...assistant("unused"),
    content: [{ type: "toolCall" as const, id: "edit-call", name: "edit", arguments: { path: "/work/retained.ts" } }],
    stopReason: "toolUse" as const,
  };
  const priorTail = [user("prior retained request", 1), edited];
  const after = user("new work", 2);
  const entries: SessionTreeEntry[] = [
    { type: "compaction", id: "first-checkpoint", parentId: "old", timestamp: "2026-01-01T00:00:00.000Z", summary: "first summary", tokensBefore: 100, retainedTail: priorTail },
    { type: "message", id: "after", parentId: "first-checkpoint", timestamp: "2026-01-01T00:00:01.000Z", message: after },
  ];

  const carry = prepareCompaction(entries, { enabled: true, reserveTokens: 100, keepRecentTokens: 10_000 });
  assert.ok(carry.ok && carry.value);
  assert.deepEqual(carry.value.retainedTail, [...priorTail, after]);

  const summarize = prepareCompaction(entries, { enabled: true, reserveTokens: 100, keepRecentTokens: 1 });
  assert.ok(summarize.ok && summarize.value);
  assert.deepEqual(summarize.value.messagesToSummarize, priorTail);
  assert.deepEqual(summarize.value.retainedTail, [after]);
  assert.equal(summarize.value.previousSummary, "first summary");
  assert.deepEqual([...summarize.value.fileOps.edited], ["/work/retained.ts"]);

  const generated = await compact(summarize.value, models, model);
  assert.ok(generated.ok);
  assert.deepEqual(generated.value.retainedTail, [after]);
  assert.deepEqual(generated.value.details, { readFiles: [], modifiedFiles: ["/work/retained.ts"] });
});

test("memory sessions stop at retained-tail checkpoints and preserve legacy ancestry", async () => {
  const storage = new InMemorySessionStorage();
  const session = new Session(storage);
  const oldId = await session.appendMessage(user("old", 1));
  const retained = user("kept", 2);
  const retainedId = await session.appendMessage(retained);
  const compactId = await session.appendCompaction("checkpoint", undefined, 100, undefined, false, undefined, [retained]);
  const afterId = await session.appendMessage(user("after", 3));

  assert.deepEqual((await storage.getPathToRoot(afterId)).map((entry) => entry.id), [oldId, retainedId, compactId, afterId]);
  assert.deepEqual((await storage.getPathToRootOrCompaction(afterId)).map((entry) => entry.id), [compactId, afterId]);
  assert.deepEqual((await session.getBranch()).map((entry) => entry.id), [compactId, afterId]);
  const context = await session.buildContext();
  assert.deepEqual(context.messages.map((message) => message.role), ["compactionSummary", "user", "user"]);
  assert.deepEqual(context.messages.slice(1), [retained, user("after", 3)]);

  const legacyStorage = new InMemorySessionStorage();
  const legacy = new Session(legacyStorage);
  await legacy.appendMessage(user("old", 1));
  const keptId = await legacy.appendMessage(user("legacy kept", 2));
  const legacyCompactId = await legacy.appendCompaction("legacy checkpoint", keptId, 100);
  const legacyAfterId = await legacy.appendMessage(user("legacy after", 3));
  assert.deepEqual((await legacyStorage.getPathToRootOrCompaction(legacyAfterId)).map((entry) => entry.id), [keptId, legacyCompactId, legacyAfterId]);
  assert.deepEqual((await legacy.buildContext()).messages.map((message) => message.role), ["compactionSummary", "user", "user"]);

  const emptyTailStorage = new InMemorySessionStorage({ entries: [
    { type: "message", id: "before", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: user("before", 1) },
    { type: "compaction", id: "empty", parentId: "before", timestamp: "2026-01-01T00:00:01.000Z", summary: "empty tail", tokensBefore: 10, retainedTail: [] },
    { type: "message", id: "after", parentId: "empty", timestamp: "2026-01-01T00:00:02.000Z", message: user("after", 2) },
  ] });
  assert.deepEqual((await emptyTailStorage.getPathToRootOrCompaction("after")).map((entry) => entry.id), ["empty", "after"]);
});

test("memory checkpoints preserve the nearest session state", async () => {
  const session = new Session(new InMemorySessionStorage());
  await session.appendThinkingLevelChange("low");
  await session.appendThinkingLevelChange("high");
  await session.appendModelChange("old-provider", "old-model");
  await session.appendModelChange("current-provider", "current-model");
  await session.appendActiveToolsChange(["old-tool"]);
  await session.appendActiveToolsChange(["read", "edit"]);
  const retained = user("kept", 1);
  await session.appendMessage(retained);
  await session.appendCompaction("checkpoint", undefined, 100, undefined, false, undefined, [retained]);
  await session.appendMessage(user("after", 2));

  assert.deepEqual((await session.getBranch()).map((entry) => entry.type), ["compaction", "message"]);
  const context = await session.buildContext();
  assert.equal(context.thinkingLevel, "high");
  assert.deepEqual(context.model, { provider: "current-provider", modelId: "current-model" });
  assert.deepEqual(context.activeToolNames, ["read", "edit"]);
});

test("JSONL sessions round-trip and reconstruct retained-tail checkpoints", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-retained-tail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = new NodeExecutionEnv({ cwd: root });
  const path = join(root, "session.jsonl");
  const storage = await JsonlSessionStorage.create(env, path, { cwd: root, sessionId: "session" });
  const session = new Session(storage);
  await session.appendMessage(user("old", 1));
  const retained = user("kept", 2);
  await session.appendMessage(retained);
  const compactId = await session.appendCompaction("checkpoint", undefined, 100, undefined, true, undefined, [retained]);
  const afterId = await session.appendMessage(user("after", 3));

  const reopenedStorage = await JsonlSessionStorage.open(env, path);
  const reopenedEntry = await reopenedStorage.getEntry(compactId);
  assert.equal(reopenedEntry?.type, "compaction");
  assert.deepEqual(reopenedEntry?.type === "compaction" ? reopenedEntry.retainedTail : undefined, [retained]);
  assert.deepEqual((await reopenedStorage.getPathToRootOrCompaction(afterId)).map((entry) => entry.id), [compactId, afterId]);
  const reopened = new Session(reopenedStorage);
  const context = await reopened.buildContext();
  assert.deepEqual(context.messages.map((message) => message.role), ["compactionSummary", "user", "user"]);
  assert.deepEqual(context.messages.slice(1), [retained, user("after", 3)]);
});

test("reopened JSONL checkpoints preserve the nearest session state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-retained-tail-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = new NodeExecutionEnv({ cwd: root });
  const path = join(root, "session.jsonl");
  const storage = await JsonlSessionStorage.create(env, path, { cwd: root, sessionId: "session" });
  const session = new Session(storage);
  await session.appendThinkingLevelChange("high");
  await session.appendModelChange("current-provider", "current-model");
  await session.appendActiveToolsChange(["read", "edit"]);
  const retained = user("kept", 1);
  await session.appendMessage(retained);
  await session.appendCompaction("checkpoint", undefined, 100, undefined, false, undefined, [retained]);
  await session.appendMessage(user("after", 2));

  const reopened = new Session(await JsonlSessionStorage.open(env, path));
  assert.deepEqual((await reopened.getBranch()).map((entry) => entry.type), ["compaction", "message"]);
  const context = await reopened.buildContext();
  assert.equal(context.thinkingLevel, "high");
  assert.deepEqual(context.model, { provider: "current-provider", modelId: "current-model" });
  assert.deepEqual(context.activeToolNames, ["read", "edit"]);
});

test("compaction hooks can persist a retained-tail checkpoint without an ancestry id", async () => {
  const session = new Session(new InMemorySessionStorage());
  await session.appendMessage(user("old", 1));
  const retained = user("hook retained", 2);
  const harness = new AgentHarness({ env: new NodeExecutionEnv({ cwd: process.cwd() }), session, models, model });
  harness.on("session_before_compact", ({ preparation }) => ({
    compaction: { summary: "hook checkpoint", tokensBefore: preparation.tokensBefore, retainedTail: [retained] },
  }));

  const result = await harness.compact();
  assert.equal(result.firstKeptEntryId, undefined);
  assert.deepEqual(result.retainedTail, [retained]);
  const entry = (await session.getEntries()).at(-1);
  assert.equal(entry?.type, "compaction");
  assert.equal(entry?.type === "compaction" ? entry.firstKeptEntryId : "present", undefined);
  assert.deepEqual(entry?.type === "compaction" ? entry.retainedTail : undefined, [retained]);
  assert.deepEqual((await session.buildContext()).messages.map((message) => message.role), ["compactionSummary", "user"]);
});
