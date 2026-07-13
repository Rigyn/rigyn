import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_TUI_LIMITS } from "../../src/tui/controller.js";
import { renderFrame, renderTranscript, renderTranscriptFrame } from "../../src/tui/layout.js";
import { TuiModel } from "../../src/tui/model.js";
import { validateTerminalImage, type TerminalImageResolution } from "../../src/tui/terminal-image.js";
import { createTheme } from "../../src/tui/theme.js";
import type { TuiViewState } from "../../src/tui/types.js";
import { cellWidth, stripAnsi } from "../../src/tui/unicode.js";
import { envelope } from "./helpers.js";

function snapshot(value: string): string {
  return value.split("\n").map((line) => line.trimEnd()).join("\n");
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
});

test("collapsed reasoning renders a clean headline instead of provider markdown artifacts", () => {
  const rendered = renderTranscript([{
    id: "reasoning",
    kind: "reasoning",
    text: "**Planning extension capability research** <!-- internal marker -->\n\nMore detail",
    expanded: false,
  }], 80, createTheme("mono", { color: false, unicode: false }));

  assert.match(rendered, /summary Planning extension capability research/u);
  assert.doesNotMatch(rendered, /\*\*|<!--|internal marker|More detail/u);
});

test("collapsed reasoning wraps sequential summaries within the terminal width", () => {
  const width = 34;
  const rendered = snapshot(renderTranscript([{
    id: "reasoning-wrap",
    kind: "reasoning",
    text: "**Planning renderer checks**<!-- boundary -->**Designing a focused fixture**<!-- boundary -->**Reviewing narrow terminal behavior**",
    expanded: false,
  }], width, createTheme("mono", { color: false, unicode: false })));
  const lines = rendered.split("\n");

  assert.ok(lines.length > 1);
  assert.match(rendered.replace(/\s+/gu, " "), /Planning renderer checks Designing/u);
  assert.doesNotMatch(rendered, /checksDesigning|fixtureReviewing|<!--|\*\*/u);
  assert.ok(lines.every((line) => cellWidth(line) <= width));
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
        expanded: false,
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
    "",
    "-".repeat(52),
    "+ Read · src/parser.ts · done",
    "  | line 1",
    "  | line 2",
    "  | line 3",
    "  | line 4",
    "  | line 5",
    "  \\ line 6",
    "-".repeat(52),
    ". Ready",
    "----------------------------------------------------",
    " next step",
    "----------------------------------------------------",
    " ~/rigyn • parser fix",
    "↑10 ↓5 50.0%/20k (auto)            (openai) gpt-test",
  ].join("\n"));
  assert.deepEqual(frame.cursor, { row: 13, column: 6 });
  assert.doesNotMatch(frame.text, /Rigyn|thr_1/u);
});

test("successful reads show a bounded preview and reveal the rest when expanded", () => {
  const theme = createTheme("mono", { color: false, unicode: false });
  const read = {
    id: "tool:read",
    kind: "tool" as const,
    callId: "read",
    title: "read",
    summary: "src/parser.ts:1-2",
    status: "completed" as const,
    text: "first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh\neighth",
    expanded: false,
  };

  assert.equal(snapshot(renderTranscript([read], 60, theme)), [
    "-".repeat(60),
    "+ Read · src/parser.ts:1-2 · done",
    "  | first",
    "  | second",
    "  | third",
    "  | fourth",
    "  | fifth",
    "  | sixth",
    "  \\ ... (2 more lines, Ctrl+O to expand)",
    "-".repeat(60),
  ].join("\n"));
  assert.equal(snapshot(renderTranscript([{ ...read, expanded: true }], 60, theme)), [
    "-".repeat(60),
    "+ Read · src/parser.ts:1-2 · done",
    "  | first",
    "  | second",
    "  | third",
    "  | fourth",
    "  | fifth",
    "  | sixth",
    "  | seventh",
    "  \\ eighth",
    "-".repeat(60),
  ].join("\n"));
});

test("native tool cards combine bounded previews, metadata, and one frame", () => {
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
    expanded: false,
  }], 52, theme));
  const lines = rendered.split("\n");

  assert.equal(lines[0], "─".repeat(52));
  assert.match(lines[1] ?? "", /✓ Read · \[ts\] src\/parser\.ts · 7 lines read · limited/u);
  assert.match(rendered, /│ one/u);
  assert.match(rendered, /│   two/u);
  assert.match(rendered, /Ctrl\+O to expand/u);
  assert.equal(lines.at(-1), "─".repeat(52));
  assert.equal(lines.filter((line) => /^─+$/u.test(line)).length, 2);
  assert.ok(lines.every((line) => cellWidth(line) <= 52));
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

  assert.match(lines[1] ?? "", /Read · \[ts\] src\/重要/u);
  assert.ok(lines.every((line) => cellWidth(line) <= width));
});

test("failed shell headers remain explicit when result metadata is missing or inconsistent", () => {
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

  assert.match(withoutMetadata, /x Bash · failed/u);
  assert.match(inconsistentMetadata, /x Bash · failed · exit 0/u);
});

test("native tool status uses canonical built-in metadata without naming companion tools", () => {
  const theme = createTheme("mono", { color: false, unicode: false });
  const cases = [
    ["grep", { count: 1 }, "1 match"],
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
    assert.match(rendered, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
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
    text: "Read image file [image/png]\nImage omitted: unsupported dimensions",
    expanded: false,
    toolData: {
      result: {
        content: "Read image file [image/png]\nImage omitted: unsupported dimensions",
        isError: false,
        metadata: { mediaType: "image/png", omitted: true },
      },
    },
  };

  assert.match(
    snapshot(renderTranscript([entry], 60, createTheme("mono", { color: false, unicode: false }))),
    /Image omitted: unsupported dimensions/u,
  );
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
  const warning = renderFrame(base, { columns: 40, rows: 8 }, createTheme("dark", { color: true, unicode: true })).text;
  assert.match(warning, /\u001b\[38;5;221m/u);
  const error = renderFrame({ ...base, context: { ...base.context, contextTokens: 95 } }, { columns: 40, rows: 8 }, createTheme("dark", { color: true, unicode: true })).text;
  assert.match(error, /\u001b\[38;5;203m/u);
});

test("footer exposes the active phase, elapsed time, retry countdown, and cancel key", () => {
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
  assert.match(snapshot(frame.text), /Retrying rate limit · 1\.\ds · retry in 2\.\ds \(attempt 2\) · Esc cancel/u);
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

  assert.equal(snapshot(frame.text).split("\n").at(-1), "  model-with-a-very-long-…");
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

  assert.match(snapshot(reasoning).split("\n").at(-1) ?? "", /fixture • thinking off$/u);
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
  assert.deepEqual(frame.cursor, { row: 8, column: 9 });
});

test("picker overlay is searchable and temporarily replaces the editor body", () => {
  const frame = renderFrame({
    context: { status: "idle" },
    transcript: [],
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
  assert.match(rendered, /Models:/u);
  assert.match(rendered, /search> sm/u);
  assert.match(rendered, /> smart — large context/u);
  assert.doesNotMatch(rendered, /small|swift|draft remains/u);
  assert.match(rendered.split("\n").at(-1) ?? "", /no-model/u);
  assert.equal(frame.cursor?.column, 11);
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
  assert.match(rendered, /Resume Session:/u);
  assert.match(rendered, /search> ui/u);
  assert.match(rendered, /> UI audit session/u);
  assert.match(rendered, /Enter select · Esc cancel/u);
  assert.equal(rendered.match(/Enter select/gu)?.length, 1);
  assert.equal(lines.at(-3), "─".repeat(32));
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
  const lines = rendered.split("\n");
  assert.match(rendered, /No available models/u);
  assert.match(rendered, /\/login to connect/u);
  assert.match(rendered, /provider\./u);
  assert.match(rendered, /Esc cancel/u);
  assert.equal(lines.at(-3), "─".repeat(32));
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
  assert.match(rendered, /Enter change · Esc close/u);
  assert.equal(lines.at(-3), "─".repeat(32));
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
  assert.equal(compact.text.split("\n").length, 4);
  assert.equal(snapshot(compact.text).split("\n")[0], "----------------------------------------");
  assert.deepEqual(compact.cursor, { row: 2, column: 7 });
  assert.equal(full.text.split("\n").length, 24);
});

test("collapsed tool output stays multiline and expands without duplicating its header", () => {
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
  assert.match(collapsed, /\+ Shell · npm test · 1m 1s · exit 0 · full output: \/tmp\/npm-test\.log/u);
  assert.match(collapsed, /\| \.\.\. \(2 earlier lines, Ctrl\+O to expand\)\n  \| three\n  \| four\n  \| five\n  \| six\n  \| seven\n  \\ eight/u);
  assert.doesNotMatch(collapsed, /\| one|\| two/u);

  const expanded = snapshot(renderTranscript([{ ...base.transcript[0]!, expanded: true }], 80, theme));
  assert.match(expanded, /\| one\n  \| two\n  \| three\n  \| four\n  \| five\n  \| six\n  \| seven\n  \\ eight/u);
  assert.equal(expanded.match(/\+ Shell/gu)?.length, 1);
});

test("persisted user shell history renders as one expandable shell card", () => {
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
  assert.match(collapsed, /\+ Shell · npm test · exit 0/u);
  assert.match(collapsed, /\| \.\.\. \(2 earlier lines, Ctrl\+O to expand\)\n  \| three\n  \| four\n  \| five\n  \| six\n  \| seven\n  \\ eight/u);
  assert.doesNotMatch(collapsed, /\[User shell command\]|user-shell-render/u);

  assert.equal(model.toggleTool("user-shell:user-shell-render"), true);
  const expanded = snapshot(renderTranscript(model.entries, 80, theme));
  assert.match(expanded, /\| one\n  \| two\n  \| three\n  \| four\n  \| five\n  \| six\n  \| seven\n  \\ eight/u);
  assert.equal(expanded.match(/\+ Shell/gu)?.length, 1);
});

test("mutation cards render structured input through the existing collapse and keep errors visible", () => {
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
    "-".repeat(60),
    "x Edit · src/a.ts · failed",
    "  | oldText was not found",
    "  | --- old",
    "  | - first",
    "  | - second",
    "  | +++ new",
    "  \\ + replacement",
    "-".repeat(60),
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
    "-".repeat(60),
    "+ Write · src/new.ts · done",
    "  | + one",
    "  \\ + two",
    "-".repeat(60),
  ].join("\n"));
  assert.doesNotMatch(write, /sha256/u);

  const coloredTheme = createTheme("dark", { color: true, unicode: true });
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
  const theme = createTheme("dark", { color: true, unicode: true });
  const rendered = renderTranscript([entry], 50, theme, {
    toolRenderBlocks: new Map([["custom", {
      call: { lines: [{ spans: [{ text: "\u001b]2;owned\u0007CUSTOM ", role: "accent" }, { text: "read", role: "warning" }] }] },
      result: { lines: [{ spans: [{ text: "CUSTOM RESULT", role: "success" }] }] },
    }]]),
  });
  assert.match(snapshot(stripAnsi(rendered)), /CUSTOM read\nCUSTOM RESULT/u);
  assert.doesNotMatch(stripAnsi(rendered), /^(?:─+|-+)$/mu);
  assert.doesNotMatch(rendered, /\u001b\]2;owned/u);
  assert.ok(rendered.includes(theme.codes.accent));
  assert.ok(rendered.includes(theme.codes.warning));
  assert.ok(rendered.includes(theme.codes.success));

  const fallback = snapshot(renderTranscript([{ ...entry, expanded: true }], 50, createTheme("mono", { color: false, unicode: false }), {
    toolRenderBlocks: new Map([["custom", {
      call: { lines: [], raw: "not allowed" } as never,
    }]]),
  }));
  assert.match(fallback, /\+ Read · fallback\.txt · done\n  \\ built-in result/u);
});

test("extension session render blocks override bounded data-only fallbacks", () => {
  const entries = [{
    id: "extension-state",
    kind: "status" as const,
    text: "",
    extension: { type: "state" as const, extensionId: "owner.extension", schemaVersion: 1, key: "counter" },
  }, {
    id: "extension-message",
    kind: "status" as const,
    text: "safe fallback",
    extension: { type: "message" as const, extensionId: "owner.extension", schemaVersion: 1, key: "notice" },
  }];
  const mono = createTheme("mono", { color: false, unicode: false });
  const fallback = snapshot(renderTranscript(entries, 60, mono));
  assert.match(fallback, /owner\.extension@1\/counter/u);
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
  const theme = createTheme("dark", { color: true, unicode: true });
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

test("assistant Markdown presents inline code, emphasis, strong text, and links without rewriting them", () => {
  const source = "Use `npm test`, **strong**, *careful*, [the docs](https://example.test), and <mailto:team@example.test>.";
  const mono = renderTranscript([{
    id: "assistant",
    kind: "assistant",
    text: source,
  }], 120, createTheme("mono", { color: false, unicode: false }));
  assert.equal(mono, source);

  const theme = createTheme("dark", { color: true, unicode: true });
  const colored = renderTranscript([{
    id: "assistant",
    kind: "assistant",
    text: source,
  }], 120, theme);
  assert.equal(stripAnsi(colored), source);
  assert.ok(colored.includes(theme.codes.accent));
  assert.ok(colored.includes(theme.codes.title));
  assert.ok(colored.includes(theme.codes.muted));
});

test("trusted Markdown links emit line-local OSC 8 only when terminal support is known", () => {
  const source = "Read [docs](https://example.test/guide) or <mailto:team@example.test>; keep [unsafe](javascript:alert(1)) literal.";
  const entry = [{ id: "assistant", kind: "assistant" as const, text: source }];
  const theme = createTheme("mono", { color: false, unicode: true });
  const fallback = renderTranscript(entry, 140, theme, { hyperlinks: false });
  assert.equal(fallback, source);
  assert.doesNotMatch(fallback, /\u001b\]8;/u);
  const linked = renderTranscript(entry, 140, theme, { hyperlinks: true });
  assert.equal(stripAnsi(linked), source);
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
  assert.equal(frame.text.split("\n").length, 4);
  assert.doesNotMatch(frame.text, new RegExp(data.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
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
  assert.equal(mono, source);

  const theme = createTheme("dark", { color: true, unicode: true });
  const colored = renderTranscript([{
    id: "assistant",
    kind: "assistant",
    text: source,
  }], 120, theme);
  const lines = colored.split("\n");
  assert.equal(stripAnsi(colored), source);
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
  const expected = "**前🙂後** and `界🙂` [文](https://例.test) tail";
  const rendered = renderTranscript([{
    id: "assistant",
    kind: "assistant",
    text: source,
  }], 20, createTheme("mono", { color: false, unicode: true }));
  assert.equal(rendered.split("\n").join(""), expected);
  assert.ok(rendered.split("\n").every((line) => cellWidth(line) <= 20));
  assert.doesNotMatch(rendered, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u001b]/u);
});

test("malformed Markdown and HTML-like text remain readable literal text", () => {
  const source = "<b>literal</b> **unclosed [bad](target with space)";
  const theme = createTheme("dark", { color: true, unicode: true });
  const rendered = renderTranscript([{
    id: "assistant",
    kind: "assistant",
    text: source,
  }], 100, theme);
  assert.equal(stripAnsi(rendered), source);
  assert.doesNotMatch(rendered, new RegExp([theme.codes.accent, theme.codes.title, theme.codes.muted]
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
  assert.equal(mono, source);

  const theme = createTheme("dark", { color: true, unicode: true });
  const colored = renderTranscript([{ id: "assistant", kind: "assistant", text: source }], 120, theme);
  const lines = colored.split("\n");
  assert.equal(stripAnsi(colored), source);
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
  const theme = createTheme("dark", { color: true, unicode: true });
  const rendered = renderTranscript([{ id: "assistant", kind: "assistant", text: source }], 120, theme);
  const lines = rendered.split("\n");
  assert.equal(stripAnsi(rendered), source);
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
  assert.equal(mono, source);

  const theme = createTheme("dark", { color: true, unicode: true });
  const rendered = renderTranscript([{ id: "assistant", kind: "assistant", text: source }], 120, theme);
  const lines = rendered.split("\n");
  assert.equal(stripAnsi(rendered), source);
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
  const theme = createTheme("dark", { color: true, unicode: true });
  const partial = renderTranscript([{ id: "assistant", kind: "assistant", text: partialSource }], 80, theme);
  const again = renderTranscript([{ id: "assistant", kind: "assistant", text: partialSource }], 80, theme);
  const complete = renderTranscript([{ id: "assistant", kind: "assistant", text: completeSource }], 80, theme);
  assert.equal(partial, again);
  assert.ok(complete.startsWith(`${partial}\n`));
  assert.equal(stripAnsi(complete), completeSource);
  assert.ok(complete.split("\n")[6]?.includes(theme.codes.accent));
  assert.ok(complete.split("\n")[6]?.includes(theme.codes.success));
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
  assert.equal(renderedLines.split("\n").length, 20_000);
  assert.match(renderedLines.split("\n")[0] ?? "", /earlier rendered Markdown omitted/u);
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
  assert.deepEqual(transcript.split("\n").map(cellWidth), [500, 500, 1]);
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

test("transcript cards distinguish speakers and every tool state without noisy labels", () => {
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

  assert.equal(rendered, [
    " Fix the parser",
    " and keep the API stable",
    "",
    "## Plan",
    "I will inspect the parser.",
    "",
    "-".repeat(48),
    "> Read · src/parser.ts · queued",
    "-".repeat(48),
    "",
    "-".repeat(48),
    ". Shell · npm test · running",
    "  \\ waiting",
    "-".repeat(48),
    "",
    "-".repeat(48),
    "+ Edit · src/parser.ts · done",
    "  | one",
    "  | two",
    "  | three",
    "  | four",
    "  | five",
    "  \\ six",
    "-".repeat(48),
    "",
    "-".repeat(48),
    "x Web fetch · https://example.test · failed",
    "  \\ network error",
    "-".repeat(48),
  ].join("\n"));
  assert.doesNotMatch(rendered, /\b(?:you|agent)\b/u);

  const coloredTheme = createTheme("dark", { color: true, unicode: true });
  const coloredLines = renderTranscript([
    { id: "u", kind: "user", text: "message" },
    { id: "p", kind: "tool", title: "read", status: "pending", text: "" },
    { id: "r", kind: "tool", title: "shell", status: "running", text: "" },
    { id: "s", kind: "tool", title: "edit", status: "completed", text: "" },
    { id: "e", kind: "tool", title: "fetch", status: "failed", text: "" },
  ], 20, coloredTheme).split("\n");
  assert.ok([coloredLines[0], coloredLines[3], coloredLines[7], coloredLines[11], coloredLines[15]]
    .every((line) => cellWidth(line ?? "") > 0 && cellWidth(line ?? "") <= 20));
  assert.ok(coloredLines[0]?.startsWith(coloredTheme.codes.userMessage));
  assert.ok(coloredLines[3]?.startsWith(coloredTheme.codes.toolPending));
  assert.ok(coloredLines[7]?.startsWith(coloredTheme.codes.toolRunning));
  assert.ok(coloredLines[11]?.startsWith(coloredTheme.codes.toolSuccess));
  assert.ok(coloredLines[15]?.startsWith(coloredTheme.codes.toolError));
  assert.doesNotMatch(coloredLines[1] ?? "", /48;/u);
});

test("thinking level changes the editor border role", () => {
  const theme = createTheme("dark", { color: true, unicode: true });
  const frame = renderFrame({
    context: { status: "idle", thinking: "high" },
    transcript: [],
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  }, { columns: 60, rows: 10 }, theme);
  assert.ok(frame.text.includes(theme.codes.warning));
});
