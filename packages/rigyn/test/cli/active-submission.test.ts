import assert from "node:assert/strict";
import test from "node:test";

import {
  BoundedDeferredSubmissionQueue,
  classifyActiveSubmission,
  deliverActiveSubmission,
} from "../../src/cli/active-submission.js";

test("active submissions execute every built-in command without entering the deferred lane", () => {
  const removedCommand = ["/re", "load"].join("");
  assert.deepEqual(classifyActiveSubmission(" /cancel "), { kind: "cancel" });
  assert.deepEqual(classifyActiveSubmission("/follow next step"), { kind: "follow_up", text: "next step" });
  assert.deepEqual(classifyActiveSubmission("/follow"), { kind: "follow_up", text: "" });
  assert.deepEqual(classifyActiveSubmission("/settings"), {
    kind: "command",
    text: "/settings",
    interrupt: false,
  });
  assert.deepEqual(classifyActiveSubmission("/model gpt-5"), {
    kind: "command",
    text: "/model gpt-5",
    interrupt: false,
  });
  assert.deepEqual(classifyActiveSubmission("/refresh"), {
    kind: "command",
    text: "/refresh",
    interrupt: true,
  });
  assert.deepEqual(classifyActiveSubmission("/new"), {
    kind: "command",
    text: "/new",
    interrupt: true,
  });
  assert.deepEqual(classifyActiveSubmission("/tree"), {
    kind: "command",
    text: "/tree",
    interrupt: false,
  });
  assert.deepEqual(classifyActiveSubmission("/models provider/model"), {
    kind: "command",
    text: "/models provider/model",
    interrupt: false,
  });
  assert.deepEqual(classifyActiveSubmission("/clear"), {
    kind: "command",
    text: "/clear",
    interrupt: true,
  });
  assert.deepEqual(classifyActiveSubmission(removedCommand), { kind: "unknown", command: "reload" });

  assert.deepEqual(classifyActiveSubmission("/extension arg", { resourceCommand: true }), {
    kind: "resource",
    text: "/extension arg",
  });
  assert.deepEqual(classifyActiveSubmission("/unknown"), { kind: "unknown", command: "unknown" });
  for (const text of ["!git status", "!!secret"]) assert.deepEqual(classifyActiveSubmission(text), { kind: "defer", text });

  assert.deepEqual(classifyActiveSubmission("please inspect /tmp"), { kind: "steer", text: "please inspect /tmp" });
  assert.deepEqual(classifyActiveSubmission("cancel"), { kind: "steer", text: "cancel" });
  assert.deepEqual(classifyActiveSubmission("/cancel later"), { kind: "defer", text: "/cancel later" });
});

test("active delivery waits for steering and follow-up admission failures", async () => {
  const calls: string[] = [];
  const session = {
    async steer(text: string): Promise<void> {
      calls.push(`steer:${text}`);
      throw new Error("steering queue is closed");
    },
    async followUp(text: string): Promise<void> {
      calls.push(`follow:${text}`);
      throw new Error("follow-up queue is closed");
    },
  };

  await assert.rejects(
    deliverActiveSubmission(session, { kind: "steer", text: "now" }, []),
    /steering queue is closed/u,
  );
  await assert.rejects(
    deliverActiveSubmission(session, { kind: "follow_up", text: "later" }, []),
    /follow-up queue is closed/u,
  );
  assert.deepEqual(calls, ["steer:now", "follow:later"]);
});

test("deferred submissions are byte-bounded and retain FIFO image ownership", () => {
  const queue = new BoundedDeferredSubmissionQueue<{ id: string; bytes: number }>((image) => image.bytes, {
    maxItems: 2,
    maxBytes: 20,
  });
  const firstImages = [{ id: "one", bytes: 3 }];
  assert.deepEqual(queue.enqueue("first", firstImages), { accepted: true, size: 1, bytes: 8 });
  firstImages.push({ id: "mutated", bytes: 1 });
  assert.deepEqual(queue.enqueue("second", [{ id: "two", bytes: 2 }]), { accepted: true, size: 2, bytes: 16 });
  assert.deepEqual(queue.enqueue("third", []), { accepted: false, reason: "items" });
  assert.deepEqual(queue.shift(), { text: "first", images: [{ id: "one", bytes: 3 }] });
  assert.equal(queue.bytes, 8);
  assert.deepEqual(queue.enqueue("012345678901234567890", []), { accepted: false, reason: "bytes" });
  assert.deepEqual(queue.shift(), { text: "second", images: [{ id: "two", bytes: 2 }] });
  assert.equal(queue.size, 0);
  assert.equal(queue.bytes, 0);
});

test("late completion handoffs retain original submission order", () => {
  const queue = new BoundedDeferredSubmissionQueue<never>(() => 0);
  queue.enqueue("submitted second", [], 2);
  queue.enqueue("submitted first but reduced late", [], 1);
  assert.equal(queue.shift()?.text, "submitted first but reduced late");
  assert.equal(queue.shift()?.text, "submitted second");
});
