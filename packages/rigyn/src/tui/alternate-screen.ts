import { trustedHyperlinkTarget } from "./terminal-image.js";
import { cellWidth, splitGraphemes } from "./unicode.js";

const ESCAPE = 0x1b;
const CSI = 0x5b;
const SGR_MOUSE = 0x3c;
const LEGACY_MOUSE = 0x4d;
const MAX_MOUSE_SEQUENCE_BYTES = 64;
const DEFAULT_SELECTION_BYTES = 75_000;
const MAX_SELECTION_HISTORY_ROWS = 4_096;
const SELECTION_ON = "\u001b[7m";
const SELECTION_OFF = "\u001b[27m";

export interface AlternateScreenPoint {
  readonly row: number;
  readonly column: number;
}

export interface AlternateScreenMouseEvent {
  readonly type: "press" | "release" | "move" | "wheel";
  readonly button: "left" | "middle" | "right" | "none";
  readonly point: AlternateScreenPoint;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly deltaY?: -1 | 1;
  readonly horizontal?: boolean;
}

export interface AlternateScreenInputResult {
  readonly data: Buffer;
  readonly mouse: readonly AlternateScreenMouseEvent[];
  readonly focusLost: boolean;
}

export interface AlternateScreenScrollRegion {
  readonly top: number;
  readonly bottom: number;
  readonly scrollbar?: {
    readonly column: number;
    readonly thumbTop: number;
    readonly thumbRows: number;
    readonly totalRows: number;
    readonly viewportRows: number;
  };
}

interface ScreenCell {
  text: string;
  width: number;
  continuation: boolean;
  hyperlink?: string;
}

interface ScreenGrid {
  columns: number;
  rows: readonly (readonly (ScreenCell | undefined)[])[];
}

interface Selection {
  anchor: AlternateScreenPoint;
  focus: AlternateScreenPoint;
  pressed: boolean;
  dragged: boolean;
}

interface SelectionHistory {
  top: number;
  bottom: number;
  viewOrigin: number;
  rows: Map<number, readonly (ScreenCell | undefined)[]>;
  truncated: boolean;
}

export type AlternateScreenDecision =
  | { readonly type: "scroll"; readonly rows: number }
  | { readonly type: "scroll_to"; readonly rowsFromEnd: number }
  | { readonly type: "scrollbar_hover"; readonly active: boolean }
  | { readonly type: "selection_autoscroll"; readonly rows: -1 | 0 | 1 }
  | { readonly type: "copy"; readonly text: string; readonly truncated: boolean }
  | { readonly type: "open"; readonly target: string };

interface TextToken {
  type: "text";
  value: string;
  hyperlink?: string;
}

interface ControlToken {
  type: "control";
  value: string;
}

type LineToken = TextToken | ControlToken;

function modifiers(code: number): Pick<AlternateScreenMouseEvent, "shift" | "alt" | "ctrl"> {
  return {
    shift: (code & 4) !== 0,
    alt: (code & 8) !== 0,
    ctrl: (code & 16) !== 0,
  };
}

function mouseButton(code: number): AlternateScreenMouseEvent["button"] {
  const selected = code & 3;
  if (selected === 0) return "left";
  if (selected === 1) return "middle";
  if (selected === 2) return "right";
  return "none";
}

function decodedMouse(
  code: number,
  x: number,
  y: number,
  released: boolean,
): AlternateScreenMouseEvent | undefined {
  if (
    !Number.isSafeInteger(code)
    || code < 0
    || code > 255
    || !Number.isSafeInteger(x)
    || !Number.isSafeInteger(y)
    || x < 1
    || y < 1
    || x > 10_000
    || y > 10_000
  ) return undefined;
  const point = { row: y - 1, column: x - 1 };
  const base = { point, ...modifiers(code) };
  if ((code & 64) !== 0) {
    const direction = code & 3;
    if (direction === 0) return { type: "wheel", button: "none", deltaY: -1, ...base };
    if (direction === 1) return { type: "wheel", button: "none", deltaY: 1, ...base };
    return { type: "wheel", button: "none", horizontal: true, ...base };
  }
  if (released) return { type: "release", button: mouseButton(code), ...base };
  if ((code & 32) !== 0) return { type: "move", button: mouseButton(code), ...base };
  if ((code & 3) === 3) return { type: "release", button: mouseButton(code), ...base };
  return { type: "press", button: mouseButton(code), ...base };
}

/**
 * Consumes only terminal mouse reports. All other bytes are returned unchanged
 * so the normal key decoder remains the sole keyboard owner.
 */
export class AlternateScreenInputParser {
  #pending = Buffer.alloc(0);

  get pendingSequence(): boolean {
    return this.#pending.length > 0;
  }

  push(value: Buffer | string | Uint8Array): AlternateScreenInputResult {
    const incoming = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
    const source = this.#pending.length === 0 ? incoming : Buffer.concat([this.#pending, incoming]);
    this.#pending = Buffer.alloc(0);
    const output: Buffer[] = [];
    const mouse: AlternateScreenMouseEvent[] = [];
    let focusLost = false;
    let plainStart = 0;
    let index = 0;
    const flushPlain = (end: number): void => {
      if (end > plainStart) output.push(source.subarray(plainStart, end));
    };

    while (index < source.length) {
      if (source[index] !== ESCAPE) {
        index += 1;
        continue;
      }
      const remaining = source.length - index;
      if (remaining < 2) {
        flushPlain(index);
        this.#pending = Buffer.from(source.subarray(index));
        plainStart = source.length;
        break;
      }
      if (source[index + 1] !== CSI) {
        index += 1;
        continue;
      }
      if (remaining < 3) {
        flushPlain(index);
        this.#pending = Buffer.from(source.subarray(index));
        plainStart = source.length;
        break;
      }
      const kind = source[index + 2];
      if (kind === 0x49 || kind === 0x4f) {
        flushPlain(index);
        focusLost ||= kind === 0x4f;
        index += 3;
        plainStart = index;
        continue;
      }
      if (kind === LEGACY_MOUSE) {
        if (remaining < 6) {
          flushPlain(index);
          this.#pending = Buffer.from(source.subarray(index));
          plainStart = source.length;
          break;
        }
        flushPlain(index);
        const decoded = decodedMouse(
          source[index + 3]! - 32,
          source[index + 4]! - 32,
          source[index + 5]! - 32,
          ((source[index + 3]! - 32) & 3) === 3,
        );
        if (decoded !== undefined) mouse.push(decoded);
        index += 6;
        plainStart = index;
        continue;
      }
      if (kind !== SGR_MOUSE) {
        index += 1;
        continue;
      }

      let end = index + 3;
      while (
        end < source.length
        && end - index <= MAX_MOUSE_SEQUENCE_BYTES
        && source[end] !== 0x4d
        && source[end] !== 0x6d
      ) end += 1;
      if (end >= source.length && source.length - index <= MAX_MOUSE_SEQUENCE_BYTES) {
        flushPlain(index);
        this.#pending = Buffer.from(source.subarray(index));
        plainStart = source.length;
        break;
      }
      flushPlain(index);
      if (end < source.length && end - index <= MAX_MOUSE_SEQUENCE_BYTES) {
        const body = source.subarray(index + 3, end).toString("ascii");
        const match = /^(\d{1,3});(\d{1,5});(\d{1,5})$/u.exec(body);
        if (match !== null) {
          const decoded = decodedMouse(
            Number.parseInt(match[1]!, 10),
            Number.parseInt(match[2]!, 10),
            Number.parseInt(match[3]!, 10),
            source[end] === 0x6d,
          );
          if (decoded !== undefined) mouse.push(decoded);
        }
        index = end + 1;
      } else {
        // A recognized but unbounded mouse prefix is discarded rather than
        // being reinterpreted as editor input.
        let terminator = end;
        const maximum = Math.min(source.length, index + 4_096);
        while (terminator < maximum && source[terminator] !== 0x4d && source[terminator] !== 0x6d) {
          terminator += 1;
        }
        index = terminator < maximum ? terminator + 1 : source.length;
      }
      plainStart = index;
    }
    flushPlain(source.length);
    return {
      data: output.length === 0 ? Buffer.alloc(0) : Buffer.concat(output),
      mouse,
      focusLost,
    };
  }

  flushPending(): Buffer {
    const pending = this.#pending;
    this.#pending = Buffer.alloc(0);
    if (
      pending.length >= 3
      && pending[0] === ESCAPE
      && pending[1] === CSI
      && (pending[2] === SGR_MOUSE || pending[2] === LEGACY_MOUSE)
    ) return Buffer.alloc(0);
    return pending;
  }

  clear(): void {
    this.#pending = Buffer.alloc(0);
  }
}

function controlEnd(value: string, start: number): number {
  const kind = value[start + 1];
  if (kind === "[") {
    for (let index = start + 2; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index + 1;
    }
    return value.length;
  }
  if (kind === "]" || kind === "P" || kind === "^" || kind === "_") {
    for (let index = start + 2; index < value.length; index += 1) {
      if (value[index] === "\u0007") return index + 1;
      if (value[index] === "\u001b" && value[index + 1] === "\\") return index + 2;
    }
    return value.length;
  }
  return Math.min(value.length, start + 2);
}

function oscHyperlink(value: string): string | null | undefined {
  if (!value.startsWith("\u001b]8;")) return undefined;
  const terminatorLength = value.endsWith("\u001b\\") ? 2 : value.endsWith("\u0007") ? 1 : 0;
  const payload = value.slice(4, Math.max(4, value.length - terminatorLength));
  const separator = payload.indexOf(";");
  if (separator < 0) return undefined;
  const target = payload.slice(separator + 1);
  return target === "" ? null : trustedHyperlinkTarget(target) ?? null;
}

function lineTokens(value: string): LineToken[] {
  const tokens: LineToken[] = [];
  let hyperlink: string | undefined;
  let index = 0;
  let textStart = 0;
  const flushText = (end: number): void => {
    if (end <= textStart) return;
    tokens.push({
      type: "text",
      value: value.slice(textStart, end),
      ...(hyperlink === undefined ? {} : { hyperlink }),
    });
  };
  while (index < value.length) {
    if (value[index] !== "\u001b") {
      index += 1;
      continue;
    }
    flushText(index);
    const end = controlEnd(value, index);
    const control = value.slice(index, end);
    const target = oscHyperlink(control);
    if (target === null) hyperlink = undefined;
    else if (target !== undefined) hyperlink = target;
    tokens.push({ type: "control", value: control });
    index = end;
    textStart = index;
  }
  flushText(value.length);
  return tokens;
}

function screenGrid(value: string, columns: number, rows: number): ScreenGrid {
  const width = Math.max(1, Math.min(500, columns));
  const height = Math.max(1, Math.min(200, rows));
  const selectedRows: (ScreenCell | undefined)[][] = [];
  for (const line of value.split("\n").slice(0, height)) {
    const cells: (ScreenCell | undefined)[] = Array.from({ length: width });
    let column = 0;
    for (const token of lineTokens(line)) {
      if (token.type === "control") continue;
      for (const grapheme of splitGraphemes(token.value)) {
        const graphemeCells = cellWidth(grapheme);
        if (graphemeCells === 0) {
          for (let candidate = Math.min(column - 1, width - 1); candidate >= 0; candidate -= 1) {
            const prior = cells[candidate];
            if (prior === undefined || prior.continuation) continue;
            prior.text += grapheme;
            break;
          }
          continue;
        }
        if (column >= width || column + graphemeCells > width) break;
        cells[column] = {
          text: grapheme,
          width: graphemeCells,
          continuation: false,
          ...(token.hyperlink === undefined ? {} : { hyperlink: token.hyperlink }),
        };
        for (let offset = 1; offset < graphemeCells; offset += 1) {
          cells[column + offset] = {
            text: "",
            width: 0,
            continuation: true,
            ...(token.hyperlink === undefined ? {} : { hyperlink: token.hyperlink }),
          };
        }
        column += graphemeCells;
      }
    }
    selectedRows.push(cells);
  }
  while (selectedRows.length < height) selectedRows.push(Array.from({ length: width }));
  return { columns: width, rows: selectedRows };
}

function pointOrder(left: AlternateScreenPoint, right: AlternateScreenPoint): number {
  return left.row === right.row ? left.column - right.column : left.row - right.row;
}

function orderedSelection(selection: Selection): readonly [AlternateScreenPoint, AlternateScreenPoint] {
  return pointOrder(selection.anchor, selection.focus) <= 0
    ? [selection.anchor, selection.focus]
    : [selection.focus, selection.anchor];
}

function inSelection(
  row: number,
  column: number,
  width: number,
  selection: Selection,
): boolean {
  const [start, end] = orderedSelection(selection);
  if (row < start.row || row > end.row) return false;
  const left = row === start.row ? start.column : 0;
  const right = row === end.row ? end.column : Number.MAX_SAFE_INTEGER;
  return column <= right && column + Math.max(1, width) - 1 >= left;
}

function clampPoint(grid: ScreenGrid, value: AlternateScreenPoint): AlternateScreenPoint | undefined {
  if (
    !Number.isSafeInteger(value.row)
    || !Number.isSafeInteger(value.column)
    || value.row < 0
    || value.column < 0
    || value.row >= grid.rows.length
    || value.column >= grid.columns
  ) return undefined;
  const row = grid.rows[value.row]!;
  let column = value.column;
  while (column > 0 && row[column]?.continuation === true) column -= 1;
  return { row: value.row, column };
}

function selectionText(
  grid: ScreenGrid,
  selection: Selection,
  maximumBytes: number,
): { text: string; truncated: boolean } {
  const [start, end] = orderedSelection(selection);
  const lines: string[] = [];
  for (let rowIndex = start.row; rowIndex <= end.row; rowIndex += 1) {
    const row = grid.rows[rowIndex];
    if (row === undefined) break;
    const left = rowIndex === start.row ? start.column : 0;
    const right = rowIndex === end.row ? end.column : grid.columns - 1;
    let line = "";
    for (let column = left; column <= right; column += 1) {
      const cell = row[column];
      if (cell?.continuation === true) continue;
      line += cell?.text ?? " ";
    }
    lines.push(line.replace(/ +$/u, ""));
  }
  while (lines.at(-1) === "") lines.pop();
  const source = lines.join("\n");
  if (Buffer.byteLength(source, "utf8") <= maximumBytes) return { text: source, truncated: false };
  const marker = "…";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const selected: string[] = [];
  let bytes = 0;
  for (const grapheme of splitGraphemes(source)) {
    const next = Buffer.byteLength(grapheme, "utf8");
    if (bytes + next + markerBytes > maximumBytes) break;
    selected.push(grapheme);
    bytes += next;
  }
  return { text: `${selected.join("")}${marker}`, truncated: true };
}

function selectionTextFromHistory(
  history: SelectionHistory,
  columns: number,
  selection: Selection,
  maximumBytes: number,
): { text: string; truncated: boolean } {
  const [start, end] = orderedSelection(selection);
  const lines: string[] = [];
  for (let rowIndex = start.row; rowIndex <= end.row; rowIndex += 1) {
    const row = history.rows.get(rowIndex);
    if (row === undefined) return selectionTextSource(lines.join("\n"), maximumBytes, true);
    const left = rowIndex === start.row ? start.column : 0;
    const right = rowIndex === end.row ? end.column : columns - 1;
    let line = "";
    for (let column = left; column <= right; column += 1) {
      const cell = row[column];
      if (cell?.continuation === true) continue;
      line += cell?.text ?? " ";
    }
    lines.push(line.replace(/ +$/u, ""));
  }
  while (lines.at(-1) === "") lines.pop();
  return selectionTextSource(lines.join("\n"), maximumBytes, history.truncated);
}

function selectionTextSource(
  source: string,
  maximumBytes: number,
  forceTruncated: boolean,
): { text: string; truncated: boolean } {
  if (!forceTruncated && Buffer.byteLength(source, "utf8") <= maximumBytes) {
    return { text: source, truncated: false };
  }
  const marker = "…";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const selected: string[] = [];
  let bytes = 0;
  for (const grapheme of splitGraphemes(source)) {
    const next = Buffer.byteLength(grapheme, "utf8");
    if (bytes + next + markerBytes > maximumBytes) break;
    selected.push(grapheme);
    bytes += next;
  }
  return { text: `${selected.join("")}${marker}`, truncated: true };
}

function rowSignature(row: readonly (ScreenCell | undefined)[]): string {
  let value = "";
  for (const cell of row) {
    if (cell?.continuation === true) continue;
    value += cell?.text ?? " ";
  }
  return value.replace(/ +$/u, "");
}

function inferredViewShift(
  previous: ScreenGrid,
  previousRegion: AlternateScreenScrollRegion,
  next: ScreenGrid,
  nextRegion: AlternateScreenScrollRegion,
  direction: -1 | 0 | 1,
): { shift: number; uncertain: boolean } {
  if (direction === 0) return { shift: 0, uncertain: false };
  const previousRows = previous.rows.slice(previousRegion.top, previousRegion.bottom + 1).map(rowSignature);
  const nextRows = next.rows.slice(nextRegion.top, nextRegion.bottom + 1).map(rowSignature);
  if (previousRows.length === 0 || nextRows.length === 0) return { shift: 0, uncertain: true };
  if (previousRows.length === nextRows.length
    && previousRows.every((row, index) => row === nextRows[index])) return { shift: 0, uncertain: true };

  const expectedSign = direction > 0 ? -1 : 1;
  const maximumShift = Math.max(0, Math.min(previousRows.length, nextRows.length) - 1);
  let best: { shift: number; score: number; available: number } | undefined;
  let viable = 0;
  for (let distance = 1; distance <= maximumShift; distance += 1) {
    const shift = expectedSign * distance;
    let score = 0;
    let available = 0;
    for (let nextIndex = 0; nextIndex < nextRows.length; nextIndex += 1) {
      const previousIndex = nextIndex + shift;
      if (previousIndex < 0 || previousIndex >= previousRows.length) continue;
      available += 1;
      if (previousRows[previousIndex] === nextRows[nextIndex]) score += 1;
    }
    if (available === 0 || score < Math.max(1, available - 1)) continue;
    viable += 1;
    if (best === undefined || score > best.score
      || (score === best.score && available > best.available)
      || (score === best.score && available === best.available && distance < Math.abs(best.shift))) {
      best = { shift, score, available };
    }
  }
  return best === undefined
    ? { shift: expectedSign, uncertain: true }
    : { shift: best.shift, uncertain: viable > 1 };
}

function highlightedFrame(value: string, selection: Selection): string {
  return value.split("\n").map((line, row) => {
    let column = 0;
    let selected = false;
    let output = "";
    for (const token of lineTokens(line)) {
      if (token.type === "control") {
        output += token.value;
        if (selected && token.value.startsWith("\u001b[") && token.value.endsWith("m")) {
          output += SELECTION_ON;
        }
        continue;
      }
      for (const grapheme of splitGraphemes(token.value)) {
        const width = Math.max(0, cellWidth(grapheme));
        const nextSelected = width > 0 && inSelection(row, column, width, selection);
        if (nextSelected !== selected) {
          output += nextSelected ? SELECTION_ON : SELECTION_OFF;
          selected = nextSelected;
        }
        output += grapheme;
        column += width;
      }
    }
    if (selected) output += SELECTION_OFF;
    return output;
  }).join("\n");
}

/**
 * Owns pointer state for one alternate-screen surface. It stores only the
 * bounded visible cell map; the canonical transcript remains in the TUI model.
 */
export class AlternateScreenInteraction {
  readonly #maximumSelectionBytes: number;
  #grid: ScreenGrid = screenGrid("", 1, 1);
  #selection: Selection | undefined;
  #selectionHistory: SelectionHistory | undefined;
  #scrollRegion: AlternateScreenScrollRegion | undefined;
  #scrollbarDragOffset: number | undefined;
  #scrollbarHovered = false;
  #selectionAutoScroll: -1 | 0 | 1 = 0;

  constructor(maximumSelectionBytes = DEFAULT_SELECTION_BYTES) {
    if (!Number.isSafeInteger(maximumSelectionBytes) || maximumSelectionBytes < 1 || maximumSelectionBytes > 75_000) {
      throw new RangeError("Alternate-screen selection limit must be 1 to 75000 bytes");
    }
    this.#maximumSelectionBytes = maximumSelectionBytes;
  }

  updateFrame(
    value: string,
    columns: number,
    rows: number,
    scrollRegion?: AlternateScreenScrollRegion,
  ): void {
    const nextGrid = screenGrid(value, columns, rows);
    const history = this.#selectionHistory;
    if (history !== undefined && this.#selection?.pressed === true
      && this.#scrollRegion !== undefined && scrollRegion !== undefined) {
      const inferred = inferredViewShift(
        this.#grid,
        this.#scrollRegion,
        nextGrid,
        scrollRegion,
        this.#selectionAutoScroll,
      );
      history.viewOrigin += inferred.shift;
      history.truncated ||= inferred.uncertain;
      history.top = scrollRegion.top;
      history.bottom = scrollRegion.bottom;
      this.#rememberSelectionRows(history, nextGrid);
    }
    this.#grid = nextGrid;
    this.#scrollRegion = scrollRegion;
  }

  decorateFrame(value: string): string {
    if (this.#selection === undefined || !this.#selection.dragged) return value;
    const selection = this.#selectionHistory === undefined
      ? this.#selection
      : {
          ...this.#selection,
          anchor: this.#visibleSelectionPoint(this.#selection.anchor),
          focus: this.#visibleSelectionPoint(this.#selection.focus),
        };
    return selection === undefined
      ? value
      : highlightedFrame(value, selection);
  }

  handle(event: AlternateScreenMouseEvent): readonly AlternateScreenDecision[] {
    if (event.type === "wheel") {
      if (event.horizontal === true || event.deltaY === undefined) return [];
      if (this.#scrollRegion !== undefined
        && (event.point.row < this.#scrollRegion.top || event.point.row > this.#scrollRegion.bottom)) return [];
      this.#selection = undefined;
      this.#selectionHistory = undefined;
      return [...this.#setSelectionAutoScroll(0), { type: "scroll", rows: event.deltaY < 0 ? 3 : -3 }];
    }
    if (event.type === "press") {
      if (event.button !== "left") return [];
      const scrollbar = this.#scrollRegion?.scrollbar;
      if (scrollbar !== undefined && event.point.column === scrollbar.column
        && event.point.row >= this.#scrollRegion!.top && event.point.row <= this.#scrollRegion!.bottom) {
        this.#selection = undefined;
        this.#selectionHistory = undefined;
        this.#scrollbarDragOffset = event.point.row >= scrollbar.thumbTop
          && event.point.row < scrollbar.thumbTop + scrollbar.thumbRows
          ? event.point.row - scrollbar.thumbTop
          : Math.floor(scrollbar.thumbRows / 2);
        return [
          ...this.#setSelectionAutoScroll(0),
          ...this.#setScrollbarHovered(true),
          ...this.#scrollbarDecision(event.point.row),
        ];
      }
      const hover = this.#setScrollbarHovered(false);
      const autoScroll = this.#setSelectionAutoScroll(0);
      const point = clampPoint(this.#grid, event.point);
      this.#selectionHistory = point === undefined ? undefined : this.#newSelectionHistory(point);
      const selectedPoint = point === undefined ? undefined : this.#logicalSelectionPoint(point);
      this.#selection = selectedPoint === undefined
        ? undefined
        : { anchor: selectedPoint, focus: selectedPoint, pressed: true, dragged: false };
      return [...hover, ...autoScroll];
    }
    const selection = this.#selection;
    if (this.#scrollbarDragOffset !== undefined) {
      if (event.type === "move") return this.#scrollbarDecision(event.point.row);
      if (event.type === "release") {
        const decision = this.#scrollbarDecision(event.point.row);
        this.#scrollbarDragOffset = undefined;
        const scrollbar = this.#scrollRegion?.scrollbar;
        return [
          ...decision,
          ...this.#setScrollbarHovered(scrollbar !== undefined
            && event.point.column === scrollbar.column
            && event.point.row >= this.#scrollRegion!.top
            && event.point.row <= this.#scrollRegion!.bottom),
        ];
      }
      return [];
    }
    if (event.type === "move" && (selection === undefined || !selection.pressed)) {
      const scrollbar = this.#scrollRegion?.scrollbar;
      return this.#setScrollbarHovered(scrollbar !== undefined
        && event.point.column === scrollbar.column
        && event.point.row >= this.#scrollRegion!.top
        && event.point.row <= this.#scrollRegion!.bottom);
    }
    if (selection === undefined || !selection.pressed) return [];
    const point = clampPoint(this.#grid, event.point);
    if (point === undefined) return [];
    const selectedPoint = this.#logicalSelectionPoint(point);
    if (selectedPoint === undefined) return [];
    if (event.type === "move") {
      selection.focus = selectedPoint;
      selection.dragged = true;
      const region = this.#scrollRegion;
      if (region !== undefined && point.row <= region.top) return this.#setSelectionAutoScroll(1);
      if (region !== undefined && point.row >= region.bottom) return this.#setSelectionAutoScroll(-1);
      return this.#setSelectionAutoScroll(0);
    }
    if (event.type !== "release") return [];
    selection.focus = selectedPoint;
    selection.pressed = false;
    const autoScroll = this.#setSelectionAutoScroll(0);
    if (pointOrder(selection.anchor, selection.focus) !== 0) selection.dragged = true;
    if (!selection.dragged) {
      this.#selection = undefined;
      this.#selectionHistory = undefined;
      const target = this.#grid.rows[point.row]?.[point.column]?.hyperlink;
      return target === undefined ? autoScroll : [...autoScroll, { type: "open", target }];
    }
    const selected = this.#selectionHistory === undefined
      ? selectionText(this.#grid, selection, this.#maximumSelectionBytes)
      : selectionTextFromHistory(
          this.#selectionHistory,
          this.#grid.columns,
          selection,
          this.#maximumSelectionBytes,
        );
    return selected.text === "" ? autoScroll : [...autoScroll, { type: "copy", ...selected }];
  }

  clear(): void {
    this.#selection = undefined;
    this.#selectionHistory = undefined;
    this.#scrollbarDragOffset = undefined;
    this.#scrollbarHovered = false;
    this.#selectionAutoScroll = 0;
    this.#scrollRegion = undefined;
    this.#grid = screenGrid("", 1, 1);
  }

  cancelPointer(): readonly AlternateScreenDecision[] {
    this.#selection = undefined;
    this.#selectionHistory = undefined;
    this.#scrollbarDragOffset = undefined;
    return [...this.#setSelectionAutoScroll(0), ...this.#setScrollbarHovered(false)];
  }

  #scrollbarDecision(row: number): readonly AlternateScreenDecision[] {
    const region = this.#scrollRegion;
    const scrollbar = region?.scrollbar;
    if (region === undefined || scrollbar === undefined) return [];
    const travel = Math.max(0, scrollbar.viewportRows - scrollbar.thumbRows);
    const thumb = Math.max(
      0,
      Math.min(travel, Math.trunc(row) - region.top - (this.#scrollbarDragOffset ?? 0)),
    );
    const maximumStart = Math.max(0, scrollbar.totalRows - scrollbar.viewportRows);
    const start = travel === 0 ? 0 : Math.round((thumb / travel) * maximumStart);
    return [{
      type: "scroll_to",
      rowsFromEnd: Math.max(0, scrollbar.totalRows - scrollbar.viewportRows - start),
    }];
  }

  #setScrollbarHovered(active: boolean): readonly AlternateScreenDecision[] {
    if (this.#scrollbarHovered === active) return [];
    this.#scrollbarHovered = active;
    return [{ type: "scrollbar_hover", active }];
  }

  #setSelectionAutoScroll(rows: -1 | 0 | 1): readonly AlternateScreenDecision[] {
    if (this.#selectionAutoScroll === rows) return [];
    this.#selectionAutoScroll = rows;
    return [{ type: "selection_autoscroll", rows }];
  }

  #newSelectionHistory(point: AlternateScreenPoint): SelectionHistory | undefined {
    const region = this.#scrollRegion;
    if (region === undefined || point.row < region.top || point.row > region.bottom) return undefined;
    const history: SelectionHistory = {
      top: region.top,
      bottom: region.bottom,
      viewOrigin: 0,
      rows: new Map(),
      truncated: false,
    };
    this.#rememberSelectionRows(history, this.#grid);
    return history;
  }

  #rememberSelectionRows(history: SelectionHistory, grid: ScreenGrid): void {
    for (let screenRow = history.top; screenRow <= history.bottom; screenRow += 1) {
      const row = grid.rows[screenRow];
      if (row !== undefined) history.rows.set(history.viewOrigin + screenRow - history.top, row);
    }
    while (history.rows.size > MAX_SELECTION_HISTORY_ROWS) {
      let last = Number.NEGATIVE_INFINITY;
      for (const row of history.rows.keys()) last = Math.max(last, row);
      history.rows.delete(last);
      history.truncated = true;
    }
  }

  #logicalSelectionPoint(point: AlternateScreenPoint): AlternateScreenPoint | undefined {
    const history = this.#selectionHistory;
    if (history === undefined) return point;
    const row = Math.max(history.top, Math.min(history.bottom, point.row));
    return { row: history.viewOrigin + row - history.top, column: point.column };
  }

  #visibleSelectionPoint(point: AlternateScreenPoint): AlternateScreenPoint {
    const history = this.#selectionHistory!;
    return { row: point.row - history.viewOrigin + history.top, column: point.column };
  }
}
