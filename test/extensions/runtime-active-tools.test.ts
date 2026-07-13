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
import type { HarnessTool } from "../../src/tools/types.js";

const ownerSource = `export default (api) => {
  globalThis.__activeToolOwnerApi = api;
  api.registerTool({
    name: "owner_switch",
    description: "Switch the next provider turn's tools",
    inputSchema: { type: "object", additionalProperties: false },
    async execute(_input, context) {
      globalThis.__activeToolCatalogDuringRun = await api.getAllTools({ threadId: context.threadId });
      await api.setActiveTools({ threadId: context.threadId, names: ["foreign_tool", "read"] });
      return { content: "switched", isError: false };
    }
  });
  api.on("before_agent_start", (event) => ({ messages: [], systemPrompt: event.systemPrompt + "\\nACTIVE_TOOL_PROMPT" }));
};\n`;

const foreignSource = `export default (api) => {
  globalThis.__activeToolForeignApi = api;
  api.registerTool({
    name: "foreign_tool",
    description: "A tool registered by another loaded extension",
    inputSchema: { type: "object", additionalProperties: false },
    execute() { return { content: "foreign", isError: false }; }
  });
};\n`;

test("runtime extensions replace active tools in caller order at the next safe provider turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-active-tools-"));
  const ownerPath = join(root, "owner.mjs");
  const foreignPath = join(root, "foreign.mjs");
  await writeFile(ownerPath, ownerSource);
  await writeFile(foreignPath, foreignSource);
  const host = await loadRuntimeExtensions([
    { extensionId: "owner.extension", sourcePath: ownerPath, sha256: sha256(ownerSource) },
    { extensionId: "foreign.extension", sourcePath: foreignPath, sha256: sha256(foreignSource) },
  ], { workspace: root });
  const provider = new ScriptedProvider({
    scripts: [
      {
        kind: "turn",
        content: [{ type: "tool_call", id: "switch-call", name: "owner_switch", arguments: {} }],
        terminal: { type: "finish", reason: "tool_calls" },
      },
      { kind: "turn", content: [{ type: "text", text: "done" }] },
    ],
    models: [{ id: "scripted-model", contextTokens: 100_000, capabilities: { tools: "supported" } }],
  });
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const hostTool: HarnessTool = {
    definition: {
      name: "host_tool",
      description: "A tool supplied by the embedding host",
      inputSchema: { type: "object", additionalProperties: false },
    },
    validate() {},
    resources() { return []; },
    async execute() { return { content: "host", isError: false }; },
  };
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    runtimeExtensions: host,
    extraTools: [...host.tools(), hostTool],
  });
  await service.initialize({ skills: [] });
  t.after(async () => {
    await service.close("runtime_active_tools_test");
    await host.close();
    store.close();
    delete (globalThis as Record<string, unknown>).__activeToolOwnerApi;
    delete (globalThis as Record<string, unknown>).__activeToolForeignApi;
    delete (globalThis as Record<string, unknown>).__activeToolCatalogDuringRun;
    await rm(root, { recursive: true, force: true });
  });
  const owner = (globalThis as Record<string, any>).__activeToolOwnerApi;
  const foreign = (globalThis as Record<string, any>).__activeToolForeignApi;
  const thread = store.createThread({ threadId: "active-tools-thread", workspaceRoot: root });

  const initialCatalog = await owner.getAllTools({ threadId: thread.threadId });
  assert.equal(initialCatalog.every((tool: { active: boolean }) => tool.active), true);
  assert.deepEqual(initialCatalog.find((tool: { name: string }) => tool.name === "read")?.owner, { kind: "builtin" });
  assert.deepEqual(initialCatalog.find((tool: { name: string }) => tool.name === "host_tool")?.owner, { kind: "host" });
  assert.deepEqual(initialCatalog.find((tool: { name: string }) => tool.name === "owner_switch")?.owner, {
    kind: "extension",
    extensionId: "owner.extension",
    sourcePath: ownerPath,
  });
  initialCatalog[0].description = "mutated";
  assert.notEqual((await owner.getAllTools({ threadId: thread.threadId }))[0]?.description, "mutated");

  assert.deepEqual(await owner.setActiveTools({
    threadId: thread.threadId,
    names: ["owner_switch", "foreign_tool", "read"],
  }), ["owner_switch", "foreign_tool", "read"]);
  assert.deepEqual(await foreign.getActiveTools({ threadId: thread.threadId }), ["owner_switch", "foreign_tool", "read"]);
  assert.deepEqual(
    (await foreign.getAllTools({ threadId: thread.threadId }))
      .filter((tool: { active: boolean }) => tool.active)
      .map((tool: { name: string }) => tool.name),
    ["foreign_tool", "owner_switch", "read"],
  );

  const run = await service.run({
    threadId: thread.threadId,
    prompt: "switch tools",
    provider: provider.id,
    model: "scripted-model",
  });
  assert.equal(run.results[0]?.finalText, "done");
  assert.deepEqual(
    ((globalThis as Record<string, any>).__activeToolCatalogDuringRun as Array<{ name: string; active: boolean }>)
      .filter((tool) => tool.active)
      .map((tool) => tool.name),
    ["foreign_tool", "owner_switch", "read"],
  );
  const requests = provider.capturedRequests();
  assert.deepEqual(requests[0]?.tools.map((tool) => tool.name), ["owner_switch", "foreign_tool", "read"]);
  assert.deepEqual(requests[1]?.tools.map((tool) => tool.name), ["foreign_tool", "read"]);
  assert.ok(requests.every((request) => JSON.stringify(request.messages).includes("ACTIVE_TOOL_PROMPT")));
  assert.equal(requests[1]?.providerState, undefined, "tool fingerprint changes invalidate provider continuation state");
  assert.deepEqual(await owner.getActiveTools({ threadId: thread.threadId }), ["foreign_tool", "read"]);

  const head = store.getThread(thread.threadId).branches.find((branch) => branch.name === "main")?.headEventId;
  assert.ok(head);
  store.forkBranch({ threadId: thread.threadId, newBranch: "experiment", atEventId: head });
  await foreign.setActiveTools({ threadId: thread.threadId, branch: "experiment", names: ["read"] });
  assert.deepEqual(await owner.getActiveTools({ threadId: thread.threadId, branch: "experiment" }), ["read"]);
  assert.deepEqual(await owner.getActiveTools({ threadId: thread.threadId }), ["foreign_tool", "read"]);
  assert.deepEqual(
    (await owner.getAllTools({ threadId: thread.threadId, branch: "experiment" }))
      .filter((tool: { active: boolean }) => tool.active)
      .map((tool: { name: string }) => tool.name),
    ["read"],
  );

  await owner.setActiveTools({ threadId: thread.threadId, names: ["read", "foreign_tool"] });
  await foreign.setActiveTools({ threadId: thread.threadId, names: ["foreign_tool", "read"] });
  assert.deepEqual(await owner.getActiveTools({ threadId: thread.threadId }), ["foreign_tool", "read"]);
  await assert.rejects(owner.setActiveTools({ threadId: thread.threadId, names: ["unloaded_tool"] }), /unavailable tools/u);
  assert.equal(host.diagnostics().some((entry) => entry.message.includes("Active tool update failed")), true);

  await owner.setActiveTools({ threadId: thread.threadId, names: ["bash"] });
  await assert.rejects(service.run({
    threadId: thread.threadId,
    prompt: "must honor exclusion",
    provider: provider.id,
    model: "scripted-model",
    excludedTools: ["bash"],
  }), (error: unknown) => (
    error !== null && typeof error === "object" &&
    (error as { code?: unknown }).code === "EXTENSION_ACTIVE_TOOLS" &&
    String((error as { message?: unknown }).message).includes("allowed/excluded")
  ));

  const otherWorkspace = join(root, "other-workspace");
  const foreignThread = store.createThread({ threadId: "other-workspace-thread", workspaceRoot: otherWorkspace });
  await assert.rejects(owner.getActiveTools({ threadId: foreignThread.threadId }), /belongs to/u);
  await assert.rejects(owner.getAllTools({ threadId: foreignThread.threadId }), /belongs to/u);
  const cancelled = new AbortController();
  cancelled.abort(new Error("cancel catalog query"));
  await assert.rejects(owner.getAllTools({ threadId: thread.threadId, signal: cancelled.signal }), /cancel catalog query/u);
});
