import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdapterEvent, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import {
  loadRuntimeExtensions,
  type RuntimeExtensionHost,
  type RuntimeInputEvent,
  type RuntimeInputResult,
} from "../../src/extensions/runtime.js";
import { RpcRuntimeDispatcher } from "../../src/interfaces/rpc-runtime.js";
import type { RpcRequest } from "../../src/interfaces/rpc.js";
import { sha256 } from "../../src/tools/hash.js";
import { CapturePeer, GatedProvider, QueueProvider, createTestRuntime } from "./rpc-helpers.js";

function request(method: string, params?: unknown): RpcRequest {
  return { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) };
}

async function inputFixture(context: { after(callback: () => void | Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "harness-rpc-input-"));
  const source = `export default (api) => {
    api.on("input", async (event) => {
      if (event.text === "handled") return { action: "handled" };
      if (event.text === "bad-image") {
        return { action: "transform", text: "invalid image", images: [{ type: "image", mediaType: "image/png", data: "not base64" }] };
      }
      if (event.text.startsWith("slow")) await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        action: "transform",
        text: event.text + ":" + (event.delivery ?? "start"),
        ...(event.images === undefined ? {} : { images: event.images }),
      };
    });
  };\n`;
  const sourcePath = join(root, "input-extension.mjs");
  await writeFile(sourcePath, source);
  const runtimeExtensions = await loadRuntimeExtensions([{
    extensionId: "rpc-input",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root });
  const provider = new GatedProvider();
  const base = await createTestRuntime(root, join(root, "sessions.sqlite"), provider);
  const dispatcher = new RpcRuntimeDispatcher({
    runtime: { ...base, runtimeExtensions },
  });
  context.after(async () => {
    await dispatcher.close("test complete");
    await runtimeExtensions.close();
    await base.close();
  });
  context.after(async () => await rm(root, { recursive: true, force: true }));
  return { base, dispatcher, provider };
}

test("RPC input reducers transform start and queued images in invocation order and can handle input", async (context) => {
  const { base, dispatcher, provider } = await inputFixture(context);
  const peer = new CapturePeer("input-owner");
  const image = { type: "image", mediaType: "image/png", data: "iVBORw==" } as const;
  const started = await dispatcher.dispatch(peer, request("run.start", {
    prompt: "initial",
    provider: "test-provider",
    model: "test-model",
    images: [image],
  })) as { threadId: string };
  await provider.ready;
  assert.deepEqual(provider.requests[0]?.messages.findLast((message) => message.role === "user")?.content, [
    { type: "text", text: "initial:start" },
    image,
  ]);

  assert.deepEqual(await dispatcher.dispatch(peer, request("run.steer", {
    threadId: started.threadId,
    message: "handled",
  })), { accepted: false, handled: true });
  const first = dispatcher.dispatch(peer, request("run.followUp", {
    threadId: started.threadId,
    message: "slow-first",
    images: [image],
  }));
  const second = dispatcher.dispatch(peer, request("run.followUp", {
    threadId: started.threadId,
    message: "fast-second",
  }));
  assert.deepEqual(await Promise.all([first, second]), [{ accepted: true }, { accepted: true }]);
  assert.deepEqual(await dispatcher.dispatch(peer, request("run.queue", { threadId: started.threadId })), {
    messages: [
      { mode: "follow_up", text: "slow-first:follow_up", images: [image] },
      { mode: "follow_up", text: "fast-second:follow_up" },
    ],
  });

  provider.release();
  await dispatcher.dispatch(peer, request("run.wait", { threadId: started.threadId }));
  const durableUsers = base.store.listEvents(started.threadId)
    .filter((entry) => entry.event.type === "message_appended" && entry.event.message.role === "user")
    .map((entry) => entry.event.type === "message_appended" ? entry.event.message.content : []);
  assert.deepEqual(durableUsers.slice(-3), [
    [{ type: "text", text: "initial:start" }, image],
    [{ type: "text", text: "slow-first:follow_up" }, image],
    [{ type: "text", text: "fast-second:follow_up" }],
  ]);

  const runCount = base.store.listRuns(started.threadId).length;
  const providerCalls = provider.requests.length;
  assert.deepEqual(await dispatcher.dispatch(peer, request("run.start", {
    threadId: started.threadId,
    prompt: "handled",
    provider: "test-provider",
    model: "test-model",
  })), { threadId: started.threadId, handled: true });
  assert.equal(base.store.listRuns(started.threadId).length, runCount);
  assert.equal(provider.requests.length, providerCalls);

  await assert.rejects(dispatcher.dispatch(peer, request("run.start", {
    threadId: started.threadId,
    prompt: "bad-image",
    provider: "test-provider",
    model: "test-model",
  })), /canonical base64/u);
  assert.equal(base.store.listRuns(started.threadId).length, runCount);
});

function blockingExtensions(entered: () => void): RuntimeExtensionHost {
  return {
    setHostContext() {},
    async dispatch() {},
    async reduceInput(_event: RuntimeInputEvent, signal?: AbortSignal): Promise<RuntimeInputResult> {
      entered();
      return await new Promise<RuntimeInputResult>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  } as unknown as RuntimeExtensionHost;
}

function blockingEventExtensions(entered: () => void): RuntimeExtensionHost {
  return {
    setHostContext() {},
    async dispatch(event: string) {
      if (event !== "event") return;
      entered();
      await new Promise<void>(() => undefined);
    },
  } as unknown as RuntimeExtensionHost;
}

test("RPC input reduction is cancelled by runtime generation replacement and peer disconnect", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-rpc-input-cancel-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));

  for (const mode of ["generation", "disconnect"] as const) {
    const provider = new QueueProvider([]);
    const base = await createTestRuntime(root, join(root, `${mode}.sqlite`), provider);
    const generation = new AbortController();
    let enter: () => void = () => {};
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const dispatcher = new RpcRuntimeDispatcher({
      runtime: {
        ...base,
        runtimeExtensions: blockingExtensions(enter),
        ...(mode === "generation" ? { generationSignal: generation.signal } : {}),
      },
    });
    const peer = new CapturePeer(`${mode}-peer`);
    const pending = dispatcher.dispatch(peer, request("run.start", {
      prompt: "wait",
      provider: "test-provider",
      model: "test-model",
    }));
    await entered;
    if (mode === "generation") generation.abort(new Error("runtime generation replaced"));
    else dispatcher.disconnect(peer.id);
    await assert.rejects(pending, mode === "generation" ? /generation replaced/u : /client disconnected/u);
    assert.equal(provider.requests.length, 0);
    await dispatcher.close("test complete");
    await base.close();
  }
});

test("RPC disconnect settles an active run whose extension event observer never resolves", { timeout: 5_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-rpc-event-cancel-"));
  const provider = new QueueProvider(["must not complete"]);
  const base = await createTestRuntime(root, join(root, "sessions.sqlite"), provider);
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const dispatcher = new RpcRuntimeDispatcher({
    runtime: { ...base, runtimeExtensions: blockingEventExtensions(markEntered) },
  });
  context.after(async () => {
    await dispatcher.close("test complete", 0);
    await base.close();
    await rm(root, { recursive: true, force: true });
  });
  const peer = new CapturePeer("event-observer-owner");
  const started = await dispatcher.dispatch(peer, request("run.start", {
    prompt: "block extension event dispatch",
    provider: "test-provider",
    model: "test-model",
  })) as { threadId: string };

  await entered;
  const waiting = dispatcher.dispatch(peer, request("run.wait", { threadId: started.threadId }));
  dispatcher.disconnect(peer.id);
  await waiting;

  assert.equal(base.store.listRuns(started.threadId).at(-1)?.state, "cancelled");
});

test("RPC queue-mode mutation and active controls are owner-scoped", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-rpc-owner-"));
  const provider = new GatedProvider();
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), provider);
  const dispatcher = new RpcRuntimeDispatcher({ runtime });
  context.after(async () => {
    await dispatcher.close("test complete");
    await runtime.close();
  });
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const owner = new CapturePeer("queue-owner");
  const other = new CapturePeer("queue-other");
  const capabilities = await dispatcher.dispatch(owner, request("capabilities")) as {
    runtimeExtensions: { input: unknown };
    runQueueModes: unknown;
    runStart: { reasoningEffortMaxBytes: number };
    threadState: unknown;
  };
  assert.deepEqual(capabilities.runtimeExtensions.input, {
    runStart: true,
    steer: true,
    followUp: true,
    orderedPerThread: true,
    cancellable: true,
    results: ["continue", "handled", "transform"],
    maxTransformedTextBytes: 1024 * 1024,
  });
  assert.deepEqual(capabilities.runQueueModes, {
    values: ["one-at-a-time", "all"],
    readable: true,
    mutableDuringRun: true,
    ownerScoped: true,
  });
  assert.equal(capabilities.runStart.reasoningEffortMaxBytes, 256);
  assert.deepEqual(capabilities.threadState, {
    state: true,
    statistics: true,
    lastAssistantText: true,
    maxLastAssistantTextBytes: 8 * 1024 * 1024,
    runSelection: "durable-readable-and-idle-mutable",
    setModel: "thread.model.set",
    cycleModel: "thread.model.cycle",
    setThinking: "thread.thinking.set",
    cycleThinking: "thread.thinking.cycle",
    setAutoCompaction: "thread.autoCompaction.set",
  });
  const started = await dispatcher.dispatch(owner, request("run.start", {
    prompt: "hold",
    provider: "test-provider",
    model: "test-model",
    reasoningEffort: "high",
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
  })) as { threadId: string };
  await provider.ready;
  assert.deepEqual(await dispatcher.dispatch(owner, request("run.queueModes.get", { threadId: started.threadId })), {
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
  });
  assert.deepEqual(await dispatcher.dispatch(owner, request("run.queueModes.set", {
    threadId: started.threadId,
    steeringMode: "all",
    followUpMode: "all",
  })), { steeringMode: "all", followUpMode: "all" });
  const state = await dispatcher.dispatch(owner, request("thread.state", { threadId: started.threadId })) as {
    active: boolean;
    reasoningEffort?: string;
    queueModes?: { steeringMode: string; followUpMode: string };
  };
  assert.equal(state.active, true);
  assert.equal(state.reasoningEffort, "high");
  assert.deepEqual(state.queueModes, { steeringMode: "all", followUpMode: "all" });

  for (const [method, params] of [
    ["run.queueModes.set", { threadId: started.threadId, steeringMode: "one-at-a-time" }],
    ["run.wait", { threadId: started.threadId }],
    ["run.queue", { threadId: started.threadId }],
    ["run.dequeue", { threadId: started.threadId }],
    ["run.steer", { threadId: started.threadId, message: "foreign" }],
    ["run.followUp", { threadId: started.threadId, message: "foreign" }],
    ["run.cancel", { threadId: started.threadId }],
  ] as const) {
    await assert.rejects(dispatcher.dispatch(other, request(method, params)), /No RPC-owned run/u);
  }
  const waiting = dispatcher.dispatch(owner, request("run.wait", { threadId: started.threadId }));
  dispatcher.disconnect(owner.id);
  await waiting;
  assert.equal(runtime.store.listRuns(started.threadId).at(-1)?.state, "cancelled");
});

class StatisticsProvider implements ProviderAdapter {
  readonly id = "statistics";

  async *stream(_request: ProviderRequest, _signal: AbortSignal): AsyncIterable<AdapterEvent> {
    yield { type: "response_start", model: "statistics-model" };
    yield { type: "text_delta", part: 0, text: "statistics answer" };
    yield {
      type: "usage",
      semantics: "final",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 150,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
        reasoningTokens: 5,
        cost: "0.01",
      },
    };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "statistics answer" } },
    };
  }

  async listModels(_signal: AbortSignal): Promise<ModelInfo[]> {
    const observedAt = "2026-07-10T00:00:00.000Z";
    const unknown = { value: "unknown" as const, source: "provider" as const, observedAt };
    return [{
      id: "statistics-model",
      provider: this.id,
      contextTokens: 100_000,
      capabilities: { tools: unknown, reasoning: unknown, images: unknown },
    }];
  }
}

test("RPC exposes durable thread state, structured statistics, and last assistant text", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-rpc-stats-"));
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), new StatisticsProvider());
  const dispatcher = new RpcRuntimeDispatcher({ runtime });
  context.after(async () => {
    await dispatcher.close("test complete");
    await runtime.close();
  });
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const peer = new CapturePeer("stats-peer");
  const empty = await dispatcher.dispatch(peer, request("thread.create")) as { threadId: string };
  assert.deepEqual(await dispatcher.dispatch(peer, request("thread.lastAssistantText", { threadId: empty.threadId })), { text: null });

  const started = await dispatcher.dispatch(peer, request("run.start", {
    prompt: "collect statistics",
    provider: "statistics",
    model: "statistics-model",
    reasoningEffort: "high",
  })) as { threadId: string };
  await dispatcher.dispatch(peer, request("run.wait", { threadId: started.threadId }));
  const state = await dispatcher.dispatch(peer, request("thread.state", { threadId: started.threadId })) as Record<string, unknown>;
  assert.deepEqual({
    active: state.active,
    operation: state.operation,
    provider: state.provider,
    model: state.model,
    reasoningEffort: state.reasoningEffort,
    pendingMessageCount: state.pendingMessageCount,
  }, {
    active: false,
    operation: null,
    provider: "statistics",
    model: "statistics-model",
    reasoningEffort: "high",
    pendingMessageCount: 0,
  });
  assert.equal("queueModes" in state, false);

  const stats = await dispatcher.dispatch(peer, request("thread.stats", { threadId: started.threadId })) as {
    messages: { system: number; user: number; assistant: number; tool: number; total: number };
    tools: { calls: number; results: number };
    runs: { total: number; completed: number };
    tokens: Record<string, number>;
    cost?: string;
    contextUsage?: { tokens: number; contextWindow: number; percent: number };
  };
  assert.deepEqual(stats.messages, { system: 1, user: 1, assistant: 1, tool: 0, total: 3 });
  assert.deepEqual(stats.tools, { calls: 0, results: 0 });
  assert.equal(stats.runs.total, 1);
  assert.equal(stats.runs.completed, 1);
  assert.deepEqual(stats.tokens, {
    input: 100,
    output: 20,
    total: 150,
    cacheRead: 30,
    cacheWrite: 0,
    reasoning: 5,
  });
  assert.equal(stats.cost, "0.01");
  assert.deepEqual(stats.contextUsage, { tokens: 130, contextWindow: 100_000, percent: 0.1 });
  assert.deepEqual(await dispatcher.dispatch(peer, request("thread.lastAssistantText", { threadId: started.threadId })), {
    text: "statistics answer",
  });
});
