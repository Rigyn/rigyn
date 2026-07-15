import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Frame, PickerItem, TranscriptEntry, TuiViewState } from "./types.js";
import {
  sanitizeRuntimeUiBlock,
  type RuntimeUiBlock,
  type RuntimeUiOverlayLength,
  type RuntimeUiOverlayOptions,
  type RuntimeUiSpan,
} from "./components.js";
import type { Theme, ThemeRole } from "./theme.js";
import { style } from "./theme.js";
import { renderMarkdownMessageLines, type MarkdownSpan } from "./markdown.js";
import {
  MAX_TERMINAL_IMAGE_AGGREGATE_BYTES,
  MAX_TERMINAL_IMAGE_COUNT,
  terminalImageFallback,
  trustedTerminalHyperlink,
  type TerminalImagePlacement,
  type TerminalImageResolution,
  type TranscriptImage,
} from "./terminal-image.js";
import { cellWidth, graphemeWidth, padCells, sanitizeTerminalText, splitGraphemes, truncateCells, wrapCells } from "./unicode.js";

interface RenderedLine {
  text: string;
  role: ThemeRole;
  fill?: boolean;
  spans?: readonly MarkdownSpan[];
  semanticZoneStart?: boolean;
  semanticZoneEnd?: boolean;
  image?: Omit<TerminalImagePlacement, "row" | "column">;
  imageOffset?: number;
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

function entryPrefix(entry: TranscriptEntry, theme: Theme): string {
  if (entry.kind === "startup" || entry.kind === "user" || entry.kind === "assistant") return "";
  if (entry.kind === "reasoning") return `${theme.glyphs.assistant} summary `;
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

function toolRole(entry: TranscriptEntry): ThemeRole {
  if (entry.status === "running") return "toolRunning";
  if (entry.status === "completed") return "toolSuccess";
  if (entry.status === "failed" || entry.status === "in_doubt") return "toolError";
  return "toolPending";
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

  if (entry.title === "read") {
    const mediaType = metadata?.mediaType;
    if (typeof mediaType === "string" && mediaType !== "") {
      const width = metadataInteger(metadata, "width");
      const height = metadataInteger(metadata, "height");
      return width === undefined || height === undefined ? mediaType : `${mediaType} · ${width}×${height}`;
    }
    const shownLines = metadataInteger(metadata, "shownLines");
    if (shownLines !== undefined) return `${quantity(shownLines, "line")} read${metadata?.truncated === true ? " · limited" : ""}`;
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
    if (label !== undefined) return `${label}${metadata?.truncated === true ? " · limited" : ""}`;
  }
  const replacements = metadataInteger(metadata, "replacements");
  if (entry.title === "edit" && replacements !== undefined) return quantity(replacements, "replacement");
  const bytes = metadataInteger(metadata, "bytes");
  if (entry.title === "write" && bytes !== undefined) return `${quantity(bytes, "byte")} written`;
  return "done";
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
  const glyph = entry.status === "completed"
    ? theme.glyphs.success
    : entry.status === "failed"
      ? theme.glyphs.failure
      : entry.status === "in_doubt"
        ? "!"
        : entry.status === "running"
          ? theme.glyphs.pending
          : theme.glyphs.tool;
  const status = toolStatusText(entry);
  const badge = toolFileBadge(entry);
  const summary = entry.summary === undefined ? "" : sanitizeTerminalText(entry.summary).replaceAll("\n", " ").trim();
  const detail = [badge, summary].filter((part): part is string => part !== undefined && part !== "").join(" ");
  return {
    text: "",
    role: toolRole(entry),
    spans: boundedSpans([
      { text: `${glyph} `, role: toolRole(entry) },
      { text: toolDisplayName(entry.title), role: "title" },
      ...(detail === "" ? [] : [{ text: ` · ${detail}`, role: "muted" as const }]),
      ...(status === undefined ? [] : [{ text: ` · ${status}`, role: entry.status === "failed" ? "error" as const : "muted" as const }]),
    ], width),
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

function branchedToolLines(lines: readonly RenderedLine[], theme: Theme): RenderedLine[] {
  const unicode = theme.glyphs.horizontal === "─";
  return lines.map((line, index) => ({
    ...line,
    text: `  ${unicode ? (index === lines.length - 1 ? "└" : "│") : (index === lines.length - 1 ? "\\" : "|")} ${line.text.startsWith("   ") ? line.text.slice(3) : line.text}`,
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

function hangingLines(prefix: string, value: string, width: number, role: ThemeRole): RenderedLine[] {
  const safePrefix = truncateCells(prefix, Math.max(1, width - 1));
  const available = Math.max(1, width - cellWidth(safePrefix));
  const wrapped = wrapCells(value, available);
  return wrapped.map((line, index) => ({
    role,
    text: `${index === 0 ? safePrefix : " ".repeat(cellWidth(safePrefix))}${line}`,
  }));
}

function userMessageLines(value: string, width: number): RenderedLine[] {
  const padding = { text: "", role: "userMessage" as const, fill: true };
  const content = wrapCells(value, Math.max(1, width - 2)).map((line) => ({
    text: ` ${line}`,
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
  imageOptions: {
    resolveImage?: TranscriptRenderOptions["resolveImage"] | undefined;
    maxImageRows?: number | undefined;
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
      maxColumns: Math.max(1, Math.min(width - 2, 80)),
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
    const prefix = entryPrefix(entry, theme);
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
      const lines = [...(entry.text === "" ? [] : userMessageLines(entry.text, width)), ...renderedImages(entry)];
      return [...separator, ...withSemanticZone(lines)];
    }
    if (entry.kind === "reasoning" && entry.expanded !== true) {
      return [...separator, ...hangingLines(
        prefix,
        collapsedReasoningSummary(entry.text),
        width,
        "muted",
      )];
    }
    if (entry.kind === "assistant" || entry.kind === "reasoning") {
      const lines = [...(entry.text === "" ? [] : renderMarkdownMessageLines(prefix, entry.text, width, role)), ...renderedImages(entry)];
      const toolBearing = entry.hasToolCalls === true || entries[index + 1]?.kind === "tool";
      return [...separator, ...(entry.kind === "assistant" && !toolBearing ? withSemanticZone(lines) : lines)];
    }
    if (entry.extension !== undefined) {
      const custom = structuralLines(sessionRenderBlocks?.get(entry.id), width);
      if (custom !== undefined) return [...separator, ...custom];
      const label = entry.extension.type === "state"
        ? `${entry.extension.extensionId}@${entry.extension.schemaVersion}/${entry.extension.key}`
        : `${entry.extension.extensionId}/${entry.extension.key}`;
      const fallback = entry.extension.type === "state" || entry.text === ""
        ? label
        : `${label}: ${entry.text}`;
      return [...separator, ...hangingLines(prefix, fallback, width, role)];
    }
    if (entry.kind !== "tool") return [...separator, ...hangingLines(prefix, entry.text, width, role), ...renderedImages(entry)];
    const headerLine = toolHeaderLine(entry, width, theme);
    const failed = entry.status === "failed" || entry.status === "in_doubt";
    const output = entry.text === ""
      ? []
      : wrappedToolLines(entry.text, Math.max(1, width - 4), failed ? "error" : entry.status === "running" ? "toolRunning" : "code");
    const input = entry.inputPreview === undefined || entry.inputPreview === ""
      ? []
      : wrappedToolLines(entry.inputPreview, Math.max(1, width - 4), toolInputRole);
    const body = failed
      ? [...output, ...input]
      : [...input, ...output];
    let resultLines: RenderedLine[];
    if (body.length === 0) resultLines = [];
    else if (entry.expanded) resultLines = body;
    else {
      const tail = entry.title === "shell" || entry.title === "bash";
      const limit = tail
        ? 6
        : entry.title === "read"
          ? 6
          : entry.title === "edit" || entry.title === "write" || entry.title === "apply_patch"
            ? 8
            : 5;
      const visible = tail ? body.slice(-limit) : body.slice(0, limit);
      const remaining = body.length - visible.length;
      const omission = theme.glyphs.pending === "." ? "..." : "…";
      resultLines = [
        ...(remaining === 0 || !tail
          ? []
          : [{ text: `${omission} (${remaining} earlier lines)`, role: "muted" as const }]),
        ...visible,
        ...(remaining === 0 || tail
          ? []
          : [{ text: `${omission} (${remaining} more lines)`, role: "muted" as const }]),
      ];
    }
    const custom = entry.callId === undefined ? undefined : toolRenderBlocks?.get(entry.callId);
    const customCall = structuralLines(custom?.call, width);
    const customResult = structuralLines(custom?.result, width);
    if (customCall !== undefined || customResult !== undefined) {
      return [
        ...separator,
        ...(customCall ?? [headerLine]),
        ...(customResult ?? branchedToolLines(resultLines, theme)),
        ...renderedImages(entry),
      ];
    }
    const border: RenderedLine = { text: theme.glyphs.horizontal.repeat(width), role: "border" };
    return [
      ...separator,
      border,
      headerLine,
      ...branchedToolLines(resultLines, theme),
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
): EditorBlock {
  const safeLabel = sanitizeTerminalText(label);
  const prefix = safeLabel === "you" ? " " : ` ${safeLabel}> `;
  const continuation = " ".repeat(cellWidth(prefix));
  const graphemes = splitGraphemes(text);
  const lines: string[] = [prefix];
  let row = 0;
  let column = cellWidth(prefix);
  let cursorRow = 0;
  let cursorColumn = column;

  const nextLine = () => {
    lines.push(continuation);
    row += 1;
    column = cellWidth(continuation);
  };

  for (let index = 0; index <= graphemes.length; index += 1) {
    if (index === cursor) {
      if (column >= width) nextLine();
      cursorRow = row;
      cursorColumn = column;
    }
    if (index === graphemes.length) break;
    const grapheme = graphemes[index] ?? "";
    if (grapheme === "\n") {
      nextLine();
      continue;
    }
    const next = graphemeWidth(grapheme);
    if (column > cellWidth(continuation) && column + next > width) nextLine();
    lines[row] = `${lines[row] ?? ""}${grapheme}`;
    column += next;
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

function overlayLines(
  overlay: NonNullable<TuiViewState["overlay"]>,
  width: number,
  height: number,
  border = "─",
): { lines: RenderedLine[]; cursor: { row: number; column: number } } {
  const queryPrefix = overlay.queryLabel ?? "search> ";
  const queryWidth = Math.max(1, width - cellWidth(queryPrefix));
  const query = truncateCells(overlay.query.replaceAll("\n", " "), queryWidth);
  const searchable = overlay.query !== "" || overlay.items.length > 10;
  const top: RenderedLine[] = [
    { text: border.repeat(width), role: "accent" },
    { text: ` ${truncateCells(overlay.title, Math.max(1, width - 2))}:`, role: "accent" },
  ];
  if (overlay.status !== undefined) top.push({ text: truncateCells(overlay.status, width), role: "warning" });
  const queryRow = searchable ? top.length : 1;
  if (searchable) top.push({ text: `${queryPrefix}${query}`, role: "accent" });

  const fullAction = " ↑↓ navigate · Enter select · Esc/Ctrl+C cancel";
  const action = {
    text: cellWidth(fullAction) <= width ? fullAction : truncateCells(" Enter select · Esc cancel", width),
    role: "muted" as const,
  };
  const bottom: RenderedLine[] = [action, { text: border.repeat(width), role: "accent" }];
  const contentRoom = Math.max(1, height - top.length - bottom.length);
  const hints = (overlay.hints ?? []).flatMap((hint) => {
    const selected = hint.split(/\s+·\s+/u).filter((part) => !/^(?:↑\/?↓ navigate|Enter select|Esc(?:\/Ctrl\+C)? cancel)$/iu.test(part.trim()));
    return selected.length === 0 ? [] : [{ text: truncateCells(selected.join(" · "), width), role: "muted" as const }];
  });
  const hintCount = Math.min(hints.length, Math.max(0, contentRoom - 1));
  const visible = Math.max(1, contentRoom - hintCount);
  const content: RenderedLine[] = [];
  if (overlay.items.length === 0) {
    content.push(...wrapCells(`  ${overlay.emptyMessage ?? "No matches"}`, width).slice(0, visible).map((text) => ({
      text,
      role: "muted" as const,
    })));
  } else {
    const start = Math.max(0, Math.min(overlay.selected - visible + 1, overlay.items.length - visible));
    for (const [offset, item] of overlay.items.slice(start, start + visible).entries()) {
      const index = start + offset;
      const marker = index === overlay.selected ? ">" : " ";
      const detail = item.detail === undefined ? "" : ` — ${item.detail}`;
      content.push({
        text: `${marker} ${truncateCells(`${item.label}${detail}`, Math.max(1, width - 2))}`,
        role: index === overlay.selected ? "selection" : "muted",
      });
    }
  }
  const lines = [...top, ...hints.slice(0, hintCount), ...content, ...bottom];
  return {
    lines: lines.slice(0, height),
    cursor: searchable
      ? { row: queryRow, column: Math.min(width - 1, cellWidth(queryPrefix) + cellWidth(query)) }
      : { row: Math.min(height - 1, queryRow), column: 1 },
  };
}

function settingsOverlayLines(
  overlay: NonNullable<TuiViewState["overlay"]>,
  width: number,
  height: number,
  border: string,
): { lines: RenderedLine[]; cursor: { row: number; column: number } } {
  const queryPrefix = overlay.queryLabel ?? "> ";
  const query = truncateCells(overlay.query.replaceAll("\n", " "), Math.max(1, width - cellWidth(queryPrefix)));
  const top: RenderedLine[] = [
    { text: border.repeat(width), role: "accent" },
    { text: `${queryPrefix}${query}`, role: "accent" },
  ];
  if (overlay.status !== undefined) top.push({ text: truncateCells(overlay.status, width), role: "warning" });
  const fullHelp = `  ${overlay.hints?.at(-1) ?? "Enter/Space change · Esc close"}`;
  const help = cellWidth(fullHelp) <= width ? fullHelp : " Enter change · Esc close";
  const bottom: RenderedLine[] = [
    { text: truncateCells(help, width), role: "muted" },
    { text: border.repeat(width), role: "accent" },
  ];
  const contentRoom = Math.max(1, height - top.length - bottom.length);
  const visible = Math.max(1, Math.min(10, contentRoom));
  const start = Math.max(0, Math.min(overlay.selected - visible + 1, overlay.items.length - visible));
  const shown = overlay.items.slice(start, start + visible);
  const labelWidth = Math.min(Math.max(12, width - 10), Math.max(12, ...shown.map((item) => cellWidth(item.label))));
  const content: RenderedLine[] = [];
  if (shown.length === 0) content.push({ text: "  No matching settings", role: "muted" });
  for (const [offset, item] of shown.entries()) {
    const index = start + offset;
    const marker = index === overlay.selected ? "→" : " ";
    const label = padCells(truncateCells(item.label, labelWidth), labelWidth);
    content.push({
      text: truncateCells(`${marker} ${label}  ${item.detail ?? ""}`, width),
      role: index === overlay.selected ? "selection" : "muted",
    });
  }
  let remaining = Math.max(0, contentRoom - content.length);
  if (remaining > 0) {
    content.push({ text: `  (${overlay.items.length === 0 ? 0 : overlay.selected + 1}/${overlay.items.length})`, role: "muted" });
    remaining -= 1;
  }
  if (remaining > 0 && overlay.selectedDescription !== undefined) {
    content.push(...wrapCells(`  ${overlay.selectedDescription}`, width).slice(0, Math.min(2, remaining)).map((text) => ({
      text,
      role: "muted" as const,
    })));
  }
  const lines = [...top, ...content, ...bottom];
  return {
    lines: lines.slice(0, height),
    cursor: { row: 1, column: Math.min(width - 1, cellWidth(queryPrefix) + cellWidth(query)) },
  };
}

function modelOverlayLines(
  overlay: NonNullable<TuiViewState["overlay"]>,
  width: number,
  height: number,
  border: string,
): { lines: RenderedLine[]; cursor: { row: number; column: number } } {
  const queryPrefix = "> ";
  const query = truncateCells(overlay.query.replaceAll("\n", " "), Math.max(1, width - 2));
  const top: RenderedLine[] = [{ text: border.repeat(width), role: "accent" }];
  if (overlay.status !== undefined) top.push({ text: truncateCells(overlay.status, width), role: "warning" });
  const queryRow = top.length;
  top.push({ text: `${queryPrefix}${query}`, role: "accent" });
  const fullHelp = overlay.items.length === 0 ? " Esc cancel" : " ↑↓ navigate · Enter select · Esc cancel";
  const help = cellWidth(fullHelp) <= width ? fullHelp : " Enter select · Esc cancel";
  const bottom: RenderedLine[] = [
    { text: truncateCells(help, width), role: "muted" },
    { text: border.repeat(width), role: "accent" },
  ];
  const contentRoom = Math.max(1, height - top.length - bottom.length);
  const visible = Math.max(1, Math.min(10, contentRoom));
  const start = Math.max(0, Math.min(overlay.selected - visible + 1, overlay.items.length - visible));
  const content: RenderedLine[] = [];
  if (overlay.items.length === 0) {
    content.push(...wrapCells(`  ${overlay.emptyMessage ?? "No matching models"}`, width).slice(0, contentRoom).map((text) => ({
      text,
      role: "muted" as const,
    })));
  }
  for (const [offset, item] of overlay.items.slice(start, start + visible).entries()) {
    const index = start + offset;
    content.push({
      text: `${index === overlay.selected ? "→" : " "} ${truncateCells(item.label, Math.max(1, width - 2))}`,
      role: index === overlay.selected ? "selection" : "muted",
    });
  }
  const selected = overlay.items[overlay.selected];
  const remaining = Math.max(0, contentRoom - content.length);
  if (selected?.detail !== undefined && remaining > 0) {
    content.push(...wrapCells(`  ${selected.detail}`, width).slice(0, Math.min(2, remaining)).map((text) => ({
      text,
      role: "muted" as const,
    })));
  }
  const lines = [...top, ...content, ...bottom];
  return {
    lines: lines.slice(0, height),
    cursor: { row: queryRow, column: Math.min(width - 1, cellWidth(queryPrefix) + cellWidth(query)) },
  };
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
  return fromHome === "" ? "~" : `~${sep}${fromHome}`;
}

function footerStats(view: TuiViewState): string {
  const usage = view.usage?.total;
  const parts: string[] = [];
  if ((usage?.inputTokens ?? 0) > 0) parts.push(`↑${formatFooterTokens(usage!.inputTokens!)}`);
  if ((usage?.outputTokens ?? 0) > 0) parts.push(`↓${formatFooterTokens(usage!.outputTokens!)}`);
  if ((usage?.cacheReadTokens ?? 0) > 0) parts.push(`R${formatFooterTokens(usage!.cacheReadTokens!)}`);
  if ((usage?.cacheWriteTokens ?? 0) > 0) parts.push(`W${formatFooterTokens(usage!.cacheWriteTokens!)}`);
  if (
    ((usage?.cacheReadTokens ?? 0) > 0 || (usage?.cacheWriteTokens ?? 0) > 0)
    && view.usage?.latestCacheHitRate !== undefined
  ) parts.push(`CH${view.usage.latestCacheHitRate.toFixed(1)}%`);
  const numericCost = usage?.cost === undefined ? 0 : Number(usage.cost);
  if ((Number.isFinite(numericCost) && numericCost > 0) || view.context.subscription === true) {
    parts.push(`$${(Number.isFinite(numericCost) ? numericCost : 0).toFixed(3)}${view.context.subscription === true ? " (sub)" : ""}`);
  }
  const contextWindow = view.context.contextWindowTokens ?? 0;
  if (contextWindow > 0) {
    const percent = view.context.contextTokens === undefined
      ? "?"
      : Math.min(999, view.context.contextTokens / contextWindow * 100).toFixed(1);
    parts.push(`${percent}%/${formatFooterTokens(contextWindow)}${view.context.autoCompaction === false ? "" : " (auto)"}`);
  }
  return parts.join(" ");
}

function activityText(view: TuiViewState): string | undefined {
  const activity = view.context.activity;
  if (activity === undefined || view.context.active !== true || view.context.workingVisible === false) return undefined;
  const now = Date.now();
  const elapsedSeconds = Math.max(0, now - activity.startedAt) / 1_000;
  const elapsed = elapsedSeconds < 10 ? `${elapsedSeconds.toFixed(1)}s` : `${Math.floor(elapsedSeconds)}s`;
  const frames = ["|", "/", "-", "\\"];
  const spinner = frames[(view.context.activityFrame ?? 0) % frames.length]!;
  const retry = activity.retryAt === undefined
    ? undefined
    : `retry in ${(Math.max(0, activity.retryAt - now) / 1_000).toFixed(1)}s${activity.attempt === undefined ? "" : ` (attempt ${activity.attempt})`}`;
  return [spinner, sanitizeTerminalText(view.context.workingMessage ?? activity.phase), elapsed, retry, activity.cancellable === true ? "Esc cancel" : undefined]
    .filter((value): value is string => value !== undefined && value !== "")
    .join(" · ");
}

function contextLines(view: TuiViewState, width: number): RenderedLine[] {
  const status = view.context.status ?? (view.context.active ? "streaming" : "idle");
  const stats = footerStats(view);
  const modelName = view.context.model === undefined
    ? view.context.provider === undefined ? "no-model" : `(${view.context.provider})`
    : view.context.provider !== undefined && (view.context.availableProviderCount ?? 0) > 1
      ? `(${view.context.provider}) ${view.context.model}`
      : view.context.model;
  const withThinking = (name: string) => view.context.thinkingSupported === true
    ? `${name} • ${view.context.thinking === undefined || view.context.thinking === "off" ? "thinking off" : view.context.thinking}`
    : name;
  let right = withThinking(modelName);
  const left = status === "failed" ? ["failed", stats].filter(Boolean).join(" ") : stats;
  const availableRight = Math.max(0, width - cellWidth(left) - 2);
  if (view.context.model !== undefined && modelName !== view.context.model && cellWidth(right) > availableRight) {
    right = withThinking(view.context.model);
  }
  const renderedRight = truncateCells(right, availableRight);
  const padding = renderedRight === "" ? "" : " ".repeat(Math.max(2, width - cellWidth(left) - cellWidth(renderedRight)));
  const details = truncateCells(`${left}${padding}${renderedRight}`, width);
  const location = [
    view.context.workspace === undefined ? undefined : footerWorkspace(view.context.workspace),
    view.context.sessionName,
  ].filter((value): value is string => value !== undefined && value !== "").join(" • ");
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
  return [
    ...(activityText(view) === undefined
      ? []
      : [{ text: truncateCells(` ${activityText(view)!}`, width), role: "working" as const }]),
    ...(location === ""
      ? []
      : [{ text: truncateCells(` ${sanitizeTerminalText(location)}`, width), role: "muted" as const }]),
    { text: truncateCells(details, width), role: detailsRole },
    ...(view.context.extensionStatus === undefined || view.context.extensionStatus === ""
      ? []
      : [{ text: truncateCells(sanitizeTerminalText(view.context.extensionStatus), width), role: "muted" as const }]),
  ];
}

function styledSpan(span: MarkdownSpan, fallbackRole: ThemeRole, theme: Theme, hyperlinks: boolean): string {
  const rendered = style(theme, span.role ?? fallbackRole, span.text);
  return hyperlinks && span.hyperlink !== undefined ? trustedTerminalHyperlink(rendered, span.hyperlink) : rendered;
}

function styleFrameLine(line: RenderedLine, width: number, theme: Theme, hyperlinks = false): string {
  const semanticPrefix = `${line.semanticZoneStart === true ? OSC133_ZONE_START : ""}${line.semanticZoneEnd === true ? `${OSC133_ZONE_END}${OSC133_ZONE_FINAL}` : ""}`;
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
  const spans = line.spans ?? [{ text: line.text, role: line.role }];
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
  } = {},
): Frame {
  const width = frameDimension(size.columns, MAX_FRAME_COLUMNS, 80);
  const maximumHeight = frameDimension(size.rows, MAX_FRAME_ROWS, 24);
  const footer = contextLines(view, width);
  let extensionHeaderLines: RenderedLine[] = (view.context.extensionHeaders ?? []).slice(-4).flatMap((header) =>
    wrapCells(header, Math.max(1, width - 2)).slice(0, 2).map((line) => ({
      text: ` ${line}`,
      role: "accent" as const,
    }))).slice(-4);
  let extensionFooterLines: RenderedLine[] = (view.context.extensionFooters ?? []).slice(-4).flatMap((extensionFooter) =>
    wrapCells(extensionFooter, Math.max(1, width - 2)).slice(0, 2).map((line) => ({
      text: ` ${line}`,
      role: "muted" as const,
    }))).slice(-4);
  const editor = editorBlock(
    view.editorText,
    view.editorCursor,
    view.inputMode === "follow_up" ? "follow" : view.inputLabel,
    Math.max(1, width - 1),
    Math.min(6, Math.max(2, Math.floor(maximumHeight / 3))),
  );
  const widgetLines: RenderedLine[] = (view.context.widgets ?? []).slice(-4).flatMap((widget) =>
    wrapCells(widget, Math.max(1, width - 2)).slice(0, 2).map((line) => ({
      text: ` ${line}`,
      role: "accent" as const,
    })));
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
  const editorLines: RenderedLine[] = selectorActive ? [] : [
    ...widgetLines,
    { text: theme.glyphs.horizontal.repeat(width), role: editorBorderRole },
    ...inputImageLines,
    ...editor.lines,
    { text: theme.glyphs.horizontal.repeat(width), role: editorBorderRole },
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
  let middle: RenderedLine[];
  let cursor = {
    row: extensionHeaderLines.length + middleHeight + widgetLines.length + 1 + inputImageLines.length + editor.cursor.row,
    column: editor.cursor.column,
  };
  let overlayCursor = false;

  if (view.overlay !== undefined && view.overlay.inline !== true) {
    const overlay = view.overlay.settings === true
      ? settingsOverlayLines(view.overlay, width, middleHeight, theme.glyphs.horizontal)
      : view.overlay.pickerKind === "model"
        ? modelOverlayLines(view.overlay, width, middleHeight, theme.glyphs.horizontal)
        : overlayLines(view.overlay, width, middleHeight, theme.glyphs.horizontal);
    middle = overlay.lines;
    cursor = { row: extensionHeaderLines.length + overlay.cursor.row, column: overlay.cursor.column };
    overlayCursor = true;
  } else if (view.runtimeComponent !== undefined) {
    const block = sanitizeRuntimeUiBlock(view.runtimeComponent, { width });
    middle = structuralLines(block, width)?.slice(0, middleHeight) ?? [];
    cursor = {
      row: extensionHeaderLines.length + Math.min(Math.max(0, middle.length - 1), block.cursor?.row ?? 0),
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
      ...transcriptLines(view.transcript, width, theme, options.toolRenderBlocks, options.sessionRenderBlocks, false, options),
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
  if (options.compact === true && !overlayCursor) {
    cursor.row = extensionHeaderLines.length + middle.length + widgetLines.length + 1 + inputImageLines.length + editor.cursor.row;
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
  return {
    text: selectedLines.map((line) => styleFrameLine(line, width, theme, options.hyperlinks === true)).join("\n"),
    cursor: { row: Math.min(height, cursor.row + 1), column: Math.min(width, cursor.column + 1) },
    ...(images.length === 0 ? {} : { images }),
  };
}

export function pickerItem<T>(id: string, label: string, value: T, detail?: string): PickerItem<T> {
  return { id, label, value, ...(detail === undefined ? {} : { detail }) };
}
