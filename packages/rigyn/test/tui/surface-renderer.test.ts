import assert from "node:assert/strict";
import test from "node:test";
import { LiveSurfaceRenderer } from "../../src/tui/surface-renderer.js";
import { validateTerminalImage, type TerminalImagePlacement } from "../../src/tui/terminal-image.js";
import type { Frame } from "../../src/tui/types.js";
import { FocusedVirtualTerminal } from "./virtual-terminal.js";

function frame(rows: readonly string[], cursor = { row: rows.length || 1, column: 1 }): Frame {
  return { text: rows.join("\n"), cursor };
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

function terminalImage(): TerminalImagePlacement {
  return {
    ...validateTerminalImage({
      key: "surface:image:0",
      block: { type: "image", mediaType: "image/png", data: png().toString("base64") },
    }, 77),
    row: 1,
    column: 0,
    columns: 4,
    rows: 2,
  };
}

function apply(
  terminal: FocusedVirtualTerminal,
  renderer: LiveSurfaceRenderer,
  rows: readonly string[],
  size: { columns: number; rows: number },
  cursor?: { row: number; column: number },
) {
  const update = renderer.render(frame(rows, cursor), size);
  terminal.write(update.output);
  return update;
}

test("live surface rewrites only changed styled rows and tracks the hardware cursor", () => {
  const terminal = new FocusedVirtualTerminal(20, 6);
  const renderer = new LiveSurfaceRenderer({ alternateScreen: false, synchronizedOutput: false });
  apply(terminal, renderer, ["head", "working", "foot"], { columns: 20, rows: 6 }, { row: 2, column: 4 });

  const styled = apply(
    terminal,
    renderer,
    ["head", "\u001b[31mworking\u001b[0m", "foot"],
    { columns: 20, rows: 6 },
    { row: 2, column: 4 },
  );
  assert.equal(styled.strategy, "diff");
  assert.equal(styled.changedRows, 1);
  assert.equal(styled.output.match(/\u001b\[2K/gu)?.length, 1);
  assert.deepEqual(terminal.viewport().slice(0, 3), ["head", "working", "foot"]);
  assert.deepEqual(terminal.cursor(), { row: 1, column: 3 });

  const unchanged = apply(
    terminal,
    renderer,
    ["head", "\u001b[31mworking\u001b[0m", "foot"],
    { columns: 20, rows: 6 },
    { row: 2, column: 4 },
  );
  assert.equal(unchanged.strategy, "none");
  assert.equal(unchanged.output, "");
});

test("first, last, and non-adjacent row changes preserve untouched physical rows", () => {
  const terminal = new FocusedVirtualTerminal(20, 6);
  const renderer = new LiveSurfaceRenderer({ alternateScreen: false, synchronizedOutput: false });
  apply(terminal, renderer, ["row 0", "row 1", "row 2", "row 3", "row 4"], { columns: 20, rows: 6 });

  const edges = apply(
    terminal,
    renderer,
    ["first", "row 1", "row 2", "row 3", "last"],
    { columns: 20, rows: 6 },
  );
  assert.equal(edges.changedRows, 2);
  assert.equal(edges.output.match(/\u001b\[2K/gu)?.length, 2);
  const separated = apply(
    terminal,
    renderer,
    ["first", "changed 1", "row 2", "changed 3", "last"],
    { columns: 20, rows: 6 },
  );
  assert.equal(separated.changedRows, 2);
  assert.deepEqual(terminal.viewport().slice(0, 5), ["first", "changed 1", "row 2", "changed 3", "last"]);
});

test("shrink-to-empty clears stale rows and reset-then-append reuses the owned anchor", () => {
  const terminal = new FocusedVirtualTerminal(20, 6);
  const renderer = new LiveSurfaceRenderer({ alternateScreen: false, synchronizedOutput: false });
  apply(terminal, renderer, ["first", "second", "third"], { columns: 20, rows: 6 });
  apply(terminal, renderer, ["first"], { columns: 20, rows: 6 });
  assert.deepEqual(terminal.viewport().slice(0, 3), ["first", "", ""]);

  apply(terminal, renderer, [], { columns: 20, rows: 6 });
  assert.deepEqual(terminal.viewport().slice(0, 3), ["", "", ""]);
  const appended = apply(terminal, renderer, ["new first", "new second"], { columns: 20, rows: 6 });
  assert.equal(appended.strategy, "initial");
  assert.doesNotMatch(appended.output, /\u001b\[2J/u);
  assert.deepEqual(terminal.viewport().slice(0, 3), ["new first", "new second", ""]);
});

test("shrink with unchanged remaining rows resets cursor state before the next update", () => {
  const terminal = new FocusedVirtualTerminal(20, 6);
  const renderer = new LiveSurfaceRenderer({ alternateScreen: false, synchronizedOutput: false });
  apply(terminal, renderer, ["row 0", "row 1", "row 2", "row 3", "row 4"], { columns: 20, rows: 6 });
  apply(terminal, renderer, ["row 0", "row 1", "row 2"], { columns: 20, rows: 6 });
  const updated = apply(terminal, renderer, ["row 0", "changed", "row 2"], { columns: 20, rows: 6 });
  assert.equal(updated.changedRows, 1);
  assert.deepEqual(terminal.viewport().slice(0, 4), ["row 0", "changed", "row 2", ""]);
});

test("temporary height inflation cannot leave selector or branch rows behind", () => {
  const terminal = new FocusedVirtualTerminal(24, 8);
  const renderer = new LiveSurfaceRenderer({ alternateScreen: false, synchronizedOutput: false });
  apply(terminal, renderer, ["chat", "editor"], { columns: 24, rows: 8 });
  apply(terminal, renderer, ["chat", ...Array.from({ length: 6 }, (_, index) => `selector ${index}`)], { columns: 24, rows: 8 });
  apply(terminal, renderer, ["chat", "editor"], { columns: 24, rows: 8 });
  apply(terminal, renderer, ["branch", "editor"], { columns: 24, rows: 8 });
  assert.deepEqual(terminal.viewport(), ["branch", "editor", "", "", "", "", "", ""]);
});

test("viewport movement and post-tool appends never overwrite committed scrollback", () => {
  const terminal = new FocusedVirtualTerminal(18, 5);
  for (let index = 0; index < 8; index += 1) terminal.write(`PRE ${index}\r\n`);
  const renderer = new LiveSurfaceRenderer({ alternateScreen: false, synchronizedOutput: false });
  for (let count = 1; count <= 5; count += 1) {
    apply(terminal, renderer, Array.from({ length: count }, (_, index) => `TOOL ${index}`), { columns: 18, rows: 5 });
  }
  apply(terminal, renderer, ["TOOL 0", "TOOL 1", "POST 0"], { columns: 18, rows: 5 });
  apply(terminal, renderer, ["TOOL 0", "TOOL 1", "POST 0", "POST 1"], { columns: 18, rows: 5 });

  const buffer = terminal.buffer();
  for (let index = 0; index < 8; index += 1) {
    assert.equal(buffer.filter((row) => row === `PRE ${index}`).length, 1, `PRE ${index} must survive exactly once`);
  }
  assert.ok(buffer.includes("POST 0"));
  assert.ok(buffer.includes("POST 1"));
  assert.ok(!buffer.includes("TOOL 4"), "stale tool rows must be erased after shrink");
});

test("width and safe height changes clear only the known live surface", () => {
  const terminal = new FocusedVirtualTerminal(20, 6);
  terminal.write("committed\r\n");
  const renderer = new LiveSurfaceRenderer({ alternateScreen: false, synchronizedOutput: false });
  apply(terminal, renderer, ["old one", "old two", "old three"], { columns: 20, rows: 6 });
  terminal.resize(12, 6);
  const update = apply(terminal, renderer, ["new one", "new two"], { columns: 12, rows: 6 });

  assert.equal(update.strategy, "surface-clear");
  assert.doesNotMatch(update.output, /\u001b\[2J/u);
  assert.equal(terminal.buffer().filter((row) => row === "committed").length, 1);
  assert.ok(!terminal.buffer().some((row) => row.includes("old")));
  assert.deepEqual(terminal.viewport().slice(1, 4), ["new one", "new two", ""]);

  terminal.resize(12, 8);
  const taller = apply(terminal, renderer, ["new one", "new two", "new three"], { columns: 12, rows: 8 });
  assert.equal(taller.strategy, "surface-clear");
  assert.doesNotMatch(taller.output, /\u001b\[2J/u);
  assert.deepEqual(terminal.viewport().slice(1, 5), ["new one", "new two", "new three", ""]);
});

test("unsafe height shrink promotes to a viewport clear without deleting native scrollback", () => {
  const terminal = new FocusedVirtualTerminal(20, 8);
  terminal.write("committed\r\n");
  const renderer = new LiveSurfaceRenderer({ alternateScreen: false, synchronizedOutput: false });
  apply(terminal, renderer, Array.from({ length: 8 }, (_, index) => `live ${index}`), { columns: 20, rows: 8 });
  terminal.resize(20, 4);
  const update = apply(terminal, renderer, ["small 0", "small 1"], { columns: 20, rows: 4 });

  assert.equal(update.strategy, "viewport-clear");
  assert.match(update.output, /\u001b\[2J\u001b\[H/u);
  assert.doesNotMatch(update.output, /\u001b\[3J/u);
  assert.equal(terminal.buffer().filter((row) => row === "committed").length, 1);
  assert.deepEqual(terminal.viewport().slice(0, 3), ["small 0", "small 1", ""]);
});

test("a resize observed while committing uses the same safe clear promotion", () => {
  const terminal = new FocusedVirtualTerminal(20, 8);
  terminal.write("committed\r\n");
  const renderer = new LiveSurfaceRenderer({ alternateScreen: false, synchronizedOutput: false });
  apply(terminal, renderer, Array.from({ length: 8 }, (_, index) => `live ${index}`), { columns: 20, rows: 8 });
  terminal.resize(20, 4);
  const cleared = renderer.clear({ columns: 20, rows: 4 });
  terminal.write(cleared);

  assert.match(cleared, /\u001b\[2J\u001b\[H/u);
  assert.doesNotMatch(cleared, /\u001b\[3J/u);
  assert.equal(terminal.buffer().filter((row) => row === "committed").length, 1);
  const appended = apply(terminal, renderer, ["fresh"], { columns: 20, rows: 4 });
  assert.equal(appended.strategy, "initial");
  assert.equal(terminal.viewport()[0], "fresh");
});

test("wide cells and OSC 133 markers remain zero-width and synchronized", () => {
  const terminal = new FocusedVirtualTerminal(6, 4);
  const renderer = new LiveSurfaceRenderer({ alternateScreen: false });
  const marked = "\u001b]133;A\u0007🙂x\u001b]133;B\u0007";
  const first = apply(terminal, renderer, [marked], { columns: 6, rows: 4 }, { row: 1, column: 4 });
  assert.ok(first.output.startsWith("\u001b[?2026h"));
  assert.ok(first.output.endsWith("\u001b[?2026l"));
  assert.equal(terminal.viewport()[0], "🙂x");
  assert.deepEqual(terminal.cursor(), { row: 0, column: 3 });

  const markerOnlyChange = apply(
    terminal,
    renderer,
    [marked.replace("133;A", "133;D")],
    { columns: 6, rows: 4 },
    { row: 1, column: 4 },
  );
  assert.equal(markerOnlyChange.strategy, "diff");
  assert.equal(markerOnlyChange.changedRows, 1);
  assert.equal(terminal.viewport()[0], "🙂x");
});

test("alternate-screen updates stay differential and resize with a bounded viewport reset", () => {
  const terminal = new FocusedVirtualTerminal(16, 4);
  const renderer = new LiveSurfaceRenderer({ alternateScreen: true, synchronizedOutput: false });
  apply(terminal, renderer, ["one", "two", "three", "four"], { columns: 16, rows: 4 });
  const diff = apply(terminal, renderer, ["one", "changed", "three", "four"], { columns: 16, rows: 4 });
  assert.equal(diff.strategy, "diff");
  assert.equal(diff.output.match(/\u001b\[2K/gu)?.length, 1);
  terminal.resize(12, 3);
  const resized = apply(terminal, renderer, ["new", "screen", "rows"], { columns: 12, rows: 3 });
  assert.equal(resized.strategy, "viewport-clear");
  assert.deepEqual(terminal.viewport(), ["new", "screen", "rows"]);
});

test("surface input and output are bounded before terminal writes", () => {
  const renderer = new LiveSurfaceRenderer({ alternateScreen: false });
  assert.throws(() => renderer.render(frame(["12345"]), { columns: 4, rows: 4 }), /5 cells wide/u);
  assert.throws(() => renderer.render(frame(["one", "two"]), { columns: 10, rows: 1 }), /2 rows/u);
  assert.throws(() => renderer.render(frame(["bad\rrow"]), { columns: 10, rows: 2 }), /carriage return/u);
  assert.throws(() => renderer.render(frame(["ok"]), { columns: 501, rows: 2 }), /1 to 500/u);
  assert.throws(() => renderer.render(frame(["x".repeat(65 * 1024)]), { columns: 500, rows: 2 }), /64 KiB|cells wide/u);
});

test("image rows use a separate protocol channel and redraw with bounded deletion", () => {
  const terminal = new FocusedVirtualTerminal(20, 6);
  const renderer = new LiveSurfaceRenderer({
    alternateScreen: false,
    synchronizedOutput: false,
    imageProtocol: "kitty",
  });
  const image = terminalImage();
  const firstFrame: Frame = {
    text: ["caption", "", "", "footer"].join("\n"),
    cursor: { row: 4, column: 1 },
    images: [image],
  };
  assert.doesNotMatch(firstFrame.text, new RegExp(image.data.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  const initial = renderer.render(firstFrame, { columns: 20, rows: 6 });
  terminal.write(initial.output);
  assert.equal(initial.strategy, "initial");
  assert.match(initial.output, /\u001b_Ga=T,f=100/u);
  assert.deepEqual(terminal.viewport().slice(0, 4), ["caption", "", "", "footer"]);

  const unchanged = renderer.render(firstFrame, { columns: 20, rows: 6 });
  assert.equal(unchanged.strategy, "none");
  assert.equal(unchanged.output, "");

  const changed = renderer.render({ ...firstFrame, text: ["caption", "", "", "changed"].join("\n") }, { columns: 20, rows: 6 });
  terminal.write(changed.output);
  assert.equal(changed.strategy, "image-redraw");
  assert.match(changed.output, /\u001b_Ga=d,d=I,i=77,q=2\u001b\\/u);
  assert.match(changed.output, /\u001b_Ga=T,f=100/u);
  assert.deepEqual(terminal.viewport().slice(0, 4), ["caption", "", "", "changed"]);

  const removed = renderer.render({ text: "caption\n\n\nchanged", cursor: { row: 4, column: 1 } }, { columns: 20, rows: 6 });
  assert.equal(removed.strategy, "image-redraw");
  assert.match(removed.output, /\u001b_Ga=d,d=I,i=77/u);
  assert.doesNotMatch(removed.output, /a=T,f=100/u);
});

test("resizing an image-bearing surface promotes unsafe shrink to a viewport clear", () => {
  const renderer = new LiveSurfaceRenderer({ alternateScreen: false, synchronizedOutput: false, imageProtocol: "kitty" });
  const image = terminalImage();
  renderer.render({ text: "caption\n\n\nfooter", images: [image] }, { columns: 20, rows: 6 });
  const resized = renderer.render({ text: "small\n\n", images: [{ ...image, row: 1 }] }, { columns: 20, rows: 3 });
  assert.equal(resized.strategy, "viewport-clear");
  assert.match(resized.output, /\u001b\[2J\u001b\[H/u);
  assert.match(resized.output, /a=d,d=I,i=77/u);
});

test("surface rejects unvalidated image metadata and protocols without terminal support", () => {
  const image = terminalImage();
  const text = "caption\n\n\nfooter";
  assert.throws(
    () => new LiveSurfaceRenderer({ alternateScreen: false }).render({ text, images: [image] }, { columns: 20, rows: 6 }),
    /active image protocol/u,
  );
  assert.throws(
    () => new LiveSurfaceRenderer({ alternateScreen: false, imageProtocol: "kitty" }).render({
      text,
      images: [{ ...image, fingerprint: "0".repeat(64) }],
    }, { columns: 20, rows: 6 }),
    /metadata does not match/u,
  );
  assert.throws(
    () => new LiveSurfaceRenderer({ alternateScreen: false, imageProtocol: "kitty" }).render({
      text,
      images: Array.from({ length: 9 }, (_, index) => ({ ...image, imageId: index + 1 })),
    }, { columns: 20, rows: 6 }),
    /at most 8/u,
  );
});
