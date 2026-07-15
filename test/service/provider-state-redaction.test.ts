import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdapterEvent, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import { ProviderRegistry } from "../../src/providers/index.js";
import { HarnessService } from "../../src/service/index.js";
import { SessionStore } from "../../src/storage/index.js";
import { ScriptedProvider } from "../../src/testing/index.js";
import type { ToolExecutionBackend } from "../../src/tools/index.js";

const observedAt = "2026-07-14T00:00:00.000Z";
const unknown = { value: "unknown" as const, source: "provider" as const, observedAt };

class AliasedStateProvider implements ProviderAdapter {
  readonly id = "aliased-state-provider";
  readonly requests: ProviderRequest[] = [];

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    signal.throwIfAborted();
    this.requests.push(structuredClone(request));
    yield { type: "response_start", model: request.model };
    if (this.requests.length === 1) {
      const input = { path: "fixture.txt" };
      const rawArguments = JSON.stringify(input);
      yield { type: "tool_call_start", index: 0, id: "read-call", name: "read" };
      yield { type: "tool_call_delta", index: 0, jsonFragment: rawArguments };
      yield {
        type: "tool_call_end",
        index: 0,
        id: "read-call",
        name: "read",
        rawArguments,
        arguments: input,
      };
      yield {
        type: "response_end",
        reason: "tool_calls",
        state: {
          kind: "anthropic_messages",
          assistantBlocks: [{ type: "tool_use", id: "read-call", name: "read", input }],
        },
      };
      return;
    }
    yield { type: "text_delta", part: 0, text: "complete" };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "anthropic_messages", assistantBlocks: [{ type: "text", text: "complete" }] },
    };
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    signal.throwIfAborted();
    return [{
      id: "aliased-state-model",
      provider: this.id,
      capabilities: {
        tools: { value: "supported", source: "provider", observedAt },
        reasoning: unknown,
        images: unknown,
      },
    }];
  }
}

test("service keeps redacted provider state and its serialized copy consistent", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-provider-state-redaction-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const provider = new ScriptedProvider({
    id: "state-redaction-provider",
    models: [{ id: "state-redaction-model" }],
    scripts: [{
      kind: "turn",
      content: [{ type: "text", text: "complete" }],
      terminal: {
        type: "finish",
        state: {
          kind: "anthropic_messages",
          assistantBlocks: [{ type: "text", text: "complete", secret: "provider-private" }],
        },
      },
    }],
  });
  const store = new SessionStore(":memory:");
  const service = new HarnessService({
    store,
    workspace,
    providers: new ProviderRegistry([provider]),
  });
  t.after(async () => {
    await service.close("test complete");
    store.close();
  });
  await service.initialize({ skills: [] });

  const run = await service.run({
    prompt: "complete once",
    provider: provider.id,
    model: "state-redaction-model",
    noBuiltinTools: true,
  });
  assert.equal(run.results.at(-1)?.finalText, "complete");
  const appended = store.listEvents(run.threadId).findLast((entry) =>
    entry.event.type === "message_appended" && entry.event.message.role === "assistant");
  assert.equal(appended?.event.type, "message_appended");
  if (appended?.event.type !== "message_appended") return;
  assert.deepEqual(appended.event.providerState, {
    kind: "anthropic_messages",
    assistantBlocks: [{ type: "text", text: "complete", secret: "[REDACTED]" }],
  });
  assert.deepEqual(JSON.parse(appended.event.providerStateSerialized ?? "null"), appended.event.providerState);
});

test("service preserves aliased tool arguments across durable provider continuation", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-provider-state-alias-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const provider = new AliasedStateProvider();
  const toolBackend: ToolExecutionBackend = {
    id: "provider-state-fixture",
    handles(name) { return name === "read"; },
    resources() { return []; },
    async execute() {
      return { content: "fixture contents", isError: false, status: "success", summary: "read fixture" };
    },
  };
  const store = new SessionStore(":memory:");
  const service = new HarnessService({
    store,
    workspace,
    providers: new ProviderRegistry([provider]),
    toolBackend,
  });
  t.after(async () => {
    await service.close("test complete");
    store.close();
  });
  await service.initialize({ skills: [] });

  const run = await service.run({
    prompt: "read the fixture",
    provider: provider.id,
    model: "aliased-state-model",
    allowedTools: ["read"],
  });
  assert.equal(run.results.at(-1)?.finalText, "complete");
  assert.equal(provider.requests.length, 2);
  assert.deepEqual(provider.requests[1]?.providerState, {
    kind: "anthropic_messages",
    assistantBlocks: [{
      type: "tool_use",
      id: "read-call",
      name: "read",
      input: { path: "fixture.txt" },
    }],
  });
  const appended = store.listEvents(run.threadId).find((entry) =>
    entry.event.type === "message_appended" &&
    entry.event.message.content.some((block) => block.type === "tool_call"));
  assert.equal(appended?.event.type, "message_appended");
  if (appended?.event.type !== "message_appended") return;
  assert.deepEqual(appended.event.providerState, provider.requests[1]?.providerState);
  assert.deepEqual(JSON.parse(appended.event.providerStateSerialized ?? "null"), appended.event.providerState);
});
