import { isProxy } from "node:util/types";

import { canonicalAssistantDiagnostics } from "./assistant-diagnostics.js";
import { ASSISTANT_CONTENT_LIMITS } from "./assistant-content-limits.js";
import { boundedJsonSnapshot } from "./bounded-json.js";
import {
  MAX_TOOL_CALL_STREAM_DELTA_BYTES,
  MAX_TOOL_CALL_STREAM_ID_BYTES,
  MAX_TOOL_CALL_STREAM_NAME_BYTES,
  MAX_TOOL_CALL_STREAM_PARSE_ERROR_BYTES,
} from "./events.js";
import type { JsonValue } from "./json.js";
import {
  validateProviderAdapterError,
  validateProviderResponseDiagnostics,
} from "./provider-diagnostics.js";
import { validateProviderState } from "./provider-state.js";
import { validatedAssistantContent } from "./public-assistant-content.js";
import type { AdapterEvent, FinishReason, NormalizedUsage } from "./types.js";
import { isNormalizedUsage } from "./usage.js";

const FINISH_REASONS = new Set<FinishReason>([
  "stop", "tool_calls", "length", "context_limit", "content_filter", "refusal",
  "pause", "cancelled", "aborted", "error", "incomplete", "unknown",
]);

const KNOWN_EVENT_TYPES = new Set<AdapterEvent["type"]>([
  "response_start", "text_start", "text_delta", "text_end", "reasoning_start",
  "reasoning_delta", "reasoning_end", "tool_call_start", "tool_call_delta",
  "tool_call_end", "usage", "unknown_provider_event", "response_end", "error",
]);

const JSON_STRING_ESCAPE_FACTOR = 6;
const EVENT_ENVELOPE_OVERHEAD_BYTES = 4 * 1024;
const TEXT_DELTA_ENVELOPE_BYTES = (ASSISTANT_CONTENT_LIMITS.fieldBytes * JSON_STRING_ESCAPE_FACTOR)
  + EVENT_ENVELOPE_OVERHEAD_BYTES;
const TEXT_END_ENVELOPE_BYTES = (ASSISTANT_CONTENT_LIMITS.fieldBytes * 2 * JSON_STRING_ESCAPE_FACTOR)
  + EVENT_ENVELOPE_OVERHEAD_BYTES;
const TOOL_END_ENVELOPE_BYTES = (ASSISTANT_CONTENT_LIMITS.fieldBytes * ((2 * JSON_STRING_ESCAPE_FACTOR) + 1))
  + ((MAX_TOOL_CALL_STREAM_ID_BYTES + MAX_TOOL_CALL_STREAM_NAME_BYTES + MAX_TOOL_CALL_STREAM_PARSE_ERROR_BYTES)
    * JSON_STRING_ESCAPE_FACTOR)
  + EVENT_ENVELOPE_OVERHEAD_BYTES;
const RESPONSE_END_ENVELOPE_BYTES = (64 * 1024 * 1024)
  + ASSISTANT_CONTENT_LIMITS.contentBytes
  + (512 * 1024)
  + (8 * 1024 * JSON_STRING_ESCAPE_FACTOR)
  + EVENT_ENVELOPE_OVERHEAD_BYTES;

function unknownRawMarker(): JsonValue {
  return { invalid: true, truncated: true };
}

interface EventEnvelopeLimits {
  bytes: number;
  values: number;
  containers: number;
  depth: number;
}

function inspectedAdapterEvent(value: unknown): { source: object; type: AdapterEvent["type"] } {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    throw new TypeError("Provider adapter event must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Provider adapter event must be a plain object");
  }
  const descriptor = Reflect.getOwnPropertyDescriptor(value, "type");
  if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)
    || typeof descriptor.value !== "string" || !KNOWN_EVENT_TYPES.has(descriptor.value as AdapterEvent["type"])) {
    throw new TypeError("Provider adapter event type is invalid");
  }
  return { source: value, type: descriptor.value as AdapterEvent["type"] };
}

/** Safely reads only the plain data discriminator of a provider adapter event. */
export function adapterEventType(value: unknown): AdapterEvent["type"] {
  return inspectedAdapterEvent(value).type;
}

function limitsFor(type: AdapterEvent["type"]): EventEnvelopeLimits {
  switch (type) {
    case "response_end": return { bytes: RESPONSE_END_ENVELOPE_BYTES, values: 100_000, containers: 50_000, depth: 68 };
    case "text_end":
    case "reasoning_end": return { bytes: TEXT_END_ENVELOPE_BYTES, values: 16, containers: 1, depth: 1 };
    case "tool_call_end": return { bytes: TOOL_END_ENVELOPE_BYTES, values: 8_224, containers: 8_193, depth: 60 };
    case "text_delta":
    case "reasoning_delta":
    case "tool_call_delta": return { bytes: TEXT_DELTA_ENVELOPE_BYTES, values: 8, containers: 1, depth: 1 };
    case "usage": return { bytes: 84 * 1024, values: 8_230, containers: 4_101, depth: 62 };
    case "error": return { bytes: 132 * 1024, values: 8_292, containers: 4_101, depth: 62 };
    case "response_start": return { bytes: 96 * 1024, values: 128, containers: 8, depth: 4 };
    default: return { bytes: 16 * 1024, values: 32, containers: 1, depth: 1 };
  }
}

function snapshotRecord(
  value: object,
  type: AdapterEvent["type"],
  allowed: readonly string[],
): Record<string, JsonValue> {
  const limits = limitsFor(type);
  const selected = boundedJsonSnapshot(value, {
    label: `Provider adapter ${type} event`,
    maximumBytes: limits.bytes,
    maximumValues: limits.values,
    maximumContainers: limits.containers,
    maximumDepth: limits.depth,
  }).value;
  if (selected === null || typeof selected !== "object" || Array.isArray(selected)) {
    throw new TypeError(`Provider adapter ${type} event must be an object`);
  }
  const record = selected as Record<string, JsonValue>;
  const allowedKeys = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new TypeError(`Provider adapter ${type} event contains unsupported fields`);
  }
  if (record.type !== type) throw new TypeError("Provider adapter event type changed during validation");
  return record;
}

function required(record: Record<string, JsonValue>, fields: readonly string[], type: string): void {
  if (fields.some((field) => !Object.hasOwn(record, field))) {
    throw new TypeError(`Provider adapter ${type} event is missing required fields`);
  }
}

function index(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function string(
  value: JsonValue | undefined,
  label: string,
  maximumBytes: number,
  options: { empty?: boolean; identity?: boolean } = {},
): string {
  if (typeof value !== "string" || (options.empty !== true && value === "")
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || (options.identity === true && /[\u0000-\u001f\u007f-\u009f]/u.test(value))) {
    throw new TypeError(`${label} is invalid or exceeds ${maximumBytes} bytes`);
  }
  return value;
}

function optionalString(
  value: JsonValue | undefined,
  label: string,
  maximumBytes: number,
  options: { empty?: boolean; identity?: boolean } = {},
): string | undefined {
  return value === undefined ? undefined : string(value, label, maximumBytes, options);
}

function visibility(value: JsonValue | undefined): "summary" | "provider_trace" {
  if (value !== "summary" && value !== "provider_trace") {
    throw new TypeError("Provider adapter reasoning visibility is invalid");
  }
  return value;
}

function usage(value: JsonValue | undefined): NormalizedUsage {
  const selected = boundedJsonSnapshot(value, {
    label: "Provider adapter usage",
    maximumBytes: 80 * 1024,
    maximumValues: 8_224,
    maximumContainers: 4_100,
    maximumDepth: 61,
  }).value;
  if (!isNormalizedUsage(selected)) throw new TypeError("Provider adapter usage is invalid");
  return selected as NormalizedUsage;
}

function unknownEvent(source: object): AdapterEvent {
  const keys = Reflect.ownKeys(source);
  if (keys.some((key) => typeof key !== "string" || !["type", "provider", "raw"].includes(key))) {
    throw new TypeError("Provider adapter unknown event contains unsupported fields");
  }
  const providerDescriptor = Reflect.getOwnPropertyDescriptor(source, "provider");
  if (providerDescriptor === undefined || providerDescriptor.enumerable !== true || !("value" in providerDescriptor)) {
    throw new TypeError("Provider adapter unknown event provider must be a data property");
  }
  const provider = string(providerDescriptor.value as JsonValue, "Provider adapter unknown event provider", 4_096, {
    identity: true,
  });
  const rawDescriptor = Reflect.getOwnPropertyDescriptor(source, "raw");
  let raw = unknownRawMarker();
  if (rawDescriptor !== undefined && rawDescriptor.enumerable === true && "value" in rawDescriptor) {
    try {
      raw = boundedJsonSnapshot(rawDescriptor.value, {
        label: "Provider adapter unknown event raw payload",
        maximumBytes: ASSISTANT_CONTENT_LIMITS.contentBytes,
        maximumValues: ASSISTANT_CONTENT_LIMITS.argumentValues,
        maximumContainers: ASSISTANT_CONTENT_LIMITS.containers,
        maximumDepth: ASSISTANT_CONTENT_LIMITS.argumentDepth,
      }).value;
    } catch {
      raw = unknownRawMarker();
    }
  }
  return { type: "unknown_provider_event", provider, raw };
}

/** Validates and detaches one custom-provider stream event before any consumer reads it. */
export function snapshotAdapterEvent(value: unknown): AdapterEvent {
  const selectedType = inspectedAdapterEvent(value);
  const { source, type } = selectedType;
  if (type === "unknown_provider_event") return unknownEvent(source);

  switch (type) {
    case "response_start": {
      const record = snapshotRecord(source, type, ["type", "model", "responseId", "requestId", "diagnostics"]);
      required(record, ["type", "model"], type);
      const model = string(record.model, "Provider adapter response model", 1_024, { identity: true });
      const responseId = optionalString(record.responseId, "Provider adapter response ID", 4_096, { identity: true });
      const requestId = optionalString(record.requestId, "Provider adapter request ID", 4_096, { identity: true });
      const diagnostics = record.diagnostics === undefined
        ? undefined
        : validateProviderResponseDiagnostics(record.diagnostics);
      return {
        type,
        model,
        ...(responseId === undefined ? {} : { responseId }),
        ...(requestId === undefined ? {} : { requestId }),
        ...(diagnostics === undefined ? {} : { diagnostics }),
      };
    }
    case "text_start": {
      const record = snapshotRecord(source, type, ["type", "part"]);
      required(record, ["type", "part"], type);
      return { type, part: index(record.part, "Provider adapter text part") };
    }
    case "text_delta": {
      const record = snapshotRecord(source, type, ["type", "part", "text"]);
      required(record, ["type", "part", "text"], type);
      return {
        type,
        part: index(record.part, "Provider adapter text part"),
        text: string(record.text, "Provider adapter text delta", ASSISTANT_CONTENT_LIMITS.fieldBytes, { empty: true }),
      };
    }
    case "text_end": {
      const record = snapshotRecord(source, type, ["type", "part", "text", "textSignature"]);
      required(record, ["type", "part", "text"], type);
      const textSignature = optionalString(
        record.textSignature,
        "Provider adapter text signature",
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
        { empty: true },
      );
      return {
        type,
        part: index(record.part, "Provider adapter text part"),
        text: string(record.text, "Provider adapter text final text", ASSISTANT_CONTENT_LIMITS.fieldBytes, { empty: true }),
        ...(textSignature === undefined ? {} : { textSignature }),
      };
    }
    case "reasoning_start": {
      const record = snapshotRecord(source, type, ["type", "part", "visibility"]);
      required(record, ["type", "part", "visibility"], type);
      return { type, part: index(record.part, "Provider adapter reasoning part"), visibility: visibility(record.visibility) };
    }
    case "reasoning_delta": {
      const record = snapshotRecord(source, type, ["type", "part", "text", "visibility"]);
      required(record, ["type", "part", "text", "visibility"], type);
      return {
        type,
        part: index(record.part, "Provider adapter reasoning part"),
        text: string(record.text, "Provider adapter reasoning delta", ASSISTANT_CONTENT_LIMITS.fieldBytes, { empty: true }),
        visibility: visibility(record.visibility),
      };
    }
    case "reasoning_end": {
      const record = snapshotRecord(source, type, ["type", "part", "text", "visibility", "thinkingSignature", "redacted"]);
      required(record, ["type", "part", "text", "visibility"], type);
      if (record.redacted !== undefined && typeof record.redacted !== "boolean") {
        throw new TypeError("Provider adapter reasoning redacted marker must be boolean");
      }
      const thinkingSignature = optionalString(
        record.thinkingSignature,
        "Provider adapter reasoning signature",
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
        { empty: true },
      );
      return {
        type,
        part: index(record.part, "Provider adapter reasoning part"),
        text: string(record.text, "Provider adapter reasoning final text", ASSISTANT_CONTENT_LIMITS.fieldBytes, { empty: true }),
        visibility: visibility(record.visibility),
        ...(thinkingSignature === undefined ? {} : { thinkingSignature }),
        ...(record.redacted === undefined ? {} : { redacted: record.redacted }),
      };
    }
    case "tool_call_start": {
      const record = snapshotRecord(source, type, ["type", "index", "id", "name"]);
      required(record, ["type", "index"], type);
      const id = optionalString(record.id, "Provider adapter tool-call ID", MAX_TOOL_CALL_STREAM_ID_BYTES, { identity: true });
      const name = optionalString(record.name, "Provider adapter tool-call name", MAX_TOOL_CALL_STREAM_NAME_BYTES, { identity: true });
      return {
        type,
        index: index(record.index, "Provider adapter tool-call index"),
        ...(id === undefined ? {} : { id }),
        ...(name === undefined ? {} : { name }),
      };
    }
    case "tool_call_delta": {
      const record = snapshotRecord(source, type, ["type", "index", "jsonFragment"]);
      required(record, ["type", "index", "jsonFragment"], type);
      return {
        type,
        index: index(record.index, "Provider adapter tool-call index"),
        jsonFragment: string(
          record.jsonFragment,
          "Provider adapter tool-call delta",
          MAX_TOOL_CALL_STREAM_DELTA_BYTES,
          { empty: true },
        ),
      };
    }
    case "tool_call_end": {
      const record = snapshotRecord(source, type, [
        "type", "index", "name", "rawArguments", "id", "arguments", "parseError", "thoughtSignature",
      ]);
      required(record, ["type", "index", "name", "rawArguments"], type);
      const id = optionalString(record.id, "Provider adapter tool-call ID", MAX_TOOL_CALL_STREAM_ID_BYTES, { identity: true });
      const argumentsValue = record.arguments === undefined
        ? undefined
        : boundedJsonSnapshot(record.arguments, {
            label: "Provider adapter tool-call arguments",
            maximumBytes: MAX_TOOL_CALL_STREAM_DELTA_BYTES,
            maximumValues: ASSISTANT_CONTENT_LIMITS.argumentValues,
            maximumContainers: ASSISTANT_CONTENT_LIMITS.containers,
            maximumDepth: ASSISTANT_CONTENT_LIMITS.argumentDepth,
          }).value;
      const parseError = optionalString(
        record.parseError,
        "Provider adapter tool-call parse error",
        MAX_TOOL_CALL_STREAM_PARSE_ERROR_BYTES,
        { empty: true },
      );
      const thoughtSignature = optionalString(
        record.thoughtSignature,
        "Provider adapter tool-call signature",
        ASSISTANT_CONTENT_LIMITS.fieldBytes,
        { empty: true },
      );
      return {
        type,
        index: index(record.index, "Provider adapter tool-call index"),
        name: string(record.name, "Provider adapter tool-call name", MAX_TOOL_CALL_STREAM_NAME_BYTES, { identity: true }),
        rawArguments: string(
          record.rawArguments,
          "Provider adapter tool-call arguments",
          MAX_TOOL_CALL_STREAM_DELTA_BYTES,
          { empty: true },
        ),
        ...(id === undefined ? {} : { id }),
        ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
        ...(parseError === undefined ? {} : { parseError }),
        ...(thoughtSignature === undefined ? {} : { thoughtSignature }),
      };
    }
    case "usage": {
      const record = snapshotRecord(source, type, ["type", "usage", "semantics"]);
      required(record, ["type", "usage", "semantics"], type);
      if (record.semantics !== "incremental" && record.semantics !== "cumulative" && record.semantics !== "final") {
        throw new TypeError("Provider adapter usage semantics are invalid");
      }
      return { type, usage: usage(record.usage), semantics: record.semantics };
    }
    case "response_end": {
      const record = snapshotRecord(source, type, [
        "type", "reason", "state", "content", "assistantDiagnostics", "rawReason", "explanation",
      ]);
      required(record, ["type", "reason", "state"], type);
      if (typeof record.reason !== "string" || !FINISH_REASONS.has(record.reason as FinishReason)) {
        throw new TypeError("Provider adapter finish reason is invalid");
      }
      const state = validateProviderState(record.state).state;
      const content = record.content === undefined ? undefined : validatedAssistantContent(record.content);
      const assistantDiagnostics = record.assistantDiagnostics === undefined
        ? undefined
        : canonicalAssistantDiagnostics(record.assistantDiagnostics);
      const rawReason = optionalString(record.rawReason, "Provider adapter raw reason", 4 * 1024, { empty: true });
      const explanation = optionalString(record.explanation, "Provider adapter explanation", 4 * 1024, { empty: true });
      return {
        type,
        reason: record.reason as FinishReason,
        state,
        ...(content === undefined ? {} : { content }),
        ...(assistantDiagnostics === undefined ? {} : { assistantDiagnostics }),
        ...(rawReason === undefined ? {} : { rawReason }),
        ...(explanation === undefined ? {} : { explanation }),
      };
    }
    case "error": {
      const record = snapshotRecord(source, type, ["type", "error"]);
      required(record, ["type", "error"], type);
      return { type, error: validateProviderAdapterError(record.error) };
    }
  }
}
