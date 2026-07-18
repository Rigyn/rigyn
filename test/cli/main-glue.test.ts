import assert from "node:assert/strict";
import test from "node:test";

import { pickModel, runtimeUi } from "../../src/cli/main.js";
import type { LoadedRuntime } from "../../src/cli/runtime.js";
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
  let theme = "dark";
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
    themeNames: () => ["dark", "light"],
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
  assert.deepEqual(await ui.getTheme(), { name: "dark", available: ["dark", "light"] });
  assert.deepEqual(await ui.setTheme("light"), { name: "light", available: ["dark", "light"] });
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
