import { StringDecoder } from "node:string_decoder";
import { splitGraphemes } from "./unicode.js";

export type TerminalInputToken =
  | { type: "text"; value: string }
  | { type: "sequence"; value: string; complete: boolean }
  | { type: "paste"; value: string };

const ESCAPE = "\u001b";
const PASTE_START = `${ESCAPE}[200~`;
const PASTE_END = `${ESCAPE}[201~`;
const STRING_TERMINATOR = `${ESCAPE}\\`;
const C1_CSI = "\u009b";
const C1_ST = "\u009c";
const MAX_PENDING_PASTE_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_SEQUENCE_BYTES = 4 * 1024;

function suffixPrefixLength(value: string, marker: string): number {
  const maximum = Math.min(value.length, marker.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (marker.startsWith(value.slice(-length))) return length;
  }
  return 0;
}

function firstTerminator(value: string, allowBell: boolean): { index: number; length: number } | undefined {
  const candidates = [
    { index: value.indexOf(STRING_TERMINATOR), length: STRING_TERMINATOR.length },
    { index: value.indexOf(C1_ST), length: C1_ST.length },
    ...(allowBell ? [{ index: value.indexOf("\u0007"), length: 1 }] : []),
  ].filter((candidate) => candidate.index >= 0).sort((left, right) => left.index - right.index);
  return candidates[0];
}

function csiLength(value: string, prefixLength: number): number | undefined {
  const body = value.slice(prefixLength);
  const linuxFunction = /^\[[A-E]/u.exec(body);
  if (linuxFunction !== null) return prefixLength + linuxFunction[0].length;
  const standard = /^[0-?]*[ -/]*[@-~]/u.exec(body);
  if (standard !== null) return prefixLength + standard[0].length;
  const rxvt = /^[0-9;:]*\$/u.exec(body);
  return rxvt === null ? undefined : prefixLength + rxvt[0].length;
}

function ss3Length(value: string): number | undefined {
  const match = /^[0-?]*[ -/]*[@-~]/u.exec(value.slice(2));
  return match === null ? undefined : 2 + match[0].length;
}

/**
 * Reassembles terminal input without interpreting keyboard semantics. Complete
 * control strings are emitted atomically so query replies cannot leak into text.
 */
export class TerminalInputBuffer {
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";
  #paste: string | undefined;

  push(chunk: Uint8Array | string): TerminalInputToken[] {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(Buffer.from(chunk));
    const tokens = this.#drain(false);
    this.#checkPendingBounds();
    return tokens;
  }

  flushPending(): TerminalInputToken[] {
    return this.#drain(true);
  }

  flush(): TerminalInputToken[] {
    this.#buffer += this.#decoder.end();
    return this.#drain(true);
  }

  get pendingEscape(): boolean {
    return this.#paste === undefined && this.#buffer === ESCAPE;
  }

  get pendingSequence(): boolean {
    return this.#paste === undefined
      && this.#buffer !== ESCAPE
      && (this.#buffer.startsWith(ESCAPE) || this.#buffer.startsWith(C1_CSI));
  }

  #checkPendingBounds(): void {
    if (this.#paste !== undefined) {
      if (Buffer.byteLength(this.#paste, "utf8") > MAX_PENDING_PASTE_BYTES) {
        throw new Error("Bracketed paste exceeds the terminal input limit");
      }
      return;
    }
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_PENDING_SEQUENCE_BYTES) {
      throw new Error("Terminal input sequence is too large");
    }
  }

  #sequence(length: number, complete = true): TerminalInputToken {
    const value = this.#buffer.slice(0, length);
    if (Buffer.byteLength(value, "utf8") > MAX_PENDING_SEQUENCE_BYTES) {
      throw new Error("Terminal input sequence is too large");
    }
    this.#buffer = this.#buffer.slice(length);
    return { type: "sequence", value, complete };
  }

  #drain(flush: boolean): TerminalInputToken[] {
    const tokens: TerminalInputToken[] = [];
    while (this.#buffer !== "") {
      if (this.#paste !== undefined) {
        const end = this.#buffer.indexOf(PASTE_END);
        if (end >= 0) {
          this.#paste += this.#buffer.slice(0, end);
          this.#checkPendingBounds();
          tokens.push({ type: "paste", value: this.#paste });
          this.#paste = undefined;
          this.#buffer = this.#buffer.slice(end + PASTE_END.length);
          continue;
        }
        const retained = suffixPrefixLength(this.#buffer, PASTE_END);
        this.#paste += this.#buffer.slice(0, this.#buffer.length - retained);
        this.#buffer = this.#buffer.slice(this.#buffer.length - retained);
        this.#checkPendingBounds();
        if (flush) {
          tokens.push({ type: "paste", value: this.#paste + this.#buffer });
          this.#paste = undefined;
          this.#buffer = "";
        }
        break;
      }

      if (this.#buffer.startsWith(PASTE_START)) {
        this.#buffer = this.#buffer.slice(PASTE_START.length);
        this.#paste = "";
        continue;
      }

      if (this.#buffer.startsWith(`${ESCAPE}[`) || this.#buffer.startsWith(C1_CSI)) {
        const prefixLength = this.#buffer.startsWith(C1_CSI) ? 1 : 2;
        const length = csiLength(this.#buffer, prefixLength);
        if (length !== undefined) {
          tokens.push(this.#sequence(length));
          continue;
        }
        if (flush) tokens.push(this.#sequence(this.#buffer.length, false));
        break;
      }

      if (this.#buffer.startsWith(`${ESCAPE}O`)) {
        const length = ss3Length(this.#buffer);
        if (length !== undefined) {
          tokens.push(this.#sequence(length));
          continue;
        }
        if (flush) tokens.push(this.#sequence(this.#buffer.length, false));
        break;
      }

      const stringControl = this.#buffer.startsWith(`${ESCAPE}]`) || this.#buffer.startsWith("\u009d")
        ? { prefixLength: this.#buffer.startsWith(ESCAPE) ? 2 : 1, allowBell: true }
        : this.#buffer.startsWith(`${ESCAPE}P`) || this.#buffer.startsWith(`${ESCAPE}_`)
          || this.#buffer.startsWith(`${ESCAPE}^`) || this.#buffer.startsWith(`${ESCAPE}X`)
          || this.#buffer.startsWith("\u0090") || this.#buffer.startsWith("\u009f")
          || this.#buffer.startsWith("\u009e") || this.#buffer.startsWith("\u0098")
          ? { prefixLength: this.#buffer.startsWith(ESCAPE) ? 2 : 1, allowBell: false }
          : undefined;
      if (stringControl !== undefined) {
        const terminator = firstTerminator(this.#buffer.slice(stringControl.prefixLength), stringControl.allowBell);
        if (terminator !== undefined) {
          tokens.push(this.#sequence(stringControl.prefixLength + terminator.index + terminator.length));
          continue;
        }
        if (flush) tokens.push(this.#sequence(this.#buffer.length, false));
        break;
      }

      if (this.#buffer.startsWith(ESCAPE)) {
        if (this.#buffer.length === 1) {
          if (flush) tokens.push(this.#sequence(1));
          break;
        }
        const intermediate = this.#buffer.charCodeAt(1);
        if (intermediate >= 0x20 && intermediate <= 0x2f) {
          const finalIndex = [...this.#buffer.slice(2)].findIndex((value) => {
            const code = value.charCodeAt(0);
            return code >= 0x30 && code <= 0x7e;
          });
          if (finalIndex >= 0) {
            tokens.push(this.#sequence(3 + finalIndex));
            continue;
          }
          if (flush) tokens.push(this.#sequence(this.#buffer.length, false));
          break;
        }
        const grapheme = splitGraphemes(this.#buffer.slice(1))[0];
        if (grapheme === undefined) break;
        tokens.push(this.#sequence(1 + grapheme.length));
        continue;
      }

      const first = this.#buffer.codePointAt(0) ?? 0;
      if (first < 0x20 || first === 0x7f) {
        const value = String.fromCodePoint(first);
        this.#buffer = this.#buffer.slice(value.length);
        tokens.push({ type: "text", value });
        continue;
      }
      const grapheme = splitGraphemes(this.#buffer)[0];
      if (grapheme === undefined) break;
      this.#buffer = this.#buffer.slice(grapheme.length);
      tokens.push({ type: "text", value: grapheme });
    }
    return tokens;
  }
}
