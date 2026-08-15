import type { Model, ProviderHeaders, StreamOptions } from "./contracts.js";
import { boundedJsonSnapshot, errorMessage } from "./utilities.js";

const MAX_ERROR_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_STREAM_EVENTS = 65_536;
const MAX_RETRIES = 10;
const MAX_TIMER = 2_147_483_647;

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

export interface HttpStreamRequest {
  url: string;
  body: unknown;
  model?: Model;
  headers?: ProviderHeaders | undefined;
  options?: StreamOptions | undefined;
  defaultHeaders?: Record<string, string> | undefined;
  authorization?: { scheme?: string; value: string; header?: string } | undefined;
}

export interface HttpStreamResponse {
  response: Response;
  events: AsyncIterable<SseEvent>;
}

export function normalizedHeaders(...sources: Array<HeadersInit | ProviderHeaders | undefined>): Record<string, string> {
  const merged = new Map<string, { name: string; value: string }>();
  for (const source of sources) {
    if (!source) continue;
    const entries: Array<[string, string | null]> = source instanceof Headers
      ? [...source.entries()]
      : Array.isArray(source)
        ? source.map(([name, value]) => [name, String(value)])
        : Object.entries(source).map(([name, value]) => [name, value === null ? null : String(value)]);
    for (const [name, value] of entries) {
      const key = name.toLowerCase();
      if (value === null) merged.delete(key);
      else merged.set(key, { name, value });
    }
  }
  return Object.fromEntries([...merged.values()].map(({ name, value }) => [name, value]));
}

function redact(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = /authorization|api[-_]?key|token|cookie/i.test(name) ? "[redacted]" : value;
  }
  return result;
}

function boundedInteger(name: string, value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: unknown): AbortSignal | undefined {
  const timeout = boundedInteger("timeoutMs", timeoutMs, 0, MAX_TIMER);
  if (timeout === 0) return signal;
  const timeoutSignal = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export async function fetchEventStream(request: HttpStreamRequest): Promise<HttpStreamResponse> {
  const options = request.options ?? {};
  const retries = boundedInteger("maxRetries", options.maxRetries, 2, MAX_RETRIES);
  const maxRetryDelayMs = boundedInteger("maxRetryDelayMs", options.maxRetryDelayMs, 60_000, MAX_TIMER);
  const fetcher = typeof options.fetch === "function" ? options.fetch as typeof globalThis.fetch : globalThis.fetch;
  const authorization = request.authorization;
  const authHeaders = authorization === undefined ? undefined : {
    [authorization.header ?? "authorization"]: authorization.scheme === "raw"
      ? authorization.value
      : `${authorization.scheme ?? "Bearer"} ${authorization.value}`,
  };
  const headers = normalizedHeaders(
    { accept: "text/event-stream", "content-type": "application/json" },
    request.defaultHeaders,
    authHeaders,
    request.headers,
  );
  const replacement = request.model && options.onPayload
    ? await options.onPayload(structuredClone(request.body), request.model)
    : undefined;
  const payload = replacement === undefined ? request.body : replacement;
  const body = JSON.stringify(payload);
  let attempt = 0;
  while (true) {
    attempt += 1;
    const signal = requestSignal(options.signal, options.timeoutMs);
    await options.onRequest?.({
      url: request.url,
      method: "POST",
      headers: redact(headers),
      body: structuredClone(payload),
      attempt,
    });
    let response: Response;
    try {
      response = await fetcher(request.url, { method: "POST", headers, body, ...(signal === undefined ? {} : { signal }) });
    } catch (cause) {
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
      if (attempt > retries) throw cause;
      await retryWait(backoff(attempt), options.signal);
      continue;
    }
    const responseHeaders = Object.fromEntries([...response.headers].map(([name, value]) => [name.toLowerCase(), value]));
    if (options.onResponse && request.model) {
      await options.onResponse({ url: request.url, status: response.status, headers: responseHeaders, attempt }, request.model);
    }
    if (response.ok) {
      if (!response.body) throw new Error("Streaming response did not include a body");
      return { response, events: parseEventStream(response.body, signal) };
    }
    const details = await boundedResponseText(response, MAX_ERROR_BYTES);
    if (attempt > retries || !retryStatus(response.status)) {
      throw new Error(`HTTP ${response.status}${details ? `: ${details}` : ""}`);
    }
    const requested = retryAfter(response.headers.get("retry-after"));
    const delay = requested ?? backoff(attempt);
    await retryWait(maxRetryDelayMs === 0 ? Math.min(delay, MAX_TIMER) : Math.min(delay, maxRetryDelayMs), options.signal);
  }
}

export async function fetchJson<T>(request: HttpStreamRequest): Promise<T> {
  const options = request.options ?? {};
  const retries = boundedInteger("maxRetries", options.maxRetries, 2, MAX_RETRIES);
  const maxRetryDelayMs = boundedInteger("maxRetryDelayMs", options.maxRetryDelayMs, 60_000, MAX_TIMER);
  const fetcher = typeof options.fetch === "function" ? options.fetch as typeof globalThis.fetch : globalThis.fetch;
  const authorization = request.authorization;
  const authHeaders = authorization === undefined ? undefined : {
    [authorization.header ?? "authorization"]: authorization.scheme === "raw"
      ? authorization.value
      : `${authorization.scheme ?? "Bearer"} ${authorization.value}`,
  };
  const headers = normalizedHeaders({ accept: "application/json", "content-type": "application/json" }, request.defaultHeaders, authHeaders, request.headers);
  const replacement = request.model && options.onPayload
    ? await options.onPayload(structuredClone(request.body), request.model)
    : undefined;
  const payload = replacement === undefined ? request.body : replacement;
  let attempt = 0;
  while (true) {
    attempt += 1;
    const signal = requestSignal(options.signal, options.timeoutMs);
    await options.onRequest?.({ url: request.url, method: "POST", headers: redact(headers), body: structuredClone(payload), attempt });
    let response: Response;
    try {
      response = await fetcher(request.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      if (options.signal?.aborted || attempt > retries) throw cause;
      await retryWait(backoff(attempt), options.signal);
      continue;
    }
    const responseHeaders = Object.fromEntries([...response.headers].map(([name, value]) => [name.toLowerCase(), value]));
    if (options.onResponse && request.model) {
      await options.onResponse({ url: request.url, status: response.status, headers: responseHeaders, attempt }, request.model);
    }
    if (response.ok) {
      const text = await boundedResponseText(response, MAX_EVENT_BYTES);
      try { return JSON.parse(text) as T; } catch (cause) { throw new Error(`Invalid JSON response: ${errorMessage(cause)}`); }
    }
    const details = await boundedResponseText(response, MAX_ERROR_BYTES);
    if (attempt > retries || !retryStatus(response.status)) throw new Error(`HTTP ${response.status}${details ? `: ${details}` : ""}`);
    const requested = retryAfter(response.headers.get("retry-after"));
    const delay = requested ?? backoff(attempt);
    await retryWait(maxRetryDelayMs === 0 ? Math.min(delay, MAX_TIMER) : Math.min(delay, maxRetryDelayMs), options.signal);
  }
}

function retryStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529;
}

function backoff(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(0, attempt - 1), 8000);
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function retryWait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function boundedResponseText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return boundedJsonSnapshot({ error: "Response body exceeded limit" }, limit);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function* parseEventStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const firstDecoder = new TextDecoder();
  const laterDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let firstRecord = true;
  let buffer = new Uint8Array(1_024);
  let length = 0;
  let naturalEnd = false;
  let streamBytes = 0;
  let streamEvents = 0;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  const append = (byte: number): void => {
    const required = length + 1;
    if (required > buffer.byteLength) {
      const capacity = Math.min(MAX_EVENT_BYTES + 4, Math.max(required, buffer.byteLength * 2));
      const expanded = new Uint8Array(capacity);
      expanded.set(buffer.subarray(0, length));
      buffer = expanded;
    }
    buffer[length] = byte;
    length = required;
  };
  const boundaryLength = (): number => {
    if (
      length >= 4 && buffer[length - 4] === 13 && buffer[length - 3] === 10 &&
      buffer[length - 2] === 13 && buffer[length - 1] === 10
    ) return 4;
    if (
      length >= 3 && buffer[length - 1] === 10 &&
      ((buffer[length - 3] === 13 && buffer[length - 2] === 10) ||
        (buffer[length - 3] === 10 && buffer[length - 2] === 13))
    ) return 3;
    return length >= 2 && buffer[length - 2] === 10 && buffer[length - 1] === 10 ? 2 : 0;
  };
  const decodeRecord = (recordLength: number): string => {
    if (recordLength > MAX_EVENT_BYTES) throw new Error("SSE event exceeded 8 MiB");
    const decoder = firstRecord ? firstDecoder : laterDecoder;
    firstRecord = false;
    return decoder.decode(buffer.subarray(0, recordLength));
  };
  try {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    while (true) {
      const { value, done } = await reader.read();
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      if (done) {
        naturalEnd = true;
        break;
      }
      streamBytes += value.byteLength;
      if (!Number.isSafeInteger(streamBytes) || streamBytes > MAX_STREAM_BYTES) {
        throw new Error("SSE stream exceeded 64 MiB");
      }
      for (const byte of value) {
        append(byte);
        const delimiterBytes = byte === 10 ? boundaryLength() : 0;
        if (delimiterBytes > 0) {
          streamEvents += 1;
          if (streamEvents > MAX_STREAM_EVENTS) throw new Error(`SSE stream exceeded ${MAX_STREAM_EVENTS} events`);
          const parsed = parseSseRecord(decodeRecord(length - delimiterBytes));
          length = 0;
          if (parsed) yield parsed;
        } else if (length > MAX_EVENT_BYTES + 3) {
          throw new Error("SSE event exceeded 8 MiB");
        }
      }
    }
    if (length > 0) {
      streamEvents += 1;
      if (streamEvents > MAX_STREAM_EVENTS) throw new Error(`SSE stream exceeded ${MAX_STREAM_EVENTS} events`);
      const raw = decodeRecord(length);
      const parsed = raw.trim() ? parseSseRecord(raw) : undefined;
      if (parsed) yield parsed;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!naturalEnd) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseSseRecord(raw: string): SseEvent | undefined {
  let event = "message";
  let id: string | undefined;
  let retry: number | undefined;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id" && !value.includes("\0")) id = value;
    else if (field === "retry" && /^\d+$/u.test(value)) retry = Number(value);
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join("\n"), ...(id === undefined ? {} : { id }), ...(retry === undefined ? {} : { retry }) };
}
