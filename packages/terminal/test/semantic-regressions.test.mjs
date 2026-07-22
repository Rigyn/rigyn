import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Container,
  Markdown,
  TUI,
  encodeKitty,
  setCapabilities,
  sliceByColumn,
  visibleWidth,
} from "../dist/index.js";
import { VirtualTerminal } from "./virtual-terminal-shim.mjs";

const identityTheme = {
  heading: (value) => value,
  link: (value) => value,
  linkUrl: (value) => value,
  code: (value) => value,
  codeBlock: (value) => value,
  codeBlockBorder: (value) => value,
  quote: (value) => value,
  quoteBorder: (value) => value,
  hr: (value) => value,
  listBullet: (value) => value,
  bold: (value) => value,
  italic: (value) => value,
  strikethrough: (value) => value,
  underline: (value) => value,
};

class FocusableComponent {
  focused = false;
  inputs = [];
  constructor(lines = [""]) { this.lines = lines; }
  render() { return this.lines; }
  invalidate() {}
  handleInput(value) { this.inputs.push(value); }
}

async function settle(terminal) {
  await terminal.waitForRender();
}

describe("overlay ownership", () => {
  it("returns input to a visible overlay after a temporary mounted replacement closes", async () => {
    const terminal = new VirtualTerminal(40, 8);
    const tui = new TUI(terminal);
    const base = new Container();
    const editor = new FocusableComponent(["editor"]);
    const replacement = new FocusableComponent(["replacement"]);
    const overlay = new FocusableComponent(["overlay"]);
    base.addChild(editor);
    base.addChild(replacement);
    tui.addChild(base);
    tui.setFocus(editor);
    overlay.handleInput = (value) => {
      overlay.inputs.push(value);
      if (value === "b") tui.setFocus(replacement);
    };
    replacement.handleInput = (value) => {
      replacement.inputs.push(value);
      if (value === "\r") {
        base.clear();
        base.addChild(editor);
        tui.setFocus(editor);
      }
    };
    tui.start();
    tui.showOverlay(overlay);
    terminal.sendInput("b");
    terminal.sendInput("\r");
    terminal.sendInput("x");
    await settle(terminal);
    assert.deepEqual(replacement.inputs, ["\r"]);
    assert.deepEqual(overlay.inputs, ["b", "x"]);
    assert.equal(overlay.focused, true);
    tui.stop();
  });
});

describe("differential terminal state", () => {
  it("clears every old row when content becomes empty", async () => {
    const terminal = new VirtualTerminal(20, 5);
    const tui = new TUI(terminal);
    const component = new FocusableComponent(["one", "two", "three"]);
    tui.addChild(component);
    tui.start();
    await settle(terminal);
    component.lines = [];
    tui.requestRender();
    await settle(terminal);
    assert.deepEqual(terminal.getViewport(), ["", "", "", "", ""]);
    tui.stop();
  });

  it("deletes a reserved image placement before redrawing its block", async () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    const terminal = new VirtualTerminal(30, 6);
    const tui = new TUI(terminal);
    const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 91, moveCursor: false });
    const component = new FocusableComponent(["", image, ""]);
    tui.addChild(component);
    tui.start();
    await settle(terminal);
    terminal.writes.length = 0;
    component.lines = ["changed", image, ""];
    tui.requestRender();
    await settle(terminal);
    const output = terminal.writes.join("");
    assert.ok(output.indexOf("a=d,d=I,i=91") >= 0);
    assert.ok(output.indexOf("a=d,d=I,i=91") < output.indexOf(image));
    tui.stop();
  });
});

describe("cell-accurate composition", () => {
  it("places an overlay at a column that intersects a wide grapheme", () => {
    const tui = new TUI(new VirtualTerminal(20, 5));
    const output = tui.compositeLineAt("abcd让EFGH", "│XX│", 5, 4, 20);
    assert.equal(output.includes("让"), false);
    assert.equal(visibleWidth(output), 20);
    assert.equal(sliceByColumn(output, 5, 4, true).includes("│XX│"), true);
  });
});

describe("Markdown stability", () => {
  it("normalizes partial fences and preserves loose ordered-list state", () => {
    const fenced = new Markdown("```ts\nconst x = 1;\n``", 0, 0, identityTheme).render(40).map((line) => line.trimEnd());
    assert.deepEqual(fenced, ["```ts", "  const x = 1;", "```"]);
    const loose = new Markdown("1. one\n\n   continuation\n\n2. two", 0, 0, identityTheme).render(40).map((line) => line.trimEnd());
    assert.deepEqual(loose, ["1. one", "", "   continuation", "", "2. two"]);
  });

  it("hard-wraps oversized table tokens without dropping borders", () => {
    const lines = new Markdown("| Value |\n| --- |\n| prefix https://example.com/a/very/long/path |", 0, 0, identityTheme).render(24);
    for (const line of lines.filter((value) => value.startsWith("│"))) {
      assert.equal(line.split("│").length - 1, 2);
      assert.ok(visibleWidth(line) <= 24);
    }
  });
});
