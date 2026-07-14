import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAISdkEventStream } from "../../src/providers/openai-sdk-transport.js";
import {
  OpenAIResponsesAdapter,
  type ResponsesEventStreamInput,
  type ResponsesWireEvent,
} from "../../src/providers/openai-responses.js";
import { ProtocolError } from "../../src/providers/transport.js";
import { byteChunks, collect, fakeFetch, request, streamResponse, terminalCount } from "./helpers.js";

function sse(...values: unknown[]): string {
  return values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
}

async function* unexpectedFallback(_input: ResponsesEventStreamInput): AsyncGenerator<ResponsesWireEvent> {
  throw new Error("unexpected direct transport fallback");
}

function directWireEvent(value: unknown, requestId?: string): ResponsesWireEvent {
  assert.equal(value !== undefined, true);
  return { data: "typed-sdk-event", ...(requestId === undefined ? {} : { requestId }) };
}

function sdkInput(
  fetchImplementation: typeof fetch,
  body: Record<string, unknown> = { model: "gpt-test", input: "hello", stream: true, store: false },
  signal = new AbortController().signal,
): ResponsesEventStreamInput {
  return {
    url: "https://api.openai.com/v1/responses",
    headers: new Headers({
      accept: "text/event-stream",
      authorization: "Bearer resolved-secret",
      "content-type": "application/json",
    }),
    body,
    request: request("openai"),
    signal,
    fetch: fetchImplementation,
  };
}

async function wireEvents(iterable: AsyncIterable<ResponsesWireEvent>): Promise<ResponsesWireEvent[]> {
  const events: ResponsesWireEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test("first-party SDK transport uses resolved authorization, zero retries, sanitized JSON, and request IDs", async () => {
  let attempts = 0;
  let sdkLoads = 0;
  let posted: Record<string, unknown> | undefined;
  const typedEvents: unknown[] = [];
  const fetchImplementation = fakeFetch(async (incoming) => {
    attempts += 1;
    assert.equal(incoming.redirect, "error");
    assert.equal(incoming.headers.get("authorization"), "Bearer resolved-secret");
    assert.equal(incoming.headers.get("authorization")?.includes("never-send"), false);
    assert.equal(incoming.headers.get("x-stainless-retry-count"), "0");
    posted = await incoming.json() as Record<string, unknown>;
    return streamResponse(byteChunks(sse(
      { type: "response.created", response: { id: "response-sdk", model: "gpt-test" } },
      { type: "response.completed", response: { id: "response-sdk", model: "gpt-test" } },
    ), [1, 2, 3, 5, 8]), { "content-type": "text/event-stream", "x-request-id": "req-sdk" });
  });
  const stream = createOpenAISdkEventStream({
    baseUrl: "https://api.openai.com/v1",
    fetch: fetchImplementation,
    fallback: unexpectedFallback,
    eventFromValue: (value, requestId) => {
      typedEvents.push(value);
      return directWireEvent(value, requestId);
    },
    loadSdk: async () => {
      sdkLoads += 1;
      return import("openai");
    },
  });
  const pending = stream(sdkInput(fetchImplementation, {
    model: "gpt-test",
    input: "hello",
    metadata: { unsafe: "\ud800" },
    stream: true,
    store: false,
  }));
  assert.equal(sdkLoads, 0, "constructing the stream must not load the SDK");
  const events = await wireEvents(pending);

  assert.equal(attempts, 1);
  assert.equal(sdkLoads, 1);
  assert.equal((posted?.metadata as Record<string, unknown> | undefined)?.unsafe, "�");
  assert.equal(events.length, 2);
  assert.equal(events.every((event) => event.data === "typed-sdk-event"), true);
  assert.deepEqual(typedEvents.map((event) => (event as { type?: string }).type), [
    "response.created",
    "response.completed",
  ]);
  assert.equal(events.every((event) => event.requestId === "req-sdk"), true);
});

test("custom endpoints and missing authorization retain the direct transport", async (t) => {
  await t.test("custom endpoint", async () => {
    let sdkHeader: string | null = null;
    const adapter = new OpenAIResponsesAdapter({
      apiKey: "custom-secret",
      baseUrl: "https://compatible.example/v1",
      fetch: fakeFetch((incoming) => {
        sdkHeader = incoming.headers.get("x-stainless-retry-count");
        return streamResponse(byteChunks(sse(
          { type: "response.created", response: { id: "custom", model: "gpt-test" } },
          { type: "response.completed", response: { id: "custom", model: "gpt-test" } },
        )));
      }),
    });
    const events = await collect(adapter.stream(request("openai"), new AbortController().signal));
    assert.equal(terminalCount(events), 1);
    assert.equal(sdkHeader, null);
  });

  await t.test("no authorization", async () => {
    let authorization: string | null = null;
    let sdkHeader: string | null = null;
    const adapter = new OpenAIResponsesAdapter({
      fetch: fakeFetch((incoming) => {
        authorization = incoming.headers.get("authorization");
        sdkHeader = incoming.headers.get("x-stainless-retry-count");
        return streamResponse(byteChunks(sse(
          { type: "response.created", response: { id: "anonymous", model: "gpt-test" } },
          { type: "response.completed", response: { id: "anonymous", model: "gpt-test" } },
        )));
      }),
    });
    const events = await collect(adapter.stream(request("openai"), new AbortController().signal));
    assert.equal(terminalCount(events), 1);
    assert.equal(authorization, null);
    assert.equal(sdkHeader, null);
  });

  await t.test("no authorization does not load the SDK", async () => {
    let fallbackCalls = 0;
    let sdkLoads = 0;
    const fetchImplementation = fakeFetch(() => {
      throw new Error("network must not be called by the SDK path");
    });
    const stream = createOpenAISdkEventStream({
      baseUrl: "https://api.openai.com/v1",
      fetch: fetchImplementation,
      fallback: async function* () {
        fallbackCalls += 1;
        yield { data: "fallback" };
      },
      eventFromValue: directWireEvent,
      loadSdk: async () => {
        sdkLoads += 1;
        return import("openai");
      },
    });
    const input = sdkInput(fetchImplementation);
    input.headers.delete("authorization");
    const events = await wireEvents(stream(input));
    assert.deepEqual(events, [{ data: "fallback" }]);
    assert.equal(fallbackCalls, 1);
    assert.equal(sdkLoads, 0);
  });
});

test("SDK transport keeps bounded HTTP errors and does not retry", async () => {
  let attempts = 0;
  const adapter = new OpenAIResponsesAdapter({
    apiKey: "secret",
    fetch: fakeFetch(() => {
      attempts += 1;
      return new Response(JSON.stringify({ error: { code: "rate_limit", message: "slow down" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "2", "x-request-id": "req-rate" },
      });
    }),
  });
  const events = await collect(adapter.stream(request("openai"), new AbortController().signal));
  assert.equal(attempts, 1);
  assert.equal(terminalCount(events), 1);
  const failure = events.at(-1);
  assert.equal(failure?.type, "error");
  if (failure?.type !== "error") return;
  assert.equal(failure.error.category, "rate_limit");
  assert.equal(failure.error.httpStatus, 429);
  assert.equal(failure.error.retryAfterMs, 2_000);
  assert.equal(failure.error.requestId, "req-rate");
});

test("SDK pass-through rejects oversized events and invalid UTF-8", async (t) => {
  await t.test("event bound across CRLF chunks", async () => {
    const source = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(80) })}\r\n\r\n`;
    const fetchImplementation = fakeFetch(() => streamResponse(byteChunks(source, [1, 3, 2, 5, 8])));
    const stream = createOpenAISdkEventStream({
      baseUrl: "https://api.openai.com/v1",
      fetch: fetchImplementation,
      fallback: unexpectedFallback,
      eventFromValue: directWireEvent,
      maxSseEventBytes: 48,
    });
    await assert.rejects(async () => {
      for await (const _event of stream(sdkInput(fetchImplementation))) {
        // Consume the stream.
      }
    }, (error: unknown) => error instanceof ProtocolError && /SSE event exceeded 48 bytes/u.test(error.message));
  });

  await t.test("invalid split UTF-8", async () => {
    const prefix = new TextEncoder().encode("data: ");
    const suffix = new TextEncoder().encode("\n\n");
    const malformed = new Uint8Array(prefix.length + 1 + suffix.length);
    malformed.set(prefix);
    malformed[prefix.length] = 0xff;
    malformed.set(suffix, prefix.length + 1);
    const fetchImplementation = fakeFetch(() => streamResponse([
      malformed.slice(0, prefix.length),
      malformed.slice(prefix.length),
    ]));
    const stream = createOpenAISdkEventStream({
      baseUrl: "https://api.openai.com/v1",
      fetch: fetchImplementation,
      fallback: unexpectedFallback,
      eventFromValue: directWireEvent,
    });
    await assert.rejects(async () => {
      for await (const _event of stream(sdkInput(fetchImplementation))) {
        // Consume the stream.
      }
    }, (error: unknown) => error instanceof ProtocolError && /invalid UTF-8/u.test(error.message));
  });
});

test("malformed SDK stream remains a partial protocol error with its request ID", async () => {
  const body = [
    `data: ${JSON.stringify({ type: "response.created", response: { id: "partial", model: "gpt-test" } })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", content_index: 0, delta: "partial" })}\n\n`,
    "data: {not-json}\n\n",
  ].join("");
  const adapter = new OpenAIResponsesAdapter({
    apiKey: "secret",
    fetch: fakeFetch(() => streamResponse(byteChunks(body), {
      "content-type": "text/event-stream",
      "x-request-id": "req-partial",
    })),
  });
  const events = await collect(adapter.stream(request("openai"), new AbortController().signal));
  const failure = events.at(-1);
  assert.equal(failure?.type, "error");
  if (failure?.type !== "error") return;
  assert.equal(failure.error.category, "protocol");
  assert.equal(failure.error.partial, true);
  assert.equal(failure.error.requestId, "req-partial");
});

test("SDK streamed provider errors retain request IDs", async () => {
  const adapter = new OpenAIResponsesAdapter({
    apiKey: "secret",
    fetch: fakeFetch(() => streamResponse(byteChunks(sse({
      type: "error",
      error: { code: "rate_limit_exceeded", message: "slow down" },
    })), { "content-type": "text/event-stream", "x-request-id": "req-stream-error" })),
  });
  const events = await collect(adapter.stream(request("openai"), new AbortController().signal));
  const failure = events.at(-1);
  assert.equal(failure?.type, "error");
  if (failure?.type !== "error") return;
  assert.equal(failure.error.category, "rate_limit");
  assert.equal(failure.error.providerCode, "rate_limit_exceeded");
  assert.equal(failure.error.requestId, "req-stream-error");
});

test("SDK and direct transports normalize the same complex response identically", async () => {
  const body = sse(
    { type: "response.created", response: { id: "response-parity", model: "gpt-test" } },
    { type: "response.reasoning_summary_text.delta", summary_index: 0, delta: "plan" },
    { type: "response.output_text.delta", content_index: 0, delta: "hello" },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", id: "item-1", call_id: "call-1", name: "read", arguments: "" },
    },
    { type: "response.function_call_arguments.delta", item_id: "item-1", output_index: 1, delta: '{"path":"' },
    { type: "response.function_call_arguments.delta", item_id: "item-1", output_index: 1, delta: 'README.md"}' },
    {
      type: "response.function_call_arguments.done",
      item_id: "item-1",
      output_index: 1,
      arguments: '{"path":"README.md"}',
    },
    {
      type: "response.completed",
      response: {
        id: "response-parity",
        model: "gpt-test",
        output: [],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: { cached_tokens: 60 },
          output_tokens_details: { reasoning_tokens: 5 },
        },
      },
    },
  );
  const posted: unknown[] = [];
  const transport = () => fakeFetch(async (incoming) => {
    posted.push(await incoming.json());
    return streamResponse(
      byteChunks(body, [1, 2, 3, 5, 8, 13]),
      { "content-type": "text/event-stream", "x-request-id": "request-parity" },
    );
  });
  const sdk = new OpenAIResponsesAdapter({ apiKey: "secret", fetch: transport() });
  const direct = new OpenAIResponsesAdapter({
    apiKey: "secret",
    baseUrl: "https://compatible.example/v1",
    fetch: transport(),
  });

  const sdkEvents = await collect(sdk.stream(request("openai"), new AbortController().signal));
  const directEvents = await collect(direct.stream(request("openai"), new AbortController().signal));

  assert.deepEqual(posted[0], posted[1]);
  assert.deepEqual(sdkEvents, directEvents);
});
