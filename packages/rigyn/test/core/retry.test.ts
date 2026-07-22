import assert from "node:assert/strict";
import test from "node:test";

import type { AdapterError } from "../../src/core/types.js";
import { isContextOverflowError, isRetryableProviderError, mayRetry } from "../../src/core/retry.js";

function error(overrides: Partial<AdapterError>): AdapterError {
  return {
    category: "invalid_request",
    message: "bad request",
    retryable: false,
    partial: false,
    ...overrides,
  };
}

test("context overflow classifier recognizes bounded provider codes, messages, and 413", () => {
  for (const candidate of [
    error({ providerCode: "context_length_exceeded" }),
    error({ providerCode: "PROMPT-TOO-LONG" }),
    error({ message: "This model's maximum context length is 128000 tokens" }),
    error({ message: "Input tokens exceed the model token limit" }),
    error({ message: "Please reduce the length of the messages" }),
    error({ message: "The input token count (2000) exceeds the maximum number of tokens allowed (1000)" }),
    error({ message: "This model's maximum prompt length is 131072 but the request contains more" }),
    error({ message: "The input (2000 tokens) is longer than the model's context length (1000 tokens)" }),
    error({ message: "Prompt has 2,000 tokens, but the configured context size is 1,000 tokens" }),
    error({ message: "Range of input length should be [1, 32768]" }),
    error({ message: "413 status code (no body)" }),
    error({ httpStatus: 413, message: "Payload Too Large" }),
  ]) assert.equal(isContextOverflowError(candidate), true);
});

test("context overflow classifier excludes quota, rate-limit, partial, and unrelated request errors", () => {
  for (const candidate of [
    error({ category: "rate_limit", providerCode: "context_length_exceeded", message: "rate limit" }),
    error({ providerCode: "context_length_exceeded", message: "token quota exhausted" }),
    error({ message: "tokens per minute limit exceeded" }),
    error({ message: "maximum context length", partial: true }),
    error({ httpStatus: 400, message: "Bad Request" }),
    error({ category: "authentication", message: "maximum context length" }),
    error({ message: "Throttling error: Too many tokens, please wait before trying again" }),
    error({ message: "Too many requests: token limit exceeded" }),
  ]) assert.equal(isContextOverflowError(candidate), false);
});

test("retry classifier covers transport and provider guidance but excludes account limits", () => {
  for (const candidate of [
    error({ message: "WebSocket closed before a terminal response event" }),
    error({ message: "HTTP2 request did not get a response" }),
    error({ message: "Provider returned error: please retry your request" }),
    error({ message: "upstream connect error: reset before headers" }),
    error({ message: "ResourceExhausted" }),
  ]) assert.equal(isRetryableProviderError(candidate), true);

  for (const candidate of [
    error({ message: "insufficient_quota" }),
    error({ message: "Monthly usage limit reached; enable available balance" }),
    error({ message: "billing quota exceeded" }),
    error({ message: "connection lost", partial: true }),
    error({ message: "timeout", category: "cancelled" }),
  ]) assert.equal(isRetryableProviderError(candidate), false);
});

test("retry policy applies semantic classification without retrying partial output", () => {
  const policy = { enabled: true, maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 };
  assert.equal(mayRetry(error({ message: "fetch failed", retryable: false }), 1, policy, false), true);
  assert.equal(mayRetry(error({ message: "fetch failed", retryable: false, partial: true }), 1, policy, false), false);
  assert.equal(mayRetry(error({ message: "fetch failed", retryable: false }), 3, policy, false), false);
});
