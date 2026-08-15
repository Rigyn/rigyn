import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  CombinedAutocompleteProvider,
  cellWidth,
  Container,
  CURSOR_MARKER,
  Editor,
  Image,
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
  graphemeWidth,
  imageFallback,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  parseKey,
  resetCapabilitiesCache,
  setCapabilities,
  setKittyProtocolActive,
  sliceByColumn,
  splitGraphemes,
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

function occurrences(value, selected) {
  return value.split(selected).length - 1;
}

describe("keyboard protocols", () => {
  it("normalizes legacy aliases and modifiers", () => {
    assert.equal(parseKey("\r"), "enter");
    assert.equal(parseKey("\x1b[1;5D"), "ctrl+left");
    assert.equal(matchesKey("\x1b[1;3C", Key.alt("right")), true);
    assert.equal(matchesKey("\x01", Key.ctrl("a")), true);
    assert.equal(parseKey("\x1b[11~"), "f1");
    assert.equal(parseKey("\x1b[[E"), "f5");
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
    assert.deepEqual(splitGraphemes("plain\ttext\n"), ["p", "l", "a", "i", "n", "\t", "t", "e", "x", "t", "\n"]);
    assert.equal(cellWidth("plain\ttext\n\u007f"), 12);
    assert.equal(visibleWidth("a界🙂"), 5);
    assert.equal(visibleWidth("\x1b[31mred\x1b[0m"), 3);
    assert.equal(visibleWidth("👨‍👩‍👧‍👦"), 2);
    for (const grapheme of ["1️⃣", "#️⃣", "*️⃣", "👩🏽‍💻", "🇨🇦"]) {
      assert.equal(graphemeWidth(grapheme), visibleWidth(grapheme));
      assert.equal(cellWidth(grapheme), visibleWidth(grapheme));
    }
    assert.equal(visibleWidth("1️⃣"), 2);
    assert.equal(visibleWidth("✔"), 1);
    assert.equal(visibleWidth("✔️"), 2);
    assert.equal(visibleWidth(" \u200d"), 1);
    assert.equal(cellWidth(" \u200d"), 1);
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

describe("image text fallback", () => {
  it("shortens home paths and links only absolute filenames", () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: true });
    try {
      const absolute = join(homedir(), "images", "résumé 界.png");
      const linked = imageFallback("image/png", { widthPx: 1280, heightPx: 720 }, absolute);
      assert.equal(stripVTControlCharacters(linked), "[Image: ~/images/résumé 界.png [image/png] 1280x720]");
      assert.ok(linked.includes(`\x1b]8;;${pathToFileURL(absolute).href}\x1b\\`));
      assert.equal(occurrences(linked, "\x1b]8;;\x1b\\"), 1);

      const basename = imageFallback("image/png", { widthPx: 1, heightPx: 1 }, "shot.png");
      assert.equal(basename, "[Image: shot.png [image/png] 1x1]");
      assert.equal(basename.includes("\x1b]8;"), false);

      const outside = resolve(homedir(), "..", `${homedir().split(/[\\/]/u).filter(Boolean).at(-1) ?? "home"}-other`, "shot.png");
      const outsideFallback = imageFallback("image/png", undefined, outside);
      assert.ok(stripVTControlCharacters(outsideFallback).includes(outside));
      assert.ok(outsideFallback.includes(`\x1b]8;;${pathToFileURL(outside).href}\x1b\\`));
    } finally {
      resetCapabilitiesCache();
    }
  });

  it("bounds styled Unicode fallback rows and closes active links at every width", () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    try {
      const filename = join(homedir(), "images", `${"界🙂résumé-".repeat(20)}shot.png`);
      const image = new Image(
        "AAAA",
        "image/png",
        { fallbackColor: (value) => `\x1b[33m${value}\x1b[0m` },
        { filename },
        { widthPx: 1280, heightPx: 720 },
      );
      for (const width of [0, 1, 2, 3, 4, 9, 24, 40, 80]) {
        const line = image.render(width)[0] ?? "";
        assert.ok(visibleWidth(line) <= width, `fallback width ${visibleWidth(line)} exceeds ${width}`);
        assert.equal(
          occurrences(line, "\x1b]8;;\x1b\\"),
          occurrences(line, "\x1b]8;;file:"),
          `unclosed hyperlink at width ${width}`,
        );
        if (width > 0) assert.match(line, /\x1b\[0m/u);
      }
      const linked = image.render(40)[0] ?? "";
      assert.equal(linked.includes("\x1b]8;;file:"), true);
      assert.match(linked, /\.\.\./u);
      assert.equal(occurrences(linked, "\x1b]8;;\x1b\\"), 1);
    } finally {
      resetCapabilitiesCache();
    }
  });

  it("keeps the filename optional when hyperlinks are disabled", () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    try {
      assert.equal(imageFallback("image/png", { widthPx: 8, heightPx: 6 }), "[Image: [image/png] 8x6]");
      assert.equal(
        imageFallback("image/png", undefined, join(homedir(), "shot.png")),
        "[Image: ~/shot.png [image/png]]",
      );
    } finally {
      resetCapabilitiesCache();
    }
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

  it("bounds unterminated control sequences and resets after overflow", () => {
    const buffer = new StdinBuffer();
    const values = [];
    buffer.on("data", (value) => values.push(value));
    assert.throws(
      () => buffer.process(`\x1b]${"x".repeat(4 * 1024 + 1)}`),
      /sequence is too large/u,
    );
    assert.equal(buffer.getBuffer(), "");
    buffer.process("a");
    assert.deepEqual(values, ["a"]);
    buffer.destroy();
  });

  it("bounds fragmented bracketed paste and resets after overflow", () => {
    const buffer = new StdinBuffer();
    const values = [];
    buffer.on("data", (value) => values.push(value));
    buffer.process(`\x1b[200~${"x".repeat(4 * 1024 * 1024)}`);
    assert.throws(() => buffer.process("x"), /paste exceeds/u);
    assert.equal(buffer.getBuffer(), "");
    buffer.process("b");
    assert.deepEqual(values, ["b"]);
    buffer.destroy();
  });
});

describe("editor behavior", () => {
  it("edits Unicode by grapheme and supports common undo and redo chords", () => {
    const { editor } = makeEditor();
    editor.handleInput("a");
    editor.handleInput("🙂");
    editor.handleInput("\x7f");
    assert.equal(editor.getText(), "a");
    editor.handleInput("\x1a");
    assert.equal(editor.getText(), "a🙂");
    editor.handleInput("\x1b[122;6u");
    assert.equal(editor.getText(), "a");
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

    editor.handleInput("\x1a");

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

  it("keeps narrow scroll indicators inside the border color", () => {
    const terminal = new MemoryTerminal();
    terminal.columns = 10;
    const tui = new TUI(terminal);
    const borderColor = (value) => `\x1b[35m${value}\x1b[39m`;
    const editor = new Editor(tui, { ...plainTheme, borderColor });
    const document = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    editor.setText(document);
    editor.render(10);
    for (let index = 0; index < 10; index += 1) editor.handleInput("\x1b[A");

    const lines = editor.render(10);
    const top = lines[0];
    const bottom = lines.at(-1);
    assert.equal(top, borderColor(stripVTControlCharacters(top)));
    assert.equal(bottom, borderColor(stripVTControlCharacters(bottom)));
    assert.equal(lines.every((line) => visibleWidth(line) === 10), true);
  });
});

describe("single-line input", () => {
  it("uses one undo entry for a paste", () => {
    const input = new Input();
    input.handleInput("a");
    input.handleInput("\x1b[200~xyz\x1b[201~");
    input.handleInput("\x1a");
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

  it("renders nested inline styles and formatted link labels", () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    const line = new Markdown(
      "**bold and _italic_**; _italic and **bold**_; [**bold** label](https://example.com); [**safe**](javascript:alert)",
      0,
      0,
      markdownTheme,
    ).render(300).join("\n");
    assert.match(line, /<s>bold and <i>italic<\/i>.*<\/s>/u);
    assert.match(line, /<i>italic and <s>bold<\/s>.*<\/i>/u);
    assert.match(line, /<a><s>bold<\/s>.* label<\/a>.*https:\/\/example\.com/u);
    assert.match(line, /<s>safe<\/s>/u);
    assert.doesNotMatch(line, /javascript:|<a><s>safe/u);
  });

  it("preserves hard line breaks, angle autolinks, and whitespace-invalid strike text", () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    const lines = new Markdown(
      "first  \nsecond <https://example.com> ~~ invalid ~~",
      0,
      0,
      markdownTheme,
    ).render(200).map((line) => line.trimEnd());
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^first$/u);
    assert.match(lines[1], /second <a>https:\/\/example\.com<\/a> ~~ invalid ~~/u);
    assert.doesNotMatch(lines[1], /<x>/u);
  });

  it("applies width-aware source transforms and keeps the original text when one fails", () => {
    const widths = [];
    const transformed = new Markdown("before", 2, 0, markdownTheme, undefined, {
      transform(markdown, availableWidth) {
        widths.push(availableWidth);
        return markdown.replace("before", "after");
      },
    }).render(20).join("\n");
    assert.deepEqual(widths, [16]);
    assert.match(transformed, /after/u);

    const fallback = new Markdown("readable", 0, 0, markdownTheme, undefined, {
      transform() { throw new Error("display transform failed"); },
    }).render(20).join("\n");
    assert.match(fallback, /readable/u);
  });
});

describe("images", () => {
  it("reads dimensions for supported image headers", () => {
    const png = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(7, 16); png.writeUInt32BE(9, 20);
    assert.deepEqual(getPngDimensions(png.toString("base64")), { widthPx: 7, heightPx: 9 });
    const gif = Buffer.alloc(10); gif.write("GIF89a", 0, "ascii"); gif.writeUInt16LE(3, 6); gif.writeUInt16LE(4, 8);
    assert.deepEqual(getGifDimensions(gif.toString("base64")), { widthPx: 3, heightPx: 4 });
    assert.equal(getJpegDimensions("bad"), null);
    assert.equal(getWebpDimensions("bad"), null);
  });

  it("falls back instead of labeling non-PNG image bytes as Kitty PNG data", () => {
    const gif = Buffer.alloc(10); gif.write("GIF89a", 0, "ascii"); gif.writeUInt16LE(3, 6); gif.writeUInt16LE(4, 8);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x04, 0x00, 0x03, 0x00]);
    const webp = Buffer.alloc(30); webp.write("RIFF", 0, "ascii"); webp.write("WEBP", 8, "ascii"); webp.write("VP8X", 12, "ascii"); webp[24] = 2; webp[27] = 3;
    const fixtures = [
      [gif, "image/gif", { widthPx: 3, heightPx: 4 }],
      [jpeg, "image/jpeg", { widthPx: 3, heightPx: 4 }],
      [webp, "image/webp", { widthPx: 3, heightPx: 4 }],
    ];
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    try {
      for (const [value, mimeType, dimensions] of fixtures) {
        const rendered = new Image(value.toString("base64"), mimeType, { fallbackColor: (text) => text }, {}, dimensions).render(80).join("\n");
        assert.equal(rendered.includes("\x1b_G"), false);
        assert.equal(rendered, `[Image: [${mimeType}] 3x4]`);
      }
    } finally {
      resetCapabilitiesCache();
    }
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

  it("settles a hostile autocomplete rejection without inspecting it", async () => {
    const { editor } = makeEditor();
    let traps = 0;
    const failure = new Proxy(new Error("autocomplete failed"), {
      getPrototypeOf() {
        traps += 1;
        throw new Error("autocomplete rejection was inspected");
      },
    });
    editor.setAutocompleteProvider({
      async getSuggestions() { throw failure; },
      applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
    });

    editor.handleInput("/");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(traps, 0);
    assert.equal(editor.isShowingAutocomplete(), false);
  });
});

describe("composition and renderer", () => {
  it("restores terminal ownership when an input callback fails", () => {
    class LifecycleTerminal extends MemoryTerminal {
      raw = false;
      cursorVisible = true;
      stopCalls = 0;
      start(input, resize) { super.start(input, resize); this.raw = true; }
      stop() { this.stopCalls += 1; this.raw = false; this.input = undefined; }
      hideCursor() { this.cursorVisible = false; }
      showCursor() { this.cursorVisible = true; }
    }
    const terminal = new LifecycleTerminal();
    const tui = new TUI(terminal);
    const failure = { source: "input-listener" };
    tui.addInputListener(() => { throw failure; });
    tui.start();

    assert.throws(() => terminal.input("x"), (cause) => cause === failure);
    assert.equal(terminal.stopCalls, 1);
    assert.equal(terminal.raw, false);
    assert.equal(terminal.cursorVisible, true);
  });

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

  it("removes timed-out background queries before routing later replies", async () => {
    const terminal = new MemoryTerminal();
    const tui = new TUI(terminal);
    tui.start();
    try {
      assert.equal(await tui.queryTerminalBackgroundColor({ timeoutMs: 1 }), undefined);
      const current = tui.queryTerminalBackgroundColor({ timeoutMs: 100 });
      terminal.input("\x1b]11;rgb:ffff/0000/8080\x07");
      assert.deepEqual(await current, { r: 255, g: 0, b: 128 });
    } finally {
      tui.stop();
    }
  });

  it("settles terminal queries on stop and clears their restart ownership", async () => {
    const terminal = new MemoryTerminal();
    const tui = new TUI(terminal);
    tui.start();
    const oldBackground = tui.queryTerminalBackgroundColor({ timeoutMs: 60_000 });
    const oldScheme = tui.queryTerminalColorScheme({ timeoutMs: 60_000 });
    tui.stop();
    assert.equal(await oldBackground, undefined);
    assert.equal(await oldScheme, undefined);

    tui.start();
    terminal.input("\x1b]11;rgb:0000/0000/0000\x07");
    terminal.input("\x1b[?997;1n");
    const currentBackground = tui.queryTerminalBackgroundColor({ timeoutMs: 100 });
    const currentScheme = tui.queryTerminalColorScheme({ timeoutMs: 100 });
    terminal.input("\x1b]11;rgb:ffff/0000/8080\x07");
    terminal.input("\x1b[?997;2n");
    assert.deepEqual(await currentBackground, { r: 255, g: 0, b: 128 });
    assert.equal(await currentScheme, "light");
    tui.stop();
  });
});
