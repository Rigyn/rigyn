export const TOOL_MAX_LINES = 2_000;
export const TOOL_MAX_BYTES = 50 * 1024;
export const DEFAULT_MAX_LINES = TOOL_MAX_LINES;
export const DEFAULT_MAX_BYTES = TOOL_MAX_BYTES;

export interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

export interface TruncationResult {
  content: string;
  truncated: boolean;
  wasTruncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  maxLines: number;
  maxBytes: number;
  firstLineExceedsLimit: boolean;
  lastLinePartial: boolean;
}

export type ToolTruncation = TruncationResult;

function bound(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return result;
}

function utf8Prefix(value: string, maximum: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximum) return value;
  let end = maximum;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function utf8Tail(value: string, maximum: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximum) return value;
  let start = bytes.length - maximum;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function truncate(value: string, options: TruncationOptions, tail: boolean): TruncationResult {
  const maxLines = bound(options.maxLines, DEFAULT_MAX_LINES, "maxLines");
  const maxBytes = bound(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  const lines = (value.endsWith("\n") ? value.slice(0, -1) : value).split("\n");
  const totalBytes = Buffer.byteLength(value, "utf8");
  const byLines = lines.length > maxLines;
  const selectedLines = maxLines === 0
    ? []
    : byLines
      ? tail ? lines.slice(-maxLines) : lines.slice(0, maxLines)
      : lines;
  const lineContent = selectedLines.join("\n");
  const byBytes = Buffer.byteLength(lineContent, "utf8") > maxBytes
    || (!byLines && totalBytes > maxBytes);
  const truncated = byLines || byBytes;
  const content = truncated
    ? byBytes
      ? tail ? utf8Tail(lineContent, maxBytes) : utf8Prefix(lineContent, maxBytes)
      : lineContent
    : value;
  const outputBytes = Buffer.byteLength(content, "utf8");
  return {
    content,
    truncated,
    wasTruncated: truncated,
    truncatedBy: byBytes ? "bytes" : byLines ? "lines" : null,
    totalLines: lines.length,
    totalBytes,
    outputLines: selectedLines.length === 0
      ? 0
      : truncated ? content.split("\n").length : lines.length,
    outputBytes,
    maxLines,
    maxBytes,
    firstLineExceedsLimit: !tail && Buffer.byteLength(lines[0] ?? "", "utf8") > maxBytes,
    lastLinePartial: tail && Buffer.byteLength(lines.at(-1) ?? "", "utf8") > maxBytes,
  };
}

export function truncateHead(value: string, options: TruncationOptions = {}): TruncationResult {
  return truncate(value, options, false);
}

export function truncateTail(value: string, options: TruncationOptions = {}): TruncationResult {
  return truncate(value, options, true);
}

export const truncateToolHead = truncateHead;
export const truncateToolTail = truncateTail;

export function truncateLine(value: string, maxLength: number): { text: string; wasTruncated: boolean } {
  if (!Number.isSafeInteger(maxLength) || maxLength < 0) throw new RangeError("maxLength must be non-negative");
  return value.length <= maxLength
    ? { text: value, wasTruncated: false }
    : { text: `${value.slice(0, maxLength)}... [truncated]`, wasTruncated: true };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
}
