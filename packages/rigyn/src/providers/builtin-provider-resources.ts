import type { ProviderAdapter } from "../core/types.js";
import type { NetworkTransport } from "../net/index.js";
import {
  cleanupProviderStreamResources,
  type ProviderStreamFailure,
} from "./stream-resource-cleanup.js";

export interface BuiltinProviderResource {
  adapter: ProviderAdapter;
  network?: NetworkTransport;
}

export interface BuiltinProviderResourceLease extends BuiltinProviderResource {
  release(primary?: ProviderStreamFailure): Promise<ProviderStreamFailure | undefined>;
}

/** @internal Owns the small set of reusable transports created by one built-in model collection. */
export class BuiltinProviderResources {
  readonly #retained = new Map<string, BuiltinProviderResource>();
  readonly #maximumRetained: number;
  readonly #lifecycle = new AbortController();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(maximumRetained = 4) {
    if (!Number.isSafeInteger(maximumRetained) || maximumRetained < 0) {
      throw new RangeError("maximumRetained must be a non-negative safe integer");
    }
    this.#maximumRetained = maximumRetained;
  }

  /** Signal for non-stream resources whose lifetime is owned by this collection. */
  get signal(): AbortSignal {
    return this.#lifecycle.signal;
  }

  acquire(
    key: string | undefined,
    create: () => BuiltinProviderResource,
  ): BuiltinProviderResourceLease {
    if (this.#closed) throw new Error("Built-in model resources are closed");
    const retained = key === undefined ? undefined : this.#retained.get(key);
    const resource = retained ?? create();
    const keep = retained !== undefined || (
      key !== undefined
      && this.#retained.size < this.#maximumRetained
    );
    if (retained === undefined && keep) this.#retained.set(key!, resource);
    let released = false;
    return {
      ...resource,
      async release(primary) {
        if (released || keep) return primary;
        released = true;
        return await cleanupProviderStreamResources(primary, resource.adapter, resource.network);
      },
    };
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#lifecycle.abort(new Error("Built-in model resources are closed"));
    const retained = [...this.#retained.values()];
    this.#retained.clear();
    this.#closePromise = (async () => {
      const failures: unknown[] = [];
      for (const resource of retained) {
        const failure = await cleanupProviderStreamResources(undefined, resource.adapter, resource.network);
        if (failure !== undefined) failures.push(failure.error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Built-in model resource cleanup failed");
    })();
    return this.#closePromise;
  }
}
