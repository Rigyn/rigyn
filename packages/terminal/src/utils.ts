import { eastAsianWidth } from "get-east-asian-width";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });

export const cjkBreakRegex = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;
export const PUNCTUATION_REGEX = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;

export function getGraphemeSegmenter(): Intl.Segmenter {
  return graphemes;
}

export function getWordSegmenter(): Intl.Segmenter {
  return words;
}

export function isWhitespaceChar(value: string): boolean {
  return /\s/u.test(value);
}

export function isPunctuationChar(value: string): boolean {
  return PUNCTUATION_REGEX.test(value);
}

export function extractAnsiCode(value: string, offset: number): { code: string; length: number } | null {
  if (value.charCodeAt(offset) !== 0x1b) return null;
  const kind = value[offset + 1];
  if (kind === "[") {
    for (let i = offset + 2; i < value.length; i += 1) {
      const byte = value.charCodeAt(i);
      if (byte >= 0x40 && byte <= 0x7e) return { code: value.slice(offset, i + 1), length: i - offset + 1 };
    }
    return null;
  }
  if (kind === "]" || kind === "P" || kind === "_") {
    for (let i = offset + 2; i < value.length; i += 1) {
      if ((kind === "]" || kind === "_") && value.charCodeAt(i) === 7) return { code: value.slice(offset, i + 1), length: i - offset + 1 };
      if (value[i] === "\x1b" && value[i + 1] === "\\") return { code: value.slice(offset, i + 2), length: i - offset + 2 };
    }
    return null;
  }
  return offset + 1 < value.length ? { code: value.slice(offset, offset + 2), length: 2 } : null;
}

type Token = { value: string; width: number; escape: boolean };

function clusterWidth(cluster: string): number {
  if (cluster === "\t") return 3;
  if (/^[\p{Control}\p{Mark}\p{Default_Ignorable_Code_Point}]+$/u.test(cluster)) return 0;
  const first = cluster.codePointAt(0);
  if (first === undefined) return 0;
  if (first >= 0x1f1e6 && first <= 0x1f1ff) return 2;
  if (/\p{Extended_Pictographic}/u.test(cluster) || cluster.includes("\ufe0f") || cluster.includes("\u200d")) return 2;
  const base = cluster.replace(/^[\p{Control}\p{Mark}\p{Default_Ignorable_Code_Point}]+/u, "").codePointAt(0);
  if (base === undefined) return 0;
  let width = eastAsianWidth(base);
  for (const char of cluster.slice(String.fromCodePoint(base).length)) {
    const code = char.codePointAt(0) ?? 0;
    if ((code >= 0xff00 && code <= 0xffef) || code === 0x0e33 || code === 0x0eb3) width += eastAsianWidth(code);
  }
  return width;
}

function tokenize(value: string): Token[] {
  const result: Token[] = [];
  let offset = 0;
  while (offset < value.length) {
    const escape = extractAnsiCode(value, offset);
    if (escape) {
      result.push({ value: escape.code, width: 0, escape: true });
      offset += escape.length;
      continue;
    }
    let end = offset;
    while (end < value.length && value[end] !== "\x1b") end += 1;
    for (const item of graphemes.segment(value.slice(offset, end))) {
      result.push({ value: item.segment, width: clusterWidth(item.segment), escape: false });
    }
    offset = end;
  }
  return result;
}

const widthCache = new Map<string, number>();

export function visibleWidth(value: string): number {
  if (value.length === 0) return 0;
  if (/^[ -~]+$/u.test(value)) return value.length;
  const hit = widthCache.get(value);
  if (hit !== undefined) return hit;
  const width = tokenize(value).reduce((sum, token) => sum + token.width, 0);
  if (widthCache.size >= 512) widthCache.delete(widthCache.keys().next().value as string);
  widthCache.set(value, width);
  return width;
}

interface HyperlinkState {
  open: string;
  terminator: "\x07" | "\x1b\\";
}

interface StyleState {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  blink: boolean;
  inverse: boolean;
  hidden: boolean;
  strike: boolean;
  foreground: string | undefined;
  background: string | undefined;
  hyperlink: HyperlinkState | undefined;
}

function emptyStyle(): StyleState {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    blink: false,
    inverse: false,
    hidden: false,
    strike: false,
    foreground: undefined,
    background: undefined,
    hyperlink: undefined,
  };
}

function clearSgr(state: StyleState): void {
  state.bold = false;
  state.dim = false;
  state.italic = false;
  state.underline = false;
  state.blink = false;
  state.inverse = false;
  state.hidden = false;
  state.strike = false;
  state.foreground = undefined;
  state.background = undefined;
}

function updateStyle(state: StyleState, escape: string): void {
  if (escape.startsWith("\x1b]8;")) {
    const terminator = escape.endsWith("\x07") ? "\x07" : "\x1b\\";
    const body = escape.slice(4, terminator === "\x07" ? -1 : -2);
    const separator = body.indexOf(";");
    const url = separator < 0 ? "" : body.slice(separator + 1);
    state.hyperlink = url.length === 0 ? undefined : { open: escape, terminator };
    return;
  }
  const match = /^\x1b\[([\d;]*)m$/u.exec(escape);
  if (!match) return;
  const fields = match[1] === "" ? ["0"] : match[1]!.split(";");
  for (let index = 0; index < fields.length; index += 1) {
    const code = Number(fields[index]);
    if ((code === 38 || code === 48) && fields[index + 1] === "5" && fields[index + 2] !== undefined) {
      const color = `${fields[index]};5;${fields[index + 2]}`;
      if (code === 38) state.foreground = color;
      else state.background = color;
      index += 2;
      continue;
    }
    if ((code === 38 || code === 48) && fields[index + 1] === "2" && fields[index + 4] !== undefined) {
      const color = `${fields[index]};2;${fields[index + 2]};${fields[index + 3]};${fields[index + 4]}`;
      if (code === 38) state.foreground = color;
      else state.background = color;
      index += 4;
      continue;
    }
    if (code === 0) clearSgr(state);
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 5) state.blink = true;
    else if (code === 7) state.inverse = true;
    else if (code === 8) state.hidden = true;
    else if (code === 9) state.strike = true;
    else if (code === 21) state.bold = false;
    else if (code === 22) { state.bold = false; state.dim = false; }
    else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 25) state.blink = false;
    else if (code === 27) state.inverse = false;
    else if (code === 28) state.hidden = false;
    else if (code === 29) state.strike = false;
    else if (code === 39) state.foreground = undefined;
    else if (code === 49) state.background = undefined;
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) state.foreground = String(code);
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) state.background = String(code);
  }
}

function updateStyleFromText(state: StyleState, value: string): void {
  let offset = 0;
  while (offset < value.length) {
    const escape = extractAnsiCode(value, offset);
    if (escape) {
      updateStyle(state, escape.code);
      offset += escape.length;
    } else offset += 1;
  }
}

function stylePrefix(state: StyleState): string {
  const codes: string[] = [];
  if (state.bold) codes.push("1");
  if (state.dim) codes.push("2");
  if (state.italic) codes.push("3");
  if (state.underline) codes.push("4");
  if (state.blink) codes.push("5");
  if (state.inverse) codes.push("7");
  if (state.hidden) codes.push("8");
  if (state.strike) codes.push("9");
  if (state.foreground) codes.push(state.foreground);
  if (state.background) codes.push(state.background);
  return `${codes.length > 0 ? `\x1b[${codes.join(";")}m` : ""}${state.hyperlink?.open ?? ""}`;
}

function lineClose(state: StyleState): string {
  return `${state.underline ? "\x1b[24m" : ""}${state.hyperlink ? `\x1b]8;;${state.hyperlink.terminator}` : ""}`;
}

export function normalizeTerminalOutput(value: string): string {
  let result = "";
  let offset = 0;
  while (offset < value.length) {
    const escape = extractAnsiCode(value, offset);
    if (escape) {
      result += escape.code;
      offset += escape.length;
      continue;
    }
    const character = value[offset]!;
    result += character === "\t" ? "   " : character === "\u0e33" ? "\u0e4d\u0e32" : character === "\u0eb3" ? "\u0ecd\u0eb2" : character;
    offset += 1;
  }
  return result;
}

export function sliceWithWidth(
  value: string,
  startColumn: number,
  length: number,
  strict = false,
): { text: string; width: number } {
  const start = Math.max(0, startColumn);
  const end = start + Math.max(0, length);
  if (end <= start) return { text: "", width: 0 };
  let column = 0;
  let output = "";
  let outputWidth = 0;
  let pending = "";
  for (const token of tokenize(value)) {
    if (token.escape) {
      if (column >= start && column < end) output += token.value;
      else if (column < start) pending += token.value;
      continue;
    }
    const intersects = column < end && column + token.width > start;
    const fits = !strict || (column >= start && column + token.width <= end);
    if (intersects && fits) {
      if (pending) {
        output += pending;
        pending = "";
      }
      output += token.value;
      outputWidth += token.width;
    }
    column += token.width;
    if (column >= end) break;
  }
  return { text: output, width: outputWidth };
}

export function sliceByColumn(value: string, startColumn: number, length: number, strict = false): string {
  return sliceWithWidth(value, startColumn, length, strict).text;
}

export function truncateToWidth(value: string, maximum: number, ellipsis = "...", pad = false): string {
  const max = Math.max(0, Math.floor(maximum));
  if (max === 0) return "";
  const current = visibleWidth(value);
  if (current <= max) return pad ? value + " ".repeat(max - current) : value;
  const suffix = sliceByColumn(ellipsis, 0, max, true);
  if (ellipsis.length > 0 && suffix.length === 0) return pad ? " ".repeat(max) : "";
  const suffixWidth = visibleWidth(suffix);
  const prefix = sliceByColumn(value, 0, Math.max(0, max - suffixWidth), true);
  const result = `${prefix}\x1b[0m${suffix}${suffix ? "\x1b[0m" : ""}`;
  const resultWidth = visibleWidth(result);
  return pad ? result + " ".repeat(Math.max(0, max - resultWidth)) : result;
}

interface WrapToken {
  raw: string;
  width: number;
  whitespace: boolean;
}

function wrapTokens(value: string): WrapToken[] {
  const result: WrapToken[] = [];
  let pending = "";
  let current = "";
  let currentWidth = 0;
  let currentWhitespace: boolean | undefined;
  let offset = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    result.push({ raw: current, width: currentWidth, whitespace: currentWhitespace ?? false });
    current = "";
    currentWidth = 0;
    currentWhitespace = undefined;
  };

  while (offset < value.length) {
    const escape = extractAnsiCode(value, offset);
    if (escape) {
      pending += escape.code;
      offset += escape.length;
      continue;
    }
    let end = offset;
    while (end < value.length && value[end] !== "\x1b") end += 1;
    if (end === offset) {
      pending += value[offset]!;
      offset += 1;
      continue;
    }
    for (const part of graphemes.segment(value.slice(offset, end))) {
      const whitespace = isWhitespaceChar(part.segment);
      if (!whitespace && cjkBreakRegex.test(part.segment)) {
        flush();
        result.push({ raw: pending + part.segment, width: clusterWidth(part.segment), whitespace: false });
        pending = "";
        continue;
      }
      if (current.length > 0 && currentWhitespace !== whitespace) flush();
      current += pending + part.segment;
      pending = "";
      currentWidth += clusterWidth(part.segment);
      currentWhitespace = whitespace;
    }
    offset = end;
  }

  if (pending.length > 0) {
    if (current.length > 0) current += pending;
    else if (result.length > 0) result[result.length - 1]!.raw += pending;
    else current = pending;
  }
  flush();
  return result;
}

function trimVisibleTail(value: string): string {
  return value.replace(/[ \t]+$/u, "");
}

function wrapPhysicalLine(value: string, width: number): string[] {
  if (value.length === 0) return [""];
  const lines: string[] = [];
  const state = emptyStyle();
  let line = "";
  let lineWidth = 0;
  const finish = (): void => {
    lines.push(trimVisibleTail(line) + lineClose(state));
    line = stylePrefix(state);
    lineWidth = 0;
  };

  for (const token of wrapTokens(value)) {
    if (token.whitespace && token.width > width) {
      if (lineWidth > 0) finish();
      updateStyleFromText(state, token.raw);
      line = stylePrefix(state);
      continue;
    }

    if (token.width <= width) {
      if (lineWidth > 0 && lineWidth + token.width > width) {
        finish();
        if (token.whitespace) {
          updateStyleFromText(state, token.raw);
          line = stylePrefix(state);
          continue;
        }
      }
      line += token.raw;
      lineWidth += token.width;
      updateStyleFromText(state, token.raw);
      continue;
    }

    if (lineWidth > 0) finish();
    let pending = "";
    let offset = 0;
    while (offset < token.raw.length) {
      const escape = extractAnsiCode(token.raw, offset);
      if (escape) {
        pending += escape.code;
        offset += escape.length;
        continue;
      }
      let end = offset;
      while (end < token.raw.length && token.raw[end] !== "\x1b") end += 1;
      if (end === offset) {
        pending += token.raw[offset]!;
        offset += 1;
        continue;
      }
      for (const part of graphemes.segment(token.raw.slice(offset, end))) {
        const partWidth = clusterWidth(part.segment);
        if (lineWidth > 0 && lineWidth + partWidth > width) finish();
        line += pending;
        updateStyleFromText(state, pending);
        pending = "";
        line += part.segment;
        lineWidth += partWidth;
      }
      offset = end;
    }
    line += pending;
    updateStyleFromText(state, pending);
  }

  if (line.length > 0) lines.push(trimVisibleTail(line));
  return lines.length > 0 ? lines : [""];
}

export function wrapTextWithAnsi(value: string, width: number): string[] {
  if (value.length === 0) return [""];
  const maximum = Math.max(1, Math.floor(width));
  const output: string[] = [];
  const carry = emptyStyle();
  for (const physical of value.split(/\r\n|\r|\n/u)) {
    const prefix = output.length > 0 ? stylePrefix(carry) : "";
    output.push(...wrapPhysicalLine(prefix + physical, maximum));
    updateStyleFromText(carry, physical);
  }
  return output.length > 0 ? output : [""];
}

export function applyBackgroundToLine(value: string, width: number, background: (text: string) => string): string {
  const padded = value + " ".repeat(Math.max(0, width - visibleWidth(value)));
  return background(padded);
}

export function extractSegments(
  value: string,
  beforeEnd: number,
  afterStart: number,
  afterLength: number,
  strictAfter = false,
): { before: string; beforeWidth: number; after: string; afterWidth: number } {
  const beforeLimit = Math.max(0, beforeEnd);
  const afterBegin = Math.max(0, afterStart);
  const afterLimit = afterBegin + Math.max(0, afterLength);
  const state = emptyStyle();
  let column = 0;
  let before = "";
  let beforeWidth = 0;
  let beforeEscapes = "";
  let after = "";
  let afterWidth = 0;
  let afterStarted = false;

  for (const token of tokenize(value)) {
    if (token.escape) {
      updateStyle(state, token.value);
      if (column < beforeLimit) beforeEscapes += token.value;
      if (afterStarted && column >= afterBegin && column < afterLimit) after += token.value;
      continue;
    }

    if (column < beforeLimit && column + token.width <= beforeLimit) {
      before += beforeEscapes + token.value;
      beforeEscapes = "";
      beforeWidth += token.width;
    }

    const intersectsAfter = column < afterLimit && column + token.width > afterBegin;
    const fitsAfter = !strictAfter || column >= afterBegin && column + token.width <= afterLimit;
    if (intersectsAfter && fitsAfter) {
      if (!afterStarted) {
        after = stylePrefix(state);
        afterStarted = true;
      }
      after += token.value;
      afterWidth += token.width;
    }

    column += token.width;
    if (column >= Math.max(beforeLimit, afterLimit)) break;
  }

  return { before, beforeWidth, after, afterWidth };
}
