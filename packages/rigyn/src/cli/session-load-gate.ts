export type SessionLoadResult<T> =
  | { current: true; value: T }
  | { current: false };

/** Reuses identical in-flight loads and publishes results only for the latest request. */
export class SessionLoadGate<T> {
  #generation = 0;
  readonly #pending = new Map<string, Promise<T>>();

  async request(key: string, load: () => Promise<T>): Promise<SessionLoadResult<T>> {
    const generation = ++this.#generation;
    let pending = this.#pending.get(key);
    if (pending === undefined) {
      pending = Promise.resolve().then(load);
      this.#pending.set(key, pending);
      const clear = (): void => {
        if (this.#pending.get(key) === pending) this.#pending.delete(key);
      };
      void pending.then(clear, clear);
    }

    try {
      const value = await pending;
      return generation === this.#generation ? { current: true, value } : { current: false };
    } catch (cause) {
      if (generation !== this.#generation) return { current: false };
      throw cause;
    }
  }
}
