import { MultilineEditor } from "../text-buffer.js";
import { decodePrintableKey, matchesKey } from "../keys.js";
import type { Component } from "../tui.js";
import { splitGraphemes } from "../internal-unicode.js";
import { sliceByColumn, visibleWidth } from "../utils.js";

export class Input implements Component {
  readonly #editor = new MultilineEditor();
  focused = false;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  getValue(): string { return this.#editor.text; }
  setValue(value: string): void { this.#editor.setText(value); }
  handleInput(data: string): void {
    const paste = /^\x1b\[200~([\s\S]*)\x1b\[201~$/u.exec(data);
    if (paste !== null) { this.#editor.insertPaste(paste[1]!); return; }
    if (matchesKey(data, "escape")) this.onEscape?.();
    else if (matchesKey(data, "backspace")) this.#editor.backspace();
    else if (matchesKey(data, "delete")) this.#editor.deleteForward();
    else if (matchesKey(data, "left")) this.#editor.moveLeft();
    else if (matchesKey(data, "right")) this.#editor.moveRight();
    else if (matchesKey(data, "ctrl+left") || matchesKey(data, "alt+left")) this.#editor.moveLeft(true);
    else if (matchesKey(data, "ctrl+right") || matchesKey(data, "alt+right")) this.#editor.moveRight(true);
    else if (matchesKey(data, "ctrl+w")) this.#editor.deleteWordBackward();
    else if (matchesKey(data, "ctrl+y")) this.#editor.yank();
    else if (matchesKey(data, "ctrl+z")) this.#editor.undo();
    else if (matchesKey(data, "ctrl+shift+z")) this.#editor.redo();
    else if (matchesKey(data, "enter")) this.onSubmit?.(this.#editor.text);
    else { const printable = decodePrintableKey(data); if (printable !== undefined && !data.startsWith("\x1b")) this.#editor.insert(printable); }
  }
  render(width: number): string[] {
    const columns = Math.max(0, Math.trunc(width));
    if (columns === 0) return [];
    const value = this.#editor.text.replaceAll("\n", " ");
    const cursorText = splitGraphemes(value).slice(0, this.#editor.cursor).join("");
    const start = Math.max(0, visibleWidth(cursorText) - columns + 1);
    return [sliceByColumn(value, start, columns, true)];
  }
  invalidate(): void {}
}
