export const HARNESS_TRANSCRIPT_SCHEMA_VERSION = 1 as const;

export const HARNESS_TRANSCRIPT_LIMITS = Object.freeze({
  maxEntries: 256,
  maxBytes: 1024 * 1024,
  maxTextBytes: 64 * 1024,
  maxImagesPerEntry: 32,
  maxIdentifierBytes: 1_024,
});

export interface HarnessTranscriptImage {
  mediaType: string;
  source: "embedded" | "remote";
}

export interface HarnessTranscriptEntryBase {
  eventId: string;
  sequence: number;
  timestamp: string;
  runId?: string;
  text?: string;
  images?: HarnessTranscriptImage[];
  truncated?: true;
}

export interface HarnessTranscriptMessageEntry extends HarnessTranscriptEntryBase {
  kind: "message";
  role: "user" | "assistant";
  messageId: string;
}

export interface HarnessTranscriptReasoningEntry extends HarnessTranscriptEntryBase {
  kind: "reasoning";
  part: number;
}

export interface HarnessTranscriptToolEntry extends HarnessTranscriptEntryBase {
  kind: "tool";
  callId: string;
  name: string;
  status: "requested" | "running" | "completed" | "error" | "in_doubt";
}

export interface HarnessTranscriptExtensionEntry extends HarnessTranscriptEntryBase {
  kind: "extension";
  extensionId: string;
  schemaVersion: number;
  messageKind: string;
  messageId: string;
}

export interface HarnessTranscriptSummaryEntry extends HarnessTranscriptEntryBase {
  kind: "summary";
  summaryType: "compaction" | "branch";
  sourceCount: number;
  sourceBranch?: string;
}

export interface HarnessTranscriptStatusEntry extends HarnessTranscriptEntryBase {
  kind: "status";
  statusType: "retry" | "failed" | "cancelled" | "warning";
  code?: string;
}

export type HarnessTranscriptEntry =
  | HarnessTranscriptMessageEntry
  | HarnessTranscriptReasoningEntry
  | HarnessTranscriptToolEntry
  | HarnessTranscriptExtensionEntry
  | HarnessTranscriptSummaryEntry
  | HarnessTranscriptStatusEntry;

export interface HarnessTranscriptPage {
  schemaVersion: typeof HARNESS_TRANSCRIPT_SCHEMA_VERSION;
  threadId: string;
  branch: string;
  entries: HarnessTranscriptEntry[];
  nextSequence?: number;
  hasMore: boolean;
  /** True when visible entry text or image metadata was clipped. */
  truncated: boolean;
}

export interface HarnessTranscriptRequest {
  threadId: string;
  branch?: string;
  /** Exclusive durable event-sequence cursor. */
  afterSequence?: number;
  limit?: number;
  signal?: AbortSignal;
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be plain JSON data`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${label} contains an unknown symbol field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new Error(`${label} must contain only enumerable data fields`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exact(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}`);
}

function dataArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} is invalid`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new Error(`${label} must contain only enumerable data entries`);
    }
    result.push(descriptor.value);
  }
  const unknown = Reflect.ownKeys(descriptors).filter((key) =>
    key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields`);
  return result;
}

function string(value: unknown, label: string, maximum: number = HARNESS_TRANSCRIPT_LIMITS.maxIdentifierBytes): string {
  if (typeof value !== "string" || value === "" || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`);
  return value as number;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > HARNESS_TRANSCRIPT_LIMITS.maxTextBytes) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalText(record: Record<string, unknown>, result: HarnessTranscriptEntryBase): void {
  if (record.text !== undefined) result.text = text(record.text, "Transcript entry text");
  if (record.truncated !== undefined) {
    if (record.truncated !== true) throw new Error("Transcript entry truncated flag is invalid");
    result.truncated = true;
  }
  if (record.images !== undefined) {
    result.images = dataArray(record.images, "Transcript entry images", HARNESS_TRANSCRIPT_LIMITS.maxImagesPerEntry).map((value, index) => {
      const image = dataRecord(value, `Transcript image ${index}`);
      exact(image, ["mediaType", "source"], `Transcript image ${index}`);
      if (image.source !== "embedded" && image.source !== "remote") throw new Error(`Transcript image ${index} source is invalid`);
      return {
        mediaType: string(image.mediaType, `Transcript image ${index} mediaType`, 256),
        source: image.source,
      };
    });
  }
}

function parseEntry(value: unknown): HarnessTranscriptEntry {
  const record = dataRecord(value, "Transcript entry");
  const common = ["eventId", "sequence", "timestamp", "runId", "text", "images", "truncated", "kind"];
  const base: HarnessTranscriptEntryBase = {
    eventId: string(record.eventId, "Transcript eventId"),
    sequence: integer(record.sequence, "Transcript sequence"),
    timestamp: string(record.timestamp, "Transcript timestamp", 128),
  };
  if (record.runId !== undefined) base.runId = string(record.runId, "Transcript runId");
  optionalText(record, base);
  switch (record.kind) {
    case "message":
      exact(record, [...common, "role", "messageId"], "Transcript message entry");
      if (record.role !== "user" && record.role !== "assistant") throw new Error("Transcript message role is invalid");
      return { ...base, kind: "message", role: record.role, messageId: string(record.messageId, "Transcript messageId") };
    case "reasoning":
      exact(record, [...common, "part"], "Transcript reasoning entry");
      return { ...base, kind: "reasoning", part: integer(record.part, "Transcript reasoning part") };
    case "tool":
      exact(record, [...common, "callId", "name", "status"], "Transcript tool entry");
      if (!["requested", "running", "completed", "error", "in_doubt"].includes(String(record.status))) {
        throw new Error("Transcript tool status is invalid");
      }
      return {
        ...base,
        kind: "tool",
        callId: string(record.callId, "Transcript tool callId"),
        name: string(record.name, "Transcript tool name"),
        status: record.status as HarnessTranscriptToolEntry["status"],
      };
    case "extension":
      exact(record, [...common, "extensionId", "schemaVersion", "messageKind", "messageId"], "Transcript extension entry");
      if (!Number.isSafeInteger(record.schemaVersion) || (record.schemaVersion as number) < 1) {
        throw new Error("Transcript extension schemaVersion is invalid");
      }
      return {
        ...base,
        kind: "extension",
        extensionId: string(record.extensionId, "Transcript extensionId"),
        schemaVersion: integer(record.schemaVersion, "Transcript extension schemaVersion"),
        messageKind: string(record.messageKind, "Transcript extension messageKind"),
        messageId: string(record.messageId, "Transcript extension messageId"),
      };
    case "summary": {
      exact(record, [...common, "summaryType", "sourceCount", "sourceBranch"], "Transcript summary entry");
      if (record.summaryType !== "compaction" && record.summaryType !== "branch") throw new Error("Transcript summary type is invalid");
      const result: HarnessTranscriptSummaryEntry = {
        ...base,
        kind: "summary",
        summaryType: record.summaryType,
        sourceCount: integer(record.sourceCount, "Transcript summary sourceCount"),
      };
      if (record.sourceBranch !== undefined) result.sourceBranch = string(record.sourceBranch, "Transcript summary sourceBranch");
      return result;
    }
    case "status": {
      exact(record, [...common, "statusType", "code"], "Transcript status entry");
      if (!["retry", "failed", "cancelled", "warning"].includes(String(record.statusType))) {
        throw new Error("Transcript status type is invalid");
      }
      const result: HarnessTranscriptStatusEntry = {
        ...base,
        kind: "status",
        statusType: record.statusType as HarnessTranscriptStatusEntry["statusType"],
      };
      if (record.code !== undefined) result.code = string(record.code, "Transcript status code");
      return result;
    }
    default:
      throw new Error("Transcript entry kind is invalid");
  }
}

/** Re-validates a host result before it crosses the runtime-extension boundary. */
export function parseHarnessTranscriptPage(value: unknown): HarnessTranscriptPage {
  const record = dataRecord(value, "Transcript page");
  exact(record, ["schemaVersion", "threadId", "branch", "entries", "nextSequence", "hasMore", "truncated"], "Transcript page");
  if (record.schemaVersion !== HARNESS_TRANSCRIPT_SCHEMA_VERSION) throw new Error("Transcript page schemaVersion is invalid");
  if (typeof record.hasMore !== "boolean" || typeof record.truncated !== "boolean") {
    throw new Error("Transcript page flags are invalid");
  }
  const entries = dataArray(record.entries, "Transcript page entries", HARNESS_TRANSCRIPT_LIMITS.maxEntries).map(parseEntry);
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index]!.sequence <= entries[index - 1]!.sequence) throw new Error("Transcript page sequences are not strictly increasing");
  }
  const result: HarnessTranscriptPage = {
    schemaVersion: HARNESS_TRANSCRIPT_SCHEMA_VERSION,
    threadId: string(record.threadId, "Transcript threadId"),
    branch: string(record.branch, "Transcript branch"),
    entries,
    hasMore: record.hasMore,
    truncated: record.truncated,
  };
  if (record.nextSequence !== undefined) result.nextSequence = integer(record.nextSequence, "Transcript nextSequence");
  if (entries.length === 0 && result.nextSequence !== undefined) throw new Error("Empty transcript page must not have nextSequence");
  if (entries.length > 0 && result.nextSequence !== entries.at(-1)!.sequence) {
    throw new Error("Transcript nextSequence does not match the last entry");
  }
  if (result.hasMore && entries.length === 0) throw new Error("Transcript page cannot have more entries without a cursor");
  if (result.truncated !== entries.some((entry) => entry.truncated === true)) {
    throw new Error("Transcript page truncated flag is inconsistent");
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > HARNESS_TRANSCRIPT_LIMITS.maxBytes) {
    throw new Error(`Transcript page exceeds ${HARNESS_TRANSCRIPT_LIMITS.maxBytes} bytes`);
  }
  return result;
}
