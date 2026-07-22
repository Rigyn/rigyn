import assert from "node:assert/strict";
import test from "node:test";

import { filterAndSortSessions, parseSessionSearch } from "../../src/cli/session-picker.js";
import { resolveSessionReference } from "../../src/cli/session-resolution.js";
import type { SessionInfo } from "../../src/storage/types.js";

function session(id: string, text: string, modified: string, name?: string): SessionInfo {
  return {
    path: `/tmp/${id}.jsonl`,
    id,
    cwd: "/tmp/project",
    ...(name === undefined ? {} : { name }),
    created: new Date(0),
    modified: new Date(modified),
    messageCount: 1,
    firstMessage: text,
    allMessagesText: text,
  };
}

test("session search supports normalized phrases and case-insensitive regex", () => {
  const values = [
    session("a", "Node\n\n  CVE was discussed", "2026-01-01T00:00:00.000Z"),
    session("b", "node something else", "2026-01-02T00:00:00.000Z"),
  ];
  assert.deepEqual(filterAndSortSessions(values, '"node cve"', "recent").map((value) => value.id), ["a"]);
  assert.deepEqual(filterAndSortSessions(values, "re:\\bNODE\\b", "recent").map((value) => value.id), ["a", "b"]);
  assert.deepEqual(filterAndSortSessions(values, "re:(", "recent"), []);
});

test("session relevance uses score then modification time while recent preserves input order", () => {
  const values = [
    session("late", "xxxx brave", "2026-01-03T00:00:00.000Z"),
    session("early", "brave xxxx", "2026-01-01T00:00:00.000Z"),
  ];
  assert.deepEqual(filterAndSortSessions(values, '"brave"', "recent").map((value) => value.id), ["late", "early"]);
  assert.deepEqual(filterAndSortSessions(values, '"brave"', "relevance").map((value) => value.id), ["early", "late"]);

  const tied = [
    session("newer", "brave", "2026-01-03T00:00:00.000Z"),
    session("older", "brave", "2026-01-01T00:00:00.000Z"),
  ];
  assert.deepEqual(filterAndSortSessions(tied, '"brave"', "relevance").map((value) => value.id), ["newer", "older"]);
});

test("named-session filtering excludes empty names and composes with search", () => {
  const values = [
    session("named", "blueberry", "2026-01-03T00:00:00.000Z", "Real Name"),
    session("blank", "blueberry", "2026-01-02T00:00:00.000Z", "   "),
    session("other", "cranberry", "2026-01-01T00:00:00.000Z"),
  ];
  assert.deepEqual(filterAndSortSessions(values, "blueberry", "recent", "named").map((value) => value.id), ["named"]);
});

test("unclosed quotes fall back to fuzzy tokens", () => {
  assert.deepEqual(parseSessionSearch('one "two').tokens, [
    { kind: "fuzzy", value: "one" },
    { kind: "fuzzy", value: '"two' },
  ]);
});

test("session path references honor Windows case-insensitive identity", () => {
  const value = session("windows", "message", "2026-01-01T00:00:00.000Z");
  value.path = String.raw`C:\Repo\Sessions\Thread.jsonl`;
  assert.equal(resolveSessionReference([value], "c:/repo/sessions/thread.jsonl"), value);
});
