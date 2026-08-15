import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { readSessionV4FileSync, type SessionV4State } from "@rigyn/kernel/session-v4";
import type { CanonicalMessage } from "../../src/core/types.js";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  buildContextEntries,
  buildSessionContext,
  findMostRecentSession,
  getDefaultSessionDir,
  type SessionContextMessage,
} from "../../src/storage/index.js";

const sessionManagerModule = new URL("../../src/storage/session-manager.ts", import.meta.url).href;

const roots = new Set<string>();
let messageSequence = 0;

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rigyn-session-v4-"));
  roots.add(root);
  return root;
}

test.afterEach(async () => {
  await Promise.all([...roots].map(async (root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

function message(
  role: CanonicalMessage["role"],
  text: string,
  options: { provider?: string; model?: string; timestamp?: number } = {},
): CanonicalMessage & { timestamp?: number } {
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

function contextText(entry: SessionContextMessage): string {
  if (entry.role === "compactionSummary" || entry.role === "branchSummary") return entry.summary;
  if (entry.role === "bashExecution") return entry.output;
  if (typeof entry.content === "string") return entry.content;
  return entry.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
}

test("persistent session directories, journals, and writer locks stay private under permissive umasks", {
  skip: process.platform === "win32" ? "POSIX permission bits do not apply on Windows" : false,
}, () => {
  const source = [
    `import { SessionManager } from ${JSON.stringify(sessionManagerModule)};`,
    'import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { dirname, join } from "node:path";',
    "process.umask(Number.parseInt(process.argv[1], 8));",
    'const root = mkdtempSync(join(tmpdir(), "rigyn-session-manager-permissions-"));',
    "const mode = (path) => statSync(path).mode & 0o777;",
    "const lockModes = (file) => {",
    "  const pathLock = `${file}.writer-lock`;",
    '  const identityRoot = join(process.env.RIGYN_HOME, "writer-locks");',
    '  const identityName = readdirSync(identityRoot).find((name) => name.endsWith(".writer-lock"));',
    '  if (identityName === undefined) throw new Error("identity writer lock was not created");',
    "  const identityLock = join(identityRoot, identityName);",
    "  return {",
    "    agentRoot: mode(process.env.RIGYN_HOME),",
    "    pathDirectory: mode(pathLock),",
    '    pathOwner: mode(join(pathLock, "owner.json")),',
    "    identityRoot: mode(identityRoot),",
    "    identityDirectory: mode(identityLock),",
    '    identityOwner: mode(join(identityLock, "owner.json")),',
    "  };",
    "};",
    "try {",
    '  process.env.RIGYN_HOME = join(root, "agent");',
    '  const identityRoot = join(process.env.RIGYN_HOME, "writer-locks");',
    "  mkdirSync(identityRoot, { recursive: true, mode: 0o777 });",
    "  chmodSync(identityRoot, 0o777);",
    '  const workspace = join(root, "workspace");',
    "  mkdirSync(workspace);",
    '  process.env.RIGYN_HOME = join(root, "listing-agent");',
    "  mkdirSync(process.env.RIGYN_HOME, { mode: 0o777 });",
    "  await SessionManager.list(workspace);",
    "  const listingModes = {",
    "    agentRoot: mode(process.env.RIGYN_HOME),",
    '    sessionsRoot: mode(join(process.env.RIGYN_HOME, "sessions")),',
    "  };",
    '  process.env.RIGYN_HOME = join(root, "agent");',
    '  const customDirectory = join(root, "custom", "sessions");',
    "  mkdirSync(customDirectory, { recursive: true, mode: 0o777 });",
    "  chmodSync(customDirectory, 0o777);",
    '  const custom = SessionManager.create(workspace, customDirectory, { id: "custom" });',
    "  const customFile = custom.getSessionFile();",
    '  const first = custom.appendMessage({ id: "message", role: "user", content: [{ type: "text", text: "private" }], createdAt: new Date().toISOString() });',
    '  custom.appendCompaction("summary", first, 1);',
    '  custom.appendSessionInfo("metadata rename");',
    "  const customModes = { directory: mode(customDirectory), file: mode(customFile), ...lockModes(customFile) };",
    "  custom.closeV4Store();",
    "  chmodSync(customFile, 0o666);",
    "  const reopened = SessionManager.open(customFile, customDirectory, workspace);",
    "  const reopenedModes = { directory: mode(customDirectory), file: mode(customFile), ...lockModes(customFile) };",
    '  reopened.appendSessionInfo("renamed again");',
    "  reopened.closeV4Store();",
    '  const defaults = SessionManager.create(workspace, undefined, { id: "default" });',
    "  const defaultFile = defaults.getSessionFile();",
    "  const defaultModes = {",
    '    sessionsRoot: mode(join(process.env.RIGYN_HOME, "sessions")),',
    "    directory: mode(dirname(defaultFile)),",
    "    file: mode(defaultFile),",
    "    ...lockModes(defaultFile),",
    "  };",
    "  defaults.closeV4Store();",
    "  process.stdout.write(JSON.stringify({ listingModes, customModes, reopenedModes, defaultModes }));",
    "} finally {",
    "  rmSync(root, { recursive: true, force: true });",
    "}",
  ].join("\n");
  const expected = {
    agentRoot: 0o700,
    directory: 0o700,
    file: 0o600,
    pathDirectory: 0o700,
    pathOwner: 0o600,
    identityRoot: 0o700,
    identityDirectory: 0o700,
    identityOwner: 0o600,
  };

  for (const mask of ["000", "022"]) {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source, mask],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, `${child.stdout}${child.stderr}`);
    assert.deepEqual(JSON.parse(child.stdout), {
      listingModes: { agentRoot: 0o700, sessionsRoot: 0o700 },
      customModes: expected,
      reopenedModes: expected,
      defaultModes: { sessionsRoot: 0o700, ...expected },
    });
  }
});

test("persistent sessions materialize one exact version-four header immediately", async () => {
  const root = await temporaryRoot();
  const cwd = join(root, "workspace");
  const manager = SessionManager.create(cwd, join(root, "sessions"), { id: "session.one" });
  const file = manager.getSessionFile()!;

  assert.equal(existsSync(file), true);
  assert.match(basename(file), /_session\.one\.jsonl$/u);
  assert.deepEqual(manager.getHeader(), {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: "session.one",
    timestamp: manager.getHeader().timestamp,
    cwd: resolve(cwd),
  });
  const lines = readFileSync(file, "utf8").split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[1], "");
  assert.deepEqual(JSON.parse(lines[0]!), {
    record: "session",
    version: 4,
    sessionId: "session.one",
    createdAt: manager.getHeader().timestamp,
    workspace: resolve(cwd),
    cwd: resolve(cwd),
  });
  assert.equal(readSessionV4FileSync(file).state.sequence, 0);
});

test("failed fresh-session preparation leaves the current writer active", async () => {
  const root = await temporaryRoot();
  const sessions = join(root, "sessions");
  const manager = SessionManager.create(root, sessions, { id: "current" });
  const currentFile = manager.getSessionFile()!;
  manager.appendMessage(message("user", "before failure"));
  const blockedDirectory = join(root, "not-a-directory");
  writeFileSync(blockedDirectory, "blocked");
  (manager as unknown as { sessionDir: string }).sessionDir = blockedDirectory;

  assert.throws(() => manager.newSession({ id: "replacement" }));
  assert.equal(manager.getSessionId(), "current");
  assert.equal(manager.getSessionFile(), currentFile);
  manager.appendMessage(message("assistant", "after failure"));
  assert.deepEqual(manager.buildSessionContext().messages.map(contextText), ["before failure", "after failure"]);
  assert.equal(readSessionV4FileSync(currentFile).state.sequence, 2);
});

test("conversation entries project from v4 nodes and survive reopening", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.create(root, join(root, "sessions"), { id: "conversation" });
  const system = manager.appendMessage(message("system", "instructions"));
  const user = manager.appendMessage(message("user", "hello"));
  manager.appendThinkingLevelChange("max");
  manager.appendModelChange("openai", "gpt-test");
  const assistant = manager.appendMessage(message("assistant", "hi", { provider: "openai", model: "gpt-test" }));
  manager.appendCustomEntry("memory", { enabled: true });
  manager.appendCustomMessageEntry("notice", "visible context", true, { source: "test" });

  manager.closeV4Store();
  const reopened = SessionManager.open(manager.getSessionFile()!);
  assert.deepEqual(
    reopened.getEntries().map((entry) => entry.type),
    ["message", "message", "thinking_level_change", "model_change", "message", "custom", "custom_message"],
  );
  assert.deepEqual(reopened.getBranch(assistant).map((entry) => entry.id), [
    system,
    user,
    reopened.getEntries()[2]?.id,
    reopened.getEntries()[3]?.id,
    assistant,
  ]);
  assert.deepEqual(reopened.buildSessionContext().model, { provider: "openai", modelId: "gpt-test" });
  assert.equal(reopened.buildSessionContext().thinkingLevel, "max");
  assert.deepEqual(
    reopened.buildSessionContext().messages.map(contextText),
    ["instructions", "hello", "hi", "visible context"],
  );
});

test("head navigation is durable and appends branches without rewriting nodes", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.create(root, join(root, "sessions"), { id: "branches" });
  const rootId = manager.appendMessage(message("user", "root"));
  const first = manager.appendMessage(message("assistant", "first"));
  manager.branch(rootId);
  const second = manager.appendMessage(message("assistant", "second"));

  assert.deepEqual(manager.getBranch(first).map((entry) => entry.id), [rootId, first]);
  assert.deepEqual(manager.getBranch(second).map((entry) => entry.id), [rootId, second]);
  assert.deepEqual(manager.getChildren(rootId).map((entry) => entry.id), [first, second]);

  manager.closeV4Store();
  const reopened = SessionManager.open(manager.getSessionFile()!);
  assert.equal(reopened.getLeafId(), second);
  reopened.branch(first);
  reopened.closeV4Store();
  const verifiedBranch = SessionManager.open(manager.getSessionFile()!);
  assert.equal(verifiedBranch.getLeafId(), first);
  verifiedBranch.closeV4Store();
  const reset = SessionManager.open(manager.getSessionFile()!);
  reset.resetLeaf();
  reset.closeV4Store();
  assert.equal(SessionManager.open(manager.getSessionFile()!).getLeafId(), null);
});

test("bounded branch queries support traversal bounds, filters, and active-leaf defaults", async () => {
  const workspace = await temporaryRoot();
  const manager = SessionManager.create(workspace, join(workspace, "sessions"), { id: "branch-queries" });
  const root = manager.appendMessage(message("user", "root"));
  const custom = manager.appendCustomEntry("note", { value: 1 });
  const child = manager.appendMessage(message("assistant", "child"));
  const compaction = manager.appendCompaction("summary", child, 100);
  const recentCustom = manager.appendCustomEntry("note", { value: 2 });
  const tail = manager.appendMessage(message("user", "tail"));
  manager.branch(root);
  const sibling = manager.appendMessage(message("user", "sibling"));

  assert.deepEqual(manager.findEntriesOnBranch().map((entry) => entry.id), [sibling, root]);
  assert.deepEqual(manager.findEntriesOnBranch({ start: null }), []);
  assert.deepEqual(
    manager.findEntriesOnBranch({ start: tail, order: "oldestFirst" }).map((entry) => entry.id),
    [root, custom, child, compaction, recentCustom, tail],
  );
  assert.deepEqual(
    manager.findEntriesOnBranch({ start: tail, stopAtType: "compaction" }).map((entry) => entry.id),
    [tail, recentCustom, compaction],
  );
  assert.deepEqual(
    manager.findEntriesOnBranch({
      start: tail,
      stopAtType: "compaction",
      type: "message",
    }).map((entry) => entry.id),
    [tail],
  );
  assert.deepEqual(
    manager.findEntriesOnBranch({
      start: tail,
      stopAtId: child,
      order: "oldestFirst",
    }).map((entry) => entry.id),
    [root, custom, child],
  );
  assert.deepEqual(
    manager.findEntriesOnBranch({ start: tail, stopAtType: "custom" }).map((entry) => entry.id),
    [tail, recentCustom],
  );
  assert.deepEqual(
    manager.findEntriesOnBranch({
      start: tail,
      stopAtType: "custom",
      order: "oldestFirst",
    }).map((entry) => entry.id),
    [root, custom],
  );
  assert.deepEqual(
    manager.findEntriesOnBranch({
      start: tail,
      type: "message",
      order: "oldestFirst",
    }).map((entry) => entry.id),
    [root, child, tail],
  );
  assert.deepEqual(
    manager.findEntriesOnBranch({ start: tail, customType: "note" }).map((entry) => entry.id),
    [recentCustom, custom],
  );
  assert.deepEqual(manager.findEntriesOnBranch({ start: tail, limit: 1 }).map((entry) => entry.id), [tail]);
  assert.deepEqual(
    manager.findEntriesOnBranch({
      start: tail,
      type: "message",
      order: "oldestFirst",
      limit: 1,
    }).map((entry) => entry.id),
    [root],
  );
  assert.equal(manager.findEntryOnBranch({ start: tail, type: "compaction" })?.id, compaction);
  assert.throws(() => manager.findEntriesOnBranch({ start: "missing" }), /Entry missing not found/u);
  assert.throws(() => manager.findEntriesOnBranch({ limit: 0 }), /positive integer/u);
  assert.throws(() => manager.findEntriesOnBranch({ limit: 1.5 }), /positive integer/u);

  const queried = manager.findEntriesOnBranch({ start: tail, customType: "note", limit: 1 });
  (queried[0] as { data?: { value: number } }).data!.value = 99;
  const stored = manager.getEntry(recentCustom);
  assert.deepEqual(stored?.type === "custom" ? stored.data : undefined, { value: 2 });
  assert.deepEqual(manager.getBranch(tail).map((entry) => entry.id), [
    root,
    custom,
    child,
    compaction,
    recentCustom,
    tail,
  ]);
  assert.deepEqual(manager.getBranch("missing"), []);

  const file = manager.getSessionFile()!;
  manager.closeV4Store();
  const reopened = SessionManager.open(file);
  assert.deepEqual(
    reopened.findEntriesOnBranch({ start: tail, order: "oldestFirst" }).map((entry) => entry.id),
    [root, custom, child, compaction, recentCustom, tail],
  );
  reopened.closeV4Store();
});

test("active-branch usage includes summaries without cloning the conversation branch", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.inMemory(root, { id: "active-usage" });
  const common = manager.appendMessage({
    ...message("assistant", "common"),
    stopReason: "stop",
    usage: { inputTokens: 100, cacheReadTokens: 100, outputTokens: 10 },
  });
  manager.appendMessage({
    ...message("assistant", "abandoned"),
    stopReason: "stop",
    usage: { inputTokens: 900, outputTokens: 10 },
  });
  manager.branch(common);
  const active = manager.appendMessage({
    ...message("assistant", "active"),
    stopReason: "stop",
    usage: { inputTokens: 40, cacheReadTokens: 160, cacheWriteTokens: 0, outputTokens: 20 },
  });
  manager.appendMessage({
    ...message("tool", ""),
    content: [{
      type: "tool_result",
      callId: "usage-one",
      name: "read",
      content: "one",
      isError: false,
    }, {
      type: "tool_result",
      callId: "usage-two",
      name: "read",
      content: "two",
      isError: false,
    }],
    usage: { inputTokens: 20, outputTokens: 5 },
  });
  manager.appendCompaction("summary", active, 1_000, undefined, false, {
    inputTokens: 30,
    outputTokens: 10,
  });
  Object.defineProperty(manager, "getBranch", {
    value: () => { throw new Error("active usage must not clone the branch"); },
  });

  assert.deepEqual(manager.getActiveBranchUsage(), {
    usage: {
      inputTokens: 190,
      outputTokens: 45,
    },
    reportedUsage: {
      inputTokens: 190,
      outputTokens: 45,
      cacheReadTokens: 260,
      cacheWriteTokens: 0,
      totalTokens: 495,
    },
    hasUsageObservations: true,
    latestAssistantUsage: {
      inputTokens: 40,
      outputTokens: 20,
      cacheReadTokens: 160,
      cacheWriteTokens: 0,
    },
  });
});

test("active-branch usage distinguishes an empty branch from missing request telemetry", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.inMemory(root, { id: "active-usage-empty" });

  assert.deepEqual(manager.getActiveBranchUsage(), {
    usage: {},
    hasUsageObservations: false,
  });
});

test("active-branch usage treats a successful assistant without telemetry as an observation", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.inMemory(root, { id: "active-usage-omitted" });
  manager.appendMessage({
    ...message("assistant", "reported"),
    stopReason: "stop",
    usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
  });
  manager.appendMessage({
    ...message("assistant", "omitted"),
    stopReason: "stop",
  });

  assert.deepEqual(manager.getActiveBranchUsage(), {
    usage: {},
    reportedUsage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    hasUsageObservations: true,
  });
});

test("active-branch usage retains a fuller reported prompt lower bound when cache telemetry is incomplete", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.inMemory(root, { id: "active-usage-partial-cache" });
  manager.appendMessage({
    ...message("assistant", "complete cache telemetry"),
    stopReason: "stop",
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0 },
  });
  manager.appendMessage({
    ...message("assistant", "missing cache telemetry"),
    stopReason: "stop",
    usage: { inputTokens: 100, outputTokens: 10 },
  });

  assert.deepEqual(manager.getActiveBranchUsage(), {
    usage: { inputTokens: 200, outputTokens: 20 },
    reportedUsage: {
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
      totalTokens: 270,
    },
    hasUsageObservations: true,
    latestAssistantUsage: { inputTokens: 100, outputTokens: 10 },
  });
});

test("active-branch usage retains reported cache fields when total minus output stays exact", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.inMemory(root, { id: "active-usage-derived-prompt" });
  manager.appendMessage({
    ...message("assistant", "reported cache"),
    stopReason: "stop",
    usage: { outputTokens: 10, totalTokens: 100, cacheReadTokens: 80 },
  });
  manager.appendMessage({
    ...message("assistant", "omitted cache"),
    stopReason: "stop",
    usage: { outputTokens: 10, totalTokens: 100 },
  });

  assert.deepEqual(manager.getActiveBranchUsage(), {
    usage: { outputTokens: 20, totalTokens: 200 },
    reportedUsage: { outputTokens: 20, totalTokens: 200, cacheReadTokens: 80 },
    hasUsageObservations: true,
    latestAssistantUsage: { outputTokens: 10, totalTokens: 100 },
  });
});

test("active-branch usage ignores unmetered failures and hook summaries", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.inMemory(root, { id: "active-usage-unmetered" });
  const reported = manager.appendMessage({
    ...message("assistant", "reported"),
    stopReason: "stop",
    usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
  });
  manager.appendMessage({ ...message("assistant", "cancelled"), stopReason: "cancelled" });
  manager.appendCompaction("hook summary", reported, 25, undefined, true);

  assert.deepEqual(manager.getActiveBranchUsage(), {
    usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    hasUsageObservations: true,
    latestAssistantUsage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
  });
});

test("names and labels are state changes instead of tree pseudo-entries", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.create(root, join(root, "sessions"), { id: "metadata" });
  const entry = manager.appendMessage(message("user", "hello"));
  const count = manager.getEntryCount();

  manager.appendSessionInfo("  My\nSession  ");
  manager.appendLabelChange(entry, " checkpoint ");
  assert.equal(manager.getEntryCount(), count);
  assert.deepEqual(manager.getEntries().map((value) => value.type), ["message"]);
  assert.equal(manager.getSessionName(), "My Session");
  assert.equal(manager.getLabel(entry), "checkpoint");
  assert.equal(manager.getTree()[0]?.label, "checkpoint");

  manager.appendLabelChange(entry, "");
  manager.closeV4Store();
  const reopened = SessionManager.open(manager.getSessionFile()!);
  assert.equal(reopened.getSessionName(), "My Session");
  assert.equal(reopened.getLabel(entry), undefined);
});

test("paged session views share stable entry order and project tree and context data", () => {
  const manager = SessionManager.inMemory("/tmp", { id: "pages" });
  const root = manager.appendMessage(message("user", "root"));
  const child = manager.appendMessage(message("assistant", "child"));
  manager.appendLabelChange(child, "reviewed");

  assert.equal(manager.getEntrySequence(root), 0);
  assert.equal(manager.getEntrySequence(child), 1);
  assert.equal(manager.getEntrySequence("missing"), undefined);
  assert.deepEqual(manager.getEntriesPage(-1, 1), []);
  assert.deepEqual(manager.getEntriesPage(0, 0), []);
  assert.deepEqual(manager.getEntriesPage(0, 1).map((entry) => entry.id), [root]);

  const leaf = manager.appendMessage(message("user", "leaf"));
  assert.deepEqual(manager.getEntriesPage(0, 10).map((entry) => entry.id), [root, child, leaf]);

  const flat = manager.getTreeEntryPage(0, 10);
  assert.deepEqual(flat.map((entry) => entry.entry.id), [root, child, leaf]);
  assert.equal(flat[1]?.label, "reviewed");
  assert.match(flat[1]?.labelTimestamp ?? "", /^\d{4}-\d{2}-\d{2}T/u);
  assert.ok(flat.every((entry) => entry.children.length === 0));
  assert.deepEqual(flat.map((entry) => entry.depth), [0, 1, 2]);

  const tree = manager.getTreePage(0, 10);
  assert.deepEqual(tree.map((entry) => entry.entry.id), [root]);
  assert.deepEqual(tree[0]?.children.map((entry) => entry.entry.id), [child]);
  assert.deepEqual(tree[0]?.children[0]?.children.map((entry) => entry.entry.id), [leaf]);
  const pagedTree = manager.getTreePage(1, 2);
  assert.equal(pagedTree[0]?.entry.id, child);
  assert.equal(pagedTree[0]?.depth, 1);
  assert.equal(pagedTree[0]?.children[0]?.depth, 2);
  assert.deepEqual(manager.getActiveBranchEntryIdsInPage(0, 2), [root, child]);
  assert.deepEqual(manager.getActiveBranchEntryIdsInPage(1, 2), [child, leaf]);
  assert.deepEqual(manager.getActiveBranchEntryIdsInPage(-1, 2), []);

  assert.deepEqual(manager.getContextMessagePage(-1, 1), {
    messages: [],
    totalMessages: 3,
  });
  assert.deepEqual(manager.getContextMessagePage(1, 1).messages.map(contextText), ["child"]);
});

test("tree projections scan label commits once instead of once per node", () => {
  const manager = SessionManager.inMemory("/tmp", { id: "tree-label-index" });
  for (let index = 0; index < 12; index += 1) {
    const id = manager.appendMessage(message("user", `node ${index}`));
    if (index % 3 === 0) manager.appendLabelChange(id, `label ${index}`);
  }
  const internal = manager as unknown as { memoryState: SessionV4State };
  const commits = internal.memoryState.commits;
  const originalValues = commits.values.bind(commits);
  let scans = 0;
  commits.values = () => {
    scans += 1;
    return originalValues();
  };

  manager.getTree();
  assert.equal(scans, 1);
  scans = 0;
  manager.getTreeEntryPage(0, 12);
  assert.equal(scans, 1);
});

test("compaction reconstruction keeps selected instructions and retained tail", () => {
  const manager = SessionManager.inMemory("/tmp", { id: "compaction" });
  manager.appendMessage(message("system", "old instructions"));
  manager.appendMessage(message("system", "active instructions"));
  manager.appendMessage(message("user", "old user"));
  manager.appendMessage(message("assistant", "old assistant"));
  const retained = manager.appendMessage(message("user", "retained user"));
  manager.appendMessage(message("assistant", "retained assistant"));
  manager.appendCompaction("summary", retained, 42);
  manager.appendMessage(message("user", "new user"));

  assert.deepEqual(
    manager.buildSessionContext().messages.map(contextText),
    ["old instructions", "active instructions", "summary", "retained user", "retained assistant", "new user"],
  );
  const entries = manager.getEntries();
  assert.deepEqual(buildContextEntries(entries), manager.buildContextEntries());
  assert.deepEqual(buildSessionContext(entries), manager.buildSessionContext());
});

test("custom state stays out of context while custom and branch summaries enter it", () => {
  const manager = SessionManager.inMemory("/tmp", { id: "custom" });
  const root = manager.appendMessage(message("user", "root"));
  manager.appendCustomEntry("state", { hidden: true });
  manager.appendCustomMessageEntry("notice", "custom context", true);
  manager.branchWithSummary(root, "branch context");
  assert.deepEqual(manager.buildSessionContext().messages.map(contextText), ["root", "branch context"]);

  manager.branch(root);
  manager.appendCustomMessageEntry("notice", "custom context", true);
  assert.deepEqual(manager.buildSessionContext().messages.map(contextText), ["root", "custom context"]);
});

test("an unterminated tail is discarded before the next durable commit", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.create(root, join(root, "sessions"), { id: "tail" });
  manager.appendMessage(message("user", "committed"));
  const file = manager.getSessionFile()!;
  manager.closeV4Store();
  appendFileSync(file, JSON.stringify({
    record: "commit",
    sequence: 999,
    commitId: "uncommitted",
    committedAt: new Date().toISOString(),
    changes: [{ type: "head", nodeId: null }],
  }));
  const dirtyBytes = statSync(file).size;

  const reopened = SessionManager.open(file);
  assert.ok(statSync(file).size < dirtyBytes);
  reopened.appendMessage(message("assistant", "continued"));
  assert.equal(readSessionV4FileSync(file).state.sequence, 2);
  assert.deepEqual(reopened.buildSessionContext().messages.map(contextText), ["committed", "continued"]);
});

test("a malformed LF-complete record is rejected without modifying bytes", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.create(root, join(root, "sessions"), { id: "malformed" });
  const file = manager.getSessionFile()!;
  manager.closeV4Store();
  appendFileSync(file, "{broken}\n");
  const before = readFileSync(file);
  assert.throws(() => SessionManager.open(file), /invalid session file/u);
  assert.deepEqual(readFileSync(file), before);
});

test("one session file cannot acquire two product writers", async () => {
  const root = await temporaryRoot();
  const manager = SessionManager.create(root, join(root, "sessions"), { id: "single-writer" });
  assert.throws(() => SessionManager.open(manager.getSessionFile()!), /active writer/u);
  manager.closeV4Store();
  const reopened = SessionManager.open(manager.getSessionFile()!);
  reopened.closeV4Store();
});

test("non-v4 structures fail ordinary strict validation", async () => {
  const root = await temporaryRoot();
  const file = join(root, "invalid.jsonl");
  writeFileSync(file, `${JSON.stringify({
    record: "session",
    version: 5,
    sessionId: "invalid",
    createdAt: new Date().toISOString(),
    workspace: root,
    cwd: root,
  })}\n`);
  assert.throws(() => SessionManager.open(file), /invalid session file/u);
  assert.throws(() => SessionManager.open(file), /header\.version/u);
});

test("listing derives metadata, text, lineage, and current workspace", async () => {
  const root = await temporaryRoot();
  const sessions = join(root, "sessions");
  const first = SessionManager.create(root, sessions, { id: "first" });
  first.appendMessage(message("user", "searchable first", { timestamp: 1_700_000_010_000 }));
  first.appendSessionInfo("Named");
  const child = SessionManager.forkFrom(first.getSessionFile()!, root, sessions, { id: "child" });
  child.appendMessage(message("assistant", "child answer", { timestamp: 1_700_000_020_000 }));

  const listed = await SessionManager.list(root, sessions);
  assert.deepEqual(listed.map((entry) => entry.id), ["child", "first"]);
  assert.equal(listed[0]?.parentSessionPath, "first");
  assert.equal(listed[1]?.name, "Named");
  assert.equal(listed[1]?.firstMessage, "searchable first");
  assert.match(listed[1]?.allMessagesText ?? "", /searchable first/u);
  assert.equal(findMostRecentSession(sessions, root), child.getSessionFile());
});

test("default session buckets isolate canonical workspaces with colliding readable slugs", async () => {
  const root = await temporaryRoot();
  const workspaceA = join(root, "a", "b-c");
  const workspaceB = join(root, "a-b", "c");
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });
  const previousAgentDir = process.env.RIGYN_HOME;
  let first: SessionManager | undefined;
  let continued: SessionManager | undefined;
  try {
    process.env.RIGYN_HOME = join(root, "agent");
    const directoryA = getDefaultSessionDir(workspaceA);
    const directoryB = getDefaultSessionDir(workspaceB);
    const bucketA = basename(directoryA);
    const bucketB = basename(directoryB);
    first = SessionManager.create(workspaceA, undefined, { id: "workspace-a" });
    first.appendMessage(message("user", "workspace A only"));
    const firstFile = first.getSessionFile()!;
    first.closeV4Store();
    first = undefined;
    copyFileSync(firstFile, join(directoryB, "foreign.jsonl"));

    const inspectedFromB = await SessionManager.inspect(workspaceB);
    const listedFromB = await SessionManager.list(workspaceB);
    continued = SessionManager.continueRecent(workspaceB);

    assert.notEqual(directoryA, directoryB);
    assert.match(bucketA, /^--[A-Za-z0-9._-]{1,80}-[a-f0-9]{64}--$/u);
    assert.match(bucketB, /^--[A-Za-z0-9._-]{1,80}-[a-f0-9]{64}--$/u);
    assert.equal(bucketA.slice(0, -66), bucketB.slice(0, -66));
    assert.ok(bucketA.length <= 149);
    assert.ok(bucketB.length <= 149);
    assert.deepEqual(inspectedFromB.sessions, []);
    assert.deepEqual(inspectedFromB.invalid, []);
    assert.deepEqual(listedFromB, []);
    assert.notEqual(continued.getSessionId(), "workspace-a");
    assert.equal(continued.getCwd(), resolve(workspaceB));
    assert.equal(continued.getSessionDir(), directoryB);
    assert.equal(
      readSessionV4FileSync(continued.getSessionFile()!).state.header.cwd,
      resolve(workspaceB),
    );
  } finally {
    first?.closeV4Store();
    continued?.closeV4Store();
    if (previousAgentDir === undefined) delete process.env.RIGYN_HOME;
    else process.env.RIGYN_HOME = previousAgentDir;
  }
});

test("session inspect and list reject special scan entries without blocking", {
  skip: process.platform === "win32" ? "POSIX FIFO and device probe" : false,
}, async () => {
  const root = await temporaryRoot();
  const sessions = join(root, "sessions");
  const ordinary = SessionManager.create(root, sessions, { id: "ordinary" });
  const ordinaryFile = ordinary.getSessionFile()!;
  ordinary.appendMessage(message("user", "ordinary session"));
  ordinary.closeV4Store();

  const fifo = join(sessions, "blocked.jsonl");
  const alias = join(sessions, "alias.jsonl");
  const device = join(sessions, "device.jsonl");
  const directory = join(sessions, "directory.jsonl");
  execFileSync("mkfifo", [fifo]);
  symlinkSync(ordinaryFile, alias, "file");
  symlinkSync("/dev/null", device, "file");
  mkdirSync(directory);

  const source = [
    `import { SessionManager } from ${JSON.stringify(sessionManagerModule)};`,
    "const [cwd, sessions, alias] = process.argv.slice(1);",
    "const inspected = await SessionManager.inspect(cwd, sessions);",
    "const listed = await SessionManager.list(cwd, sessions);",
    "const directAlias = await SessionManager.inspectFile(alias);",
    "let deviceRejected = false;",
    "try { await SessionManager.inspectFile('/dev/null'); } catch { deviceRejected = true; }",
    "process.stdout.write(JSON.stringify({",
    "  inspected: inspected.sessions.map((entry) => entry.id),",
    "  invalid: inspected.invalid.map((entry) => entry.path.split('/').at(-1)).sort(),",
    "  listed: listed.map((entry) => entry.id),",
    "  directAlias: directAlias.id,",
    "  deviceRejected,",
    "}));",
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source, root, sessions, alias],
    { encoding: "utf8", timeout: 2_000 },
  );
  assert.equal(child.error, undefined, String(child.error));
  assert.equal(child.status, 0, `${child.stdout}${child.stderr}`);
  assert.deepEqual(JSON.parse(child.stdout), {
    inspected: ["ordinary"],
    invalid: ["alias.jsonl", "blocked.jsonl", "device.jsonl", "directory.jsonl"],
    listed: ["ordinary"],
    directAlias: "ordinary",
    deviceRejected: true,
  });
});

test("forks and extracted branches use linked child headers and independent stores", async () => {
  const root = await temporaryRoot();
  const sessions = join(root, "sessions");
  const source = SessionManager.create(root, sessions, { id: "source" });
  const prompt = source.appendMessage(message("user", "prompt"));
  const first = source.appendMessage(message("assistant", "first"));
  source.branch(prompt);
  source.appendMessage(message("assistant", "second"));
  source.branch(first);
  source.appendLabelChange(prompt, "start");

  const fork = SessionManager.forkFrom(source.getSessionFile()!, join(root, "target"), sessions, { id: "fork" });
  assert.equal(fork.getHeader().parentSession, "source");
  assert.equal(fork.getCwd(), resolve(join(root, "target")));
  assert.equal(fork.getLabel(prompt), "start");
  assert.deepEqual(fork.getEntries(), source.getEntries());

  const branchFile = source.createBranchedSession(first)!;
  assert.equal(source.getHeader().parentSession, "source");
  assert.deepEqual(source.getEntries().map((entry) => entry.id), [prompt, first]);
  assert.equal(source.getLabel(prompt), "start");
  assert.equal(existsSync(branchFile), true);
});

test("forkFrom removes its new journal and writer lease when copying fails", async () => {
  const root = await temporaryRoot();
  const sessions = join(root, "sessions");
  const source = SessionManager.create(root, sessions, { id: "source" });
  source.appendMessage(message("user", "first"));
  source.appendMessage(message("assistant", "second"));
  const sourceFile = source.getSessionFile()!;
  const preservedFile = join(sessions, "user-owned.jsonl");
  writeFileSync(preservedFile, "preserve this file");

  const prototype = SessionManager.prototype as unknown as {
    commitChanges: (...values: unknown[]) => unknown;
  };
  const originalCommit = prototype.commitChanges;
  let commits = 0;
  prototype.commitChanges = function (...values: unknown[]): unknown {
    commits += 1;
    if (commits === 2) throw new Error("injected fork copy failure");
    return Reflect.apply(originalCommit, this, values);
  };
  try {
    assert.throws(
      () => SessionManager.forkFrom(sourceFile, root, sessions, { id: "failed-fork" }),
      /injected fork copy failure/u,
    );
  } finally {
    prototype.commitChanges = originalCommit;
  }

  assert.deepEqual(
    readdirSync(sessions).filter((name) => name.endsWith(".jsonl")).sort(),
    [basename(sourceFile), basename(preservedFile)].sort(),
  );
  assert.deepEqual(
    readdirSync(sessions).filter((name) => name.endsWith(".writer-lock")),
    [`${basename(sourceFile)}.writer-lock`],
  );
  assert.equal(readFileSync(preservedFile, "utf8"), "preserve this file");
});

test("in-memory clones and append listeners receive detached projections", () => {
  const manager = SessionManager.inMemory("/tmp", { id: "memory" });
  const observed: string[] = [];
  manager.onAppend((entry) => {
    observed.push(entry.id);
    (entry as { parentId: string | null }).parentId = "mutated";
  });
  const id = manager.appendMessage(message("user", "hello"));
  const clone = manager.cloneInMemory();
  clone.appendMessage(message("assistant", "clone only"));

  assert.deepEqual(observed, [id]);
  assert.equal(manager.getEntry(id)?.parentId, null);
  assert.equal(manager.getEntries().length, 1);
  assert.equal(clone.getEntries().length, 2);
});

test("internal v4 hooks expose detached state and pending recovery work", () => {
  const manager = SessionManager.inMemory("/tmp", { id: "recovery" });
  manager.commitChanges([{
    type: "run_accepted",
    branchId: "main",
    operationId: "operation-1",
    promptNodeId: "prompt-node-1",
    sourceHeadId: null,
    acceptedAt: new Date().toISOString(),
    request: { prompt: "prompt" },
    selection: {
      provider: "openai",
      model: "gpt-test",
      api: null,
      thinkingLevel: "high",
      toolNames: [],
      toolsetFingerprint: "none",
    },
  }]);
  manager.commitChanges([{
    type: "queue_added",
    branchId: "main",
    entryId: "queue-1",
    targetNodeId: "queued-node-1",
    kind: "follow_up",
    addedAt: new Date().toISOString(),
    message: { prompt: "next" },
  }]);

  const snapshot = manager.getV4RecoverySnapshot();
  assert.equal(snapshot.openOperation?.id, "operation-1");
  assert.deepEqual(snapshot.queue.map((entry) => entry.id), ["queue-1"]);
  const state = manager.getV4State();
  state.name = "mutated";
  assert.equal(manager.getSessionName(), undefined);
});

test("default directory identity and explicit paths remain deterministic", async () => {
  const root = await temporaryRoot();
  const upper = String.raw`C:\Repo\Workspace`;
  const lower = "c:/repo/workspace";
  assert.equal(getDefaultSessionDir(upper, join(root, "agent")), getDefaultSessionDir(lower, join(root, "agent")));

  const explicit = join(root, "chosen.jsonl");
  const manager = SessionManager.open(explicit, root, root);
  assert.equal(manager.getSessionFile(), explicit);
  assert.equal(existsSync(explicit), true);
  assert.equal(manager.getCwd(), resolve(root));
  manager.closeV4Store();
  assert.equal(SessionManager.open(explicit, undefined, join(root, "override")).getCwd(), resolve(join(root, "override")));
});

test("continueRecent reopens the newest matching durable session", async () => {
  const root = await temporaryRoot();
  const sessions = join(root, "sessions");
  const manager = SessionManager.create(root, sessions, { id: "recent" });
  manager.appendMessage(message("user", "continue me"));
  const file = manager.getSessionFile();
  manager.closeV4Store();

  const continued = SessionManager.continueRecent(root, sessions);
  assert.equal(continued.getSessionFile(), file);
  assert.deepEqual(continued.buildSessionContext().messages.map(contextText), ["continue me"]);
  continued.closeV4Store();
});

test("continueRecent skips a newer journal whose committed tail is invalid", async () => {
  const root = await temporaryRoot();
  const sessions = join(root, "sessions");
  const valid = SessionManager.create(root, sessions, { id: "valid-recent" });
  const validFile = valid.getSessionFile()!;
  valid.closeV4Store();
  const invalid = SessionManager.create(root, sessions, { id: "invalid-recent" });
  const invalidFile = invalid.getSessionFile()!;
  invalid.closeV4Store();
  appendFileSync(invalidFile, "{invalid}\n");

  const continued = SessionManager.continueRecent(root, sessions);
  assert.equal(continued.getSessionId(), "valid-recent");
  assert.equal(continued.getSessionFile(), validFile);
  continued.closeV4Store();
});

test("custom identifiers are checked by every new-session factory", async () => {
  const root = await temporaryRoot();
  for (const invalid of ["", "-bad", "bad-", "bad/path", "bad space", "x".repeat(257)]) {
    assert.throws(() => SessionManager.inMemory(root, { id: invalid }), /Session id/u);
  }
  assert.equal(SessionManager.inMemory(root, { id: "Good.id_2-x" }).getSessionId(), "Good.id_2-x");
});
