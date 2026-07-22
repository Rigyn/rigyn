import { getWordSegmenter, isWhitespaceChar, PUNCTUATION_REGEX } from "./utils.js";

export interface WordNavigationOptions {
  segment?: (text: string) => Iterable<Intl.SegmentData>;
  isAtomicSegment?: (segment: string) => boolean;
}

export function findWordBackward(text: string, cursor: number, options: WordNavigationOptions = {}): number {
  if (cursor <= 0) return 0;
  const source = text.slice(0, cursor);
  const segments = [...(options.segment?.(source) ?? getWordSegmenter().segment(source))];
  let target = cursor;
  while (segments.length > 0 && !options.isAtomicSegment?.(segments.at(-1)!.segment) && isWhitespaceChar(segments.at(-1)!.segment)) {
    target -= segments.pop()!.segment.length;
  }
  const last = segments.at(-1);
  if (!last) return target;
  if (options.isAtomicSegment?.(last.segment)) return target - last.segment.length;
  if (last.isWordLike) {
    const punctuation = [...last.segment.matchAll(new RegExp(PUNCTUATION_REGEX, "gu"))].at(-1);
    return target - (punctuation ? last.segment.length - punctuation.index! - punctuation[0].length : last.segment.length);
  }
  while (segments.length > 0) {
    const segment = segments.at(-1)!;
    if (segment.isWordLike || isWhitespaceChar(segment.segment) || options.isAtomicSegment?.(segment.segment)) break;
    target -= segments.pop()!.segment.length;
  }
  return target;
}

export function findWordForward(text: string, cursor: number, options: WordNavigationOptions = {}): number {
  if (cursor >= text.length) return text.length;
  const iterator = (options.segment?.(text.slice(cursor)) ?? getWordSegmenter().segment(text.slice(cursor)))[Symbol.iterator]();
  let current = iterator.next();
  let target = cursor;
  while (!current.done && !options.isAtomicSegment?.(current.value.segment) && isWhitespaceChar(current.value.segment)) {
    target += current.value.segment.length;
    current = iterator.next();
  }
  if (current.done) return target;
  if (options.isAtomicSegment?.(current.value.segment)) return target + current.value.segment.length;
  if (current.value.isWordLike) return target + (PUNCTUATION_REGEX.exec(current.value.segment)?.index ?? current.value.segment.length);
  while (!current.done && !current.value.isWordLike && !isWhitespaceChar(current.value.segment) && !options.isAtomicSegment?.(current.value.segment)) {
    target += current.value.segment.length;
    current = iterator.next();
  }
  return target;
}
