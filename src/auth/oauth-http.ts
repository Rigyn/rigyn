import { parseJsonRecord, requestBounded } from "./cloud-http.js";

export const OAUTH_HTTP_TIMEOUT_MS = 30_000;
export const OAUTH_MAX_RESPONSE_BYTES = 64 * 1024;

export interface OAuthJsonResponse {
  ok: boolean;
  status: number;
  value: Record<string, unknown>;
}

/** Execute a secret-bearing OAuth request with fixed redirect, time, and body bounds. */
export async function requestOAuthJson(
  input: string | URL,
  init: RequestInit,
  options: {
    label: string;
    fetch?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<OAuthJsonResponse> {
  const response = await requestBounded(input, { ...init, redirect: "error" }, {
    fetch: options.fetch ?? fetch,
    timeoutMs: options.timeoutMs ?? OAUTH_HTTP_TIMEOUT_MS,
    maxResponseBytes: OAUTH_MAX_RESPONSE_BYTES,
    label: options.label,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return {
    ok: response.ok,
    status: response.status,
    value: parseJsonRecord(response.text, options.label),
  };
}
