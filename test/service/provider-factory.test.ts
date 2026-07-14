import assert from "node:assert/strict";
import test from "node:test";
import {
  CredentialBroker,
  ExplicitCredentialSource,
  type CredentialSource,
} from "../../src/auth/index.js";
import {
  GeminiAdapter,
  GeminiInteractionsAdapter,
  MistralAdapter,
  MistralConversationsAdapter,
} from "../../src/providers/index.js";
import { createProviderAdapter } from "../../src/service/provider-factory.js";
import { collect, request } from "../providers/helpers.js";

function broker(entries: Array<[string, "api_key" | "bearer", string]> = []): CredentialBroker {
  return new CredentialBroker([
    new ExplicitCredentialSource(new Map(entries.map(([provider, kind, secret]) => [
      provider,
      kind === "api_key"
        ? { kind, provider, apiKey: secret }
        : { kind, provider, accessToken: secret },
    ]))),
  ]);
}

function blockingBroker(): { broker: CredentialBroker; started: Promise<void> } {
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const source: CredentialSource = {
    name: "blocking",
    async resolve({ signal }) {
      markStarted?.();
      signal?.throwIfAborted();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return undefined;
    },
  };
  return { broker: new CredentialBroker([source]), started };
}

test("Gemini uses stable Interactions by default with an explicit GenerateContent escape hatch", () => {
  assert.ok(createProviderAdapter({ kind: "gemini" }, broker([["gemini", "api_key", "test-key"]])) instanceof GeminiInteractionsAdapter);
  assert.ok(createProviderAdapter({ kind: "gemini", protocol: "generate-content" }, broker([["gemini", "api_key", "test-key"]])) instanceof GeminiAdapter);
});

test("cloud-backed provider factories preserve their configured protocols", () => {
  assert.equal(createProviderAdapter({ kind: "azure-openai", endpoint: "https://example.openai.azure.com" }, broker([["azure-openai", "api_key", "test-key"]])).id, "azure-openai");
  assert.equal(createProviderAdapter({ kind: "vertex", project: "project-id" }, broker([["vertex", "bearer", "test-token"]])).id, "vertex");
  assert.equal(createProviderAdapter({ kind: "bedrock", region: "us-east-1" }, broker([["bedrock", "bearer", "test-token"]])).id, "bedrock");
  assert.ok(createProviderAdapter({ kind: "mistral" }, broker([["mistral", "api_key", "test-key"]])) instanceof MistralAdapter);
  assert.ok(createProviderAdapter({
    kind: "mistral",
    protocol: "conversations",
    store: true,
    promptCache: "off",
    reasoningMode: "effort",
  }, broker([["mistral", "api_key", "test-key"]])) instanceof MistralConversationsAdapter);
  assert.throws(() => createProviderAdapter({
    kind: "mistral",
    protocol: "conversations",
    promptCache: "session",
  }, broker([["mistral", "api_key", "test-key"]])), /does not support prompt_cache_key/u);
});

test("provider factories route discovery through an injected network transport", async () => {
  let url = "";
  const adapter = createProviderAdapter({
    kind: "openai-compatible",
    id: "proxy-fixture",
    baseUrl: "https://models.example.test/v1",
  }, broker([["proxy-fixture", "bearer", "test-token"]]), {
    fetch: (async (input: string | URL | Request) => {
      url = input instanceof Request ? input.url : String(input);
      return new Response(JSON.stringify({ data: [{ id: "model-v1" }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  assert.deepEqual((await adapter.listModels(new AbortController().signal)).map((model) => model.id), ["model-v1"]);
  assert.equal(url, "https://models.example.test/v1/models");
});

test("provider factory credential resolution stops with stream and model-list cancellation", { timeout: 2_000 }, async () => {
  {
    const blocked = blockingBroker();
    const adapter = createProviderAdapter({
      kind: "openai-compatible",
      id: "proxy-fixture",
      baseUrl: "https://models.example.test/v1",
    }, blocked.broker);
    const controller = new AbortController();
    const events = collect(adapter.stream(request("proxy-fixture"), controller.signal));
    await blocked.started;
    controller.abort();
    assert.deepEqual(await events, [{
      type: "error",
      error: {
        category: "cancelled",
        message: "Request cancelled",
        retryable: false,
        partial: false,
      },
    }]);
  }

  {
    const blocked = blockingBroker();
    const adapter = createProviderAdapter({
      kind: "openai-compatible",
      id: "proxy-fixture",
      baseUrl: "https://models.example.test/v1",
    }, blocked.broker);
    const controller = new AbortController();
    const models = adapter.listModels(controller.signal);
    await blocked.started;
    controller.abort();
    await assert.rejects(models, { name: "AbortError" });
  }
});
