import assert from "node:assert/strict";
import test from "node:test";

import {
  caughtProcessFailure,
  InteractiveExtensionUiBinder,
  isStructuredOutputFailure,
  loginInteractively,
  parseInteractiveModelReference,
  pickModel,
  runtimeUi,
} from "../../src/cli/main.js";
import { interactiveRuntimeCommandUi } from "../../src/modes/interactive-runtime-ui.js";
import type { LoadedRuntime } from "../../src/cli/runtime.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import type { TerminalPrompter } from "../../src/interfaces/terminal.js";
import type { TuiController } from "../../src/tui/controller.js";

function runtimeWithModels(input: {
  models?: Array<{ id: string; displayName?: string; description?: string; contextTokens?: number }>;
  refresh?: { ok: true } | { ok: false; status: { error?: { message: string } } };
}): LoadedRuntime {
  return {
    providers: {
      refreshModels: async () => input.refresh ?? { ok: true },
      listModels: async () => input.models ?? [],
    },
  } as unknown as LoadedRuntime;
}

test("structured-output classification does not inspect hostile thrown objects", () => {
  let prototypeTrapCalls = 0;
  let descriptorTrapCalls = 0;
  let conversionTrapCalls = 0;
  const hostileFailure = new Proxy({}, {
    getPrototypeOf() {
      prototypeTrapCalls += 1;
      throw new Error("top-level failure prototype must not be inspected");
    },
    getOwnPropertyDescriptor() {
      descriptorTrapCalls += 1;
      throw new Error("top-level failure descriptors must not be inspected");
    },
    get(_target, property) {
      if (property === "toString" || property === Symbol.toPrimitive) conversionTrapCalls += 1;
      throw new Error("top-level failure conversion must not be invoked");
    },
  });

  assert.equal(isStructuredOutputFailure(hostileFailure), false);
  assert.deepEqual(caughtProcessFailure(hostileFailure), { exitCode: 1, message: "[Thrown object]" });
  assert.equal(prototypeTrapCalls, 0);
  assert.equal(descriptorTrapCalls, 0);
  assert.equal(conversionTrapCalls, 0);

  const branded = Object.assign(new Error("branded failure"), { exitCode: 23 });
  assert.deepEqual(caughtProcessFailure(branded), { exitCode: 23, message: "branded failure" });
});

test("explicit provider/model references override the current provider without splitting provider-owned slash model IDs", () => {
  assert.deepEqual(parseInteractiveModelReference("anthropic/claude-sonnet", "openai", ["openai", "anthropic", "openrouter"]), {
    provider: "anthropic",
    model: "claude-sonnet",
  });
  assert.deepEqual(parseInteractiveModelReference("moonshotai/kimi", "openrouter", ["openai", "anthropic", "openrouter"]), {
    provider: "openrouter",
    model: "moonshotai/kimi",
  });
  assert.deepEqual(parseInteractiveModelReference(undefined, "openai", ["openai"]), {
    provider: "openai",
    model: undefined,
  });
});

test("model picker uses verified catalogs and falls back to an exact deployment ID", async () => {
  const prompts: string[] = [];
  const terminal = {
    async choose<T>(prompt: string, choices: Array<{ value: T }>): Promise<T> {
      prompts.push(prompt);
      return choices.at(-1)!.value;
    },
    async question(prompt: string): Promise<string> {
      prompts.push(prompt);
      return " private-deployment ";
    },
  } as TerminalPrompter;

  assert.equal(await pickModel(runtimeWithModels({
    models: [
      { id: "alpha", displayName: "Alpha", contextTokens: 32_000 },
      { id: "beta", description: "Beta model", contextTokens: 64_000 },
    ],
  }), "fixture", terminal), "beta");
  assert.equal(prompts[0], "Select fixture model");

  prompts.length = 0;
  assert.equal(await pickModel(runtimeWithModels({
    refresh: { ok: false, status: { error: { message: "catalog unavailable" } } },
  }), "fixture", terminal), "private-deployment");
  assert.deepEqual(prompts, ["Exact model/deployment ID: "]);

  await assert.rejects(
    pickModel(runtimeWithModels({ models: [] }), "fixture", {
      ...terminal,
      question: async () => "  ",
    }),
    /Model is required/u,
  );
});

test("extension command UI scopes resources and forwards bounded interactions", async () => {
  const calls: Array<{ name: string; values: unknown[] }> = [];
  let theme = "mono";
  let editorText = "draft";
  const record = (name: string, ...values: unknown[]): void => { calls.push({ name, values }); };
  const terminal = {
    notify: (...values: unknown[]) => record("notify", ...values),
    setExtensionStatus: (...values: unknown[]) => record("status", ...values),
    setExtensionWidget: (...values: unknown[]) => record("widget", ...values),
    setExtensionHeader: (...values: unknown[]) => record("header", ...values),
    setExtensionFooter: (...values: unknown[]) => record("footer", ...values),
    setExtensionWorkingMessage: (...values: unknown[]) => record("working-message", ...values),
    setExtensionWorkingVisible: (...values: unknown[]) => record("working-visible", ...values),
    setTitle: (...values: unknown[]) => record("title", ...values),
    setKeyedTitle: (...values: unknown[]) => record("keyed-title", ...values),
    selectedThemeName: () => theme,
    themeNames: () => ["mono", "ocean"],
    setTheme: (value: string) => { theme = value; record("theme", value); },
    choose: async <T>(_prompt: string, choices: Array<{ value: T }>, signal?: AbortSignal): Promise<T> => {
      signal?.throwIfAborted();
      return choices[0]!.value;
    },
    requestInput: async () => "typed input",
    editor: async () => "edited text",
    setEditorText: (value: string) => { editorText = value; },
    getEditorText: () => editorText,
    custom: async () => "custom result",
    showOverlay: () => ({ close: () => record("overlay-close") }),
  } as unknown as TuiController;
  const lifecycle = new AbortController();
  const interaction = new AbortController();
  const ui = runtimeUi(terminal, "fixture", lifecycle.signal, interaction.signal, "fixture-owner");

  ui.notify("ready", "status");
  ui.setStatus("phase", "running");
  ui.setWidget("panel", "widget");
  ui.setHeader("head", "header");
  ui.setFooter("foot", "footer");
  ui.setWorkingMessage("working");
  ui.setWorkingVisible(true);
  ui.setTitle("Fixture title");
  assert.deepEqual(await ui.getTheme(), { name: "mono", available: ["mono", "ocean"] });
  assert.deepEqual(await ui.setTheme("ocean"), { name: "ocean", available: ["mono", "ocean"] });
  assert.equal(await ui.select("Pick", [{ label: "One", value: 1 }]), 1);
  assert.equal(await ui.confirm("Confirm", "Proceed"), true);
  assert.equal(await ui.input("Input", "placeholder"), "typed input");
  assert.equal(await ui.editor("Editor", "prefill"), "edited text");
  ui.setEditorText("replacement");
  assert.equal(ui.getEditorText(), "replacement");
  assert.equal(await ui.custom(() => ({ render: () => ({ lines: [] }), handleKey: () => false })), "custom result");
  ui.showOverlay(() => ({ render: () => ({ lines: [] }), handleKey: () => false })).close();

  assert.deepEqual(calls.filter((entry) => ["status", "widget", "header", "footer"].includes(entry.name)), [
    { name: "status", values: ["fixture-owner:phase", "running", lifecycle.signal] },
    { name: "widget", values: ["fixture-owner:panel", "widget", lifecycle.signal] },
    { name: "header", values: ["fixture-owner:head", "header", lifecycle.signal] },
    { name: "footer", values: ["fixture-owner:foot", "footer", lifecycle.signal] },
  ]);
  assert.deepEqual(calls.find((entry) => entry.name === "working-message")?.values, ["fixture-owner", "working", lifecycle.signal]);
  assert.deepEqual(calls.find((entry) => entry.name === "working-visible")?.values, ["fixture-owner", true, lifecycle.signal]);
  assert.deepEqual(calls.find((entry) => entry.name === "keyed-title")?.values, ["fixture-owner:title", "Fixture title", lifecycle.signal]);
  interaction.abort(new Error("interaction ended"));
  await assert.rejects(ui.select("Pick", [{ label: "One", value: 1 }]), /interaction ended/u);
  lifecycle.abort();
  assert.throws(() => ui.notify("late"), /no longer active/u);
});

test("both interactive extension UI handlers enforce the fallback notification bound", () => {
  const notices: string[] = [];
  const terminal = {
    notify(message: string) { notices.push(message); },
  } as unknown as TuiController;
  const generation = new AbortController();
  const handlers = [
    runtimeUi(terminal, "legacy", generation.signal),
    interactiveRuntimeCommandUi(terminal, "public", generation.signal),
  ];
  const exact = "🙂".repeat(2 * 1024);

  for (const ui of handlers) {
    ui.notify(exact);
    const before = notices.length;
    assert.throws(() => ui.notify(`${exact}x`), /Notification exceeds 8192 bytes/u);
    assert.throws(() => ui.notify("before\0after"), /Notification exceeds 8192 bytes or contains NUL/u);
    assert.equal(notices.length, before, "rejected notices must not reach the terminal");
  }
  assert.deepEqual(notices, [exact, exact]);
});

test("interactive extension UI binds every host surface across startup, refresh, resume, and workspace replacement", () => {
  const calls: Array<{ name: string; values: unknown[] }> = [];
  const terminal = new Proxy({}, {
    get(_target, property) {
      if (property === "selectedThemeName") return () => "mono";
      if (property === "themeNames") return () => ["mono"];
      if (property === "getToolOutputExpanded") return () => false;
      if (property === "actionsForKey") return () => [];
      if (property === "onThemeChange" || property === "registerUnsafeTerminalInputHandler") {
        return (...values: unknown[]) => {
          calls.push({ name: String(property), values });
          return () => undefined;
        };
      }
      return (...values: unknown[]) => { calls.push({ name: String(property), values }); };
    },
  }) as TuiController;

  function fixtureHost(id: string) {
    const lifecycle = new AbortController();
    const handlers: Record<string, unknown> = {};
    const changes = new Set<(value: string) => void>();
    let toolBindingRequests = 0;
    const toolBinding = { has: () => true };
    const host = {
      lifecycleSignal: () => lifecycle.signal,
      toolRendererBinding: () => toolBinding,
      renderers: () => [{ extensionId: id, sourcePath: `/tmp/${id}`, kind: "editor", key: "editor" }],
      entryRenderer: () => undefined,
      messageRenderer: () => undefined,
      renderEditor: () => ({ lines: [], cursor: { row: 0, column: 0 } }),
      shortcuts: () => [{ extensionId: id, sourcePath: `/tmp/${id}`, shortcut: "ctrl+x", description: "fixture" }],
      completeCommandArguments: async () => null,
      hasAutocompleteProviders: () => true,
      completeInput: async () => null,
      hasEditorMiddleware: () => true,
      handleEditorInput: () => undefined,
      commands: () => [{ extensionId: id, sourcePath: `/tmp/${id}`, name: `${id}-command`, description: "fixture" }],
      onChange: (listener: (value: string) => void) => {
        changes.add(listener);
        return () => { changes.delete(listener); };
      },
      initialUi: () => [{
        extensionId: id,
        sourcePath: `/tmp/${id}`,
        ownerKey: `${id}:owner`,
        signal: lifecycle.signal,
        type: "status",
        key: "phase",
        value: "ready",
      }],
      setUiHandler: (value: unknown) => { handlers.ui = value; },
      setAdvancedUiHandler: (value: unknown) => { handlers.advanced = value; },
      setNativeUiHandler: (value: unknown) => { handlers.native = value; },
      setUnsafeTerminalHandler: (value: unknown) => { handlers.unsafe = value; },
      setInteractiveUiHandler: (value: unknown) => { handlers.interactive = value; },
      setDirectUiHandler: (value: unknown) => { handlers.direct = value; },
    };
    return {
      host,
      lifecycle,
      handlers,
      toolBinding,
      requestToolBinding: () => {
        toolBindingRequests += 1;
        return toolBinding;
      },
      toolBindingRequests: () => toolBindingRequests,
      changed: (value: string) => { for (const change of changes) change(value); },
      changeListeners: () => changes.size,
    };
  }

  const runtime = (
    fixture: ReturnType<typeof fixtureHost>,
    workspace: string,
    enableSkillCommands = true,
    promptIds: readonly string[] = ["static-prompt"],
  ): LoadedRuntime => ({
    workspace,
    settings: SettingsManager.inMemory({
      treeFilterMode: "all",
      outputPad: 0,
      autocompleteMaxVisible: 10,
      terminal: { showImages: true, imageWidthCells: 40, clearOnShrink: true },
      markdown: { codeBlockIndent: "" },
      theme: "mono",
      enableSkillCommands,
    }),
    resourceLoader: {
      getSkills: () => ({
        skills: [
          {
            name: "review",
            description: "Review the current changes",
            filePath: "/skills/review/SKILL.md",
          },
          {
            name: "static-prompt",
            description: "Prompt-owned skill",
            filePath: "/skills/static-prompt/SKILL.md",
          },
        ],
        diagnostics: [],
      }),
    },
    session: {
      toolRendererBinding: () => fixture.requestToolBinding(),
    },
    runtimeExtensions: fixture.host,
    extensions: {
      bundle: () => ({
        commands: [{ extensionId: fixture.host.commands()[0]!.extensionId, name: "static-command" }],
        prompts: promptIds.map((id) => ({ extensionId: fixture.host.commands()[0]!.extensionId, id })),
        themes: [],
      }),
    },
  }) as unknown as LoadedRuntime;

  const startup = fixtureHost("startup");
  const binder = new InteractiveExtensionUiBinder(terminal);
  const startupRuntime = runtime(startup, "/workspace-a", false);
  assert.equal(binder.bind(startupRuntime), true);
  assert.ok(["setToolRenderers", "setSessionRenderers", "setExtensionShortcuts",
    "setCommandCompletionProvider", "setCommandItems",
    "setCustomThemes", "setExtensionStatus"].every((name) => calls.some((call) => call.name === name)), calls.map((call) => call.name).join(", "));
  const commandValues = (): string[] => {
    const items = calls.findLast((call) => call.name === "setCommandItems")?.values[0] as Array<{ value: string }> | undefined;
    return items?.map((item) => item.value) ?? [];
  };
  assert.equal(commandValues().includes("/skill:review"), false, "disabled skill commands stay out of installed CLI completion");
  startupRuntime.settings.setEnableSkillCommands(true);
  binder.refreshCommands(startupRuntime);
  assert.equal(commandValues().includes("/skill:review"), true, "enabling skill commands updates installed CLI completion");
  assert.equal(commandValues().includes("/static-prompt"), true, "the prompt remains the canonical visible command");
  assert.equal(commandValues().includes("/skill:static-prompt"), false, "a matching prompt hides the redundant skill command");
  startupRuntime.settings.setEnableSkillCommands(false);
  binder.refreshCommands(startupRuntime);
  assert.equal(commandValues().includes("/skill:review"), false, "disabling skill commands removes installed CLI completion");
  assert.equal(calls.find((call) => call.name === "setToolRenderers")?.values[0], startup.toolBinding);
  const startupBindingSignal = calls.find((call) => call.name === "setToolRenderers")?.values[1] as AbortSignal;
  assert.notEqual(startupBindingSignal, startup.lifecycle.signal);
  assert.equal(startupBindingSignal.aborted, false);
  assert.equal(startup.changeListeners(), 1);
  assert.equal(startup.toolBindingRequests(), 1);
  assert.deepEqual(Object.keys(startup.handlers).sort(), ["advanced", "direct", "interactive", "native", "ui", "unsafe"]);
  const direct = startup.handlers.direct as (
    extensionId: string,
    signal: AbortSignal,
    ownerKey: string,
    generationSignal?: AbortSignal,
  ) => {
    onTerminalInput(handler: (value: string) => unknown): unknown;
  };
  const stressGeneration = new AbortController();
  const themeListenersBeforeStress = calls.filter((call) => call.name === "onThemeChange").length;
  const inputHandlersBeforeStress = calls.filter((call) => call.name === "registerUnsafeTerminalInputHandler").length;
  let firstStressContext: ReturnType<typeof direct> | undefined;
  let lastStressContext: ReturnType<typeof direct> | undefined;
  for (let index = 0; index < 1_000; index += 1) {
    const callback = new AbortController();
    const selected = direct("stress-extension", callback.signal, "stress-extension:source", stressGeneration.signal);
    firstStressContext ??= selected;
    lastStressContext = selected;
  }
  assert.notEqual(firstStressContext, lastStressContext, "each callback receives a lightweight cancellation facade");
  assert.equal(
    calls.filter((call) => call.name === "onThemeChange").length - themeListenersBeforeStress,
    1,
    "one generation creates one heavy theme listener",
  );
  assert.equal(
    calls.filter((call) => call.name === "registerUnsafeTerminalInputHandler").length - inputHandlersBeforeStress,
    1,
    "one generation creates one heavy raw input handler",
  );
  stressGeneration.abort(new Error("stress generation ended"));
  const presentationGeneration = new AbortController();
  const presentationCallback = new AbortController();
  const presentationUi = direct(
    "presentation-extension",
    presentationCallback.signal,
    "presentation-extension:source",
    presentationGeneration.signal,
  );
  presentationUi.onTerminalInput(() => undefined);
  const presentationRegistrationSignal = calls.findLast((call) =>
    call.name === "registerUnsafeTerminalInputHandler")?.values[1] as AbortSignal;
  assert.equal(presentationRegistrationSignal.aborted, false);
  presentationCallback.abort(new Error("callback cancelled"));
  assert.equal(presentationRegistrationSignal.aborted, true, "callback cancellation releases its presentation input");
  assert.equal(presentationGeneration.signal.aborted, false);
  presentationGeneration.abort(new Error("presentation generation ended"));
  const firstGeneration = new AbortController();
  const secondGeneration = new AbortController();
  const firstDirect = direct("same-extension", firstGeneration.signal, "same-extension:source-a");
  assert.equal(direct("same-extension", firstGeneration.signal, "same-extension:source-a"), firstDirect);
  firstDirect.onTerminalInput(() => undefined);
  const firstDirectRegistrationSignal = calls.findLast((call) =>
    call.name === "registerUnsafeTerminalInputHandler")?.values[1] as AbortSignal;
  const secondDirect = direct("same-extension", secondGeneration.signal, "same-extension:source-a");
  assert.notEqual(secondDirect, firstDirect, "a replacement extension generation receives a fresh UI context");
  const otherSourceGeneration = new AbortController();
  assert.notEqual(
    direct("same-extension", otherSourceGeneration.signal, "same-extension:source-b"),
    secondDirect,
    "distinct active sources sharing a declared ID receive independent UI contexts",
  );
  secondDirect.onTerminalInput(() => undefined);
  const directRegistrationSignal = calls.findLast((call) =>
    call.name === "registerUnsafeTerminalInputHandler")?.values[1] as AbortSignal;
  assert.notEqual(directRegistrationSignal, secondGeneration.signal);
  assert.equal(directRegistrationSignal.aborted, false);
  secondGeneration.abort(new Error("extension generation replaced"));
  assert.equal(directRegistrationSignal.aborted, true, "direct terminal registrations follow the extension generation");
  const genericSessionUi = (): object => ({});
  startup.host.setDirectUiHandler(genericSessionUi);
  assert.equal(startup.handlers.direct, genericSessionUi);
  binder.restoreDirectContext(startupRuntime);
  assert.notEqual(
    startup.handlers.direct,
    genericSessionUi,
    "session binding cannot permanently replace the extension-scoped direct UI handler",
  );

  const toolBindings = () => calls.filter((call) => call.name === "setToolRenderers").length;
  const beforeResume = toolBindings();
  assert.equal(binder.bind(startupRuntime), false, "in-place resume keeps the active generation");
  assert.equal(toolBindings(), beforeResume);
  assert.equal(startup.changeListeners(), 1);
  const unavailable = fixtureHost("unavailable");
  unavailable.lifecycle.abort(new Error("candidate host is unavailable"));
  assert.throws(
    () => binder.bind(runtime(unavailable, "/workspace-b")),
    /candidate host is unavailable/u,
  );
  assert.equal(startup.changeListeners(), 1, "an invalid candidate does not release the current binding");
  startup.changed("tool_renderer");
  assert.equal(toolBindings(), beforeResume + 1, "live registrations rebind the renderer adapter");
  assert.equal(startup.toolBindingRequests(), 1, "live registrations reuse the generation-owned renderer binding");

  assert.equal(binder.bind(startupRuntime, true), true, "in-place refresh replaces its UI binding");
  assert.equal(startupBindingSignal.aborted, true);
  assert.equal(firstDirectRegistrationSignal.aborted, true);
  assert.equal(startup.changeListeners(), 1, "in-place refresh does not retain the previous change listener");

  const refreshed = fixtureHost("refresh");
  assert.equal(binder.bind(runtime(refreshed, "/workspace-a", true, [])), true, "refresh binds the replacement generation");
  assert.equal(startup.changeListeners(), 0);
  assert.equal(refreshed.changeListeners(), 1);
  assert.equal(commandValues().includes("/skill:review"), true, "refresh rebinds enabled discovered skills");
  assert.equal(commandValues().includes("/skill:static-prompt"), true, "refresh reveals a skill after its matching prompt is removed");
  assert.equal(calls.filter((call) => call.name === "clearExtensionUi").length, 3);
  const replacement = fixtureHost("workspace");
  assert.equal(binder.bind(runtime(replacement, "/workspace-b")), true, "cross-workspace resume binds the replacement runtime");
  assert.equal(refreshed.changeListeners(), 0);
  assert.equal(replacement.changeListeners(), 1);
  assert.equal(calls.filter((call) => call.name === "clearExtensionUi").length, 4);
  binder.close();
  assert.equal(replacement.changeListeners(), 0);
  assert.deepEqual(Object.values(replacement.handlers), Array(6).fill(undefined));
});

test("interactive login routes direct extension providers through the model registry credential store", async () => {
  const progress: string[] = [];
  const loginTypes: string[] = [];
  const provider = {
    id: "direct-oauth",
    name: "Direct OAuth",
    auth: { oauth: {
      name: "Direct subscription",
      loginLabel: "Connect subscription",
      async login() {
        return { type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 60_000 };
      },
    } },
  };
  const runtime = {
    providers: {
      get: () => { throw new Error("direct extension provider is not a legacy adapter"); },
      list: () => [],
    },
    auth: { has: () => false },
    modelRegistry: {
      getProvider: (id: string) => id === provider.id ? provider : undefined,
      getProviderDisplayName: () => provider.name,
      models: () => ({
        getProviders: () => [provider],
        async login(_provider: string, type: string, interaction: { notify(value: { type: string; message?: string }): void }) {
          loginTypes.push(type);
          interaction.notify({ type: "progress", message: "Direct provider login" });
        },
      }),
      async refresh() { progress.push("refreshed"); },
    },
  } as unknown as LoadedRuntime;
  const terminal = {
    notify(message: string) { progress.push(message); },
    async choose<T>(_message: string, choices: Array<{ value: T }>) { return choices[0]!.value; },
    async question() { return "answer"; },
    async readSecret() { return "secret"; },
  } as unknown as TuiController;

  assert.equal(await loginInteractively(runtime, terminal, undefined, undefined, true), provider.id);
  assert.deepEqual(loginTypes, ["oauth"]);
  assert.deepEqual(progress, ["Direct provider login", "refreshed"]);
});
