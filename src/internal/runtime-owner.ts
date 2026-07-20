import type { LoadedRuntime } from "../cli/runtime.js";
import type { HarnessRuntime } from "../public-runtime.js";

interface OwnedRuntimeRecord {
  runtime: LoadedRuntime;
  restoreExtensionShutdownHandler(): void;
  leased: boolean;
}

export interface OwnedRuntimeLease {
  runtime: LoadedRuntime;
  release(): void;
}

const OWNED_RUNTIMES = new WeakMap<HarnessRuntime, OwnedRuntimeRecord>();

export function registerOwnedRuntime(
  owner: HarnessRuntime,
  runtime: LoadedRuntime,
  restoreExtensionShutdownHandler: () => void,
): void {
  OWNED_RUNTIMES.set(owner, { runtime, restoreExtensionShutdownHandler, leased: false });
}

export function acquireOwnedRuntime(owner: HarnessRuntime): OwnedRuntimeLease {
  const record = OWNED_RUNTIMES.get(owner);
  if (record === undefined) {
    throw new Error("An owned in-process mode requires a runtime returned by createHarnessRuntime()");
  }
  if (record.leased) throw new Error("This runtime already has an active owned in-process mode");
  record.leased = true;
  let released = false;
  return {
    runtime: record.runtime,
    release() {
      if (released) return;
      released = true;
      record.leased = false;
      record.restoreExtensionShutdownHandler();
    },
  };
}
