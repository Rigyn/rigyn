import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@rigyn/terminal";
import { formatUsageCost } from "../core/usage.js";
import type { Frame, PickerItem, TranscriptEntry, TuiRawBlock, TuiViewState } from "./types.js";
import {
  sanitizeRuntimeUiBlock,
  type RuntimeUiBlock,
  type RuntimeUiOverlayLength,
  type RuntimeUiOverlayOptions,
  type RuntimeUiSpan,
} from "./components.js";
import type { Theme, ThemeRole } from "./theme.js";
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
import { byteTruncate, cellWidth, graphemeWidth, padCells, sanitizeTerminalText, splitGraphemes, truncateCells, wrapCells } from "./unicode.js";

interface RenderedLine {
  text: string;
  role: ThemeRole;
  raw?: boolean;
  fill?: boolean;
  spans?: readonly MarkdownSpan[];
  semanticZoneStart?: boolean;
  semanticZoneEnd?: boolean;
  image?: Omit<TerminalImagePlacement, "row" | "column">;
  imageOffset?: number;
}

function rawLines(value: TuiRawBlock | undefined, width: number, maximumLines: number): RenderedLine[] {
  return (value?.lines ?? []).slice(0, Math.max(0, maximumLines)).map((line) => ({
    text: truncateToWidth(line, width),
    role: "muted",
    raw: true,
  }));
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
  imageWidthCells?: number;
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

function entryPrefix(entry: TranscriptEntry, theme: Theme, hiddenReasoningLabel = "summary"): string {
  if (entry.kind === "startup" || entry.kind === "user" || entry.kind === "assistant") return "";
  if (entry.kind === "reasoning") {
    const label = truncateCells(
      byteTruncate(sanitizeTerminalText(hiddenReasoningLabel).replaceAll("\n", " ").trim() || "summary", 64),
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

function collapsedReasoningSummary(value: string): string {
  const visible = value.replace(/<!--[\s\S]*?-->/gu, " ");
  const first = visible.split(/\r?\n/gu).map((line) => line.trim()).find((line) => line !== "") ?? "";
  return first
    .replace(/^#{1,6}\s+/u, "")
    .replace(/^(?:[-+*]|\d+[.)])\s+/u, "")
    .replace(/\[([^\]]+)\]\([^\s)]+\)/gu, "$1")
    .replace(/\*\*|__|~~|`/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function durationText(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining === 0 ? `${minutes}m` : `${minutes}m ${remaining}s`;
}

function toolMetadata(entry: TranscriptEntry): Record<string, unknown> | undefined {
  const metadata = entry.toolData?.result?.metadata;
  return metadata === null || typeof metadata !== "object" || Array.isArray(metadata) ? undefined : metadata;
}

function metadataInteger(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
  const selected = metadata?.[key];
  return typeof selected === "number" && Number.isSafeInteger(selected) && selected >= 0 ? selected : undefined;
}

function quantity(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function shellStatus(entry: TranscriptEntry, metadata: Record<string, unknown> | undefined): string | undefined {
  const fields: string[] = entry.status === "failed" ? ["failed"] : [];
  const durationMs = metadata?.durationMs;
  if (typeof durationMs === "number" && Number.isSafeInteger(durationMs) && durationMs >= 0) {
    fields.push(durationText(durationMs));
  }
  if (metadata?.cancelled === true) fields.push("cancelled");
  else if (metadata?.timedOut === true) fields.push("timed out");
  else if (typeof metadata?.signal === "string" && metadata.signal !== "") fields.push(`signal ${sanitizeTerminalText(metadata.signal)}`);
  else if (typeof metadata?.exitCode === "number" && Number.isSafeInteger(metadata.exitCode)) fields.push(`exit ${metadata.exitCode}`);
  const fullOutputPath = metadata?.fullOutputPath;
  if (typeof fullOutputPath === "string" && fullOutputPath !== "") {
    fields.push(`full output: ${sanitizeTerminalText(fullOutputPath).replaceAll("\n", " ")}`);
  } else if (metadata?.truncated === true) fields.push("output limited");
  if (fields.length > 0) return fields.join(" · ");
  return entry.status === "completed" ? "done" : undefined;
}

function toolStatusText(entry: TranscriptEntry): string | undefined {
  if (entry.status === "pending") return "queued";
  if (entry.status === "running") {
    const elapsedMs = entry.toolData?.progress?.elapsedMs;
    return elapsedMs === undefined ? "running" : `running · ${durationText(elapsedMs)}`;
  }
  if (entry.status === "in_doubt") return "outcome unknown";
  const metadata = toolMetadata(entry);
  if (entry.title === "shell" || entry.title === "bash") return shellStatus(entry, metadata);
  if (entry.status === "failed") return "failed";
  if (entry.status !== "completed") return undefined;
  const durationMs = metadata?.durationMs;
  const duration = typeof durationMs === "number" && Number.isSafeInteger(durationMs) && durationMs >= 0
    ? durationText(durationMs)
    : undefined;
  const final = (value: string) => [value, duration].filter((part): part is string => part !== undefined).join(" · ");

  if (entry.title === "read") {
    const mediaType = metadata?.mediaType;
    if (typeof mediaType === "string" && mediaType !== "") {
      const width = metadataInteger(metadata, "width");
      const height = metadataInteger(metadata, "height");
      return final(width === undefined || height === undefined ? mediaType : `${mediaType} · ${width}×${height}`);
    }
    const shownLines = metadataInteger(metadata, "shownLines");
    if (shownLines !== undefined) return final(`${quantity(shownLines, "line")} read${metadata?.truncated === true ? " · limited" : ""}`);
  }
  const count = metadataInteger(metadata, "count");
  if (count !== undefined) {
    const label = entry.title === "grep"
      ? quantity(count, "match")
      : entry.title === "find"
        ? quantity(count, "path")
        : entry.title === "ls"
          ? quantity(count, "entry", "entries")
          : undefined;
    if (label !== undefined) return final(`${label}${metadata?.truncated === true ? " · limited" : ""}`);
  }
  const replacements = metadataInteger(metadata, "replacements");
  if (entry.title === "edit" && replacements !== undefined) return final(quantity(replacements, "replacement"));
  const bytes = metadataInteger(metadata, "bytes");
  if (entry.title === "write" && bytes !== undefined) return final(`${quantity(bytes, "byte")} written`);
  return final("done");
}

function toolDisplayName(value: string | undefined): string {
  const safe = sanitizeTerminalText(value ?? "tool").replaceAll("\n", " ");
  if (safe === "apply_patch") return "Patch";
  return safe.replace(/[_-]+/gu, " ").replace(/^\p{Ll}/u, (character) => character.toUpperCase());
}

function toolFileBadge(entry: TranscriptEntry): string | undefined {
  if (entry.title !== "read" && entry.title !== "edit" && entry.title !== "write") return undefined;
  const input = entry.toolData?.input;
  if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.path !== "string") return undefined;
  const suffix = extname(input.path).slice(1).toLowerCase();
  return suffix !== "" && /^[a-z0-9]{1,8}$/u.test(suffix) ? `[${suffix}]` : "[file]";
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

function toolHeaderLine(entry: TranscriptEntry, width: number, theme: Theme): RenderedLine {
  const unicode = theme.glyphs.horizontal === "─";
  const glyph = entry.status === "completed"
    ? theme.glyphs.success
    : entry.status === "failed"
      ? theme.glyphs.failure
      : entry.status === "in_doubt"
        ? "!"
        : entry.status === "running"
          ? (unicode ? "●" : "*")
          : (unicode ? "○" : "o");
  const glyphRole: ThemeRole = entry.status === "completed"
    ? "success"
    : entry.status === "failed"
      ? "error"
      : entry.status === "in_doubt"
        ? "warning"
        : entry.status === "running"
          ? "working"
          : "muted";
  const status = toolStatusText(entry);
  const badge = width < 32 ? undefined : toolFileBadge(entry);
  const summary = entry.summary === undefined ? "" : sanitizeTerminalText(entry.summary).replaceAll("\n", " ").trim();
  const detail = [badge, summary].filter((part): part is string => part !== undefined && part !== "").join(" ");
  const rail = `${unicode ? "│" : "|"} `;
  const glyphText = `${glyph} `;
  const name = toolDisplayName(entry.title);
  const compactStatus = entry.status === "running"
    ? entry.toolData?.progress?.elapsedMs === undefined ? "running" : durationText(entry.toolData.progress.elapsedMs)
    : entry.title === "shell" || entry.title === "bash"
      ? status?.replace(/^failed · /u, "").replace(/^done · /u, "")
      : entry.status === "pending"
        ? "queued"
      : entry.status === "in_doubt"
          ? "unknown"
          : entry.status === "failed"
            ? "failed"
            : entry.status === "completed" && width >= 32
              ? status?.replace(/(\d+ lines?) read/u, "$1")
              : undefined;
  const fixedWidth = cellWidth(rail) + cellWidth(glyphText) + cellWidth(name);
  const fullStatus = status === undefined ? "" : ` · ${status}`;
  const completeDetailWidth = detail === "" ? 0 : cellWidth(` · ${detail}`);
  const selectedStatus = fixedWidth + cellWidth(fullStatus) + completeDetailWidth <= width
    ? fullStatus
    : compactStatus === undefined ? "" : ` · ${compactStatus}`;
  const remaining = Math.max(0, width - fixedWidth - cellWidth(selectedStatus));
  const selectedDetail = detail === "" || remaining < 4 ? "" : truncateCells(` · ${detail}`, remaining);
  const spans: RuntimeUiSpan[] = [
    { text: rail, role: "muted" },
    { text: glyphText, role: glyphRole },
    { text: name, role: "title" },
    ...(selectedDetail === "" ? [] : [{ text: selectedDetail, role: "muted" as const }]),
    ...(selectedStatus === "" ? [] : [{ text: selectedStatus, role: entry.status === "failed" ? "error" as const : "muted" as const }]),
  ];
  return {
    text: "",
    role: "muted",
    spans: boundedSpans(spans, width),
  };
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
    return wrapCells(source, width).map((line) => ({ text: `   ${line}`, role: selectedRole, fill: true }));
  });
}

function liveToolLines(entry: TranscriptEntry, width: number): RenderedLine[] | undefined {
  if (entry.status !== "running") return undefined;
  const partial = entry.toolData?.partialResult;
  if (partial !== undefined) {
    const role: ThemeRole = partial.isError ? "error" : "code";
    return [
      { text: `   partial result${partial.truncated === true ? " · limited" : ""}`, role },
      ...wrappedToolLines(partial.content, width, role),
    ];
  }
  const progress = entry.toolData?.progress;
  if (progress === undefined) return undefined;
  const channels = [
    { label: "stdout", text: progress.stdout, bytes: progress.stdoutBytes, role: "code" as const },
    { label: "stderr", text: progress.stderr, bytes: progress.stderrBytes, role: "warning" as const },
  ].filter((channel) => channel.text !== "");
  const perChannel = channels.length > 1 ? 1 : 4;
  const lines = channels.flatMap((channel): RenderedLine[] => {
    const rendered = wrappedToolLines(channel.text, width, channel.role);
    const output = rendered.slice(-perChannel);
    return [
      { text: `   ${channel.label} · ${quantity(channel.bytes, "byte")}${output.length < rendered.length ? " · tail" : ""}`, role: channel.role },
      ...output,
    ];
  });
  if (progress.truncated) lines.push({ text: "   live output · limited", role: "warning" });
  return lines;
}

function boundedToolLines(
  lines: readonly RenderedLine[],
  tail: boolean,
  limit: number,
  width: number,
  theme: Theme,
): RenderedLine[] {
  if (lines.length <= limit) return [...lines];
  const visible = tail ? lines.slice(-limit) : lines.slice(0, limit);
  const remaining = lines.length - visible.length;
  const omission = theme.glyphs.pending === "." ? "..." : "…";
  const marker = truncateCells(`${omission} +${remaining} ${tail ? "earlier" : "more"} rows`, Math.max(1, width - 6));
  return tail
    ? [{ text: marker, role: "muted" }, ...visible]
    : [...visible, { text: marker, role: "muted" }];
}

function collapsedToolBody(
  entry: TranscriptEntry,
  input: readonly RenderedLine[],
  output: readonly RenderedLine[],
  width: number,
  theme: Theme,
): RenderedLine[] {
  if (entry.expanded === true || entry.status === "pending" || entry.status === "running") {
    return entry.status === "failed" || entry.status === "in_doubt" ? [...output, ...input] : [...input, ...output];
  }
  if (entry.title === "read") {
    if (entry.status === "completed") {
      return toolMetadata(entry)?.omitted === true ? [...input, ...output] : [...input];
    }
    if (entry.status === "failed" || entry.status === "in_doubt") {
      return [...boundedToolLines(output, false, 10, width, theme), ...input];
    }
  }
  if (entry.title === "shell" || entry.title === "bash") {
    return [...input, ...boundedToolLines(output, true, 5, width, theme)];
  }
  if (entry.title === "grep") return [...input, ...boundedToolLines(output, false, 15, width, theme)];
  if (entry.title === "find" || entry.title === "ls") {
    return [...input, ...boundedToolLines(output, false, 20, width, theme)];
  }
  if (entry.title === "write") return boundedToolLines(input, false, 10, width, theme);
  return entry.status === "failed" || entry.status === "in_doubt" ? [...output, ...input] : [...input, ...output];
}

function syntaxReadLines(entry: TranscriptEntry, width: number): RenderedLine[] | undefined {
  if (entry.title !== "read" || entry.status === "running" || entry.text === "") return undefined;
  const input = entry.toolData?.input;
  if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.path !== "string") return undefined;
  const languageHint = extname(input.path).slice(1);
  if (languageHint === "") return undefined;
  const lines = renderSyntaxCodeLines("   ", entry.text, Math.max(1, width - 2), languageHint);
  return lines.length === 0 ? undefined : lines;
}

function branchedToolLines(lines: readonly RenderedLine[], theme: Theme): RenderedLine[] {
  const unicode = theme.glyphs.horizontal === "─";
  const rail = `${unicode ? "│" : "|"} `;
  return lines.map((line) => ({
    ...line,
    text: line.spans === undefined ? `${rail}${line.text}` : line.text,
    ...(line.spans === undefined ? {} : { spans: [{ text: rail, role: "muted" as const }, ...line.spans] }),
    fill: false,
  }));
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

function userMessageLines(value: string, width: number, theme: Theme, outputPad = 0): RenderedLine[] {
  const unicode = theme.glyphs.horizontal === "─";
  const edge = " ".repeat(outputPad);
  const label = `${edge} You ${unicode ? "›" : ">"} `;
  const content = wrapCells(value, Math.max(1, width - cellWidth(label) - outputPad - 1));
  const padding = { text: "", role: "userMessage" as const, fill: true };
  return [
    padding,
    ...content.map((line, index): RenderedLine => ({
      text: `${index === 0 ? label : " ".repeat(cellWidth(label))}${line}`,
      role: "userMessage",
      fill: true,
    })),
    padding,
  ];
}

function legacyUserMessageLines(value: string, width: number, outputPad = 0): RenderedLine[] {
  const padding = { text: "", role: "userMessage" as const, fill: true };
  const edge = " ".repeat(1 + outputPad);
  const content = wrapCells(value, Math.max(1, width - cellWidth(edge) - outputPad - 1)).map((line) => ({
    text: `${edge}${line}`,
    role: "userMessage" as const,
    fill: true,
  }));
  return [padding, ...content, padding];
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

function transcriptLines(
  entries: readonly TranscriptEntry[],
  width: number,
  theme: Theme,
  toolRenderBlocks?: ReadonlyMap<string, ToolRenderSlots>,
  sessionRenderBlocks?: ReadonlyMap<string, RuntimeUiBlock>,
  semanticZones = false,
  messageMarkers = false,
  imageOptions: {
    resolveImage?: TranscriptRenderOptions["resolveImage"] | undefined;
    maxImageRows?: number | undefined;
    hiddenReasoningLabel?: string | undefined;
    hideReasoningBlock?: boolean | undefined;
    outputPad?: 0 | 1 | undefined;
    codeBlockIndent?: string | undefined;
    imageWidthCells?: number | undefined;
  } = {},
): RenderedLine[] {
  let imageCount = 0;
  let imageBytes = 0;
  const maxImageRows = Math.max(1, Math.min(200, imageOptions.maxImageRows ?? 12));
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
  return entries.flatMap((entry, index) => {
    const prefix = entryPrefix(
      entry,
      theme,
      entry.kind === "reasoning" && imageOptions.hideReasoningBlock === true
        ? imageOptions.hiddenReasoningLabel ?? "Thinking..."
        : imageOptions.hiddenReasoningLabel,
    );
    const role = entryRole(entry);
    const separator: RenderedLine[] = index === 0 ? [] : [{ text: "", role: "muted" }];
    const withSemanticZone = (lines: RenderedLine[]): RenderedLine[] => {
      if (!semanticZones || lines.length === 0) return lines;
      const selected = lines.map((line) => ({ ...line }));
      selected[0]!.semanticZoneStart = true;
      selected[selected.length - 1]!.semanticZoneEnd = true;
      return selected;
    };
    if (entry.kind === "startup") {
      return [...separator, ...startupLines(entry.expanded === true ? entry.text : entry.compactText ?? entry.text, width)];
    }
    if (entry.kind === "user") {
      const lines = [
        ...(entry.text === "" ? [] : messageMarkers
          ? userMessageLines(entry.text, width, theme, imageOptions.outputPad)
          : legacyUserMessageLines(entry.text, width, imageOptions.outputPad)),
        ...renderedImages(entry),
      ];
      return [...separator, ...withSemanticZone(lines)];
    }
    if (entry.kind === "reasoning" && imageOptions.hideReasoningBlock === true) {
      if (entries[index - 1]?.kind === "reasoning") return [];
      return [
        ...separator,
        { text: `${" ".repeat(imageOptions.outputPad ?? 0)}${prefix.trimEnd()}`, role: "muted" },
      ];
    }
    if (entry.kind === "reasoning" && entry.expanded !== true) {
      return [...separator, ...hangingLines(
        `${" ".repeat(imageOptions.outputPad ?? 0)}${prefix}`,
        collapsedReasoningSummary(entry.text),
        Math.max(1, width - (imageOptions.outputPad ?? 0)),
        "muted",
      )];
    }
    if (entry.kind === "assistant" || entry.kind === "reasoning") {
      const messagePrefix = `${" ".repeat(imageOptions.outputPad ?? 0)}${prefix}`;
      const lines = [
        ...(entry.text === "" ? [] : renderMarkdownMessageLines(
          messagePrefix,
          entry.text,
          Math.max(1, width - (imageOptions.outputPad ?? 0)),
          role,
          undefined,
          { codeBlockIndent: imageOptions.codeBlockIndent ?? "" },
        )),
        ...renderedImages(entry),
      ];
      const toolBearing = entry.hasToolCalls === true || entries[index + 1]?.kind === "tool";
      return [...separator, ...(entry.kind === "assistant" && !toolBearing ? withSemanticZone(lines) : lines)];
    }
    if (entry.extension !== undefined) {
      const custom = structuralLines(sessionRenderBlocks?.get(entry.id), width);
      if (custom !== undefined) return [...separator, ...custom, ...renderedImages(entry)];
      const label = entry.extension.customType;
      const fallback = entry.text === "" ? label : `${label}: ${entry.text}`;
      return [...separator, ...hangingLines(prefix, fallback, width, role), ...renderedImages(entry)];
    }
    if (entry.kind !== "tool") return [...separator, ...hangingLines(prefix, entry.text, width, role), ...renderedImages(entry)];
    const headerLine = toolHeaderLine(entry, width, theme);
    const failed = entry.status === "failed" || entry.status === "in_doubt";
    const output = liveToolLines(entry, Math.max(1, width - 5)) ?? syntaxReadLines(entry, width) ?? (entry.text === ""
      ? []
      : wrappedToolLines(entry.text, Math.max(1, width - 5), failed ? "error" : entry.status === "running" ? "toolRunning" : "code"));
    const input = entry.inputPreview === undefined || entry.inputPreview === ""
      ? []
      : wrappedToolLines(entry.inputPreview, Math.max(1, width - 5), toolInputRole);
    const outputLines = entry.status === "running"
      ? boundedToolLines(output, true, 6, width, theme)
      : output;
    const body = collapsedToolBody(entry, input, outputLines, width, theme);
    const custom = entry.callId === undefined ? undefined : toolRenderBlocks?.get(entry.callId);
    const customCall = structuralLines(custom?.call, width);
    const customResult = structuralLines(custom?.result, width);
    if (custom?.shell === "self") {
      const callLines = customCall ?? [headerLine];
      const resultLines = customResult ?? body;
      const selected = [...callLines, ...resultLines, ...renderedImages(entry)];
      return selected.length === 0 ? [] : [...separator, ...selected];
    }
    if (custom?.shell === "default") {
      const border: RenderedLine = { text: theme.glyphs.horizontal.repeat(width), role: "border" };
      return [
        ...separator,
        border,
        ...(customCall ?? [headerLine]),
        ...branchedToolLines(customResult ?? body, theme),
        border,
        ...renderedImages(entry),
      ];
    }
    if (customCall !== undefined || customResult !== undefined) {
      return [
        ...separator,
        ...(customCall ?? [headerLine]),
        ...(customResult ?? branchedToolLines(body, theme)),
        ...renderedImages(entry),
      ];
    }
    const border: RenderedLine = { text: theme.glyphs.horizontal.repeat(width), role: "border" };
    return [
      ...separator,
      border,
      headerLine,
      ...branchedToolLines(body, theme),
      border,
      ...renderedImages(entry),
    ];
  });
}

function editorBlock(
  text: string,
  cursor: number,
  label: string,
  width: number,
  maximumLines: number,
  paddingX = 0,
): EditorBlock {
  const safeLabel = sanitizeTerminalText(label);
  const edge = " ".repeat(paddingX);
  const prefix = `${edge}${safeLabel === "you" ? " " : ` ${safeLabel}> `}`;
  const contentWidth = Math.max(1, width - (paddingX * 2));
  const continuation = " ".repeat(cellWidth(prefix));
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

function footerStatChips(view: TuiViewState): { tokens: string[]; cost?: string; context?: string } {
  const usage = view.usage?.total;
  const tokens: string[] = [];
  if ((usage?.inputTokens ?? 0) > 0) tokens.push(`in ${formatFooterTokens(usage!.inputTokens!)}`);
  if ((usage?.outputTokens ?? 0) > 0) tokens.push(`out ${formatFooterTokens(usage!.outputTokens!)}`);
  if ((usage?.cacheReadTokens ?? 0) > 0) tokens.push(`cache ${formatFooterTokens(usage!.cacheReadTokens!)}`);
  if ((usage?.cacheWriteTokens ?? 0) > 0) tokens.push(`cache+ ${formatFooterTokens(usage!.cacheWriteTokens!)}`);
  if ((usage?.cacheWrite1hTokens ?? 0) > 0) tokens.push(`cache+1h ${formatFooterTokens(usage!.cacheWrite1hTokens!)}`);
  if (
    ((usage?.cacheReadTokens ?? 0) > 0 || (usage?.cacheWriteTokens ?? 0) > 0)
    && view.usage?.latestCacheHitRate !== undefined
  ) {
    const cacheIndex = tokens.findLastIndex((token) => token.startsWith("cache"));
    const hit = `${Math.round(view.usage.latestCacheHitRate)}%`;
    if (cacheIndex >= 0) tokens[cacheIndex] = `${tokens[cacheIndex]} (${hit})`;
    else tokens.push(`hit ${hit}`);
  }
  const numericCost = usage?.cost?.total ?? 0;
  const cost = numericCost > 0 || view.context.subscription === true
    ? `${formatUsageCost(usage?.cost, 3) ?? "$0"}${view.context.subscription === true ? " sub" : ""}`
    : undefined;
  const contextWindow = view.context.contextWindowTokens ?? 0;
  let context: string | undefined;
  if (contextWindow > 0) {
    const percent = view.context.contextTokens === undefined
      ? "?"
      : Math.min(999, view.context.contextTokens / contextWindow * 100).toFixed(1);
    const ratio = view.context.contextTokens === undefined ? 0 : Math.max(0, Math.min(1, view.context.contextTokens / contextWindow));
    const filled = Math.round(ratio * 4);
    context = `ctx [${"#".repeat(filled)}${"-".repeat(4 - filled)}] ${percent}%/${formatFooterTokens(contextWindow)}${view.context.autoCompaction === false ? "" : " auto"}`;
  }
  return {
    tokens,
    ...(cost === undefined ? {} : { cost }),
    ...(context === undefined ? {} : { context }),
  };
}

function activityText(view: TuiViewState): string | undefined {
  const activity = view.context.activity;
  if (activity === undefined || view.context.active !== true || view.context.workingVisible === false) return undefined;
  const now = Date.now();
  const elapsedSeconds = Math.max(0, now - activity.startedAt) / 1_000;
  const elapsed = elapsedSeconds < 10 ? `${elapsedSeconds.toFixed(1)}s` : `${Math.floor(elapsedSeconds)}s`;
  const configuredFrames = Array.isArray(view.workingIndicator?.frames)
    ? view.workingIndicator.frames.filter((frame): frame is string => typeof frame === "string").slice(0, 32)
    : [];
  const frames = configuredFrames.length > 0 ? configuredFrames : ["|", "/", "-", "\\"];
  const spinner = view.workingIndicator?.hidden === true ? undefined : truncateCells(byteTruncate(
    sanitizeTerminalText(frames[(view.context.activityFrame ?? 0) % frames.length]!).replaceAll("\n", " "),
    64,
  ), 16);
  const retry = activity.retryAt === undefined
    ? undefined
    : `retry in ${(Math.max(0, activity.retryAt - now) / 1_000).toFixed(1)}s${activity.attempt === undefined ? "" : ` (attempt ${activity.attempt})`}`;
  return [spinner, sanitizeTerminalText(view.context.workingMessage ?? activity.phase), elapsed, retry, activity.cancellable === true ? "Esc cancel" : undefined]
    .filter((value): value is string => value !== undefined && value !== "")
    .join(" · ");
}

function contextLocation(view: TuiViewState): string {
  return [
    view.context.workspace === undefined ? undefined : footerWorkspace(view.context.workspace),
    view.context.sessionName,
  ].filter((value): value is string => value !== undefined && value !== "").join(" • ");
}

function headerModel(view: TuiViewState): string {
  const model = view.context.model === undefined
    ? view.context.provider === undefined ? "no model" : `(${view.context.provider})`
    : view.context.provider !== undefined && (view.context.availableProviderCount ?? 0) > 1
      ? `(${view.context.provider}) ${view.context.model}`
      : view.context.model;
  if (view.context.thinkingSupported !== true) return model;
  const thinking = view.context.thinking === undefined || view.context.thinking === "off" ? "thinking off" : view.context.thinking;
  return `${model} · ${thinking}`;
}

function firstFitting(values: readonly string[], width: number): string {
  return values.find((value) => value !== "" && cellWidth(value) <= width) ?? "";
}

function contextLines(view: TuiViewState, width: number, reserveActivityRow = false): RenderedLine[] {
  const status = view.context.status ?? (view.context.active ? "streaming" : "idle");
  const statChips = footerStatChips(view);
  const failed = status === "failed" ? ["failed"] : [];
  const withoutHit = statChips.tokens.map((chip) => chip.replace(/ \(\d+%\)$/u, "")).filter((chip) => !chip.startsWith("hit "));
  const coreTokens = withoutHit.filter((chip) => chip.startsWith("in ") || chip.startsWith("out "));
  const tokenCandidates = [statChips.tokens, withoutHit, coreTokens]
    .map((chips) => [...failed, ...chips].join(" · "));
  const compactContext = statChips.context?.replace(/ctx \[[#-]+\] /u, "ctx ");
  const contextCandidates = [
    [statChips.cost, statChips.context],
    [statChips.cost, compactContext],
    [compactContext],
    [statChips.cost],
  ].map((chips) => chips.filter((value): value is string => value !== undefined && value !== "").join(" · "));
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
  const activity = activityText(view);
  const location = sanitizeTerminalText(contextLocation(view));
  let model = sanitizeTerminalText(headerModel(view));
  if (view.context.model !== undefined && cellWidth(model) > width) {
    const selected = view.context.thinkingSupported === true
      ? `${view.context.model} · ${view.context.thinking === undefined || view.context.thinking === "off" ? "thinking off" : view.context.thinking}`
      : view.context.model;
    model = sanitizeTerminalText(selected);
  }
  const extensionStatus = view.context.extensionStatus === undefined
    ? ""
    : sanitizeTerminalText(view.context.extensionStatus);
  const activityLines: RenderedLine[] = activity === undefined
    ? reserveActivityRow ? [{ text: "", role: "working" }] : []
    : [{ text: truncateCells(` ${activity}`, width), role: "working" }];
  if (width < 64) {
    const tokens = firstFitting(tokenCandidates, width);
    const context = firstFitting(contextCandidates, width);
    const metrics = [tokens, context].filter((value) => value !== "").join(" · ");
    const metricLines = metrics === ""
      ? []
      : cellWidth(metrics) <= width ? [metrics] : [tokens, context].filter((value) => value !== "");
    return [
      ...activityLines,
      ...(location === "" ? [] : [{ text: truncateCells(` ${location}`, width), role: "muted" as const }]),
      { text: truncateCells(model, width), role: detailsRole },
      ...metricLines.map((text): RenderedLine => ({ text, role: detailsRole })),
      ...(extensionStatus === "" ? [] : [{ text: truncateCells(extensionStatus, width), role: "muted" as const }]),
    ];
  }
  const separator = " · ";
  const combinations = tokenCandidates.flatMap((tokens) => contextCandidates.map((context) =>
    [tokens, context].filter((value) => value !== "").join(separator)));
  const metricBudget = Math.max(0, width - cellWidth(model) - 2);
  const selected = firstFitting(combinations, metricBudget)
    || firstFitting([...tokenCandidates, ...contextCandidates], metricBudget);
  const renderedModel = truncateCells(model, Math.max(1, width - cellWidth(selected) - (selected === "" ? 0 : 2)));
  const padding = selected === "" || renderedModel === ""
    ? ""
    : " ".repeat(Math.max(2, width - cellWidth(selected) - cellWidth(renderedModel)));
  const details = truncateCells(`${selected}${padding}${renderedModel}`, width);
  return [
    ...activityLines,
    ...(location === "" ? [] : [{ text: truncateCells(` ${location}`, width), role: "muted" as const }]),
    ...(details === "" ? [] : [{ text: details, role: detailsRole }]),
    ...(extensionStatus === "" ? [] : [{ text: truncateCells(extensionStatus, width), role: "muted" as const }]),
  ];
}

function styledSpan(span: MarkdownSpan, fallbackRole: ThemeRole, theme: Theme, hyperlinks: boolean): string {
  const rendered = style(theme, span.role ?? fallbackRole, span.text);
  return hyperlinks && span.hyperlink !== undefined ? trustedTerminalHyperlink(rendered, span.hyperlink) : rendered;
}

function styleFrameLine(line: RenderedLine, width: number, theme: Theme, hyperlinks = false): string {
  const semanticPrefix = `${line.semanticZoneStart === true ? OSC133_ZONE_START : ""}${line.semanticZoneEnd === true ? `${OSC133_ZONE_END}${OSC133_ZONE_FINAL}` : ""}`;
  if (line.raw === true) {
    const selected = truncateToWidth(line.text, width);
    return `${semanticPrefix}${selected}${" ".repeat(Math.max(0, width - visibleWidth(selected)))}`;
  }
  if (line.spans !== undefined) {
    const visible = line.spans.map((span) => span.text).join("");
    const styled = line.spans.map((span) => styledSpan(span, line.role, theme, hyperlinks)).join("");
    return `${semanticPrefix}${styled}${style(theme, line.role, " ".repeat(Math.max(0, width - cellWidth(visible))))}`;
  }
  return `${semanticPrefix}${style(theme, line.role, padCells(line.text, width))}`;
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
    false,
    options,
  );
  const text = lines.map((line) => {
    const semanticPrefix = `${line.semanticZoneStart === true ? OSC133_ZONE_START : ""}${line.semanticZoneEnd === true ? `${OSC133_ZONE_END}${OSC133_ZONE_FINAL}` : ""}`;
    if (line.spans === undefined) return `${semanticPrefix}${style(theme, line.role, line.fill === true ? padCells(line.text, width) : truncateCells(line.text, width))}`;
    const visible = line.spans.map((span) => span.text).join("");
    const styled = line.spans.map((span) => styledSpan(span, line.role, theme, options.hyperlinks === true)).join("");
    return `${semanticPrefix}${line.fill === true
      ? `${styled}${style(theme, line.role, " ".repeat(Math.max(0, width - cellWidth(visible))))}`
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
      if (column + selectedWidth > width) break;
      cells[column] = { text: grapheme, role, width: selectedWidth };
      for (let offset = 1; offset < selectedWidth; offset += 1) {
        cells[column + offset] = { text: "", role, width: 0, continuation: true };
      }
      column += selectedWidth;
    }
    if (column >= width) break;
  }
  for (let index = 0; index < width; index += 1) {
    if (cells[index] === undefined) cells[index] = { text: " ", role: line.role, width: 1 };
  }
  return cells;
}

function clearStyledCell(cells: Array<StyledCell | undefined>, column: number, role: ThemeRole): void {
  if (column < 0 || column >= cells.length) return;
  let head = column;
  while (head > 0 && cells[head]?.continuation === true) head -= 1;
  const width = Math.max(1, cells[head]?.width ?? 1);
  for (let offset = 0; offset < width && head + offset < cells.length; offset += 1) {
    cells[head + offset] = { text: " ", role, width: 1 };
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
  return { text: "", role: "muted", spans, fill: true };
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
    for (let index = column; index < end; index += 1) clearStyledCell(cells, index, fillRole);
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
      for (let offset = 0; offset < selectedWidth; offset += 1) clearStyledCell(cells, target + offset, role);
      cells[target] = { text: grapheme, role, width: selectedWidth };
      for (let offset = 1; offset < selectedWidth; offset += 1) {
        cells[target + offset] = { text: "", role, width: 0, continuation: true };
      }
      relativeColumn += selectedWidth;
    }
  }
  return {
    ...cellsLine(cells),
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
    imageWidthCells?: number;
    reserveActivityRow?: boolean;
  } = {},
): Frame {
  const width = frameDimension(size.columns, MAX_FRAME_COLUMNS, 80);
  const maximumHeight = frameDimension(size.rows, MAX_FRAME_ROWS, 24);
  const footer = view.runtimeFooterReplacement === undefined
    ? contextLines(view, width, options.reserveActivityRow === true)
    : [];
  let extensionHeaderLines: RenderedLine[] = view.rawHeaderReplacement !== undefined
    ? rawLines(view.rawHeaderReplacement, width, 8)
    : view.runtimeHeaderReplacement === undefined
    ? [
        ...(view.context.extensionHeaders ?? []).slice(-4).flatMap((header) =>
          wrapCells(header, Math.max(1, width - 2)).slice(0, 2).map((line) => ({
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
          wrapCells(extensionFooter, Math.max(1, width - 2)).slice(0, 2).map((line) => ({
            text: ` ${line}`,
            role: "muted" as const,
          }))),
        ...structuralSlotLines(view.runtimeFooterComponents, width, 8),
        ...rawSlotLines(view.rawFooterComponents, width, 8),
      ].slice(-8)
    : structuralLines(sanitizeRuntimeUiBlock(view.runtimeFooterReplacement, { width, maxLines: 8 }), width)?.slice(-8) ?? [];
  const editorWidth = Math.max(1, width - 1);
  const editorHeight = Math.min(6, Math.max(2, Math.floor(maximumHeight / 3)));
  const editor = structuralEditorBlock(view.editorBlock, editorWidth, editorHeight) ?? editorBlock(
    view.editorText,
    view.editorCursor,
    view.inputLabel,
    editorWidth,
    editorHeight,
    options.editorPaddingX ?? 0,
  );
  let widgetLines: RenderedLine[] = [
    ...(view.context.widgets ?? []).slice(-4).flatMap((widget) =>
      wrapCells(widget, Math.max(1, width - 2)).slice(0, 2).map((line) => ({
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
  const editorBorderRole: ThemeRole = view.context.thinking === undefined || view.context.thinking === "off"
    ? "accent"
    : view.context.thinking === "minimal" || view.context.thinking === "low"
      ? "success"
      : view.context.thinking === "medium"
        ? "accent"
        : "warning";
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
    maximumHeight - footer.length - inputImageLines.length - editor.lines.length - commandLines.length - 3,
  );
  let widgetAboveBudget = Math.min(widgetLines.length, Math.ceil(widgetBudget / 2));
  let widgetBelowBudget = Math.min(belowWidgetLines.length, widgetBudget - widgetAboveBudget);
  widgetAboveBudget += Math.min(widgetLines.length - widgetAboveBudget, widgetBudget - widgetAboveBudget - widgetBelowBudget);
  widgetBelowBudget += Math.min(belowWidgetLines.length - widgetBelowBudget, widgetBudget - widgetAboveBudget - widgetBelowBudget);
  widgetLines = widgetAboveBudget === 0 ? [] : widgetLines.slice(-widgetAboveBudget);
  belowWidgetLines = widgetBelowBudget === 0 ? [] : belowWidgetLines.slice(-widgetBelowBudget);
  const rawEditor = view.rawEditorBlock === undefined ? undefined : rawLines(view.rawEditorBlock, width, editorHeight + 2);
  const editorLines: RenderedLine[] = selectorActive ? [] : rawEditor === undefined ? [
    ...widgetLines,
    { text: theme.glyphs.horizontal.repeat(width), role: editorBorderRole },
    ...inputImageLines,
    ...editor.lines,
    { text: theme.glyphs.horizontal.repeat(width), role: editorBorderRole },
    ...belowWidgetLines,
    ...commandLines,
  ] : [
    ...widgetLines,
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
  let cursor = {
    row: headerOffset + middleHeight + widgetLines.length + (rawEditor === undefined ? 1 : 0)
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
    const queuedMessages = (view.queuedMessages ?? []).slice(-4).flatMap((message) => {
      const label = message.mode === "follow_up" ? "Follow-up" : "Steering";
      const imageCount = message.imageCount ?? message.images?.length ?? 0;
      const attachments = imageCount === 0 ? "" : `[${imageCount} image${imageCount === 1 ? "" : "s"}]`;
      const body = [sanitizeTerminalText(message.text), attachments].filter((value) => value.trim() !== "").join(" · ");
      return wrapCells(`${label}: ${body}`, width).slice(0, 2).map((text) => ({
        text,
        role: "muted" as const,
      }));
    });
    if ((view.queuedMessages?.length ?? 0) > 4) {
      queuedMessages.unshift({ text: `… ${(view.queuedMessages?.length ?? 0) - 4} earlier queued messages`, role: "muted" });
    }
    if (queuedMessages.length > 0) {
      queuedMessages.push({
        text: "↳ Alt+Up to restore the next queued message with its attachments",
        role: "muted",
      });
    }
    const all = [
      ...transcriptLines(view.transcript, width, theme, options.toolRenderBlocks, options.sessionRenderBlocks, false, true, {
      ...options,
      ...(view.hiddenReasoningLabel === undefined ? {} : { hiddenReasoningLabel: view.hiddenReasoningLabel }),
      }),
      ...(view.notice === undefined
        ? []
        : [{
            text: `${theme.glyphs.pending} ${sanitizeTerminalText(view.notice)}`,
            role: "muted" as const,
          }]),
      ...queuedMessages,
    ];
    const end = Math.max(0, all.length - Math.max(0, view.transcriptOffset));
    const start = Math.max(0, end - middleHeight);
    middle = all.slice(start, end);
    if (view.transcriptOffset > 0 && middle.length > 0) {
      middle[0] = { text: `${theme.glyphs.scroll} older transcript`, role: "accent" };
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
  if (options.compact === true && !overlayCursor) {
    cursor.row = headerOffset + middle.length + widgetLines.length + (rawEditor === undefined ? 1 : 0)
      + inputImageLines.length + (view.rawEditorBlock?.cursor?.row ?? editor.cursor.row);
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
    && (view.runtimeOverlays?.length ?? 0) === 0
    && view.runtimeOverlay === undefined
    && view.transcriptOffset === 0;
  const images = imagesAllowed ? terminalImagePlacements(selectedLines) : [];
  const styledLines = selectedLines.map((line) => styleFrameLine(line, width, theme, options.hyperlinks === true));
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
  return {
    text: styledLines.join("\n"),
    cursor: { row: Math.min(height, cursor.row + 1), column: Math.min(width, cursor.column + 1) },
    ...(images.length === 0 ? {} : { images }),
  };
}

export function pickerItem<T>(id: string, label: string, value: T, detail?: string): PickerItem<T> {
  return { id, label, value, ...(detail === undefined ? {} : { detail }) };
}
