import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Input,
  KeybindingsManager,
  Editor,
  Markdown,
  StdinBuffer,
  TUI,
  TUI_KEYBINDINGS,
  calculateImageCellSize,
  encodeKitty,
  isImageLine,
  resetCapabilitiesCache,
  setCapabilities,
  setCellDimensions,
  visibleWidth,
  wrapTextWithAnsi,
} from "../dist/index.js";
import { cellWidth, sanitizeTerminalText } from "../dist/internal-unicode.js";
import { VirtualTerminal } from "./virtual-terminal-shim.mjs";

const identity = (value) => value;
const selectTheme = {
  selectedPrefix: identity,
  selectedText: identity,
  description: identity,
  scrollInfo: identity,
  noMatch: identity,
};
const editorTheme = { borderColor: identity, selectList: selectTheme };
const markdownTheme = {
  heading: (value) => `\x1b[1;36m${value}\x1b[0m`,
  link: (value) => `\x1b[34m${value}\x1b[39m`,
  linkUrl: identity,
  code: (value) => `\x1b[33m${value}\x1b[39m`,
  codeBlock: (value) => `\x1b[32m${value}\x1b[39m`,
  codeBlockBorder: identity,
  quote: (value) => `\x1b[3m${value}\x1b[23m`,
  quoteBorder: identity,
  hr: identity,
  listBullet: identity,
  bold: (value) => `\x1b[1m${value}\x1b[22m`,
  italic: (value) => `\x1b[3m${value}\x1b[23m`,
  strikethrough: (value) => `\x1b[9m${value}\x1b[29m`,
  underline: (value) => `\x1b[4m${value}\x1b[24m`,
};

function editorFixture(columns = 60, rows = 12) {
  const terminal = new VirtualTerminal(columns, rows);
  const tui = new TUI(terminal);
  return { editor: new Editor(tui, editorTheme), terminal, tui };
}

class MutableComponent {
  focused = false;
  inputs = [];

  constructor(lines) {
    this.lines = lines;
  }

  render() {
    return this.lines;
  }

  invalidate() {}

  handleInput(value) {
    this.inputs.push(value);
  }
}

describe("deep terminal semantics", () => {
  it("edits a prefilled input at its tail and keeps word deletion reversible", () => {
    const input = new Input();
    input.setValue("alpha beta");
    input.handleInput("!");
    assert.equal(input.getValue(), "alpha beta!");

    input.handleInput("\x17");
    assert.equal(input.getValue(), "alpha beta");
    input.handleInput("\x1f");
    assert.equal(input.getValue(), "alpha beta!");

    const wordNavigation = new Input();
    wordNavigation.setValue("alpha beta");
    wordNavigation.handleInput("\x17");
    assert.equal(wordNavigation.getValue(), "alpha ");
    wordNavigation.handleInput("\x19");
    assert.equal(wordNavigation.getValue(), "alpha beta");
    wordNavigation.handleInput("\x1b[1;5D");
    wordNavigation.handleInput("X");
    assert.equal(wordNavigation.getValue(), "alpha Xbeta");
  });

  it("reports conflicts for modifier aliases that dispatch identically", () => {
    const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.editor.cursorUp": "ctrl+shift+a",
      "tui.editor.cursorDown": "shift+ctrl+a",
    });
    assert.equal(bindings.matches("\x1b[97;6u", "tui.editor.cursorUp"), true);
    assert.equal(bindings.matches("\x1b[97;6u", "tui.editor.cursorDown"), true);
    assert.deepEqual(bindings.getConflicts(), [{
      key: "shift+ctrl+a",
      keybindings: ["tui.editor.cursorUp", "tui.editor.cursorDown"],
    }]);
  });

  it("keeps undo boundaries and kill-ring rotation independent", () => {
    const { editor } = editorFixture();
    for (const character of "alpha beta") editor.handleInput(character);
    editor.handleInput("\x1f");
    assert.equal(editor.getText(), "alpha");
    editor.handleInput("\x1f");
    assert.equal(editor.getText(), "");

    for (const value of ["red", "blue"]) {
      editor.setText(value);
      editor.handleInput("\x17");
    }
    editor.setText("<>");
    editor.handleInput("\x01");
    editor.handleInput("\x1b[C");
    editor.handleInput("\x19");
    assert.equal(editor.getText(), "<blue>");
    editor.handleInput("\x1by");
    assert.equal(editor.getText(), "<red>");
    editor.handleInput("\x1f");
    assert.equal(editor.getText(), "<blue>");
    editor.handleInput("\x1f");
    assert.equal(editor.getText(), "<>");
  });

  it("moves by word across ASCII and fullwidth punctuation", () => {
    const { editor } = editorFixture();
    editor.setText("alpha.你好，omega");
    for (const col of [9, 8, 6, 5, 0]) {
      editor.handleInput("\x1b[1;5D");
      assert.deepEqual(editor.getCursor(), { line: 0, col });
    }
    for (const col of [5, 6, 8, 9, 14]) {
      editor.handleInput("\x1b[1;5C");
      assert.deepEqual(editor.getCursor(), { line: 0, col });
    }
  });

  it("routes composed text and printable keyboard protocols without release or Alt leakage", () => {
    const { editor, terminal, tui } = editorFixture();
    tui.addChild(editor);
    tui.setFocus(editor);
    tui.start();

    terminal.sendInput("\x1b[69;2u");
    terminal.sendInput("\x1b[27;2;196~");
    terminal.sendInput("かな");
    terminal.sendInput("\x1b[97;1:3u");
    terminal.sendInput("\x1ba");
    terminal.sendInput("\x1b[97;3u");

    assert.equal(editor.getText(), "EÄかな");
    tui.stop();
  });

  it("reassembles mixed input and suppresses only a matching keyboard echo", () => {
    const buffer = new StdinBuffer({ timeout: 5 });
    const values = [];
    buffer.on("data", (value) => values.push(value));
    buffer.process("\x1b\x1b[");
    buffer.process("1;5D\x1b[233u");
    buffer.process("éx");
    assert.deepEqual(values, ["\x1b", "\x1b[1;5D", "\x1b[233u", "x"]);
    buffer.destroy();
  });

  it("uses differential updates, then clears stale rows after shrink and redraws on resize", async () => {
    const terminal = new VirtualTerminal(18, 5);
    const tui = new TUI(terminal);
    const component = new MutableComponent(["north", "east", "south", "west"]);
    tui.addChild(component);
    tui.start();
    await terminal.waitForRender();
    const initialRedraws = tui.fullRedraws;

    component.lines[1] = "EAST";
    tui.requestRender();
    await terminal.waitForRender();
    assert.equal(tui.fullRedraws, initialRedraws);
    assert.equal(terminal.getViewport()[1], "EAST");

    component.lines = ["solo"];
    tui.requestRender();
    await terminal.waitForRender();
    assert.deepEqual(terminal.getViewport(), ["solo", "", "", "", ""]);

    terminal.resize(12, 4);
    await terminal.waitForRender();
    assert.ok(tui.fullRedraws > initialRedraws);
    assert.deepEqual(terminal.getViewport(), ["solo", "", "", ""]);
    tui.stop();
  });

  it("clears the inverted software cursor before restoring the hardware cursor on shutdown", async () => {
    const { editor, terminal, tui } = editorFixture(18, 5);
    editor.setText("software cursor");
    tui.addChild(editor);
    tui.setFocus(editor);
    tui.start();
    await terminal.waitForRender();
    terminal.writes.length = 0;

    tui.stop();

    const output = terminal.writes.join("");
    assert.ok(output.indexOf(" ") >= 0);
    assert.ok(output.indexOf(" ") < output.indexOf("\x1b[?25h"));
  });

  it("wraps CRLF and CR lines without losing active ANSI styles", () => {
    assert.deepEqual(
      wrapTextWithAnsi("\x1b[31mred\r\ngreen\rtail\x1b[0m", 20),
      ["\x1b[31mred", "\x1b[31mgreen", "\x1b[31mtail\x1b[0m"],
    );
  });

  it("keeps stacked overlay focus and underline state isolated", async () => {
    const terminal = new VirtualTerminal(20, 4);
    const tui = new TUI(terminal);
    const base = new MutableComponent(["\x1b[4mabcdefghijklmnopqrst\x1b[24m"]);
    const passive = new MutableComponent(["111111"]);
    const active = new MutableComponent(["ZZ"]);
    tui.addChild(base);
    tui.setFocus(base);
    tui.showOverlay(passive, { nonCapturing: true, width: 6, row: 0, col: 3 });
    const handle = tui.showOverlay(active, { width: 4, row: 0, col: 5 });
    tui.start();
    await terminal.waitForRender();

    terminal.sendInput("x");
    assert.deepEqual(active.inputs, ["x"]);
    const line = terminal.xterm.buffer.active.getLine(0);
    assert.equal(line.getCell(5).isUnderline(), 0);
    assert.equal(line.getCell(6).isUnderline(), 0);
    assert.equal(line.getCell(10).isUnderline(), 1);

    handle.hide();
    terminal.sendInput("y");
    assert.deepEqual(base.inputs, ["y"]);
    assert.deepEqual(passive.inputs, []);
    tui.stop();
  });

  it("reflows after resize and revives a temporarily hidden overlay on later input", async () => {
    const terminal = new VirtualTerminal(16, 4);
    const tui = new TUI(terminal);
    const base = new MutableComponent(["base row", "second"]);
    const overlay = new MutableComponent(["panel"]);
    tui.addChild(base);
    tui.setFocus(base);
    tui.showOverlay(overlay, { row: 0, col: 0, width: 7, visible: (width) => width >= 12 });
    tui.start();
    await terminal.waitForRender();
    assert.equal(terminal.getViewport()[0].startsWith("panel"), true);

    terminal.resize(9, 3);
    await terminal.waitForRender();
    assert.deepEqual(terminal.getViewport(), ["base row", "second", ""]);
    terminal.sendInput("b");
    assert.deepEqual(base.inputs, ["b"]);

    terminal.resize(16, 4);
    await terminal.waitForRender();
    terminal.sendInput("o");
    assert.deepEqual(overlay.inputs, ["o"]);
    assert.ok(tui.fullRedraws >= 3);
    tui.stop();
  });

  it("keeps streaming Unicode widths stable and strips untrusted editor controls", () => {
    assert.equal(visibleWidth("🇨"), 2);
    assert.equal(visibleWidth("🇨🇦"), 2);
    assert.equal(visibleWidth("e\u0301\u0e33\u0eb3"), 3);
    assert.equal(cellWidth("界👩🏽‍💻"), 4);
    assert.equal(
      sanitizeTerminalText("ok\x1b[2J\x1b]0;owned\x07\nnext\0\tvalue"),
      "ok\nnext    value",
    );

    const { editor } = editorFixture();
    editor.setText("safe\x1b[2J\x07 text");
    assert.equal(editor.getText(), "safe text");
  });

  it("keeps styled tables and hyperlinks within terminal columns", () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    try {
      const source = "| Item | Detail |\n| --- | --- |\n| `token` | https://example.com/a/very/long/path |";
      const lines = new Markdown(source, 0, 0, markdownTheme).render(22);
      assert.equal(lines.every((line) => visibleWidth(line) <= 22), true);
      const tableRows = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/gu, "")).filter((line) => line.startsWith("│"));
      assert.ok(tableRows.length > 1);
      assert.equal(tableRows.every((line) => line.split("│").length === 4), true);

      const link = "\x1b]8;;https://example.com\x1b\\abcdefgh\x1b]8;;\x1b\\";
      const wrapped = wrapTextWithAnsi(link, 3);
      assert.equal(wrapped.length, 3);
      assert.equal(wrapped.every((line) => visibleWidth(line) <= 3), true);
      assert.equal(wrapped.every((line) => line.includes("\x1b]8;;\x1b\\")), true);
    } finally {
      resetCapabilitiesCache();
    }
  });

  it("renders nested quote formatting without activating unsafe link targets", () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    try {
      const source = "> **bold** and `code`\n> [label](javascript:alert(1))";
      const lines = new Markdown(source, 0, 0, markdownTheme).render(14);
      assert.equal(lines.every((line) => visibleWidth(line) <= 14), true);
      assert.equal(lines.join("\n").includes("javascript:"), false);
      assert.equal(lines.join("\n").includes("label"), true);
    } finally {
      resetCapabilitiesCache();
    }
  });

  it("bounds image geometry and terminates chunked Kitty transfers", () => {
    setCellDimensions({ widthPx: 10, heightPx: 20 });
    try {
      assert.deepEqual(calculateImageCellSize({ widthPx: 400, heightPx: 800 }, 20, 5), { columns: 5, rows: 5 });
      const sequence = encodeKitty("A".repeat(8_300), { columns: 5, rows: 5, imageId: 17, moveCursor: false });
      assert.equal((sequence.match(/\x1b_G/gu) ?? []).length, 3);
      assert.match(sequence, /a=T,f=100,q=2,C=1,c=5,r=5,i=17,m=1/u);
      assert.match(sequence, /\x1b_Gm=0;A+\x1b\\$/u);
    } finally {
      setCellDimensions({ widthPx: 9, heightPx: 18 });
    }
  });

  it("detects embedded image controls without mistaking ordinary text", () => {
    const kitty = `${"prefix".repeat(20_000)}\x1b_Ga=T,f=100;AAAA\x1b\\tail`;
    const inline = `before\x1b]1337;File=inline=1:AAAA\x07after`;
    assert.equal(isImageLine(kitty), true);
    assert.equal(isImageLine(inline), true);
    assert.equal(isImageLine("notes/1337/File_G/image.txt"), false);
    assert.equal(isImageLine("\x1b[31mordinary styled output\x1b[0m"), false);
  });
});
