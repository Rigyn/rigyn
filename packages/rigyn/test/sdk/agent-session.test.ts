import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";

import type { AgentEvent, AgentTool } from "@rigyn/kernel";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@rigyn/models";

import { DefaultResourceLoader, type ResourceLoader } from "../../src/core/resource-loader.js";
import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import type { RuntimeEvent } from "../../src/core/events.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import type { DiscoveryView, ExtensionAPI } from "../../src/extensions/direct.js";
import {
  createExtensionRuntime,
  getExtensionRuntimeHost,
} from "../../src/extensions/compat.js";
import { providerFromAdapter } from "../../src/providers/internal-runtime-bridge.js";
import { ModelRuntime } from "../../src/providers/model-compat.js";
import { ModelRegistry as InternalModelRegistry } from "../../src/providers/model-registry.js";
import { ModelRegistry } from "../../src/providers/public-model-registry.js";
import { createModels, type ProviderModel } from "../../src/providers/models.js";
import { ProviderWireInterceptorRegistry } from "../../src/providers/wire.js";
import { runPrintMode } from "../../src/modes/print-mode.js";
import type { AgentSessionRuntime } from "../../src/service/agent-session-runtime.js";
import type { AgentSessionEvent } from "../../src/service/agent-session.js";
import {
  createAgentSession,
  defineTool,
  type ProviderWireLifecycleHost,
} from "../../src/sdk/index.js";
import { getDefaultSessionDir, SessionManager } from "../../src/storage/session-manager.js";
import { createScriptedProvider, type ScriptedProviderStep } from "../../src/testing/scripted-provider.js";
import type { ToolExecutionBackend } from "../../src/tools/backend.js";
import type { HarnessTool } from "../../src/tools/types.js";

const roots = new Set<string>();

async function workspace(): Promise<{ cwd: string; agentDir: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-sdk-session-"));
  roots.add(cwd);
  return { cwd, agentDir: join(cwd, ".agent") };
}

test.afterEach(async () => {
  await Promise.all([...roots].map(async (root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

test("SDK activates every built-in tool by default", async () => {
  const { cwd, agentDir } = await workspace();
  const { model, runtime } = await modelRuntime();
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
  });
  assert.deepEqual(created.session.getActiveTools(), [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
  ]);
  await created.session.close();
});

test("SDK model cycling honors configured disablement and explicit caller precedence", async () => {
  const { cwd, agentDir } = await workspace();
  const { model, runtime } = await modelRuntime();
  const settings = SettingsManager.inMemory();
  settings.setEnabledModels(["!none"]);
  const configured = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: settings,
  });
  assert.equal(configured.session.modelCyclingEnabled, false);
  assert.deepEqual(configured.session.scopedModels, []);
  assert.equal(await configured.session.cycleModel(), undefined);
  await configured.session.close();

  const explicit = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    scopedModels: [],
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: settings,
  });
  assert.equal(explicit.session.modelCyclingEnabled, true);
  explicit.session.setScopedModels([], { cyclingEnabled: false });
  assert.equal(explicit.session.modelCyclingEnabled, false);
  await explicit.session.close();
});

test("direct session presents public models and tool definitions without wire metadata", async () => {
  const { cwd, agentDir } = await workspace();
  const { runtime } = await modelRuntime();
  const selected = runtime.find("sdk-fixture", "fixture-model");
  assert.ok(selected);
  assert.equal(selected.api, "openai-completions");
  const alternate: Model<Api> = {
    ...structuredClone(selected),
    id: "fixture-alternate",
    name: "Fixture alternate",
  };
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model: selected,
    scopedModels: [{ model: selected }, { model: alternate, thinkingLevel: "low" }],
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
  });

  assert.equal(created.session.model?.api, "openai-completions");
  assert.equal(created.session.state.model?.api, "openai-completions");
  assert.equal(created.session.nativeModel?.api, "openai-chat-completions");
  assert.deepEqual(created.session.scopedModels.map((entry) => entry.model.api), [
    "openai-completions",
    "openai-completions",
  ]);
  assert.notEqual(created.session.sessionManager, created.session.nativeSessionManager);
  const publicEntryId = created.session.sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "public history" }],
    timestamp: Date.now(),
  });
  const publicEntry = created.session.sessionManager.getEntry(publicEntryId);
  assert.equal(publicEntry?.type, "message");
  assert.equal(publicEntry?.type === "message" && publicEntry.message.role, "user");

  await created.session.setModel(structuredClone(selected));
  assert.equal(created.session.model?.api, "openai-completions");
  assert.equal(created.session.nativeModel?.api, "openai-chat-completions");
  const cycled = await created.session.cycleModel();
  assert.equal(cycled?.model.id, "fixture-alternate");
  assert.equal(cycled?.model.api, "openai-completions");
  assert.equal(created.session.nativeModel?.api, "openai-chat-completions");

  const readDefinition = created.session.getToolDefinition("read");
  assert.ok(readDefinition);
  assert.equal("parameters" in readDefinition, true);
  assert.equal("inputSchema" in readDefinition, false);
  assert.equal(typeof readDefinition.execute, "function");
  const readInfo = created.session.getAllTools().find((tool) => tool.name === "read");
  assert.equal(readInfo?.sourceInfo.path, "<builtin:read>");
  assert.equal(created.session.state.tools.some((tool) => tool.name === "read"), true);

  await created.session.close();
});

test("SDK default sessions use the CLI-discoverable workspace directory", async () => {
  const { cwd, agentDir } = await workspace();
  const { model, runtime } = await modelRuntime();
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    settingsManager: SettingsManager.inMemory(),
  });

  assert.equal(created.session.sessionManager.getSessionDir(), getDefaultSessionDir(cwd, agentDir));
  await created.session.close();
});

test("SDK reopens suspended never-repeat work for explicit recovery before applying requested selection", async () => {
  const { cwd, agentDir } = await workspace();
  let executions = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const unsafeTool: HarnessTool = {
    definition: {
      name: "unsafe_probe",
      description: "Exercise explicit SDK recovery",
      inputSchema: { type: "object", additionalProperties: false },
    },
    recovery: { mode: "never_repeat" },
    validate() {},
    resources() { return []; },
    async execute(_input, execution) {
      executions += 1;
      markStarted();
      return await new Promise((_resolve, reject) => {
        const cancel = (): void => reject(execution.signal.reason ?? new Error("cancelled"));
        if (execution.signal.aborted) cancel();
        else execution.signal.addEventListener("abort", cancel, { once: true });
      });
    },
  };
  const { model, runtime } = await modelRuntime([{
    kind: "turn",
    content: [{ type: "tool_call", id: "unsafe-call", name: "unsafe_probe", arguments: {} }],
    terminal: { type: "finish", reason: "tool_calls" },
  }], { reasoning: "supported" });
  const manager = SessionManager.create(cwd, join(cwd, "sessions"), { id: "sdk-suspended-reopen" });
  const initial = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory(),
    customTools: [unsafeTool],
    tools: ["unsafe_probe"],
  });
  const running = initial.session.prompt("start unsafe work");
  await started;
  await initial.session.abort("simulate process interruption");
  assert.equal((await running).results.at(-1)?.finishReason, "cancelled");
  assert.equal(executions, 1);
  assert.equal(initial.session.suspendedRun?.effects[0]?.policy, "never_repeat");
  const sessionFile = initial.session.sessionFile;
  assert.ok(sessionFile);
  await initial.session.close();
  const matchingSessionFile = join(cwd, "sessions", "sdk-suspended-matching.jsonl");
  await copyFile(sessionFile, matchingSessionFile);

  const restored = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    sessionManager: SessionManager.open(sessionFile),
    settingsManager: SettingsManager.inMemory(),
    customTools: [unsafeTool],
    tools: ["unsafe_probe"],
  });
  assert.equal(restored.session.suspendedRun?.effects[0]?.policy, "never_repeat");
  assert.equal(restored.session.model?.id, model.id);
  assert.equal(restored.session.thinkingLevel, "medium");
  assert.equal(executions, 1);
  await restored.session.close();

  const matching = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "medium",
    sessionManager: SessionManager.open(matchingSessionFile),
    settingsManager: SettingsManager.inMemory(),
    customTools: [unsafeTool],
    tools: ["unsafe_probe"],
  });
  const matchingSelections = () => matching.session.nativeSessionManager.getEntries().flatMap((entry) => {
    if (entry.type === "model_change") return [`model:${entry.provider}/${entry.modelId}`];
    if (entry.type === "thinking_level_change") return [`thinking:${entry.thinkingLevel}`];
    return [];
  });
  const matchingSelectionsBefore = matchingSelections();
  const matchingBlocked = await matching.session.recoverInterruptedRun();
  const matchingEffectId = matchingBlocked.blocked[0]?.effectId;
  assert.ok(matchingEffectId);
  assert.deepEqual(await matching.session.recoverInterruptedRun({
    resolutions: [{ effectId: matchingEffectId, outcome: "abandoned" }],
  }), {
    recovered: true,
    operationId: matchingBlocked.operationId,
    blocked: [],
  });
  assert.deepEqual(matchingSelections(), matchingSelectionsBefore);
  assert.equal(matching.session.model?.id, model.id);
  assert.equal(matching.session.thinkingLevel, "medium");
  assert.equal(executions, 1);
  await matching.session.close();

  const resumedRuntime = await modelRuntime([{
    kind: "turn",
    content: [{ type: "text", text: "continued safely" }],
    terminal: { type: "finish", reason: "stop" },
  }], { reasoning: "supported", modelId: "fixture-alternate" });
  const requestedModel = resumedRuntime.model;
  const reopened = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: resumedRuntime.runtime,
    model: requestedModel,
    thinkingLevel: "high",
    sessionManager: SessionManager.open(sessionFile),
    settingsManager: SettingsManager.inMemory(),
    customTools: [unsafeTool],
    tools: ["unsafe_probe"],
  });
  assert.equal(
    reopened.modelFallbackMessage,
    "Could not restore model sdk-fixture/fixture-model. Using sdk-fixture/fixture-alternate.",
  );
  assert.equal(reopened.session.suspendedRun?.effects[0]?.policy, "never_repeat");
  assert.equal(reopened.session.model, undefined);
  assert.equal(reopened.session.thinkingLevel, "medium");
  assert.equal(Object.hasOwn(reopened.session, "recoverInterruptedRun"), false);

  const blocked = await reopened.session.recoverInterruptedRun();
  assert.equal(blocked.recovered, false);
  assert.equal(blocked.blocked.length, 1);
  assert.equal(executions, 1, "never-repeat work must not replay automatically");
  const effectId = blocked.blocked[0]?.effectId;
  assert.ok(effectId);
  const setModel = reopened.session.setModel.bind(reopened.session);
  let failRequestedSelection = true;
  const failModelOnce: typeof reopened.session.setModel = async (...args) => {
    await setModel(...args);
    if (failRequestedSelection) {
      failRequestedSelection = false;
      throw new Error("transient requested selection failure");
    }
  };
  Object.defineProperty(reopened.session, "setModel", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: failModelOnce,
  });
  let concurrentPrompt: Promise<{ error?: unknown; succeeded: boolean }> | undefined;
  const unsubscribe = reopened.session.onEvent((envelope) => {
    if (envelope.event.type === "run_cancelled") {
      concurrentPrompt = reopened.session.agent.prompt([{
        role: "user",
        content: [{ type: "text", text: "must wait for recovered selection" }],
        timestamp: Date.now(),
      }]).then(
        () => ({ succeeded: true }),
        (error: unknown) => ({ error, succeeded: false }),
      );
    }
  });
  await assert.rejects(
    reopened.session.recoverInterruptedRun({
      resolutions: [{ effectId, outcome: "abandoned" }],
    }),
    (error: Error & { cause?: unknown }) => {
      assert.match(error.message, /interrupted run is recovered/iu);
      assert.match(String(error.cause), /transient requested selection failure/u);
      return true;
    },
  );
  assert.equal(reopened.session.suspendedRun, undefined);
  assert.equal(reopened.session.thinkingLevel, "medium");
  assert.equal(resumedRuntime.adapter.capturedRequests().length, 0);
  assert.ok(concurrentPrompt);
  const concurrentResult = await concurrentPrompt;
  assert.equal(concurrentResult.succeeded, false);
  assert.match(String(concurrentResult.error), /requested model or thinking selection/iu);
  assert.equal(resumedRuntime.adapter.capturedRequests().length, 0);
  unsubscribe();
  await reopened.session.agent.prompt([{
    role: "user",
    content: [{ type: "text", text: "continue normally" }],
    timestamp: Date.now(),
  }]);
  assert.equal(reopened.session.state.model?.id, requestedModel.id);
  assert.equal(reopened.session.thinkingLevel, "high");
  assert.equal(Object.hasOwn(reopened.session, "recoverInterruptedRun"), false);
  assert.equal(resumedRuntime.adapter.capturedRequests()[0]?.model, requestedModel.id);
  assert.equal(resumedRuntime.adapter.capturedRequests()[0]?.reasoningEffort, "high");
  const recoveredEntries = reopened.session.nativeSessionManager.getEntries();
  assert.equal(recoveredEntries.filter((entry) =>
    entry.type === "model_change" && entry.modelId === requestedModel.id).length, 1);
  assert.equal(recoveredEntries.filter((entry) =>
    entry.type === "thinking_level_change" && entry.thinkingLevel === "high").length, 1);
  assert.deepEqual(await reopened.session.recoverInterruptedRun(), { recovered: false, blocked: [] });
  assert.equal(executions, 1);
  await reopened.session.close();
});

test("SDK, print, and JSON expose the same bounded provider failure as raw events and V4", async () => {
  const modes = ["sdk", "text", "json"] as const;
  for (const mode of modes) {
    const { cwd, agentDir } = await workspace();
    const secret = `sdk-provider-failure-secret-${mode}`;
    const failure = `provider failure ${secret} ${"x".repeat(20 * 1024)}`;
    const sanitized = failure.replaceAll(secret, "[REDACTED]");
    const expected = Buffer.from(sanitized, "utf8").subarray(0, 16 * 1024).toString("utf8");
    defaultSecretRedactor.register(secret);
    const { model, runtime } = await modelRuntime([{
      kind: "turn",
      terminal: {
        type: "error",
        error: { category: "provider", message: failure, retryable: false, partial: true },
      },
    }]);
    const manager = SessionManager.inMemory(cwd, { id: `sdk-provider-error-${mode}` });
    const created = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory(),
      noTools: "all",
    });
    const raw: RuntimeEvent[] = [];
    const publicEvents: AgentSessionEvent[] = [];
    created.session.onEvent((envelope) => { raw.push(envelope.event); });
    created.session.subscribe((event) => { publicEvents.push(event); });

    if (mode === "sdk") {
      const result = await created.session.prompt("fail");
      assert.equal(result.results.at(-1)?.finishReason, "error");
      assert.equal(result.results.at(-1)?.finalText, expected);
    } else {
      const writes: string[] = [];
      const errors: string[] = [];
      let disposed = false;
      const originalError = console.error;
      console.error = (value: unknown) => { errors.push(String(value)); };
      try {
        const printRuntime = {
          session: created.session,
          setBeforeSessionInvalidate() {},
          setRebindSession() {},
          async dispose() { disposed = true; },
        } as unknown as AgentSessionRuntime;
        assert.equal(await runPrintMode(printRuntime, {
          mode,
          initialMessage: "fail",
          write(value) { writes.push(value); },
        }), 1);
      } finally {
        console.error = originalError;
      }
      assert.equal(disposed, true);
      if (mode === "text") {
        assert.deepEqual(errors, [expected]);
        assert.deepEqual(writes, []);
      } else {
        assert.deepEqual(errors, []);
        const records = writes.flatMap((value) => value.trim().split("\n"))
          .filter((value) => value !== "")
          .map((value) => JSON.parse(value) as { type?: string; message?: { errorMessage?: string } });
        assert.equal(records.findLast((record) => record.type === "message_end")?.message?.errorMessage, expected);
      }
    }

    const rawFailures = raw.filter((event) => event.type === "run_failed");
    assert.equal(rawFailures.length, 1);
    assert.equal(rawFailures[0]?.type === "run_failed" && rawFailures[0].error.message, expected);
    const publicFailure = publicEvents.findLast((event) =>
      event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error");
    assert.equal(publicFailure?.type, "message_end");
    assert.equal(publicFailure?.type === "message_end" && publicFailure.message.role === "assistant"
      ? publicFailure.message.errorMessage
      : undefined, expected);
    const durableFailure = manager.getBranch().findLast((entry) =>
      entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error");
    assert.equal(durableFailure?.type === "message" && durableFailure.message.role === "assistant"
      ? durableFailure.message.errorMessage
      : undefined, expected);
    assert.equal(Buffer.byteLength(expected, "utf8") <= 16 * 1024, true);
    const serialized = JSON.stringify({ raw, publicEvents, branch: manager.getBranch() });
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(secret.slice(0, Math.floor(secret.length / 2))), false);
    assert.equal(serialized.includes(secret.slice(Math.floor(secret.length / 2))), false);
    assert.equal(serialized.includes(expected), true);
    assert.deepEqual([...manager.getV4State().operations.values()].map((operation) => operation.status), ["failed"]);
    await created.session.close();
  }
});

test("SDK creation failure releases its internally-created session writer", async () => {
  const { cwd, agentDir } = await workspace();
  const sessionDirectory = getDefaultSessionDir(cwd, agentDir);

  await assert.rejects(createAgentSession({
    cwd,
    agentDir,
    providerWireLifecycle: new ProviderWireInterceptorRegistry(),
    settingsManager: SettingsManager.inMemory(),
  }), /providerWireLifecycle requires a caller-supplied modelRuntime/u);

  const journals = (await readdir(sessionDirectory)).filter((name) => name.endsWith(".jsonl"));
  assert.equal(journals.length, 1);
  const reopened = SessionManager.open(join(sessionDirectory, journals[0]!));
  reopened.closeV4Store();
});

test("SDK default model and auth services use the requested agent directory", async () => {
  const { cwd, agentDir } = await workspace();
  const ambientAgentDir = join(cwd, ".ambient-agent");
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(ambientAgentDir, { recursive: true }),
  ]);
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({
    openai: { kind: "api_key", provider: "openai", apiKey: "sdk-agent-dir-key" },
  }));
  await writeFile(join(ambientAgentDir, "auth.json"), "{}\n");

  const previousAgentDir = process.env.RIGYN_HOME;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  const previousPath = process.env.PATH;
  process.env.RIGYN_HOME = ambientAgentDir;
  delete process.env.OPENAI_API_KEY;
  process.env.PATH = "";
  let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
  try {
    created = await createAgentSession({
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory(),
    });
    assert.equal(created.session.nativeModel?.provider, "openai");
  } finally {
    await created?.session.close().catch(() => undefined);
    if (previousAgentDir === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDir;
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("SDK binds provider wire hooks to a caller-connected transport and releases them on close", async (context) => {
  const { cwd, agentDir } = await workspace();
  const observedResponses: Array<{ status: number; headers: Record<string, string> }> = [];
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{
      name: "sdk-provider-hooks",
      factory(api) {
        api.on("before_provider_request", (event) => ({
          ...(event.payload as Record<string, unknown>),
          extension: true,
        }));
        api.on("before_provider_headers", (event) => {
          assert.equal(event.headers.authorization, "Bearer secret");
          event.headers.authorization = "Bearer extension";
          event.headers["x-extension"] = "active";
        });
        api.on("after_provider_response", (event) => {
          observedResponses.push({ status: event.status, headers: { ...event.headers } });
        });
      },
    }],
  });
  await loader.refresh();
  const host = getExtensionRuntimeHost(loader.getExtensions().runtime);
  assert.ok(host);
  assert.equal(host.hasListeners("before_provider_request"), true);
  assert.equal(host.hasListeners("before_provider_headers"), true);
  assert.equal(host.hasListeners("after_provider_response"), true);
  context.after(async () => await host.close());

  const wire = new ProviderWireInterceptorRegistry();
  const lifecycle: ProviderWireLifecycleHost = wire;
  const { model, runtime } = await modelRuntime();
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    providerWireLifecycle: lifecycle,
    model,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    noTools: "all",
  });
  context.after(async () => await created.session.close());

  const outgoingBodies: unknown[] = [];
  const outgoingHeaders: Headers[] = [];
  const wrapped = wire.wrapFetch("sdk-fixture", async (input, init) => {
    const request = new Request(input, init);
    outgoingBodies.push(await request.clone().json());
    outgoingHeaders.push(new Headers(request.headers));
    return new Response(null, {
      status: 201,
      headers: { "x-request-id": "sdk-request" },
    });
  });
  let transport = Promise.resolve();
  created.session.agent.streamFunction = (selected, _providerContext, options) => {
    const stream = createAssistantMessageEventStream();
    const counters = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "provider hooks complete" }],
      api: selected.api,
      provider: selected.provider,
      model: selected.id,
      usage: {
        ...counters,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    transport = wrapped("https://example.test/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: selected.id }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    }).then(() => undefined);
    void transport.finally(() => {
      stream.push({ type: "done", reason: "stop", message });
    }).catch(() => undefined);
    return stream;
  };

  const result = await created.session.prompt("exercise provider hooks");
  await transport;
  assert.equal(result.results.at(-1)?.finalText, "provider hooks complete");
  assert.deepEqual(
    outgoingBodies,
    [{ model: "fixture-model", extension: true }],
    JSON.stringify(host.diagnostics()),
  );
  assert.equal(outgoingHeaders[0]?.get("authorization"), "Bearer extension");
  assert.equal(outgoingHeaders[0]?.get("x-extension"), "active");
  assert.deepEqual(observedResponses, [{
    status: 201,
    headers: { "x-request-id": "sdk-request" },
  }]);

  await created.session.close();
  await wire.withScope({ threadId: "closed", runId: "closed", step: 0 }, async () => {
    await wrapped("https://example.test/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "fixture-model" }),
    });
  });
  assert.deepEqual(outgoingBodies[1], { model: "fixture-model" });
  assert.equal(outgoingHeaders[1]?.get("authorization"), "Bearer secret");
  assert.equal(observedResponses.length, 1);
});

test("direct sendUserMessage failures are retained as diagnostics", async (context) => {
  const { cwd, agentDir } = await workspace();
  let sendUserMessage: (() => void) | undefined;
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{
      name: "sdk-direct-message-diagnostic",
      factory(api) {
        sendUserMessage = () => api.sendUserMessage("message without a selected model");
      },
    }],
  });
  await loader.refresh();
  const host = getExtensionRuntimeHost(loader.getExtensions().runtime);
  assert.ok(host);
  context.after(async () => await host.close());

  const emptyRuntime = await ModelRuntime.create({
    models: createModels(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: new ModelRegistry(emptyRuntime),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    noTools: "all",
  });
  context.after(async () => await created.session.close());

  assert.ok(sendUserMessage);
  sendUserMessage();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (host.diagnostics().some((entry) => entry.message.includes("User message delivery failed"))) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(
    host.diagnostics().some((entry) =>
      entry.extensionId === "direct-message"
      && entry.message === "User message delivery failed: No model is selected"),
    true,
  );
});

test("SDK discovery includes commands, prompts, and skills before and after refresh", async (context) => {
  const { cwd, agentDir } = await workspace();
  const prompt = join(cwd, "sdk-review.md");
  const skill = join(cwd, "sdk-audit");
  await writeFile(prompt, "---\ndescription: Review through the SDK\n---\n\nReview this workspace.\n");
  await mkdir(skill);
  await writeFile(join(skill, "SKILL.md"), "---\nname: sdk-audit\ndescription: Audit through the SDK\n---\n\nAudit.\n");
  let getDiscoveryView: (() => Promise<DiscoveryView>) | undefined;
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noThemes: true,
    noContextFiles: true,
    additionalPromptTemplatePaths: [prompt],
    additionalSkillPaths: [skill],
    extensionFactories: [{
      name: "sdk-discovery",
      factory(api) {
        api.registerCommand("sdk-inspect", {
          description: "Inspect through the SDK",
          async handler() {},
        });
        getDiscoveryView = async () => await api.getDiscoveryView();
      },
    }],
  });
  await loader.refresh();
  const { model, runtime } = await modelRuntime();
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    noTools: "all",
  });
  context.after(async () => {
    await created.session.close();
    await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close();
  });

  const assertDiscovery = async (): Promise<void> => {
    assert.ok(getDiscoveryView);
    const view = await getDiscoveryView();
    assert.equal(view.resources.some((entry) =>
      entry.kind === "command" && entry.source === "builtin" && entry.name === "refresh"), true);
    assert.equal(view.resources.some((entry) =>
      entry.kind === "command" && entry.source === "runtime_extension" && entry.name === "sdk-inspect"), true);
    assert.equal(view.resources.some((entry) =>
      entry.kind === "prompt" && entry.name === "sdk-review"), true);
    assert.equal(view.resources.some((entry) =>
      entry.kind === "skill" && entry.name === "sdk-audit"), true);
    assert.equal(view.truncated, false);
  };

  await assertDiscovery();
  await created.session.refresh();
  await assertDiscovery();
});

test("SDK honors persistent tool settings when call options are omitted", async () => {
  const { cwd, agentDir } = await workspace();
  const { model, runtime } = await modelRuntime();
  const settingsManager = SettingsManager.inMemory({
    tools: {
      enabled: ["read", "bash"],
      excluded: ["bash"],
    },
  });
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });

  assert.deepEqual(created.session.getActiveTools(), ["read"]);
  settingsManager.updateGlobalSettings({ tools: { enabled: ["write"], excluded: [] } });
  await created.session.refresh();
  assert.deepEqual(created.session.getActiveTools(), ["write"]);

  created.session.setActiveTools(["read"]);
  settingsManager.updateGlobalSettings({ tools: { enabled: ["bash"], excluded: [] } });
  await created.session.refresh();
  assert.deepEqual(created.session.getActiveTools(), ["read"]);
  await created.session.close();
});

async function modelRuntime(
  scripts: readonly ScriptedProviderStep[] = [],
  options: {
    reasoning?: "supported" | "unsupported";
    images?: "supported" | "unsupported";
    modelId?: string;
  } = {},
): Promise<{
  adapter: ReturnType<typeof createScriptedProvider>;
  model: ProviderModel;
  runtime: ModelRegistry;
  modelRuntime: ModelRuntime;
}> {
  const adapter = createScriptedProvider({
    id: "sdk-fixture",
    models: [{
      id: options.modelId ?? "fixture-model",
      capabilities: {
        reasoning: options.reasoning ?? "unsupported",
        images: options.images ?? "supported",
      },
    }],
    scripts,
  });
  const initialModels = adapter.models.map((entry) => ({
    ...entry,
    compatibility: {
      ...entry.compatibility,
      protocolFamily: {
        value: "openai-chat-completions" as const,
        source: "configuration" as const,
        observedAt: "2026-07-20T00:00:00.000Z",
      },
    },
  }));
  const models = createModels();
  models.setProvider(providerFromAdapter(adapter, {
    initialModels,
    auth: {
      apiKey: {
        name: "Fixture key",
        async resolve() { return { auth: { apiKey: "fixture" }, source: "fixture" }; },
      },
    },
  }));
  const internal = new InternalModelRegistry(models);
  await internal.refresh({ allowNetwork: false });
  const model = internal.find("sdk-fixture", options.modelId ?? "fixture-model");
  if (model === undefined) throw new Error("fixture model was not registered");
  const modelRuntime = await ModelRuntime.create({
    models,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const runtime = new ModelRegistry(modelRuntime);
  await runtime.refresh();
  return { adapter, model, runtime, modelRuntime };
}

test("SDK sessions withhold prompt images from catalog-declared text-only models", async () => {
  const { cwd, agentDir } = await workspace();
  const { adapter, model, runtime } = await modelRuntime([{
    kind: "turn",
    content: [{ type: "text", text: "text-only complete" }],
    terminal: { type: "finish", reason: "stop" },
  }], { images: "unsupported" });
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    noTools: "all",
  });

  await created.session.prompt("inspect", {
    images: [{ type: "image", mimeType: "image/png", data: "AA==" }],
  });

  const content = adapter.capturedRequests()[0]?.messages.flatMap((message) => message.content) ?? [];
  assert.equal(content.some((block) => block.type === "image"), false);
  assert.equal(content.some((block) =>
    block.type === "text" && block.text === "(image withheld: selected model accepts text only)"), true);
  await created.session.close();
});

test("SDK clamps absent and partial advanced thinking maps", async () => {
  const { cwd, agentDir } = await workspace();
  const { model, runtime } = await modelRuntime([], { reasoning: "supported" });
  assert.equal(model.thinkingLevelMap, undefined);

  const absent = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "max",
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    noTools: "all",
  });
  assert.equal(absent.session.thinkingLevel, "high");
  await absent.session.close();

  model.thinkingLevelMap = { max: "provider-max" };
  const partialUnsupported = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "xhigh",
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    noTools: "all",
  });
  assert.equal(partialUnsupported.session.thinkingLevel, "max");
  await partialUnsupported.session.close();

  const partialSupported = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "max",
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    noTools: "all",
  });
  assert.equal(partialSupported.session.thinkingLevel, "max");
  await partialSupported.session.close();

});

function delegateResourceLoader(loader: DefaultResourceLoader, refresh: () => Promise<void>): ResourceLoader {
  return {
    getExtensions: () => loader.getExtensions(),
    getSkills: () => loader.getSkills(),
    getPrompts: () => loader.getPrompts(),
    getThemes: () => loader.getThemes(),
    getAgentsFiles: () => loader.getAgentsFiles(),
    getSystemPrompt: () => loader.getSystemPrompt(),
    getAppendSystemPrompt: () => loader.getAppendSystemPrompt(),
    extendResources: (paths) => loader.extendResources(paths),
    extendResourcesFromExtensions: async (runtime, reason) => await loader.extendResourcesFromExtensions(runtime, reason),
    refresh,
  };
}

test("createAgentSession accepts a SessionManager cwd for the same canonical workspace", async () => {
  const { cwd: root, agentDir } = await workspace();
  const cwd = join(root, "workspace");
  const alias = join(root, "workspace-alias");
  await mkdir(cwd);
  await symlink(cwd, alias, process.platform === "win32" ? "junction" : "dir");
  const { runtime } = await modelRuntime();
  const manager = SessionManager.inMemory(alias);

  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory(),
    noTools: "all",
  });

  assert.equal(created.session.nativeSessionManager, manager);
  await created.session.close();
});

test("createAgentSession accepts the public extension result contract and zero-argument runtime", async () => {
  const { cwd, agentDir } = await workspace();
  const extensionRuntime = createExtensionRuntime();
  const exactExtensionsResult = { extensions: [], errors: [], runtime: extensionRuntime };
  const resourceLoader: ResourceLoader = {
    getExtensions: () => exactExtensionsResult,
    getSkills() { return { skills: [], diagnostics: [] }; },
    getPrompts() { return { prompts: [], diagnostics: [] }; },
    getThemes() { return { themes: [], diagnostics: [] }; },
    getAgentsFiles() { return { agentsFiles: [] }; },
    getSystemPrompt() { return undefined; },
    getAppendSystemPrompt() { return []; },
    extendResources() {},
    async refresh() {},
  };
  const { model, runtime } = await modelRuntime();
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    noTools: "all",
  });

  assert.equal(created.extensionsResult, exactExtensionsResult);
  assert.equal(created.extensionsResult.runtime, extensionRuntime);
  assert.deepEqual(created.extensionsResult.extensions, []);
  assert.deepEqual(created.extensionsResult.errors, []);
  const fallbackHost = getExtensionRuntimeHost(extensionRuntime);
  assert.ok(fallbackHost);
  await created.session.close();
  assert.throws(() => fallbackHost.onError(() => {}), /closed/u);
  assert.throws(() => extensionRuntime.getCommands(), /stale|disposed/u);
});

test("direct provider registrations are available before the initial model is selected", async () => {
  const { cwd, agentDir } = await workspace();
  let generation = 0;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [{
      name: "provider-fixture",
      factory(api) {
        const current = ++generation;
        if (current > 2) return;
        api.registerProvider("extension-model", {
          name: "Extension model",
          baseUrl: "https://example.test/v1",
          apiKey: "fixture-key",
          api: "openai-completions",
          models: [{
            id: `fixture-${current}`,
            name: "Fixture",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4_096,
            maxTokens: 512,
          }],
        });
      },
    }],
  });
  await loader.refresh();
  const { runtime } = await modelRuntime();
  const settings = SettingsManager.inMemory();
  settings.setDefaultModelAndProvider("extension-model", "fixture-1");
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });

  assert.equal(created.session.model?.provider, "extension-model");
  assert.equal(created.session.model?.id, "fixture-1");
  assert.equal(runtime.find("extension-model", "fixture-1")?.id, "fixture-1");
  await created.session.refresh();
  assert.equal(runtime.find("extension-model", "fixture-1"), undefined);
  assert.equal(runtime.find("extension-model", "fixture-2")?.id, "fixture-2");
  await created.session.refresh();
  assert.equal(runtime.find("extension-model", "fixture-2"), undefined);
  await created.session.close();
  await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close();
  assert.equal(runtime.find("extension-model", "fixture-1"), undefined);
});

test("SDK provider bootstrap restores the built-in model and transport after command-time unregister", async () => {
  const { cwd, agentDir } = await workspace();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [{
      name: "provider-override-fixture",
      factory(api) {
        api.registerProvider("sdk-fixture", {
          name: "Temporary SDK provider",
          baseUrl: "https://example.test/v1",
          apiKey: "fixture-key",
          api: "openai-completions",
          models: [{
            id: "temporary-model",
            name: "Temporary model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4_096,
            maxTokens: 512,
          }],
        });
        api.registerCommand("restore-sdk-provider", {
          async handler(_args, context) {
            context.modelRegistry.unregisterProvider("sdk-fixture");
          },
        });
      },
    }],
  });
  await loader.refresh();
  const { model, runtime } = await modelRuntime([{
    kind: "turn",
    content: [{ type: "text", text: "restored transport" }],
    terminal: { type: "finish", reason: "stop" },
  }]);
  const settings = SettingsManager.inMemory();
  settings.setDefaultModelAndProvider("sdk-fixture", "temporary-model");
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });
  const host = getExtensionRuntimeHost(created.extensionsResult.runtime);
  assert.ok(host);
  assert.equal(created.session.model?.id, "temporary-model");
  assert.equal(runtime.find("sdk-fixture", "temporary-model")?.id, "temporary-model");

  assert.deepEqual(await host.runCommand("restore-sdk-provider", {
    args: "",
    threadId: created.session.sessionId,
    branch: created.session.sessionManager.getLeafId() ?? "root",
    signal: new AbortController().signal,
  }), { handled: true });
  assert.equal(runtime.find("sdk-fixture", "temporary-model"), undefined);
  assert.equal(runtime.find("sdk-fixture", "fixture-model")?.id, "fixture-model");

  await created.session.setModel(model);
  const result = await created.session.prompt("verify restored provider", { allowedTools: [] });
  assert.equal(result.results.at(-1)?.finalText, "restored transport");
  await created.session.close();
  await host.close();
});

test("direct provider overlays preserve owner order across replacement, unregister, and refresh", async () => {
  const { cwd, agentDir } = await workspace();
  const ownerA: ExtensionAPI[] = [];
  const ownerB: ExtensionAPI[] = [];
  const provider = (name: string, modelId: string) => ({
    name,
    baseUrl: "https://example.test/v1",
    apiKey: "fixture-key",
    api: "openai-completions" as const,
    models: [{
      id: modelId,
      name: modelId,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4_096,
      maxTokens: 512,
    }],
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [{
      name: "provider-owner-a",
      factory(api) {
        ownerA.push(api);
        api.registerProvider("sdk-fixture", provider("Owner A", "owner-a"));
      },
    }, {
      name: "provider-owner-b",
      factory(api) {
        ownerB.push(api);
        api.registerProvider("sdk-fixture", provider("Owner B", "owner-b"));
      },
    }],
  });
  await loader.refresh();
  const { runtime, modelRuntime: internalRuntime } = await modelRuntime();
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager: SettingsManager.inMemory(),
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });

  assert.equal(runtime.find("sdk-fixture", "owner-b")?.id, "owner-b");
  const ownerBProvider = internalRuntime.internalRegistry().getProvider("sdk-fixture");
  assert.ok(ownerBProvider);
  ownerA[0]!.unregisterProvider("sdk-fixture");
  assert.equal(runtime.find("sdk-fixture", "owner-b")?.id, "owner-b");
  assert.equal(internalRuntime.internalRegistry().getProvider("sdk-fixture"), ownerBProvider);
  ownerA[0]!.registerProvider("sdk-fixture", provider("Owner A replacement", "owner-a-2"));
  assert.equal(runtime.find("sdk-fixture", "owner-a-2")?.id, "owner-a-2");
  ownerA[0]!.registerProvider("sdk-fixture", provider("Owner A final", "owner-a-3"));
  assert.equal(runtime.find("sdk-fixture", "owner-a-2"), undefined);
  assert.equal(runtime.find("sdk-fixture", "owner-a-3")?.id, "owner-a-3");
  ownerA[0]!.unregisterProvider("sdk-fixture");
  assert.equal(runtime.find("sdk-fixture", "owner-b")?.id, "owner-b");
  ownerB[0]!.unregisterProvider("sdk-fixture");
  assert.equal(runtime.find("sdk-fixture", "fixture-model")?.id, "fixture-model");

  await created.session.refresh();
  assert.equal(runtime.find("sdk-fixture", "owner-b")?.id, "owner-b");
  assert.throws(() => ownerA[0]!.unregisterProvider("sdk-fixture"), /no longer active|stale|closed/u);
  assert.equal(runtime.find("sdk-fixture", "owner-b")?.id, "owner-b");

  await created.session.close();
  await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close();
  assert.equal(runtime.find("sdk-fixture", "fixture-model")?.id, "fixture-model");
});

test("createAgentSession composes injected managers, exact tool policy, and custom tools", async () => {
  const { cwd, agentDir } = await workspace();
  let executions = 0;
  const customTool: HarnessTool = {
    definition: {
      name: "probe",
      description: "Return the supplied value",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } },
      },
    },
    validate(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.value !== "string") {
        throw new Error("probe.value must be a string");
      }
    },
    resources() { return []; },
    async execute(input) {
      executions += 1;
      return { content: String((input as { value: string }).value), isError: false };
    },
  };
  const { model, runtime } = await modelRuntime([
    {
      kind: "turn",
      content: [{ type: "tool_call", name: "probe", arguments: { value: "works" } }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    {
      kind: "turn",
      content: [{ type: "text", text: "complete" }],
      terminal: { type: "finish", reason: "stop" },
    },
  ]);
  const sessionManager = SessionManager.inMemory(cwd, { id: "sdk-session" });
  const settingsManager = SettingsManager.inMemory();
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "high",
    sessionManager,
    settingsManager,
    customTools: [customTool],
    tools: ["probe"],
  });

  assert.deepEqual(Object.keys(created).sort(), ["extensionsResult", "session"]);
  assert.equal(created.session.nativeSessionManager, sessionManager);
  assert.equal(created.session.settingsManager, settingsManager);
  assert.equal(created.session.thinkingLevel, "off");
  assert.deepEqual(created.session.getActiveTools(), ["probe"]);
  assert.notEqual(created.extensionsResult.runtime, created.session.extensionRunner);
  assert.equal(created.extensionsResult, created.session.resourceLoader.getExtensions());

  const events: string[] = [];
  const unsubscribe = created.session.subscribe((event) => { events.push(event.type); });
  const result = await created.session.prompt("use the probe");
  unsubscribe();
  assert.equal(result.results.at(-1)?.finalText, "complete");
  assert.equal(executions, 1);
  assert.equal(events.includes("tool_execution_start"), true);
  const initialHost = getExtensionRuntimeHost(created.extensionsResult.runtime);
  assert.ok(initialHost);
  await created.session.refresh();
  const currentExtensionsResult = created.session.resourceLoader.getExtensions();
  const currentHost = getExtensionRuntimeHost(currentExtensionsResult.runtime);
  assert.ok(currentHost);
  assert.notEqual(currentExtensionsResult, created.extensionsResult);
  assert.notEqual(currentHost, initialHost);
  assert.throws(() => initialHost.onError(() => {}), /closed/u);
  await created.session.close();
  assert.throws(() => currentHost.onError(() => {}), /closed/u);
});

test("session.agent beforeToolCall termination obeys blocked batch semantics and rejects invalid hints", async () => {
  const executionCounts = new Map<string, number>();
  const completedResults = new Map<string, unknown[]>();
  const runCase = async (
    name: string,
    decision: (value: string) => unknown,
  ) => {
    const { cwd, agentDir } = await workspace();
    const tool: HarnessTool = {
      definition: {
        name: "hook_probe",
        description: "Exercise public beforeToolCall termination",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["value"],
          properties: { value: { type: "string" } },
        },
      },
      validate(input) {
        if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.value !== "string") {
          throw new TypeError("hook_probe.value must be a string");
        }
      },
      resources() { return []; },
      async execute() {
        executionCounts.set(name, (executionCounts.get(name) ?? 0) + 1);
        return { content: "executed", isError: false };
      },
    };
    const { model, runtime } = await modelRuntime([
      {
        kind: "turn",
        content: [
          { type: "tool_call", id: `${name}-one`, name: "hook_probe", arguments: { value: "one" } },
          { type: "tool_call", id: `${name}-two`, name: "hook_probe", arguments: { value: "two" } },
        ],
        terminal: { type: "finish", reason: "tool_calls" },
      },
      {
        kind: "turn",
        content: [{ type: "text", text: `continued:${name}` }],
        terminal: { type: "finish", reason: "stop" },
      },
    ]);
    const created = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory(),
      customTools: [tool],
      tools: ["hook_probe"],
    });
    created.session.agent.beforeToolCall = async ({ toolCall }) => decision(String(toolCall.arguments.value)) as never;
    const unsubscribe = created.session.subscribe((event) => {
      if (event.type !== "tool_execution_end") return;
      completedResults.set(name, [...(completedResults.get(name) ?? []), event.result]);
    });
    try {
      return await created.session.prompt(`run ${name}`);
    } finally {
      unsubscribe();
      await created.session.close();
    }
  };

  const mixed = await runCase("mixed", (value) => value === "one"
    ? { block: true, reason: "final", terminate: true }
    : { block: true, reason: "not final" });
  assert.equal(mixed.results.at(-1)?.steps, 2);
  assert.equal(mixed.results.at(-1)?.finalText, "continued:mixed");
  assert.equal(executionCounts.get("mixed") ?? 0, 0);

  const all = await runCase("all", () => ({ block: true, reason: "final", terminate: true }));
  assert.equal(all.results.at(-1)?.steps, 1);
  assert.equal(executionCounts.get("all") ?? 0, 0);

  const ignored = await runCase("ignored", () => ({ block: false, terminate: true }));
  assert.equal(ignored.results.at(-1)?.steps, 2);
  assert.equal(ignored.results.at(-1)?.finalText, "continued:ignored");
  assert.equal(executionCounts.get("ignored"), 2);

  const invalid = await runCase("invalid", () => ({ block: true, terminate: "yes" }));
  assert.equal(invalid.results.at(-1)?.steps, 2);
  assert.equal(executionCounts.get("invalid") ?? 0, 0);
  assert.match(JSON.stringify(completedResults.get("invalid")), /terminate must be boolean/u);

  const invalidBlock = await runCase("invalid-block", () => ({ block: "yes" }));
  assert.equal(invalidBlock.results.at(-1)?.steps, 2);
  assert.equal(executionCounts.get("invalid-block") ?? 0, 0);
  assert.match(JSON.stringify(completedResults.get("invalid-block")), /block must be boolean/u);

  const invalidReason = await runCase("invalid-reason", () => ({ block: true, reason: 7 }));
  assert.equal(invalidReason.results.at(-1)?.steps, 2);
  assert.equal(executionCounts.get("invalid-reason") ?? 0, 0);
  assert.match(JSON.stringify(completedResults.get("invalid-reason")), /reason must be a string/u);

  const unknownField = await runCase("invalid-unknown", () => ({ block: true, ownerControlled: true }));
  assert.equal(unknownField.results.at(-1)?.steps, 2);
  assert.equal(executionCounts.get("invalid-unknown") ?? 0, 0);
  assert.match(JSON.stringify(completedResults.get("invalid-unknown")), /unknown field/u);

  let toJsonCalls = 0;
  const customPrototype = Object.assign(Object.create({
    toJSON() {
      toJsonCalls += 1;
      return { block: false };
    },
  }) as Record<string, unknown>, { block: true });
  const invalidPrototype = await runCase("invalid-prototype", () => customPrototype);
  assert.equal(invalidPrototype.results.at(-1)?.steps, 2);
  assert.equal(executionCounts.get("invalid-prototype") ?? 0, 0);
  assert.equal(toJsonCalls, 0);
  assert.match(JSON.stringify(completedResults.get("invalid-prototype")), /plain object/u);

  let getterCalls = 0;
  const accessorDecision = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessorDecision, "block", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return false;
    },
  });
  const invalidAccessor = await runCase("invalid-accessor", () => accessorDecision);
  assert.equal(invalidAccessor.results.at(-1)?.steps, 2);
  assert.equal(executionCounts.get("invalid-accessor") ?? 0, 0);
  assert.equal(getterCalls, 0);
  assert.match(JSON.stringify(completedResults.get("invalid-accessor")), /enumerable data properties/u);

  const oversizedReason = await runCase("invalid-reason-size", () => ({
    block: true,
    reason: "x".repeat((16 * 1024) + 1),
  }));
  assert.equal(oversizedReason.results.at(-1)?.steps, 2);
  assert.equal(executionCounts.get("invalid-reason-size") ?? 0, 0);
  assert.match(JSON.stringify(completedResults.get("invalid-reason-size")), /reason exceeds 16384 bytes/u);
});

test("createAgentSession executes public tool definitions with a session context", async () => {
  const { cwd, agentDir } = await workspace();
  const updates: string[] = [];
  let invocation: { toolCallId: string; value: string; cwd: string; sessionId: string } | undefined;
  const customTool = defineTool({
    name: "direct_probe",
    label: "Direct probe",
    description: "Exercise the public SDK tool authoring contract",
    renderShell: "self",
    parameters: Type.Object({
      value: Type.String(),
    }, { additionalProperties: false }),
    renderCall(input, _theme, renderer) {
      (renderer.state as { seen?: string }).seen = input.value;
      return {
        render: () => [`CALL ${input.value} ${renderer.cwd}`],
        invalidate() {},
      };
    },
    renderResult(result, _options, _theme, renderer) {
      return {
        render: () => [
          `RESULT ${result.content[0]?.type === "text" ? result.content[0].text : ""} ${
            String((renderer.state as { seen?: string }).seen)
          }`,
        ],
        invalidate() {},
      };
    },
    async execute(toolCallId, input, signal, onUpdate, context) {
      signal?.throwIfAborted();
      invocation = {
        toolCallId,
        value: input.value,
        cwd: context.cwd,
        sessionId: context.sessionManager.getSessionId(),
      };
      onUpdate?.({
        content: [{ type: "text", text: `running ${input.value}` }],
        details: { phase: "running" },
      });
      updates.push(input.value);
      return {
        content: [{ type: "text", text: input.value }],
        details: { phase: "complete" },
      };
    },
  });
  const { model, runtime } = await modelRuntime([
    {
      kind: "turn",
      content: [{ type: "tool_call", id: "direct-call", name: "direct_probe", arguments: { value: "works" } }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    {
      kind: "turn",
      content: [{ type: "text", text: "complete" }],
      terminal: { type: "finish", reason: "stop" },
    },
  ]);
  const sessionManager = SessionManager.inMemory(cwd, { id: "direct-tool-session" });
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
    customTools: [customTool],
    tools: ["direct_probe"],
  });

  assert.deepEqual(created.session.getActiveTools(), ["direct_probe"]);
  const renderer = created.session.toolRendererBinding();
  assert.ok(renderer);
  const renderView = {
    callId: "direct-call",
    name: "direct_probe",
    input: { value: "works" },
    result: { content: "works", isError: false },
    argsComplete: true,
    executionStarted: true,
    status: "completed" as const,
    expanded: true,
  };
  const renderContext = {
    width: 120,
    height: 30,
    focused: false,
    expanded: true,
    theme: { name: "mono" as const, color: true, unicode: true },
  };
  assert.equal(renderer.has("direct_probe"), true);
  assert.equal(renderer.renderShell?.("direct_probe"), "self");
  assert.equal(
    renderer.renderCall("direct_probe", renderView, renderContext)?.lines[0]?.spans[0]?.text,
    `CALL works ${cwd}`,
  );
  assert.equal(
    renderer.renderResult("direct_probe", renderView, renderContext)?.lines[0]?.spans[0]?.text,
    "RESULT works works",
  );
  const result = await created.session.prompt("use the direct probe");
  assert.equal(result.results.at(-1)?.finalText, "complete");
  assert.deepEqual(invocation, {
    toolCallId: "direct-call",
    value: "works",
    cwd,
    sessionId: "direct-tool-session",
  });
  assert.deepEqual(updates, ["works"]);
  await created.session.close();
});

test("session.agent normalizes nullish content from untyped tool results and progress", async () => {
  const { cwd, agentDir } = await workspace();
  const { model, runtime } = await modelRuntime([
    {
      kind: "turn",
      content: [{ type: "tool_call", id: "empty-call", name: "empty_agent_tool", arguments: {} }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    {
      kind: "turn",
      content: [{ type: "text", text: "complete" }],
      terminal: { type: "finish", reason: "stop" },
    },
  ]);
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    noTools: "all",
  });
  const tool: AgentTool = {
    name: "empty_agent_tool",
    label: "Empty agent tool",
    description: "Returns no text",
    parameters: Type.Object({}),
    async execute(_toolCallId, _input, _signal, onUpdate) {
      onUpdate?.({ details: { phase: "missing" } } as never);
      onUpdate?.({ content: null, details: { phase: "null" } } as never);
      return { details: { phase: "complete" } } as never;
    },
  };
  created.session.agent.state.tools = [tool];
  const progress: unknown[] = [];
  created.session.subscribe((event) => {
    if (event.type === "tool_execution_update") progress.push(event.partialResult);
  });

  const result = await created.session.prompt("run the empty tool");
  assert.equal(result.results.at(-1)?.finalText, "complete");
  assert.deepEqual(progress, [
    { type: "result", content: "", isError: false, metadata: { phase: "missing" } },
    { type: "result", content: "", isError: false, metadata: { phase: "null" } },
  ]);
  const toolMessage = created.session.agent.state.messages.find((message) => message.role === "toolResult");
  assert.deepEqual(toolMessage?.content, []);
  assert.deepEqual(toolMessage?.details, { phase: "complete" });
  await created.session.close();
});

test("extension execution and rendering win custom-tool name collisions", async (context) => {
  const { cwd, agentDir } = await workspace();
  const executions: string[] = [];
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{
      name: "renderer-collision",
      factory(api) {
        api.registerTool({
          name: "collision_probe",
          label: "Extension collision probe",
          description: "Extension collision fixture",
          parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
          renderShell: "self",
          renderCall(input) {
            return {
              render: () => [`EXTENSION ${input.value}`],
              invalidate() {},
            };
          },
          async execute(_toolCallId, input) {
            executions.push(`extension:${input.value}`);
            return {
              content: [{ type: "text", text: input.value }],
              details: null,
            };
          },
        });
        api.registerTool({
          name: "unrendered_collision",
          label: "Unrendered extension collision probe",
          description: "Extension collision fixture without a renderer",
          parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
          async execute(_toolCallId, input) {
            executions.push(`extension-unrendered:${input.value}`);
            return {
              content: [{ type: "text", text: input.value }],
              details: null,
            };
          },
        });
      },
    }],
  });
  await loader.refresh();
  const customTool = defineTool({
    name: "collision_probe",
    label: "Custom collision probe",
    description: "Custom collision fixture",
    parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
    renderShell: "default",
    renderCall(input) {
      return {
        render: () => [`CUSTOM ${input.value}`],
        invalidate() {},
      };
    },
    async execute(_toolCallId, input) {
      executions.push(`custom:${input.value}`);
      return {
        content: [{ type: "text", text: input.value }],
        details: null,
      };
    },
  });
  const unrenderedCustomTool = defineTool({
    name: "unrendered_collision",
    label: "Custom unrendered collision probe",
    description: "Custom renderer that must not leak onto the extension executable",
    parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
    renderCall(input) {
      return {
        render: () => [`CUSTOM LEAK ${input.value}`],
        invalidate() {},
      };
    },
    async execute(_toolCallId, input) {
      executions.push(`custom-unrendered:${input.value}`);
      return {
        content: [{ type: "text", text: input.value }],
        details: null,
      };
    },
  });
  const { model, runtime } = await modelRuntime([
    {
      kind: "turn",
      content: [{
        type: "tool_call",
        id: "collision-call",
        name: "collision_probe",
        arguments: { value: "works" },
      }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    {
      kind: "turn",
      content: [{
        type: "tool_call",
        id: "unrendered-collision-call",
        name: "unrendered_collision",
        arguments: { value: "plain" },
      }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    {
      kind: "turn",
      content: [{ type: "text", text: "collision complete" }],
      terminal: { type: "finish", reason: "stop" },
    },
  ]);
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    customTools: [customTool, unrenderedCustomTool],
    tools: ["collision_probe", "unrendered_collision"],
  });
  context.after(async () => {
    await created.session.close().catch(() => undefined);
    await getExtensionRuntimeHost(loader.getExtensions().runtime)?.close().catch(() => undefined);
  });

  const renderer = created.session.toolRendererBinding();
  assert.ok(renderer);
  assert.equal(renderer.renderShell?.("collision_probe"), "self");
  assert.equal(
    renderer.renderCall("collision_probe", {
      callId: "collision-call",
      name: "collision_probe",
      input: { value: "works" },
      argsComplete: true,
      executionStarted: true,
      status: "running",
      expanded: true,
    }, {
      width: 120,
      height: 30,
      focused: false,
      expanded: true,
      theme: { name: "mono", color: true, unicode: true },
    })?.lines[0]?.spans[0]?.text,
    "EXTENSION works",
  );
  assert.equal(renderer.has("unrendered_collision"), false);
  assert.equal(renderer.renderShell?.("unrendered_collision"), undefined);
  assert.equal(
    renderer.renderCall("unrendered_collision", {
      callId: "unrendered-collision-call",
      name: "unrendered_collision",
      input: { value: "plain" },
      argsComplete: true,
      executionStarted: true,
      status: "running",
      expanded: true,
    }, {
      width: 120,
      height: 30,
      focused: false,
      expanded: true,
      theme: { name: "mono", color: true, unicode: true },
    }),
    undefined,
  );

  const result = await created.session.prompt("use the collision probe");
  assert.equal(result.results.at(-1)?.finalText, "collision complete");
  assert.deepEqual(executions, ["extension:works", "extension-unrendered:plain"]);
});

test("createAgentSession routes claimed tools through the supplied execution backend", async () => {
  const { cwd, agentDir } = await workspace();
  let localExecutions = 0;
  const requests: Array<{ name: string; workspace: string }> = [];
  const customTool: HarnessTool = {
    definition: {
      name: "backend_probe",
      description: "Exercise the SDK tool backend",
      inputSchema: { type: "object", additionalProperties: false },
    },
    validate() {},
    resources() { return []; },
    async execute() {
      localExecutions += 1;
      return { content: "local", isError: false };
    },
  };
  const backend: ToolExecutionBackend = {
    id: "sdk-test",
    handles(name) { return name === "backend_probe"; },
    resources(request) {
      requests.push({ name: request.invocation.name, workspace: request.workspace });
      return [{ kind: "workspace", key: "workspace", mode: "read" }];
    },
    async execute(request) {
      requests.push({ name: request.invocation.name, workspace: request.workspace });
      return { content: "backend", isError: false };
    },
  };
  const { model, runtime } = await modelRuntime([
    {
      kind: "turn",
      content: [{ type: "tool_call", name: "backend_probe", arguments: {} }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    {
      kind: "turn",
      content: [{ type: "text", text: "complete" }],
      terminal: { type: "finish", reason: "stop" },
    },
  ]);
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    customTools: [customTool],
    tools: ["backend_probe"],
    toolBackend: backend,
  });

  const result = await created.session.prompt("use the backend probe");
  assert.equal(result.results.at(-1)?.finalText, "complete");
  assert.equal(localExecutions, 0);
  assert.deepEqual(requests, [
    { name: "backend_probe", workspace: cwd },
    { name: "backend_probe", workspace: cwd },
  ]);
  await created.session.close();
});

test("createAgentSession enforces host authorization before model-requested tool execution", async (context) => {
  const { cwd, agentDir } = await workspace();
  const settingsManager = SettingsManager.inMemory();
  let executions = 0;
  const tool: HarnessTool = {
    definition: {
      name: "approval_probe",
      description: "Exercise the host approval boundary",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } },
      },
    },
    validate(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.value !== "string") {
        throw new TypeError("value must be a string");
      }
    },
    resources(input) {
      return [{ kind: "file", key: String((input as { value: string }).value), mode: "write" }];
    },
    async execute() {
      executions += 1;
      return { content: "executed", isError: false };
    },
  };
  const { model, runtime } = await modelRuntime([
    {
      kind: "turn",
      content: [{ type: "tool_call", id: "approval-call", name: "approval_probe", arguments: { value: "original" } }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    {
      kind: "turn",
      content: [{ type: "text", text: "denial observed" }],
      terminal: { type: "finish", reason: "stop" },
    },
  ]);
  const approvals: Array<{ value: string; workspaceRoot: string; runId: string; threadId: string }> = [];
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    customTools: [tool],
    tools: ["approval_probe"],
    toolAuthorizationHandler(request, authorizationContext) {
      assert.equal(Object.isFrozen(authorizationContext), true);
      assert.equal(Object.isFrozen(authorizationContext.owner), true);
      assert.deepEqual(authorizationContext.owner, { kind: "host" });
      approvals.push({
        value: String((request.invocation.input as { value: string }).value),
        workspaceRoot: authorizationContext.workspaceRoot,
        runId: authorizationContext.runId,
        threadId: authorizationContext.threadId,
      });
      assert.equal(request.invocation.callId, "approval-call");
      assert.deepEqual(request.resources, [{ kind: "file", key: "original", mode: "write" }]);
      assert.equal(request.backendId, "local");
      assert.equal(request.recovered, false);
      return { decision: "deny", reason: "host denied" };
    },
  });
  context.after(async () => {
    await created.session.close().catch(() => undefined);
  });

  const direct = await created.session.executeBash("echo direct", undefined, { excludeFromContext: true });
  assert.equal(direct.exitCode, 0);
  assert.equal(approvals.length, 0);
  const result = await created.session.prompt("request approval");

  assert.equal(result.results.at(-1)?.finalText, "denial observed");
  assert.equal(executions, 0);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.value, "original");
  assert.equal(approvals[0]?.workspaceRoot, cwd);
  assert.equal(approvals[0]?.threadId, created.session.sessionId);
  assert.notEqual(approvals[0]?.runId, "");
});

test("AgentSession serializes host authorization for parallel tool calls", async (context) => {
  const { cwd, agentDir } = await workspace();
  const executions: string[] = [];
  const tool: HarnessTool = {
    definition: {
      name: "parallel_approval_probe",
      description: "Exercise serialized host authorization",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "string" } },
      },
    },
    validate(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.value !== "string") {
        throw new TypeError("value must be a string");
      }
    },
    resources() { return []; },
    async execute(input) {
      executions.push(String((input as { value: string }).value));
      return { content: "executed", isError: false };
    },
  };
  const { model, runtime } = await modelRuntime([
    {
      kind: "turn",
      content: [
        { type: "tool_call", id: "approval-first", name: "parallel_approval_probe", arguments: { value: "first" } },
        { type: "tool_call", id: "approval-second", name: "parallel_approval_probe", arguments: { value: "second" } },
      ],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    {
      kind: "turn",
      content: [{ type: "text", text: "parallel approvals complete" }],
      terminal: { type: "finish", reason: "stop" },
    },
  ]);
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolveFirst) => { releaseFirst = resolveFirst; });
  context.after(() => releaseFirst());
  let reportFirst!: () => void;
  const firstStarted = new Promise<void>((resolveFirst) => { reportFirst = resolveFirst; });
  let reportSecond!: () => void;
  const secondStarted = new Promise<void>((resolveSecond) => { reportSecond = resolveSecond; });
  const approvalOrder: string[] = [];
  let activeApprovals = 0;
  let maximumActiveApprovals = 0;
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    customTools: [tool],
    tools: ["parallel_approval_probe"],
    async toolAuthorizationHandler(request) {
      activeApprovals += 1;
      maximumActiveApprovals = Math.max(maximumActiveApprovals, activeApprovals);
      const callId = request.invocation.callId;
      approvalOrder.push(callId);
      try {
        if (callId === "approval-first") {
          reportFirst();
          await firstGate;
        } else {
          reportSecond();
        }
        return { decision: "allow_once" };
      } finally {
        activeApprovals -= 1;
      }
    },
  });
  context.after(async () => await created.session.close().catch(() => undefined));

  const running = created.session.prompt("run both tools");
  await firstStarted;
  await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
  assert.deepEqual(approvalOrder, ["approval-first"]);
  assert.equal(maximumActiveApprovals, 1);
  releaseFirst();
  await secondStarted;
  const result = await running;

  assert.equal(result.results.at(-1)?.finalText, "parallel approvals complete");
  assert.deepEqual(approvalOrder, ["approval-first", "approval-second"]);
  assert.equal(maximumActiveApprovals, 1);
  assert.deepEqual(executions.sort(), ["first", "second"]);
});

test("session.agent applies mutable state and low-level stream configuration to a real run", async () => {
  const { cwd, agentDir } = await workspace();
  const { model, runtime, modelRuntime: publicRuntime } = await modelRuntime();
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    noTools: "all",
  });
  const agent = created.session.agent;
  assert.equal(agent.state, agent.state);
  const publicModel = publicRuntime.getModel(model.provider, model.id);
  assert.ok(publicModel);
  const probeParameters = Type.Object({ value: Type.String() });
  const probe: AgentTool<typeof probeParameters> = {
    name: "agent_probe",
    label: "Agent probe",
    description: "Return a value",
    parameters: probeParameters,
    async execute(_callId, input) {
      return { content: [{ type: "text", text: String(input.value) }], details: { source: "agent" } };
    },
  };
  const seed = { role: "user" as const, content: [{ type: "text" as const, text: "seed" }], timestamp: Date.now() };
  agent.state.systemPrompt = "agent-owned prompt";
  agent.state.messages = [seed];
  agent.state.tools = [probe];
  agent.state.model = publicModel;
  assert.equal(agent.state.model.id, publicModel.id);
  assert.deepEqual(agent.state.messages, [seed]);
  assert.deepEqual(agent.state.tools.map((tool) => tool.name), ["agent_probe"]);

  agent.sessionId = "provider-session";
  agent.thinkingBudgets = { low: 17, medium: 23 };
  agent.transport = "websocket";
  agent.timeoutMs = 123;
  agent.maxRetries = 2;
  agent.maxRetryDelayMs = 321;
  agent.toolExecution = "sequential";
  const payloadHook = async (payload: unknown) => payload;
  const responseHook = async () => {};
  agent.onPayload = payloadHook;
  agent.onResponse = responseHook;
  agent.getApiKey = (provider) => provider === publicModel.provider ? "agent-key" : undefined;
  let transformCalls = 0;
  agent.transformContext = async (messages) => {
    transformCalls += 1;
    return messages;
  };
  agent.convertToLlm = (messages) => messages.filter((message) =>
    message.role === "user" || message.role === "assistant" || message.role === "toolResult");

  let observedContext: Context | undefined;
  let observedOptions: SimpleStreamOptions | undefined;
  agent.streamFunction = (selected, context, options) => {
    observedContext = context;
    observedOptions = options;
    const stream = createAssistantMessageEventStream();
    const counters = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "custom stream complete" }],
      api: selected.api,
      provider: selected.provider,
      model: selected.id,
      usage: {
        ...counters,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
    return stream;
  };

  const events: AgentEvent["type"][] = [];
  const listener = (event: AgentEvent): void => { events.push(event.type); };
  const unsubscribe = agent.subscribe(listener);
  const result = await created.session.prompt("run custom stream");
  unsubscribe();
  assert.equal(result.results.at(-1)?.finalText, "custom stream complete");
  assert.equal(transformCalls, 1);
  assert.equal(observedContext?.systemPrompt, "agent-owned prompt");
  assert.deepEqual(observedContext?.messages.filter((message) => message.role === "user").map((message) =>
    typeof message.content === "string" ? message.content : message.content[0]?.type === "text" ? message.content[0].text : ""), [
    "seed",
    "run custom stream",
  ]);
  assert.deepEqual(observedContext?.tools?.map((tool) => tool.name), ["agent_probe"]);
  assert.equal(observedOptions?.apiKey, "agent-key");
  assert.equal(observedOptions?.sessionId, "provider-session");
  assert.deepEqual(observedOptions?.thinkingBudgets, { low: 17, medium: 23 });
  assert.equal(observedOptions?.transport, "websocket");
  assert.equal(observedOptions?.timeoutMs, 123);
  assert.equal(observedOptions?.maxRetries, 2);
  assert.equal(observedOptions?.maxRetryDelayMs, 321);
  assert.equal(observedOptions?.onPayload, payloadHook);
  assert.equal(observedOptions?.onResponse, responseHook);
  assert.deepEqual(events, [
    "agent_start",
    "turn_start",
    "message_start",
    "message_end",
    "message_start",
    "message_update",
    "message_update",
    "message_update",
    "message_end",
    "turn_end",
    "agent_end",
  ]);

  agent.reset();
  assert.deepEqual(agent.state.messages, []);
  assert.equal(agent.state.isStreaming, false);
  assert.equal(agent.state.errorMessage, undefined);
  assert.equal(agent.sessionId, "provider-session");
  await created.session.close();
});

test("session.agent runs a caller-owned model through caller-owned stream and auth callbacks", async (context) => {
  const { cwd, agentDir } = await workspace();
  const { model, runtime, modelRuntime: publicRuntime } = await modelRuntime();
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    noTools: "all",
  });
  context.after(async () => await created.session.close());

  const registered = publicRuntime.getModel(model.provider, model.id);
  assert.ok(registered);
  const callerOwned: Model<Api> = {
    ...structuredClone(registered),
    id: "caller-owned-model",
    name: "Caller-owned model",
    provider: "caller-owned-provider",
  };
  const agent = created.session.agent;
  let requestedApiKeyProvider: string | undefined;
  let streamedModel: Model<Api> | undefined;
  agent.getApiKey = (provider) => {
    requestedApiKeyProvider = provider;
    return "caller-owned-key";
  };
  agent.streamFunction = (selected, _context, options) => {
    streamedModel = selected;
    assert.equal(options?.apiKey, "caller-owned-key");
    const stream = createAssistantMessageEventStream();
    const counters = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "caller-owned stream complete" }],
      api: selected.api,
      provider: selected.provider,
      model: selected.id,
      usage: {
        ...counters,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
    return stream;
  };

  agent.state.model = callerOwned;
  assert.equal(agent.state.model.id, callerOwned.id);
  assert.equal(agent.state.model.provider, callerOwned.provider);
  const modelChange = created.session.sessionManager.getEntries()
    .filter((entry) => entry.type === "model_change")
    .at(-1);
  assert.deepEqual(modelChange === undefined ? undefined : {
    provider: modelChange.provider,
    modelId: modelChange.modelId,
  }, {
    provider: callerOwned.provider,
    modelId: callerOwned.id,
  });
  await assert.rejects(created.session.setModel({
    provider: "ordinary-unregistered-provider",
    api: model.api,
    id: "ordinary-unregistered-model",
  }), /Provider adapter is not registered/u);
  assert.equal(agent.state.model.id, callerOwned.id);
  const result = await created.session.prompt("use caller-owned transport");
  assert.equal(result.results.at(-1)?.finalText, "caller-owned stream complete");
  assert.equal(streamedModel?.id, callerOwned.id);
  assert.equal(streamedModel?.provider, callerOwned.provider);
  assert.equal(requestedApiKeyProvider, callerOwned.provider);
  assert.equal(agent.state.errorMessage, undefined);
});

test("prepareNextTurn installs a brand-new tool only at the next turn boundary", async () => {
  const { cwd, agentDir } = await workspace();
  let bootstrapExecutions = 0;
  let nextExecutions = 0;
  const bootstrap: HarnessTool = {
    definition: {
      name: "bootstrap",
      description: "Complete the first turn",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    validate() {},
    resources: () => [],
    async execute() {
      bootstrapExecutions += 1;
      return { content: "bootstrapped", isError: false };
    },
  };
  const nextTool: AgentTool = {
    name: "next_probe",
    label: "Next probe",
    description: "Runs after the tool registry swap",
    parameters: Type.Object({}),
    async execute() {
      nextExecutions += 1;
      return { content: [{ type: "text", text: "next ran" }], details: undefined };
    },
  };
  const { model, runtime } = await modelRuntime([
    {
      kind: "turn",
      content: [{ type: "tool_call", name: "bootstrap", arguments: {} }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    {
      kind: "turn",
      content: [{ type: "tool_call", name: "next_probe", arguments: {} }],
      terminal: { type: "finish", reason: "tool_calls" },
    },
    {
      kind: "turn",
      content: [{ type: "text", text: "boundary complete" }],
      terminal: { type: "finish", reason: "stop" },
    },
  ]);
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    customTools: [bootstrap],
    tools: ["bootstrap"],
  });
  const hookOrder: string[] = [];
  created.session.agent.beforeToolCall = async ({ toolCall }) => {
    hookOrder.push(`before:${toolCall.name}`);
    return undefined;
  };
  created.session.agent.afterToolCall = async ({ toolCall }) => {
    hookOrder.push(`after:${toolCall.name}`);
    return undefined;
  };
  let preparations = 0;
  created.session.agent.prepareNextTurnWithContext = ({ context }) => {
    preparations += 1;
    if (preparations !== 1) return undefined;
    assert.deepEqual(context.tools?.map((tool) => tool.name), ["bootstrap"]);
    return { context: { ...context, tools: [nextTool] } };
  };

  const result = await created.session.prompt("swap tools after the first turn");
  assert.equal(result.results.at(-1)?.finalText, "boundary complete");
  assert.equal(bootstrapExecutions, 1);
  assert.equal(nextExecutions, 1);
  assert.equal(preparations, 2);
  assert.deepEqual(hookOrder, [
    "before:bootstrap",
    "after:bootstrap",
    "before:next_probe",
    "after:next_probe",
  ]);
  assert.deepEqual(created.session.agent.state.tools.map((tool) => tool.name), ["next_probe"]);
  await created.session.close();
});

test("createAgentSession keeps a supplied loader intact and binds extensions only on request", async () => {
  const { cwd, agentDir } = await workspace();
  const lifecycle: Array<{ type: string; reason?: string; threadId?: string; mode?: string }> = [];
  const settingsManager = SettingsManager.inMemory();
  const dynamicSkill = join(cwd, "dynamic-skill");
  await mkdir(dynamicSkill);
  await writeFile(join(dynamicSkill, "SKILL.md"), "---\nname: sdk-dynamic\ndescription: SDK dynamic resource\n---\n\n# Dynamic\n");
  const brokenExtension = join(cwd, "broken-extension.mjs");
  await writeFile(brokenExtension, "export default function () { throw new Error('activation failed'); }\n");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [brokenExtension],
    extensionFactories: [{
      name: "lifecycle-fixture",
      factory(api) {
        api.registerTool({
          name: "extension_probe",
          label: "Extension probe",
          description: "Extension fixture",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            return { content: [{ type: "text", text: "extension" }], details: null };
          },
        });
        api.on("session_start", (event, context) => {
          lifecycle.push({
            type: event.type,
            mode: context.mode,
            ...(event.reason === undefined ? {} : { reason: event.reason }),
          });
        });
        api.on("resources_discover", () => {
          lifecycle.push({ type: "resources_discover" });
          return { skillPaths: [dynamicSkill] };
        });
        api.on("session_shutdown", (event) => {
          lifecycle.push({ type: event.type, reason: event.reason });
        });
      },
    }],
  });
  await loader.refresh();
  let refreshCalls = 0;
  const supplied = delegateResourceLoader(loader, async () => {
    refreshCalls += 1;
    throw new Error("createAgentSession must not refresh a caller-owned ResourceLoader");
  });
  const { model, runtime } = await modelRuntime();
  const manager = SessionManager.inMemory(cwd, { id: "extension-session" });
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: manager,
    settingsManager,
    resourceLoader: supplied,
    noTools: "builtin",
    sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: "/tmp/previous.jsonl" },
  });

  assert.equal(refreshCalls, 0);
  assert.equal(created.extensionsResult.extensions.some((entry) => entry.path.includes("lifecycle-fixture")), true);
  assert.equal(created.extensionsResult.errors.some((entry) =>
    entry.path.includes("broken-extension.mjs") && entry.error.includes("activation failed")), true);
  assert.deepEqual(created.session.getActiveTools(), ["extension_probe"]);
  assert.equal(lifecycle.length, 0);
  await created.session.bindExtensions({ mode: "sdk" });
  assert.equal(lifecycle[0]?.type, "session_start");
  assert.equal(lifecycle[0]?.reason, "resume");
  assert.equal(lifecycle[0]?.mode, "sdk");
  assert.equal(lifecycle[1]?.type, "resources_discover");
  assert.equal(
    supplied.getSkills().skills.some((skill) => skill.name === "sdk-dynamic"),
    true,
    JSON.stringify({
      skills: supplied.getSkills(),
      extensionDiagnostics: getExtensionRuntimeHost(loader.getExtensions().runtime)?.diagnostics(),
    }),
  );

  const host = getExtensionRuntimeHost(created.extensionsResult.runtime);
  assert.ok(host);
  await created.session.close();
  assert.equal(lifecycle.some((entry) => entry.type === "session_shutdown"), false);
  assert.equal(host.tools().some((tool) => tool.definition.name === "extension_probe"), true);
  const unsubscribe = host.onError(() => {});
  unsubscribe();
  await host.close();
  await created.session.close();
});

test("construction failure closes an SDK-created fallback host without refreshing the supplied loader", async () => {
  const { cwd, agentDir } = await workspace();
  const extensionRuntime = createExtensionRuntime();
  const exactExtensionsResult = { extensions: [], errors: [], runtime: extensionRuntime };
  let refreshCalls = 0;
  const resourceLoader: ResourceLoader = {
    getExtensions: () => exactExtensionsResult,
    getSkills() { return { skills: [], diagnostics: [] }; },
    getPrompts() { return { prompts: [], diagnostics: [] }; },
    getThemes() { return { themes: [], diagnostics: [] }; },
    getAgentsFiles() { return { agentsFiles: [] }; },
    getSystemPrompt() { return undefined; },
    getAppendSystemPrompt() { return []; },
    extendResources() {},
    async refresh() { refreshCalls += 1; },
  };
  const { runtime } = await modelRuntime();
  const invalidTool = {
    get definition(): never { throw new Error("custom tool construction failed"); },
    validate() {},
    resources() { return []; },
    async execute() { return { content: "unused", isError: false }; },
  } as HarnessTool;

  await assert.rejects(createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
    customTools: [invalidTool],
  }), /custom tool construction failed/u);

  assert.equal(refreshCalls, 0);
  const fallbackHost = getExtensionRuntimeHost(extensionRuntime);
  assert.ok(fallbackHost);
  assert.throws(() => fallbackHost.onError(() => {}), /closed/u);
  assert.throws(() => extensionRuntime.getCommands(), /stale|disposed/u);
});

test("createAgentSession reports model restoration fallback without replacing caller state", async () => {
  const { cwd, agentDir } = await workspace();
  const manager = SessionManager.inMemory(cwd);
  manager.appendModelChange("missing", "gone");
  manager.appendMessage({
    id: "user-existing",
    role: "user",
    content: [{ type: "text", text: "existing" }],
    createdAt: new Date(0).toISOString(),
  });
  const { runtime } = await modelRuntime();
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory(),
    noTools: "all",
  });
  assert.match(created.modelFallbackMessage ?? "", /Could not restore model missing\/gone/u);
  assert.match(created.modelFallbackMessage ?? "", /Using sdk-fixture\/fixture-model/u);
  assert.equal(created.session.messages.some((message) => {
    if (message.role !== "user") return false;
    return typeof message.content === "string"
      ? message.content === "existing"
      : message.content.some((block) => block.type === "text" && block.text === "existing");
  }), true);
  await created.session.close();
});
