import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, resolve } from "node:path";
import type { EventEnvelope, EventSink, RunState, RuntimeEvent } from "../core/events.js";
import {
  canonicalExtensionMessageEvent,
  canonicalExtensionStateEvent,
  validExtensionMessageEvent,
  validExtensionStateEvent,
  validateExtensionEntryKey,
  validateExtensionId,
  validateExtensionSchemaVersion,
} from "../core/extension-entries.js";
import type { ExtensionMessageEvent, ExtensionStateEvent } from "../core/extension-entries.js";
import { assertQueuedRunMessages, type QueuedRunMessage } from "../core/agent.js";
import { validateImageSource } from "../core/image-source.js";
import { HarnessError } from "../core/errors.js";
import { createId } from "../core/ids.js";
import type { ArtifactId, EventId, RunId, ThreadId } from "../core/ids.js";
import { isJsonValue, type JsonValue } from "../core/json.js";
import type { CanonicalMessage, ImageBlock, ProviderId, ToolResultBlock } from "../core/types.js";
import { isNormalizedUsage } from "../core/usage.js";
import { migrateDatabase } from "./migrations.js";
import { sessionExportEnvelope, sessionExportFormatRecord, type SessionExportRecord } from "./session-export.js";
import { assertCanonicalDirectoryCreationPathSync, windowsPathHazard } from "../config/canonical-path.js";
import type {
  AppendEventInput,
  ArtifactRecord,
  BranchRecord,
  EnqueueRunInput,
  EntryLabelRecord,
  RecoveryReport,
  RunInputQueueRecord,
  RunInputQueueState,
  RunInputRecoveryReport,
  RunRecord,
  StorageOptions,
  ThreadPreview,
  ThreadPreviewOptions,
  ThreadRecord,
} from "./types.js";

const TERMINAL_RUN_STATES = new Set<RunState>(["completed", "failed", "cancelled"]);
const DEFAULT_ARTIFACT_BYTES = 8 * 1024 * 1024;
const DEFAULT_ARTIFACT_STORE_BYTES = 256 * 1024 * 1024;
export const MAX_ENTRY_LABEL_BYTES = 256;
export const MAX_BRANCH_SUMMARY_SOURCE_EVENTS = 4_096;
export const MAX_BRANCH_SUMMARY_EVENT_BYTES = 128 * 1024;
export const MAX_EXTENSION_EVENT_METADATA_BYTES = 64 * 1024;
export const MAX_THREAD_PREVIEW_MESSAGE_COUNT = 10_000;
export const MAX_THREAD_PREVIEW_RECENT_MESSAGES = 128;
export const MAX_THREAD_PREVIEW_SEARCH_BYTES = 64 * 1024;

const DEFAULT_THREAD_PREVIEW_RECENT_MESSAGES = 64;
const MAX_THREAD_PREVIEW_SEARCH_PARTS = 512;
const MAX_THREAD_PREVIEW_SEARCH_PART_CHARACTERS = 4_096;
const MAX_THREAD_PREVIEW_FIRST_PROMPT_BYTES = 512;
const MAX_THREAD_PREVIEW_FIRST_PROMPT_PARTS = 256;
const ECMASCRIPT_WHITESPACE_SQL = [
  9, 10, 11, 12, 13, 32, 160, 5_760,
  8_192, 8_193, 8_194, 8_195, 8_196, 8_197, 8_198, 8_199, 8_200, 8_201, 8_202,
  8_232, 8_233, 8_239, 8_287, 12_288, 65_279,
].map((codePoint) => `char(${codePoint})`).join(" || ");
const STORE_NO_FOLLOW = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
const MINIMUM_SQLITE_VERSION = [3, 51, 3] as const;

interface DatabaseFileGuard {
  path: string;
  device: string;
  inode: string;
}

type SqlRow = Record<string, unknown>;

function requiredString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new HarnessError("STORAGE_CORRUPT", `Invalid ${key}`);
  return value;
}

function optionalString(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new HarnessError("STORAGE_CORRUPT", `Invalid ${key}`);
  return value;
}

function requiredNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new HarnessError("STORAGE_CORRUPT", `Invalid ${key}`);
  }
  return value;
}

function boundedThreadPreviewLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
  allowZero = false,
): number {
  const selected = value ?? fallback;
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return selected;
}

function databaseFileGuard(path: string): DatabaseFileGuard | undefined {
  if (path === ":memory:") return undefined;
  if (path.includes("\0") || path.startsWith("file:")) {
    throw new HarnessError("STORAGE_PATH", "Session database path must be a filesystem path without NUL");
  }
  const selected = resolve(path);
  const windowsHazard = windowsPathHazard(selected);
  if (windowsHazard !== undefined) {
    throw new HarnessError("STORAGE_PATH", `Session database path uses an unsupported Windows ${windowsHazard}`);
  }
  try {
    assertCanonicalDirectoryCreationPathSync(dirname(selected));
  } catch (error) {
    throw new HarnessError("STORAGE_PATH", `Session database parent is unsafe: ${dirname(selected)}`, { cause: error });
  }
  let created: number | undefined;
  try {
    created = openSync(
      selected,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | STORE_NO_FOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new HarnessError("STORAGE_PATH", `Could not securely create session database ${selected}`, { cause: error });
    }
  } finally {
    if (created !== undefined) closeSync(created);
  }
  const current = lstatSync(selected, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || realpathSync(selected) !== selected) {
    throw new HarnessError("STORAGE_PATH", "Session database must be a canonical regular non-symlink file");
  }
  if (current.nlink !== 1n) throw new HarnessError("STORAGE_PATH", "Session database must not have multiple hard links");
  if (
    process.platform !== "win32"
    && process.getuid !== undefined
    && Number(current.uid) !== process.getuid()
  ) {
    throw new HarnessError("STORAGE_PATH", "Session database is owned by another user");
  }
  if (process.platform !== "win32") {
    if ((current.mode & 0o022n) !== 0n) {
      throw new HarnessError("STORAGE_PATH", "Session database must not be group- or world-writable");
    }
    chmodSync(selected, 0o600);
  }
  const secured = lstatSync(selected, { bigint: true });
  if (
    !secured.isFile()
    || secured.isSymbolicLink()
    || secured.dev !== current.dev
    || secured.ino !== current.ino
    || realpathSync(selected) !== selected
  ) {
    throw new HarnessError("STORAGE_PATH", "Session database changed while it was being secured");
  }
  return { path: selected, device: String(secured.dev), inode: String(secured.ino) };
}

function assertDatabaseFileGuard(guard: DatabaseFileGuard): void {
  const current = lstatSync(guard.path, { bigint: true });
  if (
    !current.isFile()
    || current.isSymbolicLink()
    || String(current.dev) !== guard.device
    || String(current.ino) !== guard.inode
    || current.nlink !== 1n
    || realpathSync(guard.path) !== guard.path
  ) {
    throw new HarnessError("STORAGE_PATH", "Session database changed while it was opening");
  }
  if (
    process.platform !== "win32"
    && (
      (process.getuid !== undefined && Number(current.uid) !== process.getuid())
      || (current.mode & 0o077n) !== 0n
    )
  ) {
    throw new HarnessError("STORAGE_PATH", "Session database ownership or permissions changed while it was opening");
  }
}

function secureDatabaseSidecar(path: string): void {
  let opened;
  try {
    opened = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    !opened.isFile()
    || opened.isSymbolicLink()
    || opened.nlink !== 1n
    || realpathSync(path) !== path
  ) throw new HarnessError("STORAGE_PATH", `Session database sidecar is unsafe: ${path}`);
  if (process.platform !== "win32") {
    if (
      process.getuid !== undefined
      && Number(opened.uid) !== process.getuid()
    ) throw new HarnessError("STORAGE_PATH", `Session database sidecar is owned by another user: ${path}`);
    if ((opened.mode & 0o022n) !== 0n) {
      throw new HarnessError("STORAGE_PATH", `Session database sidecar must not be group- or world-writable: ${path}`);
    }
    chmodSync(path, 0o600);
  }
  const secured = lstatSync(path, { bigint: true });
  if (
    !secured.isFile()
    || secured.isSymbolicLink()
    || secured.dev !== opened.dev
    || secured.ino !== opened.ino
    || secured.nlink !== 1n
    || realpathSync(path) !== path
  ) throw new HarnessError("STORAGE_PATH", `Session database sidecar changed while it was being secured: ${path}`);
}

function assertDatabaseIntegrity(database: DatabaseSync): void {
  try {
    const quick = database.prepare("PRAGMA integrity_check(1)").get() as SqlRow | undefined;
    const foreign = database.prepare("PRAGMA foreign_key_check").get();
    if (quick !== undefined && Object.values(quick)[0] === "ok" && foreign === undefined) return;
  } catch (cause) {
    throw new HarnessError(
      "STORAGE_CORRUPT",
      "SQLite integrity check failed; stop all Rigyn processes, run `rigyn sessions doctor`, then use explicit index repair or restore a verified backup",
      { cause },
    );
  }
  throw new HarnessError(
    "STORAGE_CORRUPT",
    "SQLite integrity check failed; stop all Rigyn processes, run `rigyn sessions doctor`, then use explicit index repair or restore a verified backup",
  );
}

function assertSupportedSQLite(database: DatabaseSync): void {
  const row = database.prepare("SELECT sqlite_version() AS version").get() as SqlRow | undefined;
  const version = row?.["version"];
  const parts = typeof version === "string" ? version.split(".").map(Number) : [];
  let supported = true;
  for (let index = 0; index < MINIMUM_SQLITE_VERSION.length; index += 1) {
    const minimum = MINIMUM_SQLITE_VERSION[index];
    if (minimum === undefined) break;
    if ((parts[index] ?? 0) > minimum) break;
    if ((parts[index] ?? 0) < minimum) {
      supported = false;
      break;
    }
  }
  if (!supported || parts.length < 3 || parts.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    throw new HarnessError(
      "STORAGE_RUNTIME",
      `SQLite 3.51.3 or newer is required for safe WAL sessions; this Node.js runtime provides ${typeof version === "string" ? version : "an unknown version"}`,
    );
  }
}

function openSessionDatabase(path: string, busyTimeoutMs: number): DatabaseSync {
  const guard = databaseFileGuard(path);
  const selected = guard?.path ?? path;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(selected, {
      enableForeignKeyConstraints: true,
      timeout: busyTimeoutMs,
    });
    assertSupportedSQLite(database);
    if (guard !== undefined && database.location() !== selected) {
      throw new HarnessError("STORAGE_PATH", "SQLite opened an unexpected session database path");
    }
    if (guard !== undefined) assertDatabaseFileGuard(guard);
    assertDatabaseIntegrity(database);
    migrateDatabase(database, busyTimeoutMs);
    if (guard !== undefined) {
      assertDatabaseFileGuard(guard);
      secureDatabaseSidecar(`${selected}-wal`);
      secureDatabaseSidecar(`${selected}-shm`);
    }
    return database;
  } catch (error) {
    database?.close();
    throw error;
  }
}

function utf8Prefix(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return { text: value, truncated: false };
  let end = maximumBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

function appendPreviewText(
  current: string,
  value: string,
  maximumBytes: number,
): { text: string; truncated: boolean } {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized === "") return { text: current, truncated: false };
  const separator = current === "" ? "" : " ";
  const available = maximumBytes - Buffer.byteLength(current, "utf8") - Buffer.byteLength(separator, "utf8");
  if (available <= 0) return { text: current, truncated: true };
  const prefix = utf8Prefix(normalized, available);
  return {
    text: `${current}${separator}${prefix.text}`,
    truncated: prefix.truncated,
  };
}

function validRunState(value: string): value is RunState {
  return [
    "preparing",
    "streaming",
    "tool_planning",
    "executing",
    "completed",
    "failed",
    "cancelled",
  ].includes(value);
}

function validRunInputQueueState(value: string): value is RunInputQueueState {
  return ["queued", "draining", "recoverable", "leased", "quarantined"].includes(value);
}

function decodeQueuedImages(value: unknown): ImageBlock[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new HarnessError("STORAGE_CORRUPT", "Invalid queued images payload");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new HarnessError("STORAGE_CORRUPT", "Queued images payload is invalid JSON", { cause });
  }
  if (!Array.isArray(parsed)) throw new HarnessError("STORAGE_CORRUPT", "Queued images payload is not an array");
  const images: ImageBlock[] = [];
  for (const value of parsed) {
    if (!isRecord(value) || value["type"] !== "image" || typeof value["mediaType"] !== "string" || value["mediaType"] === "") {
      throw new HarnessError("STORAGE_CORRUPT", "Queued image has an invalid shape");
    }
    const keys = Object.keys(value);
    if (keys.some((key) => !["type", "mediaType", "data", "url"].includes(key))) {
      throw new HarnessError("STORAGE_CORRUPT", "Queued image contains unknown fields");
    }
    const hasData = Object.hasOwn(value, "data");
    const hasUrl = Object.hasOwn(value, "url");
    if (hasData === hasUrl) throw new HarnessError("STORAGE_CORRUPT", "Queued image must have exactly one source");
    if (hasData && typeof value["data"] !== "string") throw new HarnessError("STORAGE_CORRUPT", "Queued image data is invalid");
    if (hasUrl && typeof value["url"] !== "string") throw new HarnessError("STORAGE_CORRUPT", "Queued image URL is invalid");
    const image: ImageBlock = {
      type: "image",
      mediaType: value["mediaType"],
      ...(hasData ? { data: value["data"] as string } : { url: value["url"] as string }),
    };
    validateImageSource(image);
    images.push(image);
  }
  return images;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "string";
}

function hasInteger(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "number" && Number.isSafeInteger(record[key]);
}

function hasBoolean(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "boolean";
}

function validStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validExtensionMetadata(value: unknown): boolean {
  return value === undefined || (
    isJsonValue(value) &&
    Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_EXTENSION_EVENT_METADATA_BYTES
  );
}

function validEntryLabel(value: unknown): boolean {
  return typeof value === "string"
    && value.trim() !== ""
    && Buffer.byteLength(value, "utf8") <= MAX_ENTRY_LABEL_BYTES
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function validBranchName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value) && !value.includes("..");
}

function validBranchSummarySourceIds(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BRANCH_SUMMARY_SOURCE_EVENTS) return false;
  if (value.some((entry) => typeof entry !== "string" || entry === "")) return false;
  if (new Set(value).size !== value.length) return false;
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_BRANCH_SUMMARY_EVENT_BYTES;
}

function validContentBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value["type"]) {
    case "text":
      return hasString(value, "text");
    case "image":
      return hasString(value, "mediaType") &&
        (value["data"] === undefined || hasString(value, "data")) &&
        (value["url"] === undefined || hasString(value, "url"));
    case "tool_call":
      return (
        hasString(value, "callId") &&
        hasString(value, "name") &&
        isJsonValue(value["arguments"]) &&
        (value["rawArguments"] === undefined || hasString(value, "rawArguments"))
      );
    case "tool_result":
      return (
        hasString(value, "callId") &&
        hasString(value, "name") &&
        hasString(value, "content") &&
        hasBoolean(value, "isError") &&
        (value["status"] === undefined || ["success", "warning", "error"].includes(String(value["status"]))) &&
        (value["summary"] === undefined || hasString(value, "summary")) &&
        (value["nextActions"] === undefined || validStringArray(value["nextActions"])) &&
        (value["images"] === undefined || (
          Array.isArray(value["images"]) &&
          value["images"].every((entry) => isRecord(entry) && entry["type"] === "image" && validContentBlock(entry))
        )) &&
        (value["artifactIds"] === undefined || validStringArray(value["artifactIds"])) &&
        (value["metadata"] === undefined || isJsonValue(value["metadata"]))
      );
    case "provider_opaque":
      return hasString(value, "provider") && hasString(value, "mediaType") && isJsonValue(value["value"]) &&
        (value["serialized"] === undefined || hasString(value, "serialized"));
    default:
      return false;
  }
}

function validCanonicalMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    ["system", "user", "assistant", "tool"].includes(String(value["role"])) &&
    Array.isArray(value["content"]) &&
    value["content"].every(validContentBlock) &&
    (value["displayText"] === undefined || hasString(value, "displayText")) &&
    hasString(value, "createdAt") &&
    (value["provider"] === undefined || hasString(value, "provider")) &&
    (value["purpose"] === undefined || value["purpose"] === "instructions" || value["purpose"] === "compaction")
  );
}

function validProviderState(value: unknown): boolean {
  if (!isRecord(value) || !hasString(value, "kind")) return false;
  switch (value["kind"]) {
    case "openai_responses":
      return Array.isArray(value["outputItems"]) && value["outputItems"].every(isJsonValue) &&
        (value["previousResponseId"] === undefined || hasString(value, "previousResponseId"));
    case "anthropic_messages":
      return Array.isArray(value["assistantBlocks"]) && value["assistantBlocks"].every(isJsonValue);
    case "gemini_interactions":
      return Array.isArray(value["steps"]) && value["steps"].every(isJsonValue) &&
        (value["previousInteractionId"] === undefined || hasString(value, "previousInteractionId"));
    case "mistral_conversations":
      return Array.isArray(value["outputs"]) && value["outputs"].every(isJsonValue) &&
        hasString(value, "model") &&
        hasString(value, "requestFingerprint") &&
        (value["conversationId"] === undefined || hasString(value, "conversationId"));
    case "gemini_generate_content":
      return Array.isArray(value["parts"]) && value["parts"].every(isJsonValue);
    case "bedrock_converse":
    case "chat_completions":
    case "openrouter_chat":
    case "ollama_chat":
      return isJsonValue(value["assistantMessage"]);
    default:
      return false;
  }
}

function validSerializedState(event: Record<string, unknown>): boolean {
  const serialized = event["providerStateSerialized"];
  if (serialized === undefined) return true;
  if (typeof serialized !== "string" || event["providerState"] === undefined) return false;
  try {
    return JSON.stringify(JSON.parse(serialized)) === JSON.stringify(event["providerState"]);
  } catch {
    return false;
  }
}

function validToolProgress(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value["type"] === "result") {
    return hasString(value, "content") && Buffer.byteLength(value["content"] as string, "utf8") <= 256 * 1024 &&
      hasBoolean(value, "isError") &&
      (value["metadata"] === undefined || isJsonValue(value["metadata"])) &&
      (value["truncated"] === undefined || hasBoolean(value, "truncated"));
  }
  return value["type"] === "output" &&
    (value["stream"] === "stdout" || value["stream"] === "stderr") &&
    hasString(value, "delta") && Buffer.byteLength(value["delta"] as string, "utf8") <= 256 * 1024 &&
    hasInteger(value, "stdoutBytes") && (value["stdoutBytes"] as number) >= 0 &&
    hasInteger(value, "stderrBytes") && (value["stderrBytes"] as number) >= 0 &&
    (value["elapsedMs"] === undefined || (hasInteger(value, "elapsedMs") && (value["elapsedMs"] as number) >= 0)) &&
    (value["truncated"] === undefined || hasBoolean(value, "truncated"));
}

function exactObjectKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const selected = new Set(allowed);
  return Object.keys(value).every((key) => selected.has(key));
}

function validPromptComposition(value: unknown): boolean {
  if (!isRecord(value) || !exactObjectKeys(value, ["bytes", "sha256", "sources", "tools", "skills", "truncated"])) return false;
  if (!hasInteger(value, "bytes") || (value["bytes"] as number) < 0) return false;
  if (typeof value["sha256"] !== "string" || !/^[a-f0-9]{64}$/u.test(value["sha256"] as string)) return false;
  if (!hasBoolean(value, "truncated")) return false;
  if (!Array.isArray(value["sources"]) || value["sources"].length > 128) return false;
  for (const source of value["sources"]) {
    if (!isRecord(source) || !exactObjectKeys(source, ["kind", "source", "bytes", "sha256", "truncated"])) return false;
    if (![
      "instruction", "system_prompt", "append_system_prompt", "additional_instructions",
    ].includes(String(source["kind"]))) return false;
    if (
      typeof source["source"] !== "string" || source["source"] === "" || source["source"].includes("\0") ||
      Buffer.byteLength(source["source"], "utf8") > 4_096
    ) return false;
    if (!hasInteger(source, "bytes") || (source["bytes"] as number) < 0 || (source["bytes"] as number) > 1024 * 1024) return false;
    if (typeof source["sha256"] !== "string" || !/^[a-f0-9]{64}$/u.test(source["sha256"] as string)) return false;
    if (source["truncated"] !== undefined && !hasBoolean(source, "truncated")) return false;
  }
  if (
    !Array.isArray(value["tools"]) || value["tools"].length > 128 ||
    value["tools"].some((tool) => typeof tool !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(tool))
  ) return false;
  if (!Array.isArray(value["skills"]) || value["skills"].length > 256) return false;
  for (const skill of value["skills"]) {
    if (!isRecord(skill) || !exactObjectKeys(skill, ["name", "manifestPath"])) return false;
    if (typeof skill["name"] !== "string" || Buffer.byteLength(skill["name"], "utf8") > 256) return false;
    if (
      typeof skill["manifestPath"] !== "string" || skill["manifestPath"].includes("\0") ||
      Buffer.byteLength(skill["manifestPath"], "utf8") > 4_096
    ) return false;
  }
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= 256 * 1024;
}

function validEventShape(event: Record<string, unknown>): boolean {
  switch (event["type"]) {
    case "run_started":
      return hasString(event, "provider") && hasString(event, "model") &&
        (event["reasoningEffort"] === undefined || hasString(event, "reasoningEffort")) &&
        (event["promptComposition"] === undefined || validPromptComposition(event["promptComposition"]));
    case "model_selected":
      return hasString(event, "provider") && hasString(event, "model") &&
        (event["reasoningEffort"] === undefined || hasString(event, "reasoningEffort"));
    case "run_state":
      return hasString(event, "state") && validRunState(event["state"] as string);
    case "message_appended":
      return validCanonicalMessage(event["message"]) &&
        (event["providerState"] === undefined || validProviderState(event["providerState"])) &&
        (event["toolDefinitionFingerprint"] === undefined || (
          event["providerState"] !== undefined &&
          typeof event["toolDefinitionFingerprint"] === "string" &&
          /^[a-f0-9]{64}$/u.test(event["toolDefinitionFingerprint"])
        )) &&
        validSerializedState(event);
    case "assistant_started":
      return hasInteger(event, "step");
    case "provider_response_started":
      return hasInteger(event, "step") &&
        hasString(event, "model") &&
        (event["responseId"] === undefined || hasString(event, "responseId")) &&
        (event["requestId"] === undefined || hasString(event, "requestId"));
    case "text_delta":
      return hasString(event, "text") && hasInteger(event, "part");
    case "reasoning_delta":
      return (
        hasString(event, "text") &&
        hasInteger(event, "part") &&
        (event["visibility"] === "summary" || event["visibility"] === "provider_trace")
      );
    case "assistant_completed":
      return hasString(event, "finishReason") &&
        (event["rawReason"] === undefined || hasString(event, "rawReason"));
    case "tool_requested":
      return (
        hasString(event, "callId") &&
        hasString(event, "name") &&
        hasInteger(event, "index") &&
        isJsonValue(event["input"])
      );
    case "tool_started":
      return hasString(event, "callId") && hasString(event, "name") && hasInteger(event, "index");
    case "tool_progress":
      return hasString(event, "callId") &&
        hasString(event, "name") &&
        hasInteger(event, "index") && (event["index"] as number) >= 0 &&
        hasInteger(event, "sequence") && (event["sequence"] as number) >= 0 &&
        validToolProgress(event["progress"]);
    case "tool_completed":
      return (
        hasString(event, "callId") &&
        hasString(event, "name") &&
        hasInteger(event, "index") &&
        hasBoolean(event, "isError") &&
        hasString(event, "preview") &&
        (event["result"] === undefined || (
          validContentBlock(event["result"]) &&
          isRecord(event["result"]) &&
          event["result"]["type"] === "tool_result" &&
          event["result"]["callId"] === event["callId"] &&
          event["result"]["name"] === event["name"] &&
          event["result"]["isError"] === event["isError"]
        ))
      );
    case "tool_in_doubt":
      return (
        hasString(event, "callId") &&
        hasString(event, "name") &&
        hasInteger(event, "index") &&
        hasString(event, "reason")
      );
    case "usage":
      return isNormalizedUsage(event["usage"]) && ["incremental", "cumulative", "final"].includes(String(event["semantics"]));
    case "retry_scheduled":
      return hasInteger(event, "attempt") && hasInteger(event, "delayMs") && hasString(event, "category");
    case "compaction_started":
    case "steering_queued":
      return true;
    case "compaction_completed":
      return validCanonicalMessage(event["summary"]) &&
        validStringArray(event["sourceMessageIds"]) &&
        validExtensionMetadata(event["extensionMetadata"]);
    case "branch_summary_created":
      return validCanonicalMessage(event["summary"])
        && isRecord(event["summary"])
        && event["summary"]["role"] === "user"
        && event["summary"]["purpose"] === "compaction"
        && Buffer.byteLength(JSON.stringify(event["summary"]), "utf8") <= MAX_BRANCH_SUMMARY_EVENT_BYTES
        && validBranchName(event["sourceBranch"])
        && validBranchSummarySourceIds(event["sourceEventIds"])
        && validExtensionMetadata(event["extensionMetadata"]);
    case "entry_label_changed":
      return hasString(event, "targetEventId")
        && (event["label"] === undefined || validEntryLabel(event["label"]));
    case "extension_state":
      return validExtensionStateEvent(event);
    case "extension_message":
      return validExtensionMessageEvent(event);
    case "run_completed":
      return hasString(event, "finishReason");
    case "run_failed":
      return isRecord(event["error"]) && hasString(event["error"], "category") && hasString(event["error"], "message");
    case "run_cancelled":
      return hasString(event, "reason");
    case "warning":
      return hasString(event, "code") && hasString(event, "message") &&
        (event["details"] === undefined || isJsonValue(event["details"]));
    default:
      return false;
  }
}

function validateBranchName(name: string): string {
  if (!validBranchName(name)) {
    throw new HarnessError("STORAGE_BRANCH", `Invalid branch name: ${name}`);
  }
  return name;
}

function validateWorkspaceRoot(value: string): string {
  if (!isAbsolute(value) || value.length > 4096 || value.includes("\0")) {
    throw new HarnessError("STORAGE_WORKSPACE", "Workspace root must be a valid absolute path");
  }
  return value;
}

function normalizeThreadName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new HarnessError("STORAGE_NAME", "Thread name must not contain control characters");
  }
  if (normalized.length === 0 || normalized.length > 200) {
    throw new HarnessError("STORAGE_NAME", "Thread name must contain 1 to 200 characters");
  }
  return normalized;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function decodeRuntimeEvent(payload: unknown, expectedKind: string): RuntimeEvent {
  if (typeof payload !== "string") {
    throw new HarnessError("STORAGE_CORRUPT", "Event payload is not text");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (cause) {
    throw new HarnessError("STORAGE_CORRUPT", "Event payload is invalid JSON", { cause });
  }
  if (!isRecord(parsed)) {
    throw new HarnessError("STORAGE_CORRUPT", "Event payload is not an object");
  }
  const type = parsed["type"];
  if (typeof type !== "string" || type !== expectedKind) {
    throw new HarnessError("STORAGE_CORRUPT", `Event kind mismatch: ${expectedKind}`);
  }
  if (type === "extension_state") {
    try {
      return structuredClone(canonicalExtensionStateEvent(parsed));
    } catch (cause) {
      throw new HarnessError("STORAGE_CORRUPT", "Extension state event is invalid", { cause });
    }
  }
  if (type === "extension_message") {
    try {
      return structuredClone(canonicalExtensionMessageEvent(parsed));
    } catch (cause) {
      throw new HarnessError("STORAGE_CORRUPT", "Extension message event is invalid", { cause });
    }
  }
  if (!isJsonValue(parsed)) {
    throw new HarnessError("STORAGE_CORRUPT", "Event payload is not JSON-safe");
  }
  if (!validEventShape(parsed)) {
    throw new HarnessError("STORAGE_CORRUPT", `Event payload has invalid shape: ${expectedKind}`);
  }
  return parsed as RuntimeEvent;
}

export class SessionStore {
  readonly database: DatabaseSync;
  readonly maxArtifactBytes: number;
  readonly maxArtifactStoreBytes: number;
  readonly clock: () => Date;
  readonly idFactory: (prefix: string) => string;

  constructor(path: string, options: StorageOptions = {}) {
    const maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_ARTIFACT_BYTES;
    const maxArtifactStoreBytes = options.maxArtifactStoreBytes ?? DEFAULT_ARTIFACT_STORE_BYTES;
    if (
      !Number.isSafeInteger(maxArtifactBytes) ||
      !Number.isSafeInteger(maxArtifactStoreBytes) ||
      maxArtifactBytes < 0 ||
      maxArtifactStoreBytes < maxArtifactBytes
    ) {
      throw new RangeError("Invalid artifact limits");
    }
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new RangeError("busyTimeoutMs must be a non-negative safe integer");
    }
    const database = openSessionDatabase(path, busyTimeoutMs);
    this.database = database;
    this.maxArtifactBytes = maxArtifactBytes;
    this.maxArtifactStoreBytes = maxArtifactStoreBytes;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? createId;
  }

  close(): void {
    this.database.close();
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private readTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  createThread(input: {
    threadId?: ThreadId;
    name?: string;
    defaultBranch?: string;
    parentThreadId?: ThreadId;
    parentRunId?: RunId;
    workspaceRoot?: string;
  } = {}): ThreadRecord {
    const threadId = input.threadId ?? this.idFactory("thread");
    const branch = validateBranchName(input.defaultBranch ?? "main");
    const timestamp = this.now();
    const name = normalizeThreadName(input.name);
    const workspaceRoot = input.workspaceRoot === undefined ? undefined : validateWorkspaceRoot(input.workspaceRoot);
    this.transaction(() => {
      this.database
        .prepare(
          "INSERT INTO threads(thread_id, name, default_branch, created_at, updated_at, parent_thread_id, parent_run_id, workspace_root) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(threadId, name ?? null, branch, timestamp, timestamp, input.parentThreadId ?? null, input.parentRunId ?? null, workspaceRoot ?? null);
      this.database
        .prepare(
          "INSERT INTO branches(thread_id, branch_name, head_event_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)",
        )
        .run(threadId, branch, timestamp, timestamp);
    });
    return this.getThread(threadId);
  }

  getThread(threadId: ThreadId): ThreadRecord {
    const row = this.database
      .prepare(
        "SELECT thread_id, name, default_branch, created_at, updated_at, parent_thread_id, parent_run_id, workspace_root FROM threads WHERE thread_id = ?",
      )
      .get(threadId) as SqlRow | undefined;
    if (row === undefined) throw new HarnessError("STORAGE_NOT_FOUND", `Unknown thread ${threadId}`);
    const result: ThreadRecord = {
      threadId: requiredString(row, "thread_id"),
      defaultBranch: requiredString(row, "default_branch"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
      branches: this.listBranches(threadId),
    };
    const name = optionalString(row, "name");
    const parentThreadId = optionalString(row, "parent_thread_id");
    const parentRunId = optionalString(row, "parent_run_id");
    const workspaceRoot = optionalString(row, "workspace_root");
    if (name !== undefined) result.name = name;
    if (parentThreadId !== undefined) result.parentThreadId = parentThreadId;
    if (parentRunId !== undefined) result.parentRunId = parentRunId;
    if (workspaceRoot !== undefined) result.workspaceRoot = workspaceRoot;
    return result;
  }

  listThreads(options: { workspaceRoot?: string; search?: string; limit?: number } = {}): ThreadRecord[] {
    const workspaceRoot = options.workspaceRoot === undefined ? undefined : validateWorkspaceRoot(options.workspaceRoot);
    const search = options.search?.trim();
    const limit = options.limit ?? 1_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError("Thread list limit must be between 1 and 10000");
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (workspaceRoot !== undefined) {
      clauses.push("thread.workspace_root = ?");
      parameters.push(workspaceRoot);
    }
    if (search !== undefined && search !== "") {
      const pattern = `%${escapeLike(search)}%`;
      clauses.push("(thread.thread_id LIKE ? ESCAPE '\\' OR thread.name LIKE ? ESCAPE '\\' OR event.payload_json LIKE ? ESCAPE '\\')");
      parameters.push(pattern, pattern, pattern);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const searchesEvents = search !== undefined && search !== "";
    const rows = this.database.prepare(`
      SELECT ${searchesEvents ? "DISTINCT " : ""}thread.thread_id, thread.updated_at
      FROM threads thread
      ${searchesEvents ? "LEFT JOIN events event ON event.thread_id = thread.thread_id" : ""}
      ${where}
      ORDER BY thread.updated_at DESC, thread.thread_id ASC
      LIMIT ?
    `).all(...parameters, limit) as SqlRow[];
    return rows.map((row) => this.getThread(requiredString(row, "thread_id")));
  }

  listDurableWorkspaceRoots(limit = 1_024): string[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError("Workspace root list limit must be between 1 and 10000");
    }
    const rows = this.database.prepare(`
      SELECT DISTINCT thread.workspace_root
      FROM threads thread
      WHERE thread.workspace_root IS NOT NULL
        AND EXISTS (SELECT 1 FROM events event WHERE event.thread_id = thread.thread_id)
      ORDER BY thread.workspace_root ASC
      LIMIT ?
    `).all(limit + 1) as SqlRow[];
    if (rows.length > limit) {
      throw new HarnessError("STORAGE_WORKSPACE_LIMIT", `Session database exceeds ${limit} durable workspaces`);
    }
    return rows.map((row) => validateWorkspaceRoot(requiredString(row, "workspace_root")));
  }

  listThreadMetadataPage(input: {
    workspaceRoot: string;
    search?: string;
    limit: number;
    after?: { updatedAt: string; threadId: ThreadId };
    durableOnly?: boolean;
    searchEvents?: boolean;
  }): import("./types.js").ThreadMetadataPage {
    const workspaceRoot = validateWorkspaceRoot(input.workspaceRoot);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RangeError("Thread metadata page limit must be between 1 and 100");
    }
    const search = input.search?.trim();
    if (search !== undefined && (search.includes("\0") || Buffer.byteLength(search, "utf8") > 1_024)) {
      throw new RangeError("Thread metadata search must be at most 1024 bytes without NUL");
    }
    if (input.after !== undefined) {
      if (
        input.after.updatedAt === "" || input.after.updatedAt.includes("\0") ||
        Buffer.byteLength(input.after.updatedAt, "utf8") > 128
      ) throw new Error("Thread metadata cursor timestamp is invalid");
      if (
        input.after.threadId === "" || input.after.threadId.includes("\0") ||
        Buffer.byteLength(input.after.threadId, "utf8") > 200
      ) throw new Error("Thread metadata cursor threadId is invalid");
    }
    const searchEvents = input.searchEvents === true && search !== undefined && search !== "";
    const clauses = ["thread.workspace_root = ?"];
    const parameters: Array<string | number> = [workspaceRoot];
    if (input.durableOnly === true) {
      clauses.push("EXISTS (SELECT 1 FROM events durable_event WHERE durable_event.thread_id = thread.thread_id)");
    }
    if (search !== undefined && search !== "") {
      const pattern = `%${escapeLike(search)}%`;
      clauses.push(`(thread.thread_id LIKE ? ESCAPE '\\' OR thread.name LIKE ? ESCAPE '\\'${
        searchEvents ? " OR event.payload_json LIKE ? ESCAPE '\\'" : ""
      })`);
      parameters.push(pattern, pattern, ...(searchEvents ? [pattern] : []));
    }
    if (input.after !== undefined) {
      clauses.push("(thread.updated_at < ? OR (thread.updated_at = ? AND thread.thread_id > ?))");
      parameters.push(input.after.updatedAt, input.after.updatedAt, input.after.threadId);
    }
    const rows = this.database.prepare(`
      SELECT ${searchEvents ? "DISTINCT " : ""}thread.thread_id, thread.name, thread.default_branch,
             thread.created_at, thread.updated_at
      FROM threads thread
      ${searchEvents ? "LEFT JOIN events event ON event.thread_id = thread.thread_id" : ""}
      WHERE ${clauses.join(" AND ")}
      ORDER BY thread.updated_at DESC, thread.thread_id ASC
      LIMIT ?
    `).all(...parameters, input.limit + 1) as SqlRow[];
    const hasMore = rows.length > input.limit;
    const selected = rows.slice(0, input.limit);
    const threads = selected.map((row) => {
      const name = optionalString(row, "name");
      return {
        threadId: requiredString(row, "thread_id"),
        ...(name === undefined ? {} : { name }),
        defaultBranch: requiredString(row, "default_branch"),
        createdAt: requiredString(row, "created_at"),
        updatedAt: requiredString(row, "updated_at"),
      };
    });
    const last = threads.at(-1);
    return {
      threads,
      hasMore,
      ...(hasMore && last !== undefined ? { next: { updatedAt: last.updatedAt, threadId: last.threadId } } : {}),
    };
  }

  getThreadPreview(threadId: ThreadId, options: ThreadPreviewOptions = {}): ThreadPreview {
    const messageCountLimit = boundedThreadPreviewLimit(
      options.messageCountLimit,
      MAX_THREAD_PREVIEW_MESSAGE_COUNT,
      MAX_THREAD_PREVIEW_MESSAGE_COUNT,
      "Thread preview messageCountLimit",
    );
    const recentMessageLimit = boundedThreadPreviewLimit(
      options.recentMessageLimit,
      DEFAULT_THREAD_PREVIEW_RECENT_MESSAGES,
      MAX_THREAD_PREVIEW_RECENT_MESSAGES,
      "Thread preview recentMessageLimit",
    );
    const searchByteLimit = boundedThreadPreviewLimit(
      options.searchByteLimit,
      MAX_THREAD_PREVIEW_SEARCH_BYTES,
      MAX_THREAD_PREVIEW_SEARCH_BYTES,
      "Thread preview searchByteLimit",
      true,
    );

    return this.readTransaction(() => {
      const thread = this.database
        .prepare("SELECT default_branch FROM threads WHERE thread_id = ?")
        .get(threadId) as SqlRow | undefined;
      if (thread === undefined) throw new HarnessError("STORAGE_NOT_FOUND", `Unknown thread ${threadId}`);
      const branch = validateBranchName(options.branch ?? requiredString(thread, "default_branch"));
      const branchRecord = this.branchRow(threadId, branch);
      const headEventId = optionalString(branchRecord, "head_event_id");
      const latestRun = this.database.prepare(`
        SELECT provider, model
        FROM runs
        WHERE thread_id = ?
        ORDER BY started_at DESC, run_id DESC
        LIMIT 1
      `).get(threadId) as SqlRow | undefined;
      const preview: ThreadPreview = {
        branch,
        hasUserMessage: false,
        recentSearchText: "",
        searchTruncated: false,
        messageCount: 0,
        messageCountTruncated: false,
      };
      if (latestRun !== undefined) {
        const provider = optionalString(latestRun, "provider");
        const model = optionalString(latestRun, "model");
        if (provider !== undefined) preview.latestProvider = provider;
        if (model !== undefined) preview.latestModel = model;
      }
      if (headEventId === undefined) return preview;

      const statistics = this.database.prepare(`
        WITH RECURSIVE chain(event_id, parent_event_id, sequence, kind, payload_json) AS (
          SELECT event_id, parent_event_id, sequence, kind, payload_json
          FROM events
          WHERE thread_id = ? AND event_id = ?
          UNION ALL
          SELECT event.event_id, event.parent_event_id, event.sequence, event.kind, event.payload_json
          FROM events event
          JOIN chain ON event.thread_id = ? AND event.event_id = chain.parent_event_id
        )
        SELECT
          (
            SELECT COUNT(*) FROM (
              SELECT 1 FROM chain WHERE kind = 'message_appended' LIMIT ?
            )
          ) AS bounded_message_count,
          (
            SELECT COUNT(*) FROM (
              SELECT 1 FROM chain WHERE kind = 'message_appended' LIMIT ?
            )
          ) AS bounded_recent_count,
          EXISTS(
            SELECT 1
            FROM chain
            WHERE kind = 'message_appended'
              AND json_extract(payload_json, '$.message.role') = 'user'
            LIMIT 1
          ) AS has_user_message
      `).get(
        threadId,
        headEventId,
        threadId,
        messageCountLimit + 1,
        recentMessageLimit + 1,
      ) as SqlRow | undefined;
      if (statistics === undefined) throw new HarnessError("STORAGE_CORRUPT", "Thread preview statistics are missing");
      const boundedMessageCount = requiredNumber(statistics, "bounded_message_count");
      const boundedRecentCount = requiredNumber(statistics, "bounded_recent_count");
      const hasUserMessage = requiredNumber(statistics, "has_user_message");
      if (hasUserMessage !== 0 && hasUserMessage !== 1) {
        throw new HarnessError("STORAGE_CORRUPT", "Thread preview user-message flag is invalid");
      }
      preview.hasUserMessage = hasUserMessage === 1;
      preview.messageCount = Math.min(boundedMessageCount, messageCountLimit);
      preview.messageCountTruncated = boundedMessageCount > messageCountLimit;

      if (preview.hasUserMessage) {
        const promptRows = this.database.prepare(`
          WITH RECURSIVE chain(event_id, parent_event_id, sequence, kind, payload_json) AS (
            SELECT event_id, parent_event_id, sequence, kind, payload_json
            FROM events
            WHERE thread_id = ? AND event_id = ?
            UNION ALL
            SELECT event.event_id, event.parent_event_id, event.sequence, event.kind, event.payload_json
            FROM events event
            JOIN chain ON event.thread_id = ? AND event.event_id = chain.parent_event_id
          ),
          user_messages(sequence, payload_json) AS (
            SELECT sequence, payload_json
            FROM chain
            WHERE kind = 'message_appended'
              AND json_extract(payload_json, '$.message.role') = 'user'
          ),
          prompt_parts(sequence, part_index, text) AS (
            SELECT sequence, -1, json_extract(payload_json, '$.message.displayText')
            FROM user_messages
            WHERE json_type(payload_json, '$.message.displayText') = 'text'
            UNION ALL
            SELECT user_messages.sequence, CAST(block.key AS INTEGER), json_extract(block.value, '$.text')
            FROM user_messages
            JOIN json_each(user_messages.payload_json, '$.message.content') block
            WHERE (
                json_type(user_messages.payload_json, '$.message.displayText') IS NULL
                OR json_type(user_messages.payload_json, '$.message.displayText') = 'null'
              )
              AND json_extract(block.value, '$.type') = 'text'
              AND json_type(block.value, '$.text') = 'text'
          ),
          usable_parts(sequence, part_index, text) AS (
            SELECT sequence, part_index, text
            FROM prompt_parts
            WHERE typeof(text) = 'text'
              AND length(CAST(trim(text, ${ECMASCRIPT_WHITESPACE_SQL}) AS BLOB)) > 0
          ),
          selected(sequence) AS (
            SELECT MIN(sequence) FROM usable_parts
          )
          SELECT substr(trim(usable_parts.text, ${ECMASCRIPT_WHITESPACE_SQL}), 1, ?) AS text_prefix
          FROM usable_parts
          JOIN selected ON selected.sequence = usable_parts.sequence
          ORDER BY usable_parts.part_index
          LIMIT ?
        `).iterate(
          threadId,
          headEventId,
          threadId,
          MAX_THREAD_PREVIEW_FIRST_PROMPT_BYTES,
          MAX_THREAD_PREVIEW_FIRST_PROMPT_PARTS,
        ) as Iterable<SqlRow>;
        let firstPrompt = "";
        for (const row of promptRows) {
          const appended = appendPreviewText(
            firstPrompt,
            requiredString(row, "text_prefix"),
            MAX_THREAD_PREVIEW_FIRST_PROMPT_BYTES,
          );
          firstPrompt = appended.text;
          if (appended.truncated) break;
        }
        if (firstPrompt !== "") preview.firstPrompt = firstPrompt;
      }

      let recentSearchText = "";
      let searchTruncated = boundedRecentCount > recentMessageLimit;
      if (searchByteLimit === 0) {
        preview.searchTruncated = boundedRecentCount > 0;
        return preview;
      }
      const searchRows = this.database.prepare(`
        WITH RECURSIVE chain(event_id, parent_event_id, sequence, kind, payload_json) AS (
          SELECT event_id, parent_event_id, sequence, kind, payload_json
          FROM events
          WHERE thread_id = ? AND event_id = ?
          UNION ALL
          SELECT event.event_id, event.parent_event_id, event.sequence, event.kind, event.payload_json
          FROM events event
          JOIN chain ON event.thread_id = ? AND event.event_id = chain.parent_event_id
        ),
        recent_messages(sequence, payload_json) AS (
          SELECT sequence, payload_json
          FROM chain
          WHERE kind = 'message_appended'
          ORDER BY sequence DESC
          LIMIT ?
        ),
        blocks(sequence, block_index, value) AS (
          SELECT recent_messages.sequence, CAST(block.key AS INTEGER), block.value
          FROM recent_messages
          JOIN json_each(recent_messages.payload_json, '$.message.content') block
        ),
        search_parts(sequence, block_index, part_index, text) AS (
          SELECT sequence, block_index, 0, json_extract(value, '$.text')
          FROM blocks
          WHERE json_extract(value, '$.type') = 'text' AND json_type(value, '$.text') = 'text'
          UNION ALL
          SELECT sequence, block_index, 0, json_extract(value, '$.name')
          FROM blocks
          WHERE json_extract(value, '$.type') IN ('tool_call', 'tool_result')
            AND json_type(value, '$.name') = 'text'
          UNION ALL
          SELECT sequence, block_index, 1, json_extract(value, '$.rawArguments')
          FROM blocks
          WHERE json_extract(value, '$.type') = 'tool_call'
            AND json_type(value, '$.rawArguments') = 'text'
          UNION ALL
          SELECT sequence, block_index, 1, json_extract(value, '$.content')
          FROM blocks
          WHERE json_extract(value, '$.type') = 'tool_result'
            AND json_type(value, '$.content') = 'text'
          UNION ALL
          SELECT sequence, block_index, 0, json_extract(value, '$.url')
          FROM blocks
          WHERE json_extract(value, '$.type') = 'image' AND json_type(value, '$.url') = 'text'
        )
        SELECT
          substr(text, 1, ?) AS text_prefix,
          length(CAST(text AS BLOB)) AS original_bytes
        FROM search_parts
        ORDER BY sequence, block_index, part_index
        LIMIT ?
      `).iterate(
        threadId,
        headEventId,
        threadId,
        recentMessageLimit,
        Math.min(searchByteLimit, MAX_THREAD_PREVIEW_SEARCH_PART_CHARACTERS),
        MAX_THREAD_PREVIEW_SEARCH_PARTS + 1,
      ) as Iterable<SqlRow>;
      let partCount = 0;
      for (const row of searchRows) {
        if (partCount >= MAX_THREAD_PREVIEW_SEARCH_PARTS) {
          searchTruncated = true;
          break;
        }
        partCount += 1;
        const textPrefix = requiredString(row, "text_prefix");
        if (requiredNumber(row, "original_bytes") > Buffer.byteLength(textPrefix, "utf8")) {
          searchTruncated = true;
        }
        const appended = appendPreviewText(recentSearchText, textPrefix, searchByteLimit);
        recentSearchText = appended.text;
        if (appended.truncated) {
          searchTruncated = true;
          break;
        }
      }
      preview.recentSearchText = recentSearchText;
      preview.searchTruncated = searchTruncated;
      return preview;
    });
  }

  bindThreadWorkspace(threadId: ThreadId, workspaceRoot: string): ThreadRecord {
    const selected = validateWorkspaceRoot(workspaceRoot);
    const thread = this.getThread(threadId);
    if (thread.workspaceRoot !== undefined && thread.workspaceRoot !== selected) {
      throw new HarnessError("STORAGE_WORKSPACE", `Thread ${threadId} belongs to ${thread.workspaceRoot}, not ${selected}`);
    }
    if (thread.workspaceRoot === undefined) {
      const result = this.database.prepare("UPDATE threads SET workspace_root = ? WHERE thread_id = ? AND workspace_root IS NULL")
        .run(selected, threadId);
      if (result.changes !== 1) throw new HarnessError("STORAGE_HEAD_CONFLICT", `Thread ${threadId} workspace changed concurrently`);
    }
    return this.getThread(threadId);
  }

  private decodeRunInputQueue(row: SqlRow): RunInputQueueRecord {
    const mode = requiredString(row, "mode");
    if (mode !== "steer" && mode !== "follow_up") {
      throw new HarnessError("STORAGE_CORRUPT", "Invalid run input queue mode");
    }
    const state = requiredString(row, "state");
    if (!validRunInputQueueState(state)) {
      throw new HarnessError("STORAGE_CORRUPT", "Invalid run input queue state");
    }
    const record: RunInputQueueRecord = {
      queueId: requiredString(row, "queue_id"),
      sequence: requiredNumber(row, "queue_sequence"),
      messageId: requiredString(row, "message_id"),
      threadId: requiredString(row, "thread_id"),
      branch: requiredString(row, "branch_name"),
      mode,
      state,
      text: requiredString(row, "text"),
      createdAt: requiredString(row, "created_at"),
    };
    const images = decodeQueuedImages(row["images_json"]);
    if (images !== undefined) record.images = images;
    assertQueuedRunMessages([record]);
    return record;
  }

  private validRunInputRowsInTransaction(
    threadId: ThreadId,
    branch: string,
    states?: readonly RunInputQueueState[],
  ): RunInputQueueRecord[] {
    const parameters: Array<string> = [threadId, branch];
    const stateClause = states === undefined || states.length === 0
      ? "state != 'quarantined'"
      : `state IN (${states.map(() => "?").join(", ")})`;
    if (states !== undefined) parameters.push(...states);
    const rows = this.database.prepare(`
      SELECT * FROM run_input_queue
      WHERE thread_id = ? AND branch_name = ? AND ${stateClause}
      ORDER BY queue_sequence
    `).all(...parameters) as SqlRow[];
    const valid: RunInputQueueRecord[] = [];
    for (const row of rows) {
      try {
        const decoded = this.decodeRunInputQueue(row);
        assertQueuedRunMessages([...valid, decoded]);
        valid.push(decoded);
      } catch (error) {
        const queueId = typeof row["queue_id"] === "string" ? row["queue_id"] : undefined;
        if (queueId === undefined) throw error;
        const reason = `Quarantined corrupt run input: ${error instanceof Error ? error.message : String(error)}`;
        this.database.prepare(`
          UPDATE run_input_queue
          SET state = 'quarantined', quarantine_reason = ?
          WHERE queue_id = ?
        `).run(Buffer.from(reason, "utf8").subarray(0, 4096).toString("utf8"), queueId);
      }
    }
    return valid;
  }

  enqueueRunInput(input: EnqueueRunInput): RunInputQueueRecord {
    const branch = validateBranchName(input.branch);
    const message: QueuedRunMessage = {
      mode: input.mode,
      text: input.text,
      ...(input.images === undefined ? {} : { images: input.images.map((image) => ({ ...image })) }),
    };
    for (const image of message.images ?? []) validateImageSource(image);
    assertQueuedRunMessages([message]);
    return this.transaction(() => {
      this.branchRow(input.threadId, branch);
      const existing = this.validRunInputRowsInTransaction(input.threadId, branch);
      assertQueuedRunMessages([...existing, message]);
      const queueId = this.idFactory("queue");
      const messageId = this.idFactory("msg");
      this.database.prepare(`
        INSERT INTO run_input_queue(
          queue_id, message_id, thread_id, branch_name, mode, state,
          text, images_json, quarantine_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, NULL, ?)
      `).run(
        queueId,
        messageId,
        input.threadId,
        branch,
        input.mode,
        input.text,
        input.images === undefined ? null : JSON.stringify(input.images),
        this.now(),
      );
      const row = this.database.prepare("SELECT * FROM run_input_queue WHERE queue_id = ?").get(queueId) as SqlRow | undefined;
      if (row === undefined) throw new HarnessError("STORAGE_QUEUE", "Run input queue insert was lost");
      return this.decodeRunInputQueue(row);
    });
  }

  listRunInputs(
    threadId: ThreadId,
    branch: string,
    states?: readonly RunInputQueueState[],
  ): RunInputQueueRecord[] {
    const selected = validateBranchName(branch);
    this.branchRow(threadId, selected);
    return this.transaction(() => this.validRunInputRowsInTransaction(threadId, selected, states));
  }

  beginRunInputDelivery(queueId: string, threadId: ThreadId, branch: string): void {
    const result = this.database.prepare(`
      UPDATE run_input_queue
      SET state = 'draining'
      WHERE queue_id = ? AND thread_id = ? AND branch_name = ? AND state = 'queued'
    `).run(queueId, threadId, validateBranchName(branch));
    if (result.changes !== 1) {
      throw new HarnessError("STORAGE_QUEUE_CONFLICT", `Run input ${queueId} is no longer queued`);
    }
  }

  completeRunInputDelivery(queueId: string, threadId: ThreadId, branch: string): void {
    const result = this.database.prepare(`
      DELETE FROM run_input_queue
      WHERE queue_id = ? AND thread_id = ? AND branch_name = ? AND state = 'draining'
    `).run(queueId, threadId, validateBranchName(branch));
    if (result.changes !== 1) {
      throw new HarnessError("STORAGE_QUEUE_CONFLICT", `Run input ${queueId} was not draining`);
    }
  }

  dequeueRunInput(queueId: string, threadId: ThreadId, branch: string): void {
    const result = this.database.prepare(`
      DELETE FROM run_input_queue
      WHERE queue_id = ? AND thread_id = ? AND branch_name = ?
        AND state IN ('queued', 'recoverable')
    `).run(queueId, threadId, validateBranchName(branch));
    if (result.changes !== 1) {
      throw new HarnessError("STORAGE_QUEUE_CONFLICT", `Run input ${queueId} cannot be dequeued`);
    }
  }

  leaseRunInput(queueId: string, threadId: ThreadId, branch: string): void {
    const result = this.database.prepare(`
      UPDATE run_input_queue SET state = 'leased'
      WHERE queue_id = ? AND thread_id = ? AND branch_name = ?
        AND state IN ('queued', 'recoverable')
    `).run(queueId, threadId, validateBranchName(branch));
    if (result.changes !== 1) throw new HarnessError("STORAGE_QUEUE_CONFLICT", `Run input ${queueId} cannot be leased`);
  }

  acknowledgeRunInputLease(queueId: string, threadId: ThreadId, branch: string): void {
    const result = this.database.prepare(`
      DELETE FROM run_input_queue
      WHERE queue_id = ? AND thread_id = ? AND branch_name = ? AND state = 'leased'
    `).run(queueId, threadId, validateBranchName(branch));
    if (result.changes !== 1) throw new HarnessError("STORAGE_QUEUE_CONFLICT", `Run input lease ${queueId} cannot be acknowledged`);
  }

  releaseRunInputLease(queueId: string, threadId: ThreadId, branch: string): void {
    const result = this.database.prepare(`
      UPDATE run_input_queue SET state = 'recoverable'
      WHERE queue_id = ? AND thread_id = ? AND branch_name = ? AND state = 'leased'
    `).run(queueId, threadId, validateBranchName(branch));
    if (result.changes !== 1) throw new HarnessError("STORAGE_QUEUE_CONFLICT", `Run input lease ${queueId} cannot be released`);
  }

  dequeueRecoverableRunInputs(threadId: ThreadId, branch: string, limit?: number): RunInputQueueRecord[] {
    const selected = validateBranchName(branch);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
      throw new RangeError("Recoverable run input dequeue limit must be from 1 to 100");
    }
    return this.transaction(() => {
      this.branchRow(threadId, selected);
      const available = this.validRunInputRowsInTransaction(threadId, selected, ["recoverable"]);
      const records = limit === undefined ? available : available.slice(0, limit);
      for (const record of records) {
        this.database.prepare("DELETE FROM run_input_queue WHERE queue_id = ? AND state = 'recoverable'")
          .run(record.queueId);
      }
      return records;
    });
  }

  markRunInputsRecoverable(threadId: ThreadId, branch: string): number {
    const selected = validateBranchName(branch);
    return this.transaction(() => {
      this.branchRow(threadId, selected);
      this.database.prepare(`
        DELETE FROM run_input_queue AS queue
        WHERE queue.thread_id = ? AND queue.branch_name = ?
          AND queue.state != 'quarantined' AND EXISTS (
            SELECT 1 FROM events event
            WHERE event.thread_id = queue.thread_id
              AND event.kind = 'message_appended'
              AND json_extract(event.payload_json, '$.message.id') = queue.message_id
          )
      `).run(threadId, selected);
      const result = this.database.prepare(`
        UPDATE run_input_queue
        SET state = 'recoverable'
        WHERE thread_id = ? AND branch_name = ? AND state IN ('queued', 'draining')
      `).run(threadId, selected);
      return Number(result.changes);
    });
  }

  markRunInputRecoverable(queueId: string, threadId: ThreadId, branch: string): void {
    const result = this.database.prepare(`
      UPDATE run_input_queue
      SET state = 'recoverable'
      WHERE queue_id = ? AND thread_id = ? AND branch_name = ?
        AND state IN ('queued', 'draining')
    `).run(queueId, threadId, validateBranchName(branch));
    if (result.changes !== 1) {
      throw new HarnessError("STORAGE_QUEUE_CONFLICT", `Run input ${queueId} cannot be recovered`);
    }
  }

  recoverRunInputs(workspaceRoot: string): RunInputRecoveryReport {
    const workspace = validateWorkspaceRoot(workspaceRoot);
    return this.transaction(() => {
      const beforeQuarantine = requiredNumber(
        this.database.prepare(`
          SELECT count(*) AS value FROM run_input_queue queue
          JOIN threads thread ON thread.thread_id = queue.thread_id
          WHERE thread.workspace_root = ? AND queue.state = 'quarantined'
        `).get(workspace) as SqlRow,
        "value",
      );
      const rows = this.database.prepare(`
        SELECT queue.* FROM run_input_queue queue
        JOIN threads thread ON thread.thread_id = queue.thread_id
        WHERE thread.workspace_root = ? AND queue.state != 'quarantined'
        ORDER BY queue.queue_sequence
      `).all(workspace) as SqlRow[];
      let reconciled = 0;
      const groups = new Map<string, RunInputQueueRecord[]>();
      for (const row of rows) {
        let record: RunInputQueueRecord;
        try {
          record = this.decodeRunInputQueue(row);
        } catch (error) {
          const queueId = requiredString(row, "queue_id");
          const reason = `Quarantined corrupt run input: ${error instanceof Error ? error.message : String(error)}`;
          this.database.prepare(`
            UPDATE run_input_queue SET state = 'quarantined', quarantine_reason = ? WHERE queue_id = ?
          `).run(Buffer.from(reason, "utf8").subarray(0, 4096).toString("utf8"), queueId);
          continue;
        }
        const delivered = this.database.prepare(`
          SELECT 1 AS found FROM events
          WHERE thread_id = ? AND kind = 'message_appended'
            AND json_extract(payload_json, '$.message.id') = ?
          LIMIT 1
        `).get(record.threadId, record.messageId);
        if (delivered !== undefined) {
          this.database.prepare("DELETE FROM run_input_queue WHERE queue_id = ?").run(record.queueId);
          reconciled += 1;
          continue;
        }
        const key = `${record.threadId}\u0000${record.branch}`;
        const group = groups.get(key) ?? [];
        try {
          assertQueuedRunMessages([...group, record]);
          group.push(record);
          groups.set(key, group);
        } catch (error) {
          this.database.prepare(`
            UPDATE run_input_queue SET state = 'quarantined', quarantine_reason = ? WHERE queue_id = ?
          `).run("Quarantined corrupt run input: durable queue aggregate exceeds limits", record.queueId);
        }
      }
      const result = this.database.prepare(`
        UPDATE run_input_queue AS queue
        SET state = 'recoverable'
        WHERE queue.state IN ('queued', 'draining', 'leased') AND EXISTS (
          SELECT 1 FROM threads thread
          WHERE thread.thread_id = queue.thread_id AND thread.workspace_root = ?
        )
      `).run(workspace);
      const afterQuarantine = requiredNumber(
        this.database.prepare(`
          SELECT count(*) AS value FROM run_input_queue queue
          JOIN threads thread ON thread.thread_id = queue.thread_id
          WHERE thread.workspace_root = ? AND queue.state = 'quarantined'
        `).get(workspace) as SqlRow,
        "value",
      );
      return {
        recovered: Number(result.changes),
        reconciled,
        quarantined: afterQuarantine - beforeQuarantine,
      };
    });
  }

  quarantinedRunInputCount(threadId: ThreadId, branch: string): number {
    const row = this.database.prepare(`
      SELECT count(*) AS value FROM run_input_queue
      WHERE thread_id = ? AND branch_name = ? AND state = 'quarantined'
    `).get(threadId, validateBranchName(branch)) as SqlRow;
    return requiredNumber(row, "value");
  }

  nameThread(threadId: ThreadId, name: string | undefined): ThreadRecord {
    const normalized = normalizeThreadName(name);
    const result = this.database
      .prepare("UPDATE threads SET name = ?, updated_at = ? WHERE thread_id = ?")
      .run(normalized ?? null, this.now(), threadId);
    if (result.changes !== 1) throw new HarnessError("STORAGE_NOT_FOUND", `Unknown thread ${threadId}`);
    return this.getThread(threadId);
  }

  listBranches(threadId: ThreadId): BranchRecord[] {
    const rows = this.database
      .prepare(
        "SELECT thread_id, branch_name, head_event_id, created_at, updated_at FROM branches WHERE thread_id = ? ORDER BY branch_name",
      )
      .all(threadId) as SqlRow[];
    return rows.map((row) => {
      const branch: BranchRecord = {
        threadId: requiredString(row, "thread_id"),
        name: requiredString(row, "branch_name"),
        createdAt: requiredString(row, "created_at"),
        updatedAt: requiredString(row, "updated_at"),
      };
      const headEventId = optionalString(row, "head_event_id");
      if (headEventId !== undefined) branch.headEventId = headEventId;
      return branch;
    });
  }

  forkBranch(input: {
    threadId: ThreadId;
    fromBranch?: string;
    newBranch: string;
    atEventId?: EventId | null;
  }): BranchRecord {
    this.transaction(() => this.forkBranchInTransaction(input));
    return this.listBranches(input.threadId).find((branch) => branch.name === input.newBranch)!;
  }

  forkBranchWithSummary(input: {
    threadId: ThreadId;
    fromBranch?: string;
    newBranch: string;
    atEventId?: EventId | null;
    summary: CanonicalMessage;
    sourceBranch: string;
    sourceEventIds: EventId[];
    extensionMetadata?: JsonValue;
    label?: string;
  }): {
    branch: BranchRecord;
    summaryEvent: EventEnvelope<Extract<RuntimeEvent, { type: "branch_summary_created" }>>;
    labelEvent?: EventEnvelope<Extract<RuntimeEvent, { type: "entry_label_changed" }>>;
  } {
    const label = input.label?.replace(/\s+/gu, " ").trim() || undefined;
    if (label !== undefined && !validEntryLabel(label)) {
      throw new HarnessError("STORAGE_LABEL", `Entry label must be at most ${MAX_ENTRY_LABEL_BYTES} UTF-8 bytes without control characters`);
    }
    let summaryEvent: EventEnvelope<Extract<RuntimeEvent, { type: "branch_summary_created" }>> | undefined;
    let labelEvent: EventEnvelope<Extract<RuntimeEvent, { type: "entry_label_changed" }>> | undefined;
    this.transaction(() => {
      this.forkBranchInTransaction(input);
      summaryEvent = this.appendEventInTransaction({
        threadId: input.threadId,
        branch: input.newBranch,
        event: {
          type: "branch_summary_created",
          summary: input.summary,
          sourceBranch: input.sourceBranch,
          sourceEventIds: input.sourceEventIds,
          ...(input.extensionMetadata === undefined ? {} : { extensionMetadata: input.extensionMetadata }),
        },
      });
      if (label !== undefined) {
        labelEvent = this.appendEventInTransaction({
          threadId: input.threadId,
          branch: input.newBranch,
          event: { type: "entry_label_changed", targetEventId: summaryEvent.eventId, label },
        });
      }
    });
    if (summaryEvent === undefined) throw new HarnessError("STORAGE_BRANCH_SUMMARY", "Branch summary transaction produced no event");
    return {
      branch: this.listBranches(input.threadId).find((branch) => branch.name === input.newBranch)!,
      summaryEvent,
      ...(labelEvent === undefined ? {} : { labelEvent }),
    };
  }

  private forkBranchInTransaction(input: {
    threadId: ThreadId;
    fromBranch?: string;
    newBranch: string;
    atEventId?: EventId | null;
  }): void {
    const sourceName = validateBranchName(input.fromBranch ?? this.getThread(input.threadId).defaultBranch);
    const newName = validateBranchName(input.newBranch);
    const timestamp = this.now();
    const source = this.branchRow(input.threadId, sourceName);
    const sourceHead = optionalString(source, "head_event_id");
    const selectedHead = input.atEventId === undefined ? sourceHead : input.atEventId ?? undefined;
    if (input.atEventId !== undefined && input.atEventId !== null && !this.eventIsReachable(input.threadId, sourceHead, input.atEventId)) {
      throw new HarnessError(
        "STORAGE_BRANCH",
        `Event ${input.atEventId} is not reachable from branch ${sourceName}`,
      );
    }
    this.database
      .prepare(
        "INSERT INTO branches(thread_id, branch_name, head_event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.threadId, newName, selectedHead ?? null, timestamp, timestamp);
    this.database
      .prepare("UPDATE threads SET updated_at = ? WHERE thread_id = ?")
      .run(timestamp, input.threadId);
  }

  private branchRow(threadId: ThreadId, branch: string): SqlRow {
    const row = this.database
      .prepare("SELECT * FROM branches WHERE thread_id = ? AND branch_name = ?")
      .get(threadId, branch) as SqlRow | undefined;
    if (row === undefined) {
      throw new HarnessError("STORAGE_NOT_FOUND", `Unknown branch ${threadId}:${branch}`);
    }
    return row;
  }

  private eventIsReachable(
    threadId: ThreadId,
    headEventId: EventId | undefined,
    candidateEventId: EventId,
  ): boolean {
    if (headEventId === undefined) return false;
    const row = this.database
      .prepare(`
        WITH RECURSIVE ancestors(event_id, parent_event_id) AS (
          SELECT event_id, parent_event_id FROM events WHERE thread_id = ? AND event_id = ?
          UNION ALL
          SELECT event.event_id, event.parent_event_id
          FROM events event JOIN ancestors ON event.event_id = ancestors.parent_event_id
        )
        SELECT 1 AS found FROM ancestors WHERE event_id = ? LIMIT 1
      `)
      .get(threadId, headEventId, candidateEventId) as SqlRow | undefined;
    return row !== undefined;
  }

  startRun(input: {
    threadId: ThreadId;
    branch?: string;
    runId?: RunId;
    provider?: ProviderId;
    model?: string;
  }): RunRecord {
    const runId = this.transaction(() => this.startRunInTransaction(input));
    return this.getRun(runId);
  }

  private startRunInTransaction(input: {
    threadId: ThreadId;
    branch?: string;
    runId?: RunId;
    provider?: ProviderId;
    model?: string;
  }): RunId {
    const branch = validateBranchName(input.branch ?? this.getThread(input.threadId).defaultBranch);
    this.branchRow(input.threadId, branch);
    const runId = input.runId ?? this.idFactory("run");
    const startedAt = this.now();
    const active = this.database
      .prepare(
        "SELECT run_id FROM runs WHERE thread_id = ? AND state NOT IN ('completed', 'failed', 'cancelled') LIMIT 1",
      )
      .get(input.threadId) as SqlRow | undefined;
    if (active !== undefined) {
      throw new HarnessError("STORAGE_ACTIVE_RUN", `Thread ${input.threadId} already has an active run`);
    }
    this.database
      .prepare(
        "INSERT INTO runs(run_id, thread_id, branch_name, state, provider, model, started_at) VALUES (?, ?, ?, 'preparing', ?, ?, ?)",
      )
      .run(runId, input.threadId, branch, input.provider ?? null, input.model ?? null, startedAt);
    return runId;
  }

  createEventSink(input: {
    threadId: ThreadId;
    runId: RunId;
    branch?: string;
  }): EventSink {
    let initialized = false;
    return {
      emit: async (event): Promise<EventEnvelope> => {
        if (!initialized) {
          if (event.type !== "run_started") {
            throw new HarnessError("STORAGE_RUN", "The first run event must be run_started");
          }
          const startInput: {
            threadId: ThreadId;
            runId: RunId;
            branch?: string;
            provider: ProviderId;
            model: string;
          } = {
            threadId: input.threadId,
            runId: input.runId,
            provider: event.provider,
            model: event.model,
          };
          if (input.branch !== undefined) startInput.branch = input.branch;
          const envelope = this.transaction(() => {
            this.startRunInTransaction(startInput);
            const appendInput: AppendEventInput = {
              threadId: input.threadId,
              runId: input.runId,
              event,
            };
            if (input.branch !== undefined) appendInput.branch = input.branch;
            return this.appendEventInTransaction(appendInput);
          });
          initialized = true;
          return envelope;
        }
        const appendInput: AppendEventInput = {
          threadId: input.threadId,
          runId: input.runId,
          event,
        };
        if (input.branch !== undefined) appendInput.branch = input.branch;
        return this.appendEvent(appendInput);
      },
    };
  }

  getRun(runId: RunId): RunRecord {
    const row = this.database.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as
      | SqlRow
      | undefined;
    if (row === undefined) throw new HarnessError("STORAGE_NOT_FOUND", `Unknown run ${runId}`);
    return this.decodeRun(row);
  }

  listRuns(threadId: ThreadId): RunRecord[] {
    return (this.database
      .prepare("SELECT * FROM runs WHERE thread_id = ? ORDER BY started_at, run_id")
      .all(threadId) as SqlRow[]).map((row) => this.decodeRun(row));
  }

  private decodeRun(row: SqlRow): RunRecord {
    const rawState = requiredString(row, "state");
    if (!validRunState(rawState)) throw new HarnessError("STORAGE_CORRUPT", "Invalid run state");
    const run: RunRecord = {
      runId: requiredString(row, "run_id"),
      threadId: requiredString(row, "thread_id"),
      branch: requiredString(row, "branch_name"),
      state: rawState,
      startedAt: requiredString(row, "started_at"),
    };
    const provider = optionalString(row, "provider");
    const model = optionalString(row, "model");
    const endedAt = optionalString(row, "ended_at");
    if (provider !== undefined) run.provider = provider;
    if (model !== undefined) run.model = model;
    if (endedAt !== undefined) run.endedAt = endedAt;
    return run;
  }

  appendEvent<T extends RuntimeEvent>(input: AppendEventInput<T>): EventEnvelope<T> {
    return this.transaction(() => this.appendEventInTransaction(input));
  }

  compareAndAppendExtensionState(input: {
    threadId: ThreadId;
    branch?: string;
    event: ExtensionStateEvent;
    expectedEventId: EventId | null;
  }):
    | { status: "committed"; envelope: EventEnvelope<ExtensionStateEvent> }
    | { status: "conflict"; current?: EventEnvelope<ExtensionStateEvent> } {
    let event: ExtensionStateEvent;
    try {
      event = canonicalExtensionStateEvent(input.event);
    } catch (cause) {
      throw new HarnessError("STORAGE_EVENT", "Invalid event shape: extension_state", { cause });
    }
    if (
      input.expectedEventId !== null &&
      (input.expectedEventId === "" || input.expectedEventId.includes("\0") || Buffer.byteLength(input.expectedEventId, "utf8") > 200)
    ) throw new HarnessError("STORAGE_EVENT", "Expected extension state event ID is invalid");
    return this.transaction(() => {
      const branch = validateBranchName(input.branch ?? this.getThread(input.threadId).defaultBranch);
      const current = this.getExtensionState(
        input.threadId,
        event.extensionId,
        event.schemaVersion,
        event.key,
        branch,
      );
      if ((current?.eventId ?? null) !== input.expectedEventId) {
        return current === undefined ? { status: "conflict" } : { status: "conflict", current };
      }
      return {
        status: "committed",
        envelope: this.appendEventInTransaction({ threadId: input.threadId, branch, event }),
      };
    });
  }

  setEntryLabel(input: {
    threadId: ThreadId;
    branch?: string;
    targetEventId: EventId;
    label?: string;
  }): EventEnvelope<Extract<RuntimeEvent, { type: "entry_label_changed" }>> {
    const normalized = input.label?.replace(/\s+/gu, " ").trim() || undefined;
    if (normalized !== undefined && !validEntryLabel(normalized)) {
      throw new HarnessError("STORAGE_LABEL", `Entry label must be at most ${MAX_ENTRY_LABEL_BYTES} UTF-8 bytes without control characters`);
    }
    return this.transaction(() => {
      const target = this.database
        .prepare("SELECT kind FROM events WHERE thread_id = ? AND event_id = ?")
        .get(input.threadId, input.targetEventId) as SqlRow | undefined;
      if (target === undefined || requiredString(target, "kind") === "entry_label_changed") {
        throw new HarnessError("STORAGE_LABEL", `Unknown label target ${input.targetEventId}`);
      }
      return this.appendEventInTransaction({
        threadId: input.threadId,
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        event: {
          type: "entry_label_changed",
          targetEventId: input.targetEventId,
          ...(normalized === undefined ? {} : { label: normalized }),
        },
      });
    });
  }

  listEntryLabels(threadId: ThreadId): EntryLabelRecord[] {
    this.getThread(threadId);
    const rows = this.database
      .prepare("SELECT * FROM events WHERE thread_id = ? AND kind = 'entry_label_changed' ORDER BY sequence")
      .all(threadId) as SqlRow[];
    const labels = new Map<string, EntryLabelRecord>();
    for (const row of rows) {
      const envelope = this.decodeEvent(row);
      if (envelope.event.type !== "entry_label_changed") continue;
      if (envelope.event.label === undefined) labels.delete(envelope.event.targetEventId);
      else labels.set(envelope.event.targetEventId, {
        targetEventId: envelope.event.targetEventId,
        label: envelope.event.label,
        changedAt: envelope.timestamp,
        changeEventId: envelope.eventId,
      });
    }
    return [...labels.values()].sort((left, right) => left.targetEventId.localeCompare(right.targetEventId));
  }

  appendEvents(input: {
    threadId: ThreadId;
    branch?: string;
    runId?: RunId;
    events: RuntimeEvent[];
    expectedHead?: EventId | null;
  }): EventEnvelope[] {
    return this.transaction(() => {
      const envelopes: EventEnvelope[] = [];
      let expectedHead = input.expectedHead;
      for (const event of input.events) {
        const appendInput: AppendEventInput = {
          threadId: input.threadId,
          event,
        };
        if (input.branch !== undefined) appendInput.branch = input.branch;
        if (input.runId !== undefined) appendInput.runId = input.runId;
        if (expectedHead !== undefined) appendInput.expectedHead = expectedHead;
        const envelope = this.appendEventInTransaction(appendInput);
        envelopes.push(envelope);
        expectedHead = envelope.eventId;
      }
      return envelopes;
    });
  }

  private appendEventInTransaction<T extends RuntimeEvent>(
    input: AppendEventInput<T>,
  ): EventEnvelope<T> {
    const isExtensionEvent = input.event.type === "extension_state" || input.event.type === "extension_message";
    let event: RuntimeEvent = input.event;
    try {
      if (input.event.type === "extension_state") event = canonicalExtensionStateEvent(input.event);
      else if (input.event.type === "extension_message") event = canonicalExtensionMessageEvent(input.event);
    } catch (cause) {
      throw new HarnessError("STORAGE_EVENT", `Invalid event shape: ${String(input.event.type)}`, { cause });
    }
    if (!isRecord(event) || !validEventShape(event)) {
      throw new HarnessError("STORAGE_EVENT", `Invalid event shape: ${String(input.event.type)}`);
    }
    const thread = this.database
      .prepare("SELECT default_branch FROM threads WHERE thread_id = ?")
      .get(input.threadId) as SqlRow | undefined;
    if (thread === undefined) throw new HarnessError("STORAGE_NOT_FOUND", `Unknown thread ${input.threadId}`);
    const branch = validateBranchName(input.branch ?? requiredString(thread, "default_branch"));
    const branchRow = this.branchRow(input.threadId, branch);
    const currentHead = optionalString(branchRow, "head_event_id");
    if (input.expectedHead !== undefined && (input.expectedHead ?? undefined) !== currentHead) {
      throw new HarnessError("STORAGE_HEAD_CONFLICT", `Branch ${branch} changed before append`);
    }
    if (input.runId !== undefined) {
      const run = this.getRun(input.runId);
      if (run.threadId !== input.threadId || run.branch !== branch) {
        throw new HarnessError("STORAGE_RUN", `Run ${input.runId} does not belong to ${input.threadId}:${branch}`);
      }
      if (TERMINAL_RUN_STATES.has(run.state)) {
        throw new HarnessError("STORAGE_RUN", `Run ${input.runId} is already terminal`);
      }
    }

    const sequenceRow = this.database
      .prepare(
        "UPDATE threads SET next_sequence = next_sequence + 1, updated_at = ? WHERE thread_id = ? RETURNING next_sequence - 1 AS sequence",
      )
      .get(this.now(), input.threadId) as SqlRow | undefined;
    if (sequenceRow === undefined) throw new HarnessError("STORAGE_NOT_FOUND", `Unknown thread ${input.threadId}`);
    const sequence = requiredNumber(sequenceRow, "sequence");
    const eventId = input.eventId ?? this.idFactory("event");
    const timestamp = input.timestamp ?? this.now();
    const payload = JSON.stringify(event);
    this.database
      .prepare(`
        INSERT INTO events(
          event_id, thread_id, run_id, parent_event_id, branch_name,
          sequence, timestamp, kind, schema_version, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `)
      .run(
        eventId,
        input.threadId,
        input.runId ?? null,
        currentHead ?? null,
        branch,
        sequence,
        timestamp,
        event.type,
        payload,
      );
    this.recordLifecycleEvent(input.threadId, eventId, event);
    this.database
      .prepare("UPDATE branches SET head_event_id = ?, updated_at = ? WHERE thread_id = ? AND branch_name = ?")
      .run(eventId, timestamp, input.threadId, branch);
    if (input.runId !== undefined) this.updateRunFromEvent(input.runId, event, timestamp);

    const envelope: EventEnvelope<T> = {
      eventId,
      threadId: input.threadId,
      sequence,
      timestamp,
      schemaVersion: 1,
      event: (isExtensionEvent ? structuredClone(event) : event) as T,
    };
    if (input.runId !== undefined) envelope.runId = input.runId;
    if (currentHead !== undefined) envelope.parentEventId = currentHead;
    return envelope;
  }

  private recordLifecycleEvent(
    threadId: ThreadId,
    eventId: EventId,
    event: RuntimeEvent,
  ): void {
    if (event.type === "branch_summary_created") {
      const reachable = new Set(this.listEvents(threadId, event.sourceBranch).map((entry) => entry.eventId));
      const invalid = event.sourceEventIds.find((sourceEventId) => !reachable.has(sourceEventId));
      if (invalid !== undefined) {
        throw new HarnessError("STORAGE_BRANCH_SUMMARY", `Branch summary source event ${invalid} is not reachable from ${threadId}:${event.sourceBranch}`);
      }
    } else if (event.type === "entry_label_changed") {
      const target = event.targetEventId === eventId
        ? undefined
        : this.database.prepare("SELECT kind FROM events WHERE thread_id = ? AND event_id = ?")
          .get(threadId, event.targetEventId) as SqlRow | undefined;
      if (target === undefined || requiredString(target, "kind") === "entry_label_changed") {
        throw new HarnessError("STORAGE_LABEL", `Unknown label target ${event.targetEventId}`);
      }
    }
  }

  private updateRunFromEvent(runId: RunId, event: RuntimeEvent, timestamp: string): void {
    let state: RunState | undefined;
    if (event.type === "run_started") state = "preparing";
    else if (event.type === "run_state" && !TERMINAL_RUN_STATES.has(event.state)) state = event.state;
    else if (event.type === "run_completed") state = "completed";
    else if (event.type === "run_failed") state = "failed";
    else if (event.type === "run_cancelled") state = "cancelled";
    if (state === undefined) return;
    const endedAt = TERMINAL_RUN_STATES.has(state) ? timestamp : null;
    this.database
      .prepare("UPDATE runs SET state = ?, ended_at = ? WHERE run_id = ?")
      .run(state, endedAt, runId);
  }

  listEvents(threadId: ThreadId, branch?: string): EventEnvelope[] {
    const selectedBranch = validateBranchName(branch ?? this.getThread(threadId).defaultBranch);
    const branchRow = this.branchRow(threadId, selectedBranch);
    const head = optionalString(branchRow, "head_event_id");
    if (head === undefined) return [];
    const rows = this.database
      .prepare(`
        WITH RECURSIVE chain AS (
          SELECT * FROM events WHERE thread_id = ? AND event_id = ?
          UNION ALL
          SELECT event.* FROM events event JOIN chain ON event.event_id = chain.parent_event_id
        )
        SELECT * FROM chain ORDER BY sequence ASC
      `)
      .all(threadId, head) as SqlRow[];
    const events = rows.map((row) => this.decodeEvent(row));
    const progress = new Map<string, { sequence: number; stdoutBytes: number; stderrBytes: number }>();
    for (const envelope of events) {
      if (envelope.event.type !== "tool_progress") continue;
      const key = `${envelope.runId ?? "unscoped"}\u0000${envelope.event.callId}`;
      const previous = progress.get(key);
      if (
        envelope.event.sequence !== (previous?.sequence ?? -1) + 1 ||
        (envelope.event.progress.type === "output" && (
          envelope.event.progress.stdoutBytes < (previous?.stdoutBytes ?? 0) ||
          envelope.event.progress.stderrBytes < (previous?.stderrBytes ?? 0)
        ))
      ) {
        throw new HarnessError("STORAGE_CORRUPT", `Out-of-order tool progress ${envelope.event.callId}`);
      }
      progress.set(key, {
        sequence: envelope.event.sequence,
        stdoutBytes: envelope.event.progress.type === "output"
          ? envelope.event.progress.stdoutBytes
          : previous?.stdoutBytes ?? 0,
        stderrBytes: envelope.event.progress.type === "output"
          ? envelope.event.progress.stderrBytes
          : previous?.stderrBytes ?? 0,
      });
    }
    return events;
  }

  getModelSelection(threadId: ThreadId, branch?: string): { provider: ProviderId; model: string; reasoningEffort?: string } | undefined {
    const event = this.listEvents(threadId, branch).findLast((entry) =>
      entry.event.type === "model_selected" || entry.event.type === "run_started")?.event;
    if (event?.type === "model_selected") {
      return {
        provider: event.provider,
        model: event.model,
        ...(event.reasoningEffort === undefined ? {} : { reasoningEffort: event.reasoningEffort }),
      };
    }
    if (event?.type === "run_started") {
      return {
        provider: event.provider,
        model: event.model,
        ...(event.reasoningEffort === undefined ? {} : { reasoningEffort: event.reasoningEffort }),
      };
    }
    return undefined;
  }

  getExtensionState(
    threadId: ThreadId,
    extensionId: string,
    schema: number,
    key: string,
    branch?: string,
  ): EventEnvelope<ExtensionStateEvent> | undefined {
    const owner = validateExtensionId(extensionId);
    const version = validateExtensionSchemaVersion(schema);
    const selectedKey = validateExtensionEntryKey(key, "Extension state key");
    return this.listEvents(threadId, branch).findLast((entry): entry is EventEnvelope<ExtensionStateEvent> =>
      entry.event.type === "extension_state" &&
      entry.event.extensionId === owner &&
      entry.event.schemaVersion === version &&
      entry.event.key === selectedKey);
  }

  listExtensionStates(
    threadId: ThreadId,
    extensionId: string,
    schema: number,
    branch?: string,
  ): EventEnvelope<ExtensionStateEvent>[] {
    const owner = validateExtensionId(extensionId);
    const version = validateExtensionSchemaVersion(schema);
    const latest = new Map<string, EventEnvelope<ExtensionStateEvent>>();
    for (const entry of this.listEvents(threadId, branch)) {
      if (
        entry.event.type === "extension_state" &&
        entry.event.extensionId === owner &&
        entry.event.schemaVersion === version
      ) latest.set(entry.event.key, entry as EventEnvelope<ExtensionStateEvent>);
    }
    return [...latest.values()].sort((left, right) => left.sequence - right.sequence);
  }

  listExtensionMessages(
    threadId: ThreadId,
    extensionId: string,
    schema: number,
    branch?: string,
    kind?: string,
  ): EventEnvelope<ExtensionMessageEvent>[] {
    const owner = validateExtensionId(extensionId);
    const version = validateExtensionSchemaVersion(schema);
    const selectedKind = kind === undefined ? undefined : validateExtensionEntryKey(kind, "Extension message kind");
    return this.listEvents(threadId, branch).filter((entry): entry is EventEnvelope<ExtensionMessageEvent> =>
      entry.event.type === "extension_message" &&
      entry.event.extensionId === owner &&
      entry.event.schemaVersion === version &&
      (selectedKind === undefined || entry.event.kind === selectedKind));
  }

  private decodeEvent(row: SqlRow): EventEnvelope {
    const kind = requiredString(row, "kind");
    const event = decodeRuntimeEvent(row["payload_json"], kind);
    const envelope: EventEnvelope = {
      eventId: requiredString(row, "event_id"),
      threadId: requiredString(row, "thread_id"),
      sequence: requiredNumber(row, "sequence"),
      timestamp: requiredString(row, "timestamp"),
      schemaVersion: 1,
      event,
    };
    const runId = optionalString(row, "run_id");
    const parentEventId = optionalString(row, "parent_event_id");
    if (runId !== undefined) envelope.runId = runId;
    if (parentEventId !== undefined) envelope.parentEventId = parentEventId;
    return envelope;
  }

  recoverAbandonedRuns(workspaceRoot?: string): RecoveryReport {
    const workspace = workspaceRoot === undefined ? undefined : validateWorkspaceRoot(workspaceRoot);
    return this.transaction(() => {
      const activeRuns = this.database
        .prepare(
          workspace === undefined
            ? "SELECT * FROM runs WHERE state NOT IN ('completed', 'failed', 'cancelled') ORDER BY started_at, run_id"
            : `SELECT runs.* FROM runs
               INNER JOIN threads ON threads.thread_id = runs.thread_id
               WHERE runs.state NOT IN ('completed', 'failed', 'cancelled')
                 AND threads.workspace_root = ?
               ORDER BY runs.started_at, runs.run_id`,
        )
        .all(...(workspace === undefined ? [] : [workspace])) as SqlRow[];
      const report: RecoveryReport = {
        recoveredRunIds: [],
        repairedToolCallIds: [],
        inDoubtToolCallIds: [],
        reconstructedToolCallIds: [],
      };
      for (const row of activeRuns) {
        const run = this.decodeRun(row);
        const eventRows = this.database
          .prepare("SELECT * FROM events WHERE run_id = ? ORDER BY sequence")
          .all(run.runId) as SqlRow[];
        const requested = new Map<string, {
          name: string;
          index: number;
          started: boolean;
          completed: boolean;
          progressSequence: number;
          stderrBytes: number;
          stdoutBytes: number;
          completionPreview?: string;
          result?: ToolResultBlock;
        }>();
        const recordedResults = new Set<string>();
        for (const eventRow of eventRows) {
          const event = this.decodeEvent(eventRow).event;
          if (event.type === "tool_requested") {
            if (requested.has(event.callId)) {
              throw new HarnessError("STORAGE_CORRUPT", `Duplicate tool request ${event.callId}`);
            }
            requested.set(event.callId, {
              name: event.name,
              index: event.index,
              started: false,
              completed: false,
              progressSequence: -1,
              stderrBytes: 0,
              stdoutBytes: 0,
            });
          } else if (event.type === "tool_started") {
            const request = requested.get(event.callId);
            if (
              request === undefined ||
              request.started ||
              request.completed ||
              request.name !== event.name ||
              request.index !== event.index
            ) {
              throw new HarnessError("STORAGE_CORRUPT", `Invalid tool start ${event.callId}`);
            }
            request.started = true;
          } else if (event.type === "tool_progress") {
            const request = requested.get(event.callId);
            if (
              request === undefined ||
              !request.started ||
              request.completed ||
              request.name !== event.name ||
              request.index !== event.index ||
              event.sequence !== request.progressSequence + 1 ||
              (event.progress.type === "output" && (
                event.progress.stdoutBytes < request.stdoutBytes ||
                event.progress.stderrBytes < request.stderrBytes
              ))
            ) {
              throw new HarnessError("STORAGE_CORRUPT", `Invalid tool progress ${event.callId}`);
            }
            request.progressSequence = event.sequence;
            if (event.progress.type === "output") {
              request.stdoutBytes = event.progress.stdoutBytes;
              request.stderrBytes = event.progress.stderrBytes;
            }
          } else if (event.type === "tool_completed") {
            const request = requested.get(event.callId);
            if (
              request === undefined ||
              request.completed ||
              request.name !== event.name ||
              request.index !== event.index
            ) {
              throw new HarnessError("STORAGE_CORRUPT", `Invalid tool completion ${event.callId}`);
            }
            request.completed = true;
            request.completionPreview = event.preview;
            if (event.result !== undefined) request.result = event.result;
          } else if (event.type === "tool_in_doubt") {
            const request = requested.get(event.callId);
            if (
              request === undefined ||
              !request.started ||
              request.completed ||
              request.name !== event.name ||
              request.index !== event.index
            ) {
              throw new HarnessError("STORAGE_CORRUPT", `Invalid in-doubt tool ${event.callId}`);
            }
            request.completed = true;
          } else if (event.type === "message_appended" && event.message.role === "tool") {
            for (const block of event.message.content) {
              if (block.type !== "tool_result") continue;
              const request = requested.get(block.callId);
              if (request === undefined) continue;
              if (request.name !== block.name || recordedResults.has(block.callId)) {
                throw new HarnessError("STORAGE_CORRUPT", `Invalid recorded tool result ${block.callId}`);
              }
              recordedResults.add(block.callId);
            }
          }
        }
        const repairedBlocks: ToolResultBlock[] = [];
        for (const [callId, request] of requested) {
          if (request.completed) {
            if (recordedResults.has(callId)) continue;
            repairedBlocks.push(request.result ?? {
              type: "tool_result",
              callId,
              name: request.name,
              content: `Tool execution completed before interruption, but its exact result was not durably recorded. Do not retry automatically; inspect the affected state before another side-effecting call.${request.completionPreview === undefined ? "" : ` Recorded preview: ${request.completionPreview}`}`,
              isError: true,
            });
            report.repairedToolCallIds.push(callId);
            report.reconstructedToolCallIds.push(callId);
            continue;
          }
          if (request.started) {
            const reason = "The process stopped after execution began but before completion was durably recorded.";
            this.appendEventInTransaction({
              threadId: run.threadId,
              branch: run.branch,
              runId: run.runId,
              event: { type: "tool_in_doubt", callId, name: request.name, index: request.index, reason },
            });
            repairedBlocks.push({
              type: "tool_result",
              callId,
              name: request.name,
              content: `${reason} Its outcome is unknown and it may have completed partially or fully. Do not retry automatically; inspect the affected state or ask the user before another side-effecting call.`,
              isError: true,
            });
            report.inDoubtToolCallIds.push(callId);
          } else {
            const reason = "Tool execution did not start before process recovery.";
            const result: ToolResultBlock = {
              type: "tool_result",
              callId,
              name: request.name,
              content: `${reason} No tool side effect was initiated by this call.`,
              isError: true,
            };
            this.appendEventInTransaction({
              threadId: run.threadId,
              branch: run.branch,
              runId: run.runId,
              event: {
                type: "tool_completed",
                callId,
                name: request.name,
                index: request.index,
                isError: true,
                preview: reason,
                result,
              },
            });
            repairedBlocks.push(result);
          }
          report.repairedToolCallIds.push(callId);
        }
        if (repairedBlocks.length > 0) {
          this.appendEventInTransaction({
            threadId: run.threadId,
            branch: run.branch,
            runId: run.runId,
            event: {
              type: "message_appended",
              message: {
                id: this.idFactory("msg"),
                role: "tool",
                content: repairedBlocks,
                createdAt: this.now(),
              },
            },
          });
        }
        this.appendEventInTransaction({
          threadId: run.threadId,
          branch: run.branch,
          runId: run.runId,
          event: {
            type: "run_failed",
            error: { category: "internal", message: "Run was abandoned before process recovery." },
          },
        });
        report.recoveredRunIds.push(run.runId);
      }
      return report;
    });
  }

  putArtifact(input: {
    threadId: ThreadId;
    content: Uint8Array;
    mediaType: string;
    artifactId?: ArtifactId;
    runId?: RunId;
    eventId?: EventId;
  }): ArtifactRecord {
    if (input.content.byteLength > this.maxArtifactBytes) {
      throw new HarnessError(
        "STORAGE_ARTIFACT_LIMIT",
        `Artifact exceeds ${this.maxArtifactBytes} byte limit`,
      );
    }
    const artifactId = input.artifactId ?? this.idFactory("artifact");
    const timestamp = this.now();
    const digest = createHash("sha256").update(input.content).digest("hex");
    this.transaction(() => {
      const totalRow = this.database
        .prepare("SELECT COALESCE(SUM(byte_length), 0) AS total FROM artifacts")
        .get() as SqlRow | undefined;
      const total = totalRow === undefined ? 0 : requiredNumber(totalRow, "total");
      if (total + input.content.byteLength > this.maxArtifactStoreBytes) {
        throw new HarnessError(
          "STORAGE_ARTIFACT_STORE_LIMIT",
          `Artifact store exceeds ${this.maxArtifactStoreBytes} byte limit`,
        );
      }
      this.database
        .prepare(`
          INSERT INTO artifacts(
            artifact_id, thread_id, run_id, event_id, media_type,
            byte_length, sha256, content, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          artifactId,
          input.threadId,
          input.runId ?? null,
          input.eventId ?? null,
          input.mediaType,
          input.content.byteLength,
          digest,
          input.content,
          timestamp,
        );
    });
    return this.getArtifact(artifactId);
  }

  getArtifact(artifactId: ArtifactId): ArtifactRecord {
    const row = this.database.prepare("SELECT * FROM artifacts WHERE artifact_id = ?").get(artifactId) as
      | SqlRow
      | undefined;
    if (row === undefined) throw new HarnessError("STORAGE_NOT_FOUND", `Unknown artifact ${artifactId}`);
    const rawContent = row["content"];
    if (!(rawContent instanceof Uint8Array)) {
      throw new HarnessError("STORAGE_CORRUPT", "Artifact content is not binary");
    }
    const artifact: ArtifactRecord = {
      artifactId: requiredString(row, "artifact_id"),
      threadId: requiredString(row, "thread_id"),
      mediaType: requiredString(row, "media_type"),
      byteLength: requiredNumber(row, "byte_length"),
      sha256: requiredString(row, "sha256"),
      content: Uint8Array.from(rawContent),
      createdAt: requiredString(row, "created_at"),
    };
    const runId = optionalString(row, "run_id");
    const eventId = optionalString(row, "event_id");
    if (runId !== undefined) artifact.runId = runId;
    if (eventId !== undefined) artifact.eventId = eventId;
    return artifact;
  }

  listArtifacts(threadId: ThreadId): ArtifactRecord[] {
    const rows = this.database
      .prepare("SELECT artifact_id FROM artifacts WHERE thread_id = ? ORDER BY created_at, artifact_id")
      .all(threadId) as SqlRow[];
    return rows.map((row) => this.getArtifact(requiredString(row, "artifact_id")));
  }

  exportThread(threadId: ThreadId): string {
    const thread = this.getThread(threadId);
    const runs = this.listRuns(threadId);
    const eventRows = this.database
      .prepare("SELECT * FROM events WHERE thread_id = ? ORDER BY sequence")
      .all(threadId) as SqlRow[];
    const artifacts = this.listArtifacts(threadId);
    const lines: SessionExportRecord[] = [
      sessionExportFormatRecord(),
      { type: "thread", value: thread },
      ...runs.map((value) => ({ type: "run" as const, value })),
      ...eventRows.map((row) => ({
        type: "event" as const,
        branch: requiredString(row, "branch_name"),
        value: sessionExportEnvelope(this.decodeEvent(row)),
      })),
      ...artifacts.map((value) => ({
        type: "artifact" as const,
        value: { ...value, content: Buffer.from(value.content).toString("base64") },
      })),
    ];
    return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  }

  setDefaultBranch(threadId: ThreadId, branch: string): ThreadRecord {
    const selected = validateBranchName(branch);
    this.branchRow(threadId, selected);
    const result = this.database.prepare("UPDATE threads SET default_branch = ?, updated_at = ? WHERE thread_id = ?")
      .run(selected, this.now(), threadId);
    if (result.changes !== 1) throw new HarnessError("STORAGE_NOT_FOUND", `Unknown thread ${threadId}`);
    return this.getThread(threadId);
  }

  deleteBranch(threadId: ThreadId, branch: string): void {
    this.transaction(() => {
      const selected = validateBranchName(branch);
      const thread = this.getThread(threadId);
      if (selected === thread.defaultBranch) throw new HarnessError("STORAGE_BRANCH", "Cannot delete the default branch");
      const active = this.database.prepare(`
        SELECT 1 FROM runs
        WHERE thread_id = ? AND branch_name = ? AND state NOT IN ('completed', 'failed', 'cancelled')
        LIMIT 1
      `).get(threadId, selected);
      if (active !== undefined) throw new HarnessError("STORAGE_ACTIVE_RUN", `Branch ${threadId}:${selected} has an active run`);
      const result = this.database.prepare("DELETE FROM branches WHERE thread_id = ? AND branch_name = ?")
        .run(threadId, selected);
      if (result.changes !== 1) throw new HarnessError("STORAGE_NOT_FOUND", `Unknown branch ${threadId}:${selected}`);
    });
  }

  deleteThread(threadId: ThreadId): void {
    this.transaction(() => {
      this.getThread(threadId);
      const active = this.database.prepare(`
        SELECT 1 FROM runs
        WHERE thread_id = ? AND state NOT IN ('completed', 'failed', 'cancelled')
        LIMIT 1
      `).get(threadId);
      if (active !== undefined) throw new HarnessError("STORAGE_ACTIVE_RUN", `Thread ${threadId} has an active run`);
      this.database.prepare("UPDATE branches SET head_event_id = NULL WHERE thread_id = ?").run(threadId);
      this.database.prepare("DELETE FROM artifacts WHERE thread_id = ?").run(threadId);
      this.database.prepare("UPDATE events SET parent_event_id = NULL WHERE thread_id = ?").run(threadId);
      this.database.prepare("DELETE FROM events WHERE thread_id = ?").run(threadId);
      this.database.prepare("DELETE FROM runs WHERE thread_id = ?").run(threadId);
      this.database.prepare("DELETE FROM branches WHERE thread_id = ?").run(threadId);
      const result = this.database.prepare("DELETE FROM threads WHERE thread_id = ?").run(threadId);
      if (result.changes !== 1) throw new HarnessError("STORAGE_NOT_FOUND", `Unknown thread ${threadId}`);
    });
  }

  assertIntegrity(): void {
    assertDatabaseIntegrity(this.database);
  }
}
