import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantMessageEventStream,
  EventStream,
  calculateContextTokens,
  createAssistantMessageEventStream,
  emptyUsage,
  lazyStream,
  streamFromEvents,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "../src/index.ts";

test("context-token helpers omit unsafe or fractional telemetry", () => {
  assert.equal(calculateContextTokens({ totalTokens: Number.POSITIVE_INFINITY, output: 0 }), undefined);
  assert.equal(calculateContextTokens({ totalTokens: 1.5, output: 0 }), undefined);
  assert.equal(calculateContextTokens({ input: Number.MAX_SAFE_INTEGER, cacheRead: 1, cacheWrite: 0 }), undefined);
  assert.equal(calculateContextTokens({ totalTokens: 12, output: 2 }), 10);
});

function assistant(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "faux",
    provider: "test",
    model: "stream",
    usage: emptyUsage(),
    stopReason,
    timestamp: 1,
  };
}

function startEvent(): AssistantMessageEvent {
  return { type: "start", partial: assistant("pending") };
}

function doneEvent(message = assistant()): AssistantMessageEvent {
  return { type: "done", reason: "stop", message };
}

async function eventsOf<TEvent>(source: AsyncIterable<TEvent>): Promise<TEvent[]> {
  const events: TEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

test("EventStream preserves falsy values and closes after delivering its terminal event", async () => {
  type Value = false | "" | 0 | null | undefined;
  const stream = new EventStream<Value, undefined>((event) => event === undefined, () => undefined);
  stream.push(false);
  stream.push("");
  stream.push(0);
  stream.push(null);
  stream.push(undefined);
  stream.push(false);

  assert.deepEqual(await eventsOf(stream), [false, "", 0, null, undefined]);
  assert.equal(await stream.result(), undefined);
});

test("EventStream serves concurrent pending reads in emission order", async () => {
  const stream = new EventStream<{ terminal: boolean; value: number }, number>(
    (event) => event.terminal,
    (event) => event.value,
  );
  const iterator = stream[Symbol.asyncIterator]();
  const first = iterator.next();
  const second = iterator.next();

  stream.push({ terminal: false, value: 1 });
  stream.push({ terminal: true, value: 2 });

  assert.deepEqual(await first, { done: false, value: { terminal: false, value: 1 } });
  assert.deepEqual(await second, { done: false, value: { terminal: true, value: 2 } });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  assert.equal(await stream.result(), 2);
});

test("EventStream fail drains accepted events, rejects result, and ignores later pushes", async () => {
  const failure = new Error("source failed");
  const stream = new EventStream<string, string>((event) => event === "done", (event) => event);
  stream.push("accepted");
  stream.fail(failure);
  stream.push("ignored");

  assert.deepEqual(await eventsOf(stream), ["accepted"]);
  await assert.rejects(stream.result(), failure);
});

test("EventStream fails closed and discards its queue above 4096 buffered events", async () => {
  const stream = new EventStream<number, number>((event) => event < 0, (event) => event);
  for (let index = 0; index < 4_096; index += 1) stream.push(index);
  stream.push(4_096);
  stream.push(-1);

  await assert.rejects(stream.result(), /buffer exceeded 4096 events/u);
  assert.deepEqual(await eventsOf(stream), []);
});

test("EventStream remains bounded when a consumer keeps pace beyond the queue limit", async () => {
  const stream = new EventStream<number, number>((event) => event === -1, (event) => event);
  const iterator = stream[Symbol.asyncIterator]();
  for (let index = 0; index < 8_192; index += 1) {
    const pending = iterator.next();
    stream.push(index);
    assert.deepEqual(await pending, { done: false, value: index });
  }
  stream.push(-1);
  assert.deepEqual(await iterator.next(), { done: false, value: -1 });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  assert.equal(await stream.result(), -1);
});

test("return cancels pending reads without consuming events from a later iterator", async () => {
  const stream = new EventStream<number, number>((event) => event === -1, (event) => event);
  const cancelled = stream[Symbol.asyncIterator]();
  const pending = cancelled.next();

  assert.deepEqual(await cancelled.return?.(), { done: true, value: undefined });
  assert.deepEqual(await pending, { done: true, value: undefined });
  stream.push(1);
  stream.push(-1);

  assert.deepEqual(await eventsOf(stream), [1, -1]);
  assert.equal(await stream.result(), -1);
});

test("an internal EventStream cancellation hook runs once on early iterator return", async () => {
  let cancellations = 0;
  const stream = new EventStream<number, number>(
    (event) => event === -1,
    (event) => event,
    () => { cancellations += 1; },
  );
  const iterator = stream[Symbol.asyncIterator]();
  const first = iterator.next();
  stream.push(1);
  assert.deepEqual(await first, { done: false, value: 1 });
  assert.deepEqual(await iterator.return?.(), { done: true, value: undefined });
  assert.deepEqual(await iterator.return?.(), { done: true, value: undefined });
  assert.equal(cancellations, 1);
  stream.push(-1);
  assert.equal(await stream.result(), -1);
});

test("EventStream bounds concurrently pending reads at 4096", async () => {
  const failure = new Error("stop pending reads");
  const stream = new EventStream<number, number>((event) => event === -1, (event) => event);
  const iterator = stream[Symbol.asyncIterator]();
  const pending = Array.from({ length: 4_096 }, () => iterator.next());

  await assert.rejects(iterator.next(), /exceeded 4096 pending reads/u);
  stream.fail(failure);
  assert.equal((await Promise.all(pending)).every((entry) => entry.done), true);
  await assert.rejects(stream.result(), failure);
});

test("a throwing terminal projection rejects result without hiding the terminal event", async () => {
  const failure = new Error("invalid terminal");
  const stream = new EventStream<number, number>((event) => event === 1, () => { throw failure; });
  stream.push(1);

  assert.deepEqual(await eventsOf(stream), [1]);
  await assert.rejects(stream.result(), failure);
});

test("assistant error events resolve result to their canonical error message", async () => {
  const stream = createAssistantMessageEventStream();
  const error = assistant("aborted");
  const terminal: AssistantMessageEvent = { type: "error", reason: "aborted", error };
  stream.push(terminal);

  assert.deepEqual(await eventsOf(stream), [terminal]);
  assert.strictEqual(await stream.result(), error);
});

test("the public assistant stream constructor resolves a completed message and seals the channel", async () => {
  const stream = new AssistantMessageEventStream();
  const message = assistant();
  const terminal = doneEvent(message);
  stream.push(terminal);
  stream.push(startEvent());

  assert.deepEqual(await eventsOf(stream), [terminal]);
  assert.strictEqual(await stream.result(), message);
});

test("streamFromEvents closes its source immediately after a terminal event", async () => {
  let reachedAfterTerminal = false;
  let finalized = false;
  async function* source(): AsyncGenerator<AssistantMessageEvent> {
    try {
      yield startEvent();
      yield doneEvent();
      reachedAfterTerminal = true;
      yield startEvent();
    } finally {
      finalized = true;
    }
  }

  const stream = streamFromEvents(source());
  const events = await eventsOf(stream);
  assert.deepEqual(events.map((event) => event.type), ["start", "done"]);
  assert.equal((await stream.result()).stopReason, "stop");
  assert.equal(reachedAfterTerminal, false);
  assert.equal(finalized, true);
});

test("streamFromEvents rejects a source that ends or throws before a terminal event", async () => {
  const ended = streamFromEvents([startEvent()]);
  assert.deepEqual((await eventsOf(ended)).map((event) => event.type), ["start"]);
  await assert.rejects(ended.result(), /without a terminal event/u);

  const failure = new Error("generator failed");
  async function* broken(): AsyncGenerator<AssistantMessageEvent> {
    yield startEvent();
    throw failure;
  }
  const thrown = streamFromEvents(broken());
  assert.deepEqual((await eventsOf(thrown)).map((event) => event.type), ["start"]);
  await assert.rejects(thrown.result(), failure);
});

test("streamFromEvents cancels an overproducing source when its bounded channel overflows", async () => {
  let produced = 0;
  let finalized = false;
  function* source(): Generator<AssistantMessageEvent> {
    try {
      while (true) {
        produced += 1;
        yield startEvent();
      }
    } finally {
      finalized = true;
    }
  }

  const stream = streamFromEvents(source());
  await assert.rejects(stream.result(), /buffer exceeded 4096 events/u);
  assert.equal(produced, 4_097);
  assert.equal(finalized, true);
  assert.deepEqual(await eventsOf(stream), []);
});

test("lazyStream starts once, shares the source, and forwards iterator cancellation", async () => {
  const terminal = assistant();
  let factoryCalls = 0;
  let returnCalls = 0;
  const event = startEvent();
  const source = {
    async result() { return terminal; },
    [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
      let emitted = false;
      return {
        async next() {
          if (emitted) return { done: true, value: undefined };
          emitted = true;
          return { done: false, value: event };
        },
        async return() {
          returnCalls += 1;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const stream = lazyStream(async () => {
    factoryCalls += 1;
    return source;
  });
  const iterator = stream[Symbol.asyncIterator]();

  assert.equal(factoryCalls, 0);
  const [next, result] = await Promise.all([iterator.next(), stream.result()]);
  assert.deepEqual(next, { done: false, value: event });
  assert.strictEqual(result, terminal);
  assert.equal(factoryCalls, 1);
  assert.deepEqual(await iterator.return?.(), { done: true, value: undefined });
  assert.equal(returnCalls, 1);
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  assert.deepEqual(await iterator.return?.(), { done: true, value: undefined });
  assert.equal(returnCalls, 1);
});

test("lazyStream shares a factory rejection between iteration and result", async () => {
  const failure = new Error("factory failed");
  let factoryCalls = 0;
  const stream = lazyStream(() => {
    factoryCalls += 1;
    throw failure;
  });

  const iteration = stream[Symbol.asyncIterator]().next();
  const result = stream.result();
  await assert.rejects(iteration, failure);
  await assert.rejects(result, failure);
  assert.equal(factoryCalls, 1);
});

test("lazyStream cancellation wins while its factory is still pending", async () => {
  let resolveSource!: (source: AssistantMessageEventStream) => void;
  let nextCalls = 0;
  let returnCalls = 0;
  const source = {
    result: async () => assistant(),
    [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
      return {
        async next() {
          nextCalls += 1;
          return { done: false, value: startEvent() };
        },
        async return() {
          returnCalls += 1;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const stream = lazyStream(() => new Promise((resolve) => { resolveSource = resolve; }));
  const iterator = stream[Symbol.asyncIterator]();
  const pending = iterator.next();
  const returning = iterator.return!();
  await Promise.resolve();
  resolveSource(source);

  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.deepEqual(await returning, { done: true, value: undefined });
  assert.equal(nextCalls, 0);
  assert.equal(returnCalls, 1);
});
