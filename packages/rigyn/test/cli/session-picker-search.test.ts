import assert from "node:assert/strict";
import test from "node:test";

import {
  filterAndSortSessions,
  parseSessionSearch,
  selectStartupSession,
  type StartupSessionTerminal,
} from "../../src/cli/session-picker.js";
import { resolveSessionReference } from "../../src/cli/session-resolution.js";
import type { SessionInfo } from "../../src/storage/types.js";
import type { TuiAction } from "../../src/tui/types.js";

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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(cause: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));
}

function startupTerminal() {
  let dispatch: (action: TuiAction) => void = () => undefined;
  const scopes: Array<"current" | "all"> = [];
  const itemIds: string[][] = [];
  const terminal = {
    start() {},
    close() {},
    openPicker() {},
    setPickerItems(_picker: string, items: Array<{ id: string }>) { itemIds.push(items.map((item) => item.id)); },
    setSessionPickerScope(scope: "current" | "all") { scopes.push(scope); },
  } as unknown as StartupSessionTerminal;
  return {
    scopes,
    itemIds,
    emit(action: TuiAction) { dispatch(action); },
    createTerminal(onAction: (action: TuiAction) => void): StartupSessionTerminal {
      dispatch = onAction;
      return terminal;
    },
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

test("session search tokenizes adjacent phrases and words without empty terms", () => {
  assert.deepEqual(parseSessionSearch('one"two words"  ""three').tokens, [
    { kind: "fuzzy", value: "one" },
    { kind: "phrase", value: "two words" },
    { kind: "fuzzy", value: "three" },
  ]);
});

test("session path references honor Windows case-insensitive identity", () => {
  const value = session("windows", "message", "2026-01-01T00:00:00.000Z");
  value.path = String.raw`C:\Repo\Sessions\Thread.jsonl`;
  assert.equal(resolveSessionReference([value], "c:/repo/sessions/thread.jsonl"), value);
});

test("startup session picker ignores a stale scope result and its stale failure", async () => {
  for (const staleOutcome of ["success", "failure"] as const) {
    const all = deferred<readonly SessionInfo[]>();
    const view = startupTerminal();
    const current = session("current", "current", "2026-01-01T00:00:00.000Z");
    const selection = selectStartupSession(
      async () => [current],
      async () => await all.promise,
      { createTerminal: (onAction) => view.createTerminal(onAction) },
    );
    await flush();

    view.emit({ type: "session_scope", scope: "all" });
    view.emit({ type: "session_scope", scope: "current" });
    await flush();
    if (staleOutcome === "success") {
      all.resolve([session("stale-all", "stale", "2026-01-02T00:00:00.000Z")]);
    } else {
      all.reject(new Error("stale catalog failure"));
    }
    await flush();

    assert.equal(view.scopes.at(-1), "current");
    assert.deepEqual(view.itemIds.at(-1), [current.path]);
    view.emit({ type: "cancel" });
    assert.equal(await selection, undefined);
  }
});

test("startup session picker reuses an identical All load while scope changes", async () => {
  const all = deferred<readonly SessionInfo[]>();
  const view = startupTerminal();
  let allLoads = 0;
  const selection = selectStartupSession(
    async () => [session("current", "current", "2026-01-01T00:00:00.000Z")],
    async () => { allLoads += 1; return await all.promise; },
    { createTerminal: (onAction) => view.createTerminal(onAction) },
  );
  await flush();

  view.emit({ type: "session_scope", scope: "all" });
  view.emit({ type: "session_scope", scope: "current" });
  view.emit({ type: "session_scope", scope: "all" });
  await flush();
  assert.equal(allLoads, 1);

  const selected = session("all", "all", "2026-01-02T00:00:00.000Z");
  all.resolve([selected]);
  await flush();
  assert.equal(view.scopes.at(-1), "all");
  assert.deepEqual(view.itemIds.at(-1), [selected.path]);
  view.emit({ type: "cancel" });
  assert.equal(await selection, undefined);
});
