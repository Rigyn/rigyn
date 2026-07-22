import type { AutocompleteProvider, AutocompleteSuggestions } from "../autocomplete.js";
import { getKeybindings } from "../keybindings.js";
import { decodePrintableKey, matchesKey } from "../keys.js";
import { splitGraphemes } from "../internal-unicode.js";
import { MultilineEditor, type EditorSnapshot } from "../text-buffer.js";
import { type Component, CURSOR_MARKER, type Focusable, type TUI } from "../tui.js";
import { getGraphemeSegmenter, truncateToWidth, visibleWidth } from "../utils.js";
import { wordWrapLine } from "../word-wrap.js";
export { wordWrapLine, type TextChunk } from "../word-wrap.js";
import { SelectList, type SelectListLayoutOptions, type SelectListTheme } from "./select-list.js";

const graphemes = getGraphemeSegmenter();

export interface EditorTheme {
  borderColor: (text: string) => string;
  selectList: SelectListTheme;
}

export interface EditorOptions {
  paddingX?: number;
  autocompleteMaxVisible?: number;
}

interface VisualLine {
  text: string;
  sourceStart: number;
  sourceEnd: number;
  cursorOffset?: number;
}

type CompletionMode = "regular" | "force";

const commandLayout: SelectListLayoutOptions = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 };

function finiteInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

function cursorOffset(snapshot: EditorSnapshot): number {
  return splitGraphemes(snapshot.text).slice(0, snapshot.cursor).join("").length;
}

function normalizePaste(value: string): string {
  return value
    .replace(/\x1b\[(\d+);5u/gu, (whole, raw: string) => {
      const code = Number(raw);
      if (code >= 65 && code <= 90) return String.fromCharCode(code - 64);
      if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
      return whole;
    })
    .replace(/\r\n|\r/gu, "\n")
    .replace(/\t/gu, "    ")
    .split("")
    .filter((character) => character === "\n" || character.charCodeAt(0) >= 32)
    .join("");
}

export class Editor implements Component, Focusable {
  protected tui: TUI;
  #buffer = new MultilineEditor();
  #paddingX: number;
  #autocompleteMaxVisible: number;
  #provider: AutocompleteProvider | undefined;
  #completionList: SelectList | undefined;
  #completionPrefix = "";
  #completionMode: CompletionMode | undefined;
  #completionAbort: AbortController | undefined;
  #completionTimer: ReturnType<typeof setTimeout> | undefined;
  #completionRequest = 0;
  #paste = "";
  #pasting = false;
  #history: string[] = [];
  #historyIndex = -1;
  #historyDraft: EditorSnapshot | undefined;
  #jump: -1 | 1 | undefined;
  #lastLayoutWidth = 79;
  #scrollOffset = 0;

  focused = false;
  disableSubmit = false;
  borderColor: (text: string) => string;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;

  constructor(tui: TUI, private readonly theme: EditorTheme, options: EditorOptions = {}) {
    this.tui = tui;
    this.#paddingX = Math.max(0, finiteInteger(options.paddingX ?? 0, 0));
    this.#autocompleteMaxVisible = Math.max(3, Math.min(20, finiteInteger(options.autocompleteMaxVisible ?? 5, 5)));
    this.borderColor = theme.borderColor;
  }

  getPaddingX(): number { return this.#paddingX; }
  setPaddingX(value: number): void {
    const selected = Math.max(0, finiteInteger(value, 0));
    if (selected === this.#paddingX) return;
    this.#paddingX = selected;
    this.tui.requestRender();
  }
  getAutocompleteMaxVisible(): number { return this.#autocompleteMaxVisible; }
  setAutocompleteMaxVisible(value: number): void {
    const selected = Math.max(3, Math.min(20, finiteInteger(value, 5)));
    if (selected === this.#autocompleteMaxVisible) return;
    this.#autocompleteMaxVisible = selected;
    this.tui.requestRender();
  }
  setAutocompleteProvider(provider: AutocompleteProvider): void { this.#cancelCompletion(); this.#provider = provider; }
  addToHistory(value: string): void {
    const selected = value.trim();
    if (!selected || this.#history[0] === selected) return;
    this.#history.unshift(selected);
    if (this.#history.length > 100) this.#history.length = 100;
  }
  invalidate(): void {}
  getText(): string { return this.#buffer.text; }
  getExpandedText(): string {
    const snapshot = this.#buffer.snapshot();
    let result = snapshot.text;
    for (const paste of [...(snapshot.pastes ?? [])].sort((left, right) => right.start - left.start)) {
      const split = splitGraphemes(result);
      result = split.slice(0, paste.start).join("") + paste.payload + split.slice(paste.end).join("");
    }
    return result;
  }
  getLines(): string[] { return this.getText().split("\n"); }
  getCursor(): { line: number; col: number } {
    const before = this.getText().slice(0, cursorOffset(this.#buffer.snapshot())).split("\n");
    return { line: before.length - 1, col: before.at(-1)?.length ?? 0 };
  }
  setText(text: string): void {
    this.#cancelCompletion();
    this.#leaveHistory();
    const before = this.getText();
    this.#buffer.setText(text.replace(/\r\n|\r/gu, "\n").replace(/\t/gu, "    "));
    if (before !== this.getText()) this.#changed();
  }
  insertTextAtCursor(text: string): void {
    if (!text) return;
    this.#leaveHistory();
    this.#buffer.insert(text.replace(/\r\n|\r/gu, "\n").replace(/\t/gu, "    "));
    this.#changed();
  }
  isShowingAutocomplete(): boolean { return this.#completionMode !== undefined; }

  render(width: number): string[] {
    const padding = Math.min(this.#paddingX, Math.max(0, Math.floor((width - 1) / 2)));
    const contentWidth = Math.max(1, width - padding * 2);
    const layoutWidth = Math.max(1, contentWidth - (padding === 0 ? 1 : 0));
    this.#lastLayoutWidth = layoutWidth;
    const snapshot = this.#buffer.snapshot();
    const cursor = cursorOffset(snapshot);
    const layout = this.#layout(snapshot.text, cursor, layoutWidth);
    const maximum = Math.max(5, Math.floor(this.tui.terminal.rows * 0.3));
    const cursorLine = Math.max(0, layout.findIndex((line) => line.cursorOffset !== undefined));
    if (cursorLine < this.#scrollOffset) this.#scrollOffset = cursorLine;
    else if (cursorLine >= this.#scrollOffset + maximum) this.#scrollOffset = cursorLine - maximum + 1;
    this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, Math.max(0, layout.length - maximum)));
    const visible = layout.slice(this.#scrollOffset, this.#scrollOffset + maximum);
    const left = " ".repeat(padding);
    const horizontal = this.borderColor("─");
    const result: string[] = [];

    if (this.#scrollOffset > 0) {
      const label = `─── ↑ ${this.#scrollOffset} more `;
      result.push(this.borderColor(truncateToWidth(label + "─".repeat(Math.max(0, width - visibleWidth(label))), width, "")));
    } else result.push(horizontal.repeat(width));

    for (const line of visible) {
      let display = line.text;
      let lineWidth = visibleWidth(display);
      if (line.cursorOffset !== undefined) {
        const before = display.slice(0, line.cursorOffset);
        const after = display.slice(line.cursorOffset);
        const first = [...graphemes.segment(after)][0]?.segment ?? " ";
        const tail = after.slice(first === " " && after.length === 0 ? 0 : first.length);
        display = `${before}${this.focused ? CURSOR_MARKER : ""}\x1b[7m${first}\x1b[0m${tail}`;
        if (after.length === 0) lineWidth += 1;
      }
      result.push(`${left}${display}${" ".repeat(Math.max(0, contentWidth - lineWidth))}${left.slice(lineWidth > contentWidth ? 1 : 0)}`);
    }

    const below = layout.length - this.#scrollOffset - visible.length;
    if (below > 0) {
      const label = `─── ↓ ${below} more `;
      result.push(this.borderColor(truncateToWidth(label + "─".repeat(Math.max(0, width - visibleWidth(label))), width, "")));
    } else result.push(horizontal.repeat(width));

    if (this.#completionList !== undefined) {
      for (const line of this.#completionList.render(contentWidth)) {
        result.push(`${left}${line}${" ".repeat(Math.max(0, contentWidth - visibleWidth(line)))}${left}`);
      }
    }
    return result;
  }

  handleInput(input: string): void {
    let data = input;
    if (this.#jump !== undefined) {
      const kb = getKeybindings();
      if (kb.matches(data, "tui.editor.jumpForward") || kb.matches(data, "tui.editor.jumpBackward")) { this.#jump = undefined; return; }
      const character = decodePrintableKey(data) ?? (data.charCodeAt(0) >= 32 ? [...data][0] : undefined);
      const direction = this.#jump;
      this.#jump = undefined;
      if (character !== undefined) this.#buffer.jumpToCharacter(character, direction);
      return;
    }

    if (data.includes("\x1b[200~")) { this.#pasting = true; this.#paste = ""; data = data.replace("\x1b[200~", ""); }
    if (this.#pasting) {
      this.#paste += data;
      const end = this.#paste.indexOf("\x1b[201~");
      if (end < 0) return;
      const content = normalizePaste(this.#paste.slice(0, end));
      const remainder = this.#paste.slice(end + 6);
      this.#paste = "";
      this.#pasting = false;
      if (content) {
        const prefix = this.#buffer.cursor > 0 ? splitGraphemes(this.#buffer.text)[this.#buffer.cursor - 1] : undefined;
        this.#buffer.insertPaste(/^[/~.]/u.test(content) && prefix !== undefined && /\w/u.test(prefix) ? ` ${content}` : content);
        this.#leaveHistory();
        this.#changed();
      }
      if (remainder) this.handleInput(remainder);
      return;
    }

    const kb = getKeybindings();
    if (kb.matches(data, "tui.input.copy")) return;
    if (this.#completionList !== undefined) {
      if (kb.matches(data, "tui.select.cancel")) { this.#cancelCompletion(); return; }
      if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) { this.#completionList.handleInput(data); return; }
      if (kb.matches(data, "tui.input.tab") || kb.matches(data, "tui.select.confirm")) {
        const slash = this.#completionPrefix.startsWith("/");
        if (this.#applySelectedCompletion() && (!slash || kb.matches(data, "tui.input.tab"))) return;
      }
    }
    if (kb.matches(data, "tui.input.tab")) { this.#requestCompletion(true, true); return; }
    if (kb.matches(data, "tui.editor.undo")) { if (this.#buffer.undo()) this.#changed(false); this.#leaveHistory(); return; }
    if (kb.matches(data, "tui.editor.cursorUp")) { if (!this.#moveHistory(-1)) this.#buffer.moveUp(this.#lastLayoutWidth); return; }
    if (kb.matches(data, "tui.editor.cursorDown")) { if (!this.#moveHistory(1)) this.#buffer.moveDown(this.#lastLayoutWidth); return; }

    const before = this.getText();
    if (kb.matches(data, "tui.editor.deleteToLineEnd")) this.#buffer.deleteToLineEnd();
    else if (kb.matches(data, "tui.editor.deleteToLineStart")) this.#buffer.deleteToLineStart();
    else if (kb.matches(data, "tui.editor.deleteWordBackward")) this.#buffer.deleteWordBackward();
    else if (kb.matches(data, "tui.editor.deleteWordForward")) this.#buffer.deleteWordForward();
    else if (kb.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace")) this.#buffer.backspace();
    else if (kb.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete")) this.#buffer.deleteForward();
    else if (kb.matches(data, "tui.editor.yank")) this.#buffer.yank();
    else if (kb.matches(data, "tui.editor.yankPop")) this.#buffer.yankPop();
    else if (kb.matches(data, "tui.editor.cursorLineStart")) this.#buffer.moveHome();
    else if (kb.matches(data, "tui.editor.cursorLineEnd")) this.#buffer.moveEnd();
    else if (kb.matches(data, "tui.editor.cursorWordLeft")) this.#buffer.moveLeft(true);
    else if (kb.matches(data, "tui.editor.cursorWordRight")) this.#buffer.moveRight(true);
    else if (kb.matches(data, "tui.editor.pageUp")) this.#buffer.movePage(-1, this.#lastLayoutWidth, Math.max(5, Math.floor(this.tui.terminal.rows * 0.3)));
    else if (kb.matches(data, "tui.editor.pageDown")) this.#buffer.movePage(1, this.#lastLayoutWidth, Math.max(5, Math.floor(this.tui.terminal.rows * 0.3)));
    else if (kb.matches(data, "tui.editor.jumpForward")) { this.#jump = 1; return; }
    else if (kb.matches(data, "tui.editor.jumpBackward")) { this.#jump = -1; return; }
    else if (kb.matches(data, "tui.editor.cursorLeft")) this.#buffer.moveLeft();
    else if (kb.matches(data, "tui.editor.cursorRight")) this.#buffer.moveRight();
    else if (kb.matches(data, "tui.input.newLine") || data === "\n") this.#buffer.insert("\n");
    else if (kb.matches(data, "tui.input.submit")) {
      if (this.disableSubmit) return;
      if (this.#characterBeforeCursor() === "\\") { this.#buffer.backspace(); this.#buffer.insert("\n"); this.#changed(); return; }
      this.#submit();
      return;
    } else if (matchesKey(data, "shift+space")) this.#buffer.insert(" ");
    else {
      const printable = decodePrintableKey(data);
      if (printable === undefined) return;
      this.#buffer.insert(printable);
    }

    if (this.getText() !== before) { this.#leaveHistory(); this.#changed(); }
    if (this.#completionMode !== undefined) this.#requestCompletion(this.#completionMode === "force", false);
    else if (this.#shouldComplete()) this.#requestCompletion(false, false);
  }

  #layout(text: string, cursor: number, width: number): VisualLine[] {
    const output: VisualLine[] = [];
    let documentOffset = 0;
    const lines = text.split("\n");
    for (const line of lines) {
      const chunks = wordWrapLine(line, width);
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        const last = index === chunks.length - 1;
        const start = documentOffset + chunk.startIndex;
        const end = documentOffset + chunk.endIndex;
        const contains = cursor >= start && (cursor < end || last && cursor === end);
        output.push({ text: chunk.text, sourceStart: start, sourceEnd: end, ...(contains ? { cursorOffset: Math.min(chunk.text.length, cursor - start) } : {}) });
      }
      documentOffset += line.length + 1;
    }
    if (output.length === 0) output.push({ text: "", sourceStart: 0, sourceEnd: 0, cursorOffset: 0 });
    return output;
  }

  #characterBeforeCursor(): string | undefined { return splitGraphemes(this.#buffer.text)[this.#buffer.cursor - 1]; }
  #changed(render = true): void { this.onChange?.(this.getText()); if (render) this.tui.requestRender(); }
  #leaveHistory(): void { this.#historyIndex = -1; this.#historyDraft = undefined; }
  #moveHistory(direction: -1 | 1): boolean {
    const cursor = this.getCursor();
    const lines = this.getLines();
    const atTop = cursor.line === 0 && cursor.col === 0;
    const atBottom = cursor.line === lines.length - 1 && cursor.col === (lines.at(-1)?.length ?? 0);
    if (this.#historyIndex >= 0 && lines.length > 1) {
      if (direction < 0 && !atTop) return false;
      if (direction > 0 && !atBottom) return false;
    }
    if (direction < 0 && !atTop && !(this.getText() === "" || this.#historyIndex >= 0)) return false;
    if (direction > 0 && this.#historyIndex < 0) return false;
    const next = this.#historyIndex - direction;
    if (next < -1 || next >= this.#history.length) return false;
    const entering = this.#historyIndex < 0 && next >= 0;
    if (entering) this.#historyDraft = this.#buffer.snapshot();
    this.#historyIndex = next;
    if (next < 0) this.#buffer.restore(this.#historyDraft ?? { text: "", cursor: 0 });
    else {
      const value = this.#history[next] ?? "";
      const selectedCursor = direction < 0 ? 0 : splitGraphemes(value).length;
      if (entering) this.#buffer.setText(value, selectedCursor);
      else this.#buffer.restore({ text: value, cursor: selectedCursor });
    }
    this.#changed();
    return true;
  }
  #submit(): void {
    this.#cancelCompletion();
    const result = this.getExpandedText().trim();
    this.#buffer = new MultilineEditor();
    this.#leaveHistory();
    this.#scrollOffset = 0;
    this.onChange?.("");
    this.onSubmit?.(result);
  }
  #shouldComplete(): boolean {
    if (this.#provider === undefined) return false;
    const cursor = this.getCursor();
    const before = (this.getLines()[cursor.line] ?? "").slice(0, cursor.col);
    if (cursor.line === 0 && before.trimStart().startsWith("/")) return true;
    const triggers = ["@", "#", ...(this.#provider.triggerCharacters ?? [])].filter((value, index, all) => value.length === 1 && all.indexOf(value) === index);
    return triggers.some((trigger) => new RegExp(`(?:^|\\s)${trigger.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[^\\s]*$`, "u").test(before));
  }
  #requestCompletion(force: boolean, explicit: boolean): void {
    if (this.#provider === undefined) return;
    const cursor = this.getCursor();
    if (force && this.#provider.shouldTriggerFileCompletion?.(this.getLines(), cursor.line, cursor.col) === false) return;
    this.#completionAbort?.abort();
    if (this.#completionTimer !== undefined) clearTimeout(this.#completionTimer);
    const request = ++this.#completionRequest;
    const run = () => {
      const controller = new AbortController();
      this.#completionAbort = controller;
      const snapshot = this.getText();
      void this.#provider!.getSuggestions(this.getLines(), cursor.line, cursor.col, { signal: controller.signal, force })
        .then((suggestions) => {
          if (controller.signal.aborted || request !== this.#completionRequest || snapshot !== this.getText()) return;
          if (suggestions === null || !Array.isArray(suggestions.items) || suggestions.items.length === 0) { this.#clearCompletion(); return; }
          if (force && explicit && suggestions.items.length === 1) { this.#applySuggestion(suggestions, suggestions.items[0]!); return; }
          this.#showCompletion(suggestions, force ? "force" : "regular");
        })
        .catch((error: unknown) => { if (!(error instanceof Error && error.name === "AbortError")) this.#clearCompletion(); });
    };
    const line = this.getLines()[cursor.line]?.slice(0, cursor.col) ?? "";
    const triggers = ["@", "#", ...(this.#provider.triggerCharacters ?? [])]
      .filter((value, index, all) => value.length === 1 && all.indexOf(value) === index);
    const debounced = triggers.some((trigger) => new RegExp(
      `(?:^|\\s)${trigger.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[^\\s]*$`,
      "u",
    ).test(line));
    if (!explicit && !force && debounced) this.#completionTimer = setTimeout(run, 20);
    else run();
  }
  #showCompletion(suggestions: AutocompleteSuggestions, mode: CompletionMode): void {
    this.#completionPrefix = suggestions.prefix;
    this.#completionMode = mode;
    this.#completionList = new SelectList(suggestions.items, this.#autocompleteMaxVisible, this.theme.selectList, suggestions.prefix.startsWith("/") ? commandLayout : {});
    const exact = suggestions.items.findIndex((item) => item.value === suggestions.prefix || item.value.startsWith(suggestions.prefix));
    if (exact >= 0) this.#completionList.setSelectedIndex(exact);
    this.tui.requestRender();
  }
  #applySelectedCompletion(): boolean {
    const selected = this.#completionList?.getSelectedItem();
    if (selected === null || selected === undefined || this.#provider === undefined) return false;
    this.#applySuggestion({ items: [selected], prefix: this.#completionPrefix }, selected);
    return true;
  }
  #applySuggestion(suggestions: AutocompleteSuggestions, selected: { value: string; label: string; description?: string }): void {
    const cursor = this.getCursor();
    const result = this.#provider!.applyCompletion(this.getLines(), cursor.line, cursor.col, selected, suggestions.prefix);
    const text = result.lines.join("\n");
    const beforeCursor = result.lines.slice(0, result.cursorLine).reduce((sum, line) => sum + splitGraphemes(line).length + 1, 0);
    const local = splitGraphemes(result.lines[result.cursorLine]?.slice(0, result.cursorCol) ?? "").length;
    this.#buffer.setText(text, beforeCursor + local);
    this.#clearCompletion();
    this.#changed();
  }
  #clearCompletion(): void {
    this.#completionList = undefined;
    this.#completionPrefix = "";
    this.#completionMode = undefined;
    this.tui.requestRender();
  }
  #cancelCompletion(): void {
    this.#completionRequest += 1;
    this.#completionAbort?.abort();
    this.#completionAbort = undefined;
    if (this.#completionTimer !== undefined) clearTimeout(this.#completionTimer);
    this.#completionTimer = undefined;
    this.#clearCompletion();
  }
}
