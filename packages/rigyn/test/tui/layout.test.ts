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

test("multiple collapsed reasoning rows wrap independently downward", () => {
  const frame = renderFrame({
    context: { status: "idle", model: "fixture" },
    transcript: ["first", "second", "third"].map((name) => ({
      id: `reasoning-${name}`,
      kind: "reasoning" as const,
      text: `**Planning ${name} workflow with enough detail to wrap**<!-- boundary -->**Reviewing ${name} workflow without horizontal concatenation**`,
      expanded: false,
    })),
    transcriptOffset: 0,
    editorText: "",
    editorCursor: 0,
    inputLabel: "you",
    inputMode: "normal",
  }, { columns: 52, rows: 24 }, createTheme("mono", { color: false, unicode: true }));
  const lines = snapshot(frame.text).split("\n");
  const starts = lines.flatMap((line, index) => line.includes("◆ summary ") ? [index] : []);

  assert.equal(starts.length, 3);
  assert.ok(starts[0]! < starts[1]! && starts[1]! < starts[2]!);
  assert.ok(starts.every((index) => index + 1 < lines.length && !lines[index + 1]!.includes("◆ summary ")));
  assert.doesNotMatch(frame.text, /workflowReviewing|concatenation◆/u);
  assert.ok(lines.every((line) => cellWidth(line) <= 52));
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
  const editor = visible.indexOf("PROMPT> draft");
  const below = visible.indexOf("BELOW EDITOR");
  const footer = visible.indexOf("REPLACED FOOTER");
  assert.ok(header >= 0 && header < above && above < editor && editor < below && below < footer);
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
    "-".repeat(52),
    "| + Read · src/parser.ts · done",
    "|    line 1",
    "|    line 2",
    "|    line 3",
    "|    line 4",
    "|    line 5",
    "|    line 6",
    "-".repeat(52),
    ". Ready",
    "-".repeat(52),
    " next step",
    "-".repeat(52),
    " ~/rigyn • parser fix",
    "(openai) gpt-test",
    "in 10 · out 5 · ctx [##--] 50.0%/20k auto",
  ].join("\n"));
  assert.deepEqual(frame.cursor, { row: 12, column: 6 });
  assert.doesNotMatch(frame.text, /thr_1/u);
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

  assert.match(snapshot(frame.text), /(?:^|\n) ~\/projects\/rigyn(?:\n|$)/u);
  assert.doesNotMatch(frame.text, /~\\/u);
});

test("completed reads keep ordinary file content collapsed until expanded", () => {
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

  const collapsed = [
    "-".repeat(60),
    "| + Read · src/parser.ts:1-2 · done",
    "-".repeat(60),
  ].join("\n");
  const expanded = [
    "-".repeat(60),
    "| + Read · src/parser.ts:1-2 · done",
    "|    first",
    "|    second",
    "|    third",
    "|    fourth",
    "|    fifth",
    "|    sixth",
    "|    seventh",
    "|    eighth",
    "-".repeat(60),
  ].join("\n");
  assert.equal(snapshot(renderTranscript([read], 60, theme)), collapsed);
  assert.equal(snapshot(renderTranscript([{ ...read, expanded: true }], 60, theme)), expanded);
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
    expanded: true,
  }], 52, theme));
  const lines = rendered.split("\n");

  assert.equal(lines[0], "─".repeat(52));
  assert.match(lines[1] ?? "", /│ ✓ Read · \[ts\] src\/parser\.ts · 7 lines · limited/u);
  assert.match(rendered, /│ {4}one/u);
  assert.match(rendered, /│ {6}two/u);
  assert.match(rendered, /│ {4}seven/u);
  assert.doesNotMatch(rendered, /more rows|Ctrl\+O/u);
  assert.equal(lines.at(-1), "─".repeat(52));
  assert.ok(lines.every((line) => cellWidth(line) <= 52));
});

test("completed code reads reuse the native syntax tokenizer without changing stored text", () => {
  const source = "const answer: number = 42;\nconst label = \"ready\";";
  const theme = createTheme("dark", { color: true, unicode: true });
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
  const stored = stripAnsi(rendered).split("\n").slice(2, -1)
    .map((line) => line.replace(/^│ {4}/u, ""))
    .join("\n");

  assert.equal(stored, source);
  assert.ok(lines[2]?.includes(theme.codes.accent));
  assert.ok(lines[2]?.includes(theme.codes.warning));
  assert.ok(lines[3]?.includes(theme.codes.success));
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

  assert.match(lines[1] ?? "", /Read · src\/重要/u);
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

  assert.match(withoutMetadata, /\| x Bash · failed/u);
  assert.match(inconsistentMetadata, /\| x Bash · failed · exit 0/u);
});

test("narrow shell headers reserve decisive running and exit metadata", () => {
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

  assert.match(failed, /^\| x Bash.*· exit 17$/mu);
  assert.match(running, /^\| \* Bash.*· 2s$/mu);
  assert.ok([...failed.split("\n"), ...running.split("\n")].every((line) => cellWidth(line) <= 24));
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
  }], 52, createTheme("dark", { color: true, unicode: true }));

  assert.match(progress, /│ ● Bash · npm test · running · 2s/u);
  assert.match(progress, /stdout · 13 bytes · tail/u);
  assert.match(progress, /three/u);
  assert.match(progress, /stderr · 12 bytes/u);
  assert.match(progress, /warning line/u);
  assert.match(progress, /live output · limited/u);
  assert.doesNotMatch(progress, /flattened fallback/u);
  assert.match(stripAnsi(partial), /partial result · limited/u);
  assert.match(stripAnsi(partial), /permission denied/u);
  assert.ok(partial.includes(createTheme("dark", { color: true, unicode: true }).codes.error));
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
  }], 52, createTheme("mono", { color: false, unicode: true })));

  assert.match(rendered, /live 9\n│ {4}live 10\n│ {4}live 11\n│ {4}live 12/u);
  assert.doesNotMatch(rendered, /live [1-8](?:\n|$)|stored fallback/u);
  assert.ok(rendered.split("\n").length <= 9);
});

test("completed narrow shell output renders every stored row", () => {
  const rendered = snapshot(renderTranscript([{
    id: "tool:narrow-tail",
    kind: "tool",
    title: "bash",
    summary: "run",
    status: "completed",
    text: Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"),
    toolData: { result: { content: "done", isError: false, metadata: { exitCode: 0 } } },
  }], 24, createTheme("mono", { color: false, unicode: false })));

  assert.match(rendered, /\| {4}line 1/u);
  assert.match(rendered, /\| {4}line 10/u);
  assert.doesNotMatch(rendered, /earlier rows|Ctrl\+O/u);
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
  const content = rendered.split("\n").slice(2, -1)
    .map((line) => line.replace(/^\| {4}/u, "").trimEnd())
    .join(" ")
    .replace(/\s+/gu, " ");

  assert.equal(content, source);
  assert.ok(rendered.split("\n").every((line) => cellWidth(line) <= 32));
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

  const collapsed = snapshot(renderTranscript([entry], 60, theme));
  assert.match(collapsed, /read-error-10/u);
  assert.match(collapsed, /\.\.\. \+1 more rows/u);
  assert.doesNotMatch(collapsed, /read-error-11/u);

  const expanded = snapshot(renderTranscript([{ ...entry, expanded: true }], 60, theme));
  assert.match(expanded, /read-error-11/u);
  assert.doesNotMatch(expanded, /\.\.\. \+1 more rows/u);
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
  assert.deepEqual(frame.cursor, { row: 8, column: 9 });
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
  assert.equal(rendered.split("\n").at(-1), "no model");
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
  }, { columns: 52, rows: 12 }, createTheme("mono", { color: false, unicode: true }));
  const lines = snapshot(frame.text).split("\n");
  const composer = lines.findIndex((line) => line === "─".repeat(52));

  assert.equal(lines[composer + 1], " Switch to the balanced model and continue the");
  assert.equal(lines[composer + 2], " audit");
  assert.deepEqual(frame.cursor, { row: 10, column: 7 });
  assert.doesNotMatch(lines[composer + 1] ?? "", /\s[a-z]$/u);
});

test("narrow telemetry is stacked into readable chips instead of clipping one rail", () => {
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

  assert.equal(lines.at(-4), " /home/user/rigyn-demo • renderer polish");
  assert.equal(lines.at(-3), "(openai-codex) gpt-5.6-sol · high");
  assert.equal(lines.at(-2), "in 15k · out 2.8k · cache 9.8k (65%)");
  assert.equal(lines.at(-1), "$0.214 · ctx [#---] 13.0%/372k auto");
  assert.ok(lines.slice(-2).every((line) => line !== "…" && cellWidth(line ?? "") <= 52));
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
  assert.equal(snapshot(compact.text).split("\n")[0], "-".repeat(40));
  assert.deepEqual(compact.cursor, { row: 2, column: 7 });
  assert.equal(full.text.split("\n").length, 24);
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
  assert.match(collapsed, /\| \+ Shell · npm test · 1m 1s · exit 0 · full output: \/tmp\/npm-test\.log/u);
  assert.match(collapsed, /\| \.\.\. \+3 earlier rows\n\| {4}four\n\| {4}five\n\| {4}six\n\| {4}seven\n\| {4}eight/u);
  assert.doesNotMatch(collapsed, /\| {4}one\n/u);

  const expanded = snapshot(renderTranscript([{ ...base.transcript[0]!, expanded: true }], 80, theme));
  assert.match(expanded, /\| {4}one\n\| {4}two\n\| {4}three\n\| {4}four\n\| {4}five\n\| {4}six\n\| {4}seven\n\| {4}eight/u);
  assert.doesNotMatch(expanded, /earlier rows/u);
  assert.notEqual(expanded, collapsed);
  assert.equal(expanded.match(/\| \+ Shell/gu)?.length, 1);
});

test("collapsed search, listing, and write tools use their stable head limits", () => {
  const theme = createTheme("mono", { color: false, unicode: false });
  const cases = [
    { title: "grep", limit: 15, source: "output" },
    { title: "find", limit: 20, source: "output" },
    { title: "ls", limit: 20, source: "output" },
    { title: "write", limit: 10, source: "input" },
  ] as const;

  for (const selected of cases) {
    const rows = Array.from({ length: selected.limit + 1 }, (_, index) => `${selected.title}-row-${index + 1}`).join("\n");
    const entry = {
      id: `tool:${selected.title}`,
      kind: "tool" as const,
      callId: selected.title,
      title: selected.title,
      status: "completed" as const,
      text: selected.source === "output" ? rows : "",
      ...(selected.source === "input" ? { inputPreview: rows } : {}),
      expanded: false,
    };
    const collapsed = snapshot(renderTranscript([entry], 80, theme));
    assert.match(collapsed, /\.\.\. \+1 more rows/u, selected.title);
    assert.doesNotMatch(collapsed, new RegExp(`${selected.title}-row-${selected.limit + 1}\\b`, "u"), selected.title);

    const expanded = snapshot(renderTranscript([{ ...entry, expanded: true }], 80, theme));
    assert.match(expanded, new RegExp(`${selected.title}-row-${selected.limit + 1}\\b`, "u"), selected.title);
    assert.doesNotMatch(expanded, /\.\.\. \+1 more rows/u, selected.title);
  }
});

test("persisted user shell history renders as one expanded shell card by default", () => {
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
  const expanded = snapshot(renderTranscript(model.entries, 80, theme));
  assert.match(expanded, /\| \+ Shell · npm test · exit 0/u);
  assert.match(expanded, /\| {4}one\n\| {4}two\n\| {4}three\n\| {4}four\n\| {4}five\n\| {4}six\n\| {4}seven\n\| {4}eight/u);
  assert.doesNotMatch(expanded, /\[User shell command\]|user-shell-render/u);

  assert.equal(model.toggleTool("user-shell:user-shell-render"), true);
  const collapsed = snapshot(renderTranscript(model.entries, 80, theme));
  assert.match(collapsed, /\| \.\.\. \+3 earlier rows\n\| {4}four\n\| {4}five\n\| {4}six\n\| {4}seven\n\| {4}eight/u);
  assert.doesNotMatch(collapsed, /\| {4}one\n/u);
  assert.equal(collapsed.match(/\| \+ Shell/gu)?.length, 1);
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
    "| x Edit · src/a.ts · failed",
    "|    oldText was not found",
    "|    --- old",
    "|    - first",
    "|    - second",
    "|    +++ new",
    "|    + replacement",
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
    "| + Write · src/new.ts · done",
    "|    + one",
    "|    + two",
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

test("completed edit cards render the complete stored diff", () => {
  const diff = [
    "--- src/a.ts",
    "+++ src/a.ts",
    "@@ parser @@",
    ...Array.from({ length: 12 }, (_, index) => `+ added line ${index + 1}`),
  ].join("\n");
  const rendered = snapshot(renderTranscript([{
    id: "tool:complete-edit",
    kind: "tool",
    title: "edit",
    summary: "src/a.ts",
    status: "completed",
    inputPreview: diff,
    text: "",
    toolData: { result: { content: "edited", isError: false, metadata: { replacements: 12 } } },
    expanded: false,
  }], 64, createTheme("mono", { color: false, unicode: true })));

  assert.match(rendered, /│ {4}--- src\/a\.ts/u);
  assert.match(rendered, /│ {4}\+ added line 1/u);
  assert.match(rendered, /│ {4}\+ added line 12/u);
  assert.match(rendered, /│ ✓ Edit · src\/a\.ts · 12 replacements/u);
  assert.doesNotMatch(rendered, /more rows|Ctrl\+O/u);
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
  assert.match(fallback, /\| \+ Read · fallback\.txt · done\n\| {4}built-in result/u);
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
  assert.match(callOnly, /CUSTOM CALL\n\| {4}native result/u);

  const resultOnly = snapshot(renderTranscript([entry], 48, theme, {
    toolRenderBlocks: new Map([["inherited", {
      result: { lines: [{ spans: [{ text: "CUSTOM RESULT" }] }] },
    }]]),
  }));
  assert.match(resultOnly, /\| \+ Read · notes\.txt · done\nCUSTOM RESULT/u);
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
  assert.match(narrow, /earlier/u);
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

  const framed = snapshot(renderTranscript([entry], 44, theme, {
    toolRenderBlocks: new Map([["direct-shell", { shell: "default" as const, call, result }]]),
  }));
  assert.match(framed, /-{20,}\nDIRECT CALL\n\| DIRECT RESULT\n-{20,}/u);
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
  assert.equal(frame.text.split("\n").length, 6);
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

  assert.match(rendered, / Fix the parser\n and keep the API stable/u);
  assert.match(rendered, /## Plan\nI will inspect the parser\./u);
  assert.match(rendered, /\| o Read · src\/parser\.ts · queued/u);
  assert.match(rendered, /\| \* Shell · npm test · running\n\| {4}waiting/u);
  assert.match(rendered, /\| \+ Edit · src\/parser\.ts · done\n\| {4}one[\s\S]*\| {4}six/u);
  assert.match(rendered, /\| x Web fetch · https:\/\/example\.test · failed\n\| {4}network error/u);
  assert.doesNotMatch(rendered, /\b(?:CALL|RESULT|Ctrl\+O)\b/u);
  assert.doesNotMatch(rendered, /\b(?:you|agent)\b/u);

  const coloredTheme = createTheme("dark", { color: true, unicode: true });
  const coloredLines = renderTranscript([
    { id: "u", kind: "user", text: "message" },
    { id: "p", kind: "tool", title: "read", status: "pending", text: "" },
    { id: "r", kind: "tool", title: "shell", status: "running", text: "" },
    { id: "s", kind: "tool", title: "edit", status: "completed", text: "" },
    { id: "e", kind: "tool", title: "fetch", status: "failed", text: "" },
  ], 20, coloredTheme).split("\n");
  assert.ok(coloredLines.every((line) => cellWidth(line) <= 20));
  assert.ok(coloredLines[0]?.startsWith(coloredTheme.codes.userMessage));
  assert.ok(coloredLines.some((line) => line.includes(coloredTheme.codes.working)));
  assert.ok(coloredLines.some((line) => line.includes(coloredTheme.codes.success)));
  assert.ok(coloredLines.some((line) => line.includes(coloredTheme.codes.error)));
  assert.ok(coloredLines.every((line) => !line.includes(coloredTheme.codes.toolRunning)));
  assert.equal(coloredTheme.codes.assistant, coloredTheme.codes.code);
});

test("thinking level changes the released composer separator accent", () => {
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
  assert.ok(frame.text.includes(theme.codes.editorActive));
  assert.ok(frame.text.includes(theme.codes.warning));
});

test("operator transcript preferences hide reasoning runs and bound padded output", () => {
  const width = 32;
  const rendered = renderTranscript([
    { id: "r1", kind: "reasoning", text: "secret one", expanded: true },
    { id: "r2", kind: "reasoning", text: "secret two", expanded: true },
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
  assert.ok(frame.text.split("\n").some((line) => line.startsWith("   draft")));
  assert.ok((frame.cursor?.column ?? 0) >= 3);
});
