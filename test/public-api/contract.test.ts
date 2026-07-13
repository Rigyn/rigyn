import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HarnessService,
  ProviderRegistry,
  SessionStore,
  type AdapterEvent,
  type EventEnvelope,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderRequest,
} from "../../src/index.js";

const UNKNOWN_CAPABILITY = {
  value: "unknown",
  source: "configuration",
  observedAt: "2026-01-01T00:00:00.000Z",
} as const;

class OfflineProvider implements ProviderAdapter {
  readonly id = "offline-contract";
  readonly requests: ProviderRequest[] = [];

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    signal.throwIfAborted();
    this.requests.push(request);
    const answer = this.requests.length === 1 ? "offline first answer" : "offline resumed answer";
    yield { type: "response_start", model: request.model };
    yield { type: "text_delta", part: 0, text: answer };
    yield {
      type: "usage",
      semantics: "final",
      usage: { inputTokens: request.messages.length, outputTokens: 3 },
    };
    yield {
      type: "response_end",
      reason: "stop",
      state: {
        kind: "chat_completions",
        assistantMessage: { role: "assistant", content: answer },
      },
    };
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    signal.throwIfAborted();
    return [{
      id: "offline-v1",
      provider: this.id,
      contextTokens: 32_000,
      maxOutputTokens: 1_024,
      capabilities: {
        tools: UNKNOWN_CAPABILITY,
        reasoning: UNKNOWN_CAPABILITY,
        images: UNKNOWN_CAPABILITY,
      },
    }];
  }
}

test("root API runs and resumes an offline custom provider session", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-public-api-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const store = new SessionStore(":memory:");
  const provider = new OfflineProvider();
  const service = new HarnessService({
    store,
    workspace,
    providers: new ProviderRegistry([provider]),
  });

  try {
    await service.initialize({ skills: [] });
    const firstEvents: EventEnvelope[] = [];
    const first = await service.run({
      prompt: "first prompt",
      provider: provider.id,
      model: "offline-v1",
      noBuiltinTools: true,
      onEvent: (event) => {
        firstEvents.push(event);
      },
    });
    assert.equal(first.results.at(-1)?.finalText, "offline first answer");
    assert.ok(firstEvents.some((entry) => entry.event.type === "run_started"));
    assert.ok(firstEvents.some((entry) => entry.event.type === "run_completed"));

    const resumedEvents: EventEnvelope[] = [];
    const resumed = await service.run({
      threadId: first.threadId,
      prompt: "second prompt",
      provider: provider.id,
      model: "offline-v1",
      noBuiltinTools: true,
      onEvent: (event) => {
        resumedEvents.push(event);
      },
    });
    assert.equal(resumed.threadId, first.threadId);
    assert.equal(resumed.results.at(-1)?.finalText, "offline resumed answer");
    assert.equal(provider.requests.length, 2);
    assert.equal(
      provider.requests[1]?.messages.some((message) =>
        message.role === "assistant" &&
        message.content.some((block) => block.type === "text" && block.text === "offline first answer")),
      true,
    );
    assert.ok(resumedEvents.some((entry) => entry.event.type === "run_completed"));
    assert.equal(store.listRuns(first.threadId).length, 2);

    await service.close("public_api_test");
    await assert.rejects(
      service.run({ prompt: "closed", provider: provider.id, model: "offline-v1" }),
      /closed/u,
    );
  } finally {
    await service.close("public_api_test_cleanup");
    store.close();
  }
});
