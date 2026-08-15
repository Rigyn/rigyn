import { isImageLine } from "./terminal-image.js";
import { extractSegments, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.js";

const RESET_CELL_STATE = "\x1b[0m\x1b]8;;\x07";

function integer(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function padOrCrop(line: string, width: number): string {
  const selection = sliceWithWidth(line, 0, width, true);
  return selection.text + " ".repeat(Math.max(0, width - selection.width));
}

/** Overwrites a terminal-cell interval while preserving ANSI state outside it. */
export function compositeTerminalLine(
  background: string,
  foreground: string,
  column: number,
  foregroundWidth: number,
  frameWidth: number,
): string {
  const width = Math.max(0, integer(frameWidth));
  if (width === 0) return "";
  if (isImageLine(background)) return background;
  if (isImageLine(foreground)) {
    throw new Error("Terminal image rows are not supported in clipped or horizontal layouts");
  }

  const requestedStart = integer(column);
  const requestedLength = Math.max(0, integer(foregroundWidth));
  const crop = Math.max(0, -requestedStart);
  const start = Math.max(0, Math.min(width, requestedStart));
  const length = Math.min(Math.max(0, requestedLength - crop), width - start);
  if (length === 0) {
    if (foreground === "" || visibleWidth(foreground) !== 0) return padOrCrop(background, width);
    const preserved = extractSegments(background, start, start, width - start, true);
    const left = preserved.before + " ".repeat(Math.max(0, start - preserved.beforeWidth));
    const combined = `${left}${RESET_CELL_STATE}${foreground}${RESET_CELL_STATE}${preserved.after}`;
    const missing = width - visibleWidth(combined);
    return missing > 0 ? `${combined}${" ".repeat(missing)}` : combined;
  }

  const replacement = sliceWithWidth(foreground, crop, length, true);
  const preserved = extractSegments(background, start, start + length, width - start - length, true);
  const left = preserved.before + " ".repeat(Math.max(0, start - preserved.beforeWidth));
  const middle = replacement.text + " ".repeat(Math.max(0, length - replacement.width));
  let combined = `${left}${RESET_CELL_STATE}${middle}${RESET_CELL_STATE}${preserved.after}`;
  const missing = width - visibleWidth(combined);
  if (missing > 0) combined += " ".repeat(missing);
  return visibleWidth(combined) > width ? sliceByColumn(combined, 0, width, true) : combined;
}

export interface TerminalRowsCompositeOptions {
  row: number;
  column: number;
  width: number;
  totalWidth: number;
  totalHeight?: number;
}

/** Overwrites a rectangular group of text rows within a terminal frame. */
export function compositeTerminalRows(
  background: readonly string[],
  foreground: readonly string[],
  options: TerminalRowsCompositeOptions,
): string[] {
  const firstRow = integer(options.row);
  const height = options.totalHeight === undefined
    ? Math.max(background.length, foreground.length === 0 ? 0 : firstRow + foreground.length)
    : Math.max(0, integer(options.totalHeight));
  const width = Math.max(0, integer(options.totalWidth));
  const frame = Array.from({ length: height }, (_, row) => {
    const line = background[row] ?? "";
    return isImageLine(line) ? line : padOrCrop(line, width);
  });

  foreground.forEach((line, sourceRow) => {
    const destination = firstRow + sourceRow;
    if (destination < 0 || destination >= frame.length) return;
    frame[destination] = compositeTerminalLine(
      frame[destination]!,
      line,
      options.column,
      options.width,
      options.totalWidth,
    );
  });
  return frame;
}
