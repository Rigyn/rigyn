import { fuzzyFilter } from "../fuzzy.js";
import { getKeybindings } from "../keybindings.js";
import type { Component } from "../tui.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.js";
import { Input } from "./input.js";
export interface SettingItem { id: string; label: string; description?: string; currentValue: string; values?: string[]; submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component }
export interface SettingsListTheme { label: (text: string, selected: boolean) => string; value: (text: string, selected: boolean) => string; description: (text: string) => string; cursor: string; hint: (text: string) => string }
export interface SettingsListOptions { enableSearch?: boolean }
export class SettingsList implements Component {
  #filtered: SettingItem[]; #selected = 0; #submenu: Component | undefined; #submenuIndex: number | undefined; #search: Input | undefined; readonly #searchEnabled: boolean;
  constructor(private items: SettingItem[], private maxVisible: number, private theme: SettingsListTheme, private onChange: (id: string, value: string) => void, private onCancel: () => void, options: SettingsListOptions = {}) { this.#filtered = items; this.#searchEnabled = options.enableSearch ?? false; if (this.#searchEnabled) this.#search = new Input(); }
  updateValue(id: string, value: string): void { const item = this.items.find((candidate) => candidate.id === id); if (item) item.currentValue = value; }
  invalidate(): void { this.#submenu?.invalidate(); }
  render(width: number): string[] {
    if (this.#submenu) return this.#submenu.render(width); const lines: string[] = []; if (this.#search) lines.push(...this.#search.render(width), ""); const display = this.#searchEnabled ? this.#filtered : this.items;
    if (!this.items.length) { lines.push(this.theme.hint("  No settings available")); if (this.#searchEnabled) this.#hint(lines, width); return lines; }
    if (!display.length) { lines.push(truncateToWidth(this.theme.hint("  No matching settings"), width)); this.#hint(lines, width); return lines; }
    const start = Math.max(0, Math.min(this.#selected - Math.floor(this.maxVisible / 2), display.length - this.maxVisible)); const end = Math.min(start + this.maxVisible, display.length); const labelWidth = Math.min(30, Math.max(...this.items.map((item) => visibleWidth(item.label))));
    for (let index = start; index < end; index += 1) { const item = display[index]!; const selected = index === this.#selected; const prefix = selected ? this.theme.cursor : "  "; const label = item.label + " ".repeat(Math.max(0, labelWidth - visibleWidth(item.label))); const used = visibleWidth(prefix) + labelWidth + 2; const value = truncateToWidth(item.currentValue, Math.max(1, width - used - 2), ""); lines.push(truncateToWidth(prefix + this.theme.label(label, selected) + "  " + this.theme.value(value, selected), width)); }
    if (start > 0 || end < display.length) lines.push(this.theme.hint(truncateToWidth(`  (${this.#selected + 1}/${display.length})`, width - 2, ""))); const item = display[this.#selected]; if (item?.description) lines.push("", ...wrapTextWithAnsi(item.description, width - 4).map((line) => this.theme.description(`  ${line}`))); this.#hint(lines, width); return lines;
  }
  handleInput(data: string): void {
    if (this.#submenu) { this.#submenu.handleInput?.(data); return; } const display = this.#searchEnabled ? this.#filtered : this.items; const kb = getKeybindings();
    if (kb.matches(data, "tui.select.up") && display.length) this.#selected = this.#selected === 0 ? display.length - 1 : this.#selected - 1;
    else if (kb.matches(data, "tui.select.down") && display.length) this.#selected = this.#selected === display.length - 1 ? 0 : this.#selected + 1;
    else if (kb.matches(data, "tui.select.confirm") || data === " ") this.#activate(display[this.#selected]);
    else if (kb.matches(data, "tui.select.cancel")) this.onCancel();
    else if (this.#search) { const value = data.replace(/ /gu, ""); if (value) { this.#search.handleInput(value); this.#filtered = fuzzyFilter(this.items, this.#search.getValue(), (item) => item.label); this.#selected = 0; } }
  }
  #activate(item?: SettingItem): void { if (!item) return; if (item.submenu) { this.#submenuIndex = this.#selected; this.#submenu = item.submenu(item.currentValue, (value) => { if (value !== undefined) { item.currentValue = value; this.onChange(item.id, value); } this.#submenu = undefined; if (this.#submenuIndex !== undefined) this.#selected = this.#submenuIndex; this.#submenuIndex = undefined; }); } else if (item.values?.length) { const value = item.values[(item.values.indexOf(item.currentValue) + 1) % item.values.length]!; item.currentValue = value; this.onChange(item.id, value); } }
  #hint(lines: string[], width: number): void { lines.push("", truncateToWidth(this.theme.hint(this.#searchEnabled ? "  Type to search · Enter/Space to change · Esc to cancel" : "  Enter/Space to change · Esc to cancel"), width)); }
}
