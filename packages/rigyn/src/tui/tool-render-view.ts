import type { JsonValue } from "../core/json.js";
import type {
  ImageBlock,
  NormalizedUsage,
  TextBlock,
  ToolResultBlock,
} from "../core/types.js";
import { byteTail, byteTruncate, sanitizeTerminalText } from "./unicode.js";

export interface RuntimeToolRenderImageDescriptor {
  readonly type: "image";
  readonly mediaType: string;
  /** Zero-based position in the original ordered result content. */
  readonly index: number;
}

export type RuntimeToolRenderContentBlock = TextBlock | RuntimeToolRenderImageDescriptor;
export type RuntimeToolRenderUsage = Omit<NormalizedUsage, "raw">;
export type RuntimeDirectToolRenderContent = readonly (TextBlock | ImageBlock)[];
export const DIRECT_TOOL_RENDER_RESULT = Symbol("rigyn.direct-tool-render-result");

export interface RuntimeToolRenderResult {
  readonly content: string;
  readonly contentBlocks?: readonly RuntimeToolRenderContentBlock[];
  readonly isError: boolean;
  readonly status?: "success" | "warning" | "error";
  readonly summary?: string;
  readonly nextActions?: readonly string[];
  readonly metadata?: JsonValue;
  readonly usage?: RuntimeToolRenderUsage;
  readonly addedToolNames?: readonly string[];
  readonly truncated?: boolean;
}

export interface RuntimeToolRenderProgress {
  /** Output in arrival order when the runtime can preserve the merged stream. */
  readonly output?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly elapsedMs?: number;
  readonly truncated: boolean;
}

export interface RuntimeToolRenderView {
  readonly callId: string;
  readonly name: string;
  readonly input?: JsonValue;
  readonly result?: RuntimeToolRenderResult;
  readonly progress?: RuntimeToolRenderProgress;
  /** True when result is a replaceable live update rather than the terminal tool result. */
  readonly isPartial?: boolean;
  readonly argsComplete: boolean;
  readonly executionStarted: boolean;
  readonly status: "pending" | "running" | "completed" | "failed" | "in_doubt";
  readonly expanded: boolean;
}

type RuntimeToolResultSource = Pick<
  ToolResultBlock,
  | "content"
  | "contentBlocks"
  | "isError"
  | "status"
  | "summary"
  | "nextActions"
  | "images"
  | "metadata"
  | "usage"
  | "addedToolNames"
> & { truncated?: boolean };

const MAX_DIRECT_RESULT_IMAGES = 4;
const MAX_DIRECT_RESULT_IMAGE_DATA_BYTES = 12 * 1024 * 1024;

function orderedResultBlocks(source: RuntimeToolResultSource): readonly (TextBlock | ImageBlock)[] {
  return source.contentBlocks ?? ((source.images?.length ?? 0) === 0
    ? []
    : [
        ...(source.content === "" ? [] : [{ type: "text" as const, text: source.content }]),
        ...source.images!,
      ]);
}

/** Retains bounded canonical blocks only for the trusted direct-renderer boundary. */
export function projectRuntimeDirectToolRenderContent(
  source: RuntimeToolResultSource,
  options: { maximumBytes: number },
): RuntimeDirectToolRenderContent {
  let remainingText = Math.max(1, Math.floor(options.maximumBytes));
  let remainingImageData = MAX_DIRECT_RESULT_IMAGE_DATA_BYTES;
  let imageCount = 0;
  const selected: (TextBlock | ImageBlock)[] = [];
  const sourceBlocks = source.contentBlocks ?? [
    ...(source.content === "" ? [] : [{ type: "text" as const, text: source.content }]),
    ...(source.images ?? []),
  ];
  for (const block of sourceBlocks.slice(0, 256)) {
    if (block.type === "text") {
      if (remainingText <= 0) continue;
      const text = byteTruncate(block.text, remainingText);
      remainingText -= Buffer.byteLength(text, "utf8");
      selected.push(Object.freeze({ type: "text", text }));
      continue;
    }
    if (block.data === undefined || imageCount >= MAX_DIRECT_RESULT_IMAGES) continue;
    const bytes = Buffer.byteLength(block.data, "utf8");
    if (bytes > remainingImageData) continue;
    remainingImageData -= bytes;
    imageCount += 1;
    selected.push(Object.freeze({
      type: "image",
      mediaType: byteTruncate(block.mediaType, 1_024),
      data: block.data,
    }));
  }
  return Object.freeze(selected);
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

function boundedStrings(
  values: readonly string[] | undefined,
  maximumCount: number,
  maximumBytes: number,
): string[] | undefined {
  if (values === undefined) return undefined;
  let remaining = maximumBytes;
  const selected: string[] = [];
  for (const value of values.slice(0, maximumCount)) {
    if (remaining <= 0) break;
    const safe = byteTruncate(sanitizeTerminalText(value), remaining);
    remaining -= Buffer.byteLength(safe, "utf8");
    selected.push(safe);
  }
  return selected;
}

function safeUsage(
  usage: NormalizedUsage | undefined,
  maximumBytes: number,
): RuntimeToolRenderUsage | undefined {
  if (usage === undefined) return undefined;
  const { raw: _raw, ...withoutRaw } = usage;
  return boundedJsonView(withoutRaw as JsonValue, maximumBytes) as RuntimeToolRenderUsage | undefined;
}

/**
 * Produces the only result shape exposed to ordinary tool renderers.
 * Image payloads remain host-owned and appear here only as ordered descriptors.
 */
export function projectRuntimeToolRenderResult(
  source: RuntimeToolResultSource,
  options: { maximumBytes: number; tail?: boolean },
): RuntimeToolRenderResult {
  const maximumBytes = Math.max(1, Math.floor(options.maximumBytes));
  const safeContent = sanitizeTerminalText(source.content);
  const content = options.tail === true
    ? byteTail(safeContent, maximumBytes)
    : byteTruncate(safeContent, maximumBytes);
  const sourceBlocks = orderedResultBlocks(source);
  let remaining = maximumBytes;
  const contentBlocks: RuntimeToolRenderContentBlock[] = [];
  for (const [index, block] of sourceBlocks.slice(0, 256).entries()) {
    if (block.type === "image") {
      contentBlocks.push({
        type: "image",
        mediaType: byteTruncate(sanitizeTerminalText(block.mediaType), 1_024),
        index,
      });
      continue;
    }
    if (remaining <= 0) continue;
    const text = byteTruncate(sanitizeTerminalText(block.text), remaining);
    remaining -= Buffer.byteLength(text, "utf8");
    contentBlocks.push({ type: "text", text });
  }
  const metadata = source.metadata === undefined
    ? undefined
    : boundedJsonView(source.metadata, maximumBytes);
  const usage = safeUsage(source.usage, maximumBytes);
  const nextActions = boundedStrings(source.nextActions, 8, maximumBytes);
  const addedToolNames = boundedStrings(source.addedToolNames, 256, maximumBytes);
  return {
    content,
    ...(contentBlocks.length === 0 ? {} : { contentBlocks }),
    isError: source.isError,
    ...(source.status === undefined ? {} : { status: source.status }),
    ...(source.summary === undefined
      ? {}
      : { summary: byteTruncate(sanitizeTerminalText(source.summary), maximumBytes) }),
    ...(nextActions === undefined ? {} : { nextActions }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(usage === undefined ? {} : { usage }),
    ...(addedToolNames === undefined ? {} : { addedToolNames }),
    ...(source.truncated === true ? { truncated: true } : {}),
  };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(object)) deepFreeze(child, seen);
  return Object.freeze(value);
}

/** Clones and deeply freezes a bounded renderer view before caller code receives it. */
export function immutableRuntimeToolRenderView(
  view: RuntimeToolRenderView,
): Readonly<RuntimeToolRenderView> {
  return deepFreeze(structuredClone(view));
}
