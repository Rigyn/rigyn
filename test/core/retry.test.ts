import assert from "node:assert/strict";
import test from "node:test";

import type { AdapterError } from "../../src/core/types.js";
import { isContextOverflowError } from "../../src/core/retry.js";

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
  ]) assert.equal(isContextOverflowError(candidate), false);
});
