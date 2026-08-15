import assert from "node:assert/strict";
import test from "node:test";

import { canonicalAssistantDiagnostics } from "../../src/runtime/core/assistant-diagnostics.js";

function diagnostic(details: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "provider_failure", details, timestamp: 1 };
}

test("assistant diagnostics reject hostile envelopes without invoking caller code", () => {
  let calls = 0;
  const item = { type: "provider_failure", timestamp: 1 };
  Object.defineProperty(item, "message", {
    enumerable: true,
    get() {
      calls += 1;
      return "must not run";
    },
  });
  assert.throws(() => canonicalAssistantDiagnostics([item]), /data properties|accessor/u);
  assert.equal(calls, 0);

  const details: Record<string, unknown> = {};
  Object.defineProperty(details, "value", {
    enumerable: true,
    get() {
      calls += 1;
      return "must not run";
    },
  });
  assert.throws(() => canonicalAssistantDiagnostics([diagnostic(details)]), /data properties|accessor/u);
  assert.equal(calls, 0);

  const error = { message: "safe" };
  Object.defineProperty(error, "name", {
    enumerable: true,
    get() {
      calls += 1;
      return "must not run";
    },
  });
  assert.throws(
    () => canonicalAssistantDiagnostics([{ type: "provider_failure", error, timestamp: 1 }]),
    /data properties|accessor/u,
  );
  assert.equal(calls, 0);

  const outer: unknown[] = [];
  Object.defineProperty(outer, "0", {
    configurable: true,
    enumerable: true,
    get() {
      calls += 1;
      return diagnostic();
    },
  });
  outer.length = 1;
  assert.throws(() => canonicalAssistantDiagnostics(outer), /data properties|accessor/u);
  assert.equal(calls, 0);

  const proxied = new Proxy([diagnostic()], {
    getOwnPropertyDescriptor() {
      calls += 1;
      throw new Error("must not run");
    },
  });
  assert.throws(() => canonicalAssistantDiagnostics(proxied), /proxies/u);
  assert.equal(calls, 0);

  const proxiedDetails = new Proxy({ safe: true }, {
    ownKeys() {
      calls += 1;
      throw new Error("must not run");
    },
  });
  assert.throws(() => canonicalAssistantDiagnostics([diagnostic(proxiedDetails)]), /proxies/u);
  assert.equal(calls, 0);
});

test("assistant diagnostics reject exotic records without invoking toJSON", () => {
  let calls = 0;
  const inherited = Object.create({
    toJSON() {
      calls += 1;
      return { leaked: true };
    },
  }) as Record<string, unknown>;
  inherited.safe = "value";
  assert.throws(() => canonicalAssistantDiagnostics([diagnostic(inherited)]), /plain objects/u);
  assert.equal(calls, 0);

  assert.throws(
    () => canonicalAssistantDiagnostics([diagnostic({ safe: true, [Symbol("hidden")]: true })]),
    /symbol keys/u,
  );

  const nonEnumerable = { safe: true };
  Object.defineProperty(nonEnumerable, "hidden", { value: true });
  assert.throws(
    () => canonicalAssistantDiagnostics([diagnostic(nonEnumerable)]),
    /enumerable data properties/u,
  );
});

test("assistant diagnostics preserve exact item and aggregate byte limits", () => {
  const empty = diagnostic({ value: "" });
  const overhead = Buffer.byteLength(JSON.stringify(empty), "utf8");
  const exactValue = "x".repeat((16 * 1024) - overhead);
  const exact = diagnostic({ value: exactValue });
  assert.equal(Buffer.byteLength(JSON.stringify(exact), "utf8"), 16 * 1024);
  assert.equal(canonicalAssistantDiagnostics([exact])?.length, 1);
  assert.throws(
    () => canonicalAssistantDiagnostics([diagnostic({ value: `${exactValue}x` })]),
    /byte limit/u,
  );

  assert.equal(canonicalAssistantDiagnostics([exact, exact, exact, exact])?.length, 4);
  assert.throws(
    () => canonicalAssistantDiagnostics([exact, exact, exact, exact, diagnostic()]),
    /total byte limit/u,
  );

  assert.throws(
    () => canonicalAssistantDiagnostics([{ type: "x", message: "x".repeat((4 * 1024) + 1), timestamp: 1 }]),
    /message exceeds/u,
  );
  assert.throws(
    () => canonicalAssistantDiagnostics([diagnostic({ value: "x".repeat((512 * 1024) + 1) })]),
    /524288 UTF-8 bytes/u,
  );
});
