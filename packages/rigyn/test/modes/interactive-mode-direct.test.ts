import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import type { QueuedRunMessage } from "../../src/core/agent.js";
import type { EventEnvelope } from "../../src/core/events.js";
import type { ResourceLoader } from "../../src/core/resource-loader.js";
import type { AdapterEvent, ProviderAdapter, ProviderRequest } from "../../src/core/types.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import {
  createExtensionRuntime,
  ensureExtensionRuntimeHost,
  projectLoadedExtensionHost,
} from "../../src/extensions/compat.js";
import { loadDirectExtensions } from "../../src/extensions/runtime.js";
import { InteractiveMode } from "../../src/modes/interactive-mode.js";
import { ModelRegistry } from "../../src/providers/model-registry.js";
import {
  createModels,
  createProvider,
  type ProviderModel,
} from "../../src/providers/models.js";
import { providerModelToInfo } from "../../src/providers/internal-runtime-bridge.js";
import { SCOPED_MODELS_NONE } from "../../src/providers/model-scope.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import {
  AgentSession,
  type AgentSessionEventListener,
  type AgentSessionRecoveryOptions,
  type AgentSessionSuspendedRun,
} from "../../src/service/agent-session.js";
import { AgentSessionRuntime } from "../../src/service/agent-session-runtime.js";
import { SessionManager } from "../../src/storage/session-manager.js";
import { TuiController, TuiSelectionCancelledError } from "../../src/tui/controller.js";
import type { TuiAction, TuiContext, TuiInput, TuiOperatorPreferences } from "../../src/tui/types.js";
import { RIGYN_VERSION } from "../../src/version.js";

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("interactive mode owns one rich viewport and preserves renderer overrides", { concurrency: false }, async () => {
  const settings = SettingsManager.inMemory({
    showHardwareCursor: true,
  });
  const runtime = {
    session: { settingsManager: settings },
    cwd: process.cwd(),
    services: { agentDir: process.cwd() },
    setBeforeSessionInvalidate() {},
    setRebindSession() {},
  } as unknown as AgentSessionRuntime;
  const preferences: Partial<TuiOperatorPreferences>[] = [];
  const controllers: TuiController[] = [];
  const actionHandlers: Array<((action: TuiAction) => void) | undefined> = [];
  const originalPreferences = TuiController.prototype.setOperatorPreferences;
  const originalActionHandler = TuiController.prototype.setActionHandler;
  TuiController.prototype.setOperatorPreferences = function capturePreferences(value) {
    preferences.push(value);
    originalPreferences.call(this, value);
  };
  TuiController.prototype.setActionHandler = function captureController(handler) {
    controllers.push(this);
    actionHandlers.push(handler);
    originalActionHandler.call(this, handler);
  };
  try {
    const input = new PassThrough() as PassThrough & TuiInput;
    const output = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
    input.isTTY = true;
    input.setRawMode = () => input;
    output.columns = 100;
    output.rows = 30;
    output.isTTY = true;
    const persisted = new InteractiveMode(runtime, {
      terminalOptions: { input, output, mode: "full", handleSignals: false },
    });
    assert.equal(controllers.at(-1)?.capabilities.alternateScreen, true);
    assert.equal(preferences.at(-1)?.fullscreenScrollbar, "auto");
    assert.equal(preferences.at(-1)?.showHardwareCursor, true);
    assert.equal(preferences.at(-1)?.hideThinkingBlock, false);
    actionHandlers.at(-1)?.({ type: "toggle_thinking_visibility" });
    persisted.stop();

    const overridden = new InteractiveMode(runtime, {
      terminalOptions: {
        input,
        output,
        mode: "full",
        handleSignals: false,
        operatorPreferences: { fullscreenScrollbar: "never", showHardwareCursor: false },
      },
    });
    assert.equal(controllers.at(-1)?.capabilities.alternateScreen, true);
    assert.equal(preferences.at(-1)?.fullscreenScrollbar, "never");
    assert.equal(preferences.at(-1)?.showHardwareCursor, false);
    overridden.stop();
  } finally {
    TuiController.prototype.setOperatorPreferences = originalPreferences;
    TuiController.prototype.setActionHandler = originalActionHandler;
  }
});

test("streaming TUI context updates do not rescan the session graph", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-interactive-context-stream-"));
  const extensionRuntime = createExtensionRuntime();
  const extensionsResult = { extensions: [], errors: [], runtime: extensionRuntime };
  const loader: ResourceLoader = {
    async refresh() {},
    extendResources() {},
    getAppendSystemPrompt: () => [],
    getSystemPrompt: () => undefined,
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getExtensions: () => extensionsResult,
  };
  const models = new ModelRegistry(createModels());
  await models.refresh({ allowNetwork: false });
  const sessionManager = SessionManager.inMemory(cwd, { id: "streaming-context" });
  const session = await AgentSession.create({
    sessionManager,
    providers: new ProviderRegistry(),
    modelRegistry: models,
    resourceLoader: loader,
    extensionsResult,
    workspace: cwd,
    agentDirectory: join(cwd, ".agent"),
    settingsManager: SettingsManager.inMemory(),
    initialToolSelection: { names: [] },
  });
  const envelopeListeners = new Set<(event: EventEnvelope) => void | Promise<void>>();
  const sessionListeners = new Set<AgentSessionEventListener>();
  const onEvent = session.onEvent.bind(session);
  const subscribe = session.subscribe.bind(session);
  Object.defineProperty(session, "onEvent", {
    configurable: true,
    value(listener: (event: EventEnvelope) => void | Promise<void>) {
      envelopeListeners.add(listener);
      const unsubscribe = onEvent(listener);
      return (): void => {
        envelopeListeners.delete(listener);
        unsubscribe();
      };
    },
  });
  Object.defineProperty(session, "subscribe", {
    configurable: true,
    value(listener: AgentSessionEventListener) {
      sessionListeners.add(listener);
      const unsubscribe = subscribe(listener);
      return (): void => {
        sessionListeners.delete(listener);
        unsubscribe();
      };
    },
  });
  const getSessionStats = session.getSessionStats.bind(session);
  let contextTokens = 100;
  let statsReads = 0;
  let contextReads = 0;
  Object.defineProperty(session, "getSessionStats", {
    configurable: true,
    value() {
      statsReads += 1;
      return getSessionStats();
    },
  });
  Object.defineProperty(session, "getContextUsage", {
    configurable: true,
    value() {
      contextReads += 1;
      return {
        tokens: contextTokens,
        contextWindow: 1_000,
        percent: contextTokens / 10,
        source: "estimated" as const,
        autoCompactionThresholdPercent: 85,
      };
    },
  });
  const runtime = new AgentSessionRuntime(
    session,
    { cwd, agentDir: join(cwd, ".agent") },
    async () => { throw new Error("fixture does not replace sessions"); },
  );
  const input = new PassThrough();
  const output = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  output.columns = 100;
  output.rows = 30;
  output.isTTY = false;
  const terminal = new TuiController({ input, output, mode: "accessible", handleSignals: false });
  const contexts: TuiContext[] = [];
  const setContext = terminal.setContext.bind(terminal);
  terminal.setContext = (value) => {
    contexts.push(value);
    setContext(value);
  };
  const mode = new InteractiveMode(runtime, { terminal });

  try {
    await mode.init();
    statsReads = 0;
    contextReads = 0;
    for (let sequence = 1; sequence <= 128; sequence += 1) {
      const event: EventEnvelope = {
        eventId: `stream-${sequence}`,
        threadId: session.sessionId,
        sequence,
        timestamp: "2026-01-01T00:00:00.000Z",
        schemaVersion: 1,
        event: { type: "text_delta", text: "x", part: 0 },
      };
      for (const listener of envelopeListeners) void listener(event);
      for (const listener of sessionListeners) {
        void listener({ type: "bash_execution_update", id: "stream", delta: "x" });
      }
    }
    assert.equal(statsReads, 0);
    assert.equal(contextReads, 0);

    contextTokens = 321;
    sessionManager.appendMessage({
      id: "usage-bearing-message",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      usage: { inputTokens: 300, outputTokens: 21 },
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    await waitFor(() => contextReads === 1, "a durable session append did not refresh context usage");
    assert.equal(statsReads, 0);
    assert.equal(contexts.at(-1)?.contextTokens, 321);
  } finally {
    mode.stop();
    await runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("interactive model cycling preserves scoped order and per-model thinking", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-interactive-model-cycle-"));
  const extensionRuntime = createExtensionRuntime();
  const extensionsResult = { extensions: [], errors: [], runtime: extensionRuntime };
  const loader: ResourceLoader = {
    async refresh() {},
    extendResources() {},
    getAppendSystemPrompt: () => [],
    getSystemPrompt: () => undefined,
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getExtensions: () => extensionsResult,
  };
  const model = (id: string): ProviderModel => ({
    id,
    name: id,
    api: "openai-responses",
    provider: "cycle-provider",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    thinkingLevelMap: { max: null },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10_000,
    maxTokens: 1_000,
  });
  const alpha = model("alpha");
  const beta = model("beta");
  const gamma = model("gamma");
  const directModels = createModels();
  directModels.setProvider(createProvider({
    id: "cycle-provider",
    auth: {
      apiKey: {
        name: "Fixture key",
        async resolve() { return { auth: {}, source: "fixture" }; },
      },
    },
    models: [alpha, beta, gamma],
    api: { async *stream() {} },
  }));
  const models = new ModelRegistry(directModels);
  await models.refresh({ allowNetwork: false });
  const sessionModel = (entry: ProviderModel) => ({
    provider: entry.provider,
    api: entry.api,
    id: entry.id,
    info: providerModelToInfo(entry),
  });
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd, { id: "interactive-model-cycle" }),
    providers: new ProviderRegistry([{
      id: "cycle-provider",
      async *stream() {},
      async listModels() { return [alpha, beta, gamma].map(providerModelToInfo); },
    }]),
    modelRegistry: models,
    resourceLoader: loader,
    extensionsResult,
    workspace: cwd,
    agentDirectory: join(cwd, ".agent"),
    settingsManager: SettingsManager.inMemory({
      keybindings: { "app.model.cycleBackward": "ctrl+g" },
    }),
    initialToolSelection: { names: [] },
    model: sessionModel(gamma),
    thinkingLevel: "low",
    scopedModels: [
      { model: gamma, thinkingLevel: "low" },
      { model: beta, thinkingLevel: "max" },
      { model: alpha, thinkingLevel: "medium" },
    ],
  });
  let betaResolveStarted = false;
  const selectedModels: string[] = [];
  const originalResolveModel = session.resolveModel.bind(session);
  session.resolveModel = async (reference, options) => {
    if (reference.includes("/beta")) {
      betaResolveStarted = true;
      const signal = options?.signal;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, 100);
        signal?.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(signal.reason);
        }, { once: true });
      });
    }
    return await originalResolveModel(reference, options);
  };
  const originalSetModel = session.setModel.bind(session);
  session.setModel = async (model, source) => {
    await originalSetModel(model, source);
    selectedModels.push(model.id);
  };
  const runtime = new AgentSessionRuntime(
    session,
    { cwd, agentDir: join(cwd, ".agent") },
    async () => { throw new Error("fixture does not replace sessions"); },
  );
  const input = new PassThrough();
  const output = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  output.columns = 100;
  output.rows = 30;
  output.isTTY = false;
  const terminal = new TuiController({ input, output, mode: "accessible", handleSignals: false });
  const pickerValues: unknown[][] = [];
  const scopedPickerValues: unknown[][] = [];
  const cycleValues: unknown[][] = [];
  const setModelPickerItems = terminal.setModelPickerItems.bind(terminal);
  terminal.setModelPickerItems = (all, scoped) => {
    pickerValues.push(all.map((item) => item.value));
    scopedPickerValues.push((scoped ?? []).map((item) => item.value));
    setModelPickerItems(all, scoped);
  };
  const setModelCycleItems = terminal.setModelCycleItems.bind(terminal);
  terminal.setModelCycleItems = (items) => {
    cycleValues.push((items ?? []).map((item) => item.value));
    setModelCycleItems(items);
  };
  const mode = new InteractiveMode(runtime, { terminal });

  try {
    await mode.init();
    assert.deepEqual(pickerValues.at(-1), [
      { provider: "cycle-provider", model: "alpha" },
      { provider: "cycle-provider", model: "beta" },
      { provider: "cycle-provider", model: "gamma" },
    ]);
    assert.deepEqual(scopedPickerValues.at(-1), [
      { provider: "cycle-provider", model: "gamma", thinkingLevel: "low" },
      { provider: "cycle-provider", model: "beta", thinkingLevel: "max" },
      { provider: "cycle-provider", model: "alpha", thinkingLevel: "medium" },
    ]);
    assert.deepEqual(cycleValues.at(-1), [
      { provider: "cycle-provider", model: "gamma", thinkingLevel: "low" },
      { provider: "cycle-provider", model: "beta", thinkingLevel: "max" },
      { provider: "cycle-provider", model: "alpha", thinkingLevel: "medium" },
    ]);
    input.write(Buffer.from([16]));
    await waitFor(() => betaResolveStarted, "the first overlapping model selection did not start");
    input.write(Buffer.from([7]));
    await waitFor(
      () => session.model?.id === "alpha" && session.thinkingLevel === "medium",
      "interactive model cycling did not keep the latest ordered scoped model and thinking level",
    );
    assert.deepEqual(selectedModels, ["alpha"]);
  } finally {
    mode.stop();
    await runtime.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("interactive startup does not retain a stale session subscription after adoption", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-interactive-adoption-"));
  const agentDir = join(cwd, ".agent");
  const createSession = async (
    id: string,
    keybinding: string,
    providerId: string,
    modelId: string,
  ): Promise<AgentSession> => {
    const extensionRuntime = createExtensionRuntime();
    const extensionsResult = { extensions: [], errors: [], runtime: extensionRuntime };
    const loader: ResourceLoader = {
      async refresh() {},
      extendResources() {},
      getAppendSystemPrompt: () => [],
      getSystemPrompt: () => undefined,
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getExtensions: () => extensionsResult,
    };
    const directModels = createModels();
    directModels.setProvider(createProvider({
      id: providerId,
      auth: {
        apiKey: {
          name: "Fixture key",
          async resolve() { return { auth: {}, source: "fixture" }; },
        },
      },
      models: [{
        id: modelId,
        name: modelId,
        api: "openai-responses",
        provider: providerId,
        baseUrl: "https://example.test/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10_000,
        maxTokens: 1_000,
      } satisfies ProviderModel],
      api: { async *stream() {} },
    }));
    const models = new ModelRegistry(directModels);
    await models.refresh({ allowNetwork: false });
    return await AgentSession.create({
      sessionManager: SessionManager.inMemory(cwd, { id }),
      providers: new ProviderRegistry(),
      modelRegistry: models,
      resourceLoader: loader,
      extensionsResult,
      workspace: cwd,
      agentDirectory: agentDir,
      settingsManager: SettingsManager.inMemory({ keybindings: { "app.model.select": keybinding } }),
      initialToolSelection: { names: [] },
    });
  };
  const trackedSubscriptions = (session: AgentSession): (() => number) => {
    const subscribe = session.subscribe.bind(session);
    let active = 0;
    Object.defineProperty(session, "subscribe", {
      configurable: true,
      value(listener: Parameters<AgentSession["subscribe"]>[0]) {
        active += 1;
        const unsubscribe = subscribe(listener);
        let subscribed = true;
        return (): void => {
          if (!subscribed) return;
          subscribed = false;
          active -= 1;
          unsubscribe();
        };
      },
    });
    return () => active;
  };

  const initial = await createSession("startup", "alt+i", "initial-provider", "initial-model");
  const replacement = await createSession("replacement", "alt+r", "replacement-provider", "replacement-model");
  const initialSubscriptions = trackedSubscriptions(initial);
  const replacementSubscriptions = trackedSubscriptions(replacement);
  let releaseInitialBind!: () => void;
  let signalInitialBind!: () => void;
  const initialBindStarted = new Promise<void>((resolve) => { signalInitialBind = resolve; });
  const initialBindRelease = new Promise<void>((resolve) => { releaseInitialBind = resolve; });
  const bindExtensions = initial.bindExtensions.bind(initial);
  let observedInitialBindSignal: AbortSignal | undefined;
  Object.defineProperty(initial, "bindExtensions", {
    configurable: true,
    value: async (...args: Parameters<AgentSession["bindExtensions"]>) => {
      observedInitialBindSignal = args[1];
      signalInitialBind();
      await initialBindRelease;
      await bindExtensions(...args);
    },
  });

  const runtime = new AgentSessionRuntime(
    initial,
    { cwd, agentDir },
    async () => { throw new Error("fixture does not replace sessions"); },
  );
  const input = new PassThrough();
  const output = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  output.columns = 100;
  output.rows = 30;
  output.isTTY = false;
  const terminal = new TuiController({ input, output, mode: "accessible", handleSignals: false });
  let themeSubscriptions = 0;
  const onThemeChange = terminal.onThemeChange.bind(terminal);
  terminal.onThemeChange = (...args) => {
    themeSubscriptions += 1;
    return onThemeChange(...args);
  };
  const pickerModels: string[][] = [];
  const setModelPickerItems = terminal.setModelPickerItems.bind(terminal);
  terminal.setModelPickerItems = (all, scoped) => {
    pickerModels.push(all.map((item) => item.id));
    setModelPickerItems(all, scoped);
  };
  const cycleModels: string[][] = [];
  const setModelCycleItems = terminal.setModelCycleItems.bind(terminal);
  terminal.setModelCycleItems = (items) => {
    cycleModels.push((items ?? []).map((item) => item.id));
    setModelCycleItems(items);
  };
  const replacementHost = replacement.extensionRunner.getRuntimeHost();
  const uiHandlers = new Map<string, unknown>();
  type UiSetter =
    | "setUiHandler"
    | "setAdvancedUiHandler"
    | "setNativeUiHandler"
    | "setUnsafeTerminalHandler"
    | "setInteractiveUiHandler"
    | "setDirectUiHandler";
  const mutableHost = replacementHost as unknown as Record<UiSetter, (handler: unknown) => void>;
  for (const name of [
    "setUiHandler",
    "setAdvancedUiHandler",
    "setNativeUiHandler",
    "setUnsafeTerminalHandler",
    "setInteractiveUiHandler",
    "setDirectUiHandler",
  ] satisfies UiSetter[]) {
    const setter = mutableHost[name].bind(replacementHost);
    Object.defineProperty(replacementHost, name, {
      configurable: true,
      value(handler: unknown): void {
        uiHandlers.set(name, handler);
        setter(handler);
      },
    });
  }
  const mode = new InteractiveMode(runtime, { terminal });

  try {
    const initialization = mode.init();
    await initialBindStarted;
    await runtime.adoptSession(replacement);
    releaseInitialBind();
    await initialization;

    assert.equal(runtime.session, replacement);
    assert.equal(observedInitialBindSignal?.aborted, true);
    assert.equal(initialSubscriptions(), 0);
    assert.equal(replacementSubscriptions(), 1);
    assert.deepEqual(terminal.keybindingsManager().getKeys("app.model.select"), ["alt+r"]);
    assert.deepEqual(pickerModels.at(-1), ["replacement-provider/replacement-model"]);
    assert.deepEqual(cycleModels.at(-1), ["replacement-provider/replacement-model"]);

    const directHandler = uiHandlers.get("setDirectUiHandler") as (
      extensionId: string,
      signal: AbortSignal,
      ownerKey: string,
      generationSignal?: AbortSignal,
    ) => ReturnType<typeof replacement.extensionRunner.getUIContext>;
    const sharedGeneration = new AbortController();
    const sharedCallbacks = Array.from({ length: 32 }, () => new AbortController());
    const subscriptionsBeforeSharedGeneration = themeSubscriptions;
    const sharedContexts = sharedCallbacks.map((callback) => directHandler(
      "shared-generation",
      callback.signal,
      "shared-generation:source",
      sharedGeneration.signal,
    ));
    assert.notEqual(sharedContexts[0], sharedContexts.at(-1));
    assert.equal(
      themeSubscriptions - subscriptionsBeforeSharedGeneration,
      1,
      "one extension generation must create one heavyweight direct UI context",
    );
    for (const callback of sharedCallbacks) callback.abort(new Error("shared callback ended"));
    sharedGeneration.abort(new Error("shared generation ended"));
    const sourceA = new AbortController();
    const sourceB = new AbortController();
    const sourceAUi = directHandler("shared", sourceA.signal, "shared:source-a");
    const sourceBUi = directHandler("shared", sourceB.signal, "shared:source-b");
    sourceAUi.setStatus("phase", "source-a");
    sourceBUi.setStatus("phase", "source-b");
    assert.deepEqual([...terminal.extensionStatusSnapshot().values()].sort(), ["source-a", "source-b"]);
    sourceB.abort(new Error("source-b unloaded"));
    assert.deepEqual([...terminal.extensionStatusSnapshot().values()], ["source-a"]);
    sourceA.abort(new Error("source-a unloaded"));
    assert.equal(terminal.extensionStatusSnapshot().size, 0);

    const directUiBeforeStop = uiHandlers.get("setDirectUiHandler");
    mode.stop();
    assert.equal(replacement.extensionRunner.hasUI(), false);
    assert.equal(uiHandlers.get("setUiHandler"), undefined);
    assert.equal(uiHandlers.get("setAdvancedUiHandler"), undefined);
    assert.equal(uiHandlers.get("setNativeUiHandler"), undefined);
    assert.equal(uiHandlers.get("setUnsafeTerminalHandler"), undefined);
    assert.equal(uiHandlers.get("setInteractiveUiHandler"), undefined);
    assert.notEqual(uiHandlers.get("setDirectUiHandler"), directUiBeforeStop);
    assert.equal(uiHandlers.get("setDirectUiHandler"), undefined);
  } finally {
    releaseInitialBind();
    mode.stop();
    await runtime.dispose();
    await initial.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("interactive mode retries initialization, binds extensions, accepts native input, and stops cleanly", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-interactive-mode-"));
  try {
    const extensionRuntime = createExtensionRuntime();
    const extensionHost = ensureExtensionRuntimeHost(extensionRuntime, cwd);
    const themeChanges: unknown[] = [];
    Object.defineProperty(extensionHost, "dispatch", {
      configurable: true,
      value: async (event: string, value: unknown) => {
        if (event === "theme_change") themeChanges.push(value);
      },
    });
    const extensionsResult = { extensions: [], errors: [], runtime: extensionRuntime };
    const skillPath = join(cwd, "skills", "review", "SKILL.md");
    const triageSkillPath = join(cwd, "skills", "triage", "SKILL.md");
    const promptPath = join(cwd, "prompts", "review.md");
    const theme = {
      name: "ocean",
      extensionId: "theme",
      sourcePath: join(cwd, "ocean.json"),
      sha256: "0".repeat(64),
      definition: {
        schemaVersion: 1 as const,
        name: "ocean",
        base: "dark" as const,
        styles: { accent: { foreground: "#00aaff" as const } },
      },
    };
    const loader: ResourceLoader = {
      getExtensions: () => extensionsResult,
      getSkills: () => ({
        skills: [
          {
            name: "review",
            description: "Review the current changes",
            filePath: skillPath,
            baseDir: join(cwd, "skills", "review"),
            sourceInfo: {
              path: skillPath,
              source: "fixture",
              scope: "temporary",
              origin: "top-level",
            },
            disableModelInvocation: false,
          },
          {
            name: "triage",
            description: "Triage the current changes",
            filePath: triageSkillPath,
            baseDir: join(cwd, "skills", "triage"),
            sourceInfo: {
              path: triageSkillPath,
              source: "fixture",
              scope: "temporary",
              origin: "top-level",
            },
            disableModelInvocation: false,
          },
        ],
        diagnostics: [],
      }),
      getPrompts: () => ({
        prompts: [{
          name: "review",
          description: "Review with the canonical prompt",
          content: "Review the current changes.",
          filePath: promptPath,
          sourceInfo: {
            path: promptPath,
            source: "fixture",
            scope: "temporary",
            origin: "top-level",
          },
        }],
        diagnostics: [],
      }),
      getThemes: () => ({ themes: [theme], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => undefined,
      getAppendSystemPrompt: () => [],
      extendResources() {},
      async refresh() {},
    };
    const directModels = createModels();
    const unavailableModel = {
      id: "offline-model",
      name: "Offline model",
      api: "openai-responses",
      provider: "offline-provider",
      baseUrl: "https://example.test/v1",
      contextWindow: 10_000,
      maxTokens: 1_000,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      input: ["text"],
      reasoning: false,
    } satisfies ProviderModel;
    directModels.setProvider(createProvider({
      id: unavailableModel.provider,
      auth: {
        apiKey: {
          name: "Unavailable key",
          async resolve() { return undefined; },
        },
      },
      models: [unavailableModel],
      api: { async *stream() {} },
    }));
    const models = new ModelRegistry(directModels);
    await models.refresh({ allowNetwork: false });
    const unavailableModelId = `${unavailableModel.provider}/${unavailableModel.id}`;
    const settings = SettingsManager.inMemory({
      theme: "ocean",
      enableSkillCommands: true,
      enabledModels: [unavailableModelId],
    });
    const session = await AgentSession.create({
      sessionManager: SessionManager.inMemory(cwd),
      providers: new ProviderRegistry(),
      modelRegistry: models,
      resourceLoader: loader,
      extensionsResult,
      workspace: cwd,
      agentDirectory: join(cwd, ".agent"),
      settingsManager: settings,
      initialToolSelection: { names: [] },
    });
    let bindAttempts = 0;
    let failNextBind = true;
    const bindExtensions = session.bindExtensions.bind(session);
    Object.defineProperty(session, "bindExtensions", {
      configurable: true,
      value: async (...args: Parameters<AgentSession["bindExtensions"]>) => {
        bindAttempts += 1;
        if (failNextBind) {
          failNextBind = false;
          throw new Error("temporary extension bind failure");
        }
        await bindExtensions(...args);
      },
    });
    const runtime = new AgentSessionRuntime(
      session,
      { cwd, agentDir: join(cwd, ".agent") },
      async () => { throw new Error("fixture does not replace sessions"); },
    );
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
    output.columns = 100;
    output.rows = 30;
    output.isTTY = false;
    const terminal = new TuiController({ input, output, mode: "accessible", handleSignals: false });
    let modelPickerOpens = 0;
    const openPicker = terminal.openPicker.bind(terminal);
    terminal.openPicker = (kind, title, initialQuery) => {
      if (kind === "model") modelPickerOpens += 1;
      openPicker(kind, title, initialQuery);
    };
    const notifications: Array<{ message: string; kind: "status" | "warning" | "error" }> = [];
    const notify = terminal.notify.bind(terminal);
    terminal.notify = (message, kind = "status") => {
      notifications.push({ message, kind });
      notify(message, kind);
    };
    let transcriptReplacements = 0;
    const replaceTranscript = terminal.replaceTranscript.bind(terminal);
    terminal.replaceTranscript = (...request) => {
      transcriptReplacements += 1;
      replaceTranscript(...request);
    };
    const contexts: TuiContext[] = [];
    const setContext = terminal.setContext.bind(terminal);
    terminal.setContext = (context) => {
      contexts.push(context);
      setContext(context);
    };
    let dispatchAction: ((action: TuiAction) => void) | undefined;
    const setActionHandler = terminal.setActionHandler.bind(terminal);
    terminal.setActionHandler = (handler) => {
      dispatchAction = handler;
      setActionHandler(handler);
    };
    const commandItems: string[][] = [];
    const setCommandItems = terminal.setCommandItems.bind(terminal);
    terminal.setCommandItems = (items) => {
      commandItems.push(items.map((item) => item.value));
      setCommandItems(items);
    };
    const modelCycleItemCounts: Array<number | undefined> = [];
    const setModelCycleItems = terminal.setModelCycleItems.bind(terminal);
    terminal.setModelCycleItems = (items) => {
      modelCycleItemCounts.push(items?.length);
      setModelCycleItems(items);
    };
    let scopedPickerCalls = 0;
    terminal.chooseScopedModels = async (items, options) => {
      scopedPickerCalls += 1;
      assert.deepEqual(items, []);
      assert.equal(options.all, false);
      assert.deepEqual(options.selected, scopedPickerCalls === 1 ? [unavailableModelId] : []);
      assert.equal(options.live, true);

      if (scopedPickerCalls >= 3) return { mode: "none" };

      if (scopedPickerCalls === 2) {
        options.onChange?.({ mode: "models", patterns: [unavailableModelId] });
        assert.deepEqual(session.scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`), [
          unavailableModelId,
        ]);
        assert.equal(session.modelCyclingEnabled, true);
        assert.deepEqual(settings.getEnabledModels(), [SCOPED_MODELS_NONE]);
        throw new TuiSelectionCancelledError();
      }

      options.onChange?.({ mode: "models", patterns: [unavailableModelId] });
      assert.deepEqual(session.scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`), [
        unavailableModelId,
      ]);
      assert.equal(session.modelCyclingEnabled, true);
      assert.deepEqual(settings.getEnabledModels(), [unavailableModelId]);

      options.onChange?.({ mode: "none" });
      assert.deepEqual(session.scopedModels, []);
      assert.equal(session.modelCyclingEnabled, false);
      assert.deepEqual(settings.getEnabledModels(), [unavailableModelId]);
      await options.onSave?.({ mode: "none" });
      return { mode: "none" };
    };
    const mode = new InteractiveMode(runtime, { terminal });

    await assert.rejects(mode.init(), /temporary extension bind failure/u);
    await mode.init();
    await mode.init();
    assert.equal(bindAttempts, 2);
    const extensionErrorSecret = "sk-proj-interactive-mode-redaction-1234567890";
    defaultSecretRedactor.register(extensionErrorSecret);
    session.extensionRunner.emitError({
      extensionPath: `/extensions/before-${extensionErrorSecret}-after.mjs`,
      event: "input",
      error: `extension-before-${extensionErrorSecret}-after`,
    });
    const extensionErrorNotification = notifications.at(-1);
    assert.equal(extensionErrorNotification?.kind, "error");
    assert.equal(extensionErrorNotification?.message.includes(extensionErrorSecret), false);
    assert.match(extensionErrorNotification?.message ?? "", /\[REDACTED\]/u);
    mode.showError(`public-before-${extensionErrorSecret}-after`);
    const publicErrorNotification = notifications.at(-1);
    assert.equal(publicErrorNotification?.kind, "error");
    assert.equal(publicErrorNotification?.message.includes(extensionErrorSecret), false);
    assert.equal(publicErrorNotification?.message, "public-before-[REDACTED]-after");
    input.write("/scoped-models\r");
    await waitFor(() => scopedPickerCalls === 1, "unavailable-only scoped models did not open the picker");
    await waitFor(
      () => settings.getEnabledModels()?.[0] === SCOPED_MODELS_NONE,
      "explicit scoped-model save did not persist the live selection",
    );
    const cycleUpdatesBeforeCancel = modelCycleItemCounts.length;
    input.write("/scoped-models\r");
    await waitFor(() => scopedPickerCalls === 2, "cancelled scoped models did not open the picker");
    await waitFor(() => session.scopedModels.length === 0, "cancelled scoped-model preview was not rolled back");
    assert.equal(session.modelCyclingEnabled, false);
    assert.deepEqual(settings.getEnabledModels(), [SCOPED_MODELS_NONE]);
    assert.ok(modelCycleItemCounts.length >= cycleUpdatesBeforeCancel + 2);
    assert.equal(modelCycleItemCounts.at(-1), 0);
    const replacementsAfterInit = transcriptReplacements;
    mode.renderInitialMessages();
    assert.equal(transcriptReplacements, replacementsAfterInit + 1);
    terminal.setEditorText("remove this draft");
    mode.clearEditor();
    assert.equal(terminal.getEditorText(), "");
    mode.showError("public error");
    mode.showWarning("public warning");
    mode.showNewVersionNotification({ version: "9.8.7", packageName: "rigyn", note: "Release note" });
    mode.showPackageUpdateNotification(["example-package"]);
    assert.deepEqual(notifications.slice(-4).map((entry) => entry.kind), [
      "error",
      "warning",
      "warning",
      "warning",
    ]);
    assert.match(notifications.at(-2)?.message ?? "", /rigyn 9\.8\.7[\s\S]*Release note/u);
    assert.match(notifications.at(-1)?.message ?? "", /rigyn update --all[\s\S]*example-package/u);
    const noticesBeforeEmptyPackageList = notifications.length;
    mode.showPackageUpdateNotification([]);
    assert.equal(notifications.length, noticesBeforeEmptyPackageList);
    assert.equal(commandItems.some((items) => items.includes("/review")), true);
    assert.equal(commandItems.some((items) => items.includes("/skill:review")), false);
    assert.equal(commandItems.some((items) => items.includes("/skill:triage")), true);
    assert.ok(contexts.some((context) =>
      context.releaseVersion === RIGYN_VERSION
      && context.workspace === cwd
      && context.thinkingSupported === undefined));
    assert.equal(terminal.selectedThemeName(), "ocean");
    assert.deepEqual(terminal.themeNames(), ["mono", "ocean", "signal"]);
    terminal.setTheme("mono");
    await waitFor(() => themeChanges.length === 1, "embedded theme change was not forwarded to extensions");
    assert.deepEqual(themeChanges[0], {
      previous: "ocean",
      current: "mono",
      available: ["mono", "ocean", "signal"],
      reason: "selection",
    });
    assert.equal(settings.getLastChangelogVersion(), RIGYN_VERSION);
    const messagesBeforeInput = session.sessionManager.getEntries().filter((entry) => entry.type === "message").length;
    const originalPrompt = session.prompt.bind(session);
    const publicRoutedPrompts: string[] = [];
    Object.defineProperty(session, "prompt", {
      configurable: true,
      value: async (text: string) => {
        publicRoutedPrompts.push(text);
        return { sessionId: session.sessionId, results: [] };
      },
    });
    let capturedInput: string | undefined;
    const pendingInput = mode.getUserInput().then((value) => { capturedInput = value; });
    input.write("/review focus\r");
    await waitFor(() => publicRoutedPrompts.includes("/review focus"), "public prompt command was not routed");
    assert.equal(capturedInput, undefined);
    input.write("/skill:triage inspect\r");
    await waitFor(
      () => publicRoutedPrompts.includes("/skill:triage inspect"),
      "public skill command was not routed",
    );
    assert.equal(capturedInput, undefined);
    const unknownInputStart = notifications.length;
    input.write("/not-a-command\r");
    await waitFor(
      () => notifications.slice(unknownInputStart).some((entry) =>
        entry.kind === "error" && entry.message === "Unknown command: /not-a-command"),
      "public unknown command was not rejected",
    );
    assert.equal(capturedInput, undefined);
    input.write("/help\r");
    await waitFor(
      () => notifications.some((entry) => entry.message.includes("/help")),
      "a command was not handled while public input was pending",
    );
    assert.equal(capturedInput, undefined);
    input.write("host-owned input\r");
    await pendingInput;
    assert.equal(capturedInput, "host-owned input");
    Object.defineProperty(session, "prompt", { configurable: true, value: originalPrompt });
    const firstQueuedInput = mode.getUserInput();
    const secondQueuedInput = mode.getUserInput();
    input.write("first host input\rsecond host input\r");
    assert.deepEqual(await Promise.all([firstQueuedInput, secondQueuedInput]), [
      "first host input",
      "second host input",
    ]);
    assert.equal(
      session.sessionManager.getEntries().filter((entry) => entry.type === "message").length,
      messagesBeforeInput,
      "host-owned input was also submitted to the session",
    );
    const running = mode.run();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const savedNewSession = runtime.newSession.bind(runtime);
    let builtInStarted = false;
    let builtInAborted = false;
    Object.defineProperty(runtime, "newSession", {
      configurable: true,
      value: async (options: Parameters<AgentSessionRuntime["newSession"]>[0] = {}) => {
        builtInStarted = true;
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => {
            builtInAborted = true;
            reject(options.signal?.reason);
          };
          if (options.signal?.aborted === true) abort();
          else options.signal?.addEventListener("abort", abort, { once: true });
        });
        return { cancelled: false };
      },
    });
    input.write("/new\r");
    await waitFor(() => builtInStarted, "built-in /new did not receive an owned cancellation signal");
    input.write("\u001b");
    await waitFor(() => builtInAborted, "Escape did not cancel built-in /new");
    Object.defineProperty(runtime, "newSession", { configurable: true, value: savedNewSession });
    input.write("/name after-cancel\r");
    await waitFor(() => runtime.session.sessionName === "after-cancel", "Escape left the action tail blocked");

    let loginStarted = false;
    let loginAborted = false;
    directModels.setProvider(createProvider({
      id: "cancellable-auth",
      name: "Cancellable auth",
      auth: {
        oauth: {
          name: "OAuth",
          async login(interaction) {
            loginStarted = true;
            await new Promise<void>((_resolve, reject) => {
              const abort = (): void => {
                loginAborted = true;
                reject(interaction.signal?.reason);
              };
              if (interaction.signal?.aborted === true) abort();
              else interaction.signal?.addEventListener("abort", abort, { once: true });
            });
            throw new Error("unreachable");
          },
          async refresh(credential) { return credential; },
          async toAuth(credential) { return { apiKey: credential.access }; },
        },
      },
      models: [],
      api: { async *stream() {} },
    }));
    input.write("/login cancellable-auth\r");
    await waitFor(() => loginStarted, "interactive login did not receive an owned cancellation signal");
    input.write("\u001b");
    await waitFor(() => loginAborted, "Escape did not cancel interactive login");
    input.write("/name after-login-cancel\r");
    await waitFor(
      () => runtime.session.sessionName === "after-login-cancel",
      "cancelled login left the action tail blocked",
    );

    const originalModelRefresh = models.refresh.bind(models);
    let modelRefreshStarted = false;
    let releaseModelRefresh!: () => void;
    let modelRefreshFinished = false;
    Object.defineProperty(models, "refresh", {
      configurable: true,
      value: async (options?: { allowNetwork?: boolean; force?: boolean; signal?: AbortSignal }) => {
        if (options?.force !== true || options.allowNetwork !== true) return await originalModelRefresh(options);
        modelRefreshStarted = true;
        await new Promise<void>((resolve) => { releaseModelRefresh = resolve; });
        const result = await originalModelRefresh({ ...options, allowNetwork: false });
        modelRefreshFinished = true;
        return result;
      },
    });
    const pickerOpensBeforeRefresh = modelPickerOpens;
    input.write("/model\r");
    await waitFor(
      () => modelPickerOpens === pickerOpensBeforeRefresh + 1,
      "interactive model picker waited for its network refresh",
    );
    await waitFor(() => modelRefreshStarted, "interactive model refresh did not receive an owned cancellation signal");
    input.write("\u001b");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    input.write("/name while-models-refresh\r");
    await waitFor(
      () => runtime.session.sessionName === "while-models-refresh",
      "background model refresh blocked the interactive command queue",
    );
    assert.equal(modelRefreshFinished, false);
    input.write("/scoped-models\r");
    await waitFor(
      () => scopedPickerCalls === 3,
      "scoped-model picker waited for the active network refresh",
    );
    releaseModelRefresh();
    await waitFor(() => modelRefreshFinished, "background model refresh did not settle");
    Object.defineProperty(models, "refresh", { configurable: true, value: originalModelRefresh });

    const host = session.extensionRunner.getRuntimeHost();
    const originalRunShortcut = host.runShortcut.bind(host);
    let shortcutStarts = 0;
    let shortcutAborts = 0;
    Object.defineProperty(host, "runShortcut", {
      configurable: true,
      value: async (_shortcut: string, command: { signal: AbortSignal }) => {
        shortcutStarts += 1;
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => {
            shortcutAborts += 1;
            reject(command.signal.reason);
          };
          if (command.signal.aborted) abort();
          else command.signal.addEventListener("abort", abort, { once: true });
        });
      },
    });
    assert.ok(dispatchAction);
    let suspendCalls = 0;
    terminal.suspend = () => { suspendCalls += 1; };
    dispatchAction({ type: "suspend" });
    await waitFor(() => suspendCalls === 1, "suspend action was discarded by interactive mode");
    const pasteContextStart = contexts.length;
    settings.setBlockImages(true);
    dispatchAction({ type: "paste_image" });
    await waitFor(
      () => contexts.slice(pasteContextStart).some((context) => context.active === true),
      "paste-image action was discarded by interactive mode",
    );
    if (contexts.at(-1)?.active === true) {
      dispatchAction({ type: "cancel" });
      await waitFor(() => contexts.at(-1)?.active === false, "paste-image cancellation did not return to idle");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    terminal.setEditorText("");
    settings.setBlockImages(false);
    const overlappingContextStart = contexts.length;
    dispatchAction({ type: "extension_shortcut", shortcut: "first", generation: new AbortController().signal });
    dispatchAction({ type: "extension_shortcut", shortcut: "second", generation: new AbortController().signal });
    await waitFor(() => shortcutStarts === 2, "overlapping extension shortcuts did not start independently");
    assert.equal(contexts.at(-1)?.active, true);
    input.write("\u001b");
    await waitFor(() => shortcutAborts === 2, "Escape did not cancel every overlapping extension shortcut");
    await waitFor(() => contexts.at(-1)?.active === false, "overlapping operation lifecycle did not return to idle");
    const overlappingStates = contexts.slice(overlappingContextStart)
      .flatMap((context) => context.active === undefined ? [] : [context.active]);
    const firstActive = overlappingStates.indexOf(true);
    assert.ok(firstActive >= 0);
    assert.equal(
      overlappingStates.slice(firstActive, -1).every((activeState) => activeState),
      true,
      "one completed operation cleared the terminal while another operation was still active",
    );
    assert.equal(overlappingStates.at(-1), false);
    Object.defineProperty(host, "runShortcut", { configurable: true, value: originalRunShortcut });

    const exportPath = join(cwd, "interactive-export.jsonl");
    input.write("/name direct-mode\r");
    await waitFor(() => runtime.session.sessionName === "direct-mode", "session name command did not settle");
    input.write(`/export ${exportPath}\r`);
    input.write("/resources\r");
    input.write("/hotkeys\r");
    await waitFor(() => existsSync(exportPath), "public interactive export did not complete");
    assert.equal(runtime.session.sessionName, "direct-mode");
    assert.equal(contexts.some((context) => context.sessionName === "direct-mode" && context.workspace === cwd), true);

    const steeringImage = { type: "image" as const, mediaType: "image/png", data: "c3RlZXI=" };
    const followUpImage = { type: "image" as const, mediaType: "image/jpeg", data: "Zm9sbG93" };
    const cancellationQueue: QueuedRunMessage[] = [
      { mode: "steer", text: "steer before cancel", images: [steeringImage] },
      { mode: "follow_up", text: "follow after cancel", images: [followUpImage] },
    ];
    const cancellationOrder: string[] = [];
    const restoredQueue: unknown[] = [];
    let active = true;
    let suspendedRun: AgentSessionSuspendedRun | undefined = {
      operationId: "locally-interrupted-operation",
      acceptedAt: "2026-08-08T12:00:00.000Z",
      cancelled: false,
      attempts: 1,
      claimedQueueIds: [],
      effects: [{
        effectId: "locally-interrupted-write",
        callId: "locally-interrupted-call",
        name: "write",
        policy: "never_repeat",
        status: "dispatched",
        step: 0,
        index: 0,
        inputHash: "locally-interrupted-input",
      }],
    };
    let abortSnapshot: { editor: string; queued: number; reason: string | undefined } | undefined;
    Object.defineProperty(session, "suspendedRun", {
      configurable: true,
      get: () => suspendedRun,
    });
    Object.defineProperty(session, "isIdle", {
      configurable: true,
      get: () => !active && suspendedRun === undefined,
    });
    Object.defineProperty(session, "isStreaming", {
      configurable: true,
      get: () => active,
    });
    Object.defineProperty(session, "getQueuedMessages", {
      configurable: true,
      value: () => cancellationQueue.map((message) => structuredClone(message)),
    });
    Object.defineProperty(session, "dequeueMessage", {
      configurable: true,
      value: () => cancellationQueue.shift(),
    });
    Object.defineProperty(session, "abort", {
      configurable: true,
      value: async (reason?: string) => {
        cancellationOrder.push("abort/recovery");
        abortSnapshot = {
          editor: terminal.getEditorText(),
          queued: cancellationQueue.length,
          reason,
        };
        active = false;
        suspendedRun = suspendedRun === undefined ? undefined : { ...suspendedRun, cancelled: true };
      },
    });
    const recoveryCalls: AgentSessionRecoveryOptions[] = [];
    Object.defineProperty(session, "recoverInterruptedRun", {
      configurable: true,
      value: async (options: AgentSessionRecoveryOptions = {}) => {
        recoveryCalls.push(options);
        const operationId = suspendedRun?.operationId ?? "missing-operation";
        if (suspendedRun !== undefined && (options.resolutions?.length ?? 0) === 0) {
          return {
            recovered: false as const,
            operationId,
            blocked: suspendedRun.effects.map((effect) => ({
              effectId: effect.effectId,
              name: effect.name,
              reason: "This tool cannot be repeated safely.",
            })),
          };
        }
        suspendedRun = undefined;
        return { recovered: true, operationId, blocked: [] as const };
      },
    });
    const submittedAfterInterruption: string[] = [];
    Object.defineProperty(session, "prompt", {
      configurable: true,
      value: async (text: string) => {
        submittedAfterInterruption.push(text);
        return { sessionId: session.sessionId, results: [] };
      },
    });
    const restoreQueuedMessages = terminal.restoreQueuedMessages.bind(terminal);
    terminal.restoreQueuedMessages = (messages) => {
      cancellationOrder.push("restore");
      restoredQueue.push(structuredClone(messages));
      return restoreQueuedMessages(messages);
    };
    const unknownStart = notifications.length;
    input.write("/does-not-exist\r");
    await waitFor(
      () => notifications.slice(unknownStart).some((entry) =>
        entry.kind === "error" && entry.message === "Unknown command: /does-not-exist"),
      "unknown active slash command was not rejected immediately",
    );
    assert.deepEqual(submittedAfterInterruption, []);
    const activeHelpStart = notifications.length;
    input.write("/help\r");
    await waitFor(
      () => notifications.slice(activeHelpStart).some((entry) => entry.message.startsWith("Interactive commands:")),
      "active /help waited for the current turn to finish",
    );
    assert.equal(active, true, "non-mutating /help interrupted the active turn");
    assert.equal(cancellationOrder.length, 0);
    terminal.setEditorText("draft before cancellation");
    input.write("\u001b");
    await waitFor(() => cancellationOrder.includes("abort/recovery"), "Escape did not cancel the active run");
    await waitFor(() => contexts.at(-1)?.active === false, "interrupted recovery remained visually active");
    assert.deepEqual(cancellationOrder, ["restore", "abort/recovery"]);
    assert.deepEqual(restoredQueue, [[
      { mode: "steer", text: "steer before cancel", images: [steeringImage] },
      { mode: "follow_up", text: "follow after cancel", images: [followUpImage] },
    ]]);
    assert.deepEqual(abortSnapshot, {
      editor: "steer before cancel\n\nfollow after cancel\n\ndraft before cancellation",
      queued: 0,
      reason: "Interrupted",
    });
    assert.deepEqual(terminal.takePendingRecoveredImages(), [steeringImage, followUpImage]);
    const notificationStart = notifications.length;
    const sameSession = runtime.session;
    input.write("continue after interrupt\r");
    await waitFor(
      () => submittedAfterInterruption.length === 1,
      "the first post-interrupt submission did not recover and dispatch",
    );
    assert.equal(runtime.session, sameSession);
    assert.deepEqual(submittedAfterInterruption, [
      "steer before cancel\n\nfollow after cancel\n\ndraft before cancellationcontinue after interrupt",
    ]);
    assert.deepEqual(recoveryCalls, [{
      resolutions: [{ effectId: "locally-interrupted-write", outcome: "abandoned" }],
    }]);
    const recoveryNotifications = notifications.slice(notificationStart);
    assert.equal(recoveryNotifications.filter((entry) => entry.kind === "error").length, 0);
    assert.equal(recoveryNotifications.filter((entry) =>
      entry.message.includes("Recovered interrupted operation locally-interrupted-operation")).length, 1);

    suspendedRun = {
      operationId: "restart-interrupted-operation",
      acceptedAt: "2026-08-08T12:01:00.000Z",
      cancelled: true,
      attempts: 1,
      claimedQueueIds: [],
      effects: [{
        effectId: "restart-interrupted-write",
        callId: "restart-interrupted-call",
        name: "write",
        policy: "never_repeat",
        status: "in_doubt",
        step: 0,
        index: 0,
        inputHash: "restart-interrupted-input",
      }],
    };
    const explicitNotificationStart = notifications.length;
    input.write("must remain explicit\r");
    await waitFor(
      () => notifications.slice(explicitNotificationStart).some((entry) =>
        entry.kind === "error" && entry.message.includes("requires explicit recovery")),
      "a restart-like interrupted run was not kept explicit",
    );
    assert.equal(submittedAfterInterruption.length, 1);
    assert.equal(terminal.getEditorText(), "must remain explicit");
    terminal.setEditorText("/recover");
    input.write("\r");
    await waitFor(() => recoveryCalls.length === 3, "automatic /recover did not settle the blocked effect");
    assert.equal(recoveryCalls[1]?.signal instanceof AbortSignal, true);
    assert.equal(recoveryCalls[1]?.resolutions, undefined);
    assert.equal(recoveryCalls[2]?.signal instanceof AbortSignal, true);
    assert.deepEqual(recoveryCalls[2]?.resolutions, [
      { effectId: "restart-interrupted-write", outcome: "abandoned" },
    ]);
    assert.equal(suspendedRun, undefined);
    terminal.setEditorText("");

    let newSessionCalls = 0;
    const originalNewSession = runtime.newSession.bind(runtime);
    Object.defineProperty(runtime, "newSession", {
      configurable: true,
      value: async () => {
        newSessionCalls += 1;
        return { cancelled: false };
      },
    });
    active = true;
    suspendedRun = {
      operationId: "slash-new-operation",
      acceptedAt: "2026-08-08T12:02:00.000Z",
      cancelled: false,
      attempts: 1,
      claimedQueueIds: [],
      effects: [{
        effectId: "slash-new-effect",
        callId: "slash-new-call",
        name: "bash",
        policy: "never_repeat",
        status: "dispatched",
        step: 0,
        index: 0,
        inputHash: "slash-new-input",
      }],
    };
    input.write("/new\r");
    await waitFor(() => newSessionCalls === 1, "active /new did not recover before session replacement");
    assert.deepEqual(recoveryCalls[3]?.resolutions, [
      { effectId: "slash-new-effect", outcome: "abandoned" },
    ]);
    assert.equal(suspendedRun, undefined);
    Object.defineProperty(runtime, "newSession", { configurable: true, value: originalNewSession });

    const abandonedInput = mode.getUserInput();
    input.write("/exit\r");
    await assert.rejects(abandonedInput, /Terminal closed/u);
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        running,
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("interactive mode did not stop")), 2_000); }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    assert.equal(input.listenerCount("data"), 0);
    await runtime.dispose();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("public interactive mode executes active extension resources and queues each expanded prompt once", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-interactive-active-resource-"));
  const agentDir = join(cwd, ".agent");
  const handlerArgs: string[] = [];
  const preflightInputs: string[] = [];
  const host = await loadDirectExtensions([], {
    workspace: cwd,
    activationFailure: "throw",
    inlineExtensions: [{
      name: "public-active-resource",
      factory(api) {
        api.registerCommand("active-resource", {
          handler(args) {
            handlerArgs.push(args);
            return { prompt: `runtime follow-up ${args}` } as never;
          },
        });
        api.on("input", (event) => {
          preflightInputs.push(event.text);
          return { action: "continue" };
        });
      },
    }],
  });
  const extensionsResult = projectLoadedExtensionHost(host);
  const loader: ResourceLoader = {
    async refresh() {},
    extendResources() {},
    getAppendSystemPrompt: () => [],
    getSystemPrompt: () => undefined,
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getExtensions: () => extensionsResult,
  };
  const model: ProviderModel = {
    id: "active-model",
    name: "Active model",
    api: "openai-responses",
    provider: "active-provider",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10_000,
    maxTokens: 1_000,
  };
  let markStarted!: () => void;
  let releaseFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    id: model.provider,
    async *stream(request): AsyncIterable<AdapterEvent> {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        markStarted();
        await firstGate;
      }
      yield { type: "response_start", model: request.model };
      yield { type: "text_delta", part: 0, text: `answer-${requests.length}` };
      yield {
        type: "response_end",
        reason: "stop",
        state: { kind: "openai_responses", outputItems: [] },
      };
    },
    async listModels() { return [providerModelToInfo(model)]; },
  };
  const directModels = createModels();
  directModels.setProvider(createProvider({
    id: model.provider,
    auth: {
      apiKey: {
        name: "Fixture key",
        async resolve() { return { auth: {}, source: "fixture" }; },
      },
    },
    models: [model],
    api: { async *stream() {} },
  }));
  const models = new ModelRegistry(directModels);
  await models.refresh({ allowNetwork: false });
  const session = await AgentSession.create({
    sessionManager: SessionManager.inMemory(cwd, { id: "public-active-resource" }),
    providers: new ProviderRegistry([provider]),
    modelRegistry: models,
    resourceLoader: loader,
    extensionsResult,
    workspace: cwd,
    agentDirectory: agentDir,
    settingsManager: SettingsManager.inMemory(),
    initialToolSelection: { names: [] },
    model: {
      provider: model.provider,
      api: model.api,
      id: model.id,
      info: providerModelToInfo(model),
    },
  });
  const runtime = new AgentSessionRuntime(
    session,
    { cwd, agentDir },
    async () => { throw new Error("fixture does not replace sessions"); },
  );
  const input = new PassThrough();
  const output = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  output.columns = 100;
  output.rows = 30;
  output.isTTY = false;
  const terminal = new TuiController({ input, output, mode: "accessible", handleSignals: false });
  const extensionCatalog = {
    command(name: string) {
      return name === "static-command"
        ? {
            name,
            extensionId: "fixture",
            sourcePath: "/fixture/static-command.md",
            sha256: "0".repeat(64),
            template: "static command {{args}}",
          }
        : undefined;
    },
    prompt(name: string) {
      return name === "static-prompt"
        ? {
            id: name,
            extensionId: "fixture",
            sourcePath: "/fixture/static-prompt.md",
            sha256: "1".repeat(64),
            template: "static prompt {{input}}",
          }
        : undefined;
    },
  };
  const mode = new InteractiveMode(runtime, { terminal, extensionCatalog });
  const requestText = (request: ProviderRequest): string => request.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .at(-1) ?? "";

  try {
    await mode.init();
    const running = mode.run();
    input.write("hold\r");
    await firstStarted;
    assert.equal(session.isStreaming, true);

    input.write("/active-resource now\r");
    await waitFor(() => preflightInputs.includes("runtime follow-up now"), "runtime command prompt was not admitted");
    input.write("/static-command later\r");
    await waitFor(() => preflightInputs.includes("static command later"), "static command was not expanded");
    input.write("/static-prompt topic\r");
    await waitFor(() => preflightInputs.includes("static prompt topic"), "static prompt was not expanded");
    assert.deepEqual(handlerArgs, ["now"]);
    assert.equal(requests.length, 1);
    assert.equal(session.isStreaming, true);

    releaseFirst();
    await waitFor(() => requests.length === 4 && session.isIdle, "expanded follow-ups did not settle");
    assert.deepEqual(requests.map(requestText), [
      "hold",
      "runtime follow-up now",
      "static command later",
      "static prompt topic",
    ]);
    assert.equal(preflightInputs.filter((text) => text === "runtime follow-up now").length, 1);
    input.write("/quit\r");
    await running;
  } finally {
    releaseFirst();
    mode.stop();
    await runtime.dispose();
    await host.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("interactive mode loads config keybindings and refreshes them on refresh", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-interactive-keybindings-"));
  const agentDir = join(cwd, ".agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "config.json"), JSON.stringify({
    theme: "mono",
    keybindings: { "app.model.select": "alt+k" },
  }));
  try {
    let holdResourceRefresh = false;
    let releaseResourceRefresh: (() => void) | undefined;
    let includeReviewPrompt = true;
    const extensionRuntime = createExtensionRuntime();
    const extensionHost = ensureExtensionRuntimeHost(extensionRuntime, cwd);
    const advancedUiGeneration = new AbortController();
    extensionHost.applyAdvancedUi({
      extensionId: "refresh-fixture",
      sourcePath: "<test:refresh-fixture>",
      ownerKey: "refresh-fixture:owner",
      signal: advancedUiGeneration.signal,
      type: "tool_output_expanded",
      expanded: true,
    });
    const extensionsResult = { extensions: [], errors: [], runtime: extensionRuntime };
    const reviewSkillPath = join(agentDir, "skills", "review", "SKILL.md");
    const reviewPromptPath = join(agentDir, "prompts", "review.md");
    const loader: ResourceLoader = {
      supportsTransactionalRefresh: true,
      getExtensions: () => extensionsResult,
      getSkills: () => ({
        skills: [{
          name: "review",
          description: "Review the current changes",
          filePath: reviewSkillPath,
          baseDir: dirname(reviewSkillPath),
          sourceInfo: {
            path: reviewSkillPath,
            source: "fixture",
            scope: "temporary",
            origin: "top-level",
          },
          disableModelInvocation: false,
        }],
        diagnostics: [],
      }),
      getPrompts: () => ({
        prompts: includeReviewPrompt
          ? [{
              name: "review",
              description: "Review with the canonical prompt",
              content: "Review the current changes.",
              filePath: reviewPromptPath,
              sourceInfo: {
                path: reviewPromptPath,
                source: "fixture",
                scope: "temporary",
                origin: "top-level",
              },
            }]
          : [],
        diagnostics: [],
      }),
      getThemes() { return { themes: [], diagnostics: [] }; },
      getAgentsFiles() { return { agentsFiles: [] }; },
      getSystemPrompt() { return undefined; },
      getAppendSystemPrompt() { return []; },
      extendResources() {},
      async refresh() {
        if (!holdResourceRefresh) return;
        await new Promise<void>((resolve) => { releaseResourceRefresh = resolve; });
      },
    };
    const models = new ModelRegistry(createModels());
    await models.refresh({ allowNetwork: false });
    const modelRefreshes: Array<{ allowNetwork?: boolean; force?: boolean }> = [];
    const refreshModels = models.refresh.bind(models);
    Object.defineProperty(models, "refresh", {
      configurable: true,
      value: async (options?: { allowNetwork?: boolean; force?: boolean; signal?: AbortSignal }) => {
        modelRefreshes.push(options ?? {});
        return await refreshModels(options);
      },
    });
    const settings = SettingsManager.create(cwd, agentDir);
    const sessionManager = SessionManager.inMemory(cwd);
    sessionManager.appendMessage({
      id: "embedded-refresh-history",
      role: "user",
      content: [{ type: "text", text: "embedded refresh transcript sentinel" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const session = await AgentSession.create({
      sessionManager,
      providers: new ProviderRegistry(),
      modelRegistry: models,
      resourceLoader: loader,
      extensionsResult,
      workspace: cwd,
      agentDirectory: agentDir,
      settingsManager: settings,
      initialToolSelection: { names: [] },
    });
    const runtime = new AgentSessionRuntime(
      session,
      { cwd, agentDir },
      async () => { throw new Error("fixture does not replace sessions"); },
    );
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
    output.columns = 100;
    output.rows = 30;
    output.isTTY = false;
    let rendered = "";
    output.on("data", (chunk: Buffer) => { rendered += chunk.toString("utf8"); });
    const terminal = new TuiController({ input, output, mode: "accessible", handleSignals: false });
    const advancedUiBindings: Array<{ expanded: boolean; signal: AbortSignal }> = [];
    const setKeyedToolOutputExpanded = terminal.setKeyedToolOutputExpanded.bind(terminal);
    terminal.setKeyedToolOutputExpanded = (key, expanded, signal): void => {
      if (expanded !== undefined && signal !== undefined) advancedUiBindings.push({ expanded, signal });
      setKeyedToolOutputExpanded(key, expanded, signal);
    };
    const commandItems: string[][] = [];
    const setCommandItems = terminal.setCommandItems.bind(terminal);
    terminal.setCommandItems = (items) => {
      commandItems.push(items.map((item) => item.value));
      setCommandItems(items);
    };
    let activeThemeListeners = 0;
    const onThemeChange = terminal.onThemeChange.bind(terminal);
    terminal.onThemeChange = (listener, signal) => {
      activeThemeListeners += 1;
      const unsubscribe = onThemeChange(listener, signal);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        activeThemeListeners -= 1;
        unsubscribe();
      };
    };
    const refreshPresentation: Array<[string | undefined, string | undefined]> = [];
    const setInputBlocked = terminal.setInputBlocked.bind(terminal);
    terminal.setInputBlocked = (message?: string, label?: string): void => {
      refreshPresentation.push([message, label]);
      setInputBlocked(message, label);
    };
    const operatorPreferences: Partial<TuiOperatorPreferences>[] = [];
    const setOperatorPreferences = terminal.setOperatorPreferences.bind(terminal);
    terminal.setOperatorPreferences = (preferences): void => {
      operatorPreferences.push(preferences);
      setOperatorPreferences(preferences);
    };
    const mode = new InteractiveMode(runtime, { terminal });

    await mode.init();
    assert.match(rendered, /embedded refresh transcript sentinel/u);
    assert.equal(commandItems.at(-1)?.includes("/review"), true);
    assert.equal(commandItems.at(-1)?.includes("/skill:review"), false);
    assert.equal(activeThemeListeners, 2, "the mode watcher and live direct-theme facade are both generation-owned");
    assert.equal(terminal.getToolOutputExpanded(), true);
    assert.equal(advancedUiBindings.length, 1);
    assert.equal(advancedUiBindings[0]?.signal.aborted, false);
    extensionHost.applyAdvancedUi({
      extensionId: "refresh-fixture",
      sourcePath: "<test:refresh-fixture>",
      ownerKey: "refresh-fixture:owner",
      signal: advancedUiGeneration.signal,
      type: "tool_output_expanded",
      expanded: false,
    });
    assert.equal(terminal.getToolOutputExpanded(), false);
    assert.equal(terminal.selectedThemeName(), "mono");
    assert.deepEqual(terminal.keybindingsManager().getKeys("app.model.select"), ["alt+k"]);
    const uiBeforeRefresh = session.extensionRunner.getUIContext();
    await writeFile(join(agentDir, "config.json"), JSON.stringify({
      keybindings: { "app.model.select": "alt+j" },
    }));
    const running = mode.run();
    holdResourceRefresh = true;
    includeReviewPrompt = false;
    const refreshOutputStart = rendered.length;
    input.write("/refresh\r");
    await waitFor(() => refreshPresentation.some((entry) => entry[1] === "refresh"), "interactive refresh did not block terminal input");
    await waitFor(() => releaseResourceRefresh !== undefined, "interactive refresh did not reach resource hydration");
    terminal.setEditorText("preserved refresh draft");
    releaseResourceRefresh!();
    await waitFor(
      () => terminal.keybindingsManager().getKeys("app.model.select")[0] === "alt+j",
      "interactive refresh did not refresh persisted keybindings",
    );
    await waitFor(
      () => commandItems.at(-1)?.includes("/skill:review") === true,
      "interactive refresh did not reveal the skill after removing its matching prompt",
    );
    await waitFor(() => refreshPresentation.at(-1)?.[0] === undefined, "interactive refresh did not restore terminal input");
    assert.doesNotMatch(rendered.slice(refreshOutputStart), /embedded refresh transcript sentinel/u);
    assert.equal(activeThemeListeners, 2, "refresh replaces both theme listeners without leaking an old generation");
    assert.deepEqual(
      advancedUiBindings.map((entry) => entry.expanded),
      [true, false, false],
      "refresh did not replay the latest generation-owned advanced UI state",
    );
    assert.equal(advancedUiBindings[0]?.signal.aborted, true, "refresh retained the initial advanced UI binding");
    assert.equal(advancedUiBindings[1]?.signal.aborted, true, "refresh retained a live advanced UI binding");
    assert.equal(advancedUiBindings[2]?.signal.aborted, false);
    assert.match(refreshPresentation[0]?.[0] ?? "", /keyboard mappings, extensions, skills, prompt templates, themes, and instruction files/u);
    assert.equal(refreshPresentation[0]?.[1], "refresh");
    assert.deepEqual(refreshPresentation.at(-1), [undefined, undefined]);
    assert.deepEqual(modelRefreshes.at(-1), { force: false, allowNetwork: false });
    assert.equal(operatorPreferences.at(-1)?.fullscreenScrollbar, "auto");
    assert.equal(terminal.selectedThemeName(), "signal");
    assert.equal(terminal.getEditorText(), "preserved refresh draft");
    assert.notEqual(session.extensionRunner.getUIContext(), uiBeforeRefresh);
    assert.equal(session.extensionRunner.hasUI(), true);
    assert.equal(terminal.getToolOutputExpanded(), false, "refresh discarded the latest advanced UI state");
    input.write(" remains editable");
    await waitFor(() => terminal.getEditorText().endsWith(" remains editable"), "terminal input stayed blocked after refresh");
    input.write("\u001b");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(terminal.getEditorText(), "preserved refresh draft remains editable");
    terminal.setEditorText("");

    holdResourceRefresh = false;
    await writeFile(join(agentDir, "config.json"), JSON.stringify({
      theme: "candidate-theme",
      keybindings: { "app.unknown": "alt+x" },
    }));
    const beforeInvalidSettingsRefresh = refreshPresentation.length;
    input.write("/refresh\r");
    await waitFor(
      () => refreshPresentation.length >= beforeInvalidSettingsRefresh + 2,
      "invalid settings keybindings did not restore terminal input",
    );
    assert.equal(settings.getThemeSetting(), undefined);
    assert.deepEqual(terminal.keybindingsManager().getKeys("app.model.select"), ["alt+j"]);
    assert.deepEqual(refreshPresentation.at(-1), [undefined, undefined]);

    input.write("/exit\r");
    await running;
    assert.equal(terminal.getToolOutputExpanded(), false, "interactive shutdown retained extension UI state");
    advancedUiGeneration.abort(new Error("fixture complete"));
    await runtime.dispose();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
