import assert from "node:assert/strict";
import test from "node:test";

import {
  AzureOpenAIResponsesAdapter,
  OpenAIResponsesAdapter,
  ResponsesAdapter,
} from "../../src/providers/openai-responses.js";
import { byteChunks, collect, fakeFetch, request, streamResponse, terminalCount } from "./helpers.js";

function sse(...values: unknown[]): string {
  return values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
}

function response(body: string, requestId = "request-recovery"): Response {
  return streamResponse(byteChunks(body, [1, 2, 3, 5, 8]), {
    "content-type": "text/event-stream",
    "x-request-id": requestId,
  });
}

function terminatedResponse(
  body: string,
  requestId = "request-terminated",
  beforeTermination?: () => void,
): Response {
  const transportCause = Object.assign(new Error("PRIVATE_SOCKET_DETAIL"), { code: "UND_ERR_SOCKET" });
  const terminated = new TypeError("terminated", { cause: transportCause });
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      setImmediate(() => {
        beforeTermination?.();
        controller.error(terminated);
      });
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "x-request-id": requestId,
    },
  });
}

function adapter(
  kind: "azure" | "sdk" | "direct",
  fetch: typeof globalThis.fetch,
): AzureOpenAIResponsesAdapter | OpenAIResponsesAdapter {
  if (kind === "azure") {
    return new AzureOpenAIResponsesAdapter({
      endpoint: "https://azure.example.test",
      apiKey: "secret",
      fetch,
    });
  }
  return new OpenAIResponsesAdapter({
    apiKey: "secret",
    ...(kind === "direct" ? { baseUrl: "https://compatible.example/v1" } : {}),
    fetch,
  });
}

test("Responses recovers message and reasoning content supplied only by output_item.done", async (t) => {
  const message = {
    type: "message",
    id: "message-done",
    role: "assistant",
    status: "completed",
    content: [
      { type: "output_text", text: "done-only answer", annotations: [] },
      { type: "refusal", refusal: "done-only refusal" },
    ],
  };
  const reasoning = {
    type: "reasoning",
    id: "reasoning-done",
    summary: [{ type: "summary_text", text: "done-only summary" }],
    content: [{ type: "reasoning_text", text: "done-only trace" }],
  };
  const body = sse(
    { type: "response.created", response: { id: "response-done", model: "gpt-test" } },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.output_item.done", output_index: 1, item: reasoning },
    {
      type: "response.completed",
      response: { id: "response-done", model: "gpt-test", output: [message, reasoning] },
    },
  );

  for (const kind of ["sdk", "direct"] as const) {
    await t.test(kind, async () => {
      const events = await collect(adapter(kind, fakeFetch(() => response(body))).stream(
        request("openai"),
        new AbortController().signal,
      ));

      assert.deepEqual(
        events.flatMap((event) => event.type === "text_delta" ? [event.text] : []),
        ["done-only answer", "done-only refusal"],
      );
      assert.deepEqual(
        events.flatMap((event) => event.type === "reasoning_delta"
          ? [[event.part, event.text, event.visibility]]
          : []),
        [
          [0, "done-only summary", "summary"],
          [1, "done-only trace", "provider_trace"],
        ],
      );
      const end = events.at(-1);
      assert.equal(end?.type === "response_end" ? end.reason : undefined, "refusal");
      assert.equal(terminalCount(events), 1);
    });
  }
});

test("Responses recovers a function call supplied only by output_item.done", async () => {
  const tool = {
    type: "function_call",
    id: "function-done",
    call_id: "call-done",
    name: "weather",
    arguments: '{"city":"Winnipeg"}',
  };
  const events = await collect(adapter("direct", fakeFetch(() => response(sse(
    { type: "response.created", response: { id: "response-tool", model: "gpt-test" } },
    { type: "response.output_item.done", output_index: 0, item: tool },
    {
      type: "response.completed",
      response: { id: "response-tool", model: "gpt-test", output: [tool] },
    },
  )))).stream(request("openai"), new AbortController().signal));

  assert.deepEqual(
    events.filter((event) => event.type.startsWith("tool_call")).map((event) => event.type),
    ["tool_call_start", "tool_call_end"],
  );
  const end = events.find((event) => event.type === "tool_call_end");
  assert.deepEqual(end?.type === "tool_call_end" ? end.arguments : undefined, { city: "Winnipeg" });
  const terminal = events.at(-1);
  assert.equal(terminal?.type === "response_end" ? terminal.reason : undefined, "tool_calls");
});

test("Responses done-item recovery does not duplicate streamed content", async () => {
  const message = {
    type: "message",
    id: "message-streamed",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "streamed answer", annotations: [] }],
  };
  const reasoning = {
    type: "reasoning",
    id: "reasoning-streamed",
    summary: [{ type: "summary_text", text: "streamed summary" }],
  };
  const events = await collect(adapter("direct", fakeFetch(() => response(sse(
    { type: "response.created", response: { id: "response-streamed", model: "gpt-test" } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "message-streamed",
      content_index: 0,
      delta: "streamed ",
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.output_item.added", output_index: 1, item: { ...reasoning, summary: [] } },
    {
      type: "response.reasoning_summary_text.delta",
      output_index: 1,
      item_id: "reasoning-streamed",
      summary_index: 0,
      delta: "streamed ",
    },
    { type: "response.output_item.done", output_index: 1, item: reasoning },
    {
      type: "response.completed",
      response: { id: "response-streamed", model: "gpt-test", output: [message, reasoning] },
    },
  )))).stream(request("openai"), new AbortController().signal));

  assert.deepEqual(
    events.flatMap((event) => event.type === "text_delta" ? [event.text] : []),
    ["streamed ", "answer"],
  );
  assert.deepEqual(
    events.flatMap((event) => event.type === "reasoning_delta" ? [event.text] : []),
    ["streamed ", "summary"],
  );
});

test("Responses retries an early EOF exactly once and only before semantic output", async (t) => {
  for (const kind of ["sdk", "direct"] as const) {
    await t.test(`${kind}: retries metadata-only EOF and recovers`, async () => {
      let attempts = 0;
      const fetch = fakeFetch(() => {
        attempts += 1;
        if (attempts === 1) {
          return response(sse(
            {
              type: "response.created",
              response: {
                id: "response-first",
                model: "gpt-test",
                output: [
                  { type: "message", content: [] },
                  { type: "message", content: [{ type: "output_text", text: "", annotations: [] }] },
                  { type: "reasoning", summary: [], content: [], encrypted_content: "" },
                  { type: "reasoning", summary: [], content: [], encrypted_content: null },
                ],
              },
            },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "reasoning", id: "reasoning-first", summary: [] },
            },
          ), "request-first");
        }
        return response(sse(
          { type: "response.created", response: { id: "response-second", model: "gpt-test" } },
          { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "recovered" },
          { type: "response.completed", response: { id: "response-second", model: "gpt-test" } },
        ), "request-second");
      });

      const events = await collect(adapter(kind, fetch).stream(request("openai"), new AbortController().signal));

      assert.equal(attempts, 2);
      assert.deepEqual(events.flatMap((event) => event.type === "text_delta" ? [event.text] : []), ["recovered"]);
      assert.equal(events.some((event) => event.type === "error"), false);
      assert.equal(terminalCount(events), 1);
      const start = events.find((event) => event.type === "response_start");
      assert.equal(start?.type === "response_start" ? start.requestId : undefined, "request-second");
    });
  }

  await t.test("stops after the second early EOF", async () => {
    let attempts = 0;
    const fetch = fakeFetch(() => {
      attempts += 1;
      return response(sse(
        { type: "response.created", response: { id: `response-${attempts}`, model: "gpt-test" } },
      ));
    });

    const events = await collect(adapter("direct", fetch).stream(request("openai"), new AbortController().signal));

    assert.equal(attempts, 2);
    assert.deepEqual(events.map((event) => event.type), ["error"]);
    assert.equal(events[0]?.type === "error" ? events[0].error.retryable : undefined, true);
  });

  await t.test("does not retry a malformed lifecycle response", async () => {
    let attempts = 0;
    const fetch = fakeFetch(() => {
      attempts += 1;
      return response(sse({ type: "response.created", response: "invalid" }));
    });

    const events = await collect(adapter("direct", fetch).stream(request("openai"), new AbortController().signal));

    assert.equal(attempts, 1);
    assert.deepEqual(events.map((event) => event.type), ["error"]);
    assert.equal(events[0]?.type === "error" ? events[0].error.partial : undefined, true);
  });

  await t.test("does not retry malformed encrypted reasoning", async () => {
    let attempts = 0;
    const fetch = fakeFetch(() => {
      attempts += 1;
      return response(sse({
        type: "response.created",
        response: {
          id: "response-malformed-reasoning",
          output: [{ type: "reasoning", encrypted_content: 7, summary: [], content: [] }],
        },
      }));
    });

    const events = await collect(adapter("direct", fetch).stream(request("openai"), new AbortController().signal));

    assert.equal(attempts, 1);
    assert.deepEqual(events.map((event) => event.type), ["error"]);
    assert.equal(events[0]?.type === "error" ? events[0].error.partial : undefined, true);
  });

  await t.test("does not retry content in the wrong output-item container", async () => {
    const outputs = [
      [{ type: "message", content: [{ type: "summary_text", text: "" }] }],
      [{ type: "reasoning", summary: [{ type: "output_text", text: "", annotations: [] }] }],
      [{ type: "reasoning", content: [{ type: "summary_text", text: "" }] }],
    ];
    for (const output of outputs) {
      let attempts = 0;
      const fetch = fakeFetch(() => {
        attempts += 1;
        return response(sse({
          type: "response.created",
          response: { id: "response-mismatched-content", output },
        }));
      });

      const events = await collect(adapter("direct", fetch).stream(request("openai"), new AbortController().signal));

      assert.equal(attempts, 1, JSON.stringify(output));
      assert.deepEqual(events.map((event) => event.type), ["error"], JSON.stringify(output));
      assert.equal(events[0]?.type === "error" ? events[0].error.partial : undefined, true);
    }
  });

  await t.test("does not retry a malformed delta", async () => {
    let attempts = 0;
    const fetch = fakeFetch(() => {
      attempts += 1;
      return response(sse(
        { type: "response.created", response: { id: "response-malformed-delta" } },
        { type: "response.output_text.delta", delta: 7 },
      ));
    });

    const events = await collect(adapter("direct", fetch).stream(request("openai"), new AbortController().signal));

    assert.equal(attempts, 1);
    assert.deepEqual(events.map((event) => event.type), ["error"]);
    assert.equal(events[0]?.type === "error" ? events[0].error.partial : undefined, true);
  });

  await t.test("does not retry after a text delta", async () => {
    let attempts = 0;
    const fetch = fakeFetch(() => {
      attempts += 1;
      return response(sse(
        { type: "response.created", response: { id: "response-partial", model: "gpt-test" } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "partial" },
      ));
    });

    const events = await collect(adapter("direct", fetch).stream(request("openai"), new AbortController().signal));

    assert.equal(attempts, 1);
    assert.deepEqual(events.map((event) => event.type), ["response_start", "text_delta", "error"]);
    const failure = events.at(-1);
    assert.equal(failure?.type === "error" ? failure.error.partial : undefined, true);
  });

  await t.test("does not retry after done-only semantic output", async () => {
    let attempts = 0;
    const fetch = fakeFetch(() => {
      attempts += 1;
      return response(sse(
        { type: "response.created", response: { id: "response-done-partial", model: "gpt-test" } },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            id: "message-done-partial",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "done partial", annotations: [] }],
          },
        },
      ));
    });

    const events = await collect(adapter("direct", fetch).stream(request("openai"), new AbortController().signal));

    assert.equal(attempts, 1);
    assert.deepEqual(events.flatMap((event) => event.type === "text_delta" ? [event.text] : []), ["done partial"]);
    const failure = events.at(-1);
    assert.equal(failure?.type === "error" ? failure.error.partial : undefined, true);
  });

  await t.test("does not retry a different network failure", async () => {
    let attempts = 0;
    const fetch = fakeFetch(() => {
      attempts += 1;
      throw new TypeError("fetch failed");
    });

    const events = await collect(adapter("direct", fetch).stream(request("openai"), new AbortController().signal));

    assert.equal(attempts, 1);
    assert.deepEqual(events.map((event) => event.type), ["error"]);
  });
});

test("Responses classifies a terminated HTTP body by durable semantic output", async (t) => {
  await t.test("retries once after metadata-only transport state", async (nested) => {
    for (const kind of ["azure", "sdk", "direct"] as const) {
      await nested.test(kind, async () => {
        let attempts = 0;
        const fetch = fakeFetch(() => {
          attempts += 1;
          if (attempts === 1) {
            return terminatedResponse(sse({
              type: "response.created",
              response: { id: "response-terminated", model: "gpt-test" },
            }));
          }
          return response(sse(
            { type: "response.created", response: { id: "response-recovered", model: "gpt-test" } },
            { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "recovered" },
            { type: "response.completed", response: { id: "response-recovered", model: "gpt-test" } },
          ), "request-recovered");
        });

        const provider = kind === "azure" ? "azure-openai" : "openai";
        const events = await collect(adapter(kind, fetch).stream(request(provider), new AbortController().signal));

        assert.equal(attempts, 2);
        assert.deepEqual(events.flatMap((event) => event.type === "text_delta" ? [event.text] : []), ["recovered"]);
        assert.equal(events.some((event) => event.type === "error"), false);
        assert.equal(terminalCount(events), 1);
      });
    }
  });

  await t.test("does not retry or expose nested details after a text delta", async () => {
    let attempts = 0;
    const fetch = fakeFetch(() => {
      attempts += 1;
      return terminatedResponse(sse(
        { type: "response.created", response: { id: "response-partial", model: "gpt-test" } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "partial" },
      ));
    });

    const events = await collect(adapter("direct", fetch).stream(request("openai"), new AbortController().signal));

    assert.equal(attempts, 1);
    assert.deepEqual(events.map((event) => event.type), ["response_start", "text_delta", "error"]);
    const failure = events.at(-1);
    assert.equal(failure?.type, "error");
    if (failure?.type !== "error") return;
    assert.equal(failure.error.category, "network");
    assert.equal(failure.error.providerCode, "UND_ERR_SOCKET");
    assert.equal(failure.error.partial, true);
    assert.equal(failure.error.bodyStarted, true);
    assert.equal(failure.error.retryable, false);
    assert.match(failure.error.message, /Responses stream connection terminated/u);
    assert.doesNotMatch(failure.error.message, /PRIVATE_SOCKET_DETAIL/u);
  });

  await t.test("does not replay reasoning-only state even when no text or tool call is durable", async () => {
    let attempts = 0;
    const fetch = fakeFetch(() => {
      attempts += 1;
      return terminatedResponse(sse(
        { type: "response.created", response: { id: "response-reasoning", model: "gpt-test" } },
        {
          type: "response.reasoning_summary_text.delta",
          output_index: 0,
          summary_index: 0,
          delta: "visible planning state",
        },
      ));
    });

    const events = await collect(adapter("direct", fetch).stream(request("openai"), new AbortController().signal));

    assert.equal(attempts, 1);
    assert.equal(events.some((event) => event.type === "reasoning_delta"), true);
    assert.equal(events.some((event) => event.type === "text_delta" || event.type.startsWith("tool_call")), false);
    const failure = events.at(-1);
    assert.equal(failure?.type === "error" ? failure.error.partial : undefined, true);
    assert.equal(failure?.type === "error" ? failure.error.retryable : undefined, false);
  });

  await t.test("does not replay an unmatched provider event", async () => {
    let attempts = 0;
    const fetch = fakeFetch(() => {
      attempts += 1;
      return terminatedResponse(sse(
        { type: "response.created", response: { id: "response-unknown", model: "gpt-test" } },
        { type: "response.future_notice", value: "bounded" },
      ));
    });

    const events = await collect(adapter("direct", fetch).stream(request("openai"), new AbortController().signal));

    assert.equal(attempts, 1);
    assert.equal(events.filter((event) => event.type === "unknown_provider_event").length, 1);
    const failure = events.at(-1);
    assert.equal(failure?.type === "error" ? failure.error.partial : undefined, true);
    assert.equal(failure?.type === "error" ? failure.error.retryable : undefined, false);
  });

  await t.test("does not replay an unmatched provider done event", async () => {
    let attempts = 0;
    const fetch = fakeFetch(() => {
      attempts += 1;
      return terminatedResponse(sse(
        { type: "response.created", response: { id: "response-unknown-done", model: "gpt-test" } },
        { type: "response.future_notice.done", value: "bounded" },
      ));
    });

    const events = await collect(adapter("direct", fetch).stream(request("openai"), new AbortController().signal));

    assert.equal(attempts, 1);
    assert.equal(events.filter((event) => event.type === "unknown_provider_event").length, 1);
    const failure = events.at(-1);
    assert.equal(failure?.type === "error" ? failure.error.partial : undefined, true);
    assert.equal(failure?.type === "error" ? failure.error.retryable : undefined, false);
  });

  await t.test("recovers content-bearing lifecycle boundaries without replay", async (nested) => {
    const scenarios = [
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
        text: "done-only text",
      },
      {
        name: "refusal done",
        event: {
          type: "response.refusal.done",
          output_index: 0,
          content_index: 0,
          item_id: "message-refusal-done",
          refusal: "done-only refusal",
        },
        observed: "text_delta",
        text: "done-only refusal",
      },
      {
        name: "reasoning text done",
        event: {
          type: "response.reasoning_text.done",
          output_index: 0,
          content_index: 0,
          item_id: "reasoning-text-done",
          text: "done-only private reasoning",
        },
        observed: "reasoning_delta",
        text: "done-only private reasoning",
      },
      {
        name: "reasoning summary text done",
        event: {
          type: "response.reasoning_summary_text.done",
          output_index: 0,
          summary_index: 0,
          item_id: "reasoning-summary-text-done",
          text: "done-only summary",
        },
        observed: "reasoning_delta",
        text: "done-only summary",
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
        text: "added content",
      },
      {
        name: "content part done",
        event: {
          type: "response.content_part.done",
          output_index: 0,
          content_index: 0,
          item_id: "message-content-done",
          part: { type: "refusal", refusal: "part refusal" },
        },
        observed: "text_delta",
        text: "part refusal",
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
        text: "added summary",
      },
      {
        name: "reasoning summary part done",
        event: {
          type: "response.reasoning_summary_part.done",
          output_index: 0,
          summary_index: 0,
          item_id: "reasoning-summary-done",
          part: { type: "summary_text", text: "part summary" },
        },
        observed: "reasoning_delta",
        text: "part summary",
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
        text: "item added text",
      },
    ] as const;

    for (const scenario of scenarios) {
      await nested.test(scenario.name, async () => {
        let attempts = 0;
        const fetch = fakeFetch(() => {
          attempts += 1;
          return terminatedResponse(sse(
            { type: "response.created", response: { id: `response-${scenario.name}`, model: "gpt-test" } },
            scenario.event,
          ));
        });

        const events = await collect(adapter("direct", fetch).stream(request("openai"), new AbortController().signal));

        assert.equal(attempts, 1);
        assert.equal(events.some((event) => event.type === scenario.observed && event.text === scenario.text), true);
        const failure = events.at(-1);
        assert.equal(failure?.type === "error" ? failure.error.partial : undefined, true);
        assert.equal(failure?.type === "error" ? failure.error.retryable : undefined, false);
      });
    }
  });

  await t.test("cancellation prevents the metadata-only transport retry", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const fetch = fakeFetch(() => {
      attempts += 1;
      return terminatedResponse(sse({
        type: "response.created",
        response: { id: "response-cancelled", model: "gpt-test" },
      }), "request-cancelled", () => controller.abort());
    });

    const events = await collect(adapter("direct", fetch).stream(request("openai"), controller.signal));

    assert.equal(attempts, 1);
    const failure = events.at(-1);
    assert.equal(failure?.type === "error" ? failure.error.category : undefined, "cancelled");
    assert.equal(failure?.type === "error" ? failure.error.retryable : undefined, false);
  });
});

test("Responses does not retry a custom transport application TypeError after response headers", async () => {
  let attempts = 0;
  const provider = new ResponsesAdapter("openai", {
    baseUrl: "https://custom.example.test/v1",
    headers: undefined,
    fetch: fakeFetch(() => {
      throw new Error("custom stream transport owns the request");
    }),
    authorize: async () => {},
    streamEvents: async function* (input) {
      attempts += 1;
      input.onResponse?.({ status: 200, headers: {} }, "request-custom");
      throw new TypeError("custom translator failed");
    },
    stateful: false,
    promptCache: false,
    deferredToolLoading: false,
    supportsReasoningSummaries: false,
    reasoningTextVisibility: "provider_trace",
  });

  const events = await collect(provider.stream(request("openai"), new AbortController().signal));

  assert.equal(attempts, 1);
  assert.deepEqual(events.map((event) => event.type), ["error"]);
  const failure = events[0];
  assert.equal(failure?.type, "error");
  if (failure?.type !== "error") return;
  assert.match(failure.error.message, /custom translator failed/u);
  assert.doesNotMatch(failure.error.message, /Responses stream connection terminated/u);
  assert.equal(failure.error.providerCode, undefined);
});
