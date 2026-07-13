import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderRequest, ProviderState } from "../../src/core/types.js";
import { MistralConversationsAdapter } from "../../src/providers/mistral-conversations.js";
import { byteChunks, collect, fakeFetch, request, streamResponse, terminalCount } from "./helpers.js";

function event(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function done(conversationId: string, options: { tool?: boolean; text?: string } = {}): string {
  return (
    event("conversation.response.started", { conversation_id: conversationId }) +
    (options.text === undefined
      ? ""
      : event("message.output.delta", {
          output_index: 0,
          content_index: 0,
          id: `message-${conversationId}`,
          role: "assistant",
          model: "devstral-latest",
          content: options.text,
        })) +
    (options.tool !== true
      ? ""
      : event("function.call.delta", {
          output_index: 1,
          id: `entry-${conversationId}`,
          tool_call_id: "tool-call-1",
          name: "read_file",
          arguments: '{"path":"README.md"}',
        })) +
    event("conversation.response.done", {
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    })
  );
}

function stateFrom(events: Awaited<ReturnType<typeof collect>>): ProviderState {
  const terminal = events.at(-1);
  if (terminal?.type !== "response_end") assert.fail("missing response_end");
  return terminal.state;
}

test("Mistral Conversations starts a stored multimodal conversation and assembles native events", async () => {
  let posted: Record<string, unknown> | undefined;
  let url = "";
  let authorization = "";
  const stream =
    event("conversation.response.started", { conversation_id: "conversation-1" }) +
    event("message.output.delta", {
      output_index: 0,
      content_index: 0,
      id: "message-1",
      model: "devstral-latest",
      role: "assistant",
      content: {
        type: "thinking",
        thinking: [{ type: "text", text: "Inspect the file. " }],
        closed: false,
      },
    }) +
    event("message.output.delta", {
      output_index: 0,
      content_index: 1,
      id: "message-1",
      model: "devstral-latest",
      role: "assistant",
      content: { type: "text", text: "Reading " },
    }) +
    event("message.output.delta", {
      output_index: 0,
      content_index: 1,
      id: "message-1",
      model: "devstral-latest",
      role: "assistant",
      content: "README.md",
    }) +
    event("function.call.delta", {
      output_index: 1,
      id: "function-entry-1",
      tool_call_id: "tool-call-1",
      name: "read_file",
      arguments: '{"path":',
    }) +
    event("function.call.delta", {
      output_index: 1,
      id: "function-entry-1",
      tool_call_id: "tool-call-1",
      name: "read_file",
      arguments: '"README.md"}',
    }) +
    event("conversation.response.done", {
      usage: {
        prompt_tokens: 1_024,
        completion_tokens: 64,
        total_tokens: 1_088,
        connector_tokens: 7,
        connectors: { web_search: 1 },
      },
    });

  const adapter = new MistralConversationsAdapter({
    apiKey: async () => "test-secret",
    store: true,
    fetch: fakeFetch(async (incoming) => {
      url = incoming.url;
      authorization = incoming.headers.get("authorization") ?? "";
      posted = (await incoming.json()) as Record<string, unknown>;
      return streamResponse(byteChunks(stream, [1, 2, 3, 5, 8, 13]), { "x-request-id": "request-1" });
    }),
  });
  const providerRequest = request("mistral");
  providerRequest.model = "devstral-latest";
  providerRequest.sessionId = "local-session-should-not-be-sent";
  providerRequest.maxOutputTokens = 512;
  providerRequest.reasoningEffort = "medium";
  providerRequest.metadata = { harness: "test" };
  providerRequest.messages.unshift({
    id: "system-1",
    role: "system",
    content: [{ type: "text", text: "Be concise." }],
    createdAt: "2026-07-10T00:00:00.000Z",
  });
  providerRequest.messages[1]!.content.push({ type: "image", mediaType: "image/png", data: "aGVsbG8=" });
  providerRequest.tools = [{
    name: "read_file",
    description: "Read one file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  }];

  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  assert.equal(url, "https://api.mistral.ai/v1/conversations");
  assert.equal(authorization, "Bearer test-secret");
  assert.deepEqual(posted, {
    model: "devstral-latest",
    inputs: [{
      object: "entry",
      type: "message.input",
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "image_url", image_url: "data:image/png;base64,aGVsbG8=" },
      ],
    }],
    stream: true,
    store: true,
    instructions: "Be concise.",
    tools: [{
      type: "function",
      function: {
        name: "read_file",
        description: "Read one file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        strict: false,
      },
    }],
    completion_args: { max_tokens: 512, reasoning_effort: "high" },
    metadata: { harness: "test" },
  });
  assert.equal("prompt_cache_key" in (posted ?? {}), false);
  assert.deepEqual(
    events.filter((entry) => entry.type === "reasoning_delta").map((entry) =>
      entry.type === "reasoning_delta" ? entry.text : ""),
    ["Inspect the file. "],
  );
  assert.deepEqual(
    events.filter((entry) => entry.type === "text_delta").map((entry) =>
      entry.type === "text_delta" ? entry.text : ""),
    ["Reading ", "README.md"],
  );
  const tool = events.find((entry) => entry.type === "tool_call_end");
  assert.deepEqual(tool?.type === "tool_call_end" ? tool.arguments : undefined, { path: "README.md" });
  const usage = events.find((entry) => entry.type === "usage");
  assert.deepEqual(usage?.type === "usage" ? usage.usage : undefined, {
    inputTokens: 1_024,
    outputTokens: 64,
    totalTokens: 1_088,
    raw: {
      prompt_tokens: 1_024,
      completion_tokens: 64,
      total_tokens: 1_088,
      connector_tokens: 7,
      connectors: { web_search: 1 },
    },
  });
  const start = events.find((entry) => entry.type === "response_start");
  assert.deepEqual(start, {
    type: "response_start",
    model: "devstral-latest",
    responseId: "conversation-1",
    requestId: "request-1",
  });
  const state = stateFrom(events);
  if (state.kind !== "mistral_conversations") assert.fail("wrong provider state");
  assert.equal(state.conversationId, "conversation-1");
  assert.equal(state.model, "devstral-latest");
  assert.equal(state.outputs.length, 2);
  assert.equal(state.requestFingerprint.length, 64);
  const end = events.at(-1);
  assert.equal(end?.type === "response_end" ? end.reason : undefined, "tool_calls");
});

test("Mistral Conversations appends only new function results and carries the returned conversation ID", async () => {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  let call = 0;
  const adapter = new MistralConversationsAdapter({
    store: true,
    fetch: fakeFetch(async (incoming) => {
      posts.push({ url: incoming.url, body: (await incoming.json()) as Record<string, unknown> });
      call += 1;
      return streamResponse(byteChunks(call === 1
        ? done("conversation-1", { tool: true })
        : done("conversation-2", { text: "finished" })));
    }),
  });
  const first = request("mistral");
  first.model = "devstral-latest";
  first.messages.unshift({
    id: "system-1",
    role: "system",
    content: [{ type: "text", text: "Use tools." }],
    createdAt: "2026-07-10T00:00:00.000Z",
  });
  first.tools = [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }];
  const firstEvents = await collect(adapter.stream(first, new AbortController().signal));

  const second: ProviderRequest = {
    ...first,
    messages: [
      ...first.messages,
      {
        id: "assistant-1",
        role: "assistant",
        content: [{
          type: "tool_call",
          callId: "tool-call-1",
          name: "read_file",
          arguments: { path: "README.md" },
        }],
        createdAt: "2026-07-10T00:00:01.000Z",
      },
      {
        id: "tool-1",
        role: "tool",
        content: [{
          type: "tool_result",
          callId: "tool-call-1",
          name: "read_file",
          content: "file text",
          isError: false,
          images: [{ type: "image", mediaType: "image/jpeg", url: "https://images.example.test/result.jpg" }],
        }],
        createdAt: "2026-07-10T00:00:02.000Z",
      },
    ],
    providerState: stateFrom(firstEvents),
  };
  const secondEvents = await collect(adapter.stream(second, new AbortController().signal));

  assert.equal(posts[1]?.url, "https://api.mistral.ai/v1/conversations/conversation-1");
  assert.deepEqual(posts[1]?.body, {
    inputs: [
      {
        object: "entry",
        type: "function.result",
        tool_call_id: "tool-call-1",
        result: "file text",
      },
      {
        object: "entry",
        type: "message.input",
        role: "user",
        content: [
          { type: "text", text: "Image output from tool read_file." },
          { type: "image_url", image_url: "https://images.example.test/result.jpg" },
        ],
      },
    ],
    stream: true,
    store: true,
  });
  const nextState = stateFrom(secondEvents);
  assert.equal(nextState.kind === "mistral_conversations" ? nextState.conversationId : undefined, "conversation-2");
});

test("Mistral Conversations stateless mode replays native outputs instead of appending remote state", async () => {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  let call = 0;
  const adapter = new MistralConversationsAdapter({
    store: false,
    fetch: fakeFetch(async (incoming) => {
      posts.push({ url: incoming.url, body: (await incoming.json()) as Record<string, unknown> });
      call += 1;
      return streamResponse(byteChunks(call === 1
        ? done("transient-1", { tool: true })
        : done("transient-2", { text: "ok" })));
    }),
  });
  const first = request("mistral");
  first.model = "devstral-latest";
  first.tools = [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }];
  const firstEvents = await collect(adapter.stream(first, new AbortController().signal));
  const firstState = stateFrom(firstEvents);
  assert.equal(firstState.kind === "mistral_conversations" ? firstState.conversationId : undefined, undefined);

  const second: ProviderRequest = {
    ...first,
    messages: [
      ...first.messages,
      {
        id: "assistant-1",
        role: "assistant",
        content: [{ type: "tool_call", callId: "tool-call-1", name: "read_file", arguments: { path: "README.md" } }],
        createdAt: "2026-07-10T00:00:01.000Z",
      },
      {
        id: "tool-1",
        role: "tool",
        content: [{ type: "tool_result", callId: "tool-call-1", name: "read_file", content: "ok", isError: false }],
        createdAt: "2026-07-10T00:00:02.000Z",
      },
    ],
    providerState: firstState,
  };
  await collect(adapter.stream(second, new AbortController().signal));
  assert.equal(posts[1]?.url, "https://api.mistral.ai/v1/conversations");
  assert.deepEqual((posts[1]?.body.inputs as unknown[]).slice(1), [
    {
      object: "entry",
      type: "function.call",
      id: "entry-transient-1",
      tool_call_id: "tool-call-1",
      name: "read_file",
      arguments: { path: "README.md" },
    },
    {
      object: "entry",
      type: "function.result",
      tool_call_id: "tool-call-1",
      result: "ok",
    },
  ]);
});

test("Mistral Conversations accepts documented built-in tool and output-image event shapes", async () => {
  const stream =
    event("conversation.response.started", { conversation_id: "conversation-built-in" }) +
    event("tool.execution.started", {
      output_index: 0,
      id: "tool-execution-1",
      name: "image_generation",
    }) +
    event("tool.execution.done", {
      output_index: 0,
      id: "tool-execution-1",
      name: "image_generation",
      info: { status: "succeeded" },
    }) +
    event("message.output.delta", {
      output_index: 1,
      content_index: 0,
      id: "message-1",
      role: "assistant",
      content: { type: "image_url", image_url: "https://images.example.test/generated.png" },
    }) +
    event("message.output.delta", {
      output_index: 1,
      content_index: 1,
      id: "message-1",
      role: "assistant",
      content: "Generated the image.",
    }) +
    event("conversation.response.done", {
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
  const adapter = new MistralConversationsAdapter({
    fetch: fakeFetch(() => streamResponse(byteChunks(stream))),
  });

  const events = await collect(adapter.stream(request("mistral"), new AbortController().signal));
  assert.equal(terminalCount(events), 1);
  assert.equal(events.filter((entry) => entry.type === "unknown_provider_event").length, 3);
  assert.deepEqual(events.filter((entry) => entry.type === "text_delta").map((entry) =>
    entry.type === "text_delta" ? entry.text : ""), ["Generated the image."]);
  const state = stateFrom(events);
  if (state.kind !== "mistral_conversations") assert.fail("wrong provider state");
  assert.deepEqual(state.outputs, [
    {
      object: "entry",
      type: "tool.execution",
      id: "tool-execution-1",
      name: "image_generation",
      arguments: "",
      info: { status: "succeeded" },
    },
    {
      object: "entry",
      type: "message.output",
      id: "message-1",
      role: "assistant",
      content: [
        { type: "image_url", image_url: "https://images.example.test/generated.png" },
        { type: "text", text: "Generated the image." },
      ],
    },
  ]);
});

test("Mistral Conversations bounds malformed streams and maps cancellation and provider errors", async () => {
  const beforeStart = new MistralConversationsAdapter({
    fetch: fakeFetch(() => streamResponse(byteChunks(event("conversation.response.done", { usage: {} })))),
  });
  const malformed = await collect(beforeStart.stream(request("mistral"), new AbortController().signal));
  assert.equal(terminalCount(malformed), 1);
  const malformedError = malformed.at(-1);
  assert.equal(malformedError?.type === "error" ? malformedError.error.category : undefined, "protocol");

  const providerFailure = new MistralConversationsAdapter({
    fetch: fakeFetch(() => streamResponse(byteChunks(
      event("conversation.response.started", { conversation_id: "conversation-1" }) +
      event("conversation.response.error", { message: "capacity unavailable", code: 503 }),
    ))),
  });
  const failed = await collect(providerFailure.stream(request("mistral"), new AbortController().signal));
  const error = failed.at(-1);
  assert.equal(error?.type === "error" ? error.error.category : undefined, "overloaded");
  assert.equal(error?.type === "error" ? error.error.providerCode : undefined, "503");

  const controller = new AbortController();
  controller.abort();
  const cancelled = new MistralConversationsAdapter({
    fetch: fakeFetch(() => {
      throw new DOMException("aborted", "AbortError");
    }),
  });
  const cancelledEvents = await collect(cancelled.stream(request("mistral"), controller.signal));
  const cancellationError = cancelledEvents.at(-1);
  assert.equal(cancellationError?.type === "error" ? cancellationError.error.category : undefined, "cancelled");

  const bounded = new MistralConversationsAdapter({
    maxEventBytes: 8,
    fetch: fakeFetch(() => streamResponse(byteChunks(done("conversation-1", { text: "too large" })))),
  });
  const boundedEvents = await collect(bounded.stream(request("mistral"), new AbortController().signal));
  const boundedError = boundedEvents.at(-1);
  assert.equal(boundedError?.type === "error" ? boundedError.error.category : undefined, "protocol");
  assert.match(boundedError?.type === "error" ? boundedError.error.message : "", /event exceeded/u);
});

test("Mistral Conversations discovers usable models and exposes explicit remote cleanup", async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const adapter = new MistralConversationsAdapter({
    fetch: fakeFetch((incoming) => {
      calls.push({ method: incoming.method, url: incoming.url });
      if (incoming.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({
        object: "list",
        data: [
          {
            id: "devstral-latest",
            name: "Devstral",
            max_context_length: 262_144,
            capabilities: { completion_chat: true, function_calling: true, vision: false },
          },
          {
            id: "vision-latest",
            max_context_length: 128_000,
            capabilities: { completion_chat: true, function_calling: false, vision: true },
          },
          { id: "embed-only", capabilities: { completion_chat: false } },
          { id: "archived-chat", archived: true, capabilities: { completion_chat: true } },
        ],
      }), { headers: { "content-type": "application/json" } });
    }),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.deepEqual(models.map((model) => [
    model.id,
    model.contextTokens,
    model.capabilities.tools.value,
    model.capabilities.images.value,
    model.capabilities.reasoning.value,
  ]), [
    ["devstral-latest", 262_144, "supported", "unsupported", "unknown"],
    ["vision-latest", 128_000, "unsupported", "supported", "unknown"],
  ]);
  await adapter.deleteConversation("conversation/id", new AbortController().signal);
  assert.deepEqual(calls, [
    { method: "GET", url: "https://api.mistral.ai/v1/models" },
    { method: "DELETE", url: "https://api.mistral.ai/v1/conversations/conversation%2Fid" },
  ]);
});
