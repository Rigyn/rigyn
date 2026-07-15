import assert from "node:assert/strict";
import test from "node:test";

import { SecretRedactor } from "../../src/auth/redaction.js";

test("redacts registered secrets and common credential fields", () => {
  const redactor = new SecretRedactor();
  redactor.register("sk-example-secret");

  const text = redactor.redact(
    "key=sk-example-secret Authorization: Bearer token-value x-api-key=another-key refresh_token=refresh-me",
  );
  assert.doesNotMatch(text, /sk-example-secret|token-value|another-key|refresh-me/);
  assert.match(text, /\[REDACTED\]/);

  assert.deepEqual(
    redactor.redactValue({ nested: ["sk-example-secret"], accessToken: "different-secret", safe: "ok" }),
    { nested: ["[REDACTED]"], accessToken: "[REDACTED]", safe: "ok" },
  );
});

test("does not register very short values that would destroy ordinary logs", () => {
  const redactor = new SecretRedactor();
  redactor.register("abc");
  assert.equal(redactor.redact("abc alphabet"), "abc alphabet");
});

test("common standalone credential shapes are redacted without prior registration", () => {
  const redactor = new SecretRedactor();
  const values = [
    ["sk", "proj", "1234567890abcdefghijkl"].join("-"),
    ["ghp", "1234567890abcdefghijklmnop"].join("_"),
    ["AKIA", "1234567890ABCDEF"].join(""),
  ];
  const value = redactor.redact(values.join(" "));
  assert.equal(value, "[REDACTED] [REDACTED] [REDACTED]");
});

test("registered-secret memory is explicitly bounded without silently accepting unprotected values", () => {
  const redactor = new SecretRedactor({ maxSecrets: 2, maxSecretBytes: 32, maxTotalBytes: 32 });
  redactor.register("first-secret");
  redactor.register("second-secret");
  redactor.register("second-secret");
  assert.throws(() => redactor.register("third-secret"), /capacity exceeded/u);
  assert.throws(() => new SecretRedactor({ maxSecrets: 1, maxSecretBytes: 4, maxTotalBytes: 4 }).register("too-large"), /item capacity/u);
  assert.equal(redactor.redact("first-secret second-secret"), "[REDACTED] [REDACTED]");
});

test("structured redaction is cycle-, accessor-, and prototype-safe", () => {
  const redactor = new SecretRedactor();
  const shared = { path: "src/math.mjs" };
  const value: Record<string, unknown> = {
    safe: "ok",
    accessToken: "secret-value",
    first: shared,
    second: shared,
  };
  value.self = value;
  Object.defineProperty(value, "computed", { enumerable: true, get: () => { throw new Error("must not run"); } });
  Object.defineProperty(value, "__proto__", { enumerable: true, value: { polluted: true } });
  const redacted = redactor.redactValue(value) as Record<string, unknown>;
  assert.equal(redacted.accessToken, "[REDACTED]");
  assert.deepEqual(redacted.first, shared);
  assert.deepEqual(redacted.second, shared);
  assert.equal(redacted.self, "[Circular]");
  assert.equal(redacted.computed, "[Accessor]");
  assert.deepEqual(redacted.__proto__, { polluted: true });
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});
