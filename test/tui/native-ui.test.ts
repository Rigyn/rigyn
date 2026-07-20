import assert from "node:assert/strict";
import test from "node:test";
import { TuiController } from "../../src/tui/controller.js";
import { MultilineEditor, type TuiEditorImplementation } from "../../src/tui/editor.js";
import { createNativeUiHost, createUnsafeTerminalHost } from "../../src/tui/native-ui.js";
import type { TuiAutocompleteProvider } from "../../src/tui/types.js";
import { FakeInput, FakeOutput, tick } from "./helpers.js";

function fullController() {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
    handleSignals: false,
  });
  return { input, output, controller };
}

function uppercaseEditor(previous: TuiEditorImplementation): TuiEditorImplementation {
  return new Proxy({} as TuiEditorImplementation, {
    get: (_target, property) => {
      if (property === "insert") return (value: string) => previous.insert(value.toUpperCase());
      if (property === "insertPaste") return (value: string) => previous.insertPaste(value.toUpperCase());
      const selected = Reflect.get(previous, property, previous) as unknown;
      return typeof selected === "function" ? selected.bind(previous) : selected;
    },
  });
}

test("native input handlers observe, rewrite, consume, and expire with their generation", async () => {
  const { input, controller } = fullController();
  controller.start();
  const generation = new AbortController();
  const host = createNativeUiHost(controller, "input-fixture", generation.signal);
  const observed: string[] = [];
  host.onInput((event) => {
    observed.push(event.text ?? event.key);
    if (event.text === "a") return { action: "rewrite", event: { ...event, text: "b" } };
    if (event.text === "x") return { action: "consume" };
    return { action: "pass" };
  });

  const first = controller.question("you> ");
  input.write("a");
  input.write("x");
  input.write("c");
  input.write("\r");
  assert.equal(await first, "bc");
  assert.deepEqual(observed, ["a", "x", "c", "enter"]);

  generation.abort(new Error("generation replaced"));
  const second = controller.question("you> ");
  input.write("a");
  input.write("\r");
  assert.equal(await second, "a");
  assert.deepEqual(observed, ["a", "x", "c", "enter"]);
  controller.close();
});

test("explicit unsafe terminal hosts transform raw input, write bytes, expose host state, and expire", async () => {
  const { input, output, controller } = fullController();
  controller.start();
  const generation = new AbortController();
  const host = createUnsafeTerminalHost(controller, "raw-terminal-fixture", generation.signal);
  const observed: string[] = [];
  host.onInput((data) => {
    observed.push(data);
    if (data === "a") return { data: "b" };
    if (data === "x") return { consume: true };
    return undefined;
  });

  const answer = controller.question("you> ");
  input.write("a");
  input.write("x");
  input.write("c");
  input.write("\r");
  assert.equal(await answer, "bc");
  assert.deepEqual(observed, ["a", "x", "c", "\r"]);

  host.write("\u001b]9;unsafe-fixture\u0007");
  host.requestRender();
  assert.match(output.text, /unsafe-fixture/u);
  assert.deepEqual(host.size(), { columns: 80, rows: 24 });
  assert.equal(Object.isFrozen(host.size()), true);
  assert.equal(Object.isFrozen(host.capabilities()), true);
  assert.deepEqual(host.keybindings().keys("app.interrupt"), ["escape"]);

  generation.abort(new Error("unsafe terminal generation ended"));
  assert.throws(() => host.write("stale"), /unsafe terminal generation ended/u);
  controller.close();
});

test("native editor replacements and wrappers restore the nearest live predecessor", async () => {
  const { input, controller } = fullController();
  controller.start();
  controller.setEditorText("base");

  const firstGeneration = new AbortController();
  const first = createNativeUiHost(controller, "editor-replacement", firstGeneration.signal);
  const base = first.getEditor();
  const replacement = new MultilineEditor();
  replacement.setText("replacement");
  first.replaceEditor(replacement);

  const secondGeneration = new AbortController();
  const second = createNativeUiHost(controller, "editor-wrapper", secondGeneration.signal);
  const wrapped = uppercaseEditor;
  second.wrapEditor(wrapped);
  input.write("a");
  await tick();
  assert.equal(replacement.text, "replacementA");

  firstGeneration.abort(new Error("lower editor expired"));
  controller.setEditorText("retargeted");
  input.write("b");
  await tick();
  assert.equal(controller.getEditorText(), "retargetedB");
  assert.equal(replacement.text, "replacementA");

  secondGeneration.abort(new Error("wrapper expired"));
  assert.equal(secondGeneration.signal.aborted, true);
  assert.strictEqual(controller.getEditorImplementation(), base);
  assert.equal(controller.getEditorText(), "retargetedB");
  controller.close();
});

test("native components, theme objects, and editor paste use focused host primitives", async () => {
  const { output, controller } = fullController();
  controller.start();
  const generation = new AbortController();
  const host = createNativeUiHost(controller, "presentation-fixture", generation.signal);
  let disposed = 0;
  const component = (label: string) => () => ({
    render: () => ({ lines: [{ spans: [{ text: label, role: "accent" as const }] }] }),
    dispose: () => { disposed += 1; },
  });
  host.mountHeader(component("native header"));
  host.mountWidget(component("native widget"));
  host.mountWidget(component("native widget below"), "below");
  host.mountFooter(component("native footer"));
  host.replaceHeader(component("native replacement header"));
  host.replaceFooter(component("native replacement footer"));
  host.pasteToEditor("clipboard text");
  await tick();

  assert.doesNotMatch(output.text, /native header/u);
  assert.match(output.text, /native widget/u);
  assert.match(output.text, /native widget below/u);
  assert.match(output.text, /native replacement header/u);
  assert.match(output.text, /native replacement footer/u);
  assert.equal(host.getEditor().text, "clipboard text");
  const current = host.currentTheme();
  const catalog = host.themeCatalog();
  assert.equal(Object.isFrozen(current), true);
  assert.equal(Object.isFrozen(current.glyphs), true);
  assert.equal(Object.isFrozen(current.codes), true);
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(catalog.length, 3);
  assert.deepEqual(catalog.map((theme) => theme.name), ["dark", "light", "mono"]);
  assert.equal(catalog.every((theme) => Object.isFrozen(theme)), true);
  const disposeTheme = host.applyTheme(catalog.find((theme) => theme.name === "mono")!);
  assert.equal(host.currentTheme().name, "mono");
  assert.throws(() => host.applyTheme({
    ...catalog[0]!,
    codes: { ...catalog[0]!.codes, accent: "\u001b]52;c;unsafe\u0007" },
  }), /theme code accent is invalid/u);
  disposeTheme();
  assert.equal(host.currentTheme().name, current.name);

  generation.abort(new Error("presentation generation ended"));
  assert.equal(disposed, 6);
  assert.throws(() => host.currentTheme(), /presentation generation ended/u);
  controller.close();
});

test("native autocomplete wrappers follow baseline replacement and restore it on unload", async () => {
  const { input, controller } = fullController();
  controller.start();
  const firstBaseline = new AbortController();
  const provider = (value: string): TuiAutocompleteProvider => (text, cursor) => [{
    start: 0,
    end: cursor,
    value,
    label: `${value}:${text}`,
  }];
  controller.setAutocompleteProvider(provider("first"), firstBaseline.signal);

  const generation = new AbortController();
  const host = createNativeUiHost(controller, "autocomplete-fixture", generation.signal);
  host.wrapAutocomplete((previous) => async (text, cursor, signal) => {
    const completions = await previous(text, cursor, signal);
    return completions?.map((completion) => ({ ...completion, value: `[${completion.value}]` })) ?? null;
  });

  controller.setEditorText("x");
  input.write("\t");
  await tick();
  assert.equal(controller.getEditorText(), "[first]");

  const secondBaseline = new AbortController();
  controller.setAutocompleteProvider(provider("second"), secondBaseline.signal);
  controller.setEditorText("x");
  input.write("\t");
  await tick();
  assert.equal(controller.getEditorText(), "[second]");

  generation.abort(new Error("autocomplete generation ended"));
  controller.setEditorText("x");
  input.write("\t");
  await tick();
  assert.equal(controller.getEditorText(), "second");
  controller.close();
});
