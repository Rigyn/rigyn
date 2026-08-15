import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { isImageLine, sliceByColumn, truncateToWidth, visibleWidth, type BackgroundCell } from "@rigyn/terminal";
import { formatUsageCost, normalizedContextTokens } from "../core/usage.js";
import { elapsedText, MAX_RETAINED_MUTATION_PREVIEW_ROWS } from "./model.js";
import type { Frame, PickerItem, TranscriptEntry, TuiRawBlock, TuiViewState, TuiWorkingIndicatorOptions } from "./types.js";
import {
  sanitizeRuntimeUiBlock,
  type RuntimeUiBlock,
  type RuntimeUiOverlayLength,
  type RuntimeUiOverlayOptions,
  type RuntimeUiSpan,
} from "./components.js";
import type { Theme, ThemeBg, ThemeRole } from "./theme.js";
import { style } from "./theme.js";
import { renderMarkdownMessageLines, renderSyntaxCodeLines, type MarkdownSpan } from "./markdown.js";
import {
  MAX_TERMINAL_IMAGE_AGGREGATE_BYTES,
  MAX_TERMINAL_IMAGE_COUNT,
  terminalImageFallback,
  trustedTerminalHyperlink,
  type TerminalImagePlacement,
  type TerminalImageResolution,
  type TranscriptImage,
} from "./terminal-image.js";
import { byteTail, byteTruncate, cellWidth, graphemeWidth, padCells, sanitizeTerminalText, splitGraphemes, truncateCells, wrapCells } from "./unicode.js";

interface RenderedLine {
  text: string;
  role: ThemeRole;
  /** Collapsed tool affordance that is rendered after every visible tool detail line. */
  toolExpandFooter?: boolean;
  background?: ThemeBg;
  italic?: boolean;
  raw?: boolean;
  fill?: boolean;
  spans?: readonly MarkdownSpan[];
  semanticZoneStart?: boolean;
  semanticZoneEnd?: boolean;
  messageStart?: boolean;
  /** Starts a user-owned transcript section even when that prompt has no text preview. */
  owningPromptBoundary?: boolean;
  /** Collapsed user prompt beginning the transcript section owned by this row. */
  owningPromptStart?: string;
  /** Stable transcript identity used only to preserve a paged viewport across re-layout. */
  transcriptAnchor?: TranscriptRowAnchor;
  image?: Omit<TerminalImagePlacement, "row" | "column">;
  imageOffset?: number;
  occupancy?: readonly boolean[];
  rightMarker?: { text: string; role: ThemeRole };
  /** Header repeated at the top of the live viewport when this line is clipped into view. */
  viewportHeader?: RenderedLine;
}

interface TranscriptRowAnchor {
  entryId: string;
  renderedRow: number;
  durable: boolean;
}

interface TranscriptFrameAnchorState {
  rows: readonly (TranscriptRowAnchor | undefined)[];
  viewport?: {
    anchor: TranscriptRowAnchor;
    row: number;
  };
}

const transcriptFrameAnchorStates = new WeakMap<Frame, TranscriptFrameAnchorState>();

/** @internal Direct-controller bridge; transcript anchors are intentionally not part of Frame. */
export function internalTranscriptFrameAnchorState(frame: Frame): TranscriptFrameAnchorState | undefined {
  return transcriptFrameAnchorStates.get(frame);
}

function rawLines(value: TuiRawBlock | undefined, width: number, maximumLines: number): RenderedLine[] {
  const source = (value?.lines ?? []).slice(0, Math.max(0, maximumLines));
  const rendered: RenderedLine[] = source.map((line) => ({
    text: truncateToWidth(line, width),
    role: "muted",
    raw: true,
  }));
  for (const [index, line] of source.entries()) {
    if (!isImageLine(line)) continue;
    const kittyRows = /(?:^|,)r=(\d+)(?:,|;)/u.exec(line)?.[1];
    const itermRows = /\u001b\[(\d+)A(?=\u001b\]1337;File=)/u.exec(line)?.[1];
    const rows = Math.max(
      1,
      Math.min(source.length, Number(kittyRows ?? itermRows ?? 0) + (itermRows === undefined ? 0 : 1)),
    );
    const start = itermRows === undefined ? index : Math.max(0, index - rows + 1);
    const occupancy = Array.from({ length: width }, () => true);
    for (let row = start; row < Math.min(rendered.length, start + rows); row += 1) {
      rendered[row] = { ...rendered[row]!, occupancy };
    }
  }
  return rendered;
}

function rawSlotLines(values: readonly TuiRawBlock[] | undefined, width: number, maximumLines: number): RenderedLine[] {
  return (values ?? []).slice(-16).flatMap((value) => rawLines(value, width, 4)).slice(-maximumLines);
}

const OSC133_ZONE_START = "\u001b]133;A\u0007";
const OSC133_ZONE_END = "\u001b]133;B\u0007";
const OSC133_ZONE_FINAL = "\u001b]133;C\u0007";
const MAX_FRAME_COLUMNS = 500;
const MAX_FRAME_ROWS = 200;

function frameDimension(value: number, maximum: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

export interface ToolRenderSlots {
  shell?: "default" | "self";
  call?: RuntimeUiBlock;
  result?: RuntimeUiBlock;
}

export interface TranscriptRenderOptions {
  toolRenderBlocks?: ReadonlyMap<string, ToolRenderSlots>;
  sessionRenderBlocks?: ReadonlyMap<string, RuntimeUiBlock>;
  semanticZones?: boolean;
  hyperlinks?: boolean;
  resolveImage?: (image: TranscriptImage, limits: { maxColumns: number; maxRows: number }) => TerminalImageResolution;
  maxImageRows?: number;
  hiddenReasoningLabel?: string;
  hideReasoningBlock?: boolean;
  outputPad?: 0 | 1;
  codeBlockIndent?: string;
  expandKeyHint?: string | undefined;
  thinkingKeyHint?: string;
  imageWidthCells?: number;
  activityFrame?: number;
  workingIndicator?: TuiWorkingIndicatorOptions;
  transformMarkdown?: (
    markdown: string,
    context: Readonly<{
      messageType: "user" | "assistant" | "assistant-thinking";
      isStreaming: boolean;
      availableWidth: number;
    }>,
  ) => string;
}

interface EditorBlock {
  lines: RenderedLine[];
  cursor: { row: number; column: number };
}

function entryRole(entry: TranscriptEntry): ThemeRole {
  if (entry.kind === "startup") return "muted";
  if (entry.kind === "user") return "userMessage";
  if (entry.kind === "assistant" || entry.kind === "reasoning") return "assistant";
  if (entry.kind === "warning" || entry.status === "in_doubt") return "warning";
  if (entry.kind === "error" || entry.status === "failed") return "error";
  if (entry.status === "completed") return "success";
  return "muted";
}

function entryPrefix(entry: TranscriptEntry, theme: Theme, hiddenReasoningLabel?: string): string {
  if (entry.kind === "startup" || entry.kind === "user" || entry.kind === "assistant") return "";
  if (entry.kind === "reasoning") {
    if (hiddenReasoningLabel === undefined) return "";
    const label = truncateCells(
      byteTruncate(sanitizeTerminalText(hiddenReasoningLabel).replaceAll("\n", " ").trim() || "Thinking...", 64),
      32,
    );
    return `${theme.glyphs.assistant} ${label} `;
  }
  if (entry.kind === "warning") return "! warning ";
  if (entry.kind === "error") return `${theme.glyphs.failure} error `;
  if (entry.kind === "status") return `${theme.glyphs.pending} `;
  const status = entry.status === "completed"
    ? theme.glyphs.success
    : entry.status === "failed"
      ? theme.glyphs.failure
      : entry.status === "in_doubt"
        ? "!"
      : entry.status === "running"
        ? theme.glyphs.pending
        : theme.glyphs.tool;
  return `${status} ${entry.title ?? "tool"}`;
}

function visibleReasoningText(value: string): string {
  return value.replace(/<!--[\s\S]*?-->/gu, " ");
}

const defaultWorkingSpinnerFrames = ["|", "/", "-", "\\"] as const;

function workingSpinner(
  workingIndicator: TuiWorkingIndicatorOptions | undefined,
  activityFrame = 0,
): string | undefined {
  if (workingIndicator?.hidden === true) return undefined;
  const configuredFrames = Array.isArray(workingIndicator?.frames)
    ? workingIndicator.frames.filter((frame): frame is string => typeof frame === "string").slice(0, 32)
    : [];
  const frames = configuredFrames.length > 0 ? configuredFrames : defaultWorkingSpinnerFrames;
  const renderedFrames = frames.map((frame) => truncateCells(byteTruncate(
    sanitizeTerminalText(frame).replaceAll("\n", " "),
    64,
  ), 16));
  const frameWidth = Math.max(0, ...renderedFrames.map((frame) => cellWidth(frame)));
  const frameIndex = Math.abs(Number.isSafeInteger(activityFrame) ? activityFrame : 0) % frames.length;
  return padCells(renderedFrames[frameIndex]!, frameWidth);
}

const owningPromptPreviews = new WeakMap<TranscriptEntry, {
  transformed: string;
  preview?: string;
}>();

function promptMarkdownDelimiterEscaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function promptMarkdownLinkBounds(
  source: string,
  index: number,
): { labelEnd: number; targetEnd: number } | undefined {
  if (source[index] !== "[" || promptMarkdownDelimiterEscaped(source, index)) return undefined;
  let brackets = 1;
  let labelEnd = index + 1;
  while (labelEnd < source.length && brackets > 0) {
    if (source[labelEnd] === "\\") {
      labelEnd += Math.min(2, source.length - labelEnd);
      continue;
    }
    if (source[labelEnd] === "[") brackets += 1;
    else if (source[labelEnd] === "]") brackets -= 1;
    labelEnd += 1;
  }
  labelEnd -= 1;
  if (brackets !== 0 || source[labelEnd + 1] !== "(") return undefined;
  let targetEnd = labelEnd + 2;
  let parentheses = 0;
  while (targetEnd < source.length) {
    if (source[targetEnd] === "\\") {
      targetEnd += Math.min(2, source.length - targetEnd);
      continue;
    }
    if (source[targetEnd] === "(") parentheses += 1;
    else if (source[targetEnd] === ")") {
      if (parentheses === 0) return { labelEnd, targetEnd };
      parentheses -= 1;
    }
    targetEnd += 1;
  }
  return { labelEnd, targetEnd: source.length };
}

function promptPreviewMarkdown(source: string, depth = 0): string {
  if (depth >= 32) return "";
  let visible = "";
  let index = 0;
  while (index < source.length) {
    const link = promptMarkdownLinkBounds(source, index);
    if (link === undefined) {
      visible += source[index] ?? "";
      index += 1;
      continue;
    }
    if (index > 0 && source[index - 1] === "!" && !promptMarkdownDelimiterEscaped(source, index - 1)) {
      visible = visible.slice(0, -1);
    }
    visible += promptPreviewMarkdown(source.slice(index + 1, link.labelEnd), depth + 1);
    index = Math.min(source.length, link.targetEnd + 1);
  }
  return visible;
}

function owningPromptPreview(entry: TranscriptEntry, transformed: string): string | undefined {
  const transformedPrefix = transformed.length > 4_097 ? transformed.slice(0, 4_097) : transformed;
  const bounded = byteTruncate(sanitizeTerminalText(byteTruncate(transformedPrefix, 4_096)), 4_096);
  const cached = owningPromptPreviews.get(entry);
  if (cached?.transformed === bounded) return cached.preview;
  const previewMarkdown = promptPreviewMarkdown(bounded).replace(/\s+/gu, " ").trim();
  const visible = renderMarkdownMessageLines("", previewMarkdown, 500, "userMessage")
    .map((line) => line.text)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  const preview = visible === "" ? undefined : byteTruncate(visible, 4_096);
  owningPromptPreviews.set(entry, {
    transformed: bounded,
    ...(preview === undefined ? {} : { preview }),
  });
  return preview;
}

function reasoningRunDuration(run: readonly TranscriptEntry[]): number | undefined {
  const starts = run.flatMap((entry) => entry.reasoningStartedAt === undefined || !Number.isFinite(entry.reasoningStartedAt)
    ? []
    : [entry.reasoningStartedAt]);
  const ends = run.flatMap((entry) => entry.reasoningStartedAt === undefined
    || entry.reasoningDurationMs === undefined
    || !Number.isFinite(entry.reasoningStartedAt)
    || !Number.isFinite(entry.reasoningDurationMs)
    || entry.reasoningDurationMs < 0
    ? []
    : [entry.reasoningStartedAt + entry.reasoningDurationMs]);
  if (starts.length > 0 && ends.length > 0) return Math.max(0, Math.max(...ends) - Math.min(...starts));
  const durations = run.flatMap((entry) => entry.reasoningDurationMs === undefined
    || !Number.isFinite(entry.reasoningDurationMs)
    || entry.reasoningDurationMs < 0
    ? []
    : [entry.reasoningDurationMs]);
  return durations.length === 0 ? undefined : Math.max(0, ...durations);
}

function reasoningBlockHeader(
  run: readonly TranscriptEntry[],
  width: number,
  theme: Theme,
  expanded: boolean,
  thinkingKeyHint: string | undefined,
  workingIndicator: TuiWorkingIndicatorOptions | undefined,
  activityFrame = 0,
): RenderedLine {
  const horizontal = theme.unicode ? "─" : "-";
  const left = theme.unicode ? "┌" : "+";
  const right = theme.unicode ? "┐" : "+";
  const streaming = run.some((entry) => entry.streaming === true);
  const spinner = streaming ? workingSpinner(workingIndicator, activityFrame) : theme.glyphs.assistant;
  const duration = reasoningRunDuration(run);
  const state = expanded ? streaming ? undefined : "complete" : "collapsed";
  const action = thinkingKeyHint === undefined
    ? undefined
    : `${thinkingKeyHint} ${expanded ? "collapse" : "expand"}`;
  const details = [
    streaming ? undefined : duration === undefined ? undefined : elapsedText(duration),
    state,
    action,
  ].filter((value): value is string => value !== undefined);
  const label = [
    streaming ? `${spinner === undefined ? "" : `${spinner} `}Thinking${theme.unicode ? "…" : "..."}` : "Thought",
    ...details,
  ].join(" · ");
  const innerWidth = Math.max(0, width - 2);
  const labelText = truncateCells(` ${label} `, innerWidth);
  const fill = horizontal.repeat(Math.max(0, innerWidth - cellWidth(labelText)));
  return {
    text: "",
    role: "border",
    spans: [
      { text: left, role: "border" },
      { text: labelText, role: streaming ? "working" : "info" },
      { text: fill, role: "border" },
      ...(width > 1 ? [{ text: right, role: "border" as const }] : []),
    ],
  };
}

function reasoningBlockBody(
  lines: readonly RenderedLine[],
  width: number,
  theme: Theme,
): RenderedLine[] {
  const left = theme.unicode ? "│" : "|";
  const right = theme.unicode ? "│" : "|";
  const innerWidth = Math.max(0, width - 2);
  const padded = innerWidth >= 3;
  const contentWidth = Math.max(0, innerWidth - (padded ? 2 : 0));
  return lines.map((line): RenderedLine => {
    const content = contentWidth === 0
      ? []
      : line.spans ?? [{ text: truncateCells(line.text, contentWidth), role: line.role }];
    const visible = content.map((span) => span.text).join("");
    return {
      text: "",
      role: "info",
      italic: true,
      spans: [
        { text: left, role: "border" },
        ...(padded ? [{ text: " ", role: "info" as const }] : []),
        ...content,
        { text: " ".repeat(Math.max(0, contentWidth - cellWidth(visible))), role: "info" },
        ...(padded ? [{ text: " ", role: "info" as const }] : []),
        ...(width > 1 ? [{ text: right, role: "border" as const }] : []),
      ],
    };
  });
}

function reasoningBlockBottom(width: number, theme: Theme): RenderedLine {
  const left = theme.unicode ? "└" : "+";
  const horizontal = theme.unicode ? "─" : "-";
  const right = theme.unicode ? "┘" : "+";
  return { text: `${left}${horizontal.repeat(Math.max(0, width - 2))}${width > 1 ? right : ""}`, role: "border" };
}

function toolMetadata(entry: TranscriptEntry): Record<string, unknown> | undefined {
  const metadata = entry.toolData?.result?.metadata;
  return metadata === null || typeof metadata !== "object" || Array.isArray(metadata) ? undefined : metadata;
}

function quantity(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function toolInput(entry: TranscriptEntry): Record<string, unknown> | undefined {
  const input = entry.toolData?.input;
  return input === null || typeof input !== "object" || Array.isArray(input)
    ? undefined
    : input as Record<string, unknown>;
}

function toolInputString(input: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string") return sanitizeTerminalText(value).replaceAll("\n", " ");
  }
  return undefined;
}

function toolInputText(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" ? value : undefined;
}

function toolInputNumber(input: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = input?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toolName(entry: TranscriptEntry): string {
  return sanitizeTerminalText(entry.title ?? "tool").replaceAll("\n", " ").trim() || "tool";
}

const INSPECTION_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
const MUTATION_TOOL_NAMES = new Set(["edit", "write", "apply_patch"]);

function toolHeaderRole(name: string): ThemeRole {
  if (INSPECTION_TOOL_NAMES.has(name)) return "info";
  if (MUTATION_TOOL_NAMES.has(name)) return "accent";
  return "title";
}

function toolStateSpans(entry: TranscriptEntry): RuntimeUiSpan[] {
  const metadata = toolMetadata(entry);
  const durationMs = entry.status === "running"
    ? entry.toolData?.progress?.elapsedMs
    : metadata?.durationMs;
  const duration = typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
    ? ` ${shellDurationText(durationMs)}`
    : "";
  const durationDetail = duration === "" ? "" : ` ·${duration}`;
  let label: string;
  let role: ThemeRole;
  if (entry.status === "completed") {
    label = `done${duration}`;
    role = "success";
  } else if (entry.status === "failed") {
    if (metadata?.timedOut === true) label = `timed out${duration}`;
    else if (metadata?.cancelled === true) label = `aborted${duration}`;
    else if (typeof metadata?.signal === "string" && metadata.signal !== "") {
      label = `failed · signal ${sanitizeTerminalText(metadata.signal).replaceAll("\n", " ")}${durationDetail}`;
    } else if (typeof metadata?.exitCode === "number" && Number.isSafeInteger(metadata.exitCode)) {
      label = `failed · exit ${metadata.exitCode}${durationDetail}`;
    } else label = `failed${duration}`;
    role = "error";
  } else if (entry.status === "in_doubt") {
    label = "outcome unknown";
    role = "warning";
  } else if (entry.status === "running") {
    label = `running${duration}`;
    role = "toolRunning";
  } else {
    label = "queued";
    role = "toolPending";
  }
  return [
    { text: " · ", role: "muted" },
    { text: label, role },
  ];
}

function conciseToolStateSpans(entry: TranscriptEntry): RuntimeUiSpan[] {
  const metadata = toolMetadata(entry);
  if (entry.status === "completed") return [{ text: " · ", role: "muted" }, { text: "done", role: "success" }];
  if (entry.status === "failed") {
    const label = metadata?.timedOut === true
      ? "timeout"
      : metadata?.cancelled === true ? "aborted" : "failed";
    return [{ text: " · ", role: "muted" }, { text: label, role: "error" }];
  }
  if (entry.status === "in_doubt") return [{ text: " · ", role: "muted" }, { text: "unknown", role: "warning" }];
  if (entry.status === "running") return [{ text: " · ", role: "muted" }, { text: "running", role: "toolRunning" }];
  return [{ text: " · ", role: "muted" }, { text: "queued", role: "toolPending" }];
}

function appendToolState(
  spans: RuntimeUiSpan[],
  entry: TranscriptEntry,
  width: number,
  state: readonly RuntimeUiSpan[] = toolStateSpans(entry),
): void {
  const stateWidth = cellWidth(state.map((span) => span.text).join(""));
  const currentLine = wrappedSpans(spans, width).at(-1) ?? [];
  const currentWidth = cellWidth(currentLine.map((span) => span.text).join(""));
  if (currentWidth > 0 && stateWidth <= width && currentWidth + stateWidth > width) {
    spans.push({ text: "\n", role: "muted" }, ...state.slice(1));
    return;
  }
  spans.push(...state);
}

function toolSummary(entry: TranscriptEntry): string | undefined {
  const value = sanitizeTerminalText(entry.summary ?? "").replaceAll("\n", " ").trim();
  return value === "" ? undefined : value;
}

const COMPACT_RESOURCE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

function compactReadHeader(
  entry: TranscriptEntry,
  path: string,
): RuntimeUiSpan[] | undefined {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  const fileName = segments.at(-1) ?? "";
  const range = (() => {
    const input = toolInput(entry);
    const offset = toolInputNumber(input, "offset");
    const limit = toolInputNumber(input, "limit");
    if (offset === undefined && limit === undefined) return "";
    const start = offset ?? 1;
    return `:${start}${limit === undefined ? "" : `-${start + limit - 1}`}`;
  })();
  if (fileName === "SKILL.md") {
    return [
      { text: "[skill] ", role: "accent" },
      { text: segments.at(-2) ?? fileName, role: "muted" },
      ...(range === "" ? [] : [{ text: range, role: "warning" as const }]),
    ];
  }
  if (COMPACT_RESOURCE_NAMES.has(fileName)) {
    return [
      { text: "read resource", role: toolHeaderRole("read") },
      { text: ` ${path}`, role: "muted" },
      ...(range === "" ? [] : [{ text: range, role: "warning" as const }]),
    ];
  }
  const packageMarkers = ["/node_modules/rigyn/", "/packages/rigyn/"];
  const marker = packageMarkers
    .map((candidate) => ({ candidate, index: normalized.lastIndexOf(candidate) }))
    .sort((left, right) => right.index - left.index)[0];
  if (marker === undefined || marker.index < 0) return undefined;
  const label = normalized.slice(marker.index + marker.candidate.length);
  if (label !== "README.md" && !label.startsWith("docs/") && !label.startsWith("examples/")) return undefined;
  return [
    { text: "read docs", role: toolHeaderRole("read") },
    { text: ` ${label}`, role: "muted" },
    ...(range === "" ? [] : [{ text: range, role: "warning" as const }]),
  ];
}

function boundedSpans(spans: readonly RuntimeUiSpan[], width: number): RuntimeUiSpan[] {
  const selected: RuntimeUiSpan[] = [];
  let remaining = Math.max(0, width);
  for (const span of spans) {
    if (remaining === 0) break;
    const text = truncateCells(span.text, remaining);
    if (text === "") continue;
    selected.push({ ...span, text });
    remaining -= cellWidth(text);
  }
  return selected;
}

function wrappedSpans(spans: readonly RuntimeUiSpan[], width: number): RuntimeUiSpan[][] {
  const maximum = Math.max(1, width);
  const lines: RuntimeUiSpan[][] = [[]];
  let lineWidth = 0;
  for (const span of spans) {
    let text = "";
    const flush = () => {
      if (text === "") return;
      lines.at(-1)!.push({ ...span, text });
      text = "";
    };
    for (const grapheme of splitGraphemes(span.text)) {
      if (grapheme === "\n") {
        flush();
        lines.push([]);
        lineWidth = 0;
        continue;
      }
      const next = graphemeWidth(grapheme);
      if (lineWidth > 0 && lineWidth + next > maximum) {
        flush();
        lines.push([]);
        lineWidth = 0;
      }
      if (next > maximum) continue;
      text += grapheme;
      lineWidth += next;
    }
    flush();
  }
  return lines;
}

function toolHeaderLine(entry: TranscriptEntry, width: number): RenderedLine {
  const input = toolInput(entry);
  const name = toolName(entry);
  const path = toolInputString(input, "file_path", "path", "file", "directory");
  const summary = toolSummary(entry);
  const spans: RuntimeUiSpan[] = [{ text: name, role: toolHeaderRole(name) }];
  const append = (text: string | undefined, role: ThemeRole = "muted") => {
    if (text !== undefined && text !== "") spans.push({ text, role });
  };

  if (name === "read") {
    const compact = path === undefined ? undefined : compactReadHeader(entry, path);
    if (compact !== undefined) {
      appendToolState(compact, entry, width);
      return { text: "", role: "muted", spans: compact };
    }
    append(` ${path ?? summary ?? "..."}`);
    const offset = toolInputNumber(input, "offset");
    const limit = toolInputNumber(input, "limit");
    if (offset !== undefined || limit !== undefined) {
      const start = offset ?? 1;
      append(`:${start}${limit === undefined ? "" : `-${start + limit - 1}`}`, "warning");
    }
  } else if (name === "grep") {
    const pattern = toolInputString(input, "pattern", "query") ?? summary ?? "";
    append(` /${pattern}/`, "accent");
    append(` in ${path ?? "."}`);
    const glob = toolInputString(input, "glob");
    if (glob !== undefined) append(` (${glob})`);
    const limit = toolInputNumber(input, "limit");
    if (limit !== undefined) append(` limit ${limit}`);
  } else if (name === "find") {
    append(` ${toolInputString(input, "pattern") ?? summary ?? "..."}`, "accent");
    append(` in ${path ?? "."}`);
    const limit = toolInputNumber(input, "limit");
    if (limit !== undefined) append(` (limit ${limit})`);
  } else if (name === "ls") {
    append(` ${path ?? summary ?? "."}`);
    const limit = toolInputNumber(input, "limit");
    if (limit !== undefined) append(` (limit ${limit})`);
  } else if (name === "edit" || name === "write") {
    append(` ${summary ?? path ?? "..."}`);
  } else if (name === "apply_patch") {
    append(` ${path ?? summary ?? "..."}`);
  } else append(summary === undefined ? undefined : ` ${summary}`);
  appendToolState(spans, entry, width);
  return {
    text: "",
    role: "muted",
    spans,
  };
}

function shellCommand(entry: TranscriptEntry): string {
  const input = entry.toolData?.input;
  if (input !== null && typeof input === "object" && !Array.isArray(input) && typeof input.command === "string") {
    const bounded = byteTruncate(input.command, 4 * 1024);
    const command = sanitizeTerminalText(bounded).replaceAll("\n", " ").trim();
    if (command !== "") return command;
  }
  const summary = sanitizeTerminalText(entry.summary ?? "").replaceAll("\n", " ").trim();
  return summary === "" ? "…" : summary;
}

function shellHeaderLine(entry: TranscriptEntry, width: number): RenderedLine {
  const input = toolInput(entry);
  const timeout = toolInputNumber(input, "timeout");
  const timeoutText = timeout === undefined ? "" : ` (timeout ${timeout}s)`;
  const maximumCells = Math.max(1, width * 2);
  const prefix = truncateCells("$ ", Math.min(2, maximumCells));
  const prefixWidth = cellWidth(prefix);
  const rawCommand = shellCommand(entry);
  const preferredCommandWidth = Math.min(
    cellWidth(rawCommand),
    Math.max(1, Math.min(8, width - prefixWidth)),
  );
  const stateBudget = Math.max(1, maximumCells - prefixWidth - preferredCommandWidth);
  const detailedState = toolStateSpans(entry);
  const selectedState = cellWidth(detailedState.map((span) => span.text).join("")) <= stateBudget
    ? detailedState
    : conciseToolStateSpans(entry);
  const state = boundedSpans(
    selectedState,
    stateBudget,
  );
  const stateWidth = cellWidth(state.map((span) => span.text).join(""));
  const availableBeforeState = Math.max(0, maximumCells - stateWidth);
  const timeoutWidth = cellWidth(timeoutText);
  const includeTimeout = timeoutText !== ""
    && prefixWidth + preferredCommandWidth + timeoutWidth <= availableBeforeState;
  const commandWidth = Math.max(
    0,
    availableBeforeState - prefixWidth - (includeTimeout ? timeoutWidth : 0),
  );
  const command = truncateCells(rawCommand, commandWidth);
  const spans: RuntimeUiSpan[] = [
    { text: `${prefix}${command}`, role: "title" },
    ...(includeTimeout ? [{ text: timeoutText, role: "muted" as const }] : []),
  ];
  appendToolState(spans, entry, width, state);
  return { text: "", role: "muted", spans };
}

function toolInputRole(value: string): ThemeRole {
  if (/^(?:@@|\*\*\*|\+\+\+|---)/u.test(value)) return "accent";
  if (value.startsWith("+")) return "success";
  if (value.startsWith("-")) return "error";
  return "muted";
}

function wrappedToolLines(
  value: string,
  width: number,
  role: ThemeRole | ((line: string) => ThemeRole),
): RenderedLine[] {
  return value.split("\n").flatMap((source) => {
    const selectedRole = typeof role === "function" ? role(source) : role;
    return wrapCells(source, width).map((line) => ({ text: line, role: selectedRole, fill: true }));
  });
}

function tailWrappedToolLines(
  value: string,
  width: number,
  role: ThemeRole,
  limit: number,
): { lines: RenderedLine[]; truncated: boolean; omittedRows?: number } {
  const byteBudget = Math.max(
    TOOL_INPUT_SAMPLE_GUARD_BYTES,
    Math.min(
      RETAINED_TOOL_INPUT_MAX_BYTES,
      Math.max(1, width) * Math.min(Math.max(1, limit), 60),
    ),
  );
  const encoded = Buffer.from(value, "utf8");
  const byteShortened = encoded.length > byteBudget;
  const retained = byteShortened
    ? byteTail(liveInputTailSample(encoded, byteBudget), byteBudget)
    : value;
  const source = retained.replace(/(?:\r?\n)+$/u, "").split("\n");
  const selected: RenderedLine[] = [];
  let truncated = byteShortened;
  let omittedRows: number | undefined = byteShortened ? undefined : 0;
  for (let index = source.length - 1; index >= 0 && selected.length < limit; index -= 1) {
    const line = source[index] ?? "";
    const remaining = limit - selected.length;
    const visualWidth = cellWidth(line);
    const sampled = visualWidth > width * remaining
      ? tailCells(line, width * remaining)
      : line;
    const rendered = wrapCells(sampled, width)
      .map((line): RenderedLine => ({ text: line, role, fill: true }));
    if (rendered.length > remaining) {
      selected.unshift(...rendered.slice(-remaining));
      truncated = true;
      if (omittedRows !== undefined) omittedRows = index + rendered.length - remaining;
      break;
    }
    if (sampled !== line) {
      selected.unshift(...rendered);
      truncated = true;
      if (omittedRows !== undefined) {
        omittedRows = index + Math.max(1, Math.ceil(visualWidth / Math.max(1, width))) - rendered.length;
      }
      break;
    }
    selected.unshift(...rendered);
    if (index > 0 && selected.length >= limit) {
      truncated = true;
      if (omittedRows !== undefined) omittedRows = index;
    }
  }
  return { lines: selected, truncated, ...(omittedRows === undefined ? {} : { omittedRows }) };
}

function liveOutputOmission(
  output: { omittedRows?: number },
  expanded: boolean,
  width: number,
  expandKeyHint?: string,
): RenderedLine {
  const detailed = expanded
    ? RETAINED_TOOL_OUTPUT_ROW_MARKER
    : output.omittedRows === undefined
      ? toolExpandMarker(COLLAPSED_TOOL_OUTPUT_ROW_MARKER, expandKeyHint)
      : `... (${quantity(output.omittedRows, "earlier line")}${toolExpandParenthetical(expandKeyHint)})`;
  const maximum = Math.max(1, width);
  const candidates = expanded
    ? [detailed, "… tail follows", "… shortened", "… hidden", "…"]
    : expandKeyHint === undefined
      ? [detailed, COLLAPSED_TOOL_OUTPUT_ROW_MARKER, "…"]
      : [
          detailed,
          toolExpandMarker(COLLAPSED_TOOL_OUTPUT_ROW_MARKER, expandKeyHint),
          `… · ${expandKeyHint}`,
          expandKeyHint,
          "…",
        ];
  const text = candidates.find((candidate) => cellWidth(candidate) <= maximum)
    ?? truncateCells("…", maximum);
  return {
    text,
    role: "muted",
    ...(isToolExpandFooter(text, expandKeyHint) ? { toolExpandFooter: true } : {}),
  };
}

function liveToolLines(
  entry: TranscriptEntry,
  width: number,
  expanded: boolean,
  expandKeyHint?: string,
): RenderedLine[] | undefined {
  if (entry.status !== "running") return undefined;
  const partial = entry.toolData?.partialResult;
  let partialLines: RenderedLine[] = [];
  if (partial !== undefined) {
    const role: ThemeRole = partial.isError ? "error" : "code";
    const partialOutput = tailWrappedToolLines(
      partial.content,
      width,
      role,
      expanded ? EXPANDED_TOOL_DETAIL_MAX_ROWS : 5,
    );
    partialLines = [
      ...(partialOutput.truncated
        ? [liveOutputOmission(partialOutput, expanded, width, expandKeyHint)]
        : []),
      ...partialOutput.lines,
      ...(partial.truncated === true ? [{ text: "[Live result was shortened]", role: "warning" as const }] : []),
    ];
  }
  const progress = entry.toolData?.progress;
  if (progress === undefined) return partialLines.length === 0 ? undefined : partialLines;
  const shell = entry.title === "shell" || entry.title === "bash";
  const channels = shell && progress.output !== undefined
    ? [{ label: "output", text: progress.output, bytes: progress.stdoutBytes + progress.stderrBytes, role: "code" as const }]
    : [
        { label: "stdout", text: progress.stdout, bytes: progress.stdoutBytes, role: "code" as const },
        { label: "stderr", text: progress.stderr, bytes: progress.stderrBytes, role: "warning" as const },
      ];
  const visibleChannels = channels.filter((channel) => channel.text !== "");
  const perChannel = visibleChannels.length > 1 ? 2 : 5;
  const expandedPerChannel = visibleChannels.length > 1
    ? Math.floor(EXPANDED_TOOL_DETAIL_MAX_ROWS / 2)
    : EXPANDED_TOOL_DETAIL_MAX_ROWS;
  const lines = visibleChannels.flatMap((channel): RenderedLine[] => {
    const source = channel.text.replace(/(?:\r?\n)+$/u, "");
    const output = tailWrappedToolLines(
      source,
      width,
      channel.role,
      expanded ? expandedPerChannel : perChannel,
    );
    return [
      ...(visibleChannels.length > 1 ? [{ text: `${channel.label} · ${quantity(channel.bytes, "byte")}`, role: channel.role }] : []),
      ...(output.truncated
        ? [liveOutputOmission(output, expanded, width, expandKeyHint)]
        : []),
      ...output.lines,
    ];
  });
  if (progress.truncated) lines.push({ text: "[Live output was shortened]", role: "warning" });
  return [...lines, ...partialLines];
}

function shellDurationText(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function shellLifecycleLines(entry: TranscriptEntry, width: number): RenderedLine[] {
  const line = (text: string, role: ThemeRole): RenderedLine[] =>
    wrapCells(text, width).map((wrapped) => ({ text: wrapped, role }));
  if (entry.status === "pending") return [];
  if (entry.status === "running") {
    const elapsedMs = entry.toolData?.progress?.elapsedMs;
    return elapsedMs === undefined ? [] : line(`Elapsed ${shellDurationText(elapsedMs)}`, "muted");
  }

  const metadata = toolMetadata(entry);
  const lines: RenderedLine[] = [];
  if (entry.status === "failed") {
    if (metadata?.timedOut === true) lines.push(...line("Command timed out", "error"));
    else if (metadata?.cancelled === true) lines.push(...line("Command aborted", "warning"));
    else if (typeof metadata?.signal === "string" && metadata.signal !== "") {
      lines.push(...line(`Command exited with signal ${sanitizeTerminalText(metadata.signal)}`, "error"));
    } else if (typeof metadata?.exitCode === "number" && Number.isSafeInteger(metadata.exitCode)) {
      lines.push(...line(`Command exited with code ${metadata.exitCode}`, "error"));
    }
  } else if (entry.status === "in_doubt") {
    lines.push(...line("Unknown outcome", "warning"));
  }

  const durationMs = metadata?.durationMs;
  if (typeof durationMs === "number" && Number.isSafeInteger(durationMs) && durationMs >= 0) {
    lines.push(...line(`Took ${shellDurationText(durationMs)}`, "muted"));
  }
  const fullOutputPath = metadata?.fullOutputPath;
  if (typeof fullOutputPath === "string" && fullOutputPath !== "") {
    lines.push(...line(`Full output: ${sanitizeTerminalText(fullOutputPath).replaceAll("\n", " ")}`, "warning"));
  } else if (metadata?.truncated === true) {
    lines.push(...line("Stored output is limited", "warning"));
  }
  return lines;
}

function boundedToolLines(
  lines: readonly RenderedLine[],
  tail: boolean,
  limit: number,
  width: number,
  theme: Theme,
  includeTotal = false,
  expandKeyHint?: string,
): RenderedLine[] {
  if (lines.length <= limit) return [...lines];
  const visible = tail ? lines.slice(-limit) : lines.slice(0, limit);
  const remaining = lines.length - visible.length;
  const omission = theme.glyphs.pending === "." ? "..." : "…";
  const detailedMarker = `${omission} (${remaining} ${tail ? "earlier" : "more"} lines${includeTotal ? `, ${lines.length} total` : ""}${toolExpandParenthetical(expandKeyHint)})`;
  const marker = boundedToolMarker(detailedMarker, width, expandKeyHint);
  const markerLine: RenderedLine = {
    text: marker,
    role: "muted",
    ...(isToolExpandFooter(marker, expandKeyHint) ? { toolExpandFooter: true } : {}),
  };
  return tail
    ? [markerLine, ...visible]
    : [...visible, markerLine];
}

function boundedHeadTailToolLines(
  lines: readonly RenderedLine[],
  maximumLines: number,
  width: number,
  theme: Theme,
  expandKeyHint?: string,
): RenderedLine[] {
  if (lines.length <= maximumLines) return [...lines];
  const visibleLines = Math.max(0, maximumLines - 1);
  const headLines = Math.ceil(visibleLines / 2);
  const tailLines = visibleLines - headLines;
  const remaining = lines.length - headLines - tailLines;
  const omission = theme.glyphs.pending === "." ? "..." : "…";
  const marker = boundedToolMarker(toolExpandMarker(
    `${omission} ${quantity(remaining, "hidden line")}`,
    expandKeyHint,
    " expand",
  ), width, expandKeyHint);
  const markerLine: RenderedLine = {
    text: marker,
    role: "muted",
    ...(isToolExpandFooter(marker, expandKeyHint) ? { toolExpandFooter: true } : {}),
  };
  return [
    ...lines.slice(0, headLines),
    markerLine,
    ...(tailLines === 0 ? [] : lines.slice(-tailLines)),
  ];
}

function collapsedToolBody(
  entry: TranscriptEntry,
  input: readonly RenderedLine[],
  output: readonly RenderedLine[],
  width: number,
  theme: Theme,
  expandKeyHint?: string,
): RenderedLine[] {
  if (entry.expanded === true) return [...input, ...output];
  if (entry.status === "pending") return [...input];
  if (entry.status === "running") return [...input, ...output];
  if (entry.title === "read") {
    if (entry.status === "completed") {
      return [...input, ...output];
    }
    if (entry.status === "failed" || entry.status === "in_doubt") {
      return [...output, ...input];
    }
  }
  if (entry.title === "shell" || entry.title === "bash") {
    return [...output, ...input];
  }
  if (entry.title === "grep") return [...input, ...output];
  if (entry.title === "find" || entry.title === "ls") {
    return [...input, ...output];
  }
  if (entry.title === "write") {
    return entry.status === "failed" || entry.status === "in_doubt"
      ? boundedHeadTailToolLines([...input, ...output], 10, width, theme, expandKeyHint)
      : [...input];
  }
  if (entry.title === "edit") {
    if (entry.status === "failed" || entry.status === "in_doubt") {
      return boundedHeadTailToolLines([...input, ...output], 10, width, theme, expandKeyHint);
    }
    if (entry.status === "completed") {
      return boundedHeadTailToolLines(output.length > 0 ? output : input, 10, width, theme, expandKeyHint);
    }
    return [...input];
  }
  if (entry.title === "apply_patch") {
    return [...input, ...output];
  }
  if (input.length === 0) return [...output];
  if (output.length === 0) return [...input];
  const generic = [...input, ...output];
  return boundedToolLines(generic, false, 10, width, theme, false, expandKeyHint);
}

function collapsedToolNeedsOutput(entry: TranscriptEntry): boolean {
  if (
    entry.expanded === true
    || entry.status === "pending"
    || entry.status === "running"
    || entry.status === "failed"
    || entry.status === "in_doubt"
  ) return true;
  if (entry.title === "read") {
    return true;
  }
  return entry.title !== "write";
}

const LIVE_TOOL_INPUT_MAX_BYTES = 4 * 1024;
const RETAINED_TOOL_INPUT_MAX_BYTES = 64 * 1024;
const LIVE_TOOL_INPUT_MARKER = "… earlier live input hidden; newest input follows";
const LIVE_TOOL_INPUT_TAIL_ROWS = 3;
const LIVE_TOOL_INPUT_TAIL_MARKER = "… earlier input hidden; newest lines follow";
const EXPANDED_TOOL_DETAIL_MAX_ROWS = 120;
const RETAINED_MUTATION_ROW_MARKER = "… retained input rows shortened; ending follows";
const COLLAPSED_MUTATION_ROW_MARKER = "… input shortened";
const COLLAPSED_WRITE_ROW_MARKER = "… middle input hidden; newest input follows";
const COLLAPSED_WRITE_COMPLETE_ROW_MARKER = "… source shortened";
const COLLAPSED_WRITE_COMPLETE_MAX_ROWS = 4;
const RETAINED_TOOL_OUTPUT_ROW_MARKER = "… retained output rows shortened; ending follows";
const RETAINED_HEAD_OUTPUT_ROW_MARKER = "… retained output rows shortened; first rows shown";
const COLLAPSED_TOOL_OUTPUT_ROW_MARKER = "… output shortened";
const RETAINED_EXTENSION_ROW_MARKER = "… retained extension rows shortened; ending follows";
const RETAINED_STARTUP_ROW_MARKER = "… retained startup rows shortened; ending follows";
const COLLAPSED_STARTUP_ROW_MARKER = "… startup shortened";
const RETAINED_CARD_ROW_MARKER = "… retained card rows shortened; ending follows";
const RETAINED_HEAD_CARD_ROW_MARKER = "… retained card rows shortened; first rows shown";
const RETAINED_REASONING_ROW_MARKER = "… retained reasoning rows shortened; ending follows";
const RETAINED_REASONING_MAX_BYTES = 256 * 1024;
const TOOL_INPUT_SAMPLE_GUARD_BYTES = 4 * 1024;
const HEADER_SUMMARIZED_TOOL_INPUTS = new Set(["read", "grep", "find", "ls", "bash", "shell"]);
const BUILT_IN_TOOL_INPUTS = new Set([...HEADER_SUMMARIZED_TOOL_INPUTS, "edit", "write", "apply_patch"]);

function normalizedExpandKeyHint(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const safe = byteTruncate(sanitizeTerminalText(value).replaceAll("\n", " ").trim(), 64);
  return safe === "" ? undefined : safe;
}

function toolExpandMarker(marker: string, expandKeyHint: string | undefined, action = ""): string {
  return expandKeyHint === undefined ? marker : `${marker} · ${expandKeyHint}${action}`;
}

function toolExpandParenthetical(expandKeyHint: string | undefined): string {
  return expandKeyHint === undefined ? "" : `, ${expandKeyHint} to expand`;
}

function isToolExpandFooter(text: string, expandKeyHint: string | undefined): boolean {
  return expandKeyHint !== undefined && text.includes(expandKeyHint);
}

function toolExpandCandidates(marker: string, expandKeyHint: string | undefined): string[] {
  return expandKeyHint === undefined
    ? [marker, "… shortened", "… hidden", "…"]
    : [marker, `… hidden · ${expandKeyHint}`, `… · ${expandKeyHint}`, expandKeyHint, "…"];
}

function liveInputHeadSample(encoded: Buffer, retainedBytes: number): string {
  let end = Math.min(encoded.length, retainedBytes + TOOL_INPUT_SAMPLE_GUARD_BYTES);
  if (end < encoded.length) {
    let lead = end - 1;
    while (lead >= 0 && (encoded[lead]! & 0xc0) === 0x80) lead -= 1;
    const leadByte = lead < 0 ? 0 : encoded[lead]!;
    const expected = leadByte < 0x80 ? 1 : leadByte < 0xe0 ? 2 : leadByte < 0xf0 ? 3 : 4;
    if (end - lead < expected) end = Math.max(0, lead);
  }
  return encoded.subarray(0, end).toString("utf8");
}

function liveInputTailSample(encoded: Buffer, retainedBytes: number): string {
  let start = Math.max(0, encoded.length - retainedBytes - TOOL_INPUT_SAMPLE_GUARD_BYTES);
  while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString("utf8");
}

interface RetainedTextSample {
  head: string;
  tail?: string;
  shortened: boolean;
}

function lineEndAfter(value: string, rows: number): number | undefined {
  let cursor = 0;
  for (let row = 0; row < rows; row += 1) {
    const separator = value.indexOf("\n", cursor);
    if (separator < 0) return undefined;
    if (row === rows - 1) return separator;
    cursor = separator + 1;
  }
  return undefined;
}

function lineStartBefore(value: string, rows: number): number | undefined {
  let cursor = value.length;
  for (let row = 0; row < rows; row += 1) {
    const separator = value.lastIndexOf("\n", cursor - 1);
    if (separator < 0) return undefined;
    cursor = separator;
  }
  return cursor + 1;
}

function retainedTextSample(
  value: string,
  width: number,
  maximumBytes: number,
  maximumRows = MAX_RETAINED_MUTATION_PREVIEW_ROWS,
  mode: "head-tail" | "head" = "head-tail",
): RetainedTextSample {
  const source = value;
  const sourceRows = Math.max(1, maximumRows <= 32 ? maximumRows - 1 : Math.floor(maximumRows / 2));
  if (mode === "head") {
    const headEnd = lineEndAfter(source, sourceRows);
    const endsAtFinalTerminator = headEnd === source.length - 1;
    let head = headEnd === undefined || endsAtFinalTerminator ? source : source.slice(0, headEnd);
    let shortened = headEnd !== undefined && !endsAtFinalTerminator;
    const byteBudget = Math.max(1, Math.min(maximumBytes, Math.max(1, width) * sourceRows));
    if (Buffer.byteLength(head, "utf8") > byteBudget) {
      head = byteTruncate(liveInputHeadSample(Buffer.from(head, "utf8"), byteBudget), byteBudget);
      shortened = true;
    }
    return { head: sanitizeTerminalText(head), shortened };
  }
  const headRows = Math.floor(sourceRows * 2 / 3);
  const tailRows = sourceRows - headRows;
  const headEnd = lineEndAfter(source, headRows);
  const tailStart = lineStartBefore(source, tailRows);
  let head = source;
  let tail: string | undefined;
  let shortened = false;
  if (headEnd !== undefined && tailStart !== undefined && tailStart > headEnd + 1) {
    head = source.slice(0, headEnd);
    tail = source.slice(tailStart);
    shortened = true;
  }

  const byteBudget = Math.max(1, Math.min(
    maximumBytes,
    Math.max(1, width) * sourceRows,
  ));
  const totalBytes = Buffer.byteLength(head, "utf8") + (tail === undefined ? 0 : Buffer.byteLength(tail, "utf8"));
  if (totalBytes > byteBudget) {
    const headBudget = Math.floor(byteBudget * 2 / 3);
    const tailBudget = byteBudget - headBudget;
    if (tail === undefined) {
      const encoded = Buffer.from(head, "utf8");
      tail = byteTail(liveInputTailSample(encoded, tailBudget), tailBudget);
      head = byteTruncate(liveInputHeadSample(encoded, headBudget), headBudget);
    } else {
      head = byteTruncate(liveInputHeadSample(Buffer.from(head, "utf8"), headBudget), headBudget);
      tail = byteTail(liveInputTailSample(Buffer.from(tail, "utf8"), tailBudget), tailBudget);
    }
    shortened = true;
  }
  head = sanitizeTerminalText(head);
  if (tail !== undefined) tail = sanitizeTerminalText(tail);
  return { head, ...(tail === undefined ? {} : { tail }), shortened };
}

function retainedPreviewLines(
  sample: RetainedTextSample,
  width: number,
  markerText: string,
  render: (value: string) => RenderedLine[],
  maximumRows = MAX_RETAINED_MUTATION_PREVIEW_ROWS,
  expandKeyHint?: string,
): RenderedLine[] {
  const head = sample.head === "" ? [] : render(sample.head);
  const tail = sample.tail === undefined || sample.tail === "" ? [] : render(sample.tail);
  const content = [...head, ...tail];
  const shortened = sample.shortened || content.length > maximumRows;
  if (!shortened) return content;
  const available = Math.max(0, maximumRows - 1);
  const markerWidth = Math.max(1, width);
  const marker = {
    text: boundedToolMarker(markerText, markerWidth, expandKeyHint),
    role: "muted" as const,
  };
  const markedFooter: RenderedLine = {
    ...marker,
    ...(isToolExpandFooter(marker.text, expandKeyHint) ? { toolExpandFooter: true } : {}),
  };
  if (sample.tail === undefined) return [...content.slice(0, available), markedFooter];
  const headRows = Math.floor(available * 2 / 3);
  const tailRows = available - headRows;
  const selectedHead = content.length <= available ? head : content.slice(0, headRows);
  const selectedTail = content.length <= available ? tail : content.slice(-tailRows);
  return [
    ...selectedHead,
    markedFooter,
    ...selectedTail,
  ].slice(0, maximumRows);
}

function boundedToolMarker(markerText: string, width: number, expandKeyHint?: string): string {
  const maximum = Math.max(1, width);
  const candidates = expandKeyHint !== undefined
    ? toolExpandCandidates(markerText, expandKeyHint)
    : markerText.includes("first rows shown")
      ? [markerText, "… first rows shown", "… first rows", "… shortened", "…"]
      : [markerText, "… tail follows", "… shortened", "… hidden", "…"];
  return candidates.find((candidate) => cellWidth(candidate) <= maximum) ?? "";
}

function liveToolInputLines(
  value: string,
  width: number,
  render: (selected: string) => RenderedLine[] = (selected) => wrappedToolLines(selected, width, toolInputRole),
): RenderedLine[] {
  return retainedPreviewLines(
    retainedTextSample(
      value,
      width,
      LIVE_TOOL_INPUT_MAX_BYTES,
      EXPANDED_TOOL_DETAIL_MAX_ROWS,
    ),
    width,
    LIVE_TOOL_INPUT_MARKER,
    render,
    EXPANDED_TOOL_DETAIL_MAX_ROWS,
  );
}

function liveNewestToolInputLines(
  value: string,
  width: number,
  render: (selected: string) => RenderedLine[] = (selected) => wrappedToolLines(selected, width, toolInputRole),
  markerText = LIVE_TOOL_INPUT_TAIL_MARKER,
  expandKeyHint?: string,
): RenderedLine[] {
  const encoded = Buffer.from(value, "utf8");
  const tailBytes = Math.min(
    LIVE_TOOL_INPUT_MAX_BYTES,
    Math.max(256, Math.max(1, width) * LIVE_TOOL_INPUT_TAIL_ROWS * 4),
  );
  const selected = byteTail(liveInputTailSample(encoded, tailBytes), tailBytes);
  const lines = render(selected);
  if (encoded.length <= tailBytes && lines.length <= LIVE_TOOL_INPUT_TAIL_ROWS) return lines;
  const marker = boundedToolMarker(toolExpandMarker(markerText, expandKeyHint), width, expandKeyHint);
  return [
    {
      text: marker,
      role: "muted",
      ...(isToolExpandFooter(marker, expandKeyHint) ? { toolExpandFooter: true } : {}),
    },
    ...lines.slice(-LIVE_TOOL_INPUT_TAIL_ROWS),
  ];
}

function withToolExpandFooter(
  lines: readonly RenderedLine[],
  width: number,
  theme: Theme,
  expandKeyHint?: string,
): RenderedLine[] {
  const body: RenderedLine[] = [];
  const footer: RenderedLine[] = [];
  for (const line of lines) {
    const selected = { ...line };
    delete selected.toolExpandFooter;
    (line.toolExpandFooter === true ? footer : body).push(selected);
  }
  if (footer.length === 0) return body;
  if (footer.length === 1) return [...body, footer[0]!];
  const omission = theme.glyphs.pending === "." ? "..." : "…";
  return [...body, {
    text: boundedToolMarker(toolExpandMarker(`${omission} details shortened`, expandKeyHint), width, expandKeyHint),
    role: "muted",
  }];
}

function writeContentLines(value: string, width: number, languageHint: string): RenderedLine[] {
  const highlighted = languageHint === "" ? [] : renderSyntaxCodeLines("", value, width, languageHint);
  return highlighted.length === 0 ? wrappedToolLines(value, width, "code") : highlighted;
}

function writeInputLines(
  entry: TranscriptEntry,
  width: number,
  live: boolean,
  expandKeyHint?: string,
): RenderedLine[] | undefined {
  if (entry.title !== "write") return undefined;
  const input = toolInput(entry);
  const content = toolInputText(input, "content");
  if (content === undefined) return undefined;
  if (content === "") return [];
  const path = toolInputString(input, "file_path", "path");
  const languageHint = path === undefined ? "" : extname(path).slice(1);
  if (!live) {
    const collapsedCompleted = entry.expanded !== true && entry.status === "completed";
    const previewRows = entry.expanded === true
      ? EXPANDED_TOOL_DETAIL_MAX_ROWS
      : collapsedCompleted
        ? COLLAPSED_WRITE_COMPLETE_MAX_ROWS
        : 11;
    return retainedPreviewLines(
      retainedTextSample(
        content,
        width,
        RETAINED_TOOL_INPUT_MAX_BYTES,
        previewRows,
        collapsedCompleted ? "head" : "head-tail",
      ),
      width,
      entry.expanded === true
        ? RETAINED_MUTATION_ROW_MARKER
        : collapsedCompleted
          ? toolExpandMarker(COLLAPSED_WRITE_COMPLETE_ROW_MARKER, expandKeyHint)
          : toolExpandMarker(COLLAPSED_WRITE_ROW_MARKER, expandKeyHint),
      (selected) => writeContentLines(selected, width, languageHint),
      previewRows,
      collapsedCompleted || entry.expanded !== true ? expandKeyHint : undefined,
    );
  }
  const render = (selected: string): RenderedLine[] => writeContentLines(selected, width, languageHint);
  return entry.expanded === true
    ? liveToolInputLines(content, width, render)
    : liveNewestToolInputLines(content, width, render, LIVE_TOOL_INPUT_MARKER, expandKeyHint);
}

function retainedMutationInputLines(
  entry: TranscriptEntry,
  width: number,
  expandKeyHint?: string,
): RenderedLine[] | undefined {
  if (!MUTATION_TOOL_NAMES.has(entry.title ?? "") || entry.inputPreview === undefined || entry.inputPreview === "") {
    return undefined;
  }
  const collapsedWrite = entry.expanded !== true && entry.title === "write";
  const collapsedCompletedWrite = collapsedWrite && entry.status === "completed";
  const previewRows = entry.expanded === true
    ? EXPANDED_TOOL_DETAIL_MAX_ROWS
    : collapsedCompletedWrite
      ? COLLAPSED_WRITE_COMPLETE_MAX_ROWS
      : collapsedWrite
        ? 11
        : 10;
  return retainedPreviewLines(
    retainedTextSample(
      entry.inputPreview,
      width,
      RETAINED_TOOL_INPUT_MAX_BYTES,
      previewRows,
      collapsedCompletedWrite ? "head" : "head-tail",
    ),
    width,
    entry.expanded === true
      ? RETAINED_MUTATION_ROW_MARKER
      : collapsedCompletedWrite
        ? toolExpandMarker(COLLAPSED_WRITE_COMPLETE_ROW_MARKER, expandKeyHint)
      : collapsedWrite
        ? toolExpandMarker(COLLAPSED_WRITE_ROW_MARKER, expandKeyHint)
        : toolExpandMarker(COLLAPSED_MUTATION_ROW_MARKER, expandKeyHint),
    (selected) => wrappedToolLines(selected, width, toolInputRole),
    previewRows,
    entry.expanded === true ? undefined : expandKeyHint,
  );
}

function serializedToolInput(input: Record<string, unknown>): string {
  return JSON.stringify(input, null, 2) ?? "{}";
}

function genericToolInputLines(
  entry: TranscriptEntry,
  width: number,
  expandKeyHint?: string,
): RenderedLine[] | undefined {
  if (BUILT_IN_TOOL_INPUTS.has(entry.title ?? "")) return undefined;
  const input = toolInput(entry);
  if (input === undefined || Object.keys(input).length === 0) return undefined;
  const maximumRows = entry.expanded === true ? EXPANDED_TOOL_DETAIL_MAX_ROWS : 10;
  return retainedPreviewLines(
    retainedTextSample(
      serializedToolInput(input),
      width,
      RETAINED_TOOL_INPUT_MAX_BYTES,
      maximumRows,
    ),
    width,
    entry.expanded === true
      ? RETAINED_MUTATION_ROW_MARKER
      : toolExpandMarker(COLLAPSED_MUTATION_ROW_MARKER, expandKeyHint),
    (selected) => wrappedToolLines(selected, width, "muted"),
    maximumRows,
    entry.expanded === true ? undefined : expandKeyHint,
  );
}

function retainedFallbackToolInputLines(
  entry: TranscriptEntry,
  width: number,
  expandKeyHint?: string,
): RenderedLine[] {
  if (entry.inputPreview === undefined || entry.inputPreview === "") return [];
  const maximumRows = entry.expanded === true ? EXPANDED_TOOL_DETAIL_MAX_ROWS : 10;
  return retainedPreviewLines(
    retainedTextSample(
      entry.inputPreview,
      width,
      RETAINED_TOOL_INPUT_MAX_BYTES,
      maximumRows,
    ),
    width,
    entry.expanded === true
      ? RETAINED_MUTATION_ROW_MARKER
      : toolExpandMarker(COLLAPSED_MUTATION_ROW_MARKER, expandKeyHint),
    (selected) => wrappedToolLines(selected, width, toolInputRole),
    maximumRows,
    entry.expanded === true ? undefined : expandKeyHint,
  );
}

function liveStructuredToolInput(entry: TranscriptEntry): string | undefined {
  const input = toolInput(entry);
  if (BUILT_IN_TOOL_INPUTS.has(entry.title ?? "") || input === undefined || Object.keys(input).length === 0) {
    return undefined;
  }
  return serializedToolInput(input);
}

function retainedMutationOutputLines(
  entry: TranscriptEntry,
  value: string,
  width: number,
  role: ThemeRole,
  expandKeyHint?: string,
): RenderedLine[] | undefined {
  if (!MUTATION_TOOL_NAMES.has(entry.title ?? "") || value === "") return undefined;
  const previewRows = entry.expanded === true ? EXPANDED_TOOL_DETAIL_MAX_ROWS : 10;
  return retainedPreviewLines(
    retainedTextSample(value, width, RETAINED_TOOL_INPUT_MAX_BYTES, previewRows),
    width,
    entry.expanded === true
      ? RETAINED_MUTATION_ROW_MARKER
      : toolExpandMarker(COLLAPSED_MUTATION_ROW_MARKER, expandKeyHint),
    (selected) => wrappedToolLines(selected, width, role),
    previewRows,
    entry.expanded === true ? undefined : expandKeyHint,
  );
}

function storedOutputRowLimit(entry: TranscriptEntry): number {
  if (entry.expanded === true) return EXPANDED_TOOL_DETAIL_MAX_ROWS;
  if (entry.title === "shell" || entry.title === "bash") return 5;
  if (entry.title === "grep") return 15;
  if (entry.title === "find" || entry.title === "ls") return 20;
  if (entry.status === "running") return 8;
  return 10;
}

function storedToolOutputLines(
  entry: TranscriptEntry,
  value: string,
  width: number,
  role: ThemeRole,
  expandKeyHint?: string,
): RenderedLine[] {
  if (value === "") return [];
  const maximumRows = storedOutputRowLimit(entry);
  const expanded = entry.expanded === true;
  if (entry.title === "shell" || entry.title === "bash" || entry.status === "running") {
    const output = tailWrappedToolLines(value, width, role, maximumRows);
    return [
      ...(output.truncated ? [liveOutputOmission(output, expanded, width, expandKeyHint)] : []),
      ...output.lines,
    ];
  }
  const headOnly = !expanded
    || entry.title === "read"
    || entry.title === "grep"
    || entry.title === "find"
    || entry.title === "ls";
  const previewRows = expanded ? maximumRows : maximumRows + 1;
  return retainedPreviewLines(
    retainedTextSample(
      value,
      width,
      RETAINED_TOOL_INPUT_MAX_BYTES,
      previewRows,
      headOnly ? "head" : "head-tail",
    ),
    width,
    expanded
      ? (headOnly ? RETAINED_HEAD_OUTPUT_ROW_MARKER : RETAINED_TOOL_OUTPUT_ROW_MARKER)
      : toolExpandMarker(COLLAPSED_TOOL_OUTPUT_ROW_MARKER, expandKeyHint),
    (selected) => wrappedToolLines(selected, width, role),
    previewRows,
    expanded ? undefined : expandKeyHint,
  );
}

function defaultToolBodyLines(
  entry: TranscriptEntry,
  contentWidth: number,
  theme: Theme,
  expandKeyHint?: string,
): RenderedLine[] {
  const lineWidth = Math.max(1, contentWidth);
  const shell = entry.title === "shell" || entry.title === "bash";
  const summary = entry.summary?.trim() ?? "";
  const liveInput = entry.status === "pending" || entry.status === "running";
  const writeInput = writeInputLines(entry, lineWidth, liveInput, expandKeyHint);
  const mutationInput = liveInput ? undefined : retainedMutationInputLines(entry, lineWidth, expandKeyHint);
  const genericInput = liveInput ? undefined : genericToolInputLines(entry, lineWidth, expandKeyHint);
  const structuredLiveInput = liveInput ? liveStructuredToolInput(entry) : undefined;
  const hideLiveEdit = liveInput && entry.title === "edit" && entry.expanded !== true;
  const input = hideLiveEdit
    ? []
    : writeInput !== undefined
    ? writeInput
    : mutationInput !== undefined
    ? mutationInput
    : structuredLiveInput !== undefined
    ? entry.expanded === true
      ? liveToolInputLines(structuredLiveInput, lineWidth)
      : liveNewestToolInputLines(structuredLiveInput, lineWidth, undefined, LIVE_TOOL_INPUT_TAIL_MARKER, expandKeyHint)
    : liveInput && entry.inputPreview !== undefined && entry.inputPreview !== ""
      ? entry.title === "write"
        ? entry.expanded === true
          ? liveToolInputLines(entry.inputPreview, lineWidth)
          : liveNewestToolInputLines(
              entry.inputPreview,
              lineWidth,
              undefined,
              LIVE_TOOL_INPUT_MARKER,
              expandKeyHint,
            )
        : entry.expanded === true
        ? liveToolInputLines(entry.inputPreview, lineWidth)
        : liveNewestToolInputLines(entry.inputPreview, lineWidth, undefined, LIVE_TOOL_INPUT_TAIL_MARKER, expandKeyHint)
      : genericInput ?? (HEADER_SUMMARIZED_TOOL_INPUTS.has(entry.title ?? "") && summary !== ""
        ? []
        : retainedFallbackToolInputLines(entry, lineWidth, expandKeyHint));
  let output: RenderedLine[] = [];
  let liveOutput: RenderedLine[] | undefined;
  if (collapsedToolNeedsOutput(entry)) {
    const failed = entry.status === "failed" || entry.status === "in_doubt";
    liveOutput = liveToolLines(entry, lineWidth, entry.expanded === true, expandKeyHint);
    const storedText = shell ? entry.text.replace(/(?:\r?\n)+$/u, "") : entry.text;
    const storedRole = failed ? "error" : entry.status === "running" ? "toolRunning" : "code";
    const outputRows = storedOutputRowLimit(entry);
    output = liveOutput
      ?? syntaxReadLines(entry, contentWidth, outputRows, expandKeyHint)
      ?? retainedMutationOutputLines(entry, storedText, lineWidth, storedRole, expandKeyHint)
      ?? storedToolOutputLines(entry, storedText, lineWidth, storedRole, expandKeyHint);
  }
  const selectedOutput = entry.status === "running" && entry.expanded !== true && liveOutput === undefined
    ? boundedToolLines(output, true, 8, contentWidth, theme, false, expandKeyHint)
    : output;
  const body = collapsedToolBody(entry, input, selectedOutput, contentWidth, theme, expandKeyHint);
  if (!shell) {
    return withToolExpandFooter(
      body.length === 0 ? [] : [{ text: "", role: "muted" }, ...body],
      lineWidth,
      theme,
      expandKeyHint,
    );
  }
  const lifecycle = shellLifecycleLines(entry, lineWidth);
  const shellBody = body.length === 0 && entry.status === "completed"
    ? [{ text: "(no output)", role: "muted" as const }]
    : body;
  return withToolExpandFooter([
    ...(shellBody.length === 0 ? [] : [{ text: "", role: "muted" as const }, ...shellBody]),
    ...(lifecycle.length === 0 ? [] : [{ text: "", role: "muted" as const }, ...lifecycle]),
  ], lineWidth, theme, expandKeyHint);
}

function syntaxReadLines(
  entry: TranscriptEntry,
  width: number,
  maximumRows: number,
  expandKeyHint?: string,
): RenderedLine[] | undefined {
  if (entry.title !== "read" || entry.status === "running" || entry.text === "") return undefined;
  const input = entry.toolData?.input;
  if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.path !== "string") return undefined;
  const languageHint = extname(input.path).slice(1);
  if (languageHint === "") return undefined;
  const previewRows = entry.expanded === true ? maximumRows : maximumRows + 1;
  const lines = retainedPreviewLines(
    retainedTextSample(
      entry.text,
      width,
      RETAINED_TOOL_INPUT_MAX_BYTES,
      previewRows,
      "head",
    ),
    width,
    entry.expanded === true
      ? RETAINED_HEAD_OUTPUT_ROW_MARKER
      : toolExpandMarker(COLLAPSED_TOOL_OUTPUT_ROW_MARKER, expandKeyHint),
    (selected) => {
      const highlighted = renderSyntaxCodeLines("", selected, Math.max(1, width), languageHint);
      return highlighted.length === 0 ? wrappedToolLines(selected, width, "code") : highlighted;
    },
    previewRows,
    entry.expanded === true ? undefined : expandKeyHint,
  );
  return lines.length === 0 ? undefined : lines;
}

function structuralLines(value: RuntimeUiBlock | undefined, width: number): RenderedLine[] | undefined {
  if (value === undefined) return undefined;
  try {
    return sanitizeRuntimeUiBlock(value, { width }).lines.map((line) => ({
      text: line.spans.map((span) => span.text).join(""),
      role: "muted",
      spans: line.spans,
      ...(line.fill === undefined ? {} : { fill: line.fill }),
    }));
  } catch {
    return undefined;
  }
}

function structuralSlotLines(
  values: readonly RuntimeUiBlock[] | undefined,
  width: number,
  maximumLines: number,
): RenderedLine[] {
  return (values ?? []).slice(-16).flatMap((value) => {
    try {
      return structuralLines(sanitizeRuntimeUiBlock(value, {
        width,
        maxLines: 4,
        maxBytes: 16 * 1024,
      }), width) ?? [];
    } catch {
      return [];
    }
  }).slice(-maximumLines);
}

function structuralEditorBlock(
  value: RuntimeUiBlock | undefined,
  width: number,
  maximumLines: number,
): EditorBlock | undefined {
  if (value === undefined) return undefined;
  try {
    const block = sanitizeRuntimeUiBlock(value, { width, maxLines: maximumLines });
    if (block.cursor === undefined || block.lines.length === 0) return undefined;
    return {
      lines: block.lines.map((line) => ({
        text: line.spans.map((span) => span.text).join(""),
        role: "accent",
        spans: line.spans,
        ...(line.fill === undefined ? {} : { fill: line.fill }),
      })),
      cursor: block.cursor,
    };
  } catch {
    return undefined;
  }
}

function hangingLines(prefix: string, value: string, width: number, role: ThemeRole): RenderedLine[] {
  const safePrefix = truncateCells(prefix, Math.max(1, width - 1));
  const available = Math.max(1, width - cellWidth(safePrefix));
  const wrapped = wrapCells(value, available);
  return wrapped.map((line, index) => ({
    role,
    text: `${index === 0 ? safePrefix : " ".repeat(cellWidth(safePrefix))}${line}`,
  }));
}

function retainedExtensionFallbackLines(
  prefix: string,
  value: string,
  width: number,
  role: ThemeRole,
): RenderedLine[] {
  return retainedPreviewLines(
    retainedTextSample(
      value,
      width,
      RETAINED_TOOL_INPUT_MAX_BYTES,
      EXPANDED_TOOL_DETAIL_MAX_ROWS,
    ),
    width,
    RETAINED_EXTENSION_ROW_MARKER,
    (selected) => hangingLines(prefix, selected, width, role),
    EXPANDED_TOOL_DETAIL_MAX_ROWS,
  );
}

interface CachedTranscriptEntryLines {
  signature: readonly unknown[];
  lines: RenderedLine[];
}

const cachedAssistantLines = new WeakMap<TranscriptEntry, CachedTranscriptEntryLines>();
const cachedReasoningBodyLines = new WeakMap<TranscriptEntry, CachedTranscriptEntryLines>();
const cachedUserLines = new WeakMap<TranscriptEntry, CachedTranscriptEntryLines>();
const cachedHangingLines = new WeakMap<TranscriptEntry, CachedTranscriptEntryLines>();

function stableTranscriptEntryLines(
  cache: WeakMap<TranscriptEntry, CachedTranscriptEntryLines>,
  entry: TranscriptEntry,
  signature: readonly unknown[],
  render: () => RenderedLine[],
): RenderedLine[] {
  const cached = cache.get(entry);
  if (cached !== undefined
    && cached.signature.length === signature.length
    && cached.signature.every((value, index) => Object.is(value, signature[index]))) return cached.lines;
  const lines = render();
  cache.set(entry, { signature, lines });
  return lines;
}

function userMessageLines(value: string, width: number, outputPad = 1): RenderedLine[] {
  const leftPadding = Math.min(outputPad, Math.max(0, width - 1));
  const rightPadding = Math.min(outputPad, Math.max(0, width - leftPadding - 1));
  const edge = " ".repeat(leftPadding);
  const content = renderMarkdownMessageLines(
    edge,
    value,
    Math.max(1, width - rightPadding),
    "userMessage",
    "userMessage",
  );
  const padding: RenderedLine = {
    text: "",
    role: "userMessage",
    background: "userMessageBg",
    fill: true,
  };
  return [
    padding,
    ...content.map((line): RenderedLine => ({
      ...line,
      background: "userMessageBg",
      fill: true,
    })),
    padding,
  ];
}

function imageOnlyUserMessageLines(lines: readonly RenderedLine[], width: number, outputPad = 1): RenderedLine[] {
  const leftPadding = " ".repeat(Math.min(outputPad, Math.max(0, width - 1)));
  const padding: RenderedLine = {
    text: "",
    role: "userMessage",
    background: "userMessageBg",
    fill: true,
  };
  return [
    padding,
    ...lines.map((line): RenderedLine => ({
      ...line,
      text: line.image === undefined ? `${leftPadding}${line.text}` : line.text,
      role: line.image === undefined ? "userMessage" : line.role,
      background: "userMessageBg",
      fill: true,
    })),
    padding,
  ];
}

function toolCardPadding(width: number): { left: number; right: number; content: number } {
  const left = width >= 3 ? 1 : 0;
  const right = width >= 4 ? 1 : 0;
  return { left, right, content: Math.max(1, width - left - right) };
}

function activityTimelinePadding(width: number): { left: number; right: number; content: number } {
  const left = width >= 3 ? 2 : 0;
  return { left, right: 0, content: Math.max(1, width - left) };
}

function compactToolLines(lines: readonly RenderedLine[], width: number): RenderedLine[] {
  return lines.flatMap((line): RenderedLine[] => {
    const selected = line.spans === undefined
      ? [{ ...line, text: truncateCells(line.text, width) }]
      : wrappedSpans(line.spans, width).map((spans): RenderedLine => ({ ...line, text: "", spans }));
    return selected.map((value): RenderedLine => {
      const compact = { ...value, fill: false };
      delete compact.background;
      return compact;
    });
  });
}

function toolCardStatus(entry: TranscriptEntry, theme: Theme): { glyph: string; role: ThemeRole } {
  if (entry.status === "completed") return { glyph: theme.glyphs.success, role: "success" };
  if (entry.status === "failed") return { glyph: theme.glyphs.failure, role: "error" };
  if (entry.status === "in_doubt") return { glyph: "!", role: "warning" };
  if (entry.status === "running") return { glyph: theme.glyphs.pending, role: "toolRunning" };
  return { glyph: theme.glyphs.tool, role: "toolPending" };
}

function toolCardLines(
  entry: TranscriptEntry,
  lines: readonly RenderedLine[],
  width: number,
  theme: Theme,
): RenderedLine[] {
  const status = toolCardStatus(entry, theme);
  const railRole = entry.status === "completed"
    ? "success"
    : entry.status === "failed"
      ? "error"
      : entry.status === "in_doubt"
        ? "warning"
        : entry.status === "running"
          ? "toolRunning"
          : "toolPending";
  const paddingCells = activityTimelinePadding(width);
  const content = compactToolLines(lines, paddingCells.content);
  const rendered = content.map((line, index): RenderedLine => {
    const marker: RuntimeUiSpan = index === 0
      ? { text: `${status.glyph}${paddingCells.left > 1 ? " " : ""}`, role: status.role }
      : { text: `${theme.unicode ? "│" : "|"}${paddingCells.left > 1 ? " " : ""}`, role: railRole };
    return {
      ...line,
      text: "",
      spans: boundedSpans([
        ...(paddingCells.left === 0 ? [] : [marker]),
        ...(line.spans ?? [{ text: truncateCells(line.text, paddingCells.content), role: line.role }]),
      ], width - paddingCells.right),
      background: "toolPendingBg",
      fill: theme.ansi,
    };
  });
  const viewportHeader = rendered[0];
  return viewportHeader === undefined
    ? rendered
    : rendered.map((line, index) => index === 0 ? line : { ...line, viewportHeader });
}

interface CachedDefaultToolCard {
  signature: readonly unknown[];
  lines: RenderedLine[];
}

const defaultToolCards = new WeakMap<TranscriptEntry, CachedDefaultToolCard>();
const toolCardMetadataKeys = [
  "bytes",
  "cancelled",
  "count",
  "durationMs",
  "exitCode",
  "fullOutputPath",
  "height",
  "mediaType",
  "omitted",
  "replacements",
  "shownLines",
  "signal",
  "timedOut",
  "truncated",
  "width",
] as const;

function selectedToolInputSignature(
  input: Record<string, unknown>,
  keys: readonly string[],
): readonly unknown[] {
  return keys.flatMap((key) => [key, input[key]]);
}

function defaultToolInputSignature(entry: TranscriptEntry): readonly unknown[] {
  const input = toolInput(entry);
  if (input === undefined) return [];
  const name = entry.title ?? "";
  if (name === "read") {
    return selectedToolInputSignature(input, ["path", "file_path", "file", "directory", "offset", "limit"]);
  }
  if (name === "grep") {
    return selectedToolInputSignature(input, [
      "pattern", "query", "path", "file_path", "file", "directory", "glob", "limit",
    ]);
  }
  if (name === "find") {
    return selectedToolInputSignature(input, ["pattern", "path", "file_path", "file", "directory", "limit"]);
  }
  if (name === "ls") {
    return selectedToolInputSignature(input, ["path", "file_path", "file", "directory", "limit"]);
  }
  if (name === "bash" || name === "shell") {
    return selectedToolInputSignature(input, ["command", "timeout"]);
  }
  if (name === "write") {
    return selectedToolInputSignature(input, ["path", "file_path", "content"]);
  }
  if (name === "edit" || name === "apply_patch") {
    return selectedToolInputSignature(input, ["path", "file_path", "file", "directory"]);
  }
  return [JSON.stringify(input)];
}

function defaultToolCardSignature(
  entry: TranscriptEntry,
  width: number,
  theme: Theme,
  expandKeyHint: string | undefined,
): readonly unknown[] {
  const progress = entry.toolData?.progress;
  const partial = entry.toolData?.partialResult;
  const metadata = toolMetadata(entry);
  return [
    width,
    expandKeyHint,
    theme.ansi,
    theme.glyphs.assistant,
    theme.glyphs.user,
    theme.glyphs.tool,
    theme.glyphs.success,
    theme.glyphs.failure,
    theme.glyphs.pending,
    theme.glyphs.scroll,
    theme.glyphs.horizontal,
    entry.status,
    entry.title,
    entry.summary,
    entry.text,
    entry.inputPreview,
    entry.expanded === true,
    ...defaultToolInputSignature(entry),
    progress?.stdout,
    progress?.stderr,
    progress?.output,
    progress?.stdoutBytes,
    progress?.stderrBytes,
    progress?.elapsedMs,
    progress?.truncated,
    partial?.content,
    partial?.isError,
    partial?.truncated,
    ...toolCardMetadataKeys.map((key) => metadata?.[key]),
  ];
}

function equalToolCardSignatures(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function defaultToolCardLines(
  entry: TranscriptEntry,
  width: number,
  theme: Theme,
  expandKeyHint?: string,
): RenderedLine[] {
  const signature = defaultToolCardSignature(entry, width, theme, expandKeyHint);
  const cached = defaultToolCards.get(entry);
  if (cached !== undefined && equalToolCardSignatures(cached.signature, signature)) return cached.lines;

  const contentWidth = activityTimelinePadding(width).content;
  const content = compactToolLines(
    [
      entry.title === "shell" || entry.title === "bash"
        ? shellHeaderLine(entry, contentWidth)
        : toolHeaderLine(entry, contentWidth),
      ...defaultToolBodyLines(entry, contentWidth, theme, expandKeyHint),
    ],
    contentWidth,
  );
  const lines = toolCardLines(entry, content, width, theme);
  defaultToolCards.set(entry, { signature, lines });
  return lines;
}

function transcriptCardLines(lines: readonly RenderedLine[], width: number): RenderedLine[] {
  const paddingCells = toolCardPadding(width);
  const edge = " ".repeat(paddingCells.left);
  const padding: RenderedLine = {
    text: "",
    role: "muted",
    background: "customMessageBg",
    fill: true,
  };
  return [
    padding,
    ...lines.map((line): RenderedLine => ({
      ...line,
      text: line.spans === undefined ? `${edge}${truncateCells(line.text, paddingCells.content)}` : "",
      ...(line.spans === undefined
        ? {}
        : { spans: boundedSpans([{ text: edge, role: line.role }, ...line.spans], width - paddingCells.right) }),
      background: "customMessageBg",
      fill: true,
    })),
    padding,
  ];
}

function retainedMarkdownCardLines(value: string, width: number, maximumRows: number): RenderedLine[] {
  return retainedPreviewLines(
    retainedTextSample(value, width, 128 * 1024, maximumRows),
    width,
    RETAINED_CARD_ROW_MARKER,
    (selected) => renderMarkdownMessageLines("", selected, width, "assistant"),
    maximumRows,
  );
}

function compactionCardLines(
  entry: TranscriptEntry,
  width: number,
  theme: Theme,
  expandKeyHint?: string,
): RenderedLine[] {
  const expanded = entry.expanded === true;
  const title = [entry.title ?? "Context compacted", entry.compactText].filter(Boolean).join(" · ");
  const hint = expandKeyHint === undefined ? undefined : `${expandKeyHint} ${expanded ? "collapse" : "details"}`;
  const status = entry.status === "completed"
    ? { glyph: theme.glyphs.success, role: "success" as const }
    : entry.status === "failed"
      ? { glyph: theme.glyphs.failure, role: "error" as const }
      : entry.status === "in_doubt"
        ? { glyph: "!", role: "warning" as const }
        : { glyph: theme.glyphs.pending, role: "working" as const };
  const header: RenderedLine = {
    text: "",
    role: status.role,
    spans: boundedSpans([
      { text: `${status.glyph} `, role: status.role },
      { text: title, role: "title" },
      ...(hint === undefined ? [] : [
        { text: " · ", role: "muted" as const },
        { text: hint, role: "muted" as const },
      ]),
    ], width),
  };
  if (!expanded) return [header];

  const rail = width >= 3 ? `${theme.unicode ? "│" : "|"} ` : "";
  const contentWidth = Math.max(1, width - cellWidth(rail));
  const body: RenderedLine[] = [];
  if (entry.summary !== undefined && entry.summary !== entry.compactText) {
    body.push(...retainedPreviewLines(
      retainedTextSample(entry.summary, contentWidth, 64 * 1024, 20, "head"),
      contentWidth,
      RETAINED_HEAD_CARD_ROW_MARKER,
      (selected) => wrappedToolLines(selected, contentWidth, "muted"),
      20,
    ));
  }
  if (body.length > 0 && entry.text !== "") body.push({ text: "", role: "muted" });
  if (entry.text !== "") {
    body.push(...retainedMarkdownCardLines(
      entry.text,
      contentWidth,
      Math.max(1, EXPANDED_TOOL_DETAIL_MAX_ROWS - body.length),
    ));
  }
  return [
    header,
    ...body.map((line): RenderedLine => ({
      ...line,
      text: "",
      spans: boundedSpans([
        ...(rail === "" ? [] : [{ text: rail, role: "muted" as const }]),
        ...(line.spans ?? [{ text: line.text, role: line.role }]),
      ], width),
      viewportHeader: header,
    })),
  ];
}

function expandableCardLines(
  entry: TranscriptEntry,
  width: number,
  theme: Theme,
  expandKeyHint?: string,
): RenderedLine[] {
  if (entry.card === "compaction") return compactionCardLines(entry, width, theme, expandKeyHint);
  const contentWidth = toolCardPadding(width).content;
  const title = entry.card === "skill"
    ? `[skill] ${entry.summary ?? entry.compactText ?? ""}`.trimEnd()
    : [entry.title ?? "Summary", entry.compactText ?? entry.summary].filter(Boolean).join(" · ");
  const action = entry.expanded === true ? "collapse" : "expand";
  const heading = expandKeyHint === undefined ? title : `${title} · ${expandKeyHint} ${action}`;
  const lines: RenderedLine[] = [{ text: heading, role: entry.card === "skill" ? "accent" : entryRole(entry) }];
  if (entry.expanded === true && entry.text !== "") {
    lines.push(...retainedMarkdownCardLines(
      entry.card === "skill" && entry.summary !== undefined
        ? `**${entry.summary}**\n\n${entry.text}`
        : entry.text,
      contentWidth,
      EXPANDED_TOOL_DETAIL_MAX_ROWS,
    ));
  }
  return transcriptCardLines(lines, width);
}

function startupLines(value: string, width: number): RenderedLine[] {
  let firstContent = true;
  return value.split("\n").flatMap((source): RenderedLine[] => {
    if (source === "") return [{ text: "", role: "muted" }];
    const role: ThemeRole = firstContent || /^\[[^\]]+\]$/u.test(source.trim()) ? "accent" : "muted";
    firstContent = false;
    return wrapCells(source, width).map((text) => ({ text, role }));
  });
}

function retainedStartupLines(
  value: string,
  width: number,
  expanded: boolean,
  expandKeyHint?: string,
): RenderedLine[] {
  const maximumRows = expanded ? EXPANDED_TOOL_DETAIL_MAX_ROWS : 20;
  return retainedPreviewLines(
    retainedTextSample(
      value,
      width,
      expanded ? 128 * 1024 : 64 * 1024,
      maximumRows,
    ),
    width,
    expanded
      ? RETAINED_STARTUP_ROW_MARKER
      : toolExpandMarker(COLLAPSED_STARTUP_ROW_MARKER, expandKeyHint),
    (selected) => startupLines(selected, width),
    maximumRows,
    expanded ? undefined : expandKeyHint,
  );
}

function transcriptLines(
  entries: readonly TranscriptEntry[],
  width: number,
  theme: Theme,
  toolRenderBlocks?: ReadonlyMap<string, ToolRenderSlots>,
  sessionRenderBlocks?: ReadonlyMap<string, RuntimeUiBlock>,
  semanticZones = false,
  imageOptions: {
    resolveImage?: TranscriptRenderOptions["resolveImage"] | undefined;
    maxImageRows?: number | undefined;
    hiddenReasoningLabel?: string | undefined;
    hideReasoningBlock?: boolean | undefined;
    outputPad?: 0 | 1 | undefined;
    codeBlockIndent?: string | undefined;
    expandKeyHint?: string | undefined;
    thinkingKeyHint?: string | undefined;
    imageWidthCells?: number | undefined;
    activityFrame?: number | undefined;
    workingIndicator?: TuiWorkingIndicatorOptions | undefined;
    transformMarkdown?: TranscriptRenderOptions["transformMarkdown"] | undefined;
  } = {},
): RenderedLine[] {
  let imageCount = 0;
  let imageBytes = 0;
  const expandKeyHint = normalizedExpandKeyHint(
    Object.hasOwn(imageOptions, "expandKeyHint") ? imageOptions.expandKeyHint : "Ctrl+O",
  );
  const maxImageRows = Math.max(1, Math.min(200, imageOptions.maxImageRows ?? 12));
  const transformedMarkdown = (
    entry: TranscriptEntry,
    messageType: "user" | "assistant" | "assistant-thinking",
    availableWidth: number,
  ): string => {
    const source = messageType === "assistant-thinking" ? visibleReasoningText(entry.text) : entry.text;
    if (imageOptions.transformMarkdown === undefined) return source;
    try {
      const transformed = imageOptions.transformMarkdown(source, {
        messageType,
        isStreaming: entry.streaming === true,
        availableWidth,
      });
      return typeof transformed === "string" ? transformed : source;
    } catch {
      return source;
    }
  };
  const renderedImages = (entry: TranscriptEntry): RenderedLine[] => (entry.images ?? []).flatMap((image) => {
    const fallback = terminalImageFallback(image.block.mediaType);
    if (imageCount >= MAX_TERMINAL_IMAGE_COUNT) {
      return [{ text: `${fallback} — terminal preview limit reached`, role: "muted" }];
    }
    const resolved = imageOptions.resolveImage?.(image, {
      maxColumns: Math.max(1, Math.min(width - 2, imageOptions.imageWidthCells ?? 80)),
      maxRows: maxImageRows,
    }) ?? { fallback };
    if (resolved.image === undefined) return [{ text: resolved.fallback, role: "muted" }];
    if (imageBytes + resolved.image.bytes > MAX_TERMINAL_IMAGE_AGGREGATE_BYTES) {
      return [{ text: `${resolved.fallback} — terminal preview byte limit reached`, role: "muted" }];
    }
    const selectedImage = resolved.image;
    imageCount += 1;
    imageBytes += selectedImage.bytes;
    return [
      { text: resolved.fallback, role: "muted" },
      ...Array.from({ length: selectedImage.rows }, (_, imageOffset): RenderedLine => ({
        text: "",
        role: "muted",
        image: selectedImage,
        imageOffset,
      })),
    ];
  });
  const sharesSourceMessage = (left: TranscriptEntry | undefined, right: TranscriptEntry | undefined): boolean =>
    left?.sourceMessageId !== undefined && left.sourceMessageId === right?.sourceMessageId;
  const sameReasoningRun = (left: TranscriptEntry | undefined, right: TranscriptEntry | undefined): boolean =>
    left?.kind === "reasoning"
    && right?.kind === "reasoning"
    && (sharesSourceMessage(left, right)
      || (left.sourceMessageId === undefined && right.sourceMessageId === undefined));
  const sourceMessageGroups = new Map<string, {
    narratives: TranscriptEntry[];
    toolBearing: boolean;
  }>();
  for (const [candidateIndex, candidate] of entries.entries()) {
    const sourceMessageId = candidate.sourceMessageId;
    if (sourceMessageId === undefined) continue;
    const group = sourceMessageGroups.get(sourceMessageId) ?? { narratives: [], toolBearing: false };
    if (candidate.kind === "assistant" && (candidate.text !== "" || (candidate.images?.length ?? 0) > 0)) {
      group.narratives.push(candidate);
    }
    if (candidate.kind === "reasoning" && !sameReasoningRun(entries[candidateIndex - 1], candidate)) {
      let reasoningText = "";
      for (let offset = candidateIndex; offset < entries.length; offset += 1) {
        const selected = entries[offset];
        if (selected?.kind !== "reasoning" || (offset > candidateIndex && !sameReasoningRun(entries[offset - 1], selected))) break;
        reasoningText += visibleReasoningText(selected.text);
      }
      const reasoningVisible = imageOptions.hideReasoningBlock === true
        || candidate.streaming === true
        || candidate.expanded === true
        || reasoningText.trim() !== "";
      if (reasoningVisible) group.narratives.push(candidate);
    }
    if (candidate.kind === "tool" || candidate.hasToolCalls === true) group.toolBearing = true;
    sourceMessageGroups.set(sourceMessageId, group);
  }
  return entries.flatMap((entry, index) => {
    const rendered = ((): RenderedLine[] => {
    const prefix = entryPrefix(
      entry,
      theme,
      entry.kind === "reasoning" && imageOptions.hideReasoningBlock === true
        ? imageOptions.hiddenReasoningLabel ?? "Thinking..."
        : imageOptions.hiddenReasoningLabel,
    );
    const role = entryRole(entry);
    const previous = entries[index - 1];
    const sameNarrativeMessage = sharesSourceMessage(previous, entry)
      && (previous?.kind === "assistant" || previous?.kind === "reasoning")
      && (entry.kind === "assistant" || entry.kind === "reasoning");
    const separator: RenderedLine[] = sameNarrativeMessage || (index === 0
      && entry.kind !== "tool"
      && entry.kind !== "assistant"
      && entry.kind !== "reasoning")
      ? [] : [{ text: "", role: "muted" }];
    const withSemanticZone = (lines: RenderedLine[], start = true, end = true): RenderedLine[] => {
      if (lines.length === 0) return lines;
      const selected = lines.map((line) => ({ ...line }));
      if (start) selected[0]!.messageStart = true;
      if (semanticZones) {
        if (start) selected[0]!.semanticZoneStart = true;
        if (end) selected[selected.length - 1]!.semanticZoneEnd = true;
      }
      return selected;
    };
    const narrativeZone = (): { start: boolean; end: boolean; enabled: boolean } => {
      const sourceMessageId = entry.sourceMessageId;
      const group = sourceMessageId === undefined ? undefined : sourceMessageGroups.get(sourceMessageId);
      const narratives = group?.narratives ?? [entry];
      return {
        start: narratives[0] === entry,
        end: narratives.at(-1) === entry,
        enabled: group?.toolBearing !== true,
      };
    };
    if (entry.kind === "startup") {
      const expanded = entry.expanded === true;
      return [
        ...separator,
        ...retainedStartupLines(
          expanded ? entry.text : entry.compactText ?? entry.text,
          width,
          expanded,
          expandKeyHint,
        ),
      ];
    }
    if (entry.kind === "user") {
      const outputPad = imageOptions.outputPad ?? 1;
      const availableWidth = Math.max(1, width - (2 * outputPad));
      const images = renderedImages(entry);
      const markdown = entry.text === "" ? "" : transformedMarkdown(entry, "user", availableWidth);
      const promptLines = entry.text === ""
        ? images.length === 0 ? [] : imageOnlyUserMessageLines(images, width, outputPad)
        : entry.streaming !== true
          ? stableTranscriptEntryLines(
              cachedUserLines,
              entry,
              [markdown, width, outputPad],
              () => userMessageLines(markdown, width, outputPad),
            )
          : userMessageLines(
              markdown,
              width,
              outputPad,
            );
      const lines = entry.text === "" ? promptLines : [...promptLines, ...images];
      const rendered = [...separator, ...withSemanticZone(lines)];
      const owningPrompt = entry.text === "" ? undefined : owningPromptPreview(entry, markdown);
      if (rendered[0] !== undefined) {
        rendered[0] = {
          ...rendered[0],
          owningPromptBoundary: true,
          ...(owningPrompt === undefined ? {} : { owningPromptStart: owningPrompt }),
        };
      }
      return rendered;
    }
    if (entry.kind === "reasoning" && imageOptions.hideReasoningBlock === true) {
      if (sameReasoningRun(previous, entry)) return [];
      const lines = [{ text: `${" ".repeat(imageOptions.outputPad ?? 0)}${prefix.trimEnd()}`, role: "muted" as const }];
      const zone = narrativeZone();
      return [
        ...separator,
        ...(zone.enabled ? withSemanticZone(lines, zone.start, zone.end) : lines),
      ];
    }
    if (entry.kind === "reasoning") {
      if (sameReasoningRun(previous, entry)) return [];
      const run: TranscriptEntry[] = [];
      for (let offset = index; offset < entries.length; offset += 1) {
        const selected = entries[offset];
        if (selected?.kind !== "reasoning" || (offset > index && !sameReasoningRun(entries[offset - 1], selected))) break;
        run.push(selected);
      }
      const source = run.map((item) => visibleReasoningText(item.text).trim()).filter(Boolean).join("\n\n");
      const streaming = run.some((item) => item.streaming === true);
      const expanded = run.some((item) => item.expanded === true);
      const availableWidth = Math.max(1, width - 4);
      let transformed = source;
      if (source !== "" && imageOptions.transformMarkdown !== undefined) {
        try {
          const selected = imageOptions.transformMarkdown(source, {
            messageType: "assistant-thinking",
            isStreaming: streaming,
            availableWidth,
          });
          if (typeof selected === "string") transformed = selected;
        } catch {
          // Display transformations are isolated from transcript rendering.
        }
      }
      const body = source === "" || !expanded
        ? []
        : stableTranscriptEntryLines(
          cachedReasoningBodyLines,
          entry,
          [
            transformed,
            availableWidth,
            width,
            theme,
            theme.unicode,
            imageOptions.codeBlockIndent ?? "",
            expanded,
          ],
          () => reasoningBlockBody(retainedPreviewLines(
            retainedTextSample(transformed, availableWidth, RETAINED_REASONING_MAX_BYTES),
            availableWidth,
            RETAINED_REASONING_ROW_MARKER,
            (selected) => renderMarkdownMessageLines(
              "",
              selected,
              availableWidth,
              "info",
              undefined,
              { codeBlockIndent: imageOptions.codeBlockIndent ?? "" },
            ),
          ), width, theme),
        );
      const header = reasoningBlockHeader(
        run,
        width,
        theme,
        expanded,
        imageOptions.thinkingKeyHint,
        imageOptions.workingIndicator,
        imageOptions.activityFrame,
      );
      const lines = [
        header,
        ...body.map((line): RenderedLine => ({ ...line, viewportHeader: header })),
        { ...reasoningBlockBottom(width, theme), viewportHeader: header },
        ...run.flatMap((item) => renderedImages(item)),
      ];
      const zone = narrativeZone();
      return [...separator, ...(zone.enabled ? withSemanticZone(lines, zone.start, zone.end) : lines)];
    }
    if (entry.kind === "assistant") {
      const outputPad = imageOptions.outputPad ?? 0;
      const availableWidth = Math.max(1, width - (2 * outputPad));
      const messagePrefix = `${" ".repeat(outputPad)}${prefix}`;
      const messageWidth = Math.max(1, width - outputPad);
      const markdown = entry.text === "" ? "" : transformedMarkdown(entry, "assistant", availableWidth);
      const messageLines = entry.text === ""
        ? []
        : stableTranscriptEntryLines(
          cachedAssistantLines,
          entry,
          [markdown, messagePrefix, messageWidth, role, imageOptions.codeBlockIndent ?? ""],
          () => renderMarkdownMessageLines(
            messagePrefix,
            markdown,
            messageWidth,
            role,
            undefined,
            { codeBlockIndent: imageOptions.codeBlockIndent ?? "" },
          ),
        );
      const lines = [
        ...messageLines,
        ...renderedImages(entry),
      ];
      if (lines.length === 0) return [];
      const sourceMessageId = entry.sourceMessageId;
      const group = sourceMessageId === undefined ? undefined : sourceMessageGroups.get(sourceMessageId);
      const toolBearing = group?.toolBearing === true
        || (sourceMessageId === undefined && (entry.hasToolCalls === true || entries[index + 1]?.kind === "tool"));
      const narrativeEntries = group?.narratives ?? [entry];
      const firstNarrative = narrativeEntries[0] === entry;
      const lastNarrative = narrativeEntries.at(-1) === entry;
      return [
        ...separator,
        ...(!toolBearing ? withSemanticZone(lines, firstNarrative, lastNarrative) : lines),
      ];
    }
    if (entry.card !== undefined) {
      return [
        ...separator,
        ...expandableCardLines(
          entry,
          width,
          theme,
          entry.card === "skill" || entry.card === "compaction" ? expandKeyHint : undefined,
        ),
        ...renderedImages(entry),
      ];
    }
    if (entry.extension !== undefined) {
      const custom = structuralLines(sessionRenderBlocks?.get(entry.id), width);
      if (custom !== undefined) return [...separator, ...custom, ...renderedImages(entry)];
      const label = entry.extension.customType;
      const fallback = entry.expandable === true && entry.expanded !== true
        ? label
        : entry.text === "" ? label : `${label}: ${entry.text}`;
      const fallbackLines = entry.expandable === true && entry.expanded === true
        ? retainedExtensionFallbackLines(prefix, fallback, width, role)
        : hangingLines(prefix, fallback, width, role);
      return [...separator, ...fallbackLines, ...renderedImages(entry)];
    }
    if (entry.kind !== "tool") return [
      ...separator,
      ...stableTranscriptEntryLines(
        cachedHangingLines,
        entry,
        [prefix, entry.text, width, role],
        () => hangingLines(prefix, entry.text, width, role),
      ),
      ...renderedImages(entry),
    ];
    const toolImages = renderedImages(entry);
    const spacedToolImages: RenderedLine[] = toolImages.length === 0
      ? []
      : [{ text: "", role: "muted" }, ...toolImages];
    const custom = entry.callId === undefined ? undefined : toolRenderBlocks?.get(entry.callId);
    if (custom === undefined) {
      return [
        ...separator,
        ...defaultToolCardLines(entry, width, theme, expandKeyHint),
        ...spacedToolImages,
      ];
    }
    const shell = custom.shell ?? "default";
    const contentWidth = shell === "self" ? width : activityTimelinePadding(width).content;
    const headerLine = toolHeaderLine(entry, contentWidth);
    const customCall = structuralLines(custom?.call, contentWidth);
    const customResult = structuralLines(custom?.result, contentWidth);
    let defaultBody: RenderedLine[] | undefined;
    const body = (): RenderedLine[] => {
      if (defaultBody !== undefined) return defaultBody;
      defaultBody = defaultToolBodyLines(entry, contentWidth, theme, expandKeyHint);
      return defaultBody;
    };
    if (shell === "self") {
      const callLines = customCall ?? [headerLine];
      const resultLines = customResult ?? body();
      const selected = [...callLines, ...resultLines, ...spacedToolImages];
      return selected.length === 0 ? [] : [...separator, ...selected];
    }
    return [
      ...separator,
      ...toolCardLines(entry, [
        ...(customCall ?? [headerLine]),
        ...(customResult ?? body()),
      ], width, theme),
      ...spacedToolImages,
    ];
    })();
    const durable = !(
      (entry.kind === "status" || entry.kind === "error")
      && entry.id.startsWith("local:")
    );
    return rendered.map((line, renderedRow) => ({
      ...line,
      transcriptAnchor: { entryId: entry.id, renderedRow, durable },
    }));
  });
}

function editorBlock(
  text: string,
  cursor: number,
  _label: string,
  width: number,
  maximumLines: number,
  _theme: Theme,
  paddingX = 0,
): EditorBlock {
  const edge = " ".repeat(paddingX);
  const contentWidth = Math.max(1, width - (paddingX * 2) - 1);
  const prefix = edge;
  const continuation = edge;
  const graphemes = splitGraphemes(text);
  const lines: string[] = [prefix];
  let row = 0;
  let column = cellWidth(prefix);
  let cursorRow = 0;
  let cursorColumn = column;
  const indentation = cellWidth(continuation);

  const nextLine = () => {
    lines.push(continuation);
    row += 1;
    column = cellWidth(continuation);
  };

  for (let index = 0; index < graphemes.length; index += 1) {
    const grapheme = graphemes[index] ?? "";
    const previous = graphemes[index - 1];
    const startsWord = grapheme !== "\n" && !/^\s$/u.test(grapheme)
      && (index === 0 || previous === "\n" || /^\s$/u.test(previous ?? ""));
    if (startsWord && column > indentation) {
      let wordWidth = 0;
      for (let offset = index; offset < graphemes.length; offset += 1) {
        const selected = graphemes[offset] ?? "";
        if (selected === "\n" || /^\s$/u.test(selected)) break;
        wordWidth += graphemeWidth(selected);
      }
      if (column + wordWidth > contentWidth) {
        const current = lines[row] ?? "";
        const trimmed = current.replace(/ +$/u, "");
        column -= cellWidth(current) - cellWidth(trimmed);
        lines[row] = trimmed;
        nextLine();
      }
    }
    if (index === cursor) {
      if (column >= contentWidth) nextLine();
      cursorRow = row;
      cursorColumn = column;
    }
    if (grapheme === "\n") {
      nextLine();
      continue;
    }
    const next = graphemeWidth(grapheme);
    if (grapheme === " " && column + next > contentWidth) {
      nextLine();
      continue;
    }
    if (column > cellWidth(continuation) && column + next > contentWidth) nextLine();
    lines[row] = `${lines[row] ?? ""}${grapheme}`;
    column += next;
  }
  if (cursor === graphemes.length) {
    if (column >= contentWidth) nextLine();
    cursorRow = row;
    cursorColumn = column;
  }

  const start = Math.max(0, Math.min(cursorRow - maximumLines + 1, lines.length - maximumLines));
  const selected = lines.slice(start, start + maximumLines);
  return {
    lines: selected.map((line) => ({ text: line, role: "accent" as const })),
    cursor: {
      row: cursorRow - start,
      column: Math.max(0, Math.min(width - 1, cursorColumn)),
    },
  };
}

function composerGraphEdge(width: number, theme: Theme, edge: "top" | "bottom"): string {
  void edge;
  return theme.glyphs.horizontal.repeat(Math.max(0, width));
}

interface OverlayRender {
  lines: RenderedLine[];
  cursor: { row: number; column: number };
}

function tailCells(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  const safe = sanitizeTerminalText(value).replaceAll("\n", " ");
  if (cellWidth(safe) <= maximum) return safe;
  const selected: string[] = [];
  let width = 0;
  const graphemes = splitGraphemes(safe);
  for (let index = graphemes.length - 1; index >= 0; index -= 1) {
    const grapheme = graphemes[index]!;
    const next = graphemeWidth(grapheme);
    if (width + next > maximum) break;
    selected.push(grapheme);
    width += next;
  }
  return selected.reverse().join("");
}

function pickerItemText(item: PickerItem, maximum: number, selected: boolean): string {
  const detail = item.detail === undefined ? "" : ` — ${item.detail}`;
  const complete = `${item.label}${detail}`;
  if (!selected || item.tree === undefined || cellWidth(complete) <= maximum) return truncateCells(complete, maximum);
  const active = item.tree.active ? item.label.startsWith("●") ? "● " : "* " : "  ";
  const available = Math.max(0, maximum - cellWidth(active) - 1);
  return `${active}…${tailCells(item.label, available)}`;
}

function deckFrame(
  overlay: NonNullable<TuiViewState["overlay"]>,
  content: readonly RenderedLine[],
  cursor: { row: number; column: number },
  width: number,
  height: number,
  border: string,
): OverlayRender {
  if (width < 4 || height < 2) return {
    lines: content.slice(0, Math.max(1, height)).map((line) => ({ ...line, text: truncateCells(line.text, width) })),
    cursor: { row: Math.max(0, Math.min(height - 1, cursor.row)), column: Math.max(0, Math.min(width - 1, cursor.column)) },
  };
  const innerWidth = width;
  const count = overlay.items.length === 0 ? "0" : `${overlay.selected + 1}/${overlay.items.length}`;
  const title = sanitizeTerminalText(overlay.title).replaceAll("\n", " ");
  const label = truncateCells(`[ ${title} · ${count} ]`, Math.max(1, innerWidth - 3));
  const top: RenderedLine = {
    text: `${border.repeat(2)} ${label} ${border.repeat(Math.max(0, innerWidth - cellWidth(label) - 4))}`,
    role: "accent",
  };
  const selected = content.slice(0, Math.max(0, height - 2)).map((line): RenderedLine => ({
    text: padCells(line.text, innerWidth),
    role: line.role,
    fill: true,
  }));
  const bottom: RenderedLine = { text: border.repeat(innerWidth), role: "accent" };
  const lines = [top, ...selected, bottom].slice(0, height);
  return {
    lines,
    cursor: {
      row: Math.max(0, Math.min(lines.length - 1, cursor.row + 1)),
      column: Math.max(0, Math.min(width - 1, cursor.column)),
    },
  };
}

function deckSeparator(): RenderedLine {
  return { text: "", role: "muted" };
}

function deckStatus(overlay: NonNullable<TuiViewState["overlay"]>, width: number): RenderedLine[] {
  const states = overlay.states?.filter((state) => state.trim() !== "").join(" · ") ?? "";
  return [states, overlay.status ?? ""]
    .filter((value) => value !== "")
    .flatMap((value) => wrapCells(value, width).map((text): RenderedLine => ({ text, role: "muted" })));
}

function actionLines(
  overlay: NonNullable<TuiViewState["overlay"]>,
  width: number,
  fallback: string,
  maximumLines = 5,
): RenderedLine[] {
  const hints = overlay.hints === undefined || overlay.hints.length === 0 ? [fallback] : [...overlay.hints];
  const parts = hints.flatMap((hint) => hint.split(/\s+·\s+/u))
    .map((part) => part.trim()
      .replace(/\bUp\/Down\b/gu, "↑/↓")
      .replace(/\bLeft\/Right\b/gu, "←/→")
      .replace(/\bAlt\+Up\/Alt\+Down\b/gu, "Alt+↑/↓")
      .replace(/\bCtrl\+Up\/Ctrl\+Down\b/gu, "Ctrl+↑/↓"))
    .filter(Boolean);
  const rows: string[] = [];
  for (const part of parts) {
    const current = rows.at(-1);
    const candidate = current === undefined ? part : `${current} · ${part}`;
    if (current !== undefined && cellWidth(` ${candidate}`) <= width) rows[rows.length - 1] = candidate;
    else rows.push(part);
  }
  if (rows.length > maximumLines) {
    if (maximumLines === 1) {
      const primary = parts.find((part) => /\b(?:change|select|open|save|delete|next)\b/iu.test(part));
      const dismissal = parts.find((part) => /\b(?:cancel|close)\b/iu.test(part));
      if (primary !== undefined && dismissal !== undefined && primary !== dismissal) {
        const compactPrimary = primary.replace(/Enter\/Space\/Right to change/giu, "Enter/Space change");
        const suffix = ` · ${dismissal}`;
        const primaryWidth = width - 1 - cellWidth(suffix);
        if (primaryWidth > 0) rows.splice(0, rows.length, `${truncateCells(compactPrimary, primaryWidth)}${suffix}`);
      }
    }
  }
  if (rows.length > maximumLines) {
    const dismissal = rows.findLast((row) => /\b(?:cancel|close)\b/iu.test(row));
    const candidates = rows.filter((row) => row !== dismissal);
    const preferred = candidates.filter((row) => /\b(?:navigate|page|change|toggle|select|open|save|delete|next)\b/iu.test(row));
    const keep = Math.max(0, maximumLines - (dismissal === undefined ? 0 : 1));
    const chosen = [...preferred, ...candidates.filter((row) => !preferred.includes(row))].slice(0, keep);
    rows.splice(0, rows.length, ...chosen, ...(dismissal === undefined ? [] : [dismissal]));
  }
  return rows.map((text): RenderedLine => ({ text: truncateCells(` ${text}`, width), role: "muted" }));
}

function overlayLines(
  overlay: NonNullable<TuiViewState["overlay"]>,
  width: number,
  height: number,
  border = "─",
): OverlayRender {
  const innerWidth = width;
  const innerHeight = Math.max(1, height - 2);
  const queryPrefix = "SEARCH  ";
  const query = truncateCells(overlay.query.replaceAll("\n", " "), Math.max(1, innerWidth - cellWidth(queryPrefix)));
  const top: RenderedLine[] = deckStatus(overlay, innerWidth);
  const queryRow = top.length;
  top.push({ text: `${queryPrefix}${query}`, role: "accent" });
  const selectedItem = overlay.items[overlay.selected];
  const detail = selectedItem?.description ?? selectedItem?.detail;
  const showRegions = innerHeight >= 7;
  const actions = actionLines(
    overlay,
    innerWidth,
    "Up/Down navigate · Enter select · Esc cancel",
    Math.min(5, Math.max(1, innerHeight - top.length - (showRegions ? 2 : 0) - 1)),
  );
  const detailLines = detail === undefined || innerHeight < 8
    ? []
    : wrapCells(`DETAIL  ${detail}`, innerWidth).slice(0, 2).map((text): RenderedLine => ({ text, role: "muted" }));
  const dividerCount = showRegions ? 2 + (detailLines.length > 0 ? 1 : 0) : 0;
  const contentRoom = Math.max(1, innerHeight - top.length - actions.length - detailLines.length - dividerCount);
  const visibleRoom = Math.max(1, Math.min(contentRoom, overlay.maxVisible ?? contentRoom));
  const content: RenderedLine[] = [];
  if (overlay.items.length === 0) {
    content.push(...wrapCells(` ${overlay.emptyMessage ?? "No matches"}`, innerWidth).slice(0, visibleRoom).map((text) => ({
      text,
      role: "muted" as const,
    })));
  } else {
    const start = Math.max(0, Math.min(overlay.selected - visibleRoom + 1, overlay.items.length - visibleRoom));
    for (const [offset, item] of overlay.items.slice(start, start + visibleRoom).entries()) {
      const index = start + offset;
      const selected = index === overlay.selected;
      const { detail: _detail, ...labelItem } = item;
      content.push({
        text: `${selected ? (border === "─" ? "›" : ">") : " "} ${pickerItemText(labelItem, Math.max(1, innerWidth - 2), selected)}`,
        role: selected ? "selection" : "muted",
      });
    }
  }
  const body = [
    ...top,
    ...(showRegions ? [deckSeparator()] : []),
    ...content,
    ...(detailLines.length === 0 ? [] : [deckSeparator(), ...detailLines]),
    ...(showRegions ? [deckSeparator()] : []),
    ...actions,
  ];
  return deckFrame(
    overlay,
    body,
    { row: queryRow, column: Math.min(innerWidth - 1, cellWidth(queryPrefix) + cellWidth(query)) },
    width,
    height,
    border,
  );
}

function settingsOverlayLines(
  overlay: NonNullable<TuiViewState["overlay"]>,
  width: number,
  height: number,
  border: string,
): OverlayRender {
  const innerWidth = width;
  const innerHeight = Math.max(1, height - 2);
  const queryPrefix = "SEARCH  ";
  const query = truncateCells(overlay.query.replaceAll("\n", " "), Math.max(1, innerWidth - cellWidth(queryPrefix)));
  const top: RenderedLine[] = deckStatus(overlay, innerWidth);
  const queryRow = top.length;
  top.push({ text: `${queryPrefix}${query}`, role: "accent" });
  const showRegions = innerHeight >= 7;
  const actions = actionLines(
    overlay,
    innerWidth,
    "Enter/Space change · Esc close",
    Math.min(5, Math.max(1, innerHeight - top.length - (showRegions ? 2 : 0) - Math.min(2, Math.max(1, overlay.items.length)))),
  );
  const descriptionRoom = overlay.selectedDescription === undefined || innerHeight < 8 ? 0 : Math.min(2, Math.max(0, innerHeight - top.length - actions.length - 4));
  const dividerCount = showRegions ? 2 + (descriptionRoom > 0 ? 1 : 0) : 0;
  const contentRoom = Math.max(1, innerHeight - top.length - actions.length - descriptionRoom - dividerCount);
  const visible = Math.max(1, Math.min(10, contentRoom));
  const start = Math.max(0, Math.min(overlay.selected - visible + 1, overlay.items.length - visible));
  const shown = overlay.items.slice(start, start + visible);
  const labelWidth = Math.min(Math.max(12, innerWidth - 10), Math.max(12, ...shown.map((item) => cellWidth(item.label))));
  const content: RenderedLine[] = [];
  if (shown.length === 0) content.push({ text: " No matching settings", role: "muted" });
  for (const [offset, item] of shown.entries()) {
    const index = start + offset;
    const marker = index === overlay.selected ? "→" : " ";
    const label = padCells(truncateCells(item.label, labelWidth), labelWidth);
    content.push({
      text: truncateCells(`${marker} ${label}  ${item.detail ?? ""}`, innerWidth),
      role: index === overlay.selected ? "selection" : "muted",
    });
  }
  if (descriptionRoom > 0 && overlay.selectedDescription !== undefined) {
    content.push(...wrapCells(`DETAIL  ${overlay.selectedDescription}`, innerWidth).slice(0, descriptionRoom).map((text) => ({
      text,
      role: "muted" as const,
    })));
  }
  const selectedContent = content.slice(0, shown.length === 0 ? 1 : shown.length);
  const details = content.slice(selectedContent.length);
  return deckFrame(overlay, [
    ...top,
    ...(showRegions ? [deckSeparator()] : []),
    ...selectedContent,
    ...(details.length === 0 ? [] : [deckSeparator(), ...details]),
    ...(showRegions ? [deckSeparator()] : []),
    ...actions,
  ], {
    row: queryRow,
    column: Math.min(innerWidth - 1, cellWidth(queryPrefix) + cellWidth(query)),
  }, width, height, border);
}

function modelOverlayLines(
  overlay: NonNullable<TuiViewState["overlay"]>,
  width: number,
  height: number,
  border: string,
): OverlayRender {
  const innerWidth = width;
  const innerHeight = Math.max(1, height - 2);
  const queryPrefix = "SEARCH  ";
  const query = truncateCells(overlay.query.replaceAll("\n", " "), Math.max(1, innerWidth - 2));
  const top: RenderedLine[] = deckStatus(overlay, innerWidth);
  const queryRow = top.length;
  top.push({ text: `${queryPrefix}${query}`, role: "accent" });
  const selected = overlay.items[overlay.selected];
  const showRegions = innerHeight >= 7;
  const actions = actionLines(
    overlay,
    innerWidth,
    "Up/Down navigate · Enter select · Esc cancel",
    Math.min(5, Math.max(1, innerHeight - top.length - (showRegions ? 2 : 0) - 1)),
  );
  const detailRoom = selected?.detail === undefined || innerHeight < 8 ? 0 : Math.min(2, Math.max(0, innerHeight - top.length - actions.length - 4));
  const dividerCount = showRegions ? 2 + (detailRoom > 0 ? 1 : 0) : 0;
  const contentRoom = Math.max(1, innerHeight - top.length - actions.length - detailRoom - dividerCount);
  const start = Math.max(0, Math.min(overlay.selected - contentRoom + 1, overlay.items.length - contentRoom));
  const content: RenderedLine[] = [];
  if (overlay.items.length === 0) {
    content.push(...wrapCells(` ${overlay.emptyMessage ?? "No matching models"}`, innerWidth).slice(0, contentRoom).map((text) => ({
      text,
      role: "muted" as const,
    })));
  }
  for (const [offset, item] of overlay.items.slice(start, start + contentRoom).entries()) {
    const index = start + offset;
    content.push({
      text: `${index === overlay.selected ? (border === "─" ? "›" : ">") : " "} ${truncateCells(item.label, Math.max(1, innerWidth - 2))}`,
      role: index === overlay.selected ? "selection" : "muted",
    });
  }
  const details: RenderedLine[] = [];
  if (detailRoom > 0 && selected?.detail !== undefined) {
    details.push(...wrapCells(`DETAIL  ${selected.detail}`, innerWidth).slice(0, detailRoom).map((text) => ({
      text,
      role: "muted" as const,
    })));
  }
  return deckFrame(overlay, [
    ...top,
    ...(showRegions ? [deckSeparator()] : []),
    ...content,
    ...(details.length === 0 ? [] : [deckSeparator(), ...details]),
    ...(showRegions ? [deckSeparator()] : []),
    ...actions,
  ], {
    row: queryRow,
    column: Math.min(innerWidth - 1, cellWidth(queryPrefix) + cellWidth(query)),
  }, width, height, border);
}

function inlineCommandLines(
  overlay: NonNullable<TuiViewState["overlay"]>,
  width: number,
): RenderedLine[] {
  if (overlay.items.length === 0) return [{ text: "  No matching commands", role: "muted" }];
  const visible = Math.min(5, overlay.items.length);
  const start = Math.max(0, Math.min(overlay.selected - visible + 1, overlay.items.length - visible));
  const selected = overlay.items.slice(start, start + visible);
  const maximumLabel = Math.min(30, Math.max(8, ...selected.map((item) => cellWidth(item.label))));
  const lines = selected.map((item, offset): RenderedLine => {
    const index = start + offset;
    const marker = index === overlay.selected ? "→" : " ";
    const label = padCells(truncateCells(item.label, maximumLabel), maximumLabel);
    const detail = item.detail === undefined ? "" : `  ${item.detail}`;
    return {
      text: truncateCells(`${marker} ${label}${detail}`, width),
      role: index === overlay.selected ? "selection" : "muted",
    };
  });
  lines.push({ text: `  (${overlay.selected + 1}/${overlay.items.length})`, role: "muted" });
  return lines;
}

export function formatFooterTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

function footerWorkspace(workspace: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home === undefined) return workspace;
  const resolvedWorkspace = resolve(workspace);
  const resolvedHome = resolve(home);
  const fromHome = relative(resolvedHome, resolvedWorkspace);
  const insideHome = fromHome === ""
    || (fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome));
  if (!insideHome) return workspace;
  return fromHome === "" ? "~" : `~/${fromHome.split(sep).join("/")}`;
}

function footerPromptLowerBound(usage: NonNullable<TuiViewState["usage"]>): number | undefined {
  if (usage.reportedPromptInputTokens !== undefined) return usage.reportedPromptInputTokens;
  const reported = usage.reportedTotal ?? usage.total;
  const values = [reported.inputTokens, reported.cacheReadTokens, reported.cacheWriteTokens]
    .filter((value): value is number => value !== undefined);
  if (values.length === 0) return undefined;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : undefined;
}

function footerStatChips(
  view: TuiViewState,
  theme: Theme,
): { tokens: string[]; cost?: string; context?: string; contextWithMeter?: string } {
  const usage = view.usage?.total;
  const reportedUsage = view.usage?.reportedTotal;
  const tokens: string[] = [];
  const promptInputTokens = view.usage?.promptInputTokens ?? (usage === undefined
    ? undefined
    : normalizedContextTokens(usage));
  const promptInputLowerBound = view.usage === undefined ? undefined : footerPromptLowerBound(view.usage);
  if (promptInputTokens !== undefined) {
    tokens.push(`in ${formatFooterTokens(promptInputTokens)}`);
  } else if (promptInputLowerBound !== undefined) {
    tokens.push(`in ${formatFooterTokens(promptInputLowerBound)}`);
  }
  if (usage?.outputTokens !== undefined) {
    tokens.push(`out ${formatFooterTokens(usage.outputTokens)}`);
  } else if (reportedUsage?.outputTokens !== undefined) {
    tokens.push(`out ${formatFooterTokens(reportedUsage.outputTokens)}`);
  }
  if (usage !== undefined) {
    const hitRate = view.usage?.latestCacheHitRate;
    tokens.push(hitRate === undefined ? "last cache n/a" : `last cache ${hitRate.toFixed(1)}%`);
  }
  const numericCost = usage?.cost?.total ?? 0;
  const cost = numericCost > 0 || view.context.subscription === true
    ? `${formatUsageCost(usage?.cost, 3) ?? "$0"}${view.context.subscription === true ? " sub" : ""}`
    : undefined;
  const contextWindow = view.context.contextWindowTokens ?? 0;
  let context: string | undefined;
  let contextWithMeter: string | undefined;
  if (contextWindow > 0) {
    const numericPercent = view.context.contextTokens === undefined
      ? undefined
      : Math.min(999, view.context.contextTokens / contextWindow * 100);
    const percent = numericPercent === undefined
      ? "?"
      : numericPercent.toFixed(1);
    context = `ctx ${percent}%/${formatFooterTokens(contextWindow)}`;
    const meterWidth = 8;
    const filled = numericPercent === undefined
      ? 0
      : Math.max(0, Math.min(meterWidth, Math.round(numericPercent / 100 * meterWidth)));
    const full = theme.unicode ? "█" : "#";
    const empty = theme.unicode ? "░" : "-";
    contextWithMeter = `ctx [${full.repeat(filled)}${empty.repeat(meterWidth - filled)}] ${percent}%/${formatFooterTokens(contextWindow)}`;
  }
  return {
    tokens,
    ...(cost === undefined ? {} : { cost }),
    ...(context === undefined ? {} : { context }),
    ...(contextWithMeter === undefined ? {} : { contextWithMeter }),
  };
}

function activityText(view: TuiViewState, width: number): string | undefined {
  const activity = view.context.activity;
  if (activity === undefined || view.context.active !== true || view.context.workingVisible === false) return undefined;
  const now = Date.now();
  const spinner = workingSpinner(view.workingIndicator, view.context.activityFrame);
  const retryDelay = activity.retryAt === undefined
    ? undefined
    : `${(Math.max(0, activity.retryAt - now) / 1_000).toFixed(1)}s`;
  const retry = retryDelay === undefined
    ? undefined
    : `${activity.attempt === undefined ? "retry" : `attempt ${activity.attempt}`} in ${retryDelay}`;
  const phase = sanitizeTerminalText(activity.phase);
  const configuredMessage = view.context.workingMessage === undefined
    ? undefined
    : sanitizeTerminalText(view.context.workingMessage).trim();
  const message = configuredMessage === undefined || configuredMessage === "" ? phase : configuredMessage;
  const elapsed = Number.isFinite(activity.startedAt)
    ? elapsedText(Math.max(0, now - activity.startedAt))
    : undefined;
  const primary = spinner === undefined ? message : `${spinner} ${message}`;
  const cancel = activity.cancellable === true ? "Esc to cancel" : undefined;
  const full = [primary, elapsed, retry, cancel]
    .filter((value): value is string => value !== undefined && value !== "")
    .join(" · ");
  if (cellWidth(full) <= width) return full;

  const fits = (...details: Array<string | undefined>): boolean => cellWidth([
    primary,
    ...details.filter((value): value is string => value !== undefined && value !== ""),
  ].join(" · ")) <= width;
  const compactRetry = retry === undefined ? undefined : `in ${retryDelay}`;
  const selectedRetry = retry === undefined
    ? undefined
    : elapsed !== undefined && fits(elapsed, retry)
      ? retry
      : elapsed !== undefined && fits(elapsed, compactRetry)
        ? compactRetry
        : fits(retry)
          ? retry
          : fits(compactRetry)
            ? compactRetry
            : undefined;
  const selectedElapsed = elapsed !== undefined && fits(elapsed, selectedRetry) ? elapsed : undefined;
  const selectedCancel = cancel !== undefined && fits(selectedElapsed, selectedRetry, cancel) ? cancel : undefined;
  return truncateCells([primary, selectedElapsed, selectedRetry, selectedCancel]
    .filter((value): value is string => value !== undefined && value !== "")
    .join(" · "), width);
}

function contextLocation(view: TuiViewState): string {
  return [
    view.context.workspace === undefined ? undefined : footerWorkspace(view.context.workspace),
    view.context.releaseVersion === undefined ? undefined : `v${view.context.releaseVersion} release`,
    view.context.sessionName,
  ].filter((value): value is string => value !== undefined && value !== "").join(" • ");
}

function headerModel(view: TuiViewState, includeProvider: boolean): string {
  const model = view.context.model === undefined
    ? view.context.provider === undefined ? "no model" : `(${view.context.provider})`
    : includeProvider && view.context.provider !== undefined
      ? `(${view.context.provider}) ${view.context.model}`
      : view.context.model;
  if (view.context.thinkingSupported !== true) return model;
  const thinking = view.context.thinking === undefined || view.context.thinking === "off" ? "thinking off" : view.context.thinking;
  return `${model} · ${thinking}`;
}

function alignedFooterLine(left: string, right: string, width: number): string {
  const selectedLeft = truncateCells(left, width, "");
  if (right === "" || cellWidth(selectedLeft) >= width) return selectedLeft;
  if (selectedLeft === "") {
    const selectedRight = truncateCells(right, width, "");
    return `${" ".repeat(Math.max(0, width - cellWidth(selectedRight)))}${selectedRight}`;
  }
  const minimumGap = 2;
  const availableRight = Math.max(0, width - cellWidth(selectedLeft) - minimumGap);
  if (availableRight === 0) return selectedLeft;
  const selectedRight = truncateCells(right, availableRight, "");
  return `${selectedLeft}${" ".repeat(Math.max(minimumGap, width - cellWidth(selectedLeft) - cellWidth(selectedRight)))}${selectedRight}`;
}

function modelStatus(view: TuiViewState, width: number): string {
  if (width <= 0) return "";
  const includeProvider = (view.context.availableProviderCount ?? 0) > 1;
  const full = sanitizeTerminalText(headerModel(view, includeProvider));
  if (cellWidth(full) <= width) return full;
  const shorter = includeProvider ? sanitizeTerminalText(headerModel(view, false)) : full;
  if (cellWidth(shorter) <= width) return shorter;
  if (view.context.thinkingSupported !== true) return truncateCells(shorter, width, "");
  const thinking = view.context.thinking === undefined || view.context.thinking === "off"
    ? "thinking off"
    : view.context.thinking;
  const suffix = ` · ${thinking}`;
  if (cellWidth(suffix) >= width) return truncateCells(thinking, width, "");
  const model = shorter.endsWith(suffix) ? shorter.slice(0, -suffix.length) : shorter;
  return `${truncateCells(model, width - cellWidth(suffix), "")}${suffix}`;
}

function telemetryLine(view: TuiViewState, width: number, theme: Theme): RenderedLine {
  const status = view.context.status ?? (view.context.active ? "streaming" : "idle");
  const statChips = footerStatChips(view, theme);
  const failed = status === "failed" ? ["failed"] : [];
  const contextRatio = (view.context.contextWindowTokens ?? 0) <= 0 || view.context.contextTokens === undefined
    ? 0
    : view.context.contextTokens / view.context.contextWindowTokens!;
  const detailsRole: ThemeRole = status === "failed"
    ? "error"
    : contextRatio >= 0.9
      ? "error"
      : contextRatio >= 0.7
        ? "warning"
        : "muted";
  if (width < 20) {
    return { text: modelStatus(view, width), role: detailsRole };
  }
  const hasDetails = failed.length > 0
    || statChips.tokens.length > 0
    || statChips.cost !== undefined
    || statChips.context !== undefined;
  const maximumModelWidth = hasDetails ? Math.max(8, Math.floor(width * 0.42)) : width;
  const model = modelStatus(view, maximumModelWidth);
  const rightWidth = Math.max(0, width - cellWidth(model) - (model === "" ? 0 : 2));
  const compactContext = statChips.context;
  const selected: string[] = [];
  for (const chip of [...failed, compactContext, ...statChips.tokens, statChips.cost]) {
    if (chip === undefined || chip === "") continue;
    const candidate = [...selected, chip].join(" · ");
    if (cellWidth(candidate) <= rightWidth) selected.push(chip);
  }
  const inputChip = statChips.tokens[0]?.startsWith("in ") === true
    ? statChips.tokens[0]
    : undefined;
  if (inputChip !== undefined && !selected.includes(inputChip)) {
    selected.length = 0;
    for (const chip of [...failed, ...statChips.tokens, compactContext, statChips.cost]) {
      if (chip === undefined || chip === "") continue;
      const candidate = [...selected, chip].join(" · ");
      if (cellWidth(candidate) <= rightWidth) selected.push(chip);
    }
  }
  if (statChips.contextWithMeter !== undefined && compactContext !== undefined) {
    const contextIndex = selected.indexOf(compactContext);
    if (contextIndex >= 0) {
      const metered = selected.map((chip, index) => index === contextIndex ? statChips.contextWithMeter! : chip).join(" · ");
      if (cellWidth(metered) <= rightWidth) selected[contextIndex] = statChips.contextWithMeter;
    }
  }
  if (selected.length === 0) return { text: modelStatus(view, width), role: detailsRole };
  const details = selected.join(" · ");
  return { text: alignedFooterLine(model, details, width), role: detailsRole };
}

function statusDockLines(view: TuiViewState, width: number, theme: Theme, reserve: boolean): RenderedLine[] {
  const activity = activityText(view, width);
  const location = sanitizeTerminalText(contextLocation(view));
  const extensionStatus = view.context.extensionStatus === undefined
    ? ""
    : sanitizeTerminalText(view.context.extensionStatus);
  const work = activity === undefined ? location : activity;
  const secondary = activity === undefined
    ? extensionStatus
    : [location, extensionStatus].filter((value) => value !== "").join(" · ");
  const top = alignedFooterLine(work, secondary, width);
  return [
    ...(top === "" && !reserve ? [] : [{ text: top, role: activity === undefined ? "muted" as const : "working" as const }]),
    telemetryLine(view, width, theme),
  ];
}

function styledText(
  value: string,
  role: ThemeRole,
  background: ThemeBg | undefined,
  italic: boolean,
  theme: Theme,
): string {
  const rendered = style(theme, role, value);
  const selected = italic ? theme.italic(rendered) : rendered;
  return background === undefined || !theme.ansi ? selected : `${theme.getBgAnsi(background)}${selected}`;
}

function styledSpan(
  span: MarkdownSpan,
  fallbackRole: ThemeRole,
  background: ThemeBg | undefined,
  italic: boolean,
  theme: Theme,
  hyperlinks: boolean,
): string {
  const rendered = styledText(span.text, span.role ?? fallbackRole, background, italic, theme);
  return hyperlinks && span.hyperlink !== undefined ? trustedTerminalHyperlink(rendered, span.hyperlink) : rendered;
}

function styleFrameLine(line: RenderedLine, width: number, theme: Theme, hyperlinks = false): string {
  const semanticPrefix = `${line.semanticZoneStart === true ? OSC133_ZONE_START : ""}${line.semanticZoneEnd === true ? `${OSC133_ZONE_END}${OSC133_ZONE_FINAL}` : ""}`;
  const marker = line.rightMarker;
  const contentWidth = marker === undefined ? width : Math.max(0, width - 1);
  const suffix = marker === undefined ? "" : styledText(marker.text, marker.role, line.background, false, theme);
  if (line.raw === true) {
    const selected = truncateToWidth(line.text, contentWidth);
    return `${semanticPrefix}${selected}${" ".repeat(Math.max(0, contentWidth - visibleWidth(selected)))}${suffix}`;
  }
  if (line.spans !== undefined) {
    const spans = boundedSpans(line.spans, contentWidth);
    const visible = spans.map((span) => span.text).join("");
    const styled = spans.map((span) =>
      styledSpan(span, line.role, line.background, line.italic === true, theme, hyperlinks)).join("");
    return `${semanticPrefix}${styled}${styledText(
      " ".repeat(Math.max(0, contentWidth - cellWidth(visible))),
      line.role,
      line.background,
      line.italic === true,
      theme,
    )}${suffix}`;
  }
  return `${semanticPrefix}${styledText(
    padCells(truncateCells(line.text, contentWidth), contentWidth),
    line.role,
    line.background,
    line.italic === true,
    theme,
  )}${suffix}`;
}

const BACKGROUND_CELL_RESET = "\u001b[0m\u001b]8;;\u0007";

function composeBackgroundCells(
  styled: readonly string[],
  foreground: readonly RenderedLine[],
  cells: readonly BackgroundCell[] | undefined,
  images: readonly TerminalImagePlacement[],
  width: number,
  theme: Theme,
): string[] {
  if (cells === undefined || cells.length === 0) return [...styled];
  const occupancy = foreground.map((line) => lineCells(line, width).map((cell) => cell?.occupied === true));
  for (const image of images) {
    for (let row = image.row; row < image.row + image.rows && row < occupancy.length; row += 1) {
      for (let column = image.column; column < image.column + image.columns && column < width; column += 1) {
        occupancy[row]![column] = true;
      }
    }
  }
  const selected = new Map<number, Map<number, string>>();
  for (const cell of cells) {
    if (!Number.isSafeInteger(cell.row) || !Number.isSafeInteger(cell.column)
      || cell.row < 0 || cell.row >= styled.length || cell.column < 0 || cell.column >= width
      || typeof cell.text !== "string" || sanitizeTerminalText(cell.text) !== cell.text
      || splitGraphemes(cell.text).length !== 1 || cellWidth(cell.text) !== 1
      || occupancy[cell.row]?.[cell.column] === true) continue;
    const row = selected.get(cell.row) ?? new Map<number, string>();
    row.set(cell.column, cell.text);
    selected.set(cell.row, row);
  }
  const output = [...styled];
  for (const [row, replacements] of selected) {
    const line = foreground[row];
    const semanticPrefix = `${line?.semanticZoneStart === true ? OSC133_ZONE_START : ""}${line?.semanticZoneEnd === true ? `${OSC133_ZONE_END}${OSC133_ZONE_FINAL}` : ""}`;
    const base = output[row]!
      .replaceAll(OSC133_ZONE_START, "")
      .replaceAll(OSC133_ZONE_END, "")
      .replaceAll(OSC133_ZONE_FINAL, "");
    let column = 0;
    let composed = semanticPrefix;
    for (const [target, text] of [...replacements].sort(([left], [right]) => left - right)) {
      composed += sliceByColumn(base, column, target - column, true);
      composed += `${BACKGROUND_CELL_RESET}${style(theme, "muted", text)}${BACKGROUND_CELL_RESET}`;
      column = target + 1;
    }
    composed += sliceByColumn(base, column, width - column, true);
    output[row] = composed;
  }
  return output;
}

function terminalImagePlacements(lines: readonly RenderedLine[]): TerminalImagePlacement[] {
  const placements: TerminalImagePlacement[] = [];
  for (const [row, line] of lines.entries()) {
    const image = line.image;
    if (image === undefined || line.imageOffset !== 0 || row + image.rows > lines.length) continue;
    const complete = Array.from({ length: image.rows }, (_, offset) => {
      const candidate = lines[row + offset];
      return candidate?.image?.key === image.key
        && candidate.image.fingerprint === image.fingerprint
        && candidate.imageOffset === offset;
    }).every(Boolean);
    if (complete) placements.push({ ...image, row, column: 0 });
  }
  return placements;
}

export function renderTranscriptFrame(
  entries: readonly TranscriptEntry[],
  columns: number,
  theme: Theme,
  options: TranscriptRenderOptions = {},
): Frame {
  const width = frameDimension(columns, MAX_FRAME_COLUMNS, 80);
  const lines = transcriptLines(
    entries,
    width,
    theme,
    options.toolRenderBlocks,
    options.sessionRenderBlocks,
    options.semanticZones === true,
    options,
  );
  const text = lines.map((line) => {
    const semanticPrefix = `${line.semanticZoneStart === true ? OSC133_ZONE_START : ""}${line.semanticZoneEnd === true ? `${OSC133_ZONE_END}${OSC133_ZONE_FINAL}` : ""}`;
    if (line.spans === undefined) {
      return `${semanticPrefix}${styledText(
        line.fill === true ? padCells(line.text, width) : truncateCells(line.text, width),
        line.role,
        line.background,
        line.italic === true,
        theme,
      )}`;
    }
    const visible = line.spans.map((span) => span.text).join("");
    const styled = line.spans.map((span) =>
      styledSpan(
        span,
        line.role,
        line.background,
        line.italic === true,
        theme,
        options.hyperlinks === true,
      )).join("");
    return `${semanticPrefix}${line.fill === true
      ? `${styled}${styledText(
        " ".repeat(Math.max(0, width - cellWidth(visible))),
        line.role,
        line.background,
        line.italic === true,
        theme,
      )}`
      : styled}`;
  }).join("\n");
  const images = terminalImagePlacements(lines);
  return { text, ...(images.length === 0 ? {} : { images }) };
}

export function renderTranscript(
  entries: readonly TranscriptEntry[],
  columns: number,
  theme: Theme,
  options: TranscriptRenderOptions = {},
): string {
  return renderTranscriptFrame(entries, columns, theme, options).text;
}

interface StyledCell {
  text: string;
  role: ThemeRole;
  width: number;
  continuation?: boolean;
  occupied: boolean;
}

function lineCells(line: RenderedLine, width: number): Array<StyledCell | undefined> {
  const cells: Array<StyledCell | undefined> = Array.from({ length: width });
  const spans = line.raw === true
    ? [{ text: sanitizeTerminalText(line.text), role: line.role }]
    : line.spans ?? [{ text: line.text, role: line.role }];
  let column = 0;
  for (const span of spans) {
    const role = span.role ?? line.role;
    for (const grapheme of splitGraphemes(span.text)) {
      const selectedWidth = graphemeWidth(grapheme);
      if (selectedWidth === 0) {
        for (let index = column - 1; index >= 0; index -= 1) {
          const previous = cells[index];
          if (previous !== undefined && previous.continuation !== true) {
            previous.text += grapheme;
            break;
          }
        }
        continue;
      }
      const contentWidth = line.rightMarker === undefined ? width : Math.max(0, width - 1);
      if (column + selectedWidth > contentWidth) break;
      const occupied = line.occupancy?.[column] ?? true;
      cells[column] = { text: grapheme, role, width: selectedWidth, occupied };
      for (let offset = 1; offset < selectedWidth; offset += 1) {
        cells[column + offset] = {
          text: "",
          role,
          width: 0,
          continuation: true,
          occupied: line.occupancy?.[column + offset] ?? occupied,
        };
      }
      column += selectedWidth;
    }
    if (column >= width) break;
  }
  for (let index = 0; index < width; index += 1) {
    if (cells[index] === undefined) {
      cells[index] = { text: " ", role: line.role, width: 1, occupied: line.occupancy?.[index] ?? line.fill === true };
    }
  }
  if (line.rightMarker !== undefined && width > 0) {
    cells[width - 1] = {
      text: line.rightMarker.text,
      role: line.rightMarker.role,
      width: 1,
      occupied: true,
    };
  }
  return cells;
}

function clearStyledCell(cells: Array<StyledCell | undefined>, column: number, role: ThemeRole, occupied: boolean): void {
  if (column < 0 || column >= cells.length) return;
  let head = column;
  while (head > 0 && cells[head]?.continuation === true) head -= 1;
  const width = Math.max(1, cells[head]?.width ?? 1);
  for (let offset = 0; offset < width && head + offset < cells.length; offset += 1) {
    cells[head + offset] = { text: " ", role, width: 1, occupied };
  }
}

function cellsLine(cells: Array<StyledCell | undefined>): RenderedLine {
  const spans: RuntimeUiSpan[] = [];
  for (const cell of cells) {
    if (cell === undefined || cell.continuation === true) continue;
    const previous = spans.at(-1);
    if (previous?.role === cell.role) previous.text += cell.text;
    else spans.push({ text: cell.text, role: cell.role });
  }
  return { text: "", role: "muted", spans, occupancy: cells.map((cell) => cell?.occupied === true) };
}

function composeRuntimeOverlayLine(
  base: RenderedLine,
  overlay: RuntimeUiBlock["lines"][number],
  column: number,
  overlayWidth: number,
  frameWidth: number,
): RenderedLine {
  const cells = lineCells(base, frameWidth);
  const end = Math.min(frameWidth, column + overlayWidth);
  const fillRole = overlay.spans[0]?.role ?? "muted";
  if (overlay.fill === true) {
    for (let index = column; index < end; index += 1) clearStyledCell(cells, index, fillRole, true);
  }
  let relativeColumn = 0;
  for (const span of overlay.spans) {
    const role = span.role ?? "muted";
    for (const grapheme of splitGraphemes(span.text)) {
      const selectedWidth = graphemeWidth(grapheme);
      if (selectedWidth === 0) {
        const previousColumn = column + relativeColumn - 1;
        if (previousColumn >= column) {
          let head = previousColumn;
          while (head > column && cells[head]?.continuation === true) head -= 1;
          const previous = cells[head];
          if (previous !== undefined) previous.text += grapheme;
        }
        continue;
      }
      if (relativeColumn + selectedWidth > overlayWidth || column + relativeColumn + selectedWidth > frameWidth) break;
      const target = column + relativeColumn;
      for (let offset = 0; offset < selectedWidth; offset += 1) clearStyledCell(cells, target + offset, role, true);
      cells[target] = { text: grapheme, role, width: selectedWidth, occupied: true };
      for (let offset = 1; offset < selectedWidth; offset += 1) {
        cells[target + offset] = { text: "", role, width: 0, continuation: true, occupied: true };
      }
      relativeColumn += selectedWidth;
    }
  }
  return {
    ...cellsLine(cells),
    ...(base.background === undefined ? {} : { background: base.background }),
    ...(base.italic === undefined ? {} : { italic: base.italic }),
    ...(base.semanticZoneStart === true ? { semanticZoneStart: true } : {}),
    ...(base.semanticZoneEnd === true ? { semanticZoneEnd: true } : {}),
  };
}

function overlayCoordinate(value: RuntimeUiOverlayLength | undefined, origin: number, available: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  return origin + Math.floor(available * Number.parseFloat(value) / 100);
}

function overlayMargins(value: RuntimeUiOverlayOptions["margin"]): { top: number; right: number; bottom: number; left: number } {
  if (typeof value === "number") return { top: value, right: value, bottom: value, left: value };
  return {
    top: value?.top ?? 0,
    right: value?.right ?? 0,
    bottom: value?.bottom ?? 0,
    left: value?.left ?? 0,
  };
}

function runtimeOverlayPosition(
  options: RuntimeUiOverlayOptions,
  frameWidth: number,
  frameHeight: number,
  overlayWidth: number,
  overlayHeight: number,
): { row: number; column: number } {
  const margins = overlayMargins(options.margin);
  const left = Math.min(frameWidth - 1, margins.left);
  const right = Math.max(left + 1, frameWidth - Math.min(frameWidth - left - 1, margins.right));
  const top = Math.min(frameHeight - 1, margins.top);
  const bottom = Math.max(top + 1, frameHeight - Math.min(frameHeight - top - 1, margins.bottom));
  const horizontalSpace = Math.max(0, right - left - overlayWidth);
  const verticalSpace = Math.max(0, bottom - top - overlayHeight);
  const anchor = options.anchor ?? "center";
  const explicitColumn = overlayCoordinate(options.col, left, horizontalSpace);
  const explicitRow = overlayCoordinate(options.row, top, verticalSpace);
  const anchoredColumn = anchor.endsWith("left") || anchor === "left-center"
    ? 0
    : anchor.endsWith("right") || anchor === "right-center"
      ? horizontalSpace
      : Math.floor(horizontalSpace / 2);
  const anchoredRow = anchor.startsWith("top")
    ? 0
    : anchor.startsWith("bottom")
      ? verticalSpace
      : Math.floor(verticalSpace / 2);
  return {
    row: Math.max(top, Math.min(bottom - overlayHeight, (explicitRow ?? top + anchoredRow) + (options.offsetY ?? 0))),
    column: Math.max(left, Math.min(right - overlayWidth, (explicitColumn ?? left + anchoredColumn) + (options.offsetX ?? 0))),
  };
}

export function renderFrame(
  view: TuiViewState,
  size: { columns: number; rows: number },
  theme: Theme,
  options: {
    compact?: boolean;
    toolRenderBlocks?: ReadonlyMap<string, ToolRenderSlots>;
    sessionRenderBlocks?: ReadonlyMap<string, RuntimeUiBlock>;
    hyperlinks?: boolean;
    resolveImage?: TranscriptRenderOptions["resolveImage"];
    maxImageRows?: number;
    editorPaddingX?: number;
    hideReasoningBlock?: boolean;
    outputPad?: 0 | 1;
    codeBlockIndent?: string;
    expandKeyHint?: string | undefined;
    thinkingKeyHint?: string;
    transformMarkdown?: TranscriptRenderOptions["transformMarkdown"];
    imageWidthCells?: number;
    reserveActivityRow?: boolean;
    fullscreenScrollbar?: "auto" | "always" | "hidden";
    fullscreenScrollbarHovered?: boolean;
  } = {},
): Frame {
  const width = frameDimension(size.columns, MAX_FRAME_COLUMNS, 80);
  const maximumHeight = frameDimension(size.rows, MAX_FRAME_ROWS, 24);
  const footer = view.runtimeFooterReplacement === undefined && view.rawFooterReplacement === undefined
    ? statusDockLines(view, width, theme, options.reserveActivityRow === true)
    : [];
  const statusLines: RenderedLine[] = [];
  let extensionHeaderLines: RenderedLine[] = view.rawHeaderReplacement !== undefined
    ? rawLines(view.rawHeaderReplacement, width, 8)
    : view.runtimeHeaderReplacement === undefined
    ? [
        ...(view.context.extensionHeaders ?? []).slice(-4).flatMap((header) =>
          wrapCells(byteTruncate(sanitizeTerminalText(header), 32 * 1024), Math.max(1, width - 2)).slice(0, 2).map((line) => ({
            text: ` ${line}`,
            role: "accent" as const,
          }))),
        ...structuralSlotLines(view.runtimeHeaderComponents, width, 8),
        ...rawSlotLines(view.rawHeaderComponents, width, 8),
      ].slice(-8)
    : structuralLines(sanitizeRuntimeUiBlock(view.runtimeHeaderReplacement, { width, maxLines: 8 }), width)?.slice(-8) ?? [];
  let extensionFooterLines: RenderedLine[] = view.rawFooterReplacement !== undefined
    ? rawLines(view.rawFooterReplacement, width, 8)
    : view.runtimeFooterReplacement === undefined
    ? [
        ...(view.context.extensionFooters ?? []).slice(-4).flatMap((extensionFooter) =>
          wrapCells(byteTruncate(sanitizeTerminalText(extensionFooter), 32 * 1024), Math.max(1, width - 2)).slice(0, 2).map((line) => ({
            text: ` ${line}`,
            role: "muted" as const,
          }))),
        ...structuralSlotLines(view.runtimeFooterComponents, width, 8),
        ...rawSlotLines(view.rawFooterComponents, width, 8),
      ].slice(-8)
    : structuralLines(sanitizeRuntimeUiBlock(view.runtimeFooterReplacement, { width, maxLines: 8 }), width)?.slice(-8) ?? [];
  const editorWidth = Math.max(1, width);
  const editorHeight = Math.max(5, Math.floor(maximumHeight * 0.3));
  const editor = structuralEditorBlock(view.editorBlock, editorWidth, editorHeight) ?? editorBlock(
    view.editorText,
    view.editorCursor,
    view.inputLabel,
    editorWidth,
    editorHeight,
    theme,
    options.editorPaddingX ?? 0,
  );
  const inputPrompt = view.inputPrompt === undefined
    ? ""
    : sanitizeTerminalText(view.inputPrompt).trimEnd();
  const inputPromptLines: RenderedLine[] = inputPrompt === ""
    ? []
    : wrapCells(inputPrompt, Math.max(1, width - 2)).slice(-4).map((line) => ({
        text: `${width > 1 ? " " : ""}${line}`,
        role: "title" as const,
      }));
  let widgetLines: RenderedLine[] = [
    ...(view.context.widgets ?? []).slice(-4).flatMap((widget) =>
      wrapCells(byteTruncate(sanitizeTerminalText(widget), 32 * 1024), Math.max(1, width - 2)).slice(0, 2).map((line) => ({
        text: ` ${line}`,
        role: "accent" as const,
      }))),
    ...structuralSlotLines(view.runtimeWidgetComponents, width, 8),
    ...rawSlotLines(view.rawWidgetComponents, width, 8),
  ].slice(-8);
  let belowWidgetLines: RenderedLine[] = [
    ...structuralSlotLines(view.runtimeWidgetBelowComponents, width, 8),
    ...rawSlotLines(view.rawWidgetBelowComponents, width, 8),
  ].slice(-8);
  const editorBorderRole: ThemeRole = "editorActive";
  const inputImageLines: RenderedLine[] = (view.inputImages?.length ?? 0) === 0
    ? []
    : [{
        text: ` Attachments: ${(view.inputImages ?? []).map((image) =>
          `${sanitizeTerminalText(image.label)} (${image.mediaType}${image.width === undefined || image.height === undefined ? "" : ` ${image.width}x${image.height}`})`).join(" · ")}`,
        role: "muted",
      }];
  const commandLines = view.overlay?.inline === true ? inlineCommandLines(view.overlay, width) : [];
  const selectorActive = view.overlay !== undefined && view.overlay.inline !== true;
  const widgetBudget = Math.max(
    0,
    maximumHeight - footer.length - statusLines.length - inputPromptLines.length - inputImageLines.length - editor.lines.length - commandLines.length - 3,
  );
  let widgetAboveBudget = Math.min(widgetLines.length, Math.ceil(widgetBudget / 2));
  let widgetBelowBudget = Math.min(belowWidgetLines.length, widgetBudget - widgetAboveBudget);
  widgetAboveBudget += Math.min(widgetLines.length - widgetAboveBudget, widgetBudget - widgetAboveBudget - widgetBelowBudget);
  widgetBelowBudget += Math.min(belowWidgetLines.length - widgetBelowBudget, widgetBudget - widgetAboveBudget - widgetBelowBudget);
  widgetLines = widgetAboveBudget === 0 ? [] : widgetLines.slice(-widgetAboveBudget);
  belowWidgetLines = widgetBelowBudget === 0 ? [] : belowWidgetLines.slice(-widgetBelowBudget);
  if (options.compact === true && widgetLines.length === 0) widgetLines = [{ text: "", role: "muted" }];
  const rawEditor = view.rawEditorBlock === undefined ? undefined : rawLines(view.rawEditorBlock, width, editorHeight + 2);
  const editorLines: RenderedLine[] = selectorActive ? [] : rawEditor === undefined ? [
    ...statusLines,
    ...widgetLines,
    { text: composerGraphEdge(width, theme, "top"), role: editorBorderRole },
    ...inputPromptLines,
    ...inputImageLines,
    ...editor.lines,
    { text: composerGraphEdge(width, theme, "bottom"), role: editorBorderRole },
    ...belowWidgetLines,
    ...commandLines,
  ] : [
    ...statusLines,
    ...widgetLines,
    ...inputPromptLines,
    ...inputImageLines,
    ...rawEditor,
    ...belowWidgetLines,
    ...commandLines,
  ];
  const chromeBudget = Math.max(0, maximumHeight - footer.length - editorLines.length - 1);
  let headerBudget = Math.min(extensionHeaderLines.length, Math.ceil(chromeBudget / 2));
  let extensionFooterBudget = Math.min(extensionFooterLines.length, chromeBudget - headerBudget);
  headerBudget += Math.min(extensionHeaderLines.length - headerBudget, chromeBudget - headerBudget - extensionFooterBudget);
  extensionFooterBudget += Math.min(extensionFooterLines.length - extensionFooterBudget, chromeBudget - headerBudget - extensionFooterBudget);
  extensionHeaderLines = headerBudget === 0 ? [] : extensionHeaderLines.slice(-headerBudget);
  extensionFooterLines = extensionFooterBudget === 0 ? [] : extensionFooterLines.slice(-extensionFooterBudget);
  const middleHeight = Math.max(
    1,
    maximumHeight - extensionHeaderLines.length - footer.length - extensionFooterLines.length - editorLines.length,
  );
  const headerOffset = extensionHeaderLines.length;
  let middle: RenderedLine[];
  let transcriptScrollbar: { total: number; start: number } | undefined;
  let transcriptNavigation: Frame["transcriptNavigation"];
  let transcriptAnchorRows: TranscriptFrameAnchorState["rows"] | undefined;
  let transcriptViewportAnchor: TranscriptFrameAnchorState["viewport"];
  let cursor = {
    row: headerOffset + middleHeight + statusLines.length + widgetLines.length + inputPromptLines.length + (rawEditor === undefined ? 1 : 0)
      + inputImageLines.length + (view.rawEditorBlock?.cursor?.row ?? editor.cursor.row),
    column: view.rawEditorBlock?.cursor?.column ?? editor.cursor.column,
  };
  let overlayCursor = false;

  if (view.rawRuntimeComponent !== undefined) {
    middle = rawLines(view.rawRuntimeComponent, width, middleHeight);
    cursor = {
      row: headerOffset + Math.min(Math.max(0, middle.length - 1), view.rawRuntimeComponent.cursor?.row ?? 0),
      column: Math.min(width - 1, view.rawRuntimeComponent.cursor?.column ?? 0),
    };
    overlayCursor = true;
  } else if (view.runtimeComponent !== undefined) {
    const block = sanitizeRuntimeUiBlock(view.runtimeComponent, { width });
    middle = structuralLines(block, width)?.slice(0, middleHeight) ?? [];
    cursor = {
      row: headerOffset + Math.min(Math.max(0, middle.length - 1), block.cursor?.row ?? 0),
      column: Math.min(width - 1, block.cursor?.column ?? 0),
    };
    overlayCursor = true;
  } else {
    const transcriptContent = (contentWidth: number): RenderedLine[] => {
      const queuedMessages = (view.queuedMessages ?? []).slice(-4).flatMap((message) => {
        const label = message.mode === "follow_up" ? "Follow-up" : "Steering";
        const imageCount = message.imageCount ?? message.images?.length ?? 0;
        const attachments = imageCount === 0 ? "" : `[${imageCount} image${imageCount === 1 ? "" : "s"}]`;
        const body = [sanitizeTerminalText(message.text), attachments]
          .filter((value) => value.trim() !== "")
          .join(" · ");
        return wrapCells(`${label}: ${body}`, contentWidth).slice(0, 2).map((text) => ({
          text,
          role: "muted" as const,
        }));
      });
      if ((view.queuedMessages?.length ?? 0) > 4) {
        queuedMessages.unshift({
          text: `… ${(view.queuedMessages?.length ?? 0) - 4} earlier queued messages`,
          role: "muted",
        });
      }
      if (queuedMessages.length > 0) {
        queuedMessages.push({
          text: "↳ Alt+Up to restore all queued messages with their attachments",
          role: "muted",
        });
      }
      return [
        ...transcriptLines(
          view.transcript,
          contentWidth,
          theme,
          options.toolRenderBlocks,
          options.sessionRenderBlocks,
          false,
          {
            ...options,
            activityFrame: view.context.activityFrame,
            workingIndicator: view.workingIndicator,
            ...(view.hiddenReasoningLabel === undefined
              ? {}
              : { hiddenReasoningLabel: view.hiddenReasoningLabel }),
          },
        ),
        ...(view.notice === undefined
          ? []
          : [{
              text: `${theme.glyphs.pending} ${sanitizeTerminalText(view.notice)}`,
              role: "muted" as const,
            }]),
        ...queuedMessages,
      ];
    };
    const scrollbarAvailable = options.compact !== true && width > 1;
    const scrollbarAlways = scrollbarAvailable && options.fullscreenScrollbar === "always";
    const scrollbarCandidate = scrollbarAvailable && options.fullscreenScrollbar === "auto";
    let all = transcriptContent(scrollbarAlways || scrollbarCandidate ? width - 1 : width);
    const scrollbarAutomatic = scrollbarCandidate && all.length > middleHeight;
    if (scrollbarCandidate && !scrollbarAutomatic) all = transcriptContent(width);
    transcriptAnchorRows = all.map((line) => line.transcriptAnchor);
    const maximumOffset = Math.max(0, all.length - middleHeight);
    const selectedOffset = Math.min(maximumOffset, Math.max(0, view.transcriptOffset));
    const end = Math.max(0, all.length - selectedOffset);
    const start = Math.max(0, end - middleHeight);
    const messageRows: number[] = [];
    let owningPrompt: string | undefined;
    for (const [index, line] of all.entries()) {
      if (line.messageStart === true) messageRows.push(index);
      if (index <= start && line.owningPromptBoundary === true) owningPrompt = line.owningPromptStart;
    }
    transcriptNavigation = {
      totalRows: all.length,
      startRow: start,
      viewportRows: middleHeight,
      messageRows,
      pointerRegion: {
        top: headerOffset,
        bottom: headerOffset + middleHeight - 1,
      },
    };
    middle = all.slice(start, end);
    const viewportHeader = view.transcriptOffset === 0 && start > 0
      ? middle[0]?.viewportHeader
      : undefined;
    if (viewportHeader !== undefined && middle.length > 0) middle[0] = { ...viewportHeader };
    if (scrollbarAlways || scrollbarAutomatic) transcriptScrollbar = { total: all.length, start };
    if (view.transcriptOffset > 0 && start > 0 && middle.length > 0) {
      const marker = `${theme.glyphs.scroll} older transcript`;
      const contentWidth = scrollbarAlways || scrollbarAutomatic ? Math.max(1, width - 1) : width;
      middle[0] = {
        text: truncateCells(owningPrompt === undefined ? marker : `${marker} · ${owningPrompt}`, contentWidth),
        role: "accent",
      };
    }
  }

  const padding = options.compact === true ? 0 : Math.max(0, middleHeight - middle.length);
  if (options.compact !== true) while (middle.length < middleHeight) middle.unshift({ text: "", role: "muted" });
  if (overlayCursor && options.compact !== true) cursor.row += padding;
  if (middle.length > middleHeight) middle = middle.slice(0, middleHeight);
  if (view.overlay !== undefined && view.overlay.inline !== true) {
    const deck = view.overlay.settings === true
      ? settingsOverlayLines(view.overlay, width, middleHeight, theme.glyphs.horizontal)
      : view.overlay.pickerKind === "model"
        ? modelOverlayLines(view.overlay, width, middleHeight, theme.glyphs.horizontal)
        : overlayLines(view.overlay, width, middleHeight, theme.glyphs.horizontal);
    const deckPadding = options.compact === true ? 0 : Math.max(0, middleHeight - deck.lines.length);
    middle = [
      ...Array.from({ length: deckPadding }, (): RenderedLine => ({ text: "", role: "muted" })),
      ...deck.lines,
    ];
    cursor = {
      row: headerOffset + deckPadding + deck.cursor.row,
      column: deck.cursor.column,
    };
    overlayCursor = true;
  }
  if (!overlayCursor && transcriptAnchorRows !== undefined) {
    const row = middle.findIndex((line) => line.transcriptAnchor?.durable === true);
    const anchor = row < 0 ? undefined : middle[row]?.transcriptAnchor;
    if (anchor !== undefined) transcriptViewportAnchor = { anchor, row };
  }
  if (transcriptScrollbar !== undefined && !overlayCursor && middleHeight > 0 && width > 0) {
    const total = Math.max(1, transcriptScrollbar.total);
    const thumbSize = Math.max(1, Math.min(middleHeight, Math.round(middleHeight * Math.min(1, middleHeight / total))));
    const maximumStart = Math.max(0, total - middleHeight);
    const thumbStart = maximumStart === 0
      ? 0
      : Math.round(transcriptScrollbar.start / maximumStart * Math.max(0, middleHeight - thumbSize));
    if (transcriptNavigation?.pointerRegion !== undefined) {
      transcriptNavigation = {
        ...transcriptNavigation,
        pointerRegion: {
          ...transcriptNavigation.pointerRegion,
          scrollbar: {
            column: width - 1,
            thumbTop: headerOffset + thumbStart,
            thumbRows: thumbSize,
          },
        },
      };
    }
    middle = middle.map((line, index) => ({
      ...line,
      rightMarker: index >= thumbStart && index < thumbStart + thumbSize
        ? {
            text: theme.unicode ? "█" : "#",
            role: options.fullscreenScrollbarHovered === true ? "accent" : "scrollbar",
          }
        : { text: theme.unicode ? "│" : "|", role: "muted" },
    }));
  }
  if (options.compact === true && !overlayCursor) {
    cursor.row = headerOffset + middle.length + statusLines.length + widgetLines.length + (rawEditor === undefined ? 1 : 0)
      + inputPromptLines.length + inputImageLines.length + (view.rawEditorBlock?.cursor?.row ?? editor.cursor.row);
  }
  if (overlayCursor && transcriptNavigation?.pointerRegion !== undefined) {
    transcriptNavigation = {
      totalRows: transcriptNavigation.totalRows,
      startRow: transcriptNavigation.startRow,
      viewportRows: transcriptNavigation.viewportRows,
      messageRows: transcriptNavigation.messageRows,
    };
  }
  const lines = [...extensionHeaderLines, ...middle, ...editorLines, ...extensionFooterLines, ...footer];
  const height = options.compact === true
    ? Math.max(1, Math.min(maximumHeight, lines.length))
    : maximumHeight;
  while (lines.length < height) lines.push({ text: "", role: "muted" });
  const runtimeOverlays = [
    ...(view.runtimeOverlays ?? []),
    ...(view.runtimeOverlay === undefined ? [] : [view.runtimeOverlay]),
  ];
  for (const runtimeOverlay of runtimeOverlays) {
    const margins = overlayMargins(runtimeOverlay.options.margin);
    const availableWidth = Math.max(1, width - margins.left - margins.right);
    const availableHeight = Math.max(1, height - margins.top - margins.bottom);
    const overlayWidth = Math.max(1, Math.min(availableWidth, runtimeOverlay.width));
    const block = sanitizeRuntimeUiBlock(runtimeOverlay.block, {
      width: overlayWidth,
      maxLines: Math.max(1, height),
    });
    const overlayHeight = Math.min(availableHeight, block.lines.length);
    if (overlayHeight > 0) {
      const position = runtimeOverlayPosition(
        runtimeOverlay.options,
        width,
        height,
        overlayWidth,
        overlayHeight,
      );
      for (let index = 0; index < overlayHeight; index += 1) {
        const target = position.row + index;
        const overlayLine = block.lines[index];
        if (overlayLine === undefined || lines[target] === undefined) continue;
        lines[target] = composeRuntimeOverlayLine(lines[target], overlayLine, position.column, overlayWidth, width);
      }
      if (runtimeOverlay.focused) {
        cursor = {
          row: position.row + Math.min(overlayHeight - 1, block.cursor?.row ?? 0),
          column: position.column + Math.min(overlayWidth - 1, block.cursor?.column ?? 0),
        };
      }
    }
  }
  const selectedLines = lines.slice(0, height);
  const imagesAllowed = view.overlay === undefined
    && view.runtimeComponent === undefined
    && view.rawRuntimeComponent === undefined
    && (view.runtimeOverlays?.length ?? 0) === 0
    && (view.rawRuntimeOverlays?.length ?? 0) === 0
    && view.runtimeOverlay === undefined
    && view.transcriptOffset === 0;
  const images = imagesAllowed ? terminalImagePlacements(selectedLines) : [];
  const styledLines = composeBackgroundCells(
    selectedLines.map((line) => styleFrameLine(line, width, theme, options.hyperlinks === true)),
    selectedLines,
    view.backgroundCells,
    images,
    width,
    theme,
  );
  for (const rawOverlay of view.rawRuntimeOverlays ?? []) {
    const margins = overlayMargins(rawOverlay.options.margin);
    const availableWidth = Math.max(1, width - margins.left - margins.right);
    const availableHeight = Math.max(1, height - margins.top - margins.bottom);
    const overlayWidth = Math.max(1, Math.min(availableWidth, rawOverlay.width));
    const overlayHeight = Math.min(availableHeight, rawOverlay.block.lines.length);
    if (overlayHeight === 0) continue;
    const position = runtimeOverlayPosition(rawOverlay.options, width, height, overlayWidth, overlayHeight);
    for (let index = 0; index < overlayHeight; index += 1) {
      const target = position.row + index;
      const base = styledLines[target];
      const raw = rawOverlay.block.lines[index];
      if (base === undefined || raw === undefined) continue;
      const selected = truncateToWidth(raw, overlayWidth);
      styledLines[target] = `${sliceByColumn(base, 0, position.column)}${selected}${" ".repeat(Math.max(0, overlayWidth - visibleWidth(selected)))}${sliceByColumn(base, position.column + overlayWidth, width - position.column - overlayWidth)}`;
    }
    if (rawOverlay.focused) {
      cursor = {
        row: position.row + Math.min(overlayHeight - 1, rawOverlay.block.cursor?.row ?? 0),
        column: position.column + Math.min(overlayWidth - 1, rawOverlay.block.cursor?.column ?? 0),
      };
    }
  }
  const frame: Frame = {
    text: styledLines.join("\n"),
    cursor: { row: Math.min(height, cursor.row + 1), column: Math.min(width, cursor.column + 1) },
    ...(images.length === 0 ? {} : { images }),
    ...(transcriptNavigation === undefined ? {} : { transcriptNavigation }),
  };
  if (transcriptAnchorRows !== undefined) {
    transcriptFrameAnchorStates.set(frame, {
      rows: transcriptAnchorRows,
      ...(transcriptViewportAnchor === undefined ? {} : { viewport: transcriptViewportAnchor }),
    });
  }
  return frame;
}

export function pickerItem<T>(id: string, label: string, value: T, detail?: string): PickerItem<T> {
  return { id, label, value, ...(detail === undefined ? {} : { detail }) };
}
