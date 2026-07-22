import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import * as root from "rigyn";
import * as auth from "rigyn/auth";
import * as config from "rigyn/config";
import * as context from "rigyn/context";
import * as core from "rigyn/core";
import * as embedding from "rigyn/embedding";
import * as extensions from "rigyn/extensions";
import * as images from "rigyn/images";
import * as interfaces from "rigyn/interfaces";
import * as modes from "rigyn/modes";
import * as net from "rigyn/net";
import * as processApi from "rigyn/process";
import * as prompts from "rigyn/prompts";
import * as providers from "rigyn/providers";
import * as sdk from "rigyn/sdk";
import * as service from "rigyn/service";
import * as storage from "rigyn/storage";
import * as testing from "rigyn/testing";
import * as tools from "rigyn/tools";
import * as tui from "rigyn/tui";
import packageMetadata from "rigyn/package.json" with { type: "json" };

const capability = {
  value: "supported",
  source: "configuration",
  observedAt: "2026-01-01T00:00:00.000Z",
};

function scripted(id, text = "subpath ready") {
  return testing.createScriptedProvider({
    id,
    models: [{
      id: "model",
      capabilities: { tools: "supported", reasoning: "supported", images: "supported" },
    }],
    scripts: [{ kind: "turn", content: [{ type: "text", text }] }],
  });
}

test("every published subpath performs a representative runtime operation", async () => {
  assert.equal(packageMetadata.name, "rigyn");
  assert.equal(packageMetadata.version, root.RIGYN_VERSION);
  assert.equal(Object.keys(packageMetadata.exports).length, 22);
  assert.equal(typeof sdk.createAgentSession, "function");

  const redactor = new auth.SecretRedactor();
  redactor.register("consumer-secret");
  assert.equal(redactor.redact("value=consumer-secret"), "value=[REDACTED]");

  assert.equal(config.SettingsManager.inMemory({ theme: "dark" }).getTheme(), "dark");

  const budget = context.deriveContextBudget(
    { contextTokens: 32_000, maxOutputTokens: 4_096 },
    { reserveTokens: 4_096 },
  );
  assert.equal(budget?.compactAtTokens, 27_904);

  const cache = core.analyzeCacheEffectiveness([
    { inputTokens: 10, cacheReadTokens: 90, totalTokens: 100 },
  ]);
  assert.equal(cache.status, "effective");

  extensions.validateTemplatePlaceholders("Review {{args}}", new Set(["args"]), "consumer command");
  assert.equal(extensions.renderExtensionCommand({ template: "Review {{args}}" }, "src"), "Review src");

  assert.equal(
    images.sniffImageMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "image/png",
  );
  const imageModels = images.builtinImagesModels({ environment: { OPENROUTER_API_KEY: "consumer-image-key" } });
  assert.equal(imageModels.getModels("openrouter").length > 0, true);
  assert.equal((await imageModels.getAuth("openrouter"))?.apiKey, "consumer-image-key");
  images.registerImagesApiProvider({
    api: "consumer-images",
    async generateImages(model) {
      return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        output: [{ type: "image", mimeType: "image/png", data: "aGk=" }],
        stopReason: "stop",
        timestamp: 1,
      };
    },
  });
  try {
    const generated = await images.generateImages({
      id: "consumer-image-model",
      name: "Consumer image model",
      api: "consumer-images",
      provider: "consumer",
      baseUrl: "https://example.test/v1",
      input: ["text"],
      output: ["image"],
    }, { input: [{ type: "text", text: "probe" }] });
    assert.equal(generated.stopReason, "stop");
    assert.equal(generated.output[0]?.type, "image");
  } finally {
    images.unregisterImagesApiProvider("consumer-images");
  }

  assert.deepEqual(
    interfaces.parseRpcInput('{"id":"request-1","type":"get_state"}'),
    { id: "request-1", type: "get_state" },
  );

  const transport = net.createNetworkTransport({ environment: {} });
  assert.deepEqual(transport.info, { proxied: false, noProxyConfigured: false });
  await transport.close();
  await assert.rejects(transport.fetch("https://example.invalid"), /closed/u);

  const processResult = await new processApi.DirectProcessRunner().run({
    argv: [process.execPath, "--eval", 'require("node:fs").writeSync(1, "process subpath ready")'],
    cwd: process.cwd(),
    inheritEnv: false,
    timeoutMs: 10_000,
    outputLimitBytes: 64 * 1024,
  }, AbortSignal.timeout(15_000));
  assert.equal(processResult.exitCode, 0);
  assert.equal(processResult.stdout.toString("utf8"), "process subpath ready");

  const systemPrompt = prompts.buildSystemPrompt({
    cwd: process.cwd(),
    skills: [],
    selectedTools: [],
  });
  assert.match(systemPrompt, /Available tools:\n\(none\)/u);

  const registryProvider = providers.defineProviderAdapter({
    id: "subpath-provider",
    models: [{ id: "model", capabilities: { tools: true } }],
    async *stream(request, signal) {
      signal.throwIfAborted();
      yield { type: "response_start", model: request.model };
      yield { type: "response_end", reason: "stop" };
    },
    observedAt: capability.observedAt,
  });
  const registry = new providers.ProviderRegistry([registryProvider]);
  const models = await registry.listModels("subpath-provider", AbortSignal.timeout(5_000), { refresh: true });
  assert.equal(models[0]?.capabilities.tools.value, "supported");

  const catalog = service.buildHarnessResourceCatalog({
    tools: [],
    toolOwner: () => ({ kind: "builtin" }),
    skills: [],
    providers: [{ id: "subpath-provider", models }],
  });
  assert.equal(catalog.providers[0]?.id, "subpath-provider");

  const sessionManager = storage.SessionManager.inMemory(process.cwd(), { id: "subpath-session" });
  sessionManager.appendSessionInfo("Subpath session");
  assert.equal(sessionManager.getSessionId(), "subpath-session");
  assert.equal(sessionManager.getSessionName(), "Subpath session");

  const scriptedProvider = scripted("subpath-scripted");
  const scriptedEvents = [];
  for await (const event of scriptedProvider.stream({
    provider: scriptedProvider.id,
    model: "model",
    messages: [],
    tools: [],
  }, AbortSignal.timeout(5_000))) scriptedEvents.push(event);
  assert.equal(scriptedEvents.some((event) => event.type === "text_delta"), true);

  const toolRegistry = new tools.ToolRegistry([{
    definition: {
      name: "consumer_tool",
      description: "Public subpath probe",
      inputSchema: { type: "object", additionalProperties: false },
    },
    validate() {},
    resources() { return []; },
    async execute() { return { content: "ok", isError: false }; },
  }]);
  assert.deepEqual(toolRegistry.names(), ["consumer_tool"]);

  const view = tui.uiPanel(tui.uiText("ready", { role: "success" }), { title: "Subpath" });
  const block = view.render({
    width: 24,
    height: 5,
    focused: false,
    expanded: false,
    theme: { name: "dark", color: true, unicode: true },
  });
  assert.equal(block.lines.some((line) => line.spans.some((span) => span.text.includes("ready"))), true);

  const embeddingProvider = scripted("subpath-embedding", "embedding subpath ready");
  const harness = await embedding.createInMemoryHarness({
    provider: embeddingProvider,
    model: "model",
    api: "openai-chat-completions",
  });
  try {
    const run = await harness.session.run({ prompt: "probe" });
    assert.equal(run.results.at(-1)?.finalText, "embedding subpath ready");
  } finally {
    await harness.close();
  }

  let modeOutput = "";
  const modeSession = {
    sessionManager: { getHeader() { return null; } },
    state: { messages: [] },
    async bindExtensions() {},
    subscribe() { return () => {}; },
    async prompt() {
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "mode subpath ready" }],
        stopReason: "stop",
      });
    },
  };
  const modeRuntime = {
    session: modeSession,
    setRebindSession() {},
    async dispose() {},
  };
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk, encodingOrCallback, callback) => {
    modeOutput += String(chunk);
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return true;
  });
  const modeResult = await modes.runPrintMode(modeRuntime, { mode: "text", initialMessage: "probe" })
    .finally(() => { process.stdout.write = originalWrite; });
  assert.equal(modeOutput, "mode subpath ready\n");
  assert.equal(modeResult, 0);
  assert.equal(typeof service.AgentSession, "function");

  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  await new interfaces.RpcWriter(output).send({
    id: "request-1",
    type: "response",
    command: "get_state",
    success: true,
    data: { sessionId: "subpath-session" },
  });
  assert.equal(
    Buffer.concat(chunks).toString("utf8"),
    '{"id":"request-1","type":"response","command":"get_state","success":true,"data":{"sessionId":"subpath-session"}}\n',
  );
});
