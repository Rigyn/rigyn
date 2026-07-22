import assert from "node:assert/strict";
import test from "node:test";
import { convertMessages as convertGoogleMessages } from "../src/api/google-shared.js";
import { convertMessages as convertCompletionMessages, stream as streamCompletions } from "../src/api/openai-completions.js";
import { buildResponsesBody } from "../src/api/openai-responses-shared.js";
import { transformMessages } from "../src/api/transform-messages.js";
import { InMemoryCredentialStore } from "../src/auth/credential-store.js";
import { lazyOAuth } from "../src/auth/helpers.js";
import { ModelsError, resolveProviderAuth } from "../src/auth/resolve.js";
import type { OAuthAuth, OAuthCredential } from "../src/auth/types.js";
import { isRetryableAssistantError } from "../src/utils/retry.js";
import type { AssistantMessage, Context, Model, Usage } from "../src/types.js";

const zeroUsage = (): Usage => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const completionModel: Model<"openai-completions"> = {
  id: "completion-conformance", name: "Completion Conformance", api: "openai-completions", provider: "openai",
  baseUrl: "https://api.openai.com/v1", reasoning: true, input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 1_000,
};

const responsesModel: Model<"openai-responses"> = {
  id: "responses-conformance", name: "Responses Conformance", api: "openai-responses", provider: "openai",
  baseUrl: "https://api.openai.com/v1", reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 1_000,
};

const userContext: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const sse = (...events: Array<Record<string, unknown>>): Response => new Response(
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

test("lower-layer semantic conformance matrix", async (t) => {
  await t.test("cross-provider handoff removes private reasoning state and keeps tool results paired", () => {
    const source: AssistantMessage = {
      role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "source-model",
      content: [
        { type: "thinking", thinking: "portable plan", thinkingSignature: "private-signature" },
        { type: "thinking", thinking: "hidden", thinkingSignature: "redacted", redacted: true },
        { type: "text", text: "answer", textSignature: "private-text-signature" },
        { type: "toolCall", id: "call.one", name: "read", arguments: { path: "README.md" }, thoughtSignature: "private-tool-signature" },
        { type: "toolCall", id: "call.two", name: "write", arguments: { path: "notes.md" } },
      ],
      usage: zeroUsage(), stopReason: "toolUse", timestamp: 1,
    };
    const projected = transformMessages([
      source,
      { role: "toolResult", toolCallId: "call.one", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false, timestamp: 2 },
    ], completionModel, (id) => id.replaceAll(".", "_"));

    const assistant = projected[0];
    assert.equal(assistant?.role, "assistant");
    if (assistant?.role !== "assistant") return;
    assert.deepEqual(assistant.content, [
      { type: "text", text: "portable plan" },
      { type: "text", text: "answer" },
      { type: "toolCall", id: "call_one", name: "read", arguments: { path: "README.md" } },
      { type: "toolCall", id: "call_two", name: "write", arguments: { path: "notes.md" } },
    ]);
    assert.equal(projected[1]?.role === "toolResult" ? projected[1].toolCallId : undefined, "call_one");
    assert.deepEqual(projected[2], {
      role: "toolResult", toolCallId: "call_two", toolName: "write",
      content: [{ type: "text", text: "No result provided" }], isError: true,
      timestamp: projected[2]?.timestamp,
    });
  });

  await t.test("tool-result images stay after an adjacent tool-result batch and follow model capabilities", () => {
    const assistant: AssistantMessage = {
      role: "assistant", api: completionModel.api, provider: completionModel.provider, model: completionModel.id,
      content: [
        { type: "toolCall", id: "first", name: "camera", arguments: {} },
        { type: "toolCall", id: "second", name: "chart", arguments: {} },
      ],
      usage: zeroUsage(), stopReason: "toolUse", timestamp: 1,
    };
    const context: Context = { messages: [
      assistant,
      { role: "toolResult", toolCallId: "first", toolName: "camera", content: [{ type: "text", text: "photo" }, { type: "image", mimeType: "image/png", data: "AAAA" }], isError: false, timestamp: 2 },
      { role: "toolResult", toolCallId: "second", toolName: "chart", content: [{ type: "text", text: "plot" }, { type: "image", mimeType: "image/jpeg", data: "BBBB" }], isError: false, timestamp: 3 },
    ] };
    const converted = convertCompletionMessages(completionModel, context);
    assert.deepEqual(converted.map((message) => message.role), ["assistant", "tool", "tool", "user"]);
    const imageTurn = converted[3]?.content as Array<Record<string, unknown>>;
    assert.deepEqual(imageTurn.filter((part) => part.type === "image_url").map((part) => (part.image_url as Record<string, unknown>).url), [
      "data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB",
    ]);

    const textOnly = convertCompletionMessages({ ...completionModel, input: ["text"] }, context);
    assert.deepEqual(textOnly.map((message) => message.role), ["assistant", "tool", "tool"]);
    assert.match(String(textOnly[1]?.content), /tool image omitted/u);

    const googleModel: Model<"google-generative-ai"> = {
      ...responsesModel, id: "gemini-3-conformance", api: "google-generative-ai", provider: "google", input: ["text", "image"],
    };
    const google = convertGoogleMessages(googleModel, { messages: context.messages.slice(1) });
    const functionResponse = ((google[0]?.parts as Array<Record<string, unknown>>)[0]?.functionResponse as Record<string, unknown>);
    assert.equal(Array.isArray(functionResponse.parts), true);
  });

  await t.test("reasoning disable and cache disable omit provider controls", () => {
    const body = buildResponsesBody(responsesModel, userContext, {
      reasoningEffort: "none", reasoningSummary: "detailed", sessionId: "session", cacheRetention: "none",
    });
    assert.equal(body.reasoning, undefined);
    assert.equal(body.include, undefined);
    assert.equal(body.prompt_cache_key, undefined);
    assert.equal(body.prompt_cache_retention, undefined);
  });

  await t.test("cache keys preserve complete Unicode characters and usage components remain consistent", async () => {
    const sessionId = `${"a".repeat(63)}😀z`;
    let payload: Record<string, unknown> | undefined;
    const result = await streamCompletions(completionModel, userContext, {
      apiKey: "test", sessionId, maxRetries: 0,
      fetch: async (_input, init) => {
        payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sse({
          id: "completion", model: completionModel.id,
          usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } },
          choices: [{ delta: {}, finish_reason: "stop" }],
        });
      },
    }).result();
    assert.equal(payload?.prompt_cache_key, `${"a".repeat(63)}😀`);
    assert.deepEqual(result.usage, {
      input: 7, output: 4, cacheRead: 3, cacheWrite: 0, reasoning: 2, totalTokens: 14,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });

  await t.test("concurrent OAuth resolution refreshes once and a failed refresh can be retried", async () => {
    const store = new InMemoryCredentialStore();
    const expired: OAuthCredential = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0 };
    await store.modify("subscription", async () => expired);
    let refreshes = 0;
    let fail = false;
    const auth: OAuthAuth = {
      name: "Subscription",
      async login() { return expired; },
      async refresh() {
        refreshes += 1;
        if (fail) throw new Error("temporary refresh failure");
        await Promise.resolve();
        return { type: "oauth", access: "new-access", refresh: "new-refresh", expires: Date.now() + 60_000 };
      },
      async toAuth(credential) { return { apiKey: credential.access }; },
    };
    const provider = { id: "subscription", auth: { oauth: auth } };
    const context = { async env() { return undefined; }, async fileExists() { return false; } };
    const resolved = await Promise.all(Array.from({ length: 3 }, () => resolveProviderAuth(provider, store, context)));
    assert.equal(refreshes, 1);
    assert.deepEqual(resolved.map((entry) => entry?.auth.apiKey), ["new-access", "new-access", "new-access"]);
    assert.deepEqual(await store.read("subscription"), { type: "oauth", access: "new-access", refresh: "new-refresh", expires: (await store.read("subscription") as OAuthCredential).expires });

    await store.modify("subscription", async () => expired);
    fail = true;
    await assert.rejects(resolveProviderAuth(provider, store, context), (error: unknown) => error instanceof ModelsError && error.code === "oauth");
    fail = false;
    assert.equal((await resolveProviderAuth(provider, store, context))?.auth.apiKey, "new-access");
  });

  await t.test("lazy OAuth loading is shared across concurrent callers", async () => {
    let loads = 0;
    const implementation: OAuthAuth = {
      name: "Loaded subscription",
      async login() { return { type: "oauth", access: "access", refresh: "refresh", expires: 1 }; },
      async refresh(credential) { return credential; },
      async toAuth(credential) { return { apiKey: credential.access }; },
    };
    const auth = lazyOAuth({ name: "Lazy subscription", async load() { loads += 1; await Promise.resolve(); return implementation; } });
    const credential = await implementation.login({ prompt: async () => "", notify() {} });
    const results = await Promise.all([auth.toAuth(credential), auth.toAuth(credential), auth.toAuth(credential)]);
    assert.equal(loads, 1);
    assert.deepEqual(results.map((result) => result.apiKey), ["access", "access", "access"]);
  });

  await t.test("permanent limits override retry hints", () => {
    const message = (errorMessage: string): AssistantMessage => ({
      role: "assistant", api: "test", provider: "test", model: "test", content: [], usage: zeroUsage(),
      stopReason: "error", errorMessage, timestamp: 0,
    });
    assert.equal(isRetryableAssistantError(message("service unavailable; please retry your request")), true);
    assert.equal(isRetryableAssistantError(message("monthly usage limit reached; please retry your request")), false);
    assert.equal(isRetryableAssistantError({ ...message("service unavailable"), stopReason: "aborted" }), false);
  });
});
