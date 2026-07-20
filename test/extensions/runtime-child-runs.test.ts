import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  ABSOLUTE_CHILD_RUN_LIMITS,
  DEFAULT_CHILD_RUN_POLICY,
  normalizeChildRunPolicy,
  type ChildRunPolicy,
} from "../../src/core/child-runs.js";
import { loadRuntimeExtensions } from "../../src/extensions/runtime.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { ScriptedProvider, type ScriptedProviderStep } from "../../src/testing/scripted-provider.js";
import { sha256 } from "../../src/tools/hash.js";
import type { ToolExecutionBackend } from "../../src/tools/backend.js";

async function fixture(
  t: { after(callback: () => Promise<void>): void },
  source: string,
  scripts: readonly ScriptedProviderStep[],
  options: { toolBackend?: ToolExecutionBackend; childRuns?: Partial<ChildRunPolicy>; extensionId?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-child-"));
  const sourcePath = join(root, "child-extension.mjs");
  await writeFile(sourcePath, source);
  const host = await loadRuntimeExtensions([{
    extensionId: options.extensionId ?? "child-test",
    sourcePath,
    sha256: sha256(source),
  }], { workspace: root });
  const provider = new ScriptedProvider({
    id: "child-provider",
    models: [{ id: "child-model", contextTokens: 100_000, capabilities: { tools: "supported" } }],
    scripts,
  });
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const service = new HarnessService({
    store,
    workspace: root,
    providers: new ProviderRegistry([provider]),
    runtimeExtensions: host,
    extraTools: host.tools(),
    ...(options.toolBackend === undefined ? {} : { toolBackend: options.toolBackend }),
    ...(options.childRuns === undefined ? {} : { childRuns: options.childRuns }),
    projectTrusted: false,
  });
  await service.initialize();
  t.after(async () => {
    await service.close();
    store.close();
    await host.close();
    delete (globalThis as Record<string, unknown>).__runtimeChildApi;
    await rm(root, { recursive: true, force: true });
  });
  return { root, host, provider, service, store };
}

test("child-run policy keeps compatibility defaults and rejects unsafe or inconsistent values", () => {
  assert.deepEqual(normalizeChildRunPolicy(undefined), DEFAULT_CHILD_RUN_POLICY);
  assert.throws(
    () => normalizeChildRunPolicy({ maxConcurrent: ABSOLUTE_CHILD_RUN_LIMITS.maxConcurrent + 1 }),
    /childRuns\.maxConcurrent must be a safe integer from 1 through 16/u,
  );
  assert.throws(
    () => normalizeChildRunPolicy({ maxSteps: ABSOLUTE_CHILD_RUN_LIMITS.maxSteps + 1 }),
    /childRuns\.maxSteps must be a safe integer from 1 through 256/u,
  );
  assert.throws(
    () => normalizeChildRunPolicy({ maxTimeoutMs: ABSOLUTE_CHILD_RUN_LIMITS.maxTimeoutMs + 1 }),
    /childRuns\.maxTimeoutMs must be a safe integer from 1 through 3600000/u,
  );
  assert.throws(
    () => normalizeChildRunPolicy({ maxOutputLimitBytes: ABSOLUTE_CHILD_RUN_LIMITS.maxOutputLimitBytes + 1 }),
    /childRuns\.maxOutputLimitBytes must be a safe integer from 1 through 8388608/u,
  );
  assert.throws(
    () => normalizeChildRunPolicy({ defaultMaxSteps: 5, maxSteps: 4 }),
    /defaultMaxSteps must not exceed childRuns\.maxSteps/u,
  );
  assert.throws(
    () => normalizeChildRunPolicy({ defaultTimeoutMs: 2, maxTimeoutMs: 1 }),
    /defaultTimeoutMs must not exceed childRuns\.maxTimeoutMs/u,
  );
  assert.throws(
    () => normalizeChildRunPolicy({ defaultOutputLimitBytes: 2, maxOutputLimitBytes: 1 }),
    /defaultOutputLimitBytes must not exceed childRuns\.maxOutputLimitBytes/u,
  );
});

test("configured child-run defaults and maxima govern extension-requested runs", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const value = await fixture(t, source, [
    { kind: "turn", content: [{ type: "text", text: "123456789" }] },
    { kind: "turn", content: [{ type: "text", text: "abcdefgh" }] },
  ], {
    childRuns: {
      maxConcurrent: 2,
      defaultMaxSteps: 2,
      maxSteps: 3,
      defaultTimeoutMs: 1_000,
      maxTimeoutMs: 2_000,
      defaultOutputLimitBytes: 5,
      maxOutputLimitBytes: 8,
    },
  });
  const parent = await value.service.createSession();
  value.store.appendEvent({
    threadId: parent.threadId,
    event: { type: "model_selected", provider: value.provider.id, model: "child-model" },
  });
  const api = (globalThis as Record<string, any>).__runtimeChildApi;

  for (const [field, selected, expected] of [
    ["maxSteps", 4, /configured maximum of 3/u],
    ["timeoutMs", 2_001, /configured maximum of 2000/u],
    ["outputLimitBytes", 9, /configured maximum of 8/u],
  ] as const) {
    await assert.rejects(api.runChild({
      threadId: parent.threadId,
      prompt: `reject excessive ${field}`,
      context: "fresh",
      tools: ["read"],
      [field]: selected,
    }), expected);
  }

  const atMaximum = await api.runChild({
    threadId: parent.threadId,
    prompt: "accept configured maxima",
    context: "fresh",
    tools: ["read"],
    maxSteps: 3,
    timeoutMs: 2_000,
    outputLimitBytes: 8,
  });
  assert.equal(atMaximum.finalText, "12345678");
  assert.equal(atMaximum.truncated, true);

  const withDefaults = await api.runChild({
    threadId: parent.threadId,
    prompt: "use configured defaults",
    context: "fresh",
    tools: ["read"],
  });
  assert.equal(withDefaults.finalText, "abcde");
  assert.equal(withDefaults.truncated, true);
  assert.equal(value.provider.callCount, 2);
});

test("child runs accept bounded replacement and appended instructions while retaining the delegation invariant", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const value = await fixture(t, source, [
    { kind: "turn", content: [{ type: "text", text: "instruction probe complete" }] },
  ]);
  const parent = await value.service.createSession();
  value.store.appendEvent({
    threadId: parent.threadId,
    event: { type: "model_selected", provider: value.provider.id, model: "child-model" },
  });
  const api = (globalThis as Record<string, any>).__runtimeChildApi;

  await api.runChild({
    threadId: parent.threadId,
    prompt: "inspect child instructions",
    context: "fresh",
    tools: [],
    systemPrompt: "CHILD_REPLACEMENT_INSTRUCTIONS",
    appendSystemPrompt: "CHILD_APPENDED_INSTRUCTIONS",
  });
  const wire = JSON.stringify(value.provider.capturedRequests()[0]?.messages);
  assert.match(wire, /CHILD_REPLACEMENT_INSTRUCTIONS/u);
  assert.match(wire, /CHILD_APPENDED_INSTRUCTIONS/u);
  assert.match(wire, /Do not start or delegate another child run/u);
  assert.doesNotMatch(wire, /You are an expert coding assistant/u);

  for (const [field, selected, expected] of [
    ["systemPrompt", "", /systemPrompt is invalid/u],
    ["appendSystemPrompt", "bad\0value", /appendSystemPrompt is invalid/u],
    ["appendSystemPrompt", "x".repeat(64 * 1024 + 1), /exceeds 65536 bytes/u],
  ] as const) {
    await assert.rejects(api.runChild({
      threadId: parent.threadId,
      prompt: "reject invalid child instructions",
      context: "fresh",
      tools: [],
      [field]: selected,
    }), expected);
  }
  assert.equal(value.provider.callCount, 1);
});

test("runtime child admission deduplicates requester metadata and skips root branch histories", async (t) => {
  const source = `export default (api) => {
    api.registerTool({
      name: "probe_child_admission",
      description: "Probe child admission",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      async execute(_input, context) {
        globalThis.__childAdmissionProbe.start();
        try {
          await api.runChild({
            threadId: context.threadId,
            branch: context.branch,
            prompt: "reject before child creation",
            context: "fresh",
            tools: [],
            maxSteps: 2
          });
        } catch (error) {
          globalThis.__childAdmissionError = error instanceof Error ? error.message : String(error);
        } finally {
          globalThis.__childAdmissionProbe.stop();
        }
        return { content: "admission checked", isError: false };
      }
    });
  };\n`;
  const value = await fixture(t, source, [
    {
      kind: "turn",
      content: [{ type: "tool_call", id: "probe-admission", name: "probe_child_admission", arguments: {} }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    { kind: "turn", content: [{ type: "text", text: "parent complete" }] },
  ], { childRuns: { defaultMaxSteps: 1, maxSteps: 1 } });

  let probing = false;
  let workspaceBindings = 0;
  let branchHistoryReads = 0;
  (globalThis as Record<string, unknown>).__childAdmissionProbe = {
    start() { probing = true; },
    stop() { probing = false; },
  };
  t.after(() => {
    delete (globalThis as Record<string, unknown>).__childAdmissionProbe;
    delete (globalThis as Record<string, unknown>).__childAdmissionError;
  });
  const bindThreadWorkspace = value.store.bindThreadWorkspace.bind(value.store);
  value.store.bindThreadWorkspace = (threadId, workspaceRoot) => {
    if (probing) workspaceBindings += 1;
    return bindThreadWorkspace(threadId, workspaceRoot);
  };
  const listEvents = value.store.listEvents.bind(value.store);
  value.store.listEvents = (threadId, branch) => {
    if (probing) branchHistoryReads += 1;
    return listEvents(threadId, branch);
  };

  const run = await value.service.run({
    prompt: "probe child admission",
    provider: value.provider.id,
    model: "child-model",
    allowedTools: ["probe_child_admission"],
  });

  assert.equal(run.results.at(-1)?.finalText, "parent complete");
  assert.match(String((globalThis as Record<string, unknown>).__childAdmissionError), /configured maximum of 1/u);
  assert.equal(workspaceBindings, 2);
  assert.equal(branchHistoryReads, 0);
});

test("active child runs reject queued turns so the step ceiling covers the whole operation", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const value = await fixture(t, source, [{
    kind: "turn",
    content: [{ type: "text", text: "one bounded child turn" }],
    eventDelayMs: 100,
  }]);
  const parent = await value.service.createSession();
  value.store.appendEvent({
    threadId: parent.threadId,
    event: { type: "model_selected", provider: value.provider.id, model: "child-model" },
  });
  const api = (globalThis as Record<string, any>).__runtimeChildApi;
  let announceStart!: (session: { threadId: string; branch: string }) => void;
  const started = new Promise<{ threadId: string; branch: string }>((resolve) => { announceStart = resolve; });
  const running = api.runChild({
    threadId: parent.threadId,
    prompt: "stay within one operation budget",
    context: "fresh",
    tools: [],
    maxSteps: 1,
    onStart: announceStart,
  });
  const child = await started;
  await assert.rejects(api.sendUserMessage({
    threadId: child.threadId,
    branch: child.branch,
    delivery: "follow_up",
    text: "attempt another bounded turn",
  }), /do not accept steering or follow-up messages/u);
  const result = await running;
  assert.equal(result.status, "success");
  assert.equal(result.steps, 1);
  assert.equal(value.provider.callCount, 1);
});

test("runtime child runs use the active service, explicit tools, bounded output, and session retention", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const value = await fixture(t, source, [
    {
      kind: "turn",
      content: [{ type: "text", text: "ephemeral-output" }],
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 0 },
    },
    {
      kind: "turn",
      content: [{ type: "text", text: "persisted-output" }],
      usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
    },
  ]);
  const parent = await value.service.createSession({ name: "parent" });
  value.store.appendEvent({
    threadId: parent.threadId,
    event: { type: "model_selected", provider: value.provider.id, model: "child-model" },
  });
  const api = (globalThis as Record<string, any>).__runtimeChildApi;

  const ephemeral = await api.runChild({
    threadId: parent.threadId,
    prompt: "finish the bounded task",
    context: "fresh",
    tools: ["read"],
    outputLimitBytes: 9,
  });
  assert.deepEqual({
    status: ephemeral.status,
    finalText: ephemeral.finalText,
    truncated: ephemeral.truncated,
    persisted: ephemeral.persisted,
  }, {
    status: "success",
    finalText: "ephemeral",
    truncated: true,
    persisted: false,
  });
  assert.deepEqual(value.store.listThreads({ workspaceRoot: value.root }).map((thread) => thread.threadId), [parent.threadId]);
  assert.deepEqual(value.provider.capturedRequests()[0]?.tools.map((tool) => tool.name), ["read"]);
  assert.deepEqual(ephemeral.usage, {
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    cacheReadTokens: 0,
  });
  assert.deepEqual(ephemeral.artifacts, []);
  assert.deepEqual(ephemeral.execution, {
    backend: "local",
    required: false,
    routedTools: [],
    localTools: ["read"],
  });

  const kept = await api.runChild({
    threadId: parent.threadId,
    prompt: "keep this child",
    context: "fresh",
    tools: ["read", "grep"],
    session: "persisted",
  });
  assert.equal(kept.status, "success");
  assert.equal(kept.finalText, "persisted-output");
  assert.equal(kept.persisted, true);
  const retained = value.store.getThread(kept.threadId);
  assert.equal(retained.parentThreadId, parent.threadId);
  assert.deepEqual(value.provider.capturedRequests()[1]?.tools.map((tool) => tool.name), ["grep", "read"]);

  await assert.rejects(api.runChild({
    threadId: parent.threadId,
    prompt: "cannot run",
    context: "fresh",
    tools: ["missing_tool"],
  }), /unavailable tools: missing_tool/u);
  assert.equal(value.provider.callCount, 2);
});

test("runtime child runs accept an explicit empty tool allowlist", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const value = await fixture(t, source, [{
    kind: "turn",
    content: [{ type: "text", text: "review complete" }],
  }]);
  const parent = await value.service.createSession();
  value.store.appendEvent({
    threadId: parent.threadId,
    event: { type: "model_selected", provider: value.provider.id, model: "child-model" },
  });

  const api = (globalThis as Record<string, any>).__runtimeChildApi;
  const result = await api.runChild({
    threadId: parent.threadId,
    prompt: "review without tools",
    context: "fresh",
    tools: [],
  });

  assert.equal(result.status, "success");
  assert.equal(result.finalText, "review complete");
  assert.deepEqual(value.provider.capturedRequests()[0]?.tools, []);
});

test("runtime child runs select the host backend explicitly and fail closed when required routing is incomplete", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const routed: string[] = [];
  const backend: ToolExecutionBackend = {
    id: "sandbox-fixture",
    handles(name) { return name === "read"; },
    resources() { return [{ kind: "workspace", key: "sandbox", mode: "read" }]; },
    async execute(request) {
      routed.push(request.invocation.name);
      return { content: "backend read", isError: false, status: "success", summary: "backend read" };
    },
  };
  const value = await fixture(t, source, [
    {
      kind: "turn",
      content: [{ type: "tool_call", id: "read-through-backend", name: "read", arguments: { path: "README.md" } }],
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      terminal: { type: "finish", reason: "tool_calls" },
    },
    {
      kind: "turn",
      content: [{ type: "text", text: "backend complete" }],
      usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9, cacheReadTokens: 0 },
    },
  ], { toolBackend: backend });
  const parent = await value.service.createSession();
  value.store.appendEvent({
    threadId: parent.threadId,
    event: { type: "model_selected", provider: value.provider.id, model: "child-model" },
  });
  const api = (globalThis as Record<string, any>).__runtimeChildApi;

  const result = await api.runChild({
    threadId: parent.threadId,
    prompt: "read through the selected backend",
    context: "fresh",
    tools: ["read"],
    execution: { backend: "inherit", backendId: "sandbox-fixture", requireAllTools: true },
  });
  assert.equal(result.status, "success");
  assert.deepEqual(result.model, { provider: value.provider.id, model: "child-model" });
  assert.deepEqual(result.execution, {
    backend: "host",
    backendId: "sandbox-fixture",
    required: true,
    routedTools: ["read"],
    localTools: [],
  });
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    outputTokens: 3,
    totalTokens: 15,
    cacheReadTokens: 0,
  });
  assert.deepEqual(routed, ["read"]);

  await assert.rejects(api.runChild({
    threadId: parent.threadId,
    prompt: "must route all tools",
    context: "fresh",
    tools: ["read", "grep"],
    execution: { backend: "inherit", requireAllTools: true },
  }), /not routed: grep/u);
  await assert.rejects(api.runChild({
    threadId: parent.threadId,
    prompt: "wrong backend",
    context: "fresh",
    tools: ["read"],
    execution: { backend: "inherit", backendId: "missing-backend" },
  }), /unavailable execution backend/u);
  await assert.rejects(api.runChild({
    threadId: parent.threadId,
    prompt: "invalid local selection",
    context: "fresh",
    tools: ["read"],
    execution: { backend: "local", backendId: "sandbox-fixture" },
  }), /local execution cannot select or require a backend/u);
  await assert.rejects(api.runChild({
    threadId: parent.threadId,
    prompt: "unknown execution field",
    context: "fresh",
    tools: ["read"],
    execution: { backend: "inherit", fallback: true },
  }), /unknown or owner-controlled field/u);
  assert.equal(value.provider.callCount, 2);
});

test("runtime child results expose bounded artifact metadata without retaining ephemeral content", async (t) => {
  const source = `export default (api) => {
    globalThis.__runtimeChildApi = api;
    api.registerTool({
      name: "make_artifact",
      description: "Create a small artifact",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      validate() {},
      resources() { return [{ kind: "session", key: "artifact", mode: "write" }]; },
      async execute(_input, context) {
        const artifact = await context.artifacts.write(
          "report.txt",
          "text/plain",
          [Buffer.from("child artifact")],
          context.signal,
        );
        return { content: "artifact created", isError: false, artifacts: [artifact] };
      }
    });
  };\n`;
  const value = await fixture(t, source, [
    {
      kind: "turn",
      content: [{ type: "tool_call", id: "artifact-call", name: "make_artifact", arguments: {} }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    { kind: "turn", content: [{ type: "text", text: "artifact complete" }] },
  ]);
  const parent = await value.service.createSession();
  value.store.appendEvent({
    threadId: parent.threadId,
    event: { type: "model_selected", provider: value.provider.id, model: "child-model" },
  });
  const api = (globalThis as Record<string, any>).__runtimeChildApi;

  const result = await api.runChild({
    threadId: parent.threadId,
    prompt: "create one artifact",
    context: "fresh",
    tools: ["make_artifact"],
    execution: { backend: "local" },
  });
  assert.equal(result.status, "success");
  assert.equal(result.artifactCount, 1);
  assert.equal(result.artifactsTruncated, false);
  assert.deepEqual(result.artifacts.map((artifact: { mediaType: string; bytes: number; retained: boolean }) => ({
    mediaType: artifact.mediaType,
    bytes: artifact.bytes,
    retained: artifact.retained,
  })), [{ mediaType: "text/plain", bytes: 14, retained: false }]);
  assert.match(result.artifacts[0].sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(value.store.listThreads({ workspaceRoot: value.root }).map((thread) => thread.threadId), [parent.threadId]);
});

test("forked child context excludes the in-flight delegation call and recursive child runs stay blocked", async (t) => {
  const source = `export default (api) => {
    let rootThreadId;
    api.registerTool({
      name: "delegate_child",
      description: "Run one bounded child task",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      async execute(_input, context) {
        rootThreadId ??= context.threadId;
        const result = await api.runChild({
          threadId: rootThreadId,
          prompt: "inspect the delegated task",
          context: "fork",
          tools: ["delegate_child"],
          maxSteps: 3
        });
        globalThis.__runtimeChildResult = result;
        return { content: JSON.stringify(result), isError: result.status === "error" };
      }
    });
  };\n`;
  const value = await fixture(t, source, [
    {
      kind: "turn",
      content: [{ type: "tool_call", id: "parent-delegate", name: "delegate_child", arguments: {} }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    {
      kind: "turn",
      content: [{ type: "tool_call", id: "child-delegate", name: "delegate_child", arguments: {} }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    { kind: "turn", content: [{ type: "text", text: "child stopped recursion" }] },
    { kind: "turn", content: [{ type: "text", text: "parent complete" }] },
  ]);

  const run = await value.service.run({
    prompt: "delegate this request",
    provider: value.provider.id,
    model: "child-model",
  });
  assert.equal(run.results.at(-1)?.finalText, "parent complete");
  assert.equal(value.provider.callCount, 4);
  const childRequest = value.provider.capturedRequests()[1]!;
  const childMessageText = childRequest.messages.flatMap((message) => message.content)
    .flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
  assert.match(childMessageText, /delegate this request/u);
  assert.match(childMessageText, /inspect the delegated task/u);
  assert.equal(childRequest.messages.some((message) => message.content.some((block) =>
    block.type === "tool_call" && block.name === "delegate_child")), false);
  const nestedFailure = value.store.listEvents(run.threadId).find((event) =>
    event.event.type === "tool_completed" && event.event.callId === "parent-delegate");
  assert.equal(nestedFailure?.event.type === "tool_completed" ? nestedFailure.event.isError : true, false);
  assert.deepEqual(value.store.listThreads({ workspaceRoot: value.root }).map((thread) => thread.threadId), [run.threadId]);
  delete (globalThis as Record<string, unknown>).__runtimeChildResult;
});

test("child lifecycle listeners cannot target the root to bypass disabled nesting", async (t) => {
  const source = `export default (api) => {
    let rootThreadId;
    let attempted = false;
    api.on("agent_start", async (event) => {
      if (rootThreadId === undefined || event.threadId === rootThreadId || attempted) return;
      attempted = true;
      try {
        await api.runChild({
          threadId: rootThreadId,
          prompt: "nested listener delegation",
          context: "fresh",
          tools: []
        });
        globalThis.__runtimeChildListenerNesting = "nested child unexpectedly ran";
      } catch (error) {
        globalThis.__runtimeChildListenerNesting = error instanceof Error ? error.message : String(error);
      }
    });
    api.registerTool({
      name: "listener_child",
      description: "Run a child observed by the lifecycle listener",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      async execute(_input, context) {
        rootThreadId = context.threadId;
        const result = await api.runChild({
          threadId: rootThreadId,
          prompt: "primary child delegation",
          context: "fresh",
          tools: []
        });
        return { content: result.finalText, isError: result.status !== "success" };
      }
    });
  };\n`;
  const value = await fixture(t, source, [
    {
      kind: "turn",
      content: [{ type: "tool_call", id: "listener-child", name: "listener_child", arguments: {} }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    { kind: "turn", content: [{ type: "text", text: "primary child complete" }] },
    { kind: "turn", content: [{ type: "text", text: "parent complete" }] },
  ]);

  const run = await value.service.run({
    prompt: "delegate with a child listener",
    provider: value.provider.id,
    model: "child-model",
    allowedTools: ["listener_child"],
  });

  assert.equal(run.results.at(-1)?.finalText, "parent complete");
  assert.match(
    String((globalThis as Record<string, unknown>).__runtimeChildListenerNesting),
    /Nested runtime child runs are disabled/u,
  );
  assert.equal(value.provider.callCount, 3);
  assert.deepEqual(value.store.listThreads({ workspaceRoot: value.root }).map((thread) => thread.threadId), [run.threadId]);
  delete (globalThis as Record<string, unknown>).__runtimeChildListenerNesting;
});

test("all host-owned child boundaries retain child requester identity from session creation onward", async (t) => {
  const source = `export default (api) => {
    let rootThreadId;
    const probes = {};
    const pending = [];
    const probe = (name, threadId) => {
      if (rootThreadId === undefined || threadId === rootThreadId || probes[name] !== undefined) return;
      probes[name] = "pending";
      const attempt = api.runChild({
        threadId: rootThreadId,
        prompt: "nested delegation from " + name,
        context: "fresh",
        tools: []
      }).then(
        () => { probes[name] = "nested child unexpectedly ran"; },
        (error) => { probes[name] = error instanceof Error ? error.message : String(error); }
      );
      pending.push(attempt);
      return attempt;
    };
    api.on("session_before_fork", (event) => probe("session_before_fork", event.targetThreadId));
    api.on("session_start", (event) => probe("session_start", event.threadId));
    api.on("model_select", (event) => probe("model_select", event.threadId));
    api.on("thinking_level_select", (event) => probe("thinking_level_select", event.threadId));
    api.on("event", (event) => probe("event", event.threadId));
    api.registerTool({
      name: "probe_child_boundaries",
      description: "Probe requester identity across child boundaries",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      async execute(_input, context) {
        rootThreadId = context.threadId;
        const result = await api.runChild({
          threadId: rootThreadId,
          prompt: "primary boundary probe child",
          context: "fresh",
          tools: [],
          onStart(session) { probe("onStart", session.threadId); },
          onEvent(event) { probe("onEvent", event.threadId); }
        });
        await Promise.allSettled(pending);
        globalThis.__runtimeChildBoundaryProbes = probes;
        return { content: result.finalText, isError: result.status !== "success" };
      }
    });
  };\n`;
  const value = await fixture(t, source, [
    {
      kind: "turn",
      content: [{ type: "tool_call", id: "probe-boundaries", name: "probe_child_boundaries", arguments: {} }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    { kind: "turn", content: [{ type: "text", text: "primary boundary child complete" }] },
    { kind: "turn", content: [{ type: "text", text: "boundary parent complete" }] },
  ]);

  const run = await value.service.run({
    prompt: "probe every child boundary",
    provider: value.provider.id,
    model: "child-model",
    reasoningEffort: "high",
    allowedTools: ["probe_child_boundaries"],
  });

  assert.equal(run.results.at(-1)?.finalText, "boundary parent complete");
  const probes = (globalThis as Record<string, any>).__runtimeChildBoundaryProbes;
  for (const name of ["session_before_fork", "session_start", "model_select", "thinking_level_select", "event", "onStart", "onEvent"]) {
    assert.match(String(probes[name]), /Nested runtime child runs are disabled/u, name);
  }
  assert.equal(value.provider.callCount, 3);
  assert.deepEqual(value.store.listThreads({ workspaceRoot: value.root }).map((thread) => thread.threadId), [run.threadId]);
  delete (globalThis as Record<string, unknown>).__runtimeChildBoundaryProbes;
});

test("runtime children expose identity before provider work and stream safe events through the native tool row", async (t) => {
  const source = `export default (api) => {
    api.registerTool({
      name: "native_child",
      description: "Run one visible in-process child",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      async execute(_input, context) {
        const trace = { order: [], events: [], session: undefined };
        globalThis.__nativeChildTrace = trace;
        const visible = [];
        const result = await api.runChild({
          threadId: context.threadId,
          branch: context.branch,
          prompt: "complete the visible child task",
          context: "fresh",
          tools: ["read"],
          onStart(session) {
            trace.order.push("start");
            trace.session = session;
            context.reportProgress({
              type: "result",
              content: "Child started",
              isError: false,
              metadata: { threadId: session.threadId, branch: session.branch, state: "running" }
            });
          },
          onEvent(update) {
            trace.order.push(update.event.type);
            trace.events.push(update);
            if (update.event.type === "text_delta") visible.push(update.event.text);
            if (update.event.type === "reasoning_delta") visible.push(update.event.text);
            context.reportProgress({
              type: "result",
              content: visible.join("") || "Child running",
              isError: false,
              metadata: { threadId: update.threadId, event: update.event.type, sequence: update.sequence }
            });
          }
        });
        return {
          content: result.finalText,
          isError: result.status === "error",
          status: result.status === "error" ? "error" : "success",
          summary: result.summary,
          nextActions: result.nextActions,
          metadata: { childThreadId: result.threadId, childStatus: result.status }
        };
      }
    });
  };\n`;
  const value = await fixture(t, source, [
    {
      kind: "turn",
      content: [{ type: "tool_call", id: "parent-native-child", name: "native_child", arguments: {} }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    {
      kind: "turn",
      content: [
        { type: "reasoning", text: "private trace", visibility: "provider_trace" },
        { type: "reasoning", text: "visible plan", visibility: "summary" },
        { type: "text", text: "child complete" },
      ],
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 19, cacheReadTokens: 3 },
      eventDelayMs: 2,
    },
    { kind: "turn", content: [{ type: "text", text: "parent continued" }] },
  ]);

  const run = await value.service.run({
    prompt: "delegate visibly",
    provider: value.provider.id,
    model: "child-model",
    allowedTools: ["native_child", "read"],
  });
  assert.equal(run.results.at(-1)?.finalText, "parent continued");
  assert.equal(value.provider.callCount, 3);

  const trace = (globalThis as Record<string, any>).__nativeChildTrace;
  assert.ok(trace.session.threadId);
  assert.equal(trace.order[0], "start");
  assert.equal(trace.events.some((entry: any) =>
    entry.event.type === "reasoning_delta" && entry.event.visibility === "provider_trace"), false);
  assert.equal(trace.events.some((entry: any) =>
    entry.event.type === "reasoning_delta" && entry.event.visibility === "summary"), true);
  assert.equal(trace.events.some((entry: any) => entry.event.type === "text_delta"), true);

  const progress = value.store.listEvents(run.threadId).filter((entry) =>
    entry.event.type === "tool_progress" && entry.event.callId === "parent-native-child");
  assert.ok(progress.length > 1);
  assert.equal(progress.every((entry) => entry.event.type === "tool_progress" && entry.event.progress.type === "result"), true);
  const lastProgress = progress.at(-1)?.event;
  assert.equal(
    lastProgress?.type === "tool_progress" && lastProgress.progress.type === "result"
      ? lastProgress.progress.content.includes("child complete")
      : false,
    true,
  );
  assert.deepEqual(value.store.listThreads({ workspaceRoot: value.root }).map((thread) => thread.threadId), [run.threadId]);
  delete (globalThis as Record<string, unknown>).__nativeChildTrace;
});

test("omitted child limits allow more than eight model turns and the parent continues", async (t) => {
  const source = `export default (api) => {
    api.registerTool({
      name: "default_limit_child",
      description: "Exercise the default child turn budget",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      async execute(_input, context) {
        const result = await api.runChild({
          threadId: context.threadId,
          branch: context.branch,
          prompt: "inspect the extension across nine tool turns",
          context: "fresh",
          tools: ["read"],
          signal: context.signal
        });
        globalThis.__defaultLimitChildResult = result;
        return {
          content: result.finalText,
          isError: result.status !== "success",
          summary: result.summary,
          nextActions: result.nextActions
        };
      }
    });
  };\n`;
  const childToolTurns = Array.from({ length: 9 }, (_entry, index) => ({
    kind: "turn" as const,
    content: [{
      type: "tool_call" as const,
      id: `child-read-${index}`,
      name: "read",
      arguments: { path: "child-extension.mjs", offset: 1, limit: 1 },
    }],
    terminal: { type: "finish" as const, reason: "tool_calls" as const },
  }));
  const value = await fixture(t, source, [
    {
      kind: "turn",
      content: [{ type: "tool_call", id: "parent-default-child", name: "default_limit_child", arguments: {} }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    ...childToolTurns,
    { kind: "turn", content: [{ type: "text", text: "child completed after nine tool turns" }] },
    { kind: "turn", content: [{ type: "text", text: "parent continued after child" }] },
  ]);

  const run = await value.service.run({
    prompt: "delegate a longer coding task",
    provider: value.provider.id,
    model: "child-model",
    allowedTools: ["default_limit_child", "read"],
  });
  const child = (globalThis as Record<string, any>).__defaultLimitChildResult;

  assert.equal(child.status, "success");
  assert.equal(child.steps, 10);
  assert.equal(child.finalText, "child completed after nine tool turns");
  assert.equal(run.results.at(-1)?.finalText, "parent continued after child");
  assert.equal(value.provider.callCount, 12);
  assert.deepEqual(value.store.listThreads({ workspaceRoot: value.root }).map((thread) => thread.threadId), [run.threadId]);
  delete (globalThis as Record<string, unknown>).__defaultLimitChildResult;
});

test("runtime child onStart can immediately abort the reserved child session", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const value = await fixture(t, source, [
    { kind: "turn", content: [{ type: "text", text: "must not complete" }], eventDelayMs: 200 },
  ]);
  const parent = await value.service.createSession();
  value.store.appendEvent({
    threadId: parent.threadId,
    event: { type: "model_selected", provider: value.provider.id, model: "child-model" },
  });
  const api = (globalThis as Record<string, any>).__runtimeChildApi;
  let started: { threadId: string; branch: string } | undefined;
  let abortResult: Promise<boolean> | undefined;

  const result = await api.runChild({
    threadId: parent.threadId,
    prompt: "cancel immediately",
    context: "fresh",
    tools: ["read"],
    onStart(session: { threadId: string; branch: string }) {
      started = session;
      abortResult = api.abort({
        threadId: session.threadId,
        branch: session.branch,
        reason: "cancelled from onStart",
      });
    },
  });

  assert.ok(started?.threadId);
  assert.equal(await abortResult, true);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(value.store.listThreads({ workspaceRoot: value.root }).map((thread) => thread.threadId), [parent.threadId]);
});

test("runtime child callbacks remain non-blocking and consume accidental async rejection", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const value = await fixture(t, source, [
    { kind: "turn", content: [{ type: "text", text: "child completed" }] },
  ]);
  const parent = await value.service.createSession();
  value.store.appendEvent({
    threadId: parent.threadId,
    event: { type: "model_selected", provider: value.provider.id, model: "child-model" },
  });
  const api = (globalThis as Record<string, any>).__runtimeChildApi;
  let startCalls = 0;
  let eventCalls = 0;

  const result = await api.runChild({
    threadId: parent.threadId,
    prompt: "finish despite observer failures",
    context: "fresh",
    tools: ["read"],
    async onStart() {
      startCalls += 1;
      await Promise.resolve();
      throw new Error("async onStart failed");
    },
    async onEvent() {
      eventCalls += 1;
      await Promise.resolve();
      throw new Error("async onEvent failed");
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(result.status, "success");
  assert.equal(result.finalText, "child completed");
  assert.equal(startCalls, 1);
  assert.ok(eventCalls > 0);
});

test("persisted runtime children remain classified when startup fails before run_started", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const value = await fixture(t, source, []);
  const parent = await value.service.createSession();
  const api = (globalThis as Record<string, any>).__runtimeChildApi;
  let releaseOnStart!: () => void;
  const onStartGate = new Promise<void>((resolve) => { releaseOnStart = resolve; });
  let settleNestedAttempt!: (message: string) => void;
  const nestedAttempt = new Promise<string>((resolve) => { settleNestedAttempt = resolve; });
  let onStartCalls = 0;

  const child = await api.runChild({
    threadId: parent.threadId,
    prompt: "fail before provider work",
    context: "fresh",
    tools: [],
    provider: "missing-provider",
    model: "missing-model",
    session: "persisted",
    async onStart() {
      onStartCalls += 1;
      await onStartGate;
      try {
        await api.runChild({
          threadId: parent.threadId,
          prompt: "nested delegation after failed child cleanup",
          context: "fresh",
          tools: [],
          provider: value.provider.id,
          model: "child-model",
        });
        settleNestedAttempt("nested child unexpectedly ran");
      } catch (error) {
        settleNestedAttempt(error instanceof Error ? error.message : String(error));
      }
    },
  });

  assert.equal(child.status, "error");
  assert.equal(child.persisted, true);
  assert.equal(onStartCalls, 1);
  assert.match(child.error, /Provider adapter is not registered: missing-provider/u);
  assert.equal(value.store.listEvents(child.threadId, child.branch).some((entry) => entry.event.type === "run_started"), false);

  releaseOnStart();
  assert.match(await nestedAttempt, /Nested runtime child runs are disabled/u);
  assert.equal(value.provider.callCount, 0);
});

test("persisted runtime children remain classified after their parent is deleted", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const value = await fixture(t, source, [
    { kind: "turn", content: [{ type: "text", text: "persisted child complete" }] },
    { kind: "turn", content: [{ type: "text", text: "nested child unexpectedly ran" }] },
  ]);
  const parent = await value.service.createSession();
  const api = (globalThis as Record<string, any>).__runtimeChildApi;
  const child = await api.runChild({
    threadId: parent.threadId,
    prompt: "create a persisted child",
    context: "fresh",
    tools: [],
    provider: value.provider.id,
    model: "child-model",
    session: "persisted",
  });

  assert.equal(child.status, "success");
  await value.service.deleteSession(parent.threadId);
  assert.equal(value.store.getThread(child.threadId).parentThreadId, undefined);
  assert.equal(value.store.hasRuntimeChildThread(child.threadId), true);

  await assert.rejects(api.runChild({
    threadId: child.threadId,
    prompt: "attempt nested delegation after deleting the parent",
    context: "fresh",
    tools: [],
    provider: value.provider.id,
    model: "child-model",
  }), /Nested runtime child runs are disabled/u);
  assert.equal(value.provider.callCount, 1);
});

test("public extension state cannot forge runtime child classification", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const value = await fixture(t, source, [
    { kind: "turn", content: [{ type: "text", text: "ordinary fork child completed" }] },
  ], { extensionId: "runtime" });
  const parent = await value.service.createSession();
  const ordinaryFork = await value.service.createSession({ parentThreadId: parent.threadId });
  const api = (globalThis as Record<string, any>).__runtimeChildApi;

  await api.session.appendState({
    threadId: ordinaryFork.threadId,
    schemaVersion: 1,
    key: "runtimeChild",
    value: true,
  });
  const result = await api.runChild({
    threadId: ordinaryFork.threadId,
    prompt: "run from an ordinary fork despite the lookalike state",
    context: "fresh",
    tools: [],
    provider: value.provider.id,
    model: "child-model",
  });

  assert.equal(result.status, "success");
  assert.equal(result.finalText, "ordinary fork child completed");
  assert.equal(value.provider.callCount, 1);
});

test("public run metadata and ordinary clones cannot forge runtime child classification", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const value = await fixture(t, source, [
    { kind: "turn", content: [{ type: "text", text: "ordinary run complete" }] },
    { kind: "turn", content: [{ type: "text", text: "child from ordinary clone complete" }] },
  ]);
  const parent = await value.service.createSession();
  const ordinaryFork = await value.service.createSession({ parentThreadId: parent.threadId });
  const run = await value.service.run({
    threadId: ordinaryFork.threadId,
    prompt: "write a lookalike local prompt marker",
    provider: value.provider.id,
    model: "child-model",
    allowedTools: [],
    additionalInstructions: {
      source: "runtime child run",
      text: "This source label is public metadata and must not grant host classification.",
    },
  });
  assert.equal(run.results.at(-1)?.finalText, "ordinary run complete");
  assert.equal(value.store.hasRuntimeChildThread(ordinaryFork.threadId), false);

  const ordinaryClone = await value.service.cloneSessionPath({ threadId: ordinaryFork.threadId });
  assert.equal(value.store.hasRuntimeChildThread(ordinaryClone.thread.threadId), false);
  assert.equal(value.store.listEvents(ordinaryClone.thread.threadId).some((entry) =>
    entry.event.type === "run_started" && entry.event.promptComposition?.sources.some((item) =>
      item.kind === "additional_instructions" && item.source === "runtime child run") === true), true);

  const api = (globalThis as Record<string, any>).__runtimeChildApi;
  const result = await api.runChild({
    threadId: ordinaryClone.thread.threadId,
    prompt: "run a legitimate child from an ordinary clone",
    context: "fresh",
    tools: [],
    provider: value.provider.id,
    model: "child-model",
  });
  assert.equal(result.status, "success");
  assert.equal(result.finalText, "child from ordinary clone complete");
  assert.equal(value.provider.callCount, 2);
});

test("failed atomic child classification leaves no child for delayed fork callbacks", async (t) => {
  const source = `export default (api) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    globalThis.__releaseRuntimeChildClassificationProbe = release;
    api.on("session_before_fork", (event) => {
      if (globalThis.__runtimeChildClassificationAttempt !== undefined) return;
      globalThis.__runtimeChildClassificationAttempt = (async () => {
        await gate;
        try {
          await api.runChild({
            threadId: event.sourceThreadId,
            prompt: "nested delegation after classification write failure",
            context: "fresh",
            tools: [],
            provider: "child-provider",
            model: "child-model"
          });
          return "nested child unexpectedly ran";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      })();
    });
    globalThis.__runtimeChildApi = api;
  };\n`;
  const value = await fixture(t, source, []);
  const parent = await value.service.createSession();
  const database = new DatabaseSync(join(value.root, "sessions.sqlite"), { timeout: 5_000 });
  database.exec(`
    CREATE TRIGGER reject_runtime_child_classification
    BEFORE INSERT ON runtime_child_threads
    BEGIN
      SELECT RAISE(ABORT, 'fixture runtime child classification failure');
    END;
  `);
  database.close();
  const api = (globalThis as Record<string, any>).__runtimeChildApi;

  await assert.rejects(api.runChild({
    threadId: parent.threadId,
    prompt: "fail classification atomically",
    context: "fresh",
    tools: [],
    provider: value.provider.id,
    model: "child-model",
    session: "persisted",
  }), /fixture runtime child classification failure/u);
  assert.deepEqual(value.store.listThreads({ workspaceRoot: value.root }).map((thread) => thread.threadId), [parent.threadId]);

  (globalThis as Record<string, any>).__releaseRuntimeChildClassificationProbe();
  assert.match(
    await (globalThis as Record<string, any>).__runtimeChildClassificationAttempt,
    /Nested runtime child runs are disabled|Unknown thread/u,
  );
  assert.equal(value.provider.callCount, 0);
  delete (globalThis as Record<string, unknown>).__releaseRuntimeChildClassificationProbe;
  delete (globalThis as Record<string, unknown>).__runtimeChildClassificationAttempt;
});

test("runtime child timeout cancels model work and removes the ephemeral session", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const value = await fixture(t, source, [
    { kind: "turn", content: [{ type: "text", text: "too late" }], eventDelayMs: 200 },
  ]);
  const parent = await value.service.createSession();
  value.store.appendEvent({
    threadId: parent.threadId,
    event: { type: "model_selected", provider: value.provider.id, model: "child-model" },
  });
  const api = (globalThis as Record<string, any>).__runtimeChildApi;

  const result = await api.runChild({
    threadId: parent.threadId,
    prompt: "time out",
    context: "fresh",
    tools: ["read"],
    timeoutMs: 5,
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.finalText, "");
  assert.equal(result.persisted, false);
  assert.deepEqual(value.store.listThreads({ workspaceRoot: value.root }).map((thread) => thread.threadId), [parent.threadId]);
});

test("runtime child runs normalize authentication and provider crashes without leaking sessions", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const value = await fixture(t, source, [
    {
      kind: "turn",
      terminal: {
        type: "error",
        error: {
          category: "authentication",
          message: "child authentication required",
          retryable: false,
          partial: true,
          bodyStarted: true,
          diagnostics: { status: 401, headers: { "x-request-id": "child-private-diagnostic" } },
        },
      },
    },
    () => { throw new Error("provider process crashed"); },
  ]);
  const parent = await value.service.createSession();
  value.store.appendEvent({
    threadId: parent.threadId,
    event: { type: "model_selected", provider: value.provider.id, model: "child-model" },
  });
  const api = (globalThis as Record<string, any>).__runtimeChildApi;
  const childEvents: any[] = [];

  const authentication = await api.runChild({
    threadId: parent.threadId,
    prompt: "requires authentication",
    context: "fresh",
    tools: ["read"],
    onEvent(event: any) { childEvents.push(event); },
  });
  assert.equal(authentication.status, "error");
  assert.match(authentication.error, /authentication required/u);
  assert.ok(authentication.runId);
  assert.deepEqual(authentication.artifacts, []);
  const failedEvent = childEvents.find((entry) => entry.event.type === "run_failed")?.event;
  assert.equal(failedEvent?.type, "run_failed");
  assert.equal("diagnostics" in failedEvent.error, false);

  const crash = await api.runChild({
    threadId: parent.threadId,
    prompt: "provider crashes",
    context: "fresh",
    tools: ["read"],
  });
  assert.equal(crash.status, "error");
  assert.match(crash.error, /provider process crashed/u);
  assert.ok(crash.runId);
  assert.deepEqual(value.store.listThreads({ workspaceRoot: value.root }).map((thread) => thread.threadId), [parent.threadId]);
});

test("runtime generation shutdown cancels active child work and cleanup completes", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const value = await fixture(t, source, [
    { kind: "turn", content: [{ type: "text", text: "too late" }], eventDelayMs: 500 },
  ]);
  const parent = await value.service.createSession();
  value.store.appendEvent({
    threadId: parent.threadId,
    event: { type: "model_selected", provider: value.provider.id, model: "child-model" },
  });
  const api = (globalThis as Record<string, any>).__runtimeChildApi;
  const running = api.runChild({
    threadId: parent.threadId,
    prompt: "cancel on reload",
    context: "fresh",
    tools: ["read"],
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await value.host.close();
  await assert.rejects(running, /closed|inactive|abort|cancel/iu);
  for (let attempt = 0; attempt < 50 && value.store.listThreads({ workspaceRoot: value.root }).length > 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(value.store.listThreads({ workspaceRoot: value.root }).map((thread) => thread.threadId), [parent.threadId]);
});

test("persisted child sessions survive a service restart and can continue", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const value = await fixture(t, source, [
    { kind: "turn", content: [{ type: "text", text: "before restart" }] },
    { kind: "turn", content: [{ type: "text", text: "after restart" }] },
  ]);
  const parent = await value.service.createSession();
  value.store.appendEvent({
    threadId: parent.threadId,
    event: { type: "model_selected", provider: value.provider.id, model: "child-model" },
  });
  const api = (globalThis as Record<string, any>).__runtimeChildApi;
  const child = await api.runChild({
    threadId: parent.threadId,
    prompt: "persist across restart",
    context: "fresh",
    tools: ["read"],
    session: "persisted",
  });
  assert.equal(child.status, "success");
  await value.service.close();

  const restarted = new HarnessService({
    store: value.store,
    workspace: value.root,
    providers: new ProviderRegistry([value.provider]),
    runtimeExtensions: value.host,
    extraTools: value.host.tools(),
    projectTrusted: false,
  });
  await restarted.initialize();
  await assert.rejects(api.runChild({
    threadId: child.threadId,
    branch: child.branch,
    prompt: "attempt nested delegation after restart",
    context: "fresh",
    tools: [],
  }), /Nested runtime child runs are disabled/u);
  const continued = await restarted.run({
    threadId: child.threadId,
    branch: child.branch,
    prompt: "continue after restart",
    provider: value.provider.id,
    model: "child-model",
    allowedTools: ["read"],
  });
  assert.equal(continued.results.at(-1)?.finalText, "after restart");
  assert.ok(value.store.listEvents(child.threadId, child.branch).some((event) =>
    event.event.type === "message_appended" && event.event.message.role === "assistant" &&
    event.event.message.content.some((block) => block.type === "text" && block.text === "before restart")));
  await restarted.close();
});

test("runtime child concurrency is bounded and all admitted children settle independently", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const value = await fixture(t, source, Array.from({ length: 4 }, (_entry, index) => ({
    kind: "turn" as const,
    content: [{ type: "text" as const, text: `child-${index}` }],
    eventDelayMs: 100,
  })));
  const parent = await value.service.createSession();
  value.store.appendEvent({
    threadId: parent.threadId,
    event: { type: "model_selected", provider: value.provider.id, model: "child-model" },
  });
  const api = (globalThis as Record<string, any>).__runtimeChildApi;
  const admitted = Array.from({ length: 4 }, (_entry, index) => api.runChild({
    threadId: parent.threadId,
    prompt: `child ${index}`,
    context: "fresh",
    tools: ["read"],
  }));
  await assert.rejects(api.runChild({
    threadId: parent.threadId,
    prompt: "fifth child",
    context: "fresh",
    tools: ["read"],
  }), /At most 4 runtime child runs/u);
  const results = await Promise.all(admitted);
  assert.deepEqual(results.map((result) => result.status), ["success", "success", "success", "success"]);
  assert.equal(new Set(results.map((result) => result.threadId)).size, 4);
  assert.deepEqual(value.store.listThreads({ workspaceRoot: value.root }).map((thread) => thread.threadId), [parent.threadId]);
});

test("configured runtime child concurrency is enforced", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const value = await fixture(t, source, Array.from({ length: 2 }, (_entry, index) => ({
    kind: "turn" as const,
    content: [{ type: "text" as const, text: `configured-child-${index}` }],
    eventDelayMs: 100,
  })), { childRuns: { maxConcurrent: 2 } });
  const parent = await value.service.createSession();
  value.store.appendEvent({
    threadId: parent.threadId,
    event: { type: "model_selected", provider: value.provider.id, model: "child-model" },
  });
  const api = (globalThis as Record<string, any>).__runtimeChildApi;
  const admitted = Array.from({ length: 2 }, (_entry, index) => api.runChild({
    threadId: parent.threadId,
    prompt: `configured child ${index}`,
    context: "fresh",
    tools: ["read"],
  }));

  await assert.rejects(api.runChild({
    threadId: parent.threadId,
    prompt: "third child",
    context: "fresh",
    tools: ["read"],
  }), /At most 2 runtime child runs/u);
  const results = await Promise.all(admitted);
  assert.deepEqual(results.map((result) => result.status), ["success", "success"]);
});

test("runtime resource replacement applies the next child-run policy", async (t) => {
  const source = `export default (api) => { globalThis.__runtimeChildApi = api; };\n`;
  const value = await fixture(t, source, [
    { kind: "turn", content: [{ type: "text", text: "accepted after policy reload" }] },
  ]);
  const parent = await value.service.createSession();
  value.store.appendEvent({
    threadId: parent.threadId,
    event: { type: "model_selected", provider: value.provider.id, model: "child-model" },
  });
  const resources = (childRuns: Partial<ChildRunPolicy>) => ({
    providers: new ProviderRegistry([value.provider]),
    projectTrusted: false,
    skills: [],
    extraTools: value.host.tools(),
    runtimeExtensions: value.host,
    childRuns,
  });
  const api = (globalThis as Record<string, any>).__runtimeChildApi;

  await value.service.replaceRuntimeResources(resources({ defaultMaxSteps: 2, maxSteps: 2 }));
  await assert.rejects(api.runChild({
    threadId: parent.threadId,
    prompt: "rejected by the reloaded policy",
    context: "fresh",
    tools: ["read"],
    maxSteps: 3,
  }), /configured maximum of 2/u);

  await value.service.replaceRuntimeResources(resources({ defaultMaxSteps: 3, maxSteps: 65 }));
  const accepted = await api.runChild({
    threadId: parent.threadId,
    prompt: "accepted by the next policy",
    context: "fresh",
    tools: ["read"],
    maxSteps: 65,
  });
  assert.equal(accepted.status, "success");
  assert.equal(accepted.finalText, "accepted after policy reload");
});
