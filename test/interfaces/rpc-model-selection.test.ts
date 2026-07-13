import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdapterEvent, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import { RpcRuntimeDispatcher } from "../../src/interfaces/rpc-runtime.js";
import type { RpcRequest } from "../../src/interfaces/rpc.js";
import { CapturePeer, createTestRuntime } from "./rpc-helpers.js";

const observedAt = "2026-01-01T00:00:00.000Z";
const unknown = { value: "unknown" as const, source: "provider" as const, observedAt };

function request(method: string, params?: unknown): RpcRequest {
  return { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) };
}

class RpcSelectionProvider implements ProviderAdapter {
  readonly id = "rpc-selection-provider";
  readonly requests: ProviderRequest[] = [];

  async *stream(input: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    signal.throwIfAborted();
    this.requests.push(structuredClone(input));
    yield { type: "response_start", model: input.model };
    yield { type: "text_delta", part: 0, text: "rpc selected" };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "rpc selected" } },
    };
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    signal.throwIfAborted();
    return ["coder-v1", "coder-v2"].map((id) => ({
      provider: this.id,
      id,
      capabilities: { tools: unknown, reasoning: unknown, images: unknown },
      compatibility: {
        reasoningEfforts: { value: ["low", "high"], source: "provider", observedAt },
      },
    }));
  }
}

test("RPC run selection accepts canonical shorthand without a separate provider and persists canonical state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-rpc-model-selection-"));
  const provider = new RpcSelectionProvider();
  const runtime = await createTestRuntime(root, join(root, "sessions.sqlite"), provider);
  const dispatcher = new RpcRuntimeDispatcher({ runtime });
  const peer = new CapturePeer("rpc-model-selection");
  t.after(async () => {
    await dispatcher.close("test complete");
    await runtime.close();
  });
  t.after(async () => await rm(root, { recursive: true, force: true }));

  const started = await dispatcher.dispatch(peer, request("run.start", {
    prompt: "select",
    model: "rpc-selection/coder-v1:HIGH",
  })) as { threadId: string };
  await dispatcher.dispatch(peer, request("run.wait", { threadId: started.threadId }));
  assert.deepEqual(
    provider.requests.map(({ provider: selectedProvider, model, reasoningEffort }) => ({
      provider: selectedProvider,
      model,
      reasoningEffort,
    })),
    [{ provider: "rpc-selection-provider", model: "coder-v1", reasoningEffort: "high" }],
  );
  const state = await dispatcher.dispatch(peer, request("thread.state", { threadId: started.threadId })) as {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
  };
  assert.deepEqual(
    { provider: state.provider, model: state.model, reasoningEffort: state.reasoningEffort },
    { provider: "rpc-selection-provider", model: "coder-v1", reasoningEffort: "high" },
  );

  const threadCount = runtime.store.listThreads({ workspaceRoot: root }).length;
  await assert.rejects(
    dispatcher.dispatch(peer, request("run.start", { prompt: "ambiguous", model: "coder" })),
    /ambiguous; choose one of/u,
  );
  assert.equal(runtime.store.listThreads({ workspaceRoot: root }).length, threadCount);

  const resolved = await dispatcher.dispatch(peer, request("models.resolve", {
    reference: "rpc-selection/coder-v1",
    reasoningEffort: "off",
    refresh: false,
  })) as {
    match: string;
    candidates: ModelInfo[];
    reasoningEffort?: string;
    supportedReasoningEfforts?: string[];
  };
  assert.deepEqual({
    match: resolved.match,
    candidates: resolved.candidates.map((model) => `${model.provider}/${model.id}`),
    reasoningEffort: resolved.reasoningEffort,
    supportedReasoningEfforts: resolved.supportedReasoningEfforts,
  }, {
    match: "unsupported-thinking",
    candidates: ["rpc-selection-provider/coder-v1"],
    reasoningEffort: "off",
    supportedReasoningEfforts: ["low", "high"],
  });
});
