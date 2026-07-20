import type { JsonValue } from "./json.js";
import type { MessageId } from "./ids.js";
import type { CanonicalMessage, ImageBlock } from "./types.js";

export const MAX_EXTENSION_ENTRY_PAYLOAD_BYTES = 256 * 1024;
export const MAX_EXTENSION_ENTRY_TEXT_BYTES = 128 * 1024;
export const MAX_EXTENSION_ENTRY_JSON_DEPTH = 32;
export const MAX_EXTENSION_ENTRY_JSON_NODES = 4_096;
export const MAX_EXTENSION_SCHEMA_VERSION = 65_535;

const EXTENSION_ID = /^[a-z][a-z0-9._-]{0,62}$/u;
const ENTRY_KEY = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

export interface ExtensionStateEvent {
  type: "extension_state";
  extensionId: string;
  schemaVersion: number;
  key: string;
  value: JsonValue;
}

export type ExtensionMessageModelContext = false | {
  role: "system" | "user";
  text: string;
  images?: ImageBlock[];
};

export type ExtensionMessageTranscript = false | {
  text: string;
};

export interface ExtensionMessageEvent {
  type: "extension_message";
  extensionId: string;
  schemaVersion: number;
  kind: string;
  messageId: MessageId;
  payload: JsonValue;
  modelContext: ExtensionMessageModelContext;
  transcript: ExtensionMessageTranscript;
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${label} must not contain symbol keys`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label} must contain only enumerable data properties`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exact(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}`);
}

function identifier(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function validateExtensionId(value: unknown): string {
  return identifier(value, "Extension ID", EXTENSION_ID);
}

export function validateExtensionEntryKey(value: unknown, label = "Extension entry key"): string {
  return identifier(value, label, ENTRY_KEY);
}

function schemaVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_EXTENSION_SCHEMA_VERSION) {
    throw new Error(`Extension schemaVersion must be from 1 through ${MAX_EXTENSION_SCHEMA_VERSION}`);
  }
  return value as number;
}

export function validateExtensionSchemaVersion(value: unknown): number {
  return schemaVersion(value);
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_EXTENSION_ENTRY_TEXT_BYTES
  ) throw new Error(`${label} must be at most ${MAX_EXTENSION_ENTRY_TEXT_BYTES} bytes without NUL`);
  return value;
}

function messageId(value: unknown): MessageId {
  if (typeof value !== "string" || value === "" || value.includes("\0") || Buffer.byteLength(value, "utf8") > 200) {
    throw new Error("Extension messageId is invalid");
  }
  return value as MessageId;
}

interface ExtensionJsonSnapshotState {
  nodes: number;
  bytes: number;
  ancestors: Set<object>;
}

function accountJsonBytes(state: ExtensionJsonSnapshotState, bytes: number): void {
  state.bytes += bytes;
  if (state.bytes > MAX_EXTENSION_ENTRY_PAYLOAD_BYTES) {
    throw new Error(`Extension payload exceeds ${MAX_EXTENSION_ENTRY_PAYLOAD_BYTES} bytes`);
  }
}

function snapshotJsonString(value: string, state: ExtensionJsonSnapshotState): string {
  const rawBytes = Buffer.byteLength(value, "utf8");
  if (rawBytes + 2 > MAX_EXTENSION_ENTRY_PAYLOAD_BYTES - state.bytes) {
    throw new Error(`Extension payload exceeds ${MAX_EXTENSION_ENTRY_PAYLOAD_BYTES} bytes`);
  }
  const serialized = JSON.stringify(value);
  accountJsonBytes(state, Buffer.byteLength(serialized, "utf8"));
  return value;
}

function inspectJson(
  value: unknown,
  depth: number,
  state: ExtensionJsonSnapshotState,
): JsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_EXTENSION_ENTRY_JSON_NODES) {
    throw new Error(`Extension payload exceeds ${MAX_EXTENSION_ENTRY_JSON_NODES} JSON nodes`);
  }
  if (depth > MAX_EXTENSION_ENTRY_JSON_DEPTH) {
    throw new Error(`Extension payload exceeds JSON depth ${MAX_EXTENSION_ENTRY_JSON_DEPTH}`);
  }
  if (value === null) {
    accountJsonBytes(state, 4);
    return null;
  }
  if (typeof value === "string") return snapshotJsonString(value, state);
  if (typeof value === "boolean") {
    accountJsonBytes(state, value ? 4 : 5);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Extension payload contains a non-finite number");
    const normalized = Object.is(value, -0) ? 0 : value;
    accountJsonBytes(state, Buffer.byteLength(String(normalized), "utf8"));
    return normalized;
  }
  if (typeof value !== "object") throw new Error("Extension payload is not canonical JSON");
  if (state.ancestors.has(value)) throw new Error("Extension payload contains a cycle");
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) throw new Error("Extension payload array length is invalid");
      const length = lengthDescriptor.value as number;
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string") throw new Error("Extension payload array contains a symbol key");
        if (key === "length") continue;
        if (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
          throw new Error("Extension payload array contains a non-index property");
        }
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
          throw new Error("Extension payload array contains an accessor or hidden value");
        }
      }
      const result: JsonValue[] = [];
      Object.setPrototypeOf(result, null);
      accountJsonBytes(state, 2 + Math.max(0, length - 1));
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)) throw new Error("Extension payload array is sparse");
        result[index] = inspectJson(descriptor.value, depth + 1, state);
      }
      return result;
    }
    const record = dataRecord(value, "Extension payload object");
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    const entries = Object.entries(record);
    accountJsonBytes(state, 2 + Math.max(0, entries.length - 1));
    for (const [key, entry] of entries) {
      snapshotJsonString(key, state);
      accountJsonBytes(state, 1);
      Object.defineProperty(result, key, {
        value: inspectJson(entry, depth + 1, state),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

export function snapshotExtensionPayload(value: unknown): JsonValue {
  try {
    return inspectJson(value, 0, { nodes: 0, bytes: 0, ancestors: new Set() });
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("Extension payload")) throw cause;
    throw new Error(`Extension payload is invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function modelContext(value: unknown): ExtensionMessageModelContext {
  if (value === false) return false;
  const record = dataRecord(value, "Extension modelContext");
  exact(record, ["role", "text", "images"], "Extension modelContext");
  if (record.role !== "system" && record.role !== "user") throw new Error("Extension modelContext role is invalid");
  let images: ImageBlock[] | undefined;
  if (record.images !== undefined) {
    if (!Array.isArray(record.images) || record.images.length < 1 || record.images.length > 8) {
      throw new Error("Extension modelContext images must contain 1 to 8 images");
    }
    let aggregate = 0;
    images = record.images.map((value, index): ImageBlock => {
      const image = dataRecord(value, `Extension modelContext images[${index}]`);
      exact(image, ["type", "mediaType", "data", "url"], `Extension modelContext images[${index}]`);
      if (image.type !== "image" || typeof image.mediaType !== "string" || image.mediaType.trim() === "") {
        throw new Error(`Extension modelContext images[${index}] is invalid`);
      }
      if ((image.data === undefined) === (image.url === undefined)) {
        throw new Error(`Extension modelContext images[${index}] must contain exactly one of data or url`);
      }
      const mediaType = text(image.mediaType, `Extension modelContext images[${index}].mediaType`);
      const data = image.data === undefined ? undefined : text(image.data, `Extension modelContext images[${index}].data`);
      const url = image.url === undefined ? undefined : text(image.url, `Extension modelContext images[${index}].url`);
      aggregate += Buffer.byteLength(data ?? url ?? "", "utf8");
      if (aggregate > MAX_EXTENSION_ENTRY_PAYLOAD_BYTES) {
        throw new Error(`Extension modelContext images exceed ${MAX_EXTENSION_ENTRY_PAYLOAD_BYTES} bytes`);
      }
      return { type: "image", mediaType, ...(data === undefined ? {} : { data }), ...(url === undefined ? {} : { url }) };
    });
  }
  const selectedText = text(record.text, "Extension modelContext text");
  if (selectedText === "" && images === undefined) throw new Error("Extension modelContext must contain text or images");
  return Object.assign(Object.create(null), {
    role: record.role,
    text: selectedText,
    ...(images === undefined ? {} : { images }),
  }) as ExtensionMessageModelContext;
}

function transcript(value: unknown): ExtensionMessageTranscript {
  if (value === false) return false;
  const record = dataRecord(value, "Extension transcript");
  exact(record, ["text"], "Extension transcript");
  return Object.assign(Object.create(null), {
    text: text(record.text, "Extension transcript text"),
  }) as ExtensionMessageTranscript;
}

export function canonicalExtensionStateEvent(value: unknown): ExtensionStateEvent {
  const record = dataRecord(value, "Extension state event");
  exact(record, ["type", "extensionId", "schemaVersion", "key", "value"], "Extension state event");
  if (record.type !== "extension_state") throw new Error("Extension state event type is invalid");
  return Object.assign(Object.create(null), {
    type: "extension_state",
    extensionId: validateExtensionId(record.extensionId),
    schemaVersion: schemaVersion(record.schemaVersion),
    key: validateExtensionEntryKey(record.key, "Extension state key"),
    value: snapshotExtensionPayload(record.value),
  }) as ExtensionStateEvent;
}

export function canonicalExtensionMessageEvent(value: unknown): ExtensionMessageEvent {
  const record = dataRecord(value, "Extension message event");
  exact(
    record,
    ["type", "extensionId", "schemaVersion", "kind", "messageId", "payload", "modelContext", "transcript"],
    "Extension message event",
  );
  if (record.type !== "extension_message") throw new Error("Extension message event type is invalid");
  return Object.assign(Object.create(null), {
    type: "extension_message",
    extensionId: validateExtensionId(record.extensionId),
    schemaVersion: schemaVersion(record.schemaVersion),
    kind: validateExtensionEntryKey(record.kind, "Extension message kind"),
    messageId: messageId(record.messageId),
    payload: snapshotExtensionPayload(record.payload),
    modelContext: modelContext(record.modelContext),
    transcript: transcript(record.transcript),
  }) as ExtensionMessageEvent;
}

export function validExtensionStateEvent(value: unknown): value is ExtensionStateEvent {
  try {
    canonicalExtensionStateEvent(value);
    return true;
  } catch {
    return false;
  }
}

export function validExtensionMessageEvent(value: unknown): value is ExtensionMessageEvent {
  try {
    canonicalExtensionMessageEvent(value);
    return true;
  } catch {
    return false;
  }
}

export function extensionMessageContext(
  event: ExtensionMessageEvent,
  timestamp: string,
): CanonicalMessage | undefined {
  if (event.modelContext === false) return undefined;
  return {
    id: event.messageId,
    role: event.modelContext.role,
    content: [
      ...(event.modelContext.text === "" ? [] : [{ type: "text" as const, text: event.modelContext.text }]),
      ...(event.modelContext.images?.map((image) => ({ ...image })) ?? []),
    ],
    createdAt: timestamp,
  };
}
