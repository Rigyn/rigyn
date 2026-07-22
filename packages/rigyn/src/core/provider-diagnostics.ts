import type { ProviderResponseDiagnostics } from "./types.js";

const MAX_HEADER_VALUE_BYTES = 2 * 1024;
const MAX_DIAGNOSTIC_HEADER_BYTES = 16 * 1024;

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
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Provider response diagnostics must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "status" && key !== "headers")) {
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
