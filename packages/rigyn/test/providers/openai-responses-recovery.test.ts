import assert from "node:assert/strict";
import test from "node:test";

import { OpenAIResponsesAdapter } from "../../src/providers/openai-responses.js";
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

function adapter(
  kind: "sdk" | "direct",
  fetch: typeof globalThis.fetch,
): OpenAIResponsesAdapter {
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
            { type: "response.created", response: { id: "response-first", model: "gpt-test" } },
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
