import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { loadRuntime } from "../../src/cli/runtime.js";
import type {
  AdapterEvent,
  CanonicalMessage,
  ImageBlock,
  ModelInfo,
  ProviderAdapter,
  ProviderRequest,
  ProviderState,
  ToolDefinition,
} from "../../src/core/types.js";

const ENABLED = process.env.RIGYN_LIVE === "1" || process.env.npm_lifecycle_event === "test:live";
const PROVIDER = process.env.RIGYN_LIVE_PROVIDER?.trim() || "openai";
const REQUESTED_MODEL = process.env.RIGYN_LIVE_MODEL?.trim();
const CACHE_ENABLED = process.env.RIGYN_LIVE_CACHE === "1";
const SCENARIOS = new Set((process.env.RIGYN_LIVE_SCENARIOS ?? "text,tool,multiturn,image,abort")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean));

const PREFERRED_MODELS: Readonly<Record<string, readonly string[]>> = {
  openai: ["gpt-5.4-nano", "gpt-5.6-luna", "gpt-4.1-mini"],
  anthropic: ["claude-haiku-4-5", "claude-haiku-4-5-20251001"],
  gemini: ["gemini-3.5-flash", "gemini-2.5-flash-lite"],
  mistral: ["mistral-small-latest", "devstral-small-latest"],
  openrouter: ["openai/gpt-4.1-mini"],
};

const RED_SQUARE_PNG = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAP0lEQVRYhe3XsREAQAgCweu/ab4LP9nA3BkRjlb7OVlgThAR5g3HiMaKE0aJ4wGSQbJAabB8islUs5TTznXwAFQN+GqzUAe3AAAAAElFTkSuQmCC";

interface Collected {
  events: AdapterEvent[];
  text: string;
  state?: ProviderState;
}

function userMessage(id: string, text: string, images: ImageBlock[] = []): CanonicalMessage {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }, ...images],
    createdAt: "2026-07-11T00:00:00.000Z",
  };
}

function request(
  provider: string,
  model: string,
  messages: CanonicalMessage[],
  options: {
    tools?: ToolDefinition[];
    providerState?: ProviderState;
    maxOutputTokens?: number;
    sessionId?: string;
  } = {},
): ProviderRequest {
  return {
    provider,
    model,
    messages,
    tools: options.tools ?? [],
    maxOutputTokens: options.maxOutputTokens ?? 128,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.providerState === undefined ? {} : { providerState: options.providerState }),
  };
}

async function collect(adapter: ProviderAdapter, value: ProviderRequest, signal: AbortSignal): Promise<Collected> {
  const events: AdapterEvent[] = [];
  let text = "";
  let state: ProviderState | undefined;
  for await (const event of adapter.stream(value, signal)) {
    events.push(event);
    if (event.type === "text_delta") text += event.text;
    if (event.type === "response_end") state = event.state;
  }
  assert.equal(events.some((event) => event.type === "error"), false, "provider returned an error");
  return { events, text, ...(state === undefined ? {} : { state }) };
}

function chooseModel(models: readonly ModelInfo[]): ModelInfo {
  if (REQUESTED_MODEL !== undefined) {
    const exact = models.find((model) => model.id === REQUESTED_MODEL);
    assert.ok(exact, "requested live model was not returned by provider discovery");
    return exact;
  }
  for (const id of PREFERRED_MODELS[PROVIDER] ?? []) {
    const preferred = models.find((model) => model.id === id);
    if (preferred !== undefined) return preferred;
  }
  assert.ok(models[0], "connected provider returned no live models");
  return models[0];
}

function scenario(context: TestContext, name: string, run: () => Promise<void>): Promise<void> {
  return context.test(name, { skip: !SCENARIOS.has(name) }, run);
}

test("credential-gated live provider contract", { skip: !ENABLED, timeout: 180_000 }, async (context) => {
  const runtime = await loadRuntime({
    workspace: process.cwd(),
    projectTrusted: false,
    ephemeral: true,
    extensions: false,
    extensionRuntime: false,
    skills: false,
    promptTemplates: false,
    themes: false,
    recover: false,
  });
  try {
    assert.equal(runtime.providers.has(PROVIDER), true, "requested provider is not configured");
    const auth = await runtime.auth.state(PROVIDER);
    assert.equal(auth.status, "connected", "provider credential is not connected");
    const models = await runtime.providers.listModels(PROVIDER, AbortSignal.timeout(30_000), {
      refresh: true,
      verifiedOnly: true,
    });
    const selected = chooseModel(models);
    const adapter = runtime.providers.runtimeAdapter(PROVIDER);

    await scenario(context, "text", async () => {
      const result = await collect(adapter, request(PROVIDER, selected.id, [
        userMessage("live-text-user", "Reply with exactly LIVE_OK."),
      ]), AbortSignal.timeout(45_000));
      assert.equal(result.events.some((event) => event.type === "response_start"), true);
      assert.equal(result.events.some((event) => event.type === "text_delta"), true);
      assert.equal(result.events.some((event) => event.type === "response_end"), true);
      assert.equal(result.events.some((event) => event.type === "usage"), true);
      if (selected.pricing !== undefined) {
        const finalUsage = result.events.findLast((event): event is Extract<AdapterEvent, { type: "usage" }> =>
          event.type === "usage");
        assert.notEqual(finalUsage?.usage.cost, undefined, "catalog-priced live usage did not receive a cost");
      }
      assert.notEqual(result.text.trim(), "");
    });

    await scenario(context, "tool", async () => {
      if (selected.capabilities.tools.value !== "supported") {
        context.diagnostic("tool scenario skipped: live catalog does not confirm tool support");
        return;
      }
      const tool: ToolDefinition = {
        name: "live_probe",
        description: "Return a live provider compatibility marker.",
        inputSchema: {
          type: "object",
          properties: { marker: { type: "string" } },
          required: ["marker"],
          additionalProperties: false,
        },
      };
      const result = await collect(adapter, request(PROVIDER, selected.id, [
        userMessage("live-tool-user", "Call live_probe once with marker LIVE_TOOL. Do not answer in plain text."),
      ], { tools: [tool] }), AbortSignal.timeout(45_000));
      assert.equal(result.events.some((event) => event.type === "tool_call_end" && event.name === "live_probe"), true);
    });

    await scenario(context, "multiturn", async () => {
      const firstUser = userMessage("live-turn-1", "Remember the marker BLUE-COMET and acknowledge briefly.");
      const first = await collect(
        adapter,
        request(PROVIDER, selected.id, [firstUser]),
        AbortSignal.timeout(45_000),
      );
      assert.ok(first.state, "first turn did not return provider continuation state");
      const assistant: CanonicalMessage = {
        id: "live-turn-assistant",
        role: "assistant",
        content: [{ type: "text", text: first.text }],
        createdAt: "2026-07-11T00:00:01.000Z",
        provider: PROVIDER,
      };
      const second = await collect(adapter, request(PROVIDER, selected.id, [
        firstUser,
        assistant,
        userMessage("live-turn-2", "Return only the marker I asked you to remember."),
      ], { providerState: first.state }), AbortSignal.timeout(45_000));
      assert.match(second.text.toUpperCase(), /BLUE[ -]COMET/u);
    });

    await scenario(context, "image", async () => {
      if (selected.capabilities.images.value !== "supported") {
        context.diagnostic("image scenario skipped: live catalog does not confirm image input support");
        return;
      }
      const result = await collect(adapter, request(PROVIDER, selected.id, [
        userMessage("live-image-user", "Acknowledge that you received this test image.", [{
          type: "image",
          mediaType: "image/png",
          data: RED_SQUARE_PNG,
        }]),
      ]), AbortSignal.timeout(45_000));
      assert.notEqual(result.text.trim(), "");
    });

    await scenario(context, "abort", async () => {
      const controller = new AbortController();
      let started = false;
      for await (const event of adapter.stream(request(PROVIDER, selected.id, [
        userMessage("live-abort-user", "Write a long numbered list with at least 500 entries."),
      ], { maxOutputTokens: 2_000 }), controller.signal)) {
        if (event.type === "response_start") {
          started = true;
          controller.abort(new Error("live smoke cancellation"));
        }
        if (event.type === "error") {
          assert.equal(event.error.category, "cancelled");
          break;
        }
      }
      assert.equal(started, true);
      assert.equal(controller.signal.aborted, true);
    });

    await context.test("cache", { skip: !CACHE_ENABLED }, async () => {
      const cacheMode = selected.compatibility?.cacheMode?.value;
      if (cacheMode === undefined || cacheMode === "none") {
        context.diagnostic("cache scenario skipped: live metadata does not confirm prompt caching");
        return;
      }
      const prefix = `${"stable-cache-prefix ".repeat(2_500)}\n`;
      const system: CanonicalMessage = {
        id: "live-cache-system",
        role: "system",
        content: [{ type: "text", text: prefix }],
        createdAt: "2026-07-11T00:00:00.000Z",
      };
      const prompt = userMessage("live-cache-prompt", "Reply briefly.");
      const run = async () => await collect(adapter, request(PROVIDER, selected.id, [system, prompt], {
        maxOutputTokens: 32,
        sessionId: "live-provider-cache-smoke",
      }), AbortSignal.timeout(60_000));
      const first = await run();
      const second = await run();
      const cacheTokens = (events: readonly AdapterEvent[]) => events
        .filter((event): event is Extract<AdapterEvent, { type: "usage" }> => event.type === "usage")
        .reduce((maximum, event) => Math.max(
          maximum,
          event.usage.cacheReadTokens ?? 0,
          event.usage.cacheWriteTokens ?? 0,
        ), 0);
      assert.equal(Math.max(cacheTokens(first.events), cacheTokens(second.events)) > 0, true);
    });
  } finally {
    await runtime.close();
  }
});
