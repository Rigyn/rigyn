function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Operation aborted");
}

const ITERATOR_RETURN_GRACE_MS = 1_000;

async function returnWithGrace<T>(iterator: AsyncIterator<T>): Promise<void> {
  if (iterator.return === undefined) return;
  let timer: NodeJS.Timeout | undefined;
  const returned = Promise.resolve()
    .then(() => iterator.return!())
    .then(() => undefined, () => undefined);
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ITERATOR_RETURN_GRACE_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([returned, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function nextWithSignal<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  signal.throwIfAborted();
  return await new Promise<IteratorResult<T>>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return iterator.next();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

/**
 * Stops awaiting an async iterator as soon as the caller aborts, even when the
 * iterator itself does not observe the supplied signal. Iterator cleanup is
 * requested with a bounded grace period so cooperative provider cleanup can
 * finish without making cancellation depend indefinitely on `return()`.
 */
export async function* abortableAsyncIterable<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T, void, void> {
  const iterator = source[Symbol.asyncIterator]();
  let exhausted = false;
  try {
    while (true) {
      const result = await nextWithSignal(iterator, signal);
      if (result.done === true) {
        exhausted = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!exhausted) await returnWithGrace(iterator);
  }
}
