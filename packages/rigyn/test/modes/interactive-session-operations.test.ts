import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InteractiveSessionOperations,
  type InteractiveSessionRuntime,
} from "../../src/modes/interactive-session-operations.js";
import type { AgentSession, AgentSessionSuspendedRun } from "../../src/service/agent-session.js";
import { TuiController, TuiSelectionCancelledError } from "../../src/tui/controller.js";
import type { CommandResult, CommandSpec, ProcessRunner } from "../../src/process/types.js";
import type { SessionInfo } from "../../src/storage/types.js";
import { envelope, FakeInput, FakeOutput, tick } from "../tui/helpers.js";
import { FocusedVirtualTerminal } from "../tui/virtual-terminal.js";

function result(stdout = "", stderr = "", exitCode = 0): CommandResult {
  return {
    exitCode,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    timedOut: false,
    cancelled: false,
    durationMs: 1,
  };
}

function treeSession(overrides: Record<string, unknown> = {}): AgentSession {
  const timestamp = "2026-07-20T00:00:00.000Z";
  const entry = (id: string, parentId: string | null, text: string) => ({
    type: "message" as const,
    id,
    parentId,
    timestamp,
    message: {
      id: `message-${id}`,
      role: "user" as const,
      content: [{ type: "text" as const, text }],
      createdAt: timestamp,
    },
  });
  const root = entry("root", null, "Root");
  const leaf = entry("leaf", "root", "Current leaf");
  const target = entry("target", "root", "Alternate branch");
  return {
    sessionManager: {
      getEntryCount: () => 3,
      getTree: () => [{
        entry: root,
        children: [
          { entry: leaf, children: [] },
          { entry: target, children: [] },
        ],
      }],
      getBranch: () => [root, leaf],
      getLeafId: () => "leaf",
    },
    settingsManager: {
      getTreeFilterMode: () => "default",
      getBranchSummarySkipPrompt: () => false,
    },
    isStreaming: false,
    setLabel() {},
    async navigateTree() { return { cancelled: false }; },
    ...overrides,
  } as unknown as AgentSession;
}

function treeRuntime(session: AgentSession): InteractiveSessionRuntime {
  return {
    session,
    cwd: process.cwd(),
    services: { agentDir: process.cwd() },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async importFromJsonl() { return { cancelled: false }; },
  };
}

function catalogSession(id: string): SessionInfo {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: process.cwd(),
    created: new Date("2026-01-01T00:00:00.000Z"),
    modified: new Date("2026-01-01T00:00:00.000Z"),
    messageCount: 1,
    firstMessage: id,
    allMessagesText: id,
  };
}

test("bare /recover safely retries first, then abandons every remaining blocked effect without replay", async () => {
  const calls: Array<{ signal?: AbortSignal; resolutions?: unknown }> = [];
  const notifications: Array<[string, string | undefined]> = [];
  const controller = new AbortController();
  const session = {
    async recoverInterruptedRun(options: { signal?: AbortSignal; resolutions?: unknown } = {}) {
      calls.push(options);
      if (calls.length === 1) {
        return {
          recovered: false as const,
          operationId: "run-restart",
          blocked: [
            { effectId: "effect-bash", name: "bash", reason: "This tool cannot be repeated safely." },
            { effectId: "effect-write", name: "write", reason: "The tool outcome is still uncertain." },
          ],
        };
      }
      return { recovered: true as const, operationId: "run-restart", blocked: [] as const };
    },
  } as unknown as AgentSession;
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal: {
      notify(message: string, kind?: string) { notifications.push([message, kind]); },
    } as unknown as TuiController,
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.recover("", controller.signal);

  assert.deepEqual(calls, [
    { signal: controller.signal },
    {
      signal: controller.signal,
      resolutions: [
        { effectId: "effect-bash", outcome: "abandoned" },
        { effectId: "effect-write", outcome: "abandoned" },
      ],
    },
  ]);
  assert.deepEqual(notifications, [[
    "Recovered interrupted operation run-restart; abandoned 2 blocked tool calls without replay.",
    "status",
  ]]);
});

test("explicit /recover abandon keeps one-effect manual resolution semantics", async () => {
  const calls: unknown[] = [];
  const session = {
    async recoverInterruptedRun(options: unknown) {
      calls.push(options);
      return { recovered: true as const, operationId: "run-explicit", blocked: [] as const };
    },
  } as unknown as AgentSession;
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal: { notify() {} } as unknown as TuiController,
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.recover("abandon effect-one");

  assert.deepEqual(calls, [{ resolutions: [{ effectId: "effect-one", outcome: "abandoned" }] }]);
});

test("/trust rejects the active Rigyn home without saving an inert decision", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-project-trust-collision-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspace = join(root, "home");
  const agentDir = join(workspace, ".rigyn");
  await mkdir(agentDir, { recursive: true });
  let choices = 0;
  const notifications: Array<[string, string | undefined]> = [];
  const operations = new InteractiveSessionOperations({
    runtime: {
      session: {} as AgentSession,
      cwd: workspace,
      services: { agentDir },
      async newSession() { return { cancelled: false }; },
      async switchSession() { return { cancelled: false }; },
      async fork() { return { cancelled: false }; },
      async importFromJsonl() { return { cancelled: false }; },
    },
    terminal: {
      async choose() { choices += 1; return "trust"; },
      notify(message: string, level?: string) { notifications.push([message, level]); },
    } as unknown as TuiController,
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.saveProjectTrust();

  assert.equal(choices, 0);
  assert.deepEqual(notifications, [[
    "Project trust is unavailable because this workspace's .rigyn directory is the active Rigyn home.",
    "warning",
  ]]);
  await assert.rejects(access(join(agentDir, "trusted-workspaces.json")), /ENOENT/u);
});

test("interactive session catalog ignores stale scope results and failures", async () => {
  for (const staleOutcome of ["success", "failure"] as const) {
    let resolveAll!: (value: { sessions: SessionInfo[]; hasMore: boolean }) => void;
    let rejectAll!: (cause: unknown) => void;
    const allPage = new Promise<{ sessions: SessionInfo[]; hasMore: boolean }>((resolvePromise, rejectPromise) => {
      resolveAll = resolvePromise;
      rejectAll = rejectPromise;
    });
    const scopes: Array<"current" | "all"> = [];
    const itemIds: string[][] = [];
    const session = treeSession({
      sessionFile: undefined,
      sessionManager: {
        usesDefaultSessionDir: () => true,
        getSessionDir: () => "/sessions",
      },
    });
    const operations = new InteractiveSessionOperations({
      runtime: treeRuntime(session),
      terminal: {
        setPickerItems(_picker: string, items: Array<{ id: string }>) { itemIds.push(items.map((item) => item.id)); },
        setSessionPickerScope(scope: "current" | "all") { scopes.push(scope); },
        setSessionPickerPagination() {},
      } as unknown as TuiController,
      refreshTranscript() {},
      updateContext() {},
      async sessionCatalogLoader(query) {
        if (query.allWorkspaces === true) return await allPage;
        return { sessions: [catalogSession("current")], hasMore: false };
      },
    });

    const stale = operations.refreshSessions("all");
    await operations.refreshSessions("current");
    if (staleOutcome === "success") resolveAll({ sessions: [catalogSession("stale-all")], hasMore: false });
    else rejectAll(new Error("stale catalog failure"));
    await assert.doesNotReject(stale);

    assert.deepEqual(scopes, ["current"]);
    assert.deepEqual(itemIds, [[catalogSession("current").path]]);
  }
});

test("interactive session catalog reuses an identical in-flight All load", async () => {
  let resolveAll!: (value: { sessions: SessionInfo[]; hasMore: boolean }) => void;
  const allPage = new Promise<{ sessions: SessionInfo[]; hasMore: boolean }>((resolvePromise) => {
    resolveAll = resolvePromise;
  });
  let allLoads = 0;
  const scopes: Array<"current" | "all"> = [];
  const session = treeSession({
    sessionFile: undefined,
    sessionManager: {
      usesDefaultSessionDir: () => true,
      getSessionDir: () => "/sessions",
    },
  });
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal: {
      setPickerItems() {},
      setSessionPickerScope(scope: "current" | "all") { scopes.push(scope); },
      setSessionPickerPagination() {},
    } as unknown as TuiController,
    refreshTranscript() {},
    updateContext() {},
    async sessionCatalogLoader(query) {
      if (query.allWorkspaces === true) {
        allLoads += 1;
        return await allPage;
      }
      return { sessions: [catalogSession("current")], hasMore: false };
    },
  });

  const firstAll = operations.refreshSessions("all");
  const current = operations.refreshSessions("current");
  const secondAll = operations.refreshSessions("all");
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  assert.equal(allLoads, 1);

  resolveAll({ sessions: [catalogSession("all")], hasMore: false });
  await Promise.all([firstAll, current, secondAll]);
  assert.deepEqual(scopes, ["all"]);
});

test("session deletion rejects an active file reached through another symlink alias", {
  skip: process.platform === "win32" ? "directory symlinks require optional Windows privileges" : false,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rigyn-active-session-alias-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const real = join(root, "real");
  const aliasA = join(root, "alias-a");
  const aliasB = join(root, "alias-b");
  await mkdir(real);
  await symlink(real, aliasA, "dir");
  await symlink(real, aliasB, "dir");
  await writeFile(join(real, "active.jsonl"), "session\n");

  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(treeSession({ sessionFile: join(aliasA, "active.jsonl") })),
    terminal: {} as TuiController,
    refreshTranscript() {},
    updateContext() {},
  });
  await assert.rejects(
    operations.handleMutation({
      type: "session_delete",
      item: { id: "active", label: "Active", value: join(aliasB, "active.jsonl") },
      scope: "current",
      query: "",
    }),
    /Cannot delete the active session/u,
  );
});

test("/tree returns from cancelled summary prompts without losing the selected entry", async () => {
  const selected: Array<string | undefined> = [];
  const summaryChoices: string[] = [];
  const navigations: unknown[] = [];
  let treeSelections = 0;
  let summaryPrompts = 0;
  const session = treeSession({
    async navigateTree(targetId: string, options: unknown) {
      navigations.push({ targetId, options });
      return { cancelled: false };
    },
  });
  const terminal = {
    async chooseSessionTree(
      _prompt: string,
      _rows: unknown[],
      options: { initialEventId?: string },
    ) {
      selected.push(options.initialEventId);
      treeSelections += 1;
      return "target";
    },
    async choose() {
      summaryPrompts += 1;
      if (summaryPrompts === 1) throw new TuiSelectionCancelledError();
      const value = summaryPrompts === 2 ? "custom" : "default";
      summaryChoices.push(value);
      return value;
    },
    async question() {
      throw new TuiSelectionCancelledError();
    },
    setInputBlocked() {},
    getEditorText: () => "",
    notify() {},
  } as unknown as TuiController;
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal,
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.navigateTree();

  assert.equal(treeSelections, 2);
  assert.deepEqual(selected, [undefined, "target"]);
  assert.deepEqual(summaryChoices, ["custom", "default"]);
  assert.deepEqual(navigations, [{
    targetId: "target",
    options: { summarize: true },
  }]);
});

test("/tree returns a persisted label timestamp to the open picker", async () => {
  const timestamp = "2026-07-20T01:02:03.000Z";
  const session = treeSession();
  Object.assign(session.sessionManager as object, {
    getEntrySequence: (eventId: string) => eventId === "target" ? 2 : undefined,
    getTreeEntryPage: (offset: number) => offset === 2
      ? [{ entry: { id: "target" }, children: [], label: "bookmark", labelTimestamp: timestamp }]
      : [],
  });
  let changed: { label?: string; labelTimestamp?: string } | undefined;
  const terminal = {
    async chooseSessionTree(
      _prompt: string,
      _rows: unknown[],
      options: { onLabelChange(eventId: string, label: string | undefined): { label?: string; labelTimestamp?: string } },
    ) {
      changed = options.onLabelChange("target", "bookmark");
      throw new TuiSelectionCancelledError();
    },
  } as unknown as TuiController;
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal,
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.navigateTree();

  assert.deepEqual(changed, { label: "bookmark", labelTimestamp: timestamp });
});

test("/tree browses an active response without aborting when the picker is cancelled", async () => {
  let pickerOpened = false;
  let aborts = 0;
  const session = treeSession({
    isStreaming: true,
    async abort() { aborts += 1; },
  });
  const terminal = {
    async chooseSessionTree() {
      pickerOpened = true;
      throw new TuiSelectionCancelledError();
    },
  } as unknown as TuiController;
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal,
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.navigateTree();

  assert.equal(pickerOpened, true);
  assert.equal(aborts, 0);
});

test("/tree restores queued input before stopping an active turn and committing navigation", async () => {
  const order: string[] = [];
  let streaming = true;
  let suspended: AgentSessionSuspendedRun | undefined = {
    operationId: "tree-interrupted-run",
    acceptedAt: "2026-08-11T00:00:00.000Z",
    cancelled: false,
    attempts: 1,
    claimedQueueIds: [],
    effects: [{
      effectId: "tree-effect",
      callId: "tree-call",
      name: "bash",
      policy: "never_repeat" as const,
      status: "dispatched" as const,
      step: 0,
      index: 0,
      inputHash: "tree-input",
    }],
  };
  const queued = [{ mode: "followUp" as const, text: "preserve me" }];
  const session = treeSession({
    getQueuedMessages() { return [...queued]; },
    dequeueMessage() { return queued.shift(); },
    async abort() {
      assert.deepEqual(order, ["validate", "restore"]);
      order.push("abort");
      streaming = false;
      if (suspended !== undefined) suspended = { ...suspended, cancelled: true };
    },
    async waitForIdle() {},
    async recoverInterruptedRun(options: unknown) {
      assert.deepEqual(options, {
        resolutions: [{ effectId: "tree-effect", outcome: "abandoned" }],
      });
      order.push("recover");
      suspended = undefined;
      return { recovered: true, operationId: "tree-interrupted-run", blocked: [] };
    },
    async navigateTree() {
      assert.equal(streaming, false);
      assert.equal(suspended, undefined);
      order.push("navigate");
      return { cancelled: false };
    },
    settingsManager: {
      getTreeFilterMode: () => "default",
      getBranchSummarySkipPrompt: () => true,
    },
  });
  Object.defineProperties(session, {
    isStreaming: { configurable: true, get: () => streaming },
    suspendedRun: { configurable: true, get: () => suspended },
  });
  const terminal = {
    async chooseSessionTree() { return "target"; },
    assertQueuedMessagesRestorable() { order.push("validate"); },
    restoreQueuedMessages(messages: unknown[]) {
      assert.equal(messages.length, 1);
      order.push("restore");
      return messages.length;
    },
    getEditorText: () => "",
    notify() {},
  } as unknown as TuiController;
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal,
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.navigateTree();

  assert.deepEqual(order, ["validate", "restore", "abort", "recover", "navigate"]);
});

test("/tree blocks input only while summarizing, unblocks it, and reopens an aborted target", async () => {
  const selected: Array<string | undefined> = [];
  const blocked: Array<[string | undefined, string | undefined]> = [];
  const handlers: Array<() => void> = [];
  let handlerReleases = 0;
  const notifications: string[] = [];
  let navigationResolve!: (value: { cancelled: boolean; aborted: boolean }) => void;
  let treeSelections = 0;
  const session = treeSession({
    async navigateTree() {
      return await new Promise<{ cancelled: boolean; aborted: boolean }>((resolve) => {
        navigationResolve = resolve;
      });
    },
    abortBranchSummary() {
      navigationResolve({ cancelled: true, aborted: true });
    },
  });
  const terminal = {
    async chooseSessionTree(
      _prompt: string,
      _rows: unknown[],
      options: { initialEventId?: string },
    ) {
      selected.push(options.initialEventId);
      treeSelections += 1;
      return treeSelections === 1 ? "target" : "leaf";
    },
    async choose() { return "default"; },
    setInputBlocked(message?: string, label?: string) { blocked.push([message, label]); },
    notify(message: string) { notifications.push(message); },
  } as unknown as TuiController;
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal,
    refreshTranscript() {},
    updateContext() {},
    registerSummaryCancelHandler(handler) {
      handlers.push(handler);
      queueMicrotask(handler);
      return () => { handlerReleases += 1; };
    },
  });

  await operations.navigateTree();

  assert.deepEqual(selected, [undefined, "target"]);
  assert.deepEqual(blocked, [
    ["Summarizing branch… Esc to cancel", "summary"],
    [undefined, undefined],
  ]);
  assert.equal(typeof handlers[0], "function");
  assert.equal(handlerReleases, 1);
  assert.deepEqual(notifications, ["Branch summarization cancelled", "Already at this point"]);
});

test("/tree ignores a late summary result after its operation signal is cancelled", async () => {
  let navigationResolve!: (value: { cancelled: boolean; editorText: string }) => void;
  let navigationStarted!: () => void;
  const started = new Promise<void>((resolve) => { navigationStarted = resolve; });
  let summaryAborts = 0;
  let refreshes = 0;
  let updates = 0;
  const blocked: Array<string | undefined> = [];
  const edits: string[] = [];
  const notifications: string[] = [];
  const session = treeSession({
    async navigateTree() {
      navigationStarted();
      return await new Promise<{ cancelled: boolean; editorText: string }>((resolve) => {
        navigationResolve = resolve;
      });
    },
    abortBranchSummary() { summaryAborts += 1; },
  });
  const terminal = {
    async chooseSessionTree() { return "target"; },
    async choose() { return "default"; },
    setInputBlocked(message?: string) { blocked.push(message); },
    getEditorText: () => "",
    setEditorText(value: string) { edits.push(value); },
    notify(message: string) { notifications.push(message); },
  } as unknown as TuiController;
  const controller = new AbortController();
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal,
    refreshTranscript() { refreshes += 1; },
    updateContext() { updates += 1; },
  });

  const pending = operations.navigateTree(controller.signal);
  await started;
  controller.abort(new Error("operation cancelled"));
  assert.equal(blocked.at(-1), undefined);
  navigationResolve({ cancelled: false, editorText: "stale draft" });
  await assert.rejects(pending, /operation cancelled/u);

  assert.equal(summaryAborts, 1);
  assert.deepEqual(blocked, ["Summarizing branch… Esc to cancel", undefined]);
  assert.deepEqual(edits, []);
  assert.deepEqual(notifications, []);
  assert.equal(refreshes, 0);
  assert.equal(updates, 0);
});

test("/tree cancels delayed extension work when no branch summary was requested", async () => {
  let navigationResolve!: (value: { cancelled: boolean; editorText: string }) => void;
  let navigationStarted!: () => void;
  const started = new Promise<void>((resolve) => { navigationStarted = resolve; });
  let navigationAborts = 0;
  let refreshes = 0;
  const edits: string[] = [];
  const session = treeSession({
    settingsManager: {
      getTreeFilterMode: () => "default",
      getBranchSummarySkipPrompt: () => true,
    },
    async navigateTree() {
      navigationStarted();
      return await new Promise<{ cancelled: boolean; editorText: string }>((resolve) => {
        navigationResolve = resolve;
      });
    },
    abortBranchSummary() { navigationAborts += 1; },
  });
  const terminal = {
    async chooseSessionTree() { return "target"; },
    getEditorText: () => "",
    setEditorText(value: string) { edits.push(value); },
    notify() {},
  } as unknown as TuiController;
  const controller = new AbortController();
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal,
    refreshTranscript() { refreshes += 1; },
    updateContext() {},
  });

  const pending = operations.navigateTree(controller.signal);
  await started;
  controller.abort(new Error("tree operation cancelled"));
  assert.equal(navigationAborts, 1);
  navigationResolve({ cancelled: false, editorText: "stale branch draft" });
  await assert.rejects(pending, /tree operation cancelled/u);

  assert.deepEqual(edits, []);
  assert.equal(refreshes, 0);
});

test("/tree releases summary input ownership when navigation fails", async () => {
  const blocked: Array<string | undefined> = [];
  let handlerReleases = 0;
  const failure = new Error("summary transport failed");
  const session = treeSession({
    async navigateTree() { throw failure; },
  });
  const terminal = {
    async chooseSessionTree() { return "target"; },
    async choose() { return "default"; },
    setInputBlocked(message?: string) { blocked.push(message); },
  } as unknown as TuiController;
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal,
    refreshTranscript() {},
    updateContext() {},
    registerSummaryCancelHandler() {
      return () => { handlerReleases += 1; };
    },
  });

  await assert.rejects(operations.navigateTree(), failure);

  assert.deepEqual(blocked, ["Summarizing branch… Esc to cancel", undefined]);
  assert.equal(handlerReleases, 1);
});

test("/tree pages large sessions without building a complete tree and reaches recent entries", async () => {
  const timestamp = "2026-07-20T00:00:00.000Z";
  const pageCalls: Array<[number, number]> = [];
  const presented: string[][] = [];
  const navigations: string[] = [];
  const entry = (id: string, parentId: string | null) => ({
    type: "message" as const,
    id,
    parentId,
    timestamp,
    message: {
      id: `message-${id}`,
      role: "user" as const,
      content: [{ type: "text" as const, text: id }],
      createdAt: timestamp,
    },
  });
  const session = treeSession({
    sessionManager: {
      getEntryCount: () => 5_002,
      getLeafId: () => "active-old",
      getEntrySequence: () => 0,
      getTree() { throw new Error("large sessions must not build the complete tree"); },
      getBranch() { throw new Error("large sessions must not clone the complete branch"); },
      getTreePage(offset: number, limit: number) {
        pageCalls.push([offset, limit]);
        const id = offset === 0 ? "active-old" : "recent-target";
        return [{ entry: entry(id, null), children: [] }];
      },
      getActiveBranchEntryIdsInPage(offset: number) {
        return offset === 0 ? ["active-old"] : [];
      },
    },
    settingsManager: {
      getTreeFilterMode: () => "default",
      getBranchSummarySkipPrompt: () => true,
    },
    async navigateTree(targetId: string) {
      navigations.push(targetId);
      return { cancelled: false };
    },
  });
  let selectionCount = 0;
  const terminal = {
    getPickerItemLimit: () => 5_000,
    async chooseSessionTree(
      _prompt: string,
      rows: Array<{ label: string; value: string | symbol }>,
    ) {
      presented.push(rows.map((row) => row.label));
      selectionCount += 1;
      if (selectionCount === 1) return rows.find((row) => row.label === "Later entries")!.value;
      return "recent-target";
    },
    getEditorText: () => "",
    notify() {},
  } as unknown as TuiController;
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal,
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.navigateTree();

  assert.deepEqual(pageCalls, [[0, 4_998], [4, 4_998]]);
  assert.equal(presented[0]?.includes("active-old"), true);
  assert.equal(presented[1]?.includes("active-old"), false);
  assert.equal(presented[1]?.includes("recent-target"), true);
  assert.deepEqual(navigations, ["recent-target"]);
});

test("/share uploads one temporary redacted HTML export as a secret Gist and removes it", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-share-test-"));
  context.after(async () => await rm(cwd, { recursive: true, force: true }));
  const calls: CommandSpec[] = [];
  let exportedPath = "";
  let exportedOptions: unknown;
  const notifications: string[] = [];
  const session = {
    sessionId: "session-test",
    async exportToHtml(path: string, options: unknown) {
      exportedPath = path;
      exportedOptions = options;
      await writeFile(path, "<html>redacted</html>");
    },
  } as unknown as AgentSession;
  const runtime = {
    session,
    cwd,
    services: { agentDir: join(cwd, ".rigyn") },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async importFromJsonl() { return { cancelled: false }; },
  } satisfies InteractiveSessionRuntime;
  const runner: ProcessRunner = {
    async run(spec) {
      calls.push(spec);
      if (calls.length === 1) return result();
      assert.equal(await readFile(spec.argv.at(-1)!, "utf8"), "<html>redacted</html>");
      return result("https://gist.github.com/rigyn-user/0123456789abcdef\n");
    },
  };
  const terminal = {
    notify(message: string) { notifications.push(message); },
  } as unknown as TuiController;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal,
    processRunner: runner,
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.shareSession("");

  assert.deepEqual(exportedOptions, { redact: true });
  assert.deepEqual(calls.map((call) => call.argv.slice(0, 4)), [
    ["gh", "auth", "status"],
    ["gh", "gist", "create", "--public=false"],
  ]);
  assert.deepEqual(notifications, ["Share URL: https://gist.github.com/rigyn-user/0123456789abcdef"]);
  await assert.rejects(access(exportedPath));
});

test("/share rejects path arguments before exporting or starting GitHub CLI", async () => {
  let exported = false;
  let started = false;
  const session = {
    async exportToHtml() { exported = true; },
  } as unknown as AgentSession;
  const operations = new InteractiveSessionOperations({
    runtime: {
      session,
      cwd: process.cwd(),
      services: { agentDir: process.cwd() },
      async newSession() { return { cancelled: false }; },
      async switchSession() { return { cancelled: false }; },
      async fork() { return { cancelled: false }; },
      async importFromJsonl() { return { cancelled: false }; },
    },
    terminal: { notify() {} } as unknown as TuiController,
    processRunner: {
      async run() {
        started = true;
        return result();
      },
    },
    refreshTranscript() {},
    updateContext() {},
  });

  await assert.rejects(operations.shareSession("copy.html"), /Usage: \/share/u);
  assert.equal(exported, false);
  assert.equal(started, false);
});

test("/share forwards host cancellation to GitHub CLI work and removes its temporary export", async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), "rigyn-share-cancel-test-"));
  context.after(async () => await rm(cwd, { recursive: true, force: true }));
  let exportedPath = "";
  let started!: () => void;
  const commandStarted = new Promise<void>((resolve) => { started = resolve; });
  const session = {
    async exportToHtml(path: string) {
      exportedPath = path;
      await writeFile(path, "<html>redacted</html>");
    },
  } as unknown as AgentSession;
  const operations = new InteractiveSessionOperations({
    runtime: {
      session,
      cwd,
      services: { agentDir: join(cwd, ".rigyn") },
      async newSession() { return { cancelled: false }; },
      async switchSession() { return { cancelled: false }; },
      async fork() { return { cancelled: false }; },
      async importFromJsonl() { return { cancelled: false }; },
    },
    terminal: { notify() {} } as unknown as TuiController,
    processRunner: {
      async run(_spec, signal): Promise<CommandResult> {
        started();
        return await new Promise<never>((_resolve, reject) => {
          const abort = (): void => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    },
    refreshTranscript() {},
    updateContext() {},
  });
  const controller = new AbortController();
  const pending = operations.shareSession("", controller.signal);
  await commandStarted;
  const reason = new Error("cancel share");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error instanceof Error && error.cause === reason);
  await assert.rejects(access(exportedPath));
});

test("/clone applies its optional name after the replacement session is adopted", async () => {
  const names: string[] = [];
  const notifications: string[] = [];
  let forkOptions: { position?: "before" | "at"; signal?: AbortSignal } | undefined;
  const session = {
    sessionManager: { getLeafId: () => "leaf" },
    setSessionName(name: string) { names.push(name); },
  } as unknown as AgentSession;
  const runtime = {
    session,
    cwd: process.cwd(),
    services: { agentDir: process.cwd() },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork(entryId: string, options?: { position?: "before" | "at"; signal?: AbortSignal }) {
      assert.equal(entryId, "leaf");
      forkOptions = options;
      return { cancelled: false };
    },
    async importFromJsonl() { return { cancelled: false }; },
  } satisfies InteractiveSessionRuntime;
  const terminal = {
    setEditorText(value: string) { assert.equal(value, ""); },
    notify(message: string) { notifications.push(message); },
  } as unknown as TuiController;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal,
    refreshTranscript() {},
    updateContext() {},
  });
  const controller = new AbortController();

  await operations.cloneSession("  reviewed branch  ", controller.signal);

  assert.deepEqual(names, ["reviewed branch"]);
  assert.deepEqual(forkOptions, { position: "at", signal: controller.signal });
  assert.deepEqual(notifications, ['Cloned to new session "reviewed branch"']);
});

test("new and fork operations forward their caller signal to runtime and TUI boundaries", async () => {
  const controller = new AbortController();
  let newSignal: AbortSignal | undefined;
  let forkSignal: AbortSignal | undefined;
  let chooseSignal: AbortSignal | undefined;
  const session = {
    getUserMessagesForForking() {
      return [{ entryId: "entry", text: "selected text" }];
    },
  } as unknown as AgentSession;
  const runtime = {
    session,
    cwd: process.cwd(),
    services: { agentDir: process.cwd() },
    async newSession(options?: { signal?: AbortSignal }) {
      newSignal = options?.signal;
      return { cancelled: false };
    },
    async switchSession() { return { cancelled: false }; },
    async fork(_entryId: string, options?: { position?: "before" | "at"; signal?: AbortSignal }) {
      forkSignal = options?.signal;
      return { cancelled: false, selectedText: "selected text" };
    },
    async importFromJsonl() { return { cancelled: false }; },
  } satisfies InteractiveSessionRuntime;
  const terminal = {
    async choose(_prompt: string, _choices: unknown[], signal?: AbortSignal) {
      chooseSignal = signal;
      return "entry";
    },
    setEditorText() {},
    notify() {},
  } as unknown as TuiController;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal,
    refreshTranscript() {},
    updateContext() {},
  });

  await operations.newSession(controller.signal);
  await operations.forkSession(controller.signal);

  assert.equal(newSignal, controller.signal);
  assert.equal(chooseSignal, controller.signal);
  assert.equal(forkSignal, controller.signal);
});

test("/context reports the composed prompt sources and current context state", () => {
  const notifications: string[] = [];
  const session = {
    model: { provider: "openai-codex", id: "gpt-test", api: "openai-responses" },
    thinkingLevel: "xhigh",
    messages: [{}, {}],
    autoCompactionEnabled: true,
    isCompacting: false,
    getContextUsage() { return { tokens: 512, contextWindow: 4096, percent: 12.5 }; },
    getPromptComposition() {
      return {
        bytes: 6,
        sha256: "a".repeat(64),
        sources: [
          {
            kind: "additional_instructions",
            source: "built-in:system-prompt",
            bytes: 2,
            sha256: "b".repeat(64),
          },
          {
            kind: "instruction",
            source: "/workspace/AGENTS.md",
            bytes: 4,
            sha256: "c".repeat(64),
          },
        ],
        tools: ["read", "bash"],
        skills: [{ name: "build", manifestPath: "/skills/build/SKILL.md" }],
        truncated: false,
      };
    },
  } as unknown as AgentSession;
  const runtime = {
    session,
    cwd: "/workspace",
    services: { agentDir: "/agent" },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async importFromJsonl() { return { cancelled: false }; },
  } satisfies InteractiveSessionRuntime;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal: { notify(message: string) { notifications.push(message); } } as unknown as TuiController,
    refreshTranscript() {},
    updateContext() {},
  });

  operations.showContext();

  assert.deepEqual(notifications, [[
    "Model: openai-codex/gpt-test (openai-responses) · thinking: xhigh",
    "Context: 512/4096 tokens (12.5%)",
    "Messages: 2 · auto-compaction: on · context operation: idle",
    `System prompt: 6 bytes · built-in core · sha256 ${"a".repeat(64)}`,
    'Prompt sources: additional instructions: "built-in:system-prompt", instruction: "/workspace/AGENTS.md"',
    'Prompt skills: build ("/skills/build/SKILL.md")',
    "Prompt tools: read, bash",
  ].join("\n")]);
});

test("/context does not claim prompt provenance before the first composition", () => {
  const notifications: string[] = [];
  const session = {
    model: undefined,
    thinkingLevel: "off",
    messages: [],
    autoCompactionEnabled: false,
    isCompacting: true,
    getContextUsage() { return { tokens: null, contextWindow: 1000, percent: null }; },
    getPromptComposition() { return undefined; },
  } as unknown as AgentSession;
  const runtime = {
    session,
    cwd: "/workspace",
    services: { agentDir: "/agent" },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async importFromJsonl() { return { cancelled: false }; },
  } satisfies InteractiveSessionRuntime;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal: { notify(message: string) { notifications.push(message); } } as unknown as TuiController,
    refreshTranscript() {},
    updateContext() {},
  });

  operations.showContext();

  assert.deepEqual(notifications, [[
    "Model: none · thinking: off",
    "Context: unknown/1000 tokens",
    "Messages: 0 · auto-compaction: off · context operation: running",
    "System prompt: not composed yet",
  ].join("\n")]);
});

test("/compact preserves the live transcript and relies on its durable completion card", async () => {
  const refreshes: Array<{ preserveExisting?: boolean } | undefined> = [];
  const notifications: string[] = [];
  const compactArguments: Array<string | undefined> = [];
  let contextUpdates = 0;
  const session = {
    async compact(argument?: string) {
      compactArguments.push(argument);
      return {
        summary: "durable summary",
        firstKeptEntryId: "kept",
        tokensBefore: 12_345,
      };
    },
  } as unknown as AgentSession;
  const runtime = {
    session,
    cwd: "/workspace",
    services: { agentDir: "/agent" },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async importFromJsonl() { return { cancelled: false }; },
  } satisfies InteractiveSessionRuntime;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal: {
      notify(message: string) { notifications.push(message); },
    } as unknown as TuiController,
    refreshTranscript(options) { refreshes.push(options); },
    updateContext() { contextUpdates += 1; },
  });

  await operations.compact("keep decisions");

  assert.deepEqual(compactArguments, ["keep decisions"]);
  assert.deepEqual(refreshes, [{ preserveExisting: true }]);
  assert.deepEqual(notifications, []);
  assert.equal(contextUpdates, 1);
});

test("/compact clears only earlier local errors at the operations-to-TUI boundary", async (context) => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const terminal = new TuiController({
    input,
    output,
    mode: "full",
    environment: { TERM: "xterm-256color", LANG: "en_US.UTF-8", TERM_COLOR: "0" },
    handleSignals: false,
  });
  context.after(() => terminal.close());
  terminal.start();
  const viewport = new FocusedVirtualTerminal(output.columns, output.rows);
  let renderedChunks = 0;
  const flush = (): void => {
    for (const chunk of output.chunks.slice(renderedChunks)) viewport.write(chunk.toString("utf8"));
    renderedChunks = output.chunks.length;
  };
  flush();

  terminal.notify("No subscription login is registered", "error");
  terminal.notify("Review provider settings", "warning");
  await tick();
  flush();
  assert.match(viewport.viewport().join("\n"), /No subscription login is registered/u);

  const session = {
    async compact() {
      terminal.render(envelope({ type: "compaction_started", reason: "manual" }));
      await Promise.resolve();
      terminal.notify("Provider refresh failed during compaction", "error");
      return {
        summary: "Retained compacted context",
        firstKeptEntryId: "kept",
        tokensBefore: 14_721,
      };
    },
  } as unknown as AgentSession;
  const operations = new InteractiveSessionOperations({
    runtime: treeRuntime(session),
    terminal,
    refreshTranscript(options) {
      terminal.replaceTranscript([{
        type: "session_summary",
        id: "fresh-compaction-summary",
        summaryType: "compaction",
        text: "Retained compacted context",
        tokensBefore: 14_721,
      }], "main", options);
    },
    updateContext() {},
  });

  await operations.compact("");
  await tick();
  terminal.renderNow();
  flush();

  const rendered = viewport.viewport().join("\n");
  assert.match(rendered, /Context compacted/u);
  assert.match(rendered, /Review provider settings/u);
  assert.match(rendered, /Provider refresh failed during compaction/u);
  assert.doesNotMatch(rendered, /No subscription login is registered/u);
});

test("/compact refreshes interactive state after a failed compaction", async () => {
  let contextUpdates = 0;
  const session = {
    async compact() { throw new Error("nothing to compact"); },
  } as unknown as AgentSession;
  const runtime = {
    session,
    cwd: "/workspace",
    services: { agentDir: "/agent" },
    async newSession() { return { cancelled: false }; },
    async switchSession() { return { cancelled: false }; },
    async fork() { return { cancelled: false }; },
    async importFromJsonl() { return { cancelled: false }; },
  } satisfies InteractiveSessionRuntime;
  const operations = new InteractiveSessionOperations({
    runtime,
    terminal: { notify() {} } as unknown as TuiController,
    refreshTranscript() {},
    updateContext() { contextUpdates += 1; },
  });

  await assert.rejects(operations.compact(""), /nothing to compact/u);
  assert.equal(contextUpdates, 1);
});
