import type { ProviderAdapter } from "../core/types.js";
import type { NetworkTransport } from "../net/index.js";

export interface ProviderStreamFailure {
  error: unknown;
}

/** @internal Close both request-owned resources without replacing an earlier stream failure. */
export async function cleanupProviderStreamResources(
  primary: ProviderStreamFailure | undefined,
  adapter: ProviderAdapter | undefined,
  network: NetworkTransport | undefined,
): Promise<ProviderStreamFailure | undefined> {
  const failures: unknown[] = [];
  try {
    await adapter?.dispose?.();
  } catch (error) {
    failures.push(error);
  }
  try {
    await network?.close();
  } catch (error) {
    failures.push(error);
  }
  if (primary !== undefined || failures.length === 0) return primary;
  return {
    error: failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Provider stream resource cleanup failed"),
  };
}
