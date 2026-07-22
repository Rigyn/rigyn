import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SettingsManager } from "../../src/core/settings-manager.js";
import type {
  AdapterEvent,
  ModelInfo,
  NormalizedUsage,
  ProviderAdapter,
  ProviderRequest,
} from "../../src/core/types.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";
import { extensionUsage } from "../../src/extensions/session-contract.js";
import type { Usage } from "@rigyn/kernel";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { AgentSession } from "../../src/service/agent-session.js";
import { SessionManager } from "../../src/storage/session-manager.js";

const observedAt = "2026-07-20T00:00:00.000Z";
const supported = { value: "supported", source: "provider", observedAt } as const;

function usage(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  cost: number,
): NormalizedUsage {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    cost: { input: cost / 4, output: cost / 4, cacheRead: cost / 4, cacheWrite: cost / 4, total: cost },
  };
}

class ToolUsageProvider implements ProviderAdapter {
  readonly id = "usage-fixture";
  readonly model: ModelInfo = {
    id: "model",
    provider: this.id,
    contextTokens: 64_000,
    maxOutputTokens: 4_096,
    capabilities: { tools: supported, reasoning: supported, images: supported },
    compatibility: {
      protocolFamily: { value: "openai-chat-completions", source: "provider", observedAt },
    },
  };
  requests = 0;

  async *stream(request: ProviderRequest): AsyncIterable<AdapterEvent> {
    this.requests += 1;
    yield { type: "response_start", model: request.model };
    if (this.requests === 1) {
      yield { type: "tool_call_start", index: 0, id: "usage-call", name: "usage_probe" };
      yield {
        type: "tool_call_end",
        index: 0,
        id: "usage-call",
        name: "usage_probe",
        rawArguments: "{}",
        arguments: {},
      };
      yield { type: "response_end", reason: "tool_calls", state: { kind: "chat_completions", assistantMessage: {} } };
      return;
    }
    yield { type: "text_delta", part: 0, text: "done" };
    yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: {} } };
  }

  async listModels(): Promise<ModelInfo[]> { return [this.model]; }
}

test("generated branch summaries persist their own usage on the reachable summary entry", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-branch-usage-"));
  context.after(async () => await rm(cwd, { recursive: true, force: true }));
  const provider = new ToolUsageProvider();
  const manager = SessionManager.create(cwd, join(cwd, "sessions"), { id: "branch-usage" });
  const target = manager.appendMessage({
    id: "root-user",
    role: "user",
    content: [{ type: "text", text: "first" }],
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  manager.appendMessage({
    id: "old-assistant",
    role: "assistant",
    content: [{ type: "text", text: "old branch" }],
    createdAt: "2026-07-20T00:00:01.000Z",
    provider: provider.id,
    model: provider.model.id,
    api: "openai-chat-completions",
    stopReason: "stop",
  });
  const session = await AgentSession.create({
    sessionManager: manager,
    providers: new ProviderRegistry([provider]),
    settingsManager: SettingsManager.inMemory(),
  });
  context.after(async () => await session.close());
  await session.setModel({
    provider: provider.id,
    id: provider.model.id,
    api: "openai-chat-completions",
    info: provider.model,
  });

  const generatedUsage = usage(11, 3, 5, 2, 0.4);
  provider.stream = async function* (request: ProviderRequest): AsyncIterable<AdapterEvent> {
    yield { type: "response_start", model: request.model };
    yield { type: "text_delta", part: 0, text: "generated branch summary" };
    yield { type: "usage", semantics: "final", usage: generatedUsage };
    yield { type: "response_end", reason: "stop", state: { kind: "chat_completions", assistantMessage: {} } };
  };

  const result = await session.navigateTree(target, { summarize: true });
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.summaryEntry?.usage, generatedUsage);
  assert.deepEqual(manager.getBranch().at(-1), result.summaryEntry);
  assert.equal(session.getSessionStats().usageBreakdown.find((entry) => entry.key === "Tools/summaries")?.cost, 0.4);

  const file = manager.getSessionFile();
  assert.ok(file);
  const persisted = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const summary = persisted.find((entry) => entry.type === "branch_summary") as { usage?: NormalizedUsage } | undefined;
  assert.deepEqual(summary?.usage, generatedUsage);
});

test("tool-result extensions observe, replace, persist, and count tool usage once", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-tool-usage-"));
  context.after(async () => await rm(cwd, { recursive: true, force: true }));
  const provider = new ToolUsageProvider();
  const original = usage(1, 2, 3, 4, 0.1);
  const patched = usage(5, 6, 7, 8, 0.9);
  let observed: Usage | undefined;
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "usage-extension",
      factory(api) {
        api.registerTool({
          name: "usage_probe",
          label: "Usage probe",
          description: "Returns attributable usage",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            return { content: [{ type: "text", text: "tool output" }], details: {}, usage: extensionUsage(original) };
          },
        });
        api.on("tool_result", (event) => {
          observed = event.usage;
          return { usage: extensionUsage(patched) };
        });
      },
    }],
  });
  context.after(async () => await host.close());
  const manager = SessionManager.inMemory(cwd, { id: "tool-usage" });
  const session = await AgentSession.create({
    sessionManager: manager,
    providers: new ProviderRegistry([provider]),
    settingsManager: SettingsManager.inMemory(),
    extensionRunner: host,
    tools: host.tools(),
  });
  context.after(async () => await session.close());
  await session.setModel({
    provider: provider.id,
    id: provider.model.id,
    api: "openai-chat-completions",
    info: provider.model,
  });

  assert.equal(host.hasListeners("tool_result"), true);
  assert.equal(session.getActiveTools().includes("usage_probe"), true);
  await session.prompt("run the usage probe", { allowedTools: ["usage_probe"] });
  assert.deepEqual(observed, extensionUsage(original));
  const toolMessage = manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "tool");
  assert.deepEqual(
    toolMessage?.type === "message" && toolMessage.message.role === "tool" ? toolMessage.message.usage : undefined,
    patched,
  );
  const stats = session.getSessionStats();
  assert.deepEqual(stats.usage, patched);
  assert.deepEqual(stats.tokens, { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, total: 26 });
  assert.deepEqual(stats.usageBreakdown, [{ key: "Tools/summaries", tokens: 26, cost: 0.9 }]);
});

test("historical usage includes unreachable branches and auxiliary entries without double counting", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-history-usage-"));
  context.after(async () => await rm(cwd, { recursive: true, force: true }));
  const manager = SessionManager.inMemory(cwd, { id: "history-usage" });
  const root = manager.appendMessage({
    id: "history-root",
    role: "user",
    content: [{ type: "text", text: "root" }],
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  const assistantUsage = usage(10, 2, 20, 4, 1.2);
  manager.appendMessage({
    id: "history-assistant",
    role: "assistant",
    content: [{ type: "text", text: "abandoned" }],
    createdAt: "2026-07-20T00:00:01.000Z",
    provider: "provider-a",
    model: "model-a",
    api: "openai-chat-completions",
    stopReason: "stop",
    usage: assistantUsage,
  });
  manager.branch(root);
  const toolUsage = usage(3, 1, 0, 0, 0.2);
  manager.appendMessage({
    id: "history-tool",
    role: "tool",
    content: [{ type: "tool_result", callId: "call", name: "tool", content: "ok", isError: false }],
    createdAt: "2026-07-20T00:00:02.000Z",
    usage: toolUsage,
  });
  const compactionUsage = usage(2, 2, 1, 1, 0.3);
  manager.appendCompaction("summary", root, 100, undefined, false, compactionUsage);
  const branchUsage = usage(4, 1, 2, 1, 0.4);
  manager.branchWithSummary(root, "another summary", undefined, false, branchUsage);
  const session = await AgentSession.create({
    sessionManager: manager,
    providers: new ProviderRegistry(),
    settingsManager: SettingsManager.inMemory(),
  });
  context.after(async () => await session.close());

  const stats = session.getSessionStats();
  assert.deepEqual(stats.tokens, { input: 19, output: 6, cacheRead: 23, cacheWrite: 6, total: 54 });
  assert.equal(stats.cost, 2.1);
  assert.deepEqual(stats.usageBreakdown, [
    { key: "provider-a/model-a", tokens: 36, cost: 1.2 },
    { key: "Tools/summaries", tokens: 18, cost: 0.9 },
  ]);
  assert.equal(stats.usage.totalTokens, 54);
});
