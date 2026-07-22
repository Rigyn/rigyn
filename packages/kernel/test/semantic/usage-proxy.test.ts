import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import {
  Session,
  InMemorySessionStorage,
  agentLoop,
  compact,
  createAssistantEventStream,
  generateSummary,
  generateSummaryWithUsage,
  streamProxy,
  type AgentMessage,
  type AgentTool,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Models,
  type StreamFn,
  type Usage,
} from "../../src/index.js";

const model: Model = {
  id: "semantic-model",
  name: "Semantic Model",
  api: "semantic",
  provider: "semantic",
  baseUrl: "http://localhost.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, extras: Pick<Usage, "cacheWrite1h" | "reasoning"> = {}): Usage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...extras,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
  };
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop", messageUsage = usage(1, 1)): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: messageUsage, stopReason, timestamp: Date.now() };
}

function streamOf(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantEventStream();
  queueMicrotask(() => stream.push(message.stopReason === "error" || message.stopReason === "aborted"
    ? { type: "error", reason: message.stopReason, error: message }
    : { type: "done", reason: message.stopReason, message }));
  return stream;
}

const convert = (messages: AgentMessage[]) => messages.filter((message): message is Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }> => message.role === "user" || message.role === "assistant" || message.role === "toolResult");

test("tool usage reaches hooks and the persisted tool result", async () => {
  const original = usage(1, 2, 3, 4);
  const patched = usage(5, 6, 7, 8);
  let observed: Usage | undefined;
  const schema = Type.Object({ value: Type.String() });
  const tool: AgentTool<typeof schema> = {
    name: "echo",
    label: "Echo",
    description: "Echo a value",
    parameters: schema,
    async execute(_id, args) {
      return { content: [{ type: "text", text: args.value }], details: {}, usage: original };
    },
  };
  const stream = agentLoop(
    [{ role: "user", content: "run", timestamp: 1 }],
    { systemPrompt: "", messages: [], tools: [tool] },
    {
      model,
      convertToLlm: convert,
      afterToolCall: async ({ result }) => {
        observed = result.usage;
        return { usage: patched, terminate: true };
      },
    },
    undefined,
    () => streamOf(assistant([{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "ok" } }], "toolUse")),
  );
  for await (const _event of stream) {}
  const toolResult = (await stream.result()).find((message) => message.role === "toolResult");
  assert.deepEqual(observed, original);
  assert.equal(toolResult?.role, "toolResult");
  if (toolResult?.role === "toolResult") assert.deepEqual(toolResult.usage, patched);
});

test("summary APIs preserve usage and split compaction combines it", async () => {
  const first = usage(1, 2, 3, 4, { cacheWrite1h: 5, reasoning: 6 });
  const second = usage(7, 8, 9, 10, { cacheWrite1h: 11, reasoning: 12 });
  const responses = [assistant([{ type: "text", text: "first summary" }], "stop", first), assistant([{ type: "text", text: "prefix summary" }], "stop", second)];
  const models: Models = {
    streamSimple: () => { throw new Error("Unexpected stream request"); },
    async completeSimple() {
      const response = responses.shift();
      if (!response) throw new Error("No summary response queued");
      return response;
    },
  };
  const message: AgentMessage = { role: "user", content: "summarize", timestamp: 1 };
  const generated = await generateSummaryWithUsage([message], models, model, 2_000);
  assert.equal(generated.ok && generated.value.text, "first summary");
  if (generated.ok) assert.deepEqual(generated.value.usage, first);

  const legacyModels: Models = { ...models, completeSimple: async () => assistant([{ type: "text", text: "legacy" }]) };
  const legacy = await generateSummary([message], legacyModels, model, 2_000);
  assert.deepEqual(legacy, { ok: true, value: "legacy" });

  const split = await compact({
    firstKeptEntryId: "kept",
    messagesToSummarize: [message],
    turnPrefixMessages: [message],
    isSplitTurn: true,
    tokensBefore: 100,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 20 },
  }, {
    ...models,
    completeSimple: (() => {
      const queue = [assistant([{ type: "text", text: "history" }], "stop", first), assistant([{ type: "text", text: "prefix" }], "stop", second)];
      return async () => queue.shift()!;
    })(),
  }, model);
  assert.equal(split.ok, true);
  if (split.ok) {
    assert.deepEqual(split.value.usage, {
      input: 8,
      output: 10,
      cacheRead: 12,
      cacheWrite: 14,
      cacheWrite1h: 16,
      reasoning: 18,
      totalTokens: 44,
      cost: { input: 8, output: 10, cacheRead: 12, cacheWrite: 14, total: 44 },
    });
  }
});

test("sessions persist generated-operation usage metadata", async () => {
  const session = new Session(new InMemorySessionStorage());
  const root = await session.appendMessage({ role: "user", content: "root", timestamp: 1 });
  const compactUsage = usage(1, 2, 3, 4);
  const compactId = await session.appendCompaction("summary", root, 10, undefined, false, compactUsage);
  assert.deepEqual((await session.getEntry(compactId))?.type === "compaction" ? (await session.getEntry(compactId) as { usage?: Usage }).usage : undefined, compactUsage);
  const branchUsage = usage(5, 6, 7, 8);
  const branchId = await session.moveTo(root, { summary: "branch", usage: branchUsage });
  assert.ok(branchId);
  const branch = await session.getEntry(branchId!);
  assert.deepEqual(branch?.type === "branch_summary" ? branch.usage : undefined, branchUsage);
});

test("proxy reconstructs streamed tool arguments and sends only serializable options", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requestBody: Record<string, unknown> | undefined;
  const events = [
    { type: "start" },
    { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "read" },
    { type: "toolcall_delta", contentIndex: 0, delta: "{\"path\":\"ab" },
    { type: "toolcall_delta", contentIndex: 0, delta: "c\"}" },
    { type: "toolcall_end", contentIndex: 0 },
    { type: "done", reason: "toolUse", usage: usage(2, 3) },
  ];
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n`).join("");
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const encoder = new TextEncoder();
    const midpoint = Math.floor(payload.length / 2);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload.slice(0, midpoint)));
        controller.enqueue(encoder.encode(payload.slice(midpoint)));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  };

  const proxy = streamProxy(model, { systemPrompt: "system", messages: [] }, {
    authToken: "secret-token",
    proxyUrl: "https://proxy.invalid",
    sessionId: "session-1",
    reasoning: "high",
  });
  const snapshots: Array<Record<string, unknown>> = [];
  for await (const event of proxy) {
    if (event.type === "toolcall_delta") snapshots.push(structuredClone(event.partial.content[0] as ToolCallSnapshot));
  }
  const result = await proxy.result();
  assert.deepEqual(snapshots.map((snapshot) => snapshot.arguments), [{ path: "ab" }, { path: "abc" }]);
  assert.deepEqual(result.content[0]?.type === "toolCall" ? result.content[0].arguments : undefined, { path: "abc" });
  const options = requestBody?.options as Record<string, unknown>;
  assert.deepEqual(options, { reasoning: "high", sessionId: "session-1" });
  assert.equal("authToken" in options, false);
  assert.equal("proxyUrl" in options, false);
  assert.equal("signal" in options, false);
});

type ToolCallSnapshot = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

test("proxy converts an early EOF into a terminal error", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("data: {\"type\":\"start\"}\n", { status: 200 });
  const proxy = streamProxy(model, { systemPrompt: "", messages: [] }, { authToken: "token", proxyUrl: "https://proxy.invalid" });
  const seen: string[] = [];
  for await (const event of proxy) seen.push(event.type);
  const result = await proxy.result();
  assert.deepEqual(seen, ["start", "error"]);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /terminal event/);
});

test("proxy terminal events round-trip provider metadata without inspecting opaque state", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const providerState = {
    source: { api: model.api, provider: model.provider, model: model.id },
    value: { outputItems: [{ type: "future_output", opaque: "do-not-render-or-normalize", nested: [1, false, null] }] },
  };
  const diagnostics = [{
    type: "provider_failure", message: "Provider request failed", timestamp: 123,
    details: { category: "overloaded", retryable: true, partial: false, requestId: "req_123" },
  }];
  const terminal = {
    responseId: "response_123", responseModel: "provider-model-2026", diagnostics, providerState,
  };
  let mode: "done" | "error" = "done";
  globalThis.fetch = async () => {
    const event = mode === "done"
      ? { type: "done", reason: "stop", usage: usage(2, 3), ...terminal }
      : { type: "error", reason: "error", errorMessage: "capacity unavailable", usage: usage(4, 5), ...terminal };
    return new Response(`data: ${JSON.stringify({ type: "start" })}\ndata: ${JSON.stringify(event)}\n`, { status: 200 });
  };

  const done = await streamProxy(model, { messages: [] }, { authToken: "token", proxyUrl: "https://proxy.invalid" }).result();
  assert.deepEqual({ responseId: done.responseId, responseModel: done.responseModel, diagnostics: done.diagnostics, providerState: done.providerState }, terminal);

  mode = "error";
  const failed = await streamProxy(model, { messages: [] }, { authToken: "token", proxyUrl: "https://proxy.invalid" }).result();
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.errorMessage, "capacity unavailable");
  assert.deepEqual({ responseId: failed.responseId, responseModel: failed.responseModel, diagnostics: failed.diagnostics, providerState: failed.providerState }, terminal);
});

test("proxy forwards only continuation state from the exact model boundary", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const matching = {
    source: { api: model.api, provider: model.provider, model: model.id },
    value: { exact: "matching-opaque-state" },
  };
  const mismatched = {
    source: { api: model.api, provider: model.provider, model: "other-model" },
    value: { exact: "mismatched-opaque-state" },
  };
  const first = { ...assistant([{ type: "text", text: "first" }]), providerState: matching };
  const second = { ...assistant([{ type: "text", text: "second" }]), providerState: mismatched };
  let requestBody: { context?: { messages?: AssistantMessage[] } } | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
    return new Response(`data: ${JSON.stringify({ type: "done", reason: "stop", usage: usage(1, 1) })}\n`, { status: 200 });
  };

  await streamProxy(model, { messages: [first, second] }, { authToken: "token", proxyUrl: "https://proxy.invalid" }).result();
  assert.deepEqual(requestBody?.context?.messages?.[0]?.providerState, matching);
  assert.equal(requestBody?.context?.messages?.[1]?.providerState, undefined);
  assert.equal(requestBody?.context?.messages?.[1]?.content[0]?.type === "text" ? requestBody.context.messages[1].content[0].text : undefined, "second");
});

const _streamContract: StreamFn = () => streamOf(assistant([{ type: "text", text: "ok" }]));
void _streamContract;
