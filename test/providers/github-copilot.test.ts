import assert from "node:assert/strict";
import test from "node:test";

import { GitHubCopilotAdapter } from "../../src/providers/github-copilot.js";
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
