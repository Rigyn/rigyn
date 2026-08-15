import assert from "node:assert/strict";
import test from "node:test";

import {
  CredentialBroker,
  EnvironmentCredentialSource,
  ExplicitCredentialSource,
} from "../../src/auth/index.js";
import { BUILTIN_PROVIDER_CONFIGS } from "../../src/cli/runtime.js";
import { BUILTIN_PROVIDER_DESCRIPTORS } from "../../src/providers/builtins.js";
import { configuredModelsWithMaintainedCatalog } from "../../src/providers/maintained-model-catalog.js";
import { createProviderAdapter } from "../../src/service/provider-factory.js";
import { collect, request } from "./helpers.js";

test("Kimi Code has one isolated membership-key identity and current catalog", async () => {
  const descriptor = BUILTIN_PROVIDER_DESCRIPTORS.find((entry) => entry.id === "kimi-code");
  assert.deepEqual(descriptor, {
    id: "kimi-code",
    name: "Kimi Code",
    apis: ["openai-chat-completions"],
    environment: ["KIMI_CODE_API_KEY"],
    baseUrl: "https://api.kimi.com/coding/v1",
    oauth: true,
  });

  const source = new EnvironmentCredentialSource({
    environment: {
      KIMI_CODE_API_KEY: "membership-key",
      MOONSHOT_API_KEY: "unrelated-platform-key",
      OPENCODE_API_KEY: "unrelated-zen-key",
    },
  });
  assert.deepEqual(await source.resolve({ provider: "kimi-code" }), {
    kind: "api_key",
    provider: "kimi-code",
    apiKey: "membership-key",
  });

  const models = configuredModelsWithMaintainedCatalog([])
    .filter((model) => model.provider === "kimi-code");
  assert.deepEqual(models.map((model) => model.id), [
    "k3",
    "k3-256k",
    "kimi-for-coding",
    "kimi-for-coding-highspeed",
  ]);
  assert.ok(models.every((model) => model.tools === true));
});

test("Kimi Code dispatches through its coding endpoint without borrowed client identity", async () => {
  const config = BUILTIN_PROVIDER_CONFIGS["kimi-code"];
  assert.deepEqual(config, {
    kind: "openai-compatible",
    id: "kimi-code",
    baseUrl: "https://api.kimi.com/coding/v1",
    credentialProvider: "kimi-code",
    profile: "kimi-coding",
  });
  const broker = new CredentialBroker([new ExplicitCredentialSource(new Map([[
    "kimi-code",
    { kind: "api_key", provider: "kimi-code", apiKey: "membership-key" },
  ]]))]);
  let observed: Request | undefined;
  let body: Record<string, unknown> | undefined;
  const adapter = createProviderAdapter(config!, broker, {
    fetch: async (input, init) => {
      observed = input instanceof Request && init === undefined ? input : new Request(input, init);
      body = await observed.json() as Record<string, unknown>;
      return new Response(
        'data: {"id":"kimi-response","model":"k3","choices":[{"index":0,"delta":{"reasoning_content":"checked","content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const input = request("kimi-code");
  input.model = "k3";
  input.maxOutputTokens = 2_048;
  input.reasoningEffort = "high";
  input.sessionId = "session-7";
  input.modelSettings = {
    compatibility: {
      supportsReasoningEffort: true,
      requiresReasoningContentOnAssistantMessages: true,
    },
  };
  input.tools = [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }];

  const events = await collect(adapter.stream(input, new AbortController().signal));

  assert.equal(events.at(-1)?.type, "response_end");
  assert.equal(observed?.url, "https://api.kimi.com/coding/v1/chat/completions");
  assert.equal(observed?.headers.get("authorization"), "Bearer membership-key");
  for (const header of ["x-msh-platform", "chatgpt-account-id", "copilot-integration-id", "anthropic-version"]) {
    assert.equal(observed?.headers.has(header), false, header);
  }
  assert.equal(body?.model, "k3");
  assert.equal(body?.max_completion_tokens, 2_048);
  assert.equal(body?.reasoning_effort, "high");
  assert.equal(body?.prompt_cache_key, "session-7");
  assert.equal(Array.isArray(body?.tools), true);
  const terminal = events.at(-1);
  assert.equal(
    terminal?.type === "response_end" && terminal.state.kind === "chat_completions"
      ? (terminal.state.assistantMessage as { reasoning_content?: unknown }).reasoning_content
      : undefined,
    "checked",
  );
});
