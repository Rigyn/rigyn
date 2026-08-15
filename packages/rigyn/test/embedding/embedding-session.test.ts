import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";

import {
  createEmbeddingHarnessFromRuntime,
} from "../../src/embedding/index.js";
import type { EventEnvelope } from "../../src/core/events.js";
import { defineTool } from "../../src/extensions/direct.js";
import type { HarnessRuntime } from "../../src/public-runtime.js";
import { createHarnessRuntime } from "../../src/public-runtime.js";
import {
  AgentSession,
  type AgentSessionModel,
  type AgentSessionRecoveryOptions,
  type AgentSessionRecoveryResult,
  type AgentSessionSuspendedRun,
} from "../../src/service/agent-session.js";
import { MAX_TOOL_RESULT_CONTENT_BYTES } from "../../src/tools/coordinator.js";
import { createInMemoryHarness } from "../../src/embedding/index.js";
import { createScriptedProvider } from "../../src/testing/scripted-provider.js";

function fakeSession(id: string) {
  const calls: string[] = [];
  const listeners = new Set<(event: EventEnvelope) => Promise<void> | void>();
  const recoveryOptions: AgentSessionRecoveryOptions[] = [];
  let recoveryResult: AgentSessionRecoveryResult = { recovered: false, blocked: [] };
  let suspendedRun: AgentSessionSuspendedRun | undefined;
  const selected: AgentSessionModel = {
    provider: "fixture-provider",
    api: "openai-chat-completions",
    id: `${id}-model`,
  };
  const session = {
    sessionId: id,
    cwd: `/workspace/${id}`,
    model: selected,
    isIdle: true,
    get suspendedRun() { return suspendedRun; },
    async recoverInterruptedRun(options: AgentSessionRecoveryOptions = {}) {
      recoveryOptions.push(options);
      return recoveryResult;
    },
    async waitForIdle() { calls.push("idle"); },
    async resolveModel(reference: string) {
      calls.push(`resolve:${reference}`);
      return { ...selected, id: reference };
    },
    async setModel(model: AgentSessionModel) { calls.push(`set:${model.id}`); },
    setThinkingLevel(level: string) { calls.push(`thinking:${level}`); },
    setSessionName(name: string) { calls.push(`name:${name}`); },
    onEvent(listener: (event: EventEnvelope) => Promise<void> | void) {
      calls.push("subscribe");
      listeners.add(listener);
      return () => {
        calls.push("unsubscribe");
        listeners.delete(listener);
      };
    },
    steer(text: string) { calls.push(`steer:${text}`); },
    followUp(text: string) { calls.push(`follow:${text}`); },
    abort(reason?: string) { calls.push(`abort:${reason ?? ""}`); },
    cancelRetry() { return false; },
    prompt() { throw new Error("not used by this boundary test"); },
  } as unknown as AgentSession;
  return {
    session,
    calls,
    recoveryOptions,
    setRecoveryResult(value: AgentSessionRecoveryResult) { recoveryResult = value; },
    setSuspendedRun(value: AgentSessionSuspendedRun | undefined) { suspendedRun = value; },
    get listenerCount() { return listeners.size; },
    async emit(sequence: number) {
      const event = {
        eventId: `event-${id}-${sequence}`,
        threadId: `thread-${id}`,
        sequence,
        timestamp: new Date(sequence).toISOString(),
        schemaVersion: 1,
        event: { type: "warning", code: id, message: id },
      } as EventEnvelope;
      for (const listener of listeners) await listener(event);
    },
  };
}

test("configured embedding sessions remain live when refresh replaces the runtime session", async () => {
  let current = fakeSession("before");
  const replacement = fakeSession("after");
  const runtime = {
    get session() { return current.session; },
    async refresh() { current = replacement; return { warnings: [] }; },
    async close() {},
  } as unknown as HarnessRuntime;

  const harness = createEmbeddingHarnessFromRuntime(runtime);
  const session = harness.session;
  assert.equal(session, harness.session);
  assert.equal(session.id, "before");

  await session.waitForIdle();
  assert.deepEqual(current.calls, ["idle"]);

  await harness.refresh();
  assert.equal(session.id, "after");
  assert.equal(session.cwd, "/workspace/after");
  assert.equal((await session.resolveModel("selected")).id, "selected");
  await session.setModel({ provider: "fixture-provider", api: "openai-chat-completions", id: "selected" });
  const steering = session.steer("adjust");
  const followUp = session.followUp("continue");
  assert.equal(steering instanceof Promise, true);
  assert.equal(followUp instanceof Promise, true);
  await Promise.all([steering, followUp]);
  assert.deepEqual(replacement.calls, ["resolve:selected", "set:selected", "steer:adjust", "follow:continue"]);
});

test("embedding exposes explicit recovery through the current session without implicit abandonment", async () => {
  let current = fakeSession("before-recovery");
  const previous = current;
  const replacement = fakeSession("after-recovery");
  previous.setSuspendedRun({
    operationId: "run-before",
    acceptedAt: "2026-08-08T12:00:00.000Z",
    cancelled: true,
    attempts: 1,
    claimedQueueIds: [],
    effects: [{
      effectId: "effect-before",
      callId: "call-before",
      name: "write",
      policy: "never_repeat",
      status: "in_doubt",
      step: 0,
      index: 0,
      inputHash: "a".repeat(64),
    }],
  });
  replacement.setSuspendedRun({
    operationId: "run-after",
    acceptedAt: "2026-08-08T12:01:00.000Z",
    cancelled: false,
    attempts: 0,
    claimedQueueIds: ["queue-after"],
    effects: [],
  });
  const runtime = {
    get session() { return current.session; },
    async refresh() { current = replacement; return { warnings: [] }; },
    async close() {},
  } as unknown as HarnessRuntime;
  const harness = createEmbeddingHarnessFromRuntime(runtime);

  assert.equal(harness.session.suspendedRun?.operationId, "run-before");
  harness.session.abort("caller cancelled");
  assert.equal(previous.recoveryOptions.length, 0, "abort must not choose a recovery outcome");

  previous.setRecoveryResult({ recovered: true, operationId: "run-before", blocked: [] });
  assert.deepEqual(await harness.session.recoverInterruptedRun({
    resolutions: [{ effectId: "effect-before", outcome: "abandoned" }],
  }), {
    recovered: true,
    operationId: "run-before",
    blocked: [],
  });
  assert.deepEqual(previous.recoveryOptions[0]?.resolutions, [{
    effectId: "effect-before",
    outcome: "abandoned",
  }]);

  await harness.refresh();
  assert.equal(harness.session.suspendedRun?.operationId, "run-after");
  replacement.setRecoveryResult({
    recovered: false,
    operationId: "run-after",
    blocked: [],
  });
  await harness.session.recoverInterruptedRun();
  assert.equal(replacement.recoveryOptions.length, 1);
  assert.equal(previous.recoveryOptions.length, 1);
  await harness.close();
});

test("the in-memory embedding facade preserves bounded recovery retry semantics", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const provider = createScriptedProvider({
    id: "embedding-recovery-bounds",
    models: [{ id: "fixture" }],
    scripts: [{
      kind: "turn",
      content: [{
        type: "tool_call",
        id: "embedding-recovery-call",
        name: "embedding_recovery_probe",
        arguments: {},
      }],
      terminal: { type: "finish", reason: "tool_calls" },
    }],
  });
  const tool = defineTool({
    name: "embedding_recovery_probe",
    label: "Embedding recovery probe",
    description: "Wait until the embedding caller interrupts the effect",
    parameters: Type.Object({}, { additionalProperties: false }),
    recovery: { mode: "never_repeat" },
    async execute(_callId, _input, signal) {
      markStarted();
      return await new Promise<never>((_resolve, reject) => {
        const cancel = (): void => reject(signal?.reason ?? new Error("embedding tool cancelled"));
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
      });
    },
  });
  await using harness = await createInMemoryHarness({
    provider,
    model: "fixture",
    api: "openai-chat-completions",
    customTools: [tool],
    enabledTools: [tool.name],
  });

  const running = harness.session.run({ prompt: "start an uncertain embedding effect" });
  await started;
  harness.session.abort("embedding caller interrupted");
  await running;
  await harness.session.waitForIdle();
  const before = harness.session.suspendedRun;
  assert.equal(before?.effects.length, 1);
  const effectId = before?.effects[0]?.effectId;
  assert.equal(typeof effectId, "string");

  await assert.rejects(
    harness.session.recoverInterruptedRun({
      resolutions: [{
        effectId: effectId!,
        outcome: "succeeded",
        result: {
          content: "x".repeat(MAX_TOOL_RESULT_CONTENT_BYTES + 1),
          isError: false,
        },
      }],
    }),
    /Recovery tool result content exceeds/u,
  );
  assert.deepEqual(
    harness.session.suspendedRun,
    before,
    "the embedding facade must not partially recover invalid caller input",
  );

  assert.deepEqual(await harness.session.recoverInterruptedRun({
    resolutions: [{
      effectId: effectId!,
      outcome: "succeeded",
      result: {
        content: "embedding caller verified the effect",
        isError: false,
        status: "success",
        metadata: { source: "embedding" },
      },
    }],
  }), {
    recovered: true,
    operationId: before?.operationId,
    blocked: [],
  });
  assert.equal(harness.session.suspendedRun, undefined);
});

test("configured embedding subscriptions follow replacement sessions and dispose cleanly", async () => {
  let current = fakeSession("before-subscription");
  const previous = current;
  const replacement = fakeSession("after-subscription");
  const runtime = {
    get session() { return current.session; },
    async refresh(options: { beforeSessionStart?: (session: AgentSession) => void | Promise<void> } = {}) {
      await options.beforeSessionStart?.(replacement.session);
      await replacement.emit(2);
      current = replacement;
      return { warnings: [] };
    },
    async close() {},
  } as unknown as HarnessRuntime;

  const harness = createEmbeddingHarnessFromRuntime(runtime);
  const sequences: number[] = [];
  const unsubscribe = harness.session.subscribe((event) => { sequences.push(event.sequence); });
  assert.equal(previous.listenerCount, 1);
  await previous.emit(1);

  await harness.refresh();
  assert.equal(previous.listenerCount, 0);
  assert.equal(replacement.listenerCount, 1);
  await replacement.emit(3);
  assert.deepEqual(sequences, [1, 2, 3]);

  unsubscribe();
  assert.equal(replacement.listenerCount, 0);
  await replacement.emit(4);
  assert.deepEqual(sequences, [1, 2, 3]);

  harness.session.subscribe((event) => { sequences.push(event.sequence); });
  await harness.close();
  assert.equal(replacement.listenerCount, 0);
  await replacement.emit(5);
  assert.deepEqual(sequences, [1, 2, 3]);
  assert.throws(() => harness.session.subscribe(() => undefined), /Embedding session is closed/u);
});

test("embedding refresh reconciles subscriptions added after early candidate binding", async () => {
  let current = fakeSession("before-late-subscription");
  const previous = current;
  const replacement = fakeSession("after-late-subscription");
  let reportCandidate!: () => void;
  const candidateBound = new Promise<void>((resolve) => { reportCandidate = resolve; });
  let publishCandidate!: () => void;
  const publication = new Promise<void>((resolve) => { publishCandidate = resolve; });
  const runtime = {
    get session() { return current.session; },
    async refresh(options: { beforeSessionStart?: (session: AgentSession) => void | Promise<void> } = {}) {
      await options.beforeSessionStart?.(replacement.session);
      reportCandidate();
      await publication;
      current = replacement;
      return { warnings: [] };
    },
    async close() {},
  } as unknown as HarnessRuntime;
  const harness = createEmbeddingHarnessFromRuntime(runtime);
  const sequences: number[] = [];

  const refresh = harness.refresh();
  await candidateBound;
  harness.session.subscribe((event) => { sequences.push(event.sequence); });
  assert.equal(previous.listenerCount, 1);
  assert.equal(replacement.listenerCount, 0);

  publishCandidate();
  await refresh;
  assert.equal(previous.listenerCount, 0);
  assert.equal(replacement.listenerCount, 1);
  await replacement.emit(1);
  assert.deepEqual(sequences, [1]);
  await harness.close();
});

test("embedding refresh restores subscriptions when a prepared candidate is rejected", async () => {
  const current = fakeSession("before-rejected-candidate");
  const replacement = fakeSession("rejected-candidate");
  const runtime = {
    get session() { return current.session; },
    async refresh(options: { beforeSessionStart?: (session: AgentSession) => void | Promise<void> } = {}) {
      await options.beforeSessionStart?.(replacement.session);
      throw new Error("candidate rejected");
    },
    async close() {},
  } as unknown as HarnessRuntime;
  const harness = createEmbeddingHarnessFromRuntime(runtime);
  const sequences: number[] = [];
  harness.session.subscribe((event) => { sequences.push(event.sequence); });

  await assert.rejects(harness.refresh(), /candidate rejected/u);
  assert.equal(current.listenerCount, 1);
  assert.equal(replacement.listenerCount, 0);
  await current.emit(1);
  assert.deepEqual(sequences, [1]);
  await harness.close();
});

test("configured embedding startup and refresh apply persistent tool settings", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-embedding-tool-settings-"));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  await writeFile(join(agentDirectory, "config.json"), JSON.stringify({
    tools: { enabled: ["read", "bash"], excluded: ["bash"] },
  }));
  const previousAgentDirectory = process.env.RIGYN_HOME;
  process.env.RIGYN_HOME = agentDirectory;
  let harness: ReturnType<typeof createEmbeddingHarnessFromRuntime> | undefined;
  context.after(async () => {
    await harness?.close().catch(() => undefined);
    if (previousAgentDirectory === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDirectory;
    await rm(root, { recursive: true, force: true });
  });

  const runtimeOptions = {
    workspace,
    ephemeral: true,
    projectTrusted: false,
    extensions: false,
    skills: false,
    promptTemplates: false,
    themes: false,
    offline: true,
  } as const;
  const runtime = await createHarnessRuntime(runtimeOptions);
  harness = createEmbeddingHarnessFromRuntime(runtime);
  assert.deepEqual(runtime.session.getActiveTools(), ["read"]);

  await writeFile(join(agentDirectory, "config.json"), JSON.stringify({
    tools: { enabled: ["write"], excluded: [] },
  }));
  await harness.refresh();
  assert.deepEqual(runtime.session.getActiveTools(), ["write"]);
});

test("configured public runtimes bind direct extensions once and preserve the lifecycle across refresh", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-embedding-extension-lifecycle-"));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  const extensionPath = join(root, "lifecycle.mjs");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  await writeFile(extensionPath, `export default (api) => {
    globalThis.__rigynEmbeddingLifecycle ??= [];
    globalThis.__rigynEmbeddingGeneration ??= 0;
    const generation = ++globalThis.__rigynEmbeddingGeneration;
    const lifecycle = globalThis.__rigynEmbeddingLifecycle;
    lifecycle.push(generation + ":activate");
    api.on("session_start", (event, extensionContext) => {
      lifecycle.push(generation + ":start:" + event.reason + ":" + extensionContext.mode);
    });
    api.on("session_shutdown", (event, extensionContext) => {
      lifecycle.push(generation + ":shutdown:" + event.reason);
      if (event.reason === "quit") extensionContext.shutdown();
    });
    api.registerCommand("embedding-lifecycle", {
      handler() { lifecycle.push(generation + ":command"); },
    });
    api.registerProvider("embedding-lifecycle-provider", {
      api: "openai-responses",
      apiKey: "fixture-key",
      baseUrl: "https://example.invalid/v1",
      models: [{
        id: "lifecycle-model",
        name: "Lifecycle model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8000,
        maxTokens: 1000,
      }],
      streamSimple: async function* () {
        yield { type: "response_start", model: "lifecycle-model" };
        yield { type: "text_delta", part: 0, text: "complete" };
        yield { type: "response_end", reason: "stop", state: { kind: "openai_responses", outputItems: [] } };
      },
    });
    api.onDispose(() => { lifecycle.push(generation + ":dispose"); });
  };\n`);
  const previousAgentDirectory = process.env.RIGYN_HOME;
  process.env.RIGYN_HOME = agentDirectory;
  let runtime: HarnessRuntime | undefined;
  context.after(async () => {
    await runtime?.close().catch(() => undefined);
    if (previousAgentDirectory === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDirectory;
    delete (globalThis as Record<string, unknown>).__rigynEmbeddingLifecycle;
    delete (globalThis as Record<string, unknown>).__rigynEmbeddingGeneration;
    await rm(root, { recursive: true, force: true });
  });

  runtime = await createHarnessRuntime({
    workspace,
    projectTrusted: true,
    ephemeral: true,
    extensions: false,
    extensionPaths: [extensionPath],
    skills: false,
    promptTemplates: false,
    themes: false,
  });
  const lifecycle = (globalThis as Record<string, unknown>).__rigynEmbeddingLifecycle as string[];
  const observedRuns: string[] = [];
  const unsubscribe = runtime.onEvent((envelope) => {
    if (envelope.event.type === "run_completed") observedRuns.push(envelope.threadId);
  });
  assert.deepEqual(lifecycle, [
    "1:activate",
    "1:start:startup:sdk",
  ]);

  await runtime.setModel(await runtime.resolveModel(
    "lifecycle-model",
    { provider: "embedding-lifecycle-provider" },
  ));
  await runtime.prompt("before refresh").result;
  await runtime.session.prompt("/embedding-lifecycle");
  await runtime.refresh();
  await runtime.prompt("after refresh").result;
  await runtime.session.prompt("/embedding-lifecycle");
  assert.equal(observedRuns.length, 2);
  unsubscribe();

  assert.deepEqual(lifecycle, [
    "1:activate",
    "1:start:startup:sdk",
    "1:command",
    "1:shutdown:refresh",
    "2:activate",
    "1:dispose",
    "2:start:refresh:sdk",
    "2:command",
  ]);
  assert.equal(lifecycle.filter((entry) => entry === "1:start:startup:sdk").length, 1);
  assert.equal(lifecycle.filter((entry) => entry === "2:start:refresh:sdk").length, 1);
  await runtime.close();
  await runtime.close();
  runtime = undefined;
  assert.deepEqual(lifecycle.slice(-2), [
    "2:shutdown:quit",
    "2:dispose",
  ]);
});

test("configured public runtime creation rejects a startup extension shutdown without double-dispatching", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-embedding-extension-startup-shutdown-"));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  const extensionPath = join(root, "shutdown.mjs");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  await writeFile(extensionPath, `export default (api) => {
    globalThis.__rigynEmbeddingStartupShutdown ??= [];
    const lifecycle = globalThis.__rigynEmbeddingStartupShutdown;
    lifecycle.push("activate");
    api.on("session_start", (_event, extensionContext) => {
      lifecycle.push("start");
      extensionContext.shutdown();
    });
    api.on("session_shutdown", (event) => { lifecycle.push("shutdown:" + event.reason); });
    api.onDispose(() => { lifecycle.push("dispose"); });
  };\n`);
  const previousAgentDirectory = process.env.RIGYN_HOME;
  process.env.RIGYN_HOME = agentDirectory;
  context.after(async () => {
    if (previousAgentDirectory === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDirectory;
    delete (globalThis as Record<string, unknown>).__rigynEmbeddingStartupShutdown;
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(createHarnessRuntime({
    workspace,
    projectTrusted: true,
    ephemeral: true,
    extensions: false,
    extensionPaths: [extensionPath],
    skills: false,
    promptTemplates: false,
    themes: false,
  }), /shut down during extension startup/u);
  assert.deepEqual(
    (globalThis as Record<string, unknown>).__rigynEmbeddingStartupShutdown,
    ["activate", "start", "shutdown:quit", "dispose"],
  );
});

test("configured public runtime creation cleans up when extension binding fails", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-embedding-extension-bind-failure-"));
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "agent");
  const extensionPath = join(root, "cleanup.mjs");
  await Promise.all([mkdir(workspace), mkdir(agentDirectory)]);
  await writeFile(extensionPath, `export default (api) => {
    globalThis.__rigynEmbeddingBindFailure ??= [];
    globalThis.__rigynEmbeddingBindFailure.push("activate");
    api.onDispose(() => { globalThis.__rigynEmbeddingBindFailure.push("dispose"); });
  };\n`);
  const previousAgentDirectory = process.env.RIGYN_HOME;
  process.env.RIGYN_HOME = agentDirectory;
  const bindExtensions = AgentSession.prototype.bindExtensions;
  AgentSession.prototype.bindExtensions = (async () => {
    throw new Error("embedding bind fixture");
  }) as AgentSession["bindExtensions"];
  context.after(async () => {
    AgentSession.prototype.bindExtensions = bindExtensions;
    if (previousAgentDirectory === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDirectory;
    delete (globalThis as Record<string, unknown>).__rigynEmbeddingBindFailure;
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(createHarnessRuntime({
    workspace,
    projectTrusted: true,
    ephemeral: true,
    extensions: false,
    extensionPaths: [extensionPath],
    skills: false,
    promptTemplates: false,
    themes: false,
  }), /embedding bind fixture/u);

  assert.deepEqual(
    (globalThis as Record<string, unknown>).__rigynEmbeddingBindFailure,
    ["activate", "dispose"],
  );
});

test("an embedding run handle can cancel immediately after start", async () => {
  const provider = createScriptedProvider({
    id: "embedding-cancel",
    models: [{ id: "fixture" }],
    scripts: [{
      kind: "turn",
      content: [{ type: "text", text: "late response" }],
      eventDelayMs: 1_000,
    }],
  });
  await using harness = await createInMemoryHarness({
    provider,
    model: "fixture",
    api: "openai-chat-completions",
  });

  const run = harness.session.start({ prompt: "cancel now" });
  run.abort("test cancellation");

  const result = await run.result;
  assert.equal(result.results.at(-1)?.finishReason, "cancelled");
});

test("the offline in-memory harness preserves an explicit API when scripted catalog metadata omits it", async () => {
  const provider = createScriptedProvider({
    id: "embedding-explicit-api",
    models: [{ id: "fixture" }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "explicit API works" }] }],
  });
  await using harness = await createInMemoryHarness({
    provider,
    model: "fixture",
    api: "openai-chat-completions",
  });

  const result = await harness.session.run({ prompt: "offline" });
  assert.equal(result.results.at(-1)?.finalText, "explicit API works");
});

test("the in-memory harness executes public tool definitions with session context", async () => {
  const executions: Array<{ callId: string; value: string; cwd: string; sessionId: string }> = [];
  const provider = createScriptedProvider({
    id: "embedding-direct-tool",
    models: [{ id: "fixture" }],
    scripts: [
      {
        kind: "turn",
        content: [{
          type: "tool_call",
          id: "embedding-call",
          name: "embedding_probe",
          arguments: { value: "works" },
        }],
        terminal: { type: "finish", reason: "tool_calls" },
      },
      { kind: "turn", content: [{ type: "text", text: "embedding complete" }] },
    ],
  });
  const customTool = defineTool({
    name: "embedding_probe",
    label: "Embedding probe",
    description: "Exercise direct embedding tools",
    parameters: Type.Object({
      value: Type.String(),
    }, { additionalProperties: false }),
    async execute(callId, input, _signal, _onUpdate, context) {
      executions.push({
        callId,
        value: input.value,
        cwd: context.cwd,
        sessionId: context.sessionManager.getSessionId(),
      });
      return {
        content: [{ type: "text", text: input.value }],
        details: null,
      };
    },
  });
  const workspace = process.cwd();
  await using harness = await createInMemoryHarness({
    provider,
    model: "fixture",
    api: "openai-chat-completions",
    workspace,
    customTools: [customTool],
    enabledTools: ["embedding_probe"],
  });

  const result = await harness.session.run({ prompt: "use the embedding probe" });
  assert.equal(result.results.at(-1)?.finalText, "embedding complete");
  assert.equal(executions.length, 1);
  assert.deepEqual(executions[0], {
    callId: "embedding-call",
    value: "works",
    cwd: workspace,
    sessionId: harness.session.id,
  });
});

test("the in-memory harness forwards model tool calls to its host authorization handler", async () => {
  let executions = 0;
  const provider = createScriptedProvider({
    id: "embedding-approval",
    models: [{ id: "fixture" }],
    scripts: [
      {
        kind: "turn",
        content: [{
          type: "tool_call",
          id: "embedding-approval-call",
          name: "embedding_approval_probe",
          arguments: {},
        }],
        terminal: { type: "finish", reason: "tool_calls" },
      },
      { kind: "turn", content: [{ type: "text", text: "denial complete" }] },
    ],
  });
  const customTool = defineTool({
    name: "embedding_approval_probe",
    label: "Embedding approval probe",
    description: "Exercise embedding authorization",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      executions += 1;
      return { content: [{ type: "text", text: "executed" }], details: null };
    },
  });
  const approvals: string[] = [];
  await using harness = await createInMemoryHarness({
    provider,
    model: "fixture",
    api: "openai-chat-completions",
    customTools: [customTool],
    enabledTools: ["embedding_approval_probe"],
    toolAuthorizationHandler(request, context) {
      approvals.push(`${context.threadId}:${request.invocation.callId}:${request.recovered}`);
      return { decision: "deny", reason: "embedding host denied" };
    },
  });

  const result = await harness.session.run({ prompt: "request approval" });
  assert.equal(result.results.at(-1)?.finalText, "denial complete");
  assert.equal(executions, 0);
  assert.deepEqual(approvals, [`${harness.session.id}:embedding-approval-call:false`]);
});

test("the in-memory harness uses isolated settings and exact tool selection", async () => {
  const provider = createScriptedProvider({
    id: "embedding-tool-selection",
    models: [{ id: "fixture" }],
    scripts: [
      { kind: "turn", content: [{ type: "text", text: "selected" }] },
      { kind: "turn", content: [{ type: "text", text: "none" }] },
    ],
  });
  await using selected = await createInMemoryHarness({
    provider,
    model: "fixture",
    api: "openai-chat-completions",
    enabledTools: ["read", "bash"],
    excludeTools: ["bash"],
  });
  await selected.session.run({ prompt: "selected tools" });
  assert.deepEqual(provider.capturedRequests()[0]?.tools.map((tool) => tool.name), ["read"]);

  await selected.close();
  await using none = await createInMemoryHarness({
    provider,
    model: "fixture",
    api: "openai-chat-completions",
    noTools: "all",
  });
  await none.session.run({ prompt: "no tools" });
  assert.deepEqual(provider.capturedRequests()[1]?.tools, []);
});

test("the in-memory harness still requires catalog API metadata when no explicit API is supplied", async () => {
  const provider = createScriptedProvider({
    id: "embedding-missing-api",
    models: [{ id: "fixture" }],
    scripts: [],
  });
  await assert.rejects(
    createInMemoryHarness({ provider, model: "fixture" } as unknown as Parameters<typeof createInMemoryHarness>[0]),
    /does not declare an API protocol/u,
  );
});
