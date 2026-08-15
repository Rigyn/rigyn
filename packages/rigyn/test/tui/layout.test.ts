import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_TUI_LIMITS } from "../../src/tui/controller.js";
import {
  internalTranscriptFrameAnchorState,
  renderFrame,
  renderTranscript,
  renderTranscriptFrame,
} from "../../src/tui/layout.js";
import { MAX_RETAINED_MUTATION_PREVIEW_ROWS, TuiModel } from "../../src/tui/model.js";
import { validateTerminalImage, type TerminalImageResolution } from "../../src/tui/terminal-image.js";
import { createTheme } from "../../src/tui/theme.js";
import type { TranscriptEntry, TuiViewState } from "../../src/tui/types.js";
import { cellWidth, splitGraphemes, stripAnsi } from "../../src/tui/unicode.js";
import { RIGYN_VERSION } from "../../src/version.js";
import { envelope } from "./helpers.js";

// Full-suite V8 coverage roughly doubles these cold probes; the pre-bound regressions exceeded 333 ms.
const RETAINED_TRANSCRIPT_COVERAGE_CPU_CEILING_MS = 300;

function snapshot(value: string): string {
  return value.split("\n").map((line) => line.trimEnd()).join("\n");
}

function transcriptContent(value: string): string {
  const firstNewline = value.indexOf("\n");
  return firstNewline >= 0 && stripAnsi(value.slice(0, firstNewline)) === ""
    ? value.slice(firstNewline + 1)
    : value;
}

function png(width = 20, height = 10): Buffer {
  const data = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function resolvePng(image: Parameters<NonNullable<import("../../src/tui/layout.js").TranscriptRenderOptions["resolveImage"]>>[0]): TerminalImageResolution {
  const validated = validateTerminalImage(image, 55);
  return {
    fallback: `[Image: ${validated.mediaType} ${validated.widthPx}x${validated.heightPx}]`,
    image: { ...validated, columns: 4, rows: 2 },
  };
}

test("semantic terminal zones wrap stable messages without changing visible output", () => {
  const theme = createTheme("mono", { color: false, unicode: false });
  const entries = [
    { id: "u", kind: "user" as const, text: "hello\u001b]133;A\u0007 injected" },
    { id: "a", kind: "assistant" as const, text: "simple answer" },
    { id: "at", kind: "assistant" as const, text: "using a tool", hasToolCalls: true },
    { id: "t", kind: "tool" as const, text: "done", title: "read", status: "completed" as const },
  ];
  const plain = renderTranscript(entries, 40, theme);
  const zoned = renderTranscript(entries, 40, theme, { semanticZones: true });
  const count = (needle: string) => zoned.split(needle).length - 1;
  assert.equal(count("\u001b]133;A\u0007"), 2);
  assert.equal(count("\u001b]133;B\u0007"), 2);
  assert.equal(count("\u001b]133;C\u0007"), 2);
  assert.equal(stripAnsi(zoned), plain);
  assert.ok(zoned.indexOf("\u001b]133;A\u0007") < zoned.indexOf("\u001b]133;B\u0007"));
  assert.doesNotMatch(plain, /\u001b\]133;/u);

  const projected = new TuiModel(DEFAULT_TUI_LIMITS);
  projected.apply(envelope({
    type: "message_appended",
    message: {
      id: "tool-bearing-message",
      role: "assistant",
      content: [
        { type: "text", text: "before the tool" },
        { type: "tool_call", callId: "message-tool", name: "read", arguments: { path: "src/main.ts" } },
        { type: "text", text: "after the tool" },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 1));
  const projectedZones = renderTranscript(projected.entries, 40, theme, { semanticZones: true });
  assert.doesNotMatch(projectedZones, /\u001b\]133;[ABC]/u);

  const multiBlock = new TuiModel(DEFAULT_TUI_LIMITS);
  multiBlock.apply(envelope({
    type: "message_appended",
    message: {
      id: "multi-block-message",
      role: "assistant",
      content: [
        { type: "text", text: "first block" },
        { type: "text", text: "second block" },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 2));
  const grouped = renderTranscript(multiBlock.entries, 40, theme, { semanticZones: true });
  assert.equal(grouped.split("\u001b]133;A\u0007").length - 1, 1);
  assert.equal(grouped.split("\u001b]133;B\u0007").length - 1, 1);
  assert.equal(grouped.split("\u001b]133;C\u0007").length - 1, 1);
  assert.match(stripAnsi(grouped), /first block\nsecond block/u);

  const reasoningGroup = renderTranscript([{
    id: "reasoning-block",
    kind: "reasoning",
    text: "public reasoning",
    expanded: true,
    sourceMessageId: "reasoning-message",
  }, {
    id: "answer-block",
    kind: "assistant",
    text: "final answer",
    sourceMessageId: "reasoning-message",
  }], 40, theme, { semanticZones: true });
  assert.equal(reasoningGroup.split("\u001b]133;A\u0007").length - 1, 1);
  assert.equal(reasoningGroup.split("\u001b]133;B\u0007").length - 1, 1);
  assert.equal(reasoningGroup.split("\u001b]133;C\u0007").length - 1, 1);
  assert.ok(reasoningGroup.indexOf("\u001b]133;A\u0007") < reasoningGroup.indexOf("public reasoning"));

  const reasoningOnly = renderTranscript([{
    id: "reasoning-only",
    kind: "reasoning",
    text: "reasoning without answer text",
    expanded: true,
    sourceMessageId: "reasoning-only-message",
  }], 40, theme, { semanticZones: true });
  assert.equal(reasoningOnly.split("\u001b]133;A\u0007").length - 1, 1);
  assert.equal(reasoningOnly.split("\u001b]133;B\u0007").length - 1, 1);
  assert.equal(reasoningOnly.split("\u001b]133;C\u0007").length - 1, 1);
});

test("reasoning rendering coalesces only adjacent rows", () => {
  const calls: Array<[string, string]> = [];
  renderTranscript([
    { id: "reasoning-before", kind: "reasoning", text: "reasoning before", expanded: true },
    { id: "answer", kind: "assistant", text: "answer between reasoning" },
    { id: "reasoning-after-a", kind: "reasoning", text: "reasoning after a", expanded: true },
    { id: "reasoning-after-b", kind: "reasoning", text: "reasoning after b", expanded: true },
  ], 60, createTheme("mono", { color: false, unicode: false }), {
    transformMarkdown(markdown, context) {
      calls.push([context.messageType, markdown]);
      return markdown;
    },
  });

  assert.deepEqual(calls, [
    ["assistant-thinking", "reasoning before"],
    ["assistant", "answer between reasoning"],
    ["assistant-thinking", "reasoning after a\n\nreasoning after b"],
  ]);
});

test("reasoning streams inside a full box and collapses with duration and Ctrl+T state", () => {
  const theme = createTheme("signal", { color: true, unicode: true });
  const source = "**Planning extension capability research** <!-- internal marker -->\n\nMore detail";
  const streaming = renderTranscript([{
    id: "reasoning",
    kind: "reasoning",
    text: source,
    expanded: true,
    streaming: true,
    reasoningStartedAt: 1_000,
  }], 80, theme, { activityFrame: 3, thinkingKeyHint: "Ctrl+T" });
  const streamingCollapsed = renderTranscript([{
    id: "reasoning",
    kind: "reasoning",
    text: source,
    expanded: false,
    streaming: true,
    reasoningStartedAt: 1_000,
  }], 80, theme, { activityFrame: 3, thinkingKeyHint: "Ctrl+T" });
  const collapsed = renderTranscript([{
    id: "reasoning",
    kind: "reasoning",
    text: source,
    expanded: false,
    streaming: false,
    reasoningStartedAt: 1_000,
    reasoningDurationMs: 4_200,
  }], 80, theme, { thinkingKeyHint: "Ctrl+T" });
  const expanded = renderTranscript([{
    id: "reasoning",
    kind: "reasoning",
    text: source,
    expanded: true,
    streaming: false,
    reasoningStartedAt: 1_000,
    reasoningDurationMs: 4_200,
  }], 80, theme, { thinkingKeyHint: "Ctrl+T" });

  const plainStreaming = stripAnsi(streaming);
  const plainStreamingCollapsed = stripAnsi(streamingCollapsed);
  const plainCollapsed = stripAnsi(collapsed);
  const plainExpanded = stripAnsi(expanded);
  assert.match(plainStreaming, /^┌ \\ Thinking… · Ctrl\+T collapse ─+┐$/mu);
  assert.match(plainStreaming, /^│ Planning extension capability research +│[\s\S]*^│ More detail +│$/mu);
  assert.match(plainStreaming, /^└─+┘$/mu);
  assert.doesNotMatch(plainStreaming, /<!--|internal marker/u);
  assert.match(streaming, /\u001b\[3m/u);
  assert.ok(streaming.split("\n").find((line) => stripAnsi(line).includes("Thinking…"))?.includes(theme.codes.working));
  assert.ok(streaming.split("\n").find((line) => stripAnsi(line).includes("Planning extension"))?.includes(theme.codes.info));
  assert.match(plainStreamingCollapsed, /^┌ \\ Thinking… · collapsed · Ctrl\+T expand ─+┐$/mu);
  assert.match(plainStreamingCollapsed, /^└─+┘$/mu);
  assert.doesNotMatch(plainStreamingCollapsed, /Planning extension capability research|More detail/u);
  assert.match(plainCollapsed, /^┌ Thought · 4s · collapsed · Ctrl\+T expand ─+┐$/mu);
  assert.match(plainCollapsed, /^└─+┘$/mu);
  assert.doesNotMatch(plainCollapsed, /Planning extension capability research|More detail/u);
  assert.match(plainExpanded, /^┌ Thought · 4s · complete · Ctrl\+T collapse ─+┐$/mu);
  assert.match(plainExpanded, /^│ Planning extension capability research +│[\s\S]*^│ More detail +│$/mu);
  assert.match(plainExpanded, /^└─+┘$/mu);
  assert.ok(expanded.split("\n").find((line) => stripAnsi(line).includes("Thought · 4s"))?.includes(theme.codes.info));
  assert.ok([streaming, streamingCollapsed, collapsed, expanded].every((value) =>
    value.split("\n").every((line) => cellWidth(stripAnsi(line)) <= 80)));
});

test("reasoning box and live activity share one spinner without duplicate labels", () => {
  const width = 48;
  const theme = createTheme("signal", { color: true, unicode: true });
  const view: TuiViewState = {
    context: {
      active: true,
      status: "streaming",
      activity: {
        phase: "Generating response",
        startedAt: Date.now() - 61_000,
        cancellable: true,
      },
      activityFrame: 3,
    },
    transcript: [{
      id: "live-reasoning",
      kind: "reasoning",
      text: "Planning a resize-safe 你🙂 layout",
      expanded: true,
      streaming: true,
    }],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  };
  const rendered = renderFrame(view, { columns: width, rows: 14 }, theme, {
    thinkingKeyHint: "Ctrl+T",
  }).text;
  const lines = stripAnsi(rendered).split("\n");
  const thinking = lines.find((line) => line.includes("Thinking…")) ?? "";
  const reasoning = lines.find((line) => line.includes("Planning a")) ?? "";
  const activity = lines.find((line) => line.includes("Generating response")) ?? "";

  assert.equal(cellWidth(thinking.slice(0, thinking.indexOf("Thinking…"))), 4);
  assert.equal(cellWidth(reasoning.slice(0, reasoning.indexOf("Planning a"))), 2);
  assert.equal(cellWidth(activity.slice(0, activity.indexOf("Generating response"))), 2);
  assert.match(thinking, /^┌ \\ Thinking… · Ctrl\+T collapse ─+┐$/u);
  assert.match(reasoning, /^│ Planning a resize-safe 你🙂 layout +│$/u);
  assert.equal(lines.filter((line) => line.startsWith("┌")).length, 1);
  assert.equal(lines.filter((line) => line.startsWith("└")).length, 1);
  assert.match(activity, /Generating response · 1m 1s · Esc to cancel/u);
  assert.doesNotMatch(activity, /· Generating response/u);
  assert.equal(thinking[2], activity.trimStart()[0]);
  assert.doesNotMatch(activity, /[┌┐└┘]/u);
  assert.equal(lines.filter((line) => line.includes("Thinking…")).length, 1);
  assert.equal(lines.filter((line) => line.includes("Generating response")).length, 1);
  assert.ok(lines.every((line) => cellWidth(line) === width));
});

test("completed reasoning keeps complete and collapsed Ctrl+T states inside the box", () => {
  const theme = createTheme("signal", { color: true, unicode: true });
  const entry = {
    id: "completed-reasoning",
    kind: "reasoning" as const,
    text: "A retained public thought",
    reasoningDurationMs: 4_200,
  };
  const expanded = stripAnsi(renderTranscript([{ ...entry, expanded: true }], 48, theme, {
    thinkingKeyHint: "Ctrl+T",
  }));
  const collapsed = stripAnsi(renderTranscript([{ ...entry, expanded: false }], 48, theme, {
    thinkingKeyHint: "Ctrl+T",
  }));

  assert.match(expanded, /^┌ Thought · 4s · complete · Ctrl\+T collapse ─+┐$/mu);
  assert.match(expanded, /^│ A retained public thought +│$/mu);
  assert.match(expanded, /^└─+┘$/mu);
  assert.match(collapsed, /^┌ Thought · 4s · collapsed · Ctrl\+T expand ─+┐$/mu);
  assert.match(collapsed, /^└─+┘$/mu);
  assert.doesNotMatch(collapsed, /A retained public thought/u);
  assert.equal(collapsed.split("\n").filter(Boolean).length, 2);
  assert.ok(`${expanded}\n${collapsed}`.split("\n").every((line) => cellWidth(line) <= 48));
});

test("reasoning stays inside a responsive box while sharing the global working frame", () => {
  const theme = createTheme("signal", { color: true, unicode: true });
  const rendered = stripAnsi(renderTranscript([{
    id: "boxed-live-reasoning",
    kind: "reasoning",
    text: "Inspecting the live tool pipeline",
    expanded: true,
    streaming: true,
  }], 52, theme, {
    activityFrame: 3,
    thinkingKeyHint: "Ctrl+T",
  }));
  const lines = rendered.split("\n");
  const top = lines.findIndex((line) => line.includes("Thinking…"));

  assert.notEqual(top, -1);
  assert.match(lines[top] ?? "", /^┌ \\ Thinking…/u);
  assert.match(lines[top + 1] ?? "", /^│ Inspecting the live tool pipeline/u);
  assert.match(lines[top + 2] ?? "", /^└─+┘$/u);
  assert.ok(lines.every((line) => cellWidth(line) <= 52));
});

test("long live and expanded reasoning pin the box header without discarding retained rows", () => {
  const source = Array.from(
    { length: 80 },
    (_, index) => `Thinking step ${index + 1} with Unicode 你🙂 and retained detail`,
  ).join("\n\n");
  const surfaces = [{
    columns: 40,
    rows: 20,
    theme: createTheme("signal", { color: true, unicode: true }),
    streaming: true,
    header: "Thinking…",
  }, {
    columns: 80,
    rows: 24,
    theme: createTheme("mono", { color: false, unicode: false }),
    streaming: false,
    header: "Thought",
  }] as const;

  for (const surface of surfaces) {
    const view: TuiViewState = {
      context: {
        active: surface.streaming,
        status: surface.streaming ? "streaming" : "idle",
        model: "fixture",
        activityFrame: 2,
      },
      transcript: [{
        id: `long-reasoning-${surface.columns}`,
        kind: "reasoning",
        text: source,
        expanded: true,
        streaming: surface.streaming,
        ...(surface.streaming ? {} : { reasoningDurationMs: 4_200 }),
      }],
      transcriptOffset: 0,
      editorText: "",
      editorCursor: 0,
      inputLabel: "you",
      inputMode: "normal",
    };
    const frame = renderFrame(view, {
      columns: surface.columns,
      rows: surface.rows,
    }, surface.theme, { thinkingKeyHint: "Ctrl+T" });
    const rendered = stripAnsi(frame.text);
    const lines = rendered.split("\n");

    assert.match(lines[0] ?? "", surface.theme.unicode ? /^┌/u : /^\+/u);
    assert.ok(lines[0]?.includes(surface.header));
    assert.equal(lines.filter((line) => line.includes(surface.header)).length, 1);
    assert.match(rendered, /Thinking step 80/u);
    assert.ok(lines.some((line) => surface.theme.unicode ? line.startsWith("└") : /^\+-+\+/u.test(line)));
    assert.ok(lines.every((line) => cellWidth(line) <= surface.columns));
    assert.ok((frame.transcriptNavigation?.totalRows ?? 0) > (frame.transcriptNavigation?.viewportRows ?? 0));

    const retained = stripAnsi(renderFrame({ ...view, transcriptOffset: Number.MAX_SAFE_INTEGER }, {
      columns: surface.columns,
      rows: surface.rows,
    }, surface.theme, { thinkingKeyHint: "Ctrl+T" }).text);
    assert.match(retained, /Thinking step 1/u);
  }
});

test("newline-dense expanded reasoning keeps an honest hard render cap", () => {
  const source = `reasoning-head 你🙂\n${"\n".repeat(50_000)}reasoning-tail`;
  const entry: TranscriptEntry = {
    id: "newline-dense-reasoning",
    kind: "reasoning",
    text: source,
    expanded: true,
  };
  const rendered = stripAnsi(renderTranscript(
    [entry],
    80,
    createTheme("mono", { color: false, unicode: false }),
    { thinkingKeyHint: "Ctrl+T" },
  ));

  assert.match(rendered, /reasoning-head/u);
  assert.match(rendered, /retained reasoning rows shortened; ending follows/u);
  assert.match(rendered, /reasoning-tail/u);
  assert.ok(rendered.split("\n").length <= MAX_RETAINED_MUTATION_PREVIEW_ROWS + 3);
  assert.equal(entry.text, source);
});

test("reasoning box remains cell-bounded across resize and Unicode or ASCII terminals", () => {
  const entry = {
    id: "resize-reasoning",
    kind: "reasoning" as const,
    text: "你🙂 wide reasoning that wraps safely",
    expanded: true,
    reasoningDurationMs: 2_000,
  };
  for (const theme of [
    createTheme("signal", { color: true, unicode: true }),
    createTheme("mono", { color: false, unicode: true }),
    createTheme("mono", { color: false, unicode: false }),
  ]) {
    for (const width of [1, 2, 3, 4, 8, 17, 31]) {
      const rendered = stripAnsi(renderTranscript([entry], width, theme, { thinkingKeyHint: "Ctrl+T" }));
      assert.ok(
        rendered.split("\n").every((line) => cellWidth(line) <= width),
        `${theme.name}/${theme.unicode ? "unicode" : "ascii"}/${width}: ${rendered}`,
      );
      const lines = rendered.split("\n").filter((line) => line !== "");
      assert.equal(lines[0]?.[0], theme.unicode ? "┌" : "+");
      assert.equal(lines.at(-1)?.[0], theme.unicode ? "└" : "+");
      assert.ok(lines.every((line) => cellWidth(line) === width));
    }
  }

  const wide = stripAnsi(renderTranscript([entry], 31, createTheme("mono", { color: false, unicode: true }), {
    thinkingKeyHint: "Ctrl+T",
  }));
  const narrow = stripAnsi(renderTranscript([entry], 17, createTheme("mono", { color: false, unicode: true }), {
    thinkingKeyHint: "Ctrl+T",
  }));
  assert.ok(wide.split("\n").every((line) => cellWidth(line) <= 31));
  assert.ok(narrow.split("\n").every((line) => cellWidth(line) <= 17));
  assert.match(wide, /^│ 你🙂 wide reasoning/mu);
  assert.match(narrow, /^│ 你🙂 wide/mu);
});

test("reasoning box and global activity use one configured spinner source", () => {
  const render = (
    theme: ReturnType<typeof createTheme>,
    workingIndicator: TuiViewState["workingIndicator"],
    activityFrame: number,
  ): string[] => stripAnsi(renderFrame({
    context: {
      active: true,
      status: "streaming",
      activity: { phase: "Generating response", startedAt: Date.now(), cancellable: true },
      activityFrame,
    },
    transcript: [{
      id: "spinner-reasoning",
      kind: "reasoning",
      text: "synchronized public reasoning",
      expanded: true,
      streaming: true,
    }],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
    ...(workingIndicator === undefined ? {} : { workingIndicator }),
  }, { columns: 64, rows: 14 }, theme).text).split("\n").map((line) => line.trimEnd());

  for (const [activityFrame, frame] of ["|", "/", "-", "\\"].entries()) {
    const defaults = render(createTheme("signal", { color: true, unicode: true }), undefined, activityFrame);
    assert.equal((defaults.find((line) => line.includes("Thinking…")) ?? "")[2], frame);
    assert.equal((defaults.find((line) => line.includes("Generating response")) ?? "")[0], frame);
  }

  const configured = render(
    createTheme("signal", { color: true, unicode: true }),
    { frames: ["FIRST", "SECOND"], intervalMs: 250 },
    3,
  );
  assert.match(configured.find((line) => line.includes("Thinking…")) ?? "", /^┌ SECOND Thinking…/u);
  assert.match(configured.find((line) => line.includes("Generating response")) ?? "", /^SECOND Generating response/u);

  const unevenNarrow = render(
    createTheme("signal", { color: true, unicode: true }),
    { frames: ["·", "WORK"], intervalMs: 250 },
    0,
  );
  const unevenWide = render(
    createTheme("signal", { color: true, unicode: true }),
    { frames: ["·", "WORK"], intervalMs: 250 },
    1,
  );
  assert.equal(
    unevenNarrow.find((line) => line.includes("Thinking…"))?.indexOf("Thinking…"),
    unevenWide.find((line) => line.includes("Thinking…"))?.indexOf("Thinking…"),
  );
  assert.equal(
    unevenNarrow.find((line) => line.includes("Generating response"))?.indexOf("Generating response"),
    unevenWide.find((line) => line.includes("Generating response"))?.indexOf("Generating response"),
  );

  const ascii = render(createTheme("mono", { color: false, unicode: false }), undefined, 2);
  assert.match(ascii.find((line) => line.includes("Thinking...")) ?? "", /^\+ - Thinking\.\.\./u);
  assert.match(ascii.find((line) => line.includes("Generating response")) ?? "", /^- Generating response/u);

  const hidden = render(
    createTheme("signal", { color: true, unicode: true }),
    { frames: ["SECRET"], intervalMs: 250, hidden: true },
    0,
  );
  assert.match(hidden.find((line) => line.includes("Thinking…")) ?? "", /^┌ Thinking…/u);
  assert.match(hidden.find((line) => line.includes("Generating response")) ?? "", /^Generating response/u);
  assert.doesNotMatch(hidden.join("\n"), /SECRET/u);
});

test("reasoning box keeps hidden-label and markdown-transformer contracts", () => {
  const calls: Array<{ markdown: string; streaming: boolean }> = [];
  const entry = {
    id: "reasoning",
    kind: "reasoning" as const,
    text: "source reasoning",
    expanded: true,
    streaming: true,
    reasoningStartedAt: 1_000,
  };
  const visible = renderTranscript([entry], 48, createTheme("mono", { color: false, unicode: false }), {
    transformMarkdown(markdown, context) {
      if (context.messageType === "assistant-thinking") {
        calls.push({ markdown, streaming: context.isStreaming });
        return markdown.replace("source", "transformed");
      }
      return markdown;
    },
  });
  const hidden = renderTranscript([entry], 48, createTheme("mono", { color: false, unicode: false }), {
    hideReasoningBlock: true,
  });

  assert.match(visible, /^\+ \| Thinking\.\.\. -+\+$/mu);
  assert.match(visible, /^\| transformed reasoning +\|$/mu);
  assert.match(visible, /^\+-+\+$/mu);
  assert.deepEqual(calls, [{ markdown: "source reasoning", streaming: true }]);
  assert.equal(hidden.match(/Thinking\.\.\./gu)?.length, 1);
  assert.match(hidden, /^A Thinking\.\.\.$/mu);
  assert.doesNotMatch(hidden, /source reasoning|^[+|].*Thinking/mu);
  assert.ok(visible.split("\n").every((line) => cellWidth(line) <= 48));
});

test("reasoning boxes remain cell-bounded at minimal terminal widths", () => {
  const theme = createTheme("mono", { color: false, unicode: true });
  for (const width of [1, 2, 3, 4]) {
    const rendered = renderTranscript([{
      id: `reasoning-${width}`,
      kind: "reasoning",
      text: "wide reasoning",
      expanded: true,
      reasoningDurationMs: 2_000,
    }], width, theme);
    assert.ok(rendered.split("\n").every((line) => cellWidth(stripAnsi(line)) <= width), `${width}: ${rendered}`);
  }
});

test("reasoning box stays understated beside compact tool activity rows", () => {
  const theme = createTheme("signal", { color: true, unicode: true });
  const rendered = renderTranscript([
    { id: "reasoning", kind: "reasoning", text: "Inspecting the relevant files", expanded: true },
    { id: "read", kind: "tool", title: "read", summary: "src/a.ts:1-20", status: "completed", text: "source" },
    { id: "grep", kind: "tool", title: "grep", summary: "TODO in src", status: "completed", text: "src/a.ts:2: TODO" },
    { id: "answer", kind: "assistant", text: "The focused check is complete." },
  ], 64, theme, { outputPad: 1 });
  const lines = rendered.split("\n");
  const visible = lines.map((line) => stripAnsi(line));
  const reasoningLine = lines[visible.findIndex((line) => line.includes("Inspecting the relevant files"))] ?? "";
  const readIndex = visible.findIndex((line) => line.includes("read "));
  const grepIndex = visible.findIndex((line) => line.includes("grep "));
  const answerIndex = visible.findIndex((line) => line.includes("The focused check is complete."));

  assert.match(reasoningLine, /\u001b\[3m/u);
  assert.equal(visible.find((line) => line.includes("Inspecting the relevant files"))?.indexOf("Inspecting") ?? -1, 2);
  assert.equal(visible.find((line) => line.includes("read "))?.indexOf("read") ?? -1, 2);
  assert.doesNotMatch(stripAnsi(reasoningLine), /summary|◆/iu);
  assert.ok(readIndex >= 0 && grepIndex > readIndex && answerIndex > grepIndex);
  const readPreview = visible.slice(readIndex + 1, grepIndex);
  assert.match(readPreview.join("\n"), /source/u);
  assert.equal(readPreview.at(-1), "");
  assert.match(visible[readIndex] ?? "", /^✓ read/u);
  assert.match(visible[grepIndex] ?? "", /^✓ grep/u);
  assert.ok(lines[readIndex]?.includes(theme.codes.success));
  assert.ok(lines[grepIndex]?.includes(theme.codes.success));
  assert.doesNotMatch(reasoningLine, /\u001b\[48;/u);
  assert.ok(lines[readIndex]?.includes(theme.getBgAnsi("toolPendingBg")));
  assert.ok(lines[grepIndex]?.includes(theme.getBgAnsi("toolPendingBg")));
  assert.doesNotMatch(lines[answerIndex] ?? "", /\u001b\[48;/u);
  assert.doesNotMatch(lines[answerIndex] ?? "", /✓|│/u);
});

test("Markdown transformers receive display context without mutating transcript content", () => {
  const theme = createTheme("mono", { color: false, unicode: false });
  const entries = [
    { id: "user", kind: "user" as const, text: "question" },
    { id: "assistant", kind: "assistant" as const, text: "answer", streaming: true },
    {
      id: "reasoning",
      kind: "reasoning" as const,
      text: "plan<!-- hidden marker -->",
      expanded: true,
    },
  ];
  const calls: Array<{
    markdown: string;
    messageType: "user" | "assistant" | "assistant-thinking";
    isStreaming: boolean;
    availableWidth: number;
  }> = [];
  const rendered = stripAnsi(renderTranscript(entries, 40, theme, {
    outputPad: 1,
    transformMarkdown(markdown, context) {
      calls.push({ markdown, ...context });
      return `${context.messageType}:${markdown}`;
    },
  }));

  assert.match(rendered, /user:question/u);
  assert.match(rendered, /assistant:answer/u);
  assert.match(rendered, /assistant-thinking:plan/u);
  assert.doesNotMatch(rendered, /hidden marker/u);
  assert.deepEqual(calls, [
    { markdown: "question", messageType: "user", isStreaming: false, availableWidth: 38 },
    { markdown: "answer", messageType: "assistant", isStreaming: true, availableWidth: 38 },
    { markdown: "plan", messageType: "assistant-thinking", isStreaming: false, availableWidth: 36 },
  ]);
  assert.deepEqual(entries.map((entry) => entry.text), [
    "question",
    "answer",
    "plan<!-- hidden marker -->",
  ]);

  const fallback = stripAnsi(renderTranscript([entries[1]!], 40, theme, {
    transformMarkdown() {
      throw new Error("broken display extension");
    },
  }));
  assert.match(fallback, /answer/u);
});

test("visible reasoning wraps sequential summaries within the terminal width", () => {
  const width = 34;
  const rendered = snapshot(renderTranscript([{
    id: "reasoning-wrap",
    kind: "reasoning",
    text: "**Planning renderer checks**<!-- boundary -->**Designing a focused fixture**<!-- boundary -->**Reviewing narrow terminal behavior**",
    expanded: true,
  }], width, createTheme("mono", { color: false, unicode: false })));
  const lines = rendered.split("\n");

  assert.ok(lines.length > 1);
  const flattened = rendered.replace(/\s+/gu, " ");
  assert.match(flattened, /Planning renderer checks/u);
  assert.match(flattened, /Designing a focused fixture/u);
  assert.match(flattened, /Reviewing narrow terminal[\s\S]*behavior/u);
  assert.doesNotMatch(rendered, /checksDesigning|fixtureReviewing|<!--/u);
  assert.ok(lines.every((line) => cellWidth(line) <= width));
});

test("multiple visible reasoning rows wrap independently downward", () => {
  const frame = renderFrame({
    context: { status: "idle", model: "fixture" },
    transcript: ["first", "second", "third"].map((name) => ({
      id: `reasoning-${name}`,
      kind: "reasoning" as const,
      text: `**Planning ${name} workflow with enough detail to wrap**<!-- boundary -->**Reviewing ${name} workflow without horizontal concatenation**`,
      expanded: true,
    })),
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  }, { columns: 52, rows: 24 }, createTheme("mono", { color: false, unicode: true }));
  const lines = snapshot(frame.text).split("\n");
  const starts = lines.flatMap((line, index) => line.includes("Planning ") ? [index] : []);

  assert.equal(starts.length, 3);
  assert.ok(starts[0]! < starts[1]! && starts[1]! < starts[2]!);
  assert.ok(starts.every((index) => index + 1 < lines.length && !lines[index + 1]!.includes("Planning ")));
  assert.doesNotMatch(frame.text, /workflowReviewing|concatenation◆/u);
  assert.ok(lines.every((line) => cellWidth(line) <= 52));
});

test("skill cards advertise expansion while durable summaries remain compact", () => {
  const theme = createTheme("signal", { color: true, unicode: true });
  const entries = [
    {
      id: "skill",
      kind: "status" as const,
      title: "Skill",
      summary: "review",
      text: "Inspect **every** changed file.",
      compactText: "review",
      card: "skill" as const,
      expandable: true,
      expanded: false,
    },
    {
      id: "summary",
      kind: "status" as const,
      title: "Context compacted",
      summary: "summary request · prompt 2,048 · cache read 0 (0.0% of this request) · cache write 0 · output 512",
      text: "Keep the durable decision.",
      compactText: "12,345 tokens before",
      status: "completed" as const,
      card: "compaction" as const,
      expandable: true,
      expanded: false,
    },
  ];
  const collapsed = renderTranscript(entries, 64, theme, { expandKeyHint: "Alt+T" });
  const expanded = renderTranscript(
    entries.map((entry) => ({ ...entry, expanded: true })),
    64,
    theme,
    { expandKeyHint: "Alt+T" },
  );

  assert.match(stripAnsi(collapsed), /\[skill\] review/u);
  assert.match(stripAnsi(collapsed), /Context compacted.*12,345 tokens before/u);
  assert.match(stripAnsi(collapsed), /\[skill\] review · Alt\+T expand/u);
  assert.match(stripAnsi(collapsed), /Context compacted[^\n]*Alt\+T details/u);
  assert.doesNotMatch(stripAnsi(collapsed), /summary request|prompt 2,048|cache read|output 512|Inspect every|durable decision/u);
  assert.match(stripAnsi(expanded), /\[skill\].*review[\s\S]*Inspect every changed file/u);
  const flattenedExpanded = stripAnsi(expanded).replace(/\s+/gu, " ");
  assert.match(
    flattenedExpanded,
    /Context compacted.*summary request.*prompt 2,048.*cache read 0 \(0\.0% of this.*request\).*cache write 0.*output 512.*Keep the durable decision/u,
  );
  assert.match(stripAnsi(expanded), /\[skill\] review · Alt\+T collapse/u);
  assert.match(stripAnsi(expanded), /Context compacted[^\n]*Alt\+T collapse/u);
  assert.ok(expanded.includes(theme.getBgAnsi("customMessageBg")));
  assert.ok(expanded.split("\n").every((line) => cellWidth(stripAnsi(line)) <= 64));
  const compactReceipt = renderTranscript([entries[1]!], 64, theme, { expandKeyHint: "Ctrl+O" });
  assert.equal(stripAnsi(compactReceipt).split("\n").length, 1);
  assert.match(stripAnsi(compactReceipt), /^✓ Context compacted · 12,345 tokens before · Ctrl\+O details\s*$/u);
  assert.equal(compactReceipt.includes(theme.getBgAnsi("customMessageBg")), false);
  const unbound = stripAnsi(renderTranscript(entries, 64, theme, { expandKeyHint: undefined }));
  assert.match(unbound, /Context compacted.*12,345 tokens before/u);
  assert.doesNotMatch(unbound, /Ctrl\+O|Unbound|\bexpand\b|\bcollapse\b/u);
});

test("compaction receipts stay one-line, unpadded, and background-free across terminal palettes", () => {
  const entry: TranscriptEntry = {
    id: "compact-receipt",
    kind: "status",
    title: "Context compacted",
    compactText: "230,607 tokens before",
    summary: "summary request · prompt 29,092 · cache read 0 (0.0% of this request) · cache write 0 · output 1,359",
    text: "Retained summary body",
    status: "completed",
    expanded: false,
    expandable: true,
    card: "compaction",
  };
  const themes = [
    createTheme("signal", { color: true, unicode: true }),
    createTheme("mono", { color: true, unicode: true }),
    createTheme("signal", { color: false, unicode: false }),
  ];

  for (const theme of themes) {
    const rendered = renderTranscript([entry], 80, theme, { expandKeyHint: "Ctrl+O" });
    const plain = stripAnsi(rendered);
    assert.equal(plain.split("\n").length, 1);
    assert.equal(
      plain.trimEnd(),
      `${theme.glyphs.success} Context compacted · 230,607 tokens before · Ctrl+O details`,
    );
    assert.doesNotMatch(plain, /summary request|prompt 29,092|cache read|output 1,359|Retained summary body/u);
    assert.doesNotMatch(plain, /(?:->|→)/u);
    assert.doesNotMatch(rendered, /\u001b\[(?:4[0-9]|10[0-7])m/u);
    assert.ok(cellWidth(plain) <= 80);
  }

  const noColor = renderTranscript(
    [entry],
    80,
    createTheme("signal", { color: false, unicode: false }),
    { expandKeyHint: "Ctrl+O" },
  );
  assert.doesNotMatch(noColor, /\u001b/u);

  const narrow = stripAnsi(renderTranscript(
    [entry],
    18,
    createTheme("mono", { color: false, unicode: false }),
    { expandKeyHint: "Ctrl+O" },
  ));
  assert.equal(narrow.split("\n").length, 1);
  assert.ok(cellWidth(narrow) <= 18);

  const lifecycleTheme = createTheme("signal", { color: true, unicode: true });
  for (const [status, glyph] of [
    ["running", lifecycleTheme.glyphs.pending],
    ["failed", lifecycleTheme.glyphs.failure],
  ] as const) {
    const lifecycle = stripAnsi(renderTranscript(
      [{ ...entry, title: status === "running" ? "Compacting context" : "Compaction failed", status }],
      80,
      lifecycleTheme,
      { expandKeyHint: "Ctrl+O" },
    ));
    assert.ok(lifecycle.startsWith(`${glyph} `), lifecycle);
    assert.equal(lifecycle.split("\n").length, 1);
  }
});

test("expanded compaction details use one bounded rail below the receipt", () => {
  const theme = createTheme("signal", { color: true, unicode: true });
  const rendered = renderTranscript([{
    id: "compact-details",
    kind: "status",
    title: "Context compacted",
    compactText: "230,607 tokens before",
    summary: "summary request · prompt 29,092 · cache read 0 (0.0% of this request) · cache write 0 · output 1,359",
    text: "Retained **summary** body\n\nFinal constraint",
    status: "completed",
    expanded: true,
    expandable: true,
    card: "compaction",
  }], 42, theme, { expandKeyHint: "Ctrl+O" });
  const plainLines = stripAnsi(rendered).split("\n");
  const flattened = plainLines.map((line) => line.replace(/^│ /u, "")).join(" ").replace(/\s+/gu, " ");

  assert.match(plainLines[0] ?? "", /^\u2713 Context compacted/u);
  assert.ok(plainLines.slice(1).every((line) => line.startsWith("│ ")));
  assert.match(flattened, /summary request · prompt 29,092/u);
  assert.match(flattened, /cache read 0 \(0\.0% of this request\)/u);
  assert.match(flattened, /Retained summary body/u);
  assert.match(flattened, /Final constraint/u);
  assert.doesNotMatch(flattened, /(?:->|→)/u);
  assert.doesNotMatch(rendered, /\u001b\[(?:4[0-9]|10[0-7])m/u);
  assert.ok(plainLines.every((line) => cellWidth(line) <= 42));
});

test("persistent UI supports above and below widgets plus complete header and footer replacement", () => {
  const block = (text: string) => ({ lines: [{ spans: [{ text, role: "accent" as const }] }] });
  const frame = renderFrame({
    context: {
      status: "idle",
      model: "HOST-MODEL",
      extensionHeaders: ["OLD HEADER"],
      extensionFooters: ["OLD FOOTER"],
    },
    transcript: [],
    transcriptOffset: 0,
    editorText: "draft",
    editorCursor: 5,
    inputLabel: "PROMPT",
    inputMode: "normal",
    runtimeHeaderReplacement: block("REPLACED HEADER"),
    runtimeFooterReplacement: block("REPLACED FOOTER"),
    runtimeWidgetComponents: [block("ABOVE EDITOR")],
    runtimeWidgetBelowComponents: [block("BELOW EDITOR")],
  }, { columns: 50, rows: 18 }, createTheme("mono", { color: false, unicode: true }));
  const visible = stripAnsi(frame.text);
  assert.doesNotMatch(visible, /OLD HEADER|OLD FOOTER|HOST-MODEL/u);
  const header = visible.indexOf("REPLACED HEADER");
  const above = visible.indexOf("ABOVE EDITOR");
  const editor = visible.indexOf("draft");
  const below = visible.indexOf("BELOW EDITOR");
  const footer = visible.indexOf("REPLACED FOOTER");
  assert.ok(header >= 0 && header < above && above < editor && editor < below && below < footer);
});

test("a raw footer replacement fully suppresses the built-in footer", () => {
  const frame = renderFrame({
    context: {
      status: "idle",
      workspace: "/workspace",
      releaseVersion: "fixture-version",
      provider: "openai",
      model: "gpt-test",
    },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
    usage: { total: { inputTokens: 10, outputTokens: 5 } },
    rawFooterReplacement: { lines: ["RAW FOOTER"] },
  }, { columns: 60, rows: 10 }, createTheme("mono", { color: false, unicode: true }));
  const visible = stripAnsi(frame.text);

  assert.match(visible, /RAW FOOTER/u);
  assert.doesNotMatch(visible, /workspace|v0\.8\.0 release|openai|gpt-test|in 10|out 5/u);
});

test("frame renderer produces a stable transcript, editor, and footer layout", () => {
  const view: TuiViewState = {
    context: {
      threadId: "thr_1",
      sessionName: "parser fix",
      workspace: join(homedir(), "rigyn"),
      provider: "openai",
      model: "gpt-test",
      active: true,
      status: "streaming",
      contextTokens: 10_000,
      contextWindowTokens: 20_000,
      availableProviderCount: 2,
    },
    transcript: [
      { id: "u", kind: "user", text: "Please fix the parser" },
      { id: "a", kind: "assistant", text: "I am inspecting it now." },
      {
        id: "t",
        kind: "tool",
        title: "read",
        summary: "src/parser.ts",
        callId: "c",
        status: "completed",
        text: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6",
        expanded: true,
      },
    ],
    transcriptOffset: 0,
    editorText: "next step",
    editorCursor: 4,
    inputLabel: "you",
    inputMode: "normal",
    usage: { total: { inputTokens: 10, outputTokens: 5 } },
    notice: "Ready",
  };
  const frame = renderFrame(view, { columns: 52, rows: 16 }, createTheme("mono", { color: false, unicode: false }));
  assert.equal(snapshot(frame.text), [
    "I am inspecting it now.",
    "",
    "+ read src/parser.ts · done",
    "|",
    "| line 1",
    "| line 2",
    "| line 3",
    "| line 4",
    "| line 5",
    "| line 6",
    ". Ready",
    "-".repeat(52),
    "next step",
    "-".repeat(52),
    "~/rigyn • parser fix",
    "(openai) gpt-test      ctx 50.0%/20k · in 10 · out 5",
  ].join("\n"));
  assert.deepEqual(frame.cursor, { row: 13, column: 5 });
  assert.doesNotMatch(frame.text, /thr_1/u);
});

test("interactive user messages use one padded full-width unlabeled background", () => {
  const width = 40;
  const theme = createTheme("signal", { color: true, unicode: true });
  const frame = renderFrame({
    context: { status: "idle" },
    transcript: [{ id: "u", kind: "user", text: "first line\nsecond line" }],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  }, { columns: width, rows: 12 }, theme, { outputPad: 1 });
  const messageLines = frame.text.split("\n")
    .filter((line) => line.includes(theme.getBgAnsi("userMessageBg")));

  assert.equal(messageLines.length, 4);
  assert.deepEqual(messageLines.map((line) => stripAnsi(line).trimEnd()), [
    "",
    " first line",
    " second line",
    "",
  ]);
  assert.ok(messageLines.every((line) => cellWidth(stripAnsi(line)) === width));
  assert.doesNotMatch(frame.text, /\byou>/u);

  const markdown = renderTranscript(
    [{ id: "markdown-user", kind: "user", text: "**bold** and `code`" }],
    width,
    theme,
    { outputPad: 1 },
  );
  assert.ok(markdown.includes(theme.codes.title));
  assert.ok(markdown.split("\n").every((line) => line.includes(theme.getBgAnsi("userMessageBg"))));

  const mono = createTheme("mono", { color: false, unicode: true });
  for (const columns of [1, 2, 3, 4, 5]) {
    const narrow = renderTranscript(
      [{ id: `narrow-${columns}`, kind: "user", text: "你🙂a\u001b]2;ignored\u0007" }],
      columns,
      mono,
      { outputPad: 1 },
    );
    assert.ok(narrow.split("\n").every((line) => cellWidth(line) <= columns));
    assert.doesNotMatch(narrow, /\u001b|ignored/u);
  }
});

test("interactive user messages use full-width padding by default", () => {
  const width = 40;
  const theme = createTheme("signal", { color: true, unicode: true });
  const lines = renderTranscript(
    [{ id: "default-user", kind: "user", text: "same default layout" }],
    width,
    theme,
  ).split("\n");

  assert.deepEqual(lines.map((line) => stripAnsi(line).trimEnd()), [
    "",
    " same default layout",
    "",
  ]);
  assert.ok(lines.every((line) => line.includes(theme.getBgAnsi("userMessageBg"))));
  assert.ok(lines.every((line) => cellWidth(stripAnsi(line)) === width));
});

test("padded user messages preserve blank lines and wrap Unicode at wide and narrow widths", () => {
  const theme = createTheme("signal", { color: true, unicode: true });
  const render = (columns: number, text: string): string[] => renderTranscript(
    [{ id: `user-${columns}`, kind: "user", text }],
    columns,
    theme,
    { outputPad: 1 },
  ).split("\n");

  const wide = render(24, "first\n\nthird");
  assert.deepEqual(wide.map((line) => stripAnsi(line).trimEnd()), [
    "",
    " first",
    "",
    " third",
    "",
  ]);
  assert.ok(wide.every((line) => line.includes(theme.getBgAnsi("userMessageBg"))));
  assert.ok(wide.every((line) => cellWidth(stripAnsi(line)) === 24));

  const narrow = render(8, "你🙂abcdef");
  assert.deepEqual(narrow.map((line) => stripAnsi(line).trimEnd()), [
    "",
    " 你🙂ab",
    " cdef",
    "",
  ]);
  assert.ok(narrow.every((line) => line.includes(theme.getBgAnsi("userMessageBg"))));
  assert.ok(narrow.every((line) => cellWidth(stripAnsi(line)) === 8));
});

test("footer workspace uses portable display separators", () => {
  const frame = renderFrame({
    context: {
      status: "idle",
      workspace: join(homedir(), "projects", "rigyn"),
      model: "fixture",
    },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  }, { columns: 52, rows: 10 }, createTheme("mono", { color: false, unicode: false }));

  assert.match(snapshot(frame.text), /(?:^|\n)~\/projects\/rigyn(?:\n|$)/u);
  assert.doesNotMatch(frame.text, /~\\/u);
});

test("very narrow footer rows omit graph markers without losing model state", () => {
  const frame = renderFrame({
    context: { status: "idle", model: "fixture" },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  }, { columns: 7, rows: 5 }, createTheme("mono", { color: false, unicode: false }));

  assert.equal(snapshot(frame.text).split("\n").at(-1), "fixture");
  assert.ok(frame.text.split("\n").every((line) => cellWidth(line) <= 7));
});

test("completed reads show a bounded head and expand additional retained content", () => {
  const theme = createTheme("mono", { color: false, unicode: false });
  const read = {
    id: "tool:read",
    kind: "tool" as const,
    callId: "read",
    title: "read",
    summary: "src/parser.ts:1-2",
    status: "completed" as const,
    text: Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n"),
    expanded: false,
  };
  const collapsed = snapshot(renderTranscript([read], 60, theme, { expandKeyHint: "Ctrl+O" }));
  assert.match(collapsed, /^\| line-1$/mu);
  assert.match(collapsed, /^\| line-10$/mu);
  assert.doesNotMatch(collapsed, /^\| line-11$/mu);
  assert.match(collapsed, /output shortened · Ctrl\+O/u);

  const expanded = snapshot(renderTranscript([{ ...read, expanded: true }], 60, theme, { expandKeyHint: "Ctrl+O" }));
  assert.match(expanded, /^\| line-12$/mu);
  assert.doesNotMatch(expanded, /output shortened/u);

  const shortCollapsed = snapshot(renderTranscript([{ ...read, text: "only-line", expanded: false }], 60, theme, { expandKeyHint: "Ctrl+O" }));
  const shortExpanded = snapshot(renderTranscript([{ ...read, text: "only-line", expanded: true }], 60, theme, { expandKeyHint: "Ctrl+O" }));
  assert.equal(shortCollapsed, shortExpanded);
  assert.doesNotMatch(shortCollapsed, /Ctrl\+O|\bexpand\b/iu);
});

test("head-sampled tools do not treat one final line terminator as hidden content", () => {
  const collapsedRows = { read: 10, grep: 15, find: 20, ls: 20 } as const;
  const theme = createTheme("mono", { color: false, unicode: true });
  for (const title of Object.keys(collapsedRows) as Array<keyof typeof collapsedRows>) {
    for (const expanded of [false, true]) {
      const rows = expanded ? 60 : collapsedRows[title];
      const text = Array.from({ length: rows }, (_, index) => `line-${index + 1}`).join("\n");
      const entry: TranscriptEntry = {
        id: `exact-head-${title}-${expanded}`,
        kind: "tool",
        title,
        status: "completed",
        text,
        expanded,
        toolData: { input: title === "grep" ? { pattern: "line" } : { path: `sample.${title}` } },
      };
      for (const selected of [text, `${text}\n`]) {
        const rendered = snapshot(renderTranscript([{ ...entry, text: selected }], 80, theme, {
          expandKeyHint: "Ctrl+O",
        }));
        assert.doesNotMatch(rendered, /output (?:shortened|rows shortened)|Ctrl\+O/iu, `${title}/${expanded}/${JSON.stringify(selected.at(-1))}`);
      }
      const additionalBlank = snapshot(renderTranscript([{ ...entry, text: `${text}\n\n` }], 80, theme, {
        expandKeyHint: "Ctrl+O",
      }));
      assert.match(additionalBlank, expanded ? /first rows shown/iu : /output shortened · Ctrl\+O/iu, `${title}/${expanded}/blank`);
    }
  }
});

test("tool cards keep semantic lifecycles and truthful retained-detail affordances", () => {
  const tools = ["read", "bash", "edit", "write", "grep", "find", "ls", "apply_patch", "extension_probe"] as const;
  const states = ["pending", "running", "completed", "failed", "in_doubt"] as const;
  const stateLabels = {
    pending: "queued",
    running: "running",
    completed: "done",
    failed: "failed",
    in_doubt: "outcome unknown",
  } as const;
  const rows = Array.from({ length: 40 }, (_, index) => `row${String(index + 1).padStart(2, "0")}`).join("\n");
  const argumentRows = rows.replaceAll("row", "arg");
  const inputFor = (
    title: typeof tools[number],
    status: typeof states[number],
    detail: string,
  ): NonNullable<NonNullable<TranscriptEntry["toolData"]>["input"]> => {
    if (title === "bash") return { command: "emit retained rows" };
    if (title === "grep") return { pattern: "row", path: "src" };
    if (title === "find") return { pattern: "*.ts", path: "src" };
    if (title === "extension_probe") return { payload: status === "pending" ? argumentRows : "short" };
    if (title === "write") return { path: "src/write.ts", content: detail };
    return { path: `src/${title}.txt` };
  };
  const entryFor = (
    title: typeof tools[number],
    status: typeof states[number],
    detail = rows,
  ): TranscriptEntry => {
    const mutation = title === "edit" || title === "apply_patch";
    const successMutation = status === "completed" && (title === "write" || mutation);
    const running = status === "running";
    return {
      id: `affordance-${title}-${status}`,
      kind: "tool",
      title,
      status,
      ...(title === "bash" ? {} : { summary: `src/${title}.txt` }),
      text: status === "pending" || running || successMutation ? "" : detail,
      ...(mutation ? { inputPreview: detail } : {}),
      toolData: {
        input: inputFor(title, status, detail),
        ...(running && title === "bash"
          ? { progress: { stdout: detail, stderr: "", stdoutBytes: Buffer.byteLength(detail), stderrBytes: 0, truncated: false } }
          : running
            ? { partialResult: { content: detail, isError: false } }
            : {}),
      },
    };
  };

  for (const width of [64, 12]) {
    const theme = createTheme("mono", { color: false, unicode: true });
    for (const title of tools) {
      for (const status of states) {
        const entry = entryFor(title, status);
        const collapsed = snapshot(renderTranscript([{ ...entry, expanded: false }], width, theme, {
          expandKeyHint: "Alt+T",
        }));
        const expanded = snapshot(renderTranscript([{ ...entry, expanded: true }], width, theme, {
          expandKeyHint: "Alt+T",
        }));
        const flattened = collapsed.split("\n")
          .map((line) => line.replace(/^[▸…✓✗!│]\s?/u, ""))
          .join("");
        const shouldReveal = status !== "pending" || title === "edit" || title === "write"
          || title === "apply_patch" || title === "extension_probe";
        const shouldAdvertise = status !== "pending" || title === "write"
          || title === "apply_patch" || title === "extension_probe";
        const revealedProbe = ["row01", "row20", "row25", "row40", "arg01", "arg20", "arg25", "arg40"]
          .some((probe) => expanded.includes(probe) && !collapsed.includes(probe));
        assert.match(
          flattened,
          title === "bash" && status === "in_doubt" && width === 12
            ? /unknown/u
            : new RegExp(stateLabels[status].replace(" ", "\\s*"), "u"),
          `${title}/${status}/${width}`,
        );
        assert.match(
          flattened,
          title === "bash"
            ? width === 12 ? /\$\s*emit/u : /\$\s*emit\s*retained\s*rows/u
            : new RegExp(title, "u"),
          `${title}/${status}/${width}`,
        );
        assert.equal(revealedProbe, shouldReveal, `${title}/${status}/${width} retained-detail delta`);
        if (shouldAdvertise) assert.match(collapsed, /Alt\+T/u, `${title}/${status}/${width} missing affordance`);
        else assert.doesNotMatch(collapsed, /Alt\+T|\bexpand\b/iu, `${title}/${status}/${width} false affordance`);
        assert.doesNotMatch(collapsed, /Ctrl\+O/u, `${title}/${status}/${width} stale default affordance`);
        assert.doesNotMatch(expanded, /\bexpand\b|to expand/iu, `${title}/${status}/${width} expanded wording`);
        assert.ok(
          [...collapsed.split("\n"), ...expanded.split("\n")].every((line) => cellWidth(line) <= width),
          `${title}/${status}/${width} width`,
        );
      }
    }
  }

  const unbound = snapshot(renderTranscript([
    { ...entryFor("read", "completed"), expanded: false },
  ], 64, createTheme("mono", { color: false, unicode: true }), { expandKeyHint: undefined }));
  assert.match(unbound, /output shortened/u);
  assert.doesNotMatch(unbound, /Ctrl\+O|Alt\+T|\bexpand\b/iu);

  const collapsedCompleted = (title: typeof tools[number]): string => snapshot(renderTranscript([
    { ...entryFor(title, "completed"), expanded: false },
  ], 64, createTheme("mono", { color: false, unicode: true }), { expandKeyHint: "Ctrl+O" }));
  for (const title of ["read", "grep", "find", "ls"] as const) {
    assert.match(collapsedCompleted(title), /row01/u, title);
    assert.doesNotMatch(collapsedCompleted(title), /row40/u, title);
  }
  assert.doesNotMatch(collapsedCompleted("bash"), /row01/u);
  assert.match(collapsedCompleted("bash"), /row40/u);
  assert.match(collapsedCompleted("edit"), /row01[\s\S]*row40/u);
  assert.match(collapsedCompleted("write"), /row01/u);
  assert.doesNotMatch(collapsedCompleted("write"), /row40/u);

  for (const title of tools) {
    const entry = entryFor(title, "completed", "short");
    const collapsed = snapshot(renderTranscript([{ ...entry, expanded: false }], 64, createTheme("mono", { color: false, unicode: true })));
    const expanded = snapshot(renderTranscript([{ ...entry, expanded: true }], 64, createTheme("mono", { color: false, unicode: true })));
    assert.equal(collapsed, expanded, `${title} changed without hidden detail`);
    assert.doesNotMatch(collapsed, /Ctrl\+O|\bexpand\b/iu, `${title} advertised a no-op expansion`);
  }

  const compactRead: TranscriptEntry = {
    id: "short-doc-read",
    kind: "tool",
    title: "read",
    status: "completed",
    text: "",
    toolData: { input: { path: "/workspace/packages/rigyn/docs/tui.md", offset: 1, limit: 80 } },
  };
  const compactCollapsed = snapshot(renderTranscript([{ ...compactRead, expanded: false }], 64, createTheme("mono", { color: false, unicode: true })));
  const compactExpanded = snapshot(renderTranscript([{ ...compactRead, expanded: true }], 64, createTheme("mono", { color: false, unicode: true })));
  assert.equal(compactCollapsed, compactExpanded);
  assert.doesNotMatch(compactCollapsed, /Ctrl\+O|\bexpand\b/iu);
});

test("built-in tool rows use concise operation headers and status markers", () => {
  const theme = createTheme("mono", { color: false, unicode: true });
  const rendered = snapshot(renderTranscript([
    {
      id: "read",
      kind: "tool",
      title: "read",
      status: "completed",
      text: "const value = 1;",
      toolData: { input: { path: "src/value.ts", offset: 3, limit: 8 } },
    },
    {
      id: "grep",
      kind: "tool",
      title: "grep",
      status: "completed",
      text: "src/value.ts:3:const value = 1;",
      toolData: { input: { pattern: "value", path: "src", glob: "*.ts", limit: 20 } },
    },
    {
      id: "bash",
      kind: "tool",
      title: "bash",
      status: "completed",
      text: "ok",
      toolData: {
        input: { command: "npm test", timeout: 30 },
        result: { content: "ok", isError: false, metadata: { durationMs: 1_250, exitCode: 0 } },
      },
    },
  ], 72, theme));

  assert.match(rendered, /^✓ read src\/value\.ts:3-10 · done$/mu);
  assert.match(rendered, /^✓ grep \/value\/ in src \(\*\.ts\) limit 20 · done$/mu);
  assert.match(rendered, /^✓ \$ npm test \(timeout 30s\) · done 1\.3s$/mu);
  assert.match(rendered, /^│ Took 1\.3s$/mu);
  assert.doesNotMatch(rendered, /\[[a-z0-9]+\]/iu);
});

test("host tool cards use one neutral surface while rails expose every lifecycle", () => {
  const theme = createTheme("signal", { color: true, unicode: true });
  const entries: TranscriptEntry[] = [
    {
      id: "pending-read",
      kind: "tool",
      title: "read",
      status: "pending",
      text: "",
      inputPreview: "pending input",
      toolData: { input: { path: "src/pending.ts" } },
    },
    {
      id: "running-bash",
      kind: "tool",
      title: "bash",
      status: "running",
      text: "waiting",
      toolData: {
        input: { command: "npm test" },
        progress: { stdout: "waiting", stderr: "", stdoutBytes: 7, stderrBytes: 0, elapsedMs: 2_000, truncated: false },
      },
    },
    {
      id: "completed-write",
      kind: "tool",
      title: "write",
      status: "completed",
      text: "",
      toolData: {
        input: { path: "src/output.ts", content: "export {};" },
        result: { content: "written", isError: false, metadata: { durationMs: 1_250 } },
      },
    },
    {
      id: "failed-bash",
      kind: "tool",
      title: "bash",
      status: "failed",
      text: "failed",
      toolData: {
        input: { command: "npm run check" },
        result: { content: "failed", isError: true, metadata: { exitCode: 17, durationMs: 1_900 } },
      },
    },
    {
      id: "uncertain-tool",
      kind: "tool",
      title: "deploy",
      status: "in_doubt",
      text: "outcome pending",
    },
  ];
  const rendered = renderTranscript(entries, 80, theme);
  const plain = snapshot(stripAnsi(rendered));

  assert.match(plain, /^▸ read src\/pending\.ts · queued$/mu);
  assert.match(plain, /^… \$ npm test · running 2\.0s$/mu);
  assert.match(plain, /^✓ write src\/output\.ts · done 1\.3s$/mu);
  assert.match(plain, /^✗ \$ npm run check · failed · exit 17 · 1\.9s$/mu);
  assert.match(plain, /^! deploy · outcome unknown$/mu);

  const lines = rendered.split("\n");
  const selected = (text: string): string => lines.find((line) => stripAnsi(line).includes(text)) ?? "";
  const headers = [
    "read src/pending.ts · queued",
    "$ npm test · running 2.0s",
    "write src/output.ts · done 1.3s",
    "$ npm run check · failed · exit 17 · 1.9s",
    "deploy · outcome unknown",
  ] as const;
  for (const text of headers) {
    const line = selected(text);
    assert.ok(line.includes(theme.getBgAnsi("toolPendingBg")), text);
    assert.equal(cellWidth(stripAnsi(line)), 80, text);
  }

  const bodyRails = [
    ["│ pending input", theme.codes.toolPending],
    ["│ waiting", theme.codes.toolRunning],
    ["│ failed", theme.codes.error],
    ["│ outcome pending", theme.codes.warning],
  ] as const;
  for (const [text, rail] of bodyRails) {
    const line = selected(text);
    assert.ok(line.includes(rail), text);
    assert.ok(line.includes(theme.getBgAnsi("toolPendingBg")), text);
    assert.equal(cellWidth(stripAnsi(line)), 80, text);
  }
  assert.match(plain, /export \{\};/u);
  assert.ok(rendered.split("\n").every((line) => cellWidth(line) <= 80));

  const rawMono = renderTranscript(entries, 80, createTheme("mono", { color: false, unicode: true }));
  const mono = snapshot(rawMono);
  assert.equal(mono, plain);
  const rawMonoLines = rawMono.split("\n");
  for (const text of headers) {
    const line = rawMonoLines.find((candidate) => candidate.includes(text)) ?? "";
    assert.equal(line, line.trimEnd(), text);
  }

  const ansiMonoTheme = createTheme("mono", { color: true, unicode: true });
  const ansiMono = renderTranscript(entries, 80, ansiMonoTheme);
  const ansiMonoLines = ansiMono.split("\n");
  const ansiMonoSelected = (text: string): string => ansiMonoLines.find((line) => stripAnsi(line).includes(text)) ?? "";
  for (const text of headers) {
    assert.ok(ansiMonoSelected(text).includes(ansiMonoTheme.getBgAnsi("toolPendingBg")), text);
  }
  assert.equal(snapshot(stripAnsi(ansiMono)), plain);

  const noColor = snapshot(renderTranscript([{
    id: "narrow-running",
    kind: "tool",
    title: "bash",
    status: "running",
    text: "",
    toolData: {
      input: { command: "npm run an-extremely-long-command" },
      progress: { stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, elapsedMs: 2_000, truncated: false },
    },
  }], 18, createTheme("mono", { color: false, unicode: false })));
  assert.match(noColor, /running 2\.0s/u);
  assert.ok(noColor.split("\n").every((line) => cellWidth(line) <= 18));
});

test("signal distinguishes tool lifecycles while write and edit previews stay visible", () => {
  const theme = createTheme("signal", { color: true, unicode: true });
  const rendered = renderTranscript([
    {
      id: "read",
      kind: "tool",
      title: "read",
      status: "completed",
      text: "plain text",
      expanded: true,
      toolData: { input: { path: "notes.txt" } },
    },
    {
      id: "edit",
      kind: "tool",
      title: "edit",
      status: "completed",
      summary: "src/edit.ts",
      inputPreview: "--- src/edit.ts\n+++ src/edit.ts\n@@ edit context @@\n-old edit\n+new edit",
      text: "",
    },
    {
      id: "write",
      kind: "tool",
      title: "write",
      status: "running",
      text: "",
      toolData: { input: { path: "src/write.ts", content: "const answer = 42;" } },
    },
    {
      id: "patch",
      kind: "tool",
      title: "apply_patch",
      status: "failed",
      summary: "src/patch.ts",
      inputPreview: "*** Update File: src/patch.ts\n-old patch\n+new patch",
      text: "patch rejected",
    },
    {
      id: "bash",
      kind: "tool",
      title: "bash",
      status: "completed",
      text: "done",
      expanded: true,
      toolData: { input: { command: "npm test" } },
    },
  ], 72, theme);
  const lines = rendered.split("\n");
  const selected = (text: string): string => lines.find((line) => stripAnsi(line).includes(text)) ?? "";

  assert.ok(selected("read notes.txt · done").includes(theme.codes.info));
  assert.ok(selected("edit src/edit.ts · done").includes(theme.codes.accent));
  assert.ok(selected("write src/write.ts · running").includes(theme.codes.accent));
  assert.ok(selected("apply_patch src/patch.ts · failed").includes(theme.codes.accent));
  assert.ok(selected("$ npm test").includes(theme.codes.title));
  assert.ok(selected("✓ edit").includes(theme.codes.success));
  assert.ok(selected("running").includes(theme.codes.toolRunning));
  assert.ok(selected("✗ apply_patch").includes(theme.codes.error));
  assert.ok(selected("-old edit").includes(theme.codes.error));
  assert.ok(selected("+new edit").includes(theme.codes.success));
  assert.ok(selected("-old patch").includes(theme.codes.error));
  assert.ok(selected("+new patch").includes(theme.codes.success));
  assert.ok(selected("│ plain text").includes(theme.codes.success));
  assert.ok(selected("const answer").includes(theme.codes.accent));
  assert.ok(selected("const answer").includes(theme.codes.code));
  assert.ok(selected("│ +new patch").includes(theme.codes.error));
  assert.ok(selected("│ +new patch").includes(theme.codes.success));
  assert.ok(selected("│ done").includes(theme.codes.code));
  assert.ok(selected("│ done").includes(theme.codes.success));
  assert.match(stripAnsi(rendered), /^│ -old edit[ ]*\n│ \+new edit[ ]*$/mu);
  assert.match(stripAnsi(rendered), /^│ const answer = 42;[ ]*$/mu);
  assert.doesNotMatch(stripAnsi(rendered), /"(?:path|content|oldText|newText)"\s*:/u);
  assert.ok(lines.every((line) => cellWidth(stripAnsi(line)) <= 72));

  const narrowLines = renderTranscript([{
    id: "narrow-edit",
    kind: "tool",
    title: "edit",
    status: "completed",
    summary: "src/narrow.ts",
    inputPreview: `+${"continued-addition".repeat(4)}`,
    text: "",
  }], 18, theme).split("\n");
  assert.match(stripAnsi(narrowLines.join("\n")), /edit src\/narrow\.[\s\S]*ts · done/u);
  assert.match(stripAnsi(narrowLines.join("\n")), /\+continued-addit[\s\S]*-addition/u);
  assert.doesNotMatch(stripAnsi(narrowLines.join("\n")), /"(?:path|content)"\s*:/u);
  assert.ok(narrowLines.every((line) => cellWidth(line) <= 18));
});

test("compact read classifications retain their labels without changing read semantics", () => {
  const read = (id: string, path: string): TranscriptEntry => ({
    id,
    kind: "tool",
    callId: id,
    title: "read",
    status: "completed",
    text: "",
    toolData: {
      input: { path, offset: 1, limit: 800 },
      result: { content: "", isError: false },
    },
  });
  const entries = [
    read("ordinary-read", "/workspace/src/parser.ts"),
    read("documentation-read", "/workspace/packages/rigyn/docs/extension-capabilities.md"),
    read("resource-read", "/workspace/AGENTS.md"),
    read("skill-read", "/workspace/skills/review/SKILL.md"),
  ];
  const theme = createTheme("signal", { color: true, unicode: true });
  const rendered = renderTranscript(entries, 120, theme, { expandKeyHint: "Ctrl+O" });
  const lines = rendered.split("\n");
  const selected = (text: string): string => lines.find((line) => stripAnsi(line).includes(text)) ?? "";
  const background = theme.getBgAnsi("toolPendingBg");
  const expected = [
    ["read /workspace/src/parser.ts", "read", " /workspace/src/parser.ts"],
    ["read docs docs/extension-capabilities.md", "read docs", " docs/extension-capabilities.md"],
    ["read resource /workspace/AGENTS.md", "read resource", " /workspace/AGENTS.md"],
  ] as const;

  for (const [needle, operation, target] of expected) {
    const line = selected(needle);
    assert.ok(line.includes(`${background}${theme.codes.info}${operation}`), needle);
    assert.ok(line.includes(`${background}${theme.codes.muted}${target}`), needle);
    assert.ok(line.includes(`${background}${theme.codes.success}done`), needle);
    assert.ok(!line.includes(theme.codes.title), needle);
    assert.ok(!line.includes(theme.codes.accent), needle);
  }
  assert.ok(selected("[skill] review").includes(`${background}${theme.codes.accent}[skill] `));

  const plain = snapshot(renderTranscript(
    entries,
    120,
    createTheme("mono", { color: false, unicode: false }),
    { expandKeyHint: "Ctrl+O" },
  ));
  assert.doesNotMatch(plain, /\u001b/u);
  assert.match(plain, /^\+ read \/workspace\/src\/parser\.ts:1-800 · done$/mu);
  assert.match(plain, /^\+ read docs docs\/extension-capabilities\.md:1-800 · done$/mu);
  assert.match(plain, /^\+ read resource \/workspace\/AGENTS\.md:1-800 · done$/mu);
  assert.match(plain, /^\+ \[skill\] review:1-800 · done$/mu);
  assert.doesNotMatch(plain, /Ctrl\+O|\bexpand\b/iu);
});

test("monochrome tool timelines retain operation, state, and diff cues without color", () => {
  const rendered = snapshot(renderTranscript([
    {
      id: "edit",
      kind: "tool",
      title: "edit",
      status: "completed",
      summary: "src/edit.ts",
      inputPreview: "-old\n+new",
      text: "",
    },
    {
      id: "write",
      kind: "tool",
      title: "write",
      status: "running",
      text: "",
      toolData: { input: { path: "src/write.ts", content: "next" } },
    },
    {
      id: "patch",
      kind: "tool",
      title: "apply_patch",
      status: "failed",
      summary: "src/patch.ts",
      inputPreview: "-before\n+after",
      text: "patch rejected",
    },
    {
      id: "uncertain-shell",
      kind: "tool",
      title: "bash",
      status: "in_doubt",
      text: "",
      toolData: { input: { command: "deploy" } },
    },
  ], 60, createTheme("signal", { color: false, unicode: false })));

  assert.doesNotMatch(rendered, /\u001b/u);
  assert.match(rendered, /^\+ edit src\/edit\.ts · done$/mu);
  assert.match(rendered, /^\. write src\/write\.ts · running$/mu);
  assert.match(rendered, /^x apply_patch src\/patch\.ts · failed$/mu);
  assert.match(rendered, /^! \$ deploy · outcome unknown$/mu);
  assert.match(rendered, /^\| -old\n\| \+new$/mu);
  assert.match(rendered, /^\| next$/mu);
  assert.match(rendered, /^\| -before$/mu);
  assert.match(rendered, /^\| \+after$/mu);
  assert.match(rendered, /^\| patch rejected$/mu);
  assert.doesNotMatch(rendered, /"(?:path|content|oldText|newText)"\s*:/u);
  assert.ok(rendered.split("\n").every((line) => cellWidth(line) <= 60));
});

test("native tool rows combine bounded previews and metadata in one compact group", () => {
  const theme = createTheme("mono", { color: false, unicode: true });
  const rendered = snapshot(renderTranscript([{
    id: "tool:native-read",
    kind: "tool",
    callId: "native-read",
    title: "read",
    summary: "src/parser.ts",
    status: "completed",
    text: "one\n  two\nthree\nfour\nfive\nsix\nseven",
    toolData: {
      input: { path: "src/parser.ts" },
      result: {
        content: "one\n  two\nthree\nfour\nfive\nsix\nseven",
        isError: false,
        metadata: { shownLines: 7, truncated: true },
      },
    },
    expanded: true,
  }], 52, theme));
  const lines = rendered.split("\n");

  assert.match(lines[1] ?? "", /^✓ read src\/parser\.ts · done$/u);
  assert.match(rendered, /^│ one$/mu);
  assert.match(rendered, /^│ {3}two$/mu);
  assert.match(rendered, /^│ seven$/mu);
  assert.doesNotMatch(rendered, /7 lines read|limited/u);
  assert.doesNotMatch(rendered, /more rows|Ctrl\+O/u);
  assert.doesNotMatch(rendered, /^─+$/mu);
  assert.ok(lines.every((line) => cellWidth(line) <= 52));
});

test("built-in tool headers suppress redundant argument JSON while generic tools retain it", () => {
  const theme = createTheme("mono", { color: false, unicode: true });
  for (const title of ["read", "grep", "find", "ls", "bash", "shell"]) {
    const rendered = snapshot(renderTranscript([{
      id: `tool:compact-input-${title}`,
      kind: "tool",
      title,
      summary: "visible target",
      status: "completed",
      inputPreview: '{"redundant":"argument-json"}',
      text: "visible result",
      expanded: true,
    }], 60, theme));
    assert.doesNotMatch(rendered, /argument-json/u, title);
  }

  const generic = snapshot(renderTranscript([{
    id: "tool:generic-input",
    kind: "tool",
    title: "extension_probe",
    status: "completed",
    inputPreview: '{"custom":"argument-json"}',
    text: "visible result",
    expanded: true,
  }], 60, theme));
  assert.match(generic, /argument-json/u);
});

test("completed code reads reuse the native syntax tokenizer without changing stored text", () => {
  const source = "const answer: number = 42;\nconst label = \"ready\";";
  const theme = createTheme("signal", { color: true, unicode: true });
  const rendered = renderTranscript([{
    id: "tool:syntax-read",
    kind: "tool",
    title: "read",
    summary: "src/value.ts:1-2",
    status: "completed",
    text: source,
    toolData: {
      input: { path: "src/value.ts" },
      result: { content: source, isError: false, metadata: { shownLines: 2 } },
    },
    expanded: true,
  }], 52, theme);
  const lines = rendered.split("\n");
  const sourceLines = stripAnsi(rendered).split("\n")
    .filter((line) => line.includes("const answer") || line.includes("const label"));
  const stored = sourceLines
    .map((line) => line.replace(/^│ ?/u, "").trimEnd())
    .join("\n");
  const answerLine = lines.find((line) => stripAnsi(line).includes("const answer")) ?? "";
  const labelLine = lines.find((line) => stripAnsi(line).includes("const label")) ?? "";

  assert.equal(stored, source);
  assert.ok(answerLine.includes(theme.codes.accent));
  assert.ok(answerLine.includes(theme.codes.warning));
  assert.ok(labelLine.includes(theme.codes.success));
});

test("narrow native tool headers preserve the operation target before metadata", () => {
  const width = 24;
  const rendered = snapshot(renderTranscript([{
    id: "tool:narrow-read",
    kind: "tool",
    title: "read",
    summary: "src/重要.ts",
    status: "completed",
    text: "content",
    toolData: {
      input: { path: "src/重要.ts" },
      result: { content: "content", isError: false, metadata: { shownLines: 123 } },
    },
  }], width, createTheme("mono", { color: false, unicode: true })));
  const lines = rendered.split("\n");

  assert.match(lines.find((line) => line !== "") ?? "", /read src\/重要/u);
  assert.ok(lines.every((line) => cellWidth(line) <= width));
});

test("failed shell cards keep the command surface and explicit outcome", () => {
  const theme = createTheme("mono", { color: false, unicode: false });
  const withoutMetadata = snapshot(renderTranscript([{
    id: "tool:failed-shell",
    kind: "tool",
    title: "bash",
    status: "failed",
    text: "command failed",
  }], 48, theme));
  const inconsistentMetadata = snapshot(renderTranscript([{
    id: "tool:failed-shell-metadata",
    kind: "tool",
    title: "bash",
    status: "failed",
    text: "command failed",
    toolData: { result: { content: "command failed", isError: true, metadata: { exitCode: 0 } } },
  }], 48, theme));

  assert.match(withoutMetadata, /^x \$ … · failed$/mu);
  assert.match(withoutMetadata, /^\| command failed$/mu);
  assert.doesNotMatch(withoutMetadata, /Command exited/u);
  assert.match(inconsistentMetadata, /^x \$ … · failed · exit 0$/mu);
  assert.match(inconsistentMetadata, /^\| Command exited with code 0$/mu);
});

test("narrow shell cards wrap decisive running and exit metadata", () => {
  const theme = createTheme("mono", { color: false, unicode: false });
  const failed = snapshot(renderTranscript([{
    id: "tool:narrow-failed-shell",
    kind: "tool",
    title: "bash",
    summary: "npm run an-extremely-long-command",
    status: "failed",
    text: "failed",
    toolData: { result: { content: "failed", isError: true, metadata: { exitCode: 17 } } },
  }], 24, theme));
  const running = snapshot(renderTranscript([{
    id: "tool:narrow-running-shell",
    kind: "tool",
    title: "bash",
    summary: "npm run an-extremely-long-command",
    status: "running",
    text: "waiting",
    toolData: { progress: { stdout: "waiting", stderr: "", stdoutBytes: 7, stderrBytes: 0, elapsedMs: 2_000, truncated: false } },
  }], 24, theme));

  assert.match(failed, /^x \$ npm run an-extremely$/mu);
  assert.match(failed, /^\| Command exited with$/mu);
  assert.match(failed, /^\| code 17$/mu);
  assert.match(running, /^\. \$ npm run an-extremely$/mu);
  assert.match(running, /Elapsed 2\.0s/u);
  assert.ok([...failed.split("\n"), ...running.split("\n")].every((line) => cellWidth(line) <= 24));

  const tiny = snapshot(renderTranscript([{
    id: "tool:tiny-failed-shell",
    kind: "tool",
    title: "bash",
    summary: "npm run an-extremely-long-command",
    status: "failed",
    text: "failed",
    toolData: { result: { content: "failed", isError: true, metadata: { exitCode: 17 } } },
  }], 12, theme));
  const compact = snapshot(renderTranscript([{
    id: "tool:compact-failed-shell",
    kind: "tool",
    title: "bash",
    summary: "npm run an-extremely-long-command",
    status: "failed",
    text: "failed",
    toolData: { result: { content: "failed", isError: true, metadata: { exitCode: 17 } } },
  }], 20, theme));

  assert.match(tiny, /^x \$ npm/mu);
  assert.match(compact, /^\| Command exited$/mu);
  assert.match(compact, /^\| with code 17$/mu);
  assert.ok([...tiny.split("\n"), ...compact.split("\n")].every((line) => cellWidth(line) <= 20));
});

test("running tools present structured channel tails and bounded partial errors", () => {
  const theme = createTheme("mono", { color: false, unicode: true });
  const progress = snapshot(renderTranscript([{
    id: "tool:live-progress",
    kind: "tool",
    title: "bash",
    summary: "npm test",
    status: "running",
    text: "flattened fallback must not render",
    toolData: {
      progress: {
        stdout: "one\ntwo\nthree",
        stderr: "warning line",
        stdoutBytes: 13,
        stderrBytes: 12,
        elapsedMs: 2_000,
        truncated: true,
      },
      partialResult: { content: "incremental result", isError: false },
    },
  }], 52, theme));
  const partial = renderTranscript([{
    id: "tool:partial-error",
    kind: "tool",
    title: "read",
    summary: "src/missing.ts",
    status: "running",
    text: "fallback",
    toolData: {
      partialResult: { content: "permission denied", isError: true, truncated: true },
    },
  }], 52, createTheme("mono", { color: true, unicode: true }));

  assert.match(progress, /^… \$ npm test · running 2\.0s$/mu);
  assert.match(progress, /stdout · 13 bytes/u);
  assert.match(progress, /three/u);
  assert.match(progress, /stderr · 12 bytes/u);
  assert.match(progress, /warning line/u);
  assert.match(progress, /\[Live output was shortened\]/u);
  assert.match(progress, /incremental result/u);
  assert.match(progress, /Elapsed 2\.0s/u);
  assert.doesNotMatch(progress, /flattened fallback/u);
  assert.match(stripAnsi(partial), /\[Live result was shortened\]/u);
  assert.match(stripAnsi(partial), /permission denied/u);
  assert.ok(partial.includes(createTheme("mono", { color: true, unicode: true }).codes.error));
});

test("default tool cards invalidate mutable public render inputs", () => {
  const baseTheme = createTheme("mono", { color: false, unicode: true });
  const theme = { ...baseTheme, glyphs: { ...baseTheme.glyphs } };
  const progress = {
    stdout: "first live value",
    stderr: "",
    stdoutBytes: 16,
    stderrBytes: 0,
    truncated: false,
  };
  const running: TuiViewState["transcript"][number] = {
    id: "tool:mutable-progress",
    kind: "tool",
    title: "bash",
    status: "running",
    text: "",
    toolData: { progress },
  };
  assert.match(renderTranscript([running], 60, theme), /first live value/u);
  progress.stdout = "second live value";
  progress.stdoutBytes = 17;
  const updatedProgress = renderTranscript([running], 60, theme);
  assert.match(updatedProgress, /second live value/u);
  assert.doesNotMatch(updatedProgress, /first live value/u);

  const input = { path: "first.ts" };
  const completed: TuiViewState["transcript"][number] = {
    id: "tool:mutable-input",
    kind: "tool",
    title: "read",
    status: "completed",
    text: "",
    toolData: { input },
  };
  assert.match(renderTranscript([completed], 60, theme), /^✓ read first\.ts · done\s*$/mu);
  input.path = "second.ts";
  const updatedInput = renderTranscript([completed], 60, theme);
  assert.match(updatedInput, /^✓ read second\.ts · done\s*$/mu);
  assert.doesNotMatch(updatedInput, /first\.ts/u);
});

test("cold expansion of large built-in inputs avoids whole-object serialization", () => {
  const theme = createTheme("mono", { color: false, unicode: false });
  const cpuSamples: number[] = [];
  let expanded = "";
  // Fresh entries keep every expansion cold; the median ignores one coverage/GC outlier but still rejects sustained regressions.
  for (let trial = 0; trial < 3; trial += 1) {
    let enumerations = 0;
    const entries: TranscriptEntry[] = Array.from({ length: 24 }, (_, index) => {
      const input = new Proxy({ command: `printf ${String(index).padStart(2, "0")} ${"x".repeat(48 * 1024)}` }, {
        ownKeys(target) {
          enumerations += 1;
          return Reflect.ownKeys(target);
        },
      });
      return {
        id: `large-bash-${trial}-${index}`,
        kind: "tool",
        title: "bash",
        status: "completed",
        text: "done",
        expanded: false,
        toolData: { input },
      };
    });
    renderTranscript(entries, 120, theme);
    const afterCollapsed = enumerations;
    for (const entry of entries) entry.expanded = true;
    const started = process.cpuUsage();
    expanded = renderTranscript(entries, 120, theme);
    const usage = process.cpuUsage(started);
    cpuSamples.push((usage.user + usage.system) / 1_000);
    assert.equal(enumerations, afterCollapsed, "expansion serialized every complete built-in input again");
  }
  const medianCpuMs = [...cpuSamples].sort((left, right) => left - right)[1]!;
  assert.ok(
    medianCpuMs < 100,
    `cold expansion median occupied JavaScript for ${medianCpuMs.toFixed(1)} ms (${cpuSamples.map((value) => value.toFixed(1)).join(", ")} ms)`,
  );
  assert.match(expanded, /\$ printf 00/u);
  assert.match(expanded, /\$ printf 23/u);
});

test("global expansion bounds retained write edit and extension detail", () => {
  const retained = Array.from(
    { length: 320 },
    (_, index) => `retained-${String(index + 1).padStart(3, "0")}-${"x".repeat(128)}`,
  ).join("\n");
  const entries: TranscriptEntry[] = [];
  for (let index = 0; index < 8; index += 1) {
    entries.push({
      id: `retained-write-${index}`,
      kind: "tool",
      title: "write",
      status: "completed",
      summary: `src/write-${index}.ts · 320 lines`,
      text: "",
      inputPreview: retained,
      expanded: false,
    }, {
      id: `retained-edit-${index}`,
      kind: "tool",
      title: "edit",
      status: "completed",
      summary: `src/edit-${index}.ts · 320 edits`,
      text: "",
      inputPreview: retained,
      expanded: false,
    }, {
      id: `retained-extension-${index}`,
      kind: "tool",
      title: "fixture_extension",
      status: "completed",
      text: "done",
      toolData: {
        input: { payload: retained },
      },
      expanded: false,
    });
  }
  const theme = createTheme("mono", { color: false, unicode: false });
  renderTranscript(entries, 80, theme);
  for (const entry of entries) entry.expanded = true;
  const started = process.cpuUsage();
  const expanded = renderTranscript(entries, 80, theme);
  const usage = process.cpuUsage(started);
  const cpuMs = (usage.user + usage.system) / 1_000;

  assert.ok(expanded.split("\n").length <= entries.length * 125, "expanded detail exceeded its per-card row bound");
  assert.ok(
    cpuMs < RETAINED_TRANSCRIPT_COVERAGE_CPU_CEILING_MS,
    `global retained-detail expansion occupied JavaScript for ${cpuMs.toFixed(1)} ms`,
  );
  assert.match(expanded, /retained-001/u);
  assert.match(expanded, /retained-320/u);
});

test("global expansion pre-bounds retained output for every output-bearing built-in", () => {
  const titles = ["read", "bash", "grep", "find", "ls"] as const;
  const entries: TranscriptEntry[] = [];
  for (const title of titles) {
    for (let copy = 0; copy < 4; copy += 1) {
      const text = Array.from(
        { length: 320 },
        (_, index) => `${title}-row-${String(index + 1).padStart(3, "0")}-${"x".repeat(128)}`,
      ).join("\n");
      entries.push({
        id: `retained-${title}-${copy}`,
        kind: "tool",
        title,
        status: "completed",
        text,
        expanded: false,
        ...(title === "read" ? { toolData: { input: { path: `src/read-${copy}.ts` } } } : {}),
      });
    }
  }
  const theme = createTheme("mono", { color: false, unicode: false });
  renderTranscript(entries, 80, theme);
  for (const entry of entries) entry.expanded = true;
  const started = process.cpuUsage();
  const expanded = snapshot(renderTranscript(entries, 80, theme));
  const usage = process.cpuUsage(started);
  const cpuMs = (usage.user + usage.system) / 1_000;

  assert.ok(expanded.split("\n").length <= entries.length * 126, "expanded output exceeded its per-card row bound");
  assert.ok(
    cpuMs < RETAINED_TRANSCRIPT_COVERAGE_CPU_CEILING_MS,
    `global retained-output expansion occupied JavaScript for ${cpuMs.toFixed(1)} ms`,
  );
  for (const title of ["read", "grep", "find", "ls"] as const) {
    assert.match(expanded, new RegExp(`${title}-row-001`, "u"), title);
    assert.doesNotMatch(expanded, new RegExp(`${title}-row-320`, "u"), title);
  }
  assert.doesNotMatch(expanded, /bash-row-001/u);
  assert.match(expanded, /bash-row-320/u);
  assert.match(expanded, /retained output rows shortened; ending follows/u);
  assert.doesNotMatch(expanded, /Ctrl\+O/u);

  const expandedRead = snapshot(renderTranscript(
    [{ ...entries.find((entry) => entry.title === "read")!, expanded: true }],
    80,
    theme,
  ));
  assert.match(expandedRead, /retained output rows shortened; first rows shown/u);
  assert.doesNotMatch(expandedRead, /ending follows/u);
});

test("expanded shell tails pre-bound pathological single-line and newline-dense output", () => {
  const entries: TranscriptEntry[] = [{
    id: "retained-bash-single-line",
    kind: "tool",
    title: "bash",
    status: "completed",
    text: `${"🙂".repeat(1024 * 1024)}single-tail`,
    expanded: true,
    toolData: { input: { command: "emit a large single line" } },
  }, {
    id: "retained-bash-newline-dense",
    kind: "tool",
    title: "bash",
    status: "completed",
    text: `${"old\n".repeat(1024 * 1024)}dense-tail`,
    expanded: true,
    toolData: { input: { command: "emit many lines" } },
  }];
  const started = process.cpuUsage();
  const rendered = snapshot(renderTranscript(
    entries,
    80,
    createTheme("mono", { color: false, unicode: true }),
  ));
  const usage = process.cpuUsage(started);
  const cpuMs = (usage.user + usage.system) / 1_000;

  assert.ok(rendered.split("\n").length <= entries.length * 126, "expanded shell output exceeded its row cap");
  assert.ok(cpuMs < 150, `pathological shell tails occupied JavaScript for ${cpuMs.toFixed(1)} ms`);
  assert.match(rendered.replace(/\n[│|] ?/gu, ""), /single-tail/u);
  assert.match(rendered, /dense-tail/u);
  assert.match(rendered, /retained output rows shortened; ending follows/u);
  assert.doesNotMatch(rendered, /Ctrl\+O/u);
});

test("expanded shell tails remain responsive across a retained multibyte transcript", () => {
  const entries: TranscriptEntry[] = Array.from({ length: 24 }, (_, index) => ({
    id: `retained-bash-unicode-${index}`,
    kind: "tool",
    title: "bash",
    status: "completed",
    text: `${"🙂".repeat((64 * 1024 / 4) - 4)}tail-${String(index).padStart(2, "0")}`,
    expanded: true,
    toolData: { input: { command: `emit unicode ${index}` } },
  }));
  const started = process.cpuUsage();
  const rendered = snapshot(renderTranscript(
    entries,
    80,
    createTheme("mono", { color: false, unicode: true }),
  ));
  const usage = process.cpuUsage(started);
  const cpuMs = (usage.user + usage.system) / 1_000;

  assert.ok(rendered.split("\n").length <= entries.length * 126, "retained shell transcript exceeded its row cap");
  assert.ok(
    cpuMs < RETAINED_TRANSCRIPT_COVERAGE_CPU_CEILING_MS,
    `retained multibyte shell transcript occupied JavaScript for ${cpuMs.toFixed(1)} ms`,
  );
  assert.match(rendered.replace(/\n[│|] ?/gu, ""), /tail-00/u);
  assert.match(rendered.replace(/\n[│|] ?/gu, ""), /tail-23/u);
});

test("narrow shell omission markers remain truthful in collapsed and expanded states", () => {
  const entry: TranscriptEntry = {
    id: "narrow-shell-omission",
    kind: "tool",
    title: "bash",
    status: "completed",
    text: `${"old\n".repeat(1_000)}latest`,
    expanded: false,
    toolData: { input: { command: "emit" } },
  };
  const theme = createTheme("mono", { color: false, unicode: true });
  const collapsed = snapshot(renderTranscript([entry], 12, theme, { expandKeyHint: "Ctrl+O" }));
  assert.match(collapsed, /Ctrl\+O/u);
  assert.doesNotMatch(collapsed, /\(\d+\s*…|retaine…/u);

  const expanded = snapshot(renderTranscript([{ ...entry, expanded: true }], 12, theme, { expandKeyHint: "Ctrl+O" }));
  assert.match(expanded, /… hidden/u);
  assert.doesNotMatch(expanded, /Ctrl\+O|retaine…/u);
});

test("malformed completed custom-tool input stays bounded through model projection and expansion", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  const callId = "malformed-custom-call";
  const rawArguments = `{\"payload\":\"${"🙂".repeat(128 * 1024)}TAIL`;
  model.apply(envelope({ type: "run_started", provider: "openai", model: "gpt-test" }, 1));
  model.apply(envelope({ type: "assistant_started", step: 1 }, 2));
  model.apply(envelope({ type: "tool_call_started", index: 0, id: callId, name: "custom_live" }, 3));
  model.apply(envelope({
    type: "tool_call_completed",
    index: 0,
    id: callId,
    name: "custom_live",
    rawArguments,
    parseError: "invalid JSON",
  }, 4));
  const pending = model.entries.find((candidate) => candidate.kind === "tool");
  const projectedCallId = pending?.callId;
  assert.equal(typeof projectedCallId, "string");
  model.apply(envelope({
    type: "tool_started",
    callId: projectedCallId!,
    name: "custom_live",
    input: {},
    index: 0,
    recoveryMode: "never_repeat",
  }, 5));
  model.apply(envelope({
    type: "tool_completed",
    callId: projectedCallId!,
    name: "custom_live",
    index: 0,
    isError: false,
    preview: "done",
  }, 6));

  const entry = model.entries.find((candidate) => candidate.kind === "tool");
  assert.equal(entry?.status, "completed");
  assert.equal(entry?.toolData?.input, undefined);
  assert.ok(Buffer.byteLength(entry?.inputPreview ?? "", "utf8") <= DEFAULT_TUI_LIMITS.maxToolPreviewBytes);
  assert.equal(model.toggleTool(projectedCallId), true);
  const rendered = snapshot(renderTranscript(
    model.entries,
    12,
    createTheme("mono", { color: false, unicode: true }),
  ));

  assert.ok(rendered.split("\n").length <= 126, "malformed custom input exceeded its expanded row cap");
  assert.match(rendered.replace(/\n[│|] ?/gu, ""), /TAIL/u);
  assert.match(rendered, /… (?:shortened|hidden)/u);
});

test("expanded rendererless extension messages keep an honest retained row cap", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.applySessionEntry({
    type: "custom_message",
    id: "large-extension-message",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "fixture-message",
    content: `${"extension-row\n".repeat(16 * 1024)}retained-tail`,
    display: true,
  });
  assert.equal(model.toggleTool(), true);

  const rendered = snapshot(renderTranscript(
    model.entries,
    80,
    createTheme("mono", { color: false, unicode: true }),
  ));
  assert.ok(rendered.split("\n").length <= 126, "extension fallback exceeded its expanded row cap");
  assert.match(rendered, /retained extension rows shortened/u);
});

test("global expansion bounds startup skill branch and compaction detail", () => {
  const retained = `${"retained-card-row\n".repeat(16 * 1024)}retained-card-tail`;
  const entries: TranscriptEntry[] = [{
    id: "large-startup",
    kind: "startup",
    compactText: retained,
    text: retained,
    expanded: false,
  }, {
    id: "large-skill",
    kind: "status",
    card: "skill",
    summary: "large skill",
    text: retained,
    expandable: true,
    expanded: false,
  }, {
    id: "large-branch-summary",
    kind: "status",
    card: "branch_summary",
    title: "Branch summary",
    compactText: "large branch",
    text: retained,
    expandable: true,
    expanded: false,
  }, {
    id: "large-compaction",
    kind: "status",
    card: "compaction",
    title: "Context compacted",
    compactText: "large compaction",
    summary: "summary metadata",
    text: retained,
    status: "completed",
    expandable: true,
    expanded: false,
  }];
  const theme = createTheme("mono", { color: false, unicode: true });
  const collapsed = snapshot(renderTranscript(entries, 80, theme, { expandKeyHint: "Ctrl+O" }));
  assert.ok(collapsed.split("\n").length <= 34, "collapsed startup detail exceeded its row cap");
  assert.match(collapsed, /startup shortened · Ctrl\+O/u);

  for (const entry of entries) entry.expanded = true;
  const expanded = snapshot(renderTranscript(entries, 80, theme, { expandKeyHint: "Ctrl+O" }));
  assert.ok(expanded.split("\n").length <= entries.length * 126, "expanded retained cards exceeded their row cap");
  assert.match(expanded, /retained startup rows shortened/u);
  assert.match(expanded, /retained card rows shortened/u);
  assert.doesNotMatch(expanded, /startup shortened · Ctrl\+O/u);
});

test("status-less public read cards retain their fallback body", () => {
  const rendered = snapshot(renderTranscript([{
    id: "tool:status-less-read",
    kind: "tool",
    title: "read",
    text: "visible fallback body",
  }], 60, createTheme("mono", { color: false, unicode: false })));

  assert.match(rendered, /visible fallback body/u);
});

test("running tool cards stay deterministic across resize and sanitize cell-hostile output", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({
    type: "tool_requested",
    callId: "resize-live",
    name: "bash",
    input: { command: "printf 重要🙂" },
    index: 0,
  }, 1));
  model.apply(envelope({ type: "tool_started", callId: "resize-live", name: "bash", input: {}, index: 0, recoveryMode: "never_repeat" }, 2));
  model.apply(envelope({
    type: "tool_progress",
    callId: "resize-live",
    name: "bash",
    index: 0,
    sequence: 0,
    progress: {
      type: "output",
      stream: "stdout",
      delta: "first\r\n\tsecond🙂\u001b]2;owned\u0007",
      stdoutBytes: 31,
      stderrBytes: 0,
      elapsedMs: 2_000,
    },
  }, 3));
  const theme = createTheme("mono", { color: false, unicode: true });
  const wide = snapshot(renderTranscript(model.entries, 80, theme));
  const narrow = snapshot(renderTranscript(model.entries, 24, theme));
  const wideAgain = snapshot(renderTranscript(model.entries, 80, theme));

  assert.equal(wideAgain, wide);
  assert.equal(wide.match(/^… \$ printf/gmu)?.length, 1);
  assert.equal(narrow.match(/^… \$ printf/gmu)?.length, 1);
  assert.match(wide, /printf 重要🙂/u);
  assert.match(wide, /│ first\n│ {5}second🙂/u);
  assert.doesNotMatch(`${wide}${narrow}`, /\r|\u001b|owned/u);
  assert.ok(wide.split("\n").every((line) => cellWidth(line) <= 80));
  assert.ok(narrow.split("\n").every((line) => cellWidth(line) <= 24));
});

test("running shell output keeps a small live tail until the canonical result arrives", () => {
  const output = Array.from({ length: 12 }, (_, index) => `live ${index + 1}`).join("\n");
  const rendered = snapshot(renderTranscript([{
    id: "tool:live-tail",
    kind: "tool",
    title: "bash",
    summary: "npm test",
    status: "running",
    text: "stored fallback must not render",
    toolData: {
      progress: {
        stdout: output,
        stderr: "",
        stdoutBytes: Buffer.byteLength(output),
        stderrBytes: 0,
        elapsedMs: 3_000,
        truncated: false,
      },
    },
  }], 52, createTheme("mono", { color: false, unicode: true }), { expandKeyHint: "Ctrl+O" }));

  assert.match(rendered, /\(7 earlier lines, Ctrl\+O to expand\)/u);
  assert.match(rendered, /│ live 8\n│ live 9\n│ live 10\n│ live 11\n│ live 12/u);
  assert.match(rendered, /Elapsed 3\.0s/u);
  assert.doesNotMatch(rendered, /^│ live [1-7]$/mu);
  assert.doesNotMatch(rendered, /stored fallback/u);
  assert.ok(rendered.split("\n").length <= 13);
});

test("shell headers keep the command head and status within two visual rows", () => {
  const entry: TranscriptEntry = {
    id: "bounded-shell-header",
    kind: "tool",
    title: "bash",
    status: "completed",
    text: "",
    toolData: {
      input: {
        command: `semantic-command-head-${"x".repeat(256)}`,
        timeout: 30,
      },
    },
  };
  const theme = createTheme("mono", { color: false, unicode: false });

  for (const width of [80, 12]) {
    const lines = snapshot(renderTranscript([entry], width, theme)).split("\n");
    const commandRow = lines.findIndex((line) => line.includes("$ semantic"));
    const statusRow = lines.findIndex((line) => line.includes("done"));

    assert.ok(commandRow >= 0, `missing semantic command head at width ${width}`);
    assert.ok(statusRow >= commandRow, `missing status after command at width ${width}`);
    assert.ok(statusRow - commandRow <= 1, `shell header exceeded two rows at width ${width}`);
    if (width === 80) assert.match(lines.join("\n"), /\(timeout 30s\)/u);
  }
});

test("completed narrow shell output keeps a visible bounded tail", () => {
  const rendered = snapshot(renderTranscript([{
    id: "tool:narrow-tail",
    kind: "tool",
    title: "bash",
    summary: "run",
    status: "completed",
    text: Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"),
    toolData: { result: { content: "done", isError: false, metadata: { exitCode: 0 } } },
  }], 24, createTheme("mono", { color: false, unicode: false }), { expandKeyHint: "Ctrl+O" }));

  assert.doesNotMatch(rendered, /^\| line [1-5]$/mu);
  assert.match(rendered, /^\| line 6$/mu);
  assert.match(rendered, /^\| line 10$/mu);
  assert.match(rendered, /^\| … · Ctrl\+O$/mu);
  assert.ok(rendered.split("\n").every((line) => cellWidth(line) <= 24));
});

test("completed narrow tool output wraps without dropping stored text", () => {
  const source = "src/parser.test.ts:52:7 error expected ParseError assertion";
  const rendered = snapshot(renderTranscript([{
    id: "tool:narrow-long-line",
    kind: "tool",
    title: "bash",
    summary: "npm run lint",
    status: "failed",
    text: source,
    toolData: { result: { content: source, isError: true, metadata: { exitCode: 1 } } },
  }], 32, createTheme("mono", { color: false, unicode: false })));
  const content = rendered.replace(/(?:^|\n)[x|] ?/gu, " ").replace(/\s+/gu, " ");
  assert.match(content, /src\/parser\.test\.ts:52:7 error expected ParseError assertion/u);
  assert.match(content, /Command exited with code 1/u);
  assert.ok(rendered.split("\n").every((line) => cellWidth(line) <= 32));
});

test("concise built-in headers omit result metadata badges", () => {
  const theme = createTheme("mono", { color: false, unicode: false });
  const cases = [
    ["grep", { count: 1 }, "1 match"],
    ["grep", { count: 2 }, "2 matches"],
    ["find", { count: 2, truncated: true }, "2 paths · limited"],
    ["ls", { count: 3 }, "3 entries"],
    ["edit", { replacements: 1 }, "1 replacement"],
    ["write", { bytes: 24 }, "24 bytes written"],
  ] as const;

  for (const [name, metadata, expected] of cases) {
    const rendered = snapshot(renderTranscript([{
      id: `tool:${name}`,
      kind: "tool",
      title: name,
      summary: "fixture",
      status: "completed",
      text: "result",
      toolData: { result: { content: "result", isError: false, metadata } },
      expanded: false,
    }], 48, theme));
    assert.match(rendered, new RegExp(`^\\+ ${name}\\b`, "mu"));
    assert.doesNotMatch(rendered, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});

test("collapsed reads keep a visible image-omission explanation", () => {
  const entry = {
    id: "tool:image-read",
    kind: "tool" as const,
    callId: "image-read",
    title: "read",
    summary: "diagram.png",
    status: "completed" as const,
    text: "Detected image (image/png).\nImage attachment skipped: unsupported dimensions",
    expanded: false,
    toolData: {
      result: {
        content: "Detected image (image/png).\nImage attachment skipped: unsupported dimensions",
        isError: false,
        metadata: { mediaType: "image/png", omitted: true },
      },
    },
  };

  assert.match(
    snapshot(renderTranscript([entry], 60, createTheme("mono", { color: false, unicode: false }))),
    /Image attachment skipped: unsupported dimensions/u,
  );
});

test("collapsed read errors remain visible and bounded", () => {
  const rows = Array.from({ length: 11 }, (_, index) => `read-error-${index + 1}`).join("\n");
  const entry = {
    id: "tool:failed-read",
    kind: "tool" as const,
    callId: "failed-read",
    title: "read",
    summary: "missing.txt",
    status: "failed" as const,
    text: rows,
    expanded: false,
  };
  const theme = createTheme("mono", { color: false, unicode: false });

  const collapsed = snapshot(renderTranscript([entry], 60, theme, { expandKeyHint: "Ctrl+O" }));
  assert.match(collapsed, /read-error-10/u);
  assert.match(collapsed, /output shortened · Ctrl\+O/u);
  assert.doesNotMatch(collapsed, /read-error-11/u);

  const expanded = snapshot(renderTranscript([{ ...entry, expanded: true }], 60, theme, { expandKeyHint: "Ctrl+O" }));
  assert.match(expanded, /read-error-11/u);
  assert.doesNotMatch(expanded, /more rows/u);
});

test("extension header and footer chrome stay pinned outside the scrolling transcript", () => {
  const frame = renderFrame({
    context: {
      status: "idle",
      extensionHeaders: ["Review mode"],
      extensionFooters: ["Policy checks enabled"],
    },
    transcript: Array.from({ length: 20 }, (_, index) => ({
      id: `line-${index}`,
      kind: "assistant" as const,
      text: `transcript ${index}`,
    })),
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  }, { columns: 40, rows: 12 }, createTheme("mono", { color: false, unicode: false }));
  const lines = snapshot(frame.text).split("\n");
  assert.equal(lines[0], " Review mode");
  const footerIndex = lines.indexOf(" Policy checks enabled");
  assert.ok(footerIndex > 0);
  assert.ok(footerIndex < lines.length - 1);
  assert.match(lines.slice(1, footerIndex).join("\n"), /transcript 19/u);
});

test("footer calls out high context pressure before compaction", () => {
  const base: TuiViewState = {
    context: { status: "idle", model: "fixture", contextTokens: 75, contextWindowTokens: 100 },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  };
  const theme = createTheme("mono", { color: true, unicode: true });
  const warning = renderFrame(base, { columns: 40, rows: 8 }, theme).text;
  assert.match(warning, /\u001b\[38;5;250mfixture +ctx \[██████░░\] 75\.0%\/100/u);
  const error = renderFrame({ ...base, context: { ...base.context, contextTokens: 95 } }, { columns: 40, rows: 8 }, theme).text;
  assert.match(error, /\u001b\[1;97mfixture +ctx \[████████\] 95\.0%\/100/u);
});

test("status dock exposes the live phase, elapsed time, retry countdown, and cancel key", () => {
  const frame = renderFrame({
    context: {
      status: "streaming",
      active: true,
      model: "fixture",
      activityFrame: 1,
      activity: {
        phase: "Retrying rate limit",
        startedAt: Date.now() - 1_200,
        retryAt: Date.now() + 2_000,
        attempt: 2,
        cancellable: true,
      },
    },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  }, { columns: 72, rows: 8 }, createTheme("mono", { color: false, unicode: false }));
  const lines = snapshot(frame.text).split("\n");
  const working = lines.findIndex((line) => /Retrying rate limit · 1s · attempt 2 in 2\.\ds · Esc to cancel/u.test(line));
  const borders = lines.flatMap((line, index) => line === "-".repeat(72) ? [index] : []);
  assert.ok(working > (borders.at(-1) ?? -1));
  assert.equal(working, lines.length - 2);
  assert.equal(lines.at(-1)?.trim(), "fixture");
});

test("narrow retry status keeps a complete countdown instead of a clipped detail", () => {
  const now = Date.now();
  for (const surface of [{
    columns: 32,
    theme: createTheme("signal", { color: true, unicode: true }),
  }, {
    columns: 40,
    theme: createTheme("mono", { color: false, unicode: false }),
  }]) {
    const frame = renderFrame({
      context: {
        status: "streaming",
        active: true,
        model: "fixture",
        activityFrame: 1,
        activity: {
          phase: "Retrying rate limit",
          startedAt: now - 61_200,
          retryAt: now + 2_300,
          attempt: 2,
          cancellable: true,
        },
      },
      transcript: [],
      transcriptOffset: 0,
      editorText: "",
      editorCursor: 0,
      inputLabel: "you",
      inputMode: "normal",
    }, { columns: surface.columns, rows: 8 }, surface.theme);
    const activity = snapshot(stripAnsi(frame.text)).split("\n").at(-2) ?? "";

    assert.match(activity, /Retrying rate limit/u);
    assert.match(activity, /in 2\.\ds/u);
    assert.doesNotMatch(activity, /(?:attempt|Esc to)$/u);
    assert.ok(cellWidth(activity) <= surface.columns);
  }
});

test("footer truncates an oversized model identity to the terminal width", () => {
  const frame = renderFrame({
    context: {
      status: "streaming",
      provider: "provider-with-a-very-long-name",
      model: "model-with-a-very-long-name",
      availableProviderCount: 2,
      thinking: "high",
    },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  }, { columns: 26, rows: 8 }, createTheme("mono", { color: false, unicode: false }));

  const footer = snapshot(frame.text).split("\n").at(-1) ?? "";
  assert.match(footer, /model-with-a-very/u);
  assert.ok(cellWidth(footer) <= 26);
});

test("footer distinguishes explicit thinking off from a model without reasoning", () => {
  const base: TuiViewState = {
    context: { status: "idle", model: "fixture", thinking: "off" },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  };
  const theme = createTheme("mono", { color: false, unicode: false });
  const reasoning = renderFrame({
    ...base,
    context: { ...base.context, thinkingSupported: true },
  }, { columns: 40, rows: 8 }, theme).text;
  const nonReasoning = renderFrame({
    ...base,
    context: { ...base.context, thinkingSupported: false },
  }, { columns: 40, rows: 8 }, theme).text;

  assert.match(snapshot(reasoning).split("\n").at(-1) ?? "", /fixture · thinking off$/u);
  assert.equal(snapshot(nonReasoning).split("\n").at(-1)?.trim(), "fixture");
});

test("tiny frames respect the physical terminal instead of allocating an 80 by 24 surface", () => {
  const frame = renderFrame({
    context: { status: "idle", model: "fixture" },
    transcript: [],
    transcriptOffset: 0,
    editorText: "small",
    editorCursor: 5,
    inputLabel: "you",
    inputMode: "normal",
  }, { columns: 12, rows: 4 }, createTheme("mono", { color: false, unicode: false }));
  const lines = frame.text.split("\n");
  assert.equal(lines.length, 4);
  assert.ok(lines.every((line) => cellWidth(line) <= 12));
  assert.ok((frame.cursor?.row ?? 0) <= 4);
  assert.ok((frame.cursor?.column ?? 0) <= 12);
});

test("pending image attachments render metadata only and reserve the editor cursor row", () => {
  const secretPayload = Buffer.from("sensitive image bytes").toString("base64");
  const frame = renderFrame({
    context: { status: "idle" },
    transcript: [],
    transcriptOffset: 0,
    editorText: "inspect this",
    editorCursor: 7,
    inputLabel: "you",
    inputMode: "normal",
    inputImages: [{ label: "clipboard", mediaType: "image/png", width: 320, height: 200 }],
  }, { columns: 50, rows: 10 }, createTheme("mono", { color: false, unicode: false }));
  assert.match(snapshot(frame.text), /Attachments: clipboard \(image\/png 320x200\)/u);
  assert.doesNotMatch(frame.text, new RegExp(secretPayload, "u"));
  assert.deepEqual(frame.cursor, { row: 8, column: 8 });
});

test("narrow command decks own the middle and restore the unchanged draft when closed", () => {
  const frame = renderFrame({
    context: { status: "idle" },
    transcript: [{ id: "a", kind: "assistant", text: "underlying transcript" }],
    transcriptOffset: 0,
    editorText: "draft remains",
    editorCursor: 5,
    inputLabel: "you",
    inputMode: "normal",
    overlay: {
      title: "Models",
      query: "sm",
      selected: 0,
      items: [
        { id: "b", label: "smart", detail: "large context", value: "b" },
      ],
    },
  }, { columns: 40, rows: 12 }, createTheme("mono", { color: false, unicode: false }));
  const rendered = snapshot(frame.text);
  assert.match(rendered, /^-- \[ Models · 1\/1 \]/mu);
  assert.match(rendered, /^SEARCH  sm$/mu);
  assert.match(rendered, /^> smart$/mu);
  assert.doesNotMatch(rendered, /underlying transcript|draft remains/u);
  assert.equal(rendered.split("\n").at(-1)?.trim(), "no model");
  assert.equal(frame.cursor?.column, 11);
});

test("wide pickers use the released full-width overlay geometry", () => {
  const frame = renderFrame({
    context: { status: "idle", workspace: "/workspace", model: "fixture" },
    transcript: [{ id: "a", kind: "assistant", text: "context remains visible while this deliberately long line reaches the drawer edge" }],
    transcriptOffset: 0,
    editorText: "unfinished draft",
    editorCursor: 8,
    inputLabel: "you",
    inputMode: "normal",
    overlay: {
      title: "Models",
      states: ["scoped"],
      query: "",
      selected: 0,
      items: [{ id: "one", label: "fixture", value: "one" }],
      hints: ["Up/Down navigate · Enter select · Esc cancel"],
    },
  }, { columns: 80, rows: 16 }, createTheme("mono", { color: false, unicode: true }));
  const lines = snapshot(frame.text).split("\n");
  const title = lines.findIndex((line) => /^── \[ Models · 1\/1 \]/u.test(line));
  assert.ok(title > 0);
  assert.ok(lines.slice(0, title).every((line) => line === ""));
  assert.match(frame.text, /^› fixture\s*$/mu);
  assert.doesNotMatch(frame.text, /context remains visible|unfinished draft/u);
  assert.equal(lines.at(-3), "─".repeat(80));
  assert.ok(lines.every((line) => cellWidth(line) <= 80));
  assert.equal(frame.cursor?.row, lines.findIndex((line) => line.startsWith("SEARCH")) + 1);
});

test("composer wraps whole words and keeps the grapheme cursor at the wrapped draft end", () => {
  const frame = renderFrame({
    context: { status: "idle", model: "fixture" },
    transcript: [],
    transcriptOffset: 0,
    editorText: "Switch to the balanced model and continue the audit",
    editorCursor: 51,
    inputLabel: "you",
    inputMode: "normal",
  }, { columns: 40, rows: 12 }, createTheme("mono", { color: false, unicode: true }));
  const lines = snapshot(frame.text).split("\n");
  const composer = lines.findIndex((line) => line === "─".repeat(40));

  assert.equal(lines[composer + 1], "Switch to the balanced model and");
  assert.equal(lines[composer + 2], "continue the audit");
  assert.equal(lines[composer + 3], "─".repeat(40));
  assert.deepEqual(frame.cursor, { row: 10, column: 19 });
  assert.doesNotMatch(lines[composer + 1] ?? "", /\s[a-z]$/u);
});

test("default composer and footer use plain terminal rails without graph chrome", () => {
  const frame = renderFrame({
    context: {
      status: "idle",
      workspace: join(homedir(), "rigyn"),
      provider: "openai-codex",
      model: "gpt-test",
      thinking: "high",
      thinkingSupported: true,
      contextTokens: 10_000,
      contextWindowTokens: 100_000,
    },
    transcript: [],
    transcriptOffset: 0,
    editorText: "inspect this workspace",
    editorCursor: 22,
    inputLabel: "you",
    inputMode: "normal",
    usage: {
      total: { inputTokens: 1_200, outputTokens: 75, cacheReadTokens: 800 },
      latestCacheHitRate: 40,
    },
  }, { columns: 100, rows: 10 }, createTheme("mono", { color: false, unicode: true }));
  const lines = snapshot(frame.text).split("\n");
  const top = lines.findIndex((line) => line === "─".repeat(100));

  assert.ok(top >= 0);
  assert.equal(lines[top + 1], "inspect this workspace");
  assert.equal(lines[top + 2], "─".repeat(100));
  assert.equal(lines.at(-2), "~/rigyn");
  assert.match(lines.at(-1) ?? "", /^gpt-test · high\s+ctx \[█░░░░░░░\] 10\.0%\/100k · in 2\.0k · out 75 · last cache 40\.0%$/u);
  assert.doesNotMatch(lines.slice(top).join("\n"), /[◇┬└├│]|> /u);
});

test("narrow telemetry hard-clips within the two footer rows", () => {
  const frame = renderFrame({
    context: {
      status: "idle",
      workspace: "/home/user/rigyn-demo",
      sessionName: "renderer polish",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      availableProviderCount: 4,
      thinking: "high",
      thinkingSupported: true,
      contextTokens: 48_300,
      contextWindowTokens: 372_000,
    },
    transcript: [],
    transcriptOffset: 0,
    editorText: "draft",
    editorCursor: 5,
    inputLabel: "you",
    inputMode: "normal",
    usage: {
      total: {
        inputTokens: 15_200,
        outputTokens: 2_760,
        cacheReadTokens: 9_800,
        cost: { input: 0.214, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.214 },
      },
      latestCacheHitRate: 64.5,
    },
  }, { columns: 52, rows: 12 }, createTheme("mono", { color: false, unicode: true }));
  const lines = snapshot(frame.text).split("\n");

  const footer = lines.slice(-2);
  assert.match(footer[0] ?? "", /^\/home\/user\/rigyn-demo • renderer polish/u);
  assert.match(footer[1] ?? "", /^gpt-5\.6-sol · high\s+ctx 13\.0%\/372k · in 25k/u);
  assert.doesNotMatch(footer.join("\n"), /[◇├└]|\[#---\]/u);
  assert.ok(footer.every((line) => line !== "…" && cellWidth(line) <= 52));
});

test("wide telemetry right-aligns model and thinking beside metrics", () => {
  const frame = renderFrame({
    context: {
      status: "idle",
      workspace: join(homedir(), "rigyn"),
      releaseVersion: RIGYN_VERSION,
      sessionName: "release audit",
      provider: "openai",
      model: "gpt-test",
      thinking: "max",
      thinkingSupported: true,
      contextTokens: 128_300,
      contextWindowTokens: 272_000,
    },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
    usage: {
      total: {
        inputTokens: 207_000,
        outputTokens: 31_000,
        cacheReadTokens: 4_400_000,
        cost: { input: 1, output: 2, cacheRead: 1.18, cacheWrite: 0, total: 4.18 },
      },
      latestCacheHitRate: 98,
    },
  }, { columns: 180, rows: 10 }, createTheme("mono", { color: false, unicode: true }));
  const footer = snapshot(frame.text).split("\n").slice(-2);

  assert.equal(footer[0], `~/rigyn • v${RIGYN_VERSION} release • release audit`);
  assert.match(
    footer[1] ?? "",
    /^gpt-test · max\s+ctx \[████░░░░\] 47\.2%\/272k · in 4\.6M · out 31k · last cache 98\.0% · \$4\.18$/u,
  );
  assert.equal(cellWidth(footer[1] ?? ""), 180);
  assert.doesNotMatch(footer.join("\n"), /[◇├└]/u);
  assert.match(footer[1] ?? "", /\[████░░░░\]/u);
});

test("footer distinguishes an explicit cold cache result from missing cache telemetry", () => {
  const frame = renderFrame({
    context: {
      status: "idle",
      workspace: "/workspace",
      provider: "openai-codex",
      model: "gpt-test",
    },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
    usage: {
      total: {
        inputTokens: 12_623,
        outputTokens: 26,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      latestCacheHitRate: 0,
    },
  }, { columns: 100, rows: 10 }, createTheme("mono", { color: false, unicode: true }));

  const footer = snapshot(frame.text);
  assert.match(footer, /in 13k · out 26 · last cache 0\.0%/u);
  assert.doesNotMatch(footer, /cache\+/u);
});

test("footer preserves explicit zero input and output counters", () => {
  const frame = renderFrame({
    context: {
      status: "idle",
      workspace: "/workspace",
      provider: "fixture",
      model: "zero-model",
    },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
    usage: { total: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
  }, { columns: 100, rows: 10 }, createTheme("mono", { color: false, unicode: true }));

  assert.match(snapshot(frame.text), /in 0 · out 0 · last cache n\/a/u);
});

test("footer labels unavailable cache-read telemetry after metered usage", () => {
  const frame = renderFrame({
    context: {
      status: "idle",
      workspace: "/workspace",
      provider: "ollama",
      model: "local-model",
    },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
    usage: {
      total: {
        inputTokens: 12_623,
        outputTokens: 26,
      },
    },
  }, { columns: 100, rows: 10 }, createTheme("mono", { color: false, unicode: true }));

  assert.match(snapshot(frame.text), /in 13k · out 26 · last cache n\/a/u);
});

test("footer renders only the latest request cache percentage", () => {
  const renderUsage = (usage: NonNullable<TuiViewState["usage"]>): string => snapshot(renderFrame({
    context: {
      status: "idle",
      workspace: "/workspace",
      provider: "fixture",
      model: "cache-model",
    },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
    usage,
  }, { columns: 100, rows: 10 }, createTheme("mono", { color: false, unicode: true })).text);

  const readOnly = renderUsage({
    total: { inputTokens: 200, outputTokens: 10, cacheReadTokens: 800 },
    latestCacheHitRate: 80,
  });
  assert.match(readOnly, /cache 80\.0%/u);
  assert.doesNotMatch(readOnly, /cache 800|cache\+/u);

  const writeOnly = renderUsage({ total: { inputTokens: 1_000, outputTokens: 10, cacheWriteTokens: 500 } });
  assert.match(writeOnly, /last cache n\/a/u);
  assert.doesNotMatch(writeOnly, /cache\+/u);

  const latestReadOnly = renderUsage({
    total: { inputTokens: 1_000, outputTokens: 10 },
    latestCacheReadTokens: 800,
  });
  assert.match(latestReadOnly, /last cache n\/a/u);
  assert.doesNotMatch(latestReadOnly, /last 800/u);
});

test("active footer presents reported token totals plainly and hides compaction policy", () => {
  const frame = renderFrame({
    context: {
      status: "streaming",
      active: true,
      workspace: "/workspace",
      provider: "fixture",
      model: "usage-model",
      contextTokens: 42_000,
      contextWindowTokens: 100_000,
      contextSource: "estimated",
      autoCompaction: true,
      autoCompactionThresholdPercent: 85,
    },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
    usage: {
      total: {},
      reportedTotal: { inputTokens: 12_623, outputTokens: 26 },
      latestCacheHitRate: 0,
    },
  }, { columns: 120, rows: 10 }, createTheme("mono", { color: false, unicode: true }));

  assert.match(snapshot(frame.text), /ctx \[███░░░░░\] 42\.0%\/100k/u);
  assert.doesNotMatch(snapshot(frame.text), /ctx .*~/u);
  assert.doesNotMatch(snapshot(frame.text), /auto(?:@85%)?/u);
  assert.match(snapshot(frame.text), /in 13k · out 26 · last cache 0\.0%/u);
  assert.doesNotMatch(snapshot(frame.text), /[≥>]=?/u);
});

test("narrow failed telemetry keeps the outcome instead of clipping a context field", () => {
  const frame = renderFrame({
    context: {
      status: "failed",
      model: "fixture",
      contextTokens: 95_000,
      contextWindowTokens: 100_000,
    },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
    usage: { total: { inputTokens: 123_000, outputTokens: 4_500 } },
  }, { columns: 30, rows: 8 }, createTheme("mono", { color: false, unicode: true }));

  const telemetry = snapshot(frame.text).split("\n").at(-1) ?? "";
  assert.match(telemetry, /^fixture\s+failed(?: · in 123k)?$/u);
  assert.doesNotMatch(telemetry, /ctx/u);
});

test("responsive picker composition is deterministic across wide narrow wide resize", () => {
  const view: TuiViewState = {
    context: { status: "idle", workspace: "/workspace", model: "fixture" },
    transcript: [{ id: "a", kind: "assistant", text: "wide transcript context" }],
    transcriptOffset: 0,
    editorText: "unfinished draft",
    editorCursor: 8,
    inputLabel: "you",
    inputMode: "normal",
    overlay: {
      title: "Models",
      states: ["available"],
      query: "fix",
      selected: 0,
      items: [{ id: "fixture", label: "fixture", detail: "balanced", value: "fixture" }],
      hints: ["Up/Down navigate · Enter select · Esc cancel"],
    },
  };
  const theme = createTheme("mono", { color: false, unicode: true });
  const wideBefore = renderFrame(view, { columns: 80, rows: 16 }, theme);
  const narrow = renderFrame(view, { columns: 52, rows: 16 }, theme);
  const wideAfter = renderFrame(view, { columns: 80, rows: 16 }, theme);

  assert.equal(wideAfter.text, wideBefore.text);
  assert.deepEqual(wideAfter.cursor, wideBefore.cursor);
  assert.match(wideBefore.text, /── \[ Models · 1\/1 \]/u);
  assert.match(narrow.text, /── \[ Models · 1\/1 \]/u);
  assert.doesNotMatch(wideBefore.text, /wide transcript context|unfinished draft/u);
  assert.doesNotMatch(narrow.text, /wide transcript context|unfinished draft/u);
});

test("a deeply nested selected tree row keeps its active marker and tail label visible", () => {
  const frame = renderFrame({
    context: { status: "idle" },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
    overlay: {
      title: "Session Tree",
      query: "",
      selected: 0,
      items: [{
        id: "deep",
        label: `● ${"   ".repeat(30)}└─ selected-branch-tail`,
        value: "deep",
        tree: {
          eventId: "deep",
          kind: "user",
          depth: 30,
          prefix: `${"   ".repeat(30)}└─ `,
          branches: ["main"],
          paths: ["main"],
          active: true,
        },
      }],
    },
  }, { columns: 32, rows: 9 }, createTheme("mono", { color: false, unicode: true }));
  const rendered = snapshot(frame.text);
  assert.match(rendered, /› ● ….*selected-branch-tail/u);
  assert.ok(rendered.split("\n").every((line) => cellWidth(line) <= 32));
});

test("tiny generic pickers keep their title, selected item, and one non-duplicated action row", () => {
  const frame = renderFrame({
    context: { status: "idle", workspace: "/workspace" },
    transcript: [],
    transcriptOffset: 0,
    editorText: "draft remains",
    editorCursor: 5,
    inputLabel: "you",
    inputMode: "normal",
    overlay: {
      title: "Resume Session",
      query: "ui",
      selected: 0,
      hints: [
        "↑/↓ navigate · Left/Right page",
        "Ctrl+P active/all · Enter select · Esc cancel",
      ],
      items: [{ id: "session", label: "UI audit session", value: "session" }],
    },
  }, { columns: 32, rows: 10 }, createTheme("mono", { color: false, unicode: true }));
  const rendered = snapshot(frame.text);
  const lines = rendered.split("\n");
  assert.match(rendered, /Resume Session .* 1\/1/u);
  assert.match(rendered, /^SEARCH  ui$/mu);
  assert.match(rendered, /^› UI audit session$/mu);
  assert.match(rendered, /Enter select · Esc cancel/u);
  assert.equal(rendered.match(/Enter select/gu)?.length, 1);
  const title = lines.findIndex((line) => line.startsWith("── [ Resume Session · 1/1 ]"));
  assert.ok(title >= 0);
  assert.ok(lines.slice(0, title).every((line) => line === ""));
  assert.equal(lines.at(-3), "─".repeat(32));
  assert.doesNotMatch(rendered, /draft remains/u);
});

test("tiny empty model pickers wrap their recovery message and retain cancel help", () => {
  const frame = renderFrame({
    context: { status: "idle", workspace: "/workspace" },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
    overlay: {
      title: "Models",
      pickerKind: "model",
      query: "",
      selected: 0,
      items: [],
      emptyMessage: "No available models. Use /login to connect a provider.",
    },
  }, { columns: 32, rows: 10 }, createTheme("mono", { color: false, unicode: true }));
  const rendered = snapshot(frame.text);
  assert.match(rendered, /No available models/u);
  assert.match(rendered.replace(/\s+/gu, " "), /\/login to connect/u);
  assert.match(rendered, /provider\./u);
  assert.match(rendered, /Esc cancel/u);
  assert.doesNotMatch(rendered, /[╭╮╰╯]/u);
});

test("tiny settings keep multiple choices and compact change and cancel help", () => {
  const frame = renderFrame({
    context: { status: "idle", workspace: "/workspace" },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
    overlay: {
      title: "Settings",
      settings: true,
      states: ["project"],
      status: "Changes save immediately",
      query: "",
      selected: 0,
      selectedDescription: "Automatically compact context when it gets too large",
      hints: ["Type to search · Enter/Space/Right to change · Left previous · Esc close"],
      items: Array.from({ length: 9 }, (_, index) => ({
        id: `setting-${index}`,
        label: index === 0 ? "Auto-compact" : `Setting ${index + 1}`,
        detail: index === 0 ? "true" : "off",
        value: index,
      })),
    },
  }, { columns: 32, rows: 10 }, createTheme("mono", { color: false, unicode: true }));
  const rendered = snapshot(frame.text);
  const lines = rendered.split("\n");
  assert.match(rendered, /→ Auto-compact\s+true/u);
  assert.match(rendered, /Setting 2/u);
  assert.match(rendered, /Enter\/Space change/u);
  assert.match(rendered, /Esc close/u);
  assert.match(lines[0] ?? "", /^── \[ Settings · 1\/9 \]/u);
  assert.doesNotMatch(rendered, /[╭╮╰╯]/u);
  assert.equal(frame.cursor?.row, lines.findIndex((line) => line.startsWith("SEARCH")) + 1);
});

test("runtime overlays compose by terminal cells without replacing the editor", () => {
  const frame = renderFrame({
    context: { status: "idle" },
    transcript: [{ id: "a", kind: "assistant", text: "underlying transcript" }],
    transcriptOffset: 0,
    editorText: "draft remains",
    editorCursor: 5,
    inputLabel: "you",
    inputMode: "normal",
    runtimeOverlay: {
      width: 12,
      focused: true,
      options: { anchor: "top-right", margin: { top: 1, right: 2 } },
      block: {
        lines: [
          { spans: [{ text: "界 panel", role: "accent" }], fill: true },
          { spans: [{ text: "second", role: "success" }], fill: true },
        ],
        cursor: { row: 0, column: 2 },
      },
    },
  }, { columns: 40, rows: 12 }, createTheme("mono", { color: false, unicode: true }));
  const lines = frame.text.split("\n").map(stripAnsi);
  assert.match(lines[1] ?? "", /界 panel/u);
  assert.match(frame.text, /draft remains/u);
  for (const line of lines) assert.equal(cellWidth(line), 40);
  assert.deepEqual(frame.cursor, { row: 2, column: 29 });
});

test("background cells fill only unoccupied transcript, editor, and overlay cells", () => {
  const columns = 24;
  const rows = 12;
  const backgroundCells = Array.from({ length: columns * rows }, (_, index) => ({
    row: Math.floor(index / columns),
    column: index % columns,
    text: "·",
  }));
  const theme = createTheme("mono", { color: true, unicode: true });
  const frame = renderFrame({
    context: { status: "idle" },
    transcript: [{ id: "a", kind: "assistant", text: "foreground" }],
    transcriptOffset: 0,
    editorText: "draft",
    editorCursor: 5,
    inputLabel: "you",
    inputMode: "normal",
    backgroundCells,
    runtimeOverlays: [{
      width: 8,
      focused: false,
      options: { row: 0, col: 0 },
      block: { lines: [{ spans: [{ text: "PANEL" }], fill: true }] },
    }],
    rawRuntimeOverlays: [{
      width: 4,
      focused: false,
      options: { row: 1, col: 0 },
      block: { lines: ["RAW"] },
    }],
  }, { columns, rows }, theme);
  const lines = frame.text.split("\n").map(stripAnsi);

  assert.equal(lines[0]?.slice(0, 9), "PANEL   ·", "a filled structural overlay owns its complete width");
  assert.equal(lines[1]?.slice(0, 5), "RAW ·", "a raw overlay remains opaque within its declared width");
  assert.match(lines.join("\n"), /foreground/u);
  assert.match(lines.join("\n"), /draft/u);
  assert.ok(lines.some((line) => /^·+$/u.test(line)), "empty rows expose the background plane");
  assert.ok(lines.every((line) => cellWidth(line) === columns));
  assert.ok(frame.text.includes(`${theme.codes.muted}·\u001b[0m`), "the host theme styles background glyphs");
});

test("stacked runtime overlays compose in order and preserve terminal cell widths", () => {
  const frame = renderFrame({
    context: { status: "idle" },
    transcript: [],
    transcriptOffset: 0,
    editorText: "draft",
    editorCursor: 5,
    inputLabel: "you",
    inputMode: "normal",
    runtimeOverlays: [
      {
        width: 10,
        focused: false,
        options: { anchor: "top-left" },
        block: { lines: [{ spans: [{ text: "first界", role: "accent" }], fill: true }] },
      },
      {
        width: 10,
        focused: true,
        options: { anchor: "top-left" },
        block: {
          lines: [{ spans: [{ text: "second", role: "success" }], fill: true }],
          cursor: { row: 0, column: 3 },
        },
      },
    ],
  }, { columns: 40, rows: 12 }, createTheme("mono", { color: false, unicode: true }));
  const lines = frame.text.split("\n").map(stripAnsi);
  assert.match(lines[0] ?? "", /^second/u);
  assert.doesNotMatch(lines[0] ?? "", /first/u);
  assert.match(frame.text, /draft/u);
  for (const line of lines) assert.equal(cellWidth(line), 40);
  assert.deepEqual(frame.cursor, { row: 1, column: 4 });
});

test("runtime overlay absolute and percentage coordinates respect edge margins", () => {
  const base: Omit<TuiViewState, "runtimeOverlays"> = {
    context: { status: "idle" },
    transcript: [],
    transcriptOffset: 0,
    editorText: "draft",
    editorCursor: 5,
    inputLabel: "you",
    inputMode: "normal",
  };
  const absolute = renderFrame({
    ...base,
    runtimeOverlays: [{
      width: 8,
      focused: false,
      options: { row: 0, col: 0, margin: { top: 2, right: 4, bottom: 1, left: 3 } },
      block: { lines: [{ spans: [{ text: "ABS" }], fill: true }] },
    }],
  }, { columns: 40, rows: 12 }, createTheme("mono", { color: false, unicode: true }));
  const absoluteLines = absolute.text.split("\n").map(stripAnsi);
  assert.equal(absoluteLines[2]?.slice(3, 6), "ABS");

  const percentage = renderFrame({
    ...base,
    runtimeOverlays: [{
      width: 8,
      focused: false,
      options: { row: "100%", col: "100%", margin: { top: 2, right: 4, bottom: 1, left: 3 } },
      block: { lines: [{ spans: [{ text: "EDGE" }], fill: true }] },
    }],
  }, { columns: 40, rows: 12 }, createTheme("mono", { color: false, unicode: true }));
  const percentageLines = percentage.text.split("\n").map(stripAnsi);
  assert.equal(percentageLines[10]?.slice(28, 32), "EDGE");
  for (const line of [...absoluteLines, ...percentageLines]) assert.equal(cellWidth(line), 40);
});

test("compact frames omit fixed-height top padding without losing the editor cursor", () => {
  const view: TuiViewState = {
    context: { status: "idle" },
    transcript: [],
    transcriptOffset: 0,
    editorText: "draft",
    editorCursor: 5,
    inputLabel: "you",
    inputMode: "normal",
  };
  const theme = createTheme("mono", { color: false, unicode: false });
  const compact = renderFrame(view, { columns: 40, rows: 24 }, theme, { compact: true });
  const full = renderFrame(view, { columns: 40, rows: 24 }, theme);
  assert.equal(compact.text.split("\n").length, 5);
  assert.equal(snapshot(compact.text).split("\n")[1], "-".repeat(40));
  assert.deepEqual(compact.cursor, { row: 3, column: 6 });
  assert.equal(full.text.split("\n").length, 24);

  const prompted = renderFrame({
    ...view,
    inputPrompt: "Approval required\n[y] once",
  }, { columns: 40, rows: 24 }, theme, { compact: true });
  const promptedLines = prompted.text.split("\n").map(stripAnsi);
  const editorRow = promptedLines.findIndex((line) => line.includes("draft"));
  assert.ok(editorRow >= 0);
  assert.ok(prompted.cursor !== undefined);
  assert.equal(prompted.cursor.row - 1, editorRow);
});

test("completed shell output uses a width-aware tail until expanded and preserves truncation metadata", () => {
  const base: TuiViewState = {
    context: { status: "idle" },
    transcript: [{
      id: "tool:c",
      kind: "tool",
      callId: "c",
      title: "shell",
      summary: "npm test",
      status: "completed",
      text: "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight",
      toolData: {
        result: {
          content: "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight",
          isError: false,
          metadata: { exitCode: 0, durationMs: 61_000, truncated: true, fullOutputPath: "/tmp/npm-test.log" },
        },
      },
      expanded: false,
    }],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  };
  const theme = createTheme("mono", { color: false, unicode: false });
  const collapsed = snapshot(renderTranscript(base.transcript, 80, theme));
  assert.match(collapsed, /^\+ \$ npm test · done 61\.0s$/mu);
  assert.match(collapsed, /^\| four\n\| five\n\| six\n\| seven\n\| eight$/mu);
  assert.match(collapsed, /^\| Took 61\.0s$/mu);
  assert.match(collapsed, /^\| Full output: \/tmp\/npm-test\.log\n\| \.\.\. \(3 earlier lines, Ctrl\+O to expand\)$/mu);
  assert.doesNotMatch(collapsed, /^\| one$/mu);

  const expanded = snapshot(renderTranscript([{ ...base.transcript[0]!, expanded: true }], 80, theme));
  assert.match(expanded, /^\| one\n\| two\n\| three\n\| four\n\| five\n\| six\n\| seven\n\| eight$/mu);
  assert.doesNotMatch(expanded, /earlier rows/u);
  assert.notEqual(expanded, collapsed);
  assert.equal(expanded.match(/^\+ \$ npm test/gmu)?.length, 1);
});

test("collapsed built-in tool expansion hints are always the final card line", () => {
  const theme = createTheme("mono", { color: false, unicode: false });
  const rows = Array.from({ length: 30 }, (_, index) => `row-${index + 1}`).join("\n");
  const cases: TranscriptEntry[] = [{
    id: "tool:read-footer",
    kind: "tool",
    callId: "read-footer",
    title: "read",
    status: "completed",
    text: rows,
    toolData: { input: { path: "large.txt" } },
    expanded: false,
  }, {
    id: "tool:bash-footer",
    kind: "tool",
    callId: "bash-footer",
    title: "bash",
    status: "completed",
    text: rows,
    toolData: {
      input: { command: "emit rows" },
      result: { content: rows, isError: false, metadata: { exitCode: 0, durationMs: 800 } },
    },
    expanded: false,
  }, {
    id: "tool:edit-footer",
    kind: "tool",
    callId: "edit-footer",
    title: "edit",
    status: "completed",
    text: "",
    inputPreview: rows,
    expanded: false,
  }, {
    id: "tool:write-footer",
    kind: "tool",
    callId: "write-footer",
    title: "write",
    status: "completed",
    text: "",
    toolData: { input: { path: "large.txt", content: rows } },
    expanded: false,
  }, {
    id: "tool:failed-edit-footer",
    kind: "tool",
    callId: "failed-edit-footer",
    title: "edit",
    status: "failed",
    text: Array.from({ length: 30 }, (_, index) => `failure-${index + 1}`).join("\n"),
    inputPreview: rows,
    expanded: false,
  }, {
    id: "tool:failed-write-footer",
    kind: "tool",
    callId: "failed-write-footer",
    title: "write",
    status: "failed",
    text: Array.from({ length: 30 }, (_, index) => `failure-${index + 1}`).join("\n"),
    toolData: { input: { path: "large.txt", content: rows } },
    expanded: false,
  }, ...(["grep", "find", "ls"] as const).map((title): TranscriptEntry => ({
    id: `tool:${title}-footer`,
    kind: "tool",
    callId: `${title}-footer`,
    title,
    status: "completed",
    text: rows,
    expanded: false,
  }))];

  for (const entry of cases) {
    const width = 40;
    const lines = snapshot(renderTranscript([entry], width, theme))
      .split("\n")
      .filter((line) => line.trim() !== "");
    const hints = lines.filter((line) => line.includes("Ctrl+O"));
    assert.equal(hints.length, 1, `${entry.id}:\n${lines.join("\n")}`);
    assert.equal(lines.at(-1), hints[0], `${entry.id}:\n${lines.join("\n")}`);
    assert.equal(lines.every((line) => cellWidth(line) <= width), true, entry.id);
  }
});

test("collapsed search and listing tools use their stable head limits", () => {
  const theme = createTheme("mono", { color: false, unicode: false });
  const cases = [
    { title: "grep", limit: 15 },
    { title: "find", limit: 20 },
    { title: "ls", limit: 20 },
  ] as const;

  for (const selected of cases) {
    const rows = Array.from({ length: selected.limit + 1 }, (_, index) => `${selected.title}-row-${index + 1}`).join("\n");
    const entry = {
      id: `tool:${selected.title}`,
      kind: "tool" as const,
      callId: selected.title,
      title: selected.title,
      status: "completed" as const,
      text: rows,
      expanded: false,
    };
    const collapsed = snapshot(renderTranscript([entry], 80, theme));
    assert.match(collapsed, /output shortened · Ctrl\+O/u, selected.title);
    assert.doesNotMatch(collapsed, new RegExp(`${selected.title}-row-${selected.limit + 1}\\b`, "u"), selected.title);

    const expanded = snapshot(renderTranscript([{ ...entry, expanded: true }], 80, theme));
    assert.match(expanded, new RegExp(`${selected.title}-row-${selected.limit + 1}\\b`, "u"), selected.title);
    assert.doesNotMatch(expanded, /more rows/u, selected.title);
  }
});

test("live write previews prioritize newest input while completed cards expand retained context", () => {
  const rows = Array.from({ length: 200 }, (_, index) => `+ write-row-${index + 1}`).join("\n");
  const entry = {
    id: "tool:live-write",
    kind: "tool" as const,
    callId: "live-write",
    title: "write",
    status: "running" as const,
    text: "",
    inputPreview: rows,
    expanded: false,
  };
  const theme = createTheme("mono", { color: false, unicode: false });

  const live = snapshot(renderTranscript([entry], 80, theme));
  assert.match(live, /^\. write \.\.\. · running$/mu);
  assert.doesNotMatch(live, /write-row-1\b/u);
  assert.match(live, /^\| … earlier live input hidden; newest input follows · Ctrl\+O$/mu);
  assert.match(live, /^\| \+ write-row-200$/mu);
  assert.doesNotMatch(live, /write-row-100/u);
  assert.ok(live.split("\n").length <= 13, live);
  assert.ok(live.split("\n").every((line) => cellWidth(line) <= 80));
  assert.doesNotMatch(live, /"(?:path|content)"\s*:/u);

  const signalTheme = createTheme("signal", { color: true, unicode: true });
  const signalLive = renderTranscript([entry], 80, signalTheme);
  const signalLiveLines = signalLive.split("\n");
  const signalLiveHeader = signalLiveLines.find((line) => stripAnsi(line).includes("write ... · running")) ?? "";
  const signalLiveTail = signalLiveLines.find((line) => stripAnsi(line).includes("+ write-row-200")) ?? "";
  assert.ok(signalLiveHeader.includes(signalTheme.getBgAnsi("toolPendingBg")));
  assert.equal(cellWidth(stripAnsi(signalLiveHeader)), 80);
  assert.ok(signalLiveTail.includes(signalTheme.getBgAnsi("toolPendingBg")));
  assert.ok(signalLiveTail.includes(signalTheme.codes.toolRunning));
  assert.equal(cellWidth(stripAnsi(signalLiveTail)), 80);

  const expandedLive = snapshot(renderTranscript([{ ...entry, expanded: true }], 80, theme));
  assert.match(expandedLive, /^\| \+ write-row-1$/mu);
  assert.doesNotMatch(expandedLive, /write-row-100\b/u);
  assert.match(expandedLive, /^\| \+ write-row-200$/mu);
  assert.match(expandedLive, /earlier live input hidden; newest input follows/u);
  assert.doesNotMatch(expandedLive, /Ctrl\+O/u);
  assert.ok(expandedLive.split("\n").every((line) => cellWidth(line) <= 80));

  const collapsed = snapshot(renderTranscript([{ ...entry, status: "completed", expanded: false }], 80, theme));
  assert.match(collapsed, /^\+ write \.\.\. · done$/mu);
  assert.match(collapsed, /^\| \+ write-row-1$/mu);
  assert.match(collapsed, /^\| \+ write-row-3$/mu);
  assert.doesNotMatch(collapsed, /write-row-4\b|write-row-200\b/u);
  assert.match(collapsed, /source shortened · Ctrl\+O/u);

  const signalCompleted = renderTranscript([{ ...entry, status: "completed", expanded: false }], 80, signalTheme);
  const signalCompletedLines = signalCompleted.split("\n");
  const signalCompletedHeader = signalCompletedLines.find((line) => stripAnsi(line).includes("write ... · done")) ?? "";
  assert.ok(signalCompletedHeader.includes(signalTheme.getBgAnsi("toolPendingBg")));
  assert.ok(!signalCompletedHeader.includes(signalTheme.getBgAnsi("toolSuccessBg")));
  assert.equal(cellWidth(stripAnsi(signalCompletedHeader)), 80);
  assert.match(stripAnsi(signalCompleted), /\+ write-row-1/u);
  assert.match(stripAnsi(signalCompleted), /source shortened · Ctrl\+O/u);

  const expanded = snapshot(renderTranscript([{ ...entry, status: "completed", expanded: true }], 80, theme));
  assert.match(expanded, /^\| \+ write-row-1$/mu);
  assert.match(expanded, /^\| \+ write-row-200$/mu);
  assert.match(expanded, /retained input rows shortened; ending follows/u);
  assert.doesNotMatch(expanded, /write-row-100\b|Ctrl\+O/u);
  assert.ok(expanded.split("\n").length <= 125, expanded);
  assert.ok(expanded.split("\n").every((line) => cellWidth(line) <= 80));

  const canonical = {
    ...entry,
    status: "completed" as const,
    inputPreview: "",
    toolData: {
      input: {
        path: "large.txt",
        content: [
          "HEAD_ONE",
          ...Array.from({ length: 200 }, (_, index) => `middle-${index + 1}`),
          "TAIL_TWO",
        ].join("\n"),
      },
    },
  };
  for (const width of [12, 24, 40, 80, 120]) {
    const narrow = snapshot(renderTranscript([canonical], width, theme));
    assert.match(narrow, /HEAD_ONE/u, `collapsed head at width ${width}`);
    assert.doesNotMatch(narrow, /TAIL_TWO/u, `collapsed tail at width ${width}`);
    assert.match(narrow, /Ctrl\+O/u, `collapsed affordance at width ${width}`);
    assert.ok(narrow.split("\n").every((line) => cellWidth(line) <= width));
    const narrowExpanded = snapshot(renderTranscript([{ ...canonical, expanded: true }], width, theme));
    assert.match(narrowExpanded, /^\| (?:\+ )?TAIL_TWO$/mu, `expanded newest tail at width ${width}`);
    assert.ok(narrowExpanded.split("\n").every((line) => cellWidth(line) <= width));
  }
});

test("parsed write content remains byte and row bounded through live and completed states", () => {
  const content = ["write-row-1", "a".repeat(4 * 1024 * 1024), "write-row-500"].join("\n");
  const entry = {
    id: "tool:parsed-live-write",
    kind: "tool" as const,
    callId: "parsed-live-write",
    title: "write",
    status: "running" as const,
    text: "",
    toolData: { input: { path: "large.ts", content } },
    expanded: true,
  };
  const theme = createTheme("mono", { color: false, unicode: false });

  const live = snapshot(renderTranscript([entry], 80, theme));
  assert.match(live, /^\. write large\.ts · running$/mu);
  assert.match(live, /^\| write-row-1$/mu);
  assert.match(live, /^\| … earlier live input hidden; newest input follows$/mu);
  assert.match(live, /^\| write-row-500$/mu);
  assert.ok(live.split("\n").length <= 125, live);
  assert.ok(live.split("\n").every((line) => cellWidth(line) <= 80));
  assert.doesNotMatch(live, /"(?:path|content)"\s*:/u);

  const completed = snapshot(renderTranscript([{
    ...entry,
    status: "completed" as const,
    expanded: false,
  }], 80, theme));
  assert.match(completed, /^\+ write large\.ts · done$/mu);
  assert.match(completed, /^\| write-row-1$/mu);
  assert.match(completed, /^\| … source shortened · Ctrl\+O$/mu);
  assert.doesNotMatch(completed, /write-row-500/u);
  assert.ok(completed.split("\n").length <= 7, completed);
  assert.ok(completed.split("\n").every((line) => cellWidth(line) <= 80));
  assert.doesNotMatch(completed, /"(?:path|content)"\s*:/u);

  const expanded = snapshot(renderTranscript([{
    ...entry,
    status: "completed" as const,
    expanded: true,
  }], 80, theme));
  assert.match(expanded, /^\+ write large\.ts · done$/mu);
  assert.match(expanded, /^\| … retained input rows shortened; ending follows$/mu);
  assert.match(expanded, /^\| write-row-500$/mu);
  assert.ok(expanded.split("\n").length <= 125, `${expanded.split("\n").length} rows`);
  assert.ok(expanded.split("\n").every((line) => cellWidth(line) <= 80));
  assert.doesNotMatch(expanded, /"(?:path|content)"\s*:/u);
});

test("live edit hides collapsed bodies and expands only its retained preview", () => {
  const theme = createTheme("mono", { color: false, unicode: false });
  const edit: TranscriptEntry = {
    id: "tool:live-edit",
    kind: "tool",
    callId: "live-edit",
    title: "edit",
    status: "running",
    summary: "src/live-edit.ts · receiving 32,768 argument bytes",
    text: "",
    inputPreview: Array.from({ length: 20 }, (_, index) => `edit-row-${index + 1}`).join("\n"),
    expanded: false,
  };
  const collapsedEdit = snapshot(renderTranscript([edit], 80, theme));
  assert.match(collapsedEdit, /^\. edit src\/live-edit\.ts · receiving 32,768 argument bytes · running$/mu);
  assert.doesNotMatch(collapsedEdit, /edit-row-/u);
  const expandedEdit = snapshot(renderTranscript([{ ...edit, expanded: true }], 80, theme));
  assert.match(expandedEdit, /^\. edit src\/live-edit\.ts · receiving 32,768 argument bytes · running$/mu);
  assert.match(expandedEdit, /edit-row-1/u);
  assert.match(expandedEdit, /edit-row-20/u);
  assert.ok(expandedEdit.split("\n").every((line) => cellWidth(line) <= 80));

  const extension: TranscriptEntry = {
    id: "tool:live-extension",
    kind: "tool",
    callId: "live-extension",
    title: "fixture_extension",
    status: "running",
    text: "",
    toolData: {
      input: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field_${index + 1}`, `value_${index + 1}`])),
    },
    expanded: false,
  };
  const collapsedExtension = snapshot(renderTranscript([extension], 80, theme));
  assert.match(collapsedExtension, /earlier input hidden; newest lines follow · Ctrl\+O/u);
  assert.doesNotMatch(collapsedExtension, /"field_1": "value_1"/u);
  assert.match(collapsedExtension, /"field_20": "value_20"/u);
  assert.ok(collapsedExtension.split("\n").length <= 7, collapsedExtension);
  const expandedExtension = snapshot(renderTranscript([{ ...extension, expanded: true }], 80, theme));
  assert.match(expandedExtension, /"field_10": "value_10"/u);
  assert.doesNotMatch(expandedExtension, /earlier input hidden/u);
  assert.ok(expandedExtension.split("\n").every((line) => cellWidth(line) <= 80));
});

test("newline-dense retained mutation previews cap before syntax and wrapping", () => {
  const preview = `--- preview-head\n${"+\n".repeat(32_768)}+++ preview-tail`;
  const content = `content-head 你🙂\n${"\n".repeat(65_535)}content-tail`;
  const entries: TranscriptEntry[] = [{
    id: "newline-dense-edit",
    kind: "tool",
    title: "edit",
    summary: "src/dense.ts",
    status: "completed",
    text: "",
    inputPreview: preview,
    expanded: true,
  }, {
    id: "newline-dense-write",
    kind: "tool",
    title: "write",
    summary: "src/dense.ts",
    status: "completed",
    text: "",
    toolData: { input: { path: "src/dense.ts", content } },
    expanded: true,
  }];

  for (const width of [1, 80]) {
    for (const entry of entries) {
      const rendered = stripAnsi(renderTranscript(
        [entry],
        width,
        createTheme("mono", { color: false, unicode: false }),
        { expandKeyHint: "Ctrl+O" },
      ));
      const lines = rendered.split("\n");

      assert.ok(lines.length <= MAX_RETAINED_MUTATION_PREVIEW_ROWS + 32, `${width}/${entry.title}: ${lines.length}`);
      assert.ok(lines.every((line) => cellWidth(line) <= width));
      if (width > 1) {
        assert.match(rendered, /(?:preview|content)-head/u);
        assert.match(rendered, /(?:preview|content)-tail/u);
      }
      assert.match(rendered, width === 1 ? /[.…]/u : /retained input rows shortened; ending follows/u);
      assert.doesNotMatch(rendered, /"(?:path|content|oldText|newText)"\s*:/u);
    }
  }
});

test("long collapsed write and edit outcomes preserve the tool header and decisive tail", () => {
  const writeContent = Array.from(
    { length: 30 },
    (_, index) => `export const writeSource${index + 1} = "你🙂-${index + 1}";`,
  ).join("\n");
  const editDiff = [
    "--- src/fixture.ts",
    "+++ src/fixture.ts",
    "@@ retained diff @@",
    ...Array.from({ length: 30 }, (_, index) => `+ added edit line ${index + 1} 你🙂`),
  ].join("\n");
  const failure = Array.from(
    { length: 20 },
    (_, index) => `failure detail ${index + 1} 你🙂`,
  ).join("\n");
  const cases: Array<{
    entry: TranscriptEntry;
    state: "done" | "failed";
    head: string;
    tail?: string;
    hidden: string;
  }> = [{
    entry: {
      id: "long-completed-write",
      kind: "tool",
      title: "write",
      summary: "src/fixture.ts · 30 lines",
      status: "completed",
      text: "",
      toolData: { input: { path: "src/fixture.ts", content: writeContent } },
      expanded: false,
    },
    state: "done",
    head: "writeSource1",
    hidden: "writeSource20",
  }, {
    entry: {
      id: "long-failed-write",
      kind: "tool",
      title: "write",
      summary: "src/fixture.ts · 30 lines",
      status: "failed",
      text: failure,
      toolData: { input: { path: "src/fixture.ts", content: writeContent } },
      expanded: false,
    },
    state: "failed",
    head: "writeSource1",
    tail: "failure detail 20",
    hidden: "failure detail 10",
  }, {
    entry: {
      id: "long-completed-edit",
      kind: "tool",
      title: "edit",
      summary: "src/fixture.ts · 30 edits",
      status: "completed",
      text: "",
      inputPreview: editDiff,
      expanded: false,
    },
    state: "done",
    head: "--- src/fixture.ts",
    tail: "added edit line 30",
    hidden: "added edit line 15",
  }, {
    entry: {
      id: "long-failed-edit",
      kind: "tool",
      title: "edit",
      summary: "src/fixture.ts · 30 edits",
      status: "failed",
      text: failure,
      inputPreview: editDiff,
      expanded: false,
    },
    state: "failed",
    head: "--- src/fixture.ts",
    tail: "failure detail 20",
    hidden: "failure detail 10",
  }];
  const surfaces = [{
    columns: 40,
    rows: 20,
    theme: createTheme("signal", { color: true, unicode: true }),
  }, {
    columns: 80,
    rows: 24,
    theme: createTheme("mono", { color: false, unicode: false }),
  }] as const;

  for (const selected of cases) {
    for (const surface of surfaces) {
      const frame = renderFrame({
        context: { status: "idle", model: "fixture" },
        transcript: [selected.entry],
        transcriptOffset: 0,
        editorText: "",
        editorCursor: 0,
        inputLabel: "you",
        inputMode: "normal",
      }, { columns: surface.columns, rows: surface.rows }, surface.theme, { expandKeyHint: "Ctrl+O" });
      const rendered = stripAnsi(frame.text);
      const lines = rendered.split("\n");
      const header = lines.findIndex((line) => line.includes(selected.entry.title ?? "tool"));

      assert.notEqual(header, -1, `${surface.columns}: ${selected.entry.id}`);
      assert.match(lines.slice(header, header + 2).join("\n"), new RegExp(`\\b${selected.state}\\b`, "u"));
      const compactCompletedWrite = selected.entry.title === "write" && selected.entry.status === "completed";
      if (compactCompletedWrite) {
        assert.match(rendered, /source shortened · Ctrl\+O/u);
        assert.match(rendered, /writeSource1/u);
        assert.doesNotMatch(rendered, /writeSource20/u);
      } else {
        assert.match(rendered, /Ctrl\+O/u);
        assert.ok(rendered.includes(selected.head));
        if (selected.tail !== undefined) assert.ok(rendered.includes(selected.tail));
      }
      assert.doesNotMatch(rendered, /"(?:path|content|oldText|newText)"\s*:/u);
      assert.ok(lines.every((line) => cellWidth(line) <= surface.columns));
    }

    const expanded = stripAnsi(renderTranscript(
      [{ ...selected.entry, expanded: true }],
      80,
      createTheme("mono", { color: false, unicode: false }),
      { expandKeyHint: "Ctrl+O" },
    ));
    assert.ok(expanded.includes(selected.hidden));
    assert.doesNotMatch(expanded, /hidden lines/u);
  }
});

test("generic extension tools keep collapsed and expanded retained detail bounded", () => {
  const rows = Array.from({ length: 18 }, (_, index) => `extension-row-${index + 1}`).join("\n");
  const entry = {
    id: "tool:extension",
    kind: "tool" as const,
    callId: "extension",
    title: "custom-extension-tool",
    status: "completed" as const,
    text: rows,
    expanded: false,
  };
  const theme = createTheme("mono", { color: false, unicode: false });

  const collapsed = snapshot(renderTranscript([entry], 80, theme));
  assert.match(collapsed, /extension-row-10/u);
  assert.match(collapsed, /output shortened · Ctrl\+O/u);
  assert.doesNotMatch(collapsed, /extension-row-11/u);

  const expanded = snapshot(renderTranscript([{ ...entry, expanded: true }], 80, theme));
  assert.match(expanded, /extension-row-18/u);
  assert.doesNotMatch(expanded, /more rows/u);
});

test("persisted user shell history follows the global collapsed tool state", () => {
  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  model.apply(envelope({
    type: "message_appended",
    message: {
      id: "user-shell-render",
      role: "user",
      content: [{
        type: "text",
        text: "[User shell command]\n$ npm test\none\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nexit 0",
      }],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }, 1));
  const theme = createTheme("mono", { color: false, unicode: false });
  const collapsed = snapshot(renderTranscript(model.entries, 80, theme));
  assert.match(collapsed, /^\+ \$ npm test · done$/mu);
  assert.match(collapsed, /^\| four\n\| five\n\| six\n\| seven\n\| eight\n\| \.\.\. \(3 earlier lines, Ctrl\+O to expand\)$/mu);
  assert.doesNotMatch(collapsed, /^\| one$/mu);
  assert.equal(collapsed.match(/^\+ \$ npm test/gmu)?.length, 1);

  assert.equal(model.toggleTool("user-shell:user-shell-render"), true);
  const expanded = snapshot(renderTranscript(model.entries, 80, theme));
  assert.match(expanded, /^\| one\n\| two\n\| three\n\| four\n\| five\n\| six\n\| seven\n\| eight$/mu);
  assert.doesNotMatch(expanded, /\[User shell command\]|user-shell-render|earlier rows/u);
});

test("write and edit cards keep source previews, diff structure, and errors visible", () => {
  const theme = createTheme("mono", { color: false, unicode: false });
  const rendered = snapshot(renderTranscript([{
    id: "tool:edit",
    kind: "tool",
    callId: "edit",
    title: "edit",
    summary: "src/a.ts",
    status: "failed",
    inputPreview: "--- old\n- first\n- second\n+++ new\n+ replacement",
    text: "oldText was not found",
    expanded: false,
  }], 60, theme));
  assert.equal(rendered, [
    "",
    "x edit src/a.ts · failed",
    "|",
    "| --- old",
    "| - first",
    "| - second",
    "| +++ new",
    "| + replacement",
    "| oldText was not found",
  ].join("\n"));

  const write = snapshot(renderTranscript([{
    id: "tool:write",
    kind: "tool",
    callId: "write",
    title: "write",
    summary: "src/new.ts",
    status: "completed",
    inputPreview: "+ one\n+ two",
    text: "",
    expanded: false,
  }], 60, theme));
  assert.equal(write, [
    "",
    "+ write src/new.ts · done",
    "|",
    "| + one",
    "| + two",
  ].join("\n"));
  assert.doesNotMatch(`${rendered}\n${write}`, /"(?:path|content|oldText|newText)"\s*:/u);
  assert.doesNotMatch(write, /sha256/u);
  assert.ok(`${rendered}\n${write}`.split("\n").every((line) => cellWidth(line) <= 60));

  const coloredTheme = createTheme("mono", { color: true, unicode: true });
  const colored = renderTranscript([{
    id: "tool:patch",
    kind: "tool",
    title: "apply_patch",
    status: "completed",
    inputPreview: "*** Update File: src/a.ts\n-old\n+new",
    text: "",
    expanded: true,
  }], 60, coloredTheme);
  assert.ok(colored.includes(coloredTheme.codes.accent));
  assert.ok(colored.includes(coloredTheme.codes.error));
  assert.ok(colored.includes(coloredTheme.codes.success));
});

test("completed edit cards keep aggregate metrics and bound the stored diff until expanded", () => {
  const diff = [
    "--- src/a.ts",
    "+++ src/a.ts",
    "@@ parser @@",
    ...Array.from({ length: 12 }, (_, index) => `+ added line ${index + 1}`),
  ].join("\n");
  const entry: TranscriptEntry = {
    id: "tool:complete-edit",
    kind: "tool",
    title: "edit",
    summary: "src/a.ts · 12 edits · 12 to 12 lines · 120 to 144 bytes",
    status: "completed",
    inputPreview: diff,
    text: "",
    toolData: { result: { content: "edited", isError: false, metadata: { replacements: 12 } } },
    expanded: false,
  };
  const theme = createTheme("mono", { color: false, unicode: true });
  const rendered = snapshot(renderTranscript([entry], 64, theme));

  assert.match(rendered, /^✓ edit src\/a\.ts · 12 edits · 12 to 12 lines · 120 to 144 bytes\n│ done$/mu);
  assert.match(rendered, /^│ --- src\/a\.ts$/mu);
  assert.match(rendered, /^│ \+ added line 1$/mu);
  assert.match(rendered, /^│ \+ added line 12$/mu);
  assert.match(rendered, /input shortened · Ctrl\+O/u);
  assert.doesNotMatch(rendered, /^│ \+ added line 6$/mu);
  assert.doesNotMatch(rendered, /12 replacements|◆◇/u);
  assert.doesNotMatch(rendered, /"(?:path|content|oldText|newText)"\s*:/u);
  assert.ok(rendered.split("\n").every((line) => cellWidth(line) <= 64));

  const expanded = snapshot(renderTranscript([{ ...entry, expanded: true }], 64, theme));
  assert.match(expanded, /^│ \+ added line 6$/mu);
  assert.doesNotMatch(expanded, /hidden lines|Ctrl\+O expand/u);
});

test("tool renderer slots preserve safe span roles and fall back per invalid slot", () => {
  const entry = {
    id: "tool:custom",
    kind: "tool" as const,
    callId: "custom",
    title: "read",
    summary: "fallback.txt",
    status: "completed" as const,
    text: "built-in result",
    expanded: false,
  };
  const theme = createTheme("signal", { color: true, unicode: true });
  const rendered = renderTranscript([entry], 50, theme, {
    toolRenderBlocks: new Map([["custom", {
      call: { lines: [{ spans: [{ text: "\u001b]2;owned\u0007CUSTOM ", role: "accent" }, { text: "read", role: "warning" }] }] },
      result: { lines: [{ spans: [{ text: "CUSTOM RESULT", role: "success" }] }] },
    }]]),
  });
  assert.match(snapshot(stripAnsi(rendered)), /✓ CUSTOM read\n│ CUSTOM RESULT/u);
  assert.doesNotMatch(stripAnsi(rendered), /^(?:─+|-+)$/mu);
  assert.doesNotMatch(rendered, /\u001b\]2;owned/u);
  assert.ok(rendered.includes(theme.codes.accent));
  assert.ok(rendered.includes(theme.codes.warning));
  assert.ok(rendered.includes(theme.codes.success));
  const renderedLines = rendered.split("\n");
  assert.equal(stripAnsi(renderedLines[0] ?? ""), "", "the outer transcript spacer stays outside the card band");
  assert.ok(renderedLines[1]?.includes(theme.getBgAnsi("toolPendingBg")));
  assert.equal(cellWidth(stripAnsi(renderedLines[1] ?? "")), 50);
  assert.ok(renderedLines[2]?.includes(theme.getBgAnsi("toolPendingBg")));
  assert.ok(renderedLines[2]?.includes(theme.codes.success));
  assert.ok(renderedLines.slice(1).every((line) => cellWidth(stripAnsi(line)) <= 50));

  const fallback = snapshot(renderTranscript([{ ...entry, expanded: true }], 50, createTheme("mono", { color: false, unicode: false }), {
    toolRenderBlocks: new Map([["custom", {
      call: { lines: [], raw: "not allowed" } as never,
    }]]),
  }));
  assert.match(fallback, /^\+ read fallback\.txt · done\n\|\n\| built-in result$/mu);
});

test("tool renderer slots inherit each missing built-in slot independently", () => {
  const entry = {
    id: "tool:inherited",
    kind: "tool" as const,
    callId: "inherited",
    title: "read",
    summary: "notes.txt",
    status: "completed" as const,
    text: "native result",
    expanded: true,
  };
  const theme = createTheme("mono", { color: false, unicode: false });

  const callOnly = snapshot(renderTranscript([entry], 48, theme, {
    toolRenderBlocks: new Map([["inherited", {
      call: { lines: [{ spans: [{ text: "CUSTOM CALL" }] }] },
    }]]),
  }));
  assert.match(callOnly, /^\+ CUSTOM CALL\n\|\n\| native result$/mu);

  const resultOnly = snapshot(renderTranscript([entry], 48, theme, {
    toolRenderBlocks: new Map([["inherited", {
      result: { lines: [{ spans: [{ text: "CUSTOM RESULT" }] }] },
    }]]),
  }));
  assert.match(resultOnly, /^\+ read notes\.txt · done\n\| CUSTOM RESULT$/mu);
});

test("follow-tail keeps live host-framed tool identity above retained progress", () => {
  const progress = Array.from({ length: 16 }, (_, index) => `progress row ${index + 1}`).join("\n");
  const cases = [{
    label: "built-in",
    entry: {
      id: "tool:live-write-viewport",
      kind: "tool" as const,
      callId: "live-write-viewport",
      title: "write",
      summary: "src/tui/layout.ts · 16 lines",
      status: "running" as const,
      text: "",
      expanded: true,
      inputPreview: progress,
    },
    header: /write src\/tui\/layout\.ts · 16 lines/u,
    toolRenderBlocks: undefined,
  }, {
    label: "extension",
    entry: {
      id: "tool:live-extension-viewport",
      kind: "tool" as const,
      callId: "live-extension-viewport",
      title: "fixture_extension",
      status: "running" as const,
      text: progress,
      expanded: true,
    },
    header: /EXTENSION CALL/u,
    toolRenderBlocks: new Map([["live-extension-viewport", {
      call: { lines: [{ spans: [{ text: "EXTENSION CALL" }] }] },
    }]]),
  }] as const;
  const surfaces = [{
    columns: 40,
    theme: createTheme("signal", { color: true, unicode: true }),
  }, {
    columns: 72,
    theme: createTheme("mono", { color: false, unicode: false }),
  }] as const;

  for (const selected of cases) {
    for (const surface of surfaces) {
      const frame = renderFrame({
        context: {
          status: "executing",
          active: true,
          model: "fixture",
          activity: {
            phase: `Running ${selected.entry.title}`,
            startedAt: Date.now() - 2_000,
            cancellable: true,
          },
        },
        transcript: [selected.entry],
        transcriptOffset: 0,
        editorText: "",
        editorCursor: 0,
        inputLabel: "you",
        inputMode: "normal",
        queuedMessages: [{ mode: "follow_up", text: "verify the final frame" }],
      }, { columns: surface.columns, rows: 16 }, surface.theme, {
        expandKeyHint: "Ctrl+O",
        ...(selected.toolRenderBlocks === undefined ? {} : { toolRenderBlocks: selected.toolRenderBlocks }),
      });
      const rendered = snapshot(stripAnsi(frame.text));

      assert.match(rendered, selected.header, `${selected.label}/${surface.columns}`);
      assert.match(rendered, /progress row 16/u, `${selected.label}/${surface.columns}`);
      assert.match(rendered, /Follow-up: verify the final frame/u, `${selected.label}/${surface.columns}`);
      assert.match(rendered, new RegExp(`Running ${selected.entry.title}`, "u"), `${selected.label}/${surface.columns}`);
      assert.ok(rendered.split("\n").every((line) => cellWidth(line) <= surface.columns));
    }
  }
});

test("collapsed shell rows are recomputed from terminal width", () => {
  const entry = {
    id: "tool:responsive-shell",
    kind: "tool" as const,
    callId: "responsive-shell",
    title: "bash",
    summary: "printf output",
    status: "completed" as const,
    text: "a very long output line that wraps differently and keeps wrapping across several narrow rows\nsecond line\nthird line",
    expanded: false,
  };
  const theme = createTheme("mono", { color: false, unicode: false });
  const wide = snapshot(renderTranscript([entry], 80, theme));
  const narrow = snapshot(renderTranscript([entry], 24, theme));

  assert.doesNotMatch(wide, /earlier rows/u);
  assert.match(narrow, /^\| … · Ctrl\+O$/mu);
  assert.match(narrow, /^\| third line$/mu);
  assert.notEqual(wide, narrow);
  assert.ok(narrow.split("\n").every((line) => cellWidth(line) <= 24));
});

test("empty self-rendered tool rows consume no transcript space", () => {
  const rendered = renderTranscript([{
    id: "tool:empty-self",
    kind: "tool",
    callId: "empty-self",
    title: "quiet",
    status: "completed",
    text: "fallback must stay hidden",
    expanded: true,
  }], 48, createTheme("mono", { color: false, unicode: false }), {
    toolRenderBlocks: new Map([["empty-self", {
      shell: "self",
      call: { lines: [] },
      result: { lines: [] },
    }]]),
  });
  assert.equal(rendered, "");
});

test("direct tool renderer shells either keep host framing or own the complete row", () => {
  const entry = {
    id: "tool:direct-shell",
    kind: "tool" as const,
    callId: "direct-shell",
    title: "custom",
    status: "completed" as const,
    text: "fallback result",
    expanded: true,
  };
  const theme = createTheme("mono", { color: false, unicode: false });
  const call = { lines: [{ spans: [{ text: "DIRECT CALL" }] }] };
  const result = { lines: [{ spans: [{ text: "DIRECT RESULT" }] }] };
  const self = snapshot(renderTranscript([entry], 44, theme, {
    toolRenderBlocks: new Map([["direct-shell", { shell: "self" as const, call, result }]]),
  }));
  assert.match(self, /DIRECT CALL\nDIRECT RESULT/u);
  assert.doesNotMatch(self, /-{20,}/u);
  assert.doesNotMatch(self, /\| DIRECT RESULT/u);

  const coloredTheme = createTheme("signal", { color: true, unicode: true });
  const coloredSelf = renderTranscript([entry], 44, coloredTheme, {
    toolRenderBlocks: new Map([["direct-shell", { shell: "self" as const, call, result }]]),
  });
  const coloredDefault = renderTranscript([entry], 44, coloredTheme, {
    toolRenderBlocks: new Map([["direct-shell", { shell: "default" as const, call, result }]]),
  });
  assert.ok(!coloredSelf.includes(coloredTheme.getBgAnsi("toolPendingBg")));
  assert.ok(coloredDefault.includes(coloredTheme.getBgAnsi("toolPendingBg")));
  assert.ok(coloredDefault.includes(coloredTheme.codes.success));

  const customEdit = renderTranscript([{ ...entry, title: "edit" }], 44, coloredTheme, {
    toolRenderBlocks: new Map([["direct-shell", { call, result }]]),
  });
  assert.ok(customEdit.includes(coloredTheme.getBgAnsi("toolPendingBg")));
  assert.ok(customEdit.includes(coloredTheme.codes.success));

  const framed = snapshot(renderTranscript([entry], 44, theme, {
    toolRenderBlocks: new Map([["direct-shell", { shell: "default" as const, call, result }]]),
  }));
  assert.equal(framed, "\n+ DIRECT CALL\n| DIRECT RESULT");

  const width = 10;
  const narrow = renderTranscript([entry], width, theme, {
    toolRenderBlocks: new Map([["direct-shell", {
      shell: "default" as const,
      result: { lines: [{ spans: [{ text: "1234567890" }] }] },
    }]]),
  });
  assert.ok(narrow.split("\n").every((line) => cellWidth(line) <= width));
  assert.match(narrow, /^\| 12345678$/mu);

  for (const tinyWidth of [1, 2]) {
    const tiny = renderTranscript([entry], tinyWidth, theme, {
      toolRenderBlocks: new Map([["direct-shell", {
        shell: "default" as const,
        result: { lines: [{ spans: [{ text: "1234567890" }] }] },
      }]]),
    });
    assert.ok(tiny.split("\n").every((line) => cellWidth(line) <= tinyWidth));
    assert.match(tiny, tinyWidth === 1 ? /^1$/mu : /^12$/mu);
  }
});

test("extension session render blocks override bounded data-only fallbacks", () => {
  const entries = [{
    id: "extension-state",
    kind: "status" as const,
    text: "",
    extension: { type: "entry" as const, customType: "owner.extension/counter" },
  }, {
    id: "extension-message",
    kind: "status" as const,
    text: "safe fallback",
    extension: { type: "message" as const, customType: "owner.extension/notice" },
  }];
  const mono = createTheme("mono", { color: false, unicode: false });
  const fallback = snapshot(renderTranscript(entries, 60, mono));
  assert.match(fallback, /owner\.extension\/counter/u);
  assert.match(fallback, /owner\.extension\/notice: safe fallback/u);

  const custom = snapshot(renderTranscript(entries, 60, mono, {
    sessionRenderBlocks: new Map([["extension-state", {
      lines: [{ spans: [{ text: "CUSTOM STATE", role: "accent" }] }],
    }], ["extension-message", {
      lines: [{ spans: [{ text: "\u001b]2;owned\u0007CUSTOM MESSAGE", role: "success" }] }],
    }]]),
  }));
  assert.match(custom, /CUSTOM STATE\n\nCUSTOM MESSAGE/u);
  assert.doesNotMatch(custom, /owner\.extension|\u001b\]2;owned/u);
});

test("assistant Markdown gives headings, fenced code, and diffs distinct terminal roles", () => {
  const theme = createTheme("mono", { color: true, unicode: true });
  const rendered = renderTranscript([{
    id: "assistant",
    kind: "assistant",
    text: "## Result\n```diff\n-old\n+new\n@@ context\n```\nDone",
  }], 80, theme);
  assert.ok(rendered.includes(theme.codes.title));
  assert.ok(rendered.includes(theme.codes.error));
  assert.ok(rendered.includes(theme.codes.success));
  assert.ok(rendered.includes(theme.codes.accent));
});

test("assistant Markdown hides inline formatting delimiters while retaining link targets", () => {
  const source = "Use `npm test`, **strong**, *careful*, [the docs](https://example.test), and <mailto:team@example.test>.";
  const visible = "Use npm test, strong, careful, [the docs](https://example.test), and <mailto:team@example.test>.";
  const mono = renderTranscript([{
    id: "assistant",
    kind: "assistant",
    text: source,
  }], 120, createTheme("mono", { color: false, unicode: false }));
  assert.equal(transcriptContent(mono), visible);

  const theme = createTheme("mono", { color: true, unicode: true });
  const colored = renderTranscript([{
    id: "assistant",
    kind: "assistant",
    text: source,
  }], 120, theme);
  assert.equal(transcriptContent(stripAnsi(colored)), visible);
  assert.ok(colored.includes(theme.codes.accent));
  assert.ok(colored.includes(theme.codes.title));
  assert.ok(colored.includes(theme.codes.muted));
});

test("assistant Markdown composes nested inline formatting without leaking its delimiters", () => {
  const cases = [
    ["***both***", "both"],
    ["**bold *and italic***", "bold and italic"],
    ["*italic **and bold***", "italic and bold"],
    ["**use `x` now**", "use x now"],
    ["**[docs](url)**", "[docs](url)"],
    ["[**strong** and *soft* and `code`](https://example.test)", "[strong and soft and code](https://example.test)"],
  ] as const;
  const theme = createTheme("mono", { color: false, unicode: false });

  for (const [source, visible] of cases) {
    assert.equal(transcriptContent(renderTranscript([{ id: source, kind: "assistant", text: source }], 160, theme)), visible);
  }
});

test("assistant Markdown removes escapes from punctuation without activating the escaped syntax", () => {
  const source = "\\*literal\\* \\_plain\\_ \\[label\\] \\`code\\` \\\\ \\# \\!";
  const visible = "*literal* _plain_ [label] `code` \\ # !";
  const rendered = renderTranscript([{
    id: "assistant",
    kind: "assistant",
    text: source,
  }], 120, createTheme("mono", { color: false, unicode: false }));

  assert.equal(transcriptContent(rendered), visible);
});

test("assistant Markdown preserves identifier, arithmetic, and glob punctuation", () => {
  const source = "Use foo_bar_baz and a_b_c. Compute 2 * 3 * 4. glob *.{ts,js} then *.{mjs,cjs}.";
  const rendered = renderTranscript([{
    id: "assistant",
    kind: "assistant",
    text: source,
  }], 120, createTheme("mono", { color: false, unicode: false }));

  assert.equal(transcriptContent(rendered), source);
});

test("trusted Markdown links emit line-local OSC 8 only when terminal support is known", () => {
  const source = "Read [docs](https://example.test/guide) or <mailto:team@example.test>; keep [unsafe](javascript:alert(1)) literal.";
  const entry = [{ id: "assistant", kind: "assistant" as const, text: source }];
  const theme = createTheme("mono", { color: false, unicode: true });
  const fallback = renderTranscript(entry, 140, theme, { hyperlinks: false });
  assert.equal(transcriptContent(fallback), source);
  assert.doesNotMatch(fallback, /\u001b\]8;/u);
  const linked = renderTranscript(entry, 140, theme, { hyperlinks: true });
  assert.equal(transcriptContent(stripAnsi(linked)), source);
  assert.equal(linked.match(/\u001b\]8;;https:\/\/example\.test\/guide\u001b\\/gu)?.length, 1);
  assert.equal(linked.match(/\u001b\]8;;mailto:team@example\.test\u001b\\/gu)?.length, 1);
  assert.doesNotMatch(linked, /\u001b\]8;;javascript:/u);
  assert.equal(linked.match(/\u001b\]8;;\u001b\\/gu)?.length, 2);
});

test("transcript image payloads stay outside styled text while captions reserve placement rows", () => {
  const data = png().toString("base64");
  const entries = [{
    id: "user-image",
    kind: "user" as const,
    text: "inspect this",
    images: [{ key: "user-image:image:0", block: { type: "image" as const, mediaType: "image/png", data } }],
  }];
  const theme = createTheme("mono", { color: false, unicode: true });
  const fallback = renderTranscript(entries, 40, theme);
  assert.match(fallback, /\[Image: image\/png\]/u);
  assert.doesNotMatch(fallback, new RegExp(data.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

  const frame = renderTranscriptFrame(entries, 40, theme, { resolveImage: resolvePng, maxImageRows: 4 });
  assert.equal(frame.images?.length, 1);
  assert.equal(frame.images?.[0]?.rows, 2);
  assert.equal(frame.text.split("\n").length, 6);
  assert.doesNotMatch(frame.text, new RegExp(data.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

  const coloredTheme = createTheme("signal", { color: true, unicode: true });
  const imageOnly = renderTranscriptFrame([{
    id: "image-only-user",
    kind: "user",
    text: "",
    images: entries[0]!.images,
  }], 40, coloredTheme, { resolveImage: resolvePng, maxImageRows: 4 });
  const imageOnlyLines = imageOnly.text.split("\n");
  assert.equal(imageOnly.images?.length, 1);
  assert.ok(imageOnlyLines.every((line) => line.includes(coloredTheme.getBgAnsi("userMessageBg"))));
  assert.ok(imageOnlyLines.every((line) => cellWidth(stripAnsi(line)) === 40));
});

test("live image placements are suppressed while overlays or transcript paging can obscure reservations", () => {
  const data = png().toString("base64");
  const base: TuiViewState = {
    context: { status: "idle" },
    transcript: [{
      id: "image",
      kind: "assistant",
      text: "preview",
      images: [{ key: "image:0", block: { type: "image", mediaType: "image/png", data } }],
    }],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  };
  const theme = createTheme("mono", { color: false, unicode: true });
  const visible = renderFrame(base, { columns: 40, rows: 12 }, theme, { resolveImage: resolvePng });
  assert.equal(visible.images?.length, 1);
  const paged = renderFrame({ ...base, transcriptOffset: 1 }, { columns: 40, rows: 12 }, theme, { resolveImage: resolvePng });
  assert.equal(paged.images, undefined);
  const overlaid = renderFrame({
    ...base,
    runtimeOverlays: [{
      width: 10,
      focused: false,
      options: { anchor: "center" },
      block: { lines: [{ spans: [{ text: "panel" }] }] },
    }],
  }, { columns: 40, rows: 12 }, theme, { resolveImage: resolvePng });
  assert.equal(overlaid.images, undefined);
  const rawOverlaid = renderFrame({
    ...base,
    rawRuntimeOverlays: [{
      width: 10,
      focused: false,
      options: { anchor: "center" },
      block: { lines: ["raw panel"] },
    }],
  }, { columns: 40, rows: 12 }, theme, { resolveImage: resolvePng });
  assert.equal(rawOverlaid.images, undefined);
  const rawReplacement = renderFrame({
    ...base,
    rawRuntimeComponent: { lines: ["raw replacement"] },
  }, { columns: 40, rows: 12 }, theme, { resolveImage: resolvePng });
  assert.equal(rawReplacement.images, undefined);
});

test("background cells never occupy terminal-image reservations", () => {
  const columns = 40;
  const rows = 12;
  const data = png().toString("base64");
  const frame = renderFrame({
    context: { status: "idle" },
    transcript: [{
      id: "image-background",
      kind: "assistant",
      text: "preview",
      images: [{ key: "image-background:0", block: { type: "image", mediaType: "image/png", data } }],
    }],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
    backgroundCells: Array.from({ length: columns * rows }, (_, index) => ({
      row: Math.floor(index / columns),
      column: index % columns,
      text: "·",
    })),
  }, { columns, rows }, createTheme("mono", { color: false, unicode: true }), { resolveImage: resolvePng });
  const image = frame.images?.[0];
  assert.ok(image !== undefined);
  const lines = frame.text.split("\n").map(stripAnsi);
  for (let row = image.row; row < image.row + image.rows; row += 1) {
    assert.doesNotMatch(lines[row]?.slice(image.column, image.column + image.columns) ?? "", /·/u);
  }
});

test("assistant Markdown presents list markers, table headers, separators, and fence language labels", () => {
  const source = [
    "- [x] complete",
    "+ [ ] pending",
    "1. ordered",
    "| Name | Value |",
    "| :--- | ---: |",
    "| cat | yes |",
    "```ts",
    "const answer = 42;",
    "```",
    "```diff",
    "-old",
    "+new",
    "@@ context",
    "```",
  ].join("\n");
  const mono = renderTranscript([{
    id: "assistant",
    kind: "assistant",
    text: source,
  }], 120, createTheme("mono", { color: false, unicode: false }));
  assert.equal(transcriptContent(mono), source);

  const theme = createTheme("mono", { color: true, unicode: true });
  const colored = renderTranscript([{
    id: "assistant",
    kind: "assistant",
    text: source,
  }], 120, theme);
  const lines = transcriptContent(colored).split("\n");
  assert.equal(transcriptContent(stripAnsi(colored)), source);
  assert.ok(lines[0]?.startsWith(theme.codes.accent));
  assert.ok(lines[0]?.includes(theme.codes.success));
  assert.ok(lines[2]?.startsWith(theme.codes.accent));
  assert.ok(lines[3]?.includes(theme.codes.title));
  assert.ok(lines[4]?.includes(theme.codes.accent));
  assert.ok(lines[6]?.startsWith(theme.codes.muted));
  assert.ok(lines[6]?.includes(theme.codes.accent));
  assert.ok(lines[10]?.startsWith(theme.codes.error));
  assert.ok(lines[11]?.startsWith(theme.codes.success));
});

test("assistant Markdown wrapping is cell-aware and strips injected terminal controls", () => {
  const source = "**前🙂後** and \u001b]2;owned\u0007`界🙂` [文](https://例.test)\u0001 tail";
  const expected = "前🙂後 and 界🙂 [文](https://例.test) tail";
  const rendered = renderTranscript([{
    id: "assistant",
    kind: "assistant",
    text: source,
  }], 20, createTheme("mono", { color: false, unicode: true }));
  assert.equal(rendered.split("\n").join(""), expected);
  assert.ok(rendered.split("\n").every((line) => cellWidth(line) <= 20));
  assert.doesNotMatch(rendered, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u001b]/u);
});

test("assistant prose wraps on word boundaries at narrow widths", () => {
  const rendered = renderTranscript([{
    id: "assistant",
    kind: "assistant",
    text: "I found the unsafe fallback. I’m checking the call sites before changing it.",
  }], 52, createTheme("mono", { color: false, unicode: true }));
  const lines = rendered.split("\n");

  assert.deepEqual(lines.slice(-2), [
    "I found the unsafe fallback. I’m checking the call ",
    "sites before changing it.",
  ]);
  assert.doesNotMatch(rendered, /\bs\nites\b/u);
});

test("malformed Markdown and HTML-like text remain readable literal text", () => {
  const source = "<b>literal</b> **unclosed [bad](target with space)";
  const theme = createTheme("mono", { color: true, unicode: true });
  const rendered = renderTranscript([{
    id: "assistant",
    kind: "assistant",
    text: source,
  }], 100, theme);
  assert.equal(transcriptContent(stripAnsi(rendered)), source);
  assert.doesNotMatch(transcriptContent(rendered), new RegExp([theme.codes.accent, theme.codes.title, theme.codes.muted]
    .map((code) => code.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|"), "u"));
});

test("assistant Markdown keeps nested and loose container source while presenting its structure", () => {
  const source = [
    "> 1. parent",
    ">     continued paragraph",
    ">     - [x] nested complete",
    ">",
    ">     loose continuation",
    "",
    "| Name | Value |",
    "| :--- | ---: |",
    "| escaped \\| pipe | `code|pipe` |",
  ].join("\n");
  const mono = renderTranscript([{
    id: "assistant",
    kind: "assistant",
    text: source,
  }], 120, createTheme("mono", { color: false, unicode: true }));
  const visible = source.replace("\\|", "|").replace("`code|pipe`", "code|pipe");
  assert.equal(transcriptContent(mono), visible);

  const theme = createTheme("mono", { color: true, unicode: true });
  const colored = renderTranscript([{ id: "assistant", kind: "assistant", text: source }], 120, theme);
  const lines = transcriptContent(colored).split("\n");
  assert.equal(transcriptContent(stripAnsi(colored)), visible);
  assert.ok(lines[0]?.includes(theme.codes.accent));
  assert.ok(lines[2]?.includes(theme.codes.success));
  assert.ok(lines[6]?.includes(theme.codes.title));
  assert.ok(lines[7]?.includes(theme.codes.accent));
  assert.equal((stripAnsi(lines[8] ?? "").match(/\|/gu) ?? []).length, 5);
});

test("fenced code highlighting carries lexical state for common coding languages", () => {
  const source = [
    "```ts",
    "const answer: number = 42; // note",
    "const label = \"ready\";",
    "/* open",
    "continued */ let done = true;",
    "```",
    "```python",
    "def greet(name: str):",
    "    text = \"\"\"hello",
    "world\"\"\"",
    "    return text  # note",
    "```",
    "```sh",
    "if [ -n \"$HOME\" ]; then echo \"$HOME\"; fi",
    "```",
    "```json",
    "{\"enabled\": true, \"count\": 3}",
    "```",
  ].join("\n");
  const theme = createTheme("mono", { color: true, unicode: true });
  const rendered = renderTranscript([{ id: "assistant", kind: "assistant", text: source }], 120, theme);
  const lines = transcriptContent(rendered).split("\n");
  assert.equal(transcriptContent(stripAnsi(rendered)), source);
  assert.ok(lines[1]?.includes(theme.codes.accent));
  assert.ok(lines[1]?.includes(theme.codes.warning));
  assert.ok(lines[2]?.includes(theme.codes.success));
  assert.ok(lines[3]?.includes(theme.codes.muted));
  assert.ok(lines[4]?.includes(theme.codes.accent));
  assert.ok(lines[7]?.includes(theme.codes.accent));
  assert.ok(lines[8]?.includes(theme.codes.success));
  assert.ok(lines[13]?.includes(theme.codes.accent));
  assert.ok(lines[13]?.includes(theme.codes.success));
  assert.ok(lines[16]?.includes(theme.codes.warning));
});

test("blockquote and shallow list containers preserve fenced-code prefixes and state", () => {
  const source = [
    "> > ```ts",
    "> > const answer = 42;",
    "> > /* open",
    "> > continued */ const label = \"ok\";",
    "> > ```",
    "- item",
    "  ```python",
    "  def value():",
    "      return 3",
    "  ```",
    "    ```ts",
    "    const fourSpaceFenceIsLiteral = true;",
  ].join("\n");
  const mono = renderTranscript([{ id: "assistant", kind: "assistant", text: source }], 120, createTheme("mono", { color: false, unicode: true }));
  assert.equal(transcriptContent(mono), source);

  const theme = createTheme("mono", { color: true, unicode: true });
  const rendered = renderTranscript([{ id: "assistant", kind: "assistant", text: source }], 120, theme);
  const lines = transcriptContent(rendered).split("\n");
  assert.equal(transcriptContent(stripAnsi(rendered)), source);
  assert.equal((stripAnsi(lines[0] ?? "").match(/>/gu) ?? []).length, 2);
  assert.ok(lines[0]?.includes(theme.codes.accent));
  assert.ok(lines[1]?.includes(theme.codes.accent));
  assert.ok(lines[1]?.includes(theme.codes.warning));
  assert.ok(lines[2]?.includes(theme.codes.muted));
  assert.ok(lines[3]?.includes(theme.codes.success));
  assert.ok(lines[7]?.includes(theme.codes.accent));
  assert.ok(lines[8]?.includes(theme.codes.warning));
  assert.ok(!lines[10]?.includes(theme.codes.accent));
});

test("incomplete fenced Markdown is deterministic and append-stable while streaming", () => {
  const partialSource = [
    "before",
    "````ts",
    "const value = 1;",
    "```",
    "/* still code",
  ].join("\n");
  const completeSource = `${partialSource}\ncontinued */\nconst next = \"ok\";\n\`\`\`\`\nafter`;
  const theme = createTheme("mono", { color: true, unicode: true });
  const partial = renderTranscript([{ id: "assistant", kind: "assistant", text: partialSource }], 80, theme);
  const again = renderTranscript([{ id: "assistant", kind: "assistant", text: partialSource }], 80, theme);
  const complete = renderTranscript([{ id: "assistant", kind: "assistant", text: completeSource }], 80, theme);
  assert.equal(partial, again);
  assert.ok(complete.startsWith(`${partial}\n`));
  assert.equal(transcriptContent(stripAnsi(complete)), completeSource);
  const completeLines = transcriptContent(complete).split("\n");
  assert.ok(completeLines[6]?.includes(theme.codes.accent));
  assert.ok(completeLines[6]?.includes(theme.codes.success));
});

test("Markdown rendering bounds hostile nesting, tables, tokens, dimensions, and controls", () => {
  const nested = `${"> ".repeat(80)}- [x] **界🙂**\u001b]8;;https://owned.test\u0007`;
  const table = `|${Array.from({ length: 200 }, (_, index) => ` cell${index} `).join("|")}|`;
  const tokens = `\`\`\`ts\n${"const x = 1; ".repeat(2_000)}\n\`\`\``;
  const source = [nested, table, tokens].join("\n");
  const theme = createTheme("mono", { color: false, unicode: true });
  const first = renderTranscript([{ id: "assistant", kind: "assistant", text: source }], 1_000_000, theme, { hyperlinks: true });
  const second = renderTranscript([{ id: "assistant", kind: "assistant", text: source }], 1_000_000, theme, { hyperlinks: true });
  assert.equal(first, second);
  assert.doesNotMatch(first, /\u001b|owned\.test/u);
  assert.ok(first.split("\n").every((line) => cellWidth(line) <= 500));
  assert.match(first, /界🙂/u);
});

test("Markdown renderer retains a bounded recent tail for pathological output", () => {
  const manyLines = Array.from({ length: 20_100 }, (_, index) => `line ${index}`).join("\n");
  const renderedLines = renderTranscript([{
    id: "assistant",
    kind: "assistant",
    text: manyLines,
  }], 80, createTheme("mono", { color: false, unicode: true }));
  const lines = renderedLines.split("\n");
  assert.equal(lines[0], "");
  assert.equal(lines.slice(1).length, 20_000);
  assert.match(lines[1] ?? "", /earlier rendered Markdown omitted/u);
  assert.match(renderedLines, /line 20099/u);
  assert.doesNotMatch(renderedLines, /line 0(?:\n|$)/u);

  const huge = `START\n${"x".repeat(2 * 1024 * 1024 + 64)}\nEND`;
  const bounded = renderTranscript([{ id: "assistant", kind: "assistant", text: huge }], 500, createTheme("mono", { color: false, unicode: true }));
  assert.match(bounded, /earlier Markdown bytes omitted/u);
  assert.match(bounded, /END$/u);
  assert.doesNotMatch(bounded, /^START/u);
  assert.ok(bounded.split("\n").every((line) => cellWidth(line) <= 500));
});

test("direct frame dimensions are capped before Markdown allocation", () => {
  const theme = createTheme("mono", { color: false, unicode: true });
  const transcript = renderTranscript([{ id: "assistant", kind: "assistant", text: "x".repeat(1_001) }], 50_000, theme);
  assert.deepEqual(transcript.split("\n").map(cellWidth), [0, 500, 500, 1]);
  const frame = renderFrame({
    context: { status: "idle" },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  }, { columns: 50_000, rows: 50_000 }, theme);
  assert.equal(frame.text.split("\n").length, 200);
  assert.ok(frame.text.split("\n").every((line) => cellWidth(line) === 500));
});

test("transcript cards distinguish speakers and every tool state with compact labels", () => {
  const theme = createTheme("mono", { color: false, unicode: false });
  const rendered = snapshot(renderTranscript([
    { id: "user", kind: "user", text: "Fix the parser\nand keep the API stable" },
    { id: "assistant", kind: "assistant", text: "## Plan\nI will inspect the parser." },
    { id: "pending", kind: "tool", title: "read", summary: "src/parser.ts", status: "pending", text: "" },
    { id: "running", kind: "tool", title: "shell", summary: "npm test", status: "running", text: "waiting" },
    {
      id: "success",
      kind: "tool",
      title: "edit",
      summary: "src/parser.ts",
      status: "completed",
      text: "one\ntwo\nthree\nfour\nfive\nsix",
    },
    { id: "failed", kind: "tool", title: "web_fetch", summary: "https://example.test", status: "failed", text: "network error" },
  ], 48, theme));

  assert.match(rendered, /^ Fix the parser\n and keep the API stable/mu);
  assert.match(rendered, /## Plan\nI will inspect the parser\./u);
  assert.match(rendered, /^> read src\/parser\.ts · queued$/mu);
  assert.match(rendered, /^\. \$ npm test · running\n\|\n\| waiting$/mu);
  assert.match(rendered, /^\+ edit src\/parser\.ts · done\n\|\n\| one[\s\S]*^\| six$/mu);
  assert.match(rendered, /^x web_fetch https:\/\/example\.test · failed\n\|\n\| network error$/mu);
  assert.doesNotMatch(rendered, /[✓◆◇]/u);
  assert.doesNotMatch(rendered, /\b(?:CALL|RESULT|Ctrl\+O)\b/u);
  assert.doesNotMatch(rendered, /\byou>/u);
  assert.doesNotMatch(rendered, /\bagent\b/u);

  const coloredTheme = createTheme("signal", { color: true, unicode: true });
  const coloredLines = renderTranscript([
    { id: "u", kind: "user", text: "message" },
    { id: "p", kind: "tool", title: "read", status: "pending", text: "" },
    { id: "r", kind: "tool", title: "shell", status: "running", text: "" },
    { id: "s", kind: "tool", title: "edit", status: "completed", text: "" },
    { id: "e", kind: "tool", title: "fetch", status: "failed", text: "" },
  ], 20, coloredTheme).split("\n");
  assert.ok(coloredLines.every((line) => cellWidth(line) <= 20));
  assert.ok(coloredLines[0]?.includes(coloredTheme.codes.userMessage));
  assert.ok(coloredLines[0]?.includes(coloredTheme.getBgAnsi("userMessageBg")));
  assert.ok(coloredLines.some((line) => line.includes(coloredTheme.codes.toolPending)));
  assert.ok(coloredLines.some((line) => line.includes(coloredTheme.codes.success)));
  assert.ok(coloredLines.some((line) => line.includes(coloredTheme.codes.error)));
  assert.equal(coloredTheme.codes.assistant, coloredTheme.codes.code);
});

test("the composer separator keeps one accent across every thinking level", () => {
  const theme = createTheme("mono", { color: true, unicode: true });
  const frames = [undefined, "off", "minimal", "low", "medium", "high", "xhigh", "max"].map((thinking) =>
    renderFrame({
      context: { status: "idle", ...(thinking === undefined ? {} : { thinking }) },
      transcript: [],
      transcriptOffset: 0,
      editorText: "",
      editorCursor: 0,
      inputLabel: "you",
      inputMode: "normal",
    }, { columns: 60, rows: 10 }, theme).text);

  assert.equal(new Set(frames).size, 1);
  assert.ok(frames[0]?.includes(theme.codes.editorActive));
});

test("fullscreen transcript scrollbar follows overflow and visibility settings", () => {
  const theme = createTheme("mono", { color: false, unicode: true });
  const view = {
    context: { status: "idle" as const, model: "fixture" },
    transcript: Array.from({ length: 24 }, (_, index) => ({
      id: `message-${index}`,
      kind: "assistant" as const,
      text: `message ${index}`,
    })),
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal" as const,
  };
  const rightEdge = (value: string) => value.split("\n").map((line) => line.at(-1));
  const automaticFrame = renderFrame(view, { columns: 42, rows: 14 }, theme, {
    fullscreenScrollbar: "auto",
  });
  const automatic = snapshot(automaticFrame.text);
  const hidden = snapshot(renderFrame(view, { columns: 42, rows: 14 }, theme, {
    fullscreenScrollbar: "hidden",
  }).text);
  const short = snapshot(renderFrame({ ...view, transcript: view.transcript.slice(0, 1) }, {
    columns: 42,
    rows: 14,
  }, theme, { fullscreenScrollbar: "auto" }).text);

  assert.ok(rightEdge(automatic).includes("█"));
  const pointerRegion = automaticFrame.transcriptNavigation?.pointerRegion;
  assert.equal(pointerRegion?.scrollbar?.column, 41);
  assert.ok((pointerRegion?.scrollbar?.thumbRows ?? 0) > 0);
  assert.ok((pointerRegion?.scrollbar?.thumbTop ?? -1) >= (pointerRegion?.top ?? 0));
  assert.ok(
    (pointerRegion?.scrollbar?.thumbTop ?? Number.MAX_SAFE_INTEGER)
      + (pointerRegion?.scrollbar?.thumbRows ?? 0)
      <= (pointerRegion?.bottom ?? -1) + 1,
  );
  assert.equal(rightEdge(hidden).some((cell) => cell === "█" || cell === "│"), false);
  assert.equal(rightEdge(short).some((cell) => cell === "█" || cell === "│"), false);
});

test("fullscreen transcript scrollbar reflows instead of truncating the final content column", () => {
  const text = "ABCDEFGHIJKLMNOPQRSTUVWXYZAB";
  const rendered = snapshot(renderFrame({
    context: { status: "idle", model: "fixture" },
    transcript: [{ id: "message", kind: "assistant", text }],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  }, { columns: 20, rows: 12 }, createTheme("mono", { color: false, unicode: true }), {
    fullscreenScrollbar: "always",
  }).text);

  assert.doesNotMatch(rendered, /…/u);
  assert.match(rendered.replace(/[\s█│]/gu, ""), new RegExp(text, "u"));
});

test("plain text-presentation symbols keep the fullscreen scrollbar in its final column", () => {
  const columns = 42;
  const frame = renderFrame({
    context: { status: "idle", model: "fixture" },
    transcript: [
      ...Array.from({ length: 24 }, (_, index): TranscriptEntry => ({
        id: `overflow-${index}`,
        kind: "warning",
        text: `overflow row ${index}`,
      })),
      { id: "text-symbol", kind: "assistant", text: "completed ✔ without emoji presentation" },
    ],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  }, { columns, rows: 14 }, createTheme("mono", { color: false, unicode: true }), {
    fullscreenScrollbar: "auto",
  });
  const line = frame.text.split("\n").map(stripAnsi).find((candidate) => candidate.includes("completed ✔"));

  assert.ok(line !== undefined);
  assert.equal(splitGraphemes(line).length, columns);
  assert.match(line.at(-1) ?? "", /^[│█]$/u);
});

test("fullscreen scrollbar owns one aligned gutter without shortening filled or bordered rows", () => {
  const theme = createTheme("signal", { color: true, unicode: true });
  const transcript: TranscriptEntry[] = [
    ...Array.from({ length: 24 }, (_, index): TranscriptEntry => ({
      id: `overflow-${index}`,
      kind: "warning",
      text: `overflow row ${index}`,
    })),
    {
      id: "aligned-reasoning",
      kind: "reasoning",
      text: "Checking right-edge alignment",
      expanded: true,
      reasoningDurationMs: 2_000,
    },
    {
      id: "aligned-tool",
      kind: "tool",
      title: "bash",
      status: "completed",
      text: "aligned output",
      toolData: { input: { command: "true" } },
    },
  ];

  for (const columns of [192, 18]) {
    const frame = renderFrame({
      context: { status: "idle", model: "fixture" },
      transcript,
      transcriptOffset: 0,
      editorText: "",
      editorCursor: 0,
      inputLabel: "you",
      inputMode: "normal",
    }, { columns, rows: 18 }, theme, { fullscreenScrollbar: "auto" });
    const lines = frame.text.split("\n");
    const plainLines = lines.map((line) => stripAnsi(line));
    const reasoningTopIndex = plainLines.findIndex((line) => line.includes("Thought · 2s"));
    const toolIndex = plainLines.findIndex((line) => line.includes("$ true"));

    assert.notEqual(reasoningTopIndex, -1, `reasoning top is visible at ${columns} columns`);
    assert.notEqual(toolIndex, -1, `tool row is visible at ${columns} columns`);
    assert.ok(lines.every((line) => cellWidth(stripAnsi(line)) === columns), `${columns}-column frame is aligned`);
    assert.equal(plainLines[reasoningTopIndex]?.at(-2), "┐");
    assert.match(plainLines[reasoningTopIndex]?.at(-1) ?? "", /^[│█]$/u);
    assert.match(plainLines[toolIndex]?.at(-1) ?? "", /^[│█]$/u);
    const toolLine = lines[toolIndex] ?? "";
    const scrollbarGlyph = plainLines[toolIndex]?.at(-1) ?? "";
    const scrollbarIndex = toolLine.lastIndexOf(scrollbarGlyph);
    assert.ok(
      toolLine.lastIndexOf(theme.getBgAnsi("toolPendingBg"), scrollbarIndex)
        > toolLine.lastIndexOf("\u001b[0m", scrollbarIndex),
      `the ${columns}-column scrollbar gutter retains the filled tool-row background`,
    );
    assert.equal(frame.transcriptNavigation?.pointerRegion?.scrollbar?.column, columns - 1);
  }
});

test("fullscreen transcript navigation marks stable messages and clamps overscroll", () => {
  const theme = createTheme("mono", { color: false, unicode: true });
  const view = {
    context: { status: "idle" as const },
    transcript: [
      { id: "user-a", kind: "user" as const, text: "first user message" },
      { id: "assistant-a", kind: "assistant" as const, text: "first assistant message" },
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `warning-${index}`,
        kind: "warning" as const,
        text: `diagnostic ${index}`,
      })),
      { id: "user-b", kind: "user" as const, text: "last user message" },
      { id: "assistant-b", kind: "assistant" as const, text: "last assistant message" },
    ],
    transcriptOffset: 1_000_000,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal" as const,
  };
  const frame = renderFrame(view, { columns: 50, rows: 12 }, theme);

  assert.equal(frame.transcriptNavigation?.startRow, 0);
  assert.equal(frame.transcriptNavigation?.messageRows.length, 4);
  assert.doesNotMatch(snapshot(frame.text), /↕ older transcript/u);
  assert.match(snapshot(frame.text), /first user message/u);
});

test("scrollback marker pins the user prompt owning the visible transcript section", () => {
  const theme = createTheme("mono", { color: false, unicode: true });
  const view = {
    context: {
      status: "idle" as const,
      extensionHeaders: ["Extension header"],
      extensionFooters: ["Extension footer"],
    },
    transcript: [
      { id: "user-a", kind: "user" as const, text: "First prompt\nwith collapsed whitespace" },
      {
        id: "assistant-a",
        kind: "assistant" as const,
        text: Array.from({ length: 16 }, (_, index) => `first owned answer row ${index}`).join("\n"),
      },
      { id: "user-b", kind: "user" as const, text: `Second prompt 🙂 ${"wide ".repeat(40)}` },
      {
        id: "assistant-b",
        kind: "assistant" as const,
        text: Array.from({ length: 20 }, (_, index) => `second owned answer row ${index}`).join("\n"),
      },
      { id: "user-c", kind: "user" as const, text: "" },
      {
        id: "assistant-c",
        kind: "assistant" as const,
        text: Array.from({ length: 20 }, (_, index) => `unlabeled owned answer row ${index}`).join("\n"),
      },
    ],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal" as const,
  };
  const size = { columns: 64, rows: 12 };
  const tail = renderFrame(view, size, theme);
  const navigation = tail.transcriptNavigation;
  assert.ok(navigation !== undefined);
  assert.equal(navigation.messageRows.length, 5);
  assert.doesNotMatch(stripAnsi(tail.text), /older transcript/u);

  const renderAt = (row: number): string => {
    const transcriptOffset = navigation.totalRows - navigation.viewportRows - row;
    assert.ok(transcriptOffset > 0);
    const frame = renderFrame({ ...view, transcriptOffset }, size, theme);
    assert.equal(frame.transcriptNavigation?.startRow, row);
    return stripAnsi(frame.text);
  };

  const first = renderAt(navigation.messageRows[1]! + 2);
  assert.equal(first.split("\n")[0]?.trim(), "Extension header");
  const firstMarker = first.split("\n").find((line) => line.includes("older transcript")) ?? "";
  assert.match(firstMarker, /↕ older transcript · First prompt with collapsed whitespace/u);
  assert.ok(cellWidth(firstMarker) <= size.columns);
  assert.ok(first.indexOf(firstMarker) < first.indexOf("Extension footer"));

  const second = renderAt(navigation.messageRows[3]! + 2);
  const secondMarker = second.split("\n").find((line) => line.includes("older transcript")) ?? "";
  assert.match(secondMarker, /↕ older transcript · Second prompt 🙂/u);
  assert.ok(cellWidth(secondMarker) <= size.columns);
  assert.equal(second.split("\n").filter((line) => line.includes("older transcript")).length, 1);

  const unlabeled = renderAt(navigation.messageRows[4]! + 2);
  const unlabeledMarker = unlabeled.split("\n").find((line) => line.includes("older transcript")) ?? "";
  assert.match(unlabeledMarker, /↕ older transcript/u);
  assert.doesNotMatch(unlabeledMarker, /Second prompt|First prompt/u);

  let replacement = "[masked prompt]";
  const transformMarkdown: NonNullable<Parameters<typeof renderFrame>[3]>["transformMarkdown"] =
    (markdown, context) => context.messageType === "user" && markdown !== "" ? replacement : markdown;
  const transformedTail = renderFrame(view, size, theme, { transformMarkdown });
  const transformedNavigation = transformedTail.transcriptNavigation;
  assert.ok(transformedNavigation !== undefined);
  const transformedRow = transformedNavigation.messageRows[1]! + 2;
  const transformedOffset = transformedNavigation.totalRows - transformedNavigation.viewportRows - transformedRow;
  assert.ok(transformedOffset > 0);
  const transformed = stripAnsi(renderFrame({ ...view, transcriptOffset: transformedOffset }, size, theme, {
    transformMarkdown,
  }).text);
  const transformedMarker = transformed.split("\n").find((line) => line.includes("older transcript")) ?? "";
  assert.match(transformedMarker, /\[masked prompt\]/u);
  assert.doesNotMatch(transformedMarker, /First prompt|collapsed whitespace/u);

  replacement = "[refreshed mask]";
  const refreshed = stripAnsi(renderFrame({ ...view, transcriptOffset: transformedOffset }, size, theme, {
    transformMarkdown,
  }).text);
  const refreshedMarker = refreshed.split("\n").find((line) => line.includes("older transcript")) ?? "";
  assert.match(refreshedMarker, /\[refreshed mask\]/u);
  assert.doesNotMatch(refreshedMarker, /masked prompt|First prompt/u);

  const linkedView = {
    ...view,
    transcript: view.transcript.map((entry) => entry.id === "user-a"
      ? { ...entry, text: "[visible label](https://secret.example/token?key=abc)" }
      : entry),
  };
  const linkedTail = renderFrame(linkedView, size, theme);
  const linkedNavigation = linkedTail.transcriptNavigation;
  assert.ok(linkedNavigation !== undefined);
  const linkedRow = linkedNavigation.messageRows[1]! + 2;
  const linkedOffset = linkedNavigation.totalRows - linkedNavigation.viewportRows - linkedRow;
  assert.ok(linkedOffset > 0);
  const linked = stripAnsi(renderFrame({ ...linkedView, transcriptOffset: linkedOffset }, size, theme).text);
  const linkedMarker = linked.split("\n").find((line) => line.includes("older transcript")) ?? "";
  assert.match(linkedMarker, /older transcript · visible label/u);
  assert.doesNotMatch(linkedMarker, /secret\.example|token|key=abc|https?:|\]\(/u);

  const nestedLinkedView = {
    ...view,
    transcript: view.transcript.map((entry) => entry.id === "user-a"
      ? { ...entry, text: "[outer [inner](https://nested-secret.example/one)](https://nested-secret.example/two)" }
      : entry),
  };
  const nestedLinkedTail = renderFrame(nestedLinkedView, size, theme);
  const nestedLinkedNavigation = nestedLinkedTail.transcriptNavigation;
  assert.ok(nestedLinkedNavigation !== undefined);
  const nestedLinkedRow = nestedLinkedNavigation.messageRows[1]! + 2;
  const nestedLinkedOffset = nestedLinkedNavigation.totalRows
    - nestedLinkedNavigation.viewportRows
    - nestedLinkedRow;
  assert.ok(nestedLinkedOffset > 0);
  const nestedLinked = stripAnsi(renderFrame({
    ...nestedLinkedView,
    transcriptOffset: nestedLinkedOffset,
  }, size, theme).text);
  const nestedLinkedMarker = nestedLinked.split("\n")
    .find((line) => line.includes("older transcript")) ?? "";
  assert.match(nestedLinkedMarker, /older transcript · outer inner/u);
  assert.doesNotMatch(nestedLinkedMarker, /nested-secret|https?:|\]\(/u);
});

test("internal viewport anchors keep duplicate transcript text distinct and skip transient local rows", () => {
  const theme = createTheme("mono", { color: false, unicode: true });
  const view = {
    context: { status: "idle" as const },
    transcript: [
      { id: "duplicate-first", kind: "assistant" as const, text: "identical durable text" },
      { id: "local:transient-anchor", kind: "status" as const, text: "temporary status" },
      { id: "local:transient-error", kind: "error" as const, text: "temporary error" },
      { id: "duplicate-second", kind: "assistant" as const, text: "identical durable text" },
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `durable-tail-${index}`,
        kind: "status" as const,
        text: `durable tail ${index}`,
      })),
    ],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal" as const,
  };
  const size = { columns: 64, rows: 12 };
  const tail = renderFrame(view, size, theme);
  const navigation = tail.transcriptNavigation;
  const tailAnchors = internalTranscriptFrameAnchorState(tail);
  assert.ok(navigation !== undefined);
  assert.ok(tailAnchors !== undefined);
  assert.equal(tailAnchors.rows.every((anchor) => anchor !== undefined), true);
  assert.equal(
    tailAnchors.rows.some((anchor) => anchor?.entryId === "local:transient-anchor" && anchor.durable === false),
    true,
  );
  assert.equal(
    tailAnchors.rows.some((anchor) => anchor?.entryId === "local:transient-error" && anchor.durable === false),
    true,
  );

  const target = tailAnchors.rows.findIndex((anchor) =>
    anchor?.entryId === "duplicate-second" && anchor.renderedRow === 1);
  assert.ok(target > 1);
  const start = target - 1;
  const transcriptOffset = navigation.totalRows - navigation.viewportRows - start;
  assert.ok(transcriptOffset > 0);
  const paged = renderFrame({ ...view, transcriptOffset }, size, theme);
  const pagedAnchors = internalTranscriptFrameAnchorState(paged);
  assert.equal(paged.transcriptNavigation?.startRow, start);
  assert.match(stripAnsi(paged.text).split("\n")[0] ?? "", /older transcript/u);
  assert.equal(pagedAnchors?.viewport?.row, 1);
  assert.deepEqual(pagedAnchors?.viewport?.anchor, {
    entryId: "duplicate-second",
    renderedRow: 1,
    durable: true,
  });
});

test("output-limit warnings follow partial answers without changing their Markdown", () => {
  const rendered = snapshot(renderTranscript([
    { id: "partial", kind: "assistant", text: "Partial **answer**" },
    {
      id: "limit",
      kind: "warning",
      title: "Output limit",
      text: "The response reached the model's output-token limit and may be incomplete.",
    },
  ], 52, createTheme("mono", { color: false, unicode: true })));
  const words = rendered.replace(/\s+/gu, " ");

  assert.match(rendered, /Partial answer/u);
  assert.match(words, /! warning The response reached the model's output-token/u);
  assert.ok(rendered.indexOf("Partial answer") < rendered.indexOf("! warning"));
  assert.ok(rendered.split("\n").every((line) => cellWidth(line) <= 52));
});

test("operator transcript preferences hide reasoning runs and bound padded output", () => {
  const width = 32;
  const rendered = renderTranscript([
    { id: "r1", kind: "reasoning", text: "secret one", expanded: false },
    { id: "r2", kind: "reasoning", text: "secret two", expanded: false },
    { id: "a", kind: "assistant", text: "```ts\nconst value = 1;\n```" },
  ], width, createTheme("mono", { color: false, unicode: false }), {
    hideReasoningBlock: true,
    outputPad: 1,
    codeBlockIndent: "  ",
  });
  assert.equal(rendered.match(/Thinking\.\.\./gu)?.length, 1);
  assert.doesNotMatch(rendered, /secret one|secret two/u);
  assert.match(rendered, /  const value = 1;/u);
  assert.ok(rendered.split("\n").every((line) => cellWidth(line) <= width));
});

test("stable transcript layout cache follows content width theme and transformer changes", () => {
  const entries: TranscriptEntry[] = [
    { id: "cached-user", kind: "user", text: "cached user before" },
    { id: "cached-assistant", kind: "assistant", text: "cached **assistant before**" },
    { id: "cached-status", kind: "status", text: "cached status before", status: "pending" },
    {
      id: "cached-tool",
      kind: "tool",
      text: "",
      title: "read",
      status: "pending",
      toolData: { input: { command: "echo cached" } },
    },
  ];
  const signal = createTheme("signal", { color: true, unicode: true });
  const colored = renderTranscript(entries, 40, signal);
  assert.match(stripAnsi(colored), /cached assistant before/u);
  assert.match(colored, /\u001b\[/u);

  entries[0]!.text = "cached user after";
  entries[1]!.text = "cached assistant after with narrow wrapping";
  entries[2]!.text = "cached status after";
  entries[2]!.status = "failed";
  entries[3]!.title = "bash";
  entries[3]!.status = "failed";
  const mono = createTheme("mono", { color: false, unicode: false });
  const changedGlyphTheme = { ...mono, glyphs: { ...mono.glyphs, pending: "?" } };
  const plain = renderTranscript(entries, 18, changedGlyphTheme, {
    outputPad: 1,
  });
  const plainWords = plain.replace(/\s+/gu, " ");
  assert.doesNotMatch(plain, /before/u);
  assert.match(plainWords, /cached user after/u);
  assert.match(plainWords, /cached assistant after/u);
  assert.match(plainWords, /\? cached status after/u);
  assert.match(plainWords, /x \$ echo cached .*failed/u);
  assert.ok(plain.split("\n").every((line) => cellWidth(line) <= 18));
  assert.ok(renderTranscript([entries[2]!], 40, signal).includes(signal.codes.error));

  let transformedLabel = "assistant transformed";
  const transformMarkdown = (markdown: string) => markdown.replace("assistant after", transformedLabel);
  const transformed = renderTranscript(entries, 18, mono, {
    outputPad: 1,
    transformMarkdown,
  });
  assert.match(transformed.replace(/\s+/gu, " "), /cached assistant transformed/u);
  assert.doesNotMatch(transformed, /cached assistant after/u);

  transformedLabel = "assistant refreshed";
  const refreshed = renderTranscript(entries, 18, mono, { outputPad: 1, transformMarkdown });
  assert.match(refreshed.replace(/\s+/gu, " "), /cached assistant refreshed/u);
  assert.doesNotMatch(refreshed, /cached assistant transformed/u);

  entries[1]!.text = "```ts\nconst cached = true;\n```";
  const indented = renderTranscript(entries, 40, mono, { codeBlockIndent: "  " });
  assert.match(indented, /^  const cached = true;$/mu);
});

test("unchanged streaming assistant and reasoning bodies reuse their retained layout", () => {
  const theme = createTheme("mono", { color: false, unicode: true });
  const size = { columns: 180, rows: 30 };
  const source = Array.from(
    { length: 1_200 },
    (_, index) => `## Section ${index}\nA realistic paragraph with **markdown**, \`code\`, and wrapping.`,
  ).join("\n\n");
  const frame = (transcript: TranscriptEntry[], activityFrame: number) => renderFrame({
    context: {
      active: true,
      status: "streaming",
      activity: { phase: "Generating response", startedAt: Number.NaN, cancellable: true },
      activityFrame,
    },
    transcript,
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
    workingIndicator: { frames: ["A", "B"], intervalMs: 100 },
  }, size, theme).text;
  const expectFastStableFrame = (transcript: TranscriptEntry[], expected: string): void => {
    const samples = Array.from({ length: 5 }, () => {
      const startedAt = performance.now();
      const retained = frame(transcript, 0);
      const elapsedMs = performance.now() - startedAt;
      assert.equal(retained, expected, "unchanged retained narrative must render identically");
      return elapsedMs;
    }).sort((left, right) => left - right);
    const median = samples[2]!;
    assert.ok(
      median < 50,
      `unchanged retained frame took ${median.toFixed(1)}ms`,
    );
  };

  // Warm the Markdown parser without populating either retained-entry cache.
  frame([{ id: "warm", kind: "assistant", text: "warm" }], 0);

  const assistant: TranscriptEntry = {
    id: "streaming-assistant-cache",
    kind: "assistant",
    text: source,
    streaming: true,
  };
  const firstAssistant = frame([assistant], 0);
  expectFastStableFrame([assistant], firstAssistant);

  for (const streaming of [false, true]) {
    const reasoning: TranscriptEntry[] = [
      {
        id: `reasoning-cache-${streaming}-a`,
        kind: "reasoning",
        sourceMessageId: `reasoning-cache-${streaming}`,
        text: source.slice(0, Math.floor(source.length / 2)),
        expanded: true,
        streaming,
      },
      {
        id: `reasoning-cache-${streaming}-b`,
        kind: "reasoning",
        sourceMessageId: `reasoning-cache-${streaming}`,
        text: source.slice(Math.floor(source.length / 2)),
        expanded: true,
        streaming,
      },
    ];
    const first = frame(reasoning, 0);
    expectFastStableFrame(reasoning, first);
    const animated = frame(reasoning, 1);
    if (streaming) assert.notEqual(animated, first, "the live reasoning header must remain animated");
  }
});

test("streaming narrative caches invalidate on transformed text layout and theme changes", () => {
  const assistant: TranscriptEntry = {
    id: "streaming-cache-invalidation-assistant",
    kind: "assistant",
    text: "assistant TOKEN\n```ts\nconst assistant = true;\n```",
    streaming: true,
  };
  const reasoning: TranscriptEntry[] = [
    {
      id: "streaming-cache-invalidation-reasoning-a",
      kind: "reasoning",
      sourceMessageId: "streaming-cache-invalidation-reasoning",
      text: "reasoning TOKEN",
      expanded: true,
      streaming: true,
    },
    {
      id: "streaming-cache-invalidation-reasoning-b",
      kind: "reasoning",
      sourceMessageId: "streaming-cache-invalidation-reasoning",
      text: "```ts\nconst reasoning = true;\n```",
      expanded: true,
      streaming: true,
    },
  ];
  let label = "first";
  const transformMarkdown: NonNullable<Parameters<typeof renderTranscript>[3]>["transformMarkdown"] =
    (markdown, context) => markdown.replace("TOKEN", `${label}-${context.isStreaming ? "live" : "settled"}`);
  const monoUnicode = createTheme("mono", { color: false, unicode: true });
  const render = (
    width: number,
    theme = monoUnicode,
    codeBlockIndent = "",
  ) => renderTranscript([assistant, ...reasoning], width, theme, { transformMarkdown, codeBlockIndent });

  const first = stripAnsi(render(64));
  assert.match(first, /assistant first-live/u);
  assert.match(first, /reasoning first-live/u);

  label = "dynamic";
  const transformed = stripAnsi(render(64));
  assert.match(transformed, /assistant dynamic-live/u);
  assert.match(transformed, /reasoning dynamic-live/u);
  assert.doesNotMatch(transformed, /first-live/u);

  assistant.text += "\nassistant growth sentinel";
  reasoning[1]!.text += "\nreasoning growth sentinel";
  const grown = stripAnsi(render(64));
  assert.match(grown, /assistant growth sentinel/u);
  assert.match(grown, /reasoning growth sentinel/u);

  const narrow = stripAnsi(render(24));
  assert.ok(narrow.split("\n").every((line) => cellWidth(line) <= 24));
  assert.notEqual(narrow, grown);

  const indented = stripAnsi(render(64, monoUnicode, "  "));
  assert.match(indented, /^  const assistant = true;$/mu);
  assert.match(indented, /[|│]   const reasoning = true;/u);

  const ascii = stripAnsi(render(64, createTheme("mono", { color: false, unicode: false }), "  "));
  assert.match(ascii, /^\+ .*Thinking/mu);
  assert.doesNotMatch(ascii, /[┌│└]/u);

  assistant.streaming = false;
  reasoning[0]!.streaming = false;
  reasoning[1]!.streaming = false;
  label = "complete";
  const settled = stripAnsi(render(64));
  assert.match(settled, /assistant complete-settled/u);
  assert.match(settled, /reasoning complete-settled/u);
});

test("editorPaddingX reserves equal composer edges", () => {
  const frame = renderFrame({
    context: { status: "idle" },
    transcript: [],
    transcriptOffset: 0,
    editorText: "draft",
    editorCursor: 5,
    inputLabel: "you",
    inputMode: "normal",
  }, { columns: 24, rows: 8 }, createTheme("mono", { color: false, unicode: false }), { editorPaddingX: 2 });
  assert.ok(frame.text.split("\n").some((line) => line.startsWith("  draft")));
  assert.equal(frame.cursor?.column, 8);
});
