import type { Frame } from "./types.js";
import {
  MAX_TERMINAL_IMAGE_AGGREGATE_BYTES,
  MAX_TERMINAL_IMAGE_COUNT,
  deleteKittyImage,
  encodeTerminalImage,
  validateTerminalImagePlacement,
  type TerminalImagePlacement,
  type TerminalImageProtocol,
} from "./terminal-image.js";
import { cellWidth } from "./unicode.js";

const BEGIN_SYNCHRONIZED_UPDATE = "\u001b[?2026h";
const END_SYNCHRONIZED_UPDATE = "\u001b[?2026l";
const ERASE_ROW = "\u001b[2K";
const ERASE_VIEWPORT = "\u001b[2J\u001b[H";
const SAVE_CURSOR = "\u001b7";
const RESTORE_CURSOR = "\u001b8";
const MAX_COLUMNS = 500;
const MAX_ROWS = 200;
const MAX_ROW_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_UPDATE_BYTES = Math.ceil(MAX_TERMINAL_IMAGE_AGGREGATE_BYTES * 4 / 3) + 2 * 1024 * 1024;

export type SurfaceRenderStrategy =
  | "none"
  | "cursor"
  | "initial"
  | "diff"
  | "image-redraw"
  | "surface-clear"
  | "viewport-clear";

export interface SurfaceRenderResult {
  output: string;
  strategy: SurfaceRenderStrategy;
  changedRows: number;
}

export interface LiveSurfaceRendererOptions {
  alternateScreen: boolean;
  synchronizedOutput?: boolean;
  imageProtocol?: TerminalImageProtocol | null;
  clearOnShrink?: boolean;
}

interface RenderedImageIdentity {
  key: string;
  fingerprint: string;
  imageId: number;
  row: number;
  column: number;
  columns: number;
  rows: number;
}

interface ValidatedImageSource extends RenderedImageIdentity {
  mediaType: TerminalImagePlacement["mediaType"];
  data: string;
  bytes: number;
  widthPx: number;
  heightPx: number;
}

function dimension(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function moveRows(delta: number): string {
  if (delta === 0) return "";
  return delta > 0 ? `\u001b[${delta}B` : `\u001b[${-delta}A`;
}

function checkedRows(text: string, columns: number, terminalRows: number): string[] {
  if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) throw new RangeError("Live surface exceeds the 2 MiB frame limit");
  if (text === "") return [];
  const rows = text.split("\n");
  if (rows.length > terminalRows || rows.length > MAX_ROWS) {
    throw new RangeError(`Live surface has ${rows.length} rows but the terminal has ${terminalRows}`);
  }
  for (const [index, row] of rows.entries()) {
    if (row.includes("\r")) throw new Error(`Live surface row ${index} contains a carriage return`);
    if (Buffer.byteLength(row, "utf8") > MAX_ROW_BYTES) throw new RangeError(`Live surface row ${index} exceeds 64 KiB`);
    const width = cellWidth(row);
    if (width > columns) throw new RangeError(`Live surface row ${index} is ${width} cells wide but the terminal has ${columns}`);
  }
  return rows;
}

function checkedImages(
  images: readonly TerminalImagePlacement[] | undefined,
  rowCount: number,
  columns: number,
  protocol: TerminalImageProtocol | null,
  validatedSources: Map<string, ValidatedImageSource>,
): TerminalImagePlacement[] {
  if (images === undefined || images.length === 0) return [];
  if (protocol === null) throw new Error("Terminal image placements require an active image protocol");
  if (images.length > MAX_TERMINAL_IMAGE_COUNT) {
    throw new RangeError(`Live surface accepts at most ${MAX_TERMINAL_IMAGE_COUNT} terminal images`);
  }
  let aggregateBytes = 0;
  const ids = new Set<number>();
  const selected: TerminalImagePlacement[] = [];
  for (const image of images) {
    const cacheKey = `${image.key}\u0000${image.fingerprint}`;
    const cached = validatedSources.get(cacheKey);
    if (
      cached === undefined
      || cached.imageId !== image.imageId
      || cached.mediaType !== image.mediaType
      || cached.data !== image.data
      || cached.bytes !== image.bytes
      || cached.widthPx !== image.widthPx
      || cached.heightPx !== image.heightPx
      || cached.columns !== image.columns
      || cached.rows !== image.rows
    ) {
      validateTerminalImagePlacement(image);
      validatedSources.set(cacheKey, { ...imageIdentity(image), ...image });
    }
    if (protocol === "kitty" && image.mediaType !== "image/png") {
      throw new Error("Kitty live-surface placements require PNG images");
    }
    if (image.row + image.rows > rowCount || image.column + image.columns > columns) {
      throw new RangeError("Terminal image placement exceeds its reserved live-surface rows or columns");
    }
    if (ids.has(image.imageId)) throw new Error("Terminal image IDs must be unique within a frame");
    ids.add(image.imageId);
    aggregateBytes += image.bytes;
    if (aggregateBytes > MAX_TERMINAL_IMAGE_AGGREGATE_BYTES) {
      throw new RangeError(`Terminal images exceed ${MAX_TERMINAL_IMAGE_AGGREGATE_BYTES} aggregate bytes`);
    }
    selected.push(image);
  }
  return selected;
}

function imageIdentity(image: TerminalImagePlacement): RenderedImageIdentity {
  return {
    key: image.key,
    fingerprint: image.fingerprint,
    imageId: image.imageId,
    row: image.row,
    column: image.column,
    columns: image.columns,
    rows: image.rows,
  };
}

function sameImages(left: readonly RenderedImageIdentity[], right: readonly TerminalImagePlacement[]): boolean {
  return left.length === right.length && left.every((image, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && image.key === candidate.key
      && image.fingerprint === candidate.fingerprint
      && image.imageId === candidate.imageId
      && image.row === candidate.row
      && image.column === candidate.column
      && image.columns === candidate.columns
      && image.rows === candidate.rows;
  });
}

/**
 * Renders only the mutable terminal surface. Inline transcript rows are outside
 * this object's ownership and are never addressed by a differential update.
 */
export class LiveSurfaceRenderer {
  readonly #alternateScreen: boolean;
  readonly #synchronizedOutput: boolean;
  readonly #imageProtocol: TerminalImageProtocol | null;
  #clearOnShrink: boolean;
  readonly #validatedImageSources = new Map<string, ValidatedImageSource>();
  #rows: string[] = [];
  #images: RenderedImageIdentity[] = [];
  #columns = 0;
  #terminalRows = 0;
  #cursorRow = 0;
  #cursorColumn = 0;

  constructor(options: LiveSurfaceRendererOptions) {
    this.#alternateScreen = options.alternateScreen;
    this.#synchronizedOutput = options.synchronizedOutput !== false;
    this.#imageProtocol = options.imageProtocol ?? null;
    this.#clearOnShrink = options.clearOnShrink === true;
  }

  setClearOnShrink(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new TypeError("Clear-on-shrink must be boolean");
    this.#clearOnShrink = enabled;
  }

  render(frame: Frame, size: { columns: number; rows: number }): SurfaceRenderResult {
    const columns = dimension(size.columns, MAX_COLUMNS, "Terminal columns");
    const terminalRows = dimension(size.rows, MAX_ROWS, "Terminal rows");
    const nextRows = checkedRows(frame.text, columns, terminalRows);
    const nextImages = checkedImages(frame.images, nextRows.length, columns, this.#imageProtocol, this.#validatedImageSources);
    const target = this.#targetCursor(frame.cursor, nextRows.length, columns);
    const resized = this.#columns !== 0 && (this.#columns !== columns || this.#terminalRows !== terminalRows);

    let body = "";
    let strategy: SurfaceRenderStrategy = "none";
    let changedRows = 0;
    let physicalRow = this.#cursorRow;
    const textChanged = this.#rows.length !== nextRows.length
      || this.#rows.some((row, index) => row !== nextRows[index]);
    const imagesChanged = !sameImages(this.#images, nextImages);
    const imageRedraw = (this.#images.length > 0 || nextImages.length > 0) && (resized || textChanged || imagesChanged);

    if (imageRedraw) {
      body += this.#deleteRenderedImages();
      const initial = this.#columns === 0 && this.#rows.length === 0;
      let viewport = false;
      if (!initial) {
        const cleared = this.#clearForResize(terminalRows, physicalRow);
        body += cleared.output;
        physicalRow = 0;
        viewport = cleared.viewport;
      }
      const drawn = this.#drawFromAnchor(nextRows, physicalRow);
      body += drawn.output;
      physicalRow = drawn.row;
      body += this.#drawImages(nextImages, physicalRow);
      strategy = initial ? "initial" : viewport ? "viewport-clear" : "image-redraw";
      changedRows = Math.max(this.#rows.length, nextRows.length);
    } else if (resized) {
      const cleared = this.#clearForResize(terminalRows, physicalRow);
      body += cleared.output;
      physicalRow = 0;
      strategy = cleared.viewport ? "viewport-clear" : "surface-clear";
      changedRows = Math.max(this.#rows.length, nextRows.length);
      const drawn = this.#drawFromAnchor(nextRows, physicalRow);
      body += drawn.output;
      physicalRow = drawn.row;
    } else if (this.#clearOnShrink && nextRows.length < this.#rows.length) {
      const cleared = this.#clearForResize(terminalRows, physicalRow);
      body += cleared.output;
      physicalRow = 0;
      const drawn = this.#drawFromAnchor(nextRows, physicalRow);
      body += drawn.output;
      physicalRow = drawn.row;
      strategy = cleared.viewport ? "viewport-clear" : "surface-clear";
      changedRows = this.#rows.length;
    } else if (this.#rows.length === 0 && nextRows.length > 0) {
      if (this.#alternateScreen && this.#columns === 0) body += "\u001b[H";
      const drawn = this.#drawFromAnchor(nextRows, physicalRow);
      body += drawn.output;
      physicalRow = drawn.row;
      strategy = "initial";
      changedRows = nextRows.length;
    } else {
      const changed = this.#changedIndexes(nextRows);
      changedRows = changed.length;
      for (const row of changed) {
        if (row >= this.#rows.length || row >= nextRows.length) continue;
        body += `\r${moveRows(row - physicalRow)}${ERASE_ROW}${nextRows[row] ?? ""}`;
        physicalRow = row;
      }

      if (nextRows.length > this.#rows.length) {
        if (this.#rows.length === 0) {
          body += `\r${moveRows(-physicalRow)}${ERASE_ROW}${nextRows[0] ?? ""}`;
          physicalRow = 0;
        } else {
          body += `\r${moveRows(this.#rows.length - 1 - physicalRow)}`;
          physicalRow = this.#rows.length - 1;
        }
        for (let row = Math.max(1, this.#rows.length); row < nextRows.length; row += 1) {
          body += `\r\n${ERASE_ROW}${nextRows[row] ?? ""}`;
          physicalRow = row;
        }
      } else if (nextRows.length < this.#rows.length) {
        const firstStale = nextRows.length;
        body += `\r${moveRows(firstStale - physicalRow)}`;
        physicalRow = firstStale;
        for (let row = firstStale; row < this.#rows.length; row += 1) {
          body += `${ERASE_ROW}${row + 1 < this.#rows.length ? "\u001b[1B\r" : ""}`;
          physicalRow = row;
        }
      }
      if (changedRows > 0) strategy = "diff";
    }

    const cursorMove = this.#positionCursor(physicalRow, target.row, target.column, body !== "");
    body += cursorMove;
    if (strategy === "none" && cursorMove !== "") strategy = "cursor";

    this.#rows = nextRows;
    this.#images = nextImages.map(imageIdentity);
    const liveImageSources = new Set(nextImages.map((image) => `${image.key}\u0000${image.fingerprint}`));
    for (const key of this.#validatedImageSources.keys()) if (!liveImageSources.has(key)) this.#validatedImageSources.delete(key);
    this.#columns = columns;
    this.#terminalRows = terminalRows;
    this.#cursorRow = target.row;
    this.#cursorColumn = target.column;

    return {
      output: this.#wrap(body),
      strategy,
      changedRows,
    };
  }

  clear(size?: { columns: number; rows: number }): string {
    const deletedImages = this.#deleteRenderedImages();
    if (this.#rows.length === 0) {
      this.resetAnchor();
      return this.#wrap(deletedImages);
    }
    let body: string;
    const columns = size === undefined ? this.#columns : dimension(size.columns, MAX_COLUMNS, "Terminal columns");
    const terminalRows = size === undefined ? this.#terminalRows : dimension(size.rows, MAX_ROWS, "Terminal rows");
    const resized = this.#columns !== 0 && (columns !== this.#columns || terminalRows !== this.#terminalRows);
    if (resized) {
      body = this.#clearForResize(terminalRows, this.#cursorRow).output;
    } else if (this.#alternateScreen) {
      body = ERASE_VIEWPORT;
    } else if (this.#rows.length <= this.#terminalRows) {
      body = `\r${moveRows(-this.#cursorRow)}`;
      for (let row = 0; row < this.#rows.length; row += 1) {
        body += `${ERASE_ROW}${row + 1 < this.#rows.length ? "\u001b[1B\r" : ""}`;
      }
      if (this.#rows.length > 1) body += `\u001b[${this.#rows.length - 1}A`;
      body += "\r";
    } else {
      body = ERASE_VIEWPORT;
    }
    this.resetAnchor();
    return this.#wrap(`${deletedImages}${body}`);
  }

  leaveInlineSurface(size?: { columns: number; rows: number }): string {
    if (this.#alternateScreen) {
      const output = this.#deleteRenderedImages();
      this.resetAnchor();
      return this.#wrap(output);
    }
    if (size !== undefined && this.#columns !== 0 && (size.columns !== this.#columns || size.rows !== this.#terminalRows)) {
      return `${this.clear(size)}\r\n`;
    }
    const lastRow = Math.max(0, this.#rows.length - 1);
    const output = `${this.#deleteRenderedImages()}\r${moveRows(lastRow - this.#cursorRow)}\r\n`;
    this.resetAnchor();
    return output;
  }

  resetAnchor(): void {
    this.#rows = [];
    this.#images = [];
    this.#validatedImageSources.clear();
    this.#columns = 0;
    this.#terminalRows = 0;
    this.#cursorRow = 0;
    this.#cursorColumn = 0;
  }

  #targetCursor(cursor: Frame["cursor"], rowCount: number, columns: number): { row: number; column: number } {
    if (rowCount === 0) return { row: 0, column: 0 };
    return {
      row: Math.max(0, Math.min(rowCount - 1, (cursor?.row ?? rowCount) - 1)),
      column: Math.max(0, Math.min(columns - 1, (cursor?.column ?? 1) - 1)),
    };
  }

  #changedIndexes(nextRows: readonly string[]): number[] {
    const changed: number[] = [];
    const count = Math.max(this.#rows.length, nextRows.length);
    for (let row = 0; row < count; row += 1) {
      if (this.#rows[row] !== nextRows[row]) changed.push(row);
    }
    return changed;
  }

  #clearForResize(terminalRows: number, physicalRow: number): { output: string; viewport: boolean } {
    if (this.#alternateScreen || this.#rows.length > terminalRows || this.#rows.length > this.#terminalRows) {
      return { output: ERASE_VIEWPORT, viewport: true };
    }
    let output = `\r${moveRows(-physicalRow)}`;
    for (let row = 0; row < this.#rows.length; row += 1) {
      output += `${ERASE_ROW}${row + 1 < this.#rows.length ? "\u001b[1B\r" : ""}`;
    }
    if (this.#rows.length > 1) output += `\u001b[${this.#rows.length - 1}A`;
    output += "\r";
    return { output, viewport: false };
  }

  #drawFromAnchor(rows: readonly string[], physicalRow: number): { output: string; row: number } {
    if (rows.length === 0) return { output: "", row: 0 };
    let output = `\r${moveRows(-physicalRow)}${ERASE_ROW}${rows[0] ?? ""}`;
    let row = 0;
    for (let index = 1; index < rows.length; index += 1) {
      output += `\r\n${ERASE_ROW}${rows[index] ?? ""}`;
      row = index;
    }
    return { output, row };
  }

  #drawImages(images: readonly TerminalImagePlacement[], physicalRow: number): string {
    if (images.length === 0 || this.#imageProtocol === null) return "";
    return images.map((image) => {
      const move = `\r${moveRows(image.row - physicalRow)}${image.column === 0 ? "" : `\u001b[${image.column}C`}`;
      return `${SAVE_CURSOR}${move}${encodeTerminalImage(this.#imageProtocol!, image)}${RESTORE_CURSOR}`;
    }).join("");
  }

  #deleteRenderedImages(): string {
    if (this.#imageProtocol !== "kitty") return "";
    return this.#images.map((image) => deleteKittyImage(image.imageId)).join("");
  }

  #positionCursor(currentRow: number, targetRow: number, targetColumn: number, force: boolean): string {
    const rowMove = moveRows(targetRow - currentRow);
    return !force && rowMove === "" && targetColumn === this.#cursorColumn
      ? ""
      : `\r${rowMove}${targetColumn === 0 ? "" : `\u001b[${targetColumn}C`}`;
  }

  #wrap(body: string): string {
    if (body === "") return "";
    const output = this.#synchronizedOutput ? `${BEGIN_SYNCHRONIZED_UPDATE}${body}${END_SYNCHRONIZED_UPDATE}` : body;
    if (Buffer.byteLength(output, "utf8") > MAX_FRAME_BYTES + MAX_ROW_BYTES + MAX_IMAGE_UPDATE_BYTES) {
      throw new RangeError("Live surface update exceeds the output limit");
    }
    return output;
  }
}
