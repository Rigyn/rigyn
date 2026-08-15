import { eastAsianWidth } from "get-east-asian-width";

const ansiPattern = /(?:\u001b_rigyn:c\u0007|\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)|\u001b[P_^X](?:[^\u001b]|\u001b(?!\\))*\u001b\\|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b[@-_])/gu;
const asciiOnly = /^[\u0000-\u007f]*$/u;
const zeroWidth = /^[\p{Control}\p{Mark}\p{Default_Ignorable_Code_Point}]+$/u;
const leadingZeroWidth = /^[\p{Control}\p{Mark}\p{Default_Ignorable_Code_Point}]+/u;

const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

export function splitGraphemes(value: string): string[] {
  if (value === "") return [];
  if (asciiOnly.test(value)) return Array.from(value);
  if (segmenter === undefined) return Array.from(value);
  return Array.from(segmenter.segment(value), (entry) => entry.segment);
}

export function graphemeWidth(grapheme: string): number {
  if (grapheme === "\t") return 3;
  if (grapheme.length === 1) {
    const codePoint = grapheme.charCodeAt(0);
    if (codePoint < 0x20 || codePoint === 0x7f) return 0;
    if (codePoint < 0x80) return 1;
  }
  if (grapheme === "" || zeroWidth.test(grapheme)) return 0;
  const first = grapheme.codePointAt(0);
  if (first === undefined) return 0;
  if (first >= 0x1f1e6 && first <= 0x1f1ff) return 2;
  if (/\p{Emoji_Presentation}/u.test(grapheme) || grapheme.includes("\ufe0f")) return 2;
  const content = grapheme.replace(leadingZeroWidth, "");
  const base = content.codePointAt(0);
  if (base === undefined) return 0;
  let width = eastAsianWidth(base);
  for (const character of content.slice(String.fromCodePoint(base).length)) {
    const codePoint = character.codePointAt(0) ?? 0;
    if ((codePoint >= 0xff00 && codePoint <= 0xffef) || codePoint === 0x0e33 || codePoint === 0x0eb3) width += eastAsianWidth(codePoint);
  }
  return width;
}

export function cellWidth(value: string): number {
  const plain = stripAnsi(value);
  if (asciiOnly.test(plain)) {
    let width = 0;
    for (let index = 0; index < plain.length; index += 1) {
      const codePoint = plain.charCodeAt(index);
      if (codePoint === 0x09) width += 3;
      else if (codePoint >= 0x20 && codePoint !== 0x7f) width += 1;
    }
    return width;
  }
  return splitGraphemes(plain).reduce((width, item) => width + graphemeWidth(item), 0);
}

export function stripAnsi(value: string): string {
  return value.replace(ansiPattern, "");
}

export function sanitizeTerminalText(value: string): string {
  const stripped = stripAnsi(value).replace(/\r\n?/gu, "\n");
  let result = "";
  for (const character of stripped) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === "\n") result += character;
    else if (character === "\t") result += "    ";
    else if (codePoint >= 0x20 && codePoint !== 0x7f && !(codePoint >= 0x80 && codePoint < 0xa0)) result += character;
  }
  return result;
}

export function truncateCells(value: string, maximum: number, marker = "…"): string {
  if (maximum <= 0) return "";
  const safe = sanitizeTerminalText(value).replaceAll("\n", " ");
  if (cellWidth(safe) <= maximum) return safe;
  const markerWidth = Math.min(cellWidth(marker), maximum);
  const target = maximum - markerWidth;
  let width = 0;
  let result = "";
  for (const grapheme of splitGraphemes(safe)) {
    const next = graphemeWidth(grapheme);
    if (width + next > target) break;
    result += grapheme;
    width += next;
  }
  return `${result}${markerWidth > 0 ? marker : ""}`;
}

export function padCells(value: string, width: number): string {
  const selected = truncateCells(value, width);
  return `${selected}${" ".repeat(Math.max(0, width - cellWidth(selected)))}`;
}

export function wrapCells(value: string, width: number): string[] {
  if (width <= 0) return [""];
  const safe = sanitizeTerminalText(value);
  const lines: string[] = [];
  let line = "";
  let used = 0;
  const flush = () => {
    lines.push(line.trimEnd());
    line = "";
    used = 0;
  };

  const appendBroken = (token: string) => {
    for (const grapheme of splitGraphemes(token)) {
      const next = graphemeWidth(grapheme);
      if (used > 0 && used + next > width) flush();
      if (next > width) continue;
      line += grapheme;
      used += next;
    }
  };

  for (const token of safe.split(/(\n|[^\S\n]+|[^\s]+)/u).filter((part) => part !== "")) {
    if (token === "\n") {
      flush();
      continue;
    }
    const whitespace = /^\s+$/u.test(token);
    const tokenWidth = cellWidth(token);
    if (whitespace) {
      if (used === 0) appendBroken(token);
      else if (used + tokenWidth <= width) {
        line += token;
        used += tokenWidth;
      } else flush();
      continue;
    }
    if (tokenWidth <= width) {
      if (used > 0 && used + tokenWidth > width) flush();
      line += token;
      used += tokenWidth;
      continue;
    }
    if (used > 0) flush();
    appendBroken(token);
  }
  if (line !== "" || lines.length === 0 || safe.endsWith("\n")) lines.push(line);
  return lines;
}

export function byteTruncate(value: string, maximum: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximum) return value;
  let bytes = 0;
  let result = "";
  for (const grapheme of splitGraphemes(value)) {
    const size = Buffer.byteLength(grapheme, "utf8");
    if (bytes + size > maximum) break;
    result += grapheme;
    bytes += size;
  }
  return result;
}

export function byteTail(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maximum) return value;
  let bytes = 0;
  const selected: string[] = [];
  const graphemes = splitGraphemes(value);
  for (let index = graphemes.length - 1; index >= 0; index -= 1) {
    const grapheme = graphemes[index]!;
    const size = Buffer.byteLength(grapheme, "utf8");
    if (bytes + size > maximum) break;
    selected.push(grapheme);
    bytes += size;
  }
  return selected.reverse().join("");
}
