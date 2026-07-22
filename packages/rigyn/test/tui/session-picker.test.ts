import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionPickerRows,
  formatSessionAge,
  type SessionPickerMetadata,
} from "../../src/tui/session-picker.js";

const day = 24 * 60 * 60 * 1_000;

function session(
  id: string,
  updatedAt: number,
  overrides: Partial<SessionPickerMetadata> = {},
): SessionPickerMetadata {
  return { id, label: id, updatedAt, ...overrides };
}

test("session picker can restrict results to explicitly named sessions", () => {
  const result = buildSessionPickerRows([
    session("named", 3, { name: "Release work" }),
    session("blank", 2, { name: "   " }),
    session("fallback", 1, { label: "First prompt fallback" }),
  ], { namedOnly: true, sort: "recent" });

  assert.deepEqual(result.rows.map((row) => row.session.id), ["named"]);
});

test("session picker regex search is case-insensitive and reports invalid patterns", () => {
  const sessions = [
    session("one", 1, { label: "Fix HTTP Cache" }),
    session("two", 2, { label: "write documentation" }),
  ];

  assert.deepEqual(
    buildSessionPickerRows(sessions, { query: "re:^fix.*CACHE$" }).rows.map((row) => row.session.id),
    ["one"],
  );
  const invalid = buildSessionPickerRows(sessions, { query: "re:(" });
  assert.deepEqual(invalid.rows, []);
  assert.match(invalid.error ?? "", /regular expression|unterminated/iu);
});

test("session picker ANDs fuzzy tokens across searchable metadata", () => {
  const result = buildSessionPickerRows([
    session("complete", 1, { label: "Alpha workspace", detail: "provider migration" }),
    session("first-only", 3, { label: "Alpha workspace" }),
    session("second-only", 2, { label: "Provider migration" }),
  ], { query: "alp prv", sort: "relevance" });

  assert.deepEqual(result.rows.map((row) => row.session.id), ["complete"]);
});

test("quoted phrases match normalized exact text rather than fuzzy subsequences", () => {
  const result = buildSessionPickerRows([
    session("normalized", 1, { label: "Alpha\n   Project release" }),
    session("separated", 2, { label: "Alpha new Project release" }),
    session("missing-token", 3, { label: "Alpha Project backlog" }),
  ], { query: "\"alpha    project\" rls", sort: "relevance" });

  assert.deepEqual(result.rows.map((row) => row.session.id), ["normalized"]);
});

test("recent and relevance modes are flat and deterministically ordered", () => {
  const sessions = [
    session("z", 20, { label: "alpha notes" }),
    session("b", 10, { label: "alpha" }),
    session("a", 10, { label: "alpha" }),
  ];

  const recent = buildSessionPickerRows(sessions, { sort: "recent" });
  assert.deepEqual(recent.rows.map((row) => row.session.id), ["z", "a", "b"]);
  assert.ok(recent.rows.every((row) => row.depth === 0));

  const relevant = buildSessionPickerRows(sessions, { query: "alpha", sort: "relevance" });
  assert.deepEqual(relevant.rows.map((row) => row.session.id), ["a", "b", "z"]);
  assert.ok(relevant.rows[0]!.score > relevant.rows[2]!.score);
});

test("threaded mode orders roots and children by newest subtree activity", () => {
  const result = buildSessionPickerRows([
    session("root-old", 1),
    session("root-newer", 50),
    session("child-newest", 100, { parentId: "root-old" }),
    session("child-old", 2, { parentId: "root-old" }),
    session("grandchild", 80, { parentId: "child-old" }),
  ], { sort: "threaded" });

  assert.deepEqual(result.rows.map((row) => [row.session.id, row.depth]), [
    ["root-old", 0],
    ["child-newest", 1],
    ["child-old", 1],
    ["grandchild", 2],
    ["root-newer", 0],
  ]);
});

test("threaded mode handles cycles, self-parents, and orphans deterministically", () => {
  const sessions = [
    session("b", 40, { parentId: "a" }),
    session("a", 10, { parentId: "b" }),
    session("orphan", 30, { parentId: "missing" }),
    session("self", 20, { parentId: "self" }),
  ];
  const first = buildSessionPickerRows(sessions, { sort: "threaded" });
  const second = buildSessionPickerRows([...sessions].reverse(), { sort: "threaded" });

  const shape = (result: typeof first) => result.rows.map((row) => [row.session.id, row.depth]);
  assert.deepEqual(shape(first), [
    ["a", 0],
    ["b", 1],
    ["orphan", 0],
    ["self", 0],
  ]);
  assert.deepEqual(shape(second), shape(first));
});

test("a nonblank query flattens threaded results", () => {
  const result = buildSessionPickerRows([
    session("root", 1, { label: "Root alpha" }),
    session("child", 2, { label: "Child alpha", parentId: "root" }),
  ], { query: "alpha", sort: "threaded" });

  assert.deepEqual(result.rows.map((row) => row.session.id), ["root", "child"]);
  assert.ok(result.rows.every((row) => row.depth === 0));
});

test("compact session ages cover now, minutes, hours, days, weeks, months, and years", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(formatSessionAge(now, now), "now");
  assert.equal(formatSessionAge(now + day, now), "now");
  assert.equal(formatSessionAge(now - 59_000, now), "now");
  assert.equal(formatSessionAge(now - 5 * 60_000, now), "5m");
  assert.equal(formatSessionAge(now - 3 * 60 * 60_000, now), "3h");
  assert.equal(formatSessionAge(now - 4 * day, now), "4d");
  assert.equal(formatSessionAge(now - 15 * day, now), "2w");
  assert.equal(formatSessionAge(now - 65 * day, now), "2mo");
  assert.equal(formatSessionAge(now - 800 * day, now), "2y");
});
