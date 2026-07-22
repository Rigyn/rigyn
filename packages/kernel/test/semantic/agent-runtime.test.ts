import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import {
  Agent,
  createAssistantEventStream,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from "../../src/index.js";

const model: Model = {
  id: "runtime-model",
  name: "Runtime Model",
  api: "runtime",
  provider: "runtime",
  baseUrl: "http://localhost.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

function assistant(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
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

function streamOf(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantEventStream();
  queueMicrotask(() => stream.push(
    message.stopReason === "error" || message.stopReason === "aborted"
      ? { type: "error", reason: message.stopReason, error: message }
      : { type: "done", reason: message.stopReason, message },
  ));
  return stream;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function user(text: string, timestamp = Date.now()): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

test("provider exceptions still produce a complete observable lifecycle", async () => {
  const agent = new Agent({
    initialState: { model },
    streamFunction: () => { throw new Error("provider unavailable"); },
  });
  const events: string[] = [];
  agent.subscribe((event) => { events.push(event.type); });

  await agent.prompt("hello");

  assert.deepEqual(events, [
    "agent_start",
    "turn_start",
    "message_start",
    "message_end",
    "message_start",
    "message_end",
    "turn_end",
    "agent_end",
  ]);
  const final = agent.state.messages.at(-1);
  assert.equal(final?.role, "assistant");
  if (final?.role === "assistant") {
    assert.equal(final.stopReason, "error");
    assert.equal(final.errorMessage, "provider unavailable");
  }
  assert.equal(agent.state.errorMessage, "provider unavailable");
});

test("prompt and waitForIdle both wait for asynchronous subscribers", async () => {
  const gate = deferred();
  const agent = new Agent({
    initialState: { model },
    streamFunction: () => streamOf(assistant("done")),
  });
  agent.subscribe(async (event) => {
    if (event.type === "agent_end") await gate.promise;
  });

  let promptSettled = false;
  let idleSettled = false;
  const prompt = agent.prompt("work").then(() => { promptSettled = true; });
  const idle = agent.waitForIdle().then(() => { idleSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(promptSettled, false);
  assert.equal(idleSettled, false);
  assert.equal(agent.state.isStreaming, true);
  gate.resolve();
  await Promise.all([prompt, idle]);
  assert.equal(agent.state.isStreaming, false);
});

test("subscribers share the active signal and abort terminates the run", async () => {
  let observed: AbortSignal | undefined;
  const agent = new Agent({
    initialState: { model },
    streamFunction: (_model, _context, options) => {
      const stream = createAssistantEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: assistant("") });
        options?.signal?.addEventListener("abort", () => {
          stream.push({ type: "error", reason: "aborted", error: assistant("", "aborted") });
        }, { once: true });
      });
      return stream;
    },
  });
  agent.subscribe((event, signal) => {
    if (event.type === "agent_start") observed = signal;
  });

  const run = agent.prompt("wait");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(observed?.aborted, false);
  agent.abort();
  await run;
  assert.equal(observed?.aborted, true);
  const final = agent.state.messages.at(-1);
  assert.equal(final?.role === "assistant" ? final.stopReason : undefined, "aborted");
});

test("tool updates are ignored after that tool has settled", async () => {
  const schema = Type.Object({});
  let update: ((result: { content: Array<{ type: "text"; text: string }>; details: { stage: string } }) => void) | undefined;
  const tool: AgentTool<typeof schema, { stage: string }> = {
    name: "progress",
    label: "Progress",
    description: "Reports progress",
    parameters: schema,
    async execute(_id, _args, _signal, onUpdate) {
      update = onUpdate;
      onUpdate?.({ content: [{ type: "text", text: "working" }], details: { stage: "working" } });
      return { content: [{ type: "text", text: "done" }], details: { stage: "done" }, terminate: true };
    },
  };
  const toolUse = {
    ...assistant("", "toolUse"),
    content: [{ type: "toolCall" as const, id: "call-1", name: tool.name, arguments: {} }],
  };
  const agent = new Agent({
    initialState: { model, tools: [tool] },
    streamFunction: () => streamOf(toolUse),
  });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => { events.push(event); });

  await agent.prompt("run");
  const settledCount = events.length;
  update?.({ content: [{ type: "text", text: "late" }], details: { stage: "late" } });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(events.length, settledCount);
  assert.equal(events.filter((event) => event.type === "tool_execution_update").length, 1);
});

test("busy calls fail without disturbing the active run", async () => {
  const gate = deferred();
  const agent = new Agent({
    initialState: { model },
    streamFunction: () => {
      const stream = createAssistantEventStream();
      void gate.promise.then(() => stream.push({ type: "done", reason: "stop", message: assistant("done") }));
      return stream;
    },
  });
  const active = agent.prompt("first");
  await new Promise((resolve) => setTimeout(resolve, 0));

  await assert.rejects(agent.prompt("second"), /already processing a prompt/i);
  await assert.rejects(agent.continue(), /already processing/i);
  assert.equal(agent.state.isStreaming, true);
  gate.resolve();
  await active;
});

test("continue consumes queued steering and follow-up messages from an assistant tail", async () => {
  let requests = 0;
  const agent = new Agent({
    initialState: {
      model,
      messages: [user("initial", 1), assistant("initial response")],
    },
    streamFunction: () => streamOf(assistant(`response ${++requests}`)),
  });
  agent.steer(user("steer one", 2));
  agent.steer(user("steer two", 3));

  await agent.continue();
  assert.equal(requests, 2);
  assert.deepEqual(agent.state.messages.slice(-4).map((message) => message.role), ["user", "assistant", "user", "assistant"]);

  agent.followUp(user("follow-up", 4));
  await agent.continue();
  assert.equal(requests, 3);
  assert.equal(agent.state.messages.at(-2)?.role, "user");
  assert.equal(agent.state.messages.at(-1)?.role, "assistant");
});

test("the current session identifier is forwarded on every provider request", async () => {
  const seen: Array<string | undefined> = [];
  const agent = new Agent({
    initialState: { model },
    sessionId: "session-a",
    streamFunction: (_model, _context, options) => {
      seen.push(options?.sessionId);
      return streamOf(assistant("ok"));
    },
  });

  await agent.prompt("one");
  agent.sessionId = "session-b";
  await agent.prompt("two");
  assert.deepEqual(seen, ["session-a", "session-b"]);
});
