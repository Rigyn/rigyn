import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { defaultSecretRedactor } from "../auth/redaction.js";
import type { EventEnvelope } from "../core/events.js";
import type { CanonicalMessage, ImageBlock } from "../core/types.js";
import {
  HARNESS_TRANSCRIPT_LIMITS,
  HARNESS_TRANSCRIPT_SCHEMA_VERSION,
  type HarnessTranscriptEntry,
  type HarnessTranscriptEntryBase,
  type HarnessTranscriptImage,
  type HarnessTranscriptPage,
} from "./transcript.js";

interface TranscriptProjectionInput {
  threadId: string;
  branch: string;
  events: readonly EventEnvelope[];
  afterSequence?: number;
  limit?: number;
  signal?: AbortSignal;
}

function boundedText(value: string): { text: string; truncated: boolean } {
  const safe = defaultSecretRedactor.redact(value).replaceAll("\0", "�");
  const bytes = Buffer.from(safe, "utf8");
  if (bytes.byteLength <= HARNESS_TRANSCRIPT_LIMITS.maxTextBytes) return { text: safe, truncated: false };
  return {
    text: bytes.subarray(0, HARNESS_TRANSCRIPT_LIMITS.maxTextBytes).toString("utf8").replace(/�$/u, ""),
    truncated: true,
  };
}

function boundedIdentifier(value: string, maximum: number = HARNESS_TRANSCRIPT_LIMITS.maxIdentifierBytes): string {
  const safe = defaultSecretRedactor.redact(value).replaceAll("\0", "�");
  const bytes = Buffer.from(safe, "utf8");
  return bytes.byteLength <= maximum
    ? safe
    : bytes.subarray(0, maximum).toString("utf8").replace(/�$/u, "");
}

function base(envelope: EventEnvelope): HarnessTranscriptEntryBase {
  return {
    eventId: boundedIdentifier(envelope.eventId),
    sequence: envelope.sequence,
    timestamp: boundedIdentifier(envelope.timestamp, 128),
    ...(envelope.runId === undefined ? {} : { runId: boundedIdentifier(envelope.runId) }),
  };
}

function images(blocks: readonly ImageBlock[] | undefined): { images?: HarnessTranscriptImage[]; truncated: boolean } {
  const selected = blocks ?? [];
  const projected = selected.slice(0, HARNESS_TRANSCRIPT_LIMITS.maxImagesPerEntry).map((image) => ({
    mediaType: boundedIdentifier(image.mediaType, 256),
    source: image.data === undefined ? "remote" as const : "embedded" as const,
  }));
  return {
    ...(projected.length === 0 ? {} : { images: projected }),
    truncated: projected.length < selected.length,
  };
}

function messageText(message: CanonicalMessage): string {
  if (message.displayText !== undefined) return message.displayText;
  return message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}

function messageImages(message: CanonicalMessage): ImageBlock[] {
  return message.content.flatMap((block) => block.type === "image" ? [block] : []);
}

function withVisibleText<T extends HarnessTranscriptEntry>(entry: T, value: string): T {
  const visible = boundedText(value);
  return {
    ...entry,
    text: visible.text,
    ...(visible.truncated ? { truncated: true } : {}),
  } as T;
}

function project(envelope: EventEnvelope): HarnessTranscriptEntry | undefined {
  const event = envelope.event;
  switch (event.type) {
    case "message_appended": {
      if (event.message.role !== "user" && event.message.role !== "assistant") return undefined;
      if (event.message.purpose === "instructions") return undefined;
      const text = boundedText(messageText(event.message));
      const imageProjection = images(messageImages(event.message));
      if (text.text.trim() === "" && imageProjection.images === undefined) return undefined;
      return {
        ...base(envelope),
        kind: "message",
        role: event.message.role,
        messageId: boundedIdentifier(event.message.id),
        ...(text.text === "" ? {} : { text: text.text }),
        ...(imageProjection.images === undefined ? {} : { images: imageProjection.images }),
        ...(text.truncated || imageProjection.truncated ? { truncated: true } : {}),
      };
    }
    case "reasoning_delta":
      if (event.visibility !== "summary") return undefined;
      return withVisibleText({ ...base(envelope), kind: "reasoning", part: event.part }, event.text);
    case "tool_requested":
      return withVisibleText({
        ...base(envelope),
        kind: "tool",
        callId: boundedIdentifier(event.callId),
        name: boundedIdentifier(event.name),
        status: "requested",
      }, `Requested ${event.name}`);
    case "tool_started":
      return withVisibleText({
        ...base(envelope),
        kind: "tool",
        callId: boundedIdentifier(event.callId),
        name: boundedIdentifier(event.name),
        status: "running",
      }, `Running ${event.name}`);
    case "tool_completed": {
      const imageProjection = images(event.result?.images);
      const visible = boundedText(event.result?.summary ?? event.preview);
      return {
        ...base(envelope),
        kind: "tool",
        callId: boundedIdentifier(event.callId),
        name: boundedIdentifier(event.name),
        status: event.isError ? "error" : "completed",
        text: visible.text,
        ...(imageProjection.images === undefined ? {} : { images: imageProjection.images }),
        ...(visible.truncated || imageProjection.truncated ? { truncated: true } : {}),
      };
    }
    case "tool_in_doubt":
      return withVisibleText({
        ...base(envelope),
        kind: "tool",
        callId: boundedIdentifier(event.callId),
        name: boundedIdentifier(event.name),
        status: "in_doubt",
      }, event.reason);
    case "extension_message":
      if (event.transcript === false) return undefined;
      return withVisibleText({
        ...base(envelope),
        kind: "extension",
        extensionId: boundedIdentifier(event.extensionId),
        schemaVersion: event.schemaVersion,
        messageKind: boundedIdentifier(event.kind),
        messageId: boundedIdentifier(event.messageId),
      }, event.transcript.text);
    case "compaction_completed":
      return withVisibleText({
        ...base(envelope),
        kind: "summary",
        summaryType: "compaction",
        sourceCount: event.sourceMessageIds.length,
      }, `Compacted ${event.sourceMessageIds.length} messages`);
    case "branch_summary_created": {
      const visible = boundedText(messageText(event.summary));
      const imageProjection = images(messageImages(event.summary));
      return {
        ...base(envelope),
        kind: "summary",
        summaryType: "branch",
        sourceCount: event.sourceEventIds.length,
        sourceBranch: boundedIdentifier(event.sourceBranch),
        ...(visible.text === "" ? {} : { text: visible.text }),
        ...(imageProjection.images === undefined ? {} : { images: imageProjection.images }),
        ...(visible.truncated || imageProjection.truncated ? { truncated: true } : {}),
      };
    }
    case "retry_scheduled":
      return withVisibleText({ ...base(envelope), kind: "status", statusType: "retry", code: boundedIdentifier(event.category) },
        `Retrying ${event.category} in ${event.delayMs} ms (attempt ${event.attempt})`);
    case "run_failed":
      return withVisibleText({ ...base(envelope), kind: "status", statusType: "failed", code: boundedIdentifier(event.error.category) }, event.error.message);
    case "run_cancelled":
      return withVisibleText({ ...base(envelope), kind: "status", statusType: "cancelled" }, event.reason);
    case "warning":
      if (event.code === "unknown_provider_event") return undefined;
      return withVisibleText({ ...base(envelope), kind: "status", statusType: "warning", code: boundedIdentifier(event.code) }, event.message);
    default:
      return undefined;
  }
}

function validLimit(value: number | undefined): number {
  const selected = value ?? HARNESS_TRANSCRIPT_LIMITS.maxEntries;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > HARNESS_TRANSCRIPT_LIMITS.maxEntries) {
    throw new RangeError(`Transcript limit must be an integer from 1 to ${HARNESS_TRANSCRIPT_LIMITS.maxEntries}`);
  }
  return selected;
}

function validCursor(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError("Transcript afterSequence must be a non-negative safe integer");
  }
  return value;
}

function pageBytes(input: Omit<HarnessTranscriptPage, "entries" | "nextSequence" | "hasMore" | "truncated">, entries: HarnessTranscriptEntry[]): number {
  return Buffer.byteLength(JSON.stringify({
    ...input,
    entries,
    ...(entries.length === 0 ? {} : { nextSequence: entries.at(-1)!.sequence }),
    hasMore: false,
    truncated: entries.some((entry) => entry.truncated === true),
  }), "utf8");
}

export async function projectHarnessTranscriptPage(input: TranscriptProjectionInput): Promise<HarnessTranscriptPage> {
  const limit = validLimit(input.limit);
  const afterSequence = validCursor(input.afterSequence);
  input.signal?.throwIfAborted();
  const pageBase = {
    schemaVersion: HARNESS_TRANSCRIPT_SCHEMA_VERSION,
    threadId: input.threadId,
    branch: input.branch,
  };
  const entries: HarnessTranscriptEntry[] = [];
  let hasMore = false;
  for (let index = 0; index < input.events.length; index += 1) {
    if (index % 64 === 0) {
      input.signal?.throwIfAborted();
      await yieldToEventLoop();
    }
    const envelope = input.events[index]!;
    if (afterSequence !== undefined && envelope.sequence <= afterSequence) continue;
    const entry = project(envelope);
    if (entry === undefined) continue;
    const next = [...entries, entry];
    if (entries.length >= limit || pageBytes(pageBase, next) > HARNESS_TRANSCRIPT_LIMITS.maxBytes) {
      hasMore = true;
      break;
    }
    entries.push(entry);
  }
  input.signal?.throwIfAborted();
  const page: HarnessTranscriptPage = {
    ...pageBase,
    entries,
    ...(entries.length === 0 ? {} : { nextSequence: entries.at(-1)!.sequence }),
    hasMore,
    truncated: entries.some((entry) => entry.truncated === true),
  };
  input.signal?.throwIfAborted();
  return page;
}
