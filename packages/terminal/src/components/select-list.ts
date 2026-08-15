import { fuzzyFilter } from "../fuzzy.js";
import { decodePrintableKey, matchesKey } from "../keys.js";
import type { Component } from "../tui.js";
import { truncateToWidth } from "../utils.js";
export interface SelectItem<T = string> { value: T; label: string; description?: string }
export interface SelectListTheme { selectedPrefix: (value: string) => string; selectedText: (value: string) => string; description: (value: string) => string; scrollInfo: (value: string) => string; noMatch: (value: string) => string }
export interface SelectListLayoutOptions { enableSearch?: boolean }
export interface SelectListTruncatePrimaryContext { item: SelectItem; width: number; selected: boolean }
export class SelectList<T = string> implements Component {
  readonly #items: readonly SelectItem<T>[];
  readonly #height: number;
  readonly #theme: SelectListTheme;
  #selected = 0;
  #query = "";
  focused = false;
  onSelect?: (item: SelectItem<T>) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SelectItem<T>) => void;
  constructor(items: readonly SelectItem<T>[], height: number, theme: SelectListTheme, readonly options: SelectListLayoutOptions = {}) { this.#items = items; this.#height = Math.max(1, height); this.#theme = theme; }
  #visible(): readonly SelectItem<T>[] { return this.#query === "" ? this.#items : fuzzyFilter(this.#items, this.#query, (item) => `${item.label} ${item.description ?? ""}`); }
  getSelectedItem(): SelectItem<T> | undefined { return this.#visible()[this.#selected]; }
  setSelectedIndex(index: number): void { this.#select(index); }
  #select(index: number): void {
    const visible = this.#visible();
    const next = visible.length === 0 ? 0 : Math.max(0, Math.min(visible.length - 1, Math.trunc(index)));
    if (next === this.#selected) return;
    this.#selected = next;
    const selected = this.getSelectedItem();
    if (selected !== undefined) this.onSelectionChange?.(selected);
  }
  handleInput(data: string): void {
    const visible = this.#visible();
    if (matchesKey(data, "down")) this.#select(Math.min(visible.length - 1, this.#selected + 1));
    else if (matchesKey(data, "up")) this.#select(Math.max(0, this.#selected - 1));
    else if (matchesKey(data, "enter")) { const selected = this.getSelectedItem(); if (selected !== undefined) this.onSelect?.(selected); }
    else if (matchesKey(data, "escape")) this.onCancel?.();
    else if (this.options.enableSearch) { const text = decodePrintableKey(data); if (text !== undefined && !data.startsWith("\x1b")) { this.#query += text; this.#selected = 0; const selected = this.getSelectedItem(); if (selected !== undefined) this.onSelectionChange?.(selected); } }
  }
  render(width: number): string[] {
    const columns = Math.max(0, Math.trunc(width));
    if (columns === 0) return [];
    const visible = this.#visible();
    if (visible.length === 0) return [truncateToWidth(this.#theme.noMatch("No matches"), columns)];
    const start = Math.max(0, Math.min(this.#selected, visible.length - this.#height));
    return visible.slice(start, start + this.#height).map((item, offset) => {
      const selected = start + offset === this.#selected;
      const prefix = selected ? this.#theme.selectedPrefix("> ") : "  ";
      const label = selected ? this.#theme.selectedText(item.label) : item.label;
      const detail = item.description === undefined ? "" : ` ${this.#theme.description(item.description)}`;
      return truncateToWidth(`${prefix}${label}${detail}`, columns);
    });
  }
  invalidate(): void {}
}
