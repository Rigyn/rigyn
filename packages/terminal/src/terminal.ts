import { appendFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setKittyProtocolActive } from "./keys.js";
import { isNativeModifierPressed } from "./native-modifiers.js";
import { sanitizeTerminalText } from "./internal-unicode.js";
import { StdinBuffer } from "./stdin-buffer.js";

const keyboardQuery = "\x1b[>7u\x1b[?u\x1b[c";
const progressActive = "\x1b]9;4;3\x07";
const progressClear = "\x1b]9;4;0;\x07";
const require = createRequire(import.meta.url);

export type KeyboardProtocolNegotiationSequence = { type: "kitty-flags"; flags: number } | { type: "device-attributes" };
export function parseKeyboardProtocolNegotiationSequence(value: string): KeyboardProtocolNegotiationSequence | undefined {
  const flags = /^\x1b\[\?(\d+)u$/u.exec(value);
  if (flags) return { type: "kitty-flags", flags: Number(flags[1]) };
  return /^\x1b\[\?[\d;]*c$/u.test(value) ? { type: "device-attributes" } : undefined;
}
function negotiationPrefix(value: string): boolean { return value === "\x1b[" || /^\x1b\[\?[\d;]*$/u.test(value); }
export function isAppleTerminalSession(): boolean { return process.platform === "darwin" && process.env.TERM_PROGRAM === "Apple_Terminal"; }
export function normalizeAppleTerminalInput(data: string, apple: boolean, shift: boolean): string { return apple && shift && data === "\r" ? "\x1b[13;2u" : data; }

export interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  drainInput(maxMs?: number, idleMs?: number): Promise<void>;
  write(data: string): void;
  get columns(): number;
  get rows(): number;
  get kittyProtocolActive(): boolean;
  moveBy(lines: number): void;
  hideCursor(): void;
  showCursor(): void;
  clearLine(): void;
  clearFromCursor(): void;
  clearScreen(): void;
  setTitle(title: string): void;
  setProgress(active: boolean): void;
}

export interface ProcessTerminalOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

export class ProcessTerminal implements Terminal {
  readonly #input: NodeJS.ReadStream;
  readonly #output: NodeJS.WriteStream;
  #wasRaw = false;
  private inputHandler: ((data: string) => void) | undefined;
  #resize: (() => void) | undefined;
  #buffer: StdinBuffer | undefined;
  #stdinListener: ((data: string) => void) | undefined;
  #kitty = false;
  #modifyOtherKeys = false;
  #keyboardPushed = false;
  #negotiation = "";
  #negotiationTimer: ReturnType<typeof setTimeout> | undefined;
  #progressTimer: ReturnType<typeof setInterval> | undefined;
  #started = false;
  readonly #writeLog = (() => {
    const selected = process.env.RIGYN_TUI_WRITE_LOG ?? "";
    if (!selected) return "";
    try {
      if (statSync(selected).isDirectory()) return join(selected, `tui-${new Date().toISOString().replace(/[:.]/gu, "-")}-${process.pid}.log`);
    } catch { /* a non-directory is a valid target */ }
    return selected;
  })();

  constructor(options: ProcessTerminalOptions = {}) {
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
  }

  get kittyProtocolActive(): boolean { return this.#kitty; }
  get modifyOtherKeysActive(): boolean { return this.#modifyOtherKeys; }
  start(onInput: (data: string) => void, onResize: () => void): void {
    if (this.#started) return;
    this.#started = true;
    this.inputHandler = onInput;
    this.#resize = onResize;
    this.#wasRaw = this.#input.isRaw ?? false;
    this.#input.setRawMode?.(true);
    this.#input.setEncoding("utf8");
    this.#input.resume();
    this.#output.write("\x1b[?2004h");
    this.#output.on("resize", onResize);
    if (this.#output === process.stdout && process.platform !== "win32") process.kill(process.pid, "SIGWINCH");
    this.#enableWindowsInput();
    this.#startKeyboardNegotiation();
  }

  #startKeyboardNegotiation(): void {
    this.#buffer = new StdinBuffer({ timeout: 10 });
    this.#buffer.on("paste", (content) => this.inputHandler?.(`\x1b[200~${content}\x1b[201~`));
    this.#buffer.on("data", (sequence) => this.#receive(sequence));
    this.#stdinListener = (data) => this.#buffer!.process(data);
    this.#input.on("data", this.#stdinListener);
    this.#keyboardPushed = true;
    this.#output.write(keyboardQuery);
  }

  #receive(sequence: string): void {
    if (this.#negotiation) {
      const combined = this.#negotiation + sequence;
      const parsed = parseKeyboardProtocolNegotiationSequence(combined);
      if (parsed) { this.#clearNegotiation(); this.#applyNegotiation(parsed); return; }
      if (negotiationPrefix(combined)) { this.#setNegotiation(combined); return; }
      const pending = this.#negotiation;
      this.#clearNegotiation();
      this.#forward(pending);
    }
    const parsed = parseKeyboardProtocolNegotiationSequence(sequence);
    if (parsed) { this.#applyNegotiation(parsed); return; }
    if (negotiationPrefix(sequence)) { this.#setNegotiation(sequence); return; }
    this.#forward(sequence);
  }

  #setNegotiation(value: string): void {
    if (this.#negotiationTimer) clearTimeout(this.#negotiationTimer);
    this.#negotiation = value;
    this.#negotiationTimer = setTimeout(() => { const pending = this.#negotiation; this.#clearNegotiation(); this.#forward(pending); }, 150);
  }
  #clearNegotiation(): void { if (this.#negotiationTimer) clearTimeout(this.#negotiationTimer); this.#negotiationTimer = undefined; this.#negotiation = ""; }
  #applyNegotiation(value: KeyboardProtocolNegotiationSequence): void {
    this.#clearNegotiation();
    if (value.type === "kitty-flags" && value.flags !== 0) {
      this.#disableModifyOtherKeys(); this.#kitty = true; setKittyProtocolActive(true);
    } else if (!this.#kitty) this.#enableModifyOtherKeys();
  }
  #forward(value: string): void {
    const apple = value === "\r" && isAppleTerminalSession();
    this.inputHandler?.(normalizeAppleTerminalInput(value, apple, apple && isNativeModifierPressed("shift")));
  }
  #enableModifyOtherKeys(): void { if (!this.#kitty && !this.#modifyOtherKeys) { this.#output.write("\x1b[>4;2m"); this.#modifyOtherKeys = true; } }
  #disableModifyOtherKeys(): void { if (this.#modifyOtherKeys) { this.#output.write("\x1b[>4;0m"); this.#modifyOtherKeys = false; } }

  #enableWindowsInput(): void {
    if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) return;
    const directory = dirname(fileURLToPath(import.meta.url));
    const relative = join("native", "win32", "prebuilds", `win32-${process.arch}`, "win32-console-mode.node");
    for (const candidate of [join(directory, "..", relative), join(directory, relative), join(dirname(process.execPath), relative)]) {
      try { (require(candidate) as { enableVirtualTerminalInput?(): boolean }).enableVirtualTerminalInput?.(); return; } catch { /* try next layout */ }
    }
  }

  async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
    this.#disableKeyboardProtocols();
    const input = this.inputHandler; this.inputHandler = undefined;
    let last = Date.now(); const update = () => { last = Date.now(); };
    this.#input.on("data", update);
    const deadline = Date.now() + maxMs;
    try { while (Date.now() < deadline && Date.now() - last < idleMs) await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, deadline - Date.now()))); }
    finally { this.#input.off("data", update); this.inputHandler = input; }
  }

  #disableKeyboardProtocols(): void {
    this.#clearNegotiation();
    if (this.#keyboardPushed || this.#kitty) this.#output.write("\x1b[<u");
    this.#keyboardPushed = false; this.#kitty = false; setKittyProtocolActive(false); this.#disableModifyOtherKeys();
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.setProgress(false);
    this.#output.write("\x1b[?2004l");
    this.#disableKeyboardProtocols();
    this.#buffer?.destroy(); this.#buffer = undefined;
    if (this.#stdinListener) this.#input.off("data", this.#stdinListener);
    this.#stdinListener = undefined;
    if (this.#resize) this.#output.off("resize", this.#resize);
    this.inputHandler = undefined; this.#resize = undefined;
    this.#input.pause(); this.#input.setRawMode?.(this.#wasRaw);
  }

  write(data: string): void { this.#output.write(data); if (this.#writeLog) { try { appendFileSync(this.#writeLog, data); } catch { /* diagnostics must not break output */ } } }
  get columns(): number { return Math.max(1, this.#output.columns || Number(process.env.COLUMNS) || 80); }
  get rows(): number { return Math.max(1, this.#output.rows || Number(process.env.LINES) || 24); }
  moveBy(lines: number): void { if (lines) this.#output.write(`\x1b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`); }
  hideCursor(): void { this.#output.write("\x1b[?25l"); }
  showCursor(): void { this.#output.write("\x1b[?25h"); }
  clearLine(): void { this.#output.write("\x1b[K"); }
  clearFromCursor(): void { this.#output.write("\x1b[J"); }
  clearScreen(): void { this.#output.write("\x1b[2J\x1b[H"); }
  setTitle(title: string): void { this.#output.write(`\x1b]0;${sanitizeTerminalText(title).replaceAll("\n", " ")}\x07`); }
  setProgress(active: boolean): void {
    if (active) {
      this.#output.write(progressActive);
      this.#progressTimer ??= setInterval(() => this.#output.write(progressActive), 1000);
    } else {
      if (this.#progressTimer) clearInterval(this.#progressTimer);
      this.#progressTimer = undefined; this.#output.write(progressClear);
    }
  }
}
