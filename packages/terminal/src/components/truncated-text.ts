import type { Component } from "../tui.js";
import { truncateToWidth } from "../utils.js";
export class TruncatedText implements Component {
  constructor(readonly text: string, readonly paddingX = 0, readonly paddingY = 0, readonly style?: (value: string) => string) {}
  render(width: number): string[] {
    const columns = Math.max(0, Math.trunc(width));
    if (columns === 0) return [];
    const value = truncateToWidth(this.text, Math.max(0, columns - 2 * this.paddingX), "...", true);
    const line = truncateToWidth(`${" ".repeat(this.paddingX)}${this.style?.(value) ?? value}${" ".repeat(this.paddingX)}`, columns, "", true);
    return [...Array.from({ length: this.paddingY }, () => ""), line, ...Array.from({ length: this.paddingY }, () => "")];
  }
  invalidate(): void {}
}
