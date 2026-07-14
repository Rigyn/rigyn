import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdapterEvent, ModelInfo, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { loadRuntimeExtensions } from "../../src/extensions/runtime.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { ScriptedProvider } from "../../src/testing/scripted-provider.js";
import { sha256 } from "../../src/tools/hash.js";

const observedAt = "2026-01-01T00:00:00.000Z";
const unknown = { value: "unknown" as const, source: "provider" as const, observedAt };

function model(id: string, efforts?: string[]): ModelInfo {
  return {
    provider: "selection-provider",
    id,
    capabilities: { tools: unknown, reasoning: unknown, images: unknown },
    ...(efforts === undefined
      ? {}
      : { compatibility: { reasoningEfforts: { value: efforts, source: "provider", observedAt } } }),
  };
}

class SelectionProvider implements ProviderAdapter {
  readonly id = "selection-provider";
  readonly requests: ProviderRequest[] = [];
  readonly models = [model("coder-v1", ["low", "high"]), model("coder-v2", ["low", "high"])];
  listCalls = 0;

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    signal.throwIfAborted();
    this.requests.push(structuredClone(request));
    yield { type: "response_start", model: request.model };
    yield { type: "text_delta", part: 0, text: "selected" };
    yield {
      type: "response_end",
      reason: "stop",
      state: { kind: "chat_completions", assistantMessage: { role: "assistant", content: "selected" } },
    };
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    signal.throwIfAborted();
    this.listCalls += 1;
    return this.models;
  }
}

test("service run uses the shared canonical model and thinking resolver before session mutation", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-service-model-selection-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const store = new SessionStore(":memory:");
  const provider = new SelectionProvider();
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
    prompt: "select",
    provider: "selection-pro",
    model: "coder-v1:HIGH",
    noBuiltinTools: true,
  });
  assert.equal(run.results.at(-1)?.finalText, "selected");
  assert.deepEqual(
    provider.requests.map(({ provider: selectedProvider, model: selectedModel, reasoningEffort }) => ({
      provider: selectedProvider,
      model: selectedModel,
      reasoningEffort,
    })),
    [{ provider: "selection-provider", model: "coder-v1", reasoningEffort: "high" }],
  );
  await service.run({
    prompt: "select again",
    provider: "selection-provider",
    model: "coder-v1",
    noBuiltinTools: true,
  });
  assert.equal(provider.listCalls, 1);

  const threadCount = store.listThreads({ workspaceRoot: workspace }).length;
  await assert.rejects(
    service.run({
      prompt: "ambiguous",
      provider: "selection-provider",
      model: "coder",
      noBuiltinTools: true,
    }),
    /ambiguous; choose one of: selection-provider\/coder-v1, selection-provider\/coder-v2/u,
  );
  assert.equal(store.listThreads({ workspaceRoot: workspace }).length, threadCount);
  await assert.rejects(
    service.run({
      prompt: "unsupported",
      provider: "selection-provider",
      model: "coder-v1:off",
      noBuiltinTools: true,
    }),
    /does not support thinking level off; supported levels: low, high/u,
  );
});

test("runtime model and reasoning changes refresh the next safe provider turn", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "rigyn-safe-turn-selection-"));
  const sourcePath = join(workspace, "safe-turn.mjs");
  const source = `export default (api) => {
    let session;
    api.on("agent_start", (event) => { session = { threadId: event.threadId, branch: event.branch }; });
    api.registerTool({
      name: "selection_switch",
      description: "Change the selection after this tool result",
      inputSchema: { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { type: "string" } } },
      execute(input) { return { content: input.mode, isError: false }; },
    });
    api.on("tool_result", async (event, context) => {
      if (event.invocation.name !== "selection_switch") return;
      if (event.invocation.input.mode === "model") {
        await api.setModel({ ...session, provider: "safe-second", model: "second-model", reasoningEffort: "high", signal: context.signal });
      } else {
        await api.setThinkingLevel({ ...session, reasoningEffort: "high", signal: context.signal });
      }
    });
  };\n`;
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "safe-turn",
    sourcePath,
    sha256: sha256(source),
  }], { workspace });
  const primary = new ScriptedProvider({
    id: "safe-primary",
    models: [{ id: "primary-model", contextTokens: 4_096, maxOutputTokens: 512 }],
    scripts: [
      { kind: "turn", content: [{ type: "tool_call", id: "model-switch", name: "selection_switch", arguments: { mode: "model" } }] },
      { kind: "turn", content: [{ type: "tool_call", id: "reasoning-switch", name: "selection_switch", arguments: { mode: "reasoning" } }] },
      { kind: "turn", content: [{ type: "text", text: "reasoning switched" }] },
    ],
  });
  const second = new ScriptedProvider({
    id: "safe-second",
    models: [{ id: "second-model", contextTokens: 32, maxOutputTokens: 8, capabilities: { images: "unsupported" } }],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "model switched" }] }],
  });
  const store = new SessionStore(join(workspace, "sessions.sqlite"));
  const service = new HarnessService({
    store,
    workspace,
    providers: new ProviderRegistry([primary, second]),
    runtimeExtensions: host,
    extraTools: host.tools(),
  });
  await service.initialize({ skills: [] });
  t.after(async () => {
    await service.close("test complete");
    await host.close();
    store.close();
    await rm(workspace, { recursive: true, force: true });
  });

  const modelRun = await service.run({
    prompt: "switch model",
    provider: primary.id,
    model: "primary-model",
    reasoningEffort: "low",
    contextTokenBudget: 10_000,
    maxOutputTokens: 123,
    allowedTools: ["selection_switch"],
  });
  assert.equal(modelRun.results[0]?.finalText, "model switched");
  assert.equal(primary.capturedRequests()[0]?.maxOutputTokens, 123);
  const secondRequest = second.capturedRequests()[0];
  assert.equal(secondRequest?.provider, second.id);
  assert.equal(secondRequest?.model, "second-model");
  assert.equal(secondRequest?.reasoningEffort, "high");
  assert.equal(secondRequest?.maxOutputTokens, 8);
  assert.equal(secondRequest?.providerState, undefined);
  assert.deepEqual(store.getModelSelection(modelRun.threadId), {
    provider: second.id,
    model: "second-model",
    reasoningEffort: "high",
  });

  const reasoningRun = await service.run({
    prompt: "switch reasoning",
    provider: primary.id,
    model: "primary-model",
    reasoningEffort: "low",
    contextTokenBudget: 10_000,
    allowedTools: ["selection_switch"],
  });
  assert.equal(reasoningRun.results[0]?.finalText, "reasoning switched");
  const primaryRequests = primary.capturedRequests();
  assert.equal(primaryRequests[1]?.reasoningEffort, "low");
  assert.equal(primaryRequests[2]?.reasoningEffort, "high");
  assert.equal(primaryRequests[2]?.providerState, undefined);
  assert.deepEqual(store.getModelSelection(reasoningRun.threadId), {
    provider: primary.id,
    model: "primary-model",
    reasoningEffort: "high",
  });
});
