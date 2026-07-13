import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  MAX_EXTENSION_ENTRY_PAYLOAD_BYTES,
  type ExtensionMessageEvent,
} from "../../src/core/extension-entries.js";
import { loadRuntimeExtensions, RuntimeExtensionHost } from "../../src/extensions/runtime.js";
import { RpcRuntimeDispatcher } from "../../src/interfaces/rpc-runtime.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { cloneSessionPath } from "../../src/service/session-clone.js";
import { StoredConversation } from "../../src/service/session-runtime.js";
import { exportThreadHtml, exportThreadMarkdown, importThreadJsonl } from "../../src/service/session-transfer.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { DEFAULT_TUI_LIMITS } from "../../src/tui/controller.js";
import { TuiModel } from "../../src/tui/model.js";
import { sha256 } from "../../src/tools/hash.js";
import { CapturePeer } from "../interfaces/rpc-helpers.js";

const renderContext = {
  width: 80,
  height: 24,
  focused: false,
  expanded: false,
  theme: { name: "dark" as const, color: true, unicode: true },
};

const ownerSource = `export default (api) => {
  globalThis.__runtimeSessionOwnerApi = api;
  api.session.registerRenderers(1, {
    renderState(entry) {
      return { lines: [{ spans: [{ text: "state:" + entry.key + ":" + JSON.stringify(entry.value), role: "accent" }] }] };
    },
    renderMessage(entry) {
      return { lines: [{ spans: [{ text: "message:" + entry.kind + ":" + JSON.stringify(entry.payload), role: "success" }] }] };
    }
  });
  api.session.registerRenderers(2, {
    renderState() { throw new Error("state renderer exploded"); },
    renderMessage() { throw new Error("message renderer exploded"); }
  });
};\n`;

const foreignSource = `export default (api) => { globalThis.__runtimeSessionForeignApi = api; };\n`;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-session-entry-"));
  const ownerPath = join(root, "owner.mjs");
  const foreignPath = join(root, "foreign.mjs");
  await writeFile(ownerPath, ownerSource);
  await writeFile(foreignPath, foreignSource);
  const host = await loadRuntimeExtensions([
    { extensionId: "owner.extension", sourcePath: ownerPath, sha256: sha256(ownerSource) },
    { extensionId: "foreign.extension", sourcePath: foreignPath, sha256: sha256(foreignSource) },
  ], { workspace: root });
  const store = new SessionStore(join(root, "sessions.sqlite"));
  const providers = new ProviderRegistry();
  const service = new HarnessService({
    store,
    workspace: root,
    providers,
    runtimeExtensions: host,
  });
  await service.initialize({ skills: [] });
  t.after(async () => {
    await service.close("runtime_session_entry_test");
    await host.close();
    store.close();
    delete (globalThis as Record<string, unknown>).__runtimeSessionOwnerApi;
    delete (globalThis as Record<string, unknown>).__runtimeSessionForeignApi;
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    host,
    store,
    service,
    providers,
    owner: (globalThis as Record<string, any>).__runtimeSessionOwnerApi,
    foreign: (globalThis as Record<string, any>).__runtimeSessionForeignApi,
  };
}

async function crossHostFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "harness-runtime-state-cas-"));
  const database = join(root, "sessions.sqlite");
  const sourceA = `export default (api) => { globalThis.__runtimeStateCasApiA = api; };\n`;
  const sourceB = `export default (api) => { globalThis.__runtimeStateCasApiB = api; };\n`;
  const pathA = join(root, "owner-a.mjs");
  const pathB = join(root, "owner-b.mjs");
  await writeFile(pathA, sourceA);
  await writeFile(pathB, sourceB);
  const hostA = await loadRuntimeExtensions([
    { extensionId: "owner.extension", sourcePath: pathA, sha256: sha256(sourceA) },
  ], { workspace: root });
  const hostB = await loadRuntimeExtensions([
    { extensionId: "owner.extension", sourcePath: pathB, sha256: sha256(sourceB) },
  ], { workspace: root });
  const storeA = new SessionStore(database);
  const storeB = new SessionStore(database);
  const serviceA = new HarnessService({ store: storeA, workspace: root, providers: new ProviderRegistry(), runtimeExtensions: hostA });
  const serviceB = new HarnessService({ store: storeB, workspace: root, providers: new ProviderRegistry(), runtimeExtensions: hostB });
  await serviceA.initialize({ skills: [] });
  await serviceB.initialize({ skills: [] });
  t.after(async () => {
    await serviceA.close("runtime_state_cas_test");
    await serviceB.close("runtime_state_cas_test");
    await hostA.close();
    await hostB.close();
    storeA.close();
    storeB.close();
    delete (globalThis as Record<string, unknown>).__runtimeStateCasApiA;
    delete (globalThis as Record<string, unknown>).__runtimeStateCasApiB;
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    storeA,
    storeB,
    apiA: (globalThis as Record<string, any>).__runtimeStateCasApiA,
    apiB: (globalThis as Record<string, any>).__runtimeStateCasApiB,
  };
}

test("extension session APIs bind namespaces, snapshot payloads, and reconstruct branch-local state", async (t) => {
  const { root, store, owner, foreign } = await fixture(t);
  const thread = store.createThread({ threadId: "extension-state-thread", workspaceRoot: root });
  const mutable = { count: 1 };
  const firstPending = owner.session.appendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "counter",
    value: mutable,
  });
  mutable.count = 999;
  const first = await firstPending;
  assert.deepEqual(first.value, { count: 1 });
  assert.equal(first.extensionId, "owner.extension");
  assert.equal(first.branch, "main");
  (first.value as { count: number }).count = 777;
  assert.deepEqual((await owner.session.readState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "counter",
  }))?.value, { count: 1 });
  assert.equal(await foreign.session.readState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "counter",
  }), undefined);

  store.forkBranch({ threadId: thread.threadId, newBranch: "experiment", atEventId: first.eventId });
  await owner.session.appendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "counter",
    value: { count: 2 },
  });
  await owner.session.appendState({
    threadId: thread.threadId,
    branch: "experiment",
    schemaVersion: 1,
    key: "counter",
    value: { count: 3 },
  });
  const mainMessage = await owner.session.appendMessage({
    threadId: thread.threadId,
    schemaVersion: 1,
    kind: "branch_message",
    payload: { branch: "main" },
    modelContext: false,
    transcript: false,
  });
  (mainMessage.payload as { branch: string }).branch = "mutated-return-value";
  await owner.session.appendMessage({
    threadId: thread.threadId,
    branch: "experiment",
    schemaVersion: 1,
    kind: "branch_message",
    payload: { branch: "experiment" },
    modelContext: false,
    transcript: false,
  });
  assert.deepEqual((await owner.session.readState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "counter",
  }))?.value, { count: 2 });
  assert.deepEqual((await owner.session.readState({
    threadId: thread.threadId,
    branch: "experiment",
    schemaVersion: 1,
    key: "counter",
  }))?.value, { count: 3 });
  assert.deepEqual((await owner.session.readMessages({
    threadId: thread.threadId,
    schemaVersion: 1,
    kind: "branch_message",
  })).map((entry: any) => entry.payload), [{ branch: "main" }]);
  assert.deepEqual((await owner.session.readMessages({
    threadId: thread.threadId,
    branch: "experiment",
    schemaVersion: 1,
    kind: "branch_message",
  })).map((entry: any) => entry.payload), [{ branch: "experiment" }]);

  await assert.rejects(owner.session.appendState({
    threadId: thread.threadId,
    extensionId: "foreign.extension",
    schemaVersion: 1,
    key: "spoofed",
    value: null,
  }), /owner-controlled field/u);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  await assert.rejects(owner.session.appendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "cycle",
    value: cycle,
  }), /cycle/u);
  const getter = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(getter, "secret", { enumerable: true, get() { return "unsafe"; } });
  await assert.rejects(owner.session.appendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "getter",
    value: getter,
  }), /data properties/u);
  await assert.rejects(owner.session.appendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "large",
    value: "x".repeat(MAX_EXTENSION_ENTRY_PAYLOAD_BYTES + 1),
  }), /exceeds/u);
  let deep: Record<string, unknown> = {};
  const deepRoot = deep;
  for (let index = 0; index < 34; index += 1) {
    const next: Record<string, unknown> = {};
    deep.next = next;
    deep = next;
  }
  await assert.rejects(owner.session.appendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "deep",
    value: deepRoot,
  }), /depth/u);
  await assert.rejects(owner.session.compareAndAppendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "missing_expected_event",
    value: null,
  }), /expectedEventId/u);
});

test("extension state compare-and-append prevents cross-host lost updates and resolves canonical branches", async (t) => {
  const { root, storeA, apiA, apiB } = await crossHostFixture(t);
  const thread = storeA.createThread({ threadId: "extension-state-cas-thread", workspaceRoot: root });

  const first = await apiA.session.compareAndAppendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "counter",
    value: { count: 1 },
    expectedEventId: null,
  });
  assert.equal(first.status, "committed");
  if (first.status !== "committed") return;
  assert.equal(first.record.branch, "main");

  const staleCreate = await apiB.session.compareAndAppendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "counter",
    value: { count: 99 },
    expectedEventId: null,
  });
  assert.deepEqual(staleCreate, {
    status: "conflict",
    threadId: thread.threadId,
    branch: "main",
    expectedEventId: null,
    current: first.record,
  });

  await apiA.session.appendMessage({
    threadId: thread.threadId,
    schemaVersion: 1,
    kind: "unrelated",
    payload: null,
    modelContext: false,
    transcript: false,
  });
  const second = await apiB.session.compareAndAppendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "counter",
    value: { count: 2 },
    expectedEventId: first.record.eventId,
  });
  assert.equal(second.status, "committed");
  if (second.status !== "committed") return;

  const third = await apiA.session.compareAndAppendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "counter",
    value: { count: 3 },
    expectedEventId: second.record.eventId,
  });
  assert.equal(third.status, "committed");
  if (third.status !== "committed") return;
  const staleUpdate = await apiB.session.compareAndAppendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "counter",
    value: { count: 4 },
    expectedEventId: second.record.eventId,
  });
  assert.equal(staleUpdate.status, "conflict");
  assert.deepEqual(staleUpdate.status === "conflict" ? staleUpdate.current?.value : undefined, { count: 3 });

  storeA.forkBranch({
    threadId: thread.threadId,
    newBranch: "experiment",
    atEventId: first.record.eventId,
  });
  const branchUpdate = await apiB.session.compareAndAppendState({
    threadId: thread.threadId,
    branch: "experiment",
    schemaVersion: 1,
    key: "counter",
    value: { count: 10 },
    expectedEventId: first.record.eventId,
  });
  assert.equal(branchUpdate.status === "committed" ? branchUpdate.record.branch : undefined, "experiment");
  assert.deepEqual((await apiA.session.readState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "counter",
  }))?.value, { count: 3 });

  const controller = new AbortController();
  controller.abort(new Error("stop stale update"));
  await assert.rejects(apiB.session.compareAndAppendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "counter",
    value: { count: 11 },
    expectedEventId: third.record.eventId,
    signal: controller.signal,
  }), /stop stale update/u);
  assert.deepEqual((await apiA.session.readState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "counter",
  }))?.value, { count: 3 });
});

test("custom extension messages independently control model context and transcript display", async (t) => {
  const { root, store, owner } = await fixture(t);
  const thread = store.createThread({ threadId: "extension-message-thread", workspaceRoot: root });
  await owner.session.appendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "private_state",
    value: { sentinel: "STATE_MUST_NOT_REACH_MODEL" },
  });
  const modelOnly = await owner.session.appendMessage({
    threadId: thread.threadId,
    schemaVersion: 1,
    kind: "model_only",
    payload: { marker: "payload-model" },
    modelContext: { role: "system", text: "MODEL_ONLY" },
    transcript: false,
  });
  await owner.session.appendMessage({
    threadId: thread.threadId,
    schemaVersion: 1,
    kind: "display_only",
    payload: { marker: "payload-display" },
    modelContext: false,
    transcript: { text: "DISPLAY_ONLY <script>" },
  });
  const both = await owner.session.appendMessage({
    threadId: thread.threadId,
    schemaVersion: 1,
    kind: "both",
    payload: { marker: "payload-both" },
    modelContext: { role: "user", text: "BOTH_CONTEXT" },
    transcript: { text: "BOTH_DISPLAY" },
  });
  (both.payload as { marker: string }).marker = "MUTATED_RETURN_PAYLOAD";
  if (both.modelContext !== false) both.modelContext.text = "MUTATED_RETURN_CONTEXT";
  if (both.transcript !== false) both.transcript.text = "MUTATED_RETURN_TRANSCRIPT";
  await owner.session.appendMessage({
    threadId: thread.threadId,
    schemaVersion: 1,
    kind: "hidden",
    payload: { marker: "payload-hidden" },
    modelContext: false,
    transcript: false,
  });

  const conversation = new StoredConversation(store);
  const before = await conversation.loadContext(
    thread.threadId,
    "main",
    "offline-provider",
    new AbortController().signal,
  );
  const contextWire = JSON.stringify(before.messages);
  assert.match(contextWire, /MODEL_ONLY/u);
  assert.match(contextWire, /BOTH_CONTEXT/u);
  assert.doesNotMatch(contextWire, /DISPLAY_ONLY/u);
  assert.doesNotMatch(contextWire, /STATE_MUST_NOT_REACH_MODEL/u);
  assert.doesNotMatch(contextWire, /payload-/u);
  assert.doesNotMatch(contextWire, /MUTATED_RETURN/u);

  const model = new TuiModel(DEFAULT_TUI_LIMITS);
  for (const event of store.listEvents(thread.threadId)) model.apply(event);
  const transcript = JSON.stringify(model.entries);
  assert.match(transcript, /DISPLAY_ONLY/u);
  assert.match(transcript, /BOTH_DISPLAY/u);
  assert.doesNotMatch(transcript, /MODEL_ONLY/u);
  assert.doesNotMatch(transcript, /STATE_MUST_NOT_REACH_MODEL/u);
  assert.doesNotMatch(transcript, /payload-/u);
  assert.doesNotMatch(transcript, /MUTATED_RETURN/u);

  store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "compaction_completed",
      summary: {
        id: "extension-compaction-summary",
        role: "user",
        content: [{ type: "text", text: "EXTENSION_COMPACTED" }],
        createdAt: "2026-07-10T00:00:00.000Z",
        purpose: "compaction",
      },
      sourceMessageIds: [modelOnly.messageId, both.messageId],
    },
  });
  const compacted = await conversation.loadContext(
    thread.threadId,
    "main",
    "offline-provider",
    new AbortController().signal,
  );
  const compactedWire = JSON.stringify(compacted.messages);
  assert.match(compactedWire, /EXTENSION_COMPACTED/u);
  assert.doesNotMatch(compactedWire, /MODEL_ONLY|BOTH_CONTEXT/u);
  assert.equal((await owner.session.readMessages({
    threadId: thread.threadId,
    schemaVersion: 1,
    limit: 10,
  })).length, 4);
  assert.deepEqual((await owner.session.readState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "private_state",
  }))?.value, { sentinel: "STATE_MUST_NOT_REACH_MODEL" });

  const clone = cloneSessionPath(store, { threadId: thread.threadId, workspaceRoot: root });
  assert.deepEqual(
    store.getExtensionState(clone.thread.threadId, "owner.extension", 1, "private_state")?.event.value,
    { sentinel: "STATE_MUST_NOT_REACH_MODEL" },
  );
  assert.equal(store.listExtensionMessages(clone.thread.threadId, "owner.extension", 1).length, 4);

  const transferred = new SessionStore(":memory:");
  t.after(() => transferred.close());
  const imported = importThreadJsonl(transferred, store.exportThread(thread.threadId), { workspaceRoot: root });
  assert.deepEqual(
    transferred.getExtensionState(imported.thread.threadId, "owner.extension", 1, "private_state")?.event.value,
    { sentinel: "STATE_MUST_NOT_REACH_MODEL" },
  );
  assert.equal(transferred.listExtensionMessages(imported.thread.threadId, "owner.extension", 1).length, 4);
  const importedContext = await new StoredConversation(transferred).loadContext(
    imported.thread.threadId,
    "main",
    "offline-provider",
    new AbortController().signal,
  );
  assert.match(JSON.stringify(importedContext.messages), /EXTENSION_COMPACTED/u);
  const markdown = exportThreadMarkdown(store, thread.threadId);
  const html = exportThreadHtml(store, thread.threadId);
  assert.match(markdown, /DISPLAY_ONLY <script>/u);
  assert.doesNotMatch(markdown, /MODEL_ONLY|STATE_MUST_NOT_REACH_MODEL/u);
  assert.match(html, /DISPLAY_ONLY &lt;script&gt;/u);
  assert.doesNotMatch(html, /DISPLAY_ONLY <script>/u);
  assert.doesNotMatch(html, /STATE_MUST_NOT_REACH_MODEL/u);
});

test("session renderers are generation-owned and safely fall back for failures or missing extensions", async (t) => {
  const { root, host, store, service, owner } = await fixture(t);
  const thread = store.createThread({ threadId: "extension-render-thread", workspaceRoot: root });
  const state = await owner.session.appendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "rendered",
    value: { visible: true },
  });
  const message = await owner.session.appendMessage({
    threadId: thread.threadId,
    schemaVersion: 1,
    kind: "rendered",
    payload: { visible: true },
    modelContext: false,
    transcript: { text: "safe fallback" },
  });
  assert.deepEqual(host.renderers().filter((entry) => entry.kind === "session").map((entry) => entry.key), ["1", "2"]);
  assert.match(JSON.stringify(host.renderExtensionState(state, renderContext)), /state:rendered/u);
  assert.match(JSON.stringify(host.renderExtensionMessage(message, renderContext)), /message:rendered/u);

  const broken = await owner.session.appendMessage({
    threadId: thread.threadId,
    schemaVersion: 2,
    kind: "broken",
    payload: { secret: "renderer-only-payload" },
    modelContext: false,
    transcript: { text: "fallback after failure" },
  });
  const fallback = host.renderExtensionMessage(broken, renderContext);
  assert.match(JSON.stringify(fallback), /fallback after failure/u);
  assert.doesNotMatch(JSON.stringify(fallback), /renderer-only-payload/u);
  assert.equal(host.diagnostics().filter((entry) => entry.message.includes("message renderer exploded")).length, 1);

  const missing = new RuntimeExtensionHost(root);
  const missingFallback = missing.renderExtensionMessage(message, renderContext);
  const missingState = missing.renderExtensionState({ ...state, value: { secret: "must-stay-hidden" } }, renderContext);
  assert.match(JSON.stringify(missingFallback), /safe fallback/u);
  assert.doesNotMatch(JSON.stringify(missingFallback), /visible/u);
  assert.doesNotMatch(JSON.stringify(missingState), /must-stay-hidden/u);
  await missing.close();

  await service.close("runtime_reload_fixture");
  await host.close();
  await assert.rejects(owner.session.readMessages({
    threadId: thread.threadId,
    schemaVersion: 1,
  }), /no longer active/u);
});

test("storage rejects malformed extension events without invoking accessors", () => {
  const store = new SessionStore(":memory:");
  const thread = store.createThread({ threadId: "direct-extension-event" });
  const payload = Object.create(null) as Record<string, unknown>;
  let invoked = false;
  Object.defineProperty(payload, "owned", {
    enumerable: true,
    get() { invoked = true; return "unsafe"; },
  });
  assert.throws(() => store.appendEvent({
    threadId: thread.threadId,
    event: {
      type: "extension_message",
      extensionId: "owner.extension",
      schemaVersion: 1,
      kind: "getter",
      messageId: "getter-message",
      payload,
      modelContext: false,
      transcript: false,
    } as ExtensionMessageEvent,
  }), /Invalid event shape/u);
  assert.equal(invoked, false);
  assert.equal(store.listEvents(thread.threadId).length, 0);
  store.close();
});

test("storage snapshots extension payloads without invoking inherited serialization hooks", () => {
  const store = new SessionStore(":memory:");
  const thread = store.createThread({ threadId: "extension-to-json" });
  const original = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  let invoked = 0;
  try {
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value() {
        invoked += 1;
        return { rewritten: true };
      },
    });
    store.appendEvent({
      threadId: thread.threadId,
      event: {
        type: "extension_state",
        extensionId: "owner.extension",
        schemaVersion: 1,
        key: "safe_snapshot",
        value: { kept: ["original"] },
      },
    });
  } finally {
    if (original === undefined) delete (Object.prototype as Record<string, unknown>).toJSON;
    else Object.defineProperty(Object.prototype, "toJSON", original);
  }
  assert.equal(invoked, 0);
  assert.deepEqual(
    store.getExtensionState(thread.threadId, "owner.extension", 1, "safe_snapshot")?.event.value,
    { kept: ["original"] },
  );
  store.close();
});

test("extension session publications are branch-bearing, idle-safe, and failure-isolated", async (t) => {
  const { root, host, store, service, owner } = await fixture(t);
  const thread = store.createThread({ threadId: "extension-publication-thread", workspaceRoot: root });
  const publications: Array<{ branch: string; type: string }> = [];
  const unsubscribe = service.onExtensionSessionEvent((publication) => {
    publications.push({ branch: publication.branch, type: publication.envelope.event.type });
  });
  const first = await owner.session.appendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "published",
    value: { branch: "main" },
  });
  store.forkBranch({ threadId: thread.threadId, newBranch: "experiment", atEventId: first.eventId });
  await owner.session.appendMessage({
    threadId: thread.threadId,
    branch: "experiment",
    schemaVersion: 1,
    kind: "published",
    payload: null,
    modelContext: false,
    transcript: { text: "experiment" },
  });
  assert.deepEqual(publications, [
    { branch: "main", type: "extension_state" },
    { branch: "experiment", type: "extension_message" },
  ]);
  unsubscribe();

  service.onExtensionSessionEvent(() => { throw new Error("publication observer exploded"); });
  const committed = await owner.session.appendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "observer_failure",
    value: { durable: true },
  });
  assert.deepEqual(committed.value, { durable: true });
  assert.deepEqual(store.getExtensionState(
    thread.threadId,
    "owner.extension",
    1,
    "observer_failure",
  )?.event.value, { durable: true });
  assert.equal(host.diagnostics().some((entry) => entry.message.includes("observer failed after durable commit")), true);
});

test("idle extension session publications reach matching RPC subscriptions exactly once", async (t) => {
  const { root, host, store, service, providers, owner } = await fixture(t);
  const thread = store.createThread({ threadId: "extension-rpc-publication", workspaceRoot: root });
  const dispatcher = new RpcRuntimeDispatcher({
    runtime: { workspace: root, store, service, providers, runtimeExtensions: host },
  });
  const peer = new CapturePeer("extension-session-subscriber");
  await dispatcher.dispatch(peer, {
    jsonrpc: "2.0",
    id: 1,
    method: "events.subscribe",
    params: { threadId: thread.threadId, branch: "main", afterSequence: 0 },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  await owner.session.appendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "rpc_state",
    value: { live: true },
  });
  store.forkBranch({ threadId: thread.threadId, newBranch: "experiment" });
  await owner.session.appendMessage({
    threadId: thread.threadId,
    branch: "experiment",
    schemaVersion: 1,
    kind: "wrong_branch",
    payload: null,
    modelContext: false,
    transcript: { text: "must not publish to main" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const delivered = peer.notifications
    .filter((entry) => entry.method === "events.event")
    .map((entry) => (entry.params as { event: { event: { type: string; key?: string; kind?: string } } }).event.event);
  assert.deepEqual(delivered, [{
    type: "extension_state",
    extensionId: "owner.extension",
    schemaVersion: 1,
    key: "rpc_state",
    value: { live: true },
  }]);

  await dispatcher.close("extension publication test complete");
  const before = peer.notifications.length;
  await owner.session.appendState({
    threadId: thread.threadId,
    schemaVersion: 1,
    key: "after_close",
    value: null,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(peer.notifications.length, before);
});
