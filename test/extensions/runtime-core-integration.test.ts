import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntimeExtensions } from "../../src/extensions/runtime.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { ScriptedProvider, type ScriptedProviderStep } from "../../src/testing/scripted-provider.js";
import { sha256 } from "../../src/tools/hash.js";

const secret = ["sk", "proj", "ABCDEFGHIJKLMNOPQRST"].join("-");

type Cleanup = () => void | Promise<void>;
const cleanupStacks = new WeakMap<object, Cleanup[]>();

function afterCleanup(t: { after(callback: () => Promise<void>): void }, cleanup: Cleanup): void {
  let stack = cleanupStacks.get(t);
  if (stack === undefined) {
    stack = [];
    cleanupStacks.set(t, stack);
    t.after(async () => {
      for (let index = stack!.length - 1; index >= 0; index -= 1) await stack![index]!();
    });
  }
  stack.push(cleanup);
}

async function runtimeFixture(t: { after(callback: () => Promise<void>): void }, source: string) {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-core-"));
  afterCleanup(t, async () => await rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "extension.mjs");
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: "integration",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root });
  afterCleanup(t, async () => await host.close());
  return { root, host };
}

const source = `export default (api) => {
  api.registerTool({
    name: "runtime_echo",
    description: "echo a value",
    inputSchema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } },
    execute(input, context) {
      globalThis.__runtimeCoreExecutions = (globalThis.__runtimeCoreExecutions ?? 0) + 1;
      globalThis.__runtimeToolExecutionIdentity = [context.threadId, context.runId, context.branch];
      return { content: input.value, isError: false, metadata: { phase: "raw" } };
    }
  });
  api.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + "\\nEXTENSION_SYSTEM",
    messages: [{ id: "extension-injected", role: "system", content: [{ type: "text", text: "injected context" }], createdAt: "2026-07-10T00:00:00.000Z" }]
  }));
  api.on("context", (event) => ({ messages: [...event.messages, {
    id: "extension-context-view", role: "system", content: [{ type: "text", text: "context reducer marker" }], createdAt: "2026-07-10T00:00:00.000Z"
  }] }));
  api.on("message_end", (event) => event.message.role === "assistant" ? ({ message: {
    ...event.message,
    content: [...event.message.content, { type: "text", text: ":ended" }],
    displayText: "extension-finalized"
  } }) : undefined);
  api.on("tool_call", (event) => {
    globalThis.__runtimeToolCallIdentity = [event.threadId, event.runId, event.branch];
    if (event.input.value === "explode") throw new Error("tool preflight exploded");
    event.input.value = "patched";
  });
  api.on("tool_result", (event) => ({
    content: event.result.content + ":reduced ${secret}",
    metadata: { phase: "extension", secret: "${secret}" }
  }));
};\n`;

async function serviceFixture(
  t: { after(callback: () => Promise<void>): void },
  scripts: readonly ScriptedProviderStep[],
) {
  const { root, host } = await runtimeFixture(t, source);
  const provider = new ScriptedProvider({
    scripts,
    models: [{ id: "scripted-model", contextTokens: 100_000, capabilities: { tools: "supported" } }],
  });
  const store = new SessionStore(join(root, "sessions.sqlite"));
  afterCleanup(t, () => store.close());
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    runtimeExtensions: host,
    extraTools: host.tools(),
    projectTrusted: false,
  });
  await service.initialize();
  afterCleanup(t, async () => await service.close());
  return { host, provider, store, service };
}

test("runtime prompt, context, message, tool-call, and tool-result reducers are end-to-end and durable-safe", async (t) => {
  (globalThis as Record<string, unknown>).__runtimeCoreExecutions = 0;
  const value = await serviceFixture(t, [
    {
      kind: "turn",
      content: [{ type: "tool_call", id: "call-runtime", name: "runtime_echo", arguments: { value: "original" } }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    { kind: "turn", content: [{ type: "text", text: "done" }] },
  ]);

  const run = await value.service.run({
    prompt: "run the tool",
    provider: value.provider.id,
    model: "scripted-model",
  });

  assert.equal(run.results[0]?.finalText, "done:ended");
  assert.equal((globalThis as Record<string, unknown>).__runtimeCoreExecutions, 1);
  const requests = value.provider.capturedRequests();
  assert.equal(requests.length, 2);
  const firstText = requests[0]!.messages.flatMap((entry) => entry.content)
    .flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
  assert.match(firstText, /EXTENSION_SYSTEM/u);
  assert.match(firstText, /injected context/u);
  assert.match(firstText, /context reducer marker/u);
  const secondWire = JSON.stringify(requests[1]);
  assert.match(secondWire, /patched:reduced \[REDACTED\]/u);
  assert.doesNotMatch(secondWire, /sk-proj-/u);

  const events = value.store.listEvents(run.threadId);
  const started = events.find((entry) => entry.event.type === "run_started");
  assert.deepEqual((globalThis as Record<string, unknown>).__runtimeToolCallIdentity, [run.threadId, started?.runId, "main"]);
  assert.deepEqual((globalThis as Record<string, unknown>).__runtimeToolExecutionIdentity, [run.threadId, started?.runId, "main"]);
  const requestEvent = events.find((entry) => entry.event.type === "tool_requested");
  assert.deepEqual(requestEvent?.event.type === "tool_requested" ? requestEvent.event.input : undefined, { value: "patched" });
  const completed = events.find((entry) => entry.event.type === "tool_completed");
  assert.match(completed?.event.type === "tool_completed" ? completed.event.preview : "", /patched:reduced \[REDACTED\]/u);
  assert.doesNotMatch(JSON.stringify(events), /sk-proj-/u);
  assert.equal(events.some((entry) =>
    entry.event.type === "message_appended" && entry.event.message.id === "extension-injected"), true);
  const assistant = events.filter((entry) => entry.event.type === "message_appended")
    .findLast((entry) => entry.event.type === "message_appended" && entry.event.message.role === "assistant");
  assert.equal(assistant?.event.type === "message_appended" ? assistant.event.message.displayText : undefined, "extension-finalized");
  delete (globalThis as Record<string, unknown>).__runtimeCoreExecutions;
  delete (globalThis as Record<string, unknown>).__runtimeToolCallIdentity;
  delete (globalThis as Record<string, unknown>).__runtimeToolExecutionIdentity;
});

test("a throwing runtime tool-call reducer fails closed and still gives the model a durable error result", async (t) => {
  (globalThis as Record<string, unknown>).__runtimeCoreExecutions = 0;
  const value = await serviceFixture(t, [
    {
      kind: "turn",
      content: [{ type: "tool_call", id: "call-blocked", name: "runtime_echo", arguments: { value: "explode" } }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    { kind: "turn", content: [{ type: "text", text: "blocked safely" }] },
  ]);

  const run = await value.service.run({ prompt: "unsafe", provider: value.provider.id, model: "scripted-model" });
  assert.equal((globalThis as Record<string, unknown>).__runtimeCoreExecutions, 0);
  assert.equal(run.results[0]?.finalText, "blocked safely:ended");
  const request = value.store.listEvents(run.threadId).find((entry) => entry.event.type === "tool_completed");
  assert.equal(request?.event.type === "tool_completed" ? request.event.isError : false, true);
  assert.match(request?.event.type === "tool_completed" ? request.event.preview : "", /tool preflight exploded/u);
  assert.equal(value.host.diagnostics().some((entry) => entry.message.includes("tool preflight exploded")), true);
  delete (globalThis as Record<string, unknown>).__runtimeCoreExecutions;
  delete (globalThis as Record<string, unknown>).__runtimeToolCallIdentity;
  delete (globalThis as Record<string, unknown>).__runtimeToolExecutionIdentity;
});

test("session copy is guarded before any cloned thread is persisted", async (t) => {
  const extension = `export default (api) => {
    api.on("session_before_fork", () => ({ cancel: true, reason: "copy denied" }));
  };\n`;
  const { root, host } = await runtimeFixture(t, extension);
  const store = new SessionStore(join(root, "copy-sessions.sqlite"));
  afterCleanup(t, () => store.close());
  const source = store.createThread({ workspaceRoot: root });
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry(),
    runtimeExtensions: host,
  });
  await service.initialize();
  afterCleanup(t, async () => await service.close());

  await assert.rejects(service.cloneSessionPath({ threadId: source.threadId }), /copy denied/u);
  assert.deepEqual(store.listThreads().map((entry) => entry.threadId), [source.threadId]);
});
