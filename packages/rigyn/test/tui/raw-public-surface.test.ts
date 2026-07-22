import assert from "node:assert/strict";
import test from "node:test";
import {
  Editor as PackageEditor,
  StdinBuffer as PackageStdinBuffer,
  TUI as PackageTUI,
  wrapTextWithAnsi as packageWrapTextWithAnsi,
} from "@rigyn/terminal";
import {
  CURSOR_MARKER,
  Editor,
  Image,
  StdinBuffer,
  TUI,
  Text,
  encodeKitty,
  fuzzyMatch,
  getPngDimensions,
  matchesKey,
  parseKey,
  setCapabilities,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type SelectListTheme,
  type Terminal,
} from "../../src/tui/index.js";
import { stripAnsi } from "../../src/tui/unicode.js";

class MemoryTerminal implements Terminal {
  columns = 40;
  rows = 12;
  kittyProtocolActive = false;
  output = "";
  input: ((data: string) => void) | undefined;
  resize: (() => void) | undefined;
  cursorVisible = true;
  start(onInput: (data: string) => void, onResize: () => void): void { this.input = onInput; this.resize = onResize; }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  moveBy(): void {}
  hideCursor(): void { this.cursorVisible = false; }
  showCursor(): void { this.cursorVisible = true; }
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

class FocusProbe implements Component {
  focused = false;
  received: string[] = [];
  render(): string[] { return [this.focused ? `${CURSOR_MARKER}focused` : "idle"]; }
  handleInput(data: string): void { this.received.push(data); }
  invalidate(): void {}
}

const identity = (value: string) => value;
const selectTheme: SelectListTheme = {
  selectedPrefix: identity,
  selectedText: identity,
  description: identity,
  scrollInfo: identity,
  noMatch: identity,
};
const editorTheme: EditorTheme = { borderColor: identity, selectList: selectTheme };

test("rigyn raw UI exports delegate to the terminal package", () => {
  assert.equal(Editor, PackageEditor);
  assert.equal(StdinBuffer, PackageStdinBuffer);
  assert.equal(TUI, PackageTUI);
  assert.equal(wrapTextWithAnsi, packageWrapTextWithAnsi);
});

test("raw input listeners rewrite sequentially and may consume before focused input", () => {
  const terminal = new MemoryTerminal();
  const tui = new TUI(terminal);
  const probe = new FocusProbe();
  tui.addChild(probe);
  tui.setFocus(probe);
  const seen: string[] = [];
  tui.addInputListener((data) => { seen.push(`one:${data}`); return { data: `${data}b` }; });
  tui.addInputListener((data) => { seen.push(`two:${data}`); return data === "xb" ? { consume: true } : { data: `${data}c` }; });
  tui.start();
  terminal.input?.("a");
  terminal.input?.("x");
  assert.deepEqual(seen, ["one:a", "two:ab", "one:x", "two:xb"]);
  assert.deepEqual(probe.received, ["abc"]);
  assert.equal(tui.getShowHardwareCursor(), false);
  assert.equal(terminal.cursorVisible, false);
});

test("cursor markers are stripped from output and overlays own focus directly", () => {
  const terminal = new MemoryTerminal();
  const tui = new TUI(terminal);
  const base = new FocusProbe();
  const overlay = new FocusProbe();
  tui.addChild(base);
  tui.setFocus(base);
  const handle = tui.showOverlay(overlay, { width: 12, anchor: "top-left" });
  assert.equal(base.focused, false);
  assert.equal(overlay.focused, true);
  assert.equal(handle.isFocused(), true);
  tui.start();
  tui.requestRender(true);
  assert.equal(terminal.output.includes(CURSOR_MARKER), false);
  handle.unfocus({ target: base });
  assert.equal(base.focused, true);
  handle.focus();
  handle.setHidden(true);
  assert.equal(handle.isHidden(), true);
  assert.equal(base.focused, true);
});

test("editor makes only pastes above ten lines or one thousand characters atomic", () => {
  const tui = new TUI(new MemoryTerminal());
  const editor = new Editor(tui, editorTheme);
  editor.handleInput(`\u001b[200~${"x".repeat(1_000)}\u001b[201~`);
  assert.equal(editor.getText(), "x".repeat(1_000));
  editor.setText("");
  editor.handleInput(`\u001b[200~${"x".repeat(1_001)}\u001b[201~`);
  assert.match(editor.getText(), /^\[paste #1 1001 chars\]$/u);
  assert.equal(editor.getExpandedText(), "x".repeat(1_001));
  editor.setText("");
  const elevenLines = Array.from({ length: 11 }, (_, index) => String(index)).join("\n");
  editor.handleInput(`\u001b[200~${elevenLines}\u001b[201~`);
  assert.match(editor.getText(), /^\[paste #1 \+11 lines\]$/u);
  assert.equal(editor.getExpandedText(), elevenLines);
});

test("stdin buffering preserves fragmented escapes and bracketed paste", () => {
  const buffer = new StdinBuffer({ timeout: 20 });
  const data: string[] = [];
  const pastes: string[] = [];
  buffer.on("data", (value) => data.push(value));
  buffer.on("paste", (value) => pastes.push(value));
  buffer.process("\u001b[");
  buffer.process("1;5");
  buffer.process("D");
  buffer.process("\u001b[200~hello");
  buffer.process(" world\u001b[201~");
  assert.deepEqual(data, ["\u001b[1;5D"]);
  assert.deepEqual(pastes, ["hello world"]);
  buffer.process("\u001b[");
  assert.equal(buffer.getBuffer(), "\u001b[");
  assert.deepEqual(buffer.flush(), ["\u001b["]);
  assert.deepEqual(data, ["\u001b[1;5D"]);
  buffer.process("\u001b[97u");
  buffer.process("a");
  assert.deepEqual(data, ["\u001b[1;5D", "\u001b[97u"]);
  buffer.process("\u001b[");
  buffer.clear();
  assert.equal(buffer.getBuffer(), "");
  buffer.destroy();
});

test("key parsing and cell wrapping handle ANSI, OSC 8, CJK, emoji, Thai and Lao", () => {
  assert.equal(parseKey("\u001b[99;5u"), "ctrl+c");
  assert.equal(matchesKey("\u001b[99;5u", "ctrl+c"), true);
  assert.equal(fuzzyMatch("codex52", "gpt-5.2-codex").matches, true);
  const decorated = "\u001b[31m界🙂\u001b[0m \u001b]8;;https://example.test\u001b\\ไทยລາວ\u001b]8;;\u001b\\";
  assert.equal(visibleWidth(CURSOR_MARKER), 0);
  assert.equal(visibleWidth(decorated), visibleWidth("界🙂 ไทยລາວ"));
  const wrapped = wrapTextWithAnsi(decorated, 4);
  assert.ok(wrapped.length >= 3);
  assert.equal(stripAnsi(wrapped.join("")), "界🙂ไทยລາວ");
  assert.ok(wrapped.every((line) => visibleWidth(line) <= 4));
});

test("raw text and image helpers are directly consumable", () => {
  assert.deepEqual(new Text("hello", 0, 0).render(3).map(stripAnsi), ["hel", "lo "]);
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(20, 16);
  png.writeUInt32BE(10, 20);
  const data = png.toString("base64");
  assert.deepEqual(getPngDimensions(data), { widthPx: 20, heightPx: 10 });
  assert.match(encodeKitty(data, { columns: 2, rows: 1, imageId: 7 }), /a=T,f=100,q=2,c=2,r=1,i=7/u);
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  const image = new Image(data, "image/png", { fallbackColor: identity }, { maxWidthCells: 2, maxHeightCells: 1, imageId: 7 });
  assert.match(image.render(4).join(""), /\u001b_Ga=T,f=100,q=2,C=1,c=2,r=1,i=7/u);
  setCapabilities({ images: null, trueColor: true, hyperlinks: true });
});
