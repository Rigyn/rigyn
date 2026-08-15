import { ASSISTANT_CONTENT_LIMITS } from "@rigyn/kernel/runtime/core/assistant-content-limits";
import { adapterEventType, snapshotAdapterEvent } from "@rigyn/kernel/runtime/core/adapter-event";
import { boundedJsonSnapshot } from "@rigyn/kernel/runtime/core/bounded-json";

import { defaultSecretRedactor } from "../auth/redaction.js";
import {
  MAX_TOOL_CALL_STREAM_DELTA_BYTES,
  MAX_TOOL_CALL_STREAM_ID_BYTES,
  MAX_TOOL_CALL_STREAM_NAME_BYTES,
} from "../core/events.js";
import { isJsonValue, type JsonValue } from "../core/json.js";
import {
  validateProviderAdapterError,
  validateProviderResponseDiagnostics,
} from "../core/provider-diagnostics.js";
import { validatedAssistantContent } from "../core/public-assistant-content.js";
import type {
  AdapterError,
  AdapterEvent,
  AssistantContentBlock,
  FinishReason,
  NormalizedUsage,
  ProviderId,
  ProviderResponseDiagnostics,
  ProviderResponseFailureMetadata,
} from "../core/types.js";
import { isNormalizedUsage } from "../core/usage.js";
import { parseJsonWithRepair, parseStreamingJson } from "./streaming-json.js";

const MAX_PROVIDER_ID_BYTES = 128;
const MAX_MODEL_ID_BYTES = 1_024;
const MAX_RESPONSE_ID_BYTES = 4_096;
const MAX_PROVIDER_METADATA_BYTES = 4_096;
const MAX_PROVIDER_STREAM_TOOL_CALLS = 256;

export type ProviderStreamUsage = Omit<NormalizedUsage, "raw">;

export interface ProviderStreamToolCall {
  index: number;
  id?: string;
  name?: string;
  rawArguments: string;
  /** Best-effort JSON while streaming; callers must tolerate missing fields. */
  arguments?: JsonValue;
  /** Present only on a completed call whose provider reported a parse failure. */
  parseError?: string;
  thoughtSignature?: string;
}

export type ProviderStreamErrorMetadata = ProviderResponseFailureMetadata & {
  diagnostics?: ProviderResponseDiagnostics;
};

export type ProviderStreamProjectionEvent =
  | {
      type: "response_start";
      model: string;
      responseId?: string;
      requestId?: string;
      diagnostics?: ProviderResponseDiagnostics;
    }
  | { type: "text_start"; part: number }
  | { type: "text_delta"; part: number; delta: string }
  | { type: "text_end"; part: number; content: string; contentSignature?: string }
  | { type: "reasoning_start"; part: number; visibility: "summary" | "provider_trace" }
  | {
      type: "reasoning_delta";
      part: number;
      delta: string;
      visibility: "summary" | "provider_trace";
    }
  | {
      type: "reasoning_end";
      part: number;
      content: string;
      visibility: "summary" | "provider_trace";
      contentSignature?: string;
      redacted?: boolean;
    }
  | { type: "tool_call_start"; index: number; partial: ProviderStreamToolCall }
  | {
      type: "tool_call_delta";
      index: number;
      delta: string;
      partial: ProviderStreamToolCall;
    }
  | { type: "tool_call_end"; index: number; toolCall: ProviderStreamToolCall }
  | {
      type: "usage";
      usage: ProviderStreamUsage;
      semantics: "incremental" | "cumulative" | "final";
    }
  | {
      type: "response_end";
      reason: FinishReason;
      content?: AssistantContentBlock[];
      assistantDiagnostics?: Extract<AdapterEvent, { type: "response_end" }>["assistantDiagnostics"];
      rawReason?: string;
      explanation?: string;
    }
  | { type: "error"; error: ProviderStreamErrorMetadata };

/** Serializable, transport-private projection of one normalized provider stream event. */
export interface ProviderStreamEnvelope {
  schemaVersion: 1;
  provider: ProviderId;
  /** Monotonic within one projector; omitted provider-private events do not consume a sequence. */
  sequence: number;
  event: ProviderStreamProjectionEvent;
}

interface PartialToolCall {
  id?: string;
  name?: string;
  rawArguments: string;
  rawBytes: number;
  retainedBytes: number;
  nextParseBytes: number;
}

const FINISH_REASONS = new Set<FinishReason>([
  "stop",
  "tool_calls",
  "length",
  "context_limit",
  "content_filter",
  "refusal",
  "pause",
  "cancelled",
  "aborted",
  "error",
  "incomplete",
  "unknown",
]);

function boundedText(value: string, label: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value === "")) throw new TypeError(`${label} must be a string`);
  const redacted = defaultSecretRedactor.redact(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  const encoded = Buffer.from(redacted, "utf8");
  if (encoded.byteLength <= maxBytes) return redacted;
  return encoded.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
}

function exactText(value: string, label: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value === "")) throw new TypeError(`${label} must be a string`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new RangeError(`${label} exceeds its byte limit`);
  return value;
}

function identityText(value: string, label: string, maxBytes: number): string {
  const result = exactText(value, label, maxBytes);
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(result)) throw new TypeError(`${label} contains control characters`);
  return result;
}

function index(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return value;
}

function optionalJson(
  value: JsonValue | undefined,
  label: string,
  maximumBytes: number,
): JsonValue | undefined {
  if (value === undefined) return undefined;
  return boundedJsonSnapshot(value, {
    label,
    maximumBytes,
    maximumValues: ASSISTANT_CONTENT_LIMITS.argumentValues,
    maximumContainers: ASSISTANT_CONTENT_LIMITS.containers,
    maximumDepth: ASSISTANT_CONTENT_LIMITS.argumentDepth,
  }).value;
}

function partialArguments(rawArguments: string): JsonValue | undefined {
  if (rawArguments === "") return undefined;
  const value: unknown = parseStreamingJson(rawArguments);
  if (!isJsonValue(value)) return undefined;
  try {
    return optionalJson(
      value,
      "Provider stream partial tool call arguments",
      MAX_TOOL_CALL_STREAM_DELTA_BYTES,
    );
  } catch {
    return undefined;
  }
}

function completeArguments(rawArguments: string): JsonValue | undefined {
  if (rawArguments === "") return undefined;
  let value: unknown;
  try {
    value = parseJsonWithRepair(rawArguments);
  } catch {
    return undefined;
  }
  return isJsonValue(value)
    ? optionalJson(value, "Provider stream tool call arguments", MAX_TOOL_CALL_STREAM_DELTA_BYTES)
    : undefined;
}

function publicUsage(value: NormalizedUsage): ProviderStreamUsage {
  if (!isNormalizedUsage(value)) throw new TypeError("Provider stream emitted invalid normalized usage");
  const { raw: _raw, ...usage } = value;
  return structuredClone(usage);
}

function publicDiagnostics(value: ProviderResponseDiagnostics | undefined): ProviderResponseDiagnostics | undefined {
  if (value === undefined) return undefined;
  return validateProviderResponseDiagnostics(value);
}

function publicError(value: AdapterError): ProviderStreamErrorMetadata {
  const selected = validateProviderAdapterError(value);
  const diagnostics = publicDiagnostics(selected.diagnostics);
  return {
    category: selected.category,
    message: boundedText(selected.message, "Provider stream error message", MAX_PROVIDER_METADATA_BYTES),
    retryable: selected.retryable,
    partial: selected.partial,
    ...(selected.httpStatus === undefined ? {} : { httpStatus: selected.httpStatus }),
    ...(selected.providerCode === undefined
      ? {}
      : { providerCode: boundedText(selected.providerCode, "Provider stream error code", MAX_PROVIDER_METADATA_BYTES) }),
    ...(selected.requestId === undefined
      ? {}
      : { requestId: boundedText(selected.requestId, "Provider stream request ID", MAX_RESPONSE_ID_BYTES) }),
    ...(selected.retryAfterMs === undefined ? {} : { retryAfterMs: selected.retryAfterMs }),
    ...(selected.bodyStarted === undefined ? {} : { bodyStarted: selected.bodyStarted }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

function toolCall(indexValue: number, value: PartialToolCall, argumentsValue?: JsonValue, parseError?: string): ProviderStreamToolCall {
  return {
    index: indexValue,
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.name === undefined ? {} : { name: value.name }),
    rawArguments: value.rawArguments,
    ...(argumentsValue === undefined ? {} : { arguments: structuredClone(argumentsValue) }),
    ...(parseError === undefined ? {} : { parseError }),
  };
}

function partialToolCall(
  rawArguments: string,
  rawBytes: number,
  id?: string,
  name?: string,
  nextParseBytes = 1,
): PartialToolCall {
  return {
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    rawArguments,
    rawBytes,
    retainedBytes: rawBytes
      + Buffer.byteLength(id ?? "", "utf8")
      + Buffer.byteLength(name ?? "", "utf8"),
    nextParseBytes,
  };
}

function nextParseCheckpoint(currentBytes: number): number {
  let checkpoint = 1;
  while (checkpoint <= currentBytes) checkpoint *= 2;
  return checkpoint;
}

/**
 * Projects provider-neutral adapter events into a stable public stream without
 * continuation state, opaque provider events, raw usage, raw errors, or unknown headers.
 */
export class ProviderStreamProjector {
  readonly #provider: ProviderId;
  readonly #calls = new Map<number, PartialToolCall>();
  readonly #completedCalls = new Set<number>();
  #retainedCallBytes = 0;
  #sequence = 0;

  constructor(provider: ProviderId) {
    this.#provider = identityText(provider, "Provider stream provider", MAX_PROVIDER_ID_BYTES) as ProviderId;
  }

  project(value: AdapterEvent): ProviderStreamEnvelope | undefined {
    const type = adapterEventType(value);
    try {
      if (type === "response_end" && this.#calls.size > 0) {
        throw new TypeError("Provider stream emitted response_end before tool_call_end");
      }
      const event = this.#event(snapshotAdapterEvent(value));
      if (event === undefined) return undefined;
      this.#sequence += 1;
      return { schemaVersion: 1, provider: this.#provider, sequence: this.#sequence, event };
    } catch (cause) {
      if (type === "response_start" || type === "response_end" || type === "error") {
        this.#resetToolCalls();
      }
      throw cause;
    }
  }

  #assertToolCallCapacity(callIndex: number): void {
    if (
      !this.#calls.has(callIndex) &&
      !this.#completedCalls.has(callIndex) &&
      this.#calls.size + this.#completedCalls.size >= MAX_PROVIDER_STREAM_TOOL_CALLS
    ) {
      throw new RangeError(`Provider stream returned more than ${MAX_PROVIDER_STREAM_TOOL_CALLS} tool calls`);
    }
  }

  #nextRetainedCallBytes(callIndex: number, next: PartialToolCall): number {
    const previous = this.#calls.get(callIndex);
    const retainedCallBytes = this.#retainedCallBytes - (previous?.retainedBytes ?? 0) + next.retainedBytes;
    if (retainedCallBytes > ASSISTANT_CONTENT_LIMITS.contentBytes) {
      throw new RangeError(
        `Provider stream tool call state exceeds ${ASSISTANT_CONTENT_LIMITS.contentBytes} aggregate bytes`,
      );
    }
    return retainedCallBytes;
  }

  #setActiveToolCall(callIndex: number, next: PartialToolCall, retainedCallBytes: number): void {
    this.#calls.set(callIndex, next);
    this.#retainedCallBytes = retainedCallBytes;
  }

  #completeToolCall(callIndex: number): void {
    const previous = this.#calls.get(callIndex);
    if (previous !== undefined) {
      this.#calls.delete(callIndex);
      this.#retainedCallBytes -= previous.retainedBytes;
    }
    this.#completedCalls.add(callIndex);
  }

  #resetToolCalls(): void {
    this.#calls.clear();
    this.#completedCalls.clear();
    this.#retainedCallBytes = 0;
  }

  #event(value: AdapterEvent): ProviderStreamProjectionEvent | undefined {
    switch (value.type) {
      case "response_start": {
        try {
          const diagnostics = publicDiagnostics(value.diagnostics);
          return {
            type: "response_start",
            model: identityText(value.model, "Provider stream model", MAX_MODEL_ID_BYTES),
            ...(value.responseId === undefined
              ? {}
              : { responseId: boundedText(value.responseId, "Provider stream response ID", MAX_RESPONSE_ID_BYTES) }),
            ...(value.requestId === undefined
              ? {}
              : { requestId: boundedText(value.requestId, "Provider stream request ID", MAX_RESPONSE_ID_BYTES) }),
            ...(diagnostics === undefined ? {} : { diagnostics }),
          };
        } finally {
          this.#resetToolCalls();
        }
      }
      case "text_delta":
        return {
          type: "text_delta",
          part: index(value.part, "Provider stream text part"),
          delta: exactText(
            value.text,
            "Provider stream text delta",
            MAX_TOOL_CALL_STREAM_DELTA_BYTES,
            true,
          ),
        };
      case "text_start":
        return { type: "text_start", part: index(value.part, "Provider stream text part") };
      case "text_end":
        return {
          type: "text_end",
          part: index(value.part, "Provider stream text part"),
          content: exactText(value.text, "Provider stream text content", MAX_TOOL_CALL_STREAM_DELTA_BYTES, true),
          ...(value.textSignature === undefined
            ? {}
            : { contentSignature: exactText(value.textSignature, "Provider stream text signature", MAX_TOOL_CALL_STREAM_DELTA_BYTES, true) }),
        };
      case "reasoning_start":
        if (value.visibility !== "summary" && value.visibility !== "provider_trace") {
          throw new TypeError("Provider stream reasoning visibility is invalid");
        }
        return {
          type: "reasoning_start",
          part: index(value.part, "Provider stream reasoning part"),
          visibility: value.visibility,
        };
      case "reasoning_delta":
        if (value.visibility !== "summary" && value.visibility !== "provider_trace") {
          throw new TypeError("Provider stream reasoning visibility is invalid");
        }
        return {
          type: "reasoning_delta",
          part: index(value.part, "Provider stream reasoning part"),
          delta: exactText(
            value.text,
            "Provider stream reasoning delta",
            MAX_TOOL_CALL_STREAM_DELTA_BYTES,
            true,
          ),
          visibility: value.visibility,
        };
      case "reasoning_end":
        if (value.visibility !== "summary" && value.visibility !== "provider_trace") {
          throw new TypeError("Provider stream reasoning visibility is invalid");
        }
        return {
          type: "reasoning_end",
          part: index(value.part, "Provider stream reasoning part"),
          content: exactText(value.text, "Provider stream reasoning content", MAX_TOOL_CALL_STREAM_DELTA_BYTES, true),
          visibility: value.visibility,
          ...(value.thinkingSignature === undefined
            ? {}
            : { contentSignature: exactText(value.thinkingSignature, "Provider stream reasoning signature", MAX_TOOL_CALL_STREAM_DELTA_BYTES, true) }),
          ...(value.redacted === undefined ? {} : { redacted: value.redacted }),
        };
      case "tool_call_start": {
        const callIndex = index(value.index, "Provider stream tool call index");
        this.#assertToolCallCapacity(callIndex);
        if (this.#calls.has(callIndex) || this.#completedCalls.has(callIndex)) {
          throw new TypeError(`Provider stream emitted more than one tool_call_start for index ${callIndex}`);
        }
        const id = value.id === undefined
          ? undefined
          : identityText(value.id, "Provider stream tool call ID", MAX_TOOL_CALL_STREAM_ID_BYTES);
        const name = value.name === undefined
          ? undefined
          : identityText(value.name, "Provider stream tool call name", MAX_TOOL_CALL_STREAM_NAME_BYTES);
        const current = partialToolCall("", 0, id, name);
        const retainedCallBytes = this.#nextRetainedCallBytes(callIndex, current);
        const projected: ProviderStreamProjectionEvent = {
          type: "tool_call_start",
          index: callIndex,
          partial: toolCall(callIndex, current),
        };
        this.#setActiveToolCall(callIndex, current, retainedCallBytes);
        return projected;
      }
      case "tool_call_delta": {
        const callIndex = index(value.index, "Provider stream tool call index");
        this.#assertToolCallCapacity(callIndex);
        if (this.#completedCalls.has(callIndex)) {
          throw new TypeError(`Provider stream emitted tool_call_delta after tool_call_end for index ${callIndex}`);
        }
        const delta = exactText(
          value.jsonFragment,
          "Provider stream tool call delta",
          MAX_TOOL_CALL_STREAM_DELTA_BYTES,
          true,
        );
        const previous = this.#calls.get(callIndex);
        const rawBytes = (previous?.rawBytes ?? 0) + Buffer.byteLength(delta, "utf8");
        if (rawBytes > MAX_TOOL_CALL_STREAM_DELTA_BYTES) {
          throw new RangeError("Provider stream tool call arguments exceed their byte limit");
        }
        const rawArguments = `${previous?.rawArguments ?? ""}${delta}`;
        const parseArguments = rawBytes >= (previous?.nextParseBytes ?? 1);
        const current = partialToolCall(
          rawArguments,
          rawBytes,
          previous?.id,
          previous?.name,
          parseArguments ? nextParseCheckpoint(rawBytes) : previous?.nextParseBytes,
        );
        const retainedCallBytes = this.#nextRetainedCallBytes(callIndex, current);
        const projected: ProviderStreamProjectionEvent = {
          type: "tool_call_delta",
          index: callIndex,
          delta,
          partial: toolCall(
            callIndex,
            current,
            parseArguments ? partialArguments(rawArguments) : undefined,
          ),
        };
        this.#setActiveToolCall(callIndex, current, retainedCallBytes);
        return projected;
      }
      case "tool_call_end": {
        const callIndex = index(value.index, "Provider stream tool call index");
        this.#assertToolCallCapacity(callIndex);
        if (this.#completedCalls.has(callIndex)) {
          throw new TypeError(`Provider stream emitted more than one tool_call_end for index ${callIndex}`);
        }
        const id = value.id === undefined
          ? this.#calls.get(callIndex)?.id
          : identityText(value.id, "Provider stream tool call ID", MAX_TOOL_CALL_STREAM_ID_BYTES);
        const name = identityText(value.name, "Provider stream tool call name", MAX_TOOL_CALL_STREAM_NAME_BYTES);
        const rawArguments = exactText(
          value.rawArguments,
          "Provider stream tool call arguments",
          MAX_TOOL_CALL_STREAM_DELTA_BYTES,
          true,
        );
        const current = partialToolCall(
          rawArguments,
          Buffer.byteLength(rawArguments, "utf8"),
          id,
          name,
        );
        const argumentsValue = value.arguments !== undefined
          ? optionalJson(
              value.arguments,
              "Provider stream tool call arguments",
              MAX_TOOL_CALL_STREAM_DELTA_BYTES,
            )
          : value.parseError === undefined
            ? completeArguments(current.rawArguments)
            : undefined;
        const parseError = value.parseError === undefined
          ? undefined
          : boundedText(value.parseError, "Provider stream tool call parse error", MAX_PROVIDER_METADATA_BYTES);
        const projected: ProviderStreamProjectionEvent = {
          type: "tool_call_end",
          index: callIndex,
          toolCall: {
            ...toolCall(callIndex, current, argumentsValue, parseError),
            ...(value.thoughtSignature === undefined
              ? {}
              : { thoughtSignature: exactText(value.thoughtSignature, "Provider stream tool-call signature", MAX_TOOL_CALL_STREAM_DELTA_BYTES, true) }),
          },
        };
        this.#completeToolCall(callIndex);
        return projected;
      }
      case "usage":
        if (value.semantics !== "incremental" && value.semantics !== "cumulative" && value.semantics !== "final") {
          throw new TypeError("Provider stream usage semantics are invalid");
        }
        return { type: "usage", usage: publicUsage(value.usage), semantics: value.semantics };
      case "unknown_provider_event":
        return undefined;
      case "response_end": {
        try {
          if (this.#calls.size > 0) {
            throw new TypeError("Provider stream emitted response_end before tool_call_end");
          }
          if (!FINISH_REASONS.has(value.reason)) throw new TypeError("Provider stream finish reason is invalid");
          const content = value.content === undefined ? undefined : validatedAssistantContent(value.content);
          const assistantDiagnostics = value.assistantDiagnostics;
          if (content !== undefined && content.filter((block) => block.type === "tool_call").length
            > MAX_PROVIDER_STREAM_TOOL_CALLS) {
            throw new RangeError(
              `Provider stream returned more than ${MAX_PROVIDER_STREAM_TOOL_CALLS} terminal tool calls`,
            );
          }
          return {
            type: "response_end",
            reason: value.reason,
            ...(content === undefined ? {} : { content }),
            ...(assistantDiagnostics === undefined ? {} : { assistantDiagnostics }),
            ...(value.rawReason === undefined
              ? {}
              : { rawReason: boundedText(value.rawReason, "Provider stream raw reason", MAX_PROVIDER_METADATA_BYTES) }),
            ...(value.explanation === undefined
              ? {}
              : { explanation: boundedText(value.explanation, "Provider stream explanation", MAX_PROVIDER_METADATA_BYTES) }),
          };
        } finally {
          this.#resetToolCalls();
        }
      }
      case "error": {
        try {
          return { type: "error", error: publicError(value.error) };
        } finally {
          this.#resetToolCalls();
        }
      }
    }
  }
}

/** Lazily projects an adapter stream while preserving source ordering and cancellation behavior. */
export async function* projectProviderStream(
  provider: ProviderId,
  source: AsyncIterable<AdapterEvent>,
): AsyncIterable<ProviderStreamEnvelope> {
  const projector = new ProviderStreamProjector(provider);
  for await (const value of source) {
    const projected = projector.project(value);
    if (projected !== undefined) yield projected;
  }
}
