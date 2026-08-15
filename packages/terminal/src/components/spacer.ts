import type { Component } from "../tui.js";
export class Spacer implements Component {
  constructor(readonly height = 1) {}
  render(): string[] { return Array.from({ length: Math.max(0, Math.trunc(this.height)) }, () => ""); }
  invalidate(): void {}
}
