import { cjkBreakRegex, getGraphemeSegmenter, isWhitespaceChar, visibleWidth } from "./utils.js";

export interface TextChunk {
  text: string;
  startIndex: number;
  endIndex: number;
}

const graphemes = getGraphemeSegmenter();

/** Wrap one logical line while retaining source offsets for cursor placement. */
export function wordWrapLine(line: string, maxWidth: number, preSegmented?: Intl.SegmentData[]): TextChunk[] {
  if (line.length === 0 || maxWidth <= 0) return [{ text: "", startIndex: 0, endIndex: 0 }];
  if (visibleWidth(line) <= maxWidth) return [{ text: line, startIndex: 0, endIndex: line.length }];

  const units = preSegmented ?? [...graphemes.segment(line)];
  const result: TextChunk[] = [];
  let chunkStart = 0;
  let currentWidth = 0;
  let breakIndex = -1;
  let widthAtBreak = 0;

  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index]!;
    const unitWidth = visibleWidth(unit.segment);
    const inner = [...graphemes.segment(unit.segment)];
    const atomic = inner.length > 1;

    if (currentWidth + unitWidth > maxWidth) {
      if (breakIndex >= 0 && currentWidth - widthAtBreak + unitWidth <= maxWidth) {
        result.push({ text: line.slice(chunkStart, breakIndex), startIndex: chunkStart, endIndex: breakIndex });
        chunkStart = breakIndex;
        currentWidth -= widthAtBreak;
      } else if (chunkStart < unit.index) {
        result.push({ text: line.slice(chunkStart, unit.index), startIndex: chunkStart, endIndex: unit.index });
        chunkStart = unit.index;
        currentWidth = 0;
      }
      breakIndex = -1;
    }

    if (unitWidth > maxWidth) {
      const pieces = inner.length > 1
        ? wordWrapLine(unit.segment, maxWidth)
        : [{ text: unit.segment, startIndex: 0, endIndex: unit.segment.length }];
      for (const piece of pieces.slice(0, -1)) {
        result.push({
          text: piece.text,
          startIndex: unit.index + piece.startIndex,
          endIndex: unit.index + piece.endIndex,
        });
      }
      const tail = pieces.at(-1)!;
      chunkStart = unit.index + tail.startIndex;
      currentWidth = visibleWidth(tail.text);
      breakIndex = -1;
      continue;
    }

    currentWidth += unitWidth;
    const next = units[index + 1];
    if (next !== undefined) {
      const whitespace = !atomic && isWhitespaceChar(unit.segment);
      const nextAtomic = [...graphemes.segment(next.segment)].length > 1;
      if (whitespace && (nextAtomic || !isWhitespaceChar(next.segment))) {
        breakIndex = next.index;
        widthAtBreak = currentWidth;
      } else if (!whitespace && !isWhitespaceChar(next.segment)
        && (!atomic && cjkBreakRegex.test(unit.segment) || !nextAtomic && cjkBreakRegex.test(next.segment))) {
        breakIndex = next.index;
        widthAtBreak = currentWidth;
      }
    }
  }

  if (chunkStart < line.length) result.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });
  return result.length > 0 ? result : [{ text: "", startIndex: 0, endIndex: 0 }];
}
