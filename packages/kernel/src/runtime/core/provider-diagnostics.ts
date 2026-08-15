import { defaultSecretRedactor } from "../auth/redaction.js";
import { boundedJsonSnapshot } from "./bounded-json.js";
import type { JsonValue } from "./json.js";
import type { AdapterError, ProviderResponseDiagnostics } from "./types.js";

const MAX_HEADER_VALUE_BYTES = 2 * 1024;
const MAX_DIAGNOSTIC_HEADER_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_INPUT_BYTES = 32 * 1024;
const MAX_ADAPTER_ERROR_BYTES = 128 * 1024;
const MAX_ADAPTER_ERROR_MESSAGE_BYTES = 16 * 1024;
const MAX_ADAPTER_ERROR_METADATA_BYTES = 4 * 1024;
const MAX_ADAPTER_ERROR_RAW_BYTES = 64 * 1024;
const MAX_ADAPTER_ERROR_VALUES = 8_288;
const MAX_ADAPTER_ERROR_CONTAINERS = 4_100;
const MAX_ADAPTER_ERROR_DEPTH = 61;

const ADAPTER_ERROR_CATEGORIES = new Set<AdapterError["category"]>([
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

const ADAPTER_ERROR_FIELDS = new Set([
  "category",
  "message",
  "httpStatus",
  "providerCode",
  "requestId",
  "retryAfterMs",
  "retryable",
  "partial",
  "bodyStarted",
  "diagnostics",
  "raw",
]);

const ALLOWED_RESPONSE_HEADERS = new Set([
  "content-type",
  "request-id",
  "x-request-id",
  "apim-request-id",
  "x-amzn-requestid",
  "x-amzn-request-id",
  "x-generation-id",
  "x-goog-request-id",
  "cf-ray",
  "retry-after",
  "retry-after-ms",
  "x-should-retry",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "anthropic-ratelimit-requests-limit",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-limit",
  "anthropic-ratelimit-tokens-remaining",
  "anthropic-ratelimit-tokens-reset",
]);

function boundedHeaderValue(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.length <= MAX_HEADER_VALUE_BYTES) return normalized;
  return bytes.subarray(0, MAX_HEADER_VALUE_BYTES).toString("utf8").replace(/\uFFFD+$/u, "");
}

/**
 * Builds the only response-header projection that may leave a provider adapter.
 * Unknown headers—including authorization, cookies, and provider-specific secrets—are dropped.
 */
export function canonicalProviderResponseDiagnostics(
  status: number,
  headers: Iterable<readonly [string, string]>,
): ProviderResponseDiagnostics {
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
    throw new TypeError("Provider response diagnostic status must be an HTTP status code");
  }
  const selected: Record<string, string> = {};
  let retainedBytes = 0;
  for (const [rawName, rawValue] of headers) {
    const name = rawName.toLowerCase();
    if (!ALLOWED_RESPONSE_HEADERS.has(name) || Object.hasOwn(selected, name)) continue;
    const value = boundedHeaderValue(rawValue);
    const bytes = Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
    if (retainedBytes + bytes > MAX_DIAGNOSTIC_HEADER_BYTES) break;
    selected[name] = value;
    retainedBytes += bytes;
  }
  return { status, headers: selected };
}

/** Revalidates custom-provider diagnostics at the core boundary. */
export function validateProviderResponseDiagnostics(value: unknown): ProviderResponseDiagnostics {
  const snapshot = boundedJsonSnapshot(value, {
    label: "Provider response diagnostics",
    maximumBytes: MAX_DIAGNOSTIC_INPUT_BYTES,
    maximumValues: 64,
    maximumContainers: 2,
    maximumDepth: 2,
  }).value;
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("Provider response diagnostics must be an object");
  }
  const record = snapshot as Record<string, JsonValue>;
  if (Object.keys(record).some((key) => key !== "status" && key !== "headers")
    || !Object.hasOwn(record, "status") || !Object.hasOwn(record, "headers")) {
    throw new TypeError("Provider response diagnostics contain unsupported fields");
  }
  if (record.headers === null || typeof record.headers !== "object" || Array.isArray(record.headers)) {
    throw new TypeError("Provider response diagnostic headers must be an object");
  }
  const headers = Object.entries(record.headers as Record<string, unknown>).map(([name, header]) => {
    if (typeof header !== "string") throw new TypeError("Provider response diagnostic header values must be strings");
    return [name, header] as const;
  });
  return canonicalProviderResponseDiagnostics(record.status as number, headers);
}

function adapterErrorText(value: JsonValue | undefined, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || value === "") throw new TypeError(`${label} must be a non-empty string`);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new TypeError(`${label} exceeds its byte limit`);
  return value;
}

function boundedAdapterErrorMessage(value: JsonValue | undefined): string {
  if (typeof value !== "string" || value === "") {
    throw new TypeError("Provider adapter error message must be a non-empty string");
  }
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  const redacted = defaultSecretRedactor.redact(normalized);
  const encoded = Buffer.from(redacted, "utf8");
  if (encoded.byteLength <= MAX_ADAPTER_ERROR_MESSAGE_BYTES) return redacted;
  return encoded.subarray(0, MAX_ADAPTER_ERROR_MESSAGE_BYTES).toString("utf8").replace(/\uFFFD+$/u, "");
}

/** Revalidates and detaches an error returned by a custom provider adapter. */
export function validateProviderAdapterError(value: unknown): AdapterError {
  const snapshot = boundedJsonSnapshot(value, {
    label: "Provider adapter error",
    maximumBytes: MAX_ADAPTER_ERROR_BYTES,
    maximumValues: MAX_ADAPTER_ERROR_VALUES,
    maximumContainers: MAX_ADAPTER_ERROR_CONTAINERS,
    maximumDepth: MAX_ADAPTER_ERROR_DEPTH,
  }).value;
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("Provider adapter error must be an object");
  }
  const record = snapshot as Record<string, JsonValue>;
  if (Object.keys(record).some((key) => !ADAPTER_ERROR_FIELDS.has(key))) {
    throw new TypeError("Provider adapter error contains unsupported fields");
  }
  for (const field of ["category", "message", "retryable", "partial"] as const) {
    if (!Object.hasOwn(record, field)) throw new TypeError(`Provider adapter error ${field} is required`);
  }
  if (typeof record.category !== "string"
    || !ADAPTER_ERROR_CATEGORIES.has(record.category as AdapterError["category"])) {
    throw new TypeError("Provider adapter error category is invalid");
  }
  if (typeof record.retryable !== "boolean" || typeof record.partial !== "boolean") {
    throw new TypeError("Provider adapter error flags must be booleans");
  }
  if (record.bodyStarted !== undefined && typeof record.bodyStarted !== "boolean") {
    throw new TypeError("Provider adapter error bodyStarted flag must be a boolean");
  }
  if (record.httpStatus !== undefined && (
    !Number.isSafeInteger(record.httpStatus) || (record.httpStatus as number) < 100 || (record.httpStatus as number) > 599
  )) throw new TypeError("Provider adapter error HTTP status is invalid");
  if (record.retryAfterMs !== undefined && (
    !Number.isSafeInteger(record.retryAfterMs) || (record.retryAfterMs as number) < 0
  )) throw new TypeError("Provider adapter error retry delay is invalid");
  const message = boundedAdapterErrorMessage(record.message);
  const providerCode = record.providerCode === undefined
    ? undefined
    : adapterErrorText(record.providerCode, "Provider adapter error code", MAX_ADAPTER_ERROR_METADATA_BYTES);
  const requestId = record.requestId === undefined
    ? undefined
    : adapterErrorText(record.requestId, "Provider adapter request ID", MAX_ADAPTER_ERROR_METADATA_BYTES);
  const diagnostics = record.diagnostics === undefined
    ? undefined
    : validateProviderResponseDiagnostics(record.diagnostics);
  const raw = record.raw === undefined
    ? undefined
    : boundedJsonSnapshot(record.raw, {
        label: "Provider adapter error raw payload",
        maximumBytes: MAX_ADAPTER_ERROR_RAW_BYTES,
        maximumValues: 8_192,
        maximumContainers: 4_096,
        maximumDepth: 59,
      }).value;

  return {
    category: record.category as AdapterError["category"],
    message,
    ...(record.httpStatus === undefined ? {} : { httpStatus: record.httpStatus as number }),
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(record.retryAfterMs === undefined ? {} : { retryAfterMs: record.retryAfterMs as number }),
    retryable: record.retryable,
    partial: record.partial,
    ...(record.bodyStarted === undefined ? {} : { bodyStarted: record.bodyStarted }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(raw === undefined ? {} : { raw }),
  };
}
