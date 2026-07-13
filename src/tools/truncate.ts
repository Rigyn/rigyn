export const TOOL_MAX_LINES = 2_000;
export const TOOL_MAX_BYTES = 50 * 1024;

export interface ToolTruncation {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  firstLineExceedsLimit: boolean;
  lastLinePartial: boolean;
  maxLines: number;
  maxBytes: number;
}

function lines(value: string): string[] {
  if (value === "") return [];
  const result = value.split("\n");
  if (value.endsWith("\n")) result.pop();
  return result;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes}B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)}KB`;
  return `${(bytes / 1_048_576).toFixed(1)}MB`;
}

function result(
  content: string,
  source: string,
  truncatedBy: ToolTruncation["truncatedBy"],
  options: { firstLineExceedsLimit?: boolean; lastLinePartial?: boolean; maxLines: number; maxBytes: number },
): ToolTruncation {
  return {
    content,
    truncated: truncatedBy !== null,
    truncatedBy,
    totalLines: lines(source).length,
    totalBytes: Buffer.byteLength(source, "utf8"),
    outputLines: lines(content).length,
    outputBytes: Buffer.byteLength(content, "utf8"),
    firstLineExceedsLimit: options.firstLineExceedsLimit ?? false,
    lastLinePartial: options.lastLinePartial ?? false,
    maxLines: options.maxLines,
    maxBytes: options.maxBytes,
  };
}

export function truncateToolHead(
  source: string,
  options: { maxLines?: number; maxBytes?: number } = {},
): ToolTruncation {
  const maxLines = options.maxLines ?? TOOL_MAX_LINES;
  const maxBytes = options.maxBytes ?? TOOL_MAX_BYTES;
  const sourceLines = lines(source);
  if (sourceLines.length <= maxLines && Buffer.byteLength(source, "utf8") <= maxBytes) {
    return result(source, source, null, { maxLines, maxBytes });
  }
  if (Buffer.byteLength(sourceLines[0] ?? "", "utf8") > maxBytes) {
    return result("", source, "bytes", { maxLines, maxBytes, firstLineExceedsLimit: true });
  }

  const selected: string[] = [];
  let bytes = 0;
  let by: "lines" | "bytes" = "lines";
  for (const line of sourceLines.slice(0, maxLines)) {
    const needed = Buffer.byteLength(line, "utf8") + (selected.length === 0 ? 0 : 1);
    if (bytes + needed > maxBytes) {
      by = "bytes";
      break;
    }
    selected.push(line);
    bytes += needed;
  }
  if (selected.length === maxLines) by = "lines";
  return result(selected.join("\n"), source, by, { maxLines, maxBytes });
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

export function truncateToolTail(
  source: string,
  options: { maxLines?: number; maxBytes?: number } = {},
): ToolTruncation {
  const maxLines = options.maxLines ?? TOOL_MAX_LINES;
  const maxBytes = options.maxBytes ?? TOOL_MAX_BYTES;
  const sourceLines = lines(source);
  if (sourceLines.length <= maxLines && Buffer.byteLength(source, "utf8") <= maxBytes) {
    return result(source, source, null, { maxLines, maxBytes });
  }

  const selected: string[] = [];
  let bytes = 0;
  let by: "lines" | "bytes" = "lines";
  let partial = false;
  for (let index = sourceLines.length - 1; index >= 0 && selected.length < maxLines; index -= 1) {
    const line = sourceLines[index]!;
    const needed = Buffer.byteLength(line, "utf8") + (selected.length === 0 ? 0 : 1);
    if (bytes + needed > maxBytes) {
      by = "bytes";
      if (selected.length === 0) {
        const clipped = utf8Tail(line, maxBytes);
        selected.unshift(clipped);
        partial = true;
      }
      break;
    }
    selected.unshift(line);
    bytes += needed;
  }
  if (selected.length === maxLines) by = "lines";
  return result(selected.join("\n"), source, by, { maxLines, maxBytes, lastLinePartial: partial });
}
