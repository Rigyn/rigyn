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

function requestText(provider: ScriptedProvider, index: number): string {
  return provider.capturedRequests()[index]?.messages
    .flatMap((message) => message.content)
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .join("\n") ?? "";
}

test("extension messages traverse input hooks, start idle turns, defer context, carry images, and queue while active", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-runtime-message-delivery-"));
  const sourcePath = join(root, "messages.mjs");
  const source = `export default (api) => {
    globalThis.__runtimeMessageApi = api;
    globalThis.__runtimeInputSources = [];
    api.on("input", (event) => {
      globalThis.__runtimeInputSources.push([event.source, event.delivery, event.text]);
      if (event.text === "consume") return { action: "handled" };
      if (event.text === "idle input") return { action: "transform", text: "transformed idle input", images: event.images };
    });
  };\n`;
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "message-delivery",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root });
  const provider = new ScriptedProvider({
    id: "message-provider",
    models: [{ id: "message-model", capabilities: { images: "supported" } }],
    scripts: [
      { kind: "turn", content: [{ type: "text", text: "idle complete" }] },
      { kind: "turn", content: [{ type: "text", text: "deferred complete" }] },
      { kind: "turn", content: [{ type: "text", text: "trigger complete" }] },
      { kind: "turn", content: [{ type: "text", text: "active first" }], eventDelayMs: 80 },
      { kind: "turn", content: [{ type: "text", text: "active custom complete" }] },
    ],
  });
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    runtimeExtensions: host,
    managedExtensionLifecycle: true,
  });
  await service.initialize();
  t.after(async () => {
    await service.close();
    store.close();
    await host.close();
    delete (globalThis as Record<string, unknown>).__runtimeMessageApi;
    delete (globalThis as Record<string, unknown>).__runtimeInputSources;
    await rm(root, { recursive: true, force: true });
  });
  const api = (globalThis as Record<string, any>).__runtimeMessageApi;
  const thread = await service.createSession({ name: "message delivery" });
  service.setRuntimeModelSelection({
    threadId: thread.threadId,
    selection: { provider: provider.id, model: "message-model" },
  });

  assert.deepEqual(await api.sendUserMessage({
    threadId: thread.threadId,
    text: "idle input",
  }), {
    threadId: thread.threadId,
    branch: "main",
    delivery: "steer",
    queued: true,
    started: true,
  });
  await api.waitForIdle({ threadId: thread.threadId });
  assert.match(requestText(provider, 0), /transformed idle input/u);

  assert.deepEqual(await api.sendUserMessage({
    threadId: thread.threadId,
    text: "consume",
  }), {
    threadId: thread.threadId,
    branch: "main",
    delivery: "steer",
    queued: false,
    handled: true,
  });
  assert.equal(provider.callCount, 1);

  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZyrAAAAAASUVORK5CYII=";
  const deferred = await api.sendMessage({
    threadId: thread.threadId,
    schemaVersion: 1,
    kind: "visual_context",
    payload: { deferred: true },
    modelContext: {
      role: "user",
      text: "deferred visual context",
      images: [{ type: "image", mediaType: "image/png", data: png }],
    },
    transcript: { text: "Deferred visual context" },
    delivery: "next_turn",
  });
  assert.equal(deferred.modelContext === false ? undefined : deferred.modelContext.images?.length, 1);
  assert.equal(provider.callCount, 1, "next_turn does not start an idle run");
  await service.run({
    threadId: thread.threadId,
    prompt: "use deferred context",
    provider: provider.id,
    model: "message-model",
  });
  assert.match(requestText(provider, 1), /deferred visual context/u);
  assert.equal(provider.capturedRequests()[1]?.messages.some((message) =>
    message.content.some((block) => block.type === "image")), true);

  const triggered = await api.sendMessage({
    threadId: thread.threadId,
    schemaVersion: 1,
    kind: "triggered_context",
    payload: { triggered: true },
    modelContext: { role: "user", text: "trigger this turn" },
    transcript: { text: "Triggered context" },
    triggerTurn: true,
  });
  assert.equal(triggered.modelContext, false, "delivered custom context is persisted through the canonical user message once");
  await api.waitForIdle({ threadId: thread.threadId });
  assert.match(requestText(provider, 2), /trigger this turn/u);

  const active = service.run({
    threadId: thread.threadId,
    prompt: "active base",
    provider: provider.id,
    model: "message-model",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await api.sendMessage({
    threadId: thread.threadId,
    schemaVersion: 1,
    kind: "active_context",
    payload: { active: true },
    modelContext: { role: "user", text: "active custom steering" },
    transcript: { text: "Active context" },
  });
  const activeResult = await active;
  assert.equal(activeResult.results.at(-1)?.finalText, "active custom complete");
  assert.match(requestText(provider, 4), /active custom steering/u);

  assert.deepEqual((globalThis as Record<string, any>).__runtimeInputSources, [
    ["extension", "steer", "idle input"],
    ["extension", "steer", "consume"],
    ["extension", "steer", "trigger this turn"],
    ["extension", "steer", "active custom steering"],
  ]);
});
