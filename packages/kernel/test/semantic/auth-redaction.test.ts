import assert from "node:assert/strict";
import test from "node:test";

import { SecretRedactor } from "../../src/runtime/auth/redaction.js";

test("registered-secret ordering is longest-first and refreshes after registration", () => {
  const redactor = new SecretRedactor();
  redactor.register("token-value");
  assert.equal(redactor.redact("token-value"), "[REDACTED]");

  redactor.register("prefix-token-value");
  assert.equal(redactor.redact("prefix-token-value"), "[REDACTED]");
});

test("payload redaction omits secret-bearing object keys without changing schema redaction", () => {
  const redactor = new SecretRedactor();
  const secretKey = "registered-payload-key";
  const builtinKey = ["sk", "proj", "1234567890abcdefghijkl"].join("-");
  redactor.register(secretKey);

  const payload = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(payload, secretKey, { enumerable: true, value: "registered" });
  Object.defineProperty(payload, builtinKey, { enumerable: true, value: "builtin" });
  Object.defineProperty(payload, "[REDACTED]", { enumerable: true, value: "literal" });
  Object.defineProperty(payload, "safe", { enumerable: true, value: { [secretKey]: "nested", value: secretKey } });
  Object.defineProperty(payload, "computed", { enumerable: true, get: () => { throw new Error("must not run"); } });
  Object.defineProperty(payload, "__proto__", { enumerable: true, value: { clean: true } });

  const redacted = redactor.redactPayloadValue(payload) as Record<string, unknown>;
  assert.deepEqual(Object.keys(redacted).sort(), ["[REDACTED]", "__proto__", "computed", "safe"]);
  assert.equal(redacted["[REDACTED]"], "literal");
  assert.deepEqual(redacted.safe, { value: "[REDACTED]" });
  assert.equal(redacted.computed, "[Accessor]");
  assert.deepEqual(redacted.__proto__, { clean: true });
  assert.deepEqual(redactor.redactValue({ [secretKey]: "kept-key" }), { [secretKey]: "kept-key" });
  assert.equal(({} as { clean?: boolean }).clean, undefined);
});
