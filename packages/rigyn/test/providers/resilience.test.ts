import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleAdapter } from "../../src/providers/openai-compatible.js";
import { OpenAIResponsesAdapter } from "../../src/providers/openai-responses.js";
import { MAX_PERSISTED_PROVIDER_ERROR_BYTES } from "../../src/providers/transport.js";
import { byteChunks, collect, fakeFetch, request, streamResponse, terminalCount } from "./helpers.js";

test("HTTP errors are normalized once and adapters never retry", async () => {
  let attempts = 0;
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => {
      attempts += 1;
      return new Response(JSON.stringify({ error: { code: "rate_limit", message: "slow down" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "2", "x-request-id": "req-rate" },
      });
    }),
  });
  const events = await collect(adapter.stream(request("openai-compatible"), new AbortController().signal));
  assert.equal(attempts, 1);
  assert.equal(terminalCount(events), 1);
  const error = events[0];
  assert.equal(error?.type, "error");
  if (error?.type === "error") {
    assert.equal(error.error.category, "rate_limit");
    assert.equal(error.error.retryAfterMs, 2000);
    assert.equal(error.error.requestId, "req-rate");
    assert.equal(error.error.partial, false);
  }
});

test("nested gateway reasons are deduplicated while oversized raw errors are summarized", async () => {
  const nested = JSON.stringify({
    error: { code: "context_length_exceeded", message: "Actual upstream context window exceeded" },
  });
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => new Response(JSON.stringify({
      error: {
        code: "gateway_error",
        message: "Provider returned an error",
        metadata: { raw: nested, diagnostic: "x".repeat(32 * 1024) },
      },
    }), {
      status: 400,
      headers: { "content-type": "application/json", "x-request-id": "req-nested" },
    })),
  });
  const events = await collect(adapter.stream(request("openai-compatible"), new AbortController().signal));
  const failure = events.at(-1);
  assert.equal(failure?.type, "error");
  if (failure?.type !== "error") return;
  assert.match(failure.error.message, /Provider returned an error/u);
  assert.match(failure.error.message, /Actual upstream context window exceeded/u);
  assert.equal(failure.error.message.match(/Actual upstream context window exceeded/gu)?.length, 1);
  assert.equal(failure.error.requestId, "req-nested");
  assert.equal(failure.error.providerCode, "context_length_exceeded");
  assert.ok(Buffer.byteLength(JSON.stringify(failure.error.raw), "utf8") <= MAX_PERSISTED_PROVIDER_ERROR_BYTES);
  assert.deepEqual(failure.error.raw, {
    truncated: true,
    originalBytes: Buffer.byteLength(JSON.stringify({
      error: {
        code: "gateway_error",
        message: "Provider returned an error",
        metadata: { raw: nested, diagnostic: "x".repeat(32 * 1024) },
      },
    })),
    summary: "Provider returned an error: Actual upstream context window exceeded",
  });
});

test("an already-aborted request produces one cancelled terminal event", async () => {
  const controller = new AbortController();
  controller.abort();
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch((incoming) => {
      assert.equal(incoming.signal.aborted, true);
      throw new DOMException("aborted", "AbortError");
    }),
  });
  const events = await collect(adapter.stream(request("openai-compatible"), controller.signal));
  assert.equal(terminalCount(events), 1);
  assert.equal(events[0]?.type === "error" ? events[0].error.category : undefined, "cancelled");
});

test("unknown provider events are preserved without preventing a valid terminal", async () => {
  const body = [
    `data: ${JSON.stringify({ type: "response.created", response: { id: "r", model: "m" } })}\n\n`,
    `event: response.future_event\ndata: ${JSON.stringify({ type: "response.future_event", value: { future: true } })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "r", model: "m" } })}\n\n`,
  ].join("");
  const adapter = new OpenAIResponsesAdapter({
    fetch: fakeFetch(() => streamResponse(byteChunks(body))),
  });
  const events = await collect(adapter.stream(request("openai"), new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  const unknown = events.find((event) => event.type === "unknown_provider_event");
  assert.equal(unknown?.type, "unknown_provider_event");
  if (unknown?.type === "unknown_provider_event") {
    assert.deepEqual(unknown.raw, { type: "response.future_event", value: { future: true } });
  }
});

test("documented Responses reasoning-summary boundaries do not surface as unknown events", async () => {
  const body = [
    `data: ${JSON.stringify({ type: "response.created", response: { id: "r", model: "m" } })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.metadata",
      metadata: { moderation: { flagged: false }, private_marker: "must-not-surface" },
    })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.reasoning_summary_part.added",
      item_id: "reasoning-1",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.reasoning_summary_text.delta",
      item_id: "reasoning-1",
      output_index: 0,
      summary_index: 0,
      delta: "Checking the implementation",
    })}\n\n`,
    `data: ${JSON.stringify({ type: "response.reasoning_summary_text.done", item_id: "reasoning-1", summary_index: 0 })}\n\n`,
    `data: ${JSON.stringify({ type: "response.reasoning_summary_part.done", item_id: "reasoning-1", summary_index: 0 })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "r", model: "m" } })}\n\n`,
  ].join("");
  const adapter = new OpenAIResponsesAdapter({
    fetch: fakeFetch(() => streamResponse(byteChunks(body))),
  });

  const events = await collect(adapter.stream(request("openai"), new AbortController().signal));

  assert.equal(events.some((event) => event.type === "unknown_provider_event"), false);
  assert.equal(JSON.stringify(events).includes("must-not-surface"), false);
  assert.deepEqual(events.find((event) => event.type === "reasoning_delta"), {
    type: "reasoning_delta",
    part: 0,
    text: "Checking the implementation",
    visibility: "summary",
  });
  assert.equal(terminalCount(events), 1);
});

test("malformed midstream SSE becomes a partial protocol error", async () => {
  const body = [
    `data: ${JSON.stringify({ id: "c", model: "m", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })}\n\n`,
    "data: {not-json}\n\n",
  ].join("");
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: "https://compatible.example/v1",
    fetch: fakeFetch(() => streamResponse(byteChunks(body))),
  });
  const events = await collect(adapter.stream(request("openai-compatible"), new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  const error = events.at(-1);
  assert.equal(error?.type === "error" ? error.error.category : undefined, "protocol");
  assert.equal(error?.type === "error" ? error.error.partial : undefined, true);
});
