import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenAICodexResponsesBody,
  OpenAICodexResponsesAdapter,
  openAICodexModels,
} from "../../src/providers/openai-codex-responses.js";
import type { NetworkWebSocket, NetworkWebSocketFactory } from "../../src/net/index.js";
import type { ProviderRequest, ProviderState } from "../../src/core/types.js";
import {
  ProviderWireInterceptorRegistry,
  type ProviderWireRequest,
  type ProviderWireResponse,
} from "../../src/providers/wire.js";
import { collect, fakeFetch, request, streamResponse, terminalCount } from "./helpers.js";

function sse(...values: unknown[]): Uint8Array[] {
  return values.map((value) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
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

function completed(socket: FakeWebSocket, id: string, text = "done"): void {
  queueMicrotask(() => {
    socket.message({ type: "response.created", response: { id, model: "gpt-5.5" } });
    if (text !== "") socket.message({ type: "response.output_text.delta", content_index: 0, delta: text });
    socket.message({
      type: "response.completed",
      response: { id, model: "gpt-5.5", usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } },
    });
  });
}

test("OpenAI Codex adapter ships an explicit current model catalog with a stable default", async () => {
  const models = openAICodexModels("2026-07-10T00:00:00.000Z");
  assert.equal(models.length, 7);
  assert.equal(models.some((model) => model.id === "gpt-5.5"), true);
  assert.equal(models.every((model) => model.provider === "openai-codex"), true);
  assert.deepEqual(models.find((model) => model.id === "gpt-5.5")?.compatibility?.reasoningEfforts?.value, [
    "off", "minimal", "low", "medium", "high", "xhigh",
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
  assert.equal(body.prompt_cache_options, undefined);
  assert.equal(body.prompt_cache_retention, undefined);
  assert.equal(JSON.stringify(body.input).includes("Be exact."), false);
});

test("OpenAI Codex adapter sends isolated subscription credentials and normalizes the Responses stream", async () => {
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
      assert.equal(incoming.headers.get("session-id"), "session-codex");
      assert.equal(incoming.headers.get("x-client-request-id"), "session-codex");
      posted = await incoming.json() as Record<string, unknown>;
      return streamResponse(sse(
        { type: "response.created", response: { id: "codex-response", model: "gpt-5.5" } },
        { type: "response.output_text.delta", content_index: 0, delta: "done" },
        {
          type: "response.completed",
          response: {
            id: "codex-response",
            model: "gpt-5.5",
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 8 } },
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
  assert.equal(events.at(-1)?.type, "response_end");
  assert.equal(posted?.model, "gpt-5.5");
  assert.equal(credentialCalls, 1);

  const models = await adapter.listModels(new AbortController().signal);
  assert.equal(models.length, 7);
  assert.equal(credentialCalls, 1, "the bundled model catalog must not make a credential or network request");
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
  const baseFactory = socketFactory(() => socket);
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket",
    webSocket: ((url, headers) => {
      websocketUrl = String(url);
      authorization = new Headers(headers).get("authorization") ?? "";
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
  assert.equal(socket.sent[0]?.type, "response.create");
  assert.equal(socket.sent[0]?.stream, undefined);
  assert.equal(socket.sent[0]?.background, undefined);
  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "done"), true);
  const end = events.find((event) => event.type === "response_end");
  assert.equal(end?.type === "response_end" ? end.state.kind === "openai_responses" && end.state.previousResponseId : undefined, "response-ws");
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

test("cached Codex WebSocket continuation reuses one socket and sends only new input", async (t) => {
  const socket = new FakeWebSocket();
  socket.onSend = () => completed(socket, socket.sent.length === 1 ? "response-one" : "response-two", "");
  let factoryCalls = 0;
  const wirePhases: Array<ProviderWireRequest["phase"]> = [];
  const wire = new ProviderWireInterceptorRegistry();
  wire.register("openai-codex", {
    interceptRequest(observed) {
      wirePhases.push(observed.phase);
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
      { id: "assistant-1", role: "assistant", content: [{ type: "text", text: "ready" }], createdAt: "2026-07-10T00:00:01.000Z" },
      { id: "user-2", role: "user", content: [{ type: "text", text: "continue" }], createdAt: "2026-07-10T00:00:02.000Z" },
    ],
  };
  const secondEvents = await collect(adapter.stream(second, new AbortController().signal));
  assert.equal(terminalCount(secondEvents), 1);
  assert.equal(factoryCalls, 1);
  assert.deepEqual(wirePhases, ["handshake", "frame", "frame"]);
  assert.equal(socket.sent[1]?.previous_response_id, "response-one");
  assert.deepEqual(socket.sent[1]?.input, [{ role: "user", content: "continue" }]);
});

test("auto Codex transport falls back to full-context SSE only before WebSocket events", async () => {
  let fetchCalls = 0;
  let posted: Record<string, unknown> | undefined;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: (() => { throw new TypeError("websocket unavailable"); }) as NetworkWebSocketFactory,
    fetch: fakeFetch(async (incoming) => {
      fetchCalls += 1;
      posted = await incoming.json() as Record<string, unknown>;
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

test("auto Codex transport never replays through SSE after a WebSocket response starts", async (t) => {
  const socket = new FakeWebSocket();
  socket.onSend = () => queueMicrotask(() => {
    socket.message({ type: "response.created", response: { id: "partial", model: "gpt-5.5" } });
    socket.close(1011, "upstream failed");
  });
  let fetchCalls = 0;
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "auto",
    webSocket: socketFactory(() => socket),
    fetch: fakeFetch(() => {
      fetchCalls += 1;
      throw new Error("unsafe replay");
    }),
  });
  t.after(() => adapter.dispose());
  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));
  assert.equal(fetchCalls, 0);
  assert.equal(events.at(-1)?.type, "error");
});

test("Codex WebSocket retries one connection-limit event before producing output", async (t) => {
  const first = new FakeWebSocket();
  first.onSend = () => queueMicrotask(() => first.message({
    type: "error",
    error: { code: "websocket_connection_limit_reached", message: "reconnect" },
  }));
  const second = new FakeWebSocket();
  second.onSend = () => completed(second, "response-retried", "ok");
  const sockets = [first, second];
  const adapter = new OpenAICodexResponsesAdapter({
    credential: async () => ({ accessToken: "subscription-access", accountId: "chatgpt-account" }),
    transport: "websocket",
    webSocket: socketFactory(() => sockets.shift()!),
  });
  t.after(() => adapter.dispose());
  const events = await collect(adapter.stream(request("openai-codex"), new AbortController().signal));
  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "ok"), true);
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
