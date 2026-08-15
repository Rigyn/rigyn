import { setTimeout as delay } from "node:timers/promises";
import { getOverflowPatterns, isContextOverflowText } from "@rigyn/models";
import type { AdapterError } from "./types.js";

export interface RetryPolicy {
  /** Automatic retries are enabled unless explicitly disabled. */
  enabled?: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  enabled: true,
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: 0.2,
};

const MAX_PROVIDER_TIMEOUT_MS = 2_147_483_647;

export interface ProviderAttemptBoundary {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

export function providerRetryPolicy(
  policy: RetryPolicy,
  maxRetries: number | undefined,
  maxRetryDelayMs?: number,
): RetryPolicy {
  let resolved = policy;
  if (maxRetries !== undefined) {
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("maxRetries must be a non-negative safe integer");
    }
    resolved = { ...resolved, maxAttempts: maxRetries + 1 };
  }
  if (maxRetryDelayMs !== undefined) {
    if (!Number.isSafeInteger(maxRetryDelayMs) || maxRetryDelayMs < 0) {
      throw new RangeError("maxRetryDelayMs must be a non-negative safe integer");
    }
    resolved = { ...resolved, maxDelayMs: maxRetryDelayMs };
  }
  return resolved;
}

export function validateProviderTimeoutMs(timeoutMs: number | undefined): void {
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_PROVIDER_TIMEOUT_MS)
  ) {
    throw new RangeError(`timeoutMs must be an integer from 0 to ${MAX_PROVIDER_TIMEOUT_MS}`);
  }
}

export function beginProviderAttempt(
  signal: AbortSignal,
  timeoutMs: number | undefined,
): ProviderAttemptBoundary {
  validateProviderTimeoutMs(timeoutMs);
  if (timeoutMs === undefined || timeoutMs === 0) {
    return { signal, timedOut: () => false, dispose() {} };
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error(`Provider request timed out after ${timeoutMs} ms`)), timeoutMs);
  timer.unref?.();
  return {
    signal: AbortSignal.any([signal, timeout.signal]),
    timedOut: () => timeout.signal.aborted,
    dispose: () => clearTimeout(timer),
  };
}

export function providerTimeoutError(timeoutMs: number, bodyStarted: boolean): AdapterError {
  return {
    category: "network",
    message: `Provider request timed out after ${timeoutMs} ms`,
    providerCode: "request_timeout",
    retryable: !bodyStarted,
    partial: bodyStarted,
    bodyStarted,
  };
}

export function retryDelay(
  error: AdapterError,
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  if (error.retryAfterMs !== undefined) {
    if (policy.maxDelayMs > 0 && error.retryAfterMs > policy.maxDelayMs) {
      throw new Error(
        `Provider requested ${Math.ceil(error.retryAfterMs / 1_000)}s retry delay (max: ${Math.ceil(policy.maxDelayMs / 1_000)}s)`,
      );
    }
    return error.retryAfterMs;
  }
  const uncapped = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const exponential = policy.maxDelayMs > 0 ? Math.min(policy.maxDelayMs, uncapped) : uncapped;
  const factor = 1 + (random() * 2 - 1) * policy.jitter;
  return Math.max(0, Math.round(exponential * factor));
}

export function mayRetry(error: AdapterError, attempt: number, policy: RetryPolicy, bodyStarted: boolean): boolean {
  return policy.enabled !== false &&
    (error.retryable || isRetryableProviderError(error)) &&
    !error.partial &&
    error.bodyStarted !== true &&
    !bodyStarted &&
    attempt < policy.maxAttempts;
}

const NON_RETRYABLE_LIMIT = /(?:go.?usage.?limit|free.?usage.?limit|monthly usage limit reached|available balance|insufficient[_ -]?quota|out of budget|quota exceeded|billing)/iu;
const RETRYABLE_PROVIDER_FAILURE = /(?:overloaded|rate.?limit|too many requests|\b(?:429|500|502|503|504|524)\b|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?(?:error|refused|lost)|other side closed|fetch failed|getaddrinfo|\bENOTFOUND\b|\bEAI_AGAIN\b|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?(?:closed|error)|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request|resource.?exhausted)/iu;

export function isRetryableProviderError(error: AdapterError): boolean {
  if (error.partial || error.bodyStarted === true || error.category === "cancelled") return false;
  const text = `${error.providerCode ?? ""} ${error.message}`.slice(0, 8_192);
  if (NON_RETRYABLE_LIMIT.test(text)) return false;
  return RETRYABLE_PROVIDER_FAILURE.test(text);
}

export function isContextOverflowError(error: AdapterError): boolean {
  if (error.partial || !["invalid_request", "provider"].includes(error.category)) return false;
  const code = (error.providerCode ?? "").toLowerCase().replace(/[^a-z0-9]+/gu, "_");
  const message = error.message.toLowerCase().slice(0, 4_096);
  const combined = `${code} ${message}`;
  if (
    /(?:rate[_ -]?limit|quota|billing|credits?|tokens? per minute|\btpm\b|throttl|overload|capacity|resource[_ -]?exhausted)/u
      .test(combined)
  ) return false;
  if (error.httpStatus === 413) return true;
  if (/(?:context_length_exceeded|context_window_exceeded|context_limit_exceeded|prompt_too_long|input_too_long|max_context_length)/u.test(code)) {
    return true;
  }
  return isContextOverflowText(message);
}

export function getContextOverflowPatterns(): readonly RegExp[] {
  return getOverflowPatterns();
}

export async function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  let remaining = milliseconds;
  while (remaining > MAX_PROVIDER_TIMEOUT_MS) {
    await delay(MAX_PROVIDER_TIMEOUT_MS, undefined, { signal });
    remaining -= MAX_PROVIDER_TIMEOUT_MS;
  }
  await delay(remaining, undefined, { signal });
}
