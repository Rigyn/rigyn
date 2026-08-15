import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  sessionV4JsonHash,
  sessionV4ToolInputHash,
  type SessionV4Json,
  type SessionV4RunSelection,
  type SessionV4ToolEffectPolicy,
} from "@rigyn/kernel/session-v4";

import type {
  AdapterEvent,
  ModelInfo,
  ModelProtocolFamily,
  ProviderAdapter,
  ProviderRequest,
} from "../../src/core/types.js";
import type { EventEnvelope, RuntimeEvent } from "../../src/core/events.js";
import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import {
  RuntimeObservability,
  type ObservabilityRecord,
  type ObservabilitySink,
} from "../../src/core/observability.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import { createModels } from "../../src/providers/models.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { localInterruptionMarker } from "../../src/modes/interactive-interruption-recovery.js";
import {
  AgentSession,
  type AgentSessionModel,
  type AgentSessionOptions,
} from "../../src/service/agent-session.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import {
  MAX_TOOL_RESULT_CONTENT_BYTES,
  MAX_TOOL_RESULT_METADATA_BYTES,
} from "../../src/tools/coordinator.js";
import type {
  HarnessTool,
  ToolResult,
} from "../../src/tools/types.js";

const TIME = "2026-07-29T12:00:00.000Z";
const PROVIDER = "recovery-fixture";
const MODEL = "recovery-model";
const API: ModelProtocolFamily = "openai-chat-completions";
const supported = { value: "supported", source: "provider", observedAt: TIME } as const;
const MODEL_INFO: ModelInfo = {
  id: MODEL,
  provider: PROVIDER,
  capabilities: { tools: supported, reasoning: supported, images: supported },
  compatibility: {
    protocolFamily: { value: API, source: "provider", observedAt: TIME },
  },
};
const SELECTED_MODEL: AgentSessionModel = {
  provider: PROVIDER,
  api: API,
  id: MODEL,
  info: MODEL_INFO,
};

class RecoveryProvider implements ProviderAdapter {
  readonly id = PROVIDER;

  async *stream(_request: ProviderRequest): AsyncIterable<AdapterEvent> {
    throw new Error("Recovery tests must not call the provider");
  }

  async listModels(): Promise<ModelInfo[]> {
    return [structuredClone(MODEL_INFO)];
  }
}

class RecordingObservabilitySink implements ObservabilitySink {
  readonly records: ObservabilityRecord[] = [];
  record(record: ObservabilityRecord): void { this.records.push(record); }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

class CheckpointProvider extends RecoveryProvider {
  override async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    yield { type: "response_start", model: request.model };
    yield { type: "text_delta", part: 0, text: "checkpointed" };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: {} },
    };
  }
}

class ToolCheckpointProvider extends RecoveryProvider {
  requests = 0;

  override async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests += 1;
    yield { type: "response_start", model: request.model };
    if (this.requests === 1) {
      yield { type: "tool_call_start", index: 0, id: "checkpoint-call", name: "checkpoint_tool" };
      yield {
        type: "tool_call_end",
        index: 0,
        id: "checkpoint-call",
        name: "checkpoint_tool",
        rawArguments: '{"value":"durable"}',
        arguments: { value: "durable" },
      };
      yield {
        type: "response_end",
        reason: "tool_calls",
        state: { kind: "chat_completions", assistantMessage: {} },
      };
      return;
    }
    yield { type: "text_delta", part: 0, text: "tool checkpointed" };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: {} },
    };
  }
}

class InterruptedToolProvider extends RecoveryProvider {
  requests = 0;

  override async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests += 1;
    yield { type: "response_start", model: request.model };
    if (this.requests === 1) {
      yield { type: "tool_call_start", index: 0, id: "interrupted-call", name: "interrupted_tool" };
      yield {
        type: "tool_call_end",
        index: 0,
        id: "interrupted-call",
        name: "interrupted_tool",
        rawArguments: '{"value":"durable"}',
        arguments: { value: "durable" },
      };
      yield {
        type: "response_end",
        reason: "tool_calls",
        state: { kind: "chat_completions", assistantMessage: {} },
      };
      return;
    }
    yield { type: "text_delta", part: 0, text: "continued safely" };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: {} },
    };
  }
}

async function managerFixture(t: TestContext, id: string): Promise<SessionManager> {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-agent-recovery-"));
  t.after(async () => await rm(cwd, { recursive: true, force: true }));
  return SessionManager.inMemory(cwd, { id });
}

async function openSession(
  manager: SessionManager,
  tools: readonly HarnessTool[] = [],
  options: Pick<AgentSessionOptions, "observability" | "toolAuthorizationHandler"> = {},
): Promise<AgentSession> {
  return await AgentSession.create({
    sessionManager: manager,
    providers: new ProviderRegistry([new RecoveryProvider()]),
    settingsManager: SettingsManager.inMemory(),
    tools,
    model: SELECTED_MODEL,
    ...options,
  });
}

function selection(tools: readonly HarnessTool[]): SessionV4RunSelection {
  const definitions = tools.map((tool) => structuredClone(tool.definition));
  return {
    provider: PROVIDER,
    model: MODEL,
    api: API,
    thinkingLevel: "off",
    toolNames: definitions.map((definition) => definition.name),
    toolsetFingerprint: sessionV4JsonHash(definitions as unknown as SessionV4Json),
  };
}

function acceptRun(
  manager: SessionManager,
  selected: SessionV4RunSelection,
  options: {
    operationId?: string;
    promptNodeId?: string;
    prompt?: string;
  } = {},
): { operationId: string; promptNodeId: string } {
  const operationId = options.operationId ?? "operation";
  const promptNodeId = options.promptNodeId ?? "prompt";
  manager.commitChanges([{
    type: "run_accepted",
    branchId: "main",
    operationId,
    promptNodeId,
    sourceHeadId: manager.getLeafId(),
    acceptedAt: TIME,
    request: { prompt: options.prompt ?? "accepted prompt" },
    selection: selected,
  }]);
  return { operationId, promptNodeId };
}

function materializePrompt(
  manager: SessionManager,
  operationId: string,
  promptNodeId: string,
  text = "accepted prompt",
): void {
  manager.appendMessage({
    id: promptNodeId,
    role: "user",
    content: [{ type: "text", text }],
    createdAt: TIME,
  }, {
    nodeId: promptNodeId,
    operationId,
    parentId: manager.getV4State().operations.get(operationId)?.sourceHeadId ?? null,
  });
}

function beginToolStep(
  manager: SessionManager,
  operationId: string,
  selected: SessionV4RunSelection,
): string {
  manager.commitChanges([
    {
      type: "run_step_selected",
      operationId,
      step: 0,
      selectedAt: TIME,
      selection: selected,
    },
    {
      type: "run_attempt",
      operationId,
      attemptId: `${operationId}-attempt`,
      step: 0,
      attempt: 1,
      task: "provider",
      startedAt: TIME,
    },
  ]);
  const assistantNodeId = `${operationId}-assistant`;
  manager.appendMessage({
    id: assistantNodeId,
    role: "assistant",
    content: [{ type: "text", text: "Calling tools" }],
    createdAt: TIME,
  }, {
    nodeId: assistantNodeId,
    operationId,
  });
  return assistantNodeId;
}

function prepareEffect(
  manager: SessionManager,
  options: {
    operationId: string;
    assistantNodeId: string;
    selected: SessionV4RunSelection;
    effectId: string;
    callId: string;
    toolName: string;
    policy: SessionV4ToolEffectPolicy;
    input: SessionV4Json;
    resultNodeId: string;
    index: number;
  },
): void {
  manager.commitChanges([{
    type: "tool_effect_prepared",
    effectId: options.effectId,
    operationId: options.operationId,
    invocationId: `${options.effectId}-invocation`,
    callId: options.callId,
    toolName: options.toolName,
    policy: options.policy,
    effectiveInput: options.input,
    inputHash: sessionV4ToolInputHash(options.input),
    resultNodeId: options.resultNodeId,
    step: 0,
    index: options.index,
    assistantNodeId: options.assistantNodeId,
    toolsetFingerprint: options.selected.toolsetFingerprint,
    preparedAt: TIME,
  }]);
}

function dispatchEffect(manager: SessionManager, effectId: string): void {
  manager.commitChanges([{
    type: "tool_effect_dispatched",
    effectId,
    dispatchId: `${effectId}-dispatch`,
    dispatchedAt: TIME,
  }]);
}

function messagePayload(
  manager: SessionManager,
  nodeId: string,
): {
  role: string;
  content: Array<Record<string, unknown>>;
} {
  const node = manager.getV4State().nodes.get(nodeId);
  assert.equal(node?.nodeType, "message");
  if (node?.nodeType !== "message") assert.fail(`Expected message node ${nodeId}`);
  const payload = node.content as unknown;
  assert.ok(payload !== null && typeof payload === "object" && !Array.isArray(payload));
  const role = (payload as { role?: unknown }).role;
  const content = (payload as { content?: unknown }).content;
  assert.equal(typeof role, "string");
  assert.ok(Array.isArray(content));
  return {
    role: role as string,
    content: content as Array<Record<string, unknown>>,
  };
}

function recoveryTool(
  name: string,
  policy: "repeatable" | "never_repeat",
  execute: HarnessTool["execute"],
): HarnessTool {
  return {
    definition: {
      name,
      description: `${name} recovery fixture`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: {
          value: { type: "string" },
        },
      },
    },
    recovery: policy === "repeatable"
      ? { mode: "repeatable" }
      : { mode: "never_repeat" },
    validate(input) {
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        typeof input.value !== "string"
      ) {
        throw new TypeError("value must be a string");
      }
    },
    resources() {
      return [];
    },
    execute,
  };
}

function reconcileRecoveryTool(
  name: string,
  recover: Extract<NonNullable<HarnessTool["recovery"]>, { mode: "reconcile" }>["recover"],
): HarnessTool {
  return {
    definition: {
      name,
      description: `${name} recovery fixture`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: {
          value: { type: "string" },
        },
      },
    },
    recovery: { mode: "reconcile", recover },
    validate(input) {
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        typeof input.value !== "string"
      ) {
        throw new TypeError("value must be a string");
      }
    },
    resources() {
      return [];
    },
    async execute() {
      return { content: "must not execute", isError: false };
    },
  };
}

test("live operations checkpoint persisted messages before they finish", async (context) => {
  const manager = await managerFixture(context, "checkpointed-operation");
  const session = await AgentSession.create({
    sessionManager: manager,
    providers: new ProviderRegistry([new CheckpointProvider()]),
    settingsManager: SettingsManager.inMemory(),
    model: SELECTED_MODEL,
  });
  context.after(async () => await session.close());

  await session.prompt("record checkpoints");

  const state = manager.getV4State();
  const operation = [...state.operations.values()].at(-1);
  assert.equal(operation?.status, "completed");
  assert.deepEqual(
    operation?.checkpointIds.map((id) => {
      const data = state.checkpoints.get(id)?.data as Record<string, unknown> | undefined;
      return data?.["phase"] === "message_persisted" ? data["role"] : data?.["phase"];
    }),
    ["system", "user", "assistant"],
  );
});

test("live operations checkpoint settled tool effects", async (context) => {
  const manager = await managerFixture(context, "checkpointed-tool-effect");
  const provider = new ToolCheckpointProvider();
  let executions = 0;
  const tool = recoveryTool("checkpoint_tool", "repeatable", async () => {
    executions += 1;
    return { content: "tool completed", isError: false };
  });
  const session = await AgentSession.create({
    sessionManager: manager,
    providers: new ProviderRegistry([provider]),
    settingsManager: SettingsManager.inMemory(),
    tools: [tool],
    model: SELECTED_MODEL,
  });
  context.after(async () => await session.close());

  await session.prompt("record a tool checkpoint");

  const state = manager.getV4State();
  const operation = [...state.operations.values()].at(-1);
  assert.equal(executions, 1);
  assert.equal(operation?.status, "completed");
  const checkpoint = operation?.checkpointIds
    .map((id) => state.checkpoints.get(id)?.data as Record<string, unknown> | undefined)
    .find((data) => data?.["phase"] === "tool_effect_settled");
  assert.equal(checkpoint?.["callId"], "checkpoint-call");
  assert.equal(typeof checkpoint?.["effectId"], "string");
});

test("live cancellation after tool dispatch requires an explicit non-replay decision before continuing", async (context) => {
  const manager = await managerFixture(context, "live-interrupted-tool");
  const provider = new InterruptedToolProvider();
  let markToolStarted!: () => void;
  const toolStarted = new Promise<void>((resolve) => { markToolStarted = resolve; });
  const tool = recoveryTool("interrupted_tool", "never_repeat", async (_input, execution) => {
    markToolStarted();
    return await new Promise<ToolResult>((_resolve, reject) => {
      const cancel = (): void => reject(execution.signal.reason ?? new Error("cancelled"));
      if (execution.signal.aborted) cancel();
      else execution.signal.addEventListener("abort", cancel, { once: true });
    });
  });
  const session = await AgentSession.create({
    sessionManager: manager,
    providers: new ProviderRegistry([provider]),
    settingsManager: SettingsManager.inMemory(),
    tools: [tool],
    model: SELECTED_MODEL,
  });
  context.after(async () => await session.close());

  const running = session.prompt("start the interruptible tool");
  await toolStarted;
  const localOperationId = localInterruptionMarker(session);
  assert.equal(typeof localOperationId, "string");
  await session.abort("cancel live tool");
  const cancelled = await running;
  assert.equal(cancelled.results.at(-1)?.finishReason, "cancelled");

  const suspended = session.suspendedRun;
  assert.equal(suspended?.operationId, localOperationId);
  assert.equal(localInterruptionMarker(session), undefined);
  assert.equal(suspended?.cancelled, true);
  assert.equal(suspended?.effects.length, 1);
  assert.equal(suspended?.effects[0]?.status, "dispatched");
  await assert.rejects(
    session.prompt("must not overtake the uncertain effect"),
    /Call recoverInterruptedRun\(\)/u,
  );

  const blocked = await session.recoverInterruptedRun();
  assert.equal(blocked.recovered, false);
  assert.equal(blocked.operationId, suspended?.operationId);
  assert.equal(blocked.blocked.length, 1);
  const effectId = blocked.blocked[0]?.effectId;
  assert.equal(typeof effectId, "string");
  assert.match(blocked.blocked[0]?.reason ?? "", /cannot be repeated safely/u);

  assert.deepEqual(await session.recoverInterruptedRun({
    resolutions: [{ effectId: effectId!, outcome: "abandoned" }],
  }), {
    recovered: true,
    operationId: suspended?.operationId,
    blocked: [],
  });
  assert.equal(session.suspendedRun, undefined);
  assert.equal(manager.getV4State().toolEffects.get(effectId!)?.status, "abandoned");

  const continued = await session.prompt("continue after recovery");
  assert.equal(continued.results.at(-1)?.finalText, "continued safely");
});

test("restart recovery repeats unchanged tool input but blocks when durable redaction changed it", async (t) => {
  const secret = "registered-repeatable-recovery-secret";
  defaultSecretRedactor.register(secret);
  const cases = [
    { name: "unchanged", value: "benign recovery input", blocked: false },
    { name: "redacted", value: secret, blocked: true },
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.name, async (context) => {
      const manager = await managerFixture(context, `recovery-input-${fixture.name}`);
      const toolName = `recovery_input_${fixture.name}`;
      const callId = `recovery-input-${fixture.name}-call`;
      const provider = new class extends RecoveryProvider {
        override async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
          yield { type: "response_start", model: request.model };
          yield { type: "tool_call_start", index: 0, id: callId, name: toolName };
          yield {
            type: "tool_call_end",
            index: 0,
            id: callId,
            name: toolName,
            rawArguments: JSON.stringify({ value: fixture.value }),
            arguments: { value: fixture.value },
          };
          yield {
            type: "response_end",
            reason: "tool_calls",
            state: { kind: "chat_completions", assistantMessage: {} },
          };
        }
      }();
      const executionInputs: SessionV4Json[] = [];
      let markToolStarted!: () => void;
      const toolStarted = new Promise<void>((resolve) => { markToolStarted = resolve; });
      const tool = recoveryTool(toolName, "repeatable", async (input, execution) => {
        executionInputs.push(structuredClone(input));
        if (executionInputs.length !== 1) return { content: "recovered", isError: false };
        markToolStarted();
        return await new Promise<ToolResult>((_resolve, reject) => {
          const cancel = (): void => reject(execution.signal.reason ?? new Error("cancelled"));
          if (execution.signal.aborted) cancel();
          else execution.signal.addEventListener("abort", cancel, { once: true });
        });
      });
      const live = await AgentSession.create({
        sessionManager: manager,
        providers: new ProviderRegistry([provider]),
        settingsManager: SettingsManager.inMemory(),
        tools: [tool],
        allowedToolNames: [toolName],
        model: SELECTED_MODEL,
      });
      context.after(async () => await live.close());
      const liveDispatches: Array<Extract<RuntimeEvent, { type: "tool_dispatching" }>> = [];
      live.onEvent((envelope) => {
        if (envelope.event.type === "tool_dispatching") liveDispatches.push(envelope.event);
      });

      const running = live.prompt("dispatch the repeatable tool", { allowedTools: [toolName] });
      await toolStarted;
      const restartManager = manager.cloneInMemory();
      await live.abort("end the original process simulation");
      await running;

      const stateAtRestart = restartManager.getV4State();
      const operation = [...stateAtRestart.operations.values()].at(-1);
      const effect = [...stateAtRestart.toolEffects.values()].at(-1);
      assert.ok(operation);
      assert.ok(effect);
      assert.deepEqual(executionInputs, [{ value: fixture.value }]);
      assert.deepEqual(effect.effectiveInput, {
        value: fixture.blocked ? "[REDACTED]" : fixture.value,
      });
      assert.deepEqual(liveDispatches.map((event) => ({
        input: event.input,
        recoveryMode: event.recoveryMode,
      })), [{
        input: { value: fixture.blocked ? "[REDACTED]" : fixture.value },
        recoveryMode: fixture.blocked ? "never_repeat" : "repeatable",
      }]);
      assert.equal(JSON.stringify([
        ...stateAtRestart.nodes.values(),
        ...stateAtRestart.operations.values(),
        ...stateAtRestart.toolEffects.values(),
      ]).includes(secret), false);

      const sink = new RecordingObservabilitySink();
      const observability = new RuntimeObservability(sink, {
        mode: "sdk",
        processInstance: "0123456789abcdef",
        snapshotIntervalMs: 60_000,
        closeSink: false,
      });
      context.after(async () => await observability.close());
      const recovered = await openSession(restartManager, [tool], { observability });
      context.after(async () => await recovered.close());
      const envelopes: EventEnvelope[] = [];
      recovered.onEvent((envelope) => { envelopes.push(envelope); });

      const result = await recovered.recoverInterruptedRun();
      if (!fixture.blocked) {
        assert.deepEqual(result, { recovered: true, operationId: operation.id, blocked: [] });
        assert.equal(effect.policy, "repeatable");
        assert.deepEqual(executionInputs, [{ value: fixture.value }, { value: fixture.value }]);
      } else {
        assert.equal(result.recovered, false);
        assert.equal(result.operationId, operation.id);
        assert.equal(result.blocked.length, 1);
        assert.equal(result.blocked[0]?.effectId, effect.id);
        assert.match(result.blocked[0]?.reason ?? "", /cannot be repeated safely/u);
        assert.equal(effect.policy, "never_repeat");
        assert.deepEqual(executionInputs, [{ value: fixture.value }]);
        assert.deepEqual(await recovered.recoverInterruptedRun({
          resolutions: [{ effectId: effect.id, outcome: "abandoned" }],
        }), {
          recovered: true,
          operationId: operation.id,
          blocked: [],
        });
      }

      assert.deepEqual(await recovered.recoverInterruptedRun(), {
        recovered: false,
        blocked: [],
      });
      const finalState = restartManager.getV4State();
      assert.equal(finalState.operations.get(operation.id)?.status, "cancelled");
      assert.equal(finalState.branches.get(finalState.primaryBranchId)?.openOperationId, null);
      assert.equal(envelopes.filter((envelope) => envelope.event.type === "tool_in_doubt").length, 1);
      const terminal = envelopes.filter((envelope) =>
        envelope.event.type === "run_completed" ||
        envelope.event.type === "run_failed" ||
        envelope.event.type === "run_cancelled");
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0]?.runId, operation.id);
      assert.equal(terminal[0]?.event.type, "run_cancelled");
      assert.equal(JSON.stringify(envelopes).includes(secret), false);
      observability.snapshot();
      const snapshot = sink.records.findLast((record) => record.kind === "metrics_snapshot");
      assert.equal(snapshot?.fields.tools_in_doubt, 1);
      assert.equal(snapshot?.fields.runs_cancelled, 1);
      assert.equal(snapshot?.fields.active_runs, 0);
    });
  }
});

test("accepted work blocks admission, then recovery materializes its prompt and settles idempotently", async (t) => {
  const manager = await managerFixture(t, "accepted-before-prompt");
  const accepted = acceptRun(manager, selection([]), { prompt: "durable accepted prompt" });
  const sink = new RecordingObservabilitySink();
  const observability = new RuntimeObservability(sink, {
    mode: "sdk",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
    closeSink: false,
  });
  t.after(async () => await observability.close());
  const session = await openSession(manager, [], { observability });
  t.after(async () => await session.close());
  const envelopes: EventEnvelope[] = [];
  session.onEvent((envelope) => { envelopes.push(envelope); });

  assert.equal(session.suspendedRun?.operationId, accepted.operationId);
  await assert.rejects(
    session.prompt("must not overtake interrupted work"),
    /Call recoverInterruptedRun\(\)/u,
  );
  assert.equal(manager.getV4State().nodes.has(accepted.promptNodeId), false);

  assert.deepEqual(await session.recoverInterruptedRun(), {
    recovered: true,
    operationId: accepted.operationId,
    blocked: [],
  });
  assert.equal(session.suspendedRun, undefined);
  let state = manager.getV4State();
  assert.equal(state.operations.get(accepted.operationId)?.status, "cancelled");
  assert.equal(state.branches.get(state.primaryBranchId)?.openOperationId, null);
  const prompt = messagePayload(manager, accepted.promptNodeId);
  assert.equal(prompt.role, "user");
  assert.deepEqual(prompt.content, [{ type: "text", text: "durable accepted prompt" }]);
  assert.deepEqual(
    envelopes.filter((envelope) =>
      envelope.event.type === "run_completed" ||
      envelope.event.type === "run_failed" ||
      envelope.event.type === "run_cancelled")
      .map((envelope) => ({ runId: envelope.runId, event: envelope.event })),
    [{
      runId: accepted.operationId,
      event: {
        type: "run_cancelled",
        reason: "The process ended before the operation settled.",
      },
    }],
  );
  observability.snapshot();
  let snapshot = sink.records.findLast((record) => record.kind === "metrics_snapshot");
  assert.equal(snapshot?.fields.runs_started, 0);
  assert.equal(snapshot?.fields.runs_completed, 0);
  assert.equal(snapshot?.fields.runs_failed, 0);
  assert.equal(snapshot?.fields.runs_cancelled, 1);
  assert.equal(snapshot?.fields.active_runs, 0);

  assert.deepEqual(await session.recoverInterruptedRun(), {
    recovered: false,
    blocked: [],
  });
  state = manager.getV4State();
  assert.equal(state.operations.get(accepted.operationId)?.status, "cancelled");
  assert.equal(state.branches.get(state.primaryBranchId)?.openOperationId, null);
  assert.equal(envelopes.filter((envelope) => envelope.event.type === "run_cancelled").length, 1);
  observability.snapshot();
  snapshot = sink.records.findLast((record) => record.kind === "metrics_snapshot");
  assert.equal(snapshot?.fields.runs_cancelled, 1);
});

test("recovery restores an exact accepted message batch before its prompt", async (t) => {
  const manager = await managerFixture(t, "accepted-message-batch");
  manager.appendMessage({
    id: "source",
    role: "assistant",
    content: [{ type: "text", text: "existing context" }],
    createdAt: TIME,
  }, { nodeId: "source" });
  const initialMessages = [
    {
      id: "accepted-instructions",
      role: "system" as const,
      content: [{ type: "text" as const, text: "durable instructions" }],
      createdAt: TIME,
      purpose: "instructions" as const,
    },
    {
      id: "accepted-context",
      role: "user" as const,
      content: [{ type: "text" as const, text: "exact SDK context" }],
      createdAt: TIME,
    },
  ];
  manager.commitChanges([{
    type: "run_accepted",
    branchId: "main",
    operationId: "message-batch-operation",
    promptNodeId: "message-batch-prompt",
    sourceHeadId: "source",
    acceptedAt: TIME,
    request: {
      initialMessages: initialMessages as unknown as SessionV4Json,
      prompt: "accepted prompt",
    },
    selection: selection([]),
  }]);
  const session = await openSession(manager);
  t.after(async () => await session.close());

  assert.deepEqual(await session.recoverInterruptedRun(), {
    recovered: true,
    operationId: "message-batch-operation",
    blocked: [],
  });
  const state = manager.getV4State();
  assert.equal(state.nodes.get("accepted-instructions")?.parentId, "source");
  assert.equal(state.nodes.get("accepted-context")?.parentId, "accepted-instructions");
  assert.equal(state.nodes.get("message-batch-prompt")?.parentId, "accepted-context");
  assert.deepEqual(
    [
      messagePayload(manager, "accepted-instructions").content,
      messagePayload(manager, "accepted-context").content,
      messagePayload(manager, "message-batch-prompt").content,
    ],
    [
      [{ type: "text", text: "durable instructions" }],
      [{ type: "text", text: "exact SDK context" }],
      [{ type: "text", text: "accepted prompt" }],
    ],
  );
});

test("recovery supplies a result for a tool call interrupted before durable dispatch", async (t) => {
  const manager = await managerFixture(t, "pre-dispatch-tool");
  const selected = selection([]);
  const accepted = acceptRun(manager, selected);
  materializePrompt(manager, accepted.operationId, accepted.promptNodeId);
  manager.commitChanges([
    {
      type: "run_step_selected",
      operationId: accepted.operationId,
      step: 0,
      selectedAt: TIME,
      selection: selected,
    },
    {
      type: "run_attempt",
      operationId: accepted.operationId,
      attemptId: "pre-dispatch-attempt",
      step: 0,
      attempt: 1,
      task: "provider",
      startedAt: TIME,
    },
  ]);
  manager.appendMessage({
    id: "pre-dispatch-assistant",
    role: "assistant",
    content: [{
      type: "tool_call",
      callId: "pre-dispatch-call",
      name: "missing_tool",
      arguments: { value: "never dispatched" },
    }],
    createdAt: TIME,
  }, {
    nodeId: "pre-dispatch-assistant",
    operationId: accepted.operationId,
  });
  const session = await openSession(manager);
  t.after(async () => await session.close());

  assert.deepEqual(await session.recoverInterruptedRun(), {
    recovered: true,
    operationId: accepted.operationId,
    blocked: [],
  });
  const toolNode = [...manager.getV4State().nodes.values()].find((node) =>
    node.operationId === accepted.operationId &&
    node.nodeType === "message" &&
    node.role === "tool");
  assert.ok(toolNode);
  const result = messagePayload(manager, toolNode.id);
  assert.equal(result.content[0]?.["callId"], "pre-dispatch-call");
  assert.match(String(result.content[0]?.["content"]), /durable dispatch boundary/u);
});

test("dispatched repeatable effects use exact durable inputs once and materialize ordered results", async (t) => {
  const observed: SessionV4Json[] = [];
  const tool = recoveryTool("repeatable_fixture", "repeatable", async (input) => {
    observed.push(structuredClone(input));
    const value = (input as { value: string }).value;
    return { content: `recovered:${value}`, isError: false };
  });
  const selected = selection([tool]);
  const manager = await managerFixture(t, "repeatable");
  const accepted = acceptRun(manager, selected);
  materializePrompt(manager, accepted.operationId, accepted.promptNodeId);
  const assistantNodeId = beginToolStep(manager, accepted.operationId, selected);

  prepareEffect(manager, {
    operationId: accepted.operationId,
    assistantNodeId,
    selected,
    effectId: "effect-second",
    callId: "call-second",
    toolName: tool.definition.name,
    policy: "repeatable",
    input: { value: "second" },
    resultNodeId: "tool-results",
    index: 1,
  });
  prepareEffect(manager, {
    operationId: accepted.operationId,
    assistantNodeId,
    selected,
    effectId: "effect-first",
    callId: "call-first",
    toolName: tool.definition.name,
    policy: "repeatable",
    input: { value: "first" },
    resultNodeId: "tool-results",
    index: 0,
  });
  dispatchEffect(manager, "effect-second");
  dispatchEffect(manager, "effect-first");

  const approvals: Array<{ value: string; recovered: boolean }> = [];
  const session = await openSession(manager, [tool], {
    toolAuthorizationHandler(request) {
      approvals.push({
        value: String((request.invocation.input as { value: string }).value),
        recovered: request.recovered,
      });
      return { decision: "allow_once" };
    },
  });
  t.after(async () => await session.close());
  assert.deepEqual(await session.recoverInterruptedRun(), {
    recovered: true,
    operationId: accepted.operationId,
    blocked: [],
  });

  assert.deepEqual(observed, [{ value: "first" }, { value: "second" }]);
  assert.deepEqual(approvals, [
    { value: "first", recovered: true },
    { value: "second", recovered: true },
  ]);
  const state = manager.getV4State();
  assert.deepEqual(state.toolEffects.get("effect-first")?.dispatchIds.length, 2);
  assert.deepEqual(state.toolEffects.get("effect-second")?.dispatchIds.length, 2);
  assert.equal(state.toolEffects.get("effect-first")?.status, "succeeded");
  assert.equal(state.toolEffects.get("effect-second")?.status, "succeeded");
  const results = messagePayload(manager, "tool-results");
  assert.equal(results.role, "tool");
  assert.deepEqual(
    results.content.map((block) => [block["callId"], block["content"]]),
    [
      ["call-first", "recovered:first"],
      ["call-second", "recovered:second"],
    ],
  );

  assert.deepEqual(await session.recoverInterruptedRun(), {
    recovered: false,
    blocked: [],
  });
  assert.equal(observed.length, 2);
});

test("automatic reconciliation claims once, rejects invalid results, and settles valid results", async (t) => {
  let recoverCalls = 0;
  const validResult: ToolResult = {
    content: "reconciler verified the bounded effect",
    isError: false,
    status: "success",
    summary: "verified",
    metadata: { verified: true },
  };
  const tool = reconcileRecoveryTool("bounded_automatic_recovery", async (effect) => {
    recoverCalls += 1;
    return (effect.input as { value: string }).value === "invalid"
      ? {
          status: "completed",
          result: {
            content: "x".repeat(MAX_TOOL_RESULT_CONTENT_BYTES + 1),
            isError: false,
          },
        } as never
      : { status: "completed", result: validResult };
  });
  const selected = selection([tool]);
  const manager = await managerFixture(t, "bounded-automatic-recovery");
  const accepted = acceptRun(manager, selected);
  materializePrompt(manager, accepted.operationId, accepted.promptNodeId);
  const assistantNodeId = beginToolStep(manager, accepted.operationId, selected);
  for (const [index, value] of ["invalid", "valid"].entries()) {
    const effectId = `bounded-automatic-${value}`;
    prepareEffect(manager, {
      operationId: accepted.operationId,
      assistantNodeId,
      selected,
      effectId,
      callId: `${effectId}-call`,
      toolName: tool.definition.name,
      policy: "reconcile",
      input: { value },
      resultNodeId: "bounded-automatic-result",
      index,
    });
    dispatchEffect(manager, effectId);
    manager.commitChanges([{
      type: "tool_effect_in_doubt",
      effectId,
      noticedAt: TIME,
      detail: { reason: "process_interrupted" },
    }]);
  }

  const session = await openSession(manager, [tool]);
  t.after(async () => await session.close());
  const recovery = await session.recoverInterruptedRun();
  assert.equal(recovery.recovered, false);
  assert.equal(recovery.operationId, accepted.operationId);
  assert.deepEqual(recovery.blocked.map((entry) => entry.effectId), ["bounded-automatic-invalid"]);
  assert.match(recovery.blocked[0]?.reason ?? "", /Recovery tool result/u);

  const state = manager.getV4State();
  const invalid = state.toolEffects.get("bounded-automatic-invalid");
  assert.equal(invalid?.status, "recovery_started");
  assert.equal(invalid?.result, undefined);
  assert.equal(typeof invalid?.recoveryId, "string");
  const valid = state.toolEffects.get("bounded-automatic-valid");
  assert.equal(valid?.status, "succeeded");
  const stored = valid?.result as Record<string, unknown> | undefined;
  assert.ok(stored);
  assert.equal(stored["content"], validResult.content);
  assert.equal(stored["status"], validResult.status);
  assert.equal(stored["summary"], validResult.summary);
  assert.deepEqual(stored["metadata"], validResult.metadata);
  assert.equal(recoverCalls, 2);

  assert.deepEqual(await session.recoverInterruptedRun(), {
    recovered: false,
    operationId: accepted.operationId,
    blocked: [{
      effectId: "bounded-automatic-invalid",
      name: tool.definition.name,
      reason: "The tool outcome is still uncertain. Supply an explicit resolution.",
    }],
  });
  assert.equal(recoverCalls, 2, "a claimed reconciliation must never be invoked again");
});

test("automatic reconciliation rejects malformed reasons and bounds redacted diagnostics", async (t) => {
  const secret = "automatic-reconcile-secret-value";
  defaultSecretRedactor.register(secret);
  let recoverCalls = 0;
  const tool = reconcileRecoveryTool("bounded_reconcile_reason", async (effect) => {
    recoverCalls += 1;
    return (effect.input as { value: string }).value === "malformed"
      ? { status: "in_doubt", reason: 42 } as never
      : { status: "in_doubt", reason: ` ${secret} ${"z".repeat(8_192)} ` };
  });
  const selected = selection([tool]);
  const manager = await managerFixture(t, "bounded-reconcile-reason");
  const accepted = acceptRun(manager, selected);
  materializePrompt(manager, accepted.operationId, accepted.promptNodeId);
  const assistantNodeId = beginToolStep(manager, accepted.operationId, selected);
  for (const [index, value] of ["malformed", "bounded"].entries()) {
    const effectId = `bounded-reason-${value}`;
    prepareEffect(manager, {
      operationId: accepted.operationId,
      assistantNodeId,
      selected,
      effectId,
      callId: `${effectId}-call`,
      toolName: tool.definition.name,
      policy: "reconcile",
      input: { value },
      resultNodeId: "bounded-reason-result",
      index,
    });
    dispatchEffect(manager, effectId);
    manager.commitChanges([{
      type: "tool_effect_in_doubt",
      effectId,
      noticedAt: TIME,
      detail: { reason: "process_interrupted" },
    }]);
  }

  const session = await openSession(manager, [tool]);
  t.after(async () => await session.close());
  const blocked = await session.recoverInterruptedRun();
  assert.equal(blocked.recovered, false);
  assert.equal(blocked.operationId, accepted.operationId);
  assert.equal(blocked.blocked.length, 2);
  const malformed = blocked.blocked.find((entry) => entry.effectId === "bounded-reason-malformed")?.reason ?? "";
  assert.match(malformed, /in-doubt reason must be a string/u);
  assert.equal(Buffer.byteLength(malformed, "utf8") <= 4_096, true);
  const reason = blocked.blocked.find((entry) => entry.effectId === "bounded-reason-bounded")?.reason ?? "";
  assert.equal(Buffer.byteLength(reason, "utf8") <= 4_096, true);
  assert.equal(reason.includes(secret), false);
  assert.match(reason, /\[REDACTED\]/u);
  assert.match(reason, /bytes omitted/u);
  assert.deepEqual(
    ["malformed", "bounded"].map((value) =>
      manager.getV4State().toolEffects.get(`bounded-reason-${value}`)?.status),
    ["recovery_started", "recovery_started"],
  );
  await session.recoverInterruptedRun();
  assert.equal(recoverCalls, 2, "a claimed reconciliation must never be invoked again");
});

test("explicit abandonment takes precedence over repeatable and reconcile recovery", async (t) => {
  let repeatExecutions = 0;
  let reconcileCalls = 0;
  const repeatable = recoveryTool("explicit_repeatable", "repeatable", async () => {
    repeatExecutions += 1;
    return { content: "must not repeat", isError: false };
  });
  const reconcile: HarnessTool = {
    definition: {
      name: "explicit_reconcile",
      description: "explicit reconcile recovery fixture",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } },
      },
    },
    recovery: {
      mode: "reconcile",
      async recover() {
        reconcileCalls += 1;
        return { status: "not_applied" };
      },
    },
    validate(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.value !== "string") {
        throw new TypeError("value must be a string");
      }
    },
    resources() { return []; },
    async execute() { return { content: "must not execute", isError: false }; },
  };
  const tools = [repeatable, reconcile];
  const selected = selection(tools);
  const manager = await managerFixture(t, "explicit-resolution-precedence");
  const accepted = acceptRun(manager, selected);
  materializePrompt(manager, accepted.operationId, accepted.promptNodeId);
  const assistantNodeId = beginToolStep(manager, accepted.operationId, selected);
  const effects = [
    { effectId: "explicit-repeat-effect", callId: "explicit-repeat-call", tool: repeatable, policy: "repeatable" as const, index: 0 },
    { effectId: "explicit-reconcile-effect", callId: "explicit-reconcile-call", tool: reconcile, policy: "reconcile" as const, index: 1 },
  ];
  for (const effect of effects) {
    prepareEffect(manager, {
      operationId: accepted.operationId,
      assistantNodeId,
      selected,
      effectId: effect.effectId,
      callId: effect.callId,
      toolName: effect.tool.definition.name,
      policy: effect.policy,
      input: { value: effect.effectId },
      resultNodeId: "explicit-resolution-results",
      index: effect.index,
    });
    dispatchEffect(manager, effect.effectId);
  }

  const session = await openSession(manager, tools);
  t.after(async () => await session.close());
  assert.deepEqual(await session.recoverInterruptedRun({
    resolutions: effects.map((effect) => ({ effectId: effect.effectId, outcome: "abandoned" as const })),
  }), {
    recovered: true,
    operationId: accepted.operationId,
    blocked: [],
  });
  assert.equal(repeatExecutions, 0);
  assert.equal(reconcileCalls, 0);
  assert.deepEqual(
    effects.map((effect) => manager.getV4State().toolEffects.get(effect.effectId)?.status),
    ["abandoned", "abandoned"],
  );
});

test("never-repeat effects block until abandoned or supplied a manual result", async (t) => {
  let executions = 0;
  const tool = recoveryTool("never_repeat_fixture", "never_repeat", async () => {
    executions += 1;
    return { content: "must not execute", isError: false };
  });
  const selected = selection([tool]);
  const manager = await managerFixture(t, "never-repeat");
  const accepted = acceptRun(manager, selected);
  materializePrompt(manager, accepted.operationId, accepted.promptNodeId);
  const assistantNodeId = beginToolStep(manager, accepted.operationId, selected);
  for (const effect of [
    { effectId: "effect-abandoned", callId: "call-abandoned", index: 0 },
    { effectId: "effect-manual", callId: "call-manual", index: 1 },
  ]) {
    prepareEffect(manager, {
      operationId: accepted.operationId,
      assistantNodeId,
      selected,
      ...effect,
      toolName: tool.definition.name,
      policy: "never_repeat",
      input: { value: effect.effectId },
      resultNodeId: "manual-results",
    });
    dispatchEffect(manager, effect.effectId);
  }

  const session = await openSession(manager, [tool]);
  t.after(async () => await session.close());
  const blocked = await session.recoverInterruptedRun();
  assert.equal(blocked.recovered, false);
  assert.equal(blocked.operationId, accepted.operationId);
  assert.deepEqual(
    blocked.blocked.map((entry) => entry.effectId),
    ["effect-abandoned", "effect-manual"],
  );
  assert.equal(executions, 0);

  const manualResult: ToolResult = {
    content: "operator verified the completed effect",
    isError: false,
    status: "success",
  };
  assert.deepEqual(await session.recoverInterruptedRun({
    resolutions: [
      { effectId: "effect-abandoned", outcome: "abandoned" },
      { effectId: "effect-manual", outcome: "succeeded", result: manualResult },
    ],
  }), {
    recovered: true,
    operationId: accepted.operationId,
    blocked: [],
  });

  const state = manager.getV4State();
  assert.equal(state.toolEffects.get("effect-abandoned")?.status, "abandoned");
  assert.equal(state.toolEffects.get("effect-manual")?.status, "succeeded");
  const results = messagePayload(manager, "manual-results");
  assert.match(String(results.content[0]?.["content"]), /manually abandoned/u);
  assert.equal(results.content[1]?.["content"], manualResult.content);
  assert.equal(executions, 0);
});

test("lower-level suspended reopen defers direct-host model and thinking selection until recovery", async (t) => {
  let executions = 0;
  const tool = recoveryTool("deferred_selection_fixture", "never_repeat", async () => {
    executions += 1;
    return { content: "must not execute", isError: false };
  });
  const selected: SessionV4RunSelection = { ...selection([tool]), thinkingLevel: "low" };
  const manager = await managerFixture(t, "deferred-selection");
  const accepted = acceptRun(manager, selected);
  materializePrompt(manager, accepted.operationId, accepted.promptNodeId);
  const assistantNodeId = beginToolStep(manager, accepted.operationId, selected);
  prepareEffect(manager, {
    operationId: accepted.operationId,
    assistantNodeId,
    selected,
    effectId: "deferred-selection-effect",
    callId: "deferred-selection-call",
    toolName: tool.definition.name,
    policy: "never_repeat",
    input: { value: "uncertain" },
    resultNodeId: "deferred-selection-result",
    index: 0,
  });
  dispatchEffect(manager, "deferred-selection-effect");

  const requestedModelId = "requested-recovery-model";
  const host = await loadDirectExtensions([], {
    workspace: manager.getCwd(),
    activationFailure: "throw",
    inlineExtensions: [{
      name: "deferred-selection-provider",
      factory(api) {
        api.registerProvider(PROVIDER, {
          name: PROVIDER,
          baseUrl: "https://example.test/v1",
          api: "openai-completions",
          apiKey: "fixture-key",
          models: [MODEL, requestedModelId].map((id) => ({
            id,
            name: id,
            api: "openai-completions" as const,
            reasoning: true,
            input: ["text"] as const,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4_096,
            maxTokens: 512,
          })),
        });
      },
    }],
  });
  t.after(async () => await host.close());
  const selectionEntries = () => manager.getEntries().flatMap((entry) => {
    if (entry.type === "model_change") return [`model:${entry.provider}/${entry.modelId}`];
    if (entry.type === "thinking_level_change") return [`thinking:${entry.thinkingLevel}`];
    return [];
  });
  const historicalEntries = selectionEntries();
  const session = await AgentSession.create({
    sessionManager: manager,
    providers: new ProviderRegistry(),
    modelRegistry: new ModelRegistry(createModels()),
    settingsManager: SettingsManager.inMemory(),
    extensionRunner: host,
    tools: [tool],
    model: {
      provider: PROVIDER,
      api: API,
      id: requestedModelId,
    },
    thinkingLevel: "high",
  });
  t.after(async () => await session.close());

  assert.equal(session.suspendedRun?.effects[0]?.policy, "never_repeat");
  assert.equal(session.nativeModel?.id, MODEL);
  assert.equal(session.thinkingLevel, "low");
  assert.deepEqual(selectionEntries(), historicalEntries);
  await assert.rejects(session.prompt("must recover first"), /Call recoverInterruptedRun/u);
  assert.equal(session.nativeModel?.id, MODEL);
  assert.equal(session.thinkingLevel, "low");
  assert.deepEqual(selectionEntries(), historicalEntries);

  const blocked = await session.recoverInterruptedRun();
  assert.equal(blocked.recovered, false);
  assert.equal(blocked.operationId, accepted.operationId);
  assert.deepEqual(blocked.blocked.map((entry) => entry.effectId), ["deferred-selection-effect"]);
  assert.equal(executions, 0);
  assert.equal(session.nativeModel?.id, MODEL);
  assert.equal(session.thinkingLevel, "low");
  assert.deepEqual(selectionEntries(), historicalEntries);

  assert.deepEqual(await session.recoverInterruptedRun({
    resolutions: [{ effectId: "deferred-selection-effect", outcome: "abandoned" }],
  }), {
    recovered: true,
    operationId: accepted.operationId,
    blocked: [],
  });
  assert.equal(executions, 0);
  assert.equal(session.nativeModel?.id, requestedModelId);
  assert.equal(session.thinkingLevel, "high");
  assert.deepEqual(selectionEntries(), [
    `model:${PROVIDER}/${requestedModelId}`,
    "thinking:high",
  ]);
});

test("lower-level suspended reopen retains an unjournaled matching constructor selection", async (t) => {
  const manager = await managerFixture(t, "matching-constructor-selection");
  const selected: SessionV4RunSelection = { ...selection([]), thinkingLevel: "low" };
  acceptRun(manager, selected);
  const session = await AgentSession.create({
    sessionManager: manager,
    providers: new ProviderRegistry([new RecoveryProvider()]),
    settingsManager: SettingsManager.inMemory(),
    model: SELECTED_MODEL,
    thinkingLevel: "low",
  });
  t.after(async () => await session.close());

  assert.deepEqual(session.nativeModel, SELECTED_MODEL);
  assert.equal(session.thinkingLevel, "low");
  assert.equal(manager.getEntries().some((entry) =>
    entry.type === "model_change" || entry.type === "thinking_level_change"), false);
});

test("manual recovery rejects unbounded results before journaling and accepts a bounded retry", async (t) => {
  const tool = recoveryTool("bounded_manual_recovery", "never_repeat", async () => ({
    content: "must not execute",
    isError: false,
  }));
  const selected = selection([tool]);
  const manager = await managerFixture(t, "bounded-manual-recovery");
  const accepted = acceptRun(manager, selected);
  materializePrompt(manager, accepted.operationId, accepted.promptNodeId);
  const assistantNodeId = beginToolStep(manager, accepted.operationId, selected);
  prepareEffect(manager, {
    operationId: accepted.operationId,
    assistantNodeId,
    selected,
    effectId: "bounded-manual-effect",
    callId: "bounded-manual-call",
    toolName: tool.definition.name,
    policy: "never_repeat",
    input: { value: "bounded retry" },
    resultNodeId: "bounded-manual-result",
    index: 0,
  });
  dispatchEffect(manager, "bounded-manual-effect");

  const session = await openSession(manager, [tool]);
  t.after(async () => await session.close());
  const before = manager.getV4State();
  const invalidResults: ToolResult[] = [
    { content: "x".repeat(MAX_TOOL_RESULT_CONTENT_BYTES + 1), isError: false },
    {
      content: "oversized metadata",
      isError: false,
      metadata: { payload: "x".repeat(MAX_TOOL_RESULT_METADATA_BYTES + 1) },
    },
    {
      content: "invalid status",
      isError: false,
      status: "pending" as never,
    },
    {
      content: "too many actions",
      isError: false,
      nextActions: Array.from({ length: 9 }, (_, index) => `action-${index}`),
    },
  ];
  for (const result of invalidResults) {
    await assert.rejects(
      session.recoverInterruptedRun({
        resolutions: [{
          effectId: "bounded-manual-effect",
          outcome: "succeeded",
          result,
        }],
      }),
      /Recovery tool result|bounded tool result/u,
    );
    assert.deepEqual(
      manager.getV4State(),
      before,
      "invalid recovery input must not append or reduce any durable change",
    );
    assert.equal(session.suspendedRun?.effects[0]?.status, "dispatched");
  }

  const image = {
    type: "image" as const,
    mediaType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=",
  };
  const result: ToolResult = {
    content: "operator verified the bounded effect",
    contentBlocks: [{ type: "text", text: "operator verified the bounded effect" }],
    isError: false,
    status: "success",
    summary: "verified",
    nextActions: ["continue"],
    terminate: false,
    metadata: { verified: true },
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    addedToolNames: [tool.definition.name],
    artifacts: [{ id: "artifact-1", path: "artifact.txt", mediaType: "text/plain", bytes: 7 }],
    images: [image],
  };
  assert.deepEqual(await session.recoverInterruptedRun({
    resolutions: [{
      effectId: "bounded-manual-effect",
      outcome: "succeeded",
      result,
    }],
  }), {
    recovered: true,
    operationId: accepted.operationId,
    blocked: [],
  });

  const stored = messagePayload(manager, "bounded-manual-result").content[0];
  assert.equal(stored?.["content"], result.content);
  assert.deepEqual(stored?.["contentBlocks"], result.contentBlocks);
  assert.deepEqual(stored?.["images"], result.images);
  assert.deepEqual(stored?.["metadata"], result.metadata);
  assert.deepEqual(stored?.["usage"], result.usage);
  assert.deepEqual(stored?.["addedToolNames"], result.addedToolNames);
  assert.deepEqual(stored?.["artifactIds"], ["artifact-1"]);
  assert.equal(session.suspendedRun, undefined);
});

test("recovery observes each newly durable in-doubt transition once without replaying reopened state", async (t) => {
  const tool = recoveryTool("observed_never_repeat", "never_repeat", async () => ({
    content: "must not execute",
    isError: false,
  }));
  const selected = selection([tool]);
  const manager = await managerFixture(t, "observed-in-doubt");
  const accepted = acceptRun(manager, selected);
  materializePrompt(manager, accepted.operationId, accepted.promptNodeId);
  const assistantNodeId = beginToolStep(manager, accepted.operationId, selected);
  prepareEffect(manager, {
    operationId: accepted.operationId,
    assistantNodeId,
    selected,
    effectId: "newly-uncertain-effect",
    callId: "newly-uncertain-call",
    toolName: tool.definition.name,
    policy: "never_repeat",
    input: { value: "newly uncertain" },
    resultNodeId: "observed-in-doubt-result",
    index: 0,
  });
  dispatchEffect(manager, "newly-uncertain-effect");

  const sink = new RecordingObservabilitySink();
  const observability = new RuntimeObservability(sink, {
    mode: "sdk",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
    closeSink: false,
  });
  t.after(async () => await observability.close());
  const session = await openSession(manager, [tool], { observability });
  t.after(async () => await session.close());
  const envelopes: EventEnvelope[] = [];
  session.onEvent((envelope) => { envelopes.push(envelope); });

  const blocked = await session.recoverInterruptedRun();
  assert.equal(blocked.recovered, false);
  assert.equal(blocked.operationId, accepted.operationId);
  assert.deepEqual(
    envelopes.filter((envelope) => envelope.event.type === "tool_in_doubt")
      .map((envelope) => ({ runId: envelope.runId, event: envelope.event })),
    [{
      runId: accepted.operationId,
      event: {
        type: "tool_in_doubt",
        callId: "newly-uncertain-call",
        name: "observed_never_repeat",
        index: 0,
        reason: "Tool outcome is unknown after process interruption",
      },
    }],
  );
  assert.equal(envelopes.some((envelope) => envelope.event.type === "run_cancelled"), false);

  const blockedAgain = await session.recoverInterruptedRun();
  assert.equal(blockedAgain.recovered, false);
  assert.equal(envelopes.filter((envelope) => envelope.event.type === "tool_in_doubt").length, 1);
  assert.deepEqual(await session.recoverInterruptedRun({
    resolutions: [{ effectId: "newly-uncertain-effect", outcome: "abandoned" }],
  }), {
    recovered: true,
    operationId: accepted.operationId,
    blocked: [],
  });
  let state = manager.getV4State();
  assert.equal(state.operations.get(accepted.operationId)?.status, "cancelled");
  assert.equal(state.branches.get(state.primaryBranchId)?.openOperationId, null);
  const terminal = envelopes.filter((envelope) =>
    envelope.event.type === "run_completed" ||
    envelope.event.type === "run_failed" ||
    envelope.event.type === "run_cancelled");
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.runId, accepted.operationId);
  assert.equal(terminal[0]?.event.type, "run_cancelled");

  assert.deepEqual(await session.recoverInterruptedRun(), {
    recovered: false,
    blocked: [],
  });
  state = manager.getV4State();
  assert.equal(state.operations.get(accepted.operationId)?.status, "cancelled");
  assert.equal(state.branches.get(state.primaryBranchId)?.openOperationId, null);
  assert.equal(envelopes.filter((envelope) => envelope.event.type === "tool_in_doubt").length, 1);
  assert.equal(envelopes.filter((envelope) => envelope.event.type === "run_cancelled").length, 1);
  observability.snapshot();
  const snapshot = sink.records.findLast((record) => record.kind === "metrics_snapshot");
  assert.equal(snapshot?.fields.tools_in_doubt, 1);
  assert.equal(snapshot?.fields.runs_cancelled, 1);
  assert.equal(snapshot?.fields.active_runs, 0);
});

test("recovery does not re-observe an in-doubt transition persisted before reopen", async (t) => {
  const tool = recoveryTool("reopened_never_repeat", "never_repeat", async () => ({
    content: "must not execute",
    isError: false,
  }));
  const selected = selection([tool]);
  const manager = await managerFixture(t, "reopened-in-doubt");
  const accepted = acceptRun(manager, selected);
  materializePrompt(manager, accepted.operationId, accepted.promptNodeId);
  const assistantNodeId = beginToolStep(manager, accepted.operationId, selected);
  prepareEffect(manager, {
    operationId: accepted.operationId,
    assistantNodeId,
    selected,
    effectId: "already-uncertain-effect",
    callId: "already-uncertain-call",
    toolName: tool.definition.name,
    policy: "never_repeat",
    input: { value: "already uncertain" },
    resultNodeId: "reopened-in-doubt-result",
    index: 0,
  });
  dispatchEffect(manager, "already-uncertain-effect");
  manager.commitChanges([{
    type: "tool_effect_in_doubt",
    effectId: "already-uncertain-effect",
    noticedAt: TIME,
    detail: { reason: "process_interrupted" },
  }]);

  const sink = new RecordingObservabilitySink();
  const observability = new RuntimeObservability(sink, {
    mode: "sdk",
    processInstance: "0123456789abcdef",
    snapshotIntervalMs: 60_000,
    closeSink: false,
  });
  t.after(async () => await observability.close());
  const session = await openSession(manager, [tool], { observability });
  t.after(async () => await session.close());
  const runtimeEvents: RuntimeEvent[] = [];
  session.onEvent((envelope) => { runtimeEvents.push(envelope.event); });

  const blocked = await session.recoverInterruptedRun();
  assert.equal(blocked.recovered, false);
  assert.equal(runtimeEvents.some((event) => event.type === "tool_in_doubt"), false);
  observability.snapshot();
  const snapshot = sink.records.findLast((record) => record.kind === "metrics_snapshot");
  assert.equal(snapshot?.fields.tools_in_doubt, 0);
});

test("recovery synthesizes a missing terminal result node and closes claimed queue work", async (t) => {
  let executions = 0;
  const tool = recoveryTool("settled_fixture", "repeatable", async () => {
    executions += 1;
    return { content: "must not repeat", isError: false };
  });
  const selected = selection([tool]);
  const manager = await managerFixture(t, "terminal-result-and-queue");
  manager.commitChanges([{
    type: "queue_added",
    branchId: "main",
    entryId: "claimed-queue",
    targetNodeId: "claimed-message",
    kind: "follow_up",
    addedAt: TIME,
    message: {
      text: "queued follow-up",
      mode: "follow_up",
    },
  }]);
  const accepted = acceptRun(manager, selected);
  materializePrompt(manager, accepted.operationId, accepted.promptNodeId);
  const assistantNodeId = beginToolStep(manager, accepted.operationId, selected);
  prepareEffect(manager, {
    operationId: accepted.operationId,
    assistantNodeId,
    selected,
    effectId: "effect-settled",
    callId: "call-settled",
    toolName: tool.definition.name,
    policy: "repeatable",
    input: { value: "already-completed" },
    resultNodeId: "missing-result-node",
    index: 0,
  });
  dispatchEffect(manager, "effect-settled");
  manager.commitChanges([
    {
      type: "tool_effect_finished",
      effectId: "effect-settled",
      finishedAt: TIME,
      outcome: "succeeded",
      result: {
        type: "tool_result",
        callId: "call-settled",
        name: tool.definition.name,
        content: "durable completed result",
        isError: false,
        status: "success",
      },
    },
    {
      type: "queue_claimed",
      branchId: "main",
      entryId: "claimed-queue",
      operationId: accepted.operationId,
      claimedAt: TIME,
    },
  ]);
  assert.equal(manager.getV4State().nodes.has("missing-result-node"), false);

  const session = await openSession(manager, [tool]);
  t.after(async () => await session.close());
  assert.deepEqual(await session.recoverInterruptedRun(), {
    recovered: true,
    operationId: accepted.operationId,
    blocked: [],
  });

  const state = manager.getV4State();
  assert.equal(executions, 0);
  assert.equal(state.operations.get(accepted.operationId)?.status, "cancelled");
  assert.equal(state.queue.get("claimed-queue")?.status, "consumed");
  assert.deepEqual(messagePayload(manager, "claimed-message").content, [{
    type: "text",
    text: "queued follow-up",
  }]);
  assert.equal(
    messagePayload(manager, "missing-result-node").content[0]?.["content"],
    "durable completed result",
  );
  assert.deepEqual(await session.recoverInterruptedRun(), {
    recovered: false,
    blocked: [],
  });
});
