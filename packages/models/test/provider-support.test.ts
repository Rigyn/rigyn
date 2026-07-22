import assert from "node:assert/strict";
import test from "node:test";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.js";
import { buildCopilotDynamicHeaders } from "../src/api/github-copilot-headers.js";
import { stream as streamCompletions, streamSimple as streamSimpleCompletions } from "../src/api/openai-completions.js";
import { stream as streamResponses } from "../src/api/openai-responses.js";
import { getImageModel, getImageModels, getImageProviders } from "../src/image-models.js";
import { MODELS } from "../src/models.generated.js";
import { cloudflareAIGatewayAuth } from "../src/providers/cloudflare-auth.js";
import { resolveCloudflareModel } from "../src/providers/cloudflare-stream.js";
import { GITHUB_COPILOT_MODELS } from "../src/providers/github-copilot.models.js";
import { ANTHROPIC_MODELS } from "../src/providers/anthropic.models.js";
import { OPENAI_MODELS } from "../src/providers/openai.models.js";
import type { Context, Model } from "../src/types.js";
import { formatProviderError, MAX_PROVIDER_ERROR_BODY_CHARS, normalizeProviderError } from "../src/utils/error-body.js";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const sse = (...events: Array<Record<string, unknown>>): Response => new Response(
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

test("provider model submodules expose the same immutable catalog objects", () => {
  assert.equal(OPENAI_MODELS, MODELS.openai);
  assert.equal(GITHUB_COPILOT_MODELS, MODELS["github-copilot"]);
  assert.ok(Object.keys(OPENAI_MODELS).length > 0);
  assert.deepEqual(GITHUB_COPILOT_MODELS, {});
  assert.ok(Object.isFrozen(OPENAI_MODELS));
});

test("static image model reads are complete and provider-scoped", () => {
  assert.deepEqual(getImageProviders(), ["openrouter"]);
  const models = getImageModels("openrouter");
  assert.ok(models.length > 0);
  assert.equal(getImageModel("openrouter", models[0]!.id), models[0]);
});

test("Cloudflare auth merges each stored and ambient field and materializes endpoint placeholders", async () => {
  const auth = cloudflareAIGatewayAuth();
  const result = await auth.resolve({
    credential: { type: "api_key", key: "stored-key" },
    ctx: {
      async env(name) { return name === "CLOUDFLARE_ACCOUNT_ID" ? "account" : name === "CLOUDFLARE_GATEWAY_ID" ? "gateway" : undefined; },
      async fileExists() { return false; },
    },
  });
  assert.deepEqual(result, {
    auth: { headers: { "cf-aig-authorization": "Bearer stored-key", authorization: null, "x-api-key": null } },
    env: { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_GATEWAY_ID: "gateway" },
    source: "stored credential",
  });
  const model = { id: "m", name: "M", api: "openai-responses", provider: "cloudflare-ai-gateway", baseUrl: "https://gateway/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100, maxTokens: 10 } as Model<"openai-responses">;
  assert.equal(resolveCloudflareModel(model, result!.env).baseUrl, "https://gateway/account/gateway");
});

test("provider error metadata retains bounded response bodies", () => {
  const error = Object.assign(new Error("request failed"), { status: 403, error: { detail: "denied" } });
  assert.equal(formatProviderError(normalizeProviderError(error), "Provider"), 'Provider (403): {"detail":"denied"}');
  const oversized = Object.assign(new Error("failed"), { statusCode: 500, body: "x".repeat(MAX_PROVIDER_ERROR_BODY_CHARS + 25) });
  const normalized = normalizeProviderError(oversized);
  assert.equal(normalized.body?.length, MAX_PROVIDER_ERROR_BODY_CHARS + "... [truncated 25 chars]".length);
  assert.match(normalized.body ?? "", /truncated 25 chars/u);
});

test("Copilot dynamic headers describe initiator and vision input", () => {
  assert.deepEqual(buildCopilotDynamicHeaders({ messages: context.messages }), { "X-Initiator": "user", "Openai-Intent": "conversation-edits" });
  const messages: Context["messages"] = [{ role: "toolResult", toolCallId: "call", toolName: "view", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], isError: false, timestamp: 1 }];
  assert.deepEqual(buildCopilotDynamicHeaders({ messages }), { "X-Initiator": "agent", "Openai-Intent": "conversation-edits", "Copilot-Vision-Request": "true" });
});

test("all Copilot transports apply static, dynamic, and Bearer authentication headers", async () => {
  const observed: Headers[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    observed.push(new Headers(init?.headers));
    const url = String(_input);
    if (url.endsWith("/messages")) return sse(
      { type: "message_start", message: { id: "a", usage: {} } },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    );
    if (url.endsWith("/chat/completions")) return sse({ id: "c", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] });
    return sse({ type: "response.completed", response: { id: "r", usage: {} } });
  };
  const common = {
    name: "Copilot fixture", provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com",
    reasoning: false, input: ["text"] as Array<"text">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 4_096,
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0" },
  };
  const anthropic = { ...common, id: "messages", api: "anthropic-messages" } satisfies Model<"anthropic-messages">;
  const completions = { ...common, id: "completions", api: "openai-completions" } satisfies Model<"openai-completions">;
  const responses = { ...common, id: "responses", api: "openai-responses" } satisfies Model<"openai-responses">;
  await streamAnthropic(anthropic, context, { apiKey: "token", fetch, maxRetries: 0 }).result();
  await streamCompletions(completions, context, { apiKey: "token", fetch, maxRetries: 0 }).result();
  await streamResponses(responses, context, { apiKey: "token", fetch, maxRetries: 0 }).result();
  assert.equal(observed.length, 3);
  for (const headers of observed) {
    assert.equal(headers.get("authorization"), "Bearer token");
    assert.equal(headers.get("x-initiator"), "user");
    assert.equal(headers.get("openai-intent"), "conversation-edits");
    assert.match(headers.get("user-agent") ?? "", /GitHubCopilotChat/u);
  }
  assert.equal(observed[0]!.get("x-api-key"), null);
});

test("deferred tool markers become native Anthropic references and Responses search results", async () => {
  const toolContext: Context = {
    messages: [
      { role: "user", content: "work", timestamp: 1 },
      { role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-5.4", content: [{ type: "toolCall", id: "call", name: "base_tool", arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "call", toolName: "base_tool", content: [{ type: "text", text: "done" }], addedToolNames: ["late_tool"], isError: false, timestamp: 3 },
    ],
    tools: [
      { name: "base_tool", description: "Base", parameters: { type: "object", properties: {} } },
      { name: "late_tool", description: "Late", parameters: { type: "object", properties: {} } },
    ],
  };
  const payloads: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return String(_input).endsWith("/messages")
      ? sse({ type: "message_start", message: { id: "a", usage: {} } }, { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" })
      : sse({ type: "response.completed", response: { id: "r", usage: {} } });
  };
  const anthropic = {
    ...ANTHROPIC_MODELS["claude-opus-4-8"],
    compat: { supportsToolReferences: true },
  } as Model<"anthropic-messages">;
  const responses = {
    ...OPENAI_MODELS["gpt-5.4"],
    compat: { supportsToolSearch: true },
  } as Model<"openai-responses">;
  await streamAnthropic(anthropic, toolContext, { apiKey: "key", fetch, maxRetries: 0 }).result();
  await streamResponses(responses, toolContext, { apiKey: "key", fetch, maxRetries: 0 }).result();
  const anthropicTools = payloads[0]!.tools as Array<Record<string, unknown>>;
  assert.deepEqual(anthropicTools.map((tool) => [tool.name, tool.defer_loading]), [["base_tool", undefined], ["late_tool", true]]);
  const anthropicMessages = payloads[0]!.messages as Array<{ content: Array<Record<string, unknown>> }>;
  const result = anthropicMessages.flatMap((message) => message.content).find((block) => block.type === "tool_result")!;
  assert.deepEqual(result.content, [{ type: "tool_reference", tool_name: "late_tool" }]);
  const responseTools = payloads[1]!.tools as Array<Record<string, unknown>>;
  assert.deepEqual(responseTools.map((tool) => tool.name), ["base_tool"]);
  const input = payloads[1]!.input as Array<Record<string, unknown>>;
  const search = input.find((item) => item.type === "tool_search_output")!;
  assert.deepEqual((search.tools as Array<Record<string, unknown>>).map((tool) => [tool.name, tool.defer_loading]), [["late_tool", true]]);
});

test("simple streams clamp output to remaining context and cache affinity follows declared compatibility", async () => {
  const captured: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    captured.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
    return sse({ id: "c", choices: [{ delta: {}, finish_reason: "stop" }] });
  };
  const model: Model<"openai-completions"> = {
    id: "m", name: "M", api: "openai-completions", provider: "proxy", baseUrl: "https://proxy.example/v1", reasoning: false,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 5_000, maxTokens: 2_000,
    compat: { maxTokensField: "max_tokens", sendSessionAffinityHeaders: true, sessionAffinityFormat: "openai-nosession", supportsLongCacheRetention: true },
  };
  await streamSimpleCompletions(model, { messages: [{ role: "user", content: "x".repeat(4_000), timestamp: 1 }] }, { apiKey: "key", fetch, sessionId: "session", cacheRetention: "long", maxRetries: 0 }).result();
  assert.equal(captured[0]!.body.max_tokens, 1);
  assert.equal(captured[0]!.body.prompt_cache_key, "session");
  assert.equal(captured[0]!.body.prompt_cache_retention, "24h");
  assert.equal(captured[0]!.headers.get("session_id"), null);
  assert.equal(captured[0]!.headers.get("x-client-request-id"), "session");
  assert.equal(captured[0]!.headers.get("x-session-affinity"), "session");
});

test("declared reasoningFormat metadata reaches compatibility transports", async () => {
  let payload: Record<string, unknown> | undefined;
  const model: Model<"openai-completions"> = {
    id: "m", name: "M", api: "openai-completions", provider: "proxy", baseUrl: "https://proxy.example/v1", reasoning: true,
    thinkingLevelMap: { high: "high" }, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 5_000, maxTokens: 2_000,
    compat: { reasoningFormat: "qwen" },
  };
  await streamSimpleCompletions(model, context, {
    apiKey: "key",
    reasoning: "high",
    maxRetries: 0,
    fetch: async (_input, init) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sse({ id: "c", choices: [{ delta: {}, finish_reason: "stop" }] });
    },
  }).result();
  assert.equal(payload?.enable_thinking, true);
  assert.equal(payload?.reasoning_effort, undefined);
});
