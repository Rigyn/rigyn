import { setTimeout as delay } from "node:timers/promises";
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

export function retryDelay(
  error: AdapterError,
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const server = error.retryAfterMs === undefined ? 0 : Math.min(error.retryAfterMs, policy.maxDelayMs);
  const base = Math.max(exponential, server);
  const factor = 1 + (random() * 2 - 1) * policy.jitter;
  return Math.max(0, Math.round(base * factor));
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
const RETRYABLE_PROVIDER_FAILURE = /(?:overloaded|rate.?limit|too many requests|\b(?:429|500|502|503|504|524)\b|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?(?:error|refused|lost)|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?(?:closed|error)|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request|resource.?exhausted)/iu;

export function isRetryableProviderError(error: AdapterError): boolean {
  if (error.partial || error.bodyStarted === true || error.category === "cancelled") return false;
  const text = `${error.providerCode ?? ""} ${error.message}`.slice(0, 8_192);
  if (NON_RETRYABLE_LIMIT.test(text)) return false;
  return RETRYABLE_PROVIDER_FAILURE.test(text);
}

const OVERFLOW_PATTERNS = [
  /prompt is too long/iu,
  /request_too_large/iu,
  /input is too long for requested model/iu,
  /exceeds the context window/iu,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/iu,
  /input token count.*exceeds the maximum/iu,
  /input tokens? exceed/iu,
  /maximum prompt length is \d+/iu,
  /reduce the length of the messages/iu,
  /maximum context length is \d+ tokens/iu,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/iu,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/iu,
  /exceeds the limit of \d+/iu,
  /exceeds the available context size/iu,
  /greater than the context length/iu,
  /context window exceeds limit/iu,
  /exceeded model token limit/iu,
  /too large for model with \d+ maximum context length/iu,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/iu,
  /model_context_window_exceeded/iu,
  /prompt too long; exceeded (?:max )?context length/iu,
  /range of input length should be/iu,
  /context[_ ]length[_ ]exceeded/iu,
  /too many tokens/iu,
  /token limit exceeded/iu,
  /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/iu,
] as const;

const NON_OVERFLOW_PATTERNS = [
  /^(?:throttling error|service unavailable):/iu,
  /rate limit/iu,
  /too many requests/iu,
] as const;

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
  if (NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))) return false;
  if (/(?:context_length_exceeded|context_window_exceeded|context_limit_exceeded|prompt_too_long|input_too_long|max_context_length)/u.test(code)) {
    return true;
  }
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}

export function getContextOverflowPatterns(): readonly RegExp[] {
  return [...OVERFLOW_PATTERNS];
}

export async function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  await delay(milliseconds, undefined, { signal });
}
