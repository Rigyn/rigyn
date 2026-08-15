import assert from "node:assert/strict";
import test from "node:test";

import {
  AlternateScreenInputParser,
  AlternateScreenInteraction,
  type AlternateScreenMouseEvent,
} from "../../src/tui/alternate-screen.js";
import { stripAnsi } from "../../src/tui/unicode.js";

function left(
  type: "press" | "release" | "move",
  row: number,
  column: number,
): AlternateScreenMouseEvent {
  return {
    type,
    button: "left",
    point: { row, column },
    shift: false,
    alt: false,
    ctrl: false,
  };
}

test("alternate-screen parser consumes fragmented SGR mouse reports without leaking bytes", () => {
  const sequence = Buffer.from("\u001b[<64;5;3M", "utf8");
  for (let boundary = 0; boundary <= sequence.length; boundary += 1) {
    const parser = new AlternateScreenInputParser();
    const first = parser.push(sequence.subarray(0, boundary));
    const second = parser.push(sequence.subarray(boundary));
    assert.equal(Buffer.concat([first.data, second.data]).length, 0, `boundary ${boundary}`);
    assert.deepEqual([...first.mouse, ...second.mouse], [{
      type: "wheel",
      button: "none",
      point: { row: 2, column: 4 },
      shift: false,
      alt: false,
      ctrl: false,
      deltaY: -1,
    }], `boundary ${boundary}`);
  }
});

test("alternate-screen parser consumes fragmented legacy mouse reports and preserves surrounding keys", () => {
  const legacy = Buffer.from([0x1b, 0x5b, 0x4d, 32, 37, 35]);
  for (let boundary = 0; boundary <= legacy.length; boundary += 1) {
    const parser = new AlternateScreenInputParser();
    const first = parser.push(Buffer.concat([Buffer.from("a"), legacy.subarray(0, boundary)]));
    const second = parser.push(Buffer.concat([legacy.subarray(boundary), Buffer.from("b")]));
    assert.equal(Buffer.concat([first.data, second.data]).toString("utf8"), "ab", `boundary ${boundary}`);
    assert.deepEqual([...first.mouse, ...second.mouse], [{
      type: "press",
      button: "left",
      point: { row: 2, column: 4 },
      shift: false,
      alt: false,
      ctrl: false,
    }], `boundary ${boundary}`);
  }
});

test("alternate-screen parser returns normal terminal keys exactly and drops malformed mouse prefixes", () => {
  const parser = new AlternateScreenInputParser();
  assert.equal(parser.push("\u001b").data.length, 0);
  assert.equal(parser.push("[A").data.toString("utf8"), "\u001b[A");
  const malformed = `\u001b[<${"9".repeat(80)};1;1Mkept`;
  assert.equal(parser.push(malformed).data.toString("utf8"), "kept");
  assert.equal(parser.push("\u001b[<0;1").data.length, 0);
  assert.equal(parser.flushPending().length, 0);
});

test("alternate-screen parser consumes focus reports and distinguishes hover motion", () => {
  const parser = new AlternateScreenInputParser();
  const result = parser.push("before\u001b[I\u001b[<35;5;3M\u001b[Oafter");
  assert.equal(result.data.toString("utf8"), "beforeafter");
  assert.equal(result.focusLost, true);
  assert.deepEqual(result.mouse, [{
    type: "move",
    button: "none",
    point: { row: 2, column: 4 },
    shift: false,
    alt: false,
    ctrl: false,
  }]);
});

test("alternate-screen interaction scrolls vertically and ignores horizontal wheels", () => {
  const interaction = new AlternateScreenInteraction();
  interaction.updateFrame("frame", 20, 4);
  assert.deepEqual(interaction.handle({
    type: "wheel",
    button: "none",
    point: { row: 0, column: 0 },
    shift: false,
    alt: false,
    ctrl: false,
    deltaY: -1,
  }), [{ type: "scroll", rows: 3 }]);
  assert.deepEqual(interaction.handle({
    type: "wheel",
    button: "none",
    point: { row: 0, column: 0 },
    shift: false,
    alt: false,
    ctrl: false,
    horizontal: true,
  }), []);
});

test("alternate-screen interaction targets the transcript and drags its scrollbar", () => {
  const interaction = new AlternateScreenInteraction();
  interaction.updateFrame("head\none\ntwo\nthree\nfoot", 10, 5, {
    top: 1,
    bottom: 3,
    scrollbar: {
      column: 9,
      thumbTop: 3,
      thumbRows: 1,
      totalRows: 20,
      viewportRows: 3,
    },
  });
  assert.deepEqual(interaction.handle({
    type: "wheel",
    button: "none",
    point: { row: 0, column: 2 },
    shift: false,
    alt: false,
    ctrl: false,
    deltaY: -1,
  }), []);

  assert.deepEqual(interaction.handle(left("move", 2, 9)), [{ type: "scrollbar_hover", active: true }]);
  assert.deepEqual(interaction.handle(left("move", 2, 2)), [{ type: "scrollbar_hover", active: false }]);
  assert.deepEqual(interaction.handle(left("press", 1, 9)), [
    { type: "scrollbar_hover", active: true },
    { type: "scroll_to", rowsFromEnd: 17 },
  ]);
  assert.deepEqual(interaction.handle(left("move", 3, 9)), [{ type: "scroll_to", rowsFromEnd: 0 }]);
  assert.deepEqual(interaction.handle(left("release", 3, 9)), [{ type: "scroll_to", rowsFromEnd: 0 }]);
});

test("alternate-screen selection auto-scrolls at transcript edges and cancels on focus loss", () => {
  const interaction = new AlternateScreenInteraction();
  interaction.updateFrame("head\none\ntwo\nthree\nfoot", 10, 5, { top: 1, bottom: 3 });
  interaction.handle(left("press", 2, 0));
  assert.deepEqual(interaction.handle(left("move", 1, 0)), [{ type: "selection_autoscroll", rows: 1 }]);
  assert.deepEqual(interaction.handle(left("move", 3, 0)), [{ type: "selection_autoscroll", rows: -1 }]);
  assert.deepEqual(interaction.cancelPointer(), [{ type: "selection_autoscroll", rows: 0 }]);
  assert.deepEqual(interaction.handle(left("release", 3, 0)), []);
});

test("alternate-screen selection copies rows retained across viewport scrolling", () => {
  const interaction = new AlternateScreenInteraction();
  interaction.updateFrame("head\nnewer1\nnewer2\nnewer3\nfoot", 10, 5, { top: 1, bottom: 3 });
  interaction.handle(left("press", 3, 5));
  assert.deepEqual(interaction.handle(left("move", 1, 0)), [
    { type: "selection_autoscroll", rows: 1 },
  ]);

  interaction.updateFrame("head\nolder\nnewer1\nnewer2\nfoot", 10, 5, { top: 1, bottom: 3 });
  assert.deepEqual(interaction.handle(left("release", 1, 0)), [
    { type: "selection_autoscroll", rows: 0 },
    { type: "copy", text: "older\nnewer1\nnewer2\nnewer3", truncated: false },
  ]);
});

test("alternate-screen selection marks indistinguishable repeated-row scrolling as truncated", () => {
  const interaction = new AlternateScreenInteraction();
  const frame = "head\nsame\nsame\nsame\nfoot";
  interaction.updateFrame(frame, 10, 5, { top: 1, bottom: 3 });
  interaction.handle(left("press", 3, 3));
  interaction.handle(left("move", 1, 0));
  interaction.updateFrame(frame, 10, 5, { top: 1, bottom: 3 });

  assert.deepEqual(interaction.handle(left("release", 1, 0)), [
    { type: "selection_autoscroll", rows: 0 },
    { type: "copy", text: "same\nsame\nsame…", truncated: true },
  ]);
});

test("alternate-screen selection is grapheme-safe, visibly marked, and byte bounded", () => {
  const frame = `plain\n\u001b[31mA🙂e\u0301\u001b[0m tail`;
  const interaction = new AlternateScreenInteraction();
  interaction.updateFrame(frame, 40, 4);
  interaction.handle(left("press", 1, 2));
  interaction.handle(left("move", 1, 3));
  const decision = interaction.handle(left("release", 1, 3));
  assert.deepEqual(decision, [{ type: "copy", text: "🙂e\u0301", truncated: false }]);
  const highlighted = interaction.decorateFrame(frame);
  assert.match(highlighted, /\u001b\[7m/u);
  assert.equal(stripAnsi(highlighted), stripAnsi(frame));

  const bounded = new AlternateScreenInteraction(5);
  bounded.updateFrame("abcdef", 20, 2);
  bounded.handle(left("press", 0, 0));
  bounded.handle(left("move", 0, 5));
  assert.deepEqual(bounded.handle(left("release", 0, 5)), [{
    type: "copy",
    text: "ab…",
    truncated: true,
  }]);
});

test("alternate-screen links open only on a safe click and never after a drag", () => {
  const open = "\u001b]8;;https://example.test/docs\u001b\\";
  const close = "\u001b]8;;\u001b\\";
  const interaction = new AlternateScreenInteraction();
  interaction.updateFrame(`${open}docs${close}`, 20, 2);
  interaction.handle(left("press", 0, 1));
  assert.deepEqual(interaction.handle(left("release", 0, 1)), [{
    type: "open",
    target: "https://example.test/docs",
  }]);

  interaction.handle(left("press", 0, 0));
  interaction.handle(left("move", 0, 2));
  assert.deepEqual(interaction.handle(left("release", 0, 2)), [{
    type: "copy",
    text: "doc",
    truncated: false,
  }]);

  interaction.updateFrame("\u001b]8;;file:///tmp/private\u001b\\private\u001b]8;;\u001b\\", 20, 2);
  interaction.handle(left("press", 0, 1));
  assert.deepEqual(interaction.handle(left("release", 0, 1)), []);
});
