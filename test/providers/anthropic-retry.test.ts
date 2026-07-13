import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentRunner } from "../../src/core/agent.js";
import type { EventEnvelope, EventSink, RuntimeEvent } from "../../src/core/events.js";
import type { CanonicalMessage } from "../../src/core/types.js";
import { DirectProcessRunner } from "../../src/process/runner.js";
import { AnthropicAdapter } from "../../src/providers/anthropic.js";
import { ToolCoordinator } from "../../src/tools/coordinator.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { WorkspaceBoundary } from "../../src/tools/paths.js";
import { byteChunks, collect, fakeFetch, request, streamResponse } from "./helpers.js";

function sse(...values: unknown[]): string {
  return values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
}

function messageStart(id: string): Record<string, unknown> {
  return {
    type: "message_start",
    message: { id, model: "claude-test", usage: { input_tokens: 7 } },
  };
}

class MemoryEvents implements EventSink {
  readonly threadId = "anthropic-retry";
  readonly runId = "run-anthropic-retry";
  readonly events: EventEnvelope[] = [];

  async emit(event: RuntimeEvent): Promise<EventEnvelope> {
    const envelope: EventEnvelope = {
      eventId: `event-${this.events.length + 1}`,
      threadId: this.threadId,
      runId: this.runId,
      sequence: this.events.length + 1,
      timestamp: new Date(0).toISOString(),
      schemaVersion: 1,
      event,
    };
    this.events.push(envelope);
    return envelope;
  }
}

test("Anthropic premature EOF is retryable only before substantive output", async (t) => {
  await t.test("message_start bookkeeping is not durable output", async () => {
    const adapter = new AnthropicAdapter({
      apiKey: "secret",
      fetch: fakeFetch(() => streamResponse(byteChunks(sse(messageStart("truncated"))))),
    });

    const events = await collect(adapter.stream(request("anthropic"), new AbortController().signal));

    assert.deepEqual(events.map((event) => event.type), ["error"]);
    const failure = events[0];
    assert.equal(failure?.type, "error");
    if (failure?.type !== "error") return;
    assert.equal(failure.error.category, "network");
    assert.equal(failure.error.retryable, true);
    assert.equal(failure.error.partial, false);
    assert.equal(failure.error.bodyStarted, undefined);
  });

  await t.test("text output keeps a truncated attempt non-retryable", async () => {
    const adapter = new AnthropicAdapter({
      apiKey: "secret",
      fetch: fakeFetch(() => streamResponse(byteChunks(sse(
        messageStart("partial"),
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
      )))),
    });

    const events = await collect(adapter.stream(request("anthropic"), new AbortController().signal));

    assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.text : ""), ["partial"]);
    const failure = events.at(-1);
    assert.equal(failure?.type, "error");
    if (failure?.type !== "error") return;
    assert.equal(failure.error.retryable, false);
    assert.equal(failure.error.partial, true);
    assert.equal(failure.error.bodyStarted, true);
  });
});

test("agent retries a pre-content Anthropic EOF without duplicating durable output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-anthropic-retry-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const workspace = await WorkspaceBoundary.create(root);
  const runtime = new MemoryEvents();
  const messages: CanonicalMessage[] = [];
  let attempts = 0;
  const adapter = new AnthropicAdapter({
    apiKey: "secret",
    fetch: fakeFetch(() => {
      attempts += 1;
      if (attempts === 1) return streamResponse(byteChunks(sse(messageStart("truncated"))));
      return streamResponse(byteChunks(sse(
        messageStart("complete"),
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      )));
    }),
  });
  const runner = new AgentRunner({
    conversation: { async loadContext() { return { messages: [...messages] }; } },
    events() {
      return {
        ...runtime,
        emit: async (event: RuntimeEvent) => {
          const envelope = await runtime.emit(event);
          if (event.type === "message_appended") messages.push(event.message);
          return envelope;
        },
      };
    },
    retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    random: () => 0.5,
  });
  const tools = new ToolCoordinator(new ToolRegistry([]));

  const result = await runner.run({
    threadId: runtime.threadId,
    prompt: "recover safely",
    provider: adapter,
    model: "claude-test",
    tools,
    toolContext: { workspace, runner: new DirectProcessRunner() },
  });

  assert.equal(attempts, 2);
  assert.equal(result.finalText, "recovered");
  const events = runtime.events.map((entry) => entry.event);
  assert.equal(events.filter((event) => event.type === "retry_scheduled").length, 1);
  assert.equal(events.filter((event) => event.type === "provider_response_started").length, 1);
  assert.deepEqual(
    events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.text : ""),
    ["recovered"],
  );
  assert.equal(messages.filter((message) => message.role === "assistant").length, 1);
});
