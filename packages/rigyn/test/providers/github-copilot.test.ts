import assert from "node:assert/strict";
import test from "node:test";

import type { AdapterEvent, ProviderState } from "../../src/core/types.js";
import { GitHubCopilotAdapter } from "../../src/providers/github-copilot.js";
import { OpenAICompatibleAdapter } from "../../src/providers/openai-compatible.js";
import { byteChunks, collect, fakeFetch, request, streamResponse, terminalCount } from "./helpers.js";

test("GitHub Copilot lists only enabled tool-capable models and streams through their advertised protocol", async () => {
  const urls: string[] = [];
  let streamHeaders: Headers | undefined;
  const adapter = new GitHubCopilotAdapter({
    credential: async () => ({
      accessToken: "tid=fixture;proxy-ep=proxy.individual.githubcopilot.com;exp=fixture",
    }),
    fetch: fakeFetch((incoming) => {
      urls.push(incoming.url);
      if (incoming.url.endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [
            {
              id: "gemini-code",
              name: "Gemini Code",
              model_picker_enabled: true,
              policy: { state: "enabled" },
              capabilities: {
                type: "openai-completions",
                supports: { tool_calls: true, vision: true, reasoning_effort: true },
                limits: { max_context_window_tokens: 200_000, max_output_tokens: 32_000 },
              },
            },
            { id: "disabled", model_picker_enabled: true, policy: { state: "disabled" } },
            { id: "no-tools", model_picker_enabled: true, capabilities: { supports: { tool_calls: false } } },
          ],
        }), { headers: { "content-type": "application/json" } });
      }
      streamHeaders = incoming.headers;
      return streamResponse(byteChunks([
        `data: ${JSON.stringify({ id: "chat-1", model: "gemini-code", choices: [{ index: 0, delta: { content: "working" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "chat-1", model: "gemini-code", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join("")));
    }),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.equal(models.length, 1);
  assert.equal(models[0]?.id, "gemini-code");
  assert.equal(models[0]?.provider, "github-copilot");
  assert.equal(models[0]?.contextTokens, 200_000);
  assert.equal(models[0]?.maxOutputTokens, 32_000);
  assert.equal(models[0]?.compatibility?.protocolFamily?.value, "openai-chat-completions");
  assert.deepEqual(models[0]?.compatibility?.inputModalities?.value, ["text", "image"]);

  const providerRequest = request("github-copilot");
  providerRequest.model = "gemini-code";
  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
  assert.deepEqual(events.filter((event) => event.type === "text_delta"), [{ type: "text_delta", part: 0, text: "working" }]);
  assert.equal(terminalCount(events), 1);
  assert.deepEqual(urls, [
    "https://api.individual.githubcopilot.com/models",
    "https://api.individual.githubcopilot.com/chat/completions",
  ]);
  assert.match(streamHeaders?.get("authorization") ?? "", /^Bearer /u);
  assert.equal(streamHeaders?.get("x-initiator"), "user");
  assert.equal(streamHeaders?.get("openai-intent"), "conversation-edits");
});

test("GitHub Copilot rejects hostile delegate events before mapping them", async (context) => {
  let reads = 0;
  let resumed = 0;
  const hostile = new Proxy({}, {
    get(_target, key) {
      if (key === "type") reads += 1;
      return key === "type" ? "response_start" : undefined;
    },
  });
  context.mock.method(OpenAICompatibleAdapter.prototype, "stream", async function* () {
    yield hostile as AdapterEvent;
    resumed += 1;
    yield { type: "response_start", model: "late" };
  });
  const adapter = new GitHubCopilotAdapter({
    credential: async () => ({ accessToken: "token" }),
    fetch: fakeFetch(() => new Response("unavailable", { status: 503 })),
  });
  const providerRequest = request("github-copilot");
  providerRequest.model = "hostile-model";
  providerRequest.providerState = { kind: "chat_completions", assistantMessage: {} };

  const events = await collect(adapter.stream(providerRequest, new AbortController().signal));

  assert.equal(reads, 0);
  assert.equal(resumed, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  if (events[0]?.type === "error") {
    assert.equal(events[0].error.category, "protocol");
    assert.equal(events[0].error.retryable, false);
    assert.equal(events[0].error.partial, false);
  }
});

test("GitHub Copilot supplies maintained capabilities when Claude Opus 5 metadata is incomplete", async () => {
  const adapter = new GitHubCopilotAdapter({
    credential: async () => ({ accessToken: "token" }),
    fetch: fakeFetch(() => new Response(JSON.stringify({
      data: [{
        id: "claude-opus-5",
        model_picker_enabled: true,
        policy: { state: "enabled" },
        capabilities: { supports: { tool_calls: true, thinking: true } },
      }],
    }), { headers: { "content-type": "application/json" } })),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.equal(models.length, 1);
  assert.equal(models[0]?.id, "claude-opus-5");
  assert.equal(models[0]?.contextTokens, 1_000_000);
  assert.equal(models[0]?.maxOutputTokens, 128_000);
  assert.equal(models[0]?.compatibility?.protocolFamily?.value, "anthropic-messages");
  assert.deepEqual(models[0]?.compatibility?.reasoningEfforts?.value, [
    "off", "minimal", "low", "medium", "high", "xhigh", "max",
  ]);
});

test("GitHub Copilot prefers advertised endpoints over conflicting descriptive metadata for every protocol", async () => {
  const requests: Request[] = [];
  const adapter = new GitHubCopilotAdapter({
    credential: async () => ({
      accessToken: "tid=fixture;proxy-ep=proxy.individual.githubcopilot.com;exp=fixture",
    }),
    fetch: fakeFetch(async (incoming) => {
      requests.push(incoming);
      if (incoming.url.endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [
            {
              id: "structured-messages",
              model_picker_enabled: true,
              supported_endpoints: ["/v1/messages"],
              capabilities: { type: "chat", supports: { tool_calls: true } },
              notes: { fallback: "/responses" },
            },
            {
              id: "structured-responses",
              model_picker_enabled: true,
              supported_endpoints: ["/responses"],
              capabilities: { type: "chat", supports: { tool_calls: true, reasoning_effort: ["low", "high"] } },
              notes: { fallback: "/v1/messages" },
            },
            {
              id: "structured-chat",
              model_picker_enabled: true,
              supported_endpoints: ["/chat/completions"],
              capabilities: { type: "chat", supports: { tool_calls: true } },
              notes: { fallback: "/responses" },
            },
          ],
        }), { headers: { "content-type": "application/json" } });
      }
      if (incoming.url.endsWith("/v1/messages")) return anthropicResponse();
      if (incoming.url.endsWith("/responses")) return responsesResponse();
      return chatResponse();
    }),
  });

  const models = await adapter.listModels(new AbortController().signal);
  assert.deepEqual(models.map((model) => [model.id, model.compatibility?.protocolFamily?.value]), [
    ["structured-chat", "openai-chat-completions"],
    ["structured-messages", "anthropic-messages"],
    ["structured-responses", "openai-responses"],
  ]);
  assert.deepEqual(
    models.find((model) => model.id === "structured-responses")?.compatibility?.reasoningEfforts?.value,
    ["low", "high"],
  );

  for (const model of ["structured-messages", "structured-responses", "structured-chat"]) {
    const providerRequest = request("github-copilot");
    providerRequest.model = model;
    providerRequest.reasoningEffort = "high";
    const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
    assert.equal(terminalCount(events), 1);
  }
  assert.deepEqual(requests.slice(1).map((incoming) => new URL(incoming.url).pathname), [
    "/v1/messages",
    "/responses",
    "/chat/completions",
  ]);
  const responsesBody = await requests[2]!.clone().json() as Record<string, unknown>;
  assert.deepEqual(responsesBody.reasoning, { effort: "high", summary: "auto" });
});

test("GitHub Copilot uses durable provider state only when model discovery cannot recover a protocol", async () => {
  const paths: string[] = [];
  const adapter = new GitHubCopilotAdapter({
    credential: async () => ({
      accessToken: "tid=fixture;proxy-ep=proxy.individual.githubcopilot.com;exp=fixture",
    }),
    fetch: fakeFetch((incoming) => {
      const path = new URL(incoming.url).pathname;
      paths.push(path);
      if (path === "/models") return new Response("unavailable", { status: 503 });
      if (path === "/v1/messages") return anthropicResponse();
      if (path === "/responses") return responsesResponse();
      return chatResponse();
    }),
  });
  const cases: Array<{ model: string; state: ProviderState; path: string }> = [
    { model: "resume-messages", state: { kind: "anthropic_messages", assistantBlocks: [] }, path: "/v1/messages" },
    { model: "resume-responses", state: { kind: "openai_responses", outputItems: [] }, path: "/responses" },
    {
      model: "resume-chat",
      state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "prior" } },
      path: "/chat/completions",
    },
  ];
  for (const entry of cases) {
    const providerRequest = request("github-copilot");
    providerRequest.model = entry.model;
    providerRequest.providerState = entry.state;
    const events = await collect(adapter.stream(providerRequest, new AbortController().signal));
    assert.equal(terminalCount(events), 1);
  }
  assert.deepEqual(paths, cases.flatMap((entry) => ["/models", entry.path]));
});

function anthropicResponse(): Response {
  return streamResponse(byteChunks([
    { type: "message_start", message: { id: "message", model: "model", usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
}

function responsesResponse(): Response {
  return streamResponse(byteChunks([
    { type: "response.created", response: { id: "response", model: "model" } },
    { type: "response.reasoning_summary_text.delta", item_id: "reasoning", output_index: 0, summary_index: 0, delta: "plan" },
    { type: "response.output_text.delta", content_index: 0, delta: "ok" },
    { type: "response.completed", response: { id: "response", model: "model", usage: {} } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
}

function chatResponse(): Response {
  return streamResponse(byteChunks([
    `data: ${JSON.stringify({ id: "chat", model: "model", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "chat", model: "model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("")));
}
