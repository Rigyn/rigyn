import { EventEmitter } from "node:events";

import { scheduleTimeout, type ManagedTimeout, validateTimerDelay } from "./internal-timer.js";

export interface StdinBufferEventMap { data: [string]; paste: [string] }
export interface StdinBufferOptions { timeout?: number }

const CONTROL_LIMIT = 4 * 1024;
const PASTE_LIMIT = 4 * 1024 * 1024;

function sequenceLength(value: string): number | undefined {
  if (value.startsWith("\x1b\x1b")) return 1;
  if (value.startsWith("\x1b[")) {
    if (value.startsWith("\x1b[200~")) return undefined;
    const match = /^\x1b\[[0-?]*[ -/]*[@-~]/u.exec(value);
    return match?.[0].length;
  }
  if (value.startsWith("\x1b]") || value.startsWith("\x1bP") || value.startsWith("\x1b_") || value.startsWith("\x1b^") || value.startsWith("\x1bX")) {
    const bel = value.indexOf("\x07", 2);
    const st = value.indexOf("\x1b\\", 2);
    const endings = [bel >= 0 ? bel + 1 : Infinity, st >= 0 ? st + 2 : Infinity];
    const end = Math.min(...endings);
    return Number.isFinite(end) ? end : undefined;
  }
  if (value.startsWith("\x1b")) return value.length >= 2 ? 2 : undefined;
  return [...value][0]?.length;
}

export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
  readonly #timeout: number;
  #buffer = "";
  #timer: ManagedTimeout | undefined;
  #destroyed = false;
  #keyboardEcho: string | undefined;

  constructor(options: StdinBufferOptions = {}) {
    super();
    this.#timeout = validateTimerDelay(options.timeout === undefined ? 10 : options.timeout, "stdin timeout");
  }

  getBuffer(): string { return this.#buffer; }

  flush(): string[] {
    this.#timer?.clear();
    this.#timer = undefined;
    const pending = this.#buffer;
    this.#buffer = "";
    this.#keyboardEcho = undefined;
    return pending === "" ? [] : [pending];
  }

  clear(): void {
    this.#timer?.clear();
    this.#timer = undefined;
    this.#buffer = "";
    this.#keyboardEcho = undefined;
  }

  process(value: string): void {
    if (this.#destroyed) return;
    this.#timer?.clear();
    this.#timer = undefined;
    this.#buffer += value;
    try { this.#drain(); } catch (error) {
      this.#buffer = "";
      throw error;
    }
  }

  #drain(): void {
    while (this.#buffer !== "") {
      const paste = this.#buffer.indexOf("\x1b[200~");
      if (paste === 0) {
        const end = this.#buffer.indexOf("\x1b[201~", 6);
        if (end < 0) {
          if (Buffer.byteLength(this.#buffer.slice(6), "utf8") > PASTE_LIMIT) throw new Error("Bracketed paste exceeds the supported size");
          this.#arm();
          return;
        }
        const payload = this.#buffer.slice(6, end);
        if (Buffer.byteLength(payload, "utf8") > PASTE_LIMIT) throw new Error("Bracketed paste exceeds the supported size");
        this.#buffer = this.#buffer.slice(end + 6);
        this.emit("paste", payload);
        continue;
      }
      const length = sequenceLength(this.#buffer);
      if (length === undefined) {
        if (Buffer.byteLength(this.#buffer, "utf8") > CONTROL_LIMIT) throw new Error("Terminal control sequence is too large");
        this.#arm();
        return;
      }
      const selected = this.#buffer.slice(0, length);
      this.#buffer = this.#buffer.slice(length);
      const keyboard = /^\x1b\[(\d+)u$/u.exec(selected);
      if (keyboard !== null) {
        const codePoint = Number(keyboard[1]);
        this.#keyboardEcho = codePoint >= 0x20 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : undefined;
      } else if (this.#keyboardEcho !== undefined) {
        if (selected === this.#keyboardEcho) {
          this.#keyboardEcho = undefined;
          continue;
        }
        this.#keyboardEcho = undefined;
      }
      this.emit("data", selected);
    }
  }

  #arm(): void {
    this.#timer = scheduleTimeout(() => {
      const pending = this.#buffer;
      this.#buffer = "";
      if (pending !== "") this.emit("data", pending);
    }, this.#timeout);
  }

  destroy(): void {
    this.#destroyed = true;
    this.clear();
    this.removeAllListeners();
  }
}
