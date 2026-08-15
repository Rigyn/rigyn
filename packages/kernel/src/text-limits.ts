interface TruncationBounds {
  maxLines: number;
  maxBytes: number;
}

interface TruncationMeasurements {
  totalBytes: number;
  totalLines: number;
  outputBytes: number;
  outputLines: number;
}

export interface TruncationOptions extends TruncationBounds {}

export interface TruncationResult extends TruncationBounds, TruncationMeasurements {
  content: string;
  firstLineExceedsLimit: boolean;
  lastLinePartial: boolean;
  truncated: boolean;
  truncatedBy: "bytes" | "lines" | null;
}

function lineCount(value: string): number {
  if (value === "") return 0;
  const newlineCount = value.split("\n").length - 1;
  return newlineCount + (value.endsWith("\n") ? 0 : 1);
}

function validHead(bytes: Uint8Array, maximum: number): string {
  if (bytes.byteLength <= maximum) return new TextDecoder().decode(bytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = Math.max(0, maximum);
  while (end > 0) {
    try { return decoder.decode(bytes.subarray(0, end)); } catch { end -= 1; }
  }
  return "";
}

function validTail(bytes: Uint8Array, maximum: number): string {
  if (bytes.byteLength <= maximum) return new TextDecoder().decode(bytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let start = Math.max(0, bytes.byteLength - maximum);
  while (start < bytes.byteLength) {
    try { return decoder.decode(bytes.subarray(start)); } catch { start += 1; }
  }
  return "";
}

function headLines(value: string, maximum: number): string {
  if (maximum <= 0 || value === "") return "";
  let offset = 0;
  let lines = 0;
  while (lines < maximum) {
    const newline = value.indexOf("\n", offset);
    if (newline < 0) return value;
    lines += 1;
    offset = newline + 1;
  }
  return value.slice(0, Math.max(0, offset - 1));
}

function tailLines(value: string, maximum: number): string {
  if (maximum <= 0 || value === "") return "";
  const trailing = value.endsWith("\n");
  let offset = trailing ? value.length - 1 : value.length;
  let lines = 0;
  while (offset > 0 && lines < maximum) {
    const newline = value.lastIndexOf("\n", offset - 1);
    lines += 1;
    if (newline < 0) return value;
    offset = newline;
  }
  const selected = value.slice(offset + 1, trailing ? value.length - 1 : value.length);
  return selected;
}

function truncate(value: string, options: TruncationOptions, direction: "head" | "tail"): TruncationResult {
  const maxLines = Math.max(0, Math.floor(options.maxLines));
  const maxBytes = Math.max(0, Math.floor(options.maxBytes));
  const totalLines = lineCount(value);
  const totalBytes = Buffer.byteLength(value, "utf8");
  const firstLine = value.split("\n", 1)[0] ?? "";
  let content = value;
  let truncatedBy: TruncationResult["truncatedBy"] = null;

  if (totalLines > maxLines) {
    content = direction === "head" ? headLines(value, maxLines) : tailLines(value, maxLines);
    truncatedBy = "lines";
  }
  const selectedBytes = Buffer.from(content, "utf8");
  let byteTruncated = false;
  if (selectedBytes.byteLength > maxBytes) {
    content = direction === "head" ? validHead(selectedBytes, maxBytes) : validTail(selectedBytes, maxBytes);
    truncatedBy = "bytes";
    byteTruncated = true;
  }

  return {
    content,
    truncated: truncatedBy !== null,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: lineCount(content),
    outputBytes: Buffer.byteLength(content, "utf8"),
    lastLinePartial: direction === "tail" && byteTruncated,
    firstLineExceedsLimit: Buffer.byteLength(firstLine, "utf8") > maxBytes,
    maxLines,
    maxBytes,
  };
}

export function truncateHead(value: string, options: TruncationOptions): TruncationResult {
  return truncate(value, options, "head");
}

export function truncateTail(value: string, options: TruncationOptions): TruncationResult {
  return truncate(value, options, "tail");
}
