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

test("credential-bearing URLs are redacted without prior registration", () => {
  const redactor = new SecretRedactor();
  const value = redactor.redact(
    "https://alice:password@example.invalid/callback?code=oauth-code&secret=query-secret wss://bob:token@example.invalid/socket",
  );
  assert.equal(
    value,
    "https://[REDACTED]@example.invalid/callback?code=[REDACTED]&secret=[REDACTED] wss://[REDACTED]@example.invalid/socket",
  );
});

test("secret-value detection ignores field names and recognizes only registered or credential-shaped values", () => {
  const redactor = new SecretRedactor();
  const benign = {
    token: "opaque cursor",
    secret: "provider label",
    password: "continuation marker",
  };
  assert.equal(redactor.containsSecretValue(benign), false);
  assert.deepEqual(redactor.redactValue(benign), {
    token: "[REDACTED]",
    secret: "[REDACTED]",
    password: "[REDACTED]",
  });

  const registered = "registered-provider-credential";
  redactor.register(registered);
  assert.equal(redactor.containsSecretValue({ continuation: `prefix:${registered}:suffix` }), true);
  assert.equal(
    redactor.containsSecretValue({ continuation: ["sk", "proj", "1234567890abcdefghijkl"].join("-") }),
    true,
  );
  assert.equal(redactor.containsSecretValue(benign), false);
});

test("secret-value detection is cycle-safe and fails closed at its traversal bound", () => {
  const redactor = new SecretRedactor();
  const cyclic: Record<string, unknown> = { value: "ordinary" };
  cyclic.self = cyclic;
  assert.equal(redactor.containsSecretValue(cyclic), false);
  assert.equal(redactor.containsSecretValue(Array.from({ length: 10_001 }, () => null)), true);
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

test("structured redaction fails closed for hostile and unbounded containers without executing user code", () => {
  const redactor = new SecretRedactor();
  let getterCalls = 0;
  const accessorArray: unknown[] = [];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-run";
    },
  });
  accessorArray.length = 1;
  assert.deepEqual(redactor.redactValue(accessorArray), ["[Accessor]"]);
  assert.equal(redactor.containsSecretValue(accessorArray), true);
  assert.equal(getterCalls, 0);

  let proxyTrapCalls = 0;
  const hostile = new Proxy({}, {
    getPrototypeOf() {
      proxyTrapCalls += 1;
      throw new Error("must-not-run");
    },
    ownKeys() {
      proxyTrapCalls += 1;
      throw new Error("must-not-run");
    },
  });
  assert.equal(redactor.containsSecretValue(hostile), true);
  assert.equal(redactor.redactValue(hostile), "[Truncated]");
  assert.equal(proxyTrapCalls, 0);

  const sparse: unknown[] = [];
  sparse.length = 1_000_000;
  assert.equal(redactor.containsSecretValue(sparse), true);
  assert.equal(redactor.redactValue(sparse), "[Truncated]");

  let toJsonCalls = 0;
  const inherited = Object.assign(Object.create({
    toJSON() {
      toJsonCalls += 1;
      return { rewritten: true };
    },
  }) as Record<string, unknown>, { safe: true });
  assert.equal(redactor.containsSecretValue(inherited), true);
  assert.equal(redactor.redactValue(inherited), "[Truncated]");
  assert.equal(toJsonCalls, 0);
});
