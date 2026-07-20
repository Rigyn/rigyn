import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderRequest, ProviderState } from "../../src/core/types.js";
import { GatewayMessagesAdapter } from "../../src/providers/gateway-messages.js";
import { collect, fakeFetch, request, streamResponse, terminalCount } from "./helpers.js";

const CATALOG = {
  baseUrl: "https://messages.example.test/v1",
  models: [{
    id: "code-auto",
    name: "Code Auto",
    reasoning: true,
    thinkingLevelMap: { off: null, low: "brief", high: "deep" },
    input: ["text", "image"],
    cost: { input: 0.000001, output: 0.000002, cacheRead: 0.0000001, cacheWrite: 0.0000002 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  }],
};

const USAGE = {
  input: 10,
  output: 5,
  cacheRead: 3,
  cacheWrite: 2,
  reasoning: 2,
  totalTokens: 20,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};

function sse(...events: unknown[]): Response {
  return streamResponse([
    new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")),
  ], { "content-type": "text/event-stream", "x-request-id": "request-1" });
}

function gatewayRequest(state?: ProviderState): ProviderRequest {
  const value = request("company-gateway");
  value.model = "code-auto";
  value.maxOutputTokens = 512;
  value.reasoningEffort = "high";
  value.sessionId = "session-1";
  value.tools = [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }];
  if (state !== undefined) value.providerState = state;
  return value;
}

test("gateway messages discovers a credential-conditioned catalog and streams the complete contract", async () => {
  const requests: Request[] = [];
  const adapter = new GatewayMessagesAdapter({
    id: "company-gateway",
    gatewayUrl: "https://gateway.example.test/v1/",
    accessToken: "secret-token",
    cacheRetention: "long",
    toolChoice: "auto",
    temperature: 0.25,
    fetch: fakeFetch(async (incoming) => {
      requests.push(incoming);
      if (incoming.url.endsWith("/config")) return new Response(JSON.stringify(CATALOG));
      return sse(
        { type: "start" },
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_delta", contentIndex: 0, delta: "plan" },
        { type: "thinking_end", contentIndex: 0, content: "plan", contentSignature: "think-sig" },
        { type: "text_start", contentIndex: 1 },
        { type: "text_delta", contentIndex: 1, delta: "done" },
        { type: "text_end", contentIndex: 1, content: "done", contentSignature: "text-sig" },
        { type: "toolcall_start", contentIndex: 2, id: "call-1", toolName: "read" },
        { type: "toolcall_delta", contentIndex: 2, delta: "{\"path\":\"README.md\"}" },
        {
          type: "toolcall_end",
          contentIndex: 2,
          toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
        },
        {
          type: "done",
          reason: "toolUse",
          usage: USAGE,
          responseId: "response-1",
          rewrite: {
            policyId: "safe-context",
            policyVersion: 2,
            changed: true,
            tokenCountChange: -4,
            messageCountChange: 0,
            systemPromptChanged: false,
          },
        },
      );
    }),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.equal(models.length, 1);
  assert.deepEqual(models[0], {
    id: "code-auto",
    provider: "company-gateway",
    displayName: "Code Auto",
    contextTokens: 128_000,
    maxOutputTokens: 16_384,
    capabilities: {
      tools: { value: "supported", source: "provider", observedAt: models[0]!.capabilities.tools.observedAt },
      reasoning: { value: "supported", source: "provider", observedAt: models[0]!.capabilities.reasoning.observedAt },
      images: { value: "supported", source: "provider", observedAt: models[0]!.capabilities.images.observedAt },
    },
    compatibility: {
      protocolFamily: { value: "gateway-messages", source: "provider", observedAt: models[0]!.compatibility!.protocolFamily!.observedAt },
      inputModalities: { value: ["text", "image"], source: "provider", observedAt: models[0]!.compatibility!.inputModalities!.observedAt },
      outputModalities: { value: ["text"], source: "provider", observedAt: models[0]!.compatibility!.outputModalities!.observedAt },
      reasoningEfforts: { value: ["minimal", "low", "medium", "high", "xhigh", "max"], source: "provider", observedAt: models[0]!.compatibility!.reasoningEfforts!.observedAt },
      strictTools: { value: "unsupported", source: "maintained", observedAt: models[0]!.compatibility!.strictTools!.observedAt },
      toolStreaming: { value: "supported", source: "provider", observedAt: models[0]!.compatibility!.toolStreaming!.observedAt },
      cacheMode: { value: "automatic", source: "provider", observedAt: models[0]!.compatibility!.cacheMode!.observedAt },
      cacheAffinity: { value: "session", source: "provider", observedAt: models[0]!.compatibility!.cacheAffinity!.observedAt },
      cacheTiers: { value: ["provider-managed"], source: "provider", observedAt: models[0]!.compatibility!.cacheTiers!.observedAt },
      sessionAffinity: { value: "optional", source: "provider", observedAt: models[0]!.compatibility!.sessionAffinity!.observedAt },
    },
    pricing: {
      currency: "USD",
      unit: "per_million_tokens",
      source: "provider",
      observedAt: models[0]!.pricing!.observedAt,
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 0.2,
    },
  });

  const events = await collect(adapter.stream(gatewayRequest(), new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  assert.deepEqual(events.map((event) => event.type), [
    "response_start",
    "reasoning_delta",
    "text_delta",
    "tool_call_start",
    "tool_call_delta",
    "tool_call_end",
    "usage",
    "unknown_provider_event",
    "response_end",
  ]);
  const usage = events.find((event) => event.type === "usage");
  assert.deepEqual(usage?.type === "usage" ? usage.usage : undefined, {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    reasoningTokens: 2,
    totalTokens: 20,
    cost: "0.33",
    raw: USAGE,
  });
  const end = events.find((event) => event.type === "response_end");
  assert.equal(end?.type === "response_end" ? end.reason : undefined, "tool_calls");
  assert.deepEqual(end?.type === "response_end" ? end.state : undefined, {
    kind: "gateway_messages",
    responseId: "response-1",
    assistantContent: [
      { type: "thinking", thinking: "plan", thinkingSignature: "think-sig" },
      { type: "text", text: "done", textSignature: "text-sig" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
    ],
  });

  assert.equal(requests.length, 3, "each stream discovers its endpoint with the credential used for generation");
  assert.equal(requests[0]!.url, "https://gateway.example.test/v1/config");
  assert.equal(requests[1]!.url, "https://gateway.example.test/v1/config");
  assert.equal(requests[2]!.url, "https://messages.example.test/v1/messages");
  assert.equal(requests[0]!.headers.get("authorization"), "Bearer secret-token");
  assert.equal(requests[1]!.headers.get("authorization"), "Bearer secret-token");
  assert.equal(requests[2]!.headers.get("authorization"), "Bearer secret-token");
  const body = await requests[2]!.clone().json() as Record<string, any>;
  assert.deepEqual(body.options, {
    temperature: 0.25,
    maxTokens: 512,
    reasoning: "deep",
    cacheRetention: "long",
    sessionId: "session-1",
    toolChoice: "auto",
  });
  assert.equal(body.context.messages[0].role, "user");
  assert.equal(body.context.tools[0].parameters.type, "object");
});

test("gateway messages carries signed continuation content into the matching assistant turn", async () => {
  const outgoing: Request[] = [];
  const state: ProviderState = {
    kind: "gateway_messages",
    responseId: "previous-response",
    assistantContent: [
      { type: "thinking", thinking: "private", thinkingSignature: "signature" },
      { type: "text", text: "answer", textSignature: "text-signature" },
    ],
  };
  const adapter = new GatewayMessagesAdapter({
    id: "company-gateway",
    gatewayUrl: "https://gateway.example.test/v1",
    accessToken: "secret-token",
    fetch: fakeFetch(async (incoming) => {
      outgoing.push(incoming);
      if (incoming.url.endsWith("/config")) return new Response(JSON.stringify(CATALOG));
      return sse({ type: "done", reason: "stop", usage: USAGE });
    }),
  });
  const value = gatewayRequest(state);
  value.messages.push({
    id: "assistant-1",
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    createdAt: "2026-07-19T00:00:00.000Z",
  });
  value.messages.push({
    id: "user-2",
    role: "user",
    content: [{ type: "text", text: "continue" }],
    createdAt: "2026-07-19T00:00:01.000Z",
  });

  const events = await collect(adapter.stream(value, new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  const body = await outgoing[1]!.clone().json() as Record<string, any>;
  assert.deepEqual(body.context.messages[1].content, state.assistantContent);
  assert.equal(body.context.messages[1].responseId, "previous-response");
});

test("gateway messages binds discovery and generation to one fresh credential", async () => {
  let credential = 0;
  const requests: Request[] = [];
  const adapter = new GatewayMessagesAdapter({
    id: "gateway",
    gatewayUrl: "https://gateway.example.test/v1",
    accessToken: async () => `account-${++credential}`,
    fetch: fakeFetch(async (incoming) => {
      requests.push(incoming);
      if (incoming.url.endsWith("/config")) {
        const account = incoming.headers.get("authorization")?.slice("Bearer ".length);
        return new Response(JSON.stringify({
          ...CATALOG,
          baseUrl: `https://${account}.example.test/v1`,
          models: [{ ...CATALOG.models[0], id: "test-model" }],
        }));
      }
      return sse({ type: "done", reason: "stop", usage: USAGE });
    }),
  });

  await collect(adapter.stream(request("gateway"), new AbortController().signal));
  await collect(adapter.stream(request("gateway"), new AbortController().signal));

  assert.deepEqual(requests.map((entry) => [entry.url, entry.headers.get("authorization")]), [
    ["https://gateway.example.test/v1/config", "Bearer account-1"],
    ["https://account-1.example.test/v1/messages", "Bearer account-1"],
    ["https://gateway.example.test/v1/config", "Bearer account-2"],
    ["https://account-2.example.test/v1/messages", "Bearer account-2"],
  ]);
  assert.equal(credential, 2);
});

test("gateway messages withholds redacted thinking and rejects inconsistent streamed tool arguments", async (t) => {
  await t.test("redacted thinking", async () => {
    const adapter = new GatewayMessagesAdapter({
      id: "gateway",
      gatewayUrl: "https://gateway.example.test/v1",
      accessToken: "token",
      fetch: fakeFetch(async (incoming) => incoming.url.endsWith("/config")
        ? new Response(JSON.stringify({ ...CATALOG, models: [{ ...CATALOG.models[0], id: "test-model" }] }))
        : sse(
            { type: "thinking_start", contentIndex: 0 },
            { type: "thinking_delta", contentIndex: 0, delta: "private trace" },
            { type: "thinking_end", contentIndex: 0, content: "private trace", redacted: true },
            { type: "done", reason: "stop", usage: USAGE },
          )),
    });
    const events = await collect(adapter.stream(request("gateway"), new AbortController().signal));
    assert.equal(events.some((event) => event.type === "reasoning_delta"), false);
    const end = events.find((event) => event.type === "response_end");
    assert.deepEqual(end?.type === "response_end" ? end.state : undefined, {
      kind: "gateway_messages",
      assistantContent: [{ type: "thinking", thinking: "private trace", redacted: true }],
    });
  });

  await t.test("tool argument mismatch", async () => {
    const adapter = new GatewayMessagesAdapter({
      id: "gateway",
      gatewayUrl: "https://gateway.example.test/v1",
      accessToken: "token",
      fetch: fakeFetch(async (incoming) => incoming.url.endsWith("/config")
        ? new Response(JSON.stringify({ ...CATALOG, models: [{ ...CATALOG.models[0], id: "test-model" }] }))
        : sse(
            { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "read" },
            { type: "toolcall_delta", contentIndex: 0, delta: "{\"path\":\"safe.txt\"}" },
            {
              type: "toolcall_end",
              contentIndex: 0,
              toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: { path: "other.txt" } },
            },
          )),
    });
    const events = await collect(adapter.stream(request("gateway"), new AbortController().signal));
    const failure = events.at(-1);
    assert.equal(failure?.type, "error");
    assert.match(failure?.type === "error" ? failure.error.message : "", /did not match their streamed value/u);
  });
});

test("gateway messages rejects malformed catalogs, response errors, invalid ordering, and early EOF", async () => {
  const invalidCatalog = new GatewayMessagesAdapter({
    id: "gateway",
    gatewayUrl: "https://gateway.example.test/v1",
    accessToken: "token",
    fetch: fakeFetch(async () => new Response(JSON.stringify({
      ...CATALOG,
      models: [...CATALOG.models, { ...CATALOG.models[0] }],
    }))),
  });
  await assert.rejects(invalidCatalog.listModels(new AbortController().signal), /duplicate model IDs/u);

  const httpFailure = new GatewayMessagesAdapter({
    id: "gateway",
    gatewayUrl: "https://gateway.example.test/v1",
    accessToken: "token",
    fetch: fakeFetch(async (incoming) => incoming.url.endsWith("/config")
      ? new Response(JSON.stringify({ ...CATALOG, models: [{ ...CATALOG.models[0], id: "test-model" }] }))
      : new Response(JSON.stringify({ error: { message: "expired", code: "token_expired" } }), {
          status: 401,
          headers: { "content-type": "application/json", "x-request-id": "failed-request" },
        })),
  });
  const httpEvents = await collect(httpFailure.stream(request("gateway"), new AbortController().signal));
  const httpError = httpEvents.at(-1);
  assert.equal(httpError?.type === "error" ? httpError.error.category : undefined, "authentication");
  assert.equal(httpError?.type === "error" ? httpError.error.providerCode : undefined, "token_expired");
  assert.equal(httpError?.type === "error" ? httpError.error.requestId : undefined, "failed-request");

  for (const [events, message, retryable, partial, eventTypes] of [
    [[{ type: "text_delta", contentIndex: 0, delta: "bad" }], /matching start event/u, false, false, ["error"]],
    [[{ type: "start" }], /without a terminal event/u, true, false, ["error"]],
    [[{ type: "text_start", contentIndex: 0 }, { type: "text_delta", contentIndex: 0, delta: "partial" }], /without a terminal event/u, false, true, ["response_start", "text_delta", "error"]],
  ] as const) {
    const adapter = new GatewayMessagesAdapter({
      id: "gateway",
      gatewayUrl: "https://gateway.example.test/v1",
      accessToken: "token",
      fetch: fakeFetch(async (incoming) => incoming.url.endsWith("/config")
        ? new Response(JSON.stringify({ ...CATALOG, models: [{ ...CATALOG.models[0], id: "test-model" }] }))
        : sse(...events)),
    });
    const streamed = await collect(adapter.stream(request("gateway"), new AbortController().signal));
    assert.deepEqual(streamed.map((event) => event.type), eventTypes);
    const error = streamed.at(-1);
    assert.equal(error?.type, "error");
    if (error?.type !== "error") continue;
    assert.match(error.error.message, message);
    assert.equal(error.error.retryable, retryable);
    assert.equal(error.error.partial, partial);
  }
});

test("gateway messages maps a terminal aborted event and propagates fetch cancellation", async () => {
  const terminalAbort = new GatewayMessagesAdapter({
    id: "gateway",
    gatewayUrl: "https://gateway.example.test/v1",
    accessToken: "token",
    fetch: fakeFetch(async (incoming) => incoming.url.endsWith("/config")
      ? new Response(JSON.stringify({ ...CATALOG, models: [{ ...CATALOG.models[0], id: "test-model" }] }))
      : sse({ type: "error", reason: "aborted", usage: USAGE, errorMessage: "cancelled upstream" })),
  });
  const terminalEvents = await collect(terminalAbort.stream(request("gateway"), new AbortController().signal));
  const terminalError = terminalEvents.at(-1);
  assert.equal(terminalError?.type === "error" ? terminalError.error.category : undefined, "cancelled");

  let started: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const aborted = new GatewayMessagesAdapter({
    id: "gateway",
    gatewayUrl: "https://gateway.example.test/v1",
    accessToken: "token",
    fetch: fakeFetch(async (incoming) => {
      started?.();
      return await new Promise<Response>((_resolve, reject) => {
        incoming.signal.addEventListener("abort", () => reject(incoming.signal.reason), { once: true });
      });
    }),
  });
  const controller = new AbortController();
  const pending = collect(aborted.stream(request("gateway"), controller.signal));
  await waiting;
  controller.abort(new DOMException("stop", "AbortError"));
  const abortedEvents = await pending;
  const abortedError = abortedEvents.at(-1);
  assert.equal(abortedError?.type === "error" ? abortedError.error.category : undefined, "cancelled");
});

test("gateway messages discards a credential-conditioned endpoint after a failed refresh", async () => {
  let configCalls = 0;
  const adapter = new GatewayMessagesAdapter({
    id: "gateway",
    gatewayUrl: "https://gateway.example.test/v1",
    accessToken: "token",
    fetch: fakeFetch(async (incoming) => {
      if (incoming.url.endsWith("/config")) {
        configCalls += 1;
        if (configCalls === 2) {
          return new Response(JSON.stringify({ error: { message: "account changed" } }), { status: 403 });
        }
        return new Response(JSON.stringify({ ...CATALOG, models: [{ ...CATALOG.models[0], id: "test-model" }] }));
      }
      return sse({ type: "done", reason: "stop", usage: USAGE });
    }),
  });

  await adapter.listModels(new AbortController().signal);
  await assert.rejects(adapter.listModels(new AbortController().signal), /account changed/u);
  const events = await collect(adapter.stream(request("gateway"), new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  assert.equal(configCalls, 3, "the stream re-discovers instead of using the endpoint from the prior credential state");
});
