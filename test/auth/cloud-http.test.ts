import assert from "node:assert/strict";
import test from "node:test";

import { CloudAuthIoError, requestBounded } from "../../src/auth/cloud-http.js";

test("cloud auth HTTP reader enforces its byte limit while streaming", async () => {
  await assert.rejects(
    requestBounded("https://example.invalid", {}, {
      fetch: (async () => new Response("x".repeat(1024))) as typeof fetch,
      timeoutMs: 1000,
      maxResponseBytes: 32,
      label: "test cloud auth",
    }),
    (error: unknown) => {
      assert.ok(error instanceof CloudAuthIoError);
      assert.equal(error.kind, "response_limit");
      assert.doesNotMatch(error.message, /x{4}/);
      return true;
    },
  );
});

test("cloud auth HTTP errors do not include URLs that might contain secrets", async () => {
  await assert.rejects(
    requestBounded("https://example.invalid/token?secret=value", {}, {
      fetch: (async () => {
        throw new Error("https://example.invalid/token?secret=value");
      }) as typeof fetch,
      timeoutMs: 1000,
      maxResponseBytes: 1024,
      label: "test cloud auth",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /secret=value|example\.invalid/);
      return true;
    },
  );
});
