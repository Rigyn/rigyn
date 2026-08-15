import type { Component } from "../tui.js";
import { truncateToWidth, wrapTextWithAnsi } from "../utils.js";

export class Text implements Component {
  constructor(public text: string, readonly paddingX = 0, readonly paddingY = 0, readonly style?: (value: string) => string) {}
  setText(value: string): void { this.text = value; }
  render(width: number): string[] {
    const columns = Math.max(0, Math.trunc(width));
    if (columns === 0) return [];
    const inside = Math.max(1, columns - this.paddingX * 2);
    const rows = this.text.split("\n").flatMap((line) => wrapTextWithAnsi(line, inside)).map((line) => truncateToWidth(`${" ".repeat(this.paddingX)}${this.style?.(line) ?? line}`, columns, "", true));
    return [...Array.from({ length: this.paddingY }, () => ""), ...rows, ...Array.from({ length: this.paddingY }, () => "")];
  }
  invalidate(): void {}
}
