import assert from "node:assert/strict";
import test from "node:test";

import { ToolAuthorizationQueue } from "../../src/service/tool-authorization-queue.js";

async function within<T>(operation: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for authorization queue")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("cancelling a queued authorization does not wait for or release its active predecessor", async (context) => {
  const queue = new ToolAuthorizationQueue();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolveFirst) => { releaseFirst = resolveFirst; });
  context.after(() => releaseFirst());
  let reportFirst!: () => void;
  const firstStarted = new Promise<void>((resolveFirst) => { reportFirst = resolveFirst; });
  const first = queue.run(new AbortController().signal, async () => {
    reportFirst();
    await firstGate;
    return "first";
  });
  await firstStarted;

  const queuedController = new AbortController();
  let queuedStarted = false;
  const queued = queue.run(queuedController.signal, () => {
    queuedStarted = true;
    return "queued";
  });
  queuedController.abort(new Error("queued authorization cancelled"));

  await within(assert.rejects(queued, /queued authorization cancelled/u));
  assert.equal(queuedStarted, false);

  let thirdStarted = false;
  const third = queue.run(new AbortController().signal, () => {
    thirdStarted = true;
    return "third";
  });
  await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
  assert.equal(thirdStarted, false, "cancelling the queued request must not release the active request");
  releaseFirst();

  assert.equal(await within(first), "first");
  assert.equal(await within(third), "third");
});

test("cancelling an active non-cooperative authorization cannot poison later decisions", async (context) => {
  const queue = new ToolAuthorizationQueue();
  const activeController = new AbortController();
  let releaseStale!: () => void;
  const staleGate = new Promise<void>((resolveStale) => { releaseStale = resolveStale; });
  context.after(() => releaseStale());
  let reportActive!: () => void;
  const activeStarted = new Promise<void>((resolveActive) => { reportActive = resolveActive; });
  const active = queue.run(activeController.signal, async () => {
    reportActive();
    await staleGate;
    return "stale decision";
  });
  await activeStarted;
  activeController.abort(new Error("active authorization cancelled"));

  await within(assert.rejects(active, /active authorization cancelled/u));
  const next = queue.run(new AbortController().signal, () => "fresh decision");
  assert.equal(await within(next), "fresh decision");

  releaseStale();
});
