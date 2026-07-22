import assert from "node:assert/strict";
import test from "node:test";

import {
  Agent,
  agentLoop,
  createAssistantEventStream,
  setDefaultStreamFn,
  type AgentMessage,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type StreamFn,
} from "../../src/index.js";

const model: Model = {
  id: "stream-fn-model",
  name: "Stream Function Model",
  api: "stream-fn",
  provider: "stream-fn",
  baseUrl: "http://localhost.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "stop",
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
  queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
  return stream;
}

test("Agent accepts streamFn and preserves legacy streamFunction compatibility", async () => {
  const calls: string[] = [];
  const canonical: StreamFn = () => {
    calls.push("canonical");
    return streamOf(assistant("canonical"));
  };
  const legacy: StreamFn = () => {
    calls.push("legacy");
    return streamOf(assistant("legacy"));
  };

  const canonicalAgent = new Agent({ initialState: { model }, streamFn: canonical });
  await canonicalAgent.prompt("canonical");

  const legacyAgent = new Agent({ initialState: { model }, streamFunction: legacy });
  await legacyAgent.prompt("legacy");

  const bothAgent = new Agent({ initialState: { model }, streamFn: canonical, streamFunction: legacy });
  await bothAgent.prompt("precedence");

  assert.deepEqual(calls, ["canonical", "legacy", "canonical"]);
});

test("the configured default supports Agent and low-level loop runtime omissions", async () => {
  const requests: string[] = [];
  const fallback: StreamFn = (_activeModel, context) => {
    const prompt = context.messages.at(-1);
    const content = prompt?.role === "user" ? prompt.content : undefined;
    requests.push(
      typeof content === "string"
        ? content
        : content?.find((part) => part.type === "text")?.text ?? "unknown",
    );
    return streamOf(assistant("fallback"));
  };
  setDefaultStreamFn(fallback);

  try {
    const agent = Reflect.construct(Agent, [{ initialState: { model } }]) as Agent;
    await agent.prompt("agent");

    const prompt: AgentMessage = { role: "user", content: "loop", timestamp: 1 };
    const loop = Reflect.apply(agentLoop, undefined, [
      [prompt],
      { systemPrompt: "", messages: [] },
      {
        model,
        convertToLlm: (messages: AgentMessage[]) => messages.filter(
          (message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
        ),
      },
      undefined,
    ]) as ReturnType<typeof agentLoop>;
    for await (const _event of loop) {}

    assert.deepEqual(requests, ["agent", "loop"]);
  } finally {
    setDefaultStreamFn(undefined);
  }
});

test("runtime omission fails clearly when no default is configured", () => {
  setDefaultStreamFn(undefined);
  assert.throws(
    () => Reflect.construct(Agent, [{}]),
    /No default stream function configured/,
  );
});
