import assert from "node:assert/strict";
import test from "node:test";

import { createAssistantMessageDiagnostic } from "@rigyn/models";

import { defaultSecretRedactor } from "../../src/auth/redaction.js";
import { canonicalAssistantDiagnostics } from "../../src/core/assistant-diagnostics.js";

test("assistant diagnostics retain compatible error metadata within the redacted boundary", () => {
  const secret = "sk-proj-abcdefghijklmnop";
  const error = Object.assign(new Error(`provider failed for ${secret}`), { code: 429 });
  error.stack = `Error: provider failed\n    at ${secret}`;

  const diagnostic = createAssistantMessageDiagnostic("provider_failure", error, { authorization: secret });
  const canonical = canonicalAssistantDiagnostics([diagnostic]);

  assert.equal(canonical?.[0]?.message, undefined);
  assert.equal(canonical?.[0]?.error?.code, 429);
  assert.equal(canonical?.[0]?.error?.stack, undefined);
  assert.deepEqual(canonical?.[0]?.details, { authorization: "[REDACTED]" });
  assert.doesNotMatch(JSON.stringify(canonical), new RegExp(secret, "u"));
});

test("assistant diagnostic details omit registered secrets used as payload keys", () => {
  const secretKey = "assistant-diagnostic-secret-key";
  defaultSecretRedactor.register(secretKey);

  const canonical = canonicalAssistantDiagnostics([{
    type: "provider_failure",
    details: { safe: "visible", [secretKey]: "hidden" },
    timestamp: 1,
  }]);

  assert.deepEqual(canonical?.[0]?.details, { safe: "visible" });
  assert.doesNotMatch(JSON.stringify(canonical), new RegExp(secretKey, "u"));
});
