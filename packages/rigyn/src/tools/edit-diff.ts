import {
  createTwoFilesPatch,
  FILE_HEADERS_ONLY,
  structuredPatch,
} from "diff";

export interface EditDiffResult {
  diff: string;
  firstChangedLine: number | undefined;
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const firstLf = content.indexOf("\n");
  if (firstLf < 0) return "\n";
  return firstLf > 0 && content[firstLf - 1] === "\r" ? "\r\n" : "\n";
}

export function normalizeToLF(content: string): string {
  return content.replace(/\r\n?|\n/gu, "\n");
}

export function restoreLineEndings(content: string, ending: "\r\n" | "\n"): string {
  const normalized = normalizeToLF(content);
  return ending === "\r\n" ? normalized.replaceAll("\n", "\r\n") : normalized;
}

export function generateUnifiedPatch(
  path: string,
  before: string,
  after: string,
  contextLines = 4,
): string {
  return createTwoFilesPatch(path, path, before, after, undefined, undefined, {
    context: contextLines,
    headerOptions: FILE_HEADERS_ONLY,
  });
}

export function generateDiffString(
  before: string,
  after: string,
  contextLines = 4,
): EditDiffResult {
  const patch = structuredPatch("", "", before, after, "", "", { context: contextLines });
  if (patch.hunks.length === 0) return { diff: "", firstChangedLine: undefined };

  const width = String(Math.max(before.split("\n").length, after.split("\n").length)).length;
  const lines: string[] = [];
  let previousOldEnd = 0;
  let firstChangedLine: number | undefined;

  for (const hunk of patch.hunks) {
    if (hunk.oldStart > previousOldEnd + 1) lines.push(` ${"".padStart(width, " ")} ...`);
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const value of hunk.lines) {
      const marker = value[0];
      const text = value.slice(1);
      if (marker === "+") {
        firstChangedLine ??= newLine;
        lines.push(`+${String(newLine).padStart(width, " ")} ${text}`);
        newLine += 1;
      } else if (marker === "-") {
        firstChangedLine ??= newLine;
        lines.push(`-${String(oldLine).padStart(width, " ")} ${text}`);
        oldLine += 1;
      } else if (marker === " ") {
        lines.push(` ${String(oldLine).padStart(width, " ")} ${text}`);
        oldLine += 1;
        newLine += 1;
      }
    }
    previousOldEnd = hunk.oldStart + hunk.oldLines - 1;
  }

  const totalOldLines = before === "" ? 0 : before.split("\n").length - (before.endsWith("\n") ? 1 : 0);
  if (previousOldEnd < totalOldLines) lines.push(` ${"".padStart(width, " ")} ...`);
  return { diff: lines.join("\n"), firstChangedLine };
}
