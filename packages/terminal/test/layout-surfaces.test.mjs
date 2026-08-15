import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CURSOR_MARKER,
  FullscreenTUI,
  HStack,
  Image,
  ScrollView,
  Text,
  TUI,
  VStack,
  VIEWPORT_POINTER_TARGET,
  compositeTerminalLine,
  compositeTerminalRows,
  compositeTuiLine,
  dispatchViewportPointer,
  fitViewportRows,
  isViewportTUI,
  isViewportComponent,
  renderViewport,
  resetCapabilitiesCache,
  setCapabilities,
  visibleWidth,
} from "../dist/index.js";
import { VirtualTerminal } from "./virtual-terminal-shim.mjs";

function plain(value) {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "");
}

class Lines {
  constructor(lines) { this.lines = lines; }
  render(width) { return this.lines.map((line) => line.slice(0, width)); }
  invalidate() {}
}

class RawLines {
  constructor(lines) { this.lines = lines; }
  render() { return [...this.lines]; }
  invalidate() {}
}

describe("terminal layout surfaces", () => {
  it("keeps component-authoring aliases on the same implementations", () => {
    assert.equal(compositeTuiLine, compositeTerminalLine);
    const terminal = new VirtualTerminal(10, 3);
    const tui = new FullscreenTUI(terminal);
    const root = new Lines(["root"]);
    tui.setLayoutRoot(root);
    assert.equal(tui.root, root);
    assert.equal(isViewportTUI(tui), true);
    assert.equal(isViewportTUI(new TUI(new VirtualTerminal(10, 3))), false);
  });

  it("composites styled wide-cell text without losing the surrounding row", () => {
    const line = compositeTerminalLine("\x1b[31mabcdef\x1b[0m", "\x1b[36m界\x1b[0m", 2, 2, 6);
    assert.equal(visibleWidth(line), 6);
    assert.equal(plain(line), "ab界ef");

    const rows = compositeTerminalRows(["abcdef", "ghijkl"], ["🙂", "XY"], {
      row: 0,
      column: 1,
      width: 2,
      totalWidth: 6,
      totalHeight: 2,
    });
    assert.deepEqual(rows.map(plain), ["a🙂def", "gXYjkl"]);
  });

  it("normalizes untouched composite rows without extending an empty overlay", () => {
    const rows = compositeTerminalRows(["a", "界界界", "toolong"], ["X"], {
      row: 0,
      column: 1,
      width: 1,
      totalWidth: 4,
      totalHeight: 3,
    });
    assert.deepEqual(rows.map(plain), ["aX  ", "界界", "tool"]);
    assert.deepEqual(compositeTerminalRows(["a"], [], {
      row: 100,
      column: 0,
      width: 1,
      totalWidth: 4,
    }).map(plain), ["a   "]);
  });

  it("allocates horizontal regions and honors cross-axis alignment", () => {
    const left = new Lines(["L"]);
    const right = new Lines(["R1", "R2", "R3"]);
    const stack = new HStack([
      { component: left, basis: 2, grow: 1 },
      { component: right, basis: 2, grow: 1 },
    ], { gap: 1, align: "end" });
    assert.deepEqual(stack.render(7).map(plain), ["    R1 ", "    R2 ", "L   R3 "]);

    const responsive = new HStack([
      { component: new Lines(["wide"]), basis: 4, visible: ({ width }) => width >= 8 },
      { component: new Lines(["ok"]), basis: 2 },
    ], { gap: 1 });
    assert.deepEqual(renderViewport(responsive, 6, 1).map(plain), ["ok    "]);
  });

  it("measures horizontal height after assigning child widths", () => {
    const stack = new HStack([
      { component: new Text("abcdefghij", 0, 0), basis: 4 },
      { component: new Text("R", 0, 0), basis: 1 },
    ], { gap: 1 });

    assert.deepEqual(stack.render(6).map(plain), ["abcd R", "efgh  ", "ij    "]);
  });

  it("does not render a horizontal child assigned zero cells", () => {
    let renders = 0;
    const zero = {
      render(width) {
        renders += 1;
        if (width === 0) throw new Error("zero-width render");
        return ["hidden"];
      },
      invalidate() {},
    };
    const stack = new HStack([
      { component: zero, basis: 0, grow: 0, shrink: 0 },
      { component: new Lines(["ok"]), basis: 2 },
    ], { gap: 1 });

    assert.deepEqual(stack.render(3).map(plain), [" ok"]);
    assert.equal(renders, 1);
  });

  it("allocates fixed-height vertical regions and pads the viewport", () => {
    const stack = new VStack([
      { component: new Lines(["head"]), basis: 1 },
      { component: new Lines(["one", "two", "three"]), basis: 1, grow: 1 },
    ], { gap: 1 });
    assert.equal(isViewportComponent(stack), true);
    assert.deepEqual(stack.renderViewport(6, 5).map(plain), ["head  ", "      ", "one   ", "two   ", "three "]);
    assert.deepEqual(
      new VStack([{ component: new Lines(["x"]), basis: 1 }], { align: "end" }).renderViewport(4, 1).map(plain),
      ["   x"],
    );
    assert.deepEqual(fitViewportRows(["界界界"], 5, 2).map(plain), ["界界 ", "     "]);
  });

  it("preserves zero-cell cursor controls under every vertical alignment", () => {
    for (const align of ["stretch", "start", "center", "end"]) {
      const rows = new VStack([new RawLines([CURSOR_MARKER])], { align }).renderViewport(5, 1);
      assert.equal(rows[0].includes(CURSOR_MARKER), true, align);
      assert.equal(visibleWidth(rows[0]), 5, align);
    }
  });

  it("keeps complete vertical image groups intact and rejects unsafe composed image layouts", () => {
    const kitty = ["\x1b_Ga=T,f=100,c=2,r=2;AAAA\x1b\\", ""];
    const iterm = ["", "\x1b[1A\x1b]1337;File=inline=1;width=2:AAAA\x07"];
    assert.deepEqual(new VStack([new RawLines(kitty), new RawLines(iterm)]).render(8), [...kitty, ...iterm]);
    assert.throws(
      () => new HStack([new RawLines(kitty)]).render(8),
      /Terminal image rows are not supported/u,
    );
    assert.throws(
      () => new ScrollView(new RawLines(kitty)).renderViewport(8, 2),
      /Terminal image rows are not supported/u,
    );
    assert.deepEqual(fitViewportRows(kitty, 8, 2), kitty);
    assert.deepEqual(fitViewportRows(kitty, 8, 1), ["        "]);

    const terminal = new VirtualTerminal(8, 2);
    const tui = new FullscreenTUI(terminal);
    tui.setRoot(new RawLines(kitty));
    assert.deepEqual(tui.render(8), kitty);
  });

  it("keeps follow mode stable and reports chained overscroll", () => {
    const content = new Lines(["zero", "one", "two", "three"]);
    const view = new ScrollView(content, { follow: "end", overscroll: "chain" });
    assert.deepEqual(view.renderViewport(7, 2).map(plain), ["two    ", "three  "]);
    content.lines.push("four");
    assert.deepEqual(view.renderViewport(7, 2).map(plain), ["three  ", "four   "]);

    assert.equal(view.scrollBy(-1), 0);
    assert.equal(view.isFollowingEnd, false);
    content.lines.push("five");
    assert.deepEqual(view.renderViewport(7, 2).map(plain), ["two    ", "three  "]);
    assert.equal(view.scrollBy(-20), -18);

    const contained = new ScrollView(content, { overscroll: "contain" });
    contained.renderViewport(7, 2);
    assert.equal(contained.scrollBy(-5), 0);
  });

  it("shows an automatic scrollbar activated before first layout, then hides it", async () => {
    const content = new Lines(["a", "b", "c", "d"]);
    const view = new ScrollView(content, { scrollbar: "auto", scrollbarHideDelayMs: 1 });
    let renders = 0;
    view.setScrollbarActive(true);
    const active = view.renderViewport(4, 2, () => { renders += 1; });
    assert.equal(view.isScrollbarVisible, true);
    assert.ok(active.some((line) => line.includes("\x1b[7m")));

    view.setScrollbarActive(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(view.isScrollbarVisible, false);
    assert.equal(renders > 0, true);
    view.dispose();
  });

  it("routes wheel input to the pointed scroll view", async () => {
    const terminal = new VirtualTerminal(12, 3);
    const left = new ScrollView(new Lines(["l0", "l1", "l2", "l3", "l4", "l5"]));
    const right = new ScrollView(new Lines(["r0", "r1", "r2", "r3", "r4", "r5"]));
    const tui = new FullscreenTUI(terminal);
    tui.setRoot(new HStack([
      { component: left, basis: 6 },
      { component: right, basis: 6 },
    ]));
    tui.start();
    await terminal.waitForRender();

    terminal.sendInput("\x1b[<65;9;2M");
    await terminal.waitForRender();
    assert.equal(left.scrollTop, 0);
    assert.equal(right.scrollTop, 3);
    tui.stop();
  });

  it("configures wheel distance and opens only safe hyperlinks on a click", async () => {
    const terminal = new VirtualTerminal(12, 3);
    const view = new ScrollView(new RawLines([
      "\x1b]8;;https://example.test/docs\x1b\\docs\x1b]8;;\x1b\\",
      "one",
      "two",
      "three",
      "four",
    ]));
    const opened = [];
    const tui = new FullscreenTUI(terminal, undefined, undefined, {
      wheelScrollLines: 1,
      openUrl: (target) => opened.push(target),
    });
    tui.setRoot(view);
    tui.start();
    await terminal.waitForRender();

    terminal.sendInput("\x1b[<0;2;1M\x1b[<0;2;1m");
    assert.deepEqual(opened, ["https://example.test/docs"]);
    terminal.sendInput("\x1b[<65;2;2M");
    await terminal.waitForRender();
    assert.equal(view.scrollTop, 1);

    tui.stop();
    view.dispose();
  });

  it("invalidates hyperlink hit testing immediately when the fullscreen root changes", async () => {
    const terminal = new VirtualTerminal(16, 2);
    const linked = new RawLines([
      "\x1b]8;;https://stale.example.test\x1b\\stale\x1b]8;;\x1b\\",
    ]);
    const plainRoot = new Lines(["plain"]);
    const opened = [];
    const tui = new FullscreenTUI(terminal, undefined, undefined, {
      openUrl: (target) => opened.push(target),
    });
    tui.setRoot(linked);
    tui.start();
    await terminal.waitForRender();

    tui.setLayoutRoot(plainRoot);
    terminal.sendInput("\x1b[<0;2;1M\x1b[<0;2;1m");
    assert.deepEqual(opened, []);
    await terminal.waitForRender();

    tui.setRoot(linked);
    await terminal.waitForRender();
    tui.removeChild(linked);
    tui.addChild(plainRoot);
    terminal.sendInput("\x1b[<0;2;1M\x1b[<0;2;1m");
    assert.deepEqual(opened, []);
    await terminal.waitForRender();
    tui.stop();
  });

  it("uses the composited overlay frame for hyperlink hit testing", async () => {
    const terminal = new VirtualTerminal(16, 2);
    const opened = [];
    const tui = new FullscreenTUI(terminal, undefined, undefined, {
      openUrl: (target) => opened.push(target),
    });
    tui.setRoot(new RawLines([
      "\x1b]8;;https://under.example.test\x1b\\under\x1b]8;;\x1b\\",
    ]));
    tui.start();
    await terminal.waitForRender();

    const plain = tui.showOverlay(new Lines(["PLAIN"]), { row: 0, col: 0, width: 5 });
    await terminal.waitForRender();
    terminal.sendInput("\x1b[<0;2;1M\x1b[<0;2;1m");
    assert.deepEqual(opened, []);

    plain.hide();
    tui.showOverlay(new RawLines([
      "\x1b]8;;https://over.example.test\x1b\\OVER\x1b]8;;\x1b\\",
    ]), { row: 0, col: 0, width: 5 });
    await terminal.waitForRender();
    terminal.sendInput("\x1b[<0;2;1M\x1b[<0;2;1m");
    assert.deepEqual(opened, ["https://over.example.test/"]);
    tui.stop();
  });

  it("keeps iTerm2 image cursor motion aligned with later fullscreen updates", async () => {
    setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
    try {
      const terminal = new VirtualTerminal(8, 4);
      const tail = new Lines(["tail", "last"]);
      const image = new Image(
        "AAAA",
        "image/png",
        { fallbackColor: (value) => value },
        { maxWidthCells: 2, maxHeightCells: 2 },
        { widthPx: 18, heightPx: 36 },
      );
      const tui = new FullscreenTUI(terminal);
      tui.setRoot({
        render: (width) => [...image.render(width), ...tail.render(width)],
        invalidate: () => { image.invalidate(); tail.invalidate(); },
      });
      tui.start();
      await terminal.waitForRender();

      tail.lines[1] = "LAST";
      tui.requestRender();
      await terminal.waitForRender();
      assert.deepEqual(terminal.getViewport().map((line) => line.trimEnd()), ["", "", "tail", "LAST"]);
      tui.stop();
    } finally {
      resetCapabilitiesCache();
    }
  });

  it("can leave terminal pointer reporting disabled", async () => {
    const terminal = new VirtualTerminal(8, 2);
    const tui = new FullscreenTUI(terminal, undefined, undefined, { mouse: false });
    tui.setRoot(new Lines(["ready"]));
    let input = "";
    tui.addInputListener((data) => { input += data; });
    tui.start();
    await terminal.waitForRender();
    terminal.sendInput("x");
    tui.stop();

    assert.equal(input, "x");
    const output = terminal.writes.join("");
    assert.equal(output.includes("\x1b[?1003h"), false);
    assert.equal(output.includes("\x1b[?1003l"), false);
  });

  it("chains only unused wheel rows from an inner target to its scroll parent", () => {
    class InnerTarget extends Lines {
      [VIEWPORT_POINTER_TARGET] = true;
      seen = [];
      handleViewportPointer(event) {
        if (event.type !== "wheel") return { handled: false };
        this.seen.push(event.deltaRows);
        return { handled: true, remainingRows: Math.sign(event.deltaRows) * 2 };
      }
    }
    const inner = new InnerTarget(Array.from({ length: 8 }, (_, index) => `row ${index}`));
    const outer = new ScrollView(inner, { overscroll: "chain" });
    outer.renderViewport(10, 3);

    const result = dispatchViewportPointer(outer, {
      type: "wheel",
      row: 1,
      column: 2,
      button: "none",
      deltaRows: 3,
    }, 10, 3);
    assert.deepEqual(inner.seen, [3]);
    assert.equal(outer.scrollTop, 2);
    assert.equal(result.remainingRows, 0);
  });

  it("hovers and drags scrollbars, then cancels capture when terminal focus leaves", async () => {
    const terminal = new VirtualTerminal(8, 4);
    const view = new ScrollView(
      new Lines(Array.from({ length: 20 }, (_, index) => `row ${index}`)),
      { scrollbar: "auto", scrollbarHideDelayMs: 1 },
    );
    const tui = new FullscreenTUI(terminal);
    tui.setRoot(view);
    let leakedInput = "";
    tui.addInputListener((data) => { leakedInput += data; });
    tui.start();
    await terminal.waitForRender();

    terminal.sendInput("\x1b[I");
    assert.equal(leakedInput, "");

    terminal.sendInput("\x1b[<35;8;1M");
    await terminal.waitForRender();
    assert.equal(view.isScrollbarVisible, true);

    terminal.sendInput("\x1b[<0;8;1M");
    terminal.sendInput("\x1b[<32;8;4M");
    terminal.sendInput("\x1b[<0;8;4m");
    await terminal.waitForRender();
    assert.equal(view.scrollTop, 16);

    view.scrollToStart();
    terminal.sendInput("\x1b[<0;8;1M");
    terminal.sendInput("\x1b[O");
    terminal.sendInput("\x1b[<32;8;4M");
    await terminal.waitForRender();
    assert.equal(view.scrollTop, 0);
    tui.stop();

    const output = terminal.writes.join("");
    assert.match(output, /\x1b\[\?1003h/u);
    assert.match(output, /\x1b\[\?1004h/u);
    assert.match(output, /\x1b\[\?1004l/u);
    assert.match(output, /\x1b\[\?1003l/u);
    view.dispose();
  });

  it("uses a fixed-height alternate buffer and restores modes on stop", async () => {
    const terminal = new VirtualTerminal(10, 3);
    const tui = new FullscreenTUI(terminal);
    tui.setRoot(new Lines(["one", "two", "three", "four"]));
    assert.deepEqual(tui.render(10).map(plain), ["one       ", "two       ", "three     "]);
    assert.throws(() => tui.addChild(new Lines(["extra"])), /one root component/u);

    tui.start();
    await terminal.waitForRender();
    tui.stop();
    const output = terminal.writes.join("");
    assert.match(output, /\x1b\[\?1049h/u);
    assert.match(output, /\x1b\[\?7l/u);
    assert.match(output, /\x1b\[\?7h/u);
    assert.match(output, /\x1b\[\?1049l/u);

    terminal.reset();
    tui.start();
    await terminal.waitForRender();
    assert.equal(terminal.getViewport()[0], "one       ");
    tui.stop();
  });

  it("rolls back fullscreen modes when terminal startup fails", () => {
    const calls = [];
    const terminal = {
      columns: 10,
      rows: 3,
      kittyProtocolActive: false,
      start() { calls.push("start"); },
      stop() { calls.push("stop"); },
      drainInput: async () => undefined,
      write(value) { calls.push(value); },
      moveBy() {},
      hideCursor() { calls.push("hide"); throw new Error("cursor failure"); },
      showCursor() { calls.push("show"); },
      clearLine() {},
      clearFromCursor() {},
      clearScreen() {},
      setTitle() {},
      setProgress() {},
    };
    const tui = new FullscreenTUI(terminal);
    assert.throws(() => tui.start(), /cursor failure/u);
    assert.equal(calls.some((value) => String(value).includes("\x1b[?1049h")), true);
    assert.equal(calls.some((value) => String(value).includes("\x1b[?1049l")), true);
    assert.deepEqual(calls.slice(-2), ["show", "stop"]);
  });

  it("retains the existing main-screen shutdown behavior", async () => {
    const terminal = new VirtualTerminal(10, 3);
    const tui = new TUI(terminal);
    tui.addChild(new Lines(["main"]));
    tui.start();
    await terminal.waitForRender();
    tui.stop();
    const output = terminal.writes.join("");
    assert.equal(output.includes("\x1b[?1049h"), false);
    assert.equal(output.includes("\r\n"), true);
    assert.equal(output.includes("\x1b[3J"), false);
  });

  it("renders after an immediate stop and restart", async () => {
    const terminal = new VirtualTerminal(10, 3);
    const tui = new TUI(terminal);
    tui.addChild(new Lines(["ready"]));

    tui.start();
    tui.stop();
    await Promise.resolve();
    terminal.reset();
    tui.start();
    await terminal.waitForRender();

    assert.equal(terminal.getViewport()[0], "ready");
    assert.equal(terminal.writes.join("").includes("\x1b[3J"), false);
    tui.stop();
  });

  it("redraws the main screen after a completed stop and restart", async () => {
    const terminal = new VirtualTerminal(10, 3);
    const tui = new TUI(terminal);
    tui.addChild(new Lines(["ready"]));

    tui.start();
    await terminal.waitForRender();
    tui.stop();
    terminal.reset();
    tui.start();
    await terminal.waitForRender();

    assert.equal(terminal.getViewport()[0], "ready");
    tui.stop();
  });

  it("renders after a failed fullscreen start is retried", async () => {
    const terminal = new VirtualTerminal(10, 3);
    const originalHideCursor = terminal.hideCursor.bind(terminal);
    let fail = true;
    terminal.hideCursor = () => {
      if (fail) {
        fail = false;
        throw new Error("cursor failure");
      }
      originalHideCursor();
    };
    const tui = new FullscreenTUI(terminal);
    tui.setRoot(new Lines(["ready"]));

    assert.throws(() => tui.start(), /cursor failure/u);
    terminal.reset();
    tui.start();
    await terminal.waitForRender();

    assert.equal(terminal.getViewport()[0], "ready     ");
    tui.stop();
  });
});
