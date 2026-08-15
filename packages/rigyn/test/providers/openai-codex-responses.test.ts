import assert from "node:assert/strict";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import {
  CloseEvent as NetworkCloseEvent,
  ErrorEvent as NetworkErrorEvent,
  MessageEvent as NetworkMessageEvent,
} from "undici";

import {
  buildOpenAICodexResponsesBody,
  OpenAICodexResponsesAdapter,
  openAICodexModels,
  type OpenAICodexResponsesConfig,
} from "../../src/providers/openai-codex-responses.js";
import type { NetworkWebSocket, NetworkWebSocketFactory } from "../../src/net/index.js";
import type { ProviderRequest, ProviderState } from "../../src/core/types.js";
import { HttpResponseError, ProtocolError } from "../../src/providers/transport.js";
import {
  ProviderWireInterceptorRegistry,
  type ProviderWireRequest,
  type ProviderWireResponse,
  type ProviderWireTransportHost,
} from "../../src/providers/wire.js";
import {
  OPENAI_CODEX_TRANSPORT_OBSERVER,
  type OpenAICodexObservabilityOptions,
  type OpenAICodexTransportObservation,
} from "../../src/providers/openai-codex-observability.js";
import { collect, fakeFetch, request, streamResponse, terminalCount } from "./helpers.js";

const WEBSOCKET_MAX_MESSAGE_BYTES = 16 * 1_024 * 1_024;

function sse(...values: unknown[]): Uint8Array[] {
  return values.map((value) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
}

async function codexRequestJson(request: Request): Promise<Record<string, unknown>> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const decoded = request.headers.get("content-encoding") === "zstd"
    ? zstdDecompressSync(bytes).toString("utf8")
    : new TextDecoder().decode(bytes);
  return JSON.parse(decoded) as Record<string, unknown>;
}

class FakeWebSocket extends EventTarget {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  closeCalls = 0;
  onSend?: (body: Record<string, unknown>) => void;

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  send(value: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    assert.equal(typeof value, "string");
    const body = JSON.parse(value as string) as Record<string, unknown>;
    this.sent.push(body);
    this.onSend?.(body);
  }

  message(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  rawMessage(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }

  fail(message: string): void {
    this.dispatchEvent(new ErrorEvent("error", { message }));
  }

  close(code = 1000, reason = "closed"): void {
    if (this.readyState === 3) return;
    this.closeCalls += 1;
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
  }
}

function socketFactory(factory: () => FakeWebSocket): NetworkWebSocketFactory {
  return ((_url: string | URL, _headers: HeadersInit) => {
    const socket = factory();
    queueMicrotask(() => socket.open());
    return socket as unknown as NetworkWebSocket;
  }) as NetworkWebSocketFactory;
}

function completed(socket: FakeWebSocket, id: string, text = "done", output?: unknown[]): void {
  queueMicrotask(() => {
    socket.message({ type: "response.created", response: { id, model: "gpt-5.5" } });
    if (text !== "") socket.message({ type: "response.output_text.delta", content_index: 0, delta: text });
    socket.message({
      type: "response.completed",
      response: {
        id,
        model: "gpt-5.5",
        ...(output === undefined ? {} : { output }),
        usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
      },
    });
  });
}

test("OpenAI Codex adapter ships an explicit current model catalog with a stable default", async () => {
  const models = openAICodexModels("2026-07-10T00:00:00.000Z");
  assert.notEqual(models.length, 0);
  assert.equal(models.some((model) => model.id === "gpt-5.5"), true);
  assert.equal(models.every((model) => model.provider === "openai-codex"), true);
  assert.equal(models.find((model) => model.id === "gpt-5.5")?.compatibility?.deferredTools?.value, "supported");
  assert.deepEqual(models.find((model) => model.id === "gpt-5.5")?.compatibility?.reasoningEfforts?.value, [
    "low", "medium", "high", "xhigh",
  ]);
  assert.deepEqual(models.find((model) => model.id === "gpt-5.6-luna")?.compatibility?.reasoningEfforts?.value, [
    "low", "medium", "high", "xhigh", "max",
  ]);
  assert.deepEqual(models.find((model) => model.id === "gpt-5.6-sol")?.compatibility?.reasoningEfforts?.value, [
    "low", "medium", "high", "xhigh", "max",
  ]);
  assert.equal(models.find((model) => model.id === "gpt-5.6-sol")?.contextTokens, 272_000);
  assert.equal(models.find((model) => model.id === "gpt-5.6-sol")?.maxOutputTokens, undefined);
  assert.deepEqual(models.find((model) => model.id === "gpt-5.6-terra")?.compatibility?.reasoningEfforts?.value, [
    "low", "medium", "high", "xhigh", "max",
  ]);
});

test("OpenAI Codex body separates instructions, uses account-compatible stateless Responses fields, and omits unsupported limits", () => {
  const input = request("openai-codex");
  input.maxOutputTokens = 1234;
  input.reasoningEffort = "minimal";
  input.sessionId = "session-123";
  input.messages.unshift({
    id: "system-1",
    role: "system",
    content: [{ type: "text", text: "Be exact." }],
    createdAt: "2026-07-10T00:00:00.000Z",
  });
  const body = buildOpenAICodexResponsesBody(input);
  assert.equal(body.instructions, "Be exact.");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.max_output_tokens, undefined);
  assert.deepEqual(body.reasoning, { effort: "low", summary: "auto" });
  assert.deepEqual(body.text, { verbosity: "low" });
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.parallel_tool_calls, true);
  assert.equal(body.prompt_cache_key, "session-123");
  assert.equal(body.prompt_cache_options, undefined);
  assert.equal(body.prompt_cache_retention, undefined);
  assert.equal(JSON.stringify(body.input).includes("Be exact."), false);
});

test("OpenAI Codex preserves an explicit disabled-reasoning request", () => {
  const input = request("openai-codex");
  input.reasoningEffort = "off";
  input.modelSettings = { reasoningEffortMap: { off: "off" } };
  assert.deepEqual(buildOpenAICodexResponsesBody(input).reasoning, { effort: "none", summary: "auto" });

  input.modelSettings = { reasoningEffortMap: { off: null } };
  assert.equal(buildOpenAICodexResponsesBody(input).reasoning, undefined);
});

test("OpenAI Codex preserves explicit per-call request options", () => {
  const input = request("openai-codex");
  input.temperature = 0.25;
  input.toolChoice = { type: "function", function: { name: "read" } };

  const body = buildOpenAICodexResponsesBody(input);
  assert.equal(body.temperature, 0.25);
  assert.deepEqual(body.tool_choice, { type: "function", name: "read" });
});

test("OpenAI Codex uses deferred tools only for a compatible model", () => {
  const input = request("openai-codex");
  input.model = "gpt-5.5";
  input.tools = [
    {
      name: "read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      loading: "eager",
    },
    {
      name: "issue_search",
      description: "Search issues",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      loading: "deferred",
    },
  ];

  const supported = buildOpenAICodexResponsesBody(input);
  assert.deepEqual((supported.tools as Array<Record<string, unknown>>).map((tool) => [
    tool.name ?? tool.type,
    tool.defer_loading,
  ]), [
    ["read", undefined],
    ["issue_search", true],
    ["tool_search", undefined],
  ]);

  const disabled = buildOpenAICodexResponsesBody({
    ...input,
    modelSettings: { compatibility: { supportsToolSearch: false } },
  });
  assert.equal((disabled.tools as Array<Record<string, unknown>>).some((tool) => tool.type === "tool_search"), false);
  assert.equal((disabled.tools as Array<Record<string, unknown>>).some((tool) => tool.defer_loading === true), false);
});

test("OpenAI Codex adapter sends isolated configured credentials and normalizes the Responses stream", async () => {
  let posted: Record<string, unknown> | undefined;
  let credentialCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => {
      credentialCalls += 1;
      return { accessToken: "subscription-access", accountId: "chatgpt-account" };
    },
    fetch: fakeFetch(async (incoming) => {
      assert.equal(incoming.url, "https://chatgpt.com/backend-api/codex/responses");
      assert.equal(incoming.headers.get("authorization"), "Bearer subscription-access");
      assert.equal(incoming.headers.get("chatgpt-account-id"), "chatgpt-account");
      assert.equal(incoming.headers.get("originator"), "rigyn");
      assert.equal(incoming.headers.get("openai-beta"), "responses=experimental");
      assert.equal(incoming.headers.get("x-codex-routing-hint"), "model=gpt-5.5");
      assert.equal(incoming.headers.get("session-id"), "session-codex");
      assert.equal(incoming.headers.get("x-client-request-id"), "session-codex");
      assert.equal(incoming.headers.get("content-encoding"), "zstd");
      posted = await codexRequestJson(incoming);
      return streamResponse(sse(
        { type: "response.created", response: { id: "codex-response", model: "gpt-5.5" } },
        { type: "response.output_text.delta", content_index: 0, delta: "done" },
        {
          type: "response.completed",
          response: {
            id: "codex-response",
            model: "gpt-5.5",
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              total_tokens: 12,
              input_tokens_details: { cached_tokens: 7, cache_write_tokens: 1 },
            },
          },
        },
      ));
    }),
  });
  const input = request("openai-codex");
  input.model = "gpt-5.5";
  input.sessionId = "session-codex";
  const events = await collect(adapter.stream(input, new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
  assert.deepEqual(events.find((event) => event.type === "usage"), {
    type: "usage",
    semantics: "final",
    usage: {
      raw: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
        input_tokens_details: { cached_tokens: 7, cache_write_tokens: 1 },
      },
      inputTokens: 2,
      outputTokens: 2,
      cacheReadTokens: 7,
      cacheWriteTokens: 1,
      totalTokens: 12,
    },
  });
  assert.equal(events.at(-1)?.type, "response_end");
  assert.equal(posted?.model, "gpt-5.5");
  assert.equal(credentialCalls, 1);

  const models = await adapter.listModels(new AbortController().signal);
  assert.notEqual(models.length, 0);
  assert.equal(new Set(models.map((model) => model.id)).size, models.length);
  assert.ok(models.some((model) => model.id === "gpt-5.5"));
  assert.equal(credentialCalls, 1, "the bundled model catalog must not make a credential or network request");
});

test("OpenAI Codex adapter defaults to cached WebSocket when a factory is available", async (t) => {
  let fetchCalls = 0;
  let webSocketCalls = 0;
  const socket = new FakeWebSocket();
  socket.onSend = () => queueMicrotask(() => socket.message({
    type: "response.completed",
    response: { id: "default-websocket", model: "gpt-5.5", output: [], usage: {} },
  }));
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      return streamResponse(sse(
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "default-sse" },
        { type: "response.completed", response: { id: "default-sse", model: "gpt-5.5", output: [], usage: {} } },
      ));
    }),
    webSocket: socketFactory(() => {
      webSocketCalls += 1;
      return socket;
    }),
  });
  t.after(() => adapter.dispose());

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));

  assert.equal(terminalCount(events), 1);
  assert.equal(fetchCalls, 0);
  assert.equal(webSocketCalls, 1);
  assert.equal(events.at(-1)?.type, "response_end");
});

test("OpenAI Codex cache opt-out omits stable affinity from SSE", async () => {
  let headers: Headers | undefined;
  let posted: Record<string, unknown> | undefined;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    headers: {
      "session-id": "configured-session",
      "x-client-request-id": "configured-session",
      "x-session-affinity": "configured-session",
    },
    fetch: fakeFetch(async (incoming) => {
      headers = incoming.headers;
      posted = await codexRequestJson(incoming);
      return streamResponse(sse({
        type: "response.completed",
        response: { id: "sse-none", model: "gpt-5.5", output: [] },
      }));
    }),
  });
  const input = request("openai-codex");
  input.sessionId = "session-none";
  input.cacheRetention = "none";
  const events = await collect(adapter.stream(input, new AbortController().signal));

  assert.equal(terminalCount(events), 1);
  assert.equal(headers?.get("session-id"), null);
  assert.equal(headers?.get("x-client-request-id"), null);
  assert.equal(headers?.get("x-session-affinity"), null);
  assert.equal(posted?.prompt_cache_key, undefined);
  assert.equal(posted?.previous_response_id, undefined);
});

test("OpenAI Codex adapter consumes informational Codex events without starting or warning", async () => {
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    fetch: fakeFetch(() => streamResponse(sse(
      {
        type: "codex.rate_limits",
        plan_type: "pro",
        rate_limits: { allowed: true, limit_reached: false },
      },
      {
        type: "codex.response.metadata",
        headers: { "x-codex-safety-buffering-enabled": "true" },
      },
      { type: "response.created", response: { id: "codex-response", model: "gpt-5.5" } },
      { type: "response.completed", response: { id: "codex-response", model: "gpt-5.5" } },
    ))),
  });

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));

  assert.equal(events.some((event) => event.type === "unknown_provider_event"), false);
  assert.deepEqual(events.find((event) => event.type === "response_start"), {
    type: "response_start",
    model: "gpt-5.5",
    responseId: "codex-response",
    diagnostics: { status: 200, headers: { "content-type": "text/event-stream" } },
  });
  assert.equal(terminalCount(events), 1);
});

test("OpenAI Codex WebSocket mode sends response.create without HTTP streaming fields", async (t) => {
  const socket = new FakeWebSocket();
  socket.onSend = () => completed(socket, "response-ws");
  let websocketUrl = "";
  let authorization = "";
  let beta = "";
  let routingHint = "";
  const baseFactory = socketFactory(() => socket);
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket",
    webSocket: ((url, headers) => {
      websocketUrl = String(url);
      const values = new Headers(headers);
      authorization = values.get("authorization") ?? "";
      beta = values.get("openai-beta") ?? "";
      routingHint = values.get("x-codex-routing-hint") ?? "";
      return baseFactory(url, headers);
    }) as NetworkWebSocketFactory,
  });
  t.after(() => adapter.dispose());
  const input = request("openai-codex");
  input.model = "gpt-5.5";
  input.sessionId = "session-websocket";
  const events = await collect(adapter.stream(input, new AbortController().signal));
  assert.equal(websocketUrl, "wss://chatgpt.com/backend-api/codex/responses");
  assert.equal(authorization, "Bearer subscription-access");
  assert.equal(beta, "responses_websockets=2026-02-06");
  assert.equal(routingHint, "model=gpt-5.5");
  assert.equal(socket.sent[0]?.type, "response.create");
  assert.equal(socket.sent[0]?.stream, undefined);
  assert.equal(socket.sent[0]?.background, undefined);
  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
  const end = events.find((event) => event.type === "response_end");
  assert.equal(end?.type === "response_end" ? end.state.kind === "openai_responses" && end.state.previousResponseId : undefined, "response-ws");
});

test("OpenAI Codex reads production WebSocket events and reuses cached continuation", async (t) => {
  const socket = new FakeWebSocket();
  const assistantOutput = {
    type: "message",
    id: "assistant-item",
    role: "assistant",
    content: [{ type: "output_text", text: "ready", annotations: [] }],
  };
  socket.onSend = () => queueMicrotask(() => {
    const first = socket.sent.length === 1;
    socket.dispatchEvent(new NetworkMessageEvent("message", {
      data: JSON.stringify({
        type: "response.completed",
        response: {
          id: first ? "network-response-one" : "network-response-two",
          model: "gpt-5.5",
          output: first ? [assistantOutput] : [],
          usage: {
            input_tokens: first ? 10 : 12,
            output_tokens: 2,
            total_tokens: first ? 12 : 14,
            input_tokens_details: {
              cached_tokens: first ? 7 : 9,
              cache_write_tokens: 1,
            },
          },
        },
      }),
    }));
  });
  let fetchCalls = 0;
  let factoryCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: socketFactory(() => { factoryCalls += 1; return socket; }),
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      return streamResponse(sse({
        type: "response.completed",
        response: { id: "unexpected-sse", model: "gpt-5.5", output: [], usage: {} },
      }));
    }),
  });
  t.after(() => adapter.dispose());

  const first = request("openai-codex");
  first.model = "gpt-5.5";
  first.sessionId = "production-events";
  const firstEvents = await collect(adapter.stream(first, new AbortController().signal));
  const firstEnd = firstEvents.find((event) => event.type === "response_end");
  const firstUsage = firstEvents.find((event) => event.type === "usage");
  assert.ok(firstEnd?.type === "response_end");
  assert.equal(firstUsage?.type === "usage" ? firstUsage.usage.cacheReadTokens : undefined, 7);

  const second: ProviderRequest = {
    ...first,
    providerState: firstEnd.state,
    messages: [
      ...first.messages,
      { id: "assistant-1", role: "assistant", content: [{ type: "text", text: "ready" }], createdAt: "2026-07-10T00:00:01.000Z" },
      { id: "user-2", role: "user", content: [{ type: "text", text: "continue" }], createdAt: "2026-07-10T00:00:02.000Z" },
    ],
  };
  const secondEvents = await collect(adapter.stream(second, new AbortController().signal));
  const secondUsage = secondEvents.find((event) => event.type === "usage");

  assert.equal(fetchCalls, 0);
  assert.equal(factoryCalls, 1);
  assert.equal(socket.sent[1]?.previous_response_id, "network-response-one");
  assert.deepEqual(socket.sent[1]?.input, [{ role: "user", content: "continue" }]);
  assert.equal(secondUsage?.type === "usage" ? secondUsage.usage.cacheReadTokens : undefined, 9);
  assert.equal(terminalCount(secondEvents), 1);
});

test("OpenAI Codex reads production WebSocket error and close diagnostics", async (t) => {
  const run = async (...dispatched: Event[]): Promise<{
    message: string | undefined;
    providerCode: string | undefined;
    observations: OpenAICodexTransportObservation[];
  }> => {
    const socket = new FakeWebSocket();
    socket.onSend = () => queueMicrotask(() => {
      for (const event of dispatched) socket.dispatchEvent(event);
    });
    const observations: OpenAICodexTransportObservation[] = [];
    const config: OpenAICodexResponsesConfig & OpenAICodexObservabilityOptions = {
      credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
      transport: "websocket",
      webSocket: socketFactory(() => socket),
      [OPENAI_CODEX_TRANSPORT_OBSERVER]: (observation) => observations.push(observation),
    };
    const adapter = new OpenAICodexResponsesAdapter(config);
    try {
      const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));
      const terminal = events.at(-1);
      return {
        message: terminal?.type === "error" ? terminal.error.message : undefined,
        providerCode: terminal?.type === "error" ? terminal.error.providerCode : undefined,
        observations,
      };
    } finally {
      adapter.dispose();
    }
  };

  await t.test("error", async () => {
    const result = await run(new NetworkErrorEvent("error", { message: "PRIVATE_NETWORK_EVENT_FAILURE" }));
    assert.equal(result.message, "openai-codex: OpenAI Codex WebSocket failed");
    assert.doesNotMatch(result.message ?? "", /PRIVATE_NETWORK_EVENT_FAILURE/u);
    assert.deepEqual(result.observations.at(-1), {
      type: "websocket_failed",
      failureClass: "network",
      partialOutput: false,
    });
  });

  await t.test("close", async () => {
    const result = await run(new NetworkCloseEvent("close", {
      code: 1011,
      reason: "PRIVATE_CLOSE_REASON",
      wasClean: false,
    }));
    assert.match(result.message ?? "", /1011.*server error/u);
    assert.match(result.message ?? "", /reason [a-f0-9]{12}/u);
    assert.equal(result.providerCode, "WS_CLOSE_1011");
    assert.doesNotMatch(result.message ?? "", /PRIVATE_CLOSE_REASON/u);
    assert.deepEqual(result.observations.at(-1), {
      type: "websocket_failed",
      failureClass: "close",
      closeCode: 1011,
      partialOutput: false,
    });
  });

  await t.test("Undici error then abnormal close keeps the nested code and close diagnostic", async () => {
    const transportCause = Object.assign(new Error("PRIVATE_SOCKET_DETAIL"), { code: "UND_ERR_SOCKET" });
    const result = await run(
      new NetworkErrorEvent("error", { message: "terminated", error: transportCause }),
      new NetworkCloseEvent("close", { code: 1006, reason: "", wasClean: false }),
    );
    assert.equal(result.providerCode, "UND_ERR_SOCKET");
    assert.match(result.message ?? "", /1006.*abnormal closure/u);
    assert.doesNotMatch(result.message ?? "", /PRIVATE_SOCKET_DETAIL|terminated/u);
    assert.deepEqual(result.observations.at(-1), {
      type: "websocket_failed",
      failureClass: "close",
      closeCode: 1006,
      transportCode: "UND_ERR_SOCKET",
      partialOutput: false,
    });
  });

  await t.test("unapproved socket codes never enter provider or transport diagnostics", async () => {
    const transportCause = Object.assign(new Error("PRIVATE_SOCKET_DETAIL"), { code: "PRIVATE_SOCKET_CODE" });
    const result = await run(new NetworkErrorEvent("error", { message: "terminated", error: transportCause }));
    assert.equal(result.providerCode, undefined);
    assert.deepEqual(result.observations.at(-1), {
      type: "websocket_failed",
      failureClass: "network",
      partialOutput: false,
    });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SOCKET_DETAIL|PRIVATE_SOCKET_CODE|terminated/u);
  });
});

test("OpenAI Codex uses one bounded affinity value in the request body and WebSocket handshake", async (t) => {
  const socket = new FakeWebSocket();
  socket.onSend = () => completed(socket, "bounded-affinity", "");
  let handshake: Headers | undefined;
  const baseFactory = socketFactory(() => socket);
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket",
    webSocket: ((url, headers) => {
      handshake = new Headers(headers);
      return baseFactory(url, headers);
    }) as NetworkWebSocketFactory,
  });
  t.after(() => adapter.dispose());
  const input = request("openai-codex");
  input.sessionId = `session-${"🙂".repeat(80)}`;

  const events = await collect(adapter.stream(input, new AbortController().signal));

  assert.equal(terminalCount(events), 1);
  const affinity = socket.sent[0]?.prompt_cache_key;
  assert.equal(typeof affinity, "string");
  assert.equal(Array.from(affinity as string).length <= 64, true);
  assert.notEqual(affinity, input.sessionId);
  assert.equal(handshake?.get("session-id"), affinity);
  assert.equal(handshake?.get("session_id"), affinity);
  assert.equal(handshake?.get("x-client-request-id"), affinity);
});

test("OpenAI Codex accepts response.done as a successful WebSocket terminal event", async (t) => {
  const socket = new FakeWebSocket();
  socket.onSend = () => queueMicrotask(() => socket.message({
    type: "response.done",
    response: {
      id: "response-done",
      model: "gpt-5.5",
      output: [],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    },
  }));
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket",
    webSocket: socketFactory(() => socket),
  });
  t.after(() => adapter.dispose());

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));

  assert.equal(terminalCount(events), 1);
  assert.equal(events.at(-1)?.type, "response_end");
});

test("cached Codex WebSockets do not continue non-completed response.done outcomes", async (t) => {
  await t.test("incomplete", async (t) => {
    const socket = new FakeWebSocket();
    const toolCall = {
      type: "function_call",
      id: "inspect-item",
      call_id: "inspect-call",
      name: "read",
      arguments: "{\"path\":\"README.md\"}",
    };
    socket.onSend = () => queueMicrotask(() => socket.message({
      type: "response.done",
      response: {
        id: socket.sent.length === 1 ? "response-incomplete" : "response-next",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: socket.sent.length === 1 ? [toolCall] : [],
      },
    }));
    let factoryCalls = 0;
    const adapter = new OpenAICodexResponsesAdapter({
      credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
      transport: "websocket-cached",
      webSocket: socketFactory(() => { factoryCalls += 1; return socket; }),
    });
    t.after(() => adapter.dispose());

    const first = request("openai-codex");
    first.model = "gpt-5.5";
    first.sessionId = "incomplete-done";
    const firstEvents = await collect(adapter.stream(first, new AbortController().signal));
    const firstEnd = firstEvents.find((event) => event.type === "response_end");
    assert.ok(firstEnd?.type === "response_end");
    assert.equal(firstEnd.reason, "length");

    const second: ProviderRequest = {
      ...first,
      providerState: firstEnd.state,
      messages: [
        ...first.messages,
        {
          id: "assistant-1",
          role: "assistant",
          content: [{ type: "tool_call", callId: "inspect-call", name: "read", arguments: { path: "README.md" } }],
          createdAt: "2026-07-10T00:00:01.000Z",
        },
        { id: "user-2", role: "user", content: [{ type: "text", text: "continue" }], createdAt: "2026-07-10T00:00:02.000Z" },
      ],
    };
    await collect(adapter.stream(second, new AbortController().signal));

    assert.equal(factoryCalls, 1);
    assert.equal(socket.sent[1]?.previous_response_id, undefined);
    assert.equal(Array.isArray(socket.sent[1]?.input) && (socket.sent[1]?.input as unknown[]).length > 1, true);
  });

  for (const status of ["failed", "cancelled"] as const) {
    await t.test(status, async (t) => {
      const sockets: FakeWebSocket[] = [];
      const adapter = new OpenAICodexResponsesAdapter({
        credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
        transport: "websocket-cached",
        webSocket: socketFactory(() => {
          const socket = new FakeWebSocket();
          socket.onSend = () => queueMicrotask(() => socket.message({
            type: "response.done",
            response: { id: `${status}-${sockets.length}`, status },
          }));
          sockets.push(socket);
          return socket;
        }),
      });
      t.after(() => adapter.dispose());
      const input = request("openai-codex");
      input.sessionId = `done-${status}`;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const events = await collect(adapter.stream(input, new AbortController().signal));
        assert.equal(events.at(-1)?.type, "error");
      }
      assert.equal(sockets.length, 2);
      assert.equal(sockets.every((socket) => socket.closeCalls === 1), true);
      assert.equal(sockets.some((socket) => socket.sent.some((body) => body.previous_response_id !== undefined)), false);
    });
  }
});

test("OpenAI Codex WebSocket traffic uses redacted wire hooks for handshakes, frames, and diagnostics", async (t) => {
  const socket = new FakeWebSocket();
  socket.onSend = () => completed(socket, "response-wire", "patched");
  const requests: ProviderWireRequest[] = [];
  const responses: ProviderWireResponse[] = [];
  const wire = new ProviderWireInterceptorRegistry();
  wire.register("openai-codex", {
    interceptRequest(observed) {
      requests.push(observed);
      assert.equal(observed.headers.authorization, undefined);
      assert.equal(observed.headers["chatgpt-account-id"], undefined);
      if (observed.phase === "handshake") return { headers: { "x-wire-handshake": "enabled" } };
      if (observed.phase === "frame") {
        return { body: { ...(observed.body as Record<string, unknown>), instructions: "wire-patched" } };
      }
    },
    observeResponse(observed) {
      responses.push(observed);
    },
  });
  let handshakeHeaders: Headers | undefined;
  const baseFactory = socketFactory(() => socket);
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket",
    webSocket: ((url, headers) => {
      handshakeHeaders = new Headers(headers);
      return baseFactory(url, headers);
    }) as NetworkWebSocketFactory,
    wire,
  });
  t.after(() => adapter.dispose());

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));

  assert.deepEqual(requests.map(({ transport, phase }) => [transport, phase]), [
    ["websocket", "handshake"],
    ["websocket", "frame"],
  ]);
  assert.equal(handshakeHeaders?.get("authorization"), "Bearer subscription-access");
  assert.equal(handshakeHeaders?.get("x-wire-handshake"), "enabled");
  assert.equal(socket.sent[0]?.instructions, "wire-patched");
  assert.equal(responses[0]?.phase, "open");
  assert.deepEqual(
    responses.filter((response) => response.phase === "frame").map((response) => response.frame?.type),
    ["response.created", "response.output_text.delta", "response.completed"],
  );
  assert.equal(responses.every((response) => response.status === 101), true);
  assert.equal(responses.every((response) => response.transport === "websocket"), true);
  assert.equal(responses.filter((response) => response.phase === "frame").every((response) => (response.frame?.bytes ?? 0) > 0), true);
  const start = events.find((event) => event.type === "response_start");
  assert.deepEqual(start?.type === "response_start" ? start.diagnostics : undefined, { status: 101, headers: {} });
});

test("OpenAI Codex WebSocket frame hooks cannot mutate established handshake headers", async (t) => {
  const socket = new FakeWebSocket();
  const wire = new ProviderWireInterceptorRegistry();
  wire.register("openai-codex", {
    interceptRequest(observed) {
      if (observed.phase === "frame") return { headers: { "x-too-late": "true" } };
    },
  });
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket",
    webSocket: socketFactory(() => socket),
    wire,
  });
  t.after(() => adapter.dispose());

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));

  assert.equal(socket.sent.length, 0);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  assert.match(terminal?.type === "error" ? terminal.error.message : "", /cannot modify handshake headers/u);
});

test("automatic Codex transport surfaces frame interceptor errors without changing transports", async (t) => {
  const socket = new FakeWebSocket();
  const wire = new ProviderWireInterceptorRegistry();
  wire.register("openai-codex", {
    interceptRequest(observed) {
      if (observed.phase === "frame") return { headers: { "x-too-late": "true" } };
    },
  });
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: socketFactory(() => socket),
    wire,
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      throw new Error("interceptor failures must not change transports");
    }),
  });
  t.after(() => adapter.dispose());

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));

  assert.equal(fetchCalls, 0);
  assert.equal(socket.sent.length, 0);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  assert.match(terminal?.type === "error" ? terminal.error.message : "", /cannot modify handshake headers/u);
});

test("automatic Codex transport never replays a handshake-hook failure", async (t) => {
  const wire = new ProviderWireInterceptorRegistry();
  wire.register("openai-codex", {
    interceptRequest(observed) {
      if (observed.phase === "handshake") throw new ProtocolError("host handshake failed");
    },
  });
  let webSocketCalls = 0;
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: (() => {
      webSocketCalls += 1;
      return new FakeWebSocket() as unknown as NetworkWebSocket;
    }) as NetworkWebSocketFactory,
    wire,
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      return streamResponse(sse({
        type: "response.completed",
        response: { id: "unsafe-replay", model: "gpt-5.5", output: [], usage: {} },
      }));
    }),
  });
  t.after(() => adapter.dispose());

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));

  assert.equal(webSocketCalls, 0);
  assert.equal(fetchCalls, 0);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  assert.match(terminal?.type === "error" ? terminal.error.message : "", /host handshake failed/u);
});

test("automatic Codex transport never replays a throwing wire-operation accessor", async (t) => {
  const wire = {
    wrapFetch(_provider, fetchImplementation) {
      return fetchImplementation;
    },
    begin() {
      return {
        get active(): boolean { throw new ProtocolError("wire active failed"); },
        async intercept() { throw new Error("unreachable intercept"); },
        async observe() { throw new Error("unreachable observe"); },
      };
    },
  } satisfies ProviderWireTransportHost;
  let webSocketCalls = 0;
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: (() => {
      webSocketCalls += 1;
      return new FakeWebSocket() as unknown as NetworkWebSocket;
    }) as NetworkWebSocketFactory,
    wire,
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      return streamResponse(sse({
        type: "response.completed",
        response: { id: "unsafe-replay", model: "gpt-5.5", output: [], usage: {} },
      }));
    }),
  });
  t.after(() => adapter.dispose());

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));

  assert.equal(webSocketCalls, 0);
  assert.equal(fetchCalls, 0);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  assert.match(terminal?.type === "error" ? terminal.error.message : "", /wire active failed/u);
});

test("automatic Codex transport contains a hostile value thrown by a wire host", async (t) => {
  const hostile = new Proxy({}, {
    get() { throw new Error("reflected-host-value"); },
    getPrototypeOf() { throw new Error("reflected-host-value"); },
  });
  const wire = {
    wrapFetch(_provider, fetchImplementation) {
      return fetchImplementation;
    },
    begin() {
      return {
        get active(): boolean { throw hostile; },
        async intercept() { throw new Error("unreachable intercept"); },
        async observe() { throw new Error("unreachable observe"); },
      };
    },
  } satisfies ProviderWireTransportHost;
  let webSocketCalls = 0;
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: (() => {
      webSocketCalls += 1;
      return new FakeWebSocket() as unknown as NetworkWebSocket;
    }) as NetworkWebSocketFactory,
    wire,
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      throw new Error("host failures must not change transports");
    }),
  });
  t.after(() => adapter.dispose());

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));

  assert.equal(webSocketCalls, 0);
  assert.equal(fetchCalls, 0);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  assert.doesNotMatch(terminal?.type === "error" ? terminal.error.message : "", /reflected-host-value/u);
});

test("automatic Codex transport snapshots prepared wire state inside the host boundary", async (t) => {
  const socket = new FakeWebSocket();
  let beginCalls = 0;
  const wire = {
    wrapFetch(_provider, fetchImplementation) {
      return fetchImplementation;
    },
    begin() {
      beginCalls += 1;
      if (beginCalls === 1) {
        return {
          active: false,
          async intercept() { throw new Error("inactive operation"); },
          async observe() { throw new Error("inactive operation"); },
        };
      }
      return {
        active: true,
        async intercept(observed) {
          return {
            url: observed.url,
            headers: observed.headers,
            ...(observed.body === undefined ? {} : { body: observed.body }),
            bodyChanged: false,
            get headersChanged(): boolean { throw new ProtocolError("prepared state failed"); },
            urlChanged: false,
          };
        },
        async observe() {},
      };
    },
  } satisfies ProviderWireTransportHost;
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: socketFactory(() => socket),
    wire,
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      return streamResponse(sse({
        type: "response.completed",
        response: { id: "unsafe-replay", model: "gpt-5.5", output: [], usage: {} },
      }));
    }),
  });
  t.after(() => adapter.dispose());

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));

  assert.equal(fetchCalls, 0);
  assert.equal(socket.closeCalls, 1);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  assert.match(terminal?.type === "error" ? terminal.error.message : "", /prepared state failed/u);
});

test("Codex handshake termination after wire begin never enters intercept", async (suite) => {
  for (const scenario of ["dispose", "abort"] as const) {
    await suite.test(scenario, async () => {
      const controller = new AbortController();
      let adapter!: OpenAICodexResponsesAdapter;
      let interceptCalls = 0;
      let webSocketCalls = 0;
      const wire = {
        wrapFetch(_provider, fetchImplementation) {
          return fetchImplementation;
        },
        begin() {
          queueMicrotask(() => {
            if (scenario === "dispose") adapter.dispose();
            else controller.abort();
          });
          return {
            active: true,
            async intercept(observed) {
              interceptCalls += 1;
              return {
                url: observed.url,
                headers: observed.headers,
                bodyChanged: false,
                headersChanged: false,
                urlChanged: false,
              };
            },
            async observe() {},
          };
        },
      } satisfies ProviderWireTransportHost;
      adapter = new OpenAICodexResponsesAdapter({
        credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
        transport: "auto",
        webSocket: (() => {
          webSocketCalls += 1;
          return new FakeWebSocket() as unknown as NetworkWebSocket;
        }) as NetworkWebSocketFactory,
        wire,
      });

      const events = await collect(adapter.stream(request("openai-codex"), controller.signal));

      assert.equal(interceptCalls, 0);
      assert.equal(webSocketCalls, 0);
      assert.equal(events.at(-1)?.type, "error");
      adapter.dispose();
    });
  }
});

test("automatic Codex transport never replays a frame-observer failure", async (t) => {
  const socket = new FakeWebSocket();
  socket.onSend = () => queueMicrotask(() => {
    socket.message({ type: "response.created", response: { id: "observed", model: "gpt-5.5" } });
    socket.message({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "generated" });
  });
  const wire = new ProviderWireInterceptorRegistry();
  wire.register("openai-codex", {
    observeResponse(observed) {
      if (observed.phase === "frame" && observed.frame?.type === "response.output_text.delta") {
        throw new ProtocolError("host observer failed");
      }
    },
  });
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: socketFactory(() => socket),
    wire,
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      return streamResponse(sse({
        type: "response.completed",
        response: { id: "unsafe-replay", model: "gpt-5.5", output: [], usage: {} },
      }));
    }),
  });
  t.after(() => adapter.dispose());

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));

  assert.equal(fetchCalls, 0);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  assert.match(terminal?.type === "error" ? terminal.error.message : "", /host observer failed/u);
});

test("a throwing Codex wire host releases the acquired WebSocket", async (t) => {
  const socket = new FakeWebSocket();
  let beginCalls = 0;
  const wire = {
    wrapFetch(_provider, fetchImplementation) {
      return fetchImplementation;
    },
    begin() {
      beginCalls += 1;
      if (beginCalls === 1) {
        return {
          active: false,
          async intercept() { throw new Error("inactive operation"); },
          async observe() { throw new Error("inactive operation"); },
        };
      }
      throw new ProtocolError("wire begin failed");
    },
  } satisfies ProviderWireTransportHost;
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: socketFactory(() => socket),
    wire,
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      throw new Error("wire host failures must not change transports");
    }),
  });
  t.after(() => adapter.dispose());

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));

  assert.equal(fetchCalls, 0);
  assert.equal(socket.closeCalls, 1);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  assert.match(terminal?.type === "error" ? terminal.error.message : "", /wire begin failed/u);
});

test("cached Codex WebSocket continuation reuses one socket and sends only appended tool and user input", async (t) => {
  const socket = new FakeWebSocket();
  const toolCall = {
    type: "function_call",
    id: "inspect-item",
    call_id: "inspect-call",
    name: "read",
    arguments: "{\"path\":\"README.md\"}",
  };
  socket.onSend = () => completed(
    socket,
    socket.sent.length === 1 ? "response-one" : "response-two",
    "",
    socket.sent.length === 1 ? [toolCall] : [],
  );
  let factoryCalls = 0;
  const wirePhases: Array<ProviderWireRequest["phase"]> = [];
  let opened = 0;
  const wire = new ProviderWireInterceptorRegistry();
  wire.register("openai-codex", {
    interceptRequest(observed) {
      wirePhases.push(observed.phase);
    },
    observeResponse(observed) {
      if (observed.phase === "open") opened += 1;
    },
  });
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket-cached",
    webSocket: socketFactory(() => {
      factoryCalls += 1;
      return socket;
    }),
    wire,
  });
  t.after(() => adapter.dispose());

  const first = request("openai-codex");
  first.model = "gpt-5.5";
  first.sessionId = "session-cached";
  const firstEvents = await collect(adapter.stream(first, new AbortController().signal));
  const firstEnd = firstEvents.find((event) => event.type === "response_end");
  assert.ok(firstEnd?.type === "response_end");

  const second: ProviderRequest = {
    ...first,
    providerState: firstEnd.state as ProviderState,
    messages: [
      ...first.messages,
      {
        id: "assistant-1",
        role: "assistant",
        content: [{ type: "tool_call", callId: "inspect-call", name: "read", arguments: { path: "README.md" } }],
        createdAt: "2026-07-10T00:00:01.000Z",
      },
      {
        id: "tool-1",
        role: "tool",
        content: [{
          type: "tool_result",
          callId: "inspect-call",
          name: "read",
          content: "observed",
          isError: false,
        }],
        createdAt: "2026-07-10T00:00:02.000Z",
      },
      { id: "user-2", role: "user", content: [{ type: "text", text: "continue" }], createdAt: "2026-07-10T00:00:03.000Z" },
    ],
  };
  const secondEvents = await collect(adapter.stream(second, new AbortController().signal));
  assert.equal(terminalCount(secondEvents), 1);
  assert.equal(factoryCalls, 1);
  assert.deepEqual(wirePhases, ["handshake", "frame", "handshake", "frame"]);
  assert.equal(opened, 2);
  assert.equal(socket.sent[1]?.previous_response_id, "response-one");
  assert.deepEqual(socket.sent[1]?.input, [
    { type: "function_call_output", call_id: "inspect-call", output: "observed" },
    { role: "user", content: "continue" },
  ]);
});

test("cached Codex continuation retains streamed output when the terminal event omits its output array", async (t) => {
  const socket = new FakeWebSocket();
  const assistantOutput = {
    type: "message",
    id: "assistant-item",
    role: "assistant",
    content: [{ type: "output_text", text: "ready", annotations: [] }],
  };
  socket.onSend = () => {
    if (socket.sent.length > 1) {
      completed(socket, "response-two", "", []);
      return;
    }
    queueMicrotask(() => {
      socket.message({ type: "response.created", response: { id: "response-one", model: "gpt-5.5" } });
      socket.message({ type: "response.output_item.done", output_index: 0, item: assistantOutput });
      socket.message({
        type: "response.completed",
        response: { id: "response-one", model: "gpt-5.5", usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } },
      });
    });
  };
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket-cached",
    webSocket: socketFactory(() => socket),
  });
  t.after(() => adapter.dispose());

  const first = request("openai-codex");
  first.model = "gpt-5.5";
  first.sessionId = "streamed-output";
  const firstEvents = await collect(adapter.stream(first, new AbortController().signal));
  const firstEnd = firstEvents.find((event) => event.type === "response_end");
  assert.ok(firstEnd?.type === "response_end");
  const second: ProviderRequest = {
    ...first,
    providerState: firstEnd.state,
    messages: [
      ...first.messages,
      { id: "assistant-1", role: "assistant", content: [{ type: "text", text: "ready" }], createdAt: "2026-07-10T00:00:01.000Z" },
      { id: "user-2", role: "user", content: [{ type: "text", text: "continue" }], createdAt: "2026-07-10T00:00:02.000Z" },
    ],
  };

  const secondEvents = await collect(adapter.stream(second, new AbortController().signal));

  assert.equal(terminalCount(secondEvents), 1);
  assert.equal(socket.sent[1]?.previous_response_id, "response-one");
  assert.deepEqual(socket.sent[1]?.input, [{ role: "user", content: "continue" }]);
});

test("cached Codex WebSockets isolate authenticated connections within one session", async (t) => {
  const sockets: FakeWebSocket[] = [];
  const handshakes: Headers[] = [];
  const credentials = [
    { accessToken: "subscription-a", accountId: "account-a" },
    { accessToken: "subscription-b", accountId: "account-b" },
    { accessToken: "subscription-a", accountId: "account-a" },
  ];
  const assistantOutput = {
    type: "message",
    id: "assistant-item",
    role: "assistant",
    content: [{ type: "output_text", text: "ready", annotations: [] }],
  };
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => credentials.shift()!,
    transport: "websocket-cached",
    webSocket: ((_: string | URL, headers: HeadersInit) => {
      handshakes.push(new Headers(headers));
      const socket = new FakeWebSocket();
      socket.onSend = () => completed(socket, `response-${sockets.length}`, "", [assistantOutput]);
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket as unknown as NetworkWebSocket;
    }) as NetworkWebSocketFactory,
  });
  t.after(() => adapter.dispose());

  const first = request("openai-codex");
  first.model = "gpt-5.5";
  first.sessionId = "shared-session";
  const firstEvents = await collect(adapter.stream(first, new AbortController().signal));
  const firstEnd = firstEvents.find((event) => event.type === "response_end");
  assert.ok(firstEnd?.type === "response_end");
  const second: ProviderRequest = {
    ...first,
    providerState: firstEnd.state,
    messages: [
      ...first.messages,
      { id: "assistant-1", role: "assistant", content: [{ type: "text", text: "ready" }], createdAt: "2026-07-10T00:00:01.000Z" },
      { id: "user-2", role: "user", content: [{ type: "text", text: "continue" }], createdAt: "2026-07-10T00:00:02.000Z" },
    ],
  };

  const secondEvents = await collect(adapter.stream(second, new AbortController().signal));
  const thirdEvents = await collect(adapter.stream(first, new AbortController().signal));

  assert.equal(terminalCount(secondEvents), 1);
  assert.equal(terminalCount(thirdEvents), 1);
  assert.equal(sockets.length, 2);
  assert.deepEqual(handshakes.map((headers) => headers.get("chatgpt-account-id")), ["account-a", "account-b"]);
  assert.equal(sockets[0]?.sent.length, 2);
  assert.equal(sockets[1]?.sent.length, 1);
  assert.equal(sockets[1]?.sent[0]?.previous_response_id, undefined);
});

test("automatic Codex session fallback is isolated by account within one session", async (t) => {
  const failed = new FakeWebSocket();
  failed.onSend = () => queueMicrotask(() => failed.close(1011, "upstream failed"));
  const healthy = new FakeWebSocket();
  healthy.onSend = () => completed(healthy, "healthy-account", "websocket");
  const sockets = [failed, healthy];
  const credentials = [
    { accessToken: "subscription-a", accountId: "account-a" },
    { accessToken: "subscription-b", accountId: "account-b" },
    { accessToken: "subscription-a", accountId: "account-a" },
  ];
  let webSocketCalls = 0;
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => credentials.shift()!,
    transport: "auto",
    webSocket: socketFactory(() => {
      webSocketCalls += 1;
      return sockets.shift()!;
    }),
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      return streamResponse(sse({
        type: "response.completed",
        response: { id: `sse-${fetchCalls}`, model: "gpt-5.5", output: [], usage: {} },
      }));
    }),
  });
  t.after(() => adapter.dispose());

  const input = request("openai-codex");
  input.sessionId = "shared-fallback-session";
  const first = await collect(adapter.stream(input, new AbortController().signal));
  const second = await collect(adapter.stream(input, new AbortController().signal));
  const third = await collect(adapter.stream(input, new AbortController().signal));

  assert.equal(terminalCount(first), 1);
  assert.equal(terminalCount(second), 1);
  assert.equal(second.some((event) => event.type === "text_delta" && event.text === "websocket"), true);
  assert.equal(terminalCount(third), 1);
  assert.equal(webSocketCalls, 2, "the healthy account must not inherit another account's fallback");
  assert.equal(fetchCalls, 2, "the failed account must retain its own fallback");
});

test("cached Codex WebSockets key reuse on the effective intercepted handshake", async (t) => {
  const sockets: FakeWebSocket[] = [];
  const handshakes: Array<{ url: string; headers: Headers }> = [];
  let handshakeCount = 0;
  const wire = new ProviderWireInterceptorRegistry();
  wire.register("openai-codex", {
    interceptRequest(observed) {
      if (observed.phase !== "handshake") return;
      handshakeCount += 1;
      return handshakeCount === 1
        ? { headers: { "x-route-generation": "first" } }
        : {
            url: "wss://alternate.example.test/codex/responses",
            headers: { "x-route-generation": "second" },
          };
    },
  });
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket-cached",
    wire,
    webSocket: ((url: string | URL, headers: HeadersInit) => {
      handshakes.push({ url: String(url), headers: new Headers(headers) });
      const socket = new FakeWebSocket();
      socket.onSend = () => completed(socket, `response-${sockets.length + 1}`, "", []);
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket as unknown as NetworkWebSocket;
    }) as NetworkWebSocketFactory,
  });
  t.after(() => adapter.dispose());
  const first = request("openai-codex");
  first.model = "gpt-5.5";
  first.sessionId = "effective-handshake";
  const firstEvents = await collect(adapter.stream(first, new AbortController().signal));
  const firstEnd = firstEvents.find((event) => event.type === "response_end");
  assert.ok(firstEnd?.type === "response_end");

  const second: ProviderRequest = {
    ...first,
    providerState: firstEnd.state,
    messages: [
      ...first.messages,
      { id: "assistant-1", role: "assistant", content: [{ type: "text", text: "ready" }], createdAt: "2026-07-10T00:00:01.000Z" },
      { id: "user-2", role: "user", content: [{ type: "text", text: "continue" }], createdAt: "2026-07-10T00:00:02.000Z" },
    ],
  };
  const secondEvents = await collect(adapter.stream(second, new AbortController().signal));

  assert.equal(terminalCount(secondEvents), 1);
  assert.equal(sockets.length, 2);
  assert.deepEqual(handshakes.map((entry) => entry.url), [
    "wss://chatgpt.com/backend-api/codex/responses",
    "wss://alternate.example.test/codex/responses",
  ]);
  assert.deepEqual(handshakes.map((entry) => entry.headers.get("x-route-generation")), ["first", "second"]);
  assert.equal(sockets[1]?.sent[0]?.previous_response_id, undefined);
});

test("cached Codex continuation falls back to full context when request settings change", async (t) => {
  const socket = new FakeWebSocket();
  const assistantOutput = {
    type: "message",
    id: "assistant-item",
    role: "assistant",
    content: [{ type: "output_text", text: "ready", annotations: [] }],
  };
  socket.onSend = () => completed(socket, `response-${socket.sent.length}`, "", [assistantOutput]);
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket-cached",
    webSocket: socketFactory(() => socket),
  });
  t.after(() => adapter.dispose());

  const first = request("openai-codex");
  first.model = "gpt-5.5";
  first.sessionId = "settings-change";
  const firstEvents = await collect(adapter.stream(first, new AbortController().signal));
  const firstEnd = firstEvents.find((event) => event.type === "response_end");
  assert.ok(firstEnd?.type === "response_end");
  const second: ProviderRequest = {
    ...first,
    model: "gpt-5.6-sol",
    providerState: firstEnd.state,
    messages: [
      ...first.messages,
      { id: "assistant-1", role: "assistant", content: [{ type: "text", text: "ready" }], createdAt: "2026-07-10T00:00:01.000Z" },
      { id: "user-2", role: "user", content: [{ type: "text", text: "continue" }], createdAt: "2026-07-10T00:00:02.000Z" },
    ],
  };

  const secondEvents = await collect(adapter.stream(second, new AbortController().signal));

  assert.equal(terminalCount(secondEvents), 1);
  assert.equal(socket.sent.length, 2);
  assert.equal(socket.sent[1]?.previous_response_id, undefined);
  assert.equal(socket.sent[1]?.model, "gpt-5.6-sol");
  assert.equal(Array.isArray(socket.sent[1]?.input) ? socket.sent[1].input.length : 0, 3);
});

test("cached Codex continuation falls back to full context when the prior input prefix changes", async (t) => {
  const socket = new FakeWebSocket();
  const assistantOutput = {
    type: "message",
    id: "assistant-item",
    role: "assistant",
    content: [{ type: "output_text", text: "ready", annotations: [] }],
  };
  socket.onSend = () => completed(socket, `response-${socket.sent.length}`, "", [assistantOutput]);
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket-cached",
    webSocket: socketFactory(() => socket),
  });
  t.after(() => adapter.dispose());

  const first = request("openai-codex");
  first.model = "gpt-5.5";
  first.sessionId = "prefix-change";
  const firstEvents = await collect(adapter.stream(first, new AbortController().signal));
  const firstEnd = firstEvents.find((event) => event.type === "response_end");
  assert.ok(firstEnd?.type === "response_end");
  const second: ProviderRequest = {
    ...first,
    providerState: firstEnd.state,
    messages: [
      {
        ...first.messages[0]!,
        content: [{ type: "text", text: "changed earlier input" }],
      },
      { id: "assistant-1", role: "assistant", content: [{ type: "text", text: "ready" }], createdAt: "2026-07-10T00:00:01.000Z" },
      { id: "user-2", role: "user", content: [{ type: "text", text: "continue" }], createdAt: "2026-07-10T00:00:02.000Z" },
    ],
  };

  const secondEvents = await collect(adapter.stream(second, new AbortController().signal));

  assert.equal(terminalCount(secondEvents), 1);
  assert.equal(socket.sent.length, 2);
  assert.equal(socket.sent[1]?.previous_response_id, undefined);
  assert.match(JSON.stringify(socket.sent[1]?.input), /changed earlier input/u);
});

test("cached Codex WebSocket retries one missing continuation with full context", async (t) => {
  const firstSocket = new FakeWebSocket();
  firstSocket.onSend = (body) => {
    if (body.previous_response_id === undefined) {
      completed(firstSocket, "response-one", "", [{
        type: "message",
        id: "assistant-item",
        role: "assistant",
        content: [{ type: "output_text", text: "ready", annotations: [] }],
      }]);
      return;
    }
    queueMicrotask(() => firstSocket.message({
      type: "error",
      error: { code: "previous_response_not_found", message: "continuation expired" },
    }));
  };
  const retrySocket = new FakeWebSocket();
  retrySocket.onSend = () => completed(retrySocket, "response-recovered", "recovered");
  const sockets = [firstSocket, retrySocket];
  let factoryCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket-cached",
    webSocket: socketFactory(() => {
      factoryCalls += 1;
      return sockets.shift()!;
    }),
  });
  t.after(() => adapter.dispose());

  const first = request("openai-codex");
  first.model = "gpt-5.5";
  first.sessionId = "session-recovery";
  const firstEvents = await collect(adapter.stream(first, new AbortController().signal));
  const firstEnd = firstEvents.find((event) => event.type === "response_end");
  assert.ok(firstEnd?.type === "response_end");

  const second: ProviderRequest = {
    ...first,
    providerState: firstEnd.state,
    messages: [
      ...first.messages,
      {
        id: "assistant-1",
        role: "assistant",
        content: [{ type: "text", text: "ready" }],
        createdAt: "2026-07-10T00:00:01.000Z",
      },
      {
        id: "user-2",
        role: "user",
        content: [{ type: "text", text: "continue" }],
        createdAt: "2026-07-10T00:00:02.000Z",
      },
    ],
  };
  const events = await collect(adapter.stream(second, new AbortController().signal));

  assert.equal(factoryCalls, 2);
  assert.equal(firstSocket.sent[1]?.previous_response_id, "response-one");
  assert.equal(retrySocket.sent[0]?.previous_response_id, undefined);
  assert.equal((retrySocket.sent[0]?.input as unknown[]).length, 3);
  assert.deepEqual(
    events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.text : ""),
    ["recovered"],
  );
  assert.equal(terminalCount(events), 1);
});

test("Codex cache opt-out opens isolated sockets and omits continuation affinity", async (t) => {
  const sockets: FakeWebSocket[] = [];
  const handshakeHeaders: Headers[] = [];
  let factoryCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket-cached",
    headers: {
      "session-id": "configured-session",
      "x-client-request-id": "configured-session",
      "x-session-affinity": "configured-session",
    },
    webSocket: ((_: string | URL, headers: HeadersInit) => {
      factoryCalls += 1;
      handshakeHeaders.push(new Headers(headers));
      const socket = new FakeWebSocket();
      socket.onSend = () => completed(socket, `response-${factoryCalls}`, "");
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket as unknown as NetworkWebSocket;
    }) as NetworkWebSocketFactory,
  });
  t.after(() => adapter.dispose());

  const first = request("openai-codex");
  first.model = "gpt-5.5";
  first.sessionId = "session-none";
  first.cacheRetention = "none";
  const firstEvents = await collect(adapter.stream(first, new AbortController().signal));
  const firstEnd = firstEvents.find((event) => event.type === "response_end");
  assert.ok(firstEnd?.type === "response_end");

  const second: ProviderRequest = {
    ...first,
    providerState: firstEnd.state,
    messages: [
      ...first.messages,
      {
        id: "assistant-1",
        role: "assistant",
        content: [{ type: "text", text: "ready" }],
        createdAt: "2026-07-26T00:00:01.000Z",
      },
      {
        id: "user-2",
        role: "user",
        content: [{ type: "text", text: "continue" }],
        createdAt: "2026-07-26T00:00:02.000Z",
      },
    ],
  };
  const secondEvents = await collect(adapter.stream(second, new AbortController().signal));

  assert.equal(terminalCount(secondEvents), 1);
  assert.equal(factoryCalls, 2);
  assert.equal(sockets[1]?.sent[0]?.previous_response_id, undefined);
  assert.equal(sockets[1]?.sent[0]?.prompt_cache_key, undefined);
  const requestIds = handshakeHeaders.map((headers) => headers.get("x-client-request-id"));
  assert.equal(requestIds.every((requestId) => typeof requestId === "string" && requestId !== "session-none"), true);
  assert.equal(handshakeHeaders.every((headers, index) => headers.get("session-id") === requestIds[index]), true);
  assert.notEqual(requestIds[0], requestIds[1]);
  assert.equal(handshakeHeaders.every((headers) => headers.get("x-session-affinity") === null), true);
});

test("auto Codex transport falls back to full-context SSE only before WebSocket events", async () => {
  let fetchCalls = 0;
  let posted: Record<string, unknown> | undefined;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: (() => { throw new Error("websocket unavailable"); }) as NetworkWebSocketFactory,
    fetch: fakeFetch(async (incoming) => {
      fetchCalls += 1;
      assert.equal(incoming.headers.get("content-encoding"), "zstd");
      posted = await codexRequestJson(incoming);
      return streamResponse(sse(
        { type: "response.created", response: { id: "sse-response", model: "gpt-5.5" } },
        { type: "response.completed", response: { id: "sse-response", model: "gpt-5.5" } },
      ));
    }),
  });
  const input = request("openai-codex");
  input.sessionId = "fallback-session";
  const events = await collect(adapter.stream(input, new AbortController().signal));
  assert.equal(fetchCalls, 1);
  assert.equal(posted?.stream, true);
  assert.equal(terminalCount(events), 1);
});

test("auto Codex transport pins after an SSE event-named terminal", async (t) => {
  let webSocketCalls = 0;
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: (() => {
      webSocketCalls += 1;
      throw new Error("websocket unavailable");
    }) as NetworkWebSocketFactory,
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      return streamResponse([
        new TextEncoder().encode(
          `event: response.completed\ndata: ${JSON.stringify({
            response: { id: `sse-${fetchCalls}`, model: "gpt-5.5", output: [], usage: {} },
          })}\n\n`,
        ),
      ]);
    }),
  });
  t.after(() => adapter.dispose());

  for (let index = 0; index < 2; index += 1) {
    const input = request("openai-codex");
    input.sessionId = "event-named-terminal";
    const events = await collect(adapter.stream(input, new AbortController().signal));
    assert.equal(events.at(-1)?.type, "response_end");
  }

  assert.equal(webSocketCalls, 1);
  assert.equal(fetchCalls, 2);
});

test("auto Codex transport does not pin a malformed SSE event-named terminal", async (t) => {
  let webSocketCalls = 0;
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: (() => {
      webSocketCalls += 1;
      throw new Error("websocket unavailable");
    }) as NetworkWebSocketFactory,
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      return streamResponse([
        new TextEncoder().encode("event: response.completed\ndata: []\n\n"),
      ]);
    }),
  });
  t.after(() => adapter.dispose());

  for (let index = 0; index < 2; index += 1) {
    const input = request("openai-codex");
    input.sessionId = "malformed-event-named-terminal";
    const events = await collect(adapter.stream(input, new AbortController().signal));
    assert.equal(events.at(-1)?.type, "error");
  }

  assert.equal(webSocketCalls, 2);
  assert.equal(fetchCalls, 2);
});

test("Codex SSE fallback retries one first-event truncation at EOF", async (t) => {
  let webSocketCalls = 0;
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: (() => {
      webSocketCalls += 1;
      throw new Error("websocket unavailable");
    }) as NetworkWebSocketFactory,
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      if (fetchCalls === 1) return streamResponse([new TextEncoder().encode("data: {")]);
      return streamResponse(sse({
        type: "response.completed",
        response: { id: "sse-recovered", model: "gpt-5.5", output: [], usage: {} },
      }));
    }),
  });
  t.after(() => adapter.dispose());

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));

  assert.equal(webSocketCalls, 2);
  assert.equal(fetchCalls, 2);
  assert.equal(events.at(-1)?.type, "response_end");
});

test("Codex WebSocket callbacks contain hostile failures without reflection", async (suite) => {
  const fallback = async (webSocket: NetworkWebSocketFactory): Promise<void> => {
    let fetchCalls = 0;
    const adapter = new OpenAICodexResponsesAdapter({
      credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
      transport: "auto",
      webSocket,
      fetch: fakeFetch(() => {
        fetchCalls += 1;
        return streamResponse(sse({
          type: "response.completed",
          response: { id: "contained-fallback", model: "gpt-5.5", output: [], usage: {} },
        }));
      }),
    });
    try {
      const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));
      assert.equal(fetchCalls, 1);
      assert.equal(terminalCount(events), 1);
    } finally {
      adapter.dispose();
    }
  };
  let traps = 0;
  const hostile = new Proxy({}, {
    get() { traps += 1; throw new Error("get trap executed"); },
    getPrototypeOf() { traps += 1; throw new Error("prototype trap executed"); },
  });

  await suite.test("factory rejection", async () => {
    await fallback((() => { throw hostile; }) as NetworkWebSocketFactory);
  });

  const socketFailure = (failure: Event | "send"): NetworkWebSocketFactory => (() => {
    let readyState = 0;
    const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    const socket = {
      get readyState() { return readyState; },
      addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        const selected = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
        selected.add(listener);
        listeners.set(type, selected);
        if (type === "open") queueMicrotask(() => {
          readyState = 1;
          emit("open", new Event("open"));
        });
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
        listeners.get(type)?.delete(listener);
      },
      send(): void {
        if (failure === "send") throw hostile;
        queueMicrotask(() => emit("error", failure));
      },
      close(): void { readyState = 3; },
    };
    const emit = (type: string, event: Event): void => {
      for (const listener of listeners.get(type) ?? []) {
        if (typeof listener === "function") listener.call(socket, event);
        else listener.handleEvent(event);
      }
    };
    return socket as unknown as NetworkWebSocket;
  }) as NetworkWebSocketFactory;

  await suite.test("send rejection", async () => await fallback(socketFailure("send")));
  await suite.test("proxied error event", async () => {
    await fallback(socketFailure(new Proxy(new Event("error"), {
      get() { traps += 1; throw new Error("event get trap executed"); },
      getPrototypeOf() { traps += 1; throw new Error("event prototype trap executed"); },
    })));
  });
  await suite.test("accessor error event", async () => {
    const event = new ErrorEvent("error", { message: "ignored" });
    Object.defineProperties(event, {
      error: { configurable: true, get() { traps += 1; throw new Error("event error getter executed"); } },
      message: { configurable: true, get() { traps += 1; throw new Error("event message getter executed"); } },
    });
    await fallback(socketFailure(event));
  });
  assert.equal(traps, 0);
});

test("auto Codex transport falls back for a WebSocket server failure before output", async () => {
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: (() => {
      throw new HttpResponseError(503, new Headers(), "temporarily unavailable");
    }) as NetworkWebSocketFactory,
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      return streamResponse(sse({
        type: "response.completed",
        response: { id: "server-fallback", model: "gpt-5.5", output: [], usage: {} },
      }));
    }),
  });

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));

  assert.equal(fetchCalls, 1);
  assert.equal(terminalCount(events), 1);
});

test("auto Codex transport does not fall back for HTTP authentication or provider-declared failures", async (suite) => {
  await suite.test("HTTP authentication rejection", async () => {
    let fetchCalls = 0;
    const adapter = new OpenAICodexResponsesAdapter({
      credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
      transport: "auto",
      webSocket: (() => {
        throw new HttpResponseError(401, new Headers(), "authentication failed");
      }) as NetworkWebSocketFactory,
      fetch: fakeFetch(() => {
        fetchCalls += 1;
        throw new Error("authentication failures must not cross transports");
      }),
    });
    const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));
    assert.equal(fetchCalls, 0);
    const failure = events.at(-1);
    assert.equal(failure?.type, "error");
    assert.equal(failure?.type === "error" ? failure.error.category : undefined, "authentication");
  });

  await suite.test("provider-declared response failure", async (t) => {
    const socket = new FakeWebSocket();
    socket.onSend = () => queueMicrotask(() => {
      socket.message({
        type: "response.failed",
        response: { id: "provider-failure", status: "failed", error: { code: "invalid_request", message: "rejected" } },
      });
    });
    let fetchCalls = 0;
    const adapter = new OpenAICodexResponsesAdapter({
      credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
      transport: "auto",
      webSocket: socketFactory(() => socket),
      fetch: fakeFetch(() => {
        fetchCalls += 1;
        throw new Error("provider failures must not cross transports");
      }),
    });
    t.after(() => adapter.dispose());
    const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));
    assert.equal(fetchCalls, 0);
    const failure = events.at(-1);
    assert.equal(failure?.type, "error");
    assert.equal(failure?.type === "error" ? failure.error.category : undefined, "invalid_request");
  });
});

test("auto Codex transport waits for its 30-second WebSocket connect timeout before falling back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new FakeWebSocket();
  const observations: OpenAICodexTransportObservation[] = [];
  let fetchCalls = 0;
  const config: OpenAICodexResponsesConfig & OpenAICodexObservabilityOptions = {
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: (() => socket as unknown as NetworkWebSocket) as NetworkWebSocketFactory,
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      return streamResponse(sse(
        { type: "response.created", response: { id: "sse-response", model: "gpt-5.5" } },
        { type: "response.completed", response: { id: "sse-response", model: "gpt-5.5" } },
      ));
    }),
    [OPENAI_CODEX_TRANSPORT_OBSERVER]: (observation) => observations.push(observation),
  };
  const adapter = new OpenAICodexResponsesAdapter(config);
  t.after(() => adapter.dispose());

  const pending = collect(adapter.stream(request("openai-codex"), new AbortController().signal));
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(29_999);
  assert.equal(fetchCalls, 0);
  t.mock.timers.tick(1);

  const events = await pending;
  assert.equal(fetchCalls, 1);
  assert.equal(terminalCount(events), 1);
  assert.equal(
    observations.some((observation) => observation.type === "websocket_failed"
      && observation.failureClass === "connect_timeout"),
    true,
  );
});

test("auto Codex transport applies the bounded WebSocket idle timeout before SSE fallback", async (t) => {
  const socket = new FakeWebSocket();
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocketIdleTimeoutMs: 10,
    webSocket: socketFactory(() => socket),
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      return streamResponse(sse({
        type: "response.completed",
        response: { id: "idle-fallback", model: "gpt-5.5", output: [], usage: {} },
      }));
    }),
  });
  t.after(() => adapter.dispose());

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));
  assert.equal(fetchCalls, 1);
  assert.equal(terminalCount(events), 1);
});

test("Codex WebSocket inactivity timeout resets while a long response remains active", async (t) => {
  const socket = new FakeWebSocket();
  socket.onSend = () => {
    setTimeout(() => socket.message({ type: "response.in_progress", response: { id: "long-running", model: "gpt-5.5" } }), 40);
    setTimeout(() => socket.message({ type: "response.in_progress", response: { id: "long-running", model: "gpt-5.5" } }), 80);
    setTimeout(() => socket.message({
      type: "response.completed",
      response: { id: "long-running", model: "gpt-5.5", output: [], usage: {} },
    }), 120);
  };
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocketIdleTimeoutMs: 100,
    webSocket: socketFactory(() => socket),
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      throw new Error("an active WebSocket response must not fall back to SSE");
    }),
  });
  t.after(() => adapter.dispose());

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));

  assert.equal(fetchCalls, 0);
  assert.equal(terminalCount(events), 1);
  assert.equal(events.at(-1)?.type, "response_end");
});

test("auto Codex transport falls back through SSE after metadata-only WebSocket events", async (t) => {
  const socket = new FakeWebSocket();
  socket.onSend = () => queueMicrotask(() => {
    socket.message({ type: "response.queued", response: { id: "partial", model: "gpt-5.5" } });
    socket.message({
      type: "response.created",
      response: {
        id: "partial",
        model: "gpt-5.5",
        output: [
          { type: "message", content: [] },
          { type: "message", content: [{ type: "output_text", text: "", annotations: [] }] },
          { type: "reasoning", summary: [], content: [], encrypted_content: "" },
          { type: "reasoning", summary: [], content: [], encrypted_content: null },
        ],
      },
    });
    socket.message({ type: "response.in_progress", response: { id: "partial", model: "gpt-5.5" } });
    socket.message({
      type: "response.output_item.added",
      output_index: 7,
      item: { type: "message", id: "failed-ws-item", content: [] },
    });
    socket.message({ type: "codex.rate_limits", rate_limits: { allowed: true } });
    socket.message({ type: "codex.response.metadata", headers: { "x-codex": "ready" } });
    socket.message({ type: "responsesapi.websocket_timing", timing_metrics: {} });
    socket.message({ type: "response.metadata", response: { id: "partial" } });
    socket.message({
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    socket.message({
      type: "response.content_part.added",
      output_index: 1,
      content_index: 0,
      part: { type: "refusal", refusal: "" },
    });
    socket.message({
      type: "response.reasoning_summary_part.added",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    });
    const cause = Object.assign(new Error("PRIVATE_SOCKET_DETAIL"), { code: "UND_ERR_SOCKET" });
    socket.dispatchEvent(new NetworkErrorEvent("error", { message: "terminated", error: cause }));
    socket.dispatchEvent(new NetworkCloseEvent("close", { code: 1006, reason: "", wasClean: false }));
  });
  let fetchCalls = 0;
  let posted: Record<string, unknown> | undefined;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: socketFactory(() => socket),
    fetch: fakeFetch(async (incoming) => {
      fetchCalls += 1;
      posted = await codexRequestJson(incoming);
      return streamResponse(sse(
        { type: "response.created", response: { id: "sse-response", model: "gpt-5.5" } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "recovered" },
        {
          type: "response.completed",
          response: {
            id: "sse-response",
            model: "gpt-5.5",
            output: [{
              type: "message",
              id: "successful-sse-item",
              content: [{ type: "output_text", text: "recovered", annotations: [] }],
            }],
          },
        },
      ));
    }),
  });
  t.after(() => adapter.dispose());
  const input = request("openai-codex");
  input.sessionId = "fallback-after-metadata";
  input.providerState = {
    kind: "openai_responses",
    previousResponseId: "previous-response",
    outputItems: [],
  };
  input.messages.push(
    {
      id: "assistant-1",
      role: "assistant",
      content: [{ type: "text", text: "prior answer" }],
      createdAt: "2026-07-26T00:00:01.000Z",
    },
    {
      id: "user-2",
      role: "user",
      content: [{ type: "text", text: "continue now" }],
      createdAt: "2026-07-26T00:00:02.000Z",
    },
  );

  const events = await collect(adapter.stream(input, new AbortController().signal));

  assert.equal(fetchCalls, 1);
  assert.equal(posted?.previous_response_id, undefined);
  const fullInput = JSON.stringify(posted?.input);
  assert.match(fullInput, /hello/u);
  assert.match(fullInput, /prior answer/u);
  assert.match(fullInput, /continue now/u);
  assert.deepEqual(
    events.flatMap((event) => event.type === "text_delta" ? [event.text] : []),
    ["recovered"],
  );
  assert.equal(events.some((event) => event.type === "unknown_provider_event"), false);
  assert.equal(terminalCount(events), 1);
  const terminal = events.find((event) => event.type === "response_end");
  assert.equal(terminal?.type === "response_end" ? terminal.reason : undefined, "stop");
  assert.deepEqual(terminal?.type === "response_end" ? terminal.state : undefined, {
    kind: "openai_responses",
    previousResponseId: "sse-response",
    outputItems: [{
      type: "message",
      id: "successful-sse-item",
      content: [{ type: "output_text", text: "recovered", annotations: [] }],
    }],
  });
});

test("auto Codex transport does not replay an unclassifiable WebSocket frame", async (t) => {
  const frames = ["{", "[]", JSON.stringify({ response: {} })];
  let webSocketCalls = 0;
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: socketFactory(() => {
      const socket = new FakeWebSocket();
      const frame = frames[webSocketCalls];
      socket.onSend = () => queueMicrotask(() => socket.rawMessage(frame ?? ""));
      webSocketCalls += 1;
      return socket;
    }),
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      return streamResponse(sse({
        type: "response.completed",
        response: { id: "protocol-fallback", model: "gpt-5.5", output: [], usage: {} },
      }));
    }),
  });
  t.after(() => adapter.dispose());

  for (const [index, frame] of frames.entries()) {
    const input = request("openai-codex");
    input.sessionId = `malformed-frame-${index}`;
    const first = await collect(adapter.stream(input, new AbortController().signal));
    const second = await collect(adapter.stream(input, new AbortController().signal));
    assert.equal(first.at(-1)?.type, "error", frame);
    assert.equal(fetchCalls, index + 1, frame);
    assert.equal(webSocketCalls, index + 1, frame);
    assert.equal(second.at(-1)?.type, "response_end", frame);
  }
});

test("auto Codex transport does not replay after semantic WebSocket state", async (t) => {
  const cases = [
    {
      name: "text",
      event: { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "partial" },
      observed: "text_delta",
      outputBoundary: "visible_text",
      messageBoundary: "visible response text",
    },
    {
      name: "reasoning",
      event: { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "plan" },
      observed: "reasoning_delta",
      outputBoundary: "visible_summary_reasoning",
      messageBoundary: "visible reasoning-summary text",
    },
    {
      name: "hidden provider reasoning",
      event: { type: "response.reasoning_text.delta", output_index: 0, content_index: 0, delta: "private plan" },
      observed: "reasoning_delta",
      outputBoundary: "hidden_provider_reasoning",
      messageBoundary: "hidden provider reasoning state",
    },
    {
      name: "refusal",
      event: { type: "response.refusal.delta", output_index: 0, content_index: 0, delta: "cannot comply" },
      observed: "text_delta",
      outputBoundary: "visible_text",
      messageBoundary: "visible response text",
    },
    {
      name: "tool call",
      event: {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "tool-item", call_id: "tool-call", name: "read", arguments: "" },
      },
      observed: "tool_call_start",
      outputBoundary: "tool_draft",
      messageBoundary: "a tool-call draft",
    },
    {
      name: "unknown output item",
      event: {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "computer_call", id: "computer-item", action: { type: "screenshot" } },
      },
      observed: "error",
      outputBoundary: "unknown_or_opaque",
      messageBoundary: "unknown or opaque provider state",
    },
    {
      name: "unknown done event",
      event: { type: "response.future_notice.done", value: "bounded" },
      observed: "unknown_provider_event",
      outputBoundary: "unknown_or_opaque",
      messageBoundary: "unknown or opaque provider state",
    },
    {
      name: "output text done",
      event: {
        type: "response.output_text.done",
        output_index: 0,
        content_index: 0,
        item_id: "message-output-text-done",
        text: "done-only text",
      },
      observed: "text_delta",
      outputBoundary: "visible_text",
      messageBoundary: "visible response text",
    },
    {
      name: "content part added",
      event: {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        item_id: "message-content-added",
        part: { type: "output_text", text: "added content", annotations: [] },
      },
      observed: "text_delta",
      outputBoundary: "visible_text",
      messageBoundary: "visible response text",
    },
    {
      name: "reasoning summary part added",
      event: {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        summary_index: 0,
        item_id: "reasoning-summary-added",
        part: { type: "summary_text", text: "added summary" },
      },
      observed: "reasoning_delta",
      outputBoundary: "visible_summary_reasoning",
      messageBoundary: "visible reasoning-summary text",
    },
    {
      name: "message output item added",
      event: {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "message-item-added",
          content: [{ type: "output_text", text: "item added text", annotations: [] }],
        },
      },
      observed: "text_delta",
      outputBoundary: "visible_text",
      messageBoundary: "visible response text",
    },
    {
      name: "encrypted reasoning snapshot",
      event: {
        type: "response.in_progress",
        response: {
          id: "partial",
          output: [{ type: "reasoning", encrypted_content: "opaque", summary: [], content: [] }],
        },
      },
      observed: "error",
      outputBoundary: "hidden_provider_reasoning",
      messageBoundary: "hidden provider reasoning state",
    },
    {
      name: "malformed output snapshot",
      event: {
        type: "response.in_progress",
        response: { id: "partial", output: [{ type: "message", content: "invalid" }] },
      },
      observed: "error",
      outputBoundary: "unknown_or_opaque",
      messageBoundary: "unknown or opaque provider state",
    },
    {
      name: "mismatched output-item content",
      event: {
        type: "response.in_progress",
        response: {
          id: "partial",
          output: [{ type: "message", content: [{ type: "summary_text", text: "" }] }],
        },
      },
      observed: "error",
      outputBoundary: "unknown_or_opaque",
      messageBoundary: "unknown or opaque provider state",
    },
    {
      name: "missing lifecycle response",
      event: { type: "response.in_progress" },
      observed: "error",
      outputBoundary: "unknown_or_opaque",
      messageBoundary: "unknown or opaque provider state",
    },
    {
      name: "mismatched content part",
      event: {
        type: "response.content_part.added",
        part: { type: "summary_text", text: "" },
      },
      observed: "error",
      outputBoundary: "unknown_or_opaque",
      messageBoundary: "unknown or opaque provider state",
    },
    {
      name: "mismatched reasoning summary part",
      event: {
        type: "response.reasoning_summary_part.added",
        part: { type: "output_text", text: "", annotations: [] },
      },
      observed: "error",
      outputBoundary: "unknown_or_opaque",
      messageBoundary: "unknown or opaque provider state",
    },
  ] as const;

  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const socket = new FakeWebSocket();
      socket.onSend = () => queueMicrotask(() => {
        socket.message({ type: "response.created", response: { id: "partial", model: "gpt-5.5" } });
        socket.message(scenario.event);
        socket.close(1011, "upstream failed");
      });
      let fetchCalls = 0;
      const observations: OpenAICodexTransportObservation[] = [];
      const config: OpenAICodexResponsesConfig & OpenAICodexObservabilityOptions = {
        credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
        transport: "auto",
        webSocket: socketFactory(() => socket),
        fetch: fakeFetch(() => {
          fetchCalls += 1;
          throw new Error("unsafe replay");
        }),
        [OPENAI_CODEX_TRANSPORT_OBSERVER]: (observation) => observations.push(observation),
      };
      const adapter = new OpenAICodexResponsesAdapter(config);
      t.after(() => adapter.dispose());

      const input = request("openai-codex");
      input.sessionId = `semantic-boundary-${scenario.name}`;
      const events = await collect(adapter.stream(input, new AbortController().signal));

      assert.equal(fetchCalls, 0);
      assert.equal(events.some((event) => event.type === scenario.observed), true);
      const failure = events.at(-1);
      assert.equal(failure?.type, "error");
      assert.equal(failure?.type === "error" ? failure.error.partial : undefined, true);
      assert.equal(failure?.type === "error" ? failure.error.retryable : undefined, false);
      assert.match(failure?.type === "error" ? failure.error.message : "", new RegExp(scenario.messageBoundary, "u"));
      assert.match(failure?.type === "error" ? failure.error.message : "", /provider state may not be safe to repeat/u);
      assert.doesNotMatch(failure?.type === "error" ? failure.error.message : "", /partial output/u);
      assert.deepEqual(observations.find((observation) => observation.type === "websocket_failed"), {
        type: "websocket_failed",
        failureClass: "close",
        closeCode: 1011,
        partialOutput: true,
        outputBoundary: scenario.outputBoundary,
      });
      assert.deepEqual(observations.find((observation) => observation.type === "session_fallback_activated"), {
        type: "session_fallback_activated",
        failureClass: "close",
        partialOutput: true,
        outputBoundary: scenario.outputBoundary,
      });
    });
  }
});

test("auto Codex transport keeps a failed identity on SSE for the adapter lifetime", async (t) => {
  let webSocketCalls = 0;
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: socketFactory(() => {
      webSocketCalls += 1;
      const socket = new FakeWebSocket();
      if (webSocketCalls === 1) {
        socket.onSend = () => queueMicrotask(() => {
          socket.message({ type: "response.created", response: { id: "partial", model: "gpt-5.5" } });
          socket.message({
            type: "response.reasoning_summary_text.delta",
            output_index: 0,
            summary_index: 0,
            delta: "partial plan",
          });
          socket.close(1011, "upstream failed");
        });
      } else {
        socket.onSend = () => completed(socket, `websocket-${webSocketCalls}`, `websocket-${webSocketCalls}`);
      }
      return socket;
    }),
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      return streamResponse(sse(
        { type: "response.created", response: { id: "sse-response", model: "gpt-5.5" } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "recovered" },
        { type: "response.completed", response: { id: "sse-response", model: "gpt-5.5" } },
      ));
    }),
  });
  t.after(() => adapter.dispose());

  const first = request("openai-codex");
  first.sessionId = "partial-failure-session";
  const firstEvents = await collect(adapter.stream(first, new AbortController().signal));
  assert.equal(fetchCalls, 0, "the partial turn must not be replayed");
  assert.equal(firstEvents.some((event) => event.type === "reasoning_delta"), true);
  const firstFailure = firstEvents.at(-1);
  assert.equal(firstFailure?.type, "error");
  assert.match(
    firstFailure?.type === "error" ? firstFailure.error.message : "",
    /visible reasoning-summary text.*did not replay.*switched this session to HTTPS\/SSE/u,
  );

  const second = request("openai-codex");
  second.sessionId = first.sessionId;
  const secondEvents = await collect(adapter.stream(second, new AbortController().signal));

  assert.equal(webSocketCalls, 1, "the sticky fallback must suppress a repeated WebSocket failure");
  assert.equal(fetchCalls, 1);
  assert.equal(secondEvents.some((event) => event.type === "text_delta" && event.text === "recovered"), true);
  assert.equal(terminalCount(secondEvents), 1);

  const stillPinned = request("openai-codex");
  stillPinned.sessionId = first.sessionId;
  const stillPinnedEvents = await collect(adapter.stream(stillPinned, new AbortController().signal));
  assert.equal(webSocketCalls, 1, "the same identity must not probe WebSocket again during the adapter lifetime");
  assert.equal(fetchCalls, 2);
  assert.equal(stillPinnedEvents.some((event) => event.type === "text_delta" && event.text === "recovered"), true);

  const unrelated = request("openai-codex");
  unrelated.sessionId = "unrelated-session";
  const unrelatedEvents = await collect(adapter.stream(unrelated, new AbortController().signal));
  assert.equal(webSocketCalls, 2, "an unrelated session must still prefer WebSocket");
  assert.equal(fetchCalls, 2);
  assert.equal(unrelatedEvents.some((event) => event.type === "text_delta" && event.text === "websocket-2"), true);

  adapter.dispose();
  let restoredWebSocketCalls = 0;
  const restored = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: socketFactory(() => {
      restoredWebSocketCalls += 1;
      const socket = new FakeWebSocket();
      socket.onSend = () => completed(socket, "restored", "restored");
      return socket;
    }),
    fetch: fakeFetch(() => { throw new Error("a new adapter must restore WebSocket-first auto mode"); }),
  });
  t.after(() => restored.dispose());
  const restoredEvents = await collect(restored.stream(first, new AbortController().signal));
  assert.equal(restoredWebSocketCalls, 1);
  assert.equal(restoredEvents.some((event) => event.type === "text_delta" && event.text === "restored"), true);
});

test("auto Codex fallback identity survives prompt-cache opt-out", async (t) => {
  let webSocketCalls = 0;
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: socketFactory(() => {
      webSocketCalls += 1;
      const socket = new FakeWebSocket();
      socket.onSend = () => queueMicrotask(() => socket.fail("temporary WebSocket failure"));
      return socket;
    }),
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      return streamResponse(sse({
        type: "response.completed",
        response: { id: `sse-${fetchCalls}`, model: "gpt-5.5", output: [], usage: {} },
      }));
    }),
  });
  t.after(() => adapter.dispose());

  for (let index = 0; index < 2; index += 1) {
    const input = request("openai-codex");
    input.sessionId = "cache-opt-out-fallback";
    input.cacheRetention = "none";
    const events = await collect(adapter.stream(input, new AbortController().signal));
    assert.equal(events.at(-1)?.type, "response_end");
  }

  assert.equal(webSocketCalls, 1);
  assert.equal(fetchCalls, 2);
});

test("disposing Codex transport prevents active and later SSE fallback", async () => {
  const socket = new FakeWebSocket();
  let webSocketCalls = 0;
  let fetchCalls = 0;
  let adapter: OpenAICodexResponsesAdapter;
  socket.onSend = () => queueMicrotask(() => adapter.dispose());
  adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: socketFactory(() => {
      webSocketCalls += 1;
      return socket;
    }),
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      return streamResponse(sse({ type: "response.completed", response: { id: "unsafe-fallback" } }));
    }),
  });

  const input = request("openai-codex");
  input.sessionId = "disposed-fallback";
  const active = await collect(adapter.stream(input, new AbortController().signal));
  const later = await collect(adapter.stream(input, new AbortController().signal));

  assert.equal(active.at(-1)?.type, "error");
  assert.equal(later.at(-1)?.type, "error");
  assert.equal(webSocketCalls, 1);
  assert.equal(fetchCalls, 0);
});

test("disposing Codex transport closes a WebSocket still connecting", async () => {
  const socket = new FakeWebSocket();
  let created!: () => void;
  const socketCreated = new Promise<void>((resolve) => { created = resolve; });
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket",
    webSocket: (() => {
      created();
      return socket as unknown as NetworkWebSocket;
    }) as NetworkWebSocketFactory,
  });

  const pending = collect(adapter.stream(request("openai-codex"), new AbortController().signal));
  await socketCreated;
  adapter.dispose();
  const events = await pending;

  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.sent.length, 0);
  assert.equal(events.at(-1)?.type, "error");
});

test("disposing Codex transport stops an active uncached WebSocket", async () => {
  const socket = new FakeWebSocket();
  let sent!: () => void;
  const frameSent = new Promise<void>((resolve) => { sent = resolve; });
  socket.onSend = sent;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket",
    webSocket: socketFactory(() => socket),
  });

  const pending = collect(adapter.stream(request("openai-codex"), new AbortController().signal));
  await frameSent;
  adapter.dispose();
  socket.message({
    type: "response.completed",
    response: { id: "after-dispose", model: "gpt-5.5", output: [], usage: {} },
  });
  const events = await pending;

  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.sent.length, 1);
  assert.equal(events.at(-1)?.type, "error");
});

test("disposing Codex transport during frame preparation prevents send", async () => {
  const socket = new FakeWebSocket();
  let frameStarted!: () => void;
  const framePreparationStarted = new Promise<void>((resolve) => { frameStarted = resolve; });
  let releaseFrame!: () => void;
  const frameGate = new Promise<void>((resolve) => { releaseFrame = resolve; });
  const wire = new ProviderWireInterceptorRegistry();
  wire.register("openai-codex", {
    async interceptRequest(observed) {
      if (observed.phase !== "frame") return;
      frameStarted();
      await frameGate;
    },
  });
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket",
    webSocket: socketFactory(() => socket),
    wire,
  });

  const pending = collect(adapter.stream(request("openai-codex"), new AbortController().signal));
  await framePreparationStarted;
  adapter.dispose();
  releaseFrame();
  const events = await pending;

  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.sent.length, 0);
  assert.equal(events.at(-1)?.type, "error");
});

test("disposing Codex transport during frame observation prevents terminal output", async () => {
  const socket = new FakeWebSocket();
  socket.onSend = () => queueMicrotask(() => socket.message({
    type: "response.completed",
    response: { id: "after-dispose", model: "gpt-5.5", output: [], usage: {} },
  }));
  let frameObserved!: () => void;
  const frameObservationStarted = new Promise<void>((resolve) => { frameObserved = resolve; });
  let releaseFrame!: () => void;
  const frameGate = new Promise<void>((resolve) => { releaseFrame = resolve; });
  const wire = new ProviderWireInterceptorRegistry();
  wire.register("openai-codex", {
    async observeResponse(observed) {
      if (observed.phase !== "frame") return;
      frameObserved();
      await frameGate;
    },
  });
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket",
    webSocket: socketFactory(() => socket),
    wire,
  });

  const pending = collect(adapter.stream(request("openai-codex"), new AbortController().signal));
  await frameObservationStarted;
  adapter.dispose();
  releaseFrame();
  const events = await pending;

  assert.equal(socket.closeCalls, 1);
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(events.some((event) => event.type === "response_end"), false);
});

test("disposing Codex transport stops an active sticky SSE request", async () => {
  let webSocketCalls = 0;
  let fetchCalls = 0;
  let secondStarted!: () => void;
  const secondResponseStarted = new Promise<void>((resolve) => { secondStarted = resolve; });
  let releaseSecond!: () => void;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: socketFactory(() => {
      webSocketCalls += 1;
      const socket = new FakeWebSocket();
      socket.onSend = () => queueMicrotask(() => socket.fail("temporary WebSocket failure"));
      return socket;
    }),
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return streamResponse(sse({
          type: "response.completed",
          response: { id: "pin-sse", model: "gpt-5.5", output: [], usage: {} },
        }));
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          releaseSecond = () => {
            for (const chunk of sse({
              type: "response.completed",
              response: { id: "after-dispose", model: "gpt-5.5", output: [], usage: {} },
            })) controller.enqueue(chunk);
            controller.close();
          };
          secondStarted();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }),
  });
  const input = request("openai-codex");
  input.sessionId = "dispose-sticky-sse";

  assert.equal((await collect(adapter.stream(input, new AbortController().signal))).at(-1)?.type, "response_end");
  const pending = collect(adapter.stream(input, new AbortController().signal));
  await secondResponseStarted;
  adapter.dispose();
  releaseSecond();
  const events = await pending;

  assert.equal(webSocketCalls, 1);
  assert.equal(fetchCalls, 2);
  assert.equal(events.at(-1)?.type, "error");
});

test("auto Codex transport bounds sticky fallback identities by recent use", async (t) => {
  const fallbackCapacity = 1_024;
  let webSocketCalls = 0;
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: (() => {
      webSocketCalls += 1;
      throw new Error("websocket unavailable");
    }) as NetworkWebSocketFactory,
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      return streamResponse(sse({
        type: "response.completed",
        response: { id: `sse-${fetchCalls}`, model: "gpt-5.5", output: [], usage: {} },
      }));
    }),
  });
  t.after(() => adapter.dispose());

  const streamSession = async (sessionId: string): Promise<void> => {
    const input = request("openai-codex");
    input.sessionId = sessionId;
    const events = await collect(adapter.stream(input, new AbortController().signal));
    assert.equal(terminalCount(events), 1);
  };

  for (let index = 0; index < fallbackCapacity; index += 1) {
    await streamSession(`bounded-fallback-${index}`);
  }
  assert.equal(webSocketCalls, fallbackCapacity);

  await streamSession("bounded-fallback-0");
  assert.equal(webSocketCalls, fallbackCapacity, "a retained identity must stay on SSE and become most recent");

  await streamSession("bounded-fallback-overflow");
  assert.equal(webSocketCalls, fallbackCapacity + 1);
  await streamSession("bounded-fallback-0");
  assert.equal(webSocketCalls, fallbackCapacity + 1, "recent use must protect an identity from overflow eviction");

  await streamSession("bounded-fallback-1");
  assert.equal(webSocketCalls, fallbackCapacity + 2, "the oldest overflow identity may safely retry WebSocket");
});

test("Codex transport observations expose only bounded transport and fallback metadata", async (t) => {
  const observations: OpenAICodexTransportObservation[] = [];
  const socket = new FakeWebSocket();
  socket.onSend = () => queueMicrotask(() => socket.close(1011, "CLOSE_REASON_SENTINEL"));
  const config: OpenAICodexResponsesConfig & OpenAICodexObservabilityOptions = {
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: socketFactory(() => socket),
    fetch: fakeFetch(() => streamResponse(sse({
      type: "response.completed",
      response: { id: "sse-response", model: "gpt-5.5", output: [], usage: {} },
    }))),
    [OPENAI_CODEX_TRANSPORT_OBSERVER]: (observation) => observations.push(observation),
  };
  const adapter = new OpenAICodexResponsesAdapter(config);
  t.after(() => adapter.dispose());
  const input = request("openai-codex");
  input.sessionId = "private-session-identifier";

  assert.equal(terminalCount(await collect(adapter.stream(input, new AbortController().signal))), 1);
  assert.equal(terminalCount(await collect(adapter.stream(input, new AbortController().signal))), 1);

  assert.deepEqual(observations, [
    { type: "selected", transport: "websocket", cachedSocketReused: false, handshakeStatus: 101 },
    { type: "websocket_failed", failureClass: "close", closeCode: 1011, partialOutput: false },
    { type: "selected", transport: "sse", sessionFallbackUsed: true },
    { type: "session_fallback_activated", failureClass: "close", partialOutput: false },
    { type: "selected", transport: "sse", sessionFallbackUsed: true },
  ]);
  assert.doesNotMatch(JSON.stringify(observations), /CLOSE_REASON_SENTINEL|private-session-identifier/u);
});

test("Codex transport observations report cached WebSocket reuse", async (t) => {
  const observations: OpenAICodexTransportObservation[] = [];
  const socket = new FakeWebSocket();
  socket.onSend = () => completed(socket, `response-${socket.sent.length}`, "", []);
  const config: OpenAICodexResponsesConfig & OpenAICodexObservabilityOptions = {
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket-cached",
    webSocket: socketFactory(() => socket),
    [OPENAI_CODEX_TRANSPORT_OBSERVER]: (observation) => observations.push(observation),
  };
  const adapter = new OpenAICodexResponsesAdapter(config);
  t.after(() => adapter.dispose());
  const input = request("openai-codex");
  input.sessionId = "cached-observation-session";

  assert.equal(terminalCount(await collect(adapter.stream(input, new AbortController().signal))), 1);
  assert.equal(terminalCount(await collect(adapter.stream(input, new AbortController().signal))), 1);

  assert.deepEqual(observations, [
    { type: "selected", transport: "websocket", cachedSocketReused: false, handshakeStatus: 101 },
    { type: "selected", transport: "websocket", cachedSocketReused: true, handshakeStatus: 101 },
  ]);
});

test("explicit Codex WebSocket transports never fall back through SSE", async (t) => {
  for (const transport of ["websocket", "websocket-cached"] as const) {
    await t.test(transport, async (t) => {
      const socket = new FakeWebSocket();
      socket.onSend = () => queueMicrotask(() => {
        socket.message({ type: "response.created", response: { id: "metadata-only", model: "gpt-5.5" } });
        socket.close(1011, "upstream failed");
      });
      let fetchCalls = 0;
      const adapter = new OpenAICodexResponsesAdapter({
        credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
        transport,
        webSocket: socketFactory(() => socket),
        fetch: fakeFetch(() => {
          fetchCalls += 1;
          throw new Error("explicit WebSocket mode must not use SSE");
        }),
      });
      t.after(() => adapter.dispose());

      const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));

      assert.equal(fetchCalls, 0);
      assert.equal(events.at(-1)?.type, "error");
      assert.equal(terminalCount(events), 1);
    });
  }
});

test("Codex WebSocket retries one connection-limit event before producing output", async (t) => {
  const first = new FakeWebSocket();
  first.onSend = () => queueMicrotask(() => {
    first.message({ type: "response.created", response: { id: "abandoned", model: "gpt-5.5" } });
    first.message({
      type: "response.output_item.added",
      output_index: 7,
      item: { type: "message", id: "abandoned-item", content: [] },
    });
    first.message({
      type: "response.content_part.added",
      output_index: 1,
      content_index: 0,
      part: { type: "refusal", refusal: "" },
    });
    first.message({
      type: "error",
      error: { code: "websocket_connection_limit_reached", message: "reconnect" },
    });
  });
  const second = new FakeWebSocket();
  second.onSend = () => completed(second, "response-retried", "", []);
  const sockets = [first, second];
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket",
    webSocket: socketFactory(() => sockets.shift()!),
  });
  t.after(() => adapter.dispose());
  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));
  const terminal = events.find((event) => event.type === "response_end");
  assert.equal(terminal?.type === "response_end" ? terminal.reason : undefined, "stop");
  assert.deepEqual(terminal?.type === "response_end" ? terminal.state : undefined, {
    kind: "openai_responses",
    previousResponseId: "response-retried",
    outputItems: [],
  });
  assert.equal(terminalCount(events), 1);
});

test("Codex WebSocket rejects binary events that are not valid UTF-8", async (t) => {
  const socket = new FakeWebSocket();
  socket.onSend = () => queueMicrotask(() => socket.rawMessage(Uint8Array.from([0xc3, 0x28])));
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket",
    webSocket: socketFactory(() => socket),
  });
  t.after(() => adapter.dispose());

  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));

  const terminal = events.at(-1);
  assert.equal(terminal?.type, "error");
  assert.equal(terminal?.type === "error" ? terminal.error.message : undefined, "OpenAI Codex WebSocket message contained invalid UTF-8");
  assert.equal(terminalCount(events), 1);
});

test("Codex WebSocket preflights Blob payload size at the 16 MiB boundary", async (t) => {
  await t.test("accepts the exact boundary", async (t) => {
    const socket = new FakeWebSocket();
    const completedEvent = JSON.stringify({
      type: "response.completed",
      response: {
        id: "blob-boundary",
        model: "gpt-5.5",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    const message = completedEvent.padEnd(WEBSOCKET_MAX_MESSAGE_BYTES, " ");
    assert.equal(Buffer.byteLength(message, "utf8"), WEBSOCKET_MAX_MESSAGE_BYTES);
    socket.onSend = () => queueMicrotask(() => socket.rawMessage(new Blob([message])));
    const adapter = new OpenAICodexResponsesAdapter({
      credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
      transport: "websocket",
      webSocket: socketFactory(() => socket),
    });
    t.after(() => adapter.dispose());

    const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));

    assert.equal(events.at(-1)?.type, "response_end");
    assert.equal(terminalCount(events), 1);
  });

  await t.test("rejects an oversized Blob without reading it", async (t) => {
    const socket = new FakeWebSocket();
    let reads = 0;
    const message = new Blob([new Uint8Array(WEBSOCKET_MAX_MESSAGE_BYTES + 1)]);
    Object.defineProperty(message, "arrayBuffer", {
      configurable: true,
      value: async () => {
        reads += 1;
        return new ArrayBuffer(0);
      },
    });
    socket.onSend = () => queueMicrotask(() => socket.rawMessage(message));
    const adapter = new OpenAICodexResponsesAdapter({
      credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
      transport: "websocket",
      webSocket: socketFactory(() => socket),
    });
    t.after(() => adapter.dispose());

    const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));
    const terminal = events.at(-1);

    assert.equal(reads, 0);
    assert.equal(terminal?.type, "error");
    assert.equal(
      terminal?.type === "error" ? terminal.error.message : undefined,
      `OpenAI Codex WebSocket message exceeded ${WEBSOCKET_MAX_MESSAGE_BYTES} bytes`,
    );
    assert.equal(socket.closeCalls, 1);
    assert.equal(terminalCount(events), 1);
  });
});

test("Codex WebSocket cancellation does not inspect hostile abort reasons", async (t) => {
  await t.test("before acquisition", async (t) => {
    let webSocketCalls = 0;
    const adapter = new OpenAICodexResponsesAdapter({
      credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
      transport: "websocket",
      webSocket: (() => {
        webSocketCalls += 1;
        return new FakeWebSocket() as unknown as NetworkWebSocket;
      }) as NetworkWebSocketFactory,
    });
    t.after(() => adapter.dispose());
    const controller = new AbortController();
    controller.abort();

    const events = await collect(adapter.stream(request("openai-codex"), controller.signal));

    assert.equal(webSocketCalls, 0);
    assert.equal(events.at(-1)?.type, "error");
  });

  await t.test("while observing a cached handshake", async (t) => {
    const socket = new FakeWebSocket();
    socket.onSend = () => completed(socket, `response-${socket.sent.length}`, "", []);
    let openObservations = 0;
    let secondObserved!: () => void;
    const secondOpenObserved = new Promise<void>((resolve) => { secondObserved = resolve; });
    let releaseSecond!: () => void;
    const secondOpenGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const wire = new ProviderWireInterceptorRegistry();
    wire.register("openai-codex", {
      async observeResponse(observed) {
        if (observed.phase !== "open") return;
        openObservations += 1;
        if (openObservations !== 2) return;
        secondObserved();
        await secondOpenGate;
      },
    });
    const adapter = new OpenAICodexResponsesAdapter({
      credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
      transport: "websocket-cached",
      webSocket: socketFactory(() => socket),
      wire,
    });
    t.after(() => adapter.dispose());
    const input = request("openai-codex");
    input.sessionId = "abort-cached-handshake";
    assert.equal((await collect(adapter.stream(input, new AbortController().signal))).at(-1)?.type, "response_end");
    const controller = new AbortController();

    const pending = collect(adapter.stream(input, controller.signal));
    await secondOpenObserved;
    controller.abort();
    releaseSecond();
    const events = await pending;

    assert.equal(socket.sent.length, 1);
    assert.equal(events.at(-1)?.type, "error");
  });

  await t.test("while connecting", async (t) => {
    const socket = new FakeWebSocket();
    let created!: () => void;
    const socketCreated = new Promise<void>((resolve) => { created = resolve; });
    let traps = 0;
    const reason = new Proxy(Object.create(null) as object, {
      get() { traps += 1; return undefined; },
      getPrototypeOf() { traps += 1; return Object.prototype; },
    });
    const observations: OpenAICodexTransportObservation[] = [];
    const config: OpenAICodexResponsesConfig & OpenAICodexObservabilityOptions = {
      credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
      transport: "websocket",
      webSocket: (() => {
        created();
        return socket as unknown as NetworkWebSocket;
      }) as NetworkWebSocketFactory,
      [OPENAI_CODEX_TRANSPORT_OBSERVER]: (observation) => observations.push(observation),
    };
    const adapter = new OpenAICodexResponsesAdapter(config);
    t.after(() => adapter.dispose());
    const controller = new AbortController();

    const pending = collect(adapter.stream(request("openai-codex"), controller.signal));
    await socketCreated;
    controller.abort(reason);
    const events = await pending;

    assert.equal(traps, 0);
    assert.equal(socket.closeCalls, 1);
    assert.equal(events.at(-1)?.type, "error");
    assert.equal(terminalCount(events), 1);
    assert.equal(
      observations.some((observation) => observation.type === "websocket_failed"
        && observation.failureClass === "cancelled"),
      true,
    );
  });

  await t.test("while awaiting messages", async (t) => {
    const socket = new FakeWebSocket();
    let sent!: () => void;
    const frameSent = new Promise<void>((resolve) => { sent = resolve; });
    socket.onSend = sent;
    let traps = 0;
    const reason = new Proxy(Object.create(null) as object, {
      get() { traps += 1; return undefined; },
      getPrototypeOf() { traps += 1; return Object.prototype; },
    });
    const adapter = new OpenAICodexResponsesAdapter({
      credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
      transport: "websocket",
      webSocket: socketFactory(() => socket),
    });
    t.after(() => adapter.dispose());
    const controller = new AbortController();

    const pending = collect(adapter.stream(request("openai-codex"), controller.signal));
    await frameSent;
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(reason);
    const events = await pending;

    assert.equal(traps, 0);
    assert.equal(socket.closeCalls, 1);
    assert.equal(events.at(-1)?.type, "error");
    assert.equal(terminalCount(events), 1);
  });
});
