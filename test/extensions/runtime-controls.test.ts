import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadRuntimeExtensions,
  type RuntimeCompactionInput,
  type RuntimeThinkingSelectionInput,
} from "../../src/extensions/runtime.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { ScriptedProvider } from "../../src/testing/scripted-provider.js";
import { sha256 } from "../../src/tools/hash.js";

test("runtime extensions forward bounded compaction and thinking controls", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-bounded-controls-"));
  const sourcePath = join(root, "bounded-controls.mjs");
  const source = `export default (api) => { globalThis.__runtimeBoundedControlsApi = api; };\n`;
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "bounded-controls",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root });
  t.after(async () => {
    await host.close();
    delete (globalThis as Record<string, unknown>).__runtimeBoundedControlsApi;
    await rm(root, { recursive: true, force: true });
  });

  const observed: Array<Record<string, unknown>> = [];
  host.setSessionHandler({
    async compact(input: RuntimeCompactionInput) {
      observed.push({ operation: "compact", ...input });
      return { threadId: input.threadId, branch: input.branch ?? "main", summary: "bounded summary" };
    },
    async setThinking(input: RuntimeThinkingSelectionInput) {
      observed.push({ operation: "thinking", ...input });
      return { provider: "control-provider", model: "control-model", reasoningEffort: input.reasoningEffort };
    },
  } as never);
  const api = (globalThis as Record<string, any>).__runtimeBoundedControlsApi;

  assert.deepEqual(await api.compact({
    threadId: "bounded-thread",
    branch: "review",
    provider: "control-provider",
    model: "control-model",
    reasoningEffort: "low",
    instructions: "Preserve decisions",
    contextTokenBudget: 4_096,
    summaryTokenBudget: 512,
  }), {
    threadId: "bounded-thread",
    branch: "review",
    summary: "bounded summary",
  });
  assert.deepEqual(await api.setThinkingLevel({
    threadId: "bounded-thread",
    branch: "review",
    reasoningEffort: "high",
  }), {
    provider: "control-provider",
    model: "control-model",
    reasoningEffort: "high",
  });

  assert.deepEqual(observed.map(({ signal, ...entry }) => ({
    ...entry,
    signal: signal instanceof AbortSignal,
  })), [{
    operation: "compact",
    threadId: "bounded-thread",
    branch: "review",
    signal: true,
    provider: "control-provider",
    model: "control-model",
    reasoningEffort: "low",
    instructions: "Preserve decisions",
    contextTokenBudget: 4_096,
    summaryTokenBudget: 512,
  }, {
    operation: "thinking",
    threadId: "bounded-thread",
    branch: "review",
    reasoningEffort: "high",
    signal: true,
  }]);
  await assert.rejects(
    api.compact({ threadId: "bounded-thread", contextTokenBudget: 0 }),
    /contextTokenBudget is invalid/u,
  );
  await assert.rejects(
    api.setThinkingLevel({ threadId: "bounded-thread", reasoningEffort: 1 }),
    /thinking level is invalid/u,
  );
});

test("runtime extensions control sessions, messages, selection, queues, and host commands", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-controls-"));
  const sourcePath = join(root, "controls.mjs");
  const source = `export default (api) => {
    globalThis.__runtimeControlsApi = api;
    api.on("agent_start", async (event) => {
      try { await api.waitForIdle({ threadId: event.threadId }); }
      catch (cause) { globalThis.__runtimeWaitForIdleError = cause instanceof Error ? cause.message : String(cause); }
    });
  };\n`;
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "controls",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root });
  const provider = new ScriptedProvider({
    id: "control-provider",
    models: [{ id: "control-model", contextTokens: 100_000, capabilities: { tools: "supported", reasoning: "unsupported" } }],
    scripts: [
      {
        kind: "turn",
        content: [{ type: "text", text: "first" }],
        usage: { inputTokens: 20_000, totalTokens: 20_000 },
        eventDelayMs: 60,
      },
      {
        kind: "turn",
        content: [{ type: "text", text: "steered" }],
        usage: { inputTokens: 30_000, cacheReadTokens: 10_000, totalTokens: 40_000 },
      },
      { kind: "turn", content: [{ type: "text", text: "too late" }], eventDelayMs: 500 },
    ],
  });
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    runtimeExtensions: host,
    projectTrusted: false,
  });
  await service.initialize();
  t.after(async () => {
    await service.close();
    store.close();
    await host.close();
    delete (globalThis as Record<string, unknown>).__runtimeControlsApi;
    delete (globalThis as Record<string, unknown>).__runtimeWaitForIdleError;
    await rm(root, { recursive: true, force: true });
  });

  const focused: string[] = [];
  host.setSessionFocusHandler((session) => { focused.push(`${session.threadId}:${session.branch}`); });
  host.setModelFocusHandler((_target, selection) => { focused.push(`${selection.provider}/${selection.model}`); });
  host.setReloadHandler(async () => ({ warnings: ["reloaded"] }));
  const api = (globalThis as Record<string, any>).__runtimeControlsApi;

  const unavailableShutdown = await api.requestShutdown({ reason: "not owned by this test host" });
  assert.equal(unavailableShutdown.acknowledged, true);
  assert.equal(unavailableShutdown.accepted, false);
  let shutdownRequest: { requestId: string; extensionId: string; reason?: string } | undefined;
  host.setShutdownHandler(async (request) => {
    shutdownRequest = request;
    return { accepted: true, message: "shutdown scheduled" };
  });
  const shutdown = await api.requestShutdown({ reason: "test complete" });
  assert.deepEqual({ acknowledged: shutdown.acknowledged, accepted: shutdown.accepted, message: shutdown.message }, {
    acknowledged: true,
    accepted: true,
    message: "shutdown scheduled",
  });
  assert.equal(shutdownRequest?.requestId, shutdown.requestId);
  assert.equal(shutdownRequest?.extensionId, "controls");
  assert.equal(shutdownRequest?.reason, "test complete");

  const session = await api.newSession({ name: "Controlled" });
  assert.equal(session.name, "Controlled");
  assert.equal(session.branch, "main");
  assert.deepEqual({ active: session.active, operation: session.operation, phase: session.phase }, {
    active: false,
    operation: null,
    phase: "idle",
  });
  assert.equal(session.pendingMessageCount, 0);
  assert.equal(session.recoverableMessageCount, 0);
  assert.deepEqual(focused, [`${session.threadId}:main`]);

  service.setRuntimeModelSelection({
    threadId: session.threadId,
    selection: { provider: provider.id, model: "control-model" },
  });
  assert.deepEqual((await api.getSession({ threadId: session.threadId })).model, {
    provider: provider.id,
    model: "control-model",
  });
  assert.equal(store.getModelSelection(session.threadId), undefined);

  const selected = await api.setModel({
    threadId: session.threadId,
    provider: provider.id,
    model: "control-model",
  });
  assert.deepEqual(selected, { provider: provider.id, model: "control-model" });
  assert.deepEqual(await api.getModel({ threadId: session.threadId }), selected);
  assert.equal(focused.at(-1), `${provider.id}/control-model`);

  const custom = await api.sendMessage({
    threadId: session.threadId,
    schemaVersion: 1,
    kind: "dashboard_status",
    payload: { state: "ready" },
    modelContext: false,
    transcript: { text: "Dashboard ready" },
  });
  assert.equal(custom.kind, "dashboard_status");
  assert.equal(store.listExtensionMessages(session.threadId, "controls", 1, "main").length, 1);

  const running = service.run({
    threadId: session.threadId,
    prompt: "start",
    provider: provider.id,
    model: "control-model",
    systemPrompt: { source: "fixture/system", text: "private system body" },
    appendSystemPrompt: [{ source: "fixture/append", text: "private appended body" }],
    additionalInstructions: { source: "fixture/additional", text: "private additional body" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const activeSnapshot = await api.getSession({ threadId: session.threadId });
  assert.equal(activeSnapshot.active, true);
  assert.equal(activeSnapshot.operation, "run");
  assert.equal(activeSnapshot.phase, "streaming");
  let idleSettled = false;
  const idle = api.waitForIdle({ threadId: session.threadId }).then(() => { idleSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(idleSettled, false);
  const queued = await api.sendUserMessage({
    threadId: session.threadId,
    text: "change direction",
    delivery: "steer",
  });
  assert.deepEqual(queued, {
    threadId: session.threadId,
    branch: "main",
    delivery: "steer",
    queued: true,
  });
  assert.equal((await api.getSession({ threadId: session.threadId })).pendingMessageCount, 1);
  const run = await running;
  await idle;
  assert.equal(run.results.at(-1)?.finalText, "steered");
  assert.equal(provider.callCount, 2);
  assert.match(
    String((globalThis as Record<string, unknown>).__runtimeWaitForIdleError),
    /cannot be called from a lifecycle listener/u,
  );
  const completedSnapshot = await api.getSession({ threadId: session.threadId });
  assert.equal(completedSnapshot.active, false);
  assert.equal(completedSnapshot.operation, null);
  assert.equal(completedSnapshot.phase, "idle");
  assert.deepEqual(completedSnapshot.contextUsage, {
    tokens: 40_000,
    contextWindow: 100_000,
    percent: 40,
    source: "provider_usage",
  });
  assert.ok(completedSnapshot.promptComposition.bytes > 0);
  assert.match(completedSnapshot.promptComposition.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(completedSnapshot.promptComposition.sources.map((entry: { kind: string; source: string }) => [entry.kind, entry.source]), [
    ["system_prompt", "fixture/system"],
    ["append_system_prompt", "fixture/append"],
    ["additional_instructions", "fixture/additional"],
  ]);
  assert.ok(completedSnapshot.promptComposition.tools.includes("read"));
  assert.doesNotMatch(JSON.stringify(completedSnapshot.promptComposition), /private system body|private appended body|private additional body/u);

  const tree = await api.getSessionTree({ threadId: session.threadId });
  assert.ok(tree.some((row: { kind: string; text: string }) => row.kind === "extension" && row.text.includes("Dashboard ready")));
  const target = tree.find((row: { kind: string }) => row.kind === "user");
  assert.ok(target);
  const navigation = await api.navigateSessionTree({
    threadId: session.threadId,
    targetBranch: target.sourceBranch,
    targetEventId: target.eventId,
    newBranch: "controlled-tree",
    summarize: false,
  });
  assert.deepEqual(navigation, { cancelled: false, branch: "controlled-tree" });
  const inspected = await api.getSession({ threadId: session.threadId });
  assert.equal(inspected.model.model, "control-model");

  const command = await api.exec({
    command: process.execPath,
    args: ["--eval", "process.stdout.write('extension-exec')"],
    cwd: ".",
  });
  assert.equal(command.exitCode, 0);
  assert.equal(command.stdout, "extension-exec");

  const cancellable = service.run({
    threadId: session.threadId,
    prompt: "cancel this",
    provider: provider.id,
    model: "control-model",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await api.abort({ threadId: session.threadId, reason: "test cancellation" }), true);
  assert.equal((await cancellable).results.at(-1)?.finishReason, "cancelled");

  const fork = await api.forkSession({ threadId: session.threadId, name: "Controlled copy" });
  assert.equal(fork.name, "Controlled copy");
  assert.notEqual(fork.threadId, session.threadId);
  assert.equal(focused.at(-1), `${fork.threadId}:main`);
  await api.switchSession({ threadId: session.threadId });
  assert.equal(focused.at(-1), `${session.threadId}:main`);
  assert.deepEqual(await api.reload({ threadId: session.threadId }), { warnings: ["reloaded"] });
  assert.equal(await api.abort({ threadId: session.threadId }), false);
});
