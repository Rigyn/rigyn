import type { Component } from "../tui.js";
import { applyBackgroundToLine, visibleWidth } from "../utils.js";
export class Box implements Component {
  children: Component[] = []; #background: ((text: string) => string) | undefined;
  constructor(private paddingX = 1, private paddingY = 1, background?: (text: string) => string) { this.#background = background; }
  addChild(value: Component): void { this.children.push(value); }
  removeChild(value: Component): void { const index = this.children.indexOf(value); if (index >= 0) this.children.splice(index, 1); }
  clear(): void { this.children = []; }
  setBgFn(value?: (text: string) => string): void { this.#background = value; }
  invalidate(): void { for (const child of this.children) child.invalidate(); }
  render(width: number): string[] {
    if (!this.children.length) return []; const content = this.children.flatMap((child) => child.render(Math.max(1, width - this.paddingX * 2))); if (!content.length) return [];
    const fill = (line: string) => { const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line))); return this.#background ? applyBackgroundToLine(padded, width, this.#background) : padded; }; const blank = fill(""); const left = " ".repeat(this.paddingX);
    return [...Array.from({ length: this.paddingY }, () => blank), ...content.map((line) => fill(left + line)), ...Array.from({ length: this.paddingY }, () => blank)];
  }
}
