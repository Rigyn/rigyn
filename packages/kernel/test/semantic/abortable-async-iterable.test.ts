import assert from "node:assert/strict";
import test from "node:test";
import { abortableAsyncIterable } from "../../src/runtime/core/abortable-async-iterable.js";

test("prebuffered provider events yield to queued terminal input before draining", async () => {
  const source = {
    async *[Symbol.asyncIterator](): AsyncGenerator<number, void, void> {
      for (let index = 0; index < 128; index += 1) yield index;
    },
  };
  let inputReady = false;
  setImmediate(() => { inputReady = true; });

  let eventsBeforeInput = 0;
  for await (const _event of abortableAsyncIterable(source, new AbortController().signal)) {
    if (!inputReady) eventsBeforeInput += 1;
  }

  assert.ok(inputReady, "queued terminal input must run before the provider buffer drains");
  assert.ok(eventsBeforeInput <= 32, `terminal input waited behind ${eventsBeforeInput} provider events`);
});

test("slow provider consumers yield to queued terminal input before the event batch fills", async () => {
  const source = {
    async *[Symbol.asyncIterator](): AsyncGenerator<number, void, void> {
      for (let index = 0; index < 128; index += 1) yield index;
    },
  };
  let inputReady = false;
  setImmediate(() => { inputReady = true; });

  let eventsBeforeInput = 0;
  for await (const _event of abortableAsyncIterable(source, new AbortController().signal)) {
    if (!inputReady) eventsBeforeInput += 1;
    const workDeadline = performance.now() + 1;
    while (performance.now() < workDeadline) {
      // Model a slow event consumer without yielding the JavaScript turn.
    }
    if (inputReady) break;
  }

  assert.ok(inputReady, "queued terminal input must run before the provider batch fills");
  assert.ok(eventsBeforeInput < 32, `terminal input waited behind ${eventsBeforeInput} slow provider events`);
});

test("a queued abort stops a prebuffered provider stream and closes its iterator", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled from terminal input");
  let returned = 0;
  let nextValue = 0;
  const source: AsyncIterable<number> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: false as const, value: nextValue++ }),
        return: async () => {
          returned += 1;
          return { done: true as const, value: undefined };
        },
      };
    },
  };
  setImmediate(() => controller.abort(reason));

  let emitted = 0;
  await assert.rejects(async () => {
    for await (const _event of abortableAsyncIterable(source, controller.signal)) emitted += 1;
  }, (cause) => cause === reason);

  assert.ok(emitted <= 32, `abort waited behind ${emitted} provider events`);
  assert.equal(returned, 1);
});
