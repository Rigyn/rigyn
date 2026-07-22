import { AsyncLocalStorage } from "node:async_hooks";

import type { FetchLike } from "./transport.js";

const activeFetch = new AsyncLocalStorage<FetchLike>();
let proxy: FetchLike | undefined;
let fallback: FetchLike | undefined;

/** Runs SDK code that only supports global fetch without cross-request transport leakage. */
export function withScopedGlobalFetch<T>(fetchImplementation: FetchLike, operation: () => T): T {
  installProxy();
  return activeFetch.run(fetchImplementation, operation);
}

function installProxy(): void {
  if (proxy !== undefined && globalThis.fetch === proxy) return;
  fallback = globalThis.fetch;
  proxy = ((resource: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const selected = activeFetch.getStore() ?? fallback;
    if (selected === undefined) throw new TypeError("fetch is unavailable");
    return selected(resource, init);
  }) as FetchLike;
  globalThis.fetch = proxy;
}
