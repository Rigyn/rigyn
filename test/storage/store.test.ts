import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { EventEnvelope } from "../../src/core/events.js";
import { CURRENT_SCHEMA_VERSION, migrateDatabase, SessionStore } from "../../src/storage/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "harness-storage-"));
  temporaryDirectories.push(directory);
  return join(directory, "sessions.sqlite");
}

function ids(namespace: string): (prefix: string) => string {
  let next = 0;
  return (prefix) => `${prefix}_${namespace}_${++next}`;
}

function countMaterializedRows<T>(store: SessionStore, operation: () => T): { value: T; rows: number } {
  const database = store.database;
  const originalPrepare = database.prepare;
  let rows = 0;
  database.prepare = ((sql: string) => {
    const statement = originalPrepare.call(database, sql);
    return new Proxy(statement, {
      get(target, property) {
        if (property === "all") {
          return (...parameters: Parameters<typeof target.all>) => {
            const result = target.all(...parameters);
            rows += result.length;
            return result;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof database.prepare;
  try {
    return { value: operation(), rows };
  } finally {
    database.prepare = originalPrepare;
  }
}

function appendWarnings(store: SessionStore, threadId: string, count: number, branch?: string): EventEnvelope {
  let last: EventEnvelope | undefined;
  for (let offset = 0; offset < count; offset += 500) {
    const appended = store.appendEvents({
      threadId,
      ...(branch === undefined ? {} : { branch }),
      events: Array.from({ length: Math.min(500, count - offset) }, (_, index) => ({
        type: "warning" as const,
        code: `warning-${offset + index}`,
        message: `warning-${offset + index}`,
      })),
    });
    last = appended.at(-1);
  }
  if (last === undefined) throw new Error("appendWarnings requires a positive count");
  return last;
}

test("file-backed stores keep the database and SQLite sidecars private", () => {
  if (process.platform === "win32") return;
  const path = temporaryDatabase();
  const store = new SessionStore(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${path}${suffix}`;
    if (existsSync(sidecar)) assert.equal(statSync(sidecar).mode & 0o777, 0o600);
  }
  store.close();

  chmodSync(path, 0o644);
  const reopened = new SessionStore(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  reopened.close();
});

test("opening a file-backed store retains SQLite advisory locks", () => {
  if (process.platform !== "linux" || !existsSync("/proc/locks")) return;
  const path = temporaryDatabase();
  const store = new SessionStore(path);
  try {
    const inodes = [path, `${path}-wal`, `${path}-shm`]
      .filter(existsSync)
      .map((file) => String(statSync(file).ino));
    const locks = readFileSync("/proc/locks", "utf8").split("\n");
    assert.ok(
      locks.some((line) => inodes.some((inode) => line.includes(`:${inode} `))),
      "opening the store must not cancel SQLite's process locks by closing a separate file descriptor",
    );
  } finally {
    store.close();
  }
});

test("file-backed stores reject an index-corrupt database before use", () => {
  const path = temporaryDatabase();
  new SessionStore(path).close();

  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE corruption_probe(value TEXT PRIMARY KEY) STRICT; CREATE INDEX corruption_probe_idx ON corruption_probe(value)");
  database.prepare("INSERT INTO corruption_probe(value) VALUES (?)").run("stale");
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const rootPage = (database.prepare(`
    SELECT rootpage FROM sqlite_schema WHERE name = 'corruption_probe_idx'
  `).get() as { rootpage: number }).rootpage;
  database.close();

  const contents = readFileSync(path);
  const encodedPageSize = contents.readUInt16BE(16);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  const pageOffset = (rootPage - 1) * pageSize;
  assert.ok(pageOffset >= pageSize && pageOffset < contents.length);
  assert.equal(contents[pageOffset], 0x0a);
  assert.equal(contents.readUInt16BE(pageOffset + 3), 1);
  const contentOffset = contents.readUInt16BE(pageOffset + 5);
  const fragmentedBytes = pageSize - contentOffset;
  assert.ok(fragmentedBytes > 0 && fragmentedBytes <= 0xff);
  contents.writeUInt16BE(0, pageOffset + 3);
  contents[pageOffset + 7] = fragmentedBytes;
  writeFileSync(path, contents);

  assert.throws(() => new SessionStore(path), /integrity check failed/u);
});

test("file-backed stores reject writable, symlinked, and hard-linked database paths", () => {
  if (process.platform === "win32") return;

  const writable = temporaryDatabase();
  writeFileSync(writable, "", { mode: 0o600 });
  chmodSync(writable, 0o666);
  assert.throws(() => new SessionStore(writable), /group- or world-writable/u);

  const symlinkTarget = temporaryDatabase();
  writeFileSync(symlinkTarget, "", { mode: 0o600 });
  const symlinkPath = `${symlinkTarget}.link`;
  symlinkSync(symlinkTarget, symlinkPath);
  assert.throws(() => new SessionStore(symlinkPath), /securely open session database|non-symlink/u);

  const hardlinkTarget = temporaryDatabase();
  writeFileSync(hardlinkTarget, "", { mode: 0o600 });
  const hardlinkPath = `${hardlinkTarget}.link`;
  linkSync(hardlinkTarget, hardlinkPath);
  assert.throws(() => new SessionStore(hardlinkTarget), /multiple hard links/u);
});

test("file-backed stores reject an aliased parent before creating the database", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-storage-parent-"));
  temporaryDirectories.push(root);
  const target = join(root, "actual");
  const alias = join(root, "alias");
  mkdirSync(target);
  symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  const database = join(alias, "sessions.sqlite");
  assert.throws(() => new SessionStore(database), /database parent is unsafe/u);
  assert.equal(existsSync(join(target, "sessions.sqlite")), false);
});

test("schema creation is transactional and configures durable SQLite settings", () => {
  const path = temporaryDatabase();
  const database = new DatabaseSync(path);
  migrateDatabase(database);
  assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, CURRENT_SCHEMA_VERSION);
  assert.equal(
    (database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count,
    1,
  );
  database.close();

  const store = new SessionStore(path);
  assert.equal(
    (store.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    CURRENT_SCHEMA_VERSION,
  );
  assert.equal((store.database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  assert.equal((store.database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
  assert.equal((store.database.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5_000);
  assert.equal((store.database.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous, 2);
  assert.equal(
    (store.database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count,
    1,
  );
  store.assertIntegrity();
  store.close();
});

test("a newer database schema is rejected without mutation", () => {
  const path = temporaryDatabase();
  const database = new DatabaseSync(path);
  database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
  database.close();
  assert.throws(() => new SessionStore(path), /newer than supported/);
  const inspection = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    (inspection.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    CURRENT_SCHEMA_VERSION + 1,
  );
  assert.equal(
    inspection.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'").get(),
    undefined,
  );
  inspection.close();
});

test("thread names normalize line-breaking whitespace and reject other controls", () => {
  const path = temporaryDatabase();
  const store = new SessionStore(path);
  const thread = store.createThread({
    threadId: "thread_name_controls",
    name: "  Alpha\r\n Beta\tGamma  ",
  });
  assert.equal(thread.name, "Alpha Beta Gamma");
  assert.equal(store.nameThread(thread.threadId, " Next\n\nname ").name, "Next name");
  assert.throws(
    () => store.createThread({ threadId: "thread_bad_name", name: "unsafe\0name" }),
    /control characters/u,
  );
  assert.throws(() => store.nameThread(thread.threadId, "unsafe\u001bname"), /control characters/u);
  assert.equal(store.getThread(thread.threadId).name, "Next name");
  store.close();
  const reopened = new SessionStore(path);
  assert.equal(reopened.getThread(thread.threadId).name, "Next name");
  reopened.close();
});

test("model selections override older run history on their reachable branch and survive restart", () => {
  const path = temporaryDatabase();
  let store = new SessionStore(path, { idFactory: ids("model-selection") });
  const thread = store.createThread({ threadId: "thread_model_selection" });
  const run = store.startRun({
    threadId: thread.threadId,
    runId: "run_model_selection",
    provider: "provider-a",
    model: "model-a",
  });
  store.appendEvent({
    threadId: thread.threadId,
    runId: run.runId,
    event: { type: "run_started", provider: "provider-a", model: "model-a" },
  });
  const completed = store.appendEvent({
    threadId: thread.threadId,
    runId: run.runId,
    event: { type: "run_completed", finishReason: "stop" },
  });
  store.appendEvent({
    threadId: thread.threadId,
    event: { type: "model_selected", provider: "provider-b", model: "model-b", reasoningEffort: "high" },
  });
  store.forkBranch({
    threadId: thread.threadId,
    fromBranch: "main",
    newBranch: "before-selection",
    atEventId: completed.eventId,
  });

  assert.deepEqual(store.getModelSelection(thread.threadId), {
    provider: "provider-b",
    model: "model-b",
    reasoningEffort: "high",
  });
  assert.deepEqual(store.getModelSelection(thread.threadId, "before-selection"), { provider: "provider-a", model: "model-a" });

  const legacy = store.createThread({ threadId: "thread_legacy_model_selection" });
  store.appendEvent({
    threadId: legacy.threadId,
    event: { type: "model_selected", provider: "provider-legacy", model: "model-legacy" },
  });
  assert.deepEqual(store.getModelSelection(legacy.threadId), {
    provider: "provider-legacy",
    model: "model-legacy",
  });
  store.close();

  store = new SessionStore(path);
  assert.deepEqual(store.getModelSelection(thread.threadId), {
    provider: "provider-b",
    model: "model-b",
    reasoningEffort: "high",
  });
  assert.deepEqual(store.getModelSelection(thread.threadId, "before-selection"), { provider: "provider-a", model: "model-a" });
  assert.deepEqual(store.getModelSelection(legacy.threadId), {
    provider: "provider-legacy",
    model: "model-legacy",
  });
  store.close();
});

test("forking moves only the new branch head and preserves immutable ancestry", () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: ids("branch") });
  const thread = store.createThread({ threadId: "thread_a", name: "before" });
  const first = store.appendEvent({
    threadId: thread.threadId,
    event: { type: "warning", code: "one", message: "first" },
  });
  const second = store.appendEvent({
    threadId: thread.threadId,
    event: { type: "warning", code: "two", message: "second" },
  });
  store.forkBranch({
    threadId: thread.threadId,
    newBranch: "experiment",
    atEventId: first.eventId,
  });
  const forked = store.appendEvent({
    threadId: thread.threadId,
    branch: "experiment",
    event: { type: "warning", code: "three", message: "fork" },
  });

  assert.deepEqual(store.listEvents(thread.threadId).map((event) => event.eventId), [first.eventId, second.eventId]);
  assert.deepEqual(store.listEvents(thread.threadId, "experiment").map((event) => event.eventId), [
    first.eventId,
    forked.eventId,
  ]);
  assert.equal(forked.parentEventId, first.eventId);
  assert.deepEqual(
    store.listBranches(thread.threadId).map((branch) => [branch.name, branch.headEventId]),
    [
      ["experiment", forked.eventId],
      ["main", second.eventId],
    ],
  );
  assert.equal(store.nameThread(thread.threadId, "after").name, "after");
  assert.throws(
    () => store.forkBranch({ threadId: thread.threadId, newBranch: "bad", atEventId: forked.eventId }),
    /not reachable/,
  );
  const empty = store.forkBranch({ threadId: thread.threadId, newBranch: "empty", atEventId: null });
  assert.equal(empty.headEventId, undefined);
  const fromRoot = store.appendEvent({
    threadId: thread.threadId,
    branch: "empty",
    event: { type: "warning", code: "root", message: "from root" },
  });
  assert.equal(fromRoot.parentEventId, undefined);
  store.close();
});

test("event pages exclude unreachable events after a deleted branch name is reused", () => {
  const path = temporaryDatabase();
  let store = new SessionStore(path, { idFactory: ids("branch-reuse") });
  const thread = store.createThread({ threadId: "thread_branch_reuse" });
  const root = store.appendEvent({
    threadId: thread.threadId,
    event: { type: "warning", code: "root", message: "root" },
  });
  store.forkBranch({ threadId: thread.threadId, newBranch: "experiment", atEventId: root.eventId });
  store.appendEvent({
    threadId: thread.threadId,
    branch: "experiment",
    event: { type: "warning", code: "unreachable", message: "old branch incarnation" },
  });
  store.deleteBranch(thread.threadId, "experiment");
  store.forkBranch({ threadId: thread.threadId, newBranch: "experiment", atEventId: root.eventId });
  const reachable = store.appendEvent({
    threadId: thread.threadId,
    branch: "experiment",
    event: { type: "warning", code: "reachable", message: "new branch incarnation" },
  });
  store.close();

  store = new SessionStore(path);
  const paged: EventEnvelope[] = [];
  let cursor = 0;
  while (true) {
    const page = store.listEventPage(thread.threadId, "experiment", { afterSequence: cursor, limit: 1 });
    paged.push(...page.events);
    cursor = page.nextSequence;
    if (!page.hasMore) break;
  }
  assert.deepEqual(
    paged.map((event) => event.eventId),
    store.listEvents(thread.threadId, "experiment").map((event) => event.eventId),
  );
  assert.deepEqual(paged.map((event) => event.eventId), [root.eventId, reachable.eventId]);
  store.close();
});

test("cold event paging materializes bounded rows for a large single branch", () => {
  const path = temporaryDatabase();
  let store = new SessionStore(path, { idFactory: ids("bounded-single") });
  const thread = store.createThread({ threadId: "thread_bounded_single" });
  const last = appendWarnings(store, thread.threadId, 10_000);
  store.close();

  store = new SessionStore(path);
  const measured = countMaterializedRows(store, () => store.listEventPage(thread.threadId, "main", {
    afterSequence: last.sequence - 1,
    limit: 1,
  }));
  assert.deepEqual(measured.value.events.map((event) => event.eventId), [last.eventId]);
  assert.ok(measured.rows <= 16, `cold page materialized ${measured.rows} rows`);
  store.close();
});

test("cold event paging ignores large unrelated branch histories", () => {
  const path = temporaryDatabase();
  let store = new SessionStore(path, { idFactory: ids("bounded-branches") });
  const thread = store.createThread({ threadId: "thread_bounded_branches" });
  const root = store.appendEvent({
    threadId: thread.threadId,
    event: { type: "warning", code: "root", message: "root" },
  });
  store.forkBranch({ threadId: thread.threadId, newBranch: "target", atEventId: root.eventId });
  const target = store.appendEvent({
    threadId: thread.threadId,
    branch: "target",
    event: { type: "warning", code: "target", message: "target" },
  });
  for (let index = 0; index < 32; index += 1) {
    const branch = `sibling-${index}`;
    store.forkBranch({ threadId: thread.threadId, newBranch: branch, atEventId: root.eventId });
    appendWarnings(store, thread.threadId, 200, branch);
  }
  store.close();

  store = new SessionStore(path);
  const measured = countMaterializedRows(store, () => store.listEventPage(thread.threadId, "target", {
    afterSequence: root.sequence,
    limit: 1,
  }));
  assert.deepEqual(measured.value.events.map((event) => event.eventId), [target.eventId]);
  assert.ok(measured.rows <= 16, `cold branch page materialized ${measured.rows} rows`);
  store.close();
});

test("cold progress paging validates in SQLite without decoding the complete branch", () => {
  const path = temporaryDatabase();
  let store = new SessionStore(path, { idFactory: ids("bounded-progress") });
  const thread = store.createThread({ threadId: "thread_bounded_progress" });
  let last: EventEnvelope | undefined;
  for (let offset = 0; offset < 2_000; offset += 500) {
    const appended = store.appendEvents({
      threadId: thread.threadId,
      events: Array.from({ length: 500 }, (_, index) => {
        const sequence = offset + index;
        return {
          type: "tool_progress" as const,
          callId: "call",
          name: "shell",
          index: 0,
          sequence,
          progress: {
            type: "output" as const,
            stream: "stdout" as const,
            delta: "x",
            stdoutBytes: sequence + 1,
            stderrBytes: 0,
          },
        };
      }),
    });
    last = appended.at(-1);
  }
  assert.notEqual(last, undefined);
  store.close();

  store = new SessionStore(path);
  let canonicalReads = 0;
  const listEvents = store.listEvents.bind(store);
  store.listEvents = (threadId, branch) => {
    canonicalReads += 1;
    return listEvents(threadId, branch);
  };
  const measured = countMaterializedRows(store, () => store.listEventPage(thread.threadId, "main", {
    afterSequence: last!.sequence - 1,
    limit: 1,
  }));
  assert.deepEqual(measured.value.events.map((event) => event.eventId), [last!.eventId]);
  assert.equal(canonicalReads, 0);
  assert.ok(measured.rows <= 16, `cold progress page materialized ${measured.rows} rows`);
  store.close();
});

test("event tails bound replay work by event count and encoded bytes", () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: ids("tail") });
  const thread = store.createThread({ threadId: "thread_tail" });
  for (let index = 0; index < 6; index += 1) {
    store.appendEvent({
      threadId: thread.threadId,
      event: { type: "warning", code: `warning-${index}`, message: `message-${index}` },
    });
  }

  const byCount = store.listEventTail(thread.threadId, undefined, { maxEvents: 3, maxBytes: 4_096 });
  assert.equal(byCount.truncated, true);
  assert.deepEqual(byCount.events.map((entry) => entry.event.type === "warning" ? entry.event.code : ""), [
    "warning-3",
    "warning-4",
    "warning-5",
  ]);

  const byBytes = store.listEventTail(thread.threadId, undefined, { maxEvents: 16, maxBytes: 100 });
  assert.equal(byBytes.truncated, true);
  assert.ok(byBytes.events.length > 0 && byBytes.events.length < 6);
  const latest = byBytes.events.at(-1)?.event;
  assert.equal(latest?.type, "warning");
  assert.equal(latest?.type === "warning" ? latest.code : "", "warning-5");

  const complete = store.listEventTail(thread.threadId, undefined, { maxEvents: 16, maxBytes: 4_096 });
  assert.equal(complete.truncated, false);
  assert.equal(complete.events.length, 6);
  assert.throws(() => store.listEventTail(thread.threadId, undefined, { maxEvents: 0 }), /maxEvents/u);
  assert.throws(() => store.listEventTail(thread.threadId, undefined, { maxBytes: 0 }), /maxBytes/u);
  store.close();
});

test("entry labels resolve latest changes across branches and survive restart", () => {
  const path = temporaryDatabase();
  let store = new SessionStore(path, { idFactory: ids("labels") });
  store.createThread({ threadId: "thread_labels" });
  const root = store.appendEvent({
    threadId: "thread_labels",
    eventId: "label-target",
    event: { type: "warning", code: "root", message: "root" },
  });
  store.forkBranch({ threadId: "thread_labels", fromBranch: "main", newBranch: "sibling", atEventId: root.eventId });
  const changed = store.setEntryLabel({
    threadId: "thread_labels",
    branch: "sibling",
    targetEventId: root.eventId,
    label: "  investigate\nthis  ",
  });
  assert.deepEqual(changed.event, { type: "entry_label_changed", targetEventId: root.eventId, label: "investigate this" });
  assert.equal(store.listEvents("thread_labels", "main").some((entry) => entry.event.type === "entry_label_changed"), false);
  assert.deepEqual(store.listEntryLabels("thread_labels").map((entry) => [entry.targetEventId, entry.label]), [
    [root.eventId, "investigate this"],
  ]);
  store.close();

  store = new SessionStore(path, { idFactory: ids("labels-restart") });
  assert.equal(store.listEntryLabels("thread_labels")[0]?.label, "investigate this");
  store.setEntryLabel({ threadId: "thread_labels", targetEventId: root.eventId, label: "updated" });
  assert.equal(store.listEntryLabels("thread_labels")[0]?.label, "updated");
  store.setEntryLabel({ threadId: "thread_labels", branch: "sibling", targetEventId: root.eventId });
  assert.deepEqual(store.listEntryLabels("thread_labels"), []);
  assert.throws(
    () => store.setEntryLabel({ threadId: "thread_labels", targetEventId: "missing", label: "x" }),
    /Unknown label target/u,
  );
  assert.throws(
    () => store.setEntryLabel({ threadId: "thread_labels", targetEventId: root.eventId, label: "x".repeat(257) }),
    /at most 256/u,
  );
  assert.throws(
    () => store.appendEvent({
      threadId: "thread_labels",
      event: { type: "entry_label_changed", targetEventId: "missing", label: "invalid" },
    }),
    /Unknown label target/u,
  );
  store.close();
});

test("active runs prevent deletion of their thread or branch", () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: ids("active-delete") });
  const thread = store.createThread({ threadId: "thread_active_delete" });
  const first = store.appendEvent({
    threadId: thread.threadId,
    event: { type: "warning", code: "base", message: "base" },
  });
  store.forkBranch({ threadId: thread.threadId, newBranch: "active", atEventId: first.eventId });
  const run = store.startRun({ threadId: thread.threadId, branch: "active", runId: "run_active_delete" });

  assert.throws(() => store.deleteBranch(thread.threadId, "active"), /active run/u);
  assert.throws(() => store.deleteThread(thread.threadId), /active run/u);
  assert.equal(store.getRun(run.runId).state, "preparing");
  assert.equal(store.getThread(thread.threadId).branches.some((branch) => branch.name === "active"), true);
  store.appendEvent({
    threadId: thread.threadId,
    branch: "active",
    runId: run.runId,
    event: { type: "run_cancelled", reason: "test complete" },
  });
  store.deleteBranch(thread.threadId, "active");
  store.deleteThread(thread.threadId);
  assert.throws(() => store.getThread(thread.threadId), /Unknown thread/u);
  store.close();
});

test("canonical messages and provider continuation state round-trip through events", () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: ids("messages") });
  store.createThread({ threadId: "thread_messages" });
  const event = {
    type: "message_appended" as const,
    message: {
      id: "message_one",
      role: "assistant" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      provider: "openai" as const,
      content: [
        { type: "text" as const, text: "hello" },
        {
          type: "provider_opaque" as const,
          provider: "openai" as const,
          mediaType: "application/json",
          value: { signature: "preserve" },
        },
      ],
    },
    providerState: {
      kind: "openai_responses" as const,
      previousResponseId: "response_one",
      outputItems: [{ type: "opaque", signature: "preserve" }],
      routed: {
        provider: "company" as const,
        model: "public-model",
        delegate: "openai" as const,
        upstreamModel: "upstream-model",
        protocolFamily: "openai-responses" as const,
        scope: "00000000-0000-4000-8000-000000000000",
      },
    },
  };
  store.appendEvent({ threadId: "thread_messages", event });
  assert.deepEqual(store.listEvents("thread_messages")[0]?.event, event);
  const invalid = structuredClone(event);
  invalid.message.id = "message_invalid_route_scope";
  invalid.providerState.routed.scope = "not-a-route-scope";
  assert.throws(
    () => store.appendEvent({ threadId: "thread_messages", event: invalid }),
    /Invalid event shape: message_appended/u,
  );
  store.close();
});

test("Mistral Conversations continuation state round-trips through durable events", () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: ids("mistral_state") });
  store.createThread({ threadId: "thread_mistral_state" });
  const event = {
    type: "message_appended" as const,
    message: {
      id: "mistral_message",
      role: "assistant" as const,
      createdAt: "2026-07-10T00:00:00.000Z",
      provider: "mistral" as const,
      content: [{ type: "text" as const, text: "hello" }],
    },
    providerState: {
      kind: "mistral_conversations" as const,
      conversationId: "conversation-1",
      model: "devstral-latest",
      requestFingerprint: "a".repeat(64),
      outputs: [{ object: "entry", type: "message.output", content: "hello" }],
    },
  };
  store.appendEvent({ threadId: "thread_mistral_state", event });
  assert.deepEqual(store.listEvents("thread_mistral_state")[0]?.event, event);
  store.close();
});

test("image-bearing tool results round-trip without losing result correlation", () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: ids("tool_images") });
  store.createThread({ threadId: "thread_tool_images" });
  const event = {
    type: "message_appended" as const,
    message: {
      id: "tool_image_message",
      role: "tool" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      content: [{
        type: "tool_result" as const,
        callId: "read-image",
        name: "read",
        content: "attached pixel.png",
        isError: false,
        images: [{ type: "image" as const, mediaType: "image/png", data: "AQID" }],
      }],
    },
  };
  store.appendEvent({ threadId: "thread_tool_images", event });
  assert.deepEqual(store.listEvents("thread_tool_images")[0]?.event, event);
  store.close();
});

test("stale branch heads fail instead of silently reparenting events", () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: ids("heads") });
  const thread = store.createThread({ threadId: "thread_head" });
  const first = store.appendEvent({
    threadId: thread.threadId,
    expectedHead: null,
    event: { type: "warning", code: "first", message: "first" },
  });
  assert.throws(
    () =>
      store.appendEvent({
        threadId: thread.threadId,
        expectedHead: null,
        event: { type: "warning", code: "stale", message: "stale" },
      }),
    /changed before append/,
  );
  const second = store.appendEvent({
    threadId: thread.threadId,
    expectedHead: first.eventId,
    event: { type: "warning", code: "second", message: "second" },
  });
  assert.equal(second.sequence, 2);
  store.close();
});

test("foreign keys prevent branch heads and artifacts from crossing thread boundaries", () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: ids("foreign") });
  store.createThread({ threadId: "thread_left" });
  store.createThread({ threadId: "thread_right" });
  const event = store.appendEvent({
    threadId: "thread_left",
    event: { type: "warning", code: "left", message: "left" },
  });
  assert.throws(
    () =>
      store.database
        .prepare("UPDATE branches SET head_event_id = ? WHERE thread_id = ? AND branch_name = 'main'")
        .run(event.eventId, "thread_right"),
    /FOREIGN KEY constraint failed/,
  );
  assert.throws(
    () =>
      store.putArtifact({
        threadId: "thread_right",
        eventId: event.eventId,
        mediaType: "text/plain",
        content: Buffer.from("x"),
      }),
    /FOREIGN KEY constraint failed/,
  );
  store.close();
});

test("sequence allocation remains monotonic across database connections", () => {
  const path = temporaryDatabase();
  const left = new SessionStore(path, { idFactory: ids("left") });
  left.createThread({ threadId: "thread_multi" });
  const right = new SessionStore(path, { idFactory: ids("right") });
  for (let index = 0; index < 40; index += 1) {
    const store = index % 2 === 0 ? left : right;
    store.appendEvent({
      threadId: "thread_multi",
      event: { type: "warning", code: `event-${index}`, message: "sequenced" },
    });
  }
  assert.deepEqual(
    right.listEvents("thread_multi").map((event) => event.sequence),
    Array.from({ length: 40 }, (_, index) => index + 1),
  );
  left.assertIntegrity();
  right.close();
  left.close();
});

test("one active run is enforced and terminal events release the thread", () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: ids("runs") });
  store.createThread({ threadId: "thread_run" });
  const first = store.startRun({ threadId: "thread_run", runId: "run_one", provider: "openai", model: "model" });
  assert.equal(first.state, "preparing");
  assert.throws(() => store.startRun({ threadId: "thread_run", runId: "run_two" }), /active run/);
  store.appendEvents({
    threadId: "thread_run",
    runId: first.runId,
    events: [
      { type: "run_state", state: "streaming" },
      { type: "run_state", state: "completed" },
      { type: "run_completed", finishReason: "stop" },
    ],
  });
  assert.equal(store.getRun(first.runId).state, "completed");
  assert.equal(store.startRun({ threadId: "thread_run", runId: "run_two" }).runId, "run_two");
  store.close();
});

test("event sinks create their run from run_started and reject an invalid first event", async () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: ids("sink") });
  store.createThread({ threadId: "thread_sink" });
  const invalid = store.createEventSink({ threadId: "thread_sink", runId: "run_invalid" });
  await assert.rejects(invalid.emit({ type: "run_state", state: "preparing" }), /first run event/);

  const sink = store.createEventSink({ threadId: "thread_sink", runId: "run_sink" });
  const started = await sink.emit({
    type: "run_started",
    provider: "anthropic",
    model: "model",
    promptComposition: {
      bytes: 120,
      sha256: "a".repeat(64),
      sources: [{
        kind: "instruction",
        source: "/workspace/AGENTS.md",
        bytes: 12,
        sha256: "b".repeat(64),
      }],
      tools: ["read"],
      skills: [{ name: "review", manifestPath: "/skills/review/SKILL.md" }],
      truncated: false,
    },
  });
  await sink.emit({ type: "run_state", state: "completed" });
  await sink.emit({ type: "run_completed", finishReason: "stop" });
  assert.equal(started.sequence, 1);
  assert.equal(started.event.type === "run_started" ? started.event.promptComposition?.sources[0]?.source : undefined, "/workspace/AGENTS.md");
  assert.equal(store.getRun("run_sink").state, "completed");

  const secretBearing = store.createEventSink({ threadId: "thread_sink", runId: "run_secret_prompt" });
  await assert.rejects(secretBearing.emit({
    type: "run_started",
    provider: "anthropic",
    model: "model",
    promptComposition: {
      bytes: 12,
      sha256: "a".repeat(64),
      sources: [{
        kind: "instruction",
        source: "/workspace/AGENTS.md",
        bytes: 12,
        sha256: "b".repeat(64),
        text: "must not persist",
      }],
      tools: [],
      skills: [],
      truncated: false,
    },
  } as never), /Invalid event shape: run_started/u);
  store.close();
});

test("durable event replay rejects out-of-order tool progress", () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: ids("progress-order") });
  store.createThread({ threadId: "thread_progress_order" });
  const run = store.startRun({ threadId: "thread_progress_order", runId: "run_progress_order" });
  store.appendEvents({
    threadId: run.threadId,
    runId: run.runId,
    events: [
      { type: "tool_requested", callId: "call", name: "shell", input: { command: "x" }, index: 0 },
      { type: "tool_started", callId: "call", name: "shell", index: 0 },
      {
        type: "tool_progress",
        callId: "call",
        name: "shell",
        index: 0,
        sequence: 1,
        progress: { type: "output", stream: "stdout", delta: "late", stdoutBytes: 4, stderrBytes: 0 },
      },
    ],
  });
  assert.throws(() => store.listEvents(run.threadId), /Out-of-order tool progress/u);
  assert.throws(
    () => store.listEventPage(run.threadId, "main", { afterSequence: 3, limit: 10 }),
    /Out-of-order tool progress/u,
  );
  store.close();
});

test("paged replay rejects malformed progress fields on a cold cache", () => {
  const path = temporaryDatabase();
  let store = new SessionStore(path, { idFactory: ids("malformed-progress") });
  const thread = store.createThread({ threadId: "thread_malformed_progress" });
  const progress = store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "tool_progress",
      callId: "call",
      name: "shell",
      index: 0,
      sequence: 0,
      progress: { type: "output", stream: "stdout", delta: "ok", stdoutBytes: 2, stderrBytes: 0 },
    },
  });
  store.close();

  const database = new DatabaseSync(path);
  database.prepare(`
    UPDATE events
    SET payload_json = json_remove(payload_json, '$.callId')
    WHERE event_id = ?
  `).run(progress.eventId);
  database.close();

  store = new SessionStore(path);
  assert.throws(
    () => store.listEventPage(thread.threadId, "main", { afterSequence: progress.sequence, limit: 1 }),
    /Invalid call_id|Out-of-order tool progress/u,
  );
  store.close();
});

test("paged progress cache evicts the least-recently-used branch and safely revalidates it", () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: ids("progress-lru") });
  for (let index = 0; index < 65; index += 1) {
    const threadId = `thread_progress_lru_${index}`;
    store.createThread({ threadId });
    store.appendEvent({
      threadId,
      event: {
        type: "tool_progress",
        callId: "call",
        name: "shell",
        index: 0,
        sequence: 0,
        progress: { type: "output", stream: "stdout", delta: "ok", stdoutBytes: 2, stderrBytes: 0 },
      },
    });
  }
  for (let index = 0; index < 64; index += 1) {
    store.listEventPage(`thread_progress_lru_${index}`, "main", { limit: 1 });
  }
  store.listEventPage("thread_progress_lru_0", "main", { limit: 1 });
  store.listEventPage("thread_progress_lru_64", "main", { limit: 1 });
  store.database.prepare(`
    UPDATE events
    SET payload_json = json_set(payload_json, '$.sequence', 1)
    WHERE thread_id = 'thread_progress_lru_1'
  `).run();

  assert.equal(store.listEventPage("thread_progress_lru_0", "main", { limit: 1 }).events.length, 1);
  assert.throws(
    () => store.listEventPage("thread_progress_lru_1", "main", { limit: 1 }),
    /Out-of-order tool progress/u,
  );
  store.close();
});

test("oversized paged progress state is not retained and falls back to full validation", () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: ids("progress-cache-budget") });
  const thread = store.createThread({ threadId: "thread_progress_cache_budget" });
  for (let offset = 0; offset < 4_097; offset += 500) {
    store.appendEvents({
      threadId: thread.threadId,
      events: Array.from({ length: Math.min(500, 4_097 - offset) }, (_, index) => ({
        type: "tool_progress" as const,
        callId: `call-${offset + index}`,
        name: "shell",
        index: offset + index,
        sequence: 0,
        progress: { type: "output" as const, stream: "stdout" as const, delta: "x", stdoutBytes: 1, stderrBytes: 0 },
      })),
    });
  }
  store.listEventPage(thread.threadId, "main", { afterSequence: 4_096, limit: 1 });
  store.database.prepare(`
    UPDATE events
    SET payload_json = json_set(payload_json, '$.sequence', 1)
    WHERE thread_id = ? AND sequence = 1
  `).run(thread.threadId);
  assert.throws(
    () => store.listEventPage(thread.threadId, "main", { afterSequence: 4_096, limit: 1 }),
    /Out-of-order tool progress/u,
  );
  store.close();
});

test("paged replay resets integrity state when a deleted thread id is reused", () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: () => "event_reused_thread" });
  store.createThread({ threadId: "thread_reused" });
  store.appendEvent({
    threadId: "thread_reused",
    event: {
      type: "tool_progress",
      callId: "call",
      name: "shell",
      index: 0,
      sequence: 0,
      progress: { type: "output", stream: "stdout", delta: "ok", stdoutBytes: 2, stderrBytes: 0 },
    },
  });
  assert.equal(store.listEventPage("thread_reused", "main", { limit: 1 }).events.length, 1);
  store.deleteThread("thread_reused");

  store.createThread({ threadId: "thread_reused" });
  store.appendEvent({
    threadId: "thread_reused",
    event: {
      type: "tool_progress",
      callId: "call",
      name: "shell",
      index: 0,
      sequence: 1,
      progress: { type: "output", stream: "stdout", delta: "late", stdoutBytes: 4, stderrBytes: 0 },
    },
  });
  assert.throws(
    () => store.listEventPage("thread_reused", "main", { afterSequence: 1, limit: 1 }),
    /Out-of-order tool progress/u,
  );
  store.close();
});

test("paged replay invalidates cached integrity across connection-local thread reuse", () => {
  const path = temporaryDatabase();
  const first = new SessionStore(path);
  const second = new SessionStore(path);
  first.createThread({ threadId: "thread_cross_connection_reuse" });
  first.appendEvent({
    threadId: "thread_cross_connection_reuse",
    eventId: "event_cross_connection_reuse",
    event: {
      type: "tool_progress",
      callId: "call",
      name: "shell",
      index: 0,
      sequence: 0,
      progress: { type: "output", stream: "stdout", delta: "ok", stdoutBytes: 2, stderrBytes: 0 },
    },
  });
  assert.equal(first.listEventPage("thread_cross_connection_reuse", "main", { limit: 1 }).events.length, 1);

  second.deleteThread("thread_cross_connection_reuse");
  second.createThread({ threadId: "thread_cross_connection_reuse" });
  second.appendEvent({
    threadId: "thread_cross_connection_reuse",
    eventId: "event_cross_connection_reuse",
    event: {
      type: "tool_progress",
      callId: "call",
      name: "shell",
      index: 0,
      sequence: 1,
      progress: { type: "output", stream: "stdout", delta: "late", stdoutBytes: 4, stderrBytes: 0 },
    },
  });
  assert.throws(
    () => first.listEventPage("thread_cross_connection_reuse", "main", { limit: 1 }),
    /Out-of-order tool progress/u,
  );
  second.close();
  first.close();
});

test("paged progress validation checks only the descendant suffix as a branch head advances", () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: ids("progress-suffix") });
  store.createThread({ threadId: "thread_progress_suffix" });
  store.appendEvent({
    threadId: "thread_progress_suffix",
    event: {
      type: "tool_progress",
      callId: "call",
      name: "shell",
      index: 0,
      sequence: 0,
      progress: { type: "output", stream: "stdout", delta: "ok", stdoutBytes: 2, stderrBytes: 0 },
    },
  });
  let canonicalReads = 0;
  const listEvents = store.listEvents.bind(store);
  store.listEvents = (threadId, branch) => {
    canonicalReads += 1;
    return listEvents(threadId, branch);
  };
  store.listEventPage("thread_progress_suffix", "main", { limit: 1 });

  for (let index = 0; index < 10; index += 1) {
    const warning = store.appendEvent({
      threadId: "thread_progress_suffix",
      event: { type: "warning", code: `warning-${index}`, message: `warning-${index}` },
    });
    assert.equal(
      store.listEventPage("thread_progress_suffix", "main", { afterSequence: warning.sequence, limit: 1 }).events.length,
      0,
    );
  }
  assert.equal(canonicalReads, 0);

  const corrupt = store.appendEvent({
    threadId: "thread_progress_suffix",
    event: {
      type: "tool_progress",
      callId: "call",
      name: "shell",
      index: 0,
      sequence: 2,
      progress: { type: "output", stream: "stdout", delta: "gap", stdoutBytes: 5, stderrBytes: 0 },
    },
  });
  assert.throws(
    () => store.listEventPage("thread_progress_suffix", "main", { afterSequence: corrupt.sequence, limit: 1 }),
    /Out-of-order tool progress/u,
  );
  assert.equal(canonicalReads, 0);
  store.close();
});

test("recovery distinguishes tools that never started from tools with an unknown outcome", () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: ids("recovery") });
  store.createThread({ threadId: "thread_recovery" });
  const run = store.startRun({ threadId: "thread_recovery", runId: "run_recovery" });
  store.appendEvents({
    threadId: run.threadId,
    runId: run.runId,
    events: [
      { type: "tool_requested", callId: "not-started", name: "shell", input: { command: "x" }, index: 0 },
      { type: "tool_requested", callId: "in-doubt", name: "write", input: { path: "a" }, index: 1 },
      { type: "tool_started", callId: "in-doubt", name: "write", index: 1 },
      { type: "tool_requested", callId: "done", name: "read", input: { path: "a" }, index: 2 },
      { type: "tool_started", callId: "done", name: "read", index: 2 },
      {
        type: "tool_completed",
        callId: "done",
        name: "read",
        index: 2,
        isError: false,
        preview: "exact completed result",
        result: {
          type: "tool_result",
          callId: "done",
          name: "read",
          content: "exact completed result",
          isError: false,
          artifactIds: ["artifact_1"],
          metadata: { bytes: 42 },
        },
      },
    ],
  });

  assert.deepEqual(store.recoverAbandonedRuns(), {
    recoveredRunIds: [run.runId],
    repairedToolCallIds: ["not-started", "in-doubt", "done"],
    inDoubtToolCallIds: ["in-doubt"],
    reconstructedToolCallIds: ["done"],
  });
  assert.equal(store.getRun(run.runId).state, "failed");
  const events = store.listEvents(run.threadId);
  const notStarted = events.filter(
    (envelope) => envelope.event.type === "tool_completed" && envelope.event.callId === "not-started",
  );
  assert.equal(notStarted.length, 1);
  assert.equal(notStarted[0]?.event.type === "tool_completed" && notStarted[0].event.isError, true);
  assert.match(notStarted[0]?.event.type === "tool_completed" ? notStarted[0].event.preview : "", /did not start/u);
  const inDoubt = events.filter(
    (envelope) => envelope.event.type === "tool_in_doubt" && envelope.event.callId === "in-doubt",
  );
  assert.equal(inDoubt.length, 1);
  const recoveryMessage = events.findLast(
    (envelope) => envelope.event.type === "message_appended" && envelope.event.message.role === "tool",
  );
  const blocks = recoveryMessage?.event.type === "message_appended" ? recoveryMessage.event.message.content : [];
  const notStartedBlock = blocks.find((block) => block.type === "tool_result" && block.callId === "not-started");
  const inDoubtBlock = blocks.find((block) => block.type === "tool_result" && block.callId === "in-doubt");
  const completedBlock = blocks.find((block) => block.type === "tool_result" && block.callId === "done");
  assert.match(notStartedBlock?.type === "tool_result" ? notStartedBlock.content : "", /did not start/u);
  assert.match(inDoubtBlock?.type === "tool_result" ? inDoubtBlock.content : "", /outcome is unknown/u);
  assert.match(inDoubtBlock?.type === "tool_result" ? inDoubtBlock.content : "", /do not retry automatically/iu);
  assert.deepEqual(completedBlock, {
    type: "tool_result",
    callId: "done",
    name: "read",
    content: "exact completed result",
    isError: false,
    artifactIds: ["artifact_1"],
    metadata: { bytes: 42 },
  });
  assert.deepEqual(store.recoverAbandonedRuns(), {
    recoveredRunIds: [],
    repairedToolCallIds: [],
    inDoubtToolCallIds: [],
    reconstructedToolCallIds: [],
  });
  store.close();
});

test("run recovery can be scoped to one workspace without touching another", () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: ids("scoped-recovery") });
  const leftWorkspace = join(tmpdir(), "workspace-left");
  const rightWorkspace = join(tmpdir(), "workspace-right");
  store.createThread({ threadId: "thread_recovery_left", workspaceRoot: leftWorkspace });
  store.createThread({ threadId: "thread_recovery_right", workspaceRoot: rightWorkspace });
  const left = store.startRun({ threadId: "thread_recovery_left", runId: "run_recovery_left" });
  const right = store.startRun({ threadId: "thread_recovery_right", runId: "run_recovery_right" });

  assert.deepEqual(store.recoverAbandonedRuns(leftWorkspace).recoveredRunIds, [left.runId]);
  assert.equal(store.getRun(left.runId).state, "failed");
  assert.equal(store.getRun(right.runId).state, "preparing");
  assert.deepEqual(store.recoverAbandonedRuns(rightWorkspace).recoveredRunIds, [right.runId]);
  assert.equal(store.getRun(right.runId).state, "failed");
  store.close();
});

test("corrupt event shape aborts recovery without partial repair", () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: ids("corrupt") });
  store.createThread({ threadId: "thread_corrupt" });
  const run = store.startRun({ threadId: "thread_corrupt", runId: "run_corrupt" });
  const requested = store.appendEvent({
    threadId: run.threadId,
    runId: run.runId,
    event: { type: "tool_requested", callId: "broken", name: "shell", input: {}, index: 0 },
  });
  store.database
    .prepare("UPDATE events SET payload_json = ? WHERE event_id = ?")
    .run(JSON.stringify({ type: "warning", code: "tampered", message: "bad" }), requested.eventId);

  assert.throws(() => store.recoverAbandonedRuns(), /kind mismatch/);
  assert.equal(store.getRun(run.runId).state, "preparing");
  assert.equal(
    (store.database.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count,
    1,
  );
  store.close();
});

test("artifacts enforce per-item and store quotas and export with content intact", () => {
  const store = new SessionStore(temporaryDatabase(), {
    idFactory: ids("artifacts"),
    maxArtifactBytes: 5,
    maxArtifactStoreBytes: 8,
  });
  store.createThread({ threadId: "thread_artifact", name: "artifact thread" });
  const artifact = store.putArtifact({
    threadId: "thread_artifact",
    artifactId: "artifact_one",
    mediaType: "text/plain",
    content: Buffer.from("hello"),
  });
  assert.equal(artifact.sha256, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.equal(Buffer.from(store.getArtifact(artifact.artifactId).content).toString(), "hello");
  assert.throws(
    () => store.putArtifact({ threadId: "thread_artifact", content: Buffer.from("123456"), mediaType: "text/plain" }),
    /exceeds 5 byte/,
  );
  assert.throws(
    () => store.putArtifact({ threadId: "thread_artifact", content: Buffer.from("1234"), mediaType: "text/plain" }),
    /store exceeds 8 byte/,
  );

  const exported = store.exportThread("thread_artifact").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(exported[0], {
    type: "format",
    value: { format: "rigyn/session-jsonl", schemaVersion: 2 },
  });
  assert.equal(exported[1].type, "thread");
  assert.equal(exported.at(-1).value.content, Buffer.from("hello").toString("base64"));
  store.close();
});

test("threads are workspace-bound and searchable without wildcard surprises", () => {
  const store = new SessionStore(temporaryDatabase(), { idFactory: ids("workspace") });
  store.createThread({ threadId: "thread_one", name: "alpha 100%_done", workspaceRoot: "/workspace/one" });
  store.createThread({ threadId: "thread_two", name: "beta", workspaceRoot: "/workspace/two" });
  store.createThread({ threadId: "thread_legacy" });
  store.appendEvent({
    threadId: "thread_one",
    event: {
      type: "message_appended",
      message: {
        id: "message_search",
        role: "user",
        createdAt: "2026-01-01T00:00:00.000Z",
        content: [{ type: "text", text: "find this exact needle" }],
      },
    },
  });

  assert.deepEqual(store.listThreads({ workspaceRoot: "/workspace/one" }).map((entry) => entry.threadId), ["thread_one"]);
  assert.deepEqual(store.listThreads({ workspaceRoot: "/workspace/one", search: "needle" }).map((entry) => entry.threadId), ["thread_one"]);
  assert.deepEqual(store.listThreads({ search: "100%_done" }).map((entry) => entry.threadId), ["thread_one"]);
  assert.equal(store.bindThreadWorkspace("thread_legacy", "/workspace/one").workspaceRoot, "/workspace/one");
  assert.deepEqual(store.listDurableWorkspaceRoots(), ["/workspace/one"]);
  assert.throws(() => store.bindThreadWorkspace("thread_one", "/workspace/two"), /belongs to \/workspace\/one/u);
  store.close();
});
