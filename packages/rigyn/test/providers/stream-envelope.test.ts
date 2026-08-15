import assert from "node:assert/strict";
import test from "node:test";

import { MAX_TOOL_CALL_STREAM_DELTA_BYTES } from "../../src/core/events.js";
import type { JsonValue } from "../../src/core/json.js";
import type { AdapterEvent, AssistantContentBlock } from "../../src/core/types.js";
import {
  ProviderStreamProjector,
  projectProviderStream,
  type ProviderStreamEnvelope,
} from "../../src/providers/index.js";

const MAX_PROVIDER_STREAM_TOOL_CALLS = 256;

async function collect(source: AsyncIterable<ProviderStreamEnvelope>): Promise<ProviderStreamEnvelope[]> {
  const result: ProviderStreamEnvelope[] = [];
  for await (const event of source) result.push(event);
  return result;
}

async function* events(values: readonly AdapterEvent[]): AsyncIterable<AdapterEvent> {
  yield* values;
}

test("provider stream projection preserves a typed interleaved stream without private provider state", async () => {
  const projected = await collect(projectProviderStream("example-provider", events([
    {
      type: "response_start",
      model: "example-model",
      responseId: "response-1",
      requestId: "request-1",
      diagnostics: {
        status: 200,
        headers: {
          "x-request-id": "request-1",
          authorization: "Bearer transport-secret",
          "set-cookie": "session=transport-secret",
        },
      },
    },
    { type: "text_delta", part: 0, text: "visible" },
    { type: "tool_call_start", index: 1, id: "call-1", name: "write" },
    { type: "reasoning_delta", part: 0, text: "inspect", visibility: "summary" },
    { type: "tool_call_delta", index: 1, jsonFragment: "{\"path\":\"/tmp/out" },
    { type: "tool_call_start", index: 2, name: "read" },
    { type: "tool_call_delta", index: 2, jsonFragment: "{\"path\":\"/tmp/in\"}" },
    { type: "tool_call_delta", index: 1, jsonFragment: "\",\"content\":\"ok\"}" },
    {
      type: "tool_call_end",
      index: 1,
      id: "call-1",
      name: "write",
      rawArguments: "{\"path\":\"/tmp/out\",\"content\":\"ok\"}",
      arguments: { path: "/tmp/out", content: "ok" },
    },
    {
      type: "tool_call_end",
      index: 2,
      name: "read",
      rawArguments: "{\"path\":\"/tmp/in\"}",
      arguments: { path: "/tmp/in" },
    },
    {
      type: "usage",
      semantics: "final",
      usage: {
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        raw: { bearer: "transport-secret" },
      },
    },
    {
      type: "unknown_provider_event",
      provider: "example-provider",
      raw: { authorization: "transport-secret" },
    },
    {
      type: "response_end",
      reason: "tool_calls",
      rawReason: "tool_use",
      state: {
        kind: "chat_completions",
        assistantMessage: { authorization: "transport-secret" },
      },
    },
  ])));

  assert.deepEqual(projected.map((entry) => entry.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(projected.every((entry) => entry.schemaVersion === 1 && entry.provider === "example-provider"), true);
  assert.deepEqual(projected[0], {
    schemaVersion: 1,
    provider: "example-provider",
    sequence: 1,
    event: {
      type: "response_start",
      model: "example-model",
      responseId: "response-1",
      requestId: "request-1",
      diagnostics: { status: 200, headers: { "x-request-id": "request-1" } },
    },
  });
  assert.deepEqual(projected[4]?.event, {
    type: "tool_call_delta",
    index: 1,
    delta: "{\"path\":\"/tmp/out",
    partial: {
      index: 1,
      id: "call-1",
      name: "write",
      rawArguments: "{\"path\":\"/tmp/out",
      arguments: { path: "/tmp/out" },
    },
  });
  assert.deepEqual(projected[6]?.event, {
    type: "tool_call_delta",
    index: 2,
    delta: "{\"path\":\"/tmp/in\"}",
    partial: {
      index: 2,
      name: "read",
      rawArguments: "{\"path\":\"/tmp/in\"}",
      arguments: { path: "/tmp/in" },
    },
  });
  assert.deepEqual(projected[8]?.event, {
    type: "tool_call_end",
    index: 1,
    toolCall: {
      index: 1,
      id: "call-1",
      name: "write",
      rawArguments: "{\"path\":\"/tmp/out\",\"content\":\"ok\"}",
      arguments: { path: "/tmp/out", content: "ok" },
    },
  });
  assert.deepEqual(projected[10]?.event, {
    type: "usage",
    semantics: "final",
    usage: {
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  });
  assert.deepEqual(projected[11]?.event, {
    type: "response_end",
    reason: "tool_calls",
    rawReason: "tool_use",
  });
  assert.equal(JSON.stringify(projected).includes("transport-secret"), false);
});

test("provider stream projection exposes bounded error metadata and redacted diagnostics", () => {
  const projector = new ProviderStreamProjector("example-provider");
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
  const projected = projector.project({
    type: "error",
    error: {
      category: "authentication",
      message: `authorization: Bearer ${secret}`,
      httpStatus: 401,
      providerCode: "invalid_api_key",
      requestId: "request-2",
      retryAfterMs: 250,
      retryable: false,
      partial: true,
      bodyStarted: true,
      diagnostics: {
        status: 401,
        headers: {
          "x-request-id": "request-2",
          cookie: `session=${secret}`,
          "x-api-key": secret,
        },
      },
      raw: { token: secret },
    },
  });

  assert.deepEqual(projected, {
    schemaVersion: 1,
    provider: "example-provider",
    sequence: 1,
    event: {
      type: "error",
      error: {
        category: "authentication",
        message: "authorization: Bearer [REDACTED]",
        httpStatus: 401,
        providerCode: "invalid_api_key",
        requestId: "request-2",
        retryAfterMs: 250,
        retryable: false,
        partial: true,
        bodyStarted: true,
        diagnostics: { status: 401, headers: { "x-request-id": "request-2" } },
      },
    },
  });
  assert.equal(JSON.stringify(projected).includes(secret), false);
});

test("provider stream projection rejects hostile error records without invoking them", () => {
  const projector = new ProviderStreamProjector("example-provider");
  let getterCalls = 0;
  const error: Record<string, unknown> = {
    category: "provider",
    retryable: false,
    partial: false,
  };
  Object.defineProperty(error, "message", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-run";
    },
  });

  assert.throws(
    () => projector.project({ type: "error", error: error as never }),
    /enumerable data properties/u,
  );
  assert.equal(getterCalls, 0);
  assert.throws(
    () => projector.project({
      type: "error",
      error: {
        category: "provider",
        message: "invalid",
        retryable: false,
        partial: false,
        unsupported: true,
      } as never,
    }),
    /unsupported fields/u,
  );
});

test("provider stream projection rejects hostile event envelopes before invoking them", () => {
  let accessorCalls = 0;
  const typeAccessor = { part: 0 } as Record<string, unknown>;
  Object.defineProperty(typeAccessor, "type", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return "text_start";
    },
  });
  assert.throws(
    () => new ProviderStreamProjector("example-provider").project(typeAccessor as never),
    TypeError,
  );
  assert.equal(accessorCalls, 0);

  const textAccessor: Record<string, unknown> = { type: "text_delta", part: 0 };
  Object.defineProperty(textAccessor, "text", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return "must-not-run";
    },
  });
  assert.throws(
    () => new ProviderStreamProjector("example-provider").project(textAccessor as never),
    TypeError,
  );
  assert.equal(accessorCalls, 0);

  const terminalAccessor: Record<string, unknown> = {
    type: "response_end",
    reason: "stop",
    state: { kind: "chat_completions", assistantMessage: {} },
  };
  Object.defineProperty(terminalAccessor, "content", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return [{ type: "text", text: "must-not-run" }];
    },
  });
  assert.throws(
    () => new ProviderStreamProjector("example-provider").project(terminalAccessor as never),
    TypeError,
  );
  assert.equal(accessorCalls, 0);

  let proxyTrapCalls = 0;
  const proxy = new Proxy({ type: "text_start" as const, part: 0 }, {
    get(target, property, receiver) {
      proxyTrapCalls += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () => new ProviderStreamProjector("example-provider").project(proxy),
    TypeError,
  );
  assert.equal(proxyTrapCalls, 0);

  const ignored: Record<string, unknown> = {
    type: "unknown_provider_event",
    provider: "example-provider",
  };
  Object.defineProperty(ignored, "raw", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return { private: true };
    },
  });
  assert.equal(new ProviderStreamProjector("example-provider").project(ignored as never), undefined);
  assert.equal(accessorCalls, 0);
});

test("provider stream projection rejects malformed normalized metadata", () => {
  const projector = new ProviderStreamProjector("example-provider");
  assert.throws(
    () => projector.project({
      type: "usage",
      semantics: "final",
      usage: { inputTokens: -1 },
    }),
    /(?:usage is invalid|invalid normalized usage)/u,
  );
  assert.throws(
    () => projector.project({ type: "tool_call_delta", index: -1, jsonFragment: "{}" }),
    /tool(?:-call| call) index/u,
  );
});

test("provider stream projection preserves an explicit null tool argument value", () => {
  const projector = new ProviderStreamProjector("example-provider");
  const projected = projector.project({
    type: "tool_call_end",
    index: 0,
    name: "nullable",
    rawArguments: "{}",
    arguments: null,
  });
  assert.deepEqual(projected?.event, {
    type: "tool_call_end",
    index: 0,
    toolCall: { index: 0, name: "nullable", rawArguments: "{}", arguments: null },
  });
});

test("provider stream projection bounds active and completed tool-call cardinality", () => {
  const active = new ProviderStreamProjector("example-provider");
  for (let index = 0; index < MAX_PROVIDER_STREAM_TOOL_CALLS; index += 1) {
    active.project({ type: "tool_call_delta", index, jsonFragment: "" });
  }
  assert.throws(
    () => active.project({ type: "tool_call_delta", index: MAX_PROVIDER_STREAM_TOOL_CALLS, jsonFragment: "" }),
    /more than 256 tool calls/u,
  );

  const completed = new ProviderStreamProjector("example-provider");
  for (let index = 0; index < MAX_PROVIDER_STREAM_TOOL_CALLS; index += 1) {
    completed.project({
      type: "tool_call_end",
      index,
      name: "done",
      rawArguments: "{}",
      arguments: {},
    });
  }
  assert.throws(
    () => completed.project({
      type: "tool_call_end",
      index: MAX_PROVIDER_STREAM_TOOL_CALLS,
      name: "overflow",
      rawArguments: "{}",
      arguments: {},
    }),
    /more than 256 tool calls/u,
  );

  completed.project({ type: "response_start", model: "next-response" });
  assert.doesNotThrow(() => completed.project({
    type: "tool_call_end",
    index: MAX_PROVIDER_STREAM_TOOL_CALLS,
    name: "reset",
    rawArguments: "{}",
    arguments: {},
  }));
});

test("provider stream projection bounds aggregate retained tool-call state", () => {
  const projector = new ProviderStreamProjector("example-provider");
  const full = "x".repeat(MAX_TOOL_CALL_STREAM_DELTA_BYTES);
  const almostFull = "y".repeat(MAX_TOOL_CALL_STREAM_DELTA_BYTES - 1);

  projector.project({ type: "tool_call_delta", index: 0, jsonFragment: full });
  projector.project({ type: "tool_call_delta", index: 1, jsonFragment: almostFull });
  assert.doesNotThrow(() => projector.project({ type: "tool_call_start", index: 2, id: "z" }));
  assert.throws(
    () => projector.project({ type: "tool_call_start", index: 3, name: "n" }),
    /tool call state exceeds 8388608 aggregate bytes/u,
  );

  projector.project({
    type: "tool_call_end",
    index: 0,
    name: "release",
    rawArguments: "{}",
    arguments: {},
  });
  assert.doesNotThrow(() => projector.project({ type: "tool_call_start", index: 3, name: "n" }));
});

test("provider stream projection rejects tool-call order resets without corrupting state", () => {
  const projector = new ProviderStreamProjector("example-provider");
  projector.project({ type: "tool_call_delta", index: 0, jsonFragment: "{" });
  assert.throws(
    () => projector.project({ type: "tool_call_start", index: 0, id: "reset", name: "write" }),
    /tool_call_start for index 0/u,
  );
  const completedDelta = projector.project({ type: "tool_call_delta", index: 0, jsonFragment: "}" });
  assert.equal(
    completedDelta?.event.type === "tool_call_delta" ? completedDelta.event.partial.rawArguments : undefined,
    "{}",
  );

  projector.project({
    type: "tool_call_end",
    index: 0,
    name: "write",
    rawArguments: "{}",
    arguments: {},
  });
  assert.throws(
    () => projector.project({
      type: "tool_call_end",
      index: 0,
      name: "write",
      rawArguments: "{}",
      arguments: {},
    }),
    /more than one tool_call_end for index 0/u,
  );
  assert.throws(
    () => projector.project({ type: "tool_call_delta", index: 0, jsonFragment: "ignored" }),
    /tool_call_delta after tool_call_end for index 0/u,
  );
});

test("provider stream projection rejects unfinished tools at success and clears calls at every boundary", () => {
  const projector = new ProviderStreamProjector("example-provider");

  projector.project({ type: "tool_call_delta", index: 0, jsonFragment: "old" });
  assert.throws(
    () => projector.project({
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: {} },
    }),
    /response_end before tool_call_end/u,
  );
  const afterEnd = projector.project({ type: "tool_call_delta", index: 0, jsonFragment: "new" });
  assert.equal(
    afterEnd?.event.type === "tool_call_delta" ? afterEnd.event.partial.rawArguments : undefined,
    "new",
  );

  projector.project({ type: "tool_call_delta", index: 1, jsonFragment: "old" });
  projector.project({
    type: "error",
    error: { category: "provider", message: "failed", retryable: false, partial: true },
  });
  const afterError = projector.project({ type: "tool_call_delta", index: 1, jsonFragment: "new" });
  assert.equal(
    afterError?.event.type === "tool_call_delta" ? afterError.event.partial.rawArguments : undefined,
    "new",
  );

  projector.project({ type: "tool_call_delta", index: 2, jsonFragment: "old" });
  projector.project({ type: "response_start", model: "next-response" });
  const afterStart = projector.project({ type: "tool_call_delta", index: 2, jsonFragment: "new" });
  assert.equal(
    afterStart?.event.type === "tool_call_delta" ? afterStart.event.partial.rawArguments : undefined,
    "new",
  );

  const terminalContent = new ProviderStreamProjector("example-provider");
  terminalContent.project({ type: "tool_call_start", index: 0, id: "call", name: "read" });
  assert.throws(
    () => terminalContent.project({
      type: "response_end",
      reason: "tool_calls",
      state: { kind: "chat_completions", assistantMessage: {} },
      content: [{ type: "tool_call", callId: "call", name: "read", arguments: {} }],
    }),
    /response_end before tool_call_end/u,
  );

  let getterCalls = 0;
  const hostileContent = { type: "text" } as Record<string, unknown>;
  Object.defineProperty(hostileContent, "text", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-run";
    },
  });
  const hostileTerminal = new ProviderStreamProjector("example-provider");
  hostileTerminal.project({ type: "tool_call_start", index: 0, name: "read" });
  assert.throws(
    () => hostileTerminal.project({
      type: "response_end",
      reason: "tool_calls",
      state: { kind: "chat_completions", assistantMessage: {} },
      content: [hostileContent] as never,
    }),
    /response_end before tool_call_end/u,
  );
  assert.equal(getterCalls, 0);
});

test("provider stream projection preserves detached authoritative terminal content", () => {
  const projector = new ProviderStreamProjector("example-provider");
  const argumentsValue = { path: "/tmp/input" };
  const content: AssistantContentBlock[] = [
    { type: "text", text: "hello" },
    { type: "tool_call", callId: "call", name: "read", arguments: argumentsValue },
  ];
  projector.project({ type: "text_delta", part: 0, text: "hel" });
  const projected = projector.project({
    type: "response_end",
    reason: "tool_calls",
    state: { kind: "chat_completions", assistantMessage: {} },
    content,
  });
  assert.deepEqual(projected?.event, { type: "response_end", reason: "tool_calls", content });
  argumentsValue.path = "mutated";
  assert.deepEqual(
    projected?.event.type === "response_end" ? projected.event.content?.[1] : undefined,
    { type: "tool_call", callId: "call", name: "read", arguments: { path: "/tmp/input" } },
  );

  const terminalOnly = new ProviderStreamProjector("example-provider").project({
    type: "response_end",
    reason: "stop",
    state: { kind: "chat_completions", assistantMessage: {} },
    content: [{ type: "text", text: "terminal only" }],
  });
  assert.deepEqual(terminalOnly?.event, {
    type: "response_end",
    reason: "stop",
    content: [{ type: "text", text: "terminal only" }],
  });

  let getterCalls = 0;
  const hostile = { type: "text" } as Record<string, unknown>;
  Object.defineProperty(hostile, "text", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-run";
    },
  });
  assert.throws(
    () => new ProviderStreamProjector("example-provider").project({
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: {} },
      content: [hostile] as never,
    }),
    /enumerable data properties/u,
  );
  assert.equal(getterCalls, 0);

  const terminalTools = Array.from({ length: MAX_PROVIDER_STREAM_TOOL_CALLS + 1 }, (_, index) => ({
    type: "tool_call" as const,
    callId: `call-${index}`,
    name: "read",
    arguments: {},
  }));
  assert.throws(
    () => new ProviderStreamProjector("example-provider").project({
      type: "response_end",
      reason: "tool_calls",
      state: { kind: "chat_completions", assistantMessage: {} },
      content: terminalTools,
    }),
    /more than 256 terminal tool calls/u,
  );
});

test("provider stream projection preserves detached bounded terminal diagnostics", () => {
  const details = { phase: "stable" };
  const diagnostics = [{
    type: "provider_notice",
    message: "visible",
    details,
    timestamp: 1,
  }];
  const projected = new ProviderStreamProjector("example-provider").project({
    type: "response_end",
    reason: "stop",
    state: { kind: "chat_completions", assistantMessage: {} },
    assistantDiagnostics: diagnostics,
  });
  assert.deepEqual(
    projected?.event.type === "response_end" ? projected.event.assistantDiagnostics : undefined,
    diagnostics,
  );
  details.phase = "mutated";
  assert.deepEqual(
    projected?.event.type === "response_end" ? projected.event.assistantDiagnostics?.[0]?.details : undefined,
    { phase: "stable" },
  );

  let getterCalls = 0;
  const hostile = { type: "provider_notice", timestamp: 1 } as Record<string, unknown>;
  Object.defineProperty(hostile, "message", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-run";
    },
  });
  assert.throws(
    () => new ProviderStreamProjector("example-provider").project({
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: {} },
      assistantDiagnostics: [hostile] as never,
    }),
    TypeError,
  );
  assert.equal(getterCalls, 0);
});

test("provider stream projection preserves the aborted finish reason", () => {
  const projected = new ProviderStreamProjector("example-provider").project({
    type: "response_end",
    reason: "aborted",
    state: { kind: "chat_completions", assistantMessage: {} },
  });
  assert.deepEqual(projected?.event, { type: "response_end", reason: "aborted" });
});

test("provider stream projection failures do not consume capacity or mutate partial arguments", () => {
  const projector = new ProviderStreamProjector("example-provider");
  projector.project({ type: "tool_call_delta", index: 0, jsonFragment: "{" });
  assert.throws(
    () => projector.project({
      type: "tool_call_delta",
      index: 0,
      jsonFragment: "x".repeat(MAX_TOOL_CALL_STREAM_DELTA_BYTES),
    }),
    /arguments exceed their byte limit/u,
  );
  const recovered = projector.project({ type: "tool_call_delta", index: 0, jsonFragment: "}" });
  assert.equal(
    recovered?.event.type === "tool_call_delta" ? recovered.event.partial.rawArguments : undefined,
    "{}",
  );

  assert.throws(
    () => projector.project({ type: "tool_call_start", index: 1, id: "x".repeat(1_025) }),
    /tool(?:-call| call) ID .*exceeds/u,
  );
  assert.doesNotThrow(() => projector.project({ type: "tool_call_start", index: 1, id: "valid" }));
});

test("provider stream projection bounds text and reasoning deltas by UTF-8 bytes", () => {
  const projector = new ProviderStreamProjector("example-provider");
  const exactTextBoundary = "x".repeat(MAX_TOOL_CALL_STREAM_DELTA_BYTES);
  const exactReasoningBoundary = "é".repeat(MAX_TOOL_CALL_STREAM_DELTA_BYTES / 2);
  assert.equal(Buffer.byteLength(exactReasoningBoundary, "utf8"), MAX_TOOL_CALL_STREAM_DELTA_BYTES);

  assert.doesNotThrow(() => projector.project({ type: "text_delta", part: 0, text: exactTextBoundary }));
  assert.doesNotThrow(() => projector.project({
    type: "reasoning_delta",
    part: 0,
    text: exactReasoningBoundary,
    visibility: "summary",
  }));
  assert.throws(
    () => projector.project({
      type: "text_delta",
      part: 0,
      text: `${exactTextBoundary}x`,
    }),
    /text delta .*exceeds/u,
  );
  assert.throws(
    () => projector.project({
      type: "reasoning_delta",
      part: 0,
      text: `${exactReasoningBoundary}é`,
      visibility: "summary",
    }),
    /reasoning delta .*exceeds/u,
  );
});

test("provider stream projection rejects non-plain JSON without invoking toJSON", () => {
  let toJsonCalls = 0;
  const inherited = { safe: true };
  Object.setPrototypeOf(inherited, {
    toJSON() {
      toJsonCalls += 1;
      return { replaced: true };
    },
  });
  const inheritedProjector = new ProviderStreamProjector("example-provider");
  assert.throws(
    () => inheritedProjector.project({
      type: "tool_call_end",
      index: 0,
      name: "inherited",
      rawArguments: "{}",
      arguments: inherited,
    }),
    (cause) => cause instanceof TypeError && /plain objects and vanilla arrays/u.test(cause.message),
  );

  const hidden = { safe: true };
  Object.defineProperty(hidden, "toJSON", {
    enumerable: false,
    value() {
      toJsonCalls += 1;
      return { replaced: true };
    },
  });
  const hiddenProjector = new ProviderStreamProjector("example-provider");
  assert.throws(
    () => hiddenProjector.project({
      type: "tool_call_end",
      index: 0,
      name: "hidden",
      rawArguments: "{}",
      arguments: hidden,
    }),
    (cause) => cause instanceof TypeError && /enumerable data properties/u.test(cause.message),
  );
  assert.equal(toJsonCalls, 0);

  const exoticProjector = new ProviderStreamProjector("example-provider");
  assert.throws(
    () => exoticProjector.project({
      type: "tool_call_end",
      index: 0,
      name: "date",
      rawArguments: "{}",
      arguments: new Date("2026-01-01T00:00:00.000Z") as unknown as JsonValue,
    }),
    (cause) => cause instanceof TypeError && /plain objects and vanilla arrays/u.test(cause.message),
  );
  assert.doesNotThrow(() => exoticProjector.project({
    type: "tool_call_end",
    index: 0,
    name: "recovered",
    rawArguments: "{}",
    arguments: {},
  }));

  const proxyProjector = new ProviderStreamProjector("example-provider");
  assert.throws(
    () => proxyProjector.project({
      type: "tool_call_end",
      index: 0,
      name: "proxy",
      rawArguments: "{}",
      arguments: new Proxy({ safe: true }, {}),
    }),
    (cause) => cause instanceof TypeError && /must not contain proxies/u.test(cause.message),
  );
});

test("provider stream projection bounds structured tool arguments before snapshot", () => {
  const oversized = new ProviderStreamProjector("example-provider");
  assert.throws(
    () => oversized.project({
      type: "tool_call_end",
      index: 0,
      name: "oversized",
      rawArguments: "{}",
      arguments: { value: "x".repeat(MAX_TOOL_CALL_STREAM_DELTA_BYTES) },
    }),
    /tool(?:-call| call) arguments exceeds 4194304 UTF-8 bytes/u,
  );
  assert.doesNotThrow(() => oversized.project({
    type: "tool_call_end",
    index: 0,
    name: "recovered",
    rawArguments: "{}",
    arguments: {},
  }));

  const wrapperBytes = Buffer.byteLength('{"value":""}', "utf8");
  const value = "x".repeat(MAX_TOOL_CALL_STREAM_DELTA_BYTES - wrapperBytes);
  const exact = new ProviderStreamProjector("example-provider");
  const projected = exact.project({
    type: "tool_call_end",
    index: 0,
    name: "exact",
    rawArguments: "{}",
    arguments: { value },
  });
  assert.equal(
    projected?.event.type === "tool_call_end" &&
      typeof projected.event.toolCall.arguments === "object" &&
      projected.event.toolCall.arguments !== null &&
      !Array.isArray(projected.event.toolCall.arguments)
      ? projected.event.toolCall.arguments.value
      : undefined,
    value,
  );

  const tooManyValues = new ProviderStreamProjector("example-provider");
  assert.throws(
    () => tooManyValues.project({
      type: "tool_call_end",
      index: 0,
      name: "too-many-values",
      rawArguments: "[]",
      arguments: Array.from({ length: 8_192 }, () => null),
    }),
    /exceeds 8192 JSON values/u,
  );
});

test("malformed response boundaries discard retained tool-call state", () => {
  const assertReset = (boundary: AdapterEvent): void => {
    const projector = new ProviderStreamProjector("example-provider");
    projector.project({ type: "tool_call_delta", index: 0, jsonFragment: "old" });
    assert.throws(() => projector.project(boundary));
    const next = projector.project({ type: "tool_call_delta", index: 0, jsonFragment: "new" });
    assert.equal(
      next?.event.type === "tool_call_delta" ? next.event.partial.rawArguments : undefined,
      "new",
    );
  };

  assertReset({ type: "response_start", model: "" });
  assertReset({
    type: "response_end",
    reason: "invalid" as never,
    state: { kind: "chat_completions", assistantMessage: {} },
  });
  assertReset({ type: "error", error: null as never });
});

test("provider stream projection parses partial arguments only at exponential byte checkpoints", () => {
  const projector = new ProviderStreamProjector("example-provider");
  const fragments = ["{", "\"", "a", "\"", ":", "1", "}"];
  const parsed: boolean[] = [];
  for (const jsonFragment of fragments) {
    const projected = projector.project({ type: "tool_call_delta", index: 0, jsonFragment });
    parsed.push(projected?.event.type === "tool_call_delta" && "arguments" in projected.event.partial);
  }
  assert.deepEqual(parsed, [true, true, false, true, false, false, false]);

  const paced = new ProviderStreamProjector("example-provider");
  let parseCheckpoints = 0;
  let lastRawArguments = "";
  for (let index = 0; index < 4_096; index += 1) {
    const projected = paced.project({
      type: "tool_call_delta",
      index: 0,
      jsonFragment: index === 0 ? "{" : " ",
    });
    if (projected?.event.type !== "tool_call_delta") continue;
    if ("arguments" in projected.event.partial) parseCheckpoints += 1;
    lastRawArguments = projected.event.partial.rawArguments;
  }
  assert.equal(parseCheckpoints, 13);
  assert.equal(lastRawArguments, `{${" ".repeat(4_095)}`);
});

test("provider stream projection applies structured bounds to final raw arguments", () => {
  const rawArguments = JSON.stringify(Array.from({ length: 8_192 }, () => null));
  const projector = new ProviderStreamProjector("example-provider");
  assert.throws(
    () => projector.project({
      type: "tool_call_end",
      index: 0,
      name: "too-many-values",
      rawArguments,
    }),
    /exceeds 8192 JSON values/u,
  );
  assert.doesNotThrow(() => projector.project({
    type: "tool_call_end",
    index: 0,
    name: "recovered",
    rawArguments: "{}",
  }));
});
