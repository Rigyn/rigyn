import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  indexedSessionPickerPage,
  indexedSessionPickerItems,
  markCurrentSessionPickerItems,
  refreshSessionCatalogOnOpen,
  resolveSessionPickerSelection,
  sessionPickerItems,
  sessionPickerPage,
} from "../../src/cli/main.js";
import type { LoadedRuntime } from "../../src/cli/runtime.js";
import { WorkspaceSessionIndex } from "../../src/cli/session-index.js";
import { SessionStore } from "../../src/storage/store.js";

function message(id: string, role: "user" | "assistant", text: string) {
  return {
    id,
    role,
    createdAt: "2026-07-10T00:00:00.000Z",
    content: [{ type: "text" as const, text }],
  };
}

test("cached session picker items update the active marker without rebuilding previews", () => {
  const items = [
    {
      id: "first",
      label: "First",
      value: "first",
      session: { path: "db#first", createdAt: "2026-01-01", updatedAt: "2026-01-01", current: true },
    },
    {
      id: "second",
      label: "Second",
      value: "second",
      session: { path: "db#second", createdAt: "2026-01-01", updatedAt: "2026-01-01", current: false },
    },
  ];

  const updated = markCurrentSessionPickerItems(items, "second");

  assert.deepEqual(updated.map((item) => item.session?.current), [false, true]);
  assert.deepEqual(updated.map((item) => item.label), ["First", "Second"]);
});

test("session selection rejects an item removed by an asynchronous catalog reset", () => {
  const stale = {
    id: "stale",
    label: "Stale session",
    value: "stale",
    session: { path: "db#stale", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  };
  const current = {
    id: "current",
    label: "Current session",
    value: "current",
    session: { path: "db#current", createdAt: "2026-01-01", updatedAt: "2026-01-02" },
  };

  assert.equal(resolveSessionPickerSelection([current], stale), undefined);
  assert.equal(resolveSessionPickerSelection([current], current), current);
});

test("session selection resolves the current catalog item instead of stale metadata", () => {
  const stale = {
    id: "same",
    label: "Old name",
    value: "same",
    session: { path: "db#same", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  };
  const current = {
    ...stale,
    label: "New name",
    session: { ...stale.session, updatedAt: "2026-01-02" },
  };

  assert.equal(resolveSessionPickerSelection([current], stale), current);
});

test("opening a session picker queries only when its cached catalog is stale or out of scope", async () => {
  let queries = 0;
  const refresh = async () => { queries += 1; };

  assert.equal(await refreshSessionCatalogOnOpen({ stale: false, scope: "current", query: "" }, refresh), false);
  assert.equal(queries, 0);
  assert.equal(await refreshSessionCatalogOnOpen({ stale: true, scope: "current", query: "" }, refresh), true);
  assert.equal(await refreshSessionCatalogOnOpen({ stale: false, scope: "all", query: "" }, refresh), true);
  assert.equal(await refreshSessionCatalogOnOpen({ stale: false, scope: "current", query: "old" }, refresh), true);
  assert.equal(queries, 3);
});

test("session picker items carry rich metadata and bounded conversation search", () => {
  const store = new SessionStore(":memory:");
  try {
    store.createThread({ threadId: "parent", name: "Named parent", workspaceRoot: "/workspace" });
    const user = store.appendEvent({
      threadId: "parent",
      event: { type: "message_appended", message: message("parent-user", "user", `needle-token ${"x".repeat(100_000)}`) },
    });
    store.appendEvent({
      threadId: "parent",
      event: { type: "message_appended", message: message("parent-assistant", "assistant", "answer-token") },
    });
    store.forkBranch({ threadId: "parent", newBranch: "experiment", atEventId: user.eventId });
    const run = store.startRun({ threadId: "parent", runId: "parent-run", provider: "openai", model: "gpt-test" });
    store.appendEvent({
      threadId: "parent",
      runId: run.runId,
      event: { type: "run_cancelled", reason: "fixture complete" },
    });

    store.createThread({ threadId: "child", parentThreadId: "parent", workspaceRoot: "/workspace" });
    store.appendEvent({
      threadId: "child",
      event: { type: "message_appended", message: message("child-user", "user", "child prompt") },
    });
    store.createThread({ threadId: "empty", workspaceRoot: "/workspace" });
    store.createThread({ threadId: "other-workspace", workspaceRoot: "/elsewhere" });
    store.appendEvent({
      threadId: "other-workspace",
      event: { type: "message_appended", message: message("other-user", "user", "not visible") },
    });

    const runtime = {
      store,
      workspace: "/workspace",
      databasePath: "/state/sessions.sqlite",
      paths: { database: "/state/default.sqlite" },
    } as unknown as LoadedRuntime;
    const boundedStore = store as SessionStore & { listEvents: () => never; listRuns: () => never };
    boundedStore.listEvents = () => { throw new Error("sessionPickerItems must not load complete event histories"); };
    boundedStore.listRuns = () => { throw new Error("sessionPickerItems must not load complete run histories"); };
    const items = sessionPickerItems(runtime, "child");

    assert.deepEqual(items.map((item) => item.id).sort(), ["child", "parent"]);
    const parent = items.find((item) => item.id === "parent");
    const child = items.find((item) => item.id === "child");
    assert.ok(parent);
    assert.ok(child);
    assert.equal(parent.label, "Named parent");
    assert.match(parent.detail ?? "", /2 messages/u);
    assert.match(parent.detail ?? "", /openai\/gpt-test/u);
    assert.match(parent.detail ?? "", /2 branches/u);
    assert.equal(parent.session?.name, "Named parent");
    assert.equal(parent.session?.path, "/state/sessions.sqlite#parent");
    assert.equal(parent.session?.workspace, "/workspace");
    assert.equal(parent.session?.messageCount, 2);
    assert.equal(parent.session?.current, false);
    assert.equal(parent.session?.createdAt, store.getThread("parent").createdAt);
    assert.equal(parent.session?.updatedAt, store.getThread("parent").updatedAt);
    assert.match(parent.keywords?.join(" ") ?? "", /needle-token/u);
    assert.ok(Buffer.byteLength(parent.keywords?.join(" ") ?? "") <= 64 * 1024);
    assert.equal(child.session?.parentId, "parent");
    assert.equal(child.session?.current, true);
    assert.equal(child.session?.messageCount, 1);

    const allWorkspaces = sessionPickerItems(runtime, "child", { allWorkspaces: true });
    const remote = allWorkspaces.find((item) => item.id === "other-workspace");
    assert.ok(remote);
    assert.equal(remote.session?.workspace, "/elsewhere");
    assert.match(remote.detail ?? "", /\/elsewhere/u);
  } finally {
    store.close();
  }
});

test("session picker search applies one aggregate memory ceiling", () => {
  const timestamp = "2026-07-10T00:00:00.000Z";
  const threads = Array.from({ length: 70 }, (_, index) => ({
    threadId: `thread-${index}`,
    defaultBranch: "main",
    createdAt: timestamp,
    updatedAt: timestamp,
    workspaceRoot: "/workspace",
    branches: [{
      threadId: `thread-${index}`,
      name: "main",
      headEventId: `event-${index}`,
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  }));
  const runtime = {
    workspace: "/workspace",
    databasePath: "/state/sessions.sqlite",
    paths: { database: "/state/sessions.sqlite" },
    store: {
      listThreads: () => threads,
      getThreadPreview: (_threadId: string, options: { searchByteLimit?: number }) => ({
        branch: "main",
        hasUserMessage: true,
        firstPrompt: "prompt",
        recentSearchText: "z".repeat(options.searchByteLimit ?? 64 * 1024),
        searchTruncated: true,
        messageCount: 1,
        messageCountTruncated: false,
      }),
      listEvents: () => { throw new Error("sessionPickerItems must not load event histories"); },
      listRuns: () => { throw new Error("sessionPickerItems must not load run histories"); },
    },
  } as unknown as LoadedRuntime;

  const items = sessionPickerItems(runtime);
  const byteLengths = items.map((item) => Buffer.byteLength(item.keywords?.join(" ") ?? ""));
  assert.equal(items.length, 70);
  assert.ok(byteLengths.every((length) => length <= 64 * 1024));
  assert.ok(byteLengths.reduce((total, length) => total + length, 0) <= 4 * 1024 * 1024);
  assert.equal(items.at(-1)?.keywords, undefined);
});

test("current-workspace picker pages and searches beyond 500 sessions with stable ties", () => {
  const timestamp = "2026-07-10T00:00:00.000Z";
  const store = new SessionStore(":memory:", { clock: () => new Date(timestamp) });
  try {
    for (let ordinal = 0; ordinal < 501; ordinal += 1) {
      const suffix = String(ordinal).padStart(4, "0");
      const threadId = `thread-${suffix}`;
      store.createThread({ threadId, name: `Session ${suffix}`, workspaceRoot: "/workspace" });
      store.appendEvent({
        threadId,
        event: {
          type: "message_appended",
          message: message(
            `${threadId}-user`,
            "user",
            ordinal === 500 ? "deep-history-content-needle" : `prompt ${suffix}`,
          ),
        },
      });
    }
    const runtime = {
      store,
      workspace: "/workspace",
      databasePath: "/state/sessions.sqlite",
      paths: { database: "/state/sessions.sqlite" },
    } as unknown as LoadedRuntime;

    const ids: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = sessionPickerPage(runtime, "thread-0500", {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const item of page.items) {
        assert.equal(seen.has(item.id), false, `session ${item.id} appeared in more than one page`);
        seen.add(item.id);
        ids.push(item.id);
      }
      assert.equal(page.hasMore, page.nextCursor !== undefined);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    assert.equal(ids.length, 501);
    assert.equal(seen.size, 501);
    assert.deepEqual(ids, [...ids].sort());

    const contentMatch = sessionPickerPage(runtime, "thread-0500", { query: "deep-history-content-needle" });
    assert.deepEqual(contentMatch.items.map((item) => item.id), ["thread-0500"]);
    assert.equal(contentMatch.items[0]?.session?.current, true);

    store.nameThread("thread-0500", "Renamed deep target");
    assert.deepEqual(
      sessionPickerPage(runtime, "thread-0500", { query: "renamed deep target" }).items.map((item) => item.id),
      ["thread-0500"],
    );
    store.deleteThread("thread-0500");
    assert.deepEqual(sessionPickerPage(runtime, undefined, { query: "renamed deep target" }).items, []);
  } finally {
    store.close();
  }
});

test("all-workspace picker uses composite values and reads metadata without opening histories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-indexed-picker-"));
  const index = await WorkspaceSessionIndex.open(join(root, "index.sqlite"));
  t.after(() => index.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const records: Array<{ workspace: string; database: string }> = [];
  for (let ordinal = 0; ordinal < 2; ordinal += 1) {
    const workspacePath = join(root, `workspace-${ordinal}`);
    const databasePath = join(root, `sessions-${ordinal}.sqlite`);
    await mkdir(workspacePath);
    const workspace = await realpath(workspacePath);
    const store = new SessionStore(databasePath);
    store.createThread({ threadId: "duplicate", name: `Indexed ${ordinal}`, workspaceRoot: workspace });
    store.appendEvent({
      threadId: "duplicate",
      event: { type: "message_appended", message: message(`duplicate-${ordinal}-user`, "user", `Indexed ${ordinal} prompt`) },
    });
    store.close();
    await index.refreshWorkspace({ workspaceRoot: workspace, databasePath });
    records.push({ workspace, database: await realpath(databasePath) });
  }

  await rm(records[1]!.database);
  const items = indexedSessionPickerItems(index, {
    workspaceRoot: records[0]!.workspace,
    databasePath: records[0]!.database,
    threadId: "duplicate",
  });
  assert.equal(items.length, 2);
  assert.equal(new Set(items.map((item) => item.id)).size, 2);
  assert.ok(items.every((item) => item.id === item.value && item.id.endsWith("#duplicate")));
  assert.equal(items.filter((item) => item.session?.current).length, 1);
  assert.ok(items.every((item) => item.session?.path === item.value));

  const page = indexedSessionPickerPage(index, {
    workspaceRoot: records[0]!.workspace,
    databasePath: records[0]!.database,
    threadId: "duplicate",
  }, { limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.hasMore, true);
  assert.ok(page.nextCursor !== undefined);
  const nextPage = indexedSessionPickerPage(index, {
    workspaceRoot: records[0]!.workspace,
    databasePath: records[0]!.database,
    threadId: "duplicate",
  }, { cursor: page.nextCursor, limit: 1 });
  assert.equal(nextPage.items.length, 1);
  assert.equal(nextPage.hasMore, false);
  assert.equal([...page.items, ...nextPage.items].filter((item) => item.session?.current).length, 1);
});
