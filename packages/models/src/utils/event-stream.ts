import type { AssistantMessage, AssistantMessageEvent } from "../types.js";

export class EventStream<T, R = T> implements AsyncIterable<T> {
  readonly #queue: T[] = [];
  readonly #waiters: Array<(value: IteratorResult<T>) => void> = [];
  readonly #isTerminal: (event: T) => boolean;
  readonly #resultFromEvent: (event: T) => R;
  #closed = false;
  #result: Promise<R>;
  #resolve!: (value: R) => void;
  #reject!: (reason: unknown) => void;

  constructor(isTerminal: (event: T) => boolean, resultFromEvent: (event: T) => R) {
    this.#isTerminal = isTerminal;
    this.#resultFromEvent = resultFromEvent;
    this.#result = new Promise<R>((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
  }

  push(event: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: event }); else this.#queue.push(event);
    if (!this.#isTerminal(event)) return;
    this.#closed = true;
    this.#resolve(this.#resultFromEvent(event));
    for (const pending of this.#waiters.splice(0)) pending({ done: true, value: undefined });
  }

  end(result?: R): void {
    if (this.#closed) return;
    this.#closed = true;
    if (result !== undefined) this.#resolve(result);
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#reject(error);
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  result(): Promise<R> { return this.#result; }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => {
      const event = this.#queue.shift();
      if (event !== undefined) return Promise.resolve({ done: false, value: event });
      if (this.#closed) return Promise.resolve({ done: true, value: undefined });
      return new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
    } };
  }
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => event.type === "done" ? event.message : event.type === "error" ? event.error : (() => { throw new Error("Expected a terminal assistant event"); })(),
    );
  }
}
export function createAssistantMessageEventStream(): AssistantMessageEventStream { return new AssistantMessageEventStream(); }
