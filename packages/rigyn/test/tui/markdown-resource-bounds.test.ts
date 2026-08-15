import assert from "node:assert/strict";
import test from "node:test";
import { renderTranscript } from "../../src/tui/layout.js";
import { renderMarkdownMessageLines } from "../../src/tui/markdown.js";
import { createTheme } from "../../src/tui/theme.js";
import type { TranscriptEntry } from "../../src/tui/types.js";
import { cellWidth, stripAnsi } from "../../src/tui/unicode.js";

const PATHOLOGICAL_LINE_BYTES = 2 * 1024 * 1024;

function exactPathologicalLine(head: string, tail: string, fill = "x"): string {
  const remaining = PATHOLOGICAL_LINE_BYTES - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  const fillBytes = Buffer.byteLength(fill, "utf8");
  const value = `${head}${fill.repeat(Math.floor(remaining / fillBytes))}${"x".repeat(remaining % fillBytes)}${tail}`;
  assert.equal(Buffer.byteLength(value, "utf8"), PATHOLOGICAL_LINE_BYTES);
  return value;
}

test("a pathological single Markdown line is sampled before parsing and wrapping", () => {
  const source = exactPathologicalLine(
    "discarded-head ",
    " \u001b]8;;https://owned.test\u0007retained-tail-\u754c\ud83d\ude42\u001b]8;;\u0007",
    "\ud83d\ude42",
  );
  const started = process.cpuUsage();
  const lines = renderMarkdownMessageLines("", source, 80, "assistant");
  const elapsed = process.cpuUsage(started);
  const elapsedMs = (elapsed.user + elapsed.system) / 1_000;
  const visible = lines.map((line) => line.text).join("\n");

  assert.match(visible, /^\u2026 earlier Markdown line bytes omitted \u2026$/mu);
  assert.match(visible, /retained-tail-\u754c\ud83d\ude42$/u);
  assert.doesNotMatch(visible, /discarded-head|owned\.test|\u001b|\u0007|\ufffd/u);
  assert.ok(lines.length < 1_000, `sampled line unexpectedly rendered ${lines.length} rows`);
  assert.ok(lines.every((line) => cellWidth(line.text) <= 80));
  assert.ok(elapsedMs < 250, `cold Markdown render used ${elapsedMs.toFixed(1)}ms CPU`);
});

test("streaming assistant cache invalidates when a sampled Markdown tail changes", () => {
  const theme = createTheme("mono", { color: false, unicode: true });
  const entry: TranscriptEntry = {
    id: "sampled-streaming-assistant",
    kind: "assistant",
    text: exactPathologicalLine("discarded-first ", " first-tail"),
    streaming: true,
  };

  const first = stripAnsi(renderTranscript([entry], 80, theme));
  assert.match(first, /earlier Markdown line bytes omitted/u);
  assert.match(first, /first-tail/u);

  entry.text = exactPathologicalLine("discarded-second ", " second-tail", "y");
  const second = stripAnsi(renderTranscript([entry], 80, theme));
  assert.match(second, /earlier Markdown line bytes omitted/u);
  assert.match(second, /second-tail/u);
  assert.doesNotMatch(second, /first-tail/u);
});
