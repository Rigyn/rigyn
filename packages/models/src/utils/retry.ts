import type { AssistantMessage } from "../types.js";

const permanent = /(?:GoUsageLimitError|FreeUsageLimitError|monthly usage limit|available balance|insufficient_quota|out of budget|quota exceeded|billing)/iu;
const transient = /(?:overloaded|rate.?limit|too many requests|\b(?:429|500|502|503|504|524)\b|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?(?:error|refused|lost)|other side closed|fetch failed|upstream.?connect|reset before headers|socket (?:hang up|connection was closed)|timed? out|timeout|terminated|websocket.?(?:closed|error)|ended without|stream ended before (?:message_stop|a terminal response event)|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request|ResourceExhausted)/iu;

export interface RetryPolicy {
  enabled: boolean;
  /** Number of retries after the initial call. */
  maxRetries: number;
  /** Delay before retry one; later delays double for each attempt. */
  baseDelayMs: number;
}

export interface RetryCallbacks {
  onRetryScheduled?: (attempt: number, maxAttempts: number, delayMs: number, errorMessage: string) => void | Promise<void>;
  onRetryAttemptStart?: () => void | Promise<void>;
  onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {}

function sleep(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RetrySleepAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new RetrySleepAbortError());
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function retryAssistantCall(
  produce: () => Promise<AssistantMessage>,
  policy: RetryPolicy | undefined,
  signal: AbortSignal | undefined,
  callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
  const maxAttempts = policy?.enabled ? policy.maxRetries : 0;
  let attempt = 0;
  let lastRetry: { attempt: number; errorMessage: string } | undefined;

  for (;;) {
    const response = await produce();
    if (response.stopReason === "aborted") {
      if (lastRetry !== undefined) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
      return response;
    }
    if (response.stopReason !== "error") {
      if (lastRetry !== undefined) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
      return response;
    }
    if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
      if (lastRetry !== undefined) {
        await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
      }
      return response;
    }

    attempt += 1;
    lastRetry = { attempt, errorMessage: response.errorMessage ?? "Unknown error" };
    const delayMs = policy!.baseDelayMs * 2 ** (attempt - 1);
    await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);
    try {
      await sleep(delayMs, signal);
    } catch (error) {
      await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
      if (!(error instanceof RetrySleepAbortError)) throw error;
      const aborted: AssistantMessage = { ...response, stopReason: "aborted" };
      delete aborted.errorMessage;
      return aborted;
    }
    await callbacks?.onRetryAttemptStart?.();
  }
}

export function isRetryableAssistantError(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || !message.errorMessage || permanent.test(message.errorMessage)) return false;
  return transient.test(message.errorMessage);
}
