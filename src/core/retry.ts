import { setTimeout as delay } from "node:timers/promises";
import type { AdapterError } from "./types.js";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
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
  return error.retryable && !error.partial && error.bodyStarted !== true && !bodyStarted && attempt < policy.maxAttempts;
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
  if (
    /(?:context_length_exceeded|context_window_exceeded|context_limit_exceeded|prompt_too_long|input_too_long|max_context_length)/u
      .test(code)
  ) return true;
  return /(?:maximum context length|context window (?:is )?(?:full|exceeded|too small)|context length exceeded|prompt (?:is )?too long|too many (?:input )?tokens|input tokens? exceed|exceeds? (?:the )?(?:model )?token limit|reduce (?:the )?(?:length|number) of (?:the )?messages)/u
    .test(message);
}

export async function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  await delay(milliseconds, undefined, { signal });
}
