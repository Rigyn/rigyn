import type { Model, ProviderHeaders, ProviderResponse, StreamOptions } from "../../types.js";
import { canonicalProviderResponseDiagnostics, providerRequestId, type ProviderErrorCategory, type ProviderFailureDiagnosticDetails, type ProviderResponseDiagnostics } from "../../utils/diagnostics.js";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.js";
import { resolveHttpProxyUrlForTarget } from "../../utils/node-http-proxy.js";

export interface SseRecord { event?: string; data: string; id?: string; dispatchedAtEof?: true; }

export class HttpProviderError extends Error {
  constructor(readonly status: number, readonly responseBody: string, readonly responseHeaders: Record<string, string>, message?: string) {
    super(message ?? `Provider request failed with HTTP ${status}${responseBody ? `: ${responseBody}` : ""}`);
    this.name = "HttpProviderError";
  }
}
export class PrematureProviderEofError extends Error { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "PrematureProviderEofError"; } }
export class ProviderProtocolError extends Error { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "ProviderProtocolError"; } }
export class ProviderStreamError extends Error {
  constructor(message: string, readonly providerCode?: string, options?: ErrorOptions) { super(message, options); this.name = "ProviderStreamError"; }
}

function record(headers: Headers): Record<string, string> { return Object.fromEntries(headers.entries()); }
function cleanHeaders(headers?: ProviderHeaders): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) if (value !== null) output[name] = value;
  return output;
}
function retryable(error: unknown): boolean {
  if (error instanceof HttpProviderError) return error.status === 408 || error.status === 409 || error.status === 425 || error.status === 429 || error.status >= 500;
  return error instanceof TypeError || error instanceof PrematureProviderEofError;
}
function retryableStatus(status: number): boolean { return [408, 409, 425, 429, 500, 502, 503, 504, 529].includes(status); }
function categoryForStatus(status: number): ProviderErrorCategory {
  if (status === 401) return "authentication"; if (status === 402 || status === 403) return "permission"; if (status === 404) return "not_found";
  if (status === 408 || status === 504) return "timeout"; if (status === 429) return "rate_limit"; if ([500, 502, 503, 529].includes(status)) return "overloaded";
  if (status >= 400 && status < 500) return "invalid_request"; return "provider";
}
function categoryForCode(code: string | undefined): ProviderErrorCategory {
  const value = code?.toLowerCase() ?? ""; if (value.includes("auth") || value.includes("api_key")) return "authentication";
  if (value.includes("permission") || value.includes("forbidden")) return "permission"; if (value.includes("rate") || value.includes("throttl")) return "rate_limit";
  if (value.includes("invalid") || value.includes("malformed")) return "invalid_request"; if (value.includes("not_found")) return "not_found";
  if (value.includes("overload") || value.includes("unavailable") || value.includes("server")) return "overloaded"; if (value.includes("timeout") || value.includes("deadline")) return "timeout";
  return "provider";
}
function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (typeof error !== "object" || error === null) return false; const value = error as { name?: unknown; code?: unknown };
  return value.name === "AbortError" || value.code === "ABORT_ERR";
}
function retryAfterMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined; const seconds = Number(value); if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const timestamp = Date.parse(value); return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}
export function responseDiagnostics(response: Response): ProviderResponseDiagnostics { return canonicalProviderResponseDiagnostics(response.status, response.headers.entries()); }
export function failureDiagnosticDetails(error: unknown, options: { partial: boolean; aborted?: boolean; response?: ProviderResponseDiagnostics; bodyStarted?: boolean }): ProviderFailureDiagnosticDetails {
  const response = error instanceof HttpProviderError ? canonicalProviderResponseDiagnostics(error.status, Object.entries(error.responseHeaders)) : options.response;
  const requestId = response === undefined ? undefined : providerRequestId(response);
  if (options.aborted || isAbortError(error)) return { category: "cancelled", retryable: false, partial: options.partial, ...(options.partial ? { bodyStarted: true } : {}), ...(requestId === undefined ? {} : { requestId }), ...(response === undefined ? {} : { response }) };
  if (error instanceof PrematureProviderEofError) return { category: "network", retryable: !options.partial, partial: options.partial, ...(options.partial ? { bodyStarted: true } : {}), ...(requestId === undefined ? {} : { requestId }), ...(response === undefined ? {} : { response }) };
  if (error instanceof ProviderProtocolError) return { category: "protocol", retryable: false, partial: options.partial, bodyStarted: true, ...(requestId === undefined ? {} : { requestId }), ...(response === undefined ? {} : { response }) };
  if (error instanceof HttpProviderError) {
    const wait = retryAfterMs(response?.headers["retry-after"]); return { category: categoryForStatus(error.status), retryable: retryableStatus(error.status), partial: options.partial, httpStatus: error.status, ...(requestId === undefined ? {} : { requestId }), ...(wait === undefined ? {} : { retryAfterMs: wait }), ...(response === undefined ? {} : { response }) };
  }
  if (error instanceof ProviderStreamError) return { category: categoryForCode(error.providerCode), retryable: ["rate_limit", "overloaded", "timeout"].includes(categoryForCode(error.providerCode)), partial: options.partial, bodyStarted: true, ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }), ...(requestId === undefined ? {} : { requestId }), ...(response === undefined ? {} : { response }) };
  const network = error instanceof TypeError; return { category: network ? "network" : "provider", retryable: network && !options.partial, partial: options.partial, ...(options.bodyStarted ? { bodyStarted: true } : {}), ...(requestId === undefined ? {} : { requestId }), ...(response === undefined ? {} : { response }) };
}
function retryAfter(error: unknown): number | undefined {
  if (!(error instanceof HttpProviderError)) return undefined;
  const value = error.responseHeaders["retry-after"];
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal) setTimeout(() => signal.removeEventListener("abort", abort), milliseconds);
  });
}

export async function providerFetch<TApi extends string>(input: {
  model: Model<TApi>;
  url: string;
  body: unknown;
  options?: StreamOptions;
  headers?: HeadersInit;
  fetch?: typeof fetch;
  accept?: string;
}): Promise<Response> {
  const timeout = input.options?.timeoutMs === undefined ? undefined : AbortSignal.timeout(input.options.timeoutMs);
  const signals = [input.options?.signal, timeout].filter((signal): signal is AbortSignal => signal !== undefined);
  const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  const headers = new Headers(input.headers);
  for (const [name, value] of Object.entries(cleanHeaders(input.options?.headers))) headers.set(name, value);
  headers.set("content-type", "application/json");
  headers.set("accept", input.accept ?? "text/event-stream");
  const retries = Math.max(0, Math.min(10, input.options?.maxRetries ?? 2));
  const selectedFetch = input.options?.fetch ?? input.fetch;
  const proxy = selectedFetch === undefined ? resolveHttpProxyUrlForTarget(input.url, input.options?.env) : undefined;
  const dispatcher = proxy === undefined ? undefined : new (await import("undici")).ProxyAgent(proxy.href);
  for (let attempt = 0;; attempt += 1) {
      signal?.throwIfAborted();
      try {
        let payload: unknown = input.body;
        payload = await input.options?.onPayload?.(payload, input.model) ?? payload;
        const init = { method: "POST", headers, body: JSON.stringify(payload), ...(signal === undefined ? {} : { signal }), redirect: "error", ...(dispatcher === undefined ? {} : { dispatcher }) } as RequestInit;
        const response = await (selectedFetch ?? fetch)(input.url, init);
        const info: ProviderResponse = { status: response.status, headers: record(response.headers) };
        await input.options?.onResponse?.(info, input.model);
        if (!response.ok) {
          const body = sanitizeSurrogates((await response.text()).slice(0, 8_000));
          throw new HttpProviderError(response.status, body, info.headers);
        }
        return response;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (attempt >= retries || !retryable(error)) throw error;
        const maximum = Math.max(0, input.options?.maxRetryDelayMs ?? 60_000);
        const wait = Math.min(maximum, retryAfter(error) ?? 250 * 2 ** attempt + Math.floor(Math.random() * 100));
        await delay(wait, signal);
      }
    }
}

export async function* readSse(response: Response): AsyncIterable<SseRecord> {
  if (response.body === null) throw new PrematureProviderEofError("Provider returned an empty streaming body");
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  const dispatch = (atEof = false): SseRecord | undefined => {
    if (data.length === 0) { event = undefined; id = undefined; return undefined; }
    const output: SseRecord = { data: data.join("\n"), ...(event === undefined ? {} : { event }), ...(id === undefined ? {} : { id }), ...(atEof ? { dispatchedAtEof: true as const } : {}) };
    data = []; event = undefined; id = undefined; return output;
  };
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true });
    while (true) {
      const match = /\r?\n/u.exec(buffer);
      if (match === null) break;
      const line = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      if (line === "") { const record_ = dispatch(); if (record_) yield record_; continue; }
      if (line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const name = separator < 0 ? line : line.slice(0, separator);
      const raw = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /u, "");
      if (name === "data") data.push(raw); else if (name === "event") event = raw; else if (name === "id" && !raw.includes("\0")) id = raw;
    }
  }
  buffer += decoder.decode();
  if (buffer !== "") {
    const separator = buffer.indexOf(":"); const name = separator < 0 ? buffer : buffer.slice(0, separator); const raw = separator < 0 ? "" : buffer.slice(separator + 1).replace(/^ /u, "");
    if (name === "data") data.push(raw); else if (name === "event") event = raw;
  }
  const record_ = dispatch(true); if (record_) yield record_;
}
