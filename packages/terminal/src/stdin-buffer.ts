import { EventEmitter } from "node:events";

const ESC = "\x1b";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function sequenceStatus(value: string): "complete" | "incomplete" | "plain" {
  if (!value.startsWith(ESC)) return "plain";
  if (value.length === 1) return "incomplete";
  const kind = value[1];
  if (kind === "[") {
    if (value.startsWith("\x1b[M")) return value.length >= 6 ? "complete" : "incomplete";
    if (value.length < 3) return "incomplete";
    const payload = value.slice(2);
    const final = payload.charCodeAt(payload.length - 1);
    if (final < 0x40 || final > 0x7e) return "incomplete";
    if (!payload.startsWith("<")) return "complete";
    return /^<\d+;\d+;\d+[Mm]$/u.test(payload) ? "complete" : "incomplete";
  }
  if (kind === "]") return value.endsWith("\x07") || value.endsWith("\x1b\\") ? "complete" : "incomplete";
  if (kind === "P" || kind === "_") return value.endsWith("\x1b\\") ? "complete" : "incomplete";
  if (kind === "O") return value.length >= 3 ? "complete" : "incomplete";
  return value.length >= 2 ? "complete" : "incomplete";
}

function splitSequences(value: string): { complete: string[]; remainder: string } {
  const complete: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    if (value[offset] !== ESC) {
      const codepoint = value.codePointAt(offset)!;
      const character = String.fromCodePoint(codepoint);
      complete.push(character);
      offset += character.length;
      continue;
    }
    let length = 1;
    let found = false;
    while (offset + length <= value.length) {
      const candidate = value.slice(offset, offset + length);
      const state = sequenceStatus(candidate);
      if (state === "complete") {
        const next = value[offset + length];
        if (candidate === "\x1b\x1b" && next !== undefined && "[]OP_".includes(next)) {
          complete.push(ESC);
          offset += 1;
        } else {
          complete.push(candidate);
          offset += length;
        }
        found = true;
        break;
      }
      length += 1;
    }
    if (!found) return { complete, remainder: value.slice(offset) };
  }
  return { complete, remainder: "" };
}

function plainKittyCodepoint(value: string): number | undefined {
  const match = /^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/u.exec(value);
  if (!match) return undefined;
  const codepoint = Number(match[1]);
  return codepoint >= 32 ? codepoint : undefined;
}

export interface StdinBufferOptions { timeout?: number }
export interface StdinBufferEventMap { data: [string]; paste: [string] }

export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
  #buffer = "";
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #timeout: number;
  #pasting = false;
  #paste = "";
  #duplicateCodepoint: number | undefined;

  constructor(options: StdinBufferOptions = {}) {
    super();
    this.#timeout = options.timeout ?? 10;
  }

  process(chunk: string | Buffer): void {
    this.#cancelTimer();
    let value: string;
    if (Buffer.isBuffer(chunk) && chunk.length === 1 && chunk[0]! > 127) value = ESC + String.fromCharCode(chunk[0]! - 128);
    else value = chunk.toString();
    if (value.length === 0 && this.#buffer.length === 0) { this.#emit(""); return; }
    this.#buffer += value;

    if (this.#pasting) {
      this.#paste += this.#buffer;
      this.#buffer = "";
      this.#finishPasteIfPresent();
      return;
    }

    const pasteStart = this.#buffer.indexOf(PASTE_START);
    if (pasteStart >= 0) {
      const before = this.#buffer.slice(0, pasteStart);
      for (const sequence of splitSequences(before).complete) this.#emit(sequence);
      this.#duplicateCodepoint = undefined;
      this.#paste = this.#buffer.slice(pasteStart + PASTE_START.length);
      this.#buffer = "";
      this.#pasting = true;
      this.#finishPasteIfPresent();
      return;
    }

    const parsed = splitSequences(this.#buffer);
    this.#buffer = parsed.remainder;
    for (const sequence of parsed.complete) this.#emit(sequence);
    if (this.#buffer) this.#timer = setTimeout(() => { for (const sequence of this.flush()) this.#emit(sequence); }, this.#timeout);
  }

  #finishPasteIfPresent(): void {
    const end = this.#paste.indexOf(PASTE_END);
    if (end < 0) return;
    const content = this.#paste.slice(0, end);
    const remainder = this.#paste.slice(end + PASTE_END.length);
    this.#paste = "";
    this.#pasting = false;
    this.#duplicateCodepoint = undefined;
    this.emit("paste", content);
    if (remainder) this.process(remainder);
  }

  #emit(sequence: string): void {
    const raw = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
    if (raw !== undefined && raw === this.#duplicateCodepoint) { this.#duplicateCodepoint = undefined; return; }
    this.#duplicateCodepoint = plainKittyCodepoint(sequence);
    this.emit("data", sequence);
  }

  #cancelTimer(): void { if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined; }
  flush(): string[] {
    this.#cancelTimer();
    if (!this.#buffer) return [];
    const value = this.#buffer;
    this.#buffer = "";
    this.#duplicateCodepoint = undefined;
    return [value];
  }
  clear(): void {
    this.#cancelTimer();
    this.#buffer = "";
    this.#pasting = false;
    this.#paste = "";
    this.#duplicateCodepoint = undefined;
  }
  getBuffer(): string { return this.#buffer; }
  destroy(): void { this.clear(); this.removeAllListeners(); }
}
