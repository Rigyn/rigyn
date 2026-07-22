import assert from "node:assert/strict";
import test from "node:test";
import { MultilineEditor } from "../../src/tui/editor.js";

test("multiline editor edits by grapheme and moves vertically", () => {
  const editor = new MultilineEditor();
  editor.insert("ab🙂\nxy界");
  assert.equal(editor.length, 7);
  editor.moveUp();
  assert.equal(editor.cursor, 3);
  editor.backspace();
  assert.equal(editor.text, "ab\nxy界");
  editor.undo();
  assert.equal(editor.text, "ab🙂\nxy界");
  editor.redo();
  assert.equal(editor.text, "ab\nxy界");
});

test("multiline editor provides bounded shell-style history with draft restoration", () => {
  const editor = new MultilineEditor({ maxHistoryEntries: 2 });
  editor.insert("first");
  editor.commitHistory();
  editor.clear({ recordUndo: false });
  editor.insert("second");
  editor.commitHistory();
  editor.clear({ recordUndo: false });
  editor.insert("draft");
  assert.equal(editor.historyPrevious(), true);
  assert.equal(editor.text, "second");
  assert.equal(editor.historyPrevious(), true);
  assert.equal(editor.text, "first");
  assert.equal(editor.historyNext(), true);
  assert.equal(editor.text, "second");
  assert.equal(editor.historyNext(), true);
  assert.equal(editor.text, "draft");
});

test("multiline editor bounds input without splitting Unicode", () => {
  const editor = new MultilineEditor({ maxBytes: 5 });
  editor.insert("a🙂b");
  assert.equal(editor.text, "a🙂");
  assert.equal(Buffer.byteLength(editor.text), 5);
});

test("multiline editor deletes the next word without moving the cursor", () => {
  const editor = new MultilineEditor();
  editor.insert("one   two three");
  editor.moveHome();
  editor.moveRight(true);
  assert.equal(editor.cursor, 6);
  editor.deleteWordForward();
  assert.equal(editor.text, "one    three");
  assert.equal(editor.cursor, 6);
});

test("word navigation separates Unicode words, punctuation, symbols, and whitespace", () => {
  const editor = new MultilineEditor();
  editor.setText("foo.bar 变量🙂baz", 0);
  for (const cursor of [3, 4, 8, 10, 11, 14]) {
    editor.moveRight(true);
    assert.equal(editor.cursor, cursor);
  }
  editor.deleteWordBackward();
  assert.equal(editor.text, "foo.bar 变量🙂");
  editor.deleteWordBackward();
  assert.equal(editor.text, "foo.bar 变量");
  editor.deleteWordBackward();
  assert.equal(editor.text, "foo.bar ");
});

test("kill ring coalesces consecutive kills and yank-pop cycles bounded entries", () => {
  const editor = new MultilineEditor();
  editor.setText("alpha beta");
  editor.deleteWordBackward();
  editor.deleteWordBackward();
  assert.equal(editor.text, "");
  assert.equal(editor.yank(), true);
  assert.equal(editor.text, "alpha beta");

  editor.setText("first");
  editor.moveHome();
  editor.deleteToLineEnd();
  editor.setText("second");
  editor.moveHome();
  editor.deleteToLineEnd();
  assert.equal(editor.yank(), true);
  assert.equal(editor.text, "second");
  assert.equal(editor.yankPop(), true);
  assert.equal(editor.text, "first");
  assert.equal(editor.yankPop(), true);
  assert.equal(editor.text, "alpha beta");
  assert.equal(editor.yankPop(), true);
  assert.equal(editor.text, "second");
  editor.moveLeft();
  assert.equal(editor.yankPop(), false);
});

test("mixed forward and backward kills coalesce in document order with undo and redo", () => {
  const editor = new MultilineEditor();
  editor.setText("one two\nthree four", 4);
  editor.deleteWordForward();
  editor.deleteToLineEnd();
  editor.deleteWordBackward();
  assert.equal(editor.text, "three four");
  assert.equal(editor.cursor, 0);
  assert.equal(editor.yank(), true);
  assert.equal(editor.text, "one two\nthree four");
  assert.equal(editor.undo(), true);
  assert.equal(editor.text, "three four");
  assert.equal(editor.redo(), true);
  assert.equal(editor.text, "one two\nthree four");
});

test("kill and yank preserve extended graphemes while unrelated edits invalidate yank-pop", () => {
  const editor = new MultilineEditor();
  const original = "e\u0301 👩‍💻 变量🙂";
  editor.setText(original);
  editor.deleteWordBackward();
  editor.deleteWordBackward();
  editor.deleteWordBackward();
  assert.equal(editor.text, "e\u0301 ");
  assert.equal(editor.yank(), true);
  assert.equal(editor.text, original);

  editor.setText("older", 0);
  editor.deleteToLineEnd();
  editor.setText("newer", 0);
  editor.deleteToLineEnd();
  assert.equal(editor.yank(), true);
  editor.insert("!");
  const edited = editor.text;
  assert.equal(editor.yankPop(), false);
  assert.equal(editor.text, edited);
});

test("kill ring evicts by entry count and total expanded byte size", () => {
  const counted = new MultilineEditor();
  for (let index = 0; index < 65; index += 1) {
    counted.setText(`entry-${index}`, 0);
    counted.deleteToLineEnd();
  }
  assert.equal(counted.yank(), true);
  assert.equal(counted.text, "entry-64");
  for (let index = 63; index >= 5; index -= 1) {
    assert.equal(counted.yankPop(), true);
    assert.equal(counted.text, `entry-${index}`);
  }
  assert.equal(counted.yankPop(), true);
  assert.equal(counted.text, "entry-64");

  const byteBounded = new MultilineEditor({ maxBytes: 12 });
  for (const value of ["aaaaaa", "bbbbbb", "cccccc"]) {
    byteBounded.setText(value, 0);
    byteBounded.deleteToLineEnd();
  }
  assert.equal(byteBounded.yank(), true);
  assert.equal(byteBounded.text, "cccccc");
  assert.equal(byteBounded.yankPop(), true);
  assert.equal(byteBounded.text, "bbbbbb");
  assert.equal(byteBounded.yankPop(), true);
  assert.equal(byteBounded.text, "cccccc");
});

test("character jump is case-sensitive, crosses lines, and skips the current character", () => {
  const editor = new MultilineEditor();
  editor.setText("hello\nWorld hello", 0);
  assert.equal(editor.jumpToCharacter("o", 1), true);
  assert.equal(editor.cursor, 4);
  assert.equal(editor.jumpToCharacter("o", 1), true);
  assert.equal(editor.cursor, 7);
  assert.equal(editor.jumpToCharacter("w", 1), false);
  assert.equal(editor.cursor, 7);
  editor.moveEnd(true);
  assert.equal(editor.jumpToCharacter("W", -1), true);
  assert.equal(editor.cursor, 6);
});

test("vertical and page movement preserve a sticky visual cell column across wraps", () => {
  const logical = new MultilineEditor();
  logical.setText("12345\n1\n12345", 5);
  logical.moveDown();
  assert.equal(logical.cursor, 7);
  logical.moveDown();
  assert.equal(logical.cursor, 13);
  logical.moveUp();
  assert.equal(logical.cursor, 7);

  const wrapped = new MultilineEditor();
  wrapped.setText("abcdefghijklmnopqrst", 0);
  assert.equal(wrapped.hasMultipleVisualRows(4), true);
  assert.equal(wrapped.movePage(1, 4, 3), true);
  assert.equal(wrapped.cursor, 8);
  wrapped.moveDown(4);
  assert.equal(wrapped.cursor, 12);
  assert.equal(wrapped.movePage(-1, 4, 3), true);
  assert.equal(wrapped.cursor, 4);
});

test("large paste markers are atomic and expand only when committed", () => {
  const payload = Array.from({ length: 12 }, (_, index) => `private-${index}`).join("\n");
  const editor = new MultilineEditor();
  editor.insertPaste(payload);
  assert.match(editor.text, /^\[paste #1 \+12 lines\]$/u);
  assert.doesNotMatch(editor.text, /private-/u);
  const markerEnd = editor.cursor;
  editor.moveLeft();
  assert.equal(editor.cursor, 0);
  editor.moveRight();
  assert.equal(editor.cursor, markerEnd);
  editor.backspace();
  assert.equal(editor.text, "");
  assert.equal(editor.undo(), true);
  assert.doesNotMatch(editor.text, /private-/u);
  assert.equal(editor.commitHistory(), payload);
});

test("visual movement crosses a wrapped paste marker atomically and restores its sticky column", () => {
  const payload = Array(11).fill("private").join("\n");
  const editor = new MultilineEditor();
  editor.insert("abcd\n");
  editor.insertPaste(payload);
  editor.insert("\nabcdef");
  editor.setText(editor.text, 4);
  const paste = editor.snapshot().pastes?.[0];
  assert.ok(paste !== undefined);
  editor.moveDown(10);
  assert.equal(editor.cursor, paste.start);
  editor.moveDown(10);
  assert.equal(editor.cursor, paste.end);
  editor.moveDown(10);
  assert.equal(editor.cursor, paste.end + 5);
});

test("paste payload survives snapshots, history, undo, external-style edits, and kill/yank", () => {
  const payload = Array.from({ length: 11 }, (_, index) => `token-${index}`).join("\n");
  const editor = new MultilineEditor();
  editor.insertPaste(payload);
  const snapshot = editor.snapshot();

  const restored = new MultilineEditor();
  restored.restore(snapshot);
  restored.setText(`before ${restored.text} after`);
  assert.doesNotMatch(restored.text, /token-/u);
  assert.equal(restored.commitHistory(), `before ${payload} after`);
  restored.clear({ recordUndo: false });
  assert.equal(restored.historyPrevious(), true);
  assert.equal(restored.commitHistory(), `before ${payload} after`);
  assert.equal(restored.undo(), true);
  assert.equal(restored.commitHistory(), payload);
  assert.equal(restored.redo(), true);
  assert.equal(restored.commitHistory(), `before ${payload} after`);

  const killed = new MultilineEditor();
  killed.restore(snapshot);
  killed.moveHome(true);
  killed.deleteToLineEnd();
  assert.equal(killed.text, "");
  assert.equal(killed.yank(), true);
  assert.doesNotMatch(killed.text, /token-/u);
  assert.equal(killed.commitHistory(), payload);
});

test("paste markers renumber after atomic removal and respect expanded byte limits", () => {
  const first = Array(11).fill("first").join("\n");
  const second = Array(11).fill("second").join("\n");
  const editor = new MultilineEditor({ maxBytes: Buffer.byteLength(first) + Buffer.byteLength(second) + 1 });
  editor.insertPaste(first);
  editor.insert(" ");
  editor.insertPaste(second);
  assert.match(editor.text, /\[paste #1 \+11 lines\] \[paste #2 \+11 lines\]/u);
  editor.moveHome(true);
  editor.deleteForward();
  assert.equal(editor.text, " [paste #1 +11 lines]");
  assert.equal(editor.commitHistory(), ` ${second}`);

  const bounded = new MultilineEditor({ maxBytes: 32 });
  bounded.insertPaste(Array(20).fill("abcdef").join("\n"));
  const expanded = bounded.commitHistory();
  assert.ok(Buffer.byteLength(expanded) <= 32);
  assert.doesNotMatch(bounded.text, /abcdef/u);

  const tooSmallForMetadata = new MultilineEditor({ maxBytes: 8 });
  tooSmallForMetadata.insertPaste(Array(20).fill("private").join("\n"));
  assert.equal(tooSmallForMetadata.text, "");
  assert.equal(tooSmallForMetadata.commitHistory(), "");
});

test("small bracketed paste remains literal", () => {
  const editor = new MultilineEditor();
  editor.insertPaste("one\ntwo");
  assert.equal(editor.text, "one\ntwo");
  assert.equal(editor.commitHistory(), "one\ntwo");
});

test("display text remains byte-bounded beside a compact paste marker", () => {
  const editor = new MultilineEditor({ maxBytes: 24 });
  editor.insertPaste("\n".repeat(10));
  assert.match(editor.text, /^\[paste #1 \+11 lines\]$/u);
  editor.insert("abcdefghijklmnopqrstuvwxyz");
  assert.ok(Buffer.byteLength(editor.text, "utf8") <= 24);
  assert.ok(Buffer.byteLength(editor.commitHistory(), "utf8") <= 24);
});

test("snapshot restoration bounds canonical marker labels and malformed cursors", () => {
  const label = "[paste #1 +2 lines]";
  const text = label.repeat(10);
  const editor = new MultilineEditor({ maxBytes: Buffer.byteLength(text, "utf8") });
  editor.restore({
    text,
    cursor: Number.NaN,
    pastes: Array.from({ length: 10 }, (_, index) => ({
      start: index * label.length,
      end: (index + 1) * label.length,
      label,
      payload: "\n",
    })),
  });
  assert.ok(Buffer.byteLength(editor.text, "utf8") <= Buffer.byteLength(text, "utf8"));
  assert.equal(editor.snapshot().pastes?.length, 9);
  assert.equal(editor.cursor, editor.length);
});

test("yank cannot duplicate paste metadata beyond the bounded marker count", () => {
  const payload = "\n".repeat(10);
  const editor = new MultilineEditor();
  for (let index = 0; index < 100; index += 1) editor.insertPaste(payload);
  assert.equal(editor.snapshot().pastes?.length, 100);
  editor.moveHome(true);
  editor.deleteWordForward();
  assert.equal(editor.yank(), true);
  assert.equal(editor.snapshot().pastes?.length, 100);
  const before = editor.text;
  editor.moveHome(true);
  assert.equal(editor.yank(), false);
  assert.equal(editor.text, before);
  assert.equal(editor.snapshot().pastes?.length, 100);
});
