import { Container } from "../tui.js";
import { truncateToWidth } from "../utils.js";
export class Box extends Container {
  constructor(readonly paddingX = 1, readonly paddingY = 0, public border?: (value: string) => string) { super(); }
  setBgFn(style: ((value: string) => string) | undefined): void { this.border = style; }
  override render(width: number): string[] {
    const columns = Math.max(0, Math.trunc(width));
    if (columns === 0) return [];
    const leftPadding = Math.min(this.paddingX, columns);
    const rightPadding = Math.min(this.paddingX, columns - leftPadding);
    const inside = columns - leftPadding - rightPadding;
    const body = inside === 0 ? [] : super.render(inside);
    const line = (value: string) => this.border?.(value) ?? value;
    const rows = body.map((value) => line(
      `${" ".repeat(leftPadding)}${truncateToWidth(value, inside, "", true)}${" ".repeat(rightPadding)}`,
    ));
    const padding = Array.from({ length: this.paddingY }, () => line(" ".repeat(columns)));
    return [...padding, ...rows, ...padding];
  }
}
