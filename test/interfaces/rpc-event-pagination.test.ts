import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { EventEnvelope } from "../../src/core/events.js";
import type { AdapterEvent, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import {
  RPC_EVENT_MAX_SERIALIZED_BYTES,
  RPC_EVENT_PAGE_DEFAULT_LIMIT,
  RPC_EVENT_PAGE_MAX_LIMIT,
  RPC_EVENT_PAGE_MAX_SERIALIZED_BYTES,
  RPC_SUBSCRIPTION_PENDING_MAX_BYTES,
  RPC_SUBSCRIPTION_PENDING_MAX_EVENTS,
  RpcRuntimeDispatcher,
} from "../../src/interfaces/rpc-runtime.js";
import type { RpcRequest } from "../../src/interfaces/rpc.js";
import { RPC_ERROR_CODES } from "../../src/interfaces/rpc-protocol.js";
import { CapturePeer, QueueProvider, createTestRuntime } from "./rpc-helpers.js";

function request(method: string, params?: unknown): RpcRequest {
  return { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) };
}

async function fixture(context: TestContext, provider: ProviderAdapter = new QueueProvider([])) {
  const root = await mkdtemp(join(tmpdir(), "rigyn-rpc-event-page-"));
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), provider);
  const dispatcher = new RpcRuntimeDispatcher({ runtime });
  context.after(async () => {
    await dispatcher.close("test complete");
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, runtime, dispatcher };
}

class GatedReplayPeer extends CapturePeer {
  readonly blocked: Promise<void>;
  #resolveBlocked!: () => void;
  #release!: () => void;
  readonly #gate: Promise<void>;
  #held = false;

  constructor(id: string) {
    super(id);
    this.blocked = new Promise<void>((resolve) => { this.#resolveBlocked = resolve; });
    this.#gate = new Promise<void>((resolve) => { this.#release = resolve; });
  }

  release(): void {
    this.#release();
  }

  override async notification(method: string, params?: unknown): Promise<void> {
    await super.notification(method, params);
    if (method !== "events.event" || this.#held) return;
    this.#held = true;
    this.#resolveBlocked();
    await this.#gate;
  }
}

class FailingEventPeer extends CapturePeer {
  readonly #sequence: number;

  constructor(id: string, sequence: number) {
    super(id);
    this.#sequence = sequence;
  }

  override async notification(method: string, params?: unknown): Promise<void> {
    const sequence = method === "events.event"
      ? (params as { event?: EventEnvelope } | undefined)?.event?.sequence
      : undefined;
    if (sequence === this.#sequence) throw new Error("fixture outbound queue exceeded its limit");
    await super.notification(method, params);
  }
}

class PrivateEventProvider implements ProviderAdapter {
  readonly id = "test-provider";

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    signal.throwIfAborted();
    yield {
      type: "response_start",
      model: request.model,
      responseId: "PRIVATE_RPC_RESPONSE_ID",
      requestId: "PRIVATE_RPC_REQUEST_ID",
    };
    yield { type: "reasoning_delta", part: 0, text: "PRIVATE_RPC_REASONING", visibility: "provider_trace" };
    yield { type: "text_delta", part: 0, text: "visible" };
    yield {
      type: "response_end",
      reason: "stop",
      state: {
        kind: "chat_completions",
        assistantMessage: { role: "assistant", content: "PRIVATE_RPC_PROVIDER_STATE" },
      },
    };
  }

  async listModels(_signal: AbortSignal): Promise<ModelInfo[]> {
    return [];
  }
}

function appendWarnings(
  runtime: Awaited<ReturnType<typeof createTestRuntime>>,
  threadId: string,
  count: number,
): EventEnvelope[] {
  return Array.from({ length: count }, (_value, index) => runtime.store.appendEvent({
    threadId,
    event: { type: "warning", code: `page-${index}`, message: `event-${index}` },
  }));
}

test("unknown methods remain method-not-found errors", async (context) => {
  const { dispatcher } = await fixture(context);
  await assert.rejects(
    dispatcher.dispatch(new CapturePeer("unknown-method"), request("not.a.rigyn.method")),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { rpcCode?: number }).rpcCode, RPC_ERROR_CODES.methodNotFound);
      assert.match(error.message, /Method not found/u);
      return true;
    },
  );
});

async function waitForEvents(peer: CapturePeer, count: number): Promise<EventEnvelope[]> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const events = peer.notifications.flatMap((entry) => {
      if (entry.method !== "events.event") return [];
      return [(entry.params as { event: EventEnvelope }).event];
    });
    if (events.length >= count) return events;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${count} event notifications`);
}

test("thread.events returns deterministic bounded cursor pages by default", async (context) => {
  const { root, runtime, dispatcher } = await fixture(context);
  const peer = new CapturePeer("event-pages");
  const thread = runtime.store.createThread({ threadId: "rpc-event-pages", workspaceRoot: root });
  appendWarnings(runtime, thread.threadId, 7);

  const initial = await dispatcher.dispatch(peer, request("thread.events", { threadId: thread.threadId })) as {
    events: EventEnvelope[];
    nextCursor: number;
    hasMore: boolean;
  };
  assert.deepEqual(initial.events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual({ nextCursor: initial.nextCursor, hasMore: initial.hasMore }, { nextCursor: 7, hasMore: false });

  const first = await dispatcher.dispatch(peer, request("thread.events", {
    threadId: thread.threadId,
    limit: 3,
  })) as { events: EventEnvelope[]; nextCursor: number; hasMore: boolean };
  assert.deepEqual(first.events.map((event) => event.sequence), [1, 2, 3]);
  assert.deepEqual({ nextCursor: first.nextCursor, hasMore: first.hasMore }, { nextCursor: 3, hasMore: true });

  const middle = await dispatcher.dispatch(peer, request("thread.events", {
    threadId: thread.threadId,
    afterSequence: first.nextCursor,
    limit: 3,
  })) as typeof first;
  assert.deepEqual(middle.events.map((event) => event.sequence), [4, 5, 6]);
  assert.deepEqual({ nextCursor: middle.nextCursor, hasMore: middle.hasMore }, { nextCursor: 6, hasMore: true });

  const final = await dispatcher.dispatch(peer, request("thread.events", {
    threadId: thread.threadId,
    afterSequence: middle.nextCursor,
    limit: 3,
  })) as typeof first;
  assert.deepEqual(final.events.map((event) => event.sequence), [7]);
  assert.deepEqual({ nextCursor: final.nextCursor, hasMore: final.hasMore }, { nextCursor: 7, hasMore: false });

  const empty = await dispatcher.dispatch(peer, request("thread.events", {
    threadId: thread.threadId,
    afterSequence: final.nextCursor,
    limit: 3,
  })) as typeof first;
  assert.deepEqual(empty, { events: [], nextCursor: 7, hasMore: false });

  const beyondHead = await dispatcher.dispatch(peer, request("thread.events", {
    threadId: thread.threadId,
    afterSequence: 99,
  })) as typeof first;
  assert.deepEqual(beyondHead, { events: [], nextCursor: 99, hasMore: false });

  const capabilities = await dispatcher.dispatch(peer, request("capabilities")) as {
    eventPagination: Record<string, unknown>;
    subscriptionReplay: Record<string, unknown>;
  };
  assert.deepEqual(capabilities.eventPagination, {
    cursor: "exclusive-sequence",
    defaultLimit: RPC_EVENT_PAGE_DEFAULT_LIMIT,
    maxLimit: RPC_EVENT_PAGE_MAX_LIMIT,
    maxSerializedBytes: RPC_EVENT_PAGE_MAX_SERIALIZED_BYTES,
    maxSerializedEventBytes: RPC_EVENT_MAX_SERIALIZED_BYTES,
    oversizedSingleEvent: "blocked",
    alwaysPaged: true,
  });
  assert.deepEqual(capabilities.subscriptionReplay, {
    boundedBatches: true,
    snapshotAtSubscribe: true,
    defaultLimit: RPC_EVENT_PAGE_DEFAULT_LIMIT,
    maxLimit: RPC_EVENT_PAGE_MAX_LIMIT,
    maxSerializedEventBytes: RPC_EVENT_MAX_SERIALIZED_BYTES,
    oversizedSingleEvent: "events.error",
    maxPendingLiveEvents: RPC_SUBSCRIPTION_PENDING_MAX_EVENTS,
    maxPendingLiveBytes: RPC_SUBSCRIPTION_PENDING_MAX_BYTES,
    deliveryFailure: "events.error",
  });
});

test("RPC event pages, subscriptions, and live notifications omit provider-private state", async (context) => {
  const { root, runtime, dispatcher } = await fixture(context, new PrivateEventProvider());
  const peer = new CapturePeer("event-projection");
  const thread = runtime.store.createThread({ threadId: "rpc-event-projection", workspaceRoot: root });
  runtime.store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "message_appended",
      message: {
        id: "rpc-private-message",
        role: "assistant",
        createdAt: "2026-07-18T00:00:00.000Z",
        content: [
          { type: "text", text: "visible durable text" },
          {
            type: "provider_opaque",
            provider: "test-provider",
            mediaType: "application/json",
            value: { secret: "PRIVATE_RPC_OPAQUE" },
            serialized: "PRIVATE_RPC_OPAQUE_SERIALIZED",
          },
        ],
      },
      providerState: {
        kind: "chat_completions",
        assistantMessage: { secret: "PRIVATE_RPC_DURABLE_STATE" },
      },
      providerStateSerialized: JSON.stringify({
        kind: "chat_completions",
        assistantMessage: { secret: "PRIVATE_RPC_DURABLE_STATE" },
      }),
    },
  });
  runtime.store.appendEvent({
    threadId: thread.threadId,
    event: { type: "reasoning_delta", part: 0, text: "PRIVATE_RPC_DURABLE_REASONING", visibility: "provider_trace" },
  });
  runtime.store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "provider_response_started",
      step: 0,
      model: "test-model",
      responseId: "PRIVATE_RPC_DURABLE_RESPONSE_ID",
      requestId: "PRIVATE_RPC_DURABLE_REQUEST_ID",
    },
  });
  runtime.store.appendEvent({
    threadId: thread.threadId,
    event: { type: "usage", semantics: "final", usage: { totalTokens: 1, raw: { secret: "PRIVATE_RPC_USAGE" } } },
  });
  runtime.store.appendEvent({
    threadId: thread.threadId,
    event: { type: "warning", code: "fixture", message: "visible warning", details: { secret: "PRIVATE_RPC_WARNING" } },
  });

  const page = await dispatcher.dispatch(peer, request("thread.events", {
    threadId: thread.threadId,
  })) as { events: EventEnvelope[] };
  const pageWire = JSON.stringify(page);
  assert.doesNotMatch(pageWire, /PRIVATE_RPC_|providerState|provider_opaque|provider_trace|"raw"|"details"/u);
  assert.deepEqual(
    page.events[0]?.event.type === "message_appended" ? page.events[0].event.message.content : undefined,
    [{ type: "text", text: "visible durable text" }],
  );
  assert.deepEqual(page.events[1]?.event, {
    type: "warning",
    code: "rpc_private_event_omitted",
    message: "Provider-private reasoning trace omitted from RPC output",
  });

  const subscriptionPeer = new CapturePeer("event-projection-subscription");
  const subscription = await dispatcher.dispatch(subscriptionPeer, request("events.subscribe", {
    threadId: thread.threadId,
  })) as { subscriptionId: string };
  const replayed = await waitForEvents(subscriptionPeer, 5);
  assert.doesNotMatch(
    JSON.stringify(replayed),
    /PRIVATE_RPC_|providerState|provider_opaque|provider_trace|"raw"|"details"/u,
  );
  await dispatcher.dispatch(subscriptionPeer, request("events.unsubscribe", {
    subscriptionId: subscription.subscriptionId,
  }));

  const livePeer = new CapturePeer("event-projection-live");
  const live = await dispatcher.dispatch(livePeer, request("run.start", {
    prompt: "exercise the live event projection",
    provider: "test-provider",
    model: "test-model",
  })) as { threadId: string };
  await dispatcher.dispatch(livePeer, request("run.wait", { threadId: live.threadId }));
  const liveEvents = livePeer.notifications
    .filter((entry) => entry.method === "run.event")
    .map((entry) => entry.params as EventEnvelope);
  assert.ok(liveEvents.length > 0);
  const liveWire = JSON.stringify(liveEvents);
  assert.doesNotMatch(liveWire, /PRIVATE_RPC_|providerState|provider_trace/u);
  assert.match(liveWire, /rpc_private_event_omitted/u);
});

test("RPC event pages are byte bounded and oversized single events stop without advancing the cursor", async (context) => {
  const { root, runtime, dispatcher } = await fixture(context);
  const peer = new CapturePeer("event-byte-pages");
  const thread = runtime.store.createThread({ threadId: "rpc-event-byte-pages", workspaceRoot: root });
  const largeMessage = "p".repeat(Math.floor(RPC_EVENT_MAX_SERIALIZED_BYTES * 0.55));
  runtime.store.appendEvent({
    threadId: thread.threadId,
    event: { type: "warning", code: "large-1", message: largeMessage },
  });
  runtime.store.appendEvent({
    threadId: thread.threadId,
    event: { type: "warning", code: "large-2", message: largeMessage },
  });
  runtime.store.appendEvent({
    threadId: thread.threadId,
    event: { type: "warning", code: "small", message: "small" },
  });

  const first = await dispatcher.dispatch(peer, request("thread.events", {
    threadId: thread.threadId,
    afterSequence: 0,
    limit: 3,
  })) as { events: EventEnvelope[]; nextCursor: number; hasMore: boolean };
  assert.deepEqual(first.events.map((event) => event.sequence), [1]);
  assert.equal(first.nextCursor, 1);
  assert.equal(first.hasMore, true);
  assert.ok(Buffer.byteLength(JSON.stringify(first), "utf8") <= RPC_EVENT_PAGE_MAX_SERIALIZED_BYTES);

  const second = await dispatcher.dispatch(peer, request("thread.events", {
    threadId: thread.threadId,
    afterSequence: first.nextCursor,
    limit: 3,
  })) as typeof first;
  assert.deepEqual(second.events.map((event) => event.sequence), [2, 3]);
  assert.equal(second.hasMore, false);
  assert.ok(Buffer.byteLength(JSON.stringify(second), "utf8") <= RPC_EVENT_PAGE_MAX_SERIALIZED_BYTES);

  const oversizedThread = runtime.store.createThread({ threadId: "rpc-event-oversized", workspaceRoot: root });
  const oversizedEnvelope = runtime.store.appendEvent({
    threadId: oversizedThread.threadId,
    event: {
      type: "warning",
      code: "oversized",
      message: "x".repeat(RPC_EVENT_MAX_SERIALIZED_BYTES),
    },
  });
  const oversizedBytes = Buffer.byteLength(JSON.stringify(oversizedEnvelope), "utf8");
  assert.ok(oversizedBytes > RPC_EVENT_MAX_SERIALIZED_BYTES);

  const blocked = await dispatcher.dispatch(peer, request("thread.events", {
    threadId: oversizedThread.threadId,
    afterSequence: 0,
    limit: 1,
  })) as {
    events: EventEnvelope[];
    nextCursor: number;
    hasMore: boolean;
    blocked: {
      reason: string;
      sequence: number;
      serializedBytes: number;
      maximumBytes: number;
      resumeAfterSequence: number;
    };
  };
  assert.deepEqual(blocked.events, []);
  assert.equal(blocked.nextCursor, 0);
  assert.equal(blocked.hasMore, true);
  assert.deepEqual(blocked.blocked, {
    reason: "event_exceeds_serialized_byte_limit",
    sequence: 1,
    serializedBytes: oversizedBytes,
    maximumBytes: RPC_EVENT_MAX_SERIALIZED_BYTES,
    resumeAfterSequence: 1,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(blocked), "utf8") <= RPC_EVENT_PAGE_MAX_SERIALIZED_BYTES);

  const defaultPage = await dispatcher.dispatch(peer, request("thread.events", {
    threadId: oversizedThread.threadId,
  })) as typeof blocked;
  assert.deepEqual(defaultPage, blocked);

  const replayPeer = new CapturePeer("event-byte-replay");
  const subscription = await dispatcher.dispatch(replayPeer, request("events.subscribe", {
    threadId: oversizedThread.threadId,
    afterSequence: 0,
  })) as {
    subscriptionId: string;
    nextCursor: number;
    hasMore: boolean;
    blocked?: typeof blocked.blocked;
  };
  assert.equal(subscription.nextCursor, 0);
  assert.equal(subscription.hasMore, true);
  assert.deepEqual(subscription.blocked, blocked.blocked);
  const stopped = await replayPeer.waitFor("events.error") as {
    params?: { cursor?: number; blocked?: typeof blocked.blocked };
  };
  assert.equal(stopped.params?.cursor, 0);
  assert.deepEqual(stopped.params?.blocked, blocked.blocked);
  assert.equal(replayPeer.notifications.some((entry) => entry.method === "events.event"), false);
});

test("storage cursor pages can retain a fixed replay snapshot while the branch advances", async (context) => {
  const { root, runtime } = await fixture(context);
  const thread = runtime.store.createThread({ threadId: "event-page-snapshot", workspaceRoot: root });
  appendWarnings(runtime, thread.threadId, 4);
  const first = runtime.store.listEventPage(thread.threadId, "main", { afterSequence: 0, limit: 2 });
  assert.deepEqual(first.events.map((event) => event.sequence), [1, 2]);
  assert.equal(first.snapshotSequence, 4);

  appendWarnings(runtime, thread.threadId, 1);
  const frozen = runtime.store.listEventPage(thread.threadId, "main", {
    afterSequence: first.nextSequence,
    limit: 4,
    throughSequence: first.snapshotSequence,
  });
  assert.deepEqual(frozen.events.map((event) => event.sequence), [3, 4]);
  assert.equal(frozen.hasMore, false);
  const current = runtime.store.listEventPage(thread.threadId, "main", { afterSequence: 4, limit: 4 });
  assert.deepEqual(current.events.map((event) => event.sequence), [5]);
});

test("storage cursor pages preserve nested inherited branch paths across global sequence gaps", async (context) => {
  const { root, runtime } = await fixture(context);
  const thread = runtime.store.createThread({ threadId: "event-page-inherited", workspaceRoot: root });
  const main = appendWarnings(runtime, thread.threadId, 4);
  runtime.store.forkBranch({
    threadId: thread.threadId,
    fromBranch: "main",
    newBranch: "experiment",
    atEventId: main[2]!.eventId,
  });
  appendWarnings(runtime, thread.threadId, 2);
  const experiment = Array.from({ length: 2 }, (_value, index) => runtime.store.appendEvent({
    threadId: thread.threadId,
    branch: "experiment",
    event: { type: "warning", code: `experiment-${index}`, message: `experiment-${index}` },
  }));
  runtime.store.forkBranch({
    threadId: thread.threadId,
    fromBranch: "experiment",
    newBranch: "nested",
    atEventId: experiment[0]!.eventId,
  });
  runtime.store.appendEvent({
    threadId: thread.threadId,
    branch: "experiment",
    event: { type: "warning", code: "experiment-late", message: "experiment-late" },
  });
  for (let index = 0; index < 2; index += 1) {
    runtime.store.appendEvent({
      threadId: thread.threadId,
      branch: "nested",
      event: { type: "warning", code: `nested-${index}`, message: `nested-${index}` },
    });
  }

  const expected = runtime.store.listEvents(thread.threadId, "nested").map((event) => event.sequence);
  const paged: number[] = [];
  let cursor = 0;
  while (true) {
    const page = runtime.store.listEventPage(thread.threadId, "nested", { afterSequence: cursor, limit: 2 });
    paged.push(...page.events.map((event) => event.sequence));
    cursor = page.nextSequence;
    if (!page.hasMore) break;
  }
  assert.deepEqual(expected, [1, 2, 3, 7, 10, 11]);
  assert.deepEqual(paged, expected);
});

test("RPC event pages reject invalid cursors and limits before reading history", async (context) => {
  const { root, runtime, dispatcher } = await fixture(context);
  const peer = new CapturePeer("event-page-validation");
  const thread = runtime.store.createThread({ threadId: "rpc-event-validation", workspaceRoot: root });
  appendWarnings(runtime, thread.threadId, 1);

  for (const afterSequence of [-1, 1.5, "1"]) {
    await assert.rejects(dispatcher.dispatch(peer, request("thread.events", {
      threadId: thread.threadId,
      afterSequence,
      limit: 1,
    })), /afterSequence/u);
  }
  for (const limit of [0, 1.5, "1", RPC_EVENT_PAGE_MAX_LIMIT + 1]) {
    await assert.rejects(dispatcher.dispatch(peer, request("thread.events", {
      threadId: thread.threadId,
      limit,
    })), /limit/u);
  }
  await assert.rejects(dispatcher.dispatch(peer, request("events.subscribe", {
    threadId: thread.threadId,
    limit: RPC_EVENT_PAGE_MAX_LIMIT + 1,
  })), /limit/u);
});

test("thread.events enforces default and absolute history bounds", async (context) => {
  const { root, runtime, dispatcher } = await fixture(context);
  const peer = new CapturePeer("event-page-bounds");
  const thread = runtime.store.createThread({ threadId: "rpc-event-bounds", workspaceRoot: root });
  appendWarnings(runtime, thread.threadId, RPC_EVENT_PAGE_MAX_LIMIT + 9);

  const defaultPage = await dispatcher.dispatch(peer, request("thread.events", {
    threadId: thread.threadId,
    afterSequence: 0,
  })) as { events: EventEnvelope[]; nextCursor: number; hasMore: boolean };
  assert.equal(defaultPage.events.length, RPC_EVENT_PAGE_DEFAULT_LIMIT);
  assert.equal(defaultPage.hasMore, true);

  const maximumPage = await dispatcher.dispatch(peer, request("thread.events", {
    threadId: thread.threadId,
    afterSequence: 0,
    limit: RPC_EVENT_PAGE_MAX_LIMIT,
  })) as typeof defaultPage;
  assert.equal(maximumPage.events.length, RPC_EVENT_PAGE_MAX_LIMIT);
  assert.equal(maximumPage.nextCursor, RPC_EVENT_PAGE_MAX_LIMIT);
  assert.equal(maximumPage.hasMore, true);
});

test("subscription replay is cursor ordered, bounded in batches, and hands off to live events", async (context) => {
  const { root, runtime, dispatcher } = await fixture(context);
  const peer = new CapturePeer("event-replay");
  const thread = runtime.store.createThread({ threadId: "rpc-event-replay", workspaceRoot: root });
  appendWarnings(runtime, thread.threadId, 7);

  const subscribed = await dispatcher.dispatch(peer, request("events.subscribe", {
    threadId: thread.threadId,
    afterSequence: 3,
    limit: 2,
  })) as {
    subscriptionId: string;
    replayedThrough: number;
    nextCursor: number;
    hasMore: boolean;
  };
  assert.equal(subscribed.replayedThrough, 7);
  assert.equal(subscribed.nextCursor, 5);
  assert.equal(subscribed.hasMore, true);
  assert.deepEqual((await waitForEvents(peer, 4)).map((event) => event.sequence), [4, 5, 6, 7]);

  const started = await dispatcher.dispatch(peer, request("run.start", {
    threadId: thread.threadId,
    prompt: "publish live events",
    provider: "test-provider",
    model: "test-model",
  })) as { threadId: string };
  await dispatcher.dispatch(peer, request("run.wait", { threadId: started.threadId }));
  const delivered = await waitForEvents(peer, 5);
  assert.deepEqual(delivered.slice(0, 4).map((event) => event.sequence), [4, 5, 6, 7]);
  assert.ok(delivered.slice(4).every((event) => event.sequence > 7));
  assert.deepEqual(
    delivered.map((event) => event.sequence),
    delivered.map((event) => event.sequence).toSorted((left, right) => left - right),
  );
  await dispatcher.dispatch(peer, request("events.unsubscribe", { subscriptionId: subscribed.subscriptionId }));

  const legacyPeer = new CapturePeer("legacy-event-replay");
  const legacy = await dispatcher.dispatch(legacyPeer, request("events.subscribe", {
    threadId: thread.threadId,
    afterSequence: 0,
  })) as { subscriptionId: string; replayedThrough: number };
  const legacyEvents = await waitForEvents(legacyPeer, legacy.replayedThrough);
  assert.deepEqual(
    legacyEvents.map((event) => event.sequence),
    Array.from({ length: legacy.replayedThrough }, (_value, index) => index + 1),
  );
  await dispatcher.dispatch(legacyPeer, request("events.unsubscribe", { subscriptionId: legacy.subscriptionId }));
});

test("subscription handoff is byte bounded before retaining live events", async (context) => {
  const largeOutput = "x".repeat(Math.floor(RPC_SUBSCRIPTION_PENDING_MAX_BYTES * 0.55));
  const { root, runtime, dispatcher } = await fixture(context, new QueueProvider([largeOutput]));
  const peer = new GatedReplayPeer("event-byte-handoff");
  const thread = runtime.store.createThread({ threadId: "rpc-event-byte-handoff", workspaceRoot: root });
  appendWarnings(runtime, thread.threadId, 1);

  const subscribed = await dispatcher.dispatch(peer, request("events.subscribe", {
    threadId: thread.threadId,
    afterSequence: 0,
    limit: 1,
  })) as { subscriptionId: string };
  await peer.blocked;
  const started = await dispatcher.dispatch(peer, request("run.start", {
    threadId: thread.threadId,
    prompt: "publish a byte-heavy live response",
    provider: "test-provider",
    model: "test-model",
  })) as { threadId: string };
  await dispatcher.dispatch(peer, request("run.wait", { threadId: started.threadId }));

  peer.release();
  const stopped = await peer.waitFor("events.error") as {
    params?: { cursor?: number; reason?: string };
  };
  assert.equal(stopped.params?.cursor, 1);
  assert.match(stopped.params?.reason ?? "", /delivery buffer exceeded/u);
  assert.deepEqual(
    peer.notifications
      .filter((entry) => entry.method === "events.event")
      .map((entry) => (entry.params as { event: EventEnvelope }).event.sequence),
    [1],
  );
  assert.deepEqual(await dispatcher.dispatch(peer, request("events.unsubscribe", {
    subscriptionId: subscribed.subscriptionId,
  })), { unsubscribed: true });
});

test("subscription writer failures emit events.error without advancing past the last successful event", async (context) => {
  const { root, runtime, dispatcher } = await fixture(context);
  const peer = new FailingEventPeer("event-writer-failure", 2);
  const thread = runtime.store.createThread({ threadId: "rpc-event-writer-failure", workspaceRoot: root });
  appendWarnings(runtime, thread.threadId, 3);

  const subscribed = await dispatcher.dispatch(peer, request("events.subscribe", {
    threadId: thread.threadId,
    afterSequence: 0,
    limit: 3,
  })) as { subscriptionId: string };
  const stopped = await peer.waitFor("events.error") as {
    params?: { cursor?: number; reason?: string };
  };
  assert.equal(stopped.params?.cursor, 1);
  assert.match(stopped.params?.reason ?? "", /delivery failed before cursor advancement/u);
  assert.deepEqual(
    peer.notifications
      .filter((entry) => entry.method === "events.event")
      .map((entry) => (entry.params as { event: EventEnvelope }).event.sequence),
    [1],
  );
  assert.deepEqual(await dispatcher.dispatch(peer, request("events.unsubscribe", {
    subscriptionId: subscribed.subscriptionId,
  })), { unsubscribed: true });
});

test("events.unsubscribe is idempotent and cannot stop another peer's subscription", async (context) => {
  const { root, runtime, dispatcher } = await fixture(context);
  const owner = new CapturePeer("event-owner");
  const outsider = new CapturePeer("event-outsider");
  const thread = runtime.store.createThread({ threadId: "rpc-event-unsubscribe-owner", workspaceRoot: root });
  appendWarnings(runtime, thread.threadId, 1);
  const subscribed = await dispatcher.dispatch(owner, request("events.subscribe", {
    threadId: thread.threadId,
    afterSequence: 1,
  })) as { subscriptionId: string };

  assert.deepEqual(await dispatcher.dispatch(outsider, request("events.unsubscribe", {
    subscriptionId: subscribed.subscriptionId,
  })), { unsubscribed: true });
  const started = await dispatcher.dispatch(owner, request("run.start", {
    threadId: thread.threadId,
    prompt: "prove the owner remains subscribed",
    provider: "test-provider",
    model: "test-model",
  })) as { threadId: string };
  await dispatcher.dispatch(owner, request("run.wait", { threadId: started.threadId }));
  assert.ok((await waitForEvents(owner, 1))[0]!.sequence > 1);
  assert.deepEqual(await dispatcher.dispatch(owner, request("events.unsubscribe", {
    subscriptionId: subscribed.subscriptionId,
  })), { unsubscribed: true });
  assert.deepEqual(await dispatcher.dispatch(owner, request("events.unsubscribe", {
    subscriptionId: subscribed.subscriptionId,
  })), { unsubscribed: true });
});

test("unsubscribing before replay starts cancels every queued replay page", async (context) => {
  const { root, runtime, dispatcher } = await fixture(context);
  const peer = new CapturePeer("event-replay-cancel");
  const thread = runtime.store.createThread({ threadId: "rpc-event-replay-cancel", workspaceRoot: root });
  appendWarnings(runtime, thread.threadId, 12);

  const subscribed = await dispatcher.dispatch(peer, request("events.subscribe", {
    threadId: thread.threadId,
    afterSequence: 0,
    limit: 1,
  })) as { subscriptionId: string };
  assert.deepEqual(await dispatcher.dispatch(peer, request("events.unsubscribe", {
    subscriptionId: subscribed.subscriptionId,
  })), { unsubscribed: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(peer.notifications.some((entry) => entry.method === "events.event"), false);
});
