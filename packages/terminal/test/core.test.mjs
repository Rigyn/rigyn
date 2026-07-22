import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CombinedAutocompleteProvider,
  Container,
  CURSOR_MARKER,
  Editor,
  Input,
  Key,
  KeybindingsManager,
  Markdown,
  StdinBuffer,
  TUI,
  TUI_KEYBINDINGS,
  decodeKittyPrintable,
  fuzzyFilter,
  fuzzyMatch,
  getGifDimensions,
  getJpegDimensions,
  getPngDimensions,
  getWebpDimensions,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  parseKey,
  setCapabilities,
  setKittyProtocolActive,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "../dist/index.js";

class MemoryTerminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  writes = [];
  input;
  resize;
  start(input, resize) { this.input = input; this.resize = resize; }
  stop() {}
  async drainInput() {}
  write(data) { this.writes.push(data); }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}

const plainTheme = {
  borderColor: (value) => value,
  selectList: {
    selectedPrefix: (value) => value,
    selectedText: (value) => value,
    description: (value) => value,
    scrollInfo: (value) => value,
    noMatch: (value) => value,
  },
};

const markdownTheme = {
  heading: (value) => `<h>${value}</h>`,
  link: (value) => `<a>${value}</a>`,
  linkUrl: (value) => `<u>${value}</u>`,
  code: (value) => `<c>${value}</c>`,
  codeBlock: (value) => `<b>${value}</b>`,
  codeBlockBorder: (value) => value,
  quote: (value) => `<q>${value}</q>`,
  quoteBorder: (value) => value,
  hr: (value) => value,
  listBullet: (value) => value,
  bold: (value) => `<s>${value}</s>`,
  italic: (value) => `<i>${value}</i>`,
  strikethrough: (value) => `<x>${value}</x>`,
  underline: (value) => `<n>${value}</n>`,
};

function makeEditor() {
  const terminal = new MemoryTerminal();
  const tui = new TUI(terminal);
  return { editor: new Editor(tui, plainTheme), terminal, tui };
}

describe("keyboard protocols", () => {
  it("normalizes legacy aliases and modifiers", () => {
    assert.equal(parseKey("\r"), "enter");
    assert.equal(parseKey("\x1b[1;5D"), "ctrl+left");
    assert.equal(matchesKey("\x1b[1;3C", Key.alt("right")), true);
    assert.equal(matchesKey("\x01", Key.ctrl("a")), true);
  });

  it("understands CSI-u event types and printable payloads", () => {
    assert.equal(parseKey("\x1b[97;3u"), "alt+a");
    assert.equal(decodeKittyPrintable("\x1b[97:65;2u"), "A");
    assert.equal(isKeyRepeat("\x1b[97;1:2u"), true);
    assert.equal(isKeyRelease("\x1b[97;1:3u"), true);
  });

  it("switches newline interpretation with keyboard protocol state", () => {
    setKittyProtocolActive(false);
    assert.equal(parseKey("\n"), "enter");
    setKittyProtocolActive(true);
    assert.equal(parseKey("\n"), "shift+enter");
    setKittyProtocolActive(false);
  });

  it("resolves overrides and reports conflicting user bindings", () => {
    const manager = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.editor.cursorUp": "ctrl+p",
      "tui.editor.cursorDown": "ctrl+p",
    });
    assert.equal(manager.matches("\x10", "tui.editor.cursorUp"), true);
    assert.deepEqual(manager.getConflicts(), [{ key: "ctrl+p", keybindings: ["tui.editor.cursorUp", "tui.editor.cursorDown"] }]);
  });
});

describe("Unicode and ANSI layout", () => {
  it("measures grapheme clusters and ignores escape sequences", () => {
    assert.equal(visibleWidth("a界🙂"), 5);
    assert.equal(visibleWidth("\x1b[31mred\x1b[0m"), 3);
    assert.equal(visibleWidth("👨‍👩‍👧‍👦"), 2);
  });

  it("slices and truncates by terminal cells", () => {
    assert.equal(sliceByColumn("a界b", 1, 2, true), "界");
    assert.equal(visibleWidth(truncateToWidth("abcdef", 4)), 4);
  });

  it("wraps at a useful boundary and preserves active styles", () => {
    const lines = wrapTextWithAnsi("hello world", 8);
    assert.deepEqual(lines, ["hello", "world"]);
    const styled = wrapTextWithAnsi("\x1b[31mabcdef\x1b[0m", 3);
    assert.equal(styled.length, 2);
    assert.equal(styled.every((line) => visibleWidth(line) === 3), true);
  });
});

describe("fuzzy matching", () => {
  it("keeps match positions and stable candidate order", () => {
    assert.equal(fuzzyMatch("abc", "a_b_c").matches, true);
    assert.deepEqual(fuzzyFilter(["alpha", "alpine", "beta"], "alp", (value) => value), ["alpha", "alpine"]);
  });
});

describe("input framing", () => {
  it("joins fragmented control sequences", async () => {
    const buffer = new StdinBuffer({ timeout: 5 });
    const values = [];
    buffer.on("data", (value) => values.push(value));
    buffer.process("\x1b[");
    buffer.process("A");
    assert.deepEqual(values, ["\x1b[A"]);
    buffer.destroy();
  });

  it("emits bracketed paste as one payload", () => {
    const buffer = new StdinBuffer();
    const pastes = [];
    buffer.on("paste", (value) => pastes.push(value));
    buffer.process("\x1b[200~hello");
    buffer.process(" world\x1b[201~");
    assert.deepEqual(pastes, ["hello world"]);
    buffer.destroy();
  });
});

describe("editor behavior", () => {
  it("edits Unicode by grapheme and supports undo", () => {
    const { editor } = makeEditor();
    editor.handleInput("a");
    editor.handleInput("🙂");
    editor.handleInput("\x7f");
    assert.equal(editor.getText(), "a");
    editor.handleInput("\x1f");
    assert.equal(editor.getText(), "a🙂");
  });

  it("normalizes multiline input and exposes an independent line array", () => {
    const { editor } = makeEditor();
    editor.setText("one\r\ntwo\tthree");
    const lines = editor.getLines();
    lines[0] = "mutated";
    assert.equal(editor.getText(), "one\ntwo    three");
  });

  it("stores large paste compactly and expands it for submission", () => {
    const { editor } = makeEditor();
    const value = "x".repeat(1001);
    editor.handleInput(`\x1b[200~${value}\x1b[201~`);
    assert.match(editor.getText(), /^\[paste #1 1001 chars\]$/u);
    assert.equal(editor.getExpandedText(), value);
  });

  it("restores a deleted large-paste marker and payload as one undo step", () => {
    const { editor } = makeEditor();
    const value = Array.from({ length: 12 }, (_, index) => `private-${index}`).join("\n");
    editor.handleInput(`\x1b[200~${value}\x1b[201~`);
    editor.handleInput("\x7f");
    assert.equal(editor.getText(), "");

    editor.handleInput("\x1f");

    assert.match(editor.getText(), /^\[paste #1 \+12 lines\]$/u);
    assert.equal(editor.getExpandedText(), value);
  });

  it("browses saved prompts and restores the draft", () => {
    const { editor } = makeEditor();
    editor.addToHistory("older");
    editor.addToHistory("newer");
    editor.handleInput("\x1b[A");
    assert.equal(editor.getText(), "newer");
    editor.handleInput("\x1b[A");
    assert.equal(editor.getText(), "older");
    editor.handleInput("\x1b[B");
    editor.handleInput("\x1b[B");
    assert.equal(editor.getText(), "");
  });

  it("renders a bounded viewport and emits a cursor marker only when focused", () => {
    const { editor } = makeEditor();
    editor.setText("1234567890");
    assert.equal(editor.render(8).every((line) => visibleWidth(line) <= 8), true);
    editor.focused = true;
    assert.equal(editor.render(8).some((line) => line.includes(CURSOR_MARKER)), true);
  });
});

describe("single-line input", () => {
  it("uses one undo entry for a paste", () => {
    const input = new Input();
    input.handleInput("a");
    input.handleInput("\x1b[200~xyz\x1b[201~");
    input.handleInput("\x1f");
    assert.equal(input.getValue(), "a");
  });
});

describe("Markdown rendering", () => {
  it("normalizes ordered markers and produces nested indentation", () => {
    const value = new Markdown("1. alpha\n1. beta\n  - nested", 0, 0, markdownTheme).render(80).map((line) => line.trimEnd());
    assert.equal(value.some((line) => line.includes("1. alpha")), true);
    assert.equal(value.some((line) => line.includes("2. beta")), true);
    assert.equal(value.some((line) => line.includes("    - nested")), true);
  });

  it("renders bordered tables that stay inside the viewport", () => {
    const lines = new Markdown("| Name | Note |\n| --- | --- |\n| Ada | long description here |", 0, 0, markdownTheme).render(26);
    assert.equal(lines.some((line) => line.includes("┼")), true);
    assert.equal(lines.every((line) => visibleWidth(line) <= 26), true);
  });

  it("distinguishes strict strike syntax and safe hyperlinks", () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    const line = new Markdown("~~gone~~ ~kept~ [site](https://example.com)", 0, 0, markdownTheme).render(100).join("\n");
    assert.match(line, /<x>gone<\/x>/u);
    assert.match(line, /~kept~/u);
    assert.match(line, /https:\/\/example\.com/u);
  });
});

describe("images", () => {
  it("reads dimensions for supported image headers", () => {
    const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(7, 16); png.writeUInt32BE(9, 20);
    assert.deepEqual(getPngDimensions(png.toString("base64")), { widthPx: 7, heightPx: 9 });
    const gif = Buffer.alloc(10); gif.write("GIF89a", 0, "ascii"); gif.writeUInt16LE(3, 6); gif.writeUInt16LE(4, 8);
    assert.deepEqual(getGifDimensions(gif.toString("base64")), { widthPx: 3, heightPx: 4 });
    assert.equal(getJpegDimensions("bad"), null);
    assert.equal(getWebpDimensions("bad"), null);
  });
});

describe("autocomplete", () => {
  it("completes command names and delegates argument completion", async () => {
    const provider = new CombinedAutocompleteProvider([
      { name: "model", getArgumentCompletions: () => [{ value: "fast", label: "fast" }] },
    ], process.cwd());
    const controller = new AbortController();
    const command = await provider.getSuggestions(["/mo"], 0, 3, { signal: controller.signal });
    assert.equal(command?.items[0]?.value, "model");
    const argument = await provider.getSuggestions(["/model f"], 0, 8, { signal: controller.signal });
    assert.equal(argument?.items[0]?.value, "fast");
  });
});

describe("composition and renderer", () => {
  it("renders containers and a capturing overlay through synchronized output", async () => {
    const terminal = new MemoryTerminal();
    terminal.columns = 20;
    terminal.rows = 8;
    const tui = new TUI(terminal);
    const base = { render: () => ["base"], invalidate() {} };
    const overlay = { render: () => ["overlay"], invalidate() {} };
    tui.addChild(base);
    tui.showOverlay(overlay, { width: 9, anchor: "center" });
    tui.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    tui.stop();
    assert.equal(terminal.writes.some((value) => value.includes("\x1b[?2026h") && value.includes("overlay")), true);
  });

  it("composes child output in order", () => {
    const container = new Container();
    container.addChild({ render: () => ["a"], invalidate() {} });
    container.addChild({ render: () => ["b"], invalidate() {} });
    assert.deepEqual(container.render(10), ["a", "b"]);
  });
});
