import { getKeybindings } from "../keybindings.js";
import type { Component } from "../tui.js";
import { truncateToWidth, visibleWidth } from "../utils.js";
export interface SelectItem { value: string; label: string; description?: string }
export interface SelectListTheme { selectedPrefix: (text: string) => string; selectedText: (text: string) => string; description: (text: string) => string; scrollInfo: (text: string) => string; noMatch: (text: string) => string }
export interface SelectListTruncatePrimaryContext { text: string; maxWidth: number; columnWidth: number; item: SelectItem; isSelected: boolean }
export interface SelectListLayoutOptions { minPrimaryColumnWidth?: number; maxPrimaryColumnWidth?: number; truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string }
export class SelectList implements Component {
  #filtered: SelectItem[]; #selected = 0; onSelect?: (item: SelectItem) => void; onCancel?: () => void; onSelectionChange?: (item: SelectItem) => void;
  constructor(private items: SelectItem[], private maxVisible: number, private theme: SelectListTheme, private layout: SelectListLayoutOptions = {}) { this.#filtered = items; }
  setFilter(value: string): void { this.#filtered = this.items.filter((item) => item.value.toLowerCase().startsWith(value.toLowerCase())); this.#selected = 0; }
  setSelectedIndex(index: number): void { this.#selected = Math.max(0, Math.min(index, this.#filtered.length - 1)); }
  invalidate(): void {}
  render(width: number): string[] {
    if (!this.#filtered.length) return [this.theme.noMatch("  No matching commands")]; const start = Math.max(0, Math.min(this.#selected - Math.floor(this.maxVisible / 2), this.#filtered.length - this.maxVisible)); const end = Math.min(start + this.maxVisible, this.#filtered.length);
    const minimum = this.layout.minPrimaryColumnWidth ?? this.layout.maxPrimaryColumnWidth ?? 32; const maximum = this.layout.maxPrimaryColumnWidth ?? this.layout.minPrimaryColumnWidth ?? 32; const widest = Math.max(...this.#filtered.map((item) => visibleWidth(item.label || item.value) + 2)); const column = Math.max(Math.min(minimum, maximum), Math.min(Math.max(minimum, maximum), widest)); const lines: string[] = [];
    for (let index = start; index < end; index += 1) { const item = this.#filtered[index]!; const selected = index === this.#selected; const prefix = selected ? "→ " : "  "; const text = item.label || item.value; const trunc = (max: number) => truncateToWidth(this.layout.truncatePrimary?.({ text, maxWidth: max, columnWidth: column, item, isSelected: selected }) ?? text, max, ""); let line: string;
      if (item.description && width > 40) { const main = trunc(Math.max(1, column - 2)); const spacing = " ".repeat(Math.max(1, column - visibleWidth(main))); const description = truncateToWidth(item.description.replace(/[\r\n]+/gu, " ").trim(), Math.max(1, width - visibleWidth(prefix + main + spacing) - 2), ""); line = selected ? this.theme.selectedText(prefix + main + spacing + description) : prefix + main + this.theme.description(spacing + description); }
      else { const main = trunc(Math.max(1, width - visibleWidth(prefix) - 2)); line = selected ? this.theme.selectedText(prefix + main) : prefix + main; } lines.push(line);
    }
    if (start > 0 || end < this.#filtered.length) lines.push(this.theme.scrollInfo(truncateToWidth(`  (${this.#selected + 1}/${this.#filtered.length})`, width - 2, ""))); return lines;
  }
  handleInput(data: string): void { const kb = getKeybindings(); if (!this.#filtered.length) { if (kb.matches(data, "tui.select.cancel")) this.onCancel?.(); return; } if (kb.matches(data, "tui.select.up")) this.#selected = this.#selected === 0 ? this.#filtered.length - 1 : this.#selected - 1; else if (kb.matches(data, "tui.select.down")) this.#selected = this.#selected === this.#filtered.length - 1 ? 0 : this.#selected + 1; else if (kb.matches(data, "tui.select.confirm")) { this.onSelect?.(this.#filtered[this.#selected]!); return; } else if (kb.matches(data, "tui.select.cancel")) { this.onCancel?.(); return; } else return; this.onSelectionChange?.(this.#filtered[this.#selected]!); }
  getSelectedItem(): SelectItem | null { return this.#filtered[this.#selected] ?? null; }
}
