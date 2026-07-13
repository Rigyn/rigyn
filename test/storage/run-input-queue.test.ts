import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CanonicalMessage, ImageBlock } from "../../src/core/types.js";
import { SessionStore } from "../../src/storage/index.js";

const workspace = join(tmpdir(), "rigyn-queue-workspace");
const image: ImageBlock = { type: "image", mediaType: "image/png", data: "aGVsbG8=" };

function temporaryDatabase(): { path: string; remove(): void } {
  const directory = mkdtempSync(join(tmpdir(), "harness-run-input-queue-"));
  return {
    path: join(directory, "sessions.sqlite"),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function userMessage(id: string, text: string): CanonicalMessage {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    createdAt: "2026-07-10T00:00:00.000Z",
  };
}

test("SIGKILL after an explicit restore lease recovers the exact unsent item without replay", async () => {
  const fixture = temporaryDatabase();
  try {
    const source = `
      import { SessionStore } from "./src/storage/store.ts";
      const store = new SessionStore(${JSON.stringify(fixture.path)});
      store.createThread({ threadId: "thread_sigkill", workspaceRoot: ${JSON.stringify(workspace)} });
      const queued = store.enqueueRunInput({
        threadId: "thread_sigkill", branch: "main", mode: "steer", text: "survive literal SIGKILL",
        images: [{ type: "image", mediaType: "image/png", data: "aGVsbG8=" }],
      });
      store.markRunInputRecoverable(queued.queueId, queued.threadId, queued.branch);
      store.leaseRunInput(queued.queueId, queued.threadId, queued.branch);
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`child did not persist queue: ${errors}`)), 10_000);
      const poll = (): void => {
        if (output.includes("ready")) {
          clearTimeout(timeout);
          resolve();
          return;
        }
        if (child.exitCode !== null) {
          clearTimeout(timeout);
          reject(new Error(`child exited before ready (${child.exitCode}): ${errors}`));
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    child.kill("SIGKILL");
    await exited;

    const store = new SessionStore(fixture.path);
    assert.deepEqual(store.recoverRunInputs(workspace), { recovered: 1, reconciled: 0, quarantined: 0 });
    assert.deepEqual(store.listRunInputs("thread_sigkill", "main", ["recoverable"]).map((entry) => ({
      mode: entry.mode,
      text: entry.text,
      images: entry.images,
    })), [{
      mode: "steer",
      text: "survive literal SIGKILL",
      images: [{ type: "image", mediaType: "image/png", data: "aGVsbG8=" }],
    }]);
    assert.equal(store.listEvents("thread_sigkill").some((entry) => entry.event.type === "message_appended"), false);
    store.close();
  } finally {
    fixture.remove();
  }
});

test("queue ordering and aggregate limits are atomic across store connections and isolated by branch", async () => {
  const fixture = temporaryDatabase();
  try {
    const left = new SessionStore(fixture.path);
    left.createThread({ threadId: "thread_concurrent", workspaceRoot: workspace });
    left.forkBranch({ threadId: "thread_concurrent", newBranch: "other" });
    const right = new SessionStore(fixture.path);

    await Promise.all(Array.from({ length: 40 }, (_, index) => new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        try {
          (index % 2 === 0 ? left : right).enqueueRunInput({
            threadId: "thread_concurrent",
            branch: "main",
            mode: index % 3 === 0 ? "steer" : "follow_up",
            text: `item-${index}`,
          });
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    })));
    left.enqueueRunInput({
      threadId: "thread_concurrent",
      branch: "other",
      mode: "steer",
      text: "other-only",
      images: [image],
    });

    const main = right.listRunInputs("thread_concurrent", "main");
    assert.equal(main.length, 40);
    assert.equal(new Set(main.map((entry) => entry.text)).size, 40);
    assert.deepEqual(main.map((entry) => entry.sequence), [...main.map((entry) => entry.sequence)].sort((a, b) => a - b));
    assert.deepEqual(left.listRunInputs("thread_concurrent", "other").map((entry) => entry.text), ["other-only"]);
    assert.throws(() => left.listRunInputs("thread_concurrent", "missing"), /Unknown branch/u);

    for (let index = 40; index < 100; index += 1) {
      left.enqueueRunInput({
        threadId: "thread_concurrent",
        branch: "main",
        mode: "follow_up",
        text: `item-${index}`,
      });
    }
    assert.throws(() => right.enqueueRunInput({
      threadId: "thread_concurrent",
      branch: "main",
      mode: "steer",
      text: "one-too-many",
    }), /exceeds 100 messages/u);
    assert.equal(right.listRunInputs("thread_concurrent", "main").length, 100);
    right.close();
    left.close();
  } finally {
    fixture.remove();
  }
});

test("delivery crash boundaries recover only truly undelivered rows", async () => {
  const fixture = temporaryDatabase();
  try {
    let store = new SessionStore(fixture.path);
    store.createThread({ threadId: "thread_boundaries", workspaceRoot: workspace });

    const beforeAcceptance = store.enqueueRunInput({
      threadId: "thread_boundaries",
      branch: "main",
      mode: "steer",
      text: "committed before manager acceptance",
    });
    store.markRunInputRecoverable(beforeAcceptance.queueId, beforeAcceptance.threadId, beforeAcceptance.branch);

    const beforeAppend = store.enqueueRunInput({
      threadId: "thread_boundaries",
      branch: "main",
      mode: "follow_up",
      text: "draining before append",
    });
    store.beginRunInputDelivery(beforeAppend.queueId, beforeAppend.threadId, beforeAppend.branch);
    store.close();

    store = new SessionStore(fixture.path);
    assert.deepEqual(store.recoverRunInputs(workspace), { recovered: 1, reconciled: 0, quarantined: 0 });
    assert.deepEqual(
      store.listRunInputs("thread_boundaries", "main", ["recoverable"]).map((entry) => entry.text),
      ["committed before manager acceptance", "draining before append"],
    );

    const afterAppend = store.enqueueRunInput({
      threadId: "thread_boundaries",
      branch: "main",
      mode: "steer",
      text: "append committed before delete",
    });
    store.beginRunInputDelivery(afterAppend.queueId, afterAppend.threadId, afterAppend.branch);
    store.appendEvent({
      threadId: afterAppend.threadId,
      branch: afterAppend.branch,
      event: { type: "message_appended", message: userMessage(afterAppend.messageId, afterAppend.text) },
    });
    assert.equal(store.markRunInputsRecoverable(afterAppend.threadId, afterAppend.branch), 0);
    assert.equal(store.listRunInputs(afterAppend.threadId, afterAppend.branch).some((entry) => entry.queueId === afterAppend.queueId), false);

    const interrupted = store.enqueueRunInput({
      threadId: "thread_boundaries",
      branch: "main",
      mode: "follow_up",
      text: "persisted user turn",
    });
    store.beginRunInputDelivery(interrupted.queueId, interrupted.threadId, interrupted.branch);
    const sink = store.createEventSink({ threadId: interrupted.threadId, branch: interrupted.branch, runId: "run_interrupted_queue" });
    await sink.emit({ type: "run_started", provider: "offline", model: "model" });
    await sink.emit({ type: "message_appended", message: userMessage(interrupted.messageId, interrupted.text) });
    store.completeRunInputDelivery(interrupted.queueId, interrupted.threadId, interrupted.branch);
    store.close();

    store = new SessionStore(fixture.path);
    store.recoverAbandonedRuns();
    store.recoverRunInputs(workspace);
    const delivered = store.listEvents("thread_boundaries").filter((entry) =>
      entry.event.type === "message_appended" && entry.event.message.id === interrupted.messageId);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.event.type === "message_appended" && delivered[0].event.message.role, "user");
    assert.equal(store.listRunInputs("thread_boundaries", "main").some((entry) => entry.queueId === interrupted.queueId), false);
    assert.equal(store.getRun("run_interrupted_queue").state, "failed");
    store.close();
  } finally {
    fixture.remove();
  }
});

test("canonical images round-trip and malformed durable rows are quarantined without blocking later input", () => {
  const fixture = temporaryDatabase();
  try {
    const store = new SessionStore(fixture.path);
    store.createThread({ threadId: "thread_corrupt_queue", workspaceRoot: workspace });
    const corruptPayloads = [
      [{ type: "image", mediaType: 7, data: "aGVsbG8=" }],
      [{ type: "image", mediaType: "not-an-image", data: "aGVsbG8=" }],
      [{ type: "image", mediaType: "image/png", data: "%%%%" }],
      [{ type: "image", mediaType: "image/png", url: "relative/image.png" }],
      [{ type: "image", mediaType: "image/png", url: "https://example.test/im\nage.png" }],
      [{ type: "image", mediaType: "image/png", url: "https:///missing-host.png" }],
      [{ type: "image", mediaType: "image/png", url: "data:image/jpeg;base64,aGVsbG8=" }],
    ];
    const corruptIds: string[] = [];
    for (const [index, payload] of corruptPayloads.entries()) {
      const corrupt = store.enqueueRunInput({
        threadId: "thread_corrupt_queue",
        branch: "main",
        mode: "steer",
        text: `bad image ${index}`,
        images: [image],
      });
      corruptIds.push(corrupt.queueId);
      store.database.prepare("UPDATE run_input_queue SET images_json = ? WHERE queue_id = ?")
        .run(JSON.stringify(payload), corrupt.queueId);
    }
    const valid = store.enqueueRunInput({
      threadId: "thread_corrupt_queue",
      branch: "main",
      mode: "follow_up",
      text: "valid image",
      images: [image],
    });
    const validUrl = store.enqueueRunInput({
      threadId: "thread_corrupt_queue",
      branch: "main",
      mode: "follow_up",
      text: "valid provider URL scheme",
      images: [{ type: "image", mediaType: "image/png", url: "gs://bucket/image.png" }],
    });

    assert.deepEqual(store.listRunInputs("thread_corrupt_queue", "main"), [valid, validUrl]);
    assert.equal(store.quarantinedRunInputCount("thread_corrupt_queue", "main"), corruptPayloads.length);
    for (const queueId of corruptIds) {
      assert.equal(store.database.prepare("SELECT state FROM run_input_queue WHERE queue_id = ?").get(queueId)?.state, "quarantined");
    }
    store.assertIntegrity();
    store.close();
  } finally {
    fixture.remove();
  }
});
