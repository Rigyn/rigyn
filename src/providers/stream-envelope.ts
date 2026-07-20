import { defaultSecretRedactor } from "../auth/redaction.js";
import {
  MAX_TOOL_CALL_STREAM_DELTA_BYTES,
  MAX_TOOL_CALL_STREAM_ID_BYTES,
  MAX_TOOL_CALL_STREAM_NAME_BYTES,
} from "../core/events.js";
import { isJsonValue, type JsonValue } from "../core/json.js";
import { validateProviderResponseDiagnostics } from "../core/provider-diagnostics.js";
import type {
  AdapterError,
  AdapterEvent,
  FinishReason,
  NormalizedUsage,
  ProviderId,
  ProviderResponseDiagnostics,
  ProviderResponseFailureMetadata,
} from "../core/types.js";
import { isNormalizedUsage } from "../core/usage.js";
import { parse } from "jsonc-parser";

const MAX_PROVIDER_ID_BYTES = 128;
const MAX_MODEL_ID_BYTES = 1_024;
const MAX_RESPONSE_ID_BYTES = 4_096;
const MAX_PROVIDER_METADATA_BYTES = 4_096;

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
  | { type: "text_delta"; part: number; delta: string }
  | {
      type: "reasoning_delta";
      part: number;
      delta: string;
      visibility: "summary" | "provider_trace";
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
}

const ERROR_CATEGORIES = new Set<AdapterError["category"]>([
  "authentication",
  "permission",
  "rate_limit",
  "invalid_request",
  "not_found",
  "overloaded",
  "network",
  "timeout",
  "protocol",
  "cancelled",
  "provider",
]);

const FINISH_REASONS = new Set<FinishReason>([
  "stop",
  "tool_calls",
  "length",
  "context_limit",
  "content_filter",
  "refusal",
  "pause",
  "cancelled",
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

function optionalJson(value: JsonValue | undefined, label: string): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (!isJsonValue(value)) throw new TypeError(`${label} must be JSON`);
  return structuredClone(value);
}

function partialArguments(rawArguments: string): JsonValue | undefined {
  if (rawArguments === "") return undefined;
  const value: unknown = parse(rawArguments, [], { allowTrailingComma: false, disallowComments: true });
  return isJsonValue(value) ? structuredClone(value) : undefined;
}

function completeArguments(rawArguments: string): JsonValue | undefined {
  if (rawArguments === "") return undefined;
  try {
    const value: unknown = JSON.parse(rawArguments);
    return isJsonValue(value) ? structuredClone(value) : undefined;
  } catch {
    return undefined;
  }
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
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Provider stream error must be an object");
  }
  if (!ERROR_CATEGORIES.has(value.category)) throw new TypeError("Provider stream error category is invalid");
  if (typeof value.retryable !== "boolean" || typeof value.partial !== "boolean") {
    throw new TypeError("Provider stream error flags must be booleans");
  }
  if (value.httpStatus !== undefined && (
    !Number.isSafeInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599
  )) throw new TypeError("Provider stream error HTTP status is invalid");
  if (value.retryAfterMs !== undefined && (!Number.isSafeInteger(value.retryAfterMs) || value.retryAfterMs < 0)) {
    throw new TypeError("Provider stream error retry delay is invalid");
  }
  if (value.bodyStarted !== undefined && typeof value.bodyStarted !== "boolean") {
    throw new TypeError("Provider stream error bodyStarted flag is invalid");
  }
  const diagnostics = publicDiagnostics(value.diagnostics);
  return {
    category: value.category,
    message: boundedText(value.message, "Provider stream error message", MAX_PROVIDER_METADATA_BYTES),
    retryable: value.retryable,
    partial: value.partial,
    ...(value.httpStatus === undefined ? {} : { httpStatus: value.httpStatus }),
    ...(value.providerCode === undefined
      ? {}
      : { providerCode: boundedText(value.providerCode, "Provider stream error code", MAX_PROVIDER_METADATA_BYTES) }),
    ...(value.requestId === undefined
      ? {}
      : { requestId: boundedText(value.requestId, "Provider stream request ID", MAX_RESPONSE_ID_BYTES) }),
    ...(value.retryAfterMs === undefined ? {} : { retryAfterMs: value.retryAfterMs }),
    ...(value.bodyStarted === undefined ? {} : { bodyStarted: value.bodyStarted }),
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

/**
 * Projects provider-neutral adapter events into a stable public stream without
 * continuation state, opaque provider events, raw usage, raw errors, or unknown headers.
 */
export class ProviderStreamProjector {
  readonly #provider: ProviderId;
  readonly #calls = new Map<number, PartialToolCall>();
  #sequence = 0;

  constructor(provider: ProviderId) {
    this.#provider = identityText(provider, "Provider stream provider", MAX_PROVIDER_ID_BYTES) as ProviderId;
  }

  project(value: AdapterEvent): ProviderStreamEnvelope | undefined {
    const event = this.#event(value);
    if (event === undefined) return undefined;
    this.#sequence += 1;
    return { schemaVersion: 1, provider: this.#provider, sequence: this.#sequence, event };
  }

  #event(value: AdapterEvent): ProviderStreamProjectionEvent | undefined {
    switch (value.type) {
      case "response_start": {
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
      }
      case "text_delta":
        return { type: "text_delta", part: index(value.part, "Provider stream text part"), delta: value.text };
      case "reasoning_delta":
        if (value.visibility !== "summary" && value.visibility !== "provider_trace") {
          throw new TypeError("Provider stream reasoning visibility is invalid");
        }
        return {
          type: "reasoning_delta",
          part: index(value.part, "Provider stream reasoning part"),
          delta: value.text,
          visibility: value.visibility,
        };
      case "tool_call_start": {
        const callIndex = index(value.index, "Provider stream tool call index");
        const current = this.#calls.get(callIndex) ?? { rawArguments: "" };
        if (value.id !== undefined) current.id = identityText(value.id, "Provider stream tool call ID", MAX_TOOL_CALL_STREAM_ID_BYTES);
        if (value.name !== undefined) {
          current.name = identityText(value.name, "Provider stream tool call name", MAX_TOOL_CALL_STREAM_NAME_BYTES);
        }
        this.#calls.set(callIndex, current);
        return { type: "tool_call_start", index: callIndex, partial: toolCall(callIndex, current) };
      }
      case "tool_call_delta": {
        const callIndex = index(value.index, "Provider stream tool call index");
        const delta = exactText(
          value.jsonFragment,
          "Provider stream tool call delta",
          MAX_TOOL_CALL_STREAM_DELTA_BYTES,
          true,
        );
        const current = this.#calls.get(callIndex) ?? { rawArguments: "" };
        const rawArguments = `${current.rawArguments}${delta}`;
        if (Buffer.byteLength(rawArguments, "utf8") > MAX_TOOL_CALL_STREAM_DELTA_BYTES) {
          throw new RangeError("Provider stream tool call arguments exceed their byte limit");
        }
        current.rawArguments = rawArguments;
        this.#calls.set(callIndex, current);
        return {
          type: "tool_call_delta",
          index: callIndex,
          delta,
          partial: toolCall(callIndex, current, partialArguments(rawArguments)),
        };
      }
      case "tool_call_end": {
        const callIndex = index(value.index, "Provider stream tool call index");
        const current = this.#calls.get(callIndex) ?? { rawArguments: "" };
        if (value.id !== undefined) current.id = identityText(value.id, "Provider stream tool call ID", MAX_TOOL_CALL_STREAM_ID_BYTES);
        current.name = identityText(value.name, "Provider stream tool call name", MAX_TOOL_CALL_STREAM_NAME_BYTES);
        current.rawArguments = exactText(
          value.rawArguments,
          "Provider stream tool call arguments",
          MAX_TOOL_CALL_STREAM_DELTA_BYTES,
          true,
        );
        const argumentsValue = value.arguments !== undefined
          ? optionalJson(value.arguments, "Provider stream tool call arguments")
          : value.parseError === undefined
            ? completeArguments(current.rawArguments)
            : undefined;
        const parseError = value.parseError === undefined
          ? undefined
          : boundedText(value.parseError, "Provider stream tool call parse error", MAX_PROVIDER_METADATA_BYTES);
        this.#calls.delete(callIndex);
        return {
          type: "tool_call_end",
          index: callIndex,
          toolCall: toolCall(callIndex, current, argumentsValue, parseError),
        };
      }
      case "usage":
        if (value.semantics !== "incremental" && value.semantics !== "cumulative" && value.semantics !== "final") {
          throw new TypeError("Provider stream usage semantics are invalid");
        }
        return { type: "usage", usage: publicUsage(value.usage), semantics: value.semantics };
      case "unknown_provider_event":
        return undefined;
      case "response_end":
        if (!FINISH_REASONS.has(value.reason)) throw new TypeError("Provider stream finish reason is invalid");
        return {
          type: "response_end",
          reason: value.reason,
          ...(value.rawReason === undefined
            ? {}
            : { rawReason: boundedText(value.rawReason, "Provider stream raw reason", MAX_PROVIDER_METADATA_BYTES) }),
          ...(value.explanation === undefined
            ? {}
            : { explanation: boundedText(value.explanation, "Provider stream explanation", MAX_PROVIDER_METADATA_BYTES) }),
        };
      case "error":
        return { type: "error", error: publicError(value.error) };
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
