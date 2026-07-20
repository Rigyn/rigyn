import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntimeExtensions } from "../../src/extensions/runtime.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { ScriptedProvider } from "../../src/testing/scripted-provider.js";
import { sha256 } from "../../src/tools/hash.js";

test("extensions reconstruct historical usage and a redacted prompt snapshot after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-observability-"));
  const database = join(root, "sessions.sqlite");
  const sourcePath = join(root, "observability.mjs");
  const source = `export default (api) => { globalThis.__runtimeObservabilityApi = api; };\n`;
  await writeFile(sourcePath, source);
  t.after(async () => {
    delete (globalThis as Record<string, unknown>).__runtimeObservabilityApi;
    await rm(root, { recursive: true, force: true });
  });

  const firstHost = await loadRuntimeExtensions([{
    extensionId: "observability",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root });
  const provider = new ScriptedProvider({
    id: "usage-provider",
    models: [{ id: "usage-model", contextTokens: 100_000, capabilities: { tools: "supported" } }],
    scripts: [
      {
        kind: "turn",
        content: [{ type: "text", text: "first" }],
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 17,
          cacheWriteTokens: 5,
          cost: "0.125",
        },
      },
      {
        kind: "turn",
        content: [{ type: "text", text: "second" }],
        usage: {
          inputTokens: 4,
          outputTokens: 3,
          totalTokens: 13,
          cacheReadTokens: 6,
          cost: "0.25",
        },
      },
    ],
  });
  const firstStore = new SessionStore(database);
  const firstService = new HarnessService({
    store: firstStore,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    runtimeExtensions: firstHost,
  });
  await firstService.initialize();
  const systemPrompt = {
    source: "observability-test",
    text: "Keep api_key=sk-proj-abcdefghijklmnop out of extension snapshots.",
  };
  const firstRun = await firstService.run({
    prompt: "first",
    provider: provider.id,
    model: "usage-model",
    systemPrompt,
  });
  await firstService.run({
    threadId: firstRun.threadId,
    prompt: "second",
    provider: provider.id,
    model: "usage-model",
    systemPrompt,
  });
  await firstService.close();
  await firstHost.close();
  firstStore.close();

  const secondHost = await loadRuntimeExtensions([{
    extensionId: "observability",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root });
  const secondStore = new SessionStore(database);
  const secondService = new HarnessService({
    store: secondStore,
    workspace: root,
    providers: new ProviderRegistry(),
    runtimeExtensions: secondHost,
  });
  await secondService.initialize();
  t.after(async () => {
    await secondService.close();
    await secondHost.close();
    secondStore.close();
  });
  const api = (globalThis as Record<string, any>).__runtimeObservabilityApi;

  assert.deepEqual(await api.getSessionUsage({ threadId: firstRun.threadId }), {
    threadId: firstRun.threadId,
    branch: "main",
    runCount: 2,
    responseCount: 2,
    usageEventCount: 2,
    usage: {
      inputTokens: 14,
      outputTokens: 5,
      totalTokens: 30,
      cacheReadTokens: 6,
      cacheWriteTokens: 5,
      cost: "0.375",
    },
    cache: {
      status: "low_reuse",
      samples: 2,
      observedInputTokens: 25,
      uncachedInputTokens: 14,
      cacheReadTokens: 6,
      cacheWriteTokens: 5,
      reuseRatio: 0.24,
    },
  });

  const prompt = await api.getSystemPromptSnapshot({ threadId: firstRun.threadId });
  assert.equal(prompt.threadId, firstRun.threadId);
  assert.equal(prompt.branch, "main");
  assert.equal(prompt.redacted, true);
  assert.match(prompt.text, /api_key=\[REDACTED\]/u);
  assert.doesNotMatch(prompt.text, /sk-proj-/u);
  assert.match(prompt.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(prompt.model, { provider: provider.id, model: "usage-model" });
  assert.deepEqual(prompt.composition.sources.map((entry: { kind: string; source: string }) => [entry.kind, entry.source]), [
    ["system_prompt", "observability-test"],
  ]);
});
