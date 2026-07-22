import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalProviderResponseDiagnostics,
  validateProviderResponseDiagnostics,
} from "../../src/core/provider-diagnostics.js";

test("provider response diagnostics retain only bounded allowlisted headers", () => {
  const diagnostics = canonicalProviderResponseDiagnostics(429, [
    ["Content-Type", " application/json\r\n injected "],
    ["Retry-After", "30"],
    ["Authorization", "Bearer must-not-escape"],
    ["Set-Cookie", "session=must-not-escape"],
    ["X-Unlisted-Provider-Metadata", "private"],
  ]);
  assert.deepEqual(diagnostics, {
    status: 429,
    headers: { "content-type": "application/json injected", "retry-after": "30" },
  });
});

test("custom provider diagnostics are revalidated at the core boundary", () => {
  assert.deepEqual(validateProviderResponseDiagnostics({
    status: 200,
    headers: { "x-request-id": "request-1", authorization: "hidden" },
  }), {
    status: 200,
    headers: { "x-request-id": "request-1" },
  });
  assert.throws(
    () => validateProviderResponseDiagnostics({ status: 200, headers: {}, body: "forbidden" }),
    /unsupported fields/u,
  );
  assert.throws(
    () => validateProviderResponseDiagnostics({ status: 99, headers: {} }),
    /HTTP status/u,
  );
});
