import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  createAssistantEventStream,
  streamProxy,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type StreamFn,
  type Usage,
} from "../../src/index.js";
import { ASSISTANT_CONTENT_LIMITS } from "../../src/runtime/core/assistant-content-limits.js";
import {
  MAX_TOOL_CALL_STREAM_ID_BYTES,
  MAX_TOOL_CALL_STREAM_NAME_BYTES,
} from "../../src/runtime/core/events.js";

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
  const reason = message.stopReason;
  if (reason === "pending") throw new Error("stream fixture requires a terminal message");
  queueMicrotask(() => stream.push(reason === "error" || reason === "aborted"
    ? { type: "error", reason, error: message }
    : { type: "done", reason, message }));
  return stream;
}

test("proxy reconstructs streamed tool arguments and sends only serializable options", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requestBody: Record<string, unknown> | undefined;
  let requestUrl: string | undefined;
  let requestRedirect: RequestRedirect | undefined;
  const events = [
    { type: "start" },
    { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "read" },
    { type: "toolcall_delta", contentIndex: 0, delta: "{\"path\":\"ab" },
    { type: "toolcall_delta", contentIndex: 0, delta: "c\"}" },
    { type: "toolcall_end", contentIndex: 0 },
    { type: "done", reason: "toolUse", usage: usage(2, 3) },
  ];
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n`).join("");
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestRedirect = init?.redirect;
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
  assert.equal(requestUrl, "https://proxy.invalid/api/stream");
  assert.equal(requestRedirect, "error");
});

type ToolCallSnapshot = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

test("proxy rejects insecure remote and credential-bearing URLs before fetch", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("fetch must not run");
  };

  const shortToken = await streamProxy(model, { messages: [] }, {
    authToken: "a",
    proxyUrl: "https://proxy.invalid",
  }).result();
  assert.equal(shortToken.stopReason, "error");
  assert.match(shortToken.errorMessage ?? "", /at least 4 characters/u);

  const insecure = await streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "http://proxy.invalid",
  }).result();
  assert.equal(insecure.stopReason, "error");
  assert.equal(insecure.model, model.id);
  assert.equal(insecure.api, model.api);
  assert.equal(insecure.provider, model.provider);
  assert.match(insecure.errorMessage ?? "", /must use HTTPS/u);

  const credentials = await streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://user:password@proxy.invalid",
  }).result();
  assert.equal(credentials.stopReason, "error");
  assert.match(credentials.errorMessage ?? "", /must not contain credentials/u);
  assert.equal(calls, 0);
});

test("proxy permits explicit loopback HTTP without following redirects", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requestUrl: string | undefined;
  let requestRedirect: RequestRedirect | undefined;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestRedirect = init?.redirect;
    return new Response(`data: ${JSON.stringify({ type: "done", reason: "stop", usage: usage(1, 1) })}\n`, {
      status: 200,
    });
  };

  const result = await streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "http://127.0.0.1:8080/base/",
  }).result();
  assert.equal(result.stopReason, "stop");
  assert.equal(requestUrl, "http://127.0.0.1:8080/base/api/stream");
  assert.equal(requestRedirect, "error");
});

test("proxy preserves omitted cache telemetry", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({
    type: "done",
    reason: "stop",
    usage: {
      input: 2,
      output: 1,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  })}\n`, { status: 200 });

  const result = await streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  }).result();
  assert.equal(result.stopReason, "stop");
  assert.equal(Object.hasOwn(result.usage, "cacheRead"), false);
  assert.equal(Object.hasOwn(result.usage, "cacheWrite"), false);
});

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

test("proxy terminal events round-trip bounded opaque provider metadata", async (t) => {
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

async function proxyResultForEvents(
  t: TestContext,
  events: readonly Record<string, unknown>[],
): Promise<AssistantMessage> {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n`).join("");
  globalThis.fetch = async () => new Response(payload, { status: 200 });
  return streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  }).result();
}

async function proxyCollectedResultForEvents(
  t: TestContext,
  events: readonly Record<string, unknown>[],
): Promise<AssistantMessage> {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n`).join("");
  globalThis.fetch = async () => new Response(payload, { status: 200 });
  const proxy = streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  });
  const draining = (async () => {
    for await (const _event of proxy) { /* drain concurrently */ }
  })();
  const result = await proxy.result();
  await draining;
  return result;
}

test("proxy rejects sparse content indices and invalid text lifecycles", async (t) => {
  const invalidStreams = [
    [
      { type: "text_start", contentIndex: ASSISTANT_CONTENT_LIMITS.blocks },
      { type: "done", reason: "stop", usage: usage(1, 1) },
    ],
    [
      { type: "text_start", contentIndex: 0 },
      { type: "text_start", contentIndex: 0 },
      { type: "done", reason: "stop", usage: usage(1, 1) },
    ],
    [
      { type: "text_start", contentIndex: 0 },
      { type: "text_end", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "late" },
      { type: "done", reason: "stop", usage: usage(1, 1) },
    ],
  ] as const;

  for (const events of invalidStreams) {
    const result = await proxyResultForEvents(t, events);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /content index|text_start|text_end/u);
  }
});

test("proxy enforces per-field, aggregate-content, and tool-call cardinality bounds", async (t) => {
  const oversizedField = "x".repeat(ASSISTANT_CONTENT_LIMITS.fieldBytes + 1);
  const fieldResult = await proxyResultForEvents(t, [
    { type: "text_start", contentIndex: 0 },
    { type: "text_delta", contentIndex: 0, delta: oversizedField },
    { type: "done", reason: "stop", usage: usage(1, 1) },
  ]);
  assert.equal(fieldResult.stopReason, "error");
  assert.match(fieldResult.errorMessage ?? "", /text.*byte|field.*byte/u);

  const exactField = "x".repeat(ASSISTANT_CONTENT_LIMITS.fieldBytes);
  const exactAggregate = await proxyCollectedResultForEvents(t, [
    { type: "text_start", contentIndex: 0 },
    { type: "text_delta", contentIndex: 0, delta: exactField },
    { type: "text_start", contentIndex: 1 },
    { type: "text_delta", contentIndex: 1, delta: exactField },
    { type: "done", reason: "stop", usage: usage(1, 1) },
  ]);
  assert.equal(exactAggregate.stopReason, "stop");
  assert.equal(exactAggregate.content.length, 2);

  const aggregateResult = await proxyCollectedResultForEvents(t, [
    { type: "text_start", contentIndex: 0 },
    { type: "text_delta", contentIndex: 0, delta: exactField },
    { type: "text_start", contentIndex: 1 },
    { type: "text_delta", contentIndex: 1, delta: exactField },
    { type: "text_start", contentIndex: 2 },
    { type: "text_delta", contentIndex: 2, delta: "x" },
    { type: "done", reason: "stop", usage: usage(1, 1) },
  ]);
  assert.equal(aggregateResult.stopReason, "error");
  assert.match(aggregateResult.errorMessage ?? "", /aggregate.*byte/u);

  const toolResult = await proxyResultForEvents(t, [
    ...Array.from({ length: 257 }, (_, contentIndex) => ({
      type: "toolcall_start",
      contentIndex,
      id: `call-${contentIndex}`,
      toolName: "read",
    })),
    { type: "done", reason: "toolUse", usage: usage(1, 1) },
  ]);
  assert.equal(toolResult.stopReason, "error");
  assert.match(toolResult.errorMessage ?? "", /256.*tool/u);

  const exactBlocks = await proxyCollectedResultForEvents(t, [
    ...Array.from({ length: ASSISTANT_CONTENT_LIMITS.blocks }, (_, contentIndex) => ({
      type: "text_start",
      contentIndex,
    })),
    { type: "done", reason: "stop", usage: usage(1, 1) },
  ]);
  assert.equal(exactBlocks.stopReason, "stop");
  assert.equal(exactBlocks.content.length, ASSISTANT_CONTENT_LIMITS.blocks);

  const exactTools = await proxyResultForEvents(t, [
    ...Array.from({ length: 256 }, (_, contentIndex) => [
      { type: "toolcall_start", contentIndex, id: `exact-${contentIndex}`, toolName: "read" },
      { type: "toolcall_end", contentIndex },
    ]).flat(),
    { type: "done", reason: "toolUse", usage: usage(1, 1) },
  ]);
  assert.equal(exactTools.stopReason, "toolUse");
  assert.equal(exactTools.content.length, 256);
});

test("proxy rejects malformed terminal usage instead of returning an invalid assistant message", async (t) => {
  for (const invalidUsage of [
    {
      input: -1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    { ...usage(1, 1), totalTokens: 3 },
    { ...usage(1, 1), cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 3 } },
    { ...usage(1, 1, 0, 1), cacheWrite1h: 2 },
    { ...usage(1, 1), input: 1.5, totalTokens: 2.5 },
    { ...usage(1, 1), input: Number.MAX_SAFE_INTEGER + 1 },
    { ...usage(1, 1), reasoning: 0.5 },
    { ...usage(1, 1, 0, 1), cacheWrite1h: 0.5 },
    {
      input: Number.MAX_SAFE_INTEGER,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
    },
    { input: 800, output: 100, cacheRead: 200, totalTokens: 5 },
    { input: 1, totalTokens: 1, unexpected: { blob: "must not survive" } },
    { input: 1, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, extra: "must not survive" } },
  ]) {
    const result = await proxyResultForEvents(t, [{
      type: "done",
      reason: "stop",
      usage: invalidUsage,
    }]);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /usage/u);
  }
});

test("proxy preserves unavailable, partial, and explicit-zero usage distinctly", async (t) => {
  const unavailable = await proxyResultForEvents(t, [{ type: "done", reason: "stop", usage: {} }]);
  assert.deepEqual(unavailable.usage, {});

  const partial = await proxyResultForEvents(t, [{
    type: "done",
    reason: "stop",
    usage: { input: 10, output: 2, totalTokens: 12 },
  }]);
  assert.deepEqual(partial.usage, { input: 10, output: 2, totalTokens: 12 });

  const zero = await proxyResultForEvents(t, [{
    type: "done",
    reason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }]);
  assert.deepEqual(zero.usage, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("proxy accepts canonical floating-point usage cost totals", async (t) => {
  const result = await proxyResultForEvents(t, [{
    type: "done",
    reason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
    },
  }]);
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.usage.cost, {
    input: 0.1,
    output: 0.2,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0.30000000000000004,
  });
});

test("proxy rejects duplicate endings, active tools, and events after terminal markers", async (t) => {
  for (const [events, pattern] of [
    [[
      { type: "text_start", contentIndex: 0 },
      { type: "text_end", contentIndex: 0 },
      { type: "text_end", contentIndex: 0 },
    ], /text_end.*already/u],
    [[
      { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "read" },
      { type: "done", reason: "toolUse", usage: usage(1, 1) },
    ], /active tool/u],
  ] as const) {
    const result = await proxyResultForEvents(t, events);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", pattern);
  }

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const done = { type: "done", reason: "stop", usage: usage(1, 1) };
  globalThis.fetch = async () => new Response(
    `data: ${JSON.stringify(done)}\ndata: ${JSON.stringify({ type: "text_start", contentIndex: 0 })}\n`,
    { status: 200 },
  );
  const afterTerminal = await streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  }).result();
  assert.equal(afterTerminal.stopReason, "error");
  assert.match(afterTerminal.errorMessage ?? "", /after its terminal/u);

  globalThis.fetch = async () => new Response(
    `data: ${JSON.stringify(done)}\ndata: [DONE]\n`,
    { status: 200 },
  );
  const terminalThenMarker = await streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  }).result();
  assert.equal(terminalThenMarker.stopReason, "stop");

  globalThis.fetch = async () => new Response(
    `data: [DONE]\ndata: ${JSON.stringify(done)}\n`,
    { status: 200 },
  );
  const afterMarker = await streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  }).result();
  assert.equal(afterMarker.stopReason, "error");
  assert.match(afterMarker.errorMessage ?? "", /after its done marker/u);
});

test("proxy preserves valid terminal discriminants and rejects mismatched reasons", async (t) => {
  const aborted = await proxyResultForEvents(t, [{
    type: "error",
    reason: "aborted",
    usage: {},
  }]);
  assert.equal(aborted.stopReason, "aborted");

  for (const event of [
    { type: "done", reason: "error", usage: {} },
    { type: "error", reason: "stop", usage: {} },
    { type: "done", reason: "stop", errorMessage: "not allowed", usage: {} },
    { type: "error", reason: "aborted", errorMessage: "not allowed", usage: {} },
    { type: "done", reason: "stop", usage: {}, unexpected: true },
  ]) {
    const result = await proxyResultForEvents(t, [event]);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /terminal reason|unsupported fields|error message/u);
  }
});

test("proxy closes active scalar content before a terminal event", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response([
    { type: "text_start", contentIndex: 0 },
    { type: "text_delta", contentIndex: 0, delta: "hello" },
    { type: "done", reason: "stop", usage: usage(1, 1) },
  ].map((event) => `data: ${JSON.stringify(event)}\n`).join(""), { status: 200 });
  const proxy = streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  });
  const seen: string[] = [];
  for await (const event of proxy) seen.push(event.type);
  assert.deepEqual(seen, ["text_start", "text_delta", "text_end", "done"]);
  assert.equal((await proxy.result()).stopReason, "stop");
});

test("proxy request snapshots never invoke accessors and enforce the exact 16 MiB body boundary", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let fetchCalls = 0;
  let getterCalls = 0;
  let lastBody = "";
  globalThis.fetch = async (_input, init) => {
    fetchCalls += 1;
    lastBody = String(init?.body);
    return new Response(`data: ${JSON.stringify({ type: "done", reason: "stop", usage: usage(1, 1) })}\n`);
  };

  const hostileContext: Record<string, unknown> = {};
  Object.defineProperty(hostileContext, "messages", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return [];
    },
  });
  const hostileContextResult = await streamProxy(model, hostileContext as never, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  }).result();
  assert.equal(hostileContextResult.stopReason, "error");
  assert.equal(getterCalls, 0);
  assert.equal(fetchCalls, 0);

  const hostileOptions: Record<string, unknown> = { proxyUrl: "https://proxy.invalid" };
  Object.defineProperty(hostileOptions, "authToken", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-run";
    },
  });
  const hostileOptionsResult = await streamProxy(model, { messages: [] }, hostileOptions as never)
    .result();
  assert.equal(hostileOptionsResult.stopReason, "error");
  assert.equal(getterCalls, 0);
  assert.equal(fetchCalls, 0);

  const metadata: Record<string, unknown> = {};
  Object.defineProperty(metadata, "secret", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-run";
    },
  });
  const hostileMetadataResult = await streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
    metadata,
  }).result();
  assert.equal(hostileMetadataResult.stopReason, "error");
  assert.equal(getterCalls, 0);
  assert.equal(fetchCalls, 0);

  const baseline = await streamProxy(model, { systemPrompt: "", messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  }).result();
  assert.equal(baseline.stopReason, "stop");
  const requestLimit = 16 * 1024 * 1024;
  const promptBytes = requestLimit - Buffer.byteLength(lastBody, "utf8");
  assert.ok(promptBytes > 0);

  const exact = await streamProxy(model, { systemPrompt: "x".repeat(promptBytes), messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  }).result();
  assert.equal(exact.stopReason, "stop");
  assert.equal(Buffer.byteLength(lastBody, "utf8"), requestLimit);
  assert.equal(fetchCalls, 2);

  const over = await streamProxy(model, { systemPrompt: "x".repeat(promptBytes + 1), messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  }).result();
  assert.equal(over.stopReason, "error");
  assert.match(over.errorMessage ?? "", /16777216 UTF-8 bytes/u);
  assert.equal(fetchCalls, 2);
});

test("proxy bounds and redacts HTTP errors and rejects invalid response UTF-8", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const secret = "proxy-http-error-secret-value";
  globalThis.fetch = async () => new Response(JSON.stringify({ error: `failed ${secret}` }), { status: 500 });
  const redacted = await streamProxy(model, { messages: [] }, {
    authToken: secret,
    proxyUrl: "https://proxy.invalid",
  }).result();
  assert.equal(redacted.stopReason, "error");
  assert.equal(redacted.errorMessage?.includes(secret), false);
  assert.match(redacted.errorMessage ?? "", /\[REDACTED\]/u);

  globalThis.fetch = async () => new Response(JSON.stringify({ error: "x".repeat((64 * 1024) + 1) }), { status: 500 });
  const oversized = await streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  }).result();
  assert.equal(oversized.errorMessage, "Proxy request failed (500)");

  globalThis.fetch = async () => new Response(new Uint8Array([0xff]), { status: 200 });
  const invalidUtf8 = await streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  }).result();
  assert.equal(invalidUtf8.stopReason, "error");
  assert.match(invalidUtf8.errorMessage ?? "", /invalid UTF-8/u);
});

test("proxy stops reading an HTTP error body after its byte limit", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let pulls = 0;
  let cancellations = 0;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls > 10) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(16 * 1024));
    },
    cancel() {
      cancellations += 1;
    },
  }), { status: 500 });

  const result = await streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  }).result();
  assert.equal(result.errorMessage, "Proxy request failed (500)");
  assert.ok(pulls <= 6, `read ${pulls} chunks`);
  assert.equal(cancellations, 1);
});

test("proxy counts tool-call arguments toward the aggregate content limit", async (t) => {
  const argument = JSON.stringify({ value: "x".repeat(3 * 1024 * 1024) });
  const result = await proxyCollectedResultForEvents(t, [
    ...Array.from({ length: 3 }, (_, contentIndex) => [
      { type: "toolcall_start", contentIndex, id: `call-${contentIndex}`, toolName: "read" },
      { type: "toolcall_delta", contentIndex, delta: argument },
      { type: "toolcall_end", contentIndex },
    ]).flat(),
    { type: "done", reason: "toolUse", usage: usage(1, 1) },
  ]);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /aggregate content byte limit/u);
});

test("proxy rejects tool-call arguments outside canonical JSON complexity", async (t) => {
  const argument = JSON.stringify({ items: Array.from({ length: 9_000 }, () => 0) });
  const result = await proxyCollectedResultForEvents(t, [
    { type: "toolcall_start", contentIndex: 0, id: "call-complex", toolName: "read" },
    { type: "toolcall_delta", contentIndex: 0, delta: argument },
    { type: "toolcall_end", contentIndex: 0 },
    { type: "done", reason: "toolUse", usage: usage(1, 1) },
  ]);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /tool-call arguments.*values/u);
});

test("proxy enforces response chunk, line, and aggregate wire bounds before allocation", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const resultForChunks = async (chunks: readonly object[]) => {
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }) as never, { status: 200 });
    return streamProxy(model, { messages: [] }, {
      authToken: "token",
      proxyUrl: "https://proxy.invalid",
    }).result();
  };

  const oversizedChunk = await resultForChunks([{ byteLength: Number.MAX_SAFE_INTEGER }]);
  assert.match(oversizedChunk.errorMessage ?? "", /chunk exceeds/u);

  const oversizedLineChunk = {
    byteLength: 40 * 1024 * 1024,
    indexOf: () => -1,
    subarray() { return this; },
  };
  const oversizedLine = await resultForChunks([oversizedLineChunk]);
  assert.match(oversizedLine.errorMessage ?? "", /line exceeds/u);

  const aggregateChunk = {
    byteLength: 40 * 1024 * 1024,
    indexOf: () => -1,
    subarray: () => new Uint8Array(),
  };
  const oversizedResponse = await resultForChunks([aggregateChunk, aggregateChunk]);
  assert.match(oversizedResponse.errorMessage ?? "", /response exceeds/u);
});

test("proxy parses a valid SSE line split across one-byte transport chunks", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const text = "x".repeat(128 * 1024);
  const payload = new TextEncoder().encode(`data: ${JSON.stringify({
    type: "text_start",
    contentIndex: 0,
  })}\ndata: ${JSON.stringify({
    type: "text_delta",
    contentIndex: 0,
    delta: text,
  })}\ndata: ${JSON.stringify({
    type: "text_end",
    contentIndex: 0,
  })}\ndata: ${JSON.stringify({
    type: "done",
    reason: "stop",
    usage: {},
  })}\n`);
  let offset = 0;
  globalThis.fetch = async () => ({
    ok: true,
    body: {
      getReader: () => ({
        read: async () => offset >= payload.byteLength
          ? { done: true, value: undefined }
          : { done: false, value: payload.subarray(offset, ++offset) },
        cancel: async () => undefined,
      }),
    },
  }) as Response;

  const proxy = streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  });
  const draining = (async () => {
    for await (const _event of proxy) { /* drain concurrently */ }
  })();
  const result = await proxy.result();
  await draining;
  assert.equal(result.stopReason, "stop");
  assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, text);
});

test("proxy bounds event exhaustion and parses highly fragmented tool JSON without quadratic reparsing", async (t) => {
  const fragmented = [
    { type: "toolcall_start", contentIndex: 0, id: "call-fragmented", toolName: "read" },
    { type: "toolcall_delta", contentIndex: 0, delta: "{\"value\":\"" },
    ...Array.from({ length: 20_000 }, () => ({ type: "toolcall_delta", contentIndex: 0, delta: "x" })),
    { type: "toolcall_delta", contentIndex: 0, delta: "\"}" },
    { type: "toolcall_end", contentIndex: 0 },
    { type: "done", reason: "toolUse", usage: usage(1, 1) },
  ];
  const fragmentedResult = await proxyCollectedResultForEvents(t, fragmented);
  assert.equal(fragmentedResult.stopReason, "toolUse");
  assert.equal(
    fragmentedResult.content[0]?.type === "toolCall"
      ? (fragmentedResult.content[0].arguments as { value?: string }).value?.length
      : undefined,
    20_000,
  );

  const exhausted = await proxyCollectedResultForEvents(t, [
    { type: "text_start", contentIndex: 0 },
    ...Array.from({ length: 65_535 }, () => ({ type: "text_delta", contentIndex: 0, delta: "" })),
    { type: "done", reason: "stop", usage: usage(1, 1) },
  ]);
  assert.equal(exhausted.stopReason, "error");
  assert.match(exhausted.errorMessage ?? "", /65536 events/u);
});

test("cancelling proxy iteration cancels the active response reader", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let cancelled!: () => void;
  const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "start" })}\n`));
    },
    cancel() {
      cancelled();
    },
  }), { status: 200 });

  const proxy = streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  });
  for await (const event of proxy) {
    assert.equal(event.type, "start");
    break;
  }
  await cancellation;
});

test("proxy cooperatively drains one-chunk event bursts without overflowing the consumer queue", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const events = [
    { type: "text_start", contentIndex: 0 },
    ...Array.from({ length: 1_024 }, () => ({ type: "text_delta", contentIndex: 0, delta: "" })),
    { type: "text_end", contentIndex: 0 },
    { type: "done", reason: "stop", usage: usage(1, 1) },
  ];
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n`).join("");
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  }), { status: 200 });

  const proxy = streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  });
  const seen: string[] = [];
  for await (const event of proxy) seen.push(event.type);
  const result = await proxy.result();
  assert.equal(result.stopReason, "stop");
  assert.equal(seen.length, events.length);
  assert.equal(seen.at(0), "text_start");
  assert.equal(seen.at(-1), "done");
});

test("result-only proxy consumers fail closed at the bounded event-retention limit", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const events = [
    { type: "text_start", contentIndex: 0 },
    ...Array.from({ length: 5_000 }, () => ({ type: "text_delta", contentIndex: 0, delta: "" })),
    { type: "text_end", contentIndex: 0 },
    { type: "done", reason: "stop", usage: {} },
  ];
  globalThis.fetch = async () => new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n`).join(""),
    { status: 200 },
  );

  const proxy = streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  });
  const result = await proxy.result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /event buffer.*retention limit/u);
  const eventsSeen: string[] = [];
  for await (const event of proxy) eventsSeen.push(event.type);
  assert.deepEqual(eventsSeen, ["error"]);
});

test("a full proxy queue still resolves to one terminal error", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const events = [
    ...Array.from({ length: 4_096 }, () => ({ type: "start" })),
    { type: "unsupported" },
  ];
  globalThis.fetch = async () => new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n`).join(""),
    { status: 200 },
  );

  const proxy = streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  });
  const result = await proxy.result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /unsupported proxy event type/iu);
  const seen: string[] = [];
  for await (const event of proxy) seen.push(event.type);
  assert.deepEqual(seen, ["error"]);
});

test("calling result before attaching an iterator preserves every bounded proxy event", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const events = [
    { type: "start" },
    { type: "text_start", contentIndex: 0 },
    { type: "text_delta", contentIndex: 0, delta: "hello" },
    { type: "text_end", contentIndex: 0 },
    { type: "done", reason: "stop", usage: {} },
  ];
  globalThis.fetch = async () => new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n`).join(""),
    { status: 200 },
  );

  const proxy = streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  });
  const resultPromise = proxy.result();
  const eventsSeen: string[] = [];
  for await (const event of proxy) eventsSeen.push(event.type);
  const result = await resultPromise;
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(eventsSeen, events.map((event) => event.type));
});

test("cancelling during one-chunk proxy draining stops the burst and cancels the reader", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let cancelled!: () => void;
  const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
  const events = [
    { type: "text_start", contentIndex: 0 },
    ...Array.from({ length: 2_048 }, () => ({ type: "text_delta", contentIndex: 0, delta: "" })),
  ];
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n`).join("");
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
    },
    cancel() {
      cancelled();
    },
  }), { status: 200 });

  const proxy = streamProxy(model, { messages: [] }, {
    authToken: "token",
    proxyUrl: "https://proxy.invalid",
  });
  let seen = 0;
  for await (const event of proxy) {
    assert.equal(event.type, "text_start");
    seen += 1;
    break;
  }
  await cancellation;
  assert.equal(seen, 1);
});

test("proxy rejects malformed terminal metadata and scalar fields", async (t) => {
  const invalid: Array<[Record<string, unknown>, RegExp]> = [
    [{ type: "error", reason: "error", errorMessage: 42, usage: usage(1, 1) }, /error message/u],
    [{ type: "done", reason: "stop", responseId: "x".repeat((4 * 1024) + 1), usage: usage(1, 1) }, /response ID/u],
    [{ type: "done", reason: "stop", responseId: 42, usage: usage(1, 1) }, /response ID/u],
    [{ type: "done", reason: "stop", responseModel: 42, usage: usage(1, 1) }, /response model/u],
    [{ type: "done", reason: "stop", responseModel: "x".repeat(1_025), usage: usage(1, 1) }, /response model/u],
    [{ type: "done", reason: "stop", diagnostics: 42, usage: usage(1, 1) }, /diagnostics/u],
    [{
      type: "done",
      reason: "stop",
      usage: usage(1, 1),
      providerState: {
        source: { api: model.api, provider: model.provider, model: "different-model" },
        value: { state: true },
      },
    }, /model boundary/u],
  ];
  for (const [event, pattern] of invalid) {
    const result = await proxyResultForEvents(t, [event]);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", pattern);
  }
});

test("proxy enforces canonical tool-call identity limits", async (t) => {
  for (const [id, toolName] of [
    ["x".repeat(MAX_TOOL_CALL_STREAM_ID_BYTES + 1), "read"],
    ["call-1", "x".repeat(MAX_TOOL_CALL_STREAM_NAME_BYTES + 1)],
    ["", "read"],
    ["call-1", "bad\nname"],
  ] as const) {
    const result = await proxyResultForEvents(t, [{
      type: "toolcall_start",
      contentIndex: 0,
      id,
      toolName,
    }]);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /tool-call identity/u);
  }
});

test("proxy terminal errors redact the exact per-request authentication token", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const secret = "proxy-auth-secret-7f0c4da88c0e4c8f";
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({
    type: "error",
    reason: "error",
    errorMessage: `upstream reflected ${secret}`,
    usage: {},
  })}\n`, { status: 200 });
  const result = await streamProxy(model, { messages: [] }, {
    authToken: secret,
    proxyUrl: "https://proxy.invalid",
  }).result();
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage?.includes(secret), false);
  assert.match(result.errorMessage ?? "", /\[REDACTED\]/u);

  for (const terminal of [
    { responseId: `response-${secret}` },
    { responseModel: `model-${secret}` },
    { diagnostics: [{ type: "test", message: `reflected ${secret}`, timestamp: 1 }] },
    {
      providerState: {
        source: { api: model.api, provider: model.provider, model: model.id },
        value: { reflected: secret },
      },
    },
  ]) {
    globalThis.fetch = async () => new Response(`data: ${JSON.stringify({
      type: "done",
      reason: "stop",
      usage: {},
      ...terminal,
    })}\n`, { status: 200 });
    const reflected = await streamProxy(model, { messages: [] }, {
      authToken: secret,
      proxyUrl: "https://proxy.invalid",
    }).result();
    assert.equal(reflected.stopReason, "error");
    assert.equal(JSON.stringify(reflected).includes(secret), false);
  }

  for (const events of [
    [
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: `reflected ${secret}` },
    ],
    [
      { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "read" },
      { type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify({ reflected: secret }) },
    ],
  ]) {
    globalThis.fetch = async () => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n`).join(""),
      { status: 200 },
    );
    const reflected = await streamProxy(model, { messages: [] }, {
      authToken: secret,
      proxyUrl: "https://proxy.invalid",
    }).result();
    assert.equal(reflected.stopReason, "error");
    assert.equal(JSON.stringify(reflected).includes(secret), false);
  }
});

const _streamContract: StreamFn = () => streamOf(assistant([{ type: "text", text: "ok" }]));
void _streamContract;
