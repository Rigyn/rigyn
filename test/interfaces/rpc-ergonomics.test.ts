import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdapterEvent, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import { RpcRuntimeDispatcher } from "../../src/interfaces/rpc-runtime.js";
import type { RpcRequest } from "../../src/interfaces/rpc.js";
import { CapturePeer, createTestRuntime } from "./rpc-helpers.js";

const observedAt = "2026-01-01T00:00:00.000Z";
const unknown = { value: "unknown" as const, source: "provider" as const, observedAt };

function request(method: string, params?: unknown): RpcRequest {
  return { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) };
}

class ErgonomicProvider implements ProviderAdapter {
  readonly id = "ergonomic-provider";

  async *stream(input: ProviderRequest): AsyncIterable<AdapterEvent> {
    yield { type: "response_start", model: input.model };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "done" } },
    };
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    signal.throwIfAborted();
    return ["alpha", "beta"].map((id) => ({
      provider: this.id,
      id,
      capabilities: { tools: unknown, reasoning: unknown, images: unknown },
      compatibility: {
        reasoningEfforts: { value: ["off", "low", "high"], source: "provider", observedAt },
      },
    }));
  }
}

class GatedErgonomicProvider extends ErgonomicProvider {
  readonly started: Promise<void>;
  readonly #announceStarted: () => void;
  readonly #gate: Promise<void>;
  readonly #release: () => void;

  constructor() {
    super();
    let announceStarted!: () => void;
    this.started = new Promise((resolve) => { announceStarted = resolve; });
    this.#announceStarted = announceStarted;
    let release!: () => void;
    this.#gate = new Promise((resolve) => { release = resolve; });
    this.#release = release;
  }

  release(): void {
    this.#release();
  }

  override async *stream(input: ProviderRequest): AsyncIterable<AdapterEvent> {
    yield { type: "response_start", model: input.model };
    this.#announceStarted();
    await this.#gate;
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "done" } },
    };
  }
}

test("RPC model, thinking, and auto-compaction conveniences remain typed thread operations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-rpc-ergonomics-"));
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), new ErgonomicProvider());
  const dispatcher = new RpcRuntimeDispatcher({ runtime });
  const peer = new CapturePeer("ergonomic-owner");
  t.after(async () => {
    await dispatcher.close("test complete");
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const thread = await runtime.service.createSession({ name: "ergonomics" });
  await dispatcher.dispatch(peer, request("thread.model.set", {
    threadId: thread.threadId,
    reference: "ergonomic/alpha",
    reasoningEffort: "off",
  }));
  const model = await dispatcher.dispatch(peer, request("thread.model.cycle", {
    threadId: thread.threadId,
    refresh: false,
  })) as { selection: { model: string }; availableModels: number; changed: boolean; wrapped: boolean };
  assert.deepEqual(model, {
    ...model,
    selection: { ...model.selection, model: "beta" },
    availableModels: 2,
    changed: true,
    wrapped: false,
  });
  const wrapped = await dispatcher.dispatch(peer, request("thread.model.cycle", {
    threadId: thread.threadId,
    refresh: false,
  })) as { selection: { model: string }; wrapped: boolean };
  assert.equal(wrapped.selection.model, "alpha");
  assert.equal(wrapped.wrapped, true);

  const thinking = await dispatcher.dispatch(peer, request("thread.thinking.cycle", {
    threadId: thread.threadId,
  })) as { selection: { reasoningEffort?: string }; levels: string[]; wrapped: boolean };
  assert.equal(thinking.selection.reasoningEffort, "low");
  assert.deepEqual(thinking.levels, ["off", "low", "high"]);
  assert.equal(thinking.wrapped, false);

  assert.deepEqual(await dispatcher.dispatch(peer, request("thread.autoCompaction.set", {
    threadId: thread.threadId,
    enabled: false,
  })), { threadId: thread.threadId, branch: "main", enabled: false });
  const state = await dispatcher.dispatch(peer, request("thread.state", { threadId: thread.threadId })) as {
    autoCompactionEnabled: boolean;
  };
  assert.equal(state.autoCompactionEnabled, false);
  assert.equal(runtime.service.autoCompactionEnabled(thread.threadId), false);
});

test("RPC current-session conveniences clone and fork only workspace-bound current paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-rpc-current-session-"));
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), new ErgonomicProvider());
  const dispatcher = new RpcRuntimeDispatcher({ runtime });
  const peer = new CapturePeer("session-owner");
  const observer = new CapturePeer("session-observer");
  t.after(async () => {
    await dispatcher.close("test complete");
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(await dispatcher.dispatch(peer, request("session.current")), null);
  const current = await dispatcher.dispatch(peer, request("session.new", { name: "source" })) as {
    thread: { threadId: string };
    branch: string;
  };
  assert.equal(current.branch, "main");
  assert.equal(await dispatcher.dispatch(observer, request("session.current")), null);
  const first = runtime.store.appendEvent({
    threadId: current.thread.threadId,
    event: {
      type: "message_appended",
      message: {
        id: "msg_fork_first",
        role: "user",
        content: [{ type: "text", text: "first prompt" }],
        createdAt: observedAt,
      },
    },
  });
  runtime.store.appendEvent({
    threadId: current.thread.threadId,
    event: {
      type: "message_appended",
      message: {
        id: "msg_fork_answer",
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        createdAt: observedAt,
      },
    },
  });
  const second = runtime.store.appendEvent({
    threadId: current.thread.threadId,
    event: {
      type: "message_appended",
      message: {
        id: "msg_fork_second",
        role: "user",
        content: [{ type: "text", text: "second prompt" }],
        createdAt: observedAt,
      },
    },
  });

  const firstPage = await dispatcher.dispatch(peer, request("thread.forkMessages", {
    threadId: current.thread.threadId,
    limit: 1,
  })) as { messages: Array<{ eventId: string; text: string }>; nextCursor: number; hasMore: boolean };
  assert.deepEqual(firstPage.messages, [{
    eventId: first.eventId,
    sequence: first.sequence,
    text: "first prompt",
    truncated: false,
  }]);
  assert.equal(firstPage.hasMore, true);
  const secondPage = await dispatcher.dispatch(peer, request("thread.forkMessages", {
    threadId: current.thread.threadId,
    afterSequence: firstPage.nextCursor,
    limit: 1,
  })) as { messages: Array<{ eventId: string; text: string }> };
  assert.deepEqual(secondPage.messages.map((entry) => entry.text), ["second prompt"]);

  const cloned = await dispatcher.dispatch(peer, request("session.clone", { name: "complete copy" })) as {
    thread: { threadId: string };
    events: number;
  };
  assert.notEqual(cloned.thread.threadId, current.thread.threadId);
  assert.equal(cloned.events, 3);
  assert.equal((await dispatcher.dispatch(peer, request("session.current")) as {
    thread: { threadId: string };
  }).thread.threadId, cloned.thread.threadId);

  await dispatcher.dispatch(peer, request("session.switch", { threadId: current.thread.threadId }));
  const forked = await dispatcher.dispatch(peer, request("session.fork", {
    eventId: second.eventId,
    name: "before second",
  })) as { thread: { threadId: string }; selectedText: string; events: number };
  assert.equal(forked.selectedText, "second prompt");
  assert.equal(forked.events, 2);
  assert.notEqual(forked.thread.threadId, current.thread.threadId);
  assert.equal(runtime.store.listEvents(forked.thread.threadId).some((entry) => entry.eventId === second.eventId), false);

  await assert.rejects(
    dispatcher.dispatch(peer, request("session.fork", { eventId: "missing" })),
    /not a user-message fork candidate/u,
  );
});

test("RPC auto-compaction policy can change while its session run remains active", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-rpc-live-compaction-policy-"));
  const provider = new GatedErgonomicProvider();
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), provider);
  const dispatcher = new RpcRuntimeDispatcher({ runtime });
  const peer = new CapturePeer("live-policy-owner");
  const observer = new CapturePeer("live-policy-observer");
  t.after(async () => {
    provider.release();
    await dispatcher.close("test complete");
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const thread = await runtime.service.createSession();
  const started = await dispatcher.dispatch(peer, request("run.start", {
    threadId: thread.threadId,
    prompt: "hold",
    model: "ergonomic/alpha",
  })) as { threadId: string };
  await provider.started;
  await assert.rejects(dispatcher.dispatch(observer, request("thread.autoCompaction.set", {
    threadId: started.threadId,
    enabled: false,
  })), /No RPC-owned run/u);
  assert.deepEqual(await dispatcher.dispatch(peer, request("thread.autoCompaction.set", {
    threadId: started.threadId,
    enabled: false,
  })), { threadId: started.threadId, branch: "main", enabled: false });
  const active = await dispatcher.dispatch(peer, request("thread.state", { threadId: started.threadId })) as {
    active: boolean;
    autoCompactionEnabled: boolean;
  };
  assert.equal(active.active, true);
  assert.equal(active.autoCompactionEnabled, false);
  provider.release();
  await dispatcher.dispatch(peer, request("run.wait", { threadId: started.threadId }));
});
