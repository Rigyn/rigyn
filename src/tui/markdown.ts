import { trustedHyperlinkTarget } from "./terminal-image.js";
import type { ThemeRole } from "./theme.js";
import { cellWidth, graphemeWidth, sanitizeTerminalText, splitGraphemes, truncateCells } from "./unicode.js";

export interface MarkdownSpan {
  text: string;
  role?: ThemeRole;
  hyperlink?: string;
}

export interface MarkdownRenderedLine {
  text: string;
  role: ThemeRole;
  spans: readonly MarkdownSpan[];
}

const MAX_MARKDOWN_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_MARKDOWN_SOURCE_LINES = 20_000;
const MAX_MARKDOWN_RENDERED_LINES = 20_000;
const MAX_MARKDOWN_SPANS_PER_LINE = 256;
const MAX_BLOCK_PREFIX_DEPTH = 32;
const MAX_LIST_INDENT = 128;
const MAX_TABLE_DELIMITERS = 64;
const TRUNCATED_SOURCE = "… earlier Markdown bytes omitted …\n";
const TRUNCATED_LINES = "… earlier Markdown lines omitted …";
const TRUNCATED_RENDER = "… earlier rendered Markdown omitted …";
const LIST_MARKER = new RegExp(
  `^( {0,${MAX_LIST_INDENT}})([-+*]|\\d{1,9}[.)])( +)(?:(\\[[ xX]\\])( +))?`,
  "u",
);

interface FenceState {
  marker: "`" | "~";
  length: number;
  quoteDepth: number;
  language: FenceLanguage | undefined;
  syntax: SyntaxState;
}

interface SyntaxState {
  blockCommentEnd: string | undefined;
  multilineQuote: string | undefined;
}

interface BlockState {
  fence: FenceState | undefined;
  listIndent: number | undefined;
  table: boolean;
}

interface BlockSpans {
  spans: MarkdownSpan[];
  role?: ThemeRole;
}

interface TablePart {
  text: string;
  delimiter: boolean;
}

type SyntaxLanguage =
  | "c"
  | "css"
  | "go"
  | "html"
  | "java"
  | "javascript"
  | "json"
  | "jsonc"
  | "python"
  | "ruby"
  | "rust"
  | "shell"
  | "sql"
  | "swift"
  | "yaml";

type FenceLanguage = SyntaxLanguage | "diff";

interface SyntaxDefinition {
  keywords: ReadonlySet<string>;
  constants: ReadonlySet<string>;
  lineComments: readonly string[];
  blockComment?: readonly [start: string, end: string];
  quotes: readonly string[];
  multilineQuotes?: readonly string[];
  caseInsensitive?: boolean;
  variables?: boolean;
}

function words(value: string): ReadonlySet<string> {
  return new Set(value.split(" "));
}

const C_KEYWORDS = words("alignas alignof auto break case catch char class const constexpr continue default delete do double else enum explicit export extern float for friend goto if import inline int interface long namespace new operator package private protected public register return short signed sizeof static struct switch template this throw try typedef typename union unsigned using virtual void volatile while");
const JS_KEYWORDS = words("as async await break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof interface let new of package private protected public return set static super switch throw try type typeof undefined var void while with yield");
const PYTHON_KEYWORDS = words("and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield");
const RUBY_KEYWORDS = words("alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield");
const RUST_KEYWORDS = words("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while");
const SHELL_KEYWORDS = words("case coproc do done elif else esac fi for function if in select then time until while");
const SQL_KEYWORDS = words("all alter and any as asc begin between by case check column commit constraint create cross database default delete desc distinct drop else end exists foreign from full grant group having in index inner insert intersect into is join key left like limit not null on or order outer primary references revoke right rollback row select set table then union unique update values view when where with");
const GO_KEYWORDS = words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var");
const SWIFT_KEYWORDS = words("associatedtype break case catch class continue convenience default defer deinit do dynamic else enum extension fallthrough fileprivate final for func get guard if import in indirect init inout internal is lazy let mutating nil nonisolated open operator override private protocol public repeat required rethrows return self set some static struct subscript super switch throw throws try typealias unowned var weak where while");

const COMMON_CONSTANTS = words("false null true");
const SYNTAX: Record<SyntaxLanguage, SyntaxDefinition> = {
  c: { keywords: C_KEYWORDS, constants: words("NULL false nullptr true"), lineComments: ["//"], blockComment: ["/*", "*/"], quotes: ["\"", "'"] },
  css: { keywords: words("important inherit initial revert unset"), constants: words("none transparent"), lineComments: [], blockComment: ["/*", "*/"], quotes: ["\"", "'"] },
  go: { keywords: GO_KEYWORDS, constants: words("false iota nil true"), lineComments: ["//"], blockComment: ["/*", "*/"], quotes: ["\"", "'", "`"], multilineQuotes: ["`"] },
  html: { keywords: words("DOCTYPE html"), constants: new Set(), lineComments: [], blockComment: ["<!--", "-->"], quotes: ["\"", "'"] },
  java: { keywords: C_KEYWORDS, constants: COMMON_CONSTANTS, lineComments: ["//"], blockComment: ["/*", "*/"], quotes: ["\"", "'"] },
  javascript: { keywords: JS_KEYWORDS, constants: COMMON_CONSTANTS, lineComments: ["//"], blockComment: ["/*", "*/"], quotes: ["\"", "'", "`"], multilineQuotes: ["`"] },
  json: { keywords: new Set(), constants: COMMON_CONSTANTS, lineComments: [], quotes: ["\""] },
  jsonc: { keywords: new Set(), constants: COMMON_CONSTANTS, lineComments: ["//"], blockComment: ["/*", "*/"], quotes: ["\""] },
  python: { keywords: PYTHON_KEYWORDS, constants: words("False None True"), lineComments: ["#"], quotes: ["\"", "'"], multilineQuotes: ["\"\"\"", "'''"] },
  ruby: { keywords: RUBY_KEYWORDS, constants: words("false nil true"), lineComments: ["#"], quotes: ["\"", "'"] },
  rust: { keywords: RUST_KEYWORDS, constants: words("false None Some true"), lineComments: ["//"], blockComment: ["/*", "*/"], quotes: ["\"", "'"] },
  shell: { keywords: SHELL_KEYWORDS, constants: words("false true"), lineComments: ["#"], quotes: ["\"", "'", "`"], variables: true },
  sql: { keywords: SQL_KEYWORDS, constants: COMMON_CONSTANTS, lineComments: ["--"], blockComment: ["/*", "*/"], quotes: ["\"", "'", "`"], caseInsensitive: true },
  swift: { keywords: SWIFT_KEYWORDS, constants: words("false nil true"), lineComments: ["//"], blockComment: ["/*", "*/"], quotes: ["\"", "'"] },
  yaml: { keywords: new Set(), constants: words("false null true yes no"), lineComments: ["#"], quotes: ["\"", "'"], caseInsensitive: true },
};

const LANGUAGE_ALIASES: Readonly<Record<string, SyntaxLanguage>> = {
  bash: "shell",
  c: "c",
  "c++": "c",
  cjs: "javascript",
  cpp: "c",
  cs: "c",
  csharp: "c",
  css: "css",
  go: "go",
  h: "c",
  hpp: "c",
  html: "html",
  java: "java",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  json5: "jsonc",
  jsonc: "jsonc",
  jsx: "javascript",
  kt: "java",
  kotlin: "java",
  mjs: "javascript",
  php: "c",
  py: "python",
  python: "python",
  rb: "ruby",
  ruby: "ruby",
  rs: "rust",
  rust: "rust",
  sh: "shell",
  shell: "shell",
  sql: "sql",
  swift: "swift",
  ts: "javascript",
  tsx: "javascript",
  typescript: "javascript",
  xml: "html",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shell",
};

function appendSpan(spans: MarkdownSpan[], text: string, role?: ThemeRole, hyperlink?: string): void {
  if (text === "") return;
  const previous = spans.at(-1);
  if (previous !== undefined && previous.role === role && previous.hyperlink === hyperlink) {
    previous.text += text;
    return;
  }
  if (spans.length >= MAX_MARKDOWN_SPANS_PER_LINE - 1) {
    const fallback = spans.at(-1);
    if (fallback !== undefined && fallback.role === undefined && fallback.hyperlink === undefined) fallback.text += text;
    else spans.push({ text });
    return;
  }
  spans.push({ text, ...(role === undefined ? {} : { role }), ...(hyperlink === undefined ? {} : { hyperlink }) });
}

function appendSpans(target: MarkdownSpan[], values: readonly MarkdownSpan[]): void {
  for (const value of values) appendSpan(target, value.text, value.role, value.hyperlink);
}

function sourceTail(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_MARKDOWN_SOURCE_BYTES) return value;
  const markerBytes = Buffer.byteLength(TRUNCATED_SOURCE, "utf8");
  const available = MAX_MARKDOWN_SOURCE_BYTES - markerBytes;
  const bytes = Buffer.from(value, "utf8");
  let offset = bytes.length - available;
  while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset += 1;
  return `${TRUNCATED_SOURCE}${bytes.subarray(offset).toString("utf8")}`;
}

function boundedSources(value: string): string[] {
  const safe = sourceTail(sanitizeTerminalText(value));
  let remaining = MAX_MARKDOWN_SOURCE_LINES;
  let start = safe.length;
  while (start > 0 && remaining > 0) {
    start = safe.lastIndexOf("\n", start - 1);
    remaining -= 1;
  }
  if (start < 0) return safe.split("\n");
  return [TRUNCATED_LINES, ...safe.slice(start + 1).split("\n")];
}

function inlineMarkdownSpans(source: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let index = 0;
  let pendingLabelEnd = -1;
  while (index < source.length) {
    if (spans.length >= MAX_MARKDOWN_SPANS_PER_LINE - 4) {
      appendSpan(spans, source.slice(index));
      break;
    }
    if (source[index] === "\\" && index + 1 < source.length) {
      appendSpan(spans, source.slice(index, index + 2));
      index += 2;
      continue;
    }
    if (source[index] === "`") {
      let markerEnd = index + 1;
      while (source[markerEnd] === "`") markerEnd += 1;
      const marker = source.slice(index, markerEnd);
      const close = source.indexOf(marker, markerEnd);
      if (close > markerEnd) {
        appendSpan(spans, marker, "muted");
        appendSpan(spans, source.slice(markerEnd, close), "accent");
        appendSpan(spans, marker, "muted");
        index = close + marker.length;
        continue;
      }
      appendSpan(spans, marker);
      index = markerEnd;
      continue;
    }
    const strong = source.startsWith("**", index) ? "**" : source.startsWith("__", index) ? "__" : undefined;
    if (strong !== undefined) {
      const close = source.indexOf(strong, index + 2);
      if (close > index + 2) {
        appendSpan(spans, strong, "muted");
        appendSpan(spans, source.slice(index + 2, close), "title");
        appendSpan(spans, strong, "muted");
        index = close + 2;
        continue;
      }
    }
    if (source.startsWith("~~", index)) {
      const close = source.indexOf("~~", index + 2);
      if (close > index + 2) {
        appendSpan(spans, "~~", "muted");
        appendSpan(spans, source.slice(index + 2, close), "muted");
        appendSpan(spans, "~~", "muted");
        index = close + 2;
        continue;
      }
    }
    const emphasis = source[index] === "*" || source[index] === "_" ? source[index] : undefined;
    if (emphasis !== undefined && source[index + 1] !== emphasis) {
      const close = source.indexOf(emphasis, index + 1);
      if (close > index + 1) {
        appendSpan(spans, emphasis, "muted");
        appendSpan(spans, source.slice(index + 1, close), "muted");
        appendSpan(spans, emphasis, "muted");
        index = close + 1;
        continue;
      }
    }
    if (source[index] === "[") {
      if (pendingLabelEnd <= index) pendingLabelEnd = source.indexOf("](", index + 1);
      if (pendingLabelEnd < 0) {
        appendSpan(spans, source.slice(index));
        break;
      }
      const nested = source.indexOf("[", index + 1);
      if (nested >= 0 && nested < pendingLabelEnd) {
        appendSpan(spans, source.slice(index, nested));
        index = nested;
        continue;
      }
      const targetEnd = source.indexOf(")", pendingLabelEnd + 2);
      if (targetEnd < 0) {
        appendSpan(spans, source.slice(index));
        break;
      }
      const target = source.slice(pendingLabelEnd + 2, targetEnd);
      if (pendingLabelEnd > index + 1 && targetEnd > pendingLabelEnd + 2 && !/\s/u.test(target)) {
        appendSpan(spans, "[", "muted");
        appendSpan(spans, source.slice(index + 1, pendingLabelEnd), "accent", trustedHyperlinkTarget(target));
        appendSpan(spans, "](", "muted");
        appendSpan(spans, target, "muted");
        appendSpan(spans, ")", "muted");
        index = targetEnd + 1;
        pendingLabelEnd = -1;
        continue;
      }
      appendSpan(spans, source.slice(index, targetEnd + 1));
      index = targetEnd + 1;
      pendingLabelEnd = -1;
      continue;
    }
    if (source[index] === "<") {
      const autolink = /^<(?:https?:\/\/|mailto:)[^<>\s]+>/iu.exec(source.slice(index, index + 4_098));
      if (autolink !== null) {
        const target = autolink[0].slice(1, -1);
        appendSpan(spans, "<", "muted");
        appendSpan(spans, target, "accent", trustedHyperlinkTarget(target));
        appendSpan(spans, ">", "muted");
        index += autolink[0].length;
        continue;
      }
    }
    appendSpan(spans, source[index] ?? "");
    index += 1;
  }
  return spans;
}

function quotePrefix(
  source: string,
  maximumDepth = MAX_BLOCK_PREFIX_DEPTH,
): { offset: number; spans: MarkdownSpan[]; depth: number } {
  const spans: MarkdownSpan[] = [];
  let offset = 0;
  let depth = 0;
  while (depth < maximumDepth) {
    let marker = offset;
    while (marker < source.length && marker - offset < 3 && source[marker] === " ") marker += 1;
    if (source[marker] !== ">") break;
    appendSpan(spans, source.slice(offset, marker), "muted");
    appendSpan(spans, ">", "accent");
    marker += 1;
    if (source[marker] === " ") {
      appendSpan(spans, " ", "muted");
      marker += 1;
    }
    offset = marker;
    depth += 1;
  }
  return { offset, spans, depth };
}

function tableParts(source: string): TablePart[] | undefined {
  const parts: TablePart[] = [];
  let start = 0;
  let index = 0;
  let codeMarker = 0;
  let delimiters = 0;
  while (index < source.length && delimiters < MAX_TABLE_DELIMITERS) {
    if (source[index] === "\\") {
      index += Math.min(2, source.length - index);
      continue;
    }
    if (source[index] === "`") {
      let end = index + 1;
      while (source[end] === "`") end += 1;
      const run = end - index;
      codeMarker = codeMarker === 0 ? run : codeMarker === run ? 0 : codeMarker;
      index = end;
      continue;
    }
    if (source[index] === "|" && codeMarker === 0) {
      parts.push({ text: source.slice(start, index), delimiter: false }, { text: "|", delimiter: true });
      start = index + 1;
      delimiters += 1;
    }
    index += 1;
  }
  if (delimiters === 0) return undefined;
  parts.push({ text: source.slice(start), delimiter: false });
  return parts;
}

function tableSeparator(parts: readonly TablePart[]): boolean {
  const cells = parts.filter((part) => !part.delimiter).map((part) => part.text.trim());
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function tableSpans(parts: readonly TablePart[], separator: boolean): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  for (const part of parts) {
    if (part.delimiter) appendSpan(spans, part.text, "accent");
    else if (separator) appendSpan(spans, part.text, "muted");
    else appendSpans(spans, inlineMarkdownSpans(part.text));
  }
  return spans;
}

function blockMarkdownSpans(source: string, state: BlockState): BlockSpans {
  const quote = quotePrefix(source);
  const content = source.slice(quote.offset);
  const spans = [...quote.spans];
  const list = LIST_MARKER.exec(content);
  if (list !== null) {
    appendSpan(spans, list[1] ?? "");
    appendSpan(spans, list[2] ?? "", "accent");
    appendSpan(spans, list[3] ?? "");
    if (list[4] !== undefined) {
      appendSpan(spans, list[4], /[xX]/u.test(list[4]) ? "success" : "muted");
      appendSpan(spans, list[5] ?? "");
    }
    appendSpans(spans, inlineMarkdownSpans(content.slice(list[0].length)));
    state.listIndent = quote.offset + list[0].length;
    state.table = false;
    return { spans, ...(quote.depth > 0 ? { role: "muted" as const } : {}) };
  }

  const heading = /^( {0,3})(#{1,6})(?: (.*)|\s*)$/u.exec(content);
  if (heading !== null) {
    appendSpan(spans, heading[1] ?? "");
    appendSpan(spans, heading[2] ?? "", "accent");
    if (heading[3] !== undefined) {
      appendSpan(spans, " ");
      appendSpans(spans, inlineMarkdownSpans(heading[3]));
    }
    state.listIndent = undefined;
    state.table = false;
    return { spans, role: "title" };
  }

  const parts = tableParts(content);
  if (parts !== undefined) {
    const separator = tableSeparator(parts);
    appendSpans(spans, tableSpans(parts, separator));
    const role: ThemeRole | undefined = separator ? "muted" : state.table ? undefined : "title";
    state.table = true;
    state.listIndent = undefined;
    return { spans, ...(role === undefined ? {} : { role }) };
  }

  if (content.trim() === "") {
    appendSpan(spans, content);
    state.table = false;
    return { spans, ...(quote.depth > 0 ? { role: "muted" as const } : {}) };
  }

  const indentation = /^ +/u.exec(content)?.[0].length ?? 0;
  if (state.listIndent !== undefined && indentation > 0) {
    appendSpan(spans, content.slice(0, indentation), "muted");
    appendSpans(spans, inlineMarkdownSpans(content.slice(indentation)));
  } else {
    state.listIndent = undefined;
    appendSpans(spans, inlineMarkdownSpans(content));
  }
  state.table = false;
  return { spans, ...(quote.depth > 0 ? { role: "muted" as const } : {}) };
}

function languageFromInfo(value: string): FenceLanguage | undefined {
  const first = value.trim().split(/\s+/u)[0]?.replace(/^\{?\.?/u, "").replace(/\}?$/u, "").toLowerCase();
  if (first === "diff" || first === "patch") return "diff";
  return first === undefined || first === "" ? undefined : LANGUAGE_ALIASES[first];
}

function fenceSpans(source: string, marker: string): MarkdownSpan[] {
  const index = source.indexOf(marker);
  const spans: MarkdownSpan[] = [];
  appendSpan(spans, source.slice(0, index));
  appendSpan(spans, marker, "muted");
  appendSpan(spans, source.slice(index + marker.length), "accent");
  return spans;
}

function openingFence(source: string): { marker: string; info: string } | undefined {
  // Fences may be indented by at most three cells. Four-space list continuations
  // stay literal instead of being guessed as a different container grammar.
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(source);
  if (match === null) return undefined;
  const marker = match[1] ?? "```";
  const info = match[2] ?? "";
  return marker[0] === "`" && info.includes("`") ? undefined : { marker, info };
}

function openingFenceContainer(source: string): {
  marker: string;
  info: string;
  prefix: MarkdownSpan[];
  content: string;
  quoteDepth: number;
} | undefined {
  const quote = quotePrefix(source);
  const content = source.slice(quote.offset);
  const opening = openingFence(content);
  return opening === undefined ? undefined : {
    ...opening,
    prefix: quote.spans,
    content,
    quoteDepth: quote.depth,
  };
}

function activeFenceContainer(
  source: string,
  fence: FenceState,
): { prefix: MarkdownSpan[]; content: string } | undefined {
  if (fence.quoteDepth === 0) return { prefix: [], content: source };
  const quote = quotePrefix(source, fence.quoteDepth);
  return quote.depth === fence.quoteDepth
    ? { prefix: quote.spans, content: source.slice(quote.offset) }
    : undefined;
}

function closesFence(source: string, fence: FenceState): string | undefined {
  const match = /^ {0,3}(`{3,}|~{3,}) *$/u.exec(source);
  const marker = match?.[1];
  return marker !== undefined && marker[0] === fence.marker && marker.length >= fence.length ? marker : undefined;
}

function matchedAt(source: string, index: number, values: readonly string[]): string | undefined {
  return values.find((value) => source.startsWith(value, index));
}

function quotedEnd(source: string, start: number, quote: string): number {
  let index = start + quote.length;
  while (index < source.length) {
    if (source[index] === "\\" && quote !== "'") {
      index += Math.min(2, source.length - index);
      continue;
    }
    if (source.startsWith(quote, index)) return index + quote.length;
    index += 1;
  }
  return source.length;
}

function identifierAt(source: string, index: number): string | undefined {
  return /^[$A-Z_a-z][$0-9A-Z_a-z]*/u.exec(source.slice(index, index + 512))?.[0];
}

function numberAt(source: string, index: number): string | undefined {
  return /^(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|0[bB][01](?:_?[01])*|\d(?:_?\d)*(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?)/u.exec(source.slice(index, index + 512))?.[0];
}

function highlightCode(source: string, language: SyntaxLanguage | undefined, state: SyntaxState): MarkdownSpan[] {
  if (language === undefined) return source === "" ? [] : [{ text: source, role: "muted" }];
  const definition = SYNTAX[language];
  const spans: MarkdownSpan[] = [];
  let index = 0;
  while (index < source.length) {
    if (spans.length >= MAX_MARKDOWN_SPANS_PER_LINE - 4) {
      appendSpan(spans, source.slice(index));
      break;
    }
    if (state.blockCommentEnd !== undefined) {
      const end = source.indexOf(state.blockCommentEnd, index);
      if (end < 0) {
        appendSpan(spans, source.slice(index), "muted");
        break;
      }
      appendSpan(spans, source.slice(index, end + state.blockCommentEnd.length), "muted");
      index = end + state.blockCommentEnd.length;
      state.blockCommentEnd = undefined;
      continue;
    }
    if (state.multilineQuote !== undefined) {
      const quote = state.multilineQuote;
      const end = quotedEnd(source, index - quote.length, quote);
      appendSpan(spans, source.slice(index, end), "success");
      if (end < source.length || source.endsWith(quote)) state.multilineQuote = undefined;
      index = end;
      continue;
    }
    const lineComment = matchedAt(source, index, definition.lineComments);
    if (lineComment !== undefined) {
      appendSpan(spans, source.slice(index), "muted");
      break;
    }
    if (definition.blockComment !== undefined && source.startsWith(definition.blockComment[0], index)) {
      const [start, endMarker] = definition.blockComment;
      const end = source.indexOf(endMarker, index + start.length);
      if (end < 0) {
        appendSpan(spans, source.slice(index), "muted");
        state.blockCommentEnd = endMarker;
        break;
      }
      appendSpan(spans, source.slice(index, end + endMarker.length), "muted");
      index = end + endMarker.length;
      continue;
    }
    const multilineQuote = matchedAt(source, index, definition.multilineQuotes ?? []);
    if (multilineQuote !== undefined) {
      const end = quotedEnd(source, index, multilineQuote);
      appendSpan(spans, source.slice(index, end), "success");
      if (!source.slice(index, end).endsWith(multilineQuote) || end === index + multilineQuote.length) {
        state.multilineQuote = multilineQuote;
      }
      index = end;
      continue;
    }
    const quote = matchedAt(source, index, definition.quotes);
    if (quote !== undefined) {
      const end = quotedEnd(source, index, quote);
      appendSpan(spans, source.slice(index, end), "success");
      index = end;
      continue;
    }
    if (definition.variables === true && source[index] === "$") {
      const variable = /^\$(?:\{[^}\n]{1,256}\}|[?#@*!$0-9_-]|[A-Z_a-z][0-9A-Z_a-z]*)/u.exec(source.slice(index, index + 512))?.[0];
      if (variable !== undefined) {
        appendSpan(spans, variable, "accent");
        index += variable.length;
        continue;
      }
    }
    const character = source[index] ?? "";
    const number = /[0-9]/u.test(character) ? numberAt(source, index) : undefined;
    if (number !== undefined) {
      appendSpan(spans, number, "warning");
      index += number.length;
      continue;
    }
    const identifier = /[$A-Z_a-z]/u.test(character) ? identifierAt(source, index) : undefined;
    if (identifier !== undefined) {
      const lookup = definition.caseInsensitive === true ? identifier.toLowerCase() : identifier;
      appendSpan(spans, identifier, definition.keywords.has(lookup)
        ? "accent"
        : definition.constants.has(lookup)
          ? "warning"
          : undefined);
      index += identifier.length;
      continue;
    }
    if (language === "html" && /[<>/=]/u.test(source[index] ?? "")) appendSpan(spans, source[index] ?? "", "accent");
    else appendSpan(spans, source[index] ?? "");
    index += 1;
  }
  return spans;
}

function codeLine(source: string, fence: FenceState): BlockSpans {
  if (/^ {0,3}(?:`{3,}|~{3,}) *$/u.test(source)) {
    return { spans: source === "" ? [] : [{ text: source, role: "muted" }], role: "muted" };
  }
  if (fence.language === "diff") {
    const role: ThemeRole = source.startsWith("+") && !source.startsWith("+++")
      ? "success"
      : source.startsWith("-") && !source.startsWith("---")
        ? "error"
        : /^(?:@@|Index:|diff |--- |\+\+\+ )/u.test(source)
          ? "accent"
          : "muted";
    return { spans: source === "" ? [] : [{ text: source, role }], role };
  }
  if (fence.language === undefined) return { spans: highlightCode(source, undefined, fence.syntax), role: "muted" };
  const spans = highlightCode(source, fence.language, fence.syntax);
  return { spans, role: "muted" };
}

function wrappedLines(prefix: string, spans: readonly MarkdownSpan[], width: number, role: ThemeRole): MarkdownRenderedLine[] {
  const available = Math.max(1, width - cellWidth(prefix));
  const lines: MarkdownRenderedLine[] = [];
  let current: MarkdownSpan[] = [];
  let used = 0;
  let hasContent = false;
  const reset = () => {
    current = [];
    appendSpan(current, prefix);
    used = 0;
    hasContent = false;
  };
  const flush = () => {
    lines.push({ text: current.map((span) => span.text).join(""), role, spans: current });
    if (lines.length > MAX_MARKDOWN_RENDERED_LINES * 2) {
      lines.splice(0, MAX_MARKDOWN_RENDERED_LINES);
      const marker = lines[0];
      if (marker !== undefined) {
        marker.text = TRUNCATED_RENDER;
        marker.role = "muted";
        marker.spans = [{ text: TRUNCATED_RENDER, role: "muted" }];
      }
    }
    reset();
  };
  reset();
  for (const span of spans) {
    for (const grapheme of splitGraphemes(span.text)) {
      const next = graphemeWidth(grapheme);
      if (used > 0 && used + next > available) flush();
      if (next > available) continue;
      appendSpan(current, grapheme, span.role, span.hyperlink);
      used += next;
      hasContent = true;
    }
  }
  if (hasContent || lines.length === 0) flush();
  return lines;
}

export function renderMarkdownMessageLines(
  prefix: string,
  value: string,
  width: number,
  fallbackRole: ThemeRole,
): MarkdownRenderedLine[] {
  const safeWidth = Math.max(1, Math.min(500, Number.isSafeInteger(width) ? width : 80));
  const safePrefix = truncateCells(sanitizeTerminalText(prefix).replaceAll("\n", " "), Math.max(0, safeWidth - 1), "");
  const indentation = " ".repeat(cellWidth(safePrefix));
  const state: BlockState = { fence: undefined, listIndent: undefined, table: false };
  const lines: MarkdownRenderedLine[] = [];
  let omitted = false;
  let first = true;
  for (const source of boundedSources(value)) {
    let parsed: BlockSpans;
    const active = state.fence === undefined ? undefined : activeFenceContainer(source, state.fence);
    if (state.fence !== undefined && active !== undefined) {
      const closing = closesFence(active.content, state.fence);
      if (closing === undefined) {
        const code = codeLine(active.content, state.fence);
        parsed = { ...code, spans: [...active.prefix, ...code.spans] };
      } else {
        parsed = { spans: [...active.prefix, ...fenceSpans(active.content, closing)], role: "accent" };
        state.fence = undefined;
      }
    } else {
      if (state.fence !== undefined) state.fence = undefined;
      const opening = openingFenceContainer(source);
      if (opening === undefined) parsed = blockMarkdownSpans(source, state);
      else {
        const marker = opening.marker;
        state.fence = {
          marker: marker[0] as "`" | "~",
          length: marker.length,
          quoteDepth: opening.quoteDepth,
          language: languageFromInfo(opening.info),
          syntax: { blockCommentEnd: undefined, multilineQuote: undefined },
        };
        state.listIndent = undefined;
        state.table = false;
        parsed = { spans: [...opening.prefix, ...fenceSpans(opening.content, marker)], role: "accent" };
      }
    }

    const selectedPrefix = first ? safePrefix : indentation;
    lines.push(...wrappedLines(selectedPrefix, parsed.spans, safeWidth, parsed.role ?? fallbackRole));
    first = false;
    if (lines.length > MAX_MARKDOWN_RENDERED_LINES * 2) {
      lines.splice(0, lines.length - MAX_MARKDOWN_RENDERED_LINES);
      omitted = true;
    }
  }
  if (lines.length > MAX_MARKDOWN_RENDERED_LINES) {
    lines.splice(0, lines.length - MAX_MARKDOWN_RENDERED_LINES);
    omitted = true;
  }
  if (omitted && lines.length > 0) {
    const marker = wrappedLines("", [{ text: TRUNCATED_RENDER, role: "muted" }], safeWidth, "muted")[0];
    if (marker !== undefined) lines[0] = marker;
  }
  return lines;
}
