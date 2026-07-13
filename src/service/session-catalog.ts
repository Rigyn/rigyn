import { createHash } from "node:crypto";

import type { ThreadMetadataCursor, ThreadMetadataRecord } from "../storage/types.js";

export const HARNESS_SESSION_CATALOG_SCHEMA_VERSION = 1 as const;

export const HARNESS_SESSION_CATALOG_LIMITS = Object.freeze({
  defaultEntries: 50,
  maxEntries: 100,
  maxSearchBytes: 1_024,
  maxCursorBytes: 4_096,
  maxIdentifierBytes: 200,
  maxNameBytes: 200,
  maxTimestampBytes: 128,
});

export interface HarnessSessionMetadata {
  threadId: string;
  name?: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

export interface HarnessSessionListRequest {
  search?: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface HarnessSessionPage {
  schemaVersion: typeof HARNESS_SESSION_CATALOG_SCHEMA_VERSION;
  sessions: HarnessSessionMetadata[];
  nextCursor?: string;
  hasMore: boolean;
}

function boundedString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (
    typeof value !== "string" || (!allowEmpty && value === "") || value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximum
  ) throw new Error(`${label} is invalid`);
  return value;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be plain data`);
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

function metadata(value: unknown): HarnessSessionMetadata {
  const record = plainRecord(value, "Session metadata");
  exact(record, ["threadId", "name", "defaultBranch", "createdAt", "updatedAt"], "Session metadata");
  return {
    threadId: boundedString(record.threadId, "Session threadId", HARNESS_SESSION_CATALOG_LIMITS.maxIdentifierBytes),
    ...(record.name === undefined
      ? {}
      : { name: boundedString(record.name, "Session name", HARNESS_SESSION_CATALOG_LIMITS.maxNameBytes, true) }),
    defaultBranch: boundedString(record.defaultBranch, "Session defaultBranch", HARNESS_SESSION_CATALOG_LIMITS.maxIdentifierBytes),
    createdAt: boundedString(record.createdAt, "Session createdAt", HARNESS_SESSION_CATALOG_LIMITS.maxTimestampBytes),
    updatedAt: boundedString(record.updatedAt, "Session updatedAt", HARNESS_SESSION_CATALOG_LIMITS.maxTimestampBytes),
  };
}

function metadataArray(value: unknown): HarnessSessionMetadata[] {
  if (!Array.isArray(value) || value.length > HARNESS_SESSION_CATALOG_LIMITS.maxEntries) {
    throw new Error("Session page sessions are invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const sessions: HarnessSessionMetadata[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new Error("Session page sessions must contain only enumerable data entries");
    }
    sessions.push(metadata(descriptor.value));
  }
  const unknown = Reflect.ownKeys(descriptors).filter((key) =>
    key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length));
  if (unknown.length > 0) throw new Error("Session page sessions contain unknown fields");
  return sessions;
}

export function parseHarnessSessionPage(value: unknown): HarnessSessionPage {
  const record = plainRecord(value, "Session page");
  exact(record, ["schemaVersion", "sessions", "nextCursor", "hasMore"], "Session page");
  if (record.schemaVersion !== HARNESS_SESSION_CATALOG_SCHEMA_VERSION) throw new Error("Session page schemaVersion is invalid");
  if (typeof record.hasMore !== "boolean") throw new Error("Session page hasMore is invalid");
  const sessions = metadataArray(record.sessions);
  const nextCursor = record.nextCursor === undefined
    ? undefined
    : boundedString(record.nextCursor, "Session page nextCursor", HARNESS_SESSION_CATALOG_LIMITS.maxCursorBytes);
  if (record.hasMore !== (nextCursor !== undefined)) throw new Error("Session page cursor conflicts with hasMore");
  return {
    schemaVersion: HARNESS_SESSION_CATALOG_SCHEMA_VERSION,
    sessions,
    hasMore: record.hasMore,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export function normalizeHarnessSessionListRequest(input: HarnessSessionListRequest = {}, scope: string): {
  search?: string;
  after?: ThreadMetadataCursor;
  limit: number;
  signal?: AbortSignal;
} {
  const search = input.search?.trim();
  if (search !== undefined) {
    boundedString(search, "Session search", HARNESS_SESSION_CATALOG_LIMITS.maxSearchBytes, true);
  }
  const limit = input.limit ?? HARNESS_SESSION_CATALOG_LIMITS.defaultEntries;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > HARNESS_SESSION_CATALOG_LIMITS.maxEntries) {
    throw new RangeError(`Session page limit must be from 1 through ${HARNESS_SESSION_CATALOG_LIMITS.maxEntries}`);
  }
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw new Error("Session page signal is invalid");
  const after = input.cursor === undefined ? undefined : decodeHarnessSessionCursor(input.cursor, scope, search);
  return {
    ...(search === undefined || search === "" ? {} : { search }),
    ...(after === undefined ? {} : { after }),
    limit,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

function harnessSessionCursorBinding(scope: string, search: string | undefined): string {
  const selectedScope = boundedString(scope, "Session cursor scope", 16 * 1_024);
  return createHash("sha256")
    .update(selectedScope, "utf8")
    .update("\0", "utf8")
    .update(search ?? "", "utf8")
    .digest("base64url");
}

export function encodeHarnessSessionCursor(
  cursor: ThreadMetadataCursor,
  scope: string,
  search?: string,
): string {
  const updatedAt = boundedString(cursor.updatedAt, "Session cursor updatedAt", HARNESS_SESSION_CATALOG_LIMITS.maxTimestampBytes);
  const threadId = boundedString(cursor.threadId, "Session cursor threadId", HARNESS_SESSION_CATALOG_LIMITS.maxIdentifierBytes);
  return Buffer.from(JSON.stringify([
    HARNESS_SESSION_CATALOG_SCHEMA_VERSION,
    harnessSessionCursorBinding(scope, search),
    updatedAt,
    threadId,
  ]), "utf8").toString("base64url");
}

export function decodeHarnessSessionCursor(value: string, scope: string, search?: string): ThreadMetadataCursor {
  const cursor = boundedString(value, "Session cursor", HARNESS_SESSION_CATALOG_LIMITS.maxCursorBytes);
  if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error("Session cursor is invalid");
  let parsed: unknown;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error("non-canonical cursor");
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Session cursor is invalid");
  }
  if (
    !Array.isArray(parsed) || parsed.length !== 4 ||
    parsed[0] !== HARNESS_SESSION_CATALOG_SCHEMA_VERSION ||
    parsed[1] !== harnessSessionCursorBinding(scope, search)
  ) {
    throw new Error("Session cursor is invalid");
  }
  return {
    updatedAt: boundedString(parsed[2], "Session cursor updatedAt", HARNESS_SESSION_CATALOG_LIMITS.maxTimestampBytes),
    threadId: boundedString(parsed[3], "Session cursor threadId", HARNESS_SESSION_CATALOG_LIMITS.maxIdentifierBytes),
  };
}

export function harnessSessionPage(
  threads: readonly ThreadMetadataRecord[],
  hasMore: boolean,
  next?: ThreadMetadataCursor,
  scope = "session-catalog",
  search?: string,
): HarnessSessionPage {
  return parseHarnessSessionPage({
    schemaVersion: HARNESS_SESSION_CATALOG_SCHEMA_VERSION,
    sessions: threads.map((thread) => ({
      threadId: thread.threadId,
      ...(thread.name === undefined ? {} : { name: thread.name }),
      defaultBranch: thread.defaultBranch,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    })),
    hasMore,
    ...(next === undefined ? {} : { nextCursor: encodeHarnessSessionCursor(next, scope, search) }),
  });
}
