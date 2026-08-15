import { isJsonValue, type JsonValue } from "../core/json.js";
import { errorMessage } from "../core/errors.js";
import { canonicalProviderResponseDiagnostics } from "../core/provider-diagnostics.js";
import type { AdapterError, ProviderId, ProviderResponseDiagnostics } from "../core/types.js";
import { safeTransportCode, transportErrorCode } from "./transport-error.js";

export type FetchLike = typeof fetch;
export type TokenSource = string | ((signal?: AbortSignal) => string | undefined | Promise<string | undefined>);

export const MAX_PROVIDER_ERROR_BODY_BYTES = 64 * 1024;
export const MAX_PERSISTED_PROVIDER_ERROR_BYTES = 16 * 1024;
export const MAX_PROVIDER_ERROR_MESSAGE_BYTES = 4 * 1024;

export class ProtocolError extends Error {
  readonly raw?: JsonValue;

  constructor(message: string, raw?: JsonValue, options: ErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProtocolError";
    if (raw !== undefined) this.raw = raw;
  }
}

export class PrematureStreamEndError extends Error {
  readonly raw?: JsonValue;
  readonly transportCode?: string;

  constructor(
    message: string,
    raw?: JsonValue,
    options: ErrorOptions & { transportCode?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PrematureStreamEndError";
    if (raw !== undefined) this.raw = raw;
    const transportCode = safeTransportCode(options.transportCode) ?? transportErrorCode(options.cause);
    if (transportCode !== undefined) this.transportCode = transportCode;
  }
}

export class HttpResponseError extends Error {
  readonly status: number;
  readonly headers: Headers;
  readonly body?: JsonValue;

  constructor(status: number, headers: Headers, message: string, body?: JsonValue) {
    super(message);
    this.name = "HttpResponseError";
    this.status = status;
    this.headers = headers;
    if (body !== undefined) this.body = body;
  }
}

export class ProviderStreamError extends Error {
  readonly code?: string;
  readonly raw?: JsonValue;

  constructor(message: string, code?: string, raw?: JsonValue) {
    super(message);
    this.name = "ProviderStreamError";
    if (code !== undefined) this.code = code;
    if (raw !== undefined) this.raw = raw;
  }
}

export class InvalidProviderRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProviderRequestError";
  }
}

export async function resolveToken(source: TokenSource | undefined, signal?: AbortSignal): Promise<string | undefined> {
  if (source === undefined) return undefined;
  return typeof source === "function" ? await source(signal) : source;
}

export async function assertResponseOk(response: Response): Promise<void> {
  if (response.ok) return;

  const text = await readTextBounded(response, MAX_PROVIDER_ERROR_BODY_BYTES);
  let body: JsonValue | undefined;
  if (text !== "") {
    try {
      const parsed: unknown = JSON.parse(text);
      body = jsonValueOrString(parsed);
    } catch {
      body = text;
    }
  }

  const message = (errorMessageFromBody(body) ?? response.statusText) || `HTTP ${response.status}`;
  throw new HttpResponseError(response.status, response.headers, message, body);
}

export async function readJsonResponse(response: Response, maxBytes = 16 * 1024 * 1024): Promise<unknown> {
  const text = await readTextStrict(response, maxBytes);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProtocolError("Response body was not valid JSON", text.slice(0, 4096));
  }
}

export function assertSecureEndpoint(value: string, label: string): void {
  const endpoint = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new TypeError(`${label} must use HTTPS or loopback HTTP`);
  }
  if (endpoint.username !== "" || endpoint.password !== "") throw new TypeError(`${label} must not contain credentials`);
  if (endpoint.hash !== "") throw new TypeError(`${label} must not contain a fragment`);
}

export function jsonValueOrString(value: unknown): JsonValue {
  if (isJsonValue(value)) return value;
  if (typeof value === "object") return "[object Object]";
  if (typeof value === "function") return "[function]";
  return String(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function requestIdFromHeaders(headers: Headers): string | undefined {
  for (const name of [
    "x-request-id",
    "request-id",
    "apim-request-id",
    "x-amzn-requestid",
    "x-amzn-request-id",
    "x-generation-id",
  ]) {
    const value = headers.get(name);
    if (value) return value;
  }
  return undefined;
}

export function responseDiagnostics(response: Response): ProviderResponseDiagnostics {
  return canonicalProviderResponseDiagnostics(response.status, response.headers.entries());
}

export function normalizeError(
  provider: ProviderId,
  error: unknown,
  options: {
    partial: boolean;
    signal: AbortSignal;
    requestId?: string | undefined;
    diagnostics?: ProviderResponseDiagnostics | undefined;
  },
): AdapterError {
  const nativeError = isNativeError(error);
  if (options.signal.aborted || (nativeError && isAbortError(error))) {
    return withOptionalFields(
      {
        category: "cancelled",
        message: "Request cancelled",
        retryable: false,
        partial: options.partial,
      },
      { requestId: options.requestId, diagnostics: options.diagnostics },
    );
  }

  if (nativeError && error instanceof PrematureStreamEndError) {
    return withOptionalFields(
      {
        category: "network",
        message: error.message,
        retryable: !options.partial,
        partial: options.partial,
        ...(options.partial ? { bodyStarted: true } : {}),
      },
      {
        providerCode: error.transportCode,
        requestId: options.requestId,
        diagnostics: options.diagnostics,
        raw: error.raw,
      },
    );
  }

  if (nativeError && error instanceof ProtocolError) {
    return withOptionalFields(
      {
        category: "protocol",
        message: error.message,
        retryable: false,
        partial: options.partial,
        bodyStarted: true,
      },
      { requestId: options.requestId, diagnostics: options.diagnostics, raw: error.raw },
    );
  }

  if (nativeError && error instanceof InvalidProviderRequestError) {
    return withOptionalFields(
      {
        category: "invalid_request",
        message: error.message,
        retryable: false,
        partial: options.partial,
      },
      { requestId: options.requestId, diagnostics: options.diagnostics },
    );
  }

  if (nativeError && error instanceof HttpResponseError) {
    const providerCode = providerCodeFromBody(error.body);
    const requestId = requestIdFromHeaders(error.headers) ?? options.requestId;
    const retryPreference = shouldRetryHeader(error.headers);
    return withOptionalFields(
      {
        category: categoryForStatus(error.status),
        message: error.message,
        httpStatus: error.status,
        retryable: retryPreference ?? retryableStatus(error.status),
        partial: options.partial,
      },
      {
        providerCode,
        requestId,
        retryAfterMs: retryAfterMs(error.headers),
        diagnostics: canonicalProviderResponseDiagnostics(error.status, error.headers.entries()),
        raw: error.body,
      },
    );
  }

  if (nativeError && error instanceof ProviderStreamError) {
    return withOptionalFields(
      {
        category: categoryForCode(error.code),
        message: error.message,
        retryable: retryableCode(error.code),
        partial: options.partial,
        bodyStarted: true,
      },
      {
        providerCode: error.code,
        requestId: options.requestId,
        diagnostics: options.diagnostics,
        raw: error.raw,
      },
    );
  }

  const message = errorMessage(error);
  const network = nativeError && error instanceof TypeError;
  return withOptionalFields(
    {
      category: network ? "network" : "provider",
      message: `${provider}: ${message}`,
      retryable: network && !options.partial,
      partial: options.partial,
      ...(options.partial ? { bodyStarted: true } : {}),
    },
    {
      providerCode: transportErrorCode(error),
      requestId: options.requestId,
      diagnostics: options.diagnostics,
      raw: jsonValueOrString(error),
    },
  );
}

async function readTextBounded(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        bytes = maxBytes;
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  return truncated ? `${text}\n[response body truncated at ${maxBytes} bytes]` : text;
}

async function readTextStrict(response: Response, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be positive");
  if (response.body === null) throw new ProtocolError("Response did not contain a body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProtocolError(`JSON response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  } catch {
    throw new ProtocolError("JSON response contained invalid UTF-8");
  }
}

function withOptionalFields(
  base: AdapterError,
  optional: {
    providerCode?: string | undefined;
    requestId?: string | undefined;
    retryAfterMs?: number | undefined;
    diagnostics?: ProviderResponseDiagnostics | undefined;
    raw?: JsonValue | undefined;
  },
): AdapterError {
  base.message = boundedErrorText(base.message, MAX_PROVIDER_ERROR_MESSAGE_BYTES);
  if (optional.providerCode !== undefined) base.providerCode = boundedErrorText(optional.providerCode, 1_024);
  if (optional.requestId !== undefined) base.requestId = boundedErrorText(optional.requestId, 4_096);
  if (optional.retryAfterMs !== undefined) base.retryAfterMs = optional.retryAfterMs;
  if (optional.diagnostics !== undefined) base.diagnostics = optional.diagnostics;
  if (optional.raw !== undefined) base.raw = boundedErrorRaw(optional.raw);
  return base;
}

function isNativeError(error: unknown): error is Error {
  const isError = (Error as ErrorConstructor & { isError?: (candidate: unknown) => boolean }).isError;
  return isError?.(error) === true;
}

function isAbortError(error: Error): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function categoryForStatus(status: number): AdapterError["category"] {
  if (status === 401) return "authentication";
  if (status === 402 || status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "overloaded";
  if (status >= 400 && status < 500) return "invalid_request";
  return "provider";
}

function categoryForCode(code: string | undefined): AdapterError["category"] {
  const normalized = code?.toLowerCase() ?? "";
  const numeric = Number(normalized);
  if (Number.isSafeInteger(numeric) && numeric >= 100 && numeric <= 599) return categoryForStatus(numeric);
  if (normalized.includes("auth") || normalized.includes("api_key")) return "authentication";
  if (normalized.includes("permission") || normalized.includes("forbidden")) return "permission";
  if (normalized.includes("rate") || normalized.includes("throttl")) return "rate_limit";
  if (normalized.includes("invalid") || normalized.includes("malformed")) return "invalid_request";
  if (normalized.includes("not_found")) return "not_found";
  if (normalized.includes("overload") || normalized.includes("unavailable")) return "overloaded";
  if (normalized.includes("timeout") || normalized.includes("deadline")) return "timeout";
  if (normalized.includes("cancel")) return "cancelled";
  return "provider";
}

function retryableCode(code: string | undefined): boolean {
  const normalized = code?.toLowerCase() ?? "";
  const numeric = Number(normalized);
  if (Number.isSafeInteger(numeric) && numeric >= 100 && numeric <= 599) return retryableStatus(numeric);
  return ["rate", "throttl", "overload", "unavailable", "timeout", "deadline", "server"].some(
    (part) => normalized.includes(part),
  );
}

function shouldRetryHeader(headers: Headers): boolean | undefined {
  const value = headers.get("x-should-retry")?.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function retryAfterMs(headers: Headers): number | undefined {
  const milliseconds = headers.get("retry-after-ms");
  if (milliseconds !== null) {
    const parsed = Number.parseFloat(milliseconds);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

function errorMessageFromBody(body: JsonValue | undefined): string | undefined {
  const messages: string[] = [];
  collectErrorMessages(body, messages, 0);
  const unique: string[] = [];
  for (const message of messages) {
    const bounded = boundedErrorText(message, 2_048);
    if (bounded === "") continue;
    const normalized = bounded.toLowerCase();
    if (unique.some((entry) => {
      const existing = entry.toLowerCase();
      return existing === normalized || existing.includes(normalized) || normalized.includes(existing);
    })) continue;
    unique.push(bounded);
    if (unique.length === 2) break;
  }
  return unique.length === 0 ? undefined : unique.join(": ");
}

function providerCodeFromBody(body: JsonValue | undefined): string | undefined {
  return providerCodeFromValue(body, 0);
}

function providerCodeFromValue(body: JsonValue | undefined, depth: number): string | undefined {
  if (body === undefined || depth > 4) return undefined;
  if (typeof body === "string" && body.length <= 16 * 1024 && /^[\[{]/u.test(body.trim())) {
    try {
      return providerCodeFromValue(jsonValueOrString(JSON.parse(body)), depth + 1);
    } catch {
      return undefined;
    }
  }
  const record = asRecord(body);
  if (record === undefined) return undefined;
  const nested = asRecord(record.error);
  const direct = (
    asString(nested?.code) ??
    asString(nested?.type) ??
    asString(nested?.__type) ??
    asString(record.code) ??
    asString(record.type) ??
    asString(record.__type)
  );
  if (direct !== undefined && !/(?:gateway|provider|upstream|unknown|error$)/iu.test(direct)) return direct;
  for (const key of ["error", "metadata", "raw", "body", "response"]) {
    const candidate = record[key];
    if (candidate === undefined || !isJsonValue(candidate)) continue;
    const found = providerCodeFromValue(candidate, depth + 1);
    if (found !== undefined) return found;
  }
  return direct;
}

function collectErrorMessages(value: JsonValue | undefined, output: string[], depth: number): void {
  if (value === undefined || output.length >= 4 || depth > 6) return;
  if (typeof value === "string") {
    if (value.length <= 16 * 1024 && /^[\[{]/u.test(value.trim())) {
      try {
        collectErrorMessages(jsonValueOrString(JSON.parse(value)), output, depth + 1);
        return;
      } catch {}
    }
    output.push(value);
    return;
  }
  const record = asRecord(value);
  if (record === undefined) return;
  for (const key of ["message", "detail", "reason"]) {
    const candidate = record[key];
    if (typeof candidate === "string") output.push(candidate);
  }
  for (const key of ["error", "metadata", "raw", "body", "response"]) {
    const candidate = record[key];
    if (candidate !== undefined && isJsonValue(candidate)) collectErrorMessages(candidate, output, depth + 1);
  }
}

function boundedErrorText(value: string, maxBytes: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").replace(/\s+/gu, " ").trim();
  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.byteLength <= maxBytes) return normalized;
  const marker = "…[truncated]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker));
  let end = budget;
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) <= 0xbf) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}${marker}`;
}

function boundedErrorRaw(value: JsonValue): JsonValue {
  const serialized = JSON.stringify(value);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= MAX_PERSISTED_PROVIDER_ERROR_BYTES) return value;
  return {
    truncated: true,
    originalBytes: bytes,
    summary: errorMessageFromBody(value) ?? "Provider error body omitted",
  };
}
