import assert from "node:assert/strict";
import test from "node:test";
import { TuiController } from "../../src/tui/controller.js";
import { TuiModel } from "../../src/tui/model.js";
import { DEFAULT_TUI_LIMITS } from "../../src/tui/controller.js";
import { stripAnsi } from "../../src/tui/unicode.js";
import { FakeInput, FakeOutput, envelope, tick } from "./helpers.js";

function fullController() {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new TuiController({
    input,
    output,
    environment: {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      TERM_COLOR: "0",
      RIGYN_ALT_SCREEN: "1",
    },
    handleSignals: false,
  });
  return { input, output, controller };
}

function line(text: string, role: "accent" | "muted" | "success" = "accent") {
  return { lines: [{ spans: [{ text, role }] }] };
}

test("persistent structural slots replace and dispose on abort, clear, and close", async () => {
  const { output, controller } = fullController();
  controller.start();
  const first = new AbortController();
  const second = new AbortController();
  const clear = new AbortController();
  const closing = new AbortController();
  const disposed: string[] = [];

  controller.setPersistentComponent("header", "fixture:header", () => ({
    render: () => line("HEADER-A\u001b]52;c;private\u0007"),
    dispose: () => disposed.push("header-a"),
  }), first.signal);
  await tick();
  assert.match(stripAnsi(output.text), /HEADER-A/u);
  assert.doesNotMatch(output.text, /\u001b\]52;c;private/u);

  controller.setPersistentComponent("header", "fixture:header", () => ({
    render: () => line("HEADER-B"),
    dispose: () => disposed.push("header-b"),
  }), second.signal);
  assert.deepEqual(disposed, ["header-a"]);
  second.abort(new Error("generation replaced"));
  assert.deepEqual(disposed, ["header-a", "header-b"]);

  controller.setPersistentComponent("widget", "fixture:widget", () => ({
    render: () => line("WIDGET"),
    dispose: () => disposed.push("widget"),
  }), clear.signal);
  controller.setPersistentComponent("footer", "fixture:footer", () => ({
    render: () => line("FOOTER", "muted"),
    dispose: () => disposed.push("footer"),
  }), clear.signal);
  controller.clearExtensionUi();
  assert.deepEqual(disposed, ["header-a", "header-b", "widget", "footer"]);

  controller.setPersistentComponent("header", "fixture:close", () => ({
    render: () => line("CLOSE"),
    dispose: () => disposed.push("close"),
  }), closing.signal);
  controller.close();
  closing.abort();
  first.abort();
  assert.deepEqual(disposed, ["header-a", "header-b", "widget", "footer", "close"]);
});

test("persistent slots are candidate-first and enforce structural render bounds", async () => {
  const { output, controller } = fullController();
  controller.start();
  const generation = new AbortController();
  let disposed = 0;
  controller.setPersistentComponent("header", "fixture:bounded", () => ({
    render: () => line("STILL ACTIVE"),
    dispose: () => { disposed += 1; },
  }), generation.signal);
  assert.throws(() => controller.setPersistentComponent("header", "fixture:bounded", () => {
    throw new Error("candidate failed");
  }, generation.signal), /candidate failed/u);
  controller.renderNow();
  assert.match(stripAnsi(output.text), /STILL ACTIVE/u);
  assert.equal(disposed, 0);

  controller.setPersistentComponent("widget", "fixture:too-tall", () => ({
    render: () => ({
      lines: Array.from({ length: 5 }, (_, index) => ({ spans: [{ text: `row ${index}` }] })),
    }),
    dispose: () => { disposed += 1; },
  }), generation.signal);
  controller.renderNow();
  assert.equal(disposed, 1);
  controller.close();
  assert.equal(disposed, 2);
});

test("persistent slot names are exact and removing a full slot releases capacity synchronously", () => {
  const { controller } = fullController();
  const generation = new AbortController();
  assert.throws(() => controller.setPersistentComponent("__proto__" as never, "fixture:bad", () => ({
    render: () => line("bad"),
  }), generation.signal), /slot is invalid/u);

  let disposed = 0;
  for (let index = 0; index < 16; index += 1) {
    controller.setPersistentComponent("header", `fixture:item-${index}`, () => ({
      render: () => line(`item ${index}`),
      dispose: () => { disposed += 1; },
    }), generation.signal);
  }
  assert.throws(() => controller.setPersistentComponent("header", "fixture:overflow", () => ({
    render: () => line("overflow"),
  }), generation.signal), /limited to 16/u);
  controller.setPersistentComponent("header", "fixture:item-0");
  assert.equal(disposed, 1);
  assert.doesNotThrow(() => controller.setPersistentComponent("header", "fixture:replacement", () => ({
    render: () => line("replacement"),
    dispose: () => { disposed += 1; },
  }), generation.signal));
  controller.close();
  assert.equal(disposed, 17);
});

test("working frames and hidden-reasoning labels are bounded and reset with their generation", async () => {
  const { output, controller } = fullController();
  controller.start();
  const generation = new AbortController();
  controller.setWorkingIndicator({ frames: ["FRAME-A", "FRAME-B"], intervalMs: 50 }, generation.signal);
  controller.setHiddenReasoningLabel("private plan\u001b]0;unsafe\u0007", generation.signal);
  controller.setContext({ active: true, status: "streaming" });
  controller.render(envelope({ type: "reasoning_delta", text: "inspect the failure", part: 0, visibility: "summary" }, 1));
  controller.renderNow();
  const customized = stripAnsi(output.text);
  assert.match(customized, /FRAME-[AB]/u);
  assert.match(customized, /private plan inspect the failure/u);
  assert.doesNotMatch(output.text, /\u001b\]0;unsafe/u);

  generation.abort(new Error("reload"));
  controller.clearTranscript();
  output.chunks.length = 0;
  controller.render(envelope({ type: "reasoning_delta", text: "fresh reasoning", part: 0, visibility: "summary" }, 2));
  controller.renderNow();
  const reset = stripAnsi(output.text);
  assert.doesNotMatch(reset, /FRAME-|private plan/u);
  assert.match(reset, /summary fresh reasoning/u);

  const invalid = new AbortController();
  assert.throws(() => controller.setWorkingIndicator({ frames: [], intervalMs: 50 }, invalid.signal), /1-32/u);
  assert.throws(() => controller.setWorkingIndicator({ frames: ["x"], intervalMs: 49 }, invalid.signal), /50-2000/u);
  assert.throws(() => controller.setHiddenReasoningLabel("\u001b]0;hidden\u0007", invalid.signal), /cannot be empty/u);
  controller.close();
});

test("keyed presentation overrides restore the prior live owner", () => {
  const { output, controller } = fullController();
  controller.start();
  controller.setContext({ active: true, status: "streaming" });
  const first = new AbortController();
  const second = new AbortController();
  controller.setKeyedWorkingIndicator("fixture:first", { frames: ["FIRST-FRAME"], intervalMs: 60 }, first.signal);
  controller.setKeyedWorkingIndicator("fixture:second", { frames: ["SECOND-FRAME"], intervalMs: 70 }, second.signal);
  controller.setKeyedHiddenReasoningLabel("fixture:first", "first reasoning", first.signal);
  controller.setKeyedHiddenReasoningLabel("fixture:second", "second reasoning", second.signal);
  controller.render(envelope({ type: "reasoning_delta", text: "active", part: 0, visibility: "summary" }, 1));
  controller.renderNow();
  assert.match(stripAnsi(output.text), /SECOND-FRAME/u);
  assert.match(stripAnsi(output.text), /second reasoning active/u);

  controller.setKeyedWorkingIndicator("fixture:second");
  controller.setKeyedHiddenReasoningLabel("fixture:second");
  controller.clearTranscript();
  output.chunks.length = 0;
  controller.render(envelope({ type: "reasoning_delta", text: "restored", part: 0, visibility: "summary" }, 2));
  controller.renderNow();
  assert.match(stripAnsi(output.text), /FIRST-FRAME/u);
  assert.match(stripAnsi(output.text), /first reasoning restored/u);

  second.abort(new Error("stale owner"));
  first.abort(new Error("active owner ended"));
  controller.clearTranscript();
  output.chunks.length = 0;
  controller.render(envelope({ type: "reasoning_delta", text: "native", part: 0, visibility: "summary" }, 3));
  controller.renderNow();
  const native = stripAnsi(output.text);
  assert.doesNotMatch(native, /FIRST-FRAME|SECOND-FRAME|first reasoning|second reasoning/u);
  assert.match(native, /summary native/u);
  controller.close();
});

test("tool output expansion is observable, applies to future tools, and resets on abort", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({ type: "tool_requested", callId: "first", name: "read", input: { path: "a" }, index: 0 }, 1));
  model.apply(envelope({ type: "tool_completed", callId: "first", name: "read", index: 0, isError: false, preview: "a" }, 2));
  assert.equal(model.toolOutputExpanded, true);
  assert.equal(model.setToolOutputExpanded(false), true);
  assert.equal(model.entries[0]?.expanded, false);
  model.apply(envelope({ type: "tool_requested", callId: "second", name: "read", input: { path: "b" }, index: 1 }, 3));
  model.apply(envelope({ type: "tool_completed", callId: "second", name: "read", index: 1, isError: false, preview: "b" }, 4));
  assert.equal(model.entries[1]?.expanded, false);

  const { controller } = fullController();
  const generation = new AbortController();
  controller.setToolOutputExpanded(false, generation.signal);
  assert.equal(controller.getToolOutputExpanded(), false);
  generation.abort(new Error("reload"));
  assert.equal(controller.getToolOutputExpanded(), true);
  controller.close();
});

test("advanced expansion restores the user's prior collapsed preference", () => {
  const { controller } = fullController();
  controller.render(envelope({ type: "tool_requested", callId: "prior", name: "read", input: { path: "a" }, index: 0 }, 1));
  controller.render(envelope({ type: "tool_completed", callId: "prior", name: "read", index: 0, isError: false, preview: "a" }, 2));
  assert.equal(controller.toggleTool(), true);
  assert.equal(controller.getToolOutputExpanded(), false);

  const first = new AbortController();
  const replacement = new AbortController();
  controller.setToolOutputExpanded(true, first.signal);
  controller.setToolOutputExpanded(false, replacement.signal);
  assert.equal(controller.getToolOutputExpanded(), false);
  first.abort(new Error("stale generation"));
  assert.equal(controller.getToolOutputExpanded(), false);
  replacement.abort(new Error("active generation ended"));
  assert.equal(controller.getToolOutputExpanded(), false);
  controller.close();
});

test("keyed expansion is last-wins and restores owners before the user baseline", () => {
  const { controller } = fullController();
  controller.render(envelope({ type: "tool_requested", callId: "prior-keyed", name: "read", input: { path: "a" }, index: 0 }, 1));
  controller.render(envelope({ type: "tool_completed", callId: "prior-keyed", name: "read", index: 0, isError: false, preview: "a" }, 2));
  controller.toggleTool();
  assert.equal(controller.getToolOutputExpanded(), false);

  const first = new AbortController();
  const second = new AbortController();
  controller.setKeyedToolOutputExpanded("fixture:first", true, first.signal);
  controller.setKeyedToolOutputExpanded("fixture:second", false, second.signal);
  assert.equal(controller.getToolOutputExpanded(), false);
  controller.setKeyedToolOutputExpanded("fixture:second");
  assert.equal(controller.getToolOutputExpanded(), true);
  second.abort(new Error("stale owner"));
  assert.equal(controller.getToolOutputExpanded(), true);
  first.abort(new Error("active owner ended"));
  assert.equal(controller.getToolOutputExpanded(), false);
  controller.close();
});

test("normalized key observers cannot consume host input and expire with their generation", async () => {
  const { input, controller } = fullController();
  controller.start();
  const stale = new AbortController();
  const generation = new AbortController();
  const staleEvents: string[] = [];
  let persistentKeyCalls = 0;
  const events: Array<{ key: string; text?: string; frozen: boolean }> = [];
  controller.setPersistentComponent("widget", "fixture:passive", () => ({
    render: () => line("passive"),
    handleKey: () => {
      persistentKeyCalls += 1;
      return true;
    },
  }), generation.signal);
  controller.setNormalizedKeyObserver("fixture:keys", (event) => staleEvents.push(event.key), stale.signal);
  controller.setNormalizedKeyObserver("fixture:keys", (event) => {
    events.push({ key: event.key, ...(event.text === undefined ? {} : { text: event.text }), frozen: Object.isFrozen(event) });
  }, generation.signal);
  stale.abort(new Error("stale observer replaced"));

  const first = controller.question("you> ", undefined, { cancelable: false });
  input.write("x\r");
  assert.equal(await first, "x");
  assert.equal(persistentKeyCalls, 0);
  assert.deepEqual(staleEvents, []);
  assert.deepEqual(events.map((event) => [event.key, event.text, event.frozen]), [
    ["text", "x", true],
    ["enter", undefined, true],
  ]);

  controller.setNormalizedKeyObserver("fixture:keys");
  const count = events.length;
  const second = controller.question("you> ", undefined, { cancelable: false });
  input.write("y\r");
  assert.equal(await second, "y");
  assert.equal(events.length, count);

  controller.setNormalizedKeyObserver("fixture:keys", (event) => events.push({
    key: event.key,
    ...(event.text === undefined ? {} : { text: event.text }),
    frozen: Object.isFrozen(event),
  }), generation.signal);
  generation.abort(new Error("reload"));
  const third = controller.question("you> ", undefined, { cancelable: false });
  input.write("z\r");
  assert.equal(await third, "z");
  assert.equal(events.length, count);
  controller.close();
});
