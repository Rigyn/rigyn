function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function settleWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

/** @internal Serializes host-owned approval transactions without making queued cancellation wait. */
export class ToolAuthorizationQueue {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(signal: AbortSignal, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.#tail.catch(() => undefined);
    let release!: () => void;
    const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent; });
    this.#tail = previous.then(() => current);
    try {
      await settleWithSignal(previous, signal);
    } catch (error) {
      release();
      throw error;
    }
    try {
      signal.throwIfAborted();
      return await settleWithSignal(Promise.resolve().then(operation), signal);
    } finally {
      release();
    }
  }
}
