import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import * as api from "../dist/index.js";
import {
  Box,
  Editor,
  Input,
  KeybindingsManager,
  ProcessTerminal,
  SelectList,
  SettingsList,
  StdinBuffer,
  TUI,
  TUI_KEYBINDINGS,
  Text,
  TruncatedText,
  calculateImageCellSize,
  decodeKittyPrintable,
  decodePrintableKey,
  detectCapabilities,
  encodeKitty,
  getCapabilities,
  isImageLine,
  isKeyRelease,
  isKeyRepeat,
  normalizeTerminalOutput,
  parseKey,
  resetCapabilitiesCache,
  setCapabilities,
  visibleWidth,
} from "../dist/index.js";
import { VirtualTerminal } from "./virtual-terminal-shim.mjs";

const runtimeExports = [
  "Box", "CURSOR_MARKER", "CancellableLoader", "CombinedAutocompleteProvider", "Container", "Editor", "Image", "Input", "Key",
  "KeybindingsManager", "Loader", "Markdown", "ProcessTerminal", "SelectList", "SettingsList", "Spacer", "StdinBuffer", "TUI",
  "TUI_KEYBINDINGS", "Text", "TruncatedText", "allocateImageId", "calculateImageCellSize", "calculateImageRows", "decodeKittyPrintable", "decodePrintableKey", "deleteAllKittyImages",
  "deleteKittyImage", "detectCapabilities", "encodeITerm2", "encodeKitty", "fuzzyFilter", "fuzzyMatch", "getCapabilities",
  "getCellDimensions", "getGifDimensions", "getImageDimensions", "getJpegDimensions", "getKeybindings", "getPngDimensions",
  "getWebpDimensions", "hyperlink", "imageFallback", "isFocusable", "isImageLine", "isKeyRelease", "isKeyRepeat", "isKittyProtocolActive", "isOsc11BackgroundColorResponse",
  "matchesKey", "normalizeTerminalOutput", "parseKey", "parseOsc11BackgroundColor", "parseTerminalColorSchemeReport", "renderImage", "resetCapabilitiesCache",
  "setCapabilities", "setCellDimensions", "setKeybindings", "setKittyProtocolActive", "sliceByColumn", "truncateToWidth",
  "visibleWidth", "wrapTextWithAnsi",
].sort();

const plainSelectTheme = {
  selectedPrefix: (value) => value,
  selectedText: (value) => value,
  description: (value) => value,
  scrollInfo: (value) => value,
  noMatch: (value) => value,
};
const plainEditorTheme = { borderColor: (value) => value, selectList: plainSelectTheme };

function editorFixture() {
  const terminal = new VirtualTerminal(60, 12);
  const tui = new TUI(terminal);
  return { editor: new Editor(tui, plainEditorTheme), terminal, tui };
}

async function withEnvironment(values, action) {
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    resetCapabilitiesCache();
    return await action();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetCapabilitiesCache();
  }
}

describe("published module contract", () => {
  it("keeps the intended runtime entry points explicit", () => {
    assert.deepEqual(Object.keys(api).sort(), runtimeExports);
  });

  it("publishes compatibility helpers and constructor option types", async () => {
    assert.equal(decodePrintableKey("\x1b[27;2;69~"), "E");
    assert.deepEqual(
      calculateImageCellSize({ widthPx: 800, heightPx: 600 }, 40, undefined, { widthPx: 10, heightPx: 20 }),
      { columns: 40, rows: 15 },
    );
    assert.equal(isImageLine(`prefix\x1b_Ga=T;payload\x1b\\suffix`), true);
    assert.equal(isImageLine("ordinary text"), false);
    assert.equal(normalizeTerminalOutput("\t\u0e33"), "   \u0e4d\u0e32");

    const declarations = await readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8");
    for (const name of ["ImageCellSize", "ProcessTerminalOptions", "SettingsListOptions"]) {
      assert.match(declarations, new RegExp(`\\b${name}\\b`, "u"));
    }
    assert.equal(typeof ProcessTerminal, "function");
  });

  it("declares every native release target exactly once", async () => {
    const manifest = JSON.parse(await readFile(new URL("../native/targets.json", import.meta.url), "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.deepEqual(
      manifest.targets.map((target) => `${target.platform}-${target.arch}`).sort(),
      ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"],
    );
    for (const target of manifest.targets) {
      assert.match(target.source, /^native\/(darwin|win32)\/src\/[\w-]+\.c$/u);
      assert.match(target.output, /^native\/(darwin|win32)\/prebuilds\/(darwin|win32)-(arm64|x64)\/[\w-]+\.node$/u);
    }
  });
});

describe("keyboard and input protocol matrix", () => {
  it("decodes legacy, extended, modified, repeat, and release input", () => {
    const cases = new Map([
      ["\x1b[A", "up"],
      ["\x1b[1;5C", "ctrl+right"],
      ["\x1b[1;3D", "alt+left"],
      ["\x1b[97;3u", "alt+a"],
      ["\x1b[57399u", "0"],
      ["\x1b[57419u", "up"],
      ["\x1b[27;6;97~", "shift+ctrl+a"],
    ]);
    for (const [sequence, key] of cases) assert.equal(parseKey(sequence), key, sequence);
    assert.equal(decodeKittyPrintable("\x1b[97:65;2u"), "A");
    assert.equal(isKeyRepeat("\x1b[97;1:2u"), true);
    assert.equal(isKeyRelease("\x1b[97;1:3u"), true);
  });

  it("keeps user binding conflicts visible without removing defaults", () => {
    const manager = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.editor.cursorUp": "ctrl+p",
      "tui.editor.cursorDown": "ctrl+p",
    });
    assert.equal(manager.matches("\x10", "tui.editor.cursorUp"), true);
    assert.equal(manager.matches("\x1b[A", "tui.editor.cursorUp"), false);
    assert.deepEqual(manager.getConflicts(), [{ key: "ctrl+p", keybindings: ["tui.editor.cursorUp", "tui.editor.cursorDown"] }]);
  });

  it("splits batched controls and preserves bracketed paste as one event", () => {
    const buffer = new StdinBuffer({ timeout: 5 });
    const data = [];
    const pastes = [];
    buffer.on("data", (value) => data.push(value));
    buffer.on("paste", (value) => pastes.push(value));
    buffer.process("a\x1b[");
    buffer.process("A\x1b[97;1:3u");
    buffer.process("\x1b[200~alpha\n");
    buffer.process("beta\x1b[201~z");
    assert.deepEqual(data, ["a", "\x1b[A", "\x1b[97;1:3u", "z"]);
    assert.deepEqual(pastes, ["alpha\nbeta"]);
    buffer.destroy();
  });
});

describe("editor state contract", () => {
  it("keeps kill, yank, yank-pop, and undo operations coherent", () => {
    const { editor } = editorFixture();
    editor.setText("alpha beta gamma");
    editor.handleInput("\x17");
    editor.handleInput("\x17");
    assert.equal(editor.getText(), "alpha ");
    editor.handleInput("\x19");
    assert.equal(editor.getText(), "alpha beta gamma");
    editor.handleInput("\x1by");
    assert.equal(editor.getText(), "alpha beta gamma");
    editor.handleInput("\x1f");
    assert.equal(editor.getText(), "alpha ");
  });

  it("treats large paste data atomically while submitting literal content", () => {
    const { editor } = editorFixture();
    const pasted = `${"界".repeat(700)}\n${"x".repeat(700)}`;
    editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
    assert.match(editor.getText(), /^\[paste #1 /u);
    assert.equal(editor.getExpandedText(), pasted);
    editor.handleInput("\x1f");
    assert.equal(editor.getText(), "");
  });

  it("preserves a draft across history traversal", () => {
    const { editor } = editorFixture();
    editor.addToHistory("first");
    editor.addToHistory("second");
    editor.setText("draft");
    editor.handleInput("\x1b[A");
    assert.equal(editor.getText(), "draft");
    editor.handleInput("\x1b[A");
    assert.equal(editor.getText(), "second");
    editor.handleInput("\x1b[A");
    assert.equal(editor.getText(), "first");
    editor.handleInput("\x1b[B");
    editor.handleInput("\x1b[B");
    assert.equal(editor.getText(), "draft");
  });

  it("keeps rendered rows inside the terminal width after a resize", () => {
    const { editor } = editorFixture();
    editor.focused = true;
    editor.setText("Latin words 与宽字符 and emoji 👨‍👩‍👧‍👦 across several visual lines");
    for (const width of [40, 17, 8, 3]) {
      const lines = editor.render(width);
      assert.equal(lines.every((line) => visibleWidth(line) <= width), true, `width ${width}`);
    }
  });
});

describe("components and focus routing", () => {
  it("renders bounded list and text components", () => {
    const box = new Box(1, 1);
    box.addChild(new Text("hello world", 0, 0));
    assert.equal(box.render(10).every((line) => visibleWidth(line) <= 10), true);
    assert.equal(visibleWidth(new TruncatedText("a long status value", 1, 1).render(9)[1]), 9);

    const list = new SelectList([
      { value: "one", label: "One", description: "first" },
      { value: "two", label: "Two", description: "second" },
    ], 2, plainSelectTheme);
    list.handleInput("\x1b[B");
    assert.equal(list.getSelectedItem()?.value, "two");
    assert.equal(list.render(18).every((line) => visibleWidth(line) <= 18), true);
  });

  it("cycles ordinary settings and invokes cancellation", () => {
    const changes = [];
    let cancelled = false;
    const theme = {
      label: (value) => value,
      value: (value) => value,
      description: (value) => value,
      cursor: "> ",
      hint: (value) => value,
    };
    const settings = new SettingsList([
      { id: "mode", label: "Mode", currentValue: "a", values: ["a", "b"] },
    ], 4, theme, (id, value) => changes.push([id, value]), () => { cancelled = true; });
    settings.handleInput("\r");
    assert.deepEqual(changes, [["mode", "b"]]);
    settings.handleInput("\x1b");
    assert.equal(cancelled, true);
  });

  it("routes transformed input and ignores key releases unless requested", async () => {
    const terminal = new VirtualTerminal(30, 6);
    const tui = new TUI(terminal);
    const received = [];
    const component = { focused: false, invalidate() {}, render: () => ["ready"], handleInput: (value) => received.push(value) };
    tui.addChild(component);
    tui.setFocus(component);
    tui.addInputListener((value) => value === "a" ? { data: "b" } : undefined);
    tui.start();
    terminal.sendInput("a");
    terminal.sendInput("\x1b[97;1:3u");
    await terminal.waitForRender();
    assert.deepEqual(received, ["b"]);
    component.wantsKeyRelease = true;
    terminal.sendInput("\x1b[97;1:3u");
    assert.deepEqual(received, ["b", "\x1b[97;1:3u"]);
    tui.stop();
  });
});

describe("terminal capability contract", () => {
  it("uses explicit capability overrides until the detector is reset", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    assert.equal(getCapabilities().images, "kitty");
    assert.match(encodeKitty("AAAA", { columns: 2, rows: 3, imageId: 7, moveCursor: false }), /a=T,f=100,q=2,C=1,c=2,r=3,i=7/u);
    resetCapabilitiesCache();
  });

  it("keeps multiplexers conservative and recognizes known terminals", async () => {
    await withEnvironment({ TMUX: "1", TERM: "xterm-256color", TERM_PROGRAM: undefined, COLORTERM: undefined }, () => {
      assert.deepEqual(detectCapabilities(() => false), { images: null, trueColor: false, hyperlinks: false });
      assert.deepEqual(detectCapabilities(() => true), { images: null, trueColor: false, hyperlinks: true });
    });
    await withEnvironment({ TMUX: undefined, TERM: "xterm-kitty", TERM_PROGRAM: "ghostty", COLORTERM: "truecolor" }, () => {
      assert.deepEqual(detectCapabilities(), { images: "kitty", trueColor: true, hyperlinks: true });
    });
  });
});
