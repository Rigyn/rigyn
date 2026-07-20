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

test("extension model controls emit actual changes, preserve previous values, restore once, and reject unavailable auth", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-model-events-"));
  const sourcePath = join(root, "selection-events.mjs");
  const source = `export default (api) => {
    globalThis.__selectionEventsApi = api;
    globalThis.__selectionEvents = [];
    api.on("model_select", (event) => globalThis.__selectionEvents.push({ type: "model", ...event }));
    api.on("thinking_level_select", (event) => globalThis.__selectionEvents.push({ type: "thinking", ...event }));
  };\n`;
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "selection-events",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root });
  const primary = new ScriptedProvider({
    id: "selection-primary",
    models: [
      { id: "model-a", capabilities: { reasoning: "supported" } },
      { id: "model-b", capabilities: { reasoning: "supported" } },
    ],
    scripts: [{ kind: "turn", content: [{ type: "text", text: "restored" }] }],
  });
  const locked = new ScriptedProvider({
    id: "selection-locked",
    models: [{ id: "locked-model" }],
  });
  const providers = new ProviderRegistry([primary, locked]);
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const available = async (provider: string): Promise<boolean> => provider !== locked.id;
  let service = new HarnessService({
    store,
    workspace: root,
    providers,
    runtimeExtensions: host,
    providerAvailable: available,
    managedExtensionLifecycle: true,
  });
  await service.initialize();
  t.after(async () => {
    await service.close().catch(() => undefined);
    store.close();
    await host.close();
    delete (globalThis as Record<string, unknown>).__selectionEventsApi;
    delete (globalThis as Record<string, unknown>).__selectionEvents;
    await rm(root, { recursive: true, force: true });
  });
  const api = (globalThis as Record<string, any>).__selectionEventsApi;
  const thread = await service.createSession({ name: "selection events" });

  assert.deepEqual(await api.setModel({
    threadId: thread.threadId,
    provider: primary.id,
    model: "model-a",
  }), { provider: primary.id, model: "model-a" });
  await api.setModel({ threadId: thread.threadId, provider: primary.id, model: "model-a" });
  await api.setThinkingLevel({ threadId: thread.threadId, reasoningEffort: "high" });
  await api.setModel({
    threadId: thread.threadId,
    provider: primary.id,
    model: "model-b",
    reasoningEffort: "high",
  });

  const beforeUnavailable = await api.getModel({ threadId: thread.threadId });
  await assert.rejects(api.setModel({
    threadId: thread.threadId,
    provider: locked.id,
    model: "locked-model",
  }), /no usable active credential/u);
  assert.deepEqual(await api.getModel({ threadId: thread.threadId }), beforeUnavailable);

  const beforeRestore = [...((globalThis as Record<string, any>).__selectionEvents as unknown[])];
  assert.deepEqual(beforeRestore, [
    {
      type: "model",
      threadId: thread.threadId,
      branch: "main",
      provider: primary.id,
      model: "model-a",
      source: "set",
    },
    {
      type: "thinking",
      threadId: thread.threadId,
      branch: "main",
      level: "high",
      previousLevel: "off",
      source: "set",
    },
    {
      type: "model",
      threadId: thread.threadId,
      branch: "main",
      provider: primary.id,
      model: "model-b",
      previousModel: { provider: primary.id, model: "model-a", reasoningEffort: "high" },
      source: "set",
    },
  ]);
  assert.equal(store.listEvents(thread.threadId).filter((entry) => entry.event.type === "model_selected").length, 3);

  await service.close();
  service = new HarnessService({
    store,
    workspace: root,
    providers,
    runtimeExtensions: host,
    providerAvailable: available,
    managedExtensionLifecycle: true,
  });
  await service.initialize();
  const resumed = await service.run({
    threadId: thread.threadId,
    prompt: "resume",
    provider: primary.id,
    model: "model-b",
    reasoningEffort: "high",
  });
  assert.equal(resumed.results.at(-1)?.finalText, "restored");
  const restoredEvents = (globalThis as Record<string, any>).__selectionEvents as Array<Record<string, unknown>>;
  assert.equal(restoredEvents.filter((entry) => entry.type === "model" && entry.source === "restore").length, 1);
  assert.equal(restoredEvents.filter((entry) => entry.type === "model" && entry.source === "run").length, 0);
});
