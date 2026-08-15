import assert from "node:assert/strict";
import test from "node:test";

import type { AdapterEvent, ProviderRequest } from "../../src/core/types.js";
import { defineProviderAdapter } from "../../src/providers/authoring.js";

const OBSERVED_AT = "2026-07-13T00:00:00.000Z";

function request(provider = "authored-provider"): ProviderRequest {
  return {
    provider,
    model: "model-b",
    messages: [],
    tools: [],
  };
}

async function events(iterable: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const result: AdapterEvent[] = [];
  for await (const event of iterable) result.push(event);
  return result;
}

test("defineProviderAdapter expands compact capabilities into a bounded canonical catalog", async () => {
  let modelSignal: AbortSignal | undefined;
  const adapter = defineProviderAdapter({
    id: "authored-provider",
    observedAt: OBSERVED_AT,
    models(signal) {
      modelSignal = signal;
      return [
        { id: "model-b", displayName: "Model B", capabilities: { tools: true, reasoning: "unknown" } },
        { id: "model-a", capabilities: { images: false } },
      ];
    },
    async *stream(providerRequest, signal) {
      signal.throwIfAborted();
      yield { type: "response_start", model: providerRequest.model };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "ok" } },
      };
    },
  });
  const signal = new AbortController().signal;
  const models = await adapter.listModels(signal);

  assert.strictEqual(modelSignal, signal);
  assert.deepEqual(models.map((model) => model.id), ["model-a", "model-b"]);
  assert.deepEqual(models[1]?.capabilities, {
    tools: { value: "supported", source: "provider", observedAt: OBSERVED_AT },
    reasoning: { value: "unknown", source: "provider", observedAt: OBSERVED_AT },
    images: { value: "unknown", source: "provider", observedAt: OBSERVED_AT },
  });
});

test("defineProviderAdapter rejects malformed model metadata through registry normalization", async () => {
  const adapter = defineProviderAdapter({
    id: "authored-provider",
    observedAt: OBSERVED_AT,
    models: [{
      id: "model-a",
      capabilities: {
        tools: { value: "invalid", source: "provider", observedAt: OBSERVED_AT },
      },
    }] as unknown as Parameters<typeof defineProviderAdapter>[0]["models"],
    async *stream() {},
  });

  await assert.rejects(
    adapter.listModels(new AbortController().signal),
    /Tool capability.*value is invalid/u,
  );
});

test("defineProviderAdapter propagates cancellation and rejects cross-provider requests", async () => {
  let streamSignal: AbortSignal | undefined;
  const adapter = defineProviderAdapter({
    id: "authored-provider",
    models: [],
    async *stream(_providerRequest, signal) {
      streamSignal = signal;
      signal.throwIfAborted();
      yield { type: "response_start", model: "model-b" };
    },
  });
  const controller = new AbortController();

  assert.deepEqual(await events(adapter.stream(request(), controller.signal)), [{
    type: "response_start",
    model: "model-b",
  }]);
  assert.strictEqual(streamSignal, controller.signal);
  await assert.rejects(
    async () => await events(adapter.stream(request("another-provider"), controller.signal)),
    /cannot serve a request for another-provider/u,
  );

  controller.abort(new Error("provider authoring cancelled"));
  await assert.rejects(
    adapter.listModels(controller.signal),
    /provider authoring cancelled/u,
  );
  await assert.rejects(
    async () => await events(adapter.stream(request(), controller.signal)),
    /provider authoring cancelled/u,
  );
});
