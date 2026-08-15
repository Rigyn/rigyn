import assert from "node:assert/strict";
import test from "node:test";

import {
  HARNESS_TRANSCRIPT_LIMITS,
  HARNESS_TRANSCRIPT_SCHEMA_VERSION,
  parseHarnessTranscriptPage,
  type HarnessTranscriptEntry,
  type HarnessTranscriptPage,
} from "../../src/service/transcript.js";

const BASE = {
  eventId: "event-1",
  sequence: 1,
  timestamp: "2026-07-28T12:00:00.000Z",
} as const;

function page(
  entries: unknown[],
  overrides: Partial<Omit<HarnessTranscriptPage, "entries">> = {},
): unknown {
  const last = entries.at(-1);
  const inferredSequence = last !== null && typeof last === "object" && "sequence" in last
    ? (last as { sequence?: unknown }).sequence
    : undefined;
  return {
    schemaVersion: HARNESS_TRANSCRIPT_SCHEMA_VERSION,
    threadId: "thread-1",
    branch: "main",
    entries,
    ...(typeof inferredSequence === "number" ? { nextSequence: inferredSequence } : {}),
    hasMore: false,
    truncated: false,
    ...overrides,
  };
}

test("transcript pages validate and retain every public entry shape", () => {
  const entries: HarnessTranscriptEntry[] = [
    {
      ...BASE,
      kind: "message",
      role: "user",
      messageId: "message-1",
      runId: "run-1",
      text: "hello",
      images: [{ mediaType: "image/png", source: "embedded" }],
      truncated: true,
    },
    { ...BASE, eventId: "event-2", sequence: 2, kind: "reasoning", part: 0 },
    {
      ...BASE,
      eventId: "event-3",
      sequence: 3,
      kind: "tool",
      callId: "call-1",
      name: "read",
      status: "completed",
    },
    {
      ...BASE,
      eventId: "event-4",
      sequence: 4,
      kind: "extension",
      extensionId: "extension-1",
      schemaVersion: 1,
      messageKind: "notice",
      messageId: "notice-1",
    },
    {
      ...BASE,
      eventId: "event-5",
      sequence: 5,
      kind: "summary",
      summaryType: "branch",
      sourceCount: 4,
      sourceBranch: "topic",
    },
    {
      ...BASE,
      eventId: "event-6",
      sequence: 6,
      kind: "status",
      statusType: "warning",
      code: "slow",
    },
  ];

  const parsed = parseHarnessTranscriptPage(page(entries, {
    nextSequence: 6,
    hasMore: true,
    truncated: true,
  }));
  assert.deepEqual(parsed.entries, entries);
  assert.equal(parsed.nextSequence, 6);
  assert.equal(parsed.hasMore, true);
  assert.equal(parsed.truncated, true);
});

test("transcript validation rejects executable or non-JSON object shapes", () => {
  const valid = page([{ ...BASE, kind: "reasoning", part: 0 }]) as Record<string, unknown>;

  assert.throws(
    () => parseHarnessTranscriptPage(Object.assign(Object.create({ inherited: true }), valid)),
    /plain JSON data/u,
  );

  const accessor = { ...valid };
  Object.defineProperty(accessor, "branch", { enumerable: true, get: () => "main" });
  assert.throws(() => parseHarnessTranscriptPage(accessor), /only enumerable data fields/u);

  const symbol = { ...valid, [Symbol("hidden")]: true };
  assert.throws(() => parseHarnessTranscriptPage(symbol), /unknown symbol field/u);

  const sparse = new Array<unknown>(1);
  assert.throws(() => parseHarnessTranscriptPage(page(sparse)), /only enumerable data entries/u);

  const decorated = [{ ...BASE, kind: "reasoning", part: 0 }];
  Object.assign(decorated, { extra: true });
  assert.throws(() => parseHarnessTranscriptPage(page(decorated)), /unknown fields/u);
});

test("transcript validation enforces entry enums, fields, and bounded text", () => {
  assert.throws(
    () => parseHarnessTranscriptPage({ ...(page([]) as object), threadId: "" }),
    /threadId is invalid/u,
  );
  assert.throws(
    () => parseHarnessTranscriptPage({ ...(page([]) as object), hasMore: "no" }),
    /page flags are invalid/u,
  );
  assert.throws(
    () => parseHarnessTranscriptPage(page([{ ...BASE, kind: "message", role: "system", messageId: "m" }])),
    /message role/u,
  );
  assert.throws(
    () => parseHarnessTranscriptPage(page([{ ...BASE, kind: "tool", callId: "c", name: "read", status: "queued" }])),
    /tool status/u,
  );
  assert.throws(
    () => parseHarnessTranscriptPage(page([{
      ...BASE,
      kind: "extension",
      extensionId: "x",
      schemaVersion: 0,
      messageKind: "notice",
      messageId: "m",
    }])),
    /schemaVersion/u,
  );
  assert.throws(
    () => parseHarnessTranscriptPage(page([{ ...BASE, kind: "summary", summaryType: "other", sourceCount: 1 }])),
    /summary type/u,
  );
  assert.throws(
    () => parseHarnessTranscriptPage(page([{ ...BASE, kind: "status", statusType: "ready" }])),
    /status type/u,
  );
  assert.throws(
    () => parseHarnessTranscriptPage(page([{ ...BASE, kind: "unknown" }])),
    /entry kind/u,
  );
  assert.throws(
    () => parseHarnessTranscriptPage(page([{ ...BASE, kind: "reasoning", part: 0, extra: true }])),
    /unknown fields/u,
  );
  assert.throws(
    () => parseHarnessTranscriptPage(page([{ ...BASE, kind: "reasoning", part: 0, text: "bad\0text" }])),
    /entry text/u,
  );
  assert.throws(
    () => parseHarnessTranscriptPage(page([{
      ...BASE,
      kind: "reasoning",
      part: 0,
      images: [{ mediaType: "image/png", source: "local" }],
    }])),
    /image 0 source/u,
  );
  assert.throws(
    () => parseHarnessTranscriptPage(page([{
      ...BASE,
      kind: "reasoning",
      part: 0,
      truncated: false,
    }])),
    /truncated flag/u,
  );
});

test("transcript cursors and page flags must describe the returned sequence", () => {
  const entry = { ...BASE, kind: "reasoning", part: 0 };
  assert.throws(
    () => parseHarnessTranscriptPage(page([entry, { ...entry, eventId: "event-2" }])),
    /strictly increasing/u,
  );
  assert.throws(
    () => parseHarnessTranscriptPage(page([], { nextSequence: 0 })),
    /must not have nextSequence/u,
  );
  assert.throws(
    () => parseHarnessTranscriptPage(page([entry], { nextSequence: 2 })),
    /does not match/u,
  );
  assert.throws(
    () => parseHarnessTranscriptPage(page([], { hasMore: true })),
    /cannot have more entries/u,
  );
  assert.throws(
    () => parseHarnessTranscriptPage(page([entry], { truncated: true })),
    /truncated flag is inconsistent/u,
  );
});

test("transcript pages enforce both entry-count and serialized-byte limits", () => {
  const entry = { ...BASE, kind: "reasoning", part: 0 };
  assert.throws(
    () => parseHarnessTranscriptPage(page(Array.from(
      { length: HARNESS_TRANSCRIPT_LIMITS.maxEntries + 1 },
      (_, index) => ({ ...entry, eventId: `event-${index}`, sequence: index }),
    ))),
    /page entries is invalid/u,
  );

  const text = "x".repeat(HARNESS_TRANSCRIPT_LIMITS.maxTextBytes);
  const entries = Array.from({ length: 17 }, (_, index) => ({
    ...entry,
    eventId: `event-${index}`,
    sequence: index,
    text,
  }));
  assert.throws(
    () => parseHarnessTranscriptPage(page(entries)),
    new RegExp(`exceeds ${String(HARNESS_TRANSCRIPT_LIMITS.maxBytes)} bytes`, "u"),
  );
});
