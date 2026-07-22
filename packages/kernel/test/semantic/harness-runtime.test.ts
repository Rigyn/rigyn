import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import {
  AgentHarness,
  InMemorySessionRepo,
  createAssistantEventStream,
  type AgentMessage,
  type AgentTool,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Models,
  type SimpleStreamOptions,
} from "../../src/index.js";
import { NodeExecutionEnv } from "../../src/node.js";

const firstModel: Model = {
  id: "first-model",
  name: "First Model",
  api: "harness",
  provider: "harness",
  baseUrl: "http://localhost.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

const secondModel: Model = { ...firstModel, id: "second-model", name: "Second Model" };

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
  model = firstModel,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
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
  queueMicrotask(() => stream.push(
    value.stopReason === "error" || value.stopReason === "aborted"
      ? { type: "error", reason: value.stopReason, error: value }
      : { type: "done", reason: value.stopReason, message: value },
  ));
  return stream;
}

function queuedModels(
  handlers: Array<(context: Context, options?: SimpleStreamOptions, model?: Model) => AssistantMessageEventStream>,
): Models {
  return {
    streamSimple(model, context, options) {
      const handler = handlers.shift();
      if (!handler) throw new Error("Unexpected provider request");
      return handler(context, options, model);
    },
    async completeSimple() {
      return assistant([{ type: "text", text: "summary" }]);
    },
  };
}

async function createHarness(models: Models, options: {
  tools?: AgentTool[];
  model?: Model;
  thinkingLevel?: "off" | "high";
  systemPrompt?: string | (() => string);
} = {}) {
  const repo = new InMemorySessionRepo();
  const session = await repo.create();
  const harness = new AgentHarness({
    env: new NodeExecutionEnv({ cwd: process.cwd() }),
    session,
    models,
    model: options.model ?? firstModel,
    tools: options.tools,
    thinkingLevel: options.thinkingLevel,
    systemPrompt: options.systemPrompt,
  });
  return { harness, session };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("hook failures settle as durable assistant errors and leave the harness reusable", async () => {
  const models = queuedModels([
    () => streamOf(assistant([{ type: "text", text: "unused" }])),
    () => streamOf(assistant([{ type: "text", text: "recovered" }])),
  ]);
  const { harness, session } = await createHarness(models);
  let fail = true;
  harness.on("context", () => {
    if (fail) throw new Error("context hook failed");
    return { messages: [] };
  });

  const failed = await harness.prompt("first");
  fail = false;
  const recovered = await harness.prompt("second");

  assert.equal(failed.stopReason, "error");
  assert.equal(failed.errorMessage, "context hook failed");
  assert.equal(recovered.stopReason, "stop");
  const persisted = (await session.getEntries()).filter((entry) => entry.type === "message");
  assert.deepEqual(persisted.map((entry) => entry.type === "message" ? entry.message.role : ""), [
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
});

test("listener writes are committed after the assistant message at the save point", async () => {
  const { harness, session } = await createHarness(queuedModels([
    () => streamOf(assistant([{ type: "text", text: "done" }])),
  ]));
  let appended = false;
  harness.subscribe(async (event) => {
    if (event.type !== "message_end" || event.message.role !== "assistant" || appended) return;
    appended = true;
    await harness.appendMessage({
      role: "custom",
      customType: "listener-note",
      content: "after assistant",
      display: true,
      timestamp: Date.now(),
    } as AgentMessage);
  });

  await harness.prompt("work");

  const roles = (await session.getEntries()).flatMap((entry) => entry.type === "message" ? [entry.message.role] : []);
  assert.deepEqual(roles, ["user", "assistant", "custom"]);
});

test("save points refresh model, reasoning, prompt, and active tools together", async () => {
  const schema = Type.Object({});
  const firstTool: AgentTool<typeof schema> = {
    name: "first_tool",
    label: "First Tool",
    description: "First tool",
    parameters: schema,
    async execute() { return { content: [], details: {} }; },
  };
  const secondTool: AgentTool<typeof schema> = {
    name: "second_tool",
    label: "Second Tool",
    description: "Second tool",
    parameters: schema,
    async execute() { return { content: [], details: {} }; },
  };
  const requests: Array<{ model: string; prompt: string; tools: string[]; reasoning: unknown }> = [];
  const models = queuedModels([
    (context, options, activeModel) => {
      requests.push({
        model: activeModel?.id ?? "",
        prompt: context.systemPrompt ?? "",
        tools: context.tools?.map((tool) => tool.name) ?? [],
        reasoning: options?.reasoning,
      });
      return streamOf(assistant([{ type: "toolCall", id: "call", name: firstTool.name, arguments: {} }], "toolUse"));
    },
    (context, options, activeModel) => {
      requests.push({
        model: activeModel?.id ?? "",
        prompt: context.systemPrompt ?? "",
        tools: context.tools?.map((tool) => tool.name) ?? [],
        reasoning: options?.reasoning,
      });
      return streamOf(assistant([{ type: "text", text: "done" }], "stop", secondModel));
    },
  ]);
  let currentPrompt = "first prompt";
  const { harness } = await createHarness(models, { tools: [firstTool], systemPrompt: () => currentPrompt });
  harness.subscribe(async (event) => {
    if (event.type !== "tool_execution_start") return;
    currentPrompt = "second prompt";
    await harness.setModel(secondModel);
    await harness.setThinkingLevel("high");
    await harness.setTools([firstTool, secondTool], [secondTool.name]);
  });

  await harness.prompt("work");

  assert.deepEqual(requests, [
    { model: firstModel.id, prompt: "first prompt", tools: [firstTool.name], reasoning: undefined },
    { model: secondModel.id, prompt: "second prompt", tools: [secondTool.name], reasoning: "high" },
  ]);
});

test("abort clears live queues, preserves the next-turn queue, and waits for settlement", async () => {
  const entered = deferred();
  const release = deferred();
  const secondRequestUsers: string[] = [];
  const models = queuedModels([
    (_context, options) => {
      const stream = createAssistantEventStream();
      entered.resolve();
      void release.promise.then(() => stream.push({
        type: options?.signal?.aborted ? "error" : "done",
        reason: options?.signal?.aborted ? "aborted" : "stop",
        ...(options?.signal?.aborted
          ? { error: assistant([], "aborted") }
          : { message: assistant([{ type: "text", text: "done" }]) }),
      }));
      return stream;
    },
    (context) => {
      secondRequestUsers.push(...context.messages.flatMap((item) => {
        if (item.role !== "user") return [];
        if (typeof item.content === "string") return [item.content];
        return item.content.flatMap((part) => part.type === "text" ? [part.text] : []);
      }));
      return streamOf(assistant([{ type: "text", text: "second" }]));
    },
  ]);
  const { harness } = await createHarness(models);
  const firstRun = harness.prompt("first");
  await entered.promise;
  await harness.steer("steer");
  await harness.followUp("follow");
  await harness.nextTurn("next");
  const aborting = harness.abort();
  release.resolve();
  const result = await aborting;
  await firstRun;
  await harness.prompt("second");

  assert.equal(result.clearedSteer.length, 1);
  assert.equal(result.clearedFollowUp.length, 1);
  assert.deepEqual(secondRequestUsers, ["first", "next", "second"]);
});
