import assert from "node:assert/strict";
import test from "node:test";

import { CredentialBroker, ExplicitCredentialSource } from "../../src/auth/index.js";
import { BUILTIN_PROVIDER_CONFIGS } from "../../src/cli/runtime.js";
import { configuredModelsWithMaintainedCatalog } from "../../src/providers/maintained-model-catalog.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { createProviderAdapter } from "../../src/service/provider-factory.js";
import { collect, request } from "../providers/helpers.js";

const EXPECTED_RUNTIME_IDS = [
  "anthropic",
  "deepseek",
  "gemini",
  "github-copilot",
  "kimi-code",
  "ollama",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "xai",
] as const;

function broker(provider: string, apiKey = "offline-key"): CredentialBroker {
  return new CredentialBroker([new ExplicitCredentialSource(new Map([
    [provider, { kind: "api_key" as const, provider, apiKey }],
  ]))]);
}

test("the runtime publishes only the twelve retained provider configurations", () => {
  assert.deepEqual(Object.keys(BUILTIN_PROVIDER_CONFIGS).sort(), [...EXPECTED_RUNTIME_IDS].sort());
  assert.deepEqual(BUILTIN_PROVIDER_CONFIGS.deepseek, {
    kind: "openai-compatible",
    id: "deepseek",
    baseUrl: "https://api.deepseek.com",
    credentialProvider: "deepseek",
  });
  assert.deepEqual(BUILTIN_PROVIDER_CONFIGS.gemini, {
    kind: "gemini",
    protocol: "generate-content",
  });
  assert.deepEqual(BUILTIN_PROVIDER_CONFIGS["kimi-code"], {
    kind: "openai-compatible",
    id: "kimi-code",
    baseUrl: "https://api.kimi.com/coding/v1",
    credentialProvider: "kimi-code",
    profile: "kimi-coding",
  });
  assert.equal(BUILTIN_PROVIDER_CONFIGS.ollama?.kind, "ollama");
});

test("xAI routes every maintained model through Responses with visible reasoning text", () => {
  const config = BUILTIN_PROVIDER_CONFIGS.xai;
  assert.equal(config?.kind, "routed");
  if (config?.kind !== "routed") return;
  assert.deepEqual(Object.keys(config.adapters), ["responses"]);
  assert.equal(config.adapters.responses?.kind, "openai");
  assert.equal(config.adapters.responses?.reasoningTextDisplay, true);
  assert.deepEqual(
    config.routes.map((route) => route.model).sort(),
    configuredModelsWithMaintainedCatalog([])
      .filter((model) => model.provider === "xai")
      .map((model) => model.id)
      .sort(),
  );
  assert.ok(config.routes.every((route) => route.protocolFamily === "openai-responses"));
});

test("OpenCode Zen keeps explicit routes for each supported protocol", () => {
  const config = BUILTIN_PROVIDER_CONFIGS.opencode;
  assert.equal(config?.kind, "routed");
  if (config?.kind !== "routed") return;
  assert.equal(config.catalogAdapter, "chat");
  assert.deepEqual(Object.keys(config.adapters).sort(), ["chat", "chat-kimi", "gemini", "messages", "responses"]);
  assert.deepEqual(
    [...new Set(config.routes.map((route) => route.protocolFamily))].sort(),
    ["anthropic-messages", "gemini-generate-content", "openai-chat-completions", "openai-responses"],
  );
  assert.equal(config.routes.find((route) => route.model === "nemotron-3.5-lightning-free")?.adapter, "chat");
  assert.ok(config.routes.every((route) => route.modelInfo?.provider === "opencode"));
});

test("OpenCode Go keeps a distinct credential and exact maintained protocol routes", () => {
  const config = BUILTIN_PROVIDER_CONFIGS["opencode-go"];
  assert.equal(config?.kind, "routed");
  if (config?.kind !== "routed") return;
  assert.equal(config.id, "opencode-go");
  assert.equal(config.credentialProvider, "opencode-go");
  assert.equal(config.catalogAdapter, "chat");
  assert.deepEqual(Object.keys(config.adapters).sort(), ["chat", "messages", "responses"]);
  assert.deepEqual(
    [...new Set(config.routes.map((route) => route.protocolFamily))].sort(),
    ["anthropic-messages", "openai-chat-completions", "openai-responses"],
  );
  assert.equal(config.routes.length, 18);
  assert.ok(config.routes.every((route) => route.modelInfo?.provider === "opencode-go"));
  assert.equal(config.routes.some((route) => route.model === "minimax-m2.5"), false);
  assert.equal(config.routes.find((route) => route.model === "deepseek-v4-flash")?.adapter, "chat");
  assert.equal(config.routes.find((route) => route.model === "minimax-m3")?.adapter, "messages");
  assert.equal(config.routes.find((route) => route.model === "gpt-5.6-luna")?.adapter, "responses");
  assert.equal(config.routes.find((route) => route.model === "grok-4.5")?.adapter, "chat");
  assert.deepEqual(config.routes.filter((route) => route.adapter === "responses").map((route) => route.model), [
    "gpt-5.6-luna",
  ]);
  assert.deepEqual(config.routes.filter((route) => route.adapter === "messages").map((route) => route.model), [
    "minimax-m2.7", "minimax-m3", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus", "qwen3.8-max",
  ]);
  assert.deepEqual(config.routes.filter((route) => route.adapter === "chat").map((route) => route.model), [
    "deepseek-v4-flash", "deepseek-v4-pro", "glm-5.1", "glm-5.2", "grok-4.5", "hy3", "kimi-k2.6",
    "kimi-k2.7-code", "kimi-k3", "mimo-v2.5", "mimo-v2.5-pro",
  ]);
  const chat = config.adapters.chat;
  const messages = config.adapters.messages;
  const responses = config.adapters.responses;
  assert.equal(chat?.kind, "openai-compatible");
  assert.equal(messages?.kind, "anthropic");
  assert.equal(responses?.kind, "openai");
  if (chat?.kind === "openai-compatible") assert.equal(chat.baseUrl, "https://opencode.ai/zen/go/v1");
  if (messages?.kind === "anthropic") {
    assert.equal(messages.baseUrl, "https://opencode.ai/zen/go");
    assert.equal(messages.defaultMaxOutputTokens, 65_536);
    assert.deepEqual(messages.thinking, {
      budgets: { high: 16_000, max: 31_999 },
      models: {
        "minimax-m3": {
          mode: "adaptive",
          off: "disabled",
          supportsAdaptiveEffort: false,
        },
      },
    });
  }
  if (responses?.kind === "openai") assert.equal(responses.baseUrl, "https://opencode.ai/zen/go/v1");
});

test("OpenCode Go never resolves a separately stored OpenCode Zen credential", async () => {
  let fetches = 0;
  const adapter = createProviderAdapter(BUILTIN_PROVIDER_CONFIGS["opencode-go"]!, broker("opencode", "zen-secret"), {
    fetch: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ data: [] }));
    },
  });
  await assert.rejects(adapter.listModels(new AbortController().signal));
  assert.equal(fetches, 0);
  await adapter.dispose?.();
});

test("OpenCode Go Kimi routes normalize browser extension enum schemas at the wire boundary", async () => {
  const observed: Request[] = [];
  const adapter = createProviderAdapter(BUILTIN_PROVIDER_CONFIGS["opencode-go"]!, broker("opencode-go"), {
    fetch: async (input, init) => {
      observed.push(input instanceof Request && init === undefined ? input : new Request(input, init));
      return new Response('data: {"id":"chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const registry = new ProviderRegistry([adapter], {
    configuredModels: configuredModelsWithMaintainedCatalog([]).filter((model) => model.provider === "opencode-go"),
  });
  const runtime = registry.runtimeAdapter("opencode-go");
  const browserTools = [
    {
      name: "rigyn_browser_inspect",
      description: "Inspect page",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { enum: ["interactive", "text", "links", "accessibility", "all"] },
          maxElements: { type: "integer", minimum: 1, maximum: 200 },
          maxText: { type: "integer", minimum: 256, maximum: 30_000 },
          targetId: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
    },
    {
      name: "rigyn_browser_act",
      description: "Act on page",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { enum: ["click", "fill", "type", "press", "select", "check", "uncheck"] },
          key: { enum: ["Enter", "Tab", "Escape", "Backspace", "Delete"] },
        },
      },
    },
    {
      name: "rigyn_browser_emulate",
      description: "Emulate device",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["preset"],
        properties: { preset: { enum: ["iphone-15", "pixel-8", "reset"] } },
      },
    },
    {
      name: "rigyn_browser_cookies",
      description: "Handle cookie dialog",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { mode: { enum: ["accept", "reject"] } },
      },
    },
    {
      name: "rigyn_browser_diagnostics",
      description: "Browser diagnostics",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { kind: { enum: ["all", "console", "exception", "network_failure", "http_error"] } },
      },
    },
  ];
  const send = async (model: "kimi-k3" | "glm-5.2") => {
    const input = request("opencode-go");
    input.model = model;
    input.tools = browserTools;
    await collect(runtime.stream(input, new AbortController().signal));
  };

  await send("kimi-k3");
  await send("glm-5.2");
  const wireSchemas = async (request: Request) => {
    const body = await request.clone().json() as {
      tools: Array<{ function: { name: string; parameters: { properties: Record<string, Record<string, unknown>> } } }>;
    };
    return new Map(body.tools.map((tool) => [tool.function.name, tool.function.parameters.properties]));
  };
  const kimi = await wireSchemas(observed[0]!);
  assert.equal(kimi.get("rigyn_browser_inspect")?.mode?.type, "string");
  assert.equal(kimi.get("rigyn_browser_act")?.action?.type, "string");
  assert.equal(kimi.get("rigyn_browser_act")?.key?.type, "string");
  assert.equal(kimi.get("rigyn_browser_emulate")?.preset?.type, "string");
  assert.equal(kimi.get("rigyn_browser_cookies")?.mode?.type, "string");
  assert.equal(kimi.get("rigyn_browser_diagnostics")?.kind?.type, "string");
  const glm = await wireSchemas(observed[1]!);
  assert.equal(glm.get("rigyn_browser_inspect")?.mode?.type, undefined);
  assert.equal(Object.hasOwn(browserTools[0]!.inputSchema.properties.mode ?? {}, "type"), false);
  await adapter.dispose?.();
});

test("OpenCode Go filters discovery and dispatches every maintained protocol with priced cache usage", async () => {
  const observed: Request[] = [];
  const adapter = createProviderAdapter(BUILTIN_PROVIDER_CONFIGS["opencode-go"]!, broker("opencode-go", "go-secret"), {
    fetch: async (input, init) => {
      const incoming = input instanceof Request && init === undefined ? input : new Request(input, init);
      observed.push(incoming);
      if (incoming.url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [
          { id: "deepseek-v4-flash" },
          { id: "gpt-5.6-luna" },
          { id: "minimax-m2.7" },
          { id: "minimax-m2.5" },
          { id: "hy3-preview" },
        ] }), { headers: { "content-type": "application/json" } });
      }
      if (incoming.url.endsWith("/chat/completions")) {
        return new Response([
          `data: ${JSON.stringify({
            id: "chat",
            choices: [{ index: 0, delta: { reasoning_content: "plan" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 3,
              prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 0 },
            },
          })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      }
      if (incoming.url.endsWith("/messages")) {
        return new Response([
          `data: ${JSON.stringify({ type: "message_start", message: { id: "message", model: "minimax-m2.7", usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 } } })}\n\n`,
          `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}\n\n`,
          `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(`data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "response",
          model: "gpt-5.6-luna",
          output: [],
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            total_tokens: 13,
            input_tokens_details: { cached_tokens: 4, cache_write_tokens: 0 },
          },
        },
      })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const registry = new ProviderRegistry([adapter], {
    configuredModels: configuredModelsWithMaintainedCatalog([]).filter((model) => model.provider === "opencode-go"),
  });
  const runtime = registry.runtimeAdapter("opencode-go");

  const discovered = await runtime.listModels(new AbortController().signal);
  assert.deepEqual(discovered.map((model) => model.id), ["deepseek-v4-flash", "gpt-5.6-luna", "minimax-m2.7"]);

  const results = new Map<string, Awaited<ReturnType<typeof collect>>>();
  for (const model of ["deepseek-v4-flash", "minimax-m2.7", "gpt-5.6-luna"]) {
    const input = request("opencode-go");
    input.model = model;
    if (model === "deepseek-v4-flash") {
      input.reasoningEffort = "max";
      input.maxOutputTokens = 384_000;
    }
    results.set(model, await collect(runtime.stream(input, new AbortController().signal)));
  }

  assert.deepEqual(observed.map((entry) => new URL(entry.url).pathname), [
    "/zen/go/v1/models",
    "/zen/go/v1/chat/completions",
    "/zen/go/v1/messages",
    "/zen/go/v1/responses",
  ]);
  assert.equal(observed[0]?.headers.get("authorization"), "Bearer go-secret");
  assert.equal(observed[1]?.headers.get("authorization"), "Bearer go-secret");
  assert.equal(observed[1]?.headers.get("x-api-key"), null);
  assert.equal(observed[2]?.headers.get("x-api-key"), "go-secret");
  assert.equal(observed[2]?.headers.get("authorization"), null);
  assert.equal(observed[3]?.headers.get("authorization"), "Bearer go-secret");

  const deepSeekBody = JSON.parse(await observed[1]!.clone().text()) as Record<string, unknown>;
  assert.equal(deepSeekBody.max_tokens, 384_000);
  assert.equal(deepSeekBody.reasoning_effort, "max");
  assert.equal(deepSeekBody.output_config, undefined);
  assert.equal(deepSeekBody.thinking, undefined);
  const deepSeekEnd = results.get("deepseek-v4-flash")?.findLast((event) => event.type === "response_end");
  assert.equal(deepSeekEnd?.type === "response_end" ? deepSeekEnd.state.routed?.provider : undefined, "opencode-go");
  assert.equal(deepSeekEnd?.type === "response_end" ? deepSeekEnd.state.kind : undefined, "chat_completions");
  const deepSeekAssistant = deepSeekEnd?.type === "response_end" && deepSeekEnd.state.kind === "chat_completions"
    ? deepSeekEnd.state.assistantMessage
    : undefined;
  assert.equal(
    typeof deepSeekAssistant === "object" && deepSeekAssistant !== null && !Array.isArray(deepSeekAssistant)
      ? deepSeekAssistant.reasoning
      : undefined,
    "plan",
  );

  assert.equal(deepSeekEnd?.type, "response_end");
  if (deepSeekEnd?.type === "response_end") {
    const replay = request("opencode-go");
    replay.model = "deepseek-v4-flash";
    replay.reasoningEffort = "max";
    replay.providerState = deepSeekEnd.state;
    replay.messages = [
      replay.messages[0]!,
      { id: "assistant", role: "assistant", content: [], createdAt: "2026-08-10T00:00:01.000Z" },
      { id: "continue", role: "user", content: [{ type: "text", text: "continue" }], createdAt: "2026-08-10T00:00:02.000Z" },
    ];
    await collect(runtime.stream(replay, new AbortController().signal));
    const replayBody = JSON.parse(await observed.at(-1)!.clone().text()) as {
      messages: Array<{ reasoning_content?: string }>;
    };
    assert.equal(replayBody.messages[1]?.reasoning_content, "plan");
  }

  const expected = new Map([
    ["deepseek-v4-flash", { inputTokens: 6, outputTokens: 3, cacheReadTokens: 4, total: 0.0000016912 }],
    ["minimax-m2.7", { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4, total: 0.00000684 }],
    ["gpt-5.6-luna", { inputTokens: 6, outputTokens: 3, cacheReadTokens: 4, total: 0.00000488 }],
  ]);
  for (const [model, expectation] of expected) {
    const usage = results.get(model)?.findLast((event) => event.type === "usage");
    assert.equal(usage?.type === "usage" ? usage.usage.inputTokens : undefined, expectation.inputTokens, model);
    assert.equal(usage?.type === "usage" ? usage.usage.outputTokens : undefined, expectation.outputTokens, model);
    assert.equal(usage?.type === "usage" ? usage.usage.cacheReadTokens : undefined, expectation.cacheReadTokens, model);
    const total = usage?.type === "usage" ? usage.usage.cost?.total : undefined;
    assert.ok(total !== undefined && Math.abs(total - expectation.total) <= 1e-15, `${model}: ${total}`);
  }
  assert.equal(new URL(observed.at(-1)!.url).pathname, "/zen/go/v1/chat/completions");
  await adapter.dispose?.();
});

test("OpenCode Go Messages routes mirror the current fixed, adaptive, and budgeted controls", async () => {
  const observed: Array<{ model: string; body: Record<string, unknown> }> = [];
  const adapter = createProviderAdapter(BUILTIN_PROVIDER_CONFIGS["opencode-go"]!, broker("opencode-go"), {
    fetch: async (input, init) => {
      const incoming = input instanceof Request && init === undefined ? input : new Request(input, init);
      const body = JSON.parse(await incoming.clone().text()) as { model: string } & Record<string, unknown>;
      observed.push({ model: body.model, body });
      return new Response([
        `data: ${JSON.stringify({ type: "message_start", message: { id: "message", model: body.model, usage: { input_tokens: 1 } } })}\n\n`,
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
        `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const registry = new ProviderRegistry([adapter], {
    configuredModels: configuredModelsWithMaintainedCatalog([]).filter((model) => model.provider === "opencode-go"),
  });
  const runtime = registry.runtimeAdapter("opencode-go");

  const send = async (model: string, reasoningEffort: "off" | "low" | "high" | "max") => {
    const input = request("opencode-go");
    input.model = model;
    input.reasoningEffort = reasoningEffort;
    await collect(runtime.stream(input, new AbortController().signal));
  };

  await send("minimax-m2.7", "off");
  await send("minimax-m3", "off");
  await send("minimax-m3", "high");
  for (const model of ["qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus", "qwen3.8-max"]) {
    await send(model, "high");
    await send(model, "max");
  }

  assert.equal(observed[0]?.body.output_config, undefined);
  assert.equal(observed[0]?.body.thinking, undefined);
  assert.deepEqual(observed[1]?.body.thinking, { type: "disabled" });
  assert.deepEqual(observed[2]?.body.thinking, { type: "adaptive" });
  assert.equal(observed[2]?.body.output_config, undefined);
  for (const [index, entry] of observed.slice(3).entries()) {
    assert.deepEqual(entry.body.thinking, {
      type: "enabled",
      budget_tokens: index % 2 === 0 ? 16_000 : 31_999,
    }, entry.model);
  }
  await adapter.dispose?.();
});

test("DeepSeek dispatches its retained Chat Completions endpoint offline", async () => {
  let observed: Request | undefined;
  let observedBody: Record<string, unknown> | undefined;
  const adapter = createProviderAdapter(BUILTIN_PROVIDER_CONFIGS.deepseek!, broker("deepseek"), {
    fetch: async (input, init) => {
      observed = input instanceof Request && init === undefined ? input : new Request(input, init);
      observedBody = await observed.json() as Record<string, unknown>;
      return new Response('data: {"id":"offline","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const input = request("deepseek");
  input.model = "deepseek-chat";
  input.maxOutputTokens = 2_048;
  const events = await collect(adapter.stream(input, new AbortController().signal));
  assert.equal(events.at(-1)?.type, "response_end");
  assert.equal(observed?.url, "https://api.deepseek.com/chat/completions");
  assert.equal(observed?.headers.get("authorization"), "Bearer offline-key");
  assert.equal(observedBody?.max_tokens, 2_048);
  assert.equal(observedBody?.max_completion_tokens, undefined);
});
