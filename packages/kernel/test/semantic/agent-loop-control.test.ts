import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import {
  agentLoop,
  agentLoopContinue,
  createAssistantEventStream,
  type AgentMessage,
  type AgentTool,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Message,
  type Model,
} from "../../src/index.js";

const model: Model = {
  id: "control-model",
  name: "Control Model",
  api: "control",
  provider: "control",
  baseUrl: "http://localhost.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

function message(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
  activeModel = model,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: activeModel.api,
    provider: activeModel.provider,
    model: activeModel.id,
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function streamOf(value: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantEventStream();
  queueMicrotask(() => stream.push({ type: "done", reason: value.stopReason, message: value }));
  return stream;
}

const convert = (messages: AgentMessage[]): Message[] => messages.filter(
  (item): item is Message => item.role === "user" || item.role === "assistant" || item.role === "toolResult",
);

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a sequential tool makes the entire call batch execute in source order", async () => {
  const schema = Type.Object({});
  const releaseFirst = deferred();
  const firstStarted = deferred();
  const order: string[] = [];
  const first: AgentTool<typeof schema> = {
    name: "first",
    label: "First",
    description: "First operation",
    parameters: schema,
    executionMode: "sequential",
    async execute() {
      order.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      order.push("first:end");
      return { content: [], details: {}, terminate: true };
    },
  };
  const second: AgentTool<typeof schema> = {
    name: "second",
    label: "Second",
    description: "Second operation",
    parameters: schema,
    async execute() {
      order.push("second:start");
      order.push("second:end");
      return { content: [], details: {}, terminate: true };
    },
  };
  const response = message([
    { type: "toolCall", id: "one", name: first.name, arguments: {} },
    { type: "toolCall", id: "two", name: second.name, arguments: {} },
  ], "toolUse");
  const loop = agentLoop(
    [{ role: "user", content: "run", timestamp: 1 }],
    { systemPrompt: "", messages: [], tools: [first, second] },
    { model, convertToLlm: convert },
    undefined,
    () => streamOf(response),
  );
  const consume = (async () => { for await (const _event of loop) {} })();

  await firstStarted.promise;
  assert.deepEqual(order, ["first:start"]);
  releaseFirst.resolve();
  await consume;
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("steering is injected only after every tool in the current batch settles", async () => {
  const schema = Type.Object({});
  const calls: AgentTool<typeof schema> = {
    name: "finish",
    label: "Finish",
    description: "Completes a unit of work",
    parameters: schema,
    async execute() {
      return { content: [{ type: "text", text: "finished" }], details: {} };
    },
  };
  const responses = [
    message([{ type: "toolCall", id: "tool", name: calls.name, arguments: {} }], "toolUse"),
    message([{ type: "text", text: "done" }]),
  ];
  const seenContexts: Message[][] = [];
  let queueReads = 0;
  const loop = agentLoop(
    [{ role: "user", content: "start", timestamp: 1 }],
    { systemPrompt: "", messages: [], tools: [calls] },
    {
      model,
      convertToLlm: convert,
      getSteeringMessages: async () => queueReads++ === 1
        ? [{ role: "user", content: "steer", timestamp: 2 }]
        : [],
    },
    undefined,
    (_model, context) => {
      seenContexts.push(context.messages.slice());
      const next = responses.shift();
      if (!next) throw new Error("Unexpected provider request");
      return streamOf(next);
    },
  );
  for await (const _event of loop) {}

  assert.equal(seenContexts.length, 2);
  assert.deepEqual(seenContexts[1]?.map((item) => item.role), ["user", "assistant", "toolResult", "user"]);
});

test("next-turn preparation atomically replaces context, model, and thinking level", async () => {
  const nextModel: Model = { ...model, id: "next-model", name: "Next Model", reasoning: true };
  const schema = Type.Object({});
  const tool: AgentTool<typeof schema> = {
    name: "continue",
    label: "Continue",
    description: "Continues the run",
    parameters: schema,
    async execute() { return { content: [], details: {} }; },
  };
  const responses = [
    message([{ type: "toolCall", id: "call", name: tool.name, arguments: {} }], "toolUse"),
    message([{ type: "text", text: "done" }], "stop", nextModel),
  ];
  const requests: Array<{ modelId: string; systemPrompt: string; reasoning: unknown }> = [];
  let prepared = false;
  const loop = agentLoop(
    [{ role: "user", content: "start", timestamp: 1 }],
    { systemPrompt: "before", messages: [], tools: [tool] },
    {
      model,
      convertToLlm: convert,
      prepareNextTurn: async () => {
        if (prepared) return undefined;
        prepared = true;
        return {
          context: { systemPrompt: "after", messages: [{ role: "user", content: "replacement", timestamp: 2 }], tools: [tool] },
          model: nextModel,
          thinkingLevel: "high",
        };
      },
    },
    undefined,
    (activeModel, context, options) => {
      requests.push({ modelId: activeModel.id, systemPrompt: context.systemPrompt, reasoning: options?.reasoning });
      const next = responses.shift();
      if (!next) throw new Error("Unexpected provider request");
      return streamOf(next);
    },
  );
  for await (const _event of loop) {}

  assert.deepEqual(requests, [
    { modelId: model.id, systemPrompt: "before", reasoning: undefined },
    { modelId: nextModel.id, systemPrompt: "after", reasoning: "high" },
  ]);
});

test("turn-stop policy prevents another provider request after a tool batch", async () => {
  const schema = Type.Object({});
  const tool: AgentTool<typeof schema> = {
    name: "work",
    label: "Work",
    description: "Does work",
    parameters: schema,
    async execute() { return { content: [], details: {} }; },
  };
  let providerCalls = 0;
  const loop = agentLoop(
    [{ role: "user", content: "start", timestamp: 1 }],
    { systemPrompt: "", messages: [], tools: [tool] },
    { model, convertToLlm: convert, shouldStopAfterTurn: () => true },
    undefined,
    () => {
      providerCalls += 1;
      return streamOf(message([{ type: "toolCall", id: "call", name: tool.name, arguments: {} }], "toolUse"));
    },
  );
  for await (const _event of loop) {}
  assert.equal(providerCalls, 1);
});

test("continuation accepts a caller-defined tail and emits no synthetic user event", async () => {
  const custom = { role: "custom", content: "resume marker" } as unknown as AgentMessage;
  const loop = agentLoopContinue(
    { systemPrompt: "", messages: [custom] },
    { model, convertToLlm: () => [] },
    undefined,
    () => streamOf(message([{ type: "text", text: "continued" }])),
  );
  const events: string[] = [];
  for await (const event of loop) events.push(event.type);
  assert.deepEqual(events, ["agent_start", "turn_start", "message_start", "message_end", "turn_end", "agent_end"]);
});
