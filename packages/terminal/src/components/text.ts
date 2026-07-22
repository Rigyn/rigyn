import type { Component } from "../tui.js";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.js";

export class Text implements Component {
  #text: string; #paddingX: number; #paddingY: number; #background: ((text: string) => string) | undefined;
  #cache: { text: string; width: number; lines: string[] } | undefined;
  constructor(text = "", paddingX = 1, paddingY = 1, customBgFn?: (text: string) => string) { this.#text = text; this.#paddingX = paddingX; this.#paddingY = paddingY; this.#background = customBgFn; }
  setText(value: string): void { this.#text = value; this.invalidate(); }
  setCustomBgFn(value?: (text: string) => string): void { this.#background = value; this.invalidate(); }
  invalidate(): void { this.#cache = undefined; }
  render(width: number): string[] {
    if (this.#cache?.text === this.#text && this.#cache.width === width) return this.#cache.lines;
    if (!this.#text.trim()) return [];
    const contentWidth = Math.max(1, width - this.#paddingX * 2); const side = " ".repeat(this.#paddingX);
    const fill = (line: string) => this.#background ? applyBackgroundToLine(line, width, this.#background) : line + " ".repeat(Math.max(0, width - visibleWidth(line)));
    const blank = fill(""); const lines = [...Array.from({ length: this.#paddingY }, () => blank), ...wrapTextWithAnsi(this.#text.replace(/\t/gu, "   "), contentWidth).map((line) => fill(side + line + side)), ...Array.from({ length: this.#paddingY }, () => blank)];
    this.#cache = { text: this.#text, width, lines }; return lines;
  }
}
