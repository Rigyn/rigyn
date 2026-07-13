import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AdapterEvent,
  CanonicalMessage,
  FinishReason,
  ModelInfo,
  ProviderAdapter,
  ProviderRequest,
} from "../../src/core/types.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import {
  BRANCH_SUMMARY_LIMITS,
  HarnessService,
  cloneSessionPath,
  generateBranchSummary,
  importThreadJsonl,
  prepareAbandonedBranch,
  StoredConversation,
} from "../../src/service/index.js";
import { SessionStore } from "../../src/storage/store.js";

class SummaryProvider implements ProviderAdapter {
  readonly id = "summary-provider";
  readonly requests: ProviderRequest[] = [];
  readonly #output: string;
  readonly #failure: boolean;
  readonly #reason: FinishReason;

  constructor(output: string, failure = false, reason: FinishReason = "stop") {
    this.#output = output;
    this.#failure = failure;
    this.#reason = reason;
  }

  async *stream(request: ProviderRequest, _signal: AbortSignal): AsyncIterable<AdapterEvent> {
    this.requests.push(request);
    yield { type: "response_start", model: request.model };
    if (this.#failure) {
      yield {
        type: "error",
        error: {
          category: "provider",
          message: "offline summary failure",
          retryable: false,
          partial: false,
        },
      };
      return;
    }
    yield { type: "text_delta", part: 0, text: this.#output };
    yield {
      type: "response_end",
      reason: this.#reason,
      state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: this.#output } },
    };
  }

  async listModels(_signal: AbortSignal): Promise<ModelInfo[]> {
    return [];
  }
}

class CatalogSummaryProvider extends SummaryProvider {
  override async listModels(_signal: AbortSignal): Promise<ModelInfo[]> {
    const unknown = { value: "unknown" as const, source: "provider" as const, observedAt: "2026-01-01T00:00:00.000Z" };
    return [{
      id: "offline-model",
      provider: this.id,
      maxOutputTokens: 64,
      capabilities: { tools: unknown, reasoning: unknown, images: unknown },
    }];
  }
}

class EventSummaryProvider implements ProviderAdapter {
  readonly id = "summary-provider";
  readonly requests: ProviderRequest[] = [];
  readonly #events: readonly AdapterEvent[];

  constructor(events: readonly AdapterEvent[]) {
    this.#events = events;
  }

  async *stream(request: ProviderRequest, _signal: AbortSignal): AsyncIterable<AdapterEvent> {
    this.requests.push(request);
    for (const event of this.#events) yield event;
  }

  async listModels(_signal: AbortSignal): Promise<ModelInfo[]> {
    return [];
  }
}

class GatedSummaryProvider implements ProviderAdapter {
  readonly id = "summary-provider";
  readonly requests: ProviderRequest[] = [];
  readonly ready: Promise<void>;
  readonly #readyResolve: () => void;

  constructor() {
    let readyResolve: () => void = () => {};
    this.ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    this.#readyResolve = readyResolve;
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    this.requests.push(request);
    yield { type: "response_start", model: request.model };
    this.#readyResolve();
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }

  async listModels(_signal: AbortSignal): Promise<ModelInfo[]> {
    return [];
  }
}

class NonCooperativeSummaryProvider implements ProviderAdapter {
  readonly id = "summary-provider";
  readonly ready: Promise<void>;
  readonly #readyResolve: () => void;
  returnCalls = 0;

  constructor() {
    let readyResolve: () => void = () => {};
    this.ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    this.#readyResolve = readyResolve;
  }

  stream(): AsyncIterable<AdapterEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          this.#readyResolve();
          return new Promise<IteratorResult<AdapterEvent>>(() => {});
        },
        return: async () => {
          this.returnCalls += 1;
          return { done: true, value: undefined };
        },
      }),
    };
  }

  async listModels(): Promise<ModelInfo[]> { return []; }
}

function message(id: string, role: "user" | "assistant", text: string): CanonicalMessage {
  return {
    id: `message-${id}`,
    role,
    content: [{ type: "text", text }],
    createdAt: "2026-07-10T00:00:00.000Z",
  };
}

function appendMessage(
  store: SessionStore,
  threadId: string,
  branch: string,
  id: string,
  role: "user" | "assistant",
  text: string,
) {
  return store.appendEvent({
    threadId,
    branch,
    eventId: `event-${id}`,
    event: { type: "message_appended", message: message(id, role, text) },
  });
}

async function fixture(provider: ProviderAdapter) {
  const root = await mkdtemp(join(tmpdir(), "harness-branch-summary-"));
  const database = join(root, "sessions.sqlite");
  const store = new SessionStore(database);
  const thread = store.createThread({ threadId: "thread-tree", workspaceRoot: root });
  const common = appendMessage(store, thread.threadId, "main", "common", "user", "COMMON CONTEXT");
  const abandoned = appendMessage(store, thread.threadId, "main", "abandoned", "assistant", "MAIN ONLY DECISION");
  store.forkBranch({ threadId: thread.threadId, fromBranch: "main", newBranch: "sibling", atEventId: common.eventId });
  const target = appendMessage(store, thread.threadId, "sibling", "target", "assistant", "TARGET ONLY CONTEXT");
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    projectTrusted: false,
  });
  await service.initialize();
  return { root, database, store, service, thread, common, abandoned, target };
}

test("accepted branch summarization targets the selected branch and survives restart", async (t) => {
  const provider = new SummaryProvider("Preserve the main-only decision for later.");
  const value = await fixture(provider);
  t.after(async () => await rm(value.root, { recursive: true, force: true }));

  const result = await value.service.navigateTree({
    threadId: value.thread.threadId,
    branch: "main",
    targetBranch: "sibling",
    targetEventId: value.target.eventId,
    newBranch: "tree-summary",
    summarize: true,
    provider: provider.id,
    model: "offline-model",
    summaryTokenBudget: 321,
    summaryInstructions: "Retain exact branch decisions.",
    label: "abandoned context",
  });

  assert.equal(result.cancelled, false);
  assert.equal(result.summaryEvent?.parentEventId, value.target.eventId);
  assert.deepEqual(result.summaryEvent?.event.sourceEventIds, [value.abandoned.eventId]);
  assert.equal(result.summaryEvent?.event.sourceBranch, "main");
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0]?.maxOutputTokens, 321);
  assert.deepEqual(provider.requests[0]?.tools, []);
  const requestText = provider.requests[0]?.messages.flatMap((entry) => entry.content)
    .flatMap((block) => block.type === "text" ? [block.text] : []).join("\n") ?? "";
  assert.match(requestText, /MAIN ONLY DECISION/u);
  assert.match(requestText, /Retain exact branch decisions/u);
  assert.doesNotMatch(requestText, /TARGET ONLY CONTEXT/u);
  assert.equal(value.store.listEntryLabels(value.thread.threadId)[0]?.targetEventId, result.summaryEvent?.eventId);
  assert.equal(value.store.listEntryLabels(value.thread.threadId)[0]?.label, "abandoned context");
  assert.equal(value.store.listBranches(value.thread.threadId).find((entry) => entry.name === "main")?.headEventId, value.abandoned.eventId);
  const branchEvents = value.store.listEvents(value.thread.threadId, "tree-summary");
  assert.deepEqual(branchEvents.map((entry) => entry.event.type), [
    "message_appended",
    "message_appended",
    "branch_summary_created",
    "entry_label_changed",
  ]);
  const context = await new StoredConversation(value.store).loadContext(
    value.thread.threadId,
    "tree-summary",
    provider.id,
    new AbortController().signal,
  );
  assert.equal(context.messages.filter((entry) => entry.id === result.summaryEvent?.event.summary.id).length, 1);

  await value.service.close();
  value.store.close();
  const reopened = new SessionStore(value.database);
  const resumed = await new StoredConversation(reopened).loadContext(
    value.thread.threadId,
    "tree-summary",
    provider.id,
    new AbortController().signal,
  );
  assert.equal(resumed.messages.filter((entry) => entry.id === result.summaryEvent?.event.summary.id).length, 1);
  const resumedSummary = resumed.messages.at(-1)?.content[0];
  assert.match(resumedSummary?.type === "text" ? resumedSummary.text : "", /main-only decision/iu);

  const imported = importThreadJsonl(reopened, reopened.exportThread(value.thread.threadId), { workspaceRoot: value.root });
  const importedSummary = reopened.listEvents(imported.thread.threadId, "tree-summary")
    .find((entry) => entry.event.type === "branch_summary_created");
  assert.equal(importedSummary?.event.type, "branch_summary_created");
  if (importedSummary?.event.type === "branch_summary_created") {
    const importedMainIds = new Set(reopened.listEvents(imported.thread.threadId, "main").map((entry) => entry.eventId));
    assert.equal(importedSummary.event.sourceEventIds.every((eventId) => importedMainIds.has(eventId)), true);
    assert.equal(importedSummary.event.sourceEventIds.includes(value.abandoned.eventId), false);
  }

  const cloned = cloneSessionPath(reopened, {
    threadId: value.thread.threadId,
    branch: "tree-summary",
    workspaceRoot: value.root,
  });
  const clonedEvents = reopened.listEvents(cloned.thread.threadId);
  assert.equal(clonedEvents.some((entry) => entry.event.type === "branch_summary_created"), false);
  assert.equal(clonedEvents.filter((entry) =>
    entry.event.type === "message_appended" && entry.event.message.id === result.summaryEvent?.event.summary.id).length, 1);
  reopened.close();
});

test("branch summarization caps its explicit output budget to catalog model metadata", async (t) => {
  const provider = new CatalogSummaryProvider("Preserve the bounded decision.");
  const value = await fixture(provider);
  t.after(async () => await rm(value.root, { recursive: true, force: true }));

  const result = await value.service.navigateTree({
    threadId: value.thread.threadId,
    branch: "main",
    targetBranch: "sibling",
    targetEventId: value.target.eventId,
    newBranch: "tree-bounded-summary",
    summarize: true,
    provider: provider.id,
    model: "offline-model",
    summaryTokenBudget: 321,
  });

  assert.equal(result.cancelled, false);
  assert.equal(provider.requests[0]?.maxOutputTokens, 64);
  await value.service.close();
  value.store.close();
});

test("branch summary input uses non-secret image markers while canonical branch events retain sources", async () => {
  const store = new SessionStore(":memory:");
  const thread = store.createThread({ threadId: "thread-image-summary" });
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=";
  const url = "https://images.example.test/branch-summary-source.jpg";
  store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "message_appended",
      message: {
        id: "branch-image-message",
        role: "user",
        content: [
          { type: "text", text: "preserve the visual conclusion" },
          { type: "image", mediaType: "image/png", data },
          { type: "image", mediaType: "image/jpeg", url },
        ],
        createdAt: "2026-07-10T00:00:00.000Z",
      },
    },
  });
  const preparation = prepareAbandonedBranch(store.listEvents(thread.threadId), [], null);
  const provider = new SummaryProvider("visual conclusion retained");
  const generated = await generateBranchSummary(preparation, {
    provider,
    model: "offline-model",
    signal: new AbortController().signal,
  });
  assert.equal(generated.cancelled, false);
  const wire = JSON.stringify(provider.requests);
  assert.doesNotMatch(wire, /iVBORw0KGgoAAAANSUhEUg|branch-summary-source/u);
  assert.match(wire, /image omitted/u);
  assert.match(JSON.stringify(store.listEvents(thread.threadId)), /iVBORw0KGgoAAAANSUhEUg|branch-summary-source/u);
  store.close();
});

test("decline, provider failure, and cancellation leave existing branches unchanged", async (t) => {
  const declinedProvider = new SummaryProvider("unused");
  const declined = await fixture(declinedProvider);
  t.after(async () => await rm(declined.root, { recursive: true, force: true }));
  await assert.rejects(declined.service.navigateTree({
    threadId: declined.thread.threadId,
    branch: "main",
    targetBranch: "sibling",
    targetEventId: declined.target.eventId,
    newBranch: "tree-invalid-budget",
    summarize: true,
    provider: declinedProvider.id,
    model: "offline-model",
    summaryTokenBudget: 0,
  }), /output tokens must be from 1/u);
  assert.equal(declined.store.listBranches(declined.thread.threadId).some((entry) => entry.name === "tree-invalid-budget"), false);
  const declineResult = await declined.service.navigateTree({
    threadId: declined.thread.threadId,
    branch: "main",
    targetBranch: "sibling",
    targetEventId: declined.target.eventId,
    newBranch: "tree-no-summary",
    summarize: false,
  });
  assert.equal(declineResult.cancelled, false);
  assert.equal(declineResult.branch?.headEventId, declined.target.eventId);
  assert.equal(declinedProvider.requests.length, 0);
  assert.equal(declined.store.listEvents(declined.thread.threadId, "tree-no-summary").some((entry) => entry.event.type === "branch_summary_created"), false);
  await declined.service.close();
  declined.store.close();

  const failedProvider = new SummaryProvider("unused", true);
  const failed = await fixture(failedProvider);
  t.after(async () => await rm(failed.root, { recursive: true, force: true }));
  const branchesBeforeFailure = failed.store.listBranches(failed.thread.threadId).map((entry) => entry.name);
  await assert.rejects(failed.service.navigateTree({
    threadId: failed.thread.threadId,
    branch: "main",
    targetBranch: "sibling",
    targetEventId: failed.target.eventId,
    newBranch: "tree-failed",
    summarize: true,
    provider: failedProvider.id,
    model: "offline-model",
  }), /offline summary failure/u);
  assert.deepEqual(failed.store.listBranches(failed.thread.threadId).map((entry) => entry.name), branchesBeforeFailure);
  await failed.service.close();
  failed.store.close();

  const gatedProvider = new GatedSummaryProvider();
  const cancelled = await fixture(gatedProvider);
  t.after(async () => await rm(cancelled.root, { recursive: true, force: true }));
  const navigation = cancelled.service.navigateTree({
    threadId: cancelled.thread.threadId,
    branch: "main",
    targetBranch: "sibling",
    targetEventId: cancelled.target.eventId,
    newBranch: "tree-cancelled",
    summarize: true,
    provider: gatedProvider.id,
    model: "offline-model",
  });
  await gatedProvider.ready;
  cancelled.service.cancel(cancelled.thread.threadId, "cancel branch summary");
  assert.deepEqual(await navigation, { cancelled: true });
  assert.equal(cancelled.store.listBranches(cancelled.thread.threadId).some((entry) => entry.name === "tree-cancelled"), false);
  assert.doesNotThrow(() => cancelled.store.forkBranch({
    threadId: cancelled.thread.threadId,
    fromBranch: "sibling",
    newBranch: "after-cancel",
    atEventId: cancelled.target.eventId,
  }));
  await cancelled.service.close();
  cancelled.store.close();
});

test("branch-summary cancellation settles when a third-party provider ignores its signal", async (t) => {
  const provider = new NonCooperativeSummaryProvider();
  const value = await fixture(provider);
  t.after(async () => await rm(value.root, { recursive: true, force: true }));
  const navigation = value.service.navigateTree({
    threadId: value.thread.threadId,
    branch: "main",
    targetBranch: "sibling",
    targetEventId: value.target.eventId,
    newBranch: "tree-non-cooperative",
    summarize: true,
    provider: provider.id,
    model: "offline-model",
  });
  await provider.ready;
  value.service.cancel(value.thread.threadId, "cancel branch summary");
  const result = await Promise.race([
    navigation,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("branch cancellation did not settle")), 500)),
  ]);
  assert.deepEqual(result, { cancelled: true });
  assert.equal(provider.returnCalls, 1);
  assert.equal(value.store.listBranches(value.thread.threadId).some((entry) => entry.name === "tree-non-cooperative"), false);
  await value.service.close();
  value.store.close();
});

test("branch summaries reject every non-stop terminal outcome without persisting partial output", async (t) => {
  const reasons = [
    "length",
    "context_limit",
    "content_filter",
    "refusal",
    "pause",
    "cancelled",
    "error",
    "incomplete",
    "unknown",
    "tool_calls",
  ] as const satisfies readonly Exclude<FinishReason, "stop">[];

  for (const reason of reasons) {
    const provider = new SummaryProvider(`partial summary from ${reason}`, false, reason);
    const value = await fixture(provider);
    t.after(async () => await rm(value.root, { recursive: true, force: true }));
    const branch = `tree-${reason.replaceAll("_", "-")}`;

    await assert.rejects(value.service.navigateTree({
      threadId: value.thread.threadId,
      branch: "main",
      targetBranch: "sibling",
      targetEventId: value.target.eventId,
      newBranch: branch,
      summarize: true,
      provider: provider.id,
      model: "offline-model",
    }), new RegExp(`Branch summary ended with ${reason}`, "u"));

    assert.equal(value.store.listBranches(value.thread.threadId).some((entry) => entry.name === branch), false);
    assert.equal(value.store.listEvents(value.thread.threadId).some((entry) =>
      entry.event.type === "branch_summary_created" &&
      entry.event.summary.content.some((block) => block.type === "text" && block.text.includes(`partial summary from ${reason}`))), false);
    await value.service.close();
    value.store.close();
  }
});

test("branch summary tool-call attempts and empty streams cannot create a summarized branch", async (t) => {
  const cases = [
    {
      name: "tool-call",
      provider: new EventSummaryProvider([
        { type: "response_start", model: "offline-model" },
        { type: "text_delta", part: 0, text: "partial note before tool" },
        { type: "tool_call_start", index: 0, id: "call-summary", name: "read" },
      ]),
      error: /attempted a tool call/u,
    },
    {
      name: "empty-stream",
      provider: new EventSummaryProvider([]),
      error: /without a non-empty completed note/u,
    },
    {
      name: "empty-note",
      provider: new SummaryProvider(""),
      error: /without a non-empty completed note/u,
    },
  ] as const;

  for (const valueCase of cases) {
    const value = await fixture(valueCase.provider);
    t.after(async () => await rm(value.root, { recursive: true, force: true }));
    const branch = `tree-${valueCase.name}`;

    await assert.rejects(value.service.navigateTree({
      threadId: value.thread.threadId,
      branch: "main",
      targetBranch: "sibling",
      targetEventId: value.target.eventId,
      newBranch: branch,
      summarize: true,
      provider: valueCase.provider.id,
      model: "offline-model",
    }), valueCase.error);

    assert.equal(value.store.listBranches(value.thread.threadId).some((entry) => entry.name === branch), false);
    assert.equal(value.store.listEvents(value.thread.threadId).some((entry) => entry.event.type === "branch_summary_created"), false);
    await value.service.close();
    value.store.close();
  }
});

test("branch summary context and durable source references are bounded and transactional", () => {
  const store = new SessionStore(":memory:");
  store.createThread({ threadId: "bounded" });
  const root = appendMessage(store, "bounded", "main", "bounded-root", "user", "root");
  for (let index = 0; index < 100; index += 1) {
    appendMessage(store, "bounded", "main", `bounded-${index}`, "user", `${index === 0 ? "OLDEST MARKER " : ""}${"x".repeat(20_000)}`);
  }
  const source = store.listEvents("bounded", "main");
  const preparation = prepareAbandonedBranch(source, source, root.eventId);
  assert.ok(preparation.contextBytes <= BRANCH_SUMMARY_LIMITS.maxContextBytes);
  assert.ok(preparation.contextTokens <= BRANCH_SUMMARY_LIMITS.maxContextTokens);
  assert.ok(preparation.messages.length < 100);
  assert.equal(preparation.messages.some((entry) => entry.text.includes("OLDEST MARKER")), false);

  store.createThread({ threadId: "foreign" });
  const foreign = appendMessage(store, "foreign", "main", "foreign", "user", "foreign");
  const summary = message("bounded-summary", "user", "bounded summary");
  summary.purpose = "compaction";
  assert.throws(() => store.forkBranchWithSummary({
    threadId: "bounded",
    fromBranch: "main",
    newBranch: "invalid-summary",
    atEventId: root.eventId,
    summary,
    sourceBranch: "main",
    sourceEventIds: [foreign.eventId],
  }), /not reachable/u);
  assert.equal(store.listBranches("bounded").some((entry) => entry.name === "invalid-summary"), false);

  store.close();
});
