import { fuzzyFilter } from "../fuzzy.js";
import { decodePrintableKey, matchesKey } from "../keys.js";
import type { Component } from "../tui.js";
import { truncateToWidth } from "../utils.js";
export interface SettingItem { id: string; label: string; currentValue: string; values?: readonly string[]; description?: string }
export interface SettingsListTheme { label: (value: string, selected: boolean) => string; value: (value: string, selected: boolean) => string; description: (value: string) => string; cursor: string; hint: (value: string) => string }
export interface SettingsListOptions { enableSearch?: boolean }
export class SettingsList implements Component {
  #selected = 0;
  #query = "";
  readonly #selectedValues = new Map<string, string>();
  constructor(readonly items: readonly SettingItem[], readonly height: number, readonly theme: SettingsListTheme, readonly onChange: (id: string, value: string) => void, readonly onCancel: () => void, readonly options: SettingsListOptions = {}) {}
  #visible(): readonly SettingItem[] { return this.#query === "" ? this.items : fuzzyFilter(this.items, this.#query, (item) => `${item.label} ${item.description ?? ""}`); }
  #apply(): void { const item = this.#visible()[this.#selected]; if (item === undefined || item.values?.length === 0 || item.values === undefined) return; const current = this.#selectedValues.get(item.id) ?? item.currentValue; const index = item.values.indexOf(current); const next = item.values[(index + 1) % item.values.length]!; this.#selectedValues.set(item.id, next); this.onChange(item.id, next); }
  handleInput(data: string): void {
    const values = this.#visible();
    if (matchesKey(data, "down")) this.#selected = Math.min(values.length - 1, this.#selected + 1);
    else if (matchesKey(data, "up")) this.#selected = Math.max(0, this.#selected - 1);
    else if (matchesKey(data, "escape")) this.onCancel();
    else if (matchesKey(data, "enter") || (matchesKey(data, "space") && this.#query === "")) this.#apply();
    else if (this.options.enableSearch) { const text = decodePrintableKey(data); if (text !== undefined && !data.startsWith("\x1b")) { this.#query += text; this.#selected = 0; } }
  }
  render(width: number): string[] { const columns = Math.max(0, Math.trunc(width)); if (columns === 0) return []; const visible = this.#visible(); if (visible.length === 0) return [truncateToWidth(this.theme.hint("No settings"), columns)]; return visible.slice(0, this.height).map((item, index) => { const selected = index === this.#selected; return truncateToWidth(`${selected ? this.theme.cursor : " ".repeat(this.theme.cursor.length)}${this.theme.label(item.label, selected)}: ${this.theme.value(this.#selectedValues.get(item.id) ?? item.currentValue, selected)}${item.description === undefined ? "" : ` ${this.theme.description(item.description)}`}`, columns); }); }
  invalidate(): void {}
}
