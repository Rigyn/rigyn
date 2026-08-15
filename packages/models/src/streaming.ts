import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream as AssistantMessageEventStreamContract,
  PushableAssistantMessageEventStream as PushableAssistantMessageEventStreamContract,
} from "./contracts.js";

const MAX_BUFFERED_EVENTS = 4_096;

type ChannelState = "open" | "sealed";
type StreamState = "open" | "terminal" | "failed";
type OfferEvent = <TEvent, TResult>(stream: EventStream<TEvent, TResult>, event: TEvent) => boolean;

let offerEvent: OfferEvent;

/**
 * A bounded single-consumption channel. Pending receivers share a change pulse
 * rather than occupying an unbounded waiter collection, and the circular
 * buffer keeps both enqueue and dequeue operations constant-time.
 */
class BoundedEventChannel<TEvent> {
  readonly #slots: Array<TEvent | undefined> = [];
  #head = 0;
  #size = 0;
  #pendingReads = 0;
  #state: ChannelState = "open";
  #changed: Promise<void> | undefined;
  #signalChanged: (() => void) | undefined;

  send(event: TEvent): boolean {
    if (this.#state !== "open" || this.#size === MAX_BUFFERED_EVENTS) return false;
    const tail = (this.#head + this.#size) % MAX_BUFFERED_EVENTS;
    this.#slots[tail] = event;
    this.#size += 1;
    this.#pulse();
    return true;
  }

  seal(discardBufferedEvents = false): void {
    if (this.#state === "sealed") return;
    this.#state = "sealed";
    if (discardBufferedEvents) this.#clear();
    this.#pulse();
  }

  async receive(active: () => boolean): Promise<IteratorResult<TEvent>> {
    if (!active()) return { value: undefined, done: true };
    if (this.#size !== 0) return { value: this.#take(), done: false };
    if (this.#isSealed()) return { value: undefined, done: true };
    if (this.#pendingReads === MAX_BUFFERED_EVENTS) {
      throw new RangeError(`Event stream exceeded ${MAX_BUFFERED_EVENTS} pending reads`);
    }
    this.#pendingReads += 1;
    try {
      while (true) {
        if (!active()) return { value: undefined, done: true };
        if (this.#size !== 0) return { value: this.#take(), done: false };
        if (this.#isSealed()) return { value: undefined, done: true };
        const changed = this.#changePulse();
        await changed;
      }
    } finally {
      this.#pendingReads -= 1;
    }
  }

  wake(): void {
    this.#pulse();
  }

  #isSealed(): boolean {
    return this.#state === "sealed";
  }

  #take(): TEvent {
    const event = this.#slots[this.#head] as TEvent;
    this.#slots[this.#head] = undefined;
    this.#head = (this.#head + 1) % MAX_BUFFERED_EVENTS;
    this.#size -= 1;
    if (this.#size === 0) this.#head = 0;
    return event;
  }

  #clear(): void {
    for (let index = 0; index < this.#size; index += 1) {
      this.#slots[(this.#head + index) % MAX_BUFFERED_EVENTS] = undefined;
    }
    this.#head = 0;
    this.#size = 0;
  }

  #changePulse(): Promise<void> {
    return this.#changed ??= new Promise<void>((resolve) => {
      this.#signalChanged = resolve;
    });
  }

  #pulse(): void {
    const signal = this.#signalChanged;
    if (signal === undefined) return;
    this.#changed = undefined;
    this.#signalChanged = undefined;
    signal();
  }
}

/**
 * A pushable asynchronous event stream. It retains at most 4,096 unread
 * events and accepts at most 4,096 pending reads. An event-buffer overflow
 * fails closed, rejects result(), and discards the retained queue.
 */
export class EventStream<TEvent, TResult> implements AsyncIterable<TEvent> {
  readonly #channel = new BoundedEventChannel<TEvent>();
  readonly #resultPromise: Promise<TResult>;
  readonly #isTerminal: (event: TEvent) => boolean;
  readonly #terminalResult: (event: TEvent) => TResult;
  #onCancel: (() => void) | undefined;
  #resolveResult!: (result: TResult) => void;
  #rejectResult!: (error: unknown) => void;
  #state: StreamState = "open";

  static {
    offerEvent = <TOfferedEvent, TOfferedResult>(
      stream: EventStream<TOfferedEvent, TOfferedResult>,
      event: TOfferedEvent,
    ): boolean => stream.#offer(event);
  }

  constructor(
    isTerminal: (event: TEvent) => boolean,
    terminalResult: (event: TEvent) => TResult,
    onCancel?: () => void,
  ) {
    this.#isTerminal = isTerminal;
    this.#terminalResult = terminalResult;
    this.#onCancel = onCancel;
    this.#resultPromise = new Promise((resolve, reject) => {
      this.#resolveResult = resolve;
      this.#rejectResult = reject;
    });
    // A stream can be consumed only as events. Keep a later result() call
    // observably rejected without turning that valid usage into an unhandled
    // process-level rejection.
    void this.#resultPromise.catch(() => undefined);
  }

  push(event: TEvent): void {
    this.#offer(event);
  }

  fail(error: unknown): void {
    this.#fail(error, false);
  }

  result(): Promise<TResult> {
    return this.#resultPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<TEvent> {
    let active = true;
    return {
      next: () => this.#channel.receive(() => active),
      return: () => {
        active = false;
        this.#channel.wake();
        this.#cancel();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  #offer(event: TEvent): boolean {
    if (this.#state !== "open") return false;
    const terminal = this.#isTerminal(event);

    if (!this.#channel.send(event)) {
      this.#cancel();
      this.#fail(new RangeError(`Event stream buffer exceeded ${MAX_BUFFERED_EVENTS} events`), true);
      return false;
    }
    if (!terminal) return true;

    this.#state = "terminal";
    this.#onCancel = undefined;
    this.#channel.seal();
    try {
      this.#resolveResult(this.#terminalResult(event));
    } catch (error) {
      this.#rejectResult(error);
    }
    return false;
  }

  #fail(error: unknown, discardBufferedEvents: boolean): void {
    if (this.#state !== "open") return;
    this.#state = "failed";
    this.#onCancel = undefined;
    this.#channel.seal(discardBufferedEvents);
    this.#rejectResult(error);
  }

  #cancel(): void {
    if (this.#state !== "open" || this.#onCancel === undefined) return;
    const cancel = this.#onCancel;
    this.#onCancel = undefined;
    try { cancel(); } catch (error) { this.#fail(error, false); }
  }
}

function closesAssistantStream(event: AssistantMessageEvent): boolean {
  return event.type === "done" || event.type === "error";
}

function assistantStreamResult(event: AssistantMessageEvent): AssistantMessage {
  switch (event.type) {
    case "done": return event.message;
    case "error": return event.error;
    default: throw new TypeError("Assistant message result requires a terminal event");
  }
}

class AssistantMessageEventChannel
  extends EventStream<AssistantMessageEvent, AssistantMessage>
  implements PushableAssistantMessageEventStreamContract {
  constructor(onCancel?: () => void) {
    super(closesAssistantStream, assistantStreamResult, onCancel);
  }
}

/** Structural read-only stream contract with a public runtime constructor. */
export interface AssistantMessageEventStream extends AssistantMessageEventStreamContract {}

export const AssistantMessageEventStream: new () => PushableAssistantMessageEventStreamContract = AssistantMessageEventChannel;

export function createAssistantMessageEventStream(onCancel?: () => void): PushableAssistantMessageEventStreamContract {
  return new AssistantMessageEventChannel(onCancel);
}

export function streamFromEvents(
  source: AsyncIterable<AssistantMessageEvent> | Iterable<AssistantMessageEvent>,
): AssistantMessageEventStreamContract {
  const stream = new AssistantMessageEventChannel();
  void (async () => {
    try {
      for await (const event of source) {
        if (!offerEvent(stream, event)) return;
      }
      stream.fail(new Error("Event source ended without a terminal event"));
    } catch (cause) {
      stream.fail(cause);
    }
  })();
  return stream;
}

export function lazyStream(factory: () => AssistantMessageEventStreamContract | Promise<AssistantMessageEventStreamContract>): AssistantMessageEventStreamContract;
export function lazyStream(
  model: import("./contracts.js").Model,
  factory: () => AssistantMessageEventStreamContract | Promise<AssistantMessageEventStreamContract>,
): AssistantMessageEventStreamContract;
export function lazyStream(
  modelOrFactory: import("./contracts.js").Model | (() => AssistantMessageEventStreamContract | Promise<AssistantMessageEventStreamContract>),
  maybeFactory?: () => AssistantMessageEventStreamContract | Promise<AssistantMessageEventStreamContract>,
): AssistantMessageEventStreamContract {
  const factory = typeof modelOrFactory === "function" ? modelOrFactory : maybeFactory;
  if (!factory) throw new TypeError("lazyStream requires a stream factory");
  let actual: Promise<AssistantMessageEventStreamContract> | undefined;
  const get = (): Promise<AssistantMessageEventStreamContract> => actual ??= Promise.resolve().then(factory);
  return {
    async result() {
      return (await get()).result();
    },
    [Symbol.asyncIterator]() {
      let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
      let active = true;
      const getIterator = async (): Promise<AsyncIterator<AssistantMessageEvent>> =>
        iterator ??= (await get())[Symbol.asyncIterator]();
      return {
        async next() {
          if (!active) return { value: undefined, done: true };
          const selected = await getIterator();
          if (!active) return { value: undefined, done: true };
          return selected.next();
        },
        async return() {
          if (!active) return { value: undefined, done: true };
          active = false;
          const selected = await getIterator();
          return selected.return?.() ?? { value: undefined, done: true };
        },
      };
    },
  };
}

export function emptyUsage(): import("./contracts.js").Usage {
  return {};
}

export function errorAssistantMessage(cause: unknown, partial?: Partial<AssistantMessage>): AssistantMessage {
  const text = cause instanceof Error ? cause.message : String(cause);
  return {
    role: "assistant",
    content: [],
    api: partial?.api ?? "faux",
    provider: partial?.provider ?? "faux",
    model: partial?.model ?? "error",
    usage: partial?.usage ?? emptyUsage(),
    stopReason: partial?.stopReason ?? "error",
    errorMessage: text,
    timestamp: partial?.timestamp ?? Date.now(),
    ...(partial?.providerState === undefined ? {} : { providerState: partial.providerState }),
  };
}
