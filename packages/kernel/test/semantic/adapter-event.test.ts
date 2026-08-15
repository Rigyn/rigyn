import assert from "node:assert/strict";
import test from "node:test";

import { adapterEventType, snapshotAdapterEvent } from "../../src/runtime/core/adapter-event.js";
import { ASSISTANT_CONTENT_LIMITS } from "../../src/runtime/core/assistant-content-limits.js";
import type { AdapterEvent } from "../../src/runtime/core/types.js";

const state = { kind: "chat_completions" as const, assistantMessage: { role: "assistant" } };

function json(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

test("adapter event snapshots cover every event variant and detach their values", () => {
  const events: AdapterEvent[] = [
    { type: "response_start", model: "m", responseId: "response", requestId: "request", diagnostics: { status: 200, headers: {} } },
    { type: "text_start", part: 0 },
    { type: "text_delta", part: 0, text: "delta" },
    { type: "text_end", part: 0, text: "text", textSignature: "signature" },
    { type: "reasoning_start", part: 1, visibility: "summary" },
    { type: "reasoning_delta", part: 1, text: "delta", visibility: "summary" },
    { type: "reasoning_end", part: 1, text: "thought", visibility: "summary", thinkingSignature: "signature", redacted: false },
    { type: "tool_call_start", index: 0, id: "call", name: "read" },
    { type: "tool_call_delta", index: 0, jsonFragment: "{}" },
    { type: "tool_call_end", index: 0, id: "call", name: "read", rawArguments: "{}", arguments: { path: "file" } },
    { type: "usage", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, semantics: "final" },
    { type: "unknown_provider_event", provider: "test", raw: { future: true } },
    { type: "response_end", reason: "stop", state, content: [{ type: "text", text: "done" }] },
    { type: "error", error: { category: "provider", message: "failed", retryable: false, partial: false } },
  ];

  for (const event of events) {
    const selected = snapshotAdapterEvent(event);
    assert.deepEqual(json(selected), json(event));
    assert.notEqual(selected, event);
  }

  const mutable = { type: "text_delta" as const, part: 0, text: "before" };
  const detached = snapshotAdapterEvent(mutable);
  mutable.text = "after";
  assert.equal(detached.type === "text_delta" ? detached.text : undefined, "before");
});

test("adapter event snapshots reject known hostile fields without invoking caller code", () => {
  let calls = 0;
  const typeAccessor: Record<string, unknown> = { part: 0 };
  Object.defineProperty(typeAccessor, "type", {
    enumerable: true,
    get() {
      calls += 1;
      return "text_start";
    },
  });
  assert.throws(() => snapshotAdapterEvent(typeAccessor), /event type/u);
  assert.equal(calls, 0);

  const textAccessor: Record<string, unknown> = { type: "text_delta", part: 0 };
  Object.defineProperty(textAccessor, "text", {
    enumerable: true,
    get() {
      calls += 1;
      return "must not run";
    },
  });
  assert.throws(() => snapshotAdapterEvent(textAccessor), /data properties/u);
  assert.equal(calls, 0);

  const proxied = new Proxy({ type: "text_start", part: 0 }, {
    getPrototypeOf() {
      calls += 1;
      throw new Error("must not run");
    },
  });
  assert.throws(() => snapshotAdapterEvent(proxied), /plain object/u);
  assert.equal(calls, 0);

  const nested = { type: "text" };
  Object.defineProperty(nested, "text", {
    enumerable: true,
    get() {
      calls += 1;
      return "must not run";
    },
  });
  assert.throws(() => snapshotAdapterEvent({
    type: "response_end",
    reason: "stop",
    state,
    content: [nested],
  }), /data properties/u);
  assert.equal(calls, 0);
});

test("adapter event type inspection reads only a safe plain-data discriminator", () => {
  assert.equal(adapterEventType({ type: "response_end" }), "response_end");

  let calls = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "type", {
    enumerable: true,
    get() {
      calls += 1;
      return "response_end";
    },
  });
  assert.throws(() => adapterEventType(accessor), /event type/u);
  const proxied = new Proxy({ type: "response_end" }, {
    getOwnPropertyDescriptor() {
      calls += 1;
      throw new Error("must not run");
    },
  });
  assert.throws(() => adapterEventType(proxied), /plain object/u);
  assert.throws(() => adapterEventType({ type: "future_event" }), /event type/u);
  assert.equal(calls, 0);
});

test("unknown adapter events replace unsafe raw payloads without invoking them", () => {
  let calls = 0;
  const accessor: Record<string, unknown> = { type: "unknown_provider_event", provider: "test" };
  Object.defineProperty(accessor, "raw", {
    enumerable: true,
    get() {
      calls += 1;
      return { leaked: true };
    },
  });
  assert.deepEqual(json(snapshotAdapterEvent(accessor)), {
    type: "unknown_provider_event",
    provider: "test",
    raw: { invalid: true, truncated: true },
  });
  assert.equal(calls, 0);

  const first = snapshotAdapterEvent(accessor);
  if (first.type !== "unknown_provider_event" || first.raw === null || typeof first.raw !== "object" || Array.isArray(first.raw)) {
    assert.fail("expected an unknown-event fallback record");
  }
  first.raw.invalid = false;
  assert.deepEqual(json(snapshotAdapterEvent(accessor)), {
    type: "unknown_provider_event",
    provider: "test",
    raw: { invalid: true, truncated: true },
  });

  const raw = new Proxy({ future: true }, {
    ownKeys() {
      calls += 1;
      throw new Error("must not run");
    },
  });
  assert.deepEqual(json(snapshotAdapterEvent({ type: "unknown_provider_event", provider: "test", raw })), {
    type: "unknown_provider_event",
    provider: "test",
    raw: { invalid: true, truncated: true },
  });
  assert.equal(calls, 0);
});

test("adapter event snapshots preserve exact field bounds and reject one byte over", () => {
  const exact = "x".repeat(ASSISTANT_CONTENT_LIMITS.fieldBytes);
  assert.equal(snapshotAdapterEvent({ type: "text_delta", part: 0, text: exact }).type, "text_delta");
  const escapedExact = "\u0001".repeat(ASSISTANT_CONTENT_LIMITS.fieldBytes);
  assert.equal(snapshotAdapterEvent({ type: "text_delta", part: 0, text: escapedExact }).type, "text_delta");
  assert.throws(
    () => snapshotAdapterEvent({ type: "text_delta", part: 0, text: `${exact}x` }),
    /4194304 bytes/u,
  );
  assert.throws(
    () => snapshotAdapterEvent({ type: "text_start", part: 0, extra: true }),
    /unsupported fields/u,
  );
});
