import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  prepareSessionRuntimeSwitch,
  prepareIndexedSessionRuntimeSwitch,
  indexedSessionReference,
  resolveIndexedSessionReference,
  resolveSessionReference,
  resolveSessionWorkspaceTarget,
  SessionResolutionError,
} from "../../src/cli/session-resolution.js";
import { WorkspaceSessionIndex } from "../../src/cli/session-index.js";
import { TrustStore } from "../../src/config/trust.js";
import { SessionStore } from "../../src/storage/store.js";

function thread(store: SessionStore, threadId: string, name: string | undefined, workspaceRoot: string) {
  return store.createThread({ threadId, ...(name === undefined ? {} : { name }), workspaceRoot });
}

function savedIndexedThread(store: SessionStore, threadId: string, name: string, workspaceRoot: string): void {
  store.createThread({ threadId, name, workspaceRoot });
  store.appendEvent({
    threadId,
    event: {
      type: "message_appended",
      message: {
        id: `${threadId}-user`,
        role: "user",
        createdAt: new Date(0).toISOString(),
        content: [{ type: "text", text: `${name} prompt` }],
      },
    },
  });
}

test("session references prefer exact IDs and resolve unique partial IDs or names within one workspace", () => {
  const store = new SessionStore(":memory:");
  try {
    thread(store, "thread_alpha_001", "Checkout refactor", "/workspace");
    thread(store, "thread_beta_002", "Parser cleanup", "/workspace");
    thread(store, "Checkout refactor", "An ID wins", "/workspace");
    thread(store, "thread_elsewhere", "Unique remote phrase", "/elsewhere");

    assert.equal(resolveSessionReference(store, "Checkout refactor", { workspaceRoot: "/workspace" }).threadId, "Checkout refactor");
    assert.equal(resolveSessionReference(store, "thread_alpha", { workspaceRoot: "/workspace" }).threadId, "thread_alpha_001");
    assert.equal(resolveSessionReference(store, "parser clean", { workspaceRoot: "/workspace" }).threadId, "thread_beta_002");
    assert.throws(
      () => resolveSessionReference(store, "remote phrase", { workspaceRoot: "/workspace" }),
      /in this workspace/u,
    );
  } finally {
    store.close();
  }
});

test("ambiguous partial IDs and duplicate exact names are rejected with bounded choices", () => {
  const store = new SessionStore(":memory:");
  try {
    thread(store, "thread_feature_one", "Same name", "/workspace");
    thread(store, "thread_feature_two", "Same name", "/workspace");
    assert.throws(
      () => resolveSessionReference(store, "thread_feature", { workspaceRoot: "/workspace" }),
      (error: unknown) => error instanceof SessionResolutionError
        && error.code === "SESSION_AMBIGUOUS"
        && error.candidates.length === 2,
    );
    assert.throws(
      () => resolveSessionReference(store, "same name", { workspaceRoot: "/workspace" }),
      /is ambiguous/u,
    );
  } finally {
    store.close();
  }
});

test("failed resolution never binds a legacy session to the wrong workspace", () => {
  const store = new SessionStore(":memory:");
  try {
    store.createThread({ threadId: "legacy_unbound", name: "Legacy draft" });
    thread(store, "thread_other", "Other", "/other");
    thread(store, "thread_other_suffix", "Current collision", "/workspace");
    assert.throws(
      () => resolveSessionReference(store, "thread_other", { workspaceRoot: "/workspace" }),
      (error: unknown) => error instanceof SessionResolutionError
        && error.code === "SESSION_WORKSPACE"
        && /belongs to \/other/u.test(error.message),
    );
    assert.equal(store.getThread("legacy_unbound").workspaceRoot, undefined);
    const legacy = resolveSessionReference(store, "legacy_unbound", { workspaceRoot: "/workspace" });
    assert.equal(legacy.workspaceRoot, undefined);
    assert.equal(store.getThread("legacy_unbound").workspaceRoot, undefined);
  } finally {
    store.close();
  }
});

test("cross-workspace preflight rejects missing roots and re-evaluates trust", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-target-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, "current");
  const target = join(root, "target");
  await mkdir(current);
  await mkdir(target);
  const currentRoot = await realpath(current);
  const targetRoot = await realpath(target);
  const trust = new TrustStore(join(root, "trust.json"));
  const store = new SessionStore(":memory:");
  t.after(() => store.close());
  const saved = thread(store, "thread_target", "Target", targetRoot);

  await assert.rejects(
    resolveSessionWorkspaceTarget(saved, currentRoot, trust),
    /not currently trusted/u,
  );
  await trust.trust(targetRoot);
  assert.deepEqual(await resolveSessionWorkspaceTarget(saved, currentRoot, trust), {
    thread: saved,
    workspaceRoot: targetRoot,
    crossWorkspace: true,
  });
  await trust.untrust(targetRoot);
  await assert.rejects(
    resolveSessionWorkspaceTarget(saved, currentRoot, trust),
    /not currently trusted/u,
  );

  const missing = join(root, "missing");
  const missingThread = thread(store, "thread_missing", "Missing", missing);
  await assert.rejects(
    resolveSessionWorkspaceTarget(missingThread, currentRoot, trust),
    /missing or inaccessible/u,
  );

  const fileWorkspace = join(root, "workspace-file");
  await writeFile(fileWorkspace, "not a directory");
  const fileThread = thread(store, "thread_file", "File", fileWorkspace);
  await assert.rejects(
    resolveSessionWorkspaceTarget(fileThread, currentRoot, trust),
    /not a directory/u,
  );
});

test("runtime switch staging closes failed candidates and leaves source sessions untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, "current");
  const target = join(root, "target");
  await mkdir(current);
  await mkdir(target);
  const currentRoot = await realpath(current);
  const targetRoot = await realpath(target);
  const trust = new TrustStore(join(root, "trust.json"));
  await trust.trust(targetRoot);
  const source = new SessionStore(":memory:");
  t.after(() => source.close());
  const saved = thread(source, "thread_switch", "Switch me", targetRoot);
  let closed = 0;

  await assert.rejects(
    prepareSessionRuntimeSwitch(saved, currentRoot, trust, async () => {
      throw new Error("candidate load failed");
    }),
    /candidate load failed/u,
  );
  assert.equal(source.getThread(saved.threadId).name, "Switch me");

  await assert.rejects(
    prepareSessionRuntimeSwitch(saved, currentRoot, trust, async () => {
      const invalidStore = new SessionStore(":memory:");
      return {
        workspace: targetRoot,
        trusted: true,
        store: invalidStore,
        async close() {
          invalidStore.close();
          closed += 1;
        },
      };
    }),
    /Unknown thread/u,
  );
  assert.equal(closed, 1);
  assert.equal(source.getThread(saved.threadId).workspaceRoot, targetRoot);

  const candidateStore = new SessionStore(":memory:");
  thread(candidateStore, saved.threadId, saved.name, targetRoot);
  await trust.untrust(targetRoot);
  await assert.rejects(
    prepareSessionRuntimeSwitch(saved, currentRoot, { isTrusted: async () => true }, async () => ({
      workspace: targetRoot,
      trusted: false,
      store: candidateStore,
      async close() {
        candidateStore.close();
        closed += 1;
      },
    })),
    /became untrusted/u,
  );
  assert.equal(closed, 2);

  await trust.trust(targetRoot);
  const rollbackStore = new SessionStore(":memory:");
  thread(rollbackStore, saved.threadId, saved.name, targetRoot);
  const prepared = await prepareSessionRuntimeSwitch(saved, currentRoot, trust, async () => ({
    workspace: targetRoot,
    trusted: true,
    store: rollbackStore,
    async close() {
      rollbackStore.close();
      closed += 1;
    },
  }));
  await prepared.rollback();
  await prepared.rollback();
  assert.equal(closed, 3);
  assert.equal(source.getThread(saved.threadId).name, "Switch me");

  let trustChecks = 0;
  const raceStore = new SessionStore(":memory:");
  thread(raceStore, saved.threadId, saved.name, targetRoot);
  await assert.rejects(
    prepareSessionRuntimeSwitch(saved, currentRoot, {
      isTrusted: async () => {
        trustChecks += 1;
        return trustChecks === 1;
      },
    }, async () => ({
      workspace: targetRoot,
      trusted: true,
      store: raceStore,
      async close() {
        raceStore.close();
        closed += 1;
      },
    })),
    /became untrusted/u,
  );
  assert.equal(trustChecks, 2);
});

test("fifty staged session switches transfer or release every candidate exactly once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-switch-soak-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const current = join(root, "current");
  const target = join(root, "target");
  await mkdir(current);
  await mkdir(target);
  const currentRoot = await realpath(current);
  const targetRoot = await realpath(target);
  const savedStore = new SessionStore(":memory:");
  t.after(() => savedStore.close());
  const saved = thread(savedStore, "thread-switch-soak", "Switch soak", targetRoot);
  let opened = 0;
  let closed = 0;
  let active = 0;

  for (let iteration = 0; iteration < 50; iteration += 1) {
    const prepared = await prepareSessionRuntimeSwitch(saved, currentRoot, { isTrusted: async () => true }, async () => {
      const store = new SessionStore(":memory:");
      thread(store, saved.threadId, saved.name, targetRoot);
      opened += 1;
      active += 1;
      let released = false;
      return {
        workspace: targetRoot,
        trusted: true,
        store,
        async close() {
          if (released) return;
          released = true;
          store.close();
          active -= 1;
          closed += 1;
        },
      };
    });
    if (iteration % 2 === 0) {
      await prepared.rollback();
      await prepared.rollback();
    } else {
      const runtime = prepared.commit();
      await runtime.close();
    }
    assert.equal(active, 0);
  }

  assert.equal(opened, 50);
  assert.equal(closed, 50);
});

test("all-workspace index resolution keeps duplicate IDs ambiguous unless explicitly qualified", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-all-resolution-"));
  const index = await WorkspaceSessionIndex.open(join(root, "index.sqlite"));
  t.after(() => index.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  const records: Array<{ workspace: string; database: string }> = [];
  for (let ordinal = 0; ordinal < 2; ordinal += 1) {
    const workspace = join(root, `workspace-${ordinal}`);
    const database = join(root, `sessions-${ordinal}.sqlite`);
    await mkdir(workspace);
    const canonical = await realpath(workspace);
    const store = new SessionStore(database);
    savedIndexedThread(
      store,
      "duplicate_exact_id",
      ordinal === 0 ? "First indexed" : "Second indexed",
      canonical,
    );
    store.close();
    await index.refreshWorkspace({ workspaceRoot: canonical, databasePath: database });
    records.push({ workspace: canonical, database: await realpath(database) });
  }

  let candidates: readonly string[] = [];
  assert.throws(
    () => resolveIndexedSessionReference(index, "duplicate_exact_id"),
    (error: unknown) => {
      if (!(error instanceof SessionResolutionError) || error.code !== "SESSION_AMBIGUOUS") return false;
      candidates = error.candidates;
      return candidates.length === 2 && candidates.every((candidate) => candidate.includes("sessions-"));
    },
  );
  const selected = resolveIndexedSessionReference(index, candidates.find((candidate) => candidate.startsWith(records[1]!.database))!);
  assert.equal(selected.name, "Second indexed");
  assert.equal(indexedSessionReference(selected), `${records[1]!.database}#duplicate_exact_id`);
  assert.equal(resolveIndexedSessionReference(index, "first index").workspaceRoot, records[0]!.workspace);

  const hashWorkspace = join(root, "workspace-hash");
  const hashDatabase = join(root, "sessions#hash.sqlite");
  await mkdir(hashWorkspace);
  const canonicalHashWorkspace = await realpath(hashWorkspace);
  const hashStore = new SessionStore(hashDatabase);
  savedIndexedThread(hashStore, "thread#hash", "Encoded qualifier", canonicalHashWorkspace);
  hashStore.close();
  await index.refreshWorkspace({ workspaceRoot: canonicalHashWorkspace, databasePath: hashDatabase });
  const hashRecord = resolveIndexedSessionReference(index, "encoded qualifier");
  const hashReference = indexedSessionReference(hashRecord);
  assert.match(hashReference, /^session:/u);
  assert.equal(resolveIndexedSessionReference(index, hashReference).threadId, "thread#hash");
  assert.throws(
    () => resolveIndexedSessionReference(index, "session:not-valid-base64-json"),
    /Invalid qualified session reference/u,
  );

  const maximumEncodedReference = indexedSessionReference({
    databasePath: `/${"d".repeat(3_997)}#`,
    threadId: `${"t".repeat(3_999)}#`,
  });
  assert.ok(Buffer.byteLength(maximumEncodedReference) > 4 * 1024);
  assert.throws(
    () => resolveIndexedSessionReference(index, maximumEncodedReference),
    (error: unknown) => error instanceof SessionResolutionError
      && error.code === "SESSION_REFERENCE"
      && !/exceeds/u.test(error.message),
  );
});

test("indexed runtime staging verifies trust and exact database before ownership transfer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "harness-session-index-stage-"));
  const current = join(root, "current");
  const target = join(root, "target");
  const database = join(root, "target.sqlite");
  await mkdir(current);
  await mkdir(target);
  const currentRoot = await realpath(current);
  const targetRoot = await realpath(target);
  const store = new SessionStore(database);
  savedIndexedThread(store, "thread_index_target", "Indexed target", targetRoot);
  store.close();
  const index = await WorkspaceSessionIndex.open(join(root, "index.sqlite"));
  t.after(() => index.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  await index.refreshWorkspace({ workspaceRoot: targetRoot, databasePath: database });
  const record = resolveIndexedSessionReference(index, "thread_index_target");
  let closed = 0;

  await assert.rejects(
    prepareIndexedSessionRuntimeSwitch(record, currentRoot, index, { isTrusted: async () => false }, async () => {
      assert.fail("untrusted targets must fail before runtime loading");
    }),
    /not currently trusted/u,
  );

  const wrongStore = new SessionStore(database);
  await assert.rejects(
    prepareIndexedSessionRuntimeSwitch(record, currentRoot, index, { isTrusted: async () => true }, async () => ({
      workspace: targetRoot,
      databasePath: join(root, "wrong.sqlite"),
      trusted: true,
      store: wrongStore,
      async close() {
        wrongStore.close();
        closed += 1;
      },
    })),
    /wrong session database/u,
  );
  assert.equal(closed, 1);

  const candidateStore = new SessionStore(database);
  let checks = 0;
  await assert.rejects(
    prepareIndexedSessionRuntimeSwitch(record, currentRoot, index, {
      isTrusted: async () => {
        checks += 1;
        return checks === 1;
      },
    }, async () => ({
      workspace: targetRoot,
      databasePath: await realpath(database),
      trusted: true,
      store: candidateStore,
      async close() {
        candidateStore.close();
        closed += 1;
      },
    })),
    /became untrusted/u,
  );
  assert.equal(checks, 2);
  assert.equal(closed, 2);

  const localStore = new SessionStore(database);
  const localPrepared = await prepareIndexedSessionRuntimeSwitch(
    record,
    targetRoot,
    index,
    { isTrusted: async () => false },
    async () => ({
      workspace: targetRoot,
      databasePath: await realpath(database),
      trusted: false,
      store: localStore,
      async close() {
        localStore.close();
        closed += 1;
      },
    }),
  );
  await localPrepared.rollback();
  assert.equal(closed, 3);
});
