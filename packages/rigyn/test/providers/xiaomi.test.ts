import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderState } from "../../src/core/types.js";
import { OpenAICompatibleAdapter } from "../../src/providers/openai-compatible.js";
import { byteChunks, collect, fakeFetch, request, streamResponse, terminalCount } from "./helpers.js";

function sse(...values: unknown[]): string {
  return values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
}

test("Xiaomi profile uses binary thinking and replays reasoning_content across tool turns", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const authorization: Array<string | null> = [];
  const responses = [
    sse({
      id: "mimo-tool-turn",
      model: "mimo-v2.5-pro",
      choices: [{
        index: 0,
        delta: {
          reasoning_content: "inspect the workspace",
          tool_calls: [{ index: 0, id: "call-read", function: { name: "read", arguments: '{"path":"README.md"}' } }],
        },
        finish_reason: "tool_calls",
      }],
    }),
    sse({
      id: "mimo-answer-turn",
      model: "mimo-v2.5-pro",
      choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
    }),
  ];
  const adapter = new OpenAICompatibleAdapter({
    id: "xiaomi",
    baseUrl: "https://api.xiaomimimo.com/v1",
    apiKey: "mimo-key",
    profile: "xiaomi",
    fetch: fakeFetch(async (incoming) => {
      authorization.push(incoming.headers.get("authorization"));
      bodies.push(await incoming.json() as Record<string, unknown>);
      return streamResponse(byteChunks(responses[bodies.length - 1]!));
    }),
  });

  const first = request("xiaomi");
  first.model = "mimo-v2.5-pro";
  first.reasoningEffort = "high";
  first.tools = [{
    name: "read",
    description: "Read a file",
    inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
  }];
  const firstEvents = await collect(adapter.stream(first, new AbortController().signal));
  assert.equal(terminalCount(firstEvents), 1);
  assert.deepEqual(
    firstEvents.filter((event) => event.type === "reasoning_delta").map((event) => event.type === "reasoning_delta" ? event.text : ""),
    ["inspect the workspace"],
  );
  assert.deepEqual(bodies[0]?.thinking, { type: "enabled" });
  assert.equal(bodies[0]?.reasoning_effort, undefined);
  assert.equal(bodies[0]?.parallel_tool_calls, undefined);
  assert.deepEqual(bodies[0]?.stream_options, { include_usage: true });
  assert.equal(authorization[0], "Bearer mimo-key");

  const firstEnd = firstEvents.at(-1);
  assert.equal(firstEnd?.type, "response_end");
  const state: ProviderState | undefined = firstEnd?.type === "response_end" ? firstEnd.state : undefined;
  assert.equal(state?.kind, "chat_completions");
  if (state?.kind !== "chat_completions") return;
  assert.deepEqual(state.assistantMessage, {
    role: "assistant",
    content: "",
    reasoning_content: "inspect the workspace",
    tool_calls: [{
      id: "call-read",
      type: "function",
      function: { name: "read", arguments: '{"path":"README.md"}' },
    }],
  });

  const second = request("xiaomi");
  second.model = "mimo-v2.5-pro";
  second.reasoningEffort = "high";
  second.providerState = state;
  second.messages = [
    first.messages[0]!,
    {
      id: "assistant-tool",
      role: "assistant",
      content: [{ type: "tool_call", callId: "call-read", name: "read", arguments: { path: "README.md" } }],
      createdAt: "2026-07-19T00:00:01.000Z",
    },
    {
      id: "tool-result",
      role: "tool",
      content: [{ type: "tool_result", callId: "call-read", name: "read", content: "contents", isError: false }],
      createdAt: "2026-07-19T00:00:02.000Z",
    },
  ];
  const secondEvents = await collect(adapter.stream(second, new AbortController().signal));
  assert.equal(terminalCount(secondEvents), 1);
  const secondMessages = bodies[1]?.messages as Array<Record<string, unknown>>;
  assert.equal(secondMessages[1]?.reasoning_content, "inspect the workspace");
  assert.deepEqual(bodies[1]?.thinking, { type: "enabled" });
  assert.equal(authorization[1], "Bearer mimo-key");
});

test("Xiaomi profile maps omitted, off, and none reasoning to disabled thinking", async () => {
  for (const effort of [undefined, "off", "none"] as const) {
    let body: Record<string, unknown> | undefined;
    const adapter = new OpenAICompatibleAdapter({
      id: "xiaomi",
      baseUrl: "https://api.xiaomimimo.com/v1",
      profile: "xiaomi",
      fetch: fakeFetch(async (incoming) => {
        body = await incoming.json() as Record<string, unknown>;
        return streamResponse(byteChunks(sse({
          id: "mimo-no-thinking",
          model: "mimo-v2.5-pro",
          choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
        })));
      }),
    });
    const input = request("xiaomi");
    input.model = "mimo-v2.5-pro";
    if (effort !== undefined) input.reasoningEffort = effort;
    assert.equal(terminalCount(await collect(adapter.stream(input, new AbortController().signal))), 1);
    assert.deepEqual(body?.thinking, { type: "disabled" });
    assert.equal(body?.reasoning_effort, undefined);
  }
});

test("Xiaomi live discovery exposes only documented chat models with coding capabilities", async () => {
  let requestedUrl = "";
  const adapter = new OpenAICompatibleAdapter({
    id: "xiaomi",
    baseUrl: "https://api.xiaomimimo.com/v1",
    apiKey: "mimo-key",
    profile: "xiaomi",
    fetch: fakeFetch((incoming) => {
      requestedUrl = incoming.url;
      return new Response(JSON.stringify({
        object: "list",
        data: [
          { id: "mimo-v2-pro", object: "model", owned_by: "xiaomi" },
          { id: "mimo-v2.5", object: "model", owned_by: "xiaomi" },
          { id: "mimo-v2.5-asr", object: "model", owned_by: "xiaomi" },
          { id: "mimo-v2.5-pro", object: "model", owned_by: "xiaomi" },
          { id: "mimo-v2.5-tts", object: "model", owned_by: "xiaomi" },
          { id: "mimo-v2.5-tts-voiceclone", object: "model", owned_by: "xiaomi" },
          { id: "mimo-v2.5-tts-voicedesign", object: "model", owned_by: "xiaomi" },
        ],
      }), { headers: { "content-type": "application/json" } });
    }),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.equal(requestedUrl, "https://api.xiaomimimo.com/v1/models");
  assert.deepEqual(models.map((model) => model.id), ["mimo-v2-pro", "mimo-v2.5", "mimo-v2.5-pro"]);
  assert.deepEqual(models.map((model) => ({
    id: model.id,
    contextTokens: model.contextTokens,
    maxOutputTokens: model.maxOutputTokens,
    tools: model.capabilities.tools.value,
    reasoning: model.capabilities.reasoning.value,
    images: model.capabilities.images.value,
    reasoningEfforts: model.compatibility?.reasoningEfforts?.value,
  })), [
    {
      id: "mimo-v2-pro",
      contextTokens: 262_144,
      maxOutputTokens: 32_768,
      tools: "supported",
      reasoning: "supported",
      images: "unsupported",
      reasoningEfforts: ["off", "high"],
    },
    {
      id: "mimo-v2.5",
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
      tools: "supported",
      reasoning: "supported",
      images: "supported",
      reasoningEfforts: ["off", "high"],
    },
    {
      id: "mimo-v2.5-pro",
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
      tools: "supported",
      reasoning: "supported",
      images: "unsupported",
      reasoningEfforts: ["off", "high"],
    },
  ]);
});
