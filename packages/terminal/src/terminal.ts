import type { Readable, Writable } from "node:stream";

import { scheduleTimeout, validateTimerDelay } from "./internal-timer.js";
import { enableNativeInput, modifierPressed, type NativeTerminalInputOptions } from "./native-modifiers.js";
import { setKittyProtocolActive } from "./keys.js";
import { StdinBuffer } from "./stdin-buffer.js";

export type { NativeTerminalInputOptions } from "./native-modifiers.js";

export interface Terminal {
  readonly columns: number;
  readonly rows: number;
  readonly kittyProtocolActive: boolean;
  start(input: (data: string) => void, resize: () => void): void;
  stop(): void;
  drainInput(idleMs?: number, maximumMs?: number): Promise<void>;
  write(data: string): void;
  moveBy(lines: number): void;
  hideCursor(): void;
  showCursor(): void;
  clearLine(): void;
  clearFromCursor(): void;
  clearScreen(): void;
  setTitle(value: string): void;
  setProgress(value?: number): void;
}

export interface ProcessTerminalOptions {
  input?: Readable & { setRawMode?: (value: boolean) => unknown; isRaw?: boolean; setEncoding?: (value: BufferEncoding) => unknown; resume?: () => unknown; pause?: () => unknown };
  output?: Writable & { columns?: number; rows?: number; on?: (event: string, listener: () => void) => unknown; off?: (event: string, listener: () => void) => unknown };
}

function safeTitle(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/gu, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export class ProcessTerminal implements Terminal {
  readonly #input;
  readonly #output;
  readonly #buffer = new StdinBuffer();
  #active = false;
  #inputCallback: ((data: string) => void) | undefined;
  #resizeCallback: (() => void) | undefined;
  #draining = false;
  kittyProtocolActive = false;

  constructor(options: ProcessTerminalOptions = {}) {
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
    this.#buffer.on("data", (value) => this.#route(value));
    this.#buffer.on("paste", (value) => this.#route(`\x1b[200~${value}\x1b[201~`));
  }
  get columns(): number { return Math.max(1, Math.trunc(this.#output.columns ?? 80)); }
  get rows(): number { return Math.max(1, Math.trunc(this.#output.rows ?? 24)); }

  #resetDrain: (() => void) | undefined;
  readonly #onData = (value: string | Buffer): void => { this.#resetDrain?.(); this.#buffer.process(String(value)); };
  readonly #onResize = (): void => this.#resizeCallback?.();

  start(input: (data: string) => void, resize: () => void): void {
    if (this.#active) return;
    this.#active = true;
    this.#inputCallback = input;
    this.#resizeCallback = resize;
    this.#input.setRawMode?.(true);
    this.#input.setEncoding?.("utf8");
    this.#input.resume?.();
    this.#input.on("data", this.#onData);
    this.#output.on?.("resize", this.#onResize);
    this.write("\x1b[?2004h");
    this.write("\x1b[>7u\x1b[?u\x1b[c");
    if (ProcessTerminal.isWindowsTerminalSession()) ProcessTerminal.enableNativeInput();
  }

  stop(): void {
    if (!this.#active) return;
    this.#active = false;
    this.write("\x1b[?2004l\x1b[<u");
    this.#input.off("data", this.#onData);
    this.#output.off?.("resize", this.#onResize);
    this.#input.pause?.();
    this.#input.setRawMode?.(false);
    this.#inputCallback = undefined;
    this.#resizeCallback = undefined;
    this.kittyProtocolActive = false;
    setKittyProtocolActive(false);
  }

  #route(value: string): void {
    if (/^\x1b\[\?\d+u$/u.test(value)) {
      this.kittyProtocolActive = true;
      setKittyProtocolActive(true);
      return;
    }
    if (this.#draining) return;
    const normalized = ProcessTerminal.normalizeNativeInput(value);
    this.#inputCallback?.(typeof normalized === "string" ? normalized : normalized.toString("utf8"));
  }

  async drainInput(idleMs = 25, maximumMs = 100): Promise<void> {
    const idle = validateTimerDelay(idleMs, "idle delay");
    const maximum = validateTimerDelay(maximumMs, "maximum delay");
    this.write("\x1b[<u");
    this.kittyProtocolActive = false;
    setKittyProtocolActive(false);
    this.#draining = true;
    const started = Date.now();
    await new Promise<void>((accept) => {
      let timer: ReturnType<typeof scheduleTimeout> | undefined;
      const finish = (): void => {
        timer?.clear();
        this.#resetDrain = undefined;
        accept();
      };
      const arm = (): void => {
        timer?.clear();
        const remaining = Math.max(0, maximum - (Date.now() - started));
        timer = scheduleTimeout(finish, Math.min(idle, remaining));
      };
      this.#resetDrain = arm;
      arm();
    });
    this.#draining = false;
  }
  write(data: string): void { this.#output.write(data); }
  moveBy(lines: number): void { if (lines > 0) this.write(`\x1b[${lines}B`); else if (lines < 0) this.write(`\x1b[${-lines}A`); }
  hideCursor(): void { this.write("\x1b[?25l"); }
  showCursor(): void { this.write("\x1b[?25h"); }
  clearLine(): void { this.write("\x1b[2K"); }
  clearFromCursor(): void { this.write("\x1b[J"); }
  clearScreen(): void { this.write("\x1b[2J\x1b[H"); }
  setTitle(value: string): void { this.write(`\x1b]0;${safeTitle(value)}\x07`); }
  setProgress(value?: number): void { this.write(value === undefined ? "\x1b]9;4;0\x07" : `\x1b]9;4;1;${Math.max(0, Math.min(100, Math.round(value)))}\x07`); }

  static isWindowsTerminalSession(environment: NodeJS.ProcessEnv = process.env): boolean {
    return environment.WT_SESSION !== undefined && environment.SSH_CONNECTION === undefined && environment.SSH_TTY === undefined;
  }
  static enableNativeInput(options: NativeTerminalInputOptions = {}): boolean { return enableNativeInput(options); }
  static normalizeNativeInput(
    data: string | Buffer,
    options: { environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; modifierPressed?: (name: string) => boolean } = {},
  ): string | Buffer {
    const value = typeof data === "string" ? data : data.toString("utf8");
    const environment = options.environment ?? process.env;
    const platform = options.platform ?? process.platform;
    if (value === "\r" && platform === "darwin" && environment.TERM_PROGRAM === "Apple_Terminal"
      && (options.modifierPressed ?? modifierPressed)("shift")) return "\x1b[13;2u";
    return data;
  }
}
