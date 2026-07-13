import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntimeExtensions } from "../../src/extensions/runtime.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { ScriptedProvider } from "../../src/testing/scripted-provider.js";
import { sha256 } from "../../src/tools/hash.js";
import type { HarnessTool } from "../../src/tools/types.js";
import type { ProviderAdapter } from "../../src/core/types.js";

interface RecordedLifecycleEvent {
  name: string;
  event: Record<string, any>;
}

const lifecycleExtension = `export default (api) => {
  const record = (name, event) => {
    globalThis.__runtimeLifecycleEvents ??= [];
    globalThis.__runtimeLifecycleEvents.push({ name, event });
  };
  for (const name of [
    "session_start", "session_end", "session_shutdown", "agent_start", "agent_end", "agent_settled",
    "turn_start", "turn_end", "message_start", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end", "model_select",
    "thinking_level_select", "user_shell", "event"
  ]) api.on(name, (event) => { record(name, event); });
  api.on("message_update", () => { throw new Error("lifecycle observer failed"); });
  api.registerTool({
    name: "lifecycle_echo",
    description: "Return one bounded value",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "string" } }
    },
    execute(input, context) {
      context.reportProgress({ type: "output", stream: "stdout", delta: "working", stdoutBytes: 7, stderrBytes: 0 });
      return { content: input.value, isError: false };
    }
  });
};
`;

function indexOf(
  events: readonly RecordedLifecycleEvent[],
  name: string,
  predicate: (event: Record<string, any>) => boolean = () => true,
): number {
  return events.findIndex((entry) => entry.name === name && predicate(entry.event));
}

test("typed runtime lifecycle events follow durable agent, message, and tool boundaries", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-lifecycle-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "lifecycle.mjs");
  await writeFile(sourcePath, lifecycleExtension);
  const host = await loadRuntimeExtensions([{
    extensionId: "lifecycle",
    sourcePath,
    sha256: sha256(lifecycleExtension),
  }], { workspace: root });
  const provider = new ScriptedProvider({
    models: [{ id: "lifecycle-model", capabilities: { tools: "supported", reasoning: "supported" } }],
    scripts: [
      {
        kind: "turn",
        content: [{ type: "tool_call", id: "lifecycle-call", name: "lifecycle_echo", arguments: { value: "tool output" } }],
        terminal: { type: "finish", reason: "tool_calls" },
      },
      { kind: "turn", content: [{ type: "text", text: "finished" }] },
    ],
  });
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    runtimeExtensions: host,
    managedExtensionLifecycle: true,
    extraTools: host.tools(),
  });
  await service.initialize();
  (globalThis as Record<string, unknown>).__runtimeLifecycleEvents = [];

  try {
    const run = await service.run({
      prompt: "exercise lifecycle",
      provider: provider.id,
      model: "lifecycle-model",
      reasoningEffort: "high",
      allowedTools: ["lifecycle_echo"],
    });
    assert.equal(run.results[0]?.finalText, "finished");
    const durableProgress = store.listEvents(run.threadId).find((entry) => entry.event.type === "tool_progress");
    assert.equal(
      durableProgress?.event.type === "tool_progress" && durableProgress.event.progress.type === "output"
        ? durableProgress.event.progress.delta
        : undefined,
      "working",
    );
    await host.dispatch("event", {
      type: "user_shell",
      command: "printf fixture",
      hidden: false,
      result: { text: "fixture", exitCode: 0 },
    });
    await service.close();
    await host.close();

    const events = (globalThis as Record<string, unknown>).__runtimeLifecycleEvents as RecordedLifecycleEvent[];
    const sessionStart = indexOf(events, "session_start");
    const modelSelect = indexOf(events, "model_select");
    const thinkingSelect = indexOf(events, "thinking_level_select");
    const agentStart = indexOf(events, "agent_start");
    const firstTurnStart = indexOf(events, "turn_start", (event) => event.step === 1);
    const firstMessageStart = indexOf(events, "message_start", (event) => event.step === 1);
    const firstAssistantEnd = indexOf(events, "message_end", (event) => event.message?.role === "assistant");
    const firstTurnEnd = indexOf(events, "turn_end", (event) => event.step === 1);
    const toolStart = indexOf(events, "tool_execution_start");
    const toolUpdate = indexOf(events, "tool_execution_update");
    const toolProgress = indexOf(events, "tool_execution_update", (event) => event.phase === "progress");
    const toolEnd = indexOf(events, "tool_execution_end");
    const secondTurnStart = indexOf(events, "turn_start", (event) => event.step === 2);
    const textUpdate = indexOf(events, "message_update", (event) => event.step === 2 && event.kind === "text");
    const secondTurnEnd = indexOf(events, "turn_end", (event) => event.step === 2);
    const agentEnd = indexOf(events, "agent_end");
    const agentSettled = indexOf(events, "agent_settled");
    const userShell = indexOf(events, "user_shell");
    const sessionEnd = indexOf(events, "session_end");
    const shutdown = indexOf(events, "session_shutdown");

    for (const index of [
      sessionStart, modelSelect, thinkingSelect, agentStart, firstTurnStart, firstMessageStart,
      firstAssistantEnd, firstTurnEnd, toolStart, toolUpdate, toolProgress, toolEnd, secondTurnStart,
      textUpdate, secondTurnEnd, agentEnd, agentSettled, userShell, sessionEnd, shutdown,
    ]) assert.notEqual(index, -1);
    assert.ok(sessionStart < modelSelect && modelSelect < thinkingSelect && thinkingSelect < agentStart);
    assert.ok(agentStart < firstTurnStart && firstTurnStart < firstMessageStart);
    assert.ok(firstMessageStart < firstAssistantEnd && firstAssistantEnd < firstTurnEnd);
    assert.ok(firstTurnEnd < toolStart && toolStart < toolUpdate && toolUpdate < toolProgress && toolProgress < toolEnd);
    assert.ok(toolEnd < secondTurnStart && secondTurnStart < textUpdate && textUpdate < secondTurnEnd);
    assert.ok(secondTurnEnd < agentEnd && agentEnd < agentSettled);
    assert.ok(agentSettled < sessionEnd && sessionEnd < shutdown);

    assert.deepEqual(events[modelSelect]!.event, {
      threadId: run.threadId,
      provider: provider.id,
      model: "lifecycle-model",
      source: "run",
    });
    assert.equal(events[thinkingSelect]!.event.level, "high");
    assert.equal(events[toolStart]!.event.invocation.input.value, "tool output");
    assert.equal(events[toolUpdate]!.event.phase, "running");
    assert.deepEqual(events[toolProgress]!.event.progress, {
      type: "output",
      stream: "stdout",
      delta: "working",
      stdoutBytes: 7,
      stderrBytes: 0,
    });
    assert.equal(events[toolProgress]!.event.sequence, 0);
    assert.equal(events[toolEnd]!.event.outcome.status, "completed");
    assert.equal(events[agentEnd]!.event.outcome.status, "completed");
    assert.equal(events[shutdown]!.event.reason, "host_close");
    assert.equal(host.diagnostics().some((entry) => entry.message.includes("lifecycle observer failed")), true);
  } finally {
    await service.close();
    await host.close();
    store.close();
    delete (globalThis as Record<string, unknown>).__runtimeLifecycleEvents;
  }
});

test("failed and cancelled runs settle once and close pending lifecycle phases", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-lifecycle-terminal-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "lifecycle.mjs");
  await writeFile(sourcePath, lifecycleExtension);
  const host = await loadRuntimeExtensions([{
    extensionId: "lifecycle-terminal",
    sourcePath,
    sha256: sha256(lifecycleExtension),
  }], { workspace: root });
  let toolStarted!: () => void;
  const toolRunning = new Promise<void>((resolve) => { toolStarted = resolve; });
  const blockingTool: HarnessTool = {
    definition: {
      name: "blocking_fixture",
      description: "Wait until the run is cancelled",
      inputSchema: { type: "object", additionalProperties: false },
    },
    validate() {},
    resources() { return []; },
    async execute(_input, toolContext) {
      toolStarted();
      toolContext.signal.throwIfAborted();
      return await new Promise<never>((_, reject) => {
        toolContext.signal.addEventListener("abort", () => {
          reject(toolContext.signal.reason ?? new Error("blocking fixture cancelled"));
        }, { once: true });
      });
    },
  };
  const provider = new ScriptedProvider({
    models: [{ id: "lifecycle-model", capabilities: { tools: "supported" } }],
    scripts: [
      {
        kind: "turn",
        content: [{ type: "tool_call", id: "blocking-call", name: "blocking_fixture", arguments: {} }],
        terminal: { type: "finish", reason: "tool_calls" },
      },
      {
        kind: "turn",
        terminal: {
          type: "error",
          error: {
            category: "invalid_request",
            message: "fixture provider failure",
            retryable: false,
            partial: true,
            bodyStarted: true,
          },
        },
      },
      {
        kind: "turn",
        content: [{ type: "text", text: "too late" }],
        eventDelayMs: 1_000,
      },
    ],
  });
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    runtimeExtensions: host,
    extraTools: [...host.tools(), blockingTool],
  });
  await service.initialize();
  (globalThis as Record<string, unknown>).__runtimeLifecycleEvents = [];

  try {
    const toolThread = (await service.createSession()).threadId;
    const toolRun = service.run({
      threadId: toolThread,
      prompt: "run blocking tool",
      provider: provider.id,
      model: "lifecycle-model",
      allowedTools: ["blocking_fixture"],
    });
    await toolRunning;
    service.cancel(toolThread, "cancel blocking lifecycle fixture");
    assert.equal((await toolRun).results[0]?.finishReason, "cancelled");

    const failedThread = (await service.createSession()).threadId;
    await assert.rejects(service.run({
      threadId: failedThread,
      prompt: "fail provider",
      provider: provider.id,
      model: "lifecycle-model",
    }), /fixture provider failure/u);

    const pendingThread = (await service.createSession()).threadId;
    const pendingRun = service.run({
      threadId: pendingThread,
      prompt: "cancel provider turn",
      provider: provider.id,
      model: "lifecycle-model",
    });
    let turnObserved = false;
    const turnDeadline = Date.now() + 5_000;
    while (Date.now() < turnDeadline) {
      const entries = (globalThis as Record<string, unknown>).__runtimeLifecycleEvents as RecordedLifecycleEvent[];
      if (entries.some((entry) => entry.name === "turn_start" && entry.event.threadId === pendingThread)) {
        turnObserved = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(turnObserved, true);
    service.cancel(pendingThread, `cancel pending provider turn ${"x".repeat(32 * 1024)}`);
    assert.equal((await pendingRun).results[0]?.finishReason, "cancelled");

    const events = (globalThis as Record<string, unknown>).__runtimeLifecycleEvents as RecordedLifecycleEvent[];
    for (const [threadId, status] of [
      [toolThread, "cancelled"],
      [failedThread, "failed"],
      [pendingThread, "cancelled"],
    ] as const) {
      const ended = events.filter((entry) => entry.name === "agent_end" && entry.event.threadId === threadId);
      const settled = events.filter((entry) => entry.name === "agent_settled" && entry.event.threadId === threadId);
      assert.equal(ended.length, 1);
      assert.equal(settled.length, 1);
      assert.equal(ended[0]!.event.outcome.status, status);
      assert.equal(settled[0]!.event.outcome.status, status);
    }
    const boundedCancellation = events.find((entry) =>
      entry.name === "agent_end" && entry.event.threadId === pendingThread)!.event.outcome.reason as string;
    assert.ok(Buffer.byteLength(boundedCancellation, "utf8") <= 16 * 1024);
    assert.match(boundedCancellation, /\.\.\.$/u);
    const toolEnd = events.find((entry) =>
      entry.name === "tool_execution_end" && entry.event.threadId === toolThread);
    assert.equal(toolEnd?.event.outcome.status, "interrupted");
    const cancelledTurn = events.find((entry) =>
      entry.name === "turn_end" && entry.event.threadId === pendingThread);
    assert.equal(cancelledTurn?.event.outcome.status, "failed");
    assert.equal(cancelledTurn?.event.outcome.error.category, "cancelled");
    const failedTurn = events.find((entry) =>
      entry.name === "turn_end" && entry.event.threadId === failedThread);
    assert.equal(failedTurn?.event.outcome.status, "failed");
    assert.equal(failedTurn?.event.outcome.error.message, "fixture provider failure");
    assert.equal(store.listEvents(toolThread).some((entry) => entry.event.type === "run_cancelled"), true);
    assert.equal(store.listEvents(failedThread).some((entry) => entry.event.type === "run_failed"), true);
    assert.equal(store.listEvents(pendingThread).some((entry) => entry.event.type === "run_cancelled"), true);
  } finally {
    await service.close();
    await host.close();
    store.close();
    delete (globalThis as Record<string, unknown>).__runtimeLifecycleEvents;
  }
});

test("service cancellation interrupts a hung runtime lifecycle observer", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-lifecycle-cancel-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  let observerStarted!: () => void;
  const observerReady = new Promise<void>((resolve) => { observerStarted = resolve; });
  (globalThis as Record<string, unknown>).__hungLifecycleObserverStarted = observerStarted;
  const source = `export default (api) => api.on("agent_start", (_event, context) => {
    globalThis.__hungLifecycleObserverSignal = context.signal;
    globalThis.__hungLifecycleObserverStarted();
    return new Promise(() => {});
  });\n`;
  const sourcePath = join(root, "hung-lifecycle.mjs");
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "hung-lifecycle",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root });
  const provider = new ScriptedProvider({
    models: [{ id: "lifecycle-model" }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "too late" }] }],
  });
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    runtimeExtensions: host,
  });
  await service.initialize();

  try {
    const threadId = (await service.createSession()).threadId;
    const run = service.run({
      threadId,
      prompt: "cancel a hung observer",
      provider: provider.id,
      model: "lifecycle-model",
    });
    await observerReady;
    service.cancel(threadId, "cancel hung lifecycle observer");
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("cancelled run did not settle")), 2_000).unref();
    });
    assert.equal((await Promise.race([run, timeout])).results[0]?.finishReason, "cancelled");
    assert.equal(((globalThis as Record<string, unknown>).__hungLifecycleObserverSignal as AbortSignal).aborted, true);
    assert.ok(host.diagnostics().some((entry) => entry.message.includes("agent_start")));
  } finally {
    await service.close();
    await host.close();
    store.close();
    delete (globalThis as Record<string, unknown>).__hungLifecycleObserverStarted;
    delete (globalThis as Record<string, unknown>).__hungLifecycleObserverSignal;
  }
});

test("provider boundary hooks run in canonical order, clear continuation, and isolate after observers", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-provider-boundary-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const order: string[] = [];
  (globalThis as Record<string, unknown>).__providerBoundaryLifecycleOrder = order;
  const source = `export default (api) => {
    api.registerTool({
      name: "boundary_echo",
      description: "Return a boundary marker",
      inputSchema: { type: "object", additionalProperties: false },
      execute() { globalThis.__providerBoundaryLifecycleOrder.push("tool"); return { content: "ok", isError: false }; },
    });
    api.on("before_provider_request", (event) => {
      globalThis.__providerBoundaryLifecycleOrder.push("before:" + event.step);
      globalThis.__providerBoundaryRequestKeys = Object.keys(event.request).sort();
      return {
        tools: event.request.tools.map((tool) => ({ ...tool, description: tool.description + " patched" })),
        maxOutputTokens: 4096,
        reasoningEffort: "high",
        metadata: { boundary: "safe" },
      };
    });
    api.on("after_provider_response", (event) => {
      globalThis.__providerBoundaryLifecycleOrder.push("after:" + event.step + ":" + event.finishReason);
      globalThis.__providerBoundaryAfter = event;
      if (event.step === 1) throw new Error("after observer fixture failure");
    });
  };\n`;
  const sourcePath = join(root, "provider-boundary.mjs");
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "provider-boundary",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root });
  const scripted = new ScriptedProvider({
    id: "boundary-provider",
    models: [{ id: "boundary-model", maxOutputTokens: 64 }],
    scripts: [
      {
        kind: "turn",
        content: [{ type: "tool_call", id: "boundary-call", name: "boundary_echo", arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      },
      {
        kind: "turn",
        content: [{ type: "text", text: "boundary complete" }],
        usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
      },
    ],
  });
  const provider: ProviderAdapter = {
    id: scripted.id,
    stream(request, signal) {
      order.push(`provider:${scripted.capturedRequests().length + 1}`);
      return scripted.stream(request, signal);
    },
    async listModels(signal) { return await scripted.listModels(signal); },
  };
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    runtimeExtensions: host,
    extraTools: host.tools(),
  });
  await service.initialize();

  try {
    const run = await service.run({
      prompt: "exercise provider hooks",
      provider: provider.id,
      model: "boundary-model",
      maxOutputTokens: 32,
      reasoningEffort: "low",
      allowedTools: ["boundary_echo"],
    });
    assert.equal(run.results[0]?.finalText, "boundary complete");
    assert.deepEqual(order, [
      "before:1", "provider:1", "after:1:tool_calls", "tool",
      "before:2", "provider:2", "after:2:stop",
    ]);
    assert.deepEqual((globalThis as Record<string, unknown>).__providerBoundaryRequestKeys, [
      "maxOutputTokens", "messages", "reasoningEffort", "tools",
    ]);
    const requests = scripted.capturedRequests();
    assert.equal(requests[0]?.reasoningEffort, "high");
    assert.equal(requests[0]?.metadata?.boundary, "safe");
    assert.equal(requests[0]?.maxOutputTokens, 64);
    assert.equal(requests[0]?.tools[0]?.description.endsWith(" patched"), true);
    assert.equal(requests[1]?.providerState, undefined);
    assert.equal(requests[1]?.maxOutputTokens, 64);
    assert.equal(requests[1]?.reasoningEffort, "high");
    const after = (globalThis as Record<string, unknown>).__providerBoundaryAfter as Record<string, any>;
    assert.deepEqual(after.usage, { inputTokens: 20, outputTokens: 3, totalTokens: 23 });
    assert.equal("headers" in after || "authorization" in after || "providerState" in after, false);
    assert.ok(host.diagnostics().some((entry) => entry.message.includes("after observer fixture failure")));
  } finally {
    await service.close();
    await host.close();
    store.close();
    delete (globalThis as Record<string, unknown>).__providerBoundaryLifecycleOrder;
    delete (globalThis as Record<string, unknown>).__providerBoundaryRequestKeys;
    delete (globalThis as Record<string, unknown>).__providerBoundaryAfter;
  }
});

test("service cancellation interrupts a hung after-provider response observer", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harness-provider-response-cancel-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  let observerStarted!: () => void;
  const observerReady = new Promise<void>((resolve) => { observerStarted = resolve; });
  (globalThis as Record<string, unknown>).__afterProviderObserverStarted = observerStarted;
  const source = `export default (api) => api.on("after_provider_response", (_event, context) => {
    globalThis.__afterProviderObserverSignal = context.signal;
    globalThis.__afterProviderObserverStarted();
    return new Promise(() => {});
  });\n`;
  const sourcePath = join(root, "after-provider-hung.mjs");
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "after-provider-hung",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root });
  const provider = new ScriptedProvider({
    id: "after-provider-cancel",
    models: [{ id: "model" }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "normalized" }] }],
  });
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    runtimeExtensions: host,
  });
  await service.initialize();

  try {
    const threadId = (await service.createSession()).threadId;
    const running = service.run({ threadId, prompt: "cancel observer", provider: provider.id, model: "model" });
    await observerReady;
    service.cancel(threadId, "cancel hung after-provider observer");
    assert.equal((await running).results[0]?.finishReason, "cancelled");
    assert.equal(((globalThis as Record<string, unknown>).__afterProviderObserverSignal as AbortSignal).aborted, true);
  } finally {
    await service.close();
    await host.close();
    store.close();
    delete (globalThis as Record<string, unknown>).__afterProviderObserverStarted;
    delete (globalThis as Record<string, unknown>).__afterProviderObserverSignal;
  }
});
