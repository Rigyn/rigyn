interface TextSegment {
  readonly index: number;
  readonly segment: string;
}

type SegmentKind = "space" | "word" | "other";

const graphemeSegments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function segments(value: string): TextSegment[] {
  return Array.from(graphemeSegments.segment(value), ({ index, segment }) => ({ index, segment }));
}

function kind(value: string): SegmentKind {
  if (/^\s+$/u.test(value)) return "space";
  if (/[\p{L}\p{N}\p{M}\p{Pc}]/u.test(value)) return "word";
  return "other";
}

export function findWordBackward(value: string, offset: number): number {
  const limit = Math.max(0, Math.min(value.length, Math.trunc(offset)));
  const parts = segments(value.slice(0, limit));
  while (parts.length > 0 && kind(parts.at(-1)!.segment) === "space") parts.pop();
  const last = parts.at(-1);
  if (last === undefined) return 0;
  if (kind(last.segment) !== "word") return last.index;
  let start = last.index;
  while (parts.length > 1 && kind(parts.at(-2)!.segment) === "word") {
    parts.pop();
    start = parts.at(-1)!.index;
  }
  return start;
}

export function findWordForward(value: string, offset: number): number {
  const start = Math.max(0, Math.min(value.length, Math.trunc(offset)));
  const parts = segments(value);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    let end = part.index + part.segment.length;
    if (end <= start || kind(part.segment) === "space") continue;
    if (kind(part.segment) !== "word") return end;
    while (index + 1 < parts.length && kind(parts[index + 1]!.segment) === "word") {
      index += 1;
      const next = parts[index]!;
      end = next.index + next.segment.length;
    }
    return end;
  }
  return value.length;
}
