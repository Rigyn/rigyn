import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";

import { ProviderRegistry } from "../../src/providers/registry.js";
import { HarnessService } from "../../src/service/harness.js";
import { SessionStore } from "../../src/storage/store.js";
import { createScriptedProvider } from "../../src/testing/scripted-provider.js";

const workspace = join(tmpdir(), "rigyn-runtime-owner-workspace");

function fixture(): { path: string; root: string; remove(): void } {
  const root = mkdtempSync(join(tmpdir(), "rigyn-runtime-owner-"));
  return {
    path: join(root, "sessions.sqlite"),
    root,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

function mutableClock(initial = "2026-07-16T00:00:00.000Z"): {
  now(): Date;
  advance(milliseconds: number): void;
} {
  let value = new Date(initial).getTime();
  return {
    now: () => new Date(value),
    advance: (milliseconds) => { value += milliseconds; },
  };
}

test("two live owners cannot recover or mutate each other's active run and queued input", () => {
  const files = fixture();
  const clock = mutableClock();
  const left = new SessionStore(files.path, { clock: clock.now, runtimeOwnerLeaseMs: 1_000 });
  const right = new SessionStore(files.path, { clock: clock.now, runtimeOwnerLeaseMs: 1_000 });
  try {
    const leftOwner = left.acquireRuntimeOwner();
    const rightOwner = right.acquireRuntimeOwner();
    assert.match(leftOwner.ownerId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u);
    assert.notEqual(leftOwner.ownerId, rightOwner.ownerId);
    assert.equal(leftOwner.pid, process.pid);

    left.createThread({ threadId: "thread_live_owner", workspaceRoot: workspace });
    const run = left.startRun({ threadId: "thread_live_owner", runId: "run_live_owner" });
    const queued = left.enqueueRunInput({
      threadId: run.threadId,
      branch: run.branch,
      mode: "steer",
      text: "live attachment",
      images: [{ type: "image", mediaType: "image/png", data: "aGVsbG8=" }],
    });

    assert.deepEqual(right.recoverAbandonedRuns(workspace).recoveredRunIds, []);
    assert.deepEqual(right.recoverRunInputs(workspace), { recovered: 0, reconciled: 0, quarantined: 0 });
    assert.equal(left.getRun(run.runId).state, "preparing");
    assert.equal(left.listRunInputs(run.threadId, run.branch)[0]?.queueId, queued.queueId);
    assert.throws(
      () => right.appendEvent({
        threadId: run.threadId,
        branch: run.branch,
        runId: run.runId,
        event: { type: "run_state", state: "streaming" },
      }),
      /another runtime owner generation/u,
    );
    assert.throws(
      () => right.putArtifact({
        threadId: run.threadId,
        runId: run.runId,
        mediaType: "text/plain",
        content: Buffer.from("foreign artifact", "utf8"),
      }),
      /another runtime owner generation/u,
    );
  } finally {
    right.close();
    left.close();
    files.remove();
  }
});

test("an expired owner can renew when no recovery transaction took ownership", () => {
  const files = fixture();
  const clock = mutableClock();
  const store = new SessionStore(files.path, { clock: clock.now, runtimeOwnerLeaseMs: 1_000 });
  try {
    const owner = store.acquireRuntimeOwner();
    store.createThread({ threadId: "thread_late_renewal", workspaceRoot: workspace });
    const run = store.startRun({ threadId: "thread_late_renewal", runId: "run_late_renewal" });

    clock.advance(1_001);
    const renewed = store.heartbeatRuntimeOwner();

    assert.equal(renewed.ownerId, owner.ownerId);
    assert.equal(renewed.generation, owner.generation);
    store.appendEvent({
      threadId: run.threadId,
      branch: run.branch,
      runId: run.runId,
      event: { type: "run_state", state: "streaming" },
    });
    assert.equal(store.getRun(run.runId).state, "streaming");
  } finally {
    store.close();
    files.remove();
  }
});

test("an expired owner is recovered once and stale run and queue mutations stay fenced", () => {
  const files = fixture();
  const clock = mutableClock();
  const stale = new SessionStore(files.path, { clock: clock.now, runtimeOwnerLeaseMs: 1_000 });
  let recovering: SessionStore | undefined;
  try {
    const staleOwner = stale.acquireRuntimeOwner();
    stale.createThread({ threadId: "thread_expired_owner", workspaceRoot: workspace });
    const run = stale.startRun({ threadId: "thread_expired_owner", runId: "run_expired_owner" });
    const queued = stale.enqueueRunInput({
      threadId: run.threadId,
      branch: run.branch,
      mode: "follow_up",
      text: "preserve this image",
      images: [{ type: "image", mediaType: "image/png", data: "aGVsbG8=" }],
    });

    clock.advance(1_001);
    recovering = new SessionStore(files.path, { clock: clock.now, runtimeOwnerLeaseMs: 1_000 });
    recovering.acquireRuntimeOwner();

    assert.deepEqual(recovering.recoverAbandonedRuns(workspace).recoveredRunIds, [run.runId]);
    assert.deepEqual(recovering.recoverRunInputs(workspace), { recovered: 1, reconciled: 0, quarantined: 0 });
    assert.equal(recovering.getRun(run.runId).state, "failed");
    assert.equal(stale.database.prepare(`
      SELECT state FROM runtime_owners WHERE owner_id = ?
    `).get(staleOwner.ownerId)?.state, "closed");
    assert.deepEqual(recovering.listRunInputs(run.threadId, run.branch, ["recoverable"]).map((entry) => ({
      queueId: entry.queueId,
      text: entry.text,
      images: entry.images,
    })), [{
      queueId: queued.queueId,
      text: "preserve this image",
      images: [{ type: "image", mediaType: "image/png", data: "aGVsbG8=" }],
    }]);

    assert.deepEqual(recovering.recoverAbandonedRuns(workspace).recoveredRunIds, []);
    assert.deepEqual(recovering.recoverRunInputs(workspace), { recovered: 0, reconciled: 0, quarantined: 0 });
    assert.throws(() => stale.heartbeatRuntimeOwner(), /expired, closed, or was superseded/u);
    assert.throws(
      () => stale.appendEvent({
        threadId: run.threadId,
        branch: run.branch,
        runId: run.runId,
        event: { type: "run_state", state: "streaming" },
      }),
      /lease expired, closed, or was superseded/u,
    );
    assert.throws(
      () => stale.beginRunInputDelivery(queued.queueId, run.threadId, run.branch),
      /lease expired, closed, or was superseded/u,
    );
  } finally {
    recovering?.close();
    stale.close();
    files.remove();
  }
});

test("a failed repeated initialization does not release the service's live owner", async () => {
  const files = fixture();
  const serviceWorkspace = join(files.root, "workspace");
  mkdirSync(serviceWorkspace);
  const store = new SessionStore(files.path);
  const service = new HarnessService({
    store,
    workspace: serviceWorkspace,
    providers: new ProviderRegistry(),
  });
  try {
    await service.initialize({ skills: [] });
    const owner = store.currentRuntimeOwner();
    assert.ok(owner);
    rmSync(serviceWorkspace, { recursive: true, force: true });

    await assert.rejects(service.initialize({ skills: [] }));

    const renewed = store.heartbeatRuntimeOwner();
    assert.equal(renewed.ownerId, owner.ownerId);
    assert.equal(renewed.generation, owner.generation);
  } finally {
    await service.close().catch(() => undefined);
    store.close();
    files.remove();
  }
});

test("an owner acquisition failure does not leave initialization latched", async () => {
  const files = fixture();
  const store = new SessionStore(files.path);
  const service = new HarnessService({
    store,
    workspace: files.root,
    providers: new ProviderRegistry(),
  });
  store.close();
  try {
    await assert.rejects(service.initialize({ skills: [] }), /Session store is closed/u);
    await assert.rejects(service.initialize({ skills: [] }), /Session store is closed/u);
  } finally {
    await service.close().catch(() => undefined);
    files.remove();
  }
});

test("a heartbeat ownership loss closes the service and close still releases local ownership", async () => {
  const files = fixture();
  const store = new SessionStore(files.path, { runtimeOwnerLeaseMs: 30 });
  const provider = createScriptedProvider({
    id: "owner-loss",
    models: [{ id: "owner-loss-model" }],
    defaultFragmentCharacters: 1_024,
    scripts: [{
      kind: "turn",
      eventDelayMs: 60_000,
      content: [{ type: "text", text: "must be cancelled" }],
    }],
  });
  const service = new HarnessService({
    store,
    workspace: files.root,
    providers: new ProviderRegistry([provider]),
  });
  try {
    await service.initialize({ skills: [] });
    const owner = store.currentRuntimeOwner();
    assert.ok(owner);
    const running = service.run({
      prompt: "wait for ownership loss",
      provider: provider.id,
      model: "owner-loss-model",
      noBuiltinTools: true,
    });
    const settled = running.then(() => "fulfilled" as const, () => "rejected" as const);
    const startDeadline = Date.now() + 1_000;
    while (provider.callCount === 0) {
      if (Date.now() >= startDeadline) assert.fail("scripted provider run did not start");
      await wait(5);
    }
    store.database.prepare(`
      UPDATE runtime_owners SET generation = generation + 1 WHERE owner_id = ?
    `).run(owner.ownerId);

    const deadline = Date.now() + 1_000;
    while (true) {
      try {
        await service.resourceCatalog();
      } catch (error) {
        assert.match(error instanceof Error ? error.message : String(error), /Harness service is closed/u);
        break;
      }
      if (Date.now() >= deadline) assert.fail("runtime owner heartbeat did not close the fenced service");
      await wait(5);
    }

    const settlement = await Promise.race([
      settled,
      wait(1_000).then(() => "timed_out" as const),
    ]);
    assert.notEqual(settlement, "timed_out");

    await service.close();
    assert.equal(store.currentRuntimeOwner(), undefined);
  } finally {
    await service.close().catch(() => undefined);
    store.close();
    files.remove();
  }
});

test("generation fencing does not depend on the diagnostic PID", () => {
  const files = fixture();
  const clock = mutableClock();
  const store = new SessionStore(files.path, { clock: clock.now, runtimeOwnerLeaseMs: 1_000 });
  try {
    const owner = store.acquireRuntimeOwner();
    store.createThread({ threadId: "thread_generation", workspaceRoot: workspace });
    const run = store.startRun({ threadId: "thread_generation", runId: "run_generation" });
    store.database.prepare(`
      UPDATE runtime_owners SET generation = generation + 1 WHERE owner_id = ?
    `).run(owner.ownerId);
    const row = store.database.prepare(`
      SELECT pid, generation FROM runtime_owners WHERE owner_id = ?
    `).get(owner.ownerId) as { pid: number; generation: number };
    assert.equal(row.pid, process.pid);
    assert.equal(row.generation, owner.generation + 1);
    assert.throws(
      () => store.appendEvent({
        threadId: run.threadId,
        branch: run.branch,
        runId: run.runId,
        event: { type: "run_state", state: "streaming" },
      }),
      /lease expired, closed, or was superseded/u,
    );
  } finally {
    store.close();
    files.remove();
  }
});

test("only one live owner can claim and acknowledge a recovered queue item", () => {
  const files = fixture();
  const clock = mutableClock();
  const stale = new SessionStore(files.path, { clock: clock.now, runtimeOwnerLeaseMs: 1_000 });
  let left: SessionStore | undefined;
  let right: SessionStore | undefined;
  try {
    stale.acquireRuntimeOwner();
    stale.createThread({ threadId: "thread_queue_claim", workspaceRoot: workspace });
    const queued = stale.enqueueRunInput({
      threadId: "thread_queue_claim",
      branch: "main",
      mode: "steer",
      text: "claim exactly once",
    });
    clock.advance(1_001);
    left = new SessionStore(files.path, { clock: clock.now, runtimeOwnerLeaseMs: 1_000 });
    right = new SessionStore(files.path, { clock: clock.now, runtimeOwnerLeaseMs: 1_000 });
    left.acquireRuntimeOwner();
    right.acquireRuntimeOwner();
    assert.deepEqual(left.recoverRunInputs(workspace), { recovered: 1, reconciled: 0, quarantined: 0 });

    left.leaseRunInput(queued.queueId, queued.threadId, queued.branch);
    assert.throws(
      () => right!.acknowledgeRunInputLease(queued.queueId, queued.threadId, queued.branch),
      /another runtime owner generation/u,
    );
    left.acknowledgeRunInputLease(queued.queueId, queued.threadId, queued.branch);
    assert.equal(left.listRunInputs(queued.threadId, queued.branch).length, 0);
  } finally {
    right?.close();
    left?.close();
    stale.close();
    files.remove();
  }
});

test("HarnessService owns the store during its lifetime and clean close marks the owner closed", async () => {
  const files = fixture();
  const store = new SessionStore(files.path);
  const service = new HarnessService({
    store,
    workspace: files.root,
    providers: new ProviderRegistry(),
  });
  try {
    await service.initialize({ skills: [] });
    const owner = store.currentRuntimeOwner();
    assert.ok(owner);
    assert.equal(store.database.prepare(`
      SELECT state FROM runtime_owners WHERE owner_id = ? AND generation = ?
    `).get(owner.ownerId, owner.generation)?.state, "active");

    await service.close();
    assert.equal(store.database.prepare(`
      SELECT state FROM runtime_owners WHERE owner_id = ? AND generation = ?
    `).get(owner.ownerId, owner.generation)?.state, "closed");
  } finally {
    await service.close().catch(() => undefined);
    store.close();
    files.remove();
  }
});

test("SessionStore close releases an acquired owner before closing SQLite", () => {
  const files = fixture();
  const store = new SessionStore(files.path);
  const owner = store.acquireRuntimeOwner();
  store.close();

  const database = new DatabaseSync(files.path);
  try {
    const row = database.prepare(`
      SELECT state, pid FROM runtime_owners WHERE owner_id = ? AND generation = ?
    `).get(owner.ownerId, owner.generation) as { state: string; pid: number };
    assert.equal(row.state, "closed");
    assert.equal(row.pid, process.pid);
  } finally {
    database.close();
    files.remove();
  }
});
