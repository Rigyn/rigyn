import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import type { CanonicalMessage } from "../../src/core/types.js";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  buildContextEntries,
  buildSessionContext,
  findMostRecentSession,
  getDefaultSessionDir,
  loadEntriesFromFile,
  migrateSessionEntries,
  parseSessionEntries,
  type FileEntry,
  type SessionEntry,
} from "../../src/storage/index.js";

const roots = new Set<string>();

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-manager-"));
  roots.add(root);
  return root;
}

test.afterEach(async () => {
  await Promise.all([...roots].map(async (root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

let messageSequence = 0;

function message(
  role: "system" | "user" | "assistant" | "tool",
  text: string,
  options: { provider?: string; model?: string; timestamp?: number } = {},
): CanonicalMessage & { model?: string; timestamp?: number } {
  messageSequence += 1;
  return {
    id: `message-${messageSequence}`,
    role,
    content: [{ type: "text", text }],
    createdAt: new Date(1_700_000_000_000 + messageSequence).toISOString(),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
  };
}

function jsonLines(path: string): FileEntry[] {
  return parseSessionEntries(readFileSync(path, "utf8"));
}

test("new sessions expose a version-three header without touching disk", async () => {
  const root = await temporaryRoot();
  const cwd = join(root, "workspace");
  const sessions = join(root, "sessions");
  const manager = SessionManager.create(cwd, sessions, { id: "session.one" });

  assert.equal(manager.getSessionId(), "session.one");
  assert.equal(manager.getCwd(), resolve(cwd));
  assert.equal(manager.getSessionDir(), resolve(sessions));
  assert.equal(manager.getHeader()?.version, CURRENT_SESSION_VERSION);
  assert.equal(manager.getHeader()?.type, "session");
  assert.equal(manager.getHeader()?.cwd, resolve(cwd));
  assert.equal(manager.getLeafId(), null);
  assert.deepEqual(manager.getEntries(), []);
  assert.equal(existsSync(manager.getSessionFile()!), false);
  assert.match(basename(manager.getSessionFile()!), /_session\.one\.jsonl$/u);
});

test("Windows workspace identity is case-insensitive for session directories and discovery", async () => {
  const root = await temporaryRoot();
  const upper = String.raw`C:\Repo\Workspace`;
  const lower = "c:/repo/workspace";
  assert.equal(getDefaultSessionDir(upper, join(root, "agent")), getDefaultSessionDir(lower, join(root, "agent")));

  const sessions = join(root, "sessions");
  await mkdir(sessions);
  const file = join(sessions, "session.jsonl");
  await writeFile(file, `${JSON.stringify({
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: "session",
    timestamp: new Date(0).toISOString(),
    cwd: upper,
  })}\n`);
  assert.equal(findMostRecentSession(sessions, lower), file);
});

test("default session directory detection follows native filesystem identity", async () => {
  const root = await temporaryRoot();
  const workspace = join(root, "workspace");
  const directory = getDefaultSessionDir(workspace);
  const suppliedDirectory = process.platform === "win32" ? directory.toUpperCase() : directory;
  const file = join(directory, "legacy.jsonl");
  await writeFile(file, `${JSON.stringify({
    type: "session",
    id: "legacy",
    timestamp: new Date(0).toISOString(),
  })}\n`);

  const continued = SessionManager.continueRecent(workspace, suppliedDirectory);
  assert.equal(continued.getSessionId(), "legacy");
  assert.equal(continued.usesDefaultSessionDir(), true);
  assert.deepEqual((await SessionManager.inspect(workspace, suppliedDirectory)).sessions.map((entry) => entry.id), ["legacy"]);
});

test("persistence starts at the first assistant message and flushes prior entries once", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.create(root, join(root, "sessions"));
  const file = manager.getSessionFile()!;
  const userId = manager.appendMessage(message("user", "hello"));
  manager.appendThinkingLevelChange("high");
  manager.appendModelChange("openai", "gpt-test");
  assert.equal(existsSync(file), false);

  const assistantId = manager.appendMessage(message("assistant", "hi", { provider: "openai", model: "gpt-test" }));
  assert.equal(existsSync(file), true);
  const stored = jsonLines(file);
  assert.deepEqual(stored.map((entry) => entry.type), [
    "session",
    "message",
    "thinking_level_change",
    "model_change",
    "message",
  ]);
  assert.equal((stored[1] as SessionEntry).id, userId);
  assert.equal((stored[4] as SessionEntry).id, assistantId);
  assert.equal((stored[4] as SessionEntry).parentId, (stored[3] as SessionEntry).id);

  manager.appendMessage(message("user", "again"));
  assert.equal(jsonLines(file).length, 6);
});

test("an abandoned session never creates its planned file", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage(message("user", "never answered"));
  manager.appendCustomEntry("state", { pending: true });
  assert.equal(existsSync(manager.getSessionFile()!), false);
});

test("branches are parent links and moving the leaf never rewrites history", () => {
  const manager = SessionManager.inMemory("/tmp", { id: "branching" });
  const root = manager.appendMessage(message("user", "root"));
  const firstReply = manager.appendMessage(message("assistant", "first"));
  manager.branch(root);
  const secondReply = manager.appendMessage(message("assistant", "second"));

  assert.deepEqual(manager.getBranch(firstReply).map((entry) => entry.id), [root, firstReply]);
  assert.deepEqual(manager.getBranch(secondReply).map((entry) => entry.id), [root, secondReply]);
  assert.deepEqual(manager.getChildren(root).map((entry) => entry.id), [firstReply, secondReply]);
  assert.equal(manager.getLeafId(), secondReply);

  manager.resetLeaf();
  const otherRoot = manager.appendMessage(message("user", "independent root"));
  assert.equal(manager.getEntry(otherRoot)?.parentId, null);
  assert.equal(manager.getTree().length, 2);
});

test("context follows the selected leaf and applies only the newest compaction", () => {
  const manager = SessionManager.inMemory();
  const oldUser = manager.appendMessage(message("user", "old"));
  manager.appendThinkingLevelChange("high");
  manager.appendModelChange("anthropic", "model-a");
  const keptUser = manager.appendMessage(message("user", "kept"));
  const compact = manager.appendCompaction("summary", keptUser, 900);
  const reply = manager.appendMessage(message("assistant", "new", { provider: "anthropic", model: "model-b" }));
  const entries = manager.buildContextEntries();

  assert.deepEqual(entries.map((entry) => entry.id), [compact, keptUser, reply]);
  const context = manager.buildSessionContext();
  assert.deepEqual(context.messages.map((item) => item.role), ["compactionSummary", "user", "assistant"]);
  assert.equal(context.thinkingLevel, "high");
  assert.deepEqual(context.model, {
    provider: "anthropic",
    modelId: "model-a",
  });
  assert.equal(entries.some((entry) => entry.id === oldUser), false);
});

test("custom state is hidden while custom and branch-summary messages enter context", () => {
  const manager = SessionManager.inMemory();
  const root = manager.appendMessage(message("user", "root"));
  manager.appendCustomEntry("memory", { private: "state" });
  manager.appendCustomMessageEntry("notice", "visible to model", false, { displayOnly: false });
  manager.branchWithSummary(root, "abandoned work", { source: 2 }, true);

  const context = manager.buildSessionContext();
  assert.deepEqual(context.messages.map((item) => item.role), ["user", "branchSummary"]);
  const alternate = buildSessionContext(manager.getEntries(), manager.getEntries()[2]?.id);
  assert.deepEqual(alternate.messages.map((item) => item.role), ["user", "custom"]);
  assert.equal(alternate.messages.some((item) => item.role === "custom" && item.customType === "notice"), true);
});

test("labels resolve onto tree nodes and empty values clear them", () => {
  const manager = SessionManager.inMemory();
  const target = manager.appendMessage(message("user", "bookmark me"));
  manager.appendLabelChange(target, "checkpoint");
  assert.equal(manager.getLabel(target), "checkpoint");
  assert.equal(manager.getTree()[0]?.label, "checkpoint");
  assert.equal(typeof manager.getTree()[0]?.labelTimestamp, "string");

  manager.appendLabelChange(target, "");
  assert.equal(manager.getLabel(target), undefined);
  assert.equal(manager.getTree()[0]?.label, undefined);
  assert.throws(() => manager.appendLabelChange("missing", "bad"), /not found/u);
});

test("session names are single-line metadata and the newest value wins", () => {
  const manager = SessionManager.inMemory();
  manager.appendSessionInfo("  First\nName  ");
  assert.equal(manager.getSessionName(), "First Name");
  manager.appendSessionInfo("   ");
  assert.equal(manager.getSessionName(), undefined);
});

test("an incomplete trailing record is ignored and removed before the next append", async () => {
  const root = await temporaryRoot();
  const path = join(root, "recoverable.jsonl");
  const header = { type: "session", version: 3, id: "recoverable", timestamp: new Date().toISOString(), cwd: root };
  const entry = {
    type: "message",
    id: "entry0001",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: message("assistant", "ok"),
  };
  await writeFile(path, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n{"type":"message"`, "utf8");

  const loaded = loadEntriesFromFile(path);
  assert.deepEqual(loaded.map((item) => item.type), ["session", "message"]);
  const manager = SessionManager.open(path);
  assert.equal(manager.getSessionId(), "recoverable");
  assert.equal(manager.getLeafId(), "entry0001");
  const appended = manager.appendMessage(message("user", "after recovery"));
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.doesNotThrow(() => lines.map((line) => JSON.parse(line)));
  assert.equal(loadEntriesFromFile(path).at(-1)?.type, "message");
  assert.equal(manager.getEntry(appended)?.parentId, "entry0001");
});

test("a valid final record missing only its newline is preserved before append", async () => {
  const root = await temporaryRoot();
  const path = join(root, "missing-newline.jsonl");
  const timestamp = new Date().toISOString();
  const header = { type: "session", version: 3, id: "missing-newline", timestamp, cwd: root };
  const entry = {
    type: "message",
    id: "entry0001",
    parentId: null,
    timestamp,
    message: message("assistant", "complete"),
  };
  await writeFile(path, `${JSON.stringify(header)}\n${JSON.stringify(entry)}`, "utf8");

  SessionManager.open(path).appendMessage(message("user", "after recovery"));

  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.doesNotThrow(() => lines.map((line) => JSON.parse(line)));
});

test("a malformed complete record reports its line and never mutates the file", async () => {
  const root = await temporaryRoot();
  const path = join(root, "corrupt.jsonl");
  const header = { type: "session", version: 3, id: "corrupt", timestamp: new Date().toISOString(), cwd: root };
  const original = Buffer.from(`\n${JSON.stringify(header)}\n{broken\n`);
  await writeFile(path, original);

  assert.throws(() => loadEntriesFromFile(path), /malformed JSON at line 3/u);
  assert.throws(() => SessionManager.open(path), /malformed JSON at line 3/u);
  assert.deepEqual(await readFile(path), original);
});

test("a nonempty invalid file is rejected byte-for-byte without repair", async () => {
  const root = await temporaryRoot();
  const path = join(root, "invalid.jsonl");
  const original = Buffer.from('{"type":"message","id":"x"}\n');
  await writeFile(path, original);

  assert.throws(() => SessionManager.open(path), /not a valid rigyn session/u);
  assert.deepEqual(await readFile(path), original);
});

test("an explicitly selected empty file is initialized immediately", async () => {
  const root = await temporaryRoot();
  const path = join(root, "empty.jsonl");
  await writeFile(path, "");
  const manager = SessionManager.open(path);

  assert.equal(manager.getSessionFile(), path);
  assert.equal(statSync(path).size > 0, true);
  assert.deepEqual(jsonLines(path).map((entry) => entry.type), ["session"]);
  manager.appendMessage(message("user", "stored before assistant because the explicit file exists"));
  assert.deepEqual(jsonLines(path).map((entry) => entry.type), ["session", "message"]);
});

test("opening a nonexistent explicit path preserves it until an assistant arrives", async () => {
  const root = await temporaryRoot();
  const path = join(root, "chosen.jsonl");
  const manager = SessionManager.open(path, root, root);
  manager.appendMessage(message("user", "queued"));
  assert.equal(existsSync(path), false);
  manager.appendMessage(message("assistant", "written"));
  assert.equal(existsSync(path), true);
  assert.equal(manager.getSessionFile(), path);
});

test("legacy entries migrate to the current append-only tree format", () => {
  const timestamp = new Date().toISOString();
  const entries = [
    { type: "session", id: "legacy", timestamp, cwd: "/tmp" },
    { type: "message", timestamp, message: message("user", "one") },
    { type: "message", timestamp, message: { role: "hookMessage", content: "two" } },
    { type: "compaction", timestamp, summary: "sum", firstKeptEntryIndex: 1, tokensBefore: 10 },
  ] as unknown as FileEntry[];

  migrateSessionEntries(entries);
  const header = entries[0];
  assert.equal(header?.type === "session" ? header.version : undefined, 3);
  const migrated = entries.slice(1) as SessionEntry[];
  assert.equal(migrated.every((entry) => typeof entry.id === "string"), true);
  assert.equal(migrated[0]?.parentId, null);
  assert.equal(migrated[1]?.parentId, migrated[0]?.id);
  assert.equal(migrated[2]?.parentId, migrated[1]?.id);
  assert.equal((migrated[1] as { message: { role: string } }).message.role, "custom");
  assert.equal(migrated[2]?.type === "compaction" ? migrated[2].firstKeptEntryId : undefined, migrated[0]?.id);
});

test("opening a legacy file rewrites only the migration and then appends", async () => {
  const root = await temporaryRoot();
  const path = join(root, "legacy.jsonl");
  const timestamp = new Date().toISOString();
  await writeFile(path, [
    JSON.stringify({ type: "session", id: "legacy", timestamp, cwd: root }),
    JSON.stringify({ type: "message", timestamp, message: message("assistant", "old") }),
    "",
  ].join("\n"));
  const manager = SessionManager.open(path);
  assert.equal(manager.getHeader()?.version, 3);
  const migratedHeader = jsonLines(path)[0];
  assert.equal(migratedHeader?.type === "session" ? migratedHeader.version : undefined, 3);
  manager.appendMessage(message("user", "new"));
  assert.equal(jsonLines(path).length, 3);
});

test("recent-session continuation scans JSONL files and respects custom-directory cwd", async () => {
  const root = await temporaryRoot();
  const sessions = join(root, "shared");
  const workspaceA = join(root, "a");
  const workspaceB = join(root, "b");
  const first = SessionManager.create(workspaceA, sessions, { id: "first" });
  first.appendMessage(message("assistant", "A", { timestamp: 1_700_000_100_000 }));
  const firstFile = first.getSessionFile()!;
  const second = SessionManager.create(workspaceB, sessions, { id: "second" });
  second.appendMessage(message("assistant", "B", { timestamp: 1_700_000_200_000 }));
  const secondFile = second.getSessionFile()!;
  const now = new Date();
  await utimes(firstFile, new Date(now.getTime() - 5_000), new Date(now.getTime() - 5_000));
  await utimes(secondFile, now, now);

  assert.equal(SessionManager.continueRecent(workspaceA, sessions).getSessionId(), "first");
  assert.equal(SessionManager.continueRecent(workspaceB, sessions).getSessionId(), "second");
  assert.deepEqual((await SessionManager.list(workspaceA, sessions)).map((item) => item.id), ["first"]);
  assert.deepEqual((await SessionManager.listAll(sessions)).map((item) => item.id), ["second", "first"]);
});

test("listing derives names, message text, counts, lineage, and activity time", async () => {
  const root = await temporaryRoot();
  const sessions = join(root, "sessions");
  const manager = SessionManager.create(root, sessions, { id: "listed", parentSession: "/parent.jsonl" });
  manager.appendMessage(message("user", "first prompt", { timestamp: 1_700_000_100_000 }));
  manager.appendMessage(message("assistant", "answer", { timestamp: 1_700_000_200_000 }));
  manager.appendSessionInfo("Named session");

  const [info] = await SessionManager.list(root, sessions);
  assert.equal(info?.id, "listed");
  assert.equal(info?.name, "Named session");
  assert.equal(info?.parentSessionPath, "/parent.jsonl");
  assert.equal(info?.messageCount, 2);
  assert.equal(info?.firstMessage, "first prompt");
  assert.equal(info?.allMessagesText, "first prompt answer");
  assert.equal(info?.modified.getTime(), 1_700_000_200_000);
});

test("forkFrom creates an immediately durable copy with new identity and cwd", async () => {
  const root = await temporaryRoot();
  const sourceDir = join(root, "source-sessions");
  const source = SessionManager.create(join(root, "source"), sourceDir, { id: "source" });
  source.appendMessage(message("assistant", "history"));
  const sourcePath = source.getSessionFile()!;
  const targetCwd = join(root, "target");
  const target = SessionManager.forkFrom(sourcePath, targetCwd, join(root, "target-sessions"), { id: "forked" });

  assert.equal(target.getSessionId(), "forked");
  assert.equal(target.getHeader()?.parentSession, sourcePath);
  assert.equal(target.getHeader()?.cwd, resolve(targetCwd));
  assert.equal(existsSync(target.getSessionFile()!), true);
  assert.equal(target.getEntries().length, source.getEntries().length);
});

test("createBranchedSession extracts one path, rechains labels, and records lineage", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.create(root, join(root, "sessions"), { id: "original" });
  const user = manager.appendMessage(message("user", "question"));
  manager.appendLabelChange(user, "start");
  const reply = manager.appendMessage(message("assistant", "answer"));
  const abandoned = manager.appendMessage(message("user", "not copied"));
  const originalFile = manager.getSessionFile()!;

  const branchedFile = manager.createBranchedSession(reply)!;
  assert.notEqual(branchedFile, originalFile);
  assert.equal(existsSync(branchedFile), true);
  assert.equal(manager.getHeader()?.parentSession, originalFile);
  assert.equal(manager.getEntries().some((entry) => entry.id === abandoned), false);
  assert.equal(manager.getLabel(user), "start");
  const branch = manager.getBranch();
  assert.equal(branch.every((entry, index) => entry.parentId === (index === 0 ? null : branch[index - 1]?.id)), true);
});

test("a branch extracted before any assistant remains lazy", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.create(root, join(root, "sessions"));
  const user = manager.appendMessage(message("user", "question"));
  const branchFile = manager.createBranchedSession(user)!;
  assert.equal(existsSync(branchFile), false);
  manager.appendMessage(message("assistant", "answer"));
  assert.equal(existsSync(branchFile), true);
});

test("custom identifiers are validated at all new-session factories", async () => {
  const root = await temporaryRoot();
  for (const invalid of ["", "-bad", "bad-", "space id", "slash/id"]) {
    assert.throws(() => SessionManager.inMemory(root, { id: invalid }), /Session id/u);
  }
  assert.equal(SessionManager.inMemory(root, { id: "Good.id_2-x" }).getSessionId(), "Good.id_2-x");
  assert.throws(() => SessionManager.create(root, join(root, "sessions"), { id: "bad/one" }), /Session id/u);
});

test("open uses header cwd unless an override is supplied", async () => {
  const root = await temporaryRoot();
  const recorded = join(root, "recorded");
  const manager = SessionManager.create(recorded, join(root, "sessions"), { id: "cwd" });
  manager.appendMessage(message("assistant", "saved"));
  const path = manager.getSessionFile()!;

  assert.equal(SessionManager.open(path).getCwd(), resolve(recorded));
  const override = join(root, "override");
  assert.equal(SessionManager.open(path, undefined, override).getCwd(), resolve(override));
});

test("tree construction tolerates orphans and self-parented entries", async () => {
  const root = await temporaryRoot();
  const path = join(root, "odd.jsonl");
  const timestamp = new Date().toISOString();
  const header = { type: "session", version: 3, id: "odd", timestamp, cwd: root };
  const orphan = { type: "custom", id: "orphan", parentId: "missing", timestamp, customType: "x" };
  const self = { type: "custom", id: "self", parentId: "self", timestamp, customType: "x" };
  await writeFile(path, `${JSON.stringify(header)}\n${JSON.stringify(orphan)}\n${JSON.stringify(self)}\n`);
  const tree = SessionManager.open(path).getTree();
  assert.deepEqual(tree.map((node) => node.entry.id), ["orphan", "self"]);
});

test("standalone context helpers match manager traversal", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(message("user", "a"));
  manager.appendMessage(message("assistant", "b"));
  const entries = manager.getEntries();
  assert.deepEqual(buildContextEntries(entries), manager.buildContextEntries());
  assert.deepEqual(buildSessionContext(entries), manager.buildSessionContext());
});

test("setting a new session file switches the active tree", async () => {
  const root = await temporaryRoot();
  const sessions = join(root, "sessions");
  const first = SessionManager.create(root, sessions, { id: "one" });
  first.appendMessage(message("assistant", "one"));
  const second = SessionManager.create(root, sessions, { id: "two" });
  second.appendMessage(message("assistant", "two"));

  first.setSessionFile(second.getSessionFile()!);
  assert.equal(first.getSessionId(), "two");
  assert.equal((first.getLeafEntry() as { message?: CanonicalMessage }).message?.content[0]?.type, "text");
});

test("exclusive lazy creation refuses to overwrite a raced target", async () => {
  const root = await temporaryRoot();
  const path = join(root, "race.jsonl");
  const manager = SessionManager.open(path, root, root);
  manager.appendMessage(message("user", "pending"));
  writeFileSync(path, "external\n");
  assert.throws(() => manager.appendMessage(message("assistant", "answer")), /EEXIST/u);
  assert.equal(readFileSync(path, "utf8"), "external\n");
});
