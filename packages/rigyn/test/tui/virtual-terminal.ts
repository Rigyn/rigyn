import { graphemeWidth, splitGraphemes } from "../../src/tui/unicode.js";

function blank(columns: number): string[] {
  return Array.from({ length: columns }, () => " ");
}

/** A deliberately small emulator for the cursor/erase subset emitted by the live-surface renderer. */
export class FocusedVirtualTerminal {
  #columns: number;
  #rows: number;
  #screen: string[][];
  #scrollback: string[] = [];
  #cursorX = 0;
  #cursorY = 0;
  #wrapPending = false;
  #savedCursor: { x: number; y: number } | undefined;

  constructor(columns: number, rows: number) {
    this.#columns = columns;
    this.#rows = rows;
    this.#screen = Array.from({ length: rows }, () => blank(columns));
  }

  write(value: string): void {
    let index = 0;
    while (index < value.length) {
      const character = value[index] ?? "";
      if (character === "\r") {
        this.#cursorX = 0;
        this.#wrapPending = false;
        index += 1;
        continue;
      }
      if (character === "\n") {
        this.#lineFeed();
        index += 1;
        continue;
      }
      if (character === "\u001b") {
        index = this.#escape(value, index);
        continue;
      }
      let end = index;
      while (end < value.length && !["\r", "\n", "\u001b"].includes(value[end] ?? "")) end += 1;
      for (const grapheme of splitGraphemes(value.slice(index, end))) this.#print(grapheme);
      index = end;
    }
  }

  resize(columns: number, rows: number): void {
    this.#screen = this.#screen.map((line) => [
      ...line.slice(0, columns),
      ...Array.from({ length: Math.max(0, columns - line.length) }, () => " "),
    ]);
    this.#columns = columns;
    if (rows < this.#rows && this.#cursorY >= rows) {
      const removed = this.#cursorY - rows + 1;
      for (const line of this.#screen.splice(0, removed)) this.#scrollback.push(line.join("").trimEnd());
      this.#cursorY -= removed;
    }
    this.#screen = this.#screen.slice(0, rows);
    while (this.#screen.length < rows) this.#screen.push(blank(columns));
    this.#rows = rows;
    this.#cursorX = Math.min(this.#cursorX, Math.max(0, columns - 1));
    this.#cursorY = Math.min(this.#cursorY, Math.max(0, rows - 1));
    this.#wrapPending = false;
  }

  viewport(): string[] {
    return this.#screen.map((line) => line.join("").trimEnd());
  }

  buffer(): string[] {
    return [...this.#scrollback, ...this.viewport()];
  }

  cursor(): { row: number; column: number } {
    return { row: this.#cursorY, column: this.#cursorX };
  }

  #escape(value: string, start: number): number {
    const kind = value[start + 1];
    if (kind === "]") {
      let index = start + 2;
      while (index < value.length) {
        if (value[index] === "\u0007") return index + 1;
        if (value[index] === "\u001b" && value[index + 1] === "\\") return index + 2;
        index += 1;
      }
      throw new Error("Incomplete OSC sequence");
    }
    if (kind === "_") {
      let index = start + 2;
      while (index < value.length) {
        if (value[index] === "\u001b" && value[index + 1] === "\\") return index + 2;
        index += 1;
      }
      throw new Error("Incomplete APC sequence");
    }
    if (kind === "7") {
      this.#savedCursor = { x: this.#cursorX, y: this.#cursorY };
      return start + 2;
    }
    if (kind === "8") {
      if (this.#savedCursor !== undefined) {
        this.#cursorX = this.#savedCursor.x;
        this.#cursorY = this.#savedCursor.y;
      }
      this.#wrapPending = false;
      return start + 2;
    }
    if (kind !== "[") return Math.min(value.length, start + 2);
    let end = start + 2;
    while (end < value.length) {
      const code = value.charCodeAt(end);
      if (code >= 0x40 && code <= 0x7e) break;
      end += 1;
    }
    if (end >= value.length) throw new Error("Incomplete CSI sequence");
    const final = value[end] ?? "";
    const parameters = value.slice(start + 2, end);
    const numbers = parameters.replace(/^\?/u, "").split(";").map((part) => Number.parseInt(part || "0", 10));
    const first = numbers[0] || 1;
    if (final === "A") this.#cursorY = Math.max(0, this.#cursorY - first);
    else if (final === "B") this.#cursorY = Math.min(this.#rows - 1, this.#cursorY + first);
    else if (final === "C") this.#cursorX = Math.min(this.#columns - 1, this.#cursorX + first);
    else if (final === "G") this.#cursorX = Math.max(0, Math.min(this.#columns - 1, first - 1));
    else if (final === "H") {
      this.#cursorY = Math.max(0, Math.min(this.#rows - 1, (numbers[0] || 1) - 1));
      this.#cursorX = Math.max(0, Math.min(this.#columns - 1, (numbers[1] || 1) - 1));
    } else if (final === "J" && first === 2) {
      this.#screen = Array.from({ length: this.#rows }, () => blank(this.#columns));
    } else if (final === "K" && first === 2) {
      this.#screen[this.#cursorY] = blank(this.#columns);
    }
    this.#wrapPending = false;
    return end + 1;
  }

  #lineFeed(): void {
    this.#wrapPending = false;
    if (this.#cursorY < this.#rows - 1) {
      this.#cursorY += 1;
      return;
    }
    const removed = this.#screen.shift() ?? blank(this.#columns);
    this.#scrollback.push(removed.join("").trimEnd());
    this.#screen.push(blank(this.#columns));
  }

  #print(grapheme: string): void {
    const width = graphemeWidth(grapheme);
    if (width === 0) {
      const target = Math.max(0, this.#cursorX - 1);
      this.#screen[this.#cursorY]![target] = `${this.#screen[this.#cursorY]![target] ?? ""}${grapheme}`;
      return;
    }
    if (this.#wrapPending || this.#cursorX + width > this.#columns) {
      this.#cursorX = 0;
      this.#lineFeed();
    }
    this.#screen[this.#cursorY]![this.#cursorX] = grapheme;
    for (let offset = 1; offset < width; offset += 1) this.#screen[this.#cursorY]![this.#cursorX + offset] = "";
    this.#cursorX += width;
    if (this.#cursorX >= this.#columns) {
      this.#cursorX = this.#columns - 1;
      this.#wrapPending = true;
    }
  }
}
