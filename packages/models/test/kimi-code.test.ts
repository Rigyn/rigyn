import assert from "node:assert/strict";
import test from "node:test";

import { kimiCodeProvider, Type } from "../src/index.ts";
import { captureFetch, collect, model, sse, userContext } from "./black-box-helpers.ts";

test("Kimi Code's public provider sends the same bounded coding request as the product runtime", async () => {
  const provider = kimiCodeProvider({ models: [model("openai-completions", {
    id: "k3",
    name: "Kimi K3",
    provider: "kimi-code",
    baseUrl: "https://api.kimi.com/coding/v1",
    reasoning: true,
    thinkingLevelMap: { high: "high" },
    compat: {
      maxTokensField: "max_completion_tokens",
      supportsReasoningEffort: true,
      requiresReasoningContentOnAssistantMessages: true,
    },
  })] });
  const selected = provider.getModels().find((model) => model.id === "k3");
  assert.ok(selected);
  const mock = captureFetch(() => sse([
    {
      id: "kimi-response",
      model: "k3",
      choices: [{
        index: 0,
        delta: { reasoning_content: "checked", content: "done" },
        finish_reason: "stop",
      }],
    },
    "[DONE]",
  ]));
  const diagnostics: unknown[] = [];
  const context = {
    ...userContext(),
    tools: [{
      name: "read",
      description: "Read a file",
      parameters: Type.Object({ path: Type.String() }),
    }],
  };

  const result = await collect(provider.streamSimple!(selected, context, {
    apiKey: "membership-key",
    fetch: mock.fetch,
    maxRetries: 0,
    maxTokens: 2_048,
    reasoning: "high",
    sessionId: "session-7",
    onRequest(value) { diagnostics.push(value); },
  }));

  assert.equal(mock.requests[0]?.url, "https://api.kimi.com/coding/v1/chat/completions");
  const headers = new Headers(mock.requests[0]?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer membership-key");
  for (const header of ["x-msh-platform", "chatgpt-account-id", "copilot-integration-id", "anthropic-version"]) {
    assert.equal(headers.has(header), false, header);
  }
  assert.equal(mock.requests[0]?.body.model, "k3");
  assert.equal(mock.requests[0]?.body.max_completion_tokens, 2_048);
  assert.equal(mock.requests[0]?.body.max_tokens, undefined);
  assert.equal(mock.requests[0]?.body.reasoning_effort, "high");
  assert.equal(mock.requests[0]?.body.prompt_cache_key, "session-7");
  assert.equal(Array.isArray(mock.requests[0]?.body.tools), true);
  assert.equal((diagnostics[0] as { headers?: Record<string, string> }).headers?.authorization, "[redacted]");
  assert.equal(result.terminal.stopReason, "stop");
  assert.deepEqual(result.terminal.content, [
    { type: "text", text: "done" },
    { type: "thinking", thinking: "checked" },
  ]);
});
