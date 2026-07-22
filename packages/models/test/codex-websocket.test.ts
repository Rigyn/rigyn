import assert from "node:assert/strict";
import test from "node:test";
import { closeOpenAICodexWebSocketSessions, getOpenAICodexWebSocketDebugStats, resetOpenAICodexWebSocketDebugStats, stream } from "../src/api/openai-codex-responses.js";
import type { Context, Model } from "../src/types.js";

type Listener = (event: unknown) => void;
class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly listeners = new Map<string, Set<Listener>>();
  readonly sent: Array<Record<string, unknown>> = [];
  readonly options: unknown;
  readyState = 0;
  constructor(readonly url: string, options?: unknown) { this.options = options; FakeSocket.instances.push(this); queueMicrotask(() => { this.readyState = 1; this.emit("open", {}); }); }
  addEventListener(type: string, listener: Listener) { const values = this.listeners.get(type) ?? new Set(); values.add(listener); this.listeners.set(type, values); }
  removeEventListener(type: string, listener: Listener) { this.listeners.get(type)?.delete(listener); }
  emit(type: string, event: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  send(data: string) {
    const request = JSON.parse(data) as Record<string, unknown>; this.sent.push(request);
    const responseId = `response-${this.sent.length}`;
    const answer = { role: "assistant", content: [{ type: "output_text", text: `answer-${this.sent.length}`, annotations: [] }] };
    queueMicrotask(() => {
      this.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: responseId } }) });
      this.emit("message", { data: JSON.stringify({ type: "response.output_text.delta", delta: `answer-${this.sent.length}` }) });
      this.emit("message", { data: JSON.stringify({ type: "response.completed", response: { id: responseId, output: [answer], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } }) });
    });
  }
  close() { this.readyState = 3; this.emit("close", { code: 1000, wasClean: true }); }
}

const model: Model<"openai-codex-responses"> = { id: "gpt-test", name: "GPT Test", api: "openai-codex-responses", provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 10_000 };
const firstContext: Context = { messages: [{ role: "user", content: "first", timestamp: 1 }] };

test("Codex cached WebSocket transport reuses a session and sends only the context delta", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: FakeSocket });
  FakeSocket.instances = []; resetOpenAICodexWebSocketDebugStats(); closeOpenAICodexWebSocketSessions();
  try {
    const first = await stream(model, firstContext, { apiKey: "token", headers: { "chatgpt-account-id": "account" }, sessionId: "session", transport: "websocket-cached", maxRetries: 0 }).result();
    assert.equal(first.stopReason, "stop");
    const secondContext: Context = { messages: [...firstContext.messages, first, { role: "user", content: "second", timestamp: 2 }] };
    const second = await stream(model, secondContext, { apiKey: "token", headers: { "chatgpt-account-id": "account" }, sessionId: "session", transport: "websocket-cached", maxRetries: 0 }).result();
    assert.equal(second.stopReason, "stop");
    assert.equal(FakeSocket.instances.length, 1);
    const sent = FakeSocket.instances[0]?.sent ?? [];
    assert.equal(sent.length, 2);
    assert.equal(sent[1]?.previous_response_id, "response-1");
    assert.equal(Array.isArray(sent[1]?.input) ? sent[1].input.length : -1, 1);
    const stats = getOpenAICodexWebSocketDebugStats("session");
    assert.deepEqual(stats && { requests: stats.requests, created: stats.connectionsCreated, reused: stats.connectionsReused, full: stats.fullContextRequests, delta: stats.deltaRequests }, { requests: 2, created: 1, reused: 1, full: 1, delta: 1 });
    const headers = new Headers((FakeSocket.instances[0]?.options as { headers?: Record<string, string> })?.headers);
    assert.equal(headers.get("openai-beta"), "responses_websockets=2026-02-06");
  } finally {
    closeOpenAICodexWebSocketSessions(); resetOpenAICodexWebSocketDebugStats();
    if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor); else delete (globalThis as { WebSocket?: unknown }).WebSocket;
  }
});

test("Codex falls back to SSE before any WebSocket output and records diagnostics", async () => {
  const socketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const originalFetch = globalThis.fetch;
  class BrokenSocket { constructor() { throw new Error("socket unavailable"); } }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: BrokenSocket });
  globalThis.fetch = async () => new Response([
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "fallback" })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "sse", usage: {} } })}\n\n`,
  ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  resetOpenAICodexWebSocketDebugStats();
  try {
    const result = await stream(model, firstContext, { apiKey: "token", headers: { "chatgpt-account-id": "account" }, sessionId: "fallback", transport: "auto", maxRetries: 0 }).result();
    assert.equal(result.stopReason, "stop");
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "fallback");
    const stats = getOpenAICodexWebSocketDebugStats("fallback");
    assert.equal(stats?.websocketFailures, 1); assert.equal(stats?.sseFallbacks, 1); assert.equal(stats?.websocketFallbackActive, true);
  } finally {
    globalThis.fetch = originalFetch; resetOpenAICodexWebSocketDebugStats();
    if (socketDescriptor) Object.defineProperty(globalThis, "WebSocket", socketDescriptor); else delete (globalThis as { WebSocket?: unknown }).WebSocket;
  }
});
