import type { EventEnvelope, RuntimeEvent } from "../core/events.js";
import type { JsonValue } from "../core/json.js";
import type { CanonicalMessage, ImageBlock, NormalizedUsage, TextBlock, ToolResultBlock } from "../core/types.js";
import { parse as parsePartialJson } from "partial-json";
import type { CustomMessageEntry } from "../extensions/session-contract.js";
import {
  CACHE_MISS_NOTICE_COST,
  CACHE_MISS_NOTICE_TOKENS,
  cacheBoundaryFingerprint,
  observeCacheRequest,
  type CacheRequestBaseline,
} from "../core/cache-diagnostics.js";
import {
  addCompleteNormalizedUsage,
  addNormalizedUsage,
  normalizedContextTokens,
  normalizedTotalTokens,
} from "../core/usage.js";
import { normalizedCacheHitRate } from "../core/cache-usage.js";
import { parseSkillBlock } from "../core/skill-block.js";
import type { TranscriptImage } from "./terminal-image.js";
import { projectRuntimeToolRenderResult } from "./components.js";
import { projectRuntimeDirectToolRenderContent } from "./tool-render-view.js";
import type {
  TranscriptEntry,
  TuiContext,
  TuiLatestCacheUsage,
  TuiLimits,
  TuiSessionEntry,
  TuiSessionShell,
  TuiSessionSummary,
  TuiTranscriptItem,
  TuiUsageSummary,
} from "./types.js";
import { byteTail, byteTruncate, sanitizeTerminalText } from "./unicode.js";

function messageText(message: CanonicalMessage, imageMarkers = true): string {
  if (message.displayText !== undefined) return message.displayText;
  return message.content.flatMap((block) => {
    if (block.type === "text") return [block.text];
    if (block.type === "image") return imageMarkers ? [`[Image: ${block.mediaType}]`] : [];
    if (block.type === "tool_result") return [block.content];
    return [];
  }).join("\n");
}

function directMessageImages(message: CanonicalMessage): TranscriptImage[] {
  let index = 0;
  return message.content.flatMap((block) => {
    if (block.type !== "image") return [];
    const selected = { key: `${message.id}:image:${index}`, block };
    index += 1;
    return [selected];
  });
}

function toolResultImages(callId: string, images: readonly import("../core/types.js").ImageBlock[] | undefined): TranscriptImage[] {
  return (images ?? []).map((block, index) => ({ key: `tool:${callId}:image:${index}`, block }));
}

function customMessageText(entry: CustomMessageEntry): string {
  if (typeof entry.content === "string") return entry.content;
  return entry.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}

function customMessageImages(entry: CustomMessageEntry): TranscriptImage[] {
  if (typeof entry.content === "string") return [];
  return entry.content.flatMap((block, index) => block.type === "image"
    ? [{ key: `${entry.id}:image:${index}`, block: { type: "image", mediaType: block.mimeType, data: block.data } }]
    : []);
}

function errorMessage(event: Extract<RuntimeEvent, { type: "run_failed" }>): string {
  return event.error.message;
}

function eventKey(envelope: EventEnvelope, suffix: string): string {
  return `${envelope.runId ?? envelope.threadId}:${suffix}`;
}

function formatUsageTokens(value: number): string {
  return value.toLocaleString("en-US");
}

function reportedContextLowerBound(usage: NormalizedUsage): number | undefined {
  const values = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
    .filter((value): value is number => value !== undefined);
  if (values.length === 0) return undefined;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : undefined;
}

/** Formats the provider-observed summarization request without inventing missing counters. */
export function formatCompactionUsageReceipt(usage: NormalizedUsage | undefined): string | undefined {
  if (usage === undefined) return undefined;
  const prompt = normalizedContextTokens(usage);
  const output = usage.outputTokens;
  if (
    prompt === undefined &&
    output === undefined &&
    usage.cacheReadTokens === undefined &&
    usage.cacheWriteTokens === undefined
  ) return undefined;
  const cacheRead = usage.cacheReadTokens === undefined
    ? "cache read telemetry unavailable for summary"
    : `cache read ${formatUsageTokens(usage.cacheReadTokens)}${
        prompt === undefined || prompt === 0
          ? ""
          : ` (${(usage.cacheReadTokens / prompt * 100).toFixed(1)}% of this request)`
      }`;
  const cacheWrite = usage.cacheWriteTokens === undefined
    ? "cache write telemetry unavailable for summary"
    : `cache write ${formatUsageTokens(usage.cacheWriteTokens)}`;
  return [
    "summary request",
    prompt === undefined ? "prompt not reported" : `prompt ${formatUsageTokens(prompt)}`,
    cacheRead,
    cacheWrite,
    output === undefined ? "output not reported" : `output ${formatUsageTokens(output)}`,
  ].join(" · ");
}

function boundedSummaryText(value: string, maximumBytes: number): string {
  return byteTruncate(sanitizeTerminalText(value), Math.min(128 * 1024, maximumBytes));
}

const mutationTools = new Set(["write", "edit", "apply_patch"]);
const conciseMutationTools = new Set(["write", "edit"]);
const shellTools = new Set(["shell", "bash"]);
const humanizedToolInputs = new Set(["shell", "bash", "read", "grep", "find", "ls", "write", "edit", "apply_patch"]);
const USER_SHELL_MESSAGE_PREFIX = "[User shell command]\n";

export type TuiCacheReadPriceSource = (
  provider: string,
  model: string,
  promptTokens: number,
) => number | undefined;

function boundedToolPreview(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  const safe = sanitizeTerminalText(encoded.length <= maximumBytes
    ? value
    : utf8HeadSample(encoded, maximumBytes));
  if (encoded.length <= maximumBytes && Buffer.byteLength(safe, "utf8") <= maximumBytes) return safe;
  const marker = "\n… truncated";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  return markerBytes < maximumBytes
    ? `${byteTruncate(safe, maximumBytes - markerBytes)}${marker}`
    : byteTruncate(safe, maximumBytes);
}

function boundedToolTailPreview(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  const safe = sanitizeTerminalText(encoded.length <= maximumBytes
    ? value
    : utf8TailSample(encoded, maximumBytes));
  if (encoded.length <= maximumBytes && Buffer.byteLength(safe, "utf8") <= maximumBytes) return safe;
  const marker = "… earlier output truncated\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  return markerBytes < maximumBytes
    ? `${marker}${byteTail(safe, maximumBytes - markerBytes)}`
    : byteTail(safe, maximumBytes);
}

const ROLLING_TOOL_PREVIEW_MARKER = "\n… earlier input hidden; newest input follows\n";
const ROLLING_TOOL_PREVIEW_SHORT_MARKER = "\n… truncated\n";
const ROLLING_TOOL_PREVIEW_JSON_STRING_MARKER = JSON.stringify(ROLLING_TOOL_PREVIEW_MARKER).slice(1, -1);
const TOOL_PREVIEW_SAMPLE_GUARD_BYTES = 4 * 1024;
const LIVE_TOOL_CALL_PREVIEW_MAX_BYTES = 4 * 1024;

function utf8HeadSample(encoded: Buffer, retainedBytes: number): string {
  let end = Math.min(
    encoded.length,
    Math.max(0, retainedBytes) + TOOL_PREVIEW_SAMPLE_GUARD_BYTES,
  );
  if (end < encoded.length) {
    let lead = end - 1;
    while (lead >= 0 && (encoded[lead]! & 0xc0) === 0x80) lead -= 1;
    const leadByte = lead < 0 ? 0 : encoded[lead]!;
    const expected = leadByte < 0x80 ? 1
      : leadByte < 0xe0 ? 2
        : leadByte < 0xf0 ? 3
          : 4;
    if (end - lead < expected) end = Math.max(0, lead);
  }
  return encoded.subarray(0, end).toString("utf8");
}

function utf8TailSample(encoded: Buffer, retainedBytes: number): string {
  let start = Math.max(
    0,
    encoded.length - Math.max(0, retainedBytes) - TOOL_PREVIEW_SAMPLE_GUARD_BYTES,
  );
  while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString("utf8");
}

function boundedSanitizedTail(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const encoded = Buffer.from(value, "utf8");
  const sampled = encoded.length <= maximumBytes
    ? value
    : utf8TailSample(encoded, maximumBytes);
  return byteTail(sanitizeTerminalText(sampled), maximumBytes);
}

function rollingToolPreviewLimits(maximumBytes: number): {
  marker: string;
  headBytes: number;
  tailBytes: number;
} {
  const boundedMaximum = Math.max(0, maximumBytes);
  const longMarkerBytes = Buffer.byteLength(ROLLING_TOOL_PREVIEW_MARKER, "utf8");
  const shortMarkerBytes = Buffer.byteLength(ROLLING_TOOL_PREVIEW_SHORT_MARKER, "utf8");
  const marker = boundedMaximum > longMarkerBytes
    ? ROLLING_TOOL_PREVIEW_MARKER
    : boundedMaximum > shortMarkerBytes
      ? ROLLING_TOOL_PREVIEW_SHORT_MARKER
      : "";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (marker === "") return { marker, headBytes: 0, tailBytes: boundedMaximum };
  const available = boundedMaximum - markerBytes;
  const headBytes = Math.floor(available / 3);
  return {
    marker,
    headBytes,
    tailBytes: available - headBytes,
  };
}

function boundedRollingToolPreview(value: string, maximumBytes: number): {
  text: string;
  head: string;
  tail: string;
  truncated: boolean;
} {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maximumBytes) {
    const safe = sanitizeTerminalText(value);
    if (Buffer.byteLength(safe, "utf8") > maximumBytes) {
      return boundedRollingToolPreview(safe, maximumBytes);
    }
    return { text: safe, head: safe, tail: "", truncated: false };
  }
  const limits = rollingToolPreviewLimits(maximumBytes);
  const head = byteTruncate(
    sanitizeTerminalText(utf8HeadSample(encoded, limits.headBytes)),
    limits.headBytes,
  );
  const tail = byteTail(
    sanitizeTerminalText(utf8TailSample(encoded, limits.tailBytes)),
    limits.tailBytes,
  );
  return {
    text: `${head}${limits.marker}${tail}`,
    head,
    tail,
    truncated: true,
  };
}

function boundedJsonView(value: JsonValue, maximumBytes: number): JsonValue | undefined {
  let nodes = 0;
  const sanitize = (selected: JsonValue, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > 4_096 || depth > 32) throw new Error("Tool renderer data is too deeply nested");
    if (typeof selected === "string") return sanitizeTerminalText(selected);
    if (selected === null || typeof selected !== "object") return selected;
    if (Array.isArray(selected)) return selected.map((entry) => sanitize(entry, depth + 1));
    return Object.fromEntries(Object.entries(selected).map(([key, entry]) => [
      sanitizeTerminalText(key),
      sanitize(entry, depth + 1),
    ]));
  };
  try {
    const safe = sanitize(value, 0);
    return Buffer.byteLength(JSON.stringify(safe), "utf8") <= maximumBytes ? safe : undefined;
  } catch {
    return undefined;
  }
}

function boundedToolResult(
  content: string,
  isError: boolean,
  metadata: JsonValue | undefined,
  maximumBytes: number,
  tail = false,
  source?: Pick<
    ToolResultBlock,
    | "contentBlocks"
    | "status"
    | "summary"
    | "nextActions"
    | "images"
    | "usage"
    | "addedToolNames"
  >,
): NonNullable<NonNullable<TranscriptEntry["toolData"]>["result"]> {
  return projectRuntimeToolRenderResult({
    content,
    isError,
    ...(metadata === undefined ? {} : { metadata }),
    ...source,
  }, { maximumBytes, tail });
}

interface UserShellProjection {
  command: string;
  output: string;
  isError: boolean;
  metadata?: JsonValue;
}

function userShellProjection(value: string): UserShellProjection | undefined {
  if (!value.startsWith(USER_SHELL_MESSAGE_PREFIX)) return undefined;
  const payload = value.slice(USER_SHELL_MESSAGE_PREFIX.length);
  const separator = payload.indexOf("\n");
  const commandLine = separator < 0 ? payload : payload.slice(0, separator);
  if (!commandLine.startsWith("$ ") || commandLine.length <= 2) return undefined;

  const lines = (separator < 0 ? "" : payload.slice(separator + 1)).split("\n");
  let exitCode: number | undefined;
  let signal: string | undefined;
  const terminalStatus = lines.at(-1) ?? "";
  const exit = /^exit (-?\d+|unknown)$/u.exec(terminalStatus);
  if (exit !== null) {
    lines.pop();
    if (exit[1] !== "unknown") exitCode = Number.parseInt(exit[1]!, 10);
  } else if (terminalStatus.startsWith("signal ") && terminalStatus.length > 7) {
    lines.pop();
    signal = terminalStatus.slice(7);
  }

  let truncated = false;
  if (lines.at(-1) === "… output truncated") {
    lines.pop();
    truncated = true;
  }
  const metadata: Record<string, JsonValue> = {
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
    ...(truncated ? { truncated: true } : {}),
  };
  return {
    command: commandLine.slice(2),
    output: lines.join("\n"),
    isError: signal !== undefined || (exitCode !== undefined && exitCode !== 0),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
}

function inputText(input: JsonValue, key: string): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input) || !Object.hasOwn(input, key)) {
    return undefined;
  }
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function mutationPath(input: JsonValue): string | undefined {
  return ["path", "filePath", "file_path", "file"]
    .map((key) => inputText(input, key))
    .find((value) => value !== undefined && value.trim() !== "");
}

export const MAX_RETAINED_MUTATION_PREVIEW_ROWS = 2_000;

function boundedMutationPreviewLines(value: string): { lines: string[]; markerIndex?: number } {
  const maximumRows = MAX_RETAINED_MUTATION_PREVIEW_ROWS;
  const headRows = Math.floor((maximumRows - 1) * 2 / 3);
  const tailRows = maximumRows - headRows;
  const head: string[] = [];
  const tail = new Array<string>(tailRows);
  let tailCount = 0;
  let tailNext = 0;
  let totalRows = 0;
  let start = 0;
  const retain = (line: string): void => {
    if (totalRows < headRows) head.push(line);
    else {
      tail[tailNext] = line;
      tailNext = (tailNext + 1) % tailRows;
      tailCount = Math.min(tailRows, tailCount + 1);
    }
    totalRows += 1;
  };
  while (true) {
    const separator = value.indexOf("\n", start);
    if (separator < 0) {
      retain(value.slice(start));
      break;
    }
    retain(value.slice(start, separator));
    start = separator + 1;
  }
  const orderedTail = tailCount < tailRows
    ? tail.slice(0, tailCount)
    : [...tail.slice(tailNext), ...tail.slice(0, tailNext)];
  if (totalRows <= maximumRows) return { lines: [...head, ...orderedTail] };
  const selectedTail = orderedTail.slice(-(maximumRows - head.length - 1));
  const omittedRows = totalRows - head.length - selectedTail.length;
  return {
    lines: [
      ...head,
      `… ${metric(omittedRows, "retained source row")} hidden; ending follows`,
      ...selectedTail,
    ],
    markerIndex: head.length,
  };
}

function prefixedLines(value: string, prefix: "+ " | "- ", maximumBytes: number): string[] {
  const sampled = boundedMutationPreviewLines(boundedRollingToolPreview(value, maximumBytes).text);
  return sampled.lines.map((line, index) => index === sampled.markerIndex ? line : `${prefix}${line}`);
}

function mutationInputPreview(name: string, input: JsonValue, maximumBytes: number): string | undefined {
  let preview: string | undefined;
  if (name === "write") {
    const content = inputText(input, "content");
    if (content !== undefined) preview = prefixedLines(content, "+ ", maximumBytes).join("\n");
  } else if (name === "edit") {
    const oldText = inputText(input, "oldText");
    const newText = inputText(input, "newText");
    if (oldText !== undefined && newText !== undefined) {
      preview = [
        "--- old",
        ...prefixedLines(oldText, "- ", maximumBytes),
        "+++ new",
        ...prefixedLines(newText, "+ ", maximumBytes),
      ].join("\n");
    } else if (input !== null && typeof input === "object" && !Array.isArray(input)
      && Object.hasOwn(input, "edits") && Array.isArray(input.edits)) {
      const sections: string[] = [];
      for (const [index, selected] of input.edits.slice(0, 32).entries()) {
        if (selected === null || typeof selected !== "object" || Array.isArray(selected)) continue;
        const before = inputText(selected, "oldText");
        const after = inputText(selected, "newText");
        if (before === undefined || after === undefined) continue;
        sections.push(
          `--- edit ${index + 1} before`,
          ...prefixedLines(before, "- ", maximumBytes),
          `+++ edit ${index + 1} after`,
          ...prefixedLines(after, "+ ", maximumBytes),
        );
      }
      const omitted = input.edits.length - 32;
      if (omitted > 0) sections.push(`… ${omitted} additional ${omitted === 1 ? "edit" : "edits"} not shown`);
      if (sections.length > 0) preview = sections.join("\n");
    }
  } else if (name === "apply_patch") {
    preview = inputText(input, "patch") ?? inputText(input, "patchText");
  }
  return preview === undefined ? undefined : boundedRollingToolPreview(preview, maximumBytes).text;
}

function contentLineCount(value: string): number {
  if (value === "") return 0;
  let separators = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x0d) {
      separators += 1;
      if (value.charCodeAt(index + 1) === 0x0a) index += 1;
    } else if (code === 0x0a) separators += 1;
  }
  const finalCode = value.charCodeAt(value.length - 1);
  return separators + (finalCode === 0x0d || finalCode === 0x0a ? 0 : 1);
}

function metric(value: number, name: string): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? name : `${name}s`}`;
}

function conciseMutationSummary(name: string, input: JsonValue, maximumBytes: number): string | undefined {
  if (!conciseMutationTools.has(name) || input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const path = mutationPath(input);
  let detail: string | undefined;
  if (name === "write") {
    const content = inputText(input, "content");
    if (content !== undefined) {
      detail = `${metric(contentLineCount(content), "line")} · ${metric(Buffer.byteLength(content, "utf8"), "byte")}`;
    }
  } else {
    const oldText = inputText(input, "oldText");
    const newText = inputText(input, "newText");
    const edits = Object.hasOwn(input, "edits") && Array.isArray(input.edits)
      ? input.edits.flatMap((selected) => {
          if (selected === null || typeof selected !== "object" || Array.isArray(selected)) return [];
          const selectedOldText = inputText(selected, "oldText");
          const selectedNewText = inputText(selected, "newText");
          return selectedOldText === undefined || selectedNewText === undefined
            ? []
            : [{ oldText: selectedOldText, newText: selectedNewText }];
        })
      : [];
    const selected = oldText === undefined || newText === undefined ? edits : [{ oldText, newText }];
    if (selected.length > 0) {
      const oldLines = selected.reduce((total, edit) => total + contentLineCount(edit.oldText), 0);
      const newLines = selected.reduce((total, edit) => total + contentLineCount(edit.newText), 0);
      const oldBytes = selected.reduce((total, edit) => total + Buffer.byteLength(edit.oldText, "utf8"), 0);
      const newBytes = selected.reduce((total, edit) => total + Buffer.byteLength(edit.newText, "utf8"), 0);
      detail = [
        ...(selected.length > 1 ? [metric(selected.length, "edit")] : []),
        `${oldLines.toLocaleString("en-US")} to ${metric(newLines, "line")}`,
        `${oldBytes.toLocaleString("en-US")} to ${metric(newBytes, "byte")}`,
      ].join(" · ");
    }
  }
  const summary = [path, detail].filter((value): value is string => value !== undefined).join(" · ");
  return summary === "" ? undefined : boundedToolPreview(summary, maximumBytes).replaceAll("\n", " ");
}

function conciseMutationInput(input: JsonValue, maximumBytes: number): JsonValue | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const selected = Object.fromEntries(["path", "filePath", "file_path", "file"].flatMap((key) => {
    const value = inputText(input, key);
    return value === undefined ? [] : [[key, value]];
  }));
  return Object.keys(selected).length === 0 ? undefined : boundedJsonView(selected, maximumBytes);
}

function mutationResultPreview(
  name: string,
  isError: boolean,
  metadata: JsonValue | undefined,
  maximumBytes: number,
): string | undefined {
  if (isError || !mutationTools.has(name)
    || metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const patch = [inputText(metadata, "diff"), inputText(metadata, "patch")]
    .find((candidate): candidate is string => candidate !== undefined && candidate.trim() !== "");
  return patch === undefined ? undefined : boundedToolPreview(patch, maximumBytes);
}

function toolResultPreview(name: string, isError: boolean, value: string, maximumBytes: number): string {
  if (!isError && mutationTools.has(name)) return "";
  return shellTools.has(name)
    ? boundedToolTailPreview(value, maximumBytes)
    : boundedToolPreview(value, maximumBytes);
}

type LiveToolProgress = NonNullable<NonNullable<TranscriptEntry["toolData"]>["progress"]>;

interface LiveToolProgressOutputBatch {
  output: string;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  elapsedMs?: number;
  stream: "stdout" | "stderr";
  truncated: boolean;
}

interface LiveToolCallDraft {
  key: string;
  step: number;
  index: number;
  callId: string;
  providerCallId?: string;
  name: string;
  rawArguments: string;
  rawArgumentHead: string;
  rawArgumentTail: string;
  receivedBytes: number;
  targetPath?: string;
  truncated: boolean;
}

function liveMutationSummary(draft: LiveToolCallDraft, maximumBytes: number): string {
  const path = draft.targetPath === undefined
    ? undefined
    : byteTruncate(sanitizeTerminalText(draft.targetPath).replaceAll("\n", " "), maximumBytes).trim() || undefined;
  return boundedToolPreview(
    [path, `receiving ${metric(draft.receivedBytes, "argument byte")}`].filter(Boolean).join(" · "),
    maximumBytes,
  ).replaceAll("\n", " ");
}

export function elapsedText(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining === 0 ? `${minutes}m` : `${minutes}m ${remaining}s`;
}

function runPhase(status: NonNullable<TuiContext["status"]>): string {
  if (status === "preparing") return "Preparing request";
  if (status === "streaming") return "Generating response";
  if (status === "tool_planning") return "Planning tools";
  if (status === "executing") return "Running tools";
  return "Working";
}

function liveToolProgressText(progress: LiveToolProgress): string {
  const sections = [
    progress.elapsedMs === undefined ? "" : `Still running · ${elapsedText(progress.elapsedMs)}`,
    progress.stdout === "" ? "" : `stdout (${progress.stdoutBytes} bytes):\n${progress.stdout}`,
    progress.stderr === "" ? "" : `stderr (${progress.stderrBytes} bytes):\n${progress.stderr}`,
  ].filter(Boolean);
  if (progress.truncated) sections.push("… live output truncated");
  return sections.join("\n\n");
}

export function toolCallSummary(input: JsonValue, maximumBytes: number): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (keys: readonly string[]): string | undefined => {
    for (const key of keys) {
      if (!Object.hasOwn(input, key)) continue;
      const candidate = input[key];
      if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
    }
    return undefined;
  };
  const command = value(["command", "cmd"]);
  const url = value(["url", "uri"]);
  const path = value(["path", "filePath", "file", "directory"]);
  const query = value(["query", "pattern"]);
  const summary = command ?? url ?? (query === undefined ? path : path === undefined ? query : `${query} in ${path}`);
  if (summary === undefined) return undefined;
  return boundedToolPreview(summary, maximumBytes).replaceAll("\n", " ");
}

function projectToolInput(
  name: string,
  input: JsonValue,
  rawArguments: string,
  maximumBytes: number,
): {
  summary?: string;
  inputPreview?: string;
  input?: JsonValue;
  clearInputPreview?: boolean;
} {
  const summary = conciseMutationSummary(name, input, maximumBytes) ?? toolCallSummary(input, maximumBytes);
  const retainStructured = Buffer.byteLength(rawArguments, "utf8") <= maximumBytes;
  const inputPreview = mutationInputPreview(name, input, maximumBytes);
  const structured = retainStructured
    ? boundedJsonView(input, maximumBytes)
    : conciseMutationTools.has(name) ? conciseMutationInput(input, maximumBytes) : undefined;
  const selectedPreview = inputPreview ?? (structured === undefined
    ? boundedRollingToolPreview(rawArguments, maximumBytes).text
    : undefined);
  return {
    ...(summary === undefined ? {} : { summary }),
    ...(selectedPreview === undefined ? {} : { inputPreview: selectedPreview }),
    ...(selectedPreview === undefined && structured !== undefined ? { clearInputPreview: true } : {}),
    ...(structured === undefined ? {} : { input: structured }),
  };
}

function partialToolInput(value: string): JsonValue | undefined {
  try {
    const parsed: unknown = parsePartialJson(value);
    if (parsed === undefined) return undefined;
    return parsed as JsonValue;
  } catch {
    return undefined;
  }
}

function partialMutationInput(draft: LiveToolCallDraft): JsonValue | undefined {
  if (!draft.truncated) return partialToolInput(draft.rawArguments);
  return partialToolInput(
    `${draft.rawArgumentHead}${ROLLING_TOOL_PREVIEW_JSON_STRING_MARKER}${draft.rawArgumentTail}`,
  ) ?? partialToolInput(draft.rawArgumentHead);
}

function transcriptEntryBytes(entry: TranscriptEntry): number {
  const extension = entry.extension === undefined
    ? ""
    : `${entry.extension.type}\0${entry.extension.customType}`;
  return Buffer.byteLength(
    `${entry.sourceMessageId ?? ""}${entry.title ?? ""}${entry.summary ?? ""}${entry.compactText ?? ""}${entry.inputPreview ?? ""}${entry.text}${entry.toolData === undefined ? "" : JSON.stringify(entry.toolData)}${extension}`,
    "utf8",
  ) + (entry.images ?? []).reduce(
    (total, image) => total + 64 + Buffer.byteLength(image.block.mediaType, "utf8"),
    0,
  );
}

function directToolResultContentBytes(content: readonly (TextBlock | ImageBlock)[]): number {
  return content.reduce((total, block) => total + 64 + (block.type === "text"
    ? Buffer.byteLength(block.text, "utf8")
    : Buffer.byteLength(block.mediaType, "utf8")
      + Buffer.byteLength(block.data ?? "", "utf8")
      + Buffer.byteLength(block.url ?? "", "utf8")), 0);
}

function moveTrailingReasoningBeforeFinalAnswer(entries: TranscriptEntry[]): void {
  const finalAnswerIndex = entries.findLastIndex((entry) => entry.kind === "assistant");
  if (finalAnswerIndex < 0) return;
  const trailing = new Set(entries.slice(finalAnswerIndex + 1).filter((entry) => entry.kind === "reasoning"));
  if (trailing.size === 0) return;
  const ordered = entries.filter((entry) => !trailing.has(entry));
  const insertion = ordered.findLastIndex((entry) => entry.kind === "assistant");
  ordered.splice(insertion, 0, ...trailing);
  entries.splice(0, entries.length, ...ordered);
}

export class TuiModel {
  readonly #limits: TuiLimits;
  readonly #messageIds = new Set<string>();
  readonly #messageIdByEntry = new Map<TranscriptEntry, string>();
  readonly #messageEntriesById = new Map<string, Set<TranscriptEntry>>();
  readonly #mutableEntryIds = new Set<string>();
  readonly #usageByRequest = new Map<string, NormalizedUsage>();
  readonly #reportedUsageByRequest = new Map<string, NormalizedUsage>();
  readonly #usageScopeByRun = new Map<string, { key: string; kind: "model" | "summary" }>();
  readonly #cacheRunContext = new Map<string, {
    provider: string;
    model: string;
    responseModel?: string;
    instructionFingerprint?: string;
    toolFingerprint?: string;
    sawAssistant: boolean;
  }>();
  readonly #entryBytes = new WeakMap<TranscriptEntry, number>();
  readonly #directToolResultContent = new WeakMap<TranscriptEntry, readonly (TextBlock | ImageBlock)[]>();
  readonly #directToolResultContentBytes = new WeakMap<TranscriptEntry, number>();
  readonly #liveToolCalls = new Map<string, LiveToolCallDraft>();
  readonly #runToolEntries = new Set<TranscriptEntry>();
  readonly #toolProgressSequences = new Map<string, number>();
  readonly #currentAssistantEntries = new Set<TranscriptEntry>();
  #startup: TranscriptEntry | undefined;
  #entries: TranscriptEntry[] = [];
  #transcriptBytes = 0;
  #retainedDirectToolResultBytes = 0;
  #activeRunKey: string | undefined;
  #currentAssistantStepToolBearing = false;
  #context: TuiContext = { active: false, status: "idle" };
  #usage: TuiUsageSummary | undefined;
  #latestCacheHitRate: number | undefined;
  #latestCacheReadTokens: number | undefined;
  #latestCacheWriteTokens: number | undefined;
  #latestCacheWrite1hTokens: number | undefined;
  #notice: string | undefined;
  #truncated = false;
  #localSequence = 0;
  #assistantStep = 0;
  #toolOutputExpanded = false;
  #reasoningExpanded = true;
  #showCacheMissNotices = false;
  #summarizationRetrySource: "branchSummary" | "compaction" | undefined;
  #compactionEntryId: string | undefined;
  #retryEntryId: string | undefined;
  #lastCacheRequest: CacheRequestBaseline | undefined;
  readonly #cacheReadPrice: TuiCacheReadPriceSource | undefined;

  constructor(limits: TuiLimits, cacheReadPrice?: TuiCacheReadPriceSource) {
    this.#limits = limits;
    this.#cacheReadPrice = cacheReadPrice;
  }

  get entries(): readonly TranscriptEntry[] {
    return this.#startup === undefined ? this.#entries : [this.#startup, ...this.#entries];
  }

  get context(): TuiContext {
    return this.#context;
  }

  /** @internal Canonical result blocks retained only for trusted direct renderers. */
  directToolResultContent(entry: TranscriptEntry): readonly (TextBlock | ImageBlock)[] | undefined {
    return this.#directToolResultContent.get(entry);
  }

  get usage(): TuiUsageSummary | undefined {
    return this.#usage;
  }

  get notice(): string | undefined {
    return this.#notice;
  }

  get toolOutputExpanded(): boolean {
    return this.#toolOutputExpanded;
  }

  setShowCacheMissNotices(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new TypeError("showCacheMissNotices must be boolean");
    this.#showCacheMissNotices = enabled;
  }

  setUsageBaseline(
    usage: NormalizedUsage | undefined,
    latestCacheHitRate?: number,
    latestCacheUsage?: TuiLatestCacheUsage,
    reportedUsage?: NormalizedUsage,
  ): void {
    this.#usageByRequest.delete("session:history");
    this.#reportedUsageByRequest.delete("session:history");
    if (usage !== undefined) this.#usageByRequest.set("session:history", structuredClone(usage));
    if (usage !== undefined || reportedUsage !== undefined) {
      this.#reportedUsageByRequest.set(
        "session:history",
        structuredClone(reportedUsage ?? usage ?? {}),
      );
    }
    this.#latestCacheHitRate = latestCacheHitRate;
    this.#latestCacheReadTokens = latestCacheUsage?.cacheReadTokens;
    this.#latestCacheWriteTokens = latestCacheUsage?.cacheWriteTokens;
    this.#latestCacheWrite1hTokens = latestCacheUsage?.cacheWrite1hTokens;
    this.#refreshUsage();
  }

  setContext(value: TuiContext): void {
    const modelChanged = (Object.hasOwn(value, "provider") && value.provider !== this.#context.provider)
      || (Object.hasOwn(value, "model") && value.model !== this.#context.model);
    const becameActive = value.active === true && this.#context.active !== true;
    const becameInactive = value.active === false;
    const activity = becameInactive
      ? undefined
      : becameActive && value.activity === undefined
        ? { phase: runPhase(value.status ?? "streaming"), startedAt: Date.now(), cancellable: true }
        : value.activity ?? this.#context.activity;
    this.#context = {
      ...this.#context,
      ...(modelChanged ? { contextTokens: 0 } : {}),
      ...value,
      ...(activity === undefined ? {} : { activity }),
    };
    if (modelChanged && !Object.hasOwn(value, "contextSource")) delete this.#context.contextSource;
    if (becameInactive) delete this.#context.activity;
  }

  committableEntries(): readonly TranscriptEntry[] {
    const firstMutable = this.#entries.findIndex((entry) => this.#mutableEntryIds.has(entry.id));
    const stable = firstMutable === -1 ? this.#entries : this.#entries.slice(0, firstMutable);
    return this.#startup === undefined ? stable : [this.#startup, ...stable];
  }

  clearModelContext(): void {
    const {
      provider: _provider,
      model: _model,
      contextTokens: _contextTokens,
      contextWindowTokens: _contextWindowTokens,
      contextSource: _contextSource,
      autoCompactionThresholdPercent: _autoCompactionThresholdPercent,
      thinkingSupported: _thinkingSupported,
      subscription: _subscription,
      ...context
    } = this.#context;
    this.#context = context;
  }

  clearTranscript(): void {
    for (const entry of this.#entries) this.#dropDirectToolResultContent(entry);
    this.#entries = [];
    this.#transcriptBytes = 0;
    this.#retainedDirectToolResultBytes = 0;
    this.#messageIds.clear();
    this.#messageIdByEntry.clear();
    this.#messageEntriesById.clear();
    this.#mutableEntryIds.clear();
    this.#liveToolCalls.clear();
    this.#runToolEntries.clear();
    this.#toolProgressSequences.clear();
    this.#currentAssistantEntries.clear();
    this.#activeRunKey = undefined;
    this.#currentAssistantStepToolBearing = false;
    this.#usageByRequest.clear();
    this.#reportedUsageByRequest.clear();
    this.#usageScopeByRun.clear();
    this.#cacheRunContext.clear();
    this.#lastCacheRequest = undefined;
    this.#usage = undefined;
    this.#latestCacheHitRate = undefined;
    this.#latestCacheReadTokens = undefined;
    this.#latestCacheWriteTokens = undefined;
    this.#latestCacheWrite1hTokens = undefined;
    this.#context = { ...this.#context, contextTokens: 0, contextSource: "estimated" };
    this.#truncated = false;
    this.#assistantStep = 0;
    this.#compactionEntryId = undefined;
    this.#retryEntryId = undefined;
    this.#notice = undefined;
  }

  addLocal(kind: "status" | "warning" | "error", text: string, title?: string, id?: string): void {
    if (id === undefined) this.#localSequence += 1;
    this.#append({
      id: id ?? `local:${this.#localSequence}`,
      kind,
      text,
      ...(title === undefined ? {} : { title }),
    });
    this.#bound();
  }

  setStartup(compactText: string, expandedText: string): void {
    this.#startup = {
      id: "startup",
      kind: "startup",
      compactText: byteTruncate(sanitizeTerminalText(compactText), 64 * 1024),
      text: byteTruncate(sanitizeTerminalText(expandedText), 128 * 1024),
      expanded: this.#toolOutputExpanded,
    };
  }

  clearStartup(): void {
    this.#startup = undefined;
  }

  toggleTool(callId?: string): boolean {
    if (callId === undefined) {
      const expanded = !this.#toolOutputExpanded;
      this.#toolOutputExpanded = expanded;
      if (this.#startup !== undefined) this.#startup.expanded = expanded;
      for (const entry of this.#entries) {
        if (entry.kind === "tool" || entry.expandable === true) entry.expanded = expanded;
      }
      return true;
    }
    const entries = this.#entries.filter((item) => item.callId === callId);
    if (entries.length === 0) return false;
    const expanded = entries.some((entry) => entry.expanded !== true);
    for (const entry of entries) entry.expanded = expanded;
    return true;
  }

  setToolOutputExpanded(expanded: boolean): boolean {
    if (typeof expanded !== "boolean") throw new TypeError("Tool output expansion must be boolean");
    const changed = this.#toolOutputExpanded !== expanded
      || (this.#startup !== undefined && this.#startup.expanded !== expanded)
      || this.#entries.some((entry) => (
        entry.kind === "tool"
        || entry.expandable === true
      ) && entry.expanded !== expanded);
    this.#toolOutputExpanded = expanded;
    if (this.#startup !== undefined) this.#startup.expanded = expanded;
    for (const entry of this.#entries) {
      if (entry.kind === "tool" || entry.expandable === true) entry.expanded = expanded;
    }
    return changed;
  }

  /** Marks one completed tool rendered outside the agent run loop as stable. */
  settleStandaloneTool(callId: string): boolean {
    const entries = this.#entries.filter((entry) => entry.callId === callId);
    if (entries.length === 0) return false;
    let changed = false;
    for (const entry of entries) {
      if (entry.status !== "completed" && entry.status !== "failed" && entry.status !== "in_doubt") continue;
      changed = this.#mutableEntryIds.delete(entry.id) || changed;
      this.#runToolEntries.delete(entry);
    }
    this.#toolProgressSequences.delete(callId);
    return changed;
  }

  collapseTranscriptEntries(ids: ReadonlySet<string>): void {
    for (const entry of this.entries) {
      if (
        ids.has(entry.id)
        && (entry.kind === "tool" || entry.kind === "startup" || entry.kind === "reasoning" || entry.expandable === true)
      ) entry.expanded = false;
    }
  }

  toggleReasoning(): boolean {
    const reasoning = this.#entries.filter((entry) => entry.kind === "reasoning");
    if (reasoning.length === 0) return false;
    const expanded = reasoning.some((entry) => entry.expanded !== true);
    this.#reasoningExpanded = expanded;
    for (const entry of reasoning) entry.expanded = expanded;
    return true;
  }

  apply(envelope: EventEnvelope): void {
    this.#apply(envelope);
    this.#bound();
  }

  /** @internal Coalesced ingress used by the interactive controller. */
  applyToolProgressOutputBatch(envelope: EventEnvelope, update: LiveToolProgressOutputBatch): void {
    const event = envelope.event;
    if (event.type !== "tool_progress" || event.progress.type !== "output") {
      throw new TypeError("Tool progress output batches require an output progress event");
    }
    const terminal = this.#entries.findLast((entry) => entry.callId === event.callId);
    const previousSequence = this.#toolProgressSequences.get(event.callId);
    if (
      terminal?.status === "completed"
      || terminal?.status === "failed"
      || terminal?.status === "in_doubt"
      || (previousSequence !== undefined && event.sequence <= previousSequence)
    ) return;
    this.#toolProgressSequences.set(event.callId, event.sequence);
    const toolEntry = this.#updateToolProgressOutput(event.callId, event.name, update);
    this.#runToolEntries.add(toolEntry);
    this.#mutableEntryIds.add(toolEntry.id);
    this.#context = { ...this.#context, status: "executing" };
    this.#bound();
  }

  applySessionEntry(entry: TuiSessionEntry): void {
    if (entry.type === "custom_message" && entry.display !== true) return;
    if (this.#entries.some((candidate) => candidate.id === entry.id)) return;
    const customType = sanitizeTerminalText(entry.customType).replaceAll("\n", " ");
    if (entry.type === "custom") {
      this.#append({
        id: entry.id,
        kind: "status",
        text: "",
        expanded: this.#toolOutputExpanded,
        expandable: true,
        extension: { type: "entry", customType },
      });
    } else {
      const images = customMessageImages(entry);
      this.#append({
        id: entry.id,
        kind: "status",
        text: byteTruncate(sanitizeTerminalText(customMessageText(entry)), Math.min(128 * 1024, this.#limits.maxTranscriptBytes)),
        expanded: this.#toolOutputExpanded,
        expandable: true,
        extension: { type: "message", customType },
        ...(images.length === 0 ? {} : { images }),
      });
    }
    this.#bound();
  }

  applySessionSummary(entry: TuiSessionSummary): void {
    if (this.#entries.some((candidate) => candidate.id === entry.id)) return;
    this.#lastCacheRequest = undefined;
    const summary = boundedSummaryText(entry.text, this.#limits.maxTranscriptBytes);
    const context = entry.summaryType === "compaction" && entry.tokensBefore !== undefined
      ? `${entry.tokensBefore.toLocaleString("en-US")} tokens before`
      : "";
    const receipt = entry.summaryType === "compaction"
      ? formatCompactionUsageReceipt(entry.usage)
      : undefined;
    this.#append({
      id: entry.id,
      kind: "status",
      title: entry.summaryType === "compaction" ? "Context compacted" : "Branch summary",
      compactText: context,
      text: summary,
      ...(receipt === undefined ? {} : { summary: receipt }),
      status: "completed",
      expanded: this.#toolOutputExpanded,
      expandable: true,
      card: entry.summaryType,
    });
    this.#bound();
  }

  applySessionShell(entry: TuiSessionShell): void {
    if (this.#entries.some((candidate) => candidate.id === entry.id)) return;
    const isError = entry.isError === true ||
      entry.cancelled ||
      entry.timedOut === true ||
      entry.signal !== undefined ||
      (entry.exitCode !== undefined && entry.exitCode !== 0);
    const input = boundedJsonView({
      command: entry.command,
      ...(entry.excludeFromContext === true ? { excludeFromContext: true } : {}),
    }, this.#limits.maxToolPreviewBytes);
    const metadata: Record<string, JsonValue> = {
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      ...(entry.cancelled ? { cancelled: true } : {}),
      ...(entry.timedOut === undefined ? {} : { timedOut: entry.timedOut }),
      ...(entry.signal === undefined ? {} : { signal: entry.signal }),
      ...(entry.truncated ? { truncated: true } : {}),
      ...(entry.fullOutputPath === undefined ? {} : { fullOutputPath: entry.fullOutputPath }),
    };
    this.#append({
      id: entry.id,
      kind: "tool",
      callId: `user-shell:${entry.id}`,
      title: "bash",
      summary: byteTruncate(
        sanitizeTerminalText(entry.command).replaceAll("\n", " "),
        this.#limits.maxToolPreviewBytes,
      ),
      text: toolResultPreview("bash", isError, entry.output, this.#limits.maxToolPreviewBytes),
      toolData: {
        argsComplete: true,
        executionStarted: true,
        ...(input === undefined ? {} : { input }),
        result: boundedToolResult(
          entry.output,
          isError,
          metadata,
          this.#limits.maxToolPreviewBytes,
          true,
        ),
      },
      status: isError ? "failed" : "completed",
      expanded: this.#toolOutputExpanded,
    });
    this.#bound();
  }

  applyAll(items: readonly TuiTranscriptItem[]): void {
    for (const item of items) {
      if ("event" in item) this.#apply(item);
      else if (item.type === "session_summary") this.applySessionSummary(item);
      else if (item.type === "shell_execution") this.applySessionShell(item);
      else this.applySessionEntry(item);
      this.#bound();
    }
  }

  #apply(envelope: EventEnvelope): void {
    const event = envelope.event;
    switch (event.type) {
      case "run_started": {
        for (const entry of [...this.#entries]) {
          if (entry.kind === "status" && entry.id.startsWith("local:")) this.#removeEntry(entry);
        }
        const runKey = envelope.runId ?? `${envelope.threadId}:unscoped`;
        this.#foldUsageForRun(runKey);
        this.#activeRunKey = runKey;
        this.#cacheRunContext.set(runKey, {
          provider: event.provider,
          model: event.model,
          ...(event.promptComposition?.sha256 === undefined
            ? {}
            : { instructionFingerprint: event.promptComposition.sha256 }),
          sawAssistant: false,
        });
        this.#usageScopeByRun.delete(runKey);
        const sameModel = this.#context.provider === event.provider && this.#context.model === event.model;
        this.#assistantStep = 0;
        this.#liveToolCalls.clear();
        this.#runToolEntries.clear();
        this.#toolProgressSequences.clear();
        this.#currentAssistantEntries.clear();
        this.#currentAssistantStepToolBearing = false;
        this.#retryEntryId = undefined;
        this.#context = {
          ...this.#context,
          provider: event.provider,
          model: event.model,
          ...(sameModel ? {} : { contextTokens: 0, contextSource: "estimated" as const }),
          active: true,
          status: "preparing",
          activity: { phase: "Preparing request", startedAt: Date.now(), cancellable: true },
        };
        this.#notice = undefined;
        break;
      }
      case "model_selected": {
        const runKey = envelope.runId ?? `${envelope.threadId}:unscoped`;
        const cacheContext = this.#cacheRunContext.get(runKey);
        if (cacheContext !== undefined) {
          cacheContext.provider = event.provider;
          cacheContext.model = event.model;
          delete cacheContext.responseModel;
        }
        this.#context = { ...this.#context, provider: event.provider, model: event.model };
        break;
      }
      case "run_state":
        this.#context = {
          ...this.#context,
          active: !["completed", "failed", "cancelled"].includes(event.state),
          status: event.state,
          ...(["completed", "failed", "cancelled"].includes(event.state)
            ? {}
            : {
                activity: {
                  phase: runPhase(event.state),
                  startedAt: this.#context.activity?.startedAt ?? Date.now(),
                  cancellable: true,
                },
              }),
        };
        if (["completed", "failed", "cancelled"].includes(event.state)) {
          this.#settleReasoning(this.#eventTime(envelope));
          delete this.#context.activity;
          this.#activeRunKey = undefined;
          this.#currentAssistantEntries.clear();
          this.#currentAssistantStepToolBearing = false;
        }
        break;
      case "message_appended":
        this.#appendMessage(envelope, event.message);
        if (event.message.role === "assistant") {
          this.#recordCacheMessage(envelope, event.message, event.toolDefinitionFingerprint);
        }
        break;
      case "assistant_started":
        this.#assistantStep = event.step;
        this.#currentAssistantEntries.clear();
        this.#currentAssistantStepToolBearing = false;
        {
          const runKey = envelope.runId ?? `${envelope.threadId}:unscoped`;
          const key = `${runKey}:model:${event.step}`;
          if (this.#usageScopeByRun.get(runKey)?.key !== key) this.#foldUsageForRun(runKey);
          this.#usageScopeByRun.set(runKey, { key, kind: "model" });
          const cacheContext = this.#cacheRunContext.get(runKey);
          if (cacheContext !== undefined) delete cacheContext.responseModel;
        }
        this.#context = {
          ...this.#context,
          active: true,
          status: "streaming",
          activity: {
            phase: "Generating response",
            startedAt: this.#context.activity?.startedAt ?? Date.now(),
            cancellable: true,
          },
        };
        break;
      case "provider_response_started":
        {
          const runKey = envelope.runId ?? `${envelope.threadId}:unscoped`;
          const cacheContext = this.#cacheRunContext.get(runKey);
          if (cacheContext !== undefined) cacheContext.responseModel = event.model;
        }
        if (this.#context.model !== undefined && event.model !== this.#context.model) {
          this.#notice = `Provider routed response to ${sanitizeTerminalText(event.model)}`;
        }
        break;
      case "text_delta":
        this.#appendTextPart(envelope, event.part, event.text);
        break;
      case "text_completed":
        this.#completeTextPart(envelope, event.part, event.text);
        break;
      case "reasoning_started":
        if (event.visibility === "summary") {
          const id = eventKey(envelope, `reasoning:${this.#assistantStep}:${event.part}`);
          if (!this.#entries.some((entry) => entry.id === id)) {
            const entry = this.#append({
              id,
              kind: "reasoning",
              text: "",
              streaming: true,
              expanded: this.#reasoningExpanded,
              reasoningStartedAt: this.#eventTime(envelope),
            });
            this.#placeReasoningBeforeFinalAnswer(entry);
          }
          this.#mutableEntryIds.add(id);
        }
        break;
      case "reasoning_delta":
        if (event.visibility === "summary" && event.text !== "[Reasoning redacted]") {
          const id = eventKey(envelope, `reasoning:${this.#assistantStep}:${event.part}`);
          this.#appendDelta(id, "reasoning", event.text);
          const entry = this.#entries.findLast((item) => item.id === id);
          if (entry !== undefined) entry.reasoningStartedAt ??= this.#eventTime(envelope);
        }
        break;
      case "reasoning_completed":
        {
          const id = eventKey(envelope, `reasoning:${this.#assistantStep}:${event.part}`);
          const existing = this.#entries.findLast((entry) => entry.id === id);
          if (event.visibility !== "summary" || event.redacted === true) {
            if (existing !== undefined) this.#removeEntry(existing);
          } else if (event.text.trim() === "") {
            if (existing?.text.trim() === "") this.#removeEntry(existing);
            else if (existing !== undefined) this.#completeReasoning(existing, this.#eventTime(envelope));
          } else {
            this.#replaceDelta(
              id,
              "reasoning",
              event.text,
            );
            const completed = this.#entries.findLast((entry) => entry.id === id);
            if (completed !== undefined) this.#completeReasoning(completed, this.#eventTime(envelope));
          }
        }
        break;
      case "tool_call_started":
        this.#startToolCall(envelope, event.index, event.id, event.name);
        break;
      case "tool_call_delta":
        this.#appendToolCallDelta(envelope, event.index, event.jsonFragment);
        break;
      case "tool_call_completed":
        this.#completeToolCall(envelope, event);
        break;
      case "assistant_completed":
        if (event.finishReason === "context_limit") this.#discardAssistantAttempt(envelope);
        else {
          this.#settleReasoning(this.#eventTime(envelope));
          for (const entry of this.#entries) {
            if (entry.kind === "assistant" || entry.kind === "reasoning") {
              entry.streaming = false;
              this.#mutableEntryIds.delete(entry.id);
            }
          }
          this.#discardToolCallDrafts(this.#assistantStep);
          if (event.finishReason === "length") {
            const id = `output-limit:${envelope.eventId}`;
            if (!this.#entries.some((entry) => entry.id === id)) {
              this.#append({
                id,
                kind: "warning",
                title: "Output limit",
                text: "The response reached the model's output-token limit and may be incomplete.",
              });
            }
          }
          if (!["cancelled", "aborted", "error"].includes(event.finishReason)) {
            this.#completeUsageObservation(envelope, undefined, true);
          }
        }
        this.#notice = undefined;
        break;
      case "tool_requested": {
        this.#toolProgressSequences.delete(event.callId);
        const runKey = envelope.runId ?? `${envelope.threadId}:unscoped`;
        if (runKey === this.#activeRunKey) this.#markCurrentAssistantStepToolBearing();
        const projection = projectToolInput(
          event.name,
          event.input,
          JSON.stringify(event.input),
          this.#limits.maxToolPreviewBytes,
        );
        const toolEntry = this.#upsertTool(
          event.callId,
          event.name,
          "pending",
          {
            argsComplete: true,
            executionStarted: false,
            ...projection,
          },
        );
        this.#runToolEntries.add(toolEntry);
        this.#mutableEntryIds.add(toolEntry.id);
        this.#context = {
          ...this.#context,
          status: "tool_planning",
          activity: {
            phase: `Planning ${sanitizeTerminalText(event.name)}`,
            startedAt: this.#context.activity?.startedAt ?? Date.now(),
            cancellable: true,
          },
        };
        break;
      }
      case "tool_started": {
        const toolEntry = this.#upsertTool(event.callId, event.name, "running", {
          argsComplete: true,
          executionStarted: true,
        });
        this.#runToolEntries.add(toolEntry);
        this.#mutableEntryIds.add(toolEntry.id);
        this.#context = {
          ...this.#context,
          status: "executing",
          activity: {
            phase: `Running ${sanitizeTerminalText(event.name)}`,
            startedAt: this.#context.activity?.startedAt ?? Date.now(),
            cancellable: true,
          },
        };
        break;
      }
      case "tool_progress":
        {
          const terminal = this.#entries.findLast((entry) => entry.callId === event.callId);
          const previousSequence = this.#toolProgressSequences.get(event.callId);
          if (
            terminal?.status === "completed"
            || terminal?.status === "failed"
            || terminal?.status === "in_doubt"
            || (previousSequence !== undefined && event.sequence <= previousSequence)
          ) break;
          this.#toolProgressSequences.set(event.callId, event.sequence);
          const toolEntry = this.#updateToolProgress(event.callId, event.name, event.progress);
          this.#runToolEntries.add(toolEntry);
          this.#mutableEntryIds.add(toolEntry.id);
        }
        this.#context = { ...this.#context, status: "executing" };
        break;
      case "tool_completed": {
        this.#toolProgressSequences.delete(event.callId);
        const completedPreview = mutationResultPreview(
          event.name,
          event.isError,
          event.result?.metadata,
          this.#limits.maxToolPreviewBytes,
        );
        const toolEntry = this.#upsertTool(
          event.callId,
          event.name,
          event.isError ? "failed" : "completed",
          {
            argsComplete: true,
            executionStarted: true,
            text: toolResultPreview(
              event.name,
              event.isError,
              shellTools.has(event.name) ? event.result?.content ?? event.preview : event.preview,
              this.#limits.maxToolPreviewBytes,
            ),
            result: boundedToolResult(
              event.result?.content ?? event.preview,
              event.isError,
              event.result?.metadata,
              this.#limits.maxToolPreviewBytes,
              shellTools.has(event.name),
              event.result,
            ),
            images: toolResultImages(event.callId, event.result?.images),
            directResultContent: projectRuntimeDirectToolRenderContent({
              content: event.result?.content ?? event.preview,
              isError: event.isError,
              ...(event.result ?? {}),
            }, { maximumBytes: this.#limits.maxToolPreviewBytes }),
            ...(completedPreview === undefined ? {} : { inputPreview: completedPreview }),
            clearProgress: true,
          },
        );
        this.#runToolEntries.add(toolEntry);
        this.#mutableEntryIds.add(toolEntry.id);
        break;
      }
      case "tool_in_doubt": {
        this.#toolProgressSequences.delete(event.callId);
        const toolEntry = this.#upsertTool(event.callId, event.name, "in_doubt", {
          argsComplete: true,
          executionStarted: true,
          text: boundedToolPreview(event.reason, this.#limits.maxToolPreviewBytes),
          result: boundedToolResult(event.reason, true, undefined, this.#limits.maxToolPreviewBytes),
          directResultContent: projectRuntimeDirectToolRenderContent({
            content: event.reason,
            isError: true,
          }, { maximumBytes: this.#limits.maxToolPreviewBytes }),
          clearProgress: true,
        });
        this.#runToolEntries.add(toolEntry);
        this.#mutableEntryIds.delete(toolEntry.id);
        break;
      }
      case "usage":
        {
          const runKey = envelope.runId ?? `${envelope.threadId}:unscoped`;
          const scope = this.#usageScopeByRun.get(runKey);
          const usageKey = scope?.key ?? `${runKey}:unscoped`;
          const prior = this.#usageByRequest.get(usageKey);
          const current = event.semantics === "incremental" ? addNormalizedUsage(prior, event.usage) : { ...event.usage };
          this.#usageByRequest.set(usageKey, current);
          const reportedPrior = this.#reportedUsageByRequest.get(usageKey);
          this.#reportedUsageByRequest.set(
            usageKey,
            event.semantics === "incremental"
              ? addNormalizedUsage(reportedPrior, event.usage)
              : { ...event.usage },
          );
          const contextTokens = normalizedContextTokens(current);
          if (scope?.kind !== "summary" && contextTokens !== undefined) {
            this.#context = { ...this.#context, contextTokens, contextSource: "provider" };
          }
          this.#refreshUsage();
        }
        break;
      case "retry_scheduled":
        if (event.phase === "compaction") break;
        this.#retryEntryId = envelope.eventId;
        this.#append({
          id: this.#retryEntryId,
          kind: "status",
          title: "Retry scheduled",
          text: `Retrying ${event.category} in ${event.delayMs} ms (attempt ${event.attempt})`,
        });
        this.#context = {
          ...this.#context,
          active: true,
          activity: {
            phase: `Retrying ${sanitizeTerminalText(event.category)}`,
            startedAt: this.#context.activity?.startedAt ?? Date.now(),
            retryAt: Date.now() + event.delayMs,
            attempt: event.attempt,
            cancellable: true,
          },
        };
        break;
      case "retry_attempt_started": {
        const runKey = envelope.runId ?? `${envelope.threadId}:unscoped`;
        if (this.#usageScopeByRun.get(runKey)?.kind === "model") {
          this.#foldUsageForRun(runKey);
          this.#usageScopeByRun.set(runKey, {
            key: `${runKey}:model:${this.#assistantStep}:retry:${event.attempt}`,
            kind: "model",
          });
        }
        const text = `Attempt ${event.attempt} started · ${sanitizeTerminalText(event.provider)}/${sanitizeTerminalText(event.model)}`;
        const entry = this.#retryEntryId === undefined
          ? undefined
          : this.#entries.findLast((candidate) => candidate.id === this.#retryEntryId);
        if (entry === undefined) {
          this.#retryEntryId = envelope.eventId;
          this.#append({ id: this.#retryEntryId, kind: "status", title: "Retrying", text });
        } else {
          entry.title = "Retrying";
          entry.text = text;
          this.#refreshEntryBytes(entry);
        }
        this.#context = {
          ...this.#context,
          active: true,
          status: "preparing",
          activity: {
            phase: `Retry attempt ${event.attempt}`,
            startedAt: Date.now(),
            attempt: event.attempt,
            cancellable: true,
          },
        };
        break;
      }
      case "summarization_retry_scheduled":
        this.#summarizationRetrySource ??= "branchSummary";
        this.#append({
          id: envelope.eventId,
          kind: "status",
          title: this.#summarizationRetrySource === "compaction" ? "Compaction retry" : "Branch summary retry",
          text: `${event.errorMessage}\nRetrying in ${event.delayMs} ms (attempt ${event.attempt}/${event.maxAttempts})`,
        });
        this.#context = {
          ...this.#context,
          active: true,
          activity: {
            phase: this.#summarizationRetrySource === "compaction" ? "Retrying compaction" : "Retrying branch summary",
            startedAt: this.#context.activity?.startedAt ?? Date.now(),
            retryAt: Date.now() + event.delayMs,
            attempt: event.attempt,
            cancellable: true,
          },
        };
        break;
      case "summarization_retry_attempt_start": {
        this.#summarizationRetrySource = event.source;
        const runKey = envelope.runId ?? `${envelope.threadId}:unscoped`;
        this.#foldUsageForRun(runKey);
        this.#usageScopeByRun.set(runKey, {
          key: `${runKey}:summary:retry:${envelope.eventId}`,
          kind: "summary",
        });
        this.#context = {
          ...this.#context,
          active: true,
          activity: {
            phase: event.source === "branchSummary" ? "Summarizing abandoned branch" : "Compacting context",
            startedAt: this.#context.activity?.startedAt ?? Date.now(),
            cancellable: true,
          },
        };
        break;
      }
      case "summarization_retry_finished":
        if (this.#summarizationRetrySource !== "compaction") {
          this.#context = { ...this.#context, active: false };
          delete this.#context.activity;
        }
        this.#summarizationRetrySource = undefined;
        break;
      case "compaction_started":
        for (const entry of [...this.#entries]) {
          if (entry.kind === "error" && entry.id.startsWith("local:")) this.#removeEntry(entry);
        }
        this.#summarizationRetrySource = "compaction";
        this.#compactionEntryId = envelope.eventId;
        {
          const runKey = envelope.runId ?? `${envelope.threadId}:unscoped`;
          this.#foldUsageForRun(runKey);
          this.#usageScopeByRun.set(runKey, {
            key: `${runKey}:compaction:${envelope.eventId}`,
            kind: "summary",
          });
        }
        this.#append({
          id: this.#compactionEntryId,
          kind: "status",
          title: "Compacting context",
          text: [
            event.reason === undefined ? "Preparing a smaller working context" : `Reason: ${event.reason}`,
            event.estimatedTokensBefore === undefined
              ? undefined
              : `${event.estimatedTokensBefore.toLocaleString("en-US")} projected tokens`,
          ].filter((part): part is string => part !== undefined).join(" · "),
          status: "running",
          expanded: this.#toolOutputExpanded,
          expandable: true,
          card: "compaction",
        });
        this.#mutableEntryIds.add(this.#compactionEntryId);
        this.#notice = "Compacting older context";
        this.#context = {
          ...this.#context,
          ...(event.estimatedTokensBefore === undefined
            ? {}
            : { contextTokens: event.estimatedTokensBefore, contextSource: "estimated" as const }),
          active: true,
          activity: {
            phase: "Compacting context",
            startedAt: this.#context.activity?.startedAt ?? Date.now(),
            cancellable: true,
          },
        };
        break;
      case "compaction_completed":
        this.#summarizationRetrySource = undefined;
        this.#lastCacheRequest = undefined;
        this.#completeUsageObservation(envelope, event.usage, false, !event.fromExtension);
        {
          const runKey = envelope.runId ?? `${envelope.threadId}:unscoped`;
          this.#foldUsageForRun(runKey);
          this.#usageScopeByRun.delete(runKey);
        }
        if (this.#compactionEntryId !== undefined) {
          const entry = this.#entries.findLast((candidate) => candidate.id === this.#compactionEntryId);
          if (entry !== undefined) {
            entry.title = "Context compacted";
            entry.compactText = `${event.tokensBefore.toLocaleString("en-US")} tokens before`;
            const receipt = formatCompactionUsageReceipt(event.usage);
            if (receipt === undefined) delete entry.summary;
            else entry.summary = receipt;
            entry.text = boundedSummaryText(messageText(event.summary), this.#limits.maxTranscriptBytes);
            entry.status = "completed";
            this.#refreshEntryBytes(entry);
          }
          this.#mutableEntryIds.delete(this.#compactionEntryId);
          this.#compactionEntryId = undefined;
        }
        this.#notice = `Compacted ${event.sourceMessageIds.length} messages`;
        if (this.#context.active === true) this.#context = {
          ...this.#context,
          activity: {
            phase: "Continuing after compaction",
            startedAt: this.#context.activity?.startedAt ?? Date.now(),
            cancellable: true,
          },
        };
        if (event.estimatedTokensAfter === undefined) {
          const { contextTokens: _contextTokens, contextSource: _contextSource, ...context } = this.#context;
          this.#context = context;
        } else this.#context = {
          ...this.#context,
          contextTokens: event.estimatedTokensAfter,
          contextSource: "estimated",
        };
        break;
      case "compaction_failed":
        this.#summarizationRetrySource = undefined;
        {
          const id = this.#compactionEntryId ?? envelope.eventId;
          const entry = this.#entries.findLast((candidate) => candidate.id === id);
          const text = event.errorMessage === undefined
            ? `Compaction ${event.aborted ? "was cancelled" : "failed"} (${event.reason})`
            : sanitizeTerminalText(event.errorMessage);
          if (entry === undefined) {
            this.#append({ id, kind: "error", title: "Compaction failed", text, status: "failed" });
          } else {
            entry.kind = "error";
            entry.title = "Compaction failed";
            entry.text = text;
            entry.status = "failed";
            this.#refreshEntryBytes(entry);
          }
          this.#mutableEntryIds.delete(id);
          this.#compactionEntryId = undefined;
          this.#notice = "Context compaction failed";
        }
        if (this.#context.active === true) {
          this.#context = {
            ...this.#context,
            activity: {
              phase: "Continuing without compaction",
              startedAt: this.#context.activity?.startedAt ?? Date.now(),
              cancellable: true,
            },
          };
        }
        break;
      case "branch_summary_created":
        this.#lastCacheRequest = undefined;
        this.#completeUsageObservation(envelope, event.usage, false, false);
        {
          const runKey = envelope.runId ?? `${envelope.threadId}:unscoped`;
          this.#foldUsageForRun(runKey);
          this.#usageScopeByRun.delete(runKey);
        }
        this.#append({
          id: envelope.eventId,
          kind: "status",
          title: "Branch summary",
          text: messageText(event.summary),
          expanded: this.#toolOutputExpanded,
          expandable: true,
          card: "branch_summary",
        });
        break;
      case "entry_label_changed":
        break;
      case "steering_queued":
        this.#notice = "Steering queued for the next model boundary";
        break;
      case "run_completed":
        this.#summarizationRetrySource = undefined;
        this.#settleReasoning(this.#eventTime(envelope));
        this.#settleRunTools();
        this.#activeRunKey = undefined;
        this.#currentAssistantEntries.clear();
        this.#currentAssistantStepToolBearing = false;
        this.#compactionEntryId = undefined;
        this.#retryEntryId = undefined;
        {
          const runKey = envelope.runId ?? `${envelope.threadId}:unscoped`;
          const cacheContext = this.#cacheRunContext.get(runKey);
          if (cacheContext?.sawAssistant !== true) this.#lastCacheRequest = undefined;
          this.#cacheRunContext.delete(runKey);
          this.#foldUsageForRun(runKey);
          this.#usageScopeByRun.delete(runKey);
        }
        this.#mutableEntryIds.clear();
        this.#context = { ...this.#context, active: false, status: "completed" };
        this.#notice = undefined;
        delete this.#context.activity;
        break;
      case "run_failed":
        this.#summarizationRetrySource = undefined;
        this.#settleReasoning(this.#eventTime(envelope));
        this.#settleRunTools();
        this.#activeRunKey = undefined;
        this.#currentAssistantEntries.clear();
        this.#currentAssistantStepToolBearing = false;
        this.#compactionEntryId = undefined;
        this.#retryEntryId = undefined;
        {
          const runKey = envelope.runId ?? `${envelope.threadId}:unscoped`;
          this.#cacheRunContext.delete(runKey);
          this.#foldUsageForRun(runKey);
          this.#usageScopeByRun.delete(runKey);
        }
        this.#lastCacheRequest = undefined;
        this.#mutableEntryIds.clear();
        this.#context = { ...this.#context, active: false, status: "failed" };
        this.#append({ id: envelope.eventId, kind: "error", text: errorMessage(event) });
        delete this.#context.activity;
        break;
      case "run_cancelled":
        this.#summarizationRetrySource = undefined;
        this.#settleReasoning(this.#eventTime(envelope));
        this.#settleRunTools();
        this.#activeRunKey = undefined;
        this.#currentAssistantEntries.clear();
        this.#currentAssistantStepToolBearing = false;
        this.#compactionEntryId = undefined;
        this.#retryEntryId = undefined;
        {
          const runKey = envelope.runId ?? `${envelope.threadId}:unscoped`;
          this.#cacheRunContext.delete(runKey);
          this.#foldUsageForRun(runKey);
          this.#usageScopeByRun.delete(runKey);
        }
        this.#lastCacheRequest = undefined;
        this.#mutableEntryIds.clear();
        this.#context = { ...this.#context, active: false, status: "cancelled" };
        this.#notice = undefined;
        this.#append({
          id: envelope.eventId,
          kind: "status",
          title: "Interrupted",
          text: sanitizeTerminalText(event.reason),
        });
        delete this.#context.activity;
        break;
      case "warning":
        // Forward-compatible provider telemetry is retained in the durable event
        // stream for diagnostics, but it is not an actionable user warning. New
        // upstream event types are common and should not interrupt the transcript.
        if (event.code === "unknown_provider_event") break;
        this.#append({ id: envelope.eventId, kind: "warning", title: event.code, text: event.message });
        break;
    }
  }

  #recordCacheMessage(
    envelope: EventEnvelope,
    message: CanonicalMessage,
    toolDefinitionFingerprint?: string,
  ): void {
    const runKey = envelope.runId ?? `${envelope.threadId}:unscoped`;
    const context = this.#cacheRunContext.get(runKey);
    if (context !== undefined) context.sawAssistant = true;
    if (context !== undefined && toolDefinitionFingerprint !== undefined) {
      context.toolFingerprint = toolDefinitionFingerprint;
    }
    const provider = message.provider ?? context?.provider;
    const model = message.responseModel ?? context?.responseModel ?? message.model ?? context?.model;
    const pricingModel = message.model ?? context?.model ?? model;
    const usage = message.usage;
    const cacheReadTokens = usage?.cacheReadTokens;
    const promptTokens = usage === undefined
      || usage.inputTokens === undefined
      || usage.cacheReadTokens === undefined
      || usage.cacheWriteTokens === undefined
      ? undefined
      : normalizedContextTokens(usage);
    if (
      provider === undefined
      || model === undefined
      || usage === undefined
      || promptTokens === undefined
      || promptTokens <= 0
      || cacheReadTokens === undefined
    ) {
      this.#lastCacheRequest = undefined;
      return;
    }
    const messageTimestamp = Date.parse(message.createdAt);
    const envelopeTimestamp = Date.parse(envelope.timestamp);
    const timestamp = Number.isFinite(messageTimestamp) ? messageTimestamp : envelopeTimestamp;
    const cacheReadPrice = this.#cacheReadPrice?.(provider, pricingModel ?? model, promptTokens);
    const cacheBoundary = cacheBoundaryFingerprint({
      ...(message.api === undefined ? {} : { api: message.api }),
      ...(context?.instructionFingerprint === undefined
        ? {}
        : { instructionFingerprint: context.instructionFingerprint }),
      ...(context?.toolFingerprint === undefined ? {} : { toolFingerprint: context.toolFingerprint }),
      session: envelope.threadId,
    });
    const observed = observeCacheRequest(this.#lastCacheRequest, {
      provider,
      model,
      usage,
      timestamp,
      cacheBoundary,
      ...(cacheReadPrice === undefined ? {} : { cacheReadPrice }),
    });
    this.#lastCacheRequest = observed.current;
    const miss = observed.miss;
    if (!this.#showCacheMissNotices || miss === undefined) return;
    if (miss.missedTokens < CACHE_MISS_NOTICE_TOKENS && miss.missedCost < CACHE_MISS_NOTICE_COST) return;
    const detail = miss.possibleIdleExpiry
      ? ` · possible provider idle expiry after ${Math.max(1, Math.round(miss.idleMs / 60_000))}m`
      : "";
    const cost = miss.missedCost >= 0.01 ? ` · estimated added cost $${miss.missedCost.toFixed(2)}` : "";
    const cacheHitRate = cacheReadTokens / promptTokens * 100;
    this.#append({
      id: `cache-miss:${envelope.eventId}`,
      kind: "status",
      title: "Cache reuse estimate",
      text: `This request read ${cacheHitRate.toFixed(1)}% of its prompt from cache · up to ${miss.missedTokens.toLocaleString("en-US")} prior-prompt tokens were not cache-read${cost}${detail}. Later requests may recover.`,
    });
  }

  #refreshUsage(): void {
    if (this.#usageByRequest.size === 0) {
      this.#usage = undefined;
      return;
    }
    const aggregate = [...this.#usageByRequest.values()].reduce<NormalizedUsage | undefined>(
      (total, value) => addCompleteNormalizedUsage(total, value),
      undefined,
    ) ?? {};
    const reportedAggregate = [...this.#reportedUsageByRequest.values()].reduce<NormalizedUsage | undefined>(
      (total, value) => addNormalizedUsage(total, value),
      undefined,
    ) ?? {};
    const reportedFields = [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "cacheWrite1hTokens",
      "reasoningTokens",
      "serverToolCalls",
      "durationMs",
    ] as const;
    const hasReportedFallback = reportedFields.some(
      (field) => aggregate[field] === undefined && reportedAggregate[field] !== undefined,
    ) || (aggregate.cost === undefined && reportedAggregate.cost !== undefined);
    const promptInputTokens = normalizedContextTokens(aggregate);
    const reportedPromptInputTokens = promptInputTokens === undefined
      ? reportedContextLowerBound(reportedAggregate)
      : undefined;
    const derivedTotalTokens = normalizedTotalTokens(aggregate);
    this.#usage = {
      total: {
        ...aggregate,
        ...(aggregate.totalTokens === undefined && derivedTotalTokens !== undefined
          ? { totalTokens: derivedTotalTokens }
          : {}),
      },
      ...(hasReportedFallback ? { reportedTotal: reportedAggregate } : {}),
      ...(promptInputTokens === undefined ? {} : { promptInputTokens }),
      ...(reportedPromptInputTokens === undefined ? {} : { reportedPromptInputTokens }),
      ...(this.#latestCacheHitRate === undefined ? {} : { latestCacheHitRate: this.#latestCacheHitRate }),
      ...(aggregate.cacheReadTokens !== undefined || this.#latestCacheReadTokens === undefined
        ? {}
        : { latestCacheReadTokens: this.#latestCacheReadTokens }),
      ...(aggregate.cacheWriteTokens !== undefined || this.#latestCacheWriteTokens === undefined
        ? {}
        : { latestCacheWriteTokens: this.#latestCacheWriteTokens }),
      ...(aggregate.cacheWrite1hTokens !== undefined || this.#latestCacheWrite1hTokens === undefined
        ? {}
        : { latestCacheWrite1hTokens: this.#latestCacheWrite1hTokens }),
    };
  }

  #foldUsageForRun(runKey: string): void {
    const prefix = `${runKey}:`;
    let history = this.#usageByRequest.get("session:history");
    let reportedHistory = this.#reportedUsageByRequest.get("session:history");
    let changed = false;
    for (const [key, usage] of this.#usageByRequest) {
      if (key === "session:history" || !key.startsWith(prefix)) continue;
      history = addCompleteNormalizedUsage(history, usage);
      reportedHistory = addNormalizedUsage(
        reportedHistory,
        this.#reportedUsageByRequest.get(key) ?? usage,
      );
      this.#usageByRequest.delete(key);
      this.#reportedUsageByRequest.delete(key);
      changed = true;
    }
    if (changed && history !== undefined) this.#usageByRequest.set("session:history", history);
    if (changed && reportedHistory !== undefined) {
      this.#reportedUsageByRequest.set("session:history", reportedHistory);
    }
  }

  #completeUsageObservation(
    envelope: EventEnvelope,
    fallback: NormalizedUsage | undefined,
    updateLatestCacheHitRate: boolean,
    recordMissingUsage = true,
  ): void {
    const runKey = envelope.runId ?? `${envelope.threadId}:unscoped`;
    const scope = this.#usageScopeByRun.get(runKey);
    const usageKey = scope?.key ?? `${runKey}:unscoped`;
    if (!this.#usageByRequest.has(usageKey)) {
      if (fallback === undefined && !recordMissingUsage) return;
      const observed = fallback === undefined ? {} : structuredClone(fallback);
      this.#usageByRequest.set(usageKey, observed);
      this.#reportedUsageByRequest.set(usageKey, structuredClone(observed));
    }
    if (updateLatestCacheHitRate) {
      const latest = this.#usageByRequest.get(usageKey)!;
      this.#latestCacheHitRate = normalizedCacheHitRate(latest);
      this.#latestCacheReadTokens = latest.cacheReadTokens;
      this.#latestCacheWriteTokens = latest.cacheWriteTokens;
      this.#latestCacheWrite1hTokens = latest.cacheWrite1hTokens;
    }
    this.#refreshUsage();
  }

  #appendMessage(envelope: EventEnvelope, message: CanonicalMessage): void {
    if (message.custom !== undefined) return;
    if (message.role === "tool") {
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        const completedPreview = mutationResultPreview(
          block.name,
          block.isError,
          block.metadata,
          this.#limits.maxToolPreviewBytes,
        );
        const toolEntry = this.#upsertTool(
          block.callId,
          block.name,
          block.isError ? "failed" : "completed",
          {
            argsComplete: true,
            executionStarted: true,
            text: toolResultPreview(block.name, block.isError, block.content, this.#limits.maxToolPreviewBytes),
            result: boundedToolResult(
              block.content,
              block.isError,
              block.metadata,
              this.#limits.maxToolPreviewBytes,
              shellTools.has(block.name),
              block,
            ),
            images: toolResultImages(block.callId, block.images),
            directResultContent: projectRuntimeDirectToolRenderContent(
              block,
              { maximumBytes: this.#limits.maxToolPreviewBytes },
            ),
            ...(completedPreview === undefined ? {} : { inputPreview: completedPreview }),
            clearProgress: true,
          },
        );
        this.#mutableEntryIds.delete(toolEntry.id);
      }
      return;
    }
    if (this.#messageIds.has(message.id)) return;
    if (message.role === "system") return;
    if (message.role === "assistant" && message.stopReason === "context_limit") {
      this.#discardAssistantAttempt(envelope);
      return;
    }
    const images = directMessageImages(message);
    const text = messageText(message, false);
    const toolCalls = message.role === "assistant"
      ? message.content.filter((block) => block.type === "tool_call")
      : [];
    const reasoningCount = message.role === "assistant"
      ? message.content.filter((block) =>
          block.type === "thinking"
          && block.visibility === "summary"
          && block.redacted !== true
          && block.thinking.trim() !== "").length
      : 0;
    const rawUserText = message.role === "user"
      ? message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n")
      : "";
    const skill = message.role === "user" && images.length === 0 ? parseSkillBlock(rawUserText) : null;
    if (
      text.trim() === ""
      && images.length === 0
      && toolCalls.length === 0
      && reasoningCount === 0
      && skill === null
    ) return;
    this.#messageIds.add(message.id);
    const ownedEntries: TranscriptEntry[] = [];
    const userShell = message.role === "user" && message.displayText === undefined && images.length === 0
      ? userShellProjection(text)
      : undefined;
    if (userShell !== undefined) {
      const input = boundedJsonView({ command: userShell.command }, this.#limits.maxToolPreviewBytes);
      ownedEntries.push(this.#append({
        id: message.id,
        kind: "tool",
        callId: `user-shell:${message.id}`,
        title: "shell",
        summary: byteTruncate(sanitizeTerminalText(userShell.command).replaceAll("\n", " "), this.#limits.maxToolPreviewBytes),
        text: boundedToolTailPreview(userShell.output, this.#limits.maxToolPreviewBytes),
        toolData: {
          argsComplete: true,
          executionStarted: true,
          ...(input === undefined ? {} : { input }),
          result: boundedToolResult(
            userShell.output,
            userShell.isError,
            userShell.metadata,
            this.#limits.maxToolPreviewBytes,
            true,
          ),
        },
        status: userShell.isError ? "failed" : "completed",
        expanded: this.#toolOutputExpanded,
      }));
      this.#ownMessageEntries(message.id, ownedEntries);
      return;
    }
    if (skill !== null) {
      ownedEntries.push(this.#append({
        id: `${message.id}:skill`,
        kind: "status",
        title: "Skill",
        summary: byteTruncate(sanitizeTerminalText(skill.name).replaceAll("\n", " "), 1_024),
        compactText: byteTruncate(sanitizeTerminalText(skill.name).replaceAll("\n", " "), 1_024),
        text: byteTruncate(
          sanitizeTerminalText(skill.content),
          Math.min(128 * 1024, this.#limits.maxTranscriptBytes),
        ),
        expanded: this.#toolOutputExpanded,
        expandable: true,
        card: "skill",
      }));
      if (skill.userMessage !== undefined) {
        ownedEntries.push(this.#append({
          id: message.id,
          kind: "user",
          text: skill.userMessage,
        }));
      }
      this.#ownMessageEntries(message.id, ownedEntries);
      return;
    }
    if (message.role === "assistant") {
      const scope = envelope.runId ?? envelope.threadId;
      const reasoningPrefix = `${scope}:reasoning:${this.#assistantStep}:`;
      const textPrefix = `${scope}:text:${this.#assistantStep}:`;
      const liveReasoning = this.#entries.filter((entry) =>
        entry.kind === "reasoning"
        && entry.id.startsWith(reasoningPrefix)
        && this.#mutableEntryIds.has(entry.id));
      const liveAssistant = this.#entries.filter((entry) =>
        entry.kind === "assistant"
        && entry.id.startsWith(textPrefix)
        && this.#mutableEntryIds.has(entry.id));
      const projectedRows = message.content.filter((block) =>
        block.type === "text"
        || block.type === "image"
        || (block.type === "thinking"
          && block.visibility === "summary"
          && block.redacted !== true
          && block.thinking.trim() !== ""));
      const singleNarrativeRow = projectedRows.length === 1;
      const claimedLive = new Set<TranscriptEntry>();
      const claimLive = (kind: "assistant" | "reasoning", index: number): TranscriptEntry | undefined => {
        const entries = kind === "assistant" ? liveAssistant : liveReasoning;
        const id = eventKey(envelope, `${kind === "assistant" ? "text" : "reasoning"}:${this.#assistantStep}:${index}`);
        return entries.findLast((entry) => entry.id === id && !claimedLive.has(entry))
          ?? entries.find((entry) => !claimedLive.has(entry));
      };
      let imageIndex = 0;
      for (const [index, block] of message.content.entries()) {
        if (block.type === "text" && block.text.trim() !== "") {
          const id = singleNarrativeRow ? message.id : `${message.id}:assistant:${index}`;
          const live = claimLive("assistant", index);
          const entry = live ?? this.#append({ id, kind: "assistant", text: block.text });
          if (live !== undefined) {
            this.#mutableEntryIds.delete(live.id);
            live.id = id;
            live.text = sanitizeTerminalText(block.text);
            live.streaming = false;
            this.#refreshEntryBytes(live);
            claimedLive.add(live);
          }
          this.#mutableEntryIds.add(entry.id);
          ownedEntries.push(entry);
          continue;
        }
        if (block.type === "image") {
          const image = images[imageIndex];
          imageIndex += 1;
          if (image === undefined) continue;
          const id = singleNarrativeRow ? message.id : `${message.id}:assistant:${index}`;
          const entry = this.#append({
            id,
            kind: "assistant",
            text: "",
            images: [image],
          });
          this.#mutableEntryIds.add(entry.id);
          ownedEntries.push(entry);
          continue;
        }
        if (
          block.type === "thinking"
          && block.visibility === "summary"
          && block.redacted !== true
          && block.thinking.trim() !== ""
        ) {
          const id = singleNarrativeRow && toolCalls.length === 0
            ? message.id
            : `${message.id}:reasoning:${index}`;
          const live = claimLive("reasoning", index);
          const entry = live ?? this.#append({
            id,
            kind: "reasoning",
            text: block.thinking,
            expanded: this.#reasoningExpanded,
          });
          if (live !== undefined) {
            this.#mutableEntryIds.delete(live.id);
            live.id = id;
            live.text = sanitizeTerminalText(block.thinking);
            live.expanded ??= this.#reasoningExpanded;
            live.streaming = false;
            this.#refreshEntryBytes(live);
            claimedLive.add(live);
          }
          this.#mutableEntryIds.add(entry.id);
          ownedEntries.push(entry);
          continue;
        }
        if (block.type !== "tool_call") continue;
        const entryId = `${message.id}:tool:${index}`;
        this.#claimToolCallDraft(block.callId, block.name, index, entryId);
        const projection = projectToolInput(
          block.name,
          block.arguments,
          block.rawArguments ?? JSON.stringify(block.arguments),
          this.#limits.maxToolPreviewBytes,
        );
        const toolEntry = this.#upsertTool(block.callId, block.name, "pending", {
          argsComplete: true,
          executionStarted: false,
          ...projection,
        }, entryId);
        this.#runToolEntries.add(toolEntry);
        this.#mutableEntryIds.add(toolEntry.id);
        ownedEntries.push(toolEntry);
      }
      for (const entry of ownedEntries) {
        if (entry.kind !== "assistant") continue;
        if (toolCalls.length > 0) entry.hasToolCalls = true;
        else delete entry.hasToolCalls;
      }
      this.#currentAssistantEntries.clear();
      for (const entry of ownedEntries) {
        if (entry.kind === "assistant") this.#currentAssistantEntries.add(entry);
      }
      this.#currentAssistantStepToolBearing = toolCalls.length > 0;
      for (const entry of [...liveReasoning, ...liveAssistant]) {
        if (!claimedLive.has(entry)) this.#removeEntry(entry);
      }
      moveTrailingReasoningBeforeFinalAnswer(ownedEntries);
      const ordered = new Set(ownedEntries);
      const anchor = this.#entries.reduce(
        (minimum, entry, index) => ordered.has(entry) ? Math.min(minimum, index) : minimum,
        this.#entries.length,
      );
      this.#entries = this.#entries.filter((entry) => !ordered.has(entry));
      this.#entries.splice(Math.min(anchor, this.#entries.length), 0, ...ownedEntries);
      this.#ownMessageEntries(message.id, ownedEntries);
      return;
    }
    ownedEntries.push(this.#append({
      id: message.id,
      kind: message.role === "user" ? "user" : "tool",
      text,
      ...(images.length === 0 ? {} : { images }),
    }));
    this.#ownMessageEntries(message.id, ownedEntries);
  }

  #appendTextPart(envelope: EventEnvelope, part: number, value: string): void {
    this.#appendDelta(
      eventKey(envelope, `text:${this.#assistantStep}:${part}`),
      "assistant",
      value,
    );
  }

  #eventTime(envelope: EventEnvelope): number {
    const value = Date.parse(envelope.timestamp);
    return Number.isFinite(value) ? value : 0;
  }

  #placeReasoningBeforeFinalAnswer(entry: TranscriptEntry): void {
    const reasoningIndex = this.#entries.indexOf(entry);
    const answerIndex = this.#entries.findLastIndex((candidate) =>
      candidate.kind === "assistant" && this.#currentAssistantEntries.has(candidate));
    if (reasoningIndex < 0 || answerIndex < 0 || reasoningIndex < answerIndex) return;
    this.#entries.splice(reasoningIndex, 1);
    this.#entries.splice(answerIndex, 0, entry);
  }

  #completeReasoning(entry: TranscriptEntry, endedAt: number): void {
    const startedAt = entry.reasoningStartedAt ?? endedAt;
    entry.reasoningStartedAt = startedAt;
    entry.reasoningDurationMs = Math.max(0, endedAt - startedAt);
    entry.streaming = false;
    entry.expanded ??= this.#reasoningExpanded;
  }

  #settleReasoning(endedAt: number): void {
    for (const entry of [...this.#entries]) {
      if (entry.kind !== "reasoning" || entry.streaming !== true) continue;
      if (entry.text.trim() === "") this.#removeEntry(entry);
      else this.#completeReasoning(entry, endedAt);
    }
  }

  #completeTextPart(envelope: EventEnvelope, part: number, value: string): void {
    this.#replaceDelta(
      eventKey(envelope, `text:${this.#assistantStep}:${part}`),
      "assistant",
      value,
    );
  }

  #replaceDelta(id: string, kind: "assistant" | "reasoning", value: string): void {
    const safe = byteTruncate(sanitizeTerminalText(value), this.#limits.maxTranscriptBytes);
    const entry = this.#entries.findLast((item) => item.id === id);
    if (entry === undefined) {
      if (safe === "") return;
      this.#append({
        id,
        kind,
        text: safe,
        streaming: false,
        ...(kind === "reasoning" ? { expanded: this.#reasoningExpanded } : {}),
      });
    } else {
      entry.text = safe;
      entry.streaming = false;
      this.#refreshEntryBytes(entry);
    }
    const selected = this.#entries.findLast((item) => item.id === id);
    if (kind === "assistant" && selected !== undefined) {
      this.#currentAssistantEntries.add(selected);
      if (this.#currentAssistantStepToolBearing) selected.hasToolCalls = true;
    }
    if (kind === "reasoning" && selected !== undefined) this.#placeReasoningBeforeFinalAnswer(selected);
    this.#mutableEntryIds.add(id);
  }

  #toolCallDraftKey(envelope: EventEnvelope, index: number): string {
    return eventKey(envelope, `tool-call:${this.#assistantStep}:${index}`);
  }

  #startToolCall(envelope: EventEnvelope, index: number, id?: string, name?: string): LiveToolCallDraft {
    const key = this.#toolCallDraftKey(envelope, index);
    const existing = this.#liveToolCalls.get(key);
    if (existing !== undefined) {
      if (name !== undefined) existing.name = name;
      if (id !== undefined) existing.providerCallId = id;
      const toolEntry = this.#upsertTool(existing.callId, existing.name, "pending", {
        argsComplete: false,
        executionStarted: false,
      });
      this.#runToolEntries.add(toolEntry);
      return existing;
    }
    const callId = `draft:${key}`;
    const draft: LiveToolCallDraft = {
      key,
      step: this.#assistantStep,
      index,
      callId,
      ...(id === undefined ? {} : { providerCallId: id }),
      name: name ?? "tool",
      rawArguments: "",
      rawArgumentHead: "",
      rawArgumentTail: "",
      receivedBytes: 0,
      truncated: false,
    };
    this.#liveToolCalls.set(key, draft);
    const toolEntry = this.#upsertTool(callId, draft.name, "pending", {
      argsComplete: false,
      executionStarted: false,
    });
    this.#runToolEntries.add(toolEntry);
    this.#mutableEntryIds.add(toolEntry.id);
    this.#markCurrentAssistantStepToolBearing();
    this.#context = {
      ...this.#context,
      active: true,
      status: "tool_planning",
      activity: {
        phase: name === undefined ? "Preparing tool call" : `Planning ${sanitizeTerminalText(name)}`,
        startedAt: this.#context.activity?.startedAt ?? Date.now(),
        cancellable: true,
      },
    };
    return draft;
  }

  #markCurrentAssistantStepToolBearing(): void {
    if (this.#currentAssistantStepToolBearing) return;
    this.#currentAssistantStepToolBearing = true;
    for (const entry of this.#currentAssistantEntries) entry.hasToolCalls = true;
  }

  #appendToolCallDelta(envelope: EventEnvelope, index: number, fragment: string): void {
    const draft = this.#startToolCall(envelope, index);
    draft.receivedBytes = Math.min(Number.MAX_SAFE_INTEGER, draft.receivedBytes + Buffer.byteLength(fragment, "utf8"));
    const maximumBytes = Math.min(this.#limits.maxToolPreviewBytes, LIVE_TOOL_CALL_PREVIEW_MAX_BYTES);
    if (!draft.truncated) {
      const preview = boundedRollingToolPreview(
        `${draft.rawArguments}${fragment}`,
        maximumBytes,
      );
      draft.rawArguments = preview.text;
      draft.rawArgumentHead = preview.head;
      draft.rawArgumentTail = preview.tail;
      draft.truncated = preview.truncated;
    } else {
      const limits = rollingToolPreviewLimits(maximumBytes);
      const fragmentTail = boundedSanitizedTail(fragment, limits.tailBytes);
      draft.rawArgumentTail = byteTail(
        `${draft.rawArgumentTail}${fragmentTail}`,
        limits.tailBytes,
      );
      draft.rawArguments = `${draft.rawArgumentHead}${limits.marker}${draft.rawArgumentTail}`;
    }
    const concise = conciseMutationTools.has(draft.name);
    const humanized = humanizedToolInputs.has(draft.name);
    const parsedInput = concise || humanized || !draft.truncated
      ? partialMutationInput(draft)
      : undefined;
    const genericInput = !draft.truncated
      && parsedInput !== null
      && typeof parsedInput === "object"
      && !Array.isArray(parsedInput)
      && (Object.keys(parsedInput).length > 0 || draft.rawArguments.trim() === "{}")
      ? parsedInput
      : undefined;
    const partialInput = concise || humanized ? parsedInput : genericInput;
    const targetPath = partialInput === undefined ? undefined : mutationPath(partialInput);
    if (targetPath !== undefined) draft.targetPath = targetPath;
    const partialPreview = partialInput === undefined
      ? undefined
      : mutationInputPreview(draft.name, partialInput, this.#limits.maxToolPreviewBytes);
    const structuredInput = partialInput === undefined
      ? undefined
      : draft.truncated
        ? conciseMutationInput(partialInput, this.#limits.maxToolPreviewBytes) ?? {}
        : boundedJsonView(partialInput, this.#limits.maxToolPreviewBytes);
    const projection = partialInput === undefined
      ? undefined
      : projectToolInput(
          draft.name,
          partialInput,
          draft.rawArguments,
          this.#limits.maxToolPreviewBytes,
        );
    this.#upsertTool(draft.callId, draft.name, "pending", {
      argsComplete: false,
      executionStarted: false,
      ...(concise
        ? {
            summary: liveMutationSummary(draft, this.#limits.maxToolPreviewBytes),
            ...(partialPreview === undefined ? {} : { inputPreview: partialPreview }),
            ...(structuredInput === undefined ? {} : { input: structuredInput }),
          }
        : humanized
          ? projection ?? { clearInputPreview: true }
          : projection ?? { inputPreview: draft.rawArguments }),
    });
  }

  #completeToolCall(
    envelope: EventEnvelope,
    event: Extract<RuntimeEvent, { type: "tool_call_completed" }>,
  ): void {
    const draft = this.#startToolCall(envelope, event.index, event.id, event.name);
    draft.name = event.name;
    const preview = boundedRollingToolPreview(event.rawArguments, this.#limits.maxToolPreviewBytes);
    draft.rawArguments = preview.text;
    draft.rawArgumentHead = preview.head;
    draft.rawArgumentTail = preview.tail;
    draft.truncated = preview.truncated;
    const projection = event.arguments === undefined
      ? {
          ...(event.parseError === undefined
            ? {}
            : { summary: `Arguments unavailable · ${boundedToolPreview(event.parseError, this.#limits.maxToolPreviewBytes)}` }),
          inputPreview: draft.rawArguments,
        }
      : projectToolInput(
          event.name,
          event.arguments,
          event.rawArguments,
          this.#limits.maxToolPreviewBytes,
        );
    this.#upsertTool(draft.callId, draft.name, "pending", {
      argsComplete: true,
      executionStarted: false,
      ...projection,
    });
  }

  #claimToolCallDraft(callId: string, name: string, index: number, entryId: string): void {
    const draft = [...this.#liveToolCalls.values()].find((candidate) => candidate.providerCallId === callId)
      ?? [...this.#liveToolCalls.values()].find(
        (candidate) => candidate.step === this.#assistantStep && candidate.index === index,
      )
      ?? [...this.#liveToolCalls.values()].find(
        (candidate) => candidate.step === this.#assistantStep && candidate.name === name,
    );
    if (draft === undefined) return;
    const entry = draft.callId === callId
      ? this.#entries.findLast((candidate) => candidate.callId === callId)
      : this.#renameToolCall(draft.callId, callId);
    if (entry !== undefined && entry.id !== entryId) {
      const wasMutable = this.#mutableEntryIds.delete(entry.id);
      entry.id = entryId;
      if (wasMutable) this.#mutableEntryIds.add(entry.id);
      this.#refreshEntryBytes(entry);
    }
    this.#liveToolCalls.delete(draft.key);
  }

  #discardAssistantAttempt(envelope: EventEnvelope): void {
    const textPrefix = eventKey(envelope, `text:${this.#assistantStep}:`);
    const reasoningPrefix = eventKey(envelope, `reasoning:${this.#assistantStep}:`);
    for (const entry of [...this.#entries]) {
      if (
        this.#mutableEntryIds.has(entry.id)
        && (entry.id.startsWith(textPrefix) || entry.id.startsWith(reasoningPrefix))
      ) this.#removeEntry(entry);
    }
    this.#discardToolCallDrafts(this.#assistantStep);
  }

  #discardToolCallDrafts(step: number): void {
    for (const draft of [...this.#liveToolCalls.values()]) {
      if (draft.step !== step) continue;
      const entry = this.#entries.findLast((candidate) => candidate.callId === draft.callId);
      if (entry !== undefined && this.#mutableEntryIds.has(entry.id)) this.#removeEntry(entry);
      this.#liveToolCalls.delete(draft.key);
    }
  }

  #settleRunTools(): void {
    for (const entry of [...this.#runToolEntries]) {
      if (entry.callId !== undefined) this.#toolProgressSequences.delete(entry.callId);
      if (entry.status !== "pending" && entry.status !== "running") continue;
      if (!this.#messageIdByEntry.has(entry)) {
        this.#removeEntry(entry);
        continue;
      }
      entry.status = "in_doubt";
      if (entry.toolData !== undefined) {
        const { progress: _progress, partialResult: _partialResult, ...settled } = entry.toolData;
        if (Object.keys(settled).length === 0) delete entry.toolData;
        else entry.toolData = settled;
      }
      this.#mutableEntryIds.delete(entry.id);
      this.#refreshEntryBytes(entry);
    }
    this.#runToolEntries.clear();
    this.#liveToolCalls.clear();
    this.#toolProgressSequences.clear();
  }

  #removeEntry(entry: TranscriptEntry): void {
    const index = this.#entries.indexOf(entry);
    if (index < 0) return;
    this.#entries.splice(index, 1);
    this.#transcriptBytes -= this.#entryBytes.get(entry) ?? 0;
    this.#dropDirectToolResultContent(entry);
    this.#releaseMessageEntry(entry);
    this.#mutableEntryIds.delete(entry.id);
    this.#runToolEntries.delete(entry);
    this.#currentAssistantEntries.delete(entry);
    if (entry.callId !== undefined) this.#toolProgressSequences.delete(entry.callId);
  }

  #renameToolCall(fromCallId: string, toCallId: string): TranscriptEntry | undefined {
    if (fromCallId === toCallId) return this.#entries.findLast((entry) => entry.callId === toCallId);
    const source = this.#entries.findLast((entry) => entry.callId === fromCallId);
    if (source === undefined) return undefined;
    source.callId = toCallId;
    const progressSequence = this.#toolProgressSequences.get(fromCallId);
    this.#toolProgressSequences.delete(fromCallId);
    if (progressSequence !== undefined) this.#toolProgressSequences.set(toCallId, progressSequence);
    this.#refreshEntryBytes(source);
    return source;
  }

  #appendDelta(id: string, kind: "assistant" | "reasoning", value: string): void {
    const safe = sanitizeTerminalText(value);
    if (safe === "") return;
    const entry = this.#entries.findLast((item) => item.id === id);
    if (entry === undefined) {
      this.#append({
        id,
        kind,
        text: safe,
        streaming: true,
        ...(kind === "reasoning" ? { expanded: this.#reasoningExpanded } : {}),
      });
    } else {
      entry.text = byteTruncate(`${entry.text}${safe}`, this.#limits.maxTranscriptBytes);
      entry.streaming = true;
    }
    const selected = this.#entries.findLast((item) => item.id === id);
    if (kind === "assistant" && selected !== undefined) {
      this.#currentAssistantEntries.add(selected);
      if (this.#currentAssistantStepToolBearing) selected.hasToolCalls = true;
    }
    if (kind === "reasoning" && selected !== undefined) this.#placeReasoningBeforeFinalAnswer(selected);
    if (entry !== undefined) this.#refreshEntryBytes(entry);
    this.#mutableEntryIds.add(id);
  }

  #upsertTool(
    callId: string,
    name: string,
    status: "pending" | "running" | "completed" | "failed" | "in_doubt",
    values: {
      argsComplete?: boolean;
      executionStarted?: boolean;
      text?: string;
      summary?: string;
      inputPreview?: string;
      clearInputPreview?: boolean;
      input?: JsonValue;
      result?: NonNullable<NonNullable<TranscriptEntry["toolData"]>["result"]>;
      progress?: LiveToolProgress;
      partialResult?: NonNullable<NonNullable<TranscriptEntry["toolData"]>["partialResult"]>;
      clearProgress?: boolean;
      images?: readonly TranscriptImage[];
      directResultContent?: readonly (TextBlock | ImageBlock)[];
    } = {},
    entryId?: string,
  ): TranscriptEntry {
    const entry = entryId === undefined
      ? this.#entries.findLast((item) => item.callId === callId)
      : this.#entries.findLast((item) => item.id === entryId);
    const expanded = entry?.expanded ?? this.#toolOutputExpanded;
    if (entry === undefined) {
      const created = this.#append({
        id: entryId ?? `tool:${callId}`,
        kind: "tool",
        callId,
        title: sanitizeTerminalText(name),
        text: sanitizeTerminalText(values.text ?? ""),
        ...(values.summary === undefined ? {} : { summary: sanitizeTerminalText(values.summary) }),
        ...(values.inputPreview === undefined ? {} : { inputPreview: sanitizeTerminalText(values.inputPreview) }),
        ...(values.input === undefined && values.argsComplete === undefined && values.executionStarted === undefined
            && values.result === undefined && values.progress === undefined && values.partialResult === undefined
          ? {}
          : { toolData: {
              ...(values.argsComplete === undefined ? {} : { argsComplete: values.argsComplete }),
              ...(values.executionStarted === undefined ? {} : { executionStarted: values.executionStarted }),
              ...(values.input === undefined ? {} : { input: values.input }),
              ...(values.progress === undefined ? {} : { progress: values.progress }),
              ...(values.partialResult === undefined ? {} : { partialResult: values.partialResult }),
              ...(values.result === undefined ? {} : { result: values.result }),
            } }),
        status,
        expanded,
        ...(values.images === undefined || values.images.length === 0 ? {} : { images: values.images }),
      });
      if (values.directResultContent !== undefined) {
        this.#setDirectToolResultContent(created, values.directResultContent);
      }
      return created;
    }
    entry.title = sanitizeTerminalText(name);
    entry.status = status;
    if (values.text !== undefined) entry.text = sanitizeTerminalText(values.text);
    if (values.summary !== undefined) entry.summary = sanitizeTerminalText(values.summary);
    if (values.clearInputPreview === true) delete entry.inputPreview;
    if (values.inputPreview !== undefined) entry.inputPreview = sanitizeTerminalText(values.inputPreview);
    if (values.images !== undefined) {
      if (values.images.length === 0) delete entry.images;
      else entry.images = values.images;
    }
    if (values.directResultContent !== undefined) {
      this.#setDirectToolResultContent(entry, values.directResultContent);
    }
    if (
      values.input !== undefined || values.argsComplete !== undefined || values.executionStarted !== undefined
      || values.result !== undefined || values.progress !== undefined ||
      values.partialResult !== undefined || values.clearProgress === true
    ) entry.toolData = {
      ...(entry.toolData?.argsComplete === undefined ? {} : { argsComplete: entry.toolData.argsComplete }),
      ...(entry.toolData?.executionStarted === undefined ? {} : { executionStarted: entry.toolData.executionStarted }),
      ...(entry.toolData?.input === undefined ? {} : { input: entry.toolData.input }),
      ...(entry.toolData?.progress === undefined || values.clearProgress === true ? {} : { progress: entry.toolData.progress }),
      ...(entry.toolData?.partialResult === undefined || values.clearProgress === true
        ? {}
        : { partialResult: entry.toolData.partialResult }),
      ...(entry.toolData?.result === undefined ? {} : { result: entry.toolData.result }),
      ...(values.argsComplete === undefined ? {} : { argsComplete: values.argsComplete }),
      ...(values.executionStarted === undefined ? {} : { executionStarted: values.executionStarted }),
      ...(values.input === undefined ? {} : { input: values.input }),
      ...(values.progress === undefined ? {} : { progress: values.progress }),
      ...(values.partialResult === undefined ? {} : { partialResult: values.partialResult }),
      ...(values.result === undefined ? {} : { result: values.result }),
    };
    this.#refreshEntryBytes(entry);
    return entry;
  }

  #updateToolProgress(
    callId: string,
    name: string,
    update: Extract<RuntimeEvent, { type: "tool_progress" }>["progress"],
  ): TranscriptEntry {
    if (update.type === "result") {
      let entry = this.#upsertTool(callId, name, "running", {
        argsComplete: true,
        executionStarted: true,
      });
      const partialResult = {
        ...boundedToolResult(update.content, update.isError, update.metadata, this.#limits.maxToolPreviewBytes),
        ...(update.truncated === true ? { truncated: true } : {}),
      };
      entry = this.#upsertTool(callId, name, "running", {
        argsComplete: true,
        executionStarted: true,
        text: partialResult.content,
        partialResult,
        directResultContent: projectRuntimeDirectToolRenderContent({
          content: update.content,
          isError: update.isError,
        }, { maximumBytes: this.#limits.maxToolPreviewBytes }),
      });
      return entry;
    }
    return this.#updateToolProgressOutput(callId, name, {
      output: update.delta,
      stdout: update.stream === "stdout" ? update.delta : "",
      stderr: update.stream === "stderr" ? update.delta : "",
      stdoutBytes: update.stdoutBytes,
      stderrBytes: update.stderrBytes,
      ...(update.elapsedMs === undefined ? {} : { elapsedMs: update.elapsedMs }),
      stream: update.stream,
      truncated: update.truncated === true,
    });
  }

  #updateToolProgressOutput(
    callId: string,
    name: string,
    update: LiveToolProgressOutputBatch,
  ): TranscriptEntry {
    const entry = this.#upsertTool(callId, name, "running", {
      argsComplete: true,
      executionStarted: true,
    });
    const prior = entry.toolData?.progress ?? {
      output: "",
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
    };
    const safeOutput = sanitizeTerminalText(update.output);
    const safeStdout = sanitizeTerminalText(update.stdout);
    const safeStderr = sanitizeTerminalText(update.stderr);
    const appendedOutput = `${prior.output ?? ""}${safeOutput}`;
    const appendedStdout = `${prior.stdout}${safeStdout}`;
    const appendedStderr = `${prior.stderr}${safeStderr}`;
    const combined = byteTail(appendedOutput, this.#limits.maxToolPreviewBytes);
    const selected = update.stream === "stdout" ? appendedStdout : appendedStderr;
    const other = update.stream === "stdout" ? appendedStderr : appendedStdout;
    const bounded = byteTail(selected, this.#limits.maxToolPreviewBytes);
    const remaining = Math.max(0, this.#limits.maxToolPreviewBytes - Buffer.byteLength(bounded, "utf8"));
    const boundedOther = byteTail(other, remaining);
    const progress: LiveToolProgress = {
      output: combined,
      stdout: update.stream === "stdout" ? bounded : boundedOther,
      stderr: update.stream === "stderr" ? bounded : boundedOther,
      stdoutBytes: Math.max(prior.stdoutBytes, update.stdoutBytes),
      stderrBytes: Math.max(prior.stderrBytes, update.stderrBytes),
      ...(update.elapsedMs === undefined && prior.elapsedMs === undefined
        ? {}
        : { elapsedMs: update.elapsedMs ?? prior.elapsedMs }),
      truncated: prior.truncated
        || update.truncated
        || combined !== appendedOutput
        || bounded !== selected
        || boundedOther !== other,
    };
    return this.#upsertTool(callId, name, "running", {
      argsComplete: true,
      executionStarted: true,
      text: liveToolProgressText(progress),
      progress,
    });
  }

  #append(entry: TranscriptEntry): TranscriptEntry {
    const appended: TranscriptEntry = {
      ...entry,
      text: sanitizeTerminalText(entry.text),
      ...(entry.compactText === undefined ? {} : { compactText: sanitizeTerminalText(entry.compactText) }),
      ...(entry.title === undefined ? {} : { title: sanitizeTerminalText(entry.title) }),
      ...(entry.summary === undefined ? {} : { summary: sanitizeTerminalText(entry.summary) }),
      ...(entry.inputPreview === undefined ? {} : { inputPreview: sanitizeTerminalText(entry.inputPreview) }),
    };
    this.#entries.push(appended);
    this.#refreshEntryBytes(appended);
    return appended;
  }

  #setDirectToolResultContent(
    entry: TranscriptEntry,
    content: readonly (TextBlock | ImageBlock)[],
  ): void {
    const previous = this.#directToolResultContentBytes.get(entry) ?? 0;
    const next = directToolResultContentBytes(content);
    this.#directToolResultContent.set(entry, content);
    this.#directToolResultContentBytes.set(entry, next);
    this.#retainedDirectToolResultBytes += next - previous;
    if (this.#retainedDirectToolResultBytes <= this.#limits.maxTranscriptBytes) return;
    // Preserve the current bounded renderer payload and shed older payloads first.
    for (const candidate of this.#entries) {
      if (this.#retainedDirectToolResultBytes <= this.#limits.maxTranscriptBytes) break;
      if (candidate !== entry) this.#dropDirectToolResultContent(candidate);
    }
  }

  #dropDirectToolResultContent(entry: TranscriptEntry): void {
    if (!this.#directToolResultContent.delete(entry)) return;
    this.#retainedDirectToolResultBytes -= this.#directToolResultContentBytes.get(entry) ?? 0;
    this.#directToolResultContentBytes.delete(entry);
  }

  #ownMessageEntries(messageId: string, entries: readonly TranscriptEntry[]): void {
    const owned = this.#messageEntriesById.get(messageId) ?? new Set<TranscriptEntry>();
    for (const entry of entries) {
      const previousMessageId = this.#messageIdByEntry.get(entry);
      if (previousMessageId === messageId) continue;
      if (previousMessageId !== undefined) this.#releaseMessageEntry(entry);
      entry.sourceMessageId = messageId;
      this.#refreshEntryBytes(entry);
      this.#messageIdByEntry.set(entry, messageId);
      owned.add(entry);
    }
    if (owned.size > 0) this.#messageEntriesById.set(messageId, owned);
  }

  #releaseMessageEntry(entry: TranscriptEntry): void {
    const messageId = this.#messageIdByEntry.get(entry);
    if (messageId === undefined) {
      this.#messageIds.delete(entry.id);
      return;
    }
    this.#messageIdByEntry.delete(entry);
    const owned = this.#messageEntriesById.get(messageId);
    owned?.delete(entry);
    if (owned !== undefined && owned.size > 0) return;
    this.#messageEntriesById.delete(messageId);
    this.#messageIds.delete(messageId);
  }

  #refreshEntryBytes(entry: TranscriptEntry): void {
    const previous = this.#entryBytes.get(entry) ?? 0;
    const next = transcriptEntryBytes(entry);
    this.#entryBytes.set(entry, next);
    this.#transcriptBytes += next - previous;
  }

  #bound(): void {
    let removeCount = 0;
    while (
      this.#entries.length - removeCount > this.#limits.maxTranscriptEntries
      || this.#transcriptBytes > this.#limits.maxTranscriptBytes
    ) {
      const removed = this.#entries[removeCount];
      if (removed === undefined) break;
      this.#transcriptBytes -= this.#entryBytes.get(removed) ?? 0;
      removeCount += 1;
    }
    for (const removed of this.#entries.splice(0, removeCount)) {
      this.#dropDirectToolResultContent(removed);
      this.#releaseMessageEntry(removed);
      this.#mutableEntryIds.delete(removed.id);
      this.#runToolEntries.delete(removed);
      this.#currentAssistantEntries.delete(removed);
      if (removed.callId !== undefined) this.#toolProgressSequences.delete(removed.callId);
      this.#truncated = true;
    }
    if (this.#truncated) this.#notice = "Older transcript entries were discarded from the viewport";
  }
}
