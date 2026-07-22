import assert from "node:assert/strict";
import test from "node:test";

import { InteractiveExtensionUiBinder, loginInteractively, parseInteractiveModelReference, pickModel, runtimeUi } from "../../src/cli/main.js";
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
  const ui = runtimeUi(terminal, "fixture", lifecycle.signal, interaction.signal);

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
    { name: "status", values: ["fixture:phase", "running"] },
    { name: "widget", values: ["fixture:panel", "widget"] },
    { name: "header", values: ["fixture:head", "header"] },
    { name: "footer", values: ["fixture:foot", "footer"] },
  ]);
  interaction.abort(new Error("interaction ended"));
  await assert.rejects(ui.select("Pick", [{ label: "One", value: 1 }]), /interaction ended/u);
  lifecycle.abort();
  assert.throws(() => ui.notify("late"), /no longer active/u);
});

test("interactive extension UI binds every host surface across startup, reload, resume, and workspace replacement", () => {
  const calls: Array<{ name: string; values: unknown[] }> = [];
  const terminal = new Proxy({}, {
    get(_target, property) {
      if (property === "selectedThemeName") return () => "mono";
      if (property === "themeNames") return () => ["mono"];
      if (property === "getToolOutputExpanded") return () => false;
      if (property === "actionsForKey") return () => [];
      return (...values: unknown[]) => { calls.push({ name: String(property), values }); };
    },
  }) as TuiController;

  function fixtureHost(id: string) {
    const lifecycle = new AbortController();
    const handlers: Record<string, unknown> = {};
    let change: ((value: string) => void) | undefined;
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
      onChange: (listener: (value: string) => void) => { change = listener; return () => { change = undefined; }; },
      initialUi: () => [{ extensionId: id, type: "status", key: "phase", value: "ready" }],
      setUiHandler: (value: unknown) => { handlers.ui = value; },
      setAdvancedUiHandler: (value: unknown) => { handlers.advanced = value; },
      setNativeUiHandler: (value: unknown) => { handlers.native = value; },
      setUnsafeTerminalHandler: (value: unknown) => { handlers.unsafe = value; },
      setInteractiveUiHandler: (value: unknown) => { handlers.interactive = value; },
      setDirectUiHandler: (value: unknown) => { handlers.direct = value; },
    };
    return { host, lifecycle, handlers, toolBinding, changed: (value: string) => change?.(value) };
  }

  const runtime = (fixture: ReturnType<typeof fixtureHost>, workspace: string): LoadedRuntime => ({
    workspace,
    settings: SettingsManager.inMemory({
      treeFilterMode: "all",
      outputPad: 0,
      autocompleteMaxVisible: 10,
      terminal: { showImages: true, imageWidthCells: 40, clearOnShrink: true },
      markdown: { codeBlockIndent: "" },
      theme: "mono",
    }),
    runtimeExtensions: fixture.host,
    extensions: {
      bundle: () => ({
        commands: [{ extensionId: fixture.host.commands()[0]!.extensionId, name: "static-command" }],
        prompts: [{ extensionId: fixture.host.commands()[0]!.extensionId, id: "static-prompt" }],
        themes: [],
      }),
    },
  }) as unknown as LoadedRuntime;

  const startup = fixtureHost("startup");
  const binder = new InteractiveExtensionUiBinder(terminal);
  assert.equal(binder.bind(runtime(startup, "/workspace-a")), true);
  assert.ok(["setToolRenderers", "setSessionRenderers", "setExtensionShortcuts",
    "setCommandCompletionProvider", "setCommandItems",
    "setCustomThemes", "setExtensionStatus"].every((name) => calls.some((call) => call.name === name)), calls.map((call) => call.name).join(", "));
  assert.equal(calls.find((call) => call.name === "setToolRenderers")?.values[0], startup.toolBinding);
  assert.equal(calls.find((call) => call.name === "setToolRenderers")?.values[1], startup.lifecycle.signal);
  assert.deepEqual(Object.keys(startup.handlers).sort(), ["advanced", "direct", "interactive", "native", "ui", "unsafe"]);
  const direct = startup.handlers.direct as (extensionId: string, signal: AbortSignal) => {
    onTerminalInput(handler: (value: string) => unknown): unknown;
  };
  const firstGeneration = new AbortController();
  const secondGeneration = new AbortController();
  const firstDirect = direct("same-extension", firstGeneration.signal);
  assert.equal(direct("same-extension", firstGeneration.signal), firstDirect);
  const secondDirect = direct("same-extension", secondGeneration.signal);
  assert.notEqual(secondDirect, firstDirect, "a replacement extension generation receives a fresh UI context");
  secondDirect.onTerminalInput(() => undefined);
  assert.equal(
    calls.findLast((call) => call.name === "registerUnsafeTerminalInputHandler")?.values[1],
    secondGeneration.signal,
    "direct terminal registrations are owned by the extension generation",
  );

  const toolBindings = () => calls.filter((call) => call.name === "setToolRenderers").length;
  const beforeResume = toolBindings();
  assert.equal(binder.bind(runtime(startup, "/workspace-a")), false, "in-place resume keeps the active generation");
  assert.equal(toolBindings(), beforeResume);
  startup.changed("tool_renderer");
  assert.equal(toolBindings(), beforeResume + 1, "live registrations rebind the renderer adapter");

  const reloaded = fixtureHost("reload");
  assert.equal(binder.bind(runtime(reloaded, "/workspace-a")), true, "reload binds the replacement generation");
  assert.equal(calls.filter((call) => call.name === "clearExtensionUi").length, 2);
  const replacement = fixtureHost("workspace");
  assert.equal(binder.bind(runtime(replacement, "/workspace-b")), true, "cross-workspace resume binds the replacement runtime");
  assert.equal(calls.filter((call) => call.name === "clearExtensionUi").length, 3);
});

test("interactive login routes direct extension providers through the model registry credential store", async () => {
  const progress: string[] = [];
  const loginTypes: string[] = [];
  const provider = {
    id: "direct-oauth",
    name: "Direct OAuth",
    auth: { oauth: { name: "Direct subscription", loginLabel: "Connect subscription" } },
  };
  const runtime = {
    providers: {
      get: (id: string) => id,
      list: () => [{ id: provider.id }],
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

  assert.equal(await loginInteractively(runtime, terminal, provider.id, undefined, true), provider.id);
  assert.deepEqual(loginTypes, ["oauth"]);
  assert.deepEqual(progress, ["Direct provider login", "refreshed"]);
});
