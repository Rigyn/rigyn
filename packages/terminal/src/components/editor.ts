import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "../autocomplete.js";
import { decodePrintableKey, matchesKey, parseKey } from "../keys.js";
import { MultilineEditor } from "../text-buffer.js";
import { CURSOR_MARKER, type Component } from "../tui.js";
import { splitGraphemes } from "../internal-unicode.js";
import { truncateToWidth, wrapTextWithAnsi } from "../utils.js";

export interface EditorTheme {
  borderColor: (value: string) => string;
  selectList: {
    selectedPrefix: (value: string) => string;
    selectedText: (value: string) => string;
    description: (value: string) => string;
    scrollInfo: (value: string) => string;
    noMatch: (value: string) => string;
  };
}

export interface EditorOptions {
  paddingX?: number;
  autocompleteMaxVisible?: number;
}

interface CompletionState {
  result: AutocompleteSuggestions;
  selected: number;
}

function wholeNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}

export class Editor implements Component {
  readonly #editor = new MultilineEditor();
  #provider: AutocompleteProvider | undefined;
  #completion: CompletionState | undefined;
  #completionRequest = 0;
  #historyReady = false;
  #paddingX: number;
  #autocompleteMaxVisible: number;
  focused = false;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;

  constructor(readonly tui: { requestRender(): void }, readonly theme: EditorTheme, options: EditorOptions = {}) {
    this.#paddingX = wholeNumber(options.paddingX ?? 0, 0);
    this.#autocompleteMaxVisible = Math.max(1, wholeNumber(options.autocompleteMaxVisible ?? 5, 5));
  }

  getText(): string { return this.#editor.text; }
  getExpandedText(): string { return this.#editor.snapshot().pastes?.reduce((text, paste) => text.replace(paste.label, paste.payload), this.#editor.text) ?? this.#editor.text; }
  getLines(): string[] { return this.#editor.text.split("\n"); }
  getCursor(): { line: number; col: number } {
    const before = splitGraphemes(this.#editor.text).slice(0, this.#editor.cursor).join("");
    const lines = before.split("\n");
    return { line: lines.length - 1, col: (lines.at(-1) ?? "").length };
  }
  getPaddingX(): number { return this.#paddingX; }
  setPaddingX(value: number): void { this.#paddingX = wholeNumber(value, this.#paddingX); this.tui.requestRender(); }
  getAutocompleteMaxVisible(): number { return this.#autocompleteMaxVisible; }
  setAutocompleteMaxVisible(value: number): void { this.#autocompleteMaxVisible = Math.max(1, wholeNumber(value, this.#autocompleteMaxVisible)); this.tui.requestRender(); }

  setText(value: string): void {
    const before = this.#editor.text;
    this.#editor.setText(value);
    this.#historyReady = false;
    this.#closeAutocomplete();
    this.#changed(before);
  }

  insertTextAtCursor(value: string): void {
    const before = this.#editor.text;
    this.#editor.insert(value);
    this.#historyReady = false;
    this.#closeAutocomplete();
    this.#changed(before);
  }

  addToHistory(value: string): void {
    const current = this.#editor.snapshot();
    this.#editor.setText(value);
    this.#editor.commitHistory();
    this.#editor.restore(current);
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.#provider = provider;
    this.#closeAutocomplete();
  }

  isShowingAutocomplete(): boolean { return this.#completion !== undefined; }

  async #complete(force: boolean): Promise<void> {
    const provider = this.#provider;
    if (provider === undefined) {
      if (force) this.insertTextAtCursor("  ");
      return;
    }
    const lines = this.getLines();
    const cursor = this.getCursor();
    if (force && provider.shouldTriggerFileCompletion?.(lines, cursor.line, cursor.col) === false) {
      this.insertTextAtCursor("  ");
      return;
    }
    const request = ++this.#completionRequest;
    try {
      const result = await provider.getSuggestions(lines, cursor.line, cursor.col, {
        signal: new AbortController().signal,
        force,
      });
      if (request !== this.#completionRequest) return;
      if (result === null || result.items.length === 0) {
        this.#completion = undefined;
        if (force) this.insertTextAtCursor("  ");
      } else {
        this.#completion = { result, selected: 0 };
        if (force && result.items.length === 1) this.#applyCompletion(result.items[0]!);
      }
    } catch {
      if (request === this.#completionRequest) this.#completion = undefined;
    }
    this.tui.requestRender();
  }

  #applyCompletion(item?: AutocompleteItem): void {
    const provider = this.#provider;
    const completion = this.#completion;
    const selected = item ?? completion?.result.items[completion.selected];
    if (provider === undefined || completion === undefined || selected === undefined) return;
    const before = this.#editor.text;
    const applied = provider.applyCompletion(
      this.getLines(),
      this.getCursor().line,
      this.getCursor().col,
      selected,
      completion.result.prefix,
    );
    const line = Math.max(0, Math.min(applied.lines.length - 1, Math.trunc(applied.cursorLine)));
    const value = applied.lines.join("\n");
    const local = applied.lines[line] ?? "";
    const column = Math.max(0, Math.min(local.length, Math.trunc(applied.cursorCol)));
    const preceding = applied.lines.slice(0, line).join("\n");
    const cursor = splitGraphemes(preceding).length
      + (line === 0 ? 0 : 1)
      + splitGraphemes(local.slice(0, column)).length;
    this.#editor.setText(value, cursor);
    this.#closeAutocomplete();
    this.#changed(before);
  }

  #closeAutocomplete(): void {
    this.#completionRequest += 1;
    this.#completion = undefined;
  }

  #changed(before: string): void {
    if (before !== this.#editor.text) this.onChange?.(this.#editor.text);
    this.tui.requestRender();
  }

  #shouldCompleteAfterTyping(): boolean {
    const triggers = this.#provider?.triggerCharacters ?? ["/", "@"];
    if (triggers.length === 0) return false;
    const before = splitGraphemes(this.#editor.text).slice(0, this.#editor.cursor).join("");
    const token = before.split(/\s/u).at(-1) ?? "";
    return triggers.some((trigger) => token.startsWith(trigger));
  }

  handleInput(data: string): void {
    const before = this.#editor.text;
    const paste = /^\x1b\[200~([\s\S]*)\x1b\[201~$/u.exec(data);
    if (paste !== null) {
      this.#editor.insertPaste(paste[1]!);
      this.#closeAutocomplete();
      this.#changed(before);
      return;
    }
    if (matchesKey(data, "escape") && this.#completion !== undefined) this.#closeAutocomplete();
    else if (matchesKey(data, "tab")) {
      if (this.#completion === undefined) void this.#complete(true);
      else this.#applyCompletion();
      return;
    } else if (matchesKey(data, "backspace")) this.#editor.backspace();
    else if (matchesKey(data, "delete")) this.#editor.deleteForward();
    else if (matchesKey(data, "left")) this.#editor.moveLeft();
    else if (matchesKey(data, "right")) this.#editor.moveRight();
    else if (matchesKey(data, "up")) {
      if (this.#completion !== undefined) this.#completion.selected = Math.max(0, this.#completion.selected - 1);
      else if (this.#editor.hasMultipleVisualRows(1_000_000)) this.#editor.moveUp();
      else if (this.#editor.text !== "" && !this.#historyReady) this.#historyReady = true;
      else { this.#editor.historyPrevious(); this.#historyReady = true; }
    } else if (matchesKey(data, "down")) {
      if (this.#completion !== undefined) this.#completion.selected = Math.min(this.#completion.result.items.length - 1, this.#completion.selected + 1);
      else if (this.#editor.hasMultipleVisualRows(1_000_000)) this.#editor.moveDown();
      else this.#editor.historyNext();
    } else if (matchesKey(data, "ctrl+left") || matchesKey(data, "alt+left") || matchesKey(data, "alt+b")) this.#editor.moveLeft(true);
    else if (matchesKey(data, "ctrl+right") || matchesKey(data, "alt+right") || matchesKey(data, "alt+f")) this.#editor.moveRight(true);
    else if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) this.#editor.moveHome();
    else if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) this.#editor.moveEnd();
    else if (matchesKey(data, "ctrl+w")) this.#editor.deleteWordBackward();
    else if (matchesKey(data, "alt+d")) this.#editor.deleteWordForward();
    else if (matchesKey(data, "ctrl+k")) this.#editor.deleteToLineEnd();
    else if (matchesKey(data, "ctrl+u")) this.#editor.deleteToLineStart();
    else if (matchesKey(data, "ctrl+y")) this.#editor.yank();
    else if (matchesKey(data, "alt+y")) this.#editor.yankPop();
    else if (matchesKey(data, "ctrl+z")) this.#editor.undo();
    else if (matchesKey(data, "ctrl+shift+z")) this.#editor.redo();
    else if (matchesKey(data, "shift+enter") || matchesKey(data, "ctrl+j")) this.#editor.insert("\n");
    else if (matchesKey(data, "enter")) {
      if (this.#completion !== undefined) this.#applyCompletion();
      else this.onSubmit?.(this.getExpandedText());
      return;
    } else {
      const printable = decodePrintableKey(data);
      if (printable !== undefined && parseKey(data)?.startsWith("alt+") !== true) {
        this.#editor.insert(printable);
        this.#historyReady = false;
      }
    }
    if (before !== this.#editor.text && this.#shouldCompleteAfterTyping()) void this.#complete(false);
    else if (before !== this.#editor.text) this.#closeAutocomplete();
    this.#changed(before);
  }

  render(width: number): string[] {
    const columns = Math.max(0, Math.trunc(width));
    if (columns === 0) return [];
    const bodyWidth = Math.max(1, columns - 2 - this.#paddingX * 2);
    const graphemes = splitGraphemes(this.#editor.text);
    if (this.focused) graphemes.splice(this.#editor.cursor, 0, CURSOR_MARKER);
    let body = graphemes.join("").split("\n").flatMap((line) => wrapTextWithAnsi(line, bodyWidth));
    if (body.length === 0) body = [this.focused ? CURSOR_MARKER : ""];
    const rows = body.map((line) => this.theme.borderColor(`│${" ".repeat(this.#paddingX)}${truncateToWidth(line, bodyWidth, "", true)}${" ".repeat(this.#paddingX)}│`));
    const horizontal = "─".repeat(Math.max(0, columns - 2));
    const output = [this.theme.borderColor(`┌${horizontal}┐`), ...rows, this.theme.borderColor(`└${horizontal}┘`)];
    if (this.#completion !== undefined) {
      const { items } = this.#completion.result;
      const start = Math.max(0, Math.min(this.#completion.selected, items.length - this.#autocompleteMaxVisible));
      output.push(...items.slice(start, start + this.#autocompleteMaxVisible).map((item, offset) => {
        const selected = start + offset === this.#completion!.selected;
        const prefix = selected ? this.theme.selectList.selectedPrefix("> ") : "  ";
        const label = selected ? this.theme.selectList.selectedText(item.label) : item.label;
        const description = item.description === undefined ? "" : ` ${this.theme.selectList.description(item.description)}`;
        return truncateToWidth(`${prefix}${label}${description}`, columns);
      }));
    }
    return output;
  }

  invalidate(): void { this.tui.requestRender(); }
}
