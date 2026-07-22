import type { TUI } from "../tui.js";
import { Text } from "./text.js";
export interface LoaderIndicatorOptions { frames?: string[]; intervalMs?: number }
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export class Loader extends Text {
  #frames = [...frames]; #delay = 80; #index = 0; #timer: ReturnType<typeof setInterval> | undefined; #verbatim = false; #message: string;
  constructor(private ui: TUI, private spinner: (text: string) => string, private color: (text: string) => string, message = "Loading...", indicator?: LoaderIndicatorOptions) { super("", 1, 0); this.#message = message; this.setIndicator(indicator); }
  override render(width: number): string[] { return ["", ...super.render(width)]; }
  start(): void { this.stop(); this.#update(); if (this.#frames.length > 1) this.#timer = setInterval(() => { this.#index = (this.#index + 1) % this.#frames.length; this.#update(); }, this.#delay); }
  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }
  setMessage(value: string): void { this.#message = value; this.#update(); }
  setIndicator(value?: LoaderIndicatorOptions): void { this.#verbatim = value !== undefined; this.#frames = value?.frames === undefined ? [...frames] : [...value.frames]; this.#delay = value?.intervalMs && value.intervalMs > 0 ? value.intervalMs : 80; this.#index = 0; this.start(); }
  #update(): void { const frame = this.#frames[this.#index] ?? ""; this.setText(`${frame ? `${this.#verbatim ? frame : this.spinner(frame)} ` : ""}${this.color(this.#message)}`); this.ui.requestRender(); }
}
