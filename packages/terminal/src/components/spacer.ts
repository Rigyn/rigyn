import type { Component } from "../tui.js";
export class Spacer implements Component {
  constructor(private lines = 1) {}
  setLines(value: number): void { this.lines = value; }
  invalidate(): void {}
  render(_width: number): string[] { return Array.from({ length: Math.max(0, this.lines) }, () => ""); }
}
