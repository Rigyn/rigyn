import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { buildGoogleVertexClientConfig } from "../src/api/google-vertex.js";
import { InMemoryCredentialStore } from "../src/auth/credential-store.js";
import { envApiKeyAuth } from "../src/auth/helpers.js";
import { calculateCost, clampThinkingLevel, createModels, createProvider } from "../src/models.js";
import { BUILTIN_MODEL_CATALOG } from "../src/models.generated.js";
import { builtinModels, builtinProviders, getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "../src/providers/all.js";
import { fauxAssistantMessage, fauxProvider, fauxText } from "../src/providers/faux.js";
import { contentText, projectCustomContextMessage } from "../src/utils/text.js";
import { uuidv7 } from "../src/utils/uuid.js";
import type { Model, ToolResultMessage, Usage } from "../src/types.js";

test("the standalone catalog is a lossless projection of maintained metadata", () => {
  assert.equal(BUILTIN_MODEL_CATALOG.length, 11);
  const catalogProviders = [...new Set(BUILTIN_MODEL_CATALOG.map((model) => model.provider))].sort();
  assert.deepEqual(catalogProviders, ["anthropic", "openai"]);
  assert.equal(getBuiltinProviders().length, 37);
  const providers = builtinProviders();
  assert.deepEqual(providers.map((provider) => provider.id).sort(), getBuiltinProviders().sort());
  for (const provider of providers) {
    const expected = getBuiltinModels(provider.id);
    assert.deepEqual(provider.getModels(), expected);
    for (const model of expected) assert.equal(getBuiltinModel(provider.id, model.id), model);
  }
  assert.deepEqual(getBuiltinModels("github-copilot"), []);
  assert.equal(getBuiltinModel("openai", "missing"), undefined);
});

test("protocol mappings are explicit and provider-correct", () => {
  assert.equal(getBuiltinModels("openai").length, 7);
  assert.equal(getBuiltinModels("anthropic").length, 4);
  assert.ok(getBuiltinModels("openai").every((model) => model.api === "openai-responses"));
  assert.ok(getBuiltinModels("anthropic").every((model) => model.api === "anthropic-messages"));
  assert.deepEqual(getBuiltinModels("openai").find((model) => model.id === "gpt-5.6-sol")?.thinkingLevelMap, {
    off: "off",
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });
});

test("providers without strict static rows retain their transport implementations", async () => {
  const provider = builtinProviders().find((entry) => entry.id === "ant-ling");
  assert.ok(provider);
  const direct: Model<"openai-completions"> = {
    id: "live-model", name: "Live model", api: "openai-completions", provider: "ant-ling",
    baseUrl: "https://api.ant-ling.com/v1", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8_192, maxTokens: 1_024,
  };
  const message = await provider.stream(direct, {
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
  }, {
    apiKey: "test",
    maxRetries: 0,
    fetch: async () => new Response('data: {"id":"response","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n', {
      headers: { "content-type": "text/event-stream" },
    }),
  }).result();
  assert.equal(message.stopReason, "stop");
  assert.equal(contentText(message.content), "ok");
});

test("model collections allow deterministic provider replacement and removal", () => {
  const models = createModels();
  const original = builtinProviders().find((provider) => provider.id === "openai");
  assert.ok(original);
  models.setProvider(original);
  assert.equal(models.getProvider("openai"), original);
  const replacement = createProvider({ id: "openai", name: "Replacement", auth: {}, models: [], api: {} });
  models.setProvider(replacement);
  assert.equal(models.getProvider("openai"), replacement);
  models.deleteProvider("openai");
  assert.equal(models.getProvider("openai"), undefined);
});

test("environment auth respects stored credential precedence", async () => {
  const auth = envApiKeyAuth("Example key", ["FIRST_KEY", "SECOND_KEY"]);
  const ctx = { async env(name: string) { return name === "FIRST_KEY" ? "ambient" : undefined; }, async fileExists() { return false; } };
  assert.deepEqual(await auth.resolve({ ctx }), { auth: { apiKey: "ambient" }, source: "FIRST_KEY" });
  assert.deepEqual(await auth.resolve({ ctx, credential: { type: "api_key", key: "stored", env: { REGION: "one" } } }), { auth: { apiKey: "stored" }, source: "Stored API key", env: { REGION: "one" } });
});

test("built-in models resolve ambient auth without leaking credentials into catalogs", async () => {
  const models = builtinModels({
    credentials: new InMemoryCredentialStore(),
    authContext: { async env(name) { return name === "OPENAI_API_KEY" ? "secret" : undefined; }, async fileExists() { return false; } },
  });
  const auth = await models.getAuth("openai");
  assert.equal(auth?.auth.apiKey, "secret");
  assert.ok(BUILTIN_MODEL_CATALOG.every((model) => !JSON.stringify(model).includes("secret")));
});

test("faux providers stream typed text and usage", async () => {
  const handle = fauxProvider({ tokensPerSecond: 0, tokenSize: { min: 1, max: 1 } });
  handle.setResponses([fauxAssistantMessage([fauxText("hello")])]);
  const result = await handle.provider.stream(handle.getModel(), { messages: [{ role: "user", content: "hi", timestamp: 0 }] }).result();
  assert.equal(result.stopReason, "stop");
  assert.equal(contentText(result.content), "hello");
  assert.equal(handle.state.callCount, 1);
});

test("tool results can report tool-owned usage independently", () => {
  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "remote_search",
    content: [{ type: "text", text: "done" }],
    usage: {
      input: 4,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 7,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    isError: false,
    timestamp: 1,
  };
  assert.equal(message.usage?.totalTokens, 7);
});

test("custom messages project once at the provider boundary", () => {
  const projected = projectCustomContextMessage({ role: "custom", content: [{ type: "text", text: "state" }], timestamp: 10 });
  assert.deepEqual(projected, { role: "user", content: [{ type: "text", text: "state" }], timestamp: 10 });
});

test("thinking clamps upward before falling back and tiered costs are exact", () => {
  const model: Model = { id: "m", name: "M", api: "test", provider: "test", baseUrl: "http://localhost", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: "xhigh" }, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 3, tiers: [{ inputTokensAbove: 100, input: 2, output: 4, cacheRead: 1, cacheWrite: 6 }] }, contextWindow: 1000, maxTokens: 100 };
  assert.equal(clampThinkingLevel(model, "low"), "medium");
  const usage: Usage = { input: 101, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 111, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  calculateCost(model, usage);
  assert.equal(usage.cost.input, 202 / 1_000_000);
  assert.equal(usage.cost.output, 40 / 1_000_000);
});

test("UUIDv7 output remains valid and monotonic across sequence overflow", () => {
  const values = Array.from({ length: 5_000 }, () => uuidv7(1_700_000_000_000));
  assert.ok(values.every((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)));
  assert.deepEqual([...values].sort(), values);
  assert.equal(new Set(values).size, values.length);
});

test("UUIDv7 uses a monotonic logical clock when the wall clock moves backward", () => {
  const values = [
    uuidv7(1_800_000_000_000),
    uuidv7(1_800_000_000_000),
    uuidv7(1_799_999_000_000),
    uuidv7(1_800_000_000_001),
    uuidv7(1_799_000_000_000),
  ];
  assert.deepEqual([...values].sort(), values);
  assert.equal(new Set(values).size, values.length);
});

test("tool schemas remain valid TypeBox values through the public type surface", () => {
  const schema = Type.Object({ path: Type.String() });
  assert.equal(schema.type, "object");
});

test("Vertex uses the official SDK configuration for API keys and ADC", () => {
  const model: Model<"google-vertex"> = {
    id: "vertex-model", name: "Vertex model", api: "google-vertex", provider: "google-vertex",
    baseUrl: "", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 4_096,
  };
  assert.deepEqual(buildGoogleVertexClientConfig(model, { apiKey: "real-key" }, "COLLECTION"), { vertexai: true, apiKey: "real-key", apiVersion: "v1" });
  assert.deepEqual(buildGoogleVertexClientConfig(model, { apiKey: "<authenticated>", project: "project", location: "global", env: { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/key.json" } }, "COLLECTION"), { vertexai: true, project: "project", location: "global", apiVersion: "v1", googleAuthOptions: { keyFilename: "/tmp/key.json" } });
  const proxy = { ...model, baseUrl: "https://proxy.example/v1/projects/project" };
  assert.deepEqual(buildGoogleVertexClientConfig(proxy, { project: "project", location: "global" }, "COLLECTION"), { vertexai: true, project: "project", location: "global", apiVersion: "v1", httpOptions: { baseUrl: proxy.baseUrl, baseUrlResourceScope: "COLLECTION", apiVersion: "" } });
});
