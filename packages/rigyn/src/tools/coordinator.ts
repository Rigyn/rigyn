import { isDeepStrictEqual } from "node:util";

import { ASSISTANT_CONTENT_LIMITS } from "@rigyn/kernel/runtime/core/assistant-content-limits";
import { boundedJsonSnapshot } from "@rigyn/kernel/runtime/core/bounded-json";

import { errorMessage } from "../core/errors.js";
import type { ToolUpdate } from "../core/events.js";
import type { JsonValue } from "../core/json.js";
import type { ImageBlock } from "../core/types.js";
import { isNormalizedUsage, MAX_NORMALIZED_USAGE_RAW_BYTES } from "../core/usage.js";
import { MAX_IMAGE_BYTES, normalizeImageSource, requireImageMediaType } from "../providers/images.js";
import { inspectImage, TOOL_IMAGE_MEDIA_TYPES } from "./image-info.js";
import { assertSchema } from "./schema.js";
import type {
  HarnessTool,
  ResourceClaim,
  ToolContext,
  ToolExecutionContext,
  ToolInputTransformationAudit,
  ToolInvocation,
  ToolInvocationProgress,
  ToolInvocationResult,
  ToolArtifact,
  PreparedToolInvocation,
  ToolRecoveryMode,
  ToolResult,
} from "./types.js";
import { limitText } from "./output.js";
import { ToolRegistry } from "./registry.js";
import type { ToolExecutionBackend } from "./backend.js";
import {
  toolAuthorizationRequest,
  validateToolAuthorizationDecision,
  type ToolAuthorizationDecision,
  type ToolAuthorizationRequest,
} from "./approval.js";

export const MAX_TOOL_INVOCATIONS = 256;
export const MAX_TOOL_INPUT_BYTES = 11 * 1024 * 1024;
export const MAX_TOOL_RESULT_CONTENT_BYTES = 256 * 1024;
export const MAX_TOOL_BATCH_CONTENT_BYTES = 768 * 1024;
export const MAX_TOOL_RESULT_METADATA_BYTES = 16 * 1024;
const MAX_TOOL_BATCH_METADATA_BYTES = 128 * 1024;
const MAX_TOOL_ARTIFACTS = 64;
const MAX_TOOL_ARTIFACT_FIELD_BYTES = 4 * 1024;
const MAX_TOOL_RESULT_ARTIFACT_BYTES = 64 * 1024;
const MAX_TOOL_BATCH_ARTIFACT_BYTES = 256 * 1024;
const INVALID_TOOL_ARTIFACT_TEXT = /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u;
// A ToolResultBlock adds four containers around metadata inside a depth-128 V4 commit.
const MAX_TOOL_RESULT_JSON_DEPTH = 124;
const MAX_TOOL_RESULT_ARRAY_ENTRIES = 256;
export const MAX_TOOL_RESULT_IMAGES = 4;
export const MAX_TOOL_RESULT_IMAGE_BYTES = MAX_IMAGE_BYTES;
export const MAX_TOOL_BATCH_IMAGE_BYTES = MAX_IMAGE_BYTES;
export const MAX_TOOL_PROGRESS_UPDATES = 256;
export const MAX_TOOL_PROGRESS_BYTES = 256 * 1024;
export const MAX_TOOL_BATCH_PROGRESS_UPDATES = 1_024;
export const MAX_TOOL_BATCH_PROGRESS_BYTES = 768 * 1024;
export const MAX_TOOL_TRANSFORMATION_AUDIT_ENTRIES = 128;
const MAX_TOOL_RESOURCE_CLAIMS = 256;
const MAX_TOOL_RESOURCE_KEY_BYTES = 4_096;

export interface ToolCoordinatorObserver {
  transformed?(
    invocation: ToolInvocation,
    audit: readonly ToolInputTransformationAudit[],
    context: ToolContext,
  ): Promise<void> | void;
  received?(invocation: ToolInvocation, context: ToolContext): Promise<void> | void;
  started?(invocation: PreparedToolInvocation, context: ToolContext): Promise<void> | void;
  dispatching?(invocation: PreparedToolInvocation, context: ToolExecutionContext): Promise<void> | void;
  progress?(update: ToolInvocationProgress, context: ToolContext): Promise<void> | void;
  completed?(result: ToolInvocationResult, context: ToolContext): Promise<void> | void;
}

export interface ToolCoordinatorInterceptor {
  beforeCall?(
    invocation: ToolInvocation,
    context: ToolContext,
  ): Promise<{
    invocation: ToolInvocation;
    blocked: boolean;
    reason?: string;
    terminate?: boolean;
    transformations?: readonly ToolInputTransformationAudit[];
  } | void> | {
    invocation: ToolInvocation;
    blocked: boolean;
    reason?: string;
    terminate?: boolean;
    transformations?: readonly ToolInputTransformationAudit[];
  } | void;
  afterResult?(
    invocation: ToolInvocation,
    result: ToolResult,
    context: ToolContext,
  ): Promise<ToolResult | void> | ToolResult | void;
  authorize?(
    request: ToolAuthorizationRequest,
    context: ToolExecutionContext,
  ): Promise<ToolAuthorizationDecision> | ToolAuthorizationDecision;
}

interface Prepared {
  invocation: ToolInvocation;
  tool: HarnessTool;
  backend?: ToolExecutionBackend;
  resources: ResourceClaim[];
  executionMode: "parallel" | "sequential";
  recoveryMode: ToolRecoveryMode;
}

export interface ToolTurnSnapshot {
  definitions: ReturnType<ToolRegistry["definitions"]>;
  names: string[];
  revision: number;
  changed: boolean;
}

export interface ToolCoordinatorOptions {
  activeTools?: readonly string[];
  requiredTools?: readonly string[];
}

export interface ToolCoordinatorExecutionOptions {
  /** Host-owned failures that must still emit a balanced start/end lifecycle without running preflight hooks. */
  rejected?: ReadonlyMap<number, ToolResult>;
}

function selectedToolNames(
  values: readonly string[],
  available: ReadonlySet<string>,
  required: ReadonlySet<string>,
): Set<string> {
  const selected = new Set<string>();
  for (const name of values) {
    if (typeof name !== "string" || !available.has(name)) throw new Error(`Unknown registered tool: ${String(name)}`);
    if (selected.has(name)) throw new Error(`Duplicate active tool: ${name}`);
    selected.add(name);
  }
  for (const name of required) {
    if (!selected.has(name)) throw new Error(`Required tool cannot be deactivated: ${name}`);
  }
  return selected;
}

function sameToolNames(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  const rightNames = [...right];
  return [...left].every((name, index) => rightNames[index] === name);
}

function toolError(message: string, metadata?: JsonValue, nextActions: string[] = []): ToolResult {
  return {
    content: message,
    isError: true,
    status: "error",
    summary: message.split("\n", 1)[0] ?? "Tool failed",
    ...(nextActions.length === 0 ? {} : { nextActions }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function snapshotToolInput(value: unknown, invalidMessage: string): JsonValue {
  try {
    const snapshot = boundedJsonSnapshot(value, {
      label: "Tool input",
      maximumBytes: MAX_TOOL_INPUT_BYTES,
      maximumValues: ASSISTANT_CONTENT_LIMITS.argumentValues,
      maximumContainers: ASSISTANT_CONTENT_LIMITS.containers,
      maximumDepth: ASSISTANT_CONTENT_LIMITS.argumentDepth,
    });
    return JSON.parse(snapshot.serialized) as JsonValue;
  } catch (cause) {
    throw new Error(`${invalidMessage}: ${errorMessage(cause)}`);
  }
}

function transformationAudit(value: readonly ToolInputTransformationAudit[] | undefined): ToolInputTransformationAudit[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_TOOL_TRANSFORMATION_AUDIT_ENTRIES) {
    throw new Error("Tool transformation audit is invalid");
  }
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || typeof entry.actor !== "string"
      || entry.actor === "" || entry.actor.includes("\0") || Buffer.byteLength(entry.actor, "utf8") > 256) {
      throw new Error("Tool transformation audit actor is invalid");
    }
    return { actor: entry.actor };
  });
}

const TOOL_RESULT_FIELDS = [
  "content",
  "contentBlocks",
  "isError",
  "usage",
  "status",
  "summary",
  "nextActions",
  "terminate",
  "metadata",
  "addedToolNames",
  "artifacts",
  "images",
] as const satisfies readonly (keyof ToolResult)[];

function plainDataSnapshot<Field extends string>(
  value: unknown,
  fields: readonly Field[],
): Partial<Record<Field, unknown>> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: Partial<Record<Field, unknown>> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (descriptor !== undefined && "value" in descriptor) snapshot[field] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function boundedDenseArraySnapshot(
  value: unknown,
  maximumEntries: number,
): { values: unknown[]; truncated: boolean } | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) return undefined;
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0) return undefined;
    const selected = Math.min(length, maximumEntries);
    const values: unknown[] = [];
    for (let index = 0; index < selected; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      values.push(descriptor.value);
    }
    return { values, truncated: selected !== length };
  } catch {
    return undefined;
  }
}

function jsonSnapshot(value: unknown, maximumValues: number): JsonValue | undefined {
  const active = new WeakSet<object>();
  let remaining = maximumValues;
  let remainingSourceBytes = maximumValues * 8 + 4_096;
  const visit = (current: unknown, depth: number): JsonValue | undefined => {
    if (remaining <= 0) return undefined;
    remaining -= 1;
    if (typeof current === "string") {
      remainingSourceBytes -= Buffer.byteLength(current, "utf8");
      return remainingSourceBytes >= 0 ? current : undefined;
    }
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "number") return Number.isFinite(current) ? current : undefined;
    if (typeof current !== "object" || depth >= MAX_TOOL_RESULT_JSON_DEPTH || active.has(current)) {
      return undefined;
    }
    active.add(current);
    try {
      if (Array.isArray(current)) {
        const dense = boundedDenseArraySnapshot(current, remaining);
        if (dense === undefined || dense.truncated) return undefined;
        const snapshot: JsonValue[] = [];
        for (const entry of dense.values) {
          const next = visit(entry, depth + 1);
          if (next === undefined) return undefined;
          snapshot.push(next);
        }
        return snapshot;
      }

      const snapshot: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== "string") continue;
        const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
        if (descriptor?.enumerable !== true) continue;
        if (!("value" in descriptor)) return undefined;
        remainingSourceBytes -= Buffer.byteLength(key, "utf8");
        if (remainingSourceBytes < 0) return undefined;
        const next = visit(descriptor.value, depth + 1);
        if (next === undefined) return undefined;
        snapshot[key] = next;
      }
      return snapshot;
    } catch {
      return undefined;
    } finally {
      active.delete(current);
    }
  };
  return visit(value, 0);
}

function normalizedToolUsage(value: unknown): ToolResult["usage"] | undefined {
  try {
    const snapshot = jsonSnapshot(value, MAX_NORMALIZED_USAGE_RAW_BYTES);
    return snapshot !== undefined && isNormalizedUsage(snapshot) ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

function boundedMetadata(value: unknown, maxBytes: number): JsonValue | undefined {
  if (value === undefined) return undefined;
  const snapshot = jsonSnapshot(value, maxBytes);
  if (snapshot === undefined) return { truncated: true, invalid: true };
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(snapshot);
  } catch {
    return { truncated: true, invalid: true };
  }
  if (serialized === undefined) return { truncated: true, invalid: true };
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maxBytes) return { truncated: true, originalBytes: bytes };
  return JSON.parse(serialized) as JsonValue;
}

function boundedImages(value: unknown, maximumBytes: number): { images?: ImageBlock[]; invalid: boolean } {
  try {
    if (value === undefined) return { invalid: false };
    if (!Array.isArray(value) || value.length > MAX_TOOL_RESULT_IMAGES) return { invalid: true };
    const images: ImageBlock[] = [];
    let totalBytes = 0;
    for (const entry of value) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return { invalid: true };
      const record = entry as Record<string, unknown>;
      if (
        Object.keys(record).some((key) => !["type", "mediaType", "data"].includes(key)) ||
        record.type !== "image"
      ) return { invalid: true };
      const source = normalizeImageSource(entry as ImageBlock, "Tool result");
      requireImageMediaType(source, "Tool result", TOOL_IMAGE_MEDIA_TYPES);
      if (source.kind !== "base64") return { invalid: true };
      const decoded = Buffer.from(source.data, "base64");
      const inspected = inspectImage(decoded);
      if (inspected === undefined || inspected.mediaType !== source.mediaType) return { invalid: true };
      totalBytes += decoded.byteLength;
      if (totalBytes > maximumBytes) return { invalid: true };
      images.push({ type: "image", mediaType: source.mediaType, data: source.data });
    }
    return images.length === 0 ? { invalid: false } : { images, invalid: false };
  } catch {
    return { invalid: true };
  }
}

function boundedArtifacts(value: unknown, maximumBytes: number): ToolArtifact[] | undefined {
  const dense = boundedDenseArraySnapshot(value, MAX_TOOL_ARTIFACTS);
  if (dense === undefined) return undefined;
  const artifacts: ToolArtifact[] = [];
  let totalBytes = 0;
  for (const entry of dense.values) {
    const candidate = plainDataSnapshot(entry, ["id", "path", "mediaType", "bytes"] as const);
    if (candidate === undefined) continue;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.path !== "string" ||
      typeof candidate.mediaType !== "string" ||
      candidate.id === "" ||
      candidate.path === "" ||
      candidate.mediaType === "" ||
      INVALID_TOOL_ARTIFACT_TEXT.test(candidate.id) ||
      INVALID_TOOL_ARTIFACT_TEXT.test(candidate.path) ||
      INVALID_TOOL_ARTIFACT_TEXT.test(candidate.mediaType) ||
      typeof candidate.bytes !== "number" ||
      !Number.isSafeInteger(candidate.bytes) ||
      candidate.bytes < 0
    ) continue;
    const fieldBytes = [candidate.id, candidate.path, candidate.mediaType]
      .map((field) => Buffer.byteLength(field, "utf8"));
    if (fieldBytes.some((bytes) => bytes > MAX_TOOL_ARTIFACT_FIELD_BYTES)) continue;
    const artifactBytes = fieldBytes.reduce((sum, bytes) => sum + bytes, 0);
    if (totalBytes + artifactBytes > maximumBytes) continue;
    totalBytes += artifactBytes;
    artifacts.push({
      id: candidate.id,
      path: candidate.path,
      mediaType: candidate.mediaType,
      bytes: candidate.bytes,
    });
  }
  return artifacts.length === 0 ? undefined : artifacts;
}

function boundedResult(
  result: unknown,
  contentBytes: number,
  metadataBytes: number,
  artifactBytes: number,
  imageBytes: number,
): ToolResult {
  const value = plainDataSnapshot(result, TOOL_RESULT_FIELDS) ?? {};
  const content = value.content;
  const rawIsError = value.isError;
  const rawStatus = value.status;
  const rawSummary = value.summary;
  const rawTerminate = value.terminate;
  const usage = normalizedToolUsage(value.usage);
  const validContent = typeof content === "string";
  const boundedImageResult = boundedImages(value.images, imageBytes);
  const limited = limitText(
    boundedImageResult.invalid
      ? "Tool returned invalid image content"
      : validContent ? content : "Tool returned invalid non-string content",
    contentBytes,
  );
  const metadata = boundedMetadata(value.metadata, metadataBytes);
  const contentBlocks = boundedDenseArraySnapshot(value.contentBlocks, 0);
  const emptyContentBlocks = contentBlocks !== undefined && !contentBlocks.truncated;
  const artifacts = boundedArtifacts(value.artifacts, artifactBytes);
  const isError = !validContent || boundedImageResult.invalid || typeof rawIsError !== "boolean" ? true : rawIsError;
  const status = isError
    ? "error" as const
    : rawStatus === "warning" ? "warning" as const : "success" as const;
  const defaultSummary = limited.text.trim().split("\n", 1)[0] || (isError ? "Tool failed" : "Tool completed");
  const summary = utf8Prefix(typeof rawSummary === "string" && rawSummary.trim() !== "" ? rawSummary.trim() : defaultSummary, 1024).text;
  const nextActions = boundedDenseArraySnapshot(value.nextActions, MAX_TOOL_RESULT_ARRAY_ENTRIES)?.values
      .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      .slice(0, 8)
      .map((entry) => utf8Prefix(entry.trim(), 1024).text)
    ?? [];
  const addedToolNames = [...new Set(
    boundedDenseArraySnapshot(value.addedToolNames, MAX_TOOL_RESULT_ARRAY_ENTRIES)?.values
      .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      .slice(0, 256)
      .map((entry) => utf8Prefix(entry.trim(), 1_024).text) ?? [],
  )];
  return {
    content: limited.text,
    ...(emptyContentBlocks ? { contentBlocks: [] } : {}),
    isError,
    status,
    summary,
    ...(usage === undefined ? {} : { usage }),
    ...(nextActions.length === 0 ? {} : { nextActions }),
    ...(addedToolNames.length === 0 ? {} : { addedToolNames }),
    ...(typeof rawTerminate === "boolean" ? { terminate: rawTerminate } : {}),
    ...(metadata === undefined ? {} : { metadata }),
    ...(artifacts === undefined || artifacts.length === 0 ? {} : { artifacts }),
    ...(boundedImageResult.images === undefined ? {} : { images: boundedImageResult.images }),
  };
}

function validProgress(value: unknown): value is ToolUpdate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const progress = value as Record<string, unknown>;
  if (progress["type"] === "result") {
    return typeof progress["content"] === "string" &&
      typeof progress["isError"] === "boolean" &&
      (progress["metadata"] === undefined ||
        jsonSnapshot(progress["metadata"], MAX_TOOL_RESULT_METADATA_BYTES) !== undefined) &&
      (progress["truncated"] === undefined || typeof progress["truncated"] === "boolean");
  }
  return progress["type"] === "output" &&
    (progress["stream"] === "stdout" || progress["stream"] === "stderr") &&
    typeof progress["delta"] === "string" &&
    Number.isSafeInteger(progress["stdoutBytes"]) && (progress["stdoutBytes"] as number) >= 0 &&
    Number.isSafeInteger(progress["stderrBytes"]) && (progress["stderrBytes"] as number) >= 0 &&
    (progress["elapsedMs"] === undefined || (Number.isSafeInteger(progress["elapsedMs"]) && (progress["elapsedMs"] as number) >= 0)) &&
    (progress["truncated"] === undefined || typeof progress["truncated"] === "boolean");
}

function utf8Prefix(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maximumBytes) return { text: value, truncated: false };
  if (maximumBytes <= 0) return { text: "", truncated: true };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let length = maximumBytes; length >= Math.max(0, maximumBytes - 3); length -= 1) {
    try {
      return { text: decoder.decode(encoded.subarray(0, length)), truncated: true };
    } catch {
      // A UTF-8 scalar is at most four bytes, so only the last three bytes can be partial.
    }
  }
  return { text: "", truncated: true };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function settleWithSignal<T>(
  signal: AbortSignal,
  operation: () => T | PromiseLike<T>,
): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}

function pathOverlaps(left: string, right: string): boolean {
  if (left === "workspace" || right === "workspace") return true;
  const normalize = (value: string): string => {
    const portable = value.replaceAll("\\", "/");
    const path = portable === "/" ? portable : portable.replace(/\/+$/u, "");
    return process.platform === "win32" || /^[a-z]:\//iu.test(portable) || value.startsWith("\\\\")
      ? path.toLowerCase()
      : path;
  };
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  const descendant = (path: string, parent: string): boolean =>
    path.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
  return normalizedLeft === normalizedRight || descendant(normalizedLeft, normalizedRight) || descendant(normalizedRight, normalizedLeft);
}

export function resourcesConflict(left: ResourceClaim[], right: ResourceClaim[]): boolean {
  return left.some((one) => right.some((two) => {
    if (one.kind !== two.kind && one.kind !== "workspace" && two.kind !== "workspace") return false;
    if (one.mode === "read" && two.mode === "read") return false;
    return pathOverlaps(one.key, two.key);
  }));
}

function validateResourceClaims(value: unknown): ResourceClaim[] {
  if (!Array.isArray(value) || value.length > MAX_TOOL_RESOURCE_CLAIMS) {
    throw new Error(`Tool resource claims must be an array of at most ${MAX_TOOL_RESOURCE_CLAIMS} entries`);
  }
  return value.map((claim) => {
    if (claim === null || typeof claim !== "object" || Array.isArray(claim)) {
      throw new Error("Tool resource claim is invalid");
    }
    const record = claim as Record<string, unknown>;
    const kind = record.kind;
    const key = record.key;
    const mode = record.mode;
    if (
      kind !== "file" &&
      kind !== "process" &&
      kind !== "network" &&
      kind !== "workspace" &&
      kind !== "session"
    ) {
      throw new Error("Tool resource claim kind is invalid");
    }
    if (
      typeof key !== "string" ||
      key === "" ||
      key.includes("\0") ||
      Buffer.byteLength(key, "utf8") > MAX_TOOL_RESOURCE_KEY_BYTES
    ) {
      throw new Error("Tool resource claim key is invalid");
    }
    if (mode !== "read" && mode !== "write") {
      throw new Error("Tool resource claim mode is invalid");
    }
    return { kind, key, mode };
  });
}

function executionWaves(prepared: Prepared[]): Prepared[][] {
  const waves: Prepared[][] = [];
  let wave: Prepared[] = [];
  for (const item of prepared) {
    if (wave.some((scheduled) => resourcesConflict(scheduled.resources, item.resources))) {
      waves.push(wave);
      wave = [item];
      continue;
    }
    wave.push(item);
  }
  if (wave.length > 0) waves.push(wave);
  return waves;
}

export class ToolCoordinator {
  #registry: ToolRegistry;
  readonly #observer: ToolCoordinatorObserver;
  readonly #redact: ((value: string) => string) | undefined;
  readonly #redactValue: ((value: JsonValue) => JsonValue) | undefined;
  readonly #interceptor: ToolCoordinatorInterceptor;
  #availableNames: Set<string>;
  #requiredNames: Set<string>;
  #activeNames: Set<string>;
  #pendingNames: Set<string> | undefined;
  #pendingRegistry: {
    registry: ToolRegistry;
    availableNames: Set<string>;
    requiredNames: Set<string>;
    activeNames: Set<string>;
  } | undefined;
  #revision = 0;
  #activeBatches = 0;

  constructor(
    registry: ToolRegistry,
    observer: ToolCoordinatorObserver = {},
    redaction: { text(value: string): string; value(value: JsonValue): JsonValue } | undefined = undefined,
    interceptor: ToolCoordinatorInterceptor = {},
    options: ToolCoordinatorOptions = {},
  ) {
    this.#registry = registry;
    this.#observer = observer;
    this.#redact = redaction?.text;
    this.#redactValue = redaction?.value;
    this.#interceptor = interceptor;
    this.#availableNames = new Set(registry.names());
    this.#requiredNames = selectedToolNames(
      options.requiredTools ?? [],
      this.#availableNames,
      new Set(),
    );
    this.#activeNames = selectedToolNames(
      options.activeTools ?? [...this.#availableNames],
      this.#availableNames,
      this.#requiredNames,
    );
  }

  definitions() {
    return this.#registry.definitions([...this.#activeNames]);
  }

  allToolNames(): string[] {
    return [...(this.#pendingRegistry?.availableNames ?? this.#availableNames)].sort();
  }

  activeToolNames(): string[] {
    return [...(this.#pendingRegistry?.activeNames ?? this.#pendingNames ?? this.#activeNames)];
  }

  appliedToolNames(): string[] {
    return [...this.#activeNames];
  }

  queueActiveTools(names: readonly string[]): string[] {
    if (this.#pendingRegistry !== undefined) {
      this.#pendingRegistry.activeNames = selectedToolNames(
        names,
        this.#pendingRegistry.availableNames,
        this.#pendingRegistry.requiredNames,
      );
      return this.activeToolNames();
    }
    this.#pendingNames = selectedToolNames(names, this.#availableNames, this.#requiredNames);
    return this.activeToolNames();
  }

  /** Queue a complete registry replacement for the next provider turn boundary. */
  queueTools(tools: Iterable<HarnessTool>, activeNames?: readonly string[]): string[] {
    const registry = new ToolRegistry(tools);
    const availableNames = new Set(registry.names());
    const requiredNames = selectedToolNames([...this.#requiredNames], availableNames, new Set());
    this.#pendingRegistry = {
      registry,
      availableNames,
      requiredNames,
      activeNames: selectedToolNames(activeNames ?? [...availableNames], availableNames, requiredNames),
    };
    this.#pendingNames = undefined;
    return this.activeToolNames();
  }

  turnSnapshot(): ToolTurnSnapshot {
    if (this.#activeBatches !== 0) throw new Error("Cannot apply active tools while a tool batch is executing");
    const replacement = this.#pendingRegistry;
    this.#pendingRegistry = undefined;
    if (replacement !== undefined) {
      this.#registry = replacement.registry;
      this.#availableNames = replacement.availableNames;
      this.#requiredNames = replacement.requiredNames;
      this.#activeNames = replacement.activeNames;
      this.#revision += 1;
      return {
        definitions: this.#registry.definitions([...this.#activeNames]),
        names: this.appliedToolNames(),
        revision: this.#revision,
        changed: true,
      };
    }
    const pending = this.#pendingNames;
    this.#pendingNames = undefined;
    const changed = pending !== undefined && !sameToolNames(pending, this.#activeNames);
    if (pending !== undefined) this.#activeNames = pending;
    if (changed) this.#revision += 1;
    return {
      definitions: this.#registry.definitions([...this.#activeNames]),
      names: this.appliedToolNames(),
      revision: this.#revision,
      changed,
    };
  }

  async execute(
    invocations: ToolInvocation[],
    context: ToolContext,
    observer: ToolCoordinatorObserver = {},
    options: ToolCoordinatorExecutionOptions = {},
  ): Promise<ToolInvocationResult[]> {
    return await this.#execute(invocations, context, observer, options, false);
  }

  /**
   * Executes inputs that were already prepared and durably recorded before an
   * interrupted dispatch. Product recovery code is the only intended caller.
   *
   * @internal
   */
  async executeRecovered(
    invocations: ToolInvocation[],
    context: ToolContext,
    observer: ToolCoordinatorObserver = {},
  ): Promise<ToolInvocationResult[]> {
    return await this.#execute(invocations, context, observer, {}, true);
  }

  async #execute(
    invocations: ToolInvocation[],
    context: ToolContext,
    observer: ToolCoordinatorObserver,
    options: ToolCoordinatorExecutionOptions,
    recovered: boolean,
  ): Promise<ToolInvocationResult[]> {
    if (invocations.length > MAX_TOOL_INVOCATIONS) {
      throw new RangeError(`A tool batch cannot exceed ${MAX_TOOL_INVOCATIONS} invocations`);
    }
    const invocationIndexes = new Set<number>();
    for (const invocation of invocations) {
      if (!Number.isSafeInteger(invocation.index) || invocation.index < 0) {
        throw new RangeError("Tool invocation index must be a nonnegative safe integer");
      }
      if (invocationIndexes.has(invocation.index)) {
        throw new RangeError(`Tool invocation index ${invocation.index} must be distinct within its batch`);
      }
      invocationIndexes.add(invocation.index);
    }
    this.#activeBatches += 1;
    try {
    const count = Math.max(1, invocations.length);
    const contentBytes = Math.min(MAX_TOOL_RESULT_CONTENT_BYTES, Math.floor(MAX_TOOL_BATCH_CONTENT_BYTES / count));
    const metadataBytes = Math.min(MAX_TOOL_RESULT_METADATA_BYTES, Math.floor(MAX_TOOL_BATCH_METADATA_BYTES / count));
    const artifactBytes = Math.min(MAX_TOOL_RESULT_ARTIFACT_BYTES, Math.floor(MAX_TOOL_BATCH_ARTIFACT_BYTES / count));
    const imageBytes = Math.min(MAX_TOOL_RESULT_IMAGE_BYTES, Math.floor(MAX_TOOL_BATCH_IMAGE_BYTES / count));
    const results = new Map<number, ToolInvocationResult>();
    const finalized = new Set<number>();
    const notified = new Set<number>();
    const prepared: Prepared[] = [];
    const callIds = new Set<string>();
    const duplicateCallIds = new Set<string>();
    let batchProgressUpdates = 0;
    let batchProgressBytes = 0;
    let progressDelivery = Promise.resolve();
    const finalize = (entry: ToolInvocationResult): ToolInvocationResult => {
      const safe = boundedResult(entry.result, contentBytes, metadataBytes, artifactBytes, imageBytes);
      let metadata = safe.metadata;
      if (metadata !== undefined && this.#redactValue !== undefined) {
        try {
          metadata = this.#redactValue(metadata);
        } catch {
          metadata = { truncated: true, invalid: true };
        }
      }
      const candidate: ToolResult = {
        ...safe,
        content: this.#redact?.(safe.content) ?? safe.content,
        summary: this.#redact?.(safe.summary ?? safe.content) ?? safe.summary ?? safe.content,
        ...(safe.nextActions === undefined
          ? {}
          : { nextActions: safe.nextActions.map((action) => this.#redact?.(action) ?? action) }),
        ...(safe.addedToolNames === undefined
          ? {}
          : { addedToolNames: safe.addedToolNames.filter((name) => (this.#redact?.(name) ?? name) === name) }),
        ...(safe.artifacts === undefined
          ? {}
          : {
              artifacts: safe.artifacts.filter((artifact) =>
                [artifact.id, artifact.path, artifact.mediaType].every((field) =>
                  (this.#redact?.(field) ?? field) === field)),
            }),
        ...(metadata === undefined ? {} : { metadata }),
      };
      return { ...entry, result: boundedResult(candidate, contentBytes, metadataBytes, artifactBytes, imageBytes) };
    };
    const notifyCompleted = async (entry: ToolInvocationResult): Promise<void> => {
      if (this.#observer.completed !== undefined) {
        await settleWithSignal(context.signal, () => this.#observer.completed!(entry, context));
      }
      if (observer.completed !== undefined) {
        await settleWithSignal(context.signal, () => observer.completed!(entry, context));
      }
      notified.add(entry.invocation.index);
    };
    const notifyReceived = async (invocation: ToolInvocation): Promise<void> => {
      if (this.#observer.received !== undefined) {
        await settleWithSignal(context.signal, () => this.#observer.received!(invocation, context));
      }
      if (observer.received !== undefined) {
        await settleWithSignal(context.signal, () => observer.received!(invocation, context));
      }
    };
    const notifyStarted = async (invocation: PreparedToolInvocation): Promise<void> => {
      if (this.#observer.started !== undefined) {
        await settleWithSignal(context.signal, () => this.#observer.started!(invocation, context));
      }
      if (observer.started !== undefined) {
        await settleWithSignal(context.signal, () => observer.started!(invocation, context));
      }
    };
    const notifyDispatching = async (
      invocation: PreparedToolInvocation,
      invocationContext: ToolExecutionContext,
    ): Promise<void> => {
      if (this.#observer.dispatching !== undefined) {
        await settleWithSignal(context.signal, () => this.#observer.dispatching!(invocation, invocationContext));
      }
      if (observer.dispatching !== undefined) {
        await settleWithSignal(context.signal, () => observer.dispatching!(invocation, invocationContext));
      }
    };
    const notifyTransformed = async (
      invocation: ToolInvocation,
      audit: readonly ToolInputTransformationAudit[],
    ): Promise<void> => {
      if (audit.length === 0) return;
      if (this.#observer.transformed !== undefined) {
        await settleWithSignal(context.signal, () => this.#observer.transformed!(invocation, audit, context));
      }
      if (observer.transformed !== undefined) {
        await settleWithSignal(context.signal, () => observer.transformed!(invocation, audit, context));
      }
    };
    const deliverProgress = (update: ToolInvocationProgress, progressContext: ToolContext): void => {
      progressDelivery = progressDelivery.then(async () => {
        try {
          if (this.#observer.progress !== undefined) {
            await settleWithSignal(progressContext.signal, () => this.#observer.progress!(update, progressContext));
          }
        } catch {
          // Live progress is best effort and must never fail a tool invocation.
        }
        try {
          if (observer.progress !== undefined) {
            await settleWithSignal(progressContext.signal, () => observer.progress!(update, progressContext));
          }
        } catch {
          // Keep configured and per-execution observers isolated from each other.
        }
      });
    };

    for (const invocation of invocations) {
      if (callIds.has(invocation.callId)) duplicateCallIds.add(invocation.callId);
      else callIds.add(invocation.callId);
    }

    const coordinator = this;
    const completeImmediate = async (entry: ToolInvocationResult): Promise<void> => {
      const completed = finalize(entry);
      results.set(completed.invocation.index, completed);
      finalized.add(completed.invocation.index);
      await notifyCompleted(completed);
    };

    for (const invocation of invocations) {
      if (
        this.#activeNames.has(invocation.name) &&
        this.#registry.get(invocation.name)?.executionMode === "sequential"
      ) {
        await runPreparedWaves();
      }
      let effective: ToolInvocation = {
        callId: invocation.callId,
        name: invocation.name,
        input: null,
        index: invocation.index,
      };
      let observable = effective;
      let received = false;
      let receiving = false;
      let started = false;
      let starting = false;
      let recoveryMode: ToolRecoveryMode = "never_repeat";
      const receive = async (value: ToolInvocation): Promise<void> => {
        receiving = true;
        await notifyReceived(value);
        receiving = false;
        received = true;
      };
      const start = async (value: ToolInvocation): Promise<void> => {
        starting = true;
        await notifyStarted({ ...value, recoveryMode });
        starting = false;
        started = true;
      };
      try {
        const baselineInput = snapshotToolInput(invocation.input, "Tool invocation contains non-JSON input");
        effective = { ...effective, input: baselineInput };
        observable = effective;
        const tool = this.#activeNames.has(invocation.name) ? this.#registry.get(invocation.name) : undefined;
        recoveryMode = this.#registry.recovery(invocation.name)?.mode ?? "never_repeat";
        const rejected = options.rejected?.get(invocation.index);
        if (rejected !== undefined) {
          await start(effective);
          await completeImmediate({ invocation: effective, result: rejected });
          continue;
        }
        if (duplicateCallIds.has(invocation.callId)) {
          await start(effective);
          await receive(effective);
          await completeImmediate({
            invocation: effective,
            result: toolError(`Duplicate tool call ID: ${invocation.callId}`),
          });
          continue;
        }
        if (tool === undefined) {
          await start(effective);
          await receive(effective);
          await completeImmediate({
            invocation: effective,
            result: toolError(
              `Unknown or inactive tool: ${invocation.name}`,
              { available: this.appliedToolNames() },
              this.appliedToolNames().length === 0
                ? ["Stop and ask for an active tool before retrying."]
                : [`Retry with one of the active tools: ${this.appliedToolNames().join(", ")}.`],
            ),
          });
          continue;
        }
        const preparedInput = recovered || tool.prepareInput === undefined
          ? baselineInput
          : await settleWithSignal(
            context.signal,
            () => tool.prepareInput!(
              snapshotToolInput(baselineInput, "Tool invocation contains non-JSON input"),
              context,
            ),
          );
        effective = {
          callId: invocation.callId,
          name: invocation.name,
          input: snapshotToolInput(
            preparedInput,
            recovered || tool.prepareInput === undefined
              ? "Tool invocation contains non-JSON input"
              : "Tool input preparation returned non-JSON input",
          ),
          index: invocation.index,
        };
        effective = {
          ...effective,
          input: snapshotToolInput(
            assertSchema(tool.definition.inputSchema, effective.input),
            "Tool schema conversion returned non-JSON input",
          ),
        };
        tool.validate(effective.input);
        observable = {
          ...effective,
          input: snapshotToolInput(effective.input, "Tool input validation returned non-JSON input"),
        };
        const reduction = recovered || this.#interceptor.beforeCall === undefined
          ? undefined
          : await settleWithSignal(
            context.signal,
            () => this.#interceptor.beforeCall!(effective, context),
          );
        let blockedReason: string | undefined;
        let blocked = false;
        let terminate = false;
        let transformations: ToolInputTransformationAudit[] = [];
        if (reduction !== undefined) {
          if (
            reduction.invocation.callId !== invocation.callId ||
            reduction.invocation.name !== invocation.name ||
            reduction.invocation.index !== invocation.index
          ) {
            throw new Error("Tool interception cannot change call identity");
          }
          effective = {
            callId: invocation.callId,
            name: invocation.name,
            input: snapshotToolInput(reduction.invocation.input, "Tool interception returned non-JSON input"),
            index: invocation.index,
          };
          if (reduction.terminate !== undefined && typeof reduction.terminate !== "boolean") {
            throw new TypeError("Tool interception terminate must be boolean");
          }
          if (reduction.blocked) {
            blocked = true;
            blockedReason = reduction.reason;
            terminate = reduction.terminate === true;
          }
          transformations = transformationAudit(reduction.transformations);
        }
        if (!isDeepStrictEqual(observable.input, effective.input) && transformations.length === 0) {
          // Public host interceptors predate explicit transformation ledgers.
          transformations = [{ actor: "host" }];
        }
        await notifyTransformed(effective, transformations);
        observable = effective;
        if (reduction !== undefined) {
          effective = {
            ...effective,
            input: snapshotToolInput(
              assertSchema(tool.definition.inputSchema, effective.input),
              "Tool schema conversion returned non-JSON input",
            ),
          };
          tool.validate(effective.input);
          observable = {
            ...effective,
            input: snapshotToolInput(effective.input, "Tool input validation returned non-JSON input"),
          };
        }
        await start(effective);
        await receive(effective);
        if (blocked) {
          await completeImmediate({
            invocation: effective,
            result: {
              ...toolError(blockedReason ?? "Tool blocked by runtime extension"),
              ...(terminate ? { terminate: true } : {}),
            },
          });
          continue;
        }
        const backend = context.backend?.handles(effective.name) === true ? context.backend : undefined;
        const request = { invocation: effective, workspace: context.workspace.root };
        const resourceClaims = backend === undefined
          ? await settleWithSignal(context.signal, () => tool.resources(effective.input, context))
          : await settleWithSignal(context.signal, () => backend.resources(request, context));
        const resources = validateResourceClaims(resourceClaims);
        const item: Prepared = {
          invocation: effective,
          tool,
          ...(backend === undefined ? {} : { backend }),
          resources,
          executionMode: tool.executionMode ?? "parallel",
          recoveryMode,
        };
        prepared.push(item);
        if (item.executionMode === "sequential") await runPreparedWaves();
      } catch (error) {
        context.signal.throwIfAborted();
        if (starting || receiving) throw error;
        if (!started) await start(observable);
        if (!received) await receive(observable);
        await completeImmediate({
          invocation: observable,
          result: toolError(
            `Invalid tool request: ${errorMessage(error)}`,
            undefined,
            [`Correct the arguments to match the ${observable.name} schema, then retry once.`],
          ),
        });
      }
    }

    async function runPrepared(item: Prepared): Promise<ToolInvocationResult> {
      if (context.signal.aborted) {
        return { invocation: item.invocation, result: toolError("Tool cancelled before execution") };
      }
          const progressState = {
            bytes: 0,
            closed: false,
            saturated: false,
            sequence: 0,
            stderrBytes: 0,
            stdoutBytes: 0,
            updates: 0,
          };
          let invocationContext!: ToolExecutionContext;
          const reportProgress = (candidate: ToolUpdate): void => {
            try {
              if (progressState.closed || progressState.saturated || !validProgress(candidate)) return;
              if (candidate.type === "output") {
                if (
                  candidate.stdoutBytes < progressState.stdoutBytes ||
                  candidate.stderrBytes < progressState.stderrBytes
                ) return;
                progressState.stdoutBytes = candidate.stdoutBytes;
                progressState.stderrBytes = candidate.stderrBytes;
              }

              if (
                progressState.updates >= MAX_TOOL_PROGRESS_UPDATES ||
                batchProgressUpdates >= MAX_TOOL_BATCH_PROGRESS_UPDATES
              ) {
                progressState.saturated = true;
                return;
              }
              const atUpdateLimit = progressState.updates === MAX_TOOL_PROGRESS_UPDATES - 1 ||
                batchProgressUpdates === MAX_TOOL_BATCH_PROGRESS_UPDATES - 1;
              if (atUpdateLimit && candidate.type === "output") {
                progressState.saturated = true;
                const update: ToolInvocationProgress = {
                  invocation: item.invocation,
                  sequence: progressState.sequence,
                  progress: { ...candidate, delta: "", truncated: true },
                };
                progressState.sequence += 1;
                progressState.updates += 1;
                batchProgressUpdates += 1;
                deliverProgress(update, invocationContext);
                return;
              }

              const available = Math.max(0, Math.min(
                MAX_TOOL_PROGRESS_BYTES - progressState.bytes,
                MAX_TOOL_BATCH_PROGRESS_BYTES - batchProgressBytes,
              ));
              if (candidate.type === "result" && available === 0) {
                progressState.saturated = true;
                return;
              }
              const sourceText = candidate.type === "output" ? candidate.delta : candidate.content;
              const redacted = coordinator.#redact?.(sourceText) ?? sourceText;
              let metadata: JsonValue | undefined;
              let metadataBytes = 0;
              let metadataTruncated = false;
              if (candidate.type === "result" && candidate.metadata !== undefined) {
                const redactedMetadata = coordinator.#redactValue?.(candidate.metadata) ?? candidate.metadata;
                const serialized = JSON.stringify(redactedMetadata);
                const rawMetadataBytes = Buffer.byteLength(serialized, "utf8");
                metadata = boundedMetadata(redactedMetadata, MAX_TOOL_RESULT_METADATA_BYTES);
                metadataBytes = metadata === undefined ? 0 : Buffer.byteLength(JSON.stringify(metadata), "utf8");
                metadataTruncated = rawMetadataBytes > MAX_TOOL_RESULT_METADATA_BYTES;
                if (metadataBytes > available || (redacted !== "" && metadataBytes === available)) {
                  metadata = undefined;
                  metadataBytes = 0;
                  metadataTruncated = true;
                }
              }
              const limited = utf8Prefix(redacted, Math.max(0, available - metadataBytes));
              if (
                candidate.type === "result" &&
                redacted !== "" &&
                limited.text === "" &&
                limited.truncated
              ) {
                progressState.saturated = true;
                return;
              }
              const updateBytes = Buffer.byteLength(limited.text, "utf8") + metadataBytes;
              const truncated = candidate.truncated === true || limited.truncated || metadataTruncated || atUpdateLimit;
              const progress: ToolUpdate = candidate.type === "output"
                ? {
                    ...candidate,
                    delta: limited.text,
                    ...(truncated ? { truncated: true } : {}),
                  }
                : {
                    type: "result",
                    content: limited.text,
                    isError: candidate.isError,
                    ...(metadata === undefined ? {} : { metadata }),
                    ...(truncated ? { truncated: true } : {}),
                  };
              const update: ToolInvocationProgress = {
                invocation: item.invocation,
                sequence: progressState.sequence,
                progress,
              };
              progressState.sequence += 1;
              progressState.updates += 1;
              progressState.bytes += updateBytes;
              batchProgressUpdates += 1;
              batchProgressBytes += updateBytes;
              if (limited.truncated || atUpdateLimit) progressState.saturated = true;
              deliverProgress(update, invocationContext);
            } catch {
              // Redactors and malformed extension tools cannot break execution through progress.
            }
          };
          invocationContext = {
            ...context,
            reportProgress,
            toolCallId: item.invocation.callId,
          };
          let result: ToolResult | undefined;
          let authorizationRejected = false;
          try {
            let authorization: ToolAuthorizationDecision | undefined;
            try {
              authorization = coordinator.#interceptor.authorize === undefined
                ? undefined
                : validateToolAuthorizationDecision(await settleWithSignal(
                  context.signal,
                  () => coordinator.#interceptor.authorize!(toolAuthorizationRequest(
                    item.invocation,
                    item.resources,
                    item.backend?.id ?? "local",
                    recovered,
                  ), invocationContext),
                ));
            } catch {
              context.signal.throwIfAborted();
              authorizationRejected = true;
              result = toolError("Tool authorization failed");
            }
            if (result === undefined) {
              if (authorization?.decision === "deny") {
                authorizationRejected = true;
                result = toolError(authorization.reason?.trim() || "Tool execution was not approved by the host");
              } else {
                try {
                  await notifyDispatching(
                    { ...item.invocation, recoveryMode: item.recoveryMode },
                    invocationContext,
                  );
                  context.signal.throwIfAborted();
                  result = item.backend === undefined
                    ? await settleWithSignal(
                      context.signal,
                      () => item.tool.execute(item.invocation.input, invocationContext),
                    )
                    : await settleWithSignal(
                      context.signal,
                      () => item.backend!.execute({
                        invocation: item.invocation,
                        workspace: invocationContext.workspace.root,
                      }, invocationContext),
                    );
                } catch (error) {
                  context.signal.throwIfAborted();
                  result = toolError(
                    `Tool failed: ${errorMessage(error)}`,
                    undefined,
                    ["Use the reported root cause to correct the request; stop if the failure is not safely retryable."],
                  );
                }
              }
            }
          } finally {
            progressState.closed = true;
          }
          if (result === undefined) {
            throw new Error("Tool coordinator did not produce an execution result");
          }
          await settleWithSignal(context.signal, () => progressDelivery);
          result = boundedResult(result, contentBytes, metadataBytes, artifactBytes, imageBytes);
          try {
            if (!authorizationRejected && coordinator.#interceptor.afterResult !== undefined) {
              const executionResult = result;
              result = await settleWithSignal(
                context.signal,
                () => coordinator.#interceptor.afterResult!(item.invocation, executionResult, invocationContext),
              ) ?? executionResult;
            }
          } catch (error) {
            context.signal.throwIfAborted();
            result = toolError(`Tool result interception failed: ${errorMessage(error)}`);
          }
          const completedResult = finalize({
            invocation: item.invocation,
            result,
          });
          await notifyCompleted(completedResult);
          finalized.add(item.invocation.index);
          return completedResult;
    }

    async function runPreparedWaves(): Promise<void> {
      const scheduled = prepared.splice(0);
      for (const wave of executionWaves(scheduled)) {
        const completed = await Promise.all(wave.map(runPrepared));
        for (const result of completed) results.set(result.invocation.index, result);
      }
    }

    await runPreparedWaves();

    const ordered = invocations.map((invocation) => results.get(invocation.index) ?? {
      invocation,
      result: toolError("Internal tool coordinator error: missing result"),
    }).map((entry) => finalized.has(entry.invocation.index) ? entry : finalize(entry));
    for (const entry of ordered) {
      if (!notified.has(entry.invocation.index)) await notifyCompleted(entry);
    }
    return ordered;
    } finally {
      this.#activeBatches -= 1;
    }
  }
}
