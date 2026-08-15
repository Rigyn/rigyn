import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.js";
import type { Component } from "../tui.js";
import { applyBackgroundToLine, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.js";

export interface DefaultTextStyle {
  underline?: boolean;
  strikethrough?: boolean;
  italic?: boolean;
  bold?: boolean;
  bgColor?: (text: string) => string;
  color?: (text: string) => string;
}

type MarkdownStyle = (text: string) => string;

export interface MarkdownTheme {
  heading: MarkdownStyle;
  link: MarkdownStyle; linkUrl: MarkdownStyle;
  code: MarkdownStyle; codeBlock: MarkdownStyle; codeBlockBorder: MarkdownStyle;
  quote: MarkdownStyle; quoteBorder: MarkdownStyle;
  hr: MarkdownStyle; listBullet: MarkdownStyle;
  bold: MarkdownStyle; italic: MarkdownStyle;
  strikethrough: MarkdownStyle; underline: MarkdownStyle;
  highlightCode?: (code: string, language?: string) => string[];
  codeBlockIndent?: string;
}

export interface MarkdownOptions {
  preserveOrderedListMarkers?: boolean;
  preserveBackslashEscapes?: boolean;
  /** Transform source Markdown after the exact content width is known. */
  transform?: (markdown: string, availableWidth: number) => string;
}

interface Table {
  rows: string[][];
  alignment: Array<"left" | "center" | "right">;
}

function stylePrefix(style: (text: string) => string): string {
  const marker = "\u0000";
  const value = style(marker);
  const index = value.indexOf(marker);
  return index < 0 ? "" : value.slice(0, index);
}

function safeTarget(value: string): string | undefined {
  if (value.length === 0 || value.length > 4096 || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    return value;
  } catch { return undefined; }
}

function tableCells(line: string): string[] {
  const source = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  const cells: string[] = [];
  let current = "";
  let code = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\" && source[index + 1] === "|") { current += "|"; index += 1; continue; }
    if (character === "`") code = !code;
    if (character === "|" && !code) { cells.push(current.trim()); current = ""; }
    else current += character;
  }
  cells.push(current.trim());
  return cells;
}

function parseTable(lines: string[], start: number): Table | undefined {
  if (start + 1 >= lines.length || !lines[start]!.includes("|")) return undefined;
  const header = tableCells(lines[start]!);
  const separator = tableCells(lines[start + 1]!);
  if (header.length === 0 || separator.length !== header.length || !separator.every((cell) => /^:?-{3,}:?$/u.test(cell))) return undefined;
  const rows = [header];
  let index = start + 2;
  while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim() !== "") {
    const cells = tableCells(lines[index]!);
    while (cells.length < header.length) cells.push("");
    rows.push(cells.slice(0, header.length));
    index += 1;
  }
  return {
    rows,
    alignment: separator.map((cell) => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left"),
  };
}

function longestWord(value: string): number {
  return Math.max(1, ...value.split(/\s+/u).map((word) => visibleWidth(word)));
}

export class Markdown implements Component {
  #cache: { text: string; width: number; lines: string[] } | undefined;

  constructor(
    private text: string,
    private readonly paddingX: number,
    private readonly paddingY: number,
    private readonly theme: MarkdownTheme,
    private readonly defaultStyle?: DefaultTextStyle,
    private readonly options: MarkdownOptions = {},
  ) {}

  setText(value: string): void { this.text = value; this.invalidate(); }
  invalidate(): void { this.#cache = undefined; }

  render(width: number): string[] {
    if (this.#cache?.text === this.text && this.#cache.width === width) return this.#cache.lines;
    if (!this.text.trim()) return [];
    const maximum = Math.max(0, Math.floor(width));
    const horizontal = Math.max(0, Math.floor(this.paddingX));
    const vertical = Math.max(0, Math.floor(this.paddingY));
    const leftWidth = Math.min(horizontal, maximum);
    const rightWidth = Math.min(horizontal, maximum - leftWidth);
    const contentWidth = maximum - leftWidth - rightWidth;
    let selected = this.text;
    try {
      const transformed = this.options.transform?.(selected, contentWidth);
      if (typeof transformed === "string") selected = transformed;
    } catch {
      // A display-only transform cannot make the original Markdown unreadable.
    }
    const source = this.#stableSource(selected.replace(/\t/gu, "   "));
    const rendered = this.#blocks(source.split("\n"), Math.max(1, contentWidth));
    const left = " ".repeat(leftWidth);
    const right = " ".repeat(rightWidth);
    const bg = this.defaultStyle?.bgColor;
    const content = (contentWidth > 0 ? rendered.flatMap((line) => isImageLine(line) ? [line] : wrapTextWithAnsi(line, contentWidth)) : [""]).map((line) => {
      if (isImageLine(line)) return line;
      const selected = truncateToWidth(`${left}${line}${right}`, maximum, "", true);
      return bg ? applyBackgroundToLine(selected, maximum, bg) : selected;
    });
    const blank = bg ? applyBackgroundToLine(" ".repeat(maximum), maximum, bg) : " ".repeat(maximum);
    const padding = Array.from({ length: vertical }, () => blank);
    const result = [...padding, ...content, ...padding];
    this.#cache = { text: this.text, width, lines: result };
    return result;
  }

  #stableSource(value: string): string {
    const lines = value.replace(/\r\n|\r/gu, "\n").split("\n");
    let open: string | undefined;
    for (const line of lines) {
      const fence = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
      if (fence === undefined) continue;
      if (open === undefined) open = fence;
      else if (fence[0] === open[0] && fence.length >= open.length) open = undefined;
    }
    if (open !== undefined && lines.length > 0 && new RegExp(`^ {0,3}${open[0]}{1,${open.length - 1}}$`, "u").test(lines.at(-1)!)) lines.pop();
    return lines.join("\n");
  }

  #blocks(lines: string[], width: number): string[] {
    const output: string[] = [];
    const pushGap = () => { if (output.length > 0 && output.at(-1) !== "") output.push(""); };
    const ordered = new Map<number, number>();
    let listIndents: number[] = [];
    let activeList: { sourceIndent: number; hanging: string } | undefined;
    for (let index = 0; index < lines.length;) {
      const source = lines[index]!;
      if (source.trim() === "") { if (output.length > 0 && output.at(-1) !== "") output.push(""); index += 1; continue; }

      const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(source);
      if (fence !== null) {
        pushGap();
        const marker = fence[1]!;
        const language = fence[2]!.trim().split(/\s+/u)[0];
        const body: string[] = [];
        index += 1;
        while (index < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`, "u").test(lines[index]!)) body.push(lines[index++]!);
        if (index < lines.length) index += 1;
        const indent = this.theme.codeBlockIndent ?? "  ";
        const styled = this.theme.highlightCode?.(body.join("\n"), language || undefined) ?? body.map((line) => this.theme.codeBlock(line));
        output.push(this.theme.codeBlockBorder(`\`\`\`${language ?? ""}`));
        for (const line of styled) {
          const wrapped = wrapTextWithAnsi(line, Math.max(1, width - visibleWidth(indent)));
          if (wrapped.length === 0) output.push("");
          else output.push(...wrapped.map((part) => indent + part));
        }
        if (body.length === 0) output.push("");
        output.push(this.theme.codeBlockBorder("```"));
        if (index < lines.length && lines[index]!.trim()) output.push("");
        continue;
      }

      const table = parseTable(lines, index);
      if (table !== undefined) {
        activeList = undefined; listIndents = []; ordered.clear();
        pushGap();
        output.push(...this.#table(table, width));
        index += table.rows.length + 1;
        if (index < lines.length && lines[index]!.trim()) output.push("");
        continue;
      }

      const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(source);
      if (heading !== null) {
        activeList = undefined; listIndents = []; ordered.clear();
        pushGap();
        const headingStyle = heading[1]!.length === 1
          ? (value: string) => this.theme.underline(this.theme.heading(value))
          : this.theme.heading;
        output.push(this.#inline(heading[2]!, headingStyle, false));
        index += 1;
        if (index < lines.length && lines[index]!.trim()) output.push("");
        continue;
      }
      if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(source)) {
        activeList = undefined; listIndents = []; ordered.clear();
        pushGap();
        output.push(this.theme.hr("─".repeat(width)));
        index += 1;
        if (index < lines.length && lines[index]!.trim()) output.push("");
        continue;
      }
      if (/^\s*>/u.test(source)) {
        activeList = undefined; listIndents = []; ordered.clear();
        pushGap();
        while (index < lines.length && (/^\s*>/u.test(lines[index]!) || lines[index]!.trim() !== "" && index > 0 && /^\s*>/u.test(lines[index - 1]!))) {
          const content = lines[index]!.replace(/^\s*> ?/u, "");
          const prefix = this.theme.quoteBorder("│ ");
          for (const wrapped of wrapTextWithAnsi(this.#inline(content, this.theme.quote, false), Math.max(1, width - 2))) output.push(prefix + wrapped);
          index += 1;
        }
        if (index < lines.length && lines[index]!.trim()) output.push("");
        continue;
      }

      const list = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/u.exec(source);
      if (list !== null) {
        const rawIndent = list[1]!.length;
        let depth = listIndents.indexOf(rawIndent);
        if (depth < 0) {
          if (listIndents.length === 0) listIndents = [rawIndent];
          else if (rawIndent > listIndents.at(-1)!) listIndents.push(rawIndent);
          else {
            const parent = listIndents.findLastIndex((value) => value < rawIndent);
            listIndents = parent < 0 ? [rawIndent] : [...listIndents.slice(0, parent + 1), rawIndent];
          }
          depth = listIndents.length - 1;
        } else listIndents.length = depth + 1;
        let marker = list[2]!;
        if (/^\d/u.test(marker) && !this.options.preserveOrderedListMarkers) {
          const sourceNumber = Number(/^\d+/u.exec(marker)![0]);
          const next = ordered.has(depth) ? ordered.get(depth)! + 1 : sourceNumber;
          ordered.set(depth, next);
          marker = `${next}${marker.endsWith(")") ? ")" : "."}`;
        }
        for (const key of [...ordered.keys()]) if (key > depth) ordered.delete(key);
        const prefix = `${" ".repeat(depth * 4)}${this.theme.listBullet(marker)} `;
        const hanging = " ".repeat(visibleWidth(prefix));
        activeList = { sourceIndent: rawIndent, hanging };
        const quote = /^> ?(.*)$/u.exec(list[3]!);
        const listFence = /^(`{3,}|~{3,})(.*)$/u.exec(list[3]!);
        if (quote) {
          const border = this.theme.quoteBorder("│ ");
          const wrapped = wrapTextWithAnsi(this.#inline(quote[1]!, this.theme.quote, false), Math.max(1, width - visibleWidth(prefix) - 2));
          output.push(prefix + border + (wrapped[0] ?? ""), ...wrapped.slice(1).map((line) => hanging + border + line));
          index += 1;
          continue;
        }
        if (listFence) {
          const opening = `\`\`\`${listFence[2]!.trim()}`;
          output.push(prefix + this.theme.codeBlockBorder(opening));
          const fenceCharacter = listFence[1]![0]!; const fenceLength = listFence[1]!.length;
          index += 1;
          while (index < lines.length && !new RegExp(`^\\s*${fenceCharacter}{${fenceLength},}\\s*$`, "u").test(lines[index]!)) {
            const styled = this.theme.codeBlock(lines[index]!);
            const wrapped = wrapTextWithAnsi(styled, Math.max(1, width - visibleWidth(hanging)));
            output.push(...wrapped.map((line) => hanging + line));
            index += 1;
          }
          if (index < lines.length) index += 1;
          output.push(hanging + this.theme.codeBlockBorder("```"));
          continue;
        }
        const body = this.#inline(list[3]!);
        const wrapped = wrapTextWithAnsi(body, Math.max(1, width - visibleWidth(prefix)));
        output.push(prefix + (wrapped[0] ?? ""), ...wrapped.slice(1).map((line) => hanging + line));
        index += 1;
        continue;
      }

      const leading = /^\s*/u.exec(source)![0].length;
      if (activeList && leading > activeList.sourceIndent) {
        const wrapped = wrapTextWithAnsi(this.#inline(source.trim()), Math.max(1, width - visibleWidth(activeList.hanging)));
        output.push(...wrapped.map((line) => activeList!.hanging + line));
        index += 1;
        continue;
      }

      ordered.clear(); listIndents = []; activeList = undefined;
      const paragraph: string[] = [source.trimStart()];
      index += 1;
      while (index < lines.length && lines[index]!.trim() !== "" && !this.#startsBlock(lines, index)) paragraph.push(lines[index++]!.trimStart());
      output.push(this.#inline(paragraph.map((line, lineIndex) => {
        const hardBreak = / {2,}$/u.test(line);
        const content = line.trimEnd();
        if (lineIndex === paragraph.length - 1) return content;
        return content + (hardBreak ? "\n" : " ");
      }).join("")));
    }
    while (output.at(-1) === "") output.pop();
    return output;
  }

  #startsBlock(lines: string[], index: number): boolean {
    const line = lines[index] ?? "";
    return /^ {0,3}(?:#{1,6}\s|`{3,}|~{3,}|(?:-{3,}|\*{3,}|_{3,})\s*$)/u.test(line)
      || /^\s*(?:>|[-+*]\s|\d+[.)]\s)/u.test(line)
      || parseTable(lines, index) !== undefined;
  }

  #inline(source: string, context?: (value: string) => string, useDefault = true): string {
    const contextPrefix = context ? stylePrefix(context) : useDefault ? this.#defaultPrefix() : "";
    const base = (value: string) => context ? context(value) : useDefault ? this.#default(value) : value;
    const punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/u;
    const exactDelimiter = (value: string, offset: number, delimiter: string): boolean => {
      if (!value.startsWith(delimiter, offset)) return false;
      const character = delimiter[0]!;
      return value[offset - 1] !== character && value[offset + delimiter.length] !== character;
    };
    const closingDelimiter = (value: string, start: number, delimiter: string): number => {
      let offset = start;
      while (offset < value.length) {
        const candidate = value.indexOf(delimiter, offset);
        if (candidate < 0) return -1;
        const content = value.slice(start, candidate);
        if (exactDelimiter(value, candidate, delimiter)
          && content.length > 0
          && !/^\s|\s$/u.test(content)) return candidate;
        offset = candidate + delimiter.length;
      }
      return -1;
    };
    const render = (value: string, restorePrefix: string, depth: number): string => {
      if (depth > 32) return value;
      let output = "";
      for (let index = 0; index < value.length;) {
        const character = value[index]!;
        if (character === "\\" && punctuation.test(value[index + 1] ?? "")) {
          output += `${this.options.preserveBackslashEscapes ? "\\" : ""}${value[index + 1]!}`;
          index += 2;
          continue;
        }
        if (character === "`") {
          const end = value.indexOf("`", index + 1);
          if (end > index + 1 && !value.slice(index + 1, end).includes("\n")) {
            output += this.theme.code(value.slice(index + 1, end)) + restorePrefix;
            index = end + 1;
            continue;
          }
        }
        if (character === "[") {
          const labelEnd = value.indexOf("](", index + 1);
          const targetEnd = labelEnd < 0 ? -1 : value.indexOf(")", labelEnd + 2);
          if (labelEnd > index + 1 && targetEnd > labelEnd + 2) {
            const rawTarget = value.slice(labelEnd + 2, targetEnd);
            if (!/\s/u.test(rawTarget)) {
              const target = safeTarget(rawTarget);
              const linkPrefix = target === undefined ? restorePrefix : restorePrefix + stylePrefix(this.theme.link);
              const label = render(value.slice(index + 1, labelEnd), linkPrefix, depth + 1);
              if (target === undefined) output += label;
              else {
                const styled = this.theme.link(label);
                output += getCapabilities().hyperlinks
                  ? hyperlink(styled, target) + restorePrefix
                  : `${styled}${restorePrefix} ${this.theme.linkUrl(`(${target})`)}${restorePrefix}`;
              }
              index = targetEnd + 1;
              continue;
            }
          }
        }
        if (character === "<") {
          const end = value.indexOf(">", index + 1);
          if (end > index + 1) {
            const label = value.slice(index + 1, end);
            const rawTarget = /^https?:\/\//u.test(label)
              ? label
              : /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/u.test(label) ? `mailto:${label}` : undefined;
            const target = rawTarget === undefined ? undefined : safeTarget(rawTarget);
            if (target !== undefined) {
              const styled = this.theme.link(label);
              output += (getCapabilities().hyperlinks ? hyperlink(styled, target) : styled) + restorePrefix;
              index = end + 1;
              continue;
            }
          }
        }
        const delimiter = value.startsWith("~~", index) ? "~~"
          : value.startsWith("**", index) ? "**"
            : value.startsWith("__", index) ? "__"
              : character === "*" ? "*"
                : character === "_" ? "_" : undefined;
        if (delimiter !== undefined && exactDelimiter(value, index, delimiter)) {
          const end = closingDelimiter(value, index + delimiter.length, delimiter);
          if (end >= 0) {
            const style = delimiter === "~~" ? this.theme.strikethrough
              : delimiter.length === 2 ? this.theme.bold : this.theme.italic;
            const nestedPrefix = restorePrefix + stylePrefix(style);
            const nested = render(value.slice(index + delimiter.length, end), nestedPrefix, depth + 1);
            output += style(nested) + restorePrefix;
            index = end + delimiter.length;
            continue;
          }
        }
        const tail = value.slice(index);
        const url = /^(?:https?:\/\/)[^\s<>]+/u.exec(tail)?.[0];
        const mail = url === undefined ? /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u.exec(tail)?.[0] : undefined;
        const label = url ?? mail;
        if (label !== undefined && (index === 0 || /[\s(]/u.test(value[index - 1]!))) {
          const target = safeTarget(url ?? `mailto:${mail}`);
          if (target !== undefined) {
            const styled = this.theme.link(label);
            output += (getCapabilities().hyperlinks ? hyperlink(styled, target) : styled) + restorePrefix;
            index += label.length;
            continue;
          }
        }
        output += character;
        index += 1;
      }
      return output;
    };
    return base(render(source, contextPrefix, 0));
  }

  #defaultPrefix(): string {
    if (this.defaultStyle === undefined) return "";
    let prefix = "";
    if (this.defaultStyle.color) prefix += stylePrefix(this.defaultStyle.color);
    if (this.defaultStyle.bold) prefix += stylePrefix(this.theme.bold);
    if (this.defaultStyle.italic) prefix += stylePrefix(this.theme.italic);
    if (this.defaultStyle.strikethrough) prefix += stylePrefix(this.theme.strikethrough);
    if (this.defaultStyle.underline) prefix += stylePrefix(this.theme.underline);
    return prefix;
  }

  #default(value: string): string {
    let selected = value;
    if (this.defaultStyle?.color) selected = this.defaultStyle.color(selected);
    if (this.defaultStyle?.bold) selected = this.theme.bold(selected);
    if (this.defaultStyle?.italic) selected = this.theme.italic(selected);
    if (this.defaultStyle?.strikethrough) selected = this.theme.strikethrough(selected);
    if (this.defaultStyle?.underline) selected = this.theme.underline(selected);
    return selected;
  }

  #table(table: Table, width: number): string[] {
    const columns = table.rows[0]?.length ?? 0;
    if (columns === 0) return [];
    const borderWidth = columns + 1;
    const available = Math.max(columns, width - borderWidth - columns * 2);
    const natural = Array.from({ length: columns }, (_, column) => Math.max(...table.rows.map((row) => visibleWidth(row[column] ?? "")), 1));
    const minimum = Array.from({ length: columns }, (_, column) => Math.max(...table.rows.map((row) => longestWord(row[column] ?? "")), 1));
    const sizes = [...natural];
    while (sizes.reduce((sum, value) => sum + value, 0) > available) {
      let candidate = -1;
      for (let index = 0; index < sizes.length; index += 1) if (sizes[index]! > minimum[index]! && (candidate < 0 || sizes[index]! > sizes[candidate]!)) candidate = index;
      if (candidate < 0) break;
      sizes[candidate] = sizes[candidate]! - 1;
    }
    while (sizes.reduce((sum, value) => sum + value, 0) > available) {
      let candidate = 0;
      for (let index = 1; index < sizes.length; index += 1) if (sizes[index]! > sizes[candidate]!) candidate = index;
      if (sizes[candidate]! <= 1) break;
      sizes[candidate] = sizes[candidate]! - 1;
    }
    const line = (left: string, join: string, right: string) => left + sizes.map((size) => "─".repeat(size + 2)).join(join) + right;
    const result = [this.theme.codeBlockBorder(line("┌", "┬", "┐"))];
    for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
      const row = table.rows[rowIndex]!;
      const wrapped = row.map((cell, column) => wrapTextWithAnsi(this.#inline(cell), Math.max(1, sizes[column]!)));
      const height = Math.max(1, ...wrapped.map((cell) => cell.length));
      for (let visual = 0; visual < height; visual += 1) {
        const cells = wrapped.map((cell, column) => {
          const value = cell[visual] ?? "";
          const rest = Math.max(0, sizes[column]! - visibleWidth(value));
          const alignment = table.alignment[column];
          const left = alignment === "right" ? rest : alignment === "center" ? Math.floor(rest / 2) : 0;
          return ` ${" ".repeat(left)}${value}${" ".repeat(rest - left)} `;
        });
        result.push(this.theme.codeBlockBorder("│") + cells.join(this.theme.codeBlockBorder("│")) + this.theme.codeBlockBorder("│"));
      }
      if (rowIndex < table.rows.length - 1) result.push(this.theme.codeBlockBorder(line("├", "┼", "┤")));
    }
    result.push(this.theme.codeBlockBorder(line("└", "┴", "┘")));
    return result.map((entry) => visibleWidth(entry) > width ? truncateToWidth(entry, width, "") : entry);
  }
}
