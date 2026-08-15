import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicAdapter } from "../../src/providers/anthropic.js";
import { BedrockAdapter } from "../../src/providers/bedrock.js";
import { GeminiAdapter } from "../../src/providers/gemini.js";
import { OpenAICompatibleAdapter } from "../../src/providers/openai-compatible.js";
import { OpenAIResponsesAdapter } from "../../src/providers/openai-responses.js";
import {
  type FetchLike,
  MAX_PERSISTED_PROVIDER_ERROR_BYTES,
  jsonValueOrString,
  normalizeError,
} from "../../src/providers/transport.js";
import { byteChunks, collect, fakeFetch, request, streamResponse, terminalCount } from "./helpers.js";

test("provider transport safely falls back for hostile JSON candidates", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  assert.equal(jsonValueOrString(cyclic), "[object Object]");

  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      throw new Error("must not run");
    },
  });
  assert.equal(jsonValueOrString(accessor), "[object Object]");

  let conversions = 0;
  const conversion = {
    toString() {
      conversions += 1;
      return "hostile conversion";
    },
  };
  assert.equal(jsonValueOrString(conversion), "[object Object]");
  assert.equal(conversions, 0);
});

test("provider transport normalizes hostile thrown values without inspection", () => {
  let traps = 0;
  const failure = new Proxy(new Error("provider failed"), {
    getPrototypeOf() {
      traps += 1;
      throw new Error("provider failure was inspected");
    },
  });

  const normalized = normalizeError("custom", failure, {
    partial: false,
    signal: new AbortController().signal,
  });

  assert.equal(traps, 0);
  assert.equal(normalized.category, "provider");
  assert.equal(normalized.message, "custom: [Thrown object]");
  assert.equal(normalized.retryable, false);
});

test("first-party SDK adapters contain hostile host fetch failures", async (t) => {
  const cases = [
    {
      name: "OpenAI sync throw",
      provider: "openai" as const,
      asyncFailure: false,
      create: (fetch: FetchLike) => new OpenAIResponsesAdapter({ apiKey: "fixture", fetch }),
    },
    {
      name: "Anthropic async rejection",
      provider: "anthropic" as const,
      asyncFailure: true,
      create: (fetch: FetchLike) => new AnthropicAdapter({ apiKey: "fixture", fetch }),
    },
    {
      name: "Gemini sync throw",
      provider: "gemini" as const,
      asyncFailure: false,
      create: (fetch: FetchLike) => new GeminiAdapter({ apiKey: "fixture", fetch }),
    },
    {
      name: "Bedrock async rejection",
      provider: "bedrock" as const,
      asyncFailure: true,
      create: (fetch: FetchLike) => new BedrockAdapter({
        region: "us-east-1",
        credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
        fetch,
      }),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      let traps = 0;
      const hostile = new Proxy(Object.create(null) as object, {
        get() {
          traps += 1;
          throw new Error("property trap");
        },
        getOwnPropertyDescriptor() {
          traps += 1;
          throw new Error("descriptor trap");
        },
        getPrototypeOf() {
          traps += 1;
          throw new Error("prototype trap");
        },
        ownKeys() {
          traps += 1;
          throw new Error("keys trap");
        },
      });
      const fetch = (entry.asyncFailure
        ? async () => { throw hostile; }
        : () => { throw hostile; }) as FetchLike;
      const events = await collect(entry.create(fetch).stream(
        request(entry.provider),
        new AbortController().signal,
      ));
      const terminal = events.at(-1);

      assert.equal(terminal?.type, "error");
      assert.equal(traps, 0);
      if (terminal?.type === "error") assert.doesNotMatch(terminal.error.message, /trap/u);
    });
  }

  await t.test("OpenAI branded Error accessors", async () => {
    let traps = 0;
    const hostile = new Error();
    Object.defineProperty(hostile, "message", {
      get() {
        traps += 1;
        throw new Error("message trap");
      },
    });
    Object.defineProperty(hostile, Symbol.toPrimitive, {
      get() {
        traps += 1;
        throw new Error("coercion trap");
      },
    });
    const adapter = new OpenAIResponsesAdapter({
      apiKey: "fixture",
      fetch: (() => { throw hostile; }) as FetchLike,
    });
    const events = await collect(adapter.stream(request("openai"), new AbortController().signal));
    const terminal = events.at(-1);

    assert.equal(terminal?.type, "error");
    assert.equal(traps, 0);
    if (terminal?.type === "error") assert.doesNotMatch(terminal.error.message, /trap/u);
  });
});

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

test("HTTP retry headers control normalized retry guidance without transport retries", async (t) => {
  const run = async (
    status: number,
    headers: Record<string, string>,
  ): Promise<{ attempts: number; retryable?: boolean; retryAfterMs?: number }> => {
    let attempts = 0;
    const adapter = new OpenAICompatibleAdapter({
      baseUrl: "https://compatible.example/v1",
      fetch: fakeFetch(() => {
        attempts += 1;
        return new Response("provider failure", { status, headers });
      }),
    });
    const events = await collect(adapter.stream(request("openai-compatible"), new AbortController().signal));
    const failure = events.at(-1);
    assert.equal(failure?.type, "error");
    return {
      attempts,
      ...(failure?.type === "error"
        ? { retryable: failure.error.retryable, retryAfterMs: failure.error.retryAfterMs }
        : {}),
    };
  };

  await t.test("false overrides a normally retryable status", async () => {
    assert.deepEqual(await run(500, {
      "x-should-retry": "false",
      "retry-after-ms": "12",
      "retry-after": "9",
    }), { attempts: 1, retryable: false, retryAfterMs: 12 });
  });

  await t.test("true overrides a normally final status", async () => {
    assert.deepEqual(await run(400, {
      "x-should-retry": "true",
      "retry-after-ms": "0",
    }), { attempts: 1, retryable: true, retryAfterMs: 0 });
  });
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
      sequence_number: 1,
    })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.reasoning_summary_text.delta",
      item_id: "reasoning-1",
      output_index: 0,
      summary_index: 0,
      delta: "Checking the implementation",
      sequence_number: 2,
    })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.reasoning_summary_text.done",
      item_id: "reasoning-1",
      output_index: 0,
      summary_index: 0,
      text: "Checking the implementation",
      sequence_number: 3,
    })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.reasoning_summary_part.done",
      item_id: "reasoning-1",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "Checking the implementation" },
      sequence_number: 4,
    })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "r", model: "m" } })}\n\n`,
  ].join("");
  const adapter = new OpenAIResponsesAdapter({
    fetch: fakeFetch(() => streamResponse(byteChunks(body))),
  });

  const events = await collect(adapter.stream(request("openai"), new AbortController().signal));

  assert.equal(events.some((event) => event.type === "unknown_provider_event"), false);
  assert.equal(JSON.stringify(events).includes("must-not-surface"), false);
  assert.deepEqual(events.filter((event) => event.type === "reasoning_delta"), [{
    type: "reasoning_delta",
    part: 0,
    text: "Checking the implementation",
    visibility: "summary",
  }]);
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
