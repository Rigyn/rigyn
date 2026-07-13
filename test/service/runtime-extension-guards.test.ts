import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntimeExtensions } from "../../src/extensions/runtime.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { ScriptedProvider, type ScriptedProviderStep } from "../../src/testing/scripted-provider.js";
import { sha256 } from "../../src/tools/hash.js";

const extensionSource = `export default (api) => {
  api.on("session_before_switch", (event) => {
    globalThis.__runtimeGuardEvents.push(["switch", event.reason, event.targetThreadId]);
    return globalThis.__runtimeCancelSwitch ? { cancel: true, reason: "stay put" } : undefined;
  });
  api.on("session_before_fork", (event) => {
    globalThis.__runtimeGuardEvents.push(["fork", event.sourceThreadId, event.targetBranch]);
    return globalThis.__runtimeCancelFork ? { cancel: true, reason: "do not fork" } : undefined;
  });
  api.on("session_before_tree", (event) => {
    globalThis.__runtimeGuardEvents.push(["tree-before", event.targetEventId, event.sourceEventIds.length]);
    if (globalThis.__runtimeCancelTree) return { cancel: true, reason: "stay on branch" };
    return globalThis.__runtimeTreeSummary === undefined ? undefined : { summary: { text: globalThis.__runtimeTreeSummary, metadata: { source: "tree-extension" } } };
  });
  api.on("session_tree", (event) => {
    globalThis.__runtimeGuardEvents.push(["tree-after", event.currentEventId, event.fromExtension]);
  });
  api.on("session_before_compact", (event) => {
    globalThis.__runtimeGuardEvents.push(["compact-before", event.plan.reason, event.plan.sourceMessageIds.length]);
    if (globalThis.__runtimeCancelCompact) return { cancel: true, reason: "keep history" };
    return { compaction: { text: "extension compact summary", metadata: { source: "compact-extension" } } };
  });
  api.on("session_compact", (event) => {
    globalThis.__runtimeGuardEvents.push(["compact-after", event.reason, event.fromExtension, event.willRetry]);
  });
};\n`;

interface Fixture {
  root: string;
  host: Awaited<ReturnType<typeof loadRuntimeExtensions>>;
  provider: ScriptedProvider;
  store: SessionStore;
  service: HarnessService;
}

async function fixture(
  t: { after(callback: () => Promise<void>): void },
  scripts: readonly ScriptedProviderStep[] = [],
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-guards-"));
  const sourcePath = join(root, "guards.mjs");
  await writeFile(sourcePath, extensionSource);
  const host = await loadRuntimeExtensions([{
    extensionId: "guards",
    sourcePath,
    sha256: sha256(extensionSource),
  }], { workspace: root });
  assert.deepEqual(host.diagnostics(), []);
  const provider = new ScriptedProvider({
    scripts,
    models: [{ id: "scripted-model", contextTokens: 100_000 }],
  });
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    runtimeExtensions: host,
    projectTrusted: false,
  });
  await service.initialize();
  t.after(async () => {
    await service.close();
    store.close();
    await host.close();
  });
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return { root, host, provider, store, service };
}

function globals(): Record<string, unknown> {
  const state = globalThis as Record<string, unknown>;
  state.__runtimeGuardEvents = [];
  state.__runtimeCancelSwitch = false;
  state.__runtimeCancelFork = false;
  state.__runtimeCancelTree = false;
  state.__runtimeCancelCompact = false;
  delete state.__runtimeTreeSummary;
  return state;
}

function cleanupGlobals(): void {
  const state = globalThis as Record<string, unknown>;
  for (const key of [
    "__runtimeGuardEvents",
    "__runtimeCancelSwitch",
    "__runtimeCancelFork",
    "__runtimeCancelTree",
    "__runtimeCancelCompact",
    "__runtimeTreeSummary",
  ]) delete state[key];
}

test("session switch and fork guards cancel before any thread mutation", async (t) => {
  const state = globals();
  t.after(async () => cleanupGlobals());
  const value = await fixture(t);

  state.__runtimeCancelSwitch = true;
  await assert.rejects(value.service.createSession(), /stay put/u);
  assert.equal(value.store.listThreads().length, 0);

  state.__runtimeCancelSwitch = false;
  const parent = await value.service.createSession({ name: "parent" });
  assert.equal(value.store.listThreads().length, 1);

  state.__runtimeCancelFork = true;
  await assert.rejects(value.service.createSession({ parentThreadId: parent.threadId }), /do not fork/u);
  assert.equal(value.store.listThreads().length, 1);

  state.__runtimeCancelFork = false;
  const child = await value.service.createSession({ parentThreadId: parent.threadId, defaultBranch: "child" });
  assert.equal(child.parentThreadId, parent.threadId);
  assert.equal(value.store.listThreads().length, 2);
  assert.deepEqual(state.__runtimeGuardEvents, [
    ["switch", "new", undefined],
    ["switch", "new", undefined],
    ["fork", parent.threadId, "main"],
    ["fork", parent.threadId, "child"],
  ]);
});

test("tree guards cancel transactionally and custom summaries are bounded, redacted, and observed after commit", async (t) => {
  const state = globals();
  t.after(async () => cleanupGlobals());
  const value = await fixture(t);
  const thread = value.store.createThread({ threadId: "tree-thread", workspaceRoot: value.root });
  const common = value.store.appendEvent({
    threadId: thread.threadId,
    branch: "main",
    eventId: "tree-common",
    event: {
      type: "message_appended",
      message: { id: "tree-common-message", role: "user", content: [{ type: "text", text: "common" }], createdAt: "2026-07-10T00:00:00.000Z" },
    },
  });
  value.store.appendEvent({
    threadId: thread.threadId,
    branch: "main",
    eventId: "tree-abandoned",
    event: {
      type: "message_appended",
      message: { id: "tree-abandoned-message", role: "assistant", content: [{ type: "text", text: "abandoned" }], createdAt: "2026-07-10T00:00:01.000Z" },
    },
  });
  value.store.forkBranch({ threadId: thread.threadId, fromBranch: "main", newBranch: "target", atEventId: common.eventId });
  const target = value.store.appendEvent({
    threadId: thread.threadId,
    branch: "target",
    eventId: "tree-target",
    event: {
      type: "message_appended",
      message: { id: "tree-target-message", role: "assistant", content: [{ type: "text", text: "target" }], createdAt: "2026-07-10T00:00:02.000Z" },
    },
  });

  state.__runtimeCancelTree = true;
  const cancelled = await value.service.navigateTree({
    threadId: thread.threadId,
    branch: "main",
    targetBranch: "target",
    targetEventId: target.eventId,
    newBranch: "cancelled-tree",
    summarize: false,
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(value.store.listBranches(thread.threadId).some((entry) => entry.name === "cancelled-tree"), false);

  state.__runtimeCancelTree = false;
  const fixtureSecret = ["sk", "proj", "ABCDEFGHIJKLMNOPQRST"].join("-");
  state.__runtimeTreeSummary = `custom tree summary ${fixtureSecret}`;
  const completed = await value.service.navigateTree({
    threadId: thread.threadId,
    branch: "main",
    targetBranch: "target",
    targetEventId: target.eventId,
    newBranch: "custom-tree",
    summarize: true,
    provider: value.provider.id,
    model: "scripted-model",
  });
  assert.equal(completed.cancelled, false);
  assert.equal(value.provider.callCount, 0);
  assert.match(JSON.stringify(completed.summaryEvent), /custom tree summary \[REDACTED\]/u);
  assert.deepEqual(completed.summaryEvent?.event.extensionMetadata, { source: "tree-extension" });
  assert.doesNotMatch(JSON.stringify(value.store.listEvents(thread.threadId, "custom-tree")), /sk-proj-/u);
  assert.deepEqual((state.__runtimeGuardEvents as unknown[][]).at(-1), [
    "tree-after",
    completed.summaryEvent?.eventId,
    true,
  ]);

  state.__runtimeTreeSummary = "x".repeat(70_000);
  await assert.rejects(value.service.navigateTree({
    threadId: thread.threadId,
    branch: "main",
    targetBranch: "target",
    targetEventId: target.eventId,
    newBranch: "oversized-tree",
    summarize: true,
    provider: value.provider.id,
    model: "scripted-model",
  }), /must be non-empty and fit/u);
  assert.equal(value.store.listBranches(thread.threadId).some((entry) => entry.name === "oversized-tree"), false);
});

test("compaction guards cancel before persistence and custom summaries bypass the provider then emit after commit", async (t) => {
  const state = globals();
  t.after(async () => cleanupGlobals());
  const long = "context ".repeat(220);
  const value = await fixture(t, Array.from({ length: 4 }, (): ScriptedProviderStep => ({
    kind: "turn",
    content: [{ type: "text", text: `answer ${long}` }],
  })));
  const allowedTools = ["read", "write", "edit", "bash"];
  let threadId: string | undefined;
  for (const label of ["one", "two", "three", "four"]) {
    const run = await value.service.run({
      ...(threadId === undefined ? {} : { threadId }),
      prompt: `${label} ${long}`,
      provider: value.provider.id,
      model: "scripted-model",
      allowedTools,
    });
    threadId = run.threadId;
  }
  assert.ok(threadId);

  state.__runtimeCancelCompact = true;
  await assert.rejects(value.service.compact({
    threadId,
    provider: value.provider.id,
    model: "scripted-model",
    contextTokenBudget: 8_000,
    summaryTokenBudget: 64,
    allowedTools,
  }), /keep history/u);
  assert.equal(value.store.listEvents(threadId).some((entry) => entry.event.type === "compaction_completed"), false);

  state.__runtimeCancelCompact = false;
  const compacted = await value.service.compact({
    threadId,
    provider: value.provider.id,
    model: "scripted-model",
    contextTokenBudget: 8_000,
    summaryTokenBudget: 64,
    allowedTools,
  });
  assert.match(compacted.finalText, /^Compacted \d+ messages into msg_/u);
  assert.equal(value.provider.callCount, 4);
  const event = value.store.listEvents(threadId).findLast((entry) => entry.event.type === "compaction_completed");
  assert.match(event?.event.type === "compaction_completed" ? JSON.stringify(event.event.summary) : "", /extension compact summary/u);
  assert.deepEqual(event?.event.type === "compaction_completed" ? event.event.extensionMetadata : undefined, { source: "compact-extension" });
  assert.deepEqual((state.__runtimeGuardEvents as unknown[][]).at(-1), ["compact-after", "manual", true, false]);
});
