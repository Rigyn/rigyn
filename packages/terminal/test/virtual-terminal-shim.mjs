import { visibleWidth } from "../dist/utils.js";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function blankCell() {
  return { text: " ", italic: false, underline: false, continuation: false, written: false };
}

function blankLine(columns) {
  return Array.from({ length: columns }, blankCell);
}

function cloneCell(cell) {
  return { ...cell };
}

export class VirtualTerminal {
  constructor(columns = 80, rows = 24) {
    this.columns = columns;
    this.rows = rows;
    this.kittyProtocolActive = true;
    this.writes = [];
    this._lines = Array.from({ length: rows }, () => blankLine(columns));
    this._cursorX = 0;
    this._cursorY = 0;
    this._viewportY = 0;
    this._italic = false;
    this._underline = false;
    this._wrapPending = false;
    this._savedCursor = undefined;
    this.xterm = {
      get rows() { return rows; },
      buffer: {
        active: {
          get viewportY() { return this._owner._viewportY; },
          get cursorX() { return this._owner._cursorX; },
          get cursorY() { return this._owner._cursorY - this._owner._viewportY; },
          get length() { return this._owner._lines.length; },
          getLine(index) { return this._owner._lineView(index); },
          _owner: this,
        },
      },
    };
  }

  start(onInput, onResize) {
    this.onInput = onInput;
    this.onResize = onResize;
  }

  drainInput() { return Promise.resolve(); }
  stop() { this.onInput = undefined; this.onResize = undefined; }

  write(data) {
    const value = String(data);
    this.writes.push(value);
    this._consume(value);
  }

  moveBy(lines) { this.write(lines > 0 ? `\x1b[${lines}B` : lines < 0 ? `\x1b[${-lines}A` : ""); }
  hideCursor() { this.write("\x1b[?25l"); }
  showCursor() { this.write("\x1b[?25h"); }
  clearLine() { this.write("\x1b[K"); }
  clearFromCursor() { this.write("\x1b[J"); }
  clearScreen() { this.write("\x1b[2J\x1b[H"); }
  setTitle(title) { this.write(`\x1b]0;${title}\x07`); }
  setProgress() {}
  sendInput(data) { this.onInput?.(data); }

  resize(columns, rows) {
    this.columns = columns;
    this.rows = rows;
    for (const line of this._lines) {
      if (line.length > columns) line.length = columns;
      while (line.length < columns) line.push(blankCell());
    }
    while (this._lines.length < rows) this._lines.push(blankLine(columns));
    this._cursorX = Math.min(this._cursorX, Math.max(0, columns - 1));
    this._wrapPending = false;
    this._viewportY = Math.max(0, this._cursorY - rows + 1);
    this.onResize?.();
  }

  flush() { return Promise.resolve(); }
  async flushAndGetViewport() { await this.flush(); return this.getViewport(); }
  async waitForRender() {
    await new Promise((resolve) => process.nextTick(resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  getViewport() {
    return Array.from({ length: this.rows }, (_, index) => this._lineText(this._viewportY + index));
  }

  getScrollBuffer() {
    return this._lines.map((_, index) => this._lineText(index));
  }

  getCursorPosition() {
    return { x: this._cursorX, y: this._cursorY - this._viewportY };
  }

  clear() {
    this._lines = Array.from({ length: this.rows }, () => blankLine(this.columns));
    this._cursorX = 0;
    this._cursorY = 0;
    this._viewportY = 0;
    this._wrapPending = false;
  }

  reset() {
    this.clear();
    this._italic = false;
    this._underline = false;
    this.writes.length = 0;
  }

  _lineView(index) {
    const owner = this;
    const line = this._lines[index];
    if (!line) return undefined;
    return {
      translateToString(trimRight = false) {
        const text = owner._lineText(index, false);
        return trimRight ? text.replace(/\s+$/u, "") : text;
      },
      getCell(column) {
        const cell = line[column];
        if (!cell) return undefined;
        return {
          isItalic() { return cell.italic ? 1 : 0; },
          isUnderline() { return cell.underline ? 1 : 0; },
        };
      },
    };
  }

  _lineText(index, trimRight = true) {
    const line = this._lines[index];
    if (!line) return "";
    const end = trimRight ? line.findLastIndex((cell) => cell.written) + 1 : line.length;
    return line.slice(0, end).map((cell) => cell.continuation ? "" : cell.text).join("");
  }

  _ensureLine(index) {
    while (this._lines.length <= index) this._lines.push(blankLine(this.columns));
    return this._lines[index];
  }

  _lineFeed() {
    this._cursorY += 1;
    this._ensureLine(this._cursorY);
    if (this._cursorY >= this._viewportY + this.rows) this._viewportY = this._cursorY - this.rows + 1;
  }

  _put(grapheme) {
    const width = Math.max(0, visibleWidth(grapheme));
    if (width === 0) {
      const column = Math.max(0, this._cursorX - 1);
      this._ensureLine(this._cursorY)[column].text += grapheme;
      return;
    }
    if (this._wrapPending || this._cursorX + width > this.columns) {
      this._cursorX = 0;
      this._lineFeed();
      this._wrapPending = false;
    }
    const line = this._ensureLine(this._cursorY);
    line[this._cursorX] = { text: grapheme, italic: this._italic, underline: this._underline, continuation: false, written: true };
    for (let offset = 1; offset < width && this._cursorX + offset < this.columns; offset += 1) {
      line[this._cursorX + offset] = { text: "", italic: this._italic, underline: this._underline, continuation: true, written: true };
    }
    this._cursorX += width;
    this._wrapPending = this._cursorX >= this.columns;
  }

  _eraseLine(mode) {
    const line = this._ensureLine(this._cursorY);
    const start = mode === 1 ? 0 : mode === 2 ? 0 : this._cursorX;
    const end = mode === 0 ? this.columns : mode === 1 ? Math.min(this.columns, this._cursorX + 1) : this.columns;
    for (let index = start; index < end; index += 1) line[index] = blankCell();
  }

  _eraseDisplay(mode) {
    if (mode === 3) {
      const visible = this._lines.slice(this._viewportY, this._viewportY + this.rows).map((line) => line.map(cloneCell));
      this._lines = visible;
      while (this._lines.length < this.rows) this._lines.push(blankLine(this.columns));
      this._cursorY = Math.max(0, this._cursorY - this._viewportY);
      this._viewportY = 0;
      return;
    }
    if (mode === 2) {
      for (let row = 0; row < this.rows; row += 1) this._lines[this._viewportY + row] = blankLine(this.columns);
      return;
    }
    if (mode === 0) {
      this._eraseLine(0);
      for (let row = this._cursorY + 1; row < this._viewportY + this.rows; row += 1) this._lines[row] = blankLine(this.columns);
    }
  }

  _csi(parameters, final) {
    const cleaned = parameters.replace(/^[?<>!]/u, "");
    const values = cleaned === "" ? [] : cleaned.split(";").map((value) => Number(value || 0));
    const first = values[0] ?? 0;
    const amount = Math.max(1, first || 1);
    if (final !== "m" && final !== "h" && final !== "l") this._wrapPending = false;
    if (final === "A") this._cursorY = Math.max(this._viewportY, this._cursorY - amount);
    else if (final === "B") { this._cursorY += amount; this._ensureLine(this._cursorY); this._viewportY = Math.max(this._viewportY, this._cursorY - this.rows + 1); }
    else if (final === "C") this._cursorX = Math.min(this.columns - 1, this._cursorX + amount);
    else if (final === "D") this._cursorX = Math.max(0, this._cursorX - amount);
    else if (final === "E") { this._cursorY += amount; this._cursorX = 0; this._ensureLine(this._cursorY); }
    else if (final === "F") { this._cursorY = Math.max(this._viewportY, this._cursorY - amount); this._cursorX = 0; }
    else if (final === "G" || final === "`") this._cursorX = Math.max(0, Math.min(this.columns - 1, amount - 1));
    else if (final === "H" || final === "f") {
      this._cursorY = this._viewportY + Math.max(0, (values[0] || 1) - 1);
      this._cursorX = Math.max(0, Math.min(this.columns - 1, (values[1] || 1) - 1));
      this._ensureLine(this._cursorY);
    } else if (final === "J") this._eraseDisplay(first);
    else if (final === "K") this._eraseLine(first);
    else if (final === "m") {
      const modes = values.length ? values : [0];
      for (const mode of modes) {
        if (mode === 0) { this._italic = false; this._underline = false; }
        else if (mode === 23) this._italic = false;
        else if (mode === 3) this._italic = true;
        else if (mode === 4) this._underline = true;
        else if (mode === 24) this._underline = false;
      }
    } else if (final === "s") this._savedCursor = { x: this._cursorX, y: this._cursorY };
    else if (final === "u" && this._savedCursor) { this._cursorX = this._savedCursor.x; this._cursorY = this._savedCursor.y; }
  }

  _consume(value) {
    for (let index = 0; index < value.length;) {
      const character = value[index];
      if (character === "\x1b") {
        const next = value[index + 1];
        if (next === "[") {
          const match = /^\x1b\[([0-9:;?<>!=]*)([ -/]*)?([@-~])/u.exec(value.slice(index));
          if (match) {
            this._csi(match[1], match[3]);
            index += match[0].length;
            continue;
          }
        }
        if (next === "]" || next === "_" || next === "P" || next === "^") {
          const start = index + 2;
          const bell = value.indexOf("\x07", start);
          const terminator = value.indexOf("\x1b\\", start);
          const end = bell >= 0 && (terminator < 0 || bell < terminator) ? bell + 1 : terminator >= 0 ? terminator + 2 : value.length;
          index = end;
          continue;
        }
        if (next === "7") this._savedCursor = { x: this._cursorX, y: this._cursorY };
        else if (next === "8" && this._savedCursor) { this._cursorX = this._savedCursor.x; this._cursorY = this._savedCursor.y; }
        index += Math.min(2, value.length - index);
        continue;
      }
      if (character === "\r") { this._cursorX = 0; this._wrapPending = false; index += 1; continue; }
      if (character === "\n") { this._lineFeed(); this._wrapPending = false; index += 1; continue; }
      if (character === "\b") { this._cursorX = Math.max(0, this._cursorX - 1); index += 1; continue; }
      if (character === "\t") {
        const stop = Math.min(this.columns, this._cursorX + (8 - (this._cursorX % 8)));
        while (this._cursorX < stop) this._put(" ");
        index += 1;
        continue;
      }
      if (character < " ") { index += 1; continue; }
      const segment = graphemes.segment(value.slice(index))[Symbol.iterator]().next().value?.segment ?? character;
      this._put(segment);
      index += segment.length;
    }
  }
}
