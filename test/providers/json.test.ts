import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderAdapter, ProviderId, ProviderRequest } from "../../src/core/types.js";
import { AnthropicAdapter } from "../../src/providers/anthropic.js";
import { BedrockAdapter } from "../../src/providers/bedrock.js";
import { GeminiInteractionsAdapter } from "../../src/providers/gemini-interactions.js";
import { GeminiAdapter, VertexAdapter } from "../../src/providers/gemini.js";
import { sanitizeUnicode, stringifyProviderJson } from "../../src/providers/json.js";
import { OllamaAdapter } from "../../src/providers/ollama.js";
import { OpenAICompatibleAdapter, OpenRouterAdapter } from "../../src/providers/openai-compatible.js";
import { AzureOpenAIResponsesAdapter, OpenAIResponsesAdapter } from "../../src/providers/openai-responses.js";
import { collect, fakeFetch } from "./helpers.js";

test("provider JSON sanitization preserves valid pairs and replaces only lone surrogates", () => {
  assert.equal(sanitizeUnicode("before 😀 after"), "before 😀 after");
  assert.equal(sanitizeUnicode("high\ud800 low\udc00"), "high� low�");
  assert.deepEqual(JSON.parse(stringifyProviderJson({
    "file\ud800": "value\udc00",
    emoji: "😀",
  })), {
    "file�": "value�",
    emoji: "😀",
  });
  assert.throws(
    () => stringifyProviderJson({ "same\ud800": 1, "same\udc00": 2 }),
    /collide/u,
  );
});

test("every native provider sanitizes text, tool arguments, and tool output before JSON transport", async (t) => {
  const cases: Array<{
    name: string;
    provider: ProviderId;
    create(fetch: typeof globalThis.fetch): ProviderAdapter;
  }> = [
    { name: "OpenAI Responses", provider: "openai", create: (fetch) => new OpenAIResponsesAdapter({ apiKey: "offline", fetch }) },
    { name: "Azure Responses", provider: "azure-openai", create: (fetch) => new AzureOpenAIResponsesAdapter({ endpoint: "https://azure.example.test", apiKey: "offline", fetch }) },
    { name: "Anthropic", provider: "anthropic", create: (fetch) => new AnthropicAdapter({ apiKey: "offline", fetch }) },
    { name: "Gemini", provider: "gemini", create: (fetch) => new GeminiAdapter({ apiKey: "offline", fetch }) },
    { name: "Vertex", provider: "vertex", create: (fetch) => new VertexAdapter({ project: "offline-project", accessToken: "offline", fetch }) },
    { name: "Gemini Interactions", provider: "gemini", create: (fetch) => new GeminiInteractionsAdapter({ apiKey: "offline", fetch }) },
    { name: "Bedrock", provider: "bedrock", create: (fetch) => new BedrockAdapter({ region: "us-east-1", signer: (request) => request, fetch }) },
    { name: "OpenAI-compatible", provider: "openai-compatible", create: (fetch) => new OpenAICompatibleAdapter({ baseUrl: "https://chat.example.test/v1", apiKey: "offline", fetch }) },
    { name: "OpenRouter", provider: "openrouter", create: (fetch) => new OpenRouterAdapter({ apiKey: "offline", fetch }) },
    { name: "Ollama", provider: "ollama", create: (fetch) => new OllamaAdapter({ fetch }) },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      let posted: unknown;
      const adapter = entry.create(fakeFetch(async (incoming) => {
        posted = JSON.parse(await incoming.text()) as unknown;
        return new Response(JSON.stringify({ error: { message: "offline" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }));
      await collect(adapter.stream(surrogateRequest(entry.provider), new AbortController().signal));
      assert.notEqual(posted, undefined);
      const strings = collectStrings(posted);
      assert.equal(strings.some((value) => value.includes("😀")), true);
      assert.equal(strings.some((value) => value.includes("\\ud800") || value.includes("\\udc00")), false);
      assert.equal(strings.some((value) => sanitizeUnicode(value) !== value), false);
      assert.equal(strings.some((value) => value.includes("�")), true);
    });
  }
});

function surrogateRequest(provider: ProviderId): ProviderRequest {
  return {
    provider,
    model: "offline-model",
    messages: [
      {
        id: "user",
        role: "user",
        content: [{ type: "text", text: "inspect file-\ud800.txt and keep 😀" }],
        createdAt: "2026-07-10T00:00:00.000Z",
      },
      {
        id: "assistant",
        role: "assistant",
        content: [{
          type: "tool_call",
          callId: "unicode-call",
          name: "read",
          arguments: { path: "file-\ud800.txt", marker: "😀" },
          rawArguments: "{\"path\":\"file-\\ud800.txt\"}",
        }],
        createdAt: "2026-07-10T00:00:01.000Z",
      },
      {
        id: "tool",
        role: "tool",
        content: [{
          type: "tool_result",
          callId: "unicode-call",
          name: "read",
          content: "tool output \udc00 with 😀",
          isError: false,
        }],
        createdAt: "2026-07-10T00:00:02.000Z",
      },
    ],
    tools: [],
  };
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...collectStrings(entry)]);
  }
  return [];
}
