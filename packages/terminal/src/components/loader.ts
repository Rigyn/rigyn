import { scheduleInterval, type ManagedTimeout, validateTimerDelay } from "../internal-timer.js";
import type { Component } from "../tui.js";
import { truncateToWidth } from "../utils.js";

export interface LoaderIndicatorOptions { frames?: readonly string[]; intervalMs?: number }

export class Loader implements Component {
  readonly #tui: { requestRender(): void };
  readonly #activeStyle: (value: string) => string;
  readonly #messageStyle: (value: string) => string;
  readonly #message: string;
  readonly #frames: readonly string[];
  readonly #timer: ManagedTimeout;
  #frame = 0;

  constructor(
    tui: { requestRender(): void },
    activeStyle: (value: string) => string,
    messageStyle: (value: string) => string,
    message = "Loading",
    options: LoaderIndicatorOptions = {},
  ) {
    this.#tui = tui;
    this.#activeStyle = activeStyle;
    this.#messageStyle = messageStyle;
    this.#message = message;
    this.#frames = options.frames?.length ? options.frames : ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const interval = validateTimerDelay(options.intervalMs === undefined ? 80 : options.intervalMs, "loader interval");
    this.#tui.requestRender();
    this.#timer = scheduleInterval(() => { this.#frame = (this.#frame + 1) % this.#frames.length; this.#tui.requestRender(); }, interval === 0 ? 80 : interval);
  }
  render(width: number): string[] { return [truncateToWidth(`${this.#activeStyle(this.#frames[this.#frame]!)} ${this.#messageStyle(this.#message)}`, width)]; }
  stop(): void { this.#timer.clear(); }
  dispose(): void { this.stop(); }
  invalidate(): void { this.#tui.requestRender(); }
}
