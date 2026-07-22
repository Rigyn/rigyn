import type { Component } from "../tui.js";
import { truncateToWidth, visibleWidth } from "../utils.js";
export class TruncatedText implements Component {
  constructor(private text: string, private paddingX = 0, private paddingY = 0) {}
  invalidate(): void {}
  render(width: number): string[] {
    const blank = " ".repeat(width); const available = Math.max(1, width - this.paddingX * 2); const content = truncateToWidth(this.text.split("\n", 1)[0] ?? "", available); let line = " ".repeat(this.paddingX) + content + " ".repeat(this.paddingX); line += " ".repeat(Math.max(0, width - visibleWidth(line)));
    return [...Array.from({ length: this.paddingY }, () => blank), line, ...Array.from({ length: this.paddingY }, () => blank)];
  }
}
