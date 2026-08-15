import assert from "node:assert/strict";
import test from "node:test";
import { TuiController } from "../../src/tui/controller.js";
import { TuiModel } from "../../src/tui/model.js";
import { DEFAULT_TUI_LIMITS } from "../../src/tui/controller.js";
import { stripAnsi } from "../../src/tui/unicode.js";
import { FakeInput, FakeOutput, envelope, tick } from "./helpers.js";
import { FocusedVirtualTerminal } from "./virtual-terminal.js";

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

test("persistent slots keep valid oversized output visible with an explicit truncation row", async () => {
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
  assert.match(stripAnsi(output.text), /row 0/u);
  assert.match(stripAnsi(output.text), /… 2 more rows/u);
  assert.equal(disposed, 0);
  controller.close();
  assert.equal(disposed, 2);
});

test("streamed tool arguments reach the terminal before the canonical tool request", () => {
  const { output, controller } = fullController();
  controller.start();
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  controller.render(envelope({ type: "assistant_started", step: 1 }, 2));
  controller.render(envelope({ type: "tool_call_started", index: 0, name: "read" }, 3));
  controller.render(envelope({ type: "tool_call_delta", index: 0, jsonFragment: "{\"path\":\"live.ts" }, 4));
  controller.renderNow();

  const partialFrame = stripAnsi(output.text);
  assert.match(partialFrame, /read live\.ts · queued/u);
  assert.doesNotMatch(partialFrame, /"path"/u);

  controller.render(envelope({
    type: "tool_call_completed",
    index: 0,
    id: "live-call",
    name: "read",
    rawArguments: "{\"path\":\"live.ts\"}",
    arguments: { path: "live.ts" },
  }, 5));
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "assistant-live",
      role: "assistant",
      content: [{
        type: "tool_call",
        callId: "live-call",
        name: "read",
        arguments: { path: "live.ts" },
      }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 6));
  controller.render(envelope({ type: "assistant_completed", finishReason: "tool_calls" }, 7));
  controller.render(envelope({
    type: "tool_requested",
    callId: "live-call",
    name: "read",
    input: { path: "live.ts" },
    index: 0,
  }, 8));
  controller.renderNow();
  assert.match(stripAnsi(output.text), /live\.ts/u);
  controller.close();
});

test("default extension cards render valid live input as a structured summary", () => {
  const { output, controller } = fullController();
  controller.start();
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  controller.render(envelope({ type: "assistant_started", step: 1 }, 2));
  controller.render(envelope({ type: "tool_call_started", index: 0, name: "custom_live" }, 3));
  output.chunks.length = 0;
  controller.render(envelope({
    type: "tool_call_delta",
    index: 0,
    jsonFragment: "{\"query\":\"first-delta\"}",
  }, 4));
  controller.renderNow();

  const liveFrame = stripAnsi(output.text);
  assert.match(liveFrame, /custom_live first-delta · queued/u);
  assert.match(liveFrame, /"query": "first-delta"/u);
  assert.doesNotMatch(liveFrame, /\{"query":"first-delta"\}/u);
  controller.close();
});

test("large write streams keep one bounded visible card through every lifecycle state", () => {
  const { output, controller } = fullController();
  output.columns = 180;
  controller.start();
  const content = Array.from({ length: 120 }, (_, index) => `architecture-source-${index + 1}`).join("\n");
  const rawArguments = JSON.stringify({ path: "architecture.html", content });
  let sequence = 0;
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, ++sequence));
  controller.render(envelope({ type: "assistant_started", step: 1 }, ++sequence));
  controller.render(envelope({ type: "tool_call_started", index: 0, name: "write" }, ++sequence));
  output.chunks.length = 0;
  controller.render(envelope({ type: "tool_call_delta", index: 0, jsonFragment: rawArguments }, ++sequence));
  controller.renderNow();
  const streamed = stripAnsi(output.text);
  assert.match(streamed, /write architecture\.html · receiving [\d,]+ argument bytes · queued/u);
  assert.doesNotMatch(streamed, /architecture-source-1\b/u);
  assert.match(streamed, /architecture-source-120/u);
  assert.match(streamed, /earlier live input hidden; newest input follows · Ctrl\+O/u);
  assert.ok((streamed.match(/architecture-source-\d+/gu)?.length ?? 0) <= 3);
  assert.doesNotMatch(streamed, /"content"/u);

  controller.render(envelope({
    type: "tool_call_completed",
    index: 0,
    id: "write-live",
    name: "write",
    rawArguments,
    arguments: { path: "architecture.html", content },
  }, ++sequence));
  controller.render(envelope({
    type: "message_appended",
    message: {
      id: "assistant-write-live",
      role: "assistant",
      content: [{ type: "tool_call", callId: "write-live", name: "write", arguments: { path: "architecture.html", content } }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, ++sequence));
  controller.render(envelope({ type: "assistant_completed", finishReason: "tool_calls" }, ++sequence));
  controller.render(envelope({
    type: "tool_requested",
    callId: "write-live",
    name: "write",
    input: { path: "architecture.html", content },
    index: 0,
  }, ++sequence));
  output.chunks.length = 0;
  controller.renderNow();
  const queued = stripAnsi(output.text);
  assert.match(queued, /write architecture\.html · 120 lines · [\d,]+ bytes · queued/u);
  assert.doesNotMatch(queued, /"content"/u);

  controller.render(envelope({
    type: "tool_started",
    callId: "write-live",
    name: "write",
    input: { path: "architecture.html", content },
    index: 0,
    recoveryMode: "never_repeat",
  }, ++sequence));
  output.chunks.length = 0;
  controller.renderNow();
  assert.match(stripAnsi(output.text), /running/u);
  assert.doesNotMatch(stripAnsi(output.text), /"content"/u);

  controller.render(envelope({
    type: "tool_completed",
    callId: "write-live",
    name: "write",
    index: 0,
    isError: false,
    preview: "Wrote architecture.html",
  }, ++sequence));
  output.chunks.length = 0;
  controller.renderNow();
  assert.match(stripAnsi(output.text), /done/u);
  assert.doesNotMatch(stripAnsi(output.text), /"content"/u);

  const deniedContent = "failure-source-must-stay-hidden";
  controller.render(envelope({
    type: "tool_requested",
    callId: "write-failed",
    name: "write",
    input: { path: "denied.html", content: deniedContent },
    index: 1,
  }, ++sequence));
  controller.render(envelope({
    type: "tool_started",
    callId: "write-failed",
    name: "write",
    input: { path: "denied.html", content: deniedContent },
    index: 1,
    recoveryMode: "never_repeat",
  }, ++sequence));
  controller.render(envelope({
    type: "tool_completed",
    callId: "write-failed",
    name: "write",
    index: 1,
    isError: true,
    preview: "permission denied",
  }, ++sequence));
  output.chunks.length = 0;
  controller.renderNow();
  const failed = stripAnsi(output.text);
  assert.match(failed, /failed/u);
  assert.match(failed, /permission denied/u);
  assert.match(failed, /failure-source-must-stay-hidden/u);
  assert.doesNotMatch(failed, /"content"/u);
  controller.close();
});

test("write argument deltas type source progressively in one card before execution starts", async () => {
  const { input, output, controller } = fullController();
  output.columns = 100;
  output.rows = 30;
  const terminal = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const viewport = (): string => {
    for (const chunk of output.chunks.slice(renderedChunks)) terminal.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
    return terminal.viewport().join("\n");
  };
  controller.start();
  viewport();
  let sequence = 0;
  controller.render(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, ++sequence));
  controller.render(envelope({ type: "assistant_started", step: 1 }, ++sequence));
  controller.render(envelope({ type: "tool_call_started", index: 0, name: "write" }, ++sequence));
  await tick();
  assert.equal((viewport().match(/write .* queued/gu)?.length ?? 0), 1);

  const source = Array.from({ length: 16 }, (_, index) => `const line${String(index + 1).padStart(2, "0")} = ${index + 1};`);
  const fragments = [
    `{\"path\":\"src/live.ts\",\"content\":\"${source[0]}`,
    `\\n${source[1]}`,
    source.slice(2).map((line) => `\\n${line}`).join(""),
    "\"}",
  ];
  const expectedFrames = [source.slice(0, 1), source.slice(0, 2), source, source];
  for (const [index, jsonFragment] of fragments.entries()) {
    controller.render(envelope({ type: "tool_call_delta", index: 0, jsonFragment }, ++sequence));
    await tick();
    const expectedTail = expectedFrames[index]!.at(-1)!;
    let live = viewport();
    for (let attempts = 0; attempts < 20 && !live.includes(expectedTail); attempts += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      live = viewport();
    }
    assert.equal((live.match(/write src\/live\.ts .* queued/gu)?.length ?? 0), 1, `frame ${index + 1}`);
    if (expectedFrames[index]!.length <= 3) assert.match(live, new RegExp(expectedFrames[index]![0]!, "u"));
    else assert.doesNotMatch(live, new RegExp(expectedFrames[index]![0]!, "u"));
    assert.match(live, new RegExp(expectedTail, "u"));
    const next = source[expectedFrames[index]!.length];
    if (next !== undefined) assert.doesNotMatch(live, new RegExp(next, "u"));
    assert.doesNotMatch(live, /\{"path"|"content":/u);
  }

  const collapsed = viewport();
  assert.match(collapsed, /earlier live input hidden; newest input follows · Ctrl\+O/u);
  assert.doesNotMatch(collapsed, /const line08 = 8;/u);
  input.write(Buffer.from([15]));
  await tick();
  const expanded = viewport();
  assert.equal((expanded.match(/write src\/live\.ts .* queued/gu)?.length ?? 0), 1);
  assert.match(expanded, /const line08 = 8;/u);
  assert.match(expanded, /const line16 = 16;/u);
  assert.doesNotMatch(expanded, /earlier live input hidden; newest input follows · Ctrl\+O/u);
  controller.close();
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
  controller.setOperatorPreferences({ hideThinkingBlock: true });
  controller.setContext({ active: true, status: "streaming" });
  controller.render(envelope({ type: "reasoning_delta", text: "inspect the failure", part: 0, visibility: "summary" }, 1));
  controller.renderNow();
  const customized = stripAnsi(output.text);
  assert.match(customized, /FRAME-[AB]/u);
  assert.match(customized, /private plan/u);
  assert.doesNotMatch(customized, /inspect the failure/u);
  assert.doesNotMatch(output.text, /\u001b\]0;unsafe/u);

  generation.abort(new Error("refresh"));
  controller.clearTranscript();
  output.chunks.length = 0;
  controller.render(envelope({ type: "reasoning_delta", text: "fresh reasoning", part: 0, visibility: "summary" }, 2));
  controller.renderNow();
  const reset = stripAnsi(output.text);
  assert.doesNotMatch(reset, /FRAME-|private plan/u);
  assert.match(reset, /Thinking\.\.\./u);
  assert.doesNotMatch(reset, /fresh reasoning/u);

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
  controller.setOperatorPreferences({ hideThinkingBlock: true });
  const first = new AbortController();
  const second = new AbortController();
  controller.setKeyedWorkingIndicator("fixture:first", { frames: ["FIRST-FRAME"], intervalMs: 60 }, first.signal);
  controller.setKeyedWorkingIndicator("fixture:second", { frames: ["SECOND-FRAME"], intervalMs: 70 }, second.signal);
  controller.setKeyedHiddenReasoningLabel("fixture:first", "first reasoning", first.signal);
  controller.setKeyedHiddenReasoningLabel("fixture:second", "second reasoning", second.signal);
  controller.render(envelope({ type: "reasoning_delta", text: "active", part: 0, visibility: "summary" }, 1));
  controller.renderNow();
  assert.match(stripAnsi(output.text), /SECOND-FRAME/u);
  assert.match(stripAnsi(output.text), /second reasoning/u);
  assert.doesNotMatch(stripAnsi(output.text), /\bactive\b/u);

  controller.setKeyedWorkingIndicator("fixture:second");
  controller.setKeyedHiddenReasoningLabel("fixture:second");
  controller.clearTranscript();
  output.chunks.length = 0;
  controller.render(envelope({ type: "reasoning_delta", text: "restored", part: 0, visibility: "summary" }, 2));
  controller.renderNow();
  assert.match(stripAnsi(output.text), /FIRST-FRAME/u);
  assert.match(stripAnsi(output.text), /first reasoning/u);
  assert.doesNotMatch(stripAnsi(output.text), /\brestored\b/u);

  second.abort(new Error("stale owner"));
  first.abort(new Error("active owner ended"));
  controller.clearTranscript();
  output.chunks.length = 0;
  controller.render(envelope({ type: "reasoning_delta", text: "native", part: 0, visibility: "summary" }, 3));
  controller.renderNow();
  const native = stripAnsi(output.text);
  assert.doesNotMatch(native, /FIRST-FRAME|SECOND-FRAME|first reasoning|second reasoning/u);
  assert.match(native, /Thinking\.\.\./u);
  assert.doesNotMatch(native, /\bnative\b/u);
  controller.close();
});

test("tool output expansion is observable, applies to future tools, and resets on abort", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({ type: "tool_requested", callId: "first", name: "read", input: { path: "a" }, index: 0 }, 1));
  model.apply(envelope({ type: "tool_completed", callId: "first", name: "read", index: 0, isError: false, preview: "a" }, 2));
  assert.equal(model.toolOutputExpanded, false);
  assert.equal(model.setToolOutputExpanded(true), true);
  assert.equal(model.entries[0]?.expanded, true);
  model.apply(envelope({ type: "tool_requested", callId: "second", name: "read", input: { path: "b" }, index: 1 }, 3));
  model.apply(envelope({ type: "tool_completed", callId: "second", name: "read", index: 1, isError: false, preview: "b" }, 4));
  assert.equal(model.entries[1]?.expanded, true);

  const { controller } = fullController();
  const generation = new AbortController();
  controller.setToolOutputExpanded(true, generation.signal);
  assert.equal(controller.getToolOutputExpanded(), true);
  generation.abort(new Error("refresh"));
  assert.equal(controller.getToolOutputExpanded(), false);
  controller.close();
});

test("advanced expansion restores the user's prior collapsed preference", () => {
  const { controller } = fullController();
  controller.render(envelope({ type: "tool_requested", callId: "prior", name: "read", input: { path: "a" }, index: 0 }, 1));
  controller.render(envelope({ type: "tool_completed", callId: "prior", name: "read", index: 0, isError: false, preview: "a" }, 2));
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
  generation.abort(new Error("refresh"));
  const third = controller.question("you> ", undefined, { cancelable: false });
  input.write("z\r");
  assert.equal(await third, "z");
  assert.equal(events.length, count);
  controller.close();
});
