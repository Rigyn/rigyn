export type ProviderErrorCategory = "authentication" | "permission" | "rate_limit" | "invalid_request" | "not_found" | "overloaded" | "network" | "timeout" | "protocol" | "cancelled" | "provider";
export interface ProviderResponseDiagnostics { status: number; headers: Record<string, string>; }
export interface ProviderFailureDiagnosticDetails extends Record<string, unknown> {
  category: ProviderErrorCategory; retryable: boolean; partial: boolean; bodyStarted?: boolean;
  httpStatus?: number; providerCode?: string; requestId?: string; retryAfterMs?: number;
  response?: ProviderResponseDiagnostics;
}
export interface DiagnosticErrorInfo { name?: string; message: string; code?: string; status?: number; }
export interface AssistantMessageDiagnostic { type: string; message: string; error?: DiagnosticErrorInfo; details?: Record<string, unknown>; timestamp: number; }
export function formatThrownValue(value: unknown): string { if (value instanceof Error) return value.message; if (typeof value === "string") return value; try { return JSON.stringify(value); } catch { return String(value); } }
export function extractDiagnosticError(error: unknown): DiagnosticErrorInfo {
  if (!(error instanceof Error)) return { message: formatThrownValue(error) };
  const record = error as Error & { code?: unknown; status?: unknown };
  return { name: error.name, message: error.message, ...(typeof record.code === "string" ? { code: record.code } : {}), ...(typeof record.status === "number" ? { status: record.status } : {}) };
}
export function createAssistantMessageDiagnostic(type: string, message: string, error?: unknown): AssistantMessageDiagnostic { return { type, message, ...(error === undefined ? {} : { error: extractDiagnosticError(error) }), timestamp: Date.now() }; }
export function appendAssistantMessageDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(target: T, diagnostic: AssistantMessageDiagnostic): T { return { ...target, diagnostics: [...(target.diagnostics ?? []), diagnostic] }; }

const allowedResponseHeaders = new Set([
  "content-type", "request-id", "x-request-id", "apim-request-id", "x-amzn-requestid", "x-amzn-request-id", "x-generation-id", "x-goog-request-id", "cf-ray", "retry-after",
  "x-ratelimit-limit-requests", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens",
  "anthropic-ratelimit-requests-limit", "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-requests-reset", "anthropic-ratelimit-tokens-limit", "anthropic-ratelimit-tokens-remaining", "anthropic-ratelimit-tokens-reset",
]);
const utf8 = new TextEncoder();
function boundedText(value: string, maximum: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  let output = ""; let bytes = 0;
  for (const character of normalized) { const size = utf8.encode(character).byteLength; if (bytes + size > maximum) break; output += character; bytes += size; }
  return output;
}
export function canonicalProviderResponseDiagnostics(status: number, headers: Iterable<readonly [string, string]>): ProviderResponseDiagnostics {
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) throw new TypeError("Provider response diagnostic status must be an HTTP status code");
  const selected: Record<string, string> = {}; let retained = 0;
  for (const [rawName, rawValue] of headers) {
    const name = rawName.toLowerCase(); if (!allowedResponseHeaders.has(name) || Object.hasOwn(selected, name)) continue;
    const value = boundedText(rawValue, 2 * 1_024); const size = utf8.encode(name).byteLength + utf8.encode(value).byteLength;
    if (retained + size > 16 * 1_024) break; selected[name] = value; retained += size;
  }
  return { status, headers: selected };
}
export function providerRequestId(response: ProviderResponseDiagnostics): string | undefined {
  for (const name of ["x-request-id", "request-id", "apim-request-id", "x-amzn-requestid", "x-amzn-request-id", "x-generation-id", "x-goog-request-id"]) {
    const value = response.headers[name]; if (value) return value;
  }
  return undefined;
}
export function providerResponseDiagnostic(response: ProviderResponseDiagnostics): AssistantMessageDiagnostic {
  const requestId = providerRequestId(response);
  return { type: "provider_response", message: "Provider response received", details: { response, ...(requestId === undefined ? {} : { requestId }) }, timestamp: Date.now() };
}
export function providerFailureDiagnostic(details: ProviderFailureDiagnosticDetails): AssistantMessageDiagnostic {
  return { type: "provider_failure", message: "Provider request failed", details, timestamp: Date.now() };
}
