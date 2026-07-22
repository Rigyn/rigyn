import assert from "node:assert/strict";
import test from "node:test";

import { CURSOR_MARKER, TUI, type Component, type EditorComponent } from "@rigyn/terminal";

import { SettingsManager } from "../../src/core/settings-manager.js";
import { createInteractiveDirectUiContext } from "../../src/tui/direct-ui.js";
import { TuiController } from "../../src/tui/controller.js";
import { Keybindings } from "../../src/tui/keybindings.js";
import { stripAnsi } from "../../src/tui/unicode.js";
import { FakeInput, FakeOutput, tick } from "./helpers.js";

function fixture() {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    handleSignals: false,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
  });
  controller.start();
  return { input, output, controller };
}

function component(label: string, disposed: () => void): Component & { dispose(): void } {
  return {
    render: () => [label],
    invalidate() {},
    dispose: disposed,
  };
}

test("direct UI components share the host renderer, retain extension ownership, and dispose with their generation", async () => {
  const { input, output, controller } = fixture();
  controller.setContext({ availableProviderCount: 3 });
  const firstGeneration = new AbortController();
  const secondGeneration = new AbortController();
  const first = createInteractiveDirectUiContext(controller, "first", process.cwd(), firstGeneration.signal);
  const second = createInteractiveDirectUiContext(controller, "second", process.cwd(), secondGeneration.signal);
  let firstDisposed = 0;
  let secondDisposed = 0;
  let firstInputs = 0;
  let secondInputs = 0;
  let footerStatuses: ReadonlyMap<string, string> | undefined;

  first.onTerminalInput(() => { firstInputs += 1; return undefined; });
  second.onTerminalInput(() => { secondInputs += 1; return undefined; });
  first.setStatus("phase", "ready");
  first.setHeader(() => component("FIRST HEADER", () => { firstDisposed += 1; }));
  first.setWidget("shared", () => component("FIRST WIDGET", () => { firstDisposed += 1; }));
  first.setFooter((_tui, _theme, data) => {
    footerStatuses = data.getExtensionStatuses();
    assert.equal(data.getAvailableProviderCount(), 3);
    return component("FIRST FOOTER", () => { firstDisposed += 1; });
  });
  second.setWidget("shared", () => component("SECOND WIDGET", () => { secondDisposed += 1; }));
  await tick();

  const rendered = stripAnsi(output.text);
  assert.match(rendered, /FIRST HEADER/u);
  assert.match(rendered, /FIRST WIDGET/u);
  assert.match(rendered, /SECOND WIDGET/u);
  assert.match(rendered, /FIRST FOOTER/u);
  assert.equal(footerStatuses?.get("first:phase"), "ready");
  input.write("a");
  assert.equal(firstInputs, 1);
  assert.equal(secondInputs, 1);

  firstGeneration.abort(new Error("extension reload"));
  await tick();
  assert.equal(firstDisposed, 3);
  assert.equal(secondDisposed, 0, "another extension with the same local key remains mounted");
  input.write("b");
  assert.equal(firstInputs, 1, "a removed generation no longer receives terminal input");
  assert.equal(secondInputs, 2);
  secondGeneration.abort(new Error("extension reload"));
  assert.equal(secondDisposed, 1);
  controller.close();
});

test("direct custom components receive raw input and clean up exactly once on completion or abort", async () => {
  const { input, output, controller } = fixture();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "custom", process.cwd(), generation.signal);
  let disposed = 0;
  let focused = false;
  const result = ui.custom<string>((tui, theme, _keybindings, done) => {
    tui.terminal.hideCursor();
    return {
      render: () => [`${theme.fg("accent", "RAW PANEL")}${CURSOR_MARKER}`],
      handleInput: (data) => done(data),
      invalidate() {},
      dispose: () => { disposed += 1; },
    };
  }, { onHandle: (handle) => { focused = handle.isFocused(); } });
  await tick();
  assert.match(stripAnsi(output.text), /RAW PANEL/u);
  assert.equal(focused, true);
  input.write("z");
  assert.equal(await result, "z");
  assert.equal(disposed, 1);

  const expired = ui.custom<void>(() => component("TEMPORARY PANEL", () => { disposed += 1; }));
  generation.abort(new Error("extension reload"));
  assert.equal(await expired, undefined);
  assert.equal(disposed, 2);
  controller.close();
  assert.deepEqual(input.rawChanges, [true, false]);
  assert.match(output.text, /\u001b\[\?25h/u);
});

test("direct custom and editor factories receive the controller's live complete keybinding manager", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const bindings = new Keybindings({ "app.model.select": "alt+k" });
  const controller = new TuiController({
    input,
    output,
    keybindings: bindings,
    handleSignals: false,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
  });
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "bindings", process.cwd(), generation.signal);
  let customManager: unknown;
  let editorManager: unknown;

  const completed = ui.custom<void>((_tui, _theme, manager, done) => {
    customManager = manager;
    done();
    return component("bindings", () => undefined);
  });
  await completed;
  ui.setEditorComponent((_tui, _theme, manager) => {
    editorManager = manager;
    return {
      render: () => [CURSOR_MARKER],
      handleInput() {},
      getText: () => "",
      setText() {},
      invalidate() {},
    };
  });

  assert.equal(customManager, bindings.manager());
  assert.equal(editorManager, bindings.manager());
  assert.deepEqual(bindings.manager().getKeys("app.model.select"), ["alt+k"]);
  generation.abort(new Error("done"));
  controller.close();
});

test("direct editor factories replace, submit through, wrap, and restore the host editor", async () => {
  const { input, output, controller } = fixture();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "editor", process.cwd(), generation.signal);
  controller.setEditorText("draft");
  let disposed = 0;
  const factory = (): EditorComponent & { dispose(): void } => {
    let text = "";
    const editor: EditorComponent & { dispose(): void } = {
      render: () => [`CUSTOM ${text}${CURSOR_MARKER}`],
      handleInput(data) {
        if (data === "\r") editor.onSubmit?.(text);
        else {
          text += data;
          editor.onChange?.(text);
        }
      },
      getText: () => text,
      setText(value) { text = value; editor.onChange?.(text); },
      invalidate() {},
      dispose: () => { disposed += 1; },
    };
    return editor;
  };

  ui.setEditorComponent(factory);
  assert.equal(ui.getEditorComponent(), factory);
  await tick();
  assert.match(stripAnsi(output.text), /CUSTOM draft/u);
  input.write("x");
  assert.equal(ui.getEditorText(), "draftx");
  const submitted = controller.question("you> ");
  input.write("\r");
  assert.equal(await submitted, "draftx");

  controller.setEditorText("preserved");
  generation.abort(new Error("extension reload"));
  assert.equal(disposed, 1);
  const restored = controller.question("you> ");
  input.write("y\r");
  assert.equal(await restored, "preservedy");
  controller.close();
});

test("direct UI contexts report the globally active editor factory across extension generations", () => {
  const { controller } = fixture();
  const firstGeneration = new AbortController();
  const secondGeneration = new AbortController();
  const first = createInteractiveDirectUiContext(controller, "first-editor", process.cwd(), firstGeneration.signal);
  const second = createInteractiveDirectUiContext(controller, "second-editor", process.cwd(), secondGeneration.signal);
  const editor = (): EditorComponent => ({
    render: () => [CURSOR_MARKER],
    handleInput() {},
    getText: () => "",
    setText() {},
    invalidate() {},
  });
  const firstFactory = () => editor();
  const secondFactory = () => editor();

  first.setEditorComponent(firstFactory);
  assert.equal(first.getEditorComponent(), firstFactory);
  assert.equal(second.getEditorComponent(), firstFactory);
  second.setEditorComponent(secondFactory);
  assert.equal(first.getEditorComponent(), secondFactory);
  assert.equal(second.getEditorComponent(), secondFactory);

  secondGeneration.abort(new Error("second generation replaced"));
  assert.equal(first.getEditorComponent(), firstFactory);
  firstGeneration.abort(new Error("first generation replaced"));
  assert.equal(second.getEditorComponent(), undefined);
  controller.close();
});

test("a failing direct renderer is removed, reported, and never disposed twice", async () => {
  const { output, controller } = fixture();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "failure", process.cwd(), generation.signal);
  let disposed = 0;
  ui.setWidget("broken", () => ({
    render: () => { throw new Error("renderer exploded"); },
    invalidate() {},
    dispose: () => { disposed += 1; },
  }));
  await tick();
  assert.match(stripAnsi(output.text), /Raw UI component failed: renderer exploded/u);
  assert.equal(disposed, 1);
  generation.abort(new Error("extension reload"));
  assert.equal(disposed, 1);
  controller.close();
});

test("trusted terminal state, protocol queries, input draining, and ownership controls use the live host", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    theme: "dark",
    handleSignals: false,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", KITTY_WINDOW_ID: "1" },
  });
  controller.start();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "terminal", process.cwd(), generation.signal);
  let tui: TUI | undefined;
  ui.setWidget("capture", (value) => {
    tui = value;
    return component("terminal capture", () => undefined);
  });
  assert.ok(tui !== undefined);
  assert.ok(tui instanceof TUI, "trusted contexts retain the public TUI runtime identity");

  assert.equal(tui.terminal.columns, 80);
  assert.equal(tui.terminal.rows, 24);
  output.resize(132, 41);
  assert.equal(tui.terminal.columns, 132);
  assert.equal(tui.terminal.rows, 41);

  input.write("\u001b[?5u");
  assert.equal(tui.terminal.kittyProtocolActive, true);

  const schemes: string[] = [];
  const removeScheme = tui.onTerminalColorSchemeChange((scheme) => schemes.push(scheme));
  const outputBeforeNotifications = output.text.length;
  tui.setTerminalColorSchemeNotifications(true);
  assert.match(output.text.slice(outputBeforeNotifications), /\u001b\[\?2031h/u);

  const scheme = tui.queryTerminalColorScheme({ timeoutMs: 100 });
  assert.match(output.text, /\u001b\[\?996n/u);
  input.write("\u001b[?997;2n");
  assert.equal(await scheme, "light");
  assert.deepEqual(schemes, ["light"]);

  const background = tui.queryTerminalBackgroundColor({ timeoutMs: 100 });
  assert.match(output.text, /\u001b\]11;\?\u0007/u);
  input.write("\u001b]11;rgb:ffff/0000/0000\u0007");
  assert.deepEqual(await background, { r: 255, g: 0, b: 0 });
  assert.deepEqual(schemes, ["light", "dark"]);
  removeScheme();
  const outputBeforeDisable = output.text.length;
  tui.setTerminalColorSchemeNotifications(false);
  assert.match(output.text.slice(outputBeforeDisable), /\u001b\[\?2031l/u);

  controller.setEditorText("");
  input.write("\u001b");
  const drained = tui.terminal.drainInput(100, 10);
  input.write("discarded while draining");
  await drained;
  assert.equal(controller.getEditorText(), "");
  input.write("k");
  assert.equal(controller.getEditorText(), "k");

  generation.abort(new Error("extension generation ended"));
  controller.close();
});

test("trusted TUI start and stop pause only generation-owned rendering and input", async () => {
  const { input, output, controller } = fixture();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(controller, "lifecycle", process.cwd(), generation.signal);
  let tui: TUI | undefined;
  ui.setWidget("capture", (value) => {
    tui = value;
    return component("capture", () => undefined);
  });
  assert.ok(tui !== undefined);

  let renders = 0;
  let childDisposed = 0;
  const ownedChild: Component & { dispose(): void } = {
    render: () => { renders += 1; return ["owned child"]; },
    invalidate() {},
    dispose: () => { childDisposed += 1; },
  };
  tui.addChild(ownedChild);
  await tick();
  assert.ok(renders > 0);

  let inputs = 0;
  const removeInput = tui.addInputListener(() => { inputs += 1; return { consume: true }; });
  tui.showOverlay(component("owned overlay", () => undefined), { nonCapturing: true });
  assert.equal(tui.hasOverlay(), true);
  tui.stop();
  await tick();
  const stoppedRenders = renders;
  tui.requestRender();
  input.write("a");
  await tick();
  assert.equal(renders, stoppedRenders);
  assert.equal(inputs, 0);
  assert.equal(tui.hasOverlay(), false);
  assert.equal(childDisposed, 0, "pausing the trusted TUI preserves component state");

  tui.start();
  await tick();
  assert.ok(renders > stoppedRenders);
  const redraws = tui.fullRedraws;
  tui.requestRender(true);
  await tick();
  assert.ok(tui.fullRedraws > redraws, "forced requests perform a real host redraw");
  assert.equal(tui.hasOverlay(), true);
  input.write("b");
  assert.equal(inputs, 1);
  removeInput();

  const rewritten: string[] = [];
  const removeRewrite = tui.addInputListener(() => ({ data: "rewritten" }));
  const removeObserve = tui.addInputListener((data) => { rewritten.push(data); return { consume: true }; });
  input.write("source");
  assert.deepEqual(rewritten, ["rewritten"]);
  removeRewrite();
  removeObserve();
  let debug = 0;
  tui.onDebug = () => { debug += 1; };
  input.write("\u001b[100;6u");
  assert.equal(debug, 1);

  let terminalInputs = 0;
  let resizes = 0;
  tui.terminal.start(() => { terminalInputs += 1; }, () => { resizes += 1; });
  tui.terminal.start(() => { terminalInputs += 100; }, () => { resizes += 100; });
  input.write("c");
  output.resize(90, 30);
  assert.equal(terminalInputs, 1, "starting the shared terminal twice remains idempotent");
  assert.equal(resizes, 1);
  tui.terminal.stop();
  input.write("d");
  assert.equal(terminalInputs, 1);
  tui.hideOverlay();

  generation.abort(new Error("extension generation ended"));
  assert.equal(childDisposed, 1);
  controller.close();
});

test("trusted theme discovery reports source paths and successful selections persist", async () => {
  const { controller } = fixture();
  controller.setCustomThemes([{ schemaVersion: 1, name: "ocean", base: "dark", styles: {} }]);
  const settings = SettingsManager.inMemory();
  const generation = new AbortController();
  const ui = createInteractiveDirectUiContext(
    controller,
    "themes",
    process.cwd(),
    generation.signal,
    {
      settings,
      themePath: (name) => name === "ocean" ? "/themes/ocean.json" : undefined,
    },
  );

  assert.deepEqual(
    ui.getAllThemes().find((theme) => theme.name === "ocean"),
    { name: "ocean", path: "/themes/ocean.json" },
  );
  assert.deepEqual(ui.setTheme("ocean"), { success: true });
  assert.equal(controller.selectedThemeName(), "ocean");
  assert.equal(settings.getTheme(), "ocean");
  let tui: TUI | undefined;
  ui.setWidget("settings", (value) => {
    tui = value;
    return component("settings", () => undefined);
  });
  assert.ok(tui !== undefined);
  tui.setShowHardwareCursor(false);
  tui.setClearOnShrink(true);
  assert.equal(tui.getShowHardwareCursor(), false);
  assert.equal(tui.getClearOnShrink(), true);
  assert.equal(settings.getShowHardwareCursor(), false);
  assert.equal(settings.getClearOnShrink(), true);
  await settings.flush();
  assert.equal(ui.setTheme("missing").success, false);
  assert.equal(settings.getTheme(), "ocean", "a rejected theme never changes persistent settings");

  generation.abort(new Error("extension generation ended"));
  controller.close();
});
