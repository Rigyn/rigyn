import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";

import {
  AgentHarness,
  InMemorySessionRepo,
  createAssistantEventStream,
  type AgentHarnessEvent,
  type AgentMessage as HarnessMessage,
  type AgentTool,
  type AssistantMessage,
  type Model,
  type Models,
  type Usage,
} from "@rigyn/kernel";
import { NodeExecutionEnv } from "@rigyn/kernel/node";
import { AgentRunner, RunControl } from "../../src/core/agent.js";
import type { EventEnvelope, EventSink, RuntimeEvent } from "../../src/core/events.js";
import type { JsonValue } from "../../src/core/json.js";
import type {
  AdapterEvent,
  CanonicalMessage,
  ModelInfo,
  NormalizedUsage,
  ProviderAdapter,
  ProviderRequest,
} from "../../src/core/types.js";
import { DirectProcessRunner } from "../../src/process/runner.js";
import { ToolCoordinator } from "../../src/tools/coordinator.js";
import { WorkspaceBoundary } from "../../src/tools/paths.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { HarnessTool } from "../../src/tools/types.js";

interface Accounting {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  reasoning: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

interface ScriptedToolCall {
  id: string;
  name: string;
  arguments: Record<string, JsonValue>;
}

type ScriptedStep =
  | { kind: "response"; text?: string; toolCall?: ScriptedToolCall; usage: Accounting }
  | { kind: "failure"; message: string };

interface Scenario {
  prompt: string;
  steps: ScriptedStep[];
  holdFirst?: boolean;
  whileHeld?: { type: "cancel" } | { type: "follow_up"; text: string };
}

type NormalizedPart =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown }
  | { type: "tool_result"; id: string; name: string; text: string; isError: boolean };

interface NormalizedMessage {
  role: "user" | "assistant" | "tool";
  parts: NormalizedPart[];
  stop?: "stop" | "tool" | "length" | "error" | "aborted";
  error?: string;
  usage: Accounting;
}

type NormalizedEvent =
  | { type: "lifecycle"; state: "started" | "completed" | "failed" | "cancelled"; detail?: string }
  | { type: "message"; message: NormalizedMessage }
  | { type: "tool"; phase: "started" | "completed"; id: string; name: string; isError?: boolean };

interface NormalizedTrace {
  timeline: NormalizedEvent[];
  durableMessages: NormalizedMessage[];
  usage: Accounting;
}

const model: Model = {
  id: "trace-model",
  name: "Trace Model",
  api: "trace",
  provider: "trace",
  baseUrl: "http://localhost.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

const firstUsage = accounting(8, 3, 2, 1, 1, 2);
const secondUsage = accounting(13, 5, 4, 2, 1, 3);
const toolUsage = accounting(2, 1, 1, 1, 1, 0);

function accounting(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  cacheWrite1h: number,
  reasoning: number,
): Accounting {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheWrite1h,
    reasoning,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: {
      input,
      output,
      cacheRead,
      cacheWrite,
      total: input + output + cacheRead + cacheWrite,
    },
  };
}

function emptyAccounting(): Accounting {
  return accounting(0, 0, 0, 0, 0, 0);
}

function addAccounting(left: Accounting, right: Accounting): Accounting {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    cacheWrite1h: left.cacheWrite1h + right.cacheWrite1h,
    reasoning: left.reasoning + right.reasoning,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

function productUsage(value?: NormalizedUsage): Accounting {
  return {
    input: value?.inputTokens ?? 0,
    output: value?.outputTokens ?? 0,
    cacheRead: value?.cacheReadTokens ?? 0,
    cacheWrite: value?.cacheWriteTokens ?? 0,
    cacheWrite1h: value?.cacheWrite1hTokens ?? 0,
    reasoning: value?.reasoningTokens ?? 0,
    totalTokens: value?.totalTokens ?? 0,
    cost: {
      input: value?.cost?.input ?? 0,
      output: value?.cost?.output ?? 0,
      cacheRead: value?.cost?.cacheRead ?? 0,
      cacheWrite: value?.cost?.cacheWrite ?? 0,
      total: value?.cost?.total ?? 0,
    },
  };
}

function harnessUsage(value?: Usage): Accounting {
  return {
    input: value?.input ?? 0,
    output: value?.output ?? 0,
    cacheRead: value?.cacheRead ?? 0,
    cacheWrite: value?.cacheWrite ?? 0,
    cacheWrite1h: value?.cacheWrite1h ?? 0,
    reasoning: value?.reasoning ?? 0,
    totalTokens: value?.totalTokens ?? 0,
    cost: {
      input: value?.cost.input ?? 0,
      output: value?.cost.output ?? 0,
      cacheRead: value?.cost.cacheRead ?? 0,
      cacheWrite: value?.cost.cacheWrite ?? 0,
      total: value?.cost.total ?? 0,
    },
  };
}

function toProductUsage(value: Accounting): NormalizedUsage {
  return {
    inputTokens: value.input,
    outputTokens: value.output,
    cacheReadTokens: value.cacheRead,
    cacheWriteTokens: value.cacheWrite,
    cacheWrite1hTokens: value.cacheWrite1h,
    reasoningTokens: value.reasoning,
    totalTokens: value.totalTokens,
    cost: { ...value.cost },
  };
}

function toHarnessUsage(value: Accounting): Usage {
  return { ...value, cost: { ...value.cost } };
}

function productStop(reason: CanonicalMessage["stopReason"]): NormalizedMessage["stop"] | undefined {
  if (reason === "tool_calls") return "tool";
  if (reason === "stop" || reason === "length" || reason === "error" || reason === "aborted") return reason;
  return undefined;
}

function normalizeProductMessage(message: CanonicalMessage): NormalizedMessage {
  const role = message.role === "tool" ? "tool" : message.role === "assistant" ? "assistant" : "user";
  const parts = message.content.flatMap((part): NormalizedPart[] => {
    if (part.type === "text") return [{ type: "text", text: part.text }];
    if (part.type === "tool_call") {
      return [{ type: "tool_call", id: part.callId, name: part.name, arguments: part.arguments }];
    }
    if (part.type === "tool_result") {
      return [{ type: "tool_result", id: part.callId, name: part.name, text: part.content, isError: part.isError }];
    }
    return [];
  });
  const stop = productStop(message.stopReason);
  return {
    role,
    parts,
    ...(stop === undefined ? {} : { stop }),
    ...(stop === "error" && message.errorMessage !== undefined ? { error: message.errorMessage } : {}),
    usage: productUsage(message.usage),
  };
}

function harnessText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => part !== null && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
    ? [String(part.text)]
    : []).join("");
}

function normalizeHarnessMessage(message: HarnessMessage): NormalizedMessage {
  if (message.role === "user") {
    return { role: "user", parts: [{ type: "text", text: harnessText(message.content) }], usage: emptyAccounting() };
  }
  if (message.role === "toolResult") {
    return {
      role: "tool",
      parts: [{
        type: "tool_result",
        id: message.toolCallId,
        name: message.toolName,
        text: harnessText(message.content),
        isError: message.isError,
      }],
      usage: harnessUsage(message.usage),
    };
  }
  if (message.role !== "assistant") throw new Error(`Unsupported durable message role: ${String(message.role)}`);
  const parts = message.content.flatMap((part): NormalizedPart[] => part.type === "text"
    ? [{ type: "text", text: part.text }]
    : part.type === "toolCall"
      ? [{ type: "tool_call", id: part.id, name: part.name, arguments: part.arguments }]
      : []);
  const stop = message.stopReason === "toolUse" ? "tool" : message.stopReason;
  return {
    role: "assistant",
    parts,
    stop,
    ...(stop === "error" && message.errorMessage !== undefined ? { error: message.errorMessage } : {}),
    usage: harnessUsage(message.usage),
  };
}

function trace(timeline: NormalizedEvent[], durableMessages: NormalizedMessage[]): NormalizedTrace {
  assert.deepEqual(
    timeline.flatMap((event) => event.type === "message" ? [event.message] : []),
    durableMessages,
    "message events must reflect durable order",
  );
  return {
    timeline,
    durableMessages,
    usage: durableMessages.reduce((sum, message) => addAccounting(sum, message.usage), emptyAccounting()),
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class ScriptDriver {
  readonly entered = deferred();
  readonly #released = deferred();
  readonly #steps: ScriptedStep[];
  readonly #holdFirst: boolean;
  #requests = 0;

  constructor(scenario: Scenario) {
    this.#steps = structuredClone(scenario.steps);
    this.#holdFirst = scenario.holdFirst ?? false;
  }

  release(): void {
    this.#released.resolve();
  }

  async next(signal: AbortSignal): Promise<ScriptedStep> {
    const step = this.#steps.shift();
    if (step === undefined) throw new Error("No scripted response remains");
    if (this.#holdFirst && this.#requests === 0) {
      this.entered.resolve();
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(signal.reason);
        if (signal.aborted) {
          aborted();
          return;
        }
        signal.addEventListener("abort", aborted, { once: true });
        void this.#released.promise.then(() => {
          signal.removeEventListener("abort", aborted);
          resolve();
        });
      });
    }
    this.#requests += 1;
    return step;
  }

  assertDrained(): void {
    assert.equal(this.#steps.length, 0, "all scripted responses must be consumed");
  }
}

class ScriptedProductProvider implements ProviderAdapter {
  readonly id = "trace";
  readonly #driver: ScriptDriver;

  constructor(driver: ScriptDriver) {
    this.#driver = driver;
  }

  async *stream(_request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    const step = await this.#driver.next(signal);
    if (step.kind === "failure") {
      yield {
        type: "error",
        error: { category: "provider", message: step.message, retryable: false, partial: false },
      };
      return;
    }
    yield { type: "response_start", model: model.id };
    if (step.text !== undefined) yield { type: "text_delta", part: 0, text: step.text };
    if (step.toolCall !== undefined) {
      const rawArguments = JSON.stringify(step.toolCall.arguments);
      yield { type: "tool_call_start", index: 0, id: step.toolCall.id, name: step.toolCall.name };
      yield { type: "tool_call_delta", index: 0, jsonFragment: rawArguments };
      yield {
        type: "tool_call_end",
        index: 0,
        id: step.toolCall.id,
        name: step.toolCall.name,
        rawArguments,
        arguments: step.toolCall.arguments,
      };
    }
    yield { type: "usage", usage: toProductUsage(step.usage), semantics: "final" };
    yield {
      type: "response_end",
      reason: step.toolCall === undefined ? "stop" : "tool_calls",
      state: { kind: "chat_completions", assistantMessage: { role: "assistant" } },
    };
  }

  async listModels(_signal: AbortSignal): Promise<ModelInfo[]> {
    return [];
  }
}

class ProductTraceSink implements EventSink {
  readonly durable: CanonicalMessage[] = [];
  readonly timeline: NormalizedEvent[] = [];
  #sequence = 0;

  async emit(event: RuntimeEvent): Promise<EventEnvelope> {
    if (event.type === "run_started") this.timeline.push({ type: "lifecycle", state: "started" });
    else if (event.type === "message_appended") {
      this.durable.push(event.message);
      this.timeline.push({ type: "message", message: normalizeProductMessage(event.message) });
    } else if (event.type === "tool_started") {
      this.timeline.push({ type: "tool", phase: "started", id: event.callId, name: event.name });
    } else if (event.type === "tool_completed") {
      this.timeline.push({
        type: "tool",
        phase: "completed",
        id: event.callId,
        name: event.name,
        isError: event.isError,
      });
    } else if (event.type === "run_completed") {
      this.timeline.push({ type: "lifecycle", state: "completed", detail: event.finishReason });
    } else if (event.type === "run_failed") {
      this.timeline.push({ type: "lifecycle", state: "failed", detail: event.error.message });
    } else if (event.type === "run_cancelled") {
      this.timeline.push({ type: "lifecycle", state: "cancelled" });
    }
    this.#sequence += 1;
    return {
      eventId: `event-${this.#sequence}`,
      threadId: "trace-thread",
      runId: "trace-run",
      sequence: this.#sequence,
      timestamp: new Date(0).toISOString(),
      schemaVersion: 1,
      event,
    };
  }
}

const productTool: HarnessTool = {
  definition: {
    name: "echo",
    description: "Return the supplied value",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "string" } },
    },
  },
  validate(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.value !== "string") {
      throw new Error("value must be a string");
    }
  },
  resources() {
    return [];
  },
  async execute(input) {
    const value = input !== null && typeof input === "object" && !Array.isArray(input) ? input.value : "";
    return { content: String(value), isError: false, usage: toProductUsage(toolUsage) };
  },
};

const toolSchema = Type.Object({ value: Type.String() });
const harnessTool: AgentTool<typeof toolSchema> = {
  name: "echo",
  label: "Echo",
  description: "Return the supplied value",
  parameters: toolSchema,
  async execute(_callId, input) {
    return {
      content: [{ type: "text", text: input.value }],
      details: {},
      usage: toHarnessUsage(toolUsage),
    };
  },
};

async function runProduct(scenario: Scenario): Promise<NormalizedTrace> {
  const directory = await mkdtemp(join(tmpdir(), "rigyn-authority-trace-"));
  try {
    const driver = new ScriptDriver(scenario);
    const provider = new ScriptedProductProvider(driver);
    const sink = new ProductTraceSink();
    const runner = new AgentRunner({
      conversation: {
        async loadContext() {
          return { messages: structuredClone(sink.durable) };
        },
      },
      events: () => sink,
    });
    const control = new RunControl();
    const running = runner.run({
      threadId: "trace-thread",
      prompt: scenario.prompt,
      provider,
      model: model.id,
      tools: new ToolCoordinator(new ToolRegistry([productTool])),
      toolContext: {
        workspace: await WorkspaceBoundary.create(directory),
        runner: new DirectProcessRunner(),
      },
      returnProviderErrors: true,
    }, control);
    if (scenario.whileHeld !== undefined) {
      await driver.entered.promise;
      if (scenario.whileHeld.type === "cancel") control.cancel();
      else {
        control.followUp(scenario.whileHeld.text);
        driver.release();
      }
    }
    await running;
    driver.assertDrained();
    return trace(sink.timeline, sink.durable.map(normalizeProductMessage));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assistantMessage(step: Extract<ScriptedStep, { kind: "response" }>): AssistantMessage {
  return {
    role: "assistant",
    content: [
      ...(step.text === undefined ? [] : [{ type: "text" as const, text: step.text }]),
      ...(step.toolCall === undefined ? [] : [{
        type: "toolCall" as const,
        id: step.toolCall.id,
        name: step.toolCall.name,
        arguments: step.toolCall.arguments,
      }]),
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: step.toolCall === undefined ? "stop" : "toolUse",
    timestamp: Date.now(),
    usage: toHarnessUsage(step.usage),
  };
}

function failureMessage(message: string, aborted: boolean): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: aborted ? "aborted" : "error",
    errorMessage: message,
    timestamp: Date.now(),
    usage: toHarnessUsage(emptyAccounting()),
  };
}

function scriptedModels(driver: ScriptDriver): Models {
  const models: Pick<Models, "streamSimple" | "completeSimple"> = {
    streamSimple(_model, _context, options) {
      const stream = createAssistantEventStream();
      queueMicrotask(() => void (async () => {
        try {
          const step = await driver.next(options?.signal ?? new AbortController().signal);
          if (step.kind === "failure") {
            stream.push({ type: "error", reason: "error", error: failureMessage(step.message, false) });
          } else {
            const message = assistantMessage(step);
            stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          stream.push({ type: "error", reason: "aborted", error: failureMessage(message, true) });
        }
      })());
      return stream;
    },
    async completeSimple() {
      throw new Error("Unexpected completion request");
    },
  };
  return models as unknown as Models;
}

function recordHarnessEvent(timeline: NormalizedEvent[], event: AgentHarnessEvent): void {
  if (event.type === "agent_start") timeline.push({ type: "lifecycle", state: "started" });
  else if (event.type === "message_end") {
    timeline.push({ type: "message", message: normalizeHarnessMessage(event.message) });
  } else if (event.type === "tool_execution_start") {
    timeline.push({ type: "tool", phase: "started", id: event.toolCallId, name: event.toolName });
  } else if (event.type === "tool_execution_end") {
    timeline.push({
      type: "tool",
      phase: "completed",
      id: event.toolCallId,
      name: event.toolName,
      isError: event.isError,
    });
  } else if (event.type === "agent_end") {
    const final = [...event.messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
    if (final === undefined) throw new Error("Agent lifecycle ended without an assistant message");
    if (final.stopReason === "aborted") timeline.push({ type: "lifecycle", state: "cancelled" });
    else if (final.stopReason === "error") {
      timeline.push({ type: "lifecycle", state: "failed", detail: final.errorMessage ?? "" });
    } else timeline.push({ type: "lifecycle", state: "completed", detail: final.stopReason });
  }
}

async function runHarness(scenario: Scenario): Promise<NormalizedTrace> {
  const driver = new ScriptDriver(scenario);
  const repo = new InMemorySessionRepo();
  const session = await repo.create({ id: "trace-session" });
  const timeline: NormalizedEvent[] = [];
  const harness = new AgentHarness({
    env: new NodeExecutionEnv({ cwd: process.cwd() }),
    session,
    models: scriptedModels(driver),
    model,
    tools: [harnessTool],
  });
  harness.subscribe((event) => recordHarnessEvent(timeline, event));
  const running = harness.prompt(scenario.prompt);
  if (scenario.whileHeld !== undefined) {
    await driver.entered.promise;
    if (scenario.whileHeld.type === "cancel") await harness.abort();
    else {
      await harness.followUp(scenario.whileHeld.text);
      driver.release();
    }
  }
  await running;
  driver.assertDrained();
  const durableMessages = (await session.getEntries()).flatMap((entry) => entry.type === "message"
    ? [normalizeHarnessMessage(entry.message)]
    : []);
  return trace(timeline, durableMessages);
}

async function assertConforms(scenario: Scenario): Promise<NormalizedTrace> {
  const product = await runProduct(scenario);
  const harness = await runHarness(scenario);
  assert.deepEqual(harness, product);
  return product;
}

test("scripted text turns produce the same observable trace", async () => {
  const result = await assertConforms({
    prompt: "hello",
    steps: [{ kind: "response", text: "hello back", usage: firstUsage }],
  });

  assert.deepEqual(result.durableMessages.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(result.usage, firstUsage);
});

test("scripted tool turns preserve call, result, message, and accounting order", async () => {
  const result = await assertConforms({
    prompt: "echo a value",
    steps: [
      {
        kind: "response",
        toolCall: { id: "call-1", name: "echo", arguments: { value: "from tool" } },
        usage: firstUsage,
      },
      { kind: "response", text: "tool complete", usage: secondUsage },
    ],
  });

  assert.deepEqual(result.timeline.map((event) => event.type === "tool" ? `${event.phase}:${event.name}` : event.type), [
    "lifecycle",
    "message",
    "message",
    "started:echo",
    "completed:echo",
    "message",
    "message",
    "lifecycle",
  ]);
  assert.deepEqual(result.durableMessages.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
  assert.deepEqual(result.usage, addAccounting(addAccounting(firstUsage, toolUsage), secondUsage));
});

test("provider failures and cancellation settle through equivalent durable lifecycles", async (context) => {
  await context.test("failure", async () => {
    const result = await assertConforms({
      prompt: "fail",
      steps: [{ kind: "failure", message: "scripted provider failure" }],
    });
    assert.deepEqual(result.timeline.map((event) => event.type === "lifecycle" ? event.state : event.type), [
      "started",
      "message",
      "message",
      "failed",
    ]);
  });

  await context.test("cancellation", async () => {
    const result = await assertConforms({
      prompt: "wait",
      steps: [{ kind: "response", text: "too late", usage: firstUsage }],
      holdFirst: true,
      whileHeld: { type: "cancel" },
    });
    assert.deepEqual(result.timeline.map((event) => event.type === "lifecycle" ? event.state : event.type), [
      "started",
      "message",
      "message",
      "cancelled",
    ]);
  });
});

test("follow-up queues retain cross-turn durable order", async () => {
  const result = await assertConforms({
    prompt: "first",
    steps: [
      { kind: "response", text: "first response", usage: firstUsage },
      { kind: "response", text: "queued response", usage: secondUsage },
    ],
    holdFirst: true,
    whileHeld: { type: "follow_up", text: "queued" },
  });

  assert.deepEqual(result.durableMessages.map((message) => [message.role, message.parts]), [
    ["user", [{ type: "text", text: "first" }]],
    ["assistant", [{ type: "text", text: "first response" }]],
    ["user", [{ type: "text", text: "queued" }]],
    ["assistant", [{ type: "text", text: "queued response" }]],
  ]);
});
