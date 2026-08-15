import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type { AssistantMessage, Model } from "../src/index.ts";
import { streamAnthropicMessages } from "../src/api/anthropic-messages.ts";
import { streamAzureOpenAIResponses } from "../src/api/azure-openai-responses.ts";
import { createBedrockConverseTransport } from "../src/api/bedrock-converse-stream.ts";
import { streamGoogleGenerativeAI } from "../src/api/google-generative-ai.ts";
import { streamGoogleVertex } from "../src/api/google-vertex.ts";
import { streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import { streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { captureFetch, collect, eventSse, model, sse, userContext } from "./black-box-helpers.ts";

const ASSISTANT_FIELD_BYTES = 4 * 1024 * 1024;

interface FakeSocket extends EventTarget {
  readonly url: string;
  readonly options: { headers?: Record<string, string> } | undefined;
  readonly sent: Record<string, unknown>[];
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  emit(...records: Record<string, unknown>[]): void;
  fail(): void;
  disconnectNextTask(error: Error, code: number, reason: string): void;
}

function installWebSocket(
  t: TestContext,
  script: (socket: FakeSocket, payload: Record<string, unknown>, sendIndex: number) => void,
  open = true,
): FakeSocket[] {
  const original = globalThis.WebSocket;
  const sockets: FakeSocket[] = [];
  class TestWebSocket extends EventTarget implements FakeSocket {
    readonly sent: Record<string, unknown>[] = [];
    readyState = 0;

    constructor(
      readonly url: string,
      readonly options: { headers?: Record<string, string> } | undefined = undefined,
    ) {
      super();
      sockets.push(this);
      if (open) queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }

    send(data: string): void {
      const payload = JSON.parse(data) as Record<string, unknown>;
      this.sent.push(payload);
      script(this, payload, this.sent.length - 1);
    }

    close(): void {
      if (this.readyState >= 2) return;
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }

    emit(...records: Record<string, unknown>[]): void {
      for (const record of records) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(record) }));
    }

    fail(): void {
      this.dispatchEvent(new Event("error"));
    }

    disconnectNextTask(error: Error, code: number, reason: string): void {
      setImmediate(() => {
        this.readyState = 3;
        this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: false }));
      });
      this.dispatchEvent(new ErrorEvent("error", { error }));
    }
  }
  globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  return sockets;
}

function completeSocket(socket: FakeSocket, id: string, text = "ws"): void {
  socket.emit(
    { type: "response.created", response: { id, model: "served-ws" } },
    { type: "response.output_text.delta", delta: text },
    { type: "response.completed", response: { id, model: "served-ws" } },
  );
}

function terminatedSse(records: readonly unknown[], beforeTermination?: () => void): Response {
  const body = records.map((record) => `data: ${JSON.stringify(record)}\n\n`).join("");
  const transportCause = Object.assign(new Error("PRIVATE_SOCKET_DETAIL"), { code: "UND_ERR_SOCKET" });
  const terminated = new TypeError("terminated", { cause: transportCause });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      setImmediate(() => {
        beforeTermination?.();
        controller.error(terminated);
      });
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function historicalAssistant(
  selected: Model,
  overrides: Partial<Pick<AssistantMessage, "api" | "provider" | "model">> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking: "private history", thinkingSignature: "private-signature" }],
    api: overrides.api ?? selected.api,
    provider: overrides.provider ?? selected.provider,
    model: overrides.model ?? selected.id,
    usage: {},
    stopReason: "stop",
    timestamp: 1,
  };
}

test("OpenAI Responses SSE sends canonical input, cache/session metadata, and terminates", async () => {
  const mock = captureFetch(() => sse([
    { type: "response.created", response: { id: "resp_1", model: "served-model" } },
    { type: "response.output_text.delta", delta: "hello" },
    { type: "response.completed", response: {
      id: "resp_1",
      model: "served-model",
      usage: {
        input_tokens: 20,
        output_tokens: 1,
        total_tokens: 21,
        input_tokens_details: { cached_tokens: 12, cache_write_tokens: 3 },
      },
    } },
  ]));
  const result = await collect(streamOpenAIResponses(model("openai-responses", {
    compat: { supportsExplicitPromptCacheMode: true },
  }), userContext("ping"), {
    apiKey: "test-key",
    sessionId: "session-a",
    cacheRetention: "short",
    metadata: { tenant: "test" },
    fetch: mock.fetch,
    maxRetries: 0,
  }));
  assert.equal(mock.requests[0]?.url, "https://provider.example/v1/responses");
  assert.deepEqual(mock.requests[0]?.body.input, [{ role: "user", content: "ping" }]);
  assert.equal(mock.requests[0]?.body.prompt_cache_key, "black-box-model:session-a");
  assert.deepEqual(mock.requests[0]?.body.prompt_cache_options, { ttl: "30m" });
  assert.deepEqual(mock.requests[0]?.body.metadata, { tenant: "test" });
  assert.equal(result.terminal.stopReason, "stop");
  assert.equal(result.terminal.responseId, "resp_1");
  assert.equal(result.terminal.responseModel, "served-model");
  assert.deepEqual(result.terminal.content, [{ type: "text", text: "hello" }]);
  assert.deepEqual(result.terminal.usage, {
    input: 5,
    output: 1,
    cacheRead: 12,
    cacheWrite: 3,
    totalTokens: 21,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("OpenAI Responses SSE retries one terminated metadata-only body without replaying semantic output", async () => {
  let responses = 0;
  const mock = captureFetch(() => {
    responses += 1;
    if (responses === 1) {
      return terminatedSse([{
        type: "response.created",
        response: { id: "resp_terminated", model: "served-model" },
      }]);
    }
    return sse([
      { type: "response.output_text.delta", delta: "recovered" },
      { type: "response.completed", response: { id: "resp_recovered", model: "served-model" } },
    ]);
  });

  const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: mock.fetch,
    maxRetries: 0,
  }));

  assert.equal(mock.requests.length, 2);
  assert.equal(result.terminal.stopReason, "stop");
  assert.equal(result.terminal.responseId, "resp_recovered");
  assert.deepEqual(result.terminal.content, [{ type: "text", text: "recovered" }]);
});

test("OpenAI Responses SSE keeps empty lifecycle boundaries retryable", async () => {
  let responses = 0;
  const mock = captureFetch(() => {
    responses += 1;
    if (responses === 1) {
      return terminatedSse([
        { type: "response.created", response: { id: "resp_empty", output: [] } },
        { type: "response.metadata", response: { id: "resp_empty", output: [] } },
        {
          type: "response.content_part.added",
          output_index: 0,
          item_id: "message_empty",
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.reasoning_summary_part.added",
          output_index: 1,
          item_id: "reasoning_empty",
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "message_empty", content: [] },
        },
      ]);
    }
    return sse([
      { type: "response.output_text.delta", delta: "recovered" },
      { type: "response.completed", response: { id: "resp_recovered" } },
    ]);
  });

  const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: mock.fetch,
    maxRetries: 0,
  }));

  assert.equal(mock.requests.length, 2);
  assert.equal(result.terminal.stopReason, "stop");
  assert.deepEqual(result.terminal.content, [{ type: "text", text: "recovered" }]);
});

test("OpenAI Responses SSE recovers content-bearing lifecycle boundaries without replay", async (t) => {
  const cases = [
    {
      name: "output text done",
      event: { type: "response.output_text.done", output_index: 0, content_index: 0, text: "final text" },
      content: [{ type: "text", text: "final text" }],
    },
    {
      name: "content part added",
      event: {
        type: "response.content_part.added",
        output_index: 0,
        item_id: "message_1",
        content_index: 0,
        part: { type: "output_text", text: "part text", annotations: [] },
      },
      content: [{ type: "text", text: "part text" }],
    },
    {
      name: "reasoning summary part added",
      event: {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        item_id: "reasoning_1",
        summary_index: 0,
        part: { type: "summary_text", text: "summary text" },
      },
      content: [{ type: "thinking", thinking: "summary text" }],
    },
    {
      name: "message output item added",
      event: {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "message_2",
          content: [{ type: "output_text", text: "item text", annotations: [] }],
        },
      },
      content: [{ type: "text", text: "item text" }],
    },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const mock = captureFetch(() => terminatedSse([entry.event]));
      const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
        apiKey: "test-key",
        fetch: mock.fetch,
        maxRetries: 0,
      }));

      assert.equal(mock.requests.length, 1);
      assert.equal(result.terminal.stopReason, "error");
      assert.deepEqual(result.terminal.content, entry.content);
    });
  }
});

test("OpenAI Responses SSE keeps reasoning-only termination non-replayable and diagnostics bounded", async () => {
  const mock = captureFetch(() => terminatedSse([
    { type: "response.created", response: { id: "resp_reasoning", model: "served-model" } },
    { type: "response.reasoning_summary_text.delta", delta: "visible planning state" },
  ]));

  const result = await collect(streamOpenAIResponses(model("openai-responses", { reasoning: true }), userContext(), {
    apiKey: "test-key",
    fetch: mock.fetch,
    maxRetries: 0,
  }));

  assert.equal(mock.requests.length, 1);
  assert.equal(result.terminal.stopReason, "error");
  assert.deepEqual(result.terminal.content, [{ type: "thinking", thinking: "visible planning state" }]);
  assert.match(result.terminal.errorMessage ?? "", /Responses stream connection terminated.*UND_ERR_SOCKET/u);
  assert.doesNotMatch(result.terminal.errorMessage ?? "", /PRIVATE_SOCKET_DETAIL/u);
});

test("OpenAI Responses SSE does not replay after an unknown top-level event", async () => {
  const mock = captureFetch(() => terminatedSse([{ type: "response.provider_extension", opaque: true }]));

  const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: mock.fetch,
    maxRetries: 0,
  }));

  assert.equal(mock.requests.length, 1);
  assert.equal(result.terminal.stopReason, "error");
});

test("OpenAI Responses replays opaque state only inside the selected model boundary", async () => {
  const selected = model("openai-responses");
  const boundaries = [
    { api: "openai-completions" },
    { provider: "historical-provider" },
    { model: "historical-model" },
  ] as const;
  for (const boundary of boundaries) {
    const message = historicalAssistant(selected, boundary);
    message.providerState = {
      source: { api: message.api, provider: message.provider, model: message.model },
      value: { type: "opaque_history", encrypted: "private-state" },
    };
    const mock = captureFetch(() => sse([{ type: "response.completed", response: {} }]));
    await collect(streamOpenAIResponses(selected, { messages: [message] }, {
      apiKey: "test-key",
      fetch: mock.fetch,
      maxRetries: 0,
    }));
    assert.equal(JSON.stringify(mock.requests[0]?.body.input).includes("private-state"), false);
  }

  const matching = historicalAssistant(selected);
  matching.providerState = {
    source: { api: selected.api, provider: selected.provider, model: selected.id },
    value: { type: "opaque_history", encrypted: "matching-state" },
  };
  const mock = captureFetch(() => sse([{ type: "response.completed", response: {} }]));
  await collect(streamOpenAIResponses(selected, { messages: [matching] }, {
    apiKey: "test-key",
    fetch: mock.fetch,
    maxRetries: 0,
  }));
  assert.equal(JSON.stringify(mock.requests[0]?.body.input).includes("matching-state"), true);
});

test("Anthropic replays private thinking only inside the selected model boundary", async () => {
  const selected = model("anthropic-messages");
  for (const boundary of [
    { api: "openai-responses" },
    { provider: "historical-provider" },
    { model: "historical-model" },
  ] as const) {
    const mock = captureFetch(() => eventSse([{
      event: "message_stop",
      data: { type: "message_stop" },
    }]));
    await collect(streamAnthropicMessages(selected, {
      messages: [historicalAssistant(selected, boundary)],
    }, { apiKey: "test-key", fetch: mock.fetch, maxRetries: 0 }));
    assert.deepEqual((mock.requests[0]?.body.messages as Array<{ content: unknown[] }>)[0]?.content, [
      { type: "text", text: "private history" },
    ]);
  }

  const matching = captureFetch(() => eventSse([{
    event: "message_stop",
    data: { type: "message_stop" },
  }]));
  await collect(streamAnthropicMessages(selected, {
    messages: [historicalAssistant(selected)],
  }, { apiKey: "test-key", fetch: matching.fetch, maxRetries: 0 }));
  assert.deepEqual((matching.requests[0]?.body.messages as Array<{ content: unknown[] }>)[0]?.content, [{
    type: "thinking",
    thinking: "private history",
    signature: "private-signature",
  }]);
});

test("Google replays private thinking only inside the selected model boundary", async () => {
  const selected = model("google-generative-ai");
  for (const boundary of [
    { api: "google-vertex" },
    { provider: "historical-provider" },
    { model: "historical-model" },
  ] as const) {
    const mock = captureFetch(() => sse([{ candidates: [] }]));
    await collect(streamGoogleGenerativeAI(selected, {
      messages: [historicalAssistant(selected, boundary)],
    }, { apiKey: "test-key", fetch: mock.fetch, maxRetries: 0 }));
    assert.deepEqual((mock.requests[0]?.body.contents as Array<{ parts: unknown[] }>)[0]?.parts, [
      { text: "private history" },
    ]);
  }

  const matching = captureFetch(() => sse([{ candidates: [] }]));
  await collect(streamGoogleGenerativeAI(selected, {
    messages: [historicalAssistant(selected)],
  }, { apiKey: "test-key", fetch: matching.fetch, maxRetries: 0 }));
  assert.deepEqual((matching.requests[0]?.body.contents as Array<{ parts: unknown[] }>)[0]?.parts, [{
    text: "private history",
    thought: true,
    thoughtSignature: "private-signature",
  }]);
});

test("OpenAI and Azure Responses fail closed before their protocol terminal event", async () => {
  for (const response of [() => new Response("", { status: 200 }), () => sse(["[DONE]"])]) {
    const direct = captureFetch(response);
    const directResult = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
      apiKey: "test-key",
      fetch: direct.fetch,
      maxRetries: 0,
    }));
    assert.equal(directResult.terminal.stopReason, "error");
    assert.match(directResult.terminal.errorMessage ?? "", /before response\.completed/u);

    const azure = captureFetch(response);
    const azureResult = await collect(streamAzureOpenAIResponses(model("azure-openai-responses"), userContext(), {
      apiKey: "test-key",
      fetch: azure.fetch,
      maxRetries: 0,
    }));
    assert.equal(azureResult.terminal.stopReason, "error");
    assert.match(azureResult.terminal.errorMessage ?? "", /before response\.completed/u);
  }
});

test("Anthropic fails closed before message_stop and retains streamed signatures on success", async () => {
  const incomplete = captureFetch(() => eventSse([{
    event: "message_start",
    data: { type: "message_start", message: {} },
  }]));
  const failed = await collect(streamAnthropicMessages(model("anthropic-messages"), userContext(), {
    apiKey: "test-key",
    fetch: incomplete.fetch,
    maxRetries: 0,
  }));
  assert.equal(failed.terminal.stopReason, "error");
  assert.match(failed.terminal.errorMessage ?? "", /before message_stop/u);

  const complete = captureFetch(() => eventSse([
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Safe" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]));
  const succeeded = await collect(streamAnthropicMessages(model("anthropic-messages"), userContext(), {
    apiKey: "test-key",
    fetch: complete.fetch,
    maxRetries: 0,
  }));
  assert.deepEqual(succeeded.terminal.content, [{
    type: "thinking",
    thinking: "Safe",
    thinkingSignature: "signed",
  }]);
});

test("reasoning off bypasses provider mappings and omits reasoning controls", async () => {
  const mock = captureFetch(() => sse([{ type: "response.completed", response: {} }]));
  const result = await collect(streamOpenAIResponses(model("openai-responses", {
    reasoning: true,
    thinkingLevelMap: { off: "provider-unsupported" },
  }), userContext(), {
    apiKey: "test-key",
    reasoning: "off",
    fetch: mock.fetch,
    maxRetries: 0,
  }));
  assert.equal(result.terminal.stopReason, "stop");
  assert.equal(mock.requests[0]?.body.reasoning, undefined);
});

test("breaking direct response iteration aborts and cancels the live SSE body", async () => {
  let cancellations = 0;
  const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: "partial",
      })}\n\n`));
    },
    cancel() {
      cancellations += 1;
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const stream = streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch,
    maxRetries: 0,
  });
  for await (const event of stream) {
    if (event.type === "text_delta") break;
  }
  const terminal = await stream.result();
  assert.equal(terminal.stopReason, "aborted");
  assert.equal(terminal.errorMessage, undefined);
  assert.equal(cancellations, 1);
});

test("OpenAI Responses bounds cumulative text and retained content across valid SSE events", async () => {
  const halfField = "x".repeat(ASSISTANT_FIELD_BYTES / 2 + 1);
  const fieldOverflow = captureFetch(() => sse([
    { type: "response.output_text.delta", delta: halfField },
    { type: "response.output_text.delta", delta: halfField },
    { type: "response.completed", response: {} },
  ]));
  const fieldResult = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: fieldOverflow.fetch,
    maxRetries: 0,
  }));
  assert.equal(fieldResult.terminal.stopReason, "error");
  assert.match(fieldResult.terminal.errorMessage ?? "", /text content exceeded 4 MiB/u);

  const underField = "y".repeat(3 * 1024 * 1024);
  const aggregateOverflow = captureFetch(() => sse([
    { type: "response.reasoning_summary_text.delta", delta: underField },
    { type: "response.output_text.delta", delta: underField },
    { type: "response.reasoning_summary_text.delta", delta: underField },
    { type: "response.completed", response: {} },
  ]));
  const aggregateResult = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: aggregateOverflow.fetch,
    maxRetries: 0,
  }));
  assert.equal(aggregateResult.terminal.stopReason, "error");
  assert.match(aggregateResult.terminal.errorMessage ?? "", /assistant content exceeded 8 MiB/iu);
});

test("OpenAI Responses bounds cumulative streamed tool arguments across valid SSE events", async () => {
  const fragment = " ".repeat(ASSISTANT_FIELD_BYTES / 2 + 1);
  const mock = captureFetch(() => sse([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "item_1", call_id: "call_1", name: "lookup" },
    },
    { type: "response.function_call_arguments.delta", item_id: "item_1", delta: fragment },
    { type: "response.function_call_arguments.delta", item_id: "item_1", delta: fragment },
    { type: "response.completed", response: {} },
  ]));
  const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: mock.fetch,
    maxRetries: 0,
  }));
  assert.equal(result.terminal.stopReason, "error");
  assert.match(result.terminal.errorMessage ?? "", /tool arguments exceeded 4 MiB/iu);

  const exactField = " ".repeat(ASSISTANT_FIELD_BYTES);
  const aggregate = captureFetch(() => sse([
    { type: "response.output_text.delta", delta: "x".repeat(ASSISTANT_FIELD_BYTES) },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "item_1", call_id: "call_1", name: "lookup" },
    },
    { type: "response.function_call_arguments.delta", item_id: "item_1", delta: exactField },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", id: "item_2", call_id: "call_2", name: "lookup" },
    },
  ]));
  const aggregateResult = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: aggregate.fetch,
    maxRetries: 0,
  }));
  assert.equal(aggregateResult.terminal.stopReason, "error");
  assert.match(aggregateResult.terminal.errorMessage ?? "", /assistant content exceeded 8 MiB/iu);
});

test("canonical tool arguments fail closed on malformed or over-complex JSON", async () => {
  async function run(argumentsValue: string) {
    const mock = captureFetch(() => sse([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "item_1", call_id: "call_1", name: "lookup" },
      },
      { type: "response.function_call_arguments.delta", item_id: "item_1", delta: argumentsValue },
      { type: "response.output_item.done", output_index: 0, item: {
        type: "function_call",
        id: "item_1",
        call_id: "call_1",
        name: "lookup",
        arguments: argumentsValue,
      } },
      { type: "response.completed", response: {} },
    ]));
    return collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
      apiKey: "test-key",
      fetch: mock.fetch,
      maxRetries: 0,
    }));
  }

  const malformed = await run('{"open":');
  assert.equal(malformed.terminal.stopReason, "error");
  assert.match(malformed.terminal.errorMessage ?? "", /valid JSON/u);
  assert.equal(malformed.events.some((event) => event.type === "toolcall_end"), false);
  assert.deepEqual(malformed.terminal.content, []);

  const values = await run(JSON.stringify({ values: Array.from({ length: 8_191 }, () => 0) }));
  assert.equal(values.terminal.stopReason, "error");
  assert.match(values.terminal.errorMessage ?? "", /8192 JSON values/u);

  let depth: unknown = null;
  for (let index = 0; index < 60; index += 1) depth = { nested: depth };
  const deep = await run(JSON.stringify(depth));
  assert.equal(deep.terminal.stopReason, "error");
  assert.match(deep.terminal.errorMessage ?? "", /59 levels/u);

  const exact = await run(JSON.stringify({ values: Array.from({ length: 8_190 }, () => 0) }));
  assert.equal(exact.terminal.stopReason, "toolUse");
  assert.equal(exact.terminal.content[0]?.type === "toolCall"
    ? (exact.terminal.content[0].arguments.values as unknown[]).length
    : 0, 8_190);

  let exactDepth: unknown = null;
  for (let index = 0; index < 59; index += 1) exactDepth = { nested: exactDepth };
  assert.equal((await run(JSON.stringify(exactDepth))).terminal.stopReason, "toolUse");
});

test("OpenAI Responses finalizes streamed tool JSON when item.done omits its copy", async () => {
  const mock = captureFetch(() => sse([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "item_1", call_id: "call_1", name: "lookup" },
    },
    { type: "response.function_call_arguments.delta", item_id: "item_1", delta: '{"query":"kept"}' },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", id: "item_1", call_id: "call_1", name: "lookup" },
    },
    { type: "response.completed", response: {} },
  ]));
  const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: mock.fetch,
    maxRetries: 0,
  }));
  assert.deepEqual(result.terminal.content[0], {
    type: "toolCall",
    id: "call_1",
    name: "lookup",
    arguments: { query: "kept" },
  });
});

test("chat-completions and Anthropic tool streams reject malformed final JSON", async () => {
  const chat = captureFetch(() => sse([
    {
      choices: [{
        delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"open":' } }] },
        finish_reason: "tool_calls",
      }],
    },
    "[DONE]",
  ]));
  const chatResult = await collect(streamOpenAICompletions(model("openai-completions"), userContext(), {
    apiKey: "test-key",
    fetch: chat.fetch,
    maxRetries: 0,
  }));
  assert.equal(chatResult.terminal.stopReason, "error");
  assert.match(chatResult.terminal.errorMessage ?? "", /valid JSON/u);
  assert.equal(chatResult.events.some((event) => event.type === "toolcall_end"), false);
  assert.deepEqual(chatResult.terminal.content, []);

  const anthropic = captureFetch(() => eventSse([
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "lookup" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"open":' } },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  ]));
  const anthropicResult = await collect(streamAnthropicMessages(model("anthropic-messages"), userContext(), {
    apiKey: "test-key",
    fetch: anthropic.fetch,
    maxRetries: 0,
  }));
  assert.equal(anthropicResult.terminal.stopReason, "error");
  assert.match(anthropicResult.terminal.errorMessage ?? "", /valid JSON/u);
  assert.equal(anthropicResult.events.some((event) => event.type === "toolcall_end"), false);
  assert.deepEqual(anthropicResult.terminal.content, []);
});

test("OpenAI Responses rejects invalid response identities before cached continuation", async (t) => {
  for (const response of [
    { id: "", model: "served-model" },
    { id: 42, model: "served-model" },
    { id: "bad\nresponse", model: "served-model" },
    { id: "x".repeat(4_097), model: "served-model" },
    { id: "resp_valid", model: "" },
    { id: "resp_valid", model: 42 },
    { id: "resp_valid", model: "bad\u007fmodel" },
    { id: "resp_valid", model: "x".repeat(1_025) },
  ]) {
    const mock = captureFetch(() => sse([{ type: "response.completed", response }]));
    const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
      apiKey: "test-key",
      fetch: mock.fetch,
      maxRetries: 0,
    }));
    assert.equal(result.terminal.stopReason, "error");
    assert.match(result.terminal.errorMessage ?? "", /response (?:ID|model)/u);
  }

  const exactId = "é".repeat(2_048);
  const exactModel = "é".repeat(512);
  const boundary = captureFetch(() => sse([{
    type: "response.completed",
    response: { id: exactId, model: exactModel },
  }]));
  const boundaryResult = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: boundary.fetch,
    maxRetries: 0,
  }));
  assert.equal(boundaryResult.terminal.responseId, exactId);
  assert.equal(boundaryResult.terminal.responseModel, exactModel);

  let request = 0;
  const sockets = installWebSocket(t, (socket) => {
    request += 1;
    if (request === 1) {
      socket.emit({ type: "response.completed", response: { id: "x".repeat(4_097), model: "served-model" } });
    } else {
      completeSocket(socket, "resp_recovered", "recovered");
    }
  });
  const options = {
    apiKey: "test-key",
    transport: "websocket-cached" as const,
    sessionId: "invalid-continuation",
    maxRetries: 0,
  };
  const invalid = await collect(streamOpenAIResponses(model("openai-responses"), userContext("first"), options));
  assert.equal(invalid.terminal.stopReason, "error");
  const recovered = await collect(streamOpenAIResponses(model("openai-responses"), userContext("second"), options));
  assert.equal(recovered.terminal.stopReason, "stop");
  assert.equal(sockets.length, 2);
  assert.equal(sockets[1]?.sent[0]?.previous_response_id, undefined);
});

test("OpenAI Responses bounds canonical tool-call identities before streaming them", async () => {
  for (const item of [
    { id: "item_empty", call_id: "", name: "lookup" },
    { id: "item_control", call_id: "bad\ncall", name: "lookup" },
    { id: "item_large", call_id: "x".repeat(1_025), name: "lookup" },
    { id: "item_empty_name", call_id: "call_1", name: "" },
    { id: "item_control_name", call_id: "call_1", name: "bad\u007fname" },
    { id: "item_large_name", call_id: "call_1", name: "x".repeat(257) },
  ]) {
    const mock = captureFetch(() => sse([{
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", ...item },
    }]));
    const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
      apiKey: "test-key",
      fetch: mock.fetch,
      maxRetries: 0,
    }));
    assert.equal(result.terminal.stopReason, "error");
    assert.match(result.terminal.errorMessage ?? "", /tool-call (?:ID|name)/u);
    assert.equal(result.terminal.content.length, 0);
  }

  const exactId = "é".repeat(512);
  const exactName = "é".repeat(128);
  const boundary = captureFetch(() => sse([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "item_boundary", call_id: exactId, name: exactName },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", id: "item_boundary", call_id: exactId, name: exactName, arguments: "{}" },
    },
    { type: "response.completed", response: {} },
  ]));
  const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: boundary.fetch,
    maxRetries: 0,
  }));
  assert.deepEqual(result.terminal.content[0], {
    type: "toolCall",
    id: exactId,
    name: exactName,
    arguments: {},
  });
});

test("OpenAI Responses keeps cumulative partials detached across fragmented text", async () => {
  const mock = captureFetch(() => sse([
    { type: "response.output_text.delta", delta: "a".repeat(256) },
    { type: "response.output_text.delta", delta: "b".repeat(256) },
    { type: "response.completed", response: {} },
  ]));
  const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: mock.fetch,
    maxRetries: 0,
  }));
  const deltas = result.events.filter((event) => event.type === "text_delta");
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0]?.partial.content[0]?.type === "text" ? deltas[0].partial.content[0].text.length : 0, 256);
  assert.equal(deltas[1]?.partial.content[0]?.type === "text" ? deltas[1].partial.content[0].text.length : 0, 512);
  if (deltas[0]?.partial.content[0]?.type === "text") deltas[0].partial.content[0].text = "mutated";
  assert.equal(deltas[1]?.partial.content[0]?.type === "text" ? deltas[1].partial.content[0].text.length : 0, 512);
  assert.equal(result.terminal.content[0]?.type === "text" ? result.terminal.content[0].text.length : 0, 512);
});

test("OpenAI Responses does not deep-clone cumulative text for every partial snapshot", async (t) => {
  const originalStructuredClone = globalThis.structuredClone;
  let wholeMessageClones = 0;
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
    if (typeof value === "object" && value !== null && "role" in value && value.role === "assistant") {
      wholeMessageClones += 1;
    }
    return originalStructuredClone(value, options);
  }) as typeof structuredClone;
  t.after(() => { globalThis.structuredClone = originalStructuredClone; });

  const deltas = Array.from({ length: 1_024 }, () => ({
    type: "response.output_text.delta",
    delta: "x".repeat(256),
  }));
  const mock = captureFetch(() => sse([...deltas, { type: "response.completed", response: {} }]));
  const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: mock.fetch,
    maxRetries: 0,
  }));

  assert.equal(wholeMessageClones, 0);
  assert.equal(result.terminal.content[0]?.type === "text" ? result.terminal.content[0].text.length : 0, 256 * 1_024);
});

test("OpenAI Responses distinguishes omitted cache telemetry from exact zero", async () => {
  const omitted = captureFetch(() => sse([{
    type: "response.completed",
    response: {
      usage: { input_tokens: 1_000, output_tokens: 100 },
    },
  }]));
  const omittedResult = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: omitted.fetch,
    maxRetries: 0,
  }));
  assert.deepEqual(omittedResult.terminal.usage, {
    input: 1_000,
    output: 100,
    totalTokens: 1_100,
  });

  const partial = captureFetch(() => sse([{
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 1_000,
        output_tokens: 100,
        input_tokens_details: { cached_tokens: 200 },
      },
    },
  }]));
  const partialResult = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: partial.fetch,
    maxRetries: 0,
  }));
  assert.deepEqual(partialResult.terminal.usage, {
    input: 800,
    output: 100,
    cacheRead: 200,
    totalTokens: 1_100,
  });

  const zero = captureFetch(() => sse([{
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 1_000,
        output_tokens: 100,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      },
    },
  }]));
  const zeroResult = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: zero.fetch,
    maxRetries: 0,
  }));
  assert.deepEqual(zeroResult.terminal.usage, {
    input: 1_000,
    output: 100,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1_100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

  const inconsistent = captureFetch(() => sse([{
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 1_000,
        output_tokens: 100,
        total_tokens: 5,
        input_tokens_details: { cached_tokens: 200 },
      },
    },
  }]));
  const inconsistentResult = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: inconsistent.fetch,
    maxRetries: 0,
  }));
  assert.deepEqual(inconsistentResult.terminal.usage, {
    input: 800,
    output: 100,
    cacheRead: 200,
    totalTokens: 1_100,
  });

  const impossibleCache = captureFetch(() => sse([{
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        total_tokens: 110,
        input_tokens_details: { cached_tokens: 200 },
      },
    },
  }]));
  const impossibleCacheResult = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: impossibleCache.fetch,
    maxRetries: 0,
  }));
  assert.deepEqual(impossibleCacheResult.terminal.usage, { output: 10, cacheRead: 200 });
});

test("OpenAI Responses never publishes fractional or unsafe token telemetry", async () => {
  const mock = captureFetch(() => sse([{
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 1.5,
        output_tokens: Number.MAX_SAFE_INTEGER + 1,
        total_tokens: 1.5,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      },
    },
  }]));
  const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: mock.fetch,
    maxRetries: 0,
  }));
  assert.deepEqual(result.terminal.usage, { cacheRead: 0, cacheWrite: 0 });

  const overflow = captureFetch(() => sse([{
    type: "response.completed",
    response: {
      usage: {
        input_tokens: Number.MAX_SAFE_INTEGER,
        output_tokens: 1,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      },
    },
  }]));
  const overflowResult = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    fetch: overflow.fetch,
    maxRetries: 0,
  }));
  assert.deepEqual(overflowResult.terminal.usage, {});
});

test("custom Responses reasoning mappings preserve the exact provider wire value", async () => {
  const mock = captureFetch(() => sse([
    { type: "response.completed", response: { id: "resp_custom_reasoning", model: "served-model" } },
  ]));
  await collect(streamOpenAIResponses(model("openai-responses", {
    reasoning: true,
    thinkingLevelMap: { xhigh: "provider-extra-high" },
  }), userContext(), {
    apiKey: "test-key",
    reasoning: "xhigh",
    fetch: mock.fetch,
    maxRetries: 0,
  }));

  assert.deepEqual(mock.requests[0]?.body.reasoning, { effort: "provider-extra-high", summary: "auto" });
});

test("OpenAI Responses omits an explicitly unsupported reasoning level", async () => {
  const mock = captureFetch(() => sse([
    { type: "response.completed", response: { id: "resp_unsupported", model: "served-model" } },
  ]));
  await collect(streamOpenAIResponses(model("openai-responses", {
    reasoning: true,
    thinkingLevelMap: { max: null },
  }), userContext(), {
    apiKey: "test-key",
    reasoning: "max",
    fetch: mock.fetch,
    maxRetries: 0,
  }));

  assert.equal(mock.requests[0]?.body.reasoning, undefined);
});

test("OpenAI Responses SSE displays summaries without exposing raw reasoning text", async () => {
  const mock = captureFetch(() => sse([
    { type: "response.reasoning_text.delta", delta: "private chain of thought" },
    { type: "response.reasoning_summary_text.delta", delta: "Safe summary." },
    { type: "response.output_text.delta", delta: "Answer." },
    { type: "response.completed", response: { id: "resp_reasoning", model: "served-model" } },
  ]));
  const result = await collect(streamOpenAIResponses(model("openai-responses", {
    reasoning: true,
  }), userContext(), {
    apiKey: "test-key",
    reasoning: "high",
    fetch: mock.fetch,
    maxRetries: 0,
  }));

  assert.deepEqual(mock.requests[0]?.body.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(result.terminal.content, [
    { type: "thinking", thinking: "Safe summary." },
    { type: "text", text: "Answer." },
  ]);
  assert.doesNotMatch(JSON.stringify(result.terminal), /private chain of thought/u);
});

test("OpenAI Responses WebSocket displays summaries without exposing raw reasoning text", async (t) => {
  installWebSocket(t, (socket) => socket.emit(
    { type: "response.reasoning_text.delta", delta: "private socket reasoning" },
    { type: "response.reasoning_summary_text.delta", delta: "Safe socket summary." },
    { type: "response.completed", response: { id: "resp_reasoning_ws", model: "served-model" } },
  ));
  const result = await collect(streamOpenAIResponses(model("openai-responses", {
    reasoning: true,
  }), userContext(), {
    apiKey: "test-key",
    reasoning: "high",
    transport: "websocket",
  }));

  assert.deepEqual(result.terminal.content, [
    { type: "thinking", thinking: "Safe socket summary." },
  ]);
  assert.doesNotMatch(JSON.stringify(result.terminal), /private socket reasoning/u);
});

test("OpenAI Responses WebSocket rejects a done sentinel before the protocol terminal", async (t) => {
  let request = 0;
  installWebSocket(t, (socket) => {
    request += 1;
    if (request === 1) {
      socket.emit({ type: "response.output_text.delta", delta: "partial" });
      socket.dispatchEvent(new MessageEvent("message", { data: "[DONE]" }));
      return;
    }
    completeSocket(socket, "resp_completed", "complete");
  });
  const options = { apiKey: "test-key", transport: "websocket" as const };

  const failed = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), options));
  assert.equal(failed.terminal.stopReason, "error");
  assert.match(failed.terminal.errorMessage ?? "", /before response\.completed/u);
  assert.deepEqual(failed.terminal.content, [{ type: "text", text: "partial" }]);

  const completed = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), options));
  assert.equal(completed.terminal.stopReason, "stop");
  assert.equal(completed.terminal.responseId, "resp_completed");
  assert.deepEqual(completed.terminal.content, [{ type: "text", text: "complete" }]);
});

test("OpenAI Responses WebSocket bounds every received message", async (t) => {
  let request = 0;
  installWebSocket(t, (socket) => {
    request += 1;
    const ignored = JSON.stringify({ type: "response.metadata" });
    const count = request === 1 ? 65_535 : 65_536;
    for (let index = 0; index < count; index += 1) {
      socket.dispatchEvent(new MessageEvent("message", { data: ignored }));
    }
    socket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "response.completed", response: {} }),
    }));
  });
  const options = { apiKey: "test-key", transport: "websocket" as const };

  assert.equal((await collect(streamOpenAIResponses(
    model("openai-responses"),
    userContext(),
    options,
  ))).terminal.stopReason, "stop");
  const overflow = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), options));
  assert.equal(overflow.terminal.stopReason, "error");
  assert.match(overflow.terminal.errorMessage ?? "", /65536 events/u);
});

test("OpenAI Responses WebSocket bounds aggregate UTF-8 bytes inclusively", async (t) => {
  const frameBytes = 8 * 1024 * 1024;
  const streamBytes = 64 * 1024 * 1024;
  const completed = JSON.stringify({ type: "response.completed", response: {} });
  const metadata = (bytes: number): string => {
    const prefix = '{"type":"response.metadata","padding":"';
    const suffix = '"}';
    return `${prefix}${"x".repeat(bytes - prefix.length - suffix.length)}${suffix}`;
  };
  const full = metadata(frameBytes);
  const exactTail = metadata(frameBytes - completed.length);
  let request = 0;
  installWebSocket(t, (socket) => {
    request += 1;
    for (let index = 0; index < 7; index += 1) {
      socket.dispatchEvent(new MessageEvent("message", { data: full }));
    }
    socket.dispatchEvent(new MessageEvent("message", {
      data: request === 1 ? exactTail : `${exactTail.slice(0, -2)}x"}`,
    }));
    socket.dispatchEvent(new MessageEvent("message", { data: completed }));
  });
  const options = { apiKey: "test-key", transport: "websocket" as const };

  assert.equal((await collect(streamOpenAIResponses(
    model("openai-responses"),
    userContext(),
    options,
  ))).terminal.stopReason, "stop");
  const overflow = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), options));
  assert.equal(overflow.terminal.stopReason, "error");
  assert.match(overflow.terminal.errorMessage ?? "", /64 MiB/u);
  assert.equal(7 * full.length + exactTail.length + completed.length, streamBytes);
});

test("Kimi Code omits an explicitly unsupported reasoning level", async () => {
  const mock = captureFetch(() => sse(["[DONE]"]));
  await collect(streamOpenAICompletions(model("openai-completions", {
    provider: "kimi-code",
    reasoning: true,
    thinkingLevelMap: { medium: null },
  }), userContext(), {
    apiKey: "test-key",
    reasoning: "medium",
    fetch: mock.fetch,
    maxRetries: 0,
  }));

  assert.equal(mock.requests[0]?.body.reasoning_effort, undefined);
});

test("OpenAI Responses WebSocket sends response.create with headers and redacted hooks", async (t) => {
  const sockets = installWebSocket(t, (socket) => completeSocket(socket, "resp_ws"));
  const requests: unknown[] = [];
  const responses: unknown[] = [];
  const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext("socket"), {
    apiKey: "secret-key",
    transport: "websocket",
    headers: { "x-test": "present" },
    onRequest: (request) => { requests.push(request); },
    onResponse: (response) => { responses.push(response); },
  }));
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0]?.url, "wss://provider.example/v1/responses");
  assert.equal(sockets[0]?.options?.headers?.authorization, "Bearer secret-key");
  assert.equal(sockets[0]?.options?.headers?.["x-test"], "present");
  assert.deepEqual(sockets[0]?.sent[0], {
    type: "response.create",
    model: "black-box-model",
    input: [{ role: "user", content: "socket" }],
  });
  assert.equal((requests[0] as { headers: Record<string, string> }).headers.authorization, "[redacted]");
  assert.equal((responses[0] as { status: number }).status, 101);
  assert.equal(result.terminal.responseId, "resp_ws");
  assert.deepEqual(result.terminal.content, [{ type: "text", text: "ws" }]);
});

test("cached Responses WebSocket reuses one connection and sends incremental session input", async (t) => {
  const sockets = installWebSocket(t, (socket) => completeSocket(socket, `resp_${socket.sent.length}`));
  const selected = model("openai-responses", { compat: { supportsExplicitPromptCacheMode: true } });
  const options = {
    apiKey: "test-key",
    transport: "websocket-cached" as const,
    sessionId: "session-cache",
    cacheRetention: "short" as const,
    websocketIdleTimeoutMs: 1_000,
  };
  const firstContext = userContext("first");
  const first = await collect(streamOpenAIResponses(selected, firstContext, options));
  const secondContext = {
    messages: [
      ...firstContext.messages,
      first.terminal,
      { role: "user" as const, content: "second", timestamp: 2 },
    ],
  };
  const second = await collect(streamOpenAIResponses(selected, secondContext, options));
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0]?.sent.length, 2);
  assert.equal(sockets[0]?.sent[0]?.prompt_cache_key, "black-box-model:session-cache");
  assert.deepEqual(sockets[0]?.sent[0]?.prompt_cache_options, { ttl: "30m" });
  assert.equal(sockets[0]?.sent[1]?.previous_response_id, "resp_1");
  assert.deepEqual(sockets[0]?.sent[1]?.input, [{ role: "user", content: "second" }]);
  assert.equal(second.terminal.responseId, "resp_2");
});

test("cached Responses WebSocket isolates connections across selected models", async (t) => {
  const sockets = installWebSocket(t, (socket) => {
    completeSocket(socket, `resp_${sockets.indexOf(socket) + 1}`, `from-${String(socket.sent[0]?.model)}`);
  });
  const firstModel = model("openai-responses", { id: "model-a" });
  const secondModel = model("openai-responses", { id: "model-b" });
  const options = {
    apiKey: "test-key",
    transport: "websocket-cached" as const,
    sessionId: "session-model-switch",
    websocketIdleTimeoutMs: 1_000,
  };
  const firstContext = userContext("first");
  const first = await collect(streamOpenAIResponses(firstModel, firstContext, options));
  await collect(streamOpenAIResponses(secondModel, {
    messages: [
      ...firstContext.messages,
      first.terminal,
      { role: "user", content: "second", timestamp: 2 },
    ],
  }, options));

  assert.equal(sockets.length, 2);
  assert.equal(sockets[1]?.sent[0]?.model, "model-b");
  assert.equal(Object.hasOwn(sockets[1]?.sent[0] ?? {}, "previous_response_id"), false);
  assert.deepEqual(sockets[1]?.sent[0]?.input, [
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "output_text", text: "from-model-a", annotations: [] }] },
    { role: "user", content: "second" },
  ]);
});

test("cached Responses WebSocket ignores a cross-model response anchor", async (t) => {
  const sockets = installWebSocket(t, (socket) => completeSocket(socket, `resp_${socket.sent.length}`, "first-answer"));
  const selected = model("openai-responses", { id: "anchor-model" });
  const options = {
    apiKey: "test-key",
    transport: "websocket-cached" as const,
    sessionId: "session-anchor-boundary",
    websocketIdleTimeoutMs: 1_000,
  };
  const firstContext = userContext("first");
  const first = await collect(streamOpenAIResponses(selected, firstContext, options));
  const historical = { ...first.terminal, model: "different-model" };
  await collect(streamOpenAIResponses(selected, {
    messages: [
      ...firstContext.messages,
      historical,
      { role: "user", content: "second", timestamp: 2 },
    ],
  }, options));

  assert.equal(sockets.length, 1);
  assert.equal(Object.hasOwn(sockets[0]?.sent[1] ?? {}, "previous_response_id"), false);
  assert.deepEqual(sockets[0]?.sent[1]?.input, [
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "output_text", text: "first-answer", annotations: [] }] },
    { role: "user", content: "second" },
  ]);
});

test("automatic Responses transport falls back to SSE only before output", async (t) => {
  installWebSocket(t, (socket) => socket.fail());
  const mock = captureFetch(() => sse([
    { type: "response.output_text.delta", delta: "fallback" },
    { type: "response.completed", response: {} },
  ]));
  const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    transport: "auto",
    fetch: mock.fetch,
    maxRetries: 0,
  }));
  assert.equal(mock.requests.length, 1);
  assert.deepEqual(result.terminal.content, [{ type: "text", text: "fallback" }]);
});

test("automatic Responses transport treats empty response output placeholders as replay-safe", async (t) => {
  const outputs: unknown[][] = [
    [{ type: "message", id: "empty-message", content: [] }],
    [{
      type: "message",
      id: "empty-text",
      content: [{ type: "output_text", text: "", annotations: [] }],
    }],
    [{ type: "reasoning", id: "empty-reasoning", summary: [], content: [] }],
    [{ type: "reasoning", id: "empty-null-reasoning", encrypted_content: null, summary: [], content: [] }],
    [{
      type: "reasoning",
      id: "empty-reasoning-text",
      summary: [{ type: "summary_text", text: "" }],
      content: [{ type: "reasoning_text", text: "" }],
    }],
  ];
  let socketRequest = 0;
  installWebSocket(t, (socket) => {
    socket.emit({
      type: "response.created",
      response: { id: `resp_placeholder_${socketRequest}`, output: outputs[socketRequest] },
    });
    socketRequest += 1;
    socket.fail();
  });
  const mock = captureFetch(() => sse([
    { type: "response.output_text.delta", delta: "fallback" },
    { type: "response.completed", response: {} },
  ]));

  for (const [index] of outputs.entries()) {
    const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
      apiKey: "test-key",
      transport: "auto",
      fetch: mock.fetch,
      maxRetries: 0,
    }));
    assert.equal(mock.requests.length, index + 1);
    assert.equal(result.terminal.stopReason, "stop");
    assert.deepEqual(result.terminal.content, [{ type: "text", text: "fallback" }]);
  }
});

test("automatic Responses transport keeps opaque, tool, malformed, and unknown output non-replayable", async (t) => {
  const outputs: unknown[][] = [
    [{ type: "reasoning", id: "opaque-reasoning", encrypted_content: "opaque-state" }],
    [{ type: "reasoning", id: "malformed-reasoning", encrypted_content: 7, summary: [], content: [] }],
    [{ type: "function_call", id: "function-call", call_id: "call-1", name: "read", arguments: "{}" }],
    [{ type: "custom_tool_call", id: "custom-call", call_id: "call-2", name: "shell", input: "pwd" }],
    [null],
    [{ type: "message", id: "missing-message-content" }],
    [{ type: "message", id: "malformed-message", content: {} }],
    [{ type: "message", id: "mismatched-message", content: [{ type: "summary_text", text: "" }] }],
    [{ type: "reasoning", id: "mismatched-summary", summary: [{ type: "output_text", text: "", annotations: [] }] }],
    [{ type: "reasoning", id: "mismatched-content", content: [{ type: "summary_text", text: "" }] }],
    [{ type: "computer_call", id: "unknown-item", action: { type: "screenshot" } }],
  ];
  let socketRequest = 0;
  installWebSocket(t, (socket) => {
    socket.emit({
      type: "response.created",
      response: { id: `resp_non_replayable_${socketRequest}`, output: outputs[socketRequest] },
    });
    socketRequest += 1;
    socket.fail();
  });
  const mock = captureFetch(() => sse([{ type: "response.completed", response: {} }]));

  for (const output of outputs) {
    const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
      apiKey: "test-key",
      transport: "auto",
      fetch: mock.fetch,
      maxRetries: 0,
    }));
    assert.equal(mock.requests.length, 0, JSON.stringify(output));
    assert.equal(result.terminal.stopReason, "error", JSON.stringify(output));
  }
});

test("automatic Responses transport does not replay a malformed lifecycle response", async (t) => {
  installWebSocket(t, (socket) => {
    socket.emit({ type: "response.created", response: "invalid" });
    socket.fail();
  });
  const mock = captureFetch(() => sse([{ type: "response.completed", response: {} }]));

  const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    transport: "auto",
    fetch: mock.fetch,
    maxRetries: 0,
  }));

  assert.equal(mock.requests.length, 0);
  assert.equal(result.terminal.stopReason, "error");
});

test("automatic Responses transport does not replay unclassifiable WebSocket frames", async (t) => {
  const frames = ["{", "[]", JSON.stringify({ response: {} })];
  let socketRequest = 0;
  installWebSocket(t, (socket) => {
    const frame = frames[socketRequest];
    assert.ok(frame);
    socket.dispatchEvent(new MessageEvent("message", { data: frame }));
    socketRequest += 1;
    socket.fail();
  });
  const mock = captureFetch(() => sse([{ type: "response.completed", response: {} }]));

  for (const frame of frames) {
    const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
      apiKey: "test-key",
      transport: "auto",
      fetch: mock.fetch,
      maxRetries: 0,
    }));
    assert.equal(mock.requests.length, 0, frame);
    assert.equal(result.terminal.stopReason, "error", frame);
  }
});

test("automatic Responses transport does not replay mismatched content-part events", async (t) => {
  const events = [
    {
      type: "response.content_part.added",
      part: { type: "summary_text", text: "" },
    },
    {
      type: "response.reasoning_summary_part.added",
      part: { type: "output_text", text: "", annotations: [] },
    },
  ];
  let socketRequest = 0;
  installWebSocket(t, (socket) => {
    socket.emit({ type: "response.created", response: { id: `response-${socketRequest}` } });
    const event = events[socketRequest];
    assert.ok(event);
    socket.emit(event);
    socketRequest += 1;
    socket.fail();
  });
  const mock = captureFetch(() => sse([{ type: "response.completed", response: {} }]));

  for (const event of events) {
    const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
      apiKey: "test-key",
      transport: "auto",
      fetch: mock.fetch,
      maxRetries: 0,
    }));
    assert.equal(mock.requests.length, 0, JSON.stringify(event));
    assert.equal(result.terminal.stopReason, "error", JSON.stringify(event));
  }
});

test("automatic Responses transport does not replay malformed deltas", async (t) => {
  const events = [
    { type: "response.output_text.delta", delta: 7 },
    { type: "response.reasoning_summary_text.delta" },
  ];
  let socketRequest = 0;
  installWebSocket(t, (socket) => {
    socket.emit({ type: "response.created", response: { id: `response-${socketRequest}` } });
    const event = events[socketRequest];
    assert.ok(event);
    socket.emit(event);
    socketRequest += 1;
    socket.fail();
  });
  const mock = captureFetch(() => sse([{ type: "response.completed", response: {} }]));

  for (const event of events) {
    const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
      apiKey: "test-key",
      transport: "auto",
      fetch: mock.fetch,
      maxRetries: 0,
    }));
    assert.equal(mock.requests.length, 0, JSON.stringify(event));
    assert.equal(result.terminal.stopReason, "error", JSON.stringify(event));
  }
});

test("automatic Responses transport never replays after output", async (t) => {
  installWebSocket(t, (socket) => {
    socket.emit({ type: "response.output_text.delta", delta: "partial" });
    socket.fail();
  });
  const mock = captureFetch(() => sse([{ type: "response.completed", response: {} }]));
  const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    transport: "auto",
    fetch: mock.fetch,
    maxRetries: 0,
  }));
  assert.equal(mock.requests.length, 0);
  assert.equal(result.terminal.stopReason, "error");
  assert.deepEqual(result.terminal.content, [{ type: "text", text: "partial" }]);
});

test("automatic Responses transport treats an unknown output item as non-replayable", async (t) => {
  installWebSocket(t, (socket) => {
    socket.emit({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "computer_call", id: "computer-item", action: { type: "screenshot" } },
    });
    socket.fail();
  });
  const mock = captureFetch(() => sse([{ type: "response.completed", response: {} }]));
  const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    transport: "auto",
    fetch: mock.fetch,
    maxRetries: 0,
  }));

  assert.equal(mock.requests.length, 0);
  assert.equal(result.terminal.stopReason, "error");
});

test("Responses WebSocket correlates an Undici error with a close in the next task", async (t) => {
  installWebSocket(t, (socket) => {
    const cause = Object.assign(new Error("PRIVATE_SOCKET_DETAIL"), { code: "UND_ERR_SOCKET" });
    socket.disconnectNextTask(cause, 1006, "PRIVATE_CLOSE_REASON");
  });
  const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    transport: "websocket",
    maxRetries: 0,
  }));

  assert.equal(result.terminal.stopReason, "error");
  assert.match(result.terminal.errorMessage ?? "", /1006.*abnormal closure.*UND_ERR_SOCKET/u);
  assert.doesNotMatch(result.terminal.errorMessage ?? "", /PRIVATE_SOCKET_DETAIL|PRIVATE_CLOSE_REASON/u);
});

test("explicit Responses WebSocket retries a pre-output failure within configured bounds", async (t) => {
  const sockets = installWebSocket(t, (socket) => {
    if (sockets.indexOf(socket) === 0) socket.fail();
    else completeSocket(socket, "resp_retry", "retried");
  });
  const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    transport: "websocket",
    maxRetries: 1,
    maxRetryDelayMs: 1,
  }));
  assert.equal(sockets.length, 2);
  assert.deepEqual(result.terminal.content, [{ type: "text", text: "retried" }]);
});

test("Responses WebSocket cancellation closes the request as aborted", async (t) => {
  const controller = new AbortController();
  const sockets = installWebSocket(t, () => queueMicrotask(() => controller.abort()));
  const result = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    transport: "websocket",
    signal: controller.signal,
  }));
  assert.equal(result.terminal.stopReason, "aborted");
  assert.equal(sockets[0]?.readyState, 3);
});

test("Responses WebSocket enforces connect and idle timeouts", async (t) => {
  installWebSocket(t, () => undefined, false);
  const connecting = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    transport: "websocket",
    websocketConnectTimeoutMs: 1,
  }));
  assert.equal(connecting.terminal.stopReason, "error");
  assert.match(connecting.terminal.errorMessage ?? "", /timed out/u);
});

test("Responses WebSocket enforces an idle timeout after connecting", async (t) => {
  installWebSocket(t, () => undefined);
  const idle = await collect(streamOpenAIResponses(model("openai-responses"), userContext(), {
    apiKey: "test-key",
    transport: "websocket",
    websocketIdleTimeoutMs: 1,
  }));
  assert.equal(idle.terminal.stopReason, "error");
  assert.match(idle.terminal.errorMessage ?? "", /became idle/u);
});

test("OpenAI chat completions sends messages and closes tool JSON", async () => {
  const mock = captureFetch(() => sse([
    { id: "chat_1", model: "served-chat", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] }, finish_reason: "tool_calls" }] },
    "[DONE]",
  ]));
  const result = await collect(streamOpenAICompletions(model("openai-completions"), userContext(), {
    apiKey: "test-key",
    fetch: mock.fetch,
    maxRetries: 0,
  }));
  assert.equal(mock.requests[0]?.url, "https://provider.example/v1/chat/completions");
  assert.deepEqual(mock.requests[0]?.body.messages, [{ role: "user", content: "hello" }]);
  assert.equal(result.terminal.stopReason, "toolUse");
  assert.deepEqual(result.terminal.content, [{ type: "toolCall", id: "call_1", name: "lookup", arguments: { q: "x" } }]);
});

test("OpenAI chat completions requires an explicit done marker", async () => {
  const truncated = captureFetch(() => sse([{
    choices: [{ delta: { content: "partial" } }],
  }]));
  const failed = await collect(streamOpenAICompletions(model("openai-completions"), userContext(), {
    apiKey: "test-key",
    fetch: truncated.fetch,
    maxRetries: 0,
  }));
  assert.equal(failed.terminal.stopReason, "error");
  assert.match(failed.terminal.errorMessage ?? "", /before \[DONE\]/u);

  const complete = captureFetch(() => sse(["[DONE]"]));
  const succeeded = await collect(streamOpenAICompletions(model("openai-completions"), userContext(), {
    apiKey: "test-key",
    fetch: complete.fetch,
    maxRetries: 0,
  }));
  assert.equal(succeeded.terminal.stopReason, "stop");
  assert.deepEqual(succeeded.terminal.content, []);
});

test("OpenAI chat completions distinguishes omitted cache telemetry from exact zero", async () => {
  const omitted = captureFetch(() => sse([
    { usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }, choices: [] },
    "[DONE]",
  ]));
  const omittedResult = await collect(streamOpenAICompletions(model("openai-completions"), userContext(), {
    apiKey: "test-key",
    fetch: omitted.fetch,
    maxRetries: 0,
  }));
  assert.equal(Object.hasOwn(omittedResult.terminal.usage, "cacheRead"), false);
  assert.equal(Object.hasOwn(omittedResult.terminal.usage, "cacheWrite"), false);
  assert.equal(Object.hasOwn(omittedResult.terminal.usage, "cost"), false);

  const zero = captureFetch(() => sse([
    {
      usage: {
        prompt_tokens: 4,
        completion_tokens: 1,
        total_tokens: 5,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      },
      choices: [],
    },
    "[DONE]",
  ]));
  const zeroResult = await collect(streamOpenAICompletions(model("openai-completions"), userContext(), {
    apiKey: "test-key",
    fetch: zero.fetch,
    maxRetries: 0,
  }));
  assert.equal(zeroResult.terminal.usage.cacheRead, 0);
  assert.equal(zeroResult.terminal.usage.cacheWrite, 0);
});

test("OpenAI chat completions preserves maintained-provider cache-read telemetry", async () => {
  const cases = [
    { field: "prompt_cache_hit_tokens", provider: "deepseek" },
    { field: "cached_tokens", provider: "kimi-code" },
  ] as const;
  for (const { field, provider } of cases) {
    const mock = captureFetch(() => sse([
      {
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 100,
          total_tokens: 1_100,
          [field]: 700,
        },
        choices: [],
      },
      "[DONE]",
    ]));
    const result = await collect(streamOpenAICompletions(model("openai-completions", { provider }), userContext(), {
      apiKey: "test-key",
      fetch: mock.fetch,
      maxRetries: 0,
    }));

    assert.deepEqual(result.terminal.usage, {
      input: 300,
      output: 100,
      cacheRead: 700,
      totalTokens: 1_100,
    });
  }
});

test("Anthropic Messages sends versioned payload and honors message_stop", async () => {
  const mock = captureFetch(() => eventSse([
    { event: "message_start", data: { type: "message_start", message: { id: "msg_1", model: "served-anthropic", usage: { input_tokens: 2 } } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]));
  const result = await collect(streamAnthropicMessages(model("anthropic-messages"), userContext(), {
    apiKey: "test-key",
    fetch: mock.fetch,
    maxRetries: 0,
  }));
  assert.equal(mock.requests[0]?.url, "https://provider.example/v1/v1/messages");
  assert.equal(new Headers(mock.requests[0]?.init.headers).get("anthropic-version"), "2023-06-01");
  assert.equal(result.terminal.stopReason, "stop");
  assert.equal(result.terminal.content[0]?.type, "text");
  assert.equal(Object.hasOwn(result.terminal.usage, "cacheWrite"), false);
  assert.deepEqual(result.terminal.usage, { input: 2, output: 1 });
});

test("Anthropic derives totals and costs only from a complete cache split", async () => {
  async function usage(cache: Record<string, number>) {
    const mock = captureFetch(() => eventSse([
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: { usage: { input_tokens: 2, ...cache } },
        },
      },
      {
        event: "message_delta",
        data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      },
      { event: "message_stop", data: { type: "message_stop" } },
    ]));
    return (await collect(streamAnthropicMessages(model("anthropic-messages"), userContext(), {
      apiKey: "test-key",
      fetch: mock.fetch,
      maxRetries: 0,
    }))).terminal.usage;
  }

  assert.deepEqual(await usage({ cache_read_input_tokens: 0 }), {
    input: 2,
    output: 1,
    cacheRead: 0,
  });
  assert.deepEqual(await usage({ cache_creation_input_tokens: 0 }), {
    input: 2,
    output: 1,
    cacheWrite: 0,
  });
  assert.deepEqual(await usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }), {
    input: 2,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("Anthropic preserves nested cache creation lifetimes and explicit zero", async () => {
  async function usage(cacheCreation: Record<string, number>) {
    const mock = captureFetch(() => eventSse([
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 5,
              cache_read_input_tokens: 30,
              cache_creation: cacheCreation,
            },
          },
        },
      },
      {
        event: "message_delta",
        data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      },
      { event: "message_stop", data: { type: "message_stop" } },
    ]));
    return (await collect(streamAnthropicMessages(model("anthropic-messages"), userContext(), {
      apiKey: "test-key",
      fetch: mock.fetch,
      maxRetries: 0,
    }))).terminal.usage;
  }

  assert.deepEqual(await usage({
    ephemeral_5m_input_tokens: 7,
    ephemeral_1h_input_tokens: 11,
  }), {
    input: 5,
    output: 2,
    cacheRead: 30,
    cacheWrite: 18,
    cacheWrite1h: 11,
    totalTokens: 55,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  assert.deepEqual(await usage({
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 0,
  }), {
    input: 5,
    output: 2,
    cacheRead: 30,
    cacheWrite: 0,
    cacheWrite1h: 0,
    totalTokens: 37,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("Google Generative AI normalizes tool prompts and reconciles thinking output from the reported total", async () => {
  const mock = captureFetch(() => sse([{
    responseId: "google_1",
    modelVersion: "served-google",
    candidates: [{ content: { parts: [{ functionCall: { id: "call_g", name: "weather", args: { city: "W" } } }] }, finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 1_000,
      candidatesTokenCount: 100,
      cachedContentTokenCount: 800,
      toolUsePromptTokenCount: 50,
      thoughtsTokenCount: 200,
      totalTokenCount: 1_350,
    },
  }]));
  const result = await collect(streamGoogleGenerativeAI(model("google-generative-ai"), userContext(), {
    apiKey: "test-key",
    fetch: mock.fetch,
    maxRetries: 0,
  }));
  assert.match(mock.requests[0]?.url ?? "", /v1beta\/models\/black-box-model:streamGenerateContent\?alt=sse$/u);
  assert.equal(new Headers(mock.requests[0]?.init.headers).get("x-goog-api-key"), "test-key");
  assert.equal(result.terminal.stopReason, "toolUse");
  assert.deepEqual(result.terminal.content[0], { type: "toolCall", id: "call_g", name: "weather", arguments: { city: "W" } });
  assert.equal(Object.hasOwn(result.terminal.usage, "cacheWrite"), false);
  assert.deepEqual(result.terminal.usage, {
    input: 250,
    output: 300,
    cacheRead: 800,
    reasoning: 200,
    totalTokens: 1_350,
  });
});

test("Google Generative AI accepts snake-case usage aliases without inventing omitted cache telemetry", async () => {
  async function usage(usageMetadata: Record<string, number>) {
    const mock = captureFetch(() => sse([{
      candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }],
      usageMetadata,
    }]));
    return (await collect(streamGoogleGenerativeAI(model("google-generative-ai"), userContext(), {
      apiKey: "test-key",
      fetch: mock.fetch,
      maxRetries: 0,
    }))).terminal.usage;
  }

  assert.deepEqual(await usage({
    prompt_token_count: 1_000,
    candidates_token_count: 100,
    cached_content_token_count: 800,
    tool_use_prompt_token_count: 50,
    thoughts_token_count: 200,
    total_token_count: 1_350,
  }), {
    input: 250,
    output: 300,
    cacheRead: 800,
    reasoning: 200,
    totalTokens: 1_350,
  });

  const omitted = await usage({ prompt_token_count: 10, candidates_token_count: 2, total_token_count: 12 });
  assert.equal(Object.hasOwn(omitted, "cacheRead"), false);
  const zero = await usage({
    prompt_token_count: 10,
    candidates_token_count: 2,
    cached_content_token_count: 0,
    total_token_count: 12,
  });
  assert.equal(zero.cacheRead, 0);
});

test("Google Generative AI does not infer output from a total when the base prompt counter is absent", async () => {
  const mock = captureFetch(() => sse([{
    candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "STOP" }],
    usageMetadata: {
      candidatesTokenCount: 100,
      toolUsePromptTokenCount: 50,
      totalTokenCount: 1_000,
    },
  }]));
  const result = await collect(streamGoogleGenerativeAI(model("google-generative-ai"), userContext(), {
    apiKey: "test-key",
    fetch: mock.fetch,
    maxRetries: 0,
  }));
  assert.deepEqual(result.terminal.usage, { output: 100, totalTokens: 1_000 });
});

test("Google and Vertex require a candidate finish reason before natural EOF", async () => {
  const cases = [
    () => new Response("", { status: 200 }),
    () => sse([{ candidates: [{ content: { parts: [{ text: "partial" }] } }] }]),
  ];
  for (const response of cases) {
    const google = captureFetch(response);
    const googleResult = await collect(streamGoogleGenerativeAI(model("google-generative-ai"), userContext(), {
      apiKey: "test-key",
      fetch: google.fetch,
      maxRetries: 0,
    }));
    assert.equal(googleResult.terminal.stopReason, "error");
    assert.match(googleResult.terminal.errorMessage ?? "", /before a finish reason/u);

    const vertex = captureFetch(response);
    const vertexResult = await collect(streamGoogleVertex(model("google-vertex"), userContext(), {
      apiKey: "test-key",
      fetch: vertex.fetch,
      maxRetries: 0,
    }));
    assert.equal(vertexResult.terminal.stopReason, "error");
    assert.match(vertexResult.terminal.errorMessage ?? "", /before a finish reason/u);
  }

  const complete = captureFetch(() => sse([{
    candidates: [{ content: { parts: [{ text: "complete" }] }, finishReason: "STOP" }],
  }]));
  const completed = await collect(streamGoogleGenerativeAI(model("google-generative-ai"), userContext(), {
    apiKey: "test-key",
    fetch: complete.fetch,
    maxRetries: 0,
  }));
  assert.equal(completed.terminal.stopReason, "stop");
  assert.deepEqual(completed.terminal.content, [{ type: "text", text: "complete" }]);
});

test("Google Generative AI omits uncached input when cache exceeds the native prompt count", async () => {
  const mock = captureFetch(() => sse([{
    candidates: [{ content: { parts: [{ text: "inconsistent" }] }, finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 10,
      cachedContentTokenCount: 200,
      totalTokenCount: 110,
    },
  }]));
  const result = await collect(streamGoogleGenerativeAI(model("google-generative-ai"), userContext(), {
    apiKey: "test-key",
    fetch: mock.fetch,
    maxRetries: 0,
  }));
  assert.deepEqual(result.terminal.usage, { output: 10, cacheRead: 200 });
});

test("Vertex uses bearer auth at the configured publisher endpoint", async () => {
  const mock = captureFetch(() => sse([{ candidates: [{ content: { parts: [{ text: "vertex" }] }, finishReason: "STOP" }] }]));
  const result = await collect(streamGoogleVertex(model("google-vertex", {
    baseUrl: "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/l/publishers/google/models/m",
  }), userContext(), { apiKey: "token", fetch: mock.fetch, maxRetries: 0 }));
  assert.match(mock.requests[0]?.url ?? "", /:streamGenerateContent\?alt=sse$/u);
  assert.equal(new Headers(mock.requests[0]?.init.headers).get("authorization"), "Bearer token");
  assert.equal(result.terminal.stopReason, "stop");
});

test("Azure Responses uses api-key auth and an explicit API version", async () => {
  const mock = captureFetch(() => sse([
    { type: "response.output_text.delta", delta: "azure" },
    { type: "response.completed", response: {} },
  ]));
  const result = await collect(streamAzureOpenAIResponses(model("azure-openai-responses", {
    baseUrl: "https://resource.openai.azure.com/openai/v1",
  }), userContext(), { apiKey: "azure-key", apiVersion: "2025-04-01-preview", fetch: mock.fetch, maxRetries: 0 }));
  assert.match(mock.requests[0]?.url ?? "", /responses\?api-version=2025-04-01-preview$/u);
  assert.equal(new Headers(mock.requests[0]?.init.headers).get("api-key"), "azure-key");
  assert.equal(result.terminal.stopReason, "stop");
  assert.deepEqual(result.terminal.usage, {});
});

test("Azure Responses retries only a pre-semantic terminated body", async (t) => {
  const selected = model("azure-openai-responses", {
    baseUrl: "https://resource.openai.azure.com/openai/v1",
  });

  await t.test("retries one metadata-only body", async () => {
    let responses = 0;
    const mock = captureFetch(() => {
      responses += 1;
      if (responses === 1) {
        return terminatedSse([{
          type: "response.created",
          response: { id: "azure_terminated", model: "served-model" },
        }]);
      }
      return sse([
        { type: "response.output_text.delta", delta: "recovered" },
        { type: "response.completed", response: { id: "azure_recovered", model: "served-model" } },
      ]);
    });

    const result = await collect(streamAzureOpenAIResponses(selected, userContext(), {
      apiKey: "azure-key",
      fetch: mock.fetch,
      maxRetries: 0,
    }));

    assert.equal(mock.requests.length, 2);
    assert.equal(result.terminal.stopReason, "stop");
    assert.equal(result.terminal.responseId, "azure_recovered");
    assert.deepEqual(result.terminal.content, [{ type: "text", text: "recovered" }]);
  });

  await t.test("does not replay semantic output", async () => {
    const mock = captureFetch(() => terminatedSse([
      { type: "response.output_text.delta", delta: "partial" },
    ]));

    const result = await collect(streamAzureOpenAIResponses(selected, userContext(), {
      apiKey: "azure-key",
      fetch: mock.fetch,
      maxRetries: 0,
    }));

    assert.equal(mock.requests.length, 1);
    assert.equal(result.terminal.stopReason, "error");
    assert.deepEqual(result.terminal.content, [{ type: "text", text: "partial" }]);
  });

  await t.test("does not retry after cancellation", async () => {
    const controller = new AbortController();
    const mock = captureFetch(() => terminatedSse([{
      type: "response.created",
      response: { id: "azure_cancelled", model: "served-model" },
    }], () => controller.abort()));

    const result = await collect(streamAzureOpenAIResponses(selected, userContext(), {
      apiKey: "azure-key",
      fetch: mock.fetch,
      maxRetries: 0,
      signal: controller.signal,
    }));

    assert.equal(mock.requests.length, 1);
    assert.equal(result.terminal.stopReason, "aborted");
    assert.equal(result.terminal.errorMessage, undefined);
  });
});

test("Codex Responses retains the subscription route headers", async () => {
  const mock = captureFetch(() => sse([{ type: "response.completed", response: {} }]));
  const result = await collect(streamOpenAICodexResponses(model("openai-codex-responses", {
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api/codex",
  }), userContext(), { apiKey: "subscription-token", accountId: "account", fetch: mock.fetch, maxRetries: 0 }));
  const headers = new Headers(mock.requests[0]?.init.headers);
  assert.equal(headers.get("openai-beta"), "responses=experimental");
  assert.equal(headers.get("chatgpt-account-id"), "account");
  assert.equal(result.terminal.stopReason, "stop");
});

test("Codex Responses preserves session cache affinity without sending unsupported subscription fields", async () => {
  const selected = model("openai-codex-responses", {
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api/codex",
  });
  const cases = [
    { cacheRetention: undefined, promptCacheKey: "black-box-model:subscription-session" },
    { cacheRetention: "short", promptCacheKey: "black-box-model:subscription-session" },
    { cacheRetention: "long", promptCacheKey: "black-box-model:subscription-session" },
    { cacheRetention: "none", promptCacheKey: undefined },
  ] as const;

  for (const fixture of cases) {
    const mock = captureFetch(() => sse([{ type: "response.completed", response: {} }]));
    await collect(streamOpenAICodexResponses(selected, userContext(), {
      apiKey: "subscription-token",
      sessionId: "subscription-session",
      metadata: { unsupported: true },
      ...(fixture.cacheRetention === undefined ? {} : { cacheRetention: fixture.cacheRetention }),
      fetch: mock.fetch,
      maxRetries: 0,
    }));
    const body = mock.requests[0]?.body;
    assert.equal(body?.prompt_cache_key, fixture.promptCacheKey);
    assert.equal(body?.prompt_cache_options, undefined);
    assert.equal(body?.prompt_cache_retention, undefined);
    assert.equal(body?.metadata, undefined);
  }
});

test("Codex subscription Responses rejects explicit public-API WebSocket modes", async () => {
  const result = await collect(streamOpenAICodexResponses(model("openai-codex-responses", {
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api/codex",
  }), userContext(), { apiKey: "subscription-token", transport: "websocket" }));
  assert.equal(result.terminal.stopReason, "error");
  assert.match(result.terminal.errorMessage ?? "", /supports SSE only/u);
});

test("Bedrock ConverseStream maps command input and emits one terminal result", async () => {
  let commandInput: unknown;
  const client = {
    async send(command: { input: unknown }) {
      commandInput = command.input;
      return {
        stream: (async function* () {
          yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "bedrock" } } };
          yield { messageStop: { stopReason: "end_turn" } };
          yield { metadata: { usage: {
            inputTokens: 2,
            outputTokens: 1,
            totalTokens: 10,
            cacheReadInputTokens: 4,
            cacheWriteInputTokens: 3,
          } } };
        })(),
      };
    },
  } as unknown as BedrockRuntimeClient;
  const transport = createBedrockConverseTransport({ client });
  const result = await collect(transport(model("bedrock-converse-stream"), userContext(), {}));
  assert.equal((commandInput as { modelId?: string }).modelId, "black-box-model");
  assert.equal(result.terminal.stopReason, "stop");
  assert.deepEqual(result.terminal.content, [{ type: "text", text: "bedrock" }]);
  assert.deepEqual(result.terminal.usage, {
    input: 2,
    output: 1,
    cacheRead: 4,
    cacheWrite: 3,
    totalTokens: 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
});

test("Bedrock reconciles unclassified prompt tokens without inventing an omitted cache counter", async () => {
  const client = {
    async send() {
      return {
        stream: (async function* () {
          yield { messageStop: { stopReason: "end_turn" } };
          yield { metadata: { usage: {
            inputTokens: 200,
            outputTokens: 100,
            totalTokens: 1_100,
            cacheReadInputTokens: 700,
          } } };
        })(),
      };
    },
  } as unknown as BedrockRuntimeClient;
  const transport = createBedrockConverseTransport({ client });
  const result = await collect(transport(model("bedrock-converse-stream"), userContext(), {}));
  assert.deepEqual(result.terminal.usage, {
    input: 300,
    output: 100,
    cacheRead: 700,
    totalTokens: 1_100,
  });
});

test("Bedrock omits an incoherent reported total when usage components are incomplete", async () => {
  const client = {
    async send() {
      return {
        stream: (async function* () {
          yield { messageStop: { stopReason: "end_turn" } };
          yield { metadata: { usage: {
            inputTokens: 200,
            outputTokens: 100,
            totalTokens: 500,
            cacheReadInputTokens: 700,
          } } };
        })(),
      };
    },
  } as unknown as BedrockRuntimeClient;
  const transport = createBedrockConverseTransport({ client });
  const result = await collect(transport(model("bedrock-converse-stream"), userContext(), {}));
  assert.deepEqual(result.terminal.usage, {
    input: 200,
    output: 100,
    cacheRead: 700,
  });
});

test("Bedrock maps max to adaptive max and displays only requested summaries", async () => {
  const commandInputs: Array<Record<string, unknown>> = [];
  const client = {
    async send(command: { input: Record<string, unknown> }) {
      commandInputs.push(command.input);
      return {
        stream: (async function* () {
          yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "Safe summary." } } } };
          yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "summary-signature" } } } };
          yield { contentBlockDelta: { contentBlockIndex: 1, delta: { reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } } } };
          yield { contentBlockStop: { contentBlockIndex: 0 } };
          yield { contentBlockStop: { contentBlockIndex: 1 } };
          yield { contentBlockDelta: { contentBlockIndex: 2, delta: { text: "Answer." } } };
          yield { messageStop: { stopReason: "end_turn" } };
          yield { metadata: {} };
        })(),
      };
    },
  } as unknown as BedrockRuntimeClient;
  const selected = model("bedrock-converse-stream", {
    id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/team-profile",
    name: "Claude Opus 4.8",
    provider: "bedrock",
    reasoning: true,
  });
  const transport = createBedrockConverseTransport({ client, region: "us-east-1" });
  const first = await collect(transport(selected, userContext(), { reasoning: "max" }));

  assert.deepEqual(commandInputs[0]?.additionalModelRequestFields, {
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "max" },
  });
  assert.deepEqual(first.terminal.content, [
    { type: "thinking", thinking: "Safe summary.", thinkingSignature: "summary-signature" },
    { type: "text", text: "Answer." },
  ]);
  assert.doesNotMatch(JSON.stringify(first.terminal), /1,2,3/u);

  await collect(transport(selected, {
    messages: [
      ...userContext().messages,
      first.terminal,
      { role: "user", content: "continue", timestamp: 2 },
    ],
  }, { reasoning: "max" }));
  const replay = (commandInputs[1]?.messages as Array<{ content: unknown[] }>)[1]?.content;
  assert.deepEqual(replay, [
    { reasoningContent: { reasoningText: { text: "Safe summary.", signature: "summary-signature" } } },
    { reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } },
    { text: "Answer." },
  ]);
});

test("Bedrock suppresses reasoning text when summary display is unavailable", async () => {
  let commandInput: Record<string, unknown> | undefined;
  const client = {
    async send(command: { input: Record<string, unknown> }) {
      commandInput = command.input;
      return {
        stream: (async function* () {
          yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "private reasoning" } } } };
          yield { contentBlockStop: { contentBlockIndex: 0 } };
          yield { contentBlockDelta: { contentBlockIndex: 1, delta: { text: "Answer." } } };
          yield { messageStop: { stopReason: "end_turn" } };
          yield { metadata: {} };
        })(),
      };
    },
  } as unknown as BedrockRuntimeClient;
  const transport = createBedrockConverseTransport({ client, region: "us-gov-west-1" });
  const result = await collect(transport(model("bedrock-converse-stream", {
    id: "anthropic.claude-3-7-sonnet-v1:0",
    provider: "bedrock",
    reasoning: true,
  }), userContext(), { reasoning: "high" }));

  assert.deepEqual(commandInput?.additionalModelRequestFields, {
    thinking: { type: "enabled", budget_tokens: 1_024 },
    anthropic_beta: ["interleaved-thinking-2025-05-14"],
  });
  assert.deepEqual(result.terminal.content, [{ type: "text", text: "Answer." }]);
  assert.doesNotMatch(JSON.stringify(result.terminal), /private reasoning/u);
});

test("Bedrock rejects a manual thinking budget that cannot fit the output cap", async () => {
  let requests = 0;
  const client = {
    async send() {
      requests += 1;
      throw new Error("must not send");
    },
  } as unknown as BedrockRuntimeClient;
  const transport = createBedrockConverseTransport({ client });
  const result = await collect(transport(model("bedrock-converse-stream", {
    id: "anthropic.claude-3-7-sonnet-v1:0",
    provider: "bedrock",
    reasoning: true,
  }), userContext(), { reasoning: "high", maxTokens: 1_024 }));

  assert.equal(requests, 0);
  assert.equal(result.terminal.stopReason, "error");
  assert.match(result.terminal.errorMessage ?? "", /must exceed the 1,024-token minimum thinking budget/u);
});
