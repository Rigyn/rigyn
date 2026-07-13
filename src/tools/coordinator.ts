import { errorMessage } from "../core/errors.js";
import type { ToolUpdate } from "../core/events.js";
import { isJsonValue, type JsonValue } from "../core/json.js";
import type { ImageBlock } from "../core/types.js";
import { MAX_IMAGE_BYTES, normalizeImageSource, requireImageMediaType } from "../providers/images.js";
import { inspectImage, TOOL_IMAGE_MEDIA_TYPES } from "./image-info.js";
import type {
  HarnessTool,
  ResourceClaim,
  ToolContext,
  ToolInvocation,
  ToolInvocationProgress,
  ToolInvocationResult,
  ToolResult,
} from "./types.js";
import { limitText } from "./output.js";
import { ToolRegistry } from "./registry.js";
import type { ToolExecutionBackend } from "./backend.js";

export const MAX_TOOL_INVOCATIONS = 256;
export const MAX_TOOL_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_TOOL_RESULT_CONTENT_BYTES = 256 * 1024;
export const MAX_TOOL_BATCH_CONTENT_BYTES = 768 * 1024;
export const MAX_TOOL_RESULT_METADATA_BYTES = 16 * 1024;
const MAX_TOOL_BATCH_METADATA_BYTES = 128 * 1024;
const MAX_TOOL_ARTIFACTS = 64;
export const MAX_TOOL_RESULT_IMAGES = 4;
export const MAX_TOOL_RESULT_IMAGE_BYTES = MAX_IMAGE_BYTES;
export const MAX_TOOL_PROGRESS_UPDATES = 256;
export const MAX_TOOL_PROGRESS_BYTES = 256 * 1024;
export const MAX_TOOL_BATCH_PROGRESS_UPDATES = 1_024;
export const MAX_TOOL_BATCH_PROGRESS_BYTES = 768 * 1024;

export interface ToolCoordinatorObserver {
  received?(invocation: ToolInvocation, context: ToolContext): Promise<void> | void;
  started?(invocation: ToolInvocation, context: ToolContext): Promise<void> | void;
  progress?(update: ToolInvocationProgress, context: ToolContext): Promise<void> | void;
  completed?(result: ToolInvocationResult, context: ToolContext): Promise<void> | void;
}

export interface ToolCoordinatorInterceptor {
  beforeCall?(
    invocation: ToolInvocation,
    context: ToolContext,
  ): Promise<{ invocation: ToolInvocation; blocked: boolean; reason?: string } | void> |
    { invocation: ToolInvocation; blocked: boolean; reason?: string } | void;
  afterResult?(
    invocation: ToolInvocation,
    result: ToolResult,
    context: ToolContext,
  ): Promise<ToolResult | void> | ToolResult | void;
}

interface Prepared {
  invocation: ToolInvocation;
  tool: HarnessTool;
  backend?: ToolExecutionBackend;
  resources: ResourceClaim[];
  executionMode: "parallel" | "sequential";
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
  let jsonSafe = false;
  try {
    jsonSafe = isJsonValue(value);
  } catch {
    // Cyclic, excessively deep, and hostile getter values are not JSON input.
  }
  if (!jsonSafe) throw new Error(invalidMessage);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(invalidMessage);
  }
  if (serialized === undefined) throw new Error(invalidMessage);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_TOOL_INPUT_BYTES) {
    throw new RangeError(`Tool input exceeds ${MAX_TOOL_INPUT_BYTES} bytes`);
  }
  try {
    const snapshot: unknown = JSON.parse(serialized);
    if (!isJsonValue(snapshot)) throw new Error(invalidMessage);
    return snapshot;
  } catch (error) {
    if (error instanceof Error && error.message === invalidMessage) throw error;
    throw new Error(invalidMessage);
  }
}

function boundedMetadata(value: JsonValue | undefined, maxBytes: number): JsonValue | undefined {
  if (value === undefined) return undefined;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { truncated: true, invalid: true };
  }
  if (serialized === undefined) return { truncated: true, invalid: true };
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maxBytes) return { truncated: true, originalBytes: bytes };
  return JSON.parse(serialized) as JsonValue;
}

function boundedImages(value: unknown): { images?: ImageBlock[]; invalid: boolean } {
  if (value === undefined) return { invalid: false };
  if (!Array.isArray(value) || value.length > MAX_TOOL_RESULT_IMAGES) return { invalid: true };
  const images: ImageBlock[] = [];
  let totalBytes = 0;
  try {
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
      if (totalBytes > MAX_TOOL_RESULT_IMAGE_BYTES) return { invalid: true };
      images.push({ type: "image", mediaType: source.mediaType, data: source.data });
    }
  } catch {
    return { invalid: true };
  }
  return images.length === 0 ? { invalid: false } : { images, invalid: false };
}

function boundedResult(result: unknown, contentBytes: number, metadataBytes: number): ToolResult {
  const value = result !== null && typeof result === "object" ? result as Partial<ToolResult> : {};
  const validContent = typeof value.content === "string";
  const boundedImageResult = boundedImages(value.images);
  const limited = limitText(
    boundedImageResult.invalid
      ? "Tool returned invalid image content"
      : validContent ? value.content as string : "Tool returned invalid non-string content",
    contentBytes,
  );
  const metadata = boundedMetadata(value.metadata, metadataBytes);
  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts.filter((entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        typeof entry.path === "string" &&
        typeof entry.mediaType === "string" &&
        typeof entry.bytes === "number" &&
        Number.isSafeInteger(entry.bytes) &&
        entry.bytes >= 0
      ).slice(0, MAX_TOOL_ARTIFACTS)
    : undefined;
  const isError = !validContent || boundedImageResult.invalid || typeof value.isError !== "boolean" ? true : value.isError;
  const status = isError
    ? "error" as const
    : value.status === "warning" ? "warning" as const : "success" as const;
  const defaultSummary = limited.text.trim().split("\n", 1)[0] || (isError ? "Tool failed" : "Tool completed");
  const summary = utf8Prefix(typeof value.summary === "string" && value.summary.trim() !== "" ? value.summary.trim() : defaultSummary, 1024).text;
  const nextActions = Array.isArray(value.nextActions)
    ? value.nextActions
      .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      .slice(0, 8)
      .map((entry) => utf8Prefix(entry.trim(), 1024).text)
    : [];
  return {
    content: limited.text,
    isError,
    status,
    summary,
    ...(nextActions.length === 0 ? {} : { nextActions }),
    ...(typeof value.terminate === "boolean" ? { terminate: value.terminate } : {}),
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
      (progress["metadata"] === undefined || isJsonValue(progress["metadata"])) &&
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
  const normalizedLeft = left.replaceAll("\\", "/").replace(/\/$/u, "");
  const normalizedRight = right.replaceAll("\\", "/").replace(/\/$/u, "");
  return normalizedLeft === normalizedRight || normalizedLeft.startsWith(`${normalizedRight}/`) || normalizedRight.startsWith(`${normalizedLeft}/`);
}

export function resourcesConflict(left: ResourceClaim[], right: ResourceClaim[]): boolean {
  return left.some((one) => right.some((two) => {
    if (one.kind !== two.kind && one.kind !== "workspace" && two.kind !== "workspace") return false;
    if (one.mode === "read" && two.mode === "read") return false;
    return pathOverlaps(one.key, two.key);
  }));
}

function parallelWaves(prepared: Prepared[]): Prepared[][] {
  const remaining = [...prepared];
  const result: Prepared[][] = [];
  while (remaining.length > 0) {
    const wave: Prepared[] = [];
    for (let index = 0; index < remaining.length;) {
      const candidate = remaining[index];
      if (candidate !== undefined && wave.every((entry) => !resourcesConflict(entry.resources, candidate.resources))) {
        wave.push(candidate);
        remaining.splice(index, 1);
      } else {
        index += 1;
      }
    }
    result.push(wave);
  }
  return result;
}

function waves(prepared: Prepared[]): Prepared[][] {
  const result: Prepared[][] = [];
  let parallel: Prepared[] = [];
  const flushParallel = (): void => {
    result.push(...parallelWaves(parallel));
    parallel = [];
  };
  for (const item of prepared) {
    if (item.executionMode === "sequential") {
      flushParallel();
      result.push([item]);
    } else {
      parallel.push(item);
    }
  }
  flushParallel();
  return result;
}

export class ToolCoordinator {
  readonly #registry: ToolRegistry;
  readonly #observer: ToolCoordinatorObserver;
  readonly #redact: ((value: string) => string) | undefined;
  readonly #redactValue: ((value: JsonValue) => JsonValue) | undefined;
  readonly #interceptor: ToolCoordinatorInterceptor;
  readonly #availableNames: Set<string>;
  readonly #requiredNames: Set<string>;
  #activeNames: Set<string>;
  #pendingNames: Set<string> | undefined;
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
    return [...this.#availableNames].sort();
  }

  activeToolNames(): string[] {
    return [...(this.#pendingNames ?? this.#activeNames)];
  }

  appliedToolNames(): string[] {
    return [...this.#activeNames];
  }

  queueActiveTools(names: readonly string[]): string[] {
    this.#pendingNames = selectedToolNames(names, this.#availableNames, this.#requiredNames);
    return this.activeToolNames();
  }

  turnSnapshot(): ToolTurnSnapshot {
    if (this.#activeBatches !== 0) throw new Error("Cannot apply active tools while a tool batch is executing");
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
  ): Promise<ToolInvocationResult[]> {
    if (invocations.length > MAX_TOOL_INVOCATIONS) {
      throw new RangeError(`A tool batch cannot exceed ${MAX_TOOL_INVOCATIONS} invocations`);
    }
    this.#activeBatches += 1;
    try {
    const count = Math.max(1, invocations.length);
    const contentBytes = Math.min(MAX_TOOL_RESULT_CONTENT_BYTES, Math.floor(MAX_TOOL_BATCH_CONTENT_BYTES / count));
    const metadataBytes = Math.min(MAX_TOOL_RESULT_METADATA_BYTES, Math.floor(MAX_TOOL_BATCH_METADATA_BYTES / count));
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
      const raw: unknown = entry.result;
      const value = raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Partial<ToolResult>
        : undefined;
      const candidate = value === undefined
        ? raw
        : {
            ...value,
            ...(typeof value.content !== "string"
              ? {}
              : { content: this.#redact?.(value.content) ?? value.content }),
            ...(value.metadata === undefined || !isJsonValue(value.metadata)
              ? {}
              : { metadata: this.#redactValue?.(value.metadata) ?? value.metadata }),
          };
      return { ...entry, result: boundedResult(candidate, contentBytes, metadataBytes) };
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

    for (const invocation of invocations) {
      if (duplicateCallIds.has(invocation.callId)) {
        await notifyReceived(invocation);
        results.set(invocation.index, { invocation, result: toolError(`Duplicate tool call ID: ${invocation.callId}`) });
        continue;
      }
      const tool = this.#activeNames.has(invocation.name) ? this.#registry.get(invocation.name) : undefined;
      if (tool === undefined) {
        await notifyReceived(invocation);
        results.set(invocation.index, {
          invocation,
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
      let effective: ToolInvocation = {
        callId: invocation.callId,
        name: invocation.name,
        input: null,
        index: invocation.index,
      };
      let received = false;
      let receiving = false;
      const receive = async (value: ToolInvocation): Promise<void> => {
        receiving = true;
        await notifyReceived(value);
        receiving = false;
        received = true;
      };
      try {
        const baselineInput = snapshotToolInput(invocation.input, "Tool invocation contains non-JSON input");
        effective = { ...effective, input: baselineInput };
        const preparedInput = tool.prepareInput === undefined
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
            tool.prepareInput === undefined
              ? "Tool invocation contains non-JSON input"
              : "Tool input preparation returned non-JSON input",
          ),
          index: invocation.index,
        };
        tool.validate(effective.input);
        const reduction = this.#interceptor.beforeCall === undefined
          ? undefined
          : await settleWithSignal(
            context.signal,
            () => this.#interceptor.beforeCall!(effective, context),
          );
        let blockedReason: string | undefined;
        let blocked = false;
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
          if (reduction.blocked) {
            blocked = true;
            blockedReason = reduction.reason;
          }
        }
        // Extensions may mutate a previously valid input. Revalidate the final
        // value before durable observation, policy evaluation, or execution.
        tool.validate(effective.input);
        await receive(effective);
        if (blocked) {
          results.set(effective.index, {
            invocation: effective,
            result: toolError(blockedReason ?? "Tool blocked by runtime extension"),
          });
          continue;
        }
        const backend = context.backend?.handles(effective.name) === true ? context.backend : undefined;
        const request = { invocation: effective, workspace: context.workspace.root };
        const resources = backend === undefined
          ? await settleWithSignal(context.signal, () => tool.resources(effective.input, context))
          : await settleWithSignal(context.signal, () => backend.resources(request, context));
        prepared.push({
          invocation: effective,
          tool,
          ...(backend === undefined ? {} : { backend }),
          resources,
          executionMode: tool.executionMode ?? "parallel",
        });
      } catch (error) {
        context.signal.throwIfAborted();
        if (receiving) throw error;
        if (!received) await receive(effective);
        results.set(effective.index, {
          invocation: effective,
          result: toolError(
            `Invalid tool request: ${errorMessage(error)}`,
            undefined,
            [`Correct the arguments to match the ${effective.name} schema, then retry once.`],
          ),
        });
      }
    }

    for (const wave of waves(prepared)) {
      const completed = await Promise.all(wave.map(async (item): Promise<ToolInvocationResult> => {
        if (context.signal.aborted) {
          return { invocation: item.invocation, result: toolError("Tool cancelled before execution") };
        }
        const run = async (): Promise<ToolInvocationResult> => {
          if (this.#observer.started !== undefined) {
            await settleWithSignal(context.signal, () => this.#observer.started!(item.invocation, context));
          }
          if (observer.started !== undefined) {
            await settleWithSignal(context.signal, () => observer.started!(item.invocation, context));
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
          let invocationContext!: ToolContext;
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
              const redacted = this.#redact?.(sourceText) ?? sourceText;
              let metadata: JsonValue | undefined;
              let metadataBytes = 0;
              let metadataTruncated = false;
              if (candidate.type === "result" && candidate.metadata !== undefined) {
                const redactedMetadata = this.#redactValue?.(candidate.metadata) ?? candidate.metadata;
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
          invocationContext = { ...context, reportProgress };
          let result: ToolResult;
          try {
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
          } finally {
            progressState.closed = true;
          }
          await settleWithSignal(context.signal, () => progressDelivery);
          result = boundedResult(result, contentBytes, metadataBytes);
          try {
            if (this.#interceptor.afterResult !== undefined) {
              result = await settleWithSignal(
                context.signal,
                () => this.#interceptor.afterResult!(item.invocation, result, invocationContext),
              ) ?? result;
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
        };
        return await run();
      }));
      for (const result of completed) results.set(result.invocation.index, result);
    }

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
