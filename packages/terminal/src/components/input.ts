import { getKeybindings } from "../keybindings.js";
import { decodeKittyPrintable } from "../keys.js";
import { KillRing } from "../kill-ring.js";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui.js";
import { UndoStack } from "../undo-stack.js";
import { getGraphemeSegmenter, isWhitespaceChar, sliceByColumn, visibleWidth } from "../utils.js";
import { findWordBackward, findWordForward } from "../word-navigation.js";

interface State { value: string; cursor: number }
const segmenter = getGraphemeSegmenter();
export class Input implements Component, Focusable {
  #value = ""; #cursor = 0; #paste = ""; #pasting = false; #kills = new KillRing(); #undo = new UndoStack<State>(); #last: "kill" | "yank" | "word" | null = null;
  focused = false; onSubmit?: (value: string) => void; onEscape?: () => void;
  getValue(): string { return this.#value; }
  setValue(value: string): void { this.#value = value; this.#cursor = value.length; }
  invalidate(): void {}
  handleInput(input: string): void {
    let data = input; if (data.includes("\x1b[200~")) { this.#pasting = true; this.#paste = ""; data = data.replace("\x1b[200~", ""); }
    if (this.#pasting) { this.#paste += data; const end = this.#paste.indexOf("\x1b[201~"); if (end >= 0) { const content = this.#paste.slice(0, end); const rest = this.#paste.slice(end + 6); this.#pasting = false; this.#paste = ""; this.#insert(content.replace(/\r\n|\r|\n/gu, "").replace(/\t/gu, "    "), false); if (rest) this.handleInput(rest); } return; }
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.cancel")) { this.onEscape?.(); return; }
    if (kb.matches(data, "tui.editor.undo")) { const state = this.#undo.pop(); if (state) { this.#value = state.value; this.#cursor = state.cursor; this.#last = null; } return; }
    if (kb.matches(data, "tui.input.submit") || data === "\n") { this.onSubmit?.(this.#value); return; }
    if (kb.matches(data, "tui.editor.deleteCharBackward")) { this.#backspace(); return; }
    if (kb.matches(data, "tui.editor.deleteCharForward")) { this.#delete(); return; }
    if (kb.matches(data, "tui.editor.deleteWordBackward")) { this.#kill(findWordBackward(this.#value, this.#cursor), this.#cursor, true); return; }
    if (kb.matches(data, "tui.editor.deleteWordForward")) { this.#kill(this.#cursor, findWordForward(this.#value, this.#cursor), false); return; }
    if (kb.matches(data, "tui.editor.deleteToLineStart")) { this.#kill(0, this.#cursor, true); return; }
    if (kb.matches(data, "tui.editor.deleteToLineEnd")) { this.#kill(this.#cursor, this.#value.length, false); return; }
    if (kb.matches(data, "tui.editor.yank")) { const value = this.#kills.peek(); if (value) { this.#insert(value, false); this.#last = "yank"; } return; }
    if (kb.matches(data, "tui.editor.yankPop")) { if (this.#last === "yank" && this.#kills.length > 1) { this.#snapshot(); const previous = this.#kills.peek()!; this.#value = this.#value.slice(0, this.#cursor - previous.length) + this.#value.slice(this.#cursor); this.#cursor -= previous.length; this.#kills.rotate(); this.#insert(this.#kills.peek()!, false, false); this.#last = "yank"; } return; }
    if (kb.matches(data, "tui.editor.cursorLeft")) { this.#last = null; if (this.#cursor > 0) this.#cursor -= [...segmenter.segment(this.#value.slice(0, this.#cursor))].at(-1)?.segment.length ?? 1; return; }
    if (kb.matches(data, "tui.editor.cursorRight")) { this.#last = null; if (this.#cursor < this.#value.length) this.#cursor += [...segmenter.segment(this.#value.slice(this.#cursor))][0]?.segment.length ?? 1; return; }
    if (kb.matches(data, "tui.editor.cursorLineStart")) { this.#last = null; this.#cursor = 0; return; }
    if (kb.matches(data, "tui.editor.cursorLineEnd")) { this.#last = null; this.#cursor = this.#value.length; return; }
    if (kb.matches(data, "tui.editor.cursorWordLeft")) { this.#last = null; this.#cursor = findWordBackward(this.#value, this.#cursor); return; }
    if (kb.matches(data, "tui.editor.cursorWordRight")) { this.#last = null; this.#cursor = findWordForward(this.#value, this.#cursor); return; }
    const text = decodeKittyPrintable(data) ?? ([...data].some((character) => { const code = character.charCodeAt(0); return code < 32 || code === 127 || code >= 128 && code <= 159; }) ? undefined : data);
    if (text !== undefined) this.#insert(text, true);
  }
  #snapshot(): void { this.#undo.push({ value: this.#value, cursor: this.#cursor }); }
  #insert(value: string, coalesce: boolean, record = true): void { if (record && (!coalesce || isWhitespaceChar(value) || this.#last !== "word")) this.#snapshot(); this.#value = this.#value.slice(0, this.#cursor) + value + this.#value.slice(this.#cursor); this.#cursor += value.length; this.#last = coalesce ? "word" : this.#last; }
  #backspace(): void { this.#last = null; if (this.#cursor <= 0) return; this.#snapshot(); const size = [...segmenter.segment(this.#value.slice(0, this.#cursor))].at(-1)?.segment.length ?? 1; this.#value = this.#value.slice(0, this.#cursor - size) + this.#value.slice(this.#cursor); this.#cursor -= size; }
  #delete(): void { this.#last = null; if (this.#cursor >= this.#value.length) return; this.#snapshot(); const size = [...segmenter.segment(this.#value.slice(this.#cursor))][0]?.segment.length ?? 1; this.#value = this.#value.slice(0, this.#cursor) + this.#value.slice(this.#cursor + size); }
  #kill(start: number, end: number, prepend: boolean): void { if (start === end) return; this.#snapshot(); const value = this.#value.slice(start, end); this.#kills.push(value, { prepend, accumulate: this.#last === "kill" }); this.#value = this.#value.slice(0, start) + this.#value.slice(end); this.#cursor = start; this.#last = "kill"; }
  render(width: number): string[] {
    const prompt = "> "; const available = width - prompt.length; if (available <= 0) return [prompt]; const total = visibleWidth(this.#value); const cursorColumn = visibleWidth(this.#value.slice(0, this.#cursor)); let start = 0;
    if (total >= available) { const window = Math.max(1, this.#cursor === this.#value.length ? available - 1 : available); start = Math.max(0, Math.min(total - window, cursorColumn - Math.floor(window / 2))); }
    const localColumn = Math.max(0, cursorColumn - start); const before = sliceByColumn(this.#value, start, localColumn, true); const rawAfter = this.#value.slice(this.#cursor); const first = [...segmenter.segment(rawAfter)][0]?.segment ?? " "; const tailWidth = Math.max(0, available - visibleWidth(before) - visibleWidth(first)); const after = sliceByColumn(rawAfter.slice(first === " " && rawAfter.length === 0 ? 0 : first.length), 0, tailWidth, true); const marker = this.focused ? CURSOR_MARKER : ""; const content = `${before}${marker}\x1b[7m${first}\x1b[27m${after}`; return [prompt + content + " ".repeat(Math.max(0, available - visibleWidth(content)))];
  }
}
