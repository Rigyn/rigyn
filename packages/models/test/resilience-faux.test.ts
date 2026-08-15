import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantMessageEventStream,
  EventStream,
  InMemoryCredentialStore,
  createAssistantMessageDiagnostic,
  createAssistantMessageEventStream,
  createFauxTransport,
  errorAssistantMessage,
  fauxModel,
  getOverflowPatterns,
  grammarSampling,
  isContextOverflowText,
  retryAssistantCall,
  parseJsonWithRepair,
  parseStreamingJson,
  repairJson,
  sanitizeUnicode,
  strictToolValue,
} from "../src/index.ts";
import type { Tool } from "../src/index.ts";
import { fetchEventStream, parseEventStream } from "../src/http-engine.ts";
import { collect, userContext } from "./black-box-helpers.ts";

test("context overflow matchers are bounded, fresh, and isolated from caller mutation", () => {
  const first = getOverflowPatterns();
  const second = getOverflowPatterns();
  assert.notStrictEqual(first, second);
  assert.equal(first.length > 0, true);
  assert.equal(first.every((pattern, index) => pattern !== second[index]), true);
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => (first as RegExp[]).push(/overflow/u), TypeError);

  first[0]!.lastIndex = 99;
  assert.equal(second[0]!.lastIndex, 0);
  assert.equal(isContextOverflowText("This model's maximum context length is 128000 tokens"), true);
  assert.equal(isContextOverflowText("Input tokens exceed the model token limit"), true);
  assert.equal(isContextOverflowText("413 status code (no body)"), true);
  assert.equal(isContextOverflowText("tokens per minute limit exceeded"), false);
  assert.equal(isContextOverflowText(`${"x".repeat(4_096)}maximum context length`), false);
});

test("public compatibility values preserve constructor and credential-store identity", () => {
  const events = new EventStream<{ done: boolean; value: number }, number>(
    (event) => event.done,
    (event) => event.value,
  );
  assert.equal(events instanceof EventStream, true);
  assert.equal(new AssistantMessageEventStream() instanceof EventStream, true);
  assert.equal(new InMemoryCredentialStore().constructor.name, "MemoryCredentialStore");
});

test("assistant diagnostics retain safe error fields without copying stacks", () => {
  const error = Object.assign(new Error("provider failed"), { code: 429 });
  error.stack = "private stack";
  const diagnostic = createAssistantMessageDiagnostic("provider_failure", error, { attempt: 2 });
  assert.equal(Number.isFinite(diagnostic.timestamp), true);
  assert.deepEqual({ ...diagnostic, timestamp: 0 }, {
    type: "provider_failure",
    timestamp: 0,
    error: { message: "provider failed", code: 429 },
    details: { attempt: 2 },
  });
});

test("retryAssistantCall retries transient failures but never quota failures", async () => {
  let attempts = 0;
  const lifecycle: string[] = [];
  const recovered = await retryAssistantCall(async () => {
    attempts += 1;
    return attempts === 1
      ? errorAssistantMessage("HTTP 503 temporary overload")
      : { ...errorAssistantMessage("unused"), stopReason: "stop", errorMessage: undefined };
  }, { enabled: true, maxRetries: 2, baseDelayMs: 0 }, undefined, {
    onRetryScheduled(attempt) { lifecycle.push(`scheduled:${attempt}`); },
    onRetryAttemptStart(attempt) { lifecycle.push(`started:${attempt}`); },
    onRetryFinished(success, attempt) { lifecycle.push(`finished:${success}:${attempt}`); },
  });
  assert.equal(recovered.stopReason, "stop");
  assert.equal(attempts, 2);
  assert.deepEqual(lifecycle, ["scheduled:1", "started:1", "finished:true:1"]);

  attempts = 0;
  const quota = await retryAssistantCall(async () => {
    attempts += 1;
    return errorAssistantMessage("insufficient_quota: add credits");
  }, { enabled: true, maxRetries: 3, baseDelayMs: 0 });
  assert.equal(quota.stopReason, "error");
  assert.equal(attempts, 1);
});

test("retry delay cancellation returns an aborted result without the prior error", async () => {
  const controller = new AbortController();
  const result = await retryAssistantCall(async () => errorAssistantMessage("HTTP 503"), {
    enabled: true,
    maxRetries: 1,
    baseDelayMs: 1_000,
  }, controller.signal, {
    onRetryScheduled() { controller.abort(); },
  });
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.errorMessage, undefined);
});

test("HTTP retry and timer options reject unsafe bounds before a request", async () => {
  let called = false;
  await assert.rejects(fetchEventStream({
    url: "https://provider.example/stream",
    body: {},
    options: {
      maxRetries: 11,
      fetch: async () => {
        called = true;
        return new Response();
      },
    },
  }), /maxRetries/u);
  assert.equal(called, false);

  await assert.rejects(fetchEventStream({
    url: "https://provider.example/stream",
    body: {},
    options: { timeoutMs: -1, fetch: async () => new Response() },
  }), /timeoutMs/u);
});

test("SSE parsing rejects an unbounded single event", async () => {
  const oversized = new TextEncoder().encode(`data: ${"x".repeat(8 * 1024 * 1024 + 1)}`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(oversized);
      controller.close();
    },
  });
  await assert.rejects(async () => {
    for await (const _event of parseEventStream(stream)) {
      // The parser must reject before yielding an oversized record.
    }
  }, /8 MiB/u);
});

test("SSE parsing enforces the byte limit for each coalesced record", async () => {
  const encoded = new TextEncoder().encode([
    "data: ok\n\n",
    `data: ${"x".repeat(8 * 1024 * 1024 + 1)}\n\n`,
  ].join(""));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  const iterator = parseEventStream(stream)[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { event: "message", data: "ok" },
  });
  await assert.rejects(iterator.next(), /8 MiB/u);
});

test("closing SSE iteration early cancels and unlocks its live reader once", async () => {
  let cancellations = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\n\n"));
    },
    cancel() {
      cancellations += 1;
    },
  });
  for await (const event of parseEventStream(stream)) {
    assert.equal(event.data, "first");
    break;
  }
  assert.equal(cancellations, 1);
  assert.equal(stream.locked, false);
});

test("SSE parsing preserves a UTF-8 record fragmented into one-byte chunks", async () => {
  const payload = new TextEncoder().encode(`event: fragment\ndata: ${"😀x".repeat(16_384)}\n\n`);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === payload.length) {
        controller.close();
        return;
      }
      controller.enqueue(payload.subarray(offset, offset + 1));
      offset += 1;
    },
  });
  const events = [];
  for await (const event of parseEventStream(stream)) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, "fragment");
  assert.equal(events[0]?.data, "😀x".repeat(16_384));
});

test("SSE parsing bounds ignored framed records as well as yielded events", async () => {
  const payload = new TextEncoder().encode(": ignored\n\n".repeat(65_537));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
  await assert.rejects(async () => {
    for await (const _event of parseEventStream(stream)) {
      // Comment-only records still count toward the protocol resource limit.
    }
  }, /65536 events/u);
});

test("Faux is deterministic and rejoins split surrogate pairs safely", async () => {
  const transport = createFauxTransport(() => ({ text: ["A\uD83D", "\uDE00B"] }));
  const left = await collect(transport(fauxModel, userContext(), {}));
  const right = await collect(transport(fauxModel, userContext(), {}));
  assert.deepEqual(left, right);
  assert.deepEqual(left.terminal.content, [{ type: "text", text: "A😀B" }]);
  assert.equal(sanitizeUnicode("x\uD800y\uDC00"), "x�y�");
});

test("Faux publishes only canonical usage and derives trusted totals and costs", async () => {
  const pricedModel = {
    ...fauxModel,
    cost: { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
  };
  const result = await collect(createFauxTransport(() => ({
    usage: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 999,
      cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99, total: 396 },
    },
  }))(pricedModel, userContext(), {}));
  const start = result.events[0];
  assert.equal(start?.type, "start");
  if (start?.type !== "start") return;
  assert.deepEqual(start.partial.usage, {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    totalTokens: 10,
  });
  assert.deepEqual(result.terminal.usage, {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    totalTokens: 10,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  });
});

test("Faux preserves absent counters and rejects unsafe usage without trusting supplied cost", async () => {
  const partial = await collect(createFauxTransport(() => ({ usage: { input: 2, output: 1 } }))(
    fauxModel,
    userContext(),
    {},
  ));
  assert.deepEqual(partial.terminal.usage, { input: 2, output: 1 });

  const invalid = await collect(createFauxTransport(() => ({
    usage: {
      input: 0.5,
      output: Number.POSITIVE_INFINITY,
      cacheRead: -1,
      cacheWrite: Number.MAX_SAFE_INTEGER + 1,
      cacheWrite1h: Number.NaN,
      reasoning: 2.5,
      totalTokens: Number.NEGATIVE_INFINITY,
      cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
    },
  }))(fauxModel, userContext(), {}));
  assert.deepEqual(invalid.terminal.usage, {});

  const overflow = await collect(createFauxTransport(() => ({
    usage: {
      input: Number.MAX_SAFE_INTEGER,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 7,
      totalTokens: Number.MAX_SAFE_INTEGER,
    },
  }))(fauxModel, userContext(), {}));
  assert.deepEqual(overflow.terminal.usage, { reasoning: 7 });

  const partialOverflow = await collect(createFauxTransport(() => ({
    usage: { input: Number.MAX_SAFE_INTEGER, output: 1, reasoning: 7 },
  }))(fauxModel, userContext(), {}));
  assert.deepEqual(partialOverflow.terminal.usage, { reasoning: 7 });

  const impossibleTotal = await collect(createFauxTransport(() => ({
    usage: { input: 800, output: 100, cacheRead: 200, totalTokens: 5 },
  }))(fauxModel, userContext(), {}));
  assert.deepEqual(impossibleTotal.terminal.usage, { input: 800, output: 100, cacheRead: 200 });
});

test("Faux observes a pre-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await collect(createFauxTransport(() => ({ text: "must not appear" }))(
    fauxModel,
    userContext(),
    { signal: controller.signal },
  ));
  assert.equal(result.terminal.stopReason, "aborted");
  assert.deepEqual(result.terminal.content, []);
});

test("event channels reject their result when fail is used", async () => {
  const stream = createAssistantMessageEventStream();
  assert.equal(typeof stream.fail, "function");
  stream.fail(new Error("protocol broke"));
  await assert.rejects(stream.result(), /protocol broke/u);
  const seen = [];
  for await (const event of stream) seen.push(event);
  assert.deepEqual(seen, []);
});

test("sampling helpers expose protocol syntax and isolate strict capability checks", () => {
  const strict = {
    name: "strict",
    description: "Strict",
    parameters: {},
    constrainedSampling: { type: "json_schema", strict: "require" },
  } as Tool;
  const grammar = {
    name: "grammar",
    description: "Grammar",
    parameters: { required: ["source"], properties: { source: { type: "string" } } },
    constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /[a-z]+/" } },
  } as unknown as Tool;
  assert.throws(() => strictToolValue(strict, false), /requires strict JSON-schema sampling/u);
  assert.equal(grammarSampling(strict, false), undefined);
  assert.deepEqual(grammarSampling(grammar, true), {
    format: "lark",
    definition: "start: /[a-z]+/",
    property: "source",
  });
});

test("streaming JSON repair fixes strings and returns bounded usable partials", () => {
  assert.equal(repairJson('{"items":[1,2,'), '{"items":[1,2]}');
  assert.deepEqual(parseJsonWithRepair('{"items":[1,2,'), { items: [1, 2] });
  const malformed = "{\"path\":\"folder\\name\\q\",\"note\":\"first\nsecond\",\"valid\":\"\\u263a\\t\"}";
  const repaired = repairJson(malformed);
  assert.deepEqual(parseJsonWithRepair<Record<string, string>>(malformed), {
    path: ["folder", "ame\\q"].join("\n"),
    note: "first\nsecond",
    valid: "☺\t",
  });
  assert.equal(repairJson(repaired), repaired);
  assert.deepEqual(parseStreamingJson('{"text":"ok'), { text: "ok" });
  assert.deepEqual(parseStreamingJson('{"items":[1,2,{"name":"par'), {
    items: [1, 2, { name: "par" }],
  });
  assert.deepEqual(parseStreamingJson('{"path":"folder\\q'), { path: "folder" });
  assert.deepEqual(parseStreamingJson(""), {});
  assert.deepEqual(parseStreamingJson("not json"), {});
  assert.deepEqual(parseStreamingJson("{invalid"), {});
  assert.throws(() => parseJsonWithRepair('{"value":'), SyntaxError);
});
