export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const GREP_MAX_LINE_LENGTH = 500;
export interface TruncationOptions { maxLines?: number; maxBytes?: number; }
export interface TruncationResult { content: string; truncated: boolean; truncatedBy: "lines" | "bytes" | null; totalLines: number; totalBytes: number; outputLines: number; outputBytes: number; lastLinePartial: boolean; firstLineExceedsLimit: boolean; maxLines: number; maxBytes: number; }
const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
export function formatSize(value: number): string { return value < 1024 ? `${value}B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)}KB` : `${(value / 1024 / 1024).toFixed(1)}MB`; }
function result(content: string, original: string, maxLines: number, maxBytes: number, truncatedBy: "lines" | "bytes" | null, lastLinePartial = false, firstLineExceedsLimit = false, totalLines = original.split("\n").length): TruncationResult { return { content, truncated: truncatedBy !== null, truncatedBy, totalLines, totalBytes: bytes(original), outputLines: content === "" ? 0 : content.split("\n").length, outputBytes: bytes(content), lastLinePartial, firstLineExceedsLimit, maxLines, maxBytes }; }
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES, maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES, lines = content.split("\n");
  if (lines.length <= maxLines && bytes(content) <= maxBytes) return result(content, content, maxLines, maxBytes, null);
  if (bytes(lines[0] ?? "") > maxBytes) return result("", content, maxLines, maxBytes, "bytes", false, true);
  const kept: string[] = []; let count = 0; let reason: "lines" | "bytes" = "lines";
  for (let index = 0; index < lines.length && index < maxLines; index++) { const line = lines[index]!; const length = bytes(line) + (index > 0 ? 1 : 0); if (count + length > maxBytes) { reason = "bytes"; break; } kept.push(line); count += length; }
  if (kept.length >= maxLines) reason = "lines"; return result(kept.join("\n"), content, maxLines, maxBytes, reason);
}
function tailByBytes(text: string, limit: number): string {
  if (limit <= 0) return "";
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= limit) return text;
  let start = encoded.byteLength - limit;
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(encoded.subarray(start));
}
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES, maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES, lines = content.split("\n"); if (lines.length > 1 && lines.at(-1) === "") lines.pop(); const totalLines = lines.length;
  if (totalLines <= maxLines && bytes(content) <= maxBytes) return result(content, content, maxLines, maxBytes, null, false, false, totalLines);
  const kept: string[] = []; let count = 0; let reason: "lines" | "bytes" = "lines"; let partial = false;
  for (let index = lines.length - 1; index >= 0 && kept.length < maxLines; index--) { const line = lines[index]!; const length = bytes(line) + (kept.length > 0 ? 1 : 0); if (count + length > maxBytes) { reason = "bytes"; if (kept.length === 0) { kept.unshift(tailByBytes(line, maxBytes)); partial = true; } break; } kept.unshift(line); count += length; }
  if (kept.length >= maxLines) reason = "lines"; return result(kept.join("\n"), content, maxLines, maxBytes, reason, partial, false, totalLines);
}
export function truncateLine(line: string, maxChars = GREP_MAX_LINE_LENGTH): { text: string; wasTruncated: boolean } { return line.length <= maxChars ? { text: line, wasTruncated: false } : { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true }; }
